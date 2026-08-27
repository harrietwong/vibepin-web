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
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { UploadCloud, Upload, Loader2, Check, Clock, ArrowRight, CalendarClock as CalendarClockIcon, Images, Rows3, X, AlertTriangle, Sparkles } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { usePinBoardDrafts, type BoardFilter } from "@/hooks/usePinBoardDrafts";
import { usePinterestBoards } from "@/hooks/usePinterestBoards";
import * as pinDraftStore from "@/lib/pinDraftStore";
import * as assetStore from "@/lib/assetStore";
import { toProxyUrl } from "@/lib/imageProxy";
import type { PinDraft } from "@/lib/pinDraftStore";
import { publishPin, startPinterestConnect, fetchPinterestDefaultBoard, savePinterestDefaultBoard } from "@/lib/pinterestClient";
import { startImageAnalysis } from "@/lib/ai-copy/startImageAnalysis";
import { startQualityJudge } from "@/lib/ai-copy/startQualityJudge";
import { track } from "@/lib/analytics";
import { beginPublish, endPublish, isActionablePublishFailure, isActionablePublishFailureInWeek, listActionablePublishFailures, mapPublishErrorToCategory, publishFailureSetIdentity, FAILED_SUB_ENTRY_KEY, FAILED_SUB_ENTRY_PUBLISH } from "@/lib/studio/pinLifecycle";
import { FailureBanner, useFailureBannerDismiss } from "@/components/shared/FailureBanner";
import { isPinReady, isPublishableImage, pinFieldErrors, hasPinFieldErrors, type PinFieldErrors } from "@/lib/pinReadiness";
import { readStoredTarget } from "@/lib/studio/publishTarget";
import { draftReadiness } from "@/lib/weeklyPlanStats";
import { ensureScheduledPlanTime } from "@/lib/smartSchedule";
import { uploadPinImage } from "@/lib/studio/uploadPinImage";
import { measureImageFile } from "@/lib/studio/measureImageFile";
import { generateAiVersions, enqueueGeneration, pollGenerationJob } from "@/lib/studio/generateAiVersions";
import { reconcileGeneratingDrafts } from "@/lib/studio/generationRecovery";
import { type SelectedReference } from "@/lib/studio/selectedReferences";
import { runAiGeneration } from "@/lib/studio/runAiGeneration";
import { resolveModelLabel } from "@/lib/studio/modelLabel";
import { StudioBoardFilters } from "@/components/studio/StudioBoardFilters";
import { deriveTopPickIds } from "@/lib/studio/topPick";
import { PinBoardCard } from "@/components/studio/PinBoardCard";
import { AiVersionDrawer, type AiVersionDrawerSetup, type AiVersionOptions } from "@/components/studio/AiVersionDrawer";
import { StudioBoardSkeleton } from "@/components/studio/StudioBoardSkeleton";
import { BUI } from "@/components/studio/boardUI";
import { CanonicalProductPicker } from "@/components/studio/CanonicalProductPicker";
import { selectionFromLinkedProduct, toLinkedProduct, resolveProductPublicUrl, type CanonicalProductSelection } from "@/lib/studio/productSelection";
import { EMPTY_TOUCHED, type LinkedProduct } from "@/lib/pinMetadata";
import { PRODUCT_DERIVED_URL_SOURCE } from "@/lib/studio/destinationUrlDerivation";
import { isShopifyIntegrationEnabled } from "@/lib/shopifyFlag";
import { StudioPlanSidebar } from "@/components/studio/StudioPlanSidebar";
import { contentDestinationResults, contentDestinations, contentMedia, type DestinationPublishResult, type PublishDestination } from "@/lib/contentDraftModel";
import { publishToSocial } from "@/lib/social/socialClient";
import { BatchEditDrawer, type BatchApplyOpts, type BatchPinRow } from "@/components/studio/BatchEditDrawer";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
type AiDrawerState =
  // `product` on the version variant carries a RETRY's own product forward, so a
  // failed run that chose a different product than its parent is not re-inherited
  // from the parent on retry.
  | { mode: "version"; draft: PinDraft; product?: CanonicalProductSelection }
  | { mode: "scratch"; product?: CanonicalProductSelection }
  | null;

// Never surface local QA/demo fixtures as if they were a customer's Pinterest board.
// The stored ID is left untouched for diagnostics; customer-facing pickers and labels
// only use real board names.
function isInternalBoardName(name: string | null | undefined): boolean {
  return /^(qa board|vibepin sandbox demo board|sandbox demo board)$/i.test(name?.trim() ?? "");
}

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
const PLAN_PINNED_STORAGE_KEY = "vp:studio:plan-pinned";
const MULTI_UPLOAD_MODE_STORAGE_KEY = "vp:studio:multi-upload-mode";
type MultiUploadMode = "together" | "separate";
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
//   - A `?sub=publish` deep link (or the Banner CTA within Create Pins) → "publish"
//     (matches the Banner's count, which is publish-failures only).
//   - Manually clicking the "Failed" filter chip → "all" (no assumption about intent).
// Two seed channels, URL-first: a reload-durable `?sub=` query param (see the mount
// effect) takes priority; the legacy ONE-SHOT sessionStorage flag (FAILED_SUB_ENTRY_KEY)
// is retained as a fallback for any in-session caller that still writes it — read once
// on mount here, then cleared, so it never overrides a later manual chip click.
export type FailedSubFilter = "publish" | "generation" | "all";
function consumeFailedSubEntryDefault(): FailedSubFilter {
  if (typeof window === "undefined") return "all";
  try {
    const raw = window.sessionStorage.getItem(FAILED_SUB_ENTRY_KEY);
    window.sessionStorage.removeItem(FAILED_SUB_ENTRY_KEY);
    return raw === FAILED_SUB_ENTRY_PUBLISH ? "publish" : "all";
  } catch { return "all"; }
}

// ── URL query-param entry (deep link / reload-durable) ──────────────────────────
// A `?filter=<board-filter>&sub=<publish|generation|all>` query param takes priority
// over the sessionStorage session memory, so a shared/reloaded link like
// `/app/studio?filter=failed&sub=publish` reliably lands on Failed → Publish failures
// even after a refresh (sessionStorage alone doesn't survive a fresh deep link). When
// present, the filter is still written back to sessionStorage so the rest of the
// session remembers it — the existing behavior is preserved, URL just seeds it.
function parseFilterParam(raw: string | null | undefined): BoardFilter | null {
  return raw && (VALID_FILTERS as string[]).includes(raw) ? (raw as BoardFilter) : null;
}
function parseSubParam(raw: string | null | undefined): FailedSubFilter | null {
  return raw === "publish" || raw === "generation" || raw === "all" ? raw : null;
}

