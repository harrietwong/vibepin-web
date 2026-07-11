/**
 * pinMetadata.ts — source-aware metadata draft generation for generated pins.
 * Pure functions; safe for unit tests and client/server use.
 */

import type { SetupSnapshot } from "./studioPersistence";
import { getContentTemplates, LANG_FILLER_WORD, LANG_IDEAS_WORD } from "./i18n/contentTemplates";
import type { LanguageCode } from "./i18n/config";

export type MetadataConfidence = "high" | "medium" | "low";

// ── Multi-product model ─────────────────────────────────────────────────────────
// A Pin can have one Primary Product (default Destination URL + Pin context) and
// zero or more Additional Tagged Products (shop-the-look / outfit / gift-guide).

export type ProductLinkType = "auto" | "manual";

export type ProductSourceKind =
  | "url_imported"
  | "my_products"
  | "product_ideas"
  | "manual"
  | "upload"
  | "recent";

export type LinkedProduct = {
  productId?:    string;
  title:         string;
  imageUrl?:     string;
  thumbnailUrl?: string;
  productUrl?:   string;
  canonicalUrl?: string;
  store?:        string;
  price?:        string;
  currency?:     string;
  source:        ProductSourceKind;
  linkType:      ProductLinkType;
  status?:       "ready" | "import_issue" | "incomplete";
};

export function normalizeProductSource(raw: string | undefined): ProductSourceKind {
  switch (raw) {
    case "url":
    case "url_imported":   return "url_imported";
    case "product_signal":
    case "product_ideas":
    case "product_signals": return "product_ideas";
    case "my_products":    return "my_products";
    case "manual":         return "manual";
    case "upload":
    case "uploaded":       return "upload";
    case "recent":         return "recent";
    default:               return raw ? "my_products" : "manual";
  }
}

export function productSourceLabel(source: ProductSourceKind | string | undefined): string {
  switch (normalizeProductSource(source)) {
    case "url_imported": return "URL Imported";
    case "product_ideas": return "Product Opportunities";
    case "my_products":  return "My Products";
    case "manual":       return "Manual";
    case "upload":       return "Upload";
    case "recent":       return "Recent";
    default:             return "My Products";
  }
}

/** Stable identity for dedupe/removal: productId > productUrl > imageUrl > title. */
export function productKey(p: LinkedProduct | null | undefined): string {
  if (!p) return "";
  return p.productId || p.productUrl || p.imageUrl || p.title || "";
}

export type TitleSourceLabel =
  | "Search-informed"
  | "Product-based"
  | "Opportunity-based"
  | "Reference-based"
  | "Image-based"
  | "Low confidence";

export type TitleCandidateEntry = {
  text: string;
  sourceLabel: TitleSourceLabel;
};

export type MetadataTouchedFlags = {
  titleTouched: boolean;
  descriptionTouched: boolean;
  altTextTouched: boolean;
  destinationUrlTouched: boolean;
  plannedDateTouched: boolean;
  plannedTimeTouched?: boolean;
};

export const EMPTY_TOUCHED: MetadataTouchedFlags = {
  titleTouched: false,
  descriptionTouched: false,
  altTextTouched: false,
  destinationUrlTouched: false,
  plannedDateTouched: false,
  plannedTimeTouched: false,
};

export type PinMetadataDraft = {
  titleCandidates: string[];
  titleCandidateEntries?: TitleCandidateEntry[];
  selectedTitle: string;
  descriptionCandidates: string[];
  selectedDescription: string;
  altText: string;
  destinationUrl?: string;
  destinationUrlSource?: string;
  plannedDate?: string;
  plannedTime?: string;
  plannedAt?: string;
  // Real Pinterest board chosen by the user (from the connected account). These are
  // the ONLY canonical board fields. They are never auto-filled from category/topic.
  boardId?: string;
  boardName?: string;
  // Internal inferred content topic / board *recommendation* string — NOT a Pinterest
  // board. Used only as a ranking signal to suggest a matching real board.
  boardSuggestion?: string;
  topics?: string[];
  confidence: MetadataConfidence;
  sourceReasons: string[];
  updatedAt: string;
  // Multi-product model — Primary + Additional Tagged products.
  // When undefined, fall back to the legacy single-link fields below via resolvePinProducts().
  primaryProduct?: LinkedProduct | null;
  taggedProducts?: LinkedProduct[];
  // Legacy single linked-product fields — kept in sync for back-compat (batch edit,
  // older persisted drafts, destination-URL resolution).
  linkedProductId?: string;
  linkedProductTitle?: string;
  linkedProductImageUrl?: string;
  linkedProductUrl?: string;
  linkedProductSource?: string;
  isAutoLinked?: boolean;
  // Enhanced prompt used when this pin was generated — used for Remix/retry to replay the same direction
  generationFinalPrompt?: string;
  copyGenerationMeta?: {
    generatedAt: string;
    provider: string;
    model: string;
    promptVersion: string;
    strategy: string;
    contextSourcesUsed: string[];
    keywordTermsUsed: string[];
    boardId?: string;
    language: string;
    country?: string;
    contextSummary: string;
    contextDetails: string[];
    timingsMs?: Record<string, number>;
  };
};

