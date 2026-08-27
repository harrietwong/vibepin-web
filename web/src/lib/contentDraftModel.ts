/**
 * Content-level compatibility model for Create Pins.
 *
 * PinDraft remains the persisted record while the product migrates from one-image
 * Pins to one Content with N media and N independently published destinations.
 * Every field is optional on legacy rows; helpers always synthesize truthful
 * fallbacks from the pre-existing single-image/Pinterest fields.
 */

// Type-only on the PinDraft side, so this does not create a runtime import cycle with
// pinDraftStore (which imports this module for its media/result types).
import { resolveScheduledDestinations } from "./social/scheduledDestinations";

export type ContentMediaKind = "image";
export type ContentMediaSource = "upload" | "ai" | "product" | "legacy";

export interface ContentMedia {
  id: string;
  kind: ContentMediaKind;
  url: string;
  altText?: string;
  source?: ContentMediaSource;
  width?: number;
  height?: number;
}

export type PublishProvider = "pinterest" | "instagram" | "facebook";

/**
 * A destination as the UI reads it — DERIVED, never stored.
 *
 * The stored intent is `PinDraft.scheduledDestinations` and nothing else: the cron
 * worker and the server job tables read only that, so a second stored destination
 * model (the client-only `publishDestinations` this replaces) could — and did —
 * drift away from what a scheduled publish actually did. `contentDestinations()`
 * below projects the canonical intent into this shape; there is no writer.
 */
export interface PublishDestination {
  /** `${provider}:${socialConnectionId ?? "legacy"}` — also the result key. */
  id: string;
  provider: PublishProvider;
  /** The connection this destination publishes as. Null only for legacy Pinterest. */
  socialConnectionId: string | null;
  accountLabel?: string;
  boardId?: string;
  boardName?: string;
}

export type DestinationPublishStatus = "pending" | "publishing" | "published" | "failed";

/**
 * One durable record per destination of one publish (PRD §27).
 *
 * The legacy fields (`postedAt`, `remotePinId`, `socialPosts[]`) cannot express this:
 * they hold ONE Pinterest time and a flat list of successes, so a per-account failure
 * reason, a submitted-vs-published time, or two accounts on the same platform have
 * nowhere to live. Those fields are still written for back-compat, but they are
 * DERIVED from these rows (see `legacyFieldsFromResults`), never the other way round.
 */
export interface DestinationPublishResult {
  /** `${provider}:${socialConnectionId ?? "legacy"}`. Stable across retries. */
  destinationId: string;
  provider: PublishProvider;
  /** Which account received it. Null only for a legacy Pinterest draft. */
  socialConnectionId: string | null;
  accountLabel?: string;
  boardId?: string;
  boardName?: string;
  status: DestinationPublishStatus;
  /** When this attempt was handed to the platform. */
  submittedAt?: string;
  /** When the platform confirmed it. Only set on `published`. */
  publishedAt?: string;
  remoteId?: string;
  postUrl?: string;
  errorCode?: string;
  /** User-facing failure reason — shown verbatim on the card. */
  errorMessage?: string;
}

/** The one key format for a destination and its result. */
export function destinationKey(provider: string, socialConnectionId?: string | null): string {
  const id = typeof socialConnectionId === "string" ? socialConnectionId.trim() : "";
  return `${provider}:${id || "legacy"}`;
}

export type ContentDraftLike = {
  id: string;
  imageUrl: string;
  altText?: string;
  source?: string;
  boardId?: string;
  boardName?: string;
  remotePinId?: string;
  remotePinUrl?: string;
  postedAt?: string;
  publishError?: string;
  publishErrorCode?: string;
  /** The Pinterest connection this Content is pinned to (PRD §14). */
  targetConnectionId?: string;
  targetAccountLabel?: string;
  // `publishedAt` is optional HERE (it is required on the stored `SocialPostRef`):
  // refs recorded before that field existed, and callers that assemble a partial ref
  // for display, must still be readable rather than being excluded from the results.
  socialPosts?: Array<{
    provider: string; postId: string; postUrl: string; publishedAt?: string;
    accountLabel?: string; accountName?: string; socialConnectionId?: string;
  }>;
  contentId?: string;
  media?: ContentMedia[];
  coverMediaId?: string;
  /** The canonical publish intent — see `contentDestinations`. */
  scheduledDestinations?: Array<{
    provider: string; socialConnectionId: string; accountLabel?: string;
    boardId?: string; boardName?: string; capturedAt: string;
  }>;
  destinationResults?: DestinationPublishResult[];
};

function legacyMediaSource(source?: string): ContentMediaSource {
  if (source === "uploaded_image") return "upload";
  if (source === "ai_generated_from_upload") return "ai";
  return "legacy";
}

export function contentIdentity(draft: ContentDraftLike): string {
  return draft.contentId?.trim() || draft.id;
}

