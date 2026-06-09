import * as pinDraftStore from "@/lib/pinDraftStore";
import type { PinDraft } from "@/lib/pinDraftStore";
import { sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";

export type WeeklyPlanStats = {
  plannedThisWeek:      number;
  ready:                number;
  needsDetails:         number;
  unscheduledGenerated: number;
  posted:               number;
};

export function dateInWeek(dateStr: string, weekStart: string): boolean {
  if (!sanitizeHandoffField(dateStr)) return false;
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const d = new Date(`${dateStr}T00:00:00`);
  return d >= start && d < end;
}

export function weekDateISO(weekStart: string, dayIndex: number): string {
  const d = new Date(`${weekStart}T00:00:00`);
  d.setDate(d.getDate() + dayIndex);
  return d.toISOString().slice(0, 10);
}

export function draftsForCategory(category: string): PinDraft[] {
  return pinDraftStore.getAllDrafts().filter(d => d.category === category);
}

export function getAddedNeedsDateDrafts(category: string, weekStart: string): PinDraft[] {
  return draftsForCategory(category).filter(
    d => pinDraftStore.isDraftAddedToWeeklyPlan(d) && !d.postedAt && !dateInWeek(d.scheduledDate, weekStart),
  );
}

export function addedNeedsDateLabel(): { label: string; color: string } {
  return { label: "In plan · assign date", color: "#D97706" };
}

export function computeWeeklyPlanStatsFromDrafts(drafts: PinDraft[], weekStart: string): WeeklyPlanStats {
  const added = drafts.filter(pinDraftStore.isDraftAddedToWeeklyPlan);
  const unadded = drafts.filter(d => !pinDraftStore.isDraftAddedToWeeklyPlan(d));
  const inWeek = added.filter(d => dateInWeek(d.scheduledDate, weekStart));

  const needsDetails = added.filter(d => {
    if (d.postedAt) return false;
    if (!dateInWeek(d.scheduledDate, weekStart)) return true;
    return d.status !== "ready";
  }).length;

  return {
    plannedThisWeek:      inWeek.length,
    ready:                inWeek.filter(d => d.status === "ready" && !d.postedAt).length,
    needsDetails,
    unscheduledGenerated: unadded.length,
    posted:               added.filter(d => !!d.postedAt && dateInWeek(d.scheduledDate, weekStart)).length,
  };
}

export function computeWeeklyPlanStats(category: string, weekStart: string): WeeklyPlanStats {
  return computeWeeklyPlanStatsFromDrafts(draftsForCategory(category), weekStart);
}

export function scheduledDraftsInWeek(category: string, weekStart: string): PinDraft[] {
  return draftsForCategory(category).filter(
    d => pinDraftStore.isDraftAddedToWeeklyPlan(d) && dateInWeek(d.scheduledDate, weekStart),
  );
}

export function unaddedStatusLabel(): { label: string; color: string } {
  return { label: "Not added to plan", color: "#64748B" };
}
