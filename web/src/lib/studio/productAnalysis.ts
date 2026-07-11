// Deterministic per-product analysis (Creative Intelligence V1 — Product Analysis).
//
// NO LLM, NO network, NO new vision infra. Works from product title / category /
// metadata / source that the asset already carries. Produces a structured role +
// fidelity profile per product and a set-coherence summary across all products.

import type { SelectedCreativeAsset } from "./creativeDirections";

export type ProductCategory =
  | "fashion"
  | "home_decor"
  | "beauty"
  | "food_drink"
  | "digital_product"
  | "diy_crafts"
  | "travel"
  | "general_lifestyle"
  | "unknown";

export type ProductAnalysis = {
  category: ProductCategory;
  productType: string;
  role: string;
  title: string;
  color?: string;
  material?: string;
  visualKeywords: string[];
  isPrimary: boolean;
  productFidelityNotes: string[];
};

export type ProductSetAnalysis = {
  products: ProductAnalysis[];
  /** dominant category across the set — never silently "home_decor" for non-home items */
  category: ProductCategory;
  isCoherentSet: boolean;
  setSummary: string;
  hasProducts: boolean;
};

// ── Category id bridges (hyphenated playbook ids ↔ underscored product cats) ──────
export function toProductCategory(playbookId: string): ProductCategory {
  switch (playbookId) {
    case "fashion":           return "fashion";
    case "home-decor":        return "home_decor";
    case "beauty":            return "beauty";
    case "food-and-drink":    return "food_drink";
    case "digital-products":  return "digital_product";
    case "diy-crafts":        return "diy_crafts";
    case "travel":            return "travel";
    case "generic":           return "general_lifestyle";
    default:                  return "unknown";
  }
}

// ── Token banks (role + type detection) ──────────────────────────────────────────
const FASHION_ROLES: Array<{ role: string; tokens: string[] }> = [
  { role: "dress",      tokens: ["dress", "gown", "frock", "jumpsuit", "romper"] },
  { role: "top",        tokens: ["top", "camisole", "cami", "blouse", "shirt", "tee", "t-shirt", "tank", "sweater", "knit", "cardigan", "hoodie", "crop"] },
  { role: "bottom",     tokens: ["jeans", "denim", "pants", "trousers", "skirt", "shorts", "leggings", "culottes"] },
  { role: "outerwear",  tokens: ["jacket", "coat", "blazer", "trench", "parka", "windbreaker", "vest"] },
  { role: "bag",        tokens: ["bag", "handbag", "purse", "tote", "clutch", "backpack", "crossbody"] },
  { role: "shoes",      tokens: ["shoes", "heels", "boots", "sneakers", "loafers", "sandals", "flats"] },
  { role: "jewelry",    tokens: ["necklace", "earrings", "bracelet", "ring", "jewelry", "jewellery"] },
  { role: "accessory",  tokens: ["scarf", "belt", "hat", "beanie", "sunglasses", "glasses", "watch", "accessory"] },
];
const HOME_ROLES: Array<{ role: string; tokens: string[] }> = [
  { role: "hero_furniture", tokens: ["sofa", "couch", "chair", "armchair", "bed", "table", "desk", "dresser", "cabinet", "bench", "ottoman"] },
  { role: "rug",            tokens: ["rug", "carpet", "runner"] },
  { role: "lighting",       tokens: ["lamp", "light", "sconce", "chandelier", "pendant"] },
  { role: "wall_decor",     tokens: ["wall art", "print", "poster", "frame", "mirror", "tapestry"] },
  { role: "plant",          tokens: ["plant", "planter", "pot", "fern", "succulent"] },
  { role: "textile",        tokens: ["pillow", "cushion", "throw", "blanket", "curtain", "duvet", "bedding"] },
  { role: "storage",        tokens: ["basket", "shelf", "bookshelf", "storage", "bin", "crate"] },
  { role: "supporting_decor", tokens: ["vase", "candle", "tray", "clock", "decor", "ornament"] },
];
const BEAUTY_ROLES: Array<{ role: string; tokens: string[] }> = [
  { role: "lip_product",  tokens: ["lipstick", "lip gloss", "lip", "balm"] },
  { role: "face_product", tokens: ["foundation", "concealer", "blush", "bronzer", "highlighter", "powder", "primer"] },
  { role: "skin_product", tokens: ["serum", "moisturizer", "moisturiser", "cleanser", "toner", "sunscreen", "spf", "cream", "skincare"] },
  { role: "application_product", tokens: ["mascara", "eyeliner", "eyeshadow", "brush", "applicator"] },
  { role: "packaging_only", tokens: ["bottle", "jar", "tube", "packaging", "box"] },
];
const DIGITAL_ROLES: Array<{ role: string; tokens: string[] }> = [
  { role: "planner",   tokens: ["planner", "calendar", "agenda"] },
  { role: "printable", tokens: ["printable", "print"] },
  { role: "template",  tokens: ["template", "canva", "notion"] },
  { role: "checklist", tokens: ["checklist", "tracker", "worksheet"] },
  { role: "guide",     tokens: ["guide", "ebook", "e-book", "course", "lesson"] },
  { role: "ui_kit",    tokens: ["ui kit", "ui", "icon set", "font", "preset"] },
  { role: "mockup",    tokens: ["mockup", "preview"] },
];
const FOOD_ROLES: Array<{ role: string; tokens: string[] }> = [
  { role: "drink",        tokens: ["drink", "cocktail", "mocktail", "smoothie", "coffee", "tea", "latte", "beverage", "juice"] },
  { role: "dish",         tokens: ["dish", "plate", "meal", "bowl", "salad", "pasta", "soup", "dinner", "breakfast"] },
  { role: "ingredient",   tokens: ["ingredient", "spice", "herb", "produce", "flour", "sugar"] },
  { role: "packaged_food",tokens: ["snack", "granola", "chocolate", "sauce", "jar", "packaged"] },
  { role: "recipe_item",  tokens: ["recipe", "bake", "dessert", "pastry", "cake", "cookie"] },
  { role: "kitchen_tool", tokens: ["pan", "knife", "utensil", "mug", "kitchen"] },
];

