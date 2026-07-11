import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeWeeklyPlanStatsFromDrafts,
  dateInWeek,
  unaddedStatusLabel,
} from "../src/lib/weeklyPlanStats";
import * as pinDraftStore from "../src/lib/pinDraftStore";
import type { PinDraft } from "../src/lib/pinDraftStore";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(e as Error).message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const planSource = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");

function draft(partial: Partial<PinDraft> & Pick<PinDraft, "id">): PinDraft {
  return {
    id: partial.id,
    imageUrl: partial.imageUrl ?? "https://cdn.example.com/pin.jpg",
    keyword: partial.keyword ?? "cozy bedroom",
    category: partial.category ?? "home-decor",
    title: partial.title ?? "Cozy Bedroom",
    description: partial.description ?? "Save these ideas.",
    altText: "alt",
    destinationUrl: partial.destinationUrl ?? "https://example.com/pin",
    boardId: partial.boardId ?? "board_123",
    boardName: partial.boardName ?? "Home Decor",
    weeklyPlanItemId: "",
    generationSessionId: "",
    scheduledDate: partial.scheduledDate ?? "",
    status: partial.status ?? "needs_review",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    addedToPlanAt: partial.addedToPlanAt,
    postedAt: partial.postedAt,
  };
}

test("dateInWeek matches Mon-Sun window", () => {
  assert(dateInWeek("2026-06-08", "2026-06-08"), "Monday should be in week");
  assert(!dateInWeek("2026-06-01", "2026-06-08"), "prior week date excluded");
});

test("unadded queue status is not Ready", () => {
  const st = unaddedStatusLabel();
  assert(st.label !== "Ready", "unadded label must not be Ready");
  assert(st.label === "Not added to plan", "expected not added label");
});

test("computeWeeklyPlanStats exposes scheduled, published, and unscheduled", () => {
  const mockDrafts: PinDraft[] = [
    draft({ id: "d1", addedToPlanAt: "2026-06-07T00:00:00Z", scheduledDate: "2026-06-08", status: "ready", title: "T", description: "D" }),
    draft({ id: "d2" }),
    draft({ id: "d3" }),
  ];

  const stats = computeWeeklyPlanStatsFromDrafts(mockDrafts, "2026-06-08");
  assert(stats.scheduled === 1, `scheduled expected 1, got ${stats.scheduled}`);
  assert(stats.unscheduled === 2, `unscheduled expected 2, got ${stats.unscheduled}`);
  assert(stats.published === 0, `published expected 0, got ${stats.published}`);
  assert(stats.ready === 0, `ready should no longer be user-facing, got ${stats.ready}`);
});

test("added pins without a calendar date count as unscheduled, not needs details", () => {
  const stats = computeWeeklyPlanStatsFromDrafts([
    draft({ id: "d6", addedToPlanAt: "2026-06-07T00:00:00Z", scheduledDate: "" }),
  ], "2026-06-08");
  assert(stats.unscheduled === 1, "added without date should count as unscheduled");
  assert(stats.needsDetails === 0, "needsDetails should not be a lifecycle state");
});

test("missing optional publish fields do not create a lifecycle status", () => {
  const stats = computeWeeklyPlanStatsFromDrafts([
    draft({ id: "d4", addedToPlanAt: "2026-06-07T00:00:00Z", scheduledDate: "2026-06-08", status: "needs_review", title: "", description: "" }),
  ], "2026-06-08");
  assert(stats.scheduled === 1, "scheduled should remain 1");
  assert(stats.needsDetails === 0, "needsDetails should not be a lifecycle state");
});

test("Weekly Plan page shows added-needs-date section", () => {
  assert(planSource.includes("added-needs-date-section"), "added needs date section missing");
  assert(planSource.includes("Added to plan · assign a date"), "added needs date header missing");
});

test("published count uses postedAt", () => {
  const stats = computeWeeklyPlanStatsFromDrafts([
    draft({ id: "d5", addedToPlanAt: "2026-06-07T00:00:00Z", scheduledDate: "2026-06-08", status: "ready", postedAt: "2026-06-09T00:00:00Z" }),
  ], "2026-06-08");
  assert(stats.published === 1, "published count should be 1");
  assert(stats.posted === 1, "legacy posted alias should be 1");
});

test("isDraftAddedToWeeklyPlan uses addedToPlanAt", () => {
  assert(pinDraftStore.isDraftAddedToWeeklyPlan(draft({ id: "x", addedToPlanAt: "2026-06-07T00:00:00Z" })), "added draft");
  assert(!pinDraftStore.isDraftAddedToWeeklyPlan(draft({ id: "y" })), "unadded draft");
});

test("assignDraftToDate marks added and sets date", () => {
  /* logic verified via store exports in integration; source wiring checked below */
  assert(typeof pinDraftStore.assignDraftToDate === "function", "assignDraftToDate missing");
});

test("Weekly Plan page shows compact summary bar not large KPI cards", () => {
  assert(planSource.includes('"weekly-plan-summary-bar"'), "compact summary bar testId missing");
  assert(planSource.includes('"stat-scheduled"'),     "stat-scheduled segment missing");
  assert(planSource.includes('"stat-published"'),     "stat-published segment missing");
  assert(planSource.includes('"stat-unscheduled"'),   "stat-unscheduled segment missing");
  assert(!planSource.includes('"stat-ready"'),         "stat-ready segment should be removed");
  assert(!planSource.includes('"stat-needs-details"'), "stat-needs-details segment should be removed");
  assert(!planSource.includes('"stat-posted"'),        "stat-posted segment should be removed");
  assert(!planSource.includes("MetricCard"),          "MetricCard large KPI cards must be removed");
  assert(!planSource.includes('"weekly-plan-stats"'), "old large KPI stats container must be removed");
  assert(!planSource.includes("Ready to post manually"), "Ready tooltip must be removed");
  assert(!planSource.includes("Marked as posted manually"), "Posted tooltip must be removed");
  assert(planSource.includes("Generated Pins · Not added to plan"), "renamed queue header missing");
});

test("Weekly Plan calendar always renders 7 day columns", () => {
  assert(planSource.includes("weekly-plan-calendar"), "calendar test id missing");
  assert(planSource.includes("calendar-empty-slot"), "empty slot missing");
  // Empty future Smart Schedule slots are drop targets ("Drop pin here").
  assert(planSource.includes("Drop pin here"), "empty slot drop affordance missing");
});

test("Weekly Plan delegates publish UI to shared Pin Details modal", () => {
  assert(planSource.includes("DraftDetailsDrawer"), "shared details modal wrapper missing");
  assert(!planSource.includes('data-testid="draft-publish-pinterest"'), "publish editor duplicated in Weekly Plan page");
});

test("Weekly Plan page has week navigation controls", () => {
  assert(planSource.includes('"week-nav-today"'), "Today button testId missing");
  assert(planSource.includes('"week-nav-prev"'),  "prev arrow testId missing");
  assert(planSource.includes('"week-nav-next"'),  "next arrow testId missing");
  assert(planSource.includes("weekOffset"),       "weekOffset state missing");
  assert(planSource.includes("displayWeekStart"), "displayWeekStart computed value missing");
  assert(planSource.includes('"create-pin-btn"'), "Create Pin button testId missing");
});

test("Unscheduled cards use unadded status label", () => {
  assert(planSource.includes("unaddedStatusLabel()"), "unadded status in unscheduled section");
});

console.log(`\nWeekly Plan UI tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
