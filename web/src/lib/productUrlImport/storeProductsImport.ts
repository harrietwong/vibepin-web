/**
 * FR-06 stage 1 — Shopify store / collection batch import (SERVER ONLY).
 *
 * A new outbound fetch surface, so it inherits every 0904 SEC-URL rule:
 *   - the caller (route handler) authenticates and rate-limits BEFORE this runs;
 *   - the endpoint is DERIVED here from the pasted URL — a client-supplied page or
 *     pagination address is never fetched;
 *   - every hop (incl. redirects) is re-validated with `validateImportUrl` and must
 *     stay on the same store (see `isSameStoreOrigin`);
 *   - per response: 1 MB cap (Content-Length AND real bytes), 10 s timeout;
 *   - ≤ 4 pages × 25 products, ≥ 500 ms between pages;
 *   - the default transport pins DNS through `guardedDnsLookup` (rejects private
 *     addresses at connect time → DNS-rebinding safe), same as /api/fetch-og;
 *   - error text returned to the client is fixed business copy, never an upstream
 *     status code or URL.
 *
 * The page-1 response decides everything: non-2xx / non-JSON / not `{products: []}`
 * → `unsupported` after exactly ONE request, no retry, no meta.json.
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { guardedDnsLookup } from "@/app/api/fetch-og/safeOutboundUrl";
import { DEFAULT_HEADERS } from "./fetchHeaders";
import { factsFromShopifyProductJson, withFactsImages, type ShopifyProductJsonProduct } from "./productFacts";
import { sourceDomainFromUrl, validateImportUrl } from "./urlSecurity";
import {
  classifyStorePath,
  STORE_BATCH_MAX_PRODUCTS,
  STORE_FAILED_MESSAGE,
  STORE_UNSUPPORTED_MESSAGE,
  type StoreBatchProduct,
  type StoreProductsImportResponse,
} from "./storeBatchShared";

export const STORE_PAGE_LIMIT          = 25;
export const STORE_MAX_PAGES           = 4;
export const STORE_MAX_RESPONSE_BYTES  = 1024 * 1024;
export const STORE_FETCH_TIMEOUT_MS    = 10_000;
export const STORE_PAGE_INTERVAL_MS    = 500;
export const STORE_MAX_REDIRECTS       = 3;
export const STORE_CACHE_TTL_MS        = 10 * 60 * 1000;
const MAX_IMAGES_PER_PRODUCT = 8;

// ── Transport seam ──────────────────────────────────────────────────────────

export type StoreRawResponse = {
  status:  number;
  headers: { get(name: string): string | null };
  /** Body bytes — only read for 2xx; empty for redirects and errors. */
  body:    Uint8Array;
  /** True when the transport stopped reading because the body exceeded `maxBytes`. */
  overLimit?: boolean;
};

/**
 * ONE HTTP hop, no redirect following. Redirects, per-hop validation, same-store
 * checks and size checks all live ABOVE this seam (in `fetchStoreJson`) so they are
 * testable with an injected fake.
 */
export type StoreFetchRaw = (url: string, opts: { maxBytes: number }) => Promise<StoreRawResponse>;

/** Stream-read at most `maxBytes + 1` bytes; stops (and reports) as soon as the cap is crossed. */
export async function readBodyWithLimit(
  chunks: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
  onOverLimit?: () => void,
): Promise<{ body: Uint8Array; overLimit: boolean }> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > maxBytes) {
      onOverLimit?.();
      return { body: new Uint8Array(0), overLimit: true };
    }
    parts.push(bytes);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { body.set(p, offset); offset += p.byteLength; }
  return { body, overLimit: false };
}

