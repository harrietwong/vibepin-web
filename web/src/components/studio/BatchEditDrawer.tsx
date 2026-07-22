"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  X, ChevronDown, Package, Trash2, ExternalLink, Plus, Send, Loader2,
  Search, SlidersHorizontal, Calendar, Tag, Link2, CheckCircle2,
  AlertCircle, Sparkles, MoreHorizontal, Star, Pencil, Copy, CalendarClock,
} from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { toProxyUrl } from "@/lib/imageProxy";
import type { PinMetadataDraft } from "@/lib/pinMetadata";
import {
  normalizeProductSource,
  productKey,
  productSourceLabel,
  recommendRealBoard,
  type LinkedProduct,
} from "@/lib/pinMetadata";
import { startPinterestConnect, publishPin, type PinterestBoard } from "@/lib/pinterestClient";
import { usePinterestBoards } from "@/hooks/usePinterestBoards";
import { beginPublish, endPublish, mapPublishErrorToCategory } from "@/lib/studio/pinLifecycle";
import * as pinDraftStore from "@/lib/pinDraftStore";
import type { PinterestClientError } from "@/lib/pinterestClient";
import { generatePinterestPinCopy, isRateLimitError } from "@/lib/ai-copy/generatePinCopy";
import { readResolvedContentLanguage } from "@/lib/i18n/config";
import { isPinReady, pinMissingFieldLabels, pinFieldErrors, type ReadinessInput } from "@/lib/pinReadiness";
import { combineLocalPlannedAt } from "@/lib/weeklyPlanHandoff";
import { getPinDisplayContext } from "@/lib/studio/pinDisplayContext";
import { resolveProductLinkDisplay, isAmazonProduct, linkDomain } from "@/lib/studio/productLink";
import type { ProductSnapshot } from "@/lib/studioPersistence";
import { useBackButtonClose } from "@/lib/useBackButtonClose";
import { toast } from "sonner";
import { usePublishAssistantContext } from "@/lib/assistant/useAssistant";
import { detectBatch, buildBatchFindings, type BatchPinLike, type BatchHandlers } from "@/lib/assistant/detectors/batchEdit";
import type { AssistantContext, AssistantPreview, PreviewChange } from "@/lib/assistant/types";

// Theme palette — surfaces/text/borders follow the app theme; purple/pink
// reserved for the primary CTA + selection.
const UI = {
  card:      "var(--app-surface, #161D2E)",
  cardElev:  "var(--app-surface-3, #1A2236)",
  bg:        "var(--app-bg, #0B0E17)",
  bg2:       "var(--app-surface-2, #111827)",
  border:    "var(--app-border, rgba(255,255,255,0.09))",
  borderStr: "var(--app-border-hi, rgba(255,255,255,0.12))",
  text:      "var(--app-text, #E2E8F0)",
  textSec:   "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #64748B)",
  purple:    "#7C3AED",
  purpleSoft:"rgba(124,58,237,0.10)",
  success:   "#10B981",
  warning:   "#F59E0B",
  error:     "#EF4444",
  gradient:  "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
} as const;

// ── Public contract (preserved) ───────────────────────────────────────────────

export type PinProductsEdit = {
  primary: LinkedProduct | null;
  tagged:  LinkedProduct[];
};

export type RowEdit = {
  title?:              string;
  description?:        string;
  altText?:            string;
  destinationUrl?:     string;
  plannedDate?:        string;
  plannedTime?:        string;
  plannedAt?:          string;
  boardSuggestion?:    string;
  boardId?:            string;
  boardName?:          string;
  planningStatus?:     string;
  products?:           PinProductsEdit;
  linkedProductId?:    string | null;
  linkedProductTitle?: string | null;
  linkedProductUrl?:   string | null;
  linkedProductImageUrl?: string | null;
  linkedProductSource?:   string | null;
  isAutoLinked?:       boolean;
};

export type BatchApplyOpts = { rowEdits: Record<string, RowEdit> };

export type BatchPinRow = {
  pinId:                string;
  sessionId:            string;
  groupIdx:             number;
  pinIdx:               number;
  imageUrl:             string;
  title:                string;
  description:          string;
  altText:              string;
  destinationUrl:       string;
  plannedDate:          string;
  plannedTime?:         string;
  plannedAt?:           string;
  postedAt?:            string;
  addedToPlanAt?:       string;
  planningStatus:       string;
  boardSuggestion:      string;
  boardId?:             string;
  boardName?:           string;
  metadataDraft?:       PinMetadataDraft;
  linkedProductId?:     string;
  linkedProductTitle?:  string;
  linkedProductUrl?:    string;
  linkedProductImageUrl?: string;
  linkedProductSource?: string;
  isAutoLinked?:        boolean;
  taggedCount?:         number;
  taggedProducts?:      LinkedProduct[];
  category?:            string;
  setupProducts?:       ProductSnapshot[];
};

export type BatchEditInitialFilter =
  | "all" | "missing_details" | "missing_url" | "missing_products" | "missing_board"
  | "missing_title" | "missing_description" | "missing_alt_text";

export type BatchEditDrawerProps = {
  open:               boolean;
  pins:               BatchPinRow[];
  onClose:            () => void;
  onApply:            (opts: BatchApplyOpts) => void;
  onGenerateMetadata: (overwriteEdited: boolean) => void;
  source?:            "history" | "weekly_plan";
  /** Called after a publish run with the pinIds that published successfully. */
  onPublishComplete?: (publishedPinIds: string[]) => void;
  /** Add/assign the given pins to the Weekly Plan / schedule flow (no publish readiness gate). */
  onScheduleSelected?: (pinIds: string[]) => void;
  initialFilter?:     BatchEditInitialFilter;
};

// ── Value helpers (reused) ────────────────────────────────────────────────────

const APPLY_KEYS = ["title", "description", "altText", "destinationUrl", "plannedDate", "plannedTime", "boardSuggestion", "planningStatus"] as const;
type ApplyFieldKey = typeof APPLY_KEYS[number];

function getVal(pin: BatchPinRow, edits: Record<string, RowEdit>, field: ApplyFieldKey): string {
  const fromEdit = edits[pin.pinId]?.[field];
  if (fromEdit !== undefined) return fromEdit;
  if (field === "planningStatus") return pin.planningStatus ?? "";
  return (pin as unknown as Record<string, string>)[field] ?? "";
}

function pinPrimaryFromRow(pin: BatchPinRow): LinkedProduct | null {
  if (!pin.linkedProductTitle && !pin.linkedProductUrl && !pin.linkedProductId) return null;
  return {
    productId:  pin.linkedProductId,
    title:      pin.linkedProductTitle ?? "Product",
    imageUrl:   pin.linkedProductImageUrl,
    productUrl: pin.linkedProductUrl,
    source:     normalizeProductSource(pin.linkedProductSource),
    linkType:   pin.isAutoLinked ? "auto" : "manual",
  };
}

function effProducts(pin: BatchPinRow, edits: Record<string, RowEdit>): PinProductsEdit & { hasEdit: boolean } {
  const edit = edits[pin.pinId];
  if (edit?.products !== undefined) return { ...edit.products, hasEdit: true };
  if (edit?.linkedProductTitle !== undefined) {
    return {
      primary: edit.linkedProductTitle ? {
        productId:  edit.linkedProductId ?? undefined,
        title:      edit.linkedProductTitle,
        imageUrl:   edit.linkedProductImageUrl ?? undefined,
        productUrl: edit.linkedProductUrl ?? undefined,
        source:     normalizeProductSource(edit.linkedProductSource ?? undefined),
        linkType:   edit.isAutoLinked ? "auto" : "manual",
      } : null,
      tagged: [],
      hasEdit: true,
    };
  }
  return { primary: pinPrimaryFromRow(pin), tagged: pin.taggedProducts ?? [], hasEdit: false };
}

function effBoard(pin: BatchPinRow, edits: Record<string, RowEdit>): { id: string; name: string } {
  const e = edits[pin.pinId];
  if (e?.boardId !== undefined) return { id: e.boardId ?? "", name: e.boardName ?? "" };
  return { id: pin.boardId ?? "", name: pin.boardName ?? "" };
}

function pubReadinessInput(pin: BatchPinRow, edits: Record<string, RowEdit>): ReadinessInput {
  return {
    imageUrl:       pin.imageUrl,
    title:          getVal(pin, edits, "title"),
    description:    getVal(pin, edits, "description"),
    altText:        getVal(pin, edits, "altText"),
    destinationUrl: getVal(pin, edits, "destinationUrl"),
    boardId:        effBoard(pin, edits).id,
  };
}

/** Missing required fields + over-limit title/description, as one combined label list
 *  (empty title/description are never a problem; over-cap always is). */
function pubBlockingLabels(pin: BatchPinRow, edits: Record<string, RowEdit>): string[] {
  const input = pubReadinessInput(pin, edits);
  const labels = pinMissingFieldLabels(input);
  const lenErrors = pinFieldErrors(input);
  if (lenErrors.title) labels.push("Title too long");
  if (lenErrors.description) labels.push("Description too long");
  return labels;
}

function sourceShortLabel(src: string | null | undefined): string {
  if (!src) return "";
  return productSourceLabel(normalizeProductSource(src));
}

function formatDate(iso: string): string {
  const v = (iso ?? "").trim();
  if (!v) return "";
  const d = new Date(`${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Plan column value — canonical planning state collapsed to the four allowed labels.
 * Schedule auto-assigns a Smart Schedule slot, so there is no user-facing undated
 * planning state: a planned-but-undated legacy draft reads as "Not planned" until scheduled.
 */
type PlanLabel = "Not planned" | "Planned" | "Posted" | "Failed";
function planLabel(pin: BatchPinRow, edits: Record<string, RowEdit>): PlanLabel {
  const ps = getVal(pin, edits, "planningStatus");
  if (pin.postedAt || ps === "posted") return "Posted";
  if (ps === "failed") return "Failed";
  const date = getVal(pin, edits, "plannedDate").trim();
  const plannedAt = (edits[pin.pinId]?.plannedAt ?? pin.plannedAt ?? "").trim();
  if (plannedAt || date) return "Planned";
  return "Not planned";
}
// Canonical PlanLabel values double as filter-state/select values — never
// translated at the source. Render sites look up the display string here.
const PLAN_LABEL_KEY: Record<PlanLabel, "studioModals.plan.notPlanned" | "studioModals.plan.planned" | "studioModals.plan.posted" | "studioModals.plan.failed"> = {
  "Not planned": "studioModals.plan.notPlanned",
  "Planned":     "studioModals.plan.planned",
  "Posted":      "studioModals.plan.posted",
  "Failed":      "studioModals.plan.failed",
} as const;

function shortDomain(url: string): string {
  const u = (url ?? "").trim();
  if (!u) return "";
  try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, ""); }
  catch { return u.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; }
}

/** Normalized identity for a product URL — used for dedupe + existing-product matching. */
function normalizeProductUrl(url: string): string {
  const u = (url ?? "").trim().toLowerCase();
  if (!u) return "";
  try {
    const parsed = new URL(u.startsWith("http") ? u : `https://${u}`);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").split("?")[0];
  }
}

function linkedProductFromUrl(url: string): LinkedProduct {
  const u = url.trim();
  return { title: shortDomain(u) || "Product", productUrl: u, source: "url_imported", linkType: "manual" };
}

function applyProductAdd(current: PinProductsEdit, lp: LinkedProduct, asPrimary: boolean): PinProductsEdit {
  const norm = normalizeProductUrl(lp.productUrl ?? "");
  const dup = (p: LinkedProduct | null) => !!p && norm && normalizeProductUrl(p.productUrl ?? "") === norm;
  if (dup(current.primary) || current.tagged.some(dup)) return current;
  let { primary, tagged } = current;
  if (asPrimary || !primary) {
    if (primary) tagged = [{ ...primary, linkType: "manual" }, ...tagged];
    primary = lp;
  } else {
    tagged = [...tagged, lp];
  }
  return { primary, tagged };
}

function promoteTaggedToPrimary(current: PinProductsEdit, key: string): PinProductsEdit {
  const target = current.tagged.find(t => productKey(t) === key);
  if (!target) return current;
  const rest = current.tagged.filter(t => productKey(t) !== key);
  const demoted = current.primary ? [{ ...current.primary, linkType: "manual" as const }, ...rest] : rest;
  return { primary: { ...target, linkType: "manual" }, tagged: demoted };
}

function removeProductByKey(current: PinProductsEdit, key: string): PinProductsEdit {
  if (current.primary && productKey(current.primary) === key) {
    const [next, ...rest] = current.tagged;
    return { primary: next ? { ...next, linkType: "manual" } : null, tagged: rest };
  }
  return { primary: current.primary, tagged: current.tagged.filter(t => productKey(t) !== key) };
}

// ── Small UI primitives ───────────────────────────────────────────────────────

const NAV_WIDTH = 80;

