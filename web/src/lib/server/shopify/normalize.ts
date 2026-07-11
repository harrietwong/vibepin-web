/**
 * Pure GraphQL → row normalisation for the Shopify sync engine (server-only, WP3).
 *
 * No I/O, no clock, no DB — every function is deterministic so the whole mapping
 * matrix (§B) is unit-testable in isolation. The output is a productStore
 * `ProductUpsertInput` (parent row + image/variant child rows) ready for
 * upsertProductsBatch.
 *
 * Rules (§3.4 / §4.2 / task B):
 *   - external ids   = numeric tail of the Shopify GID
 *   - descriptionText = descriptionHtml stripped to plain text (entities decoded,
 *                       whitespace collapsed, capped at 5000 chars)
 *   - product_url    = onlineStoreUrl ?? https://{primaryDomain ?? shopDomain}/products/{handle}
 *   - status         = ACTIVE|DRAFT|ARCHIVED → active|draft|archived
 *   - availability   = active + any variant availableForSale → in_stock
 *                      active + none                         → out_of_stock
 *                      otherwise                             → unknown
 *   - price/compareAt = first variant, falling back to priceRangeV2 minimum
 *   - raw_source     = the complete node (raw_source_saved_at is stamped by the store)
 */

import type {
  ProductImageInput,
  ProductUpsertInput,
  ProductVariantInput,
  StoreProductAvailability,
} from "./productStore";

const MAX_DESCRIPTION_CHARS = 5000;

// ── GraphQL node shapes (subset of the sync query selection) ───────────────────

type MoneyV2 = { amount?: string | null; currencyCode?: string | null };

export type ShopifyImageNode = {
  id?: string | null;
  url?: string | null;
  width?: number | null;
  height?: number | null;
  altText?: string | null;
};

export type ShopifyVariantNode = {
  id?: string | null;
  title?: string | null;
  price?: string | null;
  sku?: string | null;
  availableForSale?: boolean | null;
  compareAtPrice?: string | null;
  image?: { id?: string | null } | null;
};

export type ShopifyProductNode = {
  id?: string | null;
  handle?: string | null;
  title?: string | null;
  descriptionHtml?: string | null;
  status?: string | null;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  onlineStoreUrl?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  priceRangeV2?: {
    minVariantPrice?: MoneyV2 | null;
    maxVariantPrice?: MoneyV2 | null;
  } | null;
  featuredImage?: ShopifyImageNode | null;
  images?: { edges?: Array<{ node?: ShopifyImageNode | null } | null> | null } | null;
  variants?: { edges?: Array<{ node?: ShopifyVariantNode | null } | null> | null } | null;
};

export type NormalizeContext = {
  /** Canonical `*.myshopify.com` host (product_url fallback + admin URL derivation). */
  shopDomain: string;
  /** Storefront host from `shop.primaryDomain.host`, when known. */
  primaryDomain?: string | null;
  /** Shop currency fallback when a product exposes no priceRangeV2 currency. */
  shopCurrency?: string | null;
};

// ── Primitive helpers ──────────────────────────────────────────────────────────

/** Numeric tail of a Shopify GID, e.g. "gid://shopify/Product/123?x=1" → "123". */
export function gidToId(gid: string | null | undefined): string {
  if (!gid) return "";
  const tail = String(gid).split("/").pop() ?? String(gid);
  return tail.split("?")[0];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Strip HTML to plain text: drop script/style bodies, turn remaining tags into
 * spaces, decode entities, collapse whitespace, truncate. Empty → null.
 */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  let text = String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  text = decodeEntities(text)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > MAX_DESCRIPTION_CHARS) text = text.slice(0, MAX_DESCRIPTION_CHARS);
  return text.length > 0 ? text : null;
}

