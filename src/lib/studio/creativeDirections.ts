import type { AssetItem } from "@/lib/assetStore";
import type { CreatePinsPrefill } from "@/lib/createPinsPrefill";
import { analyzeReferences, referenceTypeLabel, type ReferenceType } from "./referenceAnalysis";
import { inferCreativeIntent } from "./creativeIntent";
import { getCategoryPlaybook } from "./categoryPlaybooks";
import { analyzeProductSet } from "./productAnalysis";

export type SelectedCreativeAsset = {
  id?: string;
  role: "product" | "reference";
  imageUrl: string;
  source: string;
  title?: string;
  category?: string;
  keyword?: string;
  visualFormat?: string;
  humanPresence?: string;
  productType?: string;
  productSubtype?: string;
  itemType?: string;
  destinationType?: string;
  sourceContext?: string;
  productUrl?: string;
  sourceUrl?: string;
  sourceDomain?: string;
  metadataConfidence: "stored" | "prefill" | "url_only";
};

export type GuidedControls = {
  composition?: string;
  lighting?: string;
  mood?: string;
  productTreatment?: string;
  textTreatment?: string;
  referenceStrength?: string;
  // ── V1 high-level controls (additive) ──────────────────────────────────────
  goal?: string;
  subject?: string;
  productEmphasis?: string;
  textOverlay?: string;
};

export type DirectionKind = "closest_to_reference" | "product_focused" | "alternative";
export type DirectionConfidence = "high" | "medium" | "low";
export type InfluenceTag = "products" | "references" | "category" | "opportunity";

export type CreativeDirectionRecommendation = {
  id: string;
  title: string;
  summary: string;
  category: string;
  source: "category_playbook" | "creative_intelligence";
  // ── Creative Intelligence fields (all optional → backward compatible with
  //    persisted CreativeDirectionSnapshotV2 records that predate them) ──────────
  kind?: DirectionKind;
  /** spec alias of `kind` */
  type?: DirectionKind;
  shortDescription?: string;
  whyThisDirection?: string;
  /** spec alias of `whyThisDirection` */
  whyRecommended?: string;
  confidence?: DirectionConfidence;
  influencedBy?: InfluenceTag[];
  suggestedControls?: {
    goal?: string;
    subject?: string;
    framing?: string;
    scene?: string;
    style?: string;
    productEmphasis?: string;
    referenceStrength?: string;
    textOverlay?: string;
  };
  promptHints?: string[];
};

export type CreativeOpportunityContext = {
  enabled: boolean;
  removable: true;
  title?: string;
  keyword?: string;
  category?: string;
  evidenceSentence?: string;
  source?: string;
};

export type CategoryPlaybookId =
  | "home-decor"
  | "fashion"
  | "beauty"
  | "food-and-drink"
  | "diy-crafts"
  | "travel"
  | "digital-products"
  | "generic";

type PrefillAsset = NonNullable<CreatePinsPrefill["productImages"]>[number] | NonNullable<CreatePinsPrefill["pinReferences"]>[number];

const GENERIC_RECOMMENDATIONS: CreativeDirectionRecommendation[] = [
  {
    id: "generic-editorial-product",
    title: "Editorial product story",
    summary: "A polished Pinterest-native product composition with clean styling, clear subject focus, and aspirational visual pacing.",
    category: "generic",
    source: "category_playbook",
  },
  {
    id: "generic-visual-board",
    title: "Visual inspiration board",
    summary: "A save-worthy image board that borrows reference mood, layout rhythm, and lighting while keeping the output distinct.",
    category: "generic",
    source: "category_playbook",
  },
  {
    id: "generic-lifestyle-showcase",
    title: "Lifestyle showcase",
    summary: "A natural editorial scene that presents the subject in context without forcing a home, fashion, or beauty category.",
    category: "generic",
    source: "category_playbook",
  },
];

