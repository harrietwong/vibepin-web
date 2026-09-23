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

export type ChildVideoReceiptInput = DueVideoReceiptInput & {
  /** The `publish_reconcile_checks` row id that authorizes this retry. */
  reconcileCheckId: string;
  /** The PARENT intent's text `intent_id` — what `priorIntentId` is compared to. */
  parentIntentId: string;
  /** `destinationResultKey(provider, connectionId)` for the one destination being re-sent. */
  destinationId: string;
};

/**
 * The receipt for a CHILD intent that re-sends one video destination whose
 * delivery was confirmed never to have happened.
 *
 * ── WHY THIS CANNOT JUST BE `buildDueVideoReceipt` ──────────────────────────
 * `publish_intent_confirm_prepare_v82` refuses unless the receipt satisfies
 * three things the parent's receipt does not (migrate_v82:440-454):
 *
 *   1. `onlyPending` is exactly `true`. The parent is built with `false`.
 *   2. `dispatchDestinationIds` has exactly ONE element.
 *   3. that element is the proof's own `destination_id` — a reconciliation
 *      vouches for the destination it examined and for no other.
 *
 * ── HOW THE SINGLETON IS ACHIEVED: NARROW THE DRAFT, NOT THE RECEIPT ────────
 * The dispatch set is derived inside `buildPublishConfirmation` and folded into
 * the fingerprint, so it cannot be edited afterwards — a patched field would
 * leave the receipt self-inconsistent, which is the failure mode that defeated
 * an earlier attempt at hand-writing this JSON. Instead the DRAFT handed to the
 * builder is narrowed to the single target destination, and the production
 * builder derives (and hashes) a one-element set by itself.
 *
 * Narrowing is also what makes this correct rather than merely accepted. With
 * `onlyPending: true` the builder drops destinations already `published` or
 * `delivery_unknown` — but a FAILED sibling (a second Pinterest account, a
 * fan-out that errored) survives that filter and would make the set two long.
 * The RPC would answer `retry_not_allowed` and the video would be stuck again,
 * with nothing on the surface to say why.
 *
 * ── AND WHY THE ACTION ID IS DERIVED FROM THE CHECK ─────────────────────────
 * The parent's action id is `sha256({draftId, scheduledAt})`; reusing it would
 * collide with the parent intent. Adding the check id makes the child id
 * deterministic PER REDEMPTION: one proof yields one child, and a crash between
 * `prepare` and dispatch replays into the same child intent rather than minting
 * a second. The RPC's single-redemption guard is written for exactly this — it
 * excludes the receipt's own `intentId` from the "already consumed" test
 * (migrate_v82:479-486), so the replay is tolerated and a genuine second
 * redemption is not.
 */
export function buildReconcileChildVideoReceipt(
  input: ChildVideoReceiptInput,
): ConfirmedPublishReceipt {
  const revisionMs = Date.parse(input.updatedAt);
  if (!Number.isFinite(revisionMs)) throw new Error("publish_source_revision_invalid");
  const actionId = sha256Hex(stablePublishString({
    draftId: input.draftId,
    scheduledAt: input.scheduledAt,
    reconcileCheckId: input.reconcileCheckId,
  })).slice(0, 32);

  const destinations = Array.isArray(input.payload.scheduledDestinations)
    ? (input.payload.scheduledDestinations as Array<Record<string, unknown>>)
    : [];
  const target = destinations.filter(item => {
    const provider = typeof item?.provider === "string" ? item.provider : "";
    const connectionId = typeof item?.socialConnectionId === "string"
      ? item.socialConnectionId.trim()
      : "";
    return `${provider}:${connectionId || "legacy"}` === input.destinationId;
  });
  // The proof names a destination this draft no longer schedules. Refusing is
  // the only safe answer: dispatching anything else would send to a destination
  // no reconciliation ever vouched for.
  if (target.length !== 1) throw new Error("reconcile_destination_not_scheduled");

  // ── The stale result row must not travel into the child ────────────────────
  // `onlyPending: true` drops any destination whose stored result is
  // `published` or `delivery_unknown` — and this destination's stored result is
  // exactly `delivery_unknown`, since that is the state reconciliation was
  // called in to settle. Carried over, it would filter out the ONE destination
  // being retried and leave an empty dispatch set, which the RPC rejects.
  //
  // Dropping it is not a convenience: the reconciliation has already
  // established, from the provider, that this delivery never happened. The row
  // describes an outcome now known to be false, and the route's own
  // `removeDestinationResult` deletes it on the same verdict. This keeps the
  // receipt consistent with the payload the next tick will read.
  //
  // Only THIS destination's row is dropped. A sibling's result is untouched —
  // narrowing `scheduledDestinations` already keeps siblings out of the child,
  // and rewriting their history here would be a lie about destinations this
  // proof says nothing about.
  const results = Array.isArray(input.payload.destinationResults)
    ? (input.payload.destinationResults as Array<Record<string, unknown>>)
      .filter(item => item?.destinationId !== input.destinationId)
    : [];

  const draft = {
    ...input.payload,
    id: input.draftId,
    updatedAt: new Date(revisionMs).toISOString(),
    scheduledDestinations: target,
    destinationResults: results,
    // Read by the builder as `priorIntentId`, and only when `onlyPending` is
    // true — which it is below. This is the lineage the RPC checks against the
    // parent's text `intent_id` (migrate_v82:457).
    publishIntentId: input.parentIntentId,
  } as unknown as PinDraft;

  const receipt = confirmPublishSnapshot(buildPublishConfirmation(draft, {
    mode: { kind: "now" },
    onlyPending: true,
    actionId,
  }), input.scheduledAt);

  // Assert the shape the RPC will demand, HERE, where the reason is legible.
  // Reaching the database with a receipt that cannot be accepted costs a round
  // trip and returns `retry_not_allowed`, which says nothing about which of the
  // three conditions failed.
  if (receipt.dispatchDestinationIds.length !== 1
      || receipt.dispatchDestinationIds[0] !== input.destinationId) {
    throw new Error("reconcile_child_dispatch_set_invalid");
  }
  if (receipt.priorIntentId !== input.parentIntentId) {
    throw new Error("reconcile_child_lineage_missing");
  }
  return receipt;
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
