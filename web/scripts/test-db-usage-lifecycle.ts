/**
 * test-db-usage-lifecycle.ts — real-Postgres proof for the v56 usage-account
 * lifecycle RPC (usage_ensure_account). Run: npm run test:db (NOT part of `npm test`).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS THE POINT OF PHASE 3
 * ═══════════════════════════════════════════════════════════════════════════════
 * v55 shipped the SPEND primitives but nothing that CREATES or RESETS an account.
 * usage_ensure_account is that missing lifecycle: seed → roll → plan-change, all
 * idempotent, all under a FOR UPDATE row lock, all made exactly-once by a
 * period-scoped idempotency key on usage_events. Every one of those claims is a claim
 * about CONCURRENCY and UNIQUE-CONSTRAINT idempotency that an in-memory fake cannot
 * testify to — so this suite exercises the real function against real Postgres, with
 * real parallel in-flight calls.
 *
 * THE CENTRAL TESTS:
 *   - concurrent double-ensure yields EXACTLY ONE account and ONE init event (the
 *     user_id UNIQUE + the period-scoped event key collapse a first-action race);
 *   - a replayed rollover does NOT double-reset (the new period's event key 23505s the
 *     second attempt, rolling back its counter reset with it).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SAFETY — READ scripts/lib/test-db-config.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 * This test WRITES AND DELETES REAL ROWS. Target resolves exclusively from
 * TEST_SUPABASE_*; no fallback to the production variables; refuses the prod ref;
 * fails loudly when credentials are absent rather than skipping.
 *
 * Row isolation: every account uses a per-run UUID and its plan_key carries
 * `itest:<runId>`, so parallel/repeated runs cannot collide. usage_accounts is the
 * cleanup root — ON DELETE CASCADE removes its events with it.
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
    console.error("\n=== USAGE LIFECYCLE DB TEST CANNOT RUN ===\n");
    console.error(err.message);
    console.error("\nExiting NON-ZERO. This is deliberate: a silent skip would report");
    console.error("green for a channel that verified nothing.\n");
    process.exit(1);
  }
  throw err;
}
assertNotProduction(cfg);

// Bind the app's Supabase client to the TEST project before anything imports it.
process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;

export {};

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { PLAN_ENTITLEMENTS, type PlanKey } from "../src/lib/server/planEntitlements";

const RUN_ID = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const KEY_PREFIX = `itest:${RUN_ID}`;

/** Every account id this run created — cleanup root (cascades to events). */
const createdAccounts = new Set<string>();
/** Every user id this run used — for the belt-and-braces sweep. */
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

// ── Period-scoped idempotency key (must MATCH the SQL exactly) ───────────────────
// SQL: 'alloc:' || user_id || ':' || to_char(period_start at time zone 'UTC',
//      'YYYY-MM-DD"T"HH24:MI:SS"Z"'). So we format period_start as UTC, second
// precision, with a literal T and Z — NOT the JS millisecond ISO string.
function allocKey(userId: string, periodStartIso: string): string {
  const d = new Date(periodStartIso);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
  return `alloc:${userId}:${stamp}`;
}

type RpcResult = { data: Record<string, unknown> | null; error: { message: string; code?: string } | null };

async function ensure(args: {
  userId: string;
  plan: string;
  imagesLimit: number | null;
  textLimit: number | null;
  scheduledLimit: number | null;
  periodStart: string;
  periodEnd: string;
  periodAnchor: string;
  reviewRequired?: boolean;
}): Promise<RpcResult> {
  createdUsers.add(args.userId);
  const { data, error } = await service.rpc("usage_ensure_account", {
    p_user_id: args.userId,
    p_plan_key: args.plan,
    p_ai_images_limit: args.imagesLimit,
    p_ai_text_limit: args.textLimit,
    p_scheduled_posts_limit: args.scheduledLimit,
    p_period_start: args.periodStart,
    p_period_end: args.periodEnd,
    p_period_anchor: args.periodAnchor,
    p_review_required: args.reviewRequired ?? false,
  });
  const d = data as Record<string, unknown> | null;
  if (d?.account_id) createdAccounts.add(String(d.account_id));
  return { data: d, error: error ? { message: error.message, code: error.code } : null };
}

