/**
 * test-generation-record.ts — acceptance gate for the SERVER-SIDE `pin_generations`
 * writer (`src/lib/server/generationRecord.ts`).
 * Run: npx tsx scripts/test-generation-record.ts   (from web/)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS DEFENDING AGAINST
 * ═══════════════════════════════════════════════════════════════════════════════
 * The bug being repaired is not "a query returned the wrong number". It is that a
 * write FAILED and NOBODY FOUND OUT FOR ELEVEN WEEKS: the client writer wrapped its
 * insert in `catch {}`, PostgREST rejected the whole row with PGRST204 (schema drift,
 * migrate_v52), and production `pin_generations` sat at four rows from 2026-06-14
 * while six admin surfaces reported serene zeroes off it.
 *
 * So the two failure modes this file exists to catch are:
 *
 *  1. SILENT NON-RECORDING. A best-effort writer that swallows errors is correct;
 *     one that swallows errors AND reports nothing is how the original defect hid.
 *     `recordGeneration` must therefore be provably total (never throws, for any
 *     input or client) AND provably honest (`recorded: false` on every degraded
 *     path). Both halves are asserted — passing only the first would re-ship the bug.
 *
 *  2. FABRICATED FACTS. Six admin surfaces read these columns as facts. A field the
 *     route could not observe must be ABSENT from the row, never defaulted to a
 *     plausible zero/empty-string. A wrong number here is worse than a null, because
 *     a null is visibly missing and a fabrication is not. Every omission case is
 *     asserted with `'key' in row === false`, not merely "is falsy".
 *
 * INDEPENDENT ORACLE: expectations are written out from the schema (migrate_v17 +
 * v52) and from raw literals. This file never calls `buildGenerationRow` to produce
 * an expectation — only to produce the value under test.
 */

import assert from "node:assert";

// generationRecord imports publishEvents, which type-imports lib/supabase; that module
// constructs a Supabase client at load time. These placeholders keep the import graph
// from throwing. Nothing here talks to a database: every client is an in-memory double.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-placeholder";

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// ── In-memory DB doubles ──────────────────────────────────────────────────────

type Captured = { table: string; row: Record<string, unknown> };

/** Records every insert and reports success — the happy path. */
function okDb(sink: Captured[]) {
  return {
    from(table: string) {
      return {
        async insert(row: Record<string, unknown>) {
          sink.push({ table, row });
          return { error: null };
        },
      };
    },
  };
}

/** Returns a PostgREST-shaped error object — the PGRST204 shape that caused the outage. */
function errorDb(message: string) {
  return {
    from() {
      return { async insert() { return { error: { message } }; } };
    },
  };
}

/** THROWS out of insert — network death, malformed client, anything. */
function throwingDb() {
  return {
    from() {
      return { async insert(): Promise<{ error: null }> { throw new Error("socket hang up"); } };
    },
  };
}

/** Throws from `.from()` itself, before insert is ever reached. */
function throwingFromDb() {
  return {
    from(): never { throw new Error("client is not a client"); },
  };
}

