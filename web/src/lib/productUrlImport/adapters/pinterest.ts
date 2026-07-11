import { extractCandidatesFromHtml } from "../extractFromHtml";
import type { AdapterResult } from "../types";

/**
 * Returned when Pinterest blocks the fetch (common).
 * Imports from Pinterest always produce reference assets, not product assets.
 */
export const PINTEREST_BLOCKED_RESULT: Omit<AdapterResult, "candidates"> = {
  status:          "blocked",
  message:         "Pinterest blocks automatic extraction. Connect Pinterest later, upload an image, or paste a direct image URL.",
  fallbackActions: ["upload_image", "paste_direct_image_url"],
  debugCode:       "pinterest_blocked",
};

/**
 * Run when Pinterest HTML is accessible (e.g., public metadata).
 * Only returns og:image / twitter:image — never raw HTML gallery images.
 */
export function pinterestAdapter(html: string, pageUrl: string): AdapterResult {
  const { title, candidates } = extractCandidatesFromHtml(html, pageUrl);
  const filtered = candidates.filter(c =>
    c.reason === "og_image" || c.reason === "twitter_image" || c.reason === "jsonld_product_image",
  );
  return {
    status:     filtered.length ? "success" : "failed",
    title,
    candidates: filtered,
  };
}
