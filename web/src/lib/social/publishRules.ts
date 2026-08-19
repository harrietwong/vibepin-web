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

import type { SocialProvider } from "./platforms";
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
 */
export function pendingDestinations(
  intent: readonly ScheduledDestination[],
  alreadyAttempted: readonly { provider: string; status: string }[],
): ScheduledDestination[] {
  const done = new Set(
    alreadyAttempted.filter(r => r.status === "published").map(r => r.provider),
  );
  return intent.filter(d => !done.has(d.provider));
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
