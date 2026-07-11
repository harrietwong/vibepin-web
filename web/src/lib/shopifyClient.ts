"use client";

/**
 * Client-side helper for the internal /api/integrations/shopify/* routes
 * (WP4, §6 of the Phase 1 implementation plan). Uses the shared Supabase SSR
 * browser client (see supabaseBrowser.ts) to attach `Authorization: Bearer
 * <access token>` — the same convention as pinterestClient.ts / socialClient.ts.
 */

import { freshAccessToken } from "@/lib/supabaseBrowser";

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = await freshAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export type ShopifyClientError = Error & { code?: string; httpStatus?: number };

function toClientError(body: { error?: string; code?: string }, httpStatus: number): ShopifyClientError {
  const err = new Error(body.error || `Shopify request failed (${httpStatus})`) as ShopifyClientError;
  err.code = body.code;
  err.httpStatus = httpStatus;
  return err;
}

async function parseError(res: Response): Promise<ShopifyClientError> {
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    return toClientError(body, res.status);
  } catch {
    return toClientError({}, res.status);
  }
}

// ── Types (client-safe projections — mirror server/shopify/connectionStore.ts) ─

export type ShopifyConnectionState = "connected" | "degraded" | "reauth_required" | "disconnected";
export type ShopifySyncState = "idle" | "running" | "completed" | "limit_reached" | "error";

export type ShopifySyncStatus = {
  status: ShopifySyncState;
  syncedCount: number;
  totalCount: number | null;
  cursor: string | null;
  error: string | null;
  startedAt: string | null;
  /** True when an errored run kept its cursor and "Sync now" can resume it. */
  resumable: boolean;
};

export type ShopifyConnectionStatus = {
  id: string;
  shopDomain: string;
  shopName: string | null;
  primaryDomain: string | null;
  status: ShopifyConnectionState;
  scopes: string[];
  lastFullSyncAt: string | null;
  uninstalledAt: string | null;
  disconnectedAt: string | null;
  updatedAt: string | null;
  sync: ShopifySyncStatus;
};

export type ShopifyPlan = { key: string; maxStores: number; maxSyncedProducts: number };

export type ShopifyStatusResponse = {
  configured: boolean;
  connections: ShopifyConnectionStatus[];
  plan: ShopifyPlan;
};

// ── status (60s in-memory cache, invalidated on connect/disconnect/sync) ──────

const STATUS_TTL_MS = 60_000;
let statusCache: { at: number; value: ShopifyStatusResponse } | null = null;
let statusInflight: Promise<ShopifyStatusResponse> | null = null;

/** Drop the cached status so the next getShopifyStatus() call re-fetches. */
export function invalidateShopifyStatusCache(): void {
  statusCache = null;
  statusInflight = null;
}

async function fetchShopifyStatusDirect(): Promise<ShopifyStatusResponse> {
  const res = await fetch("/api/integrations/shopify/status", {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ShopifyStatusResponse;
}

/**
 * Connection + sync status, cached in-memory for 60s (concurrent callers share
 * one in-flight request). Pass `{ fresh: true }` to bypass the cache — used
 * right after connect/disconnect/sync progress so the UI never shows stale state.
 */
export async function getShopifyStatus(opts?: { fresh?: boolean }): Promise<ShopifyStatusResponse> {
  if (!opts?.fresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value;
  }
  if (!statusInflight) {
    statusInflight = fetchShopifyStatusDirect()
      .then(value => {
        statusCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        statusInflight = null;
      });
  }
  return statusInflight;
}

// ── connect ─────────────────────────────────────────────────────────────────

/**
 * Start (or reconnect) a Shopify OAuth flow for the given shop domain. Returns
 * the Shopify authorize URL; the caller navigates the browser to it
 * (window.location.assign). Tolerates a pasted full URL — the server also
 * normalizes, but trimming here avoids a round trip for the common case.
 */
export async function connectShopify(shopDomain: string): Promise<{ url: string }> {
  const res = await fetch("/api/integrations/shopify/connect", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ shopDomain: shopDomain.trim() }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as { url: string };
}

// ── disconnect ──────────────────────────────────────────────────────────────

export async function disconnectShopify(connectionId: string): Promise<{ ok: true }> {
  const res = await fetch("/api/integrations/shopify/disconnect", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ connectionId }),
  });
  invalidateShopifyStatusCache();
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as { ok: true };
}

// ── sync ────────────────────────────────────────────────────────────────────

export type ShopifySyncChunkResult = {
  state: "running" | "completed" | "limit_reached" | "error";
  hasMore: boolean;
  syncedCount: number;
  totalCount?: number | null;
  cursor?: string | null;
  error?: string;
};

