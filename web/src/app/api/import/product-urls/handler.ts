import { NextResponse } from "next/server";
import { importProductUrls, validateImportUrl } from "@/lib/productUrlImport";
import type { ProductUrlImportResult } from "@/lib/productUrlImport";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { parseAmazonLink } from "@/lib/affiliate/amazonLink";
import {
  consumeRateLimit,
  RATE_LIMITED_ERROR,
  RATE_LIMITED_MESSAGE,
  type RateLimitDecision,
} from "@/lib/server/rateLimit";

export const HARD_MAX_URLS = 20;

export type ProductUrlImportHandlerDeps = {
  getUserId?: (request: Request) => Promise<string | null>;
  consumeRateLimit?: (userId: string) => Promise<RateLimitDecision>;
  importProductUrls?: (urls: string[]) => Promise<ProductUrlImportResult[]>;
};

/**
 * POST /api/import/product-urls — server-side page fetch for product image import.
 *
 * This route makes outbound requests on the caller's behalf, so it is an SSRF-adjacent
 * fetch proxy with a real cost surface. Order matters and mirrors /api/fetch-og:
 *   1. auth       — anonymous callers get 401 before anything else runs
 *   2. rate limit — per authenticated user (`url_import` bucket), before body parsing
 *   3. body       — validation, then outbound fetches
 * The only client (`fetchProductUrlImport`) is used inside /app/** (session-guarded by
 * proxy.ts), so there is no legitimate anonymous caller.
 */
export async function handlePost(request: Request, deps: ProductUrlImportHandlerDeps = {}) {
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

  const urls = (body as { urls?: unknown } | null)?.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return NextResponse.json({ error: "urls array is required" }, { status: 400 });
  }

  if (urls.length > HARD_MAX_URLS) {
    return NextResponse.json({ error: `Maximum ${HARD_MAX_URLS} URLs per request` }, { status: 400 });
  }

  const stringUrls = urls.filter((u): u is string => typeof u === "string");
  // Amazon links are rejected by the generic validator but have their own channel.
  // FR-04 marketplaces (Temu/Shein/AliExpress/TikTok Shop) are also rejected by the
  // generic validator, but importUrl() gives them a manual-entry result instead of a
  // fetch — so they must reach importUrl too, not the early `failed` shortcut below.
  const importable = (u: string) => {
    const v = validateImportUrl(u);
    return v.ok || !!v.marketplace || parseAmazonLink(u).ok;
  };
  const invalid = stringUrls.filter(u => !importable(u));
  if (invalid.length === stringUrls.length && stringUrls.length > 0) {
    const results = stringUrls.map(sourceUrl => {
      const v = validateImportUrl(sourceUrl);
      return {
        sourceUrl:    sourceUrl.trim(),
        sourceDomain: "",
        status:       "failed" as const,
        error:        v.ok ? "Invalid URL" : v.error,
      };
    });
    return NextResponse.json({ results });
  }

  const results = await (deps.importProductUrls ?? importProductUrls)(stringUrls);
  return NextResponse.json({ results });
}
