import assert from "node:assert/strict";
import {
  rankReferences,
  rankReferencesTiered,
  keywordClusterKey,
  scoreReference,
  normalizedSaves,
  normalizedQuality,
  isDisplayable,
  toPatternTags,
  toRecommendation,
  type ReferenceCandidateRow,
  type ReferenceScoringInput,
} from "../src/lib/studio/referenceScoring";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

// A boho home-decor draft context.
const bohoHome: ReferenceScoringInput = {
  category: "home-decor",
  style: "boho",
  colors: ["terracotta", "cream"],
  visibleObjects: ["rattan chair", "macrame wall hanging", "woven basket"],
  imageSummary: "A boho living room corner with a rattan chair, macrame wall hanging and woven baskets.",
  productTitle: "Rattan Accent Chair",
};

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

test("normalizedSaves: log-scaled bands, monotonic, capped at 1", () => {
  assert.equal(normalizedSaves(0), 0);
  assert.ok(normalizedSaves(1000) > 0.55 && normalizedSaves(1000) < 0.65);
  assert.ok(normalizedSaves(10_000) > 0.75 && normalizedSaves(10_000) < 0.85);
  assert.ok(normalizedSaves(1_000_000) <= 1);
  assert.ok(normalizedSaves(50_000) > normalizedSaves(5_000));
});

test("normalizedQuality: handles 0..1 and 0..100 scales; null → neutral-low", () => {
  assert.equal(normalizedQuality(0.9), 0.9);
  assert.equal(normalizedQuality(85), 0.85);
  assert.equal(normalizedQuality(null), 0.4);
  assert.equal(normalizedQuality(undefined), 0.4);
});

test("isDisplayable: drops watermark, low quality band, and missing image", () => {
  assert.equal(isDisplayable(row("a")), true);
  assert.equal(isDisplayable(row("b", { watermarkDetected: true })), false);
  assert.equal(isDisplayable(row("c", { imageQualityBand: "low" })), false);
  assert.equal(isDisplayable(row("d", { imageQualityBand: null })), true); // null is acceptable
  assert.equal(isDisplayable(row("e", { imageUrl: "" })), false);
});

test("rankReferences: relevance beats popularity (off-category high-save ranks lower)", () => {
  const relevant = row("relevant", {
    category: "home-decor",
    title: "boho living room with rattan chair and macrame",
    visualFormat: "lifestyle",
    humanPresence: "none",
    referenceQualityScore: 0.8,
    saveCount: 400,
    hasClearSubject: true,
  });
  const offTopicViral = row("viral", {
    category: "fashion",
    title: "streetwear outfit editorial",
    visualFormat: "lifestyle",
    humanPresence: "full",
    referenceQualityScore: 0.9,
    saveCount: 90_000, // hugely popular but off-topic
    hasClearSubject: true,
  });
  const ranked = rankReferences([offTopicViral, relevant], bohoHome, 12);
  assert.equal(ranked[0].id, "relevant", "relevant same-category pin must rank first despite far fewer saves");
  // Relevance floor: a 90k-save but off-category/off-topic pin has no relevance evidence and
  // is dropped entirely — popularity can never surface it (PRD §5.3 relevance-first).
  assert.ok(!ranked.some(r => r.id === "viral"), "off-topic viral pin must be dropped, not merely ranked lower");
});

test("rankReferences: relevance floor drops cross-category pool (category-less request)", () => {
  // Simulates a draft with NO category (analysis not ready): the pool spans categories and
  // the context only has the product title. Fashion/beauty pins with no title/scene overlap
  // must be dropped rather than surfaced by save_count.
  const noCategoryCtx: ReferenceScoringInput = { productTitle: "Modern all in graphic art print black frame" };
  const fashion = row("f", { category: "fashion", title: "streetwear outfit editorial", saveCount: 80_000, humanPresence: "full" });
  const beauty = row("b", { category: "beauty", title: "summer hair tutorial", saveCount: 60_000, humanPresence: "full" });
  const nails = row("n", { category: "beauty", title: "aqua nail art manicure", saveCount: 50_000, humanPresence: "hands" });
  const onTopic = row("art", { category: "home-decor", title: "modern graphic art print gallery wall", saveCount: 400 });
  const ranked = rankReferences([fashion, beauty, nails, onTopic], noCategoryCtx, 12);
  assert.ok(!ranked.some(r => ["f", "b", "n"].includes(r.id)), "off-topic high-save pins must be dropped");
  assert.ok(ranked.some(r => r.id === "art"), "the genuinely related art print must survive on scene overlap");
});

