/**
 * Phrase matching for the Insights evidence engine.
 *
 * The one question this module answers: does a piece of Pin text CONTAIN one of the
 * account's keyword phrases, as a phrase? Nothing else. It is deliberately not the
 * fuzzy matcher in `keyword-data/keywordMatch.ts`, which scores similarity so a
 * search box can rank near-misses. A near-miss is the right answer for a search box
 * and the wrong answer here: an observation that says "this title carries none of
 * your keyword phrases" has to be checkable by the person reading it. If
 * "small pantry organizer" counted as "small pantry organization" because they are
 * 0.86 similar, the user would look at the title, see their phrase almost there, and
 * have no way to know which threshold decided against them. Contiguous subsequence
 * match is a rule anyone can apply by eye.
 *
 * Normalization is NFKC → lowercase → punctuation stripped (intra-word hyphens kept)
 * → whitespace split → stopwords dropped. Each step exists for a reason:
 *   - NFKC folds the full-width and ligature characters that arrive from pasted
 *     product copy; without it "ｄｉｙ" and "diy" are different words.
 *   - Intra-word hyphens survive because "shop-the-look" and "shop the look" are the
 *     same phrase to a reader, and Pinterest keywords contain both forms; a hyphen
 *     is therefore a word separator, not a character to delete (deleting it would
 *     make "shopthelook", which matches nothing).
 *   - Stopwords are dropped from BOTH sides, so "ideas for a small pantry" contains
 *     "small pantry" — the words a keyword tool sells you are content words, and a
 *     phrase test that fails on an inserted "for a" would report absence that a
 *     human reading the title would call presence.
 *
 * The stopword list is versioned: changing it changes which Pins count as carrying a
 * phrase, and an evidence set whose numbers moved because a constant changed must be
 * distinguishable from one whose numbers moved because the account changed.
 */

/** Bump when the stopword list or the normalization steps change. */
export const PHRASE_NORMALIZATION_VERSION = "phrase-1";

/**
 * English function words dropped from both text and phrases.
 *
 * Kept to closed-class words (articles, pronouns, prepositions, auxiliaries,
 * conjunctions) plus the handful of near-empty content words that appear in almost
 * every Pin title ("ideas", "best", "diy" is NOT here — it is a real category term).
 * No noun that could be the subject of a keyword is on this list.
 */
export const PHRASE_STOPWORDS: readonly string[] = [
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any",
  "are", "as", "at", "be", "because", "been", "before", "being", "below", "between",
  "both", "but", "by", "can", "cannot", "could", "did", "do", "does", "doing", "down",
  "during", "each", "few", "for", "from", "further", "had", "has", "have", "having",
  "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "i", "if",
  "in", "into", "is", "it", "its", "itself", "just", "me", "more", "most", "my",
  "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or",
  "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shall",
  "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs",
  "them", "themselves", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you",
  "your", "yours", "yourself", "yourselves",
];

const STOPWORD_SET = new Set(PHRASE_STOPWORDS);

/**
 * Everything that is not a letter, a digit or a hyphen becomes a space.
 *
 * Written as a negated class rather than a list of punctuation because Pin copy
 * arrives with emoji, box-drawing characters and typographic quotes that no
 * enumeration keeps up with. `\p{L}\p{N}` keeps non-Latin scripts intact: this
 * product ships in 18 languages and a Japanese title must tokenize to its own
 * characters rather than to nothing.
 */
const NON_WORD = /[^\p{L}\p{N}-]+/gu;

/** Hyphens that are not between two word characters (leading, trailing, doubled). */
const EDGE_HYPHEN = /(^-+)|(-+$)/g;

/**
 * Text → content tokens.
 *
 * Returns `[]` for empty input rather than `[""]`, which would otherwise make an
 * empty title "contain" an empty phrase.
 */
export function normalizeTokens(input: string | null | undefined): string[] {
  if (!input) return [];
  const folded = input.normalize("NFKC").toLowerCase().replace(NON_WORD, " ");
  const tokens: string[] = [];
  for (const raw of folded.split(/\s+/)) {
    const token = raw.replace(EDGE_HYPHEN, "").replace(/-{2,}/g, "-");
    if (!token) continue;
    if (STOPWORD_SET.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

/** The normalized, space-joined form used as the identity of a phrase. */
export function normalizePhrase(input: string | null | undefined): string {
  return normalizeTokens(input).join(" ");
}

/**
 * Is `phraseTokens` a contiguous run inside `tokens`?
 *
 * An empty phrase matches nothing: a phrase that normalized away (all stopwords) is
 * not a phrase every text contains, it is a phrase that should never have been in
 * the set — and the set builder drops it for exactly this reason.
 */
export function containsPhrase(tokens: readonly string[], phraseTokens: readonly string[]): boolean {
  const span = phraseTokens.length;
  if (span === 0 || span > tokens.length) return false;
  for (let start = 0; start + span <= tokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < span; offset += 1) {
      if (tokens[start + offset] !== phraseTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** The first phrase of `phrases` present in `text`, or null. Phrases arrive already
 *  normalized (space-joined); re-splitting them here keeps callers from having to
 *  carry two representations. */
export function findPhrase(text: string | null | undefined, phrases: readonly string[]): string | null {
  const tokens = normalizeTokens(text);
  if (tokens.length === 0) return null;
  for (const phrase of phrases) {
    const phraseTokens = phrase.split(" ").filter(Boolean);
    if (containsPhrase(tokens, phraseTokens)) return phrase;
  }
  return null;
}

/** How many of `phrases` occur in `text`. Used by category inference, where the
 *  count is the evidence and the identity of the phrase is not. */
export function countPhraseHits(text: string | null | undefined, phrases: readonly string[]): number {
  const tokens = normalizeTokens(text);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const phrase of phrases) {
    if (containsPhrase(tokens, phrase.split(" ").filter(Boolean))) hits += 1;
  }
  return hits;
}
