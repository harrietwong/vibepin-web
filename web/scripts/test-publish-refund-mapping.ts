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
  ledger = { events: new Map(), used: 0 };
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

/**
 * ── A STATEFUL LEDGER, MIRRORING v67's KEY FAMILY ──────────────────────────────
 *
 * The default `rpcBehaviour` above is stateless: every consume answers
 * `replayed:false`. That is fine for single-request cells, and useless for the
 * cross-route cases below, whose entire subject is what happens when a SECOND route
 * lands on a key the FIRST one already charged. Those need the real thing:
 *
 *   consume:  n = number of `K:release:*` events → K_eff = K (n=0) | K:r<n>
 *             K_eff already present → {ok:true, replayed:true}   (charged nothing)
 *             else insert it        → {ok:true, replayed:false}  (charged one unit)
 *   release:  n = number of `K:release:*`; find the standing consume K_eff;
 *             present → write K:release:<n+1>, decrement; absent → nothing_to_release
 *
 * This is a faithful reduction of migrate_v67_scheduled_post_release.sql (minus the
 * locking, which single-threaded tests cannot exercise). Its purpose is to make
 * `replayed` REAL, because `replayed` is what the fresh-consume gate reads — a fake
 * that always says `replayed:false` would report every one of the cases below as
 * passing no matter how the routes were wired.
 */
type FamilyLedger = {
  /** idempotency_key → operation, exactly as usage_events would hold them. */
  events: Map<string, "consume" | "release">;
  /** Net units charged, so a test can assert a refund really gave one back. */
  used: number;
};
let ledger: FamilyLedger = { events: new Map(), used: 0 };

function releasesFor(key: string): number {
  let n = 0;
  for (const k of ledger.events.keys()) if (k.startsWith(`${key}:release:`)) n++;
  return n;
}

function ledgerRpc(fn: string, args: Record<string, unknown>): RpcResult {
  const key = String(args.p_idempotency_key ?? "");
  const n = releasesFor(key);
  const effective = n === 0 ? key : `${key}:r${n}`;
  if (fn === "usage_consume_scheduled_post") {
    if (ledger.events.has(effective)) {
      return { data: { ok: true, replayed: true, scheduled_posts_used: ledger.used }, error: null };
    }
    ledger.events.set(effective, "consume");
    ledger.used += 1;
    return { data: { ok: true, replayed: false, scheduled_posts_used: ledger.used }, error: null };
  }
  if (fn === "usage_release_scheduled_post") {
    if (!ledger.events.has(effective)) {
      // Either nothing was ever charged, or every charge was already given back.
      return n > 0
        ? { data: { ok: true, replayed: true, reason: "already_released" }, error: null }
        : { data: { ok: false, reason: "nothing_to_release" }, error: null };
    }
    ledger.events.set(`${key}:release:${n + 1}`, "release");
    ledger.used = Math.max(0, ledger.used - 1);
    return {
      data: { ok: true, replayed: false, released_consume_key: effective, scheduled_posts_used: ledger.used },
      error: null,
    };
  }
  return { data: { ok: true, replayed: false }, error: null };
}

/** Start a cross-route case: empty ledger, and the RPC fake wired to it. */
function useLedger(): void {
  ledger = { events: new Map(), used: 0 };
  rpcBehaviour = ledgerRpc;
}

