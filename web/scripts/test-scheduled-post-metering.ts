/**
 * Phase 5B — scheduled-post metering contract.
 *
 * What this pins (the frozen contract):
 *   - one content publish = ONE unit, quantity hardwired to 1
 *   - a cron RE-CLAIM of the same draft+scheduled_at derives the IDENTICAL key,
 *     so the at-least-once publish window cannot double-charge. This is the whole
 *     reason the key is (draft_id, scheduled_at) and never claim time.
 *   - immediate publish is charged too (else "publish now" bypasses the quota),
 *     keyed on a UTC date bucket so a double-click the same day is free
 *   - OFF does nothing; SHADOW never blocks (a ledger outage must not stop a publish)
 *   - keys are salted per user, so the same draft id under two users cannot collide
 *
 * The RPC itself (idempotent replay, unlimited plans, the quantity guardrail) is
 * proven against real Postgres in test-db-post-metering.ts — this file is the pure
 * unit contract and needs no DB.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_REQUEST_KEY_SALT = "test-salt";

import assert from "node:assert";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((err) => { console.log(`  ✗ ${name}\n      ${err?.message ?? err}`); failed++; });
}

type RpcCall = { fn: string; args: Record<string, unknown> };

/** A recording RPC seam; `impl` decides what the ledger "returns".
 *  Shapes the result like supabase-js ({data, error}) so it satisfies RpcRunner. */
function makeRpc(impl?: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: RpcCall[] = [];
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return { data: impl ? impl(fn, args) : { ok: true }, error: null };
  };
  return { rpc, calls };
}

const ensureNoop = async () => ({ ok: true });

async function load(mode: string) {
  process.env.USAGE_METERING_MODE = mode;
  delete require.cache[require.resolve("../src/lib/server/usage/meterScheduledPost")];
  delete require.cache[require.resolve("../src/lib/server/usage/meterGeneration")];
  return await import("../src/lib/server/usage/meterScheduledPost");
}