const PLAYBOOKS: Record<CategoryPlaybookId, CreativeDirectionRecommendation[]> = {
  "home-decor": [
    {
      id: "home-warm-room",
      title: "Warm room styling",
      summary: "A warm styled room scene with layered decor, soft light, and a clear Pinterest home inspiration angle.",
      category: "home-decor",
      source: "category_playbook",
    },
    {
      id: "home-vignette",
      title: "Styled decor vignette",
      summary: "A close editorial vignette with intentional props, tactile materials, and a strong save-worthy decor detail.",
      category: "home-decor",
      source: "category_playbook",
    },
    {
      id: "home-moodboard",
      title: "Room moodboard",
      summary: "A Pinterest moodboard-style composition that presents colors, textures, and decor ideas as a cohesive room concept.",
      category: "home-decor",
      source: "category_playbook",
    },
  ],
  fashion: [
    {
      id: "fashion-flat-lay",
      title: "Outfit flat lay",
      summary: "An editorial outfit flat lay focused on apparel and accessories, with styled texture, color coordination, and clean spacing.",
      category: "fashion",
      source: "category_playbook",
    },
    {
      id: "fashion-lookbook",
      title: "Lookbook editorial",
      summary: "A fashion lookbook image with outfit-first styling, confident framing, and a Pinterest-native creator aesthetic.",
      category: "fashion",
      source: "category_playbook",
    },
    {
      id: "fashion-mirror",
      title: "Mirror outfit shot",
      summary: "A fashion styling composition inspired by mirror outfit content, using pose and framing without copying a person’s identity.",
      category: "fashion",
      source: "category_playbook",
    },
  ],
  beauty: [
    {
      id: "beauty-flatlay",
      title: "Beauty flat lay",
      summary: "A clean beauty product flat lay with soft light, tactile surfaces, and clear hero product hierarchy.",
      category: "beauty",
      source: "category_playbook",
    },
    {
      id: "beauty-routine",
      title: "Routine shelfie",
      summary: "A skincare or beauty routine composition with organized products, gentle styling, and aspirational daily ritual energy.",
      category: "beauty",
      source: "category_playbook",
    },
    {
      id: "beauty-editorial",
      title: "Glossy editorial",
      summary: "A polished beauty editorial image with premium lighting, refined props, and a strong product-first focal point.",
      category: "beauty",
      source: "category_playbook",
    },
  ],
  "food-and-drink": [
    {
      id: "food-tabletop",
      title: "Styled tabletop",
      summary: "An appetizing tabletop scene with natural light, inviting composition, and clear food or drink focus.",
      category: "food-and-drink",
      source: "category_playbook",
    },
    {
      id: "food-recipe-board",
      title: "Recipe board",
      summary: "A Pinterest recipe-board image with ingredients, texture, and visual steps arranged in a save-friendly layout.",
      category: "food-and-drink",
      source: "category_playbook",
    },
    {
      id: "food-editorial",
      title: "Food editorial",
      summary: "A magazine-like food composition with styled surfaces, appetizing details, and seasonal mood.",
      category: "food-and-drink",
      source: "category_playbook",
    },
  ],
  "digital-products": [
    {
      id: "digital-device-mockup",
      title: "Device mockup",
      summary: "A clean device or desk mockup that makes the digital product legible, premium, and Pinterest-ready.",
      category: "digital-products",
      source: "category_playbook",
    },
    {
      id: "digital-printable-flatlay",
      title: "Printable flat lay",
      summary: "A styled printable or planner flat lay with paper texture, organized props, and strong product clarity.",
      category: "digital-products",
      source: "category_playbook",
    },
    {
      id: "digital-template-showcase",
      title: "Template showcase",
      summary: "A crisp template presentation with clear hierarchy, modern layout, and enough context to signal the use case.",
      category: "digital-products",
      source: "category_playbook",
    },
  ],
  "diy-crafts": [
    {
      id: "diy-finished-project",
      title: "Finished project hero",
      summary: "A styled hero shot of the completed craft in a warm, handmade setting that invites the saver to make it themselves.",
      category: "diy-crafts",
      source: "category_playbook",
    },
    {
      id: "diy-materials-flatlay",
      title: "Materials & supplies flat lay",
      summary: "An organized overhead of the materials and tools, clearly showing what the project needs at a glance.",
      category: "diy-crafts",
      source: "category_playbook",
    },
    {
      id: "diy-step-by-step",
      title: "Step-by-step tutorial",
      summary: "A multi-step Pinterest-native layout that walks through the make, optimized for saves and how-to intent.",
      category: "diy-crafts",
      source: "category_playbook",
    },
  ],
  travel: [
    {
      id: "travel-destination-scene",
      title: "Destination scene",
      summary: "An aspirational travel scene that sells the place — sweeping setting, golden light, and strong wanderlust pull.",
      category: "travel",
      source: "category_playbook",
    },
    {
      id: "travel-detail-moment",
      title: "Travel detail moment",
      summary: "A close, evocative travel detail — food, architecture, or object — that anchors the destination's mood.",
      category: "travel",
      source: "category_playbook",
    },
    {
      id: "travel-guide-board",
      title: "Travel guide board",
      summary: "A save-worthy guide-style composition that frames the destination as a plannable itinerary or tips board.",
      category: "travel",
      source: "category_playbook",
    },
  ],
  generic: GENERIC_RECOMMENDATIONS,
};

