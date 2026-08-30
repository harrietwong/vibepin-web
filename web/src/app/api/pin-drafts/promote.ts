import { isSocialProvider, unschedulableDestinations, type SocialProvider } from "@/lib/social/platforms";
import { isUsableDestination } from "@/lib/social/scheduledDestinations";
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
 * Returns null when the Pin is NOT scheduled.
 *
 * PUBLISHED MARKERS (postedAt / remotePinId) do NOT blanket-null the result any more.
 * They used to, and that made a reschedule of a Posted Content unrunnable: the cron
 * scans `scheduled_at`, so nulling it here meant the merchant's new slot was never
 * looked at. It killed BOTH the deliberate re-schedule (the drawer/card path never
 * clears postedAt/remotePinId — smartScheduleDraft / assignDraftToDate / bulkUpdateDrafts
 * only touch the schedule fields) and the 409 re-base case, where the re-based retry
 * legitimately carries the server's postedAt together with the merchant's new time.
 *
 * The rule now distinguishes the two things a schedule-plus-marker can mean:
 *   • schedule STRICTLY LATER than postedAt → a deliberate re-schedule made after the
 *     post. It is honoured. Re-sending is prevented downstream, not here: the cron's
 *     owed rule `publishedForSchedule` (publishedAt >= scheduledAt) closes exactly the
 *     destinations already published FOR this schedule, and `supersededDestinationResults`
 *     archives the earlier post's permalink into `previousResults`.
 *   • schedule NOT later than the post → a stale client still holding the pre-publish
 *     schedule. Nulled, as before.
 *
 * LEGACY / UNPARSEABLE: a `remotePinId` with no usable `postedAt` cannot be compared, so
 * it is NULLED (the old behaviour). Deliberately not `updatedAt`-as-proxy: the reschedule
 * edit itself bumps `updatedAt` to now, so every future schedule would pass trivially and
 * the guard would vanish for precisely the rows that have no publish history to protect
 * them — such rows may carry `remotePinId` with no `destinationResults` at all, so
 * `pendingDestinations` would owe every destination and double-post.
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
  const scheduled = deriveScheduledAt(payload);
  if (!scheduled) return null;
  return publishedGuardAllows(payload, scheduled) ? scheduled : null;
}

/**
 * Does the published state of this payload allow `scheduled` to stand?
 *
 * True when nothing says the Content was posted, or when the schedule is strictly
 * later than the post it would supersede. False for the stale-client case (the schedule
 * is the pre-publish one the client still holds) and for a posted Content whose
 * post-time cannot be read — see the LEGACY note on buildScheduledAt.
 */
function publishedGuardAllows(payload: Record<string, unknown>, scheduled: string): boolean {
  const postedAt = nonEmptyString(payload.postedAt) ? payload.postedAt.trim() : "";
  const hasMarker = !!postedAt || nonEmptyString(payload.remotePinId);
  if (!hasMarker) return true;

  const postedMs = postedAt ? Date.parse(postedAt) : NaN;
  if (Number.isNaN(postedMs)) return false; // legacy / unparseable → keep nulling.
  const scheduledMs = Date.parse(scheduled);
  if (Number.isNaN(scheduledMs)) return false;
  return scheduledMs > postedMs;
}

/** The due instant the payload's wall-clock resolves to, ignoring published state. */
function deriveScheduledAt(payload: Record<string, unknown>): string | null {
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

// ── Schedulable-destination rule ─────────────────────────────────────────────
/**
 * The destinations a payload asks to publish to, restricted to real providers.
 *
 * READ FROM `scheduledDestinations` — the canonical, PERSISTED intent
 * (`{provider, socialConnectionId, …}`, written by buildScheduledDestinations).
 *
 * It used to read `payload.socialDestinations`, a field NOTHING writes: the drawer's
 * `socialDestinations` is local React state that never reaches the payload. So this
 * always returned [], `blockedScheduleDestinations` was always empty, and the PUT
 * handler's 422 could not fire for any request — a guard wired to a value its
 * condition can never be true for. A payload that still carries `socialDestinations`
 * is deliberately IGNORED: it is not intent, nothing at due time reads it, and
 * honouring it would let a client be refused for a destination it never scheduled.
 *
 * Only USABLE entries count (`isUsableDestination`: a real provider AND an account) —
 * the same filter `resolveScheduledDestinations` applies before dispatch, so this rule
 * refuses exactly what the due-time worker would otherwise be asked to publish, and
 * nothing else. Deduped by provider: two Pinterest accounts are one platform here.
 */
export function requestedSocialDestinations(payload: Record<string, unknown>): SocialProvider[] {
  const raw = payload.scheduledDestinations;
  if (!Array.isArray(raw)) return [];
  const out: SocialProvider[] = [];
  for (const entry of raw) {
    // isUsableDestination already rejects a non-provider; isSocialProvider is what
    // NARROWS it (ScheduledDestination.provider is typed `string` on purpose).
    if (!isUsableDestination(entry) || !isSocialProvider(entry.provider)) continue;
    if (!out.includes(entry.provider)) out.push(entry.provider);
  }
  return out;
}

/**
 * Which of a payload's destinations cannot be honoured at due time.
 *
 * Only applies to a payload that is actually being scheduled: publishing now has
 * no persistence requirement, so an unscheduled draft may name anything.
 *
 * Extracted from the PUT handler so the rule can be tested directly. The route
 * requires a real bearer token (there is deliberately no test bypass on it), so
 * asserting this through HTTP would need a live session; the handler calls this
 * exact function, and a test asserts the handler still does.
 */
export function blockedScheduleDestinations(payload: Record<string, unknown>): SocialProvider[] {
  if (!buildScheduledAt(payload)) return [];
  return unschedulableDestinations(requestedSocialDestinations(payload));
}


// ── Destination-existence rule (the other half of the remove race) ───────────
/**
 * The connection ids a scheduled payload will actually try to publish through.
 *
 * The remove path now refuses to delete an account while live schedules name it
 * (remove_social_connection_if_unscheduled, v67). That closes one direction of
 * the race. This closes the other: a schedule WRITTEN after the account was
 * removed. Without it, the merchant's browser — which may have been open since
 * before the removal — happily persists a schedule naming a row that no longer
 * exists, and the cron inherits exactly the orphan the delete guard exists to
 * prevent.
 *
 * The 口径 mirrors `resolveScheduledDestinations`, because the point is to
 * validate what the DUE-TIME worker will read, not what the payload happens to
 * contain:
 *   - usable `scheduledDestinations[]` entries win, and each names its account.
 *   - with none, the legacy `targetConnectionId` is the single derived Pinterest
 *     target — so it is validated only THEN, exactly when it is the thing that
 *     will be published through.
 *
 * Pure on purpose: this file is imported under bare `tsx` by several tests, so
 * it must not reach a database or import anything server-only. The lookup lives
 * in `lib/server/social/scheduledDestinationsAvailable.ts`.
 */
export function requiredScheduleConnectionIds(payload: Record<string, unknown>): string[] {
  const raw = payload.scheduledDestinations;
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isUsableDestination(entry)) continue;
      const id = typeof entry.socialConnectionId === "string" ? entry.socialConnectionId.trim() : "";
      if (id && !out.includes(id)) out.push(id);
    }
  }
  if (out.length > 0) return out;

  // Legacy single target: only meaningful when nothing usable was stored, which
  // is precisely when resolveScheduledDestinations derives Pinterest from it.
  const legacy = payload.targetConnectionId;
  const legacyId = typeof legacy === "string" ? legacy.trim() : "";
  return legacyId ? [legacyId] : [];
}
