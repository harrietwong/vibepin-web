/**
 * FR-06 stage 1 (Shopify store / collection batch import) — shared, PURE pieces.
 *
 * No node imports here: the client (StoreProductsImportPanel, storeBatchImport.ts)
 * and the server (storeProductsImport.ts) both read this file. The server remains
 * the only side that decides which endpoint is fetched — the client helper uses
 * `classifyStorePath` purely to decide which route to call.
 */

import type { ProductFacts } from "./types";

export type StorePathKind =
  | { kind: "product_page" }
  | { kind: "collection"; handle: string }
  | { kind: "store" }
  | { kind: "invalid_collection" };

/** `/products/{handle}` anywhere in the path (incl. `/collections/x/products/y` and `/en-gb/products/y`). */
const PRODUCT_PAGE_RE = /(?:^|\/)products\/[^/?#]+/i;
/** `/collections/{handle}` anywhere in the path (incl. locale prefixes like `/en-gb/collections/x`). */
const COLLECTION_RE = /(?:^|\/)collections\/([^/?#]+)/i;
/** A Shopify handle after percent-decoding: letters, digits, `_`, `-` (unicode letters allowed). */
const HANDLE_RE = /^[\p{L}\p{N}_-]+$/u;

/**
 * Classify a store URL path. Product pages are checked FIRST: a
 * `/collections/x/products/y` link is a single product, not a collection.
 * `/collections/x/products.json` is the collection's own endpoint → collection.
 * Anything else (store home, `/products.json`, `/pages/about`) → the whole store;
 * the server derives its own endpoint and ignores the client's path/query.
 */
export function classifyStorePath(pathname: string): StorePathKind {
  if (PRODUCT_PAGE_RE.test(pathname)) return { kind: "product_page" };
  const m = pathname.match(COLLECTION_RE);
  if (m) {
    let raw = m[1];
    if (/\.json$/i.test(raw)) return { kind: "invalid_collection" };
    try { raw = decodeURIComponent(raw); } catch { return { kind: "invalid_collection" }; }
    if (!HANDLE_RE.test(raw) || raw.length > 255) return { kind: "invalid_collection" };
    return { kind: "collection", handle: raw.toLowerCase() };
  }
  return { kind: "store" };
}

export type StoreBatchStatus = "success" | "unsupported" | "failed";

export type StoreBatchProduct = {
  handle:     string;
  title:      string;
  productUrl: string;
  /** First product image; absent → the UI marks "No image — upload one" and it cannot be selected. */
  imageUrl?:  string;
  images:     string[];
  facts:      ProductFacts;
};

export type StoreProductsImportResponse = {
  status:   StoreBatchStatus;
  store:    { domain: string; collectionHandle?: string; currency: string };
  products: StoreBatchProduct[];
  truncated: boolean;
  message?: string;
};

export const STORE_BATCH_MAX_PRODUCTS = 100;

/** Business-language messages. Never carry an upstream status code or address (0904 SEC-URL-03). */
export const STORE_UNSUPPORTED_MESSAGE =
  "This doesn't look like a Shopify store, or its product list is private. Paste a single product link instead.";
export const STORE_FAILED_MESSAGE =
  "We couldn't read this store's product list right now. Try again later, or paste a single product link instead.";
export const STORE_PRODUCT_PAGE_MESSAGE =
  "This is a single product link. Use link import for it instead.";