export type PinMetadataInput = {
  pinIndex?: number;
  groupIndex?: number;
  keyword?: string;
  category?: string;
  opportunityTitle?: string;
  promptSnapshot?: string;
  setupSnapshot?: SetupSnapshot | null;
  referenceLabel?: string;
  referenceVisualFormat?: string;
  imageCaption?: string;
  generationFinalPrompt?: string;
  /** Language for generated titles, descriptions, and alt text (not app UI). */
  contentLanguage?: LanguageCode;
};

const TITLE_MAX = 100;
const DESC_MAX = 800;
const ALT_MAX = 500;

const IMPORT_SOURCES = new Set([
  "url_import", "product_ideas", "product_signals", "shop_signals", "product_signal",
]);

function cap(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

function titleCase(s: string): string {
  return s.split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function cleanTopic(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (!v || v === "undefined" || v === "null") return "";
  return v;
}

const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * Clean a raw product title/slug so it can safely inform a Pin title.
 * Removes URL slugs, store domains, separator-trailing brand fragments, and —
 * when the content language is English — stray CJK fragments. Never returns a
 * URL slug or bilingual artifact.
 */
export function cleanProductTitle(raw: string | undefined, contentLanguage: LanguageCode = "en"): string {
  let t = (raw ?? "").trim();
  if (!t) return "";

  // Strip an "Editorial" prefix concatenated without a space: "EditorialTonal Blue…".
  t = t.replace(/^Editorial(?=[A-Z])/, "").replace(/^Editorial\s+/i, "");

  // Drop any embedded URLs.
  t = t.replace(/https?:\/\/\S+/gi, " ");

  // A bare slug (no spaces, hyphen/underscore separated) → spaced words.
  if (!/\s/.test(t) && /[-_]/.test(t)) {
    t = t.replace(/[-_]+/g, " ");
  }

  // Remove separator-trailing store/brand/domain fragments:
  //   "Blue Top | Cojira – Motelrocks-com-us搭配灵感" → "Blue Top"
  t = t.replace(/\s*[|｜·]\s*[^|｜·]*$/g, seg =>
    /(\.com|\.co|\.io|\.net|\.shop|\.store|rocks|官网|旗舰店|搭配|商城|store|shop)/i.test(seg) ? "" : seg,
  );

  // Remove bare domain tokens anywhere (motelrocks-com-us, example.com, …).
  t = t.replace(/\b[\w-]+\.(com|co|io|net|shop|store|us|uk)(\.[a-z]{2})?\b/gi, " ");
  t = t.replace(/\b[\w]+-com-[\w]+\b/gi, " ");

  // English content: strip CJK fragments entirely (no bilingual mixing).
  if (contentLanguage === "en") {
    t = t.replace(new RegExp(CJK_RE.source + "+", "g"), " ");
  }

  // Collapse stray separators / whitespace and trim edge punctuation.
  t = t.replace(/[|｜–—·]+/g, " ")
       .replace(/\s{2,}/g, " ")
       .replace(/^[\s\-–—|·,]+|[\s\-–—|·,]+$/g, "")
       .trim();

  // Drop immediate duplicate words (case-insensitive): "Top Top" → "Top".
  const out: string[] = [];
  for (const w of t.split(/\s+/)) {
    if (!out.length || out[out.length - 1].toLowerCase() !== w.toLowerCase()) out.push(w);
  }
  return out.join(" ");
}

function extractPromptTopic(prompt: string): string {
  const m = prompt.match(/for\s+"([^"]+)"/i) ?? prompt.match(/for\s+([^.]+)/i);
  if (m?.[1]) return cleanTopic(m[1]);
  const first = prompt.split(/[.!?]/)[0]?.trim() ?? "";
  if (first.length > 8 && first.length < 60) return first;
  return "";
}

function moodFromReference(refFormat?: string, refLabel?: string): string {
  const fmt = (refFormat ?? "").toLowerCase();
  if (fmt.includes("flat")) return "styled flat lay";
  if (fmt.includes("mirror")) return "mirror outfit";
  if (fmt.includes("room")) return "room scene";
  if (fmt.includes("body") || fmt.includes("on_body")) return "on-body styling";
  if (refLabel?.toLowerCase().includes("reference")) return "editorial";
  return "aesthetic";
}

function audienceForCategory(category: string): string {
  const c = category.toLowerCase();
  if (c.includes("fashion") || c.includes("apparel")) return "your wardrobe";
  if (c.includes("wedding")) return "your big day";
  if (c.includes("food")) return "your kitchen";
  if (c.includes("garden")) return "your garden";
  return "your home";
}

// Category → default board family. Keeps fashion/outfit Pins out of Home Decor boards.
const CATEGORY_BOARD_RULES: { test: RegExp; board: (ideas: string, filler: string) => string }[] = [
  { test: /fashion|apparel|outfit|clothing|streetwear|wardrobe|style|dress|denim/, board: (ideas) => `Outfit ${ideas}` },
  { test: /home|decor|interior|furniture|bedroom|living|kitchen-decor/,            board: (ideas) => `Home Decor ${ideas}` },
  { test: /beaut|makeup|skincare|hair|nail|cosmetic/,                              board: (_i, filler) => `Beauty ${filler}` },
  { test: /food|recipe|drink|baking|cocktail|meal/,                                board: (ideas) => `Recipe ${ideas}` },
  { test: /wedding|bridal/,                                                        board: (_i, filler) => `Wedding ${filler}` },
  { test: /garden|plant|outdoor|patio|landscap/,                                   board: (ideas) => `Garden ${ideas}` },
  { test: /travel|trip|vacation|destination/,                                      board: (_i, filler) => `Travel ${filler}` },
  { test: /digital|printable|template|planner/,                                    board: (ideas) => `Digital Product ${ideas}` },
  { test: /fitness|workout|wellness|health|yoga/,                                  board: (_i, filler) => `Fitness ${filler}` },
];

/**
 * Suggest a board name from the Pin's topic and category.
 * Prefers the topic ("{Topic} Ideas"); otherwise maps the category to a board family.
 * Returns "" when there is no usable signal — the caller should show "Choose board"
 * rather than silently defaulting to an unrelated board (e.g. Home Decor for fashion).
 */
export function suggestBoard(topic: string | undefined, category: string | undefined, contentLanguage: LanguageCode = "en"): string {
  const ideas  = LANG_IDEAS_WORD[contentLanguage]  ?? "Ideas";
  const filler = LANG_FILLER_WORD[contentLanguage] ?? "Inspiration";
  const t = cleanTopic(topic);
  if (t) return `${titleCase(t)} ${ideas}`;
  const cat = (category ?? "").toLowerCase().trim();
  if (!cat) return "";
  for (const { test, board } of CATEGORY_BOARD_RULES) {
    if (test.test(cat)) return board(ideas, filler);
  }
  return `${titleCase(cat.replace(/-/g, " "))} ${ideas}`;
}

// Category/topic family → keywords found in a matching real board's name.
const CATEGORY_KEYWORDS: { test: RegExp; keywords: string[] }[] = [
  { test: /fashion|apparel|outfit|clothing|streetwear|wardrobe|style|dress|denim/, keywords: ["outfit", "fashion", "style", "street", "wardrobe", "ootd", "wear", "look"] },
  { test: /home|decor|interior|furniture|bedroom|living/,                          keywords: ["home", "decor", "interior", "living room", "bedroom", "apartment", "cozy"] },
  { test: /beaut|makeup|skincare|hair|nail|cosmetic/,                              keywords: ["beauty", "makeup", "skincare", "hair", "nail", "glam"] },
  { test: /food|recipe|drink|baking|cocktail|meal/,                                keywords: ["recipe", "food", "dinner", "dessert", "baking", "meal", "drink"] },
  { test: /wedding|bridal/,                                                        keywords: ["wedding", "bridal", "bride"] },
  { test: /garden|plant|outdoor|patio|landscap/,                                   keywords: ["garden", "plant", "outdoor", "patio"] },
  { test: /travel|trip|vacation|destination/,                                      keywords: ["travel", "trip", "vacation", "destination"] },
];

/**
 * Recommend a REAL Pinterest board (by exact name from `boardNames`) that matches the
 * Pin's category/topic. Conservative: returns null unless a real board name plausibly
 * matches — it will NOT suggest an unrelated board (e.g. "Home Decor" for a fashion Pin).
 * Never invents names; the result is always one of the provided real board names.
 */
export function recommendRealBoard(
  boardNames: string[],
  opts: { category?: string; topic?: string } = {},
): string | null {
  const cat   = (opts.category ?? "").toLowerCase().trim();
  const topic = (opts.topic ?? "").toLowerCase().trim();
  const names = boardNames.filter(n => !!n?.trim());
  if (!names.length) return null;

  // Category is the most reliable signal; topic is only used to derive a family when
  // category gives none. Once a family is known we match ONLY that family's keywords,
  // so a fashion Pin can never be recommended a Home Decor board (even with a stale topic).
  const rule = CATEGORY_KEYWORDS.find(r => cat && r.test.test(cat))
            ?? CATEGORY_KEYWORDS.find(r => topic && r.test.test(topic));
  if (rule) {
    for (const name of names) {
      if (rule.keywords.some(k => name.toLowerCase().includes(k))) return name;
    }
    return null; // family known but no on-theme real board → leave empty ("Choose board")
  }

  // No category/topic family signal at all → only a conservative exact-ish name match.
  for (const name of names) {
    const n = name.toLowerCase().trim();
    if (topic && n.length >= 3 && (topic.includes(n) || n.includes(topic))) return name;
  }
  return null;
}

/** A handful of on-theme board options for a category — used for quick-pick chips. */
export function boardOptionsForCategory(category: string | undefined, contentLanguage: LanguageCode = "en"): string[] {
  const ideas = LANG_IDEAS_WORD[contentLanguage] ?? "Ideas";
  const cat = (category ?? "").toLowerCase().trim();
  if (/fashion|apparel|outfit|clothing|streetwear|wardrobe|style|dress|denim/.test(cat)) {
    return ["Outfit Ideas", "Street Style", "Summer Outfit Ideas", "Aesthetic Outfits", "Fashion"];
  }
  if (/home|decor|interior|furniture|bedroom|living/.test(cat)) {
    return ["Home Decor Ideas", "Living Room Ideas", "Bedroom Inspiration", "Cozy Home"];
  }
  if (/beaut|makeup|skincare|hair|nail/.test(cat)) return ["Beauty Inspiration", "Makeup Looks", "Skincare Routine"];
  if (/food|recipe|drink|baking/.test(cat))        return ["Recipe Ideas", "Easy Dinners", "Dessert Ideas"];
  if (/wedding|bridal/.test(cat))                  return ["Wedding Inspiration", "Bridal Looks", "Wedding Decor"];
  if (/garden|plant|outdoor/.test(cat))            return ["Garden Ideas", "Plant Inspiration", "Outdoor Living"];
  const base = suggestBoard("", cat, contentLanguage);
  return base ? [base] : [`Pin ${ideas}`];
}

function roomOrProduct(topic: string, productTitle: string): string {
  if (productTitle) return productTitle;
  const c = topic.toLowerCase();
  if (c.includes("bedroom")) return "bedroom";
  if (c.includes("living")) return "living room";
  if (c.includes("kitchen")) return "kitchen";
  if (c.includes("bathroom")) return "bathroom";
  return topic || "space";
}

export type PinSourceContext = {
  isSearchInformed: boolean;
  hasOpportunity: boolean;
  hasProductTitle: boolean;
  hasReference: boolean;
  isImageOnly: boolean;
};

const PIN_IDEA_SOURCES = new Set(["viral_pin", "pin_ideas", "pin_idea"]);

export function isSearchInformedContext(input: PinMetadataInput): boolean {
  const setup = input.setupSnapshot;
  const opp = cleanTopic(input.opportunityTitle) || cleanTopic(setup?.opportunityTitle);
  if (opp) return true;

  const kw = cleanTopic(input.keyword) || cleanTopic(setup?.keyword);
  if (kw && kw.toLowerCase() !== "pinterest content") return true;

  const products = setup?.selectedProducts ?? [];
  if (products.some(p =>
    (p.source && IMPORT_SOURCES.has(p.source)) && p.title?.trim(),
  )) return true;

  const refs = setup?.selectedReferences ?? [];
  if (refs.some(r => r.source && PIN_IDEA_SOURCES.has(r.source))) return true;

  return false;
}

export function isImageOnlyContext(input: PinMetadataInput): boolean {
  if (isSearchInformedContext(input)) return false;
  const setup = input.setupSnapshot;
  const products = setup?.selectedProducts ?? [];
  const refs = setup?.selectedReferences ?? [];
  const hasProductMeta = products.some(p => p.title?.trim() || p.productUrl?.trim());
  const hasPrompt = !!(input.promptSnapshot?.trim() || setup?.promptSnapshot?.trim());
  if (hasProductMeta || hasPrompt || refs.length > 0) return false;
  return products.length > 0;
}

export function analyzePinSourceContext(input: PinMetadataInput): PinSourceContext {
  const setup = input.setupSnapshot;
  const products = setup?.selectedProducts ?? [];
  const productTitle = cleanTopic(products.find(p => p.title?.trim())?.title);
  const hasOpportunity = !!(cleanTopic(input.opportunityTitle) || cleanTopic(setup?.opportunityTitle));
  const hasReference = (setup?.selectedReferences?.length ?? 0) > 0;
  return {
    isSearchInformed: isSearchInformedContext(input),
    hasOpportunity,
    hasProductTitle: !!productTitle,
    hasReference,
    isImageOnly: isImageOnlyContext(input),
  };
}

function labelForPattern(
  patternKind: "topic" | "product" | "reference" | "generic",
  ctx: PinSourceContext,
): TitleSourceLabel {
  if (ctx.isImageOnly) return "Image-based";
  if (patternKind === "product" && ctx.hasProductTitle) return "Product-based";
  if (patternKind === "reference" && ctx.hasReference) return "Reference-based";
  if (ctx.isSearchInformed && patternKind === "topic") return "Search-informed";
  if (ctx.hasOpportunity && patternKind === "topic") return "Opportunity-based";
  if (ctx.isSearchInformed) return "Search-informed";
  if (patternKind === "product" && ctx.hasProductTitle) return "Product-based";
  if (patternKind === "reference") return "Reference-based";
  return "Low confidence";
}

function buildTitleCandidates(opts: {
  topic: string;
  productTitle: string;
  category: string;
  mood: string;
  pinIndex: number;
  ctx: PinSourceContext;
  contentLanguage?: LanguageCode;
}): TitleCandidateEntry[] {
  const { topic, productTitle, category, mood, pinIndex, ctx, contentLanguage = "en" } = opts;
  const tpl = getContentTemplates(contentLanguage);
  const kw = titleCase(topic || productTitle || category.replace(/-/g, " "));
  const audience = tpl.audience(category);
  const room = roomOrProduct(topic, productTitle);
  const style = mood.split(" ")[0] || "cozy";

  const patternTexts = tpl.titles({
    kw,
    audience,
    room: titleCase(room),
    style: titleCase(style),
    productTitle: titleCase(productTitle),
    pinIndex,
  });

  const kinds: Array<"topic" | "product" | "reference" | "generic"> = [
    "topic", "reference", productTitle ? "product" : "topic",
    productTitle ? "product" : "topic", "topic", "reference",
  ];

  const seen = new Set<string>();
  const out: TitleCandidateEntry[] = [];
  for (let i = 0; i < patternTexts.length && out.length < 3; i++) {
    const idx = (i + pinIndex) % patternTexts.length;
    const t = cap(patternTexts[idx], TITLE_MAX);
    const kind = kinds[idx] ?? "generic";
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push({ text: t, sourceLabel: labelForPattern(kind, ctx) });
    }
  }
  const fillerWord = LANG_FILLER_WORD[contentLanguage] ?? "Inspiration";
  while (out.length < 3) {
    const filler = cap(`${kw} ${fillerWord} ${out.length + 1}`, TITLE_MAX);
    if (!seen.has(filler.toLowerCase())) {
      seen.add(filler.toLowerCase());
      out.push({ text: filler, sourceLabel: ctx.isImageOnly ? "Image-based" : "Low confidence" });
    } else break;
  }
  return out;
}

