import { isIP } from "node:net";
import { isPublicIpAddress } from "@/app/api/fetch-og/safeOutboundUrl";

import {
  AMAZON_FETCHABLE_RETAIL_HOSTS,
  AMAZON_FETCHABLE_SHORT_HOSTS,
  allKnownAmazonHosts,
  classifyAmazonHost,
} from "@/lib/affiliate/amazonHosts";
import type { MarketplaceId } from "./types";
import { classifyManualMarketplace } from "./marketplaceHosts";

export { classifyManualMarketplace };

/**
 * Generic-channel blocklist. The Amazon part is DERIVED from amazonHosts.ts (single
 * source of truth): every known retail site AND every short-link host. Before this,
 * only six Amazon domains were listed, so amazon.it / amazon.co.jp / amzn.to went
 * through the generic image-extracting fetch. Amazon now only goes through
 * validateAmazonUrl (text-only channel).
 */
const BLOCKED_HOST_SUFFIXES = [
  ...allKnownAmazonHosts(),
  "temu.com", "shein.com", "aliexpress.com", "aliexpress.us",
  "instagram.com", "tiktok.com", "tiktokshop.com",
];

const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

export function isBlockedMarketplace(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return BLOCKED_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * True for localhost names and for ANY IP literal that is not a public unicast address.
 *
 * IP literals are classified by the same `isPublicIpAddress` the fetch-og guard uses,
 * NOT by string prefixes: the WHATWG URL parser rewrites `[::ffff:127.0.0.1]` to
 * `[::ffff:7f00:1]`, so a prefix check on the literal silently let IPv4-mapped loopback
 * through. The shared classifier decodes mapped IPv4, and rejects `::`, link-local
 * `fe80::/10`, ULA, NAT64 `64:ff9b::/96`, 100.64/10, 198.18/15, etc.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (isIP(bare) !== 0) return !isPublicIpAddress(bare);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_IPV4.test(h);
  return false;
}

export function validateImportUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; error: string; marketplace?: MarketplaceId } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Empty URL" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http and https URLs are supported" };
  }

  if (isPrivateOrLocalHost(url.hostname)) {
    return { ok: false, error: "Internal or localhost URLs are not allowed" };
  }

  if (isBlockedMarketplace(url.hostname)) {
    // FR-04: the four manual-entry marketplaces carry their id so the caller can
    // route to the zero-fetch manual card instead of a plain failure. Everything
    // else blocked (Amazon has its own channel; Instagram is not a product page)
    // gets no `marketplace` and stays a generic failure.
    const marketplace = classifyManualMarketplace(url.hostname);
    return { ok: false, error: "This marketplace is not supported for URL import", ...(marketplace ? { marketplace } : {}) };
  }

  return { ok: true, url };
}

export type AmazonUrlValidation =
  | { ok: true; url: URL; kind: "retail" | "short"; host: string }
  | { ok: false; error: string };

/**
 * Amazon channel gate. Separate from validateImportUrl (which blocks all of Amazon).
 *
 * - Exact host whitelist: the nine supported retail marketplaces (bare, www., smile.,
 *   m.) plus amzn.to and a.co. Nothing else — not other Amazon subdomains, not the
 *   recognised-but-unsupported marketplaces, not amzn.eu/amzn.asia.
 * - https only; `http:` is upgraded to https before the decision.
 * - No userinfo, no non-default port.
 * The caller must re-run this on EVERY redirect hop. This channel returns text only;
 * it never produces image candidates.
 */
export function validateAmazonUrl(raw: string): AmazonUrlValidation {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "Empty URL" };
  if (trimmed.length > 2048) return { ok: false, error: "URL too long" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Only https Amazon URLs are supported" };
  }
  if (url.username || url.password) return { ok: false, error: "Credentials in URL are not allowed" };
  if (url.port && !(url.protocol === "https:" && url.port === "443") && !(url.protocol === "http:" && url.port === "80")) {
    return { ok: false, error: "Custom ports are not allowed" };
  }
  if (url.protocol === "http:") {
    url = new URL(url.href.replace(/^http:/i, "https:"));
    url.port = "";
  }

  const cls = classifyAmazonHost(url.hostname);
  if (!cls) return { ok: false, error: "Not an allowed Amazon host" };
  const allowed = cls.kind === "short"
    ? AMAZON_FETCHABLE_SHORT_HOSTS.has(cls.host)
    : AMAZON_FETCHABLE_RETAIL_HOSTS.has(cls.host);
  if (!allowed) return { ok: false, error: "Not an allowed Amazon host" };

  return { ok: true, url, kind: cls.kind, host: cls.host };
}

export function sourceDomainFromUrl(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

export function isDirectImageUrl(url: URL): boolean {
  return /\.(jpe?g|png|webp)(\?.*)?$/i.test(url.pathname);
}
