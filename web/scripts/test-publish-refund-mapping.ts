/**
 * test-publish-refund-mapping.ts — the four-state delivery mapping, per route.
 *
 * The product rule (PRD v3.2 §5.3/§5.4, decisions #4 and #8) says WHICH publish
 * failures give the scheduled-post unit back. This file is the evidence that each
 * of the three publishing routes actually implements it — one assertion per cell of
 * the design's §A.4 table, against the REAL route modules with only their
 * Supabase/auth/provider boundary faked.
 *
 *                    not_sent   rejected   sent      delivery_unknown
 *                    REFUND     REFUND     charge    charge
 *   /api/pinterest/pins   ✓         ✓        ✓            ✓
 *   /api/publish/social   ✓         ✓        ✓            ✓
 *   cron/publish-due      — (its per-destination classification is covered by
 *                            aggregateDelivery/classifyDelivery unit cells below,
 *                            plus its own end-to-end suite; see the note there)
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM THE DB SUITE: test-db-post-release.ts proves
 * the ledger arithmetic (a refund decrements once, a re-publish charges again). It
 * says nothing about WHEN a refund is asked for. That decision lives in the routes,
 * and getting it wrong in either direction is expensive — refunding a `sent` publish
 * gives away inventory, refunding a `delivery_unknown` ships a free-publish bypass,
 * and failing to refund a `not_sent` charges for something that never happened.
 *
 * THE ASSERTION THAT MATTERS MOST is "providerStatus missing → NO release". Every
 * pre-v67 error object lacked that field, and a mapping that fell back to reading
 * message text would classify those as rejections and refund them. The classifier
 * reads exactly two fields; this suite proves the absence of them keeps the charge.
 *
 * Touches no database: every client in the request path is faked here. Every
 * Module._load fake exports EVERY member the real code imports from that module —
 * a partial fake is a latent trap (ce81e826 / de18934b): the next import a route
 * adds resolves to `undefined(...)`, a synchronous TypeError thrown before any
 * assertion is reached.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_METERING_MODE = "shadow";
process.env.USAGE_REQUEST_KEY_SALT = "test-salt";

import assert from "node:assert";
import Module from "node:module";

const OWNER = "user-refund-map-1";
let passed = 0, failed = 0;

type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
let rpcBehaviour: (fn: string, args: Record<string, unknown>) => RpcResult = () => ({
  data: { ok: true, replayed: false },
  error: null,
});

/** publishPinForUser's stand-in — mutated per test to produce each mapping cell. */
let publishPinBehaviour: () => Promise<unknown> = async () => ({
  ok: true,
  pin: { id: "p1", url: "https://pin/1" },
  board: { id: "b", name: "Board" },
  environment: "sandbox",
});

/** The social provider's publishPost stand-in — same idea, for the social route. */
let socialPublishBehaviour: () => Promise<unknown> = async () => ({
  ok: true,
  status: "published",
  externalPostId: "fb-1",
  externalPostUrl: "https://facebook/1",
});

/** Records whether a provider was reached at all — the blocking-site tests assert on this. */
let providerCallCount = 0;

