/**
 * The phrase set an account's Pins are checked against.
 *
 * Where the phrases come from is the whole design: they come from `trend_keywords`
 * (what people search on Pinterest) and its `keyword_expansions` (what the search box
 * suggests), and they NEVER come from the account's own Pin text. That restriction is
 * not a performance choice, it is what makes observation A1 mean anything. A set
 * derived from the user's own titles would match those titles by construction, and
 * "your Pins do not carry your keywords" could then never be true — the rule would be
 * a mirror. The test for this is `buildKeywordSet` not having a parameter for Pin
 * text at all, and the set's hash staying identical when a Pin title changes.
 *
 * Category inference is a separate function on purpose. Inference DOES read board
 * names and Pin titles — it has to, it is guessing which market the account is in —
 * but it only ever selects among category label sets that already exist in
 * `trend_keywords`. So the account's own words can pick which shelf to read from;
 * they can never write a phrase onto it.
 */

import { countPhraseHits, normalizePhrase } from "./phraseMatch";

/** Bump when the composition rules below change (limits, ordering, filters). */
export const KEYWORD_SET_VERSION = "keyword-set-1";

/** Seed keywords taken per category, strongest first. */
export const KEYWORD_SET_SEED_LIMIT = 300;
/** Expansions of those seeds added on top. */
export const KEYWORD_SET_EXPANSION_LIMIT = 200;
/** Hard cap on the stored set. */
export const KEYWORD_SET_MAX_PHRASES = 500;
/** A set older than this is rebuilt on the next dashboard build. */
export const KEYWORD_SET_MAX_AGE_DAYS = 30;

export type TrendKeywordRow = {
  keyword: string;
  category: string | null;
  priorityScore: number | null;
};

export type KeywordExpansionRow = {
  seedKeyword: string;
  expandedKeyword: string;
  rank: number | null;
};

export type AccountKeywordSet = {
  category: string | null;
  /** Normalized, space-joined, ≥2 tokens, deduplicated, ordered by strength. */
  phrases: string[];
  /** Identity of the CONTENT of the set — two rebuilds that produce the same phrases
   *  produce the same hash, which is how "did the set really change?" is answered
   *  without diffing 500 strings. */
  hash: string;
  /** The stored row this came from, or null when it was built in memory because the
   *  v65 table is not there yet. Travels to the client so a diagnosis can be traced
   *  to the exact phrase set that produced it. */
  version: number | null;
  sourceSnapshotAt: string | null;
};

export const EMPTY_KEYWORD_SET: AccountKeywordSet = {
  category: null,
  phrases: [],
  hash: "0",
  version: null,
  sourceSnapshotAt: null,
};

/**
 * FNV-1a over the ordered phrase list.
 *
 * Deliberately not `node:crypto`: this module is imported by pure tests and by code
 * that may be bundled for the browser, and the hash is an identity check between two
 * sets we produced ourselves — not a security boundary. Collisions here would show up
 * as "the set did not change when it did", which the version counter and
 * `source_snapshot_at` also cover.
 */
export function hashPhrases(phrases: readonly string[]): string {
  let hash = 0x811c9dc5;
  const joined = phrases.join("\n");
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    // 32-bit FNV prime multiply, kept in 32 bits without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A phrase is worth keeping only if it still has two content words after
 *  normalization: a single word matches far too much to be evidence of anything, and
 *  the empty string matches everything. */
function usablePhrase(raw: string | null | undefined): string | null {
  const phrase = normalizePhrase(raw);
  return phrase.split(" ").filter(Boolean).length >= 2 ? phrase : null;
}

/**
 * Build the set from keyword rows and their expansions.
 *
 * Note the signature: rows in, phrases out. There is nowhere to pass Pin text.
 */
export function buildKeywordSet(
  keywords: readonly TrendKeywordRow[],
  expansions: readonly KeywordExpansionRow[],
  options?: { category?: string | null },
): Omit<AccountKeywordSet, "version" | "sourceSnapshotAt"> {
  const category = options?.category ?? null;
  const inCategory = category
    ? keywords.filter(row => (row.category ?? null) === category)
    : [...keywords];

  // Strongest first, ties by keyword so the order (and therefore the hash) does not
  // depend on the order Postgres happened to return.
  const seeds = [...inCategory]
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0) || a.keyword.localeCompare(b.keyword))
    .slice(0, KEYWORD_SET_SEED_LIMIT);

  const seedKeys = new Set(seeds.map(row => row.keyword.trim().toLowerCase()));
  const relevantExpansions = expansions
    .filter(row => seedKeys.has(row.seedKeyword.trim().toLowerCase()))
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)
      || a.seedKeyword.localeCompare(b.seedKeyword)
      || a.expandedKeyword.localeCompare(b.expandedKeyword))
    .slice(0, KEYWORD_SET_EXPANSION_LIMIT);

  const phrases: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined) => {
    const phrase = usablePhrase(raw);
    if (!phrase || seen.has(phrase)) return;
    seen.add(phrase);
    phrases.push(phrase);
  };
  // Seeds before expansions: when the cap bites, the phrases people actually search
  // survive and the autocomplete variants are what is lost.
  for (const row of seeds) push(row.keyword);
  for (const row of relevantExpansions) push(row.expandedKeyword);

  const capped = phrases.slice(0, KEYWORD_SET_MAX_PHRASES);
  return { category, phrases: capped, hash: hashPhrases(capped) };
}

