/**
 * test-db-integration-rate-limit.ts — the repository's FIRST real-Postgres test.
 * Run: npm run test:db      (NOT part of `npm test`)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════════
 * Every other test in this repo runs against an in-memory fake. test-ai-provider-
 * rate-limit.ts is honest about the consequence in its own header: its fake store
 * "models the two Postgres constraints the real limiter depends on" — PK uniqueness
 * and compare-and-swap — inside a single-threaded Map, in one already-resolved
 * microtask. That is a model of Postgres written by the same people who wrote the
 * code under test, so it can only ever confirm what they already believed.
 *
 * The properties a rate limiter (and, later, a credit ledger) lives or dies on are
 * exactly the ones a fake cannot testify to:
 *   - does a duplicate primary-key insert REALLY return SQLSTATE 23505?
 *   - does a guarded `.eq("hits", seen)` UPDATE REALLY lose against a concurrent
 *     writer, and does PostgREST REALLY report that as zero matched rows?
 *   - under genuine parallel HTTP requests with real network latency and real MVCC
 *     row locking, do exactly M of N racers get admitted — or does the count drift?
 * A Map answers all three by construction. Postgres answers them on the evidence.
 *
 * This file is the channel. `ai_rate_limit_windows` is its first subject because it
 * is the one shipped table with real concurrency semantics.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SAFETY — READ scripts/lib/test-db-config.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 * This test WRITES AND DELETES REAL ROWS. It resolves its target exclusively from
 * TEST_SUPABASE_* variables, has no fallback to the production Supabase variables,
 * refuses to start against the known production ref, and fails loudly when
 * credentials are absent rather than skipping.
 *
 * Row isolation: every row this test writes carries a per-run unique identity
 * (`itest:<runId>:…`), so repeated or parallel runs cannot collide, and cleanup can
 * delete precisely this run's rows without touching anything else.
 */

// ── Point the app's Supabase client at the TEST project BEFORE anything imports it ──
// `@/lib/supabase` reads these at MODULE LOAD time and caches them in module scope,
// so this assignment must happen before the first import of that module anywhere in
// the process. Everything below therefore uses dynamic import; there is a hard
// assertion further down that the client actually bound to the test URL, so if this
// ordering is ever broken the test fails loudly instead of quietly hitting prod.
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
    console.error("\n=== DB INTEGRATION TEST CANNOT RUN ===\n");
    console.error(err.message);
    console.error("\nExiting NON-ZERO. This is deliberate: a silent skip would report");
    console.error("green for a channel that verified nothing.\n");
    process.exit(1);
  }
  throw err;
}
assertNotProduction(cfg);

process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;

export {};

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const TABLE = "ai_rate_limit_windows";

/** Unique per run — isolates rows so parallel/repeated runs cannot collide. */
const RUN_ID = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const IDENTITY_PREFIX = `itest:${RUN_ID}`;

/** Every identity this run created, for guaranteed cleanup. */
const createdIdentities = new Set<string>();
function identity(label: string): string {
  const id = `${IDENTITY_PREFIX}:${label}`;
  createdIdentities.add(id);
  return id;
}

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

// ── Clients ─────────────────────────────────────────────────────────────────────

const service: SupabaseClient = createClient(cfg.url, cfg.serviceRoleKey, {
  auth: { persistSession: false },
});
const anon: SupabaseClient = createClient(cfg.url, cfg.anonKey, {
  auth: { persistSession: false },
});

/** Read the stored hits for a window, via service role (bypasses RLS). */
async function readHits(userId: string, route: string, windowStart: string): Promise<number | null> {
  const { data, error } = await service
    .from(TABLE)
    .select("hits")
    .eq("vibepin_user_id", userId)
    .eq("route", route)
    .eq("window_start", windowStart)
    .maybeSingle();
  if (error) throw new Error(`readHits failed: ${error.message}`);
  return (data as { hits: number } | null)?.hits ?? null;
}

