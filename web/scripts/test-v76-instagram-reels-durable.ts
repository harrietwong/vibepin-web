/**
 * Durable private Instagram Reel orchestration. Every boundary is local: this
 * contract suite must never contact Storage, Supabase, or Meta.
 */
import assert from "node:assert/strict";
import {
  dispatchV76InstagramReel,
  type InstagramReelPublishDependencies,
} from "../src/lib/server/publish/v76InstagramReelsPublish";
import type { DurableVideoPublishInput, DurableVideoPublishState, MaterializedVideoSource } from "../src/lib/server/publish/v76PinterestVideoPublish";

const signedUrl = "https://storage.example.test/object/sign/frozen.mp4?token=private-token";
const originalPath = "owner-1/uploads/original.mp4";
const frozenPath = "owner-1/publish/fingerprint/0-frozen.mp4";

const receipt = {
  intentId: "publish:reel-1:action-1",
  priorIntentId: null,
  fingerprint: "a".repeat(64),
  draftId: "draft-reel-1",
  contentId: "reel-1",
  sourceUpdatedAt: "2026-09-22T12:00:00.000Z",
  title: "Reel",
  description: "Caption",
  altText: "Video",
  destinationUrl: "https://shop.example.test/item",
  media: [{ id: "video-1", kind: "video" as const, url: `/api/storage-media?path=${encodeURIComponent(originalPath)}`, source: "upload" as const, width: 1080, height: 1920, durationMs: 8_000 }],
  mode: { kind: "now" as const },
  destinations: [{ id: "instagram:connection-1", provider: "instagram" as const, socialConnectionId: "connection-1" }],
  publishableDestinations: [{ id: "instagram:connection-1", provider: "instagram" as const, socialConnectionId: "connection-1" }],
  dispatchDestinationIds: ["instagram:connection-1"],
  blockers: [],
  onlyPending: false,
  confirmedAt: "2026-09-22T12:00:01.000Z",
};

const source: MaterializedVideoSource = {
  mediaId: "video-1", ordinal: 0, bucketId: "generated-private", sourceObjectPath: originalPath,
  objectPath: frozenPath, contentType: "video/mp4", byteSize: 10, checksumSha256: "b".repeat(64),
  fileName: "frozen.mp4", file: new Blob(["video-data"], { type: "video/mp4" }),
};

function input(): DurableVideoPublishInput {
  return { uid: "owner-1", receipt, destination: receipt.publishableDestinations[0], nowMs: Date.parse("2026-09-22T12:00:02.000Z") };
}

