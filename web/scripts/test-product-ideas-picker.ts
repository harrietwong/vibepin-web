import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  filterProductIdeas,
  isAmazonProductIdea,
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
const opportunityPickerSource = readFileSync(join(process.cwd(), "src/components/products/ProductOpportunityPicker.tsx"), "utf8");
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

  const searched = filterProductIdeas(ideas, { search: "dress", categoryLabel: "All Categories", sourceLabel: "All Sources", kwCatMap: kwMap });
  assert(searched.length === 1 && searched[0].id === "idea-2", "search filter failed");
});

test("filterProductIdeas supports Amazon as a source filter separate from categories", () => {
  const amazonIdea: ProductIdea = {
    ...sampleIdea,
    id: "amazon-idea",
    product_name: "Amazon Storage Basket",
    source_url: "https://www.amazon.com/dp/B08N5WRWNW",
    domain: "amazon.com",
    merchant: "Amazon",
  };
  const ideas: ProductIdea[] = [
    sampleIdea,
    amazonIdea,
    { ...sampleIdea, id: "amazon-domain", source_url: "https://example.com/x", domain: "www.amazon.co.uk", merchant: "Marketplace" },
  ];

  const amazonOnly = filterProductIdeas(ideas, { search: "", sourceLabel: "Amazon", categoryLabel: "All Categories" });
  assert(amazonOnly.length === 2, `expected 2 Amazon inventory records, got ${amazonOnly.length}`);
  assert(amazonOnly.every(isAmazonProductIdea), "Amazon filter returned a non-Amazon product idea");

  const searched = filterProductIdeas(ideas, { search: "amazon storage", sourceLabel: "Amazon", categoryLabel: "All Categories" });
  assert(searched.length === 1 && searched[0].id === "amazon-idea", "Amazon filter should preserve search");
});

test("filterProductIdeas combines Source=Amazon with category filters", () => {
  const ideas: ProductIdea[] = [
    { ...sampleIdea, id: "amazon-home", product_name: "Amazon Home Basket", source_url: "https://www.amazon.com/dp/B08N5WRWNW", domain: "amazon.com", merchant: "Amazon", seed_keyword: "home decor" },
    { ...sampleIdea, id: "amazon-fashion", product_name: "Amazon Silk Dress", source_url: "https://www.amazon.com/dp/B08N5WRWN1", domain: "amazon.com", merchant: "Amazon", seed_keyword: "fashion outfit" },
    { ...sampleIdea, id: "etsy-home", product_name: "Etsy Home Basket", source_url: "https://etsy.com/listing/1", domain: "etsy.com", merchant: "Etsy", seed_keyword: "home decor" },
  ];
  const kwMap = { "home decor": "home-decor", "fashion outfit": "fashion" };

  const amazonHome = filterProductIdeas(ideas, { search: "", sourceLabel: "Amazon", categoryLabel: "Home Decor", kwCatMap: kwMap });
  assert(amazonHome.length === 1 && amazonHome[0].id === "amazon-home", "Amazon + Home Decor intersection failed");

  const amazonFashion = filterProductIdeas(ideas, { search: "", sourceLabel: "Amazon", categoryLabel: "Fashion", kwCatMap: kwMap });
  assert(amazonFashion.length === 1 && amazonFashion[0].id === "amazon-fashion", "Amazon + Fashion intersection failed");
});

