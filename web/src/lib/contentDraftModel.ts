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

export interface PublishDestination {
  id: string;
  provider: PublishProvider;
  accountId?: string;
  accountName?: string;
  boardId?: string;
  boardName?: string;
  pageId?: string;
  pageName?: string;
}

export type DestinationPublishStatus = "pending" | "publishing" | "published" | "failed";

export interface DestinationPublishResult {
  destinationId: string;
  provider: PublishProvider;
  status: DestinationPublishStatus;
  remoteId?: string;
  postUrl?: string;
  submittedAt?: string;
  publishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
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
  socialPosts?: Array<{ provider: string; postId: string; postUrl: string; publishedAt: string; accountLabel?: string }>;
  contentId?: string;
  media?: ContentMedia[];
  coverMediaId?: string;
  publishDestinations?: PublishDestination[];
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

export function contentDestinations(draft: ContentDraftLike): PublishDestination[] {
  const explicit = (draft.publishDestinations ?? []).filter(item => item?.id && item?.provider);
  if (explicit.length) return explicit;
  if (!draft.boardId && !draft.boardName && !draft.remotePinId && !draft.publishError) return [];
  return [{
    id: `${draft.id}:pinterest`,
    provider: "pinterest",
    boardId: draft.boardId,
    boardName: draft.boardName,
  }];
}

function provider(value: string): PublishProvider | null {
  const normalized = value.toLowerCase();
  return normalized === "pinterest" || normalized === "instagram" || normalized === "facebook" ? normalized : null;
}

export function contentDestinationResults(draft: ContentDraftLike): DestinationPublishResult[] {
  if (draft.destinationResults?.length) return draft.destinationResults;
  const results: DestinationPublishResult[] = [];
  if (draft.remotePinId || draft.remotePinUrl || draft.postedAt) {
    results.push({
      destinationId: `${draft.id}:pinterest`, provider: "pinterest", status: "published",
      remoteId: draft.remotePinId, postUrl: draft.remotePinUrl, publishedAt: draft.postedAt,
    });
  } else if (draft.publishError) {
    results.push({ destinationId: `${draft.id}:pinterest`, provider: "pinterest", status: "failed", errorMessage: draft.publishError });
  }
  (draft.socialPosts ?? []).forEach(post => {
    const p = provider(post.provider);
    if (!p) return;
    results.push({ destinationId: `${draft.id}:${p}:${post.accountLabel ?? post.postId}`, provider: p, status: "published", remoteId: post.postId, postUrl: post.postUrl, publishedAt: post.publishedAt });
  });
  return results;
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
