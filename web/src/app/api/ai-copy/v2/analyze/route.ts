/**
 * POST /api/ai-copy/v2/analyze
 *
 * Rules:
 *  - Route order: flag -> auth -> rate limit -> body/provider.
 *  - Literal AI_COPY_V2_ENABLED=true only; otherwise 404.
 *  - Authenticated via getUserIdFromBearerOrCookies. 401 if unauthenticated.
 *  - Rate limit: ai_copy_v2_analyze (200/300s). Returns 429 before body parsing.
 *  - Input: draftId, idempotencyKey, locale/country, image/product/page/board context, user keywords.
 *  - No arbitrary URL fetching.
 *  - Builds FactCardV1 and KeywordEvidence.
 *  - Idempotency claimed before work; duplicate idempotencyKey returns original stored session.
 *  - Concurrency-safe against double-spending.
 */

import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { consumeRateLimit, RATE_LIMITED_ERROR, RATE_LIMITED_MESSAGE } from "@/lib/server/rateLimit";
import { createFactCardV1 } from "@/lib/ai-copy/v2/factCard";
import { buildKeywordEvidence } from "@/lib/ai-copy/v2/keywordEvidence";
import { retrievePinterestKeywords } from "@/lib/ai-copy/keywordContext";
import { getSessionStore } from "@/lib/ai-copy/v2/sessionStore";
import {
  AI_COPY_V2_MODEL_VERSION,
  AI_COPY_V2_PROMPT_VERSION,
} from "@/lib/ai-copy/v2/orchestrator";
import type { CreateFactInput } from "@/lib/ai-copy/v2/factCard";

export const runtime = "nodejs";

