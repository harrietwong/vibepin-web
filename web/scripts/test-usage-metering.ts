/**
 * usage.ts metering unit tests (migrate_v57).
 * Run: npx tsx scripts/test-usage-metering.ts
 *
 * Uses an in-memory fake of the supabase query-builder chain (no live DB) via the
 * injectable `db` parameter. Covers: idempotency, period-window summing,
 * consume/release netting, and checkAllowance boundaries (at-limit / over-limit /
 * limit-null / kill switch).
 */

// Env must be set BEFORE server modules load (supabase.ts reads env at import).
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
delete process.env.USAGE_ENFORCEMENT;

export {};

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

type Row = {
  owner_id: string;
  usage_type: string;
  operation: string;
  quantity: number;
  reference_type: string;
  reference_id: string;
  idempotency_key: string;
  metadata: unknown;
  created_at: string;
  owner_type: string;
};

/**
 * Minimal in-memory fake mimicking exactly the two chains usage.ts uses:
 *   db.from(t).upsert(rows, { onConflict, ignoreDuplicates })
 *   db.from(t).select(cols).eq(c,v).gte(c,v).lt(c,v)   (awaited → { data, error })
 */
function makeFakeDb(opts?: { failInsert?: boolean; failSelect?: boolean }) {
  const store: Row[] = [];
  const seenKeys = new Set<string>();

  const db = {
    _store: store,
    from(_table: string) {
      return {
        async upsert(rows: Row[], _o: { onConflict: string; ignoreDuplicates: boolean }) {
          if (opts?.failInsert) return { error: { message: "insert boom" } };
          for (const r of rows) {
            // ON CONFLICT (idempotency_key) DO NOTHING semantics.
            if (seenKeys.has(r.idempotency_key)) continue;
            seenKeys.add(r.idempotency_key);
            // Stamp with the test's fixed NOW, not the real wall clock: getUsageSummary
            // filters by [periodStart(NOW), periodEnd(NOW)), so a row timestamped with
            // the actual current date falls outside that window once real time crosses
            // into a different UTC month than NOW (it did, on 2026-08-01).
            store.push({ ...r, created_at: r.created_at ?? NOW.toISOString() });
          }
          return { error: null };
        },
        select(_cols: string) {
          const filters: Array<(r: Row) => boolean> = [];
          const builder = {
            eq(col: string, val: unknown) { filters.push((r) => (r as Record<string, unknown>)[col] === val); return builder; },
            gte(col: string, val: string) { filters.push((r) => String((r as Record<string, unknown>)[col]) >= val); return builder; },
            lt(col: string, val: string) { filters.push((r) => String((r as Record<string, unknown>)[col]) < val); return builder; },
            then(resolve: (v: { data: unknown; error: unknown }) => void) {
              if (opts?.failSelect) { resolve({ data: null, error: { message: "select boom" } }); return; }
              const data = store.filter((r) => filters.every((f) => f(r)));
              resolve({ data, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
  return db as unknown as import("../src/lib/server/usage").UsageDbClient & { _store: Row[] };
}

const OWNER = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-07-15T12:00:00.000Z");

function baseInput(over: Partial<import("../src/lib/server/usage").RecordUsageInput> = {}) {
  return {
    ownerId: OWNER,
    usageType: "ai_image" as const,
    operation: "consume" as const,
    quantity: 1,
    referenceType: "generation",
    referenceId: "gen_1",
    idempotencyKey: "ai_image:gen_1",
    ...over,
  };
}

async function main() {
  const usage = await import("../src/lib/server/usage");

  console.log("\nusage metering tests\n");

  await test("recordUsage inserts one row and reports recorded:true", async () => {
    const db = makeFakeDb();
    const r = await usage.recordUsage(baseInput(), db);
    assertEq(r.recorded, true, "recorded");
    assertEq((db as unknown as { _store: Row[] })._store.length, 1, "one row stored");
  });

  await test("idempotency: same key twice → only one row (second still recorded:true, no throw)", async () => {
    const db = makeFakeDb();
    await usage.recordUsage(baseInput(), db);
    await usage.recordUsage(baseInput(), db);
    assertEq((db as unknown as { _store: Row[] })._store.length, 1, "still one row after duplicate key");
  });

  await test("recordUsage never throws on insert error — returns recorded:false", async () => {
    const db = makeFakeDb({ failInsert: true });
    const r = await usage.recordUsage(baseInput(), db);
    assertEq(r.recorded, false, "recorded false on error");
  });

  await test("recordUsage skips zero/negative quantity without storing", async () => {
    const db = makeFakeDb();
    assertEq((await usage.recordUsage(baseInput({ quantity: 0 }), db)).recorded, false, "qty 0");
    assertEq((await usage.recordUsage(baseInput({ quantity: -3 }), db)).recorded, false, "qty -3");
    assertEq((db as unknown as { _store: Row[] })._store.length, 0, "nothing stored");
  });

  await test("getUsageSummary sums consume and nets out release/reverse, floored at 0", async () => {
    const db = makeFakeDb();
    await usage.recordUsage(baseInput({ usageType: "ai_image", quantity: 5, idempotencyKey: "k1" }), db);
    await usage.recordUsage(baseInput({ usageType: "ai_image", quantity: 3, idempotencyKey: "k2" }), db);
    await usage.recordUsage(baseInput({ usageType: "ai_image", operation: "release", quantity: 2, idempotencyKey: "k3" }), db);
    await usage.recordUsage(baseInput({ usageType: "ai_text_generation", quantity: 4, idempotencyKey: "k4" }), db);
    await usage.recordUsage(baseInput({ usageType: "scheduled_post", operation: "reverse", quantity: 10, idempotencyKey: "k5" }), db);
    const s = await usage.getUsageSummary(OWNER, NOW, db);
    assertEq(s.ai_image, 6, "ai_image = 5+3-2");
    assertEq(s.ai_text_generation, 4, "ai_text = 4");
    assertEq(s.scheduled_post, 0, "scheduled floored at 0 (reverse with no consume)");
  });

  await test("period window: rows outside the current UTC month are excluded", async () => {
    const db = makeFakeDb();
    const store = (db as unknown as { _store: Row[] })._store;
    // This-month consume (in-window).
    await usage.recordUsage(baseInput({ quantity: 2, idempotencyKey: "in" }), db);
    store[store.length - 1].created_at = "2026-07-10T00:00:00.000Z";
    // Last-month consume (out-of-window).
    await usage.recordUsage(baseInput({ quantity: 9, idempotencyKey: "out" }), db);
    store[store.length - 1].created_at = "2026-06-30T23:59:59.000Z";
    const s = await usage.getUsageSummary(OWNER, NOW, db);
    assertEq(s.ai_image, 2, "only in-window row counted");
  });

  await test("getUsageSummary returns zeros on select error (never throws)", async () => {
    const db = makeFakeDb({ failSelect: true });
    const s = await usage.getUsageSummary(OWNER, NOW, db);
    assertEq(s.ai_image, 0, "zero on error");
    assertEq(s.scheduled_post, 0, "zero on error");
  });

  await test("periodStart/periodEnd are the UTC month boundaries", () => {
    assertEq(usage.periodStart(NOW).toISOString(), "2026-07-01T00:00:00.000Z", "periodStart");
    assertEq(usage.periodEnd(NOW).toISOString(), "2026-08-01T00:00:00.000Z", "periodEnd");
  });

  // ── checkAllowance boundaries (plan passed explicitly → no resolvePlan network) ──
  await test("checkAllowance: exactly AT limit is allowed", async () => {
    const db = makeFakeDb();
    // free ai_image limit = 10; consume 9, request 1 → 9+1=10 <= 10 → allowed.
    await usage.recordUsage(baseInput({ quantity: 9, idempotencyKey: "c9" }), db);
    const a = await usage.checkAllowance(OWNER, "ai_image", 1, "free", NOW, db);
    assertEq(a.allowed, true, "at limit allowed");
    assertEq(a.used, 9, "used");
    assertEq(a.limit, 10, "limit");
  });

  await test("checkAllowance: one OVER limit is denied", async () => {
    const db = makeFakeDb();
    await usage.recordUsage(baseInput({ quantity: 10, idempotencyKey: "c10" }), db);
    const a = await usage.checkAllowance(OWNER, "ai_image", 1, "free", NOW, db);
    assertEq(a.allowed, false, "over limit denied");
    assertEq(a.used, 10, "used");
  });

  await test("checkAllowance: requesting a batch that would cross the limit is denied", async () => {
    const db = makeFakeDb();
    await usage.recordUsage(baseInput({ quantity: 8, idempotencyKey: "c8" }), db);
    // 8 used + request 3 = 11 > 10 → denied.
    const a = await usage.checkAllowance(OWNER, "ai_image", 3, "free", NOW, db);
    assertEq(a.allowed, false, "batch crossing limit denied");
  });

  await test("checkAllowance: null limit (business scheduled_post) is always allowed", async () => {
    const db = makeFakeDb();
    await usage.recordUsage(baseInput({ usageType: "scheduled_post", quantity: 9999, idempotencyKey: "sp" }), db);
    const a = await usage.checkAllowance(OWNER, "scheduled_post", 1000, "business", NOW, db);
    assertEq(a.allowed, true, "unlimited always allowed");
    assertEq(a.limit, null, "limit null");
  });

  await test("checkAllowance: null limit (ai_text_generation any plan) is always allowed", async () => {
    const db = makeFakeDb();
    const a = await usage.checkAllowance(OWNER, "ai_text_generation", 10_000, "free", NOW, db);
    assertEq(a.allowed, true, "ai text uncapped");
    assertEq(a.limit, null, "limit null");
  });

  await test("checkAllowance: USAGE_ENFORCEMENT=0 kill switch always allows (but still reports used/limit)", async () => {
    const db = makeFakeDb();
    await usage.recordUsage(baseInput({ quantity: 50, idempotencyKey: "kill" }), db);
    process.env.USAGE_ENFORCEMENT = "0";
    try {
      const a = await usage.checkAllowance(OWNER, "ai_image", 100, "free", NOW, db);
      assertEq(a.allowed, true, "kill switch allowed");
      assertEq(a.used, 50, "used still reported");
      assertEq(a.limit, 10, "limit still reported");
    } finally {
      delete process.env.USAGE_ENFORCEMENT;
    }
  });

  await test("checkAllowance: enforcement re-enabled after kill switch cleared", async () => {
    const db = makeFakeDb();
    await usage.recordUsage(baseInput({ quantity: 50, idempotencyKey: "re" }), db);
    const a = await usage.checkAllowance(OWNER, "ai_image", 1, "free", NOW, db);
    assertEq(a.allowed, false, "enforcement back on");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
