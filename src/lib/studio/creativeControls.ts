// Lightweight creative controls for Create Pins (context-aware, deterministic).
//
// - rankOpportunities: filter the opportunity picker to the inferred category.
// - buildCreativeTags: grouped chips (format = single-select; scene/mood/composition
//   = multi-select). format/scene/mood/composition drive the user-facing brief.
// - buildDirectionBrief: a concise, user-facing creative brief (NOT the hidden prompt).
// - cleanProductTitle: turn raw scraped titles into clean consumer phrases.

import { normalizeCategory, type CategoryPlaybookId } from "./creativeDirections";
import type { ReferenceType } from "./referenceAnalysis";

// ── Opportunity ranking ──────────────────────────────────────────────────────

export type RankableOpportunity = { keyword: string; category: string; priority_score?: number | null };

const CATEGORY_KEYWORD_HINTS: Record<CategoryPlaybookId, string[]> = {
  fashion: ["outfit", "outfits", "ootd", "fashion", "style", "streetwear", "street style", "lookbook", "wardrobe", "capsule", "denim", "jeans", "dress", "apparel", "wear"],
  "home-decor": ["decor", "room", "interior", "bedroom", "living room", "home", "shelf", "vignette", "apartment"],
  beauty: ["beauty", "skincare", "makeup", "nails", "nail", "lip", "serum", "vanity", "glow"],
  "food-and-drink": ["recipe", "food", "drink", "dish", "meal", "dessert", "cocktail", "snack", "baking"],
  "diy-crafts": ["diy", "craft", "crochet", "handmade", "knit", "sewing", "tutorial"],
  travel: ["travel", "destination", "vacation", "trip", "wanderlust", "itinerary"],
  "digital-products": ["printable", "template", "planner", "digital", "notion", "canva", "checklist"],
  generic: [],
};

export function rankOpportunities<T extends RankableOpportunity>(opps: T[], inferredCategory: string): T[] {
  const target = normalizeCategory(inferredCategory);
  if (target === "generic") {
    return [...opps].sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
  }
  const hints = CATEGORY_KEYWORD_HINTS[target] ?? [];
  const scored = opps.map(o => {
    const oppCat = normalizeCategory(o.category);
    const kw = o.keyword.toLowerCase();
    let score = 0;
    if (oppCat === target) score += 100;
    else if (hints.some(h => kw.includes(h))) score += 60;
    else if (oppCat !== "generic") score -= 100;
    score += Math.min(20, (o.priority_score ?? 0) / 5);
    return { o, score };
  });
  return scored.filter(s => s.score >= 50).sort((a, b) => b.score - a.score).map(s => s.o);
}

// ── Product title cleanup ─────────────────────────────────────────────────────

const TITLE_STOP_TOKENS = new Set([
  "the", "a", "an", "with", "for", "new", "premium", "official", "genuine",
  "women", "womens", "woman", "men", "mens", "unisex", "sale", "shop",
]);

/**
 * Turn a raw scraped product title into a short consumer phrase.
 * "Tonal Blue Paisley Mesh Butterfly Top | Cojira – motorlocks-com-us…" → "blue paisley mesh top"
 * Strips brand/source suffixes, URLs, domains; lowercases; caps to a few words.
 */
