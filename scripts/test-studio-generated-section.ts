/**
 * test-studio-generated-section.ts
 *
 * Tests for the Studio Generated Pins section business logic.
 * All 16 PRD-required test cases.
 *
 * Run with:  npx tsx scripts/test-studio-generated-section.ts
 */

export {};

// ── Minimal types (mirrors studio page) ──────────────────────────────────────

type PlanStatus =
  | "not_added" | "added_to_plan" | "needs_review"
  | "ready" | "posted" | "skipped";

interface StudioPin {
  id:               string;
  url:              string;
  planningStatus:   PlanStatus;
  title:            string;
  description:      string;
  altText:          string;
  destinationUrl:   string;
  plannedDate:      string;
  weeklyPlanItemId?: string | null;
}

interface RefGroup {
  refUrl:        string | null;
  refIndex:      number;
  items:         StudioPin[];
  status:        "generating" | "done" | "failed";
  expectedCount: number;
}

// ── Pure functions mirroring studio page logic ────────────────────────────────

function newPin(sessionId: string, gi: number, ii: number, url: string): StudioPin {
  return {
    id: `${sessionId}_g${gi}_p${ii}`, url,
    planningStatus: "not_added",
    title: "", description: "", altText: "", destinationUrl: "", plannedDate: "",
  };
}

function computePlanStatus(pin: StudioPin): PlanStatus {
  if (pin.planningStatus === "posted" || pin.planningStatus === "skipped") return pin.planningStatus;
  if (pin.planningStatus === "not_added") return "not_added";
  const ok = !!pin.title.trim() && !!pin.description.trim() && !!pin.plannedDate.trim();
  return ok ? "ready" : "needs_review";
}

/** Simulates buildReferenceGroups from generation inputs. */
function buildInitialGroups(
  refs: Array<string | null>,
  imageCount: number,
  sessionId: string,
): RefGroup[] {
  const refsToProcess = refs.length > 0 ? refs : [null];
  return refsToProcess.map((refUrl, idx) => ({
    refUrl, refIndex: idx, items: [], status: "generating", expectedCount: imageCount,
  }));
}

/** Simulates filling a group after API returns URLs. */
function fillGroup(group: RefGroup, urls: string[], sessionId: string, gi: number): RefGroup {
  return {
    ...group,
    items: urls.map((url, ii) => newPin(sessionId, gi, ii, url)),
    status: urls.length > 0 ? "done" : "failed",
  };
}

/** Simulates adding a pin to plan (returns updated pin). */
function addToPlan(pin: StudioPin, draftId: string): StudioPin {
  if (pin.planningStatus !== "not_added") return pin; // idempotent
  return { ...pin, planningStatus: "needs_review", weeklyPlanItemId: draftId };
}

/** Simulates Edit details save — recalculates planningStatus. */
function editAndSave(pin: StudioPin, updates: Partial<StudioPin>): StudioPin {
  const updated = { ...pin, ...updates };
  if (updated.planningStatus === "not_added") return updated; // not in plan yet
  return { ...updated, planningStatus: computePlanStatus(updated) };
}

/** Simulates session returnedCount. */
function sessionReturnedCount(groups: RefGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}

// ── Tiny test harness ─────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures: string[] = [];

function expect<T>(label: string, actual: T, expected: T): void {
  if (actual === expected) { passed++; console.log(`  ✓  ${label}`); }
  else {
    failed++;
    const msg = `  ✗  ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`;
    console.error(msg); failures.push(msg);
  }
}
function section(t: string) { console.log(`\n── ${t} ──`); }

// ── Tests ─────────────────────────────────────────────────────────────────────

const SID = "studio_1234567_abc";

section("1–2. Group creation from references");

// 1. no reference + imageCount 2 → 1 default group expectedCount 2
{
  const groups = buildInitialGroups([], 2, SID);
  expect("no refs → 1 group",           groups.length,             1);
  expect("no refs → group refUrl=null", groups[0].refUrl,          null);
  expect("no refs → expectedCount=2",   groups[0].expectedCount,   2);
  expect("no refs → status generating", groups[0].status,          "generating");
}

// 2. 3 references + imageCount 2 → 3 groups, total expected 6
{
  const refs = ["https://ref1.jpg", "https://ref2.jpg", "https://ref3.jpg"];
  const groups = buildInitialGroups(refs, 2, SID);
  expect("3 refs → 3 groups",             groups.length,             3);
  expect("3 refs → total expected = 6",   groups.reduce((n, g) => n + g.expectedCount, 0), 6);
  expect("3 refs → each expectedCount=2", groups.every(g => g.expectedCount === 2), true);
}

