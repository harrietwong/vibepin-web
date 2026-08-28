/**
 * test-social-only-metering.ts — closes the social-only metering gap.
 *
 * Since 4218c67 a merchant can publish to Facebook/Instagram/TikTok WITHOUT
 * Pinterest as a destination. /api/pinterest/pins is the only route that ever
 * called consumeScheduledPost, so that "social-only" publish cost 0 against the
 * scheduled-post quota -- a free bypass of PRD v3.1 decisions 3 & 4 ("one Content
 * published = one unit, no matter how many platforms").
 *
 * This loads the REAL /api/publish/social route module (not a reimplementation)
 * and fakes only its Supabase/auth/account-provisioning boundary, so what is
 * proven here is the actual route wiring, not a description of it. Every
 * Module._load fake below exports EVERY member the real code imports from that
 * module -- a fake exporting a subset is a latent trap (see ce81e826 / de18934b):
 * the next import a route adds resolves to `undefined(...)`, a synchronous
 * TypeError thrown before any `.catch` can attach, and the route dies before the
 * assertion it was meant to exercise is ever reached.
 *
 * Touches no database: every client in the request path is faked here.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_METERING_MODE = "shadow";
process.env.USAGE_REQUEST_KEY_SALT = "test-salt";

import assert from "node:assert";
import Module from "node:module";

const OWNER = "user-social-meter-1";
let passed = 0, failed = 0;

type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
let rpcBehaviour: (fn: string, args: Record<string, unknown>) => RpcResult =
  () => ({ data: { ok: true, replayed: false }, error: null });

/**
 * A generic chainable + awaitable query-builder stand-in. Every real call site
 * on the social-route dependency path either awaits the chain directly
 * (await db().from(t).select(...).eq(...)) or terminates it with
 * .single()/.maybeSingle() -- both are wired here to resolve the SAME
 * "table not applied yet" error every real degrade path already handles
 * (isMissingTable / isMissingSocialConnectionsTable), so connections
 * resolve to none and no destination is ever "connected" -- the social provider
 * dispatch (a REAL network call) can never be reached from this test.
 */
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

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: unknown, isMain: boolean,
) {
  // route.ts + meterGeneration.ts both import this by alias.
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase")) {
    return { createServerClient: fakeSupabaseClient, createClient: fakeSupabaseClient };
  }
  // /api/publish/social imports getUserIdFromBearer; /api/pinterest/pins (loaded below,
  // for the cross-route key-parity check) imports getUserIdFromBearerOrCookies. Both
  // are faked here to the SAME owner so a future import either route adds does not
  // silently resolve to undefined -- the exact trap ce81e826 fixed for the AI-provider
  // routes, which faked a DIFFERENT pair (getUserIdFromBearerOrCookies /
  // getUserIdFromSameOriginSession) because those are the exports THOSE routes import.
  if (request === "@/lib/server/authUser" || request.endsWith("/lib/server/authUser")) {
    return {
      getUserIdFromBearer: async () => OWNER,
      getUserIdFromCookies: async () => null,
      getUserIdFromBearerOrCookies: async () => OWNER,
    };
  }
  // /api/pinterest/pins delegates the actual Pinterest call to publishPinForUser --
  // faked here to a deterministic success so the cross-route key-parity check below
  // never makes a real network call and never depends on Pinterest credentials.
  if (request === "@/lib/server/pinterest/publishPin" || request.endsWith("/lib/server/pinterest/publishPin")) {
    return {
      publishPinForUser: async () => ({
        ok: true,
        pin: { id: "p1", url: "https://pin/1" },
        board: { id: "b", name: "Board" },
        environment: "sandbox",
      }),
    };
  }
  // socialConnectionStore.ts reads Pinterest rows through this aliased import. Faked to
  // "no accounts" so the test never has to reproduce its real query shape, and so no
  // destination can resolve to "connected" -- metering must not depend on that.
  if (request === "@/lib/server/pinterest/connectionStore" || request.endsWith("/lib/server/pinterest/connectionStore")) {
    return { listActiveConnections: async () => [], toSafeStatus: (r: unknown) => r };
  }
  // meterScheduledPost.ts's default `ensure` seam (used whenever the route calls
  // consumeScheduledPost without its own deps.ensure, exactly as production does).
  // Faked to a no-op success so a consume never needs a real usage_accounts round-trip.
  if (request === "./ensureAccount" || request.endsWith("/usage/ensureAccount")) {
    return { ensureUsageAccount: async () => ({ ok: true, action: "noop" }) };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

async function test(name: string, fn: () => Promise<void>) {
  rpcCalls.length = 0;
  rpcBehaviour = () => ({ data: { ok: true, replayed: false }, error: null });
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function req(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function consumeCalls(): RpcCall[] {
  return rpcCalls.filter(c => c.fn === "usage_consume_scheduled_post");
}

(async () => {
  console.log("=== /api/publish/social -- social-only metering (route-level, no database) ===\n");

  const mod = await import("../src/app/api/publish/social/route");
  const { POST } = mod as { POST: (r: Request) => Promise<Response> };
  const pinsMod = await import("../src/app/api/pinterest/pins/route");
  const { POST: pinsPOST } = pinsMod as { POST: (r: Request) => Promise<Response> };
  const { deriveScheduledPostKey } = await import("../src/lib/server/usage/meterScheduledPost");

  await test("a social-only publish (no Pinterest destination) charges exactly ONE unit, keyed like the pins route would key the SAME Content", async () => {
    const draftId = "pd_social_only_1";
    const res = await POST(req({
      postId: draftId,
      post: { imageUrls: ["https://example.com/img1.png"], title: "t", caption: "c" },
      destinations: [{ provider: "facebook", socialConnectionId: "conn-fb-1" }],
    }));
    assert.equal(res.status, 200, "the route itself must not error");

    const calls = consumeCalls();
    assert.equal(calls.length, 1, "exactly one scheduled-post consume for one Content");
    const expectedKey = deriveScheduledPostKey(OWNER, draftId);
    assert.equal(calls[0].args.p_idempotency_key, expectedKey, "must reuse the SAME key deriveScheduledPostKey(uid, draftId) produces for the pins route");
    assert.equal(calls[0].args.p_reference_id, draftId);
    assert.deepEqual(calls[0].args.p_metadata, { source: "social_immediate" });
    assert.equal(calls[0].args.p_quantity, 1);
  });

  await test("a publish that ALSO targets Pinterest still makes exactly ONE consume call from this route, keyed identically to the pins route (the shared idempotency key — not a client-trusted destination flag — is what prevents a double charge)", async () => {
    const draftId = "pd_with_pinterest_1";
    await POST(req({
      postId: draftId,
      post: { imageUrls: ["https://example.com/img2.png"] },
      destinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1" },
        { provider: "facebook", socialConnectionId: "conn-fb-1" },
      ],
    }));
    const calls = consumeCalls();
    assert.equal(calls.length, 1, "this route must always attempt a consume when postId is present, regardless of destinations");
    assert.equal(calls[0].args.p_idempotency_key, deriveScheduledPostKey(OWNER, draftId));
  });

  await test("when the ledger reports the consume as already-charged (replayed: true — simulating the pins route having charged first), the route still proceeds without error", async () => {
    rpcBehaviour = () => ({ data: { ok: true, replayed: true }, error: null });
    const draftId = "pd_replayed_1";
    const res = await POST(req({
      postId: draftId,
      post: { imageUrls: ["https://example.com/img5.png"] },
      destinations: [
        { provider: "pinterest", socialConnectionId: "conn-pin-1" },
        { provider: "facebook", socialConnectionId: "conn-fb-1" },
      ],
    }));
    assert.equal(res.status, 200, "a replayed consume must never fail the publish");
    assert.equal(consumeCalls().length, 1, "the route still attempts exactly one consume call");
  });

  await test("no draft identity on the request -> zero consume calls and a usage_meter_skipped log line, never a collide-prone key", async () => {
    const originalWarn = console.warn;
    const lines: string[] = [];
    console.warn = ((msg?: unknown) => { lines.push(String(msg)); }) as typeof console.warn;
    try {
      await POST(req({
        // no postId at all
        post: { imageUrls: ["https://example.com/img3.png"] },
        destinations: [{ provider: "facebook", socialConnectionId: "conn-fb-1" }],
      }));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(consumeCalls().length, 0, "must never charge a key with no stable draft identity");
    const parsed = lines
      .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .find(l => l?.event === "usage_meter_skipped");
    assert.ok(parsed, `expected a usage_meter_skipped log line, saw: ${JSON.stringify(lines)}`);
    assert.equal(parsed!.reason, "no_draft_identity");
    assert.equal(parsed!.route, "publish_social");
  });

  await test("a ledger RPC error still lets the publish proceed (fail-open, like the pins route)", async () => {
    rpcBehaviour = () => ({ data: null, error: { message: "simulated ledger outage" } });
    const res = await POST(req({
      postId: "pd_ledger_outage_1",
      post: { imageUrls: ["https://example.com/img4.png"] },
      destinations: [{ provider: "facebook", socialConnectionId: "conn-fb-1" }],
    }));
    assert.equal(res.status, 200, "an accounting outage must never cost a user a publish they were entitled to");
    const body = await res.json() as { destinations: unknown[] };
    assert.ok(Array.isArray(body.destinations), "the publish result is still returned");
    assert.equal(consumeCalls().length, 1, "the attempt was still made exactly once, it just failed open");
  });

  await test("cross-route parity: /api/pinterest/pins and /api/publish/social derive the BYTE-IDENTICAL idempotency key for the same Content (this is what actually prevents the double charge, not a client-trusted destination flag)", async () => {
    const draftId = "draft-X";

    await pinsPOST(req({
      draftId,
      boardId: "b",
      imageUrl: "https://i/x.png",
      title: "t",
    }));
    const pinsCalls = consumeCalls();
    assert.equal(pinsCalls.length, 1, "the pins route must consume exactly once for this publish");
    const keyFromPinsRoute = pinsCalls[0].args.p_idempotency_key;

    rpcCalls.length = 0; // isolate the social route's call from the pins route's above

    await POST(req({
      postId: draftId,
      post: { imageUrls: ["https://example.com/img6.png"] },
      destinations: [{ provider: "facebook", socialConnectionId: "conn-fb-1" }],
    }));
    const socialCalls = consumeCalls();
    assert.equal(socialCalls.length, 1, "the social route must consume exactly once for this publish");
    const keyFromSocialRoute = socialCalls[0].args.p_idempotency_key;

    assert.equal(
      keyFromPinsRoute, keyFromSocialRoute,
      "both real routes must derive the identical key for the same (uid, draftId) — this shared key, " +
      "collapsed by the ledger's UNIQUE(user_id, idempotency_key), is the actual double-charge guard",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
