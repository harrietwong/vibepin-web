/**
 * amazon.ts — Pure Amazon affiliate URL helpers (no network, no PA-API).
 *
 * MVP scope: build a stable, creator-owned affiliate destination URL from an
 * ASIN + marketplace + the creator's own tracking (associate) tag. We never
 * scrape Amazon, never call PA-API, and never preserve another user's tag.
 */

import { classifyAmazonHost } from "./amazonHosts";

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

/**
 * Parse a user/DB string as a URL. Scheme-less input ("amazon.com/dp/…") is read as
 * https so existing product-library rows keep working. Returns null on garbage.
 */
function parseLooseUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/\//, "")}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * True when a URL's HOST is a known Amazon retail or short-link host.
 *
 * Exact host whitelist on the parsed hostname (see amazonHosts.ts) — the previous
 * substring regex accepted `amazon.com.evil.io` and `evil.io/?r=amzn.to`. Still a UI /
 * filtering helper; the fetch path uses urlSecurity.validateAmazonUrl.
 */
export function isAmazonUrl(url: string | null | undefined): boolean {
  const parsed = parseLooseUrl(url ?? "");
  if (!parsed) return false;
  return classifyAmazonHost(parsed.hostname) !== null;
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
 * A product ASIN as it appears in a URL: `B0`/`BT` prefix + 8 more UPPERCASE
 * alphanumerics.
 */
export const STRICT_URL_ASIN_RE = /^(?:B0|BT)[A-Z0-9]{8}$/;

/** Book ASINs are the ISBN-10: nine digits + a digit or `X` check character. */
export const ISBN10_ASIN_RE = /^\d{9}[\dX]$/;

function isUrlAsinToken(token: string): boolean {
  return STRICT_URL_ASIN_RE.test(token) || ISBN10_ASIN_RE.test(token);
}

/**
 * Path shapes that actually carry an ASIN. Anchored on a known keyword segment; the
 * old catch-all `/XXXXXXXXXX/` rule turned `/electronic/` into "ELECTRONIC".
 */
const ASIN_PATH_PATTERNS: readonly RegExp[] = [
  /\/dp\/([A-Za-z0-9]{10})(?=[/?#;]|$)/,
  /\/gp\/product\/([A-Za-z0-9]{10})(?=[/?#;]|$)/,
  /\/gp\/aw\/d\/([A-Za-z0-9]{10})(?=[/?#;]|$)/,
  /\/exec\/obidos\/ASIN\/([A-Za-z0-9]{10})(?=[/?#;]|$)/,
  /\/o\/ASIN\/([A-Za-z0-9]{10})(?=[/?#;]|$)/,
];

/**
 * Strict ASIN extraction from a parsed URL: only the known path shapes above or an
 * `asin=` query parameter, and only tokens that are a B0/BT product ASIN or an
 * ISBN-10 book ASIN (`/dp/0316769487`, `/gp/product/030640615X`). Words such as
 * `ELECTRONIC` never qualify, in any position.
 */
export function extractAsinFromUrl(url: URL): string | null {
  const path = url.pathname;
  for (const re of ASIN_PATH_PATTERNS) {
    const token = path.match(re)?.[1];
    if (token && isUrlAsinToken(token)) return token;
  }
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === "asin" && isUrlAsinToken(value.trim())) return value.trim();
  }
  return null;
}

/**
 * Extract an ASIN from an Amazon product URL or a bare ASIN string.
 *
 * - Bare input (a stored `asin` field): any valid 10-char ASIN, case-insensitive,
 *   uppercased — unchanged contract for product-library rows.
 * - URL input: strict (extractAsinFromUrl) — /dp/, /gp/product/, /gp/aw/d/,
 *   /exec/obidos/ASIN/, /o/ASIN/, or ?asin=, with a B0/BT uppercase token.
 * Returns null when no valid ASIN can be found. Never invents an ASIN.
 */
export function extractAsin(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (isValidAsin(raw)) return raw.toUpperCase();
  const url = parseLooseUrl(raw);
  return url ? extractAsinFromUrl(url) : null;
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
