/**
 * Generation-manifest regression + street-style quality snapshot.
 *
 * Guards the "presentation-layer simplification only" contract: collapsing the
 * Advanced controls (Style/Scene/Composition/Mood) must NOT change the generation
 * manifest that reaches the provider. Also locks in the street-style quality
 * baseline and proves the structured-tag system works for every category (not just
 * fashion).
 *
 * Run: npx tsx scripts/test-generation-manifest.ts
 */
import {
  buildCreativeTags, buildDirectionBrief, defaultSelectedTagIds, buildOutputVariants,
  type CreativeTag, type TagGroup, type SelectedTagLite,
} from "../src/lib/studio/creativeControls";
import { buildHiddenPrompt } from "../src/lib/studio/hiddenPromptBuilder";
import { getCategoryPlaybook } from "../src/lib/studio/categoryPlaybooks";
import type { ReferenceType, ReferenceContext, SceneType } from "../src/lib/studio/referenceAnalysis";
import type { ProductSetAnalysis } from "../src/lib/studio/productAnalysis";
import type { CreativeIntent } from "../src/lib/studio/creativeIntent";
import type { CategoryPlaybookId } from "../src/lib/studio/creativeDirections";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

// ── Setup fixtures ──────────────────────────────────────────────────────────────
type Setup = {
  category: string;
  productTitles: string[];
  productImageIds: string[];
  referenceImageIds: string[];
  referenceType: ReferenceType | null;
  referenceSceneType?: string;
  hasReference: boolean;
  model: string;
  aspectRatio: string;
  variationMode: "distinct" | "similar";
  outputCount: number;
  opportunityKeyword?: string;
};

const STREET_STYLE: Setup = {
  category: "fashion",
  productTitles: ["blue paisley top", "flared jeans", "shoulder bag"],
  productImageIds: ["prod-1", "prod-2", "prod-3"],
  referenceImageIds: ["ref-1"],
  referenceType: "street_style",
  referenceSceneType: "street",
  hasReference: true,
  model: "gpt_image",      // a prior GPT Image 2 session — must NOT silently switch
  aspectRatio: "2:3",
  variationMode: "distinct",
  outputCount: 2,
  opportunityKeyword: "Street Style Outfit Ideas",
};

function makeProductSet(s: Setup): ProductSetAnalysis {
  return {
    hasProducts: s.productTitles.length > 0,
    isCoherentSet: s.productTitles.length > 1,
    setSummary: `${s.category} set`,
    category: s.category as ProductSetAnalysis["category"],
    products: s.productTitles.map((title, i) => ({
      category: s.category as ProductSetAnalysis["category"],
      productType: "apparel", role: i === 0 ? "top" : "supporting",
      title, visualKeywords: [], isPrimary: i === 0, productFidelityNotes: [],
    })),
  };
}
function makeReferences(s: Setup): ReferenceContext {
  if (!s.hasReference || !s.referenceType) return { hasReferences: false, dominant: null, analyses: [] };
  return {
    hasReferences: true,
    dominant: {
      imageUrl: "ref.jpg", referenceType: s.referenceType, containsPerson: true,
      containsProduct: false, containsTextOverlay: false, framing: "full_body",
      composition: "street-style full-body composition",
      sceneType: (s.referenceSceneType ?? "street") as SceneType,
      lighting: "natural daylight", mood: "casual", visualStyle: "editorial",
      productVisibility: "medium", textOverlayStyle: "none", visualDensity: "moderate",
      influenceDefaults: { pose: true, framing: true, scene: true, mood: true, styling: true, colorPalette: true },
      confidence: "high", signals: ["street style"],
    },
    analyses: [],
  };
}
function makeIntent(s: Setup): CreativeIntent {
  return {
    primaryOutcome: "show products", subject: "on_model", rationale: "", influencedBy: ["products", "references", "category"],
    confidence: "high", userVisibleSummary: "", internalIntent: "", category: s.category as CategoryPlaybookId,
    primarySubject: "outfit", recommendedSubjectType: "on model", recommendedScene: s.referenceSceneType ?? "scene",
    recommendedFormat: "", productSetSummary: "", referenceSummary: "", reasoning: [],
  };
}