test("rankReferences: empty when nothing clears the relevance floor (no empty shell)", () => {
  const noCategoryCtx: ReferenceScoringInput = { productTitle: "walnut console table" };
  const fashion = row("f", { category: "fashion", title: "streetwear outfit editorial", saveCount: 80_000 });
  const beauty = row("b", { category: "beauty", title: "summer hair tutorial", saveCount: 60_000 });
  assert.equal(rankReferences([fashion, beauty], noCategoryCtx, 12).length, 0);
});

test("rankReferences: source_keyword drives within-category scene ranking (titles empty)", () => {
  // Real-world shape: pin_samples titles are empty; source_keyword holds the scene/style
  // vocabulary. A cottagecore-bedroom analysis must rank the matching pin above an
  // unrelated same-category pin, purely via source_keyword overlap.
  const ctx: ReferenceScoringInput = {
    category: "home-decor",
    style: "cottagecore",
    visibleObjects: ["bed", "curtains", "floral bedding"],
    imageSummary: "A cottagecore bedroom with floral bedding and soft curtains.",
  };
  const match = row("match", { title: " ", sourceKeyword: "cottagecore bedroom decor", saveCount: 300 });
  const other = row("other", { title: "", sourceKeyword: "summery wallpapers", saveCount: 9000 });
  const ranked = rankReferences([other, match], ctx, 12);
  assert.equal(ranked[0].id, "match", "source_keyword scene match must outrank an unrelated higher-save pin");
});

test("rankReferences: excludes non-displayable rows from the result", () => {
  const rows = [
    row("ok"),
    row("wm", { watermarkDetected: true }),
    row("lowq", { imageQualityBand: "low" }),
  ];
  const ids = rankReferences(rows, bohoHome).map(r => r.id);
  assert.ok(ids.includes("ok"));
  assert.ok(!ids.includes("wm"));
  assert.ok(!ids.includes("lowq"));
});

test("reason: whitelisted phrases only — no fabricated metric, no 'Trending', no numbers", () => {
  const s = scoreReference(
    row("r", { category: "home-decor", title: "cozy boho bedroom", visualFormat: "lifestyle", humanPresence: "none", saveCount: 20_000 }),
    bohoHome,
    new Set(["boho", "rattan", "chair", "macrame", "home", "decor"]),
  );
  assert.ok(s.reason.length > 0);
  assert.ok(!/trending/i.test(s.reason), "reason must never claim Trending");
  assert.ok(!/\d/.test(s.reason), "reason must not contain fabricated numeric metrics");
  assert.ok(/category|scene|style|saves/i.test(s.reason));
});

test("toPatternTags: derives prompt-safe TEXT tags and carries NO image url", () => {
  const tags = toPatternTags(row("p", {
    title: "cozy boho bedroom nook",
    visualFormat: "lifestyle",
    compositionType: "scene",
    humanPresence: "none",
    textOverlayLevel: "none",
  }));
  assert.equal(tags.visualFormat, "lifestyle");
  assert.equal(tags.compositionType, "scene");
  assert.equal(tags.humanPresence, "none");
  assert.ok((tags.sceneStyleWords ?? []).length > 0);
  assert.ok(!("imageUrl" in tags), "pattern tags must not carry an image url");
  assert.ok(!JSON.stringify(tags).includes("http"), "pattern tags must not carry any URL");
});

test("toRecommendation: strips internal score/signals, keeps linkback + source", () => {
  const s = scoreReference(row("x", { pinterestUrl: "https://pinterest.com/pin/1", sourceUrl: "https://src/1" }), bohoHome, new Set());
  const pub = toRecommendation(s);
  assert.ok(!("score" in pub), "public item must not expose internal score");
  assert.ok(!("relevance" in pub), "public item must not expose internal relevance");
  assert.ok(!("signals" in pub), "public item must not expose internal signals");
  assert.equal(pub.source, "pinterest");
  assert.equal(pub.sourceUrl, "https://pinterest.com/pin/1"); // linkback prefers the Pinterest pin
});

