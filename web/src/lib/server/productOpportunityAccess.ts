import { PLAN_ENTITLEMENTS, type PlanKey } from "./planEntitlements";

export const FREE_PRODUCT_OPPORTUNITY_LIMIT = 10;

export type ProductOpportunityAccessRow = {
  free_preview_rank: number | null;
  lifecycle_status: "discovered" | "active" | "inactive" | "retired";
};

export function productCatalogLimit(plan: PlanKey): number | null {
  return PLAN_ENTITLEMENTS[plan].maxProductOpportunities;
}

export function canAccessProductOpportunity(
  plan: PlanKey,
  row: ProductOpportunityAccessRow,
): boolean {
  if (row.lifecycle_status !== "active") return false;
  const limit = productCatalogLimit(plan);
  if (limit === null) return true;
  return row.free_preview_rank != null
    && row.free_preview_rank >= 1
    && row.free_preview_rank <= limit;
}

/**
 * A paid user may revisit the truthful read-only record of a product they saved
 * before it left the catalog. Free Saved Products cannot use history to bypass
 * the current curated-ten boundary.
 */
export function canAccessSavedProductHistory(
  plan: PlanKey,
  row: ProductOpportunityAccessRow,
): boolean {
  return row.lifecycle_status !== "active" && productCatalogLimit(plan) === null;
}

/** Stable server query filter. Free access is curated rank 1–10, not page order. */
export function productCatalogScope(plan: PlanKey): {
  limit: number | null;
  requiresFreePreviewRank: boolean;
} {
  const limit = productCatalogLimit(plan);
  return { limit, requiresFreePreviewRank: limit !== null };
}
