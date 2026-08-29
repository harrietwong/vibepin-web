/**
 * test-cron-refund-mapping.ts — the four delivery states on the CRON publish path.
 *
 * The cron publisher is the one route with no user waiting on a response, which
 * makes it the one where a wrong refund decision is invisible until the ledger is
 * audited. It is also the route with the most ways to fail: a row can have an
 * unpublishable payload, one of several Pinterest accounts can fail while another
 * publishes, a social fan-out can fail after Pinterest succeeded, trial access can
 * block everything, and a throw can escape from anywhere in the row's processing.
 *
 * Cells pinned here (design §A.4, cron row):
 *   sent              a destination published                     → charge stands
 *   not_sent          a typed publishPinForUser failure, or a
 *                     thrown NotConnected/NeedsReconnect          → REFUND
 *   rejected          a Pinterest 4xx with no pin id              → REFUND
 *   delivery_unknown  5xx / no providerStatus at all              → charge stands
 *   partial           one account published, another failed       → charge stands
 *   trial access      never refunded (the row keeps its schedule
 *                     and is re-charged under the SAME key)       → charge stands
 *   nothing owed      every destination already published         → charge stands
 *   A.4.0 blocking    enforce + flag + insufficient → the row is
 *                     marked failed with a limit code, `scheduled_at`
 *                     is CLEARED (no retry storm), Pinterest is
 *                     never called, and nothing is refunded
 *                     (nothing was charged)
 *   shadow            insufficient still publishes
 *
 * Loads the REAL route module and fakes only the Supabase/publish boundary, so what
 * is proven is the route's actual wiring. Touches no database.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_METERING_MODE = "shadow";
process.env.USAGE_REQUEST_KEY_SALT = "test-salt";
process.env.CRON_SECRET = "test-cron-secret";

import assert from "node:assert";
import Module from "node:module";

const OWNER = "user-cron-refund-1";
const DRAFT = "pd_cron_1";
const DUE_AT = "2026-08-01T09:00:00.000Z";

let passed = 0, failed = 0;

type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
let rpcBehaviour: (fn: string, args: Record<string, unknown>) => RpcResult = () => ({
  data: { ok: true, replayed: false },
  error: null,
});

/** The row the fake scan/claim hands the route. Mutated per test. */
// `targetConnectionId` is required: resolveScheduledDestinations derives a
// Pinterest-only intent for a legacy Pin ONLY when the draft names a pinned target.
// Without it the row resolves to ZERO destinations and every test would pass
// vacuously through the "nothing owed" branch.
let duePayload: Record<string, unknown> = {
  boardId: "b1", imageUrl: "https://example.com/a.png", targetConnectionId: "conn-pin-1",
};

/** Every UPDATE the route wrote, so the blocking test can assert scheduled_at was cleared. */
const updates: Record<string, unknown>[] = [];

let publishPinBehaviour: () => Promise<unknown> = async () => ({
  ok: true,
  pin: { id: "p1", url: "https://pin/1" },
  board: { id: "b1", name: "Board" },
  environment: "production",
  connectionId: "conn-pin-1",
});
let publishPinCalls = 0;

/** What fanOutDestinations resolves to. Empty unless a test wants a social target. */
let fanOutBehaviour: () => Promise<unknown[]> = async () => [];

/**
 * A Supabase stand-in scripted for the cron route's exact three query shapes:
 *   SELECT … .limit()      → the due scan (resolved through `then`)
 *   UPDATE … .select()     → the claim (must RETURN the row to be "won")
 *   UPDATE … (no select)   → persistOutcomes / persistFailure / releaseClaim
 * A generic "everything is a missing table" fake cannot be used here: the route
 * would see no due rows and every test would pass vacuously.
 */