const ROLE_BANKS: Record<ProductCategory, Array<{ role: string; tokens: string[] }>> = {
  fashion: FASHION_ROLES,
  home_decor: HOME_ROLES,
  beauty: BEAUTY_ROLES,
  digital_product: DIGITAL_ROLES,
  food_drink: FOOD_ROLES,
  diy_crafts: [],
  travel: [],
  general_lifestyle: [],
  unknown: [],
};
const FALLBACK_ROLE: Record<ProductCategory, string> = {
  fashion: "unknown_fashion_item",
  home_decor: "unknown_home_item",
  beauty: "supporting_product",
  digital_product: "unknown_digital",
  food_drink: "unknown_food_item",
  diy_crafts: "primary_product",
  travel: "primary_product",
  general_lifestyle: "primary_product",
  unknown: "unknown_product",
};

const COLOR_WORDS = ["white","black","grey","gray","beige","cream","nude","tan","brown","navy","blue","red","pink","green","olive","sage","camel","khaki","burgundy","rust","coral","yellow","orange","purple","lavender","mint","teal","charcoal","ivory","gold","silver"];
const MATERIAL_WORDS = ["lace","denim","leather","cotton","linen","silk","wool","knit","velvet","satin","suede","ceramic","wood","wooden","metal","glass","marble","rattan","jute","canvas"];

const CAT_SIGNALS: Array<{ cat: ProductCategory; tokens: string[] }> = [
  { cat: "fashion", tokens: FASHION_ROLES.flatMap(r => r.tokens).concat(["outfit", "apparel", "wardrobe", "clothing"]) },
  { cat: "beauty", tokens: BEAUTY_ROLES.flatMap(r => r.tokens).concat(["beauty", "makeup", "cosmetic", "vanity"]) },
  { cat: "digital_product", tokens: DIGITAL_ROLES.flatMap(r => r.tokens).concat(["digital", "download", "pdf"]) },
  { cat: "food_drink", tokens: FOOD_ROLES.flatMap(r => r.tokens).concat(["food", "drink", "recipe"]) },
  { cat: "diy_crafts", tokens: ["diy", "craft", "handmade", "yarn", "crochet", "knit kit", "embroidery", "clay", "macrame", "sewing"] },
  { cat: "travel", tokens: ["travel", "luggage", "suitcase", "backpack", "passport", "packing"] },
  { cat: "home_decor", tokens: HOME_ROLES.flatMap(r => r.tokens).concat(["decor", "interior", "home"]) },
];

