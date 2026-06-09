import { extractCandidatesFromHtml } from "../extractFromHtml";
import type { AdapterResult, PageFetcher, RawCandidate } from "../types";

function extractHandle(pathname: string): string | null {
  return pathname.match(/\/products\/([a-zA-Z0-9_-]+)/)?.[1] ?? null;
}

interface ShopifyProductJson {
  product?: {
    title?: string;
    body_html?: string;
    images?: Array<{ src: string; width?: number; height?: number }>;
  };
}

/**
 * Tries the Shopify product JSON endpoint first (`/products/{handle}.json`),
 * which gives structured data with all variant images.
 * Falls back to HTML extraction with Shopify CDN hints.
 */
export async function shopifyAdapter(
  url: URL,
  fetchPage: PageFetcher,
  preloadedHtml: string,
  pageUrl: string,
): Promise<AdapterResult> {
  const handle = extractHandle(url.pathname);

  if (handle) {
    try {
      const jsonUrl = `${url.origin}/products/${handle}.json`;
      const { html: jsonBody } = await fetchPage(jsonUrl);
      const data = JSON.parse(jsonBody) as ShopifyProductJson;
      const images = data?.product?.images ?? [];
      if (images.length) {
        const candidates: RawCandidate[] = images.map(img => ({
          imageUrl: img.src,
          width:    img.width,
          height:   img.height,
          score:    0.95,
          reason:   "shopify_product_json" as const,
        }));
        return {
          status:      "success",
          title:       data.product?.title,
          candidates,
        };
      }
    } catch {
      /* fall through to HTML extraction */
    }
  }

  const { title, description, candidates } = extractCandidatesFromHtml(preloadedHtml, pageUrl, { shopify: true });
  return {
    status: candidates.length ? "success" : "failed",
    title,
    description,
    candidates,
  };
}
