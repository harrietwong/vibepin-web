/**
 * test-batch-edit-product-mapping.ts — Batch Edit must resolve the same products
 * the single-Pin edit modal shows. Covers resolveCanonicalPinProducts + the two
 * row mappers (Create Pins + Weekly/Monthly Plan).
 *
 * Run: npx tsx scripts/test-batch-edit-product-mapping.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveCanonicalPinProducts } from "../src/lib/studio/pinProducts";
import type { LinkedProduct } from "../src/lib/pinMetadata";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK ${name}`); }

const lp = (over: Partial<LinkedProduct> = {}): LinkedProduct => ({
  title: "Product", source: "url_imported", linkType: "manual", ...over,
});

// 1. linkedProducts is the post-edit source of truth (matches the modal).
test("linkedProducts: primary follows primaryProductId, rest are tagged (count preserved)", () => {
  const r = resolveCanonicalPinProducts({
    linkedProducts: [lp({ productId: "a", title: "A" }), lp({ productId: "b", title: "B" }), lp({ productId: "c", title: "C" })],
    primaryProductId: "b",
  });
  assert.equal(r.primary?.productId, "b");
  assert.equal(r.tagged.length, 2);
  assert.equal(1 + r.tagged.length, 3); // count matches the modal's 3 attached
});

test("linkedProducts: no primaryProductId → first is primary", () => {
  const r = resolveCanonicalPinProducts({ linkedProducts: [lp({ productId: "a", title: "A" }), lp({ productId: "b" })] });
  assert.equal(r.primary?.productId, "a");
  assert.equal(r.tagged.length, 1);
});

// 2. metadataDraft products when there are no top-level linkedProducts.
test("metadataDraft primary/tagged used when no linkedProducts", () => {
  const r = resolveCanonicalPinProducts({
    metadataDraft: { primaryProduct: lp({ productId: "m1", title: "Meta" }), taggedProducts: [lp({ productId: "m2" })] } as never,
  });
  assert.equal(r.primary?.productId, "m1");
  assert.equal(r.tagged.length, 1);
});

test("metadataDraft legacy linkedProduct* mirror is resolved", () => {
  const r = resolveCanonicalPinProducts({
    metadataDraft: { linkedProductId: "x", linkedProductTitle: "Legacy", linkedProductUrl: "https://amazon.com/dp/B08N5WRWNW" } as never,
  });
  assert.equal(r.primary?.title, "Legacy");
});

// 3. setupSnapshot.selectedProducts fallback (the modal's fallback source).
test("setupProducts fallback when metadataDraft + linkedProducts empty", () => {
  const r = resolveCanonicalPinProducts({
    setupProducts: [
      { productId: "s1", title: "Chair", imageUrl: "https://cdn/c.jpg", productUrl: "https://www.amazon.com/dp/B08N5WRWNW", source: "amazon" },
      { productId: "s2", title: "Lamp", imageUrl: null },
      { productId: "s3", title: "", imageUrl: null },
    ] as never,
  });
  assert.equal(r.primary?.title, "Chair");
  assert.equal(r.tagged.length, 1); // empty snapshot (s3) filtered out
});

// 4. Amazon affiliate fallback — an affiliate Pin is never blank.
test("affiliate fallback shows an Amazon product when nothing else resolves", () => {
  const r = resolveCanonicalPinProducts({ creatorProductLinkId: "cpl_1", sourceProductImageUrl: "https://cdn/a.jpg" });
  assert.equal(r.primary?.title, "Amazon product");
  assert.equal(r.primary?.imageUrl, "https://cdn/a.jpg");
});

// 5. Priority: linkedProducts wins over metadataDraft + setup.
test("priority: linkedProducts > metadataDraft > setupProducts", () => {
  const r = resolveCanonicalPinProducts({
    linkedProducts: [lp({ productId: "top", title: "Top" })],
    metadataDraft: { primaryProduct: lp({ productId: "meta" }) } as never,
    setupProducts: [{ productId: "setup", title: "Setup", imageUrl: null }] as never,
  });
  assert.equal(r.primary?.productId, "top");
});

// 6. Nothing → empty (optional product; no error, no invented product).
test("no product sources → empty (product is optional)", () => {
  const r = resolveCanonicalPinProducts({});
  assert.equal(r.primary, null);
  assert.equal(r.tagged.length, 0);
});

// ── Both row mappers use the canonical resolver ─────────────────────────────
test("Create Pins + Plan batch mappers use resolveCanonicalPinProducts", () => {
  const studio = readFileSync("src/app/app/studio/page.tsx", "utf8");
  const plan = readFileSync("src/app/app/plan/page.tsx", "utf8");
  assert.match(studio, /resolveCanonicalPinProducts\(\{/);
  assert.match(plan, /resolveCanonicalPinProducts\(\{/);
  // Plan mapper feeds every canonical source (incl. top-level linkedProducts + setup).
  assert.match(plan, /linkedProducts:\s*d\.linkedProducts/);
  assert.match(plan, /setupProducts:\s*d\.setupSnapshot\?\.selectedProducts/);
  // Create Pins mapper feeds session setup + affiliate context.
  assert.match(studio, /setupProducts:\s*sess\.setupSnapshot\?\.selectedProducts/);
});

// ── Product column shows a summary (not "+ Add") when products exist ────────
test("Batch Edit product cell shows summary when products exist, else Add product", () => {
  const batch = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
  // "+ Add product" only in the empty branch (prodCount === 0).
  assert.match(batch, /prodCount === 0 \? \([\s\S]*?Add product/);
  // Non-empty branch renders the primary title + "+N" summary.
  assert.match(batch, /primary\?\.title \?\? "Product"/);
  assert.match(batch, /\+\{prodCount - 1\}/);
});

console.log(`\nBatch Edit product mapping: ${passed} passed, 0 failed`);