function harness(state: DurableVideoPublishState = { kind: "missing" }) {
  const calls: string[] = [];
  let current = state;
  const deps: InstagramReelPublishDependencies = {
    inspect: async () => { calls.push("inspect"); return current; },
    confirmPrepare: async () => { calls.push("confirm"); },
    leaseMaterialization: async () => { calls.push("lease"); return { leaseToken: "lease-1", deliveryId: "delivery-1" }; },
    materializeSources: async () => { calls.push("materialize"); return [source]; },
    loadReadySources: async () => { calls.push("load-ready"); return [source]; },
    settleItem: async () => { calls.push("settle-item"); return { deliveryReady: true }; },
    claimReady: async () => { calls.push("claim"); return { claimToken: "claim-1", attempt: 1 }; },
    startAttempt: async () => { calls.push("attempt-start"); current = { kind: "attempt_started", attemptId: "attempt-1", claimToken: "claim-1", stale: false }; return { attemptId: "attempt-1", status: "started", replayed: false }; },
    publishReel: async (_input, item) => {
      calls.push(`provider:${item.objectPath}`);
      return { outcome: "succeeded", evidence: { stage: "published", classification: "succeeded", providerStatus: 200, remoteId: "ig-media-1", remoteUrl: "https://instagram.example.test/reel/1" } };
    },
    settleAttempt: async (_input, status, _attempt, result) => {
      calls.push(`attempt-settle:${status}`);
      assert.equal(JSON.stringify(result?.evidence ?? {}).includes(signedUrl), false, "signed URL must never enter durable evidence");
      assert.equal(JSON.stringify(result?.evidence ?? {}).includes(originalPath), false, "source path must never enter durable evidence");
    },
  };
  return { calls, deps };
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK   ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}\n      ${(error as Error).stack ?? String(error)}`); }
}

async function main(): Promise<void> {
  await test("orders prepare, materialization, ready claim and attempt before the Reel provider", async () => {
    const { calls, deps } = harness();
    const result = await dispatchV76InstagramReel(input(), deps);
    assert.equal(result.outcome, "published");
    assert.deepEqual(calls, ["inspect", "confirm", "lease", "materialize", "settle-item", "claim", "attempt-start", `provider:${frozenPath}`, "attempt-settle:succeeded"]);
  });

  await test("materialization failure makes zero provider calls", async () => {
    const { calls, deps } = harness();
    deps.materializeSources = async () => { calls.push("materialize"); throw new Error("private_copy_failed"); };
    await assert.rejects(() => dispatchV76InstagramReel(input(), deps), /private_copy_failed/);
    assert.equal(calls.some(call => call.startsWith("provider:")), false);
  });

  await test("the provider receives only the frozen publish copy", async () => {
    const { deps } = harness();
    deps.publishReel = async (_input, item) => {
      assert.equal(item.objectPath, frozenPath);
      assert.notEqual(item.objectPath, originalPath);
      return { outcome: "failed", evidence: { stage: "validated", classification: "definite_validation", providerStatus: 400 } };
    };
    const result = await dispatchV76InstagramReel(input(), deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.retryAllowed, true);
  });

  await test("active and unknown attempts replay without a provider call", async () => {
    const active = harness({ kind: "attempt_started", attemptId: "attempt-active", claimToken: "claim-active", stale: false });
    assert.equal((await dispatchV76InstagramReel(input(), active.deps)).outcome, "in_progress");
    assert.equal(active.calls.some(call => call.startsWith("provider:")), false);
    const unknown = harness({ kind: "delivery_unknown", evidence: { reason: "unknown" } });
    assert.equal((await dispatchV76InstagramReel(input(), unknown.deps)).outcome, "delivery_unknown");
    assert.equal(unknown.calls.some(call => call.startsWith("provider:")), false);
  });

  await test("throws, 5xx and statusless failures are delivery-unknown while 4xx without a resource retries", async () => {
    for (const [name, result, expected] of [
      ["provider throw", null, "delivery_unknown"],
      ["5xx", { outcome: "unknown" as const, evidence: { stage: "published", classification: "unknown", providerStatus: 503 } }, "delivery_unknown"],
      ["no status", { outcome: "unknown" as const, evidence: { stage: "published", classification: "unknown" } }, "delivery_unknown"],
      ["4xx", { outcome: "failed" as const, evidence: { stage: "published", classification: "definite_rejection", providerStatus: 400 } }, "failed"],
    ] as const) {
      const { deps } = harness();
      deps.publishReel = async () => { if (!result) throw new Error(name); return result; };
      const actual = await dispatchV76InstagramReel(input(), deps);
      assert.equal(actual.outcome, expected, name);
      assert.equal(actual.retryAllowed, expected === "failed", name);
    }
  });

  await test("success requires a 2xx provider status and a remote media id", async () => {
    for (const evidence of [
      { stage: "published", classification: "succeeded", remoteId: "ig-media-1" },
      { stage: "published", classification: "succeeded", providerStatus: 200 },
      { stage: "published", classification: "succeeded", providerStatus: 503, remoteId: "ig-media-1" },
    ]) {
      const { deps } = harness();
      deps.publishReel = async () => ({ outcome: "succeeded", evidence });
      const result = await dispatchV76InstagramReel(input(), deps);
      assert.equal(result.outcome, "delivery_unknown");
      assert.equal(result.retryAllowed, false);
    }
  });

  console.log(`\nInstagram durable Reels: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

void main();
