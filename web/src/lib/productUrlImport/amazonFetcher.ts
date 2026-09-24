/**
 * Amazon-channel page fetcher (design §2.1 amazonPageFetcher).
 *
 * Same shape as defaultPageFetcher, but:
 *  - every hop (initial + each redirect) must pass validateAmazonUrl — redirects can
 *    only move between whitelisted Amazon hosts; anything else is `off_allowlist`
 *    and is never requested;
 *  - honest DEFAULT_HEADERS (no browser impersonation);
 *  - the body is read up to AMAZON_MAX_RESPONSE_BYTES (4 MB, decoded) and then the
 *    stream is cancelled — real product pages are 1.3–2.5 MB decoded, so the generic
 *    2 MB reject-on-overflow rule would drop them;
 *  - every failure is a typed reason, never a thrown error.
 */

import type { AmazonFetchFailReason } from "./types";
import type { ShortLinkFetch } from "./amazonShortLink";
import { DEFAULT_HEADERS } from "./fetchHeaders";
import { validateAmazonUrl } from "./urlSecurity";

export const AMAZON_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const AMAZON_FETCH_TIMEOUT_MS = 10_000;
export const AMAZON_MAX_REDIRECTS = 3;

export type AmazonPageFetch =
  | { ok: true; html: string; finalUrl: string; truncated: boolean }
  | { ok: false; reason: AmazonFetchFailReason; httpStatus?: number };

async function readCapped(resp: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  const body = resp.body;
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytes = 0;
  let text = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = cap - bytes;
    if (value.byteLength >= remaining) {
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      truncated = value.byteLength > remaining;
      bytes = cap;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated };
}

export async function fetchAmazonPage(
  rawUrl: string,
  fetchImpl: ShortLinkFetch = (u, i) => fetch(u, i),
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<AmazonPageFetch> {
  let current = rawUrl;
  const timeoutMs = opts.timeoutMs ?? AMAZON_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? AMAZON_MAX_RESPONSE_BYTES;

  for (let hop = 0; hop <= AMAZON_MAX_REDIRECTS; hop += 1) {
    const validated = validateAmazonUrl(current);
    if (!validated.ok) return { ok: false, reason: "off_allowlist" };

    let resp: Response;
    try {
      resp = await fetchImpl(validated.url.href, {
        method: "GET",
        redirect: "manual",
        headers: DEFAULT_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error" };
    }

    if (resp.status >= 300 && resp.status < 400) {
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      const location = resp.headers.get("location");
      if (!location) return { ok: false, reason: "http_error", httpStatus: resp.status };
      try {
        current = new URL(location, validated.url).href;
      } catch {
        return { ok: false, reason: "off_allowlist" };
      }
      continue;
    }

    if (!resp.ok) {
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      return { ok: false, reason: "http_error", httpStatus: resp.status };
    }

    try {
      const { text, truncated } = await readCapped(resp, maxBytes);
      return { ok: true, html: text, finalUrl: validated.url.href, truncated };
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error" };
    }
  }
  return { ok: false, reason: "too_many_redirects" };
}
