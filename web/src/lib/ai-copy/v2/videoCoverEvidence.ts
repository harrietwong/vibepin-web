/**
 * Owner-checked video-cover evidence for AI Copy v2.
 *
 * The video URL is deliberately not part of the provider boundary.  A video draft
 * may contribute only its authenticated owner's private poster image, and only
 * after exact path/provenance checks have succeeded.
 */
import { createServerClient } from "@/lib/supabase";
import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
import { authorizeStudioStoragePath, canonicalStorageReference } from "@/lib/server/storagePathAuth";
import { analyzeImageStructured, fetchImageAsDataUrl, providerConfig, type StructuredImageAnalysis } from "@/lib/ai-copy/visionServer";

export type VideoCoverImageObserved = {
  summary: string;
  objects: string[];
  colors: string[];
  style: string;
  ocrText: string[];
};

export type VideoCoverAnalysis = {
  mode: "video_cover";
  degradedMode: "none" | "video_cover_unavailable";
  imageObserved?: VideoCoverImageObserved;
};

export type VideoCoverDeps = {
  loadOwnedDraft: (userId: string, draftId: string) => Promise<unknown | null>;
  resolveOwnedPoster: (userId: string, posterUrl: string) => Promise<{ dataUrl: string } | null>;
  analyzePoster: (input: { dataUrl: string; userId: string; draftId: string }) => Promise<StructuredImageAnalysis>;
};

const bucket = () => process.env.VIBEPIN_DRAFT_BUCKET ?? "generated-private";
// A single frozen frame can establish only a literal visual description.  These
// terms invite claims about time, action, sound, performance, protected product
// attributes, or commercial quantities, so they never become visual facts.
const FORBIDDEN_COVER_INFERENCE = /\b(?:motion|moving|moves?|sequence|before|after|action|dancing|running|speaking|speech|audio|music|sound|duration|seconds?|minutes?|performance|effective|efficacy|heals?|treats?|cures?|material|silk|leather|cotton|brand|price|cost|stock|inventory|available|quantity|quantities)\b|[$€£]|\d/i;
const safeCoverText = (value: unknown): string => typeof value === "string" && !FORBIDDEN_COVER_INFERENCE.test(value) ? value.trim() : "";
const safeCoverTexts = (values: unknown): string[] => Array.isArray(values)
  ? values.map(safeCoverText).filter(Boolean).slice(0, 10)
  : [];

function videoPosterFromDraft(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const media = (raw as { media?: unknown }).media;
  if (!Array.isArray(media)) return null;
  const cover = media[0];
  if (!cover || typeof cover !== "object") return null;
  const item = cover as { kind?: unknown; posterUrl?: unknown };
  return item.kind === "video" && typeof item.posterUrl === "string" && item.posterUrl.trim()
    ? item.posterUrl.trim()
    : null;
}

async function defaultLoadOwnedDraft(userId: string, draftId: string): Promise<unknown | null> {
  const { data, error } = await createServerClient().from("pin_drafts").select("payload")
    .eq("vibepin_user_id", userId).eq("draft_id", draftId).is("deleted_at", null).maybeSingle();
  return error || !data ? null : (data as { payload?: unknown }).payload ?? null;
}

async function defaultResolveOwnedPoster(userId: string, posterUrl: string): Promise<{ dataUrl: string } | null> {
  const ref = canonicalStorageReference(posterUrl);
  if (!ref || ref.legacy || ref.bucket !== bucket()) return null;
  const authorization = authorizeStudioStoragePath(ref.path, userId);
  if (!authorization.ok) return null;
  const provenance = await createMediaProvenanceStore().findExact(userId, ref.bucket, authorization.path).catch(() => null);
  if (!provenance || provenance.lifecycle_state === "unresolved" || provenance.lifecycle_state === "failed") return null;
  try {
    const image = await fetchImageAsDataUrl(`/api/storage-image?path=${encodeURIComponent(authorization.path)}`, { ownerUserId: userId });
    return { dataUrl: image.dataUrl };
  } catch {
    return null;
  }
}

async function defaultAnalyzePoster(input: { dataUrl: string; userId: string; draftId: string }): Promise<StructuredImageAnalysis> {
  const cfg = providerConfig();
  return analyzeImageStructured({
    cfg,
    dataUrl: input.dataUrl,
    costContext: { userId: input.userId, operationType: "ai_copy_v2_video_cover_analysis", referenceId: input.draftId },
  });
}

const defaultDeps: VideoCoverDeps = {
  loadOwnedDraft: defaultLoadOwnedDraft,
  resolveOwnedPoster: defaultResolveOwnedPoster,
  analyzePoster: defaultAnalyzePoster,
};
/**
 * Explicit dependency injection keeps route tests hermetic without process-global
 * overrides that could leak between concurrent server requests.
 */
export async function analyzeOwnedVideoCover(input: { userId: string; draftId: string }, injected: Partial<VideoCoverDeps> = {}): Promise<VideoCoverAnalysis> {
  const deps = { ...defaultDeps, ...injected };
  const draft = await deps.loadOwnedDraft(input.userId, input.draftId).catch(() => null);
  const posterUrl = videoPosterFromDraft(draft);
  if (!posterUrl) return { mode: "video_cover", degradedMode: "video_cover_unavailable" };
  const poster = await deps.resolveOwnedPoster(input.userId, posterUrl).catch(() => null);
  if (!poster) return { mode: "video_cover", degradedMode: "video_cover_unavailable" };
  try {
    const observed = await deps.analyzePoster({ dataUrl: poster.dataUrl, userId: input.userId, draftId: input.draftId });
    return {
      mode: "video_cover", degradedMode: "none",
      imageObserved: {
        summary: safeCoverText(observed.imageSummary),
        objects: safeCoverTexts(observed.visibleObjects),
        colors: safeCoverTexts(observed.colors),
        style: safeCoverText(observed.style),
        ocrText: safeCoverTexts(observed.ocrText ? [observed.ocrText] : []),
      },
    };
  } catch {
    return { mode: "video_cover", degradedMode: "video_cover_unavailable" };
  }
}
