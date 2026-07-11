/**
 * Weekly Plan Smart Schedule actions — shared Add to Plan / batch schedule handlers.
 */

import { autoSchedulePin, autoSchedulePins } from "./smartSchedule";
import { sanitizeHandoffField } from "./weeklyPlanHandoff";
import * as pinDraftStore from "./pinDraftStore";

export type SmartScheduleAddResult = ReturnType<typeof autoSchedulePin>;

export function smartScheduleAddToPlan(id: string): SmartScheduleAddResult {
  return autoSchedulePin(id);
}

export function smartScheduleSelectedPins(ids: string[]): ReturnType<typeof autoSchedulePins> {
  return autoSchedulePins(ids, { skipAlreadyScheduled: true, skipPosted: true });
}

export function filterUnscheduledPinIds(ids: string[]): string[] {
  return ids.filter(id => {
    const d = pinDraftStore.getDraft(id);
    if (!d || d.postedAt) return false;
    if (sanitizeHandoffField(d.scheduledDate) && sanitizeHandoffField(d.scheduledTime)) return false;
    return true;
  });
}

export function mergePostingSlotTimes(baseTimes: string[], configTimes: string[]): string[] {
  return [...new Set([...baseTimes, ...configTimes])].sort();
}
