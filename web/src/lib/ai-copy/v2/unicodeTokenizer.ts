/**
 * unicodeTokenizer.ts - Unicode-aware tokenizer for AI Copy v2 and keywordContext.
 *
 * Grounding & Tokenization Rules:
 *  - Uses Intl.Segmenter with Unicode regex fallback.
 *  - Preserves English / ASCII behavior: ignores <= 2-char ASCII stop-like fragments.
 *  - Retains meaningful CJK tokens (words and salient topic characters, filtering trivial particles).
 */

const CJK_REGEX = /[\p{Unified_Ideograph}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Common single-character grammatical particles/stops in CJK that do not carry topic meaning
const CJK_SINGLE_CHAR_STOPS = new Set([
  "的", "了", "和", "是", "就", "都", "而", "及", "与", "着", "或", "之", "在", "于", "把", "被", "让", "给",
]);

let cachedSegmenter: Intl.Segmenter | null | undefined = undefined;

function getSegmenter(locale?: string): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    return null;
  }
  try {
    return new Intl.Segmenter(locale || undefined, { granularity: "word" });
  } catch {
    try {
      if (cachedSegmenter === undefined) {
        cachedSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
      }
      return cachedSegmenter;
    } catch {
      return null;
    }
  }
}

export function tokenizeUnicodeWords(text: string, locale?: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const segmenter = getSegmenter(locale);

  if (segmenter) {
    const tokens: string[] = [];
    for (const seg of segmenter.segment(lower)) {
      if (!seg.isWordLike) continue;
      const s = seg.segment.trim();
      if (!s) continue;
      if (CJK_REGEX.test(s)) {
        if (s.length === 1 && CJK_SINGLE_CHAR_STOPS.has(s)) {
          continue;
        }
        tokens.push(s);
      } else {
        // Non-CJK / ASCII words: keep only if length > 2
        if (s.length > 2) {
          tokens.push(s);
        }
      }
    }
    return tokens;
  }

  // Unicode regex fallback when Intl.Segmenter is unavailable
  const fallbackRegex = /[\p{Unified_Ideograph}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu;
  const matches = lower.match(fallbackRegex) || [];
  const tokens: string[] = [];
  for (const m of matches) {
    if (CJK_REGEX.test(m)) {
      if (m.length === 1 && CJK_SINGLE_CHAR_STOPS.has(m)) {
        continue;
      }
      tokens.push(m);
    } else if (m.length > 2) {
      tokens.push(m);
    }
  }
  return tokens;
}
