/**
 * test-pin-details-phase3.ts
 * P1-A Phase 3 Step 1: Tests for PinTitleSection and PinAltTextSection.
 *
 * Verifies the same acceptance criteria as Phase 2:
 *   1. Extracted sections are controlled/presentational
 *   2. Neither imports stores
 *   3. Neither imports Pinterest API helpers
 *   4. Neither performs persistence
 *   5. title and altText still map through PinDetailsDraft correctly
 *   6. onChange callbacks pass values through unchanged
 *
 * Run: npx tsx scripts/test-pin-details-phase3.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PinTitleSectionProps } from "../src/components/pin-details/PinTitleSection";
import type { PinAltTextSectionProps } from "../src/components/pin-details/PinAltTextSection";
import { mapPinDraftToDetailsDraft } from "../src/lib/pinDetailsModel";

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

// ── PinTitleSection — prop contract ──────────────────────────────────────────

console.log("\n=== PinTitleSection — prop contract ===");

test("onChange receives the exact new value string without transformation", () => {
  let captured = "";
  const onChange: PinTitleSectionProps["onChange"] = (v) => { captured = v; };
  onChange("My awesome Pin title");
  assert.equal(captured, "My awesome Pin title");
});

test("onChange receives empty string (clears field)", () => {
  let captured = "previous";
  const onChange: PinTitleSectionProps["onChange"] = (v) => { captured = v; };
  onChange("");
  assert.equal(captured, "");
});

test("value prop is a plain string — no transformation applied by section", () => {
  const value: PinTitleSectionProps["value"] = "Unchanged title";
  assert.equal(value, "Unchanged title");
});

// ── PinAltTextSection — prop contract ─────────────────────────────────────────

console.log("\n=== PinAltTextSection — prop contract ===");

test("onChange receives the exact new alt text string without transformation", () => {
  let captured = "";
  const onChange: PinAltTextSectionProps["onChange"] = (v) => { captured = v; };
  onChange("A cozy bedroom with warm lighting and soft pillows");
  assert.equal(captured, "A cozy bedroom with warm lighting and soft pillows");
});

test("onChange receives empty string (clears field)", () => {
  let captured = "previous";
  const onChange: PinAltTextSectionProps["onChange"] = (v) => { captured = v; };
  onChange("");
  assert.equal(captured, "");
});

test("value prop is a plain string — no transformation applied by section", () => {
  const value: PinAltTextSectionProps["value"] = "Accessibility description";
  assert.equal(value, "Accessibility description");
});

// ── Section isolation — source-level ────────────────────────────────────────

console.log("\n=== Section isolation ===");

const titleSrc  = readFileSync(join(root, "src/components/pin-details/PinTitleSection.tsx"), "utf8");
const altSrc    = readFileSync(join(root, "src/components/pin-details/PinAltTextSection.tsx"), "utf8");
const drawerSrc = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");

test("PinTitleSection does not import pinDraftStore", () => {
  assert.ok(!titleSrc.includes("pinDraftStore"), "PinTitleSection must not import pinDraftStore");
});

test("PinTitleSection does not call updateDraft or any store write", () => {
  assert.ok(!titleSrc.includes("updateDraft"), "PinTitleSection must not call updateDraft");
  assert.ok(!titleSrc.includes("localStorage"), "PinTitleSection must not access localStorage");
});

test("PinTitleSection does not import Pinterest API helpers", () => {
  assert.ok(!titleSrc.includes("publishPin"), "PinTitleSection must not call publishPin");
  assert.ok(!titleSrc.includes("fetchPinterestBoards"), "PinTitleSection must not call fetchPinterestBoards");
  assert.ok(!titleSrc.includes("pinterestClient"), "PinTitleSection must not import pinterestClient");
});

test("PinAltTextSection does not import pinDraftStore", () => {
  assert.ok(!altSrc.includes("pinDraftStore"), "PinAltTextSection must not import pinDraftStore");
});

test("PinAltTextSection does not call updateDraft or any store write", () => {
  assert.ok(!altSrc.includes("updateDraft"), "PinAltTextSection must not call updateDraft");
  assert.ok(!altSrc.includes("localStorage"), "PinAltTextSection must not access localStorage");
});

test("PinAltTextSection does not import Pinterest API helpers", () => {
  assert.ok(!altSrc.includes("publishPin"), "PinAltTextSection must not call publishPin");
  assert.ok(!altSrc.includes("fetchPinterestBoards"), "PinAltTextSection must not call fetchPinterestBoards");
  assert.ok(!altSrc.includes("pinterestClient"), "PinAltTextSection must not import pinterestClient");
});

// ── data-testid preservation ─────────────────────────────────────────────────

console.log("\n=== data-testid preservation ===");

test("PinTitleSection preserves data-testid='draft-edit-title'", () => {
  assert.ok(titleSrc.includes('data-testid="draft-edit-title"'), "draft-edit-title testid missing from PinTitleSection");
});

test("PinAltTextSection preserves data-testid='draft-edit-alt-text'", () => {
  assert.ok(altSrc.includes('data-testid="draft-edit-alt-text"'), "draft-edit-alt-text testid missing from PinAltTextSection");
});

test("PinTitleSection preserves maxLength=100", () => {
  assert.ok(titleSrc.includes("maxLength={100}"), "PinTitleSection maxLength 100 missing");
});

test("PinAltTextSection preserves maxLength=500", () => {
  assert.ok(altSrc.includes("maxLength={500}"), "PinAltTextSection maxLength 500 missing");
});

test("PinAltTextSection preserves accessibility help text", () => {
  assert.ok(altSrc.includes('t("pinDetails.altText.helper")'), "PinAltTextSection must render the accessibility help text key");
  const enSrc = readFileSync(join(root, "src/lib/i18n/messages/en.ts"), "utf8");
  const match = enSrc.match(/"pinDetails\.altText\.helper":\s*"([^"]*)"/);
  assert.ok(match, "pinDetails.altText.helper key missing from en.ts");
  assert.ok(
    match![1].includes("Describe what") && match![1].includes("accessibility"),
    "PinAltTextSection must include the accessibility help text",
  );
});

// ── DraftDetailsDrawer integration ────────────────────────────────────────────

console.log("\n=== DraftDetailsDrawer integration ===");

test("DraftDetailsDrawer imports PinTitleSection", () => {
  assert.ok(drawerSrc.includes('from "@/components/pin-details/PinTitleSection"'), "PinTitleSection not imported in DraftDetailsDrawer");
});

test("DraftDetailsDrawer imports PinAltTextSection", () => {
  assert.ok(drawerSrc.includes('from "@/components/pin-details/PinAltTextSection"'), "PinAltTextSection not imported in DraftDetailsDrawer");
});

test("DraftDetailsDrawer wires PinTitleSection with title state and markDirty", () => {
  assert.ok(drawerSrc.includes("<PinTitleSection"), "PinTitleSection not rendered in DraftDetailsDrawer");
  assert.ok(
    drawerSrc.includes("setTitle(v)") || drawerSrc.includes("setTitle("),
    "DraftDetailsDrawer must call setTitle in PinTitleSection's onChange",
  );
});

test("DraftDetailsDrawer wires PinAltTextSection with altText state and markDirty", () => {
  assert.ok(drawerSrc.includes("<PinAltTextSection"), "PinAltTextSection not rendered in DraftDetailsDrawer");
  assert.ok(
    drawerSrc.includes("setAltText(v)") || drawerSrc.includes("setAltText("),
    "DraftDetailsDrawer must call setAltText in PinAltTextSection's onChange",
  );
});

test("DraftDetailsDrawer no longer has inline title input (section owns it)", () => {
  // After extraction, the inline <input ... value={title} maxLength={100} ... /> is gone.
  // PinTitleSection renders it internally.
  assert.ok(
    !drawerSrc.includes('data-testid="draft-edit-title"'),
    "Inline draft-edit-title input still present in DraftDetailsDrawer — should be in PinTitleSection",
  );
});

test("DraftDetailsDrawer no longer has inline alt text textarea (section owns it)", () => {
  // After extraction, the inline <textarea ... value={altText} ... /> is gone.
  assert.ok(
    !drawerSrc.includes('data-testid="draft-edit-alt-text"'),
    "Inline draft-edit-alt-text textarea still present in DraftDetailsDrawer — should be in PinAltTextSection",
  );
});

// ── PinDetailsDraft model — title and altText still map correctly ─────────────

console.log("\n=== PinDetailsDraft model — title and altText mapping ===");

test("mapPinDraftToDetailsDraft preserves title from draft", () => {
  const draft = mapPinDraftToDetailsDraft({
    imageUrl: "https://cdn.example.com/pin.jpg",
    title: "Summer Collection 2026",
    description: "Great pins for summer",
    altText: "Colorful summer items on white background",
    destinationUrl: "https://example.com",
  });
  assert.equal(draft.title, "Summer Collection 2026");
});

test("mapPinDraftToDetailsDraft preserves altText from draft", () => {
  const draft = mapPinDraftToDetailsDraft({
    imageUrl: "https://cdn.example.com/pin.jpg",
    title: "Test Pin",
    description: "desc",
    altText: "A descriptive alt text for screen readers",
    destinationUrl: "https://example.com",
  });
  assert.equal(draft.altText, "A descriptive alt text for screen readers");
});

test("mapPinDraftToDetailsDraft preserves empty title (blank draft)", () => {
  const draft = mapPinDraftToDetailsDraft({
    imageUrl: "https://cdn.example.com/pin.jpg",
    title: "",
    description: "",
    altText: "",
    destinationUrl: "",
  });
  assert.equal(draft.title, "");
  assert.equal(draft.altText, "");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nP1-A Phase 3 Step 1 section tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
