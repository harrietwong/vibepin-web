/**
 * keywordEvidence.ts   AI Copy v2 Keyword Evidence Adapter.
 *
 * Grounding & Provenance Rules:
 *  - trend_keywords is the SOLE demand provenance source.
 *  - User, product, page, image, and board context are relevance evidence ONLY.
 *  - Provenance honesty: only exact data_quality="official" maps to "official".
 *    Scored/derived non-official data maps to "estimated". Missing or unusable
 *    quality metadata maps to "unknown".
 *  - Never exposes internal normalizedVolume or finalScore as user-facing scores.
 *  - Selects at most 5 keyword IDs for model input; copy is never required to use all.
 *  - Non-English requests reject unlabelled English keyword banks; matching labelled
 *    non-English rows are eligible.
 *  - Returns degradedMode="no_keyword_demand_data" when no reliable selected keywords remain.
 */

import { createHash } from "node:crypto";
import { normalizeWords } from "@/lib/keyword-data/mapTrendKeywordRow";
import {
  rankKeywords,
  isTooGeneric,
  type KeywordRow,
  type KeywordContextInput,
} from "../keywordContext";
import type {
  KeywordEvidence,
  KeywordCandidate,
  KeywordProvenance,
  RelevanceEvidenceEntry,
  RelevanceEvidenceSource,
  DegradedMode,
} from "./types";

export type KeywordRejectionCode =
  | "locale_mismatch"
  | "unreliable_provenance"
  | "low_relevance"
  | "low_coverage"
  | "too_generic"
  | "not_selected";

export interface KeywordEvidenceAdapterInput {
  rows: KeywordRow[];
  context: KeywordContextInput;
  sessionId?: string;
  draftId?: string;
  keywordSetId?: string;
  targetLocale?: string;
  userInput?: string;
  pageMetadata?: {
    title?: string;
    description?: string;
  };
}

/**
 * Resolves honest demand provenance:
 * - Only exact `data_quality === "official"` is "official".
 * - Scored/derived signals without official quality are "estimated".
 * - Missing or explicitly unknown quality is "unknown".
 */
export function resolveKeywordProvenance(row: KeywordRow): KeywordProvenance {
  if (row.data_quality === "official") {
    return "official";
  }

  if (row.data_quality === "estimated" || row.data_quality === "derived") {
    return "estimated";
  }

  const hasScoredSignal =
    (row.volume_score != null && row.volume_score > 0) ||
    Boolean(row.volume_signal && row.volume_signal !== "" && row.volume_signal !== "unscored") ||
    Boolean(row.search_volume_level && row.search_volume_level !== "" && row.search_volume_level !== "unscored") ||
    (row.priority_score != null && row.priority_score > 0);

  if (hasScoredSignal && row.data_quality !== "unknown") {
    return "estimated";
  }

  return "unknown";
}

function normalizeLanguageTag(lang?: string | null): string {
  if (!lang) return "";
  const cleaned = lang.trim().toLowerCase();
  if (cleaned.startsWith("en")) return "en";
  if (cleaned.startsWith("es") || cleaned === "spanish") return "es";
  if (cleaned.startsWith("fr") || cleaned === "french") return "fr";
  if (cleaned.startsWith("de") || cleaned === "german") return "de";
  if (cleaned.startsWith("zh") || cleaned === "chinese") return "zh";
  if (cleaned.startsWith("it") || cleaned === "italian") return "it";
  if (cleaned.startsWith("pt") || cleaned === "portuguese") return "pt";
  if (cleaned.startsWith("ja") || cleaned === "japanese") return "ja";
  if (cleaned.startsWith("ko") || cleaned === "korean") return "ko";
  return cleaned.split(/[-_]/)[0];
}

function getRowLanguage(row: KeywordRow): string | null {
  if (row.language) return normalizeLanguageTag(row.language);
  if (row.locale) return normalizeLanguageTag(row.locale);
  return null;
}

export function isLocaleEligible(
  row: KeywordRow,
  targetLocale?: string
): { eligible: boolean; rejectionCode?: KeywordRejectionCode } {
  const targetTag = normalizeLanguageTag(targetLocale) || "en";
  const rowTag = getRowLanguage(row);

  if (targetTag === "en") {
    // English requests remain backward-compatible with unlabelled keyword rows
    if (rowTag === null || rowTag === "en") {
      return { eligible: true };
    }
    return { eligible: false, rejectionCode: "locale_mismatch" };
  }

  // Non-English requests must never use unlabelled English keyword bank
  if (rowTag === null || rowTag === "en" || rowTag !== targetTag) {
    return { eligible: false, rejectionCode: "locale_mismatch" };
  }

  return { eligible: true };
}

