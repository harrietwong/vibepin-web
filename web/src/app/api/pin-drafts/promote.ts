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
 * TIMEZONE (RC0 WP2): the wall-clock has no offset of its own, so we need the user's
 * timezone to resolve it to a real UTC instant. When payload.scheduleTimezone is a valid
 * IANA zone (stamped client-side at schedule time), the wall-clock is interpreted IN THAT
 * ZONE via an Intl offset-probe (zero npm deps) — a Los Angeles 9am schedules at 17:00Z in
 * winter / 16:00Z in summer, not at 9am UTC. LEGACY drafts (no scheduleTimezone) and an
 * invalid/unknown zone FALL BACK to interpreting the wall-clock as UTC — the prior, still
 * deterministic behavior — so nothing regresses for Pins scheduled before this change.
 */
export function buildScheduledAt(payload: Record<string, unknown>): string | null {
  // Already published → never due.
  if (nonEmptyString(payload.postedAt) || nonEmptyString(payload.remotePinId)) return null;

  const local = deriveLocalPlanned(payload);
  if (!local) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];

  const tz = nonEmptyString(payload.scheduleTimezone) ? payload.scheduleTimezone.trim() : "";
  if (tz) {
    const ms = wallClockToUtcMs(y, mo, d, h, mi, tz);
    if (ms !== null) return new Date(ms).toISOString();
    // Invalid zone / Intl threw → fall through to the legacy UTC interpretation.
  }

  // LEGACY / no-tz / invalid-tz fallback: interpret the wall-clock as UTC.
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  if (Number.isNaN(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

/**
 * Resolve a wall-clock (already split into components) in an IANA `tz` to a UTC epoch-ms,
 * with NO npm dependency, using an Intl offset probe:
 *
 *   1. Guess the instant as if the wall-clock were UTC.
 *   2. Format that instant back into `tz` and read the zone's wall-clock for it.
 *   3. The gap between the target wall-clock and the observed one is (minus) the zone
 *      offset; correct the guess by that gap. Iterate once more to settle DST edges.
 *
 * DST boundaries (deterministic by construction):
 *   • Spring-forward gap (a wall-clock that does not exist, e.g. 02:30 on a US spring
 *     day): the probe lands on the post-gap offset, so the result is the equivalent
 *     instant just after the gap — the schedule effectively shifts forward by the gap.
 *   • Fall-back overlap (a wall-clock that occurs twice): the two-step convergence keys
 *     off the guess derived from the PRE-transition (earlier, e.g. EDT) offset, yielding
 *     the FIRST occurrence — the earlier UTC instant. Deterministic, never ambiguous.
 *
 * Returns null if `tz` is not a usable IANA zone (Intl throws) so the caller can fall back.
 */
function wallClockToUtcMs(
  y: number, mo: number, d: number, h: number, mi: number, tz: string,
): number | null {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    // A bogus-but-non-throwing string ("Not/AZone") still throws here on all engines;
    // guard by formatting once — if it throws, the zone is unusable.
    dtf.format(0);
  } catch {
    return null;
  }

  const targetUtc = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  // Read the zone's wall-clock (as a UTC-epoch of those displayed components) for a given
  // real instant, so the difference (target − observed) is the offset correction to apply.
  const observedWallMs = (instantMs: number): number => {
    const parts = dtf.formatToParts(new Date(instantMs));
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
    let hh = get("hour");
    if (hh === 24) hh = 0; // h23 can render midnight as 24 on some engines.
    return Date.UTC(get("year"), get("month") - 1, get("day"), hh, get("minute"), get("second"));
  };

  // Iterate to convergence (≤2 passes settle even across a DST edge).
  let guess = targetUtc;
  for (let i = 0; i < 2; i++) {
    const diff = targetUtc - observedWallMs(guess);
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
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
