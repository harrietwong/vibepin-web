import * as pinDraftStore from "@/lib/pinDraftStore";
import type { PinDraft } from "@/lib/pinDraftStore";
import { sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";
import { isPinReady, type ReadinessInput } from "@/lib/pinReadiness";
import { countPublishFailures } from "@/lib/studio/pinLifecycle";

/** Sentinel meaning "every category" — the Weekly Plan is one unified publishing
 *  calendar by default, with category only an optional filter. */
export const ALL_CATEGORIES = "all";

/** Normalize a PinDraft to the shared readiness shape (board-aware). */
export function draftReadiness(d: PinDraft): ReadinessInput {
  return {
    imageUrl:         d.imageUrl,
    title:            d.title,
    description:      d.description,
    altText:          d.altText,
    destinationUrl:   d.destinationUrl,
    boardId:          d.boardId || d.metadataDraft?.boardId || "",
    primaryProductId: d.metadataDraft?.primaryProduct?.productId || d.metadataDraft?.linkedProductId || "",
  };
}

/** Board-aware "ready to publish". */
export function isDraftReadyToPublish(d: PinDraft): boolean {
  return isPinReady(draftReadiness(d));
}

export type WeeklyPlanStats = {
  scheduled:            number;
  published:            number;
  unscheduled:          number;
  plannedThisWeek:      number;
  ready:                number;
  needsDetails:         number;
  unscheduledGenerated: number;
  posted:               number;
  /** Publish-failure count (PRD "失败情况优化" §3) — GLOBAL, same source as the
   *  FailureBanner (countPublishFailures over ALL drafts), intentionally NOT scoped
   *  to the current week/category: the Banner/recovery flow is a single global
   *  concept, so the stats-bar "N failed" must always agree with the Banner's count. */
  failed:               number;
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

/** True when dateStr falls in the same calendar month/year as anchorISO. */
export function dateInMonth(dateStr: string, anchorISO: string): boolean {
  if (!sanitizeHandoffField(dateStr)) return false;
  const a = new Date(`${anchorISO}T00:00:00`);
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getFullYear() === a.getFullYear() && d.getMonth() === a.getMonth();
}

/** A draft is "scheduled" once it has a concrete date — this is the single source
 *  of truth for calendar membership. `addedToPlanAt` only matters for date-less
 *  drafts ("added to plan but still needs a date"). */
export function hasScheduledDate(d: PinDraft): boolean {
  return !!sanitizeHandoffField(d.scheduledDate);
}

/** Scheduled (dated) drafts that land inside the given month. */
export function scheduledDraftsInMonth(category: string, monthAnchor: string): PinDraft[] {
  return draftsForCategory(category).filter(
    d => hasScheduledDate(d) && dateInMonth(d.scheduledDate, monthAnchor),
  );
}

/** Dated drafts whose date is OUTSIDE the given week (used to auto-open month view). */
export function scheduledDraftsOutsideWeek(category: string, weekStart: string): PinDraft[] {
  return draftsForCategory(category).filter(
    d => hasScheduledDate(d) && !dateInWeek(d.scheduledDate, weekStart),
  );
}

/** Drafts in a category, or ALL drafts when category is empty / ALL_CATEGORIES.
 *  This is the single partition point — every weekly-plan stat and calendar query
 *  flows through here, so "all categories" support lives in exactly one place. */
export function draftsForCategory(category: string): PinDraft[] {
  const all = pinDraftStore.getAllDrafts();
  if (!category || category === ALL_CATEGORIES) return all;
  return all.filter(d => d.category === category);
}

/** Added to plan but with NO date yet — these need a date assigned. A draft that
 *  already has a date (even in a different week/month) lives on the calendar, not here. */
export function getAddedNeedsDateDrafts(category: string, weekStart: string): PinDraft[] {
  void weekStart; // kept for signature stability; membership is date-presence based now
  return draftsForCategory(category).filter(
    d => pinDraftStore.isDraftAddedToWeeklyPlan(d) && !d.postedAt && !hasScheduledDate(d),
  );
}

export function addedNeedsDateLabel(): { label: string; color: string } {
  return { label: "In plan · assign date", color: "#D97706" };
}

export function computeWeeklyPlanStatsFromDrafts(drafts: PinDraft[], weekStart: string): WeeklyPlanStats {
  // Three mutually-exclusive buckets, driven by date presence:
  //   inWeek  → has a date inside this week (on the calendar)
  //   needsDate → added to plan but no date yet
  //   unscheduled → neither added nor dated (still in the generated tray)
  // The "unscheduled" bucket MUST match the Unscheduled Pins rail exactly (same
  // selector), so header count, month-view toggle, rail badge and rail list never
  // disagree. Added-but-dateless drafts live in the added-needs-date section, and
  // Studio-board drafts live on the Create Pins board — neither is "unscheduled".
  const inWeek      = drafts.filter(d => hasScheduledDate(d) && dateInWeek(d.scheduledDate, weekStart));
  const unscheduled = drafts.filter(d => pinDraftStore.isUnaddedGeneratedDraft(d));

  const published = inWeek.filter(d => !!d.postedAt).length;
  const scheduled = inWeek.length - published;

  return {
    scheduled,
    published,
    unscheduled:          unscheduled.length,
    plannedThisWeek:      scheduled,
    ready:                0,
    needsDetails:         0,
    unscheduledGenerated: unscheduled.length,
    posted:               published,
    // Global, not scoped to `drafts` (which may already be category-filtered) or to
    // `weekStart` — same source as the FailureBanner so the two never disagree.
    failed:               countPublishFailures(pinDraftStore.getAllDrafts()),
  };
}

/** Pins in the given week that are NOT yet ready to publish (missing required details). */
export function needsDetailsDraftsInWeek(category: string, weekStart: string): PinDraft[] {
  return scheduledDraftsInWeek(category, weekStart).filter(d => !d.postedAt && !isDraftReadyToPublish(d));
}

export function computeWeeklyPlanStats(category: string, weekStart: string): WeeklyPlanStats {
  return computeWeeklyPlanStatsFromDrafts(draftsForCategory(category), weekStart);
}

export function scheduledDraftsInWeek(category: string, weekStart: string): PinDraft[] {
  return draftsForCategory(category).filter(
    d => hasScheduledDate(d) && dateInWeek(d.scheduledDate, weekStart),
  );
}

export function unaddedStatusLabel(): { label: string; color: string } {
  return { label: "Not added to plan", color: "#64748B" };
}
