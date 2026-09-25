/**
 * FR-01 / FR-02: structured product facts extracted from a single already-fetched
 * page response. Pure functions, zero network. Every field is filled only when the
 * page states it explicitly — no inferred price, no brand-from-image, no guessed
 * currency. On failure or missing data, fields are simply omitted; we never write
 * an empty string (a client merge must never blank a user's own field).
 *
 * Priority when multiple sources are available on the same page:
 *   shopify_json > jsonld > woocommerce > og_meta
 */

import { decodeHtmlText } from "./adapters/amazon";
import { extractMeta } from "./extractFromHtml";
import type { ProductFacts, ProductFactsAvailability, ProductFactsPrice, ProductFactsSource } from "./types";

const MAX_DESCRIPTION_CHARS = 1000;

/** Strip tags, decode entities, collapse whitespace, cap length. Empty result → undefined. */
export function cleanDescription(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = decodeHtmlText(raw).slice(0, MAX_DESCRIPTION_CHARS).trim();
  return cleaned.length ? cleaned : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function isFactsEmpty(f: Omit<ProductFacts, "sourceUrl" | "fetchedAt" | "source" | "completeness">): boolean {
  return (
    f.title === undefined &&
    f.description === undefined &&
    f.brand === undefined &&
    f.price === undefined &&
    f.availability === undefined
  );
}

function completenessOf(f: Pick<ProductFacts, "price" | "brand">): "full" | "partial" {
  return f.price && f.brand ? "full" : "partial";
}

// ── Shopify product.json ────────────────────────────────────────────────────

export interface ShopifyProductJsonVariant {
  price?:            string | number | null;
  compare_at_price?: string | number | null;
  available?:        unknown;
}

export interface ShopifyProductJsonProduct {
  title?:      string;
  body_html?:  string;
  vendor?:     string;
  variants?:   ShopifyProductJsonVariant[];
}

function numericOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Currency is never in products.json — only ever from the page HTML (og/JSON-LD). */
function currencyFromHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return (
    nonEmpty(extractMeta(html, "og:price:currency", "property")) ??
    nonEmpty(extractMeta(html, "product:price:currency", "property")) ??
    nonEmpty(jsonLdFirstPriceCurrency(html))
  );
}

function jsonLdFirstPriceCurrency(html: string): string | undefined {
  const products = collectJsonLdProductNodes(html);
  for (const p of products) {
    const offer = firstOffer(p.offers);
    const currency = offer && nonEmpty(offer.priceCurrency);
    if (currency) return currency;
  }
  return undefined;
}

export function factsFromShopifyProductJson(
  product: ShopifyProductJsonProduct | undefined | null,
  pageUrl: string,
  html?: string,
  now: string = new Date().toISOString(),
): ProductFacts | undefined {
  if (!product) return undefined;

  const variant = product.variants?.[0];
  const priceNum = numericOrUndefined(variant?.price);
  const compareNum = numericOrUndefined(variant?.compare_at_price);

  let price: ProductFactsPrice | undefined;
  if (priceNum !== undefined) {
    const currency = currencyFromHtml(html) ?? "unknown";
    const includeCompare =
      compareNum !== undefined && compareNum > 0 && compareNum !== priceNum;
    price = {
      amount:   String(variant!.price),
      currency,
      ...(includeCompare ? { compareAt: String(variant!.compare_at_price) } : {}),
    };
  }

  let availability: ProductFactsAvailability | undefined;
  if (typeof variant?.available === "boolean") {
    availability = variant.available ? "in_stock" : "out_of_stock";
  }

  const partial: Omit<ProductFacts, "sourceUrl" | "fetchedAt" | "source" | "completeness"> = {
    title:       nonEmpty(product.title),
    description: cleanDescription(product.body_html),
    brand:       nonEmpty(product.vendor),
    price,
    availability,
  };

  if (isFactsEmpty(partial)) return undefined;

  return {
    ...partial,
    sourceUrl:    pageUrl,
    fetchedAt:    now,
    source:       "shopify_json",
    completeness: completenessOf(partial),
  };
}

// ── JSON-LD Product ──────────────────────────────────────────────────────────

type JsonLdOffer = {
  price?:         unknown;
  priceCurrency?: unknown;
  availability?:  unknown;
  lowPrice?:      unknown;
  highPrice?:     unknown;
};

type JsonLdProductNode = {
  name?:        unknown;
  description?: unknown;
  brand?:       unknown;
  offers?:      unknown;
};

function firstOffer(offersField: unknown): JsonLdOffer | undefined {
  if (!offersField) return undefined;
  const list = Array.isArray(offersField) ? offersField : [offersField];
  const offers = list.filter((o): o is JsonLdOffer => !!o && typeof o === "object");
  if (!offers.length) return undefined;
  const inStock = offers.find(o => {
    const avail = typeof o.availability === "string" ? o.availability : "";
    return /InStock$/i.test(avail);
  });
  return inStock ?? offers[0];
}

