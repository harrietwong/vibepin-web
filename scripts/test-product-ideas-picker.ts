import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  filterProductIdeas,
  mapProductIdeaToPickerAsset,
  type ProductIdea,
} from "../src/lib/productIdeas";

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

const pickerSource = readFileSync(join(process.cwd(), "src/components/studio/InlineCreateAssetPicker.tsx"), "utf8");
const productsSource = readFileSync(join(process.cwd(), "src/app/app/products/page.tsx"), "utf8");

const sampleIdea: ProductIdea = {
  id: "idea-1",
  product_name: "Wicker Storage Basket",
  price: 29,
  currency: "USD",
  source_url: "https://shop.example.com/basket",
  domain: "shop.example.com",
  merchant: "Shop",
  image_url: "https://example.com/basket.jpg",
  save_count: 120,
  reaction_count: 0,
  source_pin_save_count: 80,
  seed_keyword: "home decor",
  parent_pin_id: "",
  scraped_at: null,
  opportunity_score: 82,
  trend_score: null,
  save_velocity_score: null,
  item_type: "product",
};

test("mapProductIdeaToPickerAsset uses product_ideas source", () => {
  const mapped = mapProductIdeaToPickerAsset(sampleIdea, { "home decor": "home-decor" });
  assert(mapped.source === "product_ideas", "source should be product_ideas");
  assert(mapped.imageUrl === sampleIdea.image_url, "imageUrl mismatch");
  assert(mapped.title === sampleIdea.product_name, "title mismatch");
  assert(mapped.productUrl === sampleIdea.source_url, "productUrl mismatch");
  assert(mapped.sourceDomain === sampleIdea.domain, "sourceDomain mismatch");
});

test("filterProductIdeas supports search and category filters", () => {
  const ideas: ProductIdea[] = [
    sampleIdea,
    { ...sampleIdea, id: "idea-2", product_name: "Silk Dress", seed_keyword: "fashion outfit", image_url: "https://example.com/dress.jpg" },
  ];
  const kwMap = { "home decor": "home-decor", "fashion outfit": "fashion" };

  const homeOnly = filterProductIdeas(ideas, { search: "", categoryLabel: "Home Decor", kwCatMap: kwMap });
  assert(homeOnly.length === 1 && homeOnly[0].id === "idea-1", "home decor filter failed");

  const searched = filterProductIdeas(ideas, { search: "dress", categoryLabel: "All Products", kwCatMap: kwMap });
  assert(searched.length === 1 && searched[0].id === "idea-2", "search filter failed");
});

test("Product Ideas picker uses shared useProductIdeas data source", () => {
  assert(pickerSource.includes("useProductIdeas"), "picker missing useProductIdeas hook");
  assert(pickerSource.includes("useProductIdeasCategoryMap"), "picker missing category map hook");
  assert(pickerSource.includes("ProductIdeasPickerGrid"), "picker missing ProductIdeasPickerGrid");
  assert(pickerSource.includes("product-idea-skeleton"), "picker missing skeleton test id");
  assert(pickerSource.includes("Could not load Product Ideas"), "picker missing error state");
  assert(pickerSource.includes('source: "product_ideas"'), "picker missing product_ideas source save");
  assert(!pickerSource.includes('.from("pin_products")'), "picker should not query pin_products directly");
});

test("Product Ideas skeleton only while loading", () => {
  assert(pickerSource.includes("showSkeleton = loading && products.length === 0 && !error"), "skeleton guard missing");
});

test("Product Ideas page uses shared useProductIdeas data source", () => {
  assert(productsSource.includes("useProductIdeas"), "products page missing useProductIdeas");
  assert(productsSource.includes("useProductIdeasCategoryMap"), "products page missing shared category map hook");
});

test("picker does not use legacy pin_products-only fetch effect", () => {
  assert(!pickerSource.includes('.from("pin_products")'), "picker still queries pin_products directly");
});

test("mapProductIdeaToPickerAsset normalizes snake_case fields to camelCase", () => {
  const mapped = mapProductIdeaToPickerAsset(sampleIdea);
  assert("imageUrl" in mapped, "mapped result must have imageUrl (camelCase)");
  assert(!("image_url" in mapped), "mapped result must not expose image_url (snake_case)");
  assert(mapped.imageUrl === sampleIdea.image_url, "imageUrl must match image_url value");
  assert(mapped.id === sampleIdea.id, "id must be preserved");
  assert(mapped.title === sampleIdea.product_name, "title must map from product_name");
  assert(mapped.source === "product_ideas", "source must be product_ideas");
});

test("filterProductIdeas excludes items with empty imageUrl", () => {
  const ideas: ProductIdea[] = [
    sampleIdea,
    { ...sampleIdea, id: "no-img", image_url: "" },
    { ...sampleIdea, id: "null-img", image_url: null as unknown as string },
  ];
  const result = filterProductIdeas(ideas, { search: "", categoryLabel: "All Products" });
  assert(result.length === 1, `expected 1 item with valid imageUrl, got ${result.length}`);
  assert(result[0].id === "idea-1", "wrong item returned");
});

test("AssetCard button uses column flex layout to prevent clipped image/title content", () => {
  assert(
    pickerSource.includes('display: "flex"') &&
    pickerSource.includes('flexDirection: "column"') &&
    pickerSource.includes('width: "100%"'),
    "AssetCard button must use column flex layout with width:100% to prevent clipped image/title content"
  );
});

test("Product Ideas image container uses explicit aspect-ratio instead of padding-bottom hack", () => {
  assert(
    pickerSource.includes('aspectRatio: portrait ? "2 / 3" : "1 / 1"') &&
    pickerSource.includes('data-testid="asset-card-image-wrap"'),
    "image container must use explicit aspectRatio with a stable image wrapper"
  );
  assert(
    !pickerSource.includes("paddingBottom") &&
    !pickerSource.includes('height: 0') &&
    !pickerSource.includes('height:"0"'),
    "image container must not use padding-bottom or height:0 ratio hacks"
  );
});

test("Product Ideas card normalizes empty titles", () => {
  assert(
    pickerSource.includes("Untitled product idea") && pickerSource.includes("normalizeCardTitle"),
    "Product Ideas card must render a fallback title for blank product names"
  );
});

test("ProductIdeasPickerGrid has dev-only diagnostic logging", () => {
  assert(
    pickerSource.includes('[ProductIdeas]') && pickerSource.includes('process.env.NODE_ENV'),
    "ProductIdeasPickerGrid missing dev-only console.log diagnostic"
  );
});

test("Product Ideas grid uses minmax(150px,1fr) columns", () => {
  assert(
    pickerSource.includes("minmax(150px,1fr)"),
    "Product Ideas grid should use minmax(150px,1fr) columns"
  );
});

console.log(`\nProduct Ideas picker tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
