/**
 * Canonical PinDraft → calendar event mapping. BOTH Weekly View and Monthly View
 * consume this single shape so the same Pin always renders the same plannedTime.
 * The planned time is read from stored data only (scheduledTime, then plannedAt) —
 * never invented or fabricated in the UI.
 */

import type { PinDraft } from "./pinDraftStore";
import { sanitizeHandoffField, splitLocalPlannedAt, displayTitle } from "./weeklyPlanHandoff";
import { draftReadiness } from "./weeklyPlanStats";
import { getPinReadiness, type PinDetailsStatus, type PinPlanStatus } from "./pinReadiness";

export type PlanCalendarEvent = {
  draftId:        string;
  pinId?:         string;
  imageUrl:       string;
  title:          string;
  plannedDate:    string;       // YYYY-MM-DD
  plannedTime:    string;       // HH:mm (24h), "" only if truly unscheduled
  plannedAt:      string;       // YYYY-MM-DDTHH:mm (canonical, local)
  detailsStatus:  PinDetailsStatus;
  planStatus:     PinPlanStatus;
  boardName:      string;
  destinationUrl: string;
};

/** Map a draft to the canonical calendar event used by week + month renderers. */
export function mapPlanDraftToCalendarEvent(draft: PinDraft): PlanCalendarEvent {
  const plannedDate = sanitizeHandoffField(draft.scheduledDate);
  const split = splitLocalPlannedAt(draft.plannedAt);
  // Stored time wins; fall back only to the time already persisted inside plannedAt.
  const plannedTime = sanitizeHandoffField(draft.scheduledTime) || split.time;
  const plannedAt = sanitizeHandoffField(draft.plannedAt)
    || (plannedDate ? `${plannedDate}T${plannedTime || "00:00"}` : "");
  const readiness = getPinReadiness({
    ...draftReadiness(draft),
    plannedDate,
    plannedAt,
    postedAt: draft.postedAt,
  });
  return {
    draftId:        draft.id,
    pinId:          draft.pinId,
    imageUrl:       draft.imageUrl,
    title:          displayTitle(draft.title, draft.keyword),
    plannedDate,
    plannedTime,
    plannedAt,
    detailsStatus:  readiness.detailsStatus,
    planStatus:     readiness.planStatus,
    boardName:      sanitizeHandoffField(draft.boardName) || sanitizeHandoffField(draft.metadataDraft?.boardName),
    destinationUrl: sanitizeHandoffField(draft.destinationUrl),
  };
}

/** A sortable key — plannedAt if present, else date+time — for ascending order. */
export function eventSortKey(ev: PlanCalendarEvent): string {
  if (ev.plannedAt) return ev.plannedAt;
  return `${ev.plannedDate}T${ev.plannedTime || "99:99"}`;
}

/** Sort drafts into ascending publish order via the canonical event mapping. */
export function draftsToSortedEvents(drafts: PinDraft[]): PlanCalendarEvent[] {
  return drafts
    .map(mapPlanDraftToCalendarEvent)
    .sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
}
