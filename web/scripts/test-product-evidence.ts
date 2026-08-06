/**
 * Tier-aware reference reranking — productEvidenceScore, tier assignment, merge, and the
 * basis/reason correction.
 *
 * Every rule asserted here is backed by the round-2 real-data evaluation
 * (scratchpad/rerank-evidence-r2.md): the 18 DB-cited synonym pairs, the plural/possessive
 * -only normalization (the `-ed`/`-ing` rules were measured defective), the `canvas`
 * exception (48 real false hits against the brand "Canva"), and `hits / sqrt(|cand|)`
 * (82.8% of 17,924 measured containment inversions corrected, vs 0% for the retracted
 * `max(containment, jaccard)`).
 */
import assert from "node:assert/strict";
import {
  rankReferencesTiered,
  rankReferences,
  deriveRecommendationBasis,
  toRecommendation,
  productEvidenceScore,
  buildProductEvidenceContext,
  productEvidenceCandidateWords,
  normalizeWord,
  NORMALIZE_EXCEPTIONS,
  PRODUCT_EVIDENCE_SYNONYMS,
  RELEVANCE_FLOOR,
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
    title: "",
    saveCount: 500,
    referenceQualityScore: 0.7,
    imageQualityBand: "high",
    watermarkDetected: false,
    ...o,
  };
}

/** productEvidenceScore for a row against a scoring input, in one call. */
function evidence(r: ReferenceCandidateRow, input: ReferenceScoringInput): number {
  return productEvidenceScore(r, buildProductEvidenceContext(input), input.category);
}

// ── 1. category words alone produce ZERO product evidence ───────────────────────

test("1. category words alone produce ZERO productEvidenceScore", () => {
  // Every word on both sides is the category name. Inside a category-scoped pool this is a
  // constant, which is exactly the saturation that made the old ranking product-independent.
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Home Decor" };
  assert.equal(evidence(row("a", { sourceKeyword: "home decor" }), input), 0);
  assert.equal(evidence(row("b", { sourceKeyword: "home decoration ideas", title: "home decor" }), input), 0,
    "'decoration'/'ideas' are not product words either — ideas is a STOP_WORD, decoration is not in the product");

  // Same with the analysis fields carrying only the category.
  const analysisOnly: ReferenceScoringInput = { category: "beauty", style: "beauty", visibleObjects: ["beauty"] };
  assert.equal(evidence(row("c", { category: "beauty", sourceKeyword: "beauty" }), analysisOnly), 0);

  // And the row's OWN category word is stripped too, so it can't hand out a free hit.
  const ctx = buildProductEvidenceContext({ category: "home-decor", productTitle: "Rattan Chair" });
  const words = productEvidenceCandidateWords(row("d", { sourceKeyword: "home decor rattan" }), "home-decor");
  assert.ok(!words.includes("home") && !words.includes("decor"), `category words must be stripped: ${words}`);
  assert.ok(words.includes("rattan"));
  assert.ok(productEvidenceScore(row("d", { sourceKeyword: "home decor rattan" }), ctx, "home-decor") > 0);
});

// ── 2. genuine product-word matches enter Tier 1 ────────────────────────────────

test("2. genuine product-word matches enter Tier 1", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Chunky Knit Wool Throw Blanket" };
  const hit = row("hit", { sourceKeyword: "chunky knit blanket styling" });
  const miss = row("miss", { imageUrl: "https://img/miss.jpg", sourceKeyword: "may 2026 nails" });
  assert.ok(evidence(hit, input) > 0, "real word overlap must produce evidence");
  assert.equal(evidence(miss, input), 0, "zero overlap must produce zero evidence");

  const ranked = rankReferencesTiered([miss, hit], input, 12);
  const byId = new Map(ranked.map(r => [r.id, r]));
  assert.equal(byId.get("hit")!.recommendationTier, "product_evidence");
  assert.equal(byId.get("miss")!.recommendationTier, "category_fallback");
});

