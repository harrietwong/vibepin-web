/**
 * test-ai-copy-v2-facts.ts — Task 1: AI Copy v2 Fact Contracts and Copy Validation.
 *
 * Verifies:
 *  - FactCardV1 schema & invariants (sources, non-numeric trust levels, closed claim policies).
 *  - Claim policy rules: commercial claims require verified or asserted trust;
 *    image-observed facts cannot be commercial copy_allowed; ai_inferred cannot be asserted.
 *  - Frozen shared contracts: KeywordEvidence (honest provenance, structured relevance, no volumeSignal,
 *    selectedKeywordIds, degradedMode union), ValidationReport (closed issue codes),
 *    CopyResultV2 (required fields, structured fact summary, no clusterId).
 *  - Hard length limits: title <= 100, description <= 500 (Studio schedule cap); no truncation mutation.
 *  - Exact keyword frequency: title <= 1, description <= 2.
 *  - Repetitive stuffing: 3 consecutive identical non-stopwords fail; stopwords & 2 reps pass.
 *  - Grounding checks: deterministic traps for silk, sterling silver, therapeutic, price,
 *    availability, brand, and numeric commercial claims.
 *  - Route orchestration detected claims: arbitrary commercial claims validation.
 *  - Policy boundaries: blocked facts, descriptive-only violations.
 *  - Valid grounded copy passes cleanly.
 */

import assert from "node:assert/strict";
import type {
  FactCardV1,
  FactItem,
  KeywordEvidence,
  ValidationReport,
  ValidationIssueCode,
  CopyResultV2,
  DetectedClaim,
} from "../src/lib/ai-copy/v2/types";
import {
  createFact,
  createFactCardV1,
  summarizeFacts,
} from "../src/lib/ai-copy/v2/factCard";
import { DESCRIPTION_MAX_LENGTH } from "../src/lib/pinReadiness";
import {
  DEFAULT_DESCRIPTION_MAX,
  validateCopy as validateCopyV2,
  type ValidateCopyInput,
} from "../src/lib/ai-copy/v2/validateCopy";

type TestValidateInput = Omit<ValidateCopyInput, "claimDetection"> & {
  claimDetection?: ValidateCopyInput["claimDetection"];
  detectedClaims?: DetectedClaim[];
};

function validateCopy(input: TestValidateInput) {
  const { detectedClaims, ...rest } = input;
  return validateCopyV2({
    ...rest,
    claimDetection: input.claimDetection ?? {
      status: "completed",
      claims: detectedClaims ?? [],
    },
  });
}

console.log("=== test-ai-copy-v2-facts: start ===");

// ── 1. Contract & Invariants Tests ───────────────────────────────────────────
console.log("1. Checking FactCardV1 and shared types contracts...");

const verifiedFact = createFact({
  id: "fact-material-1",
  key: "material",
  value: "100% Mulberry Silk",
  source: "product_catalog",
  trustLevel: "verified",
  category: "material",
  canonicalClaim: "mulberry silk",
  claimPolarity: "affirmed",
});
assert.equal(verifiedFact.source, "product_catalog");
assert.equal(verifiedFact.trustLevel, "verified");
assert.equal(verifiedFact.claimPolicy, "copy_allowed");
assert.equal(verifiedFact.canonicalClaim, "mulberry silk");
assert.equal(verifiedFact.claimPolarity, "affirmed");

const ambiguousTrustedCommercialFact = createFact({
  id: "fact-material-ambiguous",
  key: "material",
  value: "Faux leather finish",
  source: "product_catalog",
  trustLevel: "verified",
  category: "material",
});
assert.equal(
  ambiguousTrustedCommercialFact.claimPolicy,
  "blocked",
  "Trusted free text without an affirmed canonical commercial claim must be blocked",
);

const observedMaterial = createFact({
  id: "fact-mat-obs",
  key: "material",
  value: "Looks like velvet",
  source: "image_observed",
  trustLevel: "observed",
  category: "material",
});
assert.equal(observedMaterial.claimPolicy, "descriptive_only", "Observed commercial claim must be descriptive_only");

const inferredBrand = createFact({
  id: "fact-brand-inf",
  key: "brand",
  value: "Luxury Artisan",
  source: "ai_inferred",
  trustLevel: "inferred",
  category: "brand",
});
assert.equal(inferredBrand.claimPolicy, "blocked", "AI-inferred commercial claim must be blocked");

const card: FactCardV1 = createFactCardV1({
  sessionId: "sess_123",
  draftId: "draft_456",
  locale: "en-US",
  facts: [verifiedFact, observedMaterial, inferredBrand],
});
assert.equal(card.version, "fact-card-v1");
assert.equal(card.facts.length, 3);

