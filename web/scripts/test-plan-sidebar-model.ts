/**
 * test-plan-sidebar-model.ts — the pure model behind the Create Pins Plan sidebar
 * (PRD 0826 §23–§24).
 *
 * Run: npx tsx scripts/test-plan-sidebar-model.ts
 *
 * Fixture dates are written as LOCAL wall-clock strings with no trailing "Z". The
 * model groups by the leading "YYYY-MM-DD" of the stored string precisely so that a
 * Pin scheduled for Tuesday 09:00 stays on Tuesday no matter which timezone the CI
 * runner sits in; a "Z" here would have re-introduced the bug the model avoids.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BADGE_MAX,
  buildWeek,
  countWeekItems,
  countWeekScheduled,
  dateKey,
  formatBadge,
  isDateInWeek,
  itemProviders,
  itemState,
  nextBadgeCount,
  scheduledTime,
  startOfWeek,
  weekStartForDate,
} from "../src/lib/studio/planSidebarModel";
import type { PinDraft } from "../src/lib/pinDraftStore";

// The sidebar only ever reads a handful of fields; the cast keeps fixtures readable
// without restating the whole (large) PinDraft shape per case.
function draft(partial: Partial<PinDraft> & { id: string }): PinDraft {
  return { imageUrl: "", title: "", ...partial } as PinDraft;
}

/** Monday 2026-08-24 .. Sunday 2026-08-30. */
const MONDAY = new Date(2026, 7, 24);
const WEDNESDAY_NOON = new Date(2026, 7, 26, 12, 0, 0);

test("startOfWeek snaps to Monday from every day, including Sunday", () => {
  assert.equal(dateKey(startOfWeek(new Date(2026, 7, 24))), "2026-08-24", "Monday maps to itself");
  assert.equal(dateKey(startOfWeek(new Date(2026, 7, 26))), "2026-08-24", "Wednesday maps back");
  // Sunday is the trap: getDay() === 0 must go back 6 days, not forward.
  assert.equal(dateKey(startOfWeek(new Date(2026, 7, 30))), "2026-08-24", "Sunday belongs to the week it ends");
  assert.equal(dateKey(startOfWeek(new Date(2026, 7, 31))), "2026-08-31", "the next Monday starts a new week");
});

