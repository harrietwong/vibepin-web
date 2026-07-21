import assert from "node:assert/strict";
import {
  rankReferences,
  scoreReference,
  deriveRecommendationBasis,
  hasProductAnalysisSignal,
  hasProductTextSignal,
  isMeaningfulProductValue,
  PLACEHOLDER_PRODUCT_VALUES,
  type ReferenceCandidateRow,
  type ReferenceScoringInput,
} from "../src/lib/studio/referenceScoring";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

function row(id: string, o: Partial<ReferenceCandidateRow> = {}): ReferenceCandidateRow {
  return {
    id,
    imageUrl: `https://img/${id}.jpg`,
    category: "home-decor",
    title: "reference",
    saveCount: 500,
    referenceQualityScore: 0.7,
    imageQualityBand: "high",
    watermarkDetected: false,
    ...o,
  };
}

/** Mirror of the route's derivation, so basis is testable without a DB. */
function basisFor(
  input: ReferenceScoringInput,
  rows: ReferenceCandidateRow[],
  raw: {
    analysis?: { imageSummary?: string; visibleObjects?: string[]; colors?: string[]; style?: string };
    product?: { title?: string; productType?: string; productTags?: string[] };
  },
) {
  const ranked = rankReferences(rows, input, 12);
  return {
    ranked,
    basis: deriveRecommendationBasis({
      hasAnalysis: hasProductAnalysisSignal(raw.analysis),
      hasText: hasProductTextSignal(raw.product),
      results: ranked,
    }),
  };
}

// ── B1 / B2 signal detection ────────────────────────────────────────────────────

test("hasProductAnalysisSignal: true for any populated analysis field, false when empty", () => {
  assert.equal(hasProductAnalysisSignal({ imageSummary: "A boho living room corner." }), true);
  assert.equal(hasProductAnalysisSignal({ visibleObjects: ["rattan chair"] }), true);
  assert.equal(hasProductAnalysisSignal({ colors: ["terracotta"] }), true);
  assert.equal(hasProductAnalysisSignal({ style: "boho" }), true);
  assert.equal(hasProductAnalysisSignal({}), false);
  assert.equal(hasProductAnalysisSignal(undefined), false);
  assert.equal(hasProductAnalysisSignal({ imageSummary: "   ", visibleObjects: [], colors: [""], style: "" }), false);
});

test("hasProductTextSignal: real product words count, placeholders do not", () => {
  assert.equal(hasProductTextSignal({ title: "Rattan Accent Chair" }), true);
  assert.equal(hasProductTextSignal({ productType: "wall art print" }), true);
  assert.equal(hasProductTextSignal({ productTags: ["boho", "rattan"] }), true);
  assert.equal(hasProductTextSignal({}), false);
  assert.equal(hasProductTextSignal(undefined), false);
  // a tag list of pure placeholders carries no signal
  assert.equal(hasProductTextSignal({ productTags: ["", "n/a", "unknown"] }), false);
  // one meaningful tag is enough
  assert.equal(hasProductTextSignal({ productTags: ["n/a", "macrame"] }), true);
});

test("isMeaningfulProductValue: rejects placeholders, short, punctuation/digit-only", () => {
  for (const ph of ["Product", "untitled", "Untitled Product", "UNKNOWN", "n/a", "NA", "none", "item", "New Product", "-", ""]) {
    assert.equal(isMeaningfulProductValue(ph), false, `"${ph}" must not count as product signal`);
  }
  assert.equal(isMeaningfulProductValue("a"), false, "length < 2 must not count");
  assert.equal(isMeaningfulProductValue("123"), false, "digits only must not count");
  assert.equal(isMeaningfulProductValue("###"), false, "punctuation only must not count");
  assert.equal(isMeaningfulProductValue("  Rattan Chair  "), true);
  // the placeholder set is exported and covers the required vocabulary
  for (const required of ["product", "untitled", "untitled product", "unknown", "n/a", "na", "none", "item", "new product", "-", ""]) {
    assert.ok(PLACEHOLDER_PRODUCT_VALUES.has(required), `placeholder set must contain "${required}"`);
  }
});

