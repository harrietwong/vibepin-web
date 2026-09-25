import { extractCandidatesFromHtml } from "../extractFromHtml";
import { factsFromShopifyProductJson, mergeFacts, factsFromJsonLd, factsFromOgMeta } from "../productFacts";
import type { AdapterResult, PageFetcher, RawCandidate } from "../types";
import type { ShopifyProductJsonProduct } from "../productFacts";

function extractHandle(pathname: string): string | null {
  return pathname.match(/\/products\/([a-zA-Z0-9_-]+)/)?.[1] ?? null;
}

interface ShopifyProductJson {
  product?: ShopifyProductJsonProduct & {
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
      // Currency is never in products.json; the page HTML (og/JSON-LD) is the only
      // source, and it is already in hand as `preloadedHtml` — zero extra fetch.
      const shopifyFacts = factsFromShopifyProductJson(data?.product, pageUrl, preloadedHtml);
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
          facts:       shopifyFacts,
        };
      }
      // No images in the JSON — fall through to HTML extraction for candidates,
      // but keep the shopify_json facts (they still have price/brand even
      // without images) merged with whatever the HTML fallback finds.
      const htmlFallback = extractCandidatesFromHtml(preloadedHtml, pageUrl, { shopify: true });
      const htmlFacts = mergeFacts([
        factsFromJsonLd(preloadedHtml, pageUrl),
        factsFromOgMeta(preloadedHtml, pageUrl),
      ]);
      return {
        status:      htmlFallback.candidates.length ? "success" : "failed",
        title:       data.product?.title ?? htmlFallback.title,
        description: htmlFallback.description,
        candidates:  htmlFallback.candidates,
        facts:       mergeFacts([shopifyFacts, htmlFacts]),
      };
    } catch {
      /* fall through to HTML extraction */
    }
  }

  const { title, description, candidates } = extractCandidatesFromHtml(preloadedHtml, pageUrl, { shopify: true });
  const facts = mergeFacts([
    factsFromJsonLd(preloadedHtml, pageUrl),
    factsFromOgMeta(preloadedHtml, pageUrl),
  ]);
  return {
    status: candidates.length ? "success" : "failed",
    title,
    description,
    candidates,
    facts,
  };
}
