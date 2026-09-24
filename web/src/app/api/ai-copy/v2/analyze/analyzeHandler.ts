import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { consumeRateLimit, RATE_LIMITED_ERROR, RATE_LIMITED_MESSAGE } from "@/lib/server/rateLimit";
import { createFact, createFactCardV1, type CreateFactInput } from "@/lib/ai-copy/v2/factCard";
import { buildKeywordEvidence } from "@/lib/ai-copy/v2/keywordEvidence";
import { getTrendKeywordLoader } from "@/lib/ai-copy/v2/trendKeywordSource";
import { getSessionStore } from "@/lib/ai-copy/v2/sessionStore";
import { AI_COPY_V2_PROMPT_VERSION, getAI_COPY_V2ModelVersion } from "@/lib/ai-copy/v2/orchestrator";
import { resolveOwnedMediaEvidence, type VideoCoverDeps } from "@/lib/ai-copy/v2/videoCoverEvidence";
import type { KeywordContextInput } from "@/lib/ai-copy/keywordContext";

type Context = Record<string, unknown>;
export interface AnalyzeBody {
  draftId: string; idempotencyKey: string; locale?: string; country?: string;
  productContext?: Context; pageContext?: Context; imageObserved?: Context; boardContext?: Context;
  userKeywords?: string[];
  /** A client hint only. The server independently loads the owned draft and poster. */
  mediaEvidenceMode?: "video_cover";
}

const text = (value: unknown, max = 2000): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
const texts = (value: unknown, maxItems = 30): string[] =>
  Array.isArray(value) ? value.slice(0, maxItems).map(v => text(v, 200)).filter((v): v is string => Boolean(v)) : [];
const badKey = (value: unknown) => !text(value, 200);
function validLocale(value: string): boolean {
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) return false;
  try { Intl.getCanonicalLocales(value); return true; } catch { return false; }
}
const validCountry = (value: string) => /^[A-Za-z]{2}$/.test(value);
function commercialPolarity(category: CreateFactInput["category"], value: string): CreateFactInput["claimPolarity"] {
  // Product-catalog fields are explicit category assertions, but their raw values are
  // not automatically positive claims: retain any negation/uncertainty before a
  // validator ever sees a canonical claim.
  if (/^\s*(?:not|no|without|never|neither)\b|\b(?:not|no|without|never|neither)\b[^.]{0,60}\b(?:available|stock|ship|material|leather|brand|price|cost|relief|treat|warranty|guarantee)\b|\b(?:out of stock|sold out|unavailable)\b/i.test(value)) return "negated";
  if (/\b(?:unknown|not specified|see (?:details|listing)|varies|n\/?a)\b/i.test(value)) return "unknown";
  if (category !== "availability") return "affirmed";
  if (/\b(?:not|out of|unavailable|sold out|no longer)\b[^.]{0,40}\b(?:in stock|available|shipping)\b|\b(?:out of stock|unavailable|sold out)\b/i.test(value)) return "negated";
  if (/\b(?:in stock|available now|ready to ship|ships today)\b/i.test(value)) return "affirmed";
  return "unknown";
}

/** Exported for the Amazon fact-card mapping tests (real mapping, not a copy). */
export function buildFacts(body: AnalyzeBody): ReturnType<typeof createFact>[] {
  const facts: CreateFactInput[] = [];
  let index = 0;
  const add = (
    key: string,
    value: unknown,
    source: CreateFactInput["source"],
    trustLevel: CreateFactInput["trustLevel"] = "asserted",
    category: CreateFactInput["category"] = "general",
    commercialAssertion = false,
  ) => {
    const normalized = text(value);
    if (!normalized) return;
    facts.push({
      id: `fact_${++index}`, key, value: normalized, source, trustLevel, category,
      ...(commercialAssertion ? { canonicalClaim: normalized, claimPolarity: commercialPolarity(category, normalized) } : {}),
    });
  };
  const product = body.productContext ?? {};
  add("product_title", product.title, "product_catalog");
  add("product_description", product.description, "product_catalog");
  add("product_vendor", product.vendor ?? product.brand, "product_catalog", "asserted", "brand", true);
  add("product_type", product.productType, "product_catalog");
  add("product_price", product.price, "product_catalog", "asserted", "price", true);
  add("product_availability", product.availability, "product_catalog", "asserted", "availability", true);
  add("product_material", product.material, "product_catalog", "asserted", "material", true);
  add("product_efficacy", product.efficacy, "product_catalog", "asserted", "efficacy", true);
  add("product_quantity", product.quantity, "product_catalog", "asserted", "numeric_commercial", true);
  const tags = texts(product.tags); if (tags.length) add("product_tags", tags.join(", "), "product_catalog");
  const attributes = texts(product.attributes); if (attributes.length) add("product_attributes", attributes.join(", "), "product_catalog");
  const page = body.pageContext ?? {}; add("page_title", page.title, "page_metadata"); add("page_description", page.description, "page_metadata");
  const image = body.imageObserved ?? {}; add("image_summary", image.summary, "image_observed", "observed", "visual_description"); add("visual_style", image.style, "image_observed", "observed", "visual_description");
  const objects = texts(image.objects); if (objects.length) add("visible_objects", objects.join(", "), "image_observed", "observed", "visual_description");
  const colors = texts(image.colors); if (colors.length) add("colors", colors.join(", "), "image_observed", "observed", "visual_description");
  const ocr = texts(image.ocrText); if (ocr.length) add("ocr_text", ocr.join(" "), "image_observed", "observed", "visual_description");
  const board = body.boardContext ?? {}; add("board_name", board.name, "board_context"); add("board_description", board.description, "board_context");
  return facts.map(createFact);
}

