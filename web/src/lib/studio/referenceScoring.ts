// Deterministic, product-aware reference scoring (Creative Intelligence — Phase B).
//
// NO LLM. NO network. Pure functions over the metadata a `pin_samples` row already
// carries. Given a draft's image analysis (category / style / colors / visibleObjects
// / imageSummary) and optional product context (title / type / tags), it ranks
// reference-eligible Pinterest samples by RELEVANCE FIRST, popularity (save_count)
// strictly second.
//
// ── Compliance (PRD v0.2 §4) ────────────────────────────────────────────────────
// This module NEVER emits the reference image as a generation input. It only ranks,
// produces a plain-language `reason`, exposes the source linkback (pinterest_url /
// source_url), and derives structured *pattern tags* (visual_format / composition /
// human_presence / text_overlay + scene/style words) that callers may inject into a
// prompt as TEXT. It never surfaces internal scores or classifier confidence.

// ── Public shapes ────────────────────────────────────────────────────────────────

/** Raw pin_samples row (camelCased) needed for scoring + display. */
export type ReferenceCandidateRow = {
  id: string;
  imageUrl: string;
  category?: string | null;
  title?: string | null;
  /** pin_samples.source_keyword / seed_keyword — the crawl query the pin was found under
   *  (e.g. "cottagecore bedroom decor"). Titles are usually empty/garbage, so this is the
   *  richest scene/style vocabulary available for relevance matching against the analysis. */
  sourceKeyword?: string | null;
  sourceUrl?: string | null;      // pin_samples.source_url  (merchant/source page)
  pinterestUrl?: string | null;   // pin_samples.pinterest_url (the Pinterest pin)
  saveCount?: number | null;
  referenceQualityScore?: number | null;
  visualFormat?: string | null;
  humanPresence?: string | null;      // 'none' | 'hands' | 'partial' | 'full'
  textOverlayLevel?: string | null;   // 'none' | 'light' | 'moderate' | 'heavy'
  watermarkDetected?: boolean | null;
  imageQualityBand?: string | null;   // 'high' | 'medium' | 'low'
  compositionType?: string | null;    // 'single_focal' | 'multi_product' | 'scene' | 'abstract'
  hasClearSubject?: boolean | null;
};

/** Draft image-analysis subset + product context that drives relevance. */
export type ReferenceScoringInput = {
  category?: string | null;
  style?: string | null;
  colors?: string[] | null;
  visibleObjects?: string[] | null;
  imageSummary?: string | null;
  productTitle?: string | null;
  productType?: string | null;
  productTags?: string[] | null;
};

/**
 * Derived, prompt-safe pattern tags for a selected reference. Structured TEXT only —
 * this is what may be woven into a hidden prompt. It carries NO image URL.
 */
export type InspirationPatternTags = {
  visualFormat?: string;
  compositionType?: string;
  humanPresence?: string;
  textOverlayLevel?: string;
  sceneStyleWords?: string[];
};

/** Display-safe recommended reference returned to the client. No internal scores. */
export type ReferenceRecommendation = {
  id: string;
  imageUrl: string;
  title: string;
  category: string;              // humanized label (e.g. "Home decor")
  /** One plain-language sentence; whitelisted phrases only, never a fabricated metric. */
  reason: string;
  /** Provenance is always Pinterest — the UI must label + linkback. */
  source: "pinterest";
  sourceUrl: string | null;
  pinterestUrl: string | null;
  /** Derived mode tags for prompt injection (no image data). */
  patternTags: InspirationPatternTags;
};

/** Internal scored shape (test-visible). Route maps this to ReferenceRecommendation. */
export type ScoredReference = ReferenceRecommendation & {
  score: number;
  relevance: number;   // relevance-only evidence (category/scene/style), no popularity
  signals: string[];
};

/**
 * What a recommendation set was ACTUALLY based on — honest provenance for the UI label.
 *
 * - `product_analysis`  the draft's image analysis carried real visual signal AND at least one
 *                       returned pin genuinely matched it.
 * - `product_text`      only product text (title / type / tags) carried real signal AND at least
 *                       one returned pin genuinely matched it.
 * - `category_fallback` the results are category-popularity only. The UI must NOT claim these
 *                       were picked "for this product" — two products in the same category will
 *                       legitimately get near-identical lists.
 */
