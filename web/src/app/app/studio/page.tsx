"use client";
import { useState, useEffect, useRef, Suspense, useCallback, useMemo } from "react";
import { preload } from "swr";
import { PRODUCT_IDEAS_SWR_KEY, fetchProductIdeasWithMeta } from "@/lib/productIdeas";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Sparkles, X, ChevronDown, Plus, Clock,
  Search, AlertCircle, Target,
  CheckCircle2, Calendar,
  Play,
} from "lucide-react";
import { toast } from "sonner";
import dynamic from "next/dynamic";
import { SelectedAssetPreview, type SelectedAssetPreviewItem } from "@/components/studio/SelectedAssetPreview";
import { CreativeDirectionPanel } from "@/components/studio/CreativeDirectionPanel";
import * as assetStore from "@/lib/assetStore";
import { supabase } from "@/lib/supabase";
import {
  loadPrefill, buildPromptFromPrefill, draftToPrefill,
  type CreatePinsPrefill,
} from "@/lib/createPinsPrefill";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { ensureScheduledPlanTime } from "@/lib/smartSchedule";
import { isPlanDebugEnabled } from "@/lib/planDebug";
import { toProxyUrl } from "@/lib/imageProxy";
import {
  addHistory, loadHistory, createRunningSessionInDb, updateSessionInDb,
  mergeHistoryEntries, fetchGenerationsFromDb, deriveEntryStatus, resolveStaleRunningEntries,
  type SetupSnapshot, type HistoryEntry, type GenerationStatus, type GenerationErrorType, type CategoryAudit,
  type CreativeDirectionSnapshotV2,
  type PinGroup as HistoryPinGroup, type ProductSnapshot,
} from "@/lib/studioPersistence";
import {
  saveSetupSnapshot as saveRemixSetup,
  loadAllSetupSnapshots as loadAllRemixSetups,
  pruneSetupSnapshots as pruneRemixSetups,
} from "@/lib/remixRecoveryStore";
import type { PinMetadataFormState, PinDetailsGenStatus, DrawerTab, RemixDraftSetup } from "@/components/studio/PinDetailsDrawer";
import type { BatchPinRow, BatchApplyOpts } from "@/components/studio/BatchEditDrawer";
import { StudioBoard } from "@/components/studio/StudioBoard";
import { StudioBoardSkeleton } from "@/components/studio/StudioBoardSkeleton";
import {
  resolveStudioExperienceFromEnv,
  resolveStudioExperienceFromClient,
  type StudioExperience,
} from "@/lib/studioBoardFlag";
import { PinCardActions, type PinCardStatus } from "@/components/studio/PinCardActions";
import { resolvePinDetail, type PinDetailView } from "@/components/studio/pinDetails";
import { analyzeProductSet } from "@/lib/studio/productAnalysis";
import { analyzeReferences } from "@/lib/studio/referenceAnalysis";
import { inferCreativeIntent } from "@/lib/studio/creativeIntent";
import { getCategoryPlaybook } from "@/lib/studio/categoryPlaybooks";
import { buildHiddenPrompt, inferReferenceInfluenceMode } from "@/lib/studio/hiddenPromptBuilder";
import { AiUnderstandingPanel } from "@/components/studio/AiUnderstandingPanel";
import { CreativeChips } from "@/components/studio/CreativeChips";
import {
  rankOpportunities, buildCreativeTags, buildDirectionBrief, defaultSelectedTagIds,
  toggleTagSelection, cleanProductTitle, buildOutputVariants,
  type CreativeTag, type TagGroup, type OutputVariant,
} from "@/lib/studio/creativeControls";
import {
  markOutputRetrying, applyRetrySuccess, applyRetryFailure,
  planSingleOutputRetry, outputSlotId, SINGLE_OUTPUT_RETRY_COUNT,
} from "@/lib/studio/retryScope";
import { buildRegeneratePayload, regenerateErrorCopy, shouldBlockImagelessRetry } from "@/lib/studio/regeneratePayload";
import {
  findDraftForStudioOutput, deriveCardStatusFromDraft,
  type StudioPlanMatchReason,
} from "@/lib/studioPlanMatch";

// Developer-only: show the verbose AI Understanding / Creative Direction panels.
// Normal users see lightweight direction chips instead.
import {
  generatePinMetadataDraft, generateBatchMetadataDraft, applyDraftToPinFields,
  computePlanningStatusFromFields, metadataReadinessLabel, pinNeedsDetailsGeneration, EMPTY_TOUCHED,
  writePinProducts,
  type PinMetadataDraft, type MetadataTouchedFlags,
} from "@/lib/pinMetadata";
import { resolveCanonicalPinProducts } from "@/lib/studio/pinProducts";
import { usePublishAssistantContext } from "@/lib/assistant/useAssistant";
import { detectCreatePins } from "@/lib/assistant/detectors/createPins";
import { detectSinglePin } from "@/lib/assistant/detectors/singlePin";
import type { AssistantContext } from "@/lib/assistant/types";
import { MODEL_KEY_TO_LABEL, resolveModelLabel } from "@/lib/studio/modelLabel";
import * as pinMetadataStore from "@/lib/pinMetadataStore";
import { preserveAffiliateContextOnRegenerate, applyCreatorProductLinkToPinDraft } from "@/lib/affiliate/pinAffiliateInheritance";
import { getAmazonAffiliateSettings, type AmazonAffiliateSettings } from "@/lib/affiliate/amazonAffiliateSettings";
import { resolveStudioAffiliateContext, type StudioAffiliateContext } from "@/lib/studio/affiliateContext";
import { canViewGenerationDebug } from "@/lib/generationDebugAccess";
import type { PinDraft } from "@/lib/pinDraftStore";
import { readResolvedContentLanguage, type LanguageCode } from "@/lib/i18n/config";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  buildWeeklyPlanItemFromGeneratedPin,
  canAddGeneratedPinToPlan,
  localDateISO,
} from "@/lib/weeklyPlanHandoff";
import {
  buildManualBrief,
  buildSelectedCreativeAssets,
  getRecommendedCreativeDirections,
  inferCreativeCategory,
  type CreativeDirectionRecommendation,
  type CreativeOpportunityContext,
  type GuidedControls,
  type SelectedCreativeAsset,
} from "@/lib/studio/creativeDirections";
import { markDataReady } from "@/lib/navTiming";

// ── Lazily loaded components ─────────────────────────────────────────────────
// Heavy drawers/pickers deferred out of the main route chunk so the Create
// Pins page shell mounts faster after a sidebar nav. Behavior is unchanged —
// each of these already renders nothing when closed / not selected.
const PinDetailsDrawer = dynamic(() =>
  import("@/components/studio/PinDetailsDrawer").then(m => m.PinDetailsDrawer), { ssr: false });
const BatchEditDrawer = dynamic(() =>
  import("@/components/studio/BatchEditDrawer").then(m => m.BatchEditDrawer), { ssr: false });
const PinDetailsModal = dynamic(() =>
  import("@/components/pin-details/PinDetailsModal").then(m => m.PinDetailsModal), { ssr: false });
const InlineCreateAssetPicker = dynamic(() =>
  import("@/components/studio/InlineCreateAssetPicker").then(m => m.InlineCreateAssetPicker), { ssr: false });

// ── Theme palette ─────────────────────────────────────────────────────────────
// Surfaces/text/borders resolve from the app-shell theme tokens (--app-*) so the
// whole studio follows the global light/dark setting. Brand + semantic colors are
// theme-independent. Dark hex literals are kept as fallbacks.

const D = {
  bg:          "var(--app-bg, #0B0E17)",
  surface:     "var(--app-surface-2, #111827)",
  card:        "var(--app-surface, #161D2E)",
  cardElev:    "var(--app-surface-3, #1A2236)",
  border:      "var(--app-border, rgba(255,255,255,0.07))",
  borderStr:   "var(--app-border-hi, rgba(255,255,255,0.12))",
  text:        "var(--app-text, #E2E8F0)",
  textSec:     "var(--app-text-sec, #8892A4)",
  textMuted:   "var(--app-text-muted, #4A5568)",
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
  plannedTime?:     string;
  plannedAt?:       string;
  weeklyPlanItemId?: string | null;
  metadataDraft?:   PinMetadataDraft;
  metadataTouched:  MetadataTouchedFlags;
  setupSnapshot?:   SetupSnapshot | null;
  generationSetup?: SetupSnapshot | null;
  batchId?:         string | null;
  requestId?:       string | null;
  createdAt?:       string;
  // ── Amazon affiliate product link context (creator-owned) ──────────────────
  productId?:            string;
  creatorProductLinkId?: string;
  sourceProductImageUrl?: string;
  destinationUrlSource?:  string;
};

type RefGroup = {
  refUrl:        string | null;
  refIndex:      number;
  items:         StudioPin[];
  status:        "generating" | "done" | "partial" | "failed";
  expectedCount: number;
  retrying?:     boolean;
  // Output indices currently being retried (per-slot). A retrying slot never flips
  // the group/sibling to "generating".
  retryingSlots?: number[];
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
  generationFinalPrompt?: string;
  setupSnapshot?:     SetupSnapshot;
  errorType?:         GenerationErrorType;
  errorMessage?:      string;
  model?:             string;
  format?:            string;
  textOverlay?:       string;
  groupErrors?:       Record<number, { message?: string; errorType?: GenerationErrorType }>;
  categoryAudit?:     CategoryAudit;
  /** Amazon affiliate context resolved at generate time (selected product + link). */
  affiliate?:         StudioAffiliateContext | null;
};

/**
 * Stamp a freshly generated Studio pin with its creator-owned Amazon affiliate
 * context. Fresh pins have no manual edits yet, so we start from an empty
 * destination and let the canonical helper fill the affiliate URL + source marker.
 * A pin already marked "manual" is never overwritten.
 */
function applyAffiliateToFreshPin(pin: StudioPin, ctx: StudioAffiliateContext | null | undefined): StudioPin {
  if (!ctx || ctx.link.status !== "ready") return pin;
  const base: StudioPin = pin.destinationUrlSource === "manual" ? pin : { ...pin, destinationUrl: "" };
  const stamped = applyCreatorProductLinkToPinDraft(base, ctx.product, ctx.link);
  // Keep the metadata draft's destination in sync so Pin Details / Batch Edit and
  // the publish path all read the same affiliate URL.
  const metadataDraft = stamped.metadataDraft
    ? { ...stamped.metadataDraft, destinationUrl: stamped.destinationUrl, destinationUrlSource: stamped.destinationUrlSource }
    : stamped.metadataDraft;
  const synced: StudioPin = { ...stamped, metadataDraft };
  persistStudioPinMetadata(synced, synced.batchId ?? "");
  return synced;
}

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
    plannedDate: pin.plannedDate, plannedTime: pin.plannedTime, plannedAt: pin.plannedAt, planningStatus: pin.planningStatus,
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
    plannedTime: stored.plannedTime ?? draft?.scheduledTime ?? pin.plannedTime,
    plannedAt: stored.plannedAt ?? draft?.plannedAt ?? pin.plannedAt,
    planningStatus: (stored.planningStatus as PlanStatus) || pin.planningStatus,
    metadataDraft: stored.metadataDraft,
    metadataTouched: stored.touched,
    weeklyPlanItemId: draft?.id ?? pin.weeklyPlanItemId,
    setupSnapshot: pin.setupSnapshot,
    generationSetup: pin.generationSetup,
    batchId: pin.batchId,
    requestId: pin.requestId,
    createdAt: pin.createdAt,
  };
}

function devLogSnapshot(event: string, payload: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "production") return;
  console.log(event, payload);
}

// Enrich a product image URL with metadata from the asset store.
// Used when building SetupSnapshot.selectedProducts at generation time.
// Falls back to minimal { imageUrl, title: "", source: "uploaded" } when no asset record exists
// (e.g. raw data-URL uploads that were never passed through the picker).
function productUrlToSnapshot(imageUrl: string): ProductSnapshot {
  const asset = assetStore.getAssets().find(a => a.imageUrl === imageUrl && a.role === "product");
  return {
    imageUrl,
    title:        asset?.title?.trim()    ?? "",
    source:       asset?.source           ?? "uploaded",
    productUrl:   asset?.productUrl?.trim() || asset?.sourceUrl?.trim() || undefined,
    productId:    asset?.id,
    sourceDomain: asset?.sourceDomain,
  };
}

// Detects whether the user's creative-direction prompt explicitly requests
// rendered text inside the image (e.g. "add text: Spring Sale").
// Only returns true for unambiguous requests — errs on the side of no text.
function detectTextOverlayIntent(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return /\b(add text|with text|include text|overlay text|text overlay|the words?\s|headline|typography|text that says|words on the image|add label|put.*words?|title that says|overlay.*saying|add.*saying|text:\s)/i.test(p);
}

function createCompletedPin(
  sessionId: string, gi: number, ii: number, url: string,
  session: Pick<GenerationSession, "keyword" | "category" | "setupSnapshot" | "promptFull" | "generationFinalPrompt">,
  refLabel: string,
): StudioPin {
  const id = `${sessionId}_g${gi}_p${ii}`;
  const createdAt = new Date().toISOString();
  const existing = pinMetadataStore.getPinMetadata(id);
  if (existing) {
    const draft = pinDraftStore.getDraftByImageUrl(url);
    const hydrated = hydratePinFromStore({
      id, url, planningStatus: (existing.planningStatus as PlanStatus) || "not_added",
      title: existing.title, description: existing.description,
      altText: existing.altText, destinationUrl: existing.destinationUrl,
      plannedDate: existing.plannedDate, plannedTime: existing.plannedTime, plannedAt: existing.plannedAt, weeklyPlanItemId: draft?.id ?? null,
      metadataDraft: existing.metadataDraft, metadataTouched: existing.touched,
      setupSnapshot: session.setupSnapshot ?? null,
      generationSetup: session.setupSnapshot ?? null,
      batchId: sessionId,
      requestId: id,
      createdAt,
    }, sessionId);
    devLogSnapshot("[GenerateSetup] output pin hydrated from metadata store", {
      pinId: id,
      batchId: sessionId,
      requestId: id,
      hasPinSetupSnapshot: !!hydrated.setupSnapshot,
      hasPinGenerationSetup: !!hydrated.generationSetup,
      onlyBatchPointer: !hydrated.setupSnapshot && !!hydrated.batchId,
    });
    return hydrated;
  }
  const metaDraft = generatePinMetadataDraft({
    pinIndex: ii, groupIndex: gi,
    keyword: session.keyword, category: session.category,
    opportunityTitle: session.setupSnapshot?.opportunityTitle,
    promptSnapshot: session.promptFull ?? session.setupSnapshot?.promptSnapshot,
    setupSnapshot: session.setupSnapshot,
    referenceLabel: refLabel,
    referenceVisualFormat: session.setupSnapshot?.selectedReferences?.[gi]?.visualFormat,
    generationFinalPrompt: session.generationFinalPrompt,
    contentLanguage: readResolvedContentLanguage(),
  });
  const fields = applyDraftToPinFields(metaDraft);
  const pin: StudioPin = {
    id, url, planningStatus: "not_added",
    ...fields, metadataDraft: metaDraft, metadataTouched: EMPTY_TOUCHED,
    weeklyPlanItemId: null,
    setupSnapshot: session.setupSnapshot ?? null,
    generationSetup: session.setupSnapshot ?? null,
    batchId: sessionId,
    requestId: id,
    createdAt,
  };
  persistStudioPinMetadata(pin, sessionId);
  devLogSnapshot("[GenerateSetup] output pin saved", {
    pinId: id,
    batchId: sessionId,
    requestId: id,
    setupSnapshotEmbedded: !!pin.setupSnapshot,
    onlyBatchPointer: !pin.setupSnapshot && !!pin.batchId,
    productImagesCount: pin.setupSnapshot?.selectedProducts?.length ?? 0,
    pinReferencesCount: pin.setupSnapshot?.selectedReferences?.length ?? 0,
  });
  return pin;
}

function newPin(sessionId: string, gi: number, ii: number, url: string, session?: GenerationSession, refLabel?: string): StudioPin {
  if (session) {
    return createCompletedPin(sessionId, gi, ii, url, session, refLabel ?? refLabelForGroup(session, session.groups[gi]));
  }
  return {
    id: `${sessionId}_g${gi}_p${ii}`, url, planningStatus: "not_added",
    title: "", description: "", altText: "", destinationUrl: "", plannedDate: "", plannedTime: "", plannedAt: "",
    metadataTouched: EMPTY_TOUCHED,
    setupSnapshot: null,
    generationSetup: null,
    batchId: sessionId,
    requestId: `${sessionId}_g${gi}_p${ii}`,
    createdAt: new Date().toISOString(),
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
// Values are MessageKeys — resolve with tr(TIER_LABEL_KEY[tier]) at render time.
const TIER_LABEL_KEY = { best_bet: "studio.tier.bestBet", steady: "studio.tier.steady", competitive: "studio.tier.competitive" } as const;
const TREND_COLOR: Record<string, string> = { rising: "#10B981", evergreen: "#3B82F6", seasonal: "#F59E0B" };

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
  errorType?:          GenerationErrorType;
  errorMessage?:       string;
  retrying?:           boolean;
  outputIndex?:        number;
  // ── Live Weekly Plan reconciliation (the real plan source of truth) ──────────
  planState?:          CardWorkflowState;
  planDate?:           string;
  planTime?:           string;
  planDraftId?:        string;
  planMatchReason?:    StudioPlanMatchReason;
};

type FeedItem = { entry: MasonryPinEntry; session: GenerationSession };

type PromptSnapshot = {
  user_raw_text?: string;
  final_prompt?: string;
  prompt_mode?: string;
  prompt_version?: string;
  creative_direction_meta?: CreativeDirectionSnapshotV2;
  enhancer_failed?: boolean;
  detected_category?: string;
  effective_category?: string;
  category_passed?: string;
  inferred_category?: string;
  output_type?: string;
  product_image_count?: number;
  reference_image_count?: number;
  provider_endpoint?: string;
  image_ordering?: Array<{ position: number; role: "product" | "reference" }>;
  products_loaded?: number;
  references_loaded?: number;
  home_decor_check?: Record<string, boolean>;
  fashion_safety_applied?: boolean;
  plan?: {
    summary_for_ui?: {
      scene?: string;
      style?: string;
      layout?: string;
      products?: string;
    };
  };
};

function categoryAuditFromSnapshot(snap: PromptSnapshot, frontendCategory: string): CategoryAudit {
  const detected  = String(snap.detected_category  ?? "");
  const effective = String(snap.effective_category  ?? "");
  const inferred  = String(snap.inferred_category   ?? "");
  const src: CategoryAudit["categorySource"] =
    frontendCategory && !["", "generic"].includes(frontendCategory) ? "frontend"
    : detected  ? "vlm_plan"
    : inferred  ? "generator_inference"
    : "fallback";
  const hdCheck = snap.home_decor_check ?? {};
  return {
    frontendCategory,
    detectedCategory:    detected,
    effectiveCategory:   effective,
    inferredCategory:    inferred,
    outputType:          String(snap.output_type ?? ""),
    productImageCount:   Number(snap.product_image_count  ?? 0),
    referenceImageCount: Number(snap.reference_image_count ?? 0),
    finalPrompt:         String(snap.final_prompt ?? ""),
    homeDriftTerms:      Object.entries(hdCheck).filter(([, v]) => v).map(([k]) => k),
    fashionSafetyApplied: Boolean(snap.fashion_safety_applied),
    enhancerFailed:      Boolean(snap.enhancer_failed),
    categorySource:      src,
  };
}

type GenerateApiResult = {
  urls?: string[];
  error?: string;
  error_type?: GenerationErrorType;
  prompt_snapshot?: PromptSnapshot;
  requested_image_count?: number;
  actual_image_count?: number;
  count_clamped?: boolean;
  generation_request_id?: string;
};

type GenerateRecoveryInput = {
  keyword: string;
  category: string;
  prompt: string;
  count: number;
  styleRef: string | null;
  productImages: string[];
  // Prompt-enhancer extras (optional — defaults applied in route.ts / generator.py)
  textOverlay?: boolean;
  referenceStrength?: string;
  outputType?: string;
  pinFormat?: string;
  productMetadata?: Array<{ title?: string; productUrl?: string }>;
  modelKey?: string;
  contentLanguage?: LanguageCode;
  promptMode?: "legacy" | "creative_direction_v2";
  promptVersion?: 1 | 2;
  creativeDirectionMeta?: CreativeDirectionSnapshotV2;
  selectedTags?: Array<{ id: string; label: string; group: TagGroup }>;
  primaryFormatTag?: string;
  directionBrief?: string;
  briefManuallyEdited?: boolean;
  inferredCategory?: string;
  selectedOpportunity?: Opportunity | null;
  productImageCountRequested?: number;
  referenceImageCountRequested?: number;
  outputCount?: number;
  variationMode?: "distinct" | "similar";
  outputVariants?: OutputVariant[];
  generationRequestId?: string;
  studioClientId?: string;
  retrySingleOutput?: boolean;
  retryOfOutputId?: string;
  retryOutputIndex?: number;
};

type GenerateRecoveryResult = {
  urls: string[];
  error?: string;
  errorType?: GenerationErrorType;
  usedFallback: boolean;
  promptSnapshot?: PromptSnapshot;
  countClamped?: boolean;
  actualImageCount?: number;
};

function getStudioClientId(): string {
  const key = "vbp:studio:client_id";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = `studio_client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, id);
    return id;
  } catch {
    return `studio_client_memory_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function inferOutputType(category: string | undefined): string {
  const cat = (category ?? "").toLowerCase().trim();
  if (["fashion", "womens-fashion", "mens-fashion", "kids-fashion"].includes(cat)) return "editorial";
  if (cat === "beauty") return "beauty-lifestyle";
  if (cat === "food-and-drink") return "food-lifestyle";
  if (cat === "digital-products") return "digital-mockup";
  if (cat === "diy-crafts") return "tutorial";
  if (cat === "travel") return "lifestyle";
  if (cat === "home-decor") return "lifestyle";
  return "";
}

async function requestGenerate(input: GenerateRecoveryInput, count: number, styleRef: string | null, promptOverride?: string): Promise<GenerateApiResult> {
  const contentLang = input.contentLanguage ?? readResolvedContentLanguage();
  const basePrompt = promptOverride ?? input.prompt;
  const resp = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keyword:  input.keyword,
      style:    "editorial",
      count,
      prompt:   basePrompt,
      category: input.category,
      content_language: contentLang,
      prompt_mode: input.promptMode ?? "legacy",
      prompt_version: input.promptVersion ?? 1,
      ...(input.creativeDirectionMeta ? { creative_direction_meta: input.creativeDirectionMeta } : {}),
      ...(input.selectedTags ? { selectedTags: input.selectedTags } : {}),
      ...(input.primaryFormatTag !== undefined ? { primaryFormatTag: input.primaryFormatTag } : {}),
      ...(input.directionBrief !== undefined ? { directionBrief: input.directionBrief } : {}),
      ...(input.briefManuallyEdited !== undefined ? { briefManuallyEdited: input.briefManuallyEdited } : {}),
      ...(input.inferredCategory !== undefined ? { inferredCategory: input.inferredCategory } : {}),
      ...(input.selectedOpportunity !== undefined ? { selectedOpportunity: input.selectedOpportunity } : {}),
      ...(input.productImageCountRequested !== undefined ? { productImageCountRequested: input.productImageCountRequested } : {}),
      ...(input.referenceImageCountRequested !== undefined ? { referenceImageCountRequested: input.referenceImageCountRequested } : {}),
      ...(input.outputCount !== undefined ? { outputCount: input.outputCount } : {}),
      ...(input.variationMode ? { variationMode: input.variationMode } : {}),
      ...(input.outputVariants ? { outputVariants: input.outputVariants } : {}),
      ...(input.generationRequestId ? { generationRequestId: input.generationRequestId } : {}),
      ...(input.studioClientId ? { studioClientId: input.studioClientId } : {}),
      ...(input.retrySingleOutput ? { mode: "retry_single_output", retryOfOutputId: input.retryOfOutputId, retryOutputIndex: input.retryOutputIndex } : {}),
      ...(styleRef                    ? { style_ref:           styleRef                   } : {}),
      ...(input.productImages.length  ? { product_images:      input.productImages        } : {}),
      // Prompt-enhancer fields
      text_overlay:        input.textOverlay       ?? false,
      reference_strength:  input.referenceStrength ?? "moderate",
      output_type:         input.outputType        ?? "",
      format:              input.pinFormat          ?? "2:3",
      model_key:           input.modelKey           ?? "gemini_image",
      ...(input.productMetadata?.length ? { product_metadata: input.productMetadata } : {}),
    }),
  });
  return await resp.json() as GenerateApiResult;
}

