import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(process.cwd(), "src", path), "utf8");
const picker = src("components/studio/InlineCreateAssetPicker.tsx");
const image = src("components/products/ProductImageSurface.tsx");
const catalog = src("components/products/ProductOpportunitiesV1.tsx");
const client = src("lib/productOpportunitiesClient.ts");
const pickerSource = src("lib/useProductIdeas.ts");
const taxonomy = src("lib/myProductsPicker.ts");
const listRoute = src("app/api/product-opportunities/route.ts");
const detailRoute = src("app/api/product-opportunities/[id]/route.ts");
const savedRoute = src("app/api/saved-product-opportunities/route.ts");

let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`  OK ${name}`);
}

test("PO90-01 uses one neutral fallback for missing, decode, tiny, and unsupported images", () => {
  for (const state of ["missing", "decode_failed", "tiny", "unsupported"]) assert.match(image, new RegExp(`\\b${state}\\b`));
  assert.match(image, /background: "#202631"/);
  assert.match(image, /naturalWidth < minEdge \|\| image\.naturalHeight < minEdge/);
  assert.match(image, /image\.decode\(\)/);
  assert.match(image, /10_000/);
  assert.match(picker, /ProductImageSurface/);
  assert.match(catalog, /ProductImageSurface/);
  assert.doesNotMatch(picker, /currentTarget\.style\.opacity = "0\.3"/);
});

test("PO90-01a resets image state by keyed source remount without effect state synchronization", () => {
  assert.match(image, /function productImageRenderKey/);
  assert.match(image, /<ProductImageForSource key=\{productImageRenderKey\(source\)\}/);
  assert.match(image, /useState<ProductImageState>\(\(\) => initialProductImageState\(src\)\)/);
  assert.doesNotMatch(image, /useEffect\(\(\) => \{[\s\S]*?loadSequence\.current \+= 1;[\s\S]*?setState\(initialProductImageState\(src\)\)/);
});

test("PO90-02 exposes only My Products and Product inspiration as primary product tabs", () => {
  const tabs = picker.slice(picker.indexOf("export const PRODUCT_PICKER_TABS"), picker.indexOf("export const REFERENCE_PICKER_TABS"));
  assert.equal((tabs.match(/id:/g) ?? []).length, 2);
  assert.match(tabs, /my_products/);
  assert.match(tabs, /product_ideas/);
  assert.doesNotMatch(tabs, /upload|url|amazon|shopify/i);
  assert.match(picker, /compact-upload-product/);
  assert.match(picker, /compact-import-url/);
});

test("PO90-03 replaces internal source words with user-facing origin labels", () => {
  assert.match(taxonomy, /Uploaded product image/);
  assert.match(taxonomy, /Imported from link/);
  assert.match(taxonomy, /VibePin product opportunity/);
  assert.match(taxonomy, /return "My product"/);
  assert.doesNotMatch(taxonomy, /return "Recent"/);
});

test("PO90-04 Product inspiration reads only the canonical Product Opportunities API", () => {
  assert.match(pickerSource, /fetchProductOpportunities/);
  assert.match(pickerSource, /product_opportunity_catalog_v1/);
  assert.doesNotMatch(pickerSource, /api\/products\/top|pin_products|supabase\.from|from\("pin_products"\)/);
  assert.match(pickerSource, /errorRetryCount: 0/);
  assert.match(pickerSource, /shouldRetryOnError: false/);
});

test("PO90-05 error states preserve safe request evidence and an explicit retry", () => {
  for (const field of ["method", "path", "status", "code", "requestId", "occurredAt", "runtime", "deployment"]) assert.match(client, new RegExp(`\\b${field}\\b`));
  assert.match(picker, /product-ideas-error-evidence/);
  assert.match(picker, /product-ideas-retry/);
  assert.match(catalog, /product-error-evidence/);
});

test("PO90-06 API errors use stable codes and request IDs", () => {
  assert.match(listRoute, /AUTH_REQUIRED/);
  assert.match(listRoute, /METRIC_FILTER_NOT_READY/);
  assert.match(listRoute, /CATALOG_UNAVAILABLE/);
  assert.match(detailRoute, /PRODUCT_NOT_FOUND/);
  assert.match(savedRoute, /productApiError/);
  assert.match(savedRoute, /productApiSuccess/);
});

test("PO90-07 catalog, saved, and picker expose the same provenance language", () => {
  assert.match(catalog, /VibePin product opportunity/);
  assert.match(catalog, /Product Pin evidence/);
  assert.match(catalog, /Source Pin evidence/);
  assert.match(catalog, /Updated/);
  assert.match(picker, /VibePin product opportunity/);
});

test("PO90-08 picker remains fluid at desktop and 390px widths", () => {
  assert.match(picker, /minWidth: 0/);
  assert.match(picker, /repeat\(auto-fill,minmax\(150px,1fr\)\)/);
  assert.doesNotMatch(picker, /width:\s*["'](?:4\d\d|[5-9]\d\d)px/);
});

console.log(`\n0901 Product Picker PRD: ${passed} passed, 0 failed`);
