import { applyDraftToPinFields, generatePinMetadataDraft } from "@/lib/pinMetadata";
import { parseLimitReached } from "@/lib/usage/limitReached";
import type { LinkedProduct } from "@/lib/pinMetadata";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { coverMedia } from "@/lib/contentDraftModel";
import { waitForPinDraftMediaSync } from "@/lib/pinDraftSync";
import { track, trackLatency } from "@/lib/analytics";
import { AI_COPY_V2_PROMPT_VERSION, COPY_PROMPT_VERSION } from "@/lib/ai-copy/promptVersions";
import { readPinterestRegionFromStorage } from "@/lib/i18n/config";
import type {
  GeneratePinterestPinCopyInput,
  GeneratePinterestPinCopyResult,
  ImageContext,
  KeywordContext,
  PageContext,
  ProductContext,
} from "./types";
import { generatePinterestPinCopyV2, isAICopyV2ClientEnabled } from "./generatePinCopyV2";
import type { AffiliateDisclosureKind } from "./affiliateDisclosure";
import {
  buildAmazonCopyContext,
  buildMarketplaceCopyContext,
  canGenerateAmazonCopy,
  cardSourceForUrl,
  isAmazonAffiliateDraft,
  isMarketplaceCardDraft,
  type AmazonCopyContext,
} from "@/lib/studio/amazonCardSource";

/**
 * Error thrown by generatePinterestPinCopy, carrying a machine-readable `code` so the
 * calling UI can pick the right severity instead of pattern-matching a message.
 *
 * `code === "rate_limited"` means the server's per-user AI cost ceiling was hit
 * (HTTP 429). It is NOT a quality failure and NOT a provider failure: the user simply
 * asked for too much too quickly and the same request will work after a short wait.
 * Callers should surface it with the NEUTRAL toast severity — the same treatment
 * /api/generate's `user_generation_limit` gets in app/app/studio/page.tsx.
 */
export class PinCopyError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "PinCopyError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Amazon card without a product name: generation is refused client-side (no request). */
export const AMAZON_PRODUCT_NAME_REQUIRED = "amazon_product_name_required";

/** Amazon affiliate card while AI Copy v2 is disabled: v1 never attaches the required
 *  #ad affiliate disclosure, so generation is refused client-side (no request) rather
 *  than silently producing undisclosed affiliate copy. */
export const AMAZON_COPY_REQUIRES_V2 = "amazon_copy_requires_v2";

/** True when `err` is the rate-limit stop (429), so the UI can soften the toast. */
export function isRateLimitError(err: unknown): err is PinCopyError | { code: string; status?: number; retryAfterSeconds?: number | null } {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "rate_limited";
}

/**
 * True when the server refused because the plan's AI text allowance is spent (402
 * ai_text_limit_reached). Distinct from `rate_limited`: waiting does NOT fix this, so
 * the UI must show the PRD's upgrade message instead of "try again in a moment".
 */
export function isTextLimitReachedError(err: unknown): err is PinCopyError | { code: string; status?: number; retryAfterSeconds?: number | null } {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ai_text_limit_reached";
}

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

/** Loose read of Shopify-only fields that may ride along on a LinkedProduct snapshot
 *  without widening the LinkedProduct type itself — mirrors the existing
 *  `productWithLooseMeta` cast pattern above. Fields are simply absent (never
 *  fabricated) when the snapshot doesn't carry them. */
type ShopifyLooseLinkedProduct = LinkedProduct & {
  vendor?: string;
  tags?: string[];
  availability?: string;
  productType?: string;
};

/** "USD 19.99" — currency folded into a single display string; undefined when
 *  there is no price to show. */
function formatShopifyPrice(price?: string, currency?: string): string | undefined {
  const trimmed = price?.trim();
  if (!trimmed) return undefined;
  return currency ? `${currency} ${trimmed}` : trimmed;
}

