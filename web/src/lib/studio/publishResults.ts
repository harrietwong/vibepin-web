/**
 * The presentation shape for one publish result row — a VIEW over the one reader.
 *
 * This file used to hold a SECOND derivation of the same fact: it rebuilt the
 * per-destination result set from `postedAt` / `remotePinId` / `socialPosts[]` while
 * `contentDestinationResults()` rebuilt it from those same fields PLUS the stored
 * `destinationResults[]`. Two readers of one fact is how a destination that really
 * published shows in one surface and not another — and it could not see stored rows
 * at all, so a per-account failure reason had nowhere to surface.
 *
 * There is now exactly one reader (`contentDestinationResults`). What remains here is
 * the mapping into the row shape `PublishResults.tsx` renders.
 */

import {
  contentDestinationResults,
  canViewExternally as canViewResultExternally,
  type ContentDraftLike,
  type DestinationPublishResult,
} from "../contentDraftModel";

export type PublishResultRow = {
  provider: string;
  /** A failed destination now gets a row too, with the reason it failed. */
  status: "published" | "failed" | "publishing" | "pending";
  /** Which account received it, when we know. Never invented. */
  accountName?: string | null;
  /** Pinterest's board. Absent for platforms that have no equivalent. */
  boardName?: string | null;
  /** Public permalink. A "View on X" action is offered ONLY when this is present. */
  postUrl?: string | null;
  postId?: string | null;
  publishedAt?: string | null;
  /**
   * The RAW upstream failure text for a `failed` row. Diagnostic payload, not display
   * text — the UI maps it through `getPublishErrorDisplayKey` and never renders it.
   */
  errorMessage?: string | null;
  /** Stable failure code, when the platform gave one. Drives the same mapping. */
  errorCode?: string | null;
};

/** The draft fields these rows are read from. A superset is fine. */
export type PublishResultSource = Partial<ContentDraftLike>;

function clean(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function toPublishResultRow(result: DestinationPublishResult): PublishResultRow {
  return {
    provider: result.provider,
    status: result.status,
    accountName: clean(result.accountLabel),
    boardName: clean(result.boardName),
    postUrl: clean(result.postUrl),
    postId: clean(result.remoteId),
    publishedAt: clean(result.publishedAt),
    errorMessage: clean(result.errorMessage),
    errorCode: clean(result.errorCode),
  };
}

/**
 * Every destination this Content reached (or tried to), in result order.
 *
 * Delegates to the single reader, so a stored per-destination record and a legacy
 * draft with only the old fields both render through the same path.
 */
export function publishResultRows(draft: PublishResultSource | null | undefined): PublishResultRow[] {
  if (!draft) return [];
  return contentDestinationResults({ ...draft, id: draft.id ?? "", imageUrl: draft.imageUrl ?? "" })
    .map(toPublishResultRow);
}

/**
 * Whether to offer "View on {platform}" for a row. Only a real http(s) permalink earns
 * the action — a missing or malformed URL renders as no button rather than a dead link.
 */
export function canViewExternally(row: Pick<PublishResultRow, "status" | "postUrl">): boolean {
  return canViewResultExternally({
    status: row.status,
    postUrl: row.postUrl ?? undefined,
  });
}

/** True once this Content has any durable publish result to show. */
export function hasPublishResults(draft: PublishResultSource | null | undefined): boolean {
  return publishResultRows(draft).length > 0;
}
