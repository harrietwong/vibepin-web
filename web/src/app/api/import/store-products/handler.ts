import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import {
  consumeRateLimit,
  RATE_LIMITED_ERROR,
  RATE_LIMITED_MESSAGE,
  type RateLimitDecision,
} from "@/lib/server/rateLimit";
import {
  deriveStoreEndpoint,
  importStoreProducts,
  StoreImportCache,
  type StoreFetchRaw,
} from "@/lib/productUrlImport/storeProductsImport";
import {
  STORE_FAILED_MESSAGE,
  STORE_PRODUCT_PAGE_MESSAGE,
  type StoreProductsImportResponse,
} from "@/lib/productUrlImport/storeBatchShared";

const MAX_URL_LENGTH = 2048;

/** Process-local, per serverless instance (see StoreImportCache). */
const defaultCache = new StoreImportCache();

/** TEST SEAM ONLY. */
export function __resetStoreImportCacheForTests(): void {
  defaultCache.clear();
}

export type StoreProductsImportHandlerDeps = {
  getUserId?:        (request: Request) => Promise<string | null>;
  consumeRateLimit?: (userId: string) => Promise<RateLimitDecision>;
  /** Single-hop transport (no redirect following); see StoreFetchRaw. */
  fetchRaw?:         StoreFetchRaw;
  sleep?:            (ms: number) => Promise<void>;
  now?:              () => number;
  cache?:            StoreImportCache;
};

/**
 * POST /api/import/store-products — FR-06 stage 1: Shopify store / collection
 * batch import into "My Products". Body: `{ url: string }`.
 *
 * Same order as /api/import/product-urls:
 *   1. auth       — anonymous → 401 before anything else (zero outbound calls)
 *   2. rate limit — `url_import` bucket, one slot per batch, before body parsing.
 *                   Debited BEFORE the cache lookup (accepted simplification: a
 *                   cache hit still costs one slot, but makes no outbound call).
 *   3. body       — validateImportUrl (SSRF / private / protocol / blocklist) and
 *                   endpoint derivation; any failure → 400 with zero outbound calls.
 *   4. cache      — same user + store + collection within 10 min → no outbound call.
 *   5. fetch      — importStoreProducts (page limits, size caps, redirects).
 *
 * The response only ever carries fixed business-language messages; no upstream
 * status code or address is echoed (0904 SEC-URL-03). This route never creates
 * drafts or schedules anything — the client saves the chosen items to My Products.
 */
export async function handlePost(request: Request, deps: StoreProductsImportHandlerDeps = {}) {
  const getUserId = deps.getUserId ?? getUserIdFromBearerOrCookies;
  const userId = await getUserId(request).catch(() => null);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await (deps.consumeRateLimit ?? ((id: string) => consumeRateLimit(id, "url_import")))(userId);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITED_MESSAGE, code: RATE_LIMITED_ERROR },
      {
        status: limit.reason === "limit_exceeded" ? 429 : 503,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = (body as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !url.trim()) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  if (url.length > MAX_URL_LENGTH) {
    return NextResponse.json({ error: "URL too long" }, { status: 400 });
  }

  const endpoint = deriveStoreEndpoint(url);
  if (!endpoint.ok) {
    return NextResponse.json(
      endpoint.code === "product_page"
        ? { error: STORE_PRODUCT_PAGE_MESSAGE, code: "product_page" }
        : { error: endpoint.error, code: "invalid_url" },
      { status: 400 },
    );
  }

  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? defaultCache;
  const cacheKey = StoreImportCache.key(userId, endpoint.origin.origin, endpoint.collectionHandle);
  const cached = cache.get(cacheKey, now());
  if (cached) return NextResponse.json(cached);

  let result: StoreProductsImportResponse;
  try {
    result = await importStoreProducts(endpoint, { fetchRaw: deps.fetchRaw, sleep: deps.sleep, now });
  } catch {
    // Defensive: importStoreProducts converts transport errors itself; anything that
    // still escapes becomes the fixed business message, never a stack or upstream text.
    result = {
      status:    "failed",
      store:     {
        domain: endpoint.domain,
        ...(endpoint.collectionHandle ? { collectionHandle: endpoint.collectionHandle } : {}),
        currency: "unknown",
      },
      products:  [],
      truncated: false,
      message:   STORE_FAILED_MESSAGE,
    };
  }
  cache.set(cacheKey, result, now());
  return NextResponse.json(result);
}