// Hard errors that won't resolve by retrying — stop immediately.
const HARD_STOP_ERRORS: GenerationErrorType[] = ["api_auth_error", "safety_blocked", "api_payload_error", "provider_busy", "user_generation_limit", "configuration_error"];

async function generateWithRecovery(input: GenerateRecoveryInput): Promise<GenerateRecoveryResult> {
  const urls: string[] = [];
  let lastError: string | undefined;
  let lastErrorType: GenerationErrorType | undefined;
  let firstSnapshot: PromptSnapshot | undefined;
  let targetCount = input.count;
  let countClamped = false;
  let actualImageCount: number | undefined;

  // The backend generates ALL `count` variations in parallel inside ONE call, so we
  // request the full remaining count each round rather than one image at a time.
  // The previous one-at-a-time loop made N slow sequential calls; if the 2nd call
  // transiently failed (timeout / 5xx) a 2-image batch ended up with only 1 image
  // and a false "failed" state — even though the image had usually already uploaded
  // (hence it reappeared on refresh). Requesting the batch in one call fixes that
  // and is faster; we still round-retry to top up any genuine shortfall.
  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS && urls.length < targetCount; round++) {
    const need = targetCount - urls.length;
    const data = await requestGenerate(input, need, input.styleRef);
    if (data.count_clamped && data.actual_image_count) {
      countClamped = true;
      actualImageCount = data.actual_image_count;
      targetCount = Math.min(targetCount, data.actual_image_count);
    }
    if (!firstSnapshot && data.prompt_snapshot) firstSnapshot = data.prompt_snapshot;
    if (data.urls?.length) {
      for (const u of data.urls) {
        if (u && !urls.includes(u) && urls.length < targetCount) urls.push(u);
      }
    }
    if (urls.length >= targetCount) break;
    lastError     = data.error      ?? lastError;
    lastErrorType = data.error_type ?? lastErrorType;
    if (data.error_type && HARD_STOP_ERRORS.includes(data.error_type)) break;
  }

  // Clear the carried error once we ultimately got everything we asked for.
  const complete = urls.length >= targetCount;
  return {
    urls,
    error: complete ? undefined : lastError,
    errorType: complete ? undefined : lastErrorType,
    usedFallback: false,
    promptSnapshot: firstSnapshot,
    countClamped,
    actualImageCount,
  };
}

// Maps a raw generation error (type + upstream message) to safe, user-facing copy.
// The raw provider JSON (e.g. "Invalid value at contents[0].parts[4].inline_data.data")
// is NEVER returned here — it stays in dev/server logs only.
// NOTE: this is a plain (non-component) helper function, so it cannot call the
// useLocale() hook. It is called from component render paths that already have
// `tr` in scope; those callers pass `tr` through so this stays translated.
function getReadableGenerationError(
  errorType: GenerationErrorType | undefined,
  rawMessage: string | undefined,
  tr: (key: import("@/lib/i18n/messages/en").MessageKey) => string,
): { title: string; body: string } {
  const raw = (rawMessage ?? "").toLowerCase();
  const looksLikeImage =
    errorType === "image_load_failed" ||
    /base64|inline_data|inline data|input image|decoding failed|parts\[\d+\]/.test(raw);
  if (looksLikeImage) {
    return {
      title: tr("studio.error.imageProcessFailed.title"),
      body: tr("studio.error.imageProcessFailed.body"),
    };
  }
  switch (errorType) {
    case "provider_busy":
      return { title: tr("studio.error.generationBusy.title"), body: tr("studio.error.generationBusy.body") };
    case "user_generation_limit":
      return { title: tr("studio.error.generationAlreadyRunning.title"), body: tr("studio.error.generationAlreadyRunning.body") };
    case "configuration_error":
      return { title: tr("studio.error.misconfigured.title"), body: tr("studio.error.misconfigured.body") };
    case "safety_blocked":
      return { title: tr("studio.error.safetyBlocked.title"), body: tr("studio.error.safetyBlocked.body") };
    case "rate_limited":
      return { title: tr("studio.error.serviceBusy.title"), body: tr("studio.error.serviceBusy.body") };
    case "api_auth_error":
      return { title: tr("studio.error.serviceUnavailable.title"), body: tr("studio.error.serviceUnavailable.body") };
    default:
      return { title: tr("studio.error.generateFailed.title"), body: tr("studio.error.generateFailed.body") };
  }
}

// Toast helper: maps an error_type to the P0 user-facing copy (never raw provider JSON).
function toastGenerationError(
  errorType: GenerationErrorType | undefined,
  rawMessage: string | undefined,
  tr: (key: import("@/lib/i18n/messages/en").MessageKey) => string,
): void {
  const { title, body } = getReadableGenerationError(errorType, rawMessage, tr);
  if (errorType === "user_generation_limit" || errorType === "provider_busy") toast.message(title, { description: body });
  else toast.error(title, { description: body });
}

