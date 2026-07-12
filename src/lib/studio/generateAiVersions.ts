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

export async function generateAiVersions(opts: {
  source?: PinDraft | null;
  keyword?: string;
  setup: AiVersionOptions;
}): Promise<AiVersionGenerateResult> {
  const { source, setup } = opts;
  const generationRequestId = `board_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const productImages = setup.productImages.length
    ? setup.productImages
    : source?.imageUrl ? [source.imageUrl] : [];
  const referenceImages = setup.referenceImages;

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      keyword: source?.keyword || opts.keyword || source?.title || setup.category || "pin",
      category: setup.category || source?.category || "",
      style: "editorial",
      count: Math.max(1, Math.min(4, setup.count)),
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
