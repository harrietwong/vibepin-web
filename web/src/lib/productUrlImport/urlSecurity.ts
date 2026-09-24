import { isIP } from "node:net";
import { isPublicIpAddress } from "@/app/api/fetch-og/safeOutboundUrl";

const BLOCKED_HOST_SUFFIXES = [
  "amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.ca", "amazon.com.au",
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

export function validateImportUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
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
    return { ok: false, error: "This marketplace is not supported for URL import" };
  }

  return { ok: true, url };
}

export function sourceDomainFromUrl(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

export function isDirectImageUrl(url: URL): boolean {
  return /\.(jpe?g|png|webp)(\?.*)?$/i.test(url.pathname);
}
