/**
 * Content-level compatibility model for Create Pins.
 *
 * PinDraft remains the persisted record while the product migrates from one-image
 * Pins to one Content with N media and N independently published destinations.
 * Every field is optional on legacy rows; helpers always synthesize truthful
 * fallbacks from the pre-existing single-image/Pinterest fields.
 */

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

export function coverMedia(draft: ContentDraftLike): ContentMedia | null {
  const media = contentMedia(draft);
  return media.find(item => item.id === draft.coverMediaId) ?? media[0] ?? null;
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

export function mediaId(contentId: string, index: number): string {
  return `${contentId}:media:${index}:${Math.random().toString(36).slice(2, 7)}`;
}