const btnBase: React.CSSProperties = {
  padding: "7px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600,
  cursor: "pointer", border: `1px solid ${UI.border}`, background: UI.cardElev, color: UI.text,
  flexShrink: 0, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6,
};
const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 8,
  border: `1px solid ${UI.borderStr}`, background: "var(--app-surface-2, #0D1423)", color: UI.text, fontSize: 12, outline: "none",
};
const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: UI.textSec, marginBottom: 6, display: "block" };

// Inline editable cell input (dense, transparent until focused).
const inlineInput: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "5px 7px", borderRadius: 6,
  border: "1px solid transparent", background: "transparent", color: UI.text, fontSize: 11.5,
  outline: "none", fontFamily: "inherit",
};
function onInlineFocus(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = UI.borderStr; e.currentTarget.style.background = UI.bg2;
}
function onInlineBlur(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.background = "transparent";
}

function Dropdown({ trigger, align = "left", width = 220, children, disabled }: {
  trigger: (open: boolean) => React.ReactNode;
  align?: "left" | "right";
  width?: number;
  disabled?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" disabled={disabled} onClick={e => { e.stopPropagation(); if (!disabled) setOpen(o => !o); }}
        style={{ background: "none", border: "none", padding: 0, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }}>
        {trigger(open)}
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 5px)", zIndex: 60,
          left: align === "left" ? 0 : undefined, right: align === "right" ? 0 : undefined,
          background: UI.bg2, border: `1px solid ${UI.borderStr}`, borderRadius: 10,
          boxShadow: "0 10px 28px rgba(0,0,0,0.5)", minWidth: width, overflow: "hidden",
        }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, sub, onClick, danger, disabled, testId }: { icon?: React.ReactNode; label: string; sub?: string; onClick: () => void; danger?: boolean; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" disabled={disabled} data-testid={testId}
      style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "9px 13px", background: "none", border: "none", textAlign: "left", fontSize: 12, color: disabled ? UI.textMuted : danger ? UI.error : UI.text, cursor: disabled ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = danger ? "rgba(239,68,68,0.07)" : "rgba(255,255,255,0.05)"; }}
      onMouseLeave={e => (e.currentTarget.style.background = "none")}
      onClick={onClick}>
      {icon}<span style={{ flex: 1 }}>{label}</span>{sub && <span style={{ fontSize: 10, color: UI.textMuted }}>{sub}</span>}
    </button>
  );
}

function Modal({ title, subtitle, width = 440, onClose, children, footer }: {
  title: string; subtitle?: string; width?: number; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 320, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: UI.bg2, border: `1px solid ${UI.borderStr}`, borderRadius: 14, boxShadow: "0 18px 52px rgba(0,0,0,0.6)", padding: "22px 24px", width, maxWidth: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: UI.text }}>{title}</h3>
            {subtitle && <p style={{ margin: "4px 0 0", fontSize: 11, color: UI.textSec, lineHeight: 1.5 }}>{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: UI.textMuted, padding: 2 }}><X style={{ width: 15, height: 15 }} /></button>
        </div>
        <div style={{ overflowY: "auto" }}>{children}</div>
        {footer && <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>{footer}</div>}
      </div>
    </div>
  );
}

type ConfirmState = { title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void };

function ConfirmModal({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const { t: tr } = useLocale();
  return (
    <Modal title={state.title} onClose={onClose} footer={<>
      <button type="button" onClick={onClose} style={{ ...btnBase }}>{tr("common.cancel")}</button>
      <button type="button" onClick={() => { state.onConfirm(); onClose(); }} style={{ ...btnBase, border: "none", background: state.danger ? UI.error : UI.gradient, color: "#fff" }}>{state.confirmLabel}</button>
    </>}>
      <div style={{ fontSize: 12, color: UI.textSec, lineHeight: 1.6 }}>{state.body}</div>
    </Modal>
  );
}

// ── Board picker ──────────────────────────────────────────────────────────────

type BoardsState = { boards: PinterestBoard[]; status: "loading" | "ready" | "not_connected" | "reconnect" | "error" };

function BoardSelect({ value, boardsState, onChange, recommendFor, dense }: {
  value: { id: string; name: string };
  boardsState: BoardsState;
  onChange: (b: { id: string; name: string } | null) => void;
  recommendFor?: { category?: string; topic?: string };
  dense?: boolean;
}) {
  const { t: tr } = useLocale();
  const { boards, status } = boardsState;
  if (status === "loading") return <span style={{ fontSize: 11, color: UI.textMuted }}>{tr("common.loading")}</span>;
  if (status === "not_connected") return (
    <button type="button" onClick={() => startPinterestConnect()} style={{ ...btnBase, fontSize: 10.5, padding: "4px 8px", color: "#93C5FD" }}>{tr("studioModals.board.connectPinterest")}</button>
  );
  // Expired/revoked token: the account IS connected — never say "Connect".
  if (status === "reconnect") return (
    <button type="button" onClick={() => startPinterestConnect()} style={{ ...btnBase, fontSize: 10.5, padding: "4px 8px", color: "#FBBF24" }}>{tr("studioModals.board.reconnectPinterest")}</button>
  );
  if (status === "error") return <span style={{ fontSize: 11, color: UI.textMuted }}>{tr("studioModals.board.couldNotLoad")}</span>;
  const known = !value.id || boards.some(b => b.id === value.id);
  const recName = !value.id && recommendFor ? recommendRealBoard(boards.map(b => b.name), recommendFor) : null;
  const recBoard = recName ? boards.find(b => b.name === recName) ?? null : null;
  const sel = (
    <select value={known ? value.id : "__unavailable__"}
      onChange={e => {
        const v = e.target.value;
        if (v === "" || v === "__unavailable__") { onChange(null); return; }
        const b = boards.find(x => x.id === v);
        if (b) onChange({ id: b.id, name: b.name });
      }}
      onFocus={dense ? onInlineFocus : undefined} onBlur={dense ? onInlineBlur : undefined}
      style={dense ? { ...inlineInput, appearance: "none" } : { ...inputStyle, padding: "8px 10px" }}>
      <option value="">{tr("studioModals.board.selectBoard")}</option>
      {!known && value.id && <option value="__unavailable__">{tr("studioModals.board.boardUnavailable")}</option>}
      {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );
  if (dense) return sel;
  return (
    <div>
      {sel}
      {recBoard && (
        <button type="button" data-testid="board-recommend" onClick={() => onChange({ id: recBoard.id, name: recBoard.name })}
          style={{ marginTop: 5, background: "none", border: "none", padding: 0, fontSize: 10.5, fontWeight: 700, color: "#A78BFA", cursor: "pointer" }}>
          {tr("studioModals.board.usePrefix")}{recBoard.name}{tr("studioModals.board.useSuffix")}
        </button>
      )}
    </div>
  );
}

// ── Bulk popovers ─────────────────────────────────────────────────────────────

type DestUrlMode = "fill_empty" | "replace" | "product" | "clear";
function DestinationUrlPopover({ count, onApply, onClose }: {
  count: number;
  onApply: (url: string, mode: DestUrlMode) => void;
  onClose: () => void;
}) {
  const { t: tr } = useLocale();
  const [url, setUrl]   = useState("");
  const [mode, setMode] = useState<DestUrlMode>("fill_empty");
  const needsUrl = mode === "fill_empty" || mode === "replace";
  const canApply = needsUrl ? !!url.trim() : true;
  const applyLabel = mode === "clear" ? tr("studioModals.dest.clearUrls") : mode === "product" ? tr("studioModals.dest.useProductUrls") : tr("studioModals.apply");
  const modeTestId: Record<DestUrlMode, string> = { fill_empty: "fill", replace: "replace", product: "product", clear: "clear" };
  const modeRows: [DestUrlMode, string, string][] = [
    ["fill_empty", tr("studioModals.dest.fillEmptyOnly"), tr("studioModals.dest.fillEmptyOnlyHint")],
    ["replace", tr("studioModals.dest.replaceExisting"), tr("studioModals.dest.replaceExistingHint")],
    ["product", tr("studioModals.dest.useProductUrlWhereAvailable"), tr("studioModals.dest.useProductUrlWhereAvailableHint")],
    ["clear", tr("studioModals.dest.clearWebsiteUrl"), tr("studioModals.dest.clearWebsiteUrlHint")],
  ];
  return (
    <Modal title={(count === 1 ? tr("studioModals.dest.titleOne") : tr("studioModals.dest.titleMany").replace("{n}", String(count)))} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} style={btnBase}>{tr("common.cancel")}</button>
        <button type="button" disabled={!canApply} data-testid="batch-edit-destination-url-apply"
          onClick={() => canApply && onApply(url.trim(), mode)}
          style={{ ...btnBase, border: "none", background: canApply ? UI.gradient : UI.cardElev, color: "#fff", opacity: canApply ? 1 : 0.5 }}>{applyLabel}</button>
      </>}>
      <p style={{ ...labelStyle, marginTop: 0 }}>{tr("studioModals.dest.optionalHint")}</p>
      {modeRows.map(([m, lbl, sub]) => (
        <label key={m} data-testid={`batch-edit-destination-mode-${modeTestId[m]}`} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10, cursor: "pointer" }}>
          <input type="radio" name="dest-mode" checked={mode === m} onChange={() => setMode(m)} style={{ accentColor: UI.purple, marginTop: 2 }} />
          <span><span style={{ fontSize: 12, color: UI.text, fontWeight: 600 }}>{lbl}</span><br /><span style={{ fontSize: 10.5, color: UI.textMuted }}>{sub}</span></span>
        </label>
      ))}
      {needsUrl && (
        <>
          <label style={{ ...labelStyle, marginTop: 6 }}>{tr("pinDetails.websiteUrl")}</label>
          <input data-testid="batch-edit-destination-url-input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" autoFocus style={inputStyle} />
        </>
      )}
      <p style={{ margin: "10px 0 0", fontSize: 10.5, color: UI.textMuted }}>{tr("studioModals.dest.productUrlsNeverChanged")}</p>
    </Modal>
  );
}

function SchedulePopover({ count, onApply, onClose }: {
  count: number;
  onApply: (date: string, time: string) => void;
  onClose: () => void;
}) {
  const { t: tr } = useLocale();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  return (
    <Modal title={(count === 1 ? tr("studioModals.schedule.titleOne") : tr("studioModals.schedule.titleMany").replace("{n}", String(count)))}
      subtitle={tr("studioModals.schedule.subtitle")} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} style={btnBase}>{tr("common.cancel")}</button>
        <button type="button" disabled={!date} data-testid="batch-edit-schedule-apply" onClick={() => date && onApply(date, time)}
          style={{ ...btnBase, border: "none", background: date ? UI.gradient : UI.cardElev, color: "#fff", opacity: date ? 1 : 0.5 }}>{tr("studioModals.apply")}</button>
      </>}>
      <label style={labelStyle}>{tr("studioModals.schedule.date")}</label>
      <input type="date" data-testid="batch-edit-schedule-date" value={date} onChange={e => setDate(e.target.value)} style={{ ...inputStyle, colorScheme: "dark" }} />
      <label style={{ ...labelStyle, marginTop: 14 }}>{tr("studioModals.schedule.time")}</label>
      <input type="time" data-testid="batch-edit-schedule-time" value={time} onChange={e => setTime(e.target.value)} style={{ ...inputStyle, colorScheme: "dark" }} />
    </Modal>
  );
}