function extractRelevanceEvidence(
  phrase: string,
  context: KeywordContextInput,
  options?: {
    userInput?: string;
    pageMetadata?: { title?: string; description?: string };
  }
): RelevanceEvidenceEntry[] {
  const entries: RelevanceEvidenceEntry[] = [];
  const phraseWords = normalizeWords(phrase);
  if (!phraseWords.length) return entries;

  const checkSource = (source: RelevanceEvidenceSource, text: string) => {
    if (!text.trim()) return;
    const sourceWordSet = new Set(normalizeWords(text));
    if (!sourceWordSet.size) return;
    const matched = phraseWords.filter(w => sourceWordSet.has(w));
    if (matched.length > 0) {
      entries.push({
        source,
        matchedText: matched.join(" "),
      });
    }
  };

  // 1. image_observed
  const imageText = [
    context.imageSummary ?? "",
    ...(context.visibleObjects ?? []),
    context.style ?? "",
  ].join(" ");
  checkSource("image_observed", imageText);

  // 2. board_context
  checkSource("board_context", context.boardName ?? "");

  // 3. product_catalog
  const productText = [
    context.productTitle ?? "",
    context.productType ?? "",
    ...(context.productTags ?? []),
  ].join(" ");
  checkSource("product_catalog", productText);

  // 4. user_input
  const userText = [
    options?.userInput ?? "",
    context.directionTitle ?? "",
    ...(context.directionTerms ?? []),
  ].join(" ");
  checkSource("user_input", userText);

  // 5. page_metadata
  const pageText = [
    options?.pageMetadata?.title ?? "",
    options?.pageMetadata?.description ?? "",
  ].join(" ");
  checkSource("page_metadata", pageText);

  return entries;
}

function deriveDeterministicKeywordSetId(
  input: KeywordEvidenceAdapterInput,
  selectedKeywordIds: string[]
): string {
  if (input.keywordSetId) {
    return input.keywordSetId;
  }
  const payload = [
    input.draftId ?? "",
    input.sessionId ?? "",
    input.context.imageSummary ?? "",
    input.context.boardName ?? "",
    ...selectedKeywordIds,
  ].join("|");
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return `kwset_${hash}`;
}

/**
 * Converts trend_keywords rows + KeywordContextInput into KeywordEvidence.
 *
 * Supports both:
 *  - buildKeywordEvidence(adapterInput)
 *  - buildKeywordEvidence(rows, context, options)
 */