function brandNameFrom(brandField: unknown): string | undefined {
  if (!brandField) return undefined;
  if (typeof brandField === "string") return nonEmpty(brandField);
  const candidates = Array.isArray(brandField) ? brandField : [brandField];
  for (const b of candidates) {
    if (b && typeof b === "object" && typeof (b as { name?: unknown }).name === "string") {
      const name = nonEmpty((b as { name?: unknown }).name);
      if (name) return name;
    }
    if (typeof b === "string") {
      const name = nonEmpty(b);
      if (name) return name;
    }
  }
  return undefined;
}

function availabilityFrom(value: unknown): ProductFactsAvailability | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const last = value.trim().split("/").pop() ?? value.trim();
  const norm = last.toLowerCase();
  if (norm === "instock") return "in_stock";
  if (norm === "outofstock" || norm === "soldout") return "out_of_stock";
  if (norm === "preorder") return "preorder";
  return "unknown";
}

function priceFrom(offer: JsonLdOffer | undefined): ProductFactsPrice | undefined {
  if (!offer) return undefined;
  // AggregateOffer with only low/high range is a range, not a stated price — don't infer one.
  if (offer.price === undefined || offer.price === null) return undefined;
  const priceStr = typeof offer.price === "number" ? String(offer.price) : nonEmpty(String(offer.price));
  if (!priceStr) return undefined;
  const currency = nonEmpty(
    typeof offer.priceCurrency === "string" ? offer.priceCurrency : undefined,
  ) ?? "unknown";
  return { amount: priceStr, currency };
}

/**
 * Walks JSON-LD for Product nodes, returning ones with or without images (unlike
 * extractFromHtml.ts's walker, which drops image-less Products because it only
 * cares about candidate images). Do not merge with that walker — its behavior is
 * relied on by the candidate-image tests.
 */
function collectJsonLdProductNodes(html: string): JsonLdProductNode[] {
  const out: JsonLdProductNode[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;
      walkForProducts(parsed, out);
    } catch {
      /* skip malformed JSON-LD */
    }
  }
  return out;
}

