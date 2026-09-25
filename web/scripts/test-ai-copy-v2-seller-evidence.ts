/**
 * test-ai-copy-v2-seller-evidence.ts — seller-text grounding for AI Copy v2 (P1 0925).
 *
 * Preview (c712e7f3) produced 7/7 422s on Amazon cards: every brand / material /
 * numeric / efficacy claim was UNSUPPORTED even when it was copied from the fetched
 * listing, because only commercially-categorised facts (canonicalClaim + affirmed)
 * could ground a claim, and Amazon page text / selling points are category "general".
 *
 * This suite pins the fix: a claim is grounded when it appears as a contiguous token
 * phrase in a seller-text fact (user_input / product_catalog / page_metadata, trust
 * verified|asserted, copy_allowed, category general) — never image_observed /
 * ai_inferred / board_context — with fail-closed guards:
 *  - a clause carrying negation ("not", "no", "without", "sin", "不", ...) grounds nothing
 *  - material: the matched span must not be glued to a qualifier ("faux leather",
 *    "PU leather", "gold tone", "silk-like", "leather-free")
 *  - price / availability / therapeutic efficacy stay canonical-only
 *
 * Fixture: the REAL Echo Dot listing (ASIN B09B8V1LZ3) returned by importAmazonUrl
 * on 2026-09-25, and the manual-entry values used in the Preview QA.
 *
 * Run: npx tsx scripts/test-ai-copy-v2-seller-evidence.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service";

import assert from "node:assert/strict";
import type { AnalyzeBody } from "../src/app/api/ai-copy/v2/analyze/analyzeHandler";
import type { AmazonCardSource } from "../src/lib/studio/amazonCardSource";
import type { DetectedClaim, FactCardV1, FactItem, ValidationReport } from "../src/lib/ai-copy/v2/types";
import { ECHO_DOT_EXTRACTED } from "./fixtures/amazon-echo-dot-b09b8v1lz3";

async function main() {
// Dynamic imports: analyzeHandler pulls supabase.ts, which needs the env above first.
const { buildFacts } = await import("../src/app/api/ai-copy/v2/analyze/analyzeHandler");
const { createFact, createFactCardV1 } = await import("../src/lib/ai-copy/v2/factCard");
const { validateCopy } = await import("../src/lib/ai-copy/v2/validateCopy");
const { buildAmazonCopyContext } = await import("../src/lib/studio/amazonCardSource");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${(error as Error).message.split("\n").join("\n    ")}`); }
}

function source(partial: Partial<AmazonCardSource>): AmazonCardSource {
  return {
    version: 1,
    pastedUrl: "https://www.amazon.com/dp/B09B8V1LZ3?tag=qa-20",
    linkStatus: "ok",
    host: "amazon.com",
    marketplace: "US",
    asin: "B09B8V1LZ3",
    fetch: { status: "not_attempted" },
    manual: {},
    resolvedAt: "2026-09-25T00:00:00.000Z",
    ...partial,
  };
}

/** The same product/page mapping buildAICopyV2AnalyzePayload sends to analyze. */
function amazonFactCard(src: AmazonCardSource): FactCardV1 {
  const ctx = buildAmazonCopyContext(src);
  const p = ctx.product;
  const body: AnalyzeBody = {
    draftId: "d", idempotencyKey: "k",
    productContext: { title: p.title, productType: p.category, vendor: p.vendor, price: p.price, availability: p.availability, tags: p.tags, attributes: p.attributes, material: p.material, quantity: p.quantity },
    ...(ctx.page ? { pageContext: { title: ctx.page.title, description: ctx.page.description } } : {}),
  };
  return createFactCardV1({ sessionId: "s", draftId: "d", locale: "en", facts: buildFacts(body) });
}

const fetchedEchoDot = () => amazonFactCard(source({ fetch: { status: "ok" }, extracted: ECHO_DOT_EXTRACTED, manual: { brand: "Amazon" } }));
const manualEchoDot = () => amazonFactCard(source({
  fetch: { status: "failed", reason: "no_product_fields" },
  manual: { productName: "Echo Dot (4th Gen) Smart Speaker", sellingPoints: "Works with Alexa\nBluetooth speaker\nCompact design fits any room" },
}));

