/**
 * test-db-text-metering.ts — real-Postgres proof for Phase 4T TEXT metering.
 * Run: npm run test:db      (NOT part of `npm test`)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 4T wires /api/ai-copy to usage_reserve (usage_type ai_text_generation, a SINGLE
 * slot ["s0"], operation text_generation) + usage_settle_reservation_item /
 * usage_release_reservation. The route unit tests mock the RPCs; THIS suite drives the
 * exact same RPC cycle against real Postgres, so the contract the app now depends on is
 * proven against the database, not a fake:
 *
 *   reserve (ai_text_generation, ["s0"])  → ai_text_generations_reserved == 1,
 *                                            _used == 0.
 *   settle s0 succeeded                    → _used == 1, _reserved == 0 (billed once).
 *   reserve then release                   → _used == 0, _reserved == 0 (nothing billed).
 *   settle replay                          → billed EXACTLY once.
 *
 * The slot key is the SAME "s0" the TS module (meterTextGeneration.TEXT_SLOT_KEYS)
 * produces — so settlement actually matches.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SAFETY — READ scripts/lib/test-db-config.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 * WRITES AND DELETES REAL ROWS. Target resolved exclusively from TEST_SUPABASE_*
 * (no production fallback; refuses the known production ref; fails loudly if creds
 * are absent). Per-run UUID namespace + `itest:<runId>` key prefix so parallel runs
 * cannot collide. usage_accounts is the cascade cleanup root.
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
    console.error("\n=== TEXT METERING DB TEST CANNOT RUN ===\n");
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
 *  test-db-usage-metering.ts. Phase 4T does not add an account-creation RPC. */
async function makeAccount(label: string, textLimit: number | null = 100): Promise<Account> {
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
      ai_images_limit: 100,
      ai_text_generations_limit: textLimit,
      scheduled_posts_limit: 100,
      bonus_images_balance: 0,
    })
    .select("id, user_id")
    .single();
  if (error) throw new Error(`makeAccount(${label}) failed: ${error.message}`);
  const acct = { id: (data as { id: string }).id, userId };
  createdAccounts.add(acct.id);
  return acct;
}

type AccountRow = {
  ai_text_generations_used: number;
  ai_text_generations_reserved: number;
};

async function readAccount(id: string): Promise<AccountRow> {
  const { data, error } = await service
    .from("usage_accounts")
    .select("ai_text_generations_used, ai_text_generations_reserved")
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

/** The SAME single-slot convention the TS module (TEXT_SLOT_KEYS) produces: ["s0"]. */
const TEXT_SLOTS = ["s0"];

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
  const { error: sweepErr, count: sweepCount } = await service
    .from("usage_accounts")
    .delete({ count: "exact" })
    .like("plan_key", `${KEY_PREFIX}:%`);
  if (sweepErr) throw new Error(`cleanup sweep failed: ${sweepErr.message}`);
  return removed + (sweepCount ?? 0);
}