/** The Shopify "Select product" flow (StudioBoard.tsx §3.6) writes `linkedProducts`
 *  directly onto the draft with no `setupSnapshot` — resolve the primary linked
 *  product (by `primaryProductId`, else the first) so that flow still has something
 *  to ground on. Returns undefined unless that product's source is "shopify". */
function resolvePrimaryShopifyProduct(storeDraft?: pinDraftStore.PinDraft | null): ShopifyLooseLinkedProduct | undefined {
  const linked = storeDraft?.linkedProducts?.length
    ? (storeDraft.linkedProducts.find(p => p.productId === storeDraft.primaryProductId) ?? storeDraft.linkedProducts[0])
    : undefined;
  return linked?.source === "shopify" ? (linked as ShopifyLooseLinkedProduct) : undefined;
}

/** Exported for direct unit testing (test-shopify-ai-grounding.ts, WP6 §10) — same
 *  function generatePinterestPinCopy() calls internally, not a parallel copy. */
/**
 * Amazon OR manual-entry-marketplace card context (T3 design §3.2; FR-04 generalizes
 * it to Temu/Shein/AliExpress/TikTok Shop), or null for every other card. The card
 * counts as Amazon/marketplace only while its CURRENT Website URL is that kind of
 * link and it carries an amazonSource (a stale source behind a changed URL is
 * ignored) — same rule for both kinds, unchanged from the original Amazon-only logic.
 *
 * `affiliateDisclosure` (#ad) is an Amazon Associates compliance requirement and is
 * only ever set for the Amazon branch; it is omitted (not `undefined`-valued, simply
 * absent from the object) for marketplace cards, so callers that only spread it when
 * present (`...(amazonContext ? { affiliateDisclosure: ... } : {})`) never attach a
 * disclosure marker to non-Amazon affiliate copy.
 */
export function resolveAmazonCopyContext(
  input: Pick<GeneratePinterestPinCopyInput, "destinationUrl" | "destinationUrlIsCurrent">,
  storeDraft?: pinDraftStore.PinDraft | null,
): (AmazonCopyContext & { affiliateDisclosure?: AffiliateDisclosureKind; canGenerate: boolean }) | null {
  // Studio card: the stored draft is fresh (the card flushes pending edits before
  // generating); the prop copy of the URL can lag one debounce behind. Plan drawer /
  // Batch Edit: the caller's own unsaved URL is the current one.
  const destinationUrl = input.destinationUrlIsCurrent
    ? input.destinationUrl
    : storeDraft?.destinationUrl ?? input.destinationUrl;
  // T4: an Amazon/marketplace URL is a card on EVERY entry point (Plan drawer, Batch
  // Edit), even when it never passed through the Studio card that records
  // amazonSource. The context is derived from the URL (same pure function the card
  // uses), carrying any stored manual facts; without a product name the §2.3 gate
  // applies as on the card.
  const source = cardSourceForUrl(destinationUrl, storeDraft?.amazonSource) ?? undefined;
  if (!source || !isMarketplaceCardDraft({ destinationUrl, amazonSource: source })) return null;
  if (isAmazonAffiliateDraft({ destinationUrl, amazonSource: source })) {
    return { ...buildAmazonCopyContext(source), affiliateDisclosure: "ad_hashtag", canGenerate: canGenerateAmazonCopy(source) };
  }
  // Manual-entry marketplace: same field mapping, no #ad (not an Amazon Associates
  // link), never a page (no fetch ever happens for these hosts).
  return { ...buildMarketplaceCopyContext(source), canGenerate: canGenerateAmazonCopy(source) };
}

