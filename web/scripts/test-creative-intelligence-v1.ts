/**
 * Creative Intelligence V1 test matrix — product analysis, intent, directions,
 * and the hidden prompt builder across categories.
 *
 * Run:  npx tsx scripts/test-creative-intelligence-v1.ts
 */
import { analyzeProductSet } from "../src/lib/studio/productAnalysis";
import fs from "node:fs";
import { analyzeReferences } from "../src/lib/studio/referenceAnalysis";
import { inferCreativeIntent } from "../src/lib/studio/creativeIntent";
import { getCategoryPlaybook } from "../src/lib/studio/categoryPlaybooks";
import { buildHiddenPrompt, inferReferenceInfluenceMode } from "../src/lib/studio/hiddenPromptBuilder";
import {
  getRecommendedCreativeDirections, inferCreativeCategory,
  type SelectedCreativeAsset, type CategoryPlaybookId,
} from "../src/lib/studio/creativeDirections";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
function p(title: string, category?: string): SelectedCreativeAsset {
  return { role: "product", imageUrl: `p:${title}`, source: "upload", title, category, metadataConfidence: "stored" };
}
function r(title: string, vf?: string, hp?: string): SelectedCreativeAsset {
  return { role: "reference", imageUrl: `r:${title}`, source: "upload", title, visualFormat: vf, humanPresence: hp, metadataConfidence: "stored" };
}

// Helper: full pipeline for an assets bundle.
function pipeline(category: string, assets: SelectedCreativeAsset[], opts: { keyword?: string; refinement?: string; controls?: Record<string, string> } = {}) {
  const cat = inferCreativeCategory({ explicitCategory: category, assets }) as CategoryPlaybookId;
  const productSet = analyzeProductSet(assets);
  const references = analyzeReferences(assets, {
    productCategory: cat,
    isCompleteOutfit: productSet.category === "fashion" && productSet.isCoherentSet,
  });
  const intent = inferCreativeIntent({
    category: cat, references, hasProducts: productSet.hasProducts, hasOpportunity: !!opts.keyword,
    productSetSummary: productSet.setSummary, primaryProductTitle: productSet.products[0]?.title,
    keyword: opts.keyword, refinement: opts.refinement,
  });
  const directions = getRecommendedCreativeDirections({ category, assets, hasOpportunity: !!opts.keyword });
  const hidden = buildHiddenPrompt({
    direction: directions[0], productSet, references, intent,
    playbook: getCategoryPlaybook(cat), controls: opts.controls ?? {},
    refinement: opts.refinement, opportunityKeyword: opts.keyword, format: "2:3",
  });
  const promptInput = {
    direction: directions[0], productSet, references, intent,
    playbook: getCategoryPlaybook(cat), controls: opts.controls ?? {},
    refinement: opts.refinement, opportunityKeyword: opts.keyword, format: "2:3",
  };
  const referenceInfluenceMode = inferReferenceInfluenceMode(promptInput);
  return { cat, productSet, references, intent, directions, hidden, referenceInfluenceMode, promptInput };
}

console.log("\n=== Creative Intelligence V1 — test matrix ===\n");

// ── Fashion: jeans + camisole + handbag + street-style reference ──────────────
{
  const { productSet, directions, hidden } = pipeline("fashion", [
    p("blue denim jeans"), p("white lace camisole"), p("leather handbag"),
    r("street style outfit on model", "on_body", "visible_person"),
  ]);
  check("FASHION: product roles include bottom+top+bag",
    ["bottom", "top", "bag"].every(role => productSet.products.some(pp => pp.role === role)),
    productSet.products.map(pp => pp.role).join(","));
  check("FASHION: detected complete outfit set", productSet.isCoherentSet && /outfit/.test(productSet.setSummary), productSet.setSummary);
  check("FASHION: closest direction is on-model (not flat lay)", /on-model|outfit portrait/i.test(directions[0].title) && !/flat lay/i.test(directions[0].title), directions[0].title);
  check("FASHION: hidden prompt says ORIGINAL model", /original (model|person)/i.test(hidden));
  check("FASHION: hidden prompt forbids identity copy", /do not copy.*(identity|face|likeness)/i.test(hidden));
  check("FASHION: hidden prompt includes all 3 products", ["jeans", "camisole", "handbag"].every(t => hidden.toLowerCase().includes(t)));
  check("FASHION: hidden prompt is vertical 2:3", /2:3/.test(hidden));
}

