"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { BoardFilter, BoardCounts } from "@/hooks/usePinBoardDrafts";
import { BUI } from "@/components/studio/boardUI";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";

// Lifecycle-only filters (P0). Source (Uploaded / AI Generated) is a card badge and
// a separate future filter, never mixed into this status row.
//
// Plan is NOT a status tab (PRD 0826). It is a workspace view, entered from the Plan
// sidebar's "Open full planner" (→ /app/studio?view=plan), so this row stays a pure
// status row: Drafts / Scheduled / Posted / Failed / All, defaulting to Drafts.
// The Link rendering below is still required: when the Plan view is active
// (WeeklyPlanWorkspace renders this row with `planActive` and no `onChange`) the tabs
// must navigate back to the board rather than call a handler that is not there.
const TABS: { id: BoardFilter; labelKey: MessageKey }[] = [
  { id: "unscheduled", labelKey: "studioBoard.filters.drafts" },
  { id: "scheduled",   labelKey: "studioBoard.filters.scheduled" },
  { id: "posted",      labelKey: "studioBoard.filters.posted" },
  { id: "failed",      labelKey: "studioBoard.filters.failed" },
  { id: "all",         labelKey: "studioBoard.filters.all" },
];

export function StudioBoardFilters({ value, counts, onChange, planActive = false, attentionCount = 0, onReviewAttention }: {
  value: BoardFilter;
  counts: BoardCounts;
  onChange?: (f: BoardFilter) => void;
  planActive?: boolean;
  attentionCount?: number;
  onReviewAttention?: () => void;
}) {
  const { t: tr } = useLocale();
  const attentionCopy = attentionCount === 1
    ? tr("studioBoard.attention.onePin")
    : tr("studioBoard.attention.manyPins").replace("{n}", String(attentionCount));
  return (
    <div data-testid="board-filters" style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", borderBottom: `1px solid ${BUI.border}`, paddingBottom: 2 }}>
      {TABS.map(t => {
        const active = !planActive && value === t.id;
        const n = counts[t.id];
        const commonStyle = {
          display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "none",
          borderBottom: `2px solid ${active ? BUI.purple : "transparent"}`, background: "none",
          color: active ? BUI.text : BUI.textSec, fontSize: 12.5, fontWeight: active ? 800 : 600,
          cursor: "pointer", fontFamily: "inherit", textDecoration: "none",
        } as const;
        const content = <>{tr(t.labelKey)}
          <span style={{ fontSize: 10.5, fontWeight: 700, color: active ? BUI.purple : BUI.textMuted, background: active ? "rgba(124,58,237,0.10)" : BUI.surface3, borderRadius: 999, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>
            {n}
          </span>
        </>;

        if (planActive || !onChange) {
          return <Link key={t.id} href={`/app/studio?filter=${t.id}`} data-testid={`board-filter-${t.id}`} style={commonStyle}>{content}</Link>;
        }
        return <button key={t.id} type="button" data-testid={`board-filter-${t.id}`} onClick={() => onChange(t.id)} style={commonStyle}>{content}</button>;
      })}
      {!planActive && value !== "failed" && attentionCount > 0 && onReviewAttention && (
        <button type="button" data-testid="studio-failure-notice" onClick={onReviewAttention}
          aria-label={`${attentionCopy}. ${tr("studioBoard.attention.review")}`}
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 9px",
            border: `1px solid ${BUI.border}`, borderRadius: 999, background: BUI.surface2,
            color: BUI.warning, fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          <AlertTriangle aria-hidden="true" style={{ width: 12, height: 12 }} />
          <span>{attentionCopy}</span>
          <span style={{ color: BUI.textSec }}>{tr("studioBoard.attention.review")}</span>
        </button>
      )}
    </div>
  );
}
