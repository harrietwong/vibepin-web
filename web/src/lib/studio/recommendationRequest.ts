/**
 * Pure builders + a stale-response guard for the drawer's recommendation flow.
 *
 * Extracted from AiVersionDrawer so the behaviour the review requires — a scratch
 * (draft-less) product still requests recommendations, the request carries the
 * CURRENT product's title/type/tags/analysis, and a late response for a previous
 * product is discarded — can be unit-tested without a DOM.
 */

import type { CanonicalProductSelection } from "@/lib/studio/productSelection";

export type ProductImageAnalysis = {
  category?: string;
  style?: string;
  colors?: string[];
  visibleObjects?: string[];
  imageSummary?: string;
};

/** Where the `imageAnalysis` in a request came from — never guessed, never implied. */
export type AnalysisSource = "draft" | "stateless" | "none";
/** Lifecycle of that analysis at request time. */
export type AnalysisStatus = "ready" | "pending" | "failed" | "none";
/** Why an image analysis failed, in the only shapes the UI reacts to differently. */
export type AnalysisErrorCode = "rate_limited" | "unauthenticated" | "timeout" | "network" | "other";

/** Hard cap on `excludeIds` (the server truncates too — this keeps the payload small). */
export const EXCLUDE_IDS_CAP = 72;

/**
 * Observability + serving context the drawer attaches to a recommendation request.
 *
 * Every field is optional on the server (old clients and existing fixtures must keep
 * working); the client sends all of them so a served result can be explained after the
 * fact — which analysis it had, which image, which day's seed, what was excluded.
 */
export type ReferenceServeContext = {
  draftId?: string;
  requestId: string;
  imageKey?: string;
  analysisSource: AnalysisSource;
  analysisStatus: AnalysisStatus;
  seed?: string;
  excludeIds?: string[];
};

export type ReferenceRequestBody = {
  category?: string;
  imageAnalysis?: ProductImageAnalysis;
  product?: { title: string; imageUrl?: string; type?: string; tags?: string[] };
  limit: number;
  // ── Serving context (all optional server-side, see §1.1) ────────────────────
  draftId?: string;
  requestId?: string;
  imageKey?: string;
  analysisSource?: AnalysisSource;
  analysisStatus?: AnalysisStatus;
  seed?: string;
  excludeIds?: string[];
};

