"use client";

/**
 * usePinBoardDrafts — reactive Create Pins board (studioBoardV2).
 *
 * Version-cached pinDraftStore snapshot via useSyncExternalStore (stable array ref
 * between writes — no render loops), then board items + lifecycle FILTER counts +
 * selection via useMemo. Ordering: createdAt desc, id desc.
 *
 * Filters are lifecycle-only (P0): all / unscheduled / scheduled / posted / failed.
 * Board = active (non-archived) board-origin drafts (uploads + AI pins).
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { isBoardSource, type PinDraft } from "@/lib/pinDraftStore";
import {
  getPinLifecycle,
  getInFlightPublishSet,
  getInFlightVersion,
  subscribeInFlight,
  type PinLifecycle,
} from "@/lib/studio/pinLifecycle";

export type BoardFilter = "all" | "unscheduled" | "scheduled" | "posted" | "failed";

export type BoardItem = { draft: PinDraft; lifecycle: PinLifecycle };
export type BoardCounts = Record<BoardFilter, number>;

export function matchesFilter(item: BoardItem, filter: BoardFilter): boolean {
  if (filter === "all") return true;
  // "generating" is a transient state, not one of the four resting places a Pin ends
  // up in, so strict lifecycle equality matched it to NO bucket — and since the board
  // lands on "unscheduled" by default, every card vanished the instant the user hit
  // Generate, making the app's core button look dead. An in-flight Pin is on its way
  // to becoming unscheduled, so that is the one bucket it belongs in; it must not
  // pollute Scheduled / Posted / Failed, which are claims about a settled outcome.
  if (item.lifecycle === "generating") return filter === "unscheduled";
  return item.lifecycle === filter;
}

export function usePinBoardDrafts(filter: BoardFilter = "all") {
  const all = useSyncExternalStore(
    pinDraftStore.subscribe,
    pinDraftStore.getSnapshot,
    pinDraftStore.getServerSnapshot,
  );
  // Primitive version so React re-renders the "Publishing…" button state.
  const inFlightVersion = useSyncExternalStore(subscribeInFlight, getInFlightVersion, () => 0);

  const items = useMemo<BoardItem[]>(() => {
    return all
      .filter(d => !d.archivedAt && isBoardSource(d))
      .map(d => ({ draft: d, lifecycle: getPinLifecycle(d) }))
      .sort((a, b) =>
        b.draft.createdAt.localeCompare(a.draft.createdAt) ||
        b.draft.id.localeCompare(a.draft.id),
      );
  }, [all]);

  const counts = useMemo<BoardCounts>(() => ({
    all:         items.length,
    unscheduled: items.filter(x => x.lifecycle === "unscheduled").length,
    scheduled:   items.filter(x => x.lifecycle === "scheduled").length,
    posted:      items.filter(x => x.lifecycle === "posted").length,
    failed:      items.filter(x => x.lifecycle === "failed").length,
  }), [items]);

  const filtered = useMemo(() => items.filter(x => matchesFilter(x, filter)), [items, filter]);

  const isPublishing = useCallback((id: string) => {
    void inFlightVersion; // re-evaluate when the in-flight set changes
    return getInFlightPublishSet().has(id);
  }, [inFlightVersion]);

  // ── Selection ────────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const liveSelected = useMemo(() => {
    const present = new Set(items.map(x => x.draft.id));
    let changed = false;
    const next = new Set<string>();
    selected.forEach(id => { if (present.has(id)) next.add(id); else changed = true; });
    return changed ? next : selected;
  }, [items, selected]);

  const isSelected = useCallback((id: string) => liveSelected.has(id), [liveSelected]);
  const toggle = useCallback((id: string) => {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback(() => setSelected(new Set(filtered.map(x => x.draft.id))), [filtered]);
  const selectedDrafts = useMemo(
    () => items.filter(x => liveSelected.has(x.draft.id)).map(x => x.draft),
    [items, liveSelected],
  );

  return {
    items: filtered,
    drafts: filtered.map(x => x.draft),
    allItems: items,
    counts,
    isPublishing,
    selectedIds: liveSelected,
    selectedCount: liveSelected.size,
    selectedDrafts,
    isSelected,
    toggle,
    clearSelection,
    selectAll,
  };
}
