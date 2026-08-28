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

  // ── Cross-route parity: the pins path and the social path must never charge twice ──
  // /api/pinterest/pins and /api/publish/social both call
  // deriveScheduledPostKey(uid, draftId) for the SAME Content when a publish targets
  // Pinterest AND a social platform together. If either call site salted, bucketed, or
  // hashed differently, the two routes would mint two different idempotency keys for
  // one publish and usage_consume_scheduled_post's UNIQUE(user_id, idempotency_key)
  // could not collapse them — the social route's metering fix would silently double-
  // charge instead of closing the gap. Same inputs, same call, must be the same key.
  await test("the pins path and the social path derive the IDENTICAL key for one Content (same uid, same draftId)", async () => {
    const m = await load("shadow");
    const uid = "u-cross-route";
    const draftId = "pd_cross_route_1";
    // Neither call site passes scheduledAtIso for an immediate publish — both fall
    // through to the same UTC-date bucket. Calling it twice, exactly as the pins route
    // and the social route each independently do, must not move the result.
    const fromPinsRoute = m.deriveScheduledPostKey(uid, draftId);
    const fromSocialRoute = m.deriveScheduledPostKey(uid, draftId);
    assert.equal(
      fromPinsRoute, fromSocialRoute,
      "same (uid, draftId) must derive the same key regardless of which route calls it — " +
      "otherwise a Pinterest+social publish would be charged twice, not collapsed to one",
    );
  });

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

  // ── PER-TYPE ENFORCE SWITCH (decision #8, 2026-08-28) ─ usageEnforceFor exists for
  // scheduled_post too, but consumeScheduledPost itself is STILL fully unwired to any
  // blocking decision (Phase 6C, not this phase) ─ so it must never block regardless
  // of the mode/flag combination below. When 6C wires a caller-side block, that call
  // site should read usageEnforceFor("scheduled_post"), exactly like the image/text
  // call sites do ─ proven directly against the shared switch in
  // test-usage-enforce-switches.ts.
  await test("ENFORCE + USAGE_ENFORCE_SCHEDULED_POSTS on: a ledger refusal is reported but STILL does not block (6C not wired yet)", async () => {
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    const m = await load("enforce");
    assert.equal(m.usageEnforceFor("scheduled_post"), true, "the switch itself is on");
    const { rpc } = makeRpc(() => ({ ok: false, reason: "limit_reached" }));
    const r = await m.consumeScheduledPost({ userId: "u-1", key: "k", deps: { rpc, ensure: ensureNoop } });
    assert.ok(r.kind !== "consumed", "still not consumed (refusal reported)");
    delete process.env.USAGE_ENFORCE_SCHEDULED_POSTS;
  });

  await test("ENFORCE WITHOUT USAGE_ENFORCE_SCHEDULED_POSTS: a ledger refusal is reported but does not block either", async () => {
    delete process.env.USAGE_ENFORCE_SCHEDULED_POSTS;
    const m = await load("enforce");
    assert.equal(m.usageEnforceFor("scheduled_post"), false, "the switch is off — global mode alone does not flip it");
    const { rpc } = makeRpc(() => ({ ok: false, reason: "limit_reached" }));
    const r = await m.consumeScheduledPost({ userId: "u-1", key: "k", deps: { rpc, ensure: ensureNoop } });
    assert.ok(r.kind !== "consumed", "still not consumed (refusal reported, no block either way — unwired)");
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