test("2b. Tier-1 admission is `> 0`, NOT the old RELEVANCE_FLOOR", () => {
  // Round 2: re-applying the 0.3 floor to category-free evidence emptied 37% of real
  // catalog products (home-decor 57%, fashion 60%). A single weak-but-real hit must admit.
  const input: ReferenceScoringInput = { category: "digital-products", productTitle: "Reading comprehension and fluency worksheet" };
  const weak = row("weak", {
    category: "digital-products",
    // ONE real hit ("worksheet") inside a long keyword → evidence well under 0.3
    sourceKeyword:
      "notion aesthetic dashboard sticker bundle worksheet cover mockup layout freebie widget journal",
  });
  const e = evidence(weak, input);
  assert.ok(e > 0, "must carry evidence");
  assert.ok(e < RELEVANCE_FLOOR, `this case must sit BELOW the old floor to be meaningful (got ${e})`);
  const ranked = rankReferencesTiered([weak], input, 12);
  assert.equal(ranked[0].recommendationTier, "product_evidence",
    "evidence below the old relevance floor must still reach Tier 1");
});

// ── 3. Tier 1 always ranks ahead of Tier 2 ──────────────────────────────────────

test("3. Tier 1 always ranks ahead of Tier 2, even when Tier 2 has a far higher score", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Rattan Accent Chair" };
  const tier1Weak = row("t1", {
    sourceKeyword: "rattan corner styling for narrow hallway entry nooks",
    saveCount: 0, referenceQualityScore: 0.05, humanPresence: "full",
  });
  const tier2Strong = row("t2", {
    imageUrl: "https://img/t2.jpg",
    sourceKeyword: "may 2026 nails", saveCount: 500_000, referenceQualityScore: 1, hasClearSubject: true,
  });
  const ranked = rankReferencesTiered([tier2Strong, tier1Weak], input, 12);
  assert.equal(ranked[0].id, "t1", "product evidence outranks a maximal-score category pin");
  assert.ok(ranked[0].score < ranked[1].score, "…and it does so despite a strictly lower score");
});

// ── 4. within a tier, existing score still governs ──────────────────────────────

test("4. within a tier, the existing score still governs", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Walnut Console Table" };
  // Tier 2 (no evidence at all): pure score order.
  const lo = row("lo", { sourceKeyword: "may 2026 nails", saveCount: 10 });
  const hi = row("hi", { imageUrl: "https://img/hi.jpg", sourceKeyword: "graduation hairstyles", saveCount: 400_000 });
  const t2 = rankReferencesTiered([lo, hi], input, 12);
  assert.deepEqual(t2.map(r => r.id), ["hi", "lo"], "higher score first inside Tier 2");
  assert.ok(t2.every(r => r.recommendationTier === "category_fallback"));

  // Tier 1 with EQUAL evidence: the existing score breaks the tie.
  const a = row("a", { sourceKeyword: "walnut styling", saveCount: 10 });
  const b = row("b", { imageUrl: "https://img/b.jpg", sourceKeyword: "console styling", saveCount: 400_000 });
  const ea = evidence(a, input), eb = evidence(b, input);
  assert.equal(ea, eb, "fixture must have equal evidence for this assertion to mean anything");
  const t1 = rankReferencesTiered([a, b], input, 12);
  assert.deepEqual(t1.map(r => r.id), ["b", "a"], "equal evidence → higher score wins");
});

// ── 5 / 6. no Tier 1 → category baseline, never empty, category_fallback ────────

test("5. no Tier 1 → still returns the full category baseline (never empty)", () => {
  const input: ReferenceScoringInput = { category: "fashion", productTitle: "larssonjennings" };
  // Real round-2 zero-bridge product; none of these pool keywords share a word with it.
  const rows = [
    row("p1", { category: "fashion", imageUrl: "https://img/p1.jpg", sourceKeyword: "outfit ideas for school" }),
    row("p2", { category: "fashion", imageUrl: "https://img/p2.jpg", sourceKeyword: "brunch outfit ideas black women" }),
    row("p3", { category: "fashion", imageUrl: "https://img/p3.jpg", sourceKeyword: "mens fashion casual outfits" }),
  ];
  assert.ok(rows.every(r => evidence(r, input) === 0), "fixture must genuinely have no evidence");
  const ranked = rankReferencesTiered(rows, input, 12);
  assert.equal(ranked.length, 3, "the entire displayable pool is returned as category inspiration");
  assert.ok(ranked.every(r => r.recommendationTier === "category_fallback"));
});