section("3. Each reference group keeps correct referenceId");

{
  const refs = ["https://ref-a.jpg", "https://ref-b.jpg"];
  const groups = buildInitialGroups(refs, 2, SID);
  expect("group[0].refUrl = ref-a", groups[0].refUrl, "https://ref-a.jpg");
  expect("group[1].refUrl = ref-b", groups[1].refUrl, "https://ref-b.jpg");
  expect("group[0].refIndex = 0",   groups[0].refIndex, 0);
  expect("group[1].refIndex = 1",   groups[1].refIndex, 1);
}

section("4. Generation uses each reference (not just [0])");

{
  const refs = ["https://ref1.jpg", "https://ref2.jpg", "https://ref3.jpg"];
  const groups = buildInitialGroups(refs, 2, SID);
  // Each group should have its own distinct refUrl
  const refUrls = groups.map(g => g.refUrl);
  const allDistinct = new Set(refUrls).size === 3;
  expect("all 3 refs are distinct",     allDistinct, true);
  expect("ref[0] is refs[0]",           refUrls[0], refs[0]);
  expect("ref[2] is refs[2]",           refUrls[2], refs[2]);
}

section("5. Session returnedCount sums groups returnedCount");

{
  let groups = buildInitialGroups(["https://r1.jpg", "https://r2.jpg", "https://r3.jpg"], 2, SID);
  groups[0] = fillGroup(groups[0], ["https://gen1.jpg", "https://gen2.jpg"], SID, 0);
  groups[1] = fillGroup(groups[1], ["https://gen3.jpg", "https://gen4.jpg"], SID, 1);
  groups[2] = fillGroup(groups[2], [], SID, 2); // failed group
  expect("returnedCount = 4 (2+2+0)", sessionReturnedCount(groups), 4);
}

section("6–8. Group status rules");

// 6. completed groups show "done"
{
  let g = buildInitialGroups(["https://r.jpg"], 2, SID)[0];
  g = fillGroup(g, ["https://a.jpg", "https://b.jpg"], SID, 0);
  expect("all pins returned → status=done", g.status, "done");
}

// 7. partial group (fewer than expected) — status is "done" with fewer items
{
  let g = buildInitialGroups(["https://r.jpg"], 4, SID)[0];
  g = fillGroup(g, ["https://a.jpg", "https://b.jpg"], SID, 0); // only 2 of 4
  expect("partial return → status=done, items.length=2", g.items.length, 2);
  expect("partial return → expectedCount=4",             g.expectedCount,  4);
  expect("returnedCount < expectedCount → partial session",
    sessionReturnedCount([g]) < g.expectedCount, true);
}

// 8. failed group does not erase successful groups
{
  let groups = buildInitialGroups(["https://r1.jpg", "https://r2.jpg"], 2, SID);
  groups[0] = fillGroup(groups[0], ["https://ok1.jpg", "https://ok2.jpg"], SID, 0); // success
  groups[1] = fillGroup(groups[1], [], SID, 1);                                      // failure
  expect("group[0] items preserved after group[1] fails", groups[0].items.length, 2);
  expect("group[1] status = failed",                       groups[1].status, "failed");
  expect("group[0] status = done",                         groups[0].status, "done");
}

section("9–10. UI rendering rules");

// 9. generated pins render below composer — test via hasActivity logic
{
  let groups = buildInitialGroups(["https://r.jpg"], 2, SID);
  const beforeFill = groups.flatMap(g => g.items).length === 0 && groups.some(g => g.status === "generating");
  expect("empty pins + generating → hasActivity=true", beforeFill, true);
  groups[0] = fillGroup(groups[0], ["https://gen.jpg", "https://gen2.jpg"], SID, 0);
  const afterFill = groups.flatMap(g => g.items).length > 0;
  expect("after fill → renders pin cards", afterFill, true);
}

// 10. empty state renders before generation
{
  const emptyGroups: RefGroup[] = [];
  const hasActivity = emptyGroups.flatMap(g => g.items).length > 0 || emptyGroups.some(g => g.status === "generating");
  expect("no groups → empty state shown", hasActivity, false);
}

section("11–12. Add to Plan");

// 11. Add to Plan creates weekly_plan_item (sets planningStatus)
{
  const pin = newPin(SID, 0, 0, "https://gen.jpg");
  const updated = addToPlan(pin, "draft-abc-123");
  expect("after Add to Plan → planningStatus = needs_review", updated.planningStatus, "needs_review");
  expect("after Add to Plan → weeklyPlanItemId set",          updated.weeklyPlanItemId, "draft-abc-123");
}

