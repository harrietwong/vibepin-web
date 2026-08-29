/**
 * Product Opportunities v3.7 compatibility boundary.
 *
 * The old Product Opportunity Finder exposed percentile Demand, keyword Trend,
 * Competition, and Opportunity Score conclusions. v3.7 replaces that surface
 * with the evidence-safe catalog. This test keeps the route handoff, family
 * filters, Saved Products, and Create Pin actions honest while preventing the
 * legacy endpoint from reintroducing retired conclusions.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)),
  "utf8",
);

const page = read("../src/app/app/products/page.tsx");
const catalog = read("../src/components/products/ProductOpportunitiesV1.tsx");
const legacyApi = read("../src/app/api/products/top/route.ts");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

test("Products route mounts the v3.7 catalog, not the legacy finder", () => {
  assert.match(page, /<ProductOpportunitiesV1\s*\/>/);
  assert.doesNotMatch(page, /useProductIdeas|productOpportunityCounts|ProductOpportunityPicker/);
});

test("Physical and Digital remain separate catalog filters", () => {
  assert.match(catalog, /type Family = "all" \| "physical" \| "digital"/);
  assert.match(catalog, /\["all", "physical", "digital"\]/);
  assert.match(catalog, /productFamily === family/);
});

test("Save and Create Pin are separate explicit actions", () => {
  assert.match(catalog, /setProductOpportunitySaved\(item\.id, next\)/);
  assert.match(catalog, /const createPin = useCallback\(async \(item: ProductOpportunityItem\) =>/);
  assert.match(catalog, /openCreatePinsWithDraft/);
  assert.match(catalog, />Create Pin<\/button>/);
  assert.match(catalog, /saved \? "Saved" : "Save"/);
  assert.doesNotMatch(catalog, /setProductOpportunitySaved\([^)]*\)[\s\S]{0,200}createPin\(/);
});

test("Saved Products has a dedicated entry and history surface", () => {
  assert.match(catalog, /href=\{mode === "saved" \? "\/app\/products" : "\/app\/products\/saved"\}/);
  assert.match(catalog, /fetchSavedProductOpportunities\(\)/);
  assert.match(catalog, /SavedPlaceholder/);
});

test("Missing product titles are omitted rather than fabricated", () => {
  assert.match(catalog, /\{item\.productName\?\.trim\(\) \? <button[^>]*>\{item\.productName\}<\/button> : null\}/);
  assert.match(catalog, /history\?\.productName\?\.trim\(\) \|\| "Saved item"/);
  assert.doesNotMatch(catalog, /history\?\.productName\?\.trim\(\) \|\| history\?\.(?:merchant|domain)/);
  assert.doesNotMatch(catalog, /productName\s*\|\|\s*["']Product["']/);
  assert.doesNotMatch(catalog, /productName\s*\?\?\s*["']Product["']/);
});

test("Legacy picker API exposes evidence inventory only, never retired scores", () => {
  assert.doesNotMatch(
    legacyApi,
    /public_metrics|opportunity_score:|trend_score:|save_velocity_score:|competition_score:|latestDemandUpdatedAt|latestCompetitionUpdatedAt|latestScoreUpdatedAt/,
  );
  assert.match(legacyApi, /deriveProductSaveCount/);
});

test("Catalog does not render internal lifecycle/status vocabulary", () => {
  for (const internal of ["retired", "inactive", "unavailable", "insufficient_signal"]) {
    assert.equal(catalog.includes(`>${internal}<`), false, internal);
    assert.equal(catalog.includes(`"${internal}"`), false, internal);
  }
});

test("Catalog is isolated from Pin Ideas and legacy scoring helpers", () => {
  assert.doesNotMatch(catalog, /useProductIdeas|fetchInspirationPins|productOpportunityCounts/);
  assert.doesNotMatch(catalog, /opportunity_score|trend_score|competition_score/);
});

console.log(`\nProduct Opportunities v3.7 compatibility: ${passed} passed, 0 failed`);
