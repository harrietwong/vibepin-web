/**
 * failureMedia.ts — resolves which image a GENERATION-failed board card should show.
 *
 * A generation-failed card (PinDraft with generationStatus === "failed", not a
 * publish failure) must never render blank/broken art. It falls back through the
 * ORIGINAL input image the failed generation was based on, ending in a neutral
 * placeholder only when nothing resolvable exists (prompt-only / scratch mode).
 *
 * Priority (all reads are from PERSISTED draft fields — must survive refresh /
 * cross-device, never rely on in-memory-only state):
 *   1. draft.imageUrl            — already-resolved image on the draft itself.
 *   2. draft.sourceImageUrl      — snapshot of the parent's image at generation time
 *                                   (set for both version-mode AI regenerations and
 *                                   any card created "from" another image).
 *   3. First product input image — draft.setupSnapshot.selectedProducts[0].imageUrl
 *                                   (product-image generation failure → product original).
 *   4. First reference input image — draft.setupSnapshot.selectedReferences[0].imageUrl
 *                                   (reference-image generation failure → reference original).
 *   5. Parent draft's own image  — resolved via parentDraftId through the SAME chain
 *                                   (regenerate failures show the parent pin's image,
 *                                   even if sourceImageUrl itself went dead).
 *   6. null → caller renders the neutral "Generation failed" placeholder.
 *
 * A `blob:` URL is never a valid candidate — it only ever resolves in the tab that
 * created it, so a value that looks like one is treated as already-dead and skipped
 * (no destructive migration of persisted data; just skipped at read time).
 *
 * Candidate URLs are not classified by spelling, color, or guessed hashes. A
 * short inline `data:` fixture is rejected before it can paint; every other tiny
 * image advances only after the browser reports its dimensions, while explicit
 * fixture/legacy identity is carried by persisted media metadata.
 */

import { isBlobUrl } from "@/lib/mediaUrl";
import type { PinDraft } from "@/lib/pinDraftStore";

/**
 * Provenance is deliberately coarse and explicit.  It is the safety boundary for
 * placeholder detection: a pink/solid product image is still a valid product image,
 * while a legacy/QA placeholder may be advanced when its identity is known.
 */
export type MediaProvenance = "generated" | "product" | "reference" | "legacy" | "qa" | "unknown";

export type LoadedMediaMetrics = {
  /** The persisted ContentMedia identity, when this candidate came from media[]. */
  id?: string;
  width?: number;
  height?: number;
  provenance?: MediaProvenance;
  /** Explicit importer/fixture marker; never inferred from color or average pixels. */
  knownPlaceholder?: boolean;
};

export type LoadedMediaClass = "valid" | "tiny" | "placeholder";

export type FailureMediaCandidateRole = "draft" | "source" | "product" | "reference" | "parent";

export type MediaCursorState = { identity: string; index: number };
export type MediaCursorAction = { type: "advance" } | { type: "sync"; identity: string };

/** Pure cursor state machine used by the keyed renderer and unit tests. */
export function reduceMediaCursor(state: MediaCursorState, action: MediaCursorAction): MediaCursorState {
  if (action.type === "sync") {
    return action.identity === state.identity ? state : { identity: action.identity, index: 0 };
  }
  return { identity: state.identity, index: state.index + 1 };
}

/** Test-only fixture identity.  The strict shape prevents ordinary catalog ids from
 * being rejected just because they contain the words "qa" or "slide". */
export function isQaFixtureMediaId(id: string | null | undefined): boolean {
  return /^qa-slide-\d+$/i.test((id ?? "").trim());
}

/** Canonical resource identity used only for candidate de-duplication. URL fragments
 * do not select a different image, while the original URL is retained for rendering. */
export function canonicalMediaUrl(url: string): string {
  const value = url.trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    // Inline data URLs and legacy relative values retain their trimmed identity.
  }
  return value;
}

function isExplicitLegacyPlaceholderMarker(value: unknown): boolean {
  return /(?:legacy[_ -]?placeholder|placeholder[_ -]?legacy)/i.test(String(value ?? ""));
}

/**
 * Conservative loaded-image classification.  The only automatic visual signal is
 * known tiny dimensions; no average/unique-color/edge heuristic is allowed here.
 * A strict QA fixture id, known tiny dimensions, or an explicit legacy-placeholder
 * marker is enough to advance.  A generic legacy source, URL spelling, hash guess,
 * color, or average-pixel value is never enough.
 */