/** Honest tag list for a selection: its own tags, else its category/keyword/format. */
export function selectionTags(sel: CanonicalProductSelection | null): string[] {
  if (!sel) return [];
  if (sel.tags && sel.tags.length) return sel.tags.filter(Boolean);
  return [sel.category, sel.keyword, sel.visualFormat]
    .map(v => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
}

/**
 * Build the /api/reference-candidates request body for the current primary product.
 *
 * `draftAnalysis` is the draft's own stored analysis and applies ONLY when the
 * primary product IS the draft's image (draftImageSelected). Otherwise the
 * product's own freshly-fetched analysis (`productAnalysis`) is used — never the
 * previous product's. When neither is available the request omits imageAnalysis and
 * the API answers category_fallback, which the UI reports honestly.
 *
 * `serve` is optional observability/serving context (§1.1). It is merged through
 * as-is except for `excludeIds`, which is de-duplicated and capped at 72 (keeping the
 * most recent ids) so a long refresh session cannot grow the payload without bound.
 */
export function buildReferenceRequestBody(input: {
  primary: CanonicalProductSelection | null;
  draftImageSelected: boolean;
  draftAnalysis?: ProductImageAnalysis & { title?: string };
  productAnalysis?: ProductImageAnalysis;
  limit?: number;
  serve?: ReferenceServeContext;
}): ReferenceRequestBody {
  const { primary, draftImageSelected, draftAnalysis, productAnalysis } = input;
  const tags = selectionTags(primary);
  const title = draftImageSelected
    ? primary?.title?.trim() || draftAnalysis?.title?.trim() || ""
    : primary?.title?.trim() || "";

  const imageAnalysis = draftImageSelected
    ? (draftAnalysis
        ? {
            category: draftAnalysis.category,
            style: draftAnalysis.style,
            colors: draftAnalysis.colors,
            visibleObjects: draftAnalysis.visibleObjects,
            imageSummary: draftAnalysis.imageSummary,
          }
        : undefined)
    : (productAnalysis
        ? {
            category: productAnalysis.category || primary?.category,
            style: productAnalysis.style,
            colors: productAnalysis.colors,
            visibleObjects: productAnalysis.visibleObjects,
            imageSummary: productAnalysis.imageSummary,
          }
        : undefined);

  const serve = input.serve;
  const excludeIds = serve?.excludeIds?.length
    ? mergeExcludeIds([], serve.excludeIds)
    : undefined;

  return {
    category: draftImageSelected
      ? (draftAnalysis?.category || primary?.category || undefined)
      : (productAnalysis?.category || primary?.category || undefined),
    imageAnalysis,
    product: (title || primary)
      ? {
          title,
          imageUrl: primary?.imageUrl || undefined,
          type: primary?.productType || undefined,
          tags: tags.length ? tags : undefined,
        }
      : undefined,
    limit: input.limit ?? 9,
    ...(serve
      ? {
          draftId: serve.draftId,
          requestId: serve.requestId,
          imageKey: serve.imageKey,
          analysisSource: serve.analysisSource,
          analysisStatus: serve.analysisStatus,
          seed: serve.seed,
          excludeIds: excludeIds?.length ? excludeIds : undefined,
        }
      : {}),
  };
}

/**
 * Resolve a recommendation basis honestly.
 *
 * Only the two product-level bases pass through; anything else — an unknown value,
 * a missing field, an empty/failed response — collapses to category_fallback, which
 * the UI renders as "Category inspiration". This is what prevents a fabricated
 * "Recommended for this product" claim.
 */
export function resolveBasis(
  raw: string | undefined | null,
  itemCount?: number,
): "product_analysis" | "product_text" | "category_fallback" {
  // With no items there is no product-level result to justify the stronger claim,
  // so an empty list collapses to category_fallback regardless of what the field says.
  if (itemCount === 0) return "category_fallback";
  return raw === "product_analysis" || raw === "product_text" ? raw : "category_fallback";
}

/**
 * A minimal keyed guard for async results. A response is applied only when its key
 * still matches the current product key — the mechanism the drawer uses (via
 * AbortController + this check) so a late response for product A cannot overwrite
 * product B's recommendations / basis / analysis.
 */
export function isCurrentResult(resultKey: string, currentKey: string): boolean {
  return resultKey === currentKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis state (P0-a/b): what the drawer actually knows about the primary
// product's image analysis, derived from the two real sources — the draft's own
// stored analysis, and the stateless per-URL analysis used on the swap path.
// The UI reads THIS, not `recommendationBasis`: basis describes what the server
// could rank with, state describes what the client has. Conflating them is what
// made a missing analysis look like a weak library.
// ─────────────────────────────────────────────────────────────────────────────

export type AnalysisState = {
  status: "none" | "pending" | "ready" | "failed";
  source: AnalysisSource;
  errorCode?: AnalysisErrorCode;
  retryAfter?: number;
};

/**
 * Derive the honest analysis state for the CURRENT primary image.
 *
 * - draft image selected → the draft's own stored lifecycle (`source: "draft"`);
 *   a draft with no status yet is "none", not "pending" (nothing was ever started).
 * - otherwise the stateless swap path (`source: "stateless"`): no record, or a record
 *   for a DIFFERENT url, means the request for this url is in flight or not yet sent
 *   → "pending". A record with an analysis is "ready". A record without one is a
 *   failure — with its errorCode when we have it, and "other" for the legacy `{url}`
 *   marker that older code wrote with no reason attached.
 * - no primary url at all → nothing to analyse: `{ status: "none", source: "none" }`.
 *
 * Draft-path `errorCode`/`retryAfter` pass through as stored. startImageAnalysis
 * clears both on success, so a "ready" draft never carries a stale error.
 */
export function deriveAnalysisState(args: {
  draftImageSelected: boolean;
  draftStatus?: "pending" | "ready" | "failed";
  draftError?: AnalysisErrorCode;
  draftRetryAfter?: number;
  swapped?: { url: string; analysis?: unknown; error?: AnalysisErrorCode; retryAfter?: number } | null;
  primaryUrl?: string;
}): AnalysisState {
  if (args.draftImageSelected) {
    const state: AnalysisState = { status: args.draftStatus ?? "none", source: "draft" };
    if (args.draftError) state.errorCode = args.draftError;
    if (typeof args.draftRetryAfter === "number" && Number.isFinite(args.draftRetryAfter)) {
      state.retryAfter = args.draftRetryAfter;
    }
    return state;
  }

  if (!args.primaryUrl) return { status: "none", source: "none" };

  const swapped = args.swapped;
  // No record for THIS url → the request is in flight (or about to be issued).
  if (!swapped || swapped.url !== args.primaryUrl) return { status: "pending", source: "stateless" };
  if (swapped.analysis) return { status: "ready", source: "stateless" };

  const state: AnalysisState = {
    status: "failed",
    source: "stateless",
    errorCode: swapped.error ?? "other",
  };
  if (typeof swapped.retryAfter === "number" && Number.isFinite(swapped.retryAfter)) {
    state.retryAfter = swapped.retryAfter;
  }
  return state;
}

/**
 * Classify an analysis failure into the few codes the UI treats differently.
 *
 * The HTTP status wins when we have one (429 = our own per-user AI ceiling, 401 = a
 * signed-out session — neither is an image or provider problem). Otherwise we read the
 * error itself: an abort/timeout is not a failed analysis, and a fetch-level TypeError
 * is a network problem, not a rejection. Everything unrecognised stays "other" rather
 * than being filed under a cause we did not observe.
 */
export function classifyAnalysisError(err: unknown, httpStatus?: number): AnalysisErrorCode {
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 401) return "unauthenticated";

  const name = typeof (err as { name?: unknown })?.name === "string" ? (err as { name: string }).name : "";
  const raw =
    typeof (err as { message?: unknown })?.message === "string"
      ? (err as { message: string }).message
      : typeof err === "string"
        ? err
        : "";
  const message = raw.toLowerCase();

  // startImageAnalysis throws these exact markers when it has already read the status.
  if (message.includes("rate_limited") || message.includes("rate limited")) return "rate_limited";
  if (message.includes("unauthenticated") || message.includes("unauthorized")) return "unauthenticated";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (message.includes("timeout") || message.includes("timed out") || message.includes("abort")) return "timeout";
  if (err instanceof TypeError) return "network";
  if (message.includes("network") || message.includes("failed to fetch") || message.includes("load failed")) {
    return "network";
  }
  return "other";
}

/** `Retry-After` in whole seconds. A date form, a negative, or junk → undefined. */
export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (typeof headerValue !== "string") return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.floor(seconds);
}

