"use client";

/**
 * Client helper for Board V2 Generate AI Image -> POST /api/generate.
 * It uses the real Studio generation contract: product images are subject inputs,
 * reference images are style/composition inputs, and Creative Direction V2 is sent
 * as structured metadata.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { PinDraft } from "@/lib/pinDraftStore";
import type { AiVersionOptions } from "@/components/studio/AiVersionDrawer";
import { PINS_PER_REFERENCE_OPTIONS } from "@/lib/studio/selectedReferences";

const MAX_PINS_PER_REFERENCE = Math.max(...PINS_PER_REFERENCE_OPTIONS);

let _client: ReturnType<typeof createBrowserClient> | null = null;
function browser() {
  if (_client) return _client;
  _client = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return _client;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await browser().auth.getSession();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  return h;
}

export type AiVersionGenerateResult = {
  urls: string[];
  generationRequestId: string;
  promptSnapshot?: Record<string, unknown>;
  requestedImageCount?: number;
  actualImageCount?: number;
  countClamped?: boolean;
  source?: string;
};

/**
 * Generate ONE reference group.
 *
 * A batch of N references is N sequential calls to this function, each requesting
 * `setup.count` images with a single `styleReference` as its style_ref. That is not
 * a stylistic choice:
 *
 *  - /api/generate rebuilds image_inputs from `product_images` + ONE `style_ref`
 *    string (buildImageInputs), so a single request can only ever carry one
 *    reference image; and
 *  - it holds a per-user "active-generation" lock and returns 429
 *    (user_generation_limit) for a concurrent second call, so the groups must be
 *    serial rather than parallel.
 *
 * Product images and metadata are shared across every group; only the style
 * reference varies. The caller pairs each result with its group's reference to
 * persist the association onto the resulting Pins.
 */
export async function generateAiVersions(opts: {
  source?: PinDraft | null;
  keyword?: string;
  setup: AiVersionOptions;
  /** This group's style reference. Omit for a product/prompt-only group. */
  styleReference?: string | null;
  /** Shared across all groups in one batch, for log/telemetry correlation. */
  batchRequestId?: string;
}): Promise<AiVersionGenerateResult> {
  const { source, setup } = opts;
  const generationRequestId = opts.batchRequestId
    ? `${opts.batchRequestId}_g${Math.random().toString(36).slice(2, 6)}`
    : `board_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const productImages = setup.productImages.length
    ? setup.productImages
    : source?.imageUrl ? [source.imageUrl] : [];
  // One reference per group. `styleReference === undefined` means the caller did not
  // opt into grouped generation, so fall back to the legacy first-reference behavior.
  const groupReference = opts.styleReference !== undefined
    ? opts.styleReference
    : setup.referenceImages[0] ?? null;
  const referenceImages = groupReference ? [groupReference] : [];

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      keyword: source?.keyword || opts.keyword || source?.title || setup.category || "pin",
      category: setup.category || source?.category || "",
      style: "editorial",
      // Per-GROUP count (pinsPerReference, 1..3) — never the batch total.
      count: Math.max(1, Math.min(MAX_PINS_PER_REFERENCE, setup.count)),
      prompt: setup.hiddenPrompt || setup.prompt,
      prompt_mode: "creative_direction_v2",
      prompt_version: 2,
      creative_direction_meta: setup.creativeDirectionMeta,
      selectedTags: setup.selectedTags,
      primaryFormatTag: setup.primaryFormatTag,
      directionBrief: setup.directionBrief,
      briefManuallyEdited: setup.briefManuallyEdited,
      inferredCategory: setup.category,
      productImageCountRequested: productImages.length,
      referenceImageCountRequested: referenceImages.length,
      outputCount: setup.count,
      variationMode: setup.variationMode,
      outputVariants: setup.outputVariants,
      generationRequestId,
      style_ref: referenceImages[0] || null,
      product_images: productImages,
      image_inputs: [
        ...productImages.map((sourceUrl, index) => ({
          role: "product",
          order: index + 1,
          sourceUrl,
          label: `Product image ${index + 1}`,
        })),
        ...referenceImages.map((sourceUrl, index) => ({
          role: "reference",
          order: productImages.length + index + 1,
          sourceUrl,
          label: `Reference image ${index + 1}`,
        })),
      ],
      text_overlay: false,
      reference_strength: referenceImages.length ? "strong" : "moderate",
      output_type: setup.category === "fashion" ? "fashion_editorial" : "",
      format: setup.format,
      model_key: setup.modelKey,
      product_metadata: setup.productMetadata,
    }),
  });
  if (!res.ok) throw new Error(`Generation failed (${res.status})`);
  const body = await res.json() as {
    ok?: boolean;
    urls?: string[];
    generation_request_id?: string;
    generationRequestId?: string;
    prompt_snapshot?: Record<string, unknown>;
    requested_image_count?: number;
    actual_image_count?: number;
    count_clamped?: boolean;
    source?: string;
  };
  return {
    urls: Array.isArray(body.urls) ? body.urls.filter(Boolean) : [],
    generationRequestId: body.generation_request_id || body.generationRequestId || generationRequestId,
    promptSnapshot: body.prompt_snapshot,
    requestedImageCount: body.requested_image_count,
    actualImageCount: body.actual_image_count,
    countClamped: body.count_clamped,
    source: body.source,
  };
}
