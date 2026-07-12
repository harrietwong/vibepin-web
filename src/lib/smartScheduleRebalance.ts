/**
 * Smart Schedule rebalance — full repack of eligible future planned Pins into the
 * latest saved Smart Schedule slots, with a session-undo snapshot.
 *
 * Eligible Pins (Part 7): future, planned (date+time), not posted, not failed,
 * not locked, scheduleSource !== "manual" (legacy/undefined treated as "smart").
 * Posted / past / failed / manual / locked Pins are FIXED — they occupy their slot
 * but are never moved. All date/time math is browser-local (no UTC day-shift).
 */

import type { PinDraft } from "./pinDraftStore";
import * as pinDraftStore from "./pinDraftStore";
import { sanitizeHandoffField } from "./weeklyPlanHandoff";
import {
  getSmartScheduleConfig,
  hasConfiguredSlots,
  type SmartScheduleConfig,
} from "./smartScheduleStore";
import { findNextAvailableScheduleSlot } from "./smartSchedule";

export type RebalanceSnapshotEntry = {
  id: string;
  scheduledDate: string;
  scheduledTime: string;
  plannedAt: string;
  scheduleSource?: "smart" | "manual";
  scheduleLocked?: boolean;
};

export type RebalanceResult = {
  changed: number;
  snapshot: RebalanceSnapshotEntry[];
};

function plannedMs(d: PinDraft): number | null {
  const date = sanitizeHandoffField(d.scheduledDate);
  const time = sanitizeHandoffField(d.scheduledTime);
  if (!date || !time) return null;
  const [y, mo, da] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, mo - 1, da, h, mi, 0, 0).getTime();
}

function isFailed(d: PinDraft): boolean {
  return /fail/i.test(d.generationStatus ?? "");
}

function isPlanned(d: PinDraft): boolean {
  return !!sanitizeHandoffField(d.scheduledDate) && !!sanitizeHandoffField(d.scheduledTime);
}

/** Part 7 — future planned Pins eligible to be moved by a rebalance. */
export function getEligibleRebalancePins(pins: PinDraft[], now: Date = new Date()): PinDraft[] {
  const nowMs = now.getTime();
  return pins.filter(d => {
    if (!isPlanned(d)) return false;
    if (d.postedAt) return false;            // posted Pins are fixed
    if (isFailed(d)) return false;           // failed Pins are skipped
    if (d.scheduleLocked) return false;      // locked Pins are skipped
    if (d.scheduleSource === "manual") return false; // manual Pins are skipped
    const ms = plannedMs(d);
    if (ms === null || ms < nowMs) return false;     // past Pins are skipped
    return true;
  });
}

/** Convenience read against the live store. */
export function countEligibleRebalancePins(now: Date = new Date()): number {
  return getEligibleRebalancePins(pinDraftStore.getAllDrafts(), now).length;
}

/** Future planned Pins that are NOT moved but still occupy their slot (manual/locked,
 *  posted, or otherwise ineligible). Past Pins are ignored — they cannot collide with
 *  future slots. */
function getFixedFuturePlannedPins(pins: PinDraft[], now: Date, eligibleIds: Set<string>): PinDraft[] {
  const nowMs = now.getTime();
  return pins.filter(d => {
    if (eligibleIds.has(d.id)) return false;
    if (!isPlanned(d)) return false;
    const ms = plannedMs(d);
    if (ms === null || ms < nowMs) return false;
    return true;
  });
}

/**
 * Full repack. Saves nothing about the config itself (caller persists config first).
 * Sorts eligible Pins by current plannedAt, then assigns each the next free slot from
 * the latest config.weeklySlots, rolling into future weeks as needed. Never drops a
 * Pin, never produces a duplicate plannedAt, never leaves empty date/time. Persists in
 * one batch and emits one event. Returns the count changed + an undo snapshot.
 */
export function rebalancePlannedPins(opts?: { config?: SmartScheduleConfig; now?: Date }): RebalanceResult {
  const config = opts?.config ?? getSmartScheduleConfig();
  const now = opts?.now ?? new Date();
  if (!hasConfiguredSlots(config)) return { changed: 0, snapshot: [] };

  const all = pinDraftStore.getAllDrafts();
  const eligible = getEligibleRebalancePins(all, now)
    .sort((a, b) => (plannedMs(a) ?? 0) - (plannedMs(b) ?? 0));
  if (eligible.length === 0) return { changed: 0, snapshot: [] };

  const eligibleIds = new Set(eligible.map(d => d.id));
  const fixed = getFixedFuturePlannedPins(all, now, eligibleIds);

  const snapshot: RebalanceSnapshotEntry[] = eligible.map(d => ({
    id: d.id,
    scheduledDate: d.scheduledDate ?? "",
    scheduledTime: d.scheduledTime ?? "",
    plannedAt: d.plannedAt ?? "",
    scheduleSource: d.scheduleSource,
    scheduleLocked: d.scheduleLocked,
  }));

  const extraOccupied = new Set<string>();
  const updates: Array<{ id: string; patch: Partial<PinDraft> }> = [];
  for (const pin of eligible) {
    const slot = findNextAvailableScheduleSlot({
      weeklySlots: config.weeklySlots,
      existingPlannedPins: fixed,
      fromDateTime: now,
      extraOccupied,
    });
    if (!slot) continue; // no slot within window — never drop; leave this Pin unchanged
    extraOccupied.add(`${slot.plannedDate}|${slot.plannedTime}`);
    updates.push({
      id: pin.id,
      patch: {
        scheduledDate: slot.plannedDate,
        scheduledTime: slot.plannedTime,
        plannedAt: slot.plannedAt,
        scheduleSource: "smart",
        scheduleLocked: false,
        autoScheduled: true,
      },
    });
  }

  const changed = pinDraftStore.bulkUpdateDrafts(updates);
  return { changed, snapshot };
}

/** Restore the snapshotted schedule values (one batch + one event). */
export function undoRebalance(snapshot: RebalanceSnapshotEntry[]): number {
  if (!snapshot.length) return 0;
  return pinDraftStore.bulkUpdateDrafts(
    snapshot.map(s => ({
      id: s.id,
      patch: {
        scheduledDate: s.scheduledDate,
        scheduledTime: s.scheduledTime,
        plannedAt: s.plannedAt,           // explicit → bulkUpdateDrafts preserves it
        scheduleSource: s.scheduleSource,
        scheduleLocked: s.scheduleLocked,
      },
    })),
  );
}
