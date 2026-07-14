import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPlanDebugEnabled } from "../src/lib/planDebug";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const studioSource  = readFileSync("src/app/app/studio/page.tsx", "utf8");
const batchSource   = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
const planSource    = readFileSync("src/app/app/plan/page.tsx", "utf8");
const actionsSource = readFileSync("src/components/studio/PinCardActions.tsx", "utf8");

// Helper: extract a status' matrix block from PinCardActions MATRIX.
function matrixBlock(status: string): string {
  // Anchor on the block key with its leading newline + 2-space indent so
  // "scheduled" does not false-match inside the earlier "unscheduled" key.
  const start = actionsSource.indexOf(`\n  ${status}: {`);
  assert.ok(start >= 0, `MATRIX missing status: ${status}`);
  return actionsSource.slice(start, start + 360);
}

// ── plan_debug gating ──────────────────────────────────────────────────────
test("isPlanDebugEnabled: true in local development", () => {
  assert.equal(isPlanDebugEnabled("development", undefined), true);
});
test("isPlanDebugEnabled: false in production (no flag)", () => {
  assert.equal(isPlanDebugEnabled("production", undefined), false);
});
test("isPlanDebugEnabled: false in test (production-parity)", () => {
  assert.equal(isPlanDebugEnabled("test", undefined), false);
});
test("isPlanDebugEnabled: explicit flag enables it even in production", () => {
  assert.equal(isPlanDebugEnabled("production", "true"), true);
});
test("isPlanDebugEnabled: false when env undefined and no flag", () => {
  assert.equal(isPlanDebugEnabled(undefined, undefined), false);
});
test("studio card gates plan debug via isPlanDebugEnabled()", () => {
  assert.match(studioSource, /const showDiag = isPlanDebugEnabled\(\)/);
  assert.doesNotMatch(studioSource, /const IS_PROD/);
});

// ── Normalized card status model ────────────────────────────────────────────
test("AC1: no 'Needs details' / 'Needs date' / 'Not planned' card status anywhere", () => {
  // No card-grid status ("needs details") concept at all.
  assert.doesNotMatch(studioSource, /Needs details/);
  // The card badge model no longer has the old negative/intermediate labels.
  const badgeBlock = studioSource.slice(studioSource.indexOf("const badgeLabel"), studioSource.indexOf("const badgeIcon"));
  assert.doesNotMatch(badgeBlock, /Needs date|Needs details|Not planned/);
  // Clean default badge label for a completed-but-unscheduled pin.
  assert.match(badgeBlock, /studio\.badge\.ready|studio\.badge\.unscheduled/);
  // The shared action component knows nothing about those states either.
  assert.doesNotMatch(actionsSource, /Needs details|Needs date|Not planned/);
});
test("Card status model is Ready/Scheduled/Failed/Posted/Generating", () => {
  assert.match(studioSource, /const cardStatus: PinCardStatus =/);
  assert.match(actionsSource, /PinCardStatus = "generating" \| "failed" \| "unscheduled" \| "scheduled" \| "posted"/);
});
test("Unscheduled badge replaces the old negative 'Not planned'", () => {
  assert.match(studioSource, /:\s*tr\("studio\.badge\.unscheduled"\);/); // badgeLabel fallthrough → "Unscheduled"
});

// ── AC8: all actions come from one shared PinCardActions ────────────────────
test("AC8: cards render the shared PinCardActions component", () => {
  assert.match(studioSource, /import \{ PinCardActions, type PinCardStatus \}/);
  assert.match(studioSource, /<PinCardActions/);
  // The card no longer hardcodes its own action buttons.
  assert.doesNotMatch(studioSource, /data-testid="pin-card-add-to-plan"/);
  assert.doesNotMatch(studioSource, /data-testid="pin-card-view-in-plan"/);
});

// ── AC2–AC4: action matrix labels by status ─────────────────────────────────
test("AC2: Unscheduled → Schedule + Details, More: Regenerate/Download/Save as Reference", () => {
  const b = matrixBlock("unscheduled");
  assert.match(b, /label: "Schedule"/);
  assert.match(b, /label: "Details"/);
  assert.match(b, /more: \["regenerate", "download", "saveReference"\]/);
});
test("AC3: Scheduled → Edit + View Plan", () => {
  const b = matrixBlock("scheduled");
  assert.match(b, /label: "Edit"/);
  assert.match(b, /label: "View Plan"/);
  assert.match(b, /more: \["regenerate", "download", "saveReference"\]/);
});
test("AC4: Failed → Try again + Edit prompt, More: Regenerate only", () => {
  const b = matrixBlock("failed");
  assert.match(b, /label: "Try again"/);
  assert.match(b, /label: "Edit prompt"/);
  assert.match(b, /more: \["regenerate"\]/);
});
test("Posted → View Pin + Details, More: Download/Save as Reference (no Regenerate)", () => {
  const b = matrixBlock("posted");
  assert.match(b, /label: "View Pin"/);
  assert.match(b, /label: "Details"/);
  assert.match(b, /more: \["download", "saveReference"\]/);
});
test("Generating → disabled 'Generating…' primary, no secondary, no More", () => {
  const b = matrixBlock("generating");
  assert.match(b, /label: "Generating…", disabled: true/);
  assert.match(b, /more: \[\]/);
  assert.doesNotMatch(b, /secondary/);
});