async function ensureOk(args: Parameters<typeof ensure>[0]): Promise<Record<string, unknown>> {
  const { data, error } = await ensure(args);
  if (error) throw new Error(`usage_ensure_account errored: ${error.message}`);
  assert(data?.ok === true, `ensure not ok: ${JSON.stringify(data)}`);
  return data as Record<string, unknown>;
}

type AccountRow = {
  id: string;
  plan_key: string;
  period_start: string;
  period_end: string;
  period_anchor: string;
  ai_images_limit: number | null;
  ai_text_generations_limit: number | null;
  scheduled_posts_limit: number | null;
  ai_images_used: number;
  ai_images_reserved: number;
  ai_text_generations_used: number;
  ai_text_generations_reserved: number;
  scheduled_posts_used: number;
  scheduled_posts_reserved: number;
  bonus_images_balance: number;
  bonus_images_reserved: number;
  bonus_images_used: number;
  version: number;
};

async function readAccountByUser(userId: string): Promise<AccountRow | null> {
  const { data, error } = await service
    .from("usage_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`readAccountByUser failed: ${error.message}`);
  return (data as unknown as AccountRow) ?? null;
}

async function countAccounts(userId: string): Promise<number> {
  const { count, error } = await service
    .from("usage_accounts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`countAccounts failed: ${error.message}`);
  return count ?? 0;
}

async function countEvents(userId: string, operation: string): Promise<number> {
  const { count, error } = await service
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("operation", operation);
  if (error) throw new Error(`countEvents failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Seed a usage_accounts row DIRECTLY (service role) with an arbitrary period — used
 * to construct a "past period_end" or "mid-period" starting state the RPC then acts
 * on. Also writes the matching account_init event so the account looks exactly as
 * usage_ensure_account would have left it (its period-scoped key present), which is
 * what makes a subsequent rollover's replay guard meaningful.
 */
async function seedAccount(args: {
  userId: string;
  plan: string;
  imagesLimit: number | null;
  textLimit: number | null;
  scheduledLimit: number | null;
  periodStart: string;
  periodEnd: string;
  periodAnchor: string;
  imagesUsed?: number;
  textUsed?: number;
  scheduledUsed?: number;
  bonusBalance?: number;
  bonusUsed?: number;
}): Promise<AccountRow> {
  createdUsers.add(args.userId);
  const { data, error } = await service
    .from("usage_accounts")
    .insert({
      user_id: args.userId,
      plan_key: args.plan,
      period_start: args.periodStart,
      period_end: args.periodEnd,
      period_anchor: args.periodAnchor,
      ai_images_limit: args.imagesLimit,
      ai_text_generations_limit: args.textLimit,
      scheduled_posts_limit: args.scheduledLimit,
      ai_images_used: args.imagesUsed ?? 0,
      ai_text_generations_used: args.textUsed ?? 0,
      scheduled_posts_used: args.scheduledUsed ?? 0,
      bonus_images_balance: args.bonusBalance ?? 0,
      bonus_images_used: args.bonusUsed ?? 0,
    })
    .select("*")
    .single();
  if (error) throw new Error(`seedAccount failed: ${error.message}`);
  const row = data as unknown as AccountRow;
  createdAccounts.add(row.id);
  // Matching init event so the seeded account is indistinguishable from an RPC-created one.
  const { error: evErr } = await service.from("usage_events").insert({
    account_id: row.id,
    user_id: args.userId,
    usage_type: "account",
    operation: "account_init",
    quantity: 0,
    source: "system",
    idempotency_key: allocKey(args.userId, args.periodStart),
    metadata: {},
  });
  if (evErr) throw new Error(`seedAccount init event failed: ${evErr.message}`);
  return row;
}

const DAY = 24 * 3600 * 1000;

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
  // Belt-and-braces: any account whose plan_key carries this run's prefix.
  const { error: sweepErr, count: sweepCount } = await service
    .from("usage_accounts")
    .delete({ count: "exact" })
    .like("plan_key", `${KEY_PREFIX}:%`);
  if (sweepErr) throw new Error(`cleanup sweep failed: ${sweepErr.message}`);
  return removed + (sweepCount ?? 0);
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== REAL POSTGRES INTEGRATION — usage_ensure_account (v56) ===");
  console.log(`  target project ref : ${cfg.projectRef}`);
  console.log(`  run id             : ${RUN_ID}`);
  console.log("  (writes and deletes real rows; never production — see lib/test-db-config.ts)\n");

  // ── 0. Preflight ──────────────────────────────────────────────────────────────
  await test("preflight: usage_accounts reachable + usage_ensure_account exists", async () => {
    const { error: tblErr } = await service.from("usage_accounts").select("id").limit(1);
    assert(
      !tblErr,
      `cannot reach usage_accounts on ${cfg.projectRef}: ${tblErr?.message ?? ""}. ` +
        `Apply v55 THEN v56 to the test project:\n` +
        `  py backend/scripts/run_migration.py --apply --sql db/migrate_v56_usage_account_lifecycle.sql ` +
        `--project-ref ${cfg.projectRef}`,
    );
    const uid = randomUUID();
    const now = new Date();
    const { data, error } = await ensure({
      userId: uid,
      plan: `${KEY_PREFIX}:preflight`,
      imagesLimit: 1,
      textLimit: 1,
      scheduledLimit: 1,
      periodStart: now.toISOString(),
      periodEnd: new Date(now.getTime() + 30 * DAY).toISOString(),
      periodAnchor: now.toISOString(),
    });
    assert(!error, `usage_ensure_account not callable: ${error?.message ?? ""}`);
    assertEq(data?.action, "created", "preflight ensure should create");
  });

  // ── 1. Init with the right limits for each of the 4 plans ─────────────────────
  await test("ensure creates an account with config limits for each of the 4 plans", async () => {
    for (const plan of ["free", "starter", "pro", "business"] as PlanKey[]) {
      const uid = randomUUID();
      const now = new Date();
      const e = PLAN_ENTITLEMENTS[plan];
      const res = await ensureOk({
        userId: uid,
        plan: `${KEY_PREFIX}:${plan}`,
        imagesLimit: e.monthlyAiImages,
        textLimit: e.monthlyAiTextGenerations,
        scheduledLimit: e.monthlyScheduledPosts,
        periodStart: now.toISOString(),
        periodEnd: new Date(now.getTime() + 30 * DAY).toISOString(),
        periodAnchor: now.toISOString(),
      });
      assertEq(res.action, "created", `${plan} action`);
      const row = await readAccountByUser(uid);
      assert(row !== null, `${plan} row must exist`);
      assertEq(row!.ai_images_limit, e.monthlyAiImages, `${plan} images limit`);
      assertEq(row!.ai_text_generations_limit, e.monthlyAiTextGenerations, `${plan} text limit`);
      assertEq(row!.scheduled_posts_limit, e.monthlyScheduledPosts, `${plan} scheduled limit`);
      assertEq(row!.version, 0, `${plan} fresh version`);
      // Exactly one init event.
      assertEq(await countEvents(uid, "account_init"), 1, `${plan} one init event`);
    }
  });

  // ── 1b. Unlimited plan (business scheduled_posts null) represented as NULL ─────
  await test("unlimited scheduled_posts (business) is stored as NULL, not 0", async () => {
    const uid = randomUUID();
    const now = new Date();
    await ensureOk({
      userId: uid,
      plan: `${KEY_PREFIX}:unlimited`,
      imagesLimit: 3000,
      textLimit: 10000,
      scheduledLimit: null, // business unlimited
      periodStart: now.toISOString(),
      periodEnd: new Date(now.getTime() + 30 * DAY).toISOString(),
      periodAnchor: now.toISOString(),
    });
    const row = await readAccountByUser(uid);
    assertEq(row!.scheduled_posts_limit, null, "null limit persisted as NULL");
    assertEq(row!.ai_images_limit, 3000, "finite images limit alongside null");
  });

  // ── 2. Concurrent double-ensure → ONE account, ONE init event ─────────────────
  const N_CONCURRENT = 12;
  await test(`concurrency: ${N_CONCURRENT} simultaneous first-ensures → exactly 1 account + 1 init event`, async () => {
    const uid = randomUUID();
    const now = new Date();
    const args = {
      userId: uid,
      plan: `${KEY_PREFIX}:race`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: now.toISOString(),
      periodEnd: new Date(now.getTime() + 30 * DAY).toISOString(),
      periodAnchor: now.toISOString(),
    };
    // Fire N at once — real parallel in-flight RPCs contending on the user_id UNIQUE
    // and the period-scoped event key.
    const results = await Promise.all(Array.from({ length: N_CONCURRENT }, () => ensure(args)));

    // Every call must succeed (a loser is a converged no-op, never an error).
    const errored = results.filter((r) => r.error);
    assertEq(errored.length, 0, `no ensure may error (got: ${errored.map((e) => e.error?.message).join("; ")})`);

    const created = results.filter((r) => r.data?.action === "created").length;
    const accounts = await countAccounts(uid);
    const initEvents = await countEvents(uid, "account_init");

    assertEq(accounts, 1, "exactly ONE account row after the race");
    assertEq(initEvents, 1, "exactly ONE account_init event after the race");
    // At most one caller may report 'created'; the rest converge to noop.
    assert(created <= 1, `at most one 'created' (got ${created})`);
    console.log(
      `        observed: N=${N_CONCURRENT} fired → accounts=${accounts}, init_events=${initEvents}, created_reports=${created}`,
    );
  });

  // ── 3. Rollover past period_end ────────────────────────────────────────────────
  await test("rollover: past period_end advances period, resets *_used to 0, bumps version, one rollover event", async () => {
    const uid = randomUUID();
    // Anchor 3 months ago; the seeded period is the FIRST month and is long expired.
    const anchor = new Date(Date.now() - 90 * DAY);
    const seedStart = anchor.toISOString();
    const seedEnd = new Date(anchor.getTime() + 30 * DAY).toISOString();
    const seeded = await seedAccount({
      userId: uid,
      plan: `${KEY_PREFIX}:roll`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: seedStart,
      periodEnd: seedEnd,
      periodAnchor: seedStart,
      imagesUsed: 42,
      textUsed: 100,
      scheduledUsed: 7,
    });

    const res = await ensureOk({
      userId: uid,
      plan: `${KEY_PREFIX}:roll`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: new Date().toISOString(), // caller period ignored for existing account
      periodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
      periodAnchor: seedStart,
    });
    assertEq(res.action, "rolled", "action must be rolled");

    const row = await readAccountByUser(uid);
    assertEq(row!.ai_images_used, 0, "images_used reset");
    assertEq(row!.ai_text_generations_used, 0, "text_used reset");
    assertEq(row!.scheduled_posts_used, 0, "scheduled_used reset");
    assertEq(row!.ai_images_reserved, 0, "images_reserved reset");
    assert(row!.version > seeded.version, `version bumped (${seeded.version} → ${row!.version})`);
    // New period must contain now and be anchor-aligned.
    assert(new Date(row!.period_end).getTime() > Date.now(), "new period_end is in the future");
    assert(new Date(row!.period_start).getTime() <= Date.now(), "new period_start is not in the future");
    assertEq(await countEvents(uid, "period_rollover"), 1, "exactly one rollover event");

    // Second ensure in the SAME new period = no-op (no second reset).
    const res2 = await ensureOk({
      userId: uid,
      plan: `${KEY_PREFIX}:roll`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
      periodAnchor: seedStart,
    });
    assertEq(res2.action, "noop", "second ensure in the new period is a no-op");
    assertEq(await countEvents(uid, "period_rollover"), 1, "still exactly one rollover event");
  });

  // ── 4. Bonus survives rollover ─────────────────────────────────────────────────
  await test("bonus pool is UNTOUCHED by rollover (bonus survives period resets)", async () => {
    const uid = randomUUID();
    const anchor = new Date(Date.now() - 60 * DAY);
    const seedStart = anchor.toISOString();
    const seedEnd = new Date(anchor.getTime() + 30 * DAY).toISOString();
    await seedAccount({
      userId: uid,
      plan: `${KEY_PREFIX}:bonus`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: seedStart,
      periodEnd: seedEnd,
      periodAnchor: seedStart,
      imagesUsed: 30,
      bonusBalance: 25,
      bonusUsed: 10,
    });

    await ensureOk({
      userId: uid,
      plan: `${KEY_PREFIX}:bonus`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
      periodAnchor: seedStart,
    });

    const row = await readAccountByUser(uid);
    assertEq(row!.ai_images_used, 0, "recurring images_used reset");
    assertEq(row!.bonus_images_balance, 25, "bonus balance untouched");
    assertEq(row!.bonus_images_used, 10, "bonus used untouched");
  });

  // ── 5. Mid-cycle plan upgrade preserves *_used, raises *_limit ─────────────────
  await test("mid-cycle upgrade preserves *_used, raises *_limit, does NOT reset", async () => {
    const uid = randomUUID();
    const now = new Date();
    const start = now.toISOString();
    const end = new Date(now.getTime() + 30 * DAY).toISOString(); // well in the future
    // Start on starter with usage already consumed.
    await seedAccount({
      userId: uid,
      plan: `${KEY_PREFIX}:up`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: start,
      periodEnd: end,
      periodAnchor: start,
      imagesUsed: 120,
      textUsed: 300,
      scheduledUsed: 40,
    });

    // Upgrade to pro-sized limits mid-period.
    const res = await ensureOk({
      userId: uid,
      plan: `${KEY_PREFIX}:up-pro`,
      imagesLimit: 800,
      textLimit: 2000,
      scheduledLimit: 300,
      periodStart: start,
      periodEnd: end,
      periodAnchor: start,
    });
    assertEq(res.action, "plan_changed", "action must be plan_changed");

    const row = await readAccountByUser(uid);
    assertEq(row!.ai_images_limit, 800, "images limit raised");
    assertEq(row!.ai_text_generations_limit, 2000, "text limit raised");
    assertEq(row!.scheduled_posts_limit, 300, "scheduled limit raised");
    assertEq(row!.plan_key, `${KEY_PREFIX}:up-pro`, "plan_key updated");
    // *_used PRESERVED — the frozen contract: an upgrade keeps consumed usage.
    assertEq(row!.ai_images_used, 120, "images_used PRESERVED across upgrade");
    assertEq(row!.ai_text_generations_used, 300, "text_used PRESERVED");
    assertEq(row!.scheduled_posts_used, 40, "scheduled_used PRESERVED");
    assertEq(await countEvents(uid, "plan_change"), 1, "one plan_change event");
    assertEq(await countEvents(uid, "period_rollover"), 0, "no rollover on a plan change");

    // Re-applying the SAME upgrade is a no-op (idempotent plan-change key).
    const res2 = await ensureOk({
      userId: uid,
      plan: `${KEY_PREFIX}:up-pro`,
      imagesLimit: 800,
      textLimit: 2000,
      scheduledLimit: 300,
      periodStart: start,
      periodEnd: end,
      periodAnchor: start,
    });
    assertEq(res2.action, "noop", "re-applying the same change is a no-op");
    assertEq(await countEvents(uid, "plan_change"), 1, "still exactly one plan_change event");
  });

  // ── 6. Exactly-once: a replayed rollover key does NOT double-reset ─────────────
  // Fire the rollover-triggering ensure CONCURRENTLY N times against a past-period
  // account. Exactly one must roll (write the new-period key + reset); the rest must
  // converge (their event insert 23505s → their reset rolls back → noop).
  await test("exactly-once: concurrent rollover replays → ONE reset, ONE rollover event", async () => {
    const uid = randomUUID();
    const anchor = new Date(Date.now() - 75 * DAY);
    const seedStart = anchor.toISOString();
    const seedEnd = new Date(anchor.getTime() + 30 * DAY).toISOString();
    await seedAccount({
      userId: uid,
      plan: `${KEY_PREFIX}:x1`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: seedStart,
      periodEnd: seedEnd,
      periodAnchor: seedStart,
      imagesUsed: 90,
    });

    const args = {
      userId: uid,
      plan: `${KEY_PREFIX}:x1`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
      periodAnchor: seedStart,
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => ensure(args)));
    const errored = results.filter((r) => r.error);
    assertEq(errored.length, 0, `no ensure may error under replay (got: ${errored.map((e) => e.error?.message).join("; ")})`);
    const rolled = results.filter((r) => r.data?.action === "rolled").length;
    assert(rolled <= 1, `at most one caller may roll (got ${rolled})`);
    assertEq(await countEvents(uid, "period_rollover"), 1, "exactly ONE rollover event despite the replay burst");

    const row = await readAccountByUser(uid);
    assertEq(row!.ai_images_used, 0, "reset happened exactly once (used=0)");
    // version bumped exactly once by the single roll (seed started at 0).
    assertEq(row!.version, 1, "version bumped exactly once (single reset)");
  });

  // ── 7. Drift-free rollover across several cycles ──────────────────────────────
  // Anchor on the 15th, 5 whole months stale. One ensure must land the CURRENT
  // period, whose start = anchor + k months for the correct k (day-of-month 15
  // preserved, no creep), and end = start + 1 month.
  await test("rollover is drift-free across several cycles (anchor day preserved)", async () => {
    const uid = randomUUID();
    // Build an anchor exactly 5 months before "now" on a stable day (the 15th).
    const now = new Date();
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 15, 12, 0, 0));
    const seedStart = anchor.toISOString();
    const seedEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 15, 12, 0, 0)).toISOString();
    await seedAccount({
      userId: uid,
      plan: `${KEY_PREFIX}:drift`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: seedStart,
      periodEnd: seedEnd,
      periodAnchor: seedStart,
      imagesUsed: 5,
    });

    const res = await ensureOk({
      userId: uid,
      plan: `${KEY_PREFIX}:drift`,
      imagesLimit: 150,
      textLimit: 500,
      scheduledLimit: 150,
      periodStart: now.toISOString(),
      periodEnd: new Date(now.getTime() + 30 * DAY).toISOString(),
      periodAnchor: seedStart,
    });
    assertEq(res.action, "rolled", "must roll");

    const row = await readAccountByUser(uid);
    const ps = new Date(row!.period_start);
    const pe = new Date(row!.period_end);
    // The anchor's day-of-month (15) is preserved — no drift toward the 1st/end.
    assertEq(ps.getUTCDate(), 15, "period_start keeps anchor day-of-month 15");
    assert(ps.getTime() <= now.getTime() && pe.getTime() > now.getTime(), "current period contains now");
    // Exactly one month wide.
    const expectedEnd = new Date(Date.UTC(ps.getUTCFullYear(), ps.getUTCMonth() + 1, 15, 12, 0, 0));
    assertEq(pe.toISOString(), expectedEnd.toISOString(), "period is exactly one anchored month");
    // rolled_periods reflects the multi-cycle skip (>1 because 5 months stale).
    assert(Number(res.rolled_periods) >= 1, `rolled_periods reported (${res.rolled_periods})`);
  });

  // ── 8. RLS — anon cannot touch usage_accounts ─────────────────────────────────
  await test("RLS: anon key cannot read a usage_accounts row that exists", async () => {
    const uid = randomUUID();
    const now = new Date();
    await ensureOk({
      userId: uid,
      plan: `${KEY_PREFIX}:rls`,
      imagesLimit: 10,
      textLimit: 20,
      scheduledLimit: 5,
      periodStart: now.toISOString(),
      periodEnd: new Date(now.getTime() + 30 * DAY).toISOString(),
      periodAnchor: now.toISOString(),
    });
    // Exists for service role.
    assert((await readAccountByUser(uid)) !== null, "row must exist for service role");
    // Hidden from anon (200 + [] is not access — assert on rows).
    const { data, error } = await anon.from("usage_accounts").select("id").eq("user_id", uid);
    if (!error) assertEq(data?.length ?? 0, 0, "anon must see ZERO rows");
  });

  // ── 9. Cleanup, asserted ──────────────────────────────────────────────────────
  const removed = await cleanup();
  await test("cleanup: every row this run created has been removed", async () => {
    const { data, error } = await service
      .from("usage_accounts")
      .select("id")
      .like("plan_key", `${KEY_PREFIX}:%`);
    assert(!error, `post-cleanup verification failed: ${error?.message ?? ""}`);
    assertEq(data?.length ?? -1, 0, `accounts left behind by run ${RUN_ID}`);
    // Events cascade with their account; verify none linger for this run's users.
    for (const uid of createdUsers) {
      const { count } = await service
        .from("usage_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", uid);
      assertEq(count ?? 0, 0, `events left behind for user ${uid}`);
    }
    console.log(`        removed ${removed} account(s) for run ${RUN_ID}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("\nFATAL:", (err as Error).message);
  try {
    const removed = await cleanup();
    console.error(`(cleanup removed ${removed} account(s) for run ${RUN_ID})`);
  } catch (cleanupErr) {
    console.error(`(cleanup ALSO failed: ${(cleanupErr as Error).message} — run id ${RUN_ID})`);
  }
  process.exit(1);
});
