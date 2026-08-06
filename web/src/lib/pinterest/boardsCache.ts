"use client";

/**
 * Tiny in-memory session cache for the Pinterest connection status + boards list,
 * shared across every DraftDetailsDrawer mount within the page's lifetime. Lets
 * reopening a Pin drawer paint boards instantly instead of re-running the full
 * status → boards network round trip (including a live Pinterest API call) from
 * scratch every time.
 *
 * Deliberately minimal — module-scoped map, not persisted, resets on a full
 * page reload. This is a targeted perf fix for one drawer, not a general data
 * layer. Call invalidate() right after a fresh Pinterest OAuth connect so a stale
 * pre-connect ("not connected") cache entry is never served after the user just
 * connected.
 *
 * Keyed by CONNECTION (Phase C): boards belong to one Pinterest account, so a cache
 * shared across accounts would paint account A's boards while a Pin targets account B —
 * and the user could pick a board that does not exist where the Pin actually publishes.
 * Callers that don't name a connection use the DEFAULT_KEY bucket, which is the
 * default connection — byte-for-byte the single-account behaviour that came before.
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

/** Bucket for callers that don't name a connection: the user's default account. */
const DEFAULT_KEY = "default";

const cache = new Map<string, CachedBoardsResult>();

function keyFor(connectionId?: string | null): string {
  const id = typeof connectionId === "string" ? connectionId.trim() : "";
  return id || DEFAULT_KEY;
}

/** Returns the cached result for this connection, or null if there is none or it's
 *  too old to trust at all. */
export function getCachedBoardsResult(connectionId?: string | null): CachedBoardsResult | null {
  const entry = cache.get(keyFor(connectionId));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > STALE_MS) return null;
  return entry;
}

/** True when the cache is fresh enough to skip a background revalidation entirely. */
export function isCacheFresh(entry: CachedBoardsResult): boolean {
  return Date.now() - entry.fetchedAt < FRESH_MS;
}

export function setCachedBoardsResult(
  status: PinterestStatus,
  boards: PinterestBoard[],
  connectionId?: string | null,
): void {
  cache.set(keyFor(connectionId), { status, boards, fetchedAt: Date.now() });
}

/**
 * Call right after a fresh OAuth connect (or a disconnect) so a stale pre-connect cache
 * is never reused. Clears EVERY account's entry, not just one: connecting or removing an
 * account can change which row is the default, so any bucket may now be wrong.
 */
export function invalidateBoardsCache(): void {
  cache.clear();
}
