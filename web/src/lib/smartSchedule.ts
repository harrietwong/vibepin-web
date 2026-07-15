/**
 * Smart Schedule — next available slot + board rotation for Weekly Plan.
 * All date/time math uses the browser local timezone (no UTC day-shift).
 */

import type { PinDraft } from "./pinDraftStore";
import * as pinDraftStore from "./pinDraftStore";
import { isPublishableImage } from "./pinReadiness";
import { combineLocalPlannedAt, localDateISO, sanitizeHandoffField } from "./weeklyPlanHandoff";
import {
  getSmartScheduleConfig,
  hasConfiguredSlots,
  type SmartScheduleBoard,
  type SmartScheduleConfig,
  type WeekdayIndex,
} from "./smartScheduleStore";

export type ScheduleSlot = {
  plannedDate: string;
  plannedTime: string;
  plannedAt:   string;
};

export type FindNextSlotParams = {
  weeklySlots:          Partial<Record<WeekdayIndex, string[]>>;
  existingPlannedPins:  PinDraft[];
  fromDateTime?:        Date;
  extraOccupied?:       Set<string>;
  maxDaysAhead?:        number;
  /** Confine the search to `fromDateTime`'s calendar day. When the caller named an
   *  explicit date (drag, reschedule, legacy normalize), sliding to another day is a
   *  silent relocation, not a schedule — return null instead so the caller can say so. */
  strictDate?:          boolean;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function slotKey(date: string, time: string): string {
  return `${date}|${time}`;
}

function localWeekdayIndex(d: Date): WeekdayIndex {
  return ((d.getDay() + 6) % 7) as WeekdayIndex;
}

function localDateTimeMs(date: string, time: string): number {
  const [y, mo, da] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, mo - 1, da, h, mi, 0, 0).getTime();
}

function buildOccupiedSet(pins: PinDraft[], extra?: Set<string>): Set<string> {
  const set = new Set(extra ?? []);
  for (const p of pins) {
    const date = sanitizeHandoffField(p.scheduledDate);
    const time = sanitizeHandoffField(p.scheduledTime);
    if (date && time) set.add(slotKey(date, time));
  }
  return set;
}

/** Find the next free Smart Schedule slot at or after `fromDateTime` (local). */
export function findNextAvailableScheduleSlot(params: FindNextSlotParams): ScheduleSlot | null {
  const {
    weeklySlots,
    existingPlannedPins,
    fromDateTime = new Date(),
    extraOccupied,
    maxDaysAhead = 90,
    strictDate = false,
  } = params;

  const occupied = buildOccupiedSet(existingPlannedPins, extraOccupied);
  // Never assign a past slot — the floor is ALWAYS the real current time, in both
  // modes. A drag onto today therefore skips this morning's slots, and a strict-date
  // request for a past day (or a past time today) finds nothing and returns null.
  // strictDate constrains only WHICH DAY may be used, never whether the clock applies:
  // relaxing this floor would let a Pin be scheduled into the past, and it would never
  // publish.
  const nowMs = Math.max(fromDateTime.getTime(), Date.now());
  const days = strictDate ? 1 : maxDaysAhead;

  // Soft-date scans must never START in the past. A legacy draft whose own (stale)
  // date is a year old would otherwise burn all `maxDaysAhead` iterations on days that
  // are all before now, find nothing, and return null — stranding a rescuable draft.
  // A strict-date request keeps its exact day (it is honoured-or-fails by design, and
  // the clock floor below still rejects a past day / past time on it).
  const scanStart = new Date(fromDateTime);
  scanStart.setHours(0, 0, 0, 0);
  if (!strictDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (scanStart.getTime() < today.getTime()) scanStart.setTime(today.getTime());
  }

  for (let offset = 0; offset < days; offset++) {
    const day = new Date(scanStart);
    day.setDate(day.getDate() + offset);
    const dateISO = localDateISO(day);
    const dow = localWeekdayIndex(day);
    const times = weeklySlots[dow];
    if (!times?.length) continue;

    for (const time of times) {
      const ms = localDateTimeMs(dateISO, time);
      if (ms <= nowMs) continue;
      if (occupied.has(slotKey(dateISO, time))) continue;
      return {
        plannedDate: dateISO,
        plannedTime: time,
        plannedAt: combineLocalPlannedAt(dateISO, time),
      };
    }
  }
  return null;
}

