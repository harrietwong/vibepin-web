/**
 * cardView — the ONE derivation of what a Create Pins card shows (PRD 0826 §3–§6).
 *
 * The card used to compute its own variant, its own "is this failed", its own result
 * rows and its own primary action inline in JSX, which is how a Content could read as
 * Posted in one branch and Failed in another within the same render. This module is
 * pure and framework-free: PinBoardCard renders exactly what it returns, and the test
 * suite exercises the same function the UI uses (a parallel fork of this logic in a
 * test would prove nothing about the card).
 *
 * Deliberately NOT here: any user-facing string. Everything is a key or a raw datum;
 * the component translates. That keeps this testable in node without a locale.
 */

import {
  contentDestinationResults,
  contentMedia,
  hasFailedDestination,
  hasPublishedDestination,
  type ContentDraftLike,
  type DestinationPublishResult,
} from "@/lib/contentDraftModel";

/** The four card shapes the PRD defines, plus the in-flight generation state. */
export type CardVariant = "draft" | "scheduled" | "posted" | "failed" | "generating";

/**
 * The single primary button a card offers.
 *
 * `publish` is used verbatim on Draft/Scheduled/Posted-editing (PRD §20: every real
 * publish action reads "Publish" — never "Publish now" / "Retry publish"). `retry` is
 * the failed-card publish, which differs in SCOPE, not in wording of the concept:
 * it re-sends only the destinations that failed (`onlyPending: true`).
 */
export type CardPrimaryAction = "schedule" | "publish" | "retry" | "generating";

/** One destination line under "View results". */
export interface CardResultRow {
  destinationId: string;
  provider: DestinationPublishResult["provider"];
  status: DestinationPublishResult["status"];
  accountLabel?: string;
  boardName?: string;
  /** Only a real http(s) permalink on a `published` row — never a link that 404s. */
  postUrl?: string;
  publishedAt?: string;
  /** Present only on `failed` rows; the CALLER maps it to a customer-safe sentence. */
  errorCode?: string;
  errorMessage?: string;
  /** True when this row was superseded by a later publish of the same destination. */
  superseded?: boolean;
}

export interface CardViewModel {
  variant: CardVariant;
  /** "1 / N" for multi-image Content (cover is always 1); null for a single image. */
  counter: string | null;
  /** Total media items — the card sizes its strip from this without re-deriving. */
  mediaCount: number;
  /** Current publish outcome per destination, latest attempt first-class. */
  resultRows: CardResultRow[];
  /** Superseded `published` rows from earlier publishes, newest last. */
  earlierResultRows: CardResultRow[];
  /**
   * A destination failed. TRUE on a partial success too — that Content is Posted
   * AND needs attention, which is why this is not `variant === "failed"`.
   */
  needsAttention: boolean;
  primaryAction: CardPrimaryAction;
  /** At least one destination published (drives "Published {relative time}"). */
  hasPublished: boolean;
  /** The newest `publishedAt` across all rows, ISO. Null when nothing published. */
  latestPublishedAt: string | null;
}

/** Only expose a permalink the browser can actually open. */
function safeUrl(url: string | undefined): string | undefined {
  const value = (url ?? "").trim();
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}

function toRow(result: DestinationPublishResult, superseded = false): CardResultRow {
  const row: CardResultRow = {
    destinationId: result.destinationId,
    provider: result.provider,
    status: result.status,
    ...(result.accountLabel ? { accountLabel: result.accountLabel } : {}),
    ...(result.boardName ? { boardName: result.boardName } : {}),
    ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  };
  // A link is offered ONLY for a published row with a real URL (PRD 0809 §6).
  const url = result.status === "published" ? safeUrl(result.postUrl) : undefined;
  if (url) row.postUrl = url;
  if (superseded) row.superseded = true;
  return row;
}

/** The newest ISO timestamp in a list, or null. */
function newestTimestamp(values: Array<string | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (!trimmed) continue;
    const ms = new Date(trimmed).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) { bestMs = ms; best = trimmed; }
  }
  return best;
}

/**
 * The lifecycle the card renders, given the store's lifecycle verdict.
 *
 * `getPinLifecycle` is the authority and is passed IN rather than re-derived here:
 * the board already computed it for filtering/grouping, and a second derivation is
 * exactly how a card once showed "Scheduled" in a Posted column. The only mapping is
 * naming — the store calls the empty state `unscheduled`, the PRD calls it `draft`.
 */
export type LifecycleInput = "generating" | "failed" | "unscheduled" | "scheduled" | "posted";

export function cardVariant(lifecycle: LifecycleInput): CardVariant {
  return lifecycle === "unscheduled" ? "draft" : lifecycle;
}

/**
 * Build the view model for one card.
 *
 * Partial success is the case worth stating: a Content whose Pinterest row published
 * and whose Instagram row failed is `posted` (the store's own rule — posted beats
 * failed) with `needsAttention: true` and a `retry` primary, because the actionable
 * next step is re-sending the failed destination only, not republishing the Pin.
 */
export function buildCardViewModel(
  draft: ContentDraftLike,
  lifecycle: LifecycleInput,
  options: { editing?: boolean } = {},
): CardViewModel {
  const variant = cardVariant(lifecycle);
  const media = contentMedia(draft);
  const results = contentDestinationResults(draft);
  const resultRows = results.map(result => toRow(result));
  const earlier = (draft as { previousResults?: DestinationPublishResult[] }).previousResults ?? [];
  const earlierResultRows = earlier.map(result => toRow(result, true));
  const needsAttention = hasFailedDestination(draft);
  const hasPublished = hasPublishedDestination(draft);

  // The primary action, in priority order:
  //   generating → nothing to do but wait
  //   any failed destination (whole-card failure OR partial success) → Retry
  //   editing a Scheduled/Posted card → Publish (a fresh publish of what is on screen)
  //   scheduled → Publish (with the "publishes now instead of {time}" confirm)
  //   posted → Publish (republish); draft → Schedule
  const primaryAction: CardPrimaryAction =
    variant === "generating" ? "generating"
    : needsAttention ? "retry"
    : options.editing && (variant === "scheduled" || variant === "posted") ? "publish"
    : variant === "scheduled" || variant === "posted" ? "publish"
    : "schedule";

  return {
    variant,
    counter: media.length > 1 ? `1 / ${media.length}` : null,
    mediaCount: media.length,
    resultRows,
    earlierResultRows,
    needsAttention,
    primaryAction,
    hasPublished,
    latestPublishedAt: newestTimestamp(results.map(result => result.publishedAt)),
  };
}

/**
 * "3 hours ago" style label input — returns the unit + amount, never a string, so the
 * component can translate. Null when the timestamp is unusable.
 */
export function relativePublishedParts(
  iso: string | null,
  now: number = Date.now(),
): { unit: "now" | "minute" | "hour" | "day"; value: number } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  // A clock-skewed future stamp reads as "just now" rather than a negative age.
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return { unit: "now", value: 0 };
  if (minutes < 60) return { unit: "minute", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", value: hours };
  return { unit: "day", value: Math.floor(hours / 24) };
}