export function contentMedia(draft: ContentDraftLike): ContentMedia[] {
  const media = (draft.media ?? []).filter(item => item?.id && item?.url);
  if (media.length) return media;
  if (!draft.imageUrl) return [];
  return [{
    id: `${draft.id}:media:0`,
    kind: "image",
    url: draft.imageUrl,
    altText: draft.altText,
    source: legacyMediaSource(draft.source),
  }];
}

export function coverMedia(draft: ContentDraftLike): ContentMedia | null {
  const media = contentMedia(draft);
  return media.find(item => item.id === draft.coverMediaId) ?? media[0] ?? null;
}

/**
 * Where this Content publishes — a projection of the canonical intent.
 *
 * Tier 1 is `resolveScheduledDestinations`, i.e. exactly what the cron worker will
 * dispatch, so what the card shows and what a scheduled run does cannot disagree.
 *
 * Tier 2 exists because that resolver's own legacy fallback needs a
 * `targetConnectionId`, and most historical drafts have none — they only ever had a
 * board (and possibly a published/failed Pinterest outcome). Dropping them would
 * silently strip the destination chip and the publish path off every pre-multi-account
 * draft. They project as Pinterest with a null connection (`pinterest:legacy`); the
 * publish path then resolves the account the same way it always did (server default,
 * adopt-once).
 */
export function contentDestinations(draft: ContentDraftLike): PublishDestination[] {
  const intent = resolveScheduledDestinations(draft as Parameters<typeof resolveScheduledDestinations>[0]);
  if (intent.length) {
    return intent
      .map((d): PublishDestination | null => {
        const p = provider(d.provider);
        if (!p) return null;
        const dest: PublishDestination = {
          id: destinationKey(p, d.socialConnectionId),
          provider: p,
          socialConnectionId: d.socialConnectionId,
        };
        if (d.accountLabel) dest.accountLabel = d.accountLabel;
        // Pinterest's board lives on the draft; the intent copy can lag an edit.
        if (p === "pinterest") {
          const boardId = d.boardId || draft.boardId;
          const boardName = d.boardName || draft.boardName;
          if (boardId) dest.boardId = boardId;
          if (boardName) dest.boardName = boardName;
        } else {
          if (d.boardId) dest.boardId = d.boardId;
          if (d.boardName) dest.boardName = d.boardName;
        }
        return dest;
      })
      .filter((d): d is PublishDestination => d !== null);
  }
  if (!draft.boardId && !draft.boardName && !draft.remotePinId && !draft.publishError) return [];
  return [{
    id: destinationKey("pinterest", null),
    provider: "pinterest",
    socialConnectionId: null,
    boardId: draft.boardId,
    boardName: draft.boardName,
  }];
}

function provider(value: string): PublishProvider | null {
  const normalized = value.toLowerCase();
  return normalized === "pinterest" || normalized === "instagram" || normalized === "facebook" ? normalized : null;
}

function trimmed(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * THE reader for per-destination publish outcomes — the only one.
 *
 * Stored rows win. A draft with none (every publish before this model existed) is
 * derived from the legacy fields, so nothing that used to render a result stops
 * rendering one: Pinterest from the draft's own postedAt/remotePinId (+ its account
 * label and board), the other platforms from socialPosts[].
 *
 * This replaced `publishResultRows()` in studio/publishResults.ts, which derived the
 * same thing from the same fields and could not see stored rows at all — two readers
 * of one fact is how a published destination shows in one surface and not another.
 */
export function contentDestinationResults(draft: ContentDraftLike): DestinationPublishResult[] {
  if (draft.destinationResults?.length) return draft.destinationResults;
  const results: DestinationPublishResult[] = [];
  const pinterestConnection = trimmed(draft.targetConnectionId) ?? null;
  const pinterestKey = destinationKey("pinterest", pinterestConnection);
  if (draft.remotePinId || draft.remotePinUrl || draft.postedAt) {
    results.push({
      destinationId: pinterestKey, provider: "pinterest", socialConnectionId: pinterestConnection,
      accountLabel: trimmed(draft.targetAccountLabel), boardId: trimmed(draft.boardId), boardName: trimmed(draft.boardName),
      status: "published", remoteId: trimmed(draft.remotePinId),
      // A draft published before remotePinUrl existed reconstructs Pinterest's own
      // canonical permalink from the id — a known format, not a guess.
      postUrl: trimmed(draft.remotePinUrl) ?? (trimmed(draft.remotePinId) ? `https://www.pinterest.com/pin/${draft.remotePinId}/` : undefined),
      publishedAt: trimmed(draft.postedAt),
    });
  } else if (draft.publishError) {
    results.push({
      destinationId: pinterestKey, provider: "pinterest", socialConnectionId: pinterestConnection,
      accountLabel: trimmed(draft.targetAccountLabel), boardId: trimmed(draft.boardId), boardName: trimmed(draft.boardName),
      status: "failed", errorMessage: draft.publishError, errorCode: trimmed(draft.publishErrorCode),
    });
  }
  (draft.socialPosts ?? []).forEach(post => {
    const p = provider(post.provider);
    // Pinterest is read from the draft's own fields above. A stray pinterest entry in
    // socialPosts (older fan-out code wrote one) would otherwise duplicate that row and
    // the merchant would see the same Pin listed twice.
    if (!p || p === "pinterest") return;
    results.push({
      destinationId: destinationKey(p, post.socialConnectionId),
      provider: p,
      socialConnectionId: trimmed(post.socialConnectionId) ?? null,
      accountLabel: trimmed(post.accountLabel) ?? trimmed(post.accountName),
      status: "published", remoteId: trimmed(post.postId), postUrl: trimmed(post.postUrl),
      publishedAt: trimmed(post.publishedAt),
    });
  });
  return results;
}