export type RecommendationBasis =
  | "product_analysis"
  | "product_text"
  | "category_fallback";

/**
 * Minimum relevance evidence to surface a reference. Below this a pin has essentially no
 * category/scene/style overlap with the product — showing it would violate PRD "relevance
 * first" (e.g. a high-save fashion pin for a home-decor print). Mirrors keywordContext's
 * relevance floor. Tuned so a same-category match (~0.6) or a decent scene overlap passes,
 * while cross-category noise — including a lone coincidental word collision (e.g. "art" in
 * "nail art" vs "graphic art print", relevance ~0.2) — is dropped.
 */
export const RELEVANCE_FLOOR = 0.3;

// ── Recommendation basis (honest provenance) ─────────────────────────────────────
//
// Why this exists: `categoryMatch === 1` alone yields relevance 0.6, which clears
// RELEVANCE_FLOOR. So a request carrying nothing but a category still returns pins —
// correctly ranked by category popularity, but NOT "recommended for this product".
// The basis lets the client label the set truthfully instead of overclaiming.

/** Image-analysis subset that can carry genuine visual signal. */
export type ProductAnalysisSignalInput = {
  imageSummary?: string | null;
  visibleObjects?: string[] | null;
  colors?: string[] | null;
  style?: string | null;
} | null | undefined;

/** Product-text subset that can carry genuine descriptive signal. */
export type ProductTextSignalInput = {
  title?: string | null;
  productType?: string | null;
  productTags?: string[] | null;
} | null | undefined;

/**
 * Placeholder / filler strings that a product record commonly carries when the user has
 * NOT actually named the product. These must never count as product signal — treating
 * "Untitled Product" as text signal is exactly the overclaim this module is fixing.
 * Compared case-insensitively after trimming. Exported so tests can assert coverage.
 */
export const PLACEHOLDER_PRODUCT_VALUES: ReadonlySet<string> = new Set([
  "",
  "-",
  "--",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "unknown",
  "untitled",
  "untitled product",
  "no title",
  "product",
  "products",
  "new product",
  "item",
  "items",
  "test",
  "sample",
  "default",
  "tbd",
]);

/**
 * Is a single string a MEANINGFUL product descriptor?
 * Rejects: empty/whitespace, known placeholders, length < 2, and strings that are purely
 * punctuation and/or digits (e.g. "123", "---", "#1") — none of these describe a product.
 */
export function isMeaningfulProductValue(value?: string | null): boolean {
  const raw = (value ?? "").trim();
  if (raw.length < 2) return false;
  const lower = raw.toLowerCase();
  if (PLACEHOLDER_PRODUCT_VALUES.has(lower)) return false;
  // purely punctuation/digits → carries no descriptive vocabulary
  if (!/[a-zÀ-ɏ一-鿿]/i.test(raw)) return false;
  return true;
}

/**
 * B1. Does the draft's image analysis carry GENUINE visual signal?
 * True when any of imageSummary / visibleObjects / colors / style is actually populated
 * (non-empty after trim for strings; at least one non-empty entry for arrays).
 */
export function hasProductAnalysisSignal(analysis: ProductAnalysisSignalInput): boolean {
  if (!analysis) return false;
  const str = (v?: string | null) => (v ?? "").trim().length > 0;
  const arr = (v?: string[] | null) => Array.isArray(v) && v.some(x => (x ?? "").trim().length > 0);
  return str(analysis.imageSummary) || arr(analysis.visibleObjects) || arr(analysis.colors) || str(analysis.style);
}

/**
 * B2. Does the product carry GENUINE text signal?
 * True when any of title / productType / productTags is meaningful per
 * `isMeaningfulProductValue`. Placeholder titles ("Product", "Untitled", …) do NOT count.
 * `productTags` counts only if at least one tag is itself meaningful.
 */
