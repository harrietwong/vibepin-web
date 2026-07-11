/**
 * Sharded Shopify product sync (server-only, WP3, §3.4).
 *
 * `runSyncChunk` processes 1–3 pages (50 products each, most-recently-updated
 * first) of one connection's catalogue per call and returns a §6.6 chunk result.
 * The driving client re-POSTs while `hasMore` is true until a terminal state
 * (completed / limit_reached / error).
 *
 * All sync state lives on the store_connections row (裁决 j). Concurrency and
 * crash recovery ride on connectionStore primitives:
 *   - acquireSyncLock : CAS lock; fresh run resets cursor, resume takes over an
 *                       expired lock and keeps the cursor.
 *   - updateSyncProgress : per-page cursor/count write + lock heartbeat; returns
 *                          null when a newer run superseded us → abandon.
 *   - releaseSyncLock : non-terminal pause expires the lock so the next chunk
 *                       resumes without a 409.
 *   - finishSync : terminal transition (completed sweeps tombstones; error keeps
 *                  the cursor for resume).
 *
 * The Admin token is decrypted here, used only for adminGraphql, and never logged.
 */

import { randomUUID } from "node:crypto";

import {
  ShopifyAuthError,
  ShopifyThrottledError,
  adminGraphql,
  type ThrottleStatus,
} from "./adminClient";
import {
  acquireSyncLock,
  decryptAccessToken,
  finishSync,
  getConnection,
  markReauthRequired,
  releaseSyncLock,
  updateSyncProgress,
} from "./connectionStore";
import { normalizeProduct, type ShopifyProductNode } from "./normalize";
import { tombstoneStale, upsertProductsBatch } from "./productStore";
import { getEntitlements, resolvePlan } from "../entitlements";

// ── Typed control-flow errors (route maps these to HTTP codes) ─────────────────

/** Connection missing / disconnected / reauth_required at chunk entry. */
export class SyncNotConnectedError extends Error {
  code = "not_connected" as const;
  constructor(message = "Shopify store is not connected") {
    super(message);
    this.name = "SyncNotConnectedError";
  }
}

/** Another run holds a live lock — CAS acquire lost. */
export class SyncInProgressError extends Error {
  code = "sync_in_progress" as const;
  constructor(message = "A sync is already running for this store") {
    super(message);
    this.name = "SyncInProgressError";
  }
}

/** A newer run took over this connection mid-chunk — abandon quietly. */
export class SyncSupersededError extends Error {
  code = "sync_superseded" as const;
  constructor(message = "This sync run was superseded by a newer run") {
    super(message);
    this.name = "SyncSupersededError";
  }
}

// ── §6.6 result shape ──────────────────────────────────────────────────────────

export type SyncChunkResult = {
  state: "running" | "completed" | "limit_reached" | "error";
  hasMore: boolean;
  syncedCount: number;
  totalCount?: number | null;
  cursor?: string | null;
  error?: string;
};

// ── Tunables (test-injectable) ─────────────────────────────────────────────────

type Tuning = {
  pageSize: number;
  maxPages: number;
  pageBudgetMs: number;
  throttleBackoffMs: number;
};

let TUNING: Tuning = {
  pageSize: 50,
  maxPages: 3,
  pageBudgetMs: 20_000,
  throttleBackoffMs: 2_000,
};

/** Test-only: shrink budgets / backoff so the state machine runs fast. */
export function __setTuningForTests(t: Partial<Tuning> | null): void {
  TUNING = t
    ? { ...TUNING, ...t }
    : { pageSize: 50, maxPages: 3, pageBudgetMs: 20_000, throttleBackoffMs: 2_000 };
}

// Plan resolution hits Supabase Auth (getUserById); inject it in tests.
type PlanLimitResolver = (userId: string) => Promise<number>;
let planResolver: PlanLimitResolver | null = null;

/** Test-only: override maxSyncedProducts resolution (pass null to restore). */
export function __setPlanResolverForTests(fn: PlanLimitResolver | null): void {
  planResolver = fn;
}

async function resolveMaxProducts(userId: string): Promise<number> {
  if (planResolver) return planResolver(userId);
  const plan = await resolvePlan(userId);
  return getEntitlements(plan).maxSyncedProducts;
}

// ── GraphQL ────────────────────────────────────────────────────────────────────

