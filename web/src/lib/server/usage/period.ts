/**
 * Usage-account period math + plan→limit mapping (Phase 3).
 *
 * PURE and DB-FREE on purpose: this is the TS half of the account-lifecycle
 * contract, and it is unit-tested (fast suite) without touching Postgres. The
 * DRIFT-FREE rollover itself lives in the v56 `usage_ensure_account` RPC — this
 * module only computes the *inputs* that RPC needs:
 *   - the three snapshot limits for a plan (from the canonical entitlement config), and
 *   - the period + anchor to establish on FIRST init.
 *
 * Two period sources:
 *   - PAID: the Creem subscription mirror's current_period_start / current_period_end.
 *     When the start is absent (some events carry only the end), we derive a sane
 *     start by anchoring one month before the known end — documented below.
 *   - FREE: a monthly window anchored on the user's auth.users.created_at (signup),
 *     rolled forward to contain "now". The anchor is signup so a free user's cycle is
 *     stable across their lifetime.
 *
 * Once an account EXISTS, the v56 RPC owns period advancement from the stored anchor;
 * these computed periods matter only for the INSERT. That is why a slightly-off
 * derived paid start is harmless: it seeds the first period, after which the anchor
 * (which we set to the start) governs every future boundary.
 */

import {
  PLAN_ENTITLEMENTS,
  type PlanKey,
} from "../planEntitlements";

/** The three snapshot limits usage_accounts stores (null = unlimited). */
export type AccountLimits = {
  aiImagesLimit: number | null;
  aiTextGenerationsLimit: number | null;
  scheduledPostsLimit: number | null;
};

/** A concrete billing/usage period plus the anchor the RPC rolls from. */
export type PeriodSpec = {
  periodStart: Date;
  periodEnd: Date;
  /** Stable day-of-cycle the rollover advances by whole months from. */
  periodAnchor: Date;
};

/**
 * Map a plan to the three usage_accounts snapshot limits, read from the single
 * source of truth (PLAN_ENTITLEMENTS). `monthlyAiTextGenerations` is unpublished
 * config but is a real per-period allowance, so it maps to the text limit column.
 * `null` (unlimited) passes straight through — the RPC and CHECK constraints treat
 * a NULL limit as "no cap, still counted".
 */
export function planToAccountLimits(plan: PlanKey): AccountLimits {
  const e = PLAN_ENTITLEMENTS[plan];
  return {
    aiImagesLimit: e.monthlyAiImages,
    aiTextGenerationsLimit: e.monthlyAiTextGenerations,
    scheduledPostsLimit: e.monthlyScheduledPosts,
  };
}

/**
 * Add `n` whole months to a UTC instant with END-OF-MONTH CLAMPING that matches
 * Postgres `timestamptz + interval 'n months'`: 2024-01-31 + 1 month = 2024-02-29,
 * NOT 2024-03-02. We build the target from UTC components and clamp the day to the
 * target month's length. Computing every boundary from a FIXED anchor (never from the
 * previous result) is what makes the free-plan rollover drift-free, mirroring the SQL.
 */
export function addMonthsUtcClamped(anchor: Date, n: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + n;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const anchorDay = anchor.getUTCDate();
  // Last day of the target month (day 0 of the *next* month in UTC).
  const daysInTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  const day = Math.min(anchorDay, daysInTargetMonth);
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * The monthly FREE-plan window that contains `now`, anchored on signup. Finds the
 * smallest N with anchor + N months > now and returns [anchor+(N-1)mo, anchor+N mo).
 * Anchor is preserved as the periodAnchor so the RPC rolls from signup, not from now.
 * Drift-free by the same construction as the SQL: every boundary is anchor + k months.
 */
export function freePeriodForNow(signup: Date, now: Date): PeriodSpec {
  let n = 1;
  // Guard against a pathological signup far in the future (n stays 1 → start=anchor).
  while (addMonthsUtcClamped(signup, n).getTime() <= now.getTime() && n < 1200) {
    n += 1;
  }
  return {
    periodStart: addMonthsUtcClamped(signup, n - 1),
    periodEnd: addMonthsUtcClamped(signup, n),
    periodAnchor: signup,
  };
}

/**
 * The period for a PAID plan from the Creem mirror dates.
 *   - both present            → use them verbatim; anchor = start.
 *   - only end present        → derive start = end − 1 month (the typical monthly
 *                               billing width); anchor = derived start. This only
 *                               affects the FIRST init; the anchor then governs
 *                               rollovers, so a one-off derived start cannot drift.
 *   - only start present      → derive end = start + 1 month; anchor = start.
 *   - neither present         → fall back to a monthly window anchored on `now`
 *                               (last resort; the webhook normally has at least end).
 * Returns null only when the provided strings are unparseable AND both absent.
 */
export function paidPeriodFromMirror(
  startIso: string | null,
  endIso: string | null,
  now: Date,
): PeriodSpec {
  const start = parseIso(startIso);
  const end = parseIso(endIso);

  if (start && end && end.getTime() > start.getTime()) {
    return { periodStart: start, periodEnd: end, periodAnchor: start };
  }
  if (end) {
    const derivedStart = addMonthsUtcClamped(end, -1);
    return { periodStart: derivedStart, periodEnd: end, periodAnchor: derivedStart };
  }
  if (start) {
    return {
      periodStart: start,
      periodEnd: addMonthsUtcClamped(start, 1),
      periodAnchor: start,
    };
  }
  // Neither date usable: monthly window anchored on now.
  return {
    periodStart: now,
    periodEnd: addMonthsUtcClamped(now, 1),
    periodAnchor: now,
  };
}

function parseIso(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