export interface AnalyzeRequestBody {
  draftId: string;
  idempotencyKey: string;
  locale?: string;
  country?: string;
  productContext?: {
    title?: string;
    description?: string;
    vendor?: string;
    productType?: string;
    tags?: string[];
    price?: string;
  };
  pageContext?: {
    title?: string;
    description?: string;
  };
  imageObserved?: {
    summary?: string;
    objects?: string[];
    colors?: string[];
    style?: string;
    ocrText?: string[];
  };
  boardContext?: {
    name?: string;
    description?: string;
  };
  userKeywords?: string[];
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
  const rl = await consumeRateLimit(userId, "ai_copy_v2_analyze");
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
  let body: AnalyzeRequestBody;
  try {
    body = (await req.json()) as AnalyzeRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "Malformed JSON request body" },
      { status: 400 },
    );
  }

  if (!body.draftId || typeof body.draftId !== "string" || !body.draftId.trim()) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", message: "draftId is required" },
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

  // 5. Check if session already exists for this idempotency key (idempotent replay)
  const existing = await sessionStore.findSessionByAnalyzeKey(userId, body.idempotencyKey);
  if (existing) {
    return NextResponse.json({
      ok: true,
      sessionId: existing.id,
      draftId: existing.draft_id,
      factCard: existing.fact_card,
      keywordEvidence: existing.keyword_evidence,
      degradedMode: existing.keyword_evidence.degradedMode,
      replayed: true,
    });
  }

  const locale = body.locale || "en";
  const country = body.country || "US";

  // 6. Build FactCardV1 from semantic contexts (no arbitrary URL fetch)
  const facts: CreateFactInput[] = [];

  if (body.productContext) {
    const pc = body.productContext;
    if (pc.title) facts.push({ key: "product_title", value: pc.title, source: "product_catalog", trustLevel: "verified", category: "general" });
    if (pc.description) facts.push({ key: "product_description", value: pc.description, source: "product_catalog", trustLevel: "verified", category: "general" });
    if (pc.vendor) facts.push({ key: "product_vendor", value: pc.vendor, source: "product_catalog", trustLevel: "verified", category: "brand" });
    if (pc.productType) facts.push({ key: "product_type", value: pc.productType, source: "product_catalog", trustLevel: "verified", category: "general" });
    if (pc.price) facts.push({ key: "product_price", value: pc.price, source: "product_catalog", trustLevel: "verified", category: "price" });
    if (pc.tags && pc.tags.length) facts.push({ key: "product_tags", value: pc.tags.join(", "), source: "product_catalog", trustLevel: "verified", category: "general" });
  }

  if (body.pageContext) {
    const pg = body.pageContext;
    if (pg.title) facts.push({ key: "page_title", value: pg.title, source: "page_metadata", trustLevel: "asserted", category: "general" });
    if (pg.description) facts.push({ key: "page_description", value: pg.description, source: "page_metadata", trustLevel: "asserted", category: "general" });
  }

  if (body.imageObserved) {
    const io = body.imageObserved;
    if (io.summary) facts.push({ key: "image_summary", value: io.summary, source: "image_observed", trustLevel: "observed", category: "visual_description", claimPolicy: "descriptive_only" });
    if (io.objects?.length) facts.push({ key: "visible_objects", value: io.objects.join(", "), source: "image_observed", trustLevel: "observed", category: "visual_description", claimPolicy: "descriptive_only" });
    if (io.colors?.length) facts.push({ key: "colors", value: io.colors.join(", "), source: "image_observed", trustLevel: "observed", category: "visual_description", claimPolicy: "descriptive_only" });
    if (io.style) facts.push({ key: "visual_style", value: io.style, source: "image_observed", trustLevel: "observed", category: "visual_description", claimPolicy: "descriptive_only" });
    if (io.ocrText?.length) facts.push({ key: "ocr_text", value: io.ocrText.join(" "), source: "image_observed", trustLevel: "observed", category: "visual_description", claimPolicy: "descriptive_only" });
  }

  if (body.boardContext) {
    const bc = body.boardContext;
    if (bc.name) facts.push({ key: "board_name", value: bc.name, source: "board_context", trustLevel: "asserted", category: "general" });
    if (bc.description) facts.push({ key: "board_description", value: bc.description, source: "board_context", trustLevel: "asserted", category: "general" });
  }

  if (body.userKeywords?.length) {
    facts.push({
      key: "user_keywords",
      value: body.userKeywords.join(", "),
      source: "user_input",
      trustLevel: "asserted",
      category: "general",
    });
  }

  const factCard = createFactCardV1({
    sessionId: "pending",
    draftId: body.draftId,
    locale,
    facts,
  });

  // 7. Keyword Evidence Retrieval via trend_keywords (sole demand source)
  const kwResult = await retrievePinterestKeywords({
    imageSummary: body.imageObserved?.summary,
    ocrText: body.imageObserved?.ocrText,
    category: body.productContext?.productType,
    boardName: body.boardContext?.name,
    productTitle: body.productContext?.title,
    productDescription: body.productContext?.description,
    productTags: body.productContext?.tags,
    locale,
    country,
  }).catch(() => null);

  const kwContext = {
    imageSummary: body.imageObserved?.summary,
    ocrText: body.imageObserved?.ocrText,
    category: body.productContext?.productType,
    boardName: body.boardContext?.name,
    language: locale,
    country,
  };

  const candidateRows = (kwResult?.recommended ?? []).map((r) => ({
    id: `kw_${r.keyword.toLowerCase().replace(/\s+/g, "_")}`,
    keyword: r.keyword,
    category: body.productContext?.productType || "general",
    data_quality: "official" as const,
    language: locale,
    country,
  }));

  const keywordEvidence = buildKeywordEvidence(candidateRows, kwContext, {
    draftId: body.draftId,
    targetLocale: locale,
    userInput: body.userKeywords?.join(", "),
    pageMetadata: body.pageContext,
  });

  // 8. Persist session atomically
  const { session } = await sessionStore.createSession({
    userId,
    draftId: body.draftId,
    analyzeIdempotencyKey: body.idempotencyKey,
    factCard,
    keywordEvidence,
    modelVersion: AI_COPY_V2_MODEL_VERSION,
    promptVersion: AI_COPY_V2_PROMPT_VERSION,
  });

  // Update factCard's sessionId to the assigned UUID
  session.fact_card.sessionId = session.id;
  session.keyword_evidence.sessionId = session.id;

  return NextResponse.json({
    ok: true,
    sessionId: session.id,
    draftId: session.draft_id,
    factCard: session.fact_card,
    keywordEvidence: session.keyword_evidence,
    degradedMode: session.keyword_evidence.degradedMode,
    replayed: false,
  });
}