function keywordContext(body: AnalyzeBody, locale: string, country: string): KeywordContextInput {
  const product = body.productContext ?? {}, image = body.imageObserved ?? {}, board = body.boardContext ?? {};
  const page = body.pageContext ?? {};
  return {
    imageSummary: text(image.summary) ?? "",
    visibleObjects: texts(image.objects),
    style: text(image.style, 200) ?? "",
    boardName: text(board.name, 200),
    category: text(product.productType, 200),
    language: locale,
    region: country,
    // Keyword RETRIEVAL term only: a fetched page title (Amazon) is used when there is
    // no catalog title. It creates no fact and relaxes no claim rule (design §3.2).
    productTitle: text(product.title) ?? text(page.title),
    productType: text(product.productType, 200),
    productTags: texts(product.tags),
    directionTerms: texts(body.userKeywords),
  };
}

export function createAnalyzeHandler(deps: { videoCoverDeps?: Partial<VideoCoverDeps> } = {}) {
  return async function POST(req: Request) {
  if (process.env.AI_COPY_V2_ENABLED !== "true") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const userId = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized", message: "Authentication required" }, { status: 401 });
  const limit = await consumeRateLimit(userId, "ai_copy_v2_analyze");
  if (!limit.allowed) return NextResponse.json({ ok: false, error: RATE_LIMITED_ERROR, message: RATE_LIMITED_MESSAGE }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });

  let body: AnalyzeBody;
  try { body = await req.json() as AnalyzeBody; } catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }
  if (!body || typeof body !== "object" || badKey(body.draftId) || badKey(body.idempotencyKey) || (body.userKeywords != null && !Array.isArray(body.userKeywords)) || (body.mediaEvidenceMode != null && body.mediaEvidenceMode !== "video_cover")) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const locale = body.locale == null ? "en" : text(body.locale, 35);
  const country = body.country == null ? "US" : text(body.country, 10)?.toUpperCase();
  if (!locale || !country || !validLocale(locale) || !validCountry(country)) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
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
    if (claim.row.expires_at <= new Date().toISOString()) return NextResponse.json({ ok: false, error: "session_expired" }, { status: 404 });
    if (!claim.row.fact_card || !claim.row.keyword_evidence) return NextResponse.json({ ok: false, error: "analysis_failed" }, { status: 502 });
    const degradedMode = claim.row.fact_card.mediaEvidence?.degradedMode === "video_cover_unavailable"
      ? "video_cover_unavailable"
      : claim.row.keyword_evidence.degradedMode;
    return NextResponse.json({ ok: true, sessionId: claim.row.id, draftId: claim.row.draft_id, factCard: claim.row.fact_card, keywordEvidence: claim.row.keyword_evidence, degradedMode, replayed: true });
  }

  try {
    // The persisted owner-scoped media discriminator, never a client mode hint,
    // decides whether client visual assertions are legal inputs.
    const ownedMedia = await resolveOwnedMediaEvidence({ userId, draftId: body.draftId.trim() }, deps.videoCoverDeps);
    const cover = ownedMedia.kind === "image" ? null : ownedMedia.analysis;
    const evidenceBody = ownedMedia.kind === "image"
      ? body
      : { ...body, imageObserved: cover?.imageObserved ?? {} };
    const factCard = createFactCardV1({
      sessionId: claim.row.id, draftId: body.draftId.trim(), locale, facts: buildFacts(evidenceBody),
      ...(cover ? { mediaEvidence: { mode: cover.mode, degradedMode: cover.degradedMode } } : {}),
    });
    const context = keywordContext(evidenceBody, locale, country);
    const rows = await getTrendKeywordLoader()(context).catch(() => []);
    const keywordEvidence = buildKeywordEvidence(rows, context, {
      sessionId: claim.row.id, draftId: body.draftId.trim(), targetLocale: locale,
      userInput: texts(body.userKeywords).join(" "),
      pageMetadata: { title: text(body.pageContext?.title), description: text(body.pageContext?.description) },
    });
    const completed = await store.completeSession({ sessionId: claim.row.id, userId, claimToken: claim.row.claim_token, factCard, keywordEvidence });
    const degradedMode = cover?.degradedMode === "video_cover_unavailable" ? "video_cover_unavailable" : keywordEvidence.degradedMode;
    return NextResponse.json({ ok: true, sessionId: completed.id, draftId: completed.draft_id, factCard, keywordEvidence, degradedMode, replayed: false });
  } catch {
    await store.releaseSessionClaim(claim.row.id, userId, claim.row.claim_token).catch(() => undefined);
    return NextResponse.json({ ok: false, error: "analysis_failed", message: "Unable to analyze right now" }, { status: 502 });
  }
}

}


