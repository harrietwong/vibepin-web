/**
 * POST /api/quality-judge  (PRD v0.2 §5.5, Phase C — Quality Judge v0)
 *
 * Grades a GENERATED Pin image with a VLM rubric grader and returns a conservative verdict.
 * Only ever hides *clearly* invalid images (unsafe, or severely broken AND low overall);
 * everything else is reported ok/borderline and shown unchanged.
 *
 * Runs only on AI-generated results (the client helper enforces this) — never on uploads.
 *
 * Status contract (mirrors /api/ai-copy/analyze): 401 = not signed in; 429 = per-user
 * rate limit (Retry-After set); 422 = bad/unreadable image; 502 = upstream
 * provider failure; 500 = provider not configured. Internal error codes are NEVER surfaced to
 * the UI — only a user-safe message. On any failure the client marks the draft judge "failed"
 * and the card behaves exactly as it does today.
 */

import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { consumeRateLimit, RATE_LIMITED_ERROR, RATE_LIMITED_MESSAGE } from "@/lib/server/rateLimit";
import {
  CopyError,
  PROVIDER_MESSAGE,
  fetchImageAsDataUrl,
  providerConfig,
  devLog,
  elapsed,
  isDev,
} from "@/lib/ai-copy/visionServer";
import { judgeImageQuality } from "@/lib/ai-copy/qualityJudgeServer";
import { judgeFromRawScores, JUDGE_VERSION } from "@/lib/ai-copy/judgeVerdict";

export const runtime = "nodejs";

type Body = {
  draftId?: string;
  imageUrl?: string;
  // Optional grounding context (best-effort, from the client draft).
  productImageSummary?: string;
  productTitle?: string;
  directionHint?: string;
};

/** Same envelope as every other failure on this route; code distinguishes sign-in from provider errors. */
const UNAUTHENTICATED_MESSAGE = "Please sign in to run quality checks.";

export async function POST(req: Request) {
  const started = performance.now();

  // AUTHENTICATION FIRST — before body parsing, provider configuration, the image
  // fetch and the grading call. An anonymous caller reaches no outbound request.
  const userId = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "unauthenticated", userMessage: UNAUTHENTICATED_MESSAGE },
      { status: 401 },
    );
  }

  // RATE LIMIT SECOND — still before body parsing, provider configuration, the image
  // fetch and the grading call. Authentication alone only converted anonymous spend
  // into per-account spend; this bounds what one account can cost. Fails OPEN when
  // the limiter's own infrastructure is down (see lib/server/rateLimit.ts).
  const limit = await consumeRateLimit(userId, "quality_judge");
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: RATE_LIMITED_ERROR, userMessage: RATE_LIMITED_MESSAGE },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await req.json() as Body;
  const cfg = providerConfig();

  try {
    if (!cfg.key) throw new CopyError("ai_copy_provider_not_configured", 500, PROVIDER_MESSAGE);

    // 1) Fetch the generated image (422 on bad/unreadable image via fetchImageAsDataUrl).
    const img = await fetchImageAsDataUrl(body.imageUrl);

    // 2) Grade it (raw scores only — 502 on genuine upstream/parse failure).
    const graded = await judgeImageQuality({
      cfg,
      dataUrl: img.dataUrl,
      context: {
        productImageSummary: body.productImageSummary,
        productTitle: body.productTitle,
        directionHint: body.directionHint,
      },
    });

    // 3) Pure verdict logic (clamp + overall + conservative verdict).
    const { scores, overall, verdict } = judgeFromRawScores(graded.scores);
    const latencyMs = elapsed(started);
    devLog("quality-judge", {
      draftId: body.draftId,
      model: cfg.visionModel,
      imageBytes: img.bytes,
      verdict,
      overall,
      scores,
      latencyMs,
    });

    return NextResponse.json({
      ok: true,
      verdict,
      overall,
      scores,
      // reasons are INTERNAL diagnostics — returned for storage/training only, never shown to users.
      reasons: graded.reasons,
      judgeVersion: JUDGE_VERSION,
      timingsMs: { total: latencyMs },
    });
  } catch (err) {
    const isCopyErr = err instanceof CopyError;
    const status = isCopyErr ? err.status : 502;
    const code = isCopyErr ? err.code : (err as Error)?.message || "quality_judge_failed";
    const userMessage = isCopyErr ? err.userMessage : PROVIDER_MESSAGE;
    if (isDev) console.warn("[quality-judge] failure", JSON.stringify({ draftId: body.draftId, status, code }));
    return NextResponse.json({ ok: false, error: code, userMessage }, { status });
  }
}
