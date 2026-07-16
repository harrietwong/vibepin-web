// Product Opportunity image provenance — PRD v3.1 §7.1 / §7.4 / §4②.
//
// ONE rule, enforced structurally rather than by convention:
//
//     A Pinterest-hosted image (i.pinimg.com) is PINTEREST imagery.
//     It is NEVER a merchant product photo.
//
// WHY THIS MODULE EXISTS
// ---------------------
// `pin_products.image_url` is DECLARED as the product image (v45 column comment), but
// the live corpus contradicts the declaration. Probed read-only 2026-07-14 over the
// 2,795 active rows:
//
//     discovery_method='stl'           image_url host: i.pinimg.com  2654 / 2676
//     discovery_method='outbound_link' image_url host: merchant CDN   108 /  119
//
// Sampled against pin_samples, 144 of those STL image_urls are byte-identical to their
// parent Pin's image and 154 product_names are byte-identical to their parent Pin's
// title — the exact T10 signature (Pin image written into the product-image column;
// Pin title written into product_name). The remainder are STL sub-card pinimg assets:
// still Pinterest-hosted, still not a merchant product photo.
//
// So the STL corpus's `image_url` is Pinterest imagery mis-filed in a product column.
// This module reads it back as what it actually IS, and hard-quarantines it out of the
// product-image slot. That resolves the apparent conflict between v3.1 §7.4 ("card main
// image = Source Pin Image") and the fact that the dedicated `source_pin_image_url`
// column is populated on only 119/2795 rows: the pin imagery was there all along, under
// the wrong name.
//
// This is a READ-SIDE reclassification only. It writes nothing and changes no schema.
// The fix at the source (a backfill moving these values into source_pin_image_url and
// NULLing image_url) is a separate, approval-gated data task.

/** Hosts that serve Pinterest's own CDN imagery. */
const PINTEREST_IMAGE_HOSTS = ["i.pinimg.com", "pinimg.com"];

/**
 * True when the URL is served from Pinterest's image CDN.
 *
 * Used as a hard gate on the product-image slot: v3.1 §4② permanently forbids a pinimg
 * URL from ever standing in as `product_image_url`, no matter which column it arrived in.
 */
export function isPinterestHostedImage(url: string | null | undefined): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  return PINTEREST_IMAGE_HOSTS.some(h => u.includes(h));
}

export interface ProductImageProvenanceInput {
  /** v45 column — the source Pin's image. Authoritative when present. */
  source_pin_image_url?: string | null;
  /** Declared as the product image; on the STL corpus it actually holds pin imagery. */
  image_url?: string | null;
  /** v48 four-state enrichment outcome. NULL on legacy rows. */
  detail_fetch_status?: string | null;
}

export interface ProductImageProvenance {
  /** The card's MAIN image (v3.1 §7.4). Pinterest content evidence. */
  sourcePinImageUrl: string | null;
  /** OPTIONAL secondary/enrichment thumb (v3.1 §7.2). NEVER the main image. */
  productImageUrl: string | null;
}

/**
 * Split a row's image fields into the two provenance-separated slots the card renders.
 *
 * Main image (Source Pin Image), in precedence order:
 *   1. `source_pin_image_url` — the dedicated v45 column (outbound_link rows).
 *   2. `image_url` **iff it is Pinterest-hosted** — the STL corpus, reclassified. This is
 *      a re-reading of existing data, not a fabrication: the bytes at that URL genuinely
 *      are the Pin's image.
 *   3. NULL.
 *
 * Product image (optional enhancement only):
 *   `image_url` **iff** it is NOT Pinterest-hosted AND the detail fetch actually
 *   succeeded (`detail_fetch_status='available'`, or a legacy row that predates the
 *   column). A pinimg URL can never reach this slot — that is the whole point.
 *
 * The two slots are never allowed to hold the same URL, so the card can never present
 * Pinterest imagery as a merchant product photo.
 */
export function deriveProductImageProvenance(
  row: ProductImageProvenanceInput,
): ProductImageProvenance {
  const imageUrl = row.image_url?.trim() || null;
  const dedicated = row.source_pin_image_url?.trim() || null;
  const imageIsPinterest = isPinterestHostedImage(imageUrl);

  // MAIN: the dedicated column wins; otherwise a Pinterest-hosted image_url IS the pin image.
  const sourcePinImageUrl = dedicated ?? (imageIsPinterest ? imageUrl : null);

  // OPTIONAL: a merchant-CDN image_url, and only when a merchant page was really read.
  // detail_fetch_status is NULL on rows that predate enrichment tracking; those rows'
  // non-pinimg image_url was written by the STL/legacy writer from the merchant side,
  // so it is admissible. Every non-'available' recorded state means NO page was read →
  // any image there would be a guess → NULL.
  const detailsWereRead =
    row.detail_fetch_status === "available" || row.detail_fetch_status == null;
  const productImageUrl =
    imageUrl && !imageIsPinterest && detailsWereRead ? imageUrl : null;

  return { sourcePinImageUrl, productImageUrl };
}