async function main() {
  const mod = await import("../src/lib/server/generationRecord");
  const { buildGenerationRow, recordGeneration, MAX_ERROR_MESSAGE_LENGTH, MAX_PROMPT_EXCERPT_LENGTH } = mod;

  const USER = "11111111-2222-3333-4444-555555555555";
  const REQ = "board_1756000000000_abc123";

  // ── 1. Success path ─────────────────────────────────────────────────────────

  await test("success: writes ONE pin_generations row with status=completed", async () => {
    const sink: Captured[] = [];
    const res = await recordGeneration(okDb(sink), {
      userId: USER, generationRequestId: REQ, status: "completed", source: "board",
      keyword: "cozy reading nook", totalPins: 4, expectedTotal: 4,
      pinUrls: ["https://cdn.example/a.png", "https://cdn.example/b.png"],
    });
    assert.deepEqual(res, { recorded: true });
    assert.equal(sink.length, 1, "exactly one insert");
    assert.equal(sink[0].table, "pin_generations", "writes to pin_generations, not another table");
    assert.equal(sink[0].row.status, "completed");
    assert.equal(sink[0].row.user_id, USER);
  });

  await test("success: generation_request_id is present AND equals session_id", () => {
    // Both are load-bearing and for DIFFERENT consumers: generationLogs shows
    // session_id as the run's source id; adminAiAdoption joins generation_request_id
    // against the draft's payload.sourceGenerationId. Asserting only one would let a
    // regression drop the other silently.
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "completed", source: "board",
    })!;
    assert.equal(row.generation_request_id, REQ);
    assert.equal(row.session_id, REQ);
  });

  await test("success: source is a board lineage value, never the retired composer's 'studio'", () => {
    // The four rows already in production say `studio`. The admin console has to be
    // able to tell the new server-side lineage from the dead client one.
    const inline = buildGenerationRow({ userId: USER, generationRequestId: REQ, status: "completed", source: "board" })!;
    const worker = buildGenerationRow({ userId: USER, generationRequestId: REQ, status: "running", source: "board_worker" })!;
    assert.equal(inline.source, "board");
    assert.equal(worker.source, "board_worker");
    assert.notEqual(inline.source, "studio");
    assert.notEqual(worker.source, "studio");
  });

  await test("success: created_at is NOT written — the DB clock is the authority", () => {
    // adminActivationFunnel orders firstGeneration on created_at. Sending a Node
    // clock value would let a skewed serverless instance reorder the funnel.
    const row = buildGenerationRow({ userId: USER, generationRequestId: REQ, status: "completed", source: "board" })!;
    assert.equal("created_at" in row, false);
  });

  await test("success: partial and running statuses round-trip verbatim", () => {
    for (const status of ["running", "partial", "failed", "completed"] as const) {
      const row = buildGenerationRow({ userId: USER, generationRequestId: REQ, status, source: "board" })!;
      assert.equal(row.status, status, `status ${status}`);
    }
  });

  // ── 2. Failure path ─────────────────────────────────────────────────────────

  await test("failure: status=failed carries error_type and error_message", async () => {
    const sink: Captured[] = [];
    const res = await recordGeneration(okDb(sink), {
      userId: USER, generationRequestId: REQ, status: "failed", source: "board",
      totalPins: 0, errorType: "quota_exceeded", errorMessage: "Monthly AI image allowance reached (800/800).",
    });
    assert.deepEqual(res, { recorded: true });
    const row = sink[0].row;
    assert.equal(row.status, "failed");
    assert.equal(row.error_type, "quota_exceeded");
    assert.equal(row.error_message, "Monthly AI image allowance reached (800/800).");
    assert.equal(row.total_pins, 0, "an explicit zero IS a fact and must be written");
  });

  await test("failure: a credential-shaped error message is REDACTED before storage", () => {
    // adminActionCenter surfaces error_message to operators. Storing a raw provider
    // error would put a token in a table admins read.
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "failed", source: "board",
      errorType: "api_auth_error",
      errorMessage: "401 from provider: Authorization: Bearer sk-live-AbCdEf0123456789XyZaBcDeFg rejected",
    })!;
    const stored = String(row.error_message);
    assert.ok(!stored.includes("sk-live-AbCdEf0123456789XyZaBcDeFg"), `token leaked: ${stored}`);
    assert.ok(stored.includes("[REDACTED]"), `expected a redaction marker, got: ${stored}`);
  });

  await test("failure: a long error message is truncated to <= MAX_ERROR_MESSAGE_LENGTH", () => {
    // Oracle: the cap is 300 (publishEvents.MAX_ERROR_MESSAGE_LENGTH), asserted as a
    // literal here so a silent widening of the constant fails this test.
    assert.equal(MAX_ERROR_MESSAGE_LENGTH, 300);
    const long = "generator.py stderr: " + "e".repeat(5000);
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "failed", source: "board",
      errorType: "api_server_error", errorMessage: long,
    })!;
    const stored = String(row.error_message);
    assert.ok(stored.length <= 300, `stored ${stored.length} chars, cap is 300`);
    assert.ok(stored.length > 100, "truncation must not degenerate into dropping the message");
  });

  await test("failure: a non-string error (a thrown Error) is coerced, not dropped", () => {
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "failed", source: "board",
      errorType: "unknown_error", errorMessage: new Error("generator.py exited with code 1"),
    })!;
    assert.ok(String(row.error_message).includes("generator.py exited with code 1"));
  });

  // ── 3. BEST-EFFORT: the writer degrades honestly, never throws ──────────────
  // This is the block that would have caught the original 11-week outage.

  await test("best-effort: an insert ERROR does not throw and reports recorded:false", async () => {
    const res = await recordGeneration(
      errorDb("Could not find the 'generation_request_id' column of 'pin_generations' in the schema cache"),
      { userId: USER, generationRequestId: REQ, status: "completed", source: "board" },
    );
    assert.equal(res.recorded, false, "a rejected insert must NOT report success");
    assert.equal(res.recorded === false && res.reason, "insert_error");
  });

  await test("best-effort: an insert that THROWS does not escape and reports recorded:false", async () => {
    let threw = false;
    let res: Awaited<ReturnType<typeof recordGeneration>> | null = null;
    try {
      res = await recordGeneration(throwingDb(), {
        userId: USER, generationRequestId: REQ, status: "completed", source: "board",
      });
    } catch { threw = true; }
    assert.equal(threw, false, "recordGeneration must be total — it may never throw at a caller");
    assert.equal(res!.recorded, false);
    assert.equal(res!.recorded === false && res!.reason, "threw");
  });

  await test("best-effort: a client that throws from .from() is also contained", async () => {
    const res = await recordGeneration(throwingFromDb() as never, {
      userId: USER, generationRequestId: REQ, status: "completed", source: "board",
    });
    assert.equal(res.recorded, false);
    assert.equal(res.recorded === false && res.reason, "threw");
  });

  await test("best-effort: a null client reports no_client rather than crashing the route", async () => {
    const res = await recordGeneration(null, {
      userId: USER, generationRequestId: REQ, status: "completed", source: "board",
    });
    assert.equal(res.recorded, false);
    assert.equal(res.recorded === false && res.reason, "no_client");
  });

  await test("best-effort: an unattributable row is REFUSED, not inserted with a blank owner", async () => {
    // user_id is NOT NULL and every consumer groups by it, so a row without an owner
    // is invisible noise. It must also never reach the DB in the first place.
    for (const bad of [
      { userId: "", generationRequestId: REQ },
      { userId: "   ", generationRequestId: REQ },
      { userId: USER, generationRequestId: "" },
    ]) {
      assert.equal(
        buildGenerationRow({ ...bad, status: "completed", source: "board" }),
        null,
        `expected null for ${JSON.stringify(bad)}`,
      );
      const sink: Captured[] = [];
      const res = await recordGeneration(okDb(sink), { ...bad, status: "completed", source: "board" });
      assert.equal(res.recorded, false);
      assert.equal(res.recorded === false && res.reason, "no_user");
      assert.equal(sink.length, 0, "nothing may be inserted for an unattributable row");
    }
  });

  // ── 4. NEVER FABRICATE: unknown fields are omitted, not defaulted ────────────

  await test("omission: an all-unknown-context row carries ONLY the five known keys", () => {
    // The worker enqueue path knows the user, the request id, that it started, and
    // where — and genuinely nothing else. Oracle: that is exactly five columns.
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "running", source: "board_worker",
    })!;
    assert.deepEqual(
      Object.keys(row).sort(),
      ["generation_request_id", "session_id", "source", "status", "user_id"],
    );
  });

  await test("omission: absent scalars are ABSENT, not '' / 0 / null", () => {
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "running", source: "board_worker",
    })!;
    for (const key of [
      "keyword", "category", "total_pins", "expected_total", "product_count",
      "ref_urls", "ref_count", "pin_urls", "error_type", "error_message", "prompt_excerpt",
    ]) {
      assert.equal(key in row, false, `${key} must be omitted when unknown, not defaulted`);
    }
  });

  await test("omission: whitespace-only text is treated as unknown, never stored blank", () => {
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "completed", source: "board",
      keyword: "   ", category: "", errorType: "  ", promptExcerpt: "\n\t ",
    })!;
    assert.equal("keyword" in row, false);
    assert.equal("category" in row, false);
    assert.equal("error_type" in row, false);
    assert.equal("prompt_excerpt" in row, false);
  });

  await test("omission: an empty URL array is omitted — 'no refs known' is not 'zero refs'", () => {
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "running", source: "board_worker",
      refUrls: [], pinUrls: [],
    })!;
    assert.equal("ref_urls" in row, false);
    assert.equal("ref_count" in row, false, "ref_count must not be fabricated as 0");
    assert.equal("pin_urls" in row, false);
  });

  await test("omission: NaN / Infinity / negative counts are omitted, never coerced to 0", () => {
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "failed", source: "board",
      totalPins: Number.NaN, expectedTotal: Number.POSITIVE_INFINITY, productCount: -3,
    })!;
    assert.equal("total_pins" in row, false);
    assert.equal("expected_total" in row, false);
    assert.equal("product_count" in row, false);
  });

  await test("omission: a real zero IS written — 0 images generated is a measured fact", () => {
    // The counterpart to the rule above: omission is for UNKNOWN, not for zero.
    // adminActionCenter's failure blocker needs to see total_pins = 0.
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "failed", source: "board",
      totalPins: 0, productCount: 0,
    })!;
    assert.equal(row.total_pins, 0);
    assert.equal(row.product_count, 0);
  });

  await test("consistency: ref_count is DERIVED from the stored ref_urls, never supplied", () => {
    // Two columns that can disagree are two columns that eventually will. ref_count is
    // computed from the list actually being written.
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "completed", source: "board",
      refUrls: ["https://a", "  ", "https://b", ""],
    })!;
    assert.deepEqual(row.ref_urls, ["https://a", "https://b"], "blank entries are dropped");
    assert.equal(row.ref_count, 2, "ref_count matches the array that was actually stored");
  });

  await test("prompt_excerpt: capped at MAX_PROMPT_EXCERPT_LENGTH, never the full prompt", () => {
    assert.equal(MAX_PROMPT_EXCERPT_LENGTH, 300);
    const prompt = "Studio-lit product hero shot. " + "detail. ".repeat(500);
    const row = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "completed", source: "board",
      promptExcerpt: prompt,
    })!;
    const stored = String(row.prompt_excerpt);
    assert.ok(stored.length <= 300, `stored ${stored.length} chars, cap is 300`);
    assert.ok(stored.startsWith("Studio-lit product hero shot."), "the head of the prompt is preserved");
    assert.equal("prompt_full" in row, false, "the full prompt is deliberately NOT written server-side");
  });

  await test("schema: every key written exists in pin_generations (v17 + v19 + v52)", () => {
    // Oracle: transcribed from backend/db/migrate_v17.sql, migrate_v19.sql and
    // migrate_v52_pin_generations_context_columns.sql. This is the check that would
    // have caught the original PGRST204 — an unknown column rejects the WHOLE row.
    const V17 = ["id", "user_id", "created_at", "keyword", "category", "source", "ref_urls",
      "pin_urls", "groups_json", "ref_count", "product_count", "total_pins"];
    const V19 = ["session_id"];
    const V52 = ["status", "expected_total", "mode", "opportunity", "images_per_ref",
      "product_names", "product_ids", "prompt_excerpt", "prompt_full", "setup_snapshot",
      "category_audit", "error_type", "error_message", "generation_request_id"];
    const known = new Set([...V17, ...V19, ...V52]);

    const maximal = buildGenerationRow({
      userId: USER, generationRequestId: REQ, status: "partial", source: "board",
      keyword: "k", category: "c", totalPins: 2, expectedTotal: 4, productCount: 1,
      refUrls: ["https://r"], pinUrls: ["https://p"], errorType: "api_server_error",
      errorMessage: "boom", promptExcerpt: "p",
    })!;
    for (const key of Object.keys(maximal)) {
      assert.ok(known.has(key), `column '${key}' is not in the production schema — PostgREST would reject the whole row`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
