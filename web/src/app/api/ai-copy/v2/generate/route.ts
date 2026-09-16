/**
 * POST /api/ai-copy/v2/generate
 *
 * Rules:
 *  - Literal AI_COPY_V2_ENABLED=true only; otherwise 404.
 *  - Route order: flag -> auth -> rate limit -> body/provider.
 *  - Verified auth via getUserIdFromBearerOrCookies. 401 if unauthenticated.
 *  - Rate limit: ai_copy_v2_generate (150/300s). Returns 429 before body parsing.
 *  - Input: sessionId, idempotencyKey, lengthPreference, optional angleId/angleRequest.
 *  - Loads trusted server-side session data owned by current user and unexpired.
 *    Foreign or expired session both return 404.
 *  - Concurrency-safe unique idempotency: repeated generate request with same
 *    idempotencyKey returns identical stored output. Supports A -> B -> retry A.
 *  - Generation ledger stores each generation row.
 *  - Exactly one CopyResultV2, no clusterId.
 *  - Passes at most 5 keywords, never mandatory.
 *  - Degraded mode (no_keyword_demand_data) generates from grounded semantics only.
 *  - Validator 100/800. At most ONE repair call for repairable non-fact issues.
 *  - Never repair fact conflicts by inventing facts.
 *  - Second invalid -> 422 (and never returns bad copy).
 *  - Provider failure -> 502.
 */

import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { consumeRateLimit, RATE_LIMITED_ERROR, RATE_LIMITED_MESSAGE } from "@/lib/server/rateLimit";
import { getSessionStore } from "@/lib/ai-copy/v2/sessionStore";
import {
  orchestrateCopyGeneration,
  ValidationErrorV2,
} from "@/lib/ai-copy/v2/orchestrator";
import { CopyError } from "@/lib/ai-copy/visionServer";

export const runtime = "nodejs";

export interface GenerateRequestBody {
  sessionId: string;
  idempotencyKey: string;
  lengthPreference?: "short" | "standard" | "seo-rich";
  angleId?: string;
  angleRequest?: string;
}

export async function POST(req: Request) {
  // 1. Literal Feature Flag Check
  if (process.env.AI_COPY_V2_ENABLED !== "true") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // 2. Verified Authentication
  const userId = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", message: "Authentication required" },
      { status: 401 },
    );
  }

  // 3. Durable Rate Limiter (BEFORE body parsing / work)
  const rl = await consumeRateLimit(userId, "ai_copy_v2_generate");
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: RATE_LIMITED_ERROR, message: RATE_LIMITED_MESSAGE },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSeconds) },
      },
    );
  }

  // 4. Body parsing and validation
  let body: GenerateRequestBody;
  try {
    body = (await req.json()) as GenerateRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "Malformed JSON request body" },
      { status: 400 },
    );
  }

  if (!body.sessionId || typeof body.sessionId !== "string" || !body.sessionId.trim()) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", message: "sessionId is required" },
      { status: 400 },
    );
  }

  if (!body.idempotencyKey || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim()) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", message: "idempotencyKey is required" },
      { status: 400 },
    );
  }

  const sessionStore = getSessionStore();

  // 5. Load trusted session (filtered by userId and unexpired in single check)
  // Foreign or expired sessions both result in 404
  const session = await sessionStore.getValidSession(body.sessionId, userId);
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "session_not_found", message: "Session not found or expired" },
      { status: 404 },
    );
  }

  // 6. Check Generation Ledger for idempotency (e.g. A -> B -> retry A)
  const existingGen = await sessionStore.findGeneration(session.id, body.idempotencyKey);
  if (existingGen) {
    return NextResponse.json({
      ok: true,
      result: existingGen.output,
      replayed: true,
    });
  }

  // 7. Orchestrate Copy Generation
  try {
    const copyResult = await orchestrateCopyGeneration({
      sessionId: session.id,
      draftId: session.draft_id,
      factCard: session.fact_card,
      keywordEvidence: session.keyword_evidence,
      angleId: body.angleId,
      lengthPreference: body.lengthPreference,
    });

    // 8. Record generation in ledger atomically
    await sessionStore.recordGeneration({
      sessionId: session.id,
      userId,
      idempotencyKey: body.idempotencyKey,
      angleId: body.angleId,
      output: copyResult,
      validationReport: copyResult.validationReport,
    });

    return NextResponse.json({
      ok: true,
      result: copyResult,
      replayed: false,
    });
  } catch (err) {
    if (err instanceof ValidationErrorV2) {
      return NextResponse.json(
        {
          ok: false,
          error: "validation_failed",
          message: err.message,
          validationReport: err.validationReport,
        },
        { status: 422 },
      );
    }

    if (err instanceof CopyError) {
      return NextResponse.json(
        {
          ok: false,
          error: "provider_error",
          message: err.message,
        },
        { status: err.status || 502 },
      );
    }

    const message = (err as Error)?.message || "unknown";
    return NextResponse.json(
      {
        ok: false,
        error: "generation_failed",
        message,
      },
      { status: 502 },
    );
  }
}
