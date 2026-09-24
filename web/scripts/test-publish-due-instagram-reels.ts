/**
 * test-publish-due-instagram-reels.ts — scheduled Instagram Reels through the cron.
 *
 * The defect: `/api/cron/publish-due` handed a single-video Content's Instagram
 * destination to the IMAGE fan-out (`imageUrls: input.imageUrls`, i.e. the private
 * mp4), and Instagram's image branch refused it before the network ("Image URL must
 * be publicly reachable for Instagram to fetch it"). Scheduled Reels therefore only
 * went out from a desktop scheduled task calling the Graph API by hand.
 *
 * Loads the ACTUAL route GET handler, same pattern as test-publish-retry-worker.ts:
 * only the Supabase client, the Pinterest publishers, the Instagram Reels due
 * dispatcher, the social connection store and the social provider registry are
 * faked. The real `fanOutDestinations` runs, so "the image branch was never asked"
 * is measured at the provider's `publishPost`, not inferred from a stub.
 *
 * Part 2 exercises the real `dispatchDueInstagramReel` binding against a fake of the
 * durable dispatcher, proving what reaches the provider (no images, one signed video
 * URL, the frozen caption) and that Instagram's own error text is kept — but never a
 * signed URL.
 *
 * Touches no database and makes no network call.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_METERING_MODE = "shadow";
process.env.USAGE_REQUEST_KEY_SALT = "test-salt";
process.env.CRON_SECRET = "test-cron-secret";

import assert from "node:assert/strict";
import Module from "node:module";

const OWNER = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb1";
const DRAFT = "pd_ig_reel_1";
const IG_CONN = "conn-ig-1";
const PIN_CONN = "conn-pin-1";
const DUE_AT = "2026-09-24T16:00:00.000Z";

let passed = 0, failed = 0;

// ── Fake state ────────────────────────────────────────────────────────────────

type AttemptRecord = {
  provider: string; social_connection_id: string | null; attempt: number; retry_class: string;
  next_attempt_at: string | null; reconcile_required_at: string | null; reconciled_at: string | null;
  final_failure_at: string | null;
};
type DraftRow = {
  vibepin_user_id: string; draft_id: string; payload: Record<string, unknown>;
  scheduled_at: string | null; updated_at: string; publish_claimed_at: string | null;
  publish_next_attempt_at: string | null; deleted_at: string | null; archived_at: string | null;
};

let draft: DraftRow;
let ledger: AttemptRecord[] = [];
let chargedKeys = new Set<string>();
let releaseCalls: Array<{ key: string; reason: string }> = [];
let consumeCalls: Array<{ key: string; fresh: boolean }> = [];
let failedEvents: Array<{ code?: string; message?: string }> = [];

let publishPinCalls = 0;
let pinterestVideoCalls = 0;
let reelDispatchCalls = 0;
let reelDispatchInputs: Array<Record<string, unknown>> = [];
/** Every `publishPost` the real fan-out made, with the media it carried. */
let providerPosts: Array<{ provider: string; imageUrls: string[]; videoUrls: string[] }> = [];
/** Every destination list the real fan-out was handed. */
let fanOutDestinationLists: Array<Array<{ provider: string }>> = [];

type ReelResult = { result: Record<string, unknown>; observed: Record<string, unknown> | null };
let reelBehaviour: () => Promise<ReelResult> = async () => ({
  result: { outcome: "published", retryAllowed: false, remoteId: "ig-media-1", remoteUrl: "https://www.instagram.com/reel/ABC/" },
  observed: { providerStatus: 200, preNetwork: false },
});
let pinterestVideoBehaviour: () => Promise<unknown> = async () => ({
  outcome: "published", retryAllowed: false, remoteId: "pin-v1", remoteUrl: "https://www.pinterest.com/pin/1/",
});

