/**
 * publishDueLogic.ts — pure, DB-free helpers for the due-time publisher
 * (/api/cron/publish-due). Kept separate from the route so the claim window, the
 * payload→publish-input mapping, and the success/failure payload transforms unit-test
 * in isolation (scripts/test-publish-due-claim.ts) with no Supabase or HTTP.
 *
 * The atomic claim itself lives in the route (a single conditional UPDATE … RETURNING
 * via PostgREST), but the *predicate* it encodes — "claimable = unclaimed OR the claim
 * is older than the stale window" — is expressed here so it can be asserted directly.
 */

import { mapPublishErrorToCategory } from "@/lib/studio/pinLifecycle";

/** A claim is reclaimable if it was never taken, or the worker that took it is
 *  presumed dead (claim older than this window). Matches the SQL the route runs. */
export const CLAIM_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** ISO timestamp of the stale-claim cutoff: claims at/after this are still "live". */
export function staleClaimCutoffIso(nowMs: number): string {
  return new Date(nowMs - CLAIM_STALE_MS).toISOString();
}

/**
 * The claim predicate, in JS, mirroring the route's
 *   (publish_claimed_at IS NULL OR publish_claimed_at < now() - interval '10 minutes')
 * Used by the test to prove the boundary; the route relies on the DB to evaluate it
 * atomically across concurrent workers.
 */
export function isClaimable(publishClaimedAt: string | null | undefined, nowMs: number): boolean {
  if (!publishClaimedAt) return true;
  const claimedMs = Date.parse(publishClaimedAt);
  if (Number.isNaN(claimedMs)) return true; // unparseable lock ⇒ treat as stale/claimable
  return claimedMs < nowMs - CLAIM_STALE_MS;
}

/** First non-empty trimmed string among the candidates, else "". */
function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

export interface DuePublishInput {
  uid: string;
  boardId: string;
  imageUrl: string;
  title?: string;
  description?: string;
  link?: string;
  altText?: string;
}

/**
 * Map a stored PinDraft `payload` to the publishPinForUser() input. Field names mirror
 * the studio store (imageUrl / boardId / title / description / destinationUrl / altText).
 * Returns null when a hard requirement (image or board) is missing — the caller records a
 * content failure rather than calling Pinterest with an unpublishable payload.
 */
export function payloadToPublishInput(uid: string, payload: Record<string, unknown>): DuePublishInput | null {
  const imageUrl = firstString(payload.imageUrl, payload.sourceImageUrl);
  const boardId = firstString(payload.boardId);
  if (!imageUrl || !boardId) return null;
  return {
    uid,
    boardId,
    imageUrl,
    title: firstString(payload.title) || undefined,
    description: firstString(payload.description) || undefined,
    // destination link is optional/recommended (never blocks publish).
    link: firstString(payload.destinationUrl) || undefined,
    altText: firstString(payload.altText) || undefined,
  };
}

/**
 * The payload patch to persist after a SUCCESSFUL publish. The draft's whole object
 * lives in `payload`, so we merge onto it: mark posted, capture the remote Pin, and
 * clear the scheduling fields so it is neither re-scanned nor shown as scheduled.
 */
export function payloadAfterSuccess(
  payload: Record<string, unknown>,
  pin: { id: string; url: string },
  nowIso: string,
): Record<string, unknown> {
  const next = { ...payload };
  // Bump payload.updatedAt: the client's mergeServerDrafts LWW compares this field
  // (pinDraftStore.ts:815, local wins on tie) — without it the client never sees the
  // cron's result and a later local edit can push the stale scheduled payload back,
  // reviving scheduled_at and re-publishing the same Pin.
  next.updatedAt = nowIso;
  next.postedAt = nowIso;
  next.remotePinId = pin.id;
  next.remotePinUrl = pin.url;
  next.generationStatus = "completed";
  // Clear scheduling so lifecycle derives "posted" and the row is no longer due.
  next.scheduledDate = "";
  next.scheduledTime = "";
  next.plannedAt = "";
  // Clear any prior failure framing.
  delete next.publishError;
  delete next.failureType;
  delete next.errorCategory;
  delete next.publishErrorCode;
  return next;
}

export interface PublishFailureInfo {
  /** User-facing / diagnostic message. */
  message: string;
  /** Stable error code when available (drives categorization + internal display). */
  code?: string;
}

/**
 * The payload patch to persist after a FAILED publish (validation failure OR a thrown
 * connection/API error). Writes the WP-B failure semantics (§11.5): failureType,
 * errorCategory (via mapPublishErrorToCategory), the raw code, and preserves the time
 * the Pin *was* scheduled for so a future "reschedule" affordance can restore it. Clears
 * the scheduling fields so the row drops out of the due scan (no retry storm).
 */
export function payloadAfterFailure(
  payload: Record<string, unknown>,
  fail: PublishFailureInfo,
  nowIso: string,
): Record<string, unknown> {
  const next = { ...payload };
  // Bump payload.updatedAt (same reason as payloadAfterSuccess — see comment there):
  // the client's LWW merge compares this field, so it must match the row's updated_at.
  next.updatedAt = nowIso;

  // previousScheduledTime is stored as ISO (matches DraftDetailsDrawer.tsx:955 and
  // promote.ts's deriveLocalPlanned + "append :00.000Z" UTC convention) rather than the
  // raw local wall-clock string, so downstream consumers get a consistent format.
  const localPlanned = firstString(payload.plannedAt, payload.scheduledDate);
  let previousScheduled: string | undefined;
  if (localPlanned) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(localPlanned);
    if (m) {
      const iso = `${m[1]}T${m[2] ?? "00:00"}:00.000Z`;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) previousScheduled = new Date(ms).toISOString();
    }
  }

  next.publishError = fail.message;
  next.failureType = "publish";
  next.errorCategory = mapPublishErrorToCategory(fail.code, fail.message);
  if (fail.code) next.publishErrorCode = fail.code;
  if (previousScheduled) next.previousScheduledTime = previousScheduled;

  // Drop it out of the due scan; the "failed" lifecycle comes from publishError.
  next.scheduledDate = "";
  next.scheduledTime = "";
  next.plannedAt = "";
  return next;
}

/** Extract { message, code } from a thrown error for categorization. Connection/API
 *  errors from publishPin.ts carry a `.code` (needs_reconnect / not_connected / …). */
export function describeThrown(err: unknown): PublishFailureInfo {
  const e = err as { message?: unknown; code?: unknown } | null;
  const message = typeof e?.message === "string" && e.message ? e.message : "Publish failed";
  const code = typeof e?.code === "string" && e.code ? e.code : undefined;
  return { message, code };
}
