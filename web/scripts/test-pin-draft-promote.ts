/**
 * Unit tests for the v41 Creative-Intelligence promoted columns (A3).
 * Run: npx tsx scripts/test-pin-draft-promote.ts   (from web/)
 *
 * Covers building pin_drafts.{image_analysis, recommended_keywords, creative_selections}
 * from a PinDraft payload: nesting, empty→null, undefined stripping, and the exact
 * key set stripped on the missing-column fallback.
 */

import assert from "node:assert";
import {
  buildImageAnalysis,
  buildRecommendedKeywords,
  buildCreativeSelections,
  buildPromotedColumns,
  PROMOTED_COLUMN_KEYS,
} from "../src/app/api/pin-drafts/promote";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

test("image_analysis: nests the flat analysis fields", () => {
  const col = buildImageAnalysis({
    imageSummary: "a cozy living room",
    visibleObjects: ["sofa", "lamp"],
    colors: ["beige"],
    style: "mid-century",
    ocrText: "",
    imageCategory: "home_decor",
    imageAnalysisModel: "gpt-x",
    imageAnalysisUpdatedAt: "2026-07-11T00:00:00.000Z",
    imageAnalysisStatus: "ready",
  });
  assert.ok(col);
  assert.equal(col!.summary, "a cozy living room");
  assert.deepEqual(col!.objects, ["sofa", "lamp"]);
  assert.equal(col!.category, "home_decor");
  assert.equal(col!.model, "gpt-x");
  assert.equal(col!.status, "ready");
  // "" ocr is a present string → kept; undefined keys are stripped.
  assert.equal(col!.ocr, "");
});

test("image_analysis: all-empty payload → null", () => {
  assert.equal(buildImageAnalysis({}), null);
  assert.equal(buildImageAnalysis({ imageSummary: "", visibleObjects: [], colors: [], style: "" }), null);
});

test("image_analysis: strips undefined keys but keeps a present status", () => {
  const col = buildImageAnalysis({ imageAnalysisStatus: "pending" });
  assert.ok(col);
  assert.deepEqual(Object.keys(col!), ["status"]);
  assert.equal(col!.status, "pending");
});

test("recommended_keywords: array kept, empty/absent → null", () => {
  assert.deepEqual(buildRecommendedKeywords({ recommendedKeywords: ["boho decor", "wall art"] }), ["boho decor", "wall art"]);
  assert.equal(buildRecommendedKeywords({ recommendedKeywords: [] }), null);
  assert.equal(buildRecommendedKeywords({}), null);
});

test("creative_selections: object kept + cleaned, empty → null", () => {
  const col = buildCreativeSelections({
    creativeSelections: { selectedDirection: "warm-minimal", removedKeywords: ["cheap"], rejectedReferenceIds: undefined },
  });
  assert.ok(col);
  assert.equal(col!.selectedDirection, "warm-minimal");
  assert.deepEqual(col!.removedKeywords, ["cheap"]);
  assert.ok(!("rejectedReferenceIds" in col!), "undefined keys stripped");
  assert.equal(buildCreativeSelections({ creativeSelections: {} }), null);
  assert.equal(buildCreativeSelections({}), null);
  assert.equal(buildCreativeSelections({ creativeSelections: [] as unknown }), null, "arrays are not selection objects");
});

test("buildPromotedColumns: always returns the three keys", () => {
  const cols = buildPromotedColumns({ recommendedKeywords: ["x"] });
  assert.deepEqual(Object.keys(cols).sort(), ["creative_selections", "image_analysis", "recommended_keywords"]);
  assert.equal(cols.image_analysis, null);
  assert.deepEqual(cols.recommended_keywords, ["x"]);
  assert.equal(cols.creative_selections, null);
});

test("PROMOTED_COLUMN_KEYS matches the column set (used by the missing-column fallback)", () => {
  assert.deepEqual([...PROMOTED_COLUMN_KEYS].sort(), ["creative_selections", "image_analysis", "recommended_keywords"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
