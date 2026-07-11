/**
 * amazon.ts — Pure Amazon affiliate URL helpers (no network, no PA-API).
 *
 * MVP scope: build a stable, creator-owned affiliate destination URL from an
 * ASIN + marketplace + the creator's own tracking (associate) tag. We never
 * scrape Amazon, never call PA-API, and never preserve another user's tag.
 */

export type AmazonMarketplace =
  | "US" | "UK" | "CA" | "DE" | "FR" | "IT" | "ES" | "AU" | "JP";

/** Marketplace → Amazon host. Used to build canonical + affiliate URLs. */
export const AMAZON_MARKETPLACE_DOMAINS: Record<AmazonMarketplace, string> = {
  US: "www.amazon.com",
  UK: "www.amazon.co.uk",
  CA: "www.amazon.ca",
  DE: "www.amazon.de",
  FR: "www.amazon.fr",
  IT: "www.amazon.it",
  ES: "www.amazon.es",
  AU: "www.amazon.com.au",
  JP: "www.amazon.co.jp",
};

export const AMAZON_MARKETPLACES = Object.keys(AMAZON_MARKETPLACE_DOMAINS) as AmazonMarketplace[];

/** An ASIN is exactly 10 alphanumeric characters (Amazon Standard Identification Number). */
const ASIN_RE = /^[A-Z0-9]{10}$/i;

export function isValidAsin(asin: string | null | undefined): boolean {
  return !!asin && ASIN_RE.test(asin.trim());
}

export function normalizeMarketplace(raw: string | null | undefined): AmazonMarketplace {
  const v = (raw ?? "").trim().toUpperCase();
  return (AMAZON_MARKETPLACES as string[]).includes(v) ? (v as AmazonMarketplace) : "US";
}

/** True when a URL points at any Amazon marketplace host. */
export function isAmazonUrl(url: string | null | undefined): boolean {
  const u = (url ?? "").trim().toLowerCase();
  if (!u) return false;
  return /(^|\/\/|\.)amazon\.[a-z.]+/.test(u) || /amzn\.(to|eu)\b/.test(u);
}

/**
 * Heuristic: does this product look like an Amazon product? Checks any URL-ish
 * field for an Amazon host, then falls back to domain/store text hints. Used by
 * the Product Opportunities and Create Pins Amazon source filters. No network.
 */
export function looksLikeAmazon(hints: {
  productUrl?:   string | null;
  sourceUrl?:    string | null;
  canonicalUrl?: string | null;
  url?:          string | null;
  domain?:       string | null;
  sourceDomain?: string | null;
  store?:        string | null;
  merchant?:     string | null;
} | null | undefined): boolean {
  if (!hints) return false;
  if (
    isAmazonUrl(hints.productUrl) ||
    isAmazonUrl(hints.sourceUrl) ||
    isAmazonUrl(hints.canonicalUrl) ||
    isAmazonUrl(hints.url)
  ) return true;
  const text = `${hints.domain ?? ""} ${hints.sourceDomain ?? ""} ${hints.store ?? ""} ${hints.merchant ?? ""}`.toLowerCase();
  return /amazon|amzn/.test(text);
}

/**
 * Extract an ASIN from an Amazon product URL or a bare ASIN string.
 * Supports the common forms: /dp/ASIN, /gp/product/ASIN, /product/ASIN, /ASIN/.
 * Returns null when no valid ASIN can be found. Never invents an ASIN.
 */
export function extractAsin(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (isValidAsin(raw)) return raw.toUpperCase();

  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /[?&]asin=([A-Z0-9]{10})\b/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1] && isValidAsin(m[1])) return m[1].toUpperCase();
  }
  return null;
}

/** Canonical (tag-free) product URL for an ASIN on a marketplace. */
export function buildCanonicalProductUrl(asin: string, marketplace: AmazonMarketplace): string {
  const host = AMAZON_MARKETPLACE_DOMAINS[marketplace];
  return `https://${host}/dp/${asin.toUpperCase()}`;
}

/**
 * Build a stable creator-owned affiliate URL.
 *
 * Returns "" when the ASIN is missing/invalid or the tracking tag is empty — the
 * caller decides whether that means `failed` (no ASIN) or `needs_setup` (no tag).
 * The output is deterministic for a given (asin, marketplace, trackingId).
 */
export function buildAmazonAffiliateUrl(input: {
  asin: string;
  marketplace: string;
  trackingId: string;
}): string {
  const asin = (input.asin ?? "").trim().toUpperCase();
  const trackingId = (input.trackingId ?? "").trim();
  const marketplace = normalizeMarketplace(input.marketplace);
  if (!isValidAsin(asin) || !trackingId) return "";
  return `${buildCanonicalProductUrl(asin, marketplace)}?tag=${encodeURIComponent(trackingId)}`;
}
