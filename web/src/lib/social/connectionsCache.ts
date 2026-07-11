"use client";

/**
 * Tiny in-memory session cache for /api/social/connections, mirroring
 * lib/pinterest/boardsCache.ts. Lets the "Publishing accounts" section paint
 * instantly when a second Pin drawer is opened in the same session instead of
 * re-running the full connections fetch from a blank loading state every time.
 *
 * Module-scoped, not persisted, resets on a full page reload — a targeted perf
 * fix for one section, not a general data layer.
 */

import type { PlatformConnectionSummary } from "@/lib/social/types";

export type CachedConnectionsResult = {
  platforms: PlatformConnectionSummary[];
  fetchedAt: number;
};

/** Reuse without a background refetch if newer than this. */
const FRESH_MS = 30_000;
/** Never paint from cache older than this, even as an instant placeholder. */
const STALE_MS = 5 * 60_000;

let cache: CachedConnectionsResult | null = null;

export function getCachedConnections(): CachedConnectionsResult | null {
  if (!cache) return null;
  if (Date.now() - cache.fetchedAt > STALE_MS) return null;
  return cache;
}

export function isConnectionsCacheFresh(entry: CachedConnectionsResult): boolean {
  return Date.now() - entry.fetchedAt < FRESH_MS;
}

export function setCachedConnections(platforms: PlatformConnectionSummary[]): void {
  cache = { platforms, fetchedAt: Date.now() };
}

/** Call right after a fresh OAuth connect so a stale pre-connect cache is never reused. */
export function invalidateConnectionsCache(): void {
  cache = null;
}