export function getTitleCandidateEntries(draft: PinMetadataDraft): TitleCandidateEntry[] {
  if (draft.titleCandidateEntries?.length) return draft.titleCandidateEntries;
  return (draft.titleCandidates ?? []).map(text => ({ text, sourceLabel: "Low confidence" as TitleSourceLabel }));
}

export function shouldShowLowConfidenceHint(draft: PinMetadataDraft): boolean {
  const entries = getTitleCandidateEntries(draft);
  return draft.confidence === "low"
    || entries.every(e => e.sourceLabel === "Low confidence" || e.sourceLabel === "Image-based");
}

export function pinNeedsDetailsGeneration(pin: {
  title?: string;
  description?: string;
  altText?: string;
  metadataDraft?: PinMetadataDraft | null;
}): boolean {
  const missingFields = !pin.title?.trim() || !pin.description?.trim() || !pin.altText?.trim();
  return missingFields || !pin.metadataDraft;
}

function buildDescriptionCandidates(opts: {
  topic: string;
  productTitle: string;
  category: string;
  mood: string;
  promptSnippet: string;
  contentLanguage?: LanguageCode;
}): string[] {
  const { topic, productTitle, category, mood, promptSnippet, contentLanguage = "en" } = opts;
  const tpl = getContentTemplates(contentLanguage);
  const kw = topic || productTitle || category.replace(/-/g, " ");
  const catLabel = category.replace(/-/g, " ");

  const candidates = tpl.descriptions({ kw, catLabel, mood, promptSnippet });

  return candidates.map(c => cap(c, DESC_MAX)).filter((c, i, arr) => c && arr.indexOf(c) === i).slice(0, 3);
}