export function cleanProductTitle(raw: string): string {
  let t = (raw || "").trim();
  if (!t) return "product";
  t = t.replace(/https?:\/\/\S+/gi, "");
  t = t.replace(/\b[\w.-]+\.(com|net|org|co|us|shop|store|io)\b/gi, "");
  t = t.split(/\s*(?:\||•|·|—|–|\s-\s|::)\s*/)[0] ?? t;
  t = t.replace(/[®™©]/g, "");
  t = t.replace(/[^\w\s'-]/g, " ");
  t = t.replace(/\s{2,}/g, " ").trim().toLowerCase();

  const color = [
    "blue", "navy", "black", "white", "cream", "beige", "brown", "tan", "pink",
    "red", "green", "yellow", "gold", "silver", "gray", "grey", "denim",
  ].find(c => new RegExp(`\\b${c}\\b`, "i").test(t));

  if (/\bshoulder\s+bag\b/.test(t)) return `${color ? `${color} ` : ""}shoulder bag`.trim();
  const bagMatch = t.match(/\b(handbag|purse|tote|crossbody|bag)\b/);
  if (bagMatch?.[1]) return `${color ? `${color} ` : ""}${bagMatch[1]}`.trim();
  if (/\b(flare|flared|wide\s+leg|bootcut)\b/.test(t) && /\bjeans?\b/.test(t)) {
    const cut = /\bwide\s+leg\b/.test(t) ? "wide-leg" : /\bbootcut\b/.test(t) ? "bootcut" : "flared";
    return `${color && color !== "denim" ? `${color} ` : ""}${cut} jeans`.trim();
  }
  if (/\bjeans?\b/.test(t)) return `${color && color !== "denim" ? `${color} ` : ""}jeans`.trim();
  if (/\bpaisley\b/.test(t) && /\b(camisole|cami|top|shirt|blouse|tank)\b/.test(t)) {
    const role = /\b(camisole|cami)\b/.test(t) ? "camisole" : "top";
    return `${color ? `${color} ` : ""}paisley ${role}`.trim();
  }

  const words = t.split(/\s+/).filter(w => w && !TITLE_STOP_TOKENS.has(w));
  return (words.slice(0, 4).join(" ") || t).trim() || "product";
}

// ── Creative tags ────────────────────────────────────────────────────────────

export type TagGroup = "format" | "scene" | "mood" | "composition";
export type CreativeTag = { id: string; label: string; group: TagGroup; defaultSelected?: boolean };

export const TAG_GROUP_LABEL: Record<TagGroup, string> = {
  format: "Style", scene: "Scene", mood: "Mood", composition: "Composition",
};

// Per-category chip sets. EXACTLY ONE format tag is defaultSelected (single-select);
// scene/mood/composition may have several defaults (multi-select).
const CATEGORY_TAGS: Record<CategoryPlaybookId, CreativeTag[]> = {
  fashion: [
    { id: "f-fmt-street",    label: "Street-style outfit", group: "format", defaultSelected: true },
    { id: "f-fmt-portrait",  label: "Outfit portrait",     group: "format" },
    { id: "f-fmt-lookbook",  label: "Editorial lookbook",  group: "format" },
    { id: "f-fmt-mirror",    label: "Mirror outfit",       group: "format" },
    { id: "f-sc-urban",      label: "Urban street",        group: "scene", defaultSelected: true },
    { id: "f-sc-doorway",    label: "Outdoor doorway",     group: "scene" },
    { id: "f-sc-sidewalk",   label: "City sidewalk",       group: "scene" },
    { id: "f-sc-daylight",   label: "Natural daylight",    group: "scene" },
    { id: "f-mo-editorial",  label: "Editorial",           group: "mood", defaultSelected: true },
    { id: "f-mo-influencer", label: "Casual influencer",   group: "mood" },
    { id: "f-mo-effortless", label: "Effortless",          group: "mood" },
    { id: "f-mo-pinterest",  label: "Pinterest fashion",   group: "mood" },
    { id: "f-cp-fullbody",   label: "Full-body framing",   group: "composition", defaultSelected: true },
    { id: "f-cp-movement",   label: "Natural movement",    group: "composition", defaultSelected: true },
    { id: "f-cp-visible",    label: "Product-visible",     group: "composition", defaultSelected: true },
    { id: "f-cp-vertical",   label: "Vertical 2:3",        group: "composition" },
  ],
  "home-decor": [
    { id: "h-fmt-room",      label: "Styled room",         group: "format", defaultSelected: true },
    { id: "h-fmt-vignette",  label: "Interior vignette",   group: "format" },
    { id: "h-fmt-makeover",  label: "Room makeover",       group: "format" },
    { id: "h-sc-daylight",   label: "Natural daylight",    group: "scene", defaultSelected: true },
    { id: "h-mo-cozy",       label: "Cozy",                group: "mood", defaultSelected: true },
    { id: "h-mo-minimal",    label: "Minimal",             group: "mood" },
    { id: "h-cp-visible",    label: "Product-visible",     group: "composition", defaultSelected: true },
    { id: "h-cp-wide",       label: "Wide room framing",   group: "composition" },
  ],
  beauty: [
    { id: "b-fmt-closeup",   label: "Product close-up",    group: "format", defaultSelected: true },
    { id: "b-fmt-application",label: "Application shot",   group: "format" },
    { id: "b-fmt-routine",   label: "Routine layout",      group: "format" },
    { id: "b-sc-studio",     label: "Clean studio light",  group: "scene", defaultSelected: true },
    { id: "b-mo-clean",      label: "Clean beauty",        group: "mood", defaultSelected: true },
    { id: "b-mo-premium",    label: "Premium",             group: "mood" },
    { id: "b-cp-visible",    label: "Product-visible",     group: "composition", defaultSelected: true },
    { id: "b-cp-detail",     label: "Close-up detail",     group: "composition" },
  ],
  "food-and-drink": [
    { id: "fd-fmt-hero",     label: "Hero dish",           group: "format", defaultSelected: true },
    { id: "fd-fmt-recipe",   label: "Recipe Pin",          group: "format" },
    { id: "fd-fmt-ingredients", label: "Ingredient layout", group: "format" },
    { id: "fd-sc-daylight",  label: "Natural daylight",    group: "scene", defaultSelected: true },
    { id: "fd-mo-fresh",     label: "Fresh & inviting",    group: "mood", defaultSelected: true },
    { id: "fd-mo-rustic",    label: "Rustic",              group: "mood" },
    { id: "fd-cp-visible",   label: "Product-visible",     group: "composition", defaultSelected: true },
    { id: "fd-cp-tabletop",  label: "Tabletop framing",    group: "composition" },
  ],
  "digital-products": [
    { id: "d-fmt-preview",   label: "Product preview",     group: "format", defaultSelected: true },
    { id: "d-fmt-benefit",   label: "Benefit-led Pin",     group: "format" },
    { id: "d-fmt-checklist", label: "Checklist layout",    group: "format" },
    { id: "d-sc-mockup",     label: "Device mockup",       group: "scene", defaultSelected: true },
    { id: "d-mo-clean",      label: "Clean & modern",      group: "mood", defaultSelected: true },
    { id: "d-cp-readable",   label: "Readable layout",     group: "composition", defaultSelected: true },
    { id: "d-cp-text",       label: "Text overlay",        group: "composition", defaultSelected: true },
  ],
  "diy-crafts": [
    { id: "diy-fmt-finished", label: "Finished project",   group: "format", defaultSelected: true },
    { id: "diy-fmt-materials",label: "Materials flat lay", group: "format" },
    { id: "diy-fmt-steps",   label: "Step-by-step",        group: "format" },
    { id: "diy-sc-daylight", label: "Natural daylight",    group: "scene", defaultSelected: true },
    { id: "diy-mo-cozy",     label: "Handmade & cozy",     group: "mood", defaultSelected: true },
    { id: "diy-cp-visible",  label: "Product-visible",     group: "composition", defaultSelected: true },
  ],
  travel: [
    { id: "t-fmt-destination", label: "Destination scene", group: "format", defaultSelected: true },
    { id: "t-fmt-detail",    label: "Travel detail",       group: "format" },
    { id: "t-fmt-guide",     label: "Guide board",         group: "format" },
    { id: "t-sc-outdoor",    label: "Outdoor daylight",    group: "scene", defaultSelected: true },
    { id: "t-mo-aspirational",label: "Aspirational",       group: "mood", defaultSelected: true },
    { id: "t-cp-scenic",     label: "Scenic framing",      group: "composition", defaultSelected: true },
  ],
  generic: [
    { id: "g-fmt-lifestyle", label: "Lifestyle scene",     group: "format", defaultSelected: true },
    { id: "g-fmt-product",   label: "Product showcase",    group: "format" },
    { id: "g-sc-daylight",   label: "Natural daylight",    group: "scene", defaultSelected: true },
    { id: "g-mo-clean",      label: "Clean aesthetic",     group: "mood", defaultSelected: true },
    { id: "g-cp-visible",    label: "Product-visible",     group: "composition", defaultSelected: true },
    { id: "g-cp-vertical",   label: "Vertical 2:3",        group: "composition" },
  ],
};

export type CreativeControlContext = {
  category: CategoryPlaybookId;
  productTitles: string[];
  referenceType?: ReferenceType | null;
  referenceSceneType?: string;
  hasReference: boolean;
  opportunityKeyword?: string;
  format?: string;
};

export function buildCreativeTags(ctx: CreativeControlContext): CreativeTag[] {
  const base = (CATEGORY_TAGS[ctx.category] ?? CATEGORY_TAGS.generic).map(t => ({ ...t }));

  // Reference-aware default: a mirror_selfie reference makes "Mirror outfit" the
  // default format instead of Street-style. Otherwise Street-style stays default.
  if (ctx.category === "fashion" && ctx.referenceType === "mirror_selfie") {
    base.forEach(t => { if (t.group === "format") t.defaultSelected = t.id === "f-fmt-mirror"; });
  }
  return base;
}

/** Default selection — enforces a SINGLE default format tag. */
export function defaultSelectedTagIds(tags: CreativeTag[]): string[] {
  const out: string[] = [];
  let formatPicked = false;
  for (const t of tags) {
    if (!t.defaultSelected) continue;
    if (t.group === "format") {
      if (formatPicked) continue;
      formatPicked = true;
    }
    out.push(t.id);
  }
  if (!formatPicked) {
    const firstFormat = tags.find(t => t.group === "format");
    if (firstFormat) out.unshift(firstFormat.id);
  }
  return out;
}

/**
 * Toggle a tag with group rules: format is single-select (selecting a new format
 * deselects the previous one); scene/mood/composition are multi-select.
 */
export function toggleTagSelection(tags: CreativeTag[], selectedIds: string[], id: string): string[] {
  const tag = tags.find(t => t.id === id);
  if (!tag) return selectedIds;
  const isSelected = selectedIds.includes(id);
  if (tag.group === "format") {
    const formatIds = new Set(tags.filter(t => t.group === "format").map(t => t.id));
    const withoutFormat = selectedIds.filter(s => !formatIds.has(s));
    return isSelected ? withoutFormat : [...withoutFormat, id]; // replace previous format
  }
  return isSelected ? selectedIds.filter(s => s !== id) : [...selectedIds, id];
}

// ── Direction brief (user-facing; NOT the hidden prompt) ──────────────────────

function joinTitles(titles: string[]): string {
  const t = titles.map(s => s.trim()).filter(Boolean);
  if (t.length === 0) return "the selected products";
  if (t.length === 1) return t[0];
  if (t.length === 2) return `${t[0]} and ${t[1]}`;
  return `${t.slice(0, -1).join(", ")}, and ${t[t.length - 1]}`;
}

function article(phrase: string): string {
  return /^[aeiou]/i.test(phrase.trim()) ? "an" : "a";
}

const FASHION_SCENE_PHRASE: Record<string, string> = {
  "Urban street": "outdoor urban", "Outdoor doorway": "outdoor doorway",
  "City sidewalk": "city sidewalk", "Natural daylight": "natural-light",
};
const FASHION_FORMAT_PHRASE: Record<string, string> = {
  "Street-style outfit": "street-style outfit", "Outfit portrait": "outfit portrait",
  "Editorial lookbook": "editorial lookbook", "Mirror outfit": "mirror outfit",
};

export type SelectedTagLite = { label: string; group: TagGroup };
export type SelectedCreativeTag = { id: string; label: string; group: TagGroup };

/**
 * Concise, editable creative brief. Plain language, no technical/model wording.
 * Composed from the selected tags by group so toggling any chip changes the text.
 */
export function buildDirectionBrief(ctx: CreativeControlContext, selectedTags: SelectedTagLite[]): string {
  const titles = joinTitles(ctx.productTitles);
  const fmt = selectedTags.find(t => t.group === "format")?.label;
  const scenes = selectedTags.filter(t => t.group === "scene").map(t => t.label);
  const moods = selectedTags.filter(t => t.group === "mood").map(t => t.label);
  const comps = selectedTags.filter(t => t.group === "composition").map(t => t.label.toLowerCase());
  const angle = ctx.opportunityKeyword ? ` Lean into the "${ctx.opportunityKeyword}" angle.` : "";
  const compText = comps.length ? comps.join(", ") : "";
  const withComp = compText ? ` with ${compText}` : "";

  switch (ctx.category) {
    case "fashion": {
      const scenePhrase = scenes.length ? (FASHION_SCENE_PHRASE[scenes[0]] ?? scenes[0].toLowerCase()) : "outdoor urban";
      const fmtPhrase = fmt ? (FASHION_FORMAT_PHRASE[fmt] ?? fmt.toLowerCase()) : "outfit";
      const moodPhrase = moods.some(m => /editorial|pinterest/i.test(m))
        ? "an editorial Pinterest mood"
        : moods.length ? `a ${moods[0].toLowerCase()} mood` : "an editorial Pinterest mood";
      return `Create ${article(scenePhrase)} ${scenePhrase} ${fmtPhrase} Pin. Show an original model wearing the ${titles}${withComp || " with full-body framing"}, and ${moodPhrase}. Avoid studio backdrops.${angle}`;
    }
    case "home-decor": {
      const moodPhrase = moods.length ? moods[0].toLowerCase() : "warm, lived-in";
      return `Create a styled ${(fmt ?? "room scene").toLowerCase()} Pin featuring the ${titles} in a ${moodPhrase} interior with natural lighting${withComp}. Keep the products clearly visible.${angle}`;
    }
    case "beauty":
      return `Create a clean beauty Pin showcasing the ${titles}${withComp || " with clear product detail"} and a ${(moods[0] ?? "fresh, minimal").toLowerCase()} aesthetic.${angle}`;
    case "food-and-drink":
      return `Create an appetizing ${(fmt ?? "food").toLowerCase()} Pin featuring the ${titles}, styled on a natural tabletop${withComp} with fresh, inviting detail.${angle}`;
    case "digital-products":
      return `Create a ${(fmt ?? "product preview").toLowerCase()} digital product Pin previewing the ${titles} with a clear, readable layout and a clean mockup${withComp}.${angle}`;
    case "diy-crafts":
      return `Create a DIY & crafts Pin featuring the ${titles} as ${(fmt ?? "a finished project").toLowerCase()}${withComp}, with a handmade, approachable feel.${angle}`;
    case "travel":
      return `Create an aspirational travel Pin built around ${(fmt ?? "a destination scene").toLowerCase()}, with the ${titles} placed naturally in context${withComp}.${angle}`;
    default:
      return `Create a Pinterest-native ${(fmt ?? "lifestyle scene").toLowerCase()} Pin featuring the ${titles} in a clean, aspirational scene${withComp || " with the products clearly visible"}.${angle}`;
  }
}

// ── Per-output variation plans ──────────────────────────────────────────────────
// Part of the generation manifest (NOT the visible UI). Output 0 is the anchor;
// outputs 2+ are distinct or consistent variants. Distinct rotates pose/framing/
// scene/angle so outputs differ from the anchor and each other, while always keeping
// the SAME products, category, reference influence, and format — variety changes
// composition, never the product set.
export type OutputVariant = {
  index: number;
  role: "anchor" | "distinct_variant" | "consistent_variant";
  variationMode: "distinct" | "similar";
  // Full-sentence, output-specific directive surfaced prominently in the provider prompt.
  variantInstruction: string;
  variationInstructions: {
    framing: string;
    pose: string;
    scene: string;
    emphasis: string;
  };
};

const FASHION_DISTINCT_POOL = {
  pose:    ["walking mid-stride", "side-angle three-quarter turn", "leaning against a wall looking away", "candid adjusting-jacket gesture"],
  framing: ["slightly closer knee-up editorial crop", "wide full-body composition", "low-angle full-body", "over-the-shoulder three-quarter framing"],
  scene:   ["crosswalk", "cafe exterior", "building entrance / doorway", "storefront window"],
  angle:   ["side profile", "three-quarter angle", "straight-on but looking away", "slightly low camera angle"],
} as const;
const GENERIC_DISTINCT_POOL = {
  pose:    ["alternate product placement within the scene", "product shown in-use rather than styled", "different supporting-prop interaction", "secondary angle on the product"],
  framing: ["closer hero crop", "wider establishing composition", "off-center editorial composition", "alternate camera distance"],
  scene:   ["adjacent micro-location in the same setting", "different surface or backdrop within the same category", "alternate time-of-day lighting", "different complementary props"],
  angle:   ["three-quarter angle", "slightly elevated top-down angle", "eye-level straight-on", "low hero angle"],
} as const;

export function buildOutputVariants(outputCount: number, variationMode: "distinct" | "similar", category: string): OutputVariant[] {
  const isFashion = category === "fashion";
  const mood = isFashion ? "street-style fashion mood" : "creative direction and aesthetic";
  const anchorComposition = isFashion
    ? "full-body, front-facing, standing, sidewalk/street-style framing"
    : "reference-faithful hero composition";
  const pool = isFashion ? FASHION_DISTINCT_POOL : GENERIC_DISTINCT_POOL;

  return Array.from({ length: outputCount }, (_, i): OutputVariant => {
    // ── Anchor (output 1) — same for both modes ──────────────────────────────
    if (i === 0) {
      return {
        index: 1,
        role: "anchor",
        variationMode,
        variantInstruction: isFashion
          ? "Create the anchor version. Stay closest to the selected products and reference. Use full-body street-style framing, clear product visibility, and natural outdoor editorial mood."
          : "Create the anchor version. Stay closest to the selected products and reference: reference-faithful hero composition, clear product visibility, and the reference's lighting and mood.",
        variationInstructions: {
          framing: isFashion ? "full-body" : "reference-faithful hero framing",
          pose: isFashion ? "natural standing, front-facing" : "stable reference-faithful presentation",
          scene: isFashion ? "reference-faithful sidewalk / street-style setting" : "reference-faithful scene",
          emphasis: "balanced editorial mood plus product visibility",
        },
      };
    }

    // ── Consistent (Similar) variant — small, deliberate change only ──────────
    if (variationMode === "similar") {
      return {
        index: i + 1,
        role: "consistent_variant",
        variationMode,
        variantInstruction:
          `Create a close alternative to output 1. Keep the same product set, ${mood}, framing family, and format. ` +
          "Make only a small pose, gesture, crop, or camera-angle change so it is not an exact duplicate.",
        variationInstructions: {
          framing: isFashion ? "same full-body or 3/4 body framing family" : "same composition family",
          pose: isFashion ? "similar natural pose with a small gesture change" : "similar subject placement",
          scene: "same scene type with a minor prop, crop, or angle adjustment",
          emphasis: "keep a close variation of the anchor while preserving product fidelity",
        },
      };
    }

    // ── Distinct variant — rotate dimensions so it visibly differs ────────────
    const v = i - 1; // 0-based index among variants
    const pose    = pool.pose[v % pool.pose.length];
    const framing = pool.framing[v % pool.framing.length];
    const scene   = pool.scene[v % pool.scene.length];
    const angle   = pool.angle[v % pool.angle.length];
    return {
      index: i + 1,
      role: "distinct_variant",
      variationMode,
      variantInstruction:
        `Create a visibly different variant of the same creative direction. Keep the SAME product set, product category, ${mood}, selected reference influence, and Pin format. ` +
        `Change the composition: ${pose}, ${framing}, set at a ${scene}, shot from a ${angle}. ` +
        `Do NOT repeat output 1's composition (${anchorComposition}). Do not change the product category, drop key products, ignore the reference, or turn it into a studio/catalog/ecommerce shot.`,
      variationInstructions: {
        framing,
        pose,
        scene,
        emphasis: v % 2 === 0 ? "slightly more product-forward" : "slightly more movement or editorial mood",
      },
    };
  });
}
