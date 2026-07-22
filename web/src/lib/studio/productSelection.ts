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
function safePublicUrl(url: string | undefined | null): string | undefined {
  const v = (url ?? "").trim();
  if (!v) return undefined;
  if (/^(javascript|data|blob|file):/i.test(v)) return undefined;
  // Shopify Admin URLs are internal — they 404 for visitors and leak the store's
  // back office. The storefront URL is the only valid destination.
  if (/^https?:\/\/admin\.shopify\.com\//i.test(v)) return undefined;
  if (!/^https?:\/\//i.test(v)) return undefined;
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
}): CanonicalProductSelection {
  return {
    id: asset.id,
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
    productId: selection.id,
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