async function main(): Promise<void> {
  console.log("\n=== REAL POSTGRES INTEGRATION — Phase 4T text metering ===");
  console.log(`  target project ref : ${cfg.projectRef}`);
  console.log(`  run id             : ${RUN_ID}`);
  console.log("  (writes and deletes real rows; never production — see lib/test-db-config.ts)\n");

  await test("preflight: usage_reserve admits an ai_text_generation single-slot reservation", async () => {
    const acct = await makeAccount("preflight");
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_text_generation",
      p_slot_keys: TEXT_SLOTS,
      p_request_key: `${KEY_PREFIX}:preflight`,
      p_operation: "text_generation",
    });
    assertEq(res.ok, true, "reserve succeeds on a fresh account");
    assert(!!String(res.reservation_id), "a reservation id came back");
    const after = await readAccount(acct.id);
    assertEq(after.ai_text_generations_reserved, 1, "one text unit reserved");
    assertEq(after.ai_text_generations_used, 0, "nothing used until settle");
  });

  // ── THE END-TO-END CYCLE the route now drives ─────────────────────────────────
  await test("reserve → settle s0 succeeded → used=1, reserved=0 (billed exactly once)", async () => {
    const acct = await makeAccount("cycle", 100);
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_text_generation",
      p_slot_keys: TEXT_SLOTS, // ["s0"] — the exact key TS produces
      p_request_key: `${KEY_PREFIX}:cycle`,
      p_operation: "text_generation",
    });
    assertEq(res.ok, true, "reserve admitted");
    const rid = String(res.reservation_id);
    assert(!!rid, "reservation id present");

    const afterReserve = await readAccount(acct.id);
    assertEq(afterReserve.ai_text_generations_reserved, 1, "1 slot reserved");
    assertEq(afterReserve.ai_text_generations_used, 0, "nothing used until settle");

    const s0 = await rpcOk("usage_settle_reservation_item", {
      p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded",
    });
    assertEq(s0.ok, true, "settle s0 succeeded");

    const final = await readAccount(acct.id);
    assertEq(final.ai_text_generations_used, 1, "exactly one text generation billed");
    assertEq(final.ai_text_generations_reserved, 0, "no capacity left in flight");

    // Reservation itself is now 'settled' (its single slot terminal).
    const { data: resRow } = await service
      .from("usage_reservations")
      .select("state, consumed_quantity, released_quantity")
      .eq("id", rid)
      .single();
    const r = resRow as { state: string; consumed_quantity: number; released_quantity: number };
    assertEq(r.state, "settled", "reservation is terminal once its only slot settled");
    assertEq(r.consumed_quantity, 1, "one slot consumed (s0)");
    assertEq(r.released_quantity, 0, "nothing released on success");

    console.log(
      `        reserved 1 (s0) → settle s0 success → used=${final.ai_text_generations_used}, ` +
        `reserved=${final.ai_text_generations_reserved}, state=${r.state}`,
    );
  });

  await test("reserve → release → used=0, reserved=0 (quality-gate failure path)", async () => {
    const acct = await makeAccount("release", 100);
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_text_generation",
      p_slot_keys: TEXT_SLOTS,
      p_request_key: `${KEY_PREFIX}:release`,
      p_operation: "text_generation",
    });
    const rid = String(res.reservation_id);

    const afterReserve = await readAccount(acct.id);
    assertEq(afterReserve.ai_text_generations_reserved, 1, "1 reserved before release");

    const rel = await rpcOk("usage_release_reservation", { p_reservation_id: rid, p_reason: "text_generation_failed" });
    assertEq(rel.released_quantity, 1, "the pending slot released");

    const row = await readAccount(acct.id);
    assertEq(row.ai_text_generations_reserved, 0, "capacity fully returned");
    assertEq(row.ai_text_generations_used, 0, "nothing billed on a released reservation");
  });

  await test("settle is idempotent: a replayed s0 success bills exactly once", async () => {
    const acct = await makeAccount("settle-idem", 100);
    const res = await rpcOk("usage_reserve", {
      p_user_id: acct.userId,
      p_usage_type: "ai_text_generation",
      p_slot_keys: TEXT_SLOTS,
      p_request_key: `${KEY_PREFIX}:settle-idem`,
      p_operation: "text_generation",
    });
    const rid = String(res.reservation_id);

    const first = await rpcOk("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded" });
    assertEq(first.ok, true, "first settle succeeds");
    assertEq(first.replayed, false, "first settle is not a replay");

    // A SINGLE-slot reservation becomes terminal ('settled') the moment its only slot
    // settles. So a duplicate settle no longer finds a PENDING reservation — the v55 RPC
    // returns the honest `reservation_not_pending` refusal (NOT a cheerful replayed:true,
    // which only fires when a DIFFERENT slot keeps the reservation open — see the image
    // meter's multi-slot case). The load-bearing invariant is the same either way:
    // nothing is double-billed. The guarded UPDATE cannot re-fire on a terminal slot.
    const { data: replay } = await rpc("usage_settle_reservation_item", { p_reservation_id: rid, p_slot_key: "s0", p_outcome: "succeeded" });
    const replayObj = replay as Record<string, unknown>;
    assertEq(replayObj.ok, false, "the second settle is refused (reservation already terminal)");
    assertEq(replayObj.reason, "reservation_not_pending", "honest refusal, not a silent double-bill");

    const row = await readAccount(acct.id);
    assertEq(row.ai_text_generations_used, 1, "billed exactly once despite the duplicate settle");
    assertEq(row.ai_text_generations_reserved, 0, "no capacity left reserved");
  });

  // ── Cleanup, asserted ─────────────────────────────────────────────────────────
  const removed = await cleanup();
  await test("cleanup: every row this run created has been removed", async () => {
    const { data, error } = await service
      .from("usage_accounts").select("id").like("plan_key", `${KEY_PREFIX}:%`);
    assert(!error, `post-cleanup verification failed: ${error?.message ?? ""}`);
    assertEq((data ?? []).length, 0, `accounts left behind by run ${RUN_ID}`);
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
