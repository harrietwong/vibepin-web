/**
 * Reverse map: Creem product id (prod_…) → VibePin { plan, interval }.
 *
 * Built at module load from the six CREEM_PRODUCT_* env vars (test-mode prod_ ids).
 * Server-only — these env vars carry no secret, but this module reads process.env
 * so it must never be imported into client code.
 *
 * A missing/unset env var is SKIPPED (not thrown) so a partial config degrades to
 * a null lookup rather than crashing the webhook at import; the caller logs the
 * miss and still mirrors the raw event.
 */

import type { PlanKey } from "@/lib/pricingPlans";

export type CreemProductMapping = {
  plan: PlanKey;
  interval: "month" | "year";
};

// (env var name → resolved plan/interval). Values are prod_… ids at runtime.
const ENV_TO_MAPPING: ReadonlyArray<
  readonly [envVar: string, plan: PlanKey, interval: "month" | "year"]
> = [
  ["CREEM_PRODUCT_STARTER_MONTHLY", "starter", "month"],
  ["CREEM_PRODUCT_STARTER_YEARLY", "starter", "year"],
  ["CREEM_PRODUCT_PRO_MONTHLY", "pro", "month"],
  ["CREEM_PRODUCT_PRO_YEARLY", "pro", "year"],
  ["CREEM_PRODUCT_BUSINESS_MONTHLY", "business", "month"],
  ["CREEM_PRODUCT_BUSINESS_YEARLY", "business", "year"],
];

/** productId → { plan, interval }. Built once at module load. */
const PRODUCT_MAP: ReadonlyMap<string, CreemProductMapping> = (() => {
  const map = new Map<string, CreemProductMapping>();
  for (const [envVar, plan, interval] of ENV_TO_MAPPING) {
    const productId = (process.env[envVar] ?? "").trim();
    if (!productId) continue; // unset → skip; lookup for it will simply be null
    map.set(productId, { plan, interval });
  }
  return map;
})();

/**
 * Resolve a Creem product id to its VibePin plan + billing interval, or null when
 * the id is unknown (unmapped product, or its env var is unset).
 */
export function resolveCreemProduct(
  productId: string | null | undefined,
): CreemProductMapping | null {
  if (!productId) return null;
  return PRODUCT_MAP.get(productId) ?? null;
}

/** Convenience: just the plan key for a Creem product id, or null. */
export function planKeyForCreemProduct(
  productId: string | null | undefined,
): PlanKey | null {
  return resolveCreemProduct(productId)?.plan ?? null;
}
