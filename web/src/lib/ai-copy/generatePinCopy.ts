import { applyDraftToPinFields, generatePinMetadataDraft } from "@/lib/pinMetadata";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { track, trackLatency } from "@/lib/analytics";
import type {
  GeneratePinterestPinCopyInput,
  GeneratePinterestPinCopyResult,
  ImageContext,
  KeywordContext,
  PageContext,
  ProductContext,
} from "./types";

const UI_STAGE_YIELD_MS = 40;
// How long "Generate copy" waits for an in-flight upload-time analysis to finish
// before falling back to the vision one-call path.
const ANALYSIS_WAIT_TRIES = 6;
const ANALYSIS_WAIT_MS = 400;

function yieldForUi(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, UI_STAGE_YIELD_MS));
}

type CachedAnalysis = {
  status: "ready";
  imageSummary: string;
  visibleObjects: string[];
  colors: string[];
  style: string;
  ocrText: string;
  category: string;
};

/** Look up the backing pinDraftStore draft by id, then by imageUrl (Batch Edit rows). */
function findStoreDraft(draftId: string, imageUrl?: string) {
  return pinDraftStore.getDraft(draftId) ?? (imageUrl ? pinDraftStore.getDraftByImageUrl(imageUrl) : null);
}

/**
 * Resolve cached image analysis for the fast path. Prefers an explicitly-provided
 * analysis; otherwise reads pinDraftStore (by id then imageUrl), briefly polling while
 * an upload-time analysis is still pending. Returns null when unavailable → vision fallback.
 */
async function resolveCachedAnalysis(
  input: GeneratePinterestPinCopyInput,
): Promise<{ analysis: CachedAnalysis | null; recommendedKeywords: string[] }> {
  if (input.imageAnalysis && input.imageAnalysis.imageSummary) {
    return {
      analysis: { status: "ready", ...input.imageAnalysis },
      recommendedKeywords: input.recommendedKeywords ?? [],
    };
  }
  let d = findStoreDraft(input.draftId, input.imageUrl);
  for (let i = 0; i < ANALYSIS_WAIT_TRIES && d?.imageAnalysisStatus === "pending"; i++) {
    await new Promise(r => setTimeout(r, ANALYSIS_WAIT_MS));
    d = findStoreDraft(input.draftId, input.imageUrl);
  }
  if (d?.imageAnalysisStatus === "ready" && d.imageSummary) {
    return {
      analysis: {
        status: "ready",
        imageSummary: d.imageSummary,
        visibleObjects: d.visibleObjects ?? [],
        colors: d.colors ?? [],
        style: d.style ?? "",
        ocrText: d.ocrText ?? "",
        category: d.imageCategory ?? "",
      },
      recommendedKeywords: input.recommendedKeywords ?? d.recommendedKeywords ?? [],
    };
  }
  return { analysis: null, recommendedKeywords: input.recommendedKeywords ?? [] };
}

function inferProductContext(input: GeneratePinterestPinCopyInput): ProductContext {
  const product = input.setupSnapshot?.selectedProducts?.find(p => p.title?.trim() || p.productUrl?.trim());
  const productWithLooseMeta = product as typeof product & { category?: string; attributes?: string[] } | undefined;
  return {
    title: product?.title || undefined,
    category: productWithLooseMeta?.category || input.category || undefined,
    productUrl: product?.productUrl || input.destinationUrl || undefined,
    attributes: productWithLooseMeta?.attributes,
    source: product?.source,
  };
}

