/**
 * Canonical PlanEntitlements — the ONE typed server-side source of truth for
 * every plan's allowances (task 1C-a).
 *
 * Everything that needs a per-plan allowance number derives from this file:
 *   - the pricing page DISPLAY strings (via the formatters below) so a change to
 *     an advertised number happens in exactly one place;
 *   - the Shopify enforcement limits (`entitlements.ts` reads `maxStores` /
 *     `maxSyncedProducts` FROM here — it keeps the `SHOPIFY_PRODUCT_LIMIT_*` env
 *     override + all enforcement logic; only the base numbers moved here).
 *
 * Number semantics (uniform across every allowance):
 *   - `null`            = unlimited (no cap)
 *   - `0`               = feature not offered on this plan
 *   - positive integer  = a per-period quota
 *
 * SCOPE GUARD (do not widen without a follow-up task):
 *   - `monthlyAiTextGenerations` lives here but is UNPUBLISHED — it must NOT
 *     appear in any user-visible pricing string (publishing is a later step 6A).
 *   - This file is display + Shopify-limit source only. It is deliberately NOT
 *     wired into any enforcement path, route, usage RPC, or metering.
 */

export type PlanKey = "free" | "starter" | "pro" | "business";

/**
 * A per-plan allowance value. See the module header for the `null` / `0` /
 * positive-integer semantics that hold for every field using this type.
 */
export type AllowanceValue = number | null;

export type PlanEntitlements = {
  planKey: PlanKey;
  displayName: string;
  /** free 0 < starter 1 < pro 2 < business 3 — the plan ordering. */
  rank: number;

  // ── AI creation (per calendar month) ──────────────────────────────────────
  monthlyAiImages: AllowanceValue;
  /** UNPUBLISHED — in the config, never rendered on the pricing page (step 6A). */
  monthlyAiTextGenerations: AllowanceValue;

  // ── Publishing (per calendar month) ───────────────────────────────────────
  monthlyScheduledPosts: AllowanceValue;

  // ── Connections ───────────────────────────────────────────────────────────
  connectedAccountsPerPlatform: AllowanceValue;

  // ── Shopify (folded in from entitlements.ts; enforcement stays there) ──────
  /** How many store connections the plan may hold (0 = cannot connect). */
  maxStores: number;
  /** Product sync cap per user (before the SHOPIFY_PRODUCT_LIMIT_* env override). */
  maxSyncedProducts: number;
};

/**
 * The v3.1 product contract. These are the ONLY place plan allowance numbers are
 * written; every consumer derives from this table.
 */
export const PLAN_ENTITLEMENTS: Record<PlanKey, PlanEntitlements> = {
  free: {
    planKey: "free",
    displayName: "Free",
    rank: 0,
    monthlyAiImages: 10,
    monthlyAiTextGenerations: 20,
    monthlyScheduledPosts: 5,
    connectedAccountsPerPlatform: 1,
    maxStores: 0,
    maxSyncedProducts: 0,
  },
  starter: {
    planKey: "starter",
    displayName: "Starter",
    rank: 1,
    monthlyAiImages: 150,
    monthlyAiTextGenerations: 500,
    monthlyScheduledPosts: 150,
    connectedAccountsPerPlatform: 1,
    maxStores: 1,
    maxSyncedProducts: 100,
  },
  pro: {
    planKey: "pro",
    displayName: "Pro",
    rank: 2,
    monthlyAiImages: 800,
    monthlyAiTextGenerations: 2000,
    monthlyScheduledPosts: 300,
    connectedAccountsPerPlatform: 2,
    maxStores: 2,
    maxSyncedProducts: 500,
  },
  business: {
    planKey: "business",
    displayName: "Business",
    rank: 3,
    monthlyAiImages: 3000,
    monthlyAiTextGenerations: 10000,
    monthlyScheduledPosts: null, // unlimited
    connectedAccountsPerPlatform: 3,
    maxStores: 3,
    maxSyncedProducts: 1000,
  },
};

/** Plans in display / rank order: Free → Starter → Pro → Business. */
export const PLAN_KEYS_IN_ORDER: readonly PlanKey[] = ["free", "starter", "pro", "business"];

/** Typed lookup: plan key → its canonical entitlements. */
export function getPlanEntitlements(plan: PlanKey): PlanEntitlements {
  return PLAN_ENTITLEMENTS[plan];
}

/** Read a single allowance for a plan. */
export function getAllowance<K extends keyof PlanEntitlements>(
  plan: PlanKey,
  key: K,
): PlanEntitlements[K] {
  return PLAN_ENTITLEMENTS[plan][key];
}

/** `true` when the allowance is unlimited (`null`). */
export function isUnlimited(value: AllowanceValue): boolean {
  return value === null;
}

// ── Display formatters (pricing page derives from these) ──────────────────────
//
// These produce the EXACT strings the /pricing comparison table renders today.
// They exist so an advertised number changes in this file only. They are
// intentionally the sole bridge from raw config numbers to user-visible text.

/** e.g. 3000 → "3,000" (thousands separator, matches the published table). */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A "<n> / month" allowance cell, or "Unlimited" for `null`. Matches the
 * published pricing comparison rows for AI image credits and scheduled posts.
 * `0` (feature not offered) is not used by any published row today, but is
 * rendered as "0 / month" for completeness.
 */
export function formatMonthlyAllowance(value: AllowanceValue): string {
  if (value === null) return "Unlimited";
  return `${formatCount(value)} / month`;
}

/** A bare per-plan integer cell (e.g. accounts per platform: "1"/"2"/"3"). */
export function formatPlainCount(value: AllowanceValue): string {
  if (value === null) return "Unlimited";
  return formatCount(value);
}

/**
 * The four-plan tuple (Free, Starter, Pro, Business) for one allowance field,
 * mapped through a formatter — this is exactly the shape a pricing comparison
 * row's `values` needs, so the row derives from the config with no duplicated
 * numbers.
 */
export function allowanceRowValues(
  key: keyof PlanEntitlements,
  format: (v: AllowanceValue) => string,
): [string, string, string, string] {
  return [
    format(PLAN_ENTITLEMENTS.free[key] as AllowanceValue),
    format(PLAN_ENTITLEMENTS.starter[key] as AllowanceValue),
    format(PLAN_ENTITLEMENTS.pro[key] as AllowanceValue),
    format(PLAN_ENTITLEMENTS.business[key] as AllowanceValue),
  ];
}
