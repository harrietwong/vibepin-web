/**
 * test-studio-plan-match.ts
 * Covers the manual-QA bug fixes:
 *   1. Create Pins ↔ Weekly Plan status sync (studioPlanMatch matcher + derivation)
 *   2. Batch Edit selection includes already-planned ("added") pins
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PinDraft } from "../src/lib/pinDraftStore";
import {
  findDraftForStudioOutput,
  deriveCardStatusFromDraft,
  getStudioCardPlanState,
  normalizePinSourceId,
} from "../src/lib/studioPlanMatch";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK  ${name}`);
}

function draft(over: Partial<PinDraft>): PinDraft {
  return {
    id: "draft_1",
    imageUrl: "https://cdn.example.com/a.jpg",
    keyword: "", category: "",
    title: "T", description: "D", altText: "A",
    destinationUrl: "https://example.com",
    boardId: "board_123", boardName: "Board",
    weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: "", status: "ready",
    createdAt: "", updatedAt: "",
    ...over,
  } as PinDraft;
}

console.log("\n=== Matching ===");

test("matches by pinId first", () => {
  const drafts = [draft({ id: "d1", pinId: "sess_g0_p0", imageUrl: "https://x/1.jpg" })];
  const r = findDraftForStudioOutput({ id: "sess_g0_p0", url: "https://x/other.jpg" }, drafts);
  assert.equal(r.reason, "pinId");
  assert.equal(r.draft?.id, "d1");
});

test("falls back to imageUrl when pinId does not match", () => {
  const drafts = [draft({ id: "d2", pinId: "different", imageUrl: "https://x/2.jpg" })];
  const r = findDraftForStudioOutput({ id: "sess_g0_p0", url: "https://x/2.jpg" }, drafts);
  assert.equal(r.reason, "imageUrl");
  assert.equal(r.draft?.id, "d2");
});

test("returns none when nothing matches", () => {
  const r = findDraftForStudioOutput({ id: "nope", url: "https://x/none.jpg" }, [draft({ pinId: "x", imageUrl: "https://x/y.jpg" })]);
  assert.equal(r.reason, "none");
  assert.equal(r.draft, null);
});

test("normalizePinSourceId strips junk values", () => {
  assert.equal(normalizePinSourceId("  "), "");
  assert.equal(normalizePinSourceId("undefined"), "");
  assert.equal(normalizePinSourceId("null"), "");
  assert.equal(normalizePinSourceId(" abc "), "abc");
});

console.log("\n=== Status derivation from draft ===");

test("added to plan, no date → needs_date", () => {
  assert.equal(deriveCardStatusFromDraft(draft({ addedToPlanAt: "2026-06-23T10:00:00Z", scheduledDate: "" })), "needs_date");
});

test("scheduled date → scheduled (wins over needs_date)", () => {
  assert.equal(deriveCardStatusFromDraft(draft({ addedToPlanAt: "2026-06-23T10:00:00Z", scheduledDate: "2026-07-01" })), "scheduled");
});

test("posted → posted (highest priority)", () => {
  assert.equal(deriveCardStatusFromDraft(draft({ postedAt: "2026-06-20T00:00:00Z", scheduledDate: "2026-07-01" })), "posted");
});

test("no plan signals → not_planned", () => {
  assert.equal(deriveCardStatusFromDraft(draft({ addedToPlanAt: "", scheduledDate: "" })), "not_planned");
});

console.log("\n=== getStudioCardPlanState (matched vs fallback) ===");

test("matched draft drives state regardless of in-memory fallback", () => {
  const drafts = [draft({ id: "d9", pinId: "sess_g0_p0", scheduledDate: "2026-07-04" })];
  // The in-memory pin still says not_planned, but the draft says scheduled.
  const r = getStudioCardPlanState({ id: "sess_g0_p0", url: "https://x/none.jpg" }, drafts, { state: "not_planned" });
  assert.equal(r.state, "scheduled");
  assert.equal(r.matchReason, "pinId");
  assert.equal(r.plannedDate, "2026-07-04");
});

test("no draft → uses caller fallback state (in-memory)", () => {
  const r = getStudioCardPlanState({ id: "x", url: "https://x/none.jpg" }, [], { state: "posted", plannedDate: "2026-01-01" });
  assert.equal(r.state, "posted");
  assert.equal(r.matchReason, "none");
});

console.log("\n=== Source-level regression guards ===");

const studio = readFileSync("src/app/app/studio/page.tsx", "utf8");
const batch = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");

test("Studio feed reconciles cards against live planDrafts", () => {
  assert.match(studio, /findDraftForStudioOutput\(\{ id: pin\.id, url: pin\.url \}, planDrafts\)/);
  assert.match(studio, /DRAFT_STORE_EVENT, read/);
  assert.match(studio, /entry\.planState \?\? getCardWorkflowState\(pin\)/);
});

test("Batch Edit selection includes already-planned ('added') pins", () => {
  assert.match(studio, /i\.entry\.status === "completed" \|\| i\.entry\.status === "added"/);
});

test("Batch Edit reseeds checkedRows when the selection signature changes", () => {
  assert.match(batch, /const pinIdsKey = pins\.map\(p => p\.pinId\)\.join\("\|"\)/);
  assert.match(batch, /\}, \[open, pinIdsKey\]\)/);
});

test("Scheduled card shows Edit (primary) + View Plan (secondary) via shared actions", () => {
  // Card actions now live in the shared PinCardActions component (status-driven).
  const actions = readFileSync("src/components/studio/PinCardActions.tsx", "utf8");
  // Anchor on the real "scheduled" block key (2-space indent) so we don't
  // false-match the earlier "unscheduled: {" key.
  const schedStart = actions.indexOf("\n  scheduled: {");
  const scheduled = actions.slice(schedStart, schedStart + 360);
  assert.match(scheduled, /label: "Edit"/);
  assert.match(scheduled, /label: "View Plan"/);
  assert.match(scheduled, /testId: "pin-card-view-in-plan"/);
  // Studio renders the shared component and wires Edit → shared modal.
  assert.match(studio, /<PinCardActions/);
  assert.match(studio, /onOpenModal=\{onView\}/);
});

test("Plan-state diagnostics are gated to non-production", () => {
  // Diagnostics gating was refactored from a local IS_PROD constant to the shared
  // isPlanDebugEnabled() helper; assert the current implementation.
  assert.match(studio, /showDiag = isPlanDebugEnabled\(\)/);
  assert.match(studio, /pin-card-plan-debug/);
});

console.log(`\nStudio plan match + QA fixes: ${passed} passed, 0 failed\n`);