export function buildKeywordEvidence(
  rowsOrInput: KeywordRow[] | KeywordEvidenceAdapterInput,
  maybeContext?: KeywordContextInput,
  maybeOptions?: {
    sessionId?: string;
    draftId?: string;
    keywordSetId?: string;
    targetLocale?: string;
    userInput?: string;
    pageMetadata?: { title?: string; description?: string };
  }
): KeywordEvidence {
  const adapterInput: KeywordEvidenceAdapterInput = Array.isArray(rowsOrInput)
    ? {
        rows: rowsOrInput,
        context: maybeContext!,
        sessionId: maybeOptions?.sessionId,
        draftId: maybeOptions?.draftId,
        keywordSetId: maybeOptions?.keywordSetId,
        targetLocale: maybeOptions?.targetLocale,
        userInput: maybeOptions?.userInput,
        pageMetadata: maybeOptions?.pageMetadata,
      }
    : rowsOrInput;

  const { rows, context } = adapterInput;
  const targetLocale = adapterInput.targetLocale ?? context.language ?? "en";

  // Fast path for empty rows
  if (!rows || rows.length === 0) {
    return {
      keywordSetId: deriveDeterministicKeywordSetId(adapterInput, []),
      ...(adapterInput.sessionId ? { sessionId: adapterInput.sessionId } : {}),
      ...(adapterInput.draftId ? { draftId: adapterInput.draftId } : {}),
      candidates: [],
      selectedKeywordIds: [],
      degradedMode: "no_keyword_demand_data",
    };
  }

  // Pre-process candidates from input rows (preserving stable row IDs)
  interface CandidateState {
    candidate: KeywordCandidate;
    row: KeywordRow;
    localeEligible: boolean;
    normPhrase: string;
  }

  const seenIds = new Set<string>();
  const states: CandidateState[] = [];
  const eligibleRows: KeywordRow[] = [];

  for (const row of rows) {
    const phrase = (row.keyword ?? "").trim();
    if (!phrase) continue;

    let candidateId = row.id?.trim();
    if (!candidateId) {
      const slug = normalizeWords(phrase).join("_");
      candidateId = `kw_${slug}`;
    }
    // Ensure candidate IDs are unique in the collection
    let uniqueId = candidateId;
    let dupCounter = 1;
    while (seenIds.has(uniqueId)) {
      uniqueId = `${candidateId}_${dupCounter++}`;
    }
    seenIds.add(uniqueId);

    const provenance = resolveKeywordProvenance(row);
    const relevanceEvidence = extractRelevanceEvidence(phrase, context, {
      userInput: adapterInput.userInput,
      pageMetadata: adapterInput.pageMetadata,
    });

    const localeCheck = isLocaleEligible(row, targetLocale);

    const candidate: KeywordCandidate = {
      id: uniqueId,
      phrase,
      ...(row.locale || row.language ? { locale: row.locale ?? row.language ?? undefined } : {}),
      ...(row.country || row.region ? { country: row.country ?? row.region ?? undefined } : {}),
      provenance,
      relevanceEvidence,
      status: "rejected", // default until acceptance/selection
      ...(localeCheck.rejectionCode ? { rejectionCode: localeCheck.rejectionCode } : {}),
    };

    const normPhrase = phrase.toLowerCase();
    states.push({
      candidate,
      row,
      localeEligible: localeCheck.eligible,
      normPhrase,
    });

    if (localeCheck.eligible) {
      eligibleRows.push(row);
    }
  }

  // If no locale-eligible rows exist, return early in degraded mode
  if (eligibleRows.length === 0) {
    const candidates = states.map(s => s.candidate);
    return {
      keywordSetId: deriveDeterministicKeywordSetId(adapterInput, []),
      ...(adapterInput.sessionId ? { sessionId: adapterInput.sessionId } : {}),
      ...(adapterInput.draftId ? { draftId: adapterInput.draftId } : {}),
      candidates,
      selectedKeywordIds: [],
      degradedMode: "no_keyword_demand_data",
    };
  }

  // Execute existing versioned ranking heuristics on eligible rows
  const rankResult = rankKeywords(eligibleRows, context);

  // Map raw rejection reasons from rankKeywords
  const rankRejectedMap = new Map<string, string>();
  for (const r of rankResult.rejected) {
    rankRejectedMap.set(r.keyword.toLowerCase(), r.reason);
  }

  const mapRejectionReason = (reason?: string, phrase?: string): KeywordRejectionCode => {
    if (!reason) {
      if (phrase && isTooGeneric(phrase)) return "too_generic";
      return "not_selected";
    }
    if (reason === "too_generic") return "too_generic";
    if (reason.startsWith("low_coverage")) return "low_coverage";
    if (reason.startsWith("low_relevance") || reason.startsWith("below_recommend_floor")) {
      return "low_relevance";
    }
    return "low_relevance";
  };

  // Select at most 5 keywords from recommended
  const selectedKeywordIds: string[] = [];
  const acceptedCandidateIds = new Set<string>();

  for (const recKeyword of rankResult.recommended) {
    if (selectedKeywordIds.length >= 5) break;
    const norm = recKeyword.toLowerCase();
    const matchingState = states.find(
      s => s.localeEligible && s.normPhrase === norm && !acceptedCandidateIds.has(s.candidate.id)
    );
    if (!matchingState) continue;

    // Provenance honesty: only reliable demand keywords (official or estimated) may be selected
    if (matchingState.candidate.provenance === "unknown") {
      matchingState.candidate.status = "rejected";
      matchingState.candidate.rejectionCode = "unreliable_provenance";
      continue;
    }

    matchingState.candidate.status = "accepted";
    matchingState.candidate.rejectionCode = undefined;
    acceptedCandidateIds.add(matchingState.candidate.id);
    selectedKeywordIds.push(matchingState.candidate.id);
  }

  // Process remaining unaccepted candidates
  for (const s of states) {
    if (acceptedCandidateIds.has(s.candidate.id)) continue;

    s.candidate.status = "rejected";
    if (!s.localeEligible) {
      s.candidate.rejectionCode = "locale_mismatch";
      continue;
    }

    if (s.candidate.provenance === "unknown") {
      // If it failed relevance first, preserve low_relevance
      const rawReason = rankRejectedMap.get(s.normPhrase);
      if (rawReason && (rawReason.startsWith("low_relevance") || rawReason.startsWith("below_recommend_floor"))) {
        s.candidate.rejectionCode = "low_relevance";
      } else if (rawReason && rawReason.startsWith("low_coverage")) {
        s.candidate.rejectionCode = "low_coverage";
      } else if (rawReason === "too_generic" || isTooGeneric(s.candidate.phrase)) {
        s.candidate.rejectionCode = "too_generic";
      } else {
        s.candidate.rejectionCode = "unreliable_provenance";
      }
      continue;
    }

    const rawReason = rankRejectedMap.get(s.normPhrase);
    if (rawReason) {
      s.candidate.rejectionCode = mapRejectionReason(rawReason, s.candidate.phrase);
    } else {
      // Scored / evaluated but either capped out of top 5 or not selected
      s.candidate.rejectionCode = "not_selected";
    }
  }

  const degradedMode: DegradedMode =
    selectedKeywordIds.length === 0 ? "no_keyword_demand_data" : "none";

  const keywordSetId = deriveDeterministicKeywordSetId(adapterInput, selectedKeywordIds);

  return {
    keywordSetId,
    ...(adapterInput.sessionId ? { sessionId: adapterInput.sessionId } : {}),
    ...(adapterInput.draftId ? { draftId: adapterInput.draftId } : {}),
    candidates: states.map(s => s.candidate),
    selectedKeywordIds,
    degradedMode,
  };
}
