"use client";
import { useState, useEffect, useRef, Suspense, useCallback, useMemo } from "react";
import { preload } from "swr";
import { PRODUCT_IDEAS_SWR_KEY, fetchProductIdeasWithMeta } from "@/lib/productIdeas";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Sparkles, X, ChevronDown, Plus, Clock,
  Search, AlertCircle, Target,
  CheckCircle2,
  Play, MoreVertical,
} from "lucide-react";
import { toast } from "sonner";
import { InlineCreateAssetPicker } from "@/components/studio/InlineCreateAssetPicker";
import * as assetStore from "@/lib/assetStore";
import { supabase } from "@/lib/supabase";
import {
  loadPrefill, buildPromptFromPrefill, draftToPrefill,
  type CreatePinsPrefill,
} from "@/lib/createPinsPrefill";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { toProxyUrl } from "@/lib/imageProxy";
import {
  addHistory, loadHistory, createRunningSessionInDb, updateSessionInDb,
  mergeHistoryEntries, fetchGenerationsFromDb, deriveEntryStatus, resolveStaleRunningEntries,
  type SetupSnapshot, type HistoryEntry, type GenerationStatus, type GenerationErrorType,
  type PinGroup as HistoryPinGroup,
} from "@/lib/studioPersistence";
import { PinDetailsDrawer, type PinMetadataFormState, type PinDetailsGenStatus, type DrawerTab, type RemixDraftSetup } from "@/components/studio/PinDetailsDrawer";
import { BatchEditDrawer, type BatchPinRow, type BatchEditDrawerProps } from "@/components/studio/BatchEditDrawer";
import { resolvePinDetail, type PinDetailView } from "@/components/studio/pinDetails";
import {
  generatePinMetadataDraft, generateBatchMetadataDraft, applyDraftToPinFields,
  computePlanningStatusFromFields, metadataReadinessLabel, pinNeedsDetailsGeneration, EMPTY_TOUCHED,
  type PinMetadataDraft, type MetadataTouchedFlags,
} from "@/lib/pinMetadata";
import * as pinMetadataStore from "@/lib/pinMetadataStore";
import {
  buildWeeklyPlanItemFromGeneratedPin,
  canAddGeneratedPinToPlan,
} from "@/lib/weeklyPlanHandoff";

// ── Dark theme palette ────────────────────────────────────────────────────────

const D = {
  bg:          "#0B0E17",
  surface:     "#111827",
  card:        "#161D2E",
  cardElev:    "#1A2236",
  border:      "rgba(255,255,255,0.07)",
  borderStr:   "rgba(255,255,255,0.12)",
  text:        "#E2E8F0",
  textSec:     "#8892A4",
  textMuted:   "#4A5568",
  accent:      "#3B82F6",
  accentBg:    "rgba(59,130,246,0.12)",
  success:     "#10B981",
  warning:     "#F59E0B",
  error:       "#EF4444",
  purple:      "#7C3AED",
  purpleBg:    "rgba(124,58,237,0.12)",
  gradient:    "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type Opportunity = { keyword: string; category: string; tier: string; trend?: string };
type PlanStatus  = "not_added" | "added_to_plan" | "needs_review" | "ready" | "posted" | "skipped";

type StudioPin = {
  id:               string;
  url:              string;
  planningStatus:   PlanStatus;
  title:            string;
  description:      string;
  altText:          string;
  destinationUrl:   string;
  plannedDate:      string;
  weeklyPlanItemId?: string | null;
  metadataDraft?:   PinMetadataDraft;
  metadataTouched:  MetadataTouchedFlags;
};

type RefGroup = {
  refUrl:        string | null;
  refIndex:      number;
  items:         StudioPin[];
  status:        "generating" | "done" | "failed";
  expectedCount: number;
};

type OppRow = { id: string; keyword: string; category: string; priority_score: number | null; yearly_change: number | null };

type SessionStatus = "queued" | "generating" | "completed" | "partial" | "failed";

type GenerationSession = {
  id:                 string;
  savedAt:            string;
  keyword:            string;
  category:           string;
  source:             string;
  groups:             RefGroup[];
  status:             SessionStatus;
  expectedTotal:      number;
  promptExcerpt:      string;
  productCount:       number;
  refCount:           number;
  isNew:              boolean;
  collapsed:          boolean;
  generatingGroupIdx: number | null;
  promptFull?:        string;
  setupSnapshot?:     SetupSnapshot;
  errorType?:         GenerationErrorType;
  errorMessage?:      string;
  model?:             string;
  format?:            string;
  textOverlay?:       string;
  groupErrors?:       Record<number, { message?: string; errorType?: GenerationErrorType }>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function nextWeekdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() + 1);
  if (day === 6) d.setDate(d.getDate() + 2);
  return d.toISOString().split("T")[0];
}

function persistStudioPinMetadata(pin: StudioPin, sessionId: string): void {
  if (!pin.metadataDraft) return;
  pinMetadataStore.savePinMetadata({
    pinId: pin.id, sessionId, imageUrl: pin.url,
    metadataDraft: pin.metadataDraft,
    title: pin.title, description: pin.description,
    altText: pin.altText, destinationUrl: pin.destinationUrl,
    plannedDate: pin.plannedDate, planningStatus: pin.planningStatus,
    touched: pin.metadataTouched,
  });
}

function hydratePinFromStore(pin: StudioPin, sessionId: string): StudioPin {
  const stored = pinMetadataStore.getPinMetadata(pin.id);
  if (!stored) return pin;
  const draft = pinDraftStore.getDraftByImageUrl(pin.url);
  return {
    ...pin,
    title: stored.title || pin.title,
    description: stored.description || pin.description,
    altText: stored.altText || pin.altText,
    destinationUrl: stored.destinationUrl || pin.destinationUrl,
    plannedDate: stored.plannedDate || pin.plannedDate,
    planningStatus: (stored.planningStatus as PlanStatus) || pin.planningStatus,
    metadataDraft: stored.metadataDraft,
    metadataTouched: stored.touched,
    weeklyPlanItemId: draft?.id ?? pin.weeklyPlanItemId,
  };
}

function createCompletedPin(
  sessionId: string, gi: number, ii: number, url: string,
  session: Pick<GenerationSession, "keyword" | "category" | "setupSnapshot" | "promptFull">,
  refLabel: string,
): StudioPin {
  const id = `${sessionId}_g${gi}_p${ii}`;
  const existing = pinMetadataStore.getPinMetadata(id);
  if (existing) {
    const draft = pinDraftStore.getDraftByImageUrl(url);
    return hydratePinFromStore({
      id, url, planningStatus: (existing.planningStatus as PlanStatus) || "not_added",
      title: existing.title, description: existing.description,
      altText: existing.altText, destinationUrl: existing.destinationUrl,
      plannedDate: existing.plannedDate, weeklyPlanItemId: draft?.id ?? null,
      metadataDraft: existing.metadataDraft, metadataTouched: existing.touched,
    }, sessionId);
  }
  const metaDraft = generatePinMetadataDraft({
    pinIndex: ii, groupIndex: gi,
    keyword: session.keyword, category: session.category,
    opportunityTitle: session.setupSnapshot?.opportunityTitle,
    promptSnapshot: session.promptFull ?? session.setupSnapshot?.promptSnapshot,
    setupSnapshot: session.setupSnapshot,
    referenceLabel: refLabel,
    referenceVisualFormat: session.setupSnapshot?.selectedReferences?.[gi]?.visualFormat,
  });
  const fields = applyDraftToPinFields(metaDraft);
  const pin: StudioPin = {
    id, url, planningStatus: "not_added",
    ...fields, metadataDraft: metaDraft, metadataTouched: EMPTY_TOUCHED,
    weeklyPlanItemId: null,
  };
  persistStudioPinMetadata(pin, sessionId);
  return pin;
}

function newPin(sessionId: string, gi: number, ii: number, url: string, session?: GenerationSession, refLabel?: string): StudioPin {
  if (session) {
    return createCompletedPin(sessionId, gi, ii, url, session, refLabel ?? refLabelForGroup(session, session.groups[gi]));
  }
  return {
    id: `${sessionId}_g${gi}_p${ii}`, url, planningStatus: "not_added",
    title: "", description: "", altText: "", destinationUrl: "", plannedDate: "",
    metadataTouched: EMPTY_TOUCHED,
  };
}

function formatTimeAgo(isoDate: string): string {
  const ms  = Date.now() - new Date(isoDate).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1)  return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `${hr}h ago`;
  return new Date(isoDate).toLocaleDateString();
}

const TIER_COLOR:  Record<string, string> = { best_bet: "#10B981", steady: "#3B82F6", competitive: "#F59E0B" };
const TIER_LABEL:  Record<string, string> = { best_bet: "Best Bet", steady: "Steady", competitive: "Competitive" };
const TREND_COLOR: Record<string, string> = { rising: "#10B981", evergreen: "#3B82F6", seasonal: "#F59E0B" };

const PROMPT_STARTERS = [
  "Cozy bedroom scene",
  "Product flat lay",
  "Mirror outfit shot",
  "Room decor moodboard",
  "Digital product mockup",
  "No text overlay",
] as const;

type FeedFilter = "all" | "generating" | "completed" | "failed" | "added";
type RightPanelMode = "feed" | "product_picker" | "reference_picker";
type FeedPinStatus = "completed" | "generating" | "failed" | "added";

type MasonryPinEntry = {
  key:                 string;
  sessionId:           string;
  groupIdx:            number;
  pinIdx?:             number;
  pin?:                StudioPin;
  status:              FeedPinStatus;
  refLabel:            string;
  createdAt:           string;
  placeholderVariant?: "generating" | "queued" | "failed";
};

type FeedItem = { entry: MasonryPinEntry; session: GenerationSession };