test("Product Ideas picker uses shared useProductIdeas data source", () => {
  assert(pickerSource.includes("useProductIdeas"), "picker missing useProductIdeas hook");
  assert(pickerSource.includes("useProductIdeasCategoryMap"), "picker missing category map hook");
  assert(pickerSource.includes("ProductIdeasPickerGrid"), "picker missing ProductIdeasPickerGrid");
  assert(pickerSource.includes("isAmazonProductIdea"), "picker missing Amazon inventory detection");
  assert(pickerSource.includes('label={isAmazon ? "Amazon" : "Product Ideas"}'), "picker must label Amazon inventory records inside Product Ideas");
  assert(pickerSource.includes("PRODUCT_IDEA_SOURCE_FILTERS"), "picker missing Product Ideas source filters");
  assert(pickerSource.includes("product-ideas-source-filters"), "picker missing separate source filter row");
  assert(pickerSource.includes("product-ideas-category-filters"), "picker missing separate category filter row");
  assert(!pickerSource.includes('productTab === "amazon"'), "picker must not render Amazon as a top-level tab");
  assert(pickerSource.includes("product-idea-skeleton"), "picker missing skeleton test id");
  assert(pickerSource.includes("studioModals.picker.couldNotLoadProductIdeas"), "picker missing error state");
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

test("picker ranks by real Pinterest saves — no opportunity label/score ranking (v2.0)", () => {
  assert(opportunityPickerSource.includes("deriveProductSaveCount"), "picker should rank by the honest save-count precedence");
  assert(!opportunityPickerSource.includes("deriveProductOpportunityPublicMetrics"), "picker must not rank by a synthesized opportunity ordering");
  assert(!opportunityPickerSource.includes("opportunityRank"), "picker must not carry an opportunity-label rank map");
  assert(!opportunityPickerSource.includes("b.opportunity_score ?? 0"), "picker must not rank by raw score");
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
  const result = filterProductIdeas(ideas, { search: "", categoryLabel: "All Categories", sourceLabel: "All Sources" });
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
    pickerSource.includes("studioModals.picker.untitledProductIdea") && pickerSource.includes("normalizeCardTitle"),
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

// ── STL bootstrap category filtering ─────────────────────────────────────────
// STL product-card bootstrap rows have: no seed_keyword, save_count=0, no scores,
// but carry a derived `category` (resolved server-side from source_category).
// They must be filterable by category via that derived field.

const stlBootstrapIdea: ProductIdea = {
  id: "stl-1",
  product_name: "Floral Wrap Dress",
  price: null,
  currency: null,
  source_url: "https://us.shein.com/Women-Dress-p-123.html",
  domain: "us.shein.com",
  merchant: "shein",
  image_url: "https://img.shein.com/dress.jpg",
  save_count: 0,                 // STL bootstrap rows have 0 saves on the product row
  reaction_count: 0,
  source_pin_save_count: 8000,   // evidence inherited from the source pin
  seed_keyword: null,            // STL bootstrap rows usually lack a keyword
  category: "womens-fashion",    // derived from source_category (non-provenance)
  parent_pin_id: "",
  scraped_at: null,
  opportunity_score: null,       // not yet scored
  trend_score: null,
  save_velocity_score: null,
  item_type: "product",
};

test("STL bootstrap (womens-fashion, no seed_keyword, save_count=0) surfaces under Fashion", () => {
  const kwMap = { "home decor": "home-decor" }; // does NOT contain the STL product
  const fashion = filterProductIdeas([stlBootstrapIdea], {
    search: "", categoryLabel: "Fashion", kwCatMap: kwMap,
  });
  assert(fashion.length === 1 && fashion[0].id === "stl-1",
    `womens-fashion STL product must appear under Fashion (got ${fashion.length})`);
});

test("STL bootstrap womens-fashion does NOT leak into Home Decor", () => {
  const kwMap = { "home decor": "home-decor" };
  const home = filterProductIdeas([stlBootstrapIdea], {
    search: "", categoryLabel: "Home Decor", kwCatMap: kwMap,
  });
  assert(home.length === 0,
    `womens-fashion STL product must not appear under Home Decor (got ${home.length})`);
});

test("STL bootstrap home-decor category surfaces under Home Decor", () => {
  const homeStl: ProductIdea = { ...stlBootstrapIdea, id: "stl-home", category: "home-decor" };
  const kwMap = {};
  const home = filterProductIdeas([homeStl], {
    search: "", categoryLabel: "Home Decor", kwCatMap: kwMap,
  });
  assert(home.length === 1 && home[0].id === "stl-home",
    `home-decor STL product must appear under Home Decor (got ${home.length})`);
});

test("STL bootstrap appears with save_count=0 and no product_scores", () => {
  // All Categories / All Sources view must include it; zero saves / null scores must not exclude it.
  const all = filterProductIdeas([stlBootstrapIdea], { search: "", categoryLabel: "All Categories", sourceLabel: "All Sources" });
  assert(all.length === 1 && all[0].save_count === 0 && all[0].opportunity_score === null,
    "STL bootstrap product with save_count=0 / no scores must still appear");
});

test("STL bootstrap missing image_url is filtered out", () => {
  const noImg: ProductIdea = { ...stlBootstrapIdea, id: "stl-noimg", image_url: "" };
  const all = filterProductIdeas([noImg], { search: "", categoryLabel: "Fashion", kwCatMap: {} });
  assert(all.length === 0, "STL bootstrap product without image_url must be excluded");
});

test("legacy seed_keyword category filtering is unchanged", () => {
  // Legacy product (no derived category) must still resolve via kwCatMap[seed_keyword].
  const legacy: ProductIdea = {
    ...sampleIdea, id: "legacy-1", seed_keyword: "fashion outfit", category: null,
    image_url: "https://example.com/x.jpg",
  };
  const kwMap = { "fashion outfit": "fashion" };
  const fashion = filterProductIdeas([legacy], { search: "", categoryLabel: "Fashion", kwCatMap: kwMap });
  assert(fashion.length === 1 && fashion[0].id === "legacy-1", "legacy fashion filtering broke");
  const home = filterProductIdeas([legacy], { search: "", categoryLabel: "Home Decor", kwCatMap: kwMap });
  assert(home.length === 0, "legacy product must not appear under wrong category");
});

test("derived category wins over a stale seed_keyword mapping", () => {
  // A row with both a derived category and a seed_keyword: derived category drives filtering.
  const mixed: ProductIdea = {
    ...stlBootstrapIdea, id: "stl-mixed", seed_keyword: "random kitchen thing", category: "womens-fashion",
  };
  const kwMap = { "random kitchen thing": "home-decor" };
  const fashion = filterProductIdeas([mixed], { search: "", categoryLabel: "Fashion", kwCatMap: kwMap });
  assert(fashion.length === 1, "derived category should place product under Fashion");
  const home = filterProductIdeas([mixed], { search: "", categoryLabel: "Home Decor", kwCatMap: kwMap });
  assert(home.length === 0, "derived category should override seed_keyword's home-decor mapping");
});

console.log(`\nProduct Ideas picker tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
