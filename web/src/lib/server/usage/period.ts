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

// ════════════════════════════════════════════════════════════════════════════════
// MONTHLY SUB-WINDOWS INSIDE A LONGER SUBSCRIPTION PERIOD (annual plans)
// ════════════════════════════════════════════════════════════════════════════════
// Product rule (裁决 #2 / PRD v3.2 §9.1): an ANNUAL subscriber pays yearly but gets
// the SAME MONTHLY allowances as a monthly subscriber, reset MONTHLY, anchored on the
// subscription start. Billing cadence and allowance cadence are separate concerns.
//
// The webhook hands us the subscription's current_period_start/end, which for an
// annual plan is a TWELVE-MONTH window. Feeding that to usage_ensure_account would
// store a 12-month usage period, so the ledger would only reset once a year. The fix
// is entirely on this side: derive the monthly sub-window that contains `now` and pass
// THAT as p_period_start/end, while p_period_anchor stays the subscription start.
//
// WHY NO MIGRATION: the v56 rollover already advances by whole months from the stored
// anchor (`anchor + N months`, smallest N with anchor + N months > now). Once the
// FIRST period we insert is one month wide and the anchor is the subscription start,
// every subsequent rollover the RPC performs is already monthly — including across the
// year-2 renewal boundary, because year-2's start is anchor + 12 months, i.e. a point
// on the very same monthly lattice. The RPC contract is untouched.

/** A half-open monthly window plus the month index N it came from (window = [anchor+(N-1)mo, anchor+N mo)). */
export type MonthlyWindow = {
  start: Date;
  end: Date;
  /** Smallest whole month count N with anchor + N months > now. Always >= 1. */
  n: number;
};

/**
 * The monthly window containing `now`, measured in whole months from `anchorMs`.
 *
 * This is the v56 rollover rule expressed in TS, character for character:
 *   find the smallest whole N such that  anchor + N months  is STRICTLY after now,
 *   then window = [anchor + (N-1) months, anchor + N months).
 * Month arithmetic is addMonthsUtcClamped, which reproduces Postgres's end-of-month
 * clamp (2024-01-31 + 1 month = 2024-02-29). Every boundary is computed from the FIXED
 * anchor rather than from the previous boundary, so there is no drift and a month-end
 * anchor recovers its day-of-month the moment the target month is long enough.
 *
 * When `now` is at or before the anchor (a subscription whose start is in the future,
 * or the very instant it begins) N stays 1 and the window is [anchor, anchor+1mo) —
 * the same degenerate-but-valid answer freePeriodForNow gives. The 1200-month (100y)
 * guard mirrors the SQL safety valve so a corrupt anchor cannot spin the loop.
 *
 * PURE: no clock, no DB, no env. `nowMs` is always passed in.
 */
export function monthlyWindowFrom(anchorMs: number, nowMs: number): MonthlyWindow {
  const anchor = new Date(anchorMs);
  let n = 1;
  while (addMonthsUtcClamped(anchor, n).getTime() <= nowMs && n < 1200) {
    n += 1;
  }
  return {
    start: addMonthsUtcClamped(anchor, n - 1),
    end: addMonthsUtcClamped(anchor, n),
    n,
  };
}

/**
 * Keep a monthly sub-window inside the subscription's current_period_end.
 *
 * Two distinct jobs, and the second one is the load-bearing safety property:
 *
 *  1. TRUNCATE the final sub-window. An annual period is rarely an exact whole number
 *     of months away from every boundary — and a plan's last month can overhang the
 *     subscription end by hours (or by a day, via the month-end clamp). The window must
 *     never claim allowance past the point the renewal webhook will re-anchor from.
 *
 *  2. REPAIR a stale window. If `now` is already at or past the subscription end (a
 *     late renewal webhook, a lazy ensure fired after expiry, a replayed event), the
 *     naive window computed from `now` starts AT OR AFTER subEnd. Clamping only the end
 *     would then yield end <= start, and usage_ensure_account raises
 *     `p_period_end must be after p_period_start` → the webhook 500s → Creem retries
 *     forever. So instead we recompute the LAST window that still lies inside the
 *     subscription (the one containing subEnd − 1ms) and truncate that.
 *
 *     For a MONTHLY subscription this repair is what makes the change a no-op: a stale
 *     monthly hint re-derives exactly [start, end) — the same pair passed through
 *     verbatim today.
 *
 * `subscriptionEndMs` that is not a finite number (absent/unparseable hint end) returns
 * the window untouched: with no known subscription end there is nothing to clamp to,
 * and inventing one would freeze the window.
 */
export function clampToSubscriptionEnd(
  window: MonthlyWindow,
  subscriptionEndMs: number,
  anchorMs: number,
): MonthlyWindow {
  if (!Number.isFinite(subscriptionEndMs)) return window;
  // Subscription end at or before the anchor is a contradictory hint; the caller's
  // ordering repair (paidPeriodFromMirror) owns that case, so leave the window alone
  // rather than produce an empty period here.
  if (subscriptionEndMs <= anchorMs) return window;

  let w = window;
  if (w.start.getTime() >= subscriptionEndMs) {
    // Stale: fall back to the last window that still contains a point inside the
    // subscription. subEnd − 1ms is inside by construction (subEnd > anchor).
    w = monthlyWindowFrom(anchorMs, subscriptionEndMs - 1);
  }
  if (w.end.getTime() > subscriptionEndMs) {
    return { start: w.start, end: new Date(subscriptionEndMs), n: w.n };
  }
  return w;
}
