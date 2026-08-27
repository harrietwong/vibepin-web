/**
 * planSidebarModel.ts — pure model behind the Create Pins right-side Plan sidebar
 * (PRD 0826 §23–§24).
 *
 * Everything the sidebar needs to render a week — grouping by day, ordering inside a
 * day, the three visual states, the cover image, the destination provider icons and
 * the "+N since you last looked" badge — lives here so it is unit-testable without
 * React, a DOM or a clock.
 *
 * Two deliberate design choices:
 *
 *  • Dates stay STRINGS (`raw.slice(0, 10)`), never `new Date(...)` round-trips. The
 *    persisted draft carries a local wall-clock date/time; parsing it into a Date and
 *    back re-interprets it through the runner's timezone, which made grouping flaky.
 *    `startOfWeek`/`dateKey` do use Date, but only for calendar arithmetic on a date
 *    the caller already normalized to local midnight.
 *
 *  • State comes from getPinLifecycle(), not from re-reading postedAt/publishError.
 *    That helper already resolves the awkward cases in one place — most importantly a
 *    partial fan-out success (Pinterest published, Instagram failed) is "posted", not
 *    "failed", because it checks posted BEFORE failed. Re-deriving here would silently
 *    disagree with the card badges on exactly those drafts.
 */

import type { PinDraft } from "@/lib/pinDraftStore";
import { sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";
import { contentDestinations, contentMedia, type PublishProvider } from "@/lib/contentDraftModel";
import { getPinLifecycle } from "@/lib/studio/pinLifecycle";

/** The three visual states the sidebar distinguishes (PRD §23). */
export type PlanItemState = "scheduled" | "posted" | "failed";

export interface PlanSidebarItem {
  id: string;
  /** Local wall-clock "HH:MM" used both for the label and for intra-day ordering. */
  time: string;
  /** Cover image URL, or "" when the draft has no usable media yet. */
  cover: string;
  /** Unique destination providers, in a stable order, for the small platform icons. */
  providers: PublishProvider[];
  state: PlanItemState;
  title: string;
}

export interface PlanSidebarDay {
  /** "YYYY-MM-DD" local date key. */
  key: string;
  date: Date;
  isToday: boolean;
  items: PlanSidebarItem[];
}

/** Monday-start week containing `input`, at local midnight. */
export function startOfWeek(input: Date): Date {
  const d = new Date(input);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d;
}

/** Local "YYYY-MM-DD" (never toISOString(), which would shift across the UTC boundary). */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The day a draft belongs to, or "" when it carries no date at all. */
export function scheduledKey(draft: Pick<PinDraft, "plannedAt" | "scheduledDate">): string {
  const raw = sanitizeHandoffField(draft.plannedAt) || sanitizeHandoffField(draft.scheduledDate);
  return raw.slice(0, 10);
}

/** The time label, falling back through plannedAt's clock part to a sane default. */
export function scheduledTime(draft: Pick<PinDraft, "scheduledTime" | "plannedAt">): string {
  return sanitizeHandoffField(draft.scheduledTime)
    || sanitizeHandoffField(draft.plannedAt).slice(11, 16)
    || "09:00";
}

/**
 * Collapse the lifecycle to the sidebar's three states.
 *
 * "generating" and "unscheduled" cannot reach the sidebar with a date and mean
 * anything else useful there, so they read as "scheduled": the item IS on the
 * calendar for that slot, whatever its generation progress.
 */
export function itemState(draft: PinDraft): PlanItemState {
  const lifecycle = getPinLifecycle(draft);
  if (lifecycle === "posted") return "posted";
  if (lifecycle === "failed") return "failed";
  return "scheduled";
}

/**
 * Unique providers for the platform icons.
 *
 * The fallback lives HERE rather than leaning on contentDestinations()' own legacy
 * synthesis: that helper is being reworked concurrently and only its name and
 * `{provider}[]` return shape are contracted. A legacy single-Pin draft with a board
 * but no explicit destinations is a Pinterest post, and the sidebar says so itself.
 */
export function itemProviders(draft: PinDraft): PublishProvider[] {
  const seen = new Set<PublishProvider>();
  const out: PublishProvider[] = [];
  for (const destination of contentDestinations(draft)) {
    const provider = destination?.provider;
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    out.push(provider);
  }
  if (!out.length && sanitizeHandoffField(draft.boardId)) return ["pinterest"];
  return out;
}

/** Cover = the Content's first media, falling back to the legacy single image. */
export function itemCover(draft: PinDraft): string {
  return contentMedia(draft)[0]?.url ?? draft.imageUrl ?? "";
}

export function toItem(draft: PinDraft): PlanSidebarItem {
  return {
    id: draft.id,
    time: scheduledTime(draft),
    cover: itemCover(draft),
    providers: itemProviders(draft),
    state: itemState(draft),
    title: sanitizeHandoffField(draft.title),
  };
}

/**
 * Future first (PRD §23.2): inside one day, everything still upcoming sorts above the
 * posted history, so a busy Tuesday of already-published Pins never buries the two
 * that still have to go out. Ordering keys off `state`, not off a comparison with the
 * wall clock — the state already encodes "this has happened", and keeping `now` out of
 * the comparator makes the ordering deterministic in tests and stable between renders.
 */
function orderRank(item: PlanSidebarItem): number {
  return item.state === "posted" ? 1 : 0;
}

function compareItems(a: PlanSidebarItem, b: PlanSidebarItem): number {
  const rank = orderRank(a) - orderRank(b);
  if (rank !== 0) return rank;
  const time = a.time.localeCompare(b.time);
  if (time !== 0) return time;
  return a.id.localeCompare(b.id);
}

/**
 * Build the seven days of the week starting at `weekStart` (assumed a Monday at local
 * midnight — pass startOfWeek()'s output). `now` only decides which day is "today";
 * it never filters, because a past day's posted items are still worth seeing.
 */
export function buildWeek(drafts: PinDraft[], weekStart: Date, now: Date = new Date()): PlanSidebarDay[] {
  const byDay = new Map<string, PlanSidebarItem[]>();
  for (const draft of drafts) {
    if (!draft?.id) continue;
    const key = scheduledKey(draft);
    if (!key) continue;
    const list = byDay.get(key);
    if (list) list.push(toItem(draft));
    else byDay.set(key, [toItem(draft)]);
  }
  byDay.forEach(list => list.sort(compareItems));

  const todayKey = dateKey(now);
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + i);
    const key = dateKey(date);
    return { key, date, isToday: key === todayKey, items: byDay.get(key) ?? [] };
  });
}