test("6. no Tier 1 → recommendationBasis === category_fallback", () => {
  const input: ReferenceScoringInput = { category: "fashion", productTitle: "larssonjennings" };
  const ranked = rankReferencesTiered([
    row("p1", { category: "fashion", sourceKeyword: "outfit ideas for school" }),
  ], input, 12);
  assert.equal(
    deriveRecommendationBasis({ hasAnalysis: false, hasText: true, results: ranked }),
    "category_fallback",
  );
  assert.equal(
    deriveRecommendationBasis({ hasAnalysis: true, hasText: true, results: ranked }),
    "category_fallback",
    "even a real image analysis cannot claim product_analysis over a pure-Tier-2 output",
  );
});

// ── 7. product_* only when real Tier-1 evidence is in the FINAL output ──────────

test("7. product_analysis / product_text only when Tier 1 is in the FINAL output", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Chunky Knit Wool Throw Blanket" };
  const withT1 = rankReferencesTiered([
    row("hit", { sourceKeyword: "chunky knit blanket styling" }),
    row("bg", { imageUrl: "https://img/bg.jpg", sourceKeyword: "may 2026 nails" }),
  ], input, 12);
  assert.equal(deriveRecommendationBasis({ hasAnalysis: true, hasText: true, results: withT1 }), "product_analysis");
  assert.equal(deriveRecommendationBasis({ hasAnalysis: false, hasText: true, results: withT1 }), "product_text");
  assert.equal(deriveRecommendationBasis({ hasAnalysis: false, hasText: false, results: withT1 }), "category_fallback",
    "no product input at all is still category_fallback regardless of tier");

  // Truncation matters: if `limit` cuts Tier 1 out of the FINAL list, the claim must go too.
  // (Not reachable via the merge order, so assert the contract on the derived function.)
  const tier2Only = withT1.filter(r => r.recommendationTier === "category_fallback");
  assert.ok(tier2Only.length > 0);
  assert.equal(deriveRecommendationBasis({ hasAnalysis: true, hasText: true, results: tier2Only }), "category_fallback");
  assert.equal(deriveRecommendationBasis({ hasAnalysis: true, hasText: true, results: [] }), "category_fallback");
});

// ── 8. normalization + synonyms ─────────────────────────────────────────────────

test("8a. plural and possessive normalization works", () => {
  assert.equal(normalizeWord("nails"), "nail");
  assert.equal(normalizeWord("templates"), "template");
  assert.equal(normalizeWord("printables"), "printable");
  assert.equal(normalizeWord("designs"), "design");
  assert.equal(normalizeWord("downloads"), "download");
  assert.equal(normalizeWord("rooms"), "room");
  assert.equal(normalizeWord("prints"), "print");
  assert.equal(normalizeWord("posters"), "poster");
  assert.equal(normalizeWord("bodies"), "body");
  assert.equal(normalizeWord("dresses"), "dress");
  assert.equal(normalizeWord("couches"), "couch");
  // possessive: `words()` strips the apostrophe, leaving the plural form to normalize
  assert.equal(normalizeWord("womens"), "women");
  assert.equal(normalizeWord("teachers"), "teacher");
});

test("8b. `-ed` / `-ing` are NOT truncated (round-2 measured defects)", () => {
  // `nailed → nail` fired 12 times and `striped → strips` 6 times on real data. Both are
  // cross-POS collisions; the -ed/-ing rules are deliberately absent.
  assert.equal(normalizeWord("nailed"), "nailed", "must NOT become 'nail'");
  assert.equal(normalizeWord("striped"), "striped", "must NOT become 'strip'/'strips'");
  assert.equal(normalizeWord("hanging"), "hanging", "must NOT become 'hang'");
  assert.equal(normalizeWord("lighting"), "lighting", "must NOT become 'light'");
  assert.equal(normalizeWord("pumped"), "pumped");
  assert.notEqual(normalizeWord("nailed"), normalizeWord("nails"), "'nailed' and 'nails' must not collide");
  assert.notEqual(normalizeWord("striped"), normalizeWord("strips"), "'striped' and 'strips' must not collide");
});

