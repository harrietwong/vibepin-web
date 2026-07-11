/**
 * Tests for the lightweight Creative Recommendation layer (chips).
 * Run: npx tsx scripts/test-creative-recommendations.ts
 */
import { getRecommendedCreativeDirections, type SelectedCreativeAsset } from "../src/lib/studio/creativeDirections";
import { toCreativeRecommendations, toChipLabel } from "../src/lib/studio/creativeRecommendations";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
function p(title: string): SelectedCreativeAsset { return { role: "product", imageUrl: `p:${title}`, source: "upload", title, metadataConfidence: "stored" }; }
function r(title: string, vf?: string, hp?: string): SelectedCreativeAsset { return { role: "reference", imageUrl: `r:${title}`, source: "upload", title, visualFormat: vf, humanPresence: hp, metadataConfidence: "stored" }; }

console.log("\n=== Creative Recommendations (chips) ===\n");

// Fashion complete outfit + street-style reference
const fashionDirs = getRecommendedCreativeDirections({
  category: "fashion",
  assets: [p("blue paisley camisole"), p("flare jeans"), p("shoulder bag"),
           r("street style outfit on model, urban", "on_body", "visible_person")],
});
const fashionRecs = toCreativeRecommendations(fashionDirs);

check("returns exactly 3 recommendations", fashionRecs.length === 3, String(fashionRecs.length));
check("each recommendation has a label", fashionRecs.every(r => !!r.label));
check("labels are short (<= 24 chars)", fashionRecs.every(r => r.label.length <= 24), fashionRecs.map(r => r.label).join(" | "));
check("no label contains the word 'Suggested'", fashionRecs.every(r => !/suggested/i.test(r.label)));
check("no internal jargon in labels (Top/Bottom/Bag/confidence/influenced)",
  fashionRecs.every(r => !/\b(top|bottom|bag|confidence|influenced|prompt|why)\b/i.test(r.label)),
  fashionRecs.map(r => r.label).join(" | "));
check("first chip is street-style/outfit oriented",
  /street|outfit/i.test(fashionRecs[0].label), fashionRecs[0].label);
check("each chip maps to an internal direction id", fashionRecs.every(r => r.id === fashionDirs.find(d => d.id === r.id)?.id));
check("internalDirectionId carries the kind", fashionRecs.every(r => !!r.internalDirectionId));
console.log(`  fashion chips: [${fashionRecs.map(r => r.label).join("] [")}]`);

// Public shape must not leak reasoning into the label (other fields are internal-only)
check("label is the only user-facing string the chip renders",
  typeof fashionRecs[0].label === "string" && fashionRecs[0].label.length > 0);

// Digital planner (no reference)
const digitalDirs = getRecommendedCreativeDirections({
  category: "digital-products",
  assets: [p("printable weekly planner pdf")],
});
const digitalRecs = toCreativeRecommendations(digitalDirs);
check("digital: 3 chips", digitalRecs.length === 3);
check("digital: includes a preview/breakdown/benefit chip",
  digitalRecs.some(r => /preview|breakdown|benefit/i.test(r.label)), digitalRecs.map(r => r.label).join(" | "));
console.log(`  digital chips: [${digitalRecs.map(r => r.label).join("] [")}]`);

// toChipLabel strips internal suffixes
check("toChipLabel shortens 'Creator-style mirror outfit Pin' → 'Mirror outfit'",
  toChipLabel({ id: "x", title: "Creator-style mirror outfit Pin", summary: "", category: "fashion", source: "creative_intelligence" }) === "Mirror outfit");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
