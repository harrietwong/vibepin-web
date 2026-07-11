/**
 * productPreview.ts — pure helpers for the Create Pins product preview + Amazon
 * picker. No network, no React. Turns a saved product asset into the minimal
 * shape the hover/click preview needs (image, title, source label, ASIN).
 */

import type { AssetItem } from "@/lib/assetStore";
import { isAmazonProductAsset, productDisplayTitle, productSourceLabel } from "@/lib/myProductsPicker";
import { extractAsin } from "@/lib/affiliate/amazon";

export type PreviewProduct = {
  imageUrl?:   string;
  title:       string;
  /** User-facing source: "Amazon" / "Product Ideas" / "Uploaded" / "URL Imported" / "Recent". */
  sourceLabel: string;
  /** Amazon ASIN when this is an Amazon product and one can be parsed; else null. */
  asin:        string | null;
  productUrl?: string;
};

/** Source label for the preview. Amazon products always read "Amazon". */
export function previewSourceLabel(item: AssetItem): string {
  if (isAmazonProductAsset(item)) return "Amazon";
  return productSourceLabel(item);
}

/** Best-effort ASIN from any URL-ish field on the asset. Never invents one. */
export function asinForAsset(item: AssetItem): string | null {
  return (
    extractAsin(item.productUrl) ??
    extractAsin(item.canonicalUrl) ??
    extractAsin(item.sourceUrl) ??
    null
  );
}

export function toPreviewProduct(item: AssetItem): PreviewProduct {
  const amazon = isAmazonProductAsset(item);
  return {
    imageUrl:    item.imageUrl,
    title:       productDisplayTitle(item),
    sourceLabel: amazon ? "Amazon" : productSourceLabel(item),
    asin:        amazon ? asinForAsset(item) : null,
    productUrl:  item.productUrl ?? item.sourceUrl,
  };
}