export function hasProductTextSignal(product: ProductTextSignalInput): boolean {
  if (!product) return false;
  if (isMeaningfulProductValue(product.title)) return true;
  if (isMeaningfulProductValue(product.productType)) return true;
  if (Array.isArray(product.productTags) && product.productTags.some(isMeaningfulProductValue)) return true;
  return false;
}

/**
 * Signals that constitute PRODUCT-LEVEL evidence on a returned pin.
 *
 * ── The crux of this change: "scene" vs "scene_match" ──────────────────────────────
 * The legacy `"scene"` signal is pushed whenever `sceneLabel(row)` is non-empty. But
 * `sceneLabel` is derived ENTIRELY from the reference pin's OWN visualFormat /
 * humanPresence / compositionType — it never looks at the product or the analysis. A
 * flat-lay pin yields "flat-lay layout" even when it shares zero words with the product.
 * So `"scene"` is a DESCRIPTION of the pin, not EVIDENCE that it matched the product,
 * and it must never be used to justify a product-level basis claim.
 *
 * `"scene_match"` is the honest counterpart: pushed only when CATEGORY-FREE containment is
 * > 0 — i.e. the pin's own vocabulary overlapped the product/analysis context on words other
 * than the category name. (The raw `scene` containment is not usable here: the category name
 * sits on both sides inside a category-scoped pool, so `scene > 0` is near-universal and
 * proves nothing.) Together with `"style"` (a genuine style-word hit, category word excluded)
 * these are the ONLY signals the downgrade rule accepts as product-level evidence.
 */
export const PRODUCT_EVIDENCE_SIGNALS: readonly string[] = ["scene_match", "style"];

/** Does this ranked result carry genuine product-level (not merely category) evidence? */
export function hasProductEvidence(result: Pick<ScoredReference, "signals">): boolean {
  return (result.signals ?? []).some(s => PRODUCT_EVIDENCE_SIGNALS.includes(s));
}

/**
 * B3. Derive the honest basis for a recommendation set.
 *
 * initial = hasAnalysis ? product_analysis : hasText ? product_text : category_fallback
 *
 * DOWNGRADE RULE: if the initial basis is a product_* one, at least ONE ranked result must
 * carry genuine product-level evidence (`scene_match` or `style`). If none does, the input
 * had product info but the OUTPUT is pure category-popularity — claiming product-level would
 * be a lie — so it downgrades to `category_fallback`.
 *
 * Zero results is the degenerate case of that rule: with nothing returned there is no
 * product-level evidence at all, so an initial product_* ALWAYS downgrades.
 */
export function deriveRecommendationBasis(args: {
  hasAnalysis: boolean;
  hasText: boolean;
  results: ScoredReference[];
}): RecommendationBasis {
  const { hasAnalysis, hasText, results } = args;
  const initial: RecommendationBasis =
    hasAnalysis ? "product_analysis" : hasText ? "product_text" : "category_fallback";
  if (initial === "category_fallback") return "category_fallback";
  // Empty results → `.some` is false → downgrade. Explicit and intentional.
  const anyProductEvidence = (results ?? []).some(hasProductEvidence);
  return anyProductEvidence ? initial : "category_fallback";
}

// ── Tokenization ─────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "your", "this", "that", "of", "to",
  "in", "on", "at", "by", "is", "are", "from", "into", "over", "reference", "pin",
  "pinterest", "idea", "ideas", "inspo", "inspiration",
]);

