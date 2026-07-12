// Keyword query ↔ DB row matching with similarity thresholds.

import type { TrendKeywordDbRow } from "./mapTrendKeywordRow";
import { wordOverlapScore } from "./mapTrendKeywordRow";

export type MatchType = "exact" | "prefix" | "contains" | "word" | "none";

export type RankedMatch = {
  row: TrendKeywordDbRow;
  matchType: MatchType;
  similarity: number;
};

/** 0–1 similarity between user query and a DB keyword. */
export function computeMatchSimilarity(query: string, candidate: string): number {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (!q || !c) return 0;
  if (q === c) return 1;

  const qWords = q.split(/\s+/).filter(Boolean);
  const cWords = c.split(/\s+/).filter(Boolean);

  if (c.startsWith(q)) {
    return Math.min(0.98, 0.68 + q.length / Math.max(c.length, 1));
  }

  if (qWords.length === 1 && cWords.some(w => w.startsWith(q))) {
    const atStart = cWords[0].startsWith(q);
    const word = cWords.find(w => w.startsWith(q))!;
    if (atStart) {
      return Math.min(0.92, 0.58 + q.length / Math.max(word.length, 1));
    }
    // Embedded word (e.g. "home" in "smart home gadgets") — lower than prefix-at-start
    return Math.min(0.52, 0.32 + q.length / Math.max(c.length, 1));
  }

  if (c.includes(q)) {
    return Math.min(0.78, 0.36 + q.length / Math.max(c.length, 1));
  }

  const overlap = wordOverlapScore(q, c);
  if (overlap > 0) return overlap;

  return 0;
}

export function minSimilarityThreshold(matchType: MatchType, query: string): number {
  const len = query.trim().length;
  switch (matchType) {
    case "exact":   return 1;
    case "prefix":  return len <= 5 ? 0.38 : 0.28;
    case "contains": return len <= 5 ? 0.42 : 0.32;
    case "word":    return 0.36;
    default:        return 1;
  }
}

export function isAcceptableMatch(query: string, candidate: string, matchType: MatchType): boolean {
  const sim = computeMatchSimilarity(query, candidate);
  return sim >= minSimilarityThreshold(matchType, query);
}

export function pickBestMatch(
  query: string,
  candidates: Array<{ row: TrendKeywordDbRow; matchType: MatchType }>,
): RankedMatch | null {
  const ranked = candidates
    .map(({ row, matchType }) => ({
      row,
      matchType,
      similarity: computeMatchSimilarity(query, row.keyword),
    }))
    .filter(m => m.similarity >= minSimilarityThreshold(m.matchType, query))
    .sort((a, b) => b.similarity - a.similarity);

  return ranked[0] ?? null;
}