export function StudioBoard() {
  const { t: tr } = useLocale();
  // Deep-link filter/sub source of truth (reload-durable). Read here (component is inside
  // the page's Suspense boundary — see app/studio/page.tsx) and consumed once on mount.
  const searchParams = useSearchParams();
  // SSR/first-render always starts at the default; the real (possibly session-
  // remembered) filter is applied post-mount alongside the hydration gate below,
  // so this never causes a hydration mismatch.
  const [filter, setFilterState] = useState<BoardFilter>("unscheduled");
  // Failed-view sub-filter (PRD §4). Manual chip clicks (setFilter) always default the
  // sub-filter to "all" — only the one-shot sessionStorage entry signal (consumed on
  // mount, see the hydration effect below) can seed "publish".
  const [failedSubFilter, setFailedSubFilter] = useState<FailedSubFilter>("all");
  const planWeekScope = searchParams.get("week");
  const setFailedSub = useCallback((sub: FailedSubFilter) => {
    setFailedSubFilter(sub);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("filter", "failed");
      url.searchParams.set("sub", sub);
      if (sub !== "publish") url.searchParams.delete("week");
      window.history.replaceState({}, "", url.toString());
    } catch { /* URL persistence is best-effort. */ }
  }, []);
  // `subDefault` lets a caller (the Banner CTA) request "publish" as the sub-filter
  // default in the SAME state transition — avoids a two-render race where a plain
  // setFailedSubFilter call before/after setFilter could be seen out of order.
  const setFilter = useCallback((f: BoardFilter, subDefault: FailedSubFilter = "all") => {
    setFilterState(f);
    if (f === "failed") setFailedSubFilter(subDefault);
    try { window.sessionStorage.setItem(FILTER_STORAGE_KEY, f); } catch { /* storage unavailable — filter still works in-memory */ }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      url.searchParams.set("filter", f);
      if (f === "failed") url.searchParams.set("sub", subDefault);
      else {
        url.searchParams.delete("sub");
        url.searchParams.delete("week");
      }
      window.history.replaceState({}, "", url.toString());
    } catch { /* URL persistence is best-effort; the state transition already happened. */ }
  }, []);
  const { items: rawItems, allItems, activeDrafts, counts, isPublishing } = usePinBoardDrafts(filter);
  // Sub-filter is applied on TOP of the main "failed" filter — never touches
  // usePinBoardDrafts/BoardFilter itself (PRD: no change to the primary filter enum).
  // Shared, source-agnostic actionable-publish-failure predicate (pinLifecycle) —
  // one predicate for Plan + Create Pins so the two never disagree. Stricter than the
  // old `!!publishError`: it also requires failureType==="publish" and !archivedAt,
  // eliminating the third divergent predicate that made counts drift.
  const isPublishFailureItem = useCallback((d: PinDraft) => isActionablePublishFailure(d), []);
  const failedSubCounts = useMemo(() => {
    if (filter !== "failed") return { publish: 0, generation: 0, all: 0 };
    const publish = rawItems.filter(x => isPublishFailureItem(x.draft)
      && (!planWeekScope || isActionablePublishFailureInWeek(x.draft, planWeekScope))).length;
    const generation = rawItems.filter(x => !isPublishFailureItem(x.draft)).length;
    return { publish, generation, all: publish + generation };
  }, [filter, rawItems, isPublishFailureItem, planWeekScope]);
  const items = useMemo(() => {
    if (filter !== "failed" || failedSubFilter === "all") return rawItems;
    return rawItems.filter(x => failedSubFilter === "publish"
      ? isPublishFailureItem(x.draft) && (!planWeekScope || isActionablePublishFailureInWeek(x.draft, planWeekScope))
      : !isPublishFailureItem(x.draft));
  }, [filter, failedSubFilter, rawItems, isPublishFailureItem, planWeekScope]);
  // Publish-failure banner — computed from the FULL workspace population (not the
  // current filter view), so Retry/Move to Unscheduled/Delete are reflected immediately
  // via re-render. Publish failures are workspace-wide: Plan/cron/legacy drafts share
  // the same core predicate and are visible in Failed even when they are not V2
  // board-origin cards, so the banner counts `activeDrafts`, not just board items.
  // Dismiss is keyed on the failure-set IDENTITY (not the count) so a same-size but
  // different failure set still resurfaces the banner.
  const publishFailureCount = useMemo(() => listActionablePublishFailures(activeDrafts).length, [activeDrafts]);
  const publishFailureIdentity = useMemo(() => publishFailureSetIdentity(activeDrafts), [activeDrafts]);
  const { visibleCount: bannerCount, dismiss: dismissBanner } = useFailureBannerDismiss(publishFailureCount, publishFailureIdentity, "studio");
  // "Top pick" is derived across the FULL (unfiltered) board so batch membership never
  // depends on the current filter view; the badge transfers automatically as cards change.
  // `allItems` is now the whole active workspace (0731 count-base unification), but no
  // extra isBoardSource filter is needed here: deriveTopPickIds' own `qualifies()` already
  // admits only source === "ai_generated_from_upload" cards with a ready quality judge,
  // so the wider input cannot change which ids come back.
  const topPickIds = useMemo(() => deriveTopPickIds(allItems.map(x => x.draft)), [allItems]);
  const recentBoardName = useMemo(() => allItems
    .map(item => item.draft.boardName?.trim())
    .find(name => !!name && !isInternalBoardName(name)) || "", [allItems]);
  const { boards, loading: boardsLoading, disconnected, needsReconnect, error: boardsErr, refresh: refreshBoards } = usePinterestBoards();
  const customerBoards = useMemo(() => boards.filter(board => !isInternalBoardName(board.name)), [boards]);
  // No usable board access = no connection OR a connection needing re-auth. Used to gate
  // scheduling/publishing (distinct from a transient boards API failure).
  const noBoardAccess = disconnected || needsReconnect;
  const boardsError = boardsErr ? "Couldn't load boards. Please try again." : undefined;
  // Draft-store hydration gate. The store's SSR/server snapshot is empty and the
  // real localStorage-backed snapshot only becomes authoritative on the client. To
  // avoid briefly rendering the "empty upload zone" (a false empty state) when
  // drafts actually exist — and to avoid a hydration mismatch — we render a V2
  // loading skeleton on the SSR + first client render, then flip to the real board
  // once mounted. This is separate from the experience decision (which is already
  // resolved); it only distinguishes "loading drafts" from "empty" vs "loaded".
  const [hydrated, setHydrated] = useState(false);
  const [planPinned, setPlanPinned] = useState(false);
  const didInitFilterRef = useRef(false);
  useEffect(() => {
    if (didInitFilterRef.current) return;
    didInitFilterRef.current = true;
    setHydrated(true);
    try {
      // Intentional hydration restore: localStorage is unavailable during SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlanPinned(window.localStorage.getItem(PLAN_PINNED_STORAGE_KEY) === "true");
    } catch { /* preference remains session-default */ }
    // URL query param wins over session memory (reload-durable deep link). Falls back to
    // the sessionStorage-remembered filter when no valid ?filter= is present.
    const urlFilter = parseFilterParam(searchParams.get("filter"));
    const restored = urlFilter ?? readStoredFilter();
    setFilterState(restored);
    // Keep sessionStorage in sync so the rest of the session remembers a URL-seeded filter
    // (preserves the existing session-memory behavior — the URL just seeds it).
    if (urlFilter) { try { window.sessionStorage.setItem(FILTER_STORAGE_KEY, urlFilter); } catch { /* storage unavailable */ } }
    // Failed-view sub-filter default (PRD §4): only meaningful when we land on "failed".
    // A ?sub= param wins; otherwise consume the one-shot sessionStorage entry signal.
    // A stray/stale flag must never silently seed "publish" when not on the failed filter.
    const urlSub = parseSubParam(searchParams.get("sub"));
    setFailedSubFilter(restored === "failed" ? (urlSub ?? consumeFailedSubEntryDefault()) : "all");
    // WP3-P2: reconcile in-flight generation jobs instead of blindly failing every
    // "generating" card. Worker-mode placeholders (generationJobId set) resume
    // polling or apply their already-terminal result; only jobId-less (inline-mode)
    // leftovers are judged dead — which is exactly the old
    // failStaleGeneratingDrafts() behavior for that partition, so nothing sticks
    // in Generating either way.
    void reconcileGeneratingDrafts();
  }, [searchParams]);

  const handlePlanPinnedChange = useCallback((next: boolean) => {
    setPlanPinned(next);
    try { window.localStorage.setItem(PLAN_PINNED_STORAGE_KEY, String(next)); } catch { /* in-memory preference still works */ }
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
  const [productPickerTargetId, setProductPickerTargetId] = useState<string | null>(null);
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[] | null>(null);
  const [uploadChoice, setUploadChoice] = useState<MultiUploadMode>("together");
  const [rememberUploadChoice, setRememberUploadChoice] = useState(false);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const shopifyEnabled = isShopifyIntegrationEnabled();
  const fileRef = useRef<HTMLInputElement>(null);
  const didPrefillBoardRef = useRef(false);

  const flashSaved = useCallback(() => { setSaving(true); setTimeout(() => setSaving(false), 300); }, []);
  const openFilePicker = useCallback(() => fileRef.current?.click(), []);

  const hasCards = items.length > 0 || counts.all > 0;
  const aiSetupKey = aiDrawer?.mode === "version" ? aiDrawer.draft.id : aiDrawer?.mode === "scratch" ? "scratch" : null;
  const batchPins = useMemo<BatchPinRow[]>(() => allItems.map(({ draft }) => ({
    pinId: draft.id,
    sessionId: draft.generationSessionId || "create-pins",
    groupIdx: 0,
    pinIdx: 0,
    imageUrl: draft.imageUrl,
    title: draft.title || "",
    description: draft.description || "",
    altText: draft.altText || "",
    destinationUrl: draft.destinationUrl || "",
    plannedDate: draft.scheduledDate || "",
    plannedTime: draft.scheduledTime,
    plannedAt: draft.plannedAt,
    postedAt: draft.postedAt,
    addedToPlanAt: draft.addedToPlanAt,
    planningStatus: draft.publishError ? "failed" : draft.postedAt ? "posted" : draft.plannedAt || draft.scheduledDate ? "planned" : "not_added",
    boardSuggestion: draft.boardName || "",
    boardId: draft.boardId,
    boardName: draft.boardName,
    metadataDraft: draft.metadataDraft,
    linkedProductId: draft.linkedProducts?.find(item => item.productId === draft.primaryProductId)?.productId,
    linkedProductTitle: draft.linkedProducts?.find(item => item.productId === draft.primaryProductId)?.title,
    linkedProductUrl: draft.linkedProducts?.find(item => item.productId === draft.primaryProductId)?.productUrl,
    linkedProductImageUrl: draft.linkedProducts?.find(item => item.productId === draft.primaryProductId)?.imageUrl,
    linkedProductSource: draft.linkedProducts?.find(item => item.productId === draft.primaryProductId)?.source,
    taggedProducts: draft.linkedProducts,
    taggedCount: draft.linkedProducts?.length,
    category: draft.category,
    mediaCount: contentMedia(draft).length,
    publishTo: contentDestinations(draft).map(destination => destination.provider).join(", ") || "pinterest",
  })), [allItems]);
  const selectedBatchPins = useMemo(() => batchPins.filter(pin => selectedIds.has(pin.pinId)), [batchPins, selectedIds]);

  // PRD §12: a verified last-used Pinterest Board pre-fills boardless content.
  // The preference is adopted only when that Board is still present in the current
  // account's live board list; an unavailable/stale preference remains unset.
  useEffect(() => {
    if (didPrefillBoardRef.current || boardsLoading || noBoardAccess || !customerBoards.length) return;
    didPrefillBoardRef.current = true;
    let cancelled = false;
    const recentDraftBoard = allItems.map(item => item.draft)
      .find(draft => draft.boardId?.trim() && !isInternalBoardName(draft.boardName));
    const applyPreference = (preference: { boardId: string; boardName?: string | null } | null) => {
      if (cancelled || !preference?.boardId) return;
      const liveBoard = customerBoards.find(board => board.id === preference.boardId);
      if (!liveBoard) return;
      allItems.forEach(({ draft }) => {
        if (draft.boardId?.trim()) return;
        const existing = contentDestinations(draft);
        if (existing.length && !existing.some(destination => destination.provider === "pinterest")) return;
        const destinations = (existing.length ? existing : [{ id: `${draft.id}:pinterest`, provider: "pinterest" as const }])
          .map(destination => destination.provider === "pinterest" ? { ...destination, boardId: liveBoard.id, boardName: liveBoard.name } : destination);
        pinDraftStore.updateDraft(draft.id, { boardId: liveBoard.id, boardName: liveBoard.name, publishDestinations: destinations });
      });
    };
    const recentPreference = recentDraftBoard?.boardId
      ? { boardId: recentDraftBoard.boardId, boardName: recentDraftBoard.boardName || null }
      : null;
    void fetchPinterestDefaultBoard()
      .then(preference => applyPreference(preference ?? recentPreference))
      .catch(() => applyPreference(recentPreference));
    return () => { cancelled = true; };
  }, [allItems, boardsLoading, customerBoards, noBoardAccess]);

  const handleBatchApply = useCallback(({ rowEdits }: BatchApplyOpts) => {
    Object.entries(rowEdits).forEach(([id, edit]) => {
      const patch: Partial<PinDraft> = {
        title: edit.title,
        description: edit.description,
        altText: edit.altText,
        destinationUrl: edit.destinationUrl,
        scheduledDate: edit.plannedDate,
        scheduledTime: edit.plannedTime,
        plannedAt: edit.plannedAt,
        boardId: edit.boardId,
        boardName: edit.boardName,
      };
      Object.keys(patch).forEach(key => patch[key as keyof PinDraft] === undefined && delete patch[key as keyof PinDraft]);
      pinDraftStore.updateDraft(id, patch);
    });
    flashSaved();
  }, [flashSaved]);

  // ── Upload → one Content with N media, or N separate Contents ──────────────
  const processFiles = useCallback(async (arr: File[], mode: MultiUploadMode) => {
    if (!arr.length) return;
    setUploading(true);
    setUploadProgress({ done: 0, total: arr.length });
    const batchId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let ok = 0;
    const failedNames: string[] = [];
    const uploaded: Array<{ publicUrl: string; file: File; index: number; width?: number; height?: number }> = [];
    for (let i = 0; i < arr.length; i++) {
      try {
        const { publicUrl } = await uploadPinImage(arr[i]);
        // Measured from the File while we still hold the bytes — the hosted URL
        // cannot be measured without a second network round trip, and without
        // dimensions the carousel ratio rules can only say "unverified".
        const { width, height } = await measureImageFile(arr[i]);
        uploaded.push({ publicUrl, file: arr[i], index: i, width, height });
        ok++;
      } catch {
        // A failed file never blocks or rolls back the successful ones.
        failedNames.push(arr[i].name);
      }
      setUploadProgress({ done: i + 1, total: arr.length });
    }
    if (mode === "together" && uploaded.length) {
      const first = uploaded[0];
      const created = pinDraftStore.createBoardDraft({
        imageUrl: first.publicUrl,
        media: uploaded.map(({ publicUrl, file, index, width, height }) => ({
          id: `${batchId}:media:${index}`, kind: "image", url: publicUrl,
          altText: file.name.replace(/\.[^.]+$/, ""), source: "upload", width, height,
        })),
        source: "uploaded_image", idempotencyKey: `${batchId}:content`,
        title: first.file.name.replace(/\.[^.]+$/, "").slice(0, 100),
      });
      void startImageAnalysis(created.id);
    } else {
      uploaded.forEach(({ publicUrl, file, index, width, height }) => {
        const created = pinDraftStore.createBoardDraft({
          imageUrl: publicUrl, source: "uploaded_image", idempotencyKey: `${batchId}:${index}`,
          // Explicit single-item media: the imageUrl-only path lets the store
          // synthesize a media item, and that synthetic item has nowhere to carry
          // the dimensions we just measured.
          media: [{
            id: `${batchId}:media:${index}`, kind: "image", url: publicUrl,
            altText: file.name.replace(/\.[^.]+$/, ""), source: "upload", width, height,
          }],
          title: file.name.replace(/\.[^.]+$/, "").slice(0, 100),
        });
        void startImageAnalysis(created.id);
      });
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

  const handleFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    if (arr.length === 1) { void processFiles(arr, "separate"); return; }
    let stored: MultiUploadMode | null = null;
    try {
      const value = window.localStorage.getItem(MULTI_UPLOAD_MODE_STORAGE_KEY);
      stored = value === "together" || value === "separate" ? value : null;
    } catch { /* ask below */ }
    if (stored) { void processFiles(arr, stored); return; }
    setUploadChoice("together");
    setRememberUploadChoice(false);
    setPendingUploadFiles(arr);
  }, [processFiles]);

  const continueMultiUpload = useCallback(() => {
    const files = pendingUploadFiles;
    if (!files) return;
    if (rememberUploadChoice) {
      try { window.localStorage.setItem(MULTI_UPLOAD_MODE_STORAGE_KEY, uploadChoice); } catch { /* one-time choice still works */ }
    }
    setPendingUploadFiles(null);
    void processFiles(files, uploadChoice);
  }, [pendingUploadFiles, processFiles, rememberUploadChoice, uploadChoice]);

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
    let next = patch;
    // A URL typed into the card's own field is a manual edit, exactly like the two
    // other hand-entry points (studio page + batch row). Without this flag, product
    // selection would later treat the value as auto-derived and overwrite it
    // (create-pin PRD Section J).
    if ("destinationUrl" in patch) {
      const existing = pinDraftStore.getDraft(id);
      const typed = (patch.destinationUrl ?? "").trim();
      if (typed !== (existing?.destinationUrl ?? "").trim()) {
        next = {
          ...patch,
          destinationUrlSource: "manual",
          metadataTouched: { ...EMPTY_TOUCHED, ...existing?.metadataTouched, destinationUrlTouched: true },
        };
      }
    }
    pinDraftStore.updateDraft(id, next); flashSaved();
    if (patch.boardId) {
      setScheduleErrors(prev => (prev[id] ? { ...prev, [id]: "" } : prev));
      // Remember the board the merchant just picked as their default for the next Pin.
      const boardName = patch.boardName?.trim() || boards.find(board => board.id === patch.boardId)?.name || null;
      void savePinterestDefaultBoard({ boardId: patch.boardId, boardName }).catch(() => {});
    }
    if ("title" in patch || "description" in patch) {
      setFieldErrors(prev => {
        const cur = pinDraftStore.getDraft(id);
        const next = pinFieldErrors({ title: cur?.title, description: cur?.description });
        if (!next.title && !next.description && !prev[id]) return prev;
        return { ...prev, [id]: next };
      });
    }
  }, [boards, flashSaved]);

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
        setScheduleErrors(prev => ({ ...prev, [id]: tr("studioBoard.toast.chooseBoardToSchedule") }));
      }
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
    let d = pinDraftStore.getDraft(id); if (!d) return;
    if (d.assetError || !isPublishableImage(d.imageUrl)) { toast.error(tr("studioBoard.toast.imageUnavailable")); return; }
    let destinations: PublishDestination[] = contentDestinations(d);
    if (!destinations.length) destinations = [{ id: `${id}:pinterest`, provider: "pinterest", boardId: d.boardId, boardName: d.boardName }];
    const priorResults = contentDestinationResults(d);
    const pendingDestinations = destinations.filter(destination => !priorResults.some(result => result.destinationId === destination.id && result.status === "published"));
    const targets = pendingDestinations.length ? pendingDestinations : destinations;
    const pinterestTargets = targets.filter(destination => destination.provider === "pinterest");
    const socialTargets = targets.filter(destination => destination.provider !== "pinterest");
    // Publishing straight from the card never opens the details drawer, so the drawer's
    // board auto-fill never ran for this draft. Without this, a user who has a default
    // board set is still told to "complete required details" — the board they picked
    // last time simply was never written onto this draft. Adopt it here before gating.
    if (pinterestTargets.length && !d.boardId?.trim() && !noBoardAccess) {
      try {
        // Default board OF THE PIN'S TARGET connection (PRD §14): a draft already
        // pinned to account B must never adopt account A's default board just because
        // A is the workspace default. No stored target ⇒ server default connection,
        // which is the pre-multi-account behaviour.
        const fallback = await fetchPinterestDefaultBoard(undefined, readStoredTarget(d) || undefined);
        if (fallback?.boardId) {
          destinations = destinations.map(destination => destination.provider === "pinterest"
            ? { ...destination, boardId: fallback.boardId, boardName: fallback.boardName ?? "" }
            : destination);
          d = pinDraftStore.updateDraft(id, { boardId: fallback.boardId, boardName: fallback.boardName ?? "", publishDestinations: destinations }) ?? d;
        }
      } catch { /* leave the draft as-is; the readiness gate below reports it */ }
    }
    // Pinterest readiness only gates the Pinterest destinations; a Content going only
    // to Instagram/Facebook must not be blocked by a missing board.
    const pinterestReady = !pinterestTargets.length || (!noBoardAccess && isPinReady(draftReadiness(d)));
    if (!pinterestReady && !socialTargets.length) { setActiveId(id); toast.error(tr("studioBoard.toast.completeDetailsToPublish")); return; }
    // Field length is a property of the Content itself, so it blocks every destination.
    const lenErrors = pinFieldErrors({ title: d.title, description: d.description });
    if (lenErrors.title || lenErrors.description) {
      setActiveId(id);
      setFieldErrors(prev => ({ ...prev, [id]: lenErrors }));
      toast.error(tr("studioBoard.toast.fieldTooLong"));
      return;
    }
    if (!beginPublish(id)) return;
    const now = new Date().toISOString();
    const untouchedResults = priorResults.filter(result => !targets.some(destination => destination.id === result.destinationId));
    pinDraftStore.updateDraft(id, {
      publishError: undefined,
      destinationResults: [
        ...untouchedResults,
        ...targets.map((destination): DestinationPublishResult => ({ destinationId: destination.id, provider: destination.provider, status: "publishing", submittedAt: now })),
      ],
    });
    const outcomes: DestinationPublishResult[] = [];
    let pinterestRemote: { id: string; url?: string } | null = null;
    let adoptedConnectionId: string | undefined;
    try {
      for (const destination of pinterestTargets) {
        if (!pinterestReady) {
          outcomes.push({ destinationId: destination.id, provider: "pinterest", status: "failed", errorCode: "missing_board", errorMessage: "Choose a Pinterest board before publishing." });
          continue;
        }
        try {
          // Publish AS the account the merchant pinned to this draft (or the account
          // the destination itself names), never "the first connection we find".
          const storedTarget = destination.accountId || readStoredTarget(d) || undefined;
          const res = await publishPin({ boardId: destination.boardId || d.boardId, imageUrl: d.imageUrl, title: d.title || undefined, description: d.description || undefined, link: d.destinationUrl || undefined, altText: d.altText || undefined, sourcePinId: id, draftId: id, source: "immediate", connectionId: storedTarget });
          pinterestRemote = { id: res.pin.id, url: res.pin.url };
          // Adopt-once (PRD §14): a draft that had no pinned target keeps the connection
          // it actually published through, so every later retry/action stays on it.
          if (!readStoredTarget(d) && res.connectionId) adoptedConnectionId = res.connectionId;
          outcomes.push({ destinationId: destination.id, provider: "pinterest", status: "published", remoteId: res.pin.id, postUrl: res.pin.url, submittedAt: now, publishedAt: new Date().toISOString() });
        } catch (error) {
          const err = error as { code?: string; message?: string };
          outcomes.push({ destinationId: destination.id, provider: "pinterest", status: "failed", errorCode: err.code, errorMessage: err.message || tr("studioBoard.toast.publishFailed"), submittedAt: now });
        }
      }

      if (socialTargets.length) {
        try {
          const social = await publishToSocial({
            postId: id,
            post: { imageUrls: contentMedia(d).map(item => item.url), title: d.title || undefined, caption: d.description || undefined, destinationUrl: d.destinationUrl || undefined, altText: d.altText || undefined },
            destinations: socialTargets.map(destination => ({ provider: destination.provider, socialConnectionId: destination.accountId })),
          });
          const queues = new Map<string, PublishDestination[]>();
          socialTargets.forEach(destination => queues.set(destination.provider, [...(queues.get(destination.provider) ?? []), destination]));
          social.destinations.forEach(result => {
            const destination = queues.get(result.provider)?.shift();
            if (!destination || result.status === "skipped") return;
            outcomes.push({
              destinationId: destination.id,
              provider: destination.provider,
              status: result.status === "published" ? "published" : "failed",
              remoteId: result.externalPostId ?? undefined,
              postUrl: result.externalPostUrl ?? undefined,
              errorMessage: result.error ?? undefined,
              submittedAt: now,
              publishedAt: result.status === "published" ? new Date().toISOString() : undefined,
            });
          });
        } catch (error) {
          socialTargets.forEach(destination => outcomes.push({ destinationId: destination.id, provider: destination.provider, status: "failed", errorMessage: (error as Error).message || tr("studioBoard.toast.publishFailed"), submittedAt: now }));
        }
      }

      const finalResults = [...untouchedResults, ...outcomes];
      const published = finalResults.filter(result => result.status === "published");
      const failed = finalResults.filter(result => result.status === "failed");
      const socialPosts = finalResults.filter(result => result.provider !== "pinterest" && result.status === "published" && result.remoteId).map(result => ({
        provider: result.provider, postId: result.remoteId as string, postUrl: result.postUrl ?? "", publishedAt: result.publishedAt ?? now,
      }));
      const firstFailure = failed[0];
      const localPlanned = d.plannedAt || d.scheduledDate;
      const prevScheduled = localPlanned
        ? new Date(`${localPlanned.slice(0, 10)}T${(d.scheduledTime?.trim() || localPlanned.slice(11, 16) || "09:00")}:00`).toISOString()
        : undefined;
      pinDraftStore.updateDraft(id, {
        publishDestinations: destinations,
        destinationResults: finalResults,
        socialPosts,
        postedAt: published.length ? (d.postedAt || now) : d.postedAt,
        remotePinId: pinterestRemote?.id || d.remotePinId,
        remotePinUrl: pinterestRemote?.url || d.remotePinUrl,
        publishError: firstFailure?.errorMessage,
        failureType: firstFailure ? "publish" : undefined,
        errorCategory: firstFailure ? mapPublishErrorToCategory(firstFailure.errorCode, firstFailure.errorMessage) : undefined,
        publishErrorCode: firstFailure?.errorCode,
        previousScheduledTime: firstFailure && !published.length ? prevScheduled : d.previousScheduledTime,
        scheduledDate: firstFailure && !published.length ? "" : d.scheduledDate,
        scheduledTime: firstFailure && !published.length ? "" : d.scheduledTime,
        ...(adoptedConnectionId ? { targetConnectionId: adoptedConnectionId } : {}),
      });
      if (published.length && failed.length) toast.info(`${published.length} destination${published.length === 1 ? "" : "s"} published; ${failed.length} needs attention.`);
      else if (published.length) toast.success(tr("studioBoard.toast.publishSuccess"));
      else toast.error(tr("studioBoard.toast.publishFailed"));
    } finally { endPublish(id); }
  }, [noBoardAccess, tr]);

  const handleCustomSchedule = useCallback((id: string, date: string, time: string) => {
    const d = pinDraftStore.getDraft(id); if (!d) return;
    if (noBoardAccess || !isPinReady(draftReadiness(d))) {
      setActiveId(id);
      if (!d.boardId?.trim() && !noBoardAccess) {
        setScheduleErrors(prev => ({ ...prev, [id]: tr("studioBoard.toast.chooseBoardToSchedule") }));
      }
      toast.error(tr("studioBoard.toast.completeDetailsToSchedule"));
      return;
    }
    if (!date || !time) return;
    setScheduleErrors(prev => (prev[id] ? { ...prev, [id]: "" } : prev));
    const updated = pinDraftStore.smartScheduleDraft(id, { plannedDate: date, plannedTime: time }, null, { source: "manual" });
    if (updated) {
      flashSaved();
      toast.success(tr("studioBoard.toast.customTimeScheduled")
        .replace("{date}", date)
        .replace("{time}", time), {
        action: { label: tr("studioBoard.toast.openInPlan"), onClick: () => { window.location.href = planDeepLink(id); } },
      });
    }
  }, [flashSaved, noBoardAccess, tr]);

  // ── Product → Pin / attach product ─────────────────────────────────────────
  // A product selected from My Products, Product Opportunities, Shopify, Etsy or a
  // URL import carries its real product URL. We use it only when Website URL is empty;
  // a creator's hand-entered destination is never overwritten.
  //
  // Two entry points share this one canonical picker (0ab49bb: one Product Picker,
  // not two competing modals):
  //   • a card's "Attach product" sets productPickerTargetId → link onto that draft;
  //   • the top-level "Select product" has no target → open the SAME AiVersionDrawer
  //     as "Create with AI", prefilled with the product. No draft exists until the
  //     user Generates, so cancelling leaves nothing behind.
  const handleProductSelect = useCallback((selections: CanonicalProductSelection[]) => {
    setShowProductPicker(false);
    const targetId = productPickerTargetId;
    setProductPickerTargetId(null);
    const product = selections[0];
    if (!product) return;
    const chosenImageUrl = product.imageUrl ?? "";

    if (targetId) {
      const current = pinDraftStore.getDraft(targetId);
      if (!current) return;
      const linkedProduct = toLinkedProduct(product);
      const productUrl = resolveProductPublicUrl(product);
      const existing = current.linkedProducts ?? [];
      const sameProduct = (item: LinkedProduct) =>
        (!!linkedProduct.productId && item.productId === linkedProduct.productId)
        || (!!linkedProduct.productUrl && item.productUrl === linkedProduct.productUrl);
      const remainingProducts = existing.filter(item => !sameProduct(item));
      const nextProducts = product.asPrimary ? [linkedProduct, ...remainingProducts] : [...remainingProducts, linkedProduct];
      pinDraftStore.updateDraft(targetId, {
        linkedProducts: nextProducts,
        primaryProductId: product.asPrimary || existing.length === 0 ? linkedProduct.productId : current.primaryProductId,
        // Only fills an EMPTY Website URL — a creator's hand-entered destination is
        // never overwritten (create-pin PRD Section J).
        ...(!current.destinationUrl.trim() && productUrl ? {
          destinationUrl: productUrl,
          destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
        } : {}),
      });
      flashSaved();
      toast.success(tr("studioBoard.toast.linkedProduct"));
      return;
    }

    if (!chosenImageUrl) { toast.error(tr("studioBoard.toast.productNoImage")); return; }
    // Drop any cached scratch setup so a NEW product never inherits a previous scratch
    // session's references/settings. (A retry seeds this key deliberately and opens the
    // drawer itself, so it is unaffected.)
    setAiSetupCache(prev => {
      if (!prev.scratch) return prev;
      const { scratch: _dropped, ...rest } = prev;
      return rest;
    });
    setAiDrawer({ mode: "scratch", product });
  }, [flashSaved, productPickerTargetId, tr]);

  // ── AI drawers ─────────────────────────────────────────────────────────────
  const handleGenerateAiImage = useCallback((d: PinDraft) => setAiDrawer({ mode: "version", draft: d }), []);
  const handleCreateWithAi = useCallback(() => setAiDrawer({ mode: "scratch" }), []);
  const handleAiGenerate = useCallback(async (opts: AiVersionOptions) => {
    if (!aiDrawer) return;
    const parent = aiDrawer.mode === "version" ? aiDrawer.draft : null;
    setAiGenerating(true);
    // Regenerating from an existing pin (version mode) is a "regenerate" action.
    if (parent) track("regenerate_clicked", { draftId: parent.id });

    // ── Path selection ────────────────────────────────────────────────────────
    // WP3-P1's worker path and the grouped multi-reference path are BOTH live, and
    // they are chosen by a runtime probe, not a build flag:
    //   * GENERATION_MODE=worker (production)  → enqueueGeneration returns a jobId.
    //     That path is server-authenticated, one job per run, results delivered by
    //     slot — it owns its own placeholders and is kept exactly as-is below.
    //   * GENERATION_MODE=inline (dev/self-hosted) → enqueueGeneration returns null
    //     and we fall through to runAiGeneration, which plans one request PER style
    //     reference (the API can only carry one style_ref per call and 429s on a
    //     concurrent second call, so groups must be serial).
    // Probing FIRST matters: runAiGeneration creates placeholders eagerly, so
    // letting it run before we know the mode would leave orphan cards behind in
    // worker mode.
    const workerProbe = await enqueueGeneration({ source: parent, setup: opts }).catch(() => "error" as const);
    if (workerProbe === "error") {
      // Worker path errored (e.g. 503 generation_unavailable) — surface it rather than
      // silently falling back to the (likely also broken) inline path. No placeholder
      // cards exist yet, so there is nothing to clean up.
      setAiDrawer(null);
      setAiGenerating(false);
      toast.error(tr("studioBoard.toast.couldNotGenerate"));
      return;
    }

    if (!workerProbe) {
      // ── Inline mode: grouped, one request per style reference ────────────────
      // The run itself lives in lib/studio/runAiGeneration so it can be driven by
      // tests with a real store and a fake generate() — see test-ai-generation-run.
      const batchToastId = `gen-batch-${Date.now()}`;
      let groupTotal = 1;
      await runAiGeneration({ parent, opts }, {
        store: pinDraftStore,
        generate: ({ styleReference, batchRequestId, setup }) =>
          generateAiVersions({ source: parent, setup, styleReference, batchRequestId }),
        resolveModelLabel: (_a, modelKey) => resolveModelLabel(undefined, modelKey),
        onAnalyze: id => { void startImageAnalysis(id); },
        onJudge: id => { void startQualityJudge(id); },
        onPlaceholdersReady: totalPins => {
          // Close the drawer right away — generation continues and the cards update.
          setAiDrawer(null);
          setAiGenerating(false);
          toast.success(totalPins === 1
            ? tr("studioBoard.toast.generatingOne")
            : tr("studioBoard.toast.generatingMany").replace("{n}", String(totalPins)));
        },
        onGroupProgress: (current, total) => {
          groupTotal = total;
          // Batch progress lives in a toast because the drawer closes as soon as the
          // placeholders exist (multi-group runs are long — N serial requests).
          if (total > 1) {
            toast.loading(
              tr("studioBoard.toast.generatingReferenceProgress")
                .replace("{current}", String(current))
                .replace("{total}", String(total)),
              { id: batchToastId },
            );
          }
        },
        onSettled: ({ okCount, failCount }) => {
          if (groupTotal > 1) toast.dismiss(batchToastId);
          if (okCount && failCount) toast.error(tr("studioBoard.toast.generatedSomeFailedSome").replace("{okCount}", String(okCount)).replace("{okPlural}", okCount === 1 ? "" : "s").replace("{failCount}", String(failCount)));
          else if (okCount) toast.success(parent
            ? tr("studioBoard.toast.createdAiPinsKeptOriginal").replace("{n}", String(okCount)).replace("{plural}", okCount === 1 ? "" : "s")
            : tr("studioBoard.toast.createdAiPins").replace("{n}", String(okCount)).replace("{plural}", okCount === 1 ? "" : "s"));
          else toast.error(tr("studioBoard.toast.noAiPinsGenerated"));
        },
      });
      return;
    }

    // ── Worker mode (WP3-P1/P2) ───────────────────────────────────────────────
    // Create N Generating placeholder cards so the user sees the task started
    // (PRD 8.9). Stable keys gen:{requestId}:{i}; lineage preserved; the original
    // upload is never touched.
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
        // WP3-P2: this index IS the worker-mode results[] slot (placeholders[i] ↔
        // slot i, 1:1 — see the enqueue block below). Stamped unconditionally, even
        // in what may turn out to be the inline-mode fallback, since it's a stable
        // per-card fact and harmless when unused.
        generationSlot: i,
      }),
    );
    // Close the drawer right away — generation continues and the cards update.
    setAiDrawer(null);
    setAiGenerating(false);
    toast.success(requested === 1 ? tr("studioBoard.toast.generatingOne") : tr("studioBoard.toast.generatingMany").replace("{n}", String(requested)));

    // 2) WP3-P1: try the worker enqueue path first (response-shape probe — a jobId
    //    means the server is in GENERATION_MODE=worker). null means inline mode; fall
    //    back to the original synchronous generateAiVersions() path unchanged below.
    let enqueued: Awaited<ReturnType<typeof enqueueGeneration>> = null;
    try {
      enqueued = await enqueueGeneration({ source: parent, setup: opts });
    } catch {
      // Worker path errored (e.g. 503 generation_unavailable) — fail these placeholders
      // outright rather than silently falling back to the (likely also broken) inline path.
      placeholders.forEach(p => pinDraftStore.failGeneratedDraft(p.id));
      toast.error(tr("studioBoard.toast.couldNotGenerate"));
      return;
    }

    if (enqueued) {
      // Stamp the job id on each placeholder (slot i ↔ placeholders[i], 1:1 by index —
      // no new cards are ever created in this path, matching the P1 contract).
      placeholders.forEach(p => pinDraftStore.updateDraft(p.id, { generationJobId: enqueued!.jobId }));
      let doneCount = 0, failCount = 0;
      pollGenerationJob(enqueued.jobId, {
        onSlot: (slot, status, url) => {
          const placeholder = placeholders[slot];
          if (!placeholder) return;
          if (status === "done" && url) {
            pinDraftStore.completeGeneratedDraft(placeholder.id, url);
            void startImageAnalysis(placeholder.id);
            doneCount++;
          } else {
            pinDraftStore.failGeneratedDraft(placeholder.id);
            failCount++;
          }
        },
        onEnd: () => {
          if (doneCount && failCount) toast.error(tr("studioBoard.toast.generatedSomeFailedSome").replace("{okCount}", String(doneCount)).replace("{okPlural}", doneCount === 1 ? "" : "s").replace("{failCount}", String(failCount)));
          else if (doneCount) toast.success(parent
            ? tr("studioBoard.toast.createdAiPinsKeptOriginal").replace("{n}", String(doneCount)).replace("{plural}", doneCount === 1 ? "" : "s")
            : tr("studioBoard.toast.createdAiPins").replace("{n}", String(doneCount)).replace("{plural}", doneCount === 1 ? "" : "s"));
          else toast.error(tr("studioBoard.toast.noAiPinsGenerated"));
        },
      });
      return;
    }

    // 2b) Inline mode (unchanged): run generation; resolve/fail each placeholder.
    //    A closed drawer or a partial failure never rolls back successful results.
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
        // Phase C: grade AI results in parallel (independent of copy analysis).
        void startQualityJudge(placeholders[i].id);
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
        void startQualityJudge(extra.id);
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
    // The run itself lives in lib/studio/runAiGeneration so it can be driven by
    // tests with a real store and a fake generate() — see test-ai-generation-run.
    const batchToastId = `gen-batch-${Date.now()}`;
    let groupTotal = 1;
    await runAiGeneration({ parent, opts }, {
      store: pinDraftStore,
      generate: ({ styleReference, batchRequestId, setup }) =>
        generateAiVersions({ source: parent, setup, styleReference, batchRequestId }),
      resolveModelLabel: (_a, modelKey) => resolveModelLabel(undefined, modelKey),
      onAnalyze: id => { void startImageAnalysis(id); },
      onJudge: id => { void startQualityJudge(id); },
      onPlaceholdersReady: totalPins => {
        // Close the drawer right away — generation continues and the cards update.
        setAiDrawer(null);
        setAiGenerating(false);
        toast.success(totalPins === 1
          ? tr("studioBoard.toast.generatingOne")
          : tr("studioBoard.toast.generatingMany").replace("{n}", String(totalPins)));
      },
      onGroupProgress: (current, total) => {
        groupTotal = total;
        // Batch progress lives in a toast because the drawer closes as soon as the
        // placeholders exist (multi-group runs are long — N serial requests).
        if (total > 1) {
          toast.loading(
            tr("studioBoard.toast.generatingReferenceProgress")
              .replace("{current}", String(current))
              .replace("{total}", String(total)),
            { id: batchToastId },
          );
        }
      },
      onSettled: ({ okCount, failCount }) => {
        if (groupTotal > 1) toast.dismiss(batchToastId);
        if (okCount && failCount) toast.error(tr("studioBoard.toast.generatedSomeFailedSome").replace("{okCount}", String(okCount)).replace("{okPlural}", okCount === 1 ? "" : "s").replace("{failCount}", String(failCount)));
        else if (okCount) toast.success(parent
          ? tr("studioBoard.toast.createdAiPinsKeptOriginal").replace("{n}", String(okCount)).replace("{plural}", okCount === 1 ? "" : "s")
          : tr("studioBoard.toast.createdAiPins").replace("{n}", String(okCount)).replace("{plural}", okCount === 1 ? "" : "s"));
        else toast.error(tr("studioBoard.toast.noAiPinsGenerated"));
      },
    });
  }, [aiDrawer, tr]);


  const handleDelete = useCallback((d: PinDraft) => {
    if (typeof window !== "undefined" && !window.confirm(tr("studioBoard.confirm.deleteDraft"))) return;
    if (d.source === "ai_generated_from_upload") track("generation_deleted", { draftId: d.id });
    pinDraftStore.deleteDraft(d.id); toast.success(tr("studioBoard.toast.draftDeleted"));
    setSelectedIds(previous => { const next = new Set(previous); next.delete(d.id); return next; });
  }, [tr]);
  const handleArchive = useCallback((d: PinDraft) => {
    pinDraftStore.archiveDraft(d.id); toast.success(tr("studioBoard.toast.archived"));
    setSelectedIds(previous => { const next = new Set(previous); next.delete(d.id); return next; });
  }, [tr]);
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
    // Restore the failed card's OWN generation group reference, so retrying a failed
    // reference group regenerates against the same reference instead of reopening a
    // blank drawer (acceptance criterion 24). The association is persisted on the
    // draft, so this survives refresh and cross-device — unlike the in-memory setup
    // cache the drawer otherwise falls back to.
    const groupReference: SelectedReference[] = d.referenceImageUrl
      ? [{
          id: d.referenceId || d.referenceImageUrl,
          imageUrl: d.referenceImageUrl,
          source: (d.referenceSource as SelectedReference["source"]) || "saved",
          role: "style_reference",
        }]
      : [];
    // Restore the product images the failed run used. An EMPTY list here would be
    // treated as authoritative by buildInitialProductSelections (initialSetup wins
    // over the parent fallback), leaving the drawer with no product and Generate
    // permanently disabled — so only build a setup when we can supply them.
    const snapshotProducts = (d.setupSnapshot?.selectedProducts ?? [])
      .map(p => p.imageUrl)
      .filter((u): u is string => !!u);
    const productImages = snapshotProducts.length
      ? snapshotProducts
      : parent?.imageUrl ? [parent.imageUrl] : d.sourceImageUrl ? [d.sourceImageUrl] : [];

    // Preserve the ORIGINAL model. Only a known model key is accepted — a blank or
    // unrecognised persisted value falls back rather than being passed through to a
    // provider that does not exist.
    const KNOWN_MODELS = ["gemini_image", "gpt_image"];
    const snapshotModel = (d.setupSnapshot?.modelKey ?? "").trim();
    const retryModelKey = KNOWN_MODELS.includes(snapshotModel) ? snapshotModel : "gemini_image";

    // Build a setup whenever there is ANYTHING worth restoring. Gating on
    // `groupReference.length && productImages.length` meant a zero-reference failure
    // never restored its model — the drawer silently reopened on the default.
    // productImages may be empty here only when there is genuinely nothing to restore,
    // in which case no setup is cached at all (an empty list would otherwise be taken
    // as authoritative and leave Generate disabled).
    const retrySetup = productImages.length
      ? {
          productImages,
          referenceImages: groupReference.map(r => r.imageUrl),
          referenceSelections: groupReference,
          count: 1,
          format: d.format ?? "Pinterest 2:3",
          modelKey: retryModelKey,
          variationMode: "distinct" as const,
          selectedDirectionId: null,
          selectedTagIds: [],
          directionBrief: d.promptSnapshot ?? "",
          briefManuallyEdited: false,
        }
      : undefined;

    // The drawer opens in version mode when there is a parent or an own image, and
    // reads aiSetupCache under the DRAFT ID in that case; a true scratch drawer reads
    // the literal key "scratch". Cache under whichever key will actually be read —
    // keying a scratch retry by draft id silently discarded the restored reference.
    // Carry the failed draft's OWN product forward. A scratch retry reopens without a
    // parent, and a restored image URL alone is classified as an implicit draft image
    // — which sends primaryProductSelection: null and silently drops the product link,
    // its Shopify id, and the Website URL the failed run had. Passing the product as
    // an explicit selection is what preserves them.
    const failedPrimary = d.linkedProducts?.length
      ? (d.linkedProducts.find(p => p.productId === d.primaryProductId) ?? d.linkedProducts[0])
      : null;
    const retryProduct = failedPrimary ? selectionFromLinkedProduct(failedPrimary) : undefined;

    // The failed draft's OWN product must survive every retry branch. Previously
    // retryProduct was computed but only reached the scratch branch, so a version
    // retry re-inherited the PARENT's product: if the failed run explicitly chose
    // product B from a parent linked to A, retrying silently produced A.
    const nextDrawer: AiDrawerState = parent
      ? { mode: "version", draft: parent, product: retryProduct }
      : d.imageUrl ? { mode: "version", draft: d, product: retryProduct } : { mode: "scratch", product: retryProduct };
    const cacheKey = nextDrawer.mode === "version" ? nextDrawer.draft.id : "scratch";
    if (retrySetup) setAiSetupCache(prev => ({ ...prev, [cacheKey]: retrySetup }));
    setAiDrawer(nextDrawer);
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
    <div data-testid="studio-board" style={{ flex: 1, minWidth: 0, display: "flex", minHeight: 0, background: BUI.bg, position: "relative", overflow: "hidden" }}>
      <div data-testid="studio-board-content" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <input ref={fileRef} type="file" accept={ACCEPT} multiple data-testid="board-upload-input" style={{ display: "none" }}
        onChange={e => { if (e.target.files?.length) void handleFiles(e.target.files); e.target.value = ""; }} />

      {/* Context suppression (PRD §2.2): never show the Banner while already on the
          Failed view — the user is already looking at exactly what it would tell them. */}
      {filter !== "failed" && (
        <FailureBanner
          count={bannerCount}
          onReview={() => {
            // Banner CTA → Failed view defaults to "Publish failures" (matches the
            // Banner's own count, which is publish-failures only). Plan applies the same
            // rule on its own surface now (stays in Plan's Failed list, no cross-nav).
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
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button type="button" data-testid="board-create-ai" onClick={handleCreateWithAi}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
              <Sparkles style={{ width: 13, height: 13 }} /> {tr("studioBoard.aiDrawer.createWithAi")}
            </button>
            <button type="button" data-testid="board-upload-more" onClick={openFilePicker} disabled={uploading}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: `1px solid ${BUI.border}`, background: BUI.surface, color: BUI.textSec, fontSize: 12, fontWeight: 750, cursor: "pointer", fontFamily: "inherit" }}>
              {uploading ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Upload style={{ width: 13, height: 13 }} />}
              {uploading && uploadProgress ? ` ${tr("studioBoard.uploadingProgress").replace("{done}", String(uploadProgress.done)).replace("{total}", String(uploadProgress.total))}` : ` ${tr("studioBoard.uploadMore")}`}
            </button>
            {shopifyEnabled && (
              <button type="button" data-testid="board-select-product" onClick={() => { setProductPickerTargetId(null); setShowProductPicker(true); }}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: BUI.textSec, background: "none", border: `1px solid ${BUI.border}`, borderRadius: 9, padding: "7px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                {tr("studioBoard.selectProduct")}
              </button>
            )}
            {selectedIds.size > 0 && (
              <div data-testid="board-selection-toolbar" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11.5, fontWeight: 800, color: BUI.text }}>{selectedIds.size} selected</span>
                <button type="button" onClick={() => setSelectedIds(new Set(items.map(item => item.draft.id)))}
                  style={{ border: 0, background: "none", color: BUI.purple, fontSize: 11, fontWeight: 750, cursor: "pointer", padding: 4 }}>Select all</button>
                <button type="button" onClick={() => setSelectedIds(new Set())}
                  style={{ border: 0, background: "none", color: BUI.textSec, fontSize: 11, fontWeight: 750, cursor: "pointer", padding: 4 }}>Clear</button>
                {selectedIds.size >= 2 && (
                  <button type="button" data-testid="board-batch-edit" onClick={() => setBatchEditOpen(true)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 800, color: "#fff", background: BUI.gradient, border: 0, borderRadius: 9, padding: "7px 14px", cursor: "pointer", fontFamily: "inherit" }}>
                    <Rows3 style={{ width: 13, height: 13 }} /> Batch edit
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <StudioBoardFilters value={filter} counts={counts} onChange={setFilter} />
        {filter !== "failed" && publishFailureCount > 0 && (
          <button type="button" data-testid="studio-failure-notice" onClick={() => setFilter("failed", "publish")}
            style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, padding: 0, border: 0, background: "none", color: "#b45309", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            <AlertTriangle style={{ width: 12, height: 12 }} />
            {publishFailureCount} {publishFailureCount === 1 ? "destination needs" : "destinations need"} attention · Review
          </button>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 22 }}>
        {/* Failed-view sub-filter chips (PRD §4) — only inside the Failed view, above
            the card grid/empty state. Purely a client-side re-filter of the "failed"
            BoardFilter results; never touches usePinBoardDrafts' own counts. */}
        {filter === "failed" && (
          <div data-testid="failed-sub-filters" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {([
              { id: "publish" as const, label: "Publish failures", n: failedSubCounts.publish },
              { id: "generation" as const, label: "Generation failures", n: failedSubCounts.generation },
              { id: "all" as const, label: "All", n: failedSubCounts.all },
            ]).map(chip => {
              const active = failedSubFilter === chip.id;
              return (
                <button key={chip.id} type="button" data-testid={`failed-sub-${chip.id}`} onClick={() => setFailedSub(chip.id)}
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
            {planWeekScope && failedSubFilter === "publish" && (
              <span data-testid="failed-plan-week-scope" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 4, padding: "5px 9px", borderRadius: 999, border: `1px solid ${BUI.border}`, color: BUI.textSec, background: BUI.surface, fontSize: 11.5, fontWeight: 700 }}>
                Plan week {planWeekScope}
                <button type="button" onClick={() => {
                  try {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("week");
                    window.history.replaceState({}, "", url.toString());
                    window.location.reload();
                  } catch { /* no-op */ }
                }} aria-label="View all publish failures" style={{ border: "none", background: "none", color: BUI.purple, padding: 0, cursor: "pointer", font: "inherit" }}>
                  View all
                </button>
              </span>
            )}
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
              <button type="button" data-testid="board-select-product-empty" onClick={() => { setProductPickerTargetId(null); setShowProductPicker(true); }}
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
          <div data-testid="studio-board-grid" style={{ display: "grid", gridTemplateColumns: planPinned
            ? "repeat(auto-fill, minmax(248px, 1fr))"
            : "repeat(auto-fill, minmax(280px, 1fr))", gap: 14, alignItems: "start" }}>
            {items.map(({ draft, lifecycle }) => (
              <PinBoardCard
                key={draft.id} draft={draft} lifecycle={lifecycle} publishing={isPublishing(draft.id)}
                topPick={topPickIds.has(draft.id)}
                fallbackBoardName={recentBoardName}
                selected={selectedIds.has(draft.id)}
                onSelectedChange={(id, selected) => setSelectedIds(previous => {
                  const next = new Set(previous);
                  if (selected) next.add(id); else next.delete(id);
                  return next;
                })}
                active={activeId === draft.id} onSetActive={setActiveId}
                boards={customerBoards} boardsLoading={boardsLoading} disconnected={disconnected}
                needsReconnect={needsReconnect} boardsError={boardsError} onRetryBoards={refreshBoards}
                boardFieldError={scheduleErrors[draft.id] || undefined}
                titleFieldError={fieldErrors[draft.id]?.title}
                descriptionFieldError={fieldErrors[draft.id]?.description}
                onPersist={handlePersist}
                onSchedule={handleSchedule} onCustomSchedule={handleCustomSchedule}
                onSelectProduct={(pin) => { setProductPickerTargetId(pin.id); setShowProductPicker(true); }}
                onGenerateAiImage={handleGenerateAiImage} onPublish={handlePublish}
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
          // A scratch drawer opened WITH a product gets a per-product key so a fresh
          // "Select product" never inherits a previous scratch session's cached setup.
          key={aiDrawer.mode === "version" ? aiDrawer.draft.id
            : aiDrawer.product ? `scratch:${aiDrawer.product.id ?? aiDrawer.product.imageUrl}`
            : "scratch"}
          draft={aiDrawer.mode === "version" ? aiDrawer.draft : null}
          title={aiDrawer.mode === "version" ? tr("studioBoard.aiDrawer.generateAiImage") : tr("studioBoard.aiDrawer.createWithAi")}
          open generating={aiGenerating}
          // A product prefill takes precedence over a cached scratch setup.
          // A cached setup wins when one exists (a retry seeds it with the failed
          // run's reference + products). Only a FRESH Select-product scratch — which
          // has a product but no cached setup — starts clean, so a previous scratch
          // session's settings are not inherited by a different product.
          initialSetup={aiSetupKey ? aiSetupCache[aiSetupKey] : undefined}
          // Both modes may carry a product: scratch from Select product, version from
          // a retry restoring the failed draft's own product.
          initialProductSelection={aiDrawer.product ?? null}
          onSetupChange={setup => {
            if (!aiSetupKey) return;
            setAiSetupCache(prev => ({ ...prev, [aiSetupKey]: setup }));
          }}
          onClose={() => setAiDrawer(null)}
          onGenerate={handleAiGenerate}
        />
      )}

      {showProductPicker && (
        <CanonicalProductPicker
          // When attaching to an existing card, the new product only becomes primary
          // if that card does not already have one.
          hasPrimary={!!(productPickerTargetId && pinDraftStore.getDraft(productPickerTargetId)?.primaryProductId)}
          selectionMode="single"
          onSelect={handleProductSelect}
          onClose={() => { setShowProductPicker(false); setProductPickerTargetId(null); }}
        />
      )}
      <BatchEditDrawer
        open={batchEditOpen}
        pins={selectedBatchPins}
        source="weekly_plan"
        onClose={() => setBatchEditOpen(false)}
        onApply={handleBatchApply}
        onGenerateMetadata={() => toast.info("Select rows, then use Generate copy to fill missing details.")}
        onScheduleSelected={ids => {
          ids.forEach(id => { ensureScheduledPlanTime(id); });
          toast.success(`${ids.length} ${ids.length === 1 ? "content item" : "content items"} scheduled.`);
        }}
        onPublishComplete={ids => {
          const now = new Date().toISOString();
          ids.forEach(id => {
            const current = pinDraftStore.getDraft(id);
            if (!current) return;
            const pinterest = contentDestinations(current).find(destination => destination.provider === "pinterest") ?? { id: `${id}:pinterest`, provider: "pinterest" as const };
            const prior = contentDestinationResults(current).filter(result => result.destinationId !== pinterest.id);
            pinDraftStore.updateDraft(id, {
              postedAt: now,
              destinationResults: [...prior, { destinationId: pinterest.id, provider: "pinterest", status: "published", publishedAt: now }],
              publishError: undefined,
              failureType: undefined,
              errorCategory: undefined,
              publishErrorCode: undefined,
            });
          });
        }}
      />
      {pendingUploadFiles && (
        <div data-testid="multi-upload-modal" role="dialog" aria-modal="true" aria-labelledby="multi-upload-title"
          style={{ position: "fixed", inset: 0, zIndex: 360, background: "rgba(15,23,42,0.42)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ width: "min(720px, 94vw)", borderRadius: 16, border: `1px solid ${BUI.border}`, background: BUI.surface, boxShadow: "0 24px 70px rgba(15,23,42,0.24)", padding: 22 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <h2 id="multi-upload-title" style={{ margin: 0, fontSize: 18, color: BUI.text }}>You&apos;ve uploaded {pendingUploadFiles.length} images</h2>
                <p style={{ margin: "5px 0 0", fontSize: 12.5, color: BUI.textSec }}>How would you like to publish them?</p>
              </div>
              <button type="button" aria-label="Cancel" onClick={() => setPendingUploadFiles(null)} style={{ border: "none", background: "transparent", color: BUI.textSec, cursor: "pointer", padding: 4 }}><X style={{ width: 17, height: 17 }} /></button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 18 }}>
              <UploadChoiceCard selected={uploadChoice === "together"} icon={<Images style={{ width: 20, height: 20 }} />} title="Publish together"
                description="Use all images in one carousel or multi-image post." visual="stack" onClick={() => setUploadChoice("together")} />
              <UploadChoiceCard selected={uploadChoice === "separate"} icon={<Rows3 style={{ width: 20, height: 20 }} />} title="Publish separately"
                description={`Create ${pendingUploadFiles.length} separate posts, one image per post.`} visual="rows" onClick={() => setUploadChoice("separate")} />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 18 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: BUI.textSec, cursor: "pointer" }}>
                <input type="checkbox" checked={rememberUploadChoice} onChange={e => setRememberUploadChoice(e.target.checked)} /> Don&apos;t show this again
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => setPendingUploadFiles(null)} style={{ padding: "8px 15px", borderRadius: 8, border: `1px solid ${BUI.border}`, background: BUI.surface, color: BUI.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
                <button type="button" data-testid="multi-upload-continue" onClick={continueMultiUpload} style={{ padding: "8px 17px", borderRadius: 8, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Continue</button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
      <StudioPlanSidebar drafts={allItems.map(item => item.draft)} pinned={planPinned} onPinnedChange={handlePlanPinnedChange} />
    </div>
  );
}

function UploadChoiceCard({ selected, icon, title, description, visual, onClick }: {
  selected: boolean; icon: React.ReactNode; title: string; description: string; visual: "stack" | "rows"; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      style={{ padding: 16, minHeight: 172, borderRadius: 12, border: `1.5px solid ${selected ? BUI.purple : BUI.border}`, background: selected ? "rgba(124,58,237,0.045)" : BUI.surface, color: BUI.text, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 800, color: selected ? BUI.purple : BUI.text }}>{icon}{title}</span>
        <span style={{ width: 18, height: 18, borderRadius: "50%", border: `1.5px solid ${selected ? BUI.purple : BUI.borderHi}`, background: selected ? BUI.purple : "transparent", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{selected ? <Check style={{ width: 12, height: 12 }} /> : null}</span>
      </div>
      <p style={{ margin: "8px 0 14px", fontSize: 11.5, lineHeight: 1.5, color: BUI.textSec }}>{description}</p>
      <div style={{ height: 72, display: "flex", alignItems: "center", justifyContent: "center", gap: visual === "rows" ? 7 : 0 }}>
        {(visual === "stack" ? [0, 1, 2] : [0, 1, 2]).map((item, index) => (
          <span key={item} style={{ width: 44, height: 62, borderRadius: 7, border: `1px solid ${BUI.border}`, background: `linear-gradient(145deg, rgba(124,58,237,${0.08 + index * 0.03}), rgba(14,165,233,0.08))`, boxShadow: visual === "stack" ? "0 5px 12px rgba(15,23,42,0.10)" : "none", marginLeft: visual === "stack" && index ? -16 : 0, transform: visual === "stack" ? `translateY(${Math.abs(index - 1) * 3}px)` : "none" }} />
        ))}
      </div>
    </button>
  );
}
