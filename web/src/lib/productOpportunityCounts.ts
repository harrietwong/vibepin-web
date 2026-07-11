// Pure, framework-free helpers for the Product Opportunity Finder count/label
// clarity. Extracted so the "summary total vs filtered grid count" semantics are
// unit-testable without rendering the page.
//
// Root-cause context: the Physical/Digital summary cards show the TOTAL count for
// the selected product class (unfiltered by category/source/price/etc.), while the
// grid shows the FILTERED count. Both come from the same client-side product list.
// These helpers make that difference explicit in the UI copy.

export type ProductOppClass = "physical" | "digital";

// ── Digital classification: CONSERVATIVE, evidence-based, single source of truth ──
//
// A product is Digital ONLY when its title carries explicit digital / intangible /
// downloadable evidence. Everything else — Amazon and physical goods, and anything
// merely ambiguous — is Physical by default.
//
// Why we DO NOT trust product_type / product_subtype: those fields are derived by
// assetClassification.classifyDestination(), which over-assigns
// product_type="digital_product" and digital subtypes from weak tokens ("planner",
// "app", "tool", "template", stray "download") appearing anywhere in the derived
// text. In production ~59% of rows (1608/2739) arrive tagged digital_product —
// including furniture (End Table), wall decor, bags and press-on nails. So the title
// is the only reliable signal for the Physical/Digital split.
//
// The whole taxonomy lives here (ONE regex) so the summary-card class totals and the
// grid's class filter can never drift, and no duplicate set exists on the page.
export const DIGITAL_EVIDENCE_RE =
  /\b(printable|downloadable|instant\s+downloads?|digital\s+downloads?|\bdownloads?\b|templates?|canva|notion|\bsvgs?\b|\bpng\b|\bpdf\b|\beps\b|\bdxf\b|clip\s?art|cut\s+files?|cricut|silhouette|\bfonts?\b|presets?|lightroom|\bebooks?\b|e-book|\bkindle\b|audiobook|\bcourse\b|masterclass|online\s+class|digital\s+(?:planner|paper|papers|art|print|pattern|sticker|stamp|kit|bundle|code|product|file|files)|digital\s+code|license\s+key|redeem\s+code|\bsoftware\b|worksheets?|spreadsheet)\b/i;

export interface DigitalClassifyInput {
  /** product_name / title — the primary and ONLY trusted signal. */
  name?: string | null;
  /** Upstream-derived fields (kept for API compatibility; NOT trusted, see above). */
  productType?: string | null;
  productSubtype?: string | null;
  /** Marketplace hint. Amazon items still require explicit digital title evidence. */
  isAmazon?: boolean;
}

export function isDigitalProductType(input: DigitalClassifyInput): boolean {
  // Digital only with explicit textual evidence in the title. Amazon / physical /
  // ambiguous items (no such evidence) fall through to Physical — the safe default.
  return DIGITAL_EVIDENCE_RE.test(input.name ?? "");
}

export function classNoun(productClass: ProductOppClass, count: number): string {
  return `${productClass} product${count === 1 ? "" : "s"}`;
}

export interface ResultsSummary {
  /** Total for the selected class — matches the summary card number. */
  classTotal: number;
  /** Count after all active filters (across all pages). */
  filteredCount: number;
  /** True when active filters reduced results below the class total. */
  reduced: boolean;
  /** e.g. "Showing 1 of 168 digital products" */
  line: string;
}

export function buildResultsSummary(
  productClass: ProductOppClass,
  filteredCount: number,
  classTotal: number,
): ResultsSummary {
  // classTotal is the class summary-card number; never render a "of N" smaller
  // than what actually matched (guards against transient count skew).
  const total = Math.max(classTotal, filteredCount);
  const line = `Showing ${filteredCount.toLocaleString()} of ${total.toLocaleString()} ${productClass} products`;
  return { classTotal: total, filteredCount, reduced: filteredCount < total, line };
}

/** Short human summary of active filters, e.g. "Category: Women's Fashion, Source: Amazon". */
export function summarizeActiveFilters(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(", ");
}

/**
 * Helper text for the reduced/low-result state, e.g.
 *   "Only 1 digital product matches Category: Women's Fashion."
 *   "Showing 12 of 168 digital products match your current filters."
 * `filterSummary` is the summarizeActiveFilters() output (may be empty).
 */
