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
 */

import { isBlobUrl } from "@/lib/mediaUrl";
import type { PinDraft } from "@/lib/pinDraftStore";

/** Draft fields this resolver needs — kept minimal so tests don't need a full PinDraft. */
export type FailureMediaDraft = Pick<PinDraft, "imageUrl" | "sourceImageUrl" | "parentDraftId" | "setupSnapshot">;

function usable(url: string | null | undefined): url is string {
  const v = (url ?? "").trim();
  if (!v) return false;
  if (isBlobUrl(v)) return false; // dead in any tab/session other than the one that created it
  return true;
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
  if (usable(draft.imageUrl)) return draft.imageUrl;
  if (usable(draft.sourceImageUrl)) return draft.sourceImageUrl;

  const product = draft.setupSnapshot?.selectedProducts?.[0]?.imageUrl;
  if (usable(product)) return product;

  const reference = draft.setupSnapshot?.selectedReferences?.[0]?.imageUrl;
  if (usable(reference)) return reference;

  if (draft.parentDraftId && lookupParent) {
    const parent = lookupParent(draft.parentDraftId);
    if (parent) {
      // Recurse (parent could itself be a regenerate of a regenerate); guard against
      // cycles is unnecessary here since parentDraftId chains are created strictly
      // forward (a fresh id every generation) and lookupParent returns null past the
      // real chain end — but cap depth defensively via a second, parent-only pass
      // that does NOT itself recurse into a grandparent to avoid any pathological loop.
      if (usable(parent.imageUrl)) return parent.imageUrl;
      if (usable(parent.sourceImageUrl)) return parent.sourceImageUrl;
      const parentProduct = parent.setupSnapshot?.selectedProducts?.[0]?.imageUrl;
      if (usable(parentProduct)) return parentProduct;
      const parentReference = parent.setupSnapshot?.selectedReferences?.[0]?.imageUrl;
      if (usable(parentReference)) return parentReference;
    }
  }

  return null;
}
