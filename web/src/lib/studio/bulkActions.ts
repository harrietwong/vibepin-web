/**
 * bulkActions — the pure decisions behind Create Pins bulk Publish and bulk Delete
 * (PRD 0826 §19, §30).
 *
 * Everything here is a pure function over drafts. The point is that the confirm sheet
 * and the executor read the SAME partition: a sheet that says "3 ready, 2 blocked" and
 * an executor that then publishes a different 3 is the defect this module exists to
 * prevent. The component decides nothing about who publishes — it renders this and
 * then iterates exactly `ready`.
 *
 * The subtle one is `alreadyPublished`. `publishContent(id, { onlyPending: true })`
 * falls back to re-attempting EVERY destination when none is pending — an explicit
 * "publish again" that is right for a single card's Publish button and catastrophic
 * for a bulk action, where a fully-Posted item in a large selection would be silently
 * double-posted to Pinterest. So a Content whose every destination already published
 * is partitioned out here and never handed to the executor.
 */

import type { PinDraft } from "../pinDraftStore";
import { getPinLifecycle, type PinLifecycle } from "./pinLifecycle";
import {
  contentDestinations,
  contentDestinationResults,
  findDestinationResult,
} from "../contentDraftModel";
import { explainPublishBlockers, type PublishBlocker } from "./publishContent";

/** The minimum a bulk row needs: an id, something to name it by, and its state. */
export type BulkDraftLike = PinDraft;

export type BulkPublishItem = {
  id: string;
  /** Display name — the caller supplies the "Untitled" fallback in its own locale. */
  title: string;
  lifecycle: PinLifecycle;
};

export type BulkPublishBlockedItem = BulkPublishItem & {
  /** Non-empty. Every reason the merchant must fix, not just the first. */
  blockers: PublishBlocker[];
};

export type BulkPublishPartition = {
  /** Publishable now — at least one destination survives the pre-dispatch checks. */
  ready: BulkPublishItem[];
  /** Nothing can be sent for these; each carries its reasons. */
  blocked: BulkPublishBlockedItem[];
  /** Every destination already published — excluded to avoid double-posting. */
  alreadyPublished: BulkPublishItem[];
  /**
   * Of `ready`, how many are currently Scheduled. The sheet must say these publish
   * NOW instead of waiting for their slot (PRD §19) — a bulk publish silently
   * overriding a schedule is the surprise we refuse to ship.
   */
  scheduledNowCount: number;
  /** Still generating — never publishable, and not a merchant error to fix. */
  generating: BulkPublishItem[];
};

function titleOf(draft: BulkDraftLike, untitled: string): string {
  const t = typeof draft.title === "string" ? draft.title.trim() : "";
  return t || untitled;
}

/** True when this Content has destinations and every one of them already published. */
export function isFullyPublished(draft: BulkDraftLike): boolean {
  const destinations = contentDestinations(draft);
  if (!destinations.length) return false;
  const results = contentDestinationResults(draft);
  return destinations.every(d => findDestinationResult(results, d)?.status === "published");
}

/**
 * Split a selection into what a bulk publish will actually do.
 *
 * Order matters: generating → already published → blocked → ready. A generating
 * Content has no media yet, so asking `explainPublishBlockers` about it would report
 * "add an image" — technically true, useless as advice, and it would push a row the
 * merchant cannot act on into the blocked list.
 */
