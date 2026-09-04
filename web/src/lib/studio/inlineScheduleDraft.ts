import { combineLocalPlannedAt } from "@/lib/weeklyPlanHandoff";

export type InlineScheduleDraft = {
  date: string;
  time: string;
};

export type InlineSchedulePatch = {
  plannedDate: string;
  plannedTime: string;
  plannedAt: string;
};

export function openInlineScheduleDraft(date: string | undefined, time: string | undefined): InlineScheduleDraft {
  return { date: date?.trim() ?? "", time: time?.trim() ?? "" };
}

export function updateInlineScheduleDraft(
  draft: InlineScheduleDraft,
  patch: Partial<InlineScheduleDraft>,
): InlineScheduleDraft {
  return {
    date: patch.date ?? draft.date,
    time: patch.time ?? draft.time,
  };
}

export function saveInlineScheduleDraft(draft: InlineScheduleDraft): InlineSchedulePatch {
  return {
    plannedDate: draft.date,
    plannedTime: draft.time,
    plannedAt: combineLocalPlannedAt(draft.date, draft.time),
  };
}

export function clearInlineScheduleDraft(): InlineSchedulePatch {
  return { plannedDate: "", plannedTime: "", plannedAt: "" };
}
