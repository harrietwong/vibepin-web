/**
 * POST /api/ai-copy/analyze
 *
 * Upload-time image analysis. Fetches the image, runs ONE vision call to produce a
 * structured analysis (imageSummary / visibleObjects / colors / style / ocrText /
 * category), then retrieves recommended high-search Pinterest keywords for it.
 *
 * The client caches the result on the Pin draft (localStorage) so that a later
 * "Generate copy" can skip vision entirely and use the fast text path.
 *
 * Status contract: 422 = bad/unreadable image; 502 = upstream provider failure;
 * 500 = provider not configured. Never returns fabricated data.
 */

import { NextResponse } from "next/server";
import {
  CopyError,
  PROVIDER_MESSAGE,
  analyzeImageStructured,
  fetchImageAsDataUrl,
  providerConfig,
  devLog,
  elapsed,
  isDev,
} from "@/lib/ai-copy/visionServer";
import { retrievePinterestKeywords } from "@/lib/ai-copy/keywordContext";

export const runtime = "nodejs";

type Body = {
  draftId?: string;
  imageUrl?: string;
  category?: string;
  boardName?: string;
  language?: string;
  country?: string;
  // Linked-product context (best-effort, from the client draft). Improves keyword
  // relevance; safely absent for non-product Pins.
  productTitle?: string;
  productType?: string;
  productTags?: string[];
};

export async function POST(req: Request) {
  const started = performance.now();
  const body = await req.json() as Body;
  const cfg = providerConfig();

  try {
    if (!cfg.key) throw new CopyError("ai_copy_provider_not_configured", 500, PROVIDER_MESSAGE);

    // 1) Fetch + analyze the image (structured JSON, no copy).
    const img = await fetchImageAsDataUrl(body.imageUrl);
    const analysis = await analyzeImageStructured({ cfg, dataUrl: img.dataUrl });
    if (!analysis.imageSummary) {
      throw new CopyError("empty_image_summary", 502, PROVIDER_MESSAGE);
    }
    const analysisLatencyMs = elapsed(started);
    devLog("analyze.image", {
      draftId: body.draftId,
      model: cfg.visionModel,
      imageBytes: img.bytes,
      imageSummary: analysis.imageSummary,
      visibleObjects: analysis.visibleObjects,
      category: analysis.category,
      latencyMs: analysisLatencyMs,
    });

    // 2) Retrieve recommended high-search Pinterest keywords (best-effort).
    const kwStart = performance.now();
    const kw = await retrievePinterestKeywords({
      imageSummary: analysis.imageSummary,
      visibleObjects: analysis.visibleObjects,
      style: analysis.style,
      boardName: body.boardName,
      category: body.category || analysis.category,
      language: body.language,
      region: body.country,
      productTitle: body.productTitle,
      productType: body.productType,
      productTags: Array.isArray(body.productTags) ? body.productTags : undefined,
    });
    const keywordLatencyMs = elapsed(kwStart);
    devLog("analyze.keywords", {
      draftId: body.draftId,
      queryTerms: kw.queryTerms,
      poolSize: kw.poolSize,
      recommended: kw.recommended,
      rejected: kw.rejected,
      latencyMs: keywordLatencyMs,
    });

    return NextResponse.json({
      ok: true,
      analysis: { ...analysis, model: cfg.visionModel },
      recommendedKeywords: kw.recommended,
      keywordSource: "pinterest_high_search" as const,
      timingsMs: { analysis: analysisLatencyMs, keywords: keywordLatencyMs, total: elapsed(started) },
      diagnostics: isDev ? { queryTerms: kw.queryTerms, poolSize: kw.poolSize, rejected: kw.rejected } : undefined,
    });
  } catch (err) {
    const isCopyErr = err instanceof CopyError;
    const status = isCopyErr ? err.status : 502;
    const code = isCopyErr ? err.code : (err as Error)?.message || "analyze_failed";
    const userMessage = isCopyErr ? err.userMessage : PROVIDER_MESSAGE;
    if (isDev) console.warn("[ai-copy/analyze] failure", JSON.stringify({ draftId: body.draftId, status, code }));
    return NextResponse.json({ ok: false, error: code, userMessage }, { status });
  }
}
