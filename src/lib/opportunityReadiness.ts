/**
 * opportunityReadiness.ts — mirrors backend/opportunity_readiness.py for API/UI.
 */

export type AvailabilityTier = "none" | "weak" | "testable" | "strong" | "deep";
export type ReadinessStatus =
  | "insight_only"
  | "needs_products"
  | "testable"
  | "launch_ready"
  | "strong_opportunity";

export type ReadinessPayload = {
  opportunityId?: string | null;
  keywordId?: string;
  category?: string | null;
  pinEvidenceCount: number;
  referenceEligibleCount: number;
  totalSaves: number;
  avgSaveVelocity?: number | null;
  trendScore: number;
  freshnessScore: number;
  linkedProductsCount: number;
  productsWithUrlCount: number;
  productsWithImageCount: number;
  productCategoryMatchCount: number;
  usableProductsCount?: number;
  effectiveProductCount?: number;
  productAvailabilityTier: AvailabilityTier;
  referenceAvailabilityTier: AvailabilityTier;
  readinessStatus: ReadinessStatus;
  readinessReasons: string[];
  save_percentile_in_category?: number | null;
  velocity_percentile_in_category?: number | null;
  category_rank?: number | null;
};

export type ReadinessProductInput = {
  source_url?: string | null;
  product_url?: string | null;
  image_url?: string | null;
  product_name?: string | null;
  title?: string | null;
  category?: string | null;
  seed_category?: string | null;
};

export function availabilityTier(count: number): AvailabilityTier {
  if (count <= 0) return "none";
  if (count <= 4) return "weak";
  if (count <= 14) return "testable";
  if (count <= 49) return "strong";
  return "deep";
}

export function countUsableProducts(
  products: ReadinessProductInput[],
  keywordCategory?: string | null,
): {
  linkedProductsCount: number;
  productsWithUrlCount: number;
  productsWithImageCount: number;
  productCategoryMatchCount: number;
  usableProductsCount: number;
} {
  let withUrl = 0;
  let withImage = 0;
  let categoryMatch = 0;
  let usable = 0;
  const kwCat = (keywordCategory ?? "").toLowerCase();

  for (const p of products) {
    const hasUrl = Boolean((p.source_url ?? p.product_url ?? "").trim());
    const hasImg = Boolean((p.image_url ?? "").trim());
    const hasTitle = Boolean((p.product_name ?? p.title ?? "").trim());
    const pCat = (p.category ?? p.seed_category ?? "").toLowerCase();
    if (hasUrl) withUrl += 1;
    if (hasImg) withImage += 1;
    if (kwCat && pCat && (pCat === kwCat || kwCat.includes(pCat) || pCat.includes(kwCat))) {
      categoryMatch += 1;
    }
    if (hasImg && hasTitle && (hasUrl || hasTitle)) usable += 1;
  }

  return {
    linkedProductsCount: products.length,
    productsWithUrlCount: withUrl,
    productsWithImageCount: withImage,
    productCategoryMatchCount: categoryMatch,
    usableProductsCount: usable,
  };
}

export function effectiveProductCount(counts: ReturnType<typeof countUsableProducts>): number {
  if (counts.usableProductsCount > 0) return counts.usableProductsCount;
  if (counts.productsWithImageCount > 0) return counts.productsWithImageCount;
  return counts.linkedProductsCount;
}

