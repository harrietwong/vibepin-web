/**
 * pinDraftStore.ts
 *
 * Client-side Pin Draft store backed by localStorage.
 * A Pin Draft is created when a generated image is added to Weekly Plan.
 * It carries copy (title, description, alt text), destination URL, board, and status.
 *
 * All functions are synchronous and safe to call during renders.
 * Emits DRAFT_STORE_EVENT on window after every write so listeners can re-read.
 */

import { writePinProducts, type LinkedProduct, type MetadataTouchedFlags, type PinMetadataDraft } from "./pinMetadata";
import * as pinMetadataStore from "./pinMetadataStore";
import type { SetupSnapshot } from "./studioPersistence";
import {
  combineLocalPlannedAt,
  draftStatusFromPlanningStatus,
  sanitizeHandoffField,
  type WeeklyPlanItemPayload,
} from "./weeklyPlanHandoff";
import { getContentTemplates } from "./i18n/contentTemplates";
import { readResolvedContentLanguage, type LanguageCode } from "./i18n/config";

const STORE_KEY       = "vp:pin_drafts:v1";
const MAX_DRAFTS      = 500;
export const DRAFT_STORE_EVENT = "vp:pin_drafts_updated";

// Monotonic version + cached snapshot so useSyncExternalStore gets a STABLE array
// reference between writes (returning a fresh array from getSnapshot each call causes
// infinite re-render loops). `emit()` bumps the version on every write.
let _version = 0;
let _snapshot: PinDraft[] = [];
let _snapshotVersion = -1;
const EMPTY_DRAFTS: PinDraft[] = [];

/**
 * The IANA timezone the current user's wall-clock schedule is expressed in (RC0 WP2).
 * Stamped onto a draft whenever plannedAt is (re)computed from date+time so the server can
 * resolve the wall-clock to a real UTC instant (promote.ts::buildScheduledAt) instead of
 * mis-reading it as UTC. Empty string when Intl is unavailable → server keeps legacy UTC
 * behavior for that draft. Never throws; safe to call during renders / SSR.
 */
export function resolveScheduleTimezone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type DraftStatus = "needs_review" | "needs_link" | "ready";

