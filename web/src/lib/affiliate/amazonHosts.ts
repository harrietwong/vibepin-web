/**
 * amazonHosts.ts — the single source of truth for "is this host Amazon?".
 *
 * Leaf module (type-only import from amazon.ts) so amazon.ts, amazonLink.ts and the
 * server-side urlSecurity blocklist can all derive from it without a runtime cycle.
 *
 * SECURITY: every decision here is an EXACT match on `URL.hostname`, never a substring
 * or regex over the raw string. `amazon.com.evil.io`, `evil.io/?r=amzn.to` and
 * `amazon.com@evil.io` must all classify as "not Amazon".
 */

import type { AmazonMarketplace } from "./amazon";

/**
 * Bare retail domains → marketplace code. `null` = a real Amazon retail site we
 * recognise but that is not in the `AmazonMarketplace` union: links to it are kept on
 * their own host (never rewritten to amazon.com), but no Settings tag is ever applied.
 */
export const AMAZON_RETAIL_HOSTS: Readonly<Record<string, AmazonMarketplace | null>> = {
  "amazon.com": "US", "amazon.co.uk": "UK", "amazon.ca": "CA", "amazon.de": "DE",
  "amazon.fr": "FR", "amazon.it": "IT", "amazon.es": "ES", "amazon.com.au": "AU",
  "amazon.co.jp": "JP",
  "amazon.nl": null, "amazon.se": null, "amazon.pl": null, "amazon.in": null,
  "amazon.com.mx": null, "amazon.com.br": null, "amazon.sg": null, "amazon.ae": null,
  "amazon.sa": null, "amazon.com.tr": null, "amazon.com.be": null, "amazon.eg": null,
};

/** Amazon-owned short-link hosts (exact host only, no subdomains). */
export const AMAZON_SHORT_HOSTS: ReadonlySet<string> = new Set(["amzn.to", "a.co", "amzn.eu", "amzn.asia"]);

/** Retail subdomains we accept; everything else (sellercentral., aws., …) is rejected. */
const RETAIL_SUBDOMAIN_PREFIXES = ["", "www.", "smile.", "m."] as const;

/**
 * Hosts the dedicated Amazon fetch channel may contact (text only, never images).
 * Deliberately narrower than recognition: the nine supported marketplaces plus the two
 * share-button short links (Fable ruling 1: a.co included).
 */
export const AMAZON_FETCHABLE_RETAIL_HOSTS: ReadonlySet<string> = new Set([
  "amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.ca",
  "amazon.com.au", "amazon.it", "amazon.es", "amazon.co.jp",
]);
export const AMAZON_FETCHABLE_SHORT_HOSTS: ReadonlySet<string> = new Set(["amzn.to", "a.co"]);

/** Every bare Amazon domain we know (retail + short). Used to derive blocklists. */
export function allKnownAmazonHosts(): string[] {
  return [...Object.keys(AMAZON_RETAIL_HOSTS), ...AMAZON_SHORT_HOSTS];
}

export type AmazonHostClass =
  | { kind: "retail"; host: string; marketplace: AmazonMarketplace | null }
  | { kind: "short"; host: string };

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Exact-match classification of a parsed `URL.hostname`.
 * Returns the BARE host (no `www.`) for retail hosts, or null when not Amazon.
 */
export function classifyAmazonHost(hostname: string): AmazonHostClass | null {
  const h = normalizeHostname(hostname);
  if (!h) return null;
  if (AMAZON_SHORT_HOSTS.has(h)) return { kind: "short", host: h };
  for (const prefix of RETAIL_SUBDOMAIN_PREFIXES) {
    if (prefix && !h.startsWith(prefix)) continue;
    const bare = h.slice(prefix.length);
    if (Object.prototype.hasOwnProperty.call(AMAZON_RETAIL_HOSTS, bare)) {
      return { kind: "retail", host: bare, marketplace: AMAZON_RETAIL_HOSTS[bare] };
    }
  }
  return null;
}

/**
 * True when the hostname is a subdomain of a known Amazon domain that
 * `classifyAmazonHost` rejects (e.g. sellercentral.amazon.com). Exact suffix on a
 * label boundary — `amazon.com.evil.io` is NOT a subdomain of amazon.com.
 */
export function isOtherAmazonSubdomain(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (classifyAmazonHost(h)) return false;
  return allKnownAmazonHosts().some(base => h.endsWith(`.${base}`));
}