function words(s?: string | null): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function distinctiveWords(s?: string | null): string[] {
  return words(s).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function humanize(slug?: string | null): string {
  const s = (slug ?? "").replace(/-/g, " ").trim();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normCat(slug?: string | null): string {
  return (slug ?? "").toLowerCase().replace(/[\s_]+/g, "-").trim();
}

// ── Relevance dimensions ─────────────────────────────────────────────────────────

/** Fraction of the keyword/candidate words present in the context word set. */
function containment(contextSet: Set<string>, candidateWords: string[]): number {
  if (!candidateWords.length || !contextSet.size) return 0;
  const hit = candidateWords.filter(w => contextSet.has(w)).length;
  return hit / candidateWords.length;
}

/** save_count → 0..1, log-scaled so a big number can never dominate a linear score. */
export function normalizedSaves(n?: number | null): number {
  const v = Math.max(0, n ?? 0);
  return clamp01(Math.log10(v + 1) / 5); // 1k→0.6, 10k→0.8, 100k→1.0
}

/** reference_quality_score → 0..1. Tolerates 0..1 and 0..100 scales; null → neutral-low. */
export function normalizedQuality(v?: number | null): number {
  if (v == null || Number.isNaN(v)) return 0.4;
  return v <= 1 ? clamp01(v) : clamp01(v / 100);
}

const PEOPLE_CATEGORIES = new Set(["fashion", "womens-fashion", "beauty"]);
const OBJECT_CATEGORIES = new Set(["home-decor", "digital-products"]);

/** How well the reference's human presence fits the product category. Unknown → neutral. */
function humanPresenceFit(cat: string, humanPresence?: string | null): number {
  const hp = (humanPresence ?? "").toLowerCase().trim();
  if (!hp || hp === "unknown") return 0.5;
  const showsPeople = hp === "full" || hp === "partial";
  const inUse = hp === "hands";
  const none = hp === "none";
  if (PEOPLE_CATEGORIES.has(cat)) {
    if (showsPeople || inUse) return 1;
    if (none) return 0.4;
    return 0.5;
  }
  if (OBJECT_CATEGORIES.has(cat)) {
    if (none || inUse) return 1;
    if (showsPeople) return 0.5;
    return 0.6;
  }
  return 0.5;
}

// ── Scene phrasing (whitelisted; never a fabricated metric) ──────────────────────

function sceneLabel(row: ReferenceCandidateRow): string {
  const vf = (row.visualFormat ?? "").toLowerCase().trim();
  const hp = (row.humanPresence ?? "").toLowerCase().trim();
  const ct = (row.compositionType ?? "").toLowerCase().trim();
  const people = hp === "full" || hp === "partial";
  if (vf === "lifestyle") return people ? "lived-in scene with people" : "lived-in scene";
  if (vf === "flat_lay") return "flat-lay layout";
  if (vf === "product_only") return "product-forward shot";
  if (vf === "collage") return "collage layout";
  if (hp === "hands") return "in-use shot";
  if (ct === "scene") return people ? "styled scene with people" : "styled scene";
  if (ct === "single_focal") return "single-subject focus";
  if (ct === "multi_product") return "multi-item layout";
  if (people) return "shows people";
  return "";
}

// ── Pattern-tag derivation (prompt-safe TEXT only) ───────────────────────────────

export function toPatternTags(row: ReferenceCandidateRow): InspirationPatternTags {
  const norm = (s?: string | null) => {
    const t = (s ?? "").toLowerCase().trim();
    return t && t !== "unknown" ? t.replace(/_/g, " ") : undefined;
  };
  const sceneWords = Array.from(new Set([
    ...distinctiveWords(row.title).slice(0, 4),
    ...(row.category ? [normCat(row.category).replace(/-/g, " ")] : []),
  ])).filter(Boolean).slice(0, 5);
  return {
    visualFormat: norm(row.visualFormat),
    compositionType: norm(row.compositionType),
    humanPresence: norm(row.humanPresence),
    textOverlayLevel: norm(row.textOverlayLevel),
    sceneStyleWords: sceneWords.length ? sceneWords : undefined,
  };
}

// ── Hard eligibility (beyond the query's is_reference_eligible) ───────────────────

export function isDisplayable(row: ReferenceCandidateRow): boolean {
  if (!row.imageUrl) return false;
  if (row.watermarkDetected === true) return false;
  if ((row.imageQualityBand ?? "").toLowerCase().trim() === "low") return false;
  return true;
}

// ── Scoring core ─────────────────────────────────────────────────────────────────

function buildContextSet(input: ReferenceScoringInput): Set<string> {
  return new Set<string>([
    ...distinctiveWords(input.style),
    ...(input.colors ?? []).flatMap(distinctiveWords),
    ...(input.visibleObjects ?? []).flatMap(distinctiveWords),
    ...distinctiveWords(input.imageSummary),
    ...distinctiveWords(input.productTitle),
    ...distinctiveWords(input.productType),
    ...(input.productTags ?? []).flatMap(distinctiveWords),
    ...distinctiveWords((input.category ?? "").replace(/-/g, " ")),
  ]);
}

/**
 * Score a single row against the draft/product context.
 *
 * Weighting is RELEVANCE-FIRST: category (0.30) + scene/style containment (0.30)
 * dominate; human-presence fit (0.14) + reference quality (0.14) refine; save_count
 * (0.12) is a subordinate tiebreaker that can never carry an off-topic pin.
 */
export function scoreReference(
  row: ReferenceCandidateRow,
  input: ReferenceScoringInput,
  contextSet: Set<string>,
): ScoredReference {
  const cat = normCat(input.category);
  const rowCat = normCat(row.category);

  // 1. category match
  let categoryMatch = 0;
  if (cat && rowCat) {
    if (cat === rowCat) categoryMatch = 1;
    else if (cat.includes(rowCat) || rowCat.includes(cat)) categoryMatch = 0.5;
  }

  // 2. scene/style containment — how much the pin's own words relate to the product/image.
  //    source_keyword carries the real scene/style vocabulary (titles are mostly empty),
  //    so it's the primary driver of within-category ranking against the image analysis.
  const candidateWords = Array.from(new Set([
    ...distinctiveWords(row.sourceKeyword),
    ...distinctiveWords(row.title),
    ...distinctiveWords((row.category ?? "").replace(/-/g, " ")),
    ...distinctiveWords((row.visualFormat ?? "").replace(/_/g, " ")),
  ]));
  const scene = containment(contextSet, candidateWords);
  // "matches your style" must reflect a GENUINE style match, not the category name leaking
  // into the analysis style string (e.g. style "flat lay, beauty, modern" for a beauty pin).
  // Exclude the category word so the signal stays honest (PRD data-honesty).
  const catWords = new Set(distinctiveWords((input.category ?? "").replace(/-/g, " ")));
  const styleWords = distinctiveWords(input.style).filter(w => !catWords.has(w));
  const styleHit = styleWords.length > 0 && styleWords.some(w => candidateWords.includes(w));

  // Category-free containment — the ONLY honest basis for a "this pin matched the product"
  // claim. The plain `scene` value above is inflated by the category name appearing on both
  // sides (row.category is in candidateWords, input.category is in contextSet), so within a
  // category-scoped pool `scene > 0` is nearly universal and proves nothing. Dropping the
  // category words on both sides leaves only real product/analysis vocabulary overlap.
  // NOTE: this is a SIGNAL-only refinement — `scene` itself still feeds the score unchanged,
  // so ranking behavior is untouched.
  const matchCandidateWords = candidateWords.filter(w => !catWords.has(w));
  const matchContextSet = new Set(Array.from(contextSet).filter(w => !catWords.has(w)));
  const sceneMatchScore = containment(matchContextSet, matchCandidateWords);

  // 3. human presence fit
  const humanFit = humanPresenceFit(cat, row.humanPresence);

  // 4. reference quality
  const quality = normalizedQuality(row.referenceQualityScore);

  // 5. save popularity (subordinate)
  const saves = normalizedSaves(row.saveCount);

  const base =
    categoryMatch * 0.30 +
    scene * 0.30 +
    humanFit * 0.14 +
    quality * 0.14 +
    saves * 0.12;
  const clearSubjectBoost = row.hasClearSubject === true ? 0.03 : 0;
  const score = clamp01(base + clearSubjectBoost);

  // Relevance evidence ONLY (no popularity/quality). PRD v0.2 §5.3 is RELEVANCE FIRST:
  // a reference must genuinely relate to the product via category, scene words, or style —
  // popularity can never carry an off-topic pin. rankReferences drops anything below the
  // floor so a category-less request can't surface high-save cross-category noise.
  const relevance = clamp01(categoryMatch * 0.6 + Math.min(scene, 0.5) + (styleHit ? 0.1 : 0));

  // ── Signals + reason (whitelisted phrases, honesty-ordered) ──
  //
  // Signal vocabulary:
  //   "scene_match"  the pin's OWN words genuinely overlapped the product/analysis context
  //                  (containment > 0). REAL product-level evidence.
  //   "style"        a genuine style-word hit (category word excluded). REAL evidence.
  //   "scene"        purely descriptive of the pin's own visualFormat/composition — it says
  //                  NOTHING about matching this product. Kept for phrasing only; it must
  //                  never justify a product-level basis claim (see PRODUCT_EVIDENCE_SIGNALS).
  //   "category"     same category only.
  //   "saves"        popularity. Supplement only, never leads.
  const signals: string[] = [];
  const sceneMatched = sceneMatchScore > 0;
  if (sceneMatched) signals.push("scene_match");
  if (styleHit) signals.push("style");
  if (categoryMatch >= 1) signals.push("category");
  const scLabel = sceneLabel(row);
  if (scLabel) signals.push("scene");
  if (saves >= 0.66) signals.push("saves");

  // Reason honesty rules:
  //  1. Real matching evidence (scene_match / style) LEADS when it exists.
  //  2. The scene-descriptor phrase (derived from the pin's own format) may only appear
  //     ALONGSIDE real evidence — on its own it reads as if the pin matched the product.
  //  3. With category as the only relevance evidence, phrase it as "<Category> inspiration",
  //     never "<Category> reference" and never a scene phrase.
  //  4. Popularity is a supplement: never first, and never the sole relevance-implying phrase.
  const hasRealEvidence = sceneMatched || styleHit;
  const phrases: string[] = [];
  if (hasRealEvidence) {
    // Real matching evidence leads; the pin's own scene descriptor may ride along.
    if (sceneMatched) phrases.push("matches your product details");
    if (styleHit) phrases.push("matches your style");
    if (scLabel) phrases.push(scLabel);
    if (categoryMatch >= 1) phrases.push(`${humanize(rowCat) || "Same"} category`.trim());
  } else {
    // Category (or nothing) is the only relevance evidence → inspiration phrasing, and NO
    // scene descriptor: the pin's own flat-lay/lifestyle format is not a product match.
    phrases.push(`${humanize(rowCat) || "Style"} inspiration`);
  }
  if (saves >= 0.66) phrases.push("strong saves");   // supplement only, always last
  const reason = capitalize(phrases.slice(0, 3).join(" · "));

  return {
    id: row.id,
    imageUrl: row.imageUrl,
    title: (row.title || "").trim() || (humanize(rowCat) ? `${humanize(rowCat)} reference` : "Reference pin"),
    category: humanize(rowCat),
    reason,
    source: "pinterest",
    sourceUrl: row.pinterestUrl ?? row.sourceUrl ?? null,     // linkback prefers the Pinterest pin
    pinterestUrl: row.pinterestUrl ?? null,
    patternTags: toPatternTags(row),
    score,
    relevance,
    signals,
  };
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Rank a candidate pool: filter non-displayable rows AND rows below the relevance floor,
 * dedupe, sort by score desc. Returns [] when nothing clears the floor — the UI renders
 * no empty shell, which per PRD is correct: better to show nothing than irrelevant pins.
 */
export function rankReferences(
  rows: ReferenceCandidateRow[],
  input: ReferenceScoringInput,
  limit = 12,
): ScoredReference[] {
  const contextSet = buildContextSet(input);
  const seen = new Set<string>();
  const scored: ScoredReference[] = [];
  for (const row of rows) {
    if (!isDisplayable(row)) continue;
    if (seen.has(row.id) || seen.has(row.imageUrl)) continue;
    seen.add(row.id);
    seen.add(row.imageUrl);
    const s = scoreReference(row, input, contextSet);
    if (s.relevance < RELEVANCE_FLOOR) continue;   // relevance-first: drop off-topic pins
    scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score);
  return limit > 0 ? scored.slice(0, limit) : scored;
}

/** Strip internal fields for the wire. */
export function toRecommendation(s: ScoredReference): ReferenceRecommendation {
  const { score, relevance, signals, ...rest } = s;
  void score; void relevance; void signals;
  return rest;
}