// ── 1. valid image analysis → product_analysis ──────────────────────────────────

test("basis: valid image analysis with a genuinely matching pin → product_analysis", () => {
  const analysis = {
    style: "cottagecore",
    colors: ["cream"],
    visibleObjects: ["floral bedding", "curtains"],
    imageSummary: "A cottagecore bedroom with floral bedding and soft curtains.",
  };
  const input: ReferenceScoringInput = { category: "home-decor", ...analysis };
  const { ranked, basis } = basisFor(input, [
    row("match", { sourceKeyword: "cottagecore bedroom decor", title: "" }),
  ], { analysis });
  assert.equal(basis, "product_analysis");
  assert.ok(ranked[0].signals.includes("scene_match"), "matching pin must carry scene_match evidence");
});

// ── 2. only valid product text → product_text ───────────────────────────────────

test("basis: only product text (no analysis) with a matching pin → product_text", () => {
  const product = { title: "Macrame Wall Hanging" };
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: product.title };
  const { basis } = basisFor(input, [
    row("m", { sourceKeyword: "macrame wall hanging boho", title: "" }),
  ], { product });
  assert.equal(basis, "product_text");
});

// ── 3. only category → category_fallback ───────────────────────────────────────

test("basis: category only (no analysis, no product) → category_fallback", () => {
  const input: ReferenceScoringInput = { category: "home-decor" };
  const { ranked, basis } = basisFor(input, [row("a"), row("b", { imageUrl: "https://img/b2.jpg" })], {});
  assert.equal(basis, "category_fallback");
  assert.ok(ranked.length > 0, "category-popular pins are still returned, just honestly labeled");
});

// ── 4. placeholder titles → not product_text ───────────────────────────────────

test("basis: placeholder product titles never yield product_text", () => {
  for (const title of ["Product", "Untitled", "Untitled Product", "unknown", "n/a", "item", "-", "New Product"]) {
    const input: ReferenceScoringInput = { category: "home-decor", productTitle: title };
    const { basis } = basisFor(input, [row("a"), row("b", { imageUrl: "https://img/b2.jpg" })], { product: { title } });
    assert.equal(basis, "category_fallback", `placeholder title "${title}" must not claim product_text`);
  }
});

// ── 5. downgrade: product text in, category-only evidence out ──────────────────

test("basis: product_text input but results carry only categoryMatch → downgraded to category_fallback", () => {
  // The product words share nothing with the candidate metadata, so every surviving pin
  // clears the floor on categoryMatch alone — pure category popularity, not a product match.
  const product = { title: "Walnut Console Table" };
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: product.title };
  const rows = [
    row("p1", { sourceKeyword: "summery wallpapers", title: "" }),
    row("p2", { imageUrl: "https://img/p2b.jpg", sourceKeyword: "kids playroom ideas", title: "" }),
  ];
  const { ranked, basis } = basisFor(input, rows, { product });
  assert.ok(ranked.length > 0, "category-popular pins still clear the relevance floor");
  assert.ok(
    ranked.every(r => !r.signals.includes("scene_match") && !r.signals.includes("style")),
    "no result may carry product-level evidence in this scenario",
  );
  assert.equal(basis, "category_fallback");
});

test("basis: product_analysis input with zero product-level evidence also downgrades", () => {
  const analysis = { imageSummary: "A walnut console table in an entry hall." };
  const input: ReferenceScoringInput = { category: "home-decor" }; // context words withheld from scoring
  const { basis } = basisFor(input, [row("x", { sourceKeyword: "summery wallpapers", title: "" })], { analysis });
  assert.equal(basis, "category_fallback");
});

// ── 6 / 7. same-category discrimination ────────────────────────────────────────

