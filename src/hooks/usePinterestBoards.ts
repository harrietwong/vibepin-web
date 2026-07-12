"use client";

/**
 * usePinterestBoards — ONE shared fetch of the connected account's boards.
 *
 * Uses SWR (already a project dependency) keyed by a constant, so every consumer
 * (board cards, editors) dedupes to a single request and shares the cache. Handles
 * loading / error / refresh / disconnected‑account state. Do NOT call
 * fetchPinterestBoards per card.
 */

import useSWR from "swr";
import {
  fetchPinterestBoards,
  type PinterestBoard,
  type PinterestClientError,
} from "@/lib/pinterestClient";

const MAX_PAGES = 6; // ~600 boards

async function fetchAllBoards(): Promise<PinterestBoard[]> {
  const all: PinterestBoard[] = [];
  let bookmark: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchPinterestBoards(bookmark);
    all.push(...page.items);
    if (!page.bookmark) break;
    bookmark = page.bookmark;
  }
  return all;
}

/**
 * Classify a boards-fetch failure into distinct, actionable states. These must NOT be
 * collapsed together: only a genuine "no connection" should tell the user to Connect.
 *   - not_connected  → HTTP 409 / code not_connected (no Pinterest connection at all)
 *   - needs_reconnect→ HTTP 401 / needsReconnect (token expired / scopes revoked)
 *   - api_error      → any other failure (5xx / network / unexpected)
 */
type BoardsFailure = "none" | "not_connected" | "needs_reconnect" | "api_error";
function classify(err: PinterestClientError | undefined): BoardsFailure {
  if (!err) return "none";
  if (err.needsReconnect === true || err.code === "needs_reconnect" || err.httpStatus === 401) return "needs_reconnect";
  if (err.code === "not_connected" || err.httpStatus === 409) return "not_connected";
  return "api_error";
}

export type UsePinterestBoards = {
  boards: PinterestBoard[];
  loading: boolean;
  /** True only for a genuine no-connection state (drives the "Connect" prompt). */
  disconnected: boolean;
  /** True when a real connection needs re-authorization (expired token / missing scopes). */
  needsReconnect: boolean;
  /** A real boards API failure (NOT a connection state) — surface an error, not "Connect". */
  error: PinterestClientError | null;
  refresh: () => void;
};

export function usePinterestBoards(): UsePinterestBoards {
  const { data, error, isLoading, mutate } = useSWR<PinterestBoard[], PinterestClientError>(
    "pinterest:boards",
    fetchAllBoards,
    { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 60_000 },
  );

  const err = (error as PinterestClientError | undefined) ?? undefined;
  const failure = classify(err);

  return {
    boards: data ?? [],
    loading: isLoading,
    // Disconnected / needs-reconnect are normal connection states, not hard errors.
    // Only a true api_error is surfaced so the UI shows a retry state (never "Connect").
    disconnected: failure === "not_connected",
    needsReconnect: failure === "needs_reconnect",
    error: failure === "api_error" ? (err ?? null) : null,
    refresh: () => { void mutate(); },
  };
}
