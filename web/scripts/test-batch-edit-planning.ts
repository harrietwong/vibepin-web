import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPinReadiness } from "../src/lib/pinReadiness";
import { combineLocalPlannedAt, splitLocalPlannedAt } from "../src/lib/weeklyPlanHandoff";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const readyInput = {
  imageUrl: "https://cdn.example.com/pin.jpg",
  title: "Pin title",
  description: "Pin description",
  altText: "Pin alt text",
  destinationUrl: "https://example.com/product",
  boardId: "real-board-id",
};

test("getPinReadiness returns separate details and plan statuses", () => {
  assert.deepEqual(getPinReadiness(readyInput), { detailsStatus: "ready", planStatus: "not_planned", missingFields: [] });
});

test("missing description alone does not block readiness or change scheduled plan status", () => {
  const result = getPinReadiness({ ...readyInput, description: "", plannedDate: "2026-06-24" });
  assert.equal(result.detailsStatus, "ready");
  assert.equal(result.planStatus, "scheduled");
  assert.deepEqual(result.missingFields, []);
});

test("missing board (the one content field that still blocks) does not change scheduled plan status", () => {
  const result = getPinReadiness({ ...readyInput, boardId: "", plannedDate: "2026-06-24" });
  assert.equal(result.detailsStatus, "need_details");
  assert.equal(result.planStatus, "scheduled");
  assert.deepEqual(result.missingFields, ["board"]);
});

test("posted status wins over a scheduled date", () => {
  assert.equal(getPinReadiness({ ...readyInput, plannedDate: "2026-06-24", postedAt: "2026-06-24T11:00:00Z" }).planStatus, "posted");
});

test("addedToPlanAt without a date gives needs_date not not_planned", () => {
  assert.equal(getPinReadiness({ ...readyInput, addedToPlanAt: "2026-06-23T10:00:00Z" }).planStatus, "needs_date");
});

test("scheduled wins over needs_date when plannedDate is also set", () => {
  assert.equal(getPinReadiness({ ...readyInput, addedToPlanAt: "2026-06-23T10:00:00Z", plannedDate: "2026-07-01" }).planStatus, "scheduled");
});

test("planned date and time compose without a UTC conversion", () => {
  assert.equal(combineLocalPlannedAt("2026-06-24", "11:30"), "2026-06-24T11:30");
});

test("date-only records remain valid", () => {
  assert.equal(combineLocalPlannedAt("2026-06-24", ""), "2026-06-24T00:00");
  assert.deepEqual(splitLocalPlannedAt("2026-06-24T00:00"), { date: "2026-06-24", time: "00:00" });
});

test("clearing planned time preserves the local date", () => {
  assert.equal(combineLocalPlannedAt("2026-06-24", ""), "2026-06-24T00:00");
});

test("clearing date removes plannedAt", () => {
  assert.equal(combineLocalPlannedAt("", "11:30"), "");
});

const batchSource = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
const studioSource = readFileSync("src/app/app/studio/page.tsx", "utf8");
const planSource = readFileSync("src/app/app/plan/page.tsx", "utf8");

test("Batch Edit autosaves via onApply — no Preview/Apply/global Save step", () => {
  assert.match(batchSource, /rowEdits: Record<string, RowEdit>/);
  assert.match(batchSource, /plannedTime\?:\s+string/);
  // Hybrid autosave persists through onApply; the heavy staged flow is gone.
  assert.match(batchSource, /onApply\(\{ rowEdits: edits \}\)/);
  assert.doesNotMatch(batchSource, /Preview changes/);
  assert.doesNotMatch(batchSource, /Apply changes/);
});

test("Plan column is plain text — no badge pills, no bottom dashboard", () => {
  assert.match(batchSource, /planLabel/);
  assert.match(batchSource, /batch-edit-plan-cell/);
  assert.doesNotMatch(batchSource, /batch-edit-status-cell/);
  assert.doesNotMatch(batchSource, /StatusBadge kind=/);
  assert.doesNotMatch(batchSource, /View only issues/);
  assert.doesNotMatch(batchSource, /SummaryStat/);
});

