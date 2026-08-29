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
  /**
   * What the PLATFORM itself reported about this destination — the HTTP status it
   * really returned and any resource id it really created. Carried on the outcome
   * (rather than recomputed later from `error` text) because the usage refund
   * decision is made after the whole fan-out, and by then the thrown error is gone.
   * Read ONLY by lib/server/usage/deliveryOutcome.ts, never rendered.
   *
   * Both undefined = no platform status was observed → `delivery_unknown` → the
   * scheduled-post charge stands. NOT persisted to the destination result rows.
   */
  providerStatus?: number | null;
  providerResourceId?: string | null;
  /**
   * True when this destination failed BEFORE any request left us (no connection,
   * a platform we cannot publish to, a payload our own rules refused). Refundable
   * `not_sent` regardless of status, and set by the dispatcher that knows — the
   * refund classifier never infers it from an error message.
   */
  preNetwork?: boolean;
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
export function pendingDestinations(
  intent: readonly ScheduledDestination[],
  alreadyAttempted: readonly { provider: string; status: string; socialConnectionId?: string | null }[],
): ScheduledDestination[] {
  const published = alreadyAttempted.filter(r => r.status === "published");
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