export function reducedResultsMessage(
  productClass: ProductOppClass,
  filteredCount: number,
  classTotal: number,
  filterSummary: string,
): string {
  const noun = classNoun(productClass, filteredCount);
  const verb = filteredCount === 1 ? "matches" : "match";
  if (filteredCount === 0) {
    return filterSummary
      ? `No ${productClass} products match ${filterSummary}.`
      : `No ${productClass} products match your current filters.`;
  }
  // Emphasise the "only a few of many" case (the 168 → 1 confusion).
  if (filteredCount <= 5 && classTotal > filteredCount) {
    return filterSummary
      ? `Only ${filteredCount.toLocaleString()} ${noun} ${verb} ${filterSummary}.`
      : `Only ${filteredCount.toLocaleString()} ${noun} ${verb} your current filters.`;
  }
  return `${filteredCount.toLocaleString()} of ${classTotal.toLocaleString()} ${productClass} products ${verb} your current filters.`;
}

// ── Product Opportunity Pinterest save-count precedence ───────────────────────
//
// A Product Opportunity card should headline REAL Pinterest demand. For Shop-the-
// Look products that demand lives on a Pinterest Pin (the product's own product Pin,
// or the "Shop the look" source Pin it was found in) — NOT on Amazon reviews, price
// or the opportunity score. The card historically read the raw source_pin_save_count
// field and rendered null as "—", ignoring the richer per-row metrics the API already
// computes and never preferring a genuine product-Pin save.
//
// This helper picks the best available Pinterest save signal, conservatively:
//   A. the product's OWN Pinterest product-Pin saves (product_pin_id present)
//   B. else the associated source ("Shop the look") Pin saves
//   C/D. else the best product-Pin save across the same normalized product URL group
//   E. else unknown → null → the card shows "—"
//
// Rules: never fabricate; never use score / price / rating / reviews; UNKNOWN stays
// null (never coerced to 0); a real MEASURED 0 is preserved and shown as "0".

export type ProductSaveCountSource =
  | "product"                       // the product's own Pinterest product-Pin saves
  | "source_pin"                    // the associated Shop-the-Look source-Pin saves
  | "stl_product_pin"               // a stored STL product-image Pin metric (alias of product)
  | "normalized_product_url_group"  // best product-Pin save across the same product URL
  | "unknown";                      // no Pinterest save data → render "—"

export interface ProductSaveCountResult {
  /** null = unknown (render "—"); 0 only when a real measured 0; otherwise the count. */
  value: number | null;
  source: ProductSaveCountSource;
}

export interface ProductSaveCountInput {
  save_count?: number | null;
  source_pin_save_count?: number | null;
  target_product_pin_save_count?: number | null;
  product_pin_id?: string | null;
  target_product_pin_id?: string | null;
  trend_score?: number | null;
  save_velocity_score?: number | null;
  scraped_at?: string | null;
  created_at?: string | null;
  opportunity_score?: number | null;
  amazon_review_count?: number | null;
  review_count?: number | null;
  rating_count?: number | null;
  product_metrics?: {
    productPinSaveCount?: number | null;
    sourcePinSaveCount?: number | null;
    productSourcePinCount?: number | null;
    uniqueProductPinCount?: number | null;
    aggregateProductPinSaves?: number | null;
  } | null;
}

export function deriveProductSaveCount(p: ProductSaveCountInput): ProductSaveCountResult {
  const m = p.product_metrics ?? null;

  // A/C: the product's OWN Pinterest product-Pin saves. productPinSaveCount is null
  // unless the row is itself a product Pin; fall back to save_count only when
  // product_pin_id confirms save_count is a genuine product-Pin metric (never for
  // bootstrap rows whose save_count is a default 0).
  const productPin =
    m?.productPinSaveCount != null
      ? m.productPinSaveCount
      : p.product_pin_id != null
        ? p.save_count ?? null
        : null;
  const stlProductPin =
    p.target_product_pin_save_count != null && p.target_product_pin_id
      ? p.target_product_pin_save_count
      : null;
  // B: the associated Shop-the-Look SOURCE-Pin saves (null-preserving, unlike the
  // API's metrics object which coerces this to 0).
  const sourcePin = p.source_pin_save_count ?? null;
  // D: best product-Pin save across pins sharing the normalized product URL.
  const groupAgg = m?.aggregateProductPinSaves ?? null;

  // Prefer the first POSITIVE real Pinterest demand signal, in precedence order.
  if (productPin != null && productPin > 0) return { value: productPin, source: "product" };
  if (sourcePin != null && sourcePin > 0) return { value: sourcePin, source: "source_pin" };
  if (stlProductPin != null && stlProductPin > 0) return { value: stlProductPin, source: "stl_product_pin" };
  if (groupAgg != null && groupAgg > 0) return { value: groupAgg, source: "normalized_product_url_group" };

  // No positive signal: show an explicit MEASURED 0 (a candidate that is exactly 0,
  // not null/unknown). Unknown stays null → the card renders "—".
  if (productPin === 0) return { value: 0, source: "product" };
  if (sourcePin === 0) return { value: 0, source: "source_pin" };
  if (stlProductPin === 0) return { value: 0, source: "stl_product_pin" };
  if (groupAgg === 0) return { value: 0, source: "normalized_product_url_group" };
  return { value: null, source: "unknown" };
}