(async () => {
  console.log("=== Phase 5B — scheduled post metering ===\n");

  // ── The re-claim invariant: the single most important assertion in 5B ────────
  await test("cron RE-CLAIM of the same draft+scheduled_at derives the IDENTICAL key", async () => {
    const m = await load("shadow");
    const user = "u-1";
    const draft = "pd_1720000000_ab12cd";
    const due = "2026-08-01T09:00:00.000Z";
    // First claim, then a stale re-claim 10+ minutes later: claim time differs,
    // but the key is derived from scheduled_at, so it must not move.
    const first = m.deriveScheduledPostKey(user, draft, due);
    const reclaim = m.deriveScheduledPostKey(user, draft, due);
    assert.equal(first, reclaim, "a re-claim must reuse the key, otherwise it double-charges");
  });

  await test("a DIFFERENT scheduled_at is a different action (rescheduled = new charge)", async () => {
    const m = await load("shadow");
    const a = m.deriveScheduledPostKey("u-1", "pd_x", "2026-08-01T09:00:00.000Z");
    const b = m.deriveScheduledPostKey("u-1", "pd_x", "2026-08-02T09:00:00.000Z");
    assert.notEqual(a, b);
  });

  await test("keys are salted per user — same draft id under two users cannot collide", async () => {
    const m = await load("shadow");
    const a = m.deriveScheduledPostKey("u-1", "pd_same", "2026-08-01T09:00:00.000Z");
    const b = m.deriveScheduledPostKey("u-2", "pd_same", "2026-08-01T09:00:00.000Z");
    assert.notEqual(a, b);
  });

  await test("immediate publish buckets by UTC day — a same-day retry is free", async () => {
    const m = await load("shadow");
    const a = m.deriveScheduledPostKey("u-1", "pd_x");
    const b = m.deriveScheduledPostKey("u-1", "pd_x");
    assert.equal(a, b, "two immediate publishes of one draft the same day are one action");
  });

  // ── The server-minted bucket override (the midnight-relay fix) ───────────────
  await test("deriveScheduledPostKey with a bucketOverride uses it INSTEAD of computing its own", async () => {
    const m = await load("shadow");
    const withOverride = m.deriveScheduledPostKey("u-1", "pd_x", undefined, "2020-01-01");
    // Compare against a key manually built from the same salted-hash contract by
    // driving `immediateBucketForNow` to report that exact date, so this assertion
    // does not depend on today's real UTC date.
    const asIfToday = m.deriveScheduledPostKey("u-1", "pd_x", undefined, m.immediateBucketForNow(Date.parse("2020-01-01T12:00:00.000Z")));
    assert.equal(withOverride, asIfToday, "the override IS the bucket the key is built from");
  });

  await test("a real scheduledAtIso always wins over a bucketOverride — the override only applies on the immediate path", async () => {
    const m = await load("shadow");
    const withScheduledAt = m.deriveScheduledPostKey("u-1", "pd_x", "2026-08-01T09:00:00.000Z", "2020-01-01");
    const withoutOverride = m.deriveScheduledPostKey("u-1", "pd_x", "2026-08-01T09:00:00.000Z");
    assert.equal(withScheduledAt, withoutOverride, "a scheduled key must ignore an override — it is never on the immediate path");
  });

  // ── isAcceptableImmediateBucket — the validation gate for a client-relayed bucket ──
  await test("isAcceptableImmediateBucket: yesterday / today / tomorrow (relative to nowMs) are all accepted", async () => {
    const m = await load("shadow");
    const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
    assert.equal(m.isAcceptableImmediateBucket("2026-08-14", nowMs), true, "yesterday");
    assert.equal(m.isAcceptableImmediateBucket("2026-08-15", nowMs), true, "today");
    assert.equal(m.isAcceptableImmediateBucket("2026-08-16", nowMs), true, "tomorrow");
  });

  await test("isAcceptableImmediateBucket: ±2 days is rejected — the window is exactly one day either side", async () => {
    const m = await load("shadow");
    const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
    assert.equal(m.isAcceptableImmediateBucket("2026-08-13", nowMs), false, "two days in the past");
    assert.equal(m.isAcceptableImmediateBucket("2026-08-17", nowMs), false, "two days in the future");
  });

  await test("isAcceptableImmediateBucket: malformed strings are rejected", async () => {
    const m = await load("shadow");
    const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
    assert.equal(m.isAcceptableImmediateBucket("2026-8-15", nowMs), false, "unpadded month");
    assert.equal(m.isAcceptableImmediateBucket("2026-08-1", nowMs), false, "unpadded day");
    assert.equal(m.isAcceptableImmediateBucket("20260815", nowMs), false, "no separators");
    assert.equal(m.isAcceptableImmediateBucket("", nowMs), false, "empty string");
    assert.equal(m.isAcceptableImmediateBucket("not-a-date", nowMs), false, "not a date at all");
  });

  await test("isAcceptableImmediateBucket: non-string candidates are rejected", async () => {
    const m = await load("shadow");
    const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
    assert.equal(m.isAcceptableImmediateBucket(123, nowMs), false, "number");
    assert.equal(m.isAcceptableImmediateBucket(null, nowMs), false, "null");
    assert.equal(m.isAcceptableImmediateBucket(undefined, nowMs), false, "undefined");
    assert.equal(m.isAcceptableImmediateBucket({}, nowMs), false, "object");
  });

  // Cross-route parity (pins path vs. social path deriving the identical key for
  // the same Content) is proven at the real-route level in
  // test-social-only-metering.ts, which loads BOTH actual route modules and
  // compares the p_idempotency_key each one's real consume call sends — calling
  // deriveScheduledPostKey(uid, draftId) twice in a row here was tautological
  // (same function, same args, in the same process) and proved nothing about the
  // two routes actually agreeing on what "the identity" is.

  // ── Mode contract ────────────────────────────────────────────────────────────
  await test("OFF: no ledger call at all", async () => {
    const m = await load("off");
    const { rpc, calls } = makeRpc();
    const r = await m.consumeScheduledPost({ userId: "u-1", key: "k", deps: { rpc, ensure: ensureNoop } });
    assert.equal(r.kind, "off");
    assert.equal(calls.length, 0, "OFF must not touch the ledger");
  });

  await test("SHADOW: exactly one consume, quantity hardwired to 1", async () => {
    const m = await load("shadow");
    const { rpc, calls } = makeRpc();
    await m.consumeScheduledPost({
      userId: "u-1", key: "k-1", referenceId: "pd_x",
      metadata: { source: "scheduled-cron" }, deps: { rpc, ensure: ensureNoop },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, "usage_consume_scheduled_post");
    assert.equal(calls[0].args.p_quantity, 1, "one content publish = one unit; the module never accepts a quantity");
    assert.equal(calls[0].args.p_idempotency_key, "k-1");
    assert.equal(calls[0].args.p_reference_id, "pd_x");
  });

  await test("SHADOW: ensureUsageAccount runs BEFORE the consume (the RPC raises without a row)", async () => {
    const m = await load("shadow");
    const order: string[] = [];
    const rpc = async (fn: string) => { order.push(`rpc:${fn}`); return { data: { ok: true }, error: null }; };
    const ensure = async () => { order.push("ensure"); return { ok: true }; };
    await m.consumeScheduledPost({ userId: "u-1", key: "k", deps: { rpc, ensure } });
    assert.deepEqual(order, ["ensure", "rpc:usage_consume_scheduled_post"]);
  });

  // ── Fail-open: the property that protects real publishes ─────────────────────
  await test("SHADOW: a ledger THROW never propagates — a publish must not fail on accounting", async () => {
    const m = await load("shadow");
    const rpc = async () => { throw new Error("simulated supabase outage"); };
    const r = await m.consumeScheduledPost({ userId: "u-1", key: "k", deps: { rpc, ensure: ensureNoop } });
    assert.ok(r.kind !== "consumed", "an outage is not a successful consume");
    // The point: it RESOLVED instead of throwing, so the caller publishes anyway.
  });

  await test("SHADOW: an ensure failure is also swallowed (fail-open end to end)", async () => {
    const m = await load("shadow");
    const { rpc, calls } = makeRpc();
    const ensure = async () => { throw new Error("account provisioning down"); };
    const r = await m.consumeScheduledPost({ userId: "u-1", key: "k", deps: { rpc, ensure } });
    assert.ok(r.kind !== "consumed");
    assert.equal(calls.length, 0, "a failed ensure must not reach the consume RPC");
  });

  await test("SHADOW: a ledger refusal is reported but still does not block (enforce is 6C)", async () => {
    const m = await load("shadow");
    const { rpc } = makeRpc(() => ({ ok: false, reason: "limit_reached" }));
    const r = await m.consumeScheduledPost({ userId: "u-1", key: "k", deps: { rpc, ensure: ensureNoop } });
    assert.ok(r.kind !== "consumed");
  });

  await test("SHADOW: a replayed consume is reported as replayed, not double-counted", async () => {
    const m = await load("shadow");
    const { rpc, calls } = makeRpc(() => ({ ok: true, replayed: true }));
    const r = await m.consumeScheduledPost({ userId: "u-1", key: "same-key", deps: { rpc, ensure: ensureNoop } });
    assert.equal(calls.length, 1, "the RPC is called once; IT collapses the replay, not us");
    assert.equal(r.kind, "consumed");
    assert.equal((r as { replayed: boolean }).replayed, true, "the RPC reports the replay; we surface it");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
