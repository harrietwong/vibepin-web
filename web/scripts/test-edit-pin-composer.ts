/**
 * test-edit-pin-composer.ts — simplified Edit Pin composer:
 * auto-save, one primary CTA, overflow Pin now, searchable board, status sync,
 * neutral affiliate tag.
 *
 * Run: npx tsx scripts/test-edit-pin-composer.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK ${name}`); }

const modal = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
const board = readFileSync("src/components/pin-details/PinBoardSection.tsx", "utf8");

// ── Auto-save + indicator ───────────────────────────────────────────────────
test("Field changes auto-save via debounced persistDraft (no Save button)", () => {
  const m = modal.match(/function markDirty\(\)[\s\S]{0,400}?\n {2}}/);
  assert.ok(m, "markDirty not found");
  assert.match(m![0], /setTimeout/);
  assert.match(m![0], /persistDraft\(\)/);
  assert.doesNotMatch(modal, /data-testid="draft-edit-save"/);
  assert.doesNotMatch(modal, /Save changes/);
});
test("Small non-clickable save indicator: Saving… / Saved / Failed to save", () => {
  assert.match(modal, /data-testid="draft-save-state"/);
  assert.match(modal, /t\("pinDetails\.savingState"\)/);
  assert.match(modal, /t\("pinDetails\.failedToSave"\)/);
  assert.match(modal, /t\("pinDetails\.saved"\)/);
});

// ── One primary CTA ─────────────────────────────────────────────────────────
test("Footer has a single Schedule / Update schedule CTA", () => {
  assert.match(modal, /data-testid="draft-cta-schedule"/);
  assert.match(modal, /isScheduled \? t\("pinDetails\.updateSchedule"\) : t\("pinDetails\.schedule"\)/);
});
test("Add to Plan + Cancel removed from the modal", () => {
  assert.doesNotMatch(modal, /data-testid="pin-details-add-to-plan"/);
  assert.doesNotMatch(modal, /data-testid="draft-details-cancel"/);
});
test("Pin now is in the overflow menu, not a competing CTA", () => {
  assert.match(modal, /data-testid="draft-overflow-pin-now"/);
  assert.doesNotMatch(modal, /data-testid="draft-publish-pinterest"/);
});
test("CTA is disabled with helper text when board/time missing", () => {
  assert.match(modal, /const canSchedule = /);
  assert.match(modal, /data-testid="draft-cta-helper"/);
  assert.match(modal, /t\("pinDetails\.helper\.chooseBoardAndTime"\)/);
  assert.match(modal, /disabled=\{!canSchedule \|\| publishing\}/);
});

// ── Status sync ─────────────────────────────────────────────────────────────
test("Status sync: schedule date/time seed falls back to plannedAt", () => {
  assert.match(modal, /draft\.scheduledDate\?\.trim\(\) \|\| \(draft\.plannedAt/);
});

// ── Neutral affiliate tag (no prominent ASIN in main form) ──────────────────
test("Website URL shows a small affiliate tag, not prominent ASIN", () => {
  assert.match(modal, /t\("pinDetails\.usingAffiliate"\)/);
  const affBlock = modal.slice(modal.indexOf('data-testid="draft-affiliate-url"') - 400, modal.indexOf('data-testid="draft-affiliate-url"') + 200);
  assert.doesNotMatch(affBlock, /ASIN/); // ASIN not shown in the Website URL area
});

// ── Searchable board combobox ───────────────────────────────────────────────
test("Board selector is a searchable combobox", () => {
  assert.match(board, /function BoardCombobox/);
  assert.match(board, /data-testid="draft-board-combobox"/);
  assert.match(board, /placeholder=\{t\("pinDetails\.board\.searchPlaceholder"\)\}/);
  assert.match(board, /data-testid="draft-board-option"/);
  assert.match(board, /role="combobox"/);
});
test("Board combobox keeps loading / disconnected states", () => {
  assert.match(board, /t\("pinDetails\.board\.loading"\)/);
  assert.match(board, /t\("pinDetails\.board\.availableAfterConnect"\)/);
  assert.match(board, /data-testid="draft-board-field"/); // not_connected/error placeholder
});

console.log(`\nEdit Pin composer: ${passed} passed, 0 failed`);
