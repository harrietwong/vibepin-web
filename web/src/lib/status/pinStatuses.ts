/**
 * pinStatuses.ts — canonical status type definitions for VibePin
 *
 * Two independent dimensions. Never mix them:
 *   GenerationStatus  — tracks the AI generation task itself
 *   PlanningStatus    — tracks the pin's position in the content plan
 */

// ── Generation status ─────────────────────────────────────────────────────────

export type GenerationStatus =
  | "pending"      // created, not yet started
  | "running"      // AI generation in progress
  | "completed"    // all expected pins generated successfully
  | "partial"      // some pins generated, some failed or missing
  | "failed"       // no pins generated at all
  | "interrupted"; // was running, stalled due to refresh/timeout/disconnect

// ── Planning status ───────────────────────────────────────────────────────────

export type PlanningStatus =
  | "not_added"     // has not been added to Weekly Plan
  | "added_to_plan" // added but required fields not yet checked
  | "needs_review"  // missing title, description, or scheduledDate
  | "ready"         // all required fields filled; ready to publish manually
  | "posted"        // user marked as published (or Pinterest confirmed)
  | "skipped";      // user chose not to use this pin

// ── Composite types ───────────────────────────────────────────────────────────

export type SessionPlanningStatusSummary = {
  notAdded:    number;
  addedToPlan: number;
  needsReview: number;
  ready:       number;
  posted:      number;
  skipped:     number;
};

/** Normalized view of a single generated pin with both status dimensions. */
export type GeneratedPin = {
  id:                string;
  imageUrl?:         string;
  generationStatus:  GenerationStatus;
  planningStatus:    PlanningStatus;
  weeklyPlanItemId?: string | null;
};

/** Normalized view of a generation session. */
export type GeneratedSession = {
  id:                    string;
  source?:               string;
  expectedCount:         number;
  returnedCount:         number;
  generationStatus:      GenerationStatus;
  planningStatusSummary: SessionPlanningStatusSummary;
};

/** Normalized view of a weekly plan item. */
export type WeeklyPlanItemNormalized = {
  id:              string;
  generatedAssetId?: string | null;
  planningStatus:  PlanningStatus;
  scheduledDate?:  string | null;
  title?:          string | null;
  description?:    string | null;
  destinationUrl?: string | null;
  boardId?:        string | null;
};
