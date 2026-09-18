/**
 * Durable Pinterest-video orchestration tests.
 *
 * DB, Storage and Pinterest are represented only at their explicit boundaries;
 * no test in this file can contact an external service.
 */

import assert from "node:assert/strict";
import {
  dispatchV76PinterestVideo,
  createV76RpcVideoPublishDependencies,
  type DurableVideoPublishDependencies,
  type DurableVideoPublishInput,
  type DurableVideoPublishState,
  type MaterializedVideoSource,
} from "../src/lib/server/publish/v76PinterestVideoPublish";
import { validateImmediatePublishReceipt } from "../src/lib/server/publish/confirmationReceipt";
import { publishConfirmationFingerprint } from "../src/lib/studio/publishConfirmation";
import {
  materializePrivateVideoSources,
  type PrivateVideoMaterializationBoundary,
} from "../src/lib/server/publish/v76PinterestVideoRuntime";
import {
  buildDueVideoReceipt,
  videoPublishHttpResult,
} from "../src/lib/server/publish/v76PinterestVideoBindings";

const receipt = {
  intentId: "publish:content-1:action1234",
  priorIntentId: null,
  fingerprint: "a".repeat(64),
  draftId: "draft-1",
  contentId: "content-1",
  sourceUpdatedAt: "2026-09-16T12:00:00.000Z",
  title: "Video Pin",
  description: "Description",
  altText: "Demo video",
  destinationUrl: "https://shop.test/item",
  media: [{
    id: "video-1",
    kind: "video" as const,
    url: "/api/storage-media?path=owner-1%2Fuploads%2Fvideo.mp4",
    source: "upload" as const,
    width: 1080,
    height: 1920,
    durationMs: 8_000,
  }],
  mode: { kind: "now" as const },
  destinations: [{
    id: "pinterest:connection-1",
    provider: "pinterest" as const,
    socialConnectionId: "connection-1",
    boardId: "board-1",
  }],
  publishableDestinations: [{
    id: "pinterest:connection-1",
    provider: "pinterest" as const,
    socialConnectionId: "connection-1",
    boardId: "board-1",
  }],
  dispatchDestinationIds: ["pinterest:connection-1"],
  blockers: [],
  onlyPending: true,
  confirmedAt: "2026-09-16T12:00:01.000Z",
};

const source: MaterializedVideoSource = {
  mediaId: "video-1",
  ordinal: 0,
  bucketId: "generated-private",
  sourceObjectPath: "owner-1/uploads/video.mp4",
  objectPath: "owner-1/publish/content-1/video-1.mp4",
  contentType: "video/mp4",
  byteSize: 11,
  checksumSha256: "b".repeat(64),
  fileName: "video-1.mp4",
  file: new Blob(["video-data"], { type: "video/mp4" }),
};

function input(overrides: Partial<DurableVideoPublishInput> = {}): DurableVideoPublishInput {
  return {
    uid: "owner-1",
    receipt,
    destination: receipt.publishableDestinations[0],
    nowMs: Date.parse("2026-09-16T12:00:02.000Z"),
    ...overrides,
  };
}