function buildAltText(opts: {
  topic: string;
  productTitle: string;
  mood: string;
  imageCaption?: string;
  pinIndex: number;
  contentLanguage?: LanguageCode;
}): string {
  const { topic, productTitle, mood, imageCaption, pinIndex, contentLanguage = "en" } = opts;
  const subject = productTitle || topic || "styled scene";
  const tpl = getContentTemplates(contentLanguage);
  if (imageCaption?.trim()) {
    const captionVariants = tpl.alt({ subject: imageCaption.trim(), mood, pinIndex });
    return cap(captionVariants[0] ?? imageCaption.trim(), ALT_MAX);
  }
  const variants = tpl.alt({ subject, mood, pinIndex });
  return cap(variants[0] ?? subject, ALT_MAX);
}

function resolveDestinationUrl(setup?: SetupSnapshot | null): {
  url?: string;
  source?: string;
  reasons: string[];
} {
  if (!setup?.selectedProducts?.length) return { reasons: [] };

  const urls = setup.selectedProducts
    .map(p => {
      const url = (p as { productUrl?: string }).productUrl?.trim();
      if (url) return { url, source: p.source ?? "product", title: p.title };
      return null;
    })
    .filter((x): x is { url: string; source: string; title: string } => !!x);

  const unique = [...new Set(urls.map(u => u.url))];
  if (unique.length === 1) {
    return { url: unique[0], source: "Populated from primary product", reasons: [] };
  }
  if (unique.length > 1) {
    return { reasons: ["Multiple product URLs found. Choose a destination URL."] };
  }
  return { reasons: [] };
}

