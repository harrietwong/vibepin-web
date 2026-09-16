import type { PinDraft } from "@/lib/pinDraftStore";
import {
  buildPublishConfirmation,
  confirmPublishSnapshot,
  sha256Hex,
  stablePublishString,
  type ConfirmedPublishReceipt,
} from "@/lib/studio/publishConfirmation";
import type { DurableVideoPublishResult } from "./v76PinterestVideoPublish";

export type DueVideoReceiptInput = {
  draftId: string;
  updatedAt: string;
  scheduledAt: string;
  payload: Record<string, unknown>;
};

/**
 * Rebuild the confirmed snapshot a scheduled row authorized.  The action id is a
 * stable identity for this exact schedule; a stale-claim replay therefore reaches
 * the same v76 intent instead of minting a second provider attempt.
 */
export function buildDueVideoReceipt(input: DueVideoReceiptInput): ConfirmedPublishReceipt {
  const revisionMs = Date.parse(input.updatedAt);
  if (!Number.isFinite(revisionMs)) throw new Error("publish_source_revision_invalid");
  const actionId = sha256Hex(stablePublishString({
    draftId: input.draftId,
    scheduledAt: input.scheduledAt,
  })).slice(0, 32);
  const draft = {
    ...input.payload,
    id: input.draftId,
    // v76 stores canonical UTC milliseconds. PostgREST may return six fractional
    // digits; normalize without changing the represented database instant.
    updatedAt: new Date(revisionMs).toISOString(),
  } as PinDraft;
  return confirmPublishSnapshot(buildPublishConfirmation(draft, {
    mode: { kind: "now" },
    onlyPending: false,
    actionId,
  }), input.scheduledAt);
}

export function confirmedMediaKind(
  receipt: Pick<ConfirmedPublishReceipt, "media">,
): "image" | "video" | "unsupported" {
  if (receipt.media.length === 1 && receipt.media[0]?.kind === "video") return "video";
  if (receipt.media.length > 0 && receipt.media.every(item => item.kind === "image")) return "image";
  return "unsupported";
}

export function videoPublishHttpResult(result: DurableVideoPublishResult): {
  status: number;
  body: Record<string, unknown>;
} {
  if (result.outcome === "published") {
    return {
      status: result.replayed ? 200 : 201,
      body: {
        ok: true,
        replayed: result.replayed === true,
        pin: { id: result.remoteId, url: result.remoteUrl },
        retryAllowed: false,
        remoteEvidence: result.evidence ?? {},
      },
    };
  }
  if (result.outcome === "delivery_unknown") {
    return {
      status: 409,
      body: {
        ok: false,
        error: "Delivery status is unknown. Reconcile the original intent before retrying.",
        code: "delivery_unknown",
        retryAllowed: false,
        reconcileRequired: result.reconcileRequired === true,
        remoteEvidence: result.evidence ?? {},
      },
    };
  }
  if (result.outcome === "in_progress") {
    return {
      status: 409,
      body: {
        ok: false,
        error: "This publish intent is already in progress.",
        code: "publish_in_progress",
        retryAllowed: false,
      },
    };
  }
  if (result.outcome === "not_due") {
    return {
      status: 409,
      body: {
        ok: false,
        error: "This scheduled publish is not due.",
        code: "publish_not_due",
        retryAllowed: false,
      },
    };
  }
  return {
    status: 422,
    body: {
      ok: false,
      error: "Pinterest rejected the video publish.",
      code: "pinterest_video_publish_failed",
      retryAllowed: result.retryAllowed,
      remoteEvidence: result.evidence ?? {},
    },
  };
}
