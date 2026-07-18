/**
 * judgeVerdict.ts — PURE, unit-testable verdict logic for the Quality Judge (Phase C).
 *
 * The /api/quality-judge route runs a VLM rubric grader that ONLY produces per-dimension
 * scores (0-100, where 100 is best on every axis). This module turns those raw scores
 * into an overall number and a conservative verdict. No network, no I/O, no imports —
 * so it can be tested in isolation and reused on both server and client.
 *
 * Design intent (PRD v0.2 §5.5, Phase C): we ONLY auto-hide an image that is *clearly*
 * invalid. Everything else is shown untouched. Better to let a mediocre image through
 * than to wrongly hide a good one. `borderline` exists purely as an analytics label — it
 * renders exactly like `ok` and never hides anything.
 */

/** The eight rubric dimensions. 0-100, higher is better on EVERY axis (incl. artifacts:
 *  100 = clean/no artifacts, 0 = severe distortion; safety: 100 = fully safe). */
export type QualityScoreKey =
  | "productPreservation"
  | "realism"
  | "creatorLikeness"
  | "sceneFit"
  | "pinterestFit"
  | "composition"
  | "artifacts"
  | "safety";

/** Partial on purpose: a flaky model may omit a field. Missing scores must never
 *  *cause* an invalid verdict (see deriveVerdict). */
export type QualityScores = Partial<Record<QualityScoreKey, number>>;

export type QualityVerdict = "ok" | "borderline" | "invalid";

// ── Thresholds (all tuned to be conservative — err toward showing images) ────────

/**
 * SAFETY is the one true hard gate: a generated image scored below this on safety is
 * always invalid (unsafe/policy-violating content). This is the primary reason an image
 * is ever hidden.
 */
export const SAFETY_FAIL_THRESHOLD = 50;

/**
 * The ONLY quality-based invalid rule, and it needs BOTH conditions at once: the artifact
 * score must be severe (badly distorted / broken render) AND the overall quality must also
 * be low. A low artifact score alone (or a low overall alone) never hides an image — that
 * guards against killing a slightly-imperfect-but-usable pin.
 */
export const ARTIFACTS_SEVERE_THRESHOLD = 25;
export const OVERALL_LOW_THRESHOLD = 40;

/**
 * Below this overall the image is labeled `borderline` (mediocre). This is ANALYTICS ONLY —
 * borderline images render identically to ok images. It exists so we can later learn where
 * the quality distribution sits without ever hiding a shown pin.
 */
export const BORDERLINE_OVERALL_THRESHOLD = 60;

/** Bump when the rubric prompt or thresholds change so accumulated judge data is comparable. */
export const JUDGE_VERSION = "qj_v1";

/** The quality dimensions that feed `overall`. `safety` is deliberately excluded — it is a
 *  gate, not a quality measure (it sits at ~100 for almost every image and would inflate the
 *  mean). */
const OVERALL_DIMENSIONS: QualityScoreKey[] = [
  "productPreservation",
  "realism",
  "creatorLikeness",
  "sceneFit",
  "pinterestFit",
  "composition",
  "artifacts",
];

/** Clamp a raw model number into 0-100, or return undefined if it isn't a finite number. */
export function clampScore(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Overall quality = mean of the present quality dimensions (safety excluded). Returns
 * undefined when NO quality dimension is present — a total absence of scores must not
 * synthesize a (low) overall that could then trip the invalid rule.
 */
export function computeOverall(scores: QualityScores): number | undefined {
  const present = OVERALL_DIMENSIONS
    .map(k => scores[k])
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (present.length === 0) return undefined;
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  return Math.round(mean);
}

/**
 * Conservative verdict. `overall` may be passed in (already computed) or derived here.
 * Rules, in order:
 *   1. safety present AND < SAFETY_FAIL_THRESHOLD            → invalid  (hard gate)
 *   2. artifacts present AND severe  AND overall present AND low → invalid (both required)
 *   3. overall present AND < BORDERLINE_OVERALL_THRESHOLD    → borderline (shown; analytics)
 *   4. otherwise                                             → ok
 * A missing score can only ever make a verdict MORE lenient, never invalid.
 */
export function deriveVerdict(scores: QualityScores, overall?: number): QualityVerdict {
  const overallScore = typeof overall === "number" ? overall : computeOverall(scores);

  // 1) Safety hard gate.
  if (typeof scores.safety === "number" && scores.safety < SAFETY_FAIL_THRESHOLD) {
    return "invalid";
  }

  // 2) Severe artifacts AND low overall — both must be present and both must trip.
  if (
    typeof scores.artifacts === "number" &&
    scores.artifacts < ARTIFACTS_SEVERE_THRESHOLD &&
    typeof overallScore === "number" &&
    overallScore < OVERALL_LOW_THRESHOLD
  ) {
    return "invalid";
  }

  // 3) Mediocre-but-shown.
  if (typeof overallScore === "number" && overallScore < BORDERLINE_OVERALL_THRESHOLD) {
    return "borderline";
  }

  // 4) Default: show it, no badge.
  return "ok";
}

/** Convenience: normalize+clamp raw scores, then produce { scores, overall, verdict }. */
export function judgeFromRawScores(raw: Record<string, unknown> | null | undefined): {
  scores: QualityScores;
  overall?: number;
  verdict: QualityVerdict;
} {
  const scores: QualityScores = {};
  for (const key of [...OVERALL_DIMENSIONS, "safety"] as QualityScoreKey[]) {
    const clamped = clampScore(raw?.[key]);
    if (clamped !== undefined) scores[key] = clamped;
  }
  const overall = computeOverall(scores);
  const verdict = deriveVerdict(scores, overall);
  return { scores, overall, verdict };
}
