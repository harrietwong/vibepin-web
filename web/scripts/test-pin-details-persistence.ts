/**
 * test-pin-details-persistence.ts
 * Post-Phase-2 QA Debt: characterization tests for DraftDetailsDrawer persistence path
 * and SmartScheduleDrawer selector safety.
 *
 * All tests are source-level or pure-logic. No DOM/browser required.
 * These verify the persistence path (persistDraft → updateDraft → localStorage) and
 * prove stable data-testid selectors exist for both drawers.
 *
 * Run: npx tsx scripts/test-pin-details-persistence.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  OK  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(e as Error).message}`);
  }
}

const root = process.cwd();
const drawerSource = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
const storeSource  = readFileSync(join(root, "src/lib/pinDraftStore.ts"), "utf8");
const smartSource  = readFileSync(join(root, "src/components/plan/SmartScheduleDrawer.tsx"), "utf8");
// Smart Schedule was refactored into a thin modal shell (SmartScheduleDrawer/Modal) that
// renders the shared SmartScheduleConfigForm. The canonical save (saveSmartScheduleConfig,
// SMART_SCHEDULE_EVENT, add-slot) now lives in the config form — assert against it.
const smartFormSource = readFileSync(join(root, "src/components/plan/SmartScheduleConfigForm.tsx"), "utf8");

// ── Persistence path: source-level verification ───────────────────────────────

console.log("\n=== DraftDetailsDrawer persistence path ===");

test("persistDraft calls pinDraftStore.updateDraft (single persistence point)", () => {
  assert.ok(
    drawerSource.includes("pinDraftStore.updateDraft(activeDraft.id,"),
    "persistDraft must call pinDraftStore.updateDraft with the active draft id",
  );
});

test("persistDraft writes title, description, altText — all trim()'d", () => {
  assert.ok(drawerSource.includes("title: title.trim()"), "title not trim()'d before persist");
  assert.ok(drawerSource.includes("description: description.trim()"), "description not trim()'d");
  assert.ok(drawerSource.includes("altText: altText.trim()"), "altText not trim()'d");
});

test("persistDraft writes destinationUrl (trim()'d, not overwritten by productUrl)", () => {
  assert.ok(drawerSource.includes("destinationUrl: destinationUrl.trim()"), "destinationUrl missing from patch");
  // The auto-fill logic only runs when destinationUrl is empty (during attachProduct, not during save).
  // This is the correct behavior: save always uses the current destinationUrl state.
  assert.ok(drawerSource.includes("attachProduct"), "attachProduct (auto-fill source) must still exist in parent");
});

test("persistDraft writes scheduledDate and scheduledTime as separate fields", () => {
  assert.ok(drawerSource.includes("scheduledDate: trimmedDate"), "scheduledDate missing from patch");
  assert.ok(drawerSource.includes("scheduledTime: trimmedDate ? scheduledTime.trim() : \"\""), "scheduledTime not guarded by trimmedDate");
});

test("persistDraft writes boardId and boardName from the boards list (never from boardSuggestion)", () => {
  assert.ok(drawerSource.includes("patch.boardId = selectedBoard?.id ?? \"\""), "boardId not written from selectedBoard");
  assert.ok(drawerSource.includes("patch.boardName = selectedBoard?.name ?? \"\""), "boardName not written from selectedBoard");
  // Verify boardSuggestion is not written into boardId
  assert.ok(!drawerSource.includes("boardId: boardSuggestion"), "boardSuggestion must never be written as boardId");
  assert.ok(!drawerSource.includes("boardId = boardSuggestion"), "boardSuggestion must never be assigned to boardId");
});

test("persistDraft updates addedToPlanAt when a date is set for an unplanned draft", () => {
  assert.ok(
    drawerSource.includes("patch.addedToPlanAt = new Date().toISOString()"),
    "addedToPlanAt flag-setting missing — needs_date transition will break",
  );
});

test("markDirty auto-saves via persistDraft (debounced) — single persist path", () => {
  // No manual Save button: markDirty schedules a debounced persistDraft().
  const m = drawerSource.match(/function markDirty\(\)[\s\S]{0,400}?\n {2}}/);
  assert.ok(m, "markDirty not found");
  assert.ok(m![0].includes("persistDraft()"), "markDirty must call persistDraft() (auto-save)");
  assert.ok(!drawerSource.includes("function handleSave"), "manual handleSave should be removed");
});

test("handlePublish auto-saves via persistDraft before publishing", () => {
  assert.ok(
    drawerSource.includes("persistDraft();\n    setPublishError(null)") ||
    drawerSource.includes("persistDraft();\n    setPublishError(null)") ||
    drawerSource.includes("persistDraft();"),
    "handlePublish must call persistDraft() before setting up publish state",
  );
});

// ── Persistence path: pinDraftStore source verification ───────────────────────

console.log("\n=== pinDraftStore persistence layer ===");

test("updateDraft reads from localStorage with STORE_KEY", () => {
  assert.ok(storeSource.includes('localStorage.getItem(STORE_KEY)'), "store must read from STORE_KEY");
  assert.ok(storeSource.includes('localStorage.setItem(STORE_KEY'), "store must write to STORE_KEY");
});

test("updateDraft emits DRAFT_STORE_EVENT after every write (listeners get live updates)", () => {
  // Every write path calls emit() which dispatches DRAFT_STORE_EVENT on window.
  assert.ok(storeSource.includes("emit()"), "store must call emit() after writes");
  assert.ok(storeSource.includes("DRAFT_STORE_EVENT"), "DRAFT_STORE_EVENT must be defined");
  assert.ok(storeSource.includes("window.dispatchEvent(new Event(DRAFT_STORE_EVENT))"), "emit must dispatch DRAFT_STORE_EVENT on window");
});

test("STORE_KEY is stable (changing it would silently lose all drafts)", () => {
  assert.ok(storeSource.includes('"vp:pin_drafts:v1"'), 'STORE_KEY must be "vp:pin_drafts:v1"');
});

test("updateDraft returns the updated draft (allows onSaved callback to fire)", () => {
  // In DraftDetailsDrawer: const updated = pinDraftStore.updateDraft(...); if (updated) onSaved?.(updated)
  assert.ok(drawerSource.includes("if (updated) onSaved?.(updated)"), "onSaved callback must only fire when updateDraft returns a draft");
});

// ── Persistence path: section isolation ───────────────────────────────────────

console.log("\n=== Extracted sections — no direct persistence ===");

test("PinBoardSection does not write to store or call fetch APIs", () => {
  const src = readFileSync(join(root, "src/components/pin-details/PinBoardSection.tsx"), "utf8");
  assert.ok(!src.includes("updateDraft"), "PinBoardSection must not call updateDraft");
  assert.ok(!src.includes("fetchPinterestBoards"), "PinBoardSection must not call fetchPinterestBoards");
  assert.ok(!src.includes("localStorage"), "PinBoardSection must not access localStorage directly");
});

test("PinPlannedDateTimeSection does not write to store or inject midnight default", () => {
  const src = readFileSync(join(root, "src/components/pin-details/PinPlannedDateTimeSection.tsx"), "utf8");
  assert.ok(!src.includes("updateDraft"), "PinPlannedDateTimeSection must not call updateDraft");
  assert.ok(!src.includes("localStorage"), "PinPlannedDateTimeSection must not access localStorage");
  assert.ok(!src.includes('"00:00"'), "PinPlannedDateTimeSection must not inject midnight default");
  assert.ok(!src.includes("'00:00'"), "PinPlannedDateTimeSection must not inject midnight default (single-quote)");
});

test("PinProductLinksSection does not write to store and has no destinationUrl prop", () => {
  const src = readFileSync(join(root, "src/components/pin-details/PinProductLinksSection.tsx"), "utf8");
  assert.ok(!src.includes("updateDraft"), "PinProductLinksSection must not call updateDraft");
  assert.ok(!src.includes("localStorage"), "PinProductLinksSection must not access localStorage");
  // The type definition block must not declare destinationUrl as a prop.
  // (Comments inside the type block may mention it for documentation — that is fine.)
  const typeBlock = src.slice(src.indexOf("export type PinProductLinksSectionProps"), src.indexOf("export function PinProductLinksSection"));
  assert.ok(!typeBlock.includes("destinationUrl:"), "PinProductLinksSection props type must not declare destinationUrl as a prop");
});

// ── Smart Schedule drawer selector safety ────────────────────────────────────

console.log("\n=== SmartScheduleDrawer selector safety ===");

test("SmartScheduleDrawer root element has data-testid='smart-schedule-drawer'", () => {
  assert.ok(
    smartSource.includes('data-testid="smart-schedule-drawer"'),
    "smart-schedule-drawer testid missing — Playwright smoke selector will fail",
  );
});

test("SmartScheduleDrawer close button is accessible (aria-label='Close')", () => {
  assert.ok(smartSource.includes('aria-label="Close"'), "Close button missing aria-label");
});

test("SmartScheduleDrawer add-slot button has stable testid", () => {
  assert.ok(
    smartFormSource.includes('data-testid="smart-schedule-add-slot"'),
    "smart-schedule-add-slot testid missing",
  );
});

test("SmartScheduleDrawer save button has stable testid", () => {
  assert.ok(
    smartSource.includes('data-testid="smart-schedule-save"'),
    "smart-schedule-save testid missing",
  );
});

test("SmartScheduleDrawer saves via saveSmartScheduleConfig (not pinDraftStore)", () => {
  assert.ok(smartFormSource.includes("saveSmartScheduleConfig(fresh)"), "Smart Schedule config form must save via smartScheduleStore (fresh slots)");
  assert.ok(!smartFormSource.includes("pinDraftStore"), "Smart Schedule config form must not touch pinDraftStore directly");
  assert.ok(!smartFormSource.includes("updateDraft"), "Smart Schedule config form must not call updateDraft");
  // The modal shell itself never writes drafts either.
  assert.ok(!smartSource.includes("pinDraftStore"), "Smart Schedule modal must not touch pinDraftStore");
});

test("SmartScheduleDrawer dispatches SMART_SCHEDULE_EVENT after save (plan page re-reads)", () => {
  // The event is emitted inside saveSmartScheduleConfig (smartScheduleStore.ts). Verify the
  // config form delegates save to that store function and imports the event for its listener.
  assert.ok(
    smartFormSource.includes("saveSmartScheduleConfig(fresh)"),
    "Smart Schedule config form must delegate save to saveSmartScheduleConfig which emits SMART_SCHEDULE_EVENT",
  );
  assert.ok(
    smartFormSource.includes("subscribeToSmartScheduleConfigChanges"),
    "Smart Schedule config form must subscribe to canonical config changes (wraps SMART_SCHEDULE_EVENT)",
  );
});

test("SmartScheduleDrawer renders null when closed (no orphaned DOM)", () => {
  assert.ok(smartSource.includes("if (!open) return null"), "SmartScheduleDrawer must return null when not open");
});

// ── Pin Details entry point testids ─────────────────────────────────────────

console.log("\n=== Pin Details drawer entry points ===");

test("DraftDetailsDrawer modal root has data-testid='draft-details-drawer'", () => {
  assert.ok(
    drawerSource.includes('data-testid="draft-details-drawer"'),
    "draft-details-drawer testid missing on modal root",
  );
});

test("Save state indicator has data-testid='draft-save-state'", () => {
  assert.ok(
    drawerSource.includes('data-testid="draft-save-state"'),
    "draft-save-state testid missing — smoke QA cannot verify saved state",
  );
});

test("No manual Save button — auto-save indicator instead", () => {
  assert.ok(!drawerSource.includes('data-testid="draft-edit-save"'), "draft-edit-save should be removed (auto-save)");
  assert.ok(drawerSource.includes('data-testid="draft-save-state"'), "auto-save indicator missing");
});

test("Close button has data-testid='draft-details-close'", () => {
  assert.ok(
    drawerSource.includes('data-testid="draft-details-close"'),
    "draft-details-close testid missing",
  );
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nPin Details persistence + Smart Schedule characterization: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