function run(factCard: FactCardV1, copy: { title: string; description: string }, claims: DetectedClaim[]): ValidationReport {
  return validateCopy({
    ...copy,
    altText: "A compact round smart speaker on a bedside table",
    factCard,
    descriptionMax: 500,
    claimDetection: { status: "completed", claims },
  });
}
const codes = (r: ValidationReport) => r.issues.map(i => i.code);
const unsupported = (r: ValidationReport) => r.issues.filter(i => i.code.startsWith("UNSUPPORTED_"));

function pageCard(description: string, extra: FactItem[] = []): FactCardV1 {
  return createFactCardV1({
    sessionId: "s", draftId: "d", locale: "en",
    facts: [
      ...buildFacts({ draftId: "d", idempotencyKey: "k", productContext: { title: "Accessory" }, pageContext: { description } }),
      ...extra,
    ],
  });
}

console.log("\n[fetched Echo Dot listing — claims copied from the page are grounded]");
test("verbatim listing claims (brand list, sensors, privacy controls, coverage, apple trap) validate", () => {
  const r = run(fetchedEchoDot(), {
    title: "Echo Dot Speaker for Bedrooms and Offices",
    description: "Play music, audiobooks, and podcasts from Amazon Music, Apple Music, Spotify and others. Control compatible smart home devices with your voice and routines triggered by built-in motion or indoor temperature sensors. Built with multiple layers of privacy controls, including a mic off button. Adds up to 1,000 sq. ft. of wifi coverage. Find it on Amazon. #ad",
  }, [
    { type: "brand", value: "Amazon Music, Apple Music, Spotify", field: "description" },
    { type: "brand", value: "Amazon", field: "description" },
    { type: "material", value: "built-in motion or indoor temperature sensors", field: "description" },
    { type: "material", value: "multiple layers of privacy controls, including a mic off button", field: "description" },
    { type: "numeric_commercial", value: "1,000 sq. ft.", field: "description" },
    { type: "efficacy", value: "Vibrant sounding speaker", field: "title" },
  ]);
  assert.deepEqual(unsupported(r), [], JSON.stringify(r.issues));
  assert.equal(r.valid, true, JSON.stringify(r.issues));
});
test("a reordered brand list is grounded item by item (Preview hint: \"Amazon Music, Spotify, Apple Music\")", () => {
  const r = run(fetchedEchoDot(), {
    title: "Echo Dot Speaker",
    description: "Stream from Amazon Music, Spotify, Apple Music and more. #ad",
  }, [{ type: "brand", value: "Amazon Music, Spotify, Apple Music", field: "description" }]);
  assert.deepEqual(unsupported(r), [], JSON.stringify(r.issues));
});
test("a claim the listing does NOT make stays UNSUPPORTED (Sonos / 2-year warranty)", () => {
  const r = run(fetchedEchoDot(), {
    title: "Echo Dot Speaker",
    description: "Pairs with Sonos and comes with a 2-year warranty. #ad",
  }, [
    { type: "brand", value: "Sonos", field: "description" },
    { type: "numeric_commercial", value: "2-year warranty", field: "description" },
  ]);
  assert.ok(codes(r).includes("UNSUPPORTED_BRAND_CLAIM"), JSON.stringify(r.issues));
  assert.ok(codes(r).includes("UNSUPPORTED_NUMERIC_CLAIM"), JSON.stringify(r.issues));
});
test("a paraphrase that adds a detail the page lacks stays UNSUPPORTED (\"dedicated mic-off button\")", () => {
  const r = run(fetchedEchoDot(), { title: "Echo Dot Speaker", description: "Multiple control layers and a dedicated mic-off button. #ad" },
    [{ type: "material", value: "multiple control layers and a dedicated mic-off button", field: "description" }]);
  assert.ok(codes(r).includes("UNSUPPORTED_MATERIAL_CLAIM"), JSON.stringify(r.issues));
});
test("the negated privacy sentence grounds nothing (\"Amazon ... is not in the business of selling\")", () => {
  const r = run(fetchedEchoDot(), { title: "Echo Dot Speaker", description: "Selling your personal information to others. #ad" },
    [{ type: "efficacy", value: "selling your personal information to others", field: "description" }]);
  assert.ok(codes(r).includes("UNSUPPORTED_EFFICACY_CLAIM"), JSON.stringify(r.issues));
});

