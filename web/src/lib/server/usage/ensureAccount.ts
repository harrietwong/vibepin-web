/**
 * ensureAccount — the lazy, idempotent entry point that seeds / rolls a user's
 * usage_accounts row (Phase 3).
 *
 * This is the ONE place the application decides a user's period + limits and hands
 * them to the v56 `usage_ensure_account` RPC. It is idempotent (the RPC's
 * period-scoped idempotency key makes a re-call within a period a no-op and a
 * replayed rollover a no-op), so callers may invoke it before every metered action
 * — later phases (4I/4T/5B) will. Phase 3 wires only two callers: nothing here, and
 * the Creem webhook.
 *
 * PLAN → LIMITS comes from planEntitlements.ts (single source of truth). PERIOD comes
 * from one of two sources:
 *   - PAID plan: the Creem subscription mirror dates (passed in by the webhook, which
 *     has both current_period_start_date and current_period_end_date on the event).
 *   - FREE plan: a monthly window anchored on auth.users.created_at (signup), fetched
 *     via the SAME admin API path resolvePlan/the webhook already use
 *     (createServerClient().auth.admin.getUserById) — no second admin path invented.
 *
 * SECURITY: this runs service-role (SECURITY DEFINER RPC, service_role-only EXECUTE).
 * It NEVER reads user_metadata for authorization; plan comes from resolvePlan, which
 * reads the billing source of truth + the app_metadata cache only.
 */

import { createServerClient } from "../../supabase";
import { resolvePlan, type PlanKey } from "../entitlements";
import {
  planToAccountLimits,
  freePeriodForNow,
  paidPeriodFromMirror,
  monthlyWindowFrom,
  clampToSubscriptionEnd,
  type PeriodSpec,
} from "./period";

export type EnsureAccountResult = {
  ok: boolean;
  action: "created" | "rolled" | "plan_changed" | "noop";
  accountId: string;
  planKey: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  rolledPeriods: number;
};

/**
 * Optional period the CALLER already knows (the webhook passes the subscription's
 * current_period_start/end straight from the event). When omitted for a paid plan we
 * fall back to a monthly window; for a free plan the signup anchor is always used and
 * these are ignored.
 */
export type PeriodHint = {
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
};

/**
 * Fetch a user's signup instant (auth.users.created_at) via the admin API — the
 * idiomatic single-user path (getUserById), the same one entitlements.ts and the
 * Creem webhook use. Returns null when the user/created_at is unavailable, so the
 * caller can fall back rather than crash.
 */