/** Default transport: node http(s) with the fetch-og guarded DNS lookup and a hard 10 s timeout. */
export function createDefaultStoreFetchRaw(lookup: LookupFunction = guardedDnsLookup): StoreFetchRaw {
  return async (rawUrl, { maxBytes }) => {
    const url = new URL(rawUrl);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const signal = AbortSignal.timeout(STORE_FETCH_TIMEOUT_MS);
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(url, {
        method:  "GET",
        headers: { ...DEFAULT_HEADERS, Accept: "application/json" },
        lookup,
        signal,
      }, resolve);
      req.on("error", reject);
      req.end();
    });
    const headers = {
      get(name: string): string | null {
        const v = res.headers[name.toLowerCase()];
        if (Array.isArray(v)) return v[0] ?? null;
        return v ?? null;
      },
    };
    const status = res.statusCode ?? 502;
    if (status < 200 || status >= 300) {
      res.destroy();
      return { status, headers, body: new Uint8Array(0) };
    }
    const declared = Number(headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      return { status, headers, body: new Uint8Array(0), overLimit: true };
    }
    const { body, overLimit } = await readBodyWithLimit(res, maxBytes, () => res.destroy());
    return { status, headers, body, overLimit };
  };
}

// ── Same-store rule for redirects ─────────────────────────────────────────────

const bareHost = (h: string) => h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/**
 * A redirect hop may only stay on the same store: https, default port, and a host
 * that equals the base host modulo a leading `www.`. The `www.` tolerance is a
 * deliberate relaxation of strict same-origin — Shopify stores very commonly 301
 * `store.com` → `www.store.com` (and back), and strict origin equality would turn
 * every such store into "unsupported". Anything else (another domain, a Shopify
 * login host, an http downgrade, a custom port) is refused.
 */
export function isSameStoreOrigin(candidate: URL, base: URL): boolean {
  if (candidate.protocol !== "https:") return false;
  if (candidate.port && candidate.port !== "443") return false;
  if (candidate.username || candidate.password) return false;
  return bareHost(candidate.hostname) === bareHost(base.hostname);
}

type FetchJsonOutcome =
  | { ok: true; data: unknown; finalUrl: URL }
  | { ok: false; reason: "blocked" | "redirect_blocked" | "too_many_redirects" | "http_status" | "too_large" | "not_json" | "network" };

/** One logical GET of a JSON document on the store, following ≤ 3 same-store redirects. */
export async function fetchStoreJson(startUrl: string, base: URL, fetchRaw: StoreFetchRaw): Promise<FetchJsonOutcome> {
  let current = startUrl;
  for (let hop = 0; hop <= STORE_MAX_REDIRECTS; hop++) {
    const validated = validateImportUrl(current);
    if (!validated.ok) return { ok: false, reason: hop === 0 ? "blocked" : "redirect_blocked" };
    if (!isSameStoreOrigin(validated.url, base)) return { ok: false, reason: hop === 0 ? "blocked" : "redirect_blocked" };

    let raw: StoreRawResponse;
    try {
      raw = await fetchRaw(validated.url.toString(), { maxBytes: STORE_MAX_RESPONSE_BYTES });
    } catch {
      return { ok: false, reason: "network" };
    }

    if (raw.status >= 300 && raw.status < 400) {
      const location = raw.headers.get("location");
      if (!location) return { ok: false, reason: "http_status" };
      try { current = new URL(location, validated.url).toString(); } catch { return { ok: false, reason: "redirect_blocked" }; }
      continue;
    }
    if (raw.status < 200 || raw.status >= 300) return { ok: false, reason: "http_status" };

    const declared = Number(raw.headers.get("content-length"));
    if (raw.overLimit || (Number.isFinite(declared) && declared > STORE_MAX_RESPONSE_BYTES) || raw.body.byteLength > STORE_MAX_RESPONSE_BYTES) {
      return { ok: false, reason: "too_large" };
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(raw.body);
      return { ok: true, data: JSON.parse(text) as unknown, finalUrl: validated.url };
    } catch {
      return { ok: false, reason: "not_json" };
    }
  }
  return { ok: false, reason: "too_many_redirects" };
}

// ── Endpoint derivation ─────────────────────────────────────────────────────

export type StoreEndpoint =
  | { ok: true; origin: URL; domain: string; collectionHandle?: string; productsPath: string }
  | { ok: false; code: "invalid_url" | "product_page"; error: string };

/**
 * Server-side endpoint derivation. The pasted URL contributes ONLY its host and an
 * optional collection handle; its path and query are otherwise discarded. `http:` is
 * upgraded to `https:` (Shopify storefronts are https-only). Userinfo and
 * non-default ports are refused.
 */
