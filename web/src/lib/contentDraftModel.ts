/**
 * Content-level compatibility model for Create Pins.
 *
 * PinDraft remains the persisted record while the product migrates from one-image
 * Pins to one Content with N media and N independently published destinations.
 * Every field is optional on legacy rows; helpers always synthesize truthful
 * fallbacks from the pre-existing single-image/Pinterest fields.
 */

import {
  ASPECT_RATIO_TOLERANCE,
  checkFacebookMedia,
  checkInstagramMedia,
  checkPinterestMedia,
} from "@/lib/publish/mediaRules";
import type { MediaCheckResult } from "@/lib/publish/mediaRules";
// Type-only on the PinDraft side, so this does not create a runtime import cycle with
// pinDraftStore (which imports this module for its media/result types).
import { resolveScheduledDestinations } from "./social/scheduledDestinations";

export type { MediaCheckResult, MediaCheckFailureCode, PublishMediaItem } from "@/lib/publish/mediaRules";

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
  /**
   * What KIND of failure `publishError` describes. Read here (not just by the
   * lifecycle predicates) because a `publishError` with no `failureType` is old
   * dirty data, not a publish failure — see `contentDestinationResults`.
   */
  failureType?: string;
  errorCategory?: string;
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
  /** `published` rows superseded by a later publish — history only, never publish input. */
  previousResults?: DestinationPublishResult[];
};

/**
 * The `published` rows a fresh attempt is about to overwrite.
 *
 * Results are keyed by destination, so republishing an edited Posted Content replaces
 * the row describing the Pin that is LIVE on the platform. Capturing the superseded
 * rows here is what lets the card still show "Earlier publishes" with the original
 * permalink instead of losing it. Only `published` rows are worth keeping: a failed
 * row carries no artifact on the platform, and a `publishing`/`pending` row never
 * described a real outcome. Capped so a Content republished many times cannot grow the
 * stored draft without bound (oldest dropped first).
 */
export const MAX_PREVIOUS_RESULTS = 20;

export function supersededResults(
  prior: readonly DestinationPublishResult[],
  fresh: readonly DestinationPublishResult[],
  existingHistory: readonly DestinationPublishResult[] = [],
): DestinationPublishResult[] {
  const replaced = new Set(fresh.map(r => r.destinationId));
  const superseded = prior.filter(r => r.status === "published" && replaced.has(r.destinationId));
  if (!superseded.length) return [...existingHistory];
  return [...existingHistory, ...superseded].slice(-MAX_PREVIOUS_RESULTS);
}

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

/**
 * The cover IS the first media item — there is no second source of truth.
 *
 * `coverMediaId` survives as a persisted field because stale drafts (and server
 * rows written before this rule) still carry it, but every store write and the
 * load-time normalization keep it equal to media[0].id. Resolving the cover by
 * searching for coverMediaId would resurrect the divergence this rule removes:
 * a draft whose cover sat at index 3 published its carousel with the WRONG lead
 * image, because publish paths read media[0] while the card showed the cover.
 */