async function cleanup(): Promise<number> {
  let removed = 0;
  for (const id of createdIdentities) {
    const { error, count } = await service
      .from(TABLE)
      .delete({ count: "exact" })
      .eq("vibepin_user_id", id);
    if (error) throw new Error(`cleanup failed for ${id}: ${error.message}`);
    removed += count ?? 0;
  }
  // Belt-and-braces: catch any row with this run's prefix that a failed test created
  // through a path that never registered its identity.
  const { error: sweepErr, count: sweepCount } = await service
    .from(TABLE)
    .delete({ count: "exact" })
    .like("vibepin_user_id", `${IDENTITY_PREFIX}:%`);
  if (sweepErr) throw new Error(`cleanup sweep failed: ${sweepErr.message}`);
  return removed + (sweepCount ?? 0);
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== REAL POSTGRES INTEGRATION — ai_rate_limit_windows ===");
  console.log(`  target project ref : ${cfg.projectRef}`);
  console.log(`  run id             : ${RUN_ID}`);
  console.log("  (writes and deletes real rows; never production — see lib/test-db-config.ts)\n");

  // ── 0. Preflight: the connection is REAL and the schema is present ────────────
  // Without this, every later assertion could pass vacuously against a table that
  // does not exist / a project that is not reachable.
  await test("preflight: table exists and is reachable with the service-role key", async () => {
    const { error } = await service.from(TABLE).select("hits").limit(1);
    assert(
      !error,
      `cannot reach ${TABLE} on project ${cfg.projectRef}: ${error?.message ?? ""}. ` +
        `Apply v53+v54 to the test project first:\n` +
        `  py backend/scripts/run_migration.py --apply ` +
        `--sql db/migrate_v53_ai_rate_limit_windows.sql --project-ref ${cfg.projectRef}`,
    );
  });

  await test("preflight: the app's Supabase client bound to the TEST project, not prod", async () => {
    // Guards the module-load ordering the header describes. If some earlier import
    // had already frozen `@/lib/supabase` against production env, this catches it
    // before any test writes a row.
    const mod = await import("../src/lib/supabase");
    const client = mod.createServerClient() as unknown as { supabaseUrl: string };
    assertEq(client.supabaseUrl, cfg.url, "createServerClient() is bound to the wrong URL");
    assert(
      client.supabaseUrl.includes(cfg.projectRef),
      `createServerClient() URL ${client.supabaseUrl} does not name the test project`,
    );
  });

  // ── 1. Unique-constraint behaviour — the admission primitive ──────────────────
  // rateLimit.ts's `create` treats error.code === "23505" as "another request won
  // the creation race" and falls through to CAS. Anything else is an infra failure
  // that fails open. If Postgres/PostgREST reported a different code, the limiter
  // would misclassify a lost race as an outage and admit unlimited requests.
  await test("duplicate primary-key insert really returns SQLSTATE 23505", async () => {
    const userId = identity("pk");
    const windowStart = new Date(0).toISOString();

    const first = await service
      .from(TABLE)
      .insert({ vibepin_user_id: userId, route: "ai_copy", window_start: windowStart, hits: 1 });
    assert(!first.error, `first insert should succeed: ${first.error?.message ?? ""}`);

    const second = await service
      .from(TABLE)
      .insert({ vibepin_user_id: userId, route: "ai_copy", window_start: windowStart, hits: 1 });
    assert(second.error !== null, "duplicate insert must fail, but it succeeded");
    assertEq(second.error!.code, "23505", "duplicate insert SQLSTATE");

    // And it must not have overwritten the existing row.
    assertEq(await readHits(userId, "ai_copy", windowStart), 1, "hits after rejected duplicate");
  });

  // ── 2. CAS behaviour — the increment primitive ─────────────────────────────────
  // `bump` decides win/lose purely from the number of rows PostgREST returns for a
  // `.eq("hits", seen)` UPDATE. If a stale-guard update silently matched anyway,
  // two racers could both take the last slot.
  await test("guarded update loses when another writer already moved the value", async () => {
    const userId = identity("cas");
    const windowStart = new Date(0).toISOString();
    await service
      .from(TABLE)
      .insert({ vibepin_user_id: userId, route: "ai_copy", window_start: windowStart, hits: 5 });

    // Winner: guard matches the current value.
    const win = await service
      .from(TABLE)
      .update({ hits: 6 })
      .eq("vibepin_user_id", userId)
      .eq("route", "ai_copy")
      .eq("window_start", windowStart)
      .eq("hits", 5)
      .select("hits");
    assert(!win.error, `winning CAS errored: ${win.error?.message ?? ""}`);
    assertEq(win.data?.length ?? 0, 1, "winning CAS matched-row count");

    // Loser: guard still holds the now-stale value 5.
    const lose = await service
      .from(TABLE)
      .update({ hits: 6 })
      .eq("vibepin_user_id", userId)
      .eq("route", "ai_copy")
      .eq("window_start", windowStart)
      .eq("hits", 5)
      .select("hits");
    assert(!lose.error, `losing CAS errored: ${lose.error?.message ?? ""}`);
    assertEq(lose.data?.length ?? 0, 0, "stale-guard CAS matched-row count must be 0");

    // The loser must not have written. Re-read rather than trusting the response.
    assertEq(await readHits(userId, "ai_copy", windowStart), 6, "hits after lost CAS");
  });

  // ── 3. THE CONCURRENCY ASSERTION ──────────────────────────────────────────────
  // The one an in-memory fake cannot honestly make. N genuinely parallel
  // consumeRateLimit calls — separate HTTPS requests, real latency, real MVCC row
  // locking — against a window whose remaining capacity is M < N. Exactly M may be
  // admitted. Not M+1 (double-spend: two racers took the same slot). Not M-1
  // (over-throttling a paying user).
  const N = 24;
  const M = 10;

  await test(`concurrency: ${N} simultaneous consumeRateLimit calls, only ${M} slots free → exactly ${M} admitted`, async () => {
    // tsx resolves dynamic imports through the CJS require cache keyed on resolved
    // path; `?query=` cache-busters do NOT work here. Import once and reuse.
    const rl = await import("../src/lib/server/rateLimit");
    const route = "ai_copy" as const;
    const rule = rl.RATE_LIMITS[route];
    const userId = identity("concurrency");

    // Seed the window so that exactly M slots remain, using the SAME window maths
    // the limiter uses, so the row we prime is the row it will contend on.
    const nowMs = Date.now();
    const windowStart = new Date(rl.windowStartMs(nowMs, rule.windowSeconds)).toISOString();
    const seededHits = rule.limit - M;
    const seed = await service
      .from(TABLE)
      .insert({ vibepin_user_id: userId, route, window_start: windowStart, hits: seededHits });
    assert(!seed.error, `seeding failed: ${seed.error?.message ?? ""}`);

    // Fire all N at once. No awaits in between — these are concurrent in-flight
    // HTTP requests to Postgres, which is the entire point.
    const decisions = await Promise.all(
      Array.from({ length: N }, () => rl.consumeRateLimit(userId, route, nowMs)),
    );

    const admitted = decisions.filter(d => d.allowed).length;
    const denied = decisions.filter(d => !d.allowed).length;

    // A fail-open admission is NOT a real admission — it means the limiter could not
    // reach Postgres, which would make this whole test vacuous. Fail hard on it.
    const failOpen = decisions.filter(d => d.allowed && d.reason === "limiter_unavailable").length;
    assertEq(failOpen, 0, "limiter fell back to fail-open (infrastructure error) — result is not evidence");

    assertEq(admitted, M, `admitted count under real Postgres contention (denied=${denied})`);

    // The durable counter must agree with the decisions: exactly limit, never more.
    const finalHits = await readHits(userId, route, windowStart);
    assertEq(finalHits, rule.limit, "stored hits after the burst");
    assert(
      (finalHits ?? 0) <= rule.limit,
      `stored hits ${finalHits} exceeded the limit ${rule.limit} — double-spend`,
    );

    console.log(
      `        observed: N=${N} racers, ${M} slots → admitted=${admitted}, denied=${denied}, ` +
        `hits ${seededHits}→${finalHits} (limit ${rule.limit})`,
    );
  });

  // ── 4. Idempotency / no double-count on replay ────────────────────────────────
  // Concurrent replays against an ALREADY-FULL window must be pure denials: the
  // counter must not inflate past the limit. An over-counting limiter would keep a
  // user locked out beyond their actual usage; an under-counting one leaks spend.
  await test("concurrent replays on a full window do not inflate hits", async () => {
    const rl = await import("../src/lib/server/rateLimit");
    const route = "quality_judge" as const;
    const rule = rl.RATE_LIMITS[route];
    const userId = identity("replay");

    const nowMs = Date.now();
    const windowStart = new Date(rl.windowStartMs(nowMs, rule.windowSeconds)).toISOString();

    // Prime the window exactly AT the limit — zero capacity remaining.
    await service
      .from(TABLE)
      .insert({ vibepin_user_id: userId, route, window_start: windowStart, hits: rule.limit });

    const replays = 16;
    const decisions = await Promise.all(
      Array.from({ length: replays }, () => rl.consumeRateLimit(userId, route, nowMs)),
    );

    const admitted = decisions.filter(d => d.allowed).length;
    assertEq(admitted, 0, "a full window must admit nobody");
    assert(
      decisions.every(d => !d.allowed && d.reason === "limit_exceeded"),
      "every replay must be denied with limit_exceeded (not limiter_unavailable)",
    );
    assertEq(
      await readHits(userId, route, windowStart),
      rule.limit,
      `hits must stay pinned at the limit after ${replays} concurrent replays`,
    );
  });

  // ── 5. Window reset restores capacity ─────────────────────────────────────────
  await test("a new fixed window restores full capacity", async () => {
    const rl = await import("../src/lib/server/rateLimit");
    const route = "ai_copy_analyze" as const;
    const rule = rl.RATE_LIMITS[route];
    const userId = identity("window-reset");

    const nowMs = Date.now();
    const thisWindow = new Date(rl.windowStartMs(nowMs, rule.windowSeconds)).toISOString();
    await service
      .from(TABLE)
      .insert({ vibepin_user_id: userId, route, window_start: thisWindow, hits: rule.limit });

    // Exhausted in the current window.
    const denied = await rl.consumeRateLimit(userId, route, nowMs);
    assertEq(denied.allowed, false, "current window must be exhausted");

    // One full window later: a different bucket, therefore a fresh counter.
    const laterMs = nowMs + rule.windowSeconds * 1000;
    const nextWindow = new Date(rl.windowStartMs(laterMs, rule.windowSeconds)).toISOString();
    assert(nextWindow !== thisWindow, "the later timestamp must fall in a different bucket");

    const allowed = await rl.consumeRateLimit(userId, route, laterMs);
    assertEq(allowed.allowed, true, "the next window must admit again");
    assert(
      allowed.allowed && allowed.reason === "under_limit",
      "the next-window admission must be a real one, not fail-open",
    );
    assertEq(await readHits(userId, route, nextWindow), 1, "new window starts at hits=1");
    // The old window is untouched — windows are independent buckets.
    assertEq(await readHits(userId, route, thisWindow), rule.limit, "old window must be unchanged");
  });

  // ── 6. RLS — the anon key must not reach this table at all ────────────────────
  // v53 enables RLS with ZERO permissive policies, so only the service role (which
  // bypasses RLS) may touch it. A client that could write this table could raise its
  // own rate limit.
  //
  // CRITICAL ASSERTION SHAPE: PostgREST returns HTTP 200 + `[]` for an RLS-hidden
  // SELECT, and 204 for a PATCH that matched zero rows. Neither status distinguishes
  // "blocked" from "succeeded". So every assertion below is on ROWS and on the
  // RE-READ VALUE, never on the status code.
  await test("RLS: anon key cannot READ rows that exist (200 + [] is not access)", async () => {
    const userId = identity("rls-read");
    const windowStart = new Date(0).toISOString();
    await service
      .from(TABLE)
      .insert({ vibepin_user_id: userId, route: "ai_copy", window_start: windowStart, hits: 3 });

    // Prove the row genuinely exists for the service role first — otherwise "anon
    // saw nothing" would be trivially true and the test would prove nothing.
    assertEq(await readHits(userId, "ai_copy", windowStart), 3, "row must exist for service role");

    const { data, error } = await anon
      .from(TABLE)
      .select("hits")
      .eq("vibepin_user_id", userId)
      .eq("route", "ai_copy")
      .eq("window_start", windowStart);
    // Either a hard error or an empty result set is acceptable; a returned row is not.
    if (!error) {
      assertEq(data?.length ?? 0, 0, "anon SELECT must return ZERO rows for an existing row");
    }
  });

  await test("RLS: anon key cannot WRITE (verified by re-reading, not by status)", async () => {
    const userId = identity("rls-write");
    const windowStart = new Date(0).toISOString();
    await service
      .from(TABLE)
      .insert({ vibepin_user_id: userId, route: "ai_copy", window_start: windowStart, hits: 7 });

    // UPDATE attempt — a 204 here proves nothing, so re-read the value.
    await anon
      .from(TABLE)
      .update({ hits: 0 })
      .eq("vibepin_user_id", userId)
      .eq("route", "ai_copy")
      .eq("window_start", windowStart);
    assertEq(
      await readHits(userId, "ai_copy", windowStart),
      7,
      "anon UPDATE must not have changed the stored value",
    );

    // DELETE attempt — likewise verified by re-reading.
    await anon
      .from(TABLE)
      .delete()
      .eq("vibepin_user_id", userId)
      .eq("route", "ai_copy")
      .eq("window_start", windowStart);
    assertEq(
      await readHits(userId, "ai_copy", windowStart),
      7,
      "anon DELETE must not have removed the row",
    );

    // INSERT attempt — verified by the row's absence under the service role.
    const anonInsertId = identity("rls-insert");
    await anon
      .from(TABLE)
      .insert({ vibepin_user_id: anonInsertId, route: "ai_copy", window_start: windowStart, hits: 1 });
    assertEq(
      await readHits(anonInsertId, "ai_copy", windowStart),
      null,
      "anon INSERT must not have created a row",
    );
  });

  // ── 7. Cleanup, asserted ──────────────────────────────────────────────────────
  // Cleanup is itself a test: a harness that leaks rows into a shared database
  // degrades every later run.
  const removed = await cleanup();
  await test("cleanup: every row this run created has been removed", async () => {
    const { data, error } = await service
      .from(TABLE)
      .select("vibepin_user_id")
      .like("vibepin_user_id", `${IDENTITY_PREFIX}:%`);
    assert(!error, `post-cleanup verification failed: ${error?.message ?? ""}`);
    assertEq(data?.length ?? -1, 0, `rows left behind by run ${RUN_ID}`);
    console.log(`        removed ${removed} row(s) for run ${RUN_ID}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

main().catch(async err => {
  console.error("\nFATAL:", (err as Error).message);
  // Never leave rows behind, even on an unexpected throw.
  try {
    const removed = await cleanup();
    console.error(`(cleanup removed ${removed} row(s) for run ${RUN_ID})`);
  } catch (cleanupErr) {
    console.error(`(cleanup ALSO failed: ${(cleanupErr as Error).message} — run id ${RUN_ID})`);
  }
  process.exit(1);
});
