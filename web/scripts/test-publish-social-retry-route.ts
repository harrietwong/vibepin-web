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

class FakePublishIntentLedgerError extends Error {
  constructor(public readonly code: "unavailable" | "conflict" | "claim_lost", message: string) {
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
    return { createServerClient: () => ({}) };
  }
  if (request === "@/lib/server/publish/confirmationReceipt" || request.endsWith("/server/publish/confirmationReceipt")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      validateImmediatePublishReceipt: (raw: Record<string, unknown>) => ({
        ok: true,
        receipt: raw,
        destinations: raw.destinations,
      }),
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
      settlePublishIntentDestination: async () => undefined,
    };
  }
  if (request === "@/lib/social/server/socialConnectionStore" || request.endsWith("/social/server/socialConnectionStore")) {
    return {
      summarizeConnections: async () => [
        { provider: "facebook", accounts: [{ id: "fb-connection" }] },
        { provider: "instagram", accounts: [{ id: "ig-connection" }] },
      ],
      findConnection: async () => null,
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
      consumeScheduledPost: async () => { meterCalls++; return { kind: "insufficient" }; },
      deriveScheduledPostKey: () => "scheduled-post-route-test",
      releaseScheduledPost: async () => undefined,
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
        publishPost: async () => { providerCalls++; return { ok: true, status: "published" }; },
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
        destinations,
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
  assert.equal((await response.json() as { code: string }).code, "retry_destination_not_allowed");
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