test("Batch Edit uses adaptive toolbar + two visible CTAs (no dropdown)", () => {
  assert.match(batchSource, /batch-edit-default-toolbar/);
  assert.match(batchSource, /batch-edit-selection-toolbar/);
  // Schedule (primary) + Publish now are both visible header buttons, not hidden in a dropdown.
  assert.match(batchSource, /data-testid="batch-edit-schedule-selected"/);
  assert.match(batchSource, /data-testid="batch-edit-publish-now"/);
  // Primary CTA is the single word "Schedule" — never "Schedule selected (N)".
  assert.doesNotMatch(batchSource, /Schedule selected/);
  assert.match(batchSource, /Publish now/);
  assert.doesNotMatch(batchSource, /Schedule \/ Publish/);
});

test("Batch Edit table cells are directly editable", () => {
  assert.match(batchSource, /batch-edit-title-cell/);
  assert.match(batchSource, /batch-edit-description-cell/);
  assert.match(batchSource, /batch-edit-alt-cell/);
  assert.match(batchSource, /batch-edit-board-cell/);
  assert.match(batchSource, /batch-edit-destination-url-cell/);
});

test("Product column shows thumbnail + quick add, never an error", () => {
  assert.match(batchSource, /batch-edit-product-add/);
  assert.match(batchSource, /ProductQuickAdd/);
  assert.doesNotMatch(batchSource, /Missing product/);
});

test("Publish time is a default column; Plan replaces Status", () => {
  assert.match(batchSource, /id: "time", label: tr\("studioModals\.col\.publishTime"\)/);
  assert.match(batchSource, /id: "plan", label: tr\("studioModals\.col\.plan"\)/);
  assert.doesNotMatch(batchSource, /showDateCol/);
  assert.doesNotMatch(batchSource, /label: "Status"/);
});

test("Table supports resizable columns + horizontal width", () => {
  assert.match(batchSource, /startResize/);
  assert.match(batchSource, /col-resize/);
  assert.match(batchSource, /tableWidth/);
});

test("Batch Edit never renders a Needs date state", () => {
  assert.doesNotMatch(batchSource, /Needs date/);
});

test("Plan values are only Not planned / Planned / Posted / Failed", () => {
  const fnIdx = batchSource.indexOf("function planLabel");
  assert.ok(fnIdx >= 0);
  const fnBody = batchSource.slice(fnIdx, fnIdx + 700);
  assert.match(fnBody, /"Not planned"/);
  assert.match(fnBody, /"Planned"/);
  assert.match(fnBody, /"Posted"/);
  assert.match(fnBody, /"Failed"/);
  assert.doesNotMatch(fnBody, /needs_date|Needs date/);
});

test("Pin preview column renders a vertical thumbnail", () => {
  assert.match(batchSource, /batch-edit-pin-thumb/);
  assert.match(batchSource, /Vertical Pin thumbnail/);
});

