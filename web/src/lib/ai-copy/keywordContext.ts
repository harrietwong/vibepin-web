/**
 * keywordContext.ts — retrieve high-search Pinterest keyword context for AI Copy.
 *
 * Source of truth: the `trend_keywords` table (collected from Pinterest). We use it
 * ONLY as keyword context — NOT as a trend system. We never present these values as
 * exact search volume, and we never label them "Trending" here (no time-series claim).
 * See project_keyword_tool_direction for the data-honesty rules.
 *
 * Selection is relevance-first: a keyword must actually relate to what is visible in
 * the image (or the board), then search volume breaks ties. High-volume-but-irrelevant
 * keywords are rejected.
 */

import { normalizeWords } from "@/lib/keyword-data/mapTrendKeywordRow";

export type KeywordRow = {
  id: string;
  keyword: string;
  category?: string | null;
  search_volume_level?: string | null;
  volume_signal?: string | null;
  volume_score?: number | null;
  priority_score?: number | null;
  region?: string | null;
};

export type ScoredKeyword = {
  keyword: string;
  category?: string | null;
  searchVolumeLevel?: string | null;
  relevanceScore: number;      // 0..1 — how well it matches the image/board
  normalizedVolume: number;    // 0..1 — search interest (NOT exact volume)
  finalScore: number;          // relevanceScore*0.7 + normalizedVolume*0.3
};

export type KeywordContextInput = {
  imageSummary: string;
  visibleObjects: string[];
  style: string;
  boardName?: string;
  category?: string;
  language?: string;
  region?: string;
  // ── Product context (Shopify / linked product) — optional relevance signal ──────
  // When a Pin is tied to a product, its title / type / tags are strong, specific
  // relevance signals. They feed both the query terms and the ranking (product words
  // count for coverage AND get an explicit overlap dimension weighted at least as high
  // as the board). Absent → behaves exactly as before.
  productTitle?: string;
  productType?: string;
  productTags?: string[];
  // ── Creative direction context — a secondary style/scene signal ─────────────────
  // The direction the user picked (name + a few scene/style terms). Weighted BELOW
  // product/board so it nudges but never dominates relevance. Absent → no effect.
  directionTitle?: string;
  directionTerms?: string[];
};

export type KeywordContextResult = {
  queryTerms: string[];
  candidates: ScoredKeyword[];                       // 10-20 relevant candidates
  recommended: string[];                             // 5-8 final keywords
  rejected: Array<{ keyword: string; reason: string }>;
  poolSize: number;
};

// Generic terms we avoid UNLESS combined with a specific modifier (a visible object,
// room, or style word). Matches the acceptance rule: keep "living room decor ideas",
// drop bare "home decor" / "inspiration" / "product ideas".
const GENERIC_WORDS = new Set([
  "home", "decor", "decoration", "decorations", "inspiration", "inspo", "idea", "ideas",
  "product", "products", "aesthetic", "aesthetics", "design", "designs", "style", "styles",
  "look", "looks", "pinterest", "trend", "trends", "trending", "vibe", "vibes", "diy",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "your", "this", "that", "of", "to", "in",
  "on", "at", "by", "is", "are", "features", "featuring", "corner", "room", // 'room' alone is weak; 'living room' is fine
]);

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Containment: fraction of the keyword's words present in the context word set. */
function containment(contextSet: Set<string>, keyword: string): number {
  const words = normalizeWords(keyword);
  if (!words.length || !contextSet.size) return 0;
  const hit = words.filter(w => contextSet.has(w)).length;
  return hit / words.length;
}

/** The keyword's distinctive words (excludes generic + stop words). */
function specificWords(keyword: string): string[] {
  return normalizeWords(keyword).filter(w => !GENERIC_WORDS.has(w) && !STOP_WORDS.has(w));
}

