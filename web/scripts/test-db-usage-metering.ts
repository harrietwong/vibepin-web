/**
 * test-db-usage-metering.ts — real-Postgres proof for Phase 4I image metering.
 * Run: npm run test:db      (NOT part of `npm test`)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 4I wires /api/generate (worker path) to usage_reserve_generation_job and the
 * VPS worker to usage_settle_reservation_item / usage_release_reservation. The route
 * and worker unit tests mock the RPCs; THIS suite drives the exact same RPC cycle
 * against real Postgres, so the end-to-end contract the app now depends on is proven
 * against the database, not a fake:
 *
 *   reserve_generation_job  → a generation_jobs row exists AND carries
 *                             usage_reservation_id (the link the worker reads).
 *   settle s0 succeeded + s1 terminal_failed  → reservation ends PARTIAL, and the
 *                             account counters move exactly (used +1, released +1,
 *                             reserved back to 0).
 *   the slot keys are the SAME ["s0","s1",...] the TS module produces and the worker
 *                             reconstructs — so settlement actually matches.
 *   release  → a reservation with no slot run returns all capacity.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SAFETY — READ scripts/lib/test-db-config.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 * WRITES AND DELETES REAL ROWS. Target resolved exclusively from TEST_SUPABASE_*
 * (no production fallback; refuses the known production ref; fails loudly if creds
 * are absent). Per-run UUID namespace + `itest:<runId>` key prefix so parallel runs
 * cannot collide. usage_accounts is the cascade cleanup root; generation_jobs is NOT
 * cascaded from it, so this run's jobs are deleted explicitly by vibepin_user_id.
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
    console.error("\n=== USAGE METERING DB TEST CANNOT RUN ===\n");
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

type Account = { id: string; userId: string };

/** Seed a usage_accounts row directly (service role) — same idiom as
 *  test-usage-ledger-db.ts. Phase 4I does not add an account-creation RPC. */
async function makeAccount(label: string, imagesLimit: number | null = 100): Promise<Account> {
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
      ai_images_limit: imagesLimit,
      ai_text_generations_limit: 100,
      scheduled_posts_limit: 100,
      bonus_images_balance: 0,
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
  ai_images_used: number;
  ai_images_reserved: number;
  bonus_images_used: number;
  bonus_images_reserved: number;
};

async function readAccount(id: string): Promise<AccountRow> {
  const { data, error } = await service
    .from("usage_accounts")
    .select("ai_images_used, ai_images_reserved, bonus_images_used, bonus_images_reserved")
    .eq("id", id)
    .single();
  if (error) throw new Error(`readAccount failed: ${error.message}`);
  return data as unknown as AccountRow;
}

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

async function rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await service.rpc(fn, args);
  return { data, error: error ? { message: error.message, code: error.code } : null };
}