test("8c. `canvas` never becomes `canva` (48 real false hits), exception list is extensible", () => {
  assert.equal(normalizeWord("canvas"), "canvas");
  assert.notEqual(normalizeWord("canvas"), "canva", "material 'canvas' must never collide with the brand 'Canva'");
  assert.ok(NORMALIZE_EXCEPTIONS.has("canvas"), "canvas must be on the exception list");
  assert.ok(NORMALIZE_EXCEPTIONS instanceof Set, "exception list must be a Set so entries can be added");
  assert.equal(normalizeWord("glass"), "glass");
  assert.equal(normalizeWord("lens"), "lens");

  // End to end: the real product/keyword pair from round 2 must NOT match.
  const input: ReferenceScoringInput = { category: "digital-products", productTitle: "Western Cowgirl Canvas Wall Art Trendy Line Vintage" };
  const canvaRow = row("canva", { category: "digital-products", sourceKeyword: "instagram feed template free download canva" });
  const words = productEvidenceCandidateWords(canvaRow, "digital-products");
  assert.ok(words.includes("canva"), "the brand word survives normalization as itself");
  const ctx = buildProductEvidenceContext(input);
  assert.ok(!ctx.expanded.has("canva"), "the product's 'canvas' must not expand to 'canva'");
});

test("8d. the 18 DB-cited synonyms map correctly, and the disproven ones are absent", () => {
  const expect: Array<[string, string]> = [
    ["bag", "outfit"], ["handbag", "outfit"], ["tote", "outfit"], ["clutch", "outfit"],
    ["necklace", "outfit"], ["watch", "outfit"], ["sunglasses", "outfit"], ["mules", "outfit"],
    ["sandal", "outfit"], ["shorts", "outfit"], ["jeans", "outfit"], ["pants", "outfit"],
    ["shirt", "outfit"], ["top", "outfit"],
    ["sofa", "living"], ["couch", "living"], ["pillow", "bedroom"], ["curtain", "bedroom"],
    ["lamp", "apartment"], ["pendant", "apartment"],
  ];
  for (const [from, to] of expect) {
    assert.ok(PRODUCT_EVIDENCE_SYNONYMS.has(from), `missing synonym source "${from}"`);
    assert.ok((PRODUCT_EVIDENCE_SYNONYMS.get(from) ?? []).includes(to), `"${from}" must map to "${to}"`);
  }
  // Round 1's disproven proposals must never ship: the TARGET words do not exist in the pools.
  for (const [from, banned] of [["sandal", "shoes"], ["curler", "lashes"], ["tote", "bag"]] as const) {
    assert.ok(!(PRODUCT_EVIDENCE_SYNONYMS.get(from) ?? []).includes(banned),
      `"${from} → ${banned}" was disproven in round 2 and must not appear`);
  }
  assert.ok(!PRODUCT_EVIDENCE_SYNONYMS.has("curler"), "`curler` has no evidenced bridge at all");
  assert.equal(PRODUCT_EVIDENCE_SYNONYMS.size, expect.length,
    "no un-cited pairs may be added — every entry needs a DB citation");

  // End to end on a real cited pair: `Faux Leather Buckle Bag` → `leather jacket outfit`.
  const input: ReferenceScoringInput = { category: "fashion", productTitle: "Faux Leather Buckle Bag" };
  const ctx = buildProductEvidenceContext(input);
  assert.ok(ctx.expanded.has("outfit"), "`bag` must bridge to `outfit`");
  assert.ok(!ctx.words.has("outfit"), "…as an EXPANSION, not as a literal product word");
  // and a bridge-only product reaches Tier 1 through it
  const clutch: ReferenceScoringInput = { category: "fashion", productTitle: "CORRIE SMALL CLUTCH" };
  const brunch = row("brunch", { category: "fashion", sourceKeyword: "brunch outfit black women" });
  assert.ok(evidence(brunch, clutch) > 0, "`clutch → outfit` must rescue a zero-overlap product");
  assert.equal(rankReferencesTiered([brunch], clutch, 12)[0].recommendationTier, "product_evidence");
});

