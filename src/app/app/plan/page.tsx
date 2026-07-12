"use client";

import { Suspense, useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { DragEvent as RDragEvent } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";

// Converts Supabase Storage public URLs to the server-side proxy so images load
// even when the "generated" bucket doesn't have public access enabled. For
// Pinterest-hosted images it also swaps the multi-MB `originals/` asset for the
// pre-generated `736x` display variant — visually identical in the planner's
// small tiles, but ~10–50× faster to download. Display-only; the stored
// `imageUrl` and publish payload keep full resolution.
function toProxyUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  if (!url.startsWith("/")) {
    const pin = url.replace(/(\/\/i\.pinimg\.com\/)originals\//, "$1736x/");
    if (pin !== url) return pin;
  }
  if (url.startsWith("/")) return url;
  const MARKER = "/storage/v1/object/public/generated/studio/";
  const idx = url.indexOf(MARKER);
  if (idx !== -1) {
    const filename = url.slice(idx + MARKER.length);
    return `/api/storage-image?path=studio/${filename}`;
  }
  return url;
}

import { ACTIVE_CATEGORIES, CATEGORIES } from "@/lib/categories";
import {
  TIER_META,
  getTitleTemplates,
  getContentTypes,
  getVisualDirection,
  getMonetizationPaths,
  getDescriptionAngle,
  getCTASuggestion,
  workspaceTierToPrimaryBadge,
  PRIMARY_BADGE_META,
  TREND_CHIP_META,
  getTrendStateChip,
  type WorkspaceTier,
  type ContentType,
  type MonetizationPath,
} from "@/lib/workspaceStatics";
import { useWeeklyPlan }    from "@/lib/useWeeklyPlan";
import type { WeeklyPlanItem } from "@/lib/useWeeklyPlan";
import { buildPrefillFromWeeklyPlan, savePrefill } from "@/lib/createPinsPrefill";
import * as pinStore        from "@/lib/pinStore";
import * as pinDraftStore   from "@/lib/pinDraftStore";
import type { PinDraft }    from "@/lib/pinDraftStore";
import { PinHoverTarget, type PinHoverPreviewActions, setPinPreviewSuspended } from "@/components/plan/PinHoverPreview";
import { PinThumbnail } from "@/components/plan/PinThumbnail";
import { autoSchedulePins, ensureScheduledPlanTime, normalizeInPlanDraftTimes, buildDaySlotRows, dayHasFreeFutureSlot, classifyDayDropBlock, formatScheduleDateLabel } from "@/lib/smartSchedule";
import { mapPlanDraftToCalendarEvent, draftsToSortedEvents } from "@/lib/planCalendar";
import { filterUnscheduledPinIds } from "@/lib/smartScheduleActions";
import { displayTitle, sanitizeHandoffField, plannableDateISO } from "@/lib/weeklyPlanHandoff";
import { fetchPinterestBoards, seedPinterestStatusConnected, syncPinterestAccount } from "@/lib/pinterestClient";
import { invalidateBoardsCache } from "@/lib/pinterest/boardsCache";
import { invalidateConnectionsCache } from "@/lib/social/connectionsCache";
import { toast } from "sonner";
import type { BatchPinRow, BatchApplyOpts } from "@/components/studio/BatchEditDrawer";
import {
  writePinProducts, generatePinMetadataDraft, applyDraftToPinFields,
} from "@/lib/pinMetadata";
import { resolveCanonicalPinProducts } from "@/lib/studio/pinProducts";
import { readResolvedContentLanguage } from "@/lib/i18n/config";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  computeWeeklyPlanStats,
  addedNeedsDateLabel,
  getAddedNeedsDateDrafts,
  scheduledDraftsInWeek,
  scheduledDraftsInMonth,
  unaddedStatusLabel,
  ALL_CATEGORIES,
  type WeeklyPlanStats,
} from "@/lib/weeklyPlanStats";
import { markDataReady } from "@/lib/navTiming";
import { logPlanHydrated, logPlanTiming } from "@/lib/planLoadTiming";

// ── Lazily loaded components ─────────────────────────────────────────────────
// Heavy drawers/alternate views deferred out of the main route chunk so the
// Plan page shell mounts faster after a sidebar nav. Behavior is unchanged —
// each of these already renders nothing when closed / not selected.
const DraftDetailsDrawer = dynamic(() =>
  import("@/components/plan/DraftDetailsDrawer").then(m => m.DraftDetailsDrawer), { ssr: false });
// Start fetching (and in dev, compiling) the drawer chunk as soon as the page module
// evaluates instead of after mount — it renders on every Plan visit anyway (open=false
// until a Pin is clicked), and on the post-OAuth restore path the drawer must open
// immediately, so the chunk request should never trail the page render.
if (typeof window !== "undefined") void import("@/components/plan/DraftDetailsDrawer");
const SmartScheduleDrawer = dynamic(() =>
  import("@/components/plan/SmartScheduleDrawer").then(m => m.SmartScheduleDrawer), { ssr: false });
const PlanListView = dynamic(() =>
  import("@/components/plan/PlanListView").then(m => m.PlanListView), { ssr: false });
const BatchEditDrawer = dynamic(() =>
  import("@/components/studio/BatchEditDrawer").then(m => m.BatchEditDrawer), { ssr: false });

// ── Types ──────────────────────────────────────────────────────────────────────

// Weekly Plan top-level views. "board" was removed from the UI (it conflicted with
// Pinterest Board terminology); any legacy value is coerced to "calendar".
type ViewMode = "calendar" | "list";
type CalendarScope = "week" | "month";

// Persist the user's explicit Week/Month choice so it survives reloads. With no
// saved preference the Plan opens in Weekly view by default.
const CALENDAR_SCOPE_KEY = "vp:plan_calendar_scope";
function readStoredCalendarScope(): CalendarScope | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(CALENDAR_SCOPE_KEY);
    return v === "week" || v === "month" ? v : null;
  } catch {
    return null;
  }
}
function persistCalendarScope(scope: CalendarScope): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CALENDAR_SCOPE_KEY, scope);
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}

const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// Local-time YYYY-MM-DD (avoids the UTC shift of Date.toISOString in +offset zones).
function localISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Local-time week-start (Monday) ISO for a given week offset.
function computeWeekStartISO(weekOffset: number): string {
  const today = new Date();
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + weekOffset * 7);
  monday.setHours(0, 0, 0, 0);
  return localISO(monday);
}

// First-of-month ISO for a given month offset.
function computeMonthAnchorISO(monthOffset: number): string {
  const t = new Date();
  const d = new Date(t.getFullYear(), t.getMonth() + monthOffset, 1);
  d.setHours(0, 0, 0, 0);
  return localISO(d);
}

function weekOffsetFromStartISO(weekStart: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;
  const current = new Date(`${computeWeekStartISO(0)}T00:00:00`);
  const target = new Date(`${weekStart}T00:00:00`);
  const diffDays = Math.round((target.getTime() - current.getTime()) / 86400000);
  return Number.isFinite(diffDays) ? Math.round(diffDays / 7) : null;
}

function monthOffsetFromAnchorISO(monthAnchor: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monthAnchor)) return null;
  const current = new Date(`${computeMonthAnchorISO(0)}T00:00:00`);
  const target = new Date(`${monthAnchor}T00:00:00`);
  return (target.getFullYear() - current.getFullYear()) * 12 + (target.getMonth() - current.getMonth());
}

// Shared drag-and-drop plumbing passed down to calendar + side sections.
type PlanDnD = {
  draggingId:     string | null;
  dragOverKey:    string | null;
  setDragOverKey: (k: string | null) => void;
  onPinDragStart: (e: RDragEvent, id: string) => void;
  onPinDragEnd:   () => void;
  assignToDate:   (id: string, date: string, time?: string) => void;
  unschedule:     (id: string) => void;
};

// Multi-select (Edit Plan mode). When active, calendar cards become selectable.
type PlanSelect = {
  active:     boolean;
  isSelected: (id: string) => boolean;
  toggle:     (id: string) => void;
};

function readDragId(e: RDragEvent): string {
  return e.dataTransfer.getData("text/plain");
}

/** True once the viewport is wide enough to show the Unscheduled Pins right rail.
 *  Below the breakpoint, unscheduled Pins fall back to a stacked section so nothing
 *  is hidden. Returns false during SSR / first paint (caller gates behind `hydrated`). */
function useWideLayout(minWidth = 1100): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const check = () => setWide(window.innerWidth >= minWidth);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [minWidth]);
  return wide;
}

type PinBrief = WeeklyPlanItem & {
  title_hook:        string;
  description_angle: string;
  content_type:      ContentType;
  visual_direction:  string;
  monetization_path: MonetizationPath[];
  product_hint:      string;
  cta_suggestion:    string;
};

function enrichItem(item: WeeklyPlanItem): PinBrief {
  const tier     = (item.tier as WorkspaceTier) ?? "early_trend";
  const monPaths = getMonetizationPaths(item.category);
  const contType = getContentTypes(item.category)[0];
  return {
    ...item,
    title_hook:        getTitleTemplates(item.keyword)[0],
    description_angle: getDescriptionAngle(item.keyword, item.category, tier, monPaths),
    content_type:      contType,
    visual_direction:  getVisualDirection(item.category),
    monetization_path: monPaths,
    product_hint:      "product signals available",
    cta_suggestion:    getCTASuggestion(contType),
  };
}

function draftStatusDisplay(draft: PinDraft): { label: string; color: string } {
  if (!pinDraftStore.isDraftAddedToWeeklyPlan(draft)) {
    return unaddedStatusLabel();
  }
  if (draft.postedAt) return { label: "Published", color: "#7C3AED" };
  if (!sanitizeHandoffField(draft.scheduledDate)) {
    return { label: "Unscheduled", color: "var(--app-text-muted)" };
  }
  return { label: "Scheduled", color: "#059669" };
}

function briefMarkdown(b: PinBrief, dateLabel: string): string {
  return [
    `**${dateLabel}**`,
    `Keyword: ${b.keyword}`,
    `Tier: ${TIER_META[b.tier as WorkspaceTier]?.label ?? b.tier}`,
    `Title Hook: ${b.title_hook}`,
    `Description Angle: ${b.description_angle}`,
    `Content Type: ${b.content_type}`,
    `Visual Direction: ${b.visual_direction}`,
    `Monetize via: ${b.monetization_path.join(", ")}`,
    `Product Hint: ${b.product_hint}`,
    `CTA: ${b.cta_suggestion}`,
  ].join("\n");
}