function ProductPopover({ count, onApply, onReplace, onClose }: {
  count: number;
  onApply: (urls: string[], primaryIdx: number) => void;
  onReplace: (urls: string[]) => void;
  onClose: () => void;
}) {
  const { t: tr } = useLocale();
  const [urls, setUrls] = useState<string[]>([""]);
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [setPrimary, setSetPrimary] = useState(true);
  const cleaned = urls.map(u => u.trim()).filter(Boolean);
  const canApply = cleaned.length > 0;
  function submit() {
    if (!canApply) return;
    if (mode === "replace") { onReplace(cleaned); return; }
    onApply(cleaned, cleaned.length === 1 ? (setPrimary ? 0 : -1) : 0);
  }
  return (
    <Modal title={(count === 1 ? tr("studioModals.product.editTitleOne") : tr("studioModals.product.editTitleMany").replace("{n}", String(count)))} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} style={btnBase}>{tr("common.cancel")}</button>
        <button type="button" disabled={!canApply} data-testid="batch-edit-product-apply" onClick={submit}
          style={{ ...btnBase, border: "none", background: canApply ? UI.gradient : UI.cardElev, color: "#fff", opacity: canApply ? 1 : 0.5 }}>
          {mode === "replace" ? tr("studioModals.product.replaceProducts") : tr("studioModals.product.addProducts")}
        </button>
      </>}>
      <label style={labelStyle}>{tr("studioModals.product.productUrls")}</label>
      {urls.map((u, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input data-testid="batch-edit-product-url-input" value={u} placeholder="https://store.example.com/product"
            onChange={e => setUrls(prev => prev.map((x, xi) => xi === i ? e.target.value : x))} style={inputStyle} />
          {urls.length > 1 && (
            <button type="button" onClick={() => setUrls(prev => prev.filter((_, xi) => xi !== i))} style={{ ...btnBase, padding: "0 10px" }}><X style={{ width: 13, height: 13 }} /></button>
          )}
        </div>
      ))}
      <button type="button" data-testid="batch-edit-add-product-url" onClick={() => setUrls(prev => [...prev, ""])}
        style={{ background: "none", border: "none", padding: 0, fontSize: 11.5, fontWeight: 700, color: "#A78BFA", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Plus style={{ width: 13, height: 13 }} /> {tr("studioModals.product.addAnotherUrl")}
      </button>

      <p style={{ ...labelStyle, marginTop: 16 }}>{tr("studioModals.product.mode")}</p>
      <label data-testid="batch-edit-product-mode-add" style={{ display: "flex", gap: 10, marginBottom: 9, cursor: "pointer", alignItems: "center" }}>
        <input type="radio" name="prod-mode" checked={mode === "add"} onChange={() => setMode("add")} style={{ accentColor: UI.purple }} />
        <span style={{ fontSize: 12, color: UI.text }}>{tr("studioModals.product.addToExisting")}</span>
      </label>
      <label data-testid="batch-edit-product-mode-replace" style={{ display: "flex", gap: 10, marginBottom: 4, cursor: "pointer", alignItems: "center" }}>
        <input type="radio" name="prod-mode" checked={mode === "replace"} onChange={() => setMode("replace")} style={{ accentColor: UI.purple }} />
        <span style={{ fontSize: 12, color: UI.text }}>{tr("studioModals.product.replaceAll")}</span>
      </label>

      {mode === "add" && cleaned.length <= 1 && (
        <label style={{ display: "flex", gap: 9, marginTop: 12, cursor: "pointer", alignItems: "center", fontSize: 11.5, color: UI.text }}>
          <input type="checkbox" checked={setPrimary} onChange={e => setSetPrimary(e.target.checked)} style={{ accentColor: UI.purple }} />
          {tr("studioModals.product.setAsPrimary")}
        </label>
      )}
      {cleaned.length > 1 && (
        <p style={{ margin: "12px 0 0", fontSize: 10.5, color: UI.textSec }}>{tr("studioModals.product.firstBecomesPrimary")}</p>
      )}
      <p style={{ margin: "14px 0 0", fontSize: 10.5, color: UI.textMuted, lineHeight: 1.5, padding: "8px 10px", borderRadius: 8, background: UI.purpleSoft, border: `1px solid ${UI.border}` }}>
        {tr("studioModals.product.linkedNotDestination")}
      </p>
    </Modal>
  );
}

// Per-row quick product add.
function ProductQuickAdd({ title, current, onApply, onClose }: {
  title: string;
  current: PinProductsEdit;
  onApply: (next: PinProductsEdit) => void;
  onClose: () => void;
}) {
  const { t: tr } = useLocale();
  const [url, setUrl] = useState("");
  const [primary, setPrimary] = useState(!current.primary);
  return (
    <Modal title={title} width={400} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} style={btnBase}>{tr("common.cancel")}</button>
        <button type="button" disabled={!url.trim()} data-testid="batch-edit-product-quickadd-apply"
          onClick={() => { if (url.trim()) { onApply(applyProductAdd(current, linkedProductFromUrl(url.trim()), primary)); } }}
          style={{ ...btnBase, border: "none", background: url.trim() ? UI.gradient : UI.cardElev, color: "#fff", opacity: url.trim() ? 1 : 0.5 }}>{tr("studioModals.product.addProduct")}</button>
      </>}>
      <label style={labelStyle}>{tr("studioModals.product.productUrl")}</label>
      <input data-testid="batch-edit-product-quickadd-input" value={url} autoFocus placeholder="https://store.example.com/product" onChange={e => setUrl(e.target.value)} style={inputStyle} />
      <label style={{ display: "flex", gap: 9, marginTop: 12, cursor: "pointer", alignItems: "center", fontSize: 11.5, color: UI.text }}>
        <input type="checkbox" checked={primary} onChange={e => setPrimary(e.target.checked)} style={{ accentColor: UI.purple }} />
        {tr("studioModals.product.setAsPrimary")}
      </label>
      <p style={{ margin: "12px 0 0", fontSize: 10.5, color: UI.textMuted }}>{tr("studioModals.product.linkedToPinNotDestination")}</p>
    </Modal>
  );
}

