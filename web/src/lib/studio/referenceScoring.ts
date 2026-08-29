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
  /** pin_samples.scraped_at — ISO-8601 crawl timestamp. Used ONLY as a freshness tie-break
   *  inside the ranker; it is never surfaced (ReferenceRecommendation / toRecommendation are
   *  unchanged, so it can never reach the wire). Missing/blank counts as OLDEST. */
  scrapedAt?: string | null;
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

/**
 * Which tier a result was admitted under.
 *
 * - `product_evidence`   Tier 1 — `productEvidenceScore > 0`: the pin's own vocabulary
 *                        genuinely overlapped the product's, on words other than the
 *                        category name. This is the ONLY tier that may claim a
 *                        product-level basis or show a product-match reason.
 * - `category_fallback`  Tier 2 — displayable in-category backfill, admitted
 *                        unconditionally. Honest "<Category> inspiration" only.
 *
 * INTERNAL. `toRecommendation()` strips it alongside score/relevance/signals.
 */
export type RecommendationTier = "product_evidence" | "category_fallback";

/** Internal scored shape (test-visible). Route maps this to ReferenceRecommendation. */
export type ScoredReference = ReferenceRecommendation & {
  score: number;
  relevance: number;   // relevance-only evidence (category/scene/style), no popularity
  signals: string[];
  /** Internal only — never serialized. Absent on rows scored outside the tiered ranker. */
  recommendationTier?: RecommendationTier;
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
 * DOWNGRADE RULE: if the initial basis is a product_* one, the FINAL merged output must
 * contain at least one item that was admitted on genuine product evidence. If none is, the
 * input had product info but the OUTPUT is pure category-popularity — claiming product-level
 * would be a lie — so it downgrades to `category_fallback`.
 *
 * Zero results is the degenerate case of that rule: with nothing returned there is no
 * product-level evidence at all, so an initial product_* ALWAYS downgrades.
 *
 * ── Why tier, not signals (a real bug this pre-empts) ────────────────────────────────
 * The obvious implementation, `results.some(hasProductEvidence)`, is WRONG once Tier-2
 * backfill exists. `scoreReference` computes `scene_match`/`style` from the FULL context
 * set, so a candidate that Tier 1 rejected can still arrive carrying those signals — and
 * that would falsely resurrect `product_*` for a list that is entirely category inspiration.
 * So when the results carry tier information it is AUTHORITATIVE: only
 * `recommendationTier === "product_evidence"` counts. The signal-based check survives only
 * as the legacy path for untiered results (`rankReferences`), where every returned row
 * cleared the relevance floor and no backfill exists.
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
  const list = results ?? [];
  // Empty results → neither branch finds evidence → downgrade. Explicit and intentional.
  const tiered = list.some(r => r.recommendationTier != null);
  const anyProductEvidence = tiered
    ? list.some(r => r.recommendationTier === "product_evidence")
    : list.some(hasProductEvidence);
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

// ── Product-evidence normalization (round-2 evidence-backed) ─────────────────────
//
// Deliberately NARROW. Round 2 measured a conservative stemmer over 109,085 real
// (product-word × pool-word) comparisons and found the `-ed`/`-ing` rules produce
// cross-POS collisions — `nailed → nail` (12 real hits), `striped → strips` (6) — while
// contributing only a small minority of the recovery. So this normalizes PLURAL and
// POSSESSIVE ONLY. No generic suffix truncation.

/**
 * Words whose trailing `-s` is part of the stem, NOT a plural marker.
 *
 * `canvas` is the load-bearing entry: the naive `-s` rule collapses the MATERIAL
 * "canvas" (real product: `Western Cowgirl Canvas Wall Art`) onto the BRAND "Canva"
 * (real source_keyword: `instagram feed template free download canva`) — 48 false hits
 * measured in round 2. The list is a plain Set so more entries can be added as further
 * false positives are evidenced.
 */
export const NORMALIZE_EXCEPTIONS: ReadonlySet<string> = new Set([
  "canvas",   // material vs. the brand "Canva" — 48 measured false hits (round 2 §C1)
  "glass",
  "dress",
  "class",
  "press",
  "gloss",
  "brass",
  "grass",
  "moss",
  "boss",
  "lens",
  "series",
  "species",
  "athletics",
  "ceramics",
  "cosmetics",
  "graphics",
  "his",
  "its",
]);

/**
 * Plural + possessive normalization. NOTHING else.
 *
 * Rules, in order:
 *   1. exception list  → returned verbatim (`canvas` stays `canvas`)
 *   2. possessive      `women's` / `womens'` → `women`   (apostrophes are already stripped
 *                      by `words()`, so this also covers the resulting `womens`)
 *   3. `-ies` → `-y`   `bodies` → `body`
 *   4. `-sses`/`-shes`/`-ches`/`-xes`/`-zes` → drop `-es`
 *   5. `-s`  → drop    (only when the stem is still ≥ 3 chars and does not end in `s`)
 *
 * Explicitly NOT implemented: `-ed`, `-ing`. Round 2 proved them defective.
 */
export function normalizeWord(word: string): string {
  const w = word.toLowerCase();
  if (w.length < 4) return w;
  if (NORMALIZE_EXCEPTIONS.has(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(sse|she|che|xe|ze)s$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) {
    const stem = w.slice(0, -1);
    if (stem.length >= 3 && !NORMALIZE_EXCEPTIONS.has(stem)) return stem;
  }
  return w;
}

/**
 * Article-noun → occasion-noun synonym bridge. **The 18 DB-verified pairs from round 2,
 * verbatim.** Every entry cites a REAL `pin_products` title and the REAL `pin_samples`
 * `source_keyword` it should have matched; all 18 were confirmed present in the live pools
 * (round 2 "Citation audit: 18/18 verified").
 *
 * Structurally this is two rules: in fashion any wearable/accessory article noun → `outfit`;
 * in home-decor any furniture/soft-furnishing noun → the room word. It is fashion- and
 * home-decor-only BY DESIGN: digital-products already has a 0% fallback rate and beauty has
 * only 12 rows in the entire DB (n too small to justify a pair).
 *
 * DO NOT ADD PAIRS without a DB citation. Round 1 proposed three that round 2 DISPROVED and
 * which must never appear here:
 *   - `sandal → shoes`   the word `shoes` does not appear in the fashion pool at all
 *   - `curler → lashes`  `lashes` does not appear in the beauty pool
 *   - `tote → bag`       `bag` does not appear in the fashion pool (the `outfit` half is kept)
 */
export const PRODUCT_EVIDENCE_SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  //  #   product word        pool word     cited real product title / cited real source_keyword
  //  1
  ["bag", ["outfit"]],          // `Faux Leather Buckle Bag`                          → `leather jacket outfit`
  //  2
  ["handbag", ["outfit"]],      // `Michael Kors Bags | … Hamilton Acorn Xl Tote`     → `outfit ideas`
  //  3
  ["tote", ["outfit"]],         // `Michael Kors Bags | … Hamilton Acorn Xl Tote`     → `outfits`
  //  4
  ["clutch", ["outfit"]],       // `CORRIE SMALL CLUTCH`                              → `brunch outfit ideas black women`
  //  5
  ["necklace", ["outfit"]],     // `T-Bar Figaro Necklace`                            → `outfit ideas`
  //  6
  ["watch", ["outfit"]],        // `Raquel Gold-Tone Stainless Steel Date Watch`      → `outfit ideas`
  //  7
  ["sunglasses", ["outfit"]],   // `Sunglasses Female Grandient Black Lens Cat Eye`   → `outfit ideas summer`
  //  8
  ["mules", ["outfit"]],        // `Feeling Good Platform Mules - Brown`              → `outfit ideas summer`
  //  9
  ["sandal", ["outfit"]],       // `Abilene Toe Loop Sandal (Women) | Nordstrom`      → `outfit ideas summer`
  // 10
  ["shorts", ["outfit"]],       // `Oaklynn Pocketed Paper Bag Shorts - White`        → `outfit ideas summer`
  // 11
  ["jeans", ["outfit"]],        // `uk streetwear jeans - siolin`                     → `mens fashion casual outfits`
  // 12
  ["pants", ["outfit"]],        // `Kensington Linen Pants-Cappuccino Chambray`       → `summer linen shirt outfits`
  // 13  (one row in the cited table, two surface forms)
  ["shirt", ["outfit"]],        // `Lovelet Round Neck Half Sleeve T-Shirt`           → `summer linen shirt outfit`
  ["top", ["outfit"]],          // `Lovelet Round Neck Half Sleeve T-Shirt`           → `summer linen shirt outfit`
  // 14
  ["sofa", ["living"]],         // `Dawson Extended Sofa | Castlery US`               → `boho living room decor ideas`
  // 15
  ["couch", ["living"]],        // `Neil Modern 120 in. Upholstered Corduroy Sofa`    → `home decoration ideas living room`
  // 16
  ["pillow", ["bedroom"]],      // `Cali Sunset Pillow - 24 x 24`                     → `small bedroom decor ideas`
  // 17
  ["curtain", ["bedroom"]],     // `54"x84" Light Filtering Textural Sheer Curtain`   → `small bedroom decor ideas`
  // 18  (one row in the cited table, two surface forms)
  ["lamp", ["apartment"]],      // `1 - Light Simple Pendant`                         → `small apartment decor ideas`
  ["pendant", ["apartment"]],   // `1 - Light Simple Pendant`                         → `small apartment decor ideas`
]);

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

