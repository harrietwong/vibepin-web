"use client";

/**
 * Tiny in-memory session cache for the Pinterest connection status + boards list,
 * shared across every DraftDetailsDrawer mount within the page's lifetime. Lets
 * reopening a Pin drawer paint boards instantly instead of re-running the full
 * status → boards network round trip (including a live Pinterest API call) from
 * scratch every time.
 *
 * Deliberately minimal — module-scoped variable, not persisted, resets on a full
 * page reload. This is a targeted perf fix for one drawer, not a general data
 * layer. Call invalidate() right after a fresh Pinterest OAuth connect so a stale
 * pre-connect ("not connected") cache entry is never served after the user just
 * connected.
 */

import type { PinterestBoard, PinterestStatus } from "@/lib/pinterestClient";

export type CachedBoardsResult = {
  status: PinterestStatus;
  boards: PinterestBoard[];
  fetchedAt: number;
};

/** Reuse without a background refetch if newer than this. */
const FRESH_MS = 30_000;
/** Never paint from cache older than this, even as an instant placeholder. */
const STALE_MS = 5 * 60_000;

let cache: CachedBoardsResult | null = null;

/** Returns the cached result, or null if there is none or it's too old to trust at all. */
export function getCachedBoardsResult(): CachedBoardsResult | null {
  if (!cache) return null;
  if (Date.now() - cache.fetchedAt > STALE_MS) return null;
  return cache;
}

/** True when the cache is fresh enough to skip a background revalidation entirely. */
export function isCacheFresh(entry: CachedBoardsResult): boolean {
  return Date.now() - entry.fetchedAt < FRESH_MS;
}

export function setCachedBoardsResult(status: PinterestStatus, boards: PinterestBoard[]): void {
  cache = { status, boards, fetchedAt: Date.now() };
}

/** Call right after a fresh OAuth connect so a stale pre-connect cache is never reused. */
export function invalidateBoardsCache(): void {
  cache = null;
}
