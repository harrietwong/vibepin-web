/**
 * Pure decision rules for a multi-destination publish.
 *
 * Split out from `publishFanout` deliberately: these are the rules that decide
 * what a merchant SEES — whether an attempt counts as published, and what a
 * retry is allowed to re-send — and they must be importable (and testable)
 * without the Supabase client that the dispatch layer constructs at module load.
 *
 * No I/O, no secrets, no DB. Import-safe everywhere.
 */

import { isSocialProvider, type SocialProvider } from "./platforms";
import type { ScheduledDestination } from "../pinDraftStore";

export type DestinationStatus = "pending" | "skipped" | "publishing" | "published" | "failed";
export type JobStatus = "draft" | "publishing" | "published" | "partially_published" | "failed";

export type DestinationOutcome = {
  provider: SocialProvider;
  status: DestinationStatus;
  socialConnectionId: string | null;
  externalPostId?: string | null;
  externalPostUrl?: string | null;
  accountName?: string | null;
  error?: string | null;
};

/** A Pinterest result produced by the dedicated Pinterest path, folded in here. */
export type PinterestOutcome = {
  ok: boolean;
  connectionId?: string | null;
  pinId?: string | null;
  pinUrl?: string | null;
  error?: string | null;
};

/**
 * Roll the per-destination results into the attempt's status.
 *
 * `skipped` destinations are excluded: a platform we deliberately did not attempt
 * must not make a fully successful publish look partial. But a set containing
 * ONLY skips is a failure — nothing was delivered, and reporting that as success
 * is exactly the "UI says published, provider never got it" defect.
 */
export function rollUpJobStatus(outcomes: readonly DestinationOutcome[]): JobStatus {
  const active = outcomes.filter(o => o.status !== "skipped");
  if (!active.length) return "failed";
  const published = active.filter(o => o.status === "published").length;
  if (published === active.length) return "published";
  if (published > 0) return "partially_published";
  return "failed";
}

/**
 * Destinations that still need dispatching, given what already happened.
 *
 * This is what makes a retry safe: a destination that has already published is
 * never dispatched again, so retrying a partial failure cannot double-post to
 * the platforms that worked. Anything not yet `published` — failed, still
 * `publishing` after a crash — stays pending, so an interrupted attempt is
 * completed rather than abandoned.
 *
 * Keyed by ACCOUNT, not by platform. Keying on the provider alone meant a merchant
 * with two Facebook Pages who published to one and failed on the other got nothing
 * on retry: the platform read as "already done" and the second Page was skipped
 * forever. An attempted row that names no account keeps the old provider-wide
 * meaning (a legacy row cannot say which account it was, and treating it as
 * account-specific would be the double-post it exists to prevent).
 */
/** A stored result row, as much of it as the pending rule needs. */
export type AttemptedResult = {
  provider: string;
  status: string;
  socialConnectionId?: string | null;
  publishedAt?: string | null;
};

/**
 * Does this prior result close its destination for THIS schedule?
 *
 * "Already published" is not a property of a destination, it is a property of a
 * destination AND a schedule. Reading it as the former is what made rescheduling a
 * Posted Content do nothing at all: the results from the original publish were still
 * on the payload, the cron therefore owed no destination, and it "completed" the row
 * by clearing the slot the merchant had just chosen. Nothing published, nothing
 * failed, no error — the schedule simply evaporated.
 *
 * So a published row closes its destination only when it was published FOR the
 * schedule being processed (`publishedAt >= scheduledAt`), which is the stale-claim
 * re-run this rule exists to protect. Published BEFORE the current `scheduled_at`, it
 * describes an earlier publish, and the destination is owed again — the persist then
 * archives the old row into `previousResults`, keeping its permalink.
 *
 * Every uncertain case resolves to "closed": no schedule given, an unparseable
 * timestamp, or a row with no `publishedAt` at all (rows written before per-
 * destination timestamps existed). Guessing the other way would double-post, and no
 * behaviour of a legacy row changes.
 */
export function publishedForSchedule(
  result: AttemptedResult,
  scheduledAt?: string | null,
): boolean {
  if (result.status !== "published") return false;
  if (!scheduledAt) return true;
  const scheduledMs = Date.parse(scheduledAt);
  if (Number.isNaN(scheduledMs)) return true;
  const publishedAt = typeof result.publishedAt === "string" ? result.publishedAt.trim() : "";
  if (!publishedAt) return true;
  const publishedMs = Date.parse(publishedAt);
  if (Number.isNaN(publishedMs)) return true;
  return publishedMs >= scheduledMs;
}

