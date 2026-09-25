import { extractCandidatesFromHtml } from "../extractFromHtml";
import type { AdapterResult } from "../types";

/**
 * Returned when Etsy blocks the fetch (HTTP 403 / timeout / any network error).
 * Never show raw "HTTP 403" to the user — always surface this instead.
 */
export const ETSY_BLOCKED_RESULT: Omit<AdapterResult, "candidates"> = {
  status:          "blocked",
  message:         "Etsy does not allow automatic product reads. Upload a product photo or paste a direct image URL — the link stays as the destination.",
  fallbackActions: ["upload_image", "paste_direct_image_url"],
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
