"use client";

import type { BoardFilter, BoardCounts } from "@/hooks/usePinBoardDrafts";
import { BUI } from "@/components/studio/boardUI";

// Lifecycle-only filters (P0). Source (Uploaded / AI Generated) is a card badge and
// a separate future filter, never mixed into this status row.
const TABS: { id: BoardFilter; label: string }[] = [
  { id: "all",         label: "All" },
  { id: "unscheduled", label: "Unscheduled" },
  { id: "scheduled",   label: "Scheduled" },
  { id: "posted",      label: "Posted" },
  { id: "failed",      label: "Failed" },
];

export function StudioBoardFilters({ value, counts, onChange }: {
  value: BoardFilter;
  counts: BoardCounts;
  onChange: (f: BoardFilter) => void;
}) {
  return (
    <div data-testid="board-filters" style={{ display: "flex", gap: 4, flexWrap: "wrap", borderBottom: `1px solid ${BUI.border}`, paddingBottom: 2 }}>
      {TABS.map(t => {
        const active = value === t.id;
        const n = counts[t.id];
        return (
          <button key={t.id} type="button" data-testid={`board-filter-${t.id}`} onClick={() => onChange(t.id)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "none",
              borderBottom: `2px solid ${active ? BUI.purple : "transparent"}`, background: "none",
              color: active ? BUI.text : BUI.textSec, fontSize: 12.5, fontWeight: active ? 800 : 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>
            {t.label}
            <span style={{ fontSize: 10.5, fontWeight: 700, color: active ? BUI.purple : BUI.textMuted, background: active ? "rgba(124,58,237,0.10)" : BUI.surface3, borderRadius: 999, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>
              {n}
            </span>
          </button>
        );
      })}
    </div>
  );
}
