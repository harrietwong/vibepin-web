"use client";

import { Suspense, useState, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

// Converts Supabase Storage public URLs to the server-side proxy so images load
// even when the "generated" bucket doesn't have public access enabled.
function toProxyUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("/") || url.startsWith("data:") || url.startsWith("blob:")) return url;
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
import { DraftDetailsDrawer } from "@/components/plan/DraftDetailsDrawer";
import { displayTitle, sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";
import {
  computeWeeklyPlanStats,
  addedNeedsDateLabel,
  getAddedNeedsDateDrafts,
  scheduledDraftsInWeek,
  unaddedStatusLabel,
  weekDateISO,
  type WeeklyPlanStats,
} from "@/lib/weeklyPlanStats";

// ── Types ──────────────────────────────────────────────────────────────────────

type ViewMode = "calendar" | "board" | "overview";

const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

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
  if (draft.postedAt) return { label: "Posted", color: "#7C3AED" };
  if (!sanitizeHandoffField(draft.scheduledDate)) {
    return { label: "Needs details", color: "#D97706" };
  }
  if (draft.status === "ready") return { label: "Ready", color: "#059669" };
  return { label: "Needs details", color: "#D97706" };
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
                      {!sanitizeHandoffField(draft.destinationUrl) && (
                        <p style={{ margin: "2px 0 0", fontSize: 8, color: "#D97706" }}>No destination URL</p>
                      )}
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
        onSaved={() => { setDrafts(pinDraftStore.getDraftsByKeyword(keyword, category)); setEditDraft(null); }}
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
            {/* Compact product state */}
            <span style={{ fontSize: "9px", color: "#CBD5E1", fontWeight: 500 }}>No product</span>
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

function SummarySegment({ dot, count, label, tipLabel, testId }: {
  dot: string; count: number; label: string; tipLabel?: string; testId: string;
}) {
  return (
    <span data-testid={testId} title={tipLabel} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0, display: "inline-block" }} />
      <span style={{ fontSize: 12, fontWeight: 800, color: "var(--app-text)" }}>{count}</span>
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--app-text-sec)" }}>{label}</span>
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
      <SummarySegment dot="#0284C7" count={stats.plannedThisWeek} label="planned"      tipLabel="Pins scheduled in this week"               testId="stat-planned"      />
      <SummarySep />
      <SummarySegment dot="#059669" count={stats.ready}           label="ready"         tipLabel="Ready to post manually"                    testId="stat-ready"        />
      <SummarySep />
      <SummarySegment dot="#D97706" count={stats.needsDetails}    label="need details"  tipLabel="Missing title, description, image, or date" testId="stat-needs-details"/>
      <SummarySep />
      <SummarySegment dot="#6366F1" count={stats.unscheduledGenerated} label="unscheduled" tipLabel="Generated but not added to plan"        testId="stat-unscheduled"  />
      <SummarySep />
      <SummarySegment dot="#7C3AED" count={stats.posted}          label="posted"        tipLabel="Marked as posted manually"                 testId="stat-posted"       />
    </div>
  );
}

// ── Inner page ────────────────────────────────────────────────────────────────

