"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Package, X, ShieldCheck, ShieldAlert, Cpu, ImageOff } from "lucide-react";
import { toProxyUrl } from "@/lib/imageProxy";
import {
  getTitleCandidateEntries,
  shouldShowLowConfidenceHint,
  resolvePinProducts,
  addProductToDraft,
  removeProductFromDraft,
  promoteProductToPrimary,
  setPrimaryProductUrl,
  productSourceLabel,
  productKey,
  normalizeProductSource,
  type LinkedProduct,
  type MetadataReadinessLabel,
  type PinMetadataDraft,
} from "@/lib/pinMetadata";
import type { SetupSnapshot, ProductSnapshot, ReferenceSnapshot, CategoryAudit } from "@/lib/studioPersistence";
import type { PinDetailView, GenerationSetupSnapshot, RecoveryQuality } from "./pinDetails";
import { getGenerationSetupSnapshot } from "./pinDetails";
import { ProductPickerModal } from "./ProductPickerModal";
import type { ProductSelection } from "./ProductPickerModal";

const UI = {
  card: "var(--app-surface, #161D2E)",
  cardElev: "var(--app-surface-3, #1A2236)",
  border: "var(--app-border, rgba(255,255,255,0.09))",
  borderStr: "var(--app-border-hi, rgba(255,255,255,0.12))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #64748B)",
  purple: "#7C3AED",
  purpleBg: "rgba(124,58,237,0.12)",
  success: "#10B981",
  error: "#EF4444",
  warning: "#F59E0B",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

// ── Tab type ──────────────────────────────────────────────────────────────────

export type DrawerTab = "plan" | "remix" | "debug";

// ── Remix draft setup (mutable copy of originalSetupSnapshot) ─────────────────

export type RemixDraftSetup = {
  selectedProducts: ProductSnapshot[];
  selectedReferences: ReferenceSnapshot[];
  prompt: string;
  imagesPerReference: number;
  noTextOverlay: boolean;
  opportunityTitle: string;
  keyword: string;
  category: string;
  modelKey?: string;
  format?: string;
};

function parseAspectRatio(format: string | undefined): string {
  const f = format ?? "2:3";
  const m = f.match(/(\d+:\d+)/);
  return m ? m[1] : "2:3";
}

function initRemixFromSnapshot(snap: SetupSnapshot | null): RemixDraftSetup {
  return {
    selectedProducts:   snap?.selectedProducts   ?? [],
    selectedReferences: snap?.selectedReferences ?? [],
    prompt:             snap?.promptSnapshot      ?? "",
    imagesPerReference: snap?.imagesPerReference  ?? 1,
    noTextOverlay:      snap?.noTextOverlay       ?? true,
    opportunityTitle:   snap?.opportunityTitle    ?? "",
    keyword:            snap?.keyword             ?? "",
    category:           snap?.category            ?? "",
    format:             parseAspectRatio(snap?.format),
  };
}

// Richer init via getGenerationSetupSnapshot — normalises access across all fallback sources.
function initRemixFromDetail(detail: import("./pinDetails").PinDetailView): RemixDraftSetup {
  const g = getGenerationSetupSnapshot(detail);
  const snap = detail.setupSnapshot;
  return {
    selectedProducts:   g.productImages.map(url => ({ imageUrl: url, title: "" })),
    selectedReferences: g.pinReferences.map(url => ({ imageUrl: url })),
    prompt:             g.prompt,
    imagesPerReference: g.imageCount,
    noTextOverlay:      g.noTextOverlay,
    opportunityTitle:   g.opportunityTitle,
    keyword:            snap?.keyword ?? detail.session.keyword ?? "",
    category:           snap?.category ?? detail.session.category ?? "",
    modelKey:           snap?.modelKey,
    format:             parseAspectRatio(snap?.format ?? detail.format),
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MetaRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div data-testid={testId} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11 }}>
      <span style={{ color: UI.textMuted, flexShrink: 0 }}>{label}</span>
      <span style={{ color: UI.text, textAlign: "right", wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 800, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {children}
    </p>
  );
}

function statusColor(label: PinDetailView["statusLabel"]): string {
  if (label === "Failed") return UI.error;
  if (label === "Generating" || label === "Queued") return UI.purple;
  if (label === "Added to Plan") return UI.success;
  return "#34D399";
}

function readinessColor(label: MetadataReadinessLabel | null): string {
  if (!label) return UI.textMuted;
  if (label === "Ready" || label === "Added to Plan") return UI.success;
  if (label.startsWith("Missing")) return UI.warning;
  return UI.purple;
}

function productSourceBadgeStyle(source: string): { bg: string; color: string } {
  switch (normalizeProductSource(source)) {
    case "url_imported":  return { bg: "rgba(99,102,241,0.18)",  color: "#A5B4FC" };
    case "product_ideas": return { bg: "rgba(16,185,129,0.15)",  color: "#6EE7B7" };
    case "upload":        return { bg: "rgba(245,158,11,0.15)",  color: "#FCD34D" };
    case "manual":        return { bg: "rgba(148,163,184,0.15)", color: "#CBD5E1" };
    default:              return { bg: "rgba(124,58,237,0.18)",  color: "#C4B5FD" };
  }
}

// ── Product source chip ─────────────────────────────────────────────────────────
function ProductSourceChip({ source }: { source: string }) {
  const s = productSourceBadgeStyle(source);
  return (
    <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 5, background: s.bg, color: s.color, flexShrink: 0, whiteSpace: "nowrap" }}>
      {productSourceLabel(source)}
    </span>
  );
}

