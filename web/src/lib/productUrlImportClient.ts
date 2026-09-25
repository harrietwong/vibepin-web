import type { AmazonImportMeta, ProductFacts } from "@/lib/productUrlImport/types";
import type { StoreProductsImportResponse } from "@/lib/productUrlImport/storeBatchShared";

export const DEFAULT_MAX_URLS = 10;
export const HARD_MAX_URLS = 20;

export function parseProductImportUrls(text: string): {
  urls: string[];
  dedupedCount: number;
  overBatchLimit: boolean;
  invalidLines: string[];
} {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const invalidLines: string[] = [];
  const valid: string[] = [];

  for (const line of lines) {
    if (/^https?:\/\//i.test(line)) valid.push(line);
    else invalidLines.push(line);
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of valid) {
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(url);
  }

  const overBatchLimit = deduped.length > DEFAULT_MAX_URLS;
  const urls = deduped.slice(0, DEFAULT_MAX_URLS);

  return { urls, dedupedCount: valid.length - deduped.length, overBatchLimit, invalidLines };
}

export function candidateSelectionKey(sourceUrl: string, candidateId: string): string {
  return `${sourceUrl}::${candidateId}`;
}

export function reasonLabel(reason: string): string {
  switch (reason) {
    case "direct_image_url":       return "Main image";
    case "og_image":               return "Main image";
    case "twitter_image":          return "Main image";
    case "jsonld_product_image":   return "Product image";
    case "shopify_product_json":   return "Product image";
    case "shopify_html_fallback":  return "Product image";
    case "woocommerce_gallery":    return "Product image";
    case "etsy_metadata_fallback": return "Product image";
    case "pinterest_og":           return "Pin image";
    default:                       return "Page image";
  }
}

export type ImportStatus = "success" | "partial" | "blocked" | "unsupported" | "error" | "failed";
export type Provider     = "direct_image" | "shopify" | "woocommerce" | "etsy" | "pinterest" | "generic" | "amazon" | "marketplace_manual" | "unknown";
export type AssetType    = "product" | "reference";
export type MarketplaceId = "temu" | "shein" | "aliexpress" | "tiktok_shop";

export type ProductUrlImportApiResponse = {
  results: Array<{
    sourceUrl:        string;
    sourceDomain:     string;
    status:           ImportStatus;
    title?:           string;
    description?:     string;
    candidates?:      Array<{
      id:       string;
      imageUrl: string;
      width?:   number;
      height?:  number;
      score:    number;
      reason:   string;
    }>;
    error?:           string;
    // Provider enrichment
    originalUrl?:     string;
    normalizedUrl?:   string;
    provider?:        Provider;
    assetType?:       AssetType;
    message?:         string;
    fallbackActions?: string[];
    debugCode?:       string;
    /** Amazon links only (text-only channel): link status, fetch outcome, page text. */
    amazon?:          AmazonImportMeta;
    /** Independent-store structured facts (FR-01/02). Never present for Amazon. */
    facts?:           ProductFacts;
    /** `provider: "marketplace_manual"` only (FR-04): which blocked marketplace. */
    marketplace?:     MarketplaceId;
  }>;
};

/**
 * The import route requires a signed-in user. Same-origin requests already carry the
 * Supabase SSR cookies, but we also send the Bearer token so auth does not depend on
 * cookie refresh timing (matches the other authed JSON routes). Loaded lazily so this
 * module stays importable from node tests without a browser Supabase client.
 */
async function importAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const { freshSessionIdentity } = await import("@/lib/supabaseBrowser");
    const identity = await freshSessionIdentity();
    if (identity?.accessToken) headers.Authorization = `Bearer ${identity.accessToken}`;
  } catch {
    /* fall back to cookie auth */
  }
  return headers;
}

export async function fetchProductUrlImport(urls: string[]): Promise<ProductUrlImportApiResponse> {
  const resp = await fetch("/api/import/product-urls", {
    method:  "POST",
    headers: await importAuthHeaders(),
    body:    JSON.stringify({ urls }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Import failed (${resp.status})`);
  }

  return resp.json() as Promise<ProductUrlImportApiResponse>;
}

/**
 * FR-06: Shopify store / collection batch import. One request per batch; the server
 * derives every endpoint itself — only the pasted URL is sent.
 */
export async function fetchStoreProductsImport(url: string): Promise<StoreProductsImportResponse> {
  const resp = await fetch("/api/import/store-products", {
    method:  "POST",
    headers: await importAuthHeaders(),
    body:    JSON.stringify({ url }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Import failed (${resp.status})`);
  }

  return resp.json() as Promise<StoreProductsImportResponse>;
}

export function autoSelectTopCandidates(
  results: ProductUrlImportApiResponse["results"],
): Set<string> {
  const selected = new Set<string>();
  for (const result of results) {
    if (result.status !== "success" || !result.candidates?.length) continue;
    const top = [...result.candidates].sort((a, b) => b.score - a.score)[0];
    selected.add(candidateSelectionKey(result.sourceUrl, top.id));
  }
  return selected;
}
