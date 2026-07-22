/**
 * test-usage-ledger-db.ts — real-Postgres proof for the v55 usage-ledger primitives.
 * Run: npm run test:db      (NOT part of `npm test`)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS THE POINT OF PHASE 2
 * ═══════════════════════════════════════════════════════════════════════════════
 * The v55 primitives are DORMANT: no route, worker, webhook or cron calls them. This
 * suite is their only caller, and it is the only reason to believe they work.
 *
 * Everything v55 claims is a claim about CONCURRENCY and TRANSACTIONS — that a
 * FOR UPDATE lock really serializes racers, that a unique constraint really collapses
 * a replay to one effect, that an error really rolls back a multi-table write. Not
 * one of those claims can be tested against an in-memory fake, because a fake is a
 * model of Postgres written by the same person who wrote the code under test: it can
 * only confirm what they already believed. A ledger that has only ever been tested
 * against a Map is a ledger nobody should bill from.
 *
 * So every assertion below runs against real Postgres, over real HTTP, with real
 * parallel in-flight requests.
 *
 * THE CENTRAL TEST is `injected failure rolls back every statement` — the one Phase
 * 1A could not make. usage_reserve_generation_job writes to FOUR tables and then
 * raises. If any row survives, the atomicity claim in the migration header is false
 * and the reserve-then-crash-before-enqueue gap is still open.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SAFETY — READ scripts/lib/test-db-config.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 * This test WRITES AND DELETES REAL ROWS. It resolves its target exclusively from
 * TEST_SUPABASE_* variables, has no fallback to the production Supabase variables,
 * refuses to start against the known production ref, and fails loudly when
 * credentials are absent rather than skipping.
 *
 * Row isolation: every account this run creates uses a per-run UUID namespace and
 * every reservation key carries `itest:<runId>`, so repeated or parallel runs cannot
 * collide, and cleanup deletes precisely this run's rows. usage_accounts is the
 * cleanup root — ON DELETE CASCADE removes reservations, items and events with it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ASSERTION SHAPE — the gotcha that makes RLS tests lie
 * ═══════════════════════════════════════════════════════════════════════════════
 * PostgREST returns HTTP 200 + `[]` for an RLS-hidden SELECT, and 204 for a PATCH
 * that matched zero rows. NEITHER STATUS DISTINGUISHES "BLOCKED" FROM "SUCCEEDED".
 * So every RLS assertion below is on rows returned and on the RE-READ VALUE, never on
 * a status code.
 */

import {
  loadTestDbConfig,
  assertNotProduction,
  TestDbConfigError,
  type TestDbConfig,
} from "./lib/test-db-config";

let cfg: TestDbConfig;
try {
  cfg = loadTestDbConfig();
} catch (err) {
  if (err instanceof TestDbConfigError) {
    console.error("\n=== USAGE LEDGER DB TEST CANNOT RUN ===\n");
    console.error(err.message);
    console.error("\nExiting NON-ZERO. This is deliberate: a silent skip would report");
    console.error("green for a channel that verified nothing.\n");
    process.exit(1);
  }
  throw err;
}
assertNotProduction(cfg);

export {};

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const RUN_ID = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const KEY_PREFIX = `itest:${RUN_ID}`;

/** Every account id this run created — the cleanup root (cascades to all children). */
const createdAccounts = new Set<string>();
const createdUsers = new Set<string>();

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

const service: SupabaseClient = createClient(cfg.url, cfg.serviceRoleKey, {
  auth: { persistSession: false },
});
const anon: SupabaseClient = createClient(cfg.url, cfg.anonKey, {
  auth: { persistSession: false },
});

// ── Account fixture ─────────────────────────────────────────────────────────────

type AccountLimits = {
  imagesLimit?: number | null;
  textLimit?: number | null;
  scheduledLimit?: number | null;
  bonusImages?: number;
};

type Account = { id: string; userId: string };

/**
 * Create a usage_accounts row directly (service role). Phase 3 will own account
 * creation; Phase 2 has no such RPC, so the test seeds the row it needs.
 *
 * NOTE the limits are passed in per-test. No plan numbers exist in SQL, and none are
 * implied here either — these are arbitrary fixture values chosen to make a specific
 * race observable, not a claim about any real plan.
 */
async function makeAccount(label: string, limits: AccountLimits = {}): Promise<Account> {
  const userId = randomUUID();
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

  const { data, error } = await service
    .from("usage_accounts")
    .insert({
      user_id: userId,
      plan_key: `${KEY_PREFIX}:${label}`,
      period_start: now.toISOString(),
      period_end: periodEnd.toISOString(),
      period_anchor: now.toISOString(),
      ai_images_limit: limits.imagesLimit === undefined ? 100 : limits.imagesLimit,
      ai_text_generations_limit: limits.textLimit === undefined ? 100 : limits.textLimit,
      scheduled_posts_limit: limits.scheduledLimit === undefined ? 100 : limits.scheduledLimit,
      bonus_images_balance: limits.bonusImages ?? 0,
    })
    .select("id, user_id")
    .single();

  if (error) throw new Error(`makeAccount(${label}) failed: ${error.message}`);
  const acct = { id: (data as { id: string }).id, userId };
  createdAccounts.add(acct.id);
  createdUsers.add(userId);
  return acct;
}

type AccountRow = {
  ai_images_limit: number | null;
  ai_images_used: number;
  ai_images_reserved: number;
  ai_text_generations_limit: number | null;
  ai_text_generations_used: number;
  ai_text_generations_reserved: number;
  scheduled_posts_limit: number | null;
  scheduled_posts_used: number;
  scheduled_posts_reserved: number;
  bonus_images_balance: number;
  bonus_images_reserved: number;
  bonus_images_used: number;
  version: number;
};

async function readAccount(id: string): Promise<AccountRow> {
  const { data, error } = await service
    .from("usage_accounts")
    .select(
      "ai_images_limit, ai_images_used, ai_images_reserved, ai_text_generations_limit, " +
        "ai_text_generations_used, ai_text_generations_reserved, scheduled_posts_limit, " +
        "scheduled_posts_used, scheduled_posts_reserved, bonus_images_balance, " +
        "bonus_images_reserved, bonus_images_used, version",
    )
    .eq("id", id)
    .single();
  if (error) throw new Error(`readAccount failed: ${error.message}`);
  // `as unknown as` because supabase-js infers a GenericStringError union for a
  // multi-column select string it cannot statically parse; the runtime shape is the
  // row, and the RPC-level assertions below are what actually police it.
  return data as unknown as AccountRow;
}

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