export type DemandLabel = "high" | "medium" | "low" | "unknown";
export type DemandTrend = "rising" | "stable" | "declining" | "unknown";
export type TrendSource = "pin_trend" | "keyword_trend" | "velocity" | "unknown";
export type CompetitionLabel = "low" | "medium" | "high" | "unknown";
export type CompetitionConfidence = "high" | "medium" | "low";
export type CompetitionSource = "internal_cluster" | "product_family" | "pin_cluster" | "url_group" | "title_cluster" | "unknown";

export interface ProductDemand {
  label: DemandLabel;
  saveCount: number | null;
  /** @deprecated Use ProductOpportunityPublicMetrics.trend. Kept for compatibility. */
  trend: DemandTrend;
  source: ProductSaveCountSource;
  percentile: number | null;
}

export interface ProductTrend {
  label: DemandTrend;
  growthPercent: number | null;
  source: TrendSource;
}

export interface ProductCompetition {
  label: CompetitionLabel;
  confidence: CompetitionConfidence;
  source: CompetitionSource;
}

// No unified opportunity label/score: the product direction (v2.0 final) shows
// Demand / Trend / Competition with plain-language explanations and lets the
// user judge — never a synthesized conclusion.
export interface ProductOpportunityPublicMetrics {
  demand: ProductDemand;
  trend: ProductTrend;
  competition: ProductCompetition;
}

type DemandThresholds = {
  enoughData: boolean;
  lowCutoff: number;
  highCutoff: number;
  sortedValid: number[];
};