function fakeSupabaseClient() {
  const missing = { code: "42P01", message: "relation does not exist (test fake)" };
  function builder(): Record<string, unknown> {
    const b: Record<string, unknown> = {
      select: () => b,
      insert: () => b,
      update: () => b,
      delete: () => b,
      eq: () => b,
      order: () => b,
      single: async () => ({ data: null, error: missing }),
      maybeSingle: async () => ({ data: null, error: missing }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: missing }).then(resolve, reject),
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

/** A connected Facebook account, so the social route reaches its provider dispatch. */
const CONNECTED_FB = {
  id: "conn-fb-1",
  provider: "facebook",
  authProvider: "official",
  connectionStatus: "connected",
  accountName: "Test Page",
};

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: unknown, isMain: boolean,
) {
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase")) {
    return { createServerClient: fakeSupabaseClient, createClient: fakeSupabaseClient };
  }
  if (request === "@/lib/server/authUser" || request.endsWith("/lib/server/authUser")) {
    return {
      getUserIdFromBearer: async () => OWNER,
      getUserIdFromCookies: async () => null,
      getUserIdFromBearerOrCookies: async () => OWNER,
    };
  }
  if (request === "@/lib/server/pinterest/publishPin" || request.endsWith("/lib/server/pinterest/publishPin")) {
    return {
      publishPinForUser: async () => {
        providerCallCount++;
        return publishPinBehaviour();
      },
    };
  }
  if (request === "@/lib/server/pinterest/connectionStore" || request.endsWith("/lib/server/pinterest/connectionStore")) {
    return { listActiveConnections: async () => [], toSafeStatus: (r: unknown) => r };
  }
  if (request === "./ensureAccount" || request.endsWith("/usage/ensureAccount")) {
    return { ensureUsageAccount: async () => ({ ok: true, action: "noop" }) };
  }
  // The social route resolves destinations through this store. Faked to ONE connected
  // Facebook account so the dispatch loop is reachable and every mapping cell can be
  // driven from `socialPublishBehaviour` below.
  if (request === "@/lib/social/server/socialConnectionStore" || request.endsWith("/social/server/socialConnectionStore")) {
    return {
      findConnection: async () => CONNECTED_FB,
      summarizeConnections: async () => [
        { provider: "facebook", accounts: [CONNECTED_FB] },
      ],
    };
  }
  // The provider registry — the ONLY place a real network call could originate.
  if (request === "@/lib/social/providers" || request.endsWith("/social/providers")) {
    return {
      getSocialProviderById: () => ({
        id: "official",
        async publishPost() {
          providerCallCount++;
          return socialPublishBehaviour();
        },
        async getConnectUrl() { return { url: null, status: "coming_soon" }; },
        async getConnections() { return []; },
        async disconnect() {},
      }),
    };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

async function test(name: string, fn: () => Promise<void>) {
  rpcCalls.length = 0;
  providerCallCount = 0;
  rpcBehaviour = () => ({ data: { ok: true, replayed: false }, error: null });
  publishPinBehaviour = async () => ({
    ok: true,
    pin: { id: "p1", url: "https://pin/1" },
    board: { id: "b", name: "Board" },
    environment: "sandbox",
  });
  socialPublishBehaviour = async () => ({
    ok: true, status: "published", externalPostId: "fb-1", externalPostUrl: "https://facebook/1",
  });
  process.env.USAGE_METERING_MODE = "shadow";
  delete process.env.USAGE_ENFORCE_SCHEDULED_POSTS;
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function req(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function consumeCalls(): RpcCall[] {
  return rpcCalls.filter(c => c.fn === "usage_consume_scheduled_post");
}
function releaseCalls(): RpcCall[] {
  return rpcCalls.filter(c => c.fn === "usage_release_scheduled_post");
}

/** Assert the route asked for exactly one refund, with this reason and this key. */
function assertReleased(reason: "not_sent" | "rejected", key: string): void {
  const calls = releaseCalls();
  assert.equal(calls.length, 1, `expected exactly one release, saw ${calls.length}`);
  assert.equal(calls[0].args.p_reason, reason, "the refund reason must match the mapped state");
  assert.equal(
    calls[0].args.p_idempotency_key, key,
    "the refund MUST release the exact key the consume charged — never a re-derived one",
  );
}

function assertNotReleased(): void {
  assert.equal(
    releaseCalls().length, 0,
    `the charge must stand for this state; saw ${JSON.stringify(releaseCalls().map(c => c.args.p_reason))}`,
  );
}

(async () => {
  console.log("=== publish refund mapping — the four delivery states, per route ===\n");

  const pinsMod = await import("../src/app/api/pinterest/pins/route");
  const { POST: pinsPOST } = pinsMod as { POST: (r: Request) => Promise<Response> };
  const socialMod = await import("../src/app/api/publish/social/route");
  const { POST: socialPOST } = socialMod as { POST: (r: Request) => Promise<Response> };
  const { deriveScheduledPostKey } = await import("../src/lib/server/usage/meterScheduledPost");
  const { classifyDelivery, aggregateDelivery, readProviderSignal, isRefundable } =
    await import("../src/lib/server/usage/deliveryOutcome");
  const { PinterestApiError, NotConnectedError, NeedsReconnectError, PinterestTrialAccessError } =
    await import("../src/lib/server/pinterest/service");

  // ══════════════════════════════════════════════════════════════════════════════
  // THE CLASSIFIER ITSELF — the rule all three routes share
  // ══════════════════════════════════════════════════════════════════════════════

  await test("classifier: preNetwork → not_sent, whatever else is present", async () => {
    assert.equal(classifyDelivery({ preNetwork: true }), "not_sent");
    // Even a status that would otherwise read as a rejection must not override it:
    // our own connection errors carry HTTP statuses WE chose, not the provider's.
    assert.equal(classifyDelivery({ preNetwork: true, providerStatus: 403 }), "not_sent");
  });

  await test("classifier: provider 4xx with no resource id → rejected (the refundable provider state)", async () => {
    for (const status of [400, 401, 403, 404, 422, 429, 499]) {
      assert.equal(classifyDelivery({ providerStatus: status }), "rejected", `status ${status}`);
    }
  });

  await test("classifier: a resource id makes it `sent` even alongside an error status", async () => {
    assert.equal(classifyDelivery({ providerStatus: 400, providerResourceId: "pin-1" }), "sent");
    assert.equal(classifyDelivery({ ok: true }), "sent");
    assert.equal(classifyDelivery({ providerStatus: 201 }), "sent");
  });

  await test("classifier: NO status at all → delivery_unknown (the charge stands)", async () => {
    assert.equal(classifyDelivery({}), "delivery_unknown");
    assert.equal(classifyDelivery({ providerStatus: null }), "delivery_unknown");
    assert.equal(classifyDelivery({ providerStatus: undefined }), "delivery_unknown");
  });

  await test("classifier: 5xx → delivery_unknown, never rejected", async () => {
    for (const status of [500, 502, 503, 504]) {
      assert.equal(classifyDelivery({ providerStatus: status }), "delivery_unknown", `status ${status}`);
    }
  });

  await test("classifier: only not_sent and rejected are refundable", async () => {
    assert.equal(isRefundable("not_sent"), true);
    assert.equal(isRefundable("rejected"), true);
    assert.equal(isRefundable("sent"), false);
    assert.equal(isRefundable("delivery_unknown"), false);
  });

  await test("readProviderSignal ignores anything that is not a real number / non-empty string", async () => {
    assert.deepEqual(readProviderSignal({ providerStatus: "403", providerResourceId: "  " }),
      { providerStatus: null, providerResourceId: null });
    assert.deepEqual(readProviderSignal(new Error("boom")),
      { providerStatus: null, providerResourceId: null });
    assert.deepEqual(readProviderSignal(null), { providerStatus: null, providerResourceId: null });
    assert.deepEqual(readProviderSignal({ providerStatus: 404, providerResourceId: "x" }),
      { providerStatus: 404, providerResourceId: "x" });
  });

  // ── Multi-target aggregation: the cron and social fan-out rule ────────────────
  await test("aggregate: ANY sent wins — a partial success is never refunded", async () => {
    assert.equal(aggregateDelivery(["sent", "not_sent", "rejected"]), "sent");
    assert.equal(aggregateDelivery(["rejected", "sent"]), "sent");
  });

  await test("aggregate: no sent but any unknown → delivery_unknown (charge stands)", async () => {
    assert.equal(aggregateDelivery(["not_sent", "delivery_unknown"]), "delivery_unknown");
    assert.equal(aggregateDelivery(["rejected", "delivery_unknown"]), "delivery_unknown");
  });

  await test("aggregate: all refundable → refund once, `rejected` preferred over `not_sent`", async () => {
    assert.equal(aggregateDelivery(["not_sent", "rejected"]), "rejected");
    assert.equal(aggregateDelivery(["not_sent", "not_sent"]), "not_sent");
    assert.equal(aggregateDelivery(["rejected"]), "rejected");
  });

  await test("aggregate: NOTHING attempted → delivery_unknown, never a refund", async () => {
    // The cron path reaches this when every destination had already published on an
    // earlier attempt. Refunding there gives back a unit for a Content that is live.
    assert.equal(aggregateDelivery([]), "delivery_unknown");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // /api/pinterest/pins — one assertion per cell
  // ══════════════════════════════════════════════════════════════════════════════

  await test("pins / sent: a successful publish is CHARGED and never refunded", async () => {
    const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_sent" }));
    assert.equal(res.status, 201);
    assert.equal(consumeCalls().length, 1, "one charge");
    assertNotReleased();
  });

  await test("pins / not_sent: a typed validation failure REFUNDS, keyed exactly as charged", async () => {
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "boardId is required", code: "bad_request", status: 400,
    });
    const draftId = "pd_typed_fail";
    const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId }));
    assert.equal(res.status, 400);
    assertReleased("not_sent", deriveScheduledPostKey(OWNER, draftId));
  });

  await test("pins / not_sent: board_not_owned REFUNDS (Pinterest refused it and created nothing)", async () => {
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "Board not found on the connected Pinterest account",
      code: "board_not_owned", status: 403,
    });
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_bno" }));
    assertReleased("not_sent", deriveScheduledPostKey(OWNER, "pd_bno"));
  });

  await test("pins / not_sent: EVERY carousel_* typed code refunds (the whole validation union)", async () => {
    for (const code of ["invalid_image_url", "invalid_link", "carousel_too_few", "carousel_too_many", "carousel_aspect_mismatch"]) {
      rpcCalls.length = 0;
      publishPinBehaviour = async () => ({ ok: false, kind: "validation", error: code, code, status: 422 });
      await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: `pd_${code}` }));
      assertReleased("not_sent", deriveScheduledPostKey(OWNER, `pd_${code}`));
    }
  });

  await test("pins / not_sent: a thrown NotConnectedError refunds — and is NOT read as a provider 409", async () => {
    // NotConnectedError carries status 409 because that is what WE answer the client.
    // No provider ever sent it. Classifying by class first is what keeps this a
    // not_sent (correct: the request never left us) instead of a provider rejection
    // that happens to land on the same answer for the wrong reason.
    publishPinBehaviour = async () => { throw new NotConnectedError(); };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_notconn" }));
    assertReleased("not_sent", deriveScheduledPostKey(OWNER, "pd_notconn"));
  });

  await test("pins / not_sent: a thrown NeedsReconnectError refunds", async () => {
    publishPinBehaviour = async () => { throw new NeedsReconnectError(); };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_reconn" }));
    assertReleased("not_sent", deriveScheduledPostKey(OWNER, "pd_reconn"));
  });

  await test("pins / rejected: a Pinterest 4xx carrying a real providerStatus and no pin id REFUNDS", async () => {
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("Insufficient scope", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      (e as unknown as { providerResourceId: string | null }).providerResourceId = null;
      throw e;
    };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_403" }));
    assertReleased("rejected", deriveScheduledPostKey(OWNER, "pd_403"));
  });

  await test("pins / sent: a 4xx that nonetheless returned a pin id KEEPS the charge", async () => {
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("Odd", 400, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 400;
      (e as unknown as { providerResourceId: string }).providerResourceId = "pin-created-anyway";
      throw e;
    };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_odd" }));
    assertNotReleased();
  });

  await test("pins / delivery_unknown: a 5xx KEEPS the charge", async () => {
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("Pinterest is down", 503, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 503;
      throw e;
    };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_503" }));
    assertNotReleased();
  });

  await test("pins / delivery_unknown: providerStatus MISSING → NO refund (the two-field rule)", async () => {
    // THE assertion this suite exists for. A plain Error carries no provider fields.
    // A mapping that fell back to message text would have to guess, and guessing
    // toward "rejected" refunds every timeout — a documented free-publish bypass.
    publishPinBehaviour = async () => { throw new Error("socket hang up"); };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_nostatus" }));
    assertNotReleased();
  });

  await test("pins / delivery_unknown: a PinterestApiError with NO providerStatus set still keeps the charge", async () => {
    // Our own 502 "Pinterest did not return a Pin id" is built without a providerStatus
    // precisely because no provider response produced it.
    publishPinBehaviour = async () => { throw new PinterestApiError("Pinterest did not return a Pin id", 502); };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_noid" }));
    assertNotReleased();
  });

  await test("pins: PinterestTrialAccessError is NEVER refunded (the row is retried under the same key)", async () => {
    publishPinBehaviour = async () => { throw new PinterestTrialAccessError(); };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_trial" }));
    assertNotReleased();
  });

  await test("pins: no draft identity → no charge, and therefore no refund either", async () => {
    publishPinBehaviour = async () => { throw new Error("boom"); };
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png" }));
    assert.equal(consumeCalls().length, 0);
    assertNotReleased();
  });

  await test("pins: a failed refund NEVER changes the response (fail-open)", async () => {
    rpcBehaviour = (fn) => fn === "usage_release_scheduled_post"
      ? { data: null, error: { message: "simulated ledger outage" } }
      : { data: { ok: true, replayed: false }, error: null };
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "boardId is required", code: "bad_request", status: 400,
    });
    const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_failopen" }));
    assert.equal(res.status, 400, "the publish failure, not a 500 from the accounting overlay");
  });

  // ── A.4.0 blocking site ───────────────────────────────────────────────────────

  await test("pins / BLOCKED: enforce + flag + insufficient → 402, NO provider call, NO refund", async () => {
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_blocked" }));
    assert.equal(res.status, 402, "a limit refusal is 402, like the image/text limits");
    const body = await res.json() as { code?: string };
    assert.equal(body.code, "scheduled_post_limit_reached");
    assert.equal(providerCallCount, 0, "a refused publish must never reach Pinterest");
    assertNotReleased();
  });

  await test("pins / BLOCKED: the real RPC's `insufficient_capacity` string is what triggers the gate", async () => {
    // The fakes historically said "insufficient"; v55 says "insufficient_capacity".
    // Both must reach the same gate, or the limit is green in tests and open in prod.
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    for (const reason of ["insufficient", "insufficient_capacity"]) {
      rpcCalls.length = 0; providerCallCount = 0;
      rpcBehaviour = () => ({ data: { ok: false, reason }, error: null });
      const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: `pd_b_${reason}` }));
      assert.equal(res.status, 402, `reason "${reason}" must block`);
      assert.equal(providerCallCount, 0, `reason "${reason}" must not reach the provider`);
    }
  });

  await test("pins / SHADOW: insufficient does NOT block — the publish still happens", async () => {
    process.env.USAGE_METERING_MODE = "shadow";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true"; // flag on, mode shadow → still open
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_shadow" }));
    assert.equal(res.status, 201, "shadow observes, never blocks");
    assert.equal(providerCallCount, 1);
  });

  await test("pins / ENFORCE but flag OFF: insufficient does NOT block (per-type rollout)", async () => {
    process.env.USAGE_METERING_MODE = "enforce";
    delete process.env.USAGE_ENFORCE_SCHEDULED_POSTS;
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_flagoff" }));
    assert.equal(res.status, 201, "the global mode alone must block nothing");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // /api/publish/social — one assertion per cell
  // ══════════════════════════════════════════════════════════════════════════════

  function socialReq(postId: string) {
    return req({
      postId,
      post: { imageUrls: ["https://example.com/img.png"], title: "t", caption: "c" },
      destinations: [{ provider: "facebook", socialConnectionId: "conn-fb-1" }],
    });
  }

  await test("social / sent: a published destination is CHARGED, never refunded", async () => {
    const res = await socialPOST(socialReq("pd_s_ok"));
    assert.equal(res.status, 200);
    assert.equal(consumeCalls().length, 1);
    assertNotReleased();
  });

  await test("social / rejected: a platform 4xx with no post id REFUNDS", async () => {
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Graph said no", providerStatus: 400, providerResourceId: null,
    });
    await socialPOST(socialReq("pd_s_400"));
    assertReleased("rejected", deriveScheduledPostKey(OWNER, "pd_s_400"));
  });

  await test("social / not_sent: `not_implemented` refunds (it never reached a platform)", async () => {
    socialPublishBehaviour = async () => ({ ok: false, status: "not_implemented", error: "coming soon" });
    await socialPOST(socialReq("pd_s_notimpl"));
    assertReleased("not_sent", deriveScheduledPostKey(OWNER, "pd_s_notimpl"));
  });

  await test("social / delivery_unknown: a 5xx KEEPS the charge", async () => {
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Graph is down", providerStatus: 503, providerResourceId: null,
    });
    await socialPOST(socialReq("pd_s_503"));
    assertNotReleased();
  });

  await test("social / delivery_unknown: providerStatus MISSING → NO refund", async () => {
    // e.g. getSelectedPageToken returned null ("Connect a Facebook Page first"): a
    // typed failure with no observed platform status. Under the two-field rule that
    // is delivery_unknown and the charge stands — deliberately conservative, and
    // recorded rather than message-sniffed around.
    socialPublishBehaviour = async () => ({ ok: false, status: "failed", error: "Connect a Facebook Page first." });
    await socialPOST(socialReq("pd_s_nostatus"));
    assertNotReleased();
  });

  await test("social / delivery_unknown: a THROWN provider with no fields keeps the charge", async () => {
    socialPublishBehaviour = async () => { throw new Error("socket hang up"); };
    await socialPOST(socialReq("pd_s_throw"));
    assertNotReleased();
  });

  await test("social / rejected: a THROWN error CARRYING providerStatus 4xx refunds", async () => {
    socialPublishBehaviour = async () => {
      const e = new Error("rejected upstream") as Error & { providerStatus: number };
      e.providerStatus = 422;
      throw e;
    };
    await socialPOST(socialReq("pd_s_throw422"));
    assertReleased("rejected", deriveScheduledPostKey(OWNER, "pd_s_throw422"));
  });

  await test("social / sent: a failure carrying a post id KEEPS the charge", async () => {
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "partial", providerStatus: 400, providerResourceId: "fb-created",
    });
    await socialPOST(socialReq("pd_s_hasid"));
    assertNotReleased();
  });

  await test("social / MULTI-TARGET: one published + one rejected → NO refund (any sent wins)", async () => {
    let call = 0;
    socialPublishBehaviour = async () => {
      call++;
      return call === 1
        ? { ok: true, status: "published", externalPostId: "fb-1" }
        : { ok: false, status: "failed", error: "no", providerStatus: 400, providerResourceId: null };
    };
    await socialPOST(req({
      postId: "pd_s_multi",
      post: { imageUrls: ["https://example.com/img.png"] },
      destinations: [
        { provider: "facebook", socialConnectionId: "conn-fb-1" },
        { provider: "instagram", socialConnectionId: "conn-ig-1" },
      ],
    }));
    assert.equal(providerCallCount, 2, "both targets attempted");
    assertNotReleased();
  });

  await test("social / MULTI-TARGET: BOTH rejected → exactly ONE refund for the Content", async () => {
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "no", providerStatus: 403, providerResourceId: null,
    });
    await socialPOST(req({
      postId: "pd_s_multifail",
      post: { imageUrls: ["https://example.com/img.png"] },
      destinations: [
        { provider: "facebook", socialConnectionId: "conn-fb-1" },
        { provider: "instagram", socialConnectionId: "conn-ig-1" },
      ],
    }));
    assertReleased("rejected", deriveScheduledPostKey(OWNER, "pd_s_multifail"));
  });

  await test("social: a Pinterest-only destination list is all SKIPS → nothing attempted → NO refund", async () => {
    // Pinterest is published by its own route; a skip is not a delivery failure, and
    // counting it as one would refund a Content the pins route published fine.
    await socialPOST(req({
      postId: "pd_s_skiponly",
      post: { imageUrls: ["https://example.com/img.png"] },
      destinations: [{ provider: "pinterest", socialConnectionId: "conn-pin-1" }],
    }));
    assert.equal(providerCallCount, 0);
    assertNotReleased();
  });

  await test("social / BLOCKED: enforce + flag + insufficient → 402, NO provider call, NO refund", async () => {
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    const res = await socialPOST(socialReq("pd_s_blocked"));
    assert.equal(res.status, 402);
    const body = await res.json() as { code?: string };
    assert.equal(body.code, "scheduled_post_limit_reached");
    assert.equal(providerCallCount, 0, "a refused publish must never reach a platform");
    assertNotReleased();
  });

  await test("social / SHADOW: insufficient does NOT block — the publish still happens", async () => {
    process.env.USAGE_METERING_MODE = "shadow";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    const res = await socialPOST(socialReq("pd_s_shadow"));
    assert.equal(res.status, 200);
    assert.equal(providerCallCount, 1);
  });

  await test("social: no postId → no charge and no refund, whatever the destinations do", async () => {
    socialPublishBehaviour = async () => ({ ok: false, status: "failed", error: "no", providerStatus: 400 });
    await socialPOST(req({
      post: { imageUrls: ["https://example.com/img.png"] },
      destinations: [{ provider: "facebook", socialConnectionId: "conn-fb-1" }],
    }));
    assert.equal(consumeCalls().length, 0);
    assertNotReleased();
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