/**
 * A per-key, per-UTC-day seed. Stable for a whole day so a user who reopens the
 * drawer sees the same sample (no churn), and different tomorrow so the library
 * rotates without any stored state.
 */
export function dailySeed(key: string, now: Date): string {
  const ms = now?.getTime?.();
  const day = typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
  return `${key}:${day}`;
}

/**
 * Apply an analysis result only if the image it was started for is still the draft's
 * image. Same guard as the recommendation flow's key check: a swap during the request
 * must not stamp product A's analysis onto product B.
 */
export function shouldApplyAnalysis(startedUrl: string, currentUrl?: string | null): boolean {
  return startedUrl === currentUrl;
}

/** djb2 → 8 hex chars. Not a security hash; a stable id for a URL when SubtleCrypto is absent. */
export function djb2Hex(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A short, stable key for an image URL: sha-256's first 16 hex chars when SubtleCrypto
 * is available (browser, secure context), djb2 otherwise. Only ever used to group
 * events by image — never as a secret, never reversed.
 */
export async function imageKeyFor(url: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return djb2Hex(url);
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(url));
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Insecure context / unavailable / rejected — a weaker key beats no key.
    return djb2Hex(url);
  }
}

/**
 * Accumulate "already shown / already picked" ids for the refresh path.
 *
 * De-duplicated, capped at `cap` keeping the MOST RECENT ids (FIFO drop). Re-adding an
 * id refreshes its recency — an id that is still on screen must not be evicted just
 * because it was first seen long ago.
 */
export function mergeExcludeIds(prev: string[], add: string[], cap = EXCLUDE_IDS_CAP): string[] {
  if (cap <= 0) return [];
  const out: string[] = [];
  for (const candidate of [...(prev ?? []), ...(add ?? [])]) {
    if (typeof candidate !== "string") continue;
    const id = candidate.trim();
    if (!id) continue;
    const at = out.indexOf(id);
    if (at >= 0) out.splice(at, 1);
    out.push(id);
  }
  return out.slice(-cap);
}

/**
 * Merge a "Show different ideas" response into the grid the user is looking at.
 *
 * The refresh must not yank away a card the user already picked: an id in
 * `selectedIds` keeps the exact slot it occupied, and only the OTHER slots are
 * refilled — in order — from `incoming`. When the server has fewer fresh ideas than
 * there are slots (Tier-1 supply exhausted after a few refreshes), the remaining slots
 * fall back to the previous list's unselected items rather than collapsing the grid,
 * so a refresh never looks like a failure. Every id appears at most once.
 *
 * A selected item that sat beyond `limit` cannot keep a position that no longer
 * exists; it stays selected in the reference tray, it just is not re-pinned here.
 */
export function mergeRefreshedRecommendations<T extends { id: string }>(
  prev: T[],
  selectedIds: string[],
  incoming: T[],
  limit: number,
): T[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const prevList = Array.isArray(prev) ? prev : [];
  const incomingList = Array.isArray(incoming) ? incoming : [];
  const selected = new Set((selectedIds ?? []).filter(id => typeof id === "string"));

  // 1) Pin the kept (selected) cards to the slots they already occupy.
  const pinned = new Map<number, T>();
  const used = new Set<string>();
  prevList.forEach((item, index) => {
    if (!item || typeof item.id !== "string" || index >= limit) return;
    if (!selected.has(item.id) || used.has(item.id)) return;
    pinned.set(index, item);
    used.add(item.id);
  });

  // 2) Fill queue: fresh results first, then the previous list's leftovers as backfill.
  const queue: T[] = [];
  for (const item of [...incomingList, ...prevList]) {
    if (!item || typeof item.id !== "string" || !item.id) continue;
    if (used.has(item.id)) continue;
    used.add(item.id);
    queue.push(item);
  }

  // 3) Lay out: a pinned slot keeps its card, every other slot takes the next queued
  //    one. Shorter than `limit` only when there genuinely are not enough distinct items.
  const total = Math.min(limit, pinned.size + queue.length);
  const out: T[] = [];
  let next = 0;
  for (let slot = 0; slot < limit && out.length < total; slot++) {
    const kept = pinned.get(slot);
    if (kept) { out.push(kept); continue; }
    if (next < queue.length) out.push(queue[next++]);
  }
  return out;
}
