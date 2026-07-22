/**
 * The single Product selection shape shared by every picker entry point.
 *
 * Before this module the three paths disagreed:
 *   - ProductPickerModal returned a rich `ProductSelection` (canonicalUrl, price,
 *     store, asPrimary…) used by Link/Change product;
 *   - InlineCreateAssetPicker returned `InlineAssetItem[]`, and AiVersionDrawer
 *     reduced it to `items.map(i => i.imageUrl)` — dropping the product URL, store
 *     and commerce identifiers entirely. That is why selecting a product in the AI
 *     drawer could never populate the Website URL: the URL was discarded at the
 *     picker boundary, not missing from the data.
 *
 * `LinkedProduct` (lib/pinMetadata) is already the canonical PERSISTED record, so
 * this module deliberately does not invent a third shape — it defines the transport
 * type the pickers emit and the lossless mapping onto LinkedProduct.
 *
 * Affiliate links stay out of this path: creatorProductLink is only for products
 * that genuinely carry an affiliate destination (see lib/affiliate/*). An ordinary
 * product selection writes a LinkedProduct and nothing else.
 */

import { normalizeProductSource, type LinkedProduct, type ProductSourceKind } from "@/lib/pinMetadata";

export type ProductSelectionSource = ProductSourceKind;

/**
 * What a picker hands back. Everything except `title` is optional because real
 * sources genuinely lack fields (a Product Idea often has no public URL, a manual
 * product has no store) — absent is honest, empty-string is not.
 */
export type CanonicalProductSelection = {
  /** Stable id: server product id where one exists, else the local asset id. */
  id?: string;
  title: string;
  imageUrl?: string;
  /** The public, user-facing product page. NEVER a Shopify Admin URL. */
  publicUrl?: string;
  /** Canonical/storefront URL when the source distinguishes it from publicUrl. */
  canonicalUrl?: string;
  source: ProductSelectionSource;
  store?: string;
  price?: string;
  currency?: string;
  /** Commerce identifiers (e.g. Shopify product/variant id, ASIN). */
  commerceIds?: Record<string, string>;
  /** Whether this becomes the Pin's primary product. */
  asPrimary?: boolean;
  status?: "ready" | "import_issue" | "incomplete";
  // ── Recommendation context (honest passthrough) ────────────────────────────
  // Carried so the drawer can request product-level recommendations WITHOUT
  // re-reading the asset store. Each is undefined when the source genuinely lacks
  // it — never inferred or fabricated.
  category?: string;
  productType?: string;
  tags?: string[];
  keyword?: string;
  visualFormat?: string;
};

/** A `javascript:`/`data:` URL must never reach a Pin's destination field. */
/**
 * Hosts that can never be a public Pin destination: loopback, link-local, and the
 * RFC1918 private ranges. A Pin published with one of these sends every visitor to
 * their own machine or nowhere at all.
 */
function isNonPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (/^127\./.test(h)) return true;                       // loopback
  if (/^10\./.test(h)) return true;                        // private class A
  if (/^192\.168\./.test(h)) return true;                  // private class C
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;   // private class B
  if (/^169\.254\./.test(h)) return true;                  // link-local
  return false;
}

