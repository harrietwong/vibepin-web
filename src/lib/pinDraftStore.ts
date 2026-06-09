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

import type { MetadataTouchedFlags, PinMetadataDraft } from "./pinMetadata";
import * as pinMetadataStore from "./pinMetadataStore";
import type { SetupSnapshot } from "./studioPersistence";
import {
  draftStatusFromPlanningStatus,
  sanitizeHandoffField,
  type WeeklyPlanItemPayload,
} from "./weeklyPlanHandoff";

const STORE_KEY       = "vp:pin_drafts:v1";
const MAX_DRAFTS      = 500;
export const DRAFT_STORE_EVENT = "vp:pin_drafts_updated";

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
}

interface StoreData {
  drafts: Record<string, PinDraft>;
}

// ── Internal I/O ─────────────────────────────────────────────────────────────

function ok(): boolean { return typeof window !== "undefined"; }

function load(): StoreData {
  if (!ok()) return { drafts: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { drafts: {} };
    const p = JSON.parse(raw) as Partial<StoreData>;
    return { drafts: p.drafts ?? {} };
  } catch { return { drafts: {} }; }
}

function persist(data: StoreData): void {
  if (!ok()) return;
  const sorted = Object.values(data.drafts)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_DRAFTS);
  const trimmed: StoreData = {
    drafts: Object.fromEntries(sorted.map(d => [d.id, d])),
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
  } catch { /* quota exceeded — silently skip */ }
}

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(DRAFT_STORE_EVENT));
}

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

function generateCopy(keyword: string, category: string): {
  title: string;
  description: string;
  altText: string;
} {
  const kwCap    = keyword.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const catLabel = category.replace(/-/g, " ");
  return {
    title:       `${kwCap} Inspiration`,
    description: `Discover beautiful ${keyword} ideas for your ${catLabel} space. Save this pin for your next project and get inspired!`,
    altText:     `${kwCap} styled photo`,
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
}): PinDraft {
  const data = load();

  // Idempotent: skip duplicate for same image
  const existing = Object.values(data.drafts).find(d => d.imageUrl === input.imageUrl);
  if (existing) return existing;

  const generated = generateCopy(input.keyword, input.category);
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
 * Create a Weekly Plan draft from a normalized Studio handoff payload.
 * Idempotent: returns existing draft for same imageUrl or pinId.
 */
export function createFromHandoff(payload: WeeklyPlanItemPayload): PinDraft | null {
  const data = load();
  const existing = Object.values(data.drafts).find(
    d => d.imageUrl === payload.imageUrl || (payload.pinId && d.pinId === payload.pinId),
  );
  if (existing) return existing;

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
    boardId:             "",
    boardName:           "",
    weeklyPlanItemId:    "",
    generationSessionId: payload.sessionId,
    scheduledDate:       payload.plannedDate,
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
  };

  data.drafts[draft.id] = draft;
  persist(data);
  emit();
  return draft;
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
  pinMetadataStore.savePinMetadata({
    ...stored,
    title: draft.title,
    description: draft.description,
    altText: draft.altText,
    destinationUrl: draft.destinationUrl,
    plannedDate: draft.scheduledDate,
    planningStatus: draft.planningStatus ?? (draft.status === "ready" ? "ready" : "needs_review"),
    metadataDraft: draft.metadataDraft ?? stored.metadataDraft,
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

/** Generated pins not yet added to the weekly plan. */
export function getUnaddedGeneratedDrafts(category?: string): PinDraft[] {
  return getAllDrafts().filter(d => {
    if (category && d.category !== category) return false;
    return !isDraftAddedToWeeklyPlan(d);
  });
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

export function assignDraftToDate(id: string, date: string): PinDraft | null {
  const draft = getDraft(id);
  if (!draft) return null;
  return updateDraft(id, {
    scheduledDate:   date,
    addedToPlanAt:   draft.addedToPlanAt || new Date().toISOString(),
  });
}

export function markDraftPosted(id: string): PinDraft | null {
  return updateDraft(id, { postedAt: new Date().toISOString() });
}

export function removeFromWeeklyPlan(id: string): PinDraft | null {
  return updateDraft(id, { addedToPlanAt: "", scheduledDate: "" });
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
