import type { AssetItem } from "@/lib/assetStore";
import { looksLikeAmazon } from "@/lib/affiliate/amazon";

export type MyProductsFilter =
  | "all"
  | "amazon"
  | "uploaded"
  | "url_imported"
  | "product_ideas"
  | "recent"
  | "import_issues";

export const MY_PRODUCTS_FILTERS: { id: MyProductsFilter; label: string }[] = [
  { id: "all",           label: "All" },
  { id: "amazon",        label: "Amazon" },
  { id: "uploaded",      label: "Uploaded" },
  { id: "url_imported",  label: "URL Imported" },
  { id: "product_ideas", label: "Product Ideas" },
  { id: "recent",        label: "Recent" },
];

/** True when a saved product asset points at an Amazon product. */
export function isAmazonProductAsset(item: AssetItem): boolean {
  return looksLikeAmazon({
    productUrl:   item.productUrl,
    sourceUrl:    item.sourceUrl,
    canonicalUrl: item.canonicalUrl,
    sourceDomain: item.sourceDomain,
    store:        item.store,
  });
}

export function isValidProductImageUrl(imageUrl?: string): boolean {
  const url = imageUrl?.trim();
  if (!url) return false;
  if (url === "undefined" || url === "null") return false;
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  if (url.startsWith("/")) return true;
  return /^https?:\/\//i.test(url);
}

export function isBrokenProductImport(item: AssetItem): boolean {
  if (item.role !== "product") return false;
  if (item.source !== "url") return false;
  return !isValidProductImageUrl(item.imageUrl);
}

export function productSourceBucket(item: AssetItem): MyProductsFilter | null {
  if (item.source === "upload") return "uploaded";
  if (item.source === "url") return "url_imported";
  if (item.source === "product_signal" || item.source === "product_ideas") return "product_ideas";
  return null;
}

export function productSourceLabel(item: AssetItem): string {
  if (item.source === "upload") return "Uploaded";
  if (item.source === "url") return "URL Imported";
  if (item.source === "product_signal" || item.source === "product_ideas") return "Product Ideas";
  if (item.source === "shopify") return "Shopify";
  return "Recent";
}

export function productDisplayTitle(item: AssetItem): string {
  const title = item.title?.trim();
  if (title) return title;
  if (item.sourceDomain) return `Imported product from ${item.sourceDomain}`;
  if (item.sourceUrl) {
    try {
      return `Imported product from ${new URL(item.sourceUrl).hostname.replace(/^www\./, "")}`;
    } catch { /* fall through */ }
  }
  return "Untitled product";
}

/** One row per asset id — no cross-section duplication. */
export function dedupeProductAssets(items: AssetItem[]): AssetItem[] {
  const seen = new Set<string>();
  const out: AssetItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function filterMyProducts(
  items: AssetItem[],
  filter: MyProductsFilter,
  search: string,
): AssetItem[] {
  const q = search.trim().toLowerCase();
  const healthy = dedupeProductAssets(items).filter(item => {
    if (isBrokenProductImport(item)) return filter === "import_issues";
    if (filter === "import_issues") return false;
    return true;
  });

  let list = healthy;
  if (filter === "amazon") {
    list = list.filter(isAmazonProductAsset);
  } else if (filter === "uploaded") {
    list = list.filter(i => i.source === "upload");
  } else if (filter === "url_imported") {
    list = list.filter(i => i.source === "url" && isValidProductImageUrl(i.imageUrl));
  } else if (filter === "product_ideas") {
    list = list.filter(i => i.source === "product_signal" || i.source === "product_ideas");
  } else if (filter === "recent") {
    list = [...list].sort(
      (a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime(),
    );
  } else if (filter === "all") {
    list = [...list].sort(
      (a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime(),
    );
  }

  if (q) {
    list = list.filter(i =>
      productDisplayTitle(i).toLowerCase().includes(q) ||
      (i.keyword ?? "").toLowerCase().includes(q) ||
      (i.category ?? "").toLowerCase().includes(q),
    );
  }

  return list;
}

export function countBrokenImports(items: AssetItem[]): number {
  return dedupeProductAssets(items).filter(isBrokenProductImport).length;
}
