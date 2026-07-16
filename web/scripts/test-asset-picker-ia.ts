import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const componentSource = readFileSync(join(process.cwd(), "src/components/studio/InlineCreateAssetPicker.tsx"), "utf8");
const studioSource = readFileSync(join(process.cwd(), "src/app/app/studio/page.tsx"), "utf8");
const legacyWrapperSource = readFileSync(join(process.cwd(), "src/components/studio/CreateAssetPicker.tsx"), "utf8");

function extractConstTabLabels(constName: string): string[] {
  const match = componentSource.match(new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`));
  if (!match) throw new Error(`${constName} not found`);
  return [...match[1].matchAll(/label:\s*"([^"]+)"/g)].map(m => m[1]);
}

test("Product picker renders My Products / Product Ideas / From Shopify tabs", () => {
  // "From Shopify" (WP5) is flag-gated at render time (isShopifyIntegrationEnabled()) —
  // with the flag off it never appears in the DOM, but it is declared here so the tab
  // id/type union covers it. See ProductPickerModal.tsx and StudioBoard.tsx for the
  // matching flag-gated "Select product" entry points.
  assertEqual(extractConstTabLabels("PRODUCT_PICKER_TABS"), ["My Products", "Product Ideas", "From Shopify"], "product tabs");
});

test("Product picker defaults to My Products", () => {
  assert(componentSource.includes('useState<typeof PRODUCT_PICKER_TABS[number]["id"]>("my_products")'), "product tab default is not my_products");
});

test("Product picker does not expose old top-level tabs", () => {
  assert(!componentSource.includes('label: "Upload"'), "Upload found as a tab label");
  assert(!componentSource.includes('label: "URL Import"'), "URL Import found as a tab label");
  assert(!componentSource.includes('More sources'), "More sources still exists in inline picker");
});

test("My Products contains compact Upload product and Import from URL buttons", () => {
  assert(componentSource.includes("Upload product"), "Upload product compact action missing");
  assert(componentSource.includes("Import from URL"), "Import from URL compact action missing");
  assert(componentSource.includes('data-testid="compact-upload-product"'), "compact upload product test id missing");
  assert(componentSource.includes("my-products-grid"), "unified my products grid missing");
  assert(componentSource.includes("my-products-filter-chips"), "filter chips missing");
  assert(!componentSource.includes('title="Uploaded Products"'), "legacy source sections still present");
});

test("Reference picker renders exactly two top-level tabs", () => {
  assertEqual(extractConstTabLabels("REFERENCE_PICKER_TABS"), ["My References", "Pin Ideas"], "reference tabs");
});

test("Reference picker does not use Viral Pins labels in UI", () => {
  assert(!componentSource.includes('"Viral Pins"'), "Viral Pins label still present in picker UI");
  assert(!componentSource.includes("Saved from Viral Pins"), "Saved from Viral Pins label still present");
  assert(!componentSource.includes("Search viral pins"), "Search viral pins placeholder still present");
  assert(!componentSource.includes("Pins Idea"), "incorrect Pins Idea wording found");
  assert(componentSource.includes("Saved from Pin Ideas"), "Saved from Pin Ideas section missing");
  assert(componentSource.includes("Search Pin ideas"), "Search Pin ideas placeholder missing");
  assert(componentSource.includes('data-testid="pin-ideas-filters"'), "pin ideas horizontal filters missing");
  assert(componentSource.includes('testId="pin-ideas-category-filter"'), "pin ideas category dropdown test id missing");
  assert(componentSource.includes('testId="pin-ideas-format-filter"'), "pin ideas format dropdown test id missing");
  assert(!componentSource.includes("viral-pins-category-sidebar"), "viral pins left sidebar still present");
});

test("Reference picker defaults to My References", () => {
  assert(componentSource.includes('useState<typeof REFERENCE_PICKER_TABS[number]["id"]>("my_references")'), "reference tab default is not my_references");
});

test("Reference picker does not expose old top-level tabs", () => {
  assert(!componentSource.includes('Saved References"'), "Saved References exists as a top-level tab");
  assert(!componentSource.includes('label: "Upload"'), "Upload found as a tab label");
  assert(!componentSource.includes('label: "URL Import"'), "URL Import found as a tab label");
  assert(!componentSource.includes('More sources'), "More sources still exists in inline picker");
});

test("My References contains compact Upload reference and Import from URL buttons", () => {
  assert(componentSource.includes("Upload reference"), "Upload reference compact action missing");
  assert(componentSource.includes("Import from URL"), "Import from URL compact action missing");
  assert(componentSource.includes('data-testid="compact-upload-reference"'), "compact upload reference test id missing");
});

test("Studio uses rightPanelMode and does not render the centered modal picker", () => {
  assert(studioSource.includes('type RightPanelMode = "feed" | "product_picker" | "reference_picker"'), "rightPanelMode type missing");
  assert(studioSource.includes("<InlineCreateAssetPicker"), "Studio does not render inline picker");
  assert(!studioSource.includes("<CreateAssetPicker"), "Studio still renders legacy picker");
});

test("Legacy CreateAssetPicker export is only a wrapper around inline picker", () => {
  assert(legacyWrapperSource.includes("<InlineCreateAssetPicker"), "legacy wrapper does not delegate to inline picker");
  assert(!legacyWrapperSource.includes("asset-picker-modal"), "legacy wrapper still exposes modal test id");
});

test("Product Ideas picker uses shared useProductIdeas data source", () => {
  assert(componentSource.includes("useProductIdeas"), "inline picker missing useProductIdeas");
  assert(componentSource.includes("ProductIdeasPickerGrid"), "inline picker missing ProductIdeasPickerGrid");
  assert(componentSource.includes("PRODUCT_IDEA_SOURCE_FILTERS"), "Product Ideas source filters missing");
  assert(componentSource.includes("PRODUCT_IDEA_PICKER_CATEGORIES"), "Product Ideas category filters missing");
  assert(componentSource.includes("product-ideas-source-filters"), "Product Ideas source filter row missing");
  assert(componentSource.includes("product-ideas-category-filters"), "Product Ideas category filter row missing");
  assert(componentSource.includes("isAmazonProductIdea"), "Product Ideas Amazon inventory detection missing");
  assert(!componentSource.includes('productTab === "amazon"'), "Amazon must not be a top-level product tab");
});

console.log(`\nAsset picker IA tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