// ── Home Decor: sofa + rug + lamp + living room reference ─────────────────────
{
  const { productSet, directions, hidden } = pipeline("home-decor", [
    p("velvet sofa"), p("wool area rug"), p("brass floor lamp"),
    r("styled living room interior", "room_scene", "no_person"),
  ]);
  check("HOME: detected room scene set", productSet.isCoherentSet && /room/.test(productSet.setSummary), productSet.setSummary);
  check("HOME: closest direction is room scene", /room scene/i.test(directions[0].title), directions[0].title);
  check("HOME: a product-focused vignette/room direction exists", directions.some(d => /vignette|room/i.test(d.title)));
  check("HOME: hidden prompt has NO on-model/person logic", !/original (model|person)|worn by/i.test(hidden));
  check("HOME: hidden prompt mentions interior/room", /interior|room|vignette/i.test(hidden));
}

// ── Beauty: lipstick + foundation + application reference ─────────────────────
{
  const { productSet, directions, hidden } = pipeline("beauty", [
    p("matte red lipstick"), p("liquid foundation"),
    r("makeup application close up", "on_body", "visible_person"),
  ]);
  check("BEAUTY: roles include lip + face product", productSet.products.some(pp => pp.role === "lip_product") && productSet.products.some(pp => pp.role === "face_product"));
  check("BEAUTY: directions mention application/face/product", directions.some(d => /application|face|product|routine|editorial/i.test(d.title)));
  check("BEAUTY: hidden prompt has NO home-decor logic", !/interior|room|vignette/i.test(hidden));
  check("BEAUTY: hidden prompt keeps packaging visible", /packaging|recognizable|visible/i.test(hidden));
}

// ── Digital Product: printable planner + info-rich reference ──────────────────
{
  const { cat, directions, hidden } = pipeline("digital-products", [
    p("printable weekly planner PDF"),
    r("information rich checklist pin", undefined, undefined),
  ], { controls: { textOverlay: "Information-rich" } });
  check("DIGITAL: category resolves to digital-products", cat === "digital-products", cat);
  check("DIGITAL: a mockup/preview direction exists", directions.some(d => /mockup|preview|information|layout|checklist/i.test(d.title)));
  check("DIGITAL: hidden prompt is benefit-led / information hierarchy", /information hierarchy|benefit-led|mockup|preview/i.test(hidden));
  check("DIGITAL: hidden prompt warns against pure decorative photo", /decorative lifestyle photo/i.test(hidden));
  check("DIGITAL: hidden prompt allows text (information-rich)", /TEXT OVERLAY/i.test(hidden) && !/ZERO TEXT/i.test(hidden));
}

// ── Food & Drink ──────────────────────────────────────────────────────────────
{
  const { cat, directions, hidden } = pipeline("food-and-drink", [
    p("iced matcha latte drink"),
    r("food close up recipe", undefined, undefined),
  ]);
  check("FOOD: category resolves to food-and-drink", cat === "food-and-drink", cat);
  check("FOOD: directions are food/recipe (no fashion/home)", directions.every(d => !/outfit|room scene|vignette/i.test(d.title)));
  // "interior room staging" legitimately appears in the Avoid: clause — check only the positive body.
  const foodPositive = hidden.split(/Avoid:/i)[0];
  check("FOOD: positive body has no fashion/home logic", !/original (model|person)|interior room scene|stage the products in a styled room/i.test(foodPositive));
  check("FOOD: food guidance present (appetizing/food/drink)", /appetizing|food|drink/i.test(hidden));
}

// ── Products only (no reference) ──────────────────────────────────────────────
{
  const { directions } = pipeline("fashion", [p("denim jacket")]);
  check("PRODUCTS-ONLY: still exactly 3 directions", directions.length === 3);
  check("PRODUCTS-ONLY: closest degrades to low confidence", directions[0].confidence === "low");
}

// ── Reference only (no products) ──────────────────────────────────────────────
{
  const { productSet, directions, intent } = pipeline("", [r("cozy living room interior", "room_scene", "no_person")], { keyword: "living room ideas" });
  check("REF-ONLY: no products detected", !productSet.hasProducts);
  check("REF-ONLY: 3 directions from reference format", directions.length === 3);
  check("REF-ONLY: intent summary references the reference", /reference|inspired/i.test(intent.userVisibleSummary), intent.userVisibleSummary);
}

// ── Opportunity only ──────────────────────────────────────────────────────────
{
  const { directions, intent } = pipeline("", [], { keyword: "fall capsule wardrobe" });
  check("OPP-ONLY: 3 directions", directions.length === 3);
  check("OPP-ONLY: keyword surfaces in intent", /fall capsule wardrobe/i.test(intent.userVisibleSummary), intent.userVisibleSummary);
}

