/**
 * affiliateContext.ts — resolve the creator's Amazon affiliate context for a
 * Create Pins session from the currently selected product snapshots.
 *
 * Pure-ish: the only side effect is persisting a CreatorProductLink via the repo
 * (idempotent / deduped). Used by the Studio "locked product context" bar and by
 * the generated-pin inheritance step.
 */

import {
  getOrCreateCreatorProductLink,
  type AffiliateProductInput,
  type CreatorProductLink,
  type CreatorProductLinkRepo,
} from "@/lib/affiliate/creatorProductLink";
import { looksLikeAmazon } from "@/lib/affiliate/amazon";
import type { AmazonAffiliateSettings } from "@/lib/affiliate/amazonAffiliateSettings";

/** Minimal product snapshot shape this resolver understands. */
export type AffiliateProductSnapshotLike = {
  productId?:    string;
  title?:        string;
  imageUrl?:     string | null;
  productUrl?:   string;
  canonicalUrl?: string;
  source?:       string;
  sourceDomain?: string;
  store?:        string;
};

export type StudioAffiliateProduct = {
  productId?: string;
  title?:     string;
  imageUrl?:  string | null;
  productUrl?: string;
};

export type StudioAffiliateContext = {
  product: StudioAffiliateProduct;
  link:    CreatorProductLink;
};

/** Heuristic: is this product an Amazon product? (provider/url/domain hints) */
export function isAmazonProductSnapshot(p: AffiliateProductSnapshotLike): boolean {
  return looksLikeAmazon({
    productUrl:   p.productUrl,
    canonicalUrl: p.canonicalUrl,
    sourceDomain: p.sourceDomain,
    store:        p.store,
    merchant:     p.source,
  });
}

function toInput(p: AffiliateProductSnapshotLike): AffiliateProductInput {
  return {
    id:           p.productId,
    productId:    p.productId,
    provider:     isAmazonProductSnapshot(p) ? "amazon" : undefined,
    productUrl:   p.productUrl,
    canonicalUrl: p.canonicalUrl,
    imageUrl:     p.imageUrl,
  };
}

/**
 * Resolve the first Amazon product's affiliate context from a selection.
 * Returns null when no Amazon product is selected. When an Amazon product is
 * found, returns its link regardless of status (ready / needs_setup / failed) so
 * the UI can show the right message.
 */
export function resolveStudioAffiliateContext(
  products: AffiliateProductSnapshotLike[],
  settings: AmazonAffiliateSettings | null | undefined,
  repo?: CreatorProductLinkRepo,
): StudioAffiliateContext | null {
  for (const p of products) {
    if (!isAmazonProductSnapshot(p)) continue;
    const link = getOrCreateCreatorProductLink(toInput(p), settings, repo);
    if (!link) continue;
    return {
      product: { productId: p.productId, title: p.title, imageUrl: p.imageUrl, productUrl: p.productUrl },
      link,
    };
  }
  return null;
}