// ── Product evidence (Tier-1 admission + ordering) ───────────────────────────────
//
// SELF-CONTAINED. This does NOT touch `containment`, `scene`, `relevance` or `score` —
// those keep byte-identical behavior, so the regression surface stays minimal.

/** Product-side vocabulary for evidence matching (category words are stripped by the caller). */
export type ProductEvidenceInput = Pick<
  ReferenceScoringInput,
  "category" | "style" | "colors" | "visibleObjects" | "imageSummary" | "productTitle" | "productType" | "productTags"
>;

/** Normalized, category-free product word set + its synonym expansion. Build once per request. */
export type ProductEvidenceContext = {
  /** Normalized product words, category words removed. */
  words: ReadonlySet<string>;
  /** `words` plus every synonym target reachable from them. */
  expanded: ReadonlySet<string>;
};

/** Category words, normalized — excluded from BOTH sides so the category name can't score. */
function categoryWordSet(category?: string | null): Set<string> {
  return new Set(distinctiveWords((category ?? "").replace(/-/g, " ")).map(normalizeWord));
}

/**
 * Build the category-free, normalized, synonym-expanded product vocabulary.
 *
 * Product side per spec: title, productType, productTags, imageSummary, visibleObjects,
 * colors, style.
 */
export function buildProductEvidenceContext(input: ProductEvidenceInput): ProductEvidenceContext {
  const catWords = categoryWordSet(input.category);
  const raw = [
    ...distinctiveWords(input.productTitle),
    ...distinctiveWords(input.productType),
    ...(input.productTags ?? []).flatMap(distinctiveWords),
    ...distinctiveWords(input.imageSummary),
    ...(input.visibleObjects ?? []).flatMap(distinctiveWords),
    ...(input.colors ?? []).flatMap(distinctiveWords),
    ...distinctiveWords(input.style),
  ].map(normalizeWord);

  const words = new Set<string>();
  for (const w of raw) if (!catWords.has(w)) words.add(w);

  const expanded = new Set<string>(words);
  for (const w of words) {
    for (const target of PRODUCT_EVIDENCE_SYNONYMS.get(w) ?? []) {
      const t = normalizeWord(target);
      if (!catWords.has(t)) expanded.add(t);
    }
  }
  return { words, expanded };
}