// Lightweight popover listing every linked product + its link. Source-agnostic:
// Amazon products show the affiliate link, others show their product link.
function ProductLinksPopover({ products, affiliateUrl, onClose, onAdd, onManage }: {
  products: LinkedProduct[];
  affiliateUrl: string | null;
  onClose: () => void;
  onAdd: () => void;
  onManage: () => void;
}) {
  const { t: tr } = useLocale();
  return (
    <>
      <div onClick={e => { e.stopPropagation(); onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
      <div data-testid="batch-edit-product-popover" onClick={e => e.stopPropagation()} style={{
        position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 41, width: 300,
        background: UI.bg2, border: `1px solid ${UI.borderStr}`, borderRadius: 10,
        boxShadow: "0 12px 32px rgba(0,0,0,0.5)", padding: 6, maxHeight: 320, overflowY: "auto",
      }}>
        {products.map((p, i) => {
          const amazon = isAmazonProduct({ productUrl: p.productUrl, canonicalUrl: p.canonicalUrl, source: p.source, store: p.store });
          const link = resolveProductLinkDisplay({ productUrl: p.productUrl, canonicalUrl: p.canonicalUrl, source: p.source, store: p.store }, amazon ? affiliateUrl : null);
          const domain = linkDomain(p.productUrl) || p.store || "";
          return (
            <div key={productKey(p) || i} data-testid="batch-edit-popover-product" style={{ display: "flex", gap: 8, padding: "6px", borderRadius: 8, alignItems: "center" }}>
              <span style={{ width: 30, height: 30, borderRadius: 6, overflow: "hidden", flexShrink: 0, background: UI.bg, border: `1px solid ${UI.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                {p.imageUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={toProxyUrl(p.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <Package style={{ width: 13, height: 13, color: UI.textMuted }} />}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || tr("studioModals.product.productFallback")}</span>
                  {i === 0 && <span style={{ flexShrink: 0, fontSize: 8, fontWeight: 800, color: "#C4B5FD", background: UI.purpleSoft, padding: "1px 5px", borderRadius: 999 }}>{tr("pinDetails.products.primary")}</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 1 }}>
                  {amazon
                    ? <span style={{ flexShrink: 0, fontSize: 8, fontWeight: 800, color: "#F59E0B", background: "rgba(245,158,11,0.14)", padding: "1px 5px", borderRadius: 999 }}>{tr("studioModals.product.amazon")}</span>
                    : domain ? <span style={{ flexShrink: 0, fontSize: 9, color: UI.textMuted }}>{domain}</span> : null}
                  {link.url
                    ? <a href={link.url} target="_blank" rel="noopener noreferrer" data-testid="batch-edit-popover-link" style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 600, color: "#60A5FA", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}><ExternalLink style={{ width: 9, height: 9 }} /> {link.label}</a>
                    : <span data-testid="batch-edit-popover-link" style={{ fontSize: 9.5, color: UI.textMuted }}>{link.label}</span>}
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 6, marginTop: 4, paddingTop: 6, borderTop: `1px solid ${UI.border}` }}>
          <button type="button" data-testid="batch-edit-popover-add" onClick={() => { onAdd(); onClose(); }}
            style={{ flex: 1, ...btnBase, justifyContent: "center", fontSize: 10.5 }}><Plus style={{ width: 12, height: 12 }} /> {tr("studioModals.product.addProduct")}</button>
          <button type="button" onClick={() => { onManage(); onClose(); }}
            style={{ flex: 1, ...btnBase, justifyContent: "center", fontSize: 10.5 }}>{tr("studioModals.product.manage")}</button>
        </div>
      </div>
    </>
  );
}

// ── Column model ──────────────────────────────────────────────────────────────

type ColId = "check" | "pin" | "dest" | "title" | "desc" | "board" | "alt" | "product" | "time" | "plan" | "more";
const DEFAULT_W: Record<ColId, number> = {
  check: 34, pin: 56, dest: 180, title: 190, desc: 230, board: 150, alt: 190, product: 190, time: 150, plan: 110, more: 44,
};

// ── Main component ────────────────────────────────────────────────────────────

type BulkKind = null | "destination" | "board" | "schedule" | "product";
type PublishPhase = null | "confirm" | "blocked" | "running" | "done";
type PublishResultRow = { pinId: string; title: string; status: "published" | "failed" | "skipped"; message?: string; url?: string };

export function BatchEditDrawer({ open, pins, onClose, onApply, onGenerateMetadata, source = "history", onPublishComplete, onScheduleSelected, initialFilter = "all" }: BatchEditDrawerProps) {
  const { t: tr } = useLocale();
  const [rowEdits,    setRowEdits]    = useState<Record<string, RowEdit>>({});
  const [checkedRows, setCheckedRows] = useState<Set<string>>(new Set());
  const [search,      setSearch]      = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | PlanLabel>("all");
  const [boardFilter, setBoardFilter] = useState<string>("all");
  const [bulk,        setBulk]        = useState<BulkKind>(null);
  const [confirm,     setConfirm]     = useState<ConfirmState | null>(null);
  const [drawerPinId, setDrawerPinId] = useState<string | null>(null);
  const [drawerTab,   setDrawerTab]   = useState<"details" | "products">("details");
  const [quickAddPinId, setQuickAddPinId] = useState<string | null>(null);
  const [productPopoverPinId, setProductPopoverPinId] = useState<string | null>(null);
  const [colW,        setColW]        = useState<Record<ColId, number>>({ ...DEFAULT_W });
  // ONE shared boards data layer (same hook as Create Pins) — no bespoke fetch loop.
  // The states stay distinct: not connected ≠ reconnect ≠ API failure ≠ loaded.
  const {
    boards,
    loading: boardsLoading,
    disconnected: boardsDisconnected,
    needsReconnect: boardsNeedReconnect,
    error: boardsErr,
  } = usePinterestBoards();
  const boardsStatus: BoardsState["status"] =
    boardsLoading ? "loading"
    : boardsDisconnected ? "not_connected"
    : boardsNeedReconnect ? "reconnect"
    : boardsErr ? "error"
    : "ready";
  const [publishPhase,    setPublishPhase]    = useState<PublishPhase>(null);
  const [publishBlocked,  setPublishBlocked]  = useState<{ pinId: string; title: string; missing: string[] }[]>([]);
  const [publishProgress, setPublishProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [publishResults,  setPublishResults]  = useState<PublishResultRow[]>([]);
  // AI Copy batch generation — per-pin, sequential, with progress + summary.
  const [genProgress, setGenProgress] = useState<{ current: number; total: number; failed: number } | null>(null);

  const boardsState: BoardsState = { boards, status: boardsStatus };
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeRef = useRef<{ id: ColId; startX: number; startW: number } | null>(null);

  const persist = useCallback((edits: Record<string, RowEdit>) => { onApply({ rowEdits: edits }); }, [onApply]);

  // Column resize (drag handles on headers).
  useEffect(() => {
    function move(e: MouseEvent) {
      const r = resizeRef.current; if (!r) return;
      const dx = e.clientX - r.startX;
      setColW(prev => ({ ...prev, [r.id]: Math.max(60, r.startW + dx) }));
    }
    function up() { resizeRef.current = null; document.body.style.cursor = ""; }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);
  function startResize(e: React.MouseEvent, id: ColId) {
    e.preventDefault(); e.stopPropagation();
    resizeRef.current = { id, startX: e.clientX, startW: colW[id] };
    document.body.style.cursor = "col-resize";
  }

  const pinIdsKey = pins.map(p => p.pinId).join("|");
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setRowEdits({});
    setCheckedRows(new Set(pins.map(p => p.pinId)));
    setBulk(null);
    setConfirm(null);
    setDrawerPinId(null);
    setQuickAddPinId(null);
    setSearch("");
    setStatusFilter("all");
    setBoardFilter("all");
    setPublishPhase(null);
    setPublishResults([]);
    setPublishBlocked([]);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pinIdsKey]);

  // Single layered-dismiss used by BOTH Escape and the browser Back button, so
  // the two stay in sync. Closes the innermost open layer first and returns
  // `true` only when the whole Batch Edit workspace closed (Back is then not
  // re-armed). A ref keeps the latest closure without re-subscribing listeners.
  const dismissRef = useRef<() => boolean>(() => false);
  useEffect(() => {
    dismissRef.current = () => {
      if (confirm)       { setConfirm(null);       return false; }
      if (quickAddPinId) { setQuickAddPinId(null);  return false; }
      if (bulk)          { setBulk(null);           return false; }
      if (publishPhase && publishPhase !== "running") { setPublishPhase(null); return false; }
      if (drawerPinId)   { setDrawerPinId(null);    return false; }
      onClose();
      return true;
    };
  });

  // Browser / hardware Back closes the current layer and STAYS on the entry page
  // (Create Pins → Create Pins, Weekly Plan → Weekly Plan) instead of navigating
  // to whatever page preceded it. See useBackButtonClose for the mechanism.
  useBackButtonClose(open, () => dismissRef.current());

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      dismissRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ── VibePin assistant: publish the Batch Edit context (real batch review) ───────
  // Findings derive from the live pins + rowEdits and recompute whenever either
  // changes, so action closures never go stale. Board-suggestion / URL-fill actions
  // are preview-gated and only offered when a safe fix is unambiguous.
  const assistantBatchContext = useMemo<AssistantContext>(() => {
    const boardNames = boards.map((b) => b.name).filter(Boolean);
    const titleOf = (p: BatchPinRow) => getVal(p, rowEdits, "title") || p.title || "Untitled Pin";

    const likes: BatchPinLike[] = pins.map((p) => {
      const board = effBoard(p, rowEdits);
      const primary = effProducts(p, rowEdits).primary;
      return {
        id:             p.pinId,
        title:          getVal(p, rowEdits, "title"),
        description:    getVal(p, rowEdits, "description"),
        boardId:        board.id,
        boardName:      board.name,
        destinationUrl: getVal(p, rowEdits, "destinationUrl"),
        imageUrl:       p.imageUrl,
        hasProduct:     !!primary,
        productUrl:     primary?.productUrl ?? "",
        isAffiliate:    primary ? isAmazonProduct(primary) : false,
        plannedDate:    getVal(p, rowEdits, "plannedDate"),
      };
    });

    const report = detectBatch(likes);

    // Board plan: only pins with no board AND a confidently-matched REAL board.
    const boardPlan = () =>
      pins
        .filter((p) => !effBoard(p, rowEdits).id)
        .map((p) => {
          const name = recommendRealBoard(boardNames, { category: p.category, topic: titleOf(p) });
          const b = name ? boards.find((bb) => bb.name === name) : null;
          return b ? { pin: p, boardId: b.id, boardName: b.name } : null;
        })
        .filter((x): x is { pin: BatchPinRow; boardId: string; boardName: string } => !!x);

    // URL plan: only pins missing a URL that have an unambiguous product URL to reuse.
    const urlPlan = () =>
      pins
        .filter((p) => !getVal(p, rowEdits, "destinationUrl").trim())
        .map((p) => {
          const url = effProducts(p, rowEdits).primary?.productUrl?.trim();
          return url ? { pin: p, url } : null;
        })
        .filter((x): x is { pin: BatchPinRow; url: string } => !!x);

    const handlers: BatchHandlers = {
      previewSuggestBoards: () => {
        const plan = boardPlan();
        if (!plan.length) return null;
        const changes: PreviewChange[] = plan.map((x) => ({ label: titleOf(x.pin), before: tr("studioModals.assistant.noBoard"), after: x.boardName }));
        return { title: tr("studioModals.assistant.suggestBoards"), changes, note: tr("studioModals.assistant.suggestBoardsNote") } satisfies AssistantPreview;
      },
      applySuggestBoards: () => {
        const plan = boardPlan();
        plan.forEach((x) => patchRow(x.pin.pinId, { boardId: x.boardId, boardName: x.boardName }));
        if (plan.length) toast.success(plan.length === 1 ? tr("studioModals.assistant.assignedBoardsOne") : tr("studioModals.assistant.assignedBoardsMany").replace("{n}", String(plan.length)));
      },
      previewFillUrls: () => {
        const plan = urlPlan();
        if (!plan.length) return null;
        const changes: PreviewChange[] = plan.map((x) => ({ label: titleOf(x.pin), before: "", after: x.url }));
        return { title: tr("studioModals.assistant.fillMissingUrls"), changes, note: tr("studioModals.assistant.fillMissingUrlsNote") } satisfies AssistantPreview;
      },
      applyFillUrls: () => {
        const plan = urlPlan();
        plan.forEach((x) => patchRow(x.pin.pinId, { destinationUrl: x.url }));
        if (plan.length) toast.success(plan.length === 1 ? tr("studioModals.assistant.filledUrlsOne") : tr("studioModals.assistant.filledUrlsMany").replace("{n}", String(plan.length)));
      },
    };

    return {
      id: "batch-edit",
      source: "modal",
      kind: "batch-edit",
      label: tr("studioModals.assistant.batchEdit"),
      summary: pins.length === 1 ? tr("studioModals.assistant.pinsSelectedOne") : tr("studioModals.assistant.pinsSelectedMany").replace("{n}", String(pins.length)),
      greeting: tr("studioModals.assistant.greeting"),
      examplePrompts: [tr("studioModals.assistant.reviewTitles"), tr("studioModals.assistant.suggestBoards"), tr("studioModals.assistant.checkSchedule")],
      tone: "detected",
      findings: buildBatchFindings(report, handlers),
      footerOffset: 72,
    };
    // patchRow is a hoisted, stable component function; deps below drive recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, rowEdits, boards, tr]);
  usePublishAssistantContext(assistantBatchContext, open, [assistantBatchContext]);

  if (!open) return null;

  const checkedCount = checkedRows.size;
  const allChecked   = checkedCount === pins.length && pins.length > 0;
  const checkedPins  = pins.filter(p => checkedRows.has(p.pinId));

  function commit(next: Record<string, RowEdit>) { setRowEdits(next); persist(next); }
  function patchRow(pinId: string, patch: RowEdit, opts?: { debounce?: boolean }) {
    setRowEdits(prev => {
      const pin = pins.find(p => p.pinId === pinId);
      if (!pin) return prev;
      const nextEdit = { ...prev[pinId], ...patch };
      if ("plannedDate" in patch || "plannedTime" in patch) {
        const date = nextEdit.plannedDate ?? pin.plannedDate ?? "";
        const time = nextEdit.plannedTime ?? pin.plannedTime ?? "";
        nextEdit.plannedAt = combineLocalPlannedAt(date, time);
        if (!date) nextEdit.plannedTime = "";
      }
      const next = { ...prev, [pinId]: nextEdit };
      if (opts?.debounce) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => persist(next), 400);
      } else { persist(next); }
      return next;
    });
  }
  function patchProducts(pinId: string, products: PinProductsEdit) {
    setRowEdits(prev => { const next = { ...prev, [pinId]: { ...prev[pinId], products } }; persist(next); return next; });
  }

  /**
   * Generate AI Copy for each selected Pin using the SHARED generatePinterestPinCopy
   * helper — one call per Pin so each uses its OWN image analysis + recommended
   * keywords (resolved from the store by image). Sequential with progress. A failed
   * Pin keeps its existing fields and never blocks the rest. No overwrite of edits on
   * failed items. Ends with a "N updated, M failed" summary.
   */
  const handleGenerateCopyBatch = useCallback(async () => {
    if (genProgress) return;
    const targets = pins.filter(p => checkedRows.has(p.pinId));
    if (!targets.length) return;
    const language = readResolvedContentLanguage();
    setGenProgress({ current: 0, total: targets.length, failed: 0 });
    const next: Record<string, RowEdit> = { ...rowEdits };
    let updated = 0, failed = 0;
    let rateLimited = false;
    for (let i = 0; i < targets.length; i++) {
      const pin = targets[i];
      setGenProgress({ current: i + 1, total: targets.length, failed });
      try {
        const res = await generatePinterestPinCopy({
          draftId: pin.pinId,
          imageUrl: pin.imageUrl,
          title: getVal(pin, next, "title") || pin.title,
          description: getVal(pin, next, "description") || pin.description,
          boardId: pin.boardId,
          boardName: pin.boardName,
          category: pin.category,
          boards,
          language,
        });
        // Only succeeded Pins get their fields updated — failures are left untouched.
        next[pin.pinId] = {
          ...next[pin.pinId],
          title: res.fields.title,
          description: res.fields.description,
          altText: res.fields.altText,
        };
        updated++;
      } catch (err) {
        // 429 = the per-user AI cost ceiling. Stop the loop immediately: every
        // remaining Pin in this batch would get the same 429, so continuing would
        // just report N spurious "failed" rows. Pins already updated keep their copy.
        if (isRateLimitError(err)) { rateLimited = true; break; }
        failed++;
      }
    }
    commit(next);
    setGenProgress(null);
    // Rate limit is a "wait a moment", not a failure — neutral toast severity,
    // matching how /api/generate's user_generation_limit is surfaced in Studio.
    // Reuses the existing all-locale rate-limit strings.
    if (rateLimited) {
      toast.message(tr("history.error.rateLimited.label"), { description: tr("studio.error.serviceBusy.body") });
      if (updated) toast.success(tr("studioModals.genCopy.updated").replace("{n}", String(updated)));
    }
    else if (updated && failed) toast.error(tr("studioModals.genCopy.updatedAndFailed").replace("{updated}", String(updated)).replace("{failed}", String(failed)));
    else if (updated) toast.success(tr("studioModals.genCopy.updated").replace("{n}", String(updated)));
    else toast.error(tr("studioModals.genCopy.failedCount").replace("{n}", String(failed)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genProgress, pins, checkedRows, rowEdits, boards, tr]);

  function toggleCheck(pinId: string) {
    setCheckedRows(prev => { const n = new Set(prev); if (n.has(pinId)) n.delete(pinId); else n.add(pinId); return n; });
  }

  // ── Bulk apply with Undo ──────────────────────────────────────────────────
  function bulkSetField(field: ApplyFieldKey, value: string, predicate?: (p: BatchPinRow) => boolean) {
    const affected: { pinId: string; original: string }[] = [];
    const next = { ...rowEdits };
    for (const pinId of checkedRows) {
      const p = pins.find(x => x.pinId === pinId);
      if (!p) continue;
      if (predicate && !predicate(p)) continue;
      affected.push({ pinId, original: getVal(p, rowEdits, field) });
      const edit = { ...next[pinId], [field]: value } as RowEdit;
      if (field === "plannedDate" || field === "plannedTime") {
        const date = field === "plannedDate" ? value : (edit.plannedDate ?? p.plannedDate ?? "");
        const time = field === "plannedTime" ? value : (edit.plannedTime ?? p.plannedTime ?? "");
        edit.plannedAt = combineLocalPlannedAt(date, time);
      }
      next[pinId] = edit;
    }
    return { next, affected };
  }
  function undoFieldToast(label: string, field: ApplyFieldKey, affected: { pinId: string; original: string }[]) {
    if (affected.length === 0) { toast.info(tr("studioModals.noPinsChanged")); return; }
    toast.success((affected.length === 1 ? tr("studioModals.fieldAppliedToOne") : tr("studioModals.fieldAppliedToMany").replace("{n}", String(affected.length))).replace("{label}", label), {
      action: { label: tr("studioModals.undo"), onClick: () => {
        setRowEdits(prev => {
          const n = { ...prev };
          for (const a of affected) n[a.pinId] = { ...n[a.pinId], [field]: a.original };
          persist(n);
          return n;
        });
      } },
    });
  }

  function applyBulkDestination(url: string, mode: "fill_empty" | "replace" | "product" | "clear") {
    // Set each selected Pin's Website URL to its own primary product URL, where one
    // exists. Never fails the whole batch — Pins without a product URL are left as-is.
    if (mode === "product") {
      const affected: { pinId: string; original: string }[] = [];
      let missing = 0;
      const next = { ...rowEdits };
      for (const pinId of checkedRows) {
        const p = pins.find(x => x.pinId === pinId); if (!p) continue;
        const productUrl = effProducts(p, rowEdits).primary?.productUrl?.trim();
        if (!productUrl) { missing++; continue; }
        affected.push({ pinId, original: getVal(p, rowEdits, "destinationUrl") });
        next[pinId] = { ...next[pinId], destinationUrl: productUrl };
      }
      commit(next);
      if (affected.length === 0) {
        toast.info(tr("studioModals.dest.noneHaveProductUrl"));
      } else {
        const msg = missing > 0
          ? tr("studioModals.dest.appliedWhereAvailable")
          : (affected.length === 1 ? tr("studioModals.dest.productUrlAppliedToOne") : tr("studioModals.dest.productUrlAppliedToMany").replace("{n}", String(affected.length)));
        toast.success(msg, {
          action: { label: tr("studioModals.undo"), onClick: () => {
            setRowEdits(prev => { const n = { ...prev }; for (const a of affected) n[a.pinId] = { ...n[a.pinId], destinationUrl: a.original }; persist(n); return n; });
          } },
        });
      }
      setBulk(null);
      return;
    }
    // Clear the Website URL on every selected Pin (publishing is still allowed).
    if (mode === "clear") {
      setConfirm({
        title: tr("studioModals.dest.clearConfirmTitle"),
        body: <>{tr("studioModals.dest.clearConfirmBody")}<br /><span style={{ color: UI.textMuted }}>{tr("studioModals.dest.productUrlsNotChanged")}</span></>,
        confirmLabel: tr("studioModals.dest.clearUrls"), danger: true, onConfirm: () => {
          const { next, affected } = bulkSetField("destinationUrl", "");
          commit(next);
          if (affected.length === 0) { toast.info(tr("studioModals.noPinsChanged")); }
          else toast.success(affected.length === 1 ? tr("studioModals.dest.clearedToOne") : tr("studioModals.dest.clearedToMany").replace("{n}", String(affected.length)), {
            action: { label: tr("studioModals.undo"), onClick: () => {
              setRowEdits(prev => { const n = { ...prev }; for (const a of affected) n[a.pinId] = { ...n[a.pinId], destinationUrl: a.original }; persist(n); return n; });
            } },
          });
          setBulk(null);
        },
      });
      return;
    }
    const run = () => {
      const { next, affected } = bulkSetField("destinationUrl", url, mode === "fill_empty" ? (p => !getVal(p, rowEdits, "destinationUrl").trim()) : undefined);
      commit(next);
      undoFieldToast(tr("pinDetails.websiteUrl"), "destinationUrl", affected);
      setBulk(null);
    };
    if (mode === "replace") {
      setConfirm({
        title: tr("studioModals.dest.replaceConfirmTitle"),
        body: <>{tr("studioModals.dest.replaceConfirmBody")}<br /><span style={{ color: UI.textMuted }}>{tr("studioModals.dest.productUrlsNotChanged")}</span></>,
        confirmLabel: tr("studioModals.dest.replaceExisting"), danger: true, onConfirm: run,
      });
    } else run();
  }

  function applyBulkBoard(b: { id: string; name: string }) {
    // Capture BOTH the effective id and name before the change (not just id) — a
    // second bulk-board-apply layered on top of a first one must undo back to
    // whatever board was effective a moment ago (which may itself already be a
    // session edit), never fall back to the pin's originally-persisted boardName.
    // Restoring id+name from mismatched sources previously showed the correct
    // boardId with the wrong (stale/original) boardName after Undo.
    const affected: { pinId: string; original: string; originalName: string }[] = [];
    const next = { ...rowEdits };
    for (const pinId of checkedRows) {
      const p = pins.find(x => x.pinId === pinId); if (!p) continue;
      const eff = effBoard(p, rowEdits);
      affected.push({ pinId, original: eff.id, originalName: eff.name });
      next[pinId] = { ...next[pinId], boardId: b.id, boardName: b.name };
    }
    commit(next);
    if (affected.length) {
      toast.success(affected.length === 1 ? tr("studioModals.board.appliedToOne") : tr("studioModals.board.appliedToMany").replace("{n}", String(affected.length)), {
        action: { label: tr("studioModals.undo"), onClick: () => {
          setRowEdits(prev => {
            const n = { ...prev };
            for (const a of affected) { n[a.pinId] = { ...n[a.pinId], boardId: a.original, boardName: a.originalName }; }
            persist(n); return n;
          });
        } },
      });
    }
    setBulk(null);
  }

  function applyBulkSchedule(date: string, time: string) {
    const { next, affected } = bulkSetField("plannedDate", date);
    const next2 = { ...next };
    for (const pinId of checkedRows) {
      const p = pins.find(x => x.pinId === pinId); if (!p) continue;
      next2[pinId] = { ...next2[pinId], plannedTime: time, plannedAt: combineLocalPlannedAt(date, time) };
    }
    commit(next2);
    undoFieldToast(tr("studioModals.schedule.publishDate"), "plannedDate", affected);
    setBulk(null);
  }

  function resolveProductFromUrl(url: string): LinkedProduct {
    const norm = normalizeProductUrl(url);
    if (norm) {
      for (const p of checkedPins) {
        const { primary, tagged } = effProducts(p, rowEdits);
        const all = [primary, ...tagged, ...(p.setupProducts ?? []).map(sp => ({ productUrl: sp.productUrl ?? "", title: sp.title, imageUrl: sp.imageUrl ?? undefined, source: normalizeProductSource(sp.source), linkType: "manual" as const } as LinkedProduct))];
        const match = all.find(x => x && normalizeProductUrl(x.productUrl ?? "") === norm);
        if (match) return { ...match, linkType: "manual" };
      }
    }
    return linkedProductFromUrl(url);
  }

  function applyBulkProductAdd(urls: string[], primaryIdx: number) {
    const products = urls.map(resolveProductFromUrl);
    const snapshot = { ...rowEdits };
    const next = { ...rowEdits };
    let changed = 0;
    for (const pinId of checkedRows) {
      const p = pins.find(x => x.pinId === pinId); if (!p) continue;
      const eff = effProducts(p, next);
      let cur: PinProductsEdit = { primary: eff.primary, tagged: eff.tagged };
      products.forEach((lp, i) => { cur = applyProductAdd(cur, lp, i === primaryIdx); });
      next[pinId] = { ...next[pinId], products: { primary: cur.primary, tagged: cur.tagged } };
      changed++;
    }
    commit(next);
    toast.success(changed === 1 ? tr("studioModals.product.addedToOne") : tr("studioModals.product.addedToMany").replace("{n}", String(changed)), { action: { label: tr("studioModals.undo"), onClick: () => commit(snapshot) } });
    setBulk(null);
  }
  function applyBulkProductReplace(urls: string[]) {
    setConfirm({
      title: checkedCount === 1 ? tr("studioModals.product.replaceConfirmTitleOne") : tr("studioModals.product.replaceConfirmTitleMany").replace("{n}", String(checkedCount)),
      body: <>{tr("studioModals.product.replaceConfirmBody")}<br /><span style={{ color: UI.textMuted }}>{tr("studioModals.product.destUrlNotChanged")}</span></>,
      confirmLabel: tr("studioModals.product.replaceProducts"), danger: true,
      onConfirm: () => {
        const products = urls.map(resolveProductFromUrl);
        const snapshot = { ...rowEdits };
        const next = { ...rowEdits };
        let changed = 0;
        for (const pinId of checkedRows) {
          if (!pins.find(x => x.pinId === pinId)) continue;
          next[pinId] = { ...next[pinId], products: { primary: products[0] ?? null, tagged: products.slice(1) } };
          changed++;
        }
        commit(next);
        toast.success(changed === 1 ? tr("studioModals.product.replacedOnOne") : tr("studioModals.product.replacedOnMany").replace("{n}", String(changed)), { action: { label: tr("studioModals.undo"), onClick: () => commit(snapshot) } });
        setBulk(null);
      },
    });
  }

  function fillEmptyDestFromPrimary() {
    const snapshot = { ...rowEdits };
    const next = { ...rowEdits };
    let filled = 0, skipped = 0;
    for (const pinId of checkedRows) {
      const p = pins.find(x => x.pinId === pinId); if (!p) continue;
      const purl = effProducts(p, next).primary?.productUrl;
      if (!purl) { skipped++; continue; }
      if (getVal(p, next, "destinationUrl").trim()) { skipped++; continue; }
      next[pinId] = { ...next[pinId], destinationUrl: purl };
      filled++;
    }
    commit(next);
    toast.success(tr("studioModals.dest.filledSkipped").replace("{filled}", String(filled)).replace("{skipped}", String(skipped)), { action: { label: tr("studioModals.undo"), onClick: () => commit(snapshot) } });
  }

  // ── Schedule (no readiness gate; parent assigns the next Smart Schedule slot) ──
  function scheduleSelected() {
    if (!checkedCount || !onScheduleSelected) return;
    onScheduleSelected([...checkedRows]);
  }

  // ── Publish now ──────────────────────────────────────────────────────────
  // Publishes selected Pins immediately. This is NOT scheduling — it never sets or
  // changes a schedule time; it triggers publishing and marks Pins published.
  function startPublish() {
    if (!checkedPins.length) return;
    // Access guard: publishing needs a usable Pinterest connection.
    if (boardsStatus === "not_connected") {
      toast.error(tr("studioModals.publish.connectBeforePublish"));
      return;
    }
    if (boardsStatus === "reconnect") {
      toast.error(tr("studioModals.publish.connectionExpired"));
      return;
    }
    const blocked = checkedPins
      .map(p => ({ pinId: p.pinId, title: getVal(p, rowEdits, "title") || p.title || tr("studioModals.untitledPin"), missing: pubBlockingLabels(p, rowEdits) }))
      .filter(b => b.missing.length > 0);
    // Some selected Pins are incomplete → validation summary (never silently skip).
    if (blocked.length) { setPublishBlocked(blocked); setPublishPhase("blocked"); return; }
    // All ready → confirm immediate publish (irreversible; not a schedule change).
    setPublishPhase("confirm");
  }
  async function runPublish(targets: BatchPinRow[]) {
    setPublishResults([]);
    setPublishProgress({ current: 0, total: targets.length });
    setPublishPhase("running");
    const results: PublishResultRow[] = [];
    const publishedIds: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      setPublishProgress({ current: i + 1, total: targets.length });
      const input = pubReadinessInput(p, rowEdits);
      const title = input.title || p.title || tr("studioModals.untitledPin");
      if (!isPinReady(input)) { results.push({ pinId: p.pinId, title, status: "skipped", message: tr("studioModals.publish.missingRequiredDetails") }); continue; }
      const lenErrors = pinFieldErrors(input);
      if (lenErrors.title || lenErrors.description) { results.push({ pinId: p.pinId, title, status: "skipped", message: lenErrors.title || lenErrors.description }); continue; }
      // Shared in-flight lock (StudioBoard.tsx's card publish uses the same registry) —
      // skip a pin that's already being published from another surface rather than
      // double-submitting it.
      if (!beginPublish(p.pinId)) { results.push({ pinId: p.pinId, title, status: "skipped", message: tr("studioModals.publish.alreadyPublishing") }); continue; }
      try {
        const res = await publishPin({
          boardId: effBoard(p, rowEdits).id, imageUrl: p.imageUrl,
          title: input.title || undefined, description: input.description || undefined,
          link: input.destinationUrl || undefined, altText: input.altText || undefined,
          sourcePinId: p.pinId,
          // p.pinId is the pinDraftStore draft id in the Weekly-Plan context (joins to a
          // draft) but NOT in the Studio context — draftId is best-effort, so a non-draft
          // id simply won't join downstream. source is the immediate batch publish.
          draftId: p.pinId, source: "immediate",
        });
        results.push({ pinId: p.pinId, title, status: "published", url: res.pin.url });
        publishedIds.push(p.pinId);
      } catch (e) {
        const err = e as PinterestClientError;
        results.push({ pinId: p.pinId, title, status: "failed", message: err?.message ?? tr("studioModals.publish.publishFailed") });
        // Persist the failure so a batch-published Pin that fails is truthfully shown
        // as "failed" (not still Scheduled) and survives reload (PRD WP-B §11.5). In the
        // Weekly Plan context p.pinId is the pinDraftStore draft id; in the Studio
        // context it isn't, so updateDraft is a harmless no-op there (returns null).
        const prev = pinDraftStore.getDraft(p.pinId);
        pinDraftStore.updateDraft(p.pinId, {
          publishError: err?.message || "Publish failed",
          failureType: "publish",
          errorCategory: mapPublishErrorToCategory(err?.code, err?.message),
          publishErrorCode: err?.code,
          previousScheduledTime: prev?.plannedAt
            ? new Date(prev.plannedAt).toISOString()
            : (prev?.scheduledDate
                ? new Date(`${prev.scheduledDate}T${prev.scheduledTime?.trim() || "09:00"}:00`).toISOString()
                : undefined),
          scheduledDate: "",
          scheduledTime: "",
        });
      } finally {
        endPublish(p.pinId);
      }
    }
    setPublishResults(results);
    setPublishPhase("done");
    // Summarize the outcome as a toast (in addition to the per-Pin results modal).
    const pubCount = results.filter(r => r.status === "published").length;
    const failCount = results.filter(r => r.status === "failed").length;
    if (pubCount > 0 && failCount === 0) {
      toast.success(tr("studioModals.publish.selectedPublished"));
    } else if (pubCount > 0 && failCount > 0) {
      toast.error(tr("studioModals.publish.partialPublished").replace("{pub}", String(pubCount)).replace("{fail}", String(failCount)));
    } else if (failCount > 0) {
      toast.error(tr("studioModals.publish.failedTryAgain"));
    }
    // Published Pins are removed from the queue by the parent via this callback
    // (status → published; scheduled/unscheduled + counts refresh).
    if (publishedIds.length) onPublishComplete?.(publishedIds);
  }
  const publishReadyCount = checkedPins.filter(p => isPinReady(pubReadinessInput(p, rowEdits))).length;

  // ── Filtering ────────────────────────────────────────────────────────────
  const visiblePins = pins.filter(p => {
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${getVal(p, rowEdits, "title")} ${getVal(p, rowEdits, "destinationUrl")} ${effBoard(p, rowEdits).name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (statusFilter !== "all" && planLabel(p, rowEdits) !== statusFilter) return false;
    if (boardFilter !== "all" && effBoard(p, rowEdits).name !== boardFilter) return false;
    return true;
  });
  const boardNames = Array.from(new Set(pins.map(p => effBoard(p, rowEdits).name).filter(Boolean)));

  const drawerPin = drawerPinId ? pins.find(p => p.pinId === drawerPinId) ?? null : null;
  const quickAddPin = quickAddPinId ? pins.find(p => p.pinId === quickAddPinId) ?? null : null;
  function openDrawer(pinId: string, tab: "details" | "products" = "details") { setDrawerPinId(pinId); setDrawerTab(tab); }

  // Column order — Pin preview near the left; Plan is the canonical planning column.
  const cols: { id: ColId; label: string }[] = [
    { id: "check", label: "" }, { id: "pin", label: tr("studioModals.col.pin") },
    { id: "dest", label: tr("studioModals.col.destinationUrl") }, { id: "title", label: tr("pinDetails.title.label") }, { id: "desc", label: tr("studioModals.col.description") },
    { id: "board", label: tr("studioModals.col.board") }, { id: "alt", label: tr("studioModals.col.altText") }, { id: "product", label: tr("studioModals.col.product") },
    { id: "time", label: tr("studioModals.col.publishTime") }, { id: "plan", label: tr("studioModals.col.plan") }, { id: "more", label: "" },
  ];
  const tableWidth = cols.reduce((s, c) => s + colW[c.id], 0);

  const th: React.CSSProperties = { padding: "8px 10px", fontSize: 9.5, fontWeight: 700, color: UI.textSec, textAlign: "left", background: UI.bg2, borderBottom: `1px solid ${UI.borderStr}`, whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: "0.03em", position: "relative" };
  const td: React.CSSProperties = { padding: "4px 6px", verticalAlign: "middle", borderBottom: `1px solid ${UI.border}`, fontSize: 11.5, color: UI.text };
  const cellBtn: React.CSSProperties = { background: "none", border: "none", padding: "5px 7px", cursor: "pointer", color: UI.text, fontSize: 11.5, textAlign: "left", fontFamily: "inherit", width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  const cellMuted: React.CSSProperties = { ...cellBtn, color: UI.textMuted };

  return (
    <>
      {/* Fullscreen workspace — fills the content area beside the (undimmed) sidebar.
          No dark backdrop, no drawer shadow: this is a workspace, not a right drawer. */}
      <div data-testid="batch-edit-root" style={{ position: "fixed", left: NAV_WIDTH, top: 0, right: 0, bottom: 0, zIndex: 199, background: UI.card, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Header — one primary CTA (Schedule), quiet Publish now, quiet X close. */}
        <header style={{ padding: "14px 22px", borderBottom: `1px solid ${UI.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: UI.text }}>{tr("studioModals.header.title")}</h2>
              <p style={{ margin: "2px 0 0", fontSize: 11.5, color: UI.textSec }}>{tr("studioModals.header.subtitle")}</p>
            </div>
            {checkedCount > 0 && (
              <span data-testid="batch-edit-selected-count" style={{
                flexShrink: 0, padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
                color: UI.textSec, background: UI.bg2, border: `1px solid ${UI.border}`,
              }}>
                {tr("studioModals.selectedCount").replace("{n}", String(checkedCount))}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <button type="button" data-testid="batch-edit-schedule-selected" disabled={checkedCount === 0 || publishPhase === "running"} onClick={scheduleSelected}
              style={{ ...btnBase, border: "none", background: checkedCount > 0 ? UI.gradient : UI.cardElev, color: "#fff", opacity: (checkedCount > 0 && publishPhase !== "running") ? 1 : 0.55, padding: "8px 18px", fontWeight: 700 }}>
              <CalendarClock style={{ width: 14, height: 14 }} /> {tr("studioModals.header.schedule")}
            </button>
            {checkedCount > 0 && (
              <button type="button" data-testid="batch-edit-publish-now" disabled={publishPhase === "running"} onClick={startPublish}
                style={{ ...btnBase, padding: "8px 14px", opacity: publishPhase === "running" ? 0.6 : 1, cursor: publishPhase === "running" ? "not-allowed" : "pointer" }}>
                <Send style={{ width: 13, height: 13 }} /> {publishPhase === "running" ? tr("studioModals.header.publishing") : tr("studioModals.header.publishSelectedNow")}
              </button>
            )}
            <button type="button" data-testid="batch-edit-close" title={tr("pinDetails.close")} aria-label={tr("pinDetails.close")} onClick={onClose}
              style={{ background: "none", border: "none", cursor: "pointer", color: UI.textMuted, padding: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 8, flexShrink: 0 }}>
              <X style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </header>

        {/* Adaptive toolbar */}
        {checkedCount === 0 ? (
          <div data-testid="batch-edit-default-toolbar" style={{ padding: "8px 22px", borderBottom: `1px solid ${UI.border}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0, background: UI.bg2 }}>
            <div style={{ position: "relative", flex: "0 0 220px", maxWidth: 260 }}>
              <Search style={{ width: 13, height: 13, color: UI.textMuted, position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
              <input data-testid="batch-edit-search" value={search} onChange={e => setSearch(e.target.value)} placeholder={tr("studioModals.toolbar.searchPins")}
                style={{ ...inputStyle, padding: "7px 10px 7px 30px", fontSize: 11.5 }} />
            </div>
            <span style={btnBase}><SlidersHorizontal style={{ width: 13, height: 13 }} /> {tr("studioModals.toolbar.filter")}</span>
            <select data-testid="batch-edit-plan-filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)} style={{ ...btnBase, paddingRight: 8 }}>
              <option value="all">{tr("studioModals.col.plan")}</option>
              <option value="Not planned">{tr(PLAN_LABEL_KEY["Not planned"])}</option>
              <option value="Planned">{tr(PLAN_LABEL_KEY["Planned"])}</option>
              <option value="Posted">{tr(PLAN_LABEL_KEY["Posted"])}</option>
              <option value="Failed">{tr(PLAN_LABEL_KEY["Failed"])}</option>
            </select>
            <select data-testid="batch-edit-board-filter" value={boardFilter} onChange={e => setBoardFilter(e.target.value)} style={{ ...btnBase, paddingRight: 8, maxWidth: 160 }}>
              <option value="all">{tr("studioModals.col.board")}</option>
              {boardNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <div style={{ flex: 1 }} />
          </div>
        ) : (
          <div data-testid="batch-edit-selection-toolbar" style={{ padding: "8px 22px", borderBottom: `1px solid ${UI.border}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0, background: UI.bg2 }}>
            <span data-testid="batch-edit-selected-count" style={{ fontSize: 11.5, fontWeight: 700, color: "#C4B5FD", border: `1px solid ${UI.borderStr}`, borderRadius: 20, padding: "3px 11px" }}>{tr("studioModals.selectedCount").replace("{n}", String(checkedCount))}</span>
            <button type="button" data-testid="batch-edit-bulk-destination-url" onClick={() => setBulk("destination")} style={btnBase}><Link2 style={{ width: 13, height: 13 }} /> {tr("studioModals.col.destinationUrl")}</button>
            <button type="button" data-testid="batch-edit-bulk-board" onClick={() => setBulk("board")} style={btnBase}><Package style={{ width: 13, height: 13 }} /> {tr("studioModals.col.board")}</button>
            <button type="button" data-testid="batch-edit-bulk-product" onClick={() => setBulk("product")} style={btnBase}><Tag style={{ width: 13, height: 13 }} /> {tr("studioModals.col.product")}</button>
            <button type="button" data-testid="batch-edit-bulk-schedule" onClick={() => setBulk("schedule")} style={btnBase}><Calendar style={{ width: 13, height: 13 }} /> {tr("studioModals.col.publishTime")}</button>
            <button type="button" data-testid="batch-edit-bulk-generate-copy" onClick={handleGenerateCopyBatch} disabled={!!genProgress}
              style={{ ...btnBase, border: "none", background: UI.gradient, color: "#fff", opacity: genProgress ? 0.7 : 1 }}>
              {genProgress ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <Sparkles style={{ width: 13, height: 13 }} />}
              {genProgress ? tr("studioModals.toolbar.generatingCopy").replace("{current}", String(genProgress.current)).replace("{total}", String(genProgress.total)) : tr("studioModals.toolbar.generateCopy")}
            </button>
            <Dropdown align="left" width={260} trigger={() => <span data-testid="batch-edit-more-menu" style={btnBase}><MoreHorizontal style={{ width: 14, height: 14 }} /> {tr("studioModals.toolbar.more")}</span>}>
              {close => <>
                <MenuItem icon={<Sparkles style={{ width: 13, height: 13 }} />} label={tr("studioModals.toolbar.generateMissingDetails")} onClick={() => { close(); onGenerateMetadata(false); }} />
                <MenuItem icon={<Link2 style={{ width: 13, height: 13 }} />} label={tr("studioModals.toolbar.fillEmptyDestFromPrimary")} onClick={() => { close(); fillEmptyDestFromPrimary(); }} />
                <MenuItem icon={<X style={{ width: 13, height: 13 }} />} label={tr("studioModals.toolbar.removeFromSelection")} onClick={() => { close(); setCheckedRows(new Set()); }} />
              </>}
            </Dropdown>
            <div style={{ flex: 1 }} />
          </div>
        )}

        {/* Table + optional drawer */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "0 22px" }}>
            {pins.length === 0 ? (
              <div style={{ padding: 60, textAlign: "center", color: UI.textMuted }}>{tr("studioModals.empty.selectPins")}</div>
            ) : visiblePins.length === 0 ? (
              <div style={{ padding: 60, textAlign: "center", color: UI.textMuted }}>{tr("studioModals.empty.noPinsMatch")}</div>
            ) : (
              <table data-testid="batch-edit-table" style={{ width: tableWidth, borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>{cols.map(c => <col key={c.id} style={{ width: colW[c.id] }} />)}</colgroup>
                <thead>
                  <tr>
                    {cols.map(c => (
                      <th key={c.id} style={th}>
                        {c.id === "check"
                          ? <input type="checkbox" checked={allChecked} onChange={() => setCheckedRows(allChecked ? new Set() : new Set(visiblePins.map(p => p.pinId)))} style={{ accentColor: UI.purple }} />
                          : c.label}
                        {c.id !== "more" && (
                          <span onMouseDown={e => startResize(e, c.id)} style={{ position: "absolute", right: -3, top: 0, height: "100%", width: 7, cursor: "col-resize", zIndex: 3 }} />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visiblePins.map(p => {
                    const checked  = checkedRows.has(p.pinId);
                    const url      = getVal(p, rowEdits, "destinationUrl");
                    const board    = effBoard(p, rowEdits);
                    const date     = getVal(p, rowEdits, "plannedDate");
                    const time     = getVal(p, rowEdits, "plannedTime");
                    const { primary, tagged } = effProducts(p, rowEdits);
                    const prodCount = (primary ? 1 : 0) + tagged.length;
                    // Unified display context for the row (Amazon label + ASIN + affiliate URL).
                    const displayCtx = getPinDisplayContext({
                      productId:             primary?.productId,
                      linkedProductId:       primary?.productId,
                      linkedProductTitle:    primary?.title,
                      linkedProductImageUrl: primary?.imageUrl,
                      linkedProductUrl:      primary?.productUrl,
                      linkedProductSource:   primary?.source,
                      destinationUrl:        url,
                    });
                    const title    = getVal(p, rowEdits, "title");
                    const desc     = getVal(p, rowEdits, "description");
                    const alt      = getVal(p, rowEdits, "altText");
                    return (
                      <tr key={p.pinId} data-testid="batch-edit-row" style={{ background: checked ? UI.purpleSoft : "transparent" }}>
                        {cols.map(c => {
                          switch (c.id) {
                            case "check":
                              return <td key={c.id} style={td}><input type="checkbox" data-testid="batch-edit-row-checkbox" checked={checked} onChange={() => toggleCheck(p.pinId)} style={{ accentColor: UI.purple }} /></td>;
                            case "pin":
                              return (
                                <td key={c.id} style={td}>
                                  <button type="button" data-testid="batch-edit-pin-cell" onClick={() => openDrawer(p.pinId, "details")} title={tr("studioModals.cell.openPreviewDetails")}
                                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "block" }}>
                                    {/* Vertical Pin thumbnail (2:3), not a horizontal strip crop. */}
                                    <span data-testid="batch-edit-pin-thumb" style={{ width: 40, height: 54, borderRadius: 5, overflow: "hidden", background: UI.cardElev, display: "block" }}>
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img src={toProxyUrl(p.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                    </span>
                                  </button>
                                </td>
                              );
                            case "product": {
                              // Neutral, source-agnostic summary. Amazon is only a small
                              // badge; the link label reflects Affiliate vs Product link.
                              const popoverProducts = [primary, ...tagged].filter(Boolean) as LinkedProduct[];
                              const amazonPrimary = isAmazonProduct({ productUrl: primary?.productUrl, canonicalUrl: primary?.canonicalUrl, source: primary?.source, store: primary?.store });
                              const primLink = resolveProductLinkDisplay({ productUrl: primary?.productUrl, canonicalUrl: primary?.canonicalUrl, source: primary?.source, store: primary?.store }, amazonPrimary ? displayCtx.affiliateUrl : null);
                              const primDomain = amazonPrimary ? tr("studioModals.product.amazon") : (linkDomain(primary?.productUrl) || primary?.store || "");
                              const popoverOpen = productPopoverPinId === p.pinId;
                              return (
                                <td key={c.id} style={td}>
                                  <div data-testid="batch-edit-product-cell" style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
                                    {prodCount === 0 ? (
                                      <button type="button" data-testid="batch-edit-product-add" onClick={() => setQuickAddPinId(p.pinId)} style={{ ...cellMuted, display: "inline-flex", alignItems: "center", gap: 4, width: "auto" }}>
                                        <Plus style={{ width: 12, height: 12 }} /> {tr("studioModals.cell.addProduct")}
                                      </button>
                                    ) : (
                                      <>
                                        <button type="button" data-testid="batch-edit-product-summary" onClick={() => setProductPopoverPinId(popoverOpen ? null : p.pinId)} title={tr("studioModals.cell.viewLinkedProducts")}
                                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                                          {primary?.imageUrl ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={toProxyUrl(primary.imageUrl)} alt="" style={{ width: 26, height: 26, borderRadius: 5, objectFit: "cover", flexShrink: 0, border: `1px solid ${UI.border}` }} />
                                          ) : <span style={{ width: 26, height: 26, borderRadius: 5, background: UI.bg2, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Package style={{ width: 12, height: 12, color: UI.textMuted }} /></span>}
                                          <span style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
                                            <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: UI.text }}>
                                              {primary?.title ?? tr("studioModals.product.productFallback")}{prodCount > 1 ? <span style={{ color: "#A78BFA" }}> · +{prodCount - 1}</span> : ""}
                                            </span>
                                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 8.5 }}>
                                              {amazonPrimary
                                                ? <span data-testid="batch-edit-product-source" style={{ fontWeight: 800, color: "#F59E0B", background: "rgba(245,158,11,0.14)", padding: "0 5px", borderRadius: 999 }}>{tr("studioModals.product.amazon")}</span>
                                                : primDomain ? <span data-testid="batch-edit-product-source" style={{ fontWeight: 600, color: UI.textMuted }}>{primDomain}</span> : null}
                                              <span data-testid="batch-edit-product-linktype" style={{ fontWeight: 700, color: primLink.url ? "#60A5FA" : UI.textMuted }}>{primLink.label}</span>
                                            </span>
                                          </span>
                                        </button>
                                        <button type="button" data-testid="batch-edit-product-add" title={tr("studioModals.cell.addProduct")} onClick={() => setQuickAddPinId(p.pinId)} style={{ background: "none", border: `1px solid ${UI.border}`, borderRadius: 5, padding: "2px", cursor: "pointer", color: UI.textMuted, flexShrink: 0, lineHeight: 0 }}><Plus style={{ width: 12, height: 12 }} /></button>
                                        {popoverOpen && (
                                          <ProductLinksPopover
                                            products={popoverProducts}
                                            affiliateUrl={displayCtx.affiliateUrl}
                                            onClose={() => setProductPopoverPinId(null)}
                                            onAdd={() => setQuickAddPinId(p.pinId)}
                                            onManage={() => openDrawer(p.pinId, "products")}
                                          />
                                        )}
                                      </>
                                    )}
                                  </div>
                                </td>
                              );
                            }
                            case "dest":
                              return (
                                <td key={c.id} style={td}>
                                  <input data-testid="batch-edit-destination-url-cell" value={url} placeholder={tr("studioModals.cell.enterDestinationUrl")}
                                    onChange={e => patchRow(p.pinId, { destinationUrl: e.target.value }, { debounce: true })}
                                    onBlur={e => { onInlineBlur(e); patchRow(p.pinId, { destinationUrl: e.target.value }); }}
                                    onFocus={onInlineFocus} style={inlineInput} />
                                  {displayCtx.affiliateUrl && url.trim() === displayCtx.affiliateUrl && (
                                    <p data-testid="batch-edit-dest-affiliate" style={{ margin: "2px 0 0", padding: "0 7px", fontSize: 8.5, fontWeight: 700, color: UI.success }}>
                                      {tr("studioModals.cell.affiliateLink")}
                                    </p>
                                  )}
                                </td>
                              );
                            case "title":
                              return (
                                <td key={c.id} style={td}>
                                  <input data-testid="batch-edit-title-cell" value={title} placeholder={tr("studioModals.cell.addTitle")} maxLength={100}
                                    onChange={e => patchRow(p.pinId, { title: e.target.value }, { debounce: true })}
                                    onBlur={e => { onInlineBlur(e); patchRow(p.pinId, { title: e.target.value }); }}
                                    onFocus={onInlineFocus} style={inlineInput} />
                                </td>
                              );
                            case "desc":
                              return (
                                <td key={c.id} style={td}>
                                  <input data-testid="batch-edit-description-cell" value={desc} placeholder={tr("studioModals.cell.addDescription")} maxLength={500}
                                    onChange={e => patchRow(p.pinId, { description: e.target.value }, { debounce: true })}
                                    onBlur={e => { onInlineBlur(e); patchRow(p.pinId, { description: e.target.value }); }}
                                    onFocus={onInlineFocus} style={inlineInput} />
                                </td>
                              );
                            case "board":
                              return (
                                <td key={c.id} style={td}>
                                  <div data-testid="batch-edit-board-cell">
                                    <BoardSelect dense value={board} boardsState={boardsState} onChange={b => patchRow(p.pinId, { boardId: b?.id ?? "", boardName: b?.name ?? "" })} recommendFor={{ category: p.category, topic: title }} />
                                  </div>
                                </td>
                              );
                            case "alt":
                              return (
                                <td key={c.id} style={td}>
                                  <input data-testid="batch-edit-alt-cell" value={alt} placeholder={tr("studioModals.cell.addAltText")}
                                    onChange={e => patchRow(p.pinId, { altText: e.target.value }, { debounce: true })}
                                    onBlur={e => { onInlineBlur(e); patchRow(p.pinId, { altText: e.target.value }); }}
                                    onFocus={onInlineFocus} style={inlineInput} />
                                </td>
                              );
                            case "time":
                              // Publish time is an optional override/reschedule. Empty is fine —
                              // Schedule assigns a Smart Schedule slot. Editing here does not gate Schedule.
                              return (
                                <td key={c.id} style={td}>
                                  <div data-testid="batch-edit-time-cell" style={{ display: "flex", gap: 4 }}>
                                    <input type="time" value={time} onChange={e => patchRow(p.pinId, { plannedTime: e.target.value })} onFocus={onInlineFocus} onBlur={onInlineBlur} style={{ ...inlineInput, colorScheme: "dark", padding: "4px 5px", width: 78 }} />
                                    <input type="date" value={date} onChange={e => patchRow(p.pinId, { plannedDate: e.target.value })} onFocus={onInlineFocus} onBlur={onInlineBlur} style={{ ...inlineInput, colorScheme: "dark", padding: "4px 5px" }} />
                                  </div>
                                </td>
                              );
                            case "plan":
                              return <td key={c.id} style={td}><span data-testid="batch-edit-plan-cell" style={{ color: UI.textSec, fontSize: 11 }}>{tr(PLAN_LABEL_KEY[planLabel(p, rowEdits)])}</span></td>;
                            case "more":
                              return (
                                <td key={c.id} style={td}>
                                  <Dropdown align="right" width={200} trigger={() => <span style={{ cursor: "pointer", color: UI.textMuted, display: "inline-flex", padding: 4 }}><MoreHorizontal style={{ width: 16, height: 16 }} /></span>}>
                                    {close => <>
                                      <MenuItem icon={<Pencil style={{ width: 13, height: 13 }} />} label={tr("studioModals.rowMenu.editDetails")} onClick={() => { close(); openDrawer(p.pinId, "details"); }} />
                                      <MenuItem icon={<Package style={{ width: 13, height: 13 }} />} label={tr("studioModals.rowMenu.manageProducts")} onClick={() => { close(); openDrawer(p.pinId, "products"); }} />
                                      <MenuItem icon={<Copy style={{ width: 13, height: 13 }} />} label={tr("studioModals.rowMenu.viewInPlan")} onClick={() => { close(); window.open("/app/plan", "_blank"); }} />
                                      <MenuItem icon={<X style={{ width: 13, height: 13 }} />} label={tr("studioModals.toolbar.removeFromSelection")} onClick={() => { close(); setCheckedRows(prev => { const n = new Set(prev); n.delete(p.pinId); return n; }); }} />
                                    </>}
                                  </Dropdown>
                                </td>
                              );
                            default: return null;
                          }
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div style={{ height: 16 }} />
          </div>

          {drawerPin && (
            <DetailDrawer
              key={drawerPin.pinId}
              pin={drawerPin}
              edits={rowEdits}
              boardsState={boardsState}
              tab={drawerTab}
              onTab={setDrawerTab}
              onClose={() => setDrawerPinId(null)}
              onPatch={(patch, debounce) => patchRow(drawerPin.pinId, patch, { debounce })}
              onProducts={prods => patchProducts(drawerPin.pinId, prods)}
              onConfirm={setConfirm}
            />
          )}
        </div>
      </div>

      {/* Bulk popovers */}
      {bulk === "destination" && <DestinationUrlPopover count={checkedCount} onApply={applyBulkDestination} onClose={() => setBulk(null)} />}
      {bulk === "schedule" && <SchedulePopover count={checkedCount} onApply={applyBulkSchedule} onClose={() => setBulk(null)} />}
      {bulk === "product" && <ProductPopover count={checkedCount} onApply={applyBulkProductAdd} onReplace={applyBulkProductReplace} onClose={() => setBulk(null)} />}
      {bulk === "board" && (
        <Modal title={checkedCount === 1 ? tr("studioModals.board.setBoardForOne") : tr("studioModals.board.setBoardForMany").replace("{n}", String(checkedCount))} onClose={() => setBulk(null)}>
          <BoardSelect value={{ id: "", name: "" }} boardsState={boardsState} onChange={b => { if (b) applyBulkBoard(b); }} />
          <p style={{ margin: "12px 0 0", fontSize: 10.5, color: UI.textMuted }}>{tr("studioModals.board.appliesToAll")}</p>
        </Modal>
      )}
      {quickAddPin && (
        <ProductQuickAdd title={tr("studioModals.product.addToThisPin")} current={(() => { const e = effProducts(quickAddPin, rowEdits); return { primary: e.primary, tagged: e.tagged }; })()}
          onApply={next => { patchProducts(quickAddPin.pinId, next); setQuickAddPinId(null); toast.success(tr("studioModals.product.productAdded")); }}
          onClose={() => setQuickAddPinId(null)} />
      )}

      {confirm && <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />}

      {/* Publish flow */}
      {publishPhase && (
        <div style={{ position: "fixed", inset: 0, zIndex: 330, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }}
          onClick={publishPhase === "running" ? undefined : () => setPublishPhase(null)}>
          <div data-testid="batch-edit-publish-modal" onClick={e => e.stopPropagation()} style={{ background: UI.bg2, border: `1px solid ${UI.borderStr}`, borderRadius: 14, boxShadow: "0 20px 56px rgba(0,0,0,0.6)", padding: "22px 24px", width: 480, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
            {publishPhase === "confirm" && (
              <div data-testid="batch-edit-publish-confirm">
                <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 800, color: UI.text }}>{tr("studioModals.publish.confirmTitle")}</h3>
                <p style={{ margin: "0 0 18px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>{tr("studioModals.publish.confirmBody")}</p>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" data-testid="batch-edit-publish-cancel" onClick={() => setPublishPhase(null)} style={btnBase}>{tr("common.cancel")}</button>
                  <button type="button" data-testid="batch-edit-publish-confirm-go" onClick={() => void runPublish(checkedPins)}
                    style={{ ...btnBase, border: "none", background: UI.gradient, color: "#fff" }}>{tr("pinDetails.publishNow")}</button>
                </div>
              </div>
            )}
            {publishPhase === "blocked" && (
              <div data-testid="batch-edit-publish-readiness">
                <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 800, color: UI.text }}>{tr("studioModals.publish.someNeedDetails")}</h3>
                <p style={{ margin: "0 0 10px", fontSize: 11.5, color: UI.textSec, lineHeight: 1.5 }}>{tr("studioModals.publish.missingRequiredInfo")}</p>
                <p style={{ margin: "0 0 14px", fontSize: 11.5, fontWeight: 700, color: UI.text }}>
                  {publishReadyCount} {publishReadyCount === 1 ? tr("studioModals.publish.pinIsReady") : tr("studioModals.publish.pinsAreReady")} {publishBlocked.length} {publishBlocked.length === 1 ? tr("studioModals.publish.pinNeedsDetails") : tr("studioModals.publish.pinsNeedDetails")}
                </p>
                <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, maxHeight: 300 }}>
                  {publishBlocked.map(b => (
                    <div key={b.pinId} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.card }}>
                      <p style={{ margin: "0 0 4px", fontSize: 11.5, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</p>
                      <p style={{ margin: 0, fontSize: 10.5, color: UI.textSec }}>{tr("studioModals.publish.missingPrefix")}{b.missing.join(", ")}</p>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
                  <button type="button" onClick={() => setPublishPhase(null)} style={btnBase}>{tr("common.cancel")}</button>
                  {publishReadyCount > 0 && (
                    <button type="button" data-testid="batch-edit-publish-ready" onClick={() => void runPublish(checkedPins.filter(p => isPinReady(pubReadinessInput(p, rowEdits))))}
                      style={{ ...btnBase, border: "none", background: UI.gradient, color: "#fff" }}>{tr("studioModals.publish.publishReadyPins")}</button>
                  )}
                </div>
              </div>
            )}
            {publishPhase === "running" && (
              <div style={{ padding: "20px 8px", textAlign: "center" }}>
                <style>{"@keyframes vp-batch-spin{to{transform:rotate(360deg)}}"}</style>
                <Loader2 style={{ width: 26, height: 26, color: UI.purple, margin: "0 auto 12px", animation: "vp-batch-spin 1s linear infinite" }} />
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: UI.text }}>{tr("studioModals.publish.publishingProgress").replace("{current}", String(publishProgress.current)).replace("{total}", String(publishProgress.total))}</p>
              </div>
            )}
            {publishPhase === "done" && (() => {
              const pub = publishResults.filter(r => r.status === "published").length;
              const fail = publishResults.filter(r => r.status === "failed").length;
              const skip = publishResults.filter(r => r.status === "skipped").length;
              return (
                <>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 800, color: UI.text }}>{tr("studioModals.publish.complete")}</h3>
                  <p style={{ margin: "0 0 14px", fontSize: 12, color: UI.textSec }}>
                    <span style={{ color: UI.success, fontWeight: 700 }}>{tr("studioModals.publish.publishedCount").replace("{n}", String(pub))}</span>
                    {fail > 0 && <> · <span style={{ color: UI.error, fontWeight: 700 }}>{tr("studioModals.publish.failedCount").replace("{n}", String(fail))}</span></>}
                    {skip > 0 && <> · <span style={{ color: UI.textSec, fontWeight: 700 }}>{tr("studioModals.publish.needDetailsCount").replace("{n}", String(skip))}</span></>}
                  </p>
                  <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, maxHeight: 320 }}>
                    {publishResults.map(r => (
                      <div key={r.pinId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.card }}>
                        {r.status === "published" ? <CheckCircle2 style={{ width: 14, height: 14, color: UI.success, flexShrink: 0 }} /> : r.status === "failed" ? <X style={{ width: 14, height: 14, color: UI.error, flexShrink: 0 }} /> : <AlertCircle style={{ width: 14, height: 14, color: UI.textSec, flexShrink: 0 }} />}
                        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                        {r.status === "published" && r.url ? <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, fontWeight: 700, color: "#93C5FD" }}>{tr("studioModals.publish.viewLink")}</a> : <span style={{ fontSize: 9.5, color: r.status === "failed" ? UI.error : UI.textSec }}>{r.message}</span>}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
                    <button type="button" onClick={() => setPublishPhase(null)} style={{ ...btnBase, border: "none", background: UI.gradient, color: "#fff" }}>{tr("studioModals.publish.done")}</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </>
  );
}

// ── Detail drawer (optional, on-demand deep edit) ─────────────────────────────

function DetailDrawer({ pin, edits, boardsState, tab, onTab, onClose, onPatch, onProducts, onConfirm }: {
  pin: BatchPinRow;
  edits: Record<string, RowEdit>;
  boardsState: BoardsState;
  tab: "details" | "products";
  onTab: (t: "details" | "products") => void;
  onClose: () => void;
  onPatch: (patch: RowEdit, debounce?: boolean) => void;
  onProducts: (products: PinProductsEdit) => void;
  onConfirm: (c: ConfirmState) => void;
}) {
  const { t: tr } = useLocale();
  const title = getVal(pin, edits, "title");
  const desc  = getVal(pin, edits, "description");
  const alt   = getVal(pin, edits, "altText");
  const url   = getVal(pin, edits, "destinationUrl");
  const date  = getVal(pin, edits, "plannedDate");
  const time  = getVal(pin, edits, "plannedTime");
  const board = effBoard(pin, edits);
  const { primary, tagged } = effProducts(pin, edits);
  const [newUrls, setNewUrls] = useState<string[]>([""]);

  const field: React.CSSProperties = { ...inputStyle, marginTop: 6 };
  const lbl: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.04em" };

  function addProductUrls() {
    const cleaned = newUrls.map(u => u.trim()).filter(Boolean);
    if (!cleaned.length) return;
    let cur: PinProductsEdit = { primary, tagged };
    for (const u of cleaned) cur = applyProductAdd(cur, linkedProductFromUrl(u), !cur.primary);
    onProducts(cur);
    setNewUrls([""]);
    toast.success(cleaned.length === 1 ? tr("studioModals.product.addedCountOne") : tr("studioModals.product.addedCountMany").replace("{n}", String(cleaned.length)));
  }

  return (
    <aside data-testid="batch-edit-drawer" style={{ width: "min(420px, 42vw)", flexShrink: 0, borderLeft: `1px solid ${UI.borderStr}`, background: UI.bg2, display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "12px 16px", borderBottom: `1px solid ${UI.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" data-testid="batch-edit-drawer-details-tab" onClick={() => onTab("details")} style={{ ...btnBase, background: tab === "details" ? UI.purpleSoft : "none", color: tab === "details" ? "#C4B5FD" : UI.textSec, border: tab === "details" ? `1px solid ${UI.purple}` : `1px solid transparent` }}>{tr("studioModals.drawer.details")}</button>
          <button type="button" data-testid="batch-edit-drawer-products-tab" onClick={() => onTab("products")} style={{ ...btnBase, background: tab === "products" ? UI.purpleSoft : "none", color: tab === "products" ? "#C4B5FD" : UI.textSec, border: tab === "products" ? `1px solid ${UI.purple}` : `1px solid transparent` }}>{tr("studioModals.drawer.products")}</button>
        </div>
        <button type="button" data-testid="batch-edit-drawer-close" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: UI.textMuted, padding: 4 }}><X style={{ width: 16, height: 16 }} /></button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
        {tab === "details" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ width: "100%", aspectRatio: "4/3", borderRadius: 10, overflow: "hidden", background: UI.cardElev }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={toProxyUrl(pin.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
            <div><span style={lbl}>{tr("pinDetails.title.label")}</span>
              <input data-testid="batch-edit-drawer-title" value={title} maxLength={100} onChange={e => onPatch({ title: e.target.value }, true)} onBlur={e => onPatch({ title: e.target.value })} style={field} /></div>
            <div><span style={lbl}>{tr("studioModals.col.description")}</span>
              <textarea value={desc} rows={4} maxLength={500} onChange={e => onPatch({ description: e.target.value }, true)} onBlur={e => onPatch({ description: e.target.value })} style={{ ...field, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} /></div>
            <div><span style={lbl}>{tr("pinDetails.altText.label")}</span>
              <textarea value={alt} rows={2} onChange={e => onPatch({ altText: e.target.value }, true)} onBlur={e => onPatch({ altText: e.target.value })} style={{ ...field, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} /></div>
            <div><span style={lbl}>{tr("studioModals.col.destinationUrl")}</span>
              <input data-testid="batch-edit-drawer-destination-url" value={url} placeholder="https://…" onChange={e => onPatch({ destinationUrl: e.target.value }, true)} onBlur={e => onPatch({ destinationUrl: e.target.value })} style={field} /></div>
            <div><span style={lbl}>{tr("studioModals.col.board")}</span>
              <div style={{ marginTop: 6 }}><BoardSelect value={board} boardsState={boardsState} onChange={b => onPatch({ boardId: b?.id ?? "", boardName: b?.name ?? "" })} recommendFor={{ category: pin.category, topic: title }} /></div></div>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}><span style={lbl}>{tr("studioModals.schedule.publishDate")}</span>
                <input type="date" value={date} onChange={e => onPatch({ plannedDate: e.target.value })} style={{ ...field, colorScheme: "dark" }} /></div>
              <div style={{ flex: 1 }}><span style={lbl}>{tr("studioModals.col.publishTime")}</span>
                <input type="time" value={time} onChange={e => onPatch({ plannedTime: e.target.value })} style={{ ...field, colorScheme: "dark" }} /></div>
            </div>
            <div><span style={lbl}>{tr("studioModals.col.plan")}</span><p style={{ margin: "6px 0 0", fontSize: 12, color: UI.textSec }}>{tr(PLAN_LABEL_KEY[planLabel(pin, edits)])}</p></div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0, fontSize: 10.5, color: UI.textMuted, lineHeight: 1.5, padding: "8px 10px", borderRadius: 8, background: UI.purpleSoft, border: `1px solid ${UI.border}` }}>
              {tr("studioModals.product.linkedNotDestinationSingle")}
            </p>
            {primary || tagged.length > 0 ? (
              [primary, ...tagged].filter(Boolean).map((lp, i) => {
                const product = lp as LinkedProduct;
                const isPrimary = i === 0 && !!primary;
                return (
                  <div key={productKey(product) + i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.card }}>
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={toProxyUrl(product.imageUrl)} alt="" style={{ width: 38, height: 38, borderRadius: 7, objectFit: "cover", flexShrink: 0 }} />
                    ) : <div style={{ width: 38, height: 38, borderRadius: 7, background: UI.bg2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Package style={{ width: 15, height: 15, color: UI.textMuted }} /></div>}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p style={{ margin: 0, fontSize: 11.5, fontWeight: 600, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {isPrimary && <Star style={{ width: 11, height: 11, color: "#FBBF24", display: "inline", marginRight: 4, verticalAlign: "-1px" }} />}
                        {product.title}
                      </p>
                      {product.productUrl && <p style={{ margin: "2px 0 0", fontSize: 10, color: "#93C5FD", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{product.productUrl}</p>}
                      <span style={{ fontSize: 9.5, color: UI.textMuted }}>{sourceShortLabel(product.source)}{isPrimary ? ` · ${tr("pinDetails.products.primary")}` : ""}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                      {!isPrimary && <button type="button" onClick={() => onProducts(promoteTaggedToPrimary({ primary, tagged }, productKey(product)))} style={{ ...btnBase, padding: "3px 8px", fontSize: 10 }}>{tr("pinDetails.products.makePrimary")}</button>}
                      <button type="button" onClick={() => onProducts(removeProductByKey({ primary, tagged }, productKey(product)))} style={{ ...btnBase, padding: "3px 8px", fontSize: 10, color: UI.error }}><Trash2 style={{ width: 11, height: 11 }} /></button>
                    </div>
                  </div>
                );
              })
            ) : <p style={{ margin: 0, fontSize: 11.5, color: UI.textMuted }}>{tr("studioModals.product.noneLinkedOptional")}</p>}

            <div style={{ borderTop: `1px solid ${UI.border}`, paddingTop: 12 }}>
              <span style={lbl}>{tr("studioModals.product.addProductUrl")}</span>
              {newUrls.map((u, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <input data-testid="batch-edit-drawer-product-url" value={u} placeholder="https://store.example.com/product" onChange={e => setNewUrls(prev => prev.map((x, xi) => xi === i ? e.target.value : x))} style={inputStyle} />
                  {newUrls.length > 1 && <button type="button" onClick={() => setNewUrls(prev => prev.filter((_, xi) => xi !== i))} style={{ ...btnBase, padding: "0 9px" }}><X style={{ width: 12, height: 12 }} /></button>}
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" onClick={() => setNewUrls(prev => [...prev, ""])} style={{ ...btnBase, fontSize: 10.5 }}><Plus style={{ width: 12, height: 12 }} /> {tr("studioModals.product.addAnother")}</button>
                <button type="button" data-testid="batch-edit-drawer-add-product" onClick={addProductUrls} style={{ ...btnBase, border: "none", background: UI.gradient, color: "#fff", fontSize: 10.5 }}>{tr("studioModals.product.linkProduct")}</button>
              </div>
            </div>

            {primary?.productUrl && (
              <button type="button" onClick={() => {
                if (url.trim()) {
                  onConfirm({ title: tr("studioModals.dest.overwriteTitle"), body: <>{tr("studioModals.dest.overwriteBody")}</>, confirmLabel: tr("studioModals.confirmReplace"), danger: true, onConfirm: () => onPatch({ destinationUrl: primary.productUrl! }) });
                } else onPatch({ destinationUrl: primary.productUrl! });
              }} style={{ ...btnBase, fontSize: 10.5, color: "#A78BFA" }}>
                <Link2 style={{ width: 12, height: 12 }} /> {tr("studioModals.product.fillEmptyDestFromPrimarySingle")}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
