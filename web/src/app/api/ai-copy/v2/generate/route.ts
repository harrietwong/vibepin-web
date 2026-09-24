import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { consumeRateLimit, RATE_LIMITED_ERROR, RATE_LIMITED_MESSAGE } from "@/lib/server/rateLimit";
import { getSessionStore } from "@/lib/ai-copy/v2/sessionStore";
import { orchestrateCopyGeneration, ValidationErrorV2 } from "@/lib/ai-copy/v2/orchestrator";
import { CopyError, PROVIDER_MESSAGE } from "@/lib/ai-copy/visionServer";
import { isAffiliateDisclosureKind, type AffiliateDisclosureKind } from "@/lib/ai-copy/affiliateDisclosure";
import { aiTextLimitResponseBody, releaseTextGeneration, reserveTextGeneration, settleTextGeneration, usageEnforceFor } from "@/lib/server/usage/meterTextGeneration";

export const runtime = "nodejs";
interface Body { sessionId: string; idempotencyKey: string; lengthPreference?: "short" | "standard" | "seo-rich"; angleId?: string; angleRequest?: string; affiliateDisclosure?: AffiliateDisclosureKind; }
const validText = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export async function POST(req: Request) {
  if (process.env.AI_COPY_V2_ENABLED !== "true") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const userId = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized", message: "Authentication required" }, { status: 401 });
  const limit = await consumeRateLimit(userId, "ai_copy_v2_generate");
  if (!limit.allowed) return NextResponse.json({ ok: false, error: RATE_LIMITED_ERROR, message: RATE_LIMITED_MESSAGE }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  let body: Body;
  try { body = await req.json() as Body; } catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }
  const lengths = new Set([undefined, "short", "standard", "seo-rich"]);
  if (!body || !validText(body.sessionId, 100) || !validText(body.idempotencyKey, 200) || !lengths.has(body.lengthPreference) || (body.angleId != null && !validText(body.angleId, 100)) || (body.angleRequest != null && !validText(body.angleRequest, 1000)) || (body.affiliateDisclosure != null && !isAffiliateDisclosureKind(body.affiliateDisclosure))) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const store = getSessionStore();
  let session;
  try { session = await store.getValidSession(body.sessionId.trim(), userId); } catch { return NextResponse.json({ ok: false, error: "generation_failed", message: PROVIDER_MESSAGE }, { status: 502 }); }
  if (!session || !session.fact_card || !session.keyword_evidence) return NextResponse.json({ ok: false, error: "session_not_found", message: "Session not found or expired" }, { status: 404 });

  let claim;
  try {
    claim = await store.claimGeneration({ sessionId: session.id, userId, idempotencyKey: body.idempotencyKey.trim(), angleId: body.angleId?.trim() });
  } catch {
    return NextResponse.json({ ok: false, error: "generation_failed", message: PROVIDER_MESSAGE }, { status: 502 });
  }
  if (claim.state === "pending") return NextResponse.json({ ok: false, error: "request_in_progress" }, { status: 409 });
  if (claim.state === "completed") {
    if (!claim.row.output) return NextResponse.json({ ok: false, error: "generation_failed", message: PROVIDER_MESSAGE }, { status: 502 });
    // Completion is terminal: a client replay returns the saved output only. It
    // never opens a historical reservation or re-settles customer usage.
    return NextResponse.json({ ok: true, result: claim.row.output, replayed: true });
  }

  const reservation = await reserveTextGeneration({ userId, generationRequestId: claim.row.id });
  if (reservation.kind === "insufficient" && usageEnforceFor("ai_text_generation")) {
    await store.releaseGenerationClaim(claim.row.id, session.id, userId, claim.row.claim_token).catch(() => undefined);
    return NextResponse.json(aiTextLimitResponseBody(claim.row.id), { status: 402 });
  }

  try {
    const result = await orchestrateCopyGeneration({
      generationId: claim.row.id, sessionId: session.id, draftId: session.draft_id,
      factCard: session.fact_card, keywordEvidence: session.keyword_evidence,
      angleId: body.angleId?.trim(), angleRequest: body.angleRequest?.trim(), lengthPreference: body.lengthPreference,
      // Whitelisted above; the server (never the model or the client) appends it.
      ...(body.affiliateDisclosure ? { affiliateDisclosure: body.affiliateDisclosure } : {}),
      costContext: { userId, operationType: "ai_copy_v2_generation", referenceId: claim.row.id },
    });
    const completed = await store.completeGeneration({ generationId: claim.row.id, sessionId: session.id, userId, claimToken: claim.row.claim_token, output: result, validationReport: result.validationReport });
    if (!completed.output) throw new Error("empty_completion");
    await settleTextGeneration({ reservation }).catch(() => undefined);
    return NextResponse.json({ ok: true, result: completed.output, replayed: false });
  } catch (error) {
    await releaseTextGeneration({ reservation, reason: "ai_copy_v2_generation_failed" }).catch(() => undefined);
    await store.releaseGenerationClaim(claim.row.id, session.id, userId, claim.row.claim_token).catch(() => undefined);
    if (error instanceof ValidationErrorV2) return NextResponse.json({ ok: false, error: "validation_failed", validationReport: error.validationReport }, { status: 422 });
    if (error instanceof CopyError) return NextResponse.json({ ok: false, error: "provider_error", message: error.userMessage || PROVIDER_MESSAGE }, { status: 502 });
    return NextResponse.json({ ok: false, error: "generation_failed", message: PROVIDER_MESSAGE }, { status: 502 });
  }
}
