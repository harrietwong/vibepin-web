import {
  buildPublishConfirmation,
  publishConfirmationFingerprint,
  stablePublishString,
  type ConfirmedPublishReceipt,
} from "@/lib/studio/publishConfirmation";
import type { PublishDestination } from "@/lib/contentDraftModel";
import type { PinDraft } from "@/lib/pinDraftStore";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidCoverFrameTime } from "@/lib/videoCoverFrame";

const MAX_CONFIRMATION_AGE_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type ImmediateDispatchContent = {
  draftId: string;
  title?: string;
  description?: string;
  destinationUrl?: string;
  altText?: string;
  imageUrls: string[];
  videoUrls?: string[];
};

export type ConfirmationValidation =
  | { ok: true; receipt: ConfirmedPublishReceipt; destinations: PublishDestination[] }
  | { ok: false; code: "confirmation_required" | "invalid_confirmation"; error: string };

export type StoredConfirmationValidation =
  | { ok: true; priorIntentId: string | null }
  | { ok: false; code: "invalid_confirmation" | "publish_intent_unavailable"; error: string };

/**
 * A new social publish must dispatch the complete confirmed social fan-out.
 * Retry may narrow that set, but durable ledger state authorizes the narrowed
 * destinations separately; this helper proves only receipt membership and mode.
 */