export function deriveStoreEndpoint(rawUrl: string): StoreEndpoint {
  const validated = validateImportUrl(rawUrl);
  if (!validated.ok) return { ok: false, code: "invalid_url", error: validated.error };
  const url = validated.url;
  if (url.username || url.password) return { ok: false, code: "invalid_url", error: "Credentials in URL are not allowed" };
  if (url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) {
    return { ok: false, code: "invalid_url", error: "Custom ports are not allowed" };
  }

  const path = classifyStorePath(url.pathname);
  if (path.kind === "product_page") {
    return { ok: false, code: "product_page", error: "This is a single product link. Use link import for it instead." };
  }
  if (path.kind === "invalid_collection") return { ok: false, code: "invalid_url", error: "Invalid collection link" };

  const origin = new URL(`https://${url.hostname}`);
  const domain = sourceDomainFromUrl(origin);
  if (path.kind === "collection") {
    return {
      ok: true, origin, domain,
      collectionHandle: path.handle,
      productsPath: `/collections/${encodeURIComponent(path.handle)}/products.json`,
    };
  }
  return { ok: true, origin, domain, productsPath: "/products.json" };
}

// ── Mapping ─────────────────────────────────────────────────────────────────

type ShopifyListProduct = ShopifyProductJsonProduct & {
  handle?: unknown;
  images?: Array<{ src?: unknown } | null> | null;
};

function isProductsShape(data: unknown): data is { products: unknown[] } {
  return !!data && typeof data === "object" && Array.isArray((data as { products?: unknown }).products);
}