// ── 9. sqrt damping — long sourceKeyword is not unfairly penalized ──────────────

test("9. long sourceKeyword is not unfairly penalized (sqrt damping, real-data case)", () => {
  // Round 2 measured 17,924 real inversions (7.6% of 234,861 pairs) where the candidate
  // sharing MORE product words scored LOWER, purely because plain containment divides by
  // candidate length. This is that shape, built from a REAL product title
  // (`Free Printable Bullet Journal Templates (76 Pages)`) and two REAL digital-products
  // `source_keyword`s from the round-2 pool dump.
  const input: ReferenceScoringInput = {
    category: "digital-products",
    productTitle: "Free Printable Bullet Journal Templates (76 Pages)",
    imageSummary: "A printable bullet journal planner spread with daily trackers and page dividers.",
  };
  const richer = row("richer", {
    category: "digital-products",
    sourceKeyword: "digital planner free download kilobytes of happiness aesthetic mockup printable",
  });
  const poorer = row("poorer", {
    category: "digital-products", imageUrl: "https://img/poorer.jpg", sourceKeyword: "goodnotes templates",
  });

  const ctx = buildProductEvidenceContext(input);
  const rw = productEvidenceCandidateWords(richer, "digital-products");
  const pw = productEvidenceCandidateWords(poorer, "digital-products");
  const rHits = rw.filter(w => ctx.expanded.has(w)).length;
  const pHits = pw.filter(w => ctx.expanded.has(w)).length;
  assert.equal(rHits, 3, "richer keyword shares planner/free/printable");
  assert.equal(pHits, 1, "poorer keyword shares only template");
  assert.ok(rHits > pHits, "the richer keyword genuinely shares more product words");

  // Plain containment INVERTS this pair (0.375 < 0.500) — precisely the measured defect.
  assert.ok(rHits / rw.length < pHits / pw.length,
    `plain hits/|cand| must invert here: ${(rHits / rw.length).toFixed(3)} vs ${(pHits / pw.length).toFixed(3)}`);
  // sqrt damping restores the correct order.
  assert.ok(productEvidenceScore(richer, ctx, "digital-products") > productEvidenceScore(poorer, ctx, "digital-products"),
    "hits/sqrt(|cand|) must rank the richer keyword first");

  const ranked = rankReferencesTiered([poorer, richer], input, 12);
  assert.equal(ranked[0].id, "richer", "the richer match must lead the Tier-1 ordering");
});

test("9c. the 0..1 mapping is order-preserving — Tier 1 does NOT saturate at 1.0", () => {
  // `hits / sqrt(|cand|)` exceeds 1 whenever hits >= sqrt(|cand|), which is common on real
  // keywords. A hard clamp would pin most of Tier 1 at exactly 1.0 and reintroduce exactly
  // the saturation that made the ORIGINAL ranking product-independent. The monotonic
  // raw/(1+raw) mapping must keep strictly distinct, correctly-ordered values.
  const input: ReferenceScoringInput = {
    category: "home-decor",
    productTitle: "Chunky Knit Wool Throw Blanket",
    imageSummary: "A cozy living room corner with a chunky knit throw on a small apartment sofa.",
  };
  const ctx = buildProductEvidenceContext(input);
  // All REAL home-decor source_keywords; all would clamp to exactly 1.0 under hard clamping.
  const rows = [
    row("all4", { sourceKeyword: "small apartment decor ideas living room" }),      // 4 hits / 4 words
    row("two3", { imageUrl: "https://img/two3.jpg", sourceKeyword: "boho living room decor ideas" }), // 2 / 3
    row("one3", { imageUrl: "https://img/one3.jpg", sourceKeyword: "cozy bedroom decor ideas for couples" }), // 1 / 3
  ];
  const scores = rows.map(r => productEvidenceScore(r, ctx, "home-decor"));
  assert.ok(scores.every(s => s > 0 && s < 1), `all scores must be strictly inside 0..1: ${scores}`);
  assert.equal(new Set(scores).size, scores.length, `scores must stay distinct, not saturate: ${scores}`);
  assert.ok(scores[0] > scores[1] && scores[1] > scores[2], `ordering must be preserved: ${scores}`);
  assert.deepEqual(rankReferencesTiered(rows, input, 12).map(r => r.id), ["all4", "two3", "one3"]);
});

