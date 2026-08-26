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
 *   - PAID: the mirror dates (hint), deriving a start from the end when only the end
 *     is present (see paidPeriodFromMirror).
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
  return paidPeriodFromMirror(
    hint.currentPeriodStart ?? null,
    hint.currentPeriodEnd ?? null,
    now,
  );
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