/**
 * Candidate-side vocabulary for evidence matching — normalized, category words stripped.
 *
 * Candidate side per spec: title, sourceKeyword/seedKeyword, plus the other existing
 * explainable structured fields (visualFormat, compositionType, humanPresence).
 */
export function productEvidenceCandidateWords(
  row: ReferenceCandidateRow,
  category?: string | null,
): string[] {
  const catWords = categoryWordSet(category);
  // The ROW's own category is stripped too — inside a category-scoped pool it is a constant
  // on both sides and would hand every candidate a free hit.
  for (const w of categoryWordSet(row.category)) catWords.add(w);
  const raw = [
    ...distinctiveWords(row.sourceKeyword),
    ...distinctiveWords(row.title),
    ...distinctiveWords((row.visualFormat ?? "").replace(/_/g, " ")),
    ...distinctiveWords((row.compositionType ?? "").replace(/_/g, " ")),
    ...distinctiveWords((row.humanPresence ?? "").replace(/_/g, " ")),
  ].map(normalizeWord);
  return Array.from(new Set(raw.filter(w => !catWords.has(w))));
}

/**
 * CATEGORY-FREE product evidence for one candidate, in 0..1. Tier-1 admission is `> 0`.
 *
 * `hits / sqrt(|candidateWords|)`, then clamped into 0..1.
 *
 * Why sqrt and not `hits / |cand|`: round 2 measured 234,861 real candidate pairs and found
 * **17,924 (7.6%) inversions** where the candidate sharing MORE product words scored LOWER,
 * purely because plain containment divides by candidate length and long `source_keyword`s
 * are therefore penalised. Measured correction rates on that exact inversion set:
 *
 *   max(containment, jaccard)      0 / 17,924   (0.0%)  ← round 1's proposal, RETRACTED as inert:
 *                                                          |ctx| > |cand| always, so jaccard is
 *                                                          uniformly smaller and max(c,j) ≡ c
 *   hits / min(|cand|, |ctx|)      4,805        (26.8%)
 *   hits / sqrt(|cand|)           14,844        (82.8%)  ← chosen
 *   raw hits (no normalization)   17,924       (100%)    ← rejected: a 10-word keyword with 2
 *                                                          incidental hits would beat a 2-word
 *                                                          exact match
 *
 * The sqrt normalization lives ONLY here. It must never enter `scene`/`relevance`/`score`.
 *
 * ── Mapping the raw ratio into 0..1 ──
 * `hits / sqrt(|cand|)` is NOT bounded by 1 — it exceeds 1 whenever `hits >= sqrt(|cand|)`,
 * which on real keywords is common (e.g. 4 hits in a 7-word keyword → 1.512). Clamping would
 * therefore saturate most of Tier 1 at exactly 1.0 and destroy the ordering the sqrt damping
 * exists to produce — the same saturation failure that made the ORIGINAL ranking
 * product-independent. So the raw ratio is mapped monotonically instead:
 *
 *     raw / (1 + raw)     strictly increasing on [0, ∞) → (0, 1)
 *
 * This is order-preserving, so every inversion the round-2 sweep measured on the raw ratio is
 * corrected identically, while the returned value is a genuine 0..1 with no ties introduced.
 */
