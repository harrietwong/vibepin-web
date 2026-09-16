import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublishDestination } from "@/lib/contentDraftModel";
import type { ConfirmedPublishReceipt } from "@/lib/studio/publishConfirmation";
import {
  consumeScheduledPost,
  deriveScheduledPostKey,
  immediateBucketForNow,
  releaseScheduledPost,
  scheduledPostLimitResponseBody,
  signImmediateBucket,
  usageEnforceFor,
} from "@/lib/server/usage/meterScheduledPost";
import {
  newPublishAttemptId,
  PUBLISH_EVENT_ATTEMPTED,
  PUBLISH_EVENT_SUCCEEDED,
  recordFailedPublishEvent,
  recordPublishEvent,
  type PublishEventBase,
} from "@/lib/server/publishEvents";
import { videoPublishHttpResult } from "./v76PinterestVideoBindings";
import { dispatchSupabaseV76PinterestVideo } from "./v76PinterestVideoServer";

export async function publishImmediateV76PinterestVideo(input: {
  db: SupabaseClient;
  uid: string;
  receipt: ConfirmedPublishReceipt;
  destination: PublishDestination;
  draftId: string | null;
  sourcePinId: string;
}): Promise<Response> {
  const boardId = input.destination.boardId?.trim() ?? "";
  const startedAt = Date.now();
  const eventBase: PublishEventBase = {
    publishAttemptId: newPublishAttemptId(),
    userId: input.uid,
    draftId: input.draftId,
    boardId,
    source: "immediate",
  };
  void recordPublishEvent(input.db, PUBLISH_EVENT_ATTEMPTED, eventBase);
  const mintedAt = Date.now();
  const meteringBucket = immediateBucketForNow(mintedAt);
  const meteringBucketSig = input.draftId
    ? signImmediateBucket(input.uid, input.draftId, meteringBucket, mintedAt)
    : undefined;
  const meterIdentity = input.draftId ?? (input.sourcePinId || null);
  let meterKey: string | null = null;
  let meterFresh = false;
  if (meterIdentity) {
    meterKey = deriveScheduledPostKey(input.uid, meterIdentity, undefined, meteringBucket);
    const consumed = await consumeScheduledPost({
      userId: input.uid,
      key: meterKey,
      referenceId: meterIdentity,
      metadata: { source: "immediate" },
    });
    meterFresh = consumed.kind === "consumed" && consumed.fresh === true;
    if (consumed.kind === "insufficient" && usageEnforceFor("scheduled_post")) {
      void recordFailedPublishEvent(input.db, eventBase, Date.now() - startedAt, {
        code: "scheduled_post_limit_reached", message: "Scheduled post limit reached",
      });
      return Response.json(scheduledPostLimitResponseBody(), { status: 402 });
    }
  }
  const refundNotSent = async () => {
    if (!meterFresh || !meterKey || !meterIdentity) return;
    await releaseScheduledPost({
      userId: input.uid,
      key: meterKey,
      reason: "not_sent",
      referenceId: meterIdentity,
      metadata: { source: "immediate", route: "pinterest_pins_video" },
    });
  };

  try {
    const result = await dispatchSupabaseV76PinterestVideo(input.db, {
      uid: input.uid,
      receipt: input.receipt,
      destination: input.destination,
    });
    if (result.outcome === "failed") await refundNotSent();
    if (result.outcome === "published") {
      void recordPublishEvent(input.db, PUBLISH_EVENT_SUCCEEDED, {
        ...eventBase,
        durationMs: Date.now() - startedAt,
        remotePinId: result.remoteId,
        remotePinUrl: result.remoteUrl,
      });
    } else if (result.outcome !== "in_progress") {
      void recordFailedPublishEvent(input.db, eventBase, Date.now() - startedAt, {
        code: result.outcome,
        message: result.outcome === "delivery_unknown"
          ? "Video delivery is unknown and requires reconciliation."
          : "Video publish failed.",
      });
    }
    const mapped = videoPublishHttpResult(result);
    return Response.json({
      ...mapped.body,
      board: { id: boardId, name: input.destination.boardName ?? "" },
      connectionId: input.destination.socialConnectionId,
      intentId: input.receipt.intentId,
      meteringBucket,
      ...(meteringBucketSig ? { meteringBucketSig, meteringBucketMintedAt: mintedAt } : {}),
    }, { status: mapped.status });
  } catch (error) {
    // Post-attempt ambiguity is converted inside the v76 orchestrator. An escaping
    // exception happened before provider dispatch and is safe to classify not-sent.
    await refundNotSent();
    void recordFailedPublishEvent(input.db, eventBase, Date.now() - startedAt, error);
    const message = error instanceof Error ? error.message : "materialization_required";
    const materialization = /source|media|materializ|owner|provenance|destination/.test(message);
    return Response.json({
      error: materialization
        ? "The frozen private video could not be materialized for this owner and revision."
        : "Could not establish durable video publishing.",
      code: materialization ? "materialization_required" : "publish_intent_unavailable",
    }, { status: materialization ? 409 : 503 });
  }
}