function percentileValue(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export function buildDemandThresholds(products: ProductSaveCountInput[]): DemandThresholds {
  const sortedValid = products
    .map(p => deriveProductSaveCount(p).value)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  if (sortedValid.length >= 8) {
    return {
      enoughData: true,
      lowCutoff: percentileValue(sortedValid, 0.25),
      highCutoff: percentileValue(sortedValid, 0.75),
      sortedValid,
    };
  }
  // Temporary bootstrap thresholds for sparse result sets; conservative and
  // Pinterest-only. 0 is still a real measured value, null remains unknown.
  return { enoughData: false, lowCutoff: 1_000, highCutoff: 10_000, sortedValid };
}

function demandPercentile(value: number | null, sortedValid: number[]): number | null {
  if (value == null || sortedValid.length === 0) return null;
  const belowOrEqual = sortedValid.filter(v => v <= value).length;
  return Math.round((belowOrEqual / sortedValid.length) * 100);
}

function demandLabel(saveCount: number | null, thresholds: DemandThresholds): DemandLabel {
  if (saveCount == null) return "unknown";
  if (thresholds.enoughData) {
    if (saveCount >= thresholds.highCutoff) return "high";
    if (saveCount <= thresholds.lowCutoff) return "low";
    return "medium";
  }
  if (saveCount >= thresholds.highCutoff) return "high";
  if (saveCount < thresholds.lowCutoff) return "low";
  return "medium";
}

export function deriveProductTrend(p: Pick<ProductSaveCountInput, "trend_score" | "save_velocity_score"> & { yearly_change?: number | null; pct_growth_yoy?: number | null }): ProductTrend {
  const explicitGrowth = p.pct_growth_yoy ?? p.yearly_change ?? null;
  if (typeof explicitGrowth === "number" && Number.isFinite(explicitGrowth)) {
    return {
      label: explicitGrowth > 10 ? "rising" : explicitGrowth < -10 ? "declining" : "stable",
      growthPercent: explicitGrowth,
      source: "keyword_trend",
    };
  }
  const trendScore = p.trend_score ?? p.save_velocity_score ?? null;
  if (trendScore == null) return { label: "unknown", growthPercent: null, source: "unknown" };
  return {
    label: trendScore >= 60 ? "rising" : trendScore <= 30 ? "declining" : "stable",
    growthPercent: null,
    source: p.trend_score != null ? "pin_trend" : "velocity",
  };
}

export function deriveDemandTrend(p: Pick<ProductSaveCountInput, "trend_score" | "save_velocity_score">): DemandTrend {
  return deriveProductTrend(p).label;
}

export function deriveProductDemand(p: ProductSaveCountInput, thresholds: DemandThresholds): ProductDemand {
  const save = deriveProductSaveCount(p);
  const trend = deriveProductTrend(p);
  return {
    label: demandLabel(save.value, thresholds),
    saveCount: save.value,
    trend: trend.label,
    source: save.source,
    percentile: demandPercentile(save.value, thresholds.sortedValid),
  };
}

function isFreshEnoughForCompetition(p: ProductSaveCountInput): boolean {
  const iso = p.scraped_at ?? p.created_at ?? null;
  if (!iso) return true;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return false;
  return Date.now() - time <= 30 * 24 * 3_600_000;
}

export function deriveProductCompetition(p: ProductSaveCountInput): ProductCompetition {
  const m = p.product_metrics ?? null;
  const similarPinCount = m?.productSourcePinCount ?? null;
  const similarProductFamilyCount = m?.uniqueProductPinCount ?? null;
  const normalizedProductUrlGroupCount =
    similarPinCount != null || similarProductFamilyCount != null
      ? (similarPinCount ?? 0) + (similarProductFamilyCount ?? 0)
      : null;
  const signalFamilies = [
    similarPinCount != null ? "pin_cluster" : null,
    similarProductFamilyCount != null ? "product_family" : null,
    normalizedProductUrlGroupCount != null ? "url_group" : null,
  ].filter(Boolean);
  const hasEnoughSignals = signalFamilies.length >= 2;
  const hasEnoughCoverage = (similarPinCount ?? 0) + (similarProductFamilyCount ?? 0) >= 3;

  if (!hasEnoughSignals || !hasEnoughCoverage || !isFreshEnoughForCompetition(p)) {
    return { label: "unknown", confidence: "low", source: "unknown" };
  }

  const source: CompetitionSource =
    similarPinCount != null && similarProductFamilyCount != null
      ? "internal_cluster"
      : similarPinCount != null
        ? "pin_cluster"
        : similarProductFamilyCount != null
          ? "product_family"
          : "url_group";

  if ((similarPinCount ?? 0) > 25 || (similarProductFamilyCount ?? 0) > 12) {
    return { label: "high", confidence: "high", source };
  }
  if ((similarPinCount ?? 0) >= 9 || (similarProductFamilyCount ?? 0) >= 5) {
    return { label: "medium", confidence: "medium", source };
  }
  return { label: "low", confidence: "medium", source };
}

export function deriveProductOpportunityPublicMetrics(
  p: ProductSaveCountInput,
  thresholds: DemandThresholds,
): ProductOpportunityPublicMetrics {
  return {
    demand: deriveProductDemand(p, thresholds),
    trend: deriveProductTrend(p),
    competition: deriveProductCompetition(p),
  };
}

// ── Plain-language explanations for the three public metrics ──────────────────
// Every badge must answer "where does this come from" in one sentence the user
// can read. Unknown always says "Not enough data" — never a forced conclusion.

export function demandExplanation(demand: ProductDemand): string {
  switch (demand.label) {
    case "high":
      return demand.percentile != null
        ? `Saves are in the top of similar products (${demand.percentile}th percentile).`
        : "Saves are among the highest of similar products.";
    case "medium":
      return "Saves are around the middle of similar products.";
    case "low":
      return "Saves are below most similar products.";
    default:
      return "Not enough data — no Pinterest save signal yet.";
  }
}

export function trendExplanation(trend: ProductTrend): string {
  const via =
    trend.source === "keyword_trend" ? "its related keyword" :
    trend.source === "pin_trend" ? "its Pin activity" :
    trend.source === "velocity" ? "recent save activity" : "";
  switch (trend.label) {
    case "rising":
      return trend.growthPercent != null
        ? `Related keyword searches are rising (${trend.growthPercent > 0 ? "+" : ""}${Math.round(trend.growthPercent)}% year over year).`
        : `Interest is rising based on ${via}.`;
    case "declining":
      return trend.growthPercent != null
        ? `Related keyword searches are declining (${Math.round(trend.growthPercent)}% year over year).`
        : `Interest is declining based on ${via}.`;
    case "stable":
      return `Interest is steady based on ${via}.`;
    default:
      return "Not enough data — no trend signal yet.";
  }
}

export function competitionExplanation(competition: ProductCompetition): string {
  switch (competition.label) {
    case "low":
      return "Few similar products found so far.";
    case "medium":
      return "Some similar products found.";
    case "high":
      return "Many similar products found — this space is crowded.";
    default:
      return "Not enough data — too few similar products tracked to judge.";
  }
}
