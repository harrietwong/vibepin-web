import { extractCandidatesFromHtml, resolveUrl } from "../extractFromHtml";
import type { AdapterResult, RawCandidate } from "../types";

/** Extracts full-res images from WooCommerce product gallery data attributes. */
function collectWooCommerceGallery(html: string, pageUrl: string): RawCandidate[] {
  const seen = new Set<string>();
  const results: RawCandidate[] = [];

  // data-large_image on gallery wrapper elements
  const reLarge = /data-large_image="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = reLarge.exec(html)) !== null) {
    const abs = resolveUrl(m[1], pageUrl);
    if (abs && !abs.startsWith("data:") && !seen.has(abs)) {
      seen.add(abs);
      results.push({ imageUrl: abs, score: 0.9, reason: "woocommerce_gallery" });
    }
  }

  // Fallback: img inside .woocommerce-product-gallery__image
  const reGalleryImg = /class="[^"]*woocommerce-product-gallery__image[^"]*"[\s\S]*?<img[^>]+src="([^"]+)"/gi;
  while ((m = reGalleryImg.exec(html)) !== null) {
    const abs = resolveUrl(m[1], pageUrl);
    if (abs && !abs.startsWith("data:") && !seen.has(abs)) {
      seen.add(abs);
      results.push({ imageUrl: abs, score: 0.85, reason: "woocommerce_gallery" });
    }
  }

  return results;
}

/**
 * WooCommerce adapter: gallery images take priority over generic og:image.
 * JSON-LD Product is still used for title/description.
 */
export function woocommerceAdapter(html: string, pageUrl: string): AdapterResult {
  const galleryCandidates = collectWooCommerceGallery(html, pageUrl);
  const { title, description, candidates: genericCandidates } = extractCandidatesFromHtml(html, pageUrl);

  // Gallery images first, then JSON-LD / og:image
  const candidates = [...galleryCandidates, ...genericCandidates];

  return {
    status: candidates.length ? "success" : "failed",
    title,
    description,
    candidates,
  };
}