function clean(value: unknown): string | undefined {
  const v = typeof value === "string" ? value.trim() : "";
  return v && v !== "undefined" && v !== "null" ? v : undefined;
}

export function normalizeCategory(category?: string): CategoryPlaybookId {
  const cat = (category ?? "").toLowerCase().trim();
  if (!cat) return "generic";
  if (cat.includes("fashion") || cat.includes("outfit") || cat.includes("style")) return "fashion";
  if (cat.includes("beauty") || cat.includes("skincare") || cat.includes("makeup")) return "beauty";
  if (cat.includes("food") || cat.includes("drink") || cat.includes("recipe")) return "food-and-drink";
  if (cat.includes("diy") || cat.includes("craft") || cat.includes("handmade") || cat.includes("tutorial")) return "diy-crafts";
  if (cat.includes("travel") || cat.includes("destination") || cat.includes("vacation") || cat.includes("trip")) return "travel";
  if (cat.includes("digital") || cat.includes("printable") || cat.includes("template")) return "digital-products";
  if (cat.includes("home") || cat.includes("decor") || cat.includes("interior")) return "home-decor";
  return "generic";
}

function assetFromStore(item: AssetItem, role: "product" | "reference"): SelectedCreativeAsset {
  return {
    id: item.id,
    role,
    imageUrl: item.imageUrl,
    source: item.source,
    title: clean(item.title),
    category: clean(item.category),
    keyword: clean(item.keyword),
    visualFormat: clean(item.visualFormat),
    humanPresence: undefined,
    productType: clean(item.productType),
    productSubtype: clean(item.productSubtype),
    itemType: clean(item.itemType),
    destinationType: clean(item.destinationType),
    sourceContext: clean(item.sourceContext),
    productUrl: clean(item.productUrl),
    sourceUrl: clean(item.sourceUrl),
    sourceDomain: clean(item.sourceDomain),
    metadataConfidence: "stored",
  };
}

function assetFromPrefill(item: PrefillAsset, role: "product" | "reference"): SelectedCreativeAsset {
  return {
    id: item.id,
    role,
    imageUrl: item.imageUrl,
    source: item.source,
    title: clean(item.title),
    category: clean(item.category),
    keyword: "keyword" in item ? clean(item.keyword) : undefined,
    visualFormat: "visualFormat" in item ? clean(item.visualFormat) : undefined,
    humanPresence: "humanPresence" in item ? clean(item.humanPresence) : undefined,
    productUrl: "productUrl" in item ? clean(item.productUrl) : undefined,
    sourceDomain: "sourceDomain" in item ? clean(item.sourceDomain) : undefined,
    metadataConfidence: "prefill",
  };
}