test("9b. sqrt damping is confined to productEvidenceScore — score/relevance are untouched", () => {
  // The same row scored through the untouched public path must keep 0..1 score/relevance
  // computed the old way; the tiered ranker only REORDERS, it never rewrites these numbers.
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Rattan Accent Chair" };
  const rows = [row("a", { sourceKeyword: "boho rattan chair corner" }), row("b", { imageUrl: "https://img/b.jpg", sourceKeyword: "may 2026 nails" })];
  const legacy = new Map(rankReferences(rows, input, 12).map(r => [r.id, r]));
  for (const r of rankReferencesTiered(rows, input, 12)) {
    const old = legacy.get(r.id);
    if (!old) continue;
    assert.equal(r.score, old.score, `score must be byte-identical for ${r.id}`);
    assert.equal(r.relevance, old.relevance, `relevance must be byte-identical for ${r.id}`);
    assert.deepEqual(r.signals, old.signals, `signals must be byte-identical for ${r.id}`);
  }
});

// ── 10. determinism, dedupe, limit, safety filters ─────────────────────────────

test("10a. determinism — same input yields the same order, including on exact ties", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Rattan Accent Chair" };
  // Three rows that are IDENTICAL apart from id/imageUrl → every sort key ties. Only the
  // deterministic id tie-break can make this reproducible.
  const rows = ["zeta", "alpha", "mid"].map(id => row(id, { imageUrl: `https://img/${id}.jpg`, sourceKeyword: "may 2026 nails" }));
  const first = rankReferencesTiered(rows, input, 12).map(r => r.id);
  assert.deepEqual(first, ["alpha", "mid", "zeta"], "ties break by id ascending");
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(rankReferencesTiered([...rows].reverse(), input, 12).map(r => r.id), first,
      "input order must not affect the result");
  }
  // Same for Tier 1.
  const t1rows = ["zz", "aa", "mm"].map(id => row(id, { imageUrl: `https://img/${id}.jpg`, sourceKeyword: "rattan chair styling" }));
  assert.deepEqual(rankReferencesTiered(t1rows, input, 12).map(r => r.id), ["aa", "mm", "zz"]);
});

test("10b. cross-tier dedupe by id AND imageUrl", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Rattan Accent Chair" };
  // `dupImage` would land in Tier 2 but shares an imageUrl with the Tier-1 row; `dupId`
  // shares its id. Neither may appear a second time.
  const rows = [
    row("t1", { imageUrl: "https://img/shared.jpg", sourceKeyword: "rattan chair styling" }),
    row("dupImage", { imageUrl: "https://img/shared.jpg", sourceKeyword: "may 2026 nails" }),
    row("t1", { imageUrl: "https://img/other.jpg", sourceKeyword: "may 2026 nails" }),
    row("clean", { imageUrl: "https://img/clean.jpg", sourceKeyword: "may 2026 nails" }),
  ];
  const ranked = rankReferencesTiered(rows, input, 12);
  assert.deepEqual(ranked.map(r => r.id), ["t1", "clean"]);
  assert.equal(new Set(ranked.map(r => r.imageUrl)).size, ranked.length, "no imageUrl may repeat");
});