function formatPinDate(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatShortDate(iso: string): string {
  if (!iso?.trim()) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type CardWorkflowState = "not_planned" | "needs_date" | "scheduled" | "posted";

function getCardWorkflowState(pin: StudioPin | null | undefined): CardWorkflowState {
  if (!pin || pin.planningStatus === "not_added") return "not_planned";
  if (pin.planningStatus === "posted" || pin.planningStatus === "skipped") return "posted";
  if (pin.plannedDate?.trim()) return "scheduled";
  return "needs_date";
}

function refLabelForGroup(session: GenerationSession, group: RefGroup): string {
  if (group.refUrl) return `Reference ${group.refIndex + 1}`;
  return session.productCount > 0 ? "Product" : "No product";
}

function collectSessionPins(session: GenerationSession, planDrafts: PinDraft[] = []): MasonryPinEntry[] {
  const entries: MasonryPinEntry[] = [];
  session.groups.forEach((group, gi) => {
    const refLabel = refLabelForGroup(session, group);
    group.items.forEach((pin, pi) => {
      // Reconcile against the live Weekly Plan draft (the source of truth). When a
      // matching draft exists, plan state + dates come from it; otherwise fall back
      // to the in-memory pin's own state.
      const { draft, reason } = findDraftForStudioOutput({ id: pin.id, url: pin.url }, planDrafts);
      const planState: CardWorkflowState = draft ? deriveCardStatusFromDraft(draft) : getCardWorkflowState(pin);
      const inPlan = planState !== "not_planned";
      entries.push({
        key:       pin.id,
        sessionId: session.id,
        groupIdx:  gi,
        pinIdx:      pi,
        pin,
        status:    inPlan ? "added" : "completed",
        refLabel,
        createdAt: session.savedAt,
        planState,
        planDate:  draft?.scheduledDate ?? pin.plannedDate ?? "",
        planTime:  draft?.scheduledTime ?? pin.plannedTime ?? "",
        planDraftId: draft?.id,
        planMatchReason: reason,
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
          retrying: group.retrying,
        });
      }
    }

    // Each missing/failed slot gets a STABLE outputIndex (= its position after the
    // completed items). A slot that is currently retrying renders as "retrying" — this
    // is per-slot, so a completed sibling never flips to generating.
    const retryingSlots = group.retryingSlots ?? [];
    const pushFailedSlot = (outputIndex: number, keySuffix: string) => {
      const err = session.groupErrors?.[gi];
      const isRetrying = retryingSlots.includes(outputIndex);
      entries.push({
        key: `${session.id}-${gi}-${keySuffix}`,
        sessionId: session.id,
        groupIdx: gi,
        outputIndex,
        status: isRetrying ? "generating" : "failed",
        refLabel,
        createdAt: session.savedAt,
        placeholderVariant: isRetrying ? "generating" : "failed",
        retrying: isRetrying,
        errorType: isRetrying ? undefined : err?.errorType,
        errorMessage: isRetrying ? undefined : err?.message,
      });
    };

    if (group.status === "failed" && group.items.length === 0) {
      for (let i = 0; i < group.expectedCount; i++) pushFailedSlot(i, `fail-${i}`);
    }

    const missing = Math.max(0, group.expectedCount - group.items.length);
    if ((group.status === "failed" || group.status === "partial") && group.items.length > 0 && missing > 0) {
      for (let i = 0; i < missing; i++) pushFailedSlot(group.items.length + i, `fail-partial-${i}`);
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

function flattenFeedItems(sessions: GenerationSession[], filter: FeedFilter, planDrafts: PinDraft[] = []): FeedItem[] {
  const sorted = [...sessions].sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
  const items: FeedItem[] = [];
  for (const session of sorted) {
    for (const entry of filterMasonryPins(collectSessionPins(session, planDrafts), filter)) {
      items.push({ entry, session });
    }
  }
  return items;
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
    groups:             entry.groups.map((g, gi) => {
      const grpImagesPerRef = entry.imagesPerRef ?? 0;
      const grpStatus: RefGroup["status"] = g.images.length === 0
        ? (sessionStatus === "generating" || sessionStatus === "queued" ? "generating" : "failed")
        : (grpImagesPerRef > 0 && g.images.length < grpImagesPerRef ? "partial" : "done");
      return {
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
        status:        grpStatus,
        expectedCount: entry.imagesPerRef ?? Math.max(g.images.length, 1),
      };
    }),
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
    // Real generation metadata — never a hardcoded model. Falls back through the
    // snapshot's modelKey to the MVP default; the stale legacy label is ignored.
    model:              resolveModelLabel(entry.setupSnapshot?.model, entry.setupSnapshot?.modelKey),
    format:             entry.setupSnapshot?.format ?? "2:3",
    textOverlay:        entry.setupSnapshot?.noTextOverlay === false ? "On" : "Off",
    groupErrors:        Object.keys(groupErrors).length > 0 ? groupErrors : undefined,
    categoryAudit:      entry.categoryAudit,
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
      "No text overlay. No typography. No watermark.",
    ].join("\n\n");
  }
  if (kw) {
    return [
      `Create a Pinterest-native ${style} Pin for "${kw}".`,
      refGuide,
      `Create ${baseScene}.`,
      "No text overlay. No typography. No watermark.",
    ].join("\n\n");
  }
  return "";
}

// ── Model options ─────────────────────────────────────────────────────────────

const MODEL_OPTIONS = [
  { value: "gpt_image",    label: "GPT Image"    },
  { value: "gemini_image", label: "Gemini Image" },
] as const;
const SHOW_GENERATION_DEBUG = process.env.NEXT_PUBLIC_STUDIO_DEBUG_GENERATION === "true";

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
  const { t: tr }   = useLocale();
  const isProduct   = role === "product";
  const testSection = isProduct ? "products-asset-section" : "refs-asset-section";
  const testAddBtn  = isProduct ? "add-product-images" : "add-pin-references";
  const testSelected = isProduct ? "selected-products" : "selected-refs";
  const title    = isProduct ? tr("page.studio.products") : tr("page.studio.references");
  const helper   = isProduct
    ? tr("page.studio.productsHelper")
    : tr("page.studio.referencesHelper");
  const addLabel = isProduct ? tr("page.studio.addProductImages") : tr("page.studio.addPinReferences");
  const selectedItems: SelectedAssetPreviewItem[] = selectedUrls.map(url => {
    const asset = assetStore.getAssets().find(a => a.imageUrl === url && a.role === role);
    return {
      imageUrl: url,
      title: asset?.title,
      source: asset?.source,
      sourceDomain: asset?.sourceDomain || asset?.store,
    };
  });

  return (
    <div
      data-testid={testSection}
                  style={{
        flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
        padding: "7px 8px 6px", borderRadius: 8,
        border: `1.5px dashed ${D.borderStr}`, background: D.cardElev,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: D.text }}>{title}</span>
        <span data-testid={`${testSection}-count`} style={{ fontSize: "10px", fontWeight: 600, color: D.textSec }}>
          ({selectedUrls.length})
        </span>
                  </div>
      <p style={{ margin: "0 0 5px", fontSize: "9.5px", lineHeight: 1.35, color: D.textMuted }}>{helper}</p>

      {selectedUrls.length > 0 && (
        <div data-testid={testSelected} style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
            {selectedItems.map((item, i) => (
            <div key={`${item.imageUrl}-${i}`} style={{ position: "relative", flexShrink: 0, width: 42, height: 42 }}>
              <SelectedAssetPreview
                item={item}
                items={selectedItems}
                index={i}
                kind={isProduct ? "product" : "reference"}
                thumbnailSize={42}
                testId={isProduct ? "selected-product-thumbnail" : "selected-reference-thumbnail"}
              />
                <button
                  type="button"
                  aria-label={(isProduct ? tr("studio.asset.removeProduct") : tr("studio.asset.removeReference")).replace("{n}", String(i + 1))}
                  onClick={(e) => { e.stopPropagation(); onToggleUrl(item.imageUrl); }}
                  style={{
                  position: "absolute", top: -4, right: -4, width: 16, height: 16, borderRadius: "50%",
                  background: "rgba(0,0,0,0.75)", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2,
                }}
              >
                <X style={{ width: 9, height: 9, color: "#fff" }} />
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
          width: "100%", padding: "5px 8px", borderRadius: 6,
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

function OpportunityDrawer({ open, inferredCategory, onClose, onSelect }: {
  open: boolean; inferredCategory?: string; onClose: () => void; onSelect: (o: Opportunity) => void;
}) {
  const { t: tr } = useLocale();
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
  // Searching hits ALL opportunities; the default recommended list is filtered to
  // the inferred category (fashion upload → only fashion/outfit/style, never Nails).
  const contextMatched = (tab === "recommended" && inferredCategory)
    ? (rankOpportunities(baseRows, inferredCategory) as OppRow[])
    : baseRows;
  const filtered = q.trim()
    ? baseRows.filter(o => o.keyword.toLowerCase().includes(q.toLowerCase()) || o.category.toLowerCase().includes(q.toLowerCase()))
    : contextMatched;
  const showContextEmpty = !q.trim() && tab === "recommended" && !!inferredCategory && !loading && contextMatched.length === 0 && baseRows.length > 0;

  if (!open) return null;

  const tabs: { id: OppDrawerTab; label: string }[] = [
    { id: "recommended", label: tr("studio.oppDrawer.tabRecommended") },
    { id: "recent",      label: tr("studio.oppDrawer.tabRecent") },
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
              <p style={{ margin: "0 0 2px", fontSize: "16px", fontWeight: 800, color: D.text }}>{tr("studio.oppDrawer.title")}</p>
              <p style={{ margin: 0, fontSize: "12px", color: D.textSec }}>{tr("studio.oppDrawer.subtitle")}</p>
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
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr("studio.oppDrawer.searchPlaceholder")}
              style={{ width: "100%", boxSizing: "border-box", paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 8, border: `1px solid ${D.border}`, fontSize: "12px", color: D.text, outline: "none", background: D.cardElev }} />
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
          {tab === "recent" && recentOpps.length === 0 ? (
            <p style={{ textAlign: "center", padding: "30px 0", fontSize: "13px", color: D.textSec }}>{tr("studio.oppDrawer.noRecent")}</p>
          ) : (loading && tab !== "recent") ? (
            [1,2,3,4,5].map(i => <div key={i} style={{ height: 78, borderRadius: 10, background: D.cardElev, marginBottom: 6, animation: "pulse 1.5s ease-in-out infinite" }} />)
          ) : showContextEmpty ? (
            <p style={{ textAlign: "center", padding: "30px 16px", fontSize: "12px", lineHeight: 1.55, color: D.textSec }}>
              {tr("studio.oppDrawer.noContextMatch")}
            </p>
          ) : filtered.length === 0 ? (
            <p style={{ textAlign: "center", padding: "30px 0", fontSize: "13px", color: D.textSec }}>{tr("studio.oppDrawer.noResults")}</p>
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
                    <span style={{ fontSize: "9px", fontWeight: 700, color: tc, background: `${tc}20`, padding: "2px 7px", borderRadius: 20 }}>{tr(TIER_LABEL_KEY[tier as keyof typeof TIER_LABEL_KEY])}</span>
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
  onAddToPlan, onAddAllToPlan, onRegeneratePin, onRegenerateGroup, onRetryOutput, onEditInputs,
  pinDetailOpen, pinDetailInitialTab, pinDetail, metadataForm, pinDetailsGenStatus, readinessLabel, isDirty, showSaved,
  onOpenPinDetail, onClosePinDetail, onRetryGenerateDetails,
  onMetadataChange, onSelectTitleCandidate, onRegenerateTitles, onRegenerateDescription, onSavePinMetadata,
  onPinDetailAddToPlan, onPinDetailRegenerate, onPinDetailSaveAsReference,
  onPinDetailRetryPin, onPinDetailRetryGroup, onPinDetailReuseSetup, onPinDetailViewSetup,
  onPinDetailRegenerateWithRemix,
  canViewDebug,
  selectedPinKeys, onTogglePinSelect, onClearSelection, onOpenBatchEdit, onBatchGenerateMetadata, onAddSelectedToPlan,
  batchEditOpen, batchPins, onCloseBatchEdit, onBatchApply, onBatchGenerateFromDrawer,
  onBatchScheduleSelected, onBatchPublishComplete,
  planDrafts,
}: {
  sessions:            GenerationSession[];
  filter:              FeedFilter;
  planDrafts:          PinDraft[];
  onFilterChange:      (f: FeedFilter) => void;
  onAddToPlan:         (sessionId: string, gi: number, pi: number) => void;
  onAddAllToPlan:      (sessionId: string) => void;
  onRegeneratePin:     (sessionId: string, gi: number, pi: number) => void;
  onRegenerateGroup:   (sessionId: string, gi: number) => void;
  onRetryOutput:       (sessionId: string, gi: number, outputIndex: number) => void;
  onEditInputs:        (sessionId: string) => void;
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
  canViewDebug:         boolean;
  selectedPinKeys:     Set<string>;
  onTogglePinSelect:   (entryKey: string) => void;
  onClearSelection:    () => void;
  onOpenBatchEdit:     () => void;
  onBatchGenerateMetadata: () => void;
  onAddSelectedToPlan: () => void;
  batchEditOpen:       boolean;
  batchPins:           BatchPinRow[];
  onCloseBatchEdit:    () => void;
  onBatchApply:        (opts: BatchApplyOpts) => void;
  onBatchGenerateFromDrawer: (overwriteEdited: boolean) => void;
  onBatchScheduleSelected: (pinIds: string[]) => void;
  onBatchPublishComplete: (pinIds: string[]) => void;
}) {
  const { t: tr } = useLocale();
  const tabs: { id: FeedFilter; label: string }[] = [
    { id: "all",        label: tr("page.studio.filterAll") },
    { id: "generating", label: tr("page.studio.filterGenerating") },
    { id: "completed",  label: tr("page.studio.filterCompleted") },
    { id: "failed",     label: tr("page.studio.filterFailed") },
    { id: "added",      label: tr("page.studio.filterAdded") },
  ];
  const feedItems = flattenFeedItems(sessions, filter, planDrafts);
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
            <span style={{ fontSize: 11, fontWeight: 700, color: D.text }}>{tr("studio.batch.selectedCount").replace("{n}", String(selectedPinKeys.size))}</span>
            <button type="button" data-testid="generate-pin-details-button" onClick={onBatchGenerateMetadata} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${D.border}`, background: "none", color: D.textSec, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{tr("studio.batch.generatePinDetails")}</button>
            <button type="button" data-testid="batch-edit-details-button" onClick={onOpenBatchEdit} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${D.border}`, background: "none", color: D.textSec, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{tr("studio.batch.editDetails")}</button>
            <button type="button" data-testid="batch-add-selected" onClick={onAddSelectedToPlan} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: D.gradient, color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{tr("studio.batch.addSelectedToPlan")}</button>
            <button type="button" data-testid="batch-clear-selection" onClick={onClearSelection} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${D.border}`, background: "none", color: D.textMuted, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>{tr("studio.batch.clearSelection")}</button>
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
              {tr("page.studio.emptyTitle")}
            </p>
            <p style={{ margin: "0 0 20px", fontSize: "13px", color: D.textSec, lineHeight: 1.6, maxWidth: 360 }}>
              {tr("page.studio.emptySub")}
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
              <Play style={{ width: 12, height: 12 }} /> {tr("page.studio.howItWorks")}
            </button>
              </div>
        ) : !hasPins ? (
          <div style={{ padding: "48px 20px", textAlign: "center" }}>
            <p style={{ margin: 0, fontSize: "13px", color: D.textSec }}>{tr("studio.feed.noGenerationsInTab")}</p>
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
                onOpenDetails={() => onOpenPinDetail(session.id, entry.key, "plan")}
                onAddToPlan={(e) => {
                  e.stopPropagation();
                  if (entry.status === "failed" || entry.status === "generating") return;
                  if (entry.pinIdx !== undefined) onAddToPlan(session.id, entry.groupIdx, entry.pinIdx);
                }}
                onView={(e) => {
                  e.stopPropagation();
                  onOpenPinDetail(session.id, entry.key, "plan");
                }}
                onViewPlan={(e) => {
                  e.stopPropagation();
                  window.location.assign("/app/plan");
                }}
                onViewPin={(e) => {
                  e.stopPropagation();
                  const url = entry.pin?.url;
                  if (url) window.open(url, "_blank", "noopener,noreferrer");
                  else onOpenPinDetail(session.id, entry.key, "plan");
                }}
                onRemix={(e) => {
                  e.stopPropagation();
                  onOpenPinDetail(session.id, entry.key, "remix");
                }}
                onRegenerate={(e) => {
                  e.stopPropagation();
                  // Failed outputs have no Pin to remix — regenerate = retry that output.
                  if (entry.status === "failed") { onRetryOutput(session.id, entry.groupIdx, entry.outputIndex ?? entry.pinIdx ?? 0); return; }
                  onOpenPinDetail(session.id, entry.key, "remix");
                }}
                onDiagnostics={canViewDebug ? (e) => { e.stopPropagation(); onOpenPinDetail(session.id, entry.key, "debug"); } : undefined}
                onRetry={entry.status === "failed" ? (e) => { e.stopPropagation(); onRetryOutput(session.id, entry.groupIdx, entry.outputIndex ?? entry.pinIdx ?? 0); } : undefined}
                onEditInputs={entry.status === "failed" ? (e) => { e.stopPropagation(); onEditInputs(session.id); } : undefined}
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
        canViewDebug={canViewDebug}
      />
      <BatchEditDrawer
        open={batchEditOpen}
        pins={batchPins}
        onClose={onCloseBatchEdit}
        onApply={onBatchApply}
        onGenerateMetadata={onBatchGenerateFromDrawer}
        onScheduleSelected={onBatchScheduleSelected}
        onPublishComplete={onBatchPublishComplete}
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
  // onAddToPlan / onRemix / onAddAllToPlan / onRegenerateSet / onDiagnostics remain on
  // the prop contract (callers still pass them) but are no longer surfaced on the card —
  // all actions now flow through the shared PinCardActions component.
  entry, session, isSelected, onToggleSelect, onOpenDetails, onView, onViewPlan, onViewPin, onRegenerate, onRetry, onEditInputs,
}: {
  entry: MasonryPinEntry;
  session: GenerationSession;
  isSelected: boolean;
  onToggleSelect: (e: React.MouseEvent) => void;
  onOpenDetails: () => void;
  onAddToPlan: (e: React.MouseEvent) => void;
  onView: (e: React.MouseEvent) => void;
  onViewPlan: (e: React.MouseEvent) => void;
  onViewPin: (e: React.MouseEvent) => void;
  onRemix: (e: React.MouseEvent) => void;
  onRegenerate?: (e: React.MouseEvent) => void;
  onRetry?: (e: React.MouseEvent) => void;
  onEditInputs?: (e: React.MouseEvent) => void;
  onDiagnostics?: (e: React.MouseEvent) => void;
  onAddAllToPlan: () => void;
  onRegenerateSet: () => void;
}) {
  const { t: tr } = useLocale();
  const [hover, setHover] = useState(false);
  const isPlaceholder = entry.status === "generating" || entry.status === "failed";
  const variant = entry.placeholderVariant ?? (entry.status === "failed" ? "failed" : "generating");
  const pin = entry.pin;
  const dlName = pin ? `vibepin-${session.id.slice(-8)}-${pin.id.slice(-6)}.png` : "";

  // ── Workflow state (plan + publish) ────────────────────────────────────────
  // Prefer the live plan state reconciled against the Weekly Plan draft store
  // (entry.planState); fall back to the in-memory pin only when no reconciliation ran.
  const workflowState: CardWorkflowState | null = isPlaceholder
    ? null
    : (entry.planState ?? getCardWorkflowState(pin));
  // Date for the "Scheduled <date>" badge comes from the matched draft when present.
  const resolvedPlanDate = entry.planDate?.trim() || pin?.plannedDate || "";

  // ── Normalized card status ─────────────────────────────────────────────────
  // The ONLY status model the UI shows: Unscheduled / Scheduled / Failed / Posted /
  // Generating. There is no "needs details" / "not planned" state — a pin in the
  // plan is Scheduled (the shared modal resolves any missing date/fields); an
  // un-added generated pin is Unscheduled (generated but not yet scheduled).
  const cardStatus: PinCardStatus = isPlaceholder
    ? (variant === "failed" ? "failed" : "generating")
    : workflowState === "posted" ? "posted"
    : (workflowState === "scheduled" || workflowState === "needs_date") ? "scheduled"
    : "unscheduled";

  // ── Badge (left-top) ───────────────────────────────────────────────────────
  const badgeLabel =
      cardStatus === "failed"     ? tr("studio.badge.failed")
    : cardStatus === "generating" ? (variant === "queued" ? tr("studio.badge.queued") : tr("studio.badge.generating"))
    : cardStatus === "posted"     ? tr("studio.badge.posted")
    : cardStatus === "scheduled"  ? (resolvedPlanDate ? tr("studio.badge.scheduledOn").replace("{date}", formatShortDate(resolvedPlanDate)) : tr("studio.badge.scheduled"))
    : tr("studio.badge.unscheduled");

  const badgeColor =
      cardStatus === "failed"     ? D.error
    : cardStatus === "generating" ? (variant === "queued" ? D.textMuted : D.purple)
    : cardStatus === "posted"     ? D.success
    : cardStatus === "scheduled"  ? "#60A5FA"
    : "#34D399"; // unscheduled — positive emerald

  const badgeIcon = (() => {
    if (cardStatus === "generating") {
      if (variant === "queued") return <Clock style={{ width: 9, height: 9, color: D.textMuted }} />;
      return <div style={{ width: 8, height: 8, border: `1.5px solid ${D.purple}40`, borderTopColor: D.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />;
    }
    if (cardStatus === "failed")    return <AlertCircle style={{ width: 9, height: 9, color: D.error }} />;
    if (cardStatus === "posted")    return <CheckCircle2 style={{ width: 9, height: 9, color: D.success }} />;
    if (cardStatus === "scheduled") return <Calendar style={{ width: 9, height: 9, color: "#60A5FA" }} />;
    return <Sparkles style={{ width: 9, height: 9, color: "#34D399" }} />; // unscheduled
  })();

  // ── Output position + batch context ───────────────────────────────────────
  const globalPinIdx = entry.pinIdx !== undefined
    ? session.groups.slice(0, entry.groupIdx).reduce((sum, g) => sum + g.items.length, 0) + entry.pinIdx + 1
    : null;
  const productCount = session.setupSnapshot?.selectedProducts?.length ?? session.productCount ?? 0;
  const refCount = session.setupSnapshot?.selectedReferences?.length ?? session.refCount ?? 0;
  const batchMeta = [
    productCount > 0 ? tr("studio.count.products").replace("{n}", String(productCount)) : null,
    refCount > 0 ? tr("studio.count.refs").replace("{n}", String(refCount)) : null,
  ].filter(Boolean).join(" · ");

  // ── Footer second line (workflow-aware) ───────────────────────────────────
  const catLabel = session.category
    ? session.category.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "";
  const footerLine2 = (() => {
    if (isPlaceholder || !pin) return `${batchMeta ? `${batchMeta} · ` : ""}${session.format ?? "2:3"}`;
    if (cardStatus === "posted") {
      const d = pin.plannedDate?.trim() ? tr("studio.footer.postedOn").replace("{date}", formatShortDate(pin.plannedDate)) : tr("studio.badge.posted");
      return `${d} · Pinterest`;
    }
    if (cardStatus === "scheduled") {
      const d = formatShortDate(pin.plannedDate);
      return d ? `${tr("studio.footer.scheduledOn").replace("{date}", d)}${catLabel ? ` · ${catLabel}` : ""}` : (catLabel || tr("studio.badge.scheduled"));
    }
    // unscheduled — show generation context
    const modelLabel = session.model ?? "";
    return `${batchMeta ? `${batchMeta} · ` : ""}${session.format ?? "2:3"}${modelLabel ? ` · ${modelLabel}` : ""}`;
  })();

  // Field-level readiness (missing product / destination URL) is deliberately
  // NOT surfaced on the card image. Product is optional and a missing URL never
  // blocks scheduling — those details live in Pin Details / Batch Edit / Publish
  // readiness, not as noisy public card text.

  // Card action buttons (labels + layout) live in the shared PinCardActions component.

  const placeholderCfg = {
    generating: { bg: "linear-gradient(145deg, rgba(124,58,237,0.16), rgba(11,16,32,0.98))", color: D.purple, text: tr("studio.placeholder.stillGenerating") },
    queued:     { bg: "linear-gradient(145deg, rgba(74,85,104,0.22), rgba(11,16,32,0.98))", color: D.textMuted, text: tr("studio.badge.queued") },
    failed:     { bg: "linear-gradient(145deg, rgba(239,68,68,0.2), rgba(11,16,32,0.98))", color: D.error, text: tr("studio.placeholder.failedToGenerate") },
  }[variant];
  // Safe, human copy — never surfaces the raw upstream JSON to the user.
  const readableError = getReadableGenerationError(entry.errorType, entry.errorMessage, tr);

  // ── Dev/test-only plan-state diagnostics ───────────────────────────────────
  // Surfaces the matching internals so state mismatches between Create Pins and
  // Weekly Plan are inspectable. Absent from production UI; only data-* attributes
  // (invisible) and a small collapsible block render, and only when not production.
  const showDiag = isPlanDebugEnabled() && !isPlaceholder && !!pin;
  const diagAttrs: Record<string, string> = showDiag ? {
    "data-vp-pin-id":          pin!.id,
    "data-vp-session-id":      entry.sessionId,
    "data-vp-draft-id":        entry.planDraftId ?? "",
    "data-vp-match-reason":    entry.planMatchReason ?? "none",
    "data-vp-matched":         String(!!entry.planDraftId),
    "data-vp-planning-status": pin!.planningStatus,
    "data-vp-plan-state":      workflowState ?? "",
    "data-vp-card-status":     entry.status,
    "data-vp-planned-date":    resolvedPlanDate,
    "data-vp-planned-time":    entry.planTime ?? pin!.plannedTime ?? "",
    "data-vp-planned-at":      pin!.plannedAt ?? "",
  } : {};

  return (
    <article
      {...diagAttrs}
      data-testid={isPlaceholder ? "placeholder-card" : "generated-pin-card"}
      title={tr("studio.card.generatedSetTitle").replace("{id}", session.id.slice(-8))}
      onClick={onOpenDetails}
      onMouseEnter={() => setHover(true)}
      // Keep an open More menu open when the cursor leaves the card body — closing
      // it here made the three-dot menu impossible to reach. Outside-click (the
      // fixed overlay below) and Escape still dismiss it.
      onMouseLeave={() => setHover(false)}
        style={{
        position: "relative", borderRadius: 12, overflow: "hidden", cursor: "pointer",
        border: `1px solid ${hover ? "rgba(124,58,237,0.45)" : D.border}`,
        background: D.cardElev, minWidth: 0, width: "100%",
        boxShadow: hover ? "0 10px 24px rgba(0,0,0,0.32)" : "0 4px 14px rgba(0,0,0,0.18)",
        transition: "box-shadow 0.15s ease, border-color 0.15s ease",
      }}
    >
      <div style={{ position: "relative", width: "100%", aspectRatio: "2/3", background: "var(--app-surface-3, #0B1020)", overflow: "hidden" }}>
        {/* Dev/test-only plan-state diagnostics — collapsible, absent in production. */}
        {showDiag && (
          <details data-testid="pin-card-plan-debug" onClick={e => e.stopPropagation()}
            style={{ position: "absolute", top: 30, left: 8, zIndex: 4, maxWidth: "82%", background: "rgba(8,13,25,0.92)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 6, padding: "2px 6px", fontSize: 8.5, lineHeight: 1.45, color: "#9FB3C8", fontFamily: "monospace" }}>
            <summary style={{ cursor: "pointer", color: "#C4B5FD", fontWeight: 700 }}>plan debug</summary>
            <div>state: <b style={{ color: "#E2E8F0" }}>{workflowState}</b> · card: {entry.status}</div>
            <div>match: {entry.planMatchReason ?? "none"} · draft: {entry.planDraftId ? entry.planDraftId.slice(-8) : "—"}</div>
            <div>planningStatus: {pin!.planningStatus}</div>
            <div>date: {resolvedPlanDate || "—"} · time: {entry.planTime || pin!.plannedTime || "—"}</div>
            <div>plannedAt: {pin!.plannedAt || "—"}</div>
            <div>pinId: {pin!.id.slice(-12)}</div>
          </details>
        )}
        {/* Checkbox — only on hover or when selected (multi-select mode) */}
        {!isPlaceholder && pin && (hover || isSelected) && (
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

        {/* Image or placeholder */}
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
              {variant === "failed" ? readableError.title : (entry.retrying ? tr("studio.placeholder.retrying") : placeholderCfg.text)}
            </p>
            {/* User-facing copy only — the raw provider error stays in dev/server logs. */}
            {variant === "failed" && (
              <p style={{ margin: 0, maxWidth: "84%", fontSize: "9px", lineHeight: 1.4, color: "rgba(226,232,240,0.78)", textAlign: "center", position: "relative" }}>
                {readableError.body}
              </p>
            )}
                    </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={toProxyUrl(pin!.url)}
            alt={tr("studio.card.generatedPinAlt")}
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

        {/* Workflow status badge — top-left */}
        <span data-testid="pin-card-status-badge" style={{
          position: "absolute", top: 8, left: 8, display: "inline-flex", alignItems: "center", gap: 4,
          padding: "3px 7px", borderRadius: 999, fontSize: "9px", fontWeight: 800,
          color: "#EAFDF5", background: "rgba(8,13,25,0.78)", backdropFilter: "blur(8px)",
          border: `1px solid ${badgeColor}55`,
        }}>
          {badgeIcon}
          {badgeLabel}
                  </span>

        {/* Footer gradient overlay — meta + always-visible action area */}
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0,
          padding: (isPlaceholder && variant !== "failed") ? "8px" : "48px 8px 8px",
          background: "linear-gradient(180deg, transparent 0%, rgba(8,13,25,0.55) 38%, rgba(8,13,25,0.95) 100%)",
          display: "flex", flexDirection: "column", gap: 7,
        }}>
          <div>
            <p style={{ margin: "0 0 1px", fontSize: "10px", fontWeight: 700, color: "#F1F5F9" }}>
              {globalPinIdx !== null
                ? tr("studio.card.outputOfTotal").replace("{n}", String(globalPinIdx)).replace("{total}", String(session.expectedTotal))
                : (session.expectedTotal === 1
                    ? tr("studio.card.batchOfOne")
                    : tr("studio.card.batchOfTotal").replace("{total}", String(session.expectedTotal)))}
            </p>
            <p style={{ margin: 0, fontSize: "9px", fontWeight: 500, color: "rgba(226,232,240,0.72)" }}>
              {footerLine2}
            </p>
          </div>

          {/* Card actions — ONE shared, status-driven component for every Create Pins
              card. Labels and the More menu are derived only from cardStatus inside
              PinCardActions; nothing is hardcoded per card. Schedule / Edit / Details
              all open the shared edit/schedule modal where any missing fields are
              validated — there is no separate "needs details" card state. */}
          <PinCardActions
            status={cardStatus}
            onOpenModal={onView}
            onViewPlan={onViewPlan}
            onViewPin={onViewPin}
            onTryAgain={(e) => onRetry?.(e)}
            onEditPrompt={(e) => onEditInputs?.(e)}
            onRegenerate={(e) => onRegenerate?.(e)}
            onSaveReference={() => toast.success(tr("studio.toast.savedAsReference"))}
            downloadHref={pin ? toProxyUrl(pin.url) : ""}
            downloadName={dlName}
          />

        </div>
    </div>
    </article>
  );
}

// ── Main content ──────────────────────────────────────────────────────────────

function CreatePinsContent() {
  const searchParams = useSearchParams();
  const router       = useRouter();
  const { t: tr }    = useLocale();

  const [products,        setProducts]        = useState<string[]>([]);
  const [refs,            setRefs]            = useState<string[]>([]);
  const [prompt,          setPrompt]          = useState("");
  const [systemRecommendations, setSystemRecommendations] = useState<CreativeDirectionRecommendation[]>([]);
  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(null);
  const [guidedControls, setGuidedControls] = useState<GuidedControls>({});
  const [customInstructions, setCustomInstructions] = useState("");
  const [manualBrief, setManualBrief] = useState("");
  const [manualBriefEdited, setManualBriefEdited] = useState(false);
  // ── Lightweight creative controls (tags + auto-filled Direction brief) ──────
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [briefManuallyEdited, setBriefManuallyEdited] = useState(false);
  const [briefStaleFromTags, setBriefStaleFromTags] = useState(false);
  const [inputVersion, setInputVersion] = useState("init");
  const [lastBriefInputVersion, setLastBriefInputVersion] = useState("init");
  const [briefStale, setBriefStale] = useState(false);
  const [opportunityContext, setOpportunityContext] = useState<CreativeOpportunityContext>({ enabled: false, removable: true });
  const [lastPrefill, setLastPrefill] = useState<CreatePinsPrefill | null>(null);
  const [count,           setCount]           = useState(2);
  const [variationMode,   setVariationMode]   = useState<"distinct" | "similar">("distinct");
  const [format,          setFormat]          = useState("2:3");
  // Create Pins MVP default provider is Gemini Image. GPT Image stays selectable.
  // Remix preserves a saved snapshot.modelKey (incl. gpt_image); only missing/legacy
  // values fall back to this default.
  const [model,           setModel]           = useState("gemini_image");
  const [opportunity,     setOpportunity]     = useState<Opportunity | null>(null);
  const [rightPanelMode,  setRightPanelMode]  = useState<RightPanelMode>("feed");
  const [oppDrawerOpen,   setOppDrawerOpen]   = useState(false);
  const [isSubmitting,    setIsSubmitting]    = useState(false);
  const [enhancerSummary, setEnhancerSummary] = useState<{ scene?: string; style?: string; layout?: string; products?: string } | null>(null);
  const [sessions,        setSessions]        = useState<GenerationSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  // ── Amazon affiliate product context ────────────────────────────────────────
  const [amazonSettings,  setAmazonSettings]  = useState<AmazonAffiliateSettings | null>(null);
  const [wsEntry,         setWsEntry]         = useState(false);
  const [wsPrimLabel,     setWsPrimLabel]     = useState("");
  const [wsTrendLabel,    setWsTrendLabel]    = useState("");
  const [feedFilter,      setFeedFilter]      = useState<FeedFilter>("all");
  const [pinDetailSelection, setPinDetailSelection] = useState<{ sessionId: string; entryKey: string; initialTab?: DrawerTab } | null>(null);
  const [detailsModalDraft, setDetailsModalDraft] = useState<PinDraft | null>(null);
  const [canViewDebug, setCanViewDebug] = useState(false);
  const [metadataForm,    setMetadataForm]    = useState<PinMetadataFormState | null>(null);
  const [metadataFormTouched, setMetadataFormTouched] = useState<Partial<MetadataTouchedFlags>>({});
  const [selectedPinKeys, setSelectedPinKeys] = useState<Set<string>>(new Set());
  const [batchEditOpen,   setBatchEditOpen]   = useState(false);
  // Live Weekly Plan drafts — the source of truth for a card's plan state. Kept in
  // sync so a pin scheduled in Weekly Plan immediately reflects in Create Pins.
  const [planDrafts,      setPlanDrafts]      = useState<PinDraft[]>([]);
  const [pinDetailsGenStatus, setPinDetailsGenStatus] = useState<PinDetailsGenStatus>("idle");
  const [formBaseline,    setFormBaseline]    = useState<PinMetadataFormState | null>(null);
  const [showSaved,       setShowSaved]       = useState(false);

  const promptManuallyEdited    = useRef(false);
  const pinDetailsGenRef        = useRef<string | null>(null);
  const sessionRestoredRef      = useRef(false);
  // Immutable registry: keyed by sessionId, set once at generate time, never cleared by applySessions.
  // This is the authoritative source for Remix recovery in the current tab session.
  const snapshotRegistry        = useRef(new Map<string, SetupSnapshot>());
  // Durable recovery store hydrated from IndexedDB on mount — holds FULL snapshots
  // (incl. data-URL images) from previous page loads, so Remix can restore uploaded
  // product/reference images after a refresh or browser restart. The version counter
  // bumps after hydration so the pinDetailView memo recomputes with the loaded data.
  const recoveryStore           = useRef(new Map<string, SetupSnapshot>());
  const [recoveryStoreVersion, setRecoveryStoreVersion] = useState(0);
  // Sync guard: prevents double-click duplicate submissions before React re-renders.
  const submitGuard             = useRef(false);
  // Per-(session,group) guard so a double-click on "Try again" fires exactly one retry request.
  const retryGuard              = useRef<Set<string>>(new Set());
  // Prevents the auto-save effect from firing on the very first render — before
  // the restore effect has had a chance to set state from localStorage.
  const skipFirstComposerSave   = useRef(true);
  const [interactive, setInteractive] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setInteractive(true); }, []);

  // ── VibePin assistant: publish the Create Pins context ──────────────────────────
  // Honest, data-driven findings from the live setup. The effective "creative
  // direction" is the longest of the brief fields so we don't false-flag when the
  // user wrote the direction in a different input. Product-link/reference-size
  // detection lives in Batch Edit / Single Pin, where that data is available.
  const assistantDirection = useMemo(
    () => [manualBrief, prompt, customInstructions]
      .map((s) => (s ?? "").trim())
      .sort((a, b) => b.length - a.length)[0] ?? "",
    [manualBrief, prompt, customInstructions],
  );
  const createPinsContext = useMemo<AssistantContext>(() => {
    const findings = detectCreatePins({
      creativeDirection: assistantDirection,
      productCount: products.length,
      productsMissingLink: 0,
      referenceCount: refs.length,
    });
    const productsLabel = products.length === 1 ? tr("studio.assistant.oneProduct") : tr("studio.assistant.nProducts").replace("{n}", String(products.length));
    const refsLabel = refs.length === 1 ? tr("studio.assistant.oneReference") : tr("studio.assistant.nReferences").replace("{n}", String(refs.length));
    return {
      id: "studio-create-pins",
      source: "page",
      kind: "create-pins",
      label: tr("studio.header.title"),
      summary: products.length || refs.length
        ? `${productsLabel} · ${refsLabel}`
        : undefined,
      greeting: tr("studio.assistant.createPinsGreeting"),
      examplePrompts: [tr("studio.assistant.checkMySetup"), tr("studio.assistant.suggestAngles"), tr("studio.assistant.reviewDirection")],
      tone: findings.some((f) => f.severity === "issue") ? "detected" : "suggested",
      findings,
    };
  }, [assistantDirection, products.length, refs.length]);
  usePublishAssistantContext(createPinsContext, true, [createPinsContext]);

  // Load Amazon affiliate settings (localStorage) on mount.
  useEffect(() => { setAmazonSettings(getAmazonAffiliateSettings()); }, []);

  // Keep the live Weekly Plan drafts in sync. pinDraftStore emits DRAFT_STORE_EVENT
  // after every write, and `storage` fires for cross-tab edits — both re-read so a
  // pin scheduled in Weekly Plan immediately re-renders the matching Create Pins card.
  useEffect(() => {
    const read = () => setPlanDrafts(pinDraftStore.getAllDrafts());
    read();
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (active) setCanViewDebug(canViewGenerationDebug(data.user));
    }).catch(() => { if (active) setCanViewDebug(false); });
    return () => { active = false; };
  }, []);

  // Pre-warm Product Ideas cache the moment the studio page mounts, so data is
  // ready (or in-flight) before the user opens the picker.
  useEffect(() => { void preload(PRODUCT_IDEAS_SWR_KEY, fetchProductIdeasWithMeta); }, []);

  // ── Composer state persistence ────────────────────────────────────────────────
  // Save whenever the user changes the composer inputs. Defined BEFORE the restore
  // effect so it runs first on mount — the first-run guard skips that call.
  useEffect(() => {
    if (skipFirstComposerSave.current) {
      skipFirstComposerSave.current = false;
      return;
    }
    try {
      localStorage.setItem(
        "vibepin_composer_v1",
        JSON.stringify({
          products, refs, prompt, count, variationMode, opportunity,
          creativeDirection: {
            selectedDirectionId,
            guidedControls,
            customInstructions,
            manualBrief,
            manualBriefEdited,
            inputVersion,
            lastBriefInputVersion,
            briefStale,
            opportunityContext,
          },
        }),
      );
    } catch { /* storage quota — non-fatal */ }
  }, [products, refs, prompt, count, variationMode, opportunity, selectedDirectionId, guidedControls, customInstructions, manualBrief, manualBriefEdited, inputVersion, lastBriefInputVersion, briefStale, opportunityContext]);

  // Restore composer state on mount (runs after save on first render, so the
  // skip-first guard above means save never clobbers the restored state).
  useEffect(() => {
    const hasUrlPrefill =
      searchParams.get("prefillKey")    ||
      searchParams.get("draft_id")      ||
      searchParams.get("image_url")     ||
      searchParams.get("product_image_url") ||
      searchParams.get("keyword");
    if (hasUrlPrefill) return; // URL-based prefill takes precedence
    try {
      const raw =
        localStorage.getItem("vibepin_composer_v1") ??
        localStorage.getItem("vibepin_studio_draft"); // legacy fallback
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(saved.products) && (saved.products as string[]).length) setProducts(saved.products as string[]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(saved.refs)     && (saved.refs     as string[]).length) setRefs(saved.refs     as string[]);
      if (typeof saved.prompt === "string" && saved.prompt) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPrompt(saved.prompt);
        setManualBrief(saved.prompt);
        setManualBriefEdited(true);
        promptManuallyEdited.current = true;
      }
      const cd = saved.creativeDirection as Partial<{
        selectedDirectionId: string | null;
        guidedControls: GuidedControls;
        customInstructions: string;
        manualBrief: string;
        manualBriefEdited: boolean;
        inputVersion: string;
        lastBriefInputVersion: string;
        briefStale: boolean;
        opportunityContext: CreativeOpportunityContext;
      }> | undefined;
      if (cd && typeof cd === "object") {
        if ("selectedDirectionId" in cd) setSelectedDirectionId(cd.selectedDirectionId ?? null);
        if (cd.guidedControls) setGuidedControls(cd.guidedControls);
        if (typeof cd.customInstructions === "string") setCustomInstructions(cd.customInstructions);
        if (typeof cd.manualBrief === "string") setManualBrief(cd.manualBrief);
        if (typeof cd.manualBriefEdited === "boolean") setManualBriefEdited(cd.manualBriefEdited);
        if (typeof cd.inputVersion === "string") setInputVersion(cd.inputVersion);
        if (typeof cd.lastBriefInputVersion === "string") setLastBriefInputVersion(cd.lastBriefInputVersion);
        if (typeof cd.briefStale === "boolean") setBriefStale(cd.briefStale);
        if (cd.opportunityContext) setOpportunityContext(cd.opportunityContext);
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (typeof saved.count === "number") setCount(saved.count);
      if (saved.variationMode === "distinct" || saved.variationMode === "similar") setVariationMode(saved.variationMode);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved.opportunity && typeof saved.opportunity === "object") setOpportunity(saved.opportunity as Opportunity);
    } catch { /* noop — corrupted data is silently ignored */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scheduling ───────────────────────────────────────────────────────────

  function getRemainingDaysOfCurrentWeek(): string[] {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = today.getDay();
    const daysUntilEnd = day === 0 ? 0 : 7 - day;
    const days: string[] = [];
    for (let i = 0; i <= daysUntilEnd; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      // Local date — must match Weekly Plan's local-time week filter. Using
      // toISOString() here shifts the date a day earlier in UTC+ zones and hides
      // the Pin from the visible week (the original Add-to-Plan invisibility bug).
      days.push(localDateISO(d));
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
    setLastPrefill(prefill);
    const isRich = ["workspace","weekly_plan","keyword_trends","pin_opportunities"].includes(prefill.source);
    if (prefill.opportunity) {
      const o = prefill.opportunity;
      const tierCode  = o.primaryLabel === "Best Bet" ? "best_bet" : o.primaryLabel === "Competitive" ? "competitive" : "steady";
      const trendCode = (o.trendState?.toLowerCase() ?? "evergreen") as "rising" | "evergreen" | "seasonal";
      setOpportunity({ keyword: o.keyword ?? o.title, category: o.category ?? "", tier: tierCode, trend: trendCode });
      if (isRich) {
        setWsEntry(true);
        setWsPrimLabel(o.primaryLabel ?? "Steady");
        setWsTrendLabel(o.trendState ?? "Evergreen");
      }
      setOpportunityContext({
        enabled: true,
        removable: true,
        title: o.title,
        keyword: o.keyword ?? o.title,
        category: o.category,
        evidenceSentence: o.evidenceSentence,
        source: prefill.source,
      });
    }
    if (prefill.productImages?.length) {
      const urls = prefill.productImages.map(p => p.imageUrl);
      // Preserve productUrl/sourceDomain so Amazon affiliate detection works downstream
      // (productUrlToSnapshot reads these back from the asset store at resolve time).
      prefill.productImages.forEach(p => assetStore.saveAsset({
        role: "product", source: "product_signal", imageUrl: p.imageUrl, title: p.title, keyword: p.category,
        productUrl: p.productUrl, sourceUrl: p.productUrl, sourceDomain: p.sourceDomain,
      }));
      setProducts(urls);
    }
    if (prefill.pinReferences?.length) {
      const urls = prefill.pinReferences.map(r => r.imageUrl);
      prefill.pinReferences.forEach(r => assetStore.saveAsset({ role: "style_reference", source: "viral_pin", imageUrl: r.imageUrl, keyword: r.keyword, category: r.category }));
      setRefs(urls);
    }
    const p = prefill.creativeDirectionSeed || prefill.promptSeed || buildPromptFromPrefill(prefill);
    if (p) {
      setPrompt(p);
      setManualBrief(p);
      setManualBriefEdited(Boolean(prefill.promptSeed || prefill.creativeDirectionSeed));
      setLastBriefInputVersion("prefill");
      setInputVersion("prefill");
      setBriefStale(false);
      promptManuallyEdited.current = Boolean(prefill.promptSeed || prefill.creativeDirectionSeed);
    }
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
    const cat        = searchParams.get("category") ? decodeURIComponent(searchParams.get("category") ?? "") : "";
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
  const selectedCreativeAssets = useMemo<SelectedCreativeAsset[]>(() => (
    buildSelectedCreativeAssets({
      productUrls: products,
      referenceUrls: refs,
      storedAssets: assetStore.getAssets(),
      prefill: lastPrefill,
    })
  ), [products, refs, lastPrefill]);

  const creativeCategory = useMemo(() => (
    inferCreativeCategory({ explicitCategory: opportunity?.category, assets: selectedCreativeAssets })
  ), [opportunity?.category, selectedCreativeAssets]);

  const derivedRecommendations = useMemo(() => (
    getRecommendedCreativeDirections({
      category: opportunity?.category,
      assets: selectedCreativeAssets,
      hasOpportunity: !!opportunity,
    })
  ), [opportunity?.category, selectedCreativeAssets, opportunity]);

  const selectedDirection = useMemo(() => (
    derivedRecommendations.find(r => r.id === selectedDirectionId) ?? derivedRecommendations[0] ?? null
  ), [derivedRecommendations, selectedDirectionId]);

  // ── Creative Intelligence V1: product/reference analysis + intent inference ──
  const productSetAnalysis = useMemo(() => analyzeProductSet(selectedCreativeAssets), [selectedCreativeAssets]);
  const referenceContext   = useMemo(() => analyzeReferences(selectedCreativeAssets, {
    productCategory: creativeCategory,
    isCompleteOutfit: productSetAnalysis.category === "fashion" && productSetAnalysis.isCoherentSet,
  }), [selectedCreativeAssets, creativeCategory, productSetAnalysis]);
  const inferredIntent = useMemo(() => inferCreativeIntent({
    category: creativeCategory,
    references: referenceContext,
    hasProducts: productSetAnalysis.hasProducts,
    hasOpportunity: !!opportunity,
    productSetSummary: productSetAnalysis.setSummary,
    primaryProductTitle: productSetAnalysis.products[0]?.title,
    keyword: opportunity?.keyword,
    refinement: customInstructions,
  }), [creativeCategory, referenceContext, productSetAnalysis, opportunity, customInstructions]);

  const cleanedProductTitles = useMemo(() => (
    productSetAnalysis.products.map(p => cleanProductTitle(p.title))
  ), [productSetAnalysis]);

  // ── Lightweight creative controls: diverse tags + auto-filled Direction brief ──
  const creativeTags = useMemo<CreativeTag[]>(() => buildCreativeTags({
    category: creativeCategory,
    productTitles: cleanedProductTitles,
    referenceType: referenceContext.dominant?.referenceType ?? null,
    referenceSceneType: referenceContext.dominant?.sceneType,
    hasReference: referenceContext.hasReferences,
    opportunityKeyword: opportunity?.keyword,
    format,
  }), [creativeCategory, cleanedProductTitles, referenceContext, opportunity, format]);

  // Reset tag selection to category defaults whenever the available tag set changes.
  const tagSetKey = creativeTags.map(t => t.id).join(",");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedTagIds(defaultSelectedTagIds(creativeTags));
    setBriefStaleFromTags(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagSetKey]);

  const selectedCreativeTags = useMemo(() => (
    creativeTags.filter(t => selectedTagIds.includes(t.id))
  ), [creativeTags, selectedTagIds]);
  const selectedTagPayload = useMemo(() => (
    selectedCreativeTags.map(t => ({ id: t.id, label: t.label, group: t.group }))
  ), [selectedCreativeTags]);
  const primaryFormatTag = selectedCreativeTags.find(t => t.group === "format")?.label ?? "";

  const derivedBrief = useMemo(() => buildDirectionBrief({
    category: creativeCategory,
    productTitles: cleanedProductTitles,
    referenceType: referenceContext.dominant?.referenceType ?? null,
    referenceSceneType: referenceContext.dominant?.sceneType,
    hasReference: referenceContext.hasReferences,
    opportunityKeyword: opportunity?.keyword,
    format,
  }, selectedTagPayload),
  [creativeCategory, cleanedProductTitles, referenceContext, opportunity, format, selectedTagPayload]);

  // Auto-fill the Direction brief from the derived brief — but never overwrite the
  // user once they've typed (briefManuallyEdited). The brief is the user-facing
  // refinement; the hidden prompt builder stays responsible for the technical prompt.
  useEffect(() => {
    if (briefManuallyEdited) {
      if (products.length > 0 || refs.length > 0) setBriefStaleFromTags(true);
      return;
    }
    if (products.length === 0 && refs.length === 0) return; // keep empty until an upload exists
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCustomInstructions(derivedBrief);
    if (!manualBriefEdited) setManualBrief(derivedBrief);
    setPrompt(derivedBrief);
    setBriefStaleFromTags(false);
  }, [derivedBrief, briefManuallyEdited, manualBriefEdited, products.length, refs.length]);

  function handleToggleCreativeTag(id: string) {
    setSelectedTagIds(prev => toggleTagSelection(creativeTags, prev, id));
    if (briefManuallyEdited) setBriefStaleFromTags(true);
  }
  function handleBriefChange(value: string) {
    setBriefManuallyEdited(true);
    setBriefStaleFromTags(false);
    setCustomInstructions(value);
    setManualBrief(value);
    setManualBriefEdited(true);
    setPrompt(value);
  }
  function handleUpdateBriefFromTags() {
    setBriefManuallyEdited(false);
    setBriefStaleFromTags(false);
    setCustomInstructions(derivedBrief);
    setManualBrief(derivedBrief);
    setManualBriefEdited(false);
    setPrompt(derivedBrief);
  }

  const composeCreativeBrief = useCallback((
    direction = selectedDirection,
    controls = guidedControls,
    custom = customInstructions,
    context = opportunityContext,
  ): string => buildManualBrief({
    selected: direction,
    guidedControls: controls,
    customInstructions: custom,
    opportunityContext: context,
  }), [selectedDirection, guidedControls, customInstructions, opportunityContext]);

  const buildCreativeDirectionSnapshot = useCallback((brief = manualBrief): CreativeDirectionSnapshotV2 => ({
    version: 2,
    selectedDirectionId: selectedDirection?.id ?? null,
    selectedDirectionTitle: selectedDirection?.title ?? "",
    selectedDirectionSummary: selectedDirection?.summary ?? "",
    systemRecommendations: derivedRecommendations,
    guidedControls,
    customInstructions,
    manualBrief: brief,
    manualBriefEdited,
    inputVersion,
    briefStale,
    opportunityContext,
    selectedAssets: selectedCreativeAssets,
    categoryPlaybookId: creativeCategory,
    fallbackUsed: creativeCategory === "generic" ? "generic" : "category_playbook",
  }), [
    selectedDirection, derivedRecommendations, guidedControls, customInstructions,
    manualBrief, manualBriefEdited, inputVersion, briefStale, opportunityContext,
    selectedCreativeAssets, creativeCategory,
  ]);

  useEffect(() => {
    setSystemRecommendations(derivedRecommendations);
    if (!selectedDirectionId || !derivedRecommendations.some(r => r.id === selectedDirectionId)) {
      // Default-select the highest-confidence direction (never a LOW one when a
      // higher-confidence option exists); ties keep recommendation order.
      const rank = { high: 3, medium: 2, low: 1 } as const;
      const best = derivedRecommendations.reduce<typeof derivedRecommendations[number] | null>(
        (acc, cur) => (!acc || (rank[cur.confidence ?? "low"]) > (rank[acc.confidence ?? "low"]) ? cur : acc),
        null,
      );
      setSelectedDirectionId(best?.id ?? derivedRecommendations[0]?.id ?? null);
    }
  }, [derivedRecommendations, selectedDirectionId]);

  useEffect(() => {
    const nextVersion = JSON.stringify({
      products,
      refs,
      opportunityKeyword: opportunity?.keyword ?? "",
      opportunityCategory: opportunity?.category ?? "",
      opportunityEnabled: opportunityContext.enabled,
      recommendationIds: derivedRecommendations.map(r => r.id),
    });
    if (nextVersion === inputVersion) return;
    setInputVersion(nextVersion);
    if (manualBriefEdited && manualBrief.trim()) {
      setBriefStale(true);
      return;
    }
    const nextBrief = composeCreativeBrief();
    setManualBrief(nextBrief);
    setPrompt(nextBrief);
    setLastBriefInputVersion(nextVersion);
    setBriefStale(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsKey, refsKey, opportunity?.keyword, opportunity?.category, opportunityContext.enabled, derivedRecommendations, composeCreativeBrief]);

  // Clear stale AI Direction summary when the user's input set changes
  useEffect(() => {
    setEnhancerSummary(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsKey, refsKey]);

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
      setSessions(prev => {
        const restoredById = new Map(restored.map(s => [s.id, s]));
        const prevById     = new Map(prev.map(s => [s.id, s]));

        // Merge restored sessions, carrying over setupSnapshot when the storage copy lost it
        // (e.g. localStorage quota exceeded for data-URL product images).
        const mergedRestored = restored.map(s => {
          const live = prevById.get(s.id);
          if (live?.setupSnapshot && !s.setupSnapshot) {
            return { ...s, setupSnapshot: live.setupSnapshot };
          }
          return s;
        });

        // Keep any live sessions that aren't in restored yet — typically sessions that
        // were generated after the mount-time DB query ran, whose localStorage save also
        // failed (large data-URL products hit quota). Without this, the async merge would
        // silently drop them, clearing the feed and closing any open drawer.
        const liveOnly = prev.filter(s => !restoredById.has(s.id));

        // Live sessions are newer, so they come first.
        return [...liveOnly, ...mergedRestored];
      });
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
      markDataReady("/app/studio");
    }).catch(() => { markDataReady("/app/studio"); });

    // Durable Remix recovery: hydrate full snapshots (incl. data-URL images) from
    // IndexedDB so uploaded product/reference images survive refresh + browser restart.
    loadAllRemixSetups()
      .then(map => {
        if (map.size === 0) return;
        recoveryStore.current = map;
        setRecoveryStoreVersion(v => v + 1);
        // Bound IndexedDB growth; never drop sessions still present in local history.
        pruneRemixSetups(new Set(loadHistory().map(h => h.id))).catch(() => {});
      })
      .catch(() => { /* IndexedDB unavailable — fall through to other tiers */ });
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────────

  const totalPins = (refs.length > 0 ? refs.length : 1) * count;
  const overLimit = totalPins > 12;
  const hasInput  = (manualBrief || prompt).trim().length > 0 || products.length > 0 || refs.length > 0 || !!opportunity;
  const genLabel  = totalPins === 1 ? tr("page.studio.generateOnePin") : tr("page.studio.generatePins").replace("{n}", String(totalPins));
  const referenceInfluenceMode = inferReferenceInfluenceMode({
    direction: selectedDirection,
    productSet: productSetAnalysis,
    references: referenceContext,
    intent: inferredIntent,
    playbook: getCategoryPlaybook(creativeCategory),
    controls: {
      goal: guidedControls.goal,
      subject: guidedControls.subject,
      productEmphasis: guidedControls.productEmphasis ?? guidedControls.productTreatment,
      referenceStrength: guidedControls.referenceStrength,
      textOverlay: guidedControls.textOverlay,
    },
    refinement: customInstructions,
    opportunityKeyword: opportunity?.keyword,
    format,
  });
  const referenceWeight = refs.length > 0
    ? referenceInfluenceMode === "layout_scene_strong" ? 70 : referenceInfluenceMode === "style_mood_balanced" ? 50 : 20
    : 0;
  const productWeight = products.length > 0 ? Math.max(35, 100 - referenceWeight) : 0;

  void activeSessionId;

  function toggleProductUrl(url: string) {
    setProducts(p => p.includes(url) ? p.filter(u => u !== url) : [...p, url]);
  }

  function toggleRefUrl(url: string) {
    setRefs(r => r.includes(url) ? r.filter(u => u !== url) : [...r, url]);
  }

  // ── Generation ────────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!hasInput) { toast.error(tr("studio.toast.needInputFirst")); return; }
    if (submitGuard.current) return;
    submitGuard.current = true;
    setIsSubmitting(true);
    setRightPanelMode("feed");
    const refsToProcess: Array<string | null> = refs.length > 0 ? refs : [null];
    const sessionId = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const studioClientId = getStudioClientId();
    const mode = products.length > 0 ? "product_led" : refs.length > 0 ? "keyword_led" : "scratch";
    const outputVariants = buildOutputVariants(count, variationMode, creativeCategory);
    const directionBriefForGeneration = (customInstructions || derivedBrief).trim();
    const briefForGeneration = (directionBriefForGeneration || manualBrief || prompt).trim();
    // Compile the hidden technical prompt (creative_direction_v2). This is what the
    // image model receives; the backend passes it through without re-enhancing.
    const hiddenPrompt = buildHiddenPrompt({
      direction: selectedDirection,
      productSet: productSetAnalysis,
      references: referenceContext,
      intent: inferredIntent,
      playbook: getCategoryPlaybook(creativeCategory),
      controls: {
        goal: guidedControls.goal,
        subject: guidedControls.subject,
        productEmphasis: guidedControls.productEmphasis ?? guidedControls.productTreatment,
        referenceStrength: guidedControls.referenceStrength,
        textOverlay: guidedControls.textOverlay,
      },
      refinement: directionBriefForGeneration,
      directionBrief: directionBriefForGeneration,
      selectedTags: selectedTagPayload,
      primaryFormatTag,
      opportunityKeyword: opportunity?.keyword,
      format,
    });
    const promptForGeneration = hiddenPrompt.trim() || briefForGeneration;
    if (SHOW_GENERATION_DEBUG) {
      console.debug("[Studio generation payload]", {
        prompt_mode: "creative_direction_v2",
        selectedDirection: selectedDirection?.title,
        referenceInfluenceMode,
        productImageCount: products.length,
        referenceImageCount: refs.length,
        finalProviderEndpoint: model === "gpt_image" && (products.length > 0 || refs.length > 0) ? "/images/edits" : model,
        finalPromptReferenceExcerpt: hiddenPrompt.match(/REFERENCE REQUIREMENTS:[\s\S]*?(?:\n\n[A-Z ]+:|$)/)?.[0]?.slice(0, 1200) ?? "",
        fastapiPathSkipped: true,
        promptEnhancerMayAnalyzeButNotRewriteV2: true,
      });
    }
    // ── Structured creative-control metadata for the generate payload ──────────
    const tagGroups: Record<TagGroup, string[]> = { format: [], scene: [], mood: [], composition: [] };
    selectedCreativeTags.forEach(t => tagGroups[t.group].push(t.label));
    const creativeControls = {
      selectedTags: selectedTagPayload,
      primaryFormatTag,
      directionBrief: directionBriefForGeneration,
      tagGroups,
      derivedBrief,
      briefManuallyEdited,
      selectedOpportunity: opportunity ?? null,
      inferredCategory: creativeCategory,
      productImageCountRequested: products.length,
      referenceImageCountRequested: refs.length,
    };

    const baseSnapshot = buildCreativeDirectionSnapshot(briefForGeneration);
    const creativeDirectionSnapshot = {
      ...baseSnapshot,
      hiddenPrompt,
      productAnalysis: productSetAnalysis,
      referenceAnalysis: referenceContext.analyses,
      inferredIntent,
      creativeControls,
      outputCount: count,
      variationMode,
      outputVariants,
    };

    if (SHOW_GENERATION_DEBUG) {
      console.log("[StudioDebug] creative controls", {
        inferredCategory: creativeCategory,
        productRoles: productSetAnalysis.products.map(p => p.role),
        referenceType: referenceContext.dominant?.referenceType ?? null,
        selectedTags: creativeControls.selectedTags,
        derivedBrief,
        briefManuallyEdited,
        selectedOpportunity: opportunity ?? null,
        productImageCountRequested: products.length,
        referenceImageCountRequested: refs.length,
      });
    }

    const effectiveCategory = opportunity?.category || (creativeCategory !== "generic" ? creativeCategory : "");

    const snap: SetupSnapshot = {
      mode, keyword: opportunity?.keyword, category: effectiveCategory,
      opportunityTitle: opportunity?.keyword, noTextOverlay: !detectTextOverlayIntent(briefForGeneration),
      imagesPerReference: count,
      selectedProducts:   products.map(url => productUrlToSnapshot(url)),
      selectedReferences: refs.map(url => ({ imageUrl: url })),
      promptSnapshot:     briefForGeneration,
      creativeDirectionSnapshot,
      createdFrom:        wsEntry ? "workspace" : "studio",
      format,
      model:    MODEL_KEY_TO_LABEL[model] ?? model,
      modelKey: model,
    };
    devLogSnapshot("[GenerateSetup] click", {
      batchId: sessionId,
      requestId: sessionId,
      setupSnapshot: {
        productImagesCount: snap.selectedProducts.length,
        pinReferencesCount: snap.selectedReferences.length,
        prompt: snap.promptSnapshot,
        category: snap.category,
        aspectRatio: snap.format,
        model: snap.model,
      },
    });
    // Resolve the creator-owned Amazon affiliate context for this generation, so
    // every pin produced here inherits the same product + affiliate destination.
    const affiliateCtx = resolveStudioAffiliateContext(snap.selectedProducts, amazonSettings);

    // Register immutably — this survives any applySessions or setSessions call for the tab session.
    snapshotRegistry.current.set(sessionId, snap);
    // Durable: persist the FULL snapshot (incl. data-URL images) to IndexedDB so it
    // survives refresh + browser restart — this is what makes uploaded product/reference
    // images recoverable in Remix later. Fire-and-forget; fails soft.
    recoveryStore.current.set(sessionId, snap);
    saveRemixSetup(sessionId, snap).catch(() => {});
    // Persist setup to sessionStorage so it survives an applySessions clobber.
    // Full snap first; if it fails (data-URL quota), store a compact version that strips
    // large data-URL imageUrls. The compact version still carries metadata (productCount via
    // selectedProducts.length) so the hydration guard in pinDetailView can detect "products
    // were selected" and fall back gracefully.
    const snapKey = `vibepin_setup_${sessionId}`;
    try {
      sessionStorage.setItem(snapKey, JSON.stringify(snap));
    } catch {
      try {
        const compact: SetupSnapshot = {
          ...snap,
          selectedProducts:   snap.selectedProducts.map(p => ({ ...p, imageUrl: p.imageUrl?.startsWith("data:") ? null : p.imageUrl })),
          selectedReferences: snap.selectedReferences.map(r => ({ ...r, imageUrl: r.imageUrl.startsWith("data:") ? "" : r.imageUrl })),
        };
        sessionStorage.setItem(snapKey, JSON.stringify(compact));
      } catch { /* noop */ }
    }
    const runningEntry: HistoryEntry = {
      id: sessionId, savedAt: new Date().toISOString(),
      keyword: opportunity?.keyword ?? "", category: effectiveCategory,
      source: wsEntry ? "workspace" : "studio",
      groups: [], refCount: refs.length, productCount: products.length, totalPins: 0,
      status: "running", expectedTotal: totalPins, mode,
      opportunity: opportunity?.keyword, imagesPerRef: count,
      promptExcerpt: briefForGeneration.slice(0, 120), promptFull: briefForGeneration, setupSnapshot: snap,
    };
    addHistory(runningEntry);
    devLogSnapshot("[GenerateSetup] persisted local history", {
      batchId: sessionId,
      where: "localStorage vp:studio:history",
      success: true,
      setupSnapshotStored: !!runningEntry.setupSnapshot,
    });
    createRunningSessionInDb(supabase, runningEntry).catch(() => {});

    setActiveSessionId(sessionId);
    try { sessionStorage.setItem("vbp:studio:last_session_id", sessionId); } catch { /* noop */ }

    const newSession: GenerationSession = {
      id: sessionId, savedAt: new Date().toISOString(),
      keyword: opportunity?.keyword ?? "", category: effectiveCategory,
      source: wsEntry ? "workspace" : "studio",
      groups: refsToProcess.map((refUrl, idx) => ({
        refUrl, refIndex: idx, items: [], status: "generating" as const, expectedCount: count,
      })),
      status: "generating", expectedTotal: totalPins,
      promptExcerpt: briefForGeneration.slice(0, 120), productCount: products.length, refCount: refs.length,
      isNew: true, collapsed: false, generatingGroupIdx: 0,
      promptFull: briefForGeneration, setupSnapshot: snap, model: MODEL_KEY_TO_LABEL[model] ?? model, format,
      textOverlay: detectTextOverlayIntent(briefForGeneration) ? "On" : "Off",
      groupErrors: {},
      affiliate: affiliateCtx,
    };
    // Prepend new session, collapse old ones. Do NOT clear products/refs/prompt.
    setSessions(prev => [newSession, ...prev.map(s => ({ ...s, isNew: false, collapsed: false }))]);
    // Unlock the button immediately — the session card is now in the feed.
    // The generation loop below runs concurrently; new batches can be started independently.
    submitGuard.current = false;
    setIsSubmitting(false);

    const finalGroups: RefGroup[] = refsToProcess.map((refUrl, idx) => ({
      refUrl, refIndex: idx, items: [], status: "generating" as const, expectedCount: count,
    }));
    const recoverableProductImages = snap.selectedProducts
      .map(p => p.imageUrl)
      .filter((u): u is string => !!u && !u.startsWith("data:"));
    const dbGroups: HistoryPinGroup[] = refsToProcess.map(r => ({
      refUrl: r,
      images: [],
      productImages: recoverableProductImages,
      promptSnapshot: briefForGeneration,
      category: effectiveCategory,
      format: snap.format,
      model: snap.model,
      creativeDirectionSnapshot,
    }));
    const groupErrors: Record<number, { message?: string; errorType?: GenerationErrorType }> = {};
    let totalGenerated = 0;
    let sessionErrorMessage: string | undefined;
    let sessionFinalPrompt: string | undefined;
    let sessionCategoryAudit: CategoryAudit | undefined;

    for (let i = 0; i < refsToProcess.length; i++) {
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status: "generating", generatingGroupIdx: i } : s));
      const ref = refsToProcess[i];
      try {
        const data = await generateWithRecovery({
          keyword:  opportunity?.keyword ?? "Pinterest content",
          category: effectiveCategory,
          prompt: promptForGeneration,
          count,
          styleRef: ref,
          productImages: products,
          textOverlay:       snap.noTextOverlay === false,
          referenceStrength: creativeDirectionSnapshot.guidedControls.referenceStrength ?? "moderate",
          outputType:        inferOutputType(effectiveCategory),
          pinFormat:         snap.format ?? "vertical 2:3",
          productMetadata:   snap.selectedProducts.map(p => ({ title: p.title, productUrl: p.productUrl })),
          modelKey:          snap.modelKey ?? "gemini_image",
          promptMode:        "creative_direction_v2",
          promptVersion:     2,
          creativeDirectionMeta: creativeDirectionSnapshot,
          selectedTags: selectedTagPayload,
          primaryFormatTag,
          directionBrief: directionBriefForGeneration,
          briefManuallyEdited,
          inferredCategory: creativeCategory,
          selectedOpportunity: opportunity ?? null,
          productImageCountRequested: products.length,
          referenceImageCountRequested: ref ? 1 : 0,
          outputCount: count,
          variationMode,
          outputVariants,
          generationRequestId: sessionId,
          studioClientId,
        });
        if (data.countClamped && data.actualImageCount) {
          const limitedLabel = data.actualImageCount === 1
            ? tr("studio.toast.limitedToOneImage")
            : tr("studio.toast.limitedToNImages").replace("{n}", String(data.actualImageCount));
          toast.message(limitedLabel, {
            description: tr("studio.toast.providerProtectionActive"),
          });
        }
        if (data.promptSnapshot?.plan?.summary_for_ui) {
          setEnhancerSummary(data.promptSnapshot.plan.summary_for_ui);
        }
        if (data.promptSnapshot?.final_prompt && !sessionFinalPrompt) {
          sessionFinalPrompt = data.promptSnapshot.final_prompt;
        }
        if (!sessionCategoryAudit && data.promptSnapshot?.effective_category !== undefined) {
          sessionCategoryAudit = categoryAuditFromSnapshot(data.promptSnapshot, opportunity?.category ?? "");
        }
        if (data.urls.length) {
          const expectedForResult = data.countClamped && data.actualImageCount ? data.actualImageCount : count;
          const isPartial = data.urls.length < expectedForResult;
          const sessCtx = {
            keyword: opportunity?.keyword ?? "",
            category: effectiveCategory,
            setupSnapshot: snap,
            promptFull: briefForGeneration,
            generationFinalPrompt: data.promptSnapshot?.final_prompt,
          };
          const refLabel = ref ? `Reference ${i + 1}` : products.length > 0 ? "Product" : "No product";
          finalGroups[i] = {
            ...finalGroups[i],
            items: data.urls.map((url, ii) => applyAffiliateToFreshPin(createCompletedPin(sessionId, i, ii, url, sessCtx, refLabel), affiliateCtx)),
            expectedCount: expectedForResult,
            // "partial" when fewer images returned than requested — keeps the missing
            // slots visible as failed/retryable in the feed without a hard red error.
            status: isPartial ? "partial" : "done",
          };
          dbGroups[i]    = {
            ...dbGroups[i],
            refUrl: ref,
            images: data.urls,
          };
          totalGenerated += data.urls.length;
          if (isPartial) {
            const shortfall = expectedForResult - data.urls.length;
            const shortfallMsg = shortfall === 1 ? tr("studio.toast.oneImageDidntGenerate") : tr("studio.toast.nImagesDidntGenerate").replace("{n}", String(shortfall));
            const errMsg = data.error ?? shortfallMsg;
            groupErrors[i] = { message: errMsg, errorType: data.errorType ?? "unknown_error" };
            // Informational toast — we still produced usable Pins.
            toast.message(tr("studio.toast.nOfTotalGenerated").replace("{n}", String(data.urls.length)).replace("{total}", String(count)), { description: errMsg });
          }
        } else {
          const errMsg = data.error ?? tr("studio.toast.noImagesReturned");
          finalGroups[i] = { ...finalGroups[i], status: "failed" };
          groupErrors[i] = { message: errMsg, errorType: data.errorType ?? "unknown_error" };
          sessionErrorMessage = errMsg;
          toast.error(tr("studio.toast.referenceNFailed").replace("{n}", String(i + 1)), { description: errMsg });
        }
      } catch (err) {
        const errMsg = String(err);
        finalGroups[i] = { ...finalGroups[i], status: "failed" };
        groupErrors[i] = { message: errMsg, errorType: "unknown_error" };
        sessionErrorMessage = errMsg;
        toast.error(tr("studio.toast.networkError"), { description: errMsg });
      }
      setSessions(prev => prev.map(s => s.id === sessionId ? {
        ...s, groups: [...finalGroups],
        groupErrors: { ...groupErrors },
        errorMessage: sessionErrorMessage,
      } : s));
      addHistory({ ...runningEntry, groups: dbGroups, totalPins: totalGenerated, status: totalGenerated > 0 ? "partial" : "running" });
      updateSessionInDb(supabase, sessionId, {
        groups_json: dbGroups,
        pin_urls: dbGroups.flatMap(g => g.images),
        total_pins: totalGenerated,
        status: totalGenerated > 0 ? "partial" : "running",
        error_type: sessionErrorMessage ? groupErrors[i]?.errorType : undefined,
        error_message: sessionErrorMessage,
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }

    const doneCount   = finalGroups.flatMap(g => g.items).length;
    const finalStatus: GenerationStatus = doneCount === 0 ? "failed" : doneCount < totalPins ? "partial" : "completed";
    setSessions(prev => prev.map(s => s.id === sessionId ? {
      ...s, status: finalStatus as SessionStatus, generatingGroupIdx: null,
      groupErrors: Object.keys(groupErrors).length > 0 ? groupErrors : s.groupErrors,
      errorMessage: sessionErrorMessage ?? s.errorMessage,
      errorType: doneCount === 0 ? "unknown_error" : s.errorType,
      ...(sessionFinalPrompt    ? { generationFinalPrompt: sessionFinalPrompt }    : {}),
      ...(sessionCategoryAudit  ? { categoryAudit: sessionCategoryAudit }          : {}),
    } : s));
    addHistory({
      ...runningEntry, groups: dbGroups, totalPins: doneCount, status: finalStatus,
      errorMessage: sessionErrorMessage, errorType: doneCount === 0 ? "unknown_error" : undefined,
      ...(sessionCategoryAudit ? { categoryAudit: sessionCategoryAudit } : {}),
    });
    updateSessionInDb(supabase, sessionId, {
      groups_json: dbGroups,
      pin_urls: dbGroups.flatMap(g => g.images),
      total_pins: doneCount,
      status: finalStatus,
      ...(sessionCategoryAudit ? { category_audit: sessionCategoryAudit } : {}),
      error_type: doneCount === 0 ? "unknown_error" : Object.values(groupErrors)[0]?.errorType,
      error_message: sessionErrorMessage,
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    if (SHOW_GENERATION_DEBUG) {
      console.debug("[Studio] generation session complete", {
        generationSessionId:    sessionId,
        requestedImageCount:    totalPins,
        plannedVariantCount:    count * refsToProcess.length,
        completedImageCount:    doneCount,
        failedImageCount:       totalPins - doneCount,
        status:                 finalStatus,
        providerExecutionMode:  "backend_fan_out",
        persistedImageCount:    doneCount,
        failedOutputIndexes:    Object.keys(groupErrors).map(Number),
        outputs: finalGroups.flatMap((g, gi) => [
          ...g.items.map((p, pi) => ({
            groupIdx: gi, outputIndex: pi, variantRole: pi === 0 ? "anchor" : "variant",
            status: "completed", imageUrl: p.url, persisted: true,
          })),
          ...(g.status !== "done"
            ? Array.from({ length: Math.max(0, g.expectedCount - g.items.length) }, (_, k) => ({
                groupIdx: gi, outputIndex: g.items.length + k, variantRole: "variant",
                status: g.status, imageUrl: null, persisted: false,
              }))
            : []),
        ]),
      });
    }
    if (doneCount) toast.success(doneCount === 1 ? tr("studio.toast.oneGenerated") : tr("studio.toast.nGenerated").replace("{n}", String(doneCount)));
  }, [
    hasInput, refs, count, variationMode, prompt, manualBrief, derivedBrief, briefManuallyEdited, opportunity, products, totalPins,
    wsEntry, model, format, buildCreativeDirectionSnapshot, creativeCategory,
    customInstructions, selectedCreativeTags, selectedTagPayload, primaryFormatTag, inferredIntent, productSetAnalysis,
    referenceContext, referenceContext.analyses, referenceInfluenceMode, guidedControls, selectedDirection,
  ]);

  const pinDetailView = useMemo((): PinDetailView | null => {
    if (!pinDetailSelection) return null;
    const session = sessions.find(s => s.id === pinDetailSelection.sessionId);
    if (!session) return null;
    const allItems = flattenFeedItems(sessions, "all");
    const item = allItems.find(i => i.entry.key === pinDetailSelection.entryKey && i.entry.sessionId === pinDetailSelection.sessionId);
    if (!item) return null;
    const historyEntry = loadHistory().find(h => h.id === session.id) ?? null;

    // Recovery sources, richest first. Each candidate is scored by how many live
    // (non-empty) product/reference imageUrls it carries; we pick the richest so a
    // full snapshot with images always beats a compact one whose imageUrls were
    // stripped. This is what restores uploaded images after refresh/browser restart.
    //   1. snapshotRegistry — in-memory, set at generate time (current tab)
    //   2. recoveryStore    — IndexedDB, FULL snapshot incl. data-URL images (durable)
    //   3. sessionStorage/localStorage — tab-local (may be compacted)
    //   4. session.setupSnapshot       — DB/storage-restored (compact)
    //   5. historyEntry.setupSnapshot  — localStorage history (compact)
    const sessionStorageSnap = (() => {
      try {
        const raw = sessionStorage.getItem(`vibepin_setup_${session.id}`)
          ?? localStorage.getItem(`vibepin_setup_${session.id}`);
        return raw ? (JSON.parse(raw) as SetupSnapshot) : null;
      } catch { return null; }
    })();

    const liveImageScore = (snap: SetupSnapshot | null): number => {
      if (!snap) return -1;
      const prod = (snap.selectedProducts   ?? []).filter(p => !!p.imageUrl).length;
      const refs = (snap.selectedReferences ?? []).filter(r => !!r.imageUrl).length;
      return prod + refs;
    };

    const candidates = [
      snapshotRegistry.current.get(session.id) ?? null,
      recoveryStore.current.get(session.id) ?? null,
      sessionStorageSnap,
      session.setupSnapshot ?? null,
      historyEntry?.setupSnapshot ?? null,
    ].filter((s): s is SetupSnapshot => !!s);

    // Pick the candidate with the most recovered images; ties keep the
    // higher-priority (earlier) one because we only replace on a strict win.
    const bestSnap = candidates.reduce<SetupSnapshot | null>(
      (best, cur) => (!best || liveImageScore(cur) > liveImageScore(best) ? cur : best),
      null,
    );

    const hydratedSession: typeof session = bestSnap
      ? { ...session, setupSnapshot: bestSnap }
      : session;

    return resolvePinDetail(hydratedSession, item.entry, historyEntry);
    // recoveryStoreVersion is referenced so the memo recomputes once IndexedDB hydrates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinDetailSelection, sessions, recoveryStoreVersion]);

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

  // ── VibePin assistant: publish the Single Pin Edit context (lightweight) ────────
  // Highest-priority "modal" source so it overrides the Create Pins page context while
  // a pin detail is open. Studio pins don't carry a board (that's applied in Weekly
  // Plan), so board is not treated as a required field here.
  const singlePinAssistantActive = !!(pinDetailSelection && metadataForm && pinDetailPin);
  const singlePinAssistantContext = useMemo<AssistantContext>(() => {
    const form = metadataForm;
    const pin = pinDetailPin;
    if (!form || !pin) {
      return { id: "studio-single-pin", source: "modal", kind: "single-pin", label: tr("studio.assistant.pinEdit"), tone: "detected", findings: [] };
    }
    const planned = pin.planningStatus === "added_to_plan" || pin.planningStatus === "needs_review" || pin.planningStatus === "ready";
    const hasTime = !!((form.plannedDate ?? "").trim() || pin.plannedAt);
    const findings = detectSinglePin({
      imageUrl:       pin.url,
      title:          form.title,
      description:    form.description,
      altText:        form.altText,
      destinationUrl: form.destinationUrl,
      plannedDate:    form.plannedDate,
      plannedAt:      pin.plannedAt,
      planningStatus: pin.planningStatus,
      boardManaged:   false,
      scheduleTimeMissing: planned && !hasTime,
    });
    return {
      id: "studio-single-pin",
      source: "modal",
      kind: "single-pin",
      label: tr("studio.assistant.pinEdit"),
      summary: form.title?.trim() ? tr("studio.assistant.editingTitle").replace("{title}", form.title.trim().slice(0, 40)) : undefined,
      greeting: tr("studio.assistant.singlePinGreeting"),
      examplePrompts: [tr("studio.assistant.readyToSchedule"), tr("studio.assistant.improveDescription")],
      tone: "detected",
      findings,
    };
  }, [metadataForm, pinDetailPin]);
  usePublishAssistantContext(singlePinAssistantContext, singlePinAssistantActive, [singlePinAssistantContext, singlePinAssistantActive]);

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
      contentLanguage: readResolvedContentLanguage(),
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
    // Product / board changes ride on metadataDraft — persist them immediately so they
    // survive closing & reopening the drawer without requiring an explicit Save (Test F).
    if ("metadataDraft" in patch && patch.metadataDraft && pinDetailView && pinDetailView.pinIdx !== undefined) {
      const draft = patch.metadataDraft;
      updatePinMetadata(pinDetailView.sessionId, pinDetailView.groupIdx, pinDetailView.pinIdx, p => ({ ...p, metadataDraft: draft }));
    }
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
      contentLanguage: readResolvedContentLanguage(),
    });
    if (!metadataFormTouched.titleTouched || window.confirm(tr("studio.confirm.overwriteTitle"))) {
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
      contentLanguage: readResolvedContentLanguage(),
    });
    if (!metadataFormTouched.descriptionTouched || window.confirm(tr("studio.confirm.overwriteDescription"))) {
      handleMetadataChange({ description: fresh.selectedDescription, metadataDraft: fresh });
    }
  }

  const selectedCompletedPins = useMemo(() => {
    const items = flattenFeedItems(sessions, "all", planDrafts);
    // A real, editable output is any with an image and a pin index — whether it is
    // still "completed" (not yet planned) OR already "added" to the plan. The old
    // `status === "completed"` filter silently dropped every already-planned Pin, so
    // selecting a scheduled/added card produced an empty Batch Edit ("0 selected").
    return items.filter(i =>
      selectedPinKeys.has(i.entry.key)
      && i.entry.pin
      && (i.entry.status === "completed" || i.entry.status === "added")
      && i.entry.pinIdx !== undefined,
    );
  }, [selectedPinKeys, sessions, planDrafts]);

  const batchPins: BatchPinRow[] = useMemo(() => selectedCompletedPins.map(({ entry, session: sess }) => {
    const pin = entry.pin!;
    // Canonical product resolution — same sources the single-Pin edit modal reads,
    // so linked products never disappear when a generated Pin enters Batch Edit.
    const { primary, tagged } = resolveCanonicalPinProducts({
      metadataDraft:         pin.metadataDraft,
      setupProducts:         sess.setupSnapshot?.selectedProducts,
      productId:             pin.productId,
      creatorProductLinkId:  pin.creatorProductLinkId,
      sourceProductImageUrl: pin.sourceProductImageUrl,
    });
    return {
      pinId: pin.id, sessionId: sess.id, groupIdx: entry.groupIdx, pinIdx: entry.pinIdx!,
      imageUrl: pin.url, title: pin.title, description: pin.description,
      altText: pin.altText, boardSuggestion: pin.metadataDraft?.boardSuggestion ?? "",
      boardId: pin.metadataDraft?.boardId ?? "", boardName: pin.metadataDraft?.boardName ?? "",
      destinationUrl: pin.destinationUrl, plannedDate: pin.plannedDate, plannedTime: pin.plannedTime, plannedAt: pin.plannedAt,
      addedToPlanAt: pin.planningStatus !== "not_added" ? "added" : undefined,
      planningStatus: pin.planningStatus, metadataDraft: pin.metadataDraft,
      // Fall back to the affiliate product context so an Amazon-affiliate Pin always
      // shows its product thumbnail + label in Batch Edit (never "missing").
      linkedProductId: primary?.productId ?? pin.productId,
      linkedProductTitle: primary?.title ?? (pin.creatorProductLinkId ? tr("studio.product.amazonProduct") : undefined),
      linkedProductImageUrl: primary?.imageUrl ?? pin.sourceProductImageUrl,
      linkedProductUrl: primary?.productUrl,
      linkedProductSource: primary?.source,
      isAutoLinked: primary?.linkType === "auto",
      taggedCount: tagged.length,
      primaryProduct: primary,
      taggedProducts: tagged,
      category: sess.setupSnapshot?.category ?? sess.category ?? "",
      setupProducts: sess.setupSnapshot?.selectedProducts ?? [],
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
      contentLanguage: readResolvedContentLanguage(),
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
    toast.success(tr("studio.toast.pinDetailsGeneratedForN").replace("{n}", String(Object.keys(results).length)));
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
    const addedLabel = added === 1 ? tr("studio.toast.addedOnePinToPlan") : tr("studio.toast.addedPinsToPlan").replace("{n}", String(added));
    toast.success(skipped ? `${addedLabel} · ${tr("studio.toast.skippedCount").replace("{n}", String(skipped))}` : addedLabel);
    setSelectedPinKeys(new Set());
  }

  // Batch Edit → Schedule selected. Adds the given pins to the Weekly Plan (no publish
  // readiness gate; missing details are allowed). Selection is preserved (drawer stays open).
  function handleBatchScheduleSelected(pinIds: string[]) {
    const ids = new Set(pinIds);
    let added = 0, already = 0;
    for (const { entry, session } of selectedCompletedPins) {
      if (!ids.has(entry.key) || entry.pinIdx === undefined || !entry.pin) continue;
      if (entry.pin.planningStatus !== "not_added") { already++; continue; }
      const group = session.groups[entry.groupIdx];
      if (!group || group.status !== "done") { already++; continue; }
      addPinToWeeklyPlan(session, entry.pin, session.id, entry.groupIdx, entry.pinIdx, group.status);
      added++;
    }
    if (added === 0) {
      const alreadyLabel = already === 1 ? tr("studio.toast.oneAlreadyScheduled") : tr("studio.toast.nAlreadyScheduled").replace("{n}", String(already));
      toast.info(alreadyLabel);
      return;
    }
    const scheduledLabel = added === 1 ? tr("studio.toast.scheduledOnePin") : tr("studio.toast.scheduledNPins").replace("{n}", String(added));
    toast.success(already ? `${scheduledLabel} · ${tr("studio.toast.nAlreadyScheduledSuffix").replace("{n}", String(already))}` : scheduledLabel);
  }

  // Batch Edit → Publish now (from Studio). Mark published pins Posted through the
  // canonical path: markDraftPosted for pins with a draft + in-memory planningStatus.
  // Card plan state derives Posted from these — no new Studio-only status path.
  function handleBatchPublishComplete(pinIds: string[]) {
    const ids = new Set(pinIds);
    for (const { entry, session } of selectedCompletedPins) {
      if (!ids.has(entry.key) || entry.pinIdx === undefined || !entry.pin) continue;
      const draft = pinDraftStore.getDraftByImageUrl(entry.pin.url);
      if (draft) pinDraftStore.markDraftPosted(draft.id);
      updatePinMetadata(session.id, entry.groupIdx, entry.pinIdx, p => ({ ...p, planningStatus: "posted" }));
    }
    // Outcome toast is owned by the Batch Edit drawer (partial-failure aware), so we
    // don't emit a second toast here — just sync canonical posted state.
  }

  function handleBatchApply(opts: BatchApplyOpts) {
    selectedCompletedPins.forEach(({ entry, session }) => {
      if (entry.pinIdx === undefined || !entry.pin) return;
      const rowEdit = opts.rowEdits[entry.pin.id];
      if (!rowEdit) return;
      updatePinMetadata(session.id, entry.groupIdx, entry.pinIdx, p => {
        let next = { ...p };
        if (rowEdit.title          !== undefined) next = { ...next, title:          rowEdit.title,          metadataTouched: { ...next.metadataTouched, titleTouched:          true } };
        if (rowEdit.description    !== undefined) next = { ...next, description:    rowEdit.description,    metadataTouched: { ...next.metadataTouched, descriptionTouched:    true } };
        if (rowEdit.altText        !== undefined) next = { ...next, altText:        rowEdit.altText,        metadataTouched: { ...next.metadataTouched, altTextTouched:        true } };
        if (rowEdit.destinationUrl !== undefined) next = { ...next, destinationUrl: rowEdit.destinationUrl, metadataTouched: { ...next.metadataTouched, destinationUrlTouched: true } };
        if (rowEdit.plannedDate    !== undefined) next = { ...next, plannedDate:    rowEdit.plannedDate };
        if (rowEdit.plannedTime    !== undefined) next = { ...next, plannedTime:    rowEdit.plannedTime };
        if (rowEdit.plannedAt      !== undefined) next = { ...next, plannedAt:      rowEdit.plannedAt };
        if ((rowEdit.plannedDate !== undefined || rowEdit.plannedTime !== undefined || rowEdit.plannedAt !== undefined) && next.metadataDraft) {
          next = { ...next, metadataDraft: {
            ...next.metadataDraft,
            plannedDate: rowEdit.plannedDate ?? next.plannedDate,
            plannedTime: rowEdit.plannedTime ?? next.plannedTime,
            plannedAt: rowEdit.plannedAt ?? next.plannedAt,
          }};
        }
        if (rowEdit.boardSuggestion !== undefined && next.metadataDraft) {
          next = { ...next, metadataDraft: { ...next.metadataDraft, boardSuggestion: rowEdit.boardSuggestion } };
        }
        // Real Pinterest board selection (canonical boardId/boardName). Only ever set
        // from a real board chosen in the picker — never from category/topic.
        if (rowEdit.boardId !== undefined && next.metadataDraft) {
          next = { ...next, metadataDraft: {
            ...next.metadataDraft,
            boardId:   rowEdit.boardId   || undefined,
            boardName: rowEdit.boardName || undefined,
          }};
        }
        if (rowEdit.products !== undefined && next.metadataDraft) {
          next = { ...next, metadataDraft: writePinProducts(
            next.metadataDraft,
            rowEdit.products.primary,
            rowEdit.products.tagged,
          )};
        } else if (rowEdit.linkedProductTitle !== undefined && next.metadataDraft) {
          next = { ...next, metadataDraft: {
            ...next.metadataDraft,
            linkedProductId:       rowEdit.linkedProductId       ?? undefined,
            linkedProductTitle:    rowEdit.linkedProductTitle     ?? undefined,
            linkedProductUrl:      rowEdit.linkedProductUrl       ?? undefined,
            linkedProductImageUrl: rowEdit.linkedProductImageUrl  ?? undefined,
            linkedProductSource:   rowEdit.linkedProductSource    ?? undefined,
            isAutoLinked:          rowEdit.isAutoLinked           ?? false,
          }};
        }
        if (rowEdit.planningStatus !== undefined) {
          next = { ...next, planningStatus: rowEdit.planningStatus as PlanStatus };
        }
        return next;
      });
      const draft = pinDraftStore.getDraftByImageUrl(entry.pin.url);
      if (draft && (rowEdit.plannedDate !== undefined || rowEdit.plannedTime !== undefined || rowEdit.plannedAt !== undefined)) {
        pinDraftStore.updateDraft(draft.id, {
          scheduledDate: rowEdit.plannedDate ?? draft.scheduledDate,
          scheduledTime: rowEdit.plannedTime ?? draft.scheduledTime,
          plannedAt: rowEdit.plannedAt ?? draft.plannedAt,
        });
      }
    });
    // Autosave: persist silently. The drawer owns per-action feedback and stays open.
  }

  function handleReuseSetup(source: { setupSnapshot?: SetupSnapshot; promptFull?: string }) {
    const snap = source.setupSnapshot;
    const promptText = source.promptFull ?? snap?.promptSnapshot ?? "";
    const legacyReuseMessage = tr("studio.toast.promptLoadedLegacy");
    if (snap) {
      const prodUrls = snap.selectedProducts.map(p => p.imageUrl).filter((u): u is string => !!u);
      const refUrls  = snap.selectedReferences.map(r => r.imageUrl).filter(Boolean);
      // Sync product metadata back to asset store so productUrlToSnapshot() can look it up
      // next time the user clicks Generate (handles Reuse Setup from old/remote sessions).
      snap.selectedProducts.forEach(p => {
        if (!p.imageUrl) return;
        assetStore.saveAsset({
          role: "product",
          source: (p.source as assetStore.AssetSource) ?? "upload",
          imageUrl: p.imageUrl,
          title:       p.title       ?? undefined,
          productUrl:  p.productUrl  ?? undefined,
          sourceDomain: p.sourceDomain ?? undefined,
        });
      });
      if (prodUrls.length) setProducts(prodUrls);
      if (refUrls.length)  setRefs(refUrls);
      if (snap.imagesPerReference) setCount(snap.imagesPerReference);
      if (snap.modelKey && MODEL_KEY_TO_LABEL[snap.modelKey]) setModel(snap.modelKey);
      if (snap.keyword) {
        setOpportunity({ keyword: snap.keyword, category: snap.category ?? "", tier: "steady" });
      }
      if (snap.creativeDirectionSnapshot?.version === 2) {
        const cd = snap.creativeDirectionSnapshot;
        setSystemRecommendations(cd.systemRecommendations);
        setSelectedDirectionId(cd.selectedDirectionId);
        setGuidedControls(cd.guidedControls);
        setCustomInstructions(cd.customInstructions);
        setManualBrief(cd.manualBrief || promptText);
        setManualBriefEdited(cd.manualBriefEdited);
        setInputVersion(cd.inputVersion);
        setLastBriefInputVersion(cd.inputVersion);
        setBriefStale(false);
        setOpportunityContext(cd.opportunityContext);
      }
    }
    if (promptText.trim()) {
      setPrompt(promptText);
      if (!snap?.creativeDirectionSnapshot) {
        setManualBrief(promptText);
        setManualBriefEdited(true);
      }
      promptManuallyEdited.current = true;
    }
    setPinDetailSelection(null);
    toast.success(snap ? tr("studio.toast.setupLoadedIntoComposer") : legacyReuseMessage);
  }

  // ── Generate again from Remix tab (does NOT touch composer state) ────────────

  async function handleGenerateFromRemix(remixSetup: RemixDraftSetup) {
    const remixRefs  = remixSetup.selectedReferences.map(r => r.imageUrl).filter(Boolean) as string[];
    const remixProds = remixSetup.selectedProducts.map(p => p.imageUrl).filter((u): u is string => !!u);
    const refsToUse  = remixRefs.length > 0 ? remixRefs : [null as null];
    const remixCount = remixSetup.imagesPerReference;
    const kw         = remixSetup.keyword  || opportunity?.keyword  || "Pinterest content";
    const cat        = remixSetup.category || opportunity?.category || "";
    const sessionId  = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const remixFormat = remixSetup.format ?? format ?? "2:3";
    const snap: SetupSnapshot = {
      mode: "keyword_led", keyword: kw, category: cat,
      opportunityTitle: remixSetup.opportunityTitle,
      noTextOverlay: remixSetup.noTextOverlay,
      format: remixFormat,
      imagesPerReference: remixCount,
      selectedProducts: remixSetup.selectedProducts,
      selectedReferences: remixSetup.selectedReferences,
      promptSnapshot: remixSetup.prompt, createdFrom: "studio",
      // Preserve the snapshot's saved model (incl. gpt_image); missing/legacy → gemini_image.
      modelKey: remixSetup.modelKey ?? "gemini_image",
      model:    MODEL_KEY_TO_LABEL[remixSetup.modelKey ?? "gemini_image"] ?? "Gemini Image",
    };
    snapshotRegistry.current.set(sessionId, snap);
    recoveryStore.current.set(sessionId, snap);
    saveRemixSetup(sessionId, snap).catch(() => {});
    try { sessionStorage.setItem(`vibepin_setup_${sessionId}`, JSON.stringify(snap)); } catch { /* noop */ }
    const runningEntry: HistoryEntry = {
      id: sessionId, savedAt: new Date().toISOString(),
      keyword: kw, category: cat, source: "studio",
      groups: [], refCount: remixRefs.length, productCount: remixProds.length,
      totalPins: 0, status: "running",
      expectedTotal: refsToUse.length * remixCount,
      promptExcerpt: remixSetup.prompt.slice(0, 120),
      promptFull: remixSetup.prompt, setupSnapshot: snap,
    };
    addHistory(runningEntry);

    const newSession: GenerationSession = {
      id: sessionId, savedAt: new Date().toISOString(),
      keyword: kw, category: cat, source: "studio",
      groups: refsToUse.map((refUrl, idx) => ({
        refUrl, refIndex: idx, items: [], status: "generating" as const, expectedCount: remixCount,
      })),
      status: "generating" as SessionStatus,
      expectedTotal: refsToUse.length * remixCount,
      promptExcerpt: remixSetup.prompt.slice(0, 120),
      productCount: remixProds.length, refCount: remixRefs.length,
      isNew: true, collapsed: false, generatingGroupIdx: 0,
      promptFull: remixSetup.prompt, setupSnapshot: snap,
      model: MODEL_KEY_TO_LABEL[remixSetup.modelKey ?? "gemini_image"] ?? "Gemini Image", format: remixFormat,
      textOverlay: remixSetup.noTextOverlay ? "Off" : "On",
      groupErrors: {},
    };
    setPinDetailSelection(null);
    setSessions(prev => [newSession, ...prev.map(s => ({ ...s, isNew: false, collapsed: false }))]);
    setActiveSessionId(sessionId);

    const finalGroups: RefGroup[] = refsToUse.map((refUrl, idx) => ({
      refUrl, refIndex: idx, items: [], status: "generating" as const, expectedCount: remixCount,
    }));
    const recoverableProductImages = snap.selectedProducts
      .map(p => p.imageUrl)
      .filter((u): u is string => !!u && !u.startsWith("data:"));
    const dbGroups: HistoryPinGroup[] = refsToUse.map(r => ({
      refUrl: r ?? null,
      images: [],
      productImages: recoverableProductImages,
      promptSnapshot: remixSetup.prompt,
      category: cat,
      format: snap.format,
      model: snap.model,
    }));
    let totalGenerated = 0;
    let remixCategoryAudit: CategoryAudit | undefined;

    for (let i = 0; i < refsToUse.length; i++) {
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, generatingGroupIdx: i } : s));
      const ref = refsToUse[i];
      try {
        const resp = await fetch("/api/generate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyword: kw, style: "editorial", count: remixCount,
            prompt: remixSetup.prompt, category: cat,
            ...(ref               ? { style_ref: ref }             : {}),
            ...(remixProds.length ? { product_images: remixProds } : {}),
            text_overlay:       !remixSetup.noTextOverlay,
            reference_strength: "moderate",
            output_type:        inferOutputType(cat),
            format:             snap.format ?? "2:3",
            model_key:          snap.modelKey ?? "gemini_image",
            ...(remixSetup.selectedProducts.length ? {
              product_metadata: remixSetup.selectedProducts.map(p => ({ title: p.title, productUrl: p.productUrl })),
            } : {}),
          }),
        });
        const data = await resp.json() as { urls?: string[]; error?: string; prompt_snapshot?: PromptSnapshot };
        if (!remixCategoryAudit && data.prompt_snapshot?.effective_category !== undefined) {
          remixCategoryAudit = categoryAuditFromSnapshot(data.prompt_snapshot, cat);
        }
        if (data.urls?.length) {
          const sessCtx = { keyword: kw, category: cat, setupSnapshot: snap, promptFull: remixSetup.prompt, generationFinalPrompt: data.prompt_snapshot?.final_prompt };
          const refLabel = ref ? `Reference ${i + 1}` : remixProds.length > 0 ? "Product" : "No product";
          finalGroups[i] = { ...finalGroups[i], items: data.urls.map((url, ii) => createCompletedPin(sessionId, i, ii, url, sessCtx, refLabel)), status: "done" };
          dbGroups[i] = { ...dbGroups[i], refUrl: ref ?? null, images: data.urls };
          totalGenerated += data.urls.length;
        } else {
          finalGroups[i] = { ...finalGroups[i], status: "failed" };
          toast.error(tr("studio.toast.referenceNFailed").replace("{n}", String(i + 1)), { description: data.error ?? tr("studio.toast.noImagesReturned") });
        }
      } catch (err) {
        finalGroups[i] = { ...finalGroups[i], status: "failed" };
        toast.error(tr("studio.toast.networkError"), { description: String(err) });
      }
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, groups: [...finalGroups] } : s));
      addHistory({ ...runningEntry, groups: dbGroups, totalPins: totalGenerated });
    }

    const finalStatus: GenerationStatus = totalGenerated === 0 ? "failed" : totalGenerated < refsToUse.length * remixCount ? "partial" : "completed";
    setSessions(prev => prev.map(s => s.id === sessionId ? {
      ...s, status: finalStatus as SessionStatus, generatingGroupIdx: null,
      ...(remixCategoryAudit ? { categoryAudit: remixCategoryAudit } : {}),
    } : s));
    addHistory({
      ...runningEntry, groups: dbGroups, totalPins: totalGenerated, status: finalStatus,
      ...(remixCategoryAudit ? { categoryAudit: remixCategoryAudit } : {}),
    });
    updateSessionInDb(supabase, sessionId, {
      groups_json: dbGroups,
      pin_urls: dbGroups.flatMap(g => g.images),
      total_pins: totalGenerated,
      status: finalStatus,
      ...(remixCategoryAudit ? { category_audit: remixCategoryAudit } : {}),
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    if (totalGenerated) toast.success(totalGenerated === 1 ? tr("studio.toast.oneNewGenerated") : tr("studio.toast.nNewGenerated").replace("{n}", String(totalGenerated)));
  }

  // ── Picker confirm ────────────────────────────────────────────────────────────

  function onPickerConfirm(items: { id: string; imageUrl: string; source: string; title?: string; productUrl?: string; sourceUrl?: string }[]) {
    const urls = items.map(i => i.imageUrl);
    if (rightPanelMode === "product_picker") {
      // Ensure each product asset is in the store with its full metadata so
      // productUrlToSnapshot() can look it up at generation time.
      items.forEach(item => {
        if (item.productUrl || item.title) {
          assetStore.saveAsset({
            role: "product",
            source: (item.source as assetStore.AssetSource) ?? "upload",
            imageUrl: item.imageUrl,
            title:      item.title      ?? undefined,
            productUrl: item.productUrl ?? item.sourceUrl ?? undefined,
          });
        }
      });
      setProducts(p => { const s = new Set(p); return [...p, ...urls.filter(u => !s.has(u))]; });
    } else {
      setRefs(r => { const s = new Set(r); return [...r, ...urls.filter(u => !s.has(u))]; });
    }
    setRightPanelMode("feed");
  }

  // ── Add to plan ───────────────────────────────────────────────────────────────

  function openSharedPinDetails(sessionId: string, groupIdx: number, pinIdx: number) {
    const session = sessions.find(s => s.id === sessionId);
    const pin = session?.groups[groupIdx]?.items[pinIdx];
    if (!session || !pin?.url) return;
    const existing = pinDraftStore.getDraftByImageUrl(pin.url);
    if (existing) {
      setDetailsModalDraft(existing);
      return;
    }
    const payload = buildWeeklyPlanItemFromGeneratedPin({
      pin: { ...pin, planningStatus: "not_added" },
      session: {
        id: sessionId,
        keyword: session.keyword,
        category: session.category,
        source: session.source,
        status: session.status,
        savedAt: session.savedAt,
        setupSnapshot: pin.setupSnapshot ?? session.setupSnapshot,
        promptFull: session.promptFull,
        model: session.model,
        format: session.format,
      },
      groupStatus: "done",
      keywordFallback: opportunity?.keyword || "Pinterest content",
      categoryFallback: opportunity?.category || "home-decor",
    });
    const draft = payload ? pinDraftStore.createDetailsDraftFromHandoff(payload) : null;
    if (draft) setDetailsModalDraft(draft);
  }

  function syncDetailsDraftToStudio(updated: PinDraft) {
    setDetailsModalDraft(updated);
    setSessions(prev => prev.map(session => ({
      ...session,
      groups: session.groups.map(group => ({
        ...group,
        items: group.items.map(pin => pin.id !== updated.pinId ? pin : ({
          ...pin,
          title: updated.title,
          description: updated.description,
          altText: updated.altText,
          destinationUrl: updated.destinationUrl,
          plannedDate: updated.scheduledDate,
          metadataDraft: updated.metadataDraft ?? pin.metadataDraft,
          weeklyPlanItemId: updated.addedToPlanAt ? updated.id : pin.weeklyPlanItemId,
        })),
      })),
    })));
  }

  function addDetailsDraftToPlan(updated: PinDraft) {
    const session = sessions.find(s => s.groups.some(g => g.items.some(p => p.id === updated.pinId)));
    if (!session) return;
    const groupIdx = session.groups.findIndex(g => g.items.some(p => p.id === updated.pinId));
    const pinIdx = session.groups[groupIdx]?.items.findIndex(p => p.id === updated.pinId) ?? -1;
    const pin = session.groups[groupIdx]?.items[pinIdx];
    if (!pin || groupIdx < 0 || pinIdx < 0) return;
    const merged: StudioPin = {
      ...pin,
      title: updated.title,
      description: updated.description,
      altText: updated.altText,
      destinationUrl: updated.destinationUrl,
      plannedDate: updated.scheduledDate,
      metadataDraft: updated.metadataDraft ?? pin.metadataDraft,
    };
    const result = addPinToWeeklyPlan(session, merged, session.id, groupIdx, pinIdx, session.groups[groupIdx].status);
    if (!result) return;
    const persisted = pinDraftStore.getDraftByImageUrl(updated.imageUrl);
    if (persisted) syncDetailsDraftToStudio(persisted);
    toast.success(tr("studio.toast.addedToPlan"));
  }

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

    // Canonical scheduling: every Add-to-Plan Pin gets a real Smart Schedule slot
    // (plannedDate + plannedTime + plannedAt) — never a date-only / time-less state.
    const scheduled = ensureScheduledPlanTime(draft.id, { date: payload.plannedDate || undefined });
    const finalDraft = scheduled.ok ? scheduled.draft : draft;

    // Debug trace — only for internal/debug users with the flag on. Proves the Pin
    // lands where Weekly Plan can read it (same store, local date inside the week).
    if (SHOW_GENERATION_DEBUG && canViewDebug) {
      const today = new Date();
      const dow = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
      const weekStart = localDateISO(monday);
      const inWeek = !!draft.scheduledDate && draft.scheduledDate >= weekStart;
      console.debug("[add-to-plan]", {
        sourcePage: "studio",
        generatedOutputId: pin.id,
        pinAssetId: draft.pinId ?? draft.id,
        planItemId: draft.id,
        imageUrlPresent: !!draft.imageUrl,
        plannedAt: draft.scheduledDate || "(unscheduled)",
        planStatus: draft.scheduledDate ? "scheduled" : "needs_date",
        detailsStatus: draft.status,
        sessionId, category: draft.category,
        weeklyPlanWeekStart: weekStart,
        includedInVisibleWeek: inWeek,
        reason: !draft.scheduledDate
          ? "no date → Unscheduled / needs-date area"
          : inWeek ? "dated within current week → calendar"
          : "dated outside current week → month view / nav required",
      });
    }

    const planningStatus = payload.planningStatus as PlanStatus;
    const plannedDate = finalDraft.scheduledDate || payload.plannedDate;
    const updated: StudioPin = {
      ...pin,
      title: payload.title,
      description: payload.description,
      altText: payload.altText,
      destinationUrl: payload.destinationUrl,
      planningStatus,
      weeklyPlanItemId: draft.id,
      plannedDate,
      plannedTime: finalDraft.scheduledTime || pin.plannedTime,
      plannedAt: finalDraft.plannedAt || pin.plannedAt,
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
    if (!pin || !pin.url || (group?.status !== "done" && group?.status !== "partial")) return;
    if (pin.planningStatus !== "not_added") { toast.info(tr("studio.toast.alreadyAddedToPlan")); return; }
    const result = addPinToWeeklyPlan(session!, pin, sessionId, groupIdx, pinIdx, group.status);
    if (!result) return;
    const { planningStatus, plannedDate } = result;
    toast.success(plannedDate ? tr("studio.toast.addedToPlan") : tr("studio.toast.addedToPlanNeedsDate"), {
      description: planningStatus === "ready"
        ? (plannedDate ? tr("studio.toast.readyForPublishOn").replace("{date}", plannedDate) : tr("studio.toast.readyForPublish"))
        : plannedDate
          ? tr("studio.toast.needsReviewScheduledOn").replace("{date}", plannedDate)
          : tr("studio.toast.assignDateHint"),
      action: { label: tr("studio.toast.viewInWeeklyPlan"), onClick: () => { window.location.assign("/app/plan"); } },
    });
  }

  // Resolve the RICHEST setup snapshot for a session — the same recovery the detail
  // drawer uses. A history-restored session.setupSnapshot is COMPACT (image URLs
  // stripped for storage), so retry/regenerate must prefer the in-memory registry,
  // the durable IndexedDB recovery store, and sessionStorage, which still carry the
  // real product/reference image URLs. Without this, retry sends a request with NO
  // images and fails again (the "Try again flashes then nothing" bug).
  function resolveRichestSnapshot(session: GenerationSession): {
    snapshot?: SetupSnapshot; source: string;
    productImagesRecovered: number; referenceImagesRecovered: number;
  } {
    const sessionStorageSnap = (() => {
      try {
        const raw = sessionStorage.getItem(`vibepin_setup_${session.id}`)
          ?? localStorage.getItem(`vibepin_setup_${session.id}`);
        return raw ? (JSON.parse(raw) as SetupSnapshot) : null;
      } catch { return null; }
    })();
    const historyEntry = loadHistory().find(h => h.id === session.id) ?? null;
    const score = (s: SetupSnapshot | null): number => s
      ? (s.selectedProducts ?? []).filter(p => !!p.imageUrl).length + (s.selectedReferences ?? []).filter(r => !!r.imageUrl).length
      : -1;
    const labeled: Array<{ source: string; snap: SetupSnapshot | null }> = [
      { source: "snapshotRegistry", snap: snapshotRegistry.current.get(session.id) ?? null },
      { source: "recoveryStore",    snap: recoveryStore.current.get(session.id) ?? null },
      { source: "sessionStorage",   snap: sessionStorageSnap },
      { source: "session",          snap: session.setupSnapshot ?? null },
      { source: "history",          snap: historyEntry?.setupSnapshot ?? null },
    ].filter(c => !!c.snap);
    const best = labeled.reduce<{ source: string; snap: SetupSnapshot } | undefined>(
      (acc, cur) => (acc === undefined || score(cur.snap) > score(acc.snap) ? { source: cur.source, snap: cur.snap! } : acc),
      undefined,
    );
    return {
      snapshot: best?.snap,
      source: best?.source ?? "none",
      productImagesRecovered: (best?.snap?.selectedProducts ?? []).filter(p => !!p.imageUrl).length,
      referenceImagesRecovered: (best?.snap?.selectedReferences ?? []).filter(r => !!r.imageUrl).length,
    };
  }

  // ── Regenerate group ──────────────────────────────────────────────────────────

  async function handleRegenerateGroup(sessionId: string, groupIdx: number) {
    const session = sessions.find(s => s.id === sessionId);
    const group   = session?.groups[groupIdx];
    if (!group) return;

    // Reconstruct the original generation inputs from the stored snapshot.
    // Fall back to current UI state only when the session has no snapshot (legacy).
    const snap          = session?.setupSnapshot;
    const retryPrompt   = snap?.promptSnapshot   ?? session?.promptFull ?? prompt;
    const retryKeyword  = snap?.keyword  ?? session?.keyword  ?? opportunity?.keyword  ?? "Pinterest content";
    const retryCategory = snap?.category ?? session?.category ?? opportunity?.category ?? "";
    const retryCount    = snap?.imagesPerReference ?? count;
    const retryProducts = (snap?.selectedProducts ?? [])
      .map(p => p.imageUrl)
      .filter((u): u is string => u !== null && u !== undefined && u.length > 0);

    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      return { ...s, groups: s.groups.map((g, i) => i !== groupIdx ? g : { ...g, status: "generating" as const, items: [], expectedCount: retryCount }) };
    }));
    try {
      const retryRequestId = `${sessionId}_retry_g${groupIdx}_${Date.now()}`;
      const data = await generateWithRecovery({
        keyword: retryKeyword,
        category: retryCategory,
        prompt: retryPrompt,
        count: retryCount,
        styleRef: group.refUrl,
        productImages: retryProducts,
        outputType: inferOutputType(retryCategory),
        promptMode: snap?.creativeDirectionSnapshot ? "creative_direction_v2" : "legacy",
        promptVersion: snap?.creativeDirectionSnapshot ? 2 : 1,
        creativeDirectionMeta: snap?.creativeDirectionSnapshot,
        // Preserve the session's model on retry (incl. gpt_image); missing → gemini_image.
        modelKey: snap?.modelKey ?? "gemini_image",
        generationRequestId: retryRequestId,
        studioClientId: getStudioClientId(),
      });
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        const nextGroupErrors = { ...(s.groupErrors ?? {}) };
        if (data.urls.length >= retryCount) {
          delete nextGroupErrors[groupIdx];
        } else {
          nextGroupErrors[groupIdx] = {
            message: data.error ?? "No images returned after automatic retries",
            errorType: data.errorType ?? "unknown_error",
          };
        }
        return { ...s, groups: s.groups.map((g, i) => {
          if (i !== groupIdx) return g;
          const refLabel = refLabelForGroup(s, g);
          const sessCtx = { keyword: s.keyword, category: s.category, setupSnapshot: s.setupSnapshot, promptFull: s.promptFull, generationFinalPrompt: data.promptSnapshot?.final_prompt ?? s.generationFinalPrompt };
          const retryStatus: RefGroup["status"] =
            data.urls.length >= retryCount ? "done" : data.urls.length > 0 ? "partial" : "failed";
          return {
            ...g, items: data.urls.map((url, ii) =>
              // Carry product / affiliate context from the prior Pin at this slot so a
              // group regenerate never loses productId, creatorProductLinkId, or destinationUrl.
              preserveAffiliateContextOnRegenerate(
                group.items[ii] ?? group.items[0],
                createCompletedPin(sessionId, groupIdx, ii, url, sessCtx, refLabel),
              )),
            status: retryStatus,
          };
        }), groupErrors: nextGroupErrors };
      }));
    } catch (err) {
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          groups: s.groups.map((g, i) => i !== groupIdx ? g : { ...g, status: "failed" as const }),
          groupErrors: {
            ...(s.groupErrors ?? {}),
            [groupIdx]: { message: String(err), errorType: "unknown_error" as const },
          },
        };
      }));
    }
  }

  // ── Retry EXACTLY ONE failed output ──────────────────────────────────────────
  // Scope = a single output slot (sessionId, groupIdx, outputIndex). It:
  //   • generates exactly ONE image (outputCount = 1), never the original batch count
  //   • never sets the group/sibling to "generating" — only the target slot enters a
  //     per-slot retrying state (group.retryingSlots), so a completed sibling's image,
  //     metadata, and plan state stay byte-for-byte untouched
  //   • keeps the failed output's variantRole/variantInstruction (re-indexed to 1)
  //   • rebuilds image inputs from the snapshot's SOURCE urls/data-urls, so the broken
  //     provider inline_data.data is never reused (backend re-fetches + re-encodes)
  async function handleRetryFailedOutput(sessionId: string, groupIdx: number, outputIndex: number) {
    const session = sessions.find(s => s.id === sessionId);
    const group   = session?.groups[groupIdx];
    if (!group || !session) return;
    // Use the richest recovered snapshot (real image URLs), NOT the compact session copy.
    const recovery = resolveRichestSnapshot(session);
    const snap     = recovery.snapshot;
    const slotId   = outputSlotId(sessionId, groupIdx, outputIndex);
    const plan      = planSingleOutputRetry(outputIndex);

    if (retryGuard.current.has(slotId)) return;         // Part J: duplicate-click guard, per OUTPUT

    const retryPrompt   = snap?.promptSnapshot   ?? session?.promptFull ?? prompt;
    const retryKeyword  = snap?.keyword  ?? session?.keyword  ?? opportunity?.keyword  ?? "Pinterest content";
    const retryCategory = snap?.category ?? session?.category ?? opportunity?.category ?? "";
    const retryProducts = (snap?.selectedProducts ?? [])
      .map(p => p.imageUrl)
      .filter((u): u is string => !!u && u.length > 0);
    const sentRefCount = group.refUrl ? 1 : 0;

    // Step 1 guard: if the original used images but recovery yielded none (and no group
    // ref), we'd send an imageless request that just fails again → show missing-setup,
    // do NOT call /api/generate / LinAPI. Also covers "no setup at all".
    const imageless = shouldBlockImagelessRetry(session.productCount, session.refCount, retryProducts.length, sentRefCount);
    const nothingToSend = retryProducts.length === 0 && sentRefCount === 0 && !retryPrompt.trim();
    if (imageless || nothingToSend) {
      const { title, body } = regenerateErrorCopy("missing_setup");
      toast.error(title, { description: body });
      return;
    }

    retryGuard.current.add(slotId);
    const snapVariationMode =
      ((snap?.creativeDirectionSnapshot as { variationMode?: string } | undefined)?.variationMode === "similar" ? "similar"
        : (snap?.creativeDirectionSnapshot as { variationMode?: string } | undefined)?.variationMode === "distinct" ? "distinct"
        : variationMode) as "distinct" | "similar";
    // Preserve THIS output's variant role/instruction; re-index to 1 since we generate one image.
    const fullVariants = buildOutputVariants(group.expectedCount, snapVariationMode, retryCategory);
    const targetVariant = fullVariants[outputIndex] ?? fullVariants[0];
    const retryVariant: OutputVariant = { ...targetVariant, index: plan.variantIndex };

    const retryModel = snap?.modelKey ?? "gemini_image";
    // Dev-only trace (behind NEXT_PUBLIC_STUDIO_DEBUG_GENERATION) — proves the retry
    // recovered real images and what it is about to send. Never shown in production UI.
    if (SHOW_GENERATION_DEBUG) {
      console.debug("[retry-single-output]", {
        retryOutputId: slotId,
        retrySessionId: sessionId,
        outputIndex,
        variantRole: outputIndex === 0 ? "anchor" : "distinct_variant",
        richestSnapshotSource: recovery.source,
        productImageCountRecovered: recovery.productImagesRecovered,
        referenceImageCountRecovered: recovery.referenceImagesRecovered,
        productImageCountSent: retryProducts.length,
        referenceImageCountSent: sentRefCount,
        model: retryModel,
        siblingStatuses: group.items.map((p, pi) => ({ outputId: p.id, outputIndex: pi, status: "completed" })),
      });
    }

    // Immediate feedback: mark ONLY this slot retrying. items + sibling status unchanged.
    setSessions(prev => prev.map(s => s.id !== sessionId ? s : {
      ...s,
      groups: s.groups.map((g, i) => i !== groupIdx ? g : markOutputRetrying(g, outputIndex)),
    }));

    try {
      const retryRequestId = `${sessionId}_retry_${slotId}_${Date.now()}`;
      const data = await generateWithRecovery({
        keyword: retryKeyword,
        category: retryCategory,
        prompt: retryPrompt,
        count: SINGLE_OUTPUT_RETRY_COUNT,           // Part B: exactly one image, never batch count
        styleRef: group.refUrl,
        productImages: retryProducts,
        outputType: inferOutputType(retryCategory),
        pinFormat: snap?.format ?? "2:3",
        productMetadata: (snap?.selectedProducts ?? []).map(p => ({ title: p.title, productUrl: p.productUrl })),
        promptMode: snap?.creativeDirectionSnapshot ? "creative_direction_v2" : "legacy",
        promptVersion: snap?.creativeDirectionSnapshot ? 2 : 1,
        creativeDirectionMeta: snap?.creativeDirectionSnapshot,
        modelKey: snap?.modelKey ?? "gemini_image",
        outputCount: SINGLE_OUTPUT_RETRY_COUNT,
        variationMode: snapVariationMode,
        outputVariants: [retryVariant],
        retrySingleOutput: true,                     // Part B: backend forces count=1
        retryOfOutputId: slotId,
        retryOutputIndex: outputIndex,
        generationRequestId: retryRequestId,
        studioClientId: getStudioClientId(),
      });
      const newUrl = data.urls[0];
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s;
        const nextErrors = { ...(s.groupErrors ?? {}) };
        return {
          ...s,
          groups: s.groups.map((g, i) => {
            if (i !== groupIdx) return g;
            if (newUrl) {
              const refLabel = refLabelForGroup(s, g);
              const sessCtx = { keyword: s.keyword, category: s.category, setupSnapshot: s.setupSnapshot, promptFull: s.promptFull, generationFinalPrompt: data.promptSnapshot?.final_prompt ?? s.generationFinalPrompt };
              const appendedPin = createCompletedPin(sessionId, groupIdx, g.items.length, newUrl, sessCtx, refLabel);
              const merged = applyRetrySuccess(g, outputIndex, [appendedPin]);  // appends; sibling untouched
              if (merged.status === "done") delete nextErrors[groupIdx];
              return merged;
            }
            // No image came back → revert just this slot to failed; siblings untouched.
            nextErrors[groupIdx] = { message: data.error ?? "This Pin didn't generate — try again.", errorType: data.errorType ?? "unknown_error" };
            return applyRetryFailure(g, outputIndex);
          }),
          groupErrors: nextErrors,
        };
      }));
      if (SHOW_GENERATION_DEBUG) {
        console.debug("[retry-single-output] result", {
          retryOutputId: slotId, retrySessionId: sessionId, model: retryModel,
          status: newUrl ? "completed" : "failed",
          errorType: newUrl ? undefined : data.errorType,
        });
      }
      // Always give visible feedback — never a silent "flash then nothing".
      if (newUrl) toast.success(tr("studio.toast.retrySuccess"));
      else toastGenerationError(data.errorType, data.error, tr);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") console.error("[retry-single-output] failed", err);
      setSessions(prev => prev.map(s => s.id !== sessionId ? s : {
        ...s,
        groups: s.groups.map((g, i) => i !== groupIdx ? g : applyRetryFailure(g, outputIndex)),
        groupErrors: { ...(s.groupErrors ?? {}), [groupIdx]: { message: String(err), errorType: "unknown_error" as const } },
      }));
      toast.error(tr("studio.toast.networkErrorRetry"), { description: tr("studio.toast.tryAgainShortly") });
    } finally {
      retryGuard.current.delete(slotId);
    }
  }

  // ── Regenerate single pin → add ONE new variation ────────────────────────────
  // Goes through the SAME safe path as Generate (generateWithRecovery): reconstructs
  // the full payload from the setup snapshot (products, references, direction brief,
  // selected tags, model, creative-direction meta), sends studioClientId +
  // generationRequestId so the P0 per-user lock keys consistently, never falls back to
  // text-only when images exist, preserves the original Pin (APPENDS a new output), and
  // maps P0 errors (provider_busy / user_generation_limit / configuration_error) to
  // friendly copy. Missing setup → clear message, NO provider call.
  async function handleRegeneratePin(sessionId: string, groupIdx: number, pinIdx: number) {
    const session = sessions.find(s => s.id === sessionId);
    const group   = session?.groups[groupIdx];
    if (!group) return;

    // Richest recovered snapshot (real image URLs), not the compact session copy.
    const snap = session ? resolveRichestSnapshot(session).snapshot : undefined;
    const rp = buildRegeneratePayload(snap, {
      refUrl: group.refUrl,
      fallbackPrompt: session?.promptFull,
      fallbackKeyword: opportunity?.keyword,
      fallbackCategory: opportunity?.category,
    });

    // Step 2 guard: without a usable setup we cannot rebuild a real request → don't call the provider.
    if (!rp.hasSetup) {
      const { title, body } = regenerateErrorCopy("missing_setup");
      toast.error(title, { description: body });
      return;
    }

    try {
      const data = await generateWithRecovery({
        keyword: rp.keyword,
        category: rp.category,
        prompt: rp.prompt,
        count: rp.count,                           // one new variation; obeys MAX_IMAGES_PER_REQUEST
        styleRef: rp.styleRef,
        productImages: rp.productImages,
        textOverlay: rp.textOverlay,
        referenceStrength: "moderate",
        outputType: inferOutputType(rp.category),
        pinFormat: snap?.format ?? "2:3",
        productMetadata: rp.productMetadata,
        modelKey: rp.modelKey,
        promptMode: rp.promptMode,
        promptVersion: rp.promptVersion,
        creativeDirectionMeta: snap?.creativeDirectionSnapshot,
        ...(rp.selectedTags ? { selectedTags: rp.selectedTags } : {}),
        ...(rp.directionBrief ? { directionBrief: rp.directionBrief } : {}),
        productImageCountRequested: rp.productImageCountRequested,
        referenceImageCountRequested: rp.referenceImageCountRequested,
        generationRequestId: `${sessionId}_regen_g${groupIdx}_${Date.now()}`,
        studioClientId: getStudioClientId(),
      });
      const newUrl = data.urls[0];
      if (newUrl) {
        setSessions(prev => prev.map(s => {
          if (s.id !== sessionId) return s;
          return { ...s, groups: s.groups.map((g, i) => {
            if (i !== groupIdx) return g;
            const newIdx = g.items.length;
            const refLabel = refLabelForGroup(s, g);
            const sessCtx = { keyword: s.keyword, category: s.category, setupSnapshot: s.setupSnapshot, promptFull: s.promptFull, generationFinalPrompt: data.promptSnapshot?.final_prompt ?? s.generationFinalPrompt };
            // APPEND — the original Pin is preserved; the regenerated Pin is a new output
            // carrying the same setup snapshot (so Remix works on it too). Affiliate /
            // product context (productId, creatorProductLinkId, destinationUrl) is carried
            // over from the source Pin so Regenerate never loses the product link.
            const sourcePin = g.items[pinIdx] ?? g.items[0];
            const fresh = createCompletedPin(sessionId, groupIdx, newIdx, newUrl, sessCtx, refLabel);
            return { ...g, items: [...g.items, preserveAffiliateContextOnRegenerate(sourcePin, fresh)] };
          })};
        }));
        toast.success(tr("studio.toast.newVariationAdded"));
      } else {
        toastGenerationError(data.errorType, data.error, tr);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "production") console.error("[regenerate-pin] failed", err);
      toast.error(tr("studio.toast.networkErrorRegen"), { description: tr("studio.toast.tryAgainShortly") });
    }
  }

  // ── Add all to plan ───────────────────────────────────────────────────────────

  function handleAddAllToPlan(sessionId: string) {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    let added = 0;
    let skipped = 0;
    for (let gi = 0; gi < session.groups.length; gi++) {
      const group = session.groups[gi];
      if (group.status !== "done" && group.status !== "partial") { skipped += group.items.length; continue; }
      for (let pi = 0; pi < group.items.length; pi++) {
        const pin = group.items[pi];
        if (!canAddGeneratedPinToPlan(group.status, pin)) { skipped++; continue; }
        const result = addPinToWeeklyPlan(session, pin, sessionId, gi, pi, group.status);
        if (result) added++; else skipped++;
      }
    }
    if (added === 0) { toast.info(tr("studio.toast.allAlreadyAdded")); return; }
    const addedLabel = added === 1 ? tr("studio.toast.addedOnePinToWeeklyPlan") : tr("studio.toast.addedPinsToWeeklyPlan").replace("{n}", String(added));
    toast.success(addedLabel, {
      description: skipped > 0 ? tr("studio.toast.skippedNotCompleted").replace("{n}", String(skipped)) : undefined,
    });
  }

  // ── Save draft ────────────────────────────────────────────────────────────────

  function handleSaveDraft() {
    localStorage.setItem("vibepin_studio_draft", JSON.stringify({
      products, refs, prompt: manualBrief || prompt, count, variationMode, opportunity,
      creativeDirection: buildCreativeDirectionSnapshot(manualBrief || prompt),
      savedAt: new Date().toISOString(),
    }));
    toast.success(tr("studio.toast.draftSaved"));
  }

  function handleSelectCreativeDirection(id: string) {
    const direction = derivedRecommendations.find(r => r.id === id);
    setSelectedDirectionId(id);
    const nextBrief = composeCreativeBrief(direction);
    setManualBrief(nextBrief);
    setPrompt(nextBrief);
    setManualBriefEdited(false);
    setLastBriefInputVersion(inputVersion);
    setBriefStale(false);
    promptManuallyEdited.current = false;
  }

  function handleGuidedControlsChange(patch: Partial<GuidedControls>) {
    const next = { ...guidedControls, ...patch };
    setGuidedControls(next);
    if (!manualBriefEdited) {
      const nextBrief = composeCreativeBrief(selectedDirection, next);
      setManualBrief(nextBrief);
      setPrompt(nextBrief);
      setLastBriefInputVersion(inputVersion);
      setBriefStale(false);
    } else {
      setBriefStale(true);
    }
  }

  function handleCustomInstructionsChange(value: string) {
    setCustomInstructions(value);
    if (!manualBriefEdited) {
      const nextBrief = composeCreativeBrief(selectedDirection, guidedControls, value);
      setManualBrief(nextBrief);
      setPrompt(nextBrief);
      setLastBriefInputVersion(inputVersion);
      setBriefStale(false);
    } else {
      setBriefStale(true);
    }
  }

  function handleManualBriefChange(value: string) {
    setManualBrief(value);
    setPrompt(value);
    setManualBriefEdited(true);
    setBriefStale(false);
    promptManuallyEdited.current = true;
  }

  function handleUpdateDirection() {
    const nextBrief = composeCreativeBrief();
    setManualBrief(nextBrief);
    setPrompt(nextBrief);
    setManualBriefEdited(false);
    setLastBriefInputVersion(inputVersion);
    setBriefStale(false);
    promptManuallyEdited.current = false;
  }

  function handleKeepCreativeEdits() {
    setLastBriefInputVersion(inputVersion);
    setBriefStale(false);
  }

  function handleRemoveOpportunityContext() {
    const next = { ...opportunityContext, enabled: false, removable: true as const };
    setOpportunityContext(next);
    if (!manualBriefEdited) {
      const nextBrief = composeCreativeBrief(selectedDirection, guidedControls, customInstructions, next);
      setManualBrief(nextBrief);
      setPrompt(nextBrief);
    } else {
      setBriefStale(true);
    }
  }

  const tc = opportunity ? (TIER_COLOR[opportunity.tier] ?? D.purple) : "";
  const tierKey = opportunity ? TIER_LABEL_KEY[opportunity.tier as keyof typeof TIER_LABEL_KEY] : undefined;
  const tl = opportunity ? (tierKey ? tr(tierKey) : opportunity.tier) : "";
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
        padding: "0 16px", height: 44, background: D.surface,
        borderBottom: `1px solid ${D.border}`,
        flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <p data-testid="page-header-title" style={{ margin: 0, fontSize: "14px", fontWeight: 800, color: D.text }}>{tr("studio.header.title")}</p>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" onClick={handleSaveDraft}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 12px", borderRadius: 20, border: `1px solid ${D.border}`, background: "none", fontSize: "11px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
            {tr("studio.header.saveDraft")}
          </button>
          <button type="button" onClick={() => router.push("/app/history")}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 12px", borderRadius: 20, border: `1px solid ${D.border}`, background: D.cardElev, fontSize: "11px", fontWeight: 600, color: D.textSec, cursor: "pointer" }}>
            <Clock style={{ width: 11, height: 11 }} /> {tr("studio.header.history")}
          </button>
        </div>
      </div>

      {/* Main body: composer + generation feed */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* Left composer panel */}
        <div
          data-testid="composer-panel"
          style={{
            width: "32%", minWidth: 264, maxWidth: 360, flexShrink: 0,
            display: "flex", flexDirection: "column", minHeight: 0,
            borderRight: "none", background: D.card, overflow: "hidden",
          }}
        >
          <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {/* Compact side-by-side asset entries */}
            <div style={{ padding: "8px 12px", borderBottom: `1px solid ${D.border}`, display: "flex", gap: 8 }}>
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

            {canViewDebug ? (
              <>
                <AiUnderstandingPanel
                  productSet={productSetAnalysis}
                  references={referenceContext}
                  intent={inferredIntent}
                />
                <CreativeDirectionPanel
                  recommendations={systemRecommendations.length ? systemRecommendations : derivedRecommendations}
                  selectedDirectionId={selectedDirectionId}
                  subjectOptions={getCategoryPlaybook(creativeCategory).subjectOptions}
                  guidedControls={guidedControls}
                  customInstructions={customInstructions}
                  manualBrief={manualBrief}
                  manualBriefEdited={manualBriefEdited}
                  briefStale={briefStale}
                  opportunityContext={opportunityContext}
                  onSelectDirection={handleSelectCreativeDirection}
                  onGuidedControlsChange={handleGuidedControlsChange}
                  onCustomInstructionsChange={handleCustomInstructionsChange}
                  onManualBriefChange={handleManualBriefChange}
                  onUpdateDirection={handleUpdateDirection}
                  onKeepEdits={handleKeepCreativeEdits}
                  onRemoveOpportunityContext={handleRemoveOpportunityContext}
                />
              </>
            ) : (
              // Normal users: lightweight creative tags + editable Direction brief.
              <CreativeChips
                tags={creativeTags}
                selectedTagIds={selectedTagIds}
                briefValue={customInstructions}
                briefStale={briefStaleFromTags}
                onToggleTag={handleToggleCreativeTag}
                onBriefChange={handleBriefChange}
                onUpdateBriefFromTags={handleUpdateBriefFromTags}
              />
            )}

            {/* Lightweight controls */}
            <div style={{ padding: "12px 14px 16px" }}>
              <p style={{ margin: "0 0 8px", fontSize: "12px", fontWeight: 700, color: D.text }}>{tr("page.studio.pinSettings")}</p>
                {opportunity ? (
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px 4px 10px", borderRadius: 20, background: D.cardElev, border: `1px solid ${D.border}`, marginBottom: 8, width: "fit-content" }}>
                  <span style={{ fontSize: "10px", fontWeight: 700, color: D.text, textTransform: "capitalize" }}>{opportunity.keyword}</span>
                    {tc && <span style={{ fontSize: "9px", fontWeight: 700, color: tc, background: `${tc}20`, padding: "1px 6px", borderRadius: 20 }}>{wsPrimLabel || tl}</span>}
                    {vc && (wsTrendLabel || vl) && <span style={{ fontSize: "9px", fontWeight: 700, color: vc, background: `${vc}20`, padding: "1px 6px", borderRadius: 20 }}>{wsTrendLabel || vl}</span>}
                  <button type="button" onClick={() => { setOpportunity(null); setWsEntry(false); setOpportunityContext({ enabled: false, removable: true }); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: D.textSec, display: "flex", padding: "0 2px" }}>
                      <X style={{ width: 10, height: 10 }} />
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setOppDrawerOpen(true)}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 20, border: `1px solid ${D.border}`, background: D.cardElev, fontSize: "11px", fontWeight: 500, color: D.textSec, cursor: "pointer", marginBottom: 8 }}>
                  <Target style={{ width: 10, height: 10 }} /> {tr("page.studio.addOpportunity")}
                  </button>
                )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Dropdown label={tr("page.studio.numberOfPins")} value={count} options={[1,2,3,4].map(n => ({ value: n, label: String(n) }))} onChange={setCount} />
                <Dropdown label={tr("studio.settings.model")} value={model} options={MODEL_OPTIONS as unknown as { value: string; label: string }[]} onChange={setModel} />
              </div>
              <div style={{ marginTop: 8 }}>
                <Dropdown
                  label={tr("studio.settings.results")}
                  value={variationMode}
                  options={[
                    { value: "similar",  label: tr("studio.settings.similarOptions") },
                    { value: "distinct", label: tr("studio.settings.moreVariety") },
                  ]}
                  onChange={setVariationMode}
                />
                {variationMode === "distinct" && (
                  <p data-testid="results-variety-helper" style={{ margin: "5px 0 0", fontSize: "10px", lineHeight: 1.4, color: D.textMuted }}>
                    {tr("studio.settings.moreVarietyHint")}
                  </p>
                )}
              </div>
              <div style={{ marginTop: 8 }}>
                <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: D.textSec }}>
                  {tr("page.studio.aspectRatio")}
                  <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 500, color: D.textMuted }}>{tr("studio.settings.recommendedRatio")}</span>
                </p>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {(["2:3","4:5","3:4","1:1","9:16","16:9"] as const).map(r => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setFormat(r)}
                      style={{
                        padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
                        border: `1px solid ${format === r ? D.purple : D.border}`,
                        background: format === r ? "rgba(124,58,237,0.18)" : D.cardElev,
                        color: format === r ? "#C4B5FD" : D.textSec,
                        transition: "all 0.1s",
                      }}
                    >
                      {r}
                    </button>
                  ))}
                    </div>
              </div>
                      {overLimit && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 10 }}>
                          <AlertCircle style={{ width: 11, height: 11, color: D.warning }} />
                          <span style={{ fontSize: "10px", color: D.warning, fontWeight: 600 }}>
                            {tr("studio.settings.overLimitWarning").replace("{n}", String(totalPins))}
                          </span>
                        </div>
                      )}
                    </div>
          </div>

          {/* Developer-only AI Direction Summary */}
          {canViewDebug && (
          <div style={{ padding: "0 14px 12px", flexShrink: 0 }}>
            <div style={{
              padding: "8px 10px", borderRadius: 8,
              background: "rgba(124,58,237,0.08)", border: "1px solid rgba(124,58,237,0.2)",
            }}>
              <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 700, color: "#A78BFA", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                {tr("studio.debug.aiDirection")}
              </p>
              {enhancerSummary ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {([
                    [tr("studio.debug.scene"),    enhancerSummary.scene],
                    [tr("studio.debug.style"),    enhancerSummary.style],
                    [tr("studio.debug.layout"),   enhancerSummary.layout],
                    [tr("studio.debug.products"), enhancerSummary.products],
                  ] as [string, string | undefined][]).filter(([, v]) => v).map(([label, value]) => (
                    <div key={label} style={{ display: "flex", gap: 4, alignItems: "baseline" }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: "#7C3AED", minWidth: 44 }}>{label}</span>
                      <span style={{ fontSize: 10, color: D.textSec }}>{value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 10, color: D.textMuted, fontStyle: "italic" }}>
                  {tr("studio.debug.willAnalyze")}
                </p>
              )}
            </div>
          </div>
          )}

          {canViewDebug && (
          <div data-testid="generation-debug-overlay" style={{ padding: "0 14px 12px", flexShrink: 0 }}>
            <div style={{
              padding: "8px 10px", borderRadius: 8,
              background: "rgba(15,23,42,0.82)", border: "1px solid rgba(148,163,184,0.22)",
              boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
            }}>
              <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 800, color: "#C4B5FD", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                {tr("studio.debug.developerDebug")}
              </p>
              <p style={{ margin: "0 0 6px", fontSize: 9, color: D.textMuted, fontWeight: 700 }}>
                {tr("studio.debug.referenceMode")} {referenceInfluenceMode}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <div>
                  <p style={{ margin: 0, fontSize: 9, color: D.textMuted, fontWeight: 700 }}>{tr("studio.debug.products")}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 14, color: D.text, fontWeight: 900 }}>{tr("studio.debug.imagesCount").replace("{n}", String(products.length))}</p>
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 9, color: D.textMuted, fontWeight: 700 }}>{tr("page.studio.references")}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 14, color: D.text, fontWeight: 900 }}>{tr("studio.debug.imagesCount").replace("{n}", String(refs.length))}</p>
                </div>
              </div>
              <div style={{ marginTop: 7, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <div>
                  <p style={{ margin: "0 0 3px", fontSize: 9, color: D.textMuted, fontWeight: 700 }}>{tr("studio.debug.productsWeight")}</p>
                  <div style={{ height: 5, borderRadius: 99, background: "rgba(148,163,184,0.16)", overflow: "hidden" }}>
                    <div style={{ width: `${productWeight}%`, height: "100%", background: "#38BDF8" }} />
                  </div>
                  <p style={{ margin: "3px 0 0", fontSize: 10, color: D.textSec, fontWeight: 800 }}>{productWeight}%</p>
                </div>
                <div>
                  <p style={{ margin: "0 0 3px", fontSize: 9, color: D.textMuted, fontWeight: 700 }}>{tr("studio.debug.referencesWeight")}</p>
                  <div style={{ height: 5, borderRadius: 99, background: "rgba(148,163,184,0.16)", overflow: "hidden" }}>
                    <div style={{ width: `${referenceWeight}%`, height: "100%", background: "#A855F7" }} />
                  </div>
                  <p style={{ margin: "3px 0 0", fontSize: 10, color: D.textSec, fontWeight: 800 }}>{referenceWeight}%</p>
                </div>
              </div>
            </div>
          </div>
          )}

          {/* Product selection lives only in the top Products section — the duplicated
              lower locked product card was removed. Pin Settings holds only actual
              Pin configuration fields. */}

          {/* Primary CTA */}
          <div style={{ padding: "12px 16px 16px", borderTop: `1px solid ${D.border}`, flexShrink: 0, background: D.card }}>
                <button
                  type="button"
                  data-testid="generate-btn"
              disabled={!hasInput || isSubmitting}
                  onClick={handleGenerate}
                  style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                width: "100%", padding: "12px 20px", borderRadius: 12, border: "none",
                fontSize: "13px", fontWeight: 800,
                background: hasInput && !isSubmitting ? D.gradient : "rgba(124,58,237,0.25)",
                    color: "#fff",
                cursor: hasInput && !isSubmitting ? "pointer" : "not-allowed",
                boxShadow: hasInput && !isSubmitting ? "0 4px 16px rgba(124,58,237,0.3)" : "none",
              }}
            >
              {isSubmitting ? (
                <>
                  <div style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                  {tr("studio.header.submitting")}
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
            planDrafts={planDrafts}
            filter={feedFilter}
            onFilterChange={setFeedFilter}
            onAddToPlan={handleAddToPlan}
            onAddAllToPlan={handleAddAllToPlan}
            onRegeneratePin={handleRegeneratePin}
            onRegenerateGroup={handleRegenerateGroup}
            onRetryOutput={handleRetryFailedOutput}
            onEditInputs={(sessionId) => { const s = sessions.find(x => x.id === sessionId); if (s) handleReuseSetup(s); }}
            pinDetailOpen={pinDetailSelection !== null && pinDetailView !== null}
            pinDetailInitialTab={pinDetailSelection?.initialTab ?? "remix"}
            pinDetail={pinDetailView}
            metadataForm={metadataForm}
            pinDetailsGenStatus={pinDetailsGenStatus}
            readinessLabel={pinReadinessLabel}
            isDirty={isFormDirty}
            showSaved={showSaved}
            onRetryGenerateDetails={handleRetryGenerateDetails}
            onOpenPinDetail={(sessionId, entryKey, tab) => {
              if (tab === "plan") {
                const item = flattenFeedItems(sessions, "all").find(x => x.entry.sessionId === sessionId && x.entry.key === entryKey);
                if (item?.entry.pinIdx !== undefined) openSharedPinDetails(sessionId, item.entry.groupIdx, item.entry.pinIdx);
                return;
              }
              setPinDetailSelection({ sessionId, entryKey, initialTab: tab ?? "remix" });
            }}
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
              toast.success(tr("studio.toast.addedToPlan"), {
                description: planningStatus === "ready" ? tr("studio.toast.readyOn").replace("{date}", plannedDate || tr("studio.toast.scheduled")) : tr("studio.toast.needsReview"),
              });
            }}
            onPinDetailRegenerate={() => {
              if (!pinDetailView || pinDetailView.pinIdx === undefined) return;
              handleRegeneratePin(pinDetailView.sessionId, pinDetailView.groupIdx, pinDetailView.pinIdx);
            }}
            onPinDetailSaveAsReference={() => toast.success(tr("studio.toast.savedAsReference"))}
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
              handleGenerateFromRemix(remixSetup);
            }}
            canViewDebug={canViewDebug}
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
            onBatchScheduleSelected={handleBatchScheduleSelected}
            onBatchPublishComplete={handleBatchPublishComplete}
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

      <PinDetailsModal
        draft={detailsModalDraft}
        open={detailsModalDraft !== null}
        source="create_pins"
        mode="details"
        onClose={() => setDetailsModalDraft(null)}
        onSaved={syncDetailsDraftToStudio}
        onAddToPlan={addDetailsDraftToPlan}
      />

      <OpportunityDrawer
        open={oppDrawerOpen}
        inferredCategory={creativeCategory}
        onClose={() => setOppDrawerOpen(false)}
        onSelect={o => {
          setOpportunity(o);
          setOpportunityContext({
            enabled: true,
            removable: true,
            title: o.keyword,
            keyword: o.keyword,
            category: o.category,
            source: "studio",
          });
          if (!manualBriefEdited) {
            const nextBrief = buildComposerPrompt(o.keyword, o.category, products.length > 0);
            setManualBrief(nextBrief);
            setPrompt(nextBrief);
          } else {
            setBriefStale(true);
          }
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
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 16px;
          align-items: start;
          width: 100%;
        }
        @media (min-width: 1400px) {
          .pin-feed-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
          }
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
  // Resolve WHICH Studio experience to render as one atomic decision, so the legacy
  // Studio (and its heavy history/DB/generation-feed effects) never mounts when V2
  // is intended — no legacy flash, no wasted network calls.
  //
  // The env decision (NEXT_PUBLIC_STUDIO_BOARD_V2) is build-time inlined, so it is
  // identical on the server render and the first client render → used as the INITIAL
  // state (not resolved in an effect). That means when the env flag is set, the very
  // first paint is already the correct experience with no hydration mismatch.
  //
  // Only when the env var is UNSET do we defer to the client-only localStorage
  // override. In that (dev/local) window the initial state is "resolving" and we show
  // a neutral, board-shaped skeleton — never the legacy Studio.
  const { t: tr } = useLocale();
  const envDecision = resolveStudioExperienceFromEnv();
  const [experience, setExperience] = useState<StudioExperience>(envDecision ?? "resolving");

  useEffect(() => {
    if (envDecision === null) setExperience(resolveStudioExperienceFromClient());
  }, [envDecision]);

  if (experience === "board-v2") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--app-bg, #F8FAFC)", overflow: "hidden", minHeight: 0 }}>
        <StudioBoard />
      </div>
    );
  }

  if (experience === "resolving") {
    // Env unset → waiting one tick to read the localStorage override. Neutral shell,
    // never legacy. Board-shaped so switching to V2 causes no layout shift.
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--app-bg, #F8FAFC)", overflow: "hidden", minHeight: 0 }}>
        <StudioBoardSkeleton />
      </div>
    );
  }

  return (
    <Suspense fallback={<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--app-text-sec, #8892A4)", fontSize: "13px", background: "var(--app-bg, #0B0E17)" }}>{tr("common.loading")}</div>}>
      <CreatePinsContent />
    </Suspense>
  );
}