function ProductThumbnail({ src, size = 40 }: { src?: string; size?: number }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div style={{ width: size, height: size, borderRadius: 6, background: UI.card, border: `1px solid ${UI.border}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Package style={{ width: size * 0.45, height: size * 0.45, color: UI.textMuted }} />
      </div>
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: 6, overflow: "hidden", flexShrink: 0, border: `1px solid ${UI.border}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={toProxyUrl(src)} alt="" onError={() => setErr(true)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </div>
  );
}

// Compact suggested titles (Option A): selected source label + "View N more" reveal.
function CompactTitleSuggestions({
  entries, selected, onSelect,
}: {
  entries: { text: string; sourceLabel: string }[];
  selected: string;
  onSelect: (t: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!entries.length) return null;
  const selectedEntry = entries.find(e => e.text === selected);
  const others = entries.filter(e => e.text !== selected);
  return (
    <div data-testid="pin-details-title-candidates" style={{ marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {selectedEntry && (
          <span data-testid="pin-details-title-source" style={{ fontSize: 9, color: UI.success, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 3 }}>
            <CheckCircle2 style={{ width: 9, height: 9 }} /> {selectedEntry.sourceLabel}
          </span>
        )}
        {others.length > 0 && (
          <button type="button" data-testid="pin-details-toggle-suggestions" onClick={() => setExpanded(v => !v)}
            style={{ background: "none", border: "none", cursor: "pointer", color: UI.purple, fontSize: 9, fontWeight: 700, padding: 0 }}>
            {expanded ? "Hide suggestions" : `View ${others.length} more`}
          </button>
        )}
      </div>
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          {others.map((entry, i) => (
            <button key={i} type="button" data-testid={`pin-details-title-candidate-${i}`} onClick={() => onSelect(entry.text)}
              style={{ padding: "6px 9px", borderRadius: 6, border: `1px solid ${UI.border}`, background: UI.cardElev, color: UI.textSec, fontSize: 10, textAlign: "left" as const, cursor: "pointer", width: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontWeight: 700, color: UI.text, lineHeight: 1.4 }}>{entry.text}</span>
                <span style={{ fontSize: 9, fontWeight: 700, color: UI.purple, flexShrink: 0 }}>Use</span>
              </div>
              <span style={{ fontSize: 9, color: UI.textMuted }}>{entry.sourceLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Debug panel ──────────────────────────────────────────────────────────────

function AuditRow({ label, value, highlight }: { label: string; value: string; highlight?: "ok" | "warn" | "err" | "none" }) {
  const color = highlight === "ok" ? UI.success : highlight === "warn" ? UI.warning : highlight === "err" ? UI.error : UI.text;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, minHeight: 18 }}>
      <span style={{ color: UI.textMuted, flexShrink: 0, minWidth: 110 }}>{label}</span>
      <span style={{ color, textAlign: "right", wordBreak: "break-all", fontFamily: "monospace", fontSize: 10 }}>{value || "—"}</span>
    </div>
  );
}

function AuditBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.cardElev, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
      <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 800, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.06em" }}>{title}</p>
      {children}
    </section>
  );
}

function ThumbnailStrip({ urls, label }: { urls: string[]; label: string }) {
  if (!urls.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: UI.textMuted }}>
        <ImageOff style={{ width: 12, height: 12 }} />
        <span>{label}: none recovered</span>
      </div>
    );
  }
  return (
    <div>
      <p style={{ margin: "0 0 6px", fontSize: 10, color: UI.textSec }}>{label} ({urls.length})</p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {urls.slice(0, 8).map((url, i) => (
          <ProductThumbnail key={i} src={url} size={36} />
        ))}
      </div>
    </div>
  );
}

function categorySourceLabel(src: CategoryAudit["categorySource"]): string {
  switch (src) {
    case "frontend":            return "Frontend (user selected)";
    case "vlm_plan":            return "VLM plan (auto-detected)";
    case "generator_inference": return "Generator inference";
    case "fallback":            return "Fallback (unknown)";
  }
}

function recoveryQualityLabel(q: RecoveryQuality): string {
  switch (q) {
    case "full":           return "Full recovery";
    case "visual_partial": return "Partial (some images missing)";
    case "text_only":      return "Text only (no images)";
    case "unavailable":    return "Unavailable";
  }
}

function DebugPanel({
  detail,
  genSnap,
  recoveryQuality,
}: {
  detail: PinDetailView;
  genSnap: GenerationSetupSnapshot;
  recoveryQuality: RecoveryQuality;
}) {
  const audit = detail.categoryAudit;
  const snap  = detail.setupSnapshot;

  return (
    <div data-testid="pin-details-debug-panel" style={{ padding: "14px 18px 24px", display: "flex", flexDirection: "column", gap: 12 }}>

      {/* ── A. Generation Summary ── */}
      <AuditBlock title="A — Generation Summary">
        <AuditRow label="Session / batch" value={detail.sessionId.slice(-12)} />
        <AuditRow label="Pin ID"          value={detail.pinId.slice(-16)} />
        <AuditRow label="Created at"      value={detail.createdAt ? new Date(detail.createdAt).toLocaleString() : "—"} />
        <AuditRow label="Model"           value={detail.model} />
        <AuditRow label="Format"          value={detail.format} />
        <AuditRow label="Text overlay"    value={detail.textOverlay} />
        <AuditRow label="Status"          value={detail.statusLabel} />
      </AuditBlock>

      {/* ── B. Category Audit ── */}
      <AuditBlock title="B — Category Audit">
        {!audit ? (
          <p style={{ margin: 0, fontSize: 10, color: UI.textMuted, fontStyle: "italic" }}>
            Not available — this Pin was created before generation audit data was saved, or the persisted record is missing category_audit.
          </p>
        ) : (
          <>
            <AuditRow label="Frontend category"  value={audit.frontendCategory || "(empty)"}
              highlight={audit.frontendCategory ? "none" : "warn"} />
            <AuditRow label="Detected (VLM)"     value={audit.detectedCategory || "(none)"}
              highlight={audit.detectedCategory ? "ok" : "warn"} />
            <AuditRow label="Effective category" value={audit.effectiveCategory || "(none)"}
              highlight={audit.effectiveCategory ? "ok" : "warn"} />
            <AuditRow label="Generator inferred" value={audit.inferredCategory || "(none)"} />
            <AuditRow label="Category source"    value={categorySourceLabel(audit.categorySource)}
              highlight={audit.categorySource === "frontend" || audit.categorySource === "vlm_plan" ? "ok" : "warn"} />
            <AuditRow label="Output type"        value={audit.outputType || "(auto)"} />
            <AuditRow label="Product images"     value={String(audit.productImageCount)} />
            <AuditRow label="Reference images"   value={String(audit.referenceImageCount)} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              {audit.fashionSafetyApplied ? (
                <><ShieldCheck style={{ width: 11, height: 11, color: UI.success }} />
                <span style={{ fontSize: 10, color: UI.success }}>Fashion safety guardrail active</span></>
              ) : (
                <><ShieldAlert style={{ width: 11, height: 11, color: UI.textMuted }} />
                <span style={{ fontSize: 10, color: UI.textMuted }}>Fashion safety not applied</span></>
              )}
            </div>
            {audit.homeDriftTerms.length > 0 && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 2 }}>
                <AlertCircle style={{ width: 11, height: 11, color: UI.error, flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 10, color: UI.error }}>
                  Home-decor drift detected in positive prompt body: {audit.homeDriftTerms.join(", ")}
                </span>
              </div>
            )}
            {audit.enhancerFailed && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <AlertCircle style={{ width: 11, height: 11, color: UI.warning }} />
                <span style={{ fontSize: 10, color: UI.warning }}>Prompt enhancer failed — used fallback</span>
              </div>
            )}
          </>
        )}
      </AuditBlock>

      {/* ── C. Input Assets ── */}
      <AuditBlock title="C — Input Assets">
        <ThumbnailStrip urls={genSnap.productImages}   label="Products" />
        <ThumbnailStrip urls={genSnap.pinReferences}   label="References" />
        {snap?.category && <AuditRow label="Snapshot category" value={snap.category} />}
        {snap?.keyword  && <AuditRow label="Snapshot keyword"  value={snap.keyword} />}
      </AuditBlock>

      {/* ── D. Prompt Audit ── */}
      <AuditBlock title="D — Prompt Audit">
        {audit?.finalPrompt ? (
          <details style={{ margin: 0 }}>
            <summary style={{ fontSize: 10, color: UI.purple, cursor: "pointer", fontWeight: 700 }}>
              Final prompt ({audit.finalPrompt.length} chars) — click to expand
            </summary>
            <pre style={{
              margin: "8px 0 0", fontSize: 9, color: UI.textSec, whiteSpace: "pre-wrap",
              wordBreak: "break-word", background: "var(--app-bg, #0B1020)", borderRadius: 6,
              padding: "8px 10px", maxHeight: 300, overflowY: "auto",
            }}>
              {audit.finalPrompt}
            </pre>
          </details>
        ) : detail.promptSnapshot ? (
          <details style={{ margin: 0 }}>
            <summary style={{ fontSize: 10, color: UI.purple, cursor: "pointer", fontWeight: 700 }}>
              Stored prompt ({detail.promptSnapshot.length} chars) — click to expand
            </summary>
            <pre style={{
              margin: "8px 0 0", fontSize: 9, color: UI.textSec, whiteSpace: "pre-wrap",
              wordBreak: "break-word", background: "var(--app-bg, #0B1020)", borderRadius: 6,
              padding: "8px 10px", maxHeight: 300, overflowY: "auto",
            }}>
              {detail.promptSnapshot}
            </pre>
          </details>
        ) : (
          <p style={{ margin: 0, fontSize: 10, color: UI.textMuted, fontStyle: "italic" }}>No prompt stored.</p>
        )}
      </AuditBlock>

      {/* ── E. Recovery Audit ── */}
      <AuditBlock title="E — Recovery Audit">
        <AuditRow label="Snapshot source"    value={detail.setupSnapshotSource}
          highlight={detail.setupSnapshotSource === "pin.setupSnapshot" || detail.setupSnapshotSource === "pin.generationSetup" ? "ok"
            : detail.setupSnapshotSource === "legacy_prompt_fallback" ? "err" : "warn"} />
        <AuditRow label="Recovery quality"   value={recoveryQualityLabel(recoveryQuality)}
          highlight={recoveryQuality === "full" ? "ok" : recoveryQuality === "unavailable" ? "err" : "warn"} />
        <AuditRow label="Expected products"  value={String(genSnap.expectedProducts)} />
        <AuditRow label="Recovered products" value={String(genSnap.recoveredProducts)}
          highlight={genSnap.recoveredProducts >= genSnap.expectedProducts ? "ok" : "warn"} />
        <AuditRow label="Expected refs"      value={String(genSnap.expectedReferences)} />
        <AuditRow label="Recovered refs"     value={String(genSnap.recoveredReferences)}
          highlight={genSnap.recoveredReferences >= genSnap.expectedReferences ? "ok" : "warn"} />
        {detail.setupSnapshotMissingReasons.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <p style={{ margin: "0 0 4px", fontSize: 10, color: UI.textMuted }}>Why earlier sources were skipped:</p>
            {detail.setupSnapshotMissingReasons.map((r, i) => (
              <p key={i} style={{ margin: "0 0 2px", fontSize: 9, color: UI.textMuted, paddingLeft: 8 }}>• {r}</p>
            ))}
          </div>
        )}
      </AuditBlock>

      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 8, background: "rgba(124,58,237,0.08)", border: `1px solid ${UI.border}` }}>
        <Cpu style={{ width: 12, height: 12, color: UI.purple, flexShrink: 0 }} />
        <p style={{ margin: 0, fontSize: 9, color: UI.textSec, lineHeight: 1.5 }}>
          Category audit is recorded per-session in memory. Reload or close the tab and the audit fields will not be available for older pins — use backend logs for historical records.
        </p>
      </div>
    </div>
  );
}

