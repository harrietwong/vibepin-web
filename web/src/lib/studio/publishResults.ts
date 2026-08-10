/**
 * One publish, one row per destination (PRD 0809 §5/§6).
 *
 * A publish can now fan out to several platforms, which broke the old shape in two ways:
 * a single "Published successfully" spoke for whatever Pinterest did, and one global
 * "View Pin" pointed at Pinterest no matter which platforms actually received the post.
 *
 * This assembles the durable per-destination result from what is already persisted —
 * Pinterest from the draft's own fields, everything else from `socialPosts[]` — so the
 * modal and the Posted detail read the same thing, and it survives a refresh. Toasts
 * stay what they are: immediate feedback, never the record.
 */

export type PublishResultRow = {
  provider: string;
  /** "published" today; the shape carries status so a failed row can join later. */
  status: "published";
  /** Which account received it, when we know. Never invented. */
  accountName?: string | null;
  /** Pinterest's board. Absent for platforms that have no equivalent. */
  boardName?: string | null;
  /** Public permalink. A "View on X" action is offered ONLY when this is present. */
  postUrl?: string | null;
  postId?: string | null;
  publishedAt?: string | null;
};

export type PublishResultSource = {
  /** Pinterest lives on the draft itself, not in socialPosts. */
  postedAt?: string | null;
  remotePinId?: string | null;
  remotePinUrl?: string | null;
  boardName?: string | null;
  targetAccountLabel?: string | null;
  socialPosts?: Array<{
    provider: string;
    postId?: string;
    postUrl?: string;
    publishedAt?: string;
    accountName?: string;
  }> | null;
};

function clean(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Every destination this Pin actually reached, Pinterest first.
 *
 * Pinterest counts as published when it has a postedAt or a remote id — the same test the
 * drawer already used for its "published" view, so nothing that used to show a result
 * stops showing one.
 */
export function publishResultRows(draft: PublishResultSource | null | undefined): PublishResultRow[] {
  if (!draft) return [];
  const rows: PublishResultRow[] = [];

  const pinUrl = clean(draft.remotePinUrl);
  const pinId = clean(draft.remotePinId);
  if (clean(draft.postedAt) || pinId || pinUrl) {
    rows.push({
      provider: "pinterest",
      status: "published",
      accountName: clean(draft.targetAccountLabel),
      boardName: clean(draft.boardName),
      // Reconstructing a permalink from the id is a fallback for drafts published before
      // remotePinUrl existed — not a guess: this is Pinterest's own canonical Pin URL.
      postUrl: pinUrl ?? (pinId ? `https://www.pinterest.com/pin/${pinId}/` : null),
      postId: pinId,
      publishedAt: clean(draft.postedAt),
    });
  }

  for (const p of draft.socialPosts ?? []) {
    const provider = clean(p?.provider);
    if (!provider || provider === "pinterest") continue;   // Pinterest is handled above
    rows.push({
      provider,
      status: "published",
      accountName: clean(p.accountName),
      postUrl: clean(p.postUrl),
      postId: clean(p.postId),
      publishedAt: clean(p.publishedAt),
    });
  }

  return rows;
}

/**
 * Whether to offer "View on {platform}" for a row.
 *
 * Only a real http(s) permalink earns the action. A missing or malformed URL must render
 * as no button rather than a link that 404s — the PRD's rule that only a genuinely
 * published destination with a real external URL gets a view action.
 */
export function canViewExternally(row: Pick<PublishResultRow, "status" | "postUrl">): boolean {
  if (row.status !== "published") return false;
  const url = clean(row.postUrl);
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

/** True once this Pin has any durable publish result to show. */
export function hasPublishResults(draft: PublishResultSource | null | undefined): boolean {
  return publishResultRows(draft).length > 0;
}
