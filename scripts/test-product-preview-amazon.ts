/**
 * test-product-preview-amazon.ts 鈥?Create Pins product-selection UX:
 *   Part 1 product preview, Part 2 context bar, Part 3 Amazon Product Ideas filter.
 *
 * Run: npx tsx scripts/test-product-preview-amazon.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const asset = (over: Record<string, unknown> = {}) => ({
  id: Math.random().toString(36).slice(2), role: "product" as const, source: "url" as const,
  imageUrl: "https://cdn/p.jpg", createdAt: "2026-06-01", lastUsedAt: "2026-06-01",
  ...over,
});

async function main() {
  const { toPreviewProduct, previewSourceLabel, asinForAsset } = await import("../src/lib/studio/productPreview");

  // 鈹€鈹€ Pure preview helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  test("previewSourceLabel: Amazon products read 'Amazon'", () => {
    assert.equal(previewSourceLabel(asset({ productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }) as never), "Amazon");
  });
  test("previewSourceLabel: non-Amazon keeps its source label", () => {
    assert.equal(previewSourceLabel(asset({ source: "upload", imageUrl: "data:image/png;base64,x" }) as never), "Uploaded");
    assert.equal(previewSourceLabel(asset({ source: "product_ideas", productUrl: "https://etsy.com/x" }) as never), "Product Ideas");
  });
  test("asinForAsset: extracts ASIN from amazon /dp/ URL, null otherwise", () => {
    assert.equal(asinForAsset(asset({ productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }) as never), "B08N5WRWNW");
    assert.equal(asinForAsset(asset({ canonicalUrl: "https://www.amazon.com/gp/product/B07XYZ1234" }) as never), "B07XYZ1234");
    assert.equal(asinForAsset(asset({ productUrl: "https://etsy.com/listing/9" }) as never), null);
  });
  test("toPreviewProduct: Amazon product carries label + ASIN; non-Amazon has null ASIN", () => {
    const amazon = toPreviewProduct(asset({ title: "Lamp", productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }) as never);
    assert.equal(amazon.sourceLabel, "Amazon");
    assert.equal(amazon.asin, "B08N5WRWNW");
    assert.equal(amazon.title, "Lamp");
    const etsy = toPreviewProduct(asset({ title: "Vase", productUrl: "https://etsy.com/x" }) as never);
    assert.equal(etsy.asin, null);
    assert.notEqual(etsy.sourceLabel, "Amazon");
  });

  // 鈹€鈹€ Part 2: context bar (no green status box) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const studioSource = readFileSync("src/app/app/studio/page.tsx", "utf8");
  test("Part2: no green 'Amazon affiliate destination ready' status box", () => {
    assert.doesNotMatch(studioSource, /Amazon affiliate destination ready/);
    assert.doesNotMatch(studioSource, /data-testid="cp-affiliate-status"/);
    // No green ready tint on the locked context bar.
    assert.doesNotMatch(studioSource, /background: ready \? "rgba\(16,185,129/);
  });
  test("Part2: lower 'Generating Pins for' product card removed (products live only in top section)", () => {
    assert.doesNotMatch(studioSource, /Generating Pins for/);
    assert.doesNotMatch(studioSource, /data-testid="cp-affiliate-destination"/);
    assert.doesNotMatch(studioSource, /data-testid="cp-affiliate-change"/);
    assert.doesNotMatch(studioSource, /data-testid="cp-affiliate-context"/);
  });

  // 鈹€鈹€ Part 1: preview component 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const previewSource = readFileSync("src/components/studio/ProductPreview.tsx", "utf8");
  test("Part1: hover popover shows large image + Use for Pins", () => {
    assert.match(previewSource, /data-testid="product-preview-popover"/);
    assert.match(previewSource, /data-testid="product-preview-image"/);
    assert.match(previewSource, /data-testid="product-preview-use"/);
    assert.match(previewSource, />\s*Use for Pins\s*</);
  });
  test("Part1: click modal is zoomable with 'Use this product'", () => {
    assert.match(previewSource, /data-testid="product-preview-modal"/);
    assert.match(previewSource, /data-testid="product-preview-modal-image"/);
    assert.match(previewSource, /data-testid="product-preview-modal-zoom"/);
    assert.match(previewSource, />\s*Use this product\s*</);
  });
  test("Part1: popover surfaces source label + ASIN", () => {
    assert.match(previewSource, /data-testid="product-preview-source"/);
    assert.match(previewSource, /data-testid="product-preview-asin"/);
  });

  // Part 3: Amazon is an internal Product Ideas filter, not a top-level tab.
  const pickerSource = readFileSync("src/components/studio/InlineCreateAssetPicker.tsx", "utf8");
  const productIdeasSource = readFileSync("src/lib/productIdeas.ts", "utf8");
  test("Part3: product picker has no Amazon top-level tab", () => {
    assert.doesNotMatch(pickerSource, /\{ id: "amazon", label: "Amazon" \}/);
    assert.doesNotMatch(pickerSource, /productTab === "amazon"/);
    assert.doesNotMatch(pickerSource, /data-testid="amazon-products-grid"/);
  });
  test("Part3: Product Ideas exposes Amazon as a separate source filter", () => {
    assert.match(productIdeasSource, /"Amazon"/);
    assert.match(productIdeasSource, /sourceLabel === "Amazon"/);
    assert.match(productIdeasSource, /isAmazonProductIdea/);
    assert.match(pickerSource, /PRODUCT_IDEA_SOURCE_FILTERS/);
    assert.match(pickerSource, /PRODUCT_IDEA_PICKER_CATEGORIES/);
    assert.match(pickerSource, /product-ideas-source-filters/);
    assert.match(pickerSource, /product-ideas-category-filters/);
  });
  test("Part3: Amazon inventory records are labeled inside Product Ideas", () => {
    assert.match(pickerSource, /isAmazonProductIdea\(product\)/);
    assert.match(pickerSource, /label=\{isAmazon \? "Amazon" : "Product Ideas"\}/);
  });
  test("Part3: cards are wrapped in the hover preview", () => {
    assert.match(pickerSource, /<ProductHoverPreview/);
    assert.match(pickerSource, /import \{ ProductHoverPreview \}/);
  });
  test("Part3: saved-product preview can still choose one product directly", () => {
    assert.match(pickerSource, /function chooseProductForPins\(item: assets\.AssetItem\)/);
    assert.match(pickerSource, /onConfirm\(\[\{ id: item\.id/);
  });
  test("Part3: Product Ideas keeps multi-select Add Selected flow", () => {
    assert.match(pickerSource, /onToggleProduct\(product\)/);
    assert.match(pickerSource, /data-testid="asset-picker-confirm"/);
    assert.match(pickerSource, /!disabled && !hideCheckbox/);
  });

  console.log(`\nProduct preview + Amazon picker: ${passed} passed, 0 failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
