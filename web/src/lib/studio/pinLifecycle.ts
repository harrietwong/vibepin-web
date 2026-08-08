/**
 * pinLifecycle.ts — Create Pins board status model (studioBoardV2).
 *
 * The ONLY card status values (matches the existing studio PinCardActions model):
 *   generating | failed | unscheduled | scheduled | posted
 *
 * Derived purely from durable draft fields — there is NO "ready" / "need details"
 * card status. Missing fields (title/description/board/url…) never change the card
 * status; a generated-but-undated Pin is simply "unscheduled". Required-field
 * validation is surfaced ONLY inside the edit/schedule modal on publish/schedule.
 *
 * Source ("Uploaded" / "AI Generated") is a SEPARATE badge — never merged with status.
 */

import type { PinDraft } from "@/lib/pinDraftStore";
import { sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";

export type PinLifecycle = "generating" | "failed" | "unscheduled" | "scheduled" | "posted";

function genStatus(d: Pick<PinDraft, "generationStatus">): string {
  return (d.generationStatus ?? "").toLowerCase();
}
function isGenerating(d: Pick<PinDraft, "generationStatus">): boolean {
  const s = genStatus(d);
  return s === "generating" || s === "running" || s === "pending" || s === "queued";
}
function isGenerationFailed(d: Pick<PinDraft, "generationStatus">): boolean {
  const s = genStatus(d);
  return s === "failed" || s === "error";
}

export function isPosted(d: Pick<PinDraft, "postedAt" | "remotePinId">): boolean {
  return !!sanitizeHandoffField(d.postedAt) || !!sanitizeHandoffField(d.remotePinId);
}
export function isScheduledLifecycle(d: Pick<PinDraft, "scheduledDate" | "plannedAt">): boolean {
  return !!sanitizeHandoffField(d.scheduledDate) || !!sanitizeHandoffField(d.plannedAt);
}

/**
 * Derive lifecycle. Order: generating → posted → failed → scheduled → unscheduled.
 * (Missing required fields do NOT produce a status — they stay "unscheduled".)
 */
export function getPinLifecycle(draft: PinDraft): PinLifecycle {
  if (isGenerating(draft)) return "generating";
  if (isPosted(draft)) return "posted";
  if (sanitizeHandoffField(draft.publishError) || isGenerationFailed(draft)) return "failed";
  if (isScheduledLifecycle(draft)) return "scheduled";
  return "unscheduled";
}

// ── Publish-failure categorization (PRD WP-B §11.5) ─────────────────────────────
// Maps a normalized publish error (the `code` from /api/pinterest/pins and/or the
// user-facing message) to a coarse retry bucket. The bias is deliberately toward
// "transient": anything not clearly auth- or content-related lets the user Retry.
export type ErrorCategory = "transient" | "content" | "auth";

/**
 * Classify a publish failure.
 *   auth      → the Pinterest connection must be (re)authorized (needs_reconnect / 401).
 *   content   → the request itself is wrong and Retry-as-is won't help (bad board /
 *               invalid image or link URL / field validation).
 *   transient → unknown / timeout / 5xx / concurrent-publish lock → safe to Retry.
 *
 * Prefer `code` (stable) over `message` (localized/formatted). When neither is
 * conclusive, return "transient" so the user is never blocked from retrying.
 */
export function mapPublishErrorToCategory(code?: string, message?: string): ErrorCategory {
  const c = (code ?? "").trim().toLowerCase();
  const m = (message ?? "").trim().toLowerCase();

  // auth — connection expired / not authorized for publishing.
  if (c === "needs_reconnect" || c === "unauthorized" || c === "401") return "auth";

  // content — a fixed, request-shaped problem; retrying the same payload won't help.
  if (
    c === "board_not_owned" ||
    c === "invalid_image_url" ||
    c === "invalid_link" ||
    c === "bad_request"
  ) return "content";

  // transient — explicitly safe to retry (do NOT let the message heuristics below
  // reclassify these as content).
  if (c === "publish_in_progress" || c === "network_error") return "transient";

  // Fall back to message heuristics only when the code was inconclusive.
  if (c === "" || c === "pinterest_api_error") {
    if (/reconnect|token .*expired|connection expired|reauthor/.test(m)) return "auth";
    if (/board (not found|not owned)|not a public|must be a public|must use http|is not a valid url|invalid/.test(m)) return "content";
  }

  // Unknown / timeout / 5xx / anything else → let the user retry.
  return "transient";
}

/** THE single, source-agnostic predicate for an *actionable* publish failure.
 *  A draft counts iff its last failure was a PUBLISH failure, it still carries a
 *  publish error, and it is NOT archived. Source is deliberately NOT part of this:
 *  the Plan drawer / cron can fail non-board-source drafts too, and those are real
 *  failures the user can Retry from Plan — so we must not filter them out by source.
 *  Plan and Create Pins are one workspace (PRD v1.1 §6.3) and share this one set;
 *  the Plan week view only layers a time-range filter on top (see …InWeek below). */
export function isActionablePublishFailure(
  d: Pick<PinDraft, "failureType" | "publishError" | "archivedAt">,
): boolean {
  return d.failureType === "publish"
    && !!sanitizeHandoffField(d.publishError)
    && !d.archivedAt;
}

/** Full-population actionable publish failures (Plan and Create Pins use this set). */
export function listActionablePublishFailures<
  T extends Pick<PinDraft, "failureType" | "publishError" | "archivedAt">,
>(drafts: T[]): T[] {
  return drafts.filter(isActionablePublishFailure);
}

type PublishFailureSchedule = Pick<
  PinDraft,
  "failureType" | "publishError" | "archivedAt" | "previousScheduledTime" | "scheduledDate" | "plannedAt"
>;

function datePart(value?: string): string | null {
  const clean = sanitizeHandoffField(value);
  const match = clean?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

/** Plan scope uses the time that failed, falling back to the current scheduled date. */
export function isActionablePublishFailureInWeek(d: PublishFailureSchedule, weekStart: string): boolean {
  if (!isActionablePublishFailure(d) || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return false;
  const failureDate = datePart(d.previousScheduledTime) ?? datePart(d.scheduledDate) ?? datePart(d.plannedAt);
  if (!failureDate) return false;
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const value = new Date(`${failureDate}T00:00:00`);
  return value >= start && value < end;
}

export function listActionablePublishFailuresInWeek<T extends PublishFailureSchedule>(
  drafts: T[],
  weekStart: string,
): T[] {
  return drafts.filter(d => isActionablePublishFailureInWeek(d, weekStart));
}

/** Count drafts whose most recent PUBLISH attempt failed (drives a "N failed" banner).
 *  Now equivalent to listActionablePublishFailures().length — it additionally excludes
 *  archived drafts, which is the intended fix (archived failures are off the board). */
export function countPublishFailures(
  drafts: Pick<PinDraft, "failureType" | "publishError" | "archivedAt">[],
): number {
  return listActionablePublishFailures(drafts).length;
}

/** Stable identity of the currently actionable set. A retry failure on the same Pin
 * changes updatedAt, so a genuinely new failure resurfaces the banner even when the
 * total count did not increase. */
export function publishFailureSetIdentity(
  drafts: Pick<PinDraft, "id" | "updatedAt" | "failureType" | "publishError" | "archivedAt">[],
): string {
  return listActionablePublishFailures(drafts)
    .map(d => `${d.id}:${d.updatedAt}`)
    .sort()
    .join("|");
}

// ── Failed-view sub-filter entry signal (PRD "失败情况优化" §4) ─────────────────
// One-shot sessionStorage flag: any entry point that wants Create Pins' Failed view
// to default its sub-filter to "Publish failures" (Banner CTA, Plan's stats-bar "N
// failed") writes this key right before navigating; StudioBoard consumes (reads +
// clears) it once on mount. Shared here so Plan (plan/page.tsx) and StudioBoard.tsx
// agree on the exact key/value without importing each other.
export const FAILED_SUB_ENTRY_KEY = "vp:studio:failed-sub-entry";
export const FAILED_SUB_ENTRY_PUBLISH = "publish";

export type StatusTone = "info" | "success" | "error" | "scheduled" | "neutral";
export type StatusBadge = { lifecycle: PinLifecycle; label: string; tone: StatusTone };

export function getStatusBadge(draft: PinDraft): StatusBadge {
  const lifecycle = getPinLifecycle(draft);
  switch (lifecycle) {
    case "generating": return { lifecycle, label: "Generating",  tone: "info" };
    case "posted":     return { lifecycle, label: "Posted",      tone: "success" };
    case "failed":     return { lifecycle, label: "Failed",      tone: "error" };
    case "scheduled":  return { lifecycle, label: "Scheduled",   tone: "scheduled" };
    case "unscheduled":
    default:           return { lifecycle, label: "Unscheduled", tone: "neutral" };
  }
}

export type SourceBadge = { label: "Uploaded" | "AI Generated" } | null;

/** Separate source badge (never merged with status). */
export function getSourceBadge(draft: Pick<PinDraft, "source">): SourceBadge {
  if (draft.source === "uploaded_image") return { label: "Uploaded" };
  if (draft.source === "ai_generated_from_upload") return { label: "AI Generated" };
  return null;
}

// ── Shared in-flight publish registry ──────────────────────────────────────────
// Prevents a card publish and a batch publish from running on the same draft at
// once, and drives the transient "Publishing…" BUTTON state (not a card status).

const _inFlight = new Set<string>();
const _listeners = new Set<() => void>();
let _inFlightVersion = 0;

function _notify(): void { _inFlightVersion++; _listeners.forEach(fn => fn()); }

/** Monotonic version — use as the useSyncExternalStore snapshot (the Set ref is stable). */
export function getInFlightVersion(): number { return _inFlightVersion; }

/** Claim a draft for publishing. Returns false if it's already in flight (dedupe). */
export function beginPublish(id: string): boolean {
  if (_inFlight.has(id)) return false;
  _inFlight.add(id);
  _notify();
  return true;
}

/** Release a draft after publish success/failure. */
export function endPublish(id: string): void {
  if (_inFlight.delete(id)) _notify();
}

export function isPublishInFlight(id: string): boolean { return _inFlight.has(id); }

export function getInFlightPublishSet(): ReadonlySet<string> { return _inFlight; }

/** Subscribe to in-flight changes (for React re-render of the publishing button). */
export function subscribeInFlight(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}