test("10c. limit is respected, and Tier 2 backfills up to it", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Rattan Accent Chair" };
  const rows = [
    row("e1", { imageUrl: "https://img/e1.jpg", sourceKeyword: "rattan chair styling" }),
    ...Array.from({ length: 20 }, (_, i) => row(`c${i}`, { imageUrl: `https://img/c${i}.jpg`, sourceKeyword: "may 2026 nails", saveCount: 1000 - i })),
  ];
  const ranked = rankReferencesTiered(rows, input, 5);
  assert.equal(ranked.length, 5, "limit respected");
  assert.equal(ranked[0].id, "e1", "the single Tier-1 item leads");
  assert.equal(ranked.filter(r => r.recommendationTier === "category_fallback").length, 4, "Tier 2 backfills the rest");
  assert.equal(rankReferencesTiered(rows, input, 0).length, 21, "limit <= 0 returns everything");
});

test("10d. existing safety filters are intact (watermark / low quality / no image)", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Rattan Accent Chair" };
  const rows = [
    row("ok", { sourceKeyword: "rattan chair styling" }),
    row("wm", { imageUrl: "https://img/wm.jpg", sourceKeyword: "rattan chair styling", watermarkDetected: true }),
    row("lowq", { imageUrl: "https://img/lowq.jpg", sourceKeyword: "rattan chair styling", imageQualityBand: "low" }),
    row("noimg", { imageUrl: "", sourceKeyword: "rattan chair styling" }),
  ];
  const ids = rankReferencesTiered(rows, input, 12).map(r => r.id);
  assert.deepEqual(ids, ["ok"], "unsafe rows must be dropped in BOTH tiers, not merely demoted");
});

test("10e. the empty-result rate is 0% by construction whenever the pool is non-empty", () => {
  // Sweep the round-2 named zero-bridge products. Under the naive de-saturation these were
  // 37% empty; here every one must return the full baseline.
  const pool = [
    row("k1", { category: "fashion", imageUrl: "https://img/k1.jpg", sourceKeyword: "outfit ideas for school" }),
    row("k2", { category: "fashion", imageUrl: "https://img/k2.jpg", sourceKeyword: "aesthetic wallpaper" }),
    row("k3", { category: "fashion", imageUrl: "https://img/k3.jpg", sourceKeyword: "mens fashion casual outfits" }),
  ];
  const zeroBridge = [
    "larssonjennings", "Tate Deep Tan", "STRAPSTORY MIX BAG - 408 - Standard Size",
    "Raquel Gold-Tone Stainless Steel Date Watch", "CORRIE SMALL CLUTCH",
    "Louis Vuitton LV Monogram Hobo XL", "T-Bar Figaro Necklace",
    "Michael Kors Bags | Michael Kors Hamilton Acorn Xl Tote",
    "Feeling Good Platform Mules - Brown", "DECAL - 18240", "Chair, acacia",
  ];
  for (const title of zeroBridge) {
    const ranked = rankReferencesTiered(pool, { category: "fashion", productTitle: title }, 12);
    assert.equal(ranked.length, pool.length, `"${title}" must never return an empty list`);
  }
});

// ── 11. THE BUG: a Tier-2 item carrying scene_match/style must not claim product_* ──