type ChunkOutcome =
  | { kind: "ok"; result: ShopifySyncChunkResult }
  | { kind: "conflict" }
  | { kind: "error"; error: ShopifyClientError };

async function postSyncChunk(connectionId: string, fresh: boolean): Promise<ChunkOutcome> {
  const res = await fetch("/api/integrations/shopify/sync", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ connectionId, fresh }),
  });
  if (res.status === 409) return { kind: "conflict" };
  if (!res.ok) return { kind: "error", error: await parseError(res) };
  return { kind: "ok", result: (await res.json()) as ShopifySyncChunkResult };
}

export type ShopifySyncProgress = {
  syncedCount: number;
  totalCount?: number | null;
  state: ShopifySyncChunkResult["state"];
};

export type RunSyncOptions = {
  /** Force a brand-new run (cursor/counters reset) even if the last run ended in error. */
  fresh?: boolean;
  onProgress?: (progress: ShopifySyncProgress) => void;
  /** Test hook: override the 409 poll backoff (ms). Default 1500. */
  pollIntervalMs?: number;
  /** Test hook: cap the number of 409 poll attempts before giving up. Default 40 (~60s). */
  maxConflictPolls?: number;
  signal?: AbortSignal;
};

export type RunSyncResult =
  | { state: "completed" | "limit_reached"; syncedCount: number; totalCount?: number | null }
  | { state: "error"; syncedCount: number; error: string }
  /** The lock never released within maxConflictPolls — present as "already syncing", not a failure. */
  | { state: "sync_in_progress"; syncedCount: number };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Drive one Shopify sync run to a terminal state (§6.6 / §3.4): loop
 * POST /sync while the server reports `hasMore: true`, forwarding progress via
 * onProgress after every chunk. Stops on a terminal state (completed /
 * limit_reached / error) or a non-2xx response (thrown to the caller).
 *
 * A 409 (`sync_in_progress` — another tab/run holds the lock) is not treated
 * as failure: poll GET /status (bypassing the cache) until the lock is
 * released, then resume with fresh:false so the takeover continues from the
 * persisted cursor. If the lock never releases within maxConflictPolls,
 * resolve as `{ state: "sync_in_progress" }` so the caller can show a
 * non-blocking "already syncing" state instead of hanging forever.
 */
export async function runSyncToCompletion(
  connectionId: string,
  opts: RunSyncOptions = {},
): Promise<RunSyncResult> {
  const pollMs = opts.pollIntervalMs ?? 1500;
  const maxPolls = opts.maxConflictPolls ?? 40;
  let fresh = opts.fresh ?? false;
  let conflictPolls = 0;
  let lastSyncedCount = 0;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new DOMException("Shopify sync aborted", "AbortError");
    }

    const outcome = await postSyncChunk(connectionId, fresh);
    fresh = false; // only the very first chunk may force a fresh run

    if (outcome.kind === "conflict") {
      // Poll /status until the lock is released (sync.status no longer
      // "running") or we give up, THEN retry /sync — never retry /sync on
      // every poll tick, which would just re-produce 409s while the other
      // run is genuinely still in flight.
      for (;;) {
        conflictPolls++;
        if (conflictPolls > maxPolls) {
          return { state: "sync_in_progress", syncedCount: lastSyncedCount };
        }
        await sleep(pollMs);
        const status = await getShopifyStatus({ fresh: true });
        const conn = status.connections.find(c => c.id === connectionId);
        lastSyncedCount = conn?.sync.syncedCount ?? lastSyncedCount;
        opts.onProgress?.({
          syncedCount: lastSyncedCount,
          totalCount: conn?.sync.totalCount,
          state: "running",
        });
        if (!conn || conn.sync.status !== "running") break; // released — retry /sync below
      }
      continue; // retry postSyncChunk now that the lock appears free
    }

    if (outcome.kind === "error") throw outcome.error;

    const result = outcome.result;
    lastSyncedCount = result.syncedCount;
    opts.onProgress?.({ syncedCount: result.syncedCount, totalCount: result.totalCount, state: result.state });

    if (result.state === "completed" || result.state === "limit_reached") {
      invalidateShopifyStatusCache();
      return { state: result.state, syncedCount: result.syncedCount, totalCount: result.totalCount };
    }
    if (result.state === "error") {
      invalidateShopifyStatusCache();
      return { state: "error", syncedCount: result.syncedCount, error: result.error ?? "Sync failed" };
    }
    // state === "running": loop immediately for the next chunk while hasMore
    // is true. Defensive fallback if the server ever returns running+no-more.
    if (!result.hasMore) {
      invalidateShopifyStatusCache();
      return { state: "completed", syncedCount: result.syncedCount, totalCount: result.totalCount };
    }
  }
}
