/**
 * The Create Pins generation run, extracted from StudioBoard.handleAiGenerate so it
 * can be driven by tests.
 *
 * Why this exists: every previous test of this behaviour hand-wrote the patch it
 * expected the component to apply, then asserted its own hand-written value. Such a
 * test passes no matter what the component actually does — which is how a retry path
 * that disabled Generate, and a cache key that never matched, both shipped green.
 * Tests now call THIS function with fake side-effects and assert what it really did.
 *
 * Everything with an external effect (draft store, generation API, analysis/judge
 * triggers, toasts, drawer state) is injected. The logic itself — group planning,
 * product-link resolution, placeholder lineage, serial execution, failure isolation
 * — lives here unchanged.
 */

import type { PinDraft } from "@/lib/pinDraftStore";
import type { SetupSnapshot } from "@/lib/studioPersistence";
import type { AiVersionOptions } from "@/components/studio/AiVersionDrawer";
import type { LinkedProduct } from "@/lib/pinMetadata";
import { planReferenceGroups } from "@/lib/studio/selectedReferences";
import { resolveProductPublicUrl, toLinkedProduct } from "@/lib/studio/productSelection";
import { PRODUCT_DERIVED_URL_SOURCE } from "@/lib/studio/destinationUrlDerivation";

/**
 * The draft-store surface this run needs. Typed off the real module so a fake in a
 * test cannot drift from the production signature.
 */
export type GenerationStore = {
  createBoardDraft: (input: Parameters<typeof import("@/lib/pinDraftStore").createBoardDraft>[0]) => PinDraft;
  updateDraft: (id: string, patch: Partial<PinDraft>) => void;
  completeGeneratedDraft: (id: string, url: string) => void;
  failGeneratedDraft: (id: string) => void;
};

export type GenerationResult = { urls: string[] };

export type RunAiGenerationDeps = {
  store: GenerationStore;
  /** One call per reference group. Rejecting fails only that group. */
  generate: (args: { styleReference: string | null; batchRequestId: string; setup: AiVersionOptions }) => Promise<GenerationResult>;
  resolveModelLabel: (a: undefined, modelKey: string) => string;
  onAnalyze?: (draftId: string) => void;
  onJudge?: (draftId: string) => void;
  /** Called once all placeholders exist — the UI closes the drawer here. */
  onPlaceholdersReady?: (totalPins: number) => void;
  onGroupProgress?: (current: number, total: number) => void;
  onSettled?: (summary: { okCount: number; failCount: number }) => void;
  now?: () => number;
  randomId?: () => string;
};

export type RunAiGenerationInput = {
  parent: PinDraft | null;
  opts: AiVersionOptions;
  /**
   * Where these Pins are meant to publish, when the run started from a prefill that
   * named an account (e.g. "Generate based on this insight" on account B).
   *
   * Applied to every placeholder at creation. Absent for an ordinary run, which
   * leaves the drafts untargeted exactly as before — this never overwrites a target
   * with nothing.
   */
  destinationPatch?: { targetConnectionId: string; boardId?: string; boardName?: string } | null;
};

/**
 * Resolve the product state every generated Pin should carry.
 *
 * A product arrives ONLY when the user actively chose one this session (the drawer
 * gates on that). Otherwise a version run inherits the parent's COMPLETE state —
 * all links, its own primaryProductId, and its destinationUrl *and provenance*
 * verbatim, so a hand-edited parent URL is never re-derived away.
 *
 * Returns null when there is no product on either side: a generated Pin must not
 * invent a product link.
 */
export function resolveProductLinkPatch(
  chosenProduct: AiVersionOptions["primaryProductSelection"],
  parent: PinDraft | null,
): Partial<PinDraft> | null {
  if (chosenProduct) {
    const linked: LinkedProduct = toLinkedProduct({ ...chosenProduct, asPrimary: true });
    const url = resolveProductPublicUrl(chosenProduct);
    return {
      linkedProducts: [linked],
      primaryProductId: linked.productId,
      // Provenance is required: without it, later derivation sees an unknown source,
      // treats the URL as manual, and refuses to update or clear it.
      ...(url ? { destinationUrl: url, destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE } : {}),
    };
  }
  const parentLinked = parent?.linkedProducts?.length ? parent.linkedProducts : null;
  if (!parentLinked) return null;
  return {
    linkedProducts: parentLinked,
    primaryProductId: parent?.primaryProductId ?? parentLinked[0]?.productId,
    ...(parent?.destinationUrl
      ? { destinationUrl: parent.destinationUrl, destinationUrlSource: parent.destinationUrlSource }
      : {}),
  };
}