test("11. a Tier-2 item carrying scene_match/style signals produces NO product_* basis and NO product reason", () => {
  // Construction of the trap, and why it is REACHABLE in production:
  // `scoreReference` computes scene_match after stripping only the INPUT category's words,
  // so a candidate from a DIFFERENT category can match on its own category name and emit
  // `scene_match`. `productEvidenceScore` strips BOTH sides' category words, so its evidence
  // is correctly 0. Mixed-category pools really do occur: when the request carries no
  // recognized category the route queries the whole P0 set rather than one category.
  // `results.some(hasProductEvidence)` — the naive implementation — reports product_* here.
  const input: ReferenceScoringInput = {
    category: "home-decor",
    productTitle: "Beauty Vanity Mirror Tray",   // "beauty" is a genuine product word here
  };
  const trap = row("trap", {
    category: "beauty",                          // …and also this row's category name
    sourceKeyword: "beauty", title: "", visualFormat: "flat_lay", saveCount: 400_000,
  });

  const ranked = rankReferencesTiered([trap], input, 12);
  assert.equal(ranked.length, 1);
  const item = ranked[0];

  // Precondition: the trap really does carry the misleading signals.
  assert.ok(item.signals.includes("style") || item.signals.includes("scene_match"),
    `the fixture must actually carry the misleading signals (got ${item.signals})`);
  // …and it is nonetheless Tier 2.
  assert.equal(item.recommendationTier, "category_fallback",
    "a category-name collision is not category-free PRODUCT evidence — this must be Tier 2");

  // 1) basis must NOT be resurrected
  assert.equal(deriveRecommendationBasis({ hasAnalysis: true, hasText: true, results: ranked }), "category_fallback");
  assert.equal(deriveRecommendationBasis({ hasAnalysis: false, hasText: true, results: ranked }), "category_fallback");

  // 2) the reason must NOT make a product-match claim
  assert.ok(!/matches your product details/i.test(item.reason), `Tier 2 must not claim a product match: "${item.reason}"`);
  assert.ok(!/matches your style/i.test(item.reason), `Tier 2 must not claim a style match: "${item.reason}"`);
  assert.ok(/inspiration/i.test(item.reason), `Tier 2 must use inspiration phrasing: "${item.reason}"`);
  assert.ok(!/\d/.test(item.reason), "reason must never carry a fabricated number");

  // 3) and the naive check would indeed have got this wrong — the regression is real
  assert.ok(
    ranked.some(r => (r.signals ?? []).some(s => ["scene_match", "style"].includes(s))),
    "sanity: the signal-based check WOULD have returned true here, which is why tier is authoritative",
  );
});

test("11b. only Tier 1 may show a product-match reason", () => {
  const input: ReferenceScoringInput = { category: "home-decor", style: "boho", productTitle: "Rattan Accent Chair" };
  const ranked = rankReferencesTiered([
    row("real", { sourceKeyword: "boho rattan chair corner" }),
    row("bg", { imageUrl: "https://img/bg.jpg", sourceKeyword: "boho", saveCount: 400_000 }),
  ], input, 12);
  for (const r of ranked) {
    const claimsProduct = /matches your/i.test(r.reason);
    if (r.recommendationTier === "category_fallback") {
      assert.ok(!claimsProduct, `Tier 2 must not claim a match: "${r.reason}"`);
      assert.ok(/inspiration/i.test(r.reason), `Tier 2 must use inspiration phrasing: "${r.reason}"`);
    }
  }
  const t1 = ranked.find(r => r.recommendationTier === "product_evidence");
  assert.ok(t1, "the genuinely matching pin must be Tier 1");
  assert.ok(/matches your/i.test(t1!.reason), `Tier 1 keeps its genuine reason: "${t1!.reason}"`);
});

// ── 6 (route contract). recommendationTier is INTERNAL ─────────────────────────

test("route contract: recommendationTier is stripped, item shape unchanged, imageUrl kept", () => {
  const input: ReferenceScoringInput = { category: "home-decor", productTitle: "Rattan Accent Chair" };
  const ranked = rankReferencesTiered([
    row("a", { sourceKeyword: "boho rattan chair corner", pinterestUrl: "https://pinterest.com/pin/1" }),
    row("b", { imageUrl: "https://img/b.jpg", sourceKeyword: "may 2026 nails" }),
  ], input, 12);
  assert.ok(ranked.every(r => r.recommendationTier != null), "the internal field exists before stripping");
  for (const item of ranked.map(toRecommendation)) {
    assert.ok(!("recommendationTier" in item), "recommendationTier must never be serialized");
    assert.ok(!("score" in item) && !("relevance" in item) && !("signals" in item));
    assert.deepEqual(
      Object.keys(item).sort(),
      ["category", "id", "imageUrl", "patternTags", "pinterestUrl", "reason", "source", "sourceUrl", "title"],
      "the item contract is unchanged",
    );
    assert.ok(item.imageUrl.length > 0, "imageUrl stays");
    assert.ok(!JSON.stringify(item.patternTags).includes("http"), "patternTags still carries no image URL");
    assert.equal(item.source, "pinterest");
  }
});

console.log(`\n${passed} product-evidence tests passed.`);