export type CategoryPhraseIndex = Array<{
  category: string;
  phrases: string[];
  /** Summed `priority_score` of the rows behind those phrases. The tie-break. */
  weight: number;
}>;

/** Group keyword rows into the per-category phrase lists inference compares. */
export function buildCategoryPhraseIndex(keywords: readonly TrendKeywordRow[]): CategoryPhraseIndex {
  const byCategory = new Map<string, { phrases: Set<string>; weight: number }>();
  for (const row of keywords) {
    const category = (row.category ?? "").trim();
    if (!category) continue;
    const phrase = usablePhrase(row.keyword);
    if (!phrase) continue;
    const entry = byCategory.get(category) ?? { phrases: new Set<string>(), weight: 0 };
    entry.phrases.add(phrase);
    entry.weight += row.priorityScore ?? 0;
    byCategory.set(category, entry);
  }
  return [...byCategory.entries()]
    .map(([category, entry]) => ({ category, phrases: [...entry.phrases], weight: entry.weight }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export type CategoryInference = {
  category: string | null;
  hits: number;
  /** Every category that scored, strongest first — kept so a wrong guess is
   *  diagnosable without re-running the inference. */
  ranking: Array<{ category: string; hits: number; weight: number }>;
};

/**
 * Which category does this account look like?
 *
 * Counts how many of each category's phrases appear in the account's own text (board
 * names and the titles of its best-known Pins). Zero hits everywhere returns null
 * rather than the largest category: a wrong category silently rewrites every A1
 * observation, and "we do not know yet" is a state the caller can handle (it asks
 * the user) while a confident wrong answer is not.
 */
export function inferCategory(texts: readonly string[], index: CategoryPhraseIndex): CategoryInference {
  const ranking = index.map(entry => ({
    category: entry.category,
    hits: texts.reduce((total, text) => total + countPhraseHits(text, entry.phrases), 0),
    weight: entry.weight,
  }));
  ranking.sort((a, b) => b.hits - a.hits || b.weight - a.weight || a.category.localeCompare(b.category));
  const best = ranking[0];
  return {
    category: best && best.hits > 0 ? best.category : null,
    hits: best?.hits ?? 0,
    ranking: ranking.filter(entry => entry.hits > 0),
  };
}

/** Is a stored set still usable? Rebuilt when the category changed under it or when
 *  it is older than 30 days — Pinterest's search terms move with the seasons, and a
 *  set from last quarter measures against a market that has gone. */
export function keywordSetIsFresh(
  stored: { category: string | null; sourceSnapshotAt: string | null } | null,
  wantedCategory: string | null,
  now: Date,
): boolean {
  if (!stored) return false;
  if ((stored.category ?? null) !== (wantedCategory ?? null)) return false;
  if (!stored.sourceSnapshotAt) return false;
  const snapshot = new Date(stored.sourceSnapshotAt).getTime();
  if (!Number.isFinite(snapshot)) return false;
  const ageDays = (now.getTime() - snapshot) / 86_400_000;
  return ageDays >= 0 && ageDays <= KEYWORD_SET_MAX_AGE_DAYS;
}
