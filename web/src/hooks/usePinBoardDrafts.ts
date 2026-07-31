"use client";

/**
 * usePinBoardDrafts — reactive Create Pins board (studioBoardV2).
 *
 * Version-cached pinDraftStore snapshot via useSyncExternalStore (stable array ref
 * between writes — no render loops), then board items + lifecycle FILTER counts +
 * selection via useMemo. Ordering: createdAt desc, id desc.
 *
 * Filters are lifecycle-only (P0): all / unscheduled / scheduled / posted / failed.
 * Normal board views contain active board-origin drafts (uploads + AI pins). Failed is
 * deliberately workspace-wide: Plan / cron / legacy handoff drafts must be recoverable
 * from Create Pins even when they were not created by the V2 board.
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

export function deriveBoardCollections(all: PinDraft[]): { activeDrafts: PinDraft[]; boardItems: BoardItem[]; failureItems: BoardItem[] } {
  const activeDrafts = all.filter(d => !d.archivedAt);
  const byCreated = (a: BoardItem, b: BoardItem) =>
    b.draft.createdAt.localeCompare(a.draft.createdAt) || b.draft.id.localeCompare(a.draft.id);
  const boardItems = activeDrafts
    .filter(isBoardSource)
    .map(d => ({ draft: d, lifecycle: getPinLifecycle(d) }))
    .sort(byCreated);
  const failureItems = activeDrafts
    .map(d => ({ draft: d, lifecycle: getPinLifecycle(d) }))
    .filter(item => item.lifecycle === "failed")
    .sort((a, b) => b.draft.updatedAt.localeCompare(a.draft.updatedAt) || byCreated(a, b));
  return { activeDrafts, boardItems, failureItems };
}

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

  const { activeDrafts, boardItems, failureItems } = useMemo(() => deriveBoardCollections(all), [all]);

  const counts = useMemo<BoardCounts>(() => ({
    all:         boardItems.length,
    unscheduled: boardItems.filter(x => x.lifecycle === "unscheduled" || x.lifecycle === "generating").length,
    scheduled:   boardItems.filter(x => x.lifecycle === "scheduled").length,
    posted:      boardItems.filter(x => x.lifecycle === "posted").length,
    failed:      failureItems.length,
  }), [boardItems, failureItems]);

  const filtered = useMemo(
    () => filter === "failed" ? failureItems : boardItems.filter(x => matchesFilter(x, filter)),
    [boardItems, failureItems, filter],
  );

  const isPublishing = useCallback((id: string) => {
    void inFlightVersion; // re-evaluate when the in-flight set changes
    return getInFlightPublishSet().has(id);
  }, [inFlightVersion]);

  // ── Selection ────────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const liveSelected = useMemo(() => {
    const present = new Set([...boardItems, ...failureItems].map(x => x.draft.id));
    let changed = false;
    const next = new Set<string>();
    selected.forEach(id => { if (present.has(id)) next.add(id); else changed = true; });
    return changed ? next : selected;
  }, [boardItems, failureItems, selected]);

  const isSelected = useCallback((id: string) => liveSelected.has(id), [liveSelected]);
  const toggle = useCallback((id: string) => {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback(() => setSelected(new Set(filtered.map(x => x.draft.id))), [filtered]);
  const selectedDrafts = useMemo(
    () => [...boardItems, ...failureItems]
      .filter((x, index, rows) => rows.findIndex(row => row.draft.id === x.draft.id) === index)
      .filter(x => liveSelected.has(x.draft.id))
      .map(x => x.draft),
    [boardItems, failureItems, liveSelected],
  );

  return {
    items: filtered,
    drafts: filtered.map(x => x.draft),
    allItems: boardItems,
    failureItems,
    activeDrafts,
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
