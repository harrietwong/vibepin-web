/**
 * pinDisplayContext.ts — the unified Pin Display Context Layer.
 *
 * `getPinDisplayContext(pin)` resolves the product + affiliate context for ANY
 * Pin shown in the UI (Edit Pin modal, Batch Edit, Plan views), so product
 * image / title / ASIN / affiliate URL / destination URL are always consistent
 * and no Pin is rendered as an orphan when a product actually exists.
 *
 * Read-only + pure (given its deps): it does NOT create/modify affiliate links,
 * Pins, or the schema. It only *reads* the existing product asset store and the
 * CreatorProductLink repo. Deps are injectable for deterministic unit tests.
 */

import { extractAsin, isAmazonUrl, isValidAsin } from "@/lib/affiliate/amazon";
import type { CreatorProductLink } from "@/lib/affiliate/creatorProductLink";
import { localStorageRepo } from "@/lib/affiliate/creatorProductLink";
import * as assetStore from "@/lib/assetStore";
import type { LinkedProduct } from "@/lib/pinMetadata";

/** Minimal product record the context layer needs (AssetItem / LinkedProduct compatible). */
export type DisplayProductLike = {
  productId?:   string;
  id?:          string;
  title?:       string;
  imageUrl?:    string | null;
  productUrl?:  string;
  canonicalUrl?: string;
  sourceUrl?:   string;
  sourceDomain?: string;
  store?:       string;
  source?:      string;
};

/** The Pin fields this layer reads. Superset of PinDraft + Batch row + generated Pin. */
export type PinDisplayInput = {
  productId?:            string;
  creatorProductLinkId?: string;
  sourceProductImageUrl?: string;
  destinationUrl?:       string;
  primaryProductId?:     string;
  linkedProducts?:       LinkedProduct[];
  // Batch Edit row / generated Pin single-product fields:
  linkedProductId?:      string | null;
  linkedProductTitle?:   string | null;
  linkedProductImageUrl?: string | null;
  linkedProductUrl?:     string | null;
  linkedProductSource?:  string | null;
  // Fallback image if nothing else resolves a product image.
  imageUrl?:             string;
};

export type PinDisplayContext = {
  productTitle:   string | null;
  productImage:   string | null;
  asin:           string | null;
  affiliateUrl:   string | null;
  destinationUrl: string | null;
  productSource:  "amazon" | "other";
  /** True when the Pin has any resolvable product identity/context. */
  hasProduct:     boolean;
  /** The resolved CreatorProductLink status, when a link exists. */
  linkStatus:     CreatorProductLink["status"] | null;
};

export type PinDisplayDeps = {
  getProductById?: (id: string) => DisplayProductLike | null;
  getLinkById?:    (id: string) => CreatorProductLink | null;
};

function defaultGetProductById(id: string): DisplayProductLike | null {
  if (!id) return null;
  try { return (assetStore.getAssets().find(a => a.id === id) as DisplayProductLike | undefined) ?? null; }
  catch { return null; }
}

function defaultGetLinkById(id: string): CreatorProductLink | null {
  if (!id) return null;
  try { return localStorageRepo.getById(id); }
  catch { return null; }
}

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

/** Loose resolved-product shape (LinkedProduct / batch-row / product record). */
type ResolvedProduct = {
  productId?:   string;
  title?:       string;
  imageUrl?:    string | null;
  productUrl?:  string;
  canonicalUrl?: string;
  source?:      string;
};

/** Resolve the primary linked product from a Pin's linked-product fields. */
function resolveLinkedProduct(pin: PinDisplayInput): ResolvedProduct | null {
  const list = pin.linkedProducts ?? [];
  if (list.length) {
    const primary = (pin.primaryProductId && list.find(p => p.productId === pin.primaryProductId)) || list[0];
    if (primary) return primary;
  }
  // Batch row / generated Pin single-product shape.
  if (pin.linkedProductId || pin.linkedProductTitle || pin.linkedProductUrl || pin.linkedProductImageUrl) {
    return {
      productId:  pin.linkedProductId ?? undefined,
      title:      pin.linkedProductTitle ?? "",
      imageUrl:   pin.linkedProductImageUrl ?? undefined,
      productUrl: pin.linkedProductUrl ?? undefined,
      source:     pin.linkedProductSource ?? "url_imported",
    };
  }
  return null;
}

/**
 * Resolve the unified product + affiliate display context for a Pin.
 *
 * Priority for each field:
 *  - product record (assetStore by productId) → linked product → creator link
 *  - affiliate URL only from a `ready` CreatorProductLink with a real affiliateUrl
 *  - destinationUrl always comes straight from the Pin (never invented)
 */
export function getPinDisplayContext(
  pin: PinDisplayInput | null | undefined,
  deps: PinDisplayDeps = {},
): PinDisplayContext {
  const empty: PinDisplayContext = {
    productTitle: null, productImage: null, asin: null, affiliateUrl: null,
    destinationUrl: null, productSource: "other", hasProduct: false, linkStatus: null,
  };
  if (!pin) return empty;

  const getProductById = deps.getProductById ?? defaultGetProductById;
  const getLinkById     = deps.getLinkById ?? defaultGetLinkById;

  const productId = trimOrNull(pin.productId);
  const product   = productId ? getProductById(productId) : null;
  const linked    = resolveLinkedProduct(pin);
  const link      = pin.creatorProductLinkId ? getLinkById(pin.creatorProductLinkId) : null;

  const productUrl =
    trimOrNull(product?.productUrl) ??
    trimOrNull(product?.canonicalUrl) ??
    trimOrNull(product?.sourceUrl) ??
    trimOrNull(linked?.productUrl) ??
    trimOrNull(linked?.canonicalUrl) ??
    trimOrNull(link?.canonicalProductUrl);

  const productTitle =
    trimOrNull(product?.title) ??
    trimOrNull(linked?.title) ??
    null;

  const productImage =
    trimOrNull(product?.imageUrl) ??
    trimOrNull(pin.sourceProductImageUrl) ??
    trimOrNull(linked?.imageUrl) ??
    null;

  const destinationUrl = trimOrNull(pin.destinationUrl);

  // ASIN: prefer the persisted link's ASIN, else parse any product/destination URL.
  const asin =
    (link && isValidAsin(link.asin) ? link.asin : null) ??
    extractAsin(productUrl) ??
    extractAsin(destinationUrl) ??
    null;

  // Affiliate URL only surfaces from a ready link with a real URL.
  const affiliateUrl = link && link.status === "ready" ? trimOrNull(link.affiliateUrl) : null;

  const looksAmazon =
    link?.provider === "amazon" ||
    !!asin ||
    isAmazonUrl(productUrl) ||
    isAmazonUrl(destinationUrl) ||
    /amazon|amzn/.test(`${linked?.source ?? ""} ${product?.sourceDomain ?? ""} ${product?.store ?? ""} ${product?.source ?? ""}`.toLowerCase());

  const hasProduct = !!(productTitle || productImage || productId || linked || link);

  return {
    productTitle,
    productImage,
    asin,
    affiliateUrl,
    destinationUrl,
    productSource: looksAmazon ? "amazon" : "other",
    hasProduct,
    linkStatus: link?.status ?? null,
  };
}
