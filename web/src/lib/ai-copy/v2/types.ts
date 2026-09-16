/**
 * AI Copy v2 Shared Types and Contracts.
 *
 * Freezes:
 *  - FactCardV1 and fact item models (sources, non-numeric trust levels, claim policies).
 *  - KeywordEvidence and candidate models (honest provenance, structured relevance, no volumeSignal).
 *  - ValidationReport and closed structured issue codes.
 *  - CopyResultV2 output contract (single title/description/altText, no clusterId, required fields).
 */

export type FactSource =
  | "user_input"
  | "product_catalog"
  | "page_metadata"
  | "image_observed"
  | "board_context"
  | "ai_inferred";

export type FactTrustLevel =
  | "verified"
  | "asserted"
  | "observed"
  | "inferred";

export type FactClaimPolicy =
  | "copy_allowed"
  | "descriptive_only"
  | "blocked";

/**
 * Structured polarity for a normalized commercial claim.
 *
 * `value` remains the human-readable source text. Commercial copy is only
 * supported by an explicit `canonicalClaim` whose polarity is `affirmed`;
 * validators must never infer affirmation from substrings in `value`.
 */
export type FactClaimPolarity = "affirmed" | "negated" | "unknown";

export type FactCategory =
  | "material"
  | "brand"
  | "price"
  | "availability"
  | "efficacy"
  | "numeric_commercial"
  | "visual_description"
  | "general";

export interface FactItem {
  id: string;
  key: string;
  value: string;
  source: FactSource;
  trustLevel: FactTrustLevel;
  claimPolicy: FactClaimPolicy;
  category?: FactCategory;
  canonicalClaim?: string;
  claimPolarity?: FactClaimPolarity;
}

export interface FactCardV1 {
  /** v2 is emitted only when serialized media-evidence metadata is present. */
  version: "fact-card-v1" | "fact-card-v2";
  sessionId: string;
  draftId: string;
  locale: string;
  facts: FactItem[];
  mediaEvidence?: {
    mode: "image" | "video_cover";
    degradedMode: "none" | "video_cover_unavailable";
  };
}

export type KeywordProvenance = "official" | "estimated" | "unknown";

export type RelevanceEvidenceSource =
  | "user_input"
  | "product_catalog"
  | "page_metadata"
  | "image_observed"
  | "board_context";

export interface RelevanceEvidenceEntry {
  source: RelevanceEvidenceSource;
  matchedText?: string;
  note?: string;
}

export interface KeywordCandidate {
  id: string;
  phrase: string;
  locale?: string;
  country?: string;
  provenance: KeywordProvenance;
  relevanceEvidence: RelevanceEvidenceEntry[];
  status: "accepted" | "rejected";
  rejectionCode?: string;
}

export type DegradedMode = "none" | "no_keyword_demand_data" | "video_cover_unavailable";

export interface KeywordEvidence {
  keywordSetId: string;
  sessionId?: string;
  draftId?: string;
  candidates: KeywordCandidate[];
  selectedKeywordIds: string[];
  degradedMode: DegradedMode;
}

export type ValidationIssueCode =
  | "TITLE_REQUIRED"
  | "DESCRIPTION_REQUIRED"
  | "ALT_TEXT_REQUIRED"
  | "TITLE_TOO_LONG"
  | "DESCRIPTION_TOO_LONG"
  | "KEYWORD_FREQUENCY_TITLE"
  | "KEYWORD_FREQUENCY_DESCRIPTION"
  | "CONSECUTIVE_WORD_STUFFING"
  | "UNSUPPORTED_MATERIAL_CLAIM"
  | "UNSUPPORTED_EFFICACY_CLAIM"
  | "UNSUPPORTED_PRICE_CLAIM"
  | "UNSUPPORTED_AVAILABILITY_CLAIM"
  | "UNSUPPORTED_BRAND_CLAIM"
  | "UNSUPPORTED_NUMERIC_CLAIM"
  | "UNSUPPORTED_VIDEO_COVER_INFERENCE"
  | "CLAIM_DETECTION_INCOMPLETE"
  | "BLOCKED_FACT_USED"
  | "DESCRIPTIVE_ONLY_VIOLATION";

export interface ValidationIssue {
  code: ValidationIssueCode;
  field: "title" | "description" | "altText" | "general";
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export type DetectedClaimType =
  | "material"
  | "brand"
  | "price"
  | "availability"
  | "efficacy"
  | "numeric_commercial"
  | "video_motion"
  | "video_audio"
  | "video_temporal";

export interface DetectedClaim {
  type: DetectedClaimType;
  value: string;
  field?: "title" | "description" | "altText";
}

export type ClaimDetectionResult =
  | { status: "completed"; claims: DetectedClaim[] }
  | { status: "incomplete"; claims: [] };

export interface FactSummaryItem {
  factId: string;
  key: string;
  value: string;
  trustLevel: FactTrustLevel;
  source?: FactSource;
  canonicalClaim?: string;
  claimPolarity?: FactClaimPolarity;
}

export interface CopyResultV2 {
  generationId: string;
  sessionId: string;
  draftId: string;
  angleId: string;
  keywordSetId: string;
  title: string;
  description: string;
  altText: string;
  usedKeywordIds: string[];
  factSummary: FactSummaryItem[];
  degradedMode: DegradedMode;
  validationReport: ValidationReport;
}
