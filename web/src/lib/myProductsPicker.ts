import type { AssetItem } from "@/lib/assetStore";
import { looksLikeAmazon } from "@/lib/affiliate/amazon";

/**
 * My Products SOURCE filters (create-pin PRD Section C).
 *
 * These describe where a product came from. Two former entries were removed:
 *   - "product_ideas" — Product Ideas is a primary TAB, not a source of the user's
 *     own products; listing it here made the same items reachable two ways.
 *   - "recent" — recency is an ordering, not a source. It now lives in
 *     MY_PRODUCTS_SORTS below.
 * "shopify" was added: it is a genuine source of My Products (and replaces the old
 * "From Shopify" primary tab).
 *
 * "import_issues" is not a source either; it is a conditional triage chip appended
 * by the UI only when broken imports exist.
 */
export type MyProductsFilter =
  | "all"
  | "shopify"
  | "amazon"
  | "uploaded"
  | "url_imported"
  | "import_issues";

export const MY_PRODUCTS_FILTERS: { id: MyProductsFilter; label: string }[] = [
  { id: "all",           label: "All" },
  { id: "shopify",       label: "Shopify" },
  { id: "amazon",        label: "Amazon" },
  { id: "uploaded",      label: "Uploaded" },
  { id: "url_imported",  label: "URL Imported" },
];

/** Sorting is independent of the source filter (Section C: "Move Recent to sorting"). */
export type MyProductsSort = "recently_used" | "recently_added" | "name_asc";

export const MY_PRODUCTS_SORTS: { id: MyProductsSort; label: string }[] = [
  { id: "recently_used",  label: "Recently used" },
  { id: "recently_added", label: "Recently added" },
  { id: "name_asc",       label: "Name A–Z" },
];

/** True when the workspace has any Shopify-sourced product (drives chip visibility). */
export function hasShopifyProducts(items: AssetItem[]): boolean {
  return items.some(i => i.source === "shopify");
}

/** True when the workspace has any Amazon product. */
export function hasAmazonProducts(items: AssetItem[]): boolean {
  return items.some(isAmazonProductAsset);
}

/**
 * Only show source chips relevant to this workspace (Section C). "All" is always
 * shown; a source chip appears only when the user actually has such products, so
 * nobody clicks a chip that can only ever return an empty grid.
 */
export function visibleProductSourceFilters(items: AssetItem[]): { id: MyProductsFilter; label: string }[] {
  return MY_PRODUCTS_FILTERS.filter(chip => {
    switch (chip.id) {
      case "all":          return true;
      case "shopify":      return hasShopifyProducts(items);
      case "amazon":       return hasAmazonProducts(items);
      case "uploaded":     return items.some(i => i.source === "upload");
      case "url_imported": return items.some(i => i.source === "url");
      default:             return false;
    }
  });
}

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

// productSourceBucket() was removed with the "product_ideas" source chip — it had
// no callers and its only non-trivial branch mapped to a filter that no longer
// exists. Source labelling goes through productSourceLabel() below.

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

function sortProducts(list: AssetItem[], sort: MyProductsSort): AssetItem[] {
  const time = (v: string | undefined) => {
    const t = new Date(v ?? "").getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  switch (sort) {
    case "recently_added":
      return [...list].sort((a, b) => time(b.createdAt) - time(a.createdAt));
    case "name_asc":
      return [...list].sort((a, b) =>
        productDisplayTitle(a).localeCompare(productDisplayTitle(b), undefined, { sensitivity: "base" }),
      );
    case "recently_used":
    default:
      return [...list].sort((a, b) => time(b.lastUsedAt) - time(a.lastUsedAt));
  }
}

export function filterMyProducts(
  items: AssetItem[],
  filter: MyProductsFilter,
  search: string,
  sort: MyProductsSort = "recently_used",
): AssetItem[] {
  const q = search.trim().toLowerCase();
  const healthy = dedupeProductAssets(items).filter(item => {
    if (isBrokenProductImport(item)) return filter === "import_issues";
    if (filter === "import_issues") return false;
    return true;
  });

  let list = healthy;
  if (filter === "shopify") {
    list = list.filter(i => i.source === "shopify");
  } else if (filter === "amazon") {
    list = list.filter(isAmazonProductAsset);
  } else if (filter === "uploaded") {
    list = list.filter(i => i.source === "upload");
  } else if (filter === "url_imported") {
    list = list.filter(i => i.source === "url" && isValidProductImageUrl(i.imageUrl));
  }

  // Sorting is orthogonal to the source filter — including for "import_issues",
  // which is a triage view over the same records.
  list = sortProducts(list, sort);

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