// KeywordEvidence contract check: honest provenance, no volumeSignal, structured relevance
const keywordEvidence: KeywordEvidence = {
  keywordSetId: "kset_123",
  candidates: [
    {
      id: "kw_1",
      phrase: "silk pillowcase",
      provenance: "official",
      relevanceEvidence: [
        { source: "product_catalog", matchedText: "100% Mulberry Silk" },
      ],
      status: "accepted",
    },
  ],
  selectedKeywordIds: ["kw_1"],
  degradedMode: "none",
};
assert.equal("volumeSignal" in keywordEvidence.candidates[0], false, "Must not expose volumeSignal");
assert.equal(keywordEvidence.candidates[0].relevanceEvidence[0].source, "product_catalog");
assert.equal(keywordEvidence.selectedKeywordIds[0], "kw_1");

// Structured fact summary
const summaryItems = summarizeFacts(card);
assert.equal(summaryItems.length, 3);
assert.equal(summaryItems[0].factId, "fact-material-1");
assert.equal(summaryItems[0].trustLevel, "verified");

// CopyResultV2 required fields & no clusterId
const sampleResult: CopyResultV2 = {
  generationId: "gen_001",
  sessionId: "sess_123",
  draftId: "draft_456",
  angleId: "angle_aesthetic",
  keywordSetId: "kset_123",
  title: "Mulberry Silk Pillowcase",
  description: "Experience luxurious sleep with 100% Mulberry Silk.",
  altText: "Mulberry Silk pillowcase on bed",
  usedKeywordIds: ["kw_1"],
  factSummary: summaryItems,
  degradedMode: "none",
  validationReport: { valid: true, issues: [] },
};
assert.equal("clusterId" in sampleResult, false, "CopyResultV2 must not contain clusterId");
assert.equal(sampleResult.angleId, "angle_aesthetic");
assert.equal(sampleResult.keywordSetId, "kset_123");
assert.equal(sampleResult.altText, "Mulberry Silk pillowcase on bed");
assert.equal(sampleResult.degradedMode, "none");

console.log("   FactCardV1 & shared contracts passed.");

// ── 2. Hard Limits (100 title, 500 description = Studio schedule cap) ────────
console.log("2. Checking hard length limits...");

const validCard: FactCardV1 = createFactCardV1({
  sessionId: "sess_123",
  draftId: "draft_456",
  locale: "en-US",
  facts: [
    createFact({
      id: "f-title",
      key: "product_title",
      value: "Handmade Ceramic Mug",
      source: "product_catalog",
      trustLevel: "verified",
      category: "general",
    }),
  ],
});

const titleOver = validateCopy({ title: "A".repeat(101), description: "Mug desc", factCard: validCard });
assert.equal(titleOver.valid, false);
assert.ok(titleOver.issues.some(i => i.code === "TITLE_TOO_LONG" && i.field === "title"));

const descOver = validateCopy({ title: "Mug", description: "B".repeat(501), factCard: validCard });
assert.equal(descOver.valid, false);
assert.ok(descOver.issues.some(i => i.code === "DESCRIPTION_TOO_LONG" && i.field === "description"));

const exactReport = validateCopy({ title: "A".repeat(100), description: "B".repeat(500), factCard: validCard });
assert.ok(!exactReport.issues.some(i => i.code === "TITLE_TOO_LONG" || i.code === "DESCRIPTION_TOO_LONG"));
// The v2 default must be exactly what Studio lets the merchant schedule (P1 0925).
assert.equal(DEFAULT_DESCRIPTION_MAX, DESCRIPTION_MAX_LENGTH);

console.log("   Hard length limits passed.");

// ── 3. Exact Keyword Frequency Limits ────────────────────────────────────────
console.log("3. Checking exact keyword frequency limits...");
const kw = "ceramic coffee mug";

const titleKwFail = validateCopy({
  title: "Ceramic Coffee Mug - Ceramic Coffee Mug",
  description: "Cozy morning cup.",
  factCard: validCard,
  keywords: [kw],
});
assert.equal(titleKwFail.valid, false);
assert.ok(titleKwFail.issues.some(i => i.code === "KEYWORD_FREQUENCY_TITLE" && i.field === "title"));

const titleKwPass = validateCopy({
  title: "Handmade Ceramic Coffee Mug for Mornings",
  description: "Cozy morning cup.",
  factCard: validCard,
  keywords: [kw],
});
assert.ok(!titleKwPass.issues.some(i => i.code === "KEYWORD_FREQUENCY_TITLE"));