export function inferProductContext(input: GeneratePinterestPinCopyInput, storeDraft?: pinDraftStore.PinDraft | null): ProductContext {
  const product = input.setupSnapshot?.selectedProducts?.find(p => p.title?.trim() || p.productUrl?.trim());
  const productWithLooseMeta = product as typeof product & { category?: string; attributes?: string[] } | undefined;
  const base: ProductContext = {
    title: product?.title || undefined,
    category: productWithLooseMeta?.category || input.category || undefined,
    productUrl: product?.productUrl || input.destinationUrl || undefined,
    attributes: productWithLooseMeta?.attributes,
    source: product?.source,
  };

  // Amazon card: user-declared facts only; price/availability are never passed and
  // fetched page text travels separately as pageContext (resolveAmazonCopyContext).
  const amazon = resolveAmazonCopyContext(input, storeDraft);
  if (amazon) {
    return { ...amazon.product, category: base.category, productUrl: base.productUrl };
  }

  const shopify = resolvePrimaryShopifyProduct(storeDraft);
  if (!shopify) return base; // non-Shopify (or no linked product): unchanged.

  return {
    title: base.title || shopify.title || undefined,
    category: base.category || shopify.productType || undefined,
    productUrl: base.productUrl || shopify.productUrl || shopify.canonicalUrl || undefined,
    attributes: base.attributes,
    source: base.source || shopify.source,
    vendor: shopify.vendor || undefined,
    tags: shopify.tags?.length ? shopify.tags.slice(0, 10) : undefined,
    price: formatShopifyPrice(shopify.price, shopify.currency),
    availability: shopify.availability || undefined,
  };
}

/** Direction hint for AI Copy: prefer the draft's recorded creativeSelections (parent
 *  uploads, written when the user picks a direction), else the generated Pin's
 *  setupSnapshot.creativeDirectionSnapshot (AI pins carry it from generation). Returns
 *  a minimal { title, terms } or undefined — copy-context only, never a keyword claim. */
export function resolveDirectionContext(
  storeDraft?: pinDraftStore.PinDraft | null,
): { title: string; terms?: string[] } | undefined {
  const sel = storeDraft?.creativeSelections?.selectedDirection;
  if (sel?.title) return { title: sel.title, terms: sel.terms?.length ? sel.terms.slice(0, 5) : undefined };
  const snap = storeDraft?.setupSnapshot?.creativeDirectionSnapshot;
  if (snap?.selectedDirectionTitle) {
    const gc = snap.guidedControls ?? {};
    const terms = Array.from(new Set(
      [gc.subject, gc.mood, gc.composition].map(v => (typeof v === "string" ? v.trim() : "")).filter(Boolean),
    )).slice(0, 5);
    return { title: snap.selectedDirectionTitle, terms: terms.length ? terms : undefined };
  }
  return undefined;
}

