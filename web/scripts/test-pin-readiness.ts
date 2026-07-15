import assert from "node:assert/strict";
import { getPinReadiness } from "../src/lib/pinReadiness";
import { readFileSync } from "node:fs";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const fullDetails = {
  imageUrl: "https://cdn.example.com/pin.jpg",
  title: "Pin title",
  description: "Pin description",
  altText: "Pin alt text",
  destinationUrl: "https://example.com/product",
  boardId: "real-board-id",
};

// A. Not planned
test("A: not_planned when no addedToPlanAt, no plannedDate, no plannedAt", () => {
  const result = getPinReadiness(fullDetails);
  assert.equal(result.planStatus, "not_planned");
  assert.equal(result.detailsStatus, "ready");
});

// B. Needs date — via addedToPlanAt
test("B: needs_date when addedToPlanAt set but no date/time", () => {
  const result = getPinReadiness({ ...fullDetails, addedToPlanAt: "2026-06-01T10:00:00Z" });
  assert.equal(result.planStatus, "needs_date");
  assert.equal(result.detailsStatus, "ready");
});

// B2. Needs date — via planningStatus = "added_to_plan"
test("B2: needs_date when planningStatus=added_to_plan but no date", () => {
  const result = getPinReadiness({ ...fullDetails, planningStatus: "added_to_plan" });
  assert.equal(result.planStatus, "needs_date");
});

// C. Scheduled with plannedDate
test("C: scheduled when plannedDate is set", () => {
  const result = getPinReadiness({ ...fullDetails, plannedDate: "2026-07-01" });
  assert.equal(result.planStatus, "scheduled");
});

// D. Scheduled with plannedAt
test("D: scheduled when plannedAt is set", () => {
  const result = getPinReadiness({ ...fullDetails, plannedAt: "2026-07-01T09:00" });
  assert.equal(result.planStatus, "scheduled");
});

// E. Posted
test("E: posted when postedAt is set", () => {
  const result = getPinReadiness({ ...fullDetails, postedAt: "2026-06-20T12:00:00Z" });
  assert.equal(result.planStatus, "posted");
});

test("E2: posted when planningStatus=posted", () => {
  const result = getPinReadiness({ ...fullDetails, planningStatus: "posted" });
  assert.equal(result.planStatus, "posted");
});

// posted wins over scheduled
test("E3: posted wins over scheduled date", () => {
  const result = getPinReadiness({ ...fullDetails, plannedDate: "2026-07-01", postedAt: "2026-06-20T12:00:00Z" });
  assert.equal(result.planStatus, "posted");
});

// F. Copy and accessibility metadata are recommendations, not publish blockers.
test("F: missing title, description and alt text stays ready", () => {
  const result = getPinReadiness({ ...fullDetails, title: "", description: "", altText: "", plannedDate: "2026-07-01" });
  assert.equal(result.detailsStatus, "ready");
  assert.equal(result.planStatus, "scheduled");
  assert.deepEqual(result.missingFields, []);
});

test("F2: missing image blocks publishing without changing plan status", () => {
  const result = getPinReadiness({ ...fullDetails, imageUrl: "", plannedDate: "2026-07-01" });
  assert.equal(result.detailsStatus, "need_details");
  assert.equal(result.planStatus, "scheduled");
  assert.deepEqual(result.missingFields, ["image"]);
});

test("F3: missing board blocks publishing without changing plan status", () => {
  const result = getPinReadiness({ ...fullDetails, boardId: "", plannedDate: "2026-07-01" });
  assert.equal(result.detailsStatus, "need_details");
  assert.equal(result.planStatus, "scheduled");
  assert.deepEqual(result.missingFields, ["board"]);
});

// G. Ready but needs date
test("G: ready details but needs_date planStatus", () => {
  const result = getPinReadiness({ ...fullDetails, addedToPlanAt: "2026-06-01T10:00:00Z" });
  assert.equal(result.detailsStatus, "ready");
  assert.equal(result.planStatus, "needs_date");
});

// scheduled wins over needs_date (date takes priority)
test("scheduled wins over addedToPlanAt when date is also present", () => {
  const result = getPinReadiness({ ...fullDetails, addedToPlanAt: "2026-06-01T10:00:00Z", plannedDate: "2026-07-01" });
  assert.equal(result.planStatus, "scheduled");
});

// Source-file structural checks
const batchSource = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
const studioSource = readFileSync("src/app/app/studio/page.tsx", "utf8");
const planSource = readFileSync("src/app/app/plan/page.tsx", "utf8");
const readinessSource = readFileSync("src/lib/pinReadiness.ts", "utf8");

test("pinReadiness.ts exports PinPlanStatus with needs_date", () => {
  assert.match(readinessSource, /needs_date/);
  assert.match(readinessSource, /addedToPlanAt/);
});

test("BatchEditDrawer Plan column derives from canonical planning fields", () => {
  assert.match(batchSource, /function planLabel/);
  assert.match(batchSource, /pin\.postedAt \|\| ps === "posted"/);
  assert.match(batchSource, /plannedAt \|\| date/);
});

test("BatchEditDrawer never renders a Needs date state", () => {
  assert.doesNotMatch(batchSource, /Needs date/);
});

test("BatchEditDrawer Plan filter uses the four plan labels", () => {
  assert.match(batchSource, /value="Not planned"/);
  assert.match(batchSource, /value="Planned"/);
  assert.match(batchSource, /value="Posted"/);
  assert.match(batchSource, /value="Failed"/);
});

test("BatchEditDrawer Plan column is plain text (no count dashboard)", () => {
  assert.match(batchSource, /batch-edit-plan-cell/);
  assert.doesNotMatch(batchSource, /sumNeedsDate/);
});

test("studio/page.tsx batch row derives addedToPlanAt from planningStatus", () => {
  assert.match(studioSource, /addedToPlanAt: pin\.planningStatus !== "not_added" \? "added" : undefined/);
});

test("plan/page.tsx batch row includes addedToPlanAt", () => {
  assert.match(planSource, /addedToPlanAt: d\.addedToPlanAt/);
});

test("Publish date & time bulk applies one date/time to all selected", () => {
  assert.match(batchSource, /function applyBulkSchedule/);
});

console.log(`\nPin readiness: ${passed} passed, 0 failed`);