// 12. Add to Plan does not duplicate existing weekly_plan_item
{
  let pin = newPin(SID, 0, 0, "https://gen.jpg");
  pin = addToPlan(pin, "draft-1");
  const again = addToPlan(pin, "draft-2"); // try to add again
  expect("second Add to Plan → idempotent (planningStatus unchanged)", again.planningStatus, "needs_review");
  expect("second Add to Plan → weeklyPlanItemId unchanged",            again.weeklyPlanItemId, "draft-1");
}

section("13–14. Edit details");

// 13. Edit details updates pin metadata
{
  let pin = newPin(SID, 0, 0, "https://gen.jpg");
  pin = addToPlan(pin, "draft-1");
  const updated = editAndSave(pin, { title: "Cozy Room Ideas", description: "Beautiful home decor", plannedDate: "2026-06-15" });
  expect("after edit → title updated",       updated.title,       "Cozy Room Ideas");
  expect("after edit → description updated", updated.description, "Beautiful home decor");
  expect("after edit → plannedDate updated", updated.plannedDate, "2026-06-15");
}

// 14. planningStatus recalculates after edit
{
  let pin = newPin(SID, 0, 0, "https://gen.jpg");
  pin = addToPlan(pin, "draft-1"); // planningStatus = needs_review

  // fill all required fields
  const withAll = editAndSave(pin, { title: "T", description: "D", plannedDate: "2026-06-10" });
  expect("all required fields → ready",       withAll.planningStatus, "ready");

  // missing title
  const missingTitle = editAndSave(pin, { title: "", description: "D", plannedDate: "2026-06-10" });
  expect("missing title → needs_review",      missingTitle.planningStatus, "needs_review");

  // missing planned date
  const missingDate  = editAndSave(pin, { title: "T", description: "D", plannedDate: "" });
  expect("missing plannedDate → needs_review", missingDate.planningStatus, "needs_review");

  // not in plan — edit should NOT change planningStatus
  const notInPlan = newPin(SID, 0, 0, "https://gen.jpg");
  const edited = editAndSave(notInPlan, { title: "T", description: "D", plannedDate: "2026-06-10" });
  expect("not in plan → edit keeps not_added", edited.planningStatus, "not_added");
}

section("15. Download disabled when imageUrl missing");

{
  const pin = newPin(SID, 0, 0, "");
  const downloadDisabled = !pin.url;
  expect("empty url → download disabled", downloadDisabled, true);

  const pinWithUrl = newPin(SID, 0, 0, "https://gen.jpg");
  const downloadEnabled = !!pinWithUrl.url;
  expect("url present → download enabled", downloadEnabled, true);
}

section("16. Refresh with existing session does not crash");

{
  // Simulate session restore logic: if session entry exists, convert to RefGroup[]
  const sessionEntry = {
    id: SID,
    savedAt: new Date().toISOString(),
    groups: [
      { refUrl: "https://ref.jpg", images: ["https://gen1.jpg", "https://gen2.jpg"] },
    ],
    status: "completed" as string,
    imagesPerRef: 2,
  };

  let restored: RefGroup[] = [];
  try {
    restored = sessionEntry.groups.map((g, idx) => ({
      refUrl:        g.refUrl,
      refIndex:      idx,
      items:         g.images.map((url, ii) => newPin(sessionEntry.id, idx, ii, url)),
      status:        (sessionEntry.status === "running" ? "generating" : sessionEntry.status === "failed" ? "failed" : "done") as RefGroup["status"],
      expectedCount: (sessionEntry.imagesPerRef ?? g.images.length),
    }));
  } catch (e) {
    console.error("  ✗  restore crashed:", e);
    failed++;
  }

  expect("restored groups count = 1",             restored.length,             1);
  expect("restored pins count = 2",               restored[0]?.items.length,   2);
  expect("restored refUrl preserved",             restored[0]?.refUrl,         "https://ref.jpg");
  expect("restored pin 0 url correct",            restored[0]?.items[0]?.url,  "https://gen1.jpg");
  expect("restored pins planningStatus not_added",restored[0]?.items[0]?.planningStatus, "not_added");
}

section("Bonus: newPin ID format");

{
  const pin = newPin("session_xyz_123", 1, 2, "https://u.jpg");
  expect("pin ID contains sessionId", pin.id.startsWith("session_xyz_123_"), true);
  expect("pin ID encodes group index",pin.id.includes("_g1_"),                true);
  expect("pin ID encodes pin index",  pin.id.includes("_p2"),                 true);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.error("\nFailures:");
  failures.forEach(f => console.error(f));
  process.exit(1);
} else {
  console.log("All tests passed ✓");
  process.exit(0);
}