export interface PinDraft {
  id:                  string;
  imageUrl:            string;
  keyword:             string;
  category:            string;
  title:               string;
  description:         string;
  altText:             string;
  destinationUrl:      string;   // product / affiliate / landing page link
  boardId:             string;
  boardName:           string;
  weeklyPlanItemId:    string;
  generationSessionId: string;
  scheduledDate:       string;   // ISO date string, auto-assigned on Add to Plan
  scheduledTime?:      string;   // "HH:mm" 24h posting slot, optional
  plannedAt?:          string;   // local YYYY-MM-DDTHH:mm, no UTC conversion
  scheduleTimezone?:   string;   // IANA zone the plannedAt wall-clock was set in (RC0 WP2)
  status:              DraftStatus;
  createdAt:           string;
  updatedAt:           string;
  // ── Extended handoff fields (Studio → Weekly Plan) ─────────────────────────
  pinId?:              string;
  planningStatus?:     "ready" | "needs_review";
  generationStatus?:   string;
  metadataDraft?:      PinMetadataDraft;
  metadataTouched?:    MetadataTouchedFlags;
  setupSnapshot?:      SetupSnapshot;
  promptSnapshot?:     string;
  opportunity?:        string;
  source?:             string;
  format?:             string;
  model?:              string;
  addedToPlanAt?:      string;
  pinCreatedAt?:       string;
  postedAt?:           string;
  /** Set when placed via Smart Schedule / Auto Schedule. */
  autoScheduled?:      boolean;
  /** How the current publish time was decided. "smart" = Smart Schedule (eligible
   *  for rebalance); "manual" = user explicitly set date/time (skipped by rebalance).
   *  Legacy drafts without this are treated as "smart". */
  scheduleSource?:     "smart" | "manual";
  /** True when the user manually pinned the time; rebalance must never move it. */
  scheduleLocked?:     boolean;
  linkedProducts?:     LinkedProduct[];
  primaryProductId?:   string;
  // ── Amazon affiliate product link (creator-owned) ──────────────────────────
  /** Library product this Pin was generated from. */
  productId?:          string;
  /** Reusable creator-owned affiliate link (CreatorProductLink.id). */
  creatorProductLinkId?: string;
  /** Stable product image reference — survives generate / regenerate. */
  sourceProductImageUrl?: string;
  /** How destinationUrl was set: "creator_affiliate_product" | "manual" | "" (auto/product). */
  destinationUrlSource?: string;
  // ── Create Pins board (studioBoardV2) ──────────────────────────────────────
  /** AI‑Pin → source‑upload relationship of record (the reliable link). */
  parentDraftId?:      string;
  /** Snapshot of the parent's image at generation time — display only, NOT the link. */
  sourceImageUrl?:     string;
  /** User‑approved tags/hashtags. `metadataDraft.topics` stays the raw AI result. */
  tags?:               string[];
  /** Server-side generation id (generateAiVersions → generation_request_id) captured when
   *  an AI image resolves this card. Lets the AI-adoption metric join on a stable id
   *  instead of fragile image-URL string matching. Rides the payload sync — no migration. */
  sourceGenerationId?: string;
  /** Stable per-asset key for this generated card (the card's idempotencyKey), so a draft
   *  keeps a durable handle to which generated asset it is even if its imageUrl changes. */
  sourceAssetKey?:     string;
  /** Remote Pinterest Pin id captured after a successful publish. */
  remotePinId?:        string;
  /** Real Pinterest Pin URL returned at publish time. Legacy drafts (published
   *  before this field existed) fall back to reconstructing the URL from remotePinId. */
  remotePinUrl?:       string;
  /** Last publish error message. Present ⇒ lifecycle is "failed" until retried. */
  publishError?:       string;
  // ── Failure semantics (PRD WP-B §11.5) ──────────────────────────────────────
  // Optional; drafts persisted before this feature keep working unchanged. All ride
  // the pin_drafts payload sync automatically (whole draft is serialized — no field
  // whitelist in pinDraftSync.flush) — no migration.
  /** What kind of failure produced the "failed" lifecycle. */
  failureType?:        "generation" | "publish";
  /** Coarse failure bucket for retry framing (drives Banner/Retry copy). */
  errorCategory?:      "transient" | "content" | "auth";
  /** The scheduled time (ISO) this Pin had before a failed publish cleared it — so a
   *  future "reschedule" affordance can offer to restore it. */
  previousScheduledTime?: string;
  /** Raw publish error code from the API (e.g. "board_not_owned"); internal, not shown. */
  publishErrorCode?:   string;
  /** Set when the stored image URL is not publicly usable (blocks publish). */
  assetError?:         string;
  /** Explicit dedup key for board creation (upload / generation / migration). */
  idempotencyKey?:     string;
  /** WP3-P1: generation_jobs row id when this placeholder was created via the
   *  worker-mode enqueue path. Used to resume polling after a refresh (P2 reconcile);
   *  P1 only sets/clears it during the live in-page poll. */
  generationJobId?:    string;
  /** WP3-P2: this placeholder's index into the generation_jobs row's `results[]`
   *  array. Stamped at creation time (StudioBoard's worker-mode enqueue maps
   *  placeholders[i] ↔ slot i 1:1). Reconcile-after-reload matches a reloaded
   *  draft back to its job result by this field, not by array order — order is
   *  not stable across a localStorage reload. */
  generationSlot?:     number;
  /** Set when the card is archived off the active board (recoverable). */
  archivedAt?:         string;
  // ── Async image analysis (AI Copy v5 — computed at upload time) ─────────────
  // All optional so drafts persisted before this feature keep working unchanged.
  /** Lifecycle of the background image analysis started right after upload. */
  imageAnalysisStatus?:    "pending" | "ready" | "failed";
  /** 1-2 sentence description of what is visible in the image. */
  imageSummary?:           string;
  visibleObjects?:         string[];
  colors?:                 string[];
  /** Visual style/mood, e.g. "mid-century modern". */
  style?:                  string;
  /** Text detected in the image (OCR); "" when none. */
  ocrText?:                string;
  /** Vision-detected content category. Distinct from `category` (user/board category). */
  imageCategory?:          string;
  imageAnalysisModel?:     string;
  imageAnalysisUpdatedAt?: string;
  // ── Recommended high-search Pinterest keywords (computed after analysis) ─────
  keywordStatus?:          "pending" | "ready" | "failed";
  recommendedKeywords?:    string[];
  keywordSource?:          "pinterest_high_search";
  keywordUpdatedAt?:       string;
  // ── Creative-Intelligence selections (PRD v0.2 Phase A/B) ────────────────────
  // Channel + storage ready this phase; the writer lands in Phase B. Round-trips
  // to the server via `payload`; also promoted to pin_drafts.creative_selections.
  creativeSelections?:     CreativeSelections;
  // ── Quality Judge (PRD v0.2 §5.5, Phase C) ───────────────────────────────────
  // Only ever set on AI-generated result cards (never on uploads). Rides the v38
  // payload sync automatically — no migration. Scores/reasons are INTERNAL (never
  // shown to users); only an `invalid` verdict changes the card (collapsed/dimmed).
  qualityJudge?:           QualityJudge;
}

// The Quality Judge grader (lib/ai-copy/judgeVerdict.ts, its startQualityJudge runner,
// and /api/quality-judge) is a separate RC0 cluster and is not yet committed. The draft
// only ever STORES a judge result and PinBoardCard only READS verdict/status/userOverride,
// so these result types are inlined here rather than imported — that keeps the persisted
// shape and the card's display gate intact without pulling the grader in. Keep in sync
// with judgeVerdict.ts when that cluster lands.
export type QualityScoreKey =
  | "productPreservation" | "realism" | "creatorLikeness" | "sceneFit"
  | "pinterestFit" | "composition" | "artifacts" | "safety";
export type QualityScores = Partial<Record<QualityScoreKey, number>>;
export type QualityVerdict = "ok" | "borderline" | "invalid";

/**
 * Quality Judge result cached on a generated draft. `status` mirrors the async
 * image-analysis state machine. `scores`/`reasons`/`overall` are internal diagnostics
 * (for analytics/training) — never rendered. `userOverride` records a "Show anyway" click.
 */
export interface QualityJudge {
  status:        "pending" | "ready" | "failed";
  verdict?:      QualityVerdict;
  scores?:       QualityScores;
  overall?:      number;
  /** Short internal diagnostic notes from the grader. NEVER shown to the user. */
  reasons?:      string[];
  judgeVersion:  string;
  updatedAt:     string;
  /** True once the user clicked "Show anyway" on an invalid-verdict card. */
  userOverride?: boolean;
}

/** Minimal summary of the creative direction the user picked in the AI Image drawer.
 *  Enough to (a) record the choice and (b) feed AI Copy a direction hint — never the
 *  full recommendation object. */
export interface SelectedCreativeDirection {
  id:      string;
  title:   string;
  /** A few scene/style terms (from the direction's prompt hints) — copy context only. */
  terms?:  string[];
}

