// Deterministic reference analyzer (Creative Intelligence — Step 1).
//
// NO LLM. NO network. Works purely from the metadata a reference asset already
// carries (visualFormat, humanPresence, title, keyword, category, source). When a
// signal is absent the analyzer degrades honestly to "unknown"/"generic" and lowers
// its confidence — it never invents pixel-level facts it cannot know.
//
// Input surface (from SelectedCreativeAsset, role === "reference"):
//   visualFormat   on_body | flat_lay | mirror_selfie | room_scene | unknown
//   humanPresence  visible_person | no_person | unknown
//   title / keyword / category   free text tokens
//   source / sourceContext       provenance hints

import type { SelectedCreativeAsset } from "./creativeDirections";

export type ReferenceType =
  | "outfit_on_model"
  | "street_style"
  | "mirror_selfie"
  | "flat_lay"
  | "lifestyle"
  | "room_scene"
  | "product_showcase"
  | "tutorial"
  | "before_after"
  | "moodboard"
  | "close_up"
  | "editorial"
  | "infographic"
  | "quote"
  | "recipe"
  | "travel_scene"
  | "generic";

export type Framing =
  | "full_body"
  | "half_body"
  | "close_up"
  | "detail"
  | "room_wide"
  | "product_focus"
  | "unknown";

export type VisualStyle =
  | "pinterest_lifestyle"
  | "editorial"
  | "commercial"
  | "influencer"
  | "catalog"
  | "tutorial"
  | "moodboard"
  | "unknown";

export type SceneType =
  | "indoor"
  | "outdoor"
  | "studio"
  | "neutral"
  | "room"
  | "street"
  | "unknown";

export type RefMood =
  | "cozy"
  | "minimal"
  | "luxury"
  | "casual"
  | "feminine"
  | "bold"
  | "modern"
  | "natural"
  | "romantic"
  | "playful"
  | "professional"
  | "unknown";

export type ReferenceAnalysis = {
  imageUrl: string;
  referenceType: ReferenceType;
  containsPerson: boolean;
  containsProduct: boolean;
  containsTextOverlay: boolean;
  framing: Framing;
  pose?: string;
  composition: string;
  sceneType: SceneType;
  lighting: string;
  mood: RefMood;
  visualStyle: VisualStyle;
  productVisibility: "high" | "medium" | "low";
  textOverlayStyle: "none" | "light" | "headline" | "information_rich";
  visualDensity: "minimal" | "moderate" | "rich";
  /** which reference dimensions are safe to influence the output by default */
  influenceDefaults: {
    pose: boolean;
    framing: boolean;
    scene: boolean;
    mood: boolean;
    styling: boolean;
    colorPalette: boolean;
  };
  /** how much real signal we had — drives recommendation confidence downstream */
  confidence: "high" | "medium" | "low";
  /** which inputs drove the verdict (audit / debugging) */
  signals: string[];
};

// ── Token banks ────────────────────────────────────────────────────────────────