export async function generatePinterestPinCopy(input: GeneratePinterestPinCopyInput): Promise<GeneratePinterestPinCopyResult> {
  const started = performance.now();
  const storeDraft = findStoreDraft(input.draftId, input.imageUrl);
  const previousMeta = storeDraft?.metadataDraft?.copyGenerationMeta;
  // Mode: caller override wins; else derive from whether copy was generated before.
  const mode = input.mode ?? (previousMeta ? "regenerate" : "initial");
  const attempt = mode === "regenerate"
    ? Number(previousMeta?.timingsMs?.regenerationAttempt ?? 1) + 1
    : 1;
  const previousCopy = mode === "regenerate"
    ? (input.previousCopy ?? { title: input.title ?? storeDraft?.title, description: input.description ?? storeDraft?.description })
    : undefined;

  track("ai_copy_generate_clicked", { draftId: input.draftId, mode });

  // Fast path: reuse the upload-time analysis + recommended keywords when ready
  // (regenerate reuses them too, so vision never re-runs). Falls back to vision.
  input.onStage?.("analyzing");
  await yieldForUi();
  const { analysis: cachedAnalysis, recommendedKeywords } = await resolveCachedAnalysis(input);
  const cacheHit = !!cachedAnalysis;

  const productContext = inferProductContext(input);
  const board = input.boards?.find(b => b.id === input.boardId);
  const boardContext = {
    name: board?.name || input.boardName || undefined,
    description: board?.description,
  };

  input.onStage?.("generating");
  await yieldForUi();

  // The Pinterest keyword DB is English-only — never weave English keywords into
  // non-English copy. Fast path still runs (cached analysis), just without keywords.
  const isEnglish = (input.language ?? "en").toLowerCase().startsWith("en");

  // Progressive perceived-speed states: after the model has likely finished
  // writing, show "Checking quality..." while we await the response.
  const checkTimer = setTimeout(() => input.onStage?.("checking"), cacheHit ? 4000 : 9000);

  const requestStart = performance.now();
  const res = await fetch("/api/ai-copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      draftId: input.draftId,
      imageUrl: input.imageUrl,
      destinationUrl: input.destinationUrl,
      category: input.category,
      keyword: input.keyword,
      language: input.language,
      country: input.country,
      length: input.length,
      mode,
      attempt,
      previousCopy,
      productContext,
      boardContext,
      imageAnalysis: cachedAnalysis ?? undefined,
      recommendedKeywords: cachedAnalysis && isEnglish ? recommendedKeywords : undefined,
    }),
  }).finally(() => clearTimeout(checkTimer));

  const body = await res.json() as {
    ok?: boolean;
    requestId?: string;
    error?: string;
    userMessage?: string;
    output?: {
      title?: string;
      description?: string;
      tags?: string[];
      keywords?: string[];
      altText?: string;
    };
    contextUsed?: {
      imageSummary?: string;
      recommendedKeywords?: string[];
      boardName?: string | null;
    };
    context?: {
      imageContext?: ImageContext | null;
      productContext?: ProductContext;
      pageContext?: PageContext;
      boardContext?: { name?: string; description?: string };
      keywordContext?: string[];
      recommendedKeywords?: string[];
      imageSummary?: string;
      boardName?: string | null;
      trendContext?: Array<{ term: string; signal?: string; source?: string }>;
    };
    promptContext?: unknown;
    contextSourcesUsed?: string[];
    contextSummary?: string;
    contextDetails?: string[];
    timingsMs?: Record<string, number>;
    provider?: string;
    model?: string;
    promptVersion?: string;
    pathUsed?: string;
    fallbackUsed?: boolean;
  };

  const clickToCopyMs = performance.now() - requestStart;
  trackLatency("generate_click_to_copy", clickToCopyMs, { draftId: input.draftId, mode, cacheHit, pathUsed: body.pathUsed ?? null });

  if (!res.ok || !body.ok || !body.output?.title || !body.output.description || !body.output.altText) {
    // 422 = quality gate (don't write fields); 502 = provider failure. Never leak
    // internal codes (e.g. ai_copy_quality_gate_failed) into the UI.
    if (res.status === 502) track("ai_copy_provider_failed", { draftId: input.draftId, error: body.error ?? null });
    else track("ai_copy_quality_failed", { draftId: input.draftId, error: body.error ?? null });
    throw new Error(body.userMessage || "We couldn't generate good copy for this image. Please try again.");
  }

  track("ai_copy_success", { draftId: input.draftId, mode, cacheHit, pathUsed: body.pathUsed ?? null, keywords: body.output.keywords?.length ?? 0 });

  const metadataDraft = generatePinMetadataDraft({
    keyword: input.keyword,
    category: input.category,
    setupSnapshot: input.setupSnapshot,
    promptSnapshot: input.promptSnapshot,
    opportunityTitle: input.opportunity,
    contentLanguage: input.language,
    imageCaption: body.context?.imageContext?.primarySubjects?.join(", ") || body.context?.imageContext?.primarySubject,
  });
  const baseFields = applyDraftToPinFields(metadataDraft);
  const timingsMs = {
    ...(body.timingsMs ?? {}),
    regenerationAttempt: attempt,
    perceivedTotal: Math.round(performance.now() - started),
  };

  const enhancedDraft = {
    ...metadataDraft,
    selectedTitle: body.output.title,
    titleCandidates: [body.output.title, ...metadataDraft.titleCandidates.filter(t => t !== body.output?.title)].slice(0, 3),
    selectedDescription: body.output.description,
    descriptionCandidates: [body.output.description, ...metadataDraft.descriptionCandidates.filter(d => d !== body.output?.description)].slice(0, 3),
    altText: body.output.altText,
    topics: Array.isArray(body.output.tags) ? body.output.tags : metadataDraft.topics,
    boardId: input.boardId,
    boardName: input.boardName,
    copyGenerationMeta: {
      generatedAt: new Date().toISOString(),
      provider: body.provider || "unknown",
      model: body.model || "unknown",
      promptVersion: body.promptVersion || "ai_copy_v3_structured",
      strategy: mode,
      contextSourcesUsed: body.contextSourcesUsed ?? [],
      keywordTermsUsed: body.context?.keywordContext ?? [],
      boardId: input.boardId || undefined,
      language: input.language,
      country: input.country,
      contextSummary: body.contextSummary || "Based on generated context",
      contextDetails: body.contextDetails ?? [],
      timingsMs,
    },
  };

  return {
    metadataDraft: enhancedDraft,
    fields: {
      title: body.output.title,
      description: body.output.description,
      altText: body.output.altText,
      destinationUrl: baseFields.destinationUrl,
    },
    tags: Array.isArray(body.output.tags) ? body.output.tags : [],
    strategy: mode === "regenerate" ? "regenerate" : "default",
    context: {
      image: body.context?.imageContext ? { ...body.context.imageContext, source: "cached" } : undefined,
      product: body.context?.productContext,
      page: body.context?.pageContext,
      board: {
        boardId: input.boardId || undefined,
        boardName: body.context?.boardContext?.name,
        boardDescription: body.context?.boardContext?.description,
      },
      keywords: {
        terms: body.context?.keywordContext ?? [],
        source: (body.context?.keywordContext?.length ? "heuristic" : "none") as KeywordContext["source"],
      },
      recommendedKeywords: body.contextUsed?.recommendedKeywords ?? body.context?.recommendedKeywords ?? [],
      imageSummary: body.contextUsed?.imageSummary ?? body.context?.imageSummary,
      boardName: body.contextUsed?.boardName ?? body.context?.boardName ?? null,
      trendContext: body.context?.trendContext ?? [],
      contextSourcesUsed: body.contextSourcesUsed ?? [],
      contextSummary: body.contextSummary || "Based on generated context",
      contextDetails: body.contextDetails ?? [],
      timingsMs,
      requestId: body.requestId,
      provider: body.provider,
      model: body.model,
      fallbackUsed: body.fallbackUsed,
      promptContext: body.promptContext,
    },
  };
}