/** Every consume key the ledger actually stored an event under, in insertion order. */
function ledgerConsumeKeys(): string[] {
  return [...ledger.events.entries()].filter(([, op]) => op === "consume").map(([k]) => k);
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

  // ══════════════════════════════════════════════════════════════════════════════
  // CROSS-ROUTE: ONLY A FRESH CONSUME MAY BE RELEASED (Codex round 7, High 1 + 2)
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // Every cell above exercises ONE route in isolation, where its consume is always
  // the family's first and therefore always fresh. The bugs live in the seam: the key
  // K is SHARED — /api/pinterest/pins and /api/publish/social derive the same K for
  // one Content, and a same-day retry derives it again — while
  // `usage_release_scheduled_post` takes only (user, K, reason) and refunds the
  // family's standing consume no matter which caller asks. So a route whose consume
  // merely REPLAYED could give back a unit another attempt charged and delivered.
  //
  // These cases run the two REAL routes in sequence against the stateful ledger
  // above, so `replayed` is genuine rather than a hardcoded false. The pins response's
  // meteringBucket/Sig/MintedAt are relayed into the social request exactly as the
  // client does — which both pins the shared key (no dependence on the two calls
  // computing the same UTC day) and exercises the relay path itself.

  /** Run the pins route and hand back the relay triple its response carries. */
  async function pinsThenRelay(draftId: string): Promise<Record<string, unknown>> {
    const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId }));
    const body = await res.json() as Record<string, unknown>;
    return {
      meteringBucket: body.meteringBucket,
      meteringBucketSig: body.meteringBucketSig,
      meteringBucketMintedAt: body.meteringBucketMintedAt,
    };
  }

  function socialReqWithRelay(postId: string, relay: Record<string, unknown>): Request {
    return req({
      postId,
      ...relay,
      post: { imageUrls: ["https://example.com/img.png"], title: "t", caption: "c" },
      destinations: [{ provider: "facebook", socialConnectionId: "conn-fb-1" }],
    });
  }

  await test("(a) HIGH 1 — pins SENT, then social replays the same key and is rejected -> NO release", async () => {
    // The headline bug: Pinterest published the Pin (unit earned), the social fan-out
    // collapsed onto the SAME key as a replay, every social target was rejected, and
    // the old code released K — refunding a Pin that is live on Pinterest.
    useLedger();
    const draftId = "pd_x_sent_then_social";
    const relay = await pinsThenRelay(draftId);
    assert.equal(releaseCalls().length, 0, "a successful Pin is never refunded by its own route");
    const key = deriveScheduledPostKey(OWNER, draftId, undefined, relay.meteringBucket as string);
    assert.deepEqual(ledgerConsumeKeys(), [key], "pins charged the family's first consume");

    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Graph said no", providerStatus: 403, providerResourceId: null,
    });
    await socialPOST(socialReqWithRelay(draftId, relay));

    const shared = consumeCalls().filter(c => c.args.p_idempotency_key === key);
    assert.equal(shared.length, 2, "both routes consumed the SAME key (one charge, one replay)");
    assertNotReleased();
    assert.equal(ledger.used, 1, "the delivered Pin stays charged");
  });

  await test("(b) HIGH 1 — pins DELIVERY_UNKNOWN, then social replays and is rejected -> NO release", async () => {
    // Same shape, worse consequence if it leaked: a timeout is trivially reproducible,
    // so refunding it through the social route would be a repeatable free publish.
    useLedger();
    const draftId = "pd_x_unknown_then_social";
    publishPinBehaviour = async () => { throw new Error("socket hang up"); };
    const relay = await pinsThenRelay(draftId);
    assertNotReleased();

    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Graph said no", providerStatus: 400, providerResourceId: null,
    });
    await socialPOST(socialReqWithRelay(draftId, relay));

    assertNotReleased();
    assert.equal(ledger.used, 1, "delivery_unknown is charged and stays charged");
  });

  await test("(c) pins REJECTED refunds K; social's consume is then FRESH on K:r1 and its rejection refunds that", async () => {
    // The gate must not become "never refund on the second route". When the first
    // route genuinely gave its unit back, the family RE-ARMS: the social consume lands
    // on K:r1 and really does charge, so its own rejection is really refundable.
    // Nothing was delivered anywhere, and the ledger ends at zero.
    useLedger();
    const draftId = "pd_x_rejected_then_social";
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("Insufficient scope", 403, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 403;
      (e as unknown as { providerResourceId: string | null }).providerResourceId = null;
      throw e;
    };
    const relay = await pinsThenRelay(draftId);
    const key = deriveScheduledPostKey(OWNER, draftId, undefined, relay.meteringBucket as string);
    assertReleased("rejected", key);
    assert.equal(ledger.used, 0, "the pins charge was given back");

    rpcCalls.length = 0;
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Graph said no", providerStatus: 422, providerResourceId: null,
    });
    await socialPOST(socialReqWithRelay(draftId, relay));

    assert.deepEqual(
      ledgerConsumeKeys(), [key, `${key}:r1`],
      "the refunded family re-armed: the social consume is a NEW charge, not a replay",
    );
    assertReleased("rejected", key);
    assert.equal(ledger.used, 0, "both attempts refunded — nothing was ever delivered");
  });

  await test("(d) HIGH 2 — same-day retry after a SUCCESS replays the key -> NO release", async () => {
    // The free-publish bypass: publish once successfully (unit earned), then retry the
    // same draft the same day with a deliberately broken destination. The consume
    // replays K, the failure is refundable-looking, and the old code refunded the unit
    // the SUCCESSFUL publish earned. Correctly non-refundable now — see the route
    // comments: a same-day retry after a success is not a residual, it is the rule.
    useLedger();
    const draftId = "pd_x_sameday_retry";
    const relay = await pinsThenRelay(draftId);
    const key = deriveScheduledPostKey(OWNER, draftId, undefined, relay.meteringBucket as string);
    assert.equal(ledger.used, 1, "the successful publish charged one unit");
    assertNotReleased();

    rpcCalls.length = 0;
    // Same day, same draft, same key — but now a typed validation failure (`not_sent`).
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "invalid link", code: "invalid_link", status: 422,
    });
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId }));

    const retryConsume = consumeCalls();
    assert.equal(retryConsume.length, 1, "the retry did try to charge");
    assert.equal(retryConsume[0].args.p_idempotency_key, key, "and derived the SAME key");
    assert.deepEqual(ledgerConsumeKeys(), [key], "which the ledger collapsed into a replay");
    assertNotReleased();
    assert.equal(ledger.used, 1, "the unit the successful publish earned is still charged");
  });

  await test("(e) social-only FRESH consume, rejected -> still refunds (the gate is not a blanket off-switch)", async () => {
    useLedger();
    const postId = "pd_x_socialonly";
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Graph said no", providerStatus: 400, providerResourceId: null,
    });
    await socialPOST(socialReq(postId));
    const key = deriveScheduledPostKey(OWNER, postId);
    assert.deepEqual(ledgerConsumeKeys(), [key], "no pins call — this consume is the family's first");
    assertReleased("rejected", key);
    assert.equal(ledger.used, 0, "refunded");
  });

  await test("gate: an `insufficient` consume in SHADOW never releases (it charged nothing here)", async () => {
    // Shadow does not block, so the route publishes anyway and can fail refundably.
    // Releasing after a refused consume would target a PRIOR attempt's charge.
    process.env.USAGE_METERING_MODE = "shadow";
    rpcBehaviour = () => ({ data: { ok: false, reason: "insufficient_capacity" }, error: null });
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "boardId is required", code: "bad_request", status: 400,
    });
    await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_x_insuff" }));
    assertNotReleased();
  });

  await test("gate: a consume that ERRORED never releases", async () => {
    rpcBehaviour = (fn) => fn === "usage_consume_scheduled_post"
      ? { data: null, error: { message: "simulated ledger outage" } }
      : { data: { ok: true, replayed: false }, error: null };
    publishPinBehaviour = async () => ({
      ok: false, kind: "validation", error: "boardId is required", code: "bad_request", status: 400,
    });
    const res = await pinsPOST(req({ boardId: "b1", imageUrl: "https://example.com/a.png", draftId: "pd_x_cerr" }));
    assert.equal(res.status, 400, "fail-open: the publish failure is still what the client sees");
    assertNotReleased();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // PROVIDER-INTERNAL PRE-NETWORK FAILURES (Codex round 7, Medium)
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // "Connect a Facebook Page first.", missing Instagram credentials, "Instagram posts
  // need an image.", a local media-rule refusal — all decided inside official.ts
  // before any Graph call, all carrying no providerStatus (correctly: no provider
  // answered). "No status observed" is ALSO the signature of a timeout, which the
  // product charges for, so unflagged these were classified `delivery_unknown` and
  // billed a scheduled-post unit for a request that never left our process.
  // `PublishResult.preNetwork` is the disambiguator; these cells prove the routes read
  // it and that it does NOT leak into failures that really did reach the platform.

  await test("medium / preNetwork: a provider credential refusal -> not_sent -> REFUND", async () => {
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Connect a Facebook Page first.", preNetwork: true,
    });
    await socialPOST(socialReq("pd_pn_fbcred"));
    assertReleased("not_sent", deriveScheduledPostKey(OWNER, "pd_pn_fbcred"));
  });

  await test("medium / preNetwork: a local media-rule refusal -> not_sent -> REFUND", async () => {
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Instagram allows at most 10 images.", preNetwork: true,
    });
    await socialPOST(socialReq("pd_pn_media"));
    assertReleased("not_sent", deriveScheduledPostKey(OWNER, "pd_pn_media"));
  });

  await test("medium / preNetwork: missing Instagram image -> not_sent -> REFUND", async () => {
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Instagram posts need an image.", preNetwork: true,
    });
    await socialPOST(socialReq("pd_pn_noimg"));
    assertReleased("not_sent", deriveScheduledPostKey(OWNER, "pd_pn_noimg"));
  });

  await test("medium / preNetwork does NOT override a real platform 4xx: still `rejected`", async () => {
    // Both are refundable, so the reason string is the only observable difference —
    // and it is the audit trail. A provider that answered must never be recorded as
    // "we never sent it".
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Graph said no", providerStatus: 400, providerResourceId: null,
    });
    await socialPOST(socialReq("pd_pn_4xx"));
    assertReleased("rejected", deriveScheduledPostKey(OWNER, "pd_pn_4xx"));
  });

  await test("medium / a real platform 5xx stays delivery_unknown — preNetwork must not reach it", async () => {
    socialPublishBehaviour = async () => ({
      ok: false, status: "failed", error: "Graph is down", providerStatus: 503, providerResourceId: null,
    });
    await socialPOST(socialReq("pd_pn_5xx"));
    assertNotReleased();
  });

  // ── official.ts itself: the branches that must carry the flag ─────────────────
  await test("medium / official.ts: every FB and IG pre-network branch sets preNetwork", async () => {
    // Calls the REAL provider (not the fake) with credentials/media that make it
    // refuse locally. No network is reachable from these branches by construction —
    // each returns before its dynamic import of the service module.
    const { officialProvider } = await import("../src/lib/social/providers/official");
    const conn = { id: "conn-1", provider: "facebook", authProvider: "official", connectionStatus: "connected" };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["facebook, no userId", { provider: "facebook", connection: conn, post: { imageUrls: [] } }],
      ["instagram, no userId", { provider: "instagram", connection: conn, post: { imageUrls: ["https://x/1.png"] } }],
      // No image at all is an Instagram-only refusal, decided before any credential read.
      ["instagram, no image", { provider: "instagram", connection: conn, userId: OWNER, post: { imageUrls: [] } }],
    ];
    for (const [label, input] of cases) {
      const r = await officialProvider.publishPost(input as never) as { ok: boolean; preNetwork?: boolean };
      assert.equal(r.ok, false, label);
      assert.equal(r.preNetwork, true, `${label} must be marked pre-network`);
    }
  });

  await test("medium / official.ts: an unwired platform stays not_implemented (already pre-network to callers)", async () => {
    const { officialProvider } = await import("../src/lib/social/providers/official");
    const r = await officialProvider.publishPost({
      provider: "tiktok",
      connection: { id: "c", provider: "tiktok", authProvider: "official", connectionStatus: "connected" },
      post: { imageUrls: [] },
    } as never) as { status: string };
    assert.equal(r.status, "not_implemented");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
