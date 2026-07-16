/**
 * promote.ts — pure helpers that lift the Creative-Intelligence blocks out of a
 * PinDraft `payload` into the v41 pin_drafts promoted columns
 * ({image_analysis, recommended_keywords, creative_selections}).
 *
 * `payload` stays the authority (the whole PinDraft round-trips through it); these
 * columns are query-friendly copies, mirroring the existing status/archived_at/
 * deleted_at promotions. No next/supabase imports so they unit-test in isolation
 * (scripts/test-pin-draft-promote.ts). Every block is null when empty so an unset
 * feature leaves the column null instead of storing noise.
 */

export interface PromotedCreativeColumns {
  image_analysis:       Record<string, unknown> | null;
  recommended_keywords: unknown[] | null;
  creative_selections:  Record<string, unknown> | null;
}

/** True for values worth promoting (non-empty string / non-empty array / object). */
function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Drop keys whose value is undefined (keeps nulls/empties the caller chose to send). */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Build the nested image_analysis object from the flat PinDraft analysis fields. */
export function buildImageAnalysis(payload: Record<string, unknown>): Record<string, unknown> | null {
  const fields = {
    summary:   payload.imageSummary,
    objects:   payload.visibleObjects,
    colors:    payload.colors,
    style:     payload.style,
    ocr:       payload.ocrText,
    category:  payload.imageCategory,
    model:     payload.imageAnalysisModel,
    updatedAt: payload.imageAnalysisUpdatedAt,
    status:    payload.imageAnalysisStatus,
  };
  const anyPresent = Object.values(fields).some(present);
  return anyPresent ? stripUndefined(fields) : null;
}

/** Recommended keywords as a plain string[] column, or null when none. */
export function buildRecommendedKeywords(payload: Record<string, unknown>): unknown[] | null {
  const kws = payload.recommendedKeywords;
  return Array.isArray(kws) && kws.length > 0 ? kws : null;
}

/** creative_selections column straight from the payload block, or null when empty. */
export function buildCreativeSelections(payload: Record<string, unknown>): Record<string, unknown> | null {
  const sel = payload.creativeSelections;
  if (!sel || typeof sel !== "object" || Array.isArray(sel)) return null;
  const cleaned = stripUndefined(sel as Record<string, unknown>);
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/** All three promoted columns for a single PinDraft payload. */
export function buildPromotedColumns(payload: Record<string, unknown>): PromotedCreativeColumns {
  return {
    image_analysis:       buildImageAnalysis(payload),
    recommended_keywords: buildRecommendedKeywords(payload),
    creative_selections:  buildCreativeSelections(payload),
  };
}

/** Keys added by buildPromotedColumns — used to strip them on the missing-column fallback. */
export const PROMOTED_COLUMN_KEYS: Array<keyof PromotedCreativeColumns> = [
  "image_analysis",
  "recommended_keywords",
  "creative_selections",
];

// ── v42 scheduling promotion (WP-A) ─────────────────────────────────────────────────
// pin_drafts.scheduled_at is a promoted, server-queryable copy of the Pin's due time
// (the cron scheduler needs to index/compare it; payload.plannedAt is a client-local
// wall-clock string the server can't index). publish_claimed_at is DELIBERATELY not
// built here — it is a cron-only claim lock; the client PUT must never write it, and the
// route's partial-column upsert leaves any existing lock intact by simply omitting it.

/** True for a non-empty trimmed string. */
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Compute the Pin's due instant (ISO 8601, UTC) from a PinDraft payload, or null.
 *
 * Sources, in priority order:
 *   1. payload.plannedAt        — local "YYYY-MM-DDTHH:mm" (studio store authority)
 *   2. scheduledDate[+scheduledTime] — "YYYY-MM-DD" [+ "HH:mm"] fallback
 *
 * Returns null when the Pin is NOT scheduled, OR is already posted (postedAt /
 * remotePinId present) — a posted Pin must never be re-scanned as "due".
 *
 * KNOWN MVP LIMITATION (see docs/运维/自动发布-cron配置.md): plannedAt is a client-local
 * wall-clock string with no timezone (pinDraftStore keeps it UTC-free on purpose) and the
 * server stores no per-user timezone, so the wall-clock time is interpreted as UTC. This
 * is deterministic but can be off by the user's UTC offset; a per-user tz is a later P1.
 */
export function buildScheduledAt(payload: Record<string, unknown>): string | null {
  // Already published → never due.
  if (nonEmptyString(payload.postedAt) || nonEmptyString(payload.remotePinId)) return null;

  const local = deriveLocalPlanned(payload);
  if (!local) return null;

  // Interpret the wall-clock "YYYY-MM-DDTHH:mm" as UTC (append seconds + Z).
  const iso = `${local}:00.000Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Pull a "YYYY-MM-DDTHH:mm" local wall-clock string from plannedAt or date+time. */
function deriveLocalPlanned(payload: Record<string, unknown>): string | null {
  const planned = payload.plannedAt;
  if (nonEmptyString(planned)) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(planned.trim());
    if (m) return `${m[1]}T${m[2] ?? "00:00"}`;
  }

  const date = payload.scheduledDate;
  if (nonEmptyString(date)) {
    const dm = /^(\d{4}-\d{2}-\d{2})/.exec(date.trim());
    if (dm) {
      const time = payload.scheduledTime;
      const tm = nonEmptyString(time) ? /^(\d{2}:\d{2})/.exec(time.trim()) : null;
      return `${dm[1]}T${tm ? tm[1] : "00:00"}`;
    }
  }
  return null;
}

/** The single v42 promoted column the client PUT path writes (scheduled_at only —
 *  NOT publish_claimed_at, which is cron-owned). Registered under its own missing-column
 *  latch so it can be stripped independently of the v41 columns. */
export interface PromotedScheduleColumns {
  scheduled_at: string | null;
}

export function buildScheduleColumns(payload: Record<string, unknown>): PromotedScheduleColumns {
  return { scheduled_at: buildScheduledAt(payload) };
}

/** Keys added by buildScheduleColumns — stripped on the v42 missing-column fallback. */
export const SCHEDULE_COLUMN_KEYS: Array<keyof PromotedScheduleColumns> = ["scheduled_at"];