function formatPinDate(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function refLabelForGroup(session: GenerationSession, group: RefGroup): string {
  if (group.refUrl) return `Reference ${group.refIndex + 1}`;
  return session.productCount > 0 ? "Product" : "No product";
}

function collectSessionPins(session: GenerationSession): MasonryPinEntry[] {
  const entries: MasonryPinEntry[] = [];
  session.groups.forEach((group, gi) => {
    const refLabel = refLabelForGroup(session, group);
    group.items.forEach((pin, pi) => {
      entries.push({
        key:       pin.id,
        sessionId: session.id,
        groupIdx:  gi,
        pinIdx:      pi,
        pin,
        status:    pin.planningStatus !== "not_added" ? "added" : "completed",
        refLabel,
        createdAt: session.savedAt,
      });
    });

    if (group.status === "generating") {
      const remaining = Math.max(0, group.expectedCount - group.items.length);
      const variant   = gi > (session.generatingGroupIdx ?? 0) && group.items.length === 0 ? "queued" : "generating";
      for (let i = 0; i < remaining; i++) {
        entries.push({
          key: `${session.id}-${gi}-ph-${i}`,
          sessionId: session.id,
          groupIdx: gi,
          status: "generating",
          refLabel,
          createdAt: session.savedAt,
          placeholderVariant: variant,
        });
      }
    }

    if (group.status === "failed" && group.items.length === 0) {
      for (let i = 0; i < group.expectedCount; i++) {
        entries.push({
          key: `${session.id}-${gi}-fail-${i}`,
          sessionId: session.id,
          groupIdx: gi,
          status: "failed",
          refLabel,
          createdAt: session.savedAt,
          placeholderVariant: "failed",
        });
      }
    }

    const missing = Math.max(0, group.expectedCount - group.items.length);
    if (group.status === "failed" && group.items.length > 0 && missing > 0) {
      for (let i = 0; i < missing; i++) {
        entries.push({
          key: `${session.id}-${gi}-fail-partial-${i}`,
          sessionId: session.id,
          groupIdx: gi,
          status: "failed",
          refLabel,
          createdAt: session.savedAt,
          placeholderVariant: "failed",
        });
      }
    }
  });
  return entries;
}

function filterMasonryPins(pins: MasonryPinEntry[], filter: FeedFilter): MasonryPinEntry[] {
  if (filter === "all") return pins;
  return pins.filter(p => {
    switch (filter) {
      case "generating": return p.status === "generating";
      case "completed":  return p.status === "completed";
      case "failed":     return p.status === "failed";
      case "added":      return p.status === "added";
      default:           return true;
    }
  });
}

function flattenFeedItems(sessions: GenerationSession[], filter: FeedFilter): FeedItem[] {
  const sorted = [...sessions].sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
  const items: FeedItem[] = [];
  for (const session of sorted) {
    for (const entry of filterMasonryPins(collectSessionPins(session), filter)) {
      items.push({ entry, session });
    }
  }
  return items;
}

function sessionHasAddablePins(session: GenerationSession): boolean {
  return session.groups.some(g => g.items.some(p => p.planningStatus === "not_added"));
}

function entryStatusToSessionStatus(entry: HistoryEntry): SessionStatus {
  const st = deriveEntryStatus(entry);
  if (st === "running" || st === "pending") return "generating";
  if (st === "interrupted" || st === "partial") return "partial";
  if (st === "failed") return "failed";
  return "completed";
}

function historyEntryToSession(entry: HistoryEntry, collapsed: boolean): GenerationSession {
  const sessionStatus = entryStatusToSessionStatus(entry);
  const groupErrors: Record<number, { message?: string; errorType?: GenerationErrorType }> = {};
  if (entry.errorMessage && entry.groups.length > 0) {
    entry.groups.forEach((g, gi) => {
      if (g.images.length === 0) {
        groupErrors[gi] = { message: entry.errorMessage, errorType: entry.errorType };
      }
    });
  }
  return {
    id:                 entry.id,
    savedAt:            entry.savedAt,
    keyword:            entry.keyword,
    category:           entry.category,
    source:             entry.source,
    groups:             entry.groups.map((g, gi) => ({
      refUrl:        g.refUrl,
      refIndex:      gi,
      items:         g.images.map((url, ii) => {
        const sessCtx = {
          keyword: entry.keyword, category: entry.category,
          setupSnapshot: entry.setupSnapshot,
          promptFull: entry.promptFull ?? entry.promptExcerpt ?? "",
        };
        const refLabel = g.refUrl ? `Reference ${gi + 1}` : "Default";
        const pin = createCompletedPin(entry.id, gi, ii, toProxyUrl(url), sessCtx, refLabel);
        return hydratePinFromStore(pin, entry.id);
      }),
      status:        g.images.length > 0
        ? "done"
        : sessionStatus === "generating" || sessionStatus === "queued" ? "generating" : "failed",
      expectedCount: entry.imagesPerRef ?? Math.max(g.images.length, 1),
    })),
    status:             sessionStatus,
    expectedTotal:      entry.expectedTotal ?? entry.totalPins,
    promptExcerpt:      entry.promptExcerpt ?? "",
    productCount:       entry.productCount,
    refCount:           entry.refCount,
    isNew:              false,
    collapsed,
    generatingGroupIdx: null,
    promptFull:         entry.promptFull,
    setupSnapshot:      entry.setupSnapshot,
    errorType:          entry.errorType,
    errorMessage:       entry.errorMessage,
    model:              "GPT Image 2",
    format:             "Pinterest 2:3",
    textOverlay:        entry.setupSnapshot?.noTextOverlay === false ? "On" : "Off",
    groupErrors:        Object.keys(groupErrors).length > 0 ? groupErrors : undefined,
  };
}

function sessionsFromHistory(entries: HistoryEntry[]): GenerationSession[] {
  return entries.map(entry => historyEntryToSession(entry, false));
}

function allowHistoryEntry(e: HistoryEntry): boolean {
  const st = deriveEntryStatus(e);
  return e.groups.some(g => g.images.length > 0) || st === "running" || st === "interrupted";
}

function rowToTier(r: OppRow)  { return (r.priority_score ?? 0) >= 70 ? "best_bet" : (r.priority_score ?? 0) >= 40 ? "steady" : "competitive"; }
function rowToTrend(r: OppRow) { return (r.yearly_change ?? 0) >= 50 ? "rising" : "evergreen"; }

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildComposerPrompt(kw: string, cat: string, hasProducts: boolean): string {
  const c = cat.toLowerCase();
  const isDecor   = c.includes("home") || c.includes("decor") || c.includes("interior");
  const isFashion = c.includes("fashion") || c.includes("apparel");
  const style     = isDecor ? "room decor" : isFashion ? "fashion" : "Pinterest-native";
  const refGuide  = "Use the selected reference as a visual direction guide for composition, subject framing, lighting, layout, and Pinterest-native aesthetic. Do not recreate the exact scene one-to-one.";
  const baseScene = isDecor
    ? "a cozy, aesthetic interior scene with soft natural lighting, styled decor details, and a polished Pinterest-native look"
    : "a polished, aesthetic scene with natural lighting and editorial styling";

  if (hasProducts && kw) {
    return [
      `Create a Pinterest-native ${style} Pin for "${kw}".`,
      "Use the uploaded product images as the main items to feature. Keep their color, shape, material, and key details recognizable.",
      refGuide,
      `Place the products naturally in ${baseScene}.`,
      "No text overlay. No typography. No watermark. Vertical 2:3 format.",
    ].join("\n\n");
  }
  if (kw) {
    return [
      `Create a Pinterest-native ${style} Pin for "${kw}".`,
      refGuide,
      `Create ${baseScene}.`,
      "No text overlay. No typography. No watermark. Vertical 2:3 format.",
    ].join("\n\n");
  }
  return "";
}

// ── Inline Dropdown ───────────────────────────────────────────────────────────

function Dropdown<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: "11px", color: D.textSec }}>{label}</span>
      <div style={{ position: "relative" }}>
        <select
          value={value as string | number}
          onChange={e => onChange((typeof value === "number" ? Number(e.target.value) : e.target.value) as T)}
          style={{
            appearance: "none", padding: "3px 20px 3px 8px", borderRadius: 6,
            border: `1px solid ${D.borderStr}`, background: D.cardElev,
            fontSize: "11px", fontWeight: 700, color: D.text, cursor: "pointer", outline: "none",
          }}
        >
          {options.map(o => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", width: 9, height: 9, color: D.textSec, pointerEvents: "none" }} />
      </div>
    </div>
  );
}

// ── Asset Section ─────────────────────────────────────────────────────────────
// Compact entry: one unified add button opens the picker. No inline upload zone.