/**
 * Specific-word coverage: fraction of the keyword's DISTINCTIVE words present in the
 * image/board context. This is what stops unrelated high-volume keywords (e.g.
 * "christmas decor ideas for living room") from riding in on generic overlap — the
 * distinctive word ("christmas") is absent from the context, so coverage drops.
 */
function specificCoverage(contextSet: Set<string>, keyword: string): number {
  const sp = specificWords(keyword);
  if (!sp.length) return 0;
  return sp.filter(w => contextSet.has(w)).length / sp.length;
}

/** Search interest as a 0..1 signal. NOT exact search volume. */
export function normalizedVolume(row: Pick<KeywordRow, "volume_score" | "volume_signal" | "search_volume_level" | "priority_score">): number {
  if (row.volume_score != null && row.volume_score > 0) return clamp01(row.volume_score / 5);
  const band = (row.volume_signal ?? row.search_volume_level ?? "").toLowerCase();
  if (band.includes("very")) return band.includes("low") ? 0.35 : 0.95; // very_high
  if (band.includes("high")) return 0.85;
  if (band.includes("med")) return 0.55;
  if (band.includes("low")) return 0.3;
  // "unscored" / unknown → fall back to the pipeline priority score.
  if (row.priority_score != null && row.priority_score > 0) return clamp01(row.priority_score / 100);
  return 0.3;
}

/** True when a keyword has no specific modifier beyond generic/stop words. */
export function isTooGeneric(keyword: string): boolean {
  const words = normalizeWords(keyword);
  if (!words.length) return true;
  const specific = words.filter(w => !GENERIC_WORDS.has(w) && !STOP_WORDS.has(w));
  return specific.length === 0;
}

