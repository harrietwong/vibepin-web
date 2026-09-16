import assert from "node:assert/strict";
import {
  rankKeywords,
  buildQueryTerms,
  isTooGeneric,
  normalizedVolume,
  type KeywordRow,
  type KeywordContextInput,
} from "../src/lib/ai-copy/keywordContext";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

// A living-room image context (modern / minimalist — NOT mid-century, NOT christmas).
const livingRoom: KeywordContextInput = {
  imageSummary: "A modern living room corner with a bright yellow armchair, gold floor lamp, framed abstract wall art, a side table, an area rug and light wood flooring.",
  visibleObjects: ["yellow armchair", "gold floor lamp", "framed abstract art", "side table", "area rug", "media console"],
  style: "modern minimalist",
  boardName: "Living Room Ideas",
  category: "home-decor",
};

function row(keyword: string, opts: Partial<KeywordRow> = {}): KeywordRow {
  return { id: keyword, keyword, category: "home-decor", search_volume_level: "high", ...opts };
}

test("normalizedVolume: bands + very_high + unscored fallback", () => {
  assert.ok(normalizedVolume({ search_volume_level: "very_high" }) > 0.9);
  assert.equal(normalizedVolume({ search_volume_level: "high" }), 0.85);
  assert.equal(normalizedVolume({ search_volume_level: "medium" }), 0.55);
  assert.equal(normalizedVolume({ search_volume_level: "low" }), 0.3);
  // unscored → falls back to priority score
  assert.ok(Math.abs(normalizedVolume({ search_volume_level: "unscored", priority_score: 50 }) - 0.5) < 1e-9);
});

test("isTooGeneric: bare generic rejected, specific-modifier kept", () => {
  assert.equal(isTooGeneric("home decor"), true);
  assert.equal(isTooGeneric("inspiration"), true);
  assert.equal(isTooGeneric("product ideas"), true);
  assert.equal(isTooGeneric("living room decor ideas"), false);
  assert.equal(isTooGeneric("mid century modern living room"), false);
});

test("buildQueryTerms: board phrase leads; canonical shapes present", () => {
  const terms = buildQueryTerms(livingRoom);
  assert.equal(terms[0], "living room", "board phrase should be the first (highest-priority) term");
  assert.ok(terms.includes("modern minimalist"));
});

test("rankKeywords: relevant living-room keywords are recommended", () => {
  const rows = [
    row("living room decor ideas", { priority_score: 116 }),
    row("home decor ideas living room", { search_volume_level: "low" }),
    row("rug layering living room", { search_volume_level: "unscored", priority_score: 18 }),
  ];
  const { recommended } = rankKeywords(rows, livingRoom);
  assert.ok(recommended.includes("living room decor ideas"));
  assert.ok(recommended.length >= 2 && recommended.length <= 8);
});

test("rankKeywords: unrelated high-volume keyword is NOT recommended", () => {
  const rows = [
    row("living room decor ideas", { priority_score: 116, search_volume_level: "high" }),
    row("christmas decor ideas for living room", { category: "holidays-seasonal", search_volume_level: "very_high" }),
    row("boho living room ideas", { search_volume_level: "medium" }),
    row("mid century modern living room", { search_volume_level: "very_high" }),
  ];
  const { recommended, rejected } = rankKeywords(rows, livingRoom);
  assert.ok(!recommended.includes("christmas decor ideas for living room"), "christmas keyword must be rejected on a modern image");
  assert.ok(!recommended.includes("boho living room ideas"), "boho does not match a modern image");
  assert.ok(!recommended.includes("mid century modern living room"), "mid-century does not match a modern image");
  assert.ok(rejected.some(r => r.keyword.startsWith("christmas") && r.reason.startsWith("low_coverage")));
});

test("rankKeywords: never selects purely by volume (relevance floor)", () => {
  const rows = [
    row("wedding table decor", { category: "wedding", search_volume_level: "very_high" }),
    row("resume template modern", { category: "digital-products", search_volume_level: "very_high" }),
  ];
  const { recommended } = rankKeywords(rows, livingRoom);
  assert.equal(recommended.length, 0, "irrelevant high-volume keywords yield no recommendations");
});

test("rankKeywords: candidates capped at 20 and generic bare terms rejected", () => {
  const rows = [row("home decor"), row("inspiration"), ...Array.from({ length: 30 }, (_, i) => row(`living room decor ideas ${i}`))];
  const { candidates, recommended } = rankKeywords(rows, livingRoom);
  assert.ok(candidates.length <= 20);
  assert.ok(!recommended.includes("home decor"));
  assert.ok(!recommended.includes("inspiration"));
});

// ── Product + direction input dimensions (A1) ─────────────────────────────────

test("buildQueryTerms: product type + title feed query terms", () => {
  const terms = buildQueryTerms({ ...livingRoom, productType: "table lamp", productTitle: "Brass Arc Floor Lamp" });
  assert.ok(terms.includes("table lamp"), "product type should be a query term");
  assert.ok(terms.includes("floor lamp"), "product title 2-word tail should be a query term");
});