export function classifyLoadedMedia(metrics: LoadedMediaMetrics): LoadedMediaClass {
  if ((typeof metrics.width === "number" && metrics.width <= 2)
    || (typeof metrics.height === "number" && metrics.height <= 2)) return "tiny";
  const provenance = metrics.provenance ?? "unknown";
  const legacyOrQa = provenance === "legacy" || provenance === "qa";
  // qa-slide-* is a replaceable slot id, not permanent evidence. It only advances
  // when the persisted candidate still carries QA/legacy provenance (or an explicit
  // marker); real product/generated media may retain the slot id after replacement.
  if (legacyOrQa && (isQaFixtureMediaId(metrics.id) || metrics.knownPlaceholder)) return "placeholder";
  if (metrics.knownPlaceholder && provenance !== "product" && provenance !== "generated") return "placeholder";
  return "valid";
}

/** Browser-safe counterpart used by PinCardMedia's onLoad path. */
export function inspectLoadedMedia(
  img: Pick<HTMLImageElement, "naturalWidth" | "naturalHeight">,
  candidate: Pick<LoadedMediaMetrics, "id" | "provenance" | "knownPlaceholder"> | string,
): LoadedMediaClass {
  const metrics = typeof candidate === "string"
    ? {}
    : candidate;
  return classifyLoadedMedia({
    ...metrics,
    width: img.naturalWidth,
    height: img.naturalHeight,
  });
}

/** Draft fields this resolver needs — kept minimal so tests don't need a full PinDraft. */
export type FailureMediaDraft = Pick<
  PinDraft,
  | "imageUrl" | "sourceImageUrl" | "parentDraftId" | "setupSnapshot" | "referenceImageUrl"
  | "source" | "assetError" | "media" | "failureType" | "generationStatus" | "postedAt"
>;

export type FailureMediaCandidate = {
  url: string;
  provenance: MediaProvenance;
  role: FailureMediaCandidateRole;
  origin: "generated" | "original";
  id?: string;
  width?: number;
  height?: number;
  knownPlaceholder?: boolean;
  /** Stable candidate identity for React cursor remount/reset behavior. */
  identity: string;
};

/** Short inline PNG fixtures are known tiny media; reserve the runtime check for all other media. */
const DEGENERATE_DATA_URL_MAX_LENGTH = 200;

export function isDegenerateDataUrl(url: string | null | undefined): boolean {
  const value = (url ?? "").trim();
  return value.startsWith("data:") && value.length < DEGENERATE_DATA_URL_MAX_LENGTH;
}

function usable(url: string | null | undefined): url is string {
  const v = (url ?? "").trim();
  if (!v) return false;
  if (isBlobUrl(v)) return false; // dead in any tab/session other than the one that created it
  if (isDegenerateDataUrl(v)) return false; // decodable 1x1/2x2 data fixture
  return true;
}

function provenanceForDraft(draft: Pick<FailureMediaDraft, "source" | "assetError">): MediaProvenance {
  const source = String(draft.source ?? "").toLowerCase();
  const error = String(draft.assetError ?? "").toLowerCase();
  if (source.includes("qa") || error.includes("qa")) return "qa";
  if (source.includes("legacy") || error.includes("legacy") || error.includes("placeholder")) return "legacy";
  if (source.includes("product") || source === "url_imported" || source.includes("upload")) return "product";
  if (source.includes("reference")) return "reference";
  if (source.includes("ai") || source.includes("generated")) return "generated";
  return "unknown";
}

function candidate(
  url: string | null | undefined,
  provenance: MediaProvenance,
  role: FailureMediaCandidateRole,
  media: Pick<FailureMediaCandidate, "id" | "width" | "height"> | undefined,
  knownPlaceholder: boolean,
): FailureMediaCandidate | null {
  const value = (url ?? "").trim();
  if (!usable(value)) return null;
  const verdict = classifyLoadedMedia({ ...media, provenance, knownPlaceholder });
  if (verdict !== "valid") return null;
  const origin = role === "draft" && (provenance === "generated" || provenance === "unknown")
    ? "generated"
    : "original";
  const identity = `${role}:${media?.id ?? provenance}:${canonicalMediaUrl(value)}:${media?.width ?? ""}x${media?.height ?? ""}`;
  return { url: value, provenance, role, origin, ...media, knownPlaceholder, identity };
}