const descKwFail = validateCopy({
  title: "Handmade Mug",
  description: "This ceramic coffee mug is great. Another ceramic coffee mug here. Third ceramic coffee mug now.",
  factCard: validCard,
  keywords: [kw],
});
assert.equal(descKwFail.valid, false);
assert.ok(descKwFail.issues.some(i => i.code === "KEYWORD_FREQUENCY_DESCRIPTION" && i.field === "description"));

const descKwPass = validateCopy({
  title: "Handmade Mug",
  description: "This ceramic coffee mug is great. Another ceramic coffee mug here.",
  factCard: validCard,
  keywords: [kw],
});
assert.ok(!descKwPass.issues.some(i => i.code === "KEYWORD_FREQUENCY_DESCRIPTION"));

console.log("   Keyword frequency limits passed.");

// ── 4. Consecutive Word Stuffing ─────────────────────────────────────────────
console.log("4. Checking consecutive non-stopword stuffing...");

const stuffTitle = validateCopy({ title: "Handmade mug mug mug for coffee", description: "Nice cup.", factCard: validCard });
assert.equal(stuffTitle.valid, false);
assert.ok(stuffTitle.issues.some(i => i.code === "CONSECUTIVE_WORD_STUFFING" && i.field === "title"));

const stuffDesc = validateCopy({ title: "Handmade Mug", description: "Cozy, cozy, cozy vibes.", factCard: validCard });
assert.equal(stuffDesc.valid, false);
assert.ok(stuffDesc.issues.some(i => i.code === "CONSECUTIVE_WORD_STUFFING" && i.field === "description"));

const twoReps = validateCopy({ title: "Mug mug", description: "Cozy cozy coffee.", factCard: validCard });
assert.ok(!twoReps.issues.some(i => i.code === "CONSECUTIVE_WORD_STUFFING"));

const repeatedStopwords = validateCopy({ title: "Mug", description: "The cup that that that was made.", factCard: validCard });
assert.ok(!repeatedStopwords.issues.some(i => i.code === "CONSECUTIVE_WORD_STUFFING"));

console.log("   Consecutive stuffing checks passed.");

// ── 5. Grounding: Unsupported Material Claims (silk, sterling silver) ────────
console.log("5. Checking unsupported material claims (deterministic traps)...");