function normalizeImageSrc(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  const s = src.trim();
  if (!s) return undefined;
  const abs = s.startsWith("//") ? `https:${s}` : s;
  try {
    const u = new URL(abs);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function currencyFromMeta(data: unknown): string {
  const c = data && typeof data === "object" ? (data as { currency?: unknown }).currency : undefined;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c.trim()) ? c.trim() : "unknown";
}

export function mapStoreProduct(
  raw: unknown,
  origin: URL,
  currency: string,
  nowIso: string,
): StoreBatchProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as ShopifyListProduct;
  const handle = typeof p.handle === "string" ? p.handle.trim() : "";
  if (!handle) return null;

  const productUrl = `${origin.origin}/products/${encodeURIComponent(handle)}`;
  const images = (Array.isArray(p.images) ? p.images : [])
    .map(img => normalizeImageSrc(img?.src))
    .filter((s): s is string => !!s)
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .slice(0, MAX_IMAGES_PER_PRODUCT);

  // Currency is never in products.json; meta.json is the only source. No html → the
  // parser marks it "unknown", then we inject the store's declared currency.
  let facts = factsFromShopifyProductJson(p, productUrl, undefined, nowIso);
  if (!facts) return null;
  if (facts.price && currency !== "unknown") facts = { ...facts, price: { ...facts.price, currency } };
  facts = withFactsImages(facts, images) ?? facts;

  const title = facts.title ?? handle;
  return {
    handle,
    title,
    productUrl,
    ...(images[0] ? { imageUrl: images[0] } : {}),
    images,
    facts,
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────

export type StoreImportDeps = {
  fetchRaw?: StoreFetchRaw;
  sleep?:    (ms: number) => Promise<void>;
  now?:      () => number;
};

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Fetch up to 4 pages of a store's (or collection's) public product list.
 * Request order is fixed: page 1 → (if it is a Shopify product list) meta.json →
 * pages 2..4 with a ≥ 500 ms pause before each. Stops at the first page with fewer
 * than 25 products. A page ≥ 2 that fails keeps what was already collected and
 * reports `truncated: true` (we cannot know whether more existed).
 */
export async function importStoreProducts(
  endpoint: Extract<StoreEndpoint, { ok: true }>,
  deps: StoreImportDeps = {},
): Promise<StoreProductsImportResponse> {
  const fetchRaw = deps.fetchRaw ?? createDefaultStoreFetchRaw();
  const sleep = deps.sleep ?? defaultSleep;
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();

  const storeInfo = (currency: string, domain = endpoint.domain) => ({
    domain,
    ...(endpoint.collectionHandle ? { collectionHandle: endpoint.collectionHandle } : {}),
    currency,
  });
  const pageUrl = (origin: URL, page: number) =>
    `${origin.origin}${endpoint.productsPath}?limit=${STORE_PAGE_LIMIT}&page=${page}`;

  // Page 1 — decides whether this is a readable Shopify product list at all.
  const first = await fetchStoreJson(pageUrl(endpoint.origin, 1), endpoint.origin, fetchRaw);
  if (!first.ok) {
    const failed = first.reason === "network" || first.reason === "too_large";
    return {
      status:    failed ? "failed" : "unsupported",
      store:     storeInfo("unknown"),
      products:  [],
      truncated: false,
      message:   failed ? STORE_FAILED_MESSAGE : STORE_UNSUPPORTED_MESSAGE,
    };
  }
  if (!isProductsShape(first.data)) {
    return { status: "unsupported", store: storeInfo("unknown"), products: [], truncated: false, message: STORE_UNSUPPORTED_MESSAGE };
  }

  // Follow-up requests go to the origin page 1 actually answered on (e.g. after a
  // bare → www redirect), so later pages don't pay the redirect again.
  const origin = new URL(first.finalUrl.origin);
  const domain = sourceDomainFromUrl(origin);

  // Currency: one extra request under the same constraints; failure is not fatal.
  const meta = await fetchStoreJson(`${origin.origin}/meta.json`, endpoint.origin, fetchRaw);
  const currency = meta.ok ? currencyFromMeta(meta.data) : "unknown";

  const products: StoreBatchProduct[] = [];
  const seen = new Set<string>();
  const collect = (list: unknown[]) => {
    for (const raw of list) {
      if (products.length >= STORE_BATCH_MAX_PRODUCTS) return;
      let mapped: StoreBatchProduct | null = null;
      // Upstream JSON is untrusted: one malformed product must not sink the batch.
      try { mapped = mapStoreProduct(raw, origin, currency, nowIso); } catch { mapped = null; }
      if (!mapped || seen.has(mapped.handle)) continue;
      seen.add(mapped.handle);
      products.push(mapped);
    }
  };

  collect(first.data.products);
  let lastPageFull = first.data.products.length >= STORE_PAGE_LIMIT;
  let truncated = false;

  for (let page = 2; page <= STORE_MAX_PAGES && lastPageFull; page++) {
    await sleep(STORE_PAGE_INTERVAL_MS);
    const next = await fetchStoreJson(pageUrl(origin, page), endpoint.origin, fetchRaw);
    if (!next.ok || !isProductsShape(next.data)) {
      truncated = true;
      lastPageFull = false;
      break;
    }
    collect(next.data.products);
    lastPageFull = next.data.products.length >= STORE_PAGE_LIMIT;
  }
  // Four full pages means there may be more than we are allowed to fetch.
  if (lastPageFull) truncated = true;

  return { status: "success", store: storeInfo(currency, domain), products, truncated };
}

// ── Per-store cache ─────────────────────────────────────────────────────────

/**
 * Process-local cache (key = user + origin + collection handle, TTL 10 min).
 * Per serverless instance only — instances do not share it. Only `success`
 * responses are cached: caching `unsupported`/`failed` would lock a user out of a
 * store for 10 minutes after one transient upstream error.
 */
export class StoreImportCache {
  private entries = new Map<string, { expiresAt: number; value: StoreProductsImportResponse }>();
  constructor(private readonly ttlMs = STORE_CACHE_TTL_MS, private readonly maxEntries = 200) {}

  static key(userId: string, origin: string, collectionHandle?: string): string {
    return `${userId}|${origin}|${collectionHandle ?? ""}`;
  }

  get(key: string, nowMs: number): StoreProductsImportResponse | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= nowMs) { this.entries.delete(key); return null; }
    return hit.value;
  }

  set(key: string, value: StoreProductsImportResponse, nowMs: number): void {
    if (value.status !== "success") return;
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: nowMs + this.ttlMs, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void { this.entries.clear(); }
}
