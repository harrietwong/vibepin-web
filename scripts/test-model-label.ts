/**
 * test-model-label.ts — the Pin card must show the real generation model, never a
 * hardcoded string. Covers resolveModelLabel + the sites that render the label.
 *
 * Run: npx tsx scripts/test-model-label.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveModelLabel, MODEL_KEY_TO_LABEL, DEFAULT_MODEL_LABEL } from "../src/lib/studio/modelLabel";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK ${name}`); }

// ── resolver ────────────────────────────────────────────────────────────────
test("prefers a valid stored display model", () => {
  assert.equal(resolveModelLabel("Gemini Image", "gemini_image"), "Gemini Image");
  assert.equal(resolveModelLabel("GPT Image", "gpt_image"), "GPT Image");
});
test("selecting Gemini → 'Gemini Image'; selecting GPT → 'GPT Image'", () => {
  assert.equal(resolveModelLabel(undefined, "gemini_image"), "Gemini Image");
  assert.equal(resolveModelLabel(undefined, "gpt_image"), "GPT Image");
});
test("ignores the stale hardcoded 'GPT Image 2' and derives from modelKey", () => {
  assert.equal(resolveModelLabel("GPT Image 2", "gemini_image"), "Gemini Image");
  assert.equal(resolveModelLabel("GPT Image 2", "gpt_image"), "GPT Image");
});
test("legacy nano_banana key maps to Gemini Image", () => {
  assert.equal(resolveModelLabel(undefined, "nano_banana"), "Gemini Image");
});
test("empty / missing metadata falls back to the MVP default", () => {
  assert.equal(resolveModelLabel("", ""), DEFAULT_MODEL_LABEL);
  assert.equal(resolveModelLabel(undefined, undefined), "Gemini Image");
});
test("MODEL_KEY_TO_LABEL matches the selector options", () => {
  assert.equal(MODEL_KEY_TO_LABEL.gpt_image, "GPT Image");
  assert.equal(MODEL_KEY_TO_LABEL.gemini_image, "Gemini Image");
});

// ── no hardcoded model in the render sites ─────────────────────────────────
const studio = readFileSync("src/app/app/studio/page.tsx", "utf8");
const pinDetails = readFileSync("src/components/studio/pinDetails.ts", "utf8");
const handoff = readFileSync("src/lib/weeklyPlanHandoff.ts", "utf8");

test("historyEntryToSession derives the model from real snapshot metadata", () => {
  assert.match(studio, /model:\s*resolveModelLabel\(entry\.setupSnapshot\?\.model, entry\.setupSnapshot\?\.modelKey\)/);
  assert.doesNotMatch(studio, /model:\s*"GPT Image 2"/);
});
test("pinDetails + handoff no longer hardcode a model label", () => {
  assert.doesNotMatch(pinDetails, /"GPT Image 2"/);
  assert.doesNotMatch(handoff, /"GPT Image 2"/);
  assert.match(pinDetails, /resolveModelLabel/);
  assert.match(handoff, /resolveModelLabel/);
});
test("the only 'GPT Image 2' string is the guard constant in modelLabel.ts", () => {
  const label = readFileSync("src/lib/studio/modelLabel.ts", "utf8");
  assert.match(label, /STALE_MODEL_LABEL = "GPT Image 2"/);
});

console.log(`\nModel label consistency: ${passed} passed, 0 failed`);
