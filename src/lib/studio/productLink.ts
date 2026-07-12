/**
 * productLink.ts — source-agnostic product-link display logic.
 *
 * One canonical rule used by single Pin Edit + Batch Edit so Amazon and
 * non-Amazon products both show a link. Amazon is only a *source badge*; the
 * affiliate URL is chosen at this normalization layer, not via a special UI.
 *
 *   Amazon + affiliateUrl → affiliateUrl, labeled "Affiliate link"
 *   else productUrl        → productUrl,   labeled "Product link"
 *   else                   → null,         labeled "No product link"
 */

import { isAmazonUrl } from "@/lib/affiliate/amazon";

export type ProductLinkLabel = "Affiliate link" | "Product link" | "No product link";

export type ProductLinkDisplay = {
  url:         string | null;
  label:       ProductLinkLabel;
  isAffiliate: boolean;
};

export type ProductLinkInput = {
  productUrl?:   string | null;
  canonicalUrl?: string | null;
  source?:       string | null;
  store?:        string | null;
};

/** Amazon detection from source text or any product URL. */
export function isAmazonProduct(p: ProductLinkInput | null | undefined): boolean {
  if (!p) return false;
  const text = `${p.source ?? ""} ${p.store ?? ""}`.toLowerCase();
  if (/amazon|amzn/.test(text)) return true;
  return isAmazonUrl(p.productUrl) || isAmazonUrl(p.canonicalUrl);
}

/**
 * Resolve the link a product row should display + its neutral label.
 * `affiliateUrl` is the creator's affiliate URL for this product when one exists.
 */
export function resolveProductLinkDisplay(
  p: ProductLinkInput | null | undefined,
  affiliateUrl?: string | null,
): ProductLinkDisplay {
  const aff = (affiliateUrl ?? "").trim();
  if (isAmazonProduct(p) && aff) {
    return { url: aff, label: "Affiliate link", isAffiliate: true };
  }
  const url = ((p?.productUrl ?? p?.canonicalUrl) ?? "").trim();
  if (url) return { url, label: "Product link", isAffiliate: false };
  return { url: null, label: "No product link", isAffiliate: false };
}

/** Short display domain for a URL (e.g. "amazon.com"). */
export function linkDomain(url: string | null | undefined): string {
  const u = (url ?? "").trim();
  if (!u) return "";
  try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, ""); }
  catch { return u.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; }
}