// ── Day slot grid (Week View time-slot queue) ──────────────────────────────────

export type DaySlotRow = {
  time: string;            // "HH:mm"
  plannedAt: string;       // local YYYY-MM-DDTHH:mm
  isPast: boolean;         // slot time is at/before now → display-only, no drop
  draft: PinDraft | null;  // occupant, if any
  offGrid: boolean;        // occupied at a time NOT in the Smart Schedule grid (manual)
};

/**
 * Build the full ordered slot list for one calendar day: every configured Smart
 * Schedule slot for that weekday (occupied or empty) plus any off-grid occupied
 * times (manual/custom). Used by Week View to render the day as a time-slot queue.
 */
export function buildDaySlotRows(
  dateISO: string,
  dayDrafts: PinDraft[],
  opts?: { config?: SmartScheduleConfig; now?: Date },
): DaySlotRow[] {
  const config = opts?.config ?? getSmartScheduleConfig();
  const nowMs = (opts?.now ?? new Date()).getTime();
  const dow = localWeekdayIndex(new Date(`${dateISO}T00:00:00`));
  const configTimes = config.weeklySlots[dow] ?? [];
  const byTime = new Map<string, PinDraft>();
  for (const d of dayDrafts) {
    const t = sanitizeHandoffField(d.scheduledTime);
    if (t) byTime.set(t, d);
  }
  const rows: DaySlotRow[] = [];
  const seen = new Set<string>();
  for (const time of configTimes) {
    seen.add(time);
    const ms = localDateTimeMs(dateISO, time);
    rows.push({ time, plannedAt: combineLocalPlannedAt(dateISO, time), isPast: ms <= nowMs, draft: byTime.get(time) ?? null, offGrid: false });
  }
  for (const [time, d] of byTime) {
    if (seen.has(time)) continue;
    const ms = localDateTimeMs(dateISO, time);
    rows.push({ time, plannedAt: combineLocalPlannedAt(dateISO, time), isPast: ms <= nowMs, draft: d, offGrid: true });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  return rows;
}

/** True when the day has at least one FUTURE empty configured slot to accept a Pin. */
export function dayHasFreeFutureSlot(
  dateISO: string,
  dayDrafts: PinDraft[],
  opts?: { config?: SmartScheduleConfig; now?: Date },
): boolean {
  return buildDaySlotRows(dateISO, dayDrafts, opts).some(r => !r.isPast && !r.draft && !r.offGrid);
}

/** How many configured slots a weekday has (for "N scheduled Pins" messaging). */
export function configuredSlotCountForDate(dateISO: string, config?: SmartScheduleConfig): number {
  const cfg = config ?? getSmartScheduleConfig();
  const dow = localWeekdayIndex(new Date(`${dateISO}T00:00:00`));
  return (cfg.weeklySlots[dow] ?? []).length;
}

export type DayDropBlockReason = "all_past" | "full" | "no_slots";

/**
 * Explain WHY a day can't accept a day-level drop — only meaningful when
 * `dayHasFreeFutureSlot` is false. This exists so the drop-rejection toast tells
 * the truth instead of always claiming the day is "full":
 *   "no_slots" → the weekday has no configured Smart Schedule slots at all
 *   "all_past" → slots exist and are free, but every remaining one is in the past
 *                (e.g. dragging onto TODAY after its last slot time has passed)
 *   "full"     → every configured slot is occupied by a scheduled Pin
 * `scheduledCount` is the REAL number of Pins already scheduled on that day
 * (grid + off-grid) — never the configured-slot count.
 */
export function classifyDayDropBlock(
  dateISO: string,
  dayDrafts: PinDraft[],
  opts?: { config?: SmartScheduleConfig; now?: Date },
): { reason: DayDropBlockReason; scheduledCount: number } {
  const rows = buildDaySlotRows(dateISO, dayDrafts, opts);
  const scheduledCount = rows.filter(r => r.draft).length;
  if (configuredSlotCountForDate(dateISO, opts?.config) === 0) {
    return { reason: "no_slots", scheduledCount };
  }
  // Discriminate purely on whether any configured (grid) slot is still in the future.
  // Under this function's precondition (no free FUTURE slot) such a slot must be
  // occupied — so if one exists the day is genuinely "full". Only when EVERY
  // configured slot has already passed is the block truly "all_past". A free-but-past
  // morning slot must NOT mask a full evening: that's the bug this fixes.
  const hasFutureConfiguredSlot = rows.some(r => !r.offGrid && !r.isPast);
  if (hasFutureConfiguredSlot) return { reason: "full", scheduledCount };
  return { reason: "all_past", scheduledCount };
}

/** Canonical "next available slot" entry point: always reads the shared Smart
 *  Schedule weeklySlots (unless a config is passed for tests). Every Schedule /
 *  Add to Plan / Schedule-selected path resolves time through this. */
export function getNextSmartScheduleSlot(
  existingPlannedPins: PinDraft[],
  config?: SmartScheduleConfig,
): ScheduleSlot | null {
  const cfg = config ?? getSmartScheduleConfig();
  if (!hasConfiguredSlots(cfg)) return null;
  return findNextAvailableScheduleSlot({
    weeklySlots: cfg.weeklySlots,
    existingPlannedPins,
  });
}

/** Deterministic round-robin: slot index modulo selected boards. */
export function pickBoardForRotation(
  boards: SmartScheduleBoard[],
  slotIndex: number,
): SmartScheduleBoard | null {
  if (!boards.length) return null;
  const idx = ((slotIndex % boards.length) + boards.length) % boards.length;
  return boards[idx] ?? null;
}

export function countScheduledWithDateTime(pins: PinDraft[]): number {
  return pins.filter(p => sanitizeHandoffField(p.scheduledDate) && sanitizeHandoffField(p.scheduledTime)).length;
}

export function formatScheduleTimeLabel(time: string): string {
  const [hRaw, mRaw] = time.split(":");
  const h = Number(hRaw);
  if (Number.isNaN(h)) return time;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(Number(mRaw ?? 0)).padStart(2, "0")} ${ampm}`;
}

export function formatScheduleDateLabel(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00`);
  const weekday = DAY_LABELS[localWeekdayIndex(d)] ?? d.toLocaleDateString("en-US", { weekday: "short" });
  const rest = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${weekday}, ${rest}`;
}

export function formatSmartScheduleToast(slot: ScheduleSlot, board: SmartScheduleBoard | null): string {
  const when = `${formatScheduleDateLabel(slot.plannedDate)} at ${formatScheduleTimeLabel(slot.plannedTime)}`;
  if (board?.boardName) {
    return `Scheduled to ${board.boardName} on ${when}.`;
  }
  return `Scheduled for ${when}.`;
}

export type AutoScheduleResult =
  | { ok: true; draft: PinDraft; toast: string; slot: ScheduleSlot; board: SmartScheduleBoard | null }
  | { ok: false; reason: "no_schedule" | "no_slot" | "not_found" | "not_ready"; toast: string };

export type EnsureScheduleOpts = {
  /** Desired calendar date (keeps the user's chosen day; a real slot time is still
   *  assigned on that day or the next active day). Omit to use the next free slot. */
  date?:          string;
  /** Force a fresh slot even if the Pin already has a plannedAt (Reschedule/Move). */
  reschedule?:    boolean;
  /** "smart" (default) is rebalance-eligible; "manual" pins the Pin (user move/reschedule). */
  source?:        "smart" | "manual";
  config?:        SmartScheduleConfig;
  slotIndex?:     number;
  extraOccupied?: Set<string>;
};

/**
 * Canonical "make sure this Pin has a real stored plan time" helper. Every
 * Schedule / Add to Plan / drag / reschedule path routes through this so a
 * scheduled Pin ALWAYS ends up with plannedDate + plannedTime + plannedAt
 * persisted together — never a date-only / time-less state.
 *
 * - Already has date + time + plannedAt (and not rescheduling): kept as-is.
 * - Has a date but no time: next free Smart Schedule slot on that date / next active day.
 * - Has nothing (or rescheduling): next free Smart Schedule slot.
 */
export function ensureScheduledPlanTime(id: string, opts?: EnsureScheduleOpts): AutoScheduleResult {
  const draft = pinDraftStore.getDraft(id);
  if (!draft) return { ok: false, reason: "not_found", toast: "Pin not found." };

  // A scheduled Pin may auto-publish without another user review. Keep this gate
  // deliberately narrower than copy quality: only delivery-critical fields block.
  if (!isPublishableImage(draft.imageUrl)) {
    return { ok: false, reason: "not_ready", toast: "Upload a usable image before scheduling this Pin." };
  }
  if (!sanitizeHandoffField(draft.boardId)) {
    return { ok: false, reason: "not_ready", toast: "Choose a Pinterest board before scheduling this Pin." };
  }

  const curDate = sanitizeHandoffField(draft.scheduledDate);
  const curTime = sanitizeHandoffField(draft.scheduledTime);
  const curPlannedAt = sanitizeHandoffField(draft.plannedAt);
  // A date the CALLER named is an intent to honour exactly (drag, reschedule); the
  // draft's own stored date is merely a default. Conflating them meant an omitted
  // opts.date silently fell back to curDate and re-locked the search onto it — which
  // strands a draft whose stored day has already passed.
  const requestedDate = sanitizeHandoffField(opts?.date ?? "");
  const targetDate = requestedDate || curDate;

  // Idempotent: a fully-scheduled Pin is left untouched unless we are explicitly
  // rescheduling or moving it to a different date.
  const keepExisting = !opts?.reschedule && !!curDate && !!curTime && !!curPlannedAt
    && (!opts?.date || opts.date === curDate);
  if (keepExisting) {
    const slot: ScheduleSlot = { plannedDate: curDate, plannedTime: curTime, plannedAt: curPlannedAt };
    return { ok: true, draft, toast: formatSmartScheduleToast(slot, null), slot, board: null };
  }

  const config = opts?.config ?? getSmartScheduleConfig();
  if (!hasConfiguredSlots(config)) {
    return { ok: false, reason: "no_schedule", toast: "Set up Smart Schedule first to auto-assign date and time." };
  }

  // Exclude self so a Pin that already has a date/time doesn't block its own slot.
  const existing = pinDraftStore.getAllDrafts().filter(d => d.id !== id);
  // Only a date the CALLER named locks the search to that day: honour it exactly —
  // assign a time on it or fail, never slide the Pin to another day while reporting
  // success. A date merely inherited from the draft stays a soft starting point, so a
  // draft sitting on a day that has already passed can still be rescued forward.
  const strictDate = !!requestedDate;
  const fromDateTime = targetDate ? new Date(`${targetDate}T00:00:00`) : new Date();
  const slot = findNextAvailableScheduleSlot({
    weeklySlots: config.weeklySlots,
    existingPlannedPins: existing,
    fromDateTime,
    extraOccupied: opts?.extraOccupied,
    strictDate,
  });
  if (!slot) {
    return strictDate
      ? { ok: false, reason: "no_slot", toast: "No free Smart Schedule slot on that day. Pick another day or add a slot." }
      : { ok: false, reason: "no_slot", toast: "No available Smart Schedule slots in the next 90 days." };
  }

  const slotIndex = opts?.slotIndex ?? countScheduledWithDateTime(existing);
  const board = pickBoardForRotation(config.boards, slotIndex);
  const updated = pinDraftStore.smartScheduleDraft(id, slot, board, { source: opts?.source ?? "smart" });
  if (!updated) return { ok: false, reason: "not_found", toast: "Could not schedule Pin." };
  return { ok: true, draft: updated, toast: formatSmartScheduleToast(slot, board), slot, board };
}

/**
 * Safe one-shot normalization for legacy "in plan but time-less" drafts. Any draft
 * that is added to plan (or has a date) yet lacks a stored time gets the next free
 * Smart Schedule slot persisted. Updates existing drafts in place — never creates
 * duplicates. Returns the number of drafts normalized.
 */
export function normalizeInPlanDraftTimes(): number {
  const drafts = pinDraftStore.getAllDrafts();
  const config = getSmartScheduleConfig();
  if (!hasConfiguredSlots(config)) return 0;
  const extraOccupied = new Set<string>();
  let fixed = 0;
  for (const d of drafts) {
    if (d.postedAt) continue;
    const inPlan = !!sanitizeHandoffField(d.addedToPlanAt)
      || !!sanitizeHandoffField(d.scheduledDate);
    if (!inPlan) continue;
    const hasTime = !!sanitizeHandoffField(d.scheduledTime);
    if (hasTime) continue;
    // Never re-pass the draft's own date as a STRICT date: strict is honour-or-fail, so
    // a draft on a full future day (or a day whose slots have all passed, or a day that
    // is simply gone) would fail to normalize and stay stranded. Instead let the draft's
    // stored date act as a SOFT starting point — ensureScheduledPlanTime + the soft scan
    // keep that day when it still has a free future slot, and otherwise walk FORWARD from
    // today to the next free slot. Passing `date` here would make it strict; we don't.
    const res = ensureScheduledPlanTime(d.id, {
      config,
      extraOccupied,
    });
    if (res.ok) {
      extraOccupied.add(`${res.slot.plannedDate}|${res.slot.plannedTime}`);
      fixed++;
    }
  }
  return fixed;
}

export function autoSchedulePin(
  id: string,
  opts?: { config?: SmartScheduleConfig; extraOccupied?: Set<string>; slotIndex?: number },
): AutoScheduleResult {
  const draft = pinDraftStore.getDraft(id);
  if (!draft) {
    return { ok: false, reason: "not_found", toast: "Pin not found." };
  }

  const config = opts?.config ?? getSmartScheduleConfig();
  if (!hasConfiguredSlots(config)) {
    return {
      ok: false,
      reason: "no_schedule",
      toast: "Set up Smart Schedule first to auto-assign date and time.",
    };
  }

  const existing = pinDraftStore.getAllDrafts();
  const slot = findNextAvailableScheduleSlot({
    weeklySlots: config.weeklySlots,
    existingPlannedPins: existing,
    extraOccupied: opts?.extraOccupied,
  });

  if (!slot) {
    return {
      ok: false,
      reason: "no_slot",
      toast: "No available Smart Schedule slots in the next 90 days.",
    };
  }

  const slotIndex = opts?.slotIndex ?? countScheduledWithDateTime(existing);
  const board = pickBoardForRotation(config.boards, slotIndex);
  const updated = pinDraftStore.smartScheduleDraft(id, slot, board);

  if (!updated) {
    return { ok: false, reason: "not_found", toast: "Could not schedule Pin." };
  }

  return {
    ok: true,
    draft: updated,
    toast: formatSmartScheduleToast(slot, board),
    slot,
    board,
  };
}

export type BatchAutoScheduleResult = {
  scheduled: number;
  skipped:   number;
  toasts:    string[];
};

/** Schedule multiple Pins into sequential upcoming slots (skips posted + already scheduled by default). */
export function autoSchedulePins(
  ids: string[],
  opts?: {
    skipAlreadyScheduled?: boolean;
    skipPosted?: boolean;
    config?: SmartScheduleConfig;
  },
): BatchAutoScheduleResult {
  const skipScheduled = opts?.skipAlreadyScheduled !== false;
  const skipPosted = opts?.skipPosted !== false;
  const config = opts?.config ?? getSmartScheduleConfig();
  const existing = pinDraftStore.getAllDrafts();
  const extraOccupied = new Set<string>();
  let slotIndex = countScheduledWithDateTime(existing);
  let scheduled = 0;
  let skipped = 0;
  const toasts: string[] = [];

  for (const id of ids) {
    const d = pinDraftStore.getDraft(id);
    if (!d) { skipped++; continue; }
    if (skipPosted && d.postedAt) { skipped++; continue; }
    if (skipScheduled && sanitizeHandoffField(d.scheduledDate) && sanitizeHandoffField(d.scheduledTime)) {
      skipped++;
      continue;
    }

    const result = autoSchedulePin(id, { config, extraOccupied, slotIndex });
    if (!result.ok) {
      skipped++;
      if (toasts.length === 0) toasts.push(result.toast);
      continue;
    }

    extraOccupied.add(slotKey(result.slot.plannedDate, result.slot.plannedTime));
    slotIndex++;
    scheduled++;
    if (scheduled <= 3) toasts.push(result.toast);
  }

  if (scheduled > 3) {
    toasts.push(`Scheduled ${scheduled} Pins to upcoming Smart Schedule slots.`);
  }

  return { scheduled, skipped, toasts };
}