export function productEvidenceScore(
  row: ReferenceCandidateRow,
  ctx: ProductEvidenceContext,
  category?: string | null,
): number {
  const candidateWords = productEvidenceCandidateWords(row, category);
  if (!candidateWords.length || !ctx.expanded.size) return 0;
  let hits = 0;
  for (const w of candidateWords) if (ctx.expanded.has(w)) hits++;
  if (hits === 0) return 0;
  const raw = hits / Math.sqrt(candidateWords.length);
  return clamp01(raw / (1 + raw));
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

// ── Tiered ranking (product evidence first, category inspiration always) ─────────

/**
 * Rewrite a Tier-2 item's reason to honest "<Category> inspiration" phrasing.
 *
 * Non-negotiable (§5): a backfilled candidate may still carry `scene_match`/`style` from
 * `scoreReference`, which would otherwise render "Matches your product details" on a card
 * that was NOT admitted on product evidence. Tier 2 must never make a product-match claim.
 * Popularity may still ride along as a supplement — it is not a relevance claim.
 */
function asCategoryInspiration(s: ScoredReference): ScoredReference {
  const phrases = [`${s.category || "Style"} inspiration`];
  if ((s.signals ?? []).includes("saves")) phrases.push("strong saves");
  return { ...s, reason: capitalize(phrases.join(" · ")), recommendationTier: "category_fallback" };
}

/** Deterministic final tie-break so ordering is reproducible run to run. */
function byIdAsc(a: ScoredReference, b: ScoredReference): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Deterministic final tie-break: freshest crawl first, then id ascending.
 *
 * `scrapedAt` lives on the ROW, not on `ScoredReference` — the scored shape is the
 * display-safe one and must not start carrying crawl metadata — so the values are threaded in
 * through the id→row map the ranker already builds. Comparison is plain lexicographic over the
 * ISO-8601 string (same-format ISO sorts chronologically); missing / blank collapses to `""`,
 * which under DESC sorts last, i.e. an unknown crawl date is treated as the OLDEST.
 *
 * With no `scrapedAt` present anywhere (every value `""`) this is identical to `byIdAsc`.
 */
function byScrapedAtDescThenIdAsc(
  a: ScoredReference,
  b: ScoredReference,
  rowById: ReadonlyMap<string, ReferenceCandidateRow>,
): number {
  const av = (rowById.get(a.id)?.scrapedAt ?? "").trim();
  const bv = (rowById.get(b.id)?.scrapedAt ?? "").trim();
  if (av !== bv) return av < bv ? 1 : -1;
  return byIdAsc(a, b);
}

/**
 * How many leading words define a cluster. See `keywordClusterKey` — this truncation is the
 * load-bearing part of the key, not an optimization.
 */
const KEYWORD_CLUSTER_HEAD_WORDS = 3;

/**
 * Order-free identity of a crawl keyword — the unit the cluster cap rate-limits.
 *
 * Words come from `distinctiveWords` + `normalizeWord` (the SAME normalization the evidence
 * path uses), deduped in order of appearance; only the first `KEYWORD_CLUSTER_HEAD_WORDS` are
 * kept, then sorted and joined.
 *
 * ── Why the head truncation ──
 * Keying on the FULL word set was MEASURED to be far too fine on the live fashion pool: for a
 * "Gold Hoop Earrings" product with cap = 2, the top 9 were still 9 back-to-school pins,
 * because `back to school outfit inspo`, `back 2 school outfits senior`,
 * `back to school outfits boys`, `back to school outfit inspo high school`,
 * `back 2 school outfits uniform` and `back to school outfits 2026-2027` each formed their OWN
 * cluster — one distinct tail word was enough to escape the cap. Truncating to the head
 * collapses all six onto `"back outfit school"`, which is the theme a user actually perceives.
 *
 * Sorting AFTER truncation keeps the key order-insensitive within the head, so
 * `"outfit ideas summer"` and `"summer outfit ideas"` agree (`ideas` is a stop word).
 *
 * ── Known limit (deliberate, stated rather than hidden) ──
 * This is a heuristic over the HEAD of the keyword, so a variant that front-loads a modifier —
 * `"senior back to school outfits"` → `back school senior` — still forms its own cluster. Real
 * crawl keywords lead with the theme, which is why every measured variant above collapses;
 * widening the window would start merging genuinely different themes instead.
 *
 * An empty key means "no usable keyword". Callers must NOT rate-limit those rows — otherwise a
 * pool of keyword-less pins would all collapse into one cluster and get capped as if identical.
 */
export function keywordClusterKey(sourceKeyword?: string | null): string {
  const normalized = Array.from(new Set(distinctiveWords(sourceKeyword).map(normalizeWord)));
  return normalized.slice(0, KEYWORD_CLUSTER_HEAD_WORDS).sort().join(" ");
}

/**
 * Keyword-cluster diversity pass over ALREADY-SORTED tiers.
 *
 * Purely a REORDER, never a filter: rows past `cap` in a cluster are demoted to the end rather
 * than dropped, so both the "empty-result rate is 0% by construction" property and the
 * membership of the merged list survive. Only positions move — which is also why
 * `deriveRecommendationBasis` is unaffected (tiers and membership are identical).
 *
 * The cluster counter is SHARED across the two tier scans, so a Tier-2 row in a cluster Tier-1
 * already exhausted is demoted too: the cap is a property of the output set, not of a tier.
 */
function applyKeywordClusterCap(
  tier1: ScoredReference[],
  tier2: ScoredReference[],
  cap: number,
  rowById: ReadonlyMap<string, ReferenceCandidateRow>,
): ScoredReference[] {
  const counts = new Map<string, number>();
  const split = (items: ScoredReference[]) => {
    const kept: ScoredReference[] = [];
    const overflow: ScoredReference[] = [];
    for (const s of items) {
      const key = keywordClusterKey(rowById.get(s.id)?.sourceKeyword);
      if (!key) { kept.push(s); continue; }   // no keyword → never rate-limited
      const used = counts.get(key) ?? 0;
      if (used < cap) {
        counts.set(key, used + 1);
        kept.push(s);
      } else {
        overflow.push(s);
      }
    }
    return { kept, overflow };
  };
  const first = split(tier1);
  const second = split(tier2);
  return [...first.kept, ...second.kept, ...first.overflow, ...second.overflow];
}

/**
 * Tier-aware ranking for the product-aware POST path.
 *
 * ── Tier 1 — genuine product evidence ──
 *   admission: `productEvidenceScore > 0`.
 *   The old `RELEVANCE_FLOOR` (0.3) is deliberately NOT reused here. It was calibrated
 *   against the `categoryMatch * 0.6` constant; re-applying it to category-free evidence
 *   empties **37% of real catalog products** (round 2 Task A — home-decor 57%, fashion 60%,
 *   fashion mean result count 0.9 of 12). Several products with plenty of real evidence die
 *   to it: `Reading comprehension and fluency worksheet` has 71 evidence-bearing candidates
 *   and a best relevance of 0.250. The floor, not the evidence, was doing the killing.
 *   order: productEvidenceScore DESC → score DESC → scrapedAt DESC → id ASC.
 *
 * ── Tier 2 — category inspiration ──
 *   admission: displayable, unconditional. NO floor at all. This is what makes the
 *   empty-result rate 0% BY CONSTRUCTION.
 *   order: score DESC → scrapedAt DESC → id ASC.
 *
 * ── Merge ──
 *   Tier 1 first, then Tier 2 backfill to `limit`. Deduped ACROSS tiers by id AND imageUrl.
 *   If Tier 1 is empty the result is Tier 2 in full. A missing product evidence signal can
 *   NEVER produce an empty list.
 *
 * ── Optional keyword-cluster cap (`opts.keywordClusterCap`) ──
 *   OFF by default. Omitting `opts`, or passing `undefined` / `<= 0`, runs exactly the merge
 *   above. When on, each `source_keyword` cluster (see `keywordClusterKey`) may occupy at most
 *   `cap` of the leading slots; the remainder are DEMOTED (never dropped) behind the Tier-2
 *   keeps. Final order: Tier-1 keeps → Tier-2 keeps → Tier-1 overflow → Tier-2 overflow.
 *   `recommendationTier` and the returned membership are untouched, so the honest basis does
 *   not move with the cap.
 *
 * Callers get in-category scoping from the pool query; this function does not re-filter by
 * category, so `rows` must already be the intended pool.
 */
export function rankReferencesTiered(
  rows: ReferenceCandidateRow[],
  input: ReferenceScoringInput,
  limit = 12,
  opts?: { keywordClusterCap?: number },
): ScoredReference[] {
  const contextSet = buildContextSet(input);
  const evidenceCtx = buildProductEvidenceContext(input);

  const seen = new Set<string>();
  /** id → source row, so the tie-break and the cluster cap can read `scrapedAt` /
   *  `sourceKeyword` without widening the display-safe `ScoredReference` shape. */
  const rowById = new Map<string, ReferenceCandidateRow>();
  const tier1: { s: ScoredReference; evidence: number }[] = [];
  const tier2: ScoredReference[] = [];

  for (const row of rows) {
    if (!isDisplayable(row)) continue;                       // existing safety filters, unchanged
    if (seen.has(row.id) || seen.has(row.imageUrl)) continue; // cross-tier dedupe by id AND imageUrl
    seen.add(row.id);
    seen.add(row.imageUrl);
    rowById.set(row.id, row);
    const s = scoreReference(row, input, contextSet);
    const evidence = productEvidenceScore(row, evidenceCtx, input.category);
    if (evidence > 0) tier1.push({ s: { ...s, recommendationTier: "product_evidence" }, evidence });
    else tier2.push(asCategoryInspiration(s));
  }

  tier1.sort((a, b) =>
    (b.evidence - a.evidence) || (b.s.score - a.s.score) || byScrapedAtDescThenIdAsc(a.s, b.s, rowById));
  tier2.sort((a, b) => (b.score - a.score) || byScrapedAtDescThenIdAsc(a, b, rowById));

  const ranked1 = tier1.map(t => t.s);
  const cap = opts?.keywordClusterCap;
  const merged = cap != null && cap > 0
    ? applyKeywordClusterCap(ranked1, tier2, cap, rowById)
    : [...ranked1, ...tier2];
  return limit > 0 ? merged.slice(0, limit) : merged;
}

/** Strip internal fields for the wire. */
export function toRecommendation(s: ScoredReference): ReferenceRecommendation {
  const { score, relevance, signals, recommendationTier, ...rest } = s;
  void score; void relevance; void signals; void recommendationTier;
  return rest;
}