// ── Unknown category → general fallback, NEVER home decor ─────────────────────
{
  const { cat, directions, hidden } = pipeline("", [p("mysterious gadget thingamajig")]);
  check("UNKNOWN: category is generic (not home-decor)", cat === "generic", cat);
  check("UNKNOWN: directions are generic, not home decor", directions.every(d => d.category === "generic"));
  check("UNKNOWN: hidden prompt does NOT force interior/home staging", /do not default to bedroom|do not default to home|not home decor/i.test(hidden) || !/interior room scene/i.test(hidden));
}

// ── Refinement is high priority ───────────────────────────────────────────────
{
  const { hidden } = pipeline("fashion", [p("silk dress"), r("editorial", "on_body", "visible_person")], { refinement: "warm golden hour lighting, no text" });
  check("REFINEMENT: appears as high-priority instruction", /DIRECTION BRIEF/i.test(hidden) && /Honor these instructions/i.test(hidden) && /golden hour/i.test(hidden));
}

// ── Requirement #8: reference-quality regression matrix ──────────────────────
console.log("\n--- Reference-quality matrix ---");

// Required: fashion complete outfit + street-style reference should make the
// reference structural, not weak inspiration.
{
  const { hidden, referenceInfluenceMode } = pipeline("fashion", [
    p("blue flare jeans"), p("blue paisley camisole top"), p("shoulder bag"),
    r("outdoor urban candid street style influencer outfit, full body", "on_body", "visible_person"),
  ]);
  check("REQ1: street-style fashion ref uses layout_scene_strong",
    referenceInfluenceMode === "layout_scene_strong", referenceInfluenceMode);
  check("REQ1: prompt includes outdoor urban/street-style setting",
    /outdoor urban|urban\/street-style|city\/sidewalk\/street/i.test(hidden), hidden);
  check("REQ1: reference controls scene/framing/composition/pose energy",
    /REFERENCE REQUIREMENTS[^:\n]*:[\s\S]*scene type[\s\S]*framing[\s\S]*composition[\s\S]*pose energy/i.test(hidden), hidden);
  check("REQ1: REFERENCE REQUIREMENTS leads the prompt (before PRODUCT)",
    hidden.indexOf("REFERENCE REQUIREMENTS") < hidden.indexOf("PRODUCT REQUIREMENTS"), hidden);
  check("REQ1: no soft reference wording (inspired by / borrow style / take cues)",
    !/inspired by|borrow style from|take cues from/i.test(hidden), hidden);
  check("REQ1: prompt avoids studio/catalog/plain backdrop",
    /plain studio backdrop/i.test(hidden) && /ecommerce catalog pose/i.test(hidden) && /generic beige wall/i.test(hidden), hidden);
  check("REQ1: prompt preserves product requirements",
    ["blue paisley camisole", "blue flare jeans", "shoulder bag"].every(t => hidden.toLowerCase().includes(t)), hidden);
}

// Required: outfit-on-model reference remains on-model and must not become flat lay.
{
  const { hidden, referenceInfluenceMode } = pipeline("fashion", [
    p("linen camisole top"), p("flare jeans"), p("woven shoulder bag"),
    r("editorial outfit on model wearing summer look", "on_body", "visible_person"),
  ]);
  check("REQ2: outfit-on-model ref uses layout_scene_strong",
    referenceInfluenceMode === "layout_scene_strong", referenceInfluenceMode);
  check("REQ2: prompt enforces original model wearing products",
    /original model wearing the selected products together/i.test(hidden), hidden);
  const beforeAvoid = hidden.split(/STRICTLY AVOID:/i)[0];
  check("REQ2: prompt does not select flat lay for on-model ref",
    !/PRIMARY SUBJECT:[\s\S]*flat lay/i.test(beforeAvoid), hidden);
}

// Required: product-focused fashion direction keeps reference balanced.
{
  const assets = [
    p("blue paisley camisole top"), p("flare jeans"), p("shoulder bag"),
    r("outdoor urban candid street style outfit", "on_body", "visible_person"),
  ];
  const base = pipeline("fashion", assets);
  const productDirection = base.directions.find(d => d.kind === "product_focused")!;
  const mode = inferReferenceInfluenceMode({ ...base.promptInput, direction: productDirection, controls: { referenceStrength: "Balanced" } });
  const hidden = buildHiddenPrompt({ ...base.promptInput, direction: productDirection, controls: { referenceStrength: "Balanced", textOverlay: "None" } });
  check("REQ3: product-focused fashion reference is balanced",
    mode === "style_mood_balanced", mode);
  check("REQ3: product-focused prompt keeps product fidelity",
    /PRODUCT REQUIREMENTS:[\s\S]*Preserve the selected/i.test(hidden), hidden);
  check("REQ3: product-focused prompt does not allow studio unless selected direction says it",
    !/studio catalog allowed|plain studio backdrop is allowed/i.test(hidden), hidden);
}

