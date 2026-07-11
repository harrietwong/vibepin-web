/**
 * Regenerate payload reconstruction (pure / testable).
 *
 * "Regenerate" rebuilds a generation request from a saved setup snapshot — products,
 * references, the hidden prompt (or brief), selected tags, model, and creative-direction
 * meta — so it uses the SAME safe path as Generate and never falls back to text-only when
 * images exist. If the snapshot can't produce a real request, `hasSetup` is false and the
 * caller must show the "missing setup" message WITHOUT calling the provider.
 */

import type { TagGroup } from "./creativeControls";

export type RegenerateSnapshotLike = {
  selectedProducts?: Array<{ imageUrl?: string | null; title?: string | null; productUrl?: string | null }>;
  selectedReferences?: Array<{ imageUrl?: string | null }>;
  promptSnapshot?: string;
  category?: string;
  keyword?: string;
  format?: string;
  modelKey?: string;
  noTextOverlay?: boolean;
  creativeDirectionSnapshot?: {
    hiddenPrompt?: string;
    manualBrief?: string;
    // `creativeControls` is typed `unknown` on the persisted snapshot — narrowed at runtime.
    creativeControls?: unknown;
  } | null;
};

type CreativeControlsLite = {
  selectedTags?: Array<{ id: string; label: string; group: TagGroup }>;
  directionBrief?: string;
};

function readCreativeControls(value: unknown): CreativeControlsLite {
  if (!value || typeof value !== "object") return {};
  const cc = value as Record<string, unknown>;
  const tags = Array.isArray(cc.selectedTags)
    ? (cc.selectedTags as Array<{ id: string; label: string; group: TagGroup }>)
    : undefined;
  const brief = typeof cc.directionBrief === "string" ? cc.directionBrief : undefined;
  return { selectedTags: tags, directionBrief: brief };
}

export type RegenerateFallbacks = {
  refUrl?: string | null;
  fallbackPrompt?: string;
  fallbackKeyword?: string;
  fallbackCategory?: string;
};

export type RegeneratePayload = {
  hasSetup: boolean;
  keyword: string;
  category: string;
  prompt: string;
  count: 1;
  styleRef: string | null;
  productImages: string[];
  productMetadata: Array<{ title?: string; productUrl?: string }>;
  modelKey: string;
  promptMode: "legacy" | "creative_direction_v2";
  promptVersion: 1 | 2;
  textOverlay: boolean;
  selectedTags?: Array<{ id: string; label: string; group: TagGroup }>;
  directionBrief?: string;
  productImageCountRequested: number;
  referenceImageCountRequested: number;
};

export function buildRegeneratePayload(snap: RegenerateSnapshotLike | null | undefined, fb: RegenerateFallbacks = {}): RegeneratePayload {
  const cds = snap?.creativeDirectionSnapshot ?? undefined;
  const productImages = (snap?.selectedProducts ?? [])
    .map(p => (p.imageUrl ?? "").trim())
    .filter((u): u is string => u.length > 0);
  const styleRef = (fb.refUrl ?? "").trim() || null;
  // Prefer the stored hidden prompt (richest), then the brief, then any fallback.
  const prompt = (cds?.hiddenPrompt ?? snap?.promptSnapshot ?? fb.fallbackPrompt ?? "").trim();
  const hasV2 = !!snap?.creativeDirectionSnapshot;
  const controls = readCreativeControls(cds?.creativeControls);

  return {
    // Without a snapshot AND without any product/reference/prompt we cannot rebuild a real request.
    hasSetup: !!snap && (productImages.length > 0 || !!styleRef || prompt.length > 0),
    keyword: (snap?.keyword || fb.fallbackKeyword || "Pinterest content").trim(),
    category: (snap?.category || fb.fallbackCategory || "").trim(),
    prompt,
    count: 1,
    styleRef,
    productImages,
    productMetadata: (snap?.selectedProducts ?? []).map(p => ({ title: p.title ?? undefined, productUrl: p.productUrl ?? undefined })),
    modelKey: (snap?.modelKey || "gemini_image"),          // preserve saved model; default only when absent
    promptMode: hasV2 ? "creative_direction_v2" : "legacy",
    promptVersion: hasV2 ? 2 : 1,
    textOverlay: snap?.noTextOverlay === false,
    selectedTags: controls.selectedTags,
    directionBrief: controls.directionBrief ?? cds?.manualBrief,
    productImageCountRequested: productImages.length,
    referenceImageCountRequested: styleRef ? 1 : 0,
  };
}

// Block a retry that would go out WITHOUT any image inputs when the original
// generation used products/references. Sending an imageless request for an
// image-based Pin just fails again — instead the caller shows "missing setup".
export function shouldBlockImagelessRetry(
  originalProductCount: number, originalReferenceCount: number,
  sentProductCount: number, sentReferenceCount: number,
): boolean {
  const originalUsedImages = originalProductCount > 0 || originalReferenceCount > 0;
  const sentImages = sentProductCount + sentReferenceCount;
  return originalUsedImages && sentImages === 0;
}

export type GenErrorCode =
  | "provider_busy" | "user_generation_limit" | "configuration_error"
  | "rate_limited" | "safety_blocked" | "api_auth_error" | "image_load_failed"
  | "missing_setup" | "unknown_error" | string | undefined;

/** P0 user-facing copy. Never returns raw provider JSON. */
export function regenerateErrorCopy(code: GenErrorCode): { title: string; body: string } {
  switch (code) {
    case "provider_busy":
      return { title: "Generation is busy", body: "Please try again shortly." };
    case "user_generation_limit":
      return { title: "A generation is already running", body: "You already have a generation running. Please wait for it to finish." };
    case "configuration_error":
      return { title: "Generation is not configured correctly", body: "Please check server settings." };
    case "missing_setup":
      return { title: "This Pin is missing its original setup", body: "Please create a new generation instead." };
    default:
      return { title: "Couldn’t generate this Pin", body: "Try again. If it continues, edit the inputs and regenerate." };
  }
}
