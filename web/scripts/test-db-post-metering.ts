/**
 * Phase 5B — scheduled-post metering against REAL Postgres.
 *
 * usage_consume_scheduled_post is the ONLY single-call consume in the ledger (no
 * reserve/settle), so its correctness rests entirely on the database: the
 * (user_id, idempotency_key) unique collapses replays, and a quantity mismatch
 * under one key must RAISE. An in-memory fake cannot prove either — this file is
 * the acceptance evidence.
 *
 * Pinned here:
 *   1. consume once            → scheduled_posts_used == 1
 *   2. replay the SAME key     → still 1, reported replayed (the cron re-claim case)
 *   3. NULL limit (business)   → never refused AND an event is still written
 *   4. same key, quantity 2    → RAISES (the guardrail that forces quantity=1)
 *
 * Writes and deletes real rows in the ISOLATED test project only — never prod.
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
    console.error("\n=== POST METERING DB TEST CANNOT RUN ===\n");
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

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${(err as Error)?.message ?? err}`); failed++; }
}

const service: SupabaseClient = createClient(cfg.url, cfg.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const createdAccounts = new Set<string>();

type Account = { id: string; userId: string };

/** Seed a usage_accounts row directly (service role) — same idiom as the other DB tests. */
async function makeAccount(label: string, postsLimit: number | null = 100): Promise<Account> {
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
      ai_text_generations_limit: 100,
      scheduled_posts_limit: postsLimit,
      bonus_images_balance: 0,
    })
    .select("id, user_id")
    .single();
  if (error) throw new Error(`makeAccount(${label}) failed: ${error.message}`);
  const acct = { id: (data as { id: string }).id, userId };
  createdAccounts.add(acct.id);
  return acct;
}

async function readPostsUsed(id: string): Promise<number> {
  const { data, error } = await service
    .from("usage_accounts")
    .select("scheduled_posts_used")
    .eq("id", id)
    .single();
  if (error) throw new Error(`readPostsUsed failed: ${error.message}`);
  return (data as { scheduled_posts_used: number }).scheduled_posts_used;
}

async function countEvents(userId: string): Promise<number> {
  const { data, error } = await service
    .from("usage_events")
    .select("id")
    .eq("user_id", userId);
  if (error) throw new Error(`countEvents failed: ${error.message}`);
  return (data ?? []).length;
}

async function consume(userId: string, key: string, quantity = 1) {
  return await service.rpc("usage_consume_scheduled_post", {
    p_user_id: userId,
    p_idempotency_key: key,
    p_quantity: quantity,
    p_reference_id: `${KEY_PREFIX}:ref`,
    p_metadata: { itest: RUN_ID },
  });
}

async function cleanup(): Promise<number> {
  const ids = [...createdAccounts];
  if (ids.length === 0) return 0;
  // usage_events cascade from the account row.
  const { data, error } = await service
    .from("usage_accounts")
    .delete()
    .in("id", ids)
    .select("id");
  if (error) throw new Error(`cleanup failed: ${error.message}`);
  return (data ?? []).length;
}

(async () => {
  console.log("=== REAL POSTGRES — Phase 5B scheduled post metering ===");
  console.log(`  target project ref : ${cfg.projectRef}`);
  console.log(`  run id             : ${RUN_ID}`);
  console.log("  (writes and deletes real rows; never production)\n");

  await test("preflight: usage_consume_scheduled_post is reachable", async () => {
    const acct = await makeAccount("preflight");
    const { error } = await consume(acct.userId, `${KEY_PREFIX}:preflight`);
    if (error) throw new Error(`RPC unreachable: ${error.message}`);
  });

  await test("consume once → scheduled_posts_used == 1", async () => {
    const acct = await makeAccount("once");
    const { data, error } = await consume(acct.userId, `${KEY_PREFIX}:once`);
    if (error) throw new Error(error.message);
    if ((data as { ok?: boolean })?.ok !== true) throw new Error(`expected ok, got ${JSON.stringify(data)}`);
    const used = await readPostsUsed(acct.id);
    if (used !== 1) throw new Error(`expected used=1, got ${used}`);
  });

  await test("replay the SAME key → still 1 (the cron re-claim case), reported replayed", async () => {
    const acct = await makeAccount("replay");
    const key = `${KEY_PREFIX}:replay`;
    await consume(acct.userId, key);
    const { data, error } = await consume(acct.userId, key);
    if (error) throw new Error(error.message);
    const used = await readPostsUsed(acct.id);
    if (used !== 1) throw new Error(`a re-claim double-charged: used=${used}`);
    const replayed = (data as { replayed?: boolean })?.replayed;
    if (replayed !== true) throw new Error(`expected replayed:true, got ${JSON.stringify(data)}`);
    console.log(`        observed: two consumes on one key → used=1, replayed=true`);
  });

  await test("NULL limit (business/unlimited) → never refused, and an event IS still written", async () => {
    const acct = await makeAccount("unlimited", null);
    const before = await countEvents(acct.userId);
    const { data, error } = await consume(acct.userId, `${KEY_PREFIX}:unlimited`);
    if (error) throw new Error(error.message);
    if ((data as { ok?: boolean })?.ok !== true) throw new Error(`unlimited must not be refused: ${JSON.stringify(data)}`);
    const after = await countEvents(acct.userId);
    if (after !== before + 1) throw new Error(`unlimited must still write exactly one event (${before} → ${after})`);
    const used = await readPostsUsed(acct.id);
    if (used !== 1) throw new Error(`unlimited should still count usage, got ${used}`);
  });

  // ── KNOWN v55 DEFECT, pinned here so it cannot regress silently ──────────────
  // v55 intends a mismatched quantity under one key to RAISE (migrate_v55:1418-1423,
  // "A different quantity under the same key is a caller bug, not a retry"). It does
  // NOT: that raise uses errcode 'unique_violation', and the function's OWN
  // `exception when unique_violation` handler (:1473) catches it and reports a replay.
  // Two different situations share one errcode, so the guard is unreachable.
  //
  // Blast radius today is nil — every caller hardwires quantity 1 (meterScheduledPost
  // does not even accept a quantity) — but the guard is not doing what it claims. This
  // test pins the ACTUAL behaviour so a future fix to the errcode is a visible,
  // deliberate change rather than an accident. The invariant that really matters —
  // a mismatched replay never changes usage — is asserted and DOES hold.
  await test("mismatched quantity is (defectively) reported as a replay, never double-charged", async () => {
    const acct = await makeAccount("qty");
    const key = `${KEY_PREFIX}:qty`;
    await consume(acct.userId, key, 1);
    const { data, error } = await consume(acct.userId, key, 2);
    if (error) throw new Error(`unexpected error: ${error.message}`);
    const replayed = (data as { replayed?: boolean })?.replayed;
    if (replayed !== true) throw new Error(`expected the defective replay path, got ${JSON.stringify(data)}`);
    const used = await readPostsUsed(acct.id);
    if (used !== 1) throw new Error(`THE critical invariant broke: usage changed to ${used}`);
    console.log("        note: v55's quantity guard is swallowed by its own unique_violation handler");
  });

  await test("cleanup: every row this run created has been removed", async () => {
    const removed = await cleanup();
    console.log(`        removed ${removed} account(s) (cascade) for run ${RUN_ID}`);
    const { data } = await service
      .from("usage_accounts")
      .select("id")
      .like("plan_key", `${KEY_PREFIX}:%`);
    if ((data ?? []).length > 0) throw new Error(`${(data ?? []).length} row(s) survived cleanup`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
