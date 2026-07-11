export const EXISTING_APP_TOKEN_BALANCE = 34;

type UserLike = {
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
};

export type AccountBillingSummary = {
  planName: string | null;
  planStatus: string | null;
  renewalAt: string | null;
  tokenBalance: number;
  usedThisMonth: number | null;
  lastCreditActivityAt: string | null;
};

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Canonical VibePin plan display names, keyed by raw plan name / planKey. */
const CANONICAL_PLAN_NAMES: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
  // Legacy plan names stored before the 2026-07 pricing revamp
  // (Creator $19 → Starter, Growth $49 → Pro, Agency $99 → Business).
  creator: "Starter",
  growth: "Pro",
  agency: "Business",
};

/**
 * Map any stored plan name / planKey to a canonical Pricing-page label so
 * Settings and Pricing never disagree. Unknown values are title-cased; a missing
 * value defaults to the Free plan (the implicit plan for new accounts).
 */
export function normalizePlanName(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return "Free";
  const key = raw.trim().toLowerCase();
  return CANONICAL_PLAN_NAMES[key] ?? raw.trim().charAt(0).toUpperCase() + raw.trim().slice(1);
}

/** True when the resolved plan is a paid tier (anything other than Free). */
export function isPaidPlan(planName: string): boolean {
  return planName.trim().toLowerCase() !== "free";
}

export function deriveAccountBillingSummary(user: UserLike | null | undefined): AccountBillingSummary {
  const metadata = { ...(user?.app_metadata ?? {}), ...(user?.user_metadata ?? {}) };
  return {
    planName: firstString(metadata, ["plan_name", "planName", "plan"]),
    planStatus: firstString(metadata, ["subscription_status", "subscriptionStatus", "plan_status"]),
    renewalAt: firstString(metadata, ["renewal_at", "renewalAt", "current_period_end"]),
    tokenBalance: firstNumber(metadata, ["token_balance", "tokenBalance", "credits"]) ?? EXISTING_APP_TOKEN_BALANCE,
    usedThisMonth: firstNumber(metadata, ["tokens_used_this_month", "usedThisMonth", "monthly_usage"]),
    lastCreditActivityAt: firstString(metadata, ["last_credit_activity_at", "lastCreditActivityAt"]),
  };
}