test("rankReferences: no analysis + no product still ranks category pool without throwing", () => {
  const ranked = rankReferences([row("a"), row("b", { imageUrl: "https://img/b2.jpg" })], { category: "home-decor" });
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every(r => typeof r.reason === "string" && r.reason.length > 0));
});

test("rankReferences: dedupes by id and imageUrl", () => {
  const dup = [
    row("a", { imageUrl: "https://img/same.jpg" }),
    row("a", { imageUrl: "https://img/same.jpg" }),
    row("b", { imageUrl: "https://img/same.jpg" }),
  ];
  const ranked = rankReferences(dup, bohoHome);
  assert.equal(ranked.length, 1, "same id/imageUrl must not appear twice");
});


// ── scrapedAt freshness tie-break + keyword-cluster cap (P0-e) ─────────────────

test("rankReferencesTiered: final tie-break is scrapedAt desc, then id asc", () => {
  // Every row here scores identically (same category / saves / quality, no crawl keyword),
  // so ONLY the tie-break can order them. Plain id-asc would give a, b, c, d, e.
  const rows = [
    row("a", { scrapedAt: "2026-08-01T00:00:00Z" }),
    row("b", { scrapedAt: "2026-08-20T00:00:00Z" }),
    row("c", { scrapedAt: null }),
    row("d", { scrapedAt: "2026-08-20T00:00:00Z" }),
    row("e"),   // scrapedAt absent entirely
  ];
  const ids = rankReferencesTiered(rows, { category: "home-decor" }, 12).map(r => r.id);
  assert.deepEqual(
    ids,
    ["b", "d", "a", "c", "e"],
    "freshest crawl first; equal timestamps fall back to id asc; null/absent counts as oldest",
  );
});

test("keywordClusterKey: order-free, normalized identity for a crawl keyword", () => {
  assert.equal(keywordClusterKey("back to school outfit inspo"), "back outfit school");
  assert.equal(
    keywordClusterKey("back 2 school outfits"),
    keywordClusterKey("back to school outfit inspo"),
    "plural + filler variants of one keyword must collapse into the same cluster",
  );
  assert.equal(keywordClusterKey("school back outfit"), "back outfit school", "word order must not matter");
  assert.equal(keywordClusterKey("outfit outfits outfit"), "outfit", "duplicates collapse to one");
  // The six variants MEASURED on the live fashion pool: under a full-word-set key each was
  // its own cluster, so cap = 2 still left 9 of 9 top slots to one theme.
  const backToSchool = [
    "back to school outfit inspo",
    "back 2 school outfits senior",
    "back to school outfits boys",
    "back to school outfit inspo high school",
    "back 2 school outfits uniform",
    "back to school outfits 2026-2027",
  ];
  for (const kw of backToSchool) {
    assert.equal(keywordClusterKey(kw), "back outfit school", "measured variant must join the back-to-school cluster: " + kw);
  }
  assert.equal(
    new Set(backToSchool.map(kw => keywordClusterKey(kw))).size,
    1,
    "all six measured variants must collapse into ONE cluster",
  );
  assert.equal(
    keywordClusterKey("outfit ideas summer"),
    keywordClusterKey("summer outfit ideas"),
    "stop words drop out and word order must not matter",
  );
  // …and the key must still SEPARATE genuinely different themes (no over-merging).
  assert.notEqual(
    keywordClusterKey("cozy bedroom aesthetic"),
    keywordClusterKey("cozy reading nook ideas"),
    "keywords with different leading vocabulary must stay in different clusters",
  );
  for (const empty of ["", "   ", "a to the", null, undefined]) {
    assert.equal(keywordClusterKey(empty), "", String(empty) + " carries no usable keyword");
  }
});

// Product vocabulary is gold / hoop / earring. Tier-1 admission comes from the TITLE, which
// leaves the crawl keyword free to be shared across tiers — that is what makes the CROSS-tier
// cluster accounting observable.
const capInput: ReferenceScoringInput = { category: "fashion", productTitle: "Gold Hoop Earrings" };
const HOT_KEYWORD = "cozy neutral aesthetic";   // the monopolising crawl keyword