function CompactAssetEntry({
  role, selectedUrls, onToggleUrl, onOpenPicker,
}: {
  role:         "product" | "style_reference";
  selectedUrls: string[];
  onToggleUrl:  (url: string) => void;
  onOpenPicker: () => void;
}) {
  const isProduct   = role === "product";
  const testSection = isProduct ? "products-asset-section" : "refs-asset-section";
  const testAddBtn  = isProduct ? "add-product-images" : "add-pin-references";
  const testSelected = isProduct ? "selected-products" : "selected-refs";
  const title    = isProduct ? "Products" : "References";
  const addLabel = isProduct ? "Add product images" : "Add pin references";
  const thumbW   = isProduct ? 28 : 22;
  const thumbH   = isProduct ? 28 : 30;

  return (
    <div
      data-testid={testSection}
      style={{
        flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
        padding: "10px 10px 8px", borderRadius: 10,
        border: `1.5px dashed ${D.borderStr}`, background: D.cardElev,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: D.text }}>{title}</span>
        <span data-testid={`${testSection}-count`} style={{ fontSize: "10px", fontWeight: 600, color: D.textSec }}>
          ({selectedUrls.length})
        </span>
      </div>

      {selectedUrls.length > 0 && (
        <div data-testid={testSelected} style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
          {selectedUrls.map((url, i) => (
            <div key={i} style={{ position: "relative", flexShrink: 0, width: thumbW, height: thumbH }}>
              <div style={{ width: "100%", height: "100%", borderRadius: 5, overflow: "hidden", border: `1px solid ${D.borderStr}`, position: "absolute", inset: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={toProxyUrl(url)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              </div>
              <button
                type="button"
                onClick={() => onToggleUrl(url)}
                style={{
                  position: "absolute", top: 1, right: 1, width: 12, height: 12, borderRadius: "50%",
                  background: "rgba(0,0,0,0.75)", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1,
                }}
              >
                <X style={{ width: 7, height: 7, color: "#fff" }} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        data-testid={testAddBtn}
        onClick={onOpenPicker}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
          width: "100%", padding: "6px 8px", borderRadius: 7,
          border: `1px solid ${D.border}`, background: D.card,
          cursor: "pointer", fontSize: "11px", fontWeight: 600, color: D.textSec,
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = D.accent; e.currentTarget.style.color = D.text; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = D.border; e.currentTarget.style.color = D.textSec; }}
      >
        <Plus style={{ width: 10, height: 10 }} /> {addLabel}
      </button>
    </div>
  );
}

// ── Opportunity Drawer ────────────────────────────────────────────────────────

type OppDrawerTab = "recommended" | "recent";

function OpportunityDrawer({ open, onClose, onSelect }: {
  open: boolean; onClose: () => void; onSelect: (o: Opportunity) => void;
}) {
  const [opps,       setOpps]       = useState<OppRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [q,          setQ]          = useState("");
  const [tab,        setTab]        = useState<OppDrawerTab>("recommended");
  const [recentOpps, setRecentOpps] = useState<Opportunity[]>([]);

  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem("vbp:recent_opps");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setRecentOpps(JSON.parse(raw) as Opportunity[]);
    } catch { /* noop */ }
  }, [open]);

  useEffect(() => {
    if (!open || opps.length) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.resolve(
      supabase.from("trend_keywords")
        .select("id,keyword,category,priority_score,yearly_change")
        .eq("status", "active")
        .order("priority_score", { ascending: false })
        .limit(80)
    ).then(({ data }) => { setOpps((data ?? []) as OppRow[]); setLoading(false); })
     .catch(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleSelect(o: Opportunity) {
    try {
      const prev: Opportunity[] = JSON.parse(localStorage.getItem("vbp:recent_opps") ?? "[]");
      const updated = [o, ...prev.filter(r => r.keyword !== o.keyword)].slice(0, 8);
      localStorage.setItem("vbp:recent_opps", JSON.stringify(updated));
    } catch { /* noop */ }
    onSelect(o);
    onClose();
  }

  const baseRows: OppRow[] = tab === "recent"
    ? recentOpps.map(r => ({ id: r.keyword, keyword: r.keyword, category: r.category, priority_score: r.tier === "best_bet" ? 80 : 50, yearly_change: null }))
    : opps;
  const filtered = q.trim()
    ? baseRows.filter(o => o.keyword.toLowerCase().includes(q.toLowerCase()) || o.category.toLowerCase().includes(q.toLowerCase()))
    : baseRows;

  if (!open) return null;

  const tabs: { id: OppDrawerTab; label: string }[] = [
    { id: "recommended", label: "Recommended" },
    { id: "recent",      label: "Recent" },
  ];

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.6)" }} onClick={onClose} />
      <div style={{
        position: "fixed", right: 0, top: 0, bottom: 0, zIndex: 301,
        width: "min(420px,96vw)", background: D.card,
        display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 40px rgba(0,0,0,0.4)",
        borderRadius: "16px 0 0 16px",
        border: `1px solid ${D.border}`,
      }}>
        <div style={{ padding: "18px 20px 0", borderBottom: `1px solid ${D.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <p style={{ margin: "0 0 2px", fontSize: "16px", fontWeight: 800, color: D.text }}>Choose Opportunity</p>
              <p style={{ margin: 0, fontSize: "12px", color: D.textSec }}>Add an optional market angle for this generation.</p>
            </div>
            <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: D.textSec, padding: 4 }}>
              <X style={{ width: 17, height: 17 }} />
            </button>
          </div>
          <div style={{ display: "flex" }}>
            {tabs.map(t => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                style={{ padding: "8px 14px", background: "none", border: "none", borderBottom: tab === t.id ? `2px solid ${D.accent}` : "2px solid transparent", fontSize: "12px", fontWeight: tab === t.id ? 700 : 500, color: tab === t.id ? D.accent : D.textSec, cursor: "pointer" }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: "10px 20px 8px", borderBottom: `1px solid ${D.border}`, flexShrink: 0 }}>
          <div style={{ position: "relative" }}>
            <Search style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 13, height: 13, color: D.textSec, pointerEvents: "none" }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search opportunities…"
              style={{ width: "100%", boxSizing: "border-box", paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 8, border: `1px solid ${D.border}`, fontSize: "12px", color: D.text, outline: "none", background: D.cardElev }} />
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
          {tab === "recent" && recentOpps.length === 0 ? (
            <p style={{ textAlign: "center", padding: "30px 0", fontSize: "13px", color: D.textSec }}>No recent opportunities yet</p>
          ) : (loading && tab !== "recent") ? (
            [1,2,3,4,5].map(i => <div key={i} style={{ height: 78, borderRadius: 10, background: D.cardElev, marginBottom: 6, animation: "pulse 1.5s ease-in-out infinite" }} />)
          ) : filtered.length === 0 ? (
            <p style={{ textAlign: "center", padding: "30px 0", fontSize: "13px", color: D.textSec }}>No results</p>
          ) : filtered.map(row => {
            const tier = rowToTier(row);
            const trend = rowToTrend(row);
            const tc = TIER_COLOR[tier];
            const vc = TREND_COLOR[trend];
            return (
              <button key={row.id} type="button"
                onClick={() => handleSelect({ keyword: row.keyword, category: row.category, tier, trend })}
                style={{ width: "100%", textAlign: "left", padding: "10px 12px", borderRadius: 10, border: `1px solid ${D.border}`, background: D.cardElev, cursor: "pointer", marginBottom: 6, display: "flex", flexDirection: "column", gap: 5 }}
                onMouseEnter={e => { e.currentTarget.style.background = D.card; e.currentTarget.style.borderColor = D.borderStr; }}
                onMouseLeave={e => { e.currentTarget.style.background = D.cardElev; e.currentTarget.style.borderColor = D.border; }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <p style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: D.text, textTransform: "capitalize", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{row.keyword}</p>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <span style={{ fontSize: "9px", fontWeight: 700, color: tc, background: `${tc}20`, padding: "2px 7px", borderRadius: 20 }}>{TIER_LABEL[tier]}</span>
                    <span style={{ fontSize: "9px", fontWeight: 700, color: vc, background: `${vc}20`, padding: "2px 7px", borderRadius: 20, textTransform: "capitalize" }}>{trend}</span>
                  </div>
                </div>
                <p style={{ margin: 0, fontSize: "10px", color: D.textSec, textTransform: "capitalize" }}>{row.category.replace(/-/g, " ")}</p>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── Masonry Pin Feed ──────────────────────────────────────────────────────────

function MasonryPinFeed({
  sessions, filter,
  onFilterChange,
  onAddToPlan, onAddAllToPlan, onRegeneratePin, onRegenerateGroup,
  pinDetailOpen, pinDetailInitialTab, pinDetail, metadataForm, pinDetailsGenStatus, readinessLabel, isDirty, showSaved,
  onOpenPinDetail, onClosePinDetail, onRetryGenerateDetails,
  onMetadataChange, onSelectTitleCandidate, onRegenerateTitles, onRegenerateDescription, onSavePinMetadata,
  onPinDetailAddToPlan, onPinDetailRegenerate, onPinDetailSaveAsReference,
  onPinDetailRetryPin, onPinDetailRetryGroup, onPinDetailReuseSetup, onPinDetailViewSetup,
  onPinDetailRegenerateWithRemix,
  selectedPinKeys, onTogglePinSelect, onClearSelection, onOpenBatchEdit, onBatchGenerateMetadata, onAddSelectedToPlan,
  batchEditOpen, batchPins, onCloseBatchEdit, onBatchApply, onBatchGenerateFromDrawer,
}: {
  sessions:            GenerationSession[];
  filter:              FeedFilter;
  onFilterChange:      (f: FeedFilter) => void;
  onAddToPlan:         (sessionId: string, gi: number, pi: number) => void;
  onAddAllToPlan:      (sessionId: string) => void;
  onRegeneratePin:     (sessionId: string, gi: number, pi: number) => void;
  onRegenerateGroup:   (sessionId: string, gi: number) => void;
  pinDetailOpen:       boolean;
  pinDetailInitialTab: DrawerTab;
  pinDetail:           PinDetailView | null;
  metadataForm:        PinMetadataFormState | null;
  pinDetailsGenStatus: PinDetailsGenStatus;
  readinessLabel:      ReturnType<typeof metadataReadinessLabel>;
  isDirty:             boolean;
  showSaved:           boolean;
  onOpenPinDetail:     (sessionId: string, entryKey: string, tab?: DrawerTab) => void;
  onClosePinDetail:    () => void;
  onRetryGenerateDetails: () => void;
  onMetadataChange:    (patch: Partial<PinMetadataFormState>) => void;
  onSelectTitleCandidate: (title: string) => void;
  onRegenerateTitles: () => void;
  onRegenerateDescription: () => void;
  onSavePinMetadata:   () => void;
  onPinDetailAddToPlan: () => void;
  onPinDetailRegenerate: () => void;
  onPinDetailSaveAsReference: () => void;
  onPinDetailRetryPin: () => void;
  onPinDetailRetryGroup: () => void;
  onPinDetailReuseSetup: () => void;
  onPinDetailViewSetup: () => void;
  onPinDetailRegenerateWithRemix: (remixSetup: RemixDraftSetup) => void;
  selectedPinKeys:     Set<string>;
  onTogglePinSelect:   (entryKey: string) => void;
  onClearSelection:    () => void;
  onOpenBatchEdit:     () => void;
  onBatchGenerateMetadata: () => void;
  onAddSelectedToPlan: () => void;
  batchEditOpen:       boolean;
  batchPins:           BatchPinRow[];
  onCloseBatchEdit:    () => void;
  onBatchApply:        (opts: Parameters<BatchEditDrawerProps["onApply"]>[0]) => void;
  onBatchGenerateFromDrawer: (overwriteEdited: boolean) => void;
}) {
  const tabs: { id: FeedFilter; label: string }[] = [
    { id: "all",        label: "All" },
    { id: "generating", label: "Generating" },
    { id: "completed",  label: "Completed" },
    { id: "failed",     label: "Failed" },
    { id: "added",      label: "Added to Plan" },
  ];
  const feedItems = flattenFeedItems(sessions, filter);
  const isEmpty   = sessions.length === 0;
  const hasPins   = feedItems.length > 0;

  return (
    <div
      data-testid="generation-feed"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: D.bg, position: "relative" }}
    >
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 16px", borderBottom: `1px solid ${D.border}`, flexShrink: 0, background: D.surface,
      }}>
        <div style={{ display: "flex", overflowX: "auto" }}>
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              data-testid={`feed-tab-${t.id}`}
              onClick={() => onFilterChange(t.id)}
              style={{
                padding: "12px 14px", background: "none", border: "none", flexShrink: 0,
                borderBottom: filter === t.id ? `2px solid ${D.purple}` : "2px solid transparent",
                fontSize: "12px", fontWeight: filter === t.id ? 700 : 500,
                color: filter === t.id ? D.text : D.textSec, cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {selectedPinKeys.size > 0 && (
          <div data-testid="batch-toolbar" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: `1px solid ${D.border}`, background: D.cardElev, flexShrink: 0, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: D.text }}>{selectedPinKeys.size} selected</span>
            <button type="button" data-testid="generate-pin-details-button" onClick={onBatchGenerateMetadata} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${D.border}`, background: "none", color: D.textSec, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Generate Pin Details</button>
            <button type="button" data-testid="batch-edit-details-button" onClick={onOpenBatchEdit} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${D.border}`, background: "none", color: D.textSec, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Batch Edit Details</button>
            <button type="button" data-testid="batch-add-selected" onClick={onAddSelectedToPlan} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: D.gradient, color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Add selected to Plan</button>
            <button type="button" data-testid="batch-clear-selection" onClick={onClearSelection} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${D.border}`, background: "none", color: D.textMuted, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Clear selection</button>
          </div>
        )}
      </div>

      <div className="studio-scroll" style={{ flex: 1, overflowY: "auto", padding: isEmpty ? 0 : "14px 16px 18px" }}>
        {isEmpty ? (
          <div
            data-testid="generation-feed-empty"
            style={{
              height: "100%", display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", padding: "40px 32px", textAlign: "center",
            }}
          >
            <div style={{
              width: 120, height: 120, borderRadius: 20, marginBottom: 20,
              background: `linear-gradient(145deg, ${D.purpleBg} 0%, rgba(59,130,246,0.08) 100%)`,
              border: `1px solid ${D.border}`, display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <Sparkles style={{ width: 44, height: 44, color: D.purple }} />
            </div>
            <p style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 800, color: D.text }}>
              Your generated Pins will appear here
            </p>
            <p style={{ margin: "0 0 20px", fontSize: "13px", color: D.textSec, lineHeight: 1.6, maxWidth: 360 }}>
              Add product images, Pin references, and a prompt to create your first Pin set.
            </p>
            <button
              type="button"
              data-testid="how-it-works-btn"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "8px 16px", borderRadius: 20,
                border: `1px solid ${D.borderStr}`, background: D.cardElev,
                fontSize: "12px", fontWeight: 600, color: D.textSec, cursor: "pointer",
              }}
            >
              <Play style={{ width: 12, height: 12 }} /> How it works
            </button>
          </div>
        ) : !hasPins ? (
          <div style={{ padding: "48px 20px", textAlign: "center" }}>
            <p style={{ margin: 0, fontSize: "13px", color: D.textSec }}>No generations in this tab yet.</p>
          </div>
        ) : (
          <div data-testid="pin-feed-grid" className="pin-feed-grid" style={{ width: "100%" }}>
            {feedItems.map(({ entry, session }) => (
              <PinCard
                key={entry.key}
                entry={entry}
                session={session}
                isSelected={selectedPinKeys.has(entry.key)}
                onToggleSelect={(e) => { e.stopPropagation(); onTogglePinSelect(entry.key); }}
                onOpenDetails={() => onOpenPinDetail(session.id, entry.key, "preview")}
                onAddToPlan={(e) => {
                  e.stopPropagation();
                  if (entry.status === "failed" || entry.status === "generating") return;
                  onOpenPinDetail(session.id, entry.key, "plan");
                }}
                onView={(e) => {
                  e.stopPropagation();
                  onOpenPinDetail(session.id, entry.key, "preview");
                }}
                onRemix={(e) => {
                  e.stopPropagation();
                  onOpenPinDetail(session.id, entry.key, "remix");
                }}
                onRegenerate={(e) => {
                  e.stopPropagation();
                  if (entry.pinIdx === undefined) return;
                  onRegeneratePin(session.id, entry.groupIdx, entry.pinIdx);
                }}
                onRetry={entry.status === "failed" ? (e) => { e.stopPropagation(); onRegenerateGroup(session.id, entry.groupIdx); } : undefined}
                onAddAllToPlan={() => onAddAllToPlan(session.id)}
                onRegenerateSet={() => session.groups.forEach((_, gi) => onRegenerateGroup(session.id, gi))}
              />
            ))}
          </div>
        )}
      </div>

      <PinDetailsDrawer
        open={pinDetailOpen}
        initialTab={pinDetailInitialTab}
        detail={pinDetail}
        metadataForm={metadataForm}
        pinDetailsGenStatus={pinDetailsGenStatus}
        readinessLabel={readinessLabel}
        isDirty={isDirty}
        showSaved={showSaved}
        onClose={onClosePinDetail}
        onRetryGenerateDetails={onRetryGenerateDetails}
        onMetadataChange={onMetadataChange}
        onSelectTitleCandidate={onSelectTitleCandidate}
        onRegenerateTitles={onRegenerateTitles}
        onRegenerateDescription={onRegenerateDescription}
        onSaveChanges={onSavePinMetadata}
        onAddToPlan={onPinDetailAddToPlan}
        onRegenerate={onPinDetailRegenerate}
        onSaveAsReference={onPinDetailSaveAsReference}
        onRetryPin={onPinDetailRetryPin}
        onRetryGroup={onPinDetailRetryGroup}
        onReuseSetup={onPinDetailReuseSetup}
        onViewSetup={onPinDetailViewSetup}
        onRegenerateWithRemix={onPinDetailRegenerateWithRemix}
      />
      <BatchEditDrawer
        open={batchEditOpen}
        pins={batchPins}
        onClose={onCloseBatchEdit}
        onApply={onBatchApply}
        onGenerateMetadata={onBatchGenerateFromDrawer}
      />
    </div>
  );
}

// ── Planning status badge ─────────────────────────────────────────────────────

// ── Edit Details Drawer ───────────────────────────────────────────────────────

function EditDetailsDrawer({ pin, open, onClose, onSave }: {
  pin: StudioPin; open: boolean; onClose: () => void; onSave: (u: StudioPin) => void;
}) {
  const [title,       setTitle]       = useState(pin.title);
  const [description, setDescription] = useState(pin.description);
  const [altText,     setAltText]     = useState(pin.altText);
  const [destUrl,     setDestUrl]     = useState(pin.destinationUrl);
  const [plannedDate, setPlannedDate] = useState(pin.plannedDate);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle(pin.title); setDescription(pin.description);
      setAltText(pin.altText); setDestUrl(pin.destinationUrl);
      setPlannedDate(pin.plannedDate);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pin.id]);

  function handleSave() {
    const updated: StudioPin = {
      ...pin,
      title: title.trim(), description: description.trim(),
      altText: altText.trim(), destinationUrl: destUrl.trim(), plannedDate: plannedDate.trim(),
    };
    if (pin.planningStatus !== "not_added" && pin.planningStatus !== "posted" && pin.planningStatus !== "skipped") {
      updated.planningStatus = (!!updated.title && !!updated.description && !!updated.plannedDate) ? "ready" : "needs_review";
    }
    const existingDraft = pinDraftStore.getDraftByImageUrl(pin.url);
    if (existingDraft) pinDraftStore.updateDraft(existingDraft.id, { title: updated.title, description: updated.description, altText: updated.altText, destinationUrl: updated.destinationUrl });
    onSave(updated);
    onClose();
  }

  if (!open) return null;

  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 9,
    border: `1.5px solid ${D.border}`, fontSize: "13px", color: D.text,
    outline: "none", fontFamily: "inherit", background: D.cardElev,
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.6)" }} onClick={onClose} />
      <div style={{
        position: "fixed", right: 0, top: 0, bottom: 0, zIndex: 301,
        width: "min(420px,96vw)", background: D.card,
        display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 40px rgba(0,0,0,0.4)",
        borderRadius: "16px 0 0 16px",
        border: `1px solid ${D.border}`,
      }}>
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${D.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <p style={{ margin: "0 0 3px", fontSize: "16px", fontWeight: 800, color: D.text }}>Edit Pin Details</p>
              <p style={{ margin: 0, fontSize: "12px", color: D.textSec }}>Update Pin Details for this generated pin.</p>
            </div>
            <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: D.textSec, padding: 4 }}>
              <X style={{ width: 17, height: 17 }} />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {pin.url && (
            <div style={{ width: "100%", maxWidth: 140, margin: "0 auto" }}>
              <div style={{ aspectRatio: "2/3", borderRadius: 10, overflow: "hidden", border: `1px solid ${D.border}`, background: D.cardElev }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={toProxyUrl(pin.url)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
            </div>
          )}
          {[
            { label: "Pin Title *", value: title, set: setTitle, type: "input", ph: "Enter a compelling pin title…" },
            { label: "Alt Text",    value: altText, set: setAltText, type: "input", ph: "Describe the image for accessibility…" },
            { label: "Destination URL", value: destUrl, set: setDestUrl, type: "input", ph: "https://your-shop.com/product…" },
          ].map(({ label: l, value: v, set, type, ph }) => (
            <div key={l} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: "11px", fontWeight: 700, color: D.textSec }}>{l}</label>
              {type === "input"
                ? <input value={v} onChange={e => set(e.target.value)} placeholder={ph} style={fieldStyle}
                    onFocus={e => (e.currentTarget.style.borderColor = D.accent)}
                    onBlur={e => (e.currentTarget.style.borderColor = D.border)} />
                : <textarea value={v} onChange={e => set(e.target.value)} placeholder={ph} rows={3}
                    style={{ ...fieldStyle, resize: "vertical" }}
                    onFocus={e => (e.currentTarget.style.borderColor = D.accent)}
                    onBlur={e => (e.currentTarget.style.borderColor = D.border)} />
              }
            </div>
          ))}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: "11px", fontWeight: 700, color: D.textSec }}>Description *</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Describe what's in this pin…" rows={3}
              style={{ ...fieldStyle, resize: "vertical" }}
              onFocus={e => (e.currentTarget.style.borderColor = D.accent)}
              onBlur={e => (e.currentTarget.style.borderColor = D.border)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: "11px", fontWeight: 700, color: D.textSec }}>Planned Date *</label>
            <input type="date" value={plannedDate} onChange={e => setPlannedDate(e.target.value)} style={fieldStyle}
              onFocus={e => (e.currentTarget.style.borderColor = D.accent)}
              onBlur={e => (e.currentTarget.style.borderColor = D.border)} />
          </div>
        </div>
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${D.border}`, flexShrink: 0, display: "flex", gap: 8 }}>
          <button type="button" onClick={onClose}
            style={{ flex: 1, padding: "10px", borderRadius: 9, border: `1px solid ${D.border}`, background: "none", color: D.textSec, fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={handleSave}
            style={{ flex: 2, padding: "10px", borderRadius: 9, border: "none", background: D.gradient, color: "#fff", fontSize: "13px", fontWeight: 800, cursor: "pointer" }}>
            Save Changes
          </button>
        </div>
      </div>
    </>
  );
}

// ── Pin Card (completed / failed / generating / queued) ───────────────────────

function PinCard({
  entry, session, isSelected, onToggleSelect, onOpenDetails, onAddToPlan, onView, onRemix, onRegenerate, onRetry, onAddAllToPlan, onRegenerateSet,
}: {
  entry: MasonryPinEntry;
  session: GenerationSession;
  isSelected: boolean;
  onToggleSelect: (e: React.MouseEvent) => void;
  onOpenDetails: () => void;
  onAddToPlan: (e: React.MouseEvent) => void;
  onView: (e: React.MouseEvent) => void;
  onRemix: (e: React.MouseEvent) => void;
  onRegenerate?: (e: React.MouseEvent) => void;
  onRetry?: (e: React.MouseEvent) => void;
  onAddAllToPlan: () => void;
  onRegenerateSet: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const isPlaceholder = entry.status === "generating" || entry.status === "failed";
  const variant = entry.placeholderVariant ?? (entry.status === "failed" ? "failed" : "generating");
  const pin = entry.pin;
  const isAdded = pin ? pin.planningStatus !== "not_added" : false;
  const dlName = pin ? `vibepin-${session.id.slice(-8)}-${pin.id.slice(-6)}.png` : "";
  const metaLabel = pin && !isPlaceholder ? metadataReadinessLabel(pin) : null;
  const badgeLabel = isPlaceholder
    ? (variant === "failed" ? "Failed" : "Generating")
    : (metaLabel ?? "Completed");
  const badgeColor = isPlaceholder
    ? (variant === "failed" ? D.error : D.purple)
    : (metaLabel === "Ready" || metaLabel === "Added to Plan" ? D.success : metaLabel?.startsWith("Missing") ? D.warning : D.purple);
  const canAddSet = sessionHasAddablePins(session);
  const actionBtn: React.CSSProperties = {
    padding: "5px 8px", borderRadius: 7, border: "none",
    background: "rgba(8,13,25,0.82)", color: "#E2E8F0",
    fontSize: "9px", fontWeight: 700, cursor: "pointer", backdropFilter: "blur(8px)",
  };
  const placeholderCfg = {
    generating: { bg: "linear-gradient(145deg, rgba(124,58,237,0.16), rgba(11,16,32,0.98))", color: D.purple, text: "Still generating" },
    queued:     { bg: "linear-gradient(145deg, rgba(74,85,104,0.22), rgba(11,16,32,0.98))", color: D.textMuted, text: "Queued" },
    failed:     { bg: "linear-gradient(145deg, rgba(239,68,68,0.2), rgba(11,16,32,0.98))", color: D.error, text: "Failed to generate" },
  }[variant];

  return (
    <article
      data-testid={isPlaceholder ? "placeholder-card" : "generated-pin-card"}
      title={`Generated Set ${session.id.slice(-8)}`}
      onClick={onOpenDetails}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setMoreOpen(false); }}
      style={{
        position: "relative", borderRadius: 12, overflow: "hidden", cursor: "pointer",
        border: `1px solid ${hover ? "rgba(124,58,237,0.45)" : D.border}`,
        background: D.cardElev, minWidth: 0, width: "100%",
        boxShadow: hover ? "0 10px 24px rgba(0,0,0,0.32)" : "0 4px 14px rgba(0,0,0,0.18)",
        transition: "box-shadow 0.15s ease, border-color 0.15s ease",
      }}
    >
      <div style={{ position: "relative", width: "100%", aspectRatio: "2/3", background: "#0B1020", overflow: "hidden" }}>
        {!isPlaceholder && pin && (
          <button type="button" data-testid="pin-select-checkbox" onClick={onToggleSelect}
            style={{
              position: "absolute", top: 8, right: 8, zIndex: 3, width: 18, height: 18, borderRadius: 4,
              border: `1.5px solid ${isSelected ? D.purple : "rgba(255,255,255,0.5)"}`,
              background: isSelected ? D.purple : "rgba(8,13,25,0.72)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
            {isSelected && <CheckCircle2 style={{ width: 12, height: 12, color: "#fff" }} />}
          </button>
        )}
        {isPlaceholder ? (
          <div style={{
            position: "absolute", inset: 0, background: placeholderCfg.bg,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10,
          }}>
            {(variant === "generating" || variant === "queued") && (
              <div className="feed-shimmer" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
            )}
            {variant === "failed" ? (
              <AlertCircle style={{ width: 28, height: 28, color: D.error, position: "relative" }} />
            ) : (
              <div style={{ width: 32, height: 32, border: `3px solid ${placeholderCfg.color}40`, borderTopColor: placeholderCfg.color, borderRadius: "50%", animation: "spin 0.8s linear infinite", position: "relative" }} />
            )}
            <p style={{ margin: 0, fontSize: "11px", color: variant === "failed" ? D.error : D.text, fontWeight: 800, position: "relative", textAlign: "center", padding: "0 10px" }}>
              {placeholderCfg.text}
            </p>
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={toProxyUrl(pin!.url)}
            alt="Generated pin"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={e => {
              const el = e.currentTarget;
              if (!el.dataset.fallback) {
                el.dataset.fallback = "1";
                const proxy = `/api/storage-image?path=studio/${pin!.url.split("/").pop()}`;
                if (el.src !== proxy) { el.src = proxy; return; }
              }
              el.style.opacity = "0.25";
            }}
          />
        )}
        <span style={{
          position: "absolute", top: 8, left: 8, display: "inline-flex", alignItems: "center", gap: 4,
          padding: "3px 7px", borderRadius: 999, fontSize: "9px", fontWeight: 800,
          color: "#EAFDF5", background: "rgba(8,13,25,0.78)", backdropFilter: "blur(8px)",
          border: `1px solid ${badgeColor}55`,
        }}>
          {!isPlaceholder && <CheckCircle2 style={{ width: 10, height: 10, color: badgeColor }} />}
          {badgeLabel}
        </span>
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0, padding: hover && !isPlaceholder ? "36px 8px 8px" : "8px",
          background: "linear-gradient(180deg, transparent 0%, rgba(8,13,25,0.88) 72%)",
          transition: "padding 0.15s ease",
        }}>
          <p style={{ margin: "0 0 1px", fontSize: "10px", fontWeight: 700, color: "#F1F5F9" }}>{entry.refLabel}</p>
          <p style={{ margin: 0, fontSize: "9px", fontWeight: 500, color: "rgba(226,232,240,0.72)" }}>
            Pinterest 2:3 · {formatPinDate(entry.createdAt)}
          </p>
          {variant === "failed" && onRetry && (
            <button type="button" onClick={e => { e.stopPropagation(); onRetry?.(e); }}
              style={{ marginTop: 6, padding: "4px 8px", borderRadius: 6, border: `1px solid rgba(239,68,68,0.45)`, background: "rgba(239,68,68,0.18)", color: "#FCA5A5", fontSize: "9px", fontWeight: 800, cursor: "pointer" }}>
              Retry this Pin
            </button>
          )}
        </div>
        {hover && !isPlaceholder && pin && (
          <div style={{
            position: "absolute", left: 8, right: 8, bottom: 8,
            display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap",
          }}>
            <button type="button" onClick={onAddToPlan} disabled={isAdded} style={{ ...actionBtn, opacity: isAdded ? 0.65 : 1 }}>
              {isAdded ? "Added" : "Add to Plan"}
            </button>
            <button type="button" title="View" data-testid="pin-card-view-btn" onClick={onView} style={actionBtn}>View</button>
            <a href={toProxyUrl(pin.url)} download={dlName} title="Download" style={{ ...actionBtn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              ↓
            </a>
            <div style={{ position: "relative", marginLeft: "auto" }}>
              <button type="button" title="More" onClick={e => { e.stopPropagation(); setMoreOpen(v => !v); }} style={{ ...actionBtn, width: 28, height: 28, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <MoreVertical style={{ width: 12, height: 12 }} />
              </button>
              {moreOpen && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={() => setMoreOpen(false)} />
                  <div style={{
                    position: "absolute", right: 0, bottom: "calc(100% + 4px)", zIndex: 31,
                    minWidth: 168, background: D.cardElev, border: `1px solid ${D.borderStr}`,
                    borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.35)", overflow: "hidden",
                  }}>
                    <p style={{ margin: 0, padding: "7px 10px 4px", fontSize: "9px", fontWeight: 600, color: D.textMuted, borderBottom: `1px solid ${D.border}` }}>
                      Set {session.id.slice(-8)}
                    </p>
                    {canAddSet && (
                      <button type="button" onClick={() => { onAddAllToPlan(); setMoreOpen(false); }}
                        style={{ display: "block", width: "100%", padding: "7px 10px", border: "none", background: "none", textAlign: "left", fontSize: "10px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
                        Add completed to Plan
                      </button>
                    )}
                    <button type="button" data-testid="pin-card-remix-btn" onClick={e => { onRemix(e); setMoreOpen(false); }}
                      style={{ display: "block", width: "100%", padding: "7px 10px", border: "none", background: "none", textAlign: "left", fontSize: "10px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
                      Remix
                    </button>
                    <button type="button" onClick={e => { onRegenerate?.(e); setMoreOpen(false); }}
                      style={{ display: "block", width: "100%", padding: "7px 10px", border: "none", background: "none", textAlign: "left", fontSize: "10px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
                      Regenerate
                    </button>
                    <button type="button" onClick={() => { onRegenerateSet(); setMoreOpen(false); }}
                      style={{ display: "block", width: "100%", padding: "7px 10px", border: "none", background: "none", textAlign: "left", fontSize: "10px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
                      Regenerate set
                    </button>
                    <button type="button" onClick={() => { toast.success("Saved as reference."); setMoreOpen(false); }}
                      style={{ display: "block", width: "100%", padding: "7px 10px", border: "none", background: "none", textAlign: "left", fontSize: "10px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
                      Save as Reference
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

// ── Main content ──────────────────────────────────────────────────────────────

function CreatePinsContent() {
  const searchParams = useSearchParams();
  const router       = useRouter();

  const [products,        setProducts]        = useState<string[]>([]);
  const [refs,            setRefs]            = useState<string[]>([]);
  const [prompt,          setPrompt]          = useState("");
  const [count,           setCount]           = useState(2);
  const [textOverlay,     setTextOverlay]     = useState<"off" | "on">("off");
  const [format,          setFormat]          = useState("Pinterest 2:3");
  const [model,           setModel]           = useState("GPT Image 2");
  const [opportunity,     setOpportunity]     = useState<Opportunity | null>(null);
  const [rightPanelMode,  setRightPanelMode]  = useState<RightPanelMode>("feed");
  const [oppDrawerOpen,   setOppDrawerOpen]   = useState(false);
  const [generating,      setGenerating]      = useState(false);
  const [sessions,        setSessions]        = useState<GenerationSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [wsEntry,         setWsEntry]         = useState(false);
  const [wsPrimLabel,     setWsPrimLabel]     = useState("");
  const [wsTrendLabel,    setWsTrendLabel]    = useState("");
  const [feedFilter,      setFeedFilter]      = useState<FeedFilter>("all");
  const [pinDetailSelection, setPinDetailSelection] = useState<{ sessionId: string; entryKey: string; initialTab?: DrawerTab } | null>(null);
  const [metadataForm,    setMetadataForm]    = useState<PinMetadataFormState | null>(null);
  const [metadataFormTouched, setMetadataFormTouched] = useState<Partial<MetadataTouchedFlags>>({});
  const [selectedPinKeys, setSelectedPinKeys] = useState<Set<string>>(new Set());
  const [batchEditOpen,   setBatchEditOpen]   = useState(false);
  const [pinDetailsGenStatus, setPinDetailsGenStatus] = useState<PinDetailsGenStatus>("idle");
  const [formBaseline,    setFormBaseline]    = useState<PinMetadataFormState | null>(null);
  const [showSaved,       setShowSaved]       = useState(false);

  const promptManuallyEdited = useRef(false);
  const pinDetailsGenRef     = useRef<string | null>(null);
  const sessionRestoredRef   = useRef(false);
  const [interactive, setInteractive] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setInteractive(true); }, []);

  // Pre-warm Product Ideas cache the moment the studio page mounts, so data is
  // ready (or in-flight) before the user opens the picker.
  useEffect(() => { void preload(PRODUCT_IDEAS_SWR_KEY, fetchProductIdeasWithMeta); }, []);

  // ── Auto-scheduling ───────────────────────────────────────────────────────────

  function getRemainingDaysOfCurrentWeek(): string[] {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = today.getDay();
    const daysUntilEnd = day === 0 ? 0 : 7 - day;
    const days: string[] = [];
    for (let i = 0; i <= daysUntilEnd; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      days.push(d.toISOString().split("T")[0]);
    }
    return days;
  }

  function assignNextAvailablePlanDate(existingDrafts: ReturnType<typeof pinDraftStore.getAllDrafts>, dailyTarget = 2): string | null {
    const days = getRemainingDaysOfCurrentWeek();
    for (const day of days) {
      const count = existingDrafts.filter(d => (d.scheduledDate ?? "") === day).length;
      if (count < dailyTarget) return day;
    }
    return null;
  }

  // ── Hydrate from prefill ──────────────────────────────────────────────────────

  function hydrate(prefill: CreatePinsPrefill) {
    const isRich = ["workspace","weekly_plan","keyword_trends","pin_opportunities"].includes(prefill.source);
    if (prefill.opportunity) {
      const o = prefill.opportunity;
      const tierCode  = o.primaryLabel === "Best Bet" ? "best_bet" : o.primaryLabel === "Competitive" ? "competitive" : "steady";
      const trendCode = (o.trendState?.toLowerCase() ?? "evergreen") as "rising" | "evergreen" | "seasonal";
      setOpportunity({ keyword: o.keyword ?? o.title, category: o.category ?? "home-decor", tier: tierCode, trend: trendCode });
      if (isRich) {
        setWsEntry(true);
        setWsPrimLabel(o.primaryLabel ?? "Steady");
        setWsTrendLabel(o.trendState ?? "Evergreen");
      }
    }
    if (prefill.productImages?.length) {
      const urls = prefill.productImages.map(p => p.imageUrl);
      prefill.productImages.forEach(p => assetStore.saveAsset({ role: "product", source: "product_signal", imageUrl: p.imageUrl, title: p.title, keyword: p.category }));
      setProducts(urls);
    }
    if (prefill.pinReferences?.length) {
      const urls = prefill.pinReferences.map(r => r.imageUrl);
      prefill.pinReferences.forEach(r => assetStore.saveAsset({ role: "style_reference", source: "viral_pin", imageUrl: r.imageUrl, keyword: r.keyword, category: r.category }));
      setRefs(urls);
    }
    const p = prefill.promptSeed || buildPromptFromPrefill(prefill);
    if (p) { setPrompt(p); promptManuallyEdited.current = false; }
  }

  useEffect(() => {
    const prefillKey = searchParams.get("prefillKey");
    if (prefillKey) {
      const prefill = loadPrefill(prefillKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (prefill) { hydrate(prefill); return; }
    }
    const draftId = searchParams.get("draft_id");
    if (draftId) {
      fetch(`/api/composer-drafts/${draftId}`)
        .then(r => r.ok ? r.json() : null)
        .then((data: Record<string, unknown> | null) => {
          if (!data) return;
          const prefill = draftToPrefill(data);
          if (prefill) hydrate(prefill);
        })
        .catch(() => {});
      return;
    }
    // Legacy URL normalization
    const rawFrom    = searchParams.get("from") ?? searchParams.get("source") ?? "";
    const sourceType = searchParams.get("sourceType") ?? "";
    const kwRaw      = [searchParams.get("keyword"), searchParams.get("opportunity"), (searchParams.get("keywords") ?? "").split(",")[0].trim() || null].find(Boolean) ?? "";
    const kw         = kwRaw ? decodeURIComponent(kwRaw) : "";
    const cat        = decodeURIComponent(searchParams.get("category") ?? "home-decor");
    const primLabel  = searchParams.get("primaryLabel") ?? searchParams.get("tier") ?? "";
    const trendSt    = searchParams.get("trendState") ?? "";
    const imageUrlRaw = searchParams.get("image_url") ?? "";
    const imageUrl   = imageUrlRaw ? decodeURIComponent(imageUrlRaw) : "";
    const prodUrlRaw = searchParams.get("product_image_url") ?? searchParams.get("product_url") ?? "";
    const prodUrl    = prodUrlRaw ? decodeURIComponent(prodUrlRaw) : "";
    const isProductSrc = rawFrom === "shop-signal" || rawFrom === "product_signals" || sourceType === "product";
    const isPinRefSrc  = sourceType === "pin" || sourceType === "reference" || rawFrom === "viral_pins" || rawFrom === "pin_opportunities";
    const isKeywordTrends = rawFrom === "keyword_trends" || rawFrom === "keyword_trend";
    const isWorkspace  = rawFrom === "workspace" || rawFrom === "batch" || sourceType === "keyword" || rawFrom === "plan" || rawFrom === "weekly_plan" || (!isProductSrc && !isPinRefSrc && !isKeywordTrends && kw !== "");
    const isFromBasket = !!searchParams.get("fromBasket");
    const legacySource: CreatePinsPrefill["source"] = isProductSrc ? "product_signals" : isPinRefSrc ? "viral_pins" : isKeywordTrends ? "keyword_trends" : isWorkspace ? "workspace" : isFromBasket ? "product_signals" : "manual";
    const prefill: CreatePinsPrefill = { source: legacySource };
    if (kw) {
      const labelNorm: "Best Bet" | "Steady" | "Competitive" = primLabel === "Best Bet" || primLabel === "best_bet" ? "Best Bet" : primLabel === "Competitive" || primLabel === "competitive" ? "Competitive" : "Steady";
      const trendNorm: "Rising" | "Evergreen" | "Seasonal"  = trendSt.toLowerCase() === "rising" ? "Rising" : trendSt.toLowerCase() === "seasonal" ? "Seasonal" : "Evergreen";
      prefill.opportunity = { title: kw, keyword: kw, category: cat, primaryLabel: labelNorm, trendState: trendNorm };
    }
    if (imageUrl && isProductSrc) {
      assetStore.saveAsset({ role: "product", source: "product_signal", imageUrl, keyword: kw || undefined });
      prefill.productImages = [{ imageUrl, source: "product_signals" }];
    }
    if (prodUrl) {
      assetStore.saveAsset({ role: "product", source: "product_signal", imageUrl: prodUrl });
      prefill.productImages = [...(prefill.productImages ?? []), { imageUrl: prodUrl, source: "product_signals" }];
    }
    if (isFromBasket) {
      const basketAssets = assetStore.getAssets().filter(a => a.role === "product").slice(0, 4);
      if (basketAssets.length > 0) prefill.productImages = basketAssets.map(a => ({ imageUrl: a.imageUrl, source: "product_signals" as const, title: a.title, category: a.keyword }));
    }
    if (imageUrl && !isProductSrc) {
      assetStore.saveAsset({ role: "style_reference", source: "viral_pin", imageUrl, keyword: kw || undefined });
      prefill.pinReferences = [{ imageUrl, source: "viral_pins" }];
    }
    hydrate(prefill);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-generate prompt — only when the user has not manually edited it.
  // Using the ref (promptManuallyEdited) rather than the state (promptTouched) to
  // avoid a race condition where React batching may commit the state update after
  // the effect re-runs triggered by a products/refs change in the same flush.
  const productsKey = products.join("\u001f");
  const refsKey = refs.join("\u001f");
  useEffect(() => {
    if (promptManuallyEdited.current) return;
    const kw  = opportunity?.keyword  ?? "";
    const cat = opportunity?.category ?? "";
    if (!products.length && !refs.length && !kw) return;
    const prefill: CreatePinsPrefill = {
      source: "manual",
      ...(kw ? { opportunity: { title: kw, keyword: kw, category: cat } } : {}),
      ...(products.length > 0 ? { productImages: products.map(url => ({ imageUrl: url, source: "uploaded" as const })) } : {}),
      ...(refs.length    > 0 ? { pinReferences: refs.map(url => ({ imageUrl: url, source: "uploaded" as const })) }     : {}),
    };
    const p = buildPromptFromPrefill(prefill);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (p) setPrompt(p);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsKey, refsKey, opportunity?.keyword, opportunity?.category]);

  // Restore generation history into the right-side feed (local + DB + storage)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;

    resolveStaleRunningEntries();

    const applySessions = (entries: HistoryEntry[]) => {
      const allowed = entries.filter(allowHistoryEntry);
      if (!allowed.length) return;
      const restored = sessionsFromHistory(allowed);
      setSessions(restored);
      setActiveSessionId(restored[0].id);
      try { sessionStorage.setItem("vbp:studio:last_session_id", restored[0].id); } catch { /* noop */ }
    };

    // Instant: localStorage history
    applySessions(loadHistory());

    // Async: merge DB + storage (same sources as /app/history)
    Promise.all([
      fetchGenerationsFromDb(supabase).catch((): HistoryEntry[] => []),
      fetch("/api/history-storage")
        .then(r => r.json())
        .then((d: { entries: HistoryEntry[] }) => d.entries ?? [])
        .catch((): HistoryEntry[] => []),
    ]).then(([db, storage]) => {
      const merged = mergeHistoryEntries(db, loadHistory(), storage);
      applySessions(merged);
    }).catch(() => { /* keep local-only results */ });
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────────

  const totalPins = (refs.length > 0 ? refs.length : 1) * count;
  const overLimit = totalPins > 12;
  const hasInput  = prompt.trim().length > 0 || products.length > 0 || refs.length > 0 || !!opportunity;
  const genLabel  = `Generate ${totalPins} Pin${totalPins !== 1 ? "s" : ""}`;

  void activeSessionId;

  function toggleProductUrl(url: string) {
    setProducts(p => p.includes(url) ? p.filter(u => u !== url) : [...p, url]);
  }

  function toggleRefUrl(url: string) {
    setRefs(r => r.includes(url) ? r.filter(u => u !== url) : [...r, url]);
  }

  // ── Generation ────────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!hasInput) { toast.error("Add a prompt, product image, or reference first."); return; }
    if (generating) return;

    setGenerating(true);
    setRightPanelMode("feed");
    const refsToProcess: Array<string | null> = refs.length > 0 ? refs : [null];
    const sessionId = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mode = products.length > 0 ? "product_led" : refs.length > 0 ? "keyword_led" : "scratch";

    const snap: SetupSnapshot = {
      mode, keyword: opportunity?.keyword, category: opportunity?.category,
      opportunityTitle: opportunity?.keyword, noTextOverlay: textOverlay === "off",
      imagesPerReference: count,
      selectedProducts:   products.map(url => ({ imageUrl: url, title: "", source: "uploaded" })),
      selectedReferences: refs.map(url => ({ imageUrl: url })),
      promptSnapshot:     prompt,
      createdFrom:        wsEntry ? "workspace" : "studio",
    };
    const runningEntry: HistoryEntry = {
      id: sessionId, savedAt: new Date().toISOString(),
      keyword: opportunity?.keyword ?? "", category: opportunity?.category ?? "",
      source: wsEntry ? "workspace" : "studio",
      groups: [], refCount: refs.length, productCount: products.length, totalPins: 0,
      status: "running", expectedTotal: totalPins, mode,
      opportunity: opportunity?.keyword, imagesPerRef: count,
      promptExcerpt: prompt.slice(0, 120), promptFull: prompt, setupSnapshot: snap,
    };
    addHistory(runningEntry);
    createRunningSessionInDb(supabase, runningEntry).catch(() => {});

    setActiveSessionId(sessionId);
    try { sessionStorage.setItem("vbp:studio:last_session_id", sessionId); } catch { /* noop */ }

    const newSession: GenerationSession = {
      id: sessionId, savedAt: new Date().toISOString(),
      keyword: opportunity?.keyword ?? "", category: opportunity?.category ?? "",
      source: wsEntry ? "workspace" : "studio",
      groups: refsToProcess.map((refUrl, idx) => ({
        refUrl, refIndex: idx, items: [], status: "generating" as const, expectedCount: count,
      })),
      status: "generating", expectedTotal: totalPins,
      promptExcerpt: prompt.slice(0, 120), productCount: products.length, refCount: refs.length,
      isNew: true, collapsed: false, generatingGroupIdx: 0,
      promptFull: prompt, setupSnapshot: snap, model, format,
      textOverlay: textOverlay === "on" ? "On" : "Off",
      groupErrors: {},
    };
    // Prepend new session, collapse old ones. Do NOT clear products/refs/prompt.
    setSessions(prev => [newSession, ...prev.map(s => ({ ...s, isNew: false, collapsed: false }))]);

    const finalGroups: RefGroup[] = refsToProcess.map((refUrl, idx) => ({
      refUrl, refIndex: idx, items: [], status: "generating" as const, expectedCount: count,
    }));
    const dbGroups: HistoryPinGroup[] = refsToProcess.map(r => ({ refUrl: r, images: [] }));
    const groupErrors: Record<number, { message?: string; errorType?: GenerationErrorType }> = {};
    let totalGenerated = 0;
    let sessionErrorMessage: string | undefined;

    for (let i = 0; i < refsToProcess.length; i++) {
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status: "generating", generatingGroupIdx: i } : s));
      const ref = refsToProcess[i];
      try {
        const resp = await fetch("/api/generate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyword:  opportunity?.keyword ?? "Pinterest content",
            style:    "editorial", count, prompt,
            category: opportunity?.category ?? "home-decor",
            ...(ref             ? { style_ref: ref }           : {}),
            ...(products.length ? { product_images: products } : {}),
          }),
        });
        const data = await resp.json() as { urls?: string[]; error?: string };
        if (data.urls?.length) {
          const sessCtx = { keyword: opportunity?.keyword ?? "", category: opportunity?.category ?? "", setupSnapshot: snap, promptFull: prompt };
          const refLabel = ref ? `Reference ${i + 1}` : products.length > 0 ? "Product" : "No product";
          finalGroups[i] = { ...finalGroups[i], items: data.urls.map((url, ii) => createCompletedPin(sessionId, i, ii, url, sessCtx, refLabel)), status: "done" };
          dbGroups[i]    = { refUrl: ref, images: data.urls };
          totalGenerated += data.urls.length;
        } else {
          const errMsg = data.error ?? "No images returned";
          finalGroups[i] = { ...finalGroups[i], status: "failed" };
          groupErrors[i] = { message: errMsg, errorType: "unknown_error" };
          sessionErrorMessage = errMsg;
          toast.error(`Reference ${i + 1} failed`, { description: errMsg });
        }
      } catch (err) {
        const errMsg = String(err);
        finalGroups[i] = { ...finalGroups[i], status: "failed" };
        groupErrors[i] = { message: errMsg, errorType: "unknown_error" };
        sessionErrorMessage = errMsg;
        toast.error("Network error", { description: errMsg });
      }
      setSessions(prev => prev.map(s => s.id === sessionId ? {
        ...s, groups: [...finalGroups],
        groupErrors: { ...groupErrors },
        errorMessage: sessionErrorMessage,
      } : s));
      addHistory({ ...runningEntry, groups: dbGroups, totalPins: totalGenerated, status: totalGenerated > 0 ? "partial" : "running" });
      updateSessionInDb(supabase, sessionId, { groups_json: dbGroups, total_pins: totalGenerated, status: totalGenerated > 0 ? "partial" : "running", updated_at: new Date().toISOString() }).catch(() => {});
    }

    setGenerating(false);
    const doneCount   = finalGroups.flatMap(g => g.items).length;
    const finalStatus: GenerationStatus = doneCount === 0 ? "failed" : doneCount < totalPins ? "partial" : "completed";
    setSessions(prev => prev.map(s => s.id === sessionId ? {
      ...s, status: finalStatus as SessionStatus, generatingGroupIdx: null,
      groupErrors: Object.keys(groupErrors).length > 0 ? groupErrors : s.groupErrors,
      errorMessage: sessionErrorMessage ?? s.errorMessage,
      errorType: doneCount === 0 ? "unknown_error" : s.errorType,
    } : s));
    addHistory({
      ...runningEntry, groups: dbGroups, totalPins: doneCount, status: finalStatus,
      errorMessage: sessionErrorMessage, errorType: doneCount === 0 ? "unknown_error" : undefined,
    });
    updateSessionInDb(supabase, sessionId, { groups_json: dbGroups, total_pins: doneCount, status: finalStatus, updated_at: new Date().toISOString() }).catch(() => {});
    if (doneCount) toast.success(`${doneCount} pin${doneCount !== 1 ? "s" : ""} generated`);
  }, [hasInput, generating, refs, count, prompt, opportunity, products, totalPins, wsEntry, textOverlay, model, format]);

  const pinDetailView = useMemo((): PinDetailView | null => {
    if (!pinDetailSelection) return null;
    const session = sessions.find(s => s.id === pinDetailSelection.sessionId);
    if (!session) return null;
    const allItems = flattenFeedItems(sessions, "all");
    const item = allItems.find(i => i.entry.key === pinDetailSelection.entryKey && i.entry.sessionId === pinDetailSelection.sessionId);
    if (!item) return null;
    const historyEntry = loadHistory().find(h => h.id === session.id) ?? null;
    return resolvePinDetail(session, item.entry, historyEntry);
  }, [pinDetailSelection, sessions]);

  const pinDetailPin = useMemo((): StudioPin | null => {
    if (!pinDetailSelection) return null;
    const session = sessions.find(s => s.id === pinDetailSelection.sessionId);
    const item = flattenFeedItems(sessions, "all").find(i => i.entry.key === pinDetailSelection.entryKey);
    if (!session || item?.entry.pinIdx === undefined) return null;
    return session.groups[item.entry.groupIdx]?.items[item.entry.pinIdx] ?? null;
  }, [pinDetailSelection, sessions]);

  const isFormDirty = useMemo(() => {
    if (!metadataForm || !formBaseline) return false;
    return (
      metadataForm.title !== formBaseline.title
      || metadataForm.description !== formBaseline.description
      || metadataForm.altText !== formBaseline.altText
      || metadataForm.destinationUrl !== formBaseline.destinationUrl
      || metadataForm.plannedDate !== formBaseline.plannedDate
    );
  }, [metadataForm, formBaseline]);

  const pinReadinessLabel = useMemo(() => {
    if (!metadataForm || !pinDetailPin) return null;
    return metadataReadinessLabel({
      planningStatus: pinDetailPin.planningStatus,
      title: metadataForm.title,
      description: metadataForm.description,
      plannedDate: metadataForm.plannedDate,
    });
  }, [metadataForm, pinDetailPin]);

  function buildPinDetailsForm(pin: StudioPin): PinMetadataFormState {
    return {
      title: pin.title,
      description: pin.description,
      altText: pin.altText,
      destinationUrl: pin.destinationUrl,
      plannedDate: pin.plannedDate,
      metadataDraft: pin.metadataDraft ?? null,
    };
  }

  const runPinDetailsGeneration = useCallback((): boolean => {
    if (!pinDetailView || !pinDetailPin || pinDetailView.pinIdx === undefined) return false;
    const session = sessions.find(s => s.id === pinDetailView.sessionId);
    if (!session) return false;
    const fresh = generatePinMetadataDraft({
      pinIndex: pinDetailView.pinIdx,
      groupIndex: pinDetailView.groupIdx,
      keyword: session.keyword,
      category: session.category,
      opportunityTitle: session.setupSnapshot?.opportunityTitle,
      promptSnapshot: session.promptFull ?? session.setupSnapshot?.promptSnapshot,
      setupSnapshot: session.setupSnapshot,
      referenceLabel: pinDetailView.refLabel,
      referenceVisualFormat: session.setupSnapshot?.selectedReferences?.[pinDetailView.groupIdx]?.visualFormat,
    });
    const fields = applyDraftToPinFields(fresh);
    const newForm: PinMetadataFormState = {
      title: fields.title,
      description: fields.description,
      altText: fields.altText,
      destinationUrl: fields.destinationUrl,
      plannedDate: fields.plannedDate || pinDetailPin.plannedDate,
      metadataDraft: fresh,
    };
    updatePinMetadata(session.id, pinDetailView.groupIdx, pinDetailView.pinIdx, p => ({
      ...p,
      title: newForm.title,
      description: newForm.description,
      altText: newForm.altText,
      destinationUrl: newForm.destinationUrl,
      plannedDate: newForm.plannedDate,
      metadataDraft: fresh,
    }));
    setMetadataForm(newForm);
    setFormBaseline(newForm);
    setShowSaved(false);
    return true;
  }, [pinDetailView, pinDetailPin, sessions]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pinDetailPin) {
      setMetadataForm(null);
      setFormBaseline(null);
      setMetadataFormTouched({});
      setPinDetailsGenStatus("idle");
      setShowSaved(false);
      pinDetailsGenRef.current = null;
      return;
    }

    const formState = buildPinDetailsForm(pinDetailPin);
    setMetadataForm(formState);
    setFormBaseline(formState);
    setMetadataFormTouched({});
    setShowSaved(false);

    const isCompleted = pinDetailView?.statusLabel === "Completed" || pinDetailView?.statusLabel === "Added to Plan";
    if (!isCompleted) {
      setPinDetailsGenStatus("idle");
      return;
    }

    if (!pinNeedsDetailsGeneration(pinDetailPin)) {
      setPinDetailsGenStatus("idle");
      pinDetailsGenRef.current = pinDetailPin.id;
      return;
    }

    if (pinDetailsGenRef.current === pinDetailPin.id && pinDetailsGenStatus === "success") return;

    pinDetailsGenRef.current = pinDetailPin.id;
    setPinDetailsGenStatus("loading");

    const timer = window.setTimeout(() => {
      try {
        const ok = runPinDetailsGeneration();
        setPinDetailsGenStatus(ok ? "success" : "error");
      } catch {
        setPinDetailsGenStatus("error");
      }
    }, 40);

    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinDetailSelection?.entryKey, pinDetailPin?.id]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleRetryGenerateDetails() {
    setPinDetailsGenStatus("loading");
    window.setTimeout(() => {
      try {
        const ok = runPinDetailsGeneration();
        setPinDetailsGenStatus(ok ? "success" : "error");
      } catch {
        setPinDetailsGenStatus("error");
      }
    }, 40);
  }

  function updatePinMetadata(sessionId: string, groupIdx: number, pinIdx: number, updater: (pin: StudioPin) => StudioPin) {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      return { ...s, groups: s.groups.map((g, gi) => gi !== groupIdx ? g : {
        ...g, items: g.items.map((p, pi) => {
          if (pi !== pinIdx) return p;
          const updated = updater(p);
          persistStudioPinMetadata(updated, sessionId);
          return updated;
        }),
      })};
    }));
  }

  function handleSavePinMetadata() {
    if (!pinDetailView || !metadataForm || pinDetailView.pinIdx === undefined) return;
    const draft = metadataForm.metadataDraft;
    const updatedDraft: PinMetadataDraft | undefined = draft ? {
      ...draft,
      selectedTitle: metadataForm.title,
      selectedDescription: metadataForm.description,
      altText: metadataForm.altText,
      destinationUrl: metadataForm.destinationUrl || undefined,
      plannedDate: metadataForm.plannedDate || undefined,
      updatedAt: new Date().toISOString(),
    } : undefined;
    updatePinMetadata(pinDetailView.sessionId, pinDetailView.groupIdx, pinDetailView.pinIdx, p => ({
      ...p,
      title: metadataForm.title,
      description: metadataForm.description,
      altText: metadataForm.altText,
      destinationUrl: metadataForm.destinationUrl,
      plannedDate: metadataForm.plannedDate,
      metadataDraft: updatedDraft ?? p.metadataDraft,
      metadataTouched: { ...p.metadataTouched, ...metadataFormTouched },
    }));
    const existingDraft = pinDraftStore.getDraftByImageUrl(pinDetailPin?.url ?? "");
    if (existingDraft) {
      pinDraftStore.updateDraft(existingDraft.id, {
        title: metadataForm.title, description: metadataForm.description,
        altText: metadataForm.altText, destinationUrl: metadataForm.destinationUrl,
        scheduledDate: metadataForm.plannedDate,
      });
    }
    setFormBaseline({ ...metadataForm });
    setShowSaved(true);
  }

  function handleMetadataChange(patch: Partial<PinMetadataFormState>) {
    setShowSaved(false);
    setMetadataForm(prev => prev ? { ...prev, ...patch } : prev);
    const touched: Partial<MetadataTouchedFlags> = {};
    if ("title" in patch) touched.titleTouched = true;
    if ("description" in patch) touched.descriptionTouched = true;
    if ("altText" in patch) touched.altTextTouched = true;
    if ("destinationUrl" in patch) touched.destinationUrlTouched = true;
    if ("plannedDate" in patch) touched.plannedDateTouched = true;
    if (Object.keys(touched).length) setMetadataFormTouched(t => ({ ...t, ...touched }));
  }

  function handleSelectTitleCandidate(title: string) {
    handleMetadataChange({ title });
    setMetadataForm(prev => prev?.metadataDraft ? {
      ...prev,
      title,
      metadataDraft: { ...prev.metadataDraft, selectedTitle: title },
    } : prev);
  }

  function handleRegenerateTitles() {
    if (!pinDetailView) return;
    const session = sessions.find(s => s.id === pinDetailView.sessionId);
    if (!session) return;
    const fresh = generatePinMetadataDraft({
      pinIndex: pinDetailView.pinIdx ?? 0,
      groupIndex: pinDetailView.groupIdx,
      keyword: session.keyword, category: session.category,
      opportunityTitle: session.setupSnapshot?.opportunityTitle,
      promptSnapshot: session.promptFull ?? session.setupSnapshot?.promptSnapshot,
      setupSnapshot: session.setupSnapshot,
      referenceLabel: pinDetailView.refLabel,
    });
    if (!metadataFormTouched.titleTouched || window.confirm("Overwrite edited title?")) {
      handleMetadataChange({ title: fresh.selectedTitle, metadataDraft: fresh });
    } else {
      setMetadataForm(prev => prev ? { ...prev, metadataDraft: { ...fresh, selectedTitle: prev.title, titleCandidates: fresh.titleCandidates } } : prev);
    }
  }

  function handleRegenerateDescription() {
    if (!pinDetailView) return;
    const session = sessions.find(s => s.id === pinDetailView.sessionId);
    if (!session) return;
    const fresh = generatePinMetadataDraft({
      pinIndex: pinDetailView.pinIdx ?? 0,
      groupIndex: pinDetailView.groupIdx,
      keyword: session.keyword, category: session.category,
      setupSnapshot: session.setupSnapshot,
      promptSnapshot: session.promptFull,
      referenceLabel: pinDetailView.refLabel,
    });
    if (!metadataFormTouched.descriptionTouched || window.confirm("Overwrite edited description?")) {
      handleMetadataChange({ description: fresh.selectedDescription, metadataDraft: fresh });
    }
  }

  const selectedCompletedPins = useMemo(() => {
    const items = flattenFeedItems(sessions, "all");
    return items.filter(i => selectedPinKeys.has(i.entry.key) && i.entry.pin && i.entry.status === "completed" && i.entry.pinIdx !== undefined);
  }, [selectedPinKeys, sessions]);

  const batchPins: BatchPinRow[] = useMemo(() => selectedCompletedPins.map(({ entry, session }) => {
    const pin = entry.pin!;
    return {
      pinId: pin.id, sessionId: session.id, groupIdx: entry.groupIdx, pinIdx: entry.pinIdx!,
      imageUrl: pin.url, title: pin.title, description: pin.description,
      destinationUrl: pin.destinationUrl, plannedDate: pin.plannedDate,
      planningStatus: pin.planningStatus, metadataDraft: pin.metadataDraft,
    };
  }), [selectedCompletedPins]);

  function handleBatchGenerateMetadata(overwriteEdited = false) {
    const inputs = selectedCompletedPins.map(({ entry, session }, i) => ({
      pinId: entry.pin!.id,
      pinIndex: i,
      groupIndex: entry.groupIdx,
      keyword: session.keyword,
      category: session.category,
      setupSnapshot: session.setupSnapshot,
      promptSnapshot: session.promptFull,
      opportunityTitle: session.setupSnapshot?.opportunityTitle,
      referenceLabel: entry.refLabel,
      touched: entry.pin!.metadataTouched,
      existingDraft: entry.pin!.metadataDraft,
    }));
    const results = generateBatchMetadataDraft(inputs, { overwriteEdited });
    selectedCompletedPins.forEach(({ entry, session }) => {
      const pin = entry.pin!;
      const draft = results[pin.id];
      if (!draft || entry.pinIdx === undefined) return;
      const fields = applyDraftToPinFields(draft);
      updatePinMetadata(session.id, entry.groupIdx, entry.pinIdx, p => ({
        ...p, ...fields, metadataDraft: draft,
        metadataTouched: overwriteEdited ? EMPTY_TOUCHED : p.metadataTouched,
      }));
    });
    toast.success(`Pin Details generated for ${Object.keys(results).length} pins`);
  }

  function handleAddSelectedToPlan() {
    let added = 0;
    let skipped = 0;
    for (const { entry, session } of selectedCompletedPins) {
      const pin = entry.pin!;
      if (entry.pinIdx === undefined || pin.planningStatus !== "not_added") { skipped++; continue; }
      const group = session.groups[entry.groupIdx];
      if (!group || group.status !== "done") { skipped++; continue; }
      addPinToWeeklyPlan(session, pin, session.id, entry.groupIdx, entry.pinIdx, group.status);
      added++;
    }
    toast.success(`Added ${added} pin${added !== 1 ? "s" : ""} to plan${skipped ? ` · ${skipped} skipped` : ""}`);
    setSelectedPinKeys(new Set());
  }

  function handleBatchApply(opts: Parameters<BatchEditDrawerProps["onApply"]>[0]) {
    const dates: string[] = [];
    if (opts.autoAssignDates) {
      let drafts = pinDraftStore.getAllDrafts();
      for (let i = 0; i < selectedCompletedPins.length; i++) {
        const d = assignNextAvailablePlanDate(drafts) ?? "";
        dates.push(d);
        if (d) {
          const placeholder: pinDraftStore.PinDraft = {
            id: `tmp_${i}`, imageUrl: `tmp://batch/${i}`, keyword: "", category: "",
            title: "", description: "", altText: "", destinationUrl: "",
            boardId: "", boardName: "", weeklyPlanItemId: "", generationSessionId: "",
            scheduledDate: d, status: "needs_review", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          drafts = [...drafts, placeholder];
        }
      }
    }
    selectedCompletedPins.forEach(({ entry, session }, i) => {
      if (entry.pinIdx === undefined || !entry.pin) return;
      updatePinMetadata(session.id, entry.groupIdx, entry.pinIdx, p => {
        let next = { ...p };
        if (opts.applyDestinationToAll && opts.sharedDestinationUrl && (!p.metadataTouched.destinationUrlTouched || opts.overwriteEdited)) {
          next = { ...next, destinationUrl: opts.sharedDestinationUrl, metadataTouched: { ...next.metadataTouched, destinationUrlTouched: true } };
        }
        if (opts.sharedPlannedDate && (!p.metadataTouched.plannedDateTouched || opts.overwriteEdited)) {
          next = { ...next, plannedDate: opts.sharedPlannedDate };
        } else if (opts.autoAssignDates && dates[i] && (!p.metadataTouched.plannedDateTouched || opts.overwriteEdited)) {
          next = { ...next, plannedDate: dates[i] };
        }
        if (opts.uniqueTitles || opts.uniqueDescriptions) {
          const fresh = generatePinMetadataDraft({
            pinIndex: i, groupIndex: entry.groupIdx,
            keyword: session.keyword, category: session.category,
            setupSnapshot: session.setupSnapshot, promptSnapshot: session.promptFull,
          });
          if (opts.uniqueTitles && (!p.metadataTouched.titleTouched || opts.overwriteEdited)) {
            next = { ...next, title: fresh.selectedTitle, metadataDraft: { ...(next.metadataDraft ?? fresh), ...fresh, selectedTitle: fresh.selectedTitle } };
          }
          if (opts.uniqueDescriptions && (!p.metadataTouched.descriptionTouched || opts.overwriteEdited)) {
            next = { ...next, description: fresh.selectedDescription };
          }
          if (opts.uniqueAltText && (!p.metadataTouched.altTextTouched || opts.overwriteEdited)) {
            next = { ...next, altText: fresh.altText };
          }
        }
        return next;
      });
    });
    toast.success("Batch changes applied");
    setBatchEditOpen(false);
  }

  function handleReuseSetup(source: { setupSnapshot?: SetupSnapshot; promptFull?: string }) {
    const snap = source.setupSnapshot;
    if (!snap) { toast.error("Setup snapshot unavailable"); return; }
    const prodUrls = snap.selectedProducts.map(p => p.imageUrl).filter((u): u is string => !!u);
    const refUrls  = snap.selectedReferences.map(r => r.imageUrl).filter(Boolean);
    if (prodUrls.length) setProducts(prodUrls);
    if (refUrls.length) setRefs(refUrls);
    const promptText = source.promptFull ?? snap.promptSnapshot;
    if (promptText?.trim()) { setPrompt(promptText); promptManuallyEdited.current = true; }
    if (snap.imagesPerReference) setCount(snap.imagesPerReference);
    if (snap.keyword) {
      setOpportunity({ keyword: snap.keyword, category: snap.category ?? "home-decor", tier: "steady" });
    }
    setPinDetailSelection(null);
    toast.success("Setup loaded into composer");
  }

  // ── Picker confirm ────────────────────────────────────────────────────────────

  function onPickerConfirm(items: { id: string; imageUrl: string; source: string }[]) {
    const urls = items.map(i => i.imageUrl);
    if (rightPanelMode === "product_picker") {
      setProducts(p => { const s = new Set(p); return [...p, ...urls.filter(u => !s.has(u))]; });
    } else {
      setRefs(r => { const s = new Set(r); return [...r, ...urls.filter(u => !s.has(u))]; });
    }
    setRightPanelMode("feed");
  }

  // ── Add to plan ───────────────────────────────────────────────────────────────

  function addPinToWeeklyPlan(
    session: GenerationSession,
    pin: StudioPin,
    sessionId: string,
    groupIdx: number,
    pinIdx: number,
    groupStatus: RefGroup["status"] = "done",
  ): { planningStatus: PlanStatus; plannedDate: string } | null {
    if (!canAddGeneratedPinToPlan(groupStatus, pin)) return null;

    const allDrafts = pinDraftStore.getAllDrafts();
    const autoDate  = assignNextAvailablePlanDate(allDrafts) ?? "";
    const payload   = buildWeeklyPlanItemFromGeneratedPin({
      pin,
      session: {
        id: sessionId,
        keyword: session.keyword,
        category: session.category,
        source: session.source,
        status: session.status,
        savedAt: session.savedAt,
        setupSnapshot: session.setupSnapshot,
        promptFull: session.promptFull,
        model: session.model,
        format: session.format,
      },
      groupStatus,
      autoPlannedDate: autoDate,
      keywordFallback: opportunity?.keyword || "Pinterest content",
      categoryFallback: opportunity?.category || "home-decor",
    });
    if (!payload) return null;

    const draft = pinDraftStore.createFromHandoff(payload);
    if (!draft) return null;

    const planningStatus = payload.planningStatus as PlanStatus;
    const plannedDate = payload.plannedDate;
    const updated: StudioPin = {
      ...pin,
      title: payload.title,
      description: payload.description,
      altText: payload.altText,
      destinationUrl: payload.destinationUrl,
      planningStatus,
      weeklyPlanItemId: draft.id,
      plannedDate,
      metadataDraft: payload.metadataDraft ?? pin.metadataDraft,
      metadataTouched: payload.metadataTouched,
    };
    persistStudioPinMetadata(updated, sessionId);
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      return { ...s, groups: s.groups.map((g, gi) => gi !== groupIdx ? g : {
        ...g, items: g.items.map((p, pi) => pi !== pinIdx ? p : updated),
      })};
    }));
    return { planningStatus, plannedDate };
  }

  function handleAddToPlan(sessionId: string, groupIdx: number, pinIdx: number) {
    const session = sessions.find(s => s.id === sessionId);
    const group   = session?.groups[groupIdx];
    const pin     = group?.items[pinIdx];
    if (!pin || !pin.url || group?.status !== "done") return;
    if (pin.planningStatus !== "not_added") { toast.info("Already added to plan"); return; }
    const result = addPinToWeeklyPlan(session!, pin, sessionId, groupIdx, pinIdx, group.status);
    if (!result) return;
    const { planningStatus, plannedDate } = result;
    toast.success("Added to Weekly Plan", {
      description: planningStatus === "ready"
        ? `Ready for publish${plannedDate ? ` · ${plannedDate}` : ""}.`
        : plannedDate
          ? `Needs review · scheduled ${plannedDate}.`
          : "Needs review · not scheduled.",
    });
  }

  // ── Regenerate group ──────────────────────────────────────────────────────────

  async function handleRegenerateGroup(sessionId: string, groupIdx: number) {
    const session = sessions.find(s => s.id === sessionId);
    const group   = session?.groups[groupIdx];
    if (!group) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      return { ...s, groups: s.groups.map((g, i) => i !== groupIdx ? g : { ...g, status: "generating" as const, items: [], expectedCount: count }) };
    }));
    try {
      const resp = await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: opportunity?.keyword ?? "Pinterest content",
          style: "editorial", count, prompt,
          category: opportunity?.category ?? "home-decor",
          ...(group.refUrl    ? { style_ref: group.refUrl }  : {}),
          ...(products.length ? { product_images: products } : {}),
        }),
      });
      const data = await resp.json() as { urls?: string[] };
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        return { ...s, groups: s.groups.map((g, i) => {
          if (i !== groupIdx) return g;
          const refLabel = refLabelForGroup(s, g);
          const sessCtx = { keyword: s.keyword, category: s.category, setupSnapshot: s.setupSnapshot, promptFull: s.promptFull };
          return {
            ...g, items: (data.urls ?? []).map((url, ii) => createCompletedPin(sessionId, groupIdx, ii, url, sessCtx, refLabel)),
            status: data.urls?.length ? "done" as const : "failed" as const,
          };
        })};
      }));
    } catch {
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        return { ...s, groups: s.groups.map((g, i) => i !== groupIdx ? g : { ...g, status: "failed" as const }) };
      }));
    }
  }

  // ── Regenerate single pin ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleRegeneratePin(sessionId: string, groupIdx: number, _pinIdx: number) {
    const session = sessions.find(s => s.id === sessionId);
    const group   = session?.groups[groupIdx];
    if (!group) return;
    try {
      const resp = await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: opportunity?.keyword ?? "Pinterest content",
          style: "editorial", count: 1, prompt,
          category: opportunity?.category ?? "home-decor",
          ...(group.refUrl    ? { style_ref: group.refUrl }  : {}),
          ...(products.length ? { product_images: products } : {}),
        }),
      });
      const data = await resp.json() as { urls?: string[] };
      if (data.urls?.length) {
        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;
          return { ...s, groups: s.groups.map((g, i) => {
            if (i !== groupIdx) return g;
            const newIdx = g.items.length;
            const refLabel = refLabelForGroup(s, g);
            const sessCtx = { keyword: s.keyword, category: s.category, setupSnapshot: s.setupSnapshot, promptFull: s.promptFull };
            return { ...g, items: [...g.items, createCompletedPin(sessionId, groupIdx, newIdx, data.urls![0], sessCtx, refLabel)] };
          })};
        }));
        toast.success("New variation added");
      } else { toast.error("Variation failed — try again"); }
    } catch { toast.error("Network error during regeneration"); }
  }

  // ── Add all to plan ───────────────────────────────────────────────────────────

  function handleAddAllToPlan(sessionId: string) {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    let added = 0;
    let skipped = 0;
    for (let gi = 0; gi < session.groups.length; gi++) {
      const group = session.groups[gi];
      if (group.status !== "done") { skipped += group.items.length; continue; }
      for (let pi = 0; pi < group.items.length; pi++) {
        const pin = group.items[pi];
        if (!canAddGeneratedPinToPlan(group.status, pin)) { skipped++; continue; }
        const result = addPinToWeeklyPlan(session, pin, sessionId, gi, pi, group.status);
        if (result) added++; else skipped++;
      }
    }
    if (added === 0) { toast.info("All pins are already added to plan"); return; }
    toast.success(`Added ${added} pin${added !== 1 ? "s" : ""} to Weekly Plan`, {
      description: skipped > 0 ? `${skipped} skipped (already added or not completed).` : undefined,
    });
  }

  // ── Save draft ────────────────────────────────────────────────────────────────

  function handleSaveDraft() {
    localStorage.setItem("vibepin_studio_draft", JSON.stringify({ products, refs, prompt, count, opportunity, savedAt: new Date().toISOString() }));
    toast.success("Draft saved");
  }

  function appendPromptStarter(starter: string) {
    setPrompt(prev => {
      const trimmed = prev.trim();
      if (!trimmed) return starter;
      if (trimmed.toLowerCase().includes(starter.toLowerCase())) return prev;
      return `${trimmed}. ${starter}`;
    });
    promptManuallyEdited.current = true;
  }

  const tc = opportunity ? (TIER_COLOR[opportunity.tier] ?? D.purple) : "";
  const tl = opportunity ? (TIER_LABEL[opportunity.tier] ?? opportunity.tier) : "";
  const vc = opportunity?.trend ? (TREND_COLOR[opportunity.trend] ?? D.accent) : "";
  const vl = opportunity?.trend ? (opportunity.trend.charAt(0).toUpperCase() + opportunity.trend.slice(1)) : "";

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div
      data-testid={interactive ? "studio-interactive" : undefined}
      style={{ flex: 1, display: "flex", flexDirection: "column", background: D.bg, overflow: "hidden", minHeight: 0 }}
    >

      {/* Page header */}
      <div style={{
        padding: "12px 20px", background: D.surface,
        borderBottom: `1px solid ${D.border}`,
        flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div>
          <p data-testid="page-header-title" style={{ margin: 0, fontSize: "18px", fontWeight: 800, color: D.text, lineHeight: 1.2 }}>Create Pins</p>
          <p style={{ margin: "4px 0 0", fontSize: "12px", color: D.textSec }}>
            Turn product images, Pin references, or ideas into Pinterest-native visuals.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" onClick={handleSaveDraft}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 14px", borderRadius: 20, border: `1px solid ${D.border}`, background: "none", fontSize: "11px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
            Save draft
          </button>
          <button type="button" onClick={() => router.push("/app/history")}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 14px", borderRadius: 20, border: `1px solid ${D.border}`, background: D.cardElev, fontSize: "11px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
            <Clock style={{ width: 11, height: 11 }} /> History
          </button>
        </div>
      </div>

      {/* Main body: composer + generation feed */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* Left composer panel */}
        <div
          data-testid="composer-panel"
          style={{
            width: "36%", minWidth: 280, maxWidth: 400, flexShrink: 0,
            display: "flex", flexDirection: "column", minHeight: 0,
            borderRight: "none", background: D.card, overflow: "hidden",
          }}
        >
          <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
            {/* Compact side-by-side asset entries */}
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${D.border}`, display: "flex", gap: 8 }}>
              <CompactAssetEntry
                role="product"
                selectedUrls={products}
                onToggleUrl={toggleProductUrl}
                onOpenPicker={() => setRightPanelMode("product_picker")}
              />
              <CompactAssetEntry
                role="style_reference"
                selectedUrls={refs}
                onToggleUrl={toggleRefUrl}
                onOpenPicker={() => setRightPanelMode("reference_picker")}
              />
            </div>

            {/* Prompt */}
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${D.border}` }}>
              <p style={{ margin: "0 0 4px", fontSize: "12px", fontWeight: 700, color: D.text }}>Prompt</p>
              <textarea
                data-testid="prompt-textarea"
                value={prompt}
                onChange={e => { setPrompt(e.target.value.slice(0, 1200)); promptManuallyEdited.current = true; }}
                placeholder="Describe the scene, mood, lighting, composition, and any text or branding you want."
                style={{
                  width: "100%", boxSizing: "border-box", display: "block",
                  border: `1.5px solid ${D.border}`, borderRadius: 9, outline: "none", resize: "vertical",
                  padding: "10px 12px", fontSize: "12px", lineHeight: 1.7, color: D.text,
                  fontFamily: "inherit", background: D.cardElev, minHeight: 88, maxHeight: 200,
                  transition: "border-color 0.15s",
                }}
                rows={3}
                onFocus={e => (e.currentTarget.style.borderColor = D.accent)}
                onBlur={e => (e.currentTarget.style.borderColor = D.border)}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                <span style={{ fontSize: "10px", color: D.textMuted }}>{prompt.length} / 1200</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {PROMPT_STARTERS.map(starter => (
                  <button
                    key={starter}
                    type="button"
                    data-testid={`prompt-starter-${starter.replace(/\s+/g, "-").toLowerCase()}`}
                    onClick={() => appendPromptStarter(starter)}
                    style={{
                      padding: "4px 10px", borderRadius: 20,
                      border: `1px solid ${D.border}`, background: D.cardElev,
                      fontSize: "10px", fontWeight: 500, color: D.textSec, cursor: "pointer",
                    }}
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>

            {/* Lightweight controls */}
            <div style={{ padding: "12px 14px 16px" }}>
              <p style={{ margin: "0 0 8px", fontSize: "12px", fontWeight: 700, color: D.text }}>Lightweight Controls</p>
              {opportunity ? (
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px 4px 10px", borderRadius: 20, background: D.cardElev, border: `1px solid ${D.border}`, marginBottom: 8, width: "fit-content" }}>
                  <span style={{ fontSize: "10px", fontWeight: 700, color: D.text, textTransform: "capitalize" }}>{opportunity.keyword}</span>
                  {tc && <span style={{ fontSize: "9px", fontWeight: 700, color: tc, background: `${tc}20`, padding: "1px 6px", borderRadius: 20 }}>{wsPrimLabel || tl}</span>}
                  {vc && (wsTrendLabel || vl) && <span style={{ fontSize: "9px", fontWeight: 700, color: vc, background: `${vc}20`, padding: "1px 6px", borderRadius: 20 }}>{wsTrendLabel || vl}</span>}
                  <button type="button" onClick={() => { setOpportunity(null); setWsEntry(false); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: D.textSec, display: "flex", padding: "0 2px" }}>
                    <X style={{ width: 10, height: 10 }} />
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setOppDrawerOpen(true)}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 20, border: `1px solid ${D.border}`, background: D.cardElev, fontSize: "11px", fontWeight: 500, color: D.textSec, cursor: "pointer", marginBottom: 8 }}>
                  <Target style={{ width: 10, height: 10 }} /> Add opportunity
                </button>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Dropdown label="Images:" value={count} options={[1,2,3,4].map(n => ({ value: n, label: String(n) }))} onChange={setCount} />
                <Dropdown label="Text overlay:" value={textOverlay} options={[{ value: "off" as const, label: "Off" }, { value: "on" as const, label: "On" }]} onChange={setTextOverlay} />
                <Dropdown label="Format:" value={format} options={[{ value: "Pinterest 2:3", label: "Pinterest 2:3" }]} onChange={setFormat} />
                <Dropdown label="Model:" value={model} options={[{ value: "GPT Image 2", label: "GPT Image 2" }]} onChange={setModel} />
              </div>
              {overLimit && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 10 }}>
                  <AlertCircle style={{ width: 11, height: 11, color: D.warning }} />
                  <span style={{ fontSize: "10px", color: D.warning, fontWeight: 600 }}>
                    {totalPins} Pins. Consider reducing references or count.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Primary CTA */}
          <div style={{ padding: "12px 16px 16px", borderTop: `1px solid ${D.border}`, flexShrink: 0, background: D.card }}>
            <button
              type="button"
              data-testid="generate-btn"
              disabled={!hasInput || generating}
              onClick={handleGenerate}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                width: "100%", padding: "12px 20px", borderRadius: 12, border: "none",
                fontSize: "13px", fontWeight: 800,
                background: hasInput && !generating ? D.gradient : "rgba(124,58,237,0.25)",
                color: "#fff",
                cursor: hasInput && !generating ? "pointer" : "not-allowed",
                boxShadow: hasInput && !generating ? "0 4px 16px rgba(124,58,237,0.3)" : "none",
              }}
            >
              {generating ? (
                <>
                  <div style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                  Generating…
                </>
              ) : (
                <>
                  <Sparkles style={{ width: 14, height: 14 }} />
                  {genLabel}
                </>
              )}
            </button>
          </div>
        </div>

        {rightPanelMode === "feed" ? (
          <MasonryPinFeed
            sessions={sessions}
            filter={feedFilter}
            onFilterChange={setFeedFilter}
            onAddToPlan={handleAddToPlan}
            onAddAllToPlan={handleAddAllToPlan}
            onRegeneratePin={handleRegeneratePin}
            onRegenerateGroup={handleRegenerateGroup}
            pinDetailOpen={pinDetailSelection !== null && pinDetailView !== null}
            pinDetailInitialTab={pinDetailSelection?.initialTab ?? "preview"}
            pinDetail={pinDetailView}
            metadataForm={metadataForm}
            pinDetailsGenStatus={pinDetailsGenStatus}
            readinessLabel={pinReadinessLabel}
            isDirty={isFormDirty}
            showSaved={showSaved}
            onRetryGenerateDetails={handleRetryGenerateDetails}
            onOpenPinDetail={(sessionId, entryKey, tab) => setPinDetailSelection({ sessionId, entryKey, initialTab: tab ?? "preview" })}
            onClosePinDetail={() => setPinDetailSelection(null)}
            onMetadataChange={handleMetadataChange}
            onSelectTitleCandidate={handleSelectTitleCandidate}
            onRegenerateTitles={handleRegenerateTitles}
            onRegenerateDescription={handleRegenerateDescription}
            onSavePinMetadata={handleSavePinMetadata}
            onPinDetailAddToPlan={() => {
              if (!pinDetailView || !metadataForm || pinDetailView.pinIdx === undefined) return;
              const session = sessions.find(s => s.id === pinDetailView.sessionId);
              const pin = session?.groups[pinDetailView.groupIdx]?.items[pinDetailView.pinIdx];
              if (!session || !pin || pin.planningStatus !== "not_added") return;
              const merged: StudioPin = {
                ...pin,
                title: metadataForm.title,
                description: metadataForm.description,
                altText: metadataForm.altText,
                destinationUrl: metadataForm.destinationUrl,
                plannedDate: metadataForm.plannedDate,
                metadataDraft: metadataForm.metadataDraft ?? pin.metadataDraft,
              };
              const group = session.groups[pinDetailView.groupIdx];
              const result = group ? addPinToWeeklyPlan(session, merged, session.id, pinDetailView.groupIdx, pinDetailView.pinIdx, group.status) : null;
              if (!result) return;
              const { planningStatus, plannedDate } = result;
              toast.success("Added to Weekly Plan", {
                description: planningStatus === "ready" ? `Ready · ${plannedDate || "scheduled"}` : "Needs review",
              });
            }}
            onPinDetailRegenerate={() => {
              if (!pinDetailView || pinDetailView.pinIdx === undefined) return;
              handleRegeneratePin(pinDetailView.sessionId, pinDetailView.groupIdx, pinDetailView.pinIdx);
            }}
            onPinDetailSaveAsReference={() => toast.success("Saved as reference.")}
            onPinDetailRetryPin={() => {
              if (!pinDetailView) return;
              handleRegenerateGroup(pinDetailView.sessionId, pinDetailView.groupIdx);
            }}
            onPinDetailRetryGroup={() => {
              if (!pinDetailView) return;
              handleRegenerateGroup(pinDetailView.sessionId, pinDetailView.groupIdx);
            }}
            onPinDetailReuseSetup={() => {
              if (!pinDetailView) return;
              handleReuseSetup(pinDetailView.session);
            }}
            onPinDetailViewSetup={() => {
              if (!pinDetailView) return;
              handleReuseSetup(pinDetailView.session);
            }}
            onPinDetailRegenerateWithRemix={(remixSetup: RemixDraftSetup) => {
              if (!pinDetailView) return;
              const snap = pinDetailView.setupSnapshot;
              if (!snap) { toast.error("Setup snapshot unavailable"); return; }
              const merged = {
                ...snap,
                selectedProducts:   remixSetup.selectedProducts,
                selectedReferences: remixSetup.selectedReferences,
                promptSnapshot:     remixSetup.prompt || snap.promptSnapshot,
                imagesPerReference: remixSetup.imagesPerReference,
                noTextOverlay:      remixSetup.noTextOverlay,
                opportunityTitle:   remixSetup.opportunityTitle || snap.opportunityTitle,
                keyword:            remixSetup.keyword || snap.keyword,
                category:           remixSetup.category || snap.category,
              };
              handleReuseSetup({ setupSnapshot: merged, promptFull: remixSetup.prompt || snap.promptSnapshot });
              toast.success("Remix loaded into composer — click Generate to create a new variation");
            }}
            selectedPinKeys={selectedPinKeys}
            onTogglePinSelect={(key) => setSelectedPinKeys(prev => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            })}
            onClearSelection={() => setSelectedPinKeys(new Set())}
            onOpenBatchEdit={() => setBatchEditOpen(true)}
            onBatchGenerateMetadata={() => handleBatchGenerateMetadata(false)}
            onAddSelectedToPlan={handleAddSelectedToPlan}
            batchEditOpen={batchEditOpen}
            batchPins={batchPins}
            onCloseBatchEdit={() => setBatchEditOpen(false)}
            onBatchApply={handleBatchApply}
            onBatchGenerateFromDrawer={handleBatchGenerateMetadata}
          />
        ) : (
          <InlineCreateAssetPicker
            role={rightPanelMode === "product_picker" ? "product" : "style_reference"}
            onClose={() => setRightPanelMode("feed")}
            onConfirm={onPickerConfirm}
            currentSelectedUrls={rightPanelMode === "product_picker" ? products : refs}
          />
        )}
      </div>

      <OpportunityDrawer
        open={oppDrawerOpen}
        onClose={() => setOppDrawerOpen(false)}
        onSelect={o => {
          setOpportunity(o);
          if (!promptManuallyEdited.current) setPrompt(buildComposerPrompt(o.keyword, o.category, products.length > 0));
        }}
      />
      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .studio-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(71,85,105,0.55) transparent;
        }
        .studio-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
        .studio-scroll::-webkit-scrollbar-track { background: transparent; }
        .studio-scroll::-webkit-scrollbar-thumb {
          background: rgba(71,85,105,0.55);
          border-radius: 999px;
          border: 1px solid rgba(15,23,42,0.75);
        }
        .pin-feed-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 16px;
          align-items: start;
          width: 100%;
        }
        .feed-shimmer {
          background: linear-gradient(100deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.12) 45%, rgba(255,255,255,0.02) 90%);
          background-size: 200% 100%;
          animation: feed-shimmer 1.4s ease-in-out infinite;
        }
        @keyframes feed-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

export default function CreatePinsPage() {
  return (
    <Suspense fallback={<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8892A4", fontSize: "13px", background: "#0B0E17" }}>Loading…</div>}>
      <CreatePinsContent />
    </Suspense>
  );
}