// Required: no reference means no fake reference constraints.
{
  const { hidden, referenceInfluenceMode } = pipeline("fashion", [
    p("blue paisley camisole top"), p("flare jeans"), p("shoulder bag"),
  ]);
  check("REQ4: no reference mode is none", referenceInfluenceMode === "none", referenceInfluenceMode);
  check("REQ4: no fake REFERENCE REQUIREMENTS section", !/REFERENCE REQUIREMENTS:/i.test(hidden), hidden);
}

// (a) Fashion complete outfit + explicit street-style reference (rich metadata)
{
  const { directions } = pipeline("fashion", [
    p("blue denim jeans"), p("white camisole top"), p("leather handbag"),
    r("street style influencer outfit, full body", "on_body", "visible_person"),
  ]);
  check("A: street-style ref → outfit-oriented title (not generic/flat lay)",
    /outfit|on-model|street-style|mirror|lookbook/i.test(directions[0].title) && !/generic|flat lay/i.test(directions[0].title), directions[0].title);
  check("A: closest direction not LOW", directions[0].confidence !== "low", String(directions[0].confidence));
}

// (b) Fashion complete outfit + WEAK/unknown reference metadata (no vf/hp, vague title)
{
  const { references, directions } = pipeline("fashion", [
    p("denim jeans"), p("ribbed tank top"), p("crossbody bag"),
    r("ref image 4821"),  // no usable signal
  ]);
  check("B: weak ref upgraded to on-model via outfit context",
    references.dominant?.referenceType === "outfit_on_model", references.dominant?.referenceType);
  check("B: weak-ref closest direction NOT low (context upgrade)", directions[0].confidence !== "low", String(directions[0].confidence));
  check("B: weak-ref title is outfit-oriented, not 'generic'",
    /outfit|on-model/i.test(directions[0].title) && !/generic/i.test(directions[0].title), directions[0].title);
}

// (c) Home Decor products + room reference
{
  const { directions } = pipeline("home-decor", [
    p("velvet sofa"), p("wool rug"), p("floor lamp"),
    r("styled living room interior", "room_scene", "no_person"),
  ]);
  check("C: home room ref → room scene direction", /room scene/i.test(directions[0].title), directions[0].title);
  check("C: home closest not LOW", directions[0].confidence !== "low", String(directions[0].confidence));
}

// (d) Digital product + information-rich reference
{
  const { directions } = pipeline("digital-products", [
    p("printable budget planner pdf"),
    r("information rich checklist infographic pin"),
  ]);
  check("D: digital info ref → benefit/mockup/info direction",
    /benefit|information|mockup|preview|checklist|breakdown/i.test(directions[0].title), directions[0].title);
}

// (e) Unknown reference fallback — friendly label, never the word "generic" in copy
{
  const { references, directions, intent } = pipeline("", [r("untitled saved pin")], { keyword: "ideas" });
  check("E: unknown ref label is friendly (no 'generic' user copy)",
    !/generic/i.test(directions[0].title) && !/generic/i.test(directions[0].shortDescription ?? "") && !/generic/i.test(intent.userVisibleSummary),
    `${directions[0].title} | ${directions[0].shortDescription}`);
  check("E: unknown ref description uses neutral framing wording",
    /reference for framing, styling, and mood/i.test(directions[0].shortDescription ?? "") || references.dominant?.referenceType !== "generic",
    directions[0].shortDescription);
}

// Required: normal users do not see generation debug overlay by default.
{
  const studioSource = fs.readFileSync(new URL("../src/app/app/studio/page.tsx", import.meta.url), "utf8");
  check("REQ5: debug overlay is behind NEXT_PUBLIC_STUDIO_DEBUG_GENERATION",
    studioSource.includes("NEXT_PUBLIC_STUDIO_DEBUG_GENERATION") && studioSource.includes("SHOW_GENERATION_DEBUG &&"),
    "generation-debug-overlay must be dev-only");
}

// Required: creative_direction_v2 final prompt is not replaced by prompt enhancer output.
{
  const generatorSource = fs.readFileSync(new URL("../../backend/generator.py", import.meta.url), "utf8");
  check("REQ6: V2 enhancer does not rewrite final prompt",
    generatorSource.includes('prompt_mode != "creative_direction_v2"') &&
    generatorSource.includes("frontend hidden prompt (pass-through, no re-enhance)") &&
    generatorSource.includes("REFERENCE REQUIREMENTS"),
    "generator.py must pass through V2 hidden prompt and keep strong reference requirements");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