test("Batch Edit is a fullscreen workspace, not a dimmed right drawer", () => {
  assert.doesNotMatch(batchSource, /batch-edit-backdrop/);
  assert.doesNotMatch(batchSource, /rgba\(0,0,0,0\.5\)", zIndex: 198/);
  assert.doesNotMatch(batchSource, /boxShadow: "-8px 0 32px/);
});

test("Schedule button label is exactly 'Schedule'", () => {
  assert.match(batchSource, /<CalendarClock[^>]*\/>\s*\{tr\("studioModals\.header\.schedule"\)\}\s*<\/button>/);
  assert.doesNotMatch(batchSource, /Schedule selected/);
});

test("Schedule assigns Smart Schedule date/time/plannedAt; missing URL never blocks", () => {
  // Studio Add-to-Plan path assigns a real slot (date+time+plannedAt) via ensureScheduledPlanTime.
  assert.match(studioSource, /ensureScheduledPlanTime/);
  // Weekly Plan schedule uses autoSchedulePins (canonical Smart Schedule).
  assert.match(planSource, /autoSchedulePins/);
  // Schedule has no readiness/URL gate — it simply calls onScheduleSelected.
  assert.match(batchSource, /function scheduleSelected\(\)[\s\S]{0,160}onScheduleSelected/);
});

test("getPinReadiness needs_date from addedToPlanAt", () => {
  const result = getPinReadiness({ addedToPlanAt: "2026-06-01T10:00:00Z" });
  assert.equal(result.planStatus, "needs_date");
});

test("getPinReadiness needs_date from planningStatus=added_to_plan", () => {
  const result = getPinReadiness({ planningStatus: "added_to_plan" });
  assert.equal(result.planStatus, "needs_date");
});

test("getPinReadiness scheduled wins over addedToPlanAt", () => {
  const result = getPinReadiness({ addedToPlanAt: "2026-06-01T10:00:00Z", plannedDate: "2026-07-01" });
  assert.equal(result.planStatus, "scheduled");
});

test("Website URL bulk defaults to fill-empty; replace requires confirmation", () => {
  assert.match(batchSource, /fill_empty/);
  assert.match(batchSource, /studioModals\.dest\.replaceConfirmTitle/);
  assert.match(batchSource, /danger: true/);
});

test("Website URL bulk supports product-URL and clear modes (optional URL)", () => {
  // Three actions: keep (no-op default), set from product URL, clear.
  assert.match(batchSource, /"fill_empty" \| "replace" \| "product" \| "clear"/);
  assert.match(batchSource, /studioModals\.dest\.useProductUrlWhereAvailable/);
  assert.match(batchSource, /studioModals\.dest\.clearWebsiteUrl/);
  // Product mode never fails the batch when some Pins lack a product URL.
  assert.match(batchSource, /studioModals\.dest\.appliedWhereAvailable/);
  // Clear mode confirms before wiping existing URLs.
  assert.match(batchSource, /studioModals\.dest\.clearConfirmTitle/);
});

test("Product bulk add never mutates destinationUrl", () => {
  const addIdx = batchSource.indexOf("function applyBulkProductAdd");
  const replaceIdx = batchSource.indexOf("function applyBulkProductReplace");
  assert.ok(addIdx >= 0 && replaceIdx > addIdx);
  const addBody = batchSource.slice(addIdx, replaceIdx);
  assert.doesNotMatch(addBody, /destinationUrl/);
});

test("Product replace requires confirmation", () => {
  assert.match(batchSource, /studioModals\.product\.replaceConfirmTitle(One|Many)/);
});

test("Product is never surfaced as an error", () => {
  assert.doesNotMatch(batchSource, /Missing product/);
});

test("CSV import/export and preview modal removed", () => {
  assert.doesNotMatch(batchSource, /Import CSV/);
  assert.doesNotMatch(batchSource, /Export CSV/);
  assert.doesNotMatch(batchSource, /PreviewChangesModal/);
});

test("both apply flows persist planned time and plannedAt", () => {
  assert.match(studioSource, /rowEdit\.plannedTime/);
  assert.match(studioSource, /rowEdit\.plannedAt/);
  assert.match(planSource, /e\.plannedTime/);
  assert.match(planSource, /e\.plannedAt/);
});

test("Studio Publish from Batch Edit marks posted via canonical path", () => {
  assert.match(studioSource, /handleBatchPublishComplete/);
  assert.match(studioSource, /markDraftPosted/);
  assert.match(studioSource, /planningStatus: "posted"/);
});

test("Schedule selected wired on both surfaces (no publish readiness gate)", () => {
  assert.match(studioSource, /handleBatchScheduleSelected/);
  assert.match(planSource, /handleWpScheduleSelected/);
});

console.log(`\nBatch Edit planning: ${passed} passed, 0 failed`);
