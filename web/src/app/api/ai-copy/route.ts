import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { retrievePinterestKeywords, type KeywordContextResult } from "@/lib/ai-copy/keywordContext";
import { appendShopifyProductDetails } from "@/lib/ai-copy/shopifyGrounding";
import {
  CopyError,
  GENERIC_COPY_MESSAGE,
  PROVIDER_MESSAGE,
  providerConfig,
  type ProviderConfig,
  chatJson,
  fetchImageAsDataUrl,
  analyzeAndWriteCopy,
  generateCopyFromAnalysis,
  qualityIssues,
  stuffingIssues,
  toImageContext,
  toCopyOutput,
  buildContextBlock,
  normalizeCopyLength,
  LENGTH_LIMITS,
  devLog,
  elapsed,
  isDev,
  safeUrl,
  languageInstructions,
  type GroundingAnalysis,
  type VisionResult,
  type PreviousCopy,
} from "@/lib/ai-copy/visionServer";

export const runtime = "nodejs";

// ── Route-local types + context helpers ──────────────────────────────────────

type ProductContext = {
  title?: string;
  category?: string;
  productUrl?: string;
  attributes?: string[];
  // ── Shopify-only grounding fields (WP6, §3.7.2) — optional, never fabricated ──
  vendor?: string;
  tags?: string[];
  /** Display-formatted, currency already folded in (e.g. "USD 19.99"). */
  price?: string;
  availability?: string;
};
type PageContext = { title?: string; description?: string; domain?: string };
type BoardContext = { name?: string; description?: string };

type RequestBody = {
  draftId?: string;
  imageUrl?: string;
  destinationUrl?: string;
  category?: string;
  keyword?: string;
  language?: string;
  country?: string;
  /** "detailed" is the legacy alias for "seo-rich" (normalized server-side). */
  length?: "short" | "standard" | "seo-rich" | "detailed";
  mode?: "initial" | "regenerate";
  attempt?: number;
  previousCopy?: PreviousCopy;
  productContext?: ProductContext;
  boardContext?: BoardContext;
  /** Picked creative direction — copy-context guidance only (NOT a keyword claim). */
  directionContext?: { title?: string; terms?: string[] };
  // Fast-path inputs: cached image analysis + recommended keywords computed at upload.
  imageAnalysis?: {
    status?: string;
    imageSummary?: string;
    visibleObjects?: string[];
    colors?: string[];
    style?: string;
    ocrText?: string;
    category?: string;
  };
  recommendedKeywords?: string[];
};

const pageContextCache = new Map<string, { value: PageContext; savedAt: number }>();
const PAGE_CACHE_MS = 24 * 60 * 60 * 1000;

