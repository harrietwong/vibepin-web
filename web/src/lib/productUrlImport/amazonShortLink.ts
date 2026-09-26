/**
 * Server-side expansion of Amazon short links (amzn.to, a.co, link.amazon) to a
 * retail URL.
 *
 * - GET with `redirect: "manual"`, honest UA, per-hop timeout; only the Location
 *   header is read, the body is discarded.
 * - Every hop target must pass validateAmazonUrl (exact Amazon whitelist), OR be an
 *   exact match on the small third-party hop allowlist (`AMAZON_SHORT_LINK_HOP_HOSTS`
 *   — e.g. `amzlinks.in`, which `link.amazon` is observed to bounce through on its way
 *   to a real Amazon retail page). A hop-allowed host is never itself treated as
 *   Amazon (no tag/asin/marketplace is read from it) — it only earns the RIGHT to be
 *   fetched for one more redirect, which must then land on a real Amazon host to
 *   count as expanded. A hop to any other host aborts with `off_allowlist` — we never
 *   follow it.
 * - Stops at the first retail URL (the retail page itself is NOT fetched here).
 * - Never throws: every failure is a typed result so the caller degrades to manual
 *   entry and keeps the user's pasted link unchanged (design §1.6).
 */

import { validateAmazonUrl } from "./urlSecurity";
import { DEFAULT_HEADERS } from "./fetchHeaders";
import { isAmazonShortLinkHopHost } from "@/lib/affiliate/amazonHosts";

export const AMAZON_SHORT_LINK_MAX_HOPS = 3;
export const AMAZON_SHORT_LINK_TIMEOUT_MS = 5000;
const EXPAND_HEADERS = DEFAULT_HEADERS;

export type ShortLinkFetch = (url: string, init: RequestInit) => Promise<Response>;

export type AmazonShortLinkExpansion =
  | { ok: true; retailUrl: string; hops: number; expandedFrom: string }
  | {
      ok: false;
      reason: "invalid_short_link" | "not_redirect" | "off_allowlist" | "too_many_hops" | "timeout" | "network_error";
      expandedFrom: string;
    };

export async function expandAmazonShortLink(
  shortUrl: string,
  fetchImpl: ShortLinkFetch = (u, i) => fetch(u, i),
  opts: { timeoutMs?: number; maxHops?: number } = {},
): Promise<AmazonShortLinkExpansion> {
  const expandedFrom = (shortUrl ?? "").trim();
  const first = validateAmazonUrl(expandedFrom);
  if (!first.ok || first.kind !== "short") return { ok: false, reason: "invalid_short_link", expandedFrom };

  const maxHops = opts.maxHops ?? AMAZON_SHORT_LINK_MAX_HOPS;
  const timeoutMs = opts.timeoutMs ?? AMAZON_SHORT_LINK_TIMEOUT_MS;
  let current = first.url;

  for (let hop = 1; hop <= maxHops; hop += 1) {
    let res: Response;
    try {
      res = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        headers: EXPAND_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error", expandedFrom };
    }
    try { await res.body?.cancel(); } catch { /* body discarded */ }

    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { ok: false, reason: "not_redirect", expandedFrom };

    let targetUrl: URL;
    try {
      targetUrl = new URL(location, current);
    } catch {
      return { ok: false, reason: "off_allowlist", expandedFrom };
    }
    const next = validateAmazonUrl(targetUrl.href);
    if (next.ok) {
      if (next.kind === "retail") return { ok: true, retailUrl: next.url.href, hops: hop, expandedFrom };
      current = next.url;
      continue;
    }
    // Not an Amazon host — allow exactly the small third-party hop allowlist to be
    // followed for one more redirect (never treated as Amazon itself: no tag/asin is
    // ever read off it, and if it does not lead to a real Amazon host next, expansion
    // still fails below).
    if (targetUrl.protocol === "https:" && !targetUrl.username && !targetUrl.password && isAmazonShortLinkHopHost(targetUrl.hostname)) {
      current = targetUrl;
      continue;
    }
    return { ok: false, reason: "off_allowlist", expandedFrom };
  }
  return { ok: false, reason: "too_many_hops", expandedFrom };
}