function walkForProducts(node: unknown, out: JsonLdProductNode[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach(item => walkForProducts(item, out));
    return;
  }
  if (typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  if (obj["@graph"]) walkForProducts(obj["@graph"], out);

  const typeVal = obj["@type"];
  const types = Array.isArray(typeVal) ? typeVal : typeVal ? [typeVal] : [];
  const isProduct = types.some(t => String(t).toLowerCase() === "product");

  if (isProduct) {
    out.push({
      name:        obj.name,
      description: obj.description,
      brand:       obj.brand,
      offers:      obj.offers,
    });
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") walkForProducts(value, out);
  }
}

export function factsFromJsonLd(
  html: string,
  pageUrl: string,
  now: string = new Date().toISOString(),
): ProductFacts | undefined {
  const products = collectJsonLdProductNodes(html);
  if (!products.length) return undefined;

  // Take the first Product node that has any usable field.
  for (const p of products) {
    const offer = firstOffer(p.offers);
    const partial: Omit<ProductFacts, "sourceUrl" | "fetchedAt" | "source" | "completeness"> = {
      title:       nonEmpty(typeof p.name === "string" ? p.name : undefined),
      description: cleanDescription(typeof p.description === "string" ? p.description : undefined),
      brand:       brandNameFrom(p.brand),
      price:       priceFrom(offer),
      availability: availabilityFrom(offer?.availability),
    };
    if (!isFactsEmpty(partial)) {
      return {
        ...partial,
        sourceUrl:    pageUrl,
        fetchedAt:    now,
        source:       "jsonld",
        completeness: completenessOf(partial),
      };
    }
  }
  return undefined;
}

// ── WooCommerce ──────────────────────────────────────────────────────────────

function wooPriceFallback(html: string): ProductFactsPrice | undefined {
  // First `.price` block's first `.amount` text. `$` / other symbols are not ISO
  // codes, so currency is always "unknown" for this path.
  const priceBlock = html.match(/class="[^"]*\bprice\b[^"]*"[\s\S]*?<\/[a-z]+>/i)?.[0];
  if (!priceBlock) return undefined;
  const amountMatch = priceBlock.match(/class="[^"]*\bamount\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
  const amountText = amountMatch ? decodeHtmlText(amountMatch[1]) : undefined;
  if (!amountText) return undefined;
  const numeric = amountText.replace(/[^\d.,]/g, "").trim();
  if (!numeric) return undefined;
  return { amount: numeric, currency: "unknown" };
}

export function factsFromWooCommerce(
  html: string,
  pageUrl: string,
  now: string = new Date().toISOString(),
): ProductFacts | undefined {
  // Page-embedded JSON-LD takes priority over the `.price .amount` text fallback.
  // `source` on the returned facts stays "jsonld" — it reflects the actual data
  // source, not the calling adapter (the WooCommerce adapter's request for facts
  // just happens to be satisfied by JSON-LD already on the page).
  const jsonLd = factsFromJsonLd(html, pageUrl, now);
  if (jsonLd) return jsonLd;

  const price = wooPriceFallback(html);
  const title = nonEmpty(extractMeta(html, "og:title", "property"));
  const description = cleanDescription(extractMeta(html, "og:description", "property"));

  const partial: Omit<ProductFacts, "sourceUrl" | "fetchedAt" | "source" | "completeness"> = {
    title,
    description,
    brand: undefined,
    price,
    availability: undefined,
  };
  if (isFactsEmpty(partial)) return undefined;

  return {
    ...partial,
    sourceUrl:    pageUrl,
    fetchedAt:    now,
    source:       "woocommerce",
    completeness: "partial",
  };
}

// ── og / twitter meta ────────────────────────────────────────────────────────

export function factsFromOgMeta(
  html: string,
  pageUrl: string,
  now: string = new Date().toISOString(),
): ProductFacts | undefined {
  const title = nonEmpty(extractMeta(html, "og:title", "property"));
  const description = cleanDescription(extractMeta(html, "og:description", "property"));

  const amount =
    nonEmpty(extractMeta(html, "product:price:amount", "property")) ??
    nonEmpty(extractMeta(html, "og:price:amount", "property"));
  const currency =
    nonEmpty(extractMeta(html, "product:price:currency", "property")) ??
    nonEmpty(extractMeta(html, "og:price:currency", "property"));

  const price: ProductFactsPrice | undefined = amount ? { amount, currency: currency ?? "unknown" } : undefined;

  const partial: Omit<ProductFacts, "sourceUrl" | "fetchedAt" | "source" | "completeness"> = {
    title,
    description,
    brand: undefined,
    price,
    availability: undefined,
  };
  if (isFactsEmpty(partial)) return undefined;

  return {
    ...partial,
    sourceUrl:    pageUrl,
    fetchedAt:    now,
    source:       "og_meta",
    completeness: "partial",
  };
}

// ── Merge ─────────────────────────────────────────────────────────────────────

const SOURCE_PRIORITY: ProductFactsSource[] = ["shopify_json", "jsonld", "woocommerce", "og_meta", "manual"];

/**
 * Merges facts from multiple extraction attempts on the same page, in priority
 * order shopify_json > jsonld > woocommerce > og_meta. Field-by-field: first
 * defined value wins. `source` reflects whichever part actually contributed at
 * least one field (not necessarily the highest-priority part, if that part was
 * itself undefined/empty). Returns undefined if no part has any content.
 */
export function mergeFacts(parts: Array<ProductFacts | undefined>): ProductFacts | undefined {
  const defined = parts.filter((p): p is ProductFacts => !!p);
  if (!defined.length) return undefined;

  const sorted = [...defined].sort(
    (a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source),
  );

  let title: string | undefined;
  let description: string | undefined;
  let brand: string | undefined;
  let price: ProductFactsPrice | undefined;
  let availability: ProductFactsAvailability | undefined;
  let contributingSource: ProductFactsSource | undefined;
  let sourceUrl = sorted[0].sourceUrl;
  let fetchedAt = sorted[0].fetchedAt;

  for (const part of sorted) {
    if (title === undefined && part.title !== undefined) { title = part.title; contributingSource ??= part.source; }
    if (description === undefined && part.description !== undefined) { description = part.description; contributingSource ??= part.source; }
    if (brand === undefined && part.brand !== undefined) { brand = part.brand; contributingSource ??= part.source; }
    if (price === undefined && part.price !== undefined) { price = part.price; contributingSource ??= part.source; }
    if (availability === undefined && part.availability !== undefined) { availability = part.availability; contributingSource ??= part.source; }
  }

  if (!contributingSource) return undefined;

  const merged: Omit<ProductFacts, "sourceUrl" | "fetchedAt" | "source" | "completeness"> = {
    title, description, brand, price, availability,
  };

  return {
    ...merged,
    sourceUrl,
    fetchedAt,
    source:       contributingSource,
    completeness: completenessOf(merged),
  };
}

/** Fills `images` (same list as finalized candidates, capped at 8) on an existing facts object. */
export function withFactsImages(facts: ProductFacts | undefined, images: string[]): ProductFacts | undefined {
  if (!facts) return undefined;
  const capped = images.slice(0, 8);
  if (!capped.length) return facts;
  return { ...facts, images: capped };
}