export function isConfirmedSocialDestinationSelection(
  requestedDestinationIds: readonly string[],
  confirmedDestinations: readonly PublishDestination[],
  dispatchDestinationIds: readonly string[],
): boolean {
  if (!requestedDestinationIds.length || new Set(requestedDestinationIds).size !== requestedDestinationIds.length) return false;
  const confirmedSocialIds = confirmedDestinations
    .filter(destination => destination.provider !== "pinterest")
    .map(destination => destination.id);
  const confirmedSet = new Set(confirmedSocialIds);
  if (confirmedSet.size !== confirmedSocialIds.length
      || requestedDestinationIds.some(id => !confirmedSet.has(id))) return false;
  const expected = dispatchDestinationIds
    .filter(id => confirmedSet.has(id))
    .sort();
  return stablePublishString([...requestedDestinationIds].sort()) === stablePublishString(expected);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function confirmedMediaUrl(value: unknown, kind: "image" | "video"): string | null {
  const url = text(value).trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (kind !== "video") return null;
  try {
    const parsed = new URL(url, "https://vibepin.invalid");
    if (parsed.origin !== "https://vibepin.invalid"
        || parsed.pathname !== "/api/storage-media"
        || parsed.hash
        || parsed.searchParams.getAll("path").length !== 1
        || [...parsed.searchParams.keys()].some(key => key !== "path")
        || !parsed.searchParams.get("path")) return null;
    return `${parsed.pathname}?path=${encodeURIComponent(parsed.searchParams.get("path") as string)}`;
  } catch {
    return null;
  }
}

function destination(value: unknown): PublishDestination | null {
  const row = object(value);
  if (!row) return null;
  const provider = text(row.provider).trim().toLowerCase();
  const connectionId = text(row.socialConnectionId).trim();
  if (provider !== "pinterest" && provider !== "instagram" && provider !== "facebook") return null;
  if (!connectionId) return null;
  const expectedId = `${provider}:${connectionId}`;
  if (text(row.id).trim() !== expectedId) return null;
  const boardId = text(row.boardId).trim();
  if (provider === "pinterest" && !boardId) return null;
  return {
    id: expectedId,
    provider,
    socialConnectionId: connectionId,
    ...(text(row.accountLabel).trim() ? { accountLabel: text(row.accountLabel).trim() } : {}),
    ...(boardId ? { boardId } : {}),
    ...(text(row.boardName).trim() ? { boardName: text(row.boardName).trim() } : {}),
  };
}

/**
 * Verify the complete confirmation receipt against the exact bytes the route will
 * dispatch. This is deliberately before usage, analytics, job creation or provider
 * calls. A caller cannot confirm one caption/account and submit another.
 */
export function validateImmediatePublishReceipt(
  raw: unknown,
  content: ImmediateDispatchContent,
  requestedDestinationIds: readonly string[],
  nowMs = Date.now(),
): ConfirmationValidation {
  const value = object(raw);
  if (!value) return { ok: false, code: "confirmation_required", error: "A publish confirmation receipt is required." };

  const destinations = Array.isArray(value.destinations)
    ? value.destinations.map(destination).filter((item): item is PublishDestination => !!item)
    : [];
  const publishable = Array.isArray(value.publishableDestinations)
    ? value.publishableDestinations.map(destination).filter((item): item is PublishDestination => !!item)
    : [];
  const media = Array.isArray(value.media) ? value.media : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const mode = object(value.mode);
  const confirmedAt = Date.parse(text(value.confirmedAt));
  const receipt = value as unknown as ConfirmedPublishReceipt;

  const invalid = (error: string): ConfirmationValidation => ({ ok: false, code: "invalid_confirmation", error });
  if (mode?.kind !== "now") return invalid("The confirmation does not authorize an immediate publish.");
  if (!Number.isFinite(confirmedAt) || confirmedAt < nowMs - MAX_CONFIRMATION_AGE_MS || confirmedAt > nowMs + MAX_CLOCK_SKEW_MS) {
    return invalid("The publish confirmation has expired. Review the content again.");
  }
  if (text(value.draftId).trim() !== content.draftId || text(value.contentId).trim().length === 0) {
    return invalid("The confirmation belongs to different content.");
  }
  const expectedPrefix = `publish:${text(value.contentId).trim()}:`;
  const intentId = text(value.intentId).trim();
  const actionId = intentId.startsWith(expectedPrefix) ? intentId.slice(expectedPrefix.length) : "";
  if (!/^[a-z0-9]{8,64}$/i.test(actionId)) return invalid("The publish intent id is invalid.");
  if (!/^[0-9a-f]{64}$/i.test(text(value.fingerprint))) return invalid("The publish fingerprint is invalid.");
  if (!destinations.length || destinations.length !== (value.destinations as unknown[]).length) {
    return invalid("No valid publishing destination was confirmed.");
  }
  if (!publishable.length || publishable.length !== (value.publishableDestinations as unknown[]).length) {
    return invalid("No publishable destination was confirmed.");
  }
  const destinationIds = destinations.map(item => item.id);
  const publishableIds = publishable.map(item => item.id);
  if (new Set(destinationIds).size !== destinationIds.length || new Set(publishableIds).size !== publishableIds.length) {
    return invalid("The confirmation contains duplicate destinations.");
  }
  if (publishableIds.some(id => !destinationIds.includes(id))) return invalid("The confirmation destination set is inconsistent.");
  const priorIntentId = value.priorIntentId === null
    ? null
    : text(value.priorIntentId).trim();
  if (value.priorIntentId !== null && !priorIntentId) return invalid("The prior publish intent id is invalid.");
  if (priorIntentId && !priorIntentId.startsWith(`publish:${text(value.contentId).trim()}:`)) {
    return invalid("The prior publish intent belongs to different content.");
  }
  if (priorIntentId === intentId) return invalid("A retry must use a new publish intent.");
  const dispatchDestinationIds = Array.isArray(value.dispatchDestinationIds)
    ? value.dispatchDestinationIds.map(item => text(item).trim())
    : [];
  if (!dispatchDestinationIds.length
      || dispatchDestinationIds.some(id => !id)
      || new Set(dispatchDestinationIds).size !== dispatchDestinationIds.length
      || dispatchDestinationIds.some(id => !publishableIds.includes(id))) {
    return invalid("The confirmed dispatch destination set is invalid.");
  }
  const onlyPending = value.onlyPending === true;
  if (!onlyPending && priorIntentId !== null) return invalid("A full publish cannot consume a prior retry intent.");
  if ((!onlyPending || priorIntentId === null)
      && stablePublishString([...dispatchDestinationIds].sort()) !== stablePublishString([...publishableIds].sort())) {
    return invalid("The confirmation does not authorize the complete destination set.");
  }
  const requested = [...requestedDestinationIds];
  if (!requested.length || new Set(requested).size !== requested.length) return invalid("Select at least one exact destination.");
  if (requested.some(id => !dispatchDestinationIds.includes(id))) return invalid("The request includes a destination this confirmation did not authorize.");

  const normalizedMedia: ConfirmedPublishReceipt["media"] = media.flatMap(item => {
    const row = object(item);
    if (!row || !text(row.id)) return [];
    const kind = row.kind === "video" ? "video" : row.kind === "image" ? "image" : null;
    if (!kind) return [];
    const url = confirmedMediaUrl(row.url, kind);
    if (!url) return [];
    const rawSource = text(row.source);
    const source = rawSource === "upload" || rawSource === "ai" || rawSource === "product" || rawSource === "legacy"
      ? rawSource
      : "legacy";
    if (kind === "video" && source !== "upload") return [];
    const durationMs = typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs > 0
      ? row.durationMs
      : undefined;
    const posterUrl = text(row.posterUrl).trim();
    if (row.coverFrameTimeMs !== undefined
      && (kind !== "video" || !isValidCoverFrameTime(row.coverFrameTimeMs, durationMs))) return [];
    const mediaAltText = text(row.altText).trim();
    return [{
      id: text(row.id),
      kind,
      url,
      ...(typeof row.width === "number" ? { width: row.width } : {}),
      ...(typeof row.height === "number" ? { height: row.height } : {}),
      ...(mediaAltText ? { altText: mediaAltText } : {}),
      source,
      ...(kind === "video" && durationMs ? { durationMs } : {}),
      ...(kind === "video" && posterUrl ? { posterUrl } : {}),
      ...(kind === "video" && row.coverFrameTimeMs !== undefined ? { coverFrameTimeMs: row.coverFrameTimeMs as number } : {}),
    }];
  });
  if (!normalizedMedia.length || normalizedMedia.length !== media.length) return invalid("The confirmed media is invalid.");

  const normalized = {
    ...receipt,
    intentId,
    priorIntentId,
    draftId: text(value.draftId).trim(),
    contentId: text(value.contentId).trim(),
    sourceUpdatedAt: text(value.sourceUpdatedAt),
    title: text(value.title),
    description: text(value.description),
    altText: text(value.altText),
    destinationUrl: text(value.destinationUrl),
    media: normalizedMedia,
    mode: { kind: "now" as const },
    destinations,
    publishableDestinations: publishable,
    dispatchDestinationIds: [...dispatchDestinationIds].sort(),
    blockers: blockers as ConfirmedPublishReceipt["blockers"],
    onlyPending,
    confirmedAt: text(value.confirmedAt),
  };
  if (publishConfirmationFingerprint(normalized) !== text(value.fingerprint)) return invalid("The publish confirmation was changed after review.");

  const exactContent = {
    title: normalized.title,
    description: normalized.description,
    destinationUrl: normalized.destinationUrl,
    altText: normalized.altText,
    imageUrls: normalized.media.filter(item => item.kind === "image").map(item => item.url),
    ...(normalized.media.some(item => item.kind === "video")
      ? { videoUrls: normalized.media.filter(item => item.kind === "video").map(item => item.url) }
      : {}),
  };
  const submittedContent = {
    title: content.title ?? "",
    description: content.description ?? "",
    destinationUrl: content.destinationUrl ?? "",
    altText: content.altText ?? "",
    imageUrls: content.imageUrls,
    ...(content.videoUrls?.length ? { videoUrls: content.videoUrls } : {}),
  };
  if (stablePublishString(exactContent) !== stablePublishString(submittedContent)) {
    return invalid("The submitted content no longer matches the confirmation.");
  }
  return { ok: true, receipt: normalized, destinations: publishable };
}

/**
 * Bind the browser snapshot to the owner's current durable draft revision. The
 * browser SHA proves canonical bytes, not authority: without this read a caller
 * could alter both the payload and its hash and still pass. Any storage/schema
 * problem fails closed before usage, job creation or a provider call.
 */
export async function validateStoredImmediatePublishReceipt(
  db: SupabaseClient,
  uid: string,
  receipt: ConfirmedPublishReceipt,
): Promise<StoredConfirmationValidation> {
  const { data, error } = await db
    .from("pin_drafts")
    .select("draft_id,updated_at,payload,deleted_at")
    .eq("vibepin_user_id", uid)
    .eq("draft_id", receipt.draftId)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      code: "publish_intent_unavailable",
      error: "Could not verify the current Content revision.",
    };
  }
  if (!data || (data as { deleted_at?: unknown }).deleted_at) {
    return { ok: false, code: "invalid_confirmation", error: "This Content is no longer available." };
  }
  const row = data as { draft_id: string; updated_at: string; payload: Record<string, unknown> };
  const storedUpdatedAt = Date.parse(row.updated_at);
  const receiptUpdatedAt = Date.parse(receipt.sourceUpdatedAt);
  const storedIntentId = text(row.payload.publishIntentId).trim() || null;
  const storedPriorIntentId = row.payload.publishIntentPriorIntentId === null
    ? null
    : text(row.payload.publishIntentPriorIntentId).trim() || null;
  const preDispatchSnapshot = storedIntentId === receipt.priorIntentId
    && storedUpdatedAt === receiptUpdatedAt;
  const persistedDispatchSnapshot = storedIntentId === receipt.intentId
    && storedPriorIntentId === receipt.priorIntentId
    && text(row.payload.publishIntentFingerprint) === receipt.fingerprint
    && text(row.payload.publishIntentConfirmedAt) === receipt.confirmedAt
    && storedUpdatedAt >= receiptUpdatedAt;
  if (!Number.isFinite(storedUpdatedAt)
      || !Number.isFinite(receiptUpdatedAt)
      || (!preDispatchSnapshot && !persistedDispatchSnapshot)) {
    return { ok: false, code: "invalid_confirmation", error: "The Content changed after confirmation. Review it again." };
  }
  const current = buildPublishConfirmation({
    ...row.payload,
    id: row.draft_id,
    // Postgres may serialize the same timestamptz as +00:00 instead of the
    // browser's .000Z. The equality check above binds the instant; retain the
    // confirmed representation so canonical hashing is environment-independent.
    updatedAt: receipt.sourceUpdatedAt,
    // A sync may persist publishContent's lifecycle metadata before this request
    // reaches the route. Recompute against the frozen parent, not the new child.
    publishIntentId: receipt.priorIntentId ?? undefined,
  } as unknown as PinDraft, {
    mode: receipt.mode,
    onlyPending: receipt.onlyPending,
    actionId: "server-recompute",
  });
  if (current.fingerprint !== receipt.fingerprint
      || current.priorIntentId !== receipt.priorIntentId
      || stablePublishString(current.dispatchDestinationIds) !== stablePublishString(receipt.dispatchDestinationIds)
      || stablePublishString(current.destinations) !== stablePublishString(receipt.destinations)
      || stablePublishString(current.publishableDestinations) !== stablePublishString(receipt.publishableDestinations)
      || stablePublishString(current.blockers) !== stablePublishString(receipt.blockers)) {
    return { ok: false, code: "invalid_confirmation", error: "The Content or publishing destinations changed after confirmation." };
  }
  return { ok: true, priorIntentId: receipt.priorIntentId };
}