// ── AC5: no 'View error' ────────────────────────────────────────────────────
test("AC5: failed card never shows 'View error'", () => {
  assert.doesNotMatch(actionsSource, /View error/);
  assert.doesNotMatch(studioSource, /View error/);
});

// ── AC6 & Schedule/Edit/Details behavior ────────────────────────────────────
test("AC6: Schedule/Edit/Details all open the shared modal (onOpenModal)", () => {
  // Unscheduled primary + Scheduled primary + secondary all use the openModal action.
  assert.match(matrixBlock("unscheduled"), /key: "openModal"/);
  assert.match(matrixBlock("scheduled"), /key: "openModal"/);
  // Studio wires onOpenModal to onView → opens the shared Pin detail modal ("plan" tab).
  assert.match(studioSource, /onOpenModal=\{onView\}/);
  assert.match(studioSource, /onView=\{\(e\) => \{[\s\S]*?onOpenPinDetail\(session\.id, entry\.key, "plan"\)/);
});

// ── AC7: missing fields handled in modal, not as a card state ───────────────
test("AC7: no field-level card warnings (completenessHints removed)", () => {
  assert.doesNotMatch(studioSource, /completenessHints/);
});
test("Weekly Plan row no longer hardcodes a 'No product' chip", () => {
  assert.doesNotMatch(planSource, /Compact product state/);
  assert.doesNotMatch(planSource, />No product</);
});

// ── Layout + clickability ───────────────────────────────────────────────────
test("Action buttons ~36px; More hit area >=36×36", () => {
  assert.match(actionsSource, /const ACTION_H = 36/);
  assert.match(actionsSource, /width: ACTION_H, height: ACTION_H/);
});
test("Primary left, secondary next, More far right (marginLeft auto)", () => {
  assert.match(actionsSource, /marginLeft: "auto"/);
});
test("More menu click never bubbles to the card (stopPropagation)", () => {
  assert.match(actionsSource, /stopPropagation/);
  assert.match(actionsSource, /data-testid="pin-card-more"/);
});
test("More menu items only: Regenerate / Download / Save as Reference", () => {
  assert.match(actionsSource, /data-testid="pin-card-regenerate-btn"/);
  assert.match(actionsSource, /data-testid="pin-card-download"/);
  assert.match(actionsSource, /Save as Reference/);
  assert.doesNotMatch(actionsSource, /Add completed to Plan|pin-card-remix-btn|Regenerate set/);
});

// ── Batch Edit header (unchanged behavior, kept regression-green) ────────────
test("Batch Edit primary CTA renders 'Schedule', not 'Schedule selected (N)'", () => {
  assert.match(batchSource, /data-testid="batch-edit-schedule-selected"[\s\S]*?CalendarClock[\s\S]*?tr\("studioModals\.header\.schedule"\)/);
  assert.doesNotMatch(batchSource, /Schedule selected/);
});
test("Batch Edit does not render a large 'Close' text button", () => {
  assert.doesNotMatch(batchSource, /<X[^/]*\/>\s*Close/);
  assert.match(batchSource, /data-testid="batch-edit-close"[^>]*aria-label=\{tr\("pinDetails\.close"\)\}/);
});
test("Batch Edit shows Publish selected now only when Pins are selected", () => {
  // Intended behavior (Publish Now design): the button is gated on SELECTION —
  // readiness is validated at publish time via the confirm/blocked phases, not by
  // hiding the button. (The old publishReadyCount>0 gate is retired.)
  assert.match(batchSource, /checkedCount > 0 &&[\s\S]*?batch-edit-publish-now/);
  assert.doesNotMatch(batchSource, /Publish now\{/);
});
test("Batch Edit shows a quiet 'N selected' pill", () => {
  assert.match(batchSource, /batch-edit-selected-count/);
  assert.match(batchSource, /tr\("studioModals\.selectedCount"\)\.replace\("\{n\}", String\(checkedCount\)\)/);
});
test("Batch Edit Schedule has no publish-readiness gate", () => {
  assert.match(batchSource, /function scheduleSelected\(\)[\s\S]*?onScheduleSelected\(\[\.\.\.checkedRows\]\)/);
  const fn = batchSource.slice(batchSource.indexOf("function scheduleSelected()"));
  const body = fn.slice(0, fn.indexOf("}"));
  assert.doesNotMatch(body, /isPinReady|pubReadinessInput/);
});

console.log(`\nCreate Pins / Batch Edit UI: ${passed} passed, 0 failed`);
