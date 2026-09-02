import {
  buildPublishConfirmation,
  publishConfirmationFingerprint,
  stablePublishString,
  type ConfirmedPublishReceipt,
} from "@/lib/studio/publishConfirmation";
import type { PublishDestination } from "@/lib/contentDraftModel";
import type { PinDraft } from "@/lib/pinDraftStore";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_CONFIRMATION_AGE_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type ImmediateDispatchContent = {
  draftId: string;
  title?: string;
  description?: string;
  destinationUrl?: string;
  altText?: string;
  imageUrls: string[];
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
  onlyPending: boolean,
): boolean {
  if (!requestedDestinationIds.length || new Set(requestedDestinationIds).size !== requestedDestinationIds.length) return false;
  const confirmedSocialIds = confirmedDestinations
    .filter(destination => destination.provider !== "pinterest")
    .map(destination => destination.id);
  const confirmedSet = new Set(confirmedSocialIds);
  if (confirmedSet.size !== confirmedSocialIds.length
      || requestedDestinationIds.some(id => !confirmedSet.has(id))) return false;
  if (onlyPending) return true;
  return requestedDestinationIds.length === confirmedSocialIds.length;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
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
  const requested = [...requestedDestinationIds];
  if (!requested.length || new Set(requested).size !== requested.length) return invalid("Select at least one exact destination.");
  if (requested.some(id => !publishableIds.includes(id))) return invalid("The request includes a destination the merchant did not confirm.");

  const normalizedMedia: ConfirmedPublishReceipt["media"] = media.flatMap(item => {
    const row = object(item);
    if (!row || !text(row.id) || !/^https?:\/\//i.test(text(row.url))) return [];
    const rawSource = text(row.source);
    const source = rawSource === "upload" || rawSource === "ai" || rawSource === "product" || rawSource === "legacy"
      ? rawSource
      : "legacy";
    return [{
      id: text(row.id),
      kind: "image" as const,
      url: text(row.url),
      ...(typeof row.width === "number" ? { width: row.width } : {}),
      ...(typeof row.height === "number" ? { height: row.height } : {}),
      ...(text(row.altText) ? { altText: text(row.altText) } : {}),
      source,
    }];
  });
  if (!normalizedMedia.length || normalizedMedia.length !== media.length) return invalid("The confirmed media is invalid.");

  const normalized = {
    ...receipt,
    intentId,
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
    blockers: blockers as ConfirmedPublishReceipt["blockers"],
    onlyPending: value.onlyPending === true,
    confirmedAt: text(value.confirmedAt),
  };
  if (publishConfirmationFingerprint(normalized) !== text(value.fingerprint)) return invalid("The publish confirmation was changed after review.");

  const exactContent = {
    title: normalized.title,
    description: normalized.description,
    destinationUrl: normalized.destinationUrl,
    altText: normalized.altText,
    imageUrls: normalized.media.map(item => item.url),
  };
  const submittedContent = {
    title: content.title ?? "",
    description: content.description ?? "",
    destinationUrl: content.destinationUrl ?? "",
    altText: content.altText ?? "",
    imageUrls: content.imageUrls,
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
  if (!Number.isFinite(storedUpdatedAt) || !Number.isFinite(receiptUpdatedAt) || storedUpdatedAt !== receiptUpdatedAt) {
    return { ok: false, code: "invalid_confirmation", error: "The Content changed after confirmation. Review it again." };
  }
  const current = buildPublishConfirmation({
    ...row.payload,
    id: row.draft_id,
    // Postgres may serialize the same timestamptz as +00:00 instead of the
    // browser's .000Z. The equality check above binds the instant; retain the
    // confirmed representation so canonical hashing is environment-independent.
    updatedAt: receipt.sourceUpdatedAt,
  } as unknown as PinDraft, {
    mode: receipt.mode,
    onlyPending: receipt.onlyPending,
    actionId: "server-recompute",
  });
  if (current.fingerprint !== receipt.fingerprint
      || stablePublishString(current.destinations) !== stablePublishString(receipt.destinations)
      || stablePublishString(current.publishableDestinations) !== stablePublishString(receipt.publishableDestinations)
      || stablePublishString(current.blockers) !== stablePublishString(receipt.blockers)) {
    return { ok: false, code: "invalid_confirmation", error: "The Content or publishing destinations changed after confirmation." };
  }
  const priorIntentId = typeof row.payload.publishIntentId === "string" && row.payload.publishIntentId.trim()
    ? row.payload.publishIntentId.trim()
    : null;
  return { ok: true, priorIntentId };
}
