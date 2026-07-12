/**
 * Weekly Plan multi-select + shared Batch Edit entry points.
 * Verifies selection is available across Week / Month / Day-detail / Unscheduled / List
 * and that all routes open the ONE shared Batch Edit workspace with the selected IDs,
 * preserving planned time — no duplicate Batch Edit implementation.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const plan = readFileSync(join(root, "src/app/app/plan/page.tsx"), "utf8");
const studio = readFileSync(join(root, "src/app/app/studio/page.tsx"), "utf8");
const list = readFileSync(join(root, "src/components/plan/PlanListView.tsx"), "utf8");
const batch = readFileSync(join(root, "src/components/studio/BatchEditDrawer.tsx"), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

console.log("Weekly Plan multi-select + shared Batch Edit");

// 1
test("Week tiles render a selection checkbox (hover-reveal, not mode-gated)", () => {
  assert(/function SelectCheckbox/.test(plan), "shared SelectCheckbox missing");
  assert(plan.includes('testId="scheduled-select-box"'), "Week tile checkbox missing");
  // Hover-reveal: visibility comes from hover, not only Edit Plan mode.
  assert(/const checkVisible = hovered \|\| !!select\?\.active/.test(plan), "checkbox not hover-revealed");
});

// 2
test("Selecting a tile toggles the Weekly Plan selection set", () => {
  assert(plan.includes("setSelectedIds"), "selection state missing");
  assert(/toggle: \(id: string\) => setSelectedIds/.test(plan), "select.toggle not wired to selectedIds");
});

// 3
test("Selection toolbar appears whenever something is selected (not just Edit Plan mode)", () => {
  assert(/\{\(editMode \|\| selectedIds\.size > 0\) && \(/.test(plan), "toolbar still gated behind editMode only");
  assert(plan.includes('data-testid="weekly-plan-selection-bar"'), "selection bar missing");
});

// 4
test("Batch edit opens the shared Batch Edit workspace with selected IDs", () => {
  assert(plan.includes('data-testid="wp-batch-edit"'), "batch edit button missing");
  assert(plan.includes("openBatchEditFor([...selectedIds])"), "batch edit not passing selected IDs");
  assert(/setBatchDraftIds\(/.test(plan) && /setBatchOpen\(true\)/.test(plan), "openBatchEditFor does not open shared editor");
  assert(plan.includes("BatchEditDrawer"), "shared BatchEditDrawer not used");
});

// 5 & 6
test("Month View items + Day Detail rows are selectable into the same flow", () => {
  assert(plan.includes('testId="month-select-box"'), "Month item checkbox missing");
  assert(plan.includes('testId="day-detail-select-box"'), "Day detail checkbox missing");
  // Both use the same select.toggle → same selectedIds → same openBatchEditFor.
  assert(plan.includes("onToggle={() => select.toggle(ev.draftId)}"), "Month/Day selection not wired to shared select");
});

// 7
test("Unscheduled rail cards are selectable", () => {
  assert(plan.includes('testId="rail-select-box"'), "Unscheduled checkbox missing");
});

// 8
test("List View Batch edit opens the SAME shared Batch Edit workspace", () => {
  assert(/onBatchEdit\?:/.test(list), "List view onBatchEdit handler missing");
  assert(list.includes("handlers.onBatchEdit"), "List Batch edit button not wired");
  assert(list.includes('data-testid="plan-list-edit-selected"'), "List batch edit button missing");
  assert(plan.includes("onBatchEdit:   (ids) => openBatchEditFor(ids)"), "List not routed to shared openBatchEditFor");
});

// 9
test("Batch Edit receives exactly the selected IDs, no duplicates (Set-backed)", () => {
  assert(/selectedIds, setSelectedIds\] = useState<Set<string>>/.test(plan), "selection is not a Set (could duplicate)");
  assert(plan.includes("openBatchEditFor([...selectedIds])"), "spread of selection set into editor missing");
});

// 10
test("Weekly Plan Batch Edit preserves plannedDate/plannedTime/plannedAt", () => {
  assert(/plannedDate: d\.scheduledDate/.test(plan), "plannedDate not mapped from scheduledDate");
  assert(/plannedTime: d\.scheduledTime/.test(plan), "plannedTime not preserved");
  assert(/plannedAt: d\.plannedAt/.test(plan), "plannedAt not preserved");
});

// 11
test("Schedule from selection uses canonical Smart Schedule", () => {
  assert(plan.includes("handleBulkSmartSchedule"), "schedule handler missing");
  assert(plan.includes("autoSchedulePins"), "not using canonical Smart Schedule");
});

// 12
test("Already-planned Pins are not overwritten by Schedule", () => {
  assert(plan.includes("filterUnscheduledPinIds"), "schedule does not skip already-scheduled (would overwrite)");
});

// 13
test("Schedule does not gate on missing URL / board / product", () => {
  // handleBulkSmartSchedule operates purely on schedule slots; no readiness gate.
  const idx = plan.indexOf("function handleBulkSmartSchedule");
  assert(idx >= 0, "handler missing");
  const body = plan.slice(idx, idx + 700);
  assert(!/destinationUrl|boardId|isDraftReadyToPublish|pinMissingFields/.test(body), "schedule gated on metadata readiness");
});

// 14
test("Missing product is never rendered as an error in Batch Edit", () => {
  assert(!/Missing product/.test(batch), "Batch Edit shows a Missing product error");
});

// 15 & no-duplicate
test("Create Pins still uses the SAME shared Batch Edit — no duplicate implementation", () => {
  assert(studio.includes('from "@/components/studio/BatchEditDrawer"'), "Create Pins not importing shared BatchEditDrawer");
  assert(plan.includes('from "@/components/studio/BatchEditDrawer"'), "Weekly Plan not importing shared BatchEditDrawer");
  assert(studio.includes("handleBatchApply") && studio.includes("BatchEditDrawer"), "Create Pins batch flow regressed");
});

console.log(`\nWeekly Plan multi-select: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
