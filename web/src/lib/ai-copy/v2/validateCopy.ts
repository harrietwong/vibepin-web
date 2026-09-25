/**
 * validateCopy.ts — Validation engine for AI Copy v2.
 *
 * Enforces:
 *  - Hard character limits (title <= 100, description <= 500 — Studio's schedule/publish cap).
 *  - Keyword occurrence frequency (title <= 1, description <= 2).
 *  - Consecutive word stuffing (>=3 consecutive identical non-stopwords).
 *  - Grounding checks: unsupported material, efficacy/therapeutic, price,
 *    availability, brand, and numeric commercial claims.
 *  - Fact claim policy boundaries (blocked facts, descriptive-only violations).
 *  - Route orchestration detected claims (arbitrary commercial claims).
 *
 * NOTE ON LEXICONS:
 * Built-in sensitive materials, brand lists, and regexes serve as deterministic
 * traps / defense-in-depth guardrails. They are NOT exhaustive whitelists of all
 * world brands or materials. Comprehensive detection across languages should be
 * supplied by route orchestration via `detectedClaims`.
 *
 * Invariant: Never mutates or truncates text. Returns structured issue codes and locations.
 */

import type {
  FactCardV1,
  FactItem,
  ValidationReport,
  ValidationIssue,
  ValidationIssueCode,
  DetectedClaim,
  DetectedClaimType,
  ClaimDetectionResult,
} from "./types";

/**
 * Default description cap. Must equal pinReadiness.DESCRIPTION_MAX_LENGTH (500): Studio
 * blocks Schedule/Publish above it, so an 800-char v2 description (the old default) was
 * valid here but unschedulable there (Preview P1 0925: a 627-char non-Amazon result).
 * Pinned by test-ai-copy-v2-facts.
 */
export const DEFAULT_DESCRIPTION_MAX = 500;

export interface ValidateCopyInput {
  title: string;
  description: string;
  altText?: string;
  factCard: FactCardV1;
  keywords?: string[];
  claimDetection: ClaimDetectionResult;
  /**
   * Description cap. Defaults to DEFAULT_DESCRIPTION_MAX (500). Affiliate copy passes 500,
   * Studio's schedule cap, because the appended disclosure must fit inside it (design §3.4).
   */
  descriptionMax?: number;
}

const STOPWORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "at", "by", "for",
  "with", "about", "against", "between", "into", "through", "during", "before", "after",
  "above", "below", "to", "from", "up", "down", "in", "out", "on", "off", "over", "under",
  "again", "further", "once", "here", "there", "all", "any", "both", "each", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than",
  "too", "very", "s", "t", "can", "will", "just", "don", "should", "now", "i", "me", "my",
  "myself", "we", "our", "ours", "ourselves", "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself", "it", "its", "itself",
  "they", "them", "their", "theirs", "themselves", "what", "which", "who", "whom", "this",
  "that", "these", "those", "am", "is", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "having", "do", "does", "did", "doing",
]);

// Deterministic trap lists (defense-in-depth guardrails)
const TRAP_MATERIALS = [
  "sterling silver", "925 silver", "mulberry silk", "pure silk", "silk",
  "cashmere", "leather", "linen", "wool", "gold", "diamond", "diamonds",
  "platinum", "titanium", "velvet", "satin", "acrylic", "carbon fiber",
];

const TRAP_BRANDS = [
  "nike", "tiffany", "apple", "gucci", "prada", "louis vuitton",
  "adidas", "rolex", "chanel", "hermes", "hermès", "cartier",
];

