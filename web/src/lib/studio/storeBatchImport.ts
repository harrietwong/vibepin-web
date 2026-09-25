/**
 * storeBatchImport.ts — FR-06 stage 1 client-side pure logic (Shopify store /
 * collection batch import → "My Products").
 *
 * Kept out of the component so it is unit-testable in node:
 *   - `isStoreImportUrl`       — should a single pasted link go to the store route?
 *   - selection helpers        — default all-selected; image-less products are never
 *                                selectable (they need an uploaded image first);
 *   - `toStoreAssetSaveItems`  — what each chosen product becomes as a saved asset.
 *
 * Nothing here creates drafts or schedules anything (PRD C1/C4): the output only
 * feeds `assetStore.saveAsset`.
 */

import {
  classifyStorePath,
  type StoreBatchProduct,
  type StoreProductsImportResponse,
} from "@/lib/productUrlImport/storeBatchShared";
import type { ProductFacts } from "@/lib/productUrlImport/types";
import { assetFieldsFromImportResult } from "./importedProductFacts";

/**
 * True when ONE pasted link looks like a Shopify store or collection (and is not a
 * single product page): a `*.myshopify.com` host, or any host with a
 * `/collections/{handle}` path. Plain custom-domain home pages are not guessed — the
 * user reaches those through the explicit "Import products from a store" button.
 */
export function isStoreImportUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  let url: URL;
  try { url = new URL(trimmed); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const path = classifyStorePath(url.pathname);
  if (path.kind === "product_page" || path.kind === "invalid_collection") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "myshopify.com" || host.endsWith(".myshopify.com")) return true;
  return path.kind === "collection";
}

export function isSelectableStoreProduct(p: Pick<StoreBatchProduct, "imageUrl">): boolean {
  return typeof p.imageUrl === "string" && p.imageUrl.trim().length > 0;
}

/** Default selection: every product that has an image. */
export function initialStoreSelection(products: StoreBatchProduct[]): Set<string> {
  return new Set(products.filter(isSelectableStoreProduct).map(p => p.handle));
}

export function toggleStoreSelection(selection: Set<string>, handle: string, products: StoreBatchProduct[]): Set<string> {
  const product = products.find(p => p.handle === handle);
  if (!product || !isSelectableStoreProduct(product)) return selection;
  const next = new Set(selection);
  if (next.has(handle)) next.delete(handle); else next.add(handle);
  return next;
}

export function selectAllStoreProducts(products: StoreBatchProduct[]): Set<string> {
  return initialStoreSelection(products);
}

export function selectNoStoreProducts(): Set<string> {
  return new Set();
}

/** Count of selected products that will actually be saved (selectable ones only). */
export function selectedStoreProductCount(selection: Set<string>, products: StoreBatchProduct[]): number {
  return products.filter(p => isSelectableStoreProduct(p) && selection.has(p.handle)).length;
}

/** Display price for a row: amount + ISO currency; "unknown" currency is never printed. */
export function storeProductPriceLabel(p: StoreBatchProduct): string | null {
  const amount = p.facts.price?.amount?.trim();
  if (!amount) return null;
  const currency = p.facts.price?.currency?.trim();
  return currency && currency.toLowerCase() !== "unknown" ? `${amount} ${currency}` : amount;
}

export type StoreBatchSaveItem = {
  imageUrl:          string;
  title:             string;
  sourceUrl:         string;
  sourceDomain:      string;
  productUrl:        string;
  store:             string;
  collectionHandle?: string;
  allImages:         string[];
  facts?:            ProductFacts;
  price?:            string;
  currency?:         string;
};

/**
 * Chosen products → asset save items, in list order. Products without an image are
 * skipped REGARDLESS of selection: `saveAsset` dedupes on imageUrl + role, so a
 * batch of image-less rows would collapse into a single asset.
 */
export function toStoreAssetSaveItems(
  response: Pick<StoreProductsImportResponse, "store" | "products">,
  selection: Set<string>,
): StoreBatchSaveItem[] {
  const out: StoreBatchSaveItem[] = [];
  for (const p of response.products) {
    if (!selection.has(p.handle) || !isSelectableStoreProduct(p)) continue;
    out.push({
      imageUrl:     p.imageUrl!,
      title:        p.title,
      sourceUrl:    p.productUrl,
      sourceDomain: response.store.domain,
      productUrl:   p.productUrl,
      store:        response.store.domain,
      ...(response.store.collectionHandle ? { collectionHandle: response.store.collectionHandle } : {}),
      allImages:    p.images,
      ...assetFieldsFromImportResult({ facts: p.facts }),
    });
  }
  return out;
}
