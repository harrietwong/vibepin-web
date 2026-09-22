/**
 * Route-level Social retry gate. Loads the real POST handler and fakes only its
 * auth, durable-ledger, capability, metering and provider boundaries. No network,
 * database or provider call is possible from this test.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import Module from "node:module";

const OWNER = "user-social-retry-route";
const DRAFT_ID = "pd_social_retry_route";
const CONTENT_ID = "content-social-retry-route";
const FACEBOOK_ID = "facebook:fb-connection";
const INSTAGRAM_ID = "instagram:ig-connection";

const destinations = [
  { id: FACEBOOK_ID, provider: "facebook", socialConnectionId: "fb-connection" },
  { id: INSTAGRAM_ID, provider: "instagram", socialConnectionId: "ig-connection" },
];

type DurableStatus = "claimed" | "published" | "failed" | "delivery_unknown";
let authoritative = new Map<string, { status: DurableStatus; retryAllowed: boolean }>();
let priorIntentId: string | null = "publish:prior:route";
let claimCalls = 0;
let providerCalls = 0;
let meterCalls = 0;
let durableReelCalls = 0;
let releaseCalls = 0;
let jobCalls = 0;
let outcomeCalls = 0;
let invokeDurableProvider = false;
let privateConnectionAvailable = false;
let meterResult: { kind: string; fresh?: boolean } = { kind: "insufficient" };
const events: string[] = [];
let durableOutcome: Record<string, unknown> = { outcome: "published", retryAllowed: false, remoteId: "ig-media-route", remoteUrl: "https://instagram.example.test/reel/route", evidence: { provider: "instagram" } };

class FakePublishIntentLedgerError extends Error {
  constructor(public readonly code: "unavailable" | "conflict" | "claim_lost" | "retry_not_allowed", message: string) {
    super(message);
  }
}

const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) {
  if (request === "@/lib/server/authUser" || request.endsWith("/lib/server/authUser")) {
    return { getUserIdFromBearer: async () => OWNER };
  }
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase")) {
    return { createServerClient: () => ({
      storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://storage.example.test/frozen.mp4?token=private" }, error: null }) }) },
    }) };
  }
  if (request === "@/lib/server/mediaProvenance" || request.endsWith("/server/mediaProvenance")) {
    return { createMediaProvenanceStore: () => ({ findExact: async () => ({
      owner_user_id: OWNER, bucket_id: "generated-private", object_path: `${OWNER}/uploads/reel.mp4`, media_kind: "video", lifecycle_state: "draft",
    }) }) };
  }
  if (request === "@/lib/server/publish/v76InstagramReelsServer" || request.endsWith("/server/publish/v76InstagramReelsServer")) {
    return { dispatchSupabaseV76InstagramReel: async (input: {
      publishInput: unknown;
      publishReel: (current: unknown, signedFrozenCopyUrl: string) => Promise<unknown>;
    }) => {
      durableReelCalls++;
      events.push("durable");
      if (invokeDurableProvider) {
        await input.publishReel(input.publishInput, "https://storage.example.test/user/publish/frozen.mp4?token=private");
      }
      return durableOutcome;
    } };
  }
  if (request === "@/lib/social/publishFanout" || request.endsWith("/social/publishFanout")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      createPublishJob: async () => { jobCalls++; return "job-durable-reel"; },
      recordOutcomes: async () => { outcomeCalls++; return true; },
    };
  }
  if (request === "@/lib/server/publish/confirmationReceipt" || request.endsWith("/server/publish/confirmationReceipt")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      validateImmediatePublishReceipt: (raw: Record<string, unknown>, _content: Record<string, unknown>, requestedIds: string[]) => {
        const ds = Array.isArray(raw.destinations) ? raw.destinations : [];
        const destinationId = (value: unknown) => {
          const row = value as { id?: unknown; provider?: unknown; socialConnectionId?: unknown };
          return typeof row.id === "string" ? row.id : `${String(row.provider)}:${String(row.socialConnectionId)}`;
        };
        const ids = ds.map(destinationId);
        const publishable = Array.isArray(raw.publishableDestinations)
          ? raw.publishableDestinations.map(destinationId)
          : [];
        const dispatch = Array.isArray(raw.dispatchDestinationIds) ? raw.dispatchDestinationIds : [];
        const same = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
        if (!raw.onlyPending && !same(dispatch, publishable)) return { ok: false, code: "invalid_confirmation", error: "incomplete" };
        if (raw.onlyPending && !raw.priorIntentId && !same(dispatch, publishable)) return { ok: false, code: "invalid_confirmation", error: "incomplete" };
        if (!same(ids, dispatch)) return { ok: false, code: "invalid_confirmation", error: "inconsistent" };
        if (!same(requestedIds, dispatch)) return { ok: false, code: "invalid_confirmation", error: "unconfirmed" };
        return { ok: true, receipt: raw, destinations: ds };
      },
      validateStoredImmediatePublishReceipt: async () => ({ ok: true, priorIntentId }),
    };
  }
  if (request === "@/lib/server/publish/publishIntentLedger" || request.endsWith("/server/publish/publishIntentLedger")) {
    return {
      PublishIntentLedgerError: FakePublishIntentLedgerError,
      reconcilePublishIntent: async () => ({
        intentId: "publish:prior:route",
        fingerprint: "f".repeat(64),
        draftId: DRAFT_ID,
        contentId: CONTENT_ID,
        confirmedAt: "2026-09-01T12:00:00.000Z",
        destinations: destinations.map(destination => ({
          destinationJobId: `job:${destination.id}`,
          destinationId: destination.id,
          provider: destination.provider,
          socialConnectionId: destination.socialConnectionId,
          subdestinationId: null,
          status: authoritative.get(destination.id)?.status ?? "failed",
          attempt: 1,
          retryAllowed: authoritative.get(destination.id)?.retryAllowed ?? true,
          providerJobId: null,
          remoteId: null,
          remoteUrl: null,
          providerStatus: null,
          evidence: {},
          claimedAt: "2026-09-01T12:00:00.000Z",
          finishedAt: "2026-09-01T12:00:01.000Z",
        })),
      }),
      claimPublishIntentDestinations: async (_db: unknown, _uid: string, _receipt: unknown, selected: typeof destinations) => {
        claimCalls++;
        return selected.map((destination, index) => ({
          destination,
          claim: {
            claimed: true,
            replayed: false,
            intentJobId: "intent-job-route",
            destinationJobId: `destination-job-${index}`,
            claimToken: `claim-token-${index}`,
            status: "claimed",
            attempt: 1,
            retryAllowed: false,
            providerJobId: null,
            remoteId: null,
            remoteUrl: null,
            providerStatus: null,
            evidence: {},
          },
        }));
      },
      claimPublishRetryDestinations: async (_db: unknown, _uid: string, _receipt: unknown, selected: typeof destinations) => {
        if (selected.some(destination => {
          const row = authoritative.get(destination.id);
          return row?.status !== "failed" || row.retryAllowed !== true;
        })) throw new FakePublishIntentLedgerError("retry_not_allowed", "retry_not_allowed");
        claimCalls++;
        return selected.map((destination, index) => ({ destination, claim: {
          claimed: true, replayed: false, intentJobId: "retry-intent-job-route",
          destinationJobId: `retry-destination-job-${index}`, claimToken: `retry-claim-token-${index}`,
          status: "claimed", attempt: 1, retryAllowed: false, providerJobId: null,
          remoteId: null, remoteUrl: null, providerStatus: null, evidence: {},
        }}));
      },
      settlePublishIntentDestination: async () => undefined,
    };
  }
  if (request === "@/lib/social/server/socialConnectionStore" || request.endsWith("/social/server/socialConnectionStore")) {
    return {
      summarizeConnections: async () => [
        { provider: "facebook", accounts: [{ id: "fb-connection" }] },
        { provider: "instagram", accounts: [{ id: "ig-connection" }] },
      ],
      findConnection: async () => privateConnectionAvailable
        ? { id: "ig-connection", connectionStatus: "connected", authProvider: "official" }
        : null,
    };
  }
  if (request === "@/lib/social/destinationCapability" || request.endsWith("/social/destinationCapability")) {
    return {
      resolveDestinationCapability: (input: { connectionId: string }) => ({
        connectionId: input.connectionId,
        providerAccountId: input.connectionId,
        displayIdentity: input.connectionId,
        publishNow: true,
      }),
    };
  }
  if (request === "@/lib/server/usage/meterScheduledPost" || request.endsWith("/usage/meterScheduledPost")) {
    return {
      consumeScheduledPost: async () => { meterCalls++; events.push("meter"); return meterResult; },
      deriveScheduledPostKey: () => "scheduled-post-route-test",
      releaseScheduledPost: async () => { releaseCalls++; return undefined; },
      scheduledPostLimitResponseBody: () => ({ error: "limit", code: "scheduled_post_limit_reached" }),
      usageEnforceFor: () => true,
      classifyImmediateBucket: () => "ok",
    };
  }
  if (request === "@/lib/server/usage/meterGeneration" || request.endsWith("/usage/meterGeneration")) {
    return { logEvent: () => undefined };
  }
  if (request === "@/lib/social/providers" || request.endsWith("/social/providers")) {
    return {
      getSocialProviderById: () => ({
        publishPost: async () => { providerCalls++; events.push("provider"); return { ok: true, status: "published" }; },
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as never;

(async () => {
const { POST } = await import("../src/app/api/publish/social/route");

function request(onlyPending: boolean, selectedIds: string[]): Request {
  const selected = destinations.filter(destination => selectedIds.includes(destination.id));
  return {
    url: "https://app.example.com/api/publish/social",
    json: async () => ({
      postId: DRAFT_ID,
      post: { imageUrls: ["https://example.com/pin.png"], title: "Title", caption: "Caption" },
      destinations: selected.map(destination => ({
        provider: destination.provider,
        socialConnectionId: destination.socialConnectionId,
      })),
      confirmation: {
        intentId: `publish:${CONTENT_ID}:route-test`,
        fingerprint: "f".repeat(64),
        draftId: DRAFT_ID,
        contentId: CONTENT_ID,
        confirmedAt: "2026-09-01T12:00:02.000Z",
        onlyPending,
        mode: { kind: "now" },
        media: [{ id: "media-1", url: "https://example.com/pin.png", source: "upload" }],
        blockers: [],
        priorIntentId,
        dispatchDestinationIds: selected.map(destination => destination.id),
        publishableDestinations: destinations,
        destinations: selected,
      },
    }),
  } as unknown as Request;
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  authoritative = new Map();
  priorIntentId = "publish:prior:route";
  claimCalls = 0;
  providerCalls = 0;
  meterCalls = 0;
  durableReelCalls = 0;
  releaseCalls = 0;
  jobCalls = 0;
  outcomeCalls = 0;
  invokeDurableProvider = false;
  privateConnectionAvailable = false;
  meterResult = { kind: "insufficient" };
  events.length = 0;
  durableOutcome = { outcome: "published", retryAllowed: false, remoteId: "ig-media-route", remoteUrl: "https://instagram.example.test/reel/route", evidence: { provider: "instagram" } };
  try {
    await fn();
    passed++;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${(error as Error).stack ?? (error as Error).message}`);
  }
}

await test("onlyPending=true first attempt accepts the exact full social set without prior intent", async () => {
  priorIntentId = null;
  const response = await POST(request(true, [FACEBOOK_ID, INSTAGRAM_ID]));
  assert.equal(response.status, 402);
  assert.equal(claimCalls, 1);
  assert.equal(meterCalls, 1);
  assert.equal(providerCalls, 0);
});

await test("onlyPending=true first attempt still rejects a narrowed set without prior intent", async () => {
  priorIntentId = null;
  const response = await POST(request(true, [FACEBOOK_ID]));
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "invalid_confirmation");
  assert.equal(claimCalls, 0);
  assert.equal(meterCalls, 0);
  assert.equal(providerCalls, 0);
});

await test("onlyPending=false rejects a narrowed subset with 409 before claim", async () => {
  const response = await POST(request(false, [FACEBOOK_ID]));
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "invalid_confirmation");
  assert.equal(claimCalls, 0);
  assert.equal(meterCalls, 0);
  assert.equal(providerCalls, 0);
});

await test("onlyPending=false accepts the exact full social set", async () => {
  priorIntentId = null;
  const response = await POST(request(false, [FACEBOOK_ID, INSTAGRAM_ID]));
  assert.equal(response.status, 402, "the quota fake proves the request passed selection and durable claim");
  assert.equal(claimCalls, 1);
  assert.equal(meterCalls, 1);
  assert.equal(providerCalls, 0);
});

await test("onlyPending=true accepts only an authoritative failed+retryAllowed subset", async () => {
  authoritative.set(FACEBOOK_ID, { status: "failed", retryAllowed: true });
  authoritative.set(INSTAGRAM_ID, { status: "published", retryAllowed: false });
  const response = await POST(request(true, [FACEBOOK_ID]));
  assert.equal(response.status, 402);
  assert.equal(claimCalls, 1);
  assert.equal(meterCalls, 1);
  assert.equal(providerCalls, 0);
});

await test("a private Instagram Reel uses the durable v76/v79 branch and never claims the legacy generic ledger", async () => {
  priorIntentId = null;
  meterResult = { kind: "consumed", fresh: true };
  invokeDurableProvider = true;
  privateConnectionAvailable = true;
  const reel = request(false, [INSTAGRAM_ID]);
  reel.json = async () => ({
    postId: DRAFT_ID,
    post: { imageUrls: [], videoUrls: [`/api/storage-media?path=${encodeURIComponent(`${OWNER}/uploads/reel.mp4`)}`], title: "Reel", caption: "Caption" },
    destinations: [{ provider: "instagram", socialConnectionId: "ig-connection" }],
    confirmation: {
      intentId: `publish:${CONTENT_ID}:reel-route-test`, fingerprint: "f".repeat(64), draftId: DRAFT_ID, contentId: CONTENT_ID,
      confirmedAt: "2026-09-01T12:00:02.000Z", onlyPending: false, mode: { kind: "now" },
      media: [{ id: "reel-1", kind: "video", url: `/api/storage-media?path=${encodeURIComponent(`${OWNER}/uploads/reel.mp4`)}`, source: "upload", width: 1080, height: 1920, durationMs: 8_000 }],
      blockers: [], priorIntentId: null, dispatchDestinationIds: [INSTAGRAM_ID],
      publishableDestinations: [destinations[1]], destinations: [destinations[1]],
    },
  });
  const response = await POST(reel);
  assert.equal(response.status, 201);
  assert.equal(durableReelCalls, 1);
  assert.deepEqual(events, ["meter", "durable", "provider"], "quota consumption must happen before the durable path can reach the provider");
  assert.equal(jobCalls, 1, "the social job projection must start after metering and before the durable provider path");
  assert.equal(outcomeCalls, 1, "the durable result must be projected into the social job outcome");
  assert.equal(claimCalls, 0, "private Reel must not call publish_intent_claim_destinations");
  assert.equal(providerCalls, 1);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(JSON.stringify(body).includes("private"), false, "signed URL fragments must not enter the response");
});

await test("a materialization failure releases a fresh consume without reaching the generic claim", async () => {
  priorIntentId = null;
  meterResult = { kind: "consumed", fresh: true };
  durableOutcome = { outcome: "failed", retryAllowed: true, evidence: { reason: "materialization_failed" } };
  const reel = request(false, [INSTAGRAM_ID]);
  reel.json = async () => ({
    postId: DRAFT_ID, post: { imageUrls: [], videoUrls: [`/api/storage-media?path=${encodeURIComponent(`${OWNER}/uploads/reel.mp4`)}`], title: "Reel", caption: "Caption" },
    destinations: [{ provider: "instagram", socialConnectionId: "ig-connection" }],
    confirmation: { intentId: `publish:${CONTENT_ID}:reel-not-sent`, fingerprint: "f".repeat(64), draftId: DRAFT_ID, contentId: CONTENT_ID, confirmedAt: "2026-09-01T12:00:02.000Z", onlyPending: false, mode: { kind: "now" }, media: [{ id: "reel-1", kind: "video", url: `/api/storage-media?path=${encodeURIComponent(`${OWNER}/uploads/reel.mp4`)}`, source: "upload", width: 1080, height: 1920, durationMs: 8_000 }], blockers: [], priorIntentId: null, dispatchDestinationIds: [INSTAGRAM_ID], publishableDestinations: [destinations[1]], destinations: [destinations[1]] },
  });
  const response = await POST(reel);
  assert.equal(response.status, 422);
  assert.equal(releaseCalls, 1);
  assert.equal(jobCalls, 1, "a pre-network failure is still represented by a social job");
  assert.equal(outcomeCalls, 1, "a pre-network failure is recorded before its charge is released");
  assert.equal(claimCalls, 0);
});

await test("an active private Reel replay does not overwrite an existing terminal social job projection", async () => {
  priorIntentId = null;
  meterResult = { kind: "consumed", fresh: true };
  durableOutcome = { outcome: "in_progress", retryAllowed: false, evidence: { provider: "instagram" } };
  const reel = request(false, [INSTAGRAM_ID]);
  reel.json = async () => ({
    postId: DRAFT_ID, post: { imageUrls: [], videoUrls: [`/api/storage-media?path=${encodeURIComponent(`${OWNER}/uploads/reel.mp4`)}`], title: "Reel", caption: "Caption" },
    destinations: [{ provider: "instagram", socialConnectionId: "ig-connection" }],
    confirmation: { intentId: `publish:${CONTENT_ID}:reel-in-progress`, fingerprint: "f".repeat(64), draftId: DRAFT_ID, contentId: CONTENT_ID, confirmedAt: "2026-09-01T12:00:02.000Z", onlyPending: false, mode: { kind: "now" }, media: [{ id: "reel-1", kind: "video", url: `/api/storage-media?path=${encodeURIComponent(`${OWNER}/uploads/reel.mp4`)}`, source: "upload", width: 1080, height: 1920, durationMs: 8_000 }], blockers: [], priorIntentId: null, dispatchDestinationIds: [INSTAGRAM_ID], publishableDestinations: [destinations[1]], destinations: [destinations[1]] },
  });
  const response = await POST(reel);
  assert.equal(response.status, 409);
  assert.equal(durableReelCalls, 1);
  assert.equal(jobCalls, 1, "the existing intent job may be looked up/reused");
  assert.equal(outcomeCalls, 0, "a non-terminal replay must not overwrite a previously published projection");
  assert.equal(claimCalls, 0);
});

await test("a private Reel fan-out fails closed instead of sending its Instagram leg to the legacy generic claim", async () => {
  priorIntentId = null;
  const raw = request(false, [FACEBOOK_ID, INSTAGRAM_ID]);
  raw.json = async () => ({
    postId: DRAFT_ID,
    post: { imageUrls: [], videoUrls: [`/api/storage-media?path=${encodeURIComponent(`${OWNER}/uploads/reel.mp4`)}`], title: "Reel", caption: "Caption" },
    destinations: destinations.map(destination => ({ provider: destination.provider, socialConnectionId: destination.socialConnectionId })),
    confirmation: {
      intentId: `publish:${CONTENT_ID}:reel-fanout-test`, fingerprint: "f".repeat(64), draftId: DRAFT_ID, contentId: CONTENT_ID,
      confirmedAt: "2026-09-01T12:00:02.000Z", onlyPending: false, mode: { kind: "now" },
      media: [{ id: "reel-1", kind: "video", url: `/api/storage-media?path=${encodeURIComponent(`${OWNER}/uploads/reel.mp4`)}`, source: "upload", width: 1080, height: 1920, durationMs: 8_000 }],
      blockers: [], priorIntentId: null, dispatchDestinationIds: [FACEBOOK_ID, INSTAGRAM_ID], publishableDestinations: destinations, destinations,
    },
  });
  const response = await POST(raw);
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { code: string }).code, "instagram_reels_private_fanout_unsupported");
  assert.equal(claimCalls, 0);
  assert.equal(providerCalls, 0);
});

for (const [label, status, retryAllowed] of [
  ["an in-flight claim", "claimed", false],
  ["published", "published", false],
  ["delivery_unknown", "delivery_unknown", false],
  ["failed without retry permission", "failed", false],
] as const) {
  await test(`onlyPending=true rejects ${label} with 409 before claim`, async () => {
    authoritative.set(FACEBOOK_ID, { status, retryAllowed });
    const response = await POST(request(true, [FACEBOOK_ID]));
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, "retry_destination_not_allowed");
    assert.equal(claimCalls, 0);
    assert.equal(meterCalls, 0);
    assert.equal(providerCalls, 0);
  });
}

console.log(`\nPublish social retry route: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
})();