type CommercialDetectedClaimType = Exclude<DetectedClaimType, "video_motion" | "video_audio" | "video_temporal">;
const CLAIM_ISSUE_MAP: Record<DetectedClaimType, ValidationIssueCode> = {
  material: "UNSUPPORTED_MATERIAL_CLAIM",
  brand: "UNSUPPORTED_BRAND_CLAIM",
  price: "UNSUPPORTED_PRICE_CLAIM",
  availability: "UNSUPPORTED_AVAILABILITY_CLAIM",
  efficacy: "UNSUPPORTED_EFFICACY_CLAIM",
  numeric_commercial: "UNSUPPORTED_NUMERIC_CLAIM",
  video_motion: "UNSUPPORTED_VIDEO_COVER_INFERENCE",
  video_audio: "UNSUPPORTED_VIDEO_COVER_INFERENCE",
  video_temporal: "UNSUPPORTED_VIDEO_COVER_INFERENCE",
};

function escapeRegex(str: string): string {
  return str.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

interface WordSegment {
  segment: string;
  isWordLike?: boolean;
}

interface WordSegmenter {
  segment(input: string): Iterable<WordSegment>;
}

type WordSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "word" },
) => WordSegmenter;

function tokenizeWords(text: string): string[] {
  const normalized = text.normalize("NFC").toLowerCase();
  const Segmenter = (Intl as unknown as { Segmenter?: WordSegmenterConstructor }).Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: "word" }).segment(normalized))
      .filter(item => item.isWordLike)
      .map(item => item.segment);
  }
  return normalized.match(/[\p{L}\p{N}]+/gu) || [];
}

function countTokenSequence(textTokens: string[], phraseTokens: string[]): number {
  if (phraseTokens.length === 0 || textTokens.length === 0) return 0;
  if (phraseTokens.length > textTokens.length) return 0;

  let count = 0;
  for (let i = 0; i <= textTokens.length - phraseTokens.length; ) {
    let match = true;
    for (let k = 0; k < phraseTokens.length; k++) {
      if (textTokens[i + k] !== phraseTokens[k]) {
        match = false;
        break;
      }
    }
    if (match) {
      count++;
      i += phraseTokens.length;
    } else {
      i++;
    }
  }
  return count;
}

function countOccurrences(text: string, phrase: string): number {
  if (!phrase.trim()) return 0;
  return countTokenSequence(tokenizeWords(text), tokenizeWords(phrase));
}

export function containsTokenPhrase(text: string, phrase: string): boolean {
  return countTokenSequence(tokenizeWords(text), tokenizeWords(phrase)) > 0;
}

function checkConsecutiveStuffing(
  text: string,
  field: "title" | "description",
  issues: ValidationIssue[],
) {
  const tokens = tokenizeWords(text);
  for (let i = 0; i < tokens.length - 2; i++) {
    const w1 = tokens[i].toLowerCase();
    const w2 = tokens[i + 1].toLowerCase();
    const w3 = tokens[i + 2].toLowerCase();
    if (w1 === w2 && w2 === w3 && !STOPWORDS.has(w1)) {
      issues.push({
        code: "CONSECUTIVE_WORD_STUFFING",
        field,
        message: `Word "${tokens[i]}" is repeated 3 or more times consecutively`,
      });
      break;
    }
  }
}

function getEligibleFacts(factCard: FactCardV1, claimType: CommercialDetectedClaimType): FactItem[] {
  return factCard.facts.filter(
    f =>
      f.claimPolicy === "copy_allowed" &&
      (f.trustLevel === "verified" || f.trustLevel === "asserted") &&
      f.source !== "image_observed" &&
      f.source !== "ai_inferred" &&
      f.category === claimType &&
      f.claimPolarity === "affirmed" &&
      Boolean(f.canonicalClaim?.trim()),
  );
}