function textOf(a: SelectedCreativeAsset): string {
  return [a.title, a.category, a.keyword, a.productType, a.productSubtype, a.itemType, a.sourceContext]
    .filter(Boolean).join(" ").toLowerCase();
}

function detectProductCategory(text: string, explicit?: string): ProductCategory {
  // explicit asset.category wins when it maps to a known product category
  if (explicit) {
    const mapped = toProductCategory(explicit.toLowerCase().replace(/\s+/g, "-"));
    if (mapped !== "unknown" && mapped !== "general_lifestyle") return mapped;
  }
  let best: ProductCategory = "unknown";
  let bestScore = 0;
  for (const { cat, tokens } of CAT_SIGNALS) {
    const score = tokens.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return bestScore > 0 ? best : "unknown";
}

export function analyzeProduct(asset: SelectedCreativeAsset, index: number): ProductAnalysis {
  const text = textOf(asset);
  const title = (asset.title ?? "").trim() || `Product ${index + 1}`;
  const category = detectProductCategory(text, asset.category);

  const bank = ROLE_BANKS[category] ?? [];
  let role = FALLBACK_ROLE[category];
  let productType = "product";
  for (const entry of bank) {
    const hit = entry.tokens.find(t => text.includes(t));
    if (hit) { role = entry.role; productType = hit; break; }
  }

  const color = COLOR_WORDS.find(c => new RegExp(`\\b${c}\\b`).test(text));
  const material = MATERIAL_WORDS.find(m => text.includes(m));
  const visualKeywords = [...new Set([productType, color, material].filter(Boolean) as string[])];

  const productFidelityNotes: string[] = [
    `Keep "${title}" clearly recognizable.`,
  ];
  if (color) productFidelityNotes.push(`Preserve its ${color} color.`);
  if (material) productFidelityNotes.push(`Preserve its ${material} texture/material.`);

  return {
    category,
    productType,
    role,
    title,
    color,
    material,
    visualKeywords,
    isPrimary: index === 0,
    productFidelityNotes,
  };
}

// ── Set coherence ────────────────────────────────────────────────────────────────
function setSummaryFor(category: ProductCategory, roles: string[]): { summary: string; coherent: boolean } {
  const has = (...rs: string[]) => rs.some(r => roles.includes(r));
  switch (category) {
    case "fashion": {
      const coherent = has("top", "dress") && has("bottom") || (has("top") && has("bottom"));
      return { summary: coherent ? "complete outfit set" : roles.length > 1 ? "fashion product set" : "single fashion item", coherent: coherent || roles.length > 1 };
    }
    case "home_decor": {
      const coherent = has("hero_furniture") && (has("rug") || has("lighting") || has("textile"));
      return { summary: coherent ? "room scene set" : roles.length > 1 ? "decor product set" : "single decor item", coherent: coherent || roles.length > 1 };
    }
    case "beauty":
      return { summary: roles.length > 1 ? "makeup / beauty product set" : "single beauty product", coherent: roles.length > 1 };
    case "digital_product":
      return { summary: "digital product set", coherent: true };
    case "food_drink":
      return { summary: roles.length > 1 ? "food & drink set" : "single food/drink item", coherent: roles.length > 1 };
    default:
      return { summary: roles.length > 1 ? "product set" : "single product", coherent: roles.length > 1 };
  }
}

export function analyzeProductSet(assets: SelectedCreativeAsset[]): ProductSetAnalysis {
  const productAssets = assets.filter(a => a.role === "product");
  const products = productAssets.map(analyzeProduct);
  if (products.length === 0) {
    return { products: [], category: "unknown", isCoherentSet: false, setSummary: "no products selected", hasProducts: false };
  }
  // dominant category = most common non-unknown
  const counts = new Map<ProductCategory, number>();
  for (const p of products) if (p.category !== "unknown") counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const dominant: ProductCategory = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  const { summary, coherent } = setSummaryFor(dominant, products.map(p => p.role));
  return { products, category: dominant, isCoherentSet: coherent && products.length > 1, setSummary: summary, hasProducts: true };
}
