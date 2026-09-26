/**
 * Pure view-model for Settings → Billing (plan summary card + per-quota meters).
 *
 * WHY THIS EXISTS: the plan card and the usage meters used to read two different
 * plan resolutions (Creem-subscription-only vs resolvePlan with the internal
 * whitelist floor), so an internal account saw "Free · 10 images" next to
 * "800 included". Everything the Billing tab shows about allowances now derives
 * from ONE GET /api/billing/usage payload through planSummaryView, so the two
 * cards cannot disagree.
 *
 * Deliberately dependency-free (no server modules — entitlements.ts builds a
 * Supabase client at import time) so it can be unit-tested directly.
 *
 * Number semantics follow the API: `limit`/`included` null = unlimited; `used`
 * null = no usage_accounts row yet.
 */

export type UsageBucketInput = {
  used: number | null;
  limit: number | null;
  included: number | null;
};

export type UsageStateInput = "metered" | "unmetered";

/** normal / warning (≥80%) / danger (cap reached) for capped quotas; unlimited when there is no cap. */
export type BucketTone = "normal" | "warning" | "danger" | "unlimited";

export type BucketView = {
  /** True only when the ledger row actually exists (state === "metered"). */
  measured: boolean;
  /** Settled ledger usage. A user with no ledger row yet has used 0 (product decision 2026-09-26). */
  used: number;
  /** The cap in force: the account's period snapshot when metered, else the plan's included amount. null = unlimited. */
  limit: number | null;
  /** limit - used, floored at 0. null when unlimited. */
  remaining: number | null;
  /** 0..100 for the bar width. 0 when unlimited. */
  pct: number;
  tone: BucketTone;
};

/** ≥ this share of the cap → warning colour. */
export const USAGE_WARNING_RATIO = 0.8;

function nonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

/** Colour tone for a capped quota. Uses the raw ratio (not the rounded pct). */
export function toneFor(used: number, limit: number): Exclude<BucketTone, "unlimited"> {
  // A 0 cap means "not included in this plan" — nothing is available.
  if (limit <= 0) return "danger";
  if (used >= limit) return "danger";
  if (used / limit >= USAGE_WARNING_RATIO) return "warning";
  return "normal";
}

/**
 * The limit a bucket is held to right now — the SAME number the meter shows and
 * the plan card describes:
 *   - metered   → the account's period snapshot (`limit`), which the ledger enforces;
 *   - unmetered → the plan's included allowance (`included`).
 */
export function effectiveLimit(bucket: UsageBucketInput, state: UsageStateInput): number | null {
  return state === "metered" ? bucket.limit : bucket.included;
}

/**
 * One quota row. `used` comes only from the ledger (usage_accounts `*_used`).
 * With no account row the ledger has recorded nothing for this user → 0 used;
 * the UI adds a "No usage recorded yet this period" footnote in that state.
 */
export function bucketView(bucket: UsageBucketInput, state: UsageStateInput): BucketView {
  const limitRaw = effectiveLimit(bucket, state);
  const measuredUsed = state === "metered" ? nonNegative(bucket.used) : null;
  const measured = measuredUsed !== null;
  const used = measuredUsed ?? 0;

  if (limitRaw === null) {
    return { measured, used, limit: null, remaining: null, pct: 0, tone: "unlimited" };
  }
  const limit = nonNegative(limitRaw) ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return {
    measured,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    pct,
    tone: toneFor(used, limit),
  };
}

export type BillingUsageInput = {
  plan: string;
  planSource?: string | null;
  connectedAccountsPerPlatform?: number | null;
  state: UsageStateInput;
  aiImages: UsageBucketInput;
  aiTextGenerations: UsageBucketInput;
  scheduledPosts: UsageBucketInput;
};

export type PlanSummaryView = {
  /** Canonical plan key the quotas are computed for (resolvePlan). */
  planKey: string;
  /** True when the plan comes from the internal-account whitelist floor, not a subscription. */
  internal: boolean;
  connectedAccountsPerPlatform: number | null;
  images: BucketView;
  text: BucketView;
  posts: BucketView;
};

/**
 * The plan summary card and the usage meters BOTH read this. The plan's
 * description numbers are the meters' `limit`s — same objects, so they cannot drift.
 */
export function planSummaryView(usage: BillingUsageInput): PlanSummaryView {
  return {
    planKey: usage.plan,
    internal: usage.planSource === "whitelist",
    connectedAccountsPerPlatform:
      typeof usage.connectedAccountsPerPlatform === "number" ? usage.connectedAccountsPerPlatform : null,
    images: bucketView(usage.aiImages, usage.state),
    text: bucketView(usage.aiTextGenerations, usage.state),
    posts: bucketView(usage.scheduledPosts, usage.state),
  };
}
