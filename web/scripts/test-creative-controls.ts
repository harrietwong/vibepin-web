/**
 * Tests for the context-aware Create Pins controls:
 * opportunity ranking, diverse tags, and the auto-filled Direction brief.
 * Run: npx tsx scripts/test-creative-controls.ts
 */
import {
  rankOpportunities, buildCreativeTags, buildDirectionBrief, defaultSelectedTagIds,
  toggleTagSelection, cleanProductTitle,
} from "../src/lib/studio/creativeControls";
import { buildHiddenPrompt } from "../src/lib/studio/hiddenPromptBuilder";
import { getCategoryPlaybook } from "../src/lib/studio/categoryPlaybooks";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

console.log("\n=== Create Pins creative controls ===\n");

// ── Opportunity ranking: fashion upload must NOT surface Beauty/Nails/Home ────
const allOpps = [
  { keyword: "Summer Outfit Ideas", category: "fashion", priority_score: 70 },
  { keyword: "Aesthetic Outfits", category: "fashion", priority_score: 80 },
  { keyword: "Spring Fashion 2026", category: "fashion", priority_score: 65 },
  { keyword: "Street Style Outfit Ideas", category: "womens-fashion", priority_score: 60 },
  { keyword: "Aesthetic Nails", category: "beauty", priority_score: 90 },
  { keyword: "Summer Nails 2026", category: "nails", priority_score: 88 },
  { keyword: "Nail Ideas 2026", category: "beauty", priority_score: 85 },
  { keyword: "Lip Liner Looks", category: "beauty", priority_score: 84 },
  { keyword: "Aesthetic Room Decor", category: "home-decor", priority_score: 95 },
];
const ranked = rankOpportunities(allOpps, "fashion");
const rankedKw = ranked.map(o => o.keyword);
console.log("  before filtering:", allOpps.map(o => o.keyword).join(" | "));
console.log("  after filtering :", rankedKw.join(" | "));

check("fashion: includes Summer Outfit Ideas", rankedKw.includes("Summer Outfit Ideas"));
check("fashion: includes Aesthetic Outfits", rankedKw.includes("Aesthetic Outfits"));
check("fashion: includes Spring Fashion 2026", rankedKw.includes("Spring Fashion 2026"));
check("fashion: includes Street Style Outfit Ideas", rankedKw.includes("Street Style Outfit Ideas"));
check("fashion: EXCLUDES Aesthetic Nails", !rankedKw.includes("Aesthetic Nails"));
check("fashion: EXCLUDES Summer Nails 2026", !rankedKw.includes("Summer Nails 2026"));
check("fashion: EXCLUDES Nail Ideas 2026", !rankedKw.includes("Nail Ideas 2026"));
check("fashion: EXCLUDES Lip Liner Looks", !rankedKw.includes("Lip Liner Looks"));
check("fashion: EXCLUDES Aesthetic Room Decor", !rankedKw.includes("Aesthetic Room Decor"));
check("fashion: every result is fashion/outfit related",
  ranked.every(o => /fashion|outfit|style/i.test(`${o.keyword} ${o.category}`)), rankedKw.join(" | "));

// Home decor upload → only home opportunities
const home = rankOpportunities(allOpps, "home-decor").map(o => o.keyword);
check("home-decor: includes Aesthetic Room Decor", home.includes("Aesthetic Room Decor"));
check("home-decor: excludes fashion/nails", !home.some(k => /outfit|nail|lip/i.test(k)));

// Unknown category → no over-filtering (returns the list, priority-sorted)
const unknown = rankOpportunities(allOpps, "");
check("unknown category: returns all (no empty picker)", unknown.length === allOpps.length);

// ── Diverse tags ──────────────────────────────────────────────────────────────
const fashionTags = buildCreativeTags({
  category: "fashion",
  productTitles: ["blue paisley top", "flared jeans", "shoulder bag"],
  referenceType: "outfit_on_model",
  referenceSceneType: "outdoor",
  hasReference: true,
});
check("fashion: grouped tags available", fashionTags.length >= 12, String(fashionTags.length));
check("fashion: spans multiple dimensions", new Set(fashionTags.map(t => t.group)).size >= 3, [...new Set(fashionTags.map(t => t.group))].join(","));
check("fashion: includes a street-style tag", fashionTags.some(t => /street/i.test(t.label)));
check("fashion: includes full-body framing", fashionTags.some(t => /full-body/i.test(t.label)));
check("fashion: no 'Suggested' wording", fashionTags.every(t => !/suggested/i.test(t.label)));
check("fashion: has default-selected tags", defaultSelectedTagIds(fashionTags).length >= 3);
console.log("  fashion tags:", fashionTags.map(t => t.label).join(" | "));

