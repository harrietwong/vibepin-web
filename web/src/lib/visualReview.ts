// ── Visual Review v0 — shared scoring model ──────────────────────────────────
//
// INTERNAL admin review tool only. These scores are NOT exposed to any
// client-facing surface (Product Ideas, Create Pins, Discover) and MUST NOT be
// wired into ranking, recommendation, or generation. See
// web/src/app/admin/visual-review/*.
//
// The same compute functions run on the client (live preview as the reviewer
// adjusts controls) and on the server (authoritative value persisted to
// visual_asset_reviews), so the number can never drift between the two.

export type VisualReviewSourceType = "pin_sample" | "pin_product";

export type VisualReviewDecision = "PASS" | "REVIEW" | "REJECT";

/** Raw, human-entered scores. */
export type VisualReviewScores = {
  /** 1 = very AI-like/fake/rendered … 5 = authentic, fresh, human-shot. */
  human_shot_authenticity_score: number;
  /** 0 = not AI-generated … 5 = strongly AI-like, should reject. */
  ai_likeness_score: number;
  /** 1 = no clear product … 5 = clear product subject. */
  product_visibility_score: number;
  /** 1 = does not feel like Pinterest … 5 = very Pinterest-native. */
  pinterest_native_score: number;
  /** 1 = no clear commercial opportunity … 5 = strong product angle. */
  commercial_clarity_score: number;
};

export const VISUAL_REVIEW_TAGS = [
  "authentic_lifestyle",
  "ai_like",
  "product_clear",
  "pinterest_ready",
  "commercial_potential",
  "weak_product_subject",
  "too_stock_like",
  "too_ad_like",
  "low_value_for_create_pins",
] as const;

export type VisualReviewTag = (typeof VISUAL_REVIEW_TAGS)[number];

/** Neutral starting point before a reviewer touches anything. */
export const DEFAULT_SCORES: VisualReviewScores = {
  human_shot_authenticity_score: 3,
  ai_likeness_score: 0,
  product_visibility_score: 3,
  pinterest_native_score: 3,
  commercial_clarity_score: 3,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Weighted composite, normalized to 0-100:
 *   30% human_shot_authenticity  (1-5)
 * + 20% product_visibility       (1-5)
 * + 20% pinterest_native         (1-5)
 * + 20% commercial_clarity       (1-5)
 * - 10% ai_likeness penalty      (0-5)
 *
 * Each sub-score is normalized against its max of 5, so a 5 contributes its
 * full weight and a 1 contributes 20% of it; the AI-likeness term is subtracted.
 * The result is clamped to [0, 100].
 */
export function computeVisualAssetScore(s: VisualReviewScores): number {
  const positive =
    0.3 * (clamp(s.human_shot_authenticity_score, 1, 5) / 5) +
    0.2 * (clamp(s.product_visibility_score, 1, 5) / 5) +
    0.2 * (clamp(s.pinterest_native_score, 1, 5) / 5) +
    0.2 * (clamp(s.commercial_clarity_score, 1, 5) / 5);
  const penalty = 0.1 * (clamp(s.ai_likeness_score, 0, 5) / 5);
  return Math.round(clamp((positive - penalty) * 100, 0, 100));
}

/**
 * Internal decision label. REJECT and PASS are evaluated before REVIEW so a hard
 * fail (e.g. strongly AI-like) always wins over the numeric band.
 */
export function computeDecisionLabel(
  visualAssetScore: number,
  aiLikenessScore: number,
): VisualReviewDecision {
  if (visualAssetScore < 50 || aiLikenessScore >= 4) return "REJECT";
  if (visualAssetScore >= 75 && aiLikenessScore <= 2) return "PASS";
  return "REVIEW";
}

// ── Wire types shared by the candidates API + client ─────────────────────────

/** An image candidate drawn from pin_products / pin_samples. */
export type VisualReviewCandidate = {
  source_type: VisualReviewSourceType;
  source_id: string;
  image_url: string;
  title: string | null;
  category: string | null;
  source_pin_id: string | null;
  created_at: string | null;
};

/** A persisted review row (subset needed by the client). */
export type VisualReviewRecord = VisualReviewScores & {
  source_type: VisualReviewSourceType;
  source_id: string;
  image_url: string | null;
  visual_asset_score: number;
  decision_label: VisualReviewDecision;
  tags: VisualReviewTag[];
  reviewer_note: string | null;
  updated_at: string | null;
};

export type CandidatesResponse = {
  candidates: VisualReviewCandidate[];
  reviews: VisualReviewRecord[];
  /** True when the visual_asset_reviews table is not yet present (migration pending). */
  persistenceAvailable: boolean;
  categories: string[];
  warnings: string[];
};