test("two DIFFERENT products in the same category produce DIFFERENT top-N ordering", () => {
  const rows = [
    row("cottage", { sourceKeyword: "cottagecore bedroom floral bedding", title: "", saveCount: 400 }),
    row("gallery", { imageUrl: "https://img/gallery.jpg", sourceKeyword: "modern gallery wall art print", title: "", saveCount: 400 }),
  ];
  const bedding: ReferenceScoringInput = {
    category: "home-decor",
    productTitle: "Floral Cottagecore Bedding Set",
  };
  const artPrint: ReferenceScoringInput = {
    category: "home-decor",
    productTitle: "Modern Gallery Wall Art Print",
  };
  const a = rankReferences(rows, bedding, 12).map(r => r.id);
  const b = rankReferences(rows, artPrint, 12).map(r => r.id);
  assert.equal(a[0], "cottage", "bedding product must surface the cottagecore pin first");
  assert.equal(b[0], "gallery", "art print product must surface the gallery-wall pin first");
  assert.notDeepEqual(a, b, "distinguishable products must not get identical ordering");
});

test("same-category products with NO distinguishing signal may legitimately share ordering", () => {
  // Deliberately NOT asserting difference: with no product-level signal, identical
  // category-popularity ordering is the correct, honest outcome — and the basis says so.
  const rows = [
    row("hi", { sourceKeyword: "summery wallpapers", title: "", saveCount: 9000 }),
    row("lo", { imageUrl: "https://img/lo.jpg", sourceKeyword: "kids playroom ideas", title: "", saveCount: 200 }),
  ];
  const p1: ReferenceScoringInput = { category: "home-decor", productTitle: "Walnut Console Table" };
  const p2: ReferenceScoringInput = { category: "home-decor", productTitle: "Brass Floor Lamp" };
  const a = rankReferences(rows, p1, 12).map(r => r.id);
  const b = rankReferences(rows, p2, 12).map(r => r.id);
  assert.deepEqual(a, b, "no distinguishing signal → identical ordering is expected");
  assert.equal(
    deriveRecommendationBasis({ hasAnalysis: false, hasText: true, results: rankReferences(rows, p1, 12) }),
    "category_fallback",
    "identical ordering must be labeled category_fallback, not product_text",
  );
});

// ── 8. empty results ───────────────────────────────────────────────────────────

test("basis is present (and downgraded) when the ranked result set is empty", () => {
  const input: ReferenceScoringInput = { productTitle: "walnut console table" };
  const rows = [
    row("f", { category: "fashion", title: "streetwear outfit editorial", saveCount: 80_000 }),
    row("b", { category: "beauty", imageUrl: "https://img/b9.jpg", title: "summer hair tutorial", saveCount: 60_000 }),
  ];
  const { ranked, basis } = basisFor(input, rows, { product: { title: "walnut console table" } });
  assert.equal(ranked.length, 0, "nothing clears the relevance floor here");
  assert.equal(typeof basis, "string", "recommendationBasis must still be produced");
  assert.equal(basis, "category_fallback", "zero results carry no product-level evidence");
  // and directly, per the explicit empty-results rule
  assert.equal(deriveRecommendationBasis({ hasAnalysis: true, hasText: true, results: [] }), "category_fallback");
});

// ── 9. reason never leaks internals ────────────────────────────────────────────

test("reason never contains numbers, scores, confidence, or classifier field names", () => {
  const forbidden = [
    "score", "confidence", "relevance", "save_count", "savecount", "categorymatch",
    "reference_quality", "quality_score", "signal", "weight", "rank", "%",
  ];
  const contexts: ReferenceScoringInput[] = [
    { category: "home-decor", style: "boho", productTitle: "Rattan Accent Chair", imageSummary: "boho rattan corner" },
    { category: "home-decor" },
    { category: "beauty", productTitle: "Glow Serum" },
    {},
  ];
  const rows = [
    row("a", { visualFormat: "lifestyle", humanPresence: "none", saveCount: 50_000, sourceKeyword: "boho rattan chair corner" }),
    row("b", { imageUrl: "https://img/b3.jpg", visualFormat: "flat_lay", saveCount: 90_000, sourceKeyword: "summery wallpapers" }),
    row("c", { imageUrl: "https://img/c3.jpg", category: "beauty", humanPresence: "hands", saveCount: 120, sourceKeyword: "glow serum routine" }),
    row("d", { imageUrl: "https://img/d3.jpg", category: null, saveCount: 0 }),
  ];
  for (const ctx of contexts) {
    for (const r of rows) {
      const s = scoreReference(r, ctx, new Set<string>());
      assert.ok(s.reason.length > 0, "reason must never be empty");
      assert.ok(!/\d/.test(s.reason), `reason must contain no digits: "${s.reason}"`);
      const lower = s.reason.toLowerCase();
      for (const bad of forbidden) {
        assert.ok(!lower.includes(bad), `reason must not contain "${bad}": "${s.reason}"`);
      }
    }
  }
});