export async function generatePinterestPinCopy(input: GeneratePinterestPinCopyInput): Promise<GeneratePinterestPinCopyResult> {
  const started = performance.now();
  const storeDraft = findStoreDraft(input.draftId, input.imageUrl);
  // Amazon generation gate (design §2.3): no product name (manual or fetched) → stop
  // before ANY request, so nothing is reserved or released.
  const amazonContext = resolveAmazonCopyContext(input, storeDraft);
  if (amazonContext && !amazonContext.canGenerate) {
    throw new PinCopyError(AMAZON_PRODUCT_NAME_REQUIRED, "Add the product name for this Amazon link before generating copy.");
  }
  // Affiliate disclosure gate: v1 (the isAICopyV2ClientEnabled() === false branch below)
  // has no affiliateDisclosure plumbing, so it would silently write Amazon copy with no
  // #ad — an FTC/Pinterest affiliate-disclosure compliance defect, not a quality one.
  // Refuse before any request rather than ship undisclosed affiliate copy.
  if (amazonContext && !isAICopyV2ClientEnabled()) {
    throw new PinCopyError(
      AMAZON_COPY_REQUIRES_V2,
      "Amazon affiliate copy requires the new AI copy generator. Enable it before generating.",
    );
  }
  const selectedCover = storeDraft ? coverMedia(storeDraft) : null;
  if (storeDraft && selectedCover?.kind === "video" && selectedCover.coverFrameTimeMs !== undefined) {
    input.onStage?.("analyzing");
    await waitForPinDraftMediaSync(storeDraft.id);
    input = { ...input, imageUrl: selectedCover.posterUrl ?? "" };
  }
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

  const productContext = inferProductContext(input, storeDraft);
  const isVideoCover = storeDraft ? coverMedia(storeDraft)?.kind === "video" : false;
  const directionContext = resolveDirectionContext(storeDraft);
  const board = input.boards?.find(b => b.id === input.boardId);
  const boardContext = {
    name: board?.name || input.boardName || undefined,
    description: board?.description,
  };

  if (isAICopyV2ClientEnabled()) {
    const country = input.country ?? readPinterestRegionFromStorage();
    const v2 = await generatePinterestPinCopyV2({
      draftId: input.draftId,
      locale: input.language,
      country,
      length: input.length,
      product: productContext,
      ...(amazonContext?.page ? { page: amazonContext.page } : {}),
      ...(amazonContext ? { affiliateDisclosure: amazonContext.affiliateDisclosure } : {}),
      image: isVideoCover ? null : cachedAnalysis,
      imageUrl: isVideoCover ? undefined : input.imageUrl,
      ...(isVideoCover ? { mediaEvidenceMode: "video_cover" as const } : {}),
      board: boardContext,
      userKeywords: [input.keyword, directionContext?.title, ...(directionContext?.terms ?? [])].filter((value): value is string => Boolean(value?.trim())),
      onStage: input.onStage,
    });
    const selectedKeywords = v2.evidence.selectedKeywords.map(item => item.phrase);
    const contextSourcesUsed = Array.from(new Set(v2.evidence.facts.map(fact => fact.source).filter((source): source is NonNullable<typeof source> => Boolean(source))));
    const metadataDraft = generatePinMetadataDraft({
      keyword: input.keyword,
      category: input.category,
      setupSnapshot: input.setupSnapshot,
      promptSnapshot: input.promptSnapshot,
      opportunityTitle: input.opportunity,
      contentLanguage: input.language,
      imageCaption: cachedAnalysis?.imageSummary,
    });
    const baseFields = applyDraftToPinFields(metadataDraft);
    const timingsMs = { regenerationAttempt: attempt, perceivedTotal: Math.round(performance.now() - started) };
    const contextSummary = v2.evidence.degradedMode === "video_cover_unavailable"
      ? `Generated from ${v2.evidence.facts.length} grounded facts; the video cover frame was unavailable.`
      : v2.evidence.degradedMode === "no_keyword_demand_data"
      ? `Generated from ${v2.evidence.facts.length} grounded facts; keyword demand data was unavailable.`
      : `Generated from ${v2.evidence.facts.length} grounded facts and ${selectedKeywords.length} demand-backed keyword${selectedKeywords.length === 1 ? "" : "s"}.`;
    const enhancedDraft = {
      ...metadataDraft,
      selectedTitle: v2.fields.title,
      titleCandidates: [v2.fields.title, ...metadataDraft.titleCandidates.filter(title => title !== v2.fields.title)].slice(0, 3),
      selectedDescription: v2.fields.description,
      descriptionCandidates: [v2.fields.description, ...metadataDraft.descriptionCandidates.filter(description => description !== v2.fields.description)].slice(0, 3),
      altText: v2.fields.altText,
      topics: metadataDraft.topics,
      boardId: input.boardId,
      boardName: input.boardName,
      copyGenerationMeta: {
        generatedAt: new Date().toISOString(),
        provider: "ai-copy-v2",
        model: "server-selected",
        promptVersion: AI_COPY_V2_PROMPT_VERSION,
        strategy: mode,
        contextSourcesUsed,
        keywordTermsUsed: selectedKeywords,
        boardId: input.boardId || undefined,
        language: input.language,
        country,
        contextSummary,
        contextDetails: v2.evidence.facts.map(fact => `${fact.key}: ${fact.value}`),
        timingsMs,
      },
    };
    track("ai_copy_success", {
      draftId: input.draftId, mode, cacheHit, pathUsed: "v2_grounded", keywords: v2.result.usedKeywordIds.length,
      versions: { promptVersion: AI_COPY_V2_PROMPT_VERSION },
    });
    return {
      metadataDraft: enhancedDraft,
      fields: { ...v2.fields, destinationUrl: baseFields.destinationUrl },
      tags: [],
      strategy: mode === "regenerate" ? "regenerate" : "default",
      context: {
        product: productContext,
        board: { boardId: input.boardId, boardName: boardContext.name, boardDescription: boardContext.description },
        keywords: { terms: selectedKeywords, source: selectedKeywords.length ? "cached" : "none" },
        recommendedKeywords: selectedKeywords,
        imageSummary: cachedAnalysis?.imageSummary,
        boardName: boardContext.name ?? null,
        contextSourcesUsed,
        contextSummary,
        contextDetails: v2.evidence.facts.map(fact => `${fact.key}: ${fact.value}`),
        timingsMs,
        provider: "ai-copy-v2",
        model: "server-selected",
        fallbackUsed: false,
        aiCopyV2: v2.evidence,
      },
    };
  }

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
    // Explicit (this is the fetch default): the route authenticates the caller
    // from the Supabase SSR session cookies on this same origin.
    credentials: "same-origin",
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
      directionContext,
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
    // 401 = the session is gone/expired. This is NOT an AI failure: don't count it
    // as a provider or quality failure, and tell the user to sign in rather than
    // implying the model could not write copy for their image.
    if (res.status === 401) {
      throw new PinCopyError("unauthenticated", body.userMessage || "Please sign in to generate copy.");
    }
    // 429 = the server's per-user AI cost ceiling (Phase 1B PR2). This is NOT a
    // quality failure and NOT a provider failure. Before this branch existed it fell
    // through to the generic bucket below, which both told the user "we couldn't
    // generate good copy for this image" (misleading — the image is fine) and
    // counted the request as `ai_copy_quality_failed` in telemetry, corrupting the
    // quality-failure rate. It gets its OWN event and its own error code so the UI
    // can use the neutral toast severity.
    // 402 = the plan's AI text allowance is spent (PRD v3.2 §6.4). Not a quality
    // failure and not a provider failure, so it gets neither telemetry bucket — and
    // crucially not the generic "we couldn't generate good copy" message, which would
    // blame the image for what is a billing state.
    const usageLimit = parseLimitReached(res.status, body);
    if (usageLimit?.kind === "ai_text") {
      throw new PinCopyError("ai_text_limit_reached", usageLimit.message || "AI text limit reached.");
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      track("ai_copy_rate_limited", {
        draftId: input.draftId,
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
      });
      throw new PinCopyError(
        "rate_limited",
        body.userMessage || "You're doing that a bit too fast. Please wait a moment and try again.",
        Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
    // 422 = quality gate (don't write fields); 502 = provider failure. Never leak
    // internal codes (e.g. ai_copy_quality_gate_failed) into the UI.
    if (res.status === 502) track("ai_copy_provider_failed", { draftId: input.draftId, error: body.error ?? null });
    else track("ai_copy_quality_failed", { draftId: input.draftId, error: body.error ?? null, versions: { promptVersion: COPY_PROMPT_VERSION } });
    throw new PinCopyError(
      "ai_copy_failed",
      body.userMessage || "We couldn't generate good copy for this image. Please try again.",
    );
  }

  track("ai_copy_success", {
    draftId: input.draftId,
    mode,
    cacheHit,
    pathUsed: body.pathUsed ?? null,
    keywords: body.output.keywords?.length ?? 0,
    versions: { promptVersion: COPY_PROMPT_VERSION, modelVersion: body.model || undefined },
  });

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
