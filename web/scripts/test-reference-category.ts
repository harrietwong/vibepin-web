/**
 * test-reference-category.ts — canonicalizeCategory (P0 reference recommendations).
 *
 * Guards the contract the candidate route depends on: every known synonym lands on one
 * of the four P0 buckets, `dbCategories` follows the CANONICAL (so the split fashion
 * pool is always queried as both `fashion` and `womens-fashion`), and unknown input
 * stays honestly unknown instead of being forced into a wrong bucket.
 */

import assert from "node:assert/strict";
import { canonicalizeCategory, inferP0Category, type P0Canonical } from "../src/lib/studio/referenceCategory";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const FASHION_DB = ["fashion", "womens-fashion"];

test("the four P0 names map to themselves", () => {
  const p0: P0Canonical[] = ["fashion", "home-decor", "beauty", "digital-products"];
  for (const name of p0) {
    assert.equal(canonicalizeCategory(name).canonical, name, `${name} must map to itself`);
  }
  assert.deepEqual(canonicalizeCategory("home-decor").dbCategories, ["home-decor"]);
  assert.deepEqual(canonicalizeCategory("beauty").dbCategories, ["beauty"]);
  assert.deepEqual(canonicalizeCategory("digital-products").dbCategories, ["digital-products"]);
});

test("womens-fashion merges into fashion and queries BOTH db categories", () => {
  const r = canonicalizeCategory("womens-fashion");
  assert.equal(r.canonical, "fashion");
  assert.deepEqual(r.dbCategories, FASHION_DB);
  // The bare `fashion` input must read the same merged pool.
  assert.deepEqual(canonicalizeCategory("fashion").dbCategories, FASHION_DB);
});

test("home / interiors synonyms map to home-decor", () => {
  for (const raw of [
    "lifestyle", "kitchen", "furniture", "garden",
    "living-room", "bedroom", "home", "interior", "home-decoration",
  ]) {
    assert.equal(canonicalizeCategory(raw).canonical, "home-decor", `${raw} -> home-decor`);
    assert.deepEqual(canonicalizeCategory(raw).dbCategories, ["home-decor"]);
  }
});

test("apparel / accessories synonyms map to fashion (with the merged db pool)", () => {
  for (const raw of [
    "jewelry", "jewellery", "accessories", "shoes", "bags",
    "mens-fashion", "clothing", "apparel", "outfit", "outfits",
  ]) {
    const r = canonicalizeCategory(raw);
    assert.equal(r.canonical, "fashion", `${raw} -> fashion`);
    // dbCategories follows the canonical, not the raw token.
    assert.deepEqual(r.dbCategories, FASHION_DB, `${raw} must query both fashion pools`);
  }
});

test("beauty synonyms map to beauty", () => {
  for (const raw of ["nails", "hair", "skincare", "makeup", "cosmetics", "beauty-products"]) {
    assert.equal(canonicalizeCategory(raw).canonical, "beauty", `${raw} -> beauty`);
    assert.deepEqual(canonicalizeCategory(raw).dbCategories, ["beauty"]);
  }
});

test("digital / info-product synonyms map to digital-products", () => {
  for (const raw of [
    "marketing", "business", "technology", "education", "printables",
    "digital", "templates", "digital-marketing", "social-media",
  ]) {
    assert.equal(canonicalizeCategory(raw).canonical, "digital-products", `${raw} -> digital-products`);
    assert.deepEqual(canonicalizeCategory(raw).dbCategories, ["digital-products"]);
  }
});

test("normalizes case, surrounding/inner whitespace and underscores", () => {
  assert.equal(canonicalizeCategory("  Home Decor ").canonical, "home-decor");
  assert.equal(canonicalizeCategory("HOME_DECOR").canonical, "home-decor");
  assert.equal(canonicalizeCategory("Womens_Fashion").canonical, "fashion");
  assert.equal(canonicalizeCategory("Living Room").canonical, "home-decor");
  assert.equal(canonicalizeCategory("Digital Products").canonical, "digital-products");
  assert.equal(canonicalizeCategory("SocialMedia").canonical, null, "no fuzzy matching");
  assert.deepEqual(canonicalizeCategory("Womens  fashion").dbCategories, FASHION_DB);
});

test("unknown / empty / non-string input is honestly unknown", () => {
  for (const raw of ["pets", "travel", "food", "", "   ", "---"]) {
    assert.deepEqual(
      canonicalizeCategory(raw),
      { canonical: null, dbCategories: [] },
      `${JSON.stringify(raw)} must not be forced into a bucket`,
    );
  }
  assert.deepEqual(canonicalizeCategory(null), { canonical: null, dbCategories: [] });
  assert.deepEqual(canonicalizeCategory(undefined), { canonical: null, dbCategories: [] });
});

test("dbCategories is a fresh array (callers may mutate it for .in())", () => {
  const a = canonicalizeCategory("jewelry").dbCategories;
  a.push("mutated");
  assert.deepEqual(canonicalizeCategory("jewelry").dbCategories, FASHION_DB, "shared array leaked");
});

test("inferP0Category: two independent keyword hits are required (a lone word never pins a pool)", () => {
  // "blush" alone is a beauty keyword; a bouquet listing must not become nail/hair inspiration.
  assert.equal(inferP0Category("Blush Rose Bridal Bouquet romantic ivory ribbon"), undefined);
  // "art" (home-decor) + "nail" (beauty): one hit each, no winner.
  assert.equal(inferP0Category("nail art"), undefined);
  assert.equal(inferP0Category(""), undefined);
});

test("inferP0Category: a genuine two-hit text still resolves", () => {
  assert.equal(inferP0Category("cozy bedroom decor"), "home-decor");
  assert.equal(inferP0Category("Almond press-on nails manicure"), "beauty");
  assert.equal(inferP0Category("Notion weekly planner template"), "digital-products");
  assert.equal(inferP0Category("summer outfit ideas with sunglasses"), "fashion");
});

console.log(`\n${passed} reference-category tests passed.`);