const streetFormat = fashionTags.find(t => t.id === "f-fmt-street")!;
const mirrorFormat = fashionTags.find(t => t.id === "f-fmt-mirror")!;
const urbanScene = fashionTags.find(t => t.id === "f-sc-urban")!;
const sidewalkScene = fashionTags.find(t => t.id === "f-sc-sidewalk")!;
let selectedIds = [streetFormat.id, urbanScene.id];
selectedIds = toggleTagSelection(fashionTags, selectedIds, mirrorFormat.id);
check("format: selecting new format deselects previous format", selectedIds.includes(mirrorFormat.id) && !selectedIds.includes(streetFormat.id));
selectedIds = toggleTagSelection(fashionTags, selectedIds, sidewalkScene.id);
check("scene: multi-select keeps existing scene tags", selectedIds.includes(urbanScene.id) && selectedIds.includes(sidewalkScene.id));

check("clean title: paisley top", cleanProductTitle("Tonal Blue Paisley Mesh Butterfly Top | Cojira - motorlocks-com-us").includes("blue paisley"));
check("clean title: flared jeans", cleanProductTitle("Denim flare jeans - shop.example.com") === "flared jeans");
check("clean title: shoulder bag", cleanProductTitle("Brown Shoulder Bag | store.example.com") === "brown shoulder bag");

// Beauty fallback set (no fashion drift)
const beautyTags = buildCreativeTags({ category: "beauty", productTitles: ["serum"], hasReference: false });
check("beauty: tags are beauty-oriented", beautyTags.some(t => /beauty|product|application|routine/i.test(t.label)));
check("beauty: no fashion/home tags", !beautyTags.some(t => /outfit|room/i.test(t.label)));

// Unknown → general lifestyle (never home decor)
const unknownTags = buildCreativeTags({ category: "generic", productTitles: ["mystery gadget"], hasReference: false });
check("unknown: general lifestyle fallback, not home decor", !unknownTags.some(t => /room|interior|cozy/i.test(t.label)),
  unknownTags.map(t => t.label).join(" | "));

// ── Direction brief ─────────────────────────────────────────────────────────
const brief = buildDirectionBrief({
  category: "fashion",
  productTitles: ["blue paisley top", "flared jeans", "shoulder bag"],
  referenceType: "outfit_on_model",
  referenceSceneType: "outdoor",
  hasReference: true,
}, [
  { label: "Street-style outfit", group: "format" },
  { label: "Urban street", group: "scene" },
  { label: "Full-body framing", group: "composition" },
  { label: "Natural movement", group: "composition" },
  { label: "Editorial", group: "mood" },
]);
console.log("  brief:", brief);
check("brief: mentions all 3 products", ["blue paisley top", "flared jeans", "shoulder bag"].every(t => brief.includes(t)));
check("brief: street-style / outdoor", /street-style|urban|outdoor/i.test(brief));
check("brief: full-body framing", /full-body framing/i.test(brief));
check("brief: original model", /original model/i.test(brief));
check("brief: avoids studio", /avoid studio/i.test(brief));
check("brief: is concise (1–3 sentences)", (brief.match(/[.!?]/g)?.length ?? 0) <= 4, brief);
check("brief: no technical/model wording", !/prompt|model_id|provider|seed|cfg|temperature/i.test(brief));

const hiddenPrompt = buildHiddenPrompt({
  direction: null,
  productSet: {
    hasProducts: true,
    isCoherentSet: true,
    setSummary: "fashion outfit",
    category: "fashion",
    products: [
      { category: "fashion", productType: "apparel", role: "top", title: "blue paisley top", visualKeywords: [], isPrimary: true, productFidelityNotes: [] },
    ],
  },
  references: {
    hasReferences: true,
    dominant: {
      imageUrl: "ref.jpg",
      referenceType: "street_style",
      containsPerson: true,
      containsProduct: false,
      containsTextOverlay: false,
      framing: "full_body",
      composition: "street-style full-body composition",
      sceneType: "street",
      lighting: "natural daylight",
      mood: "casual",
      visualStyle: "editorial",
      productVisibility: "medium",
      textOverlayStyle: "none",
      visualDensity: "moderate",
      influenceDefaults: { pose: true, framing: true, scene: true, mood: true, styling: true, colorPalette: true },
      confidence: "high",
      signals: ["street style"],
    },
    analyses: [],
  },
  intent: {
    primaryOutcome: "show products worn by a model",
    subject: "on_model",
    rationale: "fashion products with street-style reference",
    influencedBy: ["products", "references", "category"],
    confidence: "high",
    userVisibleSummary: "street-style outfit",
    internalIntent: "on-model fashion",
    category: "fashion",
    primarySubject: "outfit",
    recommendedSubjectType: "on model",
    recommendedScene: "urban street",
    recommendedFormat: "street-style outfit",
    productSetSummary: "fashion outfit",
    referenceSummary: "street-style reference",
    reasoning: [],
  },
  playbook: getCategoryPlaybook("fashion"),
  controls: { referenceStrength: "strong", textOverlay: "none" },
  directionBrief: brief,
  selectedTags: [
    { id: "f-fmt-street", label: "Street-style outfit", group: "format" },
    { id: "f-sc-urban", label: "Urban street", group: "scene" },
  ],
  primaryFormatTag: "Street-style outfit",
  format: "2:3",
});
check("hidden prompt: includes creative tags", /CREATIVE TAGS[\s\S]*Street-style outfit[\s\S]*Urban street/.test(hiddenPrompt));
check("hidden prompt: includes direction brief", hiddenPrompt.includes(brief));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
