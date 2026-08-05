/**
 * Pure builders + a stale-response guard for the drawer's recommendation flow.
 *
 * Extracted from AiVersionDrawer so the behaviour the review requires — a scratch
 * (draft-less) product still requests recommendations, the request carries the
 * CURRENT product's title/type/tags/analysis, and a late response for a previous
 * product is discarded — can be unit-tested without a DOM.
 */

import type { CanonicalProductSelection } from "@/lib/studio/productSelection";

export type ProductImageAnalysis = {
  category?: string;
  style?: string;
  colors?: string[];
  visibleObjects?: string[];
  imageSummary?: string;
};

export type ReferenceRequestBody = {
  category?: string;
  imageAnalysis?: ProductImageAnalysis;
  product?: { title: string; imageUrl?: string; type?: string; tags?: string[] };
  limit: number;
};

/** Honest tag list for a selection: its own tags, else its category/keyword/format. */
export function selectionTags(sel: CanonicalProductSelection | null): string[] {
  if (!sel) return [];
  if (sel.tags && sel.tags.length) return sel.tags.filter(Boolean);
  return [sel.category, sel.keyword, sel.visualFormat]
    .map(v => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
}

/**
 * Build the /api/reference-candidates request body for the current primary product.
 *
 * `draftAnalysis` is the draft's own stored analysis and applies ONLY when the
 * primary product IS the draft's image (draftImageSelected). Otherwise the
 * product's own freshly-fetched analysis (`productAnalysis`) is used — never the
 * previous product's. When neither is available the request omits imageAnalysis and
 * the API answers category_fallback, which the UI reports honestly.
 */
export function buildReferenceRequestBody(input: {
  primary: CanonicalProductSelection | null;
  draftImageSelected: boolean;
  draftAnalysis?: ProductImageAnalysis & { title?: string };
  productAnalysis?: ProductImageAnalysis;
  limit?: number;
}): ReferenceRequestBody {
  const { primary, draftImageSelected, draftAnalysis, productAnalysis } = input;
  const tags = selectionTags(primary);
  const title = draftImageSelected
    ? primary?.title?.trim() || draftAnalysis?.title?.trim() || ""
    : primary?.title?.trim() || "";

  const imageAnalysis = draftImageSelected
    ? (draftAnalysis
        ? {
            category: draftAnalysis.category,
            style: draftAnalysis.style,
            colors: draftAnalysis.colors,
            visibleObjects: draftAnalysis.visibleObjects,
            imageSummary: draftAnalysis.imageSummary,
          }
        : undefined)
    : (productAnalysis
        ? {
            category: productAnalysis.category || primary?.category,
            style: productAnalysis.style,
            colors: productAnalysis.colors,
            visibleObjects: productAnalysis.visibleObjects,
            imageSummary: productAnalysis.imageSummary,
          }
        : undefined);

  return {
    category: draftImageSelected
      ? (draftAnalysis?.category || primary?.category || undefined)
      : (productAnalysis?.category || primary?.category || undefined),
    imageAnalysis,
    product: (title || primary)
      ? {
          title,
          imageUrl: primary?.imageUrl || undefined,
          type: primary?.productType || undefined,
          tags: tags.length ? tags : undefined,
        }
      : undefined,
    limit: input.limit ?? 9,
  };
}

/**
 * Resolve a recommendation basis honestly.
 *
 * Only the two product-level bases pass through; anything else — an unknown value,
 * a missing field, an empty/failed response — collapses to category_fallback, which
 * the UI renders as "Category inspiration". This is what prevents a fabricated
 * "Recommended for this product" claim.
 */
export function resolveBasis(
  raw: string | undefined | null,
  itemCount?: number,
): "product_analysis" | "product_text" | "category_fallback" {
  // With no items there is no product-level result to justify the stronger claim,
  // so an empty list collapses to category_fallback regardless of what the field says.
  if (itemCount === 0) return "category_fallback";
  return raw === "product_analysis" || raw === "product_text" ? raw : "category_fallback";
}

/**
 * A minimal keyed guard for async results. A response is applied only when its key
 * still matches the current product key — the mechanism the drawer uses (via
 * AbortController + this check) so a late response for product A cannot overwrite
 * product B's recommendations / basis / analysis.
 */
export function isCurrentResult(resultKey: string, currentKey: string): boolean {
  return resultKey === currentKey;
}