function fakeSupabaseClient() {
  function builder(): Record<string, unknown> {
    let isUpdate = false;
    let payload: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      insert: () => b,
      update: (v: Record<string, unknown>) => { isUpdate = true; payload = v; return b; },
      delete: () => b,
      eq: () => b,
      lte: () => b,
      not: () => b,
      is: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const row = {
          vibepin_user_id: OWNER,
          draft_id: DRAFT,
          payload: duePayload,
          scheduled_at: DUE_AT,
        };
        if (isUpdate) {
          if (payload) updates.push(payload);
          // The claim UPDATE returns the row; the persist UPDATEs return nothing
          // meaningful. Returning the row for both is harmless — nothing re-reads it.
          return Promise.resolve({ data: [row], error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: [row], error: null }).then(resolve, reject);
      },
    };
    return b;
  }
  return {
    from: () => builder(),
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return rpcBehaviour(fn, args);
    },
  };
}

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: unknown, isMain: boolean,
) {
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase")) {
    return { createServerClient: fakeSupabaseClient, createClient: fakeSupabaseClient };
  }
  if (request === "@/lib/server/pinterest/publishPin" || request.endsWith("/lib/server/pinterest/publishPin")) {
    return {
      publishPinForUser: async () => {
        publishPinCalls++;
        return publishPinBehaviour();
      },
    };
  }
  if (request === "./ensureAccount" || request.endsWith("/usage/ensureAccount")) {
    return { ensureUsageAccount: async () => ({ ok: true, action: "noop" }) };
  }
  // The fan-out layer. Faked whole so no social provider is ever constructed and no
  // network call is possible; `createPublishJob`/`recordOutcomes` degrade to no-ops.
  if (request === "@/lib/social/publishFanout" || request.endsWith("/social/publishFanout")) {
    const real = origLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      createPublishJob: async () => null,
      recordOutcomes: async () => {},
      fanOutDestinations: async () => fanOutBehaviour(),
    };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

async function test(name: string, fn: () => Promise<void>) {
  rpcCalls.length = 0;
  updates.length = 0;
  publishPinCalls = 0;
  rpcBehaviour = () => ({ data: { ok: true, replayed: false }, error: null });
  duePayload = {
    boardId: "b1", imageUrl: "https://example.com/a.png", targetConnectionId: "conn-pin-1",
  };
  publishPinBehaviour = async () => ({
    ok: true, pin: { id: "p1", url: "https://pin/1" }, board: { id: "b1", name: "Board" },
    environment: "production", connectionId: "conn-pin-1",
  });
  fanOutBehaviour = async () => [];
  process.env.USAGE_METERING_MODE = "shadow";
  delete process.env.USAGE_ENFORCE_SCHEDULED_POSTS;
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function cronReq(): Request {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer test-cron-secret" : null) },
  } as unknown as Request;
}

const consumeCalls = () => rpcCalls.filter(c => c.fn === "usage_consume_scheduled_post");
const releaseCalls = () => rpcCalls.filter(c => c.fn === "usage_release_scheduled_post");

function assertReleased(reason: "not_sent" | "rejected", key: string): void {
  const calls = releaseCalls();
  assert.equal(calls.length, 1, `expected exactly one release, saw ${calls.length}`);
  assert.equal(calls[0].args.p_reason, reason);
  assert.equal(calls[0].args.p_idempotency_key, key, "must release the key the consume charged");
}

function assertNotReleased(): void {
  assert.equal(
    releaseCalls().length, 0,
    `the charge must stand; saw ${JSON.stringify(releaseCalls().map(c => c.args.p_reason))}`,
  );
}

