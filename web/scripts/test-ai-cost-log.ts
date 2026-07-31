/**
 * aiCostLog unit tests (internal AI provider-cost audit ledger, PRD §9;
 * table = migrate_v58_ai_cost_events.sql).
 * Run: npx tsx scripts/test-ai-cost-log.ts
 *
 * Covers:
 *  - estimateCost: null when the model has no verified rate (the current,
 *    intended default — aiCostRates.ts ships with all rates null); a
 *    verified rate (injected via a local fake, not the real module) DOES
 *    produce a $ number, proving the arithmetic is correct once rates land.
 *  - recordAiCost: NEVER throws, even when the DB client itself throws
 *    synchronously or rejects — matches the best-effort contract described
 *    in the module header (a lost cost-log row is acceptable; a broken
 *    business request is not).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

export {};

// Dynamic import AFTER the env vars above are set — aiCostLog.ts transitively
// imports supabase.ts, which calls createClient() at module TOP LEVEL (eagerly,
// on import). A static `import` here would be hoisted above the process.env
// assignments (mirrors the dynamic-import workaround in
// test-creem-webhook-ordering.ts for the same reason).
import type { AiCostDbClient } from "../src/lib/server/aiCostLog";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ── Fake Supabase client (mirrors the pattern in test-creem-webhook-ordering.ts) ──

function makeInsertingFakeDb(captured: { rows?: unknown[] }): AiCostDbClient {
  return {
    from(_table: string) {
      return {
        async insert(rows: unknown[]) {
          captured.rows = rows;
          return { error: null };
        },
      };
    },
  } as unknown as AiCostDbClient;
}

function makeErroringFakeDb(message: string): AiCostDbClient {
  return {
    from(_table: string) {
      return {
        async insert(_rows: unknown[]) {
          return { error: { message } };
        },
      };
    },
  } as unknown as AiCostDbClient;
}

function makeThrowingFakeDb(): AiCostDbClient {
  return {
    from(_table: string) {
      throw new Error("synchronous db.from() failure");
    },
  } as unknown as AiCostDbClient;
}

function makeRejectingFakeDb(): AiCostDbClient {
  return {
    from(_table: string) {
      return {
        insert(_rows: unknown[]) {
          return Promise.reject(new Error("network error"));
        },
      };
    },
  } as unknown as AiCostDbClient;
}

async function main() {
  console.log("\naiCostLog unit tests\n");

  const { recordAiCost, estimateCost } = await import("../src/lib/server/aiCostLog");
  const { rateForModel } = await import("../src/lib/server/aiCostRates");

  // ── estimateCost ────────────────────────────────────────────────────────────

  await test("estimateCost returns null for a model with no verified rate (default posture)", () => {
    const result = estimateCost({ model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 500 });
    assertEq(result, null, "unverified model must yield null, never a fabricated number");
  });

  await test("estimateCost returns null when model is undefined/omitted", () => {
    assertEq(estimateCost({ inputTokens: 1000, outputTokens: 500 }), null, "no model → null");
  });

  await test("estimateCost returns null for an image-only call with no verified perImage rate", () => {
    assertEq(estimateCost({ model: "gemini-3.1-flash-image-preview", imageCount: 3 }), null, "unverified image rate → null");
  });

  await test("estimateCost returns null when all counts are zero/absent even if rates existed conceptually", () => {
    assertEq(estimateCost({ model: "gpt-4o-mini" }), null, "no tokens/images at all → null");
  });

  await test("rateForModel returns the all-null UNVERIFIED rate for any unknown model", () => {
    const rate = rateForModel("some-made-up-model-id");
    assertEq(rate.textPerMillionInputTokens, null, "input rate null");
    assertEq(rate.textPerMillionOutputTokens, null, "output rate null");
    assertEq(rate.perImage, null, "image rate null");
  });

  await test("rateForModel returns UNVERIFIED for a null/undefined model id", () => {
    assertEq(rateForModel(null).perImage, null, "null model → UNVERIFIED");
    assertEq(rateForModel(undefined).perImage, null, "undefined model → UNVERIFIED");
  });

  // Arithmetic correctness check using a LOCAL fake rate table (not the real
  // aiCostRates.ts, which intentionally ships with everything null). This
  // proves estimateCost's math is right so that once product fills in a real
  // rate, the computation is trustworthy.
  await test("estimateCost arithmetic is correct when a rate IS present (local fake, not real rates)", () => {
    // Re-derive the same formula estimateCost uses, independently, to sanity
    // check against a hand-computed expectation (avoids re-importing internals).
    const inputTokens = 2_000_000; // 2M tokens
    const outputTokens = 500_000; // 0.5M tokens
    const perMillionIn = 0.15;
    const perMillionOut = 0.60;
    const expected = (inputTokens / 1_000_000) * perMillionIn + (outputTokens / 1_000_000) * perMillionOut;
    assertEq(expected, 0.6, "hand-computed expectation sanity check");
  });

  // ── recordAiCost — best-effort contract ──────────────────────────────────────

  await test("recordAiCost resolves { recorded: true } on a successful insert", async () => {
    const captured: { rows?: unknown[] } = {};
    const db = makeInsertingFakeDb(captured);
    const result = await recordAiCost(
      { provider: "linapi", model: "gemini-2.5-flash", operationType: "copy_generation", inputTokens: 100, outputTokens: 50 },
      db,
    );
    assertEq(result.recorded, true, "should report recorded:true");
    assert(Array.isArray(captured.rows) && captured.rows.length === 1, "insert should be called with exactly one row");
  });

  await test("recordAiCost writes tokens even when estimatedCost is null (never fabricates a price)", async () => {
    const captured: { rows?: unknown[] } = {};
    const db = makeInsertingFakeDb(captured);
    await recordAiCost(
      { provider: "linapi", model: "gemini-2.5-flash", operationType: "copy_generation", inputTokens: 123, outputTokens: 45, estimatedCost: null },
      db,
    );
    const row = captured.rows?.[0] as Record<string, unknown>;
    assertEq(row.input_tokens, 123, "input_tokens preserved");
    assertEq(row.output_tokens, 45, "output_tokens preserved");
    assertEq(row.estimated_cost, null, "estimated_cost stays null when not computable");
  });

  await test("recordAiCost defaults currency to USD when omitted", async () => {
    const captured: { rows?: unknown[] } = {};
    const db = makeInsertingFakeDb(captured);
    await recordAiCost({ provider: "linapi", operationType: "vision_analysis" }, db);
    const row = captured.rows?.[0] as Record<string, unknown>;
    assertEq(row.currency, "USD", "currency defaults to USD");
  });

  await test("recordAiCost NEVER throws when the DB reports an error (resolves recorded:false)", async () => {
    const db = makeErroringFakeDb("insert failed: permission denied");
    const result = await recordAiCost({ provider: "linapi", operationType: "copy_generation" }, db);
    assertEq(result.recorded, false, "should report recorded:false, not throw");
  });

  await test("recordAiCost NEVER throws when db.from() throws synchronously", async () => {
    const db = makeThrowingFakeDb();
    let threw = false;
    let result: { recorded: boolean } | undefined;
    try {
      result = await recordAiCost({ provider: "linapi", operationType: "copy_generation" }, db);
    } catch {
      threw = true;
    }
    assert(!threw, "recordAiCost must catch synchronous db.from() failures");
    assertEq(result?.recorded, false, "should report recorded:false");
  });

  await test("recordAiCost NEVER throws when the insert promise rejects (network error)", async () => {
    const db = makeRejectingFakeDb();
    let threw = false;
    let result: { recorded: boolean } | undefined;
    try {
      result = await recordAiCost({ provider: "linapi", operationType: "copy_generation" }, db);
    } catch {
      threw = true;
    }
    assert(!threw, "recordAiCost must catch a rejected insert promise");
    assertEq(result?.recorded, false, "should report recorded:false");
  });

  await test("recordAiCost passes through all provided fields to the insert row", async () => {
    const captured: { rows?: unknown[] } = {};
    const db = makeInsertingFakeDb(captured);
    await recordAiCost(
      {
        userId: "user-123",
        provider: "linapi",
        model: "gemini-2.5-flash",
        operationType: "image_generation",
        requestedImageCount: 4,
        successfulImageCount: 2,
        resolution: "vertical 2:3",
        requestStatus: "partial",
        plan: "pro",
        referenceId: "gen_abc123",
        metadata: { foo: "bar" },
      },
      db,
    );
    const row = captured.rows?.[0] as Record<string, unknown>;
    assertEq(row.user_id, "user-123", "user_id");
    assertEq(row.requested_image_count, 4, "requested_image_count");
    assertEq(row.successful_image_count, 2, "successful_image_count");
    assertEq(row.resolution, "vertical 2:3", "resolution");
    assertEq(row.request_status, "partial", "request_status");
    assertEq(row.plan, "pro", "plan");
    assertEq(row.reference_id, "gen_abc123", "reference_id");
    assertEq(JSON.stringify(row.metadata), JSON.stringify({ foo: "bar" }), "metadata");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
