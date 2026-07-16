/**
 * qualityJudgeServer.ts — server-only VLM rubric grader for the Quality Judge (Phase C).
 *
 * Used by POST /api/quality-judge. It reuses the shared image-fetch + chat plumbing from
 * visionServer.ts and asks a vision model to score a GENERATED pin image on eight rubric
 * dimensions (0-100, higher = better on every axis). It ONLY produces raw scores + short
 * internal reasons — the score→verdict decision lives in the pure `judgeVerdict.ts` module.
 *
 * Contract: throws CopyError(502) on genuine upstream/parse failure (route surfaces the
 * user-safe message, never the internal code). The route separately maps a bad/unreadable
 * image (from fetchImageAsDataUrl) to 422.
 */

import {
  CopyError,
  PROVIDER_MESSAGE,
  chatJson,
  thinkingExtras,
  asStringArray,
  type ProviderConfig,
} from "./visionServer";

/** Optional grounding context for the grader — all best-effort, safely absent. */
export type JudgeContext = {
  /** Analysis summary of the ORIGINAL product image (so the grader can judge whether the
   *  generated image preserved the product). */
  productImageSummary?: string;
  /** The product's title (helps the grader know what the subject should be). */
  productTitle?: string;
  /** The creative direction / brief that drove generation (tone & scene the image aimed for). */
  directionHint?: string;
};

/** Raw grader output — scores are 0-100 (higher better), reasons are INTERNAL diagnostics. */
export type JudgeRawResult = {
  scores: Record<string, number>;
  reasons: string[];
};

const JUDGE_TIMEOUT_MS = 28_000;

/**
 * Grade a generated Pin image. Returns raw per-dimension scores + short internal reasons.
 * The caller (route) turns scores into a verdict via judgeVerdict.ts.
 */
export async function judgeImageQuality(args: {
  cfg: ProviderConfig;
  dataUrl: string;
  context?: JudgeContext;
}): Promise<JudgeRawResult> {
  const ctx = args.context ?? {};
  const schema = `{
  "productPreservation": 0-100 (does the generated image faithfully keep the original product's shape, color, and identity? 100 = identical product, 0 = wrong/warped/absent product),
  "realism": 0-100 (does it look like a real, believable photo/scene? 100 = photoreal, 0 = obviously fake/AI-broken),
  "creatorLikeness": 0-100 (does it look like authentic creator/brand content a person would actually pin, not stocky or synthetic?),
  "sceneFit": 0-100 (does the scene/context suit the product and the creative direction?),
  "pinterestFit": 0-100 (is it a strong vertical Pinterest-style image — composition, aspiration, save-worthiness?),
  "composition": 0-100 (framing, balance, focal clarity, lighting),
  "artifacts": 0-100 (ARTIFACT-FREENESS: 100 = clean, no glitches; 0 = severe distortion, extra/broken limbs, melted text, garbled objects),
  "safety": 0-100 (SAFENESS: 100 = fully safe/brand-safe; low = nudity, gore, hate, disturbing or policy-violating content),
  "reasons": ["1-4 very short internal notes explaining the lowest scores"]
}`;

  const contextLines: string[] = [];
  if (ctx.productTitle) contextLines.push(`Intended product: ${ctx.productTitle}`);
  if (ctx.productImageSummary) contextLines.push(`Original product image looked like: ${ctx.productImageSummary}`);
  if (ctx.directionHint) contextLines.push(`Creative direction the image was aiming for: ${ctx.directionHint}`);
  const contextBlock = contextLines.length
    ? `Context for grading (the generated image should be consistent with this):\n${contextLines.join("\n")}`
    : "No extra context — grade the image on its own merits.";

  const raw = await chatJson({
    key: args.cfg.key,
    baseUrl: args.cfg.baseUrl,
    model: args.cfg.visionModel,
    timeoutMs: JUDGE_TIMEOUT_MS,
    temperature: 0.1,
    maxTokens: 512,
    extraBody: thinkingExtras(args.cfg.provider, args.cfg.visionModel),
    messages: [
      {
        role: "system",
        content:
          "You are a strict but fair image-quality rubric grader for AI-generated Pinterest pins. " +
          "Score ONLY what you can see. Every score is 0-100 where 100 is best. Be conservative: reserve " +
          "very low scores for genuinely broken or unsafe images. Output JSON only, no prose.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Grade this GENERATED image and return STRICT JSON ONLY matching this schema:\n${schema}\n\n${contextBlock}`,
          },
          { type: "image_url", image_url: { url: args.dataUrl } },
        ],
      },
    ],
  }) as Record<string, unknown>;

  if (!raw || typeof raw !== "object") {
    throw new CopyError("judge_unparseable_response", 502, PROVIDER_MESSAGE);
  }

  // Pull the numeric scores out; keep them raw here (clamping/verdict lives in judgeVerdict).
  const scores: Record<string, number> = {};
  for (const key of [
    "productPreservation", "realism", "creatorLikeness", "sceneFit",
    "pinterestFit", "composition", "artifacts", "safety",
  ]) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) scores[key] = v;
  }
  // A grader that returned no usable score at all is an upstream failure, not a valid grade.
  if (Object.keys(scores).length === 0) {
    throw new CopyError("judge_no_scores", 502, PROVIDER_MESSAGE);
  }

  return { scores, reasons: asStringArray(raw.reasons, 4) };
}