export function buildSelectedCreativeAssets(input: {
  productUrls: string[];
  referenceUrls: string[];
  storedAssets: AssetItem[];
  prefill?: CreatePinsPrefill | null;
}): SelectedCreativeAsset[] {
  const byRoleUrl = new Map<string, AssetItem>();
  input.storedAssets.forEach(item => {
    const role = item.role === "product" ? "product" : "reference";
    byRoleUrl.set(`${role}:${item.imageUrl}`, item);
  });

  const prefillByRoleUrl = new Map<string, PrefillAsset>();
  input.prefill?.productImages?.forEach(item => prefillByRoleUrl.set(`product:${item.imageUrl}`, item));
  input.prefill?.pinReferences?.forEach(item => prefillByRoleUrl.set(`reference:${item.imageUrl}`, item));

  const build = (url: string, role: "product" | "reference"): SelectedCreativeAsset => {
    const stored = byRoleUrl.get(`${role}:${url}`);
    if (stored) return assetFromStore(stored, role);
    const prefill = prefillByRoleUrl.get(`${role}:${url}`);
    if (prefill) return assetFromPrefill(prefill, role);
    return { role, imageUrl: url, source: "url", metadataConfidence: "url_only" };
  };

  return [
    ...input.productUrls.map(url => build(url, "product")),
    ...input.referenceUrls.map(url => build(url, "reference")),
  ];
}

export function inferCreativeCategory(input: {
  explicitCategory?: string;
  assets: SelectedCreativeAsset[];
}): CategoryPlaybookId {
  const explicit = normalizeCategory(input.explicitCategory);
  if (explicit !== "generic") return explicit;
  for (const asset of input.assets) {
    const fromAsset = normalizeCategory(asset.category ?? asset.keyword ?? asset.title);
    if (fromAsset !== "generic") return fromAsset;
  }
  return "generic";
}

// ── Reference-type → "closest to reference" direction copy ────────────────────
// Category-aware so a fashion reference yields a fashion title (not "Pinterest-native
// scene"). The per-category map wins; otherwise the generic map is used.
const REF_TYPE_TITLE: Record<ReferenceType, string> = {
  outfit_on_model:  "On-model outfit portrait",
  street_style:     "Street-style outfit portrait",
  mirror_selfie:    "Creator-style mirror outfit Pin",
  flat_lay:         "Styled flat lay",
  lifestyle:        "Lifestyle lookbook",
  room_scene:       "Styled room scene",
  product_showcase: "Product showcase",
  tutorial:         "Step-by-step tutorial",
  before_after:     "Before & after",
  moodboard:        "Inspiration moodboard",
  close_up:         "Detail close-up",
  editorial:        "Product-visible outfit editorial",
  infographic:      "Benefit-led information Pin",
  quote:            "Quote graphic",
  recipe:           "Recipe board",
  travel_scene:     "Travel destination scene",
  generic:          "Reference-led scene", // never the literal word "generic"
};

// Per-category overrides for the reference-led (closest) title.
const CATEGORY_REF_TITLE: Partial<Record<CategoryPlaybookId, Partial<Record<ReferenceType, string>>>> = {
  "home-decor": {
    generic:   "Styled room scene",
    lifestyle: "Styled room scene",
    editorial: "Styled room scene",
  },
  beauty: {
    generic:         "On-model beauty application",
    outfit_on_model: "On-model beauty application",
    editorial:       "Product + face composition",
    lifestyle:       "Beauty routine Pin",
  },
  "digital-products": {
    generic:     "Benefit-led information Pin",
    lifestyle:   "Benefit-led information Pin",
    editorial:   "Product mockup showcase",
  },
  "food-and-drink": {
    generic:   "Food scene from reference",
    lifestyle: "Food scene from reference",
    editorial: "Food editorial scene",
  },
};

function refTitle(category: CategoryPlaybookId, type: ReferenceType): string {
  return CATEGORY_REF_TITLE[category]?.[type] ?? REF_TYPE_TITLE[type];
}

