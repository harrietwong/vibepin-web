#!/usr/bin/env tsx
/**
 * test-mvp-taxonomy.ts
 *
 * Verifies the shared presentation-layer taxonomy normalization (mvpTaxonomy.ts):
 * category grouping, art special-casing, hidden categories, platform normalization
 * (domain-first, social/invalid hidden), and the show/Other/hide platform rules.
 *
 * Run: npx tsx scripts/test-mvp-taxonomy.ts
 * Exit 0 = all pass, 1 = failures.
 */

import {
  normalizeCategoryLabel,
  normalizeCategorySlug,
  categoryMatchSlugs,
  computeVisibleCategories,
  normalizePlatform,
  normalizePlatformLabel,
  computeVisiblePlatforms,
  hostnameOf,
  PRODUCT_VISIBLE_CATEGORIES,
  PIN_VISIBLE_CATEGORIES,
  type PlatformInput,
} from "../src/lib/mvpTaxonomy";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (e) { console.error(`  ✗  ${name}`); console.error(`       ${String(e)}`); failed++; }
}
function eq<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ?? "eq"}: expected ${b}, got ${a}`);
}

// ── Slug normalization ──────────────────────────────────────────────────────────
test("normalizeCategorySlug lowercases and dashes", () => {
  eq(normalizeCategorySlug("Home_Decor"), "home-decor");
  eq(normalizeCategorySlug("  Womens Fashion "), "womens-fashion");
  eq(normalizeCategorySlug(null), "unknown");
  eq(normalizeCategorySlug(""), "unknown");
});

// ── Category grouping ───────────────────────────────────────────────────────────
test("fashion subcategories collapse to Fashion", () => {
  eq(normalizeCategoryLabel("womens-fashion"), "Fashion");
  eq(normalizeCategoryLabel("mens-fashion"), "Fashion");
  eq(normalizeCategoryLabel("fashion"), "Fashion");
});
test("home + home-decor collapse to Home Decor", () => {
  eq(normalizeCategoryLabel("home"), "Home Decor");
  eq(normalizeCategoryLabel("home-decor"), "Home Decor");
});
test("beauty + health → Beauty & Wellness", () => {
  eq(normalizeCategoryLabel("beauty"), "Beauty & Wellness");
  eq(normalizeCategoryLabel("health"), "Beauty & Wellness");
});
test("kids-fashion / parenting / education → Kids & Parenting", () => {
  eq(normalizeCategoryLabel("kids-fashion"), "Kids & Parenting");
  eq(normalizeCategoryLabel("parenting"), "Kids & Parenting");
  eq(normalizeCategoryLabel("education"), "Kids & Parenting");
});
test("food + food-and-drink → Kitchen & Dining", () => {
  eq(normalizeCategoryLabel("food"), "Kitchen & Dining");
  eq(normalizeCategoryLabel("food-and-drink"), "Kitchen & Dining");
});
test("wedding + event-planning → Wedding", () => {
  eq(normalizeCategoryLabel("wedding"), "Wedding");
  eq(normalizeCategoryLabel("event-planning"), "Wedding");
});

// ── Hidden categories ───────────────────────────────────────────────────────────
test("non-commerce categories are hidden", () => {
  for (const s of ["quotes", "finance", "entertainment", "architecture", "design",
    "animals", "automotive", "sports", "sport", "travel", "holidays-seasonal", "unknown"]) {
    eq(normalizeCategoryLabel(s), null, `expected ${s} hidden`);
  }
});
test("unmapped slug is hidden (fail-closed)", () => {
  eq(normalizeCategoryLabel("totally-made-up"), null);
});

// ── Art special case ────────────────────────────────────────────────────────────
test("art is hidden as standalone, digital only when typed digital", () => {
  eq(normalizeCategoryLabel("art"), null);
  eq(normalizeCategoryLabel("art", "physical"), null);
  eq(normalizeCategoryLabel("art", "digital"), "Digital Products");
});

// ── Match slugs (inverse) ───────────────────────────────────────────────────────
test("categoryMatchSlugs returns all feeding slugs, never art", () => {
  eq(categoryMatchSlugs("Fashion").sort(), ["fashion", "mens-fashion", "womens-fashion", "women's-fashion", "men's-fashion"].sort());
  eq(categoryMatchSlugs("Gardening"), ["gardening"]);
  // art must NOT leak into Digital Products slug set (would pull physical art in)
  if (categoryMatchSlugs("Digital Products").includes("art")) throw new Error("art leaked into Digital Products slug set");
});

// ── Data-driven visibility ──────────────────────────────────────────────────────
test("computeVisibleCategories applies the threshold + sort", () => {
  const counts = { "Digital Products": 1510, "Gardening": 50, "Wedding": 18 } as const;
  eq(computeVisibleCategories(counts, 60), ["Digital Products"]);
  eq(computeVisibleCategories(counts, 30), ["Digital Products", "Gardening"]);
});
test("baked product/pin visible sets are consistent with audit", () => {
  eq(PRODUCT_VISIBLE_CATEGORIES, ["Digital Products", "Home Decor", "Fashion", "Beauty & Wellness", "DIY & Crafts", "Gardening"]);
  // Pin set must NOT surface hidden non-commerce categories.
  for (const c of PIN_VISIBLE_CATEGORIES) if (c === ("Quotes" as unknown)) throw new Error("hidden cat in pin set");
  eq(PIN_VISIBLE_CATEGORIES.length, 10);
});

// ── Hostname extraction ─────────────────────────────────────────────────────────
test("hostnameOf strips scheme + www", () => {
  eq(hostnameOf("https://www.etsy.com/listing/123"), "etsy.com");
  eq(hostnameOf("etsy.com"), "etsy.com");
  eq(hostnameOf("https://us.shein.com/x"), "us.shein.com");
  eq(hostnameOf(null), null);
});

// ── Platform normalization (domain-first) ───────────────────────────────────────
test("known marketplaces normalize from domain", () => {
  eq(normalizePlatformLabel({ sourceUrl: "https://www.etsy.com/listing/1" }), "Etsy");
  eq(normalizePlatformLabel({ sourceUrl: "https://www.amazon.com/dp/x?ref=pinterest" }), "Amazon");
  eq(normalizePlatformLabel({ sourceUrl: "https://amzn.to/abc" }), "Amazon");
  eq(normalizePlatformLabel({ sourceUrl: "https://us.shein.com/p" }), "SHEIN");
  eq(normalizePlatformLabel({ sourceUrl: "https://www.teacherspayteachers.com/x" }), "Teachers Pay Teachers");
});
test("dirty raw label used only as fallback; tpt expands", () => {
  eq(normalizePlatformLabel({ sourcePlatform: "tpt" }), "Teachers Pay Teachers");
  eq(normalizePlatformLabel({ sourcePlatform: "amazon" }), "Amazon");
});
test("social + invalid platforms hidden", () => {
  eq(normalizePlatform({ sourceUrl: "https://www.instagram.com/p/x" }).kind, "hidden");
  eq(normalizePlatform({ sourceUrl: "https://i.pinimg.com/x" }).kind, "hidden");
  eq(normalizePlatform({ sourcePlatform: "us" }).kind, "hidden");
  eq(normalizePlatform({ sourcePlatform: "com" }).kind, "hidden");
  eq(normalizePlatform({}).kind, "hidden");
});
test("valid low-volume domain → Other", () => {
  eq(normalizePlatformLabel({ sourceUrl: "https://someblog.example.org/post" }), "Other");
  eq(normalizePlatformLabel({ domain: "randomshop.co" }), "Other");
});

// ── Platform visibility rules ───────────────────────────────────────────────────
test("computeVisiblePlatforms: show ≥25, fold 10-24 + tail into Other", () => {
  const products: PlatformInput[] = [];
  const push = (host: string, n: number) => { for (let i = 0; i < n; i++) products.push({ sourceUrl: `https://${host}/x${i}` }); };
  push("www.etsy.com", 40);       // Etsy → show
  push("www.amazon.com", 30);     // Amazon → show
  push("www.walmart.com", 20);    // Walmart 20 (10-24) → Other
  push("someblog.example.org", 15); // valid tail → Other
  push("www.instagram.com", 12);  // social → dropped entirely
  const v = computeVisiblePlatforms(products);
  eq(v.visible, ["Etsy", "Amazon"]);
  eq(v.showOther, true);           // 20 + 15 = 35 ≥ 30
  eq(v.counts["Other"], 35);
  eq(v.counts["Etsy"], 40);
  if ("Walmart" in v.counts) throw new Error("Walmart should have folded into Other");
});
test("computeVisiblePlatforms: Other hidden when below bucket floor", () => {
  const products: PlatformInput[] = [
    { sourceUrl: "https://www.etsy.com/a" },
    { sourceUrl: "https://someblog.example.org/b" }, // 1 → Other total 1 < 30
  ];
  const v = computeVisiblePlatforms(products);
  eq(v.showOther, false);
  if ("Other" in v.counts) throw new Error("Other should be hidden below floor");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
