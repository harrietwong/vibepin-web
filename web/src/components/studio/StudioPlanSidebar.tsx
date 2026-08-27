"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { PinDraft } from "@/lib/pinDraftStore";
import { sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";
import { BUI } from "@/components/studio/boardUI";
import { toProxyUrl } from "@/lib/imageProxy";

// Enough room for a readable 7-day strip, but narrow enough that the Create Pins
// workspace keeps two card columns at normal desktop widths.
const PANEL_WIDTH = 344;

function startOfWeek(input: Date): Date {
  const d = new Date(input);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function scheduledKey(draft: PinDraft): string {
  const raw = sanitizeHandoffField(draft.plannedAt) || sanitizeHandoffField(draft.scheduledDate);
  return raw.slice(0, 10);
}

function scheduledTime(draft: PinDraft): string {
  return sanitizeHandoffField(draft.scheduledTime)
    || sanitizeHandoffField(draft.plannedAt).slice(11, 16)
    || "09:00";
}

function planDeepLink(draftId: string): string {
  return `/app/plan?modal=publish&pinId=${encodeURIComponent(draftId)}`;
}

export function StudioPlanSidebar({ drafts, pinned, onPinnedChange }: {
  drafts: PinDraft[];
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
}) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = pinned || hoverOpen;
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  }), [weekStart]);

  const byDay = useMemo(() => {
    const map = new Map<string, PinDraft[]>();
    drafts.forEach(draft => {
      const key = scheduledKey(draft);
      if (!key) return;
      const list = map.get(key) ?? [];
      list.push(draft);
      map.set(key, list);
    });
    map.forEach(list => list.sort((a, b) => scheduledTime(a).localeCompare(scheduledTime(b))));
    return map;
  }, [drafts]);

  function reveal() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setHoverOpen(true);
  }

  function scheduleClose() {
    if (pinned) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHoverOpen(false), 240);
  }

  function moveWeek(delta: number) {
    setWeekStart(current => {
      const next = new Date(current);
      next.setDate(next.getDate() + delta * 7);
      return next;
    });
  }

  const end = days[6];
  const range = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <>
      <button type="button" data-testid="studio-plan-toggle"
        aria-label={pinned ? "Close Plan" : "Keep Plan open"} aria-pressed={pinned}
        title={pinned ? "Close Plan" : "Keep Plan open"}
        onMouseEnter={reveal} onMouseLeave={scheduleClose} onFocus={reveal} onBlur={scheduleClose}
        onClick={() => {
          if (pinned) {
            setHoverOpen(false);
            onPinnedChange(false);
          } else {
            setHoverOpen(true);
            onPinnedChange(true);
          }
        }}
        style={{
          position: "absolute", zIndex: 45, top: open ? 13 : "38%", right: open ? 12 : 0,
          width: open ? 30 : 28, height: open ? 30 : 44,
          border: `1px solid ${BUI.border}`, borderRight: open ? `1px solid ${BUI.border}` : "none",
          borderRadius: open ? 8 : "9px 0 0 9px",
          background: pinned ? "rgba(124,58,237,0.12)" : BUI.surface,
          color: pinned ? BUI.purple : BUI.textSec, cursor: "pointer",
          boxShadow: open ? "none" : "-4px 0 14px rgba(15,23,42,0.08)",
          display: "grid", placeItems: "center", padding: 0,
        }}>
        {pinned ? <PanelRightClose style={{ width: 16, height: 16 }} /> : <PanelRightOpen style={{ width: 16, height: 16 }} />}
      </button>

      {open && (
        <aside data-testid="studio-plan-sidebar" data-pinned={pinned ? "true" : "false"}
          onMouseEnter={reveal} onMouseLeave={scheduleClose}
          style={{
            width: PANEL_WIDTH, minWidth: PANEL_WIDTH, minHeight: 0, display: "flex", flexDirection: "column",
            background: BUI.surface, borderLeft: `1px solid ${BUI.border}`,
            position: pinned ? "relative" : "absolute", inset: pinned ? undefined : "0 0 0 auto",
            zIndex: 43, boxShadow: pinned ? "none" : "-14px 0 36px rgba(15,23,42,0.14)",
          }}>
          <header style={{ padding: "14px 50px 10px 14px", borderBottom: `1px solid ${BUI.border}`, flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <CalendarDays style={{ width: 16, height: 16, color: BUI.purple }} />
                <strong style={{ fontSize: 14, color: BUI.text }}>Plan</strong>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 12 }}>
              <button type="button" aria-label="Previous week" onClick={() => moveWeek(-1)} style={navButton}><ChevronLeft style={{ width: 14, height: 14 }} /></button>
              <span style={{ fontSize: 11.5, fontWeight: 750, color: BUI.text }}>{range}</span>
              <button type="button" aria-label="Next week" onClick={() => moveWeek(1)} style={navButton}><ChevronRight style={{ width: 14, height: 14 }} /></button>
              <button type="button" onClick={() => setWeekStart(startOfWeek(new Date()))} style={{ ...navButton, width: "auto", padding: "5px 9px", fontSize: 10.5, fontWeight: 700 }}>Today</button>
            </div>
          </header>

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 5, minHeight: "100%" }}>
              {days.map(day => {
                const key = dateKey(day);
                const items = byDay.get(key) ?? [];
                const today = key === dateKey(new Date());
                return (
                  <div key={key} style={{ minWidth: 0, borderRadius: 8, background: today ? "rgba(124,58,237,0.055)" : BUI.bg, border: `1px solid ${today ? "rgba(124,58,237,0.20)" : BUI.border}` }}>
                    <div style={{ padding: "7px 2px", textAlign: "center", borderBottom: `1px solid ${BUI.border}` }}>
                      <div style={{ fontSize: 8.5, color: BUI.textSec, textTransform: "uppercase" }}>{day.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}</div>
                      <div style={{ marginTop: 2, fontSize: 10.5, fontWeight: today ? 800 : 650, color: today ? BUI.purple : BUI.text }}>{day.getDate()}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: 4 }}>
                      {items.map(draft => (
                        <Link key={draft.id} href={planDeepLink(draft.id)} title={`${scheduledTime(draft)} · ${draft.title || "Untitled"}`}
                          style={{ display: "block", textDecoration: "none", color: "inherit" }}>
                          <div style={{ fontSize: 7.5, fontWeight: 750, color: draft.publishError ? "#D97706" : BUI.textSec, textAlign: "center", marginBottom: 2 }}>{scheduledTime(draft)}</div>
                          <div style={{ width: "100%", aspectRatio: "2/3", borderRadius: 5, overflow: "hidden", background: BUI.surface, border: `1px solid ${draft.publishError ? "rgba(217,119,6,0.45)" : BUI.border}` }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {draft.imageUrl ? <img src={toProxyUrl(draft.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <footer style={{ padding: 10, borderTop: `1px solid ${BUI.border}`, display: "flex", gap: 8 }}>
            <Link href="/app/plan" style={{ flex: 1, textAlign: "center", padding: "8px 10px", borderRadius: 8, border: `1px solid ${BUI.border}`, color: BUI.text, textDecoration: "none", fontSize: 11.5, fontWeight: 700 }}>Open full planner</Link>
          </footer>
        </aside>
      )}
    </>
  );
}

const navButton: React.CSSProperties = {
  width: 28, height: 28, padding: 0, borderRadius: 7, border: `1px solid ${BUI.border}`,
  background: BUI.surface, color: BUI.textSec, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
};