/**
 * Context-aware Creative Direction generator (Creative Intelligence — Step 5).
 *
 * Always returns exactly 3 directions:
 *   1. Closest to Reference   — built from the dominant reference's analysis
 *   2. Product-Focused        — maximises product clarity (category playbook)
 *   3. Alternative Format     — a different common Pinterest format for the category
 *
 * Each direction carries why_this_direction, confidence, and influenced_by.
 * When no reference is selected, Direction 1 degrades to the category's primary
 * format and lowers its confidence — it never fabricates reference signal.
 */
export function getRecommendedCreativeDirections(input: {
  category?: string;
  assets: SelectedCreativeAsset[];
  hasOpportunity?: boolean;
}): CreativeDirectionRecommendation[] {
  const category = inferCreativeCategory({ explicitCategory: input.category, assets: input.assets });
  const pool = PLAYBOOKS[category] ?? PLAYBOOKS.generic;
  const productSet = analyzeProductSet(input.assets);
  const isCompleteOutfit = productSet.category === "fashion" && productSet.isCoherentSet;
  const refCtx = analyzeReferences(input.assets, { productCategory: category, isCompleteOutfit });
  const hasProducts = input.assets.some(a => a.role === "product");
  const hasOpportunity = !!input.hasOpportunity;
  const intent = inferCreativeIntent({ category, references: refCtx, hasProducts, hasOpportunity });

  const baseInfluence: InfluenceTag[] = [];
  if (hasProducts) baseInfluence.push("products");

  // ── Direction 1 — Closest to Reference ──────────────────────────────────────
  const dom = refCtx.dominant;
  const d1Influence: InfluenceTag[] = [...baseInfluence];
  if (refCtx.hasReferences) d1Influence.push("references");
  d1Influence.push("category");
  if (hasOpportunity) d1Influence.push("opportunity");

  const moodScene = dom
    ? [dom.mood !== "unknown" ? `${dom.mood} mood` : "", dom.sceneType !== "unknown" ? `${dom.sceneType} setting` : ""]
        .filter(Boolean).join(", ")
    : "";

  // Specific reference type → describe matching that look. Uncertain ("generic")
  // reference → never say "Match the Generic look"; use the neutral wording.
  const d1Description = (() => {
    if (!dom) return "";
    if (dom.referenceType === "generic") {
      return `Use the reference for framing, styling, and mood while keeping the final image original${moodScene ? ` (${moodScene})` : ""}.`;
    }
    return `Match the ${referenceTypeLabel(dom.referenceType).toLowerCase()} look from your reference — ${intent.primaryOutcome}${moodScene ? `, following its ${moodScene}` : ""}, while keeping the output original.`;
  })();

  const d1: CreativeDirectionRecommendation = dom
    ? {
        id: `ci-closest-${category}-${dom.referenceType}`,
        kind: "closest_to_reference",
        title: refTitle(category, dom.referenceType),
        shortDescription: d1Description,
        summary: d1Description,
        whyThisDirection: intent.rationale,
        confidence: dom.confidence,
        influencedBy: d1Influence,
        category,
        source: "creative_intelligence",
      }
    : {
        id: `ci-closest-${category}-default`,
        kind: "closest_to_reference",
        title: pool[0].title,
        shortDescription: pool[0].summary,
        summary: pool[0].summary,
        whyThisDirection: "No reference selected — defaulting to the strongest Pinterest format for this category. Add a reference to tailor this direction.",
        confidence: "low",
        influencedBy: d1Influence,
        category,
        source: "creative_intelligence",
      };

  // Distinct-format selection: never let Direction 2/3 repeat a title already used
  // (e.g. a tutorial reference + a tutorial-based category alternative slot).
  const usedTitles = new Set<string>([d1.title]);
  const pickDistinct = (preferred: number, ...fallbacks: number[]): CreativeDirectionRecommendation => {
    for (const idx of [preferred, ...fallbacks]) {
      const entry = pool[idx];
      if (entry && !usedTitles.has(entry.title)) { usedTitles.add(entry.title); return entry; }
    }
    const any = pool.find(e => !usedTitles.has(e.title)) ?? pool[preferred] ?? pool[0];
    usedTitles.add(any.title);
    return any;
  };

  // ── Direction 2 — Product-Focused ───────────────────────────────────────────
  const productFmt = pickDistinct(1, 0, 2);
  const d2: CreativeDirectionRecommendation = {
    id: `ci-product-${category}`,
    kind: "product_focused",
    title: productFmt.title,
    shortDescription: productFmt.summary,
    summary: productFmt.summary,
    whyThisDirection: hasProducts
      ? "Prioritises product clarity and recognizability so shoppers immediately understand what's featured."
      : "A product-first format — add product images to anchor it.",
    confidence: hasProducts ? "high" : "low",
    influencedBy: hasProducts ? ["products", "category"] : ["category"],
    category,
    source: "creative_intelligence",
  };

  // ── Direction 3 — Alternative Pinterest Format ──────────────────────────────
  const altFmt = pickDistinct(2, 0, 1);
  const d3Influence: InfluenceTag[] = ["category"];
  if (hasOpportunity) d3Influence.push("opportunity");
  const d3: CreativeDirectionRecommendation = {
    id: `ci-alt-${category}`,
    kind: "alternative",
    title: altFmt.title,
    shortDescription: altFmt.summary,
    summary: altFmt.summary,
    whyThisDirection: "A different Pinterest-native format worth testing to see which composition earns more saves.",
    confidence: "medium",
    influencedBy: d3Influence,
    category,
    source: "creative_intelligence",
  };

  // ── Decorate with spec aliases, suggested controls, and prompt hints ──────────
  const pb = getCategoryPlaybook(category);
  const decorate = (d: CreativeDirectionRecommendation): CreativeDirectionRecommendation => {
    const base = pb.defaultControls;
    const controls =
      d.kind === "closest_to_reference" ? { ...base, referenceStrength: "Strong" }
      : d.kind === "product_focused"    ? { ...base, productEmphasis: "Product first", referenceStrength: "Subtle" }
      : { ...base };
    const typeHint =
      d.kind === "closest_to_reference" ? `Follow the reference's subject, pose, framing, scene, and mood${dom?.containsPerson ? " — original person, no identity copy" : ""}.`
      : d.kind === "product_focused"    ? "Maximise product visibility and fidelity; include every selected product where possible."
      : "Offer a distinct valid Pinterest format for this category.";
    return {
      ...d,
      type: d.kind,
      whyRecommended: d.whyThisDirection,
      suggestedControls: controls,
      promptHints: [...pb.hiddenPromptGuidance, typeHint],
    };
  };

  return [decorate(d1), decorate(d2), decorate(d3)];
}

export function buildManualBrief(input: {
  selected?: CreativeDirectionRecommendation | null;
  guidedControls: GuidedControls;
  customInstructions: string;
  opportunityContext?: CreativeOpportunityContext;
}): string {
  const parts: string[] = [];
  if (input.selected) parts.push(`${input.selected.title}: ${input.selected.summary}`);
  const controls = Object.entries(input.guidedControls)
    .filter(([, value]) => clean(value))
    .map(([key, value]) => `${key}: ${value}`);
  if (controls.length) parts.push(`Fine-tune direction: ${controls.join("; ")}.`);
  if (input.opportunityContext?.enabled) {
    const kw = input.opportunityContext.keyword ?? input.opportunityContext.title;
    if (kw) parts.push(`Market angle: ${kw}.`);
    if (input.opportunityContext.evidenceSentence) parts.push(`Opportunity evidence: ${input.opportunityContext.evidenceSentence}.`);
  }
  if (clean(input.customInstructions)) parts.push(`Custom instructions: ${input.customInstructions.trim()}`);
  return parts.join("\n\n");
}
