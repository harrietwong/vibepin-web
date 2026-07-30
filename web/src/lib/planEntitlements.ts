/**
 * planEntitlements — the SINGLE source of truth for the three metered monthly
 * quotas and the (data-only) account limits per plan.
 *
 * Pure data, no secrets, no imports beyond the PlanKey type — safe to import from
 * anywhere (server metering + tests). This is the ONLY place the quota numbers
 * live; server usage checks read from here so display (pricingPlans.ts) and
 * enforcement never drift. A consistency test
 * (scripts/test-plan-entitlements.ts) asserts these numbers match the
 * COMPARISON_SECTIONS display values in pricingPlans.ts.
 *
 * Number provenance (all from pricingPlans.ts COMPARISON_SECTIONS / bullets — no
 * invented values):
 *   - monthlyAiImages:        AI image credits — Free 10, Starter 150, Pro 800, Business 3000
 *   - monthlyScheduledPosts:  Scheduled posts  — Free 5, Starter 150, Pro 300, Business Unlimited (null)
 *   - monthlyAiTextGenerations: NO plan ever defined a number → null everywhere
 *                              (metered for analytics, never enforced this round).
 *   - connectedPlatforms:     Connected platforms — 1 / 4 / 4 / 4
 *   - accountsPerPlatform:    Accounts per platform — 1 / 1 / 2 / 3
 *
 * A `null` limit means "no cap / undefined" — checkAllowance treats it as always
 * allowed. connectedPlatforms / accountsPerPlatform are DATA ONLY this round (not
 * enforced anywhere yet).
 */

import type { PlanKey } from "./pricingPlans";

export type PlanEntitlements = {
  /** AI image generations per UTC calendar month (null = uncapped). */
  monthlyAiImages: number | null;
  /** Scheduled posts per UTC calendar month (null = unlimited, e.g. Business). */
  monthlyScheduledPosts: number | null;
  /** AI text (copy) generations per month — always null: metered, never limited. */
  monthlyAiTextGenerations: number | null;
  /** How many platforms may be connected (data only — not enforced this round). */
  connectedPlatforms: number | null;
  /** Accounts/Pages per platform (data only — not enforced this round). */
  accountsPerPlatform: number | null;
};

export const PLAN_ENTITLEMENTS: Record<PlanKey, PlanEntitlements> = {
  free: {
    monthlyAiImages: 10,
    monthlyScheduledPosts: 5,
    monthlyAiTextGenerations: null,
    connectedPlatforms: 1,
    accountsPerPlatform: 1,
  },
  starter: {
    monthlyAiImages: 150,
    monthlyScheduledPosts: 150,
    monthlyAiTextGenerations: null,
    connectedPlatforms: 4,
    accountsPerPlatform: 1,
  },
  pro: {
    monthlyAiImages: 800,
    monthlyScheduledPosts: 300,
    monthlyAiTextGenerations: null,
    connectedPlatforms: 4,
    accountsPerPlatform: 2,
  },
  business: {
    monthlyAiImages: 3000,
    monthlyScheduledPosts: null, // Unlimited on the pricing page
    monthlyAiTextGenerations: null,
    connectedPlatforms: 4,
    accountsPerPlatform: 3,
  },
};

/** The three metered usage types (aligned with usage_events.usage_type). */
export type MeteredUsageType = "ai_image" | "ai_text_generation" | "scheduled_post";

/** Map a metered usage type to its per-plan monthly limit field. */
export function limitForUsageType(
  plan: PlanKey,
  usageType: MeteredUsageType,
): number | null {
  const ent = PLAN_ENTITLEMENTS[plan];
  switch (usageType) {
    case "ai_image":
      return ent.monthlyAiImages;
    case "ai_text_generation":
      return ent.monthlyAiTextGenerations;
    case "scheduled_post":
      return ent.monthlyScheduledPosts;
  }
}