function tokenSequenceStarts(textTokens: string[], phraseTokens: string[]): number[] {
  if (phraseTokens.length === 0 || phraseTokens.length > textTokens.length) return [];
  const starts: number[] = [];
  for (let i = 0; i <= textTokens.length - phraseTokens.length; i++) {
    if (phraseTokens.every((token, offset) => textTokens[i + offset] === token)) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * A defensive bare-material trap is allowed only when every occurrence is
 * covered by the full, affirmed canonical material phrase. This lets accurate
 * qualified wording such as "faux leather" pass while still rejecting an
 * additional bare "leather" claim elsewhere in the same field.
 */
function hasUncoveredMaterialTrap(
  text: string,
  trap: string,
  factCard: FactCardV1,
): boolean {
  const textTokens = tokenizeWords(text);
  const trapTokens = tokenizeWords(trap);
  const trapStarts = tokenSequenceStarts(textTokens, trapTokens);
  if (trapStarts.length === 0) return false;

  const covered = new Array<boolean>(textTokens.length).fill(false);
  for (const fact of getEligibleFacts(factCard, "material")) {
    const canonicalTokens = tokenizeWords(fact.canonicalClaim!);
    for (const start of tokenSequenceStarts(textTokens, canonicalTokens)) {
      for (let i = start; i < start + canonicalTokens.length; i++) covered[i] = true;
    }
  }

  return trapStarts.some(start =>
    trapTokens.some((_token, offset) => !covered[start + offset]) &&
    !sellerTextCoversMaterialAt(textTokens, start, trapTokens.length, factCard),
  );
}

// ── Seller-text evidence (P1 0925) ─────────────────────────────────────────────
//
// Product-page text and the merchant's own typed product name / selling points are
// the SELLER's asserted statements. They arrive as free-text `general` facts with no
// canonicalClaim, so before this path no claim copied from them — not even a
// verbatim "Amazon Music, Apple Music, Spotify" — could ever be grounded (Preview:
// 7/7 Amazon generations 422). A claim is grounded by seller text only when:
//  - the fact is user_input / product_catalog / page_metadata, trust verified or
//    asserted, copy_allowed, category general (never image_observed / ai_inferred /
//    board_context; commercially-categorised facts keep the canonicalClaim rule);
//  - the claim's tokens appear CONTIGUOUSLY inside one sentence of that text
//    (no fuzzy/paraphrase matching);
//  - that sentence carries no negation cue in any supported language (fail closed:
//    "not in the business of selling", "sin", "不是" ground nothing);
//  - material only: the matched span is not glued to a qualifier on either side
//    ("faux leather", "PU leather", "gold tone", "silk-like", "leather-free").
// Price, availability and therapeutic efficacy are never grounded this way.

const SELLER_TEXT_SOURCES = new Set<FactItem["source"]>(["user_input", "product_catalog", "page_metadata"]);

const NEGATION_TOKENS = new Set<string>([
  // en
  "not", "no", "never", "without", "neither", "nor", "none", "cannot", "non",
  // es / pt / it / fr / de / nl
  "sin", "nunca", "ni", "tampoco", "ningún", "ninguna", "ninguno",
  "não", "nao", "sem", "nem", "nenhum", "nenhuma",
  "senza", "mai", "nessun", "nessuno", "nessuna",
  "ne", "pas", "sans", "jamais", "aucun", "aucune",
  "nicht", "kein", "keine", "keinen", "keinem", "keiner", "ohne", "nie", "niemals",
  "niet", "geen", "zonder", "nooit",
]);
// Scripts without spaces: any negation morpheme in the sentence fails it closed
// (this also rejects e.g. 不锈钢 — acceptable: fail closed, never open).
const CJK_NEGATION_RE = /[不没沒無无非未]|ない|なし|ません|않|없|아니/u;

/** Words that turn a preceding bare material into a different/weaker material. */
const MATERIAL_TRAILING_QUALIFIERS = new Set<string>([
  "tone", "toned", "plated", "plating", "coated", "coating", "filled", "like", "look", "looking",
  "effect", "finish", "style", "styled", "blend", "blended", "imitation", "print", "printed",
  "free", "color", "colored", "colour", "coloured", "inspired", "alternative", "substitute", "pattern",
]);

/** Words that may directly precede a material without qualifying it ("made of silk"). */
const MATERIAL_LEADING_CONNECTORS = new Set<string>([
  "of", "made", "crafted", "constructed", "woven", "knit", "knitted", "using", "featuring", "features", "real", "genuine", "solid", "pure",
]);

type SegToken = { text: string; sepBefore: string };

function segmentTokens(text: string): { tokens: SegToken[]; trailing: string } {
  const normalized = text.normalize("NFC").toLowerCase();
  const tokens: SegToken[] = [];
  let sep = "";
  const Segmenter = (Intl as unknown as { Segmenter?: WordSegmenterConstructor }).Segmenter;
  if (Segmenter) {
    for (const item of new Segmenter(undefined, { granularity: "word" }).segment(normalized)) {
      if (item.isWordLike) { tokens.push({ text: item.segment, sepBefore: sep }); sep = ""; }
      else sep += item.segment;
    }
    return { tokens, trailing: sep };
  }
  const re = /[\p{L}\p{N}]+/gu;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) {
    tokens.push({ text: m[0], sepBefore: normalized.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  return { tokens, trailing: normalized.slice(last) };
}

/** Sentence-level clauses: bullets/lines, then sentence ends before a capital, and ; */
function sellerClauses(value: string): string[] {
  return value
    .split(/\r?\n/)
    .flatMap(line => line.split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}"“(])|[;；。！？]/u))
    .map(s => s.trim())
    .filter(Boolean);
}

function clauseIsNegated(clause: string, tokens: SegToken[]): boolean {
  if (CJK_NEGATION_RE.test(clause)) return true;
  return tokens.some(t => NEGATION_TOKENS.has(t.text) || /n['’]t$/.test(t.text));
}

/** "leather-free", "silk-like": a hyphen with no surrounding space glues two words. */
function isHyphenJoin(sep: string): boolean {
  return /^[-‐‑]+$/u.test(sep);
}
/** Punctuation between words ("leather, suede", "Charcoal – Play") is a real boundary. */
function isHardBoundary(sep: string): boolean {
  return /\S/u.test(sep) && !isHyphenJoin(sep);
}

interface SellerClause { clause: string; tokens: SegToken[]; trailing: string }

function sellerTextClauses(factCard: FactCardV1): SellerClause[] {
  const out: SellerClause[] = [];
  for (const fact of factCard.facts) {
    if (!SELLER_TEXT_SOURCES.has(fact.source)) continue;
    if (fact.trustLevel !== "verified" && fact.trustLevel !== "asserted") continue;
    if (fact.claimPolicy !== "copy_allowed") continue;
    if (fact.category && fact.category !== "general") continue;
    for (const clause of sellerClauses(fact.value)) {
      const { tokens, trailing } = segmentTokens(clause);
      if (tokens.length === 0 || clauseIsNegated(clause, tokens)) continue;
      out.push({ clause, tokens, trailing });
    }
  }
  return out;
}

function materialFlanksOk(c: SellerClause, start: number, length: number): boolean {
  const first = c.tokens[start];
  if (start > 0) {
    const prev = c.tokens[start - 1];
    if (isHyphenJoin(first.sepBefore)) return false;
    if (!isHardBoundary(first.sepBefore) && !STOPWORDS.has(prev.text) && !MATERIAL_LEADING_CONNECTORS.has(prev.text)) return false;
  }
  const endIdx = start + length;
  if (endIdx < c.tokens.length) {
    const next = c.tokens[endIdx];
    if (isHyphenJoin(next.sepBefore)) return false;
    if (!isHardBoundary(next.sepBefore) && MATERIAL_TRAILING_QUALIFIERS.has(next.text)) return false;
  }
  return true;
}

function sellerTextSupports(phraseTokens: string[], factCard: FactCardV1, material: boolean): boolean {
  if (phraseTokens.length === 0) return false;
  for (const c of sellerTextClauses(factCard)) {
    const texts = c.tokens.map(t => t.text);
    for (const start of tokenSequenceStarts(texts, phraseTokens)) {
      if (!material || materialFlanksOk(c, start, phraseTokens.length)) return true;
    }
  }
  return false;
}

/** Brand lists ("Amazon Music, Spotify, Apple Music") are one brand claim per item. */
function brandListItems(value: string): string[][] {
  return value
    .split(/,|\/|&|、|和|及|\band\b|\bor\b/iu)
    .map(part => tokenizeWords(part).filter(t => !STOPWORDS.has(t)))
    .filter(tokens => tokens.length > 0);
}

const THERAPEUTIC_RE =
  /\b(?:clinically proven|cure[sd]?|curing|heal[sd]?|healing|treat[sd]?|treating|treatment|migraine[s]?|chronic anxiety|anxiety relief|pain relief|therapeutic|anti-inflammatory)\b/i;

function supportedBySellerText(type: CommercialDetectedClaimType, claimValue: string, factCard: FactCardV1): boolean {
  switch (type) {
    case "brand": {
      const items = brandListItems(claimValue);
      return items.length > 0 && items.every(item => sellerTextSupports(item, factCard, false));
    }
    case "numeric_commercial":
      return sellerTextSupports(tokenizeWords(claimValue), factCard, false);
    case "material":
      return sellerTextSupports(tokenizeWords(claimValue), factCard, true);
    case "efficacy":
      if (THERAPEUTIC_RE.test(claimValue)) return false;
      return sellerTextSupports(tokenizeWords(claimValue), factCard, false);
    case "price":
    case "availability":
      return false;
  }
}

/**
 * A bare trap-material occurrence in the copy is covered by seller text when some
 * copy window around it (up to 3 tokens either side) is itself a flank-clean seller
 * material phrase: copy "Genuine Leather Sleeve" + page "Made of genuine leather."
 */
function sellerTextCoversMaterialAt(
  textTokens: string[],
  start: number,
  length: number,
  factCard: FactCardV1,
): boolean {
  for (let a = Math.max(0, start - 3); a <= start; a++) {
    for (let b = start + length; b <= Math.min(textTokens.length, start + length + 3); b++) {
      if (sellerTextSupports(textTokens.slice(a, b), factCard, true)) return true;
    }
  }
  return false;
}

function supportsMaterialClaim(canonicalClaim: string, claimValue: string): boolean {
  const canonical = canonicalClaim.normalize("NFC").toLowerCase().trim();
  const claim = claimValue.normalize("NFC").toLowerCase().trim();
  const canonicalTokens = tokenizeWords(canonical);
  const claimTokens = tokenizeWords(claim);

  if (canonicalTokens.length === 0 || claimTokens.length === 0) return false;
  if (canonical === claim) return true;

  const isSilverPurityAlias =
    claimTokens.includes("silver") &&
    (claimTokens.includes("925") || claimTokens.includes("sterling")) &&
    canonicalTokens.includes("silver") &&
    (canonicalTokens.includes("925") || canonicalTokens.includes("sterling"));
  if (isSilverPurityAlias) return true;

  const isPureSilkAlias =
    claimTokens.includes("silk") &&
    (claimTokens.includes("pure") || claimTokens.includes("100") || claimTokens.length === 1) &&
    canonicalTokens.includes("silk") &&
    (canonicalTokens.includes("pure") || canonicalTokens.includes("100") || canonicalTokens.includes("mulberry"));
  if (isPureSilkAlias) return true;

  // Never infer a stronger bare material by dropping unknown qualifiers from
  // an open-ended phrase (for example PU leather, gold tone, or coated gold).
  // New safe equivalences must be added above as explicit, reviewed rules.
  return false;
}

type NormalizedPrice = { amount: string; currency: string };

/**
 * Price grounding needs both an amount and a currency. Token comparison would
 * otherwise treat `USD 20` and `€20` as the same bare number. This deliberately
 * accepts only a standalone, recognizable commercial price; ambiguous source
 * text cannot authorize price copy.
 */
function normalizePriceClaim(value: string): NormalizedPrice | null {
  const normalized = value.normalize("NFC").trim().toUpperCase();
  const match = /^(USD|US\$|\$|EUR|€|GBP|£|JPY|¥|￥|CAD|C\$|AUD|A\$)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)$/.exec(normalized);
  if (!match) return null;

  const currencyAliases: Record<string, string> = {
    USD: "USD", "US$": "USD", "$": "USD",
    EUR: "EUR", "€": "EUR",
    GBP: "GBP", "£": "GBP",
    JPY: "JPY", "¥": "JPY", "￥": "JPY",
    CAD: "CAD", "C$": "CAD",
    AUD: "AUD", "A$": "AUD",
  };
  const numericAmount = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(numericAmount) || numericAmount < 0) return null;
  return { currency: currencyAliases[match[1]], amount: String(numericAmount) };
}

/**
 * Checks whether a commercial claim is grounded in copy-allowed facts.
 */
function isClaimSupported(
  type: CommercialDetectedClaimType,
  claimValue: string,
  factCard: FactCardV1,
): boolean {
  const eligibleFacts = getEligibleFacts(factCard, type);
  const val = claimValue.normalize("NFC").toLowerCase().trim();
  if (!val) return true;
  if (isCanonicallySupported(type, claimValue, val, eligibleFacts)) return true;
  return supportedBySellerText(type, claimValue, factCard);
}

function isCanonicallySupported(
  type: CommercialDetectedClaimType,
  claimValue: string,
  val: string,
  eligibleFacts: FactItem[],
): boolean {

  switch (type) {
    case "material": {
      return eligibleFacts.some(f => supportsMaterialClaim(f.canonicalClaim!, val));
    }

    case "efficacy": {
      // Efficacy claims are not safely extensible: a grounded "pain relief" fact
      // cannot authorize timing, degree, clinical, or other stronger assertions.
      return eligibleFacts.some(f => f.canonicalClaim!.normalize("NFC").toLowerCase().trim() === val);
    }

    case "price": {
      const detectedPrice = normalizePriceClaim(claimValue);
      if (!detectedPrice) return false;
      return eligibleFacts.some(f => {
        const catalogPrice = normalizePriceClaim(f.canonicalClaim!);
        return catalogPrice?.currency === detectedPrice.currency && catalogPrice.amount === detectedPrice.amount;
      });
    }

    case "availability": {
      return eligibleFacts.some(f => f.claimPolarity === "affirmed" && f.canonicalClaim!.normalize("NFC").toLowerCase().trim() === val);
    }

    case "brand": {
      return eligibleFacts.some(f => containsTokenPhrase(f.canonicalClaim!, val));
    }

    case "numeric_commercial": {
      return eligibleFacts.some(f => containsTokenPhrase(f.canonicalClaim!, val));
    }
  }
}

export function validateCopy(input: ValidateCopyInput): ValidationReport {
  const { title, description, altText, factCard, keywords, claimDetection } = input;
  const descriptionMax = input.descriptionMax ?? DEFAULT_DESCRIPTION_MAX;
  const issues: ValidationIssue[] = [];
  const detectedClaims: DetectedClaim[] = claimDetection?.status === "completed"
    ? claimDetection.claims
    : [];

  if (claimDetection?.status !== "completed") {
    issues.push({
      code: "CLAIM_DETECTION_INCOMPLETE",
      field: "general",
      message: "Commercial claim detection must complete before copy can be accepted",
    });
  }

  if (!title.trim()) {
    issues.push({ code: "TITLE_REQUIRED", field: "title", message: "Title is required" });
  }
  if (!description.trim()) {
    issues.push({ code: "DESCRIPTION_REQUIRED", field: "description", message: "Description is required" });
  }
  if (!altText?.trim()) {
    issues.push({ code: "ALT_TEXT_REQUIRED", field: "altText", message: "Alt text is required" });
  }

  // 1. Hard Platform Character Limits
  if (title.length > 100) {
    issues.push({
      code: "TITLE_TOO_LONG",
      field: "title",
      message: `Title length (${title.length}) exceeds maximum of 100 characters`,
    });
  }
  if (description.length > descriptionMax) {
    issues.push({
      code: "DESCRIPTION_TOO_LONG",
      field: "description",
      message: `Description length (${description.length}) exceeds maximum of ${descriptionMax} characters`,
    });
  }

  // 2. Exact Keyword Frequency Limits
  if (keywords?.length) {
    for (const kw of keywords) {
      const trimmed = kw.trim();
      if (!trimmed) continue;
      const titleCount = countOccurrences(title, trimmed);
      if (titleCount > 1) {
        issues.push({
          code: "KEYWORD_FREQUENCY_TITLE",
          field: "title",
          message: `Keyword "${trimmed}" appears ${titleCount} times in title (maximum 1 allowed)`,
        });
      }
      const descCount = countOccurrences(description, trimmed);
      if (descCount > 2) {
        issues.push({
          code: "KEYWORD_FREQUENCY_DESCRIPTION",
          field: "description",
          message: `Keyword "${trimmed}" appears ${descCount} times in description (maximum 2 allowed)`,
        });
      }
    }
  }

  // 3. Consecutive Non-Stopword Stuffing
  checkConsecutiveStuffing(title, "title", issues);
  checkConsecutiveStuffing(description, "description", issues);

  const fieldsToCheck: Array<{ field: "title" | "description" | "altText"; text: string }> = [
    { field: "title", text: title },
    { field: "description", text: description },
  ];
  if (altText) {
    fieldsToCheck.push({ field: "altText", text: altText });
  }

  // 4. Blocked Facts
  for (const fact of factCard.facts) {
    if (fact.claimPolicy === "blocked") {
      const valLower = fact.value.normalize("NFC").toLowerCase().trim();
      if (!valLower) continue;
      for (const target of fieldsToCheck) {
        if (target.text.normalize("NFC").toLowerCase().includes(valLower)) {
          issues.push({
            code: "BLOCKED_FACT_USED",
            field: target.field,
            message: `Copy contains blocked fact: "${fact.value}"`,
            details: { factId: fact.id, factKey: fact.key },
          });
        }
      }
    }
  }

  // 5. Descriptive-Only Violations
  for (const fact of factCard.facts) {
    if (fact.claimPolicy === "descriptive_only") {
      const valLower = fact.value.toLowerCase().trim();
      if (!valLower) continue;

      if (title.toLowerCase().includes(valLower)) {
        issues.push({
          code: "DESCRIPTIVE_ONLY_VIOLATION",
          field: "title",
          message: `Descriptive-only fact "${fact.value}" cannot be used in product title`,
        });
      }

      const productClaimPattern = new RegExp(
        `(?:made of|crafted from|material of|authentic)\\s+(?:[\\w\\s]+)?${escapeRegex(valLower)}|${escapeRegex(valLower)}\\s+material`,
        "i",
      );
      if (productClaimPattern.test(description)) {
        issues.push({
          code: "DESCRIPTIVE_ONLY_VIOLATION",
          field: "description",
          message: `Descriptive-only fact "${fact.value}" cannot be claimed as product feature or material`,
        });
      }
    }
  }

  // 6. Deterministic Trap: Materials (defense-in-depth)
  for (const target of fieldsToCheck) {
    for (const mat of TRAP_MATERIALS) {
      if (
        hasUncoveredMaterialTrap(target.text, mat, factCard) &&
        !isClaimSupported("material", mat, factCard)
      ) {
        issues.push({
          code: "UNSUPPORTED_MATERIAL_CLAIM",
          field: target.field,
          message: `Unsupported material claim: "${mat}"`,
        });
      }
    }
  }

  // 7. Deterministic Trap: Efficacy / Therapeutic Claims (defense-in-depth)
  const efficacyRegex =
    /\b(?:clinically proven|cure[sd]?|curing|heal[sd]?|healing|treat[sd]?|treating|treatment|migraine[s]?|chronic anxiety|anxiety relief|pain relief|therapeutic|anti-inflammatory)\b/gi;
  for (const target of fieldsToCheck) {
    const matches = target.text.match(efficacyRegex) || [];
    if (matches.length > 0) {
      const hasUnsupported = matches.some(m => !isClaimSupported("efficacy", m, factCard));
      if (hasUnsupported) {
        issues.push({
          code: "UNSUPPORTED_EFFICACY_CLAIM",
          field: target.field,
          message: "Unsupported efficacy or therapeutic claim",
        });
      }
    }
  }

  // 8, 9, 11. Deterministic Traps: Price, Availability, Numeric Commercial (defense-in-depth)
  const regexTraps: { type: CommercialDetectedClaimType; regex: RegExp; code: ValidationIssueCode }[] = [
    {
      type: "price",
      regex: /\$\d+(?:\.\d{2})?|\b(?:\d+%\s*off|free shipping|half price|on sale|discount)\b/gi,
      code: "UNSUPPORTED_PRICE_CLAIM",
    },
    {
      type: "availability",
      regex: /\b(?:\d+\s+left in stock|ready to ship|ships immediately|ships today|in stock|out of stock|back in stock|limited stock)\b/gi,
      code: "UNSUPPORTED_AVAILABILITY_CLAIM",
    },
    {
      type: "numeric_commercial",
      regex: /\b\d+[ -]pack\b|\b(?:lifetime|\d+[ -](?:year|month|day))\s+(?:warranty|guarantee)\b|\bholds up to \d+\s*(?:lbs|pounds|kg|oz|g)\b|\b\d+[ -]day money[ -]back\b/gi,
      code: "UNSUPPORTED_NUMERIC_CLAIM",
    },
  ];

  for (const target of fieldsToCheck) {
    for (const { type, regex, code } of regexTraps) {
      const matches = Array.from(new Set(target.text.match(regex) || []));
      for (const m of matches) {
        if (!isClaimSupported(type, m, factCard)) {
          issues.push({
            code,
            field: target.field,
            message: `Unsupported ${type} claim: "${m}"`,
          });
        }
      }
    }
  }

  // 10. Deterministic Trap: Brand Claims (defense-in-depth)
  for (const target of fieldsToCheck) {
    for (const brand of TRAP_BRANDS) {
      const brandRegex = new RegExp(`\\b${escapeRegex(brand)}\\b`, "i");
      if (brandRegex.test(target.text)) {
        if (!isClaimSupported("brand", brand, factCard)) {
          issues.push({
            code: "UNSUPPORTED_BRAND_CLAIM",
            field: target.field,
            message: `Unsupported brand claim: "${brand}"`,
          });
        }
      }
    }
  }

  // 12. Arbitrary Provider-Detected Commercial Claims (supplied by route orchestration)
  if (detectedClaims.length) {
    for (const claim of detectedClaims) {
      const videoInference = claim.type === "video_motion" || claim.type === "video_audio" || claim.type === "video_temporal";
      const unsupported = videoInference
        ? factCard.mediaEvidence?.mode === "video_cover"
        : !isClaimSupported(claim.type as CommercialDetectedClaimType, claim.value, factCard);
      if (unsupported) {
        let field = claim.field;
        if (!field) {
          const normClaimVal = claim.value.normalize("NFC").toLowerCase();
          for (const target of fieldsToCheck) {
            if (target.text.normalize("NFC").toLowerCase().includes(normClaimVal)) {
              field = target.field;
              break;
            }
          }
          if (!field) {
            field = "description";
          }
        }
        issues.push({
          code: CLAIM_ISSUE_MAP[claim.type],
          field,
          message: `Unsupported ${claim.type} claim: "${claim.value}"`,
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