export async function fetchSignupInstant(userId: string): Promise<Date | null> {
  const admin = createServerClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  const createdAt = (data.user as { created_at?: string | null }).created_at ?? null;
  if (!createdAt) return null;
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compute the period to establish for `plan`.
 *   - FREE: monthly window anchored on signup (falls back to a now-anchored window if
 *     signup is unavailable — a degraded but valid cycle rather than a crash).
 *   - PAID: a MONTHLY window anchored on the subscription start, derived from the
 *     mirror dates (hint). See the annual note below.
 *
 * ── ALLOWANCES ARE MONTHLY EVEN WHEN BILLING IS ANNUAL ────────────────────────────
 * Product rule (裁决 #2 / PRD v3.2 §9.1): an annual subscriber pays once a year but
 * receives the SAME monthly allowances as a monthly subscriber, reset monthly, with
 * the month anchored on the subscription start. Billing cadence ≠ allowance cadence.
 *
 * The Creem hint for an annual plan is a TWELVE-MONTH window, so passing it through
 * verbatim (what this function used to do for every paid plan) would store a 12-month
 * usage period and reset the ledger once a year. Instead:
 *
 *   anchor := the subscription start (hint.currentPeriodStart), via
 *             paidPeriodFromMirror — which also owns every degraded-hint case
 *             (end-only → end−1mo; start-only; neither → now; end<=start → repair).
 *             That derived anchor is exactly the "existing period_anchor" fallback:
 *             for an EXISTING account the v56 RPC ignores everything we pass here and
 *             rolls from the STORED anchor, so no read of usage_accounts is needed (or
 *             wanted — it would add a roundtrip to every metered action and break the
 *             hermetic rpc-only test injections).
 *   period := monthlyWindowFrom(anchor, now), i.e. the v56 rule "smallest N with
 *             anchor + N months > now" → [anchor+(N−1)mo, anchor+N mo), clamped so it
 *             never ends after the subscription's current_period_end (the renewal
 *             webhook re-anchors from there).
 *
 * MONTHLY SUBSCRIPTIONS ARE BYTE-IDENTICAL to the previous behaviour: their hint
 * window IS anchor+1 month, so N=1 (or the stale-window repair) reproduces exactly
 * [start, end). test-usage-period-math asserts this against literals captured from the
 * pre-change implementation.
 *
 * The anchor is returned unchanged as periodAnchor, so the RPC's own monthly rollover
 * carries the cycle forward — including across the year-2 renewal, whose start lands on
 * the same monthly lattice (anchor + 12 months).
 */
export async function computePeriodForPlan(
  userId: string,
  plan: PlanKey,
  hint: PeriodHint,
  now: Date = new Date(),
): Promise<PeriodSpec> {
  if (plan === "free") {
    const signup = (await fetchSignupInstant(userId)) ?? now;
    return freePeriodForNow(signup, now);
  }

  const mirror = paidPeriodFromMirror(
    hint.currentPeriodStart ?? null,
    hint.currentPeriodEnd ?? null,
    now,
  );
  const anchorMs = mirror.periodAnchor.getTime();
  // Clamp only against a REAL subscription end. When the hint carried no usable end,
  // paidPeriodFromMirror synthesised one (start+1mo / now+1mo); clamping to a synthetic
  // end would freeze the window there forever instead of rolling monthly.
  const subEndMs = parseHintEnd(hint.currentPeriodEnd ?? null);
  const window = clampToSubscriptionEnd(
    monthlyWindowFrom(anchorMs, now.getTime()),
    subEndMs,
    anchorMs,
  );

  return {
    periodStart: window.start,
    periodEnd: window.end,
    periodAnchor: mirror.periodAnchor,
  };
}

/** Milliseconds of a parseable hint end, or NaN (→ clampToSubscriptionEnd no-ops). */
function parseHintEnd(endIso: string | null): number {
  if (!endIso) return Number.NaN;
  return new Date(endIso).getTime();
}

/**
 * Seed / roll / plan-change the user's usage account, idempotently.
 *
 * Resolves the plan (resolvePlan — billing source of truth, never user_metadata),
 * reads the plan's snapshot limits, computes the period, and calls the v56 RPC. Safe
 * to call repeatedly: the RPC no-ops inside a period and rolls exactly once per new
 * period. Returns the RPC's outcome, or throws on a genuine RPC error (a caller bug
 * or infra failure — never silently swallowed).
 *
 * `deps` is injectable for tests (the DB harness passes a fixed plan + its own
 * service client so the assertion targets the RPC, not resolvePlan's network path).
 */
export async function ensureUsageAccount(
  userId: string,
  opts: {
    plan?: PlanKey;
    hint?: PeriodHint;
    now?: Date;
    reviewRequired?: boolean;
    rpc?: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  } = {},
): Promise<EnsureAccountResult> {
  const now = opts.now ?? new Date();
  const plan = opts.plan ?? (await resolvePlan(userId));
  const limits = planToAccountLimits(plan);
  const period = await computePeriodForPlan(userId, plan, opts.hint ?? {}, now);

  const runRpc =
    opts.rpc ??
    (async (fn, args) => {
      const { data, error } = await createServerClient().rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    });

  const { data, error } = await runRpc("usage_ensure_account", {
    p_user_id: userId,
    p_plan_key: plan,
    p_ai_images_limit: limits.aiImagesLimit,
    p_ai_text_limit: limits.aiTextGenerationsLimit,
    p_scheduled_posts_limit: limits.scheduledPostsLimit,
    p_period_start: period.periodStart.toISOString(),
    p_period_end: period.periodEnd.toISOString(),
    p_period_anchor: period.periodAnchor.toISOString(),
    p_review_required: opts.reviewRequired ?? false,
  });

  if (error) {
    throw new Error(`usage_ensure_account failed for ${userId}: ${error.message}`);
  }
  const r = data as Record<string, unknown>;
  return {
    ok: r.ok === true,
    action: r.action as EnsureAccountResult["action"],
    accountId: String(r.account_id ?? ""),
    planKey: String(r.plan_key ?? plan),
    periodStart: String(r.period_start ?? period.periodStart.toISOString()),
    periodEnd: String(r.period_end ?? period.periodEnd.toISOString()),
    version: Number(r.version ?? 0),
    rolledPeriods: Number(r.rolled_periods ?? 0),
  };
}