function nowId(): string {
  return `copy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getPageContext(destinationUrl: string | undefined): Promise<{ value: PageContext; cacheStatus: "hit" | "miss" | "none" }> {
  const url = safeUrl(destinationUrl);
  if (!url) return { value: {}, cacheStatus: "none" };
  const key = url.toString();
  const hit = pageContextCache.get(key);
  if (hit && Date.now() - hit.savedAt < PAGE_CACHE_MS) return { value: hit.value, cacheStatus: "hit" };
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; VibePin/1.0)" }, signal: AbortSignal.timeout(2500) });
    const html = await res.text();
    const pick = (pattern: RegExp) => html.match(pattern)?.[1]?.replace(/\s+/g, " ").trim();
    const value: PageContext = {
      title: pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        || pick(/<title[^>]*>([^<]+)<\/title>/i)
        || url.pathname.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " "),
      description: pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
        || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i),
      domain: url.hostname.replace(/^www\./, ""),
    };
    pageContextCache.set(key, { value, savedAt: Date.now() });
    return { value, cacheStatus: "miss" };
  } catch {
    const value = { title: url.pathname.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " "), domain: url.hostname.replace(/^www\./, "") };
    return { value, cacheStatus: "miss" };
  }
}

function keywordHints(input: {
  analysis?: GroundingAnalysis | null;
  productContext: ProductContext;
  pageContext: PageContext;
  boardContext: BoardContext;
  category?: string;
}): string[] {
  const raw = [
    ...(input.analysis?.visibleObjects ?? []),
    input.analysis?.style,
    input.productContext.title,
    input.productContext.category,
    input.pageContext.title,
    input.boardContext.name,
    input.category,
  ];
  return Array.from(new Set(raw.map(v => v?.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean) as string[])).slice(0, 10);
}

function contextDetails(a: GroundingAnalysis | null, ctx: {
  productContext: ProductContext;
  pageContext: PageContext;
  boardContext: BoardContext;
  keywords: string[];
}): string[] {
  const lines: string[] = [];
  if (a) lines.push(`Image: ${[a.imageSummary, ...a.visibleObjects.slice(0, 4), ...a.colors.slice(0, 3), a.style].filter(Boolean).join(", ")}`);
  if (ctx.productContext.title || ctx.productContext.category) lines.push(`Product: ${[ctx.productContext.title, ctx.productContext.category].filter(Boolean).join(", ")}`);
  if (ctx.boardContext.name) lines.push(`Board: ${ctx.boardContext.name}`);
  if (ctx.pageContext.title || ctx.pageContext.domain) lines.push(`Page: ${[ctx.pageContext.title, ctx.pageContext.domain].filter(Boolean).join(", ")}`);
  if (ctx.keywords.length) lines.push(`Keywords: ${ctx.keywords.slice(0, 6).join(", ")}`);
  return lines;
}

function sourceSummary(sources: string[], usedKeywords: boolean) {
  if (usedKeywords) return "Based on image and high-search Pinterest keywords";
  if (!sources.length) return "Based on the uploaded image";
  if (sources.length === 1) return `Based on ${sources[0]} context`;
  return `Based on ${sources.slice(0, -1).join(", ")}, and ${sources[sources.length - 1]} context`;
}

/**
 * Vision-fallback refine: weave 2-4 recommended keywords into title/description.
 * Best-effort — callers fall back to the base copy on drift/failure.
 */
async function refineCopyWithKeywords(args: {
  cfg: ProviderConfig;
  analysis: GroundingAnalysis;
  baseTitle: string;
  baseDescription: string;
  recommendedKeywords: string[];
  directionHint?: string;
  boardName?: string;
  language: string;
}): Promise<{ title: string; description: string }> {
  const prompt = [
    "Rewrite this Pinterest Pin's title and description to naturally incorporate relevant high-search keyword concepts.",
    "Return STRICT JSON ONLY: {\"title\":\"\",\"description\":\"\"}.",
    "Rules:",
    "- Stay grounded in the image (do not add objects or details that are not in the analysis below).",
    "- The title stays Pinterest-style, natural and readable (max ~90 chars) — NOT a list of keywords.",
    "- The description may weave in 2-4 keyword concepts naturally across 1-3 sentences. Do NOT keyword-stuff.",
    "- Only use keywords that genuinely fit this image. Ignore any that do not.",
    "- Do not use generic filler (Home Decor Product Inspiration, Pinterest look, etc.).",
    ...languageInstructions(args.language),
    `Image analysis:\n${JSON.stringify({ imageSummary: args.analysis.imageSummary, visibleObjects: args.analysis.visibleObjects, colors: args.analysis.colors, style: args.analysis.style }, null, 2)}`,
    args.directionHint ? `Creative direction to reflect in tone/framing (guidance only — do not quote): ${args.directionHint}` : "",
    args.boardName ? `Pinterest board (context only — translate/paraphrase unless it is a proper noun): ${args.boardName}` : "",
    `Recommended high-search keyword CONCEPTS to consider (English-language SEO reference terms — translate/paraphrase into the target language; use only the fitting ones, and only quote verbatim if the target language is English):\n${args.recommendedKeywords.join(", ")}`,
    `Current copy:\n${JSON.stringify({ title: args.baseTitle, description: args.baseDescription }, null, 2)}`,
  ].filter(Boolean).join("\n\n");

  const raw = await chatJson({
    key: args.cfg.key,
    baseUrl: args.cfg.baseUrl,
    model: args.cfg.textModel,
    timeoutMs: 14_000,
    temperature: 0.5,
    messages: [
      { role: "system", content: "You are an expert Pinterest copywriter. You write natural, readable, image-grounded copy and never keyword-stuff. Output JSON only." },
      { role: "user", content: prompt },
    ],
  }) as { title?: unknown; description?: unknown };

  return {
    title: (typeof raw.title === "string" ? raw.title.trim() : "").slice(0, 100),
    description: (typeof raw.description === "string" ? raw.description.trim() : "").slice(0, 500),
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * User-safe 401 message. Mirrors the shape of every other failure on this route
 * ({ ok:false, error, userMessage }) so the client's existing error path renders
 * it without special-casing, while `error: "unauthenticated"` lets callers tell a
 * sign-in problem apart from an AI/provider problem.
 */
const UNAUTHENTICATED_MESSAGE = "Please sign in to generate copy.";

export async function POST(req: Request) {
  const requestId = nowId();
  const started = performance.now();
  const timings: Record<string, number> = {};

  // AUTHENTICATION FIRST — before body parsing, provider configuration, image
  // fetching and every provider call below. This route spends real provider money
  // per request; an anonymous caller must not be able to reach a single outbound
  // call, nor to make us parse an attacker-sized body.
  const userId = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!userId) {
    return NextResponse.json(
      { ok: false, requestId, error: "unauthenticated", userMessage: UNAUTHENTICATED_MESSAGE },
      { status: 401 },
    );
  }

  const body = await req.json() as RequestBody;
  const cfg = providerConfig();
  const mode = body.mode ?? "initial";
  const language = body.language ?? "en";
  // PRD 6.3 presets; legacy "detailed" wire value normalizes to seo-rich.
  const copyLength = normalizeCopyLength(body.length);
  const lengthLimits = LENGTH_LIMITS[copyLength];
  const productContext = body.productContext ?? {};
  const boardContext = body.boardContext ?? {};
  // Direction hint: a compact "Creative direction: <title> — <terms>" string woven into
  // the copy prompt as guidance (concept reference), kept SEPARATE from recommended
  // keywords so it never leaks into displayed tags / the "high-search keyword" claim.
  const directionHint = ((): string | undefined => {
    const title = body.directionContext?.title?.trim();
    if (!title) return undefined;
    const terms = (body.directionContext?.terms ?? []).map(t => t.trim()).filter(Boolean).slice(0, 5);
    return terms.length ? `${title} — ${terms.join(", ")}` : title;
  })();

  // Fast path is available when the client sends a ready cached analysis.
  const cachedAnalysis: GroundingAnalysis | null = body.imageAnalysis?.imageSummary
    ? {
        imageSummary: body.imageAnalysis.imageSummary,
        visibleObjects: Array.isArray(body.imageAnalysis.visibleObjects) ? body.imageAnalysis.visibleObjects : [],
        colors: Array.isArray(body.imageAnalysis.colors) ? body.imageAnalysis.colors : [],
        style: body.imageAnalysis.style ?? "",
        ocrText: body.imageAnalysis.ocrText ?? "",
        category: body.imageAnalysis.category ?? "",
      }
    : null;
  const pathUsed = cachedAnalysis ? "fast_text" : "vision_fallback";

  const diagnostics = {
    requestId,
    draftId: body.draftId,
    imageUrl: isDev ? body.imageUrl : undefined,
    mode,
    pathUsed,
    imageSummary: "",
    keywordContext: [] as string[],
    promptVersion: "ai_copy_v6_cached_analysis",
    provider: cfg.provider,
    qualityIssues: [] as string[],
    totalLatencyMs: 0,
  };

  // Granular latency marks (ms since request received). Returned in dev only.
  const marks: Record<string, number> = {};
  const mark = (name: string) => { marks[name] = elapsed(started); };
  let retryCount = 0;
  let gateResult = "pass";
  let promptCharsEstimate = 0;

  try {
    if (!cfg.key) throw new CopyError("ai_copy_provider_not_configured", 500, PROVIDER_MESSAGE);
    mark("received");

    let result: VisionResult;
    let groundingAnalysis: GroundingAnalysis;
    let recommended: string[];
    let keywordsUsed = false;
    let pageContext: PageContext = {};
    mark("contextLoaded");

    if (cachedAnalysis) {
      // ── FAST PATH: cached analysis → ONE text-only model call. No image fetch,
      //    no page-context fetch, no keyword DB query (keywords were precomputed at
      //    upload). Quality gate is regex-only (no extra model call).
      groundingAnalysis = cachedAnalysis;
      mark("cacheLoaded");
      // Trust the client's precomputed keywords (even if empty) — never re-query here.
      recommended = (body.recommendedKeywords ?? []).slice(0, 8);
      mark("keywordsLoaded");
      promptCharsEstimate = cachedAnalysis.imageSummary.length
        + cachedAnalysis.visibleObjects.join(",").length
        + recommended.join(",").length + 300;
      mark("promptBuilt");

      const modelStart = performance.now();
      mark("modelStart");
      result = await generateCopyFromAnalysis({ cfg, analysis: cachedAnalysis, recommendedKeywords: recommended, directionHint, boardName: boardContext.name, category: body.category, language, length: copyLength, mode, previousCopy: body.previousCopy });
      mark("modelDone");
      let issues = [...qualityIssues(result, body.previousCopy), ...stuffingIssues(result.description, recommended)];
      mark("gateDone");
      // Retry ONLY when the gate actually failed (rare on a grounded cached analysis).
      if (issues.length) {
        retryCount = 1;
        const retry = await generateCopyFromAnalysis({ cfg, analysis: cachedAnalysis, recommendedKeywords: recommended, directionHint, boardName: boardContext.name, category: body.category, language, length: copyLength, mode: "regenerate", previousCopy: { title: result.title, description: result.description } });
        const retryIssues = [...qualityIssues(retry, body.previousCopy), ...stuffingIssues(retry.description, recommended)];
        if (retryIssues.length < issues.length || !retryIssues.length) { result = retry; issues = retryIssues; }
        mark("retryDone");
      }
      timings.model = Math.round(performance.now() - modelStart);
      diagnostics.qualityIssues = issues;
      diagnostics.imageSummary = result.imageSummary;
      gateResult = issues.length ? `fail:${issues.join(",")}` : "pass";
      if (issues.length) {
        devLog("quality_gate_failed", { draftId: body.draftId, path: pathUsed, issues, title: result.title });
        throw new CopyError(`ai_copy_quality_gate_failed:${issues.join(",")}`, 422, GENERIC_COPY_MESSAGE);
      }
      // keywordsUsed is decided later from the FINAL output (truthful-claim check).
    } else {
      // ── VISION FALLBACK: analysis not cached → page context + image fetch + vision.
      const page = await getPageContext(body.destinationUrl);
      pageContext = page.value;
      const img = await fetchImageAsDataUrl(body.imageUrl);
      timings.imageFetch = img.latencyMs;
      mark("imageFetched");
      const hints = keywordHints({ analysis: null, productContext, pageContext, boardContext, category: body.category });
      const contextBlock = appendShopifyProductDetails(
        buildContextBlock({ productContext, pageContext, boardContext, keywords: hints, category: body.category, directionHint }),
        productContext,
      );
      mark("promptBuilt");

      const modelStart = performance.now();
      mark("modelStart");
      result = await analyzeAndWriteCopy({ cfg, dataUrl: img.dataUrl, contextBlock, language, mode, previousCopy: body.previousCopy });
      mark("modelDone");
      let issues = qualityIssues(result, body.previousCopy);
      mark("gateDone");
      if (issues.length) {
        retryCount = 1;
        const retry = await analyzeAndWriteCopy({ cfg, dataUrl: img.dataUrl, contextBlock, language, mode: "regenerate", cachedAnalysis: result, previousCopy: { title: result.title, description: result.description } });
        const retryIssues = qualityIssues(retry, body.previousCopy);
        if (retryIssues.length < issues.length || !retryIssues.length) { result = retry; issues = retryIssues; }
      }
      timings.model = Math.round(performance.now() - modelStart);
      diagnostics.qualityIssues = issues;
      diagnostics.imageSummary = result.imageSummary;
      gateResult = issues.length ? `fail:${issues.join(",")}` : "pass";
      if (issues.length) {
        devLog("quality_gate_failed", { draftId: body.draftId, path: pathUsed, issues, title: result.title });
        throw new CopyError(`ai_copy_quality_gate_failed:${issues.join(",")}`, 422, GENERIC_COPY_MESSAGE);
      }
      groundingAnalysis = { imageSummary: result.imageSummary, visibleObjects: result.visibleObjects, colors: result.colors, style: result.style };

      // Retrieve keywords + refine to weave them in (best-effort; slow-path only).
      let kw: KeywordContextResult = { queryTerms: [], candidates: [], recommended: [], rejected: [], poolSize: 0 };
      try {
        kw = await retrievePinterestKeywords({ imageSummary: groundingAnalysis.imageSummary, visibleObjects: groundingAnalysis.visibleObjects, style: groundingAnalysis.style, boardName: boardContext.name, category: body.category, language: body.language, region: body.country });
      } catch { /* best-effort */ }
      recommended = kw.recommended;
      if (recommended.length) {
        try {
          const refined = await refineCopyWithKeywords({ cfg, analysis: groundingAnalysis, baseTitle: result.title, baseDescription: result.description, recommendedKeywords: recommended, directionHint, boardName: boardContext.name, language });
          const refinedVision: VisionResult = { ...result, title: refined.title, description: refined.description };
          const refineIssues = [...qualityIssues(refinedVision, body.previousCopy), ...stuffingIssues(refined.description, recommended)];
          if (!refineIssues.length && refined.title && refined.description) { result = refinedVision; }
        } catch { /* keep base copy */ }
      }
    }

    // ── Shared response building ──────────────────────────────────────────────
    const imageContext = toImageContext(groundingAnalysis);
    // Tags: recommended high-search keywords first, then any model-generated tags
    // (vision path), then visible objects as a fallback (fast path drops model tags).
    const modelTags = toCopyOutput(result).tags;
    const objectTags = groundingAnalysis.visibleObjects.map(o => o.toLowerCase().trim()).filter(Boolean);
    const mergedKeywords = Array.from(new Set([...recommended, ...modelTags, ...objectTags].map(k => k.toLowerCase()))).slice(0, 12);
    const output = {
      // Preset caps enforced AFTER generation (PRD 6.3), inside the global 100/500.
      title: result.title.slice(0, Math.min(100, lengthLimits.title)),
      description: result.description.slice(0, Math.min(500, lengthLimits.desc)),
      altText: (result.altText || result.imageSummary).slice(0, 500),
      tags: mergedKeywords,
      keywords: mergedKeywords,
    };
    diagnostics.keywordContext = mergedKeywords;

    // Truthful keyword claim (PRD 7.2): only say copy is "based on high-search
    // Pinterest keywords" when the FINAL output demonstrably contains at least one
    // recommended keyword concept — being handed keywords is not using them.
    const outText = `${output.title} ${output.description}`.toLowerCase();
    keywordsUsed = recommended.some(k => {
      const words = k.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (!words.length) return false;
      const hits = words.filter(w => outText.includes(w)).length;
      return hits >= Math.min(2, words.length);
    });

    const sources: string[] = ["image"];
    if (productContext.title || productContext.category) sources.push("product");
    if (pageContext.title || pageContext.domain) sources.push("page");
    if (boardContext.name) sources.push("Board");
    if (keywordsUsed) sources.push("high-search keyword");

    const contextUsed = {
      imageSummary: groundingAnalysis.imageSummary,
      recommendedKeywords: recommended,
      boardName: boardContext.name ?? null,
    };

    mark("returned");
    const totalLatencyMs = elapsed(started);
    diagnostics.totalLatencyMs = totalLatencyMs;
    const modelUsed = cachedAnalysis ? cfg.textModel : cfg.visionModel;

    // Per-request observability line (server log, not UI). Task 4.
    console.info("[ai-copy]", JSON.stringify({
      requestId, pathUsed, modelUsed, provider: cfg.provider,
      promptChars: promptCharsEstimate, retryCount, qualityGateResult: gateResult,
      latencyMs: totalLatencyMs, modelMs: timings.model,
    }));
    devLog("success", { ...diagnostics, output, contextUsed, marks });

    return NextResponse.json({
      ok: true,
      requestId,
      pathUsed,
      output,
      contextUsed,
      context: {
        imageContext,
        productContext,
        pageContext,
        boardContext,
        keywordContext: mergedKeywords,
        recommendedKeywords: recommended,
        imageSummary: groundingAnalysis.imageSummary,
        boardName: boardContext.name ?? null,
        trendContext: [],
      },
      contextSourcesUsed: sources,
      contextSummary: sourceSummary(sources, keywordsUsed),
      contextDetails: contextDetails(groundingAnalysis, { productContext, pageContext, boardContext, keywords: mergedKeywords }),
      timingsMs: { ...timings, total: totalLatencyMs },
      provider: cfg.provider,
      model: modelUsed,
      promptVersion: diagnostics.promptVersion,
      fallbackUsed: pathUsed === "vision_fallback",
      // Detailed step-by-step timings + observability — DEV ONLY (never in prod UI).
      diagnostics: isDev ? { ...diagnostics, recommended, modelUsed, retryCount, qualityGateResult: gateResult, promptChars: promptCharsEstimate, marks } : undefined,
    });
  } catch (err) {
    diagnostics.totalLatencyMs = elapsed(started);
    const isCopyErr = err instanceof CopyError;
    const status = isCopyErr ? err.status : 502;
    const code = isCopyErr ? err.code : (err as Error)?.message || "ai_copy_failed";
    const userMessage = isCopyErr ? err.userMessage : PROVIDER_MESSAGE;
    if (isDev) console.warn("[ai-copy] failure", JSON.stringify({ ...diagnostics, status, code }, null, 2));
    return NextResponse.json({ ok: false, requestId, error: code, userMessage, diagnostics: isDev ? diagnostics : undefined }, { status });
  }
}