test("buildQueryTerms: direction words are appended as query terms", () => {
  const terms = buildQueryTerms({
    imageSummary: "a potted plant on a wooden shelf", visibleObjects: ["potted plant"], style: "",
    directionTitle: "Styled tabletop", directionTerms: ["editorial mood"],
  });
  assert.ok(["styled", "tabletop", "editorial", "mood"].some(w => terms.includes(w)), "direction words should appear in query terms");
});

test("rankKeywords: product context lifts a product-specific keyword absent from the image", () => {
  const rows = [row("soy candle gift", { category: "home-decor", priority_score: 40 })];
  const withoutProduct = rankKeywords(rows, livingRoom);
  assert.ok(!withoutProduct.recommended.includes("soy candle gift"), "off-image keyword rejected without product context");
  const withProduct = rankKeywords(rows, { ...livingRoom, productTitle: "Scented Soy Candle", productType: "soy candle", productTags: ["candle"] });
  assert.ok(withProduct.recommended.includes("soy candle gift"), "product context makes the product keyword relevant");
});

test("rankKeywords: product context does not change scoring when absent (no regression)", () => {
  const rows = [row("living room decor ideas", { priority_score: 116 })];
  const a = rankKeywords(rows, livingRoom).candidates[0];
  const b = rankKeywords(rows, { ...livingRoom, productTitle: undefined, productTags: [], directionTerms: [] }).candidates[0];
  assert.equal(a.finalScore, b.finalScore, "empty product/direction inputs leave scores identical");
});

test("rankKeywords: a matching direction never lowers a relevant keyword's score", () => {
  const rows = [row("side table styling", { category: "home-decor", priority_score: 30 })];
  const base = rankKeywords(rows, livingRoom).candidates.find(c => c.keyword === "side table styling");
  const withDir = rankKeywords(rows, { ...livingRoom, directionTitle: "Styled decor vignette", directionTerms: ["styling"] })
    .candidates.find(c => c.keyword === "side table styling");
  assert.ok(base && withDir, "keyword present in both candidate sets");
  assert.ok(withDir!.relevanceScore >= base!.relevanceScore, "direction overlap is a non-negative nudge");
});


test("rankKeywords: midcentury decor is selected with mid-century context", () => {
  const midcenturyContext: KeywordContextInput = {
    imageSummary: "A stylish mid-century modern living room with vintage sofa.",
    visibleObjects: ["mid-century sofa", "coffee table"],
    style: "mid-century",
    boardName: "Mid-Century Living Room",
    category: "home-decor",
  };
  const rows = [row("midcentury decor", { data_quality: "official", search_volume_level: "high" })];
  const { recommended, rejected } = rankKeywords(rows, midcenturyContext);
  assert.ok(recommended.includes("midcentury decor"));
  assert.ok(!rejected.some(r => r.keyword === "midcentury decor"));
});

test("rankKeywords: typographic dashes retain legacy midcentury matching", () => {
  for (const style of ["mid‑century", "mid–century", "mid—century"]) {
    const context: KeywordContextInput = {
      imageSummary: `A stylish ${style} modern living room with vintage sofa.`,
      visibleObjects: [`${style} sofa`, "coffee table"],
      style,
      boardName: `${style} Living Room`,
      category: "home-decor",
    };
    const rows = [row("midcentury decor", { data_quality: "official", search_volume_level: "high" })];
    assert.ok(rankKeywords(rows, context).recommended.includes("midcentury decor"), style);
  }
});

test("rankKeywords: Korean demand modifiers do not dilute distinctive-word coverage", () => {
  const koreanContext: KeywordContextInput = {
    imageSummary: "모던 거실에 소파와 테이블이 있는 공간",
    visibleObjects: ["모던 거실", "소파", "테이블"],
    style: "모던",
    boardName: "거실 아이디어",
    category: "home-decor",
    language: "ko-KR",
  };
  const rows = [row("모던 거실 인테리어 아이디어", {
    data_quality: "official",
    search_volume_level: "high",
    language: "ko",
    locale: "ko-KR",
  })];
  const { recommended, rejected } = rankKeywords(rows, koreanContext);
  assert.ok(recommended.includes("모던 거실 인테리어 아이디어"));
  assert.ok(!rejected.some(r => r.keyword === "모던 거실 인테리어 아이디어"));
});

test("rankKeywords: 现代客厅装饰灵感 is recommended with matching Chinese context", () => {
  const chineseContext: KeywordContextInput = {
    imageSummary: "现代风格的客厅空间，配有灰色布艺沙发、茶几和落地窗。",
    visibleObjects: ["现代客厅", "布艺沙发", "茶几"],
    style: "现代",
    boardName: "现代客厅",
    category: "home-decor",
    language: "zh",
  };
  const rows = [row("现代客厅装饰灵感", { data_quality: "official", search_volume_level: "high", language: "zh", locale: "zh-CN" })];
  const { recommended, rejected } = rankKeywords(rows, chineseContext);
  assert.ok(recommended.includes("现代客厅装饰灵感"));
  assert.ok(!rejected.some(r => r.keyword === "现代客厅装饰灵感"));
});

console.log(`\nAll ${passed} keyword-context tests passed.`);
