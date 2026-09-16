/** Server-owned, static-frame-only evidence for AI Copy v2 video drafts. */
import { createServerClient } from "@/lib/supabase";
import { createMediaProvenanceStore, type MediaProvenance } from "@/lib/server/mediaProvenance";
import { authorizeStudioStoragePath, canonicalStorageReference } from "@/lib/server/storagePathAuth";
import { handleStorageImageGet } from "@/lib/server/storageImageHandler";
import { chatJson, fetchImageAsDataUrl, providerConfig } from "@/lib/ai-copy/visionServer";

export type VideoCoverImageObserved = { summary: string; objects: string[]; colors: string[]; style: string; ocrText: string[] };
export type VideoCoverAnalysis = { mode: "video_cover"; degradedMode: "none" | "video_cover_unavailable"; imageObserved?: VideoCoverImageObserved };
export type StaticCoverObservation = { objects: string[]; colors: string[]; composition?: string; layout?: string };

export type VideoCoverDeps = {
  loadOwnedDraft: (userId: string, draftId: string) => Promise<unknown | null>;
  findProvenance: (userId: string, bucketId: string, path: string) => Promise<MediaProvenance | null>;
  fetchStorageObject: typeof fetch;
  /** Provider output is untrusted until the static observation parser accepts it. */
  analyzePoster: (input: { dataUrl: string; userId: string; draftId: string; prompt: string }) => Promise<unknown>;
};

const OBJECTS = new Set(["mug", "cup", "table", "chair", "desk", "sofa", "lamp", "book", "plant", "flower", "vase", "plate", "bowl", "bed", "pillow", "rug", "wall", "frame", "bag", "shoe", "bottle", "box", "phone", "laptop", "keyboard", "notebook", "pen", "watch", "ring", "necklace", "earring", "shirt", "dress", "jacket", "hat", "food", "fruit", "cake", "candle", "glass", "mirror", "canvas", "poster", "car", "bicycle", "beach", "mountain", "tree", "building"]);
const COLORS = new Set(["black", "white", "gray", "grey", "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "beige", "cream", "tan", "gold", "silver", "navy", "teal"]);
const COMPOSITIONS = new Set(["still_life", "interior", "flat_lay", "close_up", "portrait", "landscape", "product_display", "text_graphic"]);
const LAYOUTS = new Set(["centered", "symmetrical", "minimal", "layered", "overhead", "close_crop"]);
const bucket = () => process.env.VIBEPIN_DRAFT_BUCKET ?? "generated-private";

const oneOf = (values: unknown, allowed: Set<string>) => Array.isArray(values)
  ? values.filter((value): value is string => typeof value === "string" && allowed.has(value.trim().toLowerCase())).map(value => value.trim().toLowerCase()).slice(0, 8)
  : [];
const choice = (value: unknown, allowed: Set<string>) => typeof value === "string" && allowed.has(value.trim().toLowerCase()) ? value.trim().toLowerCase() : undefined;

export function buildVideoCoverObservationPrompt(): string {
  return [
    "Analyze one frozen video cover frame as a STATIC image only.",
    "Do not infer motion, actions, before/after or time sequence, audio, music, singing, speech, duration, performance, efficacy, brand, material, price, stock, inventory, quantity, or any numeric commercial fact.",
    "Return JSON only. Use only exact canonical taxonomy values; drop anything outside it.",
    `objects: ${[...OBJECTS].join(", ")}.`, `colors: ${[...COLORS].join(", ")}.`,
    `composition: ${[...COMPOSITIONS].join(", ")}; layout: ${[...LAYOUTS].join(", ")}.`,
    'Schema: {"objects":["mug"],"colors":["blue"],"composition":"still_life","layout":"centered"}.',
  ].join("\n");
}

function parseStaticObservation(raw: unknown): StaticCoverObservation | null {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const observation = { objects: oneOf(value.objects, OBJECTS), colors: oneOf(value.colors, COLORS), composition: choice(value.composition, COMPOSITIONS), layout: choice(value.layout, LAYOUTS) };
  return observation.objects.length || observation.colors.length || observation.composition || observation.layout ? observation : null;
}

function videoPosterFromDraft(raw: unknown): { kind: "image" } | { kind: "video"; posterUrl: string | null } | { kind: "unknown" } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { media?: unknown }).media)) return { kind: "unknown" };
  const cover = (raw as { media: unknown[] }).media[0];
  if (!cover || typeof cover !== "object") return { kind: "unknown" };
  if ((cover as { kind?: unknown }).kind === "image") return { kind: "image" };
  if ((cover as { kind?: unknown }).kind !== "video") return { kind: "unknown" };
  const poster = (cover as { posterUrl?: unknown }).posterUrl;
  return { kind: "video", posterUrl: typeof poster === "string" && poster.trim() ? poster.trim() : null };
}

