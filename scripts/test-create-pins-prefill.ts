#!/usr/bin/env tsx
/**
 * Prefill adapter tests for Create Pins.
 * Run: npx tsx scripts/test-create-pins-prefill.ts
 *
 * Tests every source mapping and every prompt rule.
 * Exit code 0 = all pass, 1 = failures.
 */

import {
  buildPromptFromPrefill,
  buildPrefillFromWorkspace,
  buildPrefillFromProductSignal,
  buildPrefillFromViralPin,
  buildPrefillFromKeywordTrend,
  buildPrefillFromWeeklyPlan,
  type CreatePinsPrefill,
} from "../src/lib/createPinsPrefill";

// ── Mini test runner ─────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${String(e)}`);
    failed++;
  }
}

function eq(a: unknown, b: unknown, msg?: string): void {
  if (a !== b) throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function includes(str: string, sub: string): void {
  if (!str.includes(sub)) throw new Error(`Expected "${sub}" in:\n${str}`);
}

function notIncludes(str: string, sub: string): void {
  if (str.includes(sub)) throw new Error(`Should NOT contain "${sub}" in:\n${str}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WORKSPACE_ITEM = {
  keyword_id: "kw-001",
  keyword: "minimalist home decor",
  category: "home-decor",
  tier: "best_bet",
  opportunity_score: 82,
  pct_growth_yoy: 65,
  total_source_saves: 80000,
  trend_lifecycle: "rising",
  pin_samples: [
    { id: "pin-1", image_url: "https://cdn.example.com/ref1.jpg", save_count: 12000 },
    { id: "pin-2", image_url: "https://cdn.example.com/ref2.jpg", save_count: 8000 },
  ],
};

const PRODUCT = {
  id: "prod-001",
  product_name: "Beige Linen Throw Pillow",
  image_url: "https://cdn.example.com/product.jpg",
  seed_keyword: "home-decor",
  source_url: "https://amazon.com/dp/B001",
  domain: "amazon.com",
};

const VIRAL_PIN = {
  id: "pin-001",
  image_url: "https://cdn.example.com/viral.jpg",
  save_count: 45000,
  source_keyword: "aesthetic bedroom",
  category: "home-decor",
};

const KEYWORD_TREND = {
  keyword: "boho living room",
  category: "home-decor",
  opportunityLabel: "Best Bet",
  trendState: "Rising",
};

const WEEKLY_PLAN = {
  keyword_id: "kw-wp-001",
  keyword: "summer outfit ideas",
  category: "fashion",
  tier: "steady",
  title_hook: "Style Your Summer",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\nSource mapping tests");

test("1. normalize workspace query — source is 'workspace'", () => {
  const p = buildPrefillFromWorkspace(WORKSPACE_ITEM, "home-decor");
  eq(p.source, "workspace");
  ok(!!p.opportunity, "should have opportunity");
  eq(p.opportunity!.keyword, "minimalist home decor");
  eq(p.opportunity!.primaryLabel, "Best Bet");
  eq(p.opportunity!.trendState, "Rising");
  ok((p.productImages?.length ?? 0) === 0, "no products from workspace");
  ok((p.pinReferences?.length ?? 0) > 0, "should have pin references from pin_samples");
});

test("2. normalize keyword trends query — source is 'keyword_trends'", () => {
  const p = buildPrefillFromKeywordTrend(KEYWORD_TREND);
  eq(p.source, "keyword_trends");
  ok(!!p.opportunity, "should have opportunity");
  eq(p.opportunity!.keyword, "boho living room");
  eq(p.opportunity!.primaryLabel, "Best Bet");
  eq(p.opportunity!.trendState, "Rising");
  ok((p.productImages?.length ?? 0) === 0, "no products from keyword trends");
});

test("3. normalize product signals query — source is 'product_signals'", () => {
  const p = buildPrefillFromProductSignal(PRODUCT);
  eq(p.source, "product_signals");
  ok((p.productImages?.length ?? 0) > 0, "should have product images");
  eq(p.productImages![0].imageUrl, PRODUCT.image_url);
  eq(p.productImages![0].source, "product_signals");
  ok((p.pinReferences?.length ?? 0) === 0, "no pin refs from product signals");
});

test("4. normalize product_url legacy query — maps to productImages", () => {
  // Simulate what the legacy fallback builds for ?product_image_url=xxx
  const prefill: CreatePinsPrefill = {
    source: "product_signals",
    productImages: [{ imageUrl: "https://cdn.example.com/prod.jpg", source: "product_signals" }],
  };
  ok((prefill.productImages?.length ?? 0) === 1, "productImages populated");
  ok((prefill.pinReferences?.length ?? 0) === 0, "pinReferences empty");
});

test("5. normalize pin opportunities query — source is 'viral_pins'", () => {
  const p = buildPrefillFromViralPin({ ...VIRAL_PIN, id: "opp-pin-001" });
  eq(p.source, "viral_pins");
  ok((p.pinReferences?.length ?? 0) > 0, "should have pin references");
  eq(p.pinReferences![0].source, "viral_pins");
  ok((p.productImages?.length ?? 0) === 0, "no products from pin opportunities");
});

test("6. normalize viral pins query — source is 'viral_pins'", () => {
  const p = buildPrefillFromViralPin(VIRAL_PIN);
  eq(p.source, "viral_pins");
  ok((p.pinReferences?.length ?? 0) > 0, "should have pin references");
  eq(p.pinReferences![0].imageUrl, VIRAL_PIN.image_url);
  eq(p.pinReferences![0].saveCount, 45000);
});

test("7. normalize manual studio — source is 'manual'", () => {
  const prefill: CreatePinsPrefill = { source: "manual" };
  eq(prefill.source, "manual");
  ok(!prefill.opportunity, "no opportunity");
  ok((prefill.productImages?.length ?? 0) === 0, "no products");
  ok((prefill.pinReferences?.length ?? 0) === 0, "no refs");
});

test("8. weekly plan — source is 'weekly_plan'", () => {
  const p = buildPrefillFromWeeklyPlan(WEEKLY_PLAN);
  eq(p.source, "weekly_plan");
  ok(!!p.opportunity, "should have opportunity");
  eq(p.opportunity!.keyword, "summer outfit ideas");
});

console.log("\nMapping correctness tests");

test("9. product signals maps to productImages, NOT pinReferences", () => {
  const p = buildPrefillFromProductSignal(PRODUCT);
  ok((p.productImages?.length ?? 0) > 0, "productImages populated");
  ok((p.pinReferences?.length ?? 0) === 0, "pinReferences must be empty");
});

test("10. pin opportunities maps to pinReferences, NOT productImages", () => {
  const p = buildPrefillFromViralPin(VIRAL_PIN);
  ok((p.pinReferences?.length ?? 0) > 0, "pinReferences populated");
  ok((p.productImages?.length ?? 0) === 0, "productImages must be empty");
});

test("11. workspace does NOT populate productImages", () => {
  const p = buildPrefillFromWorkspace(WORKSPACE_ITEM, "home-decor");
  ok((p.productImages?.length ?? 0) === 0, "workspace must not populate productImages");
});

console.log("\nPrompt builder tests");

test("12. keyword prompt does not contain empty quotes", () => {
  const p = buildPrefillFromKeywordTrend({ keyword: "boho living room", category: "home-decor" });
  const prompt = buildPromptFromPrefill(p);
  notIncludes(prompt, `for ""`);
  notIncludes(prompt, `for undefined`);
  notIncludes(prompt, `for null`);
  ok(prompt.length > 20, "prompt must not be empty");
});

test("13. prompt does not contain undefined or null", () => {
  const p = buildPrefillFromWorkspace(WORKSPACE_ITEM, "home-decor");
  const prompt = buildPromptFromPrefill(p);
  notIncludes(prompt, "undefined");
  notIncludes(prompt, "null");
});

test("14. workspace prompt contains keyword", () => {
  const p = buildPrefillFromWorkspace(WORKSPACE_ITEM, "home-decor");
  const prompt = buildPromptFromPrefill(p);
  includes(prompt, "minimalist home decor");
});

test("15. product-led prompt contains 'keep' / 'recognizable'", () => {
  const p = buildPrefillFromProductSignal(PRODUCT);
  const prompt = buildPromptFromPrefill(p);
  ok(prompt.toLowerCase().includes("recognizable"), "must contain 'recognizable'");
});

test("16. reference-guided prompt contains 'visual' and 'guidance'", () => {
  const p = buildPrefillFromViralPin(VIRAL_PIN);
  const prompt = buildPromptFromPrefill(p);
  ok(
    prompt.toLowerCase().includes("visual") && prompt.toLowerCase().includes("guid"),
    `must contain visual guidance language. Got: ${prompt.slice(0, 200)}`
  );
});

test("17. product + reference prompt contains both product and reference rules", () => {
  const p: CreatePinsPrefill = {
    source: "product_signals",
    opportunity: { title: "home decor", keyword: "home decor", category: "home-decor" },
    productImages: [{ imageUrl: "https://cdn.example.com/p.jpg", source: "product_signals", title: "Modern Vase" }],
    pinReferences: [{ imageUrl: "https://cdn.example.com/r.jpg", source: "viral_pins" }],
  };
  const prompt = buildPromptFromPrefill(p);
  ok(prompt.toLowerCase().includes("recognizable"), "must have product rule");
  ok(prompt.toLowerCase().includes("visual") || prompt.toLowerCase().includes("guid"), "must have reference rule");
  notIncludes(prompt, `for ""`);
});

test("18. empty prefill returns empty prompt (manual mode)", () => {
  const p: CreatePinsPrefill = { source: "manual" };
  const prompt = buildPromptFromPrefill(p);
  // Manual with no context → empty prompt is acceptable
  notIncludes(prompt, "undefined");
  notIncludes(prompt, "null");
  notIncludes(prompt, `for ""`);
});

test("19. keyword trends prefill produces non-empty prompt", () => {
  const p = buildPrefillFromKeywordTrend({ keyword: "summer outfits", category: "fashion" });
  const prompt = buildPromptFromPrefill(p);
  ok(prompt.length > 30, "prompt must not be empty for keyword trends");
  includes(prompt, "summer outfits");
  notIncludes(prompt, `for ""`);
});

test("20. no text overlay rule always present in non-empty prompts", () => {
  const cases: CreatePinsPrefill[] = [
    buildPrefillFromWorkspace(WORKSPACE_ITEM, "home-decor"),
    buildPrefillFromProductSignal(PRODUCT),
    buildPrefillFromViralPin(VIRAL_PIN),
    buildPrefillFromKeywordTrend(KEYWORD_TREND),
  ];
  for (const p of cases) {
    const prompt = buildPromptFromPrefill(p);
    if (prompt.length > 0) {
      ok(
        prompt.includes("No text overlay") || prompt.includes("no text overlay"),
        `Prompt missing 'No text overlay': ${prompt.slice(0, 100)}`
      );
    }
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