const unsuppSilk = validateCopy({ title: "Pure Silk Mug", description: "Soft silk cup.", factCard: validCard });
assert.equal(unsuppSilk.valid, false);
assert.ok(unsuppSilk.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM"));

const unsuppSilver = validateCopy({ title: "Sterling Silver Trim Mug", description: "925 silver rim.", factCard: validCard });
assert.equal(unsuppSilver.valid, false);
assert.ok(unsuppSilver.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM"));

const luxuryCard = createFactCardV1({
  sessionId: "s",
  draftId: "d",
  locale: "en",
  facts: [
    createFact({ id: "m1", key: "material", value: "925 Sterling Silver", source: "product_catalog", trustLevel: "verified", category: "material", canonicalClaim: "sterling silver", claimPolarity: "affirmed" }),
    createFact({ id: "m2", key: "material", value: "100% Silk lining", source: "user_input", trustLevel: "asserted", category: "material", canonicalClaim: "pure silk", claimPolarity: "affirmed" }),
  ],
});
const luxuryPass = validateCopy({
  title: "Sterling Silver Box with Silk Lining",
  description: "Crafted with 925 sterling silver and pure silk lining.",
  factCard: luxuryCard,
});
assert.ok(!luxuryPass.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM"));

console.log("   Material claims checks passed.");

// ── 6. Grounding: Therapeutic / Efficacy Claims ──────────────────────────────
console.log("6. Checking unsupported therapeutic/efficacy claims...");

const therapyCopy = validateCopy({
  title: "Healing Herbal Mug",
  description: "Clinically proven to cure migraines and treat chronic anxiety naturally.",
  factCard: validCard,
});
assert.equal(therapyCopy.valid, false);
assert.ok(therapyCopy.issues.some(i => i.code === "UNSUPPORTED_EFFICACY_CLAIM"));

console.log("   Efficacy claims checks passed.");

// ── 7. Grounding: Price & Inventory Claims ───────────────────────────────────
console.log("7. Checking unsupported price & inventory claims...");

const unsuppPrice = validateCopy({ title: "Ceramic Mug - $29.99", description: "Get 50% off with free shipping.", factCard: validCard });
assert.equal(unsuppPrice.valid, false);
assert.ok(unsuppPrice.issues.some(i => i.code === "UNSUPPORTED_PRICE_CLAIM"));

const unsuppStock = validateCopy({ title: "Ceramic Mug", description: "Only 3 left in stock! Ships today.", factCard: validCard });
assert.equal(unsuppStock.valid, false);
assert.ok(unsuppStock.issues.some(i => i.code === "UNSUPPORTED_AVAILABILITY_CLAIM"));

const commercialCard = createFactCardV1({
  sessionId: "s",
  draftId: "d",
  locale: "en",
  facts: [
    createFact({ id: "p1", key: "price", value: "$29.99", source: "product_catalog", trustLevel: "verified", category: "price", canonicalClaim: "$29.99", claimPolarity: "affirmed" }),
    createFact({ id: "a1", key: "availability", value: "In stock", source: "product_catalog", trustLevel: "verified", category: "availability", canonicalClaim: "in stock", claimPolarity: "affirmed" }),
  ],
});
const commPass = validateCopy({
  title: "Artisan Mug for $29.99",
  description: "In stock now: handcrafted ceramic mug for your morning routine.",
  factCard: commercialCard,
});
assert.ok(!commPass.issues.some(i => i.code === "UNSUPPORTED_PRICE_CLAIM" || i.code === "UNSUPPORTED_AVAILABILITY_CLAIM"));

console.log("   Price and inventory checks passed.");

// ── 8. Grounding: Brand Claims ───────────────────────────────────────────────
console.log("8. Checking unsupported brand claims...");

const unsuppBrand = validateCopy({ title: "Nike Inspired Mug", description: "Tiffany styling for coffee lovers.", factCard: validCard });
assert.equal(unsuppBrand.valid, false);
assert.ok(unsuppBrand.issues.some(i => i.code === "UNSUPPORTED_BRAND_CLAIM"));

const brandCard = createFactCardV1({
  sessionId: "s",
  draftId: "d",
  locale: "en",
  facts: [
    createFact({ id: "b1", key: "brand", value: "ClayWorks Studio", source: "product_catalog", trustLevel: "verified", category: "brand", canonicalClaim: "ClayWorks Studio", claimPolarity: "affirmed" }),
  ],
});
const brandPass = validateCopy({
  title: "ClayWorks Studio Ceramic Mug",
  description: "Handcrafted by ClayWorks Studio artisans.",
  factCard: brandCard,
});
assert.ok(!brandPass.issues.some(i => i.code === "UNSUPPORTED_BRAND_CLAIM"));

console.log("   Brand claim checks passed.");

// ── 9. Grounding: Numeric Commercial Claims ──────────────────────────────────
console.log("9. Checking unsupported numeric commercial claims...");

const unsuppNum = validateCopy({
  title: "Ceramic Mug 3-Pack",
  description: "Comes with a 10-year warranty and holds up to 50 lbs.",
  factCard: validCard,
});
assert.equal(unsuppNum.valid, false);
assert.ok(unsuppNum.issues.some(i => i.code === "UNSUPPORTED_NUMERIC_CLAIM"));

const numericCard = createFactCardV1({
  sessionId: "s",
  draftId: "d",
  locale: "en",
  facts: [
    createFact({ id: "n1", key: "pack", value: "3-pack", source: "product_catalog", trustLevel: "verified", category: "numeric_commercial", canonicalClaim: "3-pack", claimPolarity: "affirmed" }),
    createFact({ id: "n2", key: "warranty", value: "10-year warranty", source: "user_input", trustLevel: "asserted", category: "numeric_commercial", canonicalClaim: "10-year warranty", claimPolarity: "affirmed" }),
  ],
});
const numPass = validateCopy({
  title: "Ceramic Mug 3-Pack Set",
  description: "Enjoy peace of mind with an included 10-year warranty.",
  factCard: numericCard,
});
assert.ok(!numPass.issues.some(i => i.code === "UNSUPPORTED_NUMERIC_CLAIM"));

console.log("   Numeric commercial claim checks passed.");

// ── 10. Arbitrary Route-Detected Commercial Claims ───────────────────────────
console.log("10. Checking arbitrary route-detected claims...");

const unsuppDetected = validateCopy({
  title: "Exclusive Artisan Blanket",
  description: "Woven by AcmeCorp with genuine alpaca wool.",
  factCard: validCard,
  detectedClaims: [
    { type: "material", value: "alpaca wool", field: "description" },
    { type: "brand", value: "AcmeCorp", field: "description" },
  ],
});
assert.equal(unsuppDetected.valid, false);
assert.ok(unsuppDetected.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM" && i.field === "description"));
assert.ok(unsuppDetected.issues.some(i => i.code === "UNSUPPORTED_BRAND_CLAIM" && i.field === "description"));

const detectedCard = createFactCardV1({
  sessionId: "s",
  draftId: "d",
  locale: "en",
  facts: [
    createFact({ id: "det-m", key: "material", value: "100% alpaca wool", source: "product_catalog", trustLevel: "verified", category: "material", canonicalClaim: "alpaca wool", claimPolarity: "affirmed" }),
    createFact({ id: "det-b", key: "brand", value: "AcmeCorp", source: "product_catalog", trustLevel: "verified", category: "brand", canonicalClaim: "AcmeCorp", claimPolarity: "affirmed" }),
  ],
});
const suppDetected = validateCopy({
  title: "Exclusive Artisan Blanket",
  description: "Woven by AcmeCorp with genuine alpaca wool.",
  factCard: detectedCard,
  detectedClaims: [
    { type: "material", value: "alpaca wool", field: "description" },
    { type: "brand", value: "AcmeCorp", field: "description" },
  ],
});
assert.ok(!suppDetected.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM" || i.code === "UNSUPPORTED_BRAND_CLAIM"));

console.log("   Route-detected claims checks passed.");

// ── 11. Claim Policy Boundaries (Observed vs Inferred vs Blocked) ────────────
console.log("11. Checking claim policy boundaries...");

const policyCard = createFactCardV1({
  sessionId: "s",
  draftId: "d",
  locale: "en",
  facts: [
    createFact({ id: "obs-1", key: "background", value: "rustic wooden table", source: "image_observed", trustLevel: "observed", category: "visual_description", claimPolicy: "descriptive_only" }),
    createFact({ id: "blk-1", key: "hazard", value: "indestructible coating", source: "ai_inferred", trustLevel: "inferred", category: "material", claimPolicy: "blocked" }),
  ],
});

const blockedUse = validateCopy({ title: "Indestructible Coating Mug", description: "Features indestructible coating.", factCard: policyCard });
assert.equal(blockedUse.valid, false);
assert.ok(blockedUse.issues.some(i => i.code === "BLOCKED_FACT_USED"));

const descInTitle = validateCopy({ title: "Rustic Wooden Table Mug", description: "Ceramic cup.", factCard: policyCard });
assert.equal(descInTitle.valid, false);
assert.ok(descInTitle.issues.some(i => i.code === "DESCRIPTIVE_ONLY_VIOLATION" && i.field === "title"));

const descAsProduct = validateCopy({ title: "Ceramic Mug", description: "Made of authentic rustic wooden table material.", factCard: policyCard });
assert.equal(descAsProduct.valid, false);
assert.ok(descAsProduct.issues.some(i => i.code === "DESCRIPTIVE_ONLY_VIOLATION" && i.field === "description"));

const descValid = validateCopy({ title: "Ceramic Mug", description: "Photographed on a rustic wooden table in sunlight.", factCard: policyCard });
assert.ok(!descValid.issues.some(i => i.code === "DESCRIPTIVE_ONLY_VIOLATION" || i.code === "BLOCKED_FACT_USED"));

console.log("   Claim policy boundaries checks passed.");

// ── 12. Fully Grounded Valid Copy ───────────────────────────────────────────
console.log("12. Checking fully grounded valid copy...");

const cleanCard = createFactCardV1({
  sessionId: "sess_clean",
  draftId: "draft_clean",
  locale: "en-US",
  facts: [
    createFact({ id: "f1", key: "material", value: "Ceramic stoneware", source: "product_catalog", trustLevel: "verified", category: "material", canonicalClaim: "ceramic stoneware", claimPolarity: "affirmed" }),
    createFact({ id: "f2", key: "brand", value: "EarthyCraft", source: "product_catalog", trustLevel: "verified", category: "brand", canonicalClaim: "EarthyCraft", claimPolarity: "affirmed" }),
    createFact({ id: "f3", key: "color", value: "speckled cream", source: "image_observed", trustLevel: "observed", category: "visual_description", claimPolicy: "descriptive_only" }),
  ],
});

const cleanReport = validateCopy({
  title: "EarthyCraft Ceramic Stoneware Mug",
  description: "Start your morning with this EarthyCraft ceramic stoneware coffee mug featuring a speckled cream finish. Hand-thrown design that holds heat and feels great in your hands.",
  altText: "Speckled cream ceramic stoneware mug on breakfast counter",
  factCard: cleanCard,
  keywords: ["ceramic stoneware coffee mug"],
});
assert.equal(cleanReport.valid, true);
assert.equal(cleanReport.issues.length, 0);

// ── 13. Regressions & Hardened Contract Checks (Repair Round) ────────────────
console.log("13. Checking repairs & hardened regression checks...");

// A1: createFactCardV1 normalizes unsafe persisted items via createFact
const unsafePersistedFact = {
  id: "persisted-unsafe",
  key: "material",
  value: "pure cashmere",
  source: "ai_inferred" as const,
  trustLevel: "inferred" as const,
  category: "material" as const,
  claimPolicy: "copy_allowed" as const,
};
const normalizedCard = createFactCardV1({
  sessionId: "s_unsafe",
  draftId: "d_unsafe",
  locale: "en",
  facts: [unsafePersistedFact],
});
assert.equal(
  normalizedCard.facts[0].claimPolicy,
  "blocked",
  "createFactCardV1 must normalize unsafe persisted facts to blocked",
);

// A2: Inferred/observed facts cannot support commercial claims even if category matches
const unsuppInferredCard = createFactCardV1({
  sessionId: "s",
  draftId: "d",
  locale: "en",
  facts: [
    {
      id: "inf-mat",
      key: "material",
      value: "wool",
      source: "ai_inferred" as const,
      trustLevel: "inferred" as const,
      category: "material" as const,
      claimPolicy: "blocked" as const,
    },
  ],
});
const inferredMatUse = validateCopy({
  title: "Cozy Wool Sweater",
  description: "Made with warm wool.",
  factCard: unsuppInferredCard,
});
assert.equal(inferredMatUse.valid, false);
assert.ok(
  inferredMatUse.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM" || i.code === "BLOCKED_FACT_USED"),
);

// B: Unicode token-array sliding-window matching ("art" in "Artisan art print" = 1)
const artKwPass = validateCopy({
  title: "Artisan art print",
  description: "Handcrafted gallery wall decor.",
  factCard: validCard,
  keywords: ["art"],
});
assert.ok(
  !artKwPass.issues.some(i => i.code === "KEYWORD_FREQUENCY_TITLE"),
  "Keyword 'art' must occur exactly 1 time in 'Artisan art print'",
);

const artKwFail = validateCopy({
  title: "Art art print",
  description: "Handcrafted gallery wall decor.",
  factCard: validCard,
  keywords: ["art"],
});
assert.equal(artKwFail.valid, false);
assert.ok(
  artKwFail.issues.some(i => i.code === "KEYWORD_FREQUENCY_TITLE" && i.field === "title"),
  "Keyword 'art' repeated twice in title must fail",
);

// C & G: Blocked fact used only in altText reports field altText
const blockedAltOnly = validateCopy({
  title: "Ceramic Coffee Mug",
  description: "Handcrafted stoneware mug for morning coffee.",
  altText: "Ceramic coffee mug with indestructible coating on a table",
  factCard: policyCard,
});
assert.equal(blockedAltOnly.valid, false);
assert.ok(
  blockedAltOnly.issues.some(i => i.code === "BLOCKED_FACT_USED" && i.field === "altText"),
  "Blocked fact in altText must report field 'altText'",
);

// C: Commercial claim in altText reports field altText
const unsuppMatAlt = validateCopy({
  title: "Ceramic Coffee Mug",
  description: "Handcrafted stoneware mug for morning coffee.",
  altText: "Features genuine sterling silver rim",
  factCard: validCard,
});
assert.equal(unsuppMatAlt.valid, false);
assert.ok(
  unsuppMatAlt.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM" && i.field === "altText"),
  "Unsupported material claim in altText must report field 'altText'",
);

// D: Efficacy claims: 'helps moisturize dry skin' does NOT permit 'clinically proven to cure migraines'
const moisturizeCard = createFactCardV1({
  sessionId: "s_m",
  draftId: "d_m",
  locale: "en",
  facts: [
    createFact({
      id: "eff-1",
      key: "efficacy",
      value: "helps moisturize dry skin",
      source: "product_catalog",
      trustLevel: "verified",
      category: "efficacy",
      canonicalClaim: "helps moisturize dry skin",
      claimPolarity: "affirmed",
    }),
  ],
});
const unsuppMigraine = validateCopy({
  title: "Hydrating Facial Cream",
  description: "Clinically proven to cure migraines and relieve tension.",
  factCard: moisturizeCard,
});
assert.equal(unsuppMigraine.valid, false);
assert.ok(
  unsuppMigraine.issues.some(i => i.code === "UNSUPPORTED_EFFICACY_CLAIM" && i.field === "description"),
  "Efficacy fact 'helps moisturize dry skin' must not permit migraine cure claims",
);

const suppMoisturize = validateCopy({
  title: "Hydrating Facial Cream",
  description: "Daily cream that helps moisturize dry skin naturally.",
  factCard: moisturizeCard,
});
assert.ok(
  !suppMoisturize.issues.some(i => i.code === "UNSUPPORTED_EFFICACY_CLAIM"),
  "Matching efficacy claim must be supported",
);

// E: Material claims: 'silver color finish' must NOT support 'sterling silver' or '925 silver'
const silverFinishCard = createFactCardV1({
  sessionId: "s_sf",
  draftId: "d_sf",
  locale: "en",
  facts: [
    createFact({
      id: "mat-finish",
      key: "material",
      value: "silver color finish",
      source: "product_catalog",
      trustLevel: "verified",
      category: "material",
      canonicalClaim: "silver color finish",
      claimPolarity: "affirmed",
    }),
  ],
});
const unsuppSilverFromFinish = validateCopy({
  title: "Decorative Box with Sterling Silver Trim",
  description: "Beautiful accent box with 925 silver detailing.",
  factCard: silverFinishCard,
});
assert.equal(unsuppSilverFromFinish.valid, false);
assert.ok(
  unsuppSilverFromFinish.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM" && i.field === "title"),
  "'silver color finish' must not support 'sterling silver' in title",
);
assert.ok(
  unsuppSilverFromFinish.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM" && i.field === "description"),
  "'silver color finish' must not support '925 silver' in description",
);

// F: Generic X-inspired / style / dupe brand inference deleted
const styleCopyPass = validateCopy({
  title: "Vintage Inspired Mug",
  description: "Coastal style decor crafted with boho styling.",
  factCard: validCard,
});
assert.ok(
  !styleCopyPass.issues.some(i => i.code === "UNSUPPORTED_BRAND_CLAIM"),
  "'Vintage Inspired', 'Coastal style', 'boho styling' must pass brand checks",
);

// Material facts use token boundaries, not arbitrary substrings.
for (const [factValue, claim] of [
  ["leatherette synthetic material", "Leather tote"],
  ["golden metal finish", "Gold tray"],
] as const) {
  const boundaryCard = createFactCardV1({
    sessionId: "s_boundary",
    draftId: "d_boundary",
    locale: "en",
    facts: [createFact({
      id: `material-${factValue}`,
      key: "material",
      value: factValue,
      source: "product_catalog",
      trustLevel: "verified",
      category: "material",
      canonicalClaim: factValue,
      claimPolarity: "affirmed",
    })],
  });
  const report = validateCopy({ title: claim, description: "Decor item.", factCard: boundaryCard });
  assert.ok(report.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM"));
}

// Negated evidence can never support the opposite commercial claim.
const negatedCard = createFactCardV1({
  sessionId: "s_negated",
  draftId: "d_negated",
  locale: "en",
  facts: [
    createFact({ id: "neg-eff", key: "efficacy", value: "not clinically proven", source: "product_catalog", trustLevel: "verified", category: "efficacy", canonicalClaim: "clinically proven", claimPolarity: "negated" }),
    createFact({ id: "neg-stock", key: "availability", value: "not in stock", source: "product_catalog", trustLevel: "verified", category: "availability", canonicalClaim: "in stock", claimPolarity: "negated" }),
  ],
});
const negatedReport = validateCopy({
  title: "Clinically Proven Cream",
  description: "In stock today.",
  factCard: negatedCard,
});
assert.ok(negatedReport.issues.some(i => i.code === "UNSUPPORTED_EFFICACY_CLAIM"));
assert.ok(negatedReport.issues.some(i => i.code === "UNSUPPORTED_AVAILABILITY_CLAIM"));

// Numeric evidence observes token boundaries: 13-pack does not support 3-pack.
const thirteenPackCard = createFactCardV1({
  sessionId: "s_pack",
  draftId: "d_pack",
  locale: "en",
  facts: [createFact({ id: "pack-13", key: "pack", value: "13-pack", source: "product_catalog", trustLevel: "verified", category: "numeric_commercial", canonicalClaim: "13-pack", claimPolarity: "affirmed" })],
});
const wrongPackReport = validateCopy({ title: "3-Pack Storage Set", description: "Organize any room.", factCard: thirteenPackCard });
assert.ok(wrongPackReport.issues.some(i => i.code === "UNSUPPORTED_NUMERIC_CLAIM"));

// Claim detection is an explicit completed-stage contract, even when no claims were found.
const completedNoClaims: ValidateCopyInput["claimDetection"] = { status: "completed", claims: [] };
assert.equal(completedNoClaims.status, "completed");
const incompleteDetectionReport = validateCopyV2({
  title: "Plain mug",
  description: "Plain description.",
  factCard: validCard,
  claimDetection: undefined,
} as unknown as ValidateCopyInput);
assert.ok(incompleteDetectionReport.issues.some(i => i.code === "CLAIM_DETECTION_INCOMPLETE"));

// Non-space languages use phrase-aware counting.
const chineseKeywordReport = validateCopy({
  title: "咖啡杯咖啡杯",
  description: "陶瓷马克杯",
  factCard: validCard,
  keywords: ["咖啡杯"],
});
assert.ok(chineseKeywordReport.issues.some(i => i.code === "KEYWORD_FREQUENCY_TITLE"));
const chineseStuffingReport = validateCopy({
  title: "陶瓷杯",
  description: "咖啡杯咖啡杯咖啡杯",
  factCard: validCard,
});
assert.ok(chineseStuffingReport.issues.some(i => i.code === "CONSECUTIVE_WORD_STUFFING"));

// Structured canonical claims must preserve material qualifiers; substrings in
// otherwise trusted facts cannot prove stronger bare-material claims.
for (const [factValue, canonicalClaim, title] of [
  ["Faux leather exterior", "faux leather", "Leather Bag"],
  ["Silk-like polyester fabric", "silk-like polyester", "Silk Scarf"],
  ["PU leather exterior", "PU leather", "Leather Bag"],
  ["Gold tone finish", "gold tone", "Gold Necklace"],
  ["Gold coated metal", "gold coated metal", "Gold Ring"],
] as const) {
  const qualifierCard = createFactCardV1({
    sessionId: "s_qualifier",
    draftId: "d_qualifier",
    locale: "en",
    facts: [createFact({
      id: `qualifier-${canonicalClaim}`,
      key: "material",
      value: factValue,
      source: "product_catalog",
      trustLevel: "verified",
      category: "material",
      canonicalClaim,
      claimPolarity: "affirmed",
    })],
  });
  const report = validateCopy({ title, description: "A styled accessory.", factCard: qualifierCard });
  assert.ok(report.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM"));
}

// The exact qualified material remains valid, while a second uncovered bare
// claim in the same field is still rejected.
for (const [canonicalClaim, title] of [
  ["faux leather", "Faux Leather Bag"],
  ["silk-like polyester", "Silk-like Polyester Scarf"],
] as const) {
  const qualifiedCard = createFactCardV1({
    sessionId: "s_qualified",
    draftId: "d_qualified",
    locale: "en",
    facts: [createFact({
      id: `qualified-${canonicalClaim}`,
      key: "material",
      value: canonicalClaim,
      source: "product_catalog",
      trustLevel: "verified",
      category: "material",
      canonicalClaim,
      claimPolarity: "affirmed",
    })],
  });
  const supported = validateCopy({ title, description: "Accurate product description.", factCard: qualifiedCard });
  assert.ok(!supported.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM"));

  const mixed = validateCopy({
    title: `${title} with ${canonicalClaim.includes("leather") ? "leather" : "silk"} trim`,
    description: "Accurate product description.",
    factCard: qualifiedCard,
  });
  assert.ok(mixed.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM"));
}

// Polarity is language-independent: validators never infer positive support
// from a material word embedded in a negative source sentence.
for (const [locale, value, canonicalClaim, title] of [
  ["zh-CN", "不是真丝，是聚酯纤维", "真丝", "真丝围巾"],
  ["es-ES", "No es seda; es poliéster", "seda", "Bufanda de seda"],
] as const) {
  const negatedMaterialCard = createFactCardV1({
    sessionId: `s_negated_${locale}`,
    draftId: `d_negated_${locale}`,
    locale,
    facts: [createFact({
      id: `negated-${locale}`,
      key: "material",
      value,
      source: "product_catalog",
      trustLevel: "verified",
      category: "material",
      canonicalClaim,
      claimPolarity: "negated",
    })],
  });
  const report = validateCopy({
    title,
    description: "Styled accessory.",
    factCard: negatedMaterialCard,
    claimDetection: { status: "completed", claims: [{ type: "material", value: canonicalClaim, field: "title" }] },
  });
  assert.ok(report.issues.some(i => i.code === "UNSUPPORTED_MATERIAL_CLAIM"));
}

console.log("=== test-ai-copy-v2-facts: all tests passed! ===");