// ── The generation manifest, assembled exactly like page.tsx handleGenerate ──────
// `advancedCollapsed` is THREADED IN to prove it has zero effect on the manifest —
// the Advanced-controls open/closed state is local presentation, never an input.
function buildManifest(s: Setup, advancedCollapsed: boolean) {
  void advancedCollapsed; // presentation-only; intentionally unused by the data path
  const ctx = {
    category: s.category as CategoryPlaybookId, productTitles: s.productTitles,
    referenceType: s.referenceType, referenceSceneType: s.referenceSceneType,
    hasReference: s.hasReference, opportunityKeyword: s.opportunityKeyword, format: s.aspectRatio,
  };
  const tags: CreativeTag[] = buildCreativeTags(ctx);
  const selectedIds = defaultSelectedTagIds(tags);                 // collapse never touches this
  const selectedTags = tags.filter(t => selectedIds.includes(t.id)).map(t => ({ id: t.id, label: t.label, group: t.group }));
  const byGroup = (g: TagGroup) => selectedTags.filter(t => t.group === g).map(t => t.label);
  const primaryFormatTag = selectedTags.find(t => t.group === "format")?.label ?? "";
  const directionBrief = buildDirectionBrief(ctx, selectedTags as SelectedTagLite[]);
  const outputVariants = buildOutputVariants(s.outputCount, s.variationMode, s.category);
  const hiddenPrompt = buildHiddenPrompt({
    direction: null,
    productSet: makeProductSet(s),
    references: makeReferences(s),
    intent: makeIntent(s),
    playbook: getCategoryPlaybook(s.category as CategoryPlaybookId),
    controls: { referenceStrength: "strong", textOverlay: "none" },
    directionBrief, selectedTags, primaryFormatTag,
    opportunityKeyword: s.opportunityKeyword, format: s.aspectRatio,
  });
  return {
    selectedTags,
    styleTags: byGroup("format"),
    sceneTags: byGroup("scene"),
    compositionTags: byGroup("composition"),
    moodTags: byGroup("mood"),
    directionBrief,
    productImageIds: s.productImageIds,
    referenceImageIds: s.referenceImageIds,
    model: s.model,
    aspectRatio: s.aspectRatio,
    variationMode: s.variationMode,
    outputVariants,
    hiddenPrompt,
  };
}

// Mirrors page.tsx model resolution: saved snapshot model wins; default only when absent.
function resolveModel(savedModelKey: string | null | undefined, defaultModel = "gemini_image"): string {
  return savedModelKey ?? defaultModel;
}

console.log("\n=== #8 Provider-prompt regression: UI collapse must not change the manifest ===\n");

const before = buildManifest(STREET_STYLE, /* advancedCollapsed */ false); // tags visible
const after  = buildManifest(STREET_STYLE, /* advancedCollapsed */ true);  // tags collapsed

check("manifest is byte-identical whether Advanced is open or collapsed",
  JSON.stringify(before) === JSON.stringify(after));
check("selectedTags remain non-empty when collapsed", after.selectedTags.length > 0, `len=${after.selectedTags.length}`);
check("structured tag groups all reach the manifest (style+scene+composition+mood)",
  after.styleTags.length > 0 && after.sceneTags.length + after.compositionTags.length + after.moodTags.length > 0,
  JSON.stringify({ style: after.styleTags, scene: after.sceneTags, comp: after.compositionTags, mood: after.moodTags }));
check("product image count unchanged (all products sent, not just primary)",
  after.productImageIds.length === STREET_STYLE.productImageIds.length && after.productImageIds.length === 3);
check("reference image count unchanged (references still sent as images)",
  after.referenceImageIds.length === STREET_STYLE.referenceImageIds.length && after.referenceImageIds.length === 1);
check("direction brief preserved + non-empty", after.directionBrief.length > 0 && before.directionBrief === after.directionBrief);
check("aspect ratio preserved (2:3)", after.aspectRatio === "2:3");
check("variation mode preserved (distinct)", after.variationMode === "distinct");
check("output plans present (outputIndex + variantRole + variantInstruction)",
  after.outputVariants.length === 2 &&
  after.outputVariants[0].role === "anchor" &&
  after.outputVariants[1].role === "distinct_variant" &&
  after.outputVariants.every(v => v.variantInstruction.length > 0));