export function coverMedia(draft: ContentDraftLike): ContentMedia | null {
  return contentMedia(draft)[0] ?? null;
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
        // Each Pinterest entry has its OWN board. The draft-level board is a fallback
        // ONLY for the entry that IS the draft's legacy target (where the intent copy
        // can lag an edit to the board field) or for a legacy entry naming no account.
        // Applying it to every entry would hand a second account the FIRST account's
        // board id — a board it does not own, so the Pin either fails or, worse, lands
        // somewhere the merchant never chose.
        if (p === "pinterest") {
          const target = draft.targetConnectionId?.trim();
          const own = !d.socialConnectionId || (!!target && d.socialConnectionId === target);
          const boardId = d.boardId || (own ? draft.boardId : undefined);
          const boardName = d.boardName || (own ? draft.boardName : undefined);
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
 * Whether a legacy `publishError` describes a REAL publish failure.
 *
 * A draft carrying `publishError` and nothing else is old dirty data — the field was
 * once written for states that were never a publish attempt (and never cleared on
 * success). The fan-out lineage made that explicit: "有 publishError 但无 failureType
 * → 不计入" (scripts/test-publish-failure-consistency.ts). Synthesising a failed
 * Pinterest row from such a draft would resurrect exactly that miscount through the
 * destination reader — `isActionablePublishFailure` trusts a failed destination row
 * over the legacy fields, so the row would override the very rule that excludes it.
 *
 * A failure written by any code path we ship carries at least one corroborating field:
 * `failureType: "publish"` (the drawer / cron / publishContent), or an error
 * code/category from the classifier. One of those is required here.
 */
function isRealPublishFailure(draft: ContentDraftLike): boolean {
  return draft.failureType === "publish"
    || !!trimmed(draft.publishErrorCode)
    || !!trimmed(draft.errorCategory);
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
  } else if (draft.publishError && isRealPublishFailure(draft)) {
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

/**
 * Deterministic, collision-free media ids.
 *
 * The old scheme was `${contentId}:media:${index}:${Math.random()}` — random
 * enough in practice, but nondeterministic output makes store writes untestable
 * and a 5-char random suffix is not a guarantee. The array INDEX alone cannot be
 * the discriminator either: remove item 2 then add one and the new item reuses
 * `:media:2`, colliding with an id that may still live in an undo buffer, a
 * pending upload, or a server row written a moment earlier.
 *
 * So: content id + a millisecond timestamp + a module-monotonic sequence. The
 * sequence rules out same-millisecond collisions within a session; the timestamp
 * rules out collisions with ids persisted by an earlier session (a counter that
 * restarts at 0 on reload would not).
 *
 * The literal `${batchId}:media:${index}` ids minted at upload time are a
 * different, already-unique namespace (batchId contains its own timestamp) and
 * stay valid — nothing here parses an id, they are opaque keys.
 */
let _mediaSeq = 0;
export function mediaId(contentId: string, index: number): string {
  const seq = _mediaSeq++;
  return `${contentId}:media:${Date.now().toString(36)}:${index}${seq === 0 ? "" : `-${seq}`}`;
}

// ── Per-platform media readiness ──────────────────────────────────────────────

export interface ContentMediaIssues {
  /** The platform rule verdict, straight from mediaRules. */
  result: MediaCheckResult;
  /**
   * Ids of media whose aspect ratio differs from media[0]'s beyond tolerance.
   * Populated for EVERY provider, including Instagram/Facebook where a mismatch
   * is a quality warning rather than an API error — the UI needs to point at the
   * offending thumbnails either way ("2 images need adjustment").
   * Empty when dimensions are unknown: an unmeasured item is not an offender.
   */
  offendingMediaIds: string[];
  /** True when at least one item has no dimensions, so the ratio rule is unproven. */
  unverifiedRatio: boolean;
}

function mediaRatio(item: ContentMedia): number | null {
  const { width, height } = item;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return width / height;
}

/**
 * Can this Content's media go out to `provider`, and if not, which items are at
 * fault? A thin wrapper over the shared mediaRules checks (the ONE place that
 * knows each platform's limits) plus the item-level attribution the rules layer
 * deliberately does not carry, since it works on url/width/height only.
 */
export function contentMediaIssues(
  draft: ContentDraftLike,
  provider: PublishProvider,
): ContentMediaIssues {
  const media = contentMedia(draft);
  const items = media.map(item => ({ url: item.url, width: item.width, height: item.height }));
  const result =
    provider === "pinterest" ? checkPinterestMedia(items)
    : provider === "instagram" ? checkInstagramMedia(items)
    : checkFacebookMedia(items);

  const ratios = media.map(mediaRatio);
  const unverifiedRatio = media.length > 1 && ratios.some(ratio => ratio === null);
  const reference = ratios[0];
  const offendingMediaIds: string[] = [];
  if (media.length > 1 && reference !== null && reference !== undefined) {
    for (let i = 1; i < media.length; i++) {
      const ratio = ratios[i];
      if (ratio === null) continue; // unmeasured ≠ offending
      if (Math.abs(ratio - reference) / reference > ASPECT_RATIO_TOLERANCE) offendingMediaIds.push(media[i].id);
    }
  }
  return { result, offendingMediaIds, unverifiedRatio };
}