/**
 * User creative choices captured in the Creative-Intelligence flow.
 * All optional — a draft created before this feature keeps working unchanged.
 */
export interface CreativeSelections {
  /** The creative direction the user picked (id/name/terms summary). */
  selectedDirection?:    SelectedCreativeDirection;
  /** Reference-sample ids the user kept. */
  selectedReferenceIds?: string[];
  /** Reference-sample ids the user dismissed. */
  rejectedReferenceIds?: string[];
  /** Recommended keywords the user removed (wire a remove-chip UI here when one exists). */
  removedKeywords?:      string[];
}

/** Board card origin. Kept as string on PinDraft for back‑compat; these are the v2 values. */
export type PinBoardSource = "uploaded_image" | "ai_generated_from_upload";

/** True for Create Pins v2 board‑origin drafts (uploads / AI pins). */
export function isBoardSource(d: Pick<PinDraft, "source">): boolean {
  return d.source === "uploaded_image" || d.source === "ai_generated_from_upload";
}

interface StoreData {
  drafts: Record<string, PinDraft>;
}

// ── Internal I/O ─────────────────────────────────────────────────────────────

function ok(): boolean { return typeof window !== "undefined"; }

// In-memory session cache: the source of truth once loaded; localStorage is the
// durable mirror. Without this, a failed persist() (quota) silently DISCARDED the
// mutation — the next load() re-read stale localStorage and the user's edit was
// lost while the UI claimed "Saved". With it, edits survive in memory, the failure
// is observable (hasPersistFailure), and retryPersist() can recover.
let _memData: StoreData | null = null;
let _persistFailed = false;

function load(): StoreData {
  if (!ok()) return { drafts: {} };
  if (_memData) return _memData;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<StoreData>) : {};
    _memData = { drafts: p.drafts ?? {} };
  } catch { _memData = { drafts: {} }; }
  return _memData;
}

function persist(data: StoreData): void {
  if (!ok()) return;
  const sorted = Object.values(data.drafts)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_DRAFTS);
  const trimmed: StoreData = {
    drafts: Object.fromEntries(sorted.map(d => [d.id, d])),
  };
  // Memory always reflects the latest state — even when the disk write fails.
  _memData = trimmed;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
    _persistFailed = false;
  } catch {
    // Quota exceeded / storage unavailable. Edits stay in memory; surface the
    // failure so the UI can show "Failed to save · Retry" instead of "Saved".
    _persistFailed = true;
  }
}

/** True while the last localStorage write failed (edits are memory-only). */
export function hasPersistFailure(): boolean { return _persistFailed; }

/** Re-attempt writing the in-memory store to localStorage. Emits on state change. */
export function retryPersist(): boolean {
  if (!ok() || !_memData) return true;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(_memData));
    _persistFailed = false;
  } catch {
    _persistFailed = true;
  }
  emit();
  return !_persistFailed;
}

/** Test-only: reset the in-memory cache/failure flag (e.g. after seeding storage). */
export function __resetMemoryCacheForTests(): void {
  _memData = null;
  _persistFailed = false;
}

function emit(): void {
  _version++; // invalidates the cached snapshot (see getSnapshot)
  if (ok()) window.dispatchEvent(new Event(DRAFT_STORE_EVENT));
}

// ── useSyncExternalStore surface ───────────────────────────────────────────────

/** Subscribe to store writes (React external‑store contract). */
export function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(DRAFT_STORE_EVENT, cb);
  return () => window.removeEventListener(DRAFT_STORE_EVENT, cb);
}

/** Stable snapshot: same array reference until the next write bumps `_version`. */
export function getSnapshot(): PinDraft[] {
  if (_snapshotVersion !== _version) {
    _snapshot = getAllDrafts();
    _snapshotVersion = _version;
  }
  return _snapshot;
}

/** Stable empty reference for SSR / server snapshot. */
export function getServerSnapshot(): PinDraft[] { return EMPTY_DRAFTS; }

export function getStoreVersion(): number { return _version; }

