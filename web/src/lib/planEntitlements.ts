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
 *   - insightsDiagnosis:      NOT a number and NOT from the pricing table — a
 *                             capability decided for the Insights diagnosis
 *                             (2026-08-28): free false, Starter and above true.
 *                             It is written here rather than inferred from a plan
 *                             rank so that "is this user entitled to a diagnosis"
 *                             has exactly one answer, in the file every other
 *                             entitlement answer comes from. pricingPlans.ts is
 *                             deliberately NOT touched: every COMPARISON_SECTIONS
 *                             row today is a "<n> / month" allowance cell, and a
 *                             yes/no capability row would need a second cell shape
 *                             plus marketing copy for a feature whose page has not
 *                             shipped. Advertising is a separate decision from
 *                             entitlement, and the consistency test only pairs the
 *                             numeric rows, so the two files stay in agreement.
 *
 * A `null` limit means "no cap / undefined" — checkAllowance treats it as always
 * allowed. `accountsPerPlatform` IS enforced (Phase D): the Pinterest connect start
 * and OAuth callback both refuse to add an account past it — see
 * lib/server/pinterest/accountQuota.ts. `connectedPlatforms` remains data only.
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
  /**
   * Accounts/Pages per platform. ENFORCED for Pinterest (Phase D) via
   * lib/server/pinterest/accountQuota.ts; null = uncapped.
   */
  accountsPerPlatform: number | null;
  /**
   * May this plan receive the Insights DIAGNOSIS — headline, findings,
   * recommendations, evidence, weekly reports and scorecards?
   *
   * A boolean, not a quota: the thing being withheld is a reading of the account,
   * and half a reading is not a smaller reading, it is a wrong one. ENFORCED
   * server-side in lib/insights/paidGate.ts + the /api/insights routes; the free
   * payload carries no diagnosis fields at all rather than fields the client is
   * asked not to render.
   *
   * What is NOT gated: collection. A free user's Pins keep being collected every
   * night, so the day they upgrade they get a diagnosis with history behind it
   * instead of an empty page and a 30-day wait — the metrics themselves are also
   * still returned, because those are the user's own numbers.
   */
  insightsDiagnosis: boolean;
};

export const PLAN_ENTITLEMENTS: Record<PlanKey, PlanEntitlements> = {
  free: {
    monthlyAiImages: 10,
    monthlyScheduledPosts: 5,
    monthlyAiTextGenerations: null,
    connectedPlatforms: 1,
    accountsPerPlatform: 1,
    insightsDiagnosis: false,
  },
  starter: {
    monthlyAiImages: 150,
    monthlyScheduledPosts: 150,
    monthlyAiTextGenerations: null,
    connectedPlatforms: 4,
    accountsPerPlatform: 1,
    insightsDiagnosis: true,
  },
  pro: {
    monthlyAiImages: 800,
    monthlyScheduledPosts: 300,
    monthlyAiTextGenerations: null,
    connectedPlatforms: 4,
    accountsPerPlatform: 2,
    insightsDiagnosis: true,
  },
  business: {
    monthlyAiImages: 3000,
    monthlyScheduledPosts: null, // Unlimited on the pricing page
    monthlyAiTextGenerations: null,
    connectedPlatforms: 4,
    accountsPerPlatform: 3,
    insightsDiagnosis: true,
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