export async function runAiGeneration(
  input: RunAiGenerationInput,
  deps: RunAiGenerationDeps,
): Promise<{ okCount: number; failCount: number; requestId: string; totalPins: number }> {
  const { parent, opts, destinationPatch } = input;
  const { store, generate, resolveModelLabel } = deps;
  const now = deps.now ?? (() => Date.now());
  const rand = deps.randomId ?? (() => Math.random().toString(36).slice(2, 8));

  const requestId = `board_${now()}_${rand()}`;
  const perGroup = Math.max(1, opts.count || 1);
  // One group per style reference; no references still yields exactly one group.
  const groups = planReferenceGroups(opts.selectedReferences ?? [], perGroup);
  const totalPins = groups.length * perGroup;

  const chosenProduct = opts.primaryProductSelection ?? null;
  const productLinkPatch = resolveProductLinkPatch(chosenProduct, parent);

  const setupSnapshot = {
    mode: parent ? ("board_ai_version" as const) : ("board_ai_scratch" as const),
    keyword: parent?.keyword,
    category: opts.category || parent?.category,
    opportunityTitle: parent?.opportunity,
    noTextOverlay: true,
    imagesPerReference: opts.count,
    selectedProducts: opts.productImages.map((imageUrl, index) => ({
      imageUrl,
      title: opts.productMetadata[index]?.title || parent?.title || `Product ${index + 1}`,
      productUrl: opts.productMetadata[index]?.productUrl,
    })),
    selectedReferences: opts.referenceImages.map(imageUrl => ({ imageUrl })),
    promptSnapshot: opts.directionBrief,
    creativeDirectionSnapshot: opts.creativeDirectionMeta,
    createdFrom: "studio_board",
    format: opts.format,
    model: resolveModelLabel(undefined, opts.modelKey),
    modelKey: opts.modelKey,
  } as unknown as SetupSnapshot;

  // ALL placeholders exist before the first group runs, so the user sees the true
  // batch size immediately. Each already carries its group's reference association,
  // which is what makes per-group failure fallback and Retry resolvable.
  const groupPlaceholders = groups.map(group =>
    Array.from({ length: group.requestCount }, (_, i) => {
      const placeholder = store.createBoardDraft({
        imageUrl: parent?.imageUrl ?? "",
        source: "ai_generated_from_upload",
        idempotencyKey: `gen:${requestId}:${group.index}:${i}`,
        generationStatus: "generating",
        parentDraftId: parent?.id, sourceImageUrl: parent?.imageUrl,
        referenceId: group.reference?.id,
        referenceImageUrl: group.reference?.imageUrl,
        referenceSource: group.reference?.source,
        title: parent?.title ?? chosenProduct?.title,
        keyword: parent?.keyword,
        category: opts.category || parent?.category,
        model: resolveModelLabel(undefined, opts.modelKey),
        format: opts.format,
        generationSessionId: requestId,
        promptSnapshot: opts.directionBrief,
        setupSnapshot,
      });
      if (productLinkPatch) store.updateDraft(placeholder.id, productLinkPatch);
      // Carry the prefill's account/board onto the Pin it produced, so a Pin generated
      // from one account's Insights cannot publish as another.
      if (destinationPatch) store.updateDraft(placeholder.id, destinationPatch);
      return placeholder;
    }),
  );

  deps.onPlaceholdersReady?.(totalPins);

  // Groups run SERIALLY: /api/generate holds a per-user lock and answers a concurrent
  // second call with 429, so parallel groups would fail the 2nd and 3rd outright.
  let okCount = 0;
  let failCount = 0;
  for (const group of groups) {
    const placeholders = groupPlaceholders[group.index];
    deps.onGroupProgress?.(group.index + 1, groups.length);
    try {
      const result = await generate({
        styleReference: group.reference?.imageUrl ?? null,
        batchRequestId: requestId,
        setup: opts,
      });
      result.urls.slice(0, placeholders.length).forEach((url, i) => {
        store.completeGeneratedDraft(placeholders[i].id, url);
        deps.onAnalyze?.(placeholders[i].id);
        deps.onJudge?.(placeholders[i].id);
      });
      okCount += Math.min(result.urls.length, placeholders.length);
      const unfilled = placeholders.slice(result.urls.length);
      unfilled.forEach(p => store.failGeneratedDraft(p.id));
      failCount += unfilled.length;
      // A provider may return MORE images than requested. Those are DISCARDED:
      // totalPins is the only source of truth for the final record count (PRD
      // Section G / acceptance 26 — "不得创建超过请求数量的草稿"). Persisting them
      // would make the batch deliver more Pins than the CTA promised and inflate
      // the success count.
      const discarded = Math.max(0, result.urls.length - placeholders.length);
      if (discarded > 0 && process.env.NODE_ENV !== "production") {
        // Dev-only: dropping provider output is intentional but should not be
        // invisible while iterating. No user-facing surface — the CTA already
        // promised exactly totalPins, so there is nothing to report to the user.
        console.warn(`[runAiGeneration] provider returned ${discarded} image(s) beyond the requested count; discarded`);
      }
    } catch {
      // This reference failed; keep going so the others still produce results.
      placeholders.forEach(p => store.failGeneratedDraft(p.id));
      failCount += placeholders.length;
    }
  }

  deps.onSettled?.({ okCount, failCount });
  return { okCount, failCount, requestId, totalPins };
}