// Order matters — the first matching row wins. Specific/fashion-person formats are
// listed before broad ones so an outfit/street/mirror reference is never read as
// a generic scene when the title carries those words.
const TYPE_TOKENS: Array<{ type: ReferenceType; tokens: string[] }> = [
  { type: "recipe",          tokens: ["recipe", "ingredients", "how to make", "baking", "cooking"] },
  { type: "before_after",    tokens: ["before after", "before and after", "transformation", "makeover", "glow up"] },
  { type: "tutorial",        tokens: ["tutorial", "step by step", "how to", "diy", "steps"] },
  { type: "quote",           tokens: ["quote", "affirmation", "saying", "mantra"] },
  { type: "infographic",     tokens: ["infographic", "chart", "checklist", "tips list", "guide list"] },
  { type: "mirror_selfie",   tokens: ["mirror selfie", "mirror outfit", "mirror pic", "outfit check", "fit check", "selfie"] },
  { type: "street_style",    tokens: ["street style", "streetstyle", "street wear", "streetwear", "fashion blogger", "influencer outfit", "city outfit", "urban outfit"] },
  { type: "outfit_on_model", tokens: ["model", "ootd", "outfit on", "worn", "on body", "on-body", "full body", "half body", "lookbook", "outfit", "wearing", "styled look", "apparel on"] },
  { type: "flat_lay",        tokens: ["flat lay", "flatlay", "knolling", "laid out", "overhead", "top view", "layout"] },
  { type: "room_scene",      tokens: ["living room", "bedroom", "interior", "room scene", "shelf", "decor scene", "nook", "studio apartment", "room "] },
  { type: "travel_scene",    tokens: ["travel", "destination", "wanderlust", "itinerary", "vacation", "trip", "beach", "city guide"] },
  { type: "moodboard",       tokens: ["moodboard", "mood board", "inspo board", "collage", "palette board"] },
  { type: "product_showcase",tokens: ["product shot", "product showcase", "catalog", "packshot", "on white", "product only"] },
  { type: "close_up",        tokens: ["close up", "closeup", "macro", "detail shot", "texture", "application close"] },
  { type: "editorial",       tokens: ["editorial", "magazine", "campaign", "high fashion", "vogue"] },
  { type: "lifestyle",       tokens: ["lifestyle", "in use", "everyday", "candid", "in context", "aesthetic"] },
];

// Soft fashion/person signals — if any of these appear and no specific type matched,
// we still know the reference is fashion/person-oriented (not a generic still life).
const FASHION_PERSON_TOKENS = [
  "fashion", "outfit", "apparel", "clothing", "wardrobe", "style", "styled", "model",
  "person", "woman", "man", "girl", "wearing", "pose", "posing", "look", "ootd",
  "lookbook", "editorial", "street", "mirror", "selfie", "influencer", "blogger",
];

const MOOD_TOKENS: Array<{ mood: RefMood; tokens: string[] }> = [
  { mood: "cozy",         tokens: ["cozy", "cosy", "warm", "hygge", "snug"] },
  { mood: "minimal",      tokens: ["minimal", "minimalist", "clean", "simple", "scandi", "japandi"] },
  { mood: "luxury",       tokens: ["luxury", "luxe", "premium", "elegant", "opulent", "quiet luxury"] },
  { mood: "casual",       tokens: ["casual", "relaxed", "everyday", "laid back"] },
  { mood: "feminine",     tokens: ["feminine", "soft", "delicate", "coquette", "girly"] },
  { mood: "bold",         tokens: ["bold", "vibrant", "colorful", "statement", "maximalist"] },
  { mood: "modern",       tokens: ["modern", "contemporary", "sleek"] },
  { mood: "natural",      tokens: ["natural", "organic", "earthy", "botanical", "raw"] },
  { mood: "romantic",     tokens: ["romantic", "dreamy", "ethereal", "whimsical"] },
  { mood: "playful",      tokens: ["playful", "fun", "quirky", "y2k"] },
  { mood: "professional", tokens: ["professional", "corporate", "polished", "business"] },
];

const SCENE_TOKENS: Array<{ scene: SceneType; tokens: string[] }> = [
  { scene: "outdoor", tokens: ["outdoor", "outside", "garden", "beach", "street", "park", "nature"] },
  { scene: "street",  tokens: ["street style", "street", "urban", "city"] },
  { scene: "studio",  tokens: ["studio", "seamless", "on white", "backdrop"] },
  { scene: "room",    tokens: ["room", "living room", "bedroom", "interior", "home"] },
  { scene: "indoor",  tokens: ["indoor", "inside", "cafe", "kitchen"] },
];