/** Items across the whole week — drives the "{n} scheduled this week" header count. */
export function countWeekItems(days: PlanSidebarDay[]): number {
  return days.reduce((total, day) => total + day.items.length, 0);
}

/** Only the still-upcoming ones (the header counts the schedule, not the history). */
export function countWeekScheduled(days: PlanSidebarDay[]): number {
  return days.reduce((total, day) => total + day.items.filter(item => item.state !== "posted").length, 0);
}

/**
 * The trigger badge (PRD §24): when a schedule succeeds while the panel is CLOSED and
 * unpinned, the sidebar must not steal focus by opening itself — it just counts what
 * the user hasn't seen, and clears on the next open.
 *
 * Kept as a pure reducer so the "batch of N increments by N" and "open clears" rules
 * are testable without rendering anything.
 */
export function nextBadgeCount(current: number, scheduledCount: number): number {
  if (!Number.isFinite(scheduledCount) || scheduledCount <= 0) return current;
  return current + Math.floor(scheduledCount);
}

/** Cap the rendered badge so a long unattended batch cannot blow up the trigger. */
export const BADGE_MAX = 99;

export function formatBadge(count: number): string {
  if (count <= 0) return "";
  return count > BADGE_MAX ? `+${BADGE_MAX}+` : `+${count}`;
}

/** The week that should be shown to reveal `dateStr` ("YYYY-MM-DD"), or null if unparseable. */
export function weekStartForDate(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return null;
  return startOfWeek(date);
}

/** True when `weekStart`'s week already contains `dateStr` (so no jump is needed). */
export function isDateInWeek(dateStr: string, weekStart: Date): boolean {
  const target = weekStartForDate(dateStr);
  return !!target && dateKey(target) === dateKey(startOfWeek(weekStart));
}
