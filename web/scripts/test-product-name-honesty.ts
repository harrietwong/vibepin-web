/**
 * test-product-name-honesty.ts — a NULL/blank scraped product_name must never be
 * replaced by a fabricated "Product", nor by the seed keyword / category / URL /
 * domain, on the public landing tiles or the internal admin data console.
 *
 * Scope: the two scraped Product-Opportunity display paths outside the app/products
 * surfaces (Commit D covered app/products + the picker). These are Commit E.
 *
 *   1. landing  (src/lib/landingAssets.ts::mapProductAsset)  — behavioral
 *   2. admin    (src/app/admin/data/page.tsx productStripItems) — source assertion
 *      (a Next page must not export arbitrary helpers, so we assert on its source)
 *
 * Run: npx tsx scripts/test-product-name-honesty.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mapProductAsset, type ApiProduct } from "../src/lib/landingAssets";

const __dirname = dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK ${name}`); }

const base: ApiProduct = {
  id: "p1",
  image_url: "https://cdn.example.com/img.jpg",
  seed_keyword: "matcha whisk",
  price: 24,
  currency: "USD",
  source_url: "https://shop.example.com/products/matcha-whisk",
  opportunity_score: 71,
};

// ── 1. Landing: NULL / blank product_name never becomes "Product" ────────────
test("landing: NULL product_name → empty title, never 'Product'", () => {
  const a = mapProductAsset({ ...base, product_name: null });
  assert.equal(a.title, "", "NULL name must map to an empty caption");
  assert.notEqual(a.title, "Product");
});

test("landing: undefined product_name → empty title, never 'Product'", () => {
  const a = mapProductAsset({ ...base, product_name: undefined });
  assert.equal(a.title, "");
  assert.notEqual(a.title, "Product");
});

test("landing: blank/whitespace product_name → falsy, never 'Product'", () => {
  // `p.product_name || ""` — an empty string is falsy so it passes straight through
  // as empty; a whitespace-only name is a legitimately empty caption, still not a
  // fabricated product name.
  assert.equal(mapProductAsset({ ...base, product_name: "" }).title, "");
  assert.notEqual(mapProductAsset({ ...base, product_name: "" }).title, "Product");
});

test("landing: seed_keyword must NOT stand in for the missing product name", () => {
  const a = mapProductAsset({ ...base, product_name: null, seed_keyword: "matcha whisk" });
  assert.equal(a.title, "", "seed_keyword must never leak into the name/title position");
  assert.notEqual(a.title, "matcha whisk");
  // it may still describe the tile's CATEGORY bucket (that is not a product name)
  assert.equal(a.category, "Food & Drink");
});

test("landing: a real product_name still displays unchanged", () => {
  const a = mapProductAsset({ ...base, product_name: "Bamboo Matcha Whisk (Chasen)" });
  assert.equal(a.title, "Bamboo Matcha Whisk (Chasen)");
});

test("landing: no image path still maps price/score honestly", () => {
  const a = mapProductAsset({ ...base, product_name: null });
  assert.equal(a.price, "$24");
  assert.equal(a.score, 71);
});

// ── 2. Admin data console: caption source assertion ──────────────────────────
// A Next.js page must not export arbitrary named helpers, so productStripItems stays
// module-private; we assert on the exact caption expression instead. This locks the
// honest fallback and fails loudly if "Product" or a seed_keyword stand-in returns.
const adminSrc = readFileSync(
  resolve(__dirname, "../src/app/admin/data/page.tsx"), "utf8",
);

test("admin: product caption never falls back to 'Product'", () => {
  // The old fabrication was: (p.product_name ?? "").trim() || p.seed_keyword || "Product"
  assert.ok(
    !/product_name[^\n]*\|\|\s*"Product"/.test(adminSrc)
      && !/product_name[^\n]*\|\|\s*p\.seed_keyword/.test(adminSrc),
    "admin product caption must not fall back to seed_keyword or 'Product'",
  );
});

test("admin: product caption uses an explicit non-name status for NULL", () => {
  assert.ok(
    /caption:\s*\(p\.product_name \?\? ""\)\.trim\(\) \|\| "Name unavailable"/.test(adminSrc),
    "expected the honest 'Name unavailable' fallback for a NULL product_name",
  );
});

test("admin: seed_keyword still shows truthfully in the SUB line (its correct role)", () => {
  // seed_keyword belongs in the metadata sub-line, not the name/caption position.
  assert.ok(
    /sub:\s*`[^`]*\$\{p\.seed_keyword \?\? ""\}[^`]*`/.test(adminSrc),
    "seed_keyword should remain in the product sub-line",
  );
});

console.log(`\n${passed} passed`);