function baseVideoDraft(destinations: Array<Record<string, unknown>>): DraftRow {
  return {
    vibepin_user_id: OWNER, draft_id: DRAFT,
    payload: {
      contentId: "content-ig-1",
      title: "Halloween porch",
      description: "Spooky clip",
      altText: "Porch",
      destinationUrl: "https://shop.example.com/halloween",
      media: [{
        id: "media-v1", kind: "video", url: `/api/storage-media?path=${OWNER}%2Fuploads%2Fclip.mp4`,
        width: 1080, height: 1920, durationMs: 8000, source: "upload",
      }],
      scheduledDestinations: destinations,
    },
    scheduled_at: DUE_AT, updated_at: "2026-09-24T15:00:00.000Z",
    publish_claimed_at: null, publish_next_attempt_at: null, deleted_at: null, archived_at: null,
  };
}
const IG_DEST = { provider: "instagram", socialConnectionId: IG_CONN, capturedAt: DUE_AT };
const PIN_DEST = { provider: "pinterest", socialConnectionId: PIN_CONN, boardId: "b1", capturedAt: DUE_AT };

function imageDraft(): DraftRow {
  return {
    ...baseVideoDraft([IG_DEST]),
    payload: {
      contentId: "content-ig-img",
      title: "Autumn table", description: "A still", imageUrl: "https://cdn.test/a.png",
      scheduledDestinations: [IG_DEST],
    },
  };
}

// ── The Supabase stand-in (same semantics as test-publish-retry-worker.ts) ─────

type Filter = [op: string, key: string, value: unknown];
function matchesDraft(filters: Filter[]): boolean {
  for (const [op, key, value] of filters) {
    const actual = (draft as unknown as Record<string, unknown>)[key];
    if (op === "eq" && actual !== value) return false;
    if (op === "is" && actual !== value) return false;
    if (op === "lte" && !(typeof actual === "string" && actual <= String(value))) return false;
    if (op === "not_is_null" && actual === null) return false;
  }
  return true;
}
function fakeSupabaseClient() {
  function draftBuilder() {
    const filters: Filter[] = [];
    let update: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      update: (v: Record<string, unknown>) => { update = v; return b; },
      eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return b; },
      is: (k: string, v: unknown) => { filters.push(["is", k, v]); return b; },
      lte: (k: string, v: unknown) => { filters.push(["lte", k, v]); return b; },
      not: (k: string) => { filters.push(["not_is_null", k, null]); return b; },
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: { ...draft }, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const ok = matchesDraft(filters);
        if (update && ok) Object.assign(draft, update);
        return Promise.resolve({ data: ok ? [{ ...draft }] : [], error: null }).then(resolve, reject);
      },
    };
    return b;
  }
  function attemptsBuilder() {
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b, is: () => b, lte: () => b, not: () => b,
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: ledger.map(r => ({ ...r })), error: null }).then(resolve, reject),
    };
    return b;
  }
  return {
    from: (table: string) => (table === "scheduled_publish_attempts" ? attemptsBuilder() : draftBuilder()),
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "scheduled_publish_attempt_record_v82") {
        // The v82 capability check (v82Capability.ts) probes this RPC with null
        // arguments; that is a schema probe, not an attempt, and is not recorded.
        if (args.p_provider === null || args.p_provider === undefined) return { data: {}, error: null };
        ledger.push({
          provider: String(args.p_provider),
          social_connection_id: args.p_connection_id === null ? null : String(args.p_connection_id),
          attempt: Number(args.p_attempt), retry_class: String(args.p_retry_class),
          next_attempt_at: args.p_next_attempt_at === null ? null : String(args.p_next_attempt_at),
          reconcile_required_at: args.p_reconcile_required_at === null ? null : String(args.p_reconcile_required_at),
          reconciled_at: null, final_failure_at: null,
        });
        return { data: {}, error: null };
      }
      if (fn === "usage_consume_scheduled_post") {
        const key = String(args.p_idempotency_key);
        const fresh = !chargedKeys.has(key);
        chargedKeys.add(key);
        consumeCalls.push({ key, fresh });
        return { data: { ok: true, replayed: !fresh }, error: null };
      }
      if (fn === "usage_release_scheduled_post") {
        releaseCalls.push({ key: String(args.p_idempotency_key), reason: String(args.p_reason) });
        chargedKeys.delete(String(args.p_idempotency_key));
        return { data: { ok: true }, error: null };
      }
      return { data: { ok: true }, error: null };
    },
  };
}