async function defaultLoadOwnedDraft(userId: string, draftId: string): Promise<unknown | null> {
  const { data, error } = await createServerClient().from("pin_drafts").select("payload")
    .eq("vibepin_user_id", userId).eq("draft_id", draftId).is("deleted_at", null).maybeSingle();
  return error || !data ? null : (data as { payload?: unknown }).payload ?? null;
}
async function defaultFindProvenance(userId: string, bucketId: string, path: string) { return createMediaProvenanceStore().findExact(userId, bucketId, path); }
async function defaultAnalyzePoster(input: { dataUrl: string; userId: string; draftId: string; prompt: string }): Promise<StaticCoverObservation | null> {
  const cfg = providerConfig();
  if (!cfg.key) throw new Error("provider_not_configured");
  const raw = await chatJson({
    key: cfg.key, baseUrl: cfg.baseUrl, model: cfg.visionModel, provider: cfg.provider, timeoutMs: 26_000, temperature: 0,
    costContext: { userId: input.userId, operationType: "ai_copy_v2_video_cover_analysis", referenceId: input.draftId },
    messages: [{ role: "system", content: "You are a strict static-frame classifier. Follow the user taxonomy exactly." }, { role: "user", content: [{ type: "text", text: input.prompt }, { type: "image_url", image_url: { url: input.dataUrl } }] }],
  });
  return parseStaticObservation(raw);
}

const defaultDeps: VideoCoverDeps = { loadOwnedDraft: defaultLoadOwnedDraft, findProvenance: defaultFindProvenance, fetchStorageObject: fetch, analyzePoster: defaultAnalyzePoster };

async function resolvePosterDataUrl(userId: string, posterUrl: string, deps: VideoCoverDeps): Promise<{ dataUrl: string } | null> {
  const ref = canonicalStorageReference(posterUrl);
  if (!ref || ref.legacy || ref.bucket !== bucket()) return null;
  const authorization = authorizeStudioStoragePath(ref.path, userId);
  if (!authorization.ok) return null;
  const proven = await deps.findProvenance(userId, ref.bucket, authorization.path).catch(() => null);
  if (!proven || proven.lifecycle_state === "failed" || proven.lifecycle_state === "unresolved") return null;
  try {
    const image = await fetchImageAsDataUrl(`/api/storage-image?path=${encodeURIComponent(authorization.path)}`, {
      ownerUserId: userId,
      privateFetch: async () => handleStorageImageGet(new Request(`https://vibepin.invalid/api/storage-image?path=${encodeURIComponent(authorization.path)}`), {
        getUserId: async () => userId,
        // The handler's boundary is owner/path; retain its production selector
        // while binding this resolver's already-canonical private bucket.
        findProvenance: (owner, path) => deps.findProvenance(owner, ref.bucket, path),
        fetchImpl: deps.fetchStorageObject,
      }),
    });
    return { dataUrl: image.dataUrl };
  } catch { return null; }
}

/** Persisted media kind, not a client field, selects the protected video path. */
export async function resolveOwnedMediaEvidence(input: { userId: string; draftId: string }, injected: Partial<VideoCoverDeps> = {}): Promise<{ kind: "image" } | { kind: "video"; analysis: VideoCoverAnalysis } | { kind: "unknown"; analysis: VideoCoverAnalysis }> {
  const deps = { ...defaultDeps, ...injected };
  const draft = await deps.loadOwnedDraft(input.userId, input.draftId).catch(() => null);
  const media = videoPosterFromDraft(draft);
  if (media.kind === "image") return { kind: "image" };
  if (media.kind === "unknown") return { kind: "unknown", analysis: { mode: "video_cover", degradedMode: "video_cover_unavailable" } };
  if (!media.posterUrl) return { kind: "video", analysis: { mode: "video_cover", degradedMode: "video_cover_unavailable" } };
  const poster = await resolvePosterDataUrl(input.userId, media.posterUrl, deps);
  if (!poster) return { kind: "video", analysis: { mode: "video_cover", degradedMode: "video_cover_unavailable" } };
  try {
    const safe = parseStaticObservation(await deps.analyzePoster({ dataUrl: poster.dataUrl, userId: input.userId, draftId: input.draftId, prompt: buildVideoCoverObservationPrompt() }));
    if (!safe) return { kind: "video", analysis: { mode: "video_cover", degradedMode: "video_cover_unavailable" } };
    return { kind: "video", analysis: { mode: "video_cover", degradedMode: "none", imageObserved: { summary: safe.composition ? `${safe.composition} composition` : "", objects: safe.objects, colors: safe.colors, style: safe.layout ?? "", ocrText: [] } } };
  } catch { return { kind: "video", analysis: { mode: "video_cover", degradedMode: "video_cover_unavailable" } }; }
}

export async function analyzeOwnedVideoCover(input: { userId: string; draftId: string }, injected: Partial<VideoCoverDeps> = {}): Promise<VideoCoverAnalysis> {
  const resolved = await resolveOwnedMediaEvidence(input, injected);
  return resolved.kind === "video" ? resolved.analysis : { mode: "video_cover", degradedMode: "video_cover_unavailable" };
}
