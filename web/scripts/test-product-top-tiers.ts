import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mergeProductTiers,
  resolveProductCategory,
  STL_BOOTSTRAP_DETAIL,
  type RawProductRow,
} from "../src/lib/productTopTiers";

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

const IMG = "https://i.pinimg.com/x.jpg";
function row(over: Partial<RawProductRow> & { id: string }): RawProductRow {
  return { image_url: IMG, source_url: "https://shop.com/p", ...over };
}

// 1. bootstrap-detail rows surface even with a LOW source_pin_save_count
//    (the legacy top-300 tier is simulated empty, i.e. they were crowded out).
test("bootstrap-detail row with low source_pin_save_count is included", () => {
  const merged = mergeProductTiers({
    scored: [],
    bootstrap: [],
    bootstrapDetail: [row({
      id: "boot-1", source_pin_save_count: 12,
      discovery_method_detail: STL_BOOTSTRAP_DETAIL, source_category: "fashion",
      product_url_hash: "h1",
    })],
  });
  assert(merged.length === 1, "expected the low-save bootstrap-detail row to be included");
  assert(merged[0].id === "boot-1", "wrong row surfaced");
});

// 2. legacy high-save STL rows still appear (from the bootstrap tier).
test("legacy high-save STL row still appears", () => {
  const merged = mergeProductTiers({
    scored: [],
    bootstrap: [row({ id: "legacy-1", source_pin_save_count: 50000 })],
    bootstrapDetail: [row({ id: "boot-1", source_pin_save_count: 12,
      discovery_method_detail: STL_BOOTSTRAP_DETAIL, source_category: "home-decor", product_url_hash: "h2" })],
  });
  const ids = merged.map(r => r.id);
  assert(ids.includes("legacy-1"), "legacy high-save row missing");
  assert(ids.includes("boot-1"), "bootstrap-detail row missing");
});

// 3. rows without image_url are excluded.
test("rows without image_url are excluded", () => {
  const merged = mergeProductTiers({
    scored: [],
    bootstrap: [],
    bootstrapDetail: [
      row({ id: "noimg", image_url: null, discovery_method_detail: STL_BOOTSTRAP_DETAIL,
        source_category: "fashion", product_url_hash: "h3" }),
      row({ id: "withimg", discovery_method_detail: STL_BOOTSTRAP_DETAIL,
        source_category: "fashion", product_url_hash: "h4" }),
    ],
  });
  const ids = merged.map(r => r.id);
  assert(!ids.includes("noimg"), "imageless row must not surface");
  assert(ids.includes("withimg"), "image-bearing row should surface");
});

// 4. dedupe across tiers by product identity (product_url_hash).
test("same product_url_hash across tiers is deduped (kept once)", () => {
  const merged = mergeProductTiers({
    scored: [],
    bootstrap: [row({ id: "legacy-dup", source_pin_save_count: 9000, product_url_hash: "SAME" })],
    bootstrapDetail: [row({ id: "boot-dup", source_pin_save_count: 10,
      discovery_method_detail: STL_BOOTSTRAP_DETAIL, source_category: "fashion", product_url_hash: "SAME" })],
  });
  assert(merged.length === 1, `expected 1 row after identity dedup, got ${merged.length}`);
  assert(merged[0].id === "legacy-dup", "earlier tier (legacy) row should win the dedup");
});

// 5. source_category is used when seed_keyword is NULL (bootstrap-detail rows).
test("source_category resolves category when seed_keyword is NULL", () => {
  assert(resolveProductCategory(STL_BOOTSTRAP_DETAIL, "womens-fashion") === "womens-fashion",
    "bootstrap-detail should derive category from source_category");
  assert(resolveProductCategory(STL_BOOTSTRAP_DETAIL, "fashion") === "fashion", "fashion not derived");
  assert(resolveProductCategory(STL_BOOTSTRAP_DETAIL, "home-decor") === "home-decor", "home-decor not derived");
  // legacy rows (no bootstrap detail) get null here and resolve via seed_keyword on the client.
  assert(resolveProductCategory(null, "fashion") === null, "non-bootstrap rows must not derive category");
  assert(resolveProductCategory(STL_BOOTSTRAP_DETAIL, null) === null, "null source_category -> null");
});

// 6. API response schema unchanged + no new public/debug fields added.
test("response schema unchanged (no new public fields)", () => {
  const routeSrc = readFileSync(join(process.cwd(), "src/app/api/products/top/route.ts"), "utf8");
  for (const key of ["items: enriched", "data: enriched", "count,", "limit,", "offset,",
                      "itemCount: enriched.length", 'source: "product_ideas_api"', "lastUpdatedAt,"]) {
    assert(routeSrc.includes(key), `response key missing/changed: ${key}`);
  }
  // Raw provenance must NOT be returned as row fields (only derived `category` is).
  const ret = routeSrc.slice(routeSrc.indexOf("return {", routeSrc.indexOf("function enrichRow")));
  const retBlock = ret.slice(0, ret.indexOf("};") + 2);
  assert(retBlock.includes("category,"), "derived category should be returned");
  assert(!/\bdiscovery_method_detail:/.test(retBlock), "must not return discovery_method_detail");
  assert(!/\bsource_category:/.test(retBlock), "must not return source_category");
});

console.log(`\nproduct-top-tiers: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
