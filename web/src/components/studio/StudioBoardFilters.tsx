"use client";

import Link from "next/link";
import type { BoardFilter, BoardCounts } from "@/hooks/usePinBoardDrafts";
import { BUI } from "@/components/studio/boardUI";

// Lifecycle-only filters (P0). Source (Uploaded / AI Generated) is a card badge and
// a separate future filter, never mixed into this status row.
//
// Plan is NOT a status tab (PRD 0826). It is a workspace view, entered from the Plan
// sidebar's "Open full planner" (→ /app/studio?view=plan), so this row stays a pure
// status row: Drafts / Scheduled / Posted / Failed / All, defaulting to Drafts.
// The Link rendering below is still required: when the Plan view is active
// (WeeklyPlanWorkspace renders this row with `planActive` and no `onChange`) the tabs
// must navigate back to the board rather than call a handler that is not there.
const TABS: { id: BoardFilter; label: string }[] = [
  { id: "unscheduled", label: "Drafts" },
  { id: "scheduled",   label: "Scheduled" },
  { id: "posted",      label: "Posted" },
  { id: "failed",      label: "Failed" },
  { id: "all",         label: "All" },
];

export function StudioBoardFilters({ value, counts, onChange, planActive = false }: {
  value: BoardFilter;
  counts: BoardCounts;
  onChange?: (f: BoardFilter) => void;
  planActive?: boolean;
}) {
  return (
    <div data-testid="board-filters" style={{ display: "flex", gap: 4, flexWrap: "wrap", borderBottom: `1px solid ${BUI.border}`, paddingBottom: 2 }}>
      {TABS.map(t => {
        const active = !planActive && value === t.id;
        const n = counts[t.id];
        const commonStyle = {
          display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "none",
          borderBottom: `2px solid ${active ? BUI.purple : "transparent"}`, background: "none",
          color: active ? BUI.text : BUI.textSec, fontSize: 12.5, fontWeight: active ? 800 : 600,
          cursor: "pointer", fontFamily: "inherit", textDecoration: "none",
        } as const;
        const content = <>{t.label}
          <span style={{ fontSize: 10.5, fontWeight: 700, color: active ? BUI.purple : BUI.textMuted, background: active ? "rgba(124,58,237,0.10)" : BUI.surface3, borderRadius: 999, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>
            {n}
          </span>
        </>;

        if (planActive || !onChange) {
          return <Link key={t.id} href={`/app/studio?filter=${t.id}`} data-testid={`board-filter-${t.id}`} style={commonStyle}>{content}</Link>;
        }
        return <button key={t.id} type="button" data-testid={`board-filter-${t.id}`} onClick={() => onChange(t.id)} style={commonStyle}>{content}</button>;
      })}
    </div>
  );
}
