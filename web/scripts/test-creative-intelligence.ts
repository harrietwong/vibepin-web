/**
 * Deterministic tests for the Creative Intelligence core (Phase 1).
 *
 * Covers: reference analysis, intent inference, and the 3-archetype direction
 * generator — including the reported bug (jeans+camisole+bag + street-style ref)
 * and the two new categories (DIY & Crafts, Travel).
 *
 * Run:  npx tsx scripts/test-creative-intelligence.ts
 */
import { analyzeReference, analyzeReferences } from "../src/lib/studio/referenceAnalysis";
import { inferCreativeIntent } from "../src/lib/studio/creativeIntent";
import { getRecommendedCreativeDirections, normalizeCategory } from "../src/lib/studio/creativeDirections";
import type { SelectedCreativeAsset } from "../src/lib/studio/creativeDirections";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

function product(title: string, extra: Partial<SelectedCreativeAsset> = {}): SelectedCreativeAsset {
  return { role: "product", imageUrl: `prod:${title}`, source: "upload", title, metadataConfidence: "stored", ...extra };
}
function reference(title: string, extra: Partial<SelectedCreativeAsset> = {}): SelectedCreativeAsset {
  return { role: "reference", imageUrl: `ref:${title}`, source: "upload", title, metadataConfidence: "stored", ...extra };
}

// ── Reference analysis ────────────────────────────────────────────────────────
console.log("\n=== Creative Intelligence — self-test ===\n");

const streetStyle = reference("street style outfit on model", { visualFormat: "on_body", humanPresence: "visible_person" });
const a1 = analyzeReference(streetStyle);
check("street-style ref → outfit_on_model", a1.referenceType === "outfit_on_model", `got ${a1.referenceType}`);
check("street-style ref → containsPerson true", a1.containsPerson === true);
check("on_body framing is half/full body", a1.framing === "half_body" || a1.framing === "full_body", `got ${a1.framing}`);
check("on_body has high confidence (vf+hp present)", a1.confidence === "high", `got ${a1.confidence}`);

const roomRef = analyzeReference(reference("cozy living room shelf vignette", { visualFormat: "room_scene", humanPresence: "no_person" }));
check("room_scene ref → room_scene type", roomRef.referenceType === "room_scene", `got ${roomRef.referenceType}`);
check("room_scene ref → containsPerson false", roomRef.containsPerson === false);
check("room_scene scene type = room", roomRef.sceneType === "room", `got ${roomRef.sceneType}`);

const flatLay = analyzeReference(reference("overhead flat lay knolling", {}));
check("flat lay (text only) → flat_lay", flatLay.referenceType === "flat_lay", `got ${flatLay.referenceType}`);

const bare = analyzeReference(reference(""));
check("empty ref → generic + low confidence", bare.referenceType === "generic" && bare.confidence === "low",
  `type=${bare.referenceType} conf=${bare.confidence}`);

// ── Intent inference ──────────────────────────────────────────────────────────
const fashionRefCtx = analyzeReferences([streetStyle]);
const fashionIntent = inferCreativeIntent({ category: "fashion", references: fashionRefCtx, hasProducts: true, hasOpportunity: false });
check("fashion + on-model ref → subject on_model", fashionIntent.subject === "on_model", `got ${fashionIntent.subject}`);
check("fashion intent outcome mentions model", /model/.test(fashionIntent.primaryOutcome));
check("fashion intent influencedBy has products+references+category",
  ["products", "references", "category"].every(t => fashionIntent.influencedBy.includes(t as never)));

const homeIntent = inferCreativeIntent({
  category: "home-decor",
  references: analyzeReferences([reference("room", { visualFormat: "room_scene" })]),
  hasProducts: true, hasOpportunity: false,
});
check("home-decor + room ref → styled_scene", homeIntent.subject === "styled_scene", `got ${homeIntent.subject}`);

// Guardrail: on-model reference but non-wearable category must NOT stay on_model
const homeWithModelRef = inferCreativeIntent({
  category: "home-decor",
  references: analyzeReferences([reference("model", { visualFormat: "on_body", humanPresence: "visible_person" })]),
  hasProducts: true, hasOpportunity: false,
});
check("home-decor + on-model ref → NOT on_model (guardrail)", homeWithModelRef.subject !== "on_model", `got ${homeWithModelRef.subject}`);

// ── 3-archetype direction generation (the reported bug) ───────────────────────
const fashionDirs = getRecommendedCreativeDirections({
  category: "fashion",
  assets: [product("blue denim jeans"), product("white lace camisole"), product("leather handbag"), streetStyle],
  hasOpportunity: false,
});
check("fashion: exactly 3 directions", fashionDirs.length === 3, `got ${fashionDirs.length}`);
check("fashion: kinds are closest/product/alternative",
  fashionDirs[0].kind === "closest_to_reference" && fashionDirs[1].kind === "product_focused" && fashionDirs[2].kind === "alternative",
  fashionDirs.map(d => d.kind).join(","));
check("fashion: Direction 1 reflects the on-model reference (not a generic flat lay)",
  /on-model|outfit portrait/i.test(fashionDirs[0].title), `got "${fashionDirs[0].title}"`);
check("fashion: Direction 1 influenced_by includes references",
  (fashionDirs[0].influencedBy ?? []).includes("references"));
check("fashion: every direction has why + confidence",
  fashionDirs.every(d => !!d.whyThisDirection && !!d.confidence));
check("fashion: Direction 1 high confidence (strong ref)", fashionDirs[0].confidence === "high", `got ${fashionDirs[0].confidence}`);
check("fashion: source is creative_intelligence", fashionDirs.every(d => d.source === "creative_intelligence"));

// No reference → Direction 1 degrades honestly
const noRefDirs = getRecommendedCreativeDirections({
  category: "fashion",
  assets: [product("blue denim jeans")],
  hasOpportunity: false,
});
check("no reference: still exactly 3", noRefDirs.length === 3);
check("no reference: Direction 1 low confidence + says 'no reference'",
  noRefDirs[0].confidence === "low" && /no reference/i.test(noRefDirs[0].whyThisDirection ?? ""),
  `conf=${noRefDirs[0].confidence}`);
check("no reference: Direction 1 influenced_by has NO references tag",
  !(noRefDirs[0].influencedBy ?? []).includes("references"));

// ── DIY & Crafts ──────────────────────────────────────────────────────────────
check("normalizeCategory: 'DIY & Crafts' → diy-crafts", normalizeCategory("DIY & Crafts") === "diy-crafts");
const diyDirs = getRecommendedCreativeDirections({
  category: "diy-crafts",
  assets: [product("crochet yarn kit"), reference("step by step tutorial", {})],
  hasOpportunity: false,
});
check("diy: 3 directions", diyDirs.length === 3);
check("diy: tutorial reference → Direction 1 is tutorial", /tutorial|step/i.test(diyDirs[0].title), `got "${diyDirs[0].title}"`);
check("diy: directions tagged diy-crafts category", diyDirs.every(d => d.category === "diy-crafts"));

// ── Travel ──────────────────────────────────────────────────────────────────
check("normalizeCategory: 'Travel' → travel", normalizeCategory("Travel") === "travel");
const travelDirs = getRecommendedCreativeDirections({
  category: "travel",
  assets: [reference("tropical beach destination", {})],
  hasOpportunity: true,
});
check("travel: 3 directions", travelDirs.length === 3);
check("travel: directions tagged travel category", travelDirs.every(d => d.category === "travel"));
check("travel: opportunity flows into influenced_by", travelDirs.some(d => (d.influencedBy ?? []).includes("opportunity")));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