// ── Fake social layer ─────────────────────────────────────────────────────────

const fakeConnection = {
  id: IG_CONN, provider: "instagram", workspaceId: null, providerAccountId: "ig-acct",
  providerAccountName: "Quiet", providerAccountUsername: "quiet", providerAccountAvatarUrl: null,
  connectionStatus: "connected", authProvider: "official", externalConnectionId: null,
  scopes: [], tokenExpiresAt: null, metadata: null, createdAt: null, updatedAt: null,
};
/** What the fake Instagram provider answers. Records every call's media. */
let providerAnswer: (post: { imageUrls: string[]; videoUrls?: string[] }) => Record<string, unknown> =
  () => ({ ok: true, status: "published", externalPostId: "ig-img-1", externalPostUrl: "https://www.instagram.com/p/X/", providerStatus: 200 });
let lastProviderPost: Record<string, unknown> | null = null;
const fakeProviders = {
  getSocialProviderById: () => ({
    publishPost: async (input: { provider: string; post: { imageUrls: string[]; videoUrls?: string[] } & Record<string, unknown> }) => {
      providerPosts.push({ provider: input.provider, imageUrls: [...input.post.imageUrls], videoUrls: [...(input.post.videoUrls ?? [])] });
      lastProviderPost = { ...input.post };
      return providerAnswer(input.post);
    },
  }),
};
const fakeConnectionStore = { findConnection: async () => ({ ...fakeConnection }) };

/** Part 2's stand-in for the durable Reels dispatcher: it calls publishReel once. */
let durableReelBehaviour: (publishReel: (input: unknown, url: string) => Promise<Record<string, unknown>>) => Promise<unknown> =
  async publishReel => {
    const provider = await publishReel({ uid: OWNER, receipt: FAKE_RECEIPT }, SIGNED_URL);
    return provider.ok
      ? { outcome: "published", retryAllowed: false, remoteId: String(provider.externalPostId) }
      : { outcome: "failed", retryAllowed: true, evidence: { stage: "created", classification: "definite_rejection", providerStatus: 400 } };
  };
const SIGNED_URL = "https://example.supabase.co/storage/v1/object/sign/generated-private/x.mp4?token=eyJsecret";
const FAKE_RECEIPT = {
  title: "Frozen title", description: "Frozen caption", destinationUrl: "https://shop.example.com/f", altText: "Frozen alt",
};