function safePublicUrl(url: string | undefined | null): string | undefined {
  const v = (url ?? "").trim();
  if (!v) return undefined;
  if (/^(javascript|data|blob|file):/i.test(v)) return undefined;
  if (!/^https?:\/\//i.test(v)) return undefined;
  // Whitespace inside a URL means it was never a single valid URL.
  if (/\s/.test(v)) return undefined;

  let parsed: URL;
  try { parsed = new URL(v); } catch { return undefined; } // malformed
  if (!parsed.hostname) return undefined;
  // IPv6 literals are bracketed and contain colons, not dots — requiring a dot
  // rejected every public IPv6 destination. Validate them by shape instead.
  const isIpv6Literal = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  // A dotless, non-IPv6 hostname is not a routable public host (e.g. "https://x").
  if (!isIpv6Literal && !parsed.hostname.includes(".") && parsed.hostname !== "localhost") return undefined;
  if (isNonPublicHost(parsed.hostname)) return undefined;
  // Shopify Admin URLs are internal — they 404 for visitors and leak the store's
  // back office. The storefront URL is the only valid destination.
  if (parsed.hostname.toLowerCase() === "admin.shopify.com") return undefined;

  return v;
}

/**
 * The product's public destination, in source-priority order:
 *   Shopify      → canonical/storefront URL (never Admin)
 *   URL import   → the imported URL
 *   Manual       → the manually entered URL
 *   Product Idea → its public/affiliate URL when the record has one, else nothing
 *
 * Returns undefined rather than a guess when no valid public URL exists — the
 * caller leaves Website URL empty instead of inventing one.
 */
export function resolveProductPublicUrl(selection: CanonicalProductSelection): string | undefined {
  if (selection.source === "shopify") {
    return safePublicUrl(selection.canonicalUrl) ?? safePublicUrl(selection.publicUrl);
  }
  return safePublicUrl(selection.publicUrl) ?? safePublicUrl(selection.canonicalUrl);
}

/** Build a selection from a stored asset record (My Products / uploads / URL imports). */
export function selectionFromAsset(asset: {
  id?: string;
  title?: string;
  imageUrl?: string;
  productUrl?: string;
  canonicalUrl?: string;
  sourceUrl?: string;
  source?: string;
  store?: string;
  sourceDomain?: string;
  price?: string;
  currency?: string;
  status?: "ready" | "import_issue";
  category?: string;
  productType?: string;
  keyword?: string;
  visualFormat?: string;
  tags?: string[];
  shopifyProductId?: string;
}): CanonicalProductSelection {
  return {
    id: asset.id,
    // The SERVER commerce id, kept separate from the local asset id above.
    commerceIds: asset.shopifyProductId ? { shopify: asset.shopifyProductId } : undefined,
    title: (asset.title ?? "").trim(),
    imageUrl: asset.imageUrl,
    publicUrl: asset.productUrl ?? asset.sourceUrl,
    canonicalUrl: asset.canonicalUrl,
    source: normalizeProductSource(asset.source),
    store: asset.store ?? asset.sourceDomain,
    price: asset.price,
    currency: asset.currency,
    status: asset.status,
    // Recommendation context — passed through only when present.
    category: asset.category || undefined,
    productType: asset.productType || undefined,
    keyword: asset.keyword || undefined,
    visualFormat: asset.visualFormat || undefined,
    tags: asset.tags && asset.tags.length ? asset.tags : undefined,
  };
}

/**
 * Map onto the canonical persisted record.
 *
 * NOTE: `linkType` is "auto" | "manual" — it records HOW the product was linked
 * (auto-detected vs chosen by the user), NOT whether it is primary. Primary is
 * decided by primaryProductId / list position via writePinProducts(). A picker
 * selection is by definition user-chosen, hence "manual"; `asPrimary` is carried
 * separately on the selection and applied by the caller.
 */
export function toLinkedProduct(selection: CanonicalProductSelection): LinkedProduct {
  return {
    // Prefer the SERVER commerce id: a LinkedProduct that stores the local asset id
    // cannot be matched back to the merchant's catalogue. Falls back to the local id
    // for sources that genuinely have no server-side record (uploads, manual).
    productId: selection.commerceIds?.shopify ?? selection.id,
    title: selection.title,
    imageUrl: selection.imageUrl,
    productUrl: resolveProductPublicUrl(selection),
    canonicalUrl: selection.canonicalUrl,
    store: selection.store,
    price: selection.price,
    currency: selection.currency,
    source: selection.source,
    linkType: "manual",
    status: selection.status,
  };
}

/**
 * Round-trip a persisted LinkedProduct back into a selection (Change product).
 * `asPrimary` is intentionally NOT derived from linkType — the caller knows which
 * product is primary from primaryProductId and passes it in if it matters.
 */
export function selectionFromLinkedProduct(product: LinkedProduct): CanonicalProductSelection {
  return {
    id: product.productId,
    title: product.title,
    imageUrl: product.imageUrl,
    publicUrl: product.productUrl,
    canonicalUrl: product.canonicalUrl,
    source: product.source,
    store: product.store,
    price: product.price,
    currency: product.currency,
    status: product.status,
  };
}