function genId(): string {
  return `pd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Recompute draft status from required publish fields (destination URL not required). */
export function recomputeDraftStatus(draft: Pick<PinDraft, "title" | "description" | "scheduledDate">): DraftStatus {
  const hasTitle = !!sanitizeHandoffField(draft.title);
  const hasDesc  = !!sanitizeHandoffField(draft.description);
  const hasDate  = !!sanitizeHandoffField(draft.scheduledDate);
  return hasTitle && hasDesc && hasDate ? "ready" : "needs_review";
}

// ── Copy generation ───────────────────────────────────────────────────────────

function generateCopy(keyword: string, category: string, contentLanguage?: LanguageCode): {
  title: string;
  description: string;
  altText: string;
} {
  const lang = contentLanguage ?? readResolvedContentLanguage();
  const tpl = getContentTemplates(lang);
  const kw = keyword.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const catLabel = category.replace(/-/g, " ");
  const titles = tpl.titles({ kw, audience: tpl.audience(category), room: kw, style: "aesthetic", productTitle: "", pinIndex: 0 });
  const descs  = tpl.descriptions({ kw, catLabel, mood: "aesthetic", promptSnippet: "" });
  const alts   = tpl.alt({ subject: kw, mood: "aesthetic", pinIndex: 0 });
  return {
    title:       titles[0] ?? kw,
    description: descs[0]  ?? "",
    altText:     alts[0]   ?? kw,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Create a new PinDraft for a generated image.
 * Idempotent: if a draft with the same imageUrl already exists, returns it unchanged.
 */
export function createDraft(input: {
  imageUrl:             string;
  keyword:              string;
  category:             string;
  title?:               string;
  description?:         string;
  altText?:             string;
  destinationUrl?:      string;
  weeklyPlanItemId?:    string;
  generationSessionId?: string;
  scheduledDate?:       string;
  contentLanguage?:     LanguageCode;
}): PinDraft {
  const data = load();

  // Idempotent: skip duplicate for same image
  const existing = Object.values(data.drafts).find(d => d.imageUrl === input.imageUrl);
  if (existing) return existing;

  const generated = generateCopy(input.keyword, input.category, input.contentLanguage);
  const copy = {
    title:       input.title?.trim()       || generated.title,
    description: input.description?.trim() || generated.description,
    altText:     input.altText?.trim()     || generated.altText,
  };
  const now  = new Date().toISOString();

  const draft: PinDraft = {
    id:                  genId(),
    imageUrl:            input.imageUrl,
    keyword:             input.keyword,
    category:            input.category,
    title:               copy.title,
    description:         copy.description,
    altText:             copy.altText,
    destinationUrl:      input.destinationUrl?.trim() ?? "",
    boardId:             "",
    boardName:           "",
    weeklyPlanItemId:    input.weeklyPlanItemId ?? "",
    generationSessionId: input.generationSessionId ?? "",
    scheduledDate:       input.scheduledDate ?? "",
    status:              (
      copy.title && copy.description && (input.scheduledDate?.trim())
        ? "ready" as const
        : "needs_review" as const
    ),
    createdAt:           now,
    updatedAt:           now,
  };

  data.drafts[draft.id] = draft;
  persist(data);
  emit();
  return draft;
}

/**
 * Create a Create Pins **board** draft (uploaded image or AI‑generated pin).
 *
 * Unlike createDraft, this is NOT deduped by imageUrl — the same image URL may
 * legitimately back many drafts (re‑upload, duplicate, repeated provider URLs).
 * Dedup happens ONLY when the same explicit `idempotencyKey` is resubmitted
 * (e.g. `${uploadBatchId}:${fileIndex}`, `generation:${reqId}:${i}`,
 * `legacy:${entryId}:${g}:${i}`). Omit the key to always create a new draft.
 *
 * Uploaded drafts are created with NO addedToPlanAt/scheduledDate, so they stay on
 * the Studio board and never leak into the Weekly Plan until explicitly added.
 */
export function createBoardDraft(input: {
  imageUrl:         string;
  source:           PinBoardSource;
  idempotencyKey?:  string;
  title?:           string;
  description?:     string;
  altText?:         string;
  tags?:            string[];
  destinationUrl?:  string;
  parentDraftId?:   string;
  sourceImageUrl?:  string;
  keyword?:         string;
  category?:        string;
  model?:           string;
  format?:          string;
  generationSessionId?: string;
  promptSnapshot?:  string;
  setupSnapshot?:   SetupSnapshot;
  pinCreatedAt?:    string;
  /** Set when the image URL is not publicly usable (migrated/expired assets). */
  assetError?:      string;
  /** "generating" creates a placeholder card (AI Image run in flight). */
  generationStatus?: string;
  /** WP3-P1: generation_jobs row id (worker-mode enqueue path only). */
  generationJobId?: string;
  /** WP3-P2: this placeholder's slot index in the job's results[] array. */
  generationSlot?: number;
  /** Server generation id + stable asset key (see PinDraft.sourceGenerationId). */
  sourceGenerationId?: string;
  sourceAssetKey?:     string;
}): PinDraft {
  const data = load();

  // Idempotent ONLY by explicit key — never by imageUrl.
  if (input.idempotencyKey) {
    const dup = Object.values(data.drafts).find(d => d.idempotencyKey === input.idempotencyKey);
    if (dup) return dup;
  }

  const now = new Date().toISOString();
  const draft: PinDraft = {
    id:                  genId(),
    imageUrl:            input.imageUrl,
    keyword:             input.keyword ?? "",
    category:            input.category ?? "",
    title:               input.title?.trim() ?? "",
    description:         input.description?.trim() ?? "",
    altText:             input.altText?.trim() ?? "",
    destinationUrl:      input.destinationUrl?.trim() ?? "",
    boardId:             "",
    boardName:           "",
    weeklyPlanItemId:    "",
    generationSessionId: input.generationSessionId ?? "",
    scheduledDate:       "",
    status:              "needs_review",
    createdAt:           now,
    updatedAt:           now,
    source:              input.source,
    parentDraftId:       input.parentDraftId,
    sourceImageUrl:      input.sourceImageUrl,
    tags:                input.tags,
    idempotencyKey:      input.idempotencyKey,
    model:               input.model,
    format:              input.format,
    promptSnapshot:      input.promptSnapshot,
    setupSnapshot:       input.setupSnapshot,
    pinCreatedAt:        input.pinCreatedAt,
    assetError:          input.assetError,
    generationStatus:    input.generationStatus,
    generationJobId:     input.generationJobId,
    generationSlot:      input.generationSlot,
    sourceGenerationId:  input.sourceGenerationId,
    sourceAssetKey:      input.sourceAssetKey,
  };

  data.drafts[draft.id] = draft;
  persist(data);
  emit();
  return draft;
}

/**
 * Resolve a Generating placeholder card with its real generated image.
 * This is the ONLY sanctioned imageUrl write after creation (updateDraft
 * deliberately forbids imageUrl patches); it also clears the generating state.
 */
export function completeGeneratedDraft(
  id: string,
  imageUrl: string,
  meta?: { generationId?: string; assetKey?: string },
): PinDraft | null {
  const data = load();
  const draft = data.drafts[id];
  if (!draft) return null;
  const updated: PinDraft = {
    ...draft,
    imageUrl,
    generationStatus: "completed",
    // Persist the server generation id + a stable asset key so the AI-adoption metric can
    // join on ids, not image-URL strings. Only set when provided (legacy callers unchanged).
    ...(meta?.generationId ? { sourceGenerationId: meta.generationId } : {}),
    ...(meta?.assetKey ? { sourceAssetKey: meta.assetKey } : {}),
    updatedAt: new Date().toISOString(),
  };
  data.drafts[id] = updated;
  persist(data);
  emit();
  return updated;
}

/** Mark a Generating placeholder as failed (per-result or whole-run failure). */
export function failGeneratedDraft(id: string): PinDraft | null {
  return updateDraft(id, { generationStatus: "failed" });
}

/**
 * Refresh recovery: client-driven (inline-mode) generation cannot survive a page
 * reload (the awaiting promise is gone, so results can never be delivered). Any
 * board draft still marked "generating" on mount is dead — mark it failed so
 * cards never stay stuck in Generating forever (PRD 12.1).
 *
 * WP3-P2: worker-mode placeholders carry a `generationJobId` — the task lives
 * server-side and a reload does NOT kill it, so those must NOT be judged here.
 * `onlyWithoutJobId` (default false, preserving the original call sites/tests)
 * restricts this sweep to drafts with no jobId; generationRecovery.ts's
 * reconcileGeneratingDrafts() is the only caller that passes `true`, and it
 * handles the jobId-bearing drafts itself via the job-status API.
 */
export function failStaleGeneratingDrafts(onlyWithoutJobId = false): number {
  const data = load();
  let changed = 0;
  for (const d of Object.values(data.drafts)) {
    const s = (d.generationStatus ?? "").toLowerCase();
    if (onlyWithoutJobId && d.generationJobId) continue;
    if (isBoardSource(d) && (s === "generating" || s === "running" || s === "pending" || s === "queued")) {
      data.drafts[d.id] = { ...d, generationStatus: "failed", updatedAt: new Date().toISOString() };
      changed++;
    }
  }
  if (changed) { persist(data); emit(); }
  return changed;
}

/** Board drafts currently in a "generating" lifecycle state (any board source). */
export function generatingDrafts(): PinDraft[] {
  const data = load();
  return Object.values(data.drafts).filter(d => {
    const s = (d.generationStatus ?? "").toLowerCase();
    return isBoardSource(d) && (s === "generating" || s === "running" || s === "pending" || s === "queued");
  });
}

/**
 * Create a Weekly Plan draft from a normalized Studio handoff payload.
 * Idempotent: returns existing draft for same imageUrl or pinId.
 */
export function createFromHandoff(payload: WeeklyPlanItemPayload): PinDraft | null {
  const data = load();
  const existing = Object.values(data.drafts).find(
    d => d.imageUrl === payload.imageUrl || (payload.pinId && d.pinId === payload.pinId),
  );
  if (existing) {
    return updateDraft(existing.id, {
      addedToPlanAt: existing.addedToPlanAt || payload.addedToPlanAt,
      scheduledDate: existing.scheduledDate || payload.plannedDate,
      scheduledTime: existing.scheduledTime || payload.plannedTime,
      plannedAt: existing.plannedAt || payload.plannedAt,
      generationStatus: payload.generationStatus,
      setupSnapshot: existing.setupSnapshot ?? payload.setupSnapshot,
      promptSnapshot: existing.promptSnapshot || payload.promptSnapshot,
    });
  }

  const status = draftStatusFromPlanningStatus(payload.planningStatus);
  const now = payload.addedToPlanAt;

  const draft: PinDraft = {
    id:                  genId(),
    imageUrl:            payload.imageUrl,
    keyword:             payload.keyword,
    category:            payload.category,
    title:               payload.title,
    description:         payload.description,
    altText:             payload.altText,
    destinationUrl:      payload.destinationUrl,
    // Real Pinterest board carried from the Pin's metadata (selected in Batch Edit /
    // Pin Details). Empty when the user hasn't chosen a board yet.
    boardId:             payload.metadataDraft?.boardId ?? "",
    boardName:           payload.metadataDraft?.boardName ?? "",
    weeklyPlanItemId:    "",
    generationSessionId: payload.sessionId,
    scheduledDate:       payload.plannedDate,
    scheduledTime:       payload.plannedTime ?? "",
    plannedAt:           payload.plannedAt ?? "",
    status,
    createdAt:           now,
    updatedAt:           now,
    pinId:               payload.pinId,
    planningStatus:      payload.planningStatus,
    generationStatus:    payload.generationStatus,
    metadataDraft:       payload.metadataDraft,
    metadataTouched:     payload.metadataTouched,
    setupSnapshot:       payload.setupSnapshot,
    promptSnapshot:      payload.promptSnapshot,
    opportunity:         payload.opportunity,
    source:              payload.source,
    format:              payload.format,
    model:               payload.model,
    addedToPlanAt:       payload.addedToPlanAt,
    pinCreatedAt:        payload.createdAt,
    // Amazon affiliate product link context — preserved across the handoff so the
    // Pin keeps the same product image + affiliate destination in Weekly Plan.
    productId:             payload.productId,
    creatorProductLinkId:  payload.creatorProductLinkId,
    sourceProductImageUrl: payload.sourceProductImageUrl,
    destinationUrlSource:  payload.destinationUrlSource,
  };

  data.drafts[draft.id] = draft;
  persist(data);
  emit();
  return draft;
}

/**
 * Persist publishing details for a generated Pin before it is added to Weekly Plan.
 * This gives Create Pins, History, and Weekly Plan one canonical local record.
 */
export function createDetailsDraftFromHandoff(payload: WeeklyPlanItemPayload): PinDraft | null {
  const data = load();
  const existing = Object.values(data.drafts).find(
    d => d.imageUrl === payload.imageUrl || (payload.pinId && d.pinId === payload.pinId),
  );
  if (existing) return existing;

  const draft = createFromHandoff(payload);
  if (!draft) return null;
  return updateDraft(draft.id, {
    addedToPlanAt: "",
    scheduledDate: "",
    scheduledTime: "",
  });
}

/**
 * Patch any fields of an existing draft.
 * Status is auto-recomputed from destinationUrl unless explicitly set in patch.
 */
export function updateDraft(
  id: string,
  patch: Partial<Omit<PinDraft, "id" | "imageUrl" | "createdAt">>,
): PinDraft | null {
  const data  = load();
  const draft = data.drafts[id];
  if (!draft) return null;

  const updated: PinDraft = { ...draft, ...patch, updatedAt: new Date().toISOString() };
  if ("scheduledDate" in patch || "scheduledTime" in patch) {
    if (!updated.scheduledDate) updated.scheduledTime = "";
    updated.plannedAt = combineLocalPlannedAt(updated.scheduledDate, updated.scheduledTime);
    // Stamp the zone the wall-clock was set in unless the caller supplied one explicitly.
    if (!("scheduleTimezone" in patch)) {
      updated.scheduleTimezone = updated.plannedAt ? resolveScheduleTimezone() : "";
    }
  }

  // Auto-recompute status from title + description + scheduledDate when not explicitly set.
  if (!("status" in patch)) {
    updated.status = recomputeDraftStatus(updated);
    updated.planningStatus = updated.status === "ready" ? "ready" : "needs_review";
  } else if ("status" in patch && patch.status) {
    updated.planningStatus = patch.status === "ready" ? "ready" : "needs_review";
  }

  data.drafts[id] = updated;
  persist(data);
  emit();
  syncPinMetadataStore(updated);
  return updated;
}

function syncPinMetadataStore(draft: PinDraft): void {
  if (!draft.pinId) return;
  const stored = pinMetadataStore.getPinMetadata(draft.pinId);
  if (!stored) return;
  const linked = draft.linkedProducts ?? [];
  const primary = linked.find(p => p.productId === draft.primaryProductId) ?? linked[0] ?? null;
  const tagged = primary ? linked.filter(p => p !== primary) : linked;
  const productMetadataDraft = draft.metadataDraft
    ? writePinProducts(draft.metadataDraft, primary, tagged)
    : stored.metadataDraft;
  const metadataDraft = {
    ...productMetadataDraft,
    plannedDate: draft.scheduledDate,
    plannedTime: draft.scheduledTime,
    plannedAt: draft.plannedAt,
  };
  pinMetadataStore.savePinMetadata({
    ...stored,
    title: draft.title,
    description: draft.description,
    altText: draft.altText,
    destinationUrl: draft.destinationUrl,
    plannedDate: draft.scheduledDate,
    plannedTime: draft.scheduledTime,
    plannedAt: draft.plannedAt,
    planningStatus: draft.planningStatus ?? (draft.status === "ready" ? "ready" : "needs_review"),
    metadataDraft,
    touched: draft.metadataTouched ?? stored.touched,
  });
}

/** Mark one or more drafts as ready. */
export function markReady(ids: string[]): void {
  const data = load();
  const now  = new Date().toISOString();
  for (const id of ids) {
    if (data.drafts[id]) {
      data.drafts[id] = { ...data.drafts[id], status: "ready", updatedAt: now };
    }
  }
  persist(data);
  emit();
}

/** Apply the same destination URL to multiple drafts. */
export function bulkSetLink(ids: string[], destinationUrl: string): void {
  const data = load();
  const now  = new Date().toISOString();
  for (const id of ids) {
    const d = data.drafts[id];
    if (!d) continue;
    // Clearing URL does not flip to "needs_link" — URL is not a required field.
    data.drafts[id] = {
      ...d,
      destinationUrl,
      status: d.status === "ready" ? "ready" : "needs_review",
      updatedAt: now,
    };
  }
  persist(data);
  emit();
}

/** Remove a draft from the store. */
export function deleteDraft(id: string): void {
  const data = load();
  const draft = data.drafts[id];
  if (draft?.pinId) pinMetadataStore.deletePinMetadata(draft.pinId);
  delete data.drafts[id];
  persist(data);
  emit();
}

/**
 * Archive a draft off the active board (recoverable). Used for Published cards so
 * removing the card never implies deleting the live Pinterest Pin.
 */
export function archiveDraft(id: string): PinDraft | null {
  return updateDraft(id, { archivedAt: new Date().toISOString() });
}

export function unarchiveDraft(id: string): PinDraft | null {
  return updateDraft(id, { archivedAt: undefined });
}

/**
 * Duplicate a draft into a NEW independent editable draft. Copies content
 * (image, copy, tags, board, model, format, metadata) but CLEARS all lifecycle /
 * schedule / publish state so a copy never appears Published or Scheduled.
 * An AI‑pin duplicate keeps its `parentDraftId`; an uploaded‑pin duplicate gets none.
 */
export function duplicateDraft(id: string): PinDraft | null {
  const src = getDraft(id);
  if (!src) return null;
  const now = new Date().toISOString();
  const copy: PinDraft = {
    ...src,
    id:                genId(),
    createdAt:         now,
    updatedAt:         now,
    // Cleared lifecycle / schedule / publish / identity state:
    postedAt:          undefined,
    remotePinId:       undefined,
    remotePinUrl:      undefined,
    publishError:      undefined,
    archivedAt:        undefined,
    scheduledDate:     "",
    scheduledTime:     "",
    plannedAt:         undefined,
    addedToPlanAt:     undefined,
    scheduleSource:    undefined,
    scheduleLocked:    false,
    autoScheduled:     false,
    weeklyPlanItemId:  "",
    pinId:             undefined,
    idempotencyKey:    undefined,
    // AI‑pin duplicate keeps the source relationship; uploaded‑pin duplicate does not.
    parentDraftId:     src.source === "ai_generated_from_upload" ? src.parentDraftId : undefined,
  };
  const data = load();
  data.drafts[copy.id] = copy;
  persist(data);
  emit();
  return copy;
}

// ── Server merge (WP0 — pinDraftSync) ─────────────────────────────────────────

/** Timestamp-safe compare: client ISO strings and PostgREST "+00:00" both parse. */
function tsMs(value: string | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Merge server-authoritative drafts into the local store (LWW per draft on
 * updatedAt). Called by pinDraftSync at startup after the full GET pull.
 *
 * - Server draft unknown locally → inserted.
 * - Server draft strictly NEWER than local → replaces local.
 * - Local newer or equal → local kept unchanged (it re-uploads via the outbox diff).
 * - `deletedIds` tombstones remove the local draft ONLY when the local copy's
 *   updatedAt is older than the tombstone's deletedAt (a newer local edit wins
 *   and will revive the draft server-side on the next push).
 *
 * Additive API: does not change any existing function or event semantics.
 * Emits a single DRAFT_STORE_EVENT when (and only when) anything changed.
 */
export function mergeServerDrafts(
  serverDrafts: PinDraft[],
  deletedIds: Array<{ id: string; deletedAt: string }>,
): { applied: number; removed: number } {
  const data = load();
  let applied = 0;
  let removed = 0;
  const touched: PinDraft[] = [];

  for (const incoming of serverDrafts) {
    if (!incoming || typeof incoming.id !== "string" || !incoming.id) continue;
    const local = data.drafts[incoming.id];
    if (local && tsMs(incoming.updatedAt) <= tsMs(local.updatedAt)) continue; // local wins / equal → no-op
    data.drafts[incoming.id] = incoming;
    touched.push(incoming);
    applied++;
  }

  for (const t of deletedIds) {
    if (!t || typeof t.id !== "string") continue;
    const local = data.drafts[t.id];
    if (!local) continue;
    if (tsMs(local.updatedAt) >= tsMs(t.deletedAt)) continue; // newer local edit survives
    if (local.pinId) pinMetadataStore.deletePinMetadata(local.pinId);
    delete data.drafts[t.id];
    removed++;
  }

  if (applied || removed) {
    persist(data);
    emit();
    for (const d of touched) syncPinMetadataStore(d);
  }
  return { applied, removed };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function getDraftsByKeyword(keyword: string, category: string): PinDraft[] {
  const data = load();
  return Object.values(data.drafts)
    .filter(d =>
      d.keyword.toLowerCase()  === keyword.toLowerCase() &&
      d.category.toLowerCase() === category.toLowerCase(),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getDraftsBySession(sessionId: string): PinDraft[] {
  const data = load();
  return Object.values(data.drafts)
    .filter(d => d.generationSessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getDraftByImageUrl(imageUrl: string): PinDraft | null {
  const data = load();
  return Object.values(data.drafts).find(d => d.imageUrl === imageUrl) ?? null;
}

/**
 * Quick summary used by Weekly Plan rows.
 * Returns totals and first 4 thumbnail URLs.
 */
/** All drafts, newest first. */
export function getAllDrafts(): PinDraft[] {
  const data = load();
  return Object.values(data.drafts)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDraft(id: string): PinDraft | null {
  return load().drafts[id] ?? null;
}

export function isDraftAddedToWeeklyPlan(draft: PinDraft): boolean {
  return !!sanitizeHandoffField(draft.addedToPlanAt);
}

/** Generated pins still in the tray: not added to plan AND with no scheduled date.
 *  A pin that has a date (even if `addedToPlanAt` was never set) lives on the
 *  calendar, so it must not also appear here.
 *  Create Pins v2 board drafts (uploads / AI pins) live on the Studio board, not the
 *  Weekly Plan tray, until explicitly added — so board‑origin unadded drafts are
 *  excluded here (prevents fresh uploads from leaking into Weekly Plan). */
export function isUnaddedGeneratedDraft(d: PinDraft, category?: string): boolean {
  if (category && d.category !== category) return false;
  if (d.archivedAt) return false;
  if (sanitizeHandoffField(d.scheduledDate)) return false;
  if (isDraftAddedToWeeklyPlan(d)) return false;
  if (isBoardSource(d)) return false;
  return true;
}

export function getUnaddedGeneratedDrafts(category?: string): PinDraft[] {
  return getAllDrafts().filter(d => isUnaddedGeneratedDraft(d, category));
}

// ── Create Pins board selectors (studioBoardV2) ────────────────────────────────

/** Active board drafts (excludes archived by default), newest first. */
export function getBoardDrafts(opts?: { includeArchived?: boolean }): PinDraft[] {
  const all = getAllDrafts();
  return opts?.includeArchived ? all : all.filter(d => !d.archivedAt);
}

/** Drafts that belong to the Weekly Plan: explicitly added OR given a date. */
export function getPlannedDrafts(): PinDraft[] {
  return getAllDrafts().filter(
    d => isDraftAddedToWeeklyPlan(d) || !!sanitizeHandoffField(d.scheduledDate),
  );
}

/** Drafts with a concrete scheduled date (calendar membership). */
export function getScheduledDrafts(): PinDraft[] {
  return getAllDrafts().filter(d => !!sanitizeHandoffField(d.scheduledDate));
}

/** @deprecated Use getUnaddedGeneratedDrafts — keyword mismatch is not plan membership. */
export function getUnscheduledDrafts(_planKeywords: string[]): PinDraft[] {
  return getUnaddedGeneratedDrafts();
}

export function markAddedToWeeklyPlan(id: string): PinDraft | null {
  const draft = getDraft(id);
  if (!draft) return null;
  return updateDraft(id, {
    addedToPlanAt: draft.addedToPlanAt || new Date().toISOString(),
  });
}

/**
 * Assign a Pin to a Smart Schedule slot (date + time + optional board rotation).
 * Does not require publish-ready fields — scheduling is separate from readiness.
 */
export function smartScheduleDraft(
  id: string,
  slot: { plannedDate: string; plannedTime: string },
  board?: { boardId: string; boardName: string } | null,
  opts?: { source?: "smart" | "manual" },
): PinDraft | null {
  const draft = getDraft(id);
  if (!draft) return null;
  const source = opts?.source ?? "smart";
  const patch: Partial<PinDraft> = {
    scheduledDate: slot.plannedDate,
    scheduledTime: slot.plannedTime,
    addedToPlanAt: draft.addedToPlanAt || new Date().toISOString(),
    autoScheduled: source === "smart",
    // Smart placement is rebalance-eligible; an explicit manual reschedule pins it.
    scheduleSource: source,
    scheduleLocked: source === "manual",
  };
  if (board?.boardId) {
    patch.boardId = board.boardId;
    patch.boardName = board.boardName;
  }
  return updateDraft(id, patch);
}

/** Manual date/time assignment (drag/drop, manual picker). Locks the Pin so a
 *  Smart Schedule rebalance never moves it. */
export function assignDraftToDate(id: string, date: string, time?: string): PinDraft | null {
  const draft = getDraft(id);
  if (!draft) return null;
  const patch: Partial<PinDraft> = {
    scheduledDate:   date,
    addedToPlanAt:   draft.addedToPlanAt || new Date().toISOString(),
    autoScheduled:   false,
    scheduleSource:  "manual",
    scheduleLocked:  true,
  };
  // Only touch the time slot when a value is explicitly provided (drop on a slot).
  // Dropping on a day in general preserves the pin's existing time.
  if (time !== undefined) patch.scheduledTime = time;
  return updateDraft(id, patch);
}

/**
 * Batch-patch many drafts with a single persist + single DRAFT_STORE_EVENT.
 * Used by Smart Schedule rebalance / undo so the calendar updates once, not per Pin.
 * plannedAt is recomputed from date+time when those change (same rule as updateDraft),
 * unless an explicit plannedAt is supplied in the patch (used by Undo to restore).
 */
export function bulkUpdateDrafts(
  updates: Array<{ id: string; patch: Partial<Omit<PinDraft, "id" | "imageUrl" | "createdAt">> }>,
): number {
  const data = load();
  const now = new Date().toISOString();
  let changed = 0;
  const touched: PinDraft[] = [];
  for (const { id, patch } of updates) {
    const draft = data.drafts[id];
    if (!draft) continue;
    const updated: PinDraft = { ...draft, ...patch, updatedAt: now };
    if (("scheduledDate" in patch || "scheduledTime" in patch) && !("plannedAt" in patch)) {
      if (!updated.scheduledDate) updated.scheduledTime = "";
      updated.plannedAt = combineLocalPlannedAt(updated.scheduledDate, updated.scheduledTime);
      if (!("scheduleTimezone" in patch)) {
        updated.scheduleTimezone = updated.plannedAt ? resolveScheduleTimezone() : "";
      }
    }
    if (!("status" in patch)) {
      updated.status = recomputeDraftStatus(updated);
      updated.planningStatus = updated.status === "ready" ? "ready" : "needs_review";
    }
    data.drafts[id] = updated;
    touched.push(updated);
    changed++;
  }
  if (changed === 0) return 0;
  persist(data);
  emit();
  for (const d of touched) syncPinMetadataStore(d);
  return changed;
}

export function markDraftPosted(id: string): PinDraft | null {
  return updateDraft(id, { postedAt: new Date().toISOString() });
}

/** Lock/unlock a planned Pin's time so a Smart Schedule rebalance skips (or includes) it.
 *  Only flips the lock flag — never touches the date/time/source. */
export function setScheduleLocked(id: string, locked: boolean): PinDraft | null {
  return updateDraft(id, { scheduleLocked: locked });
}

export function removeFromWeeklyPlan(id: string): PinDraft | null {
  return updateDraft(id, {
    addedToPlanAt: "", scheduledDate: "", scheduledTime: "",
    scheduleSource: undefined, scheduleLocked: false, autoScheduled: false,
  });
}

export function getDraftSummary(keyword: string, category: string): {
  total:       number;
  ready:       number;
  needsLink:   number;
  needsReview: number;
  thumbnails:  string[];
} {
  const drafts = getDraftsByKeyword(keyword, category);
  return {
    total:       drafts.length,
    ready:       drafts.filter(d => d.status === "ready").length,
    needsLink:   drafts.filter(d => d.status === "needs_link").length,
    needsReview: drafts.filter(d => d.status === "needs_review").length,
    thumbnails:  drafts.slice(0, 4).map(d => d.imageUrl),
  };
}