test("startOfWeek normalizes to local midnight", () => {
  const d = startOfWeek(new Date(2026, 7, 26, 23, 59, 59));
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test("buildWeek returns seven consecutive days and marks today", () => {
  const days = buildWeek([], MONDAY, WEDNESDAY_NOON);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map(d => d.key), [
    "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30",
  ]);
  assert.deepEqual(days.map(d => d.isToday), [false, false, true, false, false, false, false]);
});

test("buildWeek groups drafts onto their own day and drops undated ones", () => {
  const days = buildWeek([
    draft({ id: "mon", plannedAt: "2026-08-24T09:00", scheduledTime: "09:00" }),
    draft({ id: "wed", scheduledDate: "2026-08-26", scheduledTime: "14:30" }),
    draft({ id: "undated" }),
    // Outside the rendered week — present in the store, absent from this view.
    draft({ id: "next-week", plannedAt: "2026-09-02T10:00" }),
  ], MONDAY, WEDNESDAY_NOON);

  assert.deepEqual(days[0].items.map(i => i.id), ["mon"]);
  assert.deepEqual(days[2].items.map(i => i.id), ["wed"]);
  assert.equal(countWeekItems(days), 2, "the undated and next-week drafts are not in this week");
});

test("plannedAt wins over scheduledDate when both are present", () => {
  const days = buildWeek([
    draft({ id: "moved", plannedAt: "2026-08-27T08:00", scheduledDate: "2026-08-24" }),
  ], MONDAY, WEDNESDAY_NOON);
  assert.deepEqual(days[0].items.map(i => i.id), []);
  assert.deepEqual(days[3].items.map(i => i.id), ["moved"]);
});

test("scheduledTime falls back through plannedAt's clock part", () => {
  assert.equal(scheduledTime(draft({ id: "a", scheduledTime: "16:45", plannedAt: "2026-08-24T09:00" })), "16:45");
  assert.equal(scheduledTime(draft({ id: "b", plannedAt: "2026-08-24T07:15" })), "07:15");
  assert.equal(scheduledTime(draft({ id: "c" })), "09:00", "a dateless draft still labels sanely");
});

// ── §23.2 future first ────────────────────────────────────────────────────────
test("within a day, upcoming items sort above posted history", () => {
  const days = buildWeek([
    // Posted at 08:00 — earlier in the day, but already done.
    draft({ id: "done-early", plannedAt: "2026-08-26T08:00", scheduledTime: "08:00", postedAt: "2026-08-26T08:01" }),
    draft({ id: "later", plannedAt: "2026-08-26T18:00", scheduledTime: "18:00" }),
    draft({ id: "soon", plannedAt: "2026-08-26T13:00", scheduledTime: "13:00" }),
    draft({ id: "done-late", plannedAt: "2026-08-26T20:00", scheduledTime: "20:00", postedAt: "2026-08-26T20:02" }),
  ], MONDAY, WEDNESDAY_NOON);

  assert.deepEqual(
    days[2].items.map(i => i.id),
    ["soon", "later", "done-early", "done-late"],
    "both scheduled items come first, then posted history, each block by time",
  );
});

test("a failed item stays in the upcoming block, not buried with history", () => {
  const days = buildWeek([
    draft({ id: "posted", plannedAt: "2026-08-26T07:00", scheduledTime: "07:00", postedAt: "2026-08-26T07:01" }),
    draft({ id: "failed", plannedAt: "2026-08-26T09:00", scheduledTime: "09:00", failureType: "publish", publishError: "board unavailable" }),
  ], MONDAY, WEDNESDAY_NOON);
  assert.deepEqual(days[2].items.map(i => i.id), ["failed", "posted"]);
});

test("ties on time break on id so ordering is stable across renders", () => {
  const days = buildWeek([
    draft({ id: "b", plannedAt: "2026-08-25T10:00", scheduledTime: "10:00" }),
    draft({ id: "a", plannedAt: "2026-08-25T10:00", scheduledTime: "10:00" }),
  ], MONDAY, WEDNESDAY_NOON);
  assert.deepEqual(days[1].items.map(i => i.id), ["a", "b"]);
});

// ── §23.1 state classification ────────────────────────────────────────────────
test("state classification: scheduled / posted / failed", () => {
  assert.equal(itemState(draft({ id: "s", plannedAt: "2026-08-26T09:00" })), "scheduled");
  assert.equal(itemState(draft({ id: "p", postedAt: "2026-08-26T09:01" })), "posted");
  assert.equal(itemState(draft({ id: "p2", remotePinId: "pin_123" })), "posted");
  assert.equal(itemState(draft({ id: "f", publishError: "token expired" })), "failed");
});

test("a partial fan-out success counts as posted, never failed", () => {
  // Pinterest published, Instagram failed. The card badge calls this Posted (the Pin
  // IS live somewhere), and the sidebar must agree or the two views contradict.
  const partial = draft({
    id: "partial",
    plannedAt: "2026-08-26T09:00",
    destinationResults: [
      { destinationId: "partial:pinterest", provider: "pinterest", status: "published", publishedAt: "2026-08-26T09:01" },
      { destinationId: "partial:instagram", provider: "instagram", status: "failed", errorMessage: "media rejected" },
    ],
  });
  assert.equal(itemState(partial), "posted");
});

test("an all-destinations-failed content is failed", () => {
  const failed = draft({
    id: "allfail",
    plannedAt: "2026-08-26T09:00",
    publishError: "rate limited",
    destinationResults: [
      { destinationId: "allfail:pinterest", provider: "pinterest", status: "failed", errorMessage: "rate limited" },
    ],
  });
  assert.equal(itemState(failed), "failed");
});

test("a still-generating dated draft reads as scheduled, not dropped", () => {
  const days = buildWeek([
    draft({ id: "gen", plannedAt: "2026-08-25T11:00", scheduledTime: "11:00", generationStatus: "generating" }),
  ], MONDAY, WEDNESDAY_NOON);
  assert.equal(days[1].items.length, 1, "it holds its calendar slot while it renders");
  assert.equal(days[1].items[0].state, "scheduled");
});

// ── providers ─────────────────────────────────────────────────────────────────
test("providers come from explicit destinations, deduped and ordered", () => {
  const multi = draft({
    id: "multi",
    publishDestinations: [
      { id: "d1", provider: "pinterest", boardId: "b1" },
      { id: "d2", provider: "instagram", accountId: "ig1" },
      { id: "d3", provider: "instagram", accountId: "ig2" },
      { id: "d4", provider: "facebook", pageId: "p1" },
    ],
  });
  assert.deepEqual(itemProviders(multi), ["pinterest", "instagram", "facebook"],
    "two Instagram accounts are one Instagram icon");
});

test("providers fall back to pinterest for a legacy board-only draft", () => {
  assert.deepEqual(itemProviders(draft({ id: "legacy", boardId: "board_1" })), ["pinterest"]);
});

test("providers are empty when there is no destination signal at all", () => {
  assert.deepEqual(itemProviders(draft({ id: "bare" })), []);
});

test("cover prefers the Content's first media over the legacy image", () => {
  const withMedia = draft({
    id: "m",
    plannedAt: "2026-08-25T09:00",
    imageUrl: "https://cdn/legacy.jpg",
    media: [
      { id: "m0", kind: "image", url: "https://cdn/first.jpg" },
      { id: "m1", kind: "image", url: "https://cdn/second.jpg" },
    ],
  });
  const days = buildWeek([withMedia], MONDAY, WEDNESDAY_NOON);
  assert.equal(days[1].items[0].cover, "https://cdn/first.jpg");

  const legacy = buildWeek([draft({ id: "l", plannedAt: "2026-08-25T09:00", imageUrl: "https://cdn/legacy.jpg" })], MONDAY, WEDNESDAY_NOON);
  assert.equal(legacy[1].items[0].cover, "https://cdn/legacy.jpg");
});

// ── header counts ─────────────────────────────────────────────────────────────
test("the header counts the schedule, not the history", () => {
  const days = buildWeek([
    draft({ id: "s1", plannedAt: "2026-08-24T09:00" }),
    draft({ id: "s2", plannedAt: "2026-08-27T09:00" }),
    draft({ id: "f1", plannedAt: "2026-08-28T09:00", publishError: "nope" }),
    draft({ id: "p1", plannedAt: "2026-08-25T09:00", postedAt: "2026-08-25T09:01" }),
  ], MONDAY, WEDNESDAY_NOON);
  assert.equal(countWeekItems(days), 4);
  assert.equal(countWeekScheduled(days), 3, "posted history is excluded; failed still needs action");
});

// ── §24 badge ─────────────────────────────────────────────────────────────────
test("badge counting: single, batch, and clear-on-open", () => {
  let badge = 0;
  badge = nextBadgeCount(badge, 1);
  assert.equal(badge, 1, "one schedule → +1");
  badge = nextBadgeCount(badge, 1);
  assert.equal(badge, 2, "a second while still closed → +2");
  badge = nextBadgeCount(badge, 5);
  assert.equal(badge, 7, "a batch of 5 increments by 5, not by 1");
  // Opening the panel is what clears it — the caller resets to 0.
  badge = 0;
  assert.equal(formatBadge(badge), "", "nothing renders once seen");
});

test("badge ignores zero / negative / non-finite increments", () => {
  assert.equal(nextBadgeCount(3, 0), 3, "a schedule that failed adds nothing");
  assert.equal(nextBadgeCount(3, -2), 3);
  assert.equal(nextBadgeCount(3, Number.NaN), 3);
});

test("badge formatting caps instead of overflowing the trigger", () => {
  assert.equal(formatBadge(1), "+1");
  assert.equal(formatBadge(12), "+12");
  assert.equal(formatBadge(BADGE_MAX), `+${BADGE_MAX}`);
  assert.equal(formatBadge(BADGE_MAX + 1), `+${BADGE_MAX}+`);
});

// ── §24 week jump ─────────────────────────────────────────────────────────────
test("weekStartForDate finds the week that reveals a just-scheduled date", () => {
  assert.equal(dateKey(weekStartForDate("2026-08-30")!), "2026-08-24", "a Sunday reveals its own week");
  assert.equal(dateKey(weekStartForDate("2026-09-02T10:00")!), "2026-08-31");
  assert.equal(weekStartForDate(""), null);
  assert.equal(weekStartForDate("not-a-date"), null);
});

test("isDateInWeek decides whether the panel has to jump at all", () => {
  assert.equal(isDateInWeek("2026-08-26", MONDAY), true);
  assert.equal(isDateInWeek("2026-08-30", MONDAY), true, "Sunday is the last day of this week");
  assert.equal(isDateInWeek("2026-08-31", MONDAY), false);
  assert.equal(isDateInWeek("2026-08-23", MONDAY), false);
});