/** Primary topic: opportunity > product title > keyword > prompt topic */
export function resolveMetadataTopic(input: PinMetadataInput): string {
  const lang = input.contentLanguage ?? "en";
  return cleanTopic(input.opportunityTitle)
    || cleanTopic(input.setupSnapshot?.opportunityTitle)
    || cleanProductTitle(input.setupSnapshot?.selectedProducts?.find(p => p.title?.trim())?.title, lang)
    || cleanTopic(input.keyword)
    || cleanTopic(input.setupSnapshot?.keyword)
    || extractPromptTopic(input.promptSnapshot ?? input.setupSnapshot?.promptSnapshot ?? "")
    || cleanTopic(input.category?.replace(/-/g, " "));
}

// ── Product resolution + mutations (pure) ───────────────────────────────────────

type ProductSnapshotLike = {
  productId?:    string;
  imageUrl?:     string | null;
  title?:        string;
  source?:       string;
  productUrl?:   string;
  canonicalUrl?: string;
  sourceDomain?: string;
  price?:        string;
  currency?:     string;
};

/** Map a setup ProductSnapshot (or similar) to a LinkedProduct. */
export function toLinkedProduct(
  p: ProductSnapshotLike,
  opts: { contentLanguage?: LanguageCode; linkType?: ProductLinkType } = {},
): LinkedProduct {
  const lang = opts.contentLanguage ?? "en";
  const cleaned = cleanProductTitle(p.title, lang);
  return {
    productId:    p.productId,
    title:        cleaned || (p.title?.trim() ?? "") || "Product",
    imageUrl:     p.imageUrl ?? undefined,
    thumbnailUrl: p.imageUrl ?? undefined,
    productUrl:   p.productUrl?.trim() || undefined,
    canonicalUrl: p.canonicalUrl?.trim() || undefined,
    store:        p.sourceDomain,
    price:        p.price,
    currency:     p.currency,
    source:       normalizeProductSource(p.source),
    linkType:     opts.linkType ?? "auto",
  };
}