function candidatesForDraft(draft: FailureMediaDraft): FailureMediaCandidate[] {
  const seen = new Set<string>();
  const out: FailureMediaCandidate[] = [];
  const mediaForUrl = (url: string | null | undefined) => {
    const identity = canonicalMediaUrl((url ?? "").trim());
    if (!identity) return undefined;
    // Persisted rows can retain an earlier host spelling or an obsolete fragment.
    // Match the canonical resource identity on both sides so their explicit
    // provenance survives the lookup; do not lowercase path/query data, whose
    // case can still identify a different product or generated replacement.
    return draft.media?.find(item => canonicalMediaUrl(item.url) === identity);
  };
  const draftLegacyMarker = isExplicitLegacyPlaceholderMarker(draft.source)
    || isExplicitLegacyPlaceholderMarker(draft.assetError);
  const push = (url: string | null | undefined, provenance: MediaProvenance, role: FailureMediaCandidateRole) => {
    const rawValue = (url ?? "").trim();
    const urlIdentity = canonicalMediaUrl(rawValue);
    if (!urlIdentity || seen.has(urlIdentity)) return;
    const media = mediaForUrl(url);
    const resolvedProvenance = media?.source === "legacy" ? "legacy"
      : media?.source === "product" || media?.source === "upload" ? "product"
        : media?.source === "ai" ? "generated"
          : provenance;
    // A draft-level marker belongs only to the explicit primary placeholder. It must
    // never turn the parent's real sourceImageUrl into another placeholder.
    const marker = role === "draft" && draftLegacyMarker
      && resolvedProvenance !== "product" && resolvedProvenance !== "reference";
    const item = candidate(url, resolvedProvenance, role, media, marker);
    // Reserve even rejected URLs so a later fallback cannot render the exact same
    // bad resource again (especially primary/sourceImageUrl duplicates).
    seen.add(urlIdentity);
    if (!item) return;
    out.push(item);
  };
  const draftProvenance = provenanceForDraft(draft);
  push(draft.imageUrl, draftProvenance, "draft");
  push(draft.sourceImageUrl, draftProvenance, "source");
  push(draft.setupSnapshot?.selectedProducts?.[0]?.imageUrl, "product", "product");
  push(draft.referenceImageUrl, "reference", "reference");
  push(draft.setupSnapshot?.selectedReferences?.[0]?.imageUrl, "reference", "reference");
  return out;
}

export type FailureMediaRenderModel = {
  chain: FailureMediaCandidate[];
  chainKey: string;
  index: number;
  current: FailureMediaCandidate | null;
  showOriginalBadge: boolean;
};

/** Shared executable presentation model for PinCardMedia and non-DOM regressions. */
export function failureMediaRenderModel(
  draft: FailureMediaDraft,
  index: number,
  lookupParent?: (id: string) => FailureMediaDraft | null | undefined,
): FailureMediaRenderModel {
  const chain = resolveFailureMediaCandidates(draft, lookupParent);
  const current = index >= 0 && index < chain.length ? chain[index] : null;
  return {
    chain,
    chainKey: chain.map(candidate => candidate.identity).join("\n"),
    index,
    current,
    showOriginalBadge: current?.origin === "original",
  };
}

/**
 * Resolve the best-available original image for a generation-failed card.
 * `lookupParent` is injected (rather than importing pinDraftStore directly) so this
 * stays a pure, dependency-free function — easy to unit test and reusable outside
 * a browser/localStorage context.
 */
export function resolveFailureMediaUrl(
  draft: FailureMediaDraft,
  lookupParent?: (id: string) => FailureMediaDraft | null | undefined,
): string | null {
  return resolveFailureMediaCandidates(draft, lookupParent)[0]?.url ?? null;
}

/** Exported for the interactive renderer so it shares exactly the resolver's
 * provenance/identity rules while retaining candidate-level fallback labels. */
export function resolveFailureMediaCandidates(
  draft: FailureMediaDraft,
  lookupParent?: (id: string) => FailureMediaDraft | null | undefined,
): FailureMediaCandidate[] {
  const out = candidatesForDraft(draft);
  const seen = new Set(out.map(item => canonicalMediaUrl(item.url)));
  if (draft.parentDraftId && lookupParent) {
    const parent = lookupParent(draft.parentDraftId);
    if (parent) {
      for (const item of candidatesForDraft(parent)) {
        const urlIdentity = canonicalMediaUrl(item.url);
        if (!seen.has(urlIdentity)) {
          seen.add(urlIdentity);
          out.push({ ...item, role: "parent", origin: "original", identity: `parent:${item.identity}` });
        }
      }
    }
  }
  return out;
}
