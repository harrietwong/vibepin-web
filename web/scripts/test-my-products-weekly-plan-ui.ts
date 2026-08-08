import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dedupeProductAssets,
  filterMyProducts,
  isBrokenProductImport,
  isValidProductImageUrl,
  visibleProductSourceFilters,
  MY_PRODUCTS_FILTERS,
} from "../src/lib/myProductsPicker";
import type { AssetItem } from "../src/lib/assetStore";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(e as Error).message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const pickerSource = readFileSync(join(process.cwd(), "src/components/studio/InlineCreateAssetPicker.tsx"), "utf8");
const layoutSource = readFileSync(join(process.cwd(), "src/app/app/layout.tsx"), "utf8");

function asset(id: string, source: AssetItem["source"], imageUrl: string, lastUsedAt: string): AssetItem {
  return {
    id, role: "product", source, imageUrl, createdAt: lastUsedAt, lastUsedAt,
  };
}

const sample: AssetItem[] = [
  asset("a1", "upload", "https://cdn.example.com/a.jpg", "2026-06-08T10:00:00Z"),
  asset("a2", "url", "https://cdn.example.com/b.jpg", "2026-06-07T10:00:00Z"),
  asset("a3", "product_ideas", "https://cdn.example.com/c.jpg", "2026-06-06T10:00:00Z"),
  asset("a4", "url", "", "2026-06-05T10:00:00Z"),
  asset("a1", "upload", "https://cdn.example.com/a.jpg", "2026-06-08T10:00:00Z"),
];

test("All filter renders each asset once", () => {
  const out = filterMyProducts(sample, "all", "");
  assert(out.length === 3, `expected 3 healthy unique assets, got ${out.length}`);
  assert(new Set(out.map(i => i.id)).size === out.length, "duplicate ids in all grid");
});

test("Uploaded filter shows only uploaded products", () => {
  const out = filterMyProducts(sample, "uploaded", "");
  assert(out.every(i => i.source === "upload"), "non-upload in uploaded filter");
  assert(out.length === 1, "expected one uploaded");
});

test("URL Imported filter shows only URL imported products", () => {
  const out = filterMyProducts(sample, "url_imported", "");
  assert(out.every(i => i.source === "url"), "non-url in url filter");
  assert(out.length === 1, "broken url should be excluded");
});

// "product_ideas" and "recent" were removed as SOURCE filters (create-pin PRD
// Section C): Product Ideas is a primary tab, and recency is an ordering. Both are
// covered below in their new form.

test("source filters contain neither Product Ideas nor Recent", () => {
  const ids = MY_PRODUCTS_FILTERS.map(f => f.id) as string[];
  assert(!ids.includes("product_ideas"), "Product Ideas must not be a source chip");
  assert(!ids.includes("recent"), "Recent must not be a source chip");
  assert(ids.includes("shopify"), "Shopify must be a source chip");
});

test("Recent is a sort mode and does not duplicate assets", () => {
  const out = filterMyProducts(sample, "all", "", "recently_used");
  assert(new Set(out.map(i => i.id)).size === out.length, "recently_used sort duplicated assets");
});

test("sorts are orthogonal to the source filter", () => {
  const byName = filterMyProducts(sample, "all", "", "name_asc");
  const byUsed = filterMyProducts(sample, "all", "", "recently_used");
  assert(byName.length === byUsed.length, "sorting must not change the result set");
});

test("source chips are hidden when the workspace has no such products", () => {
  const onlyUploads = sample.filter(i => i.source === "upload");
  const ids = visibleProductSourceFilters(onlyUploads).map(f => f.id);
  assert(ids.includes("all"), "All is always shown");
  assert(ids.includes("uploaded"), "uploaded present → chip shown");
  assert(!ids.includes("shopify"), "integration off + no products → no Shopify chip");
});

test("Shopify chip IS shown when the integration is enabled but no products exist yet", () => {
  // Its empty state hosts the connect/import panel — hiding the chip made connecting
  // impossible for exactly the workspace that needs to connect (Codex finding #6).
  const onlyUploads = sample.filter(i => i.source === "upload");
  const ids = visibleProductSourceFilters(onlyUploads, { shopifyEnabled: true }).map(f => f.id);
  assert(ids.includes("shopify"), "an unconnected workspace must be able to reach Connect");
});

test("broken/missing image imports are not in All grid", () => {
  const out = filterMyProducts(sample, "all", "");
  assert(!out.some(isBrokenProductImport), "broken import in all grid");
});

test("Import issues filter shows broken imports only", () => {
  const out = filterMyProducts(sample, "import_issues", "");
  assert(out.length === 1 && isBrokenProductImport(out[0]), "import issues filter failed");
});

test("isValidProductImageUrl rejects empty urls", () => {
  assert(!isValidProductImageUrl(""), "empty url should be invalid");
});

test("dedupeProductAssets keeps first occurrence", () => {
  assert(dedupeProductAssets(sample).length === 4, "dedupe count wrong");
});

test("Import from URL panel can collapse/expand", () => {
  assert(pickerSource.includes("showProductUrlImport"), "showProductUrlImport state missing");
  assert(pickerSource.includes("setShowProductUrlImport(false)"), "collapse after save missing");
  assert(pickerSource.includes("my-products-grid"), "unified grid missing");
  assert(!pickerSource.includes('title="Uploaded Products"'), "legacy uploaded section still present");
});

test("My Products uses filter chips not source sections", () => {
  assert(pickerSource.includes("my-products-filter-chips"), "filter chips missing");
  assert(pickerSource.includes("ProductLibraryCard"), "product library card missing");
});

test("Sidebar nav items render once", () => {
  const ids = [...layoutSource.matchAll(/id: "([^"]+)"/g)]
    .map(m => m[1])
    .filter(id => ["home", "create-pins", "weekly-plan", "my-pins", "opportunities", "keyword-trends", "viral-pins", "product-ideas", "settings"].includes(id));
  assert(new Set(ids).size === ids.length, "duplicate nav ids in NAV_ITEMS");
  assert((layoutSource.match(/labelKey: "nav.keywordTrends"/g) ?? []).length === 1, "duplicate Keyword Trends nav label");
});

console.log(`\nMy Products + sidebar tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