(async () => {
  console.log("=== cron/publish-due — refund mapping (route-level, no database) ===\n");

  const mod = await import("../src/app/api/cron/publish-due/route");
  const { GET } = mod as { GET: (r: Request) => Promise<Response> };
  const { deriveScheduledPostKey } = await import("../src/lib/server/usage/meterScheduledPost");
  const { PinterestApiError, NotConnectedError, NeedsReconnectError, PinterestTrialAccessError } =
    await import("../src/lib/server/pinterest/service");

  const KEY = deriveScheduledPostKey(OWNER, DRAFT, DUE_AT);

  await test("sent: a published row is CHARGED and never refunded", async () => {
    const res = await GET(cronReq());
    const body = await res.json() as { published: number };
    assert.equal(body.published, 1);
    assert.equal(consumeCalls().length, 1, "one charge for the row");
    assert.equal(consumeCalls()[0].args.p_idempotency_key, KEY, "keyed on (draft, scheduled_at)");
    assertNotReleased();
  });

  await test("not_sent: a typed publishPinForUser failure REFUNDS the exact key charged", async () => {
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found", code: "board_not_owned", status: 403,
    });
    await GET(cronReq());
    assertReleased("not_sent", KEY);
  });

  await test("not_sent: a thrown NotConnectedError REFUNDS — its 409 is OUR status, not a provider's", async () => {
    publishPinBehaviour = async () => { throw new NotConnectedError(); };
    await GET(cronReq());
    assertReleased("not_sent", KEY);
  });

  await test("not_sent: a thrown NeedsReconnectError REFUNDS", async () => {
    publishPinBehaviour = async () => { throw new NeedsReconnectError(); };
    await GET(cronReq());
    assertReleased("not_sent", KEY);
  });

  await test("rejected: a Pinterest 4xx with a real providerStatus and no pin id REFUNDS", async () => {
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("Insufficient scope", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      (e as unknown as { providerResourceId: string | null }).providerResourceId = null;
      throw e;
    };
    await GET(cronReq());
    assertReleased("rejected", KEY);
  });

  await test("delivery_unknown: a 5xx KEEPS the charge", async () => {
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("upstream down", 503, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 503;
      throw e;
    };
    await GET(cronReq());
    assertNotReleased();
  });

  await test("delivery_unknown: providerStatus MISSING → NO refund (the two-field rule)", async () => {
    publishPinBehaviour = async () => { throw new Error("socket hang up"); };
    await GET(cronReq());
    assertNotReleased();
  });

  await test("sent: a thrown error carrying a pin id KEEPS the charge", async () => {
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("odd", 400, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 400;
      (e as unknown as { providerResourceId: string }).providerResourceId = "pin-created";
      throw e;
    };
    await GET(cronReq());
    assertNotReleased();
  });

  await test("trial access: NEVER refunded — the row keeps its schedule and is re-charged under the same key", async () => {
    publishPinBehaviour = async () => { throw new PinterestTrialAccessError(); };
    const res = await GET(cronReq());
    const body = await res.json() as { skipped: number };
    assert.equal(body.skipped, 1, "trial access is a skip, not a failure");
    assertNotReleased();
  });

  await test("MULTI-DESTINATION: one Pinterest account published, another rejected → NO refund", async () => {
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
        { provider: "pinterest", socialConnectionId: "conn-pin-2", boardId: "b2", capturedAt: DUE_AT },
      ],
    };
    let call = 0;
    publishPinBehaviour = async () => {
      call++;
      if (call === 1) {
        return { ok: true, pin: { id: "p1", url: "u" }, board: { id: "b1", name: "B" }, environment: "production", connectionId: "conn-pin-1" };
      }
      const e = new PinterestApiError("no", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      throw e;
    };
    await GET(cronReq());
    assert.equal(publishPinCalls, 2, "both accounts attempted");
    assertNotReleased();
  });

  await test("MULTI-DESTINATION: BOTH Pinterest accounts rejected → exactly ONE refund for the Content", async () => {
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
        { provider: "pinterest", socialConnectionId: "conn-pin-2", boardId: "b2", capturedAt: DUE_AT },
      ],
    };
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("no", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      throw e;
    };
    await GET(cronReq());
    assert.equal(publishPinCalls, 2);
    assertReleased("rejected", KEY);
  });

  await test("FAN-OUT: Pinterest rejected but a social target published → NO refund (any sent wins)", async () => {
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
        { provider: "facebook", socialConnectionId: "conn-fb-1", capturedAt: DUE_AT },
      ],
    };
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("no", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      throw e;
    };
    fanOutBehaviour = async () => [
      { provider: "facebook", status: "published", socialConnectionId: "conn-fb-1", externalPostId: "fb-1" },
    ];
    await GET(cronReq());
    assertNotReleased();
  });

  await test("FAN-OUT: Pinterest rejected AND the social target rejected → ONE refund", async () => {
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
        { provider: "facebook", socialConnectionId: "conn-fb-1", capturedAt: DUE_AT },
      ],
    };
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("no", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      throw e;
    };
    fanOutBehaviour = async () => [
      { provider: "facebook", status: "failed", socialConnectionId: "conn-fb-1", providerStatus: 400, providerResourceId: null },
    ];
    await GET(cronReq());
    assertReleased("rejected", KEY);
  });

  await test("FAN-OUT: a social failure with NO providerStatus makes the whole row delivery_unknown → NO refund", async () => {
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
        { provider: "facebook", socialConnectionId: "conn-fb-1", capturedAt: DUE_AT },
      ],
    };
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("no", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      throw e;
    };
    fanOutBehaviour = async () => [
      { provider: "facebook", status: "failed", socialConnectionId: "conn-fb-1" },
    ];
    await GET(cronReq());
    assertNotReleased();
  });

  await test("FAN-OUT: a `skipped` social row is not an attempt and does not affect the decision", async () => {
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
        { provider: "facebook", socialConnectionId: "conn-fb-1", capturedAt: DUE_AT },
      ],
    };
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("no", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      throw e;
    };
    fanOutBehaviour = async () => [
      { provider: "facebook", status: "skipped", socialConnectionId: null, error: "coming soon" },
    ];
    await GET(cronReq());
    // Pinterest rejected, the social row is a skip → the aggregate is `rejected`.
    assertReleased("rejected", KEY);
  });

  await test("unpublishable payload: no charge happens, so no refund is attempted", async () => {
    duePayload = { }; // no board, no image → payloadToPublishInput returns null
    await GET(cronReq());
    assert.equal(consumeCalls().length, 0, "the contract charges only rows that attempt delivery");
    assertNotReleased();
  });

  await test("nothing owed (every destination already published) → NO refund", async () => {
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
      ],
      destinationResults: [
        { provider: "pinterest", status: "published", socialConnectionId: "conn-pin-1" },
      ],
    };
    await GET(cronReq());
    assert.equal(publishPinCalls, 0, "nothing was owed");
    assertNotReleased();
  });

  await test("a failed refund never breaks the run (fail-open)", async () => {
    rpcBehaviour = (fn) => fn === "usage_release_scheduled_post"
      ? { data: null, error: { message: "simulated ledger outage" } }
      : { data: { ok: true, replayed: false }, error: null };
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found", code: "board_not_owned", status: 403,
    });
    const res = await GET(cronReq());
    assert.equal(res.status, 200, "an accounting outage must never crash the batch");
  });

  // ── A.4.0 blocking site ───────────────────────────────────────────────────────

  await test("BLOCKED: enforce + flag + insufficient → row marked failed, Pinterest NEVER called, nothing refunded", async () => {
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    const res = await GET(cronReq());
    const body = await res.json() as { failed: number; published: number };
    assert.equal(publishPinCalls, 0, "a refused row must never reach Pinterest");
    assert.equal(body.failed, 1);
    assert.equal(body.published, 0);
    // Nothing was charged (the consume was REFUSED), so nothing may be given back.
    assertNotReleased();
  });

  await test("BLOCKED: `scheduled_at` is CLEARED so the row cannot re-fail every five minutes", async () => {
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    await GET(cronReq());
    // updates[0] is the claim (publish_claimed_at); the persist is the one that
    // carries the payload AND clears the schedule.
    const persist = updates.find(u => "payload" in u);
    assert.ok(persist, `expected a persist UPDATE, saw ${JSON.stringify(updates)}`);
    assert.equal(persist!.scheduled_at, null, "the row must leave the due scan — no retry storm");
    assert.equal(persist!.publish_claimed_at, null, "the claim must be released too");
    const payload = persist!.payload as Record<string, unknown>;
    assert.ok(
      JSON.stringify(payload).includes("scheduled_post_limit_reached"),
      `the failure must name the limit, saw ${JSON.stringify(payload).slice(0, 300)}`,
    );
  });

  await test("BLOCKED: both the short and the real RPC refusal strings trigger the gate", async () => {
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    for (const reason of ["insufficient", "insufficient_capacity"]) {
      publishPinCalls = 0;
      rpcBehaviour = () => ({ data: { ok: false, reason }, error: null });
      await GET(cronReq());
      assert.equal(publishPinCalls, 0, `reason "${reason}" must block before the provider call`);
    }
  });

  await test("SHADOW: insufficient does NOT block — the row still publishes", async () => {
    process.env.USAGE_METERING_MODE = "shadow";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    const res = await GET(cronReq());
    const body = await res.json() as { published: number };
    assert.equal(body.published, 1, "shadow observes, never blocks");
    assert.equal(publishPinCalls, 1);
  });

  await test("ENFORCE but flag OFF: insufficient does NOT block (per-type rollout)", async () => {
    process.env.USAGE_METERING_MODE = "enforce";
    delete process.env.USAGE_ENFORCE_SCHEDULED_POSTS;
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    await GET(cronReq());
    assert.equal(publishPinCalls, 1, "the global mode alone must block nothing");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // ONLY A FRESH CONSUME MAY BE RELEASED (Codex round 7, High 1 + High 2)
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // `usage_release_scheduled_post` takes only (user, K, reason): it refunds the key
  // family's standing consume regardless of WHICH attempt asks. This route's key is
  // (draft_id, scheduled_at), and a re-claim of an unfinished publish derives the
  // IDENTICAL key on purpose — that collapsing is what stops the at-least-once
  // publisher double-charging. Which means a re-claim whose consume merely REPLAYED
  // must not release: the unit belongs to the attempt that charged it, and that
  // attempt may well have delivered.
  //
  // The ledger fake here is deliberately minimal — the cron route runs ONE row per
  // request, so "was this row's own consume fresh?" is a single boolean, and driving
  // it directly is both sufficient and unambiguous.

  await test("fresh gate: a REPLAYED consume never releases, even on a refundable failure", async () => {
    // The re-claim case. A previous attempt charged K; this one lands on the same key
    // and the ledger reports replayed. Its own failure is refundable-looking, but the
    // unit is not this attempt's to give back.
    rpcBehaviour = (fn) => fn === "usage_consume_scheduled_post"
      ? { data: { ok: true, replayed: true }, error: null }
      : { data: { ok: true, replayed: false }, error: null };
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found", code: "board_not_owned", status: 403,
    });
    await GET(cronReq());
    assert.equal(consumeCalls().length, 1, "the row still tried to charge");
    assertNotReleased();
  });

  await test("fresh gate: a REPLAYED consume never releases a `rejected` provider failure either", async () => {
    rpcBehaviour = (fn) => fn === "usage_consume_scheduled_post"
      ? { data: { ok: true, replayed: true }, error: null }
      : { data: { ok: true, replayed: false }, error: null };
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("Insufficient scope", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      (e as unknown as { providerResourceId: string | null }).providerResourceId = null;
      throw e;
    };
    await GET(cronReq());
    assertNotReleased();
  });

  await test("fresh gate: a REPLAYED consume never releases from the OUTER catch either", async () => {
    // The row-level throw path has its own settleMetering() call site; the gate has to
    // hold there too, not just after the per-destination loop.
    rpcBehaviour = (fn) => fn === "usage_consume_scheduled_post"
      ? { data: { ok: true, replayed: true }, error: null }
      : { data: { ok: true, replayed: false }, error: null };
    publishPinBehaviour = async () => { throw new NotConnectedError(); };
    await GET(cronReq());
    assertNotReleased();
  });

  await test("fresh gate: a consume on a RE-ARMED key (K:r1 after a refund) IS fresh and DOES release", async () => {
    // The gate must not degrade into "never refund on a retry". v67 re-arms a refunded
    // family, so the next consume really charges again — and its own failure really is
    // refundable. `replayed:false` is exactly that signal, whichever arm it landed on.
    rpcBehaviour = (fn) => fn === "usage_consume_scheduled_post"
      ? { data: { ok: true, replayed: false, scheduled_posts_used: 1 }, error: null }
      : { data: { ok: true, replayed: false }, error: null };
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found", code: "board_not_owned", status: 403,
    });
    await GET(cronReq());
    assertReleased("not_sent", KEY);
  });

  await test("fresh gate: an `insufficient` consume in SHADOW never releases (it charged nothing)", async () => {
    // Shadow does not block, so the row still publishes and can fail refundably.
    // Releasing after a refused consume could only hit a PRIOR attempt's charge.
    process.env.USAGE_METERING_MODE = "shadow";
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found", code: "board_not_owned", status: 403,
    });
    await GET(cronReq());
    assertNotReleased();
  });

  await test("fresh gate: a consume that ERRORED never releases", async () => {
    rpcBehaviour = (fn) => fn === "usage_consume_scheduled_post"
      ? { data: null, error: { message: "simulated ledger outage" } }
      : { data: { ok: true, replayed: false }, error: null };
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found", code: "board_not_owned", status: 403,
    });
    const res = await GET(cronReq());
    const body = await res.json() as { failed: number };
    assert.equal(body.failed, 1, "fail-open: the row still fails normally");
    assertNotReleased();
  });

  // ── Provider-internal pre-network failures reach this route through the fan-out ─
  await test("medium: a fan-out destination flagged preNetwork → not_sent → REFUND", async () => {
    // dispatchDestination copies PublishResult.preNetwork onto the DestinationOutcome
    // and this route reads it (`f.preNetwork`). A credential/media refusal inside
    // official.ts therefore refunds here too, instead of being charged as a timeout.
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found", code: "board_not_owned", status: 403,
    });
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
        { provider: "facebook", socialConnectionId: "conn-fb-1", capturedAt: DUE_AT },
      ],
    };
    fanOutBehaviour = async () => [{
      provider: "facebook",
      status: "failed",
      socialConnectionId: "conn-fb-1",
      error: "Connect a Facebook Page first.",
      providerStatus: null,
      providerResourceId: null,
      preNetwork: true,
    }];
    await GET(cronReq());
    // Pinterest not_sent + Facebook not_sent → one refund for the Content.
    assertReleased("not_sent", KEY);
  });

  await test("medium: a fan-out destination with NO status and NO preNetwork stays delivery_unknown", async () => {
    // The conservative side of the same rule: an unflagged, statusless failure could be
    // a timeout, and the product charges for those.
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found", code: "board_not_owned", status: 403,
    });
    duePayload = {
      boardId: "b1",
      imageUrl: "https://example.com/a.png",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1", boardId: "b1", capturedAt: DUE_AT },
        { provider: "facebook", socialConnectionId: "conn-fb-1", capturedAt: DUE_AT },
      ],
    };
    fanOutBehaviour = async () => [{
      provider: "facebook",
      status: "failed",
      socialConnectionId: "conn-fb-1",
      error: "something went wrong",
      providerStatus: null,
      providerResourceId: null,
    }];
    await GET(cronReq());
    assertNotReleased();
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