function harness(state: DurableVideoPublishState = { kind: "missing" }) {
  const calls: string[] = [];
  let inspection = state;
  const deps: DurableVideoPublishDependencies = {
    inspect: async () => { calls.push("inspect"); return inspection; },
    confirmPrepare: async () => { calls.push("confirm"); },
    leaseMaterialization: async () => {
      calls.push("lease");
      return { leaseToken: "lease-1", deliveryId: "delivery-1" };
    },
    materializeSources: async () => { calls.push("materialize"); return [source]; },
    loadReadySources: async () => { calls.push("load-ready"); return [source]; },
    settleItem: async () => { calls.push("settle-item"); return { deliveryReady: true }; },
    claimReady: async () => { calls.push("claim"); return { claimToken: "claim-1", attempt: 1 }; },
    startAttempt: async () => {
      calls.push("attempt-start");
      inspection = { kind: "attempt_started", attemptId: "attempt-1", claimToken: "claim-1", stale: false };
      return { attemptId: "attempt-1", status: "started", replayed: false };
    },
    publishVideo: async () => {
      calls.push("provider");
      return {
        outcome: "succeeded",
        evidence: {
          stage: "created",
          classification: "succeeded",
          mediaId: "provider-media-1",
          pinId: "12345",
          pinUrl: "https://www.pinterest.com/pin/12345/",
        },
      };
    },
    settleAttempt: async (_input, status) => { calls.push(`attempt-settle:${status}`); },
  };
  return { calls, deps, setState: (next: DurableVideoPublishState) => { inspection = next; } };
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}\n      ${(error as Error).stack ?? String(error)}`);
  }
}

async function main(): Promise<void> {
await test("confirmation fingerprints freeze media kind and video identity", async () => {
  const shared = {
    priorIntentId: null,
    draftId: "draft-1",
    contentId: "content-1",
    sourceUpdatedAt: "2026-09-16T12:00:00.000Z",
    title: "Video Pin",
    description: "Description",
    altText: "Demo video",
    destinationUrl: "https://shop.test/item",
    mode: { kind: "now" as const },
    destinations: receipt.destinations,
    dispatchDestinationIds: receipt.dispatchDestinationIds,
    blockers: [],
    onlyPending: true,
  };
  const image = publishConfirmationFingerprint({
    ...shared,
    media: [{ id: "video-1", url: receipt.media[0].url, kind: "image", durationMs: null }],
  } as Parameters<typeof publishConfirmationFingerprint>[0]);
  const video = publishConfirmationFingerprint({
    ...shared,
    media: [{ id: "video-1", url: receipt.media[0].url, kind: "video", durationMs: 8_000 }],
  } as Parameters<typeof publishConfirmationFingerprint>[0]);
  assert.notEqual(video, image);
});

await test("server confirmation preserves an exact video media snapshot instead of coercing it to image", async () => {
  const raw = {
    ...receipt,
    fingerprint: publishConfirmationFingerprint({
      ...receipt,
      media: receipt.media,
    } as Parameters<typeof publishConfirmationFingerprint>[0]),
  };
  const result = validateImmediatePublishReceipt(raw, {
    draftId: receipt.draftId,
    title: receipt.title,
    description: receipt.description,
    destinationUrl: receipt.destinationUrl,
    altText: receipt.altText,
    imageUrls: [receipt.media[0].url],
  }, receipt.dispatchDestinationIds, Date.parse("2026-09-16T12:00:02.000Z"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.receipt.media[0].kind, "video");
});

await test("due execution rebuilds one deterministic now-mode receipt from the frozen database revision", async () => {
  const payload = {
    id: receipt.draftId,
    contentId: receipt.contentId,
    title: receipt.title,
    description: receipt.description,
    altText: receipt.altText,
    destinationUrl: receipt.destinationUrl,
    media: receipt.media,
    imageUrl: receipt.media[0].url,
    scheduledDestinations: receipt.destinations,
  };
  const first = buildDueVideoReceipt({
    draftId: receipt.draftId,
    updatedAt: receipt.sourceUpdatedAt,
    scheduledAt: "2026-09-16T12:00:00.000Z",
    payload,
  });
  const replay = buildDueVideoReceipt({
    draftId: receipt.draftId,
    updatedAt: receipt.sourceUpdatedAt,
    scheduledAt: "2026-09-16T12:00:00.000Z",
    payload,
  });
  assert.equal(first.intentId, replay.intentId);
  assert.deepEqual(first.mode, { kind: "now" });
  assert.equal(first.sourceUpdatedAt, receipt.sourceUpdatedAt);
  assert.equal(first.media[0].kind, "video");
  const precise = buildDueVideoReceipt({
    draftId: receipt.draftId,
    updatedAt: "2026-09-16T12:00:00.123456+00:00",
    scheduledAt: "2026-09-16T12:00:00.000Z",
    payload,
  });
  assert.equal(precise.sourceUpdatedAt, "2026-09-16T12:00:00.123Z");
});

await test("HTTP binding exposes unknown as anti-retry reconciliation, not ordinary failure", async () => {
  assert.deepEqual(videoPublishHttpResult({
    outcome: "delivery_unknown",
    retryAllowed: false,
    reconcileRequired: true,
    evidence: { reason: "provider_settlement_unavailable" },
  }), {
    status: 409,
    body: {
      ok: false,
      error: "Delivery status is unknown. Reconcile the original intent before retrying.",
      code: "delivery_unknown",
      retryAllowed: false,
      reconcileRequired: true,
      remoteEvidence: { reason: "provider_settlement_unavailable" },
    },
  });
});

await test("orders confirm, materialization, ready claim, durable attempt, provider, and success settlement", async () => {
  const { calls, deps } = harness();
  const result = await dispatchV76PinterestVideo(input(), deps);
  assert.equal(result.outcome, "published");
  assert.deepEqual(calls, [
    "inspect", "confirm", "lease", "materialize", "settle-item", "claim",
    "attempt-start", "provider", "attempt-settle:succeeded",
  ]);
});

await test("the production RPC adapter uses additive v78 recovery and v79 provenance RPCs over the v76 ledger", async () => {
  const rpcNames: string[] = [];
  let settlementArgs: Record<string, unknown> | null = null;
  const deps = createV76RpcVideoPublishDependencies({
    inspect: async () => ({ kind: "missing" }),
    materializeSources: async () => [source],
    loadReadySources: async () => [source],
    publishVideo: async () => ({
      outcome: "succeeded",
      evidence: { stage: "created", classification: "succeeded", pinId: "12345", pinUrl: "https://www.pinterest.com/pin/12345/" },
    }),
    rpc: async (name, args) => {
      rpcNames.push(name);
      if (name === "publish_asset_settle_video_item_v79") settlementArgs = args;
      const values: Record<string, unknown> = {
        publish_intent_confirm_prepare_v78: { prepared: true },
        publish_asset_lease_materialization: { leaseToken: "lease-1", deliveryId: "delivery-1" },
        publish_asset_settle_video_item_v79: { deliveryReady: true },
        publish_asset_claim_ready_v78: { claimToken: "claim-1" },
        publish_provider_attempt_start: { attemptId: "attempt-1", status: "started", replayed: false },
        publish_provider_attempt_settle_v78: { settled: true },
      };
      return values[name];
    },
  });
  assert.equal((await dispatchV76PinterestVideo(input(), deps)).outcome, "published");
  assert.deepEqual(rpcNames, [
    "publish_intent_confirm_prepare_v78",
    "publish_asset_lease_materialization",
    "publish_asset_settle_video_item_v79",
    "publish_asset_claim_ready_v78",
    "publish_provider_attempt_start",
    "publish_provider_attempt_settle_v78",
  ]);
  assert.deepEqual(settlementArgs, {
    p_user_id: "owner-1",
    p_intent_id: receipt.intentId,
    p_destination_id: receipt.destinations[0].id,
    p_lease_token: "lease-1",
    p_source_media_key: "video-1",
    p_media_ordinal: 0,
    p_source_bucket_id: "generated-private",
    p_source_object_path: "owner-1/uploads/video.mp4",
    p_target_bucket_id: "generated-private",
    p_target_object_path: "owner-1/publish/content-1/video-1.mp4",
    p_server_checksum_sha256: "b".repeat(64),
  });
});

await test("provider settlement preserves adapter evidence and provider HTTP status while adding orchestrator context", async () => {
  const settlement = { args: null as Record<string, unknown> | null };
  const deps = createV76RpcVideoPublishDependencies({
    inspect: async () => ({ kind: "missing" }),
    materializeSources: async () => [source],
    loadReadySources: async () => [source],
    publishVideo: async () => ({
      outcome: "failed",
      evidence: {
        stage: "created",
        classification: "definite_rejection",
        mediaId: "media-1",
        requestId: "request-1",
        providerStatus: 400,
        providerCode: "board.invalid",
      },
    }),
    rpc: async (name, args) => {
      if (name === "publish_provider_attempt_settle_v78") settlement.args = args;
      const values: Record<string, unknown> = {
        publish_intent_confirm_prepare_v78: { prepared: true },
        publish_asset_lease_materialization: { leaseToken: "lease-1", deliveryId: "delivery-1" },
        publish_asset_settle_video_item_v79: { deliveryReady: true },
        publish_asset_claim_ready_v78: { claimToken: "claim-1" },
        publish_provider_attempt_start: { attemptId: "attempt-1", status: "started", replayed: false },
        publish_provider_attempt_settle_v78: { settled: true },
      };
      return values[name];
    },
  });
  assert.equal((await dispatchV76PinterestVideo(input(), deps)).outcome, "failed");
  assert.equal(settlement.args?.p_provider_status, 400);
  assert.deepEqual(settlement.args?.p_evidence, { provider: "pinterest", reason: "provider_rejected" });
});

await test("private materialization freezes the owner source revision and rejects owner/path tampering before copy", async () => {
  const copied: string[] = [];
  const boundary: PrivateVideoMaterializationBoundary = {
    loadDraft: async () => ({
      updatedAt: receipt.sourceUpdatedAt,
      payload: { title: receipt.title, description: receipt.description, altText: receipt.altText, destinationUrl: receipt.destinationUrl, media: receipt.media },
    }),
    findProvenance: async (_uid, _bucket, objectPath) => ({
      ownerUserId: "owner-1",
      bucketId: "generated-private",
      objectPath,
      mediaKind: "video",
      contentType: "video/mp4",
      byteSize: 10,
      checksumSha256: "3e66ede228ae2f3f6cf3c95cb1fba47226b630fa25b4da48f3438fcb7c9d6376",
      width: 1080,
      height: 1920,
      durationMs: 8_000,
      contentTypeSource: "storage_head_verified",
      byteSizeSource: "storage_head_verified",
      checksumSource: "storage_digest_verified",
      dimensionsSource: "browser_declared",
      durationSource: "browser_declared",
      lifecycleState: "draft",
    }),
    download: async () => new Blob(["video-data"], { type: "video/mp4" }),
    storePublishCopy: async args => { copied.push(args.targetPath); },
  };
  const exact = await materializePrivateVideoSources(input(), { leaseToken: "lease-1", deliveryId: "delivery-1" }, boundary);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].sourceObjectPath, "owner-1/uploads/video.mp4");
  assert.equal(exact[0].objectPath.startsWith("owner-1/publish/"), true);
  assert.equal(copied.length, 1);

  copied.length = 0;
  const loadOriginal = boundary.loadDraft;
  boundary.loadDraft = async () => ({
    updatedAt: receipt.sourceUpdatedAt,
    payload: { title: receipt.title, description: receipt.description, altText: receipt.altText, destinationUrl: receipt.destinationUrl, media: [{ ...receipt.media[0], coverFrameTimeMs: 1250 }] },
  });
  await assert.rejects(materializePrivateVideoSources(input(), { leaseToken: "lease-1", deliveryId: "delivery-1" }, boundary), /publish_source_media_conflict/);
  assert.equal(copied.length, 0, "cover change invalidates old exact source before copying");
  boundary.loadDraft = loadOriginal;
  boundary.loadDraft = async () => ({
    updatedAt: "2026-09-16T12:00:03.000Z",
    payload: { title: receipt.title, description: receipt.description, altText: receipt.altText, destinationUrl: receipt.destinationUrl, media: receipt.media },
  });
  assert.equal((await materializePrivateVideoSources(
    input(),
    { leaseToken: "lease-1", deliveryId: "delivery-1" },
    boundary,
  )).length, 1);
  assert.equal(copied.length, 1);
  copied.length = 0;

  const verifiedProvenance = boundary.findProvenance;
  boundary.findProvenance = async (...args) => ({
    ...(await verifiedProvenance(...args))!,
    checksumSha256: "c".repeat(64),
  });
  await assert.rejects(
    materializePrivateVideoSources(input(), { leaseToken: "lease-1", deliveryId: "delivery-1" }, boundary),
    /video_source_bytes_conflict/,
  );
  assert.equal(copied.length, 0);
  boundary.findProvenance = verifiedProvenance;

  const tampered = input({
    receipt: {
      ...receipt,
      media: [{ ...receipt.media[0], url: "/api/storage-media?path=owner-2%2Fuploads%2Fvideo.mp4" }],
    },
  });
  boundary.loadDraft = async () => ({ updatedAt: receipt.sourceUpdatedAt, payload: { title: receipt.title, description: receipt.description, altText: receipt.altText, destinationUrl: receipt.destinationUrl, media: tampered.receipt.media } });
  await assert.rejects(
    materializePrivateVideoSources(tampered, { leaseToken: "lease-1", deliveryId: "delivery-1" }, boundary),
    /video_source_owner_mismatch/,
  );
  assert.equal(copied.length, 0);
});

await test("private materialization rejects incomplete fact provenance before uploading a copy", async () => {
  let copied = false;
  const boundary: PrivateVideoMaterializationBoundary = {
    loadDraft: async () => ({
      updatedAt: receipt.sourceUpdatedAt,
      payload: { title: receipt.title, description: receipt.description, altText: receipt.altText, destinationUrl: receipt.destinationUrl, media: receipt.media },
    }),
    findProvenance: async (_uid, _bucket, objectPath) => ({
      ownerUserId: "owner-1", bucketId: "generated-private", objectPath,
      mediaKind: "video", contentType: "video/mp4", byteSize: 10,
      checksumSha256: "3e66ede228ae2f3f6cf3c95cb1fba47226b630fa25b4da48f3438fcb7c9d6376",
      width: 1080, height: 1920, durationMs: 8_000,
      contentTypeSource: "storage_head_verified", byteSizeSource: "storage_head_verified",
      checksumSource: "storage_digest_verified", dimensionsSource: "browser_declared",
      durationSource: null, lifecycleState: "draft",
    }),
    download: async () => new Blob(["video-data"], { type: "video/mp4" }),
    storePublishCopy: async () => { copied = true; },
  };
  await assert.rejects(
    materializePrivateVideoSources(input(), { leaseToken: "lease-1", deliveryId: "delivery-1" }, boundary),
    /video_source_provenance_invalid/,
  );
  assert.equal(copied, false);
});

await test("private materialization promotes an unavailable source digest only from server-read bytes", async () => {
  const boundary: PrivateVideoMaterializationBoundary = {
    loadDraft: async () => ({
      updatedAt: receipt.sourceUpdatedAt,
      payload: { title: receipt.title, description: receipt.description, altText: receipt.altText, destinationUrl: receipt.destinationUrl, media: receipt.media },
    }),
    findProvenance: async (_uid, _bucket, objectPath) => ({
      ownerUserId: "owner-1", bucketId: "generated-private", objectPath,
      mediaKind: "video", contentType: "video/mp4", byteSize: 10,
      checksumSha256: null,
      width: 1080, height: 1920, durationMs: 8_000,
      contentTypeSource: "storage_head_verified", byteSizeSource: "storage_head_verified",
      checksumSource: "unavailable", dimensionsSource: "browser_declared",
      durationSource: "browser_declared", lifecycleState: "draft",
    }),
    download: async () => new Blob(["video-data"], { type: "video/mp4" }),
    storePublishCopy: async () => undefined,
  };
  const [materialized] = await materializePrivateVideoSources(
    input(),
    { leaseToken: "lease-1", deliveryId: "delivery-1" },
    boundary,
  );
  assert.equal(materialized.checksumSha256, "3e66ede228ae2f3f6cf3c95cb1fba47226b630fa25b4da48f3438fcb7c9d6376");
});

await test("future schedules and out-of-window runs do not prepare, claim, or call Pinterest", async () => {
  for (const blocked of [
    input({ scheduleAt: "2026-09-16T12:01:00.000Z" }),
    input({ latestStartMs: Date.parse("2026-09-16T12:00:01.000Z") }),
  ]) {
    const { calls, deps } = harness();
    const result = await dispatchV76PinterestVideo(blocked, deps);
    assert.equal(result.outcome, "not_due");
    assert.deepEqual(calls, []);
  }
});

await test("lease competition and an all-items-ready refusal stop before provider dispatch", async () => {
  const leased = harness();
  leased.deps.leaseMaterialization = async () => { leased.calls.push("lease"); throw new Error("materialization_already_leased"); };
  assert.equal((await dispatchV76PinterestVideo(input(), leased.deps)).outcome, "in_progress");
  assert.equal(leased.calls.includes("provider"), false);

  const unready = harness();
  unready.deps.settleItem = async () => { unready.calls.push("settle-item"); return { deliveryReady: false }; };
  assert.equal((await dispatchV76PinterestVideo(input(), unready.deps)).outcome, "in_progress");
  assert.equal(unready.calls.includes("claim"), false);
  assert.equal(unready.calls.includes("provider"), false);
});

await test("an active started attempt remains in progress and is never dispatched again", async () => {
  const { calls, deps } = harness({ kind: "attempt_started", attemptId: "attempt-old", claimToken: "claim-old", stale: false });
  const result = await dispatchV76PinterestVideo(input(), deps);
  assert.equal(result.outcome, "in_progress");
  assert.deepEqual(calls, ["inspect"]);
});

await test("an authoritatively stale started attempt becomes unknown without provider redispatch", async () => {
  const { calls, deps } = harness({ kind: "attempt_started", attemptId: "attempt-old", claimToken: "claim-old", stale: true });
  const result = await dispatchV76PinterestVideo(input(), deps);
  assert.equal(result.outcome, "delivery_unknown");
  assert.deepEqual(calls, ["inspect", "attempt-settle:unknown"]);
});

await test("published replays return success and unknown replays are anti-retry", async () => {
  const published = harness({
    kind: "published",
    remoteId: "12345",
    remoteUrl: "https://www.pinterest.com/pin/12345/",
    evidence: { provider: "pinterest" },
  });
  const replay = await dispatchV76PinterestVideo(input(), published.deps);
  assert.equal(replay.outcome, "published");
  assert.equal(replay.replayed, true);
  assert.deepEqual(published.calls, ["inspect"]);

  const unknown = harness({ kind: "delivery_unknown", evidence: { reason: "unknown_outcome" } });
  assert.equal((await dispatchV76PinterestVideo(input(), unknown.deps)).outcome, "delivery_unknown");
  assert.deepEqual(unknown.calls, ["inspect"]);

  const failedReplay = harness({ kind: "failed", evidence: { reason: "provider_rejected" } });
  const failedResult = await dispatchV76PinterestVideo(input(), failedReplay.deps);
  assert.equal(failedResult.outcome, "failed");
  assert.equal(failedResult.replayed, true);
  assert.deepEqual(failedReplay.calls, ["inspect"]);
});

await test("adapter failure and unknown settle the durable attempt without becoming success", async () => {
  for (const providerOutcome of ["failed", "unknown"] as const) {
    const { calls, deps } = harness();
    deps.publishVideo = async () => {
      calls.push("provider");
      return {
        outcome: providerOutcome,
        evidence: {
          stage: "registered",
          classification: providerOutcome === "failed" ? "definite_rejection" : "unknown",
        },
      };
    };
    const result = await dispatchV76PinterestVideo(input(), deps);
    assert.equal(result.outcome, providerOutcome === "failed" ? "failed" : "delivery_unknown");
    assert.equal(calls.at(-1), `attempt-settle:${providerOutcome}`);
  }
});

await test("an exception after durable attempt start settles unknown and cannot escape into a retry path", async () => {
  const { calls, deps } = harness();
  deps.publishVideo = async () => {
    calls.push("provider");
    throw new Error("connection lookup or provider boundary lost");
  };
  const result = await dispatchV76PinterestVideo(input(), deps);
  assert.equal(result.outcome, "delivery_unknown");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.reconcileRequired, true);
  assert.equal(calls.at(-1), "attempt-settle:unknown");
});

await test("a 201 with a Pin id but no response URL persists and returns the canonical Pinterest URL", async () => {
  const { deps } = harness();
  deps.publishVideo = async () => ({
    outcome: "succeeded",
    evidence: { stage: "created", classification: "succeeded", pinId: "12345" },
  });
  const result = await dispatchV76PinterestVideo(input(), deps);
  assert.equal(result.outcome, "published");
  assert.equal(result.remoteUrl, "https://www.pinterest.com/pin/12345/");
});

await test("a 201-equivalent success followed by settlement loss requires reconciliation and never reports retryable failure", async () => {
  const { calls, deps } = harness();
  deps.settleAttempt = async (_input, status) => {
    calls.push(`attempt-settle:${status}`);
    throw new Error("database unavailable after create");
  };
  const result = await dispatchV76PinterestVideo(input(), deps);
  assert.equal(result.outcome, "delivery_unknown");
  assert.equal(result.reconcileRequired, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(calls.filter(call => call === "provider").length, 1);
});

await test("one destination failure never mutates or suppresses a sibling success", async () => {
  const success = harness();
  const failed = harness();
  failed.deps.publishVideo = async () => ({
    outcome: "failed",
    evidence: { stage: "registered", classification: "definite_rejection" },
  });
  const [left, right] = await Promise.all([
    dispatchV76PinterestVideo(input(), success.deps),
    dispatchV76PinterestVideo(input({
      destination: { ...receipt.publishableDestinations[0], id: "pinterest:connection-2", socialConnectionId: "connection-2" },
    }), failed.deps),
  ]);
  assert.equal(left.outcome, "published");
  assert.equal(right.outcome, "failed");
  assert.equal(success.calls.includes("attempt-settle:succeeded"), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
}

void main();