/** Normalize a term for DB matching: lowercase, hyphens → spaces, collapse space. */
function normTerm(s: string): string {
  return s.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Build the search terms used to query the keyword DB, in PRIORITY ORDER. The DB
 * stores canonical 2-4 word Pinterest phrases (e.g. "mid century modern living room"),
 * so hyper-specific 4+ word object descriptions rarely match. We prioritize the terms
 * most likely to hit canonical keywords: the board phrase, the style, and 2-word object
 * tails (e.g. "area rug", "side table") — then fall back to head nouns / salient words.
 */
export function buildQueryTerms(input: KeywordContextInput): string[] {
  const tiers: string[][] = [[], [], [], []];
  const add = (tier: number, raw: string) => {
    const t = normTerm(raw);
    if (t.length > 2) tiers[tier].push(t);
  };

  const boardWords = normalizeWords(input.boardName ?? "");
  // Tier 0 (strongest): board phrase minus generic words (e.g. "living room") + style.
  const boardPhrase = boardWords.filter(w => !GENERIC_WORDS.has(w)).join(" ").trim();
  if (boardPhrase.includes(" ")) add(0, boardPhrase);
  if (input.style) add(0, input.style);

  // Tier 0 also: product type — a canonical product noun phrase (e.g. "area rug",
  // "ceramic mug"), as query-worthy as the board phrase.
  if (input.productType) add(0, input.productType);
  // Tier 1: product title 2-word tail + tag tails (canonical phrase shape).
  const productTitleWords = normalizeWords(input.productTitle ?? "").filter(w => !STOP_WORDS.has(w));
  if (productTitleWords.length >= 2) add(1, productTitleWords.slice(-2).join(" "));
  for (const tag of input.productTags ?? []) {
    const tw = normalizeWords(tag).filter(w => !STOP_WORDS.has(w));
    if (tw.length >= 2) add(1, tw.slice(-2).join(" "));
    else if (tw.length === 1 && tw[0].length > 3 && !GENERIC_WORDS.has(tw[0])) add(2, tw[0]);
  }
  // Tier 2: salient product title head nouns.
  for (const w of productTitleWords) {
    if (!GENERIC_WORDS.has(w) && w.length > 3) add(2, w);
  }

  // Tier 1: 2-word tails of visible objects (canonical phrase shape).
  for (const obj of input.visibleObjects) {
    const words = normalizeWords(obj).filter(w => !STOP_WORDS.has(w));
    if (words.length >= 2) add(1, words.slice(-2).join(" "));
  }

  // Tier 2: salient board words + object head nouns.
  for (const w of boardWords) {
    if (!GENERIC_WORDS.has(w) && !STOP_WORDS.has(w) && w.length > 3) add(2, w);
  }
  for (const obj of input.visibleObjects) {
    const head = normalizeWords(obj).filter(w => !STOP_WORDS.has(w)).pop();
    if (head && head.length > 2) add(2, head);
  }

  // Tier 3 (fallback): category + salient summary nouns + creative-direction words.
  if (input.category) add(3, input.category.replace(/-/g, " "));
  const directionWords = [
    ...normalizeWords(input.directionTitle ?? ""),
    ...(input.directionTerms ?? []).flatMap(t => normalizeWords(t)),
  ];
  for (const w of directionWords) {
    if (!GENERIC_WORDS.has(w) && !STOP_WORDS.has(w) && w.length > 3) add(3, w);
  }
  for (const w of normalizeWords(input.imageSummary)) {
    if (!GENERIC_WORDS.has(w) && !STOP_WORDS.has(w) && w.length > 4) add(3, w);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const tier of tiers) {
    for (const t of tier) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out.slice(0, 10);
}

/**
 * Pure ranking core (unit-testable). Scores a candidate pool against the image/board
 * context and returns candidates + the 5-8 recommended keywords + rejects.
 */
export function rankKeywords(rows: KeywordRow[], input: KeywordContextInput): Omit<KeywordContextResult, "queryTerms" | "poolSize"> {
  // Product words are specific, high-signal relevance evidence — fold them into the
  // coverage context set (so a product-matching keyword's distinctive words are
  // "seen") AND score them again as an explicit overlap dimension below.
  const productWords = normalizeWords(
    [input.productTitle ?? "", input.productType ?? "", ...(input.productTags ?? [])].join(" "),
  ).filter(w => !STOP_WORDS.has(w));
  // Direction words stay OUT of the coverage set (kept subordinate to image/product);
  // they only contribute a small explicit overlap dimension.
  const directionWords = [
    ...normalizeWords(input.directionTitle ?? ""),
    ...(input.directionTerms ?? []).flatMap(t => normalizeWords(t)),
  ].filter(w => !STOP_WORDS.has(w));

  const contextSet = new Set<string>([
    ...normalizeWords(input.visibleObjects.join(" ")),
    ...normalizeWords(input.style),
    ...normalizeWords(input.imageSummary),
    ...normalizeWords((input.category ?? "").replace(/-/g, " ")),
    ...productWords,
  ]);
  const boardSet = new Set<string>(normalizeWords(input.boardName ?? ""));
  const productSet = new Set<string>(productWords);
  const directionSet = new Set<string>(directionWords);
  const cat = (input.category ?? "").toLowerCase().replace(/-/g, " ").trim();

  const seen = new Set<string>();
  const rejected: Array<{ keyword: string; reason: string }> = [];
  const scored: Array<ScoredKeyword & { coverage: number }> = [];

  for (const row of rows) {
    const keyword = (row.keyword ?? "").trim();
    const norm = keyword.toLowerCase();
    if (!keyword || seen.has(norm)) continue;
    seen.add(norm);

    const coverage = specificCoverage(contextSet, keyword);
    const boardOverlap = boardSet.size ? containment(boardSet, keyword) : 0;
    const productOverlap = productSet.size ? containment(productSet, keyword) : 0;
    const directionOverlap = directionSet.size ? containment(directionSet, keyword) : 0;
    const categoryMatch = cat && (row.category ?? "").toLowerCase().replace(/-/g, " ").trim() === cat ? 1 : 0;
    // Relevance is coverage-led: a keyword's DISTINCTIVE words must appear in the image.
    // Product overlap is weighted at least as high as the board (both 0.25); the
    // direction is a lighter nudge (0.1). These are ADDITIVE increments — when no
    // product/direction context is supplied both are 0 and scoring is unchanged.
    const relevanceScore = clamp01(
      coverage * 0.55 + boardOverlap * 0.25 + categoryMatch * 0.2 + productOverlap * 0.25 + directionOverlap * 0.1,
    );

    // A keyword must genuinely relate to the image or board — never volume alone.
    if (relevanceScore < 0.3) {
      rejected.push({ keyword, reason: `low_relevance:${relevanceScore.toFixed(2)}` });
      continue;
    }
    const nv = normalizedVolume(row);
    scored.push({
      keyword,
      category: row.category,
      searchVolumeLevel: row.volume_signal ?? row.search_volume_level ?? null,
      relevanceScore,
      normalizedVolume: nv,
      finalScore: relevanceScore * 0.7 + nv * 0.3,
      coverage,
    });
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const candidates: ScoredKeyword[] = scored.slice(0, 20).map(({ coverage, ...c }) => { void coverage; return c; });

  const recommended: string[] = [];
  for (const c of scored) {
    if (recommended.length >= 8) break;
    // Generic terms only survive when combined with a specific modifier.
    if (isTooGeneric(c.keyword)) {
      rejected.push({ keyword: c.keyword, reason: "too_generic" });
      continue;
    }
    // Require the keyword's distinctive words to be well-covered by the image, so a
    // high-volume-but-off-topic keyword (christmas/boho on a modern image) is dropped.
    if (c.coverage < 0.6) {
      rejected.push({ keyword: c.keyword, reason: `low_coverage:${c.coverage.toFixed(2)}` });
      continue;
    }
    if (c.relevanceScore < 0.4) {
      rejected.push({ keyword: c.keyword, reason: `below_recommend_floor:${c.relevanceScore.toFixed(2)}` });
      continue;
    }
    recommended.push(c.keyword);
  }

  return { candidates, recommended, rejected };
}

/**
 * Retrieve keyword context from the `trend_keywords` DB. Best-effort: on any error,
 * or for non-English content (the DB is English), returns empty context so AI Copy
 * still works from image + board alone. Never throws.
 */
export async function retrievePinterestKeywords(input: KeywordContextInput): Promise<KeywordContextResult> {
  const empty: KeywordContextResult = { queryTerms: [], candidates: [], recommended: [], rejected: [], poolSize: 0 };
  // The keyword DB is English; don't inject English keywords into other-language copy.
  if (input.language && !input.language.toLowerCase().startsWith("en")) return empty;

  const queryTerms = buildQueryTerms(input);
  if (!queryTerms.length) return empty;

  const region = input.region || "US";
  const FIELDS = "id,keyword,category,search_volume_level,volume_signal,volume_score,priority_score,region";

  let rows: KeywordRow[] = [];
  try {
    // Dynamic import so the pure ranking functions above stay usable without env
    // (the Supabase module instantiates a client at load time).
    const { createServerClient } = await import("@/lib/supabase");
    const db = createServerClient();
    const results = await Promise.all(
      queryTerms.slice(0, 8).map(async term => {
        const { data } = await db
          .from("trend_keywords")
          .select(FIELDS)
          .eq("status", "active")
          .or(`region.eq.${region},region.is.null`)
          .ilike("keyword", `%${term}%`)
          .order("priority_score", { ascending: false })
          .limit(15);
        return (data ?? []) as unknown as KeywordRow[];
      }),
    );
    const byId = new Map<string, KeywordRow>();
    for (const set of results) for (const r of set) if (r?.id && !byId.has(r.id)) byId.set(r.id, r);
    rows = Array.from(byId.values());
  } catch {
    return { ...empty, queryTerms };
  }

  const ranked = rankKeywords(rows, input);
  return { queryTerms, poolSize: rows.length, ...ranked };
}