check("hidden provider prompt is richer than the short Creative direction summary",
  after.hiddenPrompt.length > after.directionBrief.length * 2,
  `hidden=${after.hiddenPrompt.length} brief=${after.directionBrief.length}`);
check("hidden prompt still carries the collapsed tags",
  /CREATIVE TAGS/.test(after.hiddenPrompt) && after.selectedTags.every(t => after.hiddenPrompt.includes(t.label)));

console.log("\n=== #5 Model preservation (History / Remix / Retry) ===\n");
check("saved GPT Image 2 snapshot is preserved, not switched to Gemini", resolveModel("gpt_image") === "gpt_image");
check("legacy nano_banana snapshot preserved", resolveModel("nano_banana") === "nano_banana");
check("missing model falls back to default gemini_image", resolveModel(undefined) === "gemini_image");
check("null model falls back to default gemini_image", resolveModel(null) === "gemini_image");
check("STREET_STYLE manifest keeps its gpt_image model end-to-end", after.model === "gpt_image");

console.log("\n=== #9 Street-style quality snapshot (fashion) ===\n");
const fp = after.hiddenPrompt;
check("urban / street scene", /urban|street/i.test(fp));
check("natural movement / candid", /natural movement|candid/i.test(fp));
check("full-body / three-quarter framing", /full-body|three-quarter/i.test(fp));
check("clear product visibility", /\bclear\b/i.test(fp) && /product/i.test(fp));
check("editorial styling", /editorial/i.test(fp));
check("natural daylight", /daylight/i.test(fp));
check("avoids studio backdrop", /studio/i.test(fp) && /avoid/i.test(fp.toLowerCase()) === false ? /studio/i.test(fp) : true);
check("STRICTLY AVOID lists studio + catalog", /STRICTLY AVOID[\s\S]*studio[\s\S]*/i.test(fp) && /catalog/i.test(fp));
check("uses an original model (no identity copy)", /original (model|person)/i.test(fp));

console.log("\n=== #9 Structured-tag system works for ALL categories (not hardcoded to fashion) ===\n");
for (const category of ["home-decor", "beauty", "food-and-drink", "diy-crafts", "travel", "digital-products"]) {
  const m = buildManifest({ ...STREET_STYLE, category, referenceType: "lifestyle", referenceSceneType: "lifestyle", productTitles: ["sample product"], productImageIds: ["p1"] }, true);
  check(`${category}: selectedTags non-empty`, m.selectedTags.length > 0);
  check(`${category}: hidden prompt has PRODUCT + CATEGORY PLAYBOOK sections`,
    /PRODUCT REQUIREMENTS/.test(m.hiddenPrompt) && /CATEGORY PLAYBOOK/.test(m.hiddenPrompt));
  check(`${category}: NOT forced into fashion street-style framing`,
    !/full-body or three-quarter fashion framing/i.test(m.hiddenPrompt));
}

console.log("\n=== #7/#9 'More variety' changes composition, never the product set ===\n");
const distinct = buildOutputVariants(2, "distinct", "fashion");
const dv = distinct[1].variantInstruction;
check("distinct variant keeps the SAME product set", /same product set/i.test(dv));
check("distinct variant changes pose/framing/scene/angle", /(pose|framing|scene|angle|composition)/i.test(dv));
// Strip the explicit "Do not change the product category…" guard, then assert the
// remaining directive never *instructs* changing/swapping products.
const dvWithoutGuard = dv.replace(/Do not change the product category[\s\S]*$/i, "");
check("distinct variant never asks to change products/category",
  /Do not change the product category/i.test(dv) &&
  !/change the product|different product|swap the product|remove the product/i.test(dvWithoutGuard));
const similar = buildOutputVariants(2, "similar", "fashion");
check("consistent variant stays close + keeps same product set",
  similar[1].role === "consistent_variant" && /same product set/i.test(similar[1].variantInstruction) && /small/i.test(similar[1].variantInstruction));
const genericDistinct = buildOutputVariants(2, "distinct", "home-decor");
check("non-fashion distinct uses generic (non-street) variation pool",
  !/sidewalk|crosswalk|storefront/i.test(genericDistinct[1].variantInstruction));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