/**
 * Resolve Primary + Tagged products from a draft. Prefers the explicit
 * primaryProduct/taggedProducts fields; migrates from legacy single-link fields
 * when the multi-product fields are absent.
 */
export function resolvePinProducts(draft: PinMetadataDraft | null | undefined): {
  primary: LinkedProduct | null;
  tagged:  LinkedProduct[];
} {
  if (!draft) return { primary: null, tagged: [] };
  if (draft.primaryProduct !== undefined || draft.taggedProducts !== undefined) {
    return { primary: draft.primaryProduct ?? null, tagged: draft.taggedProducts ?? [] };
  }
  if (draft.linkedProductTitle || draft.linkedProductUrl || draft.linkedProductId) {
    return {
      primary: {
        productId:  draft.linkedProductId,
        title:      draft.linkedProductTitle ?? "Product",
        imageUrl:   draft.linkedProductImageUrl,
        productUrl: draft.linkedProductUrl,
        source:     normalizeProductSource(draft.linkedProductSource),
        linkType:   draft.isAutoLinked ? "auto" : "manual",
      },
      tagged: [],
    };
  }
  return { primary: null, tagged: [] };
}

/** Write Primary + Tagged back into a draft, syncing the legacy mirror fields. */
export function writePinProducts(
  draft: PinMetadataDraft,
  primary: LinkedProduct | null,
  tagged: LinkedProduct[],
): PinMetadataDraft {
  return {
    ...draft,
    primaryProduct:        primary,
    taggedProducts:        tagged,
    linkedProductId:       primary?.productId,
    linkedProductTitle:    primary?.title,
    linkedProductImageUrl: primary?.imageUrl,
    linkedProductUrl:      primary?.productUrl,
    linkedProductSource:   primary?.source,
    isAutoLinked:          primary?.linkType === "auto",
    updatedAt:             new Date().toISOString(),
  };
}

/**
 * Add a product. If no Primary exists, or makePrimary is true, it becomes Primary
 * (demoting any existing Primary into Tagged). Otherwise it's appended to Tagged.
 * Deduplicates by productKey.
 */
export function addProductToDraft(
  draft: PinMetadataDraft,
  product: LinkedProduct,
  makePrimary?: boolean,
): PinMetadataDraft {
  const { primary, tagged } = resolvePinProducts(draft);
  const key = productKey(product);
  const dedupedTagged = tagged.filter(t => productKey(t) !== key);

  const shouldBePrimary = makePrimary === true || (makePrimary === undefined && !primary);
  if (shouldBePrimary) {
    const demoted = primary && productKey(primary) !== key
      ? [{ ...primary, linkType: "manual" as ProductLinkType }, ...dedupedTagged]
      : dedupedTagged;
    return writePinProducts(draft, product, demoted);
  }
  if (primary && productKey(primary) === key) {
    // Re-adding the current primary — just refresh it.
    return writePinProducts(draft, product, dedupedTagged);
  }
  return writePinProducts(draft, primary, [...dedupedTagged, product]);
}

/** Remove a product by key. If the Primary is removed, the first Tagged is promoted. */
export function removeProductFromDraft(
  draft: PinMetadataDraft,
  key: string,
): { draft: PinMetadataDraft; promoted: LinkedProduct | null } {
  const { primary, tagged } = resolvePinProducts(draft);
  if (primary && productKey(primary) === key) {
    const [next, ...rest] = tagged;
    const promoted = next ? { ...next, linkType: "manual" as ProductLinkType } : null;
    return { draft: writePinProducts(draft, promoted, rest), promoted };
  }
  return { draft: writePinProducts(draft, primary, tagged.filter(t => productKey(t) !== key)), promoted: null };
}