// ── Public types ──────────────────────────────────────────────────────────────

export type PinDetailsGenStatus = "idle" | "loading" | "success" | "error";

export type PinMetadataFormState = {
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  plannedDate: string;
  metadataDraft: PinMetadataDraft | null;
};

export type PinDetailsDrawerProps = {
  open: boolean;
  initialTab?: DrawerTab;
  detail: PinDetailView | null;
  metadataForm: PinMetadataFormState | null;
  pinDetailsGenStatus: PinDetailsGenStatus;
  readinessLabel: MetadataReadinessLabel | null;
  isDirty: boolean;
  showSaved: boolean;
  onClose: () => void;
  onMetadataChange: (patch: Partial<PinMetadataFormState>) => void;
  onSelectTitleCandidate: (title: string) => void;
  onRegenerateTitles: () => void;
  onRegenerateDescription: () => void;
  onSaveChanges: () => void;
  onRetryGenerateDetails?: () => void;
  onAddToPlan?: () => void;
  onDownload?: () => void;
  onRegenerate?: () => void;
  onSaveAsReference?: () => void;
  onRetryPin?: () => void;
  onRetryGroup?: () => void;
  onReuseSetup?: () => void;
  onViewSetup?: () => void;
  onRegenerateWithRemix?: (remixSetup: RemixDraftSetup) => void;
  onMarkAsPosted?: () => void;
  canViewDebug?: boolean;
};

// ── Main component ────────────────────────────────────────────────────────────