test("reason: popularity is a supplement — it never leads", () => {
  const s = scoreReference(
    row("viral", { category: "home-decor", saveCount: 200_000, visualFormat: "flat_lay", sourceKeyword: "summery wallpapers" }),
    { category: "home-decor", productTitle: "Walnut Console Table" },
    new Set<string>(["walnut", "console", "table"]),
  );
  assert.ok(!/^strong saves/i.test(s.reason), `popularity must not lead: "${s.reason}"`);
  assert.ok(/inspiration/i.test(s.reason.split(" · ")[0]), `category inspiration must lead: "${s.reason}"`);
});

// ── 10. pure-category reason honesty ───────────────────────────────────────────

test("reason: a pure-category result uses inspiration phrasing and NO scene descriptor", () => {
  // This pin's OWN format is flat-lay, but it shares zero words with the product. The old
  // behavior emitted "Flat-lay layout", which reads as if it matched the product.
  const s = scoreReference(
    row("flat", { category: "home-decor", title: "", sourceKeyword: "summery wallpapers", visualFormat: "flat_lay", saveCount: 300 }),
    { category: "home-decor", productTitle: "Walnut Console Table" },
    new Set<string>(["walnut", "console", "table"]),
  );
  assert.ok(!s.signals.includes("scene_match"), "no genuine overlap → no scene_match signal");
  assert.ok(!s.signals.includes("style"), "no style hit here");
  const sceneDescriptors = [
    "flat-lay layout", "lived-in scene", "product-forward shot", "collage layout",
    "in-use shot", "styled scene", "single-subject focus", "multi-item layout", "shows people",
  ];
  for (const d of sceneDescriptors) {
    assert.ok(!s.reason.toLowerCase().includes(d), `pure-category reason must not imply a product match via "${d}": "${s.reason}"`);
  }
  assert.ok(/inspiration/i.test(s.reason), `pure-category reason must use inspiration phrasing: "${s.reason}"`);
  assert.ok(!/reference$/i.test(s.reason), `must not use the old "<Category> reference" phrasing: "${s.reason}"`);
});

test("reason: genuine match evidence LEADS, ahead of category and popularity", () => {
  const s = scoreReference(
    row("m", { category: "home-decor", title: "", sourceKeyword: "boho rattan chair macrame", visualFormat: "lifestyle", saveCount: 200_000 }),
    { category: "home-decor", style: "boho", productTitle: "Rattan Accent Chair" },
    new Set<string>(["boho", "rattan", "chair", "macrame"]),
  );
  assert.ok(s.signals.includes("scene_match"), "genuine overlap must produce scene_match");
  const first = s.reason.split(" · ")[0].toLowerCase();
  assert.ok(first.startsWith("matches your"), `real evidence must lead: "${s.reason}"`);
});

test("signals: 'scene' (pin's own format) is never treated as product-level evidence", () => {
  const s = scoreReference(
    row("fmt", { category: "home-decor", title: "", sourceKeyword: "summery wallpapers", visualFormat: "flat_lay" }),
    { category: "home-decor", productTitle: "Walnut Console Table" },
    new Set<string>(["walnut", "console", "table"]),
  );
  assert.ok(s.signals.includes("scene"), "descriptive scene signal is still emitted");
  assert.equal(
    deriveRecommendationBasis({ hasAnalysis: false, hasText: true, results: [s] }),
    "category_fallback",
    "'scene' alone must never sustain a product_* basis",
  );
});

console.log(`\n${passed} reference-basis tests passed.`);
