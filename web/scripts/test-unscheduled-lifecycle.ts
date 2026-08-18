/**
 * test-unscheduled-lifecycle.ts — the Unscheduled tray is a LIFECYCLE set (PRD 0816 §7).
 * Run: npx tsx scripts/test-unscheduled-lifecycle.ts
 *
 * The bug this locks down: isUnaddedGeneratedDraft tested archived / scheduledDate /
 * addedToPlan / boardSource and nothing else. Both publish outcomes CLEAR the
 * scheduling fields (payloadAfterSuccess + payloadAfterFailure), so a posted or failed
 * Pin ended up with no date, no plan membership and no archive flag — satisfying every
 * condition and reappearing in the tray alongside genuine drafts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isUnaddedGeneratedDraft, isPublishedDraft, isFailedDraft } from "../src/lib/pinDraftStore";
import type { PinDraft } from "../src/lib/pinDraftStore";
import { isActionablePublishFailure } from "../src/lib/studio/pinLifecycle";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }

/** A generated draft sitting legitimately in the tray: no date, no plan, not posted. */
function trayDraft(over: Partial<PinDraft> = {}): PinDraft {
  return { id: "d1", source: "ai_generated", imageUrl: "https://x/y.jpg", ...over } as PinDraft;
}

console.log("\n=== the baseline still works ===");
test("a plain generated draft with no date belongs in the tray", () => {
  assert.equal(isUnaddedGeneratedDraft(trayDraft()), true);
});
test("a draft with a scheduled date lives on the calendar, not the tray", () => {
  assert.equal(isUnaddedGeneratedDraft(trayDraft({ scheduledDate: "2026-08-20" })), false);
});
test("an archived draft is off the board entirely", () => {
  assert.equal(isUnaddedGeneratedDraft(trayDraft({ archivedAt: "2026-08-01" })), false);
});
test("an uploaded board draft stays on the Studio board", () => {
  assert.equal(isUnaddedGeneratedDraft(trayDraft({ source: "uploaded_image" })), false);
});

console.log("\n=== the regression: publish CLEARS the dates, so dates cannot gate this ===");
test("a POSTED Pin whose schedule was cleared does not return to the tray", () => {
  // Exactly what payloadAfterSuccess leaves behind: postedAt set, all three
  // scheduling fields blanked. This is the reported bug.
  const posted = trayDraft({
    postedAt: "2026-08-15T09:38:00.000Z",
    remotePinId: "123",
    scheduledDate: "", scheduledTime: "", plannedAt: "",
  });
  assert.equal(isUnaddedGeneratedDraft(posted), false);
});
test("a legacy posted Pin identified only by remotePinId is also excluded", () => {
  assert.equal(isUnaddedGeneratedDraft(trayDraft({ remotePinId: "999" })), false);
});
test("a PUBLISH-FAILED Pin whose schedule was cleared does not return to the tray", () => {
  // What payloadAfterFailure leaves behind.
  const failed = trayDraft({
    failureType: "publish", publishError: "board unavailable",
    scheduledDate: "", scheduledTime: "", plannedAt: "",
    previousScheduledTime: "2026-08-15T09:38:00.000Z",
  });
  assert.equal(isUnaddedGeneratedDraft(failed), false);
});
test("a GENERATION-failed Pin does not sit in the tray as if it were a healthy draft", () => {
  assert.equal(isUnaddedGeneratedDraft(trayDraft({ generationStatus: "failed" })), false);
});

console.log("\n=== the failure rule agrees with the banner and the badge ===");
test("publish-failure exclusion delegates to the canonical predicate", () => {
  // One rule, three surfaces. A second, looser definition here is what made the
  // calendar badge disagree with the "N Pins failed" banner once before.
  const cases: Partial<PinDraft>[] = [
    { failureType: "publish", publishError: "boom" },
    { failureType: "publish", publishError: "boom", archivedAt: "2026-01-01" },
    { failureType: "generation", publishError: "boom" },
    { failureType: "publish" },
    {},
  ];
  for (const c of cases) {
    const canonical = isActionablePublishFailure(c as PinDraft);
    if (canonical) {
      assert.equal(isFailedDraft(c as PinDraft), true, `should be failed: ${JSON.stringify(c)}`);
      assert.equal(isUnaddedGeneratedDraft(trayDraft(c)), false, `must leave tray: ${JSON.stringify(c)}`);
    }
  }
});
test("an ARCHIVED failure is not counted as failed — it is off the board", () => {
  assert.equal(isFailedDraft({ failureType: "publish", publishError: "x", archivedAt: "2026-01-01" } as PinDraft), false);
  assert.equal(isFailedDraft({ generationStatus: "failed", archivedAt: "2026-01-01" } as PinDraft), false);
});

console.log("\n=== the four lifecycle states are mutually exclusive with the tray ===");
test("posted / scheduled / publish-failed / generation-failed all stay out", () => {
  const states: Array<[string, Partial<PinDraft>]> = [
    ["posted",            { postedAt: "2026-08-15T09:38:00.000Z" }],
    ["scheduled",         { scheduledDate: "2026-08-20" }],
    ["publish failed",    { failureType: "publish", publishError: "board unavailable" }],
    ["generation failed", { generationStatus: "failed" }],
  ];
  for (const [label, over] of states) {
    assert.equal(isUnaddedGeneratedDraft(trayDraft(over)), false, `${label} must not appear in Unscheduled`);
  }
});

console.log("\n=== helpers are honest about blank strings ===");
test("empty postedAt is absent, not published", () => {
  assert.equal(isPublishedDraft({ postedAt: "", remotePinId: "" } as PinDraft), false);
  assert.equal(isPublishedDraft({ postedAt: "   ", remotePinId: undefined } as PinDraft), false);
});

console.log("\n=== fixed in the canonical selector, not at the render sites ===");
test("no consumer papers over the bug with its own status filter", () => {
  // PRD §7.2 explicitly forbids hiding this behind filter(status !== "posted") while
  // the canonical query stays wrong.
  const plan = readFileSync("src/components/plan/WeeklyPlanWorkspace.tsx", "utf8");
  assert(!/filter\([^)]*postedAt[^)]*\)/.test(plan),
    "the Plan workspace must not re-filter posted drafts out of the tray by hand");
  const store = readFileSync("src/lib/pinDraftStore.ts", "utf8");
  assert(/isPublishedDraft\(d\)/.test(store) && /isFailedDraft\(d\)/.test(store),
    "the exclusion must live inside isUnaddedGeneratedDraft");
});

console.log(`\nUnscheduled lifecycle: ${passed} passed, 0 failed\n`);