export function PinDetailsDrawer({
  open, initialTab = "remix",
  detail, metadataForm, pinDetailsGenStatus, readinessLabel, isDirty, showSaved,
  onClose, onMetadataChange, onSelectTitleCandidate, onRegenerateTitles, onRegenerateDescription,
  onSaveChanges, onRetryGenerateDetails,
  onAddToPlan, onDownload, onRegenerate, onSaveAsReference,
  onRetryPin, onRetryGroup, onReuseSetup, onViewSetup,
  onRegenerateWithRemix, onMarkAsPosted, canViewDebug = false,
}: PinDetailsDrawerProps) {

  const [activeTab, setActiveTab] = useState<DrawerTab>(initialTab);
  // Remix draft — initialized from setupSnapshot, never mutates it
  const [remixDraft, setRemixDraft] = useState<RemixDraftSetup | null>(null);
  // Inline URL-add state for Remix tab product/reference inputs
  const [addingProductUrl, setAddingProductUrl] = useState("");
  const [showAddProduct,   setShowAddProduct]   = useState(false);
  const [addingRefUrl,     setAddingRefUrl]      = useState("");
  const [showAddRef,       setShowAddRef]        = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [pickerReplaceKey,  setPickerReplaceKey]  = useState<string | null>(null);
  const [editingProductUrl, setEditingProductUrl] = useState<string | false>(false);

  // Reset tab and remix draft when a new pin is opened or initialTab changes
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset drawer-local state when a new pin opens
      setActiveTab(initialTab === "debug" && !canViewDebug ? "remix" : initialTab);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- lazy remix draft must restart per opened pin
      setRemixDraft(null); // lazy-init when Remix tab first opens
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, detail?.pinId, initialTab, canViewDebug]);

  // Lazy-init remix draft when switching to Remix tab — use full detail context for best recovery
  useEffect(() => {
    if (activeTab === "remix" && !remixDraft && detail) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializes editable remix draft from immutable detail
      setRemixDraft(initRemixFromDetail(detail));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !detail) return null;

  const badgeColor       = statusColor(detail.statusLabel);
  const isFailed         = detail.statusLabel === "Failed";
  const isGenerating     = detail.statusLabel === "Generating" || detail.statusLabel === "Queued";
  const isCompleted      = detail.statusLabel === "Completed" || detail.statusLabel === "Added to Plan";
  const isAdded          = detail.statusLabel === "Added to Plan";
  const hasSetupSnapshot = !!detail.setupSnapshot;
  const promptText       = detail.promptSnapshot;
  const failureText      = detail.errorMessage?.trim() || "Unknown generation error.";
  const dlName           = detail.pin ? `vibepin-${detail.sessionId.slice(-8)}-${detail.pin.id.slice(-6)}.png` : "";
  const form             = metadataForm;
  const titleEntries     = form?.metadataDraft ? getTitleCandidateEntries(form.metadataDraft) : [];
  const isGenLoading     = pinDetailsGenStatus === "loading";
  const isGenError       = pinDetailsGenStatus === "error";
  const showLowConf      = form?.metadataDraft ? shouldShowLowConfidenceHint(form.metadataDraft) : false;

  // ── Products (Primary + Additional Tagged) ──────────────────────────────────
  const { primary: primaryProduct, tagged: taggedProducts } = resolvePinProducts(form?.metadataDraft);
  const primaryUrl       = primaryProduct?.productUrl?.trim() || "";
  const destValue        = form?.destinationUrl?.trim() || "";
  const destFilled       = !!destValue;
  const destFromPrimary  = destFilled && !!primaryUrl && destValue === primaryUrl;
  // "Use primary product URL" is offered whenever a primary URL exists and the
  // destination doesn't already match it. Missing warning only when truly empty + no source.
  const canUsePrimaryUrl = !!primaryUrl && destValue !== primaryUrl;
  const destMissing      = isCompleted && !destFilled && !primaryUrl;
  // True when the destination is a user-entered URL that doesn't come from the primary
  // product — used to label Product URL vs Destination URL distinctly.
  const destCustom       = destFilled && !destFromPrimary;

  // Safe "use product URL as destination URL": fill when empty; confirm before
  // overwriting an existing custom destination URL (never silently clobber).
  const applyPrimaryUrlToDestination = () => {
    if (!primaryUrl) return;
    if (destFilled && destValue !== primaryUrl
      && !window.confirm("Replace the current destination URL with the primary product URL?")) return;
    onMetadataChange({ destinationUrl: primaryUrl });
  };

  // Default the picker's "Link as" to Primary when replacing the primary (it's removed first).
  const replacingPrimary = !!pickerReplaceKey && !!primaryProduct && productKey(primaryProduct) === pickerReplaceKey;
  const pickerHasPrimary = replacingPrimary ? false : !!primaryProduct;

  const remix        = remixDraft ?? initRemixFromDetail(detail);
  const remixIsDirty = !!remixDraft && JSON.stringify(remixDraft) !== JSON.stringify(initRemixFromDetail(detail));
  // The normaliser resolves recovery quality across ALL sources (IndexedDB, sessionStorage,
  // historyEntry, group refUrl) and tells us exactly how much of the original setup was
  // restored — full / visual_partial / text_only / unavailable.
  const _genSnap = getGenerationSetupSnapshot(detail);
  const recoveryQuality = _genSnap.recoveryQuality;
  // How many visual inputs are still missing (used by the calm recovery notice).
  const missingProducts   = Math.max(0, _genSnap.expectedProducts   - _genSnap.recoveredProducts);
  const missingReferences = Math.max(0, _genSnap.expectedReferences - _genSnap.recoveredReferences);

  function switchToRemix() {
    if (!remixDraft) setRemixDraft(initRemixFromDetail(detail!));
    setActiveTab("remix");
  }

  const actionBtn: React.CSSProperties = {
    padding: "8px 12px", borderRadius: 8, border: `1px solid ${UI.borderStr}`,
    background: UI.cardElev, color: UI.text, fontSize: 11, fontWeight: 700, cursor: "pointer",
  };
  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8,
    border: `1px solid ${UI.border}`, fontSize: 11, color: UI.text, background: UI.cardElev,
    outline: "none", fontFamily: "inherit",
  };

  const TABS: { id: DrawerTab; label: string; testId: string }[] = [
    { id: "remix", label: "Remix", testId: "pin-details-tab-remix" },
    ...(canViewDebug ? [{ id: "debug" as const, label: "Debug", testId: "pin-details-tab-debug" }] : []),
  ];

  // Setup summary for compact failure panel
  const failedSetupParts: string[] = [];
  {
    const prodCount = detail.setupSnapshot?.selectedProducts.length ?? 0;
    const refCount  = detail.setupSnapshot?.selectedReferences.length ??
                      (detail.session.groups[detail.groupIdx]?.refUrl ? 1 : 0);
    if (prodCount > 0) failedSetupParts.push(`${prodCount} product${prodCount !== 1 ? "s" : ""}`);
    if (refCount  > 0) failedSetupParts.push(`${refCount} reference${refCount  !== 1 ? "s" : ""}`);
    if (detail.format) failedSetupParts.push(detail.format);
  }

  function toLinkedProductFromSelection(p: ProductSelection): LinkedProduct {
    return {
      productId:    p.id,
      title:        p.title?.trim() || "Product",
      imageUrl:     p.imageUrl,
      thumbnailUrl: p.imageUrl,
      productUrl:   p.url,
      canonicalUrl: p.canonicalUrl,
      store:        p.store,
      price:        p.price,
      currency:     p.currency,
      source:       normalizeProductSource(p.source),
      linkType:     "manual",
    };
  }

  function handleProductSelect(p: ProductSelection) {
    setShowProductPicker(false);
    const draft = form?.metadataDraft;
    if (!draft) { setPickerReplaceKey(null); return; }
    let next = draft;
    // "Change" replaces the targeted product before adding the new one.
    if (pickerReplaceKey) {
      next = removeProductFromDraft(next, pickerReplaceKey).draft;
    }
    const lp = toLinkedProductFromSelection(p);
    // After a primary replace, no primary exists, so honor asPrimary as-is.
    next = addProductToDraft(next, lp, p.asPrimary);
    onMetadataChange({ metadataDraft: next });
    setPickerReplaceKey(null);
  }

  function handleRemoveProduct(key: string) {
    const draft = form?.metadataDraft;
    if (!draft) return;
    const { draft: next } = removeProductFromDraft(draft, key);
    onMetadataChange({ metadataDraft: next });
  }

  function handlePromoteToPrimary(key: string) {
    const draft = form?.metadataDraft;
    if (!draft) return;
    onMetadataChange({ metadataDraft: promoteProductToPrimary(draft, key) });
  }

  function handleEditLinkSave(url: string) {
    setEditingProductUrl(false);
    const draft = form?.metadataDraft;
    if (!draft) return;
    onMetadataChange({ metadataDraft: setPrimaryProductUrl(draft, url) });
  }

  function openAddProduct()             { setPickerReplaceKey(null); setShowProductPicker(true); }
  function openChangeProduct(key: string) { setPickerReplaceKey(key); setShowProductPicker(true); }

  return (
    <>
      <div data-testid="pin-details-backdrop" onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.38)", zIndex: 45 }} />
      <aside
        data-testid="pin-details-drawer"
        role="dialog"
        aria-label="Pin Details"
        style={{
          position: "absolute", right: 0, top: 0, bottom: 0, zIndex: 46,
          width: "min(480px,92%)", maxWidth: 520, minWidth: 420,
          background: UI.card, borderLeft: `1px solid ${UI.borderStr}`,
          boxShadow: "-12px 0 40px rgba(0,0,0,0.45)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* ── Header ── */}
        <header style={{ padding: "14px 18px 10px", borderBottom: `1px solid ${UI.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
            <div>
              <h2 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 800, color: UI.text }}>Pin Details</h2>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <span data-testid="pin-details-status-badge" style={{
                  display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999,
                  fontSize: 10, fontWeight: 800, color: "var(--app-text, #EAFDF5)", background: "var(--app-surface-3, rgba(8,13,25,0.78))",
                  border: `1px solid ${badgeColor}55`,
                }}>
                  {!isFailed && !isGenerating && <CheckCircle2 style={{ width: 11, height: 11, color: badgeColor }} />}
                  {detail.statusLabel}
                </span>
                {isCompleted && readinessLabel && (
                  <span data-testid="pin-details-readiness-badge" style={{
                    display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 999,
                    fontSize: 10, fontWeight: 800, color: "var(--app-text, #EAFDF5)", background: "var(--app-surface-3, rgba(8,13,25,0.78))",
                    border: `1px solid ${readinessColor(readinessLabel)}55`,
                  }}>
                    {readinessLabel}
                  </span>
                )}
              </div>
            </div>
            <button type="button" data-testid="pin-details-close" onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", color: UI.textSec, padding: 4 }}>
              <X style={{ width: 18, height: 18 }} />
            </button>
          </div>
        </header>

        {/* ── Tab bar ── */}
        <nav data-testid="pin-details-tab-bar" style={{ display: "flex", borderBottom: `1px solid ${UI.border}`, flexShrink: 0, padding: "0 18px" }}>
          {TABS.map(tab => (
            <button key={tab.id} type="button" data-testid={tab.testId}
              onClick={() => { if (tab.id === "remix") { switchToRemix(); } else { setActiveTab(tab.id as DrawerTab); } }}
              style={{
                padding: "10px 14px", fontSize: 12, fontWeight: 700, border: "none", background: "none", cursor: "pointer",
                color: activeTab === tab.id ? UI.text : UI.textMuted,
                borderBottom: activeTab === tab.id ? `2px solid ${UI.purple}` : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* ── Tab content ── */}
        <div className="studio-scroll" style={{ flex: 1, overflowY: "auto" }}>


          {/* ───────────────── REMIX TAB ───────────────── */}
          {activeTab === "remix" && (
            <div style={{ padding: "14px 18px 18px", display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Calm, quality-aware recovery notice. "full" shows nothing. */}
              {recoveryQuality === "visual_partial" && (
                <div data-testid="pin-details-remix-recovery-notice" style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.cardElev }}>
                  <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: UI.text }}>Some inputs were reattached below</p>
                  <p style={{ margin: "3px 0 0", fontSize: 10, color: UI.textMuted, lineHeight: 1.5 }}>
                    We recovered the prompt, settings{_genSnap.recoveredReferences > 0 || _genSnap.recoveredProducts > 0 ? ", and most images" : ""}.
                    {missingProducts > 0 ? ` ${missingProducts} product image${missingProducts !== 1 ? "s" : ""} couldn’t be restored.` : ""}
                    {missingReferences > 0 ? ` ${missingReferences} reference${missingReferences !== 1 ? "s" : ""} couldn’t be restored.` : ""}
                    {" "}Reattach below, then Generate again.
                  </p>
                </div>
              )}
              {recoveryQuality === "text_only" && (
                <div data-testid="pin-details-remix-recovery-notice" style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.cardElev }}>
                  <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: UI.text }}>Prompt and settings recovered</p>
                  <p style={{ margin: "3px 0 0", fontSize: 10, color: UI.textMuted, lineHeight: 1.5 }}>
                    Some original inputs are unavailable. We recovered the prompt and settings we could find.
                    Reattach product images or pin references below — or just Generate again with the prompt.
                  </p>
                </div>
              )}
              {recoveryQuality === "unavailable" && (
                <div data-testid="pin-details-remix-recovery-notice" style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.cardElev }}>
                  <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: UI.text }}>Original setup wasn’t saved</p>
                  <p style={{ margin: "3px 0 0", fontSize: 10, color: UI.textMuted, lineHeight: 1.5 }}>
                    This Pin was created before setup was saved. Rebuild it below: add product images, add pin references, or use this Pin as a reference, then Generate again.
                  </p>
                </div>
              )}

              {/* Product Images */}
              <section data-testid="pin-details-setup-products">
                <SectionTitle>Product Images used in this batch ({remix.selectedProducts.length})</SectionTitle>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                  {remix.selectedProducts.map((p, i) => p.imageUrl ? (
                    <div key={i} style={{ position: "relative" }}>
                      <div style={{ width: 72, height: 72, borderRadius: 8, overflow: "hidden", border: `1px solid ${UI.border}`, background: "var(--app-bg, #0B1020)" }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={toProxyUrl(p.imageUrl)} alt={p.title || ""} title={p.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      </div>
                      <button type="button" aria-label="Remove product"
                        onClick={() => setRemixDraft(prev => ({ ...(prev ?? remix), selectedProducts: (prev ?? remix).selectedProducts.filter((_, j) => j !== i) }))}
                        style={{ position: "absolute", top: 3, right: 3, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.72)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, lineHeight: 1 }}>
                        ×
                      </button>
                    </div>
                  ) : null)}
                  {!showAddProduct && (
                    <button type="button" onClick={() => setShowAddProduct(true)}
                      style={{ width: 72, height: 72, borderRadius: 8, border: `1px dashed ${UI.border}`, background: "none", color: UI.textMuted, fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      +
                    </button>
                  )}
                </div>
                {showAddProduct && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <input value={addingProductUrl} onChange={e => setAddingProductUrl(e.target.value)}
                      placeholder="Paste image URL…" style={{ ...fieldStyle, flex: 1 }}
                      onKeyDown={e => {
                        if (e.key === "Enter" && addingProductUrl.trim()) {
                          setRemixDraft(prev => ({ ...(prev ?? remix), selectedProducts: [...(prev ?? remix).selectedProducts, { imageUrl: addingProductUrl.trim(), title: "" }] }));
                          setAddingProductUrl(""); setShowAddProduct(false);
                        }
                      }} />
                    <button type="button" onClick={() => {
                      if (addingProductUrl.trim()) {
                        setRemixDraft(prev => ({ ...(prev ?? remix), selectedProducts: [...(prev ?? remix).selectedProducts, { imageUrl: addingProductUrl.trim(), title: "" }] }));
                        setAddingProductUrl(""); setShowAddProduct(false);
                      }
                    }} style={{ ...actionBtn, whiteSpace: "nowrap" as const }}>Add</button>
                    <button type="button" onClick={() => { setAddingProductUrl(""); setShowAddProduct(false); }} style={{ ...actionBtn, color: UI.textMuted }}>✕</button>
                  </div>
                )}
                <p style={{ margin: "6px 0 0", fontSize: 10, color: UI.textMuted }}>Product assets are separate from Pin references.</p>
              </section>

              {/* Pin References */}
              <section data-testid="pin-details-setup-references">
                <SectionTitle>Pin References used as visual direction ({remix.selectedReferences.length})</SectionTitle>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                  {remix.selectedReferences.map((r, i) => (
                    <div key={i} style={{ position: "relative" }}>
                      <div style={{ width: 50, height: 72, borderRadius: 8, overflow: "hidden", border: `1px solid ${UI.border}`, background: "var(--app-bg, #0B1020)" }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={toProxyUrl(r.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      </div>
                      <button type="button" aria-label="Remove reference"
                        onClick={() => setRemixDraft(prev => ({ ...(prev ?? remix), selectedReferences: (prev ?? remix).selectedReferences.filter((_, j) => j !== i) }))}
                        style={{ position: "absolute", top: 3, right: 3, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.72)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, lineHeight: 1 }}>
                        ×
                      </button>
                    </div>
                  ))}
                  {!showAddRef && (
                    <button type="button" onClick={() => setShowAddRef(true)}
                      style={{ width: 50, height: 72, borderRadius: 8, border: `1px dashed ${UI.border}`, background: "none", color: UI.textMuted, fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      +
                    </button>
                  )}
                </div>
                {showAddRef && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <input value={addingRefUrl} onChange={e => setAddingRefUrl(e.target.value)}
                      placeholder="Paste image URL…" style={{ ...fieldStyle, flex: 1 }}
                      onKeyDown={e => {
                        if (e.key === "Enter" && addingRefUrl.trim()) {
                          setRemixDraft(prev => ({ ...(prev ?? remix), selectedReferences: [...(prev ?? remix).selectedReferences, { imageUrl: addingRefUrl.trim() }] }));
                          setAddingRefUrl(""); setShowAddRef(false);
                        }
                      }} />
                    <button type="button" onClick={() => {
                      if (addingRefUrl.trim()) {
                        setRemixDraft(prev => ({ ...(prev ?? remix), selectedReferences: [...(prev ?? remix).selectedReferences, { imageUrl: addingRefUrl.trim() }] }));
                        setAddingRefUrl(""); setShowAddRef(false);
                      }
                    }} style={{ ...actionBtn, whiteSpace: "nowrap" as const }}>Add</button>
                    <button type="button" onClick={() => { setAddingRefUrl(""); setShowAddRef(false); }} style={{ ...actionBtn, color: UI.textMuted }}>✕</button>
                  </div>
                )}
              </section>

              {/* Opportunity / Keyword */}
              <section data-testid="pin-details-setup-opportunity">
                <SectionTitle>Opportunity / Keyword</SectionTitle>
                {remix.opportunityTitle || remix.keyword ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {remix.opportunityTitle && (
                      <span style={{ display: "inline-flex", alignItems: "center", padding: "5px 12px", borderRadius: 999, border: `1px solid ${UI.border}`, background: UI.cardElev, fontSize: 11, fontWeight: 700, color: UI.text, alignSelf: "flex-start" }}>
                        {remix.opportunityTitle}
                      </span>
                    )}
                    {remix.keyword && (
                      <p style={{ margin: 0, fontSize: 10, color: UI.textMuted }}>{remix.keyword}{remix.category ? ` · ${remix.category}` : ""}</p>
                    )}
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: 11, color: UI.textMuted }}>No opportunity used.</p>
                )}
              </section>

              {/* Prompt */}
              <section data-testid="pin-details-prompt">
                <SectionTitle>Prompt</SectionTitle>
                <textarea
                  data-testid="pin-details-remix-prompt"
                  value={remix.prompt}
                  rows={5}
                  style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.6 }}
                  onChange={e => setRemixDraft(prev => ({ ...(prev ?? remix), prompt: e.target.value }))}
                />
              </section>

              {/* Settings */}
              <section data-testid="pin-details-setup-settings">
                <SectionTitle>Settings</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

                  {/* Images */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: UI.textMuted, flexShrink: 0 }}>Images</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {[1,2,3,4].map(n => (
                        <button key={n} type="button"
                          onClick={() => setRemixDraft(prev => ({ ...(prev ?? remix), imagesPerReference: n }))}
                          style={{
                            padding: "3px 9px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
                            border: `1px solid ${remix.imagesPerReference === n ? UI.purple : UI.border}`,
                            background: remix.imagesPerReference === n ? UI.purpleBg : UI.cardElev,
                            color: remix.imagesPerReference === n ? "#C4B5FD" : UI.textMuted,
                          }}>{n}</button>
                      ))}
                    </div>
                  </div>

                  {/* Aspect ratio */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                    <span style={{ fontSize: 11, color: UI.textMuted, flexShrink: 0, paddingTop: 3 }}>Ratio</span>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {["2:3","4:5","3:4","1:1","9:16","16:9"].map(r => (
                        <button key={r} type="button"
                          onClick={() => setRemixDraft(prev => ({ ...(prev ?? remix), format: r }))}
                          style={{
                            padding: "3px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer",
                            border: `1px solid ${remix.format === r ? UI.purple : UI.border}`,
                            background: remix.format === r ? UI.purpleBg : UI.cardElev,
                            color: remix.format === r ? "#C4B5FD" : UI.textMuted,
                          }}>{r}</button>
                      ))}
                    </div>
                  </div>

                  {/* Model */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: UI.textMuted, flexShrink: 0 }}>Model</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {([{ value: "gpt_image", label: "GPT Image" }, { value: "nano_banana", label: "Nano Banana" }] as const).map(opt => (
                        <button key={opt.value} type="button"
                          onClick={() => setRemixDraft(prev => ({ ...(prev ?? remix), modelKey: opt.value }))}
                          style={{
                            padding: "3px 9px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
                            border: `1px solid ${(remix.modelKey ?? "gpt_image") === opt.value ? UI.purple : UI.border}`,
                            background: (remix.modelKey ?? "gpt_image") === opt.value ? UI.purpleBg : UI.cardElev,
                            color: (remix.modelKey ?? "gpt_image") === opt.value ? "#C4B5FD" : UI.textMuted,
                          }}>{opt.label}</button>
                      ))}
                    </div>
                  </div>

                </div>
              </section>

              {/* Remix actions */}
              <section data-testid="pin-details-remix-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" data-testid="pin-details-regenerate-with-remix"
                  onClick={() => onRegenerateWithRemix?.(remix)}
                  style={{ flex: 1, padding: "9px 16px", borderRadius: 8, border: "none", background: UI.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                  Generate again
                </button>
                <button type="button" data-testid="pin-details-remix-reset"
                  onClick={() => setRemixDraft(initRemixFromDetail(detail))}
                  style={actionBtn}>
                  Reset
                </button>
              </section>
            </div>
          )}

          {/* ───────────────── DEBUG TAB ───────────────── */}
          {canViewDebug && activeTab === "debug" && (
            <DebugPanel detail={detail} genSnap={_genSnap} recoveryQuality={recoveryQuality} />
          )}

          {/* ───────────────── PLAN TAB ───────────────── */}
          {activeTab === "plan" && (
            <div style={{ padding: "14px 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>

              {/* ── Compact image strip ── */}
              {isCompleted && detail.imageUrl && (
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div data-testid="pin-details-preview" style={{
                    width: 72, height: 96, borderRadius: 8, overflow: "hidden",
                    border: `1px solid ${UI.border}`, background: "var(--app-bg, #0B1020)", flexShrink: 0,
                  }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img data-testid="pin-details-preview-image" src={toProxyUrl(detail.imageUrl)} alt="Generated pin"
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                    <MetaRow label="Generated" value={new Date(detail.createdAt).toLocaleString()} />
                    <MetaRow label="Ratio"     value={detail.format ?? "2:3"} />
                    <MetaRow label="Model"     value={detail.model} />
                    {detail.imageUrl && (
                      <a href={toProxyUrl(detail.imageUrl)} download={dlName} onClick={onDownload}
                        style={{ fontSize: 9, fontWeight: 600, color: UI.textMuted, textDecoration: "none", marginTop: 2 }}>
                        ↓ Download
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Failure panel */}
              {isFailed && (
                <div data-testid="pin-details-failure" style={{
                  borderRadius: 10, border: `1px solid rgba(239,68,68,0.28)`,
                  background: "rgba(239,68,68,0.06)", padding: "12px 14px",
                  display: "flex", flexDirection: "column", gap: 10,
                }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <AlertCircle style={{ width: 16, height: 16, color: UI.error, flexShrink: 0, marginTop: 1 }} />
                    <div>
                      <p data-testid="pin-details-failed-label" style={{ margin: 0, fontWeight: 800, fontSize: 12, color: UI.error }}>Failed to generate</p>
                      <p data-testid="pin-details-error-reason" style={{ margin: "3px 0 0", fontSize: 10, color: UI.textSec, lineHeight: 1.5 }}>{failureText}</p>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" data-testid="pin-details-retry-pin" onClick={onRetryPin}
                      style={{ ...actionBtn, flex: 1, textAlign: "center" as const }}>Try again</button>
                    <button type="button" data-testid="pin-details-edit-and-retry" onClick={switchToRemix}
                      style={{ ...actionBtn, flex: 1, textAlign: "center" as const }}>Edit and retry</button>
                  </div>
                </div>
              )}

              {/* Generating spinner */}
              {isGenerating && (
                <div style={{ borderRadius: 10, border: `1px solid ${UI.border}`, background: "rgba(124,58,237,0.05)", padding: "20px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 18, height: 18, border: `2px solid ${UI.purple}40`, borderTopColor: UI.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: UI.text }}>
                    {detail.statusLabel === "Queued" ? "Queued…" : "Generating…"}
                  </p>
                </div>
              )}

              <section data-testid="pin-details-editor">
                <SectionTitle>Pin Details</SectionTitle>

                {isGenLoading && (
                  <div data-testid="pin-details-generating" style={{ padding: "12px 14px", borderRadius: 10, border: `1px solid ${UI.border}`, background: UI.cardElev, marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 18, height: 18, border: `2px solid ${UI.purple}40`, borderTopColor: UI.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                    <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: UI.text }}>Generating Pin details…</p>
                  </div>
                )}

                {isGenError && (
                  <div data-testid="pin-details-generate-error" style={{ padding: "12px 14px", borderRadius: 10, border: `1px solid rgba(239,68,68,0.35)`, background: "rgba(239,68,68,0.08)", marginBottom: 12 }}>
                    <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 600, color: UI.error }}>Could not generate Pin details.</p>
                    <button type="button" data-testid="pin-details-retry-generate" onClick={onRetryGenerateDetails} style={{ ...actionBtn, borderColor: "rgba(239,68,68,0.45)", color: "#FCA5A5" }}>
                      Try again
                    </button>
                  </div>
                )}

                {form && !isGenLoading && !isGenError && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {showLowConf && (
                      <p data-testid="pin-details-low-confidence-hint" style={{ margin: "0 0 4px", fontSize: 10, color: UI.warning, lineHeight: 1.5 }}>
                        Add an opportunity or keyword to generate more search-informed titles.
                      </p>
                    )}

                    {/* ───────── CONTENT ───────── */}
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Title</label>
                        <button type="button" data-testid="pin-details-regenerate-titles" onClick={onRegenerateTitles}
                          style={{ background: "none", border: "none", cursor: "pointer", color: UI.purple, fontSize: 9, fontWeight: 700, padding: 0 }}>
                          ↻ Regenerate
                        </button>
                      </div>
                      <input data-testid="pin-details-title" value={form.title} onChange={e => onMetadataChange({ title: e.target.value })} style={fieldStyle} maxLength={100} placeholder="Title will appear after generation" />
                      <CompactTitleSuggestions entries={titleEntries} selected={form.title} onSelect={onSelectTitleCandidate} />
                    </div>

                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Description</label>
                        <button type="button" data-testid="pin-details-regenerate-description" onClick={onRegenerateDescription}
                          style={{ background: "none", border: "none", cursor: "pointer", color: UI.purple, fontSize: 9, fontWeight: 700, padding: 0 }}>
                          ↻ Regenerate
                        </button>
                      </div>
                      <textarea data-testid="pin-details-description" value={form.description} onChange={e => onMetadataChange({ description: e.target.value })} rows={4} maxLength={800} style={{ ...fieldStyle, resize: "vertical" }} placeholder="Description will appear after generation" />
                    </div>

                    {/* ───────── DESTINATION ───────── */}
                    <div style={{ borderTop: `1px solid ${UI.border}`, paddingTop: 12, marginTop: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Destination URL</label>
                        {canUsePrimaryUrl && (
                          <button type="button" data-testid="pin-details-use-product-url" onClick={applyPrimaryUrlToDestination}
                            style={{ background: "none", border: "none", cursor: "pointer", color: UI.purple, fontSize: 9, fontWeight: 700, padding: 0 }}>
                            Use product URL as destination
                          </button>
                        )}
                      </div>
                      <input data-testid="pin-details-destination-url" value={form.destinationUrl} onChange={e => onMetadataChange({ destinationUrl: e.target.value })} placeholder="https://…" style={fieldStyle} />
                      {destFromPrimary ? (
                        <p data-testid="pin-details-dest-from-primary" style={{ margin: "4px 0 0", fontSize: 9, color: UI.success, display: "flex", alignItems: "center", gap: 4 }}>
                          <CheckCircle2 style={{ width: 10, height: 10 }} /> From primary product
                        </p>
                      ) : destCustom ? (
                        <p data-testid="pin-details-dest-custom" style={{ margin: "4px 0 0", fontSize: 9, color: "#60A5FA", fontWeight: 700 }}>
                          Custom URL — the destination this Pin sends traffic to
                        </p>
                      ) : !destFilled && canUsePrimaryUrl ? (
                        <p style={{ margin: "4px 0 0", fontSize: 9, color: UI.textMuted }}>Link the primary product URL above, or paste your own.</p>
                      ) : destMissing ? (
                        <p data-testid="pin-details-destination-warning" style={{ margin: "4px 0 0", fontSize: 9, color: UI.warning }}>
                          Destination URL missing. You can still add this Pin to plan.
                        </p>
                      ) : null}
                    </div>

                    {/* ───────── PRODUCTS ───────── */}
                    <div style={{ borderTop: `1px solid ${UI.border}`, paddingTop: 12, marginTop: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <p style={{ margin: 0, fontSize: 11, fontWeight: 800, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.06em" }}>Product links</p>
                        <button type="button" data-testid="pin-details-add-product" onClick={openAddProduct}
                          style={{ background: "none", border: "none", cursor: "pointer", color: UI.purple, fontSize: 10, fontWeight: 700, padding: 0 }}>
                          + Add product link
                        </button>
                      </div>

                      {!primaryProduct && taggedProducts.length === 0 && (
                        <div data-testid="pin-details-no-product" style={{ borderRadius: 8, border: `1px dashed ${UI.borderStr}`, background: UI.cardElev, padding: "12px", textAlign: "center" }}>
                          <p style={{ margin: "0 0 8px", fontSize: 10, color: UI.textMuted, lineHeight: 1.5 }}>No product linked yet. Attach a product to keep this Pin connected to a product URL and future performance tracking.</p>
                          <button type="button" onClick={openAddProduct} style={{ ...actionBtn, padding: "4px 12px", fontSize: 10 }}>+ Add product link</button>
                          {/* Optional, secondary. VibePin Product links are NOT Pinterest Catalog product
                              tags — catalog is an advanced Pinterest feature, never required to publish. */}
                          <div style={{ marginTop: 8 }}>
                            <a href="https://www.pinterest.com/business/catalogs/" target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 9, color: UI.textMuted, textDecoration: "underline", textUnderlineOffset: 2 }}>
                              Set up Pinterest catalog ↗
                            </a>
                          </div>
                        </div>
                      )}

                      {primaryProduct && (
                        <div data-testid="pin-details-primary-product" style={{ borderRadius: 10, border: `1px solid ${UI.purple}55`, background: "rgba(124,58,237,0.06)", padding: "10px 12px", marginBottom: taggedProducts.length ? 10 : 0 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                            <span style={{ fontSize: 9, fontWeight: 800, color: "#C4B5FD", textTransform: "uppercase", letterSpacing: "0.05em" }}>Primary product</span>
                            <span style={{ fontSize: 9, fontWeight: 700, color: primaryProduct.linkType === "auto" ? UI.success : UI.textMuted, background: primaryProduct.linkType === "auto" ? "rgba(16,185,129,0.15)" : "transparent", padding: "1px 6px", borderRadius: 8 }}>
                              {primaryProduct.linkType === "auto" ? "Auto-linked" : "Manually linked"}
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <ProductThumbnail src={primaryProduct.imageUrl} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                                {primaryProduct.title}
                              </span>
                              <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 2, flexWrap: "wrap" }}>
                                <ProductSourceChip source={primaryProduct.source} />
                                {primaryProduct.store && <span style={{ fontSize: 9, color: UI.textMuted }}>{primaryProduct.store}</span>}
                                {primaryProduct.price && <span style={{ fontSize: 9, color: UI.textMuted }}>{primaryProduct.currency ?? ""}{primaryProduct.price}</span>}
                              </div>
                              {primaryProduct.productUrl && editingProductUrl === false && (
                                <p style={{ margin: "3px 0 0", fontSize: 9, color: "#818CF8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{primaryProduct.productUrl}</p>
                              )}
                              {editingProductUrl !== false && (
                                <div style={{ marginTop: 5, display: "flex", gap: 4 }}>
                                  <input value={editingProductUrl} onChange={e => setEditingProductUrl(e.target.value)} style={{ ...fieldStyle, flex: 1, padding: "4px 7px", fontSize: 10 }}
                                    // eslint-disable-next-line jsx-a11y/no-autofocus
                                    autoFocus
                                    onKeyDown={e => { if (e.key === "Enter") handleEditLinkSave((e.target as HTMLInputElement).value); if (e.key === "Escape") setEditingProductUrl(false); }} />
                                  <button type="button" onClick={() => handleEditLinkSave(editingProductUrl)} style={{ ...actionBtn, padding: "3px 8px", fontSize: 9, background: UI.gradient, border: "none", color: "#fff" }}>Save</button>
                                  <button type="button" onClick={() => setEditingProductUrl(false)} style={{ ...actionBtn, padding: "3px 8px", fontSize: 9 }}>✕</button>
                                </div>
                              )}
                            </div>
                          </div>
                          <p style={{ margin: "7px 0 0", fontSize: 9, color: UI.textMuted }}>Product URL — fills the Destination URL and gives the Pin context</p>
                          <div style={{ display: "flex", gap: 5, marginTop: 7, flexWrap: "wrap" }}>
                            <button type="button" onClick={() => openChangeProduct(productKey(primaryProduct))} style={{ ...actionBtn, padding: "3px 8px", fontSize: 9 }}>Change</button>
                            {primaryProduct.productUrl && canUsePrimaryUrl && editingProductUrl === false && (
                              <button type="button" onClick={applyPrimaryUrlToDestination} style={{ ...actionBtn, padding: "3px 8px", fontSize: 9, background: UI.gradient, border: "none", color: "#fff" }}>Use as destination URL ↗</button>
                            )}
                            {editingProductUrl === false && (
                              <button type="button" onClick={() => setEditingProductUrl(primaryProduct.productUrl ?? "")} style={{ ...actionBtn, padding: "3px 8px", fontSize: 9 }}>Edit link</button>
                            )}
                            <button type="button" onClick={() => handleRemoveProduct(productKey(primaryProduct))} style={{ ...actionBtn, padding: "3px 8px", fontSize: 9, color: UI.error, borderColor: `${UI.error}33` }}>Remove</button>
                          </div>
                        </div>
                      )}

                      {taggedProducts.length > 0 && (
                        <div data-testid="pin-details-tagged-products">
                          <p style={{ margin: "0 0 6px", fontSize: 9, fontWeight: 700, color: UI.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Linked products ({taggedProducts.length})
                          </p>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {taggedProducts.map(tp => {
                              const key = productKey(tp);
                              return (
                                <div key={key} data-testid="pin-details-tagged-product" style={{ display: "flex", gap: 8, alignItems: "center", borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.cardElev, padding: "7px 9px" }}>
                                  <ProductThumbnail src={tp.imageUrl} size={32} />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{tp.title}</span>
                                    <ProductSourceChip source={tp.source} />
                                  </div>
                                  <button type="button" onClick={() => handlePromoteToPrimary(key)} title="Set as primary" style={{ ...actionBtn, padding: "3px 7px", fontSize: 9 }}>Set primary</button>
                                  <button type="button" onClick={() => openChangeProduct(key)} title="Edit" style={{ ...actionBtn, padding: "3px 7px", fontSize: 9 }}>Edit</button>
                                  <button type="button" onClick={() => handleRemoveProduct(key)} title="Remove" style={{ ...actionBtn, padding: "3px 7px", fontSize: 9, color: UI.error, borderColor: `${UI.error}33` }}>✕</button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ───────── PLAN ───────── */}
                    <div style={{ borderTop: `1px solid ${UI.border}`, paddingTop: 12, marginTop: 4 }}>
                      <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 800, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.06em" }}>Plan</p>
                      <div style={{ display: "flex", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Pinterest board</label>
                          <input data-testid="pin-details-board" value={form.metadataDraft?.boardSuggestion ?? ""}
                            onChange={e => form.metadataDraft && onMetadataChange({ metadataDraft: { ...form.metadataDraft, boardSuggestion: e.target.value } })}
                            placeholder="Suggested board name" style={fieldStyle} />
                          <p style={{ margin: "3px 0 0", fontSize: 8.5, color: UI.textMuted, lineHeight: 1.4 }}>Suggestion only — pick the real board when you schedule or publish in Weekly Plan.</p>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Planned date</label>
                          <input data-testid="pin-details-planned-date" type="date" value={form.plannedDate} onChange={e => onMetadataChange({ plannedDate: e.target.value })} style={fieldStyle} />
                        </div>
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec, display: "block", marginBottom: 4 }}>Plan status</label>
                        <div data-testid="pin-details-plan-status" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {(() => {
                            const status = isAdded ? (form.plannedDate?.trim() ? "scheduled" : "needs_date") : "not_planned";
                            const seg = (id: string, label: string, active: boolean, onClick?: () => void, testId?: string) => (
                              <button key={id} type="button" data-testid={testId} onClick={onClick} disabled={!onClick}
                                style={{ padding: "5px 10px", borderRadius: 999, fontSize: 10, fontWeight: 700, cursor: onClick ? "pointer" : "default",
                                  border: `1px solid ${active ? UI.purple : UI.borderStr}`, background: active ? "rgba(124,58,237,0.16)" : "transparent", color: active ? "#C4B5FD" : UI.textMuted }}>
                                {label}
                              </button>
                            );
                            return [
                              seg("not_planned", "Not planned", status === "not_planned"),
                              seg("needs_date", "Needs date", status === "needs_date"),
                              seg("scheduled", "Scheduled", status === "scheduled", isAdded ? undefined : onAddToPlan, "pin-details-add-to-plan"),
                              seg("posted", "Posted", false, isAdded && onMarkAsPosted ? onMarkAsPosted : undefined, "pin-details-mark-as-posted"),
                            ];
                          })()}
                        </div>
                      </div>
                    </div>

                    {/* ───────── ACCESSIBILITY ───────── */}
                    <div style={{ borderTop: `1px solid ${UI.border}`, paddingTop: 12, marginTop: 4 }}>
                      <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 800, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.06em" }}>Accessibility</p>
                      <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Alt text</label>
                      <input data-testid="pin-details-alt-text" value={form.altText} onChange={e => onMetadataChange({ altText: e.target.value })} style={fieldStyle} maxLength={500} placeholder="Alt text will appear after generation" />
                    </div>
                  </div>
                )}
              </section>

              {isCompleted && (
                <section data-testid="pin-details-plan-actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", borderTop: `1px solid ${UI.border}`, paddingTop: 12 }}>
                  <button type="button" data-testid="pin-details-save"
                    disabled={!isDirty} onClick={onSaveChanges}
                    style={{
                      ...actionBtn,
                      opacity: isDirty ? 1 : 0.45,
                      cursor: isDirty ? "pointer" : "not-allowed",
                      background: isDirty ? UI.gradient : UI.cardElev,
                      border: isDirty ? "none" : `1px solid ${UI.borderStr}`,
                      color: isDirty ? "#fff" : UI.textMuted,
                    }}>
                    Save
                  </button>
                  {showSaved && (
                    <span data-testid="pin-details-saved-confirmation" style={{ fontSize: 10, fontWeight: 700, color: UI.success }}>Saved</span>
                  )}
                  <button type="button" data-testid="pin-details-copy-details"
                    onClick={() => {
                      const parts = [form?.title && `Title: ${form.title}`, form?.description && `Description: ${form.description}`].filter(Boolean);
                      if (parts.length) navigator.clipboard?.writeText(parts.join("\n")).catch(() => {});
                    }}
                    style={actionBtn}>
                    Copy
                  </button>
                  {readinessLabel && (
                    <span data-testid="pin-details-readiness" style={{
                      marginLeft: "auto", display: "inline-flex", alignItems: "center", padding: "4px 10px", borderRadius: 999,
                      fontSize: 10, fontWeight: 800, color: "var(--app-text, #EAFDF5)", background: "var(--app-surface-3, rgba(8,13,25,0.78))",
                      border: `1px solid ${readinessColor(readinessLabel)}55`,
                    }}>
                      {readinessLabel}
                    </span>
                  )}
                </section>
              )}
            </div>
          )}

        </div>
      </aside>
      {showProductPicker && (
        <ProductPickerModal
          title={pickerReplaceKey ? "Change product" : "Add product"}
          subtitle={replacingPrimary ? "Replace the primary product for this Pin" : "Link a product to this Pin"}
          hasPrimary={pickerHasPrimary}
          recommendedProducts={
            (detail?.setupSnapshot?.selectedProducts ?? []).length > 0
              ? detail!.setupSnapshot!.selectedProducts.map(ps => ({
                  title:    ps.title,
                  imageUrl: ps.imageUrl ?? undefined,
                  url:      ps.productUrl ?? undefined,
                  source:   ps.source ?? "product_signal",
                }))
              : undefined
          }
          onSelect={handleProductSelect}
          onClose={() => { setShowProductPicker(false); setPickerReplaceKey(null); }}
        />
      )}
    </>
  );
}
