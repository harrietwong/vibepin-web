"use client";

/**
 * StudioBoard — the FULL Create Pins page for studioBoardV2. Upload-first: no legacy
 * generation sidebar. Empty → big drag-and-drop upload zone (Upload images primary,
 * Create with AI secondary). After upload → compact Pin-card board with an "Upload
 * more" toolbar. One card expands inline at a time (activeId). Heavy AI visual
 * generation (Generate AI Image / Create with AI) opens the separate AiVersionDrawer
 * and creates NEW child cards — the original upload is never overwritten.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { UploadCloud, Upload, Loader2, Check, Clock, ArrowRight } from "lucide-react";
import { usePinBoardDrafts, type BoardFilter } from "@/hooks/usePinBoardDrafts";
import { usePinterestBoards } from "@/hooks/usePinterestBoards";
import * as pinDraftStore from "@/lib/pinDraftStore";
import * as assetStore from "@/lib/assetStore";
import { toProxyUrl } from "@/lib/imageProxy";
import type { PinDraft } from "@/lib/pinDraftStore";
import { publishPin, startPinterestConnect } from "@/lib/pinterestClient";
import { startImageAnalysis } from "@/lib/ai-copy/startImageAnalysis";
import { beginPublish, endPublish } from "@/lib/studio/pinLifecycle";
import { isPinReady, isPublishableImage } from "@/lib/pinReadiness";
import { draftReadiness } from "@/lib/weeklyPlanStats";
import { ensureScheduledPlanTime } from "@/lib/smartSchedule";
import { uploadPinImage } from "@/lib/studio/uploadPinImage";
import { generateAiVersions } from "@/lib/studio/generateAiVersions";
import { resolveModelLabel } from "@/lib/studio/modelLabel";
import { StudioBoardFilters } from "@/components/studio/StudioBoardFilters";
import { PinBoardCard } from "@/components/studio/PinBoardCard";
import { AiVersionDrawer, type AiVersionDrawerSetup, type AiVersionOptions } from "@/components/studio/AiVersionDrawer";
import { StudioBoardSkeleton } from "@/components/studio/StudioBoardSkeleton";
import { BUI } from "@/components/studio/boardUI";
import { ProductPickerModal, type ProductSelection } from "@/components/studio/ProductPickerModal";
import { normalizeProductSource, type LinkedProduct } from "@/lib/pinMetadata";
import { isShopifyIntegrationEnabled } from "@/lib/shopifyFlag";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
type AiDrawerState = { mode: "version"; draft: PinDraft } | { mode: "scratch" } | null;

export function StudioBoard() {
  const [filter, setFilter] = useState<BoardFilter>("all");
  const { items, counts, isPublishing } = usePinBoardDrafts(filter);
  const { boards, loading: boardsLoading, disconnected, needsReconnect, error: boardsErr, refresh: refreshBoards } = usePinterestBoards();
  // No usable board access = no connection OR a connection needing re-auth. Used to gate
  // scheduling/publishing (distinct from a transient boards API failure).
  const noBoardAccess = disconnected || needsReconnect;
  const boardsError = boardsErr ? "Couldn't load boards. Please try again." : undefined;
  const isDev = process.env.NODE_ENV !== "production";

  // Draft-store hydration gate. The store's SSR/server snapshot is empty and the
  // real localStorage-backed snapshot only becomes authoritative on the client. To
  // avoid briefly rendering the "empty upload zone" (a false empty state) when
  // drafts actually exist — and to avoid a hydration mismatch — we render a V2
  // loading skeleton on the SSR + first client render, then flip to the real board
  // once mounted. This is separate from the experience decision (which is already
  // resolved); it only distinguishes "loading drafts" from "empty" vs "loaded".
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
    // Client-driven generation can't survive a reload — any draft still marked
    // "generating" now is unrecoverable. Fail it so cards never stick in Generating.
    pinDraftStore.failStaleGeneratingDrafts();
  }, []);

  const [uploading, setUploading] = useState(false);
  // Per-file upload status: "Uploading 2/5…" while a multi-file batch runs.
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [aiDrawer, setAiDrawer] = useState<AiDrawerState>(null);
  const [aiSetupCache, setAiSetupCache] = useState<Record<string, AiVersionDrawerSetup>>({});
  const [aiGenerating, setAiGenerating] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const shopifyEnabled = isShopifyIntegrationEnabled();
  const fileRef = useRef<HTMLInputElement>(null);

  const flashSaved = useCallback(() => { setSaving(true); setTimeout(() => setSaving(false), 300); }, []);
  const openFilePicker = useCallback(() => fileRef.current?.click(), []);

  const hasCards = items.length > 0 || counts.all > 0;
  const aiSetupKey = aiDrawer?.mode === "version" ? aiDrawer.draft.id : aiDrawer?.mode === "scratch" ? "scratch" : null;

  // ── Upload → one board draft per image ─────────────────────────────────────
  const handleFiles = useCallback(async (files: FileList) => {
    // Snapshot to an array up front: the <input> onChange resets `value=""` right
    // after calling us, which empties the live FileList before this async loop reads
    // it. Array.from captures the File references before that happens.
    const arr = Array.from(files);
    if (!arr.length) return;
    setUploading(true);
    setUploadProgress({ done: 0, total: arr.length });
    const batchId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let ok = 0;
    const failedNames: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      try {
        const { publicUrl } = await uploadPinImage(arr[i]);
        const created = pinDraftStore.createBoardDraft({
          imageUrl: publicUrl, source: "uploaded_image", idempotencyKey: `${batchId}:${i}`,
          title: arr[i].name.replace(/\.[^.]+$/, "").slice(0, 100),
        });
        // Kick off background image analysis + keyword prep immediately — the card is
        // already created, so this never blocks upload.
        void startImageAnalysis(created.id);
        ok++;
      } catch {
        // A failed file never blocks or rolls back the successful ones.
        failedNames.push(arr[i].name);
      }
      setUploadProgress({ done: i + 1, total: arr.length });
    }
    setUploading(false);
    setUploadProgress(null);
    if (ok) { toast.success(`Uploaded ${ok} Pin${ok === 1 ? "" : "s"}.`); flashSaved(); }
    if (failedNames.length) {
      const shown = failedNames.slice(0, 3).join(", ");
      const more = failedNames.length > 3 ? ` and ${failedNames.length - 3} more` : "";
      toast.error(`Failed to upload ${shown}${more}. Try those files again.`);
    }
  }, [flashSaved]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer?.files?.length) void handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  // ── Card edits ─────────────────────────────────────────────────────────────
  // In-place field validation errors from Schedule (PRD: missing Board shows a
  // field-level error, not just a toast). Cleared as soon as a board is chosen.
  const [scheduleErrors, setScheduleErrors] = useState<Record<string, string>>({});

  const handlePersist = useCallback((id: string, patch: Partial<PinDraft>) => {
    pinDraftStore.updateDraft(id, patch); flashSaved();
    if (patch.boardId) setScheduleErrors(prev => (prev[id] ? { ...prev, [id]: "" } : prev));
  }, [flashSaved]);

  // AI Copy generation now lives inside <PinAICopyPanel> (shared across Create Pins,
  // Plan edit, and Batch Edit). The card applies results via onPersist → updateDraft.

  // ── Schedule = smart auto-assign (no pickers) ──────────────────────────────
  const handleSchedule = useCallback((id: string) => {
    const d = pinDraftStore.getDraft(id); if (!d) return;
    if (noBoardAccess || !isPinReady(draftReadiness(d))) {
      setActiveId(id);
      // Field-level error for the board (the one pickable field that most often
      // blocks scheduling); other gaps are listed in the toast. Lifecycle stays
      // Unscheduled — validation failure never creates a Scheduled state.
      if (!d.boardId?.trim() && !noBoardAccess) {
        setScheduleErrors(prev => ({ ...prev, [id]: "Choose a Pinterest board to schedule this Pin." }));
      }
      toast.error("Complete the Pin details (title, description, alt text and board) to schedule it.");
      return;
    }
    setScheduleErrors(prev => (prev[id] ? { ...prev, [id]: "" } : prev));
    const result = ensureScheduledPlanTime(id);
    if (result.ok) toast.success(result.toast); else toast.error(result.toast);
  }, [noBoardAccess]);

  // ── Publish now (from ⋮) ───────────────────────────────────────────────────
  const handlePublish = useCallback(async (id: string) => {
    const d = pinDraftStore.getDraft(id); if (!d) return;
    if (d.assetError || !isPublishableImage(d.imageUrl)) { toast.error("Image unavailable — upload the image again before publishing."); return; }
    if (noBoardAccess || !isPinReady(draftReadiness(d))) { setActiveId(id); toast.error("Complete the Pin details to publish it."); return; }
    if (!beginPublish(id)) return;
    pinDraftStore.updateDraft(id, { publishError: undefined });
    try {
      const res = await publishPin({ boardId: d.boardId, imageUrl: d.imageUrl, title: d.title || undefined, description: d.description || undefined, link: d.destinationUrl || undefined, altText: d.altText || undefined, sourcePinId: id });
      pinDraftStore.updateDraft(id, { postedAt: new Date().toISOString(), remotePinId: res.pin.id, remotePinUrl: res.pin.url, publishError: undefined });
      toast.success("Pin published successfully.");
    } catch (e) {
      pinDraftStore.updateDraft(id, { publishError: (e as Error)?.message || "Failed to publish. Please try again." });
      toast.error("Failed to publish. Please try again.");
    } finally { endPublish(id); }
  }, [noBoardAccess]);

  // ── Product → Pin (Shopify "Select product", §3.6) ─────────────────────────
  // Opening/browsing the picker never creates anything — only a confirmed selection
  // does. destinationUrl is intentionally left empty (never auto-filled, §2).
  const handleProductSelect = useCallback((p: ProductSelection) => {
    setShowProductPicker(false);
    // Multi-image selection → the first chosen image becomes the card's cover.
    const chosenImageUrl = p.images?.[0]?.url ?? p.imageUrl ?? "";
    if (!chosenImageUrl) { toast.error("That product has no image to use yet."); return; }
    const linkedProduct: LinkedProduct = {
      productId:    p.id,
      title:        p.title?.trim() || "Product",
      imageUrl:     chosenImageUrl,
      thumbnailUrl: chosenImageUrl,
      productUrl:   p.url,
      canonicalUrl: p.canonicalUrl,
      store:        p.store,
      price:        p.price,
      currency:     p.currency,
      source:       normalizeProductSource(p.source),
      linkType:     "auto",
    };
    const created = pinDraftStore.createBoardDraft({
      imageUrl: chosenImageUrl,
      source:   "uploaded_image",
      title:    p.title?.trim() || undefined,
    });
    pinDraftStore.updateDraft(created.id, {
      linkedProducts: [linkedProduct],
      primaryProductId: linkedProduct.productId,
    });
    void startImageAnalysis(created.id);
    flashSaved();
    toast.success("Created a Pin from your product.");
  }, [flashSaved]);

  // ── AI drawers ─────────────────────────────────────────────────────────────
  const handleGenerateAiImage = useCallback((d: PinDraft) => setAiDrawer({ mode: "version", draft: d }), []);
  const handleCreateWithAi = useCallback(() => setAiDrawer({ mode: "scratch" }), []);
  const handleAiGenerate = useCallback(async (opts: AiVersionOptions) => {
    if (!aiDrawer) return;
    const parent = aiDrawer.mode === "version" ? aiDrawer.draft : null;
    setAiGenerating(true);

    // 1) Create N Generating placeholder cards IMMEDIATELY so the user sees the
    //    task started (PRD 8.9). Stable keys gen:{requestId}:{i}; lineage preserved;
    //    the original upload is never touched.
    const requestId = `board_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const requested = Math.max(1, opts.count || 1);
    const setupSnapshot = {
      mode: parent ? ("board_ai_version" as const) : ("board_ai_scratch" as const),
      keyword: parent?.keyword,
      category: opts.category || parent?.category,
      opportunityTitle: parent?.opportunity,
      noTextOverlay: true,
      imagesPerReference: opts.count,
      selectedProducts: opts.productImages.map((imageUrl, index) => ({
        imageUrl,
        title: opts.productMetadata[index]?.title || parent?.title || `Product ${index + 1}`,
        productUrl: opts.productMetadata[index]?.productUrl,
      })),
      selectedReferences: opts.referenceImages.map(imageUrl => ({ imageUrl })),
      promptSnapshot: opts.directionBrief,
      creativeDirectionSnapshot: opts.creativeDirectionMeta,
      createdFrom: "studio_board",
      format: opts.format,
      model: resolveModelLabel(undefined, opts.modelKey),
      modelKey: opts.modelKey,
    };
    const placeholders = Array.from({ length: requested }, (_, i) =>
      pinDraftStore.createBoardDraft({
        // Placeholder shows the parent image while generating; scratch mode has none.
        imageUrl: parent?.imageUrl ?? "",
        source: "ai_generated_from_upload",
        idempotencyKey: `gen:${requestId}:${i}`,
        generationStatus: "generating",
        parentDraftId: parent?.id, sourceImageUrl: parent?.imageUrl,
        title: parent?.title, keyword: parent?.keyword, category: opts.category || parent?.category,
        model: resolveModelLabel(undefined, opts.modelKey),
        format: opts.format,
        generationSessionId: requestId,
        promptSnapshot: opts.directionBrief,
        setupSnapshot,
      }),
    );
    // Close the drawer right away — generation continues and the cards update.
    setAiDrawer(null);
    setAiGenerating(false);
    toast.success(`Generating ${requested} Pin${requested === 1 ? "" : "s"}…`);

    // 2) Run generation; resolve/fail each placeholder. A closed drawer or a
    //    partial failure never rolls back successful results.
    try {
      const result = await generateAiVersions({ source: parent, setup: opts });
      result.urls.slice(0, placeholders.length).forEach((url, i) => {
        pinDraftStore.completeGeneratedDraft(placeholders[i].id, url);
        void startImageAnalysis(placeholders[i].id);
      });
      // Requested more than came back → the unfilled placeholders failed.
      placeholders.slice(result.urls.length).forEach(p => pinDraftStore.failGeneratedDraft(p.id));
      // Returned more than requested (count clamped up is rare but possible) → extra cards.
      result.urls.slice(placeholders.length).forEach((url, i) => {
        const extra = pinDraftStore.createBoardDraft({
          imageUrl: url, source: "ai_generated_from_upload", idempotencyKey: `gen:${requestId}:extra:${i}`,
          parentDraftId: parent?.id, sourceImageUrl: parent?.imageUrl,
          title: parent?.title, keyword: parent?.keyword, category: opts.category || parent?.category,
          model: resolveModelLabel(undefined, opts.modelKey), format: opts.format,
          generationSessionId: requestId, promptSnapshot: opts.directionBrief, setupSnapshot,
        });
        void startImageAnalysis(extra.id);
      });
      const okCount = Math.min(result.urls.length, placeholders.length) + Math.max(0, result.urls.length - placeholders.length);
      const failCount = Math.max(0, placeholders.length - result.urls.length);
      if (okCount && failCount) toast.error(`${okCount} Pin${okCount === 1 ? "" : "s"} generated, ${failCount} failed.`);
      else if (okCount) toast.success(parent
        ? `Created ${okCount} AI Pin${okCount === 1 ? "" : "s"}. Original upload kept as a separate Pin.`
        : `Created ${okCount} AI Pin${okCount === 1 ? "" : "s"}.`);
      else { placeholders.forEach(p => pinDraftStore.failGeneratedDraft(p.id)); toast.error("No AI Pins were generated. Please try again."); }
    } catch {
      placeholders.forEach(p => pinDraftStore.failGeneratedDraft(p.id));
      toast.error("Couldn't generate. Please try again.");
    }
  }, [aiDrawer]);

  const handleDelete = useCallback((d: PinDraft) => {
    if (typeof window !== "undefined" && !window.confirm("Delete this Pin draft? This cannot be undone.")) return;
    pinDraftStore.deleteDraft(d.id); toast.success("Draft deleted.");
  }, []);
  const handleArchive = useCallback((d: PinDraft) => { pinDraftStore.archiveDraft(d.id); toast.success("Archived. This will not delete the published Pin from Pinterest."); }, []);
  const handleDuplicate = useCallback((id: string) => { pinDraftStore.duplicateDraft(id); toast.success("Duplicated."); }, []);
  const handleConnect = useCallback(() => { void startPinterestConnect(); }, []);

  // ── PRD card action matrix handlers ─────────────────────────────────────────
  const handleUnschedule = useCallback((id: string) => {
    pinDraftStore.removeFromWeeklyPlan(id);
    toast.success("Unscheduled. The Pin stays on your Create Pins board.");
  }, []);

  const handleDownload = useCallback(async (d: PinDraft) => {
    if (!d.imageUrl) { toast.error("No image to download yet."); return; }
    try {
      const res = await fetch(toProxyUrl(d.imageUrl));
      if (!res.ok) throw new Error(`http_${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const base = (d.title || "pin").replace(/[^\w-]+/g, "_").slice(0, 40) || "pin";
      a.href = url; a.download = `${base}.jpg`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Proxy unavailable → let the browser handle the original URL directly.
      window.open(d.imageUrl, "_blank", "noopener");
    }
  }, []);

  const handleSaveAsReference = useCallback((d: PinDraft) => {
    if (!d.imageUrl) { toast.error("No image to save yet."); return; }
    assetStore.saveAsset({
      role: "style_reference",
      source: d.source === "ai_generated_from_upload" ? "recent" : "upload",
      imageUrl: d.imageUrl,
      title: d.title || undefined,
      category: d.category || undefined,
      keyword: d.keyword || undefined,
    });
    toast.success("Saved to My References.");
  }, []);

  // Failed card "Try again": publish-failed → retry the real publish; generation-
  // failed → reopen the AI drawer (parent draft as source when the lineage exists).
  const handleTryAgain = useCallback((d: PinDraft) => {
    if (d.publishError?.trim()) { void handlePublish(d.id); return; }
    const parent = d.parentDraftId ? pinDraftStore.getDraft(d.parentDraftId) : null;
    setAiDrawer(parent ? { mode: "version", draft: parent } : d.imageUrl ? { mode: "version", draft: d } : { mode: "scratch" });
  }, [handlePublish]);

  // Persist failure is re-read on every render; the store emits (via
  // usePinBoardDrafts' subscription) after every write, including failed ones.
  const persistFailed = pinDraftStore.hasPersistFailure();
  const handleRetryPersist = useCallback(() => {
    if (pinDraftStore.retryPersist()) toast.success("Saved.");
    else toast.error("Still couldn't save on this device. Free up storage and retry.");
  }, []);

  const savedIndicator = persistFailed ? (
    <button type="button" data-testid="board-save-state" onClick={handleRetryPersist}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: BUI.error, background: "none", border: `1px solid ${BUI.error}55`, borderRadius: 8, padding: "3px 9px", cursor: "pointer", fontFamily: "inherit" }}>
      Failed to save · Retry
    </button>
  ) : (
    <span data-testid="board-save-state" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: BUI.textSec }}>
      {saving ? <><Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> Saving…</> : <><Check style={{ width: 12, height: 12, color: BUI.success }} /> Saved on this device</>}
    </span>
  );

  // Draft store still hydrating on the client (or SSR) → V2 loading state, never a
  // premature empty state. Matches the SSR output so hydration stays consistent.
  if (!hydrated) {
    return <StudioBoardSkeleton testId="studio-board-hydrating" />;
  }

  return (
    <div data-testid="studio-board" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, background: BUI.bg }}>
      <input ref={fileRef} type="file" accept={ACCEPT} multiple data-testid="board-upload-input" style={{ display: "none" }}
        onChange={e => { if (e.target.files?.length) void handleFiles(e.target.files); e.target.value = ""; }} />

      {/* Header */}
      <div style={{ padding: "16px 22px 10px", display: "flex", flexDirection: "column", gap: 12, background: BUI.surface, borderBottom: `1px solid ${BUI.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: BUI.text }}>Create Pins</h1>
              <p style={{ margin: "2px 0 0", fontSize: 12.5, color: BUI.textSec }}>Create, edit, schedule and publish Pinterest Pins.</p>
            </div>
            {isDev && (
              <span data-testid="studio-board-v2-marker" style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.3, color: "#fff", background: BUI.gradient, borderRadius: 999, padding: "2px 10px" }}>Studio Board V2</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            {savedIndicator}
            {shopifyEnabled && (
              <button type="button" data-testid="board-select-product" onClick={() => setShowProductPicker(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: BUI.textSec, background: "none", border: `1px solid ${BUI.border}`, borderRadius: 20, padding: "5px 12px", cursor: "pointer", fontFamily: "inherit" }}>
                Select product
              </button>
            )}
            <Link href="/app/history" data-testid="board-history" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: BUI.textSec, textDecoration: "none", border: `1px solid ${BUI.border}`, borderRadius: 20, padding: "5px 12px" }}>
              <Clock style={{ width: 12, height: 12 }} /> History
            </Link>
          </div>
        </div>
        <StudioBoardFilters value={filter} counts={counts} onChange={setFilter} />
        {hasCards && (
          <div>
            <button type="button" data-testid="board-upload-more" onClick={openFilePicker} disabled={uploading}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: `1px solid ${BUI.purple}`, background: "rgba(124,58,237,0.06)", color: BUI.purple, fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
              {uploading ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Upload style={{ width: 13, height: 13 }} />}
              {uploading && uploadProgress ? ` Uploading ${uploadProgress.done}/${uploadProgress.total}…` : " Upload more"}
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 22 }}>
        {items.length === 0 && filter === "all" ? (
          // Empty → upload-first workspace
          <div data-testid="board-empty" onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
            style={{ minHeight: 380, borderRadius: 16, border: `2px dashed ${dragOver ? BUI.purple : BUI.borderHi}`, background: dragOver ? "rgba(124,58,237,0.05)" : BUI.surface, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, textAlign: "center", padding: 24 }}>
            <div style={{ width: 68, height: 68, borderRadius: "50%", background: "rgba(124,58,237,0.10)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <UploadCloud style={{ width: 32, height: 32, color: BUI.purple }} />
            </div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: BUI.text }}>Drag and drop images here</h2>
            <p style={{ margin: 0, fontSize: 13, color: BUI.textSec }}>Upload one or more images to create editable Pin drafts.</p>
            <button type="button" data-testid="board-upload-primary" onClick={openFilePicker} disabled={uploading}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "11px 22px", borderRadius: 11, border: "none", background: BUI.gradient, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer", marginTop: 4, fontFamily: "inherit" }}>
              {uploading ? <><Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> {uploadProgress ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…` : "Uploading…"}</> : <><Upload style={{ width: 15, height: 15 }} /> Upload images</>}
            </button>
            <button type="button" data-testid="board-create-with-ai" onClick={handleCreateWithAi}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 4, fontSize: 12, fontWeight: 700, color: BUI.purple, cursor: "pointer", fontFamily: "inherit" }}>
              No image yet? Create with AI <ArrowRight style={{ width: 13, height: 13 }} />
            </button>
            {shopifyEnabled && (
              <button type="button" data-testid="board-select-product-empty" onClick={() => setShowProductPicker(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 4, fontSize: 12, fontWeight: 700, color: BUI.purple, cursor: "pointer", fontFamily: "inherit" }}>
                Create from your store? Select a product <ArrowRight style={{ width: 13, height: 13 }} />
              </button>
            )}
          </div>
        ) : items.length === 0 ? (
          <div data-testid="board-empty-filter" style={{ minHeight: 240, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, textAlign: "center", color: BUI.textSec }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: BUI.text }}>Nothing here yet</p>
            <p style={{ margin: 0, fontSize: 12.5 }}>Try a different filter, or upload more Pins.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14, alignItems: "start" }}>
            {items.map(({ draft, lifecycle }) => (
              <PinBoardCard
                key={draft.id} draft={draft} lifecycle={lifecycle} publishing={isPublishing(draft.id)}
                active={activeId === draft.id} onSetActive={setActiveId}
                boards={boards} boardsLoading={boardsLoading} disconnected={disconnected}
                needsReconnect={needsReconnect} boardsError={boardsError} onRetryBoards={refreshBoards}
                boardFieldError={scheduleErrors[draft.id] || undefined}
                onPersist={handlePersist}
                onSchedule={handleSchedule} onGenerateAiImage={handleGenerateAiImage} onPublish={handlePublish}
                onDelete={handleDelete} onArchive={handleArchive} onDuplicate={handleDuplicate}
                onUnschedule={handleUnschedule} onDownload={(d) => { void handleDownload(d); }}
                onSaveAsReference={handleSaveAsReference} onTryAgain={handleTryAgain} onConnect={handleConnect}
              />
            ))}
          </div>
        )}
      </div>

      {aiDrawer && (
        <AiVersionDrawer
          key={aiDrawer.mode === "version" ? aiDrawer.draft.id : "scratch"}
          draft={aiDrawer.mode === "version" ? aiDrawer.draft : null}
          title={aiDrawer.mode === "version" ? "Generate AI Image" : "Create with AI"}
          open generating={aiGenerating}
          initialSetup={aiSetupKey ? aiSetupCache[aiSetupKey] : undefined}
          onSetupChange={setup => {
            if (!aiSetupKey) return;
            setAiSetupCache(prev => ({ ...prev, [aiSetupKey]: setup }));
          }}
          onClose={() => setAiDrawer(null)}
          onGenerate={handleAiGenerate}
        />
      )}

      {showProductPicker && (
        <ProductPickerModal
          title="Select product"
          subtitle="Create a Pin from a product in your store."
          initialTab="shopify"
          onSelect={handleProductSelect}
          onClose={() => setShowProductPicker(false)}
        />
      )}
    </div>
  );
}