/** Call an RPC with the service role. Returns the raw {data,error} — many tests
 *  assert on the ERROR, so this must never throw on its own. */
async function rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await service.rpc(fn, args);
  return { data, error: error ? { message: error.message, code: error.code } : null };
}

/** Call an RPC and require success, returning the jsonb payload. */
async function rpcOk(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn} errored: ${error.message}`);
  return data as Record<string, unknown>;
}

function slots(n: number, prefix = "s"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

// ── Conservation check — the assertion no single test thinks to make ────────────
/**
 * Reconcile an account's counters against its own reservations and items.
 *
 * This is the invariant that catches arithmetic bugs nothing else would notice: any
 * individual test asserts the numbers IT expects, but only a full reconciliation
 * proves the ledger is internally consistent. Specifically:
 *   reserved counters  ==  sum of still-pending item allocations
 *   used counters      ==  sum of succeeded item allocations
 * If a settle ever credited the wrong pool, or double-decremented, these disagree.
 */
async function assertConservation(account: Account, label: string): Promise<void> {
  const acct = await readAccount(account.id);

  const { data: resData, error: resErr } = await service
    .from("usage_reservations")
    .select("id, usage_type")
    .eq("account_id", account.id);
  if (resErr) throw new Error(`conservation(${label}): reservations read failed: ${resErr.message}`);
  const reservations = (resData ?? []) as { id: string; usage_type: string }[];

  const byId = new Map(reservations.map(r => [r.id, r.usage_type]));
  const ids = reservations.map(r => r.id);

  let pendImgRec = 0, pendImgBonus = 0, pendText = 0;
  let doneImgRec = 0, doneImgBonus = 0, doneText = 0;

  // Chunk to stay well inside PostgREST's URL length budget.
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    if (chunk.length === 0) break;
    const { data: itemData, error: itemErr } = await service
      .from("usage_reservation_items")
      .select("reservation_id, state, recurring_quantity, bonus_quantity")
      .in("reservation_id", chunk);
    if (itemErr) throw new Error(`conservation(${label}): items read failed: ${itemErr.message}`);

    for (const it of (itemData ?? []) as {
      reservation_id: string; state: string; recurring_quantity: number; bonus_quantity: number;
    }[]) {
      const type = byId.get(it.reservation_id);
      if (it.state === "pending") {
        if (type === "ai_image") { pendImgRec += it.recurring_quantity; pendImgBonus += it.bonus_quantity; }
        else pendText += it.recurring_quantity + it.bonus_quantity;
      } else if (it.state === "succeeded") {
        if (type === "ai_image") { doneImgRec += it.recurring_quantity; doneImgBonus += it.bonus_quantity; }
        else doneText += it.recurring_quantity + it.bonus_quantity;
      }
    }
  }

  assertEq(acct.ai_images_reserved, pendImgRec, `conservation(${label}): ai_images_reserved vs pending recurring items`);
  assertEq(acct.bonus_images_reserved, pendImgBonus, `conservation(${label}): bonus_images_reserved vs pending bonus items`);
  assertEq(acct.ai_text_generations_reserved, pendText, `conservation(${label}): text reserved vs pending items`);
  assertEq(acct.ai_images_used, doneImgRec, `conservation(${label}): ai_images_used vs succeeded recurring items`);
  assertEq(acct.bonus_images_used, doneImgBonus, `conservation(${label}): bonus_images_used vs succeeded bonus items`);
  assertEq(acct.ai_text_generations_used, doneText, `conservation(${label}): text used vs succeeded items`);

  // No counter may ever be negative — the CHECK constraints should make this
  // impossible, so a failure here means a constraint is missing, not merely that
  // arithmetic drifted.
  for (const [k, v] of Object.entries(acct)) {
    if (typeof v === "number" && k !== "version" && !k.endsWith("_limit")) {
      assert(v >= 0, `conservation(${label}): ${k} is negative (${v})`);
    }
  }
}

async function cleanup(): Promise<number> {
  let removed = 0;
  for (const id of createdAccounts) {
    // usage_accounts is the cascade root: reservations, items and events go with it.
    const { error, count } = await service
      .from("usage_accounts")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw new Error(`cleanup failed for account ${id}: ${error.message}`);
    removed += count ?? 0;
  }
  // generation_jobs is NOT cascaded from usage_accounts, so sweep this run's jobs.
  for (const userId of createdUsers) {
    await service.from("generation_jobs").delete().eq("vibepin_user_id", userId);
  }
  // Belt-and-braces: any account this run created through a path that failed before
  // registering its id.
  const { error: sweepErr, count: sweepCount } = await service
    .from("usage_accounts")
    .delete({ count: "exact" })
    .like("plan_key", `${KEY_PREFIX}:%`);
  if (sweepErr) throw new Error(`cleanup sweep failed: ${sweepErr.message}`);
  return removed + (sweepCount ?? 0);
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== REAL POSTGRES INTEGRATION — v55 usage ledger primitives ===");
  console.log(`  target project ref : ${cfg.projectRef}`);
  console.log(`  run id             : ${RUN_ID}`);
  console.log("  (writes and deletes real rows; never production — see lib/test-db-config.ts)\n");

  // ── 0. Preflight ─────────────────────────────────────────────────────────────
  // Without this, every later assertion could pass vacuously against a schema that
  // was never applied.
  await test("preflight: v55 tables exist and are reachable with the service-role key", async () => {
    for (const t of ["usage_accounts", "usage_reservations", "usage_reservation_items", "usage_events"]) {
      const { error } = await service.from(t).select("id").limit(1);
      assert(
        !error,
        `cannot reach ${t} on project ${cfg.projectRef}: ${error?.message ?? ""}. Apply v55 first:\n` +
          `  py backend/scripts/run_migration.py --apply ` +
          `--sql db/migrate_v55_usage_primitives.sql --project-ref ${cfg.projectRef}`,
      );
    }
  });

  await test("preflight: the RPC surface exists and is callable by service_role", async () => {
    const acct = await makeAccount("preflight");
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_text_generation",
      p_slot_keys: ["s0"],
      p_request_key: `${KEY_PREFIX}:preflight`,
    });
    assertEq(res.ok, true, "usage_reserve should succeed on a fresh account");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. CONCURRENCY — the assertions a fake cannot honestly make
  // ══════════════════════════════════════════════════════════════════════════════
  // N genuinely parallel RPC calls (separate HTTPS requests, real latency, real MVCC
  // row locking) against an account with capacity M < N. Exactly M may be admitted.
  // Not M+1 (double-spend: two racers took the same slot). Not M-1 (a paying user
  // over-throttled).

  await test("concurrency: 24 racers vs 10 image slots → exactly 10 admitted, no negative balance", async () => {
    const M = 10;
    const N = 24;
    const acct = await makeAccount("conc-image", { imagesLimit: M, bonusImages: 0 });

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        rpc("usage_reserve", {
          p_user_id: acct.userId,
          p_usage_type: "ai_image",
          p_slot_keys: [`slot-${i}`],
          p_request_key: `${KEY_PREFIX}:conc-image:${i}`,
        }),
      ),
    );

    // An infrastructure error is NOT a denial — it would make the count meaningless.
    const errored = results.filter(r => r.error !== null);
    assertEq(errored.length, 0, `RPC infrastructure errors: ${errored.map(e => e.error?.message).join("; ")}`);

    const payloads = results.map(r => r.data as Record<string, unknown>);
    const admitted = payloads.filter(p => p.ok === true).length;
    const denied = payloads.filter(p => p.ok === false).length;

    assertEq(admitted, M, `admitted count under real Postgres contention (denied=${denied})`);
    assert(
      payloads.filter(p => p.ok === false).every(p => p.reason === "insufficient_capacity"),
      "every denial must be insufficient_capacity, not an error shape",
    );

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, M, "reserved must equal the limit exactly — never more (double-spend)");
    assertEq(row.ai_images_used, 0, "nothing is used until settlement");
    assert(row.ai_images_reserved >= 0 && row.bonus_images_reserved >= 0, "no negative balances");
    await assertConservation(acct, "conc-image");

    console.log(`        observed: N=${N} racers, M=${M} slots → admitted=${admitted}, denied=${denied}`);
  });

  await test("concurrency: 20 racers vs 6 text slots → exactly 6 admitted", async () => {
    const M = 6;
    const N = 20;
    const acct = await makeAccount("conc-text", { textLimit: M });

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        rpc("usage_reserve", {
          p_user_id: acct.userId,
          p_usage_type: "ai_text_generation",
          p_slot_keys: [`t-${i}`],
          p_request_key: `${KEY_PREFIX}:conc-text:${i}`,
        }),
      ),
    );
    assertEq(results.filter(r => r.error !== null).length, 0, "no RPC infrastructure errors");

    const payloads = results.map(r => r.data as Record<string, unknown>);
    const admitted = payloads.filter(p => p.ok === true).length;
    assertEq(admitted, M, "admitted text reservations");

    const row = await readAccount(acct.id);
    assertEq(row.ai_text_generations_reserved, M, "text reserved must equal the limit exactly");
    await assertConservation(acct, "conc-text");

    console.log(`        observed: N=${N} racers, M=${M} slots → admitted=${admitted}`);
  });

  await test("concurrency: 18 racers vs 5 scheduled posts → exactly 5 consumed", async () => {
    const M = 5;
    const N = 18;
    const acct = await makeAccount("conc-sched", { scheduledLimit: M });

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        rpc("usage_consume_scheduled_post", {
          p_user_id: acct.userId,
          p_idempotency_key: `${KEY_PREFIX}:conc-sched:${i}`,
        }),
      ),
    );
    assertEq(results.filter(r => r.error !== null).length, 0, "no RPC infrastructure errors");

    const payloads = results.map(r => r.data as Record<string, unknown>);
    const admitted = payloads.filter(p => p.ok === true).length;
    assertEq(admitted, M, "consumed scheduled posts");

    const row = await readAccount(acct.id);
    assertEq(row.scheduled_posts_used, M, "scheduled_posts_used must equal the limit exactly");
    assert(row.scheduled_posts_used >= 0, "no negative balance");

    console.log(`        observed: N=${N} racers, M=${M} slots → consumed=${admitted}`);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. IDEMPOTENCY
  // ══════════════════════════════════════════════════════════════════════════════

  await test("concurrent replay of ONE idempotency key produces exactly ONE effect", async () => {
    const acct = await makeAccount("replay", { imagesLimit: 50 });
    const key = `${KEY_PREFIX}:replay-key`;
    const REPLAYS = 12;

    const results = await Promise.all(
      Array.from({ length: REPLAYS }, () =>
        rpc("usage_reserve", {
          p_user_id: acct.userId,
          p_usage_type: "ai_image",
          p_slot_keys: slots(3),
          p_request_key: key,
        }),
      ),
    );

    // Simultaneous first-time inserts can legitimately collide on the unique
    // constraint; PostgREST surfaces that as 23505. What must NOT happen is a second
    // reservation or a second capacity draw.
    const ok = results.filter(r => r.error === null).map(r => r.data as Record<string, unknown>);
    assert(ok.length > 0, "at least one replay must return a result");
    const ids = new Set(ok.map(p => String(p.reservation_id)));
    assertEq(ids.size, 1, `all successful replays must name the SAME reservation (got ${ids.size})`);

    const { data: resRows } = await service
      .from("usage_reservations").select("id").eq("account_id", acct.id).eq("request_key", key);
    assertEq((resRows ?? []).length, 1, "exactly one reservation row for the key");

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 3, `capacity drawn exactly once (${REPLAYS} replays of a 3-slot request)`);

    const { data: evRows } = await service
      .from("usage_events").select("id").eq("account_id", acct.id).eq("operation", "reserve");
    assertEq((evRows ?? []).length, 1, "exactly one reserve event");

    await assertConservation(acct, "replay");
  });

  await test("same idempotency key with CONFLICTING inputs is rejected", async () => {
    const acct = await makeAccount("conflict", { imagesLimit: 50 });
    const key = `${KEY_PREFIX}:conflict-key`;

    const first = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_image",
      p_slot_keys: slots(2),
      p_request_key: key,
    });
    assertEq(first.ok, true, "first reserve should succeed");

    // Different quantity under the same key.
    const qty = await rpc("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_image",
      p_slot_keys: slots(5),
      p_request_key: key,
    });
    assert(qty.error !== null, "a different QUANTITY under the same key must be rejected, not silently replayed");

    // Different usage type under the same key.
    const type = await rpc("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_text_generation",
      p_slot_keys: slots(2),
      p_request_key: key,
    });
    assert(type.error !== null, "a different TYPE under the same key must be rejected");

    // Different slot keys, same count.
    const slotConflict = await rpc("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_image",
      p_slot_keys: ["other-a", "other-b"],
      p_request_key: key,
    });
    assert(slotConflict.error !== null, "different SLOT KEYS under the same key must be rejected");

    // Different reference id.
    const refConflict = await rpc("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_image",
      p_slot_keys: slots(2),
      p_request_key: key,
      p_reference_id: "a-different-reference",
    });
    assert(refConflict.error !== null, "a different REFERENCE under the same key must be rejected");

    // None of the rejections may have altered the balance.
    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 2, "rejected conflicts must not change reserved capacity");
    await assertConservation(acct, "conflict");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. PARTIAL SETTLEMENT — the pool-allocation proof
  // ══════════════════════════════════════════════════════════════════════════════

  await test("partial image settlement credits the CORRECT recurring/bonus pool", async () => {
    // Capacity is arranged so a single 4-slot reservation MUST straddle both pools:
    // 2 recurring slots remain, and the bonus pool holds 2. So slots 0-1 are
    // recurring-funded and slots 2-3 are bonus-funded.
    const acct = await makeAccount("partial", { imagesLimit: 2, bonusImages: 2 });

    const reserved = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_image",
      p_slot_keys: ["s0", "s1", "s2", "s3"],
      p_request_key: `${KEY_PREFIX}:partial`,
    });
    assertEq(reserved.ok, true, "the straddling reservation must be admitted");
    assertEq(reserved.recurring_quantity, 2, "2 slots must be recurring-funded");
    assertEq(reserved.bonus_quantity, 2, "2 slots must be bonus-funded");
    const rid = String(reserved.reservation_id);

    const afterReserve = await readAccount(acct.id);
    assertEq(afterReserve.ai_images_reserved, 2, "recurring reserved after reserve");
    assertEq(afterReserve.bonus_images_reserved, 2, "bonus reserved after reserve");
    await assertConservation(acct, "partial:reserved");

    // ONE recurring slot succeeds, ONE bonus slot succeeds; the other of each fails.
    // This is the case that exposes a wrong-pool credit: if settlement guessed the
    // pool instead of reading the item's own allocation, these numbers diverge.
    await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded",
    });
    await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s2", p_outcome: "succeeded",
    });
    await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s1", p_outcome: "terminal_failed",
    });
    await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s3", p_outcome: "terminal_failed",
    });

    const final = await readAccount(acct.id);
    // s0 succeeded (recurring) → 1 recurring used; s1 failed (recurring) → released.
    assertEq(final.ai_images_used, 1, "exactly the succeeded RECURRING slot is billed");
    assertEq(final.ai_images_reserved, 0, "no recurring capacity left in flight");
    // s2 succeeded (bonus) → 1 bonus used AND permanently removed from the balance;
    // s3 failed (bonus) → returned to the balance, still spendable.
    assertEq(final.bonus_images_used, 1, "exactly the succeeded BONUS slot is billed");
    assertEq(final.bonus_images_reserved, 0, "no bonus capacity left in flight");
    assertEq(final.bonus_images_balance, 1, "the failed bonus slot returns to the balance (2 - 1 consumed)");

    await assertConservation(acct, "partial:settled");

    const { data: resRow } = await service
      .from("usage_reservations").select("state, consumed_quantity, released_quantity").eq("id", rid).single();
    const r = resRow as { state: string; consumed_quantity: number; released_quantity: number };
    assertEq(r.state, "settled", "reservation state once every slot is terminal");
    assertEq(r.consumed_quantity, 2, "consumed quantity");
    assertEq(r.released_quantity, 2, "released quantity");

    console.log(
      `        reserved 4 (2 recurring + 2 bonus); 1 of each succeeded → ` +
        `recurring used=${final.ai_images_used}, bonus used=${final.bonus_images_used}, ` +
        `bonus balance=${final.bonus_images_balance}, all reserved=0`,
    );
  });

  await test("replayed settlement and replayed release are no-ops", async () => {
    const acct = await makeAccount("settle-replay", { imagesLimit: 10 });
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_image",
      p_slot_keys: slots(3),
      p_request_key: `${KEY_PREFIX}:settle-replay`,
    });
    const rid = String(res.reservation_id);

    // Settle one slot, then replay that settlement 5 times CONCURRENTLY.
    await rpcOk("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded" });
    const replays = await Promise.all(
      Array.from({ length: 5 }, () =>
        rpc("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded" }),
      ),
    );
    assertEq(replays.filter(r => r.error !== null).length, 0, "replayed settle must not error");
    assert(
      replays.every(r => (r.data as Record<string, unknown>).replayed === true),
      "every replayed settle must report replayed=true",
    );

    let row = await readAccount(acct.id);
    assertEq(row.ai_images_used, 1, "5 replayed settlements must bill exactly once");
    assertEq(row.ai_images_reserved, 2, "the other two slots stay reserved");

    // Release the remainder, then replay the release.
    await rpcOk("usage_release_reservation", { p_reservation_id: rid });
    const relReplays = await Promise.all(
      Array.from({ length: 4 }, () => rpc("usage_release_reservation", { p_reservation_id: rid })),
    );
    assertEq(relReplays.filter(r => r.error !== null).length, 0, "replayed release must not error");

    row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 0, "release returns the pending slots exactly once");
    assertEq(row.ai_images_used, 1, "release must NOT claw back the already-settled slot");
    await assertConservation(acct, "settle-replay");
  });

  await test("release leaves already-settled slots alone", async () => {
    const acct = await makeAccount("release-mixed", { imagesLimit: 10 });
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId, p_usage_type: "ai_image",
      p_slot_keys: slots(4), p_request_key: `${KEY_PREFIX}:release-mixed`,
    });
    const rid = String(res.reservation_id);

    await rpcOk("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded" });
    await rpcOk("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s1", p_outcome: "terminal_failed" });

    const rel = await rpcOk("usage_release_reservation", { p_reservation_id: rid });
    assertEq(rel.released_quantity, 2, "only the two still-pending slots are released");

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_used, 1, "the succeeded slot stays billed");
    assertEq(row.ai_images_reserved, 0, "nothing left in flight");
    await assertConservation(acct, "release-mixed");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. RACES WITH EXPIRY — exactly one winner
  // ══════════════════════════════════════════════════════════════════════════════

  await test("reserve-vs-expire race has exactly ONE valid winner", async () => {
    const acct = await makeAccount("race-reserve-expire", { imagesLimit: 4 });

    // Fill the account with an ALREADY-EXPIRED reservation. Capacity is only
    // available to a new reserve if the sweeper reclaims it first.
    const stale = await rpcOk("usage_reserve", {
      p_user_id: acct.userId, p_usage_type: "ai_image",
      p_slot_keys: slots(4, "stale"), p_request_key: `${KEY_PREFIX}:race-stale`,
      p_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    assertEq(stale.ok, true, "the stale reservation must be admitted");

    // Fire the sweeper and a fresh 4-slot reserve simultaneously. Both orderings are
    // legal; what must never happen is BOTH succeeding in a way that leaves more
    // reserved than the limit allows.
    const [expireRes, reserveRes] = await Promise.all([
      rpc("usage_expire_reservations", { p_limit: 10 }),
      rpc("usage_reserve", {
        p_user_id: acct.userId, p_usage_type: "ai_image",
        p_slot_keys: slots(4, "fresh"), p_request_key: `${KEY_PREFIX}:race-fresh`,
      }),
    ]);

    assertEq(expireRes.error, null, `expire errored: ${expireRes.error?.message ?? ""}`);
    assertEq(reserveRes.error, null, `reserve errored: ${reserveRes.error?.message ?? ""}`);

    const row = await readAccount(acct.id);
    // Whatever the interleaving, the ledger must never over-commit.
    assert(
      row.ai_images_reserved <= 4,
      `reserved ${row.ai_images_reserved} exceeds the limit 4 — the race over-committed capacity`,
    );
    assert(row.ai_images_reserved >= 0, "no negative reserved");
    await assertConservation(acct, "race-reserve-expire");

    const reservePayload = reserveRes.data as Record<string, unknown>;
    console.log(
      `        expire=${JSON.stringify((expireRes.data as Record<string, unknown>).expired_count)} ` +
        `reserve.ok=${reservePayload.ok} → reserved=${row.ai_images_reserved} (limit 4, never exceeded)`,
    );
  });

  await test("settle-vs-expire race has exactly ONE valid winner", async () => {
    const acct = await makeAccount("race-settle-expire", { imagesLimit: 10 });
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId, p_usage_type: "ai_image",
      p_slot_keys: slots(2), p_request_key: `${KEY_PREFIX}:race-settle`,
      p_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const rid = String(res.reservation_id);

    const [settleRes, expireRes] = await Promise.all([
      rpc("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded" }),
      rpc("usage_expire_reservations", { p_limit: 10 }),
    ]);
    assertEq(settleRes.error, null, `settle errored: ${settleRes.error?.message ?? ""}`);
    assertEq(expireRes.error, null, `expire errored: ${expireRes.error?.message ?? ""}`);

    // The slot ended EITHER succeeded (settle won) OR expired (sweeper won) — never
    // both, and never counted twice.
    const { data: itemRows } = await service
      .from("usage_reservation_items").select("slot_key, state").eq("reservation_id", rid);
    const items = (itemRows ?? []) as { slot_key: string; state: string }[];
    const s0 = items.find(i => i.slot_key === "s0");
    assert(!!s0, "slot s0 must exist");
    assert(
      s0!.state === "succeeded" || s0!.state === "expired",
      `s0 must have exactly one terminal outcome, got ${s0!.state}`,
    );

    const row = await readAccount(acct.id);
    assert(row.ai_images_used <= 1, `at most one slot may be billed, got ${row.ai_images_used}`);
    assert(row.ai_images_reserved >= 0, "no negative reserved");
    await assertConservation(acct, "race-settle-expire");

    const settlePayload = settleRes.data as Record<string, unknown>;
    console.log(
      `        winner: s0 state=${s0!.state}, settle.ok=${settlePayload.ok} ` +
        `reason=${settlePayload.reason ?? "-"}, used=${row.ai_images_used}`,
    );
  });

  await test("late settlement after expiry FAILS CLOSED", async () => {
    const acct = await makeAccount("late-settle", { imagesLimit: 10 });
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId, p_usage_type: "ai_image",
      p_slot_keys: slots(2), p_request_key: `${KEY_PREFIX}:late-settle`,
      p_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const rid = String(res.reservation_id);

    // Sweep first, so the capacity is definitively back with the user.
    await rpcOk("usage_expire_reservations", { p_limit: 10 });
    const beforeLate = await readAccount(acct.id);

    // A restarted worker now tries to bank its output.
    const late = await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded",
    });
    // It must be a REFUSAL (ok=false), not a cheerful replayed=true. The sweeper
    // marks slots 'expired' as well as the reservation, so a naive implementation
    // reports this as a duplicate settle and the caller wrongly concludes its output
    // was banked. The reservation-level check must win.
    assertEq(late.ok, false, "settlement after expiry must be REFUSED, not reported as a replay");
    assert(
      late.reason === "reservation_not_pending" || late.reason === "reservation_expired",
      `refusal must name the cause, got ${String(late.reason)}`,
    );
    assertEq(late.replayed, undefined, "a refusal must not masquerade as a successful replay");

    const after = await readAccount(acct.id);
    assertEq(after.ai_images_used, beforeLate.ai_images_used, "a refused late settle must not bill");
    assertEq(after.ai_images_reserved, beforeLate.ai_images_reserved, "a refused late settle must not move reserved");
    await assertConservation(acct, "late-settle");
  });

  await test("a RELEASED reservation rejects late output", async () => {
    const acct = await makeAccount("late-after-release", { imagesLimit: 10 });
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId, p_usage_type: "ai_image",
      p_slot_keys: slots(2), p_request_key: `${KEY_PREFIX}:late-release`,
    });
    const rid = String(res.reservation_id);
    await rpcOk("usage_release_reservation", { p_reservation_id: rid });

    const late = await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded",
    });
    // The slot itself is already terminal ('released'), so this is reported as a
    // replay rather than a fresh refusal — either way it must not bill.
    const row = await readAccount(acct.id);
    assertEq(row.ai_images_used, 0, "output arriving after a release must never be billed");
    assertEq(row.ai_images_reserved, 0, "reserved stays at zero");
    assert(late.ok === true || late.ok === false, "call must return a structured result");
    await assertConservation(acct, "late-after-release");
  });

  await test("expiry SKIPS a reservation whose job still holds a live lease", async () => {
    const acct = await makeAccount("live-lease", { imagesLimit: 10 });
    const res = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId,
      p_slot_keys: slots(2),
      p_request_key: `${KEY_PREFIX}:live-lease`,
      p_params: { keyword: "itest" },
      p_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const jobId = String(res.job_id);

    // The worker is alive and heartbeating: proof of life.
    const { error: hbErr } = await service
      .from("generation_jobs")
      .update({ status: "running", worker_heartbeat_at: new Date().toISOString() })
      .eq("id", jobId);
    assert(!hbErr, `heartbeat update failed: ${hbErr?.message ?? ""}`);

    await rpcOk("usage_expire_reservations", { p_limit: 50, p_lease_seconds: 300 });

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 2, "a live lease must protect its reservation from the sweeper");

    const { data: resRow } = await service
      .from("usage_reservations").select("state").eq("id", String(res.reservation_id)).single();
    assertEq((resRow as { state: string }).state, "pending", "the reservation stays pending while the worker lives");
    await assertConservation(acct, "live-lease");
  });

  await test("expiry marks a STALE job terminal so a restarted worker cannot publish late", async () => {
    const acct = await makeAccount("stale-lease", { imagesLimit: 10 });
    const res = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId,
      p_slot_keys: slots(2),
      p_request_key: `${KEY_PREFIX}:stale-lease`,
      p_params: { keyword: "itest" },
      p_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const jobId = String(res.job_id);

    // Worker died: heartbeat is far older than the lease window.
    await service
      .from("generation_jobs")
      .update({ status: "running", worker_heartbeat_at: new Date(Date.now() - 3600_000).toISOString() })
      .eq("id", jobId);

    const swept = await rpcOk("usage_expire_reservations", { p_limit: 50, p_lease_seconds: 300 });
    assert(Number(swept.expired_count) >= 1, "the stale reservation must be swept");

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 0, "capacity returns to the user");

    const { data: jobRow } = await service
      .from("generation_jobs").select("status").eq("id", jobId).single();
    assertEq((jobRow as { status: string }).status, "failed", "the linked job must be marked terminal");
    await assertConservation(acct, "stale-lease");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. TRANSACTION ISOLATION — the proof Phase 1A could not make
  // ══════════════════════════════════════════════════════════════════════════════

  await test("injected failure rolls back EVERY statement, including the generation_jobs insert", async () => {
    const acct = await makeAccount("rollback", { imagesLimit: 10 });
    const key = `${KEY_PREFIX}:rollback`;

    const before = await readAccount(acct.id);

    const res = await rpc("usage_reserve_generation_job", {
      p_user_id: acct.userId,
      p_slot_keys: slots(3),
      p_request_key: key,
      p_params: { keyword: "itest-rollback" },
      p_force_error: true,
    });
    assert(res.error !== null, "the injected failure must surface as an error, not a silent success");

    // NOW THE POINT: the function wrote a reservation, 3 items, an event AND a
    // generation_jobs row before raising. Every one of them must be gone.
    const { data: resRows } = await service
      .from("usage_reservations").select("id").eq("account_id", acct.id).eq("request_key", key);
    assertEq((resRows ?? []).length, 0, "the RESERVATION must have been rolled back");

    const { data: evRows } = await service
      .from("usage_events").select("id").eq("account_id", acct.id);
    assertEq((evRows ?? []).length, 0, "the EVENT must have been rolled back");

    const { data: jobRows } = await service
      .from("generation_jobs").select("id").eq("vibepin_user_id", acct.userId);
    assertEq((jobRows ?? []).length, 0, "the GENERATION_JOBS row must have been rolled back");

    const after = await readAccount(acct.id);
    assertEq(after.ai_images_reserved, before.ai_images_reserved, "reserved counter must be unchanged");
    assertEq(after.ai_images_used, before.ai_images_used, "used counter must be unchanged");
    assertEq(after.version, before.version, "the account version must not have advanced");

    // And the key must still be usable — a rolled-back attempt must not poison it.
    const retry = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId,
      p_slot_keys: slots(3),
      p_request_key: key,
      p_params: { keyword: "itest-rollback" },
    });
    assertEq(retry.ok, true, "after a rolled-back attempt the same key must still work");
    assert(!!retry.job_id, "the retry must enqueue a real job");
    await assertConservation(acct, "rollback");

    console.log(
      `        after injected failure: reservations=0, events=0, generation_jobs=0, ` +
        `version unchanged (${before.version}); retry then succeeded`,
    );
  });

  await test("usage_reserve_generation_job links exactly one job per reservation", async () => {
    const acct = await makeAccount("job-link", { imagesLimit: 10 });
    const key = `${KEY_PREFIX}:job-link`;

    const first = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId, p_slot_keys: slots(2), p_request_key: key,
      p_params: { keyword: "itest" },
    });
    assertEq(first.ok, true, "first enqueue succeeds");
    const jobId = String(first.job_id);

    // Replay: same key must return the SAME job, not enqueue a second one.
    const replay = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId, p_slot_keys: slots(2), p_request_key: key,
      p_params: { keyword: "itest" },
    });
    assertEq(replay.replayed, true, "the replay must be reported as such");
    assertEq(String(replay.job_id), jobId, "the replay must return the ORIGINAL job id");

    const { data: jobRows } = await service
      .from("generation_jobs").select("id").eq("vibepin_user_id", acct.userId);
    assertEq((jobRows ?? []).length, 1, "exactly one generation_jobs row");

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 2, "capacity drawn exactly once");
    await assertConservation(acct, "job-link");
  });

  await test("a capacity refusal enqueues NO job", async () => {
    const acct = await makeAccount("refuse-job", { imagesLimit: 1 });
    const res = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId, p_slot_keys: slots(4), p_request_key: `${KEY_PREFIX}:refuse-job`,
      p_params: { keyword: "itest" },
    });
    assertEq(res.ok, false, "4 slots against a limit of 1 with no bonus must be refused");
    assertEq(res.job_id, null, "a refused reservation must not enqueue a job");

    const { data: jobRows } = await service
      .from("generation_jobs").select("id").eq("vibepin_user_id", acct.userId);
    assertEq((jobRows ?? []).length, 0, "no generation_jobs row for a refused request");

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 0, "a refusal draws no capacity");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 6. UNLIMITED PLANS still record usage
  // ══════════════════════════════════════════════════════════════════════════════

  await test("unlimited scheduled posts (NULL limit) skip rejection but write exactly ONE event", async () => {
    const acct = await makeAccount("unlimited-sched", { scheduledLimit: null });
    const key = `${KEY_PREFIX}:unlimited-sched`;

    const res = await rpcOk("usage_consume_scheduled_post", {
      p_user_id: acct.userId, p_idempotency_key: key,
    });
    assertEq(res.ok, true, "an unlimited plan must never be rejected");
    assertEq(res.unlimited, true, "the result must report the unlimited path");

    const { data: evRows } = await service
      .from("usage_events").select("id, quantity, operation")
      .eq("account_id", acct.id).eq("idempotency_key", key);
    assertEq((evRows ?? []).length, 1, "EXACTLY ONE event — unlimited must not mean uncounted");

    const row = await readAccount(acct.id);
    assertEq(row.scheduled_posts_used, 1, "usage is still counted on an unlimited plan");

    // A far-beyond-any-plan burst must all succeed and all be recorded.
    const BURST = 12;
    const burst = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        rpc("usage_consume_scheduled_post", {
          p_user_id: acct.userId, p_idempotency_key: `${key}:burst:${i}`,
        }),
      ),
    );
    assertEq(burst.filter(r => r.error !== null).length, 0, "no errors on the unlimited path");
    assertEq(
      burst.filter(r => (r.data as Record<string, unknown>).ok === true).length,
      BURST,
      "every unlimited consume must be admitted",
    );

    const finalRow = await readAccount(acct.id);
    assertEq(finalRow.scheduled_posts_used, BURST + 1, "every unlimited consume is counted");
  });

  await test("unlimited scheduled posts remain idempotent under concurrent replay", async () => {
    const acct = await makeAccount("unlimited-idem", { scheduledLimit: null });
    const key = `${KEY_PREFIX}:unlimited-idem`;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        rpc("usage_consume_scheduled_post", { p_user_id: acct.userId, p_idempotency_key: key }),
      ),
    );
    assertEq(results.filter(r => r.error !== null).length, 0, "concurrent replays must not error");

    const { data: evRows } = await service
      .from("usage_events").select("id").eq("account_id", acct.id).eq("idempotency_key", key);
    assertEq((evRows ?? []).length, 1, "10 concurrent replays → exactly ONE event");

    const row = await readAccount(acct.id);
    assertEq(row.scheduled_posts_used, 1, "10 concurrent replays → charged exactly once");
  });

  await test("unlimited IMAGE limit (NULL) admits without touching the bonus pool", async () => {
    const acct = await makeAccount("unlimited-img", { imagesLimit: null, bonusImages: 5 });
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId, p_usage_type: "ai_image",
      p_slot_keys: slots(8), p_request_key: `${KEY_PREFIX}:unlimited-img`,
    });
    assertEq(res.ok, true, "an unlimited image plan admits any quantity");
    assertEq(res.recurring_quantity, 8, "all slots are recurring-funded");
    assertEq(res.bonus_quantity, 0, "the bonus pool must be untouched while recurring is unlimited");

    const row = await readAccount(acct.id);
    assertEq(row.bonus_images_reserved, 0, "no bonus reserved");
    assertEq(row.bonus_images_balance, 5, "bonus balance intact");
    await assertConservation(acct, "unlimited-img");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 7. IMMUTABILITY — enforced by the database, not by convention
  // ══════════════════════════════════════════════════════════════════════════════

  await test("usage_events is append-only: even service_role cannot UPDATE or DELETE", async () => {
    const acct = await makeAccount("immutable", { scheduledLimit: 10 });
    await rpcOk("usage_consume_scheduled_post", {
      p_user_id: acct.userId, p_idempotency_key: `${KEY_PREFIX}:immutable`,
    });

    const { data: evRows } = await service
      .from("usage_events").select("id, quantity").eq("account_id", acct.id);
    const ev = (evRows ?? [])[0] as { id: string; quantity: number };
    assert(!!ev, "an event must exist to attempt mutating");

    // UPDATE must be rejected by the trigger — and re-read to prove it, since a
    // zero-row PATCH also returns 204.
    const upd = await service.from("usage_events").update({ quantity: 999 }).eq("id", ev.id);
    assert(upd.error !== null, "UPDATE on usage_events must raise, not silently no-op");

    const { data: afterUpd } = await service
      .from("usage_events").select("quantity").eq("id", ev.id).single();
    assertEq((afterUpd as { quantity: number }).quantity, ev.quantity, "the event value must be unchanged");

    // A TARGETED delete (the account still exists) must be rejected — this is the
    // "doctor one inconvenient row" attack the append-only rule exists to stop.
    const del = await service.from("usage_events").delete().eq("id", ev.id);
    assert(del.error !== null, "targeted DELETE on usage_events must raise");

    const { data: afterDel } = await service
      .from("usage_events").select("id").eq("id", ev.id);
    assertEq((afterDel ?? []).length, 1, "the event row must still exist after the rejected DELETE");
  });

  await test("account erasure CASCADES through usage_events (audit trail is not a deletion deadlock)", async () => {
    // The append-only trigger must not make accounts undeletable: an account that
    // cannot be erased is a GDPR problem and, as this suite found the hard way, a
    // cleanup deadlock. Deleting the ACCOUNT must take its events with it, while a
    // targeted event delete (asserted above) stays refused.
    const acct = await makeAccount("cascade-erase", { scheduledLimit: 10 });
    await rpcOk("usage_consume_scheduled_post", {
      p_user_id: acct.userId, p_idempotency_key: `${KEY_PREFIX}:cascade-erase`,
    });

    const { data: evBefore } = await service
      .from("usage_events").select("id").eq("account_id", acct.id);
    assert((evBefore ?? []).length >= 1, "an event must exist before the erasure");

    const del = await service.from("usage_accounts").delete().eq("id", acct.id);
    assert(del.error === null, `account erasure must succeed, got: ${del.error?.message ?? ""}`);

    const { data: acctAfter } = await service.from("usage_accounts").select("id").eq("id", acct.id);
    assertEq((acctAfter ?? []).length, 0, "the account must be gone");

    const { data: evAfter } = await service
      .from("usage_events").select("id").eq("account_id", acct.id);
    assertEq((evAfter ?? []).length, 0, "its events must have cascaded away with it");

    createdAccounts.delete(acct.id);
  });

  await test("usage_accounts.user_id is immutable", async () => {
    const acct = await makeAccount("immutable-user");
    const other = randomUUID();
    const upd = await service.from("usage_accounts").update({ user_id: other }).eq("id", acct.id);
    assert(upd.error !== null, "re-pointing an account at another user must raise");

    const { data } = await service.from("usage_accounts").select("user_id").eq("id", acct.id).single();
    assertEq((data as { user_id: string }).user_id, acct.userId, "user_id must be unchanged");
  });

  await test("CHECK constraints reject negative counters", async () => {
    const acct = await makeAccount("check-negative");
    const upd = await service.from("usage_accounts").update({ ai_images_used: -1 }).eq("id", acct.id);
    assert(upd.error !== null, "a negative counter must be rejected by the database");

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_used, 0, "the value must be unchanged after the rejected write");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 8. RLS + RPC PRIVILEGE — anon/authenticated must reach nothing
  // ══════════════════════════════════════════════════════════════════════════════
  // Assertions are on ROWS and RE-READ VALUES, never on status codes (200+[] and 204
  // both look like success).

  await test("RLS: anon cannot READ any usage table (200 + [] is not access)", async () => {
    const acct = await makeAccount("rls-read", { scheduledLimit: 10 });
    await rpcOk("usage_consume_scheduled_post", {
      p_user_id: acct.userId, p_idempotency_key: `${KEY_PREFIX}:rls-read`,
    });

    // Prove the rows genuinely exist for the service role first — otherwise "anon saw
    // nothing" would be trivially true and this test would prove nothing.
    const { data: proof } = await service.from("usage_accounts").select("id").eq("id", acct.id);
    assertEq((proof ?? []).length, 1, "the account must exist for the service role");

    for (const t of ["usage_accounts", "usage_reservations", "usage_reservation_items", "usage_events"]) {
      const { data, error } = await anon.from(t).select("id").limit(5);
      if (!error) {
        assertEq((data ?? []).length, 0, `anon SELECT on ${t} must return ZERO rows`);
      }
    }
  });

  await test("RLS: anon cannot WRITE (verified by re-reading, not by status)", async () => {
    const acct = await makeAccount("rls-write", { imagesLimit: 10 });
    const before = await readAccount(acct.id);

    // UPDATE attempt — a 204 proves nothing, so re-read.
    await anon.from("usage_accounts").update({ ai_images_limit: 999999 }).eq("id", acct.id);
    const afterUpd = await readAccount(acct.id);
    assertEq(afterUpd.ai_images_limit, before.ai_images_limit, "anon UPDATE must not raise the limit");

    // DELETE attempt.
    await anon.from("usage_accounts").delete().eq("id", acct.id);
    const { data: stillThere } = await service.from("usage_accounts").select("id").eq("id", acct.id);
    assertEq((stillThere ?? []).length, 1, "anon DELETE must not remove the account");

    // INSERT attempt — verified by absence under the service role.
    const ghostUser = randomUUID();
    await anon.from("usage_accounts").insert({
      user_id: ghostUser,
      plan_key: `${KEY_PREFIX}:ghost`,
      period_start: new Date().toISOString(),
      period_end: new Date(Date.now() + 86400_000).toISOString(),
      period_anchor: new Date().toISOString(),
    });
    const { data: ghost } = await service.from("usage_accounts").select("id").eq("user_id", ghostUser);
    assertEq((ghost ?? []).length, 0, "anon INSERT must not create an account");
  });

  await test("RPC: anon cannot EXECUTE any usage_* function; service_role can", async () => {
    const acct = await makeAccount("rpc-priv", { imagesLimit: 10, scheduledLimit: 10 });

    // The dangerous ones: minting capacity, or spending someone else's.
    const anonReserve = await anon.rpc("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_image",
      p_slot_keys: ["x0"],
      p_request_key: `${KEY_PREFIX}:anon-reserve`,
    });
    assert(anonReserve.error !== null, "anon must NOT be able to execute usage_reserve");

    const anonConsume = await anon.rpc("usage_consume_scheduled_post", {
      p_user_id: acct.userId, p_idempotency_key: `${KEY_PREFIX}:anon-consume`,
    });
    assert(anonConsume.error !== null, "anon must NOT be able to execute usage_consume_scheduled_post");

    const anonExpire = await anon.rpc("usage_expire_reservations", { p_limit: 5 });
    assert(anonExpire.error !== null, "anon must NOT be able to execute usage_expire_reservations");

    const anonRelease = await anon.rpc("usage_release_reservation", {
      p_reservation_id: randomUUID(),
    });
    assert(anonRelease.error !== null, "anon must NOT be able to execute usage_release_reservation");

    const anonSettle = await anon.rpc("usage_settle_reservation_item", {
      p_reservation_id: randomUUID(), p_slot_key: "x", p_outcome: "succeeded",
    });
    assert(anonSettle.error !== null, "anon must NOT be able to execute usage_settle_reservation_item");

    const anonJob = await anon.rpc("usage_reserve_generation_job", {
      p_user_id: acct.userId, p_slot_keys: ["x0"],
      p_request_key: `${KEY_PREFIX}:anon-job`, p_params: {},
    });
    assert(anonJob.error !== null, "anon must NOT be able to execute usage_reserve_generation_job");

    // The blocked calls must have had no effect — a rejection that still wrote would
    // be the worst of both worlds.
    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 0, "no capacity may be drawn by a blocked anon call");
    assertEq(row.scheduled_posts_used, 0, "no consumption by a blocked anon call");

    // And the same call DOES work for service_role, so the assertions above are
    // about privilege and not about a malformed request.
    const svc = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_image",
      p_slot_keys: ["x0"],
      p_request_key: `${KEY_PREFIX}:svc-reserve`,
    });
    assertEq(svc.ok, true, "service_role must succeed with the identical call anon was refused");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 9. Cleanup, asserted
  // ══════════════════════════════════════════════════════════════════════════════
  const removed = await cleanup();
  await test("cleanup: every row this run created has been removed", async () => {
    const { data, error } = await service
      .from("usage_accounts").select("id").like("plan_key", `${KEY_PREFIX}:%`);
    assert(!error, `post-cleanup verification failed: ${error?.message ?? ""}`);
    assertEq((data ?? []).length, 0, `accounts left behind by run ${RUN_ID}`);

    // Cascade check: no orphaned children.
    for (const userId of createdUsers) {
      const { data: jobs } = await service
        .from("generation_jobs").select("id").eq("vibepin_user_id", userId);
      assertEq((jobs ?? []).length, 0, `generation_jobs left behind for ${userId}`);
    }
    console.log(`        removed ${removed} account(s) (cascade) for run ${RUN_ID}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

main().catch(async err => {
  console.error("\nFATAL:", (err as Error).message);
  try {
    const removed = await cleanup();
    console.error(`(cleanup removed ${removed} account(s) for run ${RUN_ID})`);
  } catch (cleanupErr) {
    console.error(`(cleanup ALSO failed: ${(cleanupErr as Error).message} — run id ${RUN_ID})`);
  }
  process.exit(1);
});