function exportCSV(briefs: { brief: PinBrief; dateLabel: string }[], fileName: string) {
  const esc    = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = [
    "planned_date", "keyword", "tier", "title_hook", "description_angle",
    "content_type", "visual_direction", "monetization_path", "product_hint",
    "cta_suggestion", "source_url", "board",
  ].join(",");
  const rows = briefs.map(({ brief: b, dateLabel }) =>
    [
      esc(dateLabel), esc(b.keyword),
      esc(TIER_META[b.tier as WorkspaceTier]?.label ?? b.tier),
      esc(b.title_hook), esc(b.description_angle), esc(b.content_type),
      esc(b.visual_direction), esc(b.monetization_path.join(", ")),
      esc(b.product_hint), esc(b.cta_suggestion), "", "",
    ].join(",")
  );
  const csv  = [header, ...rows].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

// ── Brief field ───────────────────────────────────────────────────────────────

function BriefField({ label, value, highlight, accent }: {
  label: string; value: string; highlight?: boolean; accent?: string;
}) {
  return (
    <div style={{
      padding: "7px 10px", borderRadius: "6px",
      background: highlight ? "rgba(192,38,211,0.04)" : "var(--app-bg)",
      border: `1px solid ${highlight ? "rgba(192,38,211,0.12)" : "var(--app-border)"}`,
    }}>
      <p style={{ margin: "0 0 2px", fontSize: "9px", fontWeight: 700, color: "var(--app-text-sec)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
        {label}
      </p>
      <p style={{ margin: 0, fontSize: "11px", color: accent ?? (highlight ? "#7C3AED" : "var(--app-text-sec)"), lineHeight: 1.4, fontWeight: highlight ? 600 : 400 }}>
        {value}
      </p>
    </div>
  );
}

// ── View Pins Modal ───────────────────────────────────────────────────────────

function ViewPinsModal({
  keyword, category, studioHref, onClose,
}: {
  keyword:    string;
  category:   string;
  studioHref: string;
  onClose:    () => void;
}) {
  const [drafts,    setDrafts]    = useState<PinDraft[]>([]);
  const [selected,  setSelected]  = useState<Set<string>>(new Set());
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PinDraft | null>(null);

  useEffect(() => {
    function load() { setDrafts(pinDraftStore.getDraftsByKeyword(keyword, category)); }
    load();
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
    return () => window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
  }, [keyword, category]);

  function toggleSelect(id: string) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function handleRemove(id: string) {
    pinDraftStore.deleteDraft(id);
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  function handleRemoveSelected() {
    for (const id of selected) pinDraftStore.deleteDraft(id);
    setSelected(new Set());
  }

  function downloadFile(src: string, idx: number) {
    const a = document.createElement("a");
    a.href = src; a.download = `pin-${idx + 1}.jpg`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function handleDownloadSelected() {
    const arr = [...selected];
    arr.forEach((id, idx) => {
      const draft = drafts.find(d => d.id === id);
      if (draft) setTimeout(() => downloadFile(toProxyUrl(draft.imageUrl), idx), idx * 200);
    });
  }

  const allSel   = drafts.length > 0 && drafts.every(d => selected.has(d.id));
  const someSel  = selected.size > 0;
  const readyN   = drafts.filter(d => d.status === "ready").length;
  const title    = keyword.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 55, background: "rgba(0,0,0,0.45)" }} />

      {/* Modal */}
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        zIndex: 60, width: "min(760px,96vw)", maxHeight: "90vh",
        background: "var(--app-surface)", borderRadius: 16, boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #F1F5F9", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
            <div>
              <p style={{ margin: 0, fontSize: "15px", fontWeight: 800, color: "var(--app-text)", textTransform: "capitalize" }}>{title}</p>
              <p style={{ margin: "3px 0 0", fontSize: "11px", color: "var(--app-text-muted)" }}>
                {drafts.length} pin{drafts.length !== 1 ? "s" : ""} added to plan
                {readyN > 0 && <span style={{ color: "#059669" }}> · {readyN} ready</span>}
              </p>
            </div>
            <button type="button" onClick={onClose}
              style={{ padding: "5px 9px", borderRadius: 8, border: "1px solid var(--app-border)", background: "var(--app-surface-2)", cursor: "pointer", fontSize: 14, color: "var(--app-text-sec)", lineHeight: 1, flexShrink: 0 }}>
              ✕
            </button>
          </div>
          {/* Top actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Link href={studioHref}
              style={{ padding: "5px 14px", borderRadius: 7, fontSize: "11px", fontWeight: 700, background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", textDecoration: "none", whiteSpace: "nowrap" }}>
              ✦ Create More
            </Link>
            {drafts.length > 0 && (
              <button type="button"
                onClick={() => drafts.forEach((d, i) => setTimeout(() => downloadFile(d.imageUrl, i), i * 200))}
                style={{ padding: "5px 12px", borderRadius: 7, fontSize: "11px", fontWeight: 600, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-sec)", cursor: "pointer", whiteSpace: "nowrap" }}>
                ↓ Download all
              </button>
            )}
          </div>
        </div>

        {/* Bulk action bar */}
        {someSel && (
          <div style={{
            padding: "8px 16px", borderBottom: "1px solid rgba(124,58,237,0.12)", flexShrink: 0,
            background: "rgba(124,58,237,0.04)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          }}>
            <input type="checkbox" checked={allSel}
              onChange={() => setSelected(allSel ? new Set() : new Set(drafts.map(d => d.id)))}
              style={{ accentColor: "#7C3AED", width: 14, height: 14, cursor: "pointer" }} />
            <span style={{ fontSize: "12px", fontWeight: 700, color: "#7C3AED", flex: 1 }}>
              {selected.size} selected
            </span>
            <button type="button" onClick={handleDownloadSelected}
              style={{ padding: "4px 10px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "#475569", fontSize: "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
              ↓ Download selected
            </button>
            <button type="button" onClick={handleRemoveSelected}
              style={{ padding: "4px 10px", borderRadius: 7, border: "1px solid #FECACA", background: "#FFF5F5", color: "#EF4444", fontSize: "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
              Remove selected
            </button>
            <button type="button" onClick={() => setSelected(new Set())}
              style={{ padding: "4px 8px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-sec)", fontSize: "11px", cursor: "pointer" }}>
              Deselect
            </button>
          </div>
        )}

        {/* Select-all bar */}
        {!someSel && drafts.length > 0 && (
          <div style={{ padding: "6px 20px", borderBottom: "1px solid #F1F5F9", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={false}
              onChange={() => setSelected(new Set(drafts.map(d => d.id)))}
              style={{ accentColor: "#7C3AED", width: 14, height: 14, cursor: "pointer" }} />
            <span style={{ fontSize: "11px", color: "var(--app-text-muted)", cursor: "pointer" }}
              onClick={() => setSelected(new Set(drafts.map(d => d.id)))}>
              Select all
            </span>
          </div>
        )}

        {/* Pin grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {drafts.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 0" }}>
              <p style={{ fontSize: "13px", color: "var(--app-text-muted)", fontWeight: 600 }}>No pins added yet</p>
              <p style={{ fontSize: "11px", color: "#CBD5E1", marginTop: 4 }}>
                Generate pins in Create Pin and add them to this plan item.
              </p>
              <Link href={studioHref}
                style={{ display: "inline-block", marginTop: 14, padding: "8px 20px", borderRadius: 8, background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: "12px", fontWeight: 700, textDecoration: "none" }}>
                ✦ Create Pins
              </Link>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))", gap: 10 }}>
              {drafts.map((draft, idx) => {
                const sel         = selected.has(draft.id);
                const st          = draftStatusDisplay(draft);
                const statusColor = st.color;
                const statusLabel = st.label;
                return (
                  <div key={draft.id} data-testid="weekly-plan-pin-card" style={{
                    borderRadius: 10, overflow: "hidden",
                    border: `2px solid ${sel ? "#7C3AED" : draft.status === "ready" ? "rgba(5,150,105,0.3)" : "var(--app-border)"}`,
                    background: sel ? "rgba(124,58,237,0.03)" : "var(--app-surface-2)",
                    display: "flex", flexDirection: "column",
                  }}>
                    {/* Thumbnail */}
                    <div
                      style={{ position: "relative", aspectRatio: "2/3", cursor: "pointer", overflow: "hidden", background: "var(--app-border)" }}
                      onClick={() => setPreviewSrc(draft.imageUrl)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={toProxyUrl(draft.imageUrl)} alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform 0.2s" }}
                        onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.05)")}
                        onMouseLeave={e => (e.currentTarget.style.transform = "scale(1)")}
                      />
                      {/* Checkbox */}
                      <div style={{ position: "absolute", top: 6, left: 6 }}>
                        <input type="checkbox" checked={sel}
                          onChange={e => { e.stopPropagation(); toggleSelect(draft.id); }}
                          onClick={e => e.stopPropagation()}
                          style={{ accentColor: "#7C3AED", width: 14, height: 14, cursor: "pointer" }} />
                      </div>
                      {/* Status badge */}
                      <span style={{
                        position: "absolute", bottom: 5, left: 5, right: 5, textAlign: "center",
                        fontSize: "8px", fontWeight: 700, padding: "2px 6px", borderRadius: 8,
                        background: `${statusColor}dd`, color: "#fff",
                      }}>
                        {statusLabel}
                      </span>
                    </div>
                    <div style={{ padding: "5px 8px 2px" }}>
                      <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "var(--app-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {displayTitle(draft.title, draft.keyword)}
                      </p>
                      {/* Website URL is optional — no warning when it's absent. */}
                    </div>
                    {/* Actions */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around", padding: "5px 2px", borderTop: "1px solid #F1F5F9", gap: 2, flexWrap: "wrap" }}>
                      <button type="button" data-testid="weekly-plan-edit-details" onClick={() => setEditDraft(draft)}
                        style={{ padding: "3px 5px", background: "none", border: "none", cursor: "pointer", color: "#7C3AED", fontSize: "9px", fontWeight: 600 }}>
                        Edit
                      </button>
                      <button type="button" onClick={() => downloadFile(toProxyUrl(draft.imageUrl), idx)}
                        style={{ padding: "3px 5px", background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: "9px", fontWeight: 600 }}>
                        ↓ DL
                      </button>
                      <button type="button" onClick={() => handleRemove(draft.id)}
                        style={{ padding: "3px 5px", background: "none", border: "none", cursor: "pointer", color: "#EF4444", fontSize: "9px", fontWeight: 600 }}>
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {previewSrc && (
        <div
          onClick={() => setPreviewSrc(null)}
          style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewSrc} alt=""
            style={{ maxHeight: "90vh", maxWidth: "min(500px,90vw)", borderRadius: 12, objectFit: "contain" }}
            onClick={e => e.stopPropagation()} />
          <button type="button" onClick={() => setPreviewSrc(null)}
            style={{ position: "fixed", top: 16, right: 16, width: 34, height: 34, borderRadius: "50%", background: "rgba(255,255,255,0.15)", border: "none", cursor: "pointer", fontSize: 16, color: "#fff", lineHeight: 1 }}>
            ✕
          </button>
        </div>
      )}
      <DraftDetailsDrawer
        draft={editDraft}
        open={editDraft !== null}
        onClose={() => setEditDraft(null)}
        onSaved={() => setDrafts(pinDraftStore.getDraftsByKeyword(keyword, category))}
      />
    </>
  );
}

// ── Pin thumbnail area ────────────────────────────────────────────────────────

const THUMB_W = 52;
const THUMB_H = 74; // 2:3 ratio

function PlanPinArea({ thumbnails, total, onClick }: {
  thumbnails: string[];
  total:      number;
  onClick:    () => void;
}) {
  const visible = thumbnails.slice(0, 4);
  const extra   = total > 4 ? total - 4 : 0;

  if (thumbnails.length === 0) {
    // Compact 4-slot placeholder — small boxes, not a huge dashed panel
    return (
      <div onClick={onClick} style={{ display: "flex", gap: 4, cursor: "pointer", flexShrink: 0, alignItems: "center" }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{
            width: THUMB_W, height: THUMB_H, borderRadius: 7, flexShrink: 0,
            border: "1.5px dashed #E2E8F0", background: "var(--app-surface-2)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ fontSize: "18px", color: "#E2E8F0", fontWeight: 300, lineHeight: 1 }}>+</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div data-testid="weekly-plan-thumbnails" onClick={onClick} style={{ display: "flex", gap: 4, cursor: "pointer", flexShrink: 0 }}>
      {visible.map((src, i) => {
        const isLast = i === visible.length - 1 && extra > 0;
        return (
          <div key={i} style={{ position: "relative", width: THUMB_W, height: THUMB_H, borderRadius: 7, overflow: "hidden", background: "var(--app-border)", flexShrink: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={toProxyUrl(src)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}
              onError={e => { e.currentTarget.style.opacity = "0"; }} />
            {isLast && (
              <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: "12px", fontWeight: 800, color: "#fff" }}>+{extra}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Plan row ──────────────────────────────────────────────────────────────────

type DraftSummary = ReturnType<typeof pinDraftStore.getDraftSummary>;

function PlanRow({
  brief, dayLabel, dateStr, isToday,
}: {
  brief:    PinBrief;
  dayLabel: string;
  dateStr:  string;
  isToday:  boolean;
}) {
  const [draftSummary,  setDraftSummary]  = useState<DraftSummary | null>(null);
  const [addedFromStore, setAddedFromStore] = useState(0);
  const [viewPinsOpen,  setViewPinsOpen]  = useState(false);
  const [briefOpen,     setBriefOpen]     = useState(false);
  const [copied,        setCopied]        = useState(false);

  useEffect(() => {
    function load() {
      const ds = pinDraftStore.getDraftSummary(brief.keyword, brief.category);
      if (ds.total > 0) {
        setDraftSummary(ds);
        setAddedFromStore(0);
      } else {
        setDraftSummary(null);
        const ps = pinStore.getPlanPinSummary(brief.keyword, brief.category);
        setAddedFromStore(ps.addedCount);
      }
    }
    load();
    window.addEventListener("vp:pin_store_updated",          load);
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
    return () => {
      window.removeEventListener("vp:pin_store_updated",          load);
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
    };
  }, [brief.keyword, brief.category]);

  const hasDrafts = (draftSummary?.total ?? 0) > 0;
  const hasPins   = hasDrafts || addedFromStore > 0;

  // Production state
  type ProdState = "planned" | "partial" | "pins_ready";
  let prodState: ProdState = "planned";
  if (hasDrafts) {
    prodState = draftSummary!.ready === draftSummary!.total ? "pins_ready" : "partial";
  } else if (addedFromStore > 0) {
    prodState = "partial";
  }

  const PROD_META: Record<ProdState, { dot: string; text: string; color: string }> = {
    planned:   { dot: "#CBD5E1", text: "Planned",   color: "var(--app-text-muted)" },
    partial:   { dot: "#F59E0B", text: "Partial",   color: "#D97706" },
    pins_ready:{ dot: "#10B981", text: "Pins ready", color: "#059669" },
  };
  const pm = PROD_META[prodState];

  // Progress
  const progressN     = hasDrafts ? draftSummary!.ready + draftSummary!.needsReview : addedFromStore;
  const progressTotal = hasDrafts ? draftSummary!.total : Math.max(4, progressN);
  const progressPct   = progressTotal > 0 ? Math.round((progressN / progressTotal) * 100) : 0;
  const progressColor = prodState === "pins_ready" ? "#10B981" : "#C026D3";
  const progressText  = hasDrafts
    ? draftSummary!.ready === draftSummary!.total
      ? `${draftSummary!.total} pins ready`
      : `${progressN} pins added`
    : addedFromStore > 0
      ? `${addedFromStore} pins added`
      : "0 pins yet";

  // Thumbnails
  const thumbs    = draftSummary?.thumbnails ?? [];
  const totalPins = hasDrafts ? draftSummary!.total : addedFromStore;

  // Badges
  const primaryBadge = workspaceTierToPrimaryBadge(brief.tier as WorkspaceTier);
  const bMeta        = PRIMARY_BADGE_META[primaryBadge];
  const trendChipKey = getTrendStateChip({ pct_growth_yoy: null, weekly_change: null, trend_lifecycle: null });
  const trendChip    = TREND_CHIP_META[trendChipKey];

  // Studio link — save prefill to sessionStorage and use key in href
  const prefill = buildPrefillFromWeeklyPlan({
    keyword_id: brief.keyword_id,
    keyword: brief.keyword,
    category: brief.category,
    tier: brief.tier,
    title_hook: brief.title_hook,
  });
  const prefillKey = savePrefill(prefill);
  const studioHref = `/app/studio?prefillKey=${encodeURIComponent(prefillKey)}`;

  async function copyBrief() {
    await navigator.clipboard.writeText(briefMarkdown(brief, `${dayLabel} ${dateStr}`));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Split dateStr like "Jun 1" into month + day
  const [dateMonth, dateDay] = dateStr.split(" ");

  return (
    <>
      <div data-testid="weekly-plan-row" style={{ background: "var(--app-surface)", border: "1px solid var(--app-border)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "stretch" }}>

          {/* ── Date column ── */}
          <div style={{
            width: 62, flexShrink: 0, textAlign: "center",
            padding: "14px 6px", borderRight: "1px solid #F1F5F9",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
          }}>
            <div style={{ fontSize: "9px", fontWeight: 800, color: isToday ? "#C026D3" : "var(--app-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {dayLabel}
            </div>
            <div style={{ fontSize: "15px", fontWeight: 800, color: isToday ? "#C026D3" : "var(--app-text)", lineHeight: 1 }}>
              {dateDay}
            </div>
            <div style={{ fontSize: "9px", color: "var(--app-text-muted)" }}>{dateMonth}</div>
            {isToday && (
              <div style={{ fontSize: "7px", fontWeight: 700, color: "#C026D3", border: "1px solid rgba(192,38,211,0.3)", borderRadius: 3, padding: "1px 4px", marginTop: 2, letterSpacing: "0.05em" }}>
                TODAY
              </div>
            )}
          </div>

          {/* ── Info column ── */}
          <div style={{ flex: "0 0 190px", padding: "11px 10px 11px 14px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 6, minWidth: 0 }}>
            {/* Keyword */}
            <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 800, color: "var(--app-text)", textTransform: "capitalize", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {brief.keyword}
            </h3>
            {/* Badges */}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <span style={{ padding: "2px 7px", borderRadius: 4, fontSize: "9px", fontWeight: 700, background: bMeta.bg, color: bMeta.color, border: `1px solid ${bMeta.color}33`, whiteSpace: "nowrap", letterSpacing: "0.04em" }}>
                {bMeta.label}
              </span>
              <span style={{ padding: "2px 7px", borderRadius: 20, fontSize: "9px", fontWeight: 600, background: `${trendChip.color}12`, color: trendChip.color, border: `1px solid ${trendChip.color}2E`, whiteSpace: "nowrap" }}>
                {trendChipKey === "rising" ? "↑ " : trendChipKey === "seasonal" ? "◎ " : "∞ "}{trendChip.label}
              </span>
            </div>
            {/* Production state + progress */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: pm.dot, display: "inline-block", flexShrink: 0 }} />
              <span style={{ fontSize: "9px", fontWeight: 600, color: pm.color, whiteSpace: "nowrap" }}>{pm.text}</span>
              <div style={{ width: 56, height: 2.5, borderRadius: 2, background: "var(--app-border)", overflow: "hidden", flexShrink: 0 }}>
                <div style={{ height: "100%", borderRadius: 2, width: `${progressPct}%`, background: progressColor, transition: "width 0.3s ease" }} />
              </div>
              <span style={{ fontSize: "9px", color: "var(--app-text-muted)", whiteSpace: "nowrap" }}>{progressText}</span>
            </div>
          </div>

          {/* ── Pin thumbnail area ── */}
          <div style={{ flex: 1, minWidth: 0, padding: "10px 10px", display: "flex", alignItems: "center" }}>
            <PlanPinArea
              thumbnails={thumbs}
              total={totalPins}
              onClick={() => {
                if (hasPins) setViewPinsOpen(true);
                else window.location.href = studioHref;
              }}
            />
          </div>

          {/* ── Actions column ── */}
          <div style={{
            flex: "0 0 120px", padding: "10px 12px 10px 8px",
            display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "center", gap: 5,
          }}>
            {hasPins ? (
              <>
                <button type="button" data-testid="view-pins-button" onClick={() => setViewPinsOpen(true)}
                  style={{ padding: "6px 0", fontSize: "11px", fontWeight: 700, borderRadius: 8, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", cursor: "pointer", whiteSpace: "nowrap" }}>
                  View Pins
                </button>
                <Link href={studioHref} data-testid="create-more-button"
                  style={{ padding: "5px 0", fontSize: "10px", fontWeight: 600, borderRadius: 7, border: "1px solid var(--app-border)", color: "var(--app-text-sec)", background: "var(--app-surface)", textDecoration: "none", whiteSpace: "nowrap", textAlign: "center", display: "block" }}>
                  Create More
                </Link>
              </>
            ) : (
              <Link href={studioHref}
                style={{ padding: "6px 0", fontSize: "11px", fontWeight: 700, borderRadius: 8, background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", textDecoration: "none", whiteSpace: "nowrap", textAlign: "center", display: "block" }}>
                ✦ Create Pins
              </Link>
            )}
            <button type="button" onClick={() => setBriefOpen(b => !b)}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "9px", fontWeight: 500, color: "var(--app-text-muted)", whiteSpace: "nowrap" }}>
              {briefOpen ? "Hide brief ▴" : "View brief ▾"}
            </button>
          </div>

          {/* ── Kebab ── */}
          <div style={{ padding: "12px 6px 12px 0", display: "flex", alignItems: "flex-start", flexShrink: 0 }}>
            <button type="button" style={{ background: "none", border: "none", padding: "4px", cursor: "pointer", color: "#CBD5E1", fontSize: "16px", lineHeight: 1 }}>
              ⋮
            </button>
          </div>
        </div>

        {/* Expanded brief */}
        {briefOpen && (
          <div style={{ borderTop: "1px solid #F1F5F9", padding: "12px 16px 14px", background: "#FAFBFC" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "7px", marginBottom: "7px" }}>
              <BriefField label="Title Hook"        value={brief.title_hook}                      highlight />
              <BriefField label="Description Angle" value={brief.description_angle} />
              <BriefField label="Content Type"      value={brief.content_type} />
              <BriefField label="Visual Direction"  value={brief.visual_direction} />
              <BriefField label="Monetize Via"      value={brief.monetization_path.join(" · ")} accent="#F59E0B" />
              <BriefField label="CTA"               value={brief.cta_suggestion} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={copyBrief}
                style={{ padding: "4px 10px", fontSize: "10px", fontWeight: 700, borderRadius: 5, border: "1px solid var(--app-border)", background: copied ? "rgba(5,150,105,0.1)" : "transparent", color: copied ? "#059669" : "var(--app-text-sec)", cursor: "pointer" }}>
                {copied ? "✓ Copied" : "Copy Brief"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* View Pins modal */}
      {viewPinsOpen && (
        <ViewPinsModal
          keyword={brief.keyword}
          category={brief.category}
          studioHref={studioHref}
          onClose={() => setViewPinsOpen(false)}
        />
      )}
    </>
  );
}

// ── Week display helpers ──────────────────────────────────────────────────────

function formatWeekLabel(startISO: string): string {
  const start = new Date(`${startISO}T00:00:00`);
  const end   = new Date(start);
  end.setDate(start.getDate() + 6);
  const s = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const e = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `Week of ${s} – ${e}`;
}

function formatWeekRange(startISO: string): string {
  const start = new Date(`${startISO}T00:00:00`);
  const end   = new Date(start);
  end.setDate(start.getDate() + 6);
  const s = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const e = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${s} – ${e}`;
}

// ── Compact summary bar ───────────────────────────────────────────────────────

function SummarySep() {
  return (
    <span aria-hidden="true" style={{ color: "var(--app-text-muted)", margin: "0 8px", fontSize: 12, userSelect: "none" }}>·</span>
  );
}

function SummarySegment({ dot, count, label, tipLabel, testId, onClick }: {
  dot: string; count: number; label: string; tipLabel?: string; testId: string; onClick?: () => void;
}) {
  const clickable = !!onClick && count > 0;
  return (
    <span data-testid={testId} title={clickable ? "Open Batch Edit for these Pins" : tipLabel}
      onClick={clickable ? onClick : undefined}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: clickable ? "pointer" : "default",
        textDecoration: clickable ? "underline" : "none", textUnderlineOffset: 3 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0, display: "inline-block" }} />
      <span style={{ fontSize: 12, fontWeight: 800, color: "var(--app-text)" }}>{count}</span>
      <span style={{ fontSize: 12, fontWeight: 500, color: clickable ? "#C026D3" : "var(--app-text-sec)" }}>{label}</span>
    </span>
  );
}

function CompactSummaryBar({ stats }: { stats: WeeklyPlanStats }) {
  return (
    <div
      data-testid="weekly-plan-summary-bar"
      style={{
        display: "flex", alignItems: "center", flexWrap: "wrap",
        padding: "0 24px", minHeight: 44, gap: 0, rowGap: 6,
        borderTop: "1px solid var(--app-border)",
        borderBottom: "1px solid var(--app-border)",
        background: "var(--app-surface)",
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--app-text-sec)", marginRight: 8 }}>This week:</span>
      <SummarySegment dot="var(--app-text-muted)" count={stats.scheduled} label="scheduled" tipLabel="Pins scheduled in this week" testId="stat-scheduled" />
      <SummarySep />
      <SummarySegment dot="var(--app-text-muted)" count={stats.published} label="published" tipLabel="Pins published to Pinterest" testId="stat-published" />
      <SummarySep />
      <SummarySegment dot="var(--app-text-muted)" count={stats.unscheduled} label="unscheduled" tipLabel="Generated Pins not placed on the calendar" testId="stat-unscheduled" />
    </div>
  );
}

// ── Draggable pin card (calendar) ─────────────────────────────────────────────

/**
 * Shared hover-reveal selection checkbox. Used on EVERY selectable Weekly Plan surface
 * (Week tiles, Month items, Unscheduled cards) so selection is discoverable without an
 * "Edit Plan" mode. Appears on hover or when the card is selected (or when selection mode
 * pins it visible). Clicking it toggles selection only — it never opens details or drags.
 */
function SelectCheckbox({ selected, visible, onToggle, testId }: {
  selected: boolean; visible: boolean; onToggle: () => void; testId?: string;
}) {
  if (!visible && !selected) return null;
  return (
    <button
      type="button"
      data-testid={testId ?? "wp-select-checkbox"}
      title={selected ? "Deselect" : "Select"}
      onMouseDown={e => { e.stopPropagation(); }}
      onClick={e => { e.stopPropagation(); e.preventDefault(); onToggle(); }}
      style={{
        position: "absolute", top: 4, left: 4, width: 18, height: 18, borderRadius: 5, padding: 0, zIndex: 6,
        border: `2px solid ${selected ? "#C026D3" : "rgba(255,255,255,0.85)"}`,
        background: selected ? "#C026D3" : "rgba(15,23,42,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center", color: "#fff",
        fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: "pointer",
      }}
    >
      {selected ? "✓" : ""}
    </button>
  );
}

function DraggablePinCard({ draft, dnd, onEdit, compact, select, hoverActions }: {
  draft:   PinDraft;
  dnd:     PlanDnD;
  onEdit?: (draft: PinDraft) => void;
  compact?: boolean;
  select?: PlanSelect;
  hoverActions?: PinHoverPreviewActions;
}) {
  const isDragging = dnd.draggingId === draft.id;
  const selected = !!select?.isSelected(draft.id);
  const [hovered, setHovered] = useState(false);
  const checkVisible = hovered || !!select?.active;
  // Canonical event — identical planned-time source as Month view.
  const ev = mapPlanDraftToCalendarEvent(draft);
  return (
    <div
      draggable
      onDragStart={e => dnd.onPinDragStart(e, draft.id)}
      onDragEnd={dnd.onPinDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid="scheduled-draft-card"
      data-testid2="weekly-plan-pin-tile"
      style={{
        borderRadius: 8, overflow: "hidden",
        border: `${selected ? 2 : 1}px solid ${selected ? "#C026D3" : "var(--app-border)"}`,
        background: selected ? "rgba(192,38,211,0.07)" : "var(--app-surface-2)", cursor: "grab", position: "relative",
        opacity: isDragging ? 0.4 : 1, transition: "opacity 0.12s",
      }}
    >
      <PinHoverTarget
        draft={draft}
        actions={hoverActions ?? { variant: "scheduled", onEditDetails: onEdit ?? (() => {}), onViewDetails: onEdit }}
        disabled={!hoverActions}
        onClick={() => onEdit?.(draft)}
        style={{ aspectRatio: "2/3", background: "var(--app-surface-3, #0f172a)", position: "relative", cursor: "pointer", display: "block" }}
      >
        <PinThumbnail imgTestId="weekly-plan-pin-image" src={toProxyUrl(draft.imageUrl)} loading="eager" />
        {ev.plannedTime && (
          <span data-testid="weekly-plan-pin-time" style={{
            position: "absolute", bottom: 4, left: 4,
            fontSize: 9, fontWeight: 800, color: "#fff",
            background: "rgba(0,0,0,0.62)", padding: "1px 5px", borderRadius: 4, letterSpacing: "0.02em",
          }}>
            {ev.plannedTime}
          </span>
        )}
        {/* Subtle lock indicator — only shown when the Pin's time is locked. */}
        {draft.scheduleLocked && (
          <span data-testid="weekly-plan-pin-lock" title="Time locked — kept when rebalancing" aria-label="Time locked" style={{
            position: "absolute", bottom: 4, right: 4, fontSize: 9, lineHeight: 1,
            background: "rgba(0,0,0,0.62)", borderRadius: 4, padding: "1px 3px",
          }}>🔒</span>
        )}
        {select && <SelectCheckbox testId="scheduled-select-box" selected={selected} visible={checkVisible} onToggle={() => select.toggle(draft.id)} />}
        <button
          type="button"
          data-testid="scheduled-remove-btn"
          title="Remove from plan (back to unscheduled)"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); dnd.unschedule(draft.id); }}
          style={{
            position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: "50%",
            border: "none", background: "rgba(15,23,42,0.78)", color: "#fff", fontSize: 11,
            lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity 0.12s",
          }}
        >
          ✕
        </button>
      </PinHoverTarget>
    </div>
  );
}

// ── Empty Smart Schedule slot (week view) ──────────────────────────────────────
// A configured posting time with no Pin. Future slots accept a dropped Pin; past
// slots are display-only ("Past") and reject drops.

function SlotPlaceholder({ time, isPast, dayKey, isActive, isOver, onOver, onDropPin }: {
  time: string; isPast: boolean; dayKey: string; isActive: boolean; isOver: boolean;
  onOver: (k: string | null) => void; onDropPin: (id: string) => void;
}) {
  const slotKey = `${dayKey}:${time}`;
  return (
    <div
      data-testid={isPast ? "calendar-slot-past" : "calendar-slot-empty"}
      data-slot-time={time}
      onDragOver={isPast ? undefined : e => { if (isActive) { e.preventDefault(); e.stopPropagation(); onOver(slotKey); } }}
      onDragLeave={isPast ? undefined : () => onOver(null)}
      onDrop={isPast ? undefined : e => { e.preventDefault(); e.stopPropagation(); const id = readDragId(e); if (id) onDropPin(id); }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6,
        padding: "7px 8px", borderRadius: 8,
        border: `1px dashed ${isOver ? "rgba(192,38,211,0.6)" : "var(--app-border)"}`,
        background: isOver ? "rgba(192,38,211,0.08)" : "transparent",
        opacity: isPast ? 0.45 : 1,
        cursor: isPast ? "default" : "copy",
      }}
    >
      <span data-testid="calendar-slot-time" style={{ fontSize: 10, fontWeight: 800, color: "var(--app-text-sec)", fontVariantNumeric: "tabular-nums" }}>{time}</span>
      <span style={{ fontSize: 9, fontWeight: 700, color: "var(--app-text-muted)" }}>{isPast ? "Past" : "Drop pin here"}</span>
    </div>
  );
}

// ── Day column (week view) ─────────────────────────────────────────────────────

function DayColumn({ dayLabel, dateStr, dateISO, isToday, dayBriefs, dayDrafts, dnd, onEdit, select, hoverActions }: {
  dayLabel:  string;
  dateStr:   string;
  dateISO:   string;
  isToday:   boolean;
  dayBriefs: PinBrief[];
  dayDrafts: PinDraft[];
  dnd:       PlanDnD;
  onEdit:    (d: PinDraft) => void;
  select?:   PlanSelect;
  hoverActions?: PinHoverPreviewActions;
}) {
  const dayKey   = `day:${dateISO}`;
  const isOver   = dnd.dragOverKey === dayKey;
  const isActive = !!dnd.draggingId;
  const [hovered, setHovered] = useState(false);

  // Render the day as a Smart Schedule time-slot queue: every configured slot
  // (occupied or empty) plus any off-grid manual times, ordered by time. Empty future
  // slots are drop targets; empty past slots are display-only.
  const slotRows = buildDaySlotRows(dateISO, dayDrafts);
  const hasAnything = slotRows.length > 0 || dayBriefs.length > 0;

  return (
    <div
      data-testid="calendar-day"
      data-testid2="weekly-plan-day-column"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={e => { if (isActive) { e.preventDefault(); dnd.setDragOverKey(dayKey); } }}
      onDragLeave={() => { if (dnd.dragOverKey === dayKey) dnd.setDragOverKey(null); }}
      onDrop={e => { e.preventDefault(); const id = readDragId(e); if (id) dnd.assignToDate(id, dateISO); }}
      style={{
        minHeight: 200,
        borderRadius: 12,
        border: `1px solid ${isOver ? "rgba(192,38,211,0.55)" : isToday ? "rgba(192,38,211,0.35)" : "var(--app-border)"}`,
        boxShadow: isOver ? "0 0 0 2px rgba(192,38,211,0.18)" : "none",
        background: "var(--app-surface)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        transition: "border-color 0.1s, box-shadow 0.1s",
      }}
    >
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--app-border)", background: isToday ? "rgba(192,38,211,0.06)" : "transparent" }}>
        <div style={{ fontSize: 9, fontWeight: 800, color: isToday ? "#C026D3" : "var(--app-text-muted)", letterSpacing: "0.08em" }}>{dayLabel}</div>
        <div style={{ fontSize: 12, fontWeight: 800, color: "var(--app-text)" }}>{dateStr}</div>
      </div>

      <div data-testid="weekly-plan-day-queue" style={{ flex: 1, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Keyword plan slots (kept above the Pin queue) */}
        {dayBriefs.map(brief => (
          <div key={brief.id} data-testid="calendar-keyword-slot" style={{ padding: "5px 7px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface-2)" }}>
            <p style={{ margin: 0, fontSize: 9, fontWeight: 700, color: "var(--app-text)", textTransform: "capitalize", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{brief.keyword}</p>
          </div>
        ))}

        {/* Time-slot queue — occupied tiles + empty future drop slots + disabled past slots */}
        {slotRows.map(row => row.draft ? (
          <DraggablePinCard key={row.draft.id} draft={row.draft} dnd={dnd} onEdit={onEdit} select={select} hoverActions={hoverActions} />
        ) : (
          <SlotPlaceholder
            key={`slot:${row.time}`}
            time={row.time}
            isPast={row.isPast}
            isActive={isActive}
            isOver={dnd.dragOverKey === `${dayKey}:${row.time}`}
            onOver={k => dnd.setDragOverKey(k)}
            onDropPin={id => dnd.assignToDate(id, dateISO, row.time)}
            dayKey={dayKey}
          />
        ))}

        {!hasAnything && (
          <div data-testid="calendar-empty-slot" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: "10px 6px", textAlign: "center" }}>
            <p style={{ margin: 0, fontSize: 10, color: "var(--app-text-muted)", opacity: 0.7 }}>No posting slots for this day</p>
            <Link
              href="/app/studio"
              style={{
                fontSize: 10, fontWeight: 700, color: "#C026D3", textDecoration: "none",
                opacity: hovered || isActive ? 1 : 0, transition: "opacity 0.12s",
                pointerEvents: hovered || isActive ? "auto" : "none",
              }}
            >
              + Add Pin
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Week calendar ──────────────────────────────────────────────────────────────

function WeekCalendar({ weekStart, slots, scheduledDrafts, dnd, onEdit, select, hoverActions }: {
  weekStart:       string;
  slots:           PinBrief[][];
  scheduledDrafts: PinDraft[];
  dnd:             PlanDnD;
  onEdit:          (d: PinDraft) => void;
  select?:         PlanSelect;
  hoverActions?:   PinHoverPreviewActions;
}) {
  const today = new Date();
  return (
    <div data-testid="weekly-plan-calendar" data-testid2="weekly-plan-week-grid" style={{ maxWidth: "980px", margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }}>
      {DAY_SHORT.map((dayLabel, i) => {
        const d = new Date(`${weekStart}T00:00:00`);
        d.setDate(d.getDate() + i);
        const dateISO = localISO(d);
        const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const isToday = d.toDateString() === today.toDateString();
        return (
          <DayColumn
            key={dayLabel}
            dayLabel={dayLabel}
            dateStr={dateStr}
            dateISO={dateISO}
            isToday={isToday}
            dayBriefs={slots[i]}
            dayDrafts={scheduledDrafts.filter(x => x.scheduledDate === dateISO)}
            dnd={dnd}
            onEdit={onEdit}
            select={select}
            hoverActions={hoverActions}
          />
        );
      })}
    </div>
  );
}

// ── Month calendar ─────────────────────────────────────────────────────────────

// ── Month day cell — time-ordered publishing list ──────────────────────────────
// A month cell is a mini publishing timeline: each row is `time + thumbnail`,
// sorted by planned time ascending, max 3 rows + "+N more". Clicking the cell
// opens the Day Detail panel. No image-only / time-less rows.

function MonthDayCell({ date, inMonth, isToday, drafts, dnd, onOpenDay, select, hoverActions }: {
  date:    Date;
  inMonth: boolean;
  isToday: boolean;
  drafts:  PinDraft[];
  dnd:     PlanDnD;
  onOpenDay: (iso: string) => void;
  select?: PlanSelect;
  hoverActions?: PinHoverPreviewActions;
}) {
  const iso    = localISO(date);
  const key    = `mday:${iso}`;
  const isOver = dnd.dragOverKey === key;
  const isActive = !!dnd.draggingId;
  const selecting = !!select?.active;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Canonical events — same mapping + ordering source as Week view.
  const rows    = draftsToSortedEvents(drafts);
  const byId    = new Map(drafts.map(d => [d.id, d]));
  const visible = rows.slice(0, 3);
  const extra   = rows.length - visible.length;
  const hasPins = rows.length > 0;
  const clickable = hasPins;
  return (
    <div
      data-testid="month-day-cell"
      onDragOver={e => { if (isActive) { e.preventDefault(); dnd.setDragOverKey(key); } }}
      onDragLeave={() => { if (dnd.dragOverKey === key) dnd.setDragOverKey(null); }}
      onDrop={e => { e.preventDefault(); const id = readDragId(e); if (id) dnd.assignToDate(id, iso); }}
      onClick={() => { if (clickable) onOpenDay(iso); }}
      style={{
        minHeight: 172, borderRadius: 9, padding: 7, display: "flex", flexDirection: "column", gap: 6,
        border: `1px solid ${isOver ? "rgba(192,38,211,0.55)" : isToday ? "rgba(192,38,211,0.35)" : "var(--app-border)"}`,
        boxShadow: isOver ? "0 0 0 2px rgba(192,38,211,0.18)" : "none",
        background: inMonth ? "var(--app-surface)" : "var(--app-bg)",
        opacity: inMonth ? 1 : 0.5,
        cursor: clickable ? "pointer" : "default",
        transition: "border-color 0.1s, box-shadow 0.1s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: isToday ? "#C026D3" : "var(--app-text-muted)" }}>{date.getDate()}</span>
        {hasPins && (
          <span style={{ fontSize: 8.5, fontWeight: 800, color: "var(--app-text-muted)", background: "var(--app-surface-2)", borderRadius: 20, padding: "1px 6px" }}>
            {rows.length}
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {visible.map(ev => {
          const selected = !!select?.isSelected(ev.draftId);
          const checkVisible = hoveredId === ev.draftId || selecting;
          const d = byId.get(ev.draftId)!;
          return (
            <div
              key={ev.draftId}
              data-testid="month-pin-row"
              draggable
              onDragStart={e => dnd.onPinDragStart(e, ev.draftId)}
              onDragEnd={dnd.onPinDragEnd}
              onMouseEnter={() => setHoveredId(ev.draftId)}
              onMouseLeave={() => setHoveredId(prev => prev === ev.draftId ? null : prev)}
              title={`${ev.plannedTime} · ${ev.title}`}
              style={{
                display: "flex", alignItems: "center", gap: 7,
                cursor: "grab",
                background: selected ? "rgba(192,38,211,0.08)" : "transparent", borderRadius: 6,
                opacity: dnd.draggingId === ev.draftId ? 0.4 : 1,
              }}
            >
              <span data-testid="month-pin-time" style={{
                flexShrink: 0, fontSize: 10, fontWeight: 800, color: "var(--app-text-sec)",
                fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em",
              }}>
                {ev.plannedTime}
              </span>
              {/* Pinterest portrait thumbnail (2:3). Same shared hover preview card
                  (PinHoverTarget) as Week view; click bubbles to open Day Detail.
                  The hover checkbox toggles selection without opening details. */}
              <PinHoverTarget
                draft={d}
                actions={hoverActions ?? { variant: "scheduled", onEditDetails: () => {} }}
                disabled={!hoverActions}
                style={{
                  position: "relative", flexShrink: 0, width: 34, height: 48, borderRadius: 6, overflow: "hidden",
                  border: `${selected ? 2 : 1}px solid ${selected ? "#C026D3" : "var(--app-border)"}`, background: "var(--app-surface-3, #0f172a)",
                  cursor: "pointer", display: "block",
                }}
              >
                <PinThumbnail src={toProxyUrl(ev.imageUrl)} loading="lazy" />
                {select && <SelectCheckbox testId="month-select-box" selected={selected} visible={checkVisible} onToggle={() => select.toggle(ev.draftId)} />}
              </PinHoverTarget>
            </div>
          );
        })}
        {extra > 0 && (
          <div data-testid="month-more" style={{ fontSize: 9.5, fontWeight: 700, color: "#C026D3", paddingLeft: 2 }}>
            +{extra} more
          </div>
        )}
      </div>
    </div>
  );
}

function MonthCalendar({ monthAnchorISO, scheduledDrafts, dnd, onOpenDay, select, hoverActions }: {
  monthAnchorISO:  string;
  scheduledDrafts: PinDraft[];
  dnd:             PlanDnD;
  onOpenDay:       (iso: string) => void;
  select?:         PlanSelect;
  hoverActions?:   PinHoverPreviewActions;
}) {
  const anchor = new Date(`${monthAnchorISO}T00:00:00`);
  const year   = anchor.getFullYear();
  const month  = anchor.getMonth();
  const first  = new Date(year, month, 1);
  const firstDow = (first.getDay() + 6) % 7; // Monday = 0
  const gridStart = new Date(year, month, 1 - firstDow);
  const today = new Date();

  const byDate = new Map<string, PinDraft[]>();
  for (const d of scheduledDrafts) {
    const arr = byDate.get(d.scheduledDate) ?? [];
    arr.push(d);
    byDate.set(d.scheduledDate, arr);
  }

  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });

  return (
    <div data-testid="weekly-plan-month" style={{ maxWidth: "980px", margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, marginBottom: 6 }}>
        {DAY_SHORT.map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 9, fontWeight: 800, color: "var(--app-text-muted)", letterSpacing: "0.06em" }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6 }}>
        {cells.map((date, i) => {
          const iso = localISO(date);
          return (
            <MonthDayCell
              key={i}
              date={date}
              inMonth={date.getMonth() === month}
              isToday={date.toDateString() === today.toDateString()}
              drafts={byDate.get(iso) ?? []}
              dnd={dnd}
              onOpenDay={onOpenDay}
              select={select}
              hoverActions={hoverActions}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Day Detail panel (Month view) ──────────────────────────────────────────────
// Opens when a month cell is clicked. Lists that day's Pins as time + thumbnail +
// title + status, with per-item Edit / Reschedule / Publish actions.

function DayDetailDrawer({ dateISO, drafts, onClose, onEditDetails, onReschedule, select }: {
  dateISO:       string | null;
  drafts:        PinDraft[];
  onClose:       () => void;
  onEditDetails: (d: PinDraft) => void;
  onReschedule:  (d: PinDraft) => void;
  select?:       PlanSelect;
}) {
  const rows = draftsToSortedEvents(drafts);
  const byId = new Map(drafts.map(d => [d.id, d]));
  if (!dateISO) return null;
  const dateLabel = new Date(`${dateISO}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 72, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "flex-end" }}>
      <div data-testid="month-day-detail" onClick={e => e.stopPropagation()}
        style={{ width: 420, maxWidth: "94vw", height: "100%", background: "var(--app-surface)", borderLeft: "1px solid var(--app-border)", display: "flex", flexDirection: "column", boxShadow: "-12px 0 40px rgba(0,0,0,0.35)" }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--app-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "var(--app-text)" }}>{dateLabel}</h2>
            <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--app-text-sec)" }}>
              {rows.length} Pin{rows.length === 1 ? "" : "s"} scheduled · times in your local zone
            </p>
          </div>
          <button type="button" data-testid="day-detail-close" onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", color: "var(--app-text-muted)", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.length === 0 ? (
            <p style={{ margin: "8px 4px", fontSize: 12, color: "var(--app-text-muted)" }}>No Pins scheduled for this day.</p>
          ) : rows.map(ev => {
            const d = byId.get(ev.draftId)!;
            const published = !!d.postedAt;
            return (
              <div key={ev.draftId} data-testid="day-detail-row"
                style={{ display: "flex", gap: 11, padding: 10, borderRadius: 11, border: "1px solid var(--app-border)", background: "var(--app-surface-2)" }}>
                <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <span data-testid="day-detail-time" style={{ fontSize: 12, fontWeight: 800, color: "var(--app-text)", fontVariantNumeric: "tabular-nums" }}>{ev.plannedTime}</span>
                  <div style={{ position: "relative", width: 58, height: 78, borderRadius: 8, overflow: "hidden", background: "var(--app-surface-3, #0f172a)", border: `1px solid ${select?.isSelected(ev.draftId) ? "#C026D3" : "var(--app-border)"}` }}>
                    <PinThumbnail src={toProxyUrl(ev.imageUrl)} loading="lazy" />
                    {select && <SelectCheckbox testId="day-detail-select-box" selected={!!select.isSelected(ev.draftId)} visible onToggle={() => select.toggle(ev.draftId)} />}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: "var(--app-text)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {ev.title}
                  </p>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: published ? "#7C3AED" : "#059669" }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: published ? "#7C3AED" : "#059669" }} />
                    {published ? "Published" : "Scheduled"}
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                    <button type="button" data-testid="day-detail-edit" onClick={() => onEditDetails(d)}
                      style={{ padding: "5px 10px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}>
                      Edit details
                    </button>
                    <button type="button" data-testid="day-detail-reschedule" onClick={() => onReschedule(d)}
                      style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-sec)", fontSize: 10.5, fontWeight: 600, cursor: "pointer" }}>
                      Reschedule
                    </button>
                    {!published && (
                      <button type="button" data-testid="day-detail-publish" onClick={() => onEditDetails(d)}
                        style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid rgba(5,150,105,0.45)", background: "rgba(5,150,105,0.10)", color: "#10B981", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}>
                        Publish now
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Inner page ────────────────────────────────────────────────────────────────

function PlanPageInner() {
  const searchParams = useSearchParams();
  const { t: tr } = useLocale();

  // ── [Plan timing] investigation trace — OAuth-return → Plan → drawer restore ──
  // Shared t0 for every "[Plan timing]" checkpoint logged from this page (auth/
  // workspace/query checkpoints are logged from useWeeklyPlan against its own,
  // effectively-identical mount time). See src/lib/planLoadTiming.ts for the tag.
  const [planPageMountedAt] = useState(() => performance.now());
  const planTimingLoggedRef = useRef(false);
  useEffect(() => {
    if (planTimingLoggedRef.current) return;
    planTimingLoggedRef.current = true;
    logPlanTiming("page mounted", performance.now() - planPageMountedAt);
  }, [planPageMountedAt]);

  // Weekly Plan is ONE unified publishing calendar for the workspace. Category is no
  // longer a plan switcher — it is an optional filter (default: all categories). A
  // legacy ?category= deep-link is honoured as the initial filter for back-compat.
  const deepLinkCategory = searchParams.get("category");
  const [category, setCategory] = useState<string>(() =>
    deepLinkCategory && ACTIVE_CATEGORIES.some(c => c.id === deepLinkCategory)
      ? deepLinkCategory
      : ALL_CATEGORIES,
  );
  const isAllCategories = category === ALL_CATEGORIES;
  const catDef   = CATEGORIES.find(c => c.id === category);
  const catLabel = isAllCategories ? "All categories" : (catDef?.label ?? category);

  const [viewMode, setViewMode] = useState<ViewMode>("calendar");
  const [calendarScope, setCalendarScope] = useState<CalendarScope>("week");
  const [calendarEditDraft, setCalendarEditDraft] = useState<PinDraft | null>(null);
  const [weekOffset, setWeekOffset]   = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  // Every pin tile's hover-preview card lives in its own portal above the Edit-Pin
  // modal (z-index 85 vs the modal's 80/81) and manages its open state locally — there
  // is no shared hover state here to clear. Clicking an action *inside* an open
  // preview card (e.g. "Edit details") opens this modal without the pointer ever
  // leaving the card, so nothing would otherwise close it — it stayed floating on top
  // of the modal. Broadcasting the modal's open state force-closes every hover card.
  useEffect(() => {
    setPinPreviewSuspended(calendarEditDraft !== null);
    // Defensive: this flag is module-level (shared across every hover-preview
    // instance on the page), so if this component ever unmounts while the modal is
    // open (e.g. Fast Refresh), clear it rather than leaving hover previews
    // permanently disabled for the rest of the page's lifetime.
    return () => setPinPreviewSuspended(false);
  }, [calendarEditDraft]);
  const [smartScheduleOpen, setSmartScheduleOpen] = useState(false);
  // Month view: Day Detail panel + collapsed Unscheduled drawer.
  const [dayDetailISO, setDayDetailISO] = useState<string | null>(null);
  const [monthUnscheduledOpen, setMonthUnscheduledOpen] = useState(false);

  function minimumPlanContentError(draft: PinDraft | null | undefined): string | null {
    if (!draft) return "Could not find this Pin.";
    if (!sanitizeHandoffField(draft.imageUrl)) return "This Pin needs an image before it can be scheduled.";
    if (!displayTitle(draft.title, draft.keyword)) return "This Pin needs a title before it can be scheduled.";
    if (!sanitizeHandoffField(draft.description)) return "This Pin needs a description before it can be scheduled.";
    return null;
  }

  const handleSmartScheduleAdd = useCallback((id: string) => {
    const contentError = minimumPlanContentError(pinDraftStore.getDraft(id));
    if (contentError) {
      toast.error(contentError);
      return;
    }
    const result = ensureScheduledPlanTime(id);
    if (result.ok) {
      toast.success(result.toast);
      return;
    }
    if (result.reason === "no_schedule") {
      toast.error(result.toast);
      setSmartScheduleOpen(true);
      return;
    }
    toast.error(result.toast);
  }, []);

  const scheduledHoverActions = useMemo<PinHoverPreviewActions>(() => ({
    variant: "scheduled",
    onEditDetails: setCalendarEditDraft,
    // Clicking a tile / "View details" opens the Edit details drawer directly (the
    // canonical editor) — no separate click popover. Rescheduling lives inside that
    // drawer (date/time editor) and via drag-and-drop, so no dedicated hover button.
    onViewDetails: setCalendarEditDraft,
    onToggleLock: (draft, locked) => {
      pinDraftStore.setScheduleLocked(draft.id, locked);
      toast.success(locked ? "Time locked — kept during rebalancing." : "Time unlocked.");
    },
    // Publish now: distinct from scheduling. Only a board is required (Website URL is
    // optional; missing product is NOT a blocker). Always opens Pin Details — the
    // canonical publish surface — so the real publish flow runs there; never marks
    // posted here.
    onPublishNow: (draft) => {
      const hasBoard = !!(sanitizeHandoffField(draft.boardId) || sanitizeHandoffField(draft.metadataDraft?.boardId));
      if (!hasBoard) {
        toast.error("Add a board before publishing.");
      }
      setCalendarEditDraft(draft);
    },
  }), []);
  const unscheduledHoverActions = useMemo<PinHoverPreviewActions>(() => ({
    variant: "unscheduled",
    onEditDetails: setCalendarEditDraft,
    onAddToPlan: handleSmartScheduleAdd,
  }), [handleSmartScheduleAdd]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Only true after hydration on a wide viewport — drives the right rail vs. stacked
  // fallback. Safe to read here because all consumers render inside the `hydrated` gate.
  const wideLayout = useWideLayout();

  // Hydration gate. The calendar tree and week/month labels derive from localStorage
  // drafts and `new Date()` — both differ between the server render and the browser.
  // Until mounted we render a deterministic skeleton so the server HTML and the first
  // client render are identical (no hydration mismatch). Real content fills in after.
  // `useState`'s lazy initializer runs exactly once, at first render — the
  // React-blessed way to capture a one-time impure value (vs. computing it
  // inline during render, which the compiler flags as impure).
  const [pageMountedAt] = useState(() => performance.now());
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration-gate flip, not a sync loop
    setHydrated(true);
    markDataReady("/app/plan");
    logPlanHydrated(performance.now() - pageMountedAt);
  }, [pageMountedAt]);
  useEffect(() => {
    if (hydrated) return;
    const fallback = setTimeout(() => {
      setHydrated(true);
      markDataReady("/app/plan");
      logPlanHydrated(performance.now() - pageMountedAt);
    }, 1500);
    return () => clearTimeout(fallback);
  }, [hydrated, pageMountedAt]);

  // Safety net: normalize any legacy "in plan but time-less" drafts once, so every
  // scheduled Pin has a real stored plannedDate/plannedTime/plannedAt (no UI fallback).
  const normalizedRef = useRef(false);
  useEffect(() => {
    if (normalizedRef.current) return;
    normalizedRef.current = true;
    normalizeInPlanDraftTimes();
  }, []);

  // ── Modal restore after Pinterest OAuth ──────────────────────────────────────
  const modalRestoredRef  = useRef(false);
  // Post-OAuth restore banner. Null = hidden. Holds the exact message shown when we
  // can't reopen the Pin (OAuth failed, or the draft is no longer in local storage).
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  useEffect(() => {
    if (modalRestoredRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const modalParam  = params.get("modal");
    const pinIdParam  = params.get("pinId");
    const pinterestParam = params.get("pinterest");
    if (modalParam !== "publish" || !pinIdParam) return;
    modalRestoredRef.current = true;
    logPlanTiming("drawer restore started", performance.now() - planPageMountedAt);

    const returnView = params.get("view");
    const returnScope = params.get("scope");
    const returnWeekStart = params.get("weekStart");
    const returnMonth = params.get("month");
    const returnCategory = params.get("category");

    if (returnView === "calendar" || returnView === "list") setViewMode(returnView);
    if (returnScope === "week" || returnScope === "month") {
      setCalendarScope(returnScope);
      persistCalendarScope(returnScope);
    }
    if (returnCategory && (returnCategory === ALL_CATEGORIES || ACTIVE_CATEGORIES.some(c => c.id === returnCategory))) {
      setCategory(returnCategory);
    }
    if (returnWeekStart) {
      const nextWeekOffset = weekOffsetFromStartISO(returnWeekStart);
      if (nextWeekOffset !== null) setWeekOffset(nextWeekOffset);
    }
    if (returnMonth) {
      const nextMonthOffset = monthOffsetFromAnchorISO(returnMonth);
      if (nextMonthOffset !== null) setMonthOffset(nextMonthOffset);
    }

    // Clean up OAuth / modal params without triggering a navigation. The calendar
    // view (week/month) survives the OAuth round-trip on its own via the persisted
    // `vp:plan_calendar_scope` localStorage value (see the scope-init effect), so it
    // needs no query param here.
    const url = new URL(window.location.href);
    url.searchParams.delete("modal");
    url.searchParams.delete("pinId");
    url.searchParams.delete("pinterest");
    url.searchParams.delete("view");
    url.searchParams.delete("scope");
    url.searchParams.delete("weekStart");
    url.searchParams.delete("month");
    window.history.replaceState({}, "", url.toString());

    // The callback returns "connected" only on full success; "cancelled" when the
    // user backed out; anything else is a failure (state_mismatch / state_expired /
    // session_expired / exchange_failed / persist_failed / config_error). In ALL
    // cases we still reopen the Pin drawer (so the user can retry or continue in
    // place) — we only differ in the toast, and only fall back to a banner when the
    // Pin itself can't be found. No status ever leaves the page blank or spinning.
    const isConnected = pinterestParam === "connected";
    const isCancelled = pinterestParam === "cancelled";
    const isFailure = !!pinterestParam && !isConnected && !isCancelled;

    // Only a real successful round-trip triggers the deferred profile backfill.
    if (isConnected) {
      // Defer the profile backfill so it does NOT race the drawer's boards call for the
      // Pinterest token. Both sync-account (Pinterest /user_account) and boards
      // (Pinterest /boards) build a client from the same connection row; firing them at
      // once right after connecting can have both trigger a Pinterest token
      // refresh-on-401 simultaneously, and Pinterest can reject one of the two — which
      // showed up as an intermittent boards 401 immediately after OAuth. sync-account is
      // best-effort background username enrichment, so a few seconds' delay is
      // invisible to the user and lets boards win the token cleanly.
      setTimeout(() => { void syncPinterestAccount(); }, 6000);
      // Defensive: a stale "not connected" boards-cache entry from BEFORE this OAuth
      // round trip (e.g. a Pin drawer opened earlier in this tab, or another tab)
      // must never be served instantly over the freshly-connected state.
      invalidateBoardsCache();
      invalidateConnectionsCache();
      // The "connected" flag is only ever sent AFTER the callback persisted the
      // tokens, so the client can assert connected immediately instead of every
      // surface re-deriving it from a slow status round trip (which, when it lost
      // a 2.5s race through the proxy, used to leave the drawer on "Not
      // connected"). Also start the boards fetch NOW — the reopened drawer's own
      // call joins this in-flight request (single-flight in pinterestClient)
      // instead of starting cold after mount.
      seedPinterestStatusConnected();
      void fetchPinterestBoards().catch(() => {});
    }

    const draft = pinDraftStore.getDraft(pinIdParam);
    if (draft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCalendarEditDraft(draft);
      if (isConnected) {
        toast.success("Pinterest connected. You can continue publishing this Pin.");
      } else if (isCancelled) {
        toast.info("Pinterest connection was cancelled. You can try again when ready.");
      } else if (isFailure) {
        toast.error("Pinterest couldn't be connected. Please try again from the Pin.");
      }
    } else {
      // Drawer context is gone (draft no longer in local storage) — render Plan
      // normally with a safe, actionable message instead of a blank/failed state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRestoreNotice(isConnected
        ? "Pinterest connected. Please select the Pin again to continue publishing."
        : "Pinterest connection was not completed. Please select the Pin again.");
    }
    // "Finished" here means the drawer's `open` prop flipped (or the not-found
    // banner was decided) — a synchronous localStorage read, NOT gated on the
    // useWeeklyPlan Supabase query or the Pinterest sync call above, which is why
    // this timestamp should stay small even when the plan-row query is slow.
    logPlanTiming("drawer restore finished", performance.now() - planPageMountedAt, `outcome=${draft ? "opened" : "not_found"}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismissRestoreNotice() { setRestoreNotice(null); }
  const [planStats, setPlanStats] = useState<WeeklyPlanStats>({
    scheduled: 0, published: 0, unscheduled: 0, plannedThisWeek: 0, ready: 0, needsDetails: 0, unscheduledGenerated: 0, posted: 0,
  });

  // Drag-and-drop state, shared with calendar + side sections.
  const [draggingId, setDraggingId]   = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const scopeInitRef = useRef(false);

  const dnd: PlanDnD = useMemo(() => ({
    draggingId,
    dragOverKey,
    setDragOverKey,
    onPinDragStart: (e: RDragEvent, id: string) => {
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
      setDraggingId(id);
    },
    onPinDragEnd: () => { setDraggingId(null); setDragOverKey(null); },
    assignToDate: (id: string, date: string, time?: string) => {
      // Dropping on a SPECIFIC empty slot (explicit time) → honour that exact slot.
      if (time) {
        pinDraftStore.assignDraftToDate(id, date, time);
        setDraggingId(null);
        setDragOverKey(null);
        return;
      }
      // Dropping on a DAY (no specific slot): the day must have a free future Smart
      // Schedule slot. A full/past day shows clear feedback — never silently dropped,
      // never an overflow slot, never rolled to another day behind the user's back.
      const dayDrafts = pinDraftStore.getAllDrafts().filter(d => d.scheduledDate === date && d.id !== id);
      if (!dayHasFreeFutureSlot(date, dayDrafts)) {
        const label = formatScheduleDateLabel(date);
        const { reason, scheduledCount } = classifyDayDropBlock(date, dayDrafts);
        const editAction = { label: "Edit Smart Schedule", onClick: () => setSmartScheduleOpen(true) };
        if (reason === "all_past") {
          // The day is NOT full — its remaining slots have simply already passed
          // (e.g. dragging onto today after the last slot time). Tell the truth.
          toast.error(`No open time left on ${label}.`, {
            description: `${label}'s remaining Smart Schedule slots have already passed. Pick a later custom time today, or choose another day.`,
            action: editAction,
          });
        } else if (reason === "no_slots") {
          toast.error(`No Smart Schedule slots on ${label}.`, {
            description: `${label} has no Smart Schedule time slots yet. Add a slot in Smart Schedule, or choose another day.`,
            action: editAction,
          });
        } else {
          // Genuinely full: every configured slot on the TARGET day is taken.
          toast.error(`No available slots on ${formatScheduleDateLabel(date)}.`, {
            description: `This day already has ${scheduledCount} scheduled Pin${scheduledCount === 1 ? "" : "s"} filling every Smart Schedule slot. Increase pins per day or choose another day.`,
            action: editAction,
          });
        }
        setDraggingId(null);
        setDragOverKey(null);
        return;
      }
      // A real Smart Schedule slot time is always assigned (canonical helper) so no
      // time-less pins enter the plan; the user picked the day, so it's a manual pin.
      ensureScheduledPlanTime(id, { date, reschedule: true, source: "manual" });
      setDraggingId(null);
      setDragOverKey(null);
    },
    unschedule: (id: string) => {
      pinDraftStore.removeFromWeeklyPlan(id);
      setDraggingId(null);
      setDragOverKey(null);
    },
  }), [draggingId, dragOverKey, setSmartScheduleOpen]);

  // ── Edit Plan multi-select + shared Batch Edit ──────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchDraftIds, setBatchDraftIds] = useState<string[]>([]);
  const [moveDateOpen, setMoveDateOpen] = useState(false);
  const [moveDateValue, setMoveDateValue] = useState("");

  const select: PlanSelect = {
    active: editMode,
    isSelected: (id: string) => selectedIds.has(id),
    toggle: (id: string) => setSelectedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
  };

  function toggleEditMode() {
    setEditMode(m => { if (m) setSelectedIds(new Set()); return !m; });
  }

  // Build the shared BatchPinRow[] from selected weekly-plan drafts. Computed only
  // while the editor is open (cheap; reads the live store so edits reflect immediately).
  const batchPins: BatchPinRow[] = !batchOpen ? [] :
    batchDraftIds.map(id => pinDraftStore.getDraft(id)).filter((d): d is PinDraft => !!d).map(d => {
      // Canonical product resolution — same sources the single-Pin edit modal reads,
      // so linked products never disappear when a scheduled Pin enters Batch Edit.
      const { primary, tagged } = resolveCanonicalPinProducts({
        metadataDraft:         d.metadataDraft,
        linkedProducts:        d.linkedProducts,
        primaryProductId:      d.primaryProductId,
        setupProducts:         d.setupSnapshot?.selectedProducts,
        productId:             d.productId,
        creatorProductLinkId:  d.creatorProductLinkId,
        sourceProductImageUrl: d.sourceProductImageUrl,
      });
      return {
        pinId: d.id, sessionId: d.generationSessionId ?? "", groupIdx: 0, pinIdx: 0,
        imageUrl: d.imageUrl, title: d.title, description: d.description, altText: d.altText,
        destinationUrl: d.destinationUrl, plannedDate: d.scheduledDate ?? "", plannedTime: d.scheduledTime ?? "", plannedAt: d.plannedAt ?? "", postedAt: d.postedAt,
        addedToPlanAt: d.addedToPlanAt,
        planningStatus: d.planningStatus ?? (d.status === "ready" ? "ready" : "needs_review"),
        boardSuggestion: d.metadataDraft?.boardSuggestion ?? "",
        boardId: d.boardId || d.metadataDraft?.boardId || "",
        boardName: d.boardName || d.metadataDraft?.boardName || "",
        metadataDraft: d.metadataDraft,
        linkedProductId: primary?.productId, linkedProductTitle: primary?.title,
        linkedProductImageUrl: primary?.imageUrl, linkedProductUrl: primary?.productUrl,
        linkedProductSource: primary?.source, isAutoLinked: primary?.linkType === "auto",
        taggedCount: tagged.length, taggedProducts: tagged,
        category: d.category ?? "",
        setupProducts: d.setupSnapshot?.selectedProducts ?? [],
      };
    });

  function openBatchEditFor(ids: string[]) {
    if (!ids.length) return;
    setBatchDraftIds(ids);
    setBatchOpen(true);
  }

  // Shared apply — write edits back into the PinDraft (which syncs pinMetadataStore,
  // so Create Pins History reflects the same change). No duplicate save logic.
  function handleWpBatchApply(opts: BatchApplyOpts) {
    for (const [draftId, e] of Object.entries(opts.rowEdits)) {
      const draft = pinDraftStore.getDraft(draftId);
      if (!draft) continue;
      const patch: Partial<PinDraft> = {};
      if (e.title          !== undefined) patch.title = e.title;
      if (e.description    !== undefined) patch.description = e.description;
      if (e.altText        !== undefined) patch.altText = e.altText;
      if (e.destinationUrl !== undefined) patch.destinationUrl = e.destinationUrl;
      if (e.plannedDate    !== undefined) patch.scheduledDate = e.plannedDate;
      if (e.plannedTime    !== undefined) patch.scheduledTime = e.plannedTime;
      if (e.plannedAt      !== undefined) patch.plannedAt = e.plannedAt;
      // A Batch Edit publish-time override is a manual pin — skipped by rebalance.
      if (e.plannedDate !== undefined || e.plannedTime !== undefined) {
        patch.scheduleSource = "manual";
        patch.scheduleLocked = true;
      }
      if (e.planningStatus !== undefined) patch.status = e.planningStatus === "ready" ? "ready" : "needs_review";
      let md = draft.metadataDraft;
      if (md && (e.plannedDate !== undefined || e.plannedTime !== undefined || e.plannedAt !== undefined)) {
        md = {
          ...md,
          plannedDate: e.plannedDate ?? draft.scheduledDate,
          plannedTime: e.plannedTime ?? draft.scheduledTime,
          plannedAt: e.plannedAt ?? draft.plannedAt,
        };
      }
      if (e.boardId !== undefined) {
        patch.boardId = e.boardId || "";
        patch.boardName = e.boardName || "";
        if (md) md = { ...md, boardId: e.boardId || undefined, boardName: e.boardName || undefined };
      }
      if (e.products !== undefined && md) md = writePinProducts(md, e.products.primary, e.products.tagged);
      if (e.boardSuggestion !== undefined && md) md = { ...md, boardSuggestion: e.boardSuggestion };
      if (md && md !== draft.metadataDraft) patch.metadataDraft = md;
      if (Object.keys(patch).length) pinDraftStore.updateDraft(draftId, patch);
    }
    // Autosave: persist silently. The drawer owns per-action feedback and stays open.
  }

  // Batch Edit → Schedule / Reschedule selected. Smart-schedules unscheduled pins
  // (skips already-scheduled/posted). Selection preserved (drawer stays open).
  function handleWpScheduleSelected(pinIds: string[]) {
    const candidates = filterUnscheduledPinIds(pinIds);
    const ids = candidates.filter(id => !minimumPlanContentError(pinDraftStore.getDraft(id)));
    const blocked = candidates.length - ids.length;
    const already = pinIds.length - candidates.length;
    if (!ids.length) {
      toast.info(blocked ? `${blocked} Pin${blocked === 1 ? "" : "s"} need an image, title, or description before scheduling.` : `${already} Pin${already === 1 ? " is" : "s are"} already scheduled`);
      return;
    }
    const result = autoSchedulePins(ids, { skipAlreadyScheduled: true, skipPosted: true });
    if (result.scheduled === 0) {
      toast.error(result.toasts[0] ?? "Could not schedule selected Pins.");
      if (result.toasts[0]?.includes("Set up Smart Schedule")) setSmartScheduleOpen(true);
      return;
    }
    toast.success(`Scheduled ${result.scheduled} Pin${result.scheduled === 1 ? "" : "s"}${already ? ` · ${already} already scheduled` : ""}`);
  }

  // Shared "Generate missing details" for weekly-plan drafts.
  function handleWpGenerate(overwrite: boolean) {
    const lang = readResolvedContentLanguage();
    for (const id of batchDraftIds) {
      const d = pinDraftStore.getDraft(id);
      if (!d) continue;
      const md = generatePinMetadataDraft({
        keyword: d.keyword, category: d.category,
        setupSnapshot: d.setupSnapshot, promptSnapshot: d.promptSnapshot,
        opportunityTitle: d.opportunity, contentLanguage: lang,
      });
      const fields = applyDraftToPinFields(md);
      // Preserve any already-chosen real board.
      const mergedMd = { ...md, boardId: d.metadataDraft?.boardId ?? d.boardId, boardName: d.metadataDraft?.boardName ?? d.boardName };
      pinDraftStore.updateDraft(id, {
        title:          overwrite || !d.title ? fields.title : d.title,
        description:    overwrite || !d.description ? fields.description : d.description,
        altText:        overwrite || !d.altText ? fields.altText : d.altText,
        destinationUrl: overwrite || !d.destinationUrl ? fields.destinationUrl : d.destinationUrl,
        metadataDraft:  mergedMd,
      });
    }
    toast.success("Generated missing details");
  }

  function handleWpPublishComplete(publishedIds: string[]) {
    // Canonical posted state. Do NOT force-close the drawer/session — the drawer's own
    // publish-complete summary handles feedback, and Batch Edit stays open until closed.
    for (const id of publishedIds) pinDraftStore.markDraftPosted(id);
    // Outcome toast is owned by the Batch Edit drawer (partial-failure aware), so we
    // don't emit a second toast here — just sync canonical posted state.
  }

  function handleBulkMoveDate() {
    const date = moveDateValue.trim();
    if (!date) return;
    // Move = reschedule each selected Pin onto a real slot on the chosen day.
    const occupied = new Set<string>();
    for (const id of selectedIds) {
      const res = ensureScheduledPlanTime(id, { date, reschedule: true, extraOccupied: occupied, source: "manual" });
      if (res.ok) occupied.add(`${res.slot.plannedDate}|${res.slot.plannedTime}`);
    }
    setMoveDateOpen(false);
    setMoveDateValue("");
    toast.success(`Moved ${selectedIds.size} Pin${selectedIds.size === 1 ? "" : "s"} to ${date}`);
    setSelectedIds(new Set());
  }

  function handleBulkRemove() {
    for (const id of selectedIds) pinDraftStore.removeFromWeeklyPlan(id);
    toast.success(`Removed ${selectedIds.size} Pin${selectedIds.size === 1 ? "" : "s"} from plan`);
    setSelectedIds(new Set());
  }

  function handleBulkSmartSchedule() {
    const candidates = filterUnscheduledPinIds([...selectedIds]);
    const ids = candidates.filter(id => !minimumPlanContentError(pinDraftStore.getDraft(id)));
    if (!ids.length) {
      toast.info(candidates.length ? "Selected Pins need an image, title, or description before scheduling." : "No unscheduled Pins selected — already scheduled Pins are skipped.");
      return;
    }
    const result = autoSchedulePins(ids, { skipAlreadyScheduled: true, skipPosted: true });
    if (result.scheduled === 0) {
      toast.error(result.toasts[0] ?? "Could not schedule selected Pins.");
      if (result.toasts[0]?.includes("Set up Smart Schedule")) setSmartScheduleOpen(true);
      return;
    }
    toast.success(result.toasts[result.toasts.length - 1] ?? `Scheduled ${result.scheduled} Pin${result.scheduled === 1 ? "" : "s"}.`);
    setSelectedIds(new Set());
  }

  const displayWeekStart = computeWeekStartISO(weekOffset);
  const monthAnchorISO   = computeMonthAnchorISO(monthOffset);

  const monthLabel = new Date(`${monthAnchorISO}T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const displayWeekLabel = formatWeekLabel(displayWeekStart);

  // Restore the user's explicit Week/Month choice (once, client-side). With no
  // saved preference the Plan defaults to Weekly view; Month stays available via
  // the toggle. We intentionally do NOT auto-switch to Month based on where pins
  // are scheduled — the default view is Weekly.
  useEffect(() => {
    if (scopeInitRef.current) return;
    scopeInitRef.current = true;
    const stored = readStoredCalendarScope();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setCalendarScope(stored);
  }, []);

  const { items, isPlanReady, dataLoading: planDataLoading, loadError: planLoadError, userId: planUserId } = useWeeklyPlan(category);
  const briefs = items.map(enrichItem);

  // Stuck/error fallback: if the plan/items/session-user waterfall hasn't
  // settled within a generous window, or a real fetch error came back, show a
  // Retry option instead of leaving the page looking permanently loading.
  const [planLoadTimedOut, setPlanLoadTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setPlanLoadTimedOut(true), 12000);
    return () => clearTimeout(timer);
  }, []);
  const showPlanLoadRetry = !!planLoadError || (planLoadTimedOut && planDataLoading);

  // Group by day slot
  const slots: PinBrief[][] = Array.from({ length: 7 }, () => []);
  for (const brief of briefs) { slots[brief.sort_order % 7].push(brief); }

  function dayDateLabel(dayIdx: number): { dayLabel: string; dateStr: string } {
    const d = new Date(displayWeekStart + "T00:00:00");
    d.setDate(d.getDate() + dayIdx);
    return {
      dayLabel: DAY_SHORT[dayIdx],
      dateStr:  d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    };
  }

  // Flat export list
  const exportBriefs: { brief: PinBrief; dateLabel: string }[] = slots.flatMap((dayBriefs, i) => {
    const { dayLabel, dateStr } = dayDateLabel(i);
    return dayBriefs.map(b => ({ brief: b, dateLabel: `${dayLabel} ${dateStr}` }));
  });

  const itemsSummaryKey = `${category}|${displayWeekStart}|${items.length}`;
  useEffect(() => {
    function refreshStats() {
      setPlanStats(computeWeeklyPlanStats(category, displayWeekStart));
    }
    refreshStats();
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, refreshStats);
    window.addEventListener("vp:pin_store_updated", refreshStats);
    return () => {
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, refreshStats);
      window.removeEventListener("vp:pin_store_updated", refreshStats);
    };
  }, [itemsSummaryKey, category, displayWeekStart]);

  // ── Dev-only Plan identity diagnostics (Issue B) ──────────────────────────────
  // Makes the "same account, different browser/incognito shows different Plan"
  // mismatch visible. Core finding: the keyword plan SLOTS come from Supabase
  // (weekly_plans / weekly_plan_items, keyed by user_id — persists everywhere),
  // but the scheduled Pin CARDS + images come from pinDraftStore (localStorage
  // vp:pin_drafts:v1), which is NOT synced — so a fresh browser/incognito shows an
  // empty calendar for the same account. Logs only ids already present client-side
  // plus counts — never tokens/secrets. Dev-only.
  const planDiagRef = useRef<string>("");
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (planDataLoading) return; // wait until the DB plan/items waterfall settles
    const key = `${planUserId ?? "anon"}|${displayWeekStart}|${items.length}`;
    if (planDiagRef.current === key) return; // log once per settled identity
    planDiagRef.current = key;
    const localAll = pinDraftStore.getAllDrafts();
    const localScheduled = localAll.filter(d => !!sanitizeHandoffField(d.scheduledDate));
    console.log("[Plan identity]", {
      userId: planUserId ?? "(not signed in)",
      workspace: "n/a — plan data is keyed by user_id only (no workspace partition)",
      weekStart: displayWeekStart,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffsetMin: new Date().getTimezoneOffset(),
      dbWeeklyPlanItems: items.length, // Supabase weekly_plan_items (keyword slots)
      localScheduledPinDrafts: localScheduled.length, // pinDraftStore (localStorage) — the actual cards/images
      localPinDraftsTotal: localAll.length,
      scheduledPinDraftsWithImage: localScheduled.filter(d => !!d.imageUrl).length,
      sources: {
        keywordSlots: "Supabase weekly_plans/weekly_plan_items (persists across browsers)",
        pinCardsAndImages: "localStorage vp:pin_drafts:v1 (NOT synced — empty in a fresh browser/incognito)",
      },
    });
    console.table(localScheduled.map(d => ({
      draftId: d.id,
      scheduledAt: `${d.scheduledDate ?? ""} ${d.scheduledTime ?? ""}`.trim(),
      primaryProductId: d.primaryProductId ?? "",
      boardId: d.boardId ?? "",
      imageUrlPresent: !!d.imageUrl,
      imageUrlKind: !d.imageUrl ? "none" : d.imageUrl.startsWith("data:") ? "data-url (local only)" : "url",
      posted: !!d.postedAt,
      source: "localStorage",
    })));
  }, [planDataLoading, planUserId, displayWeekStart, items.length]);

  const scheduledDrafts = scheduledDraftsInWeek(category, displayWeekStart);
  const monthDrafts     = scheduledDraftsInMonth(category, monthAnchorISO);
  const dayDetailDrafts  = dayDetailISO ? monthDrafts.filter(d => d.scheduledDate === dayDetailISO) : [];
  const hasItems     = items.length > 0 || scheduledDrafts.length > 0;
  const fileName     = `pin-brief-${displayWeekLabel.replace(/\s+/g, "-").toLowerCase()}.csv`;

  const selectedDrafts = [...selectedIds].map(id => pinDraftStore.getDraft(id)).filter((d): d is PinDraft => !!d);
  const canPublishSelected = selectedDrafts.length > 0;

  return (
    <div data-testid="weekly-plan-page" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>

      {/* ── Header ── */}
      <div style={{ background: "var(--app-surface)", flexShrink: 0 }}>

        {/* Primary row: title + nav + actions */}
        <div style={{ padding: "8px 20px 6px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          {/* Left: title + week label + neutral workspace context (no category switcher) */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 style={{ margin: 0, fontSize: "14px", fontWeight: 800, color: "var(--app-text)" }}>{tr("page.plan.title")}</h1>
              <span data-testid="weekly-plan-workspace" title="Single publishing calendar for this workspace"
                style={{ fontSize: 10, fontWeight: 600, color: "var(--app-text-muted)", border: "1px solid var(--app-border)", borderRadius: 20, padding: "1px 8px", whiteSpace: "nowrap" }}>
                Default workspace
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <p style={{ margin: 0, fontSize: "12px", color: "var(--app-text-sec)" }}>{hydrated ? (calendarScope === "month" ? monthLabel : displayWeekLabel) : tr("page.plan.loading")}</p>
              {!isAllCategories && (
                <button type="button" data-testid="weekly-plan-active-filter" onClick={() => setCategory(ALL_CATEGORIES)}
                  title="Filtering by category — click to show all"
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 8px", borderRadius: 20, fontSize: 10.5, fontWeight: 700, border: "1px solid rgba(192,38,211,0.45)", background: "rgba(192,38,211,0.08)", color: "#C026D3", cursor: "pointer" }}>
                  {catDef?.emoji} {catLabel} ✕
                </button>
              )}
            </div>
          </div>

          {/* Right: week nav + actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, flexWrap: "wrap" }}>
            <button type="button" data-testid="week-nav-today" onClick={() => { setWeekOffset(0); setMonthOffset(0); }}
              style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, border: "1px solid var(--app-border)", background: (calendarScope === "month" ? monthOffset : weekOffset) === 0 ? "var(--app-inset-hi)" : "transparent", color: "var(--app-text-sec)", cursor: "pointer", whiteSpace: "nowrap" }}>
              Today
            </button>
            <button type="button" data-testid="week-nav-prev" onClick={() => calendarScope === "month" ? setMonthOffset(o => o - 1) : setWeekOffset(o => o - 1)}
              style={{ padding: "3px 8px", borderRadius: 6, fontSize: 13, border: "1px solid var(--app-border)", background: "transparent", color: "var(--app-text-sec)", cursor: "pointer", lineHeight: 1 }}>
              ‹
            </button>
            <button type="button" data-testid="week-nav-next" onClick={() => calendarScope === "month" ? setMonthOffset(o => o + 1) : setWeekOffset(o => o + 1)}
              style={{ padding: "3px 8px", borderRadius: 6, fontSize: 13, border: "1px solid var(--app-border)", background: "transparent", color: "var(--app-text-sec)", cursor: "pointer", lineHeight: 1 }}>
              ›
            </button>
            <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600, border: "1px solid var(--app-border)", color: "var(--app-text-sec)", whiteSpace: "nowrap" }}>
              {hydrated ? (calendarScope === "month" ? monthLabel : formatWeekRange(displayWeekStart)) : "—"}
            </span>
            {isPlanReady && hasItems && (
              <button type="button"
                onClick={() => exportCSV(exportBriefs, fileName)}
                style={{ padding: "3px 10px", fontSize: "11px", fontWeight: 600, borderRadius: "6px", border: "1px solid var(--app-border)", background: "transparent", color: "var(--app-text-sec)", cursor: "pointer", whiteSpace: "nowrap" }}>
                ↓ Export CSV
              </button>
            )}
            <button type="button" data-testid="smart-schedule-btn" onClick={() => setSmartScheduleOpen(true)}
              style={{ padding: "3px 10px", fontSize: "11px", fontWeight: 700, borderRadius: "7px", cursor: "pointer", whiteSpace: "nowrap",
                border: "1px solid rgba(99,102,241,0.45)", background: "rgba(99,102,241,0.08)", color: "#6366F1" }}>
              Smart Schedule
            </button>
            <button type="button" data-testid="weekly-plan-edit-toggle" onClick={toggleEditMode}
              style={{ padding: "3px 10px", fontSize: "11px", fontWeight: 700, borderRadius: "7px", cursor: "pointer", whiteSpace: "nowrap",
                border: `1.5px solid rgba(192,38,211,0.6)`, background: editMode ? "rgba(192,38,211,0.12)" : "transparent", color: "#C026D3" }}>
              {editMode ? "✓ Done" : "✏️ Edit Plan"}
            </button>
            {!isAllCategories && (
              <Link href={`/app/workspace/${category}`} title="Edit keyword plan"
                style={{ padding: "3px 10px", fontSize: "11px", fontWeight: 600, borderRadius: "7px", border: "1px solid var(--app-border)", color: "var(--app-text-sec)", textDecoration: "none", whiteSpace: "nowrap" }}>
                Keyword plan
              </Link>
            )}
            <Link href="/app/studio" data-testid="create-pin-btn"
              style={{ padding: "3px 12px", fontSize: "11px", fontWeight: 700, borderRadius: "7px", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", textDecoration: "none", whiteSpace: "nowrap" }}>
              ✦ Create Pin
            </Link>
          </div>
        </div>

        {/* Compact summary bar */}
        <CompactSummaryBar stats={planStats} />

        {/* View mode + calendar controls */}
        <div style={{ padding: "4px 20px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: "var(--app-inset)", borderRadius: "8px", padding: "3px", gap: "2px", flexShrink: 0 }}>
            {(["calendar", "list"] as const).map(mode => (
              <button key={mode} type="button"
                data-testid={`view-mode-${mode}`}
                onClick={() => setViewMode(mode)}
                style={{
                  padding: "4px 11px", fontSize: "11px", fontWeight: 600, borderRadius: "6px", border: "none", cursor: "pointer",
                  background: viewMode === mode ? "var(--app-surface)" : "transparent",
                  color:      viewMode === mode ? "var(--app-text)" : "var(--app-text-sec)",
                  boxShadow:  viewMode === mode ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}>
                {mode === "calendar" ? "Calendar" : "List"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {/* Week / Month toggle is Calendar-only. */}
            {viewMode === "calendar" && (
            <div style={{ display: "flex", background: "var(--app-inset)", borderRadius: "8px", padding: "3px", gap: "2px" }}>
              {(["week", "month"] as const).map(scope => (
                <button key={scope} type="button" data-testid={`calendar-scope-${scope}`} onClick={() => { setCalendarScope(scope); persistCalendarScope(scope); }}
                  style={{
                    padding: "4px 10px", fontSize: "11px", fontWeight: 600, borderRadius: "6px", border: "none", cursor: "pointer",
                    textTransform: "capitalize",
                    background: calendarScope === scope ? "var(--app-surface)" : "transparent",
                    color:      calendarScope === scope ? "var(--app-text)" : "var(--app-text-sec)",
                    boxShadow:  calendarScope === scope ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  }}>
                  {scope}
                </button>
              ))}
            </div>
            )}
            {/* Month view: collapsed Unscheduled panel → opens as a drawer. */}
            {viewMode === "calendar" && hydrated && calendarScope === "month" && wideLayout && (
              <button type="button" data-testid="month-unscheduled-toggle" onClick={() => setMonthUnscheduledOpen(true)}
                style={{ padding: "5px 12px", fontSize: "11px", fontWeight: 700, borderRadius: 7,
                  border: "1px solid rgba(99,102,241,0.45)", background: "rgba(99,102,241,0.08)", color: "#6366F1", cursor: "pointer", whiteSpace: "nowrap" }}>
                Unscheduled ({planStats.unscheduledGenerated})
              </button>
            )}
            <div style={{ position: "relative" }}>
              <button type="button" data-testid="weekly-plan-filters-btn" onClick={() => setFiltersOpen(o => !o)}
                style={{ padding: "5px 12px", fontSize: "11px", fontWeight: 600, borderRadius: 7,
                  border: `1px solid ${isAllCategories ? "var(--app-border)" : "rgba(192,38,211,0.45)"}`,
                  background: isAllCategories ? "transparent" : "rgba(192,38,211,0.08)",
                  color: isAllCategories ? "var(--app-text-sec)" : "#C026D3", cursor: "pointer" }}>
                ⚙ Filters{!isAllCategories ? " · 1" : ""}
              </button>
              {filtersOpen && (
                <>
                  <div onClick={() => setFiltersOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                  <div data-testid="weekly-plan-filters-panel" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 41, width: 230, background: "var(--app-surface)", border: "1px solid var(--app-border)", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.4)", padding: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: "var(--app-text)" }}>Filters</span>
                      {!isAllCategories && (
                        <button type="button" data-testid="weekly-plan-filters-clear" onClick={() => setCategory(ALL_CATEGORIES)}
                          style={{ background: "none", border: "none", padding: 0, fontSize: 10.5, fontWeight: 700, color: "#C026D3", cursor: "pointer" }}>
                          Clear
                        </button>
                      )}
                    </div>
                    <label style={{ display: "block", fontSize: 9.5, fontWeight: 700, color: "var(--app-text-sec)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Category</label>
                    <select data-testid="weekly-plan-filter-category" value={category} onChange={e => setCategory(e.target.value)}
                      style={{ width: "100%", boxSizing: "border-box", padding: "7px 9px", borderRadius: 8, fontSize: 12, border: "1px solid var(--app-border)", background: "var(--app-surface-2)", color: "var(--app-text)", cursor: "pointer", outline: "none" }}>
                      <option value={ALL_CATEGORIES}>All categories</option>
                      {ACTIVE_CATEGORIES.map(c => (
                        <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>
                      ))}
                    </select>
                    <p style={{ margin: "8px 0 0", fontSize: 9.5, color: "var(--app-text-muted)", lineHeight: 1.5 }}>
                      Boards, status, and opportunity filters coming soon. Category is optional — Pins of any category plan in the same calendar.
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px" }}>
        {/* Post-OAuth modal restore: shown when pinId was in URL but draft not found */}
        {restoreNotice && (
          <div data-testid="wp-restore-not-found" style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(217,119,6,0.35)", background: "rgba(217,119,6,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#D97706" }}>{restoreNotice}</p>
            <button type="button" onClick={dismissRestoreNotice} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "#D97706", padding: 0, lineHeight: 1 }}>✕</button>
          </div>
        )}
        {/* Plan data load stuck/error fallback — independent of the hydration skeleton
            below (which is purely a client-render-timing gate, not data-dependent).
            Shown above the calendar so the shell stays usable either way. */}
        {hydrated && showPlanLoadRetry && (
          <div data-testid="weekly-plan-load-retry" style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#EF4444" }}>Could not load your plan.</p>
            <button type="button" onClick={() => window.location.reload()}
              style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid rgba(239,68,68,0.35)", background: "var(--app-surface)", color: "#EF4444", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              Retry
            </button>
          </div>
        )}
        {!hydrated ? (
          // Deterministic skeleton — identical on the server and the first client render.
          // Mirrors the 7-column week grid so content fills in with no layout flash.
          <div data-testid="weekly-plan-skeleton" aria-hidden="true" style={{ maxWidth: "980px", margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }}>
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} style={{ borderRadius: 10, border: "1px solid var(--app-border)", background: "var(--app-surface)", minHeight: 240, opacity: 0.5 }} />
            ))}
          </div>
        ) : viewMode === "list" ? (
          // List view — compact publishing management table (Calendar | List IA).
          <PlanListView
            category={category}
            handlers={{
              onOpenDetails: setCalendarEditDraft,
              onReschedule:  setCalendarEditDraft,
              onPublish:     setCalendarEditDraft,
              onBatchEdit:   (ids) => openBatchEditFor(ids),
            }}
          />
        ) : (
          // Wide: calendar (main column) + sticky Unscheduled Pins rail.
          // Narrow: single column with the stacked Unscheduled section as a fallback.
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {!hasItems && (
                <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, border: "1px solid var(--app-border)", background: "var(--app-surface)" }}>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--app-text-sec)" }}>
                    {isAllCategories ? (
                      <>Nothing scheduled this week yet. Add Pins from the unscheduled list{wideLayout ? " on the right" : " below"}, or{" "}
                        <Link href="/app/studio" style={{ color: "#C026D3", fontWeight: 700 }}>create new Pins →</Link></>
                    ) : (
                      <>No keyword plan for <strong>{catLabel}</strong> this week yet. Add Pins from the unscheduled list, or{" "}
                        <Link href={`/app/workspace/${category}`} style={{ color: "#C026D3", fontWeight: 700 }}>build a keyword plan →</Link></>
                    )}
                  </p>
                </div>
              )}

              {calendarScope === "week" ? (
                <WeekCalendar
                  weekStart={displayWeekStart}
                  slots={slots}
                  scheduledDrafts={scheduledDrafts}
                  dnd={dnd}
                  onEdit={setCalendarEditDraft}
                  select={select}
                  hoverActions={scheduledHoverActions}
                />
              ) : (
                <MonthCalendar
                  monthAnchorISO={monthAnchorISO}
                  scheduledDrafts={monthDrafts}
                  dnd={dnd}
                  onOpenDay={setDayDetailISO}
                  select={select}
                  hoverActions={scheduledHoverActions}
                />
              )}

              <p style={{ textAlign: "center", fontSize: "11px", color: "var(--app-text-muted)", marginTop: "20px", paddingBottom: "10px" }}>
                🕐 All times are in your local time zone · Schedule uses Smart Schedule · drag Pins to reschedule manually
              </p>
              <AddedNeedsDateSection category={category} weekStart={displayWeekStart} dnd={dnd} hoverActions={scheduledHoverActions} />
              {/* Narrow fallback — stacked Unscheduled section (rail not shown). */}
              {!wideLayout && <UnscheduledDraftsSection category={category} dnd={dnd} hoverActions={unscheduledHoverActions} onAddToPlan={handleSmartScheduleAdd} />}
            </div>

            {/* Week view keeps the inline rail. Month view hides it for calendar
                readability — opened on demand via the "Unscheduled (N)" toggle. */}
            {wideLayout && calendarScope === "week" && (
              <UnscheduledRail category={category} dnd={dnd} select={select} onEditDraft={setCalendarEditDraft} hoverActions={unscheduledHoverActions} onAddToPlan={handleSmartScheduleAdd} />
            )}
          </div>
        )}
      </div>

      <SmartScheduleDrawer open={smartScheduleOpen} onClose={() => setSmartScheduleOpen(false)} />

      {/* Month view — Day Detail panel (opens on day-cell click). */}
      <DayDetailDrawer
        select={select}
        dateISO={dayDetailISO}
        drafts={dayDetailDrafts}
        onClose={() => setDayDetailISO(null)}
        onEditDetails={(d) => { setDayDetailISO(null); setCalendarEditDraft(d); }}
        onReschedule={(d) => { setDayDetailISO(null); setCalendarEditDraft(d); }}
      />

      {/* Month view — collapsed Unscheduled panel opened as a right drawer. */}
      {monthUnscheduledOpen && (
        <div onClick={() => setMonthUnscheduledOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 71, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "flex-end" }}>
          <div data-testid="month-unscheduled-drawer" onClick={e => e.stopPropagation()}
            style={{ height: "100%", padding: 14, overflowY: "auto", background: "var(--app-surface)", borderLeft: "1px solid var(--app-border)", boxShadow: "-12px 0 40px rgba(0,0,0,0.35)" }}>
            <UnscheduledRail category={category} dnd={dnd} select={select} onEditDraft={setCalendarEditDraft} hoverActions={unscheduledHoverActions} onAddToPlan={handleSmartScheduleAdd} />
          </div>
        </div>
      )}
      <DraftDetailsDrawer
        draft={calendarEditDraft}
        open={calendarEditDraft !== null}
        onClose={() => setCalendarEditDraft(null)}
        onSaved={() => { /* keep modal open after Save/Publish; Weekly Plan refreshes via DRAFT_STORE_EVENT */ }}
        oauthReturnContext={{
          viewMode,
          calendarScope,
          weekStart: displayWeekStart,
          month: monthAnchorISO,
          category,
        }}
      />

      {/* Edit Plan selection action bar — visible whenever Edit Plan is on. */}
      {(editMode || selectedIds.size > 0) && (
        <div data-testid="weekly-plan-selection-bar" style={{
          position: "fixed", left: "50%", bottom: 20, transform: "translateX(-50%)", zIndex: 60,
          display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 14, maxWidth: "94vw", flexWrap: "wrap", justifyContent: "center",
          background: "var(--app-surface)", border: "1px solid var(--app-border)", boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
        }}>
          {selectedIds.size === 0 ? (
            <span data-testid="wp-selection-hint" style={{ fontSize: 12, fontWeight: 600, color: "var(--app-text-sec)", padding: "2px 4px" }}>
              Select Pins to perform actions.
            </span>
          ) : (
            <>
              {/* Quiet count — just the number, no verbose action-count labels */}
              <span data-testid="wp-selected-count" style={{ fontSize: 12, fontWeight: 700, color: "var(--app-text-sec)", paddingRight: 4 }}>
                {selectedIds.size} selected
              </span>
              {/* Primary: Batch edit opens the shared Batch Edit workspace with selected IDs */}
              <button type="button" data-testid="wp-batch-edit" onClick={() => openBatchEditFor([...selectedIds])}
                style={{ padding: "7px 14px", borderRadius: 9, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                Batch edit
              </button>
              {/* Secondary: Schedule (Smart Schedule next available slot) */}
              <button type="button" data-testid="wp-schedule-selected" onClick={handleBulkSmartSchedule}
                style={{ padding: "7px 14px", borderRadius: 9, border: "1px solid var(--app-border)", background: "var(--app-surface-2)", color: "var(--app-text)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                Schedule
              </button>
              {/* Secondary: Publish now. The drawer validates image/account/board at action time. */}
              <button type="button" data-testid="wp-publish-selected" onClick={() => openBatchEditFor([...selectedIds])}
                disabled={!canPublishSelected}
                title={canPublishSelected ? "Publish the selected Pins" : "Select at least one Pin to publish"}
                style={{ padding: "7px 14px", borderRadius: 9, border: "1px solid var(--app-border)", background: "var(--app-surface-2)",
                  color: canPublishSelected ? "var(--app-text)" : "var(--app-text-muted)", fontSize: 12, fontWeight: 700,
                  cursor: canPublishSelected ? "pointer" : "not-allowed", opacity: canPublishSelected ? 1 : 0.5 }}>
                Publish now
              </button>
              <button type="button" onClick={() => { setMoveDateValue(""); setMoveDateOpen(true); }}
                style={{ padding: "7px 12px", borderRadius: 9, border: "1px solid var(--app-border)", background: "var(--app-surface-2)", color: "var(--app-text-sec)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Move date
              </button>
              <button type="button" onClick={handleBulkRemove}
                style={{ padding: "7px 12px", borderRadius: 9, border: "1px solid var(--app-border)", background: "var(--app-surface-2)", color: "var(--app-text-sec)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Remove from plan
              </button>
              <button type="button" data-testid="wp-clear-selection" onClick={() => setSelectedIds(new Set())}
                style={{ padding: "7px 10px", borderRadius: 9, border: "none", background: "none", color: "var(--app-text-muted)", fontSize: 12, cursor: "pointer" }}>
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* Move date modal */}
      {moveDateOpen && (
        <div onClick={() => setMoveDateOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--app-surface)", border: "1px solid var(--app-border)", borderRadius: 14, padding: "20px 22px", width: 320, maxWidth: "90vw" }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 800, color: "var(--app-text)" }}>Move {selectedIds.size} Pin{selectedIds.size === 1 ? "" : "s"} to…</h3>
            <input type="date" value={moveDateValue} onChange={e => setMoveDateValue(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 8, border: "1px solid var(--app-border)", background: "var(--app-surface-2)", color: "var(--app-text)", fontSize: 12, outline: "none", colorScheme: "dark" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setMoveDateOpen(false)} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--app-border)", background: "var(--app-surface-2)", color: "var(--app-text-sec)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button type="button" onClick={handleBulkMoveDate} disabled={!moveDateValue}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: moveDateValue ? "linear-gradient(135deg,#FF4D8D,#7C3AED)" : "var(--app-surface-2)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: moveDateValue ? "pointer" : "not-allowed", opacity: moveDateValue ? 1 : 0.6 }}>Move</button>
            </div>
          </div>
        </div>
      )}

      {/* Shared Batch Edit (same component as Create Pins History) */}
      <BatchEditDrawer
        open={batchOpen}
        pins={batchPins}
        source="weekly_plan"
        onClose={() => setBatchOpen(false)}
        onApply={handleWpBatchApply}
        onGenerateMetadata={handleWpGenerate}
        onScheduleSelected={handleWpScheduleSelected}
        onPublishComplete={handleWpPublishComplete}
      />
    </div>
  );
}

// ── Added to plan, needs date ─────────────────────────────────────────────────

function AddedNeedsDateSection({ category, weekStart, dnd, hoverActions }: { category: string; weekStart: string; dnd: PlanDnD; hoverActions?: PinHoverPreviewActions }) {
  const [drafts, setDrafts] = useState<PinDraft[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editDraft, setEditDraft] = useState<PinDraft | null>(null);

  useEffect(() => {
    function load() { setDrafts(getAddedNeedsDateDrafts(category, weekStart)); }
    load();
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
    window.addEventListener("vp:pin_store_updated", load);
    return () => {
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
      window.removeEventListener("vp:pin_store_updated", load);
    };
  }, [category, weekStart]);

  function handleAssignDate(draftId: string, date: string) {
    if (!date) return;
    // Assign onto a real Smart Schedule slot on the chosen day (never time-less).
    // User explicitly chose the day → treat as a manual pin (skipped by rebalance).
    ensureScheduledPlanTime(draftId, { date, reschedule: true, source: "manual" });
    setEditingId(null);
    setEditDate("");
  }

  if (drafts.length === 0) return null;

  const st = addedNeedsDateLabel();
  const cardHoverActions: PinHoverPreviewActions = hoverActions
    ? {
        ...hoverActions,
        onEditDetails: (d) => setEditDraft(d),
        onReschedule: (d) => { setEditingId(d.id); setEditDate(plannableDateISO(1)); },
      }
    : { variant: "scheduled", onEditDetails: (d) => setEditDraft(d) };

  return (
    <div data-testid="added-needs-date-section" style={{ maxWidth: "980px", margin: "16px auto 0", borderRadius: 14, background: "var(--app-surface)", border: "1px solid rgba(217,119,6,0.25)", overflow: "hidden" }}>
      <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--app-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--app-text-sec)" }}>Added to plan · assign a date</span>
          <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "rgba(217,119,6,0.12)", color: "#D97706" }}>
            {drafts.length}
          </span>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--app-text-muted)" }}>
          These pins are in your plan but not on the calendar yet. Assign a date to place them on a day above.
        </p>
      </div>
      <div style={{ padding: "14px 18px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
          {drafts.map(draft => {
            const isEditing = editingId === draft.id;
            return (
              <div key={draft.id} data-testid="added-needs-date-card"
                draggable={!isEditing}
                onDragStart={e => dnd.onPinDragStart(e, draft.id)}
                onDragEnd={dnd.onPinDragEnd}
                style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--app-border)", background: "var(--app-surface-2)", display: "flex", flexDirection: "column", cursor: isEditing ? "default" : "grab", opacity: dnd.draggingId === draft.id ? 0.4 : 1 }}>
                <PinHoverTarget
                  draft={draft}
                  actions={cardHoverActions}
                  disabled={isEditing || !hoverActions}
                  style={{ position: "relative", aspectRatio: "2/3", background: "var(--app-surface-3, #0f172a)", overflow: "hidden", display: "block" }}
                >
                  <PinThumbnail src={toProxyUrl(draft.imageUrl)} loading="lazy" />
                  <span style={{ position: "absolute", bottom: 5, left: 5, right: 5, textAlign: "center", fontSize: "8px", fontWeight: 700, padding: "2px 6px", borderRadius: 8, background: `${st.color}dd`, color: "#fff" }}>
                    {st.label}
                  </span>
                </PinHoverTarget>
                <div style={{ padding: "8px 9px 4px" }}>
                  <p style={{ margin: 0, fontSize: "11px", fontWeight: 700, color: "var(--app-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {displayTitle(draft.title, draft.keyword)}
                  </p>
                </div>
                {isEditing ? (
                  <div style={{ padding: "6px 9px 8px", display: "flex", flexDirection: "column", gap: 5 }}>
                    <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                      style={{ padding: "4px 7px", borderRadius: 7, border: "1px solid #C4B5FD", fontSize: "11px", outline: "none", color: "var(--app-text-sec)", background: "var(--app-surface)", width: "100%", boxSizing: "border-box" }} />
                    <div style={{ display: "flex", gap: 4 }}>
                      <button type="button" data-testid="added-needs-date-confirm" onClick={() => handleAssignDate(draft.id, editDate)}
                        style={{ flex: 1, padding: "4px 0", borderRadius: 7, border: "none", background: "#7C3AED", color: "#fff", fontSize: "10px", fontWeight: 700, cursor: "pointer" }}>
                        Assign date
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}
                        style={{ padding: "4px 8px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-muted)", fontSize: "10px", cursor: "pointer" }}>
                        ✕
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: "4px 9px 8px", display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <button type="button" data-testid="needs-date-assign-btn"
                      onClick={() => { setEditingId(draft.id); setEditDate(plannableDateISO(1)); }}
                      style={{ flex: "1 1 auto", padding: "4px 6px", borderRadius: 7, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: "9px", fontWeight: 700, cursor: "pointer" }}>
                      Assign date
                    </button>
                    <button type="button" data-testid="needs-date-edit-details-btn" onClick={() => setEditDraft(draft)}
                      style={{ flex: "0 0 auto", padding: "4px 6px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-sec)", fontSize: "9px", fontWeight: 600, cursor: "pointer" }}>
                      Edit details
                    </button>
                    <button type="button" onClick={() => pinDraftStore.removeFromWeeklyPlan(draft.id)}
                      style={{ flex: "0 0 auto", padding: "4px 6px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-muted)", fontSize: "9px", cursor: "pointer" }}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <DraftDetailsDrawer
        draft={editDraft}
        open={editDraft !== null}
        onClose={() => setEditDraft(null)}
        onSaved={() => setDrafts(getAddedNeedsDateDrafts(category, weekStart))}
      />
    </div>
  );
}

// ── Unscheduled drafts section ────────────────────────────────────────────────
// Shows pin drafts added from Generated Pins that don't match any plan row keyword.
// Masonry grid layout — each card is independently editable.

function UnscheduledDraftsSection({ category, dnd, hoverActions, onAddToPlan }: {
  category: string; dnd: PlanDnD; hoverActions?: PinHoverPreviewActions; onAddToPlan: (id: string) => void;
}) {
  const [drafts,    setDrafts]    = useState<PinDraft[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [editDraft, setEditDraft] = useState<PinDraft | null>(null);
  const dropKey  = "unscheduled-zone";
  const isOver   = dnd.dragOverKey === dropKey;

  useEffect(() => {
    // "all" → no category filter (undefined) so every workspace draft shows.
    const catArg = category === ALL_CATEGORIES ? undefined : category;
    function load() { setDrafts(pinDraftStore.getUnaddedGeneratedDrafts(catArg)); }
    load();
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
    window.addEventListener("vp:pin_store_updated",          load);
    return () => {
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
      window.removeEventListener("vp:pin_store_updated",          load);
    };
  }, [category]);

  function handleAddToPlan(draftId: string) {
    onAddToPlan(draftId);
  }

  // Schedule-first: Smart Schedule picks the slot. No manual date entry here.
  const cardHoverActions: PinHoverPreviewActions = hoverActions
    ? {
        ...hoverActions,
        onEditDetails: (d) => setEditDraft(d),
        onAddToPlan: handleAddToPlan,
      }
    : {
        variant: "unscheduled",
        onEditDetails: (d) => setEditDraft(d),
        onAddToPlan: handleAddToPlan,
      };

  // Keep the section mounted while dragging so it can act as an "unschedule" drop zone.
  if (drafts.length === 0 && !dnd.draggingId) return null;

  return (
    <div data-testid="unscheduled-generated-section"
      onDragOver={e => { if (dnd.draggingId) { e.preventDefault(); dnd.setDragOverKey(dropKey); } }}
      onDragLeave={() => { if (dnd.dragOverKey === dropKey) dnd.setDragOverKey(null); }}
      onDrop={e => { e.preventDefault(); const id = readDragId(e); if (id) dnd.unschedule(id); }}
      style={{ maxWidth: "980px", margin: "16px auto 0", borderRadius: 14, background: "var(--app-surface)", border: `1px solid ${isOver ? "rgba(192,38,211,0.55)" : "var(--app-border)"}`, boxShadow: isOver ? "0 0 0 2px rgba(192,38,211,0.18)" : "none", overflow: "hidden", transition: "border-color 0.1s, box-shadow 0.1s" }}>
      <div onClick={() => setCollapsed(c => !c)}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", cursor: "pointer", borderBottom: collapsed ? "none" : "1px solid var(--app-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--app-text-sec)" }}>Generated Pins · Not added to plan</span>
          <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "rgba(192,38,211,0.08)", color: "#C026D3" }}>
            {drafts.length}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link href="/app/history" style={{ fontSize: "11px", fontWeight: 600, color: "#C026D3", textDecoration: "none" }}
            onClick={e => e.stopPropagation()}>
            View all in History →
          </Link>
          <span style={{ fontSize: "12px", color: "var(--app-text-muted)" }}>{collapsed ? "▶" : "▼"}</span>
        </div>
      </div>

      {dnd.draggingId && (
        <div style={{ padding: "8px 18px", borderBottom: "1px solid var(--app-border)", textAlign: "center", fontSize: 11, fontWeight: 700, color: isOver ? "#C026D3" : "var(--app-text-muted)" }}>
          Drop here to remove from plan
        </div>
      )}

      {!collapsed && drafts.length > 0 && (
        <div style={{ padding: "14px 18px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
            {drafts.map(draft => {
              const st = unaddedStatusLabel();

              return (
                <div key={draft.id} data-testid="unscheduled-pin-card"
                  draggable
                  onDragStart={e => dnd.onPinDragStart(e, draft.id)}
                  onDragEnd={dnd.onPinDragEnd}
                  style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--app-border)", background: "var(--app-surface-2)", display: "flex", flexDirection: "column", cursor: "grab", opacity: dnd.draggingId === draft.id ? 0.4 : 1 }}>
                  <PinHoverTarget
                    draft={draft}
                    actions={cardHoverActions}
                    disabled={!hoverActions}
                    style={{ position: "relative", aspectRatio: "2/3", background: "var(--app-surface-3, #0f172a)", overflow: "hidden", display: "block" }}
                  >
                    <PinThumbnail src={toProxyUrl(draft.imageUrl)} loading="lazy" />
                    <span data-testid="unscheduled-status-badge" style={{
                      position: "absolute", bottom: 5, left: 5, right: 5, textAlign: "center",
                      fontSize: "8px", fontWeight: 700, padding: "2px 6px", borderRadius: 8,
                      background: `${st.color}dd`, color: "#fff",
                    }}>
                      {st.label}
                    </span>
                  </PinHoverTarget>

                  <div style={{ padding: "8px 9px 4px", flex: 1 }}>
                    <p style={{ margin: "0 0 3px", fontSize: "11px", fontWeight: 700, color: "var(--app-text)", textTransform: "capitalize", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {displayTitle(draft.title, draft.keyword)}
                    </p>
                  </div>

                  <div style={{ padding: "4px 9px 8px", display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <button type="button" data-testid="unscheduled-add-to-plan" data-testid2="weekly-plan-unscheduled-schedule" onClick={() => handleAddToPlan(draft.id)}
                      title="Schedule into the next available Smart Schedule slot"
                      style={{ flex: "1 1 auto", padding: "4px 6px", borderRadius: 7, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: "9px", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                      Schedule
                    </button>
                    <button type="button" data-testid="unscheduled-edit-details" data-testid2="weekly-plan-unscheduled-edit-details" onClick={() => setEditDraft(draft)}
                      style={{ flex: "1 1 auto", padding: "4px 6px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-sec)", fontSize: "9px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                      Edit details
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <DraftDetailsDrawer
        draft={editDraft}
        open={editDraft !== null}
        onClose={() => setEditDraft(null)}
        onSaved={() => setDrafts(pinDraftStore.getUnaddedGeneratedDrafts(category === ALL_CATEGORIES ? undefined : category))}
      />
    </div>
  );
}

// ── Unscheduled Pins rail (right side) ────────────────────────────────────────
// Reuses the same data source (getUnaddedGeneratedDrafts) and the same shared
// single-Pin editor (via onEditDraft → page-level DraftDetailsDrawer) as the rest
// of Weekly Plan. No second editor, no duplicate readiness logic.

function railStatus(draft: PinDraft): { label: string; color: string } {
  if (draft.postedAt) return { label: "Published", color: "#7C3AED" };
  if (sanitizeHandoffField(draft.scheduledDate)) return { label: "Scheduled", color: "#059669" };
  return { label: "Unscheduled", color: "var(--app-text-muted)" };
}

function UnscheduledCard({ draft, dnd, select, onAddToPlan, onEdit, hoverActions }: {
  draft: PinDraft; dnd: PlanDnD; select?: PlanSelect;
  onAddToPlan: (id: string) => void;
  onEdit: (d: PinDraft) => void;
  hoverActions?: PinHoverPreviewActions;
}) {
  const st = railStatus(draft);
  const selected = !!select?.isSelected(draft.id);
  const [hovered, setHovered] = useState(false);
  const checkVisible = hovered || !!select?.active;
  const meta = sanitizeHandoffField(draft.source) || "Generated";
  const cardHoverActions: PinHoverPreviewActions = hoverActions
    ? { ...hoverActions, onEditDetails: onEdit, onAddToPlan }
    : { variant: "unscheduled", onEditDetails: onEdit, onAddToPlan };
  return (
    <div data-testid="rail-unscheduled-card" data-testid2="weekly-plan-unscheduled-card"
      draggable
      onDragStart={e => dnd.onPinDragStart(e, draft.id)}
      onDragEnd={dnd.onPinDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: "flex", gap: 9, padding: 8, borderRadius: 10,
        border: `${selected ? 1.5 : 1}px solid ${selected ? "#C026D3" : "var(--app-border)"}`,
        background: selected ? "rgba(192,38,211,0.07)" : "var(--app-surface-2)", opacity: dnd.draggingId === draft.id ? 0.4 : 1,
        cursor: "grab", position: "relative" }}>
      <PinHoverTarget
        draft={draft}
        actions={cardHoverActions}
        disabled={!hoverActions}
        style={{ position: "relative", flexShrink: 0, width: 46, height: 62, borderRadius: 7, overflow: "hidden", background: "var(--app-surface-3, #0f172a)" }}
      >
        <PinThumbnail src={toProxyUrl(draft.imageUrl)} loading="lazy" />
        {select && <SelectCheckbox testId="rail-select-box" selected={selected} visible={checkVisible} onToggle={() => select.toggle(draft.id)} />}
      </PinHoverTarget>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <p style={{ margin: 0, fontSize: 11.5, fontWeight: 700, color: "var(--app-text)", textTransform: "capitalize", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayTitle(draft.title, draft.keyword)}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9.5, color: "var(--app-text-muted)" }}>{meta}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9, fontWeight: 700, color: st.color }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: st.color }} /> {st.label}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
          <button type="button" data-testid="rail-add-to-plan" data-testid2="weekly-plan-unscheduled-schedule" onClick={e => { e.stopPropagation(); onAddToPlan(draft.id); }}
            title="Schedule into the next available Smart Schedule slot"
            style={{ padding: "4px 9px", borderRadius: 7, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: 9.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
            Schedule
          </button>
          <button type="button" data-testid="rail-edit-details" data-testid2="weekly-plan-unscheduled-edit-details" onClick={e => { e.stopPropagation(); onEdit(draft); }}
            style={{ padding: "4px 9px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-sec)", fontSize: 9.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
            Edit details
          </button>
        </div>
      </div>
    </div>
  );
}

function UnscheduledRail({ category, dnd, select, onEditDraft, hoverActions, onAddToPlan }: {
  category: string; dnd: PlanDnD; select: PlanSelect; onEditDraft: (d: PinDraft) => void;
  hoverActions?: PinHoverPreviewActions; onAddToPlan: (id: string) => void;
}) {
  const [drafts, setDrafts] = useState<PinDraft[]>([]);
  const [showAll, setShowAll] = useState(false);
  const dropKey = "unscheduled-rail";
  const isOver = dnd.dragOverKey === dropKey;
  const catArg = category === ALL_CATEGORIES ? undefined : category;

  useEffect(() => {
    function load() { setDrafts(pinDraftStore.getUnaddedGeneratedDrafts(catArg)); }
    load();
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
    window.addEventListener("vp:pin_store_updated", load);
    return () => {
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
      window.removeEventListener("vp:pin_store_updated", load);
    };
  }, [catArg]);

  const VISIBLE = 6;
  const shown = drafts.slice(0, VISIBLE);
  // Unscheduled queue is Schedule-first: Smart Schedule assigns the slot, so no
  // manual Assign-date / Remove affordances here (cleaned per product decision).
  const cardProps = { dnd, select, onAddToPlan, onEdit: onEditDraft, hoverActions };

  return (
    <aside data-testid="unscheduled-rail" data-testid2="weekly-plan-unscheduled-panel"
      onDragOver={e => { if (dnd.draggingId) { e.preventDefault(); dnd.setDragOverKey(dropKey); } }}
      onDragLeave={() => { if (dnd.dragOverKey === dropKey) dnd.setDragOverKey(null); }}
      onDrop={e => { e.preventDefault(); const id = readDragId(e); if (id) dnd.unschedule(id); }}
      style={{ position: "sticky", top: 0, alignSelf: "flex-start", width: 320, flexShrink: 0,
        maxHeight: "calc(100vh - 200px)", display: "flex", flexDirection: "column",
        borderRadius: 14, background: "var(--app-surface)",
        border: `1px solid ${isOver ? "rgba(192,38,211,0.55)" : "var(--app-border)"}`,
        boxShadow: isOver ? "0 0 0 2px rgba(192,38,211,0.18)" : "none", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--app-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--app-text)" }}>Unscheduled Pins</span>
          <span style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "rgba(99,102,241,0.12)", color: "#6366F1" }}>{drafts.length}</span>
        </div>
        <Link href="/app/history" style={{ fontSize: 10.5, fontWeight: 600, color: "#C026D3", textDecoration: "none" }}>History →</Link>
      </div>

      {dnd.draggingId && (
        <div style={{ padding: "7px 14px", borderBottom: "1px solid var(--app-border)", textAlign: "center", fontSize: 10.5, fontWeight: 700, color: isOver ? "#C026D3" : "var(--app-text-muted)" }}>
          Drop here to remove from plan
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {drafts.length === 0 ? (
          <p data-testid="rail-empty" style={{ margin: "6px 4px", fontSize: 11.5, color: "var(--app-text-muted)", lineHeight: 1.6 }}>
            No unscheduled Pins. <Link href="/app/studio" style={{ color: "#C026D3", fontWeight: 700 }}>Create Pins</Link> or view your <Link href="/app/history" style={{ color: "#C026D3", fontWeight: 700 }}>Pin history</Link>.
          </p>
        ) : (
          <>
            {shown.map(d => <UnscheduledCard key={d.id} draft={d} {...cardProps} />)}
            {drafts.length > VISIBLE && (
              <button type="button" data-testid="rail-view-all" onClick={() => setShowAll(true)}
                style={{ marginTop: 2, padding: "9px 0", borderRadius: 9, border: "1px solid var(--app-border)", background: "var(--app-surface-2)", color: "var(--app-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                View all {drafts.length} unscheduled Pins
              </button>
            )}
          </>
        )}
      </div>

      {/* View-all drawer — same cards, full list */}
      {showAll && (
        <div onClick={() => setShowAll(false)} style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.55)", display: "flex", justifyContent: "flex-end" }}>
          <div data-testid="rail-view-all-drawer" onClick={e => e.stopPropagation()}
            style={{ width: 400, maxWidth: "92vw", height: "100%", background: "var(--app-surface)", borderLeft: "1px solid var(--app-border)", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--app-border)" }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--app-text)" }}>All unscheduled Pins · {drafts.length}</span>
              <button type="button" onClick={() => setShowAll(false)} style={{ background: "none", border: "none", color: "var(--app-text-muted)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {drafts.map(d => <UnscheduledCard key={d.id} draft={d} {...cardProps} />)}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

// ── Page export ───────────────────────────────────────────────────────────────

export default function PlanPage() {
  return (
    <Suspense fallback={
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--app-text-sec)" }}>
        Loading…
      </div>
    }>
      <PlanPageInner />
    </Suspense>
  );
}