function parseMoney(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function mapStatus(status: string | null | undefined): "active" | "draft" | "archived" {
  switch (String(status ?? "").toUpperCase()) {
    case "DRAFT":
      return "draft";
    case "ARCHIVED":
      return "archived";
    case "ACTIVE":
      return "active";
    default:
      return "active";
  }
}

function flattenEdges<T>(
  conn: { edges?: Array<{ node?: T | null } | null> | null } | null | undefined,
): NonNullable<T>[] {
  return (conn?.edges ?? [])
    .map((e) => e?.node)
    .filter((n): n is NonNullable<T> => n != null);
}

// ── Main mapping ────────────────────────────────────────────────────────────────

/** GraphQL product node → productStore upsert input (parent + image/variant children). */
export function normalizeProduct(node: ShopifyProductNode, ctx: NormalizeContext): ProductUpsertInput {
  const externalProductId = gidToId(node.id);
  const handle = node.handle ?? null;
  const status = mapStatus(node.status);

  const variantNodes = flattenEdges<ShopifyVariantNode>(node.variants);
  const imageNodes = flattenEdges<ShopifyImageNode>(node.images);
  // featuredImage acts as the primary when the images connection is empty.
  const effectiveImageNodes =
    imageNodes.length > 0 ? imageNodes : node.featuredImage ? [node.featuredImage] : [];

  // ── product_url three-level fallback ────────────────────────────────────────
  let productUrl: string | null = node.onlineStoreUrl ?? null;
  if (!productUrl && handle) {
    const host = ctx.primaryDomain?.trim() || ctx.shopDomain;
    productUrl = `https://${host}/products/${handle}`;
  }

  // ── price / compareAt / currency ────────────────────────────────────────────
  const firstVariant = variantNodes[0];
  const minPrice = node.priceRangeV2?.minVariantPrice;
  const priceAmount = parseMoney(firstVariant?.price) ?? parseMoney(minPrice?.amount);
  const compareAtPrice = parseMoney(firstVariant?.compareAtPrice);
  const currency = minPrice?.currencyCode ?? ctx.shopCurrency ?? null;

  // ── availability derivation ─────────────────────────────────────────────────
  let availability: StoreProductAvailability = "unknown";
  if (status === "active") {
    availability = variantNodes.some((v) => v.availableForSale === true) ? "in_stock" : "out_of_stock";
  }

  // ── image child rows (with variant association) ─────────────────────────────
  const images: ProductImageInput[] = [];
  effectiveImageNodes.forEach((img, index) => {
    if (!img?.url) return; // source_image_url is NOT NULL — skip urless images
    const externalImageId = gidToId(img.id);
    const variantExternalIds = variantNodes
      .filter((v) => v.image?.id && gidToId(v.image.id) === externalImageId)
      .map((v) => gidToId(v.id))
      .filter(Boolean);
    images.push({
      externalImageId,
      sourceImageUrl: img.url,
      width: img.width ?? null,
      height: img.height ?? null,
      altText: img.altText ?? null,
      position: index,
      variantExternalIds,
    });
  });

  const primaryImageUrl = node.featuredImage?.url ?? images[0]?.sourceImageUrl ?? null;

  // ── variant child rows ──────────────────────────────────────────────────────
  const variants: ProductVariantInput[] = variantNodes.map((v, index) => ({
    externalVariantId: gidToId(v.id),
    title: v.title ?? null,
    priceAmount: parseMoney(v.price),
    sku: v.sku ?? null,
    availableForSale: v.availableForSale ?? null,
    externalImageId: v.image?.id ? gidToId(v.image.id) : null,
    position: index,
  }));

  return {
    externalProductId,
    title: node.title ?? "",
    handle,
    descriptionText: htmlToText(node.descriptionHtml),
    productUrl,
    status,
    vendor: node.vendor ?? null,
    productType: node.productType ?? null,
    tags: node.tags ?? [],
    priceAmount,
    compareAtPrice,
    currency,
    availability,
    primaryImageUrl,
    createdAtSource: node.createdAt ?? null,
    updatedAtSource: node.updatedAt ?? null,
    rawSource: node,
    images,
    variants,
  };
}
