"use client";

/**
 * StudioBoard — the FULL Create Pins page for studioBoardV2. Upload-first: no legacy
 * generation sidebar. Empty → big drag-and-drop upload zone (Upload images primary,
 * Create with AI secondary). After upload → compact Pin-card board with an "Upload
 * more" toolbar. One card expands inline at a time (activeId). Heavy AI visual
 * generation (Generate AI Image / Create with AI) opens the separate AiVersionDrawer
 * and creates NEW child cards — the original upload is never overwritten.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { UploadCloud, Upload, Loader2, Check, Clock, ArrowRight, CalendarClock as CalendarClockIcon } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { usePinBoardDrafts, type BoardFilter } from "@/hooks/usePinBoardDrafts";
import { usePinterestBoards } from "@/hooks/usePinterestBoards";
import * as pinDraftStore from "@/lib/pinDraftStore";
import * as assetStore from "@/lib/assetStore";
import { toProxyUrl } from "@/lib/imageProxy";
import type { PinDraft } from "@/lib/pinDraftStore";
import { publishPin, startPinterestConnect } from "@/lib/pinterestClient";
import { startImageAnalysis } from "@/lib/ai-copy/startImageAnalysis";
import { track } from "@/lib/analytics";
import { beginPublish, endPublish, countPublishFailures, mapPublishErrorToCategory, FAILED_SUB_ENTRY_KEY, FAILED_SUB_ENTRY_PUBLISH } from "@/lib/studio/pinLifecycle";
import { FailureBanner, useFailureBannerDismiss } from "@/components/shared/FailureBanner";
import { isPinReady, isPublishableImage, pinFieldErrors, hasPinFieldErrors, type PinFieldErrors } from "@/lib/pinReadiness";
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

// Deep link into /app/plan that reopens the Edit-details drawer for a specific Pin.
// Reuses the SAME "?modal=publish&pinId=…" contract Plan already parses (see the
// post-OAuth restore effect in app/plan/page.tsx) — no new mechanism needed.
function planDeepLink(draftId: string): string {
  return `/app/plan?modal=publish&pinId=${encodeURIComponent(draftId)}`;
}

// Remembers the user's manually-chosen filter for this browser session only
// (sessionStorage — not durable across devices/tabs-reopened-later). Falls back to
// "unscheduled" (PRD 5.1/6): Create Pins should default to the work still ahead of
// the user, not a mixed "All" view dominated by already-scheduled/posted cards.
const FILTER_STORAGE_KEY = "vp:studio:filter";
const VALID_FILTERS: BoardFilter[] = ["all", "unscheduled", "scheduled", "posted", "failed"];
function readStoredFilter(): BoardFilter {
  if (typeof window === "undefined") return "unscheduled";
  try {
    const raw = window.sessionStorage.getItem(FILTER_STORAGE_KEY);
    return raw && (VALID_FILTERS as string[]).includes(raw) ? (raw as BoardFilter) : "unscheduled";
  } catch { return "unscheduled"; }
}

// ── Failed-view sub-filter (PRD §4) ─────────────────────────────────────────────
// Second-level chips shown only while the main filter is "failed": Publish failures /
// Generation failures / All. Entry-point default differs by how the user got here:
//   - Banner CTA / stats-bar "N failed" click (openFailedInStudio-style entry) → "publish"
//     (matches the Banner's count, which is publish-failures only).
//   - Manually clicking the "Failed" filter chip → "all" (no assumption about intent).
// The signal is passed via a ONE-SHOT sessionStorage flag written by the caller right
// before navigating (Plan's openFailedInStudio) — read once on mount here, then cleared,
// so it never sticks around and overrides a later manual chip click.
export type FailedSubFilter = "publish" | "generation" | "all";
function consumeFailedSubEntryDefault(): FailedSubFilter {
  if (typeof window === "undefined") return "all";
  try {
    const raw = window.sessionStorage.getItem(FAILED_SUB_ENTRY_KEY);
    window.sessionStorage.removeItem(FAILED_SUB_ENTRY_KEY);
    return raw === FAILED_SUB_ENTRY_PUBLISH ? "publish" : "all";
  } catch { return "all"; }
}

export function StudioBoard() {
  const { t: tr } = useLocale();
  // SSR/first-render always starts at the default; the real (possibly session-
  // remembered) filter is applied post-mount alongside the hydration gate below,
  // so this never causes a hydration mismatch.
  const [filter, setFilterState] = useState<BoardFilter>("unscheduled");
  // Failed-view sub-filter (PRD §4). Manual chip clicks (setFilter) always default the
  // sub-filter to "all" — only the one-shot sessionStorage entry signal (consumed on
  // mount, see the hydration effect below) can seed "publish".
  const [failedSubFilter, setFailedSubFilter] = useState<FailedSubFilter>("all");
  // `subDefault` lets a caller (the Banner CTA) request "publish" as the sub-filter
  // default in the SAME state transition — avoids a two-render race where a plain
  // setFailedSubFilter call before/after setFilter could be seen out of order.
  const setFilter = useCallback((f: BoardFilter, subDefault: FailedSubFilter = "all") => {
    setFilterState(f);
    if (f === "failed") setFailedSubFilter(subDefault);
    try { window.sessionStorage.setItem(FILTER_STORAGE_KEY, f); } catch { /* storage unavailable — filter still works in-memory */ }
  }, []);
  const { items: rawItems, allItems, counts, isPublishing } = usePinBoardDrafts(filter);
  // Sub-filter is applied on TOP of the main "failed" filter — never touches
  // usePinBoardDrafts/BoardFilter itself (PRD: no change to the primary filter enum).
  const isPublishFailureItem = useCallback((d: PinDraft) => !!d.publishError?.trim(), []);
  const failedSubCounts = useMemo(() => {
    if (filter !== "failed") return { publish: 0, generation: 0, all: 0 };
    const publish = rawItems.filter(x => isPublishFailureItem(x.draft)).length;
    return { publish, generation: rawItems.length - publish, all: rawItems.length };
  }, [filter, rawItems, isPublishFailureItem]);
  const items = useMemo(() => {
    if (filter !== "failed" || failedSubFilter === "all") return rawItems;
    return rawItems.filter(x => (failedSubFilter === "publish" ? isPublishFailureItem(x.draft) : !isPublishFailureItem(x.draft)));
  }, [filter, failedSubFilter, rawItems, isPublishFailureItem]);
  // Publish-failure banner (PRD §12, WP-F) — computed from the FULL board so it's
  // independent of the current filter view; count is a derived value from `allItems`,
  // so Retry/Move to Unscheduled/Delete are reflected immediately via re-render.
  const publishFailureCount = useMemo(() => countPublishFailures(allItems.map(x => x.draft)), [allItems]);
  const { visibleCount: bannerCount, dismiss: dismissBanner } = useFailureBannerDismiss(publishFailureCount);
  // The "Top pick" badge (derived across the full board) is part of the Creative
  // Intelligence cluster, deferred out of RC0 Create Pins — PinBoardCard's topPick prop
  // stays optional and simply goes untold here until that cluster lands.
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
    // Apply any session-remembered filter now that we're on the client (sessionStorage
    // is unavailable during SSR). Runs once, before the board is shown.
    const restored = readStoredFilter();
    setFilterState(restored);
    // Failed-view sub-filter default (PRD §4): consume the one-shot entry signal ONLY
    // when we actually landed on the failed filter — a stray/stale flag must never
    // silently seed "publish" the next time the user happens to land elsewhere.
    setFailedSubFilter(restored === "failed" ? consumeFailedSubEntryDefault() : "all");
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
    if (ok) { toast.success(ok === 1 ? tr("studioBoard.toast.uploadedOne") : tr("studioBoard.toast.uploadedMany").replace("{n}", String(ok))); flashSaved(); }
    if (failedNames.length) {
      const shown = failedNames.slice(0, 3).join(", ");
      const more = failedNames.length > 3 ? tr("studioBoard.toast.uploadFailedAndMore").replace("{n}", String(failedNames.length - 3)) : "";
      toast.error(`${tr("studioBoard.toast.uploadFailedPrefix")}${shown}${more}${tr("studioBoard.toast.uploadFailedSuffix")}`);
    }
  }, [flashSaved, tr]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer?.files?.length) void handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  // ── Card edits ─────────────────────────────────────────────────────────────
  // In-place field validation errors from Schedule (PRD: missing Board shows a
  // field-level error, not just a toast). Cleared as soon as a board is chosen.
  const [scheduleErrors, setScheduleErrors] = useState<Record<string, string>>({});
  // Title ≤100 / description ≤500 over-limit errors (WP1 follow-up). Keyed by draft id,
  // cleared as soon as the offending field is edited back under the cap.
  const [fieldErrors, setFieldErrors] = useState<Record<string, PinFieldErrors>>({});

  const handlePersist = useCallback((id: string, patch: Partial<PinDraft>) => {
    pinDraftStore.updateDraft(id, patch); flashSaved();
    if (patch.boardId) setScheduleErrors(prev => (prev[id] ? { ...prev, [id]: "" } : prev));
    if ("title" in patch || "description" in patch) {
      setFieldErrors(prev => {
        const cur = pinDraftStore.getDraft(id);
        const next = pinFieldErrors({ title: cur?.title, description: cur?.description });
        if (!next.title && !next.description && !prev[id]) return prev;
        return { ...prev, [id]: next };
      });
    }
  }, [flashSaved]);

  // AI Copy generation now lives inside <PinAICopyPanel> (shared across Create Pins,
  // Plan edit, and Batch Edit). The card applies results via onPersist → updateDraft.

  // ── Schedule = smart auto-assign (no pickers) ──────────────────────────────
  const handleSchedule = useCallback((id: string) => {
    const d = pinDraftStore.getDraft(id); if (!d) return;
    const missingImage = d.assetError || !isPublishableImage(d.imageUrl);
    const missingBoard = noBoardAccess || !d.boardId?.trim();
    if (missingImage || missingBoard) {
      setActiveId(id);
      // Scheduling has its own minimal guard. It deliberately does not use the
      // publish-readiness gate or require copy/alt text/URL metadata.
      if (!d.boardId?.trim() && !noBoardAccess) {
        setScheduleErrors(prev => ({ ...prev, [id]: tr("studioBoard.toast.chooseBoardToSchedule") }));
      }
      // WP1 gate: only image + board block scheduling. The message already says exactly
      // that ("Add an image and choose a board…") — no copy/alt/URL requirement — and a
      // missing board also gets the field-level chooseBoardToSchedule hint above.
      toast.error(tr("studioBoard.toast.completeDetailsToSchedule"));
      return;
    }
    // Title ≤100 / description ≤500 — over-limit blocks (empty stays fine). Field-level
    // errors render next to the title/description inputs; the toast is a summary only.
    const lenErrors = pinFieldErrors({ title: d.title, description: d.description });
    if (lenErrors.title || lenErrors.description) {
      setActiveId(id);
      setFieldErrors(prev => ({ ...prev, [id]: lenErrors }));
      toast.error(tr("studioBoard.toast.fieldTooLong"));
      return;
    }
    setScheduleErrors(prev => (prev[id] ? { ...prev, [id]: "" } : prev));
    const result = ensureScheduledPlanTime(id);
    if (result.ok) {
      // PRD 5.2 — success toast gets an "Open in Plan" action that deep-links to the
      // exact Pin's edit drawer in Plan (same ?modal=publish&pinId= contract the
      // post-OAuth restore flow already uses there).
      toast.success(result.toast, { action: { label: tr("studioBoard.toast.openInPlan"), onClick: () => { window.location.href = planDeepLink(id); } } });
    } else {
      toast.error(result.toast);
    }
  }, [noBoardAccess, tr]);

  // ── Publish now (from ⋮) ───────────────────────────────────────────────────
  const handlePublish = useCallback(async (id: string) => {
    const d = pinDraftStore.getDraft(id); if (!d) return;
    if (d.assetError || !isPublishableImage(d.imageUrl)) { toast.error(tr("studioBoard.toast.imageUnavailable")); return; }
    if (noBoardAccess || !isPinReady(draftReadiness(d))) { setActiveId(id); toast.error(tr("studioBoard.toast.completeDetailsToPublish")); return; }
    const lenErrors = pinFieldErrors({ title: d.title, description: d.description });
    if (lenErrors.title || lenErrors.description) {
      setActiveId(id);
      setFieldErrors(prev => ({ ...prev, [id]: lenErrors }));
      toast.error(tr("studioBoard.toast.fieldTooLong"));
      return;
    }
    if (!beginPublish(id)) return;
    pinDraftStore.updateDraft(id, { publishError: undefined });
    try {
      const res = await publishPin({ boardId: d.boardId, imageUrl: d.imageUrl, title: d.title || undefined, description: d.description || undefined, link: d.destinationUrl || undefined, altText: d.altText || undefined, sourcePinId: id, draftId: id, source: "immediate" });
      pinDraftStore.updateDraft(id, { postedAt: new Date().toISOString(), remotePinId: res.pin.id, remotePinUrl: res.pin.url, publishError: undefined, failureType: undefined, errorCategory: undefined, publishErrorCode: undefined });
      toast.success(tr("studioBoard.toast.publishSuccess"));
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // ISO, matching DraftDetailsDrawer.tsx's previousScheduledTime convention (not a
      // bare local "YYYY-MM-DDTHH:mm" string) so all writers of this field agree.
      const localPlanned = d.plannedAt || d.scheduledDate;
      const prevScheduled = localPlanned
        ? new Date(`${localPlanned.slice(0, 10)}T${(d.scheduledTime?.trim() || localPlanned.slice(11, 16) || "09:00")}:00`).toISOString()
        : undefined;
      pinDraftStore.updateDraft(id, {
        publishError: err?.message || tr("studioBoard.toast.publishFailed"),
        failureType: "publish",
        errorCategory: mapPublishErrorToCategory(err?.code, err?.message),
        publishErrorCode: err?.code,
        previousScheduledTime: prevScheduled,
        scheduledDate: "",
        scheduledTime: "",
      });
      toast.error(tr("studioBoard.toast.publishFailed"));
    } finally { endPublish(id); }
  }, [noBoardAccess, tr]);

  // ── Product → Pin (Shopify "Select product", §3.6) ─────────────────────────
  // Opening/browsing the picker never creates anything — only a confirmed selection
  // does. destinationUrl is intentionally left empty (never auto-filled, §2).
  const handleProductSelect = useCallback((p: ProductSelection) => {
    setShowProductPicker(false);
    // Multi-image selection → the first chosen image becomes the card's cover.
    const chosenImageUrl = p.images?.[0]?.url ?? p.imageUrl ?? "";
    if (!chosenImageUrl) { toast.error(tr("studioBoard.toast.productNoImage")); return; }
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
    toast.success(tr("studioBoard.toast.createdPinFromProduct"));
  }, [flashSaved, tr]);

  // ── AI drawers ─────────────────────────────────────────────────────────────
  const handleGenerateAiImage = useCallback((d: PinDraft) => setAiDrawer({ mode: "version", draft: d }), []);
  const handleCreateWithAi = useCallback(() => setAiDrawer({ mode: "scratch" }), []);
  const handleAiGenerate = useCallback(async (opts: AiVersionOptions) => {
    if (!aiDrawer) return;
    const parent = aiDrawer.mode === "version" ? aiDrawer.draft : null;
    setAiGenerating(true);
    // Regenerating from an existing pin (version mode) is a "regenerate" action.
    if (parent) track("regenerate_clicked", { draftId: parent.id });

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
    toast.success(requested === 1 ? tr("studioBoard.toast.generatingOne") : tr("studioBoard.toast.generatingMany").replace("{n}", String(requested)));

    // 2) Run generation; resolve/fail each placeholder. A closed drawer or a
    //    partial failure never rolls back successful results.
    try {
      const result = await generateAiVersions({ source: parent, setup: opts });
      result.urls.slice(0, placeholders.length).forEach((url, i) => {
        // Persist the server generation id + this card's stable asset key so the future
        // AI-adoption metric joins on ids, not the imageUrl string.
        pinDraftStore.completeGeneratedDraft(placeholders[i].id, url, {
          generationId: result.generationRequestId,
          assetKey: `gen:${requestId}:${i}`,
        });
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
          sourceGenerationId: result.generationRequestId, sourceAssetKey: `gen:${requestId}:extra:${i}`,
        });
        void startImageAnalysis(extra.id);
      });
      const okCount = Math.min(result.urls.length, placeholders.length) + Math.max(0, result.urls.length - placeholders.length);
      const failCount = Math.max(0, placeholders.length - result.urls.length);
      if (okCount && failCount) toast.error(tr("studioBoard.toast.generatedSomeFailedSome").replace("{okCount}", String(okCount)).replace("{okPlural}", okCount === 1 ? "" : "s").replace("{failCount}", String(failCount)));
      else if (okCount) toast.success(parent
        ? tr("studioBoard.toast.createdAiPinsKeptOriginal").replace("{n}", String(okCount)).replace("{plural}", okCount === 1 ? "" : "s")
        : tr("studioBoard.toast.createdAiPins").replace("{n}", String(okCount)).replace("{plural}", okCount === 1 ? "" : "s"));
      else { placeholders.forEach(p => pinDraftStore.failGeneratedDraft(p.id)); toast.error(tr("studioBoard.toast.noAiPinsGenerated")); }
    } catch {
      placeholders.forEach(p => pinDraftStore.failGeneratedDraft(p.id));
      toast.error(tr("studioBoard.toast.couldNotGenerate"));
    }
  }, [aiDrawer, tr]);

  const handleDelete = useCallback((d: PinDraft) => {
    if (typeof window !== "undefined" && !window.confirm(tr("studioBoard.confirm.deleteDraft"))) return;
    if (d.source === "ai_generated_from_upload") track("generation_deleted", { draftId: d.id });
    pinDraftStore.deleteDraft(d.id); toast.success(tr("studioBoard.toast.draftDeleted"));
  }, [tr]);
  const handleArchive = useCallback((d: PinDraft) => { pinDraftStore.archiveDraft(d.id); toast.success(tr("studioBoard.toast.archived")); }, [tr]);
  const handleDuplicate = useCallback((id: string) => { pinDraftStore.duplicateDraft(id); toast.success(tr("studioBoard.toast.duplicated")); }, [tr]);
  const handleConnect = useCallback(() => { void startPinterestConnect(); }, []);

  // ── PRD card action matrix handlers ─────────────────────────────────────────
  const handleUnschedule = useCallback((id: string) => {
    pinDraftStore.removeFromWeeklyPlan(id);
    toast.success(tr("studioBoard.toast.unscheduled"));
  }, [tr]);

  // Failed card → "Move to Unscheduled" (PRD 13.4): clears the schedule slot AND the
  // active failure so the card returns to a clean Unscheduled state. previousScheduledTime
  // is intentionally KEPT (it's already history, not an active error) — a lightweight
  // record of what was lost without a full audit log. Draft content/product links
  // untouched.
  const handleMoveToUnscheduled = useCallback((id: string) => {
    pinDraftStore.updateDraft(id, {
      scheduledDate: "", scheduledTime: "",
      publishError: undefined, failureType: undefined, errorCategory: undefined, publishErrorCode: undefined,
    });
    toast.success(tr("studioBoard.toast.movedToUnscheduled"));
  }, [tr]);

  const handleDownload = useCallback(async (d: PinDraft) => {
    if (!d.imageUrl) { toast.error(tr("studioBoard.toast.noImageToDownload")); return; }
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
  }, [tr]);

  const handleSaveAsReference = useCallback((d: PinDraft) => {
    if (!d.imageUrl) { toast.error(tr("studioBoard.toast.noImageToSave")); return; }
    assetStore.saveAsset({
      role: "style_reference",
      source: d.source === "ai_generated_from_upload" ? "recent" : "upload",
      imageUrl: d.imageUrl,
      title: d.title || undefined,
      category: d.category || undefined,
      keyword: d.keyword || undefined,
    });
    toast.success(tr("studioBoard.toast.savedToReferences"));
  }, [tr]);

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
    if (pinDraftStore.retryPersist()) toast.success(tr("studioBoard.toast.saved"));
    else toast.error(tr("studioBoard.toast.stillCouldNotSave"));
  }, [tr]);

  const savedIndicator = persistFailed ? (
    <button type="button" data-testid="board-save-state" onClick={handleRetryPersist}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: BUI.error, background: "none", border: `1px solid ${BUI.error}55`, borderRadius: 8, padding: "3px 9px", cursor: "pointer", fontFamily: "inherit" }}>
      {tr("studioBoard.failedToSaveRetry")}
    </button>
  ) : (
    <span data-testid="board-save-state" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: BUI.textSec }}>
      {saving ? <><Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> {tr("studioBoard.saving")}</> : <><Check style={{ width: 12, height: 12, color: BUI.success }} /> {tr("studioBoard.savedOnDevice")}</>}
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

      {/* Context suppression (PRD §2.2): never show the Banner while already on the
          Failed view — the user is already looking at exactly what it would tell them. */}
      {filter !== "failed" && (
        <FailureBanner
          count={bannerCount}
          onReview={() => {
            // Banner CTA → Failed view defaults to "Publish failures" (matches the
            // Banner's own count, which is publish-failures only). Same rule Plan's
            // openFailedInStudio applies via the sessionStorage entry signal.
            setFilter("failed", "publish");
          }}
          onDismiss={dismissBanner}
        />
      )}

      {/* Header */}
      <div style={{ padding: "16px 22px 10px", display: "flex", flexDirection: "column", gap: 12, background: BUI.surface, borderBottom: `1px solid ${BUI.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: BUI.text }}>{tr("studioBoard.title")}</h1>
              <p style={{ margin: "2px 0 0", fontSize: 12.5, color: BUI.textSec }}>{tr("studioBoard.subtitle")}</p>
            </div>
            {isDev && (
              <span data-testid="studio-board-v2-marker" style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.3, color: "#fff", background: BUI.gradient, borderRadius: 999, padding: "2px 10px" }}>Studio Board V2</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            {savedIndicator}
            <Link href="/app/history" data-testid="board-history" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: BUI.textSec, textDecoration: "none", border: `1px solid ${BUI.border}`, borderRadius: 20, padding: "5px 12px" }}>
              <Clock style={{ width: 12, height: 12 }} /> {tr("studioBoard.history")}
            </Link>
          </div>
        </div>
        {/* Primary action row (PRD §8.1): Upload images primary + Select product secondary,
            side by side. Only shown once the board has cards — the empty state has its own
            upload-first zone with a "Create from your store?" product entry. */}
        {hasCards && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" data-testid="board-upload-more" onClick={openFilePicker} disabled={uploading}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
              {uploading ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Upload style={{ width: 13, height: 13 }} />}
              {uploading && uploadProgress ? ` ${tr("studioBoard.uploadingProgress").replace("{done}", String(uploadProgress.done)).replace("{total}", String(uploadProgress.total))}` : ` ${tr("studioBoard.uploadMore")}`}
            </button>
            {shopifyEnabled && (
              <button type="button" data-testid="board-select-product" onClick={() => setShowProductPicker(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: BUI.textSec, background: "none", border: `1px solid ${BUI.border}`, borderRadius: 9, padding: "7px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                {tr("studioBoard.selectProduct")}
              </button>
            )}
          </div>
        )}
        <StudioBoardFilters value={filter} counts={counts} onChange={setFilter} />
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 22 }}>
        {/* Failed-view sub-filter chips (PRD §4) — only inside the Failed view, above
            the card grid/empty state. Purely a client-side re-filter of the "failed"
            BoardFilter results; never touches usePinBoardDrafts' own counts. */}
        {filter === "failed" && (
          <div data-testid="failed-sub-filters" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {([
              { id: "publish" as const, label: "Publish failures", n: failedSubCounts.publish },
              { id: "generation" as const, label: "Generation failures", n: failedSubCounts.generation },
              { id: "all" as const, label: "All", n: failedSubCounts.all },
            ]).map(chip => {
              const active = failedSubFilter === chip.id;
              return (
                <button key={chip.id} type="button" data-testid={`failed-sub-${chip.id}`} onClick={() => setFailedSubFilter(chip.id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999,
                    border: `1px solid ${active ? BUI.purple : BUI.border}`,
                    background: active ? "rgba(124,58,237,0.10)" : BUI.surface,
                    color: active ? BUI.purple : BUI.textSec, fontSize: 12, fontWeight: active ? 800 : 600,
                    cursor: "pointer", fontFamily: "inherit",
                  }}>
                  {chip.label} ({chip.n})
                </button>
              );
            })}
          </div>
        )}
        {items.length === 0 && counts.all === 0 ? (
          // Empty → upload-first workspace
          <div data-testid="board-empty" onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
            style={{ minHeight: 380, borderRadius: 16, border: `2px dashed ${dragOver ? BUI.purple : BUI.borderHi}`, background: dragOver ? "rgba(124,58,237,0.05)" : BUI.surface, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, textAlign: "center", padding: 24 }}>
            <div style={{ width: 68, height: 68, borderRadius: "50%", background: "rgba(124,58,237,0.10)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <UploadCloud style={{ width: 32, height: 32, color: BUI.purple }} />
            </div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: BUI.text }}>{tr("studioBoard.empty.dragDropTitle")}</h2>
            <p style={{ margin: 0, fontSize: 13, color: BUI.textSec }}>{tr("studioBoard.empty.dragDropSub")}</p>
            <button type="button" data-testid="board-upload-primary" onClick={openFilePicker} disabled={uploading}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "11px 22px", borderRadius: 11, border: "none", background: BUI.gradient, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer", marginTop: 4, fontFamily: "inherit" }}>
              {uploading ? <><Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> {uploadProgress ? tr("studioBoard.uploadingProgress").replace("{done}", String(uploadProgress.done)).replace("{total}", String(uploadProgress.total)) : tr("studioBoard.empty.uploading")}</> : <><Upload style={{ width: 15, height: 15 }} /> {tr("studioBoard.empty.uploadImages")}</>}
            </button>
            <button type="button" data-testid="board-create-with-ai" onClick={handleCreateWithAi}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 4, fontSize: 12, fontWeight: 700, color: BUI.purple, cursor: "pointer", fontFamily: "inherit" }}>
              {tr("studioBoard.empty.noImageCreateWithAi")} <ArrowRight style={{ width: 13, height: 13 }} />
            </button>
            {shopifyEnabled && (
              <button type="button" data-testid="board-select-product-empty" onClick={() => setShowProductPicker(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 4, fontSize: 12, fontWeight: 700, color: BUI.purple, cursor: "pointer", fontFamily: "inherit" }}>
                {tr("studioBoard.empty.createFromStoreSelectProduct")} <ArrowRight style={{ width: 13, height: 13 }} />
              </button>
            )}
          </div>
        ) : items.length === 0 && filter === "unscheduled" && counts.scheduled > 0 ? (
          // Unscheduled is empty, but the board has scheduled content — a dedicated
          // "you're caught up" guide, not the generic upload-empty-state (PRD 5.1/6,
          // product optimization point 6).
          <div data-testid="board-empty-all-scheduled" style={{ minHeight: 240, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center", color: BUI.textSec }}>
            <div style={{ width: 52, height: 52, borderRadius: "50%", background: "rgba(124,58,237,0.10)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CalendarClockIcon style={{ width: 24, height: 24, color: BUI.purple }} />
            </div>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: BUI.text }}>{tr("studioBoard.empty.allScheduledTitle")}</p>
            <p style={{ margin: 0, fontSize: 12.5, maxWidth: 320 }}>{tr("studioBoard.empty.allScheduledSub")}</p>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
              <Link data-testid="board-empty-open-plan" href="/app/plan" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, textDecoration: "none" }}>
                {tr("studioBoard.empty.openPlanScheduled")}
              </Link>
              <button type="button" onClick={openFilePicker} disabled={uploading}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: `1px solid ${BUI.purple}`, background: "rgba(124,58,237,0.06)", color: BUI.purple, fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                {tr("studioBoard.uploadMore")}
              </button>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div data-testid="board-empty-filter" style={{ minHeight: 240, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, textAlign: "center", color: BUI.textSec }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: BUI.text }}>{tr("studioBoard.empty.nothingHereTitle")}</p>
            <p style={{ margin: 0, fontSize: 12.5 }}>{tr("studioBoard.empty.nothingHereSub")}</p>
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
                titleFieldError={fieldErrors[draft.id]?.title}
                descriptionFieldError={fieldErrors[draft.id]?.description}
                onPersist={handlePersist}
                onSchedule={handleSchedule} onGenerateAiImage={handleGenerateAiImage} onPublish={handlePublish}
                onDelete={handleDelete} onArchive={handleArchive} onDuplicate={handleDuplicate}
                onUnschedule={handleUnschedule} onMoveToUnscheduled={handleMoveToUnscheduled}
                onDownload={(d) => { void handleDownload(d); }}
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
          title={aiDrawer.mode === "version" ? tr("studioBoard.aiDrawer.generateAiImage") : tr("studioBoard.aiDrawer.createWithAi")}
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
          title={tr("studioBoard.productPicker.title")}
          subtitle={tr("studioBoard.productPicker.subtitle")}
          initialTab="shopify"
          onSelect={handleProductSelect}
          onClose={() => setShowProductPicker(false)}
        />
      )}
    </div>
  );
}