/** Promote a Tagged product to Primary, demoting the existing Primary to Tagged. */
export function promoteProductToPrimary(draft: PinMetadataDraft, key: string): PinMetadataDraft {
  const { primary, tagged } = resolvePinProducts(draft);
  const target = tagged.find(t => productKey(t) === key);
  if (!target) return draft;
  const rest = tagged.filter(t => productKey(t) !== key);
  const demoted = primary ? [{ ...primary, linkType: "manual" as ProductLinkType }, ...rest] : rest;
  return writePinProducts(draft, { ...target, linkType: "manual" }, demoted);
}

/** Set/replace the Primary product's URL (manual edit). */
export function setPrimaryProductUrl(draft: PinMetadataDraft, url: string): PinMetadataDraft {
  const { primary, tagged } = resolvePinProducts(draft);
  if (!primary) return draft;
  return writePinProducts(draft, { ...primary, productUrl: url.trim() || undefined }, tagged);
}

export function generatePinMetadataDraft(input: PinMetadataInput): PinMetadataDraft {
  const now = new Date().toISOString();
  const setup = input.setupSnapshot;
  // Raw category drives board suggestion (no silent Home Decor fallback). The
  // home-decor default is kept only for title/description tone where a neutral
  // domestic voice is acceptable.
  const rawCategory = (input.category ?? setup?.category ?? "").trim();
  const category = rawCategory || "home-decor";
  const promptSnapshot = input.promptSnapshot ?? setup?.promptSnapshot ?? "";
  const pinIndex = input.pinIndex ?? 0;

  const lang = input.contentLanguage ?? "en";
  const products = setup?.selectedProducts ?? [];
  const productWithTitle = products.find(p => p.title?.trim());
  const productTitle = cleanProductTitle(productWithTitle?.title, lang) || cleanTopic(productWithTitle?.title);
  const topic = resolveMetadataTopic(input);

  const ref = setup?.selectedReferences?.[input.groupIndex ?? 0]
    ?? setup?.selectedReferences?.[0];
  const mood = moodFromReference(ref?.visualFormat ?? input.referenceVisualFormat, input.referenceLabel);

  const sourceReasons: string[] = [];
  let confidence: MetadataConfidence = "high";

  const hasImportedProduct = products.some(p =>
    p.title?.trim() && (p.source ? IMPORT_SOURCES.has(p.source) : false),
  );
  const hasProductUrl = products.some(p => !!(p as { productUrl?: string }).productUrl?.trim());
  const uploadedWithoutMeta = products.length > 0 && !productTitle && !hasProductUrl;

  if (input.opportunityTitle || setup?.opportunityTitle) {
    sourceReasons.push("Used opportunity keyword as primary topic.");
  } else if (productTitle) {
    sourceReasons.push("Used product title as primary topic.");
  } else if (promptSnapshot) {
    sourceReasons.push("Used user prompt for topic context.");
    confidence = "medium";
  } else if (ref?.title) {
    sourceReasons.push("Used reference style context for mood words.");
    confidence = "medium";
  }

  if (uploadedWithoutMeta) {
    sourceReasons.push("Product name missing. Add product name or destination URL for better Pin Details.");
    confidence = "low";
  }

  const ctx = analyzePinSourceContext(input);
  if (ctx.isImageOnly) {
    sourceReasons.push("Image-only upload — titles are not search-informed.");
    confidence = "low";
  } else if (!ctx.isSearchInformed && !ctx.hasProductTitle) {
    confidence = confidence === "high" ? "medium" : confidence;
  }

  if (input.imageCaption?.trim()) {
    sourceReasons.push("Image caption used to validate visual content.");
  }

  const dest = resolveDestinationUrl(setup);
  sourceReasons.push(...dest.reasons);

  const titleCandidateEntries = buildTitleCandidates({ topic, productTitle, category, mood, pinIndex, ctx, contentLanguage: lang });
  const titleCandidates = titleCandidateEntries.map(e => e.text);
  const descriptionCandidates = buildDescriptionCandidates({
    topic, productTitle, category, mood, promptSnippet: promptSnapshot, contentLanguage: lang,
  });
  const altText = buildAltText({ topic, productTitle, mood, imageCaption: input.imageCaption, pinIndex, contentLanguage: lang });

  // Topic-first, else category-family board. Never silently falls back to an
  // unrelated category (fashion Pins must not default to Home Decor).
  const boardSuggestion = suggestBoard(topic, rawCategory, lang);

  // Multi-product: Primary is the first product carrying a URL (unambiguous offer),
  // otherwise the first product. All remaining products become Additional Tagged.
  const linkedAll = products.map(p => toLinkedProduct(p as ProductSnapshotLike, { contentLanguage: lang }));
  const primaryIdx = linkedAll.findIndex(p => p.productUrl);
  const pIdx = primaryIdx >= 0 ? primaryIdx : (linkedAll.length ? 0 : -1);
  const urlCount = linkedAll.filter(p => p.productUrl).length;
  let primaryProduct: LinkedProduct | null = null;
  let taggedProducts: LinkedProduct[] = [];
  if (pIdx >= 0) {
    // auto-linked = exactly one product with a URL (unambiguous primary)
    primaryProduct = { ...linkedAll[pIdx], linkType: urlCount === 1 ? "auto" : "manual" };
    taggedProducts = linkedAll.filter((_, i) => i !== pIdx).map(p => ({ ...p, linkType: "manual" as ProductLinkType }));
  }

  const base: PinMetadataDraft = {
    titleCandidates,
    titleCandidateEntries,
    selectedTitle: titleCandidates[0] ?? "",
    descriptionCandidates,
    selectedDescription: descriptionCandidates[0] ?? "",
    altText,
    destinationUrl: dest.url,
    destinationUrlSource: dest.source,
    boardSuggestion,
    topics: topic ? [topic] : [],
    confidence,
    sourceReasons,
    updatedAt: now,
    generationFinalPrompt: input.generationFinalPrompt || undefined,
  };
  // writePinProducts syncs the legacy single-link mirror fields.
  return writePinProducts(base, primaryProduct, taggedProducts);
}

