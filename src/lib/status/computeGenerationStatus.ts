/**
 * computeGenerationStatus.ts — status computation and normalization utilities
 *
 * All functions are pure (no side effects, no browser APIs) so they can run
 * in tests, server components, and client components equally.
 */

import type {
  GenerationStatus,
  PlanningStatus,
  SessionPlanningStatusSummary,
} from "./pinStatuses";

// Sessions stuck as "running" for longer than this are treated as interrupted.
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

// ── Session generation status ─────────────────────────────────────────────────

export interface SessionStatusInput {
  /** Explicit status stored in DB / localStorage, if any. */
  explicitStatus?: string | null;
  /** Whether the task was last seen as "running". */
  isRunning?: boolean;
  /** ISO timestamp when the session was saved — used for stale detection. */
  savedAt?: string;
  /** Number of pins that were expected to be generated. */
  expectedCount: number;
  /** Number of pins that were actually returned. */
  returnedCount: number;
  /** True when we know at least one generation call returned an error. */
  hasFailed?: boolean;
}

export function computeSessionGenerationStatus(
  opts: SessionStatusInput,
): GenerationStatus {
  const { explicitStatus, isRunning, savedAt, expectedCount, returnedCount, hasFailed } = opts;

  // Terminal explicit statuses — trust them directly.
  if (explicitStatus === "interrupted") return "interrupted";
  if (explicitStatus === "completed")   return "completed";
  if (explicitStatus === "partial")     return "partial";
  if (explicitStatus === "failed")      return "failed";
  if (explicitStatus === "pending")     return "pending";

  // Running — check for staleness.
  if (isRunning || explicitStatus === "running") {
    if (savedAt) {
      const ageMs = Date.now() - new Date(savedAt).getTime();
      if (ageMs > STALE_THRESHOLD_MS) return "interrupted";
    }
    return "running";
  }

  // Derive from count relationship.
  if (expectedCount === 0)                                   return "pending";
  if (returnedCount === expectedCount && expectedCount > 0)  return "completed";
  if (returnedCount > 0 && returnedCount < expectedCount)    return "partial";
  if (returnedCount === 0 && hasFailed)                      return "failed";
  if (returnedCount === 0)                                   return "failed";
  return "completed";
}

// ── Per-pin generation status ─────────────────────────────────────────────────

export interface PinStatusInput {
  /** The generated image URL, if available. */
  imageUrl?: string | null;
  /** Raw status string from the DB or store. */
  rawStatus?: string | null;
}

export function computePinGenerationStatus(opts: PinStatusInput): GenerationStatus {
  const { imageUrl, rawStatus } = opts;
  if (rawStatus === "failed")                              return "failed";
  if (rawStatus === "pending")                             return "pending";
  if (rawStatus === "processing" || rawStatus === "running") return "running";
  if (imageUrl)                                            return "completed";
  return "failed";
}

// ── Planning status ───────────────────────────────────────────────────────────

export interface PinPlanningStatusInput {
  weeklyPlanItemId?: string | null;
  title?:            string | null;
  description?:      string | null;
  scheduledDate?:    string | null;
  isPosted?:         boolean;
  isSkipped?:        boolean;
}

/**
 * Required fields for a pin to be considered "ready".
 * boardId and destinationUrl are intentionally NOT required here — VibePin is
 * not a full scheduler yet and we don't want those to block Weekly Plan.
 */
export function computePinPlanningStatus(opts: PinPlanningStatusInput): PlanningStatus {
  const { weeklyPlanItemId, title, description, scheduledDate, isPosted, isSkipped } = opts;

  if (isSkipped)                   return "skipped";
  if (isPosted)                    return "posted";
  if (!weeklyPlanItemId)           return "not_added";

  const hasTitle       = !!title?.trim();
  const hasDescription = !!description?.trim();
  const hasDate        = !!scheduledDate?.trim();

  if (!hasTitle || !hasDescription || !hasDate) return "needs_review";
  return "ready";
}

// ── Legacy normalization ──────────────────────────────────────────────────────

/** Maps raw DB or store generation status strings to canonical GenerationStatus. */
export function normalizeLegacyGenerationStatus(
  raw: string | null | undefined,
): GenerationStatus {
  if (!raw) return "pending";
  switch (raw) {
    case "pending":     return "pending";
    case "processing":
    case "running":     return "running";
    case "done":
    case "completed":   return "completed";
    case "partial":     return "partial";
    case "failed":      return "failed";
    case "interrupted": return "interrupted";
    default:            return "completed"; // unknown old entry — assume complete
  }
}

/** Maps raw DB or store planning status strings to canonical PlanningStatus. */
export function normalizeLegacyPlanningStatus(
  raw: string | null | undefined,
): PlanningStatus {
  if (!raw) return "not_added";
  switch (raw) {
    case "not_added":     return "not_added";
    case "added_to_plan": return "added_to_plan";
    case "needs_review":
    case "pending":
    case "processing":    return "needs_review";
    case "needs_link":    return "needs_review"; // old DraftStatus value
    case "failed":        return "needs_review"; // failed plan item → needs attention
    case "ready":         return "ready";
    case "done":          return "ready";
    case "posted":        return "posted";
    case "skipped":       return "skipped";
    default:              return "needs_review";
  }
}

/**
 * Maps DraftStatus (from pinDraftStore) to canonical PlanningStatus.
 * DraftStatus is the internal write-path type; PlanningStatus is for display and logic.
 */
export function draftStatusToPlanningStatus(
  draftStatus: "needs_review" | "needs_link" | "ready" | string,
): PlanningStatus {
  switch (draftStatus) {
    case "ready":        return "ready";
    case "needs_review":
    case "needs_link":   return "needs_review";
    default:             return "added_to_plan";
  }
}

// ── Session planning status summary ──────────────────────────────────────────

export function computeSessionPlanningStatusSummary(
  statuses: PlanningStatus[],
): SessionPlanningStatusSummary {
  const summary: SessionPlanningStatusSummary = {
    notAdded: 0, addedToPlan: 0, needsReview: 0, ready: 0, posted: 0, skipped: 0,
  };
  for (const s of statuses) {
    switch (s) {
      case "not_added":     summary.notAdded++;    break;
      case "added_to_plan": summary.addedToPlan++; break;
      case "needs_review":  summary.needsReview++; break;
      case "ready":         summary.ready++;        break;
      case "posted":        summary.posted++;       break;
      case "skipped":       summary.skipped++;      break;
    }
  }
  return summary;
}
