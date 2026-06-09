"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { toProxyUrl } from "@/lib/imageProxy";
import {
  getTitleCandidateEntries,
  shouldShowLowConfidenceHint,
  type MetadataReadinessLabel,
  type PinMetadataDraft,
} from "@/lib/pinMetadata";
import type { SetupSnapshot, ProductSnapshot, ReferenceSnapshot } from "@/lib/studioPersistence";
import type { PinDetailView } from "./pinDetails";

const UI = {
  card: "#161D2E",
  cardElev: "#1A2236",
  border: "rgba(255,255,255,0.09)",
  borderStr: "rgba(255,255,255,0.12)",
  text: "#E2E8F0",
  textSec: "#8892A4",
  textMuted: "#64748B",
  purple: "#7C3AED",
  success: "#10B981",
  error: "#EF4444",
  warning: "#F59E0B",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

// ── Tab type ──────────────────────────────────────────────────────────────────

export type DrawerTab = "preview" | "remix" | "plan";

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
};

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
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11 }}>
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
};

// ── Main component ────────────────────────────────────────────────────────────

export function PinDetailsDrawer({
  open, initialTab = "preview",
  detail, metadataForm, pinDetailsGenStatus, readinessLabel, isDirty, showSaved,
  onClose, onMetadataChange, onSelectTitleCandidate, onRegenerateTitles, onRegenerateDescription,
  onSaveChanges, onRetryGenerateDetails,
  onAddToPlan, onDownload, onRegenerate, onSaveAsReference,
  onRetryPin, onRetryGroup, onReuseSetup, onViewSetup,
  onRegenerateWithRemix, onMarkAsPosted,
}: PinDetailsDrawerProps) {

  const [activeTab, setActiveTab] = useState<DrawerTab>(initialTab);
  // Remix draft — initialized from setupSnapshot, never mutates it
  const [remixDraft, setRemixDraft] = useState<RemixDraftSetup | null>(null);

  // Reset tab and remix draft when a new pin is opened or initialTab changes
  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
      setRemixDraft(null); // lazy-init when Remix tab first opens
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, detail?.pinId, initialTab]);

  // Lazy-init remix draft when switching to Remix tab
  useEffect(() => {
    if (activeTab === "remix" && !remixDraft && detail) {
      setRemixDraft(initRemixFromSnapshot(detail.setupSnapshot));
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
  const destMissing      = isCompleted && !form?.destinationUrl?.trim();
  const isGenLoading     = pinDetailsGenStatus === "loading";
  const isGenError       = pinDetailsGenStatus === "error";
  const showLowConf      = form?.metadataDraft ? shouldShowLowConfidenceHint(form.metadataDraft) : false;

  const remix            = remixDraft ?? initRemixFromSnapshot(detail.setupSnapshot);
  const remixIsDirty     = !!remixDraft && JSON.stringify(remixDraft) !== JSON.stringify(initRemixFromSnapshot(detail.setupSnapshot));

  function switchToRemix() {
    if (!remixDraft) setRemixDraft(initRemixFromSnapshot(detail!.setupSnapshot));
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
    { id: "preview", label: "Preview", testId: "pin-details-tab-preview" },
    { id: "remix",   label: "Remix",   testId: "pin-details-tab-remix" },
    { id: "plan",    label: "Plan",    testId: "pin-details-tab-plan" },
  ];

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
                  fontSize: 10, fontWeight: 800, color: "#EAFDF5", background: "rgba(8,13,25,0.78)",
                  border: `1px solid ${badgeColor}55`,
                }}>
                  {!isFailed && !isGenerating && <CheckCircle2 style={{ width: 11, height: 11, color: badgeColor }} />}
                  {detail.statusLabel}
                </span>
                {isCompleted && readinessLabel && (
                  <span data-testid="pin-details-readiness-badge" style={{
                    display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 999,
                    fontSize: 10, fontWeight: 800, color: "#EAFDF5", background: "rgba(8,13,25,0.78)",
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
              onClick={() => { if (tab.id === "remix") { switchToRemix(); } else { setActiveTab(tab.id); } }}
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

          {/* ───────────────── PREVIEW TAB ───────────────── */}
          {activeTab === "preview" && (
            <div style={{ padding: "14px 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>

              <div data-testid="pin-details-preview">
                {isCompleted && detail.imageUrl ? (
                  <div style={{ aspectRatio: "2/3", borderRadius: 12, overflow: "hidden", border: `1px solid ${UI.border}`, background: "#0B1020" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img data-testid="pin-details-preview-image" src={toProxyUrl(detail.imageUrl)} alt="Generated pin" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  </div>
                ) : (
                  <div style={{
                    aspectRatio: "2/3", borderRadius: 12, overflow: "hidden", border: `1px solid ${UI.border}`,
                    background: isFailed
                      ? "linear-gradient(145deg,rgba(239,68,68,0.2),rgba(11,16,32,0.98))"
                      : "linear-gradient(145deg,rgba(124,58,237,0.16),rgba(11,16,32,0.98))",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10,
                  }}>
                    {isFailed ? (
                      <>
                        <AlertCircle style={{ width: 32, height: 32, color: UI.error }} />
                        <p data-testid="pin-details-failed-label" style={{ margin: 0, fontSize: 13, fontWeight: 800, color: UI.error }}>Failed to generate</p>
                      </>
                    ) : (
                      <>
                        <div style={{ width: 36, height: 36, border: `3px solid ${UI.purple}40`, borderTopColor: UI.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: UI.text }}>{detail.statusLabel === "Queued" ? "Queued" : "Still generating"}</p>
                      </>
                    )}
                  </div>
                )}
              </div>

              <section data-testid="pin-details-result-meta" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <MetaRow label="Status"    value={detail.statusLabel} />
                <MetaRow label="Generated" value={new Date(detail.createdAt).toLocaleString()} />
                <MetaRow label="Format"    value={detail.format} />
                <MetaRow label="Model"     value={detail.model} />
                <MetaRow label="Batch"     value={`#BP-${detail.sessionId.slice(-9).toUpperCase()}`} />
              </section>

              {isFailed && (
                <section data-testid="pin-details-failure" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <SectionTitle>Failure details</SectionTitle>
                  <p data-testid="pin-details-error-reason" style={{ margin: 0, fontSize: 12, color: UI.text, lineHeight: 1.5 }}>{failureText}</p>
                  {detail.errorType && <MetaRow label="Error code" value={detail.errorType} />}
                </section>
              )}

              {/* Preview actions */}
              <section data-testid="pin-details-actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                {isCompleted && (
                  <>
                    {detail.imageUrl && (
                      <a data-testid="pin-details-download" href={toProxyUrl(detail.imageUrl)} download={dlName} onClick={onDownload}
                        style={{ ...actionBtn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
                        ↓ Download
                      </a>
                    )}
                    <button type="button" data-testid="pin-details-save-as-reference" onClick={onSaveAsReference} style={actionBtn}>Save as Reference</button>
                    <button type="button" data-testid="pin-details-regenerate" onClick={onRegenerate} style={actionBtn}>Regenerate</button>
                    <button type="button" data-testid="pin-details-reuse-in-remix" onClick={switchToRemix} style={actionBtn}>Reuse in Remix</button>
                  </>
                )}
                {isFailed && (
                  <>
                    <button type="button" data-testid="pin-details-retry-pin" onClick={onRetryPin} style={{ ...actionBtn, borderColor: "rgba(239,68,68,0.45)", color: "#FCA5A5" }}>Retry this Pin</button>
                    <button type="button" data-testid="pin-details-retry-group" onClick={onRetryGroup} style={actionBtn}>Retry this group</button>
                    <button type="button" onClick={switchToRemix} style={actionBtn}>Reuse in Remix</button>
                  </>
                )}
                {isGenerating && (
                  <>
                    <button type="button" data-testid="pin-details-view-setup" onClick={onViewSetup} style={actionBtn}>View setup</button>
                    <button type="button" disabled style={{ ...actionBtn, opacity: 0.45, cursor: "not-allowed" }}>Add to Plan</button>
                  </>
                )}
              </section>
            </div>
          )}

          {/* ───────────────── REMIX TAB ───────────────── */}
          {activeTab === "remix" && (
            <div style={{ padding: "14px 18px 18px", display: "flex", flexDirection: "column", gap: 18 }}>

              {!hasSetupSnapshot && (
                <div data-testid="pin-details-remix-no-snapshot" style={{ padding: "12px 14px", borderRadius: 10, border: `1px solid ${UI.border}`, background: UI.cardElev }}>
                  <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
                    Setup snapshot unavailable for this older generation. New generations save full setup details.
                  </p>
                </div>
              )}

              {/* Product Images */}
              <section data-testid="pin-details-setup-products">
                <SectionTitle>Product Images ({remix.selectedProducts.length})</SectionTitle>
                {remix.selectedProducts.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 11, color: UI.textMuted }}>No product images used.</p>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {remix.selectedProducts.map((p, i) => p.imageUrl ? (
                      <div key={i} style={{ position: "relative" }}>
                        <div style={{ width: 76, height: 76, borderRadius: 8, overflow: "hidden", border: `1px solid ${UI.border}`, background: "#0B1020" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={toProxyUrl(p.imageUrl)} alt={p.title || ""} title={p.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        </div>
                        {p.title && <p style={{ margin: "3px 0 0", fontSize: 9, color: UI.textMuted, lineHeight: 1.3, maxWidth: 76, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</p>}
                        <button type="button" aria-label="Remove"
                          onClick={() => setRemixDraft(prev => ({
                            ...(prev ?? remix),
                            selectedProducts: (prev ?? remix).selectedProducts.filter((_, j) => j !== i),
                          }))}
                          style={{ position: "absolute", top: 3, right: 3, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.72)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, lineHeight: 1 }}>
                          ×
                        </button>
                      </div>
                    ) : null)}
                  </div>
                )}
                <p style={{ margin: "8px 0 0", fontSize: 10, color: UI.textMuted }}>
                  Product assets are separate from Pin references.
                </p>
              </section>

              {/* Pin References */}
              <section data-testid="pin-details-setup-references">
                <SectionTitle>Pin References ({remix.selectedReferences.length})</SectionTitle>
                {remix.selectedReferences.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 11, color: UI.textMuted }}>No Pin references used.</p>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {remix.selectedReferences.map((r, i) => (
                      <div key={i} style={{ position: "relative" }}>
                        <div style={{ width: 52, height: 76, borderRadius: 8, overflow: "hidden", border: `1px solid ${UI.border}`, background: "#0B1020" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={toProxyUrl(r.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        </div>
                        <button type="button" aria-label="Remove"
                          onClick={() => setRemixDraft(prev => ({
                            ...(prev ?? remix),
                            selectedReferences: (prev ?? remix).selectedReferences.filter((_, j) => j !== i),
                          }))}
                          style={{ position: "absolute", top: 3, right: 3, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.72)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, lineHeight: 1 }}>
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {remix.selectedReferences.length > 3 && (
                  <p style={{ margin: "6px 0 0", fontSize: 10, color: UI.textMuted }}>
                    {remix.selectedReferences.length} Pin references total.
                  </p>
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
                {!hasSetupSnapshot && !promptText ? (
                  <div style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${UI.border}`, background: UI.cardElev, fontSize: 11, color: UI.textSec, lineHeight: 1.6 }}>
                    Setup snapshot unavailable for this older generation.
                  </div>
                ) : (
                  <textarea
                    data-testid="pin-details-remix-prompt"
                    value={remix.prompt || promptText || ""}
                    rows={6}
                    style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.6 }}
                    onChange={e => setRemixDraft(prev => ({ ...(prev ?? remix), prompt: e.target.value }))}
                  />
                )}
              </section>

              {/* Generation Settings */}
              <section data-testid="pin-details-setup-settings">
                <SectionTitle>Generation Settings</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: UI.textMuted }}>Images</span>
                    <select value={remix.imagesPerReference}
                      onChange={e => setRemixDraft(prev => ({ ...(prev ?? remix), imagesPerReference: Number(e.target.value) }))}
                      style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${UI.border}`, background: UI.cardElev, color: UI.text, fontSize: 11, outline: "none" }}>
                      {[1,2,3,4].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: UI.textMuted }}>Text overlay</span>
                    <button type="button" onClick={() => setRemixDraft(prev => ({ ...(prev ?? remix), noTextOverlay: !(prev ?? remix).noTextOverlay }))}
                      style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${UI.border}`, background: UI.cardElev, color: UI.text, fontSize: 11, cursor: "pointer" }}>
                      {remix.noTextOverlay ? "Off" : "On"}
                    </button>
                  </div>
                  <MetaRow label="Format" value={detail.format} />
                  <MetaRow label="Model"  value={detail.model} />
                  <MetaRow label="Created" value={new Date(detail.createdAt).toLocaleString()} />
                </div>
              </section>

              {/* Remix actions */}
              <section data-testid="pin-details-remix-actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button type="button" data-testid="pin-details-regenerate-with-remix"
                  onClick={() => onRegenerateWithRemix?.(remix)}
                  style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: UI.gradient, color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                  Regenerate with changes
                </button>
                {remixIsDirty && (
                  <button type="button" data-testid="pin-details-remix-reset"
                    onClick={() => setRemixDraft(initRemixFromSnapshot(detail.setupSnapshot))}
                    style={actionBtn}>
                    Reset to original
                  </button>
                )}
                <button type="button" data-testid="pin-details-remix-cancel"
                  onClick={() => { setRemixDraft(null); setActiveTab("preview"); }}
                  style={{ ...actionBtn, color: UI.textMuted }}>
                  Cancel
                </button>
              </section>
            </div>
          )}

          {/* ───────────────── PLAN TAB ───────────────── */}
          {activeTab === "plan" && (
            <div style={{ padding: "14px 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>

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

                    <div>
                      <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Title</label>
                      <input data-testid="pin-details-title" value={form.title} onChange={e => onMetadataChange({ title: e.target.value })} style={fieldStyle} maxLength={100} placeholder="Title will appear after generation" />
                    </div>

                    {titleEntries.length > 0 && (
                      <div data-testid="pin-details-title-candidates">
                        <p style={{ margin: "0 0 6px", fontSize: 10, color: UI.textMuted }}>Suggested</p>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {titleEntries.map((entry, i) => (
                            <button key={i} type="button" data-testid={`pin-details-title-candidate-${i}`} onClick={() => onSelectTitleCandidate(entry.text)}
                              style={{ padding: "8px 10px", borderRadius: 6, border: `1px solid ${UI.border}`, background: form.title === entry.text ? "rgba(124,58,237,0.2)" : UI.cardElev, color: UI.textSec, fontSize: 10, textAlign: "left", cursor: "pointer" }}>
                              <span style={{ display: "block", fontWeight: 700, color: UI.text, marginBottom: 3 }}>{entry.text}</span>
                              <span data-testid={`pin-details-title-source-${i}`} style={{ fontSize: 9, color: UI.textMuted }}>{entry.sourceLabel}</span>
                            </button>
                          ))}
                        </div>
                        <button type="button" data-testid="pin-details-regenerate-titles" onClick={onRegenerateTitles} style={{ ...actionBtn, marginTop: 6 }}>Regenerate titles</button>
                      </div>
                    )}

                    <div>
                      <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Description</label>
                      <textarea data-testid="pin-details-description" value={form.description} onChange={e => onMetadataChange({ description: e.target.value })} rows={4} maxLength={800} style={{ ...fieldStyle, resize: "vertical" }} placeholder="Description will appear after generation" />
                      <button type="button" data-testid="pin-details-regenerate-description" onClick={onRegenerateDescription} style={{ ...actionBtn, marginTop: 6 }}>Regenerate description</button>
                    </div>

                    <div>
                      <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Alt text</label>
                      <input data-testid="pin-details-alt-text" value={form.altText} onChange={e => onMetadataChange({ altText: e.target.value })} style={fieldStyle} maxLength={500} placeholder="Alt text will appear after generation" />
                    </div>

                    <div>
                      <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Destination URL</label>
                      <input data-testid="pin-details-destination-url" value={form.destinationUrl} onChange={e => onMetadataChange({ destinationUrl: e.target.value })} placeholder="https://…" style={fieldStyle} />
                      {form.metadataDraft?.destinationUrlSource && (
                        <p style={{ margin: "4px 0 0", fontSize: 9, color: UI.textMuted }}>{form.metadataDraft.destinationUrlSource}</p>
                      )}
                      {destMissing && (
                        <p data-testid="pin-details-destination-warning" style={{ margin: "4px 0 0", fontSize: 9, color: UI.warning }}>
                          Destination URL missing. You can still add this Pin to plan.
                        </p>
                      )}
                    </div>

                    <div>
                      <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Planned date</label>
                      <input data-testid="pin-details-planned-date" type="date" value={form.plannedDate} onChange={e => onMetadataChange({ plannedDate: e.target.value })} style={fieldStyle} />
                    </div>
                  </div>
                )}
              </section>

              {readinessLabel && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span data-testid="pin-details-plan-status" style={{
                    display: "inline-flex", alignItems: "center", padding: "4px 10px", borderRadius: 999,
                    fontSize: 10, fontWeight: 800, color: "#EAFDF5", background: "rgba(8,13,25,0.78)",
                    border: `1px solid ${readinessColor(readinessLabel)}55`,
                  }}>
                    {readinessLabel}
                  </span>
                </div>
              )}

              {isCompleted && (
                <section data-testid="pin-details-plan-actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
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
                    Save changes
                  </button>
                  {showSaved && (
                    <span data-testid="pin-details-saved-confirmation" style={{ fontSize: 10, fontWeight: 700, color: UI.success }}>Saved</span>
                  )}
                  <button type="button" data-testid="pin-details-add-to-plan"
                    disabled={isAdded} onClick={onAddToPlan}
                    style={{ ...actionBtn, opacity: isAdded ? 0.6 : 1 }}>
                    {isAdded ? "Added to Plan" : "Add to Plan"}
                  </button>
                  {detail.imageUrl && (
                    <a data-testid="pin-details-plan-download" href={toProxyUrl(detail.imageUrl)} download={dlName} onClick={onDownload}
                      style={{ ...actionBtn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                      Download
                    </a>
                  )}
                  <button type="button" data-testid="pin-details-copy-details"
                    onClick={() => {
                      const parts = [form?.title && `Title: ${form.title}`, form?.description && `Description: ${form.description}`].filter(Boolean);
                      if (parts.length) navigator.clipboard?.writeText(parts.join("\n")).catch(() => {});
                    }}
                    style={actionBtn}>
                    Copy details
                  </button>
                  {isAdded && onMarkAsPosted && (
                    <button type="button" data-testid="pin-details-mark-as-posted" onClick={onMarkAsPosted}
                      style={{ ...actionBtn, borderColor: `${UI.purple}55`, color: UI.purple }}>
                      Mark as posted
                    </button>
                  )}
                </section>
              )}
            </div>
          )}

        </div>
      </aside>
    </>
  );
}
