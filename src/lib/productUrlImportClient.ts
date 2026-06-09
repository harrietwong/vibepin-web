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
export type Provider     = "direct_image" | "shopify" | "woocommerce" | "etsy" | "pinterest" | "generic" | "unknown";
export type AssetType    = "product" | "reference";

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
  }>;
};

export async function fetchProductUrlImport(urls: string[]): Promise<ProductUrlImportApiResponse> {
  const resp = await fetch("/api/import/product-urls", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ urls }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Import failed (${resp.status})`);
  }

  return resp.json() as Promise<ProductUrlImportApiResponse>;
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
