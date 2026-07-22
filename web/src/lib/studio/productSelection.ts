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
/** Loopback / private / link-local IPv4, in dotted form. */
function isNonPublicIpv4(h: string): boolean {
  if (h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;                       // loopback
  if (/^10\./.test(h)) return true;                        // private class A
  if (/^192\.168\./.test(h)) return true;                  // private class C
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;   // private class B
  if (/^169\.254\./.test(h)) return true;                  // link-local
  return false;
}

function isNonPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (isNonPublicIpv4(h)) return true;

  // IPv6. URL.hostname keeps the brackets, so strip them before classifying —
  // checking only the literal "::1" let fe80::/fc00::/fd00:: through as "public".
  const v6 = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (!v6.includes(":")) return false;
  if (v6 === "::1" || v6 === "::") return true;            // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;          // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;          // fc00::/7 unique-local
  // An IPv6 address can WRAP a private IPv4 in several ways, and the URL parser
  // normalises any dotted quad to hex ("::ffff:127.0.0.1" arrives as "::ffff:7f00:1").
  // Matching each textual variant with its own regex kept missing new ones
  // (::ffff:0:a.b.c.d translated, 64:ff9b:: NAT64, 2001:0::/32 Teredo), so decode the
  // address into its eight 16-bit groups once and inspect the embedded IPv4 directly.
  const groups = expandIpv6(v6);
  if (groups) {
    const hexPairToDotted = (hi: number, lo: number) =>
      `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    // The LAST two groups carry the embedded IPv4 for every mapped/compatible/
    // translated/NAT64 form; 6to4 carries it in groups 1-2 instead.
    const tail = hexPairToDotted(groups[6], groups[7]);
    // Every wrapper form leaves the first four groups zero; groups 4-5 vary by form
    // (0:0 compatible, 0:ffff mapped, ffff:0 translated), so only the leading zeros
    // are load-bearing. Checking five leading zeros missed ::ffff:0:a.b.c.d.
    const isWrapper =
      groups.slice(0, 4).every(g => g === 0) ||                        // ::x:x, ::ffff:x:x, ::ffff:0:x:x
      (groups[0] === 0x64 && groups[1] === 0xff9b) ||                  // 64:ff9b::/96 NAT64
      (groups[0] === 0x2001 && groups[1] === 0);                       // 2001:0::/32 Teredo
    if (isWrapper && isNonPublicIpv4(tail)) return true;
    if (groups[0] === 0x2002 && isNonPublicIpv4(hexPairToDotted(groups[1], groups[2]))) return true; // 6to4
  }

  return false;
}

/** Expand a (possibly `::`-compressed) IPv6 literal into eight 16-bit groups. */
function expandIpv6(addr: string): number[] | null {
  if (!addr.includes(":")) return null;
  // A trailing dotted quad ("::ffff:127.0.0.1") becomes two hex groups.
  const dotted = addr.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let text = addr;
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    if (o.some(n => Number.isNaN(n) || n > 255)) return null;
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail, ...extra] = text.split("::");
  if (extra.length) return null; // more than one "::" is invalid
  const parse = (s: string) => (s ? s.split(":").filter(Boolean).map(g => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  const fill = 8 - left.length - right.length;
  if (tail === undefined) return left.length === 8 ? left : null;
  if (fill < 0) return null;
  return [...left, ...Array(fill).fill(0), ...right];
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
