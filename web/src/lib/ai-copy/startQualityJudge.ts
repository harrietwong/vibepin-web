"use client";

/**
 * startQualityJudge — background quality grading for AI-GENERATED pin results (Phase C).
 *
 * Fired right after a generated result card is completed (in parallel with, and independent
 * of, startImageAnalysis). It POSTs the generated image to /api/quality-judge, then caches
 * the verdict + internal scores ONTO the draft (pinDraftStore / localStorage).
 *
 * STRICTLY best-effort:
 *  - Never throws, never blocks generation.
 *  - Only runs on ai_generated_from_upload drafts — user uploads are NEVER judged.
 *  - De-duped: won't re-run an in-flight or completed judge.
 *  - On ANY failure (timeout / upstream / parse) it marks the judge "failed"; a failed or
 *    pending judge leaves the card behaving EXACTLY as it does today (no hiding, no badge).
 *
 * Only an `invalid` verdict changes the UI (PinBoardCard renders it collapsed/dimmed with a
 * "Show anyway" affordance). ok/borderline look identical to an unjudged card.
 */

import * as pinDraftStore from "@/lib/pinDraftStore";
import { track } from "@/lib/analytics";
import { JUDGE_VERSION } from "@/lib/ai-copy/judgeVerdict";

type JudgeResponse = {
  ok?: boolean;
  error?: string;
  verdict?: "ok" | "borderline" | "invalid";
  overall?: number;
  scores?: Record<string, number>;
  reasons?: string[];
  judgeVersion?: string;
};

export async function startQualityJudge(draftId: string): Promise<void> {
  const draft = pinDraftStore.getDraft(draftId);
  if (!draft || !draft.imageUrl) return;
  // NEVER judge user uploads — only AI-generated results.
  if (draft.source !== "ai_generated_from_upload") return;
  // Don't re-run an in-flight or completed judge.
  if (draft.qualityJudge?.status === "pending" || draft.qualityJudge?.status === "ready") return;

  pinDraftStore.updateDraft(draftId, {
    qualityJudge: { status: "pending", judgeVersion: "", updatedAt: new Date().toISOString() },
  });

  // Best-effort grounding context. The parent (source upload) draft holds the original
  // product image analysis; the generated draft carries the creative direction brief.
  const parent = draft.parentDraftId ? pinDraftStore.getDraft(draft.parentDraftId) : null;
  const productImageSummary = parent?.imageSummary || draft.imageSummary || undefined;
  const directionHint = (draft.promptSnapshot || parent?.promptSnapshot || "").trim() || undefined;
  const productTitle = (draft.title || parent?.title || "").trim() || undefined;

  try {
    const res = await fetch("/api/quality-judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        draftId,
        imageUrl: draft.imageUrl,
        productImageSummary,
        productTitle,
        directionHint,
      }),
    });
    const bodyJson = await res.json() as JudgeResponse;
    if (!res.ok || !bodyJson.ok || !bodyJson.verdict) {
      throw new Error(bodyJson?.error || `judge_http_${res.status}`);
    }

    pinDraftStore.updateDraft(draftId, {
      qualityJudge: {
        status:       "ready",
        verdict:      bodyJson.verdict,
        scores:       bodyJson.scores ?? undefined,
        overall:      typeof bodyJson.overall === "number" ? bodyJson.overall : undefined,
        reasons:      Array.isArray(bodyJson.reasons) ? bodyJson.reasons : undefined,
        judgeVersion: bodyJson.judgeVersion || "",
        updatedAt:    new Date().toISOString(),
      },
    });

    // Durable analytics for training-data accumulation (PRD v0.2 A4). Scores/reasons are
    // internal; verdict + overall + scores go to the sink, never to the UI.
    track("generation_judged", {
      draftId,
      verdict: bodyJson.verdict,
      overall: typeof bodyJson.overall === "number" ? bodyJson.overall : null,
      ...flattenScores(bodyJson.scores),
      // Stamp the judge version so accumulated verdicts stay comparable across judge
      // iterations. Prefer the server-returned version; fall back to the shared constant.
      versions: { judgeVersion: bodyJson.judgeVersion || JUDGE_VERSION },
    });
  } catch {
    // Silent failure (PRD: a failed judge must leave the card exactly as-is). We only
    // overwrite our OWN pending marker so we never clobber a concurrent success.
    if (pinDraftStore.getDraft(draftId)?.qualityJudge?.status === "pending") {
      pinDraftStore.updateDraft(draftId, {
        qualityJudge: { status: "failed", judgeVersion: "", updatedAt: new Date().toISOString() },
      });
    }
  }
}

/** Flatten per-dimension scores into scalar analytics props (score_<dim>: number). */
function flattenScores(scores: Record<string, number> | undefined): Record<string, number> {
  if (!scores) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(scores)) {
    if (typeof v === "number" && Number.isFinite(v)) out[`score_${k}`] = v;
  }
  return out;
}
