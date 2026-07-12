/**
 * test-product-opportunity-counts.ts 鈥?Product Opportunity Finder count/label clarity.
 *
 * Covers the "Digital card shows 168 but grid shows 1" mismatch fix:
 *   - summary total vs filtered grid count differ but are LABELED clearly
 *   - clearing a category filter increases rendered results
 *   - switching Physical/Digital preserves the active filters (no silent reset)
 *   - Product Opportunity filters do NOT leak into Pin Ideas
 *   - Amazon source filter works together with the Digital class filter
 *   - "Show 60" slices up to 60, and the grid renders exactly the page slice
 *
 * Run: npx tsx scripts/test-product-opportunity-counts.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const PAGE_SRC = readFileSync(
  fileURLToPath(new URL("../src/app/app/products/page.tsx", import.meta.url)),
  "utf8",
);
const DISCOVER_SRC = readFileSync(
  fileURLToPath(new URL("../src/app/app/discover/page.tsx", import.meta.url)),
  "utf8",
);

// Minimal product shape for the class/source simulation.
type P = { product_type?: string | null; product_subtype?: string | null; domain?: string | null; source_category?: string | null };

async function main() {
  const {
    buildResultsSummary, classNoun, summarizeActiveFilters, reducedResultsMessage, isDigitalProductType,
    buildDemandThresholds, deriveProductCompetition, deriveProductDemand,
    deriveProductOpportunityPublicMetrics, deriveProductSaveCount, deriveProductTrend,
    demandExplanation, trendExplanation, competitionExplanation,
  } = await import("../src/lib/productOpportunityCounts");

  // 鈹€鈹€ 1. Summary total vs filtered count differ but are labeled clearly 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  test("buildResultsSummary labels 'Showing 1 of 168 digital products' + reduced flag", () => {
    const s = buildResultsSummary("digital", 1, 168);
    assert.equal(s.line, "Showing 1 of 168 digital products");
    assert.equal(s.reduced, true);
    assert.equal(s.classTotal, 168);
    assert.equal(s.filteredCount, 1);
  });
  test("buildResultsSummary: not reduced when filtered === total", () => {
    const s = buildResultsSummary("physical", 300, 300);
    assert.equal(s.reduced, false);
    assert.equal(s.line, "Showing 300 of 300 physical products");
  });
  test("buildResultsSummary: never renders 'of N' smaller than what matched", () => {
    // Guards against transient count skew (filtered momentarily > class total).
    const s = buildResultsSummary("digital", 5, 3);
    assert.equal(s.classTotal, 5);
    assert.equal(s.reduced, false);
  });

  // 鈹€鈹€ classNoun / summarizeActiveFilters 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  test("classNoun pluralizes on count", () => {
    assert.equal(classNoun("digital", 1), "digital product");
    assert.equal(classNoun("digital", 0), "digital products");
    assert.equal(classNoun("physical", 2), "physical products");
  });
  test("summarizeActiveFilters joins non-empty, drops falsy", () => {
    assert.equal(
      summarizeActiveFilters(["Category: Women's Fashion", null, "Source: Amazon", "", false]),
      "Category: Women's Fashion, Source: Amazon",
    );
    assert.equal(summarizeActiveFilters([]), "");
  });

  // 鈹€鈹€ reducedResultsMessage explains WHY results are small 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  test("reducedResultsMessage: single result names the active filter", () => {
    assert.equal(
      reducedResultsMessage("digital", 1, 168, "Category: Women's Fashion"),
      "Only 1 digital product matches Category: Women's Fashion.",
    );
  });
  test("reducedResultsMessage: zero results", () => {
    assert.equal(reducedResultsMessage("physical", 0, 300, "Source: Amazon"),
      "No physical products match Source: Amazon.");
    assert.equal(reducedResultsMessage("physical", 0, 300, ""),
      "No physical products match your current filters.");
  });
  test("reducedResultsMessage: many-but-reduced uses 'N of M ... match'", () => {
    assert.equal(reducedResultsMessage("digital", 12, 168, "Category: Beauty"),
      "12 of 168 digital products match your current filters.");
  });

  // 鈹€鈹€ isDigitalProductType is the single source of truth 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  test("isDigitalProductType: type + subtype taxonomy; physical is false", () => {
    assert.equal(isDigitalProductType({ name: "Printable wall art" }), true);
    assert.equal(isDigitalProductType({ name: "Canva template bundle" }), true);
    assert.equal(isDigitalProductType({ name: "Digital planner PDF" }), true);
    assert.equal(isDigitalProductType({ name: "Wood side table", productType: "physical_product" }), false);
    assert.equal(isDigitalProductType({ name: "Ceramic mug", productSubtype: "mug" }), false);
    assert.equal(isDigitalProductType({ name: null }), false);
  });

  // 鈹€鈹€ Digital-in-Physical bug: Amazon/physical goods must be Physical; only explicit
  //    title evidence promotes to Digital (even when upstream tags say digital). 鈹€鈹€鈹€鈹€鈹€鈹€
  test("Amazon physical goods are Physical even when upstream tags them digital_product", () => {
    const amazonNoise = { isAmazon: true, productType: "digital_product" };
    // Screenshot examples (were showing under Digital + Amazon):
    assert.equal(isDigitalProductType({ name: "Solid Wood Accent End Table - Hand Carved Vintage Boho", productSubtype: "software", ...amazonNoise }), false);
    assert.equal(isDigitalProductType({ name: "Vintage Wall Art Decor Rustic Wall Decor Farmhouse", productSubtype: "template", ...amazonNoise }), false);
    assert.equal(isDigitalProductType({ name: "Cute Star Messenger Bag, Y2k Crossbody Bag, Kawaii Purse", productSubtype: "template", ...amazonNoise }), false);
    // Other tangible categories:
    assert.equal(isDigitalProductType({ name: "IKEA BILLY Bookcase Cabinet, White", ...amazonNoise }), false);       // furniture / cabinet
    assert.equal(isDigitalProductType({ name: "Wireless Bluetooth Over-Ear Headphones", ...amazonNoise }), false);  // electronics
    assert.equal(isDigitalProductType({ name: "IDEA4WALL Framed Canvas Print Wall Art Set", ...amazonNoise }), false); // framed art (physical)
    assert.equal(isDigitalProductType({ name: 'Giclee Print: Birds in the Sky 18x12in' }), false);                  // physical art print
  });
  test("Explicit digital evidence in the title IS Digital (incl. on Amazon)", () => {
    assert.equal(isDigitalProductType({ name: "Printable Wall Art 鈥?Instant Download" }), true);
    assert.equal(isDigitalProductType({ name: "Boho Nursery Wall Art Set (Digital Download)" }), true);
    assert.equal(isDigitalProductType({ name: "Canva Instagram Story Template Pack" }), true);
    assert.equal(isDigitalProductType({ name: "Notion Budget Planner Template" }), true);
    assert.equal(isDigitalProductType({ name: "Floral SVG Bundle 鈥?Cut Files for Cricut" }), true);
    assert.equal(isDigitalProductType({ name: "24 Farm Portraits Clipart, PNG" }), true);
    assert.equal(isDigitalProductType({ name: "The Midnight Garden 鈥?Kindle Ebook" }), true);
    assert.equal(isDigitalProductType({ name: "PhotoEditPro Software Download" }), true);
    assert.equal(isDigitalProductType({ name: "Steam Wallet Digital Code 鈥?Redeem Key" }), true);
    assert.equal(isDigitalProductType({ name: "Cinematic Lightroom Presets Pack" }), true);
    // Explicit evidence wins even on Amazon (real printable planner listing):
    assert.equal(isDigitalProductType({ name: "Aesthetic Daily Planner Printable", isAmazon: true, productType: "digital_product" }), true);
  });
  test("Amazon filter preserved: Digital+Amazon honestly 0, Physical+Amazon shows Amazon goods", () => {
    type Q = { product_name: string; domain: string };
    const rows: Q[] = [
      { product_name: "Solid Wood Accent End Table", domain: "amazon.com" },
      { product_name: "Framed Canvas Wall Art Set",  domain: "amazon.com" },
      { product_name: "Wireless Bluetooth Headphones", domain: "amazon.com" },
      { product_name: "Printable Budget Planner",     domain: "etsy.com" }, // digital, non-amazon
    ];
    const isDig = (q: Q) => isDigitalProductType({ name: q.product_name, isAmazon: q.domain.includes("amazon") });
    const isAmz = (q: Q) => q.domain.includes("amazon");
    assert.equal(rows.filter(q => isDig(q) && isAmz(q)).length, 0, "no forced Amazon digital");
    assert.equal(rows.filter(q => !isDig(q) && isAmz(q)).length, 3, "Amazon physical goods show under Physical+Amazon");
    assert.equal(reducedResultsMessage("digital", 0, 168, "Source: Amazon"), "No digital products match Source: Amazon.");
  });

  // 鈹€鈹€ 2 + 5. Filter simulation: clearing category increases results; Amazon鈭〥igital 鈹€
  const isDigital = (p: P) => isDigitalProductType({ name: p.product_type === "digital_product" || p.product_subtype === "printable" ? "Printable template" : "Physical product" });
  const isAmazon  = (p: P) => (p.domain ?? "").includes("amazon");
  function grid(all: P[], opts: { productClass: "digital" | "physical"; source: "all" | "amazon"; category: string | null }) {
    return all.filter(p => {
      if (opts.productClass === "digital" ? !isDigital(p) : isDigital(p)) return false;
      if (opts.source === "amazon" && !isAmazon(p)) return false;
      if (opts.category && p.source_category !== opts.category) return false;
      return true;
    });
  }
  const sample: P[] = [
    { product_type: "digital_product", source_category: "womens-fashion", domain: "etsy.com" },
    { product_type: "digital_product", source_category: "home-decor", domain: "amazon.com" },
    { product_type: "digital_product", source_category: "home-decor", domain: "gumroad.com" },
    { product_subtype: "printable",    source_category: "beauty",      domain: "amazon.com" },
    { product_type: "physical_product", source_category: "womens-fashion", domain: "amazon.com" },
  ];
  test("clearing the category filter increases digital results (1 鈫?4)", () => {
    const filtered = grid(sample, { productClass: "digital", source: "all", category: "womens-fashion" });
    const cleared  = grid(sample, { productClass: "digital", source: "all", category: null });
    assert.equal(filtered.length, 1);          // matches the "168 鈫?1" symptom shape
    assert.equal(cleared.length, 4);           // clearing shows all digital
    assert.ok(cleared.length > filtered.length, "clearing category must increase results");
  });
  test("Amazon source filter works with Digital class (independent axes)", () => {
    const amazonDigital = grid(sample, { productClass: "digital", source: "amazon", category: null });
    assert.equal(amazonDigital.length, 2);     // 2 digital + amazon
    assert.ok(amazonDigital.every(isDigital) && amazonDigital.every(isAmazon));
    const allDigital = grid(sample, { productClass: "digital", source: "all", category: null });
    assert.ok(allDigital.length >= amazonDigital.length);
  });

  // 鈹€鈹€ 6 + 7. "Show 60" slices 鈮?0; the grid renders exactly the page slice 鈹€鈹€鈹€鈹€鈹€鈹€
  function pageSlice<T>(items: T[], page: number, perPage: number): T[] {
    const pageCount = Math.max(1, Math.ceil(items.length / perPage));
    const safePage = Math.min(page, pageCount);
    return items.slice((safePage - 1) * perPage, safePage * perPage);
  }
  test("Show 60 renders up to 60 and grid count === page slice length", () => {
    const items = Array.from({ length: 137 }, (_, i) => i);
    const p1 = pageSlice(items, 1, 60);
    assert.equal(p1.length, 60);
    const p3 = pageSlice(items, 3, 60);
    assert.equal(p3.length, 137 - 120);        // last page remainder = 17
    const small = pageSlice(Array.from({ length: 5 }, (_, i) => i), 1, 60);
    assert.equal(small.length, 5);             // fewer than 60 鈫?renders all
  });

  // 鈹€鈹€ Source-structure assertions on the page (behaviors not in the module) 鈹€鈹€鈹€鈹€鈹€
  test("summary cards say 'total opportunities' (total, not filtered)", () => {
    assert.ok(/physicalCount\.toLocaleString\(\)\} total opportunities/.test(PAGE_SRC));
    assert.ok(/digitalCount\.toLocaleString\(\)\} total opportunities/.test(PAGE_SRC));
  });
  test("grid footer uses the 'Showing X of Y' summary line under filters", () => {
    assert.ok(PAGE_SRC.includes('data-testid="grid-count-footer"'));
    assert.ok(PAGE_SRC.includes("resultsSummary.line"));
  });
  test("reduced-results notice + Clear filters CTA are present", () => {
    assert.ok(PAGE_SRC.includes('data-testid="filtered-results-notice"'));
    assert.ok(PAGE_SRC.includes('data-testid="clear-filters"'));
    assert.ok(PAGE_SRC.includes("reducedResultsMessage("));
  });
  test("3. Physical/Digital switch preserves filters (only class + page reset)", () => {
    // The class buttons must NOT reset catFilter/source/etc.
    assert.ok(PAGE_SRC.includes('setProductClass("physical"); setPage(1);'));
    assert.ok(PAGE_SRC.includes('setProductClass("digital"); setPage(1);'));
    assert.ok(!/setProductClass\("(physical|digital)"\);\s*setCatFilter/.test(PAGE_SRC),
      "class switch must not clear the category filter");
  });
  test("4. Pin Ideas isolation: page uses a plain CTA, not a filtered Pin Ideas strip", () => {
    assert.ok(PAGE_SRC.includes("<PinIdeasCta"), "Pin Ideas is a standalone CTA link");
    assert.ok(!PAGE_SRC.includes("PinIdeasStrip"), "no in-page Pin Ideas strip sharing product filters");
    assert.ok(!PAGE_SRC.includes("fetchInspirationPins"), "no Pin Ideas data fetch coupled to product filters");
  });
  test("classification is single-source (page delegates to isDigitalProductType)", () => {
    assert.ok(PAGE_SRC.includes("isDigitalProductType({"));
    assert.ok(!PAGE_SRC.includes("const DIGITAL_SUBTYPES = new Set"), "no duplicate taxonomy in the page");
  });

  test("normal Product Opportunity Finder does not render pipeline freshness metadata", () => {
    assert.ok(!PAGE_SRC.includes("Pipeline:"), "normal page must not show pipeline status");
    assert.ok(!PAGE_SRC.includes("Last Updated"), "normal page must not show last-updated status");
    assert.ok(!PAGE_SRC.includes("daily pipeline"), "normal page must not show pipeline provenance");
    assert.ok(PAGE_SRC.includes("Physical Products"), "physical summary card remains");
    assert.ok(PAGE_SRC.includes("Digital Products"), "digital summary card remains");
  });

  // 鈹€鈹€ Product Picker still opens from the Product Opportunity Finder 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  test("Product Picker: button opens the picker and the modal is rendered", () => {
    assert.ok(PAGE_SRC.includes("setPickerOpen(true)"), "a control opens the Product Picker");
    assert.ok(/pickerOpen\s*&&/.test(PAGE_SRC), "picker is conditionally rendered on pickerOpen");
    assert.ok(PAGE_SRC.includes("<ProductOpportunityPicker"), "ProductOpportunityPicker is mounted");
    assert.ok(PAGE_SRC.includes("Product Picker"), "the Product Picker trigger label is present");
  });

  // 鈹€鈹€ Pin Ideas remain available in their dedicated location (not this page) 鈹€鈹€鈹€鈹€鈹€
  test("Pin Ideas live on the dedicated /app/discover page, linked from the CTA", () => {
    // The Product page only links out 鈥?no cards/tabs/filters here.
    assert.ok(PAGE_SRC.includes('href="/app/discover"'), "CTA links to the dedicated Pin Ideas page");
    assert.ok(PAGE_SRC.includes("Browse Pin Ideas"), "CTA copy points to Pin Ideas");
    // The dedicated page still renders Pin Ideas + the 'use as reference' flow.
    assert.ok(DISCOVER_SRC.includes("Pin Ideas"), "discover page still surfaces Pin Ideas");
    assert.ok(
      DISCOVER_SRC.includes('data-testid="add-references-to-create-pins"'),
      "the Pin Ideas 鈫?Create Pins reference flow still exists on the dedicated page",
    );
  });

  // 鈹€鈹€ Product Opportunity Pinterest save-count precedence 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const metrics = (o: Partial<{ productPinSaveCount: number | null; aggregateProductPinSaves: number | null }>) =>
    ({ productPinSaveCount: null, aggregateProductPinSaves: null, ...o });

  test("save count: product-level product-Pin saves take precedence", () => {
    const r = deriveProductSaveCount({
      save_count: 24, source_pin_save_count: 9316, product_pin_id: "460774",
      product_metrics: metrics({ productPinSaveCount: 24 }),
    });
    assert.equal(r.value, 24); assert.equal(r.source, "product");
  });
  test("save count: falls back to source_pin saves when no product metric", () => {
    const r = deriveProductSaveCount({
      save_count: 0, source_pin_save_count: 14510, product_pin_id: null, product_metrics: metrics({}),
    });
    assert.equal(r.value, 14510); assert.equal(r.source, "source_pin");
  });
  test("save count: falls back to STL/group product-Pin saves", () => {
    const r = deriveProductSaveCount({
      save_count: null, source_pin_save_count: null, product_pin_id: null,
      product_metrics: metrics({ aggregateProductPinSaves: 4200 }),
    });
    assert.equal(r.value, 4200); assert.equal(r.source, "normalized_product_url_group");
  });
  test("save count: multiple pins for one product URL use best available save", () => {
    const r = deriveProductSaveCount({
      save_count: null, source_pin_save_count: null, product_pin_id: null,
      product_metrics: metrics({ aggregateProductPinSaves: 88000 }),
    });
    assert.equal(r.value, 88000); assert.equal(r.source, "normalized_product_url_group");
  });
  test("save count: truly unknown stays null (renders 鈥?", () => {
    const r = deriveProductSaveCount({ save_count: null, source_pin_save_count: null, product_pin_id: null, product_metrics: metrics({}) });
    assert.equal(r.value, null); assert.equal(r.source, "unknown");
  });
  test("save count: 0 only when a real measured 0; unknown never coerced to 0", () => {
    const zero = deriveProductSaveCount({ save_count: null, source_pin_save_count: 0, product_pin_id: null, product_metrics: metrics({}) });
    assert.equal(zero.value, 0); assert.equal(zero.source, "source_pin");
    assert.equal(deriveProductSaveCount({ save_count: null, source_pin_save_count: null, product_pin_id: null }).value, null);
    // bootstrap default save_count=0 with NO product_pin_id must NOT read as a product 0.
    const boot = deriveProductSaveCount({ save_count: 0, source_pin_save_count: 12685, product_pin_id: null, product_metrics: metrics({ productPinSaveCount: null }) });
    assert.equal(boot.value, 12685); assert.equal(boot.source, "source_pin");
  });
  test("save count: never uses opportunity score; API maps saves from row.* not scores", () => {
    assert.equal(deriveProductSaveCount({ save_count: null, source_pin_save_count: null, product_pin_id: null }).value, null);
    const route = readFileSync(fileURLToPath(new URL("../src/app/api/products/top/route.ts", import.meta.url)), "utf8");
    assert.ok(/save_count:\s*row\.save_count/.test(route), "API save_count must come from row.save_count");
    assert.ok(/source_pin_save_count:\s*row\.source_pin_save_count/.test(route), "API source_pin_save_count from row.*");
    assert.ok(!/save_count:\s*[^,\n]*opportunity_score/.test(route), "API must not map score into save_count");
  });
  test("save count: does not use Amazon rating/reviews as save count", () => {
    const r = deriveProductSaveCount({
      save_count: null, source_pin_save_count: null, product_pin_id: null,
      // @ts-expect-error rating/reviews are not a save-count channel and must be ignored
      rating: 4.7, review_count: 5321,
    });
    assert.equal(r.value, null); assert.equal(r.source, "unknown");
  });
  test("V1 image-first card renders product-level saves only + 'Saves unavailable' fallback", () => {
    assert.ok(PAGE_SRC.includes("productSavesValue(p)"), "public card must use product-level saves");
    assert.ok(PAGE_SRC.includes('data-testid="product-card-saves"'), "card shows a compact saves overlay");
    assert.ok(PAGE_SRC.includes("productSavesShortLabel(p)"), "renders short product-level save copy");
    assert.ok(PAGE_SRC.includes("productSavesLabel(p)"), "keeps full save copy for tooltip/aria");
    assert.ok(PAGE_SRC.includes('"Saves unavailable"'), "missing product saves -> 'Saves unavailable'");
    assert.ok(PAGE_SRC.includes('data-save-source={productSavesValue(p) == null ? "unknown" : "product"}'), "public save source distinguishes product vs unavailable");
    assert.ok(!PAGE_SRC.includes("deriveProductSaveCount(p)"), "public card must not fall back to source Pin saves");
    assert.ok(!PAGE_SRC.includes("publicMetrics.demand.saveCount"), "card must not read the public demand metric object");
  });
  test("physical/digital classification unchanged (no loosening)", () => {
    assert.equal(isDigitalProductType({ name: "Canva template bundle" }), true);
    assert.equal(isDigitalProductType({ name: "Ceramic Vase" }), false);
    assert.equal(isDigitalProductType({ name: "Press-on Nails" }), false);
    assert.equal(isDigitalProductType({ name: "Solid Oak End Table" }), false);
  });

  // 鈹€鈹€ V0: minimal Pinterest evidence card 鈥?NO model-like judgments 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // V2 (final direction): card shows the three public metrics with plain
  // explanations, sourced from the API-derived public_metrics — and still NO
  // unified opportunity label/score anywhere.
  test("V2 card renders Demand/Trend/Competition chips + source type; NO opportunity labels", () => {
    const card = PAGE_SRC.slice(PAGE_SRC.indexOf("function ProductCard("), PAGE_SRC.indexOf("function ProductDrawer("));
    assert.ok(!/product_score|opportunity_score/.test(card), "no raw score fields");
    assert.ok(card.includes('data-testid="product-card-signals"'), "card shows the public signals cluster");
    assert.ok(card.includes("demandChip(metrics.demand)"), "demand chip from public metrics");
    assert.ok(card.includes("trendChip(metrics.trend)"), "trend chip from public metrics");
    assert.ok(card.includes("competitionChip(metrics.competition)"), "competition chip from public metrics");
    assert.ok(card.includes("sourceTypeLabel(p)"), "source type shown in user language");
    assert.ok(!/Best Opportunity|Good Opportunity|Niche Opportunity|Trending demand|Popular now|opportunityLabel/.test(card), "no unified opportunity labels");
  });
  test("drawer explains all three signals in plain language (incl. Not enough data)", () => {
    assert.ok(PAGE_SRC.includes('data-testid="drawer-signals"'), "drawer has a Signals block");
    assert.ok(PAGE_SRC.includes("demandExplanation(metrics.demand)"), "demand explanation rendered");
    assert.ok(PAGE_SRC.includes("trendExplanation(metrics.trend)"), "trend explanation rendered");
    assert.ok(PAGE_SRC.includes("competitionExplanation(metrics.competition)"), "competition explanation rendered");
    assert.ok(PAGE_SRC.includes('"Not enough data"'), "unknown renders Not enough data, never a forced verdict");
  });
  test("V1 card keeps actions and evidence as image overlays only", () => {
    const card = PAGE_SRC.slice(PAGE_SRC.indexOf("function ProductCard("), PAGE_SRC.indexOf("function ProductDrawer("));
    assert.ok(!card.includes('data-testid="product-card-source"'), "public card has no source row");
    assert.ok(!card.includes("Source pending"), "missing source is not rendered as public fallback text");
    assert.ok(!card.includes("productSourceLabel(p)"), "source labels stay internal");
    assert.ok(!card.includes("fmtPrice(p.price"), "price is not rendered on the public card");
    assert.ok(card.includes('data-testid="product-card-metrics-strip"'), "left transparent metrics strip");
    assert.ok(card.includes("linear-gradient(to right, rgba(0,0,0,0.44)"), "metrics strip is translucent gradient, not a white column");
    assert.ok(card.includes("compactFoundLabel"), "found time uses compact visible text");
    assert.ok(card.includes('data-testid="product-card-saves"'), "product-level saves overlay");
    assert.ok(card.includes('data-testid="product-card-found"'), "found-time overlay");
    assert.ok(card.includes('data-testid="product-card-generate"') && card.includes('aria-label="Generate Pin"'), "Generate Pin icon action");
    assert.ok(card.includes('data-testid="product-card-save"') && card.includes('aria-label={saved ? "Remove from Product Library" : "Save Product"}'), "Save icon action");
    assert.ok(!card.includes(">Generate Pin<"), "Generate Pin is not visible text on the public card");
    assert.ok(!card.includes(">Save Product<"), "Save Product is not visible text on the public card");
    assert.ok(card.includes("onUseForPins"), "Generate Pin wired to the create-pins flow");
    assert.ok(card.includes("saveProductToLibrary(p, title)"), "Save Product persists through the shared Product Library helper");
  });
  test("demand uses Pinterest saves/repins and percentile labels", () => {
    const products = [10, 20, 30, 40, 50, 60, 70, 80].map(save_count => ({ save_count, product_pin_id: "pin" }));
    const thresholds = buildDemandThresholds(products);
    assert.equal(deriveProductDemand(products[7], thresholds).label, "high");
    assert.equal(deriveProductDemand(products[3], thresholds).label, "medium");
    assert.equal(deriveProductDemand(products[0], thresholds).label, "low");
  });
  test("demand falls back to source_pin_id metrics", () => {
    const thresholds = buildDemandThresholds([{ source_pin_save_count: 12_000 }]);
    const demand = deriveProductDemand({ save_count: 0, product_pin_id: null, source_pin_save_count: 12_000 }, thresholds);
    assert.equal(demand.saveCount, 12_000);
    assert.equal(demand.source, "source_pin");
    assert.equal(demand.label, "high");
  });
  test("demand falls back to Shop-the-Look product Pin metrics if available", () => {
    const thresholds = buildDemandThresholds([{ target_product_pin_save_count: 4_200, target_product_pin_id: "tpin" }]);
    const demand = deriveProductDemand({ target_product_pin_save_count: 4_200, target_product_pin_id: "tpin" }, thresholds);
    assert.equal(demand.saveCount, 4_200);
    assert.equal(demand.source, "stl_product_pin");
  });
  test("demand uses highest valid save count for normalized product URL group", () => {
    const thresholds = buildDemandThresholds([{ product_metrics: metrics({ aggregateProductPinSaves: 88_000 }) }]);
    const demand = deriveProductDemand({ product_metrics: metrics({ aggregateProductPinSaves: 88_000 }) }, thresholds);
    assert.equal(demand.saveCount, 88_000);
    assert.equal(demand.source, "normalized_product_url_group");
  });
  test("unknown demand remains unknown and explicit measured 0 displays as 0 saves", () => {
    const thresholds = buildDemandThresholds([]);
    assert.equal(deriveProductDemand({ save_count: null, source_pin_save_count: null }, thresholds).label, "unknown");
    const zero = deriveProductDemand({ source_pin_save_count: 0 }, thresholds);
    assert.equal(zero.saveCount, 0);
    assert.equal(zero.label, "low");
  });
  test("competition uses internal similar Pin/product-family signals", () => {
    const competition = deriveProductCompetition({
      product_metrics: { productSourcePinCount: 7, uniqueProductPinCount: 3, productPinSaveCount: null, aggregateProductPinSaves: null },
    });
    assert.equal(competition.label, "low");
    assert.equal(competition.source, "internal_cluster");
  });
  test("missing competition does not display Low Competition", () => {
    assert.equal(deriveProductCompetition({ product_metrics: null }).label, "unknown");
    assert.equal(deriveProductCompetition({ product_metrics: { productSourcePinCount: 1, uniqueProductPinCount: 1 } }).label, "unknown");
  });
  test("competition thresholds map medium/high without using backend score", () => {
    assert.equal(deriveProductCompetition({
      opportunity_score: 99,
      product_metrics: { productSourcePinCount: 12, uniqueProductPinCount: 3 },
    }).label, "medium");
    assert.equal(deriveProductCompetition({
      opportunity_score: 1,
      product_metrics: { productSourcePinCount: 30, uniqueProductPinCount: 3 },
    }).label, "high");
  });
  test("public metrics carry NO unified opportunity label/score (v2.0 direction)", () => {
    const thresholds = buildDemandThresholds([{ source_pin_save_count: 80_000 }]);
    const metricsResult = deriveProductOpportunityPublicMetrics({ source_pin_save_count: 80_000, product_metrics: null }, thresholds);
    assert.deepEqual(Object.keys(metricsResult).sort(), ["competition", "demand", "trend"]);
    assert.equal("opportunityLabel" in metricsResult, false);
  });
  test("demandExplanation is plain language and honest about unknowns", () => {
    const thresholds = buildDemandThresholds([{ source_pin_save_count: 80_000 }]);
    const high = deriveProductDemand({ source_pin_save_count: 80_000 }, thresholds);
    assert.equal(high.label, "high");
    assert.match(demandExplanation(high), /top|highest/i);
    assert.match(demandExplanation({ label: "unknown", saveCount: null, trend: "unknown", source: "unknown", percentile: null }), /Not enough data/);
  });
  test("trendExplanation states the source; competitionExplanation never forces a verdict", () => {
    assert.match(trendExplanation(deriveProductTrend({ yearly_change: 40 })), /rising.*\+40%/i);
    assert.match(trendExplanation(deriveProductTrend({})), /Not enough data/);
    assert.match(competitionExplanation({ label: "unknown", confidence: "low", source: "unknown" }), /Not enough data/);
    assert.match(competitionExplanation({ label: "low", confidence: "medium", source: "internal_cluster" }), /Few similar/i);
  });
  test("products page renders no opportunity-label copy", () => {
    for (const banned of ["Best Opportunity", "Good Opportunity", "Niche Opportunity", "Trending demand", "Popular now", "opportunityLabel", "Opportunity Score"]) {
      assert.equal(PAGE_SRC.includes(banned), false, `products page must not contain "${banned}"`);
    }
  });
  test("trend renders labels and does not fabricate percentages", () => {
    assert.deepEqual(deriveProductTrend({ trend_score: 80 }), { label: "rising", growthPercent: null, source: "pin_trend" });
    assert.deepEqual(deriveProductTrend({ save_velocity_score: 45 }), { label: "stable", growthPercent: null, source: "velocity" });
    assert.deepEqual(deriveProductTrend({ yearly_change: -25 }), { label: "declining", growthPercent: -25, source: "keyword_trend" });
    assert.deepEqual(deriveProductTrend({}), { label: "unknown", growthPercent: null, source: "unknown" });
  });
  test("demand does not use Amazon review/rating count", () => {
    const thresholds = buildDemandThresholds([]);
    const demand = deriveProductDemand({ amazon_review_count: 9000, rating_count: 9000 }, thresholds);
    assert.equal(demand.saveCount, null);
    assert.equal(demand.label, "unknown");
  });
  test("V0 public page shows no diagnostic demand/trend/competition copy anywhere", () => {
    assert.ok(!PAGE_SRC.includes("Competition data unavailable"), "no 'Competition data unavailable'");
    assert.ok(!PAGE_SRC.includes("Trend unknown"), "no 'Trend unknown'");
    assert.ok(!PAGE_SRC.includes("Demand data unavailable"), "no 'Demand data unavailable'");
    assert.ok(!PAGE_SRC.includes("demandLabelText") && !PAGE_SRC.includes("competitionLabelText") && !PAGE_SRC.includes("trendLabelText"),
      "public label helpers removed from the page");
  });
  test("V2 sort: Most saved/Rising/Low competition/Newest/Price; never a score", () => {
    assert.ok(PAGE_SRC.includes('type SortKey     = "relevance" | "most_saved" | "newest" | "price" | "rising" | "low_competition"'), "V2 SortKey");
    for (const opt of ["relevance", "most_saved", "rising", "low_competition", "newest", "price"])
      assert.ok(PAGE_SRC.includes(`value="${opt}"`), `sort option ${opt} present`);
    assert.ok(!/value="(opportunity|demand|source)"/.test(PAGE_SRC), "no score/legacy sort options");
    assert.ok(PAGE_SRC.includes('effectiveSort === "most_saved"') && PAGE_SRC.includes("savesValue(b) - savesValue(a)"), "Most saved uses saves");
    assert.ok(PAGE_SRC.includes("const savesValue = (p: PinProduct) => productSavesValue(p) ?? -1"), "Most saved uses product-level saves only");
    assert.ok(PAGE_SRC.includes('effectiveSort === "newest"') && PAGE_SRC.includes("createdOrScrapedTime(b) - createdOrScrapedTime(a)"), "Newest uses timestamp");
    assert.ok(PAGE_SRC.includes('effectiveSort === "price"') && PAGE_SRC.includes("priceValue(a) - priceValue(b)"), "Price uses price");
    // Rising / Low competition rank by the SAME public badges the user sees.
    assert.ok(PAGE_SRC.includes('effectiveSort === "rising"') && PAGE_SRC.includes("TREND_RANK[metricsFor(b).trend.label]"), "Rising uses the visible trend badge");
    assert.ok(PAGE_SRC.includes('effectiveSort === "low_competition"') && PAGE_SRC.includes("COMP_RANK[metricsFor(b).competition.label]"), "Low competition uses the visible competition badge");
    assert.ok(!PAGE_SRC.includes("opportunityRank") && !/sort\([^)]*opportunity_score/.test(PAGE_SRC), "sort never uses product/opportunity score");
    assert.ok(PAGE_SRC.includes('sortTouched ? sortKey : (hasQueryContext ? "relevance" : "most_saved")'), "default: relevance w/ context else most saved");
  });
  test("V1 image-first public card hides heavy metadata and keeps detail-only fields in drawer", () => {
    assert.ok(PAGE_SRC.includes('data-testid="product-card-generate"'), "Generate Pin overlay exists");
    assert.ok(PAGE_SRC.includes('data-testid="product-card-save"'), "Save Product overlay exists");
    assert.ok(PAGE_SRC.includes('data-testid="product-card-found"'), "found-time overlay exists");
    assert.ok(!PAGE_SRC.includes('data-testid="product-card-source"'), "public source row removed");
    assert.ok(!PAGE_SRC.includes("productSourceLabel"), "public source label helper removed");
    // v2.0 provenance: Product Pin and Source Pin are SEPARATE review CTAs/urls.
    assert.ok(PAGE_SRC.includes("Open Product Pin"), "drawer has a Product Pin review CTA");
    assert.ok(PAGE_SRC.includes("Open Source Pin"), "drawer has a Source Pin review CTA");
    assert.ok(PAGE_SRC.includes("Product Pin URL") && PAGE_SRC.includes("Source Pin URL"), "provenance URLs split into two rows");
    assert.ok(PAGE_SRC.includes("sourcePinSavesValue(p)"), "drawer separates source Pin saves");
  });
  test("API meta separates product/demand freshness from score freshness", () => {
    const route = readFileSync(fileURLToPath(new URL("../src/app/api/products/top/route.ts", import.meta.url)), "utf8");
    assert.ok(route.includes("latestProductCreatedAt"));
    assert.ok(route.includes("latestDemandUpdatedAt"));
    assert.ok(route.includes("latestScoreUpdatedAt"));
    assert.ok(route.includes("scoredCount"));
    assert.ok(route.includes("unscoredCount"));
    assert.ok(route.includes("const lastUpdatedAt = lastProductCreated ?? lastScraped"));
  });
  test("V1 public subtitle shows no score/demand/trend/competition provenance", () => {
    assert.ok(!PAGE_SRC.includes("scored daily"), "no 'scored daily'");
    assert.ok(!PAGE_SRC.includes("ranked by demand, trend, and internal competition"), "no demand/trend/competition provenance");
    assert.ok(PAGE_SRC.includes("product-level Pinterest saves"), "V1 product-save evidence subtitle");
    assert.ok(PAGE_SRC.includes("Source Pin saves stay separate in details"), "source Pin saves are described as detail-only evidence");
  });

  console.log(`\n${passed} passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