export interface PendingOptions {
  /**
   * The schedule being processed. Given, a destination published BEFORE it is owed
   * again (the merchant re-scheduled a Posted Content). Omitted, any prior `published`
   * row closes its destination — the rule this function always had.
   */
  scheduledAt?: string | null;
}

export function pendingDestinations(
  intent: readonly ScheduledDestination[],
  alreadyAttempted: readonly AttemptedResult[],
  options?: PendingOptions,
): ScheduledDestination[] {
  const published = alreadyAttempted.filter(r => publishedForSchedule(r, options?.scheduledAt));
  const doneAccounts = new Set(
    published.filter(r => !!r.socialConnectionId).map(r => `${r.provider}:${r.socialConnectionId}`),
  );
  const doneProviders = new Set(
    published.filter(r => !r.socialConnectionId).map(r => r.provider),
  );
  return intent.filter(d =>
    !doneProviders.has(d.provider)
    && !doneAccounts.has(`${d.provider}:${d.socialConnectionId}`));
}

/**
 * ── The run's hard deadline ─────────────────────────────────────────────────
 *
 * The platform kills the cron invocation at `maxDuration` (300s). Killed BETWEEN a
 * provider accepting a post and the result reaching the database, the row keeps its
 * schedule and its claim; ten minutes later the claim goes stale, the row is
 * re-claimed, and the post goes out A SECOND TIME. So the run must stop starting work
 * with enough time left to finish and persist what it started.
 *
 * `CLAIM_BUDGET_MS` bounds when the run stops TAKING rows. It cannot bound a row
 * already in hand: one Content with three Instagram accounts is three container polls
 * of up to ~45s each, all inside a single claimed row. The deadline below is checked
 * per DESTINATION, which is the only granularity at which the run can still stop
 * without abandoning a post it already made.
 */
export const RUN_DEADLINE_MS = 270_000;

/**
 * Time reserved for one destination: it must be able to run to completion AND have
 * its outcome persisted before the platform's ceiling. 50s covers the slowest single
 * provider call we make (Instagram's container poll, ~45s) plus the write.
 */
export const DESTINATION_RESERVE_MS = 50_000;

/** Why a destination has no result yet. Internal/diagnostic — see `deferredOutcome`. */
export const DEFERRED_OUT_OF_TIME = "Deferred — out of time this run";

/**
 * Is there time to START another destination before the run's deadline?
 *
 * No deadline given ⇒ always true, so every caller that does not (yet) bound its run
 * behaves exactly as it did before.
 */
export function hasTimeForDestination(nowMs: number, deadlineMs?: number): boolean {
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs)) return true;
  return nowMs + DESTINATION_RESERVE_MS <= deadlineMs;
}

/**
 * The outcome for a destination the run did not have time to start.
 *
 * `pending`, deliberately, and NOT `failed`: nothing was sent, nothing went wrong, and
 * the merchant has nothing to fix. It is also not `skipped` — skipped means "we decided
 * against it", and this destination is still owed. `pendingDestinations` excludes only
 * `published`, so a pending destination is re-attempted by the next run and no other.
 */
export function deferredOutcome(destination: ScheduledDestination): DestinationOutcome {
  return {
    provider: (isSocialProvider(destination.provider) ? destination.provider : "pinterest") as SocialProvider,
    status: "pending",
    socialConnectionId: typeof destination.socialConnectionId === "string" && destination.socialConnectionId.trim()
      ? destination.socialConnectionId.trim()
      : null,
    error: DEFERRED_OUT_OF_TIME,
  };
}

/**
 * Fold the dedicated Pinterest path's result into the shared outcome shape, so a
 * merchant sees one coherent result set rather than Pinterest reported one way
 * and every other platform another.
 */
export function pinterestOutcomeRow(
  destination: ScheduledDestination,
  result: PinterestOutcome,
): DestinationOutcome {
  return {
    provider: "pinterest",
    status: result.ok ? "published" : "failed",
    // Prefer the connection that ACTUALLY published: an untargeted Pin adopts its
    // account at publish time, and the result must name the real one.
    socialConnectionId: result.connectionId ?? destination.socialConnectionId ?? null,
    externalPostId: result.pinId ?? null,
    externalPostUrl: result.pinUrl ?? null,
    error: result.ok ? null : result.error ?? "Publishing failed.",
  };
}