async function rpcOk(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn} errored: ${error.message}`);
  return data as Record<string, unknown>;
}

/** The SAME slot-key convention the TS module (slotKeysForCount) and the worker
 *  (_slot_key) produce: ["s0","s1",...]. */
function slots(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `s${i}`);
}

async function cleanup(): Promise<number> {
  let removed = 0;
  for (const id of createdAccounts) {
    const { error, count } = await service
      .from("usage_accounts")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw new Error(`cleanup failed for account ${id}: ${error.message}`);
    removed += count ?? 0;
  }
  // generation_jobs is NOT cascaded from usage_accounts — sweep this run's jobs.
  for (const userId of createdUsers) {
    await service.from("generation_jobs").delete().eq("vibepin_user_id", userId);
  }
  const { error: sweepErr, count: sweepCount } = await service
    .from("usage_accounts")
    .delete({ count: "exact" })
    .like("plan_key", `${KEY_PREFIX}:%`);
  if (sweepErr) throw new Error(`cleanup sweep failed: ${sweepErr.message}`);
  return removed + (sweepCount ?? 0);
}

async function main(): Promise<void> {
  console.log("\n=== REAL POSTGRES INTEGRATION — Phase 4I image metering ===");
  console.log(`  target project ref : ${cfg.projectRef}`);
  console.log(`  run id             : ${RUN_ID}`);
  console.log("  (writes and deletes real rows; never production — see lib/test-db-config.ts)\n");

  await test("preflight: v55 RPC + generation_jobs.usage_reservation_id reachable", async () => {
    const acct = await makeAccount("preflight");
    const res = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId,
      p_slot_keys: slots(1),
      p_request_key: `${KEY_PREFIX}:preflight`,
      p_params: { keyword: "itest" },
    });
    assertEq(res.ok, true, "reserve_generation_job succeeds on a fresh account");
    const jobId = String(res.job_id);
    const { data: jobRow, error } = await service
      .from("generation_jobs")
      .select("usage_reservation_id")
      .eq("id", jobId)
      .single();
    assert(!error, `job read failed: ${error?.message ?? ""}`);
    assertEq(
      String((jobRow as { usage_reservation_id: string }).usage_reservation_id),
      String(res.reservation_id),
      "the job row carries the reservation id the worker reads",
    );
  });

  // ── THE END-TO-END CYCLE the route + worker now drive ─────────────────────────
  await test("reserve → job linked → settle s0 success + s1 fail → reservation PARTIAL, counters exact", async () => {
    const acct = await makeAccount("cycle", 100);
    const key = `${KEY_PREFIX}:cycle`;

    // 1. Route path: reserve AND enqueue in one transaction.
    const res = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId,
      p_slot_keys: slots(2), // ["s0","s1"] — the exact keys TS produces
      p_request_key: key,
      p_params: { keyword: "itest", count: 2 },
      p_operation: "image_generation",
    });
    assertEq(res.ok, true, "reserve admitted");
    const rid = String(res.reservation_id);
    const jobId = String(res.job_id);
    assert(!!rid && !!jobId, "reservation and job ids present");

    // The job row is real and linked.
    const { data: jobRow } = await service
      .from("generation_jobs")
      .select("status, usage_reservation_id, results, vibepin_user_id")
      .eq("id", jobId)
      .single();
    const job = jobRow as { status: string; usage_reservation_id: string; results: unknown[]; vibepin_user_id: string };
    assertEq(job.vibepin_user_id, acct.userId, "job owned by the reserving user");
    assertEq(String(job.usage_reservation_id), rid, "job.usage_reservation_id links to the reservation");
    assert(Array.isArray(job.results) && job.results.length === 2, "results seeded with 2 pending slots");

    const afterReserve = await readAccount(acct.id);
    assertEq(afterReserve.ai_images_reserved, 2, "2 slots reserved");
    assertEq(afterReserve.ai_images_used, 0, "nothing used until settle");

    // 2. Worker path: settle s0 succeeded, s1 terminal_failed — with the SAME keys.
    const s0 = await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded",
    });
    assertEq(s0.ok, true, "settle s0 succeeded");
    const s1 = await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s1", p_outcome: "terminal_failed",
    });
    assertEq(s1.ok, true, "settle s1 terminal_failed");

    // 3. Counters: used +1 (s0), released +1 (s1), reserved back to 0.
    const final = await readAccount(acct.id);
    assertEq(final.ai_images_used, 1, "exactly the succeeded slot is billed");
    assertEq(final.ai_images_reserved, 0, "no capacity left in flight");

    // Reservation itself is now 'settled' (every slot terminal), with the split.
    const { data: resRow } = await service
      .from("usage_reservations")
      .select("state, consumed_quantity, released_quantity")
      .eq("id", rid)
      .single();
    const r = resRow as { state: string; consumed_quantity: number; released_quantity: number };
    assertEq(r.state, "settled", "reservation is terminal once every slot settled");
    assertEq(r.consumed_quantity, 1, "one slot consumed (s0)");
    assertEq(r.released_quantity, 1, "one slot released (s1 failed)");

    // Slot-item states carry the per-slot outcome the worker wrote.
    const { data: items } = await service
      .from("usage_reservation_items")
      .select("slot_key, state")
      .eq("reservation_id", rid);
    const bySlot = Object.fromEntries(((items ?? []) as { slot_key: string; state: string }[]).map(i => [i.slot_key, i.state]));
    assertEq(bySlot.s0, "succeeded", "s0 item succeeded");
    assertEq(bySlot.s1, "terminal_failed", "s1 item terminal_failed");

    console.log(
      `        reserved 2 (s0,s1) → settle s0 success + s1 fail → used=${final.ai_images_used}, ` +
        `released=${r.released_quantity}, reserved=${final.ai_images_reserved}, state=${r.state}`,
    );
  });

  await test("settle is idempotent: a replayed s0 success bills exactly once", async () => {
    const acct = await makeAccount("settle-idem", 100);
    const res = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId, p_slot_keys: slots(2),
      p_request_key: `${KEY_PREFIX}:settle-idem`, p_params: { keyword: "itest" },
    });
    const rid = String(res.reservation_id);

    await rpcOk("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded" });
    // Replay the same settle (a reclaimed worker re-running a slot it already banked).
    const replay = await rpcOk("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded" });
    assertEq(replay.replayed, true, "the second settle is a no-op replay");

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_used, 1, "billed exactly once despite the replay");
    assertEq(row.ai_images_reserved, 1, "s1 still reserved");
  });

  await test("release returns all capacity when no slot ran (prepare-level failure)", async () => {
    const acct = await makeAccount("release", 100);
    const res = await rpcOk("usage_reserve_generation_job", {
      p_user_id: acct.userId, p_slot_keys: slots(3),
      p_request_key: `${KEY_PREFIX}:release`, p_params: { keyword: "itest" },
    });
    const rid = String(res.reservation_id);

    const afterReserve = await readAccount(acct.id);
    assertEq(afterReserve.ai_images_reserved, 3, "3 reserved before release");

    const rel = await rpcOk("usage_release_reservation", { p_reservation_id: rid, p_reason: "prepare_failed" });
    assertEq(rel.released_quantity, 3, "all three pending slots released");

    const row = await readAccount(acct.id);
    assertEq(row.ai_images_reserved, 0, "capacity fully returned");
    assertEq(row.ai_images_used, 0, "nothing billed");
  });

  // ── Cleanup, asserted ─────────────────────────────────────────────────────────
  const removed = await cleanup();
  await test("cleanup: every row this run created has been removed", async () => {
    const { data, error } = await service
      .from("usage_accounts").select("id").like("plan_key", `${KEY_PREFIX}:%`);
    assert(!error, `post-cleanup verification failed: ${error?.message ?? ""}`);
    assertEq((data ?? []).length, 0, `accounts left behind by run ${RUN_ID}`);
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