/**
 * Find the result for a destination, tolerating ids written by earlier shapes.
 *
 * Stored rows on a merchant's device may still carry `${draftId}:pinterest` or
 * `${draftId}:facebook:<label>` from the client-only model this replaced. Matching on
 * the exact key first, then on provider+connection, then on provider alone means an
 * un-migrated draft keeps showing its state instead of silently reverting to "pending".
 */
export function findDestinationResult(
  results: readonly DestinationPublishResult[],
  destination: Pick<PublishDestination, "id" | "provider" | "socialConnectionId">,
): DestinationPublishResult | undefined {
  return results.find(r => r.destinationId === destination.id)
    ?? results.find(r => r.provider === destination.provider
      && !!r.socialConnectionId && r.socialConnectionId === destination.socialConnectionId)
    ?? results.find(r => r.provider === destination.provider);
}

/**
 * Whether to offer "View on {platform}" for a result.
 *
 * Only a real http(s) permalink earns the action: a missing or malformed URL must
 * render as no button rather than a link that 404s (PRD 0809 §6).
 */
export function canViewExternally(result: Pick<DestinationPublishResult, "status" | "postUrl">): boolean {
  if (result.status !== "published") return false;
  const url = trimmed(result.postUrl);
  return !!url && /^https?:\/\//i.test(url);
}

/**
 * The legacy publish fields implied by a result set.
 *
 * One place computes them, so `postedAt`/`remotePinId`/`socialPosts[]` (Plan, admin,
 * the error banner) can never tell a different story from the per-destination rows.
 * Pinterest's `postedAt` is preserved from a prior publish when this attempt did not
 * republish it — a retry of Instagram must not restamp when the Pin went live.
 */
export function legacyFieldsFromResults(
  results: readonly DestinationPublishResult[],
  previous: Pick<ContentDraftLike, "postedAt" | "remotePinId" | "remotePinUrl"> = {},
): {
  postedAt?: string;
  remotePinId?: string;
  remotePinUrl?: string;
  socialPosts: NonNullable<ContentDraftLike["socialPosts"]>;
  publishError?: string;
  publishErrorCode?: string;
} {
  const published = results.filter(r => r.status === "published");
  const pinterest = published.find(r => r.provider === "pinterest");
  const firstFailure = results.find(r => r.status === "failed");
  const socialPosts = published
    .filter(r => r.provider !== "pinterest" && r.remoteId)
    .map(r => ({
      provider: r.provider,
      postId: r.remoteId as string,
      postUrl: r.postUrl ?? "",
      publishedAt: r.publishedAt ?? "",
      ...(r.accountLabel ? { accountLabel: r.accountLabel, accountName: r.accountLabel } : {}),
      ...(r.socialConnectionId ? { socialConnectionId: r.socialConnectionId } : {}),
    }));
  return {
    postedAt: pinterest?.publishedAt ?? trimmed(previous.postedAt) ?? (published.length ? published[0].publishedAt : undefined),
    remotePinId: pinterest?.remoteId ?? trimmed(previous.remotePinId),
    remotePinUrl: pinterest?.postUrl ?? trimmed(previous.remotePinUrl),
    socialPosts,
    publishError: firstFailure?.errorMessage,
    publishErrorCode: firstFailure?.errorCode,
  };
}

export function hasPublishedDestination(draft: ContentDraftLike): boolean {
  return contentDestinationResults(draft).some(result => result.status === "published");
}

export function hasFailedDestination(draft: ContentDraftLike): boolean {
  return contentDestinationResults(draft).some(result => result.status === "failed");
}

export function destinationNeedsAttention(draft: ContentDraftLike): DestinationPublishResult[] {
  return contentDestinationResults(draft).filter(result => result.status === "failed");
}

export function mediaId(contentId: string, index: number): string {
  return `${contentId}:media:${index}:${Math.random().toString(36).slice(2, 7)}`;
}
