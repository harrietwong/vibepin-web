/**
 * v68 — scheduled-post REFUND (release) + consume key re-arming, against REAL Postgres.
 *
 * The refund rule (PRD v3.2 §5.3/§5.4, decisions #4 and #8) is only half a TS
 * concern. The half that decides whether a merchant is charged twice lives entirely
 * inside two plpgsql functions, and rests on facts an in-memory fake cannot have:
 * `usage_events`'s UNIQUE (user_id, idempotency_key), the `FOR UPDATE` lock order,
 * `greatest(0, …)`, and the ledger scan that derives which attempt of a key family
 * we are on. A fake that returns `{ok:true}` proves that the TS wrapper unwraps a
 * jsonb envelope — nothing about the arithmetic that the money depends on.
 *
 * Pinned here (design §A.6.1):
 *   1. consume K → release        → scheduled_posts_used falls back to 0,
 *                                   exactly ONE `release` event, keyed K:release:1,
 *                                   metadata carries {reason, released_consume_key, attempt}
 *   2. re-consume K after a refund → CHARGED AGAIN, under the re-armed key K:r1
 *                                   (this is the whole point of the migration: the
 *                                   caller passes the same K, the RPC re-arms it)
 *   3. replayed release            → replayed:true and NO second decrement
 *   4. release with no consume     → nothing_to_release, ok:false, no write
 *   5. delivery_unknown            → the caller simply does not call release; the
 *                                   charge must still stand (asserted as "no release
 *                                   event exists and usage is unchanged")
 *   6. cron re-claim mid-attempt   → still collapses to one charge AFTER a refund
 *                                   (the re-armed key must stay idempotent too)
 *   7. unsupported reason          → RAISES (a caller-side mapping bug must be loud)
 *   8. the real RPC's over-limit answer maps to `insufficient_capacity` — the string
 *      the TS meter must recognise for the A.4.0 blocking sites to fire at all
 *
 * Writes and deletes real rows in the ISOLATED test project only — never production.
 * The target ref is printed and asserted BEFORE any write (assertNotProduction).
 *
 * REQUIRES migrate_v68_scheduled_post_release.sql to be applied to the TEST project.
 * If it is not, every test here fails loudly with "function does not exist" — which
 * is the correct outcome: a green run against a database without the function would
 * be a green run that verified nothing.
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
    console.error("\n=== POST RELEASE DB TEST CANNOT RUN ===\n");
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
const KEY_PREFIX = `itest-rel:${RUN_ID}`;

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

type EventRow = {
  operation: string;
  quantity: number;
  idempotency_key: string;
  metadata: Record<string, unknown> | null;
};

async function readEvents(userId: string, operation?: string): Promise<EventRow[]> {
  let q = service
    .from("usage_events")
    .select("operation, quantity, idempotency_key, metadata")
    .eq("user_id", userId);
  if (operation) q = q.eq("operation", operation);
  const { data, error } = await q;
  if (error) throw new Error(`readEvents failed: ${error.message}`);
  return (data ?? []) as EventRow[];
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

async function release(userId: string, key: string, reason = "not_sent") {
  return await service.rpc("usage_release_scheduled_post", {
    p_user_id: userId,
    p_idempotency_key: key,
    p_reason: reason,
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
  console.log("=== REAL POSTGRES — v68 scheduled-post release (refund) ===");
  console.log(`  target project ref : ${cfg.projectRef}`);
  console.log(`  run id             : ${RUN_ID}`);
  console.log("  (writes and deletes real rows; never production)\n");

  await test("preflight: usage_release_scheduled_post exists and is reachable", async () => {
    const acct = await makeAccount("preflight");
    const { error } = await release(acct.userId, `${KEY_PREFIX}:preflight`);
    if (error) {
      throw new Error(
        `RPC unreachable — has migrate_v68_scheduled_post_release.sql been applied to ${cfg.projectRef}? ${error.message}`,
      );
    }
  });

  await test("consume → release: usage falls back AND exactly one release event is written", async () => {
    const acct = await makeAccount("basic");
    const key = `${KEY_PREFIX}:basic`;
    await consume(acct.userId, key);
    if ((await readPostsUsed(acct.id)) !== 1) throw new Error("setup: the consume did not charge");

    const { data, error } = await release(acct.userId, key, "rejected");
    if (error) throw new Error(error.message);
    const res = data as { ok?: boolean; replayed?: boolean; attempt?: number };
    if (res?.ok !== true) throw new Error(`expected ok, got ${JSON.stringify(data)}`);
    if (res?.replayed !== false) throw new Error(`expected a fresh release, got ${JSON.stringify(data)}`);

    const used = await readPostsUsed(acct.id);
    if (used !== 0) throw new Error(`expected used=0 after refund, got ${used}`);

    const releases = await readEvents(acct.userId, "release");
    if (releases.length !== 1) throw new Error(`expected 1 release event, got ${releases.length}`);
    const ev = releases[0];
    if (ev.idempotency_key !== `${key}:release:1`) {
      throw new Error(`release key should be K:release:1, got ${ev.idempotency_key}`);
    }
    if (ev.metadata?.reason !== "rejected") throw new Error(`metadata.reason missing: ${JSON.stringify(ev.metadata)}`);
    if (ev.metadata?.released_consume_key !== key) {
      throw new Error(`metadata.released_consume_key should be K, got ${JSON.stringify(ev.metadata)}`);
    }
    if (ev.metadata?.attempt !== 1) throw new Error(`metadata.attempt should be 1, got ${JSON.stringify(ev.metadata)}`);
    console.log("        observed: used 1 → 0, one release event keyed K:release:1");
  });

  await test("refunded, then published again → CHARGED AGAIN (re-armed key K:r1)", async () => {
    const acct = await makeAccount("rearm");
    const key = `${KEY_PREFIX}:rearm`;
    await consume(acct.userId, key);
    await release(acct.userId, key, "not_sent");
    if ((await readPostsUsed(acct.id)) !== 0) throw new Error("setup: refund did not land");

    // The CALLER passes the SAME key — it has no attempt counter. The RPC re-arms.
    const { data, error } = await consume(acct.userId, key);
    if (error) throw new Error(error.message);
    const res = data as { ok?: boolean; replayed?: boolean };
    if (res?.ok !== true) throw new Error(`expected ok, got ${JSON.stringify(data)}`);
    if (res?.replayed !== false) {
      throw new Error(`THE core defect this migration fixes: the re-publish collapsed into a replay — ${JSON.stringify(data)}`);
    }
    const used = await readPostsUsed(acct.id);
    if (used !== 1) throw new Error(`expected the second publish to charge, used=${used}`);

    const consumes = await readEvents(acct.userId, "consume");
    const keys = consumes.map(c => c.idempotency_key).sort();
    if (!keys.includes(`${key}:r1`)) {
      throw new Error(`expected a consume under the re-armed key K:r1, saw ${JSON.stringify(keys)}`);
    }
    console.log("        observed: consume K → release → consume K landed on K:r1 and charged");
  });

  await test("a cron re-claim AFTER a refund still collapses to one charge (K:r1 stays idempotent)", async () => {
    const acct = await makeAccount("rearm-replay");
    const key = `${KEY_PREFIX}:rearm-replay`;
    await consume(acct.userId, key);
    await release(acct.userId, key, "not_sent");
    await consume(acct.userId, key); // attempt 2 → K:r1
    const { data } = await consume(acct.userId, key); // the re-claim of attempt 2
    if ((data as { replayed?: boolean })?.replayed !== true) {
      throw new Error(`a re-claim within attempt 2 must replay, got ${JSON.stringify(data)}`);
    }
    const used = await readPostsUsed(acct.id);
    if (used !== 1) throw new Error(`a re-claim double-charged after a refund: used=${used}`);
  });

  await test("replayed release → replayed:true and NO second decrement", async () => {
    const acct = await makeAccount("replay-release");
    const key = `${KEY_PREFIX}:replay-release`;
    await consume(acct.userId, key);
    await consume(acct.userId, key); // a replay; usage is 1, not 2
    await release(acct.userId, key);
    const usedAfterFirst = await readPostsUsed(acct.id);

    const { data, error } = await release(acct.userId, key);
    if (error) throw new Error(error.message);
    const res = data as { ok?: boolean; replayed?: boolean };
    if (res?.ok !== true || res?.replayed !== true) {
      throw new Error(`a repeated release must report a replay, got ${JSON.stringify(data)}`);
    }
    const usedAfterSecond = await readPostsUsed(acct.id);
    if (usedAfterSecond !== usedAfterFirst) {
      throw new Error(`a repeated release decremented again: ${usedAfterFirst} → ${usedAfterSecond}`);
    }
    const releases = await readEvents(acct.userId, "release");
    if (releases.length !== 1) throw new Error(`expected exactly 1 release event, got ${releases.length}`);
  });

  await test("release with no matching consume → nothing_to_release, ok:false, nothing written", async () => {
    const acct = await makeAccount("nothing");
    const before = (await readEvents(acct.userId)).length;
    const { data, error } = await release(acct.userId, `${KEY_PREFIX}:never-consumed`);
    if (error) throw new Error(error.message);
    const res = data as { ok?: boolean; reason?: string };
    if (res?.ok !== false || res?.reason !== "nothing_to_release") {
      throw new Error(`expected {ok:false, reason:'nothing_to_release'}, got ${JSON.stringify(data)}`);
    }
    const after = (await readEvents(acct.userId)).length;
    if (after !== before) throw new Error(`a no-op release wrote ${after - before} event(s)`);
    if ((await readPostsUsed(acct.id)) !== 0) throw new Error("a no-op release changed usage");
  });

  await test("delivery_unknown: the caller never calls release → the charge stands", async () => {
    // This is a NEGATIVE test on purpose. `delivery_unknown` (timeout / 5xx / no
    // provider status) has no RPC of its own — the correct behaviour IS the absence
    // of a call. What the database must show afterwards is a charge with no refund.
    const acct = await makeAccount("unknown");
    const key = `${KEY_PREFIX}:unknown`;
    await consume(acct.userId, key);
    // …provider timed out. Nothing is called.
    const used = await readPostsUsed(acct.id);
    if (used !== 1) throw new Error(`the charge must stand for delivery_unknown, used=${used}`);
    const releases = await readEvents(acct.userId, "release");
    if (releases.length !== 0) throw new Error(`delivery_unknown must never produce a release event (${releases.length})`);
  });

  await test("an unsupported reason RAISES (a route-side mapping bug must be loud)", async () => {
    const acct = await makeAccount("bad-reason");
    const key = `${KEY_PREFIX}:bad-reason`;
    await consume(acct.userId, key);
    const { error } = await release(acct.userId, key, "delivery_unknown");
    if (!error) throw new Error("expected the RPC to raise on an unsupported reason");
    const used = await readPostsUsed(acct.id);
    if (used !== 1) throw new Error(`a raised release must not have refunded anything, used=${used}`);
    console.log(`        observed: ${error.message.slice(0, 90)}`);
  });

  await test("over-limit consume answers `insufficient_capacity` — the string the TS meter must match", async () => {
    // The A.4.0 blocking sites key on consumeScheduledPost() returning
    // kind:"insufficient". That mapping reads the RPC's `reason` field, and before
    // this suite nothing pinned WHICH string the real database sends: the fakes said
    // "insufficient", v55 says "insufficient_capacity". If the TS ever narrows back
    // to one of them, this is the test that goes red instead of a limit gate silently
    // failing open in production.
    const acct = await makeAccount("limit", 1);
    await consume(acct.userId, `${KEY_PREFIX}:limit-1`);
    const { data, error } = await consume(acct.userId, `${KEY_PREFIX}:limit-2`);
    if (error) throw new Error(error.message);
    const res = data as { ok?: boolean; reason?: string };
    if (res?.ok !== false) throw new Error(`expected a refusal at the limit, got ${JSON.stringify(data)}`);
    if (res?.reason !== "insufficient_capacity") {
      throw new Error(`the meter matches on this exact string; got ${JSON.stringify(res?.reason)}`);
    }
    if ((await readPostsUsed(acct.id)) !== 1) throw new Error("a refused consume must not charge");
  });

  await test("refund never drives the counter negative (greatest(0, …))", async () => {
    const acct = await makeAccount("floor");
    const key = `${KEY_PREFIX}:floor`;
    await consume(acct.userId, key);
    // Simulate a period roll (v56) between the charge and the refund: usage is reset
    // to 0 while the consume event from the previous period still exists.
    const { error: resetErr } = await service
      .from("usage_accounts")
      .update({ scheduled_posts_used: 0 })
      .eq("id", acct.id);
    if (resetErr) throw new Error(`setup reset failed: ${resetErr.message}`);
    await release(acct.userId, key);
    const used = await readPostsUsed(acct.id);
    if (used !== 0) throw new Error(`expected the counter to floor at 0, got ${used}`);
  });

  await test("RPC LEVEL: a release after a REPLAYED consume still refunds — the route gate is the only enforcement", async () => {
    // Codex round 7, High 1 + High 2. `usage_release_scheduled_post` receives only
    // (user, K, reason). It carries NO attempt identity, so it structurally cannot
    // tell "the caller that charged this unit is asking for it back" apart from "a
    // different caller, whose own consume merely REPLAYED, is asking". It refunds the
    // family's standing consume either way.
    //
    // This case exists to pin that fact in the real database rather than assert a
    // guard that is not there:
    //   consume K       → charged (fresh)
    //   consume K again → replayed, charged nothing (the second route / the retry)
    //   release K       → STILL refunds, taking the unit the FIRST consume earned
    //
    // There is no safe one-line RPC guard: the migration would have to be told which
    // attempt is asking, which means a new parameter and a caller-side identity that
    // does not exist yet (publish-action identity, PRD v3.2 §21 5A). So the fix lives
    // where the information IS available — in the routes, which each know whether
    // THEIR OWN consume came back `replayed:false`, and refuse to release otherwise
    // (see the `meterFresh` gates in /api/pinterest/pins, /api/publish/social and
    // /api/cron/publish-due, and test-publish-refund-mapping / test-cron-refund-mapping
    // for the cross-route evidence). The migration is deliberately UNCHANGED.
    const acct = await makeAccount("replayed-then-release");
    const key = `${KEY_PREFIX}:replayed-then-release`;

    const { data: first } = await consume(acct.userId, key);
    if ((first as { replayed?: boolean })?.replayed !== false) {
      throw new Error(`setup: the first consume must be fresh, got ${JSON.stringify(first)}`);
    }
    const { data: second } = await consume(acct.userId, key);
    if ((second as { replayed?: boolean })?.replayed !== true) {
      throw new Error(`setup: the second consume must replay, got ${JSON.stringify(second)}`);
    }
    if ((await readPostsUsed(acct.id)) !== 1) throw new Error("setup: two consumes must charge once");

    // The replaying caller asks for a refund. The RPC has no way to refuse it.
    const { data: rel, error } = await release(acct.userId, key, "rejected");
    if (error) throw new Error(error.message);
    const r = rel as { ok?: boolean; replayed?: boolean };
    if (r?.ok !== true || r?.replayed !== false) {
      throw new Error(
        `the RPC was expected to refund (it cannot distinguish callers); got ${JSON.stringify(rel)}. ` +
        "If this now REFUSES, the migration gained a guard and this test's premise — and the route " +
        "comments naming the gate as the only enforcement point — must be revisited.",
      );
    }
    const used = await readPostsUsed(acct.id);
    if (used !== 0) throw new Error(`expected the RPC to have decremented, used=${used}`);
    console.log("        observed: the RPC cannot distinguish a replaying caller — the route gate is load-bearing");
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
