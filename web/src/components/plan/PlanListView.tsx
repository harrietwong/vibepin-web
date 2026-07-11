"use client";

/**
 * Weekly Plan — List view. A compact, scannable publishing-management table (not a
 * card grid, not a calendar). Reads the SAME canonical planned time as Calendar via
 * mapPlanDraftToCalendarEvent, and schedules through the SAME canonical helper
 * (ensureScheduledPlanTime). Plain-text status, neutral empty states, portrait thumbs.
 */

import { useEffect, useMemo, useState } from "react";
import type { PinDraft } from "@/lib/pinDraftStore";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { draftsForCategory } from "@/lib/weeklyPlanStats";
import { mapPlanDraftToCalendarEvent } from "@/lib/planCalendar";
import { ensureScheduledPlanTime } from "@/lib/smartSchedule";
import { sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";
import { toProxyUrl } from "@/lib/imageProxy";
import { toast } from "sonner";

type ListStatus = "Scheduled" | "Unscheduled" | "Published" | "Failed";

export type PlanListHandlers = {
  onOpenDetails: (d: PinDraft) => void;
  onReschedule:  (d: PinDraft) => void;
  onPublish:     (d: PinDraft) => void;
  /** Opens the shared Batch Edit workspace with the given draft IDs (same as Week/Month). */
  onBatchEdit?:  (draftIds: string[]) => void;
};

const C = {
  text: "var(--app-text)", sec: "var(--app-text-sec)", muted: "var(--app-text-muted)",
  border: "var(--app-border)", surface: "var(--app-surface)", surface2: "var(--app-surface-2)",
  pink: "#C026D3",
};

function listStatus(d: PinDraft): ListStatus {
  if (sanitizeHandoffField(d.postedAt)) return "Published";
  if (d.generationStatus === "failed") return "Failed";
  const ev = mapPlanDraftToCalendarEvent(d);
  if (ev.planStatus === "scheduled") return "Scheduled";
  return "Unscheduled";
}

function publishTimeLabel(d: PinDraft): string {
  const ev = mapPlanDraftToCalendarEvent(d);
  if (!ev.plannedDate || !ev.plannedTime) return "Unscheduled";
  const date = new Date(`${ev.plannedDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${date} · ${ev.plannedTime}`;
}

function shortUrl(url: string): string {
  const u = sanitizeHandoffField(url);
  if (!u) return "";
  try {
    const p = new URL(u.startsWith("http") ? u : `https://${u}`);
    const path = p.pathname.replace(/\/+$/, "");
    const s = `${p.hostname.replace(/^www\./, "")}${path}`;
    return s.length > 30 ? `${s.slice(0, 29)}…` : s;
  } catch {
    return u.length > 30 ? `${u.slice(0, 29)}…` : u;
  }
}

function productLabel(d: PinDraft): string {
  const n = (d.linkedProducts ?? []).length;
  return n === 0 ? "No product" : n === 1 ? "1 product" : `${n} products`;
}

const STATUS_OPTIONS: Array<"All" | ListStatus> = ["All", "Scheduled", "Published", "Unscheduled", "Failed"];

export function PlanListView({ category, handlers }: { category: string; handlers: PlanListHandlers }) {
  const [drafts, setDrafts] = useState<PinDraft[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"All" | ListStatus>("All");
  const [cols, setCols] = useState({ board: true, url: true, product: true });
  const [colsOpen, setColsOpen] = useState(false);

  useEffect(() => {
    function load() { setDrafts(draftsForCategory(category)); }
    load();
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
    window.addEventListener("vp:pin_store_updated", load);
    return () => {
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
      window.removeEventListener("vp:pin_store_updated", load);
    };
  }, [category]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return drafts
      .filter(d => statusFilter === "All" || listStatus(d) === statusFilter)
      .filter(d => !q || `${d.title ?? ""} ${d.keyword ?? ""}`.toLowerCase().includes(q))
      .map(d => ({ d, ev: mapPlanDraftToCalendarEvent(d) }))
      .sort((a, b) => {
        // Scheduled (by time) first, then unscheduled by recency.
        const ak = a.ev.plannedAt || "9999"; const bk = b.ev.plannedAt || "9999";
        return ak.localeCompare(bk);
      });
  }, [drafts, search, statusFilter]);

  const selectedDrafts = rows.filter(r => selected.has(r.d.id)).map(r => r.d);
  const allVisibleSelected = rows.length > 0 && rows.every(r => selected.has(r.d.id));
  const canPublishSelected = selectedDrafts.some(d => !sanitizeHandoffField(d.postedAt));

  function toggle(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(prev => {
      if (rows.every(r => prev.has(r.d.id))) return new Set();
      return new Set(rows.map(r => r.d.id));
    });
  }

  function scheduleSelected() {
    const occupied = new Set<string>();
    let n = 0;
    for (const d of selectedDrafts) {
      const res = ensureScheduledPlanTime(d.id, { extraOccupied: occupied });
      if (res.ok) { occupied.add(`${res.slot.plannedDate}|${res.slot.plannedTime}`); n++; }
    }
    if (n > 0) toast.success(`Scheduled ${n} Pin${n === 1 ? "" : "s"} to upcoming Smart Schedule slots.`);
    setSelected(new Set());
  }

  function scheduleOne(id: string) {
    const res = ensureScheduledPlanTime(id);
    if (res.ok) toast.success(res.toast);
    else toast.error(res.toast);
  }

  const gridCols = [
    "32px", "minmax(0,2.4fr)", "1.1fr", "1fr",
    cols.board ? "1.2fr" : "", cols.url ? "1.4fr" : "", cols.product ? "0.9fr" : "", "1.5fr",
  ].filter(Boolean).join(" ");

  const cellBase: React.CSSProperties = { fontSize: 12, color: C.sec, display: "flex", alignItems: "center", minWidth: 0 };

  return (
    <div data-testid="plan-list-view" style={{ maxWidth: 1180, margin: "0 auto" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        {selected.size === 0 ? (
          <>
            <input
              data-testid="plan-list-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search pins"
              style={{ flex: "1 1 220px", maxWidth: 300, padding: "7px 11px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 12, outline: "none" }}
            />
            <select
              data-testid="plan-list-status-filter"
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as "All" | ListStatus)}
              style={{ padding: "7px 9px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 12, cursor: "pointer", outline: "none" }}
            >
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s === "All" ? "All statuses" : s}</option>)}
            </select>
            <div style={{ marginLeft: "auto", position: "relative" }}>
              <button type="button" data-testid="plan-list-columns" onClick={() => setColsOpen(o => !o)}
                style={{ padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: "transparent", color: C.sec, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Columns
              </button>
              {colsOpen && (
                <>
                  <div onClick={() => setColsOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                  <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 41, width: 170, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.4)", padding: 8 }}>
                    {([["board", "Board"], ["url", "Destination URL"], ["product", "Product"]] as const).map(([k, label]) => (
                      <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", fontSize: 12, color: C.text, cursor: "pointer" }}>
                        <input type="checkbox" checked={cols[k]} onChange={() => setCols(c => ({ ...c, [k]: !c[k] }))} />
                        {label}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <div data-testid="plan-list-selection-toolbar" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", flexWrap: "wrap" }}>
            <span data-testid="plan-list-selected-count" style={{ fontSize: 12, fontWeight: 600, color: C.sec }}>{selected.size} selected</span>
            {/* Primary: Batch edit → shared Batch Edit workspace with exactly the selected rows */}
            <button type="button" data-testid="plan-list-edit-selected" onClick={() => handlers.onBatchEdit ? handlers.onBatchEdit([...selected]) : (selectedDrafts[0] && handlers.onOpenDetails(selectedDrafts[0]))}
              style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Batch edit
            </button>
            <button type="button" data-testid="plan-list-schedule-selected" onClick={scheduleSelected}
              style={{ padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Schedule
            </button>
            <button type="button" data-testid="plan-list-publish-selected" disabled={!canPublishSelected}
              onClick={() => { const r = selectedDrafts.find(d => !sanitizeHandoffField(d.postedAt)); if (r) handlers.onPublish(r); }}
              title={canPublishSelected ? "Publish selected Pins" : "No selected Pin can be published"}
              style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid rgba(5,150,105,0.45)", background: canPublishSelected ? "rgba(5,150,105,0.10)" : "transparent", color: canPublishSelected ? "#10B981" : C.muted, fontSize: 12, fontWeight: 700, cursor: canPublishSelected ? "pointer" : "not-allowed", opacity: canPublishSelected ? 1 : 0.6 }}>
              Publish now
            </button>
            <button type="button" onClick={() => setSelected(new Set())}
              style={{ marginLeft: "auto", padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: "transparent", color: C.muted, fontSize: 12, cursor: "pointer" }}>
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Header */}
      <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 12, padding: "8px 12px", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: "var(--app-bg)", zIndex: 1 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <input type="checkbox" data-testid="plan-list-select-all" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all" />
        </div>
        <HeaderCell>Pin</HeaderCell>
        <HeaderCell>Publish time</HeaderCell>
        <HeaderCell>Status</HeaderCell>
        {cols.board && <HeaderCell>Board</HeaderCell>}
        {cols.url && <HeaderCell>Destination URL</HeaderCell>}
        {cols.product && <HeaderCell>Product</HeaderCell>}
        <HeaderCell>Actions</HeaderCell>
      </div>

      {/* Rows */}
      {rows.length === 0 ? (
        <div data-testid="plan-list-empty" style={{ padding: "40px 12px", textAlign: "center", color: C.muted, fontSize: 13 }}>
          No Pins match. Create Pins or adjust filters.
        </div>
      ) : rows.map(({ d, ev }) => {
        const status = listStatus(d);
        const isSel = selected.has(d.id);
        const board = sanitizeHandoffField(d.boardName) || sanitizeHandoffField(d.metadataDraft?.boardName);
        const url = sanitizeHandoffField(d.destinationUrl);
        const scheduled = !!ev.plannedDate && !!ev.plannedTime;
        const posted = status === "Published";
        return (
          <div key={d.id} data-testid="plan-list-row"
            style={{ display: "grid", gridTemplateColumns: gridCols, gap: 12, padding: "10px 12px", minHeight: 84, alignItems: "center",
              borderBottom: `1px solid ${C.border}`, background: isSel ? "rgba(192,38,211,0.05)" : "transparent" }}>
            {/* 1. Checkbox */}
            <div style={{ display: "flex", alignItems: "center" }}>
              <input type="checkbox" data-testid="plan-list-row-checkbox" checked={isSel} onChange={() => toggle(d.id)} aria-label="Select pin" />
            </div>
            {/* 2. Pin */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, cursor: "pointer" }} onClick={() => handlers.onOpenDetails(d)}>
              <div data-testid="plan-list-thumb" style={{ flexShrink: 0, width: 48, height: 72, borderRadius: 7, overflow: "hidden", background: "var(--app-surface-3, #0f172a)", border: `1px solid ${C.border}` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={toProxyUrl(d.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  onError={e => { e.currentTarget.style.opacity = "0.3"; }} />
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {ev.title}
              </span>
            </div>
            {/* 3. Publish time */}
            <div data-testid="plan-list-time" style={{ ...cellBase, color: scheduled ? C.text : C.muted, fontVariantNumeric: "tabular-nums" }}>
              {publishTimeLabel(d)}
            </div>
            {/* 4. Status (plain text) */}
            <div data-testid="plan-list-status" style={{ ...cellBase, color: status === "Published" ? C.muted : C.sec }}>{status}</div>
            {/* 5. Board */}
            {cols.board && (
              <div data-testid="plan-list-board" style={{ ...cellBase, cursor: "pointer" }} onClick={() => handlers.onOpenDetails(d)}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: board ? C.sec : C.muted }}>
                  {board || "Select board"}
                </span>
              </div>
            )}
            {/* 6. Destination URL */}
            {cols.url && (
              <div data-testid="plan-list-url" style={{ ...cellBase, cursor: "pointer" }} onClick={() => handlers.onOpenDetails(d)}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: url ? "#60A5FA" : C.muted }}>
                  {url ? shortUrl(url) : "Add URL"}
                </span>
              </div>
            )}
            {/* 7. Product (neutral) */}
            {cols.product && (
              <div data-testid="plan-list-product" style={{ ...cellBase, color: C.muted }}>{productLabel(d)}</div>
            )}
            {/* 8. Actions */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" data-testid="plan-list-edit" onClick={() => handlers.onOpenDetails(d)}
                style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.surface2, color: C.sec, fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                Edit details
              </button>
              {posted ? (
                <button type="button" data-testid="plan-list-view-btn" onClick={() => handlers.onOpenDetails(d)}
                  style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: "transparent", color: C.sec, fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                  View
                </button>
              ) : scheduled ? (
                <button type="button" data-testid="plan-list-reschedule" onClick={() => handlers.onReschedule(d)}
                  style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.border}`, background: "transparent", color: C.sec, fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                  Reschedule
                </button>
              ) : (
                <button type="button" data-testid="plan-list-schedule" onClick={() => scheduleOne(d.id)}
                  title="Schedule into the next available Smart Schedule slot"
                  style={{ padding: "5px 10px", borderRadius: 7, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  Schedule
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HeaderCell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center" }}>
      {children}
    </div>
  );
}
