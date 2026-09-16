import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { consumeRateLimit, RATE_LIMITED_ERROR, RATE_LIMITED_MESSAGE } from "@/lib/server/rateLimit";
import { createFact, createFactCardV1, type CreateFactInput } from "@/lib/ai-copy/v2/factCard";
import { buildKeywordEvidence } from "@/lib/ai-copy/v2/keywordEvidence";
import { getTrendKeywordLoader } from "@/lib/ai-copy/v2/trendKeywordSource";
import { getSessionStore } from "@/lib/ai-copy/v2/sessionStore";
import { AI_COPY_V2_PROMPT_VERSION, getAI_COPY_V2ModelVersion } from "@/lib/ai-copy/v2/orchestrator";
import type { KeywordContextInput } from "@/lib/ai-copy/keywordContext";

export const runtime = "nodejs";

type Context = Record<string, unknown>;
interface AnalyzeBody {
  draftId: string; idempotencyKey: string; locale?: string; country?: string;
  productContext?: Context; pageContext?: Context; imageObserved?: Context; boardContext?: Context;
  userKeywords?: string[];
}

const text = (value: unknown, max = 2000): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
const texts = (value: unknown, maxItems = 30): string[] =>
  Array.isArray(value) ? value.slice(0, maxItems).map(v => text(v, 200)).filter((v): v is string => Boolean(v)) : [];
const badKey = (value: unknown) => !text(value, 200);

function buildFacts(body: AnalyzeBody): ReturnType<typeof createFact>[] {
  const facts: CreateFactInput[] = [];
  let index = 0;
  const add = (key: string, value: unknown, category: CreateFactInput["category"] = "general") => {
    const normalized = text(value);
    if (!normalized) return;
    facts.push({ id: `fact_${++index}`, key, value: normalized, source: "user_input", trustLevel: "asserted", category });
  };
  const product = body.productContext ?? {};
  add("product_title", product.title);
  add("product_description", product.description);
  add("product_vendor", product.vendor, "brand");
  add("product_type", product.productType);
  add("product_price", product.price, "price");
  const tags = texts(product.tags); if (tags.length) add("product_tags", tags.join(", "));
  const page = body.pageContext ?? {}; add("page_title", page.title); add("page_description", page.description);
  const image = body.imageObserved ?? {}; add("image_summary", image.summary); add("visual_style", image.style);
  const objects = texts(image.objects); if (objects.length) add("visible_objects", objects.join(", "));
  const colors = texts(image.colors); if (colors.length) add("colors", colors.join(", "));
  const ocr = texts(image.ocrText); if (ocr.length) add("ocr_text", ocr.join(" "));
  const board = body.boardContext ?? {}; add("board_name", board.name); add("board_description", board.description);
  return facts.map(createFact);
}

function keywordContext(body: AnalyzeBody, locale: string, country: string): KeywordContextInput {
  const product = body.productContext ?? {}, image = body.imageObserved ?? {}, board = body.boardContext ?? {};
  return {
    imageSummary: text(image.summary) ?? "",
    visibleObjects: texts(image.objects),
    style: text(image.style, 200) ?? "",
    boardName: text(board.name, 200),
    category: text(product.productType, 200),
    language: locale,
    region: country,
    productTitle: text(product.title),
    productType: text(product.productType, 200),
    productTags: texts(product.tags),
    directionTerms: texts(body.userKeywords),
  };
}

export async function POST(req: Request) {
  if (process.env.AI_COPY_V2_ENABLED !== "true") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const userId = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized", message: "Authentication required" }, { status: 401 });
  const limit = await consumeRateLimit(userId, "ai_copy_v2_analyze");
  if (!limit.allowed) return NextResponse.json({ ok: false, error: RATE_LIMITED_ERROR, message: RATE_LIMITED_MESSAGE }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });

  let body: AnalyzeBody;
  try { body = await req.json() as AnalyzeBody; } catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }
  if (!body || typeof body !== "object" || badKey(body.draftId) || badKey(body.idempotencyKey) || (body.userKeywords != null && !Array.isArray(body.userKeywords))) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const locale = text(body.locale, 35) ?? "en";
  const country = text(body.country, 10) ?? "US";
  const store = getSessionStore();
  let claim;
  try {
    claim = await store.claimSession({
      userId, workspaceId: userId, draftId: body.draftId.trim(), analyzeIdempotencyKey: body.idempotencyKey.trim(),
      modelVersion: getAI_COPY_V2ModelVersion(), promptVersion: AI_COPY_V2_PROMPT_VERSION,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "analysis_failed", message: "Unable to analyze right now" }, { status: 502 });
  }
  if (claim.state === "pending") return NextResponse.json({ ok: false, error: "request_in_progress" }, { status: 409 });
  if (claim.state === "completed") {
    if (!claim.row.fact_card || !claim.row.keyword_evidence) return NextResponse.json({ ok: false, error: "analysis_failed" }, { status: 502 });
    return NextResponse.json({ ok: true, sessionId: claim.row.id, draftId: claim.row.draft_id, factCard: claim.row.fact_card, keywordEvidence: claim.row.keyword_evidence, degradedMode: claim.row.keyword_evidence.degradedMode, replayed: true });
  }

  try {
    const factCard = createFactCardV1({ sessionId: claim.row.id, draftId: body.draftId.trim(), locale, facts: buildFacts(body) });
    const context = keywordContext(body, locale, country);
    const rows = await getTrendKeywordLoader()(context).catch(() => []);
    const keywordEvidence = buildKeywordEvidence(rows, context, {
      sessionId: claim.row.id, draftId: body.draftId.trim(), targetLocale: locale,
      userInput: texts(body.userKeywords).join(" "),
      pageMetadata: { title: text(body.pageContext?.title), description: text(body.pageContext?.description) },
    });
    const completed = await store.completeSession({ sessionId: claim.row.id, userId, factCard, keywordEvidence });
    return NextResponse.json({ ok: true, sessionId: completed.id, draftId: completed.draft_id, factCard, keywordEvidence, degradedMode: keywordEvidence.degradedMode, replayed: false });
  } catch {
    await store.releaseSessionClaim(claim.row.id, userId).catch(() => undefined);
    return NextResponse.json({ ok: false, error: "analysis_failed", message: "Unable to analyze right now" }, { status: 502 });
  }
}