// ── Module interception ───────────────────────────────────────────────────────

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean,
) {
  const from = parent?.filename?.replace(/\\/g, "/") ?? "";
  if (request.endsWith("/lib/supabase") || request === "@/lib/supabase") {
    return { createServerClient: fakeSupabaseClient, createClient: fakeSupabaseClient };
  }
  if (request.endsWith("/lib/server/pinterest/publishPin")) {
    return { publishPinForUser: async () => { publishPinCalls++; throw new Error("image Pinterest path must not run"); } };
  }
  if (request.endsWith("/lib/server/publish/v76PinterestVideoServer")) {
    return { dispatchSupabaseV76PinterestVideo: async () => { pinterestVideoCalls++; return pinterestVideoBehaviour(); } };
  }
  // The route's Reels dispatcher is faked at its module boundary; the REAL module is
  // loaded (and exercised) by Part 2, whose parent is this test file.
  if (request.endsWith("/lib/server/publish/v76InstagramReelsDue") && from.endsWith("/cron/publish-due/route.ts")) {
    return {
      dispatchDueInstagramReel: async (_db: unknown, input: Record<string, unknown>) => {
        reelDispatchCalls++;
        reelDispatchInputs.push(input);
        return reelBehaviour();
      },
    };
  }
  if (request === "./v76InstagramReelsServer" && from.endsWith("/v76InstagramReelsDue.ts")) {
    return {
      dispatchSupabaseV76InstagramReel: async (input: { publishReel: (i: unknown, u: string) => Promise<Record<string, unknown>> }) =>
        durableReelBehaviour(input.publishReel),
    };
  }
  if (request === "@/lib/social/providers" || (request === "./providers" && from.endsWith("/social/publishFanout.ts"))) {
    return fakeProviders;
  }
  if (request === "@/lib/social/server/socialConnectionStore"
      || (request === "./server/socialConnectionStore" && from.endsWith("/social/publishFanout.ts"))) {
    return fakeConnectionStore;
  }
  if (request === "./ensureAccount" || request.endsWith("/usage/ensureAccount")) {
    return { ensureUsageAccount: async () => ({ ok: true, action: "noop" }) };
  }
  if (request.endsWith("/lib/server/publishEvents")) {
    const real = origLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      recordPublishEvent: async () => {},
      recordFailedPublishEvent: async (_db: unknown, _b: unknown, _ms: unknown, info: { code?: string; message?: string }) => {
        failedEvents.push(info ?? {});
      },
    };
  }
  if (request.endsWith("/social/publishFanout")) {
    const real = origLoad.call(this, request, parent, isMain) as Record<string, unknown> & {
      fanOutDestinations: (...a: unknown[]) => Promise<unknown>;
    };
    return {
      ...real,
      createPublishJob: async () => null,
      recordOutcomes: async () => true,
      // The REAL fan-out runs; this only records what it was handed.
      fanOutDestinations: async (...a: unknown[]) => {
        fanOutDestinationLists.push((a[1] as Array<{ provider: string }>).map(d => ({ provider: d.provider })));
        return real.fanOutDestinations(...a);
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

function cronReq(): Request {
  return {
    url: "https://app.example.com/api/cron/publish-due",
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer test-cron-secret" : null) },
  } as unknown as Request;
}

type RunBody = { claimed: number; published: number; failed: number; skipped: number; deferred: number };

async function test(name: string, retryFlag: boolean, fn: () => Promise<void>) {
  draft = baseVideoDraft([IG_DEST]);
  ledger = []; chargedKeys = new Set();
  releaseCalls = []; consumeCalls = []; failedEvents = [];
  publishPinCalls = 0; pinterestVideoCalls = 0; reelDispatchCalls = 0; reelDispatchInputs = [];
  providerPosts = []; fanOutDestinationLists = []; lastProviderPost = null;
  reelBehaviour = async () => ({
    result: { outcome: "published", retryAllowed: false, remoteId: "ig-media-1", remoteUrl: "https://www.instagram.com/reel/ABC/" },
    observed: { providerStatus: 200, preNetwork: false },
  });
  pinterestVideoBehaviour = async () => ({
    outcome: "published", retryAllowed: false, remoteId: "pin-v1", remoteUrl: "https://www.pinterest.com/pin/1/",
  });
  providerAnswer = () => ({ ok: true, status: "published", externalPostId: "ig-img-1", externalPostUrl: "https://www.instagram.com/p/X/", providerStatus: 200 });
  if (retryFlag) process.env.PUBLISH_RETRY_WORKER_ENABLED = "true";
  else delete process.env.PUBLISH_RETRY_WORKER_ENABLED;
  process.env.VIDEO_PIN_UPLOAD_ENABLED = "true";
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).stack ?? (e as Error).message}`); failed++; }
  finally {
    delete process.env.PUBLISH_RETRY_WORKER_ENABLED;
    delete process.env.VIDEO_PIN_UPLOAD_ENABLED;
  }
}

function rows(): Array<Record<string, unknown>> {
  const r = draft.payload.destinationResults;
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [];
}
function rowFor(provider: string): Record<string, unknown> | undefined {
  return rows().find(r => r.provider === provider);
}
/** Instagram publishPost calls that went down the IMAGE branch (carried images). */
function igImageBranchCalls(): number {
  return providerPosts.filter(p => p.provider === "instagram" && p.imageUrls.length > 0).length;
}
function igFanOutHandoffs(): number {
  return fanOutDestinationLists.flat().filter(d => d.provider === "instagram").length;
}
function nextTick(): void { draft.publish_claimed_at = null; }

(async () => {
  console.log("=== cron/publish-due — scheduled Instagram Reels (route-level, no database) ===\n");
  const { GET } = await import("../src/app/api/cron/publish-due/route") as { GET: (r: Request) => Promise<Response> };
  const run = async (): Promise<RunBody> => (await GET(cronReq())).json() as Promise<RunBody>;

  // ── Core: the video goes to Reels, never to the image fan-out ────────────────
  for (const flag of [false, true]) {
    await test(`R1 (retry flag ${flag ? "ON" : "OFF"}): single-video IG draft → Reels dispatch 1, image branch 0`, flag, async () => {
      const body = await run();
      assert.equal(reelDispatchCalls, 1, "exactly one Reels dispatch");
      assert.equal(igImageBranchCalls(), 0, "Instagram's image branch must never see the video");
      assert.equal(igFanOutHandoffs(), 0, "the Instagram destination is not handed to the image fan-out");
      assert.equal(publishPinCalls + pinterestVideoCalls, 0, "no Pinterest destination, no Pinterest call");
      const input = reelDispatchInputs[0];
      const dest = input.destination as { provider: string; socialConnectionId: string; id: string };
      assert.equal(dest.provider, "instagram");
      assert.equal(dest.socialConnectionId, IG_CONN);
      assert.equal(input.uid, OWNER);
      assert.equal(input.scheduleAt, DUE_AT, "the durable schedule instant is frozen in");
      assert.equal(typeof input.latestStartMs, "number", "the run deadline bounds the Reel start");
      const receipt = input.receipt as { dispatchDestinationIds: string[]; draftId: string };
      assert.equal(receipt.draftId, DRAFT);
      assert.ok(receipt.dispatchDestinationIds.includes(dest.id), "the frozen destination is in the receipt's dispatch set");
      const ig = rowFor("instagram");
      assert.equal(ig?.status, "published");
      assert.equal(ig?.remoteId, "ig-media-1");
      assert.equal(ig?.postUrl, "https://www.instagram.com/reel/ABC/");
      assert.equal(body.published, 1);
      assert.equal(draft.scheduled_at, null, "a fully published Content leaves the due scan");
      assert.equal(consumeCalls.length, 1, "one scheduled-post unit");
      assert.equal(releaseCalls.length, 0, "a delivered Reel is not refunded");
      assert.equal(ledger.length, 0, `no retry bookkeeping for a success: ${JSON.stringify(ledger)}`);
    });
  }

  // ── delivery_unknown: recorded, never re-sent ────────────────────────────────
  for (const flag of [false, true]) {
    await test(`R2 (retry flag ${flag ? "ON" : "OFF"}): delivery_unknown is recorded and NEVER re-dispatched`, flag, async () => {
      reelBehaviour = async () => ({
        result: { outcome: "delivery_unknown", retryAllowed: false, reconcileRequired: true, evidence: { reason: "provider_boundary_exception" } },
        observed: null,
      });
      await run();
      const ig = rowFor("instagram");
      assert.equal(ig?.status, "delivery_unknown");
      assert.match(String(ig?.errorMessage), /reason provider_boundary_exception/, "the real orchestration reason is shown");
      assert.equal(releaseCalls.length, 0, "an unknown delivery keeps its charge");
      assert.equal(
        ledger.filter(r => r.reconcile_required_at).length, 0,
        "Instagram is not flagged into the Pinterest-only stage-0 reconcile ledger",
      );
      // Two more ticks. Whatever the schedule does, the Reel is not sent again.
      nextTick(); await run();
      nextTick(); await run();
      assert.equal(reelDispatchCalls, 1, "unknown is never blindly re-sent");
      assert.equal(igImageBranchCalls(), 0);
      assert.equal(rowFor("instagram")?.status, "delivery_unknown", "the unknown row stands");
      assert.equal(draft.scheduled_at, null, "and the Content eventually leaves the due scan (no permanent hold)");
    });
  }

  // ── failed: Instagram's own words, terminal, refunded ─────────────────────────
  for (const flag of [false, true]) {
    await test(`R3 (retry flag ${flag ? "ON" : "OFF"}): failed keeps Instagram's real error, is terminal and refunded`, flag, async () => {
      reelBehaviour = async () => ({
        result: { outcome: "failed", retryAllowed: true, evidence: { stage: "created", classification: "definite_rejection", providerStatus: 400 } },
        observed: { providerStatus: 400, message: "The video format is not supported. Please check spec for supported codec", preNetwork: false },
      });
      const body = await run();
      const ig = rowFor("instagram");
      assert.equal(ig?.status, "failed");
      assert.match(String(ig?.errorMessage), /The video format is not supported/, "Instagram's text, not a fixed sentence");
      assert.match(String(ig?.errorMessage), /HTTP 400/);
      assert.equal(body.failed, 1);
      assert.equal(failedEvents.length, 1, "the merchant is told once");
      assert.match(String(failedEvents[0].message), /video format is not supported/);
      assert.deepEqual(releaseCalls.map(r => r.reason), ["rejected"], "a provider 4xx refunds as rejected");
      assert.equal(ledger.length, 0, "no Pinterest-table retry for an Instagram failure");
      assert.equal(draft.scheduled_at, null, "terminal: the schedule ends");
      nextTick(); await run();
      assert.equal(reelDispatchCalls, 1, "and it is not retried");
    });
  }

  await test("R4: a pre-network refusal (no connection) is not_sent and shows no invented HTTP status", true, async () => {
    reelBehaviour = async () => ({
      result: { outcome: "failed", retryAllowed: true, evidence: { stage: "created", classification: "definite_rejection", providerStatus: 400 } },
      observed: { message: "Reconnect your Instagram account to publish this Reel.", preNetwork: true },
    });
    await run();
    const ig = rowFor("instagram");
    assert.equal(ig?.status, "failed");
    assert.match(String(ig?.errorMessage), /Reconnect your Instagram account/);
    assert.doesNotMatch(String(ig?.errorMessage), /HTTP/, "the dispatcher's synthesized 400 is not shown as Instagram's");
    assert.deepEqual(releaseCalls.map(r => r.reason), ["not_sent"]);
  });

  await test("R5: a throw from the durable chain (pre-provider) is a failed, refundable row", false, async () => {
    reelBehaviour = async () => { throw new Error("publish_asset_lease_materialization_failed"); };
    await run();
    const ig = rowFor("instagram");
    assert.equal(ig?.status, "failed");
    assert.match(String(ig?.errorMessage), /publish_asset_lease_materialization_failed/);
    assert.deepEqual(releaseCalls.map(r => r.reason), ["not_sent"]);
    assert.equal(igImageBranchCalls(), 0, "a failing Reel never falls back to the image branch");
  });

  await test("R6: in_progress (another worker holds the claim) defers — no row, schedule kept", false, async () => {
    reelBehaviour = async () => ({ result: { outcome: "in_progress", retryAllowed: false }, observed: null });
    const body = await run();
    assert.equal(rows().length, 0, "nothing happened, nothing is written");
    assert.equal(draft.scheduled_at, DUE_AT);
    assert.equal(body.deferred, 1);
  });

  // ── Regression: image drafts keep the fan-out path ───────────────────────────
  for (const flag of [false, true]) {
    await test(`R7 (retry flag ${flag ? "ON" : "OFF"}): an IMAGE Instagram draft still goes through the fan-out`, flag, async () => {
      draft = imageDraft();
      const body = await run();
      assert.equal(reelDispatchCalls, 0, "an image is never sent as a Reel");
      assert.equal(igFanOutHandoffs(), 1, "the Instagram destination is handed to the fan-out");
      assert.equal(igImageBranchCalls(), 1, "and published through the image branch");
      assert.deepEqual(providerPosts[0].imageUrls, ["https://cdn.test/a.png"]);
      assert.equal(rowFor("instagram")?.status, "published");
      assert.equal(body.published, 1);
    });
  }

  // ── Pinterest + Instagram video: two independent durable dispatches ──────────
  await test("R8: Pinterest+IG video — Pinterest fails, the Reel still publishes", true, async () => {
    draft = baseVideoDraft([PIN_DEST, IG_DEST]);
    pinterestVideoBehaviour = async () => ({
      outcome: "failed", retryAllowed: true,
      evidence: { stage: "created", classification: "definite_rejection", providerStatus: 400, providerMessage: "Invalid video" },
    });
    await run();
    assert.equal(pinterestVideoCalls, 1);
    assert.equal(reelDispatchCalls, 1);
    assert.equal(igFanOutHandoffs(), 0, "no image fan-out for the video row");
    assert.equal(rowFor("pinterest")?.status, "failed");
    assert.equal(rowFor("instagram")?.status, "published");
    assert.equal(releaseCalls.length, 0, "one destination delivered ⇒ the unit is charged");
    const pinDest = reelDispatchInputs[0].receipt as { dispatchDestinationIds: string[] };
    assert.equal(pinDest.dispatchDestinationIds.length, 2, "one receipt, both destinations frozen");
  });

  await test("R9: Pinterest+IG video — Pinterest publishes, the Reel is unknown; neither re-sent", false, async () => {
    draft = baseVideoDraft([PIN_DEST, IG_DEST]);
    reelBehaviour = async () => ({
      result: { outcome: "delivery_unknown", retryAllowed: false, evidence: {} }, observed: null,
    });
    await run();
    assert.equal(rowFor("pinterest")?.status, "published");
    assert.equal(rowFor("instagram")?.status, "delivery_unknown");
    nextTick(); draft.scheduled_at = draft.scheduled_at ?? DUE_AT; await run();
    assert.equal(pinterestVideoCalls, 1, "the published Pinterest destination is not re-sent");
    assert.equal(reelDispatchCalls, 1, "the unknown Reel is not re-sent");
  });

  // ── Part 2: the real due binding ─────────────────────────────────────────────
  console.log("\n--- dispatchDueInstagramReel (real module, fake durable dispatcher) ---");
  const { dispatchDueInstagramReel } = await import("../src/lib/server/publish/v76InstagramReelsDue");
  const socialDeps = { findConnection: fakeConnectionStore.findConnection, getSocialProviderById: fakeProviders.getSocialProviderById } as never;
  const dueInput = {
    uid: OWNER,
    receipt: FAKE_RECEIPT as never,
    destination: { id: `instagram:${IG_CONN}`, provider: "instagram", socialConnectionId: IG_CONN } as never,
    scheduleAt: DUE_AT,
    latestStartMs: Date.now() + 60_000,
  };

  await test("D1: the provider gets ONE signed video URL, no images, and the frozen copy", false, async () => {
    providerAnswer = () => ({ ok: true, status: "published", externalPostId: "ig-99", providerStatus: 200 });
    const out = await dispatchDueInstagramReel({} as never, dueInput, socialDeps);
    assert.equal(providerPosts.length, 1);
    assert.deepEqual(providerPosts[0].imageUrls, [], "never the image branch");
    assert.deepEqual(providerPosts[0].videoUrls, [SIGNED_URL]);
    assert.equal(lastProviderPost?.title, "Frozen title");
    assert.equal(lastProviderPost?.caption, "Frozen caption");
    assert.equal(out.result.outcome, "published");
    assert.equal(out.observed?.providerStatus, 200);
  });

  await test("D2: Instagram's error text is carried back; a URL-bearing one is dropped", false, async () => {
    providerAnswer = () => ({ ok: false, status: "failed", error: "Media ID is not available", providerStatus: 400 });
    const plain = await dispatchDueInstagramReel({} as never, dueInput, socialDeps);
    assert.equal(plain.observed?.message, "Media ID is not available");
    assert.equal(plain.observed?.providerStatus, 400);
    providerAnswer = () => ({ ok: false, status: "failed", error: `Could not download ${SIGNED_URL}`, providerStatus: 400 });
    const leaky = await dispatchDueInstagramReel({} as never, dueInput, socialDeps);
    assert.equal(leaky.observed?.message, undefined, "a signed URL must never reach a merchant-visible row");
  });

  await test("D3: a pre-network provider refusal is marked preNetwork and carries no status", false, async () => {
    providerAnswer = () => ({ ok: false, status: "failed", error: "Connect an Instagram account first.", preNetwork: true, providerStatus: 400 });
    const out = await dispatchDueInstagramReel({} as never, dueInput, socialDeps);
    assert.equal(out.observed?.preNetwork, true);
    assert.equal(out.observed?.providerStatus, undefined);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