function textOf(asset: SelectedCreativeAsset): string {
  return [asset.title, asset.keyword, asset.category, asset.sourceContext, asset.itemType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function firstMatch<T>(text: string, banks: Array<{ tokens: string[] } & T>): (T | null) {
  for (const bank of banks) {
    if (bank.tokens.some(tok => text.includes(tok))) return bank;
  }
  return null;
}

// ── Single-reference analysis ───────────────────────────────────────────────────

export function analyzeReference(asset: SelectedCreativeAsset): ReferenceAnalysis {
  const text = textOf(asset);
  const vf = (asset.visualFormat ?? "").toLowerCase().trim();
  const hp = (asset.humanPresence ?? "").toLowerCase().trim();
  const signals: string[] = [];

  const fashionPersonHint = FASHION_PERSON_TOKENS.some(t => text.includes(t));

  // 1. containsPerson — humanPresence is the strongest deterministic signal
  let containsPerson = false;
  if (hp === "visible_person") { containsPerson = true; signals.push("humanPresence=visible_person"); }
  else if (hp === "no_person") { containsPerson = false; signals.push("humanPresence=no_person"); }
  else if (vf === "on_body" || vf === "mirror_selfie") { containsPerson = true; signals.push(`visualFormat=${vf}`); }
  else if (/\b(model|person|woman|man|girl|selfie|wearing|pose)\b/.test(text)) { containsPerson = true; signals.push("title:person"); }

  // 2. referenceType — visualFormat wins, then tokens, then a fashion/person hint,
  //    then default. We never leave a fashion/person reference as a generic scene.
  let referenceType: ReferenceType = "generic";
  if (vf === "mirror_selfie") { referenceType = "mirror_selfie"; signals.push("visualFormat=mirror_selfie"); }
  else if (vf === "on_body")  { referenceType = "outfit_on_model"; signals.push("visualFormat=on_body"); }
  else if (vf === "flat_lay") { referenceType = "flat_lay";  signals.push("visualFormat=flat_lay"); }
  else if (vf === "room_scene"){ referenceType = "room_scene"; signals.push("visualFormat=room_scene"); }
  else {
    const m = firstMatch(text, TYPE_TOKENS);
    if (m) { referenceType = m.type; signals.push(`title:${m.type}`); }
    else if (fashionPersonHint) {
      // A fashion/person-oriented reference with no precise format → treat as
      // an outfit-on-model reference (the most useful fashion interpretation).
      referenceType = containsPerson ? "outfit_on_model" : "editorial";
      signals.push("fashion_person_hint");
    }
  }

  // 3. framing — derive from referenceType + person signal
  let framing: Framing = "unknown";
  switch (referenceType) {
    case "mirror_selfie":   framing = "full_body"; break;
    case "street_style":
    case "outfit_on_model": framing = "half_body"; break;
    case "room_scene":      framing = "room_wide"; break;
    case "close_up":        framing = "close_up"; break;
    case "product_showcase":framing = "product_focus"; break;
    case "flat_lay":        framing = "detail"; break;
    default:                framing = containsPerson ? "half_body" : "unknown";
  }

  // 4. visualStyle
  let visualStyle: VisualStyle = "unknown";
  if (referenceType === "tutorial" || referenceType === "recipe") visualStyle = "tutorial";
  else if (referenceType === "moodboard") visualStyle = "moodboard";
  else if (referenceType === "editorial") visualStyle = "editorial";
  else if (referenceType === "product_showcase") visualStyle = "catalog";
  else if (referenceType === "mirror_selfie" || referenceType === "street_style") visualStyle = "influencer";
  else if (referenceType === "outfit_on_model") visualStyle = "editorial";
  else if (referenceType === "lifestyle" || referenceType === "room_scene") visualStyle = "pinterest_lifestyle";
  else if (text.includes("commercial") || text.includes("ad")) visualStyle = "commercial";

  // 5. sceneType
  let sceneType: SceneType = "unknown";
  const sceneHit = firstMatch(text, SCENE_TOKENS);
  if (sceneHit) { sceneType = sceneHit.scene; signals.push(`scene:${sceneHit.scene}`); }
  else if (referenceType === "room_scene") sceneType = "room";
  else if (referenceType === "street_style") sceneType = "street";
  else if (referenceType === "mirror_selfie") sceneType = "indoor";
  else if (referenceType === "product_showcase" || referenceType === "flat_lay") sceneType = "studio";

  // 6. mood
  let mood: RefMood = "unknown";
  const moodHit = firstMatch(text, MOOD_TOKENS);
  if (moodHit) { mood = moodHit.mood; signals.push(`mood:${moodHit.mood}`); }

  // 7. containsProduct / containsTextOverlay (best-effort)
  const containsTextOverlay =
    referenceType === "quote" || referenceType === "infographic" || referenceType === "tutorial" ||
    text.includes("text") || text.includes("caption");
  const containsProduct =
    referenceType === "product_showcase" || referenceType === "flat_lay" ||
    referenceType === "outfit_on_model" || referenceType === "street_style" ||
    referenceType === "mirror_selfie" || referenceType === "close_up" ||
    asset.itemType === "product";

  // 8. confidence — how much hard signal did we actually have?
  let score = 0;
  if (vf && vf !== "unknown") score += 2;
  if (hp && hp !== "unknown") score += 2;
  if (referenceType !== "generic") score += 1;
  if (fashionPersonHint) score += 1;
  if (moodHit) score += 1;
  if (sceneHit) score += 1;
  const confidence: ReferenceAnalysis["confidence"] = score >= 4 ? "high" : score >= 2 ? "medium" : "low";

  // 9. Derived creative dimensions
  const pose = containsPerson
    ? (referenceType === "mirror_selfie" ? "mirror outfit pose"
      : referenceType === "street_style" ? "candid street pose"
      : referenceType === "outfit_on_model" ? "relaxed standing pose"
      : "natural pose")
    : undefined;

  const composition =
    referenceType === "flat_lay" ? "overhead grid layout"
    : referenceType === "room_scene" ? "wide rule-of-thirds interior"
    : referenceType === "outfit_on_model" || referenceType === "street_style" || referenceType === "mirror_selfie" ? "centered subject portrait"
    : referenceType === "moodboard" ? "multi-panel collage"
    : referenceType === "infographic" || referenceType === "tutorial" ? "stacked information layout"
    : "balanced single-subject composition";

  const lighting =
    sceneType === "studio" ? "clean diffused studio light"
    : sceneType === "outdoor" || sceneType === "street" ? "natural daylight"
    : mood === "cozy" ? "warm ambient light"
    : "soft natural light";

  const productVisibility: ReferenceAnalysis["productVisibility"] =
    referenceType === "product_showcase" || referenceType === "close_up" || referenceType === "flat_lay" ? "high"
    : referenceType === "outfit_on_model" || referenceType === "street_style" || referenceType === "mirror_selfie" || referenceType === "lifestyle" || referenceType === "room_scene" ? "medium"
    : "low";

  const textOverlayStyle: ReferenceAnalysis["textOverlayStyle"] =
    referenceType === "infographic" ? "information_rich"
    : referenceType === "quote" ? "headline"
    : referenceType === "tutorial" ? "light"
    : containsTextOverlay ? "light"
    : "none";

  const visualDensity: ReferenceAnalysis["visualDensity"] =
    referenceType === "moodboard" || referenceType === "room_scene" || referenceType === "infographic" ? "rich"
    : referenceType === "close_up" || referenceType === "product_showcase" ? "minimal"
    : "moderate";

  // Default influence map — person references influence style/pose/scene but NEVER identity.
  const influenceDefaults = {
    pose: containsPerson,
    framing: true,
    scene: sceneType !== "unknown",
    mood: mood !== "unknown",
    styling: true,
    colorPalette: true,
  };

  return {
    imageUrl: asset.imageUrl,
    referenceType,
    containsPerson,
    containsProduct,
    containsTextOverlay,
    framing,
    pose,
    composition,
    sceneType,
    lighting,
    mood,
    visualStyle,
    productVisibility,
    textOverlayStyle,
    visualDensity,
    influenceDefaults,
    confidence,
    signals,
  };
}

// ── User-facing label — never expose "generic" when a reference exists ───────────
const REFERENCE_TYPE_LABELS: Record<ReferenceType, string> = {
  outfit_on_model:  "Outfit on model",
  street_style:     "Street style",
  mirror_selfie:    "Mirror outfit",
  flat_lay:         "Flat lay",
  lifestyle:        "Lifestyle",
  room_scene:       "Room scene",
  product_showcase: "Product showcase",
  tutorial:         "Tutorial",
  before_after:     "Before & after",
  moodboard:        "Moodboard",
  close_up:         "Close-up",
  editorial:        "Editorial",
  infographic:      "Infographic",
  quote:            "Quote",
  recipe:           "Recipe",
  travel_scene:     "Travel scene",
  generic:          "Style reference", // friendly fallback — never the word "generic"
};

/** Human label for a reference type. Uncertain → "style reference", never "generic". */
export function referenceTypeLabel(type: ReferenceType): string {
  return REFERENCE_TYPE_LABELS[type] ?? "Style reference";
}

// ── Aggregate across selected references ─────────────────────────────────────────

export type ReferenceContext = {
  analyses: ReferenceAnalysis[];
  /** the most informative reference (highest confidence, first wins on ties) */
  dominant: ReferenceAnalysis | null;
  hasReferences: boolean;
};

export type ReferenceContextHint = {
  /** the playbook category id of the selected products, if known */
  productCategory?: string;
  /** true when the products form a complete fashion outfit (top+bottom / dress + bag) */
  isCompleteOutfit?: boolean;
};

const CONFIDENCE_RANK: Record<ReferenceAnalysis["confidence"], number> = { high: 3, medium: 2, low: 1 };

// Reference types that are explicitly product/flat (must NOT be overridden into on-model).
const EXPLICIT_NON_MODEL: ReferenceType[] = ["flat_lay", "product_showcase", "infographic", "quote", "moodboard"];

/**
 * Fashion-outfit contextual upgrade (Requirement #3): when the products form a
 * complete fashion outfit and the reference is anything that is NOT explicitly a
 * flat-lay / product-only / text format, prefer an outfit-on-model interpretation —
 * even when the reference's own metadata was weak. Confidence is raised to at least
 * medium so this never becomes the LOW default direction.
 */
function upgradeForFashionOutfit(a: ReferenceAnalysis): ReferenceAnalysis {
  if (EXPLICIT_NON_MODEL.includes(a.referenceType)) return a;
  if (a.referenceType === "street_style" || a.referenceType === "mirror_selfie") {
    return CONFIDENCE_RANK[a.confidence] >= 2 ? a : { ...a, confidence: "medium" };
  }
  const upgradedType: ReferenceType = "outfit_on_model";
  return {
    ...a,
    referenceType: upgradedType,
    framing: a.framing === "unknown" ? "half_body" : a.framing,
    composition: a.composition === "balanced single-subject composition" ? "centered subject portrait" : a.composition,
    productVisibility: "medium",
    confidence: CONFIDENCE_RANK[a.confidence] >= 2 ? a.confidence : "medium",
    signals: [...a.signals, "fashion_outfit_context_upgrade"],
  };
}

export function analyzeReferences(
  assets: SelectedCreativeAsset[],
  hint?: ReferenceContextHint,
): ReferenceContext {
  const refs = assets.filter(a => a.role === "reference");
  let analyses = refs.map(analyzeReference);

  if (hint?.productCategory === "fashion" && hint.isCompleteOutfit) {
    analyses = analyses.map(upgradeForFashionOutfit);
  }

  const dominant = analyses.reduce<ReferenceAnalysis | null>(
    (best, cur) => (!best || CONFIDENCE_RANK[cur.confidence] > CONFIDENCE_RANK[best.confidence] ? cur : best),
    null,
  );
  return { analyses, dominant, hasReferences: refs.length > 0 };
}