export function partitionBulkPublish(
  drafts: readonly BulkDraftLike[],
  opts: { untitled: string },
): BulkPublishPartition {
  const partition: BulkPublishPartition = {
    ready: [], blocked: [], alreadyPublished: [], scheduledNowCount: 0, generating: [],
  };
  for (const draft of drafts) {
    const lifecycle = getPinLifecycle(draft);
    const item: BulkPublishItem = { id: draft.id, title: titleOf(draft, opts.untitled), lifecycle };
    if (lifecycle === "generating") { partition.generating.push(item); continue; }
    if (isFullyPublished(draft)) { partition.alreadyPublished.push(item); continue; }

    const blockers = explainPublishBlockers(draft);
    const destinationCount = contentDestinations(draft).length;
    // Partial block is still ready: PRD §29 says one platform's rule may not become a
    // whole-Content block, so a Content with 2 destinations and 1 blocker publishes.
    const fullyBlocked = blockers.length > 0
      && (blockers.some(b => b.code === "no_destinations") || blockers.length >= destinationCount);
    if (fullyBlocked) { partition.blocked.push({ ...item, blockers }); continue; }

    partition.ready.push(item);
    if (lifecycle === "scheduled") partition.scheduledNowCount += 1;
  }
  return partition;
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * How a selection will be deleted, grouped by what deletion MEANS for each state.
 *
 * Three different things happen and the merchant is entitled to know which apply
 * before confirming: a Draft just goes; a Scheduled item loses its slot first (so the
 * publish worker cannot pick up a Content that no longer exists); a Posted item leaves
 * VibePin while its live post stays up on Pinterest/Instagram/Facebook. That last one
 * is the one people assume wrong, so it is stated explicitly in the copy.
 */
export type DeleteImpact = {
  total: number;
  /** Unscheduled / failed / generating — deleted outright. */
  draftCount: number;
  /** Scheduled — unscheduled first, then deleted. */
  scheduledCount: number;
  /** Posted — removed from VibePin; the live posts are NOT deleted. */
  postedCount: number;
  /** Ids to unschedule (a subset of `ids`) before deleting, in selection order. */
  unscheduleIds: string[];
  /** Everything to delete, in selection order. */
  ids: string[];
};

export function summarizeDeleteImpact(drafts: readonly BulkDraftLike[]): DeleteImpact {
  const impact: DeleteImpact = {
    total: drafts.length, draftCount: 0, scheduledCount: 0, postedCount: 0,
    unscheduleIds: [], ids: [],
  };
  for (const draft of drafts) {
    const lifecycle = getPinLifecycle(draft);
    impact.ids.push(draft.id);
    // Posted wins over scheduled: getPinLifecycle already resolves that precedence, so
    // a Content that published and was re-scheduled counts once, as posted.
    if (lifecycle === "posted") impact.postedCount += 1;
    else if (lifecycle === "scheduled") {
      impact.scheduledCount += 1;
      impact.unscheduleIds.push(draft.id);
    } else impact.draftCount += 1;
  }
  return impact;
}

// ── Result summary ────────────────────────────────────────────────────────────

export type BulkPublishOutcomeStatus = "published" | "failed" | "skipped";

export type BulkPublishOutcomeRow = {
  id: string;
  title: string;
  status: BulkPublishOutcomeStatus;
  /**
   * Customer-safe reason. Required for failed/skipped: "Publish failed" with no reason
   * is the exact thing PRD §19 forbids, so the caller resolves a real message (the
   * destination's errorMessage, or a translated blocker code) before building the row.
   */
  message?: string;
  /** Destinations that succeeded, e.g. ["pinterest", "instagram"]. */
  publishedProviders?: string[];
};

export type BulkPublishSummary = {
  publishedCount: number;
  failedCount: number;
  skippedCount: number;
  /** Only the rows the merchant must act on, in input order. */
  problems: BulkPublishOutcomeRow[];
  rows: BulkPublishOutcomeRow[];
  /** "all_published" | "partial" | "none_published" — drives tone, not wording. */
  tone: "all_published" | "partial" | "none_published";
};

export function summarizeBulkPublish(rows: readonly BulkPublishOutcomeRow[]): BulkPublishSummary {
  const publishedCount = rows.filter(r => r.status === "published").length;
  const failedCount = rows.filter(r => r.status === "failed").length;
  const skippedCount = rows.filter(r => r.status === "skipped").length;
  const problems = rows.filter(r => r.status !== "published");
  const tone: BulkPublishSummary["tone"] = publishedCount === 0
    ? "none_published"
    : problems.length === 0 ? "all_published" : "partial";
  return { publishedCount, failedCount, skippedCount, problems, rows: [...rows], tone };
}
