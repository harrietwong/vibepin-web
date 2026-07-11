import { extractCandidatesFromHtml } from "../extractFromHtml";
import type { AdapterResult } from "../types";

/**
 * Returned when Etsy blocks the fetch (HTTP 403 / timeout / any network error).
 * Never show raw "HTTP 403" to the user — always surface this instead.
 */
export const ETSY_BLOCKED_RESULT: Omit<AdapterResult, "candidates"> = {
  status:          "blocked",
  message:         "Etsy blocks automatic image extraction. Upload an image directly, paste a direct image URL, or connect Etsy API.",
  fallbackActions: ["upload_image", "paste_direct_image_url", "connect_etsy_api"],
  debugCode:       "etsy_http_403",
};

/** Run when Etsy HTML is successfully fetched (rare). */
export function etsyAdapter(html: string, pageUrl: string): AdapterResult {
  const { title, description, candidates } = extractCandidatesFromHtml(html, pageUrl, { etsy: true });
  return {
    status: candidates.length ? "success" : "failed",
    title,
    description,
    candidates,
  };
}