export function computeReadinessStatus(
  productTier: AvailabilityTier,
  referenceTier: AvailabilityTier,
  pinEvidenceCount: number,
  trendScore: number,
  rising: boolean,
): { status: ReadinessStatus; reasons: string[] } {
  const reasons: string[] = [];

  if (productTier === "none" || productTier === "weak") {
    if (rising && trendScore >= 50) {
      reasons.push("Strong trend signal but product supply is weak");
      return { status: "needs_products", reasons };
    }
    if (pinEvidenceCount >= 5) {
      reasons.push("Pin evidence exists but fewer than 5 usable products");
      return { status: "insight_only", reasons };
    }
    reasons.push("No or minimal product signals linked to this keyword");
    return { status: productTier === "weak" ? "needs_products" : "insight_only", reasons };
  }

  if (productTier === "testable") {
    if (pinEvidenceCount >= 3) {
      reasons.push("5–14 usable products with supporting pin evidence");
      return { status: "testable", reasons };
    }
    reasons.push("Product supply is testable but pin evidence is thin");
    return { status: "testable", reasons };
  }

  if ((productTier === "strong" || productTier === "deep") &&
      (referenceTier === "testable" || referenceTier === "strong" || referenceTier === "deep")) {
    if (productTier === "deep" && rising && pinEvidenceCount >= 10) {
      reasons.push("Deep product catalog, strong trend, and solid pin evidence");
      return { status: "strong_opportunity", reasons };
    }
    reasons.push("15+ products and 5+ reference-eligible pins");
    return { status: "launch_ready", reasons };
  }

  if (productTier === "strong" || productTier === "deep") {
    reasons.push("Strong product supply; reference pin depth still building");
    return { status: referenceTier !== "none" ? "launch_ready" : "testable", reasons };
  }

  reasons.push("Insufficient combined product and reference signals");
  return { status: "testable", reasons };
}

export function adjustPrimaryLabelForReadiness(
  baseLabel: "Best Bet" | "Steady" | "Competitive",
  readinessStatus: ReadinessStatus,
  productTier: AvailabilityTier,
): "Best Bet" | "Steady" | "Competitive" {
  if (baseLabel !== "Best Bet") return baseLabel;
  if (productTier === "none" || productTier === "weak") return "Steady";
  if (readinessStatus === "insight_only" || readinessStatus === "needs_products") return "Steady";
  if (readinessStatus === "testable") return "Steady";
  return baseLabel;
}

export function adjustTrendStateDisplay(
  baseTrendState: string,
  readinessStatus: ReadinessStatus,
  rising: boolean,
): string {
  if (readinessStatus === "insight_only" && rising) return "Insight Only";
  if (readinessStatus === "needs_products" && rising) return "Rising · Needs Products";
  return baseTrendState;
}

export function parseReadinessFromInternalCodes(raw: unknown): ReadinessPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const inner = obj.readiness;
  if (!inner || typeof inner !== "object") return null;
  return inner as ReadinessPayload;
}

export function buildReadinessFromEvidence(input: {
  keywordId?: string;
  category?: string | null;
  linkedProductsCount?: number | null;
  linkedPinsCount?: number | null;
  totalSourceSaves?: number | null;
  yearlyChange?: number | null;
  trendState?: string | null;
  products?: ReadinessProductInput[];
  referenceEligibleCount?: number | null;
}): ReadinessPayload {
  const products = input.products ?? [];
  const counts = countUsableProducts(products, input.category);
  const eff = effectiveProductCount(counts);
  const productTier = availabilityTier(eff);
  const refCount = input.referenceEligibleCount ?? 0;
  const referenceTier = availabilityTier(refCount);
  const pinEvidence = input.linkedPinsCount ?? 0;
  const trendScore = Math.min(Math.max(input.yearlyChange ?? 0, 0), 500) / 500 * 100;
  const rising = input.trendState === "Rising" || (input.yearlyChange ?? 0) >= 80;

  const { status, reasons } = computeReadinessStatus(
    productTier, referenceTier, pinEvidence, trendScore, rising,
  );

  return {
    keywordId: input.keywordId,
    category: input.category,
    pinEvidenceCount: pinEvidence,
    referenceEligibleCount: refCount,
    totalSaves: input.totalSourceSaves ?? 0,
    trendScore,
    freshnessScore: 0,
    linkedProductsCount: counts.linkedProductsCount,
    productsWithUrlCount: counts.productsWithUrlCount,
    productsWithImageCount: counts.productsWithImageCount,
    productCategoryMatchCount: counts.productCategoryMatchCount,
    usableProductsCount: counts.usableProductsCount,
    effectiveProductCount: eff,
    productAvailabilityTier: productTier,
    referenceAvailabilityTier: referenceTier,
    readinessStatus: status,
    readinessReasons: reasons,
  };
}