const PRODUCTS_QUERY = `
query SyncProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
    edges {
      node {
        id
        handle
        title
        descriptionHtml
        status
        vendor
        productType
        tags
        onlineStoreUrl
        createdAt
        updatedAt
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        featuredImage { id url width height altText }
        images(first: 20) {
          edges { node { id url width height altText } }
        }
        variants(first: 50) {
          edges { node { id title price sku availableForSale compareAtPrice image { id } } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PRODUCTS_COUNT_QUERY = `{ productsCount { count } }`;

type ProductsQueryData = {
  products?: {
    edges?: Array<{ node?: ShopifyProductNode | null } | null> | null;
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
  } | null;
};

type ProductsCountData = { productsCount?: { count?: number | null } | null };

type PageResult = {
  nodes: ShopifyProductNode[];
  hasNextPage: boolean;
  endCursor: string | null;
  cost: ThrottleStatus | null;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

async function fetchPage(
  shop: string,
  token: string,
  after: string | null,
): Promise<PageResult> {
  const { data, cost } = await adminGraphql<ProductsQueryData>(shop, token, PRODUCTS_QUERY, {
    first: TUNING.pageSize,
    after: after ?? null,
  });
  const conn = data?.products;
  const nodes = (conn?.edges ?? [])
    .map((e) => e?.node ?? null)
    .filter((n): n is ShopifyProductNode => n != null);
  return {
    nodes,
    hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
    endCursor: conn?.pageInfo?.endCursor ?? null,
    cost,
  };
}

async function fetchTotalCount(shop: string, token: string): Promise<number | null> {
  try {
    const { data } = await adminGraphql<ProductsCountData>(shop, token, PRODUCTS_COUNT_QUERY);
    const count = data?.productsCount?.count;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  } catch {
    // A missing total only weakens the "X of Y" banner — never fail the chunk on it.
    return null;
  }
}

/** Truncate the sync_error summary; never carry token-bearing detail. */
function errorSummary(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

// ── Entry point ────────────────────────────────────────────────────────────────

/**
 * Run one sync chunk for `connectionId` owned by `userId`.
 * @throws SyncNotConnectedError | SyncInProgressError | SyncSupersededError
 */
export async function runSyncChunk(
  userId: string,
  connectionId: string,
  opts?: { freshRun?: boolean },
): Promise<SyncChunkResult> {
  // 1. Ownership + status gate.
  const conn = await getConnection(userId, connectionId);
  if (!conn) throw new SyncNotConnectedError();
  if (
    conn.disconnected_at != null ||
    conn.status === "disconnected" ||
    conn.status === "reauth_required"
  ) {
    throw new SyncNotConnectedError();
  }

  // 2. Acquire (or resume) the run lock.
  const freshRun = opts?.freshRun === true;
  const runId = randomUUID();
  const locked = await acquireSyncLock(
    connectionId,
    userId,
    runId,
    freshRun ? { freshRun: true } : undefined,
  );
  if (!locked) throw new SyncInProgressError();

  if (!locked.access_token_encrypted) {
    await finishSync(connectionId, runId, "error", { error: "reauth_required" });
    throw new SyncNotConnectedError();
  }
  const token = decryptAccessToken(locked);
  const shop = locked.shop_domain;
  const primaryDomain = locked.primary_domain;
  const syncStartedAt = locked.sync_started_at ?? locked.updated_at;

  let cursor = locked.sync_cursor;
  let syncedCount = locked.synced_count ?? 0;

  const maxProducts = await resolveMaxProducts(userId);
  const budgetStart = Date.now();

  try {
    for (let page = 0; page < TUNING.maxPages; page++) {
      // ── Fetch one page, with a single throttle backoff+retry (§3.4 限流退避) ──
      let pageResult: PageResult;
      try {
        pageResult = await fetchPage(shop, token, cursor);
      } catch (err) {
        if (err instanceof ShopifyThrottledError) {
          await sleep(TUNING.throttleBackoffMs);
          try {
            pageResult = await fetchPage(shop, token, cursor);
          } catch (retryErr) {
            if (retryErr instanceof ShopifyThrottledError) {
              // Still throttled — yield the chunk; client retries next round.
              await releaseSyncLock(connectionId, runId);
              return { state: "running", hasMore: true, syncedCount, cursor };
            }
            throw retryErr;
          }
        } else {
          throw err;
        }
      }

      const normalized = pageResult.nodes.map((node) =>
        normalizeProduct(node, { shopDomain: shop, primaryDomain }),
      );

      // ── Entitlement cap (决策3: hard stop, never silent truncation) ──────────
      const remaining = maxProducts - syncedCount;
      if (normalized.length > remaining || remaining <= 0) {
        const slice = remaining > 0 ? normalized.slice(0, remaining) : [];
        if (slice.length > 0) {
          await upsertProductsBatch(userId, connectionId, slice);
          syncedCount += slice.length;
        }
        const totalCount = await fetchTotalCount(shop, token);
        await finishSync(connectionId, runId, "limit_reached", { syncedCount, totalCount });
        return { state: "limit_reached", hasMore: false, syncedCount, totalCount };
      }

      // ── Page fits: persist products + progress ──────────────────────────────
      if (normalized.length > 0) {
        await upsertProductsBatch(userId, connectionId, normalized);
        syncedCount += normalized.length;
      }
      cursor = pageResult.endCursor ?? cursor;
      const progressed = await updateSyncProgress(connectionId, runId, { cursor, syncedCount });
      if (!progressed) throw new SyncSupersededError();

      // ── Completed the whole catalogue → tombstone sweep ─────────────────────
      if (!pageResult.hasNextPage) {
        await tombstoneStale(connectionId, syncStartedAt);
        await finishSync(connectionId, runId, "completed", { syncedCount });
        return { state: "completed", hasMore: false, syncedCount };
      }

      // ── Budget guard: yield before the request gets close to timing out ─────
      if (Date.now() - budgetStart >= TUNING.pageBudgetMs) break;
    }
  } catch (err) {
    if (err instanceof SyncSupersededError) throw err; // route → 409, no finishSync
    if (err instanceof ShopifyAuthError) {
      await markReauthRequired(connectionId);
      await finishSync(connectionId, runId, "error", { error: "reauth_required", syncedCount });
      return { state: "error", hasMore: false, syncedCount, error: "reauth_required" };
    }
    // ShopifyUpstreamError / anything else: error state, cursor kept for resume.
    const summary = errorSummary(err);
    await finishSync(connectionId, runId, "error", { error: summary, syncedCount });
    return { state: "error", hasMore: false, syncedCount, error: summary };
  }

  // Ran out of page budget / page cap with more to go — pause and yield.
  await releaseSyncLock(connectionId, runId);
  return { state: "running", hasMore: true, syncedCount, cursor };
}