function capRows(): ReferenceCandidateRow[] {
  const fashion = (id: string, o: Partial<ReferenceCandidateRow> = {}) =>
    row(id, { category: "fashion", ...o });
  return [
    // 5 Tier-1 rows sharing ONE crawl keyword — evidence 3 hits / sqrt(6)
    ...[1, 2, 3, 4, 5].map(i => fashion("t1-same-" + i, { title: "gold hoop earrings", sourceKeyword: HOT_KEYWORD })),
    // 2 Tier-1 rows from other keywords, strictly lower evidence — 2 hits / sqrt(5)
    fashion("t1-alt-a", { title: "gold hoop", sourceKeyword: "linen shirt outfit" }),
    fashion("t1-alt-b", { title: "gold hoop", sourceKeyword: "denim jacket layer" }),
    // Tier-2 backfill: no product words at all ("reference" is a stop word)
    fashion("t2-x", { sourceKeyword: "summery wallpapers" }),
    fashion("t2-same", { sourceKeyword: HOT_KEYWORD }),   // same cluster as the Tier-1 five
  ];
}

test("rankReferencesTiered: keywordClusterCap breaks one keyword's monopoly (demote, never drop)", () => {
  const rows = capRows();
  const uncapped = rankReferencesTiered(rows, capInput, 12).map(r => r.id);
  assert.deepEqual(
    uncapped,
    ["t1-same-1", "t1-same-2", "t1-same-3", "t1-same-4", "t1-same-5", "t1-alt-a", "t1-alt-b", "t2-x", "t2-same"],
    "precondition: uncapped, a single crawl keyword owns the whole Tier-1 head",
  );

  const capped = rankReferencesTiered(rows, capInput, 12, { keywordClusterCap: 2 });
  assert.deepEqual(
    capped.map(r => r.id),
    [
      // Tier-1 keeps → Tier-2 keeps → Tier-1 overflow → Tier-2 overflow
      "t1-same-1", "t1-same-2", "t1-alt-a", "t1-alt-b",
      "t2-x",
      "t1-same-3", "t1-same-4", "t1-same-5",
      "t2-same",
    ],
  );
  const head = capped.slice(0, 5).map(r => r.id);
  assert.equal(
    head.filter(id => id.startsWith("t1-same")).length,
    2,
    "the monopolising cluster may hold at most cap slots in the head",
  );
  assert.ok(
    head.indexOf("t1-alt-a") < capped.map(r => r.id).indexOf("t1-same-3"),
    "other-cluster Tier-1 rows must rank ahead of the demoted overflow",
  );
  assert.deepEqual(
    capped.map(r => r.id).sort(),
    [...uncapped].sort(),
    "the cap is a reorder — it must never filter a row out",
  );
  // Cluster counting is CROSS-tier: t2-same is in the cluster Tier-1 already exhausted.
  assert.equal(capped[capped.length - 1].id, "t2-same", "a Tier-2 row in an exhausted cluster is demoted too");
  // Tiers themselves are untouched by the cap.
  assert.equal(capped.find(r => r.id === "t1-same-5")?.recommendationTier, "product_evidence");
  assert.equal(capped.find(r => r.id === "t2-same")?.recommendationTier, "category_fallback");
});

test("rankReferencesTiered: no opts, {}, and a non-positive cap are all the legacy path", () => {
  const rows = capRows();
  const base = rankReferencesTiered(rows, capInput, 12).map(r => r.id);
  assert.deepEqual(rankReferencesTiered(rows, capInput, 12, {}).map(r => r.id), base);
  assert.deepEqual(rankReferencesTiered(rows, capInput, 12, { keywordClusterCap: undefined }).map(r => r.id), base);
  assert.deepEqual(rankReferencesTiered(rows, capInput, 12, { keywordClusterCap: 0 }).map(r => r.id), base);
  assert.deepEqual(rankReferencesTiered(rows, capInput, 12, { keywordClusterCap: -1 }).map(r => r.id), base);
});
console.log(`\n${passed} reference-scoring tests passed.`);