function PlanPageInner() {
  const searchParams = useSearchParams();
  const category     = searchParams.get("category") ?? "home-decor";
  const catDef       = CATEGORIES.find(c => c.id === category);
  const catLabel     = catDef?.label ?? category;

  const [viewMode, setViewMode] = useState<ViewMode>("calendar");
  const [calendarEditDraft, setCalendarEditDraft] = useState<PinDraft | null>(null);
  const [planStats, setPlanStats] = useState<WeeklyPlanStats>({
    plannedThisWeek: 0, ready: 0, needsDetails: 0, unscheduledGenerated: 0, posted: 0,
  });
  const [weekOffset, setWeekOffset] = useState(0);

  const displayWeekStart = useMemo(() => {
    const today = new Date();
    const dow   = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + weekOffset * 7);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 10);
  }, [weekOffset]);

  const displayWeekLabel = formatWeekLabel(displayWeekStart);

  const { items, weekStart, isPlanReady } = useWeeklyPlan(category);
  const briefs = items.map(enrichItem);

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

  const scheduledDrafts = scheduledDraftsInWeek(category, displayWeekStart);
  const hasItems     = items.length > 0 || scheduledDrafts.length > 0;
  const fileName     = `pin-brief-${displayWeekLabel.replace(/\s+/g, "-").toLowerCase()}.csv`;

  return (
    <div data-testid="weekly-plan-page" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>

      {/* ── Header ── */}
      <div style={{ background: "var(--app-surface)", flexShrink: 0 }}>

        {/* Primary row: title + nav + actions */}
        <div style={{ padding: "12px 24px 10px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          {/* Left: title + subtitle + category dropdown */}
          <div>
            <h1 style={{ margin: 0, fontSize: "19px", fontWeight: 800, color: "var(--app-text)" }}>Weekly Plan</h1>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
              <p style={{ margin: 0, fontSize: "12px", color: "var(--app-text-sec)" }}>{displayWeekLabel}</p>
              <select
                value={category}
                onChange={e => { window.location.href = `/app/plan?category=${e.target.value}`; }}
                style={{ padding: "2px 6px", borderRadius: 20, fontSize: 11, fontWeight: 600, border: "1px solid rgba(192,38,211,0.45)", background: "rgba(192,38,211,0.08)", color: "#C026D3", cursor: "pointer", outline: "none" }}
              >
                {ACTIVE_CATEGORIES.map(c => (
                  <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Right: week nav + actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
            <button type="button" data-testid="week-nav-today" onClick={() => setWeekOffset(0)}
              style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 700, border: "1px solid var(--app-border)", background: weekOffset === 0 ? "rgba(255,255,255,0.06)" : "transparent", color: "var(--app-text-sec)", cursor: "pointer", whiteSpace: "nowrap" }}>
              Today
            </button>
            <button type="button" data-testid="week-nav-prev" onClick={() => setWeekOffset(o => o - 1)}
              style={{ padding: "5px 10px", borderRadius: 7, fontSize: 14, border: "1px solid var(--app-border)", background: "transparent", color: "var(--app-text-sec)", cursor: "pointer", lineHeight: 1 }}>
              ‹
            </button>
            <button type="button" data-testid="week-nav-next" onClick={() => setWeekOffset(o => o + 1)}
              style={{ padding: "5px 10px", borderRadius: 7, fontSize: 14, border: "1px solid var(--app-border)", background: "transparent", color: "var(--app-text-sec)", cursor: "pointer", lineHeight: 1 }}>
              ›
            </button>
            <span style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, border: "1px solid var(--app-border)", color: "var(--app-text-sec)", whiteSpace: "nowrap" }}>
              {formatWeekRange(displayWeekStart)}
            </span>
            {isPlanReady && hasItems && (
              <button type="button"
                onClick={() => exportCSV(exportBriefs, fileName)}
                style={{ padding: "5px 12px", fontSize: "11px", fontWeight: 600, borderRadius: "7px", border: "1px solid var(--app-border)", background: "transparent", color: "var(--app-text-sec)", cursor: "pointer", whiteSpace: "nowrap" }}>
                ↓ Export CSV
              </button>
            )}
            <Link href={`/app/workspace/${category}`}
              style={{ padding: "5px 14px", fontSize: "12px", fontWeight: 700, borderRadius: "8px", border: "1.5px solid rgba(192,38,211,0.6)", color: "#C026D3", textDecoration: "none", whiteSpace: "nowrap" }}>
              ✏️ Edit Plan
            </Link>
            <Link href="/app/studio" data-testid="create-pin-btn"
              style={{ padding: "5px 14px", fontSize: "12px", fontWeight: 700, borderRadius: "8px", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", textDecoration: "none", whiteSpace: "nowrap" }}>
              ✦ Create Pin
            </Link>
          </div>
        </div>

        {/* Compact summary bar */}
        <CompactSummaryBar stats={planStats} />

        {/* View mode + calendar controls */}
        <div style={{ padding: "8px 24px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: "rgba(255,255,255,0.04)", borderRadius: "8px", padding: "3px", gap: "2px", flexShrink: 0 }}>
            {(["calendar", "board", "overview"] as const).map(mode => (
              <button key={mode} type="button"
                data-testid={`view-mode-${mode}`}
                onClick={() => setViewMode(mode)}
                style={{
                  padding: "4px 11px", fontSize: "11px", fontWeight: 600, borderRadius: "6px", border: "none", cursor: "pointer",
                  background: viewMode === mode ? "var(--app-surface)" : "transparent",
                  color:      viewMode === mode ? "var(--app-text)" : "var(--app-text-sec)",
                  boxShadow:  viewMode === mode ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}>
                {mode === "calendar" ? "Calendar" : mode === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <div style={{ display: "flex", background: "rgba(255,255,255,0.04)", borderRadius: "8px", padding: "3px", gap: "2px" }}>
              <button type="button" style={{ padding: "4px 10px", fontSize: "11px", fontWeight: 600, borderRadius: "6px", border: "none", cursor: "pointer", background: "var(--app-surface)", color: "var(--app-text)", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}>Week</button>
              <button type="button" disabled style={{ padding: "4px 10px", fontSize: "11px", fontWeight: 600, borderRadius: "6px", border: "none", cursor: "not-allowed", background: "transparent", color: "var(--app-text-muted)", opacity: 0.45 }}>Month</button>
            </div>
            <button type="button" data-testid="weekly-plan-filters-btn"
              style={{ padding: "5px 12px", fontSize: "11px", fontWeight: 600, borderRadius: 7, border: "1px solid var(--app-border)", background: "transparent", color: "var(--app-text-sec)", cursor: "pointer" }}>
              ⚙ Filters
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
        {!hasItems && (
          <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, border: "1px solid var(--app-border)", background: "var(--app-surface)" }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--app-text-sec)" }}>
              No keyword plan for <strong>{catLabel}</strong> this week yet. You can still assign generated pins to dates below, or{" "}
              <Link href={`/app/workspace/${category}`} style={{ color: "#C026D3", fontWeight: 700 }}>build a keyword plan →</Link>
            </p>
          </div>
        )}

        <div data-testid="weekly-plan-calendar" style={{ maxWidth: "980px", margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }}>
          {DAY_SHORT.map((dayLabel, i) => {
            const { dateStr } = dayDateLabel(i);
            const dateISO = weekDateISO(displayWeekStart, i);
            const dayBriefs = slots[i];
            const dayDrafts = scheduledDrafts.filter(d => d.scheduledDate === dateISO);
            const d = new Date(`${displayWeekStart}T00:00:00`);
            d.setDate(d.getDate() + i);
            const isToday = d.toDateString() === new Date().toDateString();
            const isEmpty = dayBriefs.length === 0 && dayDrafts.length === 0;

            return (
              <div
                key={dayLabel}
                data-testid={`calendar-day-${i}`}
                style={{
                  minHeight: 180,
                  borderRadius: 12,
                  border: `1px solid ${isToday ? "rgba(192,38,211,0.35)" : "var(--app-border)"}`,
                  background: "var(--app-surface)",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--app-border)", background: isToday ? "rgba(192,38,211,0.06)" : "transparent" }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: isToday ? "#C026D3" : "var(--app-text-muted)", letterSpacing: "0.08em" }}>{dayLabel}</div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "var(--app-text)" }}>{dateStr}</div>
                </div>
                <div style={{ flex: 1, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  {dayBriefs.map(brief => (
                    <div key={brief.id} data-testid="calendar-keyword-slot" style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid var(--app-border)", background: "var(--app-surface-2)" }}>
                      <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "var(--app-text)", textTransform: "capitalize", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{brief.keyword}</p>
                    </div>
                  ))}
                  {dayDrafts.map(draft => (
                    <ScheduledDraftCard key={draft.id} draft={draft} onEdit={setCalendarEditDraft} />
                  ))}
                  {isEmpty && (
                    <div data-testid="calendar-empty-slot" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 8px", textAlign: "center" }}>
                      <p style={{ margin: 0, fontSize: 11, color: "var(--app-text-muted)" }}>No Pins planned</p>
                      <Link href="/app/studio" style={{ fontSize: 10, fontWeight: 700, color: "#C026D3", textDecoration: "none" }}>Add Pin</Link>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p style={{ textAlign: "center", fontSize: "11px", color: "var(--app-text-muted)", marginTop: "20px", paddingBottom: "10px" }}>
          🕐 All times are in your local time zone
        </p>
        <AddedNeedsDateSection category={category} weekStart={displayWeekStart} />
        <UnscheduledDraftsSection category={category} />
      </div>
      <DraftDetailsDrawer
        draft={calendarEditDraft}
        open={calendarEditDraft !== null}
        onClose={() => setCalendarEditDraft(null)}
        onSaved={() => setCalendarEditDraft(null)}
      />
    </div>
  );
}

// ── Scheduled draft card (calendar) ───────────────────────────────────────────

function ScheduledDraftCard({ draft, onEdit }: { draft: PinDraft; onEdit?: (draft: PinDraft) => void }) {
  const st = draftStatusDisplay(draft);
  return (
    <div
      data-testid="scheduled-draft-card"
      onClick={() => onEdit?.(draft)}
      style={{ borderRadius: 8, overflow: "hidden", border: "1px solid var(--app-border)", background: "var(--app-surface-2)", cursor: onEdit ? "pointer" : "default" }}
    >
      <div style={{ aspectRatio: "2/3", background: "#0f172a", position: "relative" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={toProxyUrl(draft.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        <span data-testid="scheduled-status-badge" style={{ position: "absolute", bottom: 4, left: 4, right: 4, textAlign: "center", fontSize: 8, fontWeight: 700, padding: "2px 4px", borderRadius: 6, background: `${st.color}dd`, color: "#fff" }}>
          {st.label}
        </span>
      </div>
      <p style={{ margin: 0, padding: "4px 6px", fontSize: 9, fontWeight: 700, color: "var(--app-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {displayTitle(draft.title, draft.keyword)}
      </p>
    </div>
  );
}

// ── Added to plan, needs date ─────────────────────────────────────────────────

function AddedNeedsDateSection({ category, weekStart }: { category: string; weekStart: string }) {
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
    pinDraftStore.assignDraftToDate(draftId, date);
    setEditingId(null);
    setEditDate("");
  }

  if (drafts.length === 0) return null;

  const st = addedNeedsDateLabel();

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
              <div key={draft.id} data-testid="added-needs-date-card" style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--app-border)", background: "var(--app-surface-2)", display: "flex", flexDirection: "column" }}>
                <div style={{ position: "relative", aspectRatio: "2/3", background: "#0f172a", overflow: "hidden" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={toProxyUrl(draft.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    onError={e => { e.currentTarget.style.opacity = "0.3"; }} />
                  <span style={{ position: "absolute", bottom: 5, left: 5, right: 5, textAlign: "center", fontSize: "8px", fontWeight: 700, padding: "2px 6px", borderRadius: 8, background: `${st.color}dd`, color: "#fff" }}>
                    {st.label}
                  </span>
                </div>
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
                    <button type="button"
                      onClick={() => { setEditingId(draft.id); setEditDate(new Date(Date.now() + 86400000).toISOString().split("T")[0]); }}
                      style={{ flex: "1 1 auto", padding: "4px 6px", borderRadius: 7, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: "9px", fontWeight: 700, cursor: "pointer" }}>
                      Assign date
                    </button>
                    <button type="button" onClick={() => setEditDraft(draft)}
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
        onSaved={() => { setDrafts(getAddedNeedsDateDrafts(category, weekStart)); setEditDraft(null); }}
      />
    </div>
  );
}

// ── Unscheduled drafts section ────────────────────────────────────────────────
// Shows pin drafts added from Generated Pins that don't match any plan row keyword.
// Masonry grid layout — each card is independently editable.

function UnscheduledDraftsSection({ category }: { category: string }) {
  const [drafts,    setDrafts]    = useState<PinDraft[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate,  setEditDate]  = useState("");
  const [editDraft, setEditDraft] = useState<PinDraft | null>(null);

  useEffect(() => {
    function load() { setDrafts(pinDraftStore.getUnaddedGeneratedDrafts(category)); }
    load();
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
    window.addEventListener("vp:pin_store_updated",          load);
    return () => {
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, load);
      window.removeEventListener("vp:pin_store_updated",          load);
    };
  }, [category]);

  function handleAddToPlan(draftId: string) {
    pinDraftStore.markAddedToWeeklyPlan(draftId);
  }

  function handleAssignDate(draftId: string, date: string) {
    if (!date) return;
    pinDraftStore.assignDraftToDate(draftId, date);
    setEditingId(null);
    setEditDate("");
  }

  function handleRemove(draftId: string) {
    pinDraftStore.deleteDraft(draftId);
  }

  if (drafts.length === 0) return null;

  return (
    <div data-testid="unscheduled-generated-section" style={{ maxWidth: "980px", margin: "16px auto 0", borderRadius: 14, background: "var(--app-surface)", border: "1px solid var(--app-border)", overflow: "hidden" }}>
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

      {!collapsed && (
        <div style={{ padding: "14px 18px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
            {drafts.map(draft => {
              const isEditing = editingId === draft.id;
              const st = unaddedStatusLabel();

              return (
                <div key={draft.id} data-testid="unscheduled-pin-card" style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--app-border)", background: "var(--app-surface-2)", display: "flex", flexDirection: "column" }}>
                  <div style={{ position: "relative", aspectRatio: "2/3", background: "#0f172a", overflow: "hidden" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={toProxyUrl(draft.imageUrl)} alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      onError={e => { e.currentTarget.style.opacity = "0.3"; }}/>
                    <span data-testid="unscheduled-status-badge" style={{
                      position: "absolute", bottom: 5, left: 5, right: 5, textAlign: "center",
                      fontSize: "8px", fontWeight: 700, padding: "2px 6px", borderRadius: 8,
                      background: `${st.color}dd`, color: "#fff",
                    }}>
                      {st.label}
                    </span>
                  </div>

                  <div style={{ padding: "8px 9px 4px", flex: 1 }}>
                    <p style={{ margin: "0 0 3px", fontSize: "11px", fontWeight: 700, color: "var(--app-text)", textTransform: "capitalize", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {displayTitle(draft.title, draft.keyword)}
                    </p>
                  </div>

                  {isEditing ? (
                    <div style={{ padding: "6px 9px 8px", display: "flex", flexDirection: "column", gap: 5 }}>
                      <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                        style={{ padding: "4px 7px", borderRadius: 7, border: "1px solid #C4B5FD", fontSize: "11px", outline: "none", color: "var(--app-text-sec)", background: "var(--app-surface)", width: "100%", boxSizing: "border-box" }}/>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button type="button" data-testid="unscheduled-assign-date-confirm" onClick={() => handleAssignDate(draft.id, editDate)}
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
                      <button type="button" data-testid="unscheduled-add-to-plan" onClick={() => handleAddToPlan(draft.id)}
                        style={{ flex: "1 1 auto", padding: "4px 6px", borderRadius: 7, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: "9px", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                        Add to Plan
                      </button>
                      <button type="button"
                        onClick={() => { setEditingId(draft.id); setEditDate(new Date(Date.now() + 86400000).toISOString().split("T")[0]); }}
                        style={{ flex: "1 1 auto", padding: "4px 6px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-sec)", fontSize: "9px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                        Assign date
                      </button>
                      <button type="button" data-testid="unscheduled-edit-details" onClick={() => setEditDraft(draft)}
                        style={{ flex: "0 0 auto", padding: "4px 6px", borderRadius: 7, border: "1px solid var(--app-border)", background: "var(--app-surface)", color: "var(--app-text-sec)", fontSize: "9px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                        Edit details
                      </button>
                      <button type="button" onClick={() => handleRemove(draft.id)}
                        style={{ flex: "0 0 auto", padding: "4px 6px", borderRadius: 7, border: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.04)", color: "#EF4444", fontSize: "9px", cursor: "pointer" }}>
                        Remove
                      </button>
                    </div>
                  )}
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
        onSaved={() => { setDrafts(pinDraftStore.getUnaddedGeneratedDrafts(category)); setEditDraft(null); }}
      />
    </div>
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
