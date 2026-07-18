/**
 * judgeCalibration.ts — shared, PURE helpers for the internal Judge-calibration loop
 * (/admin/creative-intelligence → "Judge calibration" section).
 *
 * Human reviewers mark Agree/Disagree against recent quality-judge verdicts
 * (generation_judged events). Verdicts persist into the EXISTING visual_asset_reviews
 * table (migrate_v31, applied) WITHOUT schema changes, via the existing admin write API
 * (POST /api/admin/visual-review):
 *
 *   - source_type  = "pin_sample"            (v31 CHECK only allows pin_sample|pin_product;
 *                                             we do not alter the table — see prefix below)
 *   - source_id    = "judge_calibration:<draftId>:<judgeVersion>"
 *                    The namespace prefix makes these rows unmistakable and collision-free
 *                    vs real pin_samples ids, and UNIQUE(source_type, source_id) gives
 *                    exactly the one-review-per-(draftId, judgeVersion) dedup we need.
 *   - scores       = NEUTRAL_CALIBRATION_SCORES (Agree/Disagree is not a 5-axis image
 *                    score; the five NOT NULL columns get neutral placeholders and the
 *                    REAL signal lives in reviewer_note)
 *   - reviewer_note = JSON: { source:"judge_calibration", agreement, judgeVersion,
 *                    verdict, overall, draftId }
 *
 * Everything here is dependency-free so it can be imported by the client section, the
 * API route, and the unit test alike.
 */

import type { QualityVerdict } from "@/lib/ai-copy/judgeVerdict";

export type CalibrationAgreement = "agree" | "disagree";

/** One judged generation shown in the calibration list. */
export type CalibrationItem = {
  draftId: string;
  imageUrl: string;
  title: string | null;
  verdict: QualityVerdict;
  overall: number | null;
  judgeVersion: string;
  judgedAt: string | null;
  /** Existing review, when this (draftId, judgeVersion) was already calibrated. */
  agreement: CalibrationAgreement | null;
  reviewedAt: string | null;
};

export type CalibrationResponse = {
  available: boolean;          // analytics_events reachable
  persistenceAvailable: boolean; // visual_asset_reviews reachable (writes possible)
  items: CalibrationItem[];
  warnings: string[];
};

export const CALIBRATION_SOURCE_TYPE = "pin_sample" as const;
export const CALIBRATION_SOURCE_PREFIX = "judge_calibration:";

/** Neutral 5-axis placeholders for the NOT NULL score columns (see module header). */
export const NEUTRAL_CALIBRATION_SCORES = {
  human_shot_authenticity_score: 3,
  ai_likeness_score: 0,
  product_visibility_score: 3,
  pinterest_native_score: 3,
  commercial_clarity_score: 3,
} as const;

export function buildCalibrationSourceId(draftId: string, judgeVersion: string): string {
  return `${CALIBRATION_SOURCE_PREFIX}${draftId}:${judgeVersion}`;
}

export type CalibrationNote = {
  source: "judge_calibration";
  agreement: CalibrationAgreement;
  judgeVersion: string;
  verdict: QualityVerdict;
  overall: number | null;
  draftId: string;
};

export function buildCalibrationNote(args: {
  agreement: CalibrationAgreement;
  judgeVersion: string;
  verdict: QualityVerdict;
  overall: number | null;
  draftId: string;
}): string {
  const note: CalibrationNote = { source: "judge_calibration", ...args };
  return JSON.stringify(note);
}

/** Parse a reviewer_note back into a CalibrationNote; null when it isn't one. */
export function parseCalibrationNote(raw: string | null | undefined): CalibrationNote | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CalibrationNote> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.source !== "judge_calibration") return null;
    if (parsed.agreement !== "agree" && parsed.agreement !== "disagree") return null;
    return {
      source: "judge_calibration",
      agreement: parsed.agreement,
      judgeVersion: typeof parsed.judgeVersion === "string" ? parsed.judgeVersion : "",
      verdict: (parsed.verdict === "ok" || parsed.verdict === "borderline" || parsed.verdict === "invalid")
        ? parsed.verdict
        : "ok",
      overall: typeof parsed.overall === "number" && Number.isFinite(parsed.overall) ? parsed.overall : null,
      draftId: typeof parsed.draftId === "string" ? parsed.draftId : "",
    };
  } catch {
    return null;
  }
}

/** An image the admin browser can actually render (http(s) or same-origin path). */
export function usableCalibrationImageUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  // Same-origin uploads (e.g. /api/studio/upload results) render fine for the admin.
  return s.startsWith("/") && !s.startsWith("//");
}