console.log("\n[manual entry — typed product name and selling points are the user's own assertions]");
test("claims from the typed selling points validate (Alexa / Bluetooth)", () => {
  const r = run(manualEchoDot(), {
    title: "Echo Dot (4th Gen) Smart Speaker",
    description: "A Bluetooth speaker that works with Alexa. Compact design fits any room. Find it on Amazon. #ad",
  }, [
    { type: "brand", value: "Alexa", field: "description" },
    { type: "brand", value: "Echo Dot", field: "title" },
  ]);
  assert.deepEqual(unsupported(r), [], JSON.stringify(r.issues));
  assert.equal(r.valid, true, JSON.stringify(r.issues));
});
test("world-knowledge the user never typed stays UNSUPPORTED (Spotify / Apple Music)", () => {
  const r = run(manualEchoDot(), { title: "Echo Dot (4th Gen) Smart Speaker", description: "Stream Spotify and Apple Music. #ad" },
    [{ type: "brand", value: "Spotify, Apple Music", field: "description" }]);
  assert.ok(codes(r).includes("UNSUPPORTED_BRAND_CLAIM"), JSON.stringify(r.issues));
});

console.log("\n[fail-closed guards on seller text]");
for (const [page, title, why] of [
  ["Faux leather exterior with gold stitching", "Leather Bag", "faux leather does not ground bare leather"],
  ["PU leather exterior", "Leather Bag", "PU leather does not ground bare leather"],
  ["Soft vegan leather strap", "Leather Strap", "vegan leather does not ground bare leather"],
  ["Synthetic leather upper", "Leather Shoes", "synthetic leather does not ground bare leather"],
  ["Imitation silk lining", "Silk Lined Jacket", "imitation silk does not ground bare silk"],
  ["Set with lab grown diamonds", "Diamond Ring", "lab grown diamonds do not ground diamond"],
  ["Gold tone finish", "Gold Necklace", "gold tone does not ground bare gold"],
  ["Silk-like polyester fabric", "Silk Scarf", "silk-like does not ground bare silk"],
  ["Leather-free vegan construction", "Leather Wallet", "leather-free does not ground leather"],
  ["This bag is not leather.", "Leather Bag", "negated sentence does not ground leather"],
  ["Made without silk.", "Silk Scarf", "'without' negates"],
  ["No es seda; es poliéster", "Bufanda de seda", "Spanish negation clause grounds nothing"],
] as const) {
  test(`material: ${why}`, () => {
    const claims: DetectedClaim[] = title.includes("seda") ? [{ type: "material", value: "seda", field: "title" }] : [];
    const r = run(pageCard(page), { title, description: "A styled accessory." }, claims);
    assert.ok(codes(r).includes("UNSUPPORTED_MATERIAL_CLAIM"), JSON.stringify(r.issues));
  });
}
test("material: 不是真丝 (Chinese negation) grounds nothing", () => {
  const card = createFactCardV1({ sessionId: "s", draftId: "d", locale: "zh-CN", facts: buildFacts({ draftId: "d", idempotencyKey: "k", pageContext: { description: "不是真丝，是聚酯纤维" } }) });
  const r = validateCopy({ title: "真丝围巾", description: "围巾。", altText: "围巾", factCard: card, claimDetection: { status: "completed", claims: [{ type: "material", value: "真丝", field: "title" }] } });
  assert.ok(codes(r).includes("UNSUPPORTED_MATERIAL_CLAIM"), JSON.stringify(r.issues));
});
test("material: a clean affirmative seller sentence grounds it (\"Made of genuine leather.\" → \"genuine leather\")", () => {
  const r = run(pageCard("Made of genuine leather. Fits a 13-inch laptop."), { title: "Genuine Leather Laptop Sleeve", description: "A slim sleeve." },
    [{ type: "material", value: "genuine leather", field: "title" }]);
  assert.deepEqual(unsupported(r), [], JSON.stringify(r.issues));
});
test("material: an ordinary adjective before the material keeps it asserted (\"Handmade Speckled Ceramic Mug\" → ceramic)", () => {
  const card = createFactCardV1({ sessionId: "s", draftId: "d", locale: "en", facts: buildFacts({ draftId: "d", idempotencyKey: "k", productContext: { title: "Handmade Speckled Ceramic Mug", attributes: ["Glazed stoneware", "Holds 12 oz", "Dishwasher safe"] } }) });
  const r = run(card, { title: "Speckled Ceramic Mug", description: "Glazed stoneware that holds 12 oz and is dishwasher safe." }, [
    { type: "material", value: "ceramic", field: "title" },
    { type: "material", value: "Glazed stoneware", field: "description" },
    { type: "numeric_commercial", value: "12 oz", field: "description" },
  ]);
  assert.deepEqual(unsupported(r), [], JSON.stringify(r.issues));
});
test("brand: 'does not work with Spotify' does not ground Spotify", () => {
  const r = run(pageCard("This speaker does not work with Spotify."), { title: "Speaker", description: "Works with Spotify." },
    [{ type: "brand", value: "Spotify", field: "description" }]);
  assert.ok(codes(r).includes("UNSUPPORTED_BRAND_CLAIM"), JSON.stringify(r.issues));
});
test("numeric: token boundaries hold in seller text (13-pack does not ground 3-pack)", () => {
  const r = run(pageCard("Includes a 13-pack of refills."), { title: "3-Pack Refills", description: "Refills." }, []);
  assert.ok(codes(r).includes("UNSUPPORTED_NUMERIC_CLAIM"), JSON.stringify(r.issues));
});
test("price / availability are never grounded by seller text", () => {
  const r = run(pageCard("On sale for $29.99. In stock and ready to ship."), { title: "Speaker", description: "On sale for $29.99, in stock and ready to ship." },
    [{ type: "price", value: "$29.99", field: "description" }]);
  assert.ok(codes(r).includes("UNSUPPORTED_PRICE_CLAIM"), JSON.stringify(r.issues));
  assert.ok(codes(r).includes("UNSUPPORTED_AVAILABILITY_CLAIM"), JSON.stringify(r.issues));
});
test("therapeutic efficacy is never grounded by seller text (pain relief)", () => {
  const r = run(pageCard("Provides pain relief for sore muscles."), { title: "Massage Ball", description: "Provides pain relief for sore muscles." },
    [{ type: "efficacy", value: "pain relief for sore muscles", field: "description" }]);
  assert.ok(codes(r).includes("UNSUPPORTED_EFFICACY_CLAIM"), JSON.stringify(r.issues));
});
test("image_observed / board_context / ai_inferred text never grounds a claim", () => {
  const card = createFactCardV1({
    sessionId: "s", draftId: "d", locale: "en",
    facts: [
      createFact({ id: "i", key: "ocr_text", value: "Works with Spotify", source: "image_observed", trustLevel: "observed", category: "visual_description" }),
      createFact({ id: "b", key: "board_name", value: "Spotify speakers", source: "board_context", trustLevel: "asserted" }),
      createFact({ id: "a", key: "guess", value: "Spotify compatible", source: "ai_inferred", trustLevel: "inferred", claimPolicy: "descriptive_only" }),
    ],
  });
  const r = run(card, { title: "Speaker", description: "Works with Spotify." }, [{ type: "brand", value: "Spotify", field: "description" }]);
  assert.ok(codes(r).includes("UNSUPPORTED_BRAND_CLAIM"), JSON.stringify(r.issues));
});

console.log(`\nSeller evidence: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
}
main().catch(error => { console.error(error); process.exit(1); });