export type BatchMetadataPinInput = PinMetadataInput & {
  pinId: string;
  touched?: Partial<MetadataTouchedFlags>;
  existingDraft?: Partial<PinMetadataDraft>;
};

export type BatchMetadataOptions = {
  overwriteEdited?: boolean;
  sharedDestinationUrl?: string;
  sharedPlannedDate?: string;
  autoAssignDates?: string[];
};

export function generateBatchMetadataDraft(
  pins: BatchMetadataPinInput[],
  options: BatchMetadataOptions = {},
): Record<string, PinMetadataDraft> {
  const result: Record<string, PinMetadataDraft> = {};

  pins.forEach((pin, i) => {
    const fresh = generatePinMetadataDraft({ ...pin, pinIndex: i });
    const touched = { ...EMPTY_TOUCHED, ...pin.touched };
    const existing = pin.existingDraft;
    const overwrite = options.overwriteEdited ?? false;

    const draft: PinMetadataDraft = { ...fresh };

    if (touched.titleTouched && !overwrite && existing?.selectedTitle) {
      draft.selectedTitle = existing.selectedTitle;
      if (existing.titleCandidates?.length) draft.titleCandidates = existing.titleCandidates;
      if (existing.titleCandidateEntries?.length) draft.titleCandidateEntries = existing.titleCandidateEntries;
    }

    if (touched.descriptionTouched && !overwrite && existing?.selectedDescription) {
      draft.selectedDescription = existing.selectedDescription;
      if (existing.descriptionCandidates?.length) draft.descriptionCandidates = existing.descriptionCandidates;
    }

    if (touched.altTextTouched && !overwrite && existing?.altText) {
      draft.altText = existing.altText;
    }

    if (options.sharedDestinationUrl && (overwrite || !touched.destinationUrlTouched)) {
      draft.destinationUrl = options.sharedDestinationUrl;
      draft.destinationUrlSource = "Applied in batch edit";
    } else if (touched.destinationUrlTouched && !overwrite && existing?.destinationUrl) {
      draft.destinationUrl = existing.destinationUrl;
      draft.destinationUrlSource = existing.destinationUrlSource;
    }

    if (options.sharedPlannedDate && (overwrite || !touched.plannedDateTouched)) {
      draft.plannedDate = options.sharedPlannedDate;
    } else if (options.autoAssignDates?.[i] && (overwrite || !touched.plannedDateTouched)) {
      draft.plannedDate = options.autoAssignDates[i];
    } else if (touched.plannedDateTouched && !overwrite && existing?.plannedDate) {
      draft.plannedDate = existing.plannedDate;
    }

    result[pin.pinId] = draft;
  });

  return result;
}

export function applyDraftToPinFields(draft: PinMetadataDraft): {
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  plannedDate: string;
  plannedTime: string;
  plannedAt: string;
} {
  return {
    title: draft.selectedTitle,
    description: draft.selectedDescription,
    altText: draft.altText,
    destinationUrl: draft.destinationUrl ?? "",
    plannedDate: draft.plannedDate ?? "",
    plannedTime: draft.plannedTime ?? "",
    plannedAt: draft.plannedAt ?? "",
  };
}

export type MetadataReadinessLabel =
  | "Ready"
  | "Needs review"
  | "Missing title"
  | "Missing description"
  | "Needs date"
  | "Added to Plan";

export function metadataReadinessLabel(pin: {
  planningStatus: string;
  title: string;
  description: string;
  plannedDate: string;
}): MetadataReadinessLabel | null {
  if (pin.planningStatus !== "not_added") return "Added to Plan";
  if (!pin.title?.trim()) return "Missing title";
  if (!pin.description?.trim()) return "Missing description";
  if (!pin.plannedDate?.trim()) return "Needs date";
  if (pin.title?.trim() && pin.description?.trim() && pin.plannedDate?.trim()) return "Ready";
  return "Needs review";
}

export function computePlanningStatusFromFields(pin: {
  weeklyPlanItemId?: string | null;
  title: string;
  description: string;
  plannedDate: string;
  wasAdded: boolean;
}): "not_added" | "needs_review" | "ready" {
  if (!pin.wasAdded && !pin.weeklyPlanItemId) return "not_added";
  const hasTitle = !!pin.title?.trim();
  const hasDesc = !!pin.description?.trim();
  const hasDate = !!pin.plannedDate?.trim();
  if (hasTitle && hasDesc && hasDate) return "ready";
  return "needs_review";
}
