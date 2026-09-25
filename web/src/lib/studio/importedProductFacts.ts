/**
 * importedProductFacts.ts — FR-03: where an independent-store URL import's
 * `ProductFacts` go after the import route answers.
 *
 * Two pure mappings, shared by every call site so the save paths and the copy
 * path cannot drift apart:
 *
 *  - `assetFieldsFromImportResult` — what a saved "My Products" asset keeps:
 *    the whole `facts` object plus the card's display price. `price`/`currency`
 *    follow the Shopify asset convention (amount and ISO code in separate fields,
 *    see ShopifyProductPickerPanel) so every existing price chip renders it the
 *    same way; an "unknown" currency is left out rather than printed. `description`
 *    lands on the asset even when the page had no structured `facts` at all — a
 *    generic page with only a scraped title/description must not lose that text
 *    just because it never produced a `ProductFacts` object.
 *
 *  - `buildImportedFactsCopyContext` — what the AI copy request may see. Mirrors
 *    `buildAmazonCopyContext`: store-declared structured fields become
 *    productContext, page text becomes pageContext (seller wording, never a
 *    catalog fact). Price and availability are NEVER passed (PRD FR-03-4, ruling
 *    D3): the validator's price traps make a quoted price an unrecoverable 422,
 *    and a stale price on a live Pin misleads buyers.
 */

import type { ProductFacts } from "@/lib/productUrlImport/types";

/** Same cap `analyzeHandler.text()` enforces; longer strings are dropped server-side. */
const MAX_PAGE_DESCRIPTION = 2000;

export type ImportedAssetFields = {
  facts?: ProductFacts;
  price?: string;
  currency?: string;
  description?: string;
};

export function assetFieldsFromImportResult(
  result: { facts?: ProductFacts; description?: string } | null | undefined,
): ImportedAssetFields {
  const facts = result?.facts;
  if (!facts) {
    const description = result?.description?.trim();
    return description ? { description } : {};
  }
  const amount = facts.price?.amount?.trim();
  const currency = facts.price?.currency?.trim();
  const description = facts.description?.trim() ?? result?.description?.trim();
  return {
    facts,
    ...(amount ? { price: amount } : {}),
    ...(amount && currency && currency.toLowerCase() !== "unknown" ? { currency } : {}),
    ...(description ? { description } : {}),
  };
}

export type ImportedFactsCopyContext = {
  /** Only the fields the facts can ground; merged over the base ProductContext by the caller. */
  product: { title?: string; vendor?: string };
  page?: { title?: string; description?: string };
};

const clean = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v ? v : undefined;
};

/**
 * Brand only counts as a declared catalog fact when it came from the store's own
 * structured data (Shopify product JSON `vendor`, JSON-LD `brand`). An og-meta or
 * WooCommerce-scraped page never supplies a vendor here.
 */
export function buildImportedFactsCopyContext(facts: ProductFacts): ImportedFactsCopyContext {
  const trustedBrand = facts.source === "shopify_json" || facts.source === "jsonld";
  const title = clean(facts.title);
  const description = clean(facts.description)?.slice(0, MAX_PAGE_DESCRIPTION);
  return {
    product: {
      title,
      vendor: trustedBrand ? clean(facts.brand) : undefined,
    },
    ...(title || description ? { page: { title, description } } : {}),
  };
}
