/**
 * pinAffiliateInheritance.ts — Pure mappers that let a Pin inherit a creator's
 * affiliate product link, and that preserve that context across Regenerate.
 *
 * Invariants (match existing Product/Destination URL rules):
 *  - destinationUrl belongs to the Pin; the affiliate URL only FILLS an empty one.
 *  - A manual destinationUrl is NEVER overwritten.
 *  - A custom (non-creator) destinationUrl is NEVER overwritten.
 *  - The product image reference survives generation and regeneration.
 */

import type { CreatorProductLink, AffiliateProductInput } from "./creatorProductLink";

/** Marker written when the affiliate product link fills the destination URL. */
export const CREATOR_AFFILIATE_SOURCE = "creator_affiliate_product";
/** Marker written when the user typed/edited the destination URL by hand. */
export const MANUAL_DESTINATION_SOURCE = "manual";

/** Structural affiliate-context fields carried on a Pin draft / generated Pin. */
export type AffiliatePinFields = {
  productId?: string;
  creatorProductLinkId?: string;
  /** Stable reference to the product image so it survives (re)generation. */
  sourceProductImageUrl?: string;
  destinationUrl?: string;
  destinationUrlSource?: string;
};

function productImageOf(product: AffiliateProductInput): string {
  return (product.imageUrl ?? "").trim();
}

function productIdOf(product: AffiliateProductInput): string {
  return (product.productId ?? product.id ?? "").trim();
}

/**
 * Stamp a Pin draft with product identity + the creator affiliate link, filling
 * an empty destination URL only. Returns a new object; never mutates the input.
 */
export function applyCreatorProductLinkToPinDraft<T extends AffiliatePinFields>(
  pinDraft: T,
  product: AffiliateProductInput,
  creatorProductLink: CreatorProductLink,
): T {
  const next: T = { ...pinDraft };

  // Product identity + link reference always attach.
  next.productId = productIdOf(product) || creatorProductLink.productId || pinDraft.productId;
  next.creatorProductLinkId = creatorProductLink.id;

  // Preserve an already-attached product image; otherwise capture this product's.
  next.sourceProductImageUrl = (pinDraft.sourceProductImageUrl ?? "").trim() || productImageOf(product) || undefined;

  const currentUrl = (pinDraft.destinationUrl ?? "").trim();
  const currentSource = pinDraft.destinationUrlSource;
  const sourceIsManual = currentSource === MANUAL_DESTINATION_SOURCE;
  const sourceIsOurs = currentSource === CREATOR_AFFILIATE_SOURCE;

  // Fill the destination only when the link is ready AND the existing URL is either
  // empty or one we previously set ourselves. Manual / custom URLs are untouched.
  const canFill =
    creatorProductLink.status === "ready" &&
    !!creatorProductLink.affiliateUrl &&
    !sourceIsManual &&
    (currentUrl === "" || sourceIsOurs);

  if (canFill) {
    next.destinationUrl = creatorProductLink.affiliateUrl;
    next.destinationUrlSource = CREATOR_AFFILIATE_SOURCE;
  }

  return next;
}

/**
 * Carry affiliate + product context from the previous Pin onto a regenerated Pin.
 *
 * Regenerate MAY refresh imageUrl/title/description/altText (left to the caller),
 * but it MUST NOT drop product identity or the affiliate destination. A manual
 * destination URL set on the previous Pin is preserved verbatim.
 */
export function preserveAffiliateContextOnRegenerate<T extends AffiliatePinFields>(
  previous: AffiliatePinFields | null | undefined,
  regenerated: T,
): T {
  if (!previous) return regenerated;
  return {
    ...regenerated,
    productId: previous.productId ?? regenerated.productId,
    creatorProductLinkId: previous.creatorProductLinkId ?? regenerated.creatorProductLinkId,
    sourceProductImageUrl: previous.sourceProductImageUrl ?? regenerated.sourceProductImageUrl,
    // Destination context is owned by the Pin, not the freshly generated image —
    // always restore the previous values (covers manual + creator-affiliate URLs).
    destinationUrl: (previous.destinationUrl ?? "").trim()
      ? previous.destinationUrl
      : regenerated.destinationUrl,
    destinationUrlSource: (previous.destinationUrl ?? "").trim()
      ? previous.destinationUrlSource
      : regenerated.destinationUrlSource,
  };
}
