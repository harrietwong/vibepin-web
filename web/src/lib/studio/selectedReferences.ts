/**
 * One selection state for every Style Reference entry point.
 *
 * Before this module the drawer kept two disconnected collections: `referenceUrls`
 * (uploaded/saved refs, which reached the image model) and `selectedRefIds`
 * (recommended Pinterest Pins, which only contributed derived patternTags). That
 * split was a deliberate compliance isolation — Pinterest创意智能层 PRD §4 used to
 * forbid pin_samples images as generation conditioning.
 *
 * That rule was lifted by the product owner on 2026-07-21 (see §4.1/§4.4 of that
 * PRD, and Section E of `create pin流程变更0721-prd.txt`). Recommended Pins now
 * participate as real style references, so both entry points must share ONE
 * collection — otherwise the top tray and the recommendation grid disagree about
 * what is selected, which is the bug Section E describes.
 *
 * Provenance is preserved per item (a recommended Pin still knows it came from
 * Pinterest and keeps its linkback + patternTags) — unified selection, not
 * flattened identity.
 */

/** Where a selected reference came from. Drives badges, linkback and patternTags. */
export type ReferenceSource = "recommended_pin" | "upload" | "saved" | "url" | "generated";

export type SelectedReference = {
  /** Stable identity. For recommended Pins this is the pin_samples row id. */
  id: string;
  imageUrl: string;
  source: ReferenceSource;
  /** Linkback to the original Pin — required for recommended_pin (compliance §4.1.11). */
  sourceUrl?: string;
  title?: string;
  /** Why this was recommended. Display-only. */
  reason?: string;
  /** Derived style signals; still sent as auxiliary prompt text (§4.1.8). */
  patternTags?: unknown;
  /** Always "style_reference" on the client. The wire role is "reference". */
  role: "style_reference";
};

/** PRD §4.1.10 — never more than 3 style references in one batch. */
export const MAX_SELECTED_REFERENCES = 3;

/** pinsPerReference is limited to 1..3, so one batch never exceeds 9 Pins. */
export const PINS_PER_REFERENCE_OPTIONS = [1, 2, 3] as const;
export type PinsPerReference = (typeof PINS_PER_REFERENCE_OPTIONS)[number];

/**
 * Identity for dedupe/toggle. Recommended Pins carry a stable row id; ad-hoc
 * uploads may not, so fall back to the image URL. Two entries pointing at the
 * same image are the same selection regardless of which surface added them.
 */
export function referenceKey(ref: Pick<SelectedReference, "id" | "imageUrl">): string {
  return ref.id || ref.imageUrl;
}

export function isSelected(list: SelectedReference[], ref: Pick<SelectedReference, "id" | "imageUrl">): boolean {
  const key = referenceKey(ref);
  return list.some(r => referenceKey(r) === key);
}

/** True when adding another reference would exceed the cap. */
export function isAtCapacity(list: SelectedReference[]): boolean {
  return list.length >= MAX_SELECTED_REFERENCES;
}

/**
 * Add or remove in one operation — this is what makes the top tray and the
 * recommendation grid stay in lockstep: both call this, so neither can hold a
 * selection the other doesn't know about.
 *
 * Selecting past the cap is a no-op (returns the same array) rather than an
 * error or a silent eviction, so the UI can disable cards without diverging.
 */
export function toggleReference(list: SelectedReference[], ref: SelectedReference): SelectedReference[] {
  const key = referenceKey(ref);
  const existing = list.findIndex(r => referenceKey(r) === key);
  if (existing >= 0) return list.filter((_, i) => i !== existing);
  if (list.length >= MAX_SELECTED_REFERENCES) return list;
  return [...list, ref];
}

/** Remove by key — used by the top tray's per-thumbnail X button. */
export function removeReference(list: SelectedReference[], key: string): SelectedReference[] {
  return list.filter(r => referenceKey(r) !== key);
}

/**
 * Merge a picker confirmation into the current selection.
 *
 * The picker returns the full set it considers selected, but it only knows about
 * the assets IT can see — it must never silently drop recommended Pins the user
 * chose in the drawer. So: keep existing entries from other sources, replace the
 * ones this picker owns, and respect the cap.
 */
export function mergePickerSelection(
  list: SelectedReference[],
  picked: SelectedReference[],
  ownedSources: ReferenceSource[],
): SelectedReference[] {
  const owned = new Set(ownedSources);
  const retained = list.filter(r => !owned.has(r.source));
  const merged = [...retained];
  for (const p of picked) {
    if (merged.length >= MAX_SELECTED_REFERENCES) break;
    if (!isSelected(merged, p)) merged.push(p);
  }
  return merged;
}

/** Image URLs in selection order — the style_ref per generation group. */
export function referenceImageUrls(list: SelectedReference[]): string[] {
  return list.map(r => r.imageUrl).filter(Boolean);
}

/** patternTags of the current selection; still fed to the prompt as auxiliary signal. */
export function selectedPatternTags<T>(list: SelectedReference[]): T[] {
  return list.map(r => r.patternTags).filter((t): t is T => t != null);
}

// ── Batch arithmetic (Section G) ─────────────────────────────────────────────
//
//   groupRequestCount = pinsPerReference
//   groupCount        = max(selectedReferences.length, 1)
//   totalPins         = groupCount × pinsPerReference
//
// totalPins governs ONLY the CTA, placeholder count and final record total. Each
// group issues its own /api/generate call with count = pinsPerReference; we never
// request totalPins in one call and assign references afterwards.

export function groupCount(referenceCount: number): number {
  return Math.max(referenceCount, 1);
}

export function totalPins(referenceCount: number, pinsPerReference: number): number {
  return groupCount(referenceCount) * pinsPerReference;
}

/**
 * The generation groups for one batch. A batch with no references still produces
 * exactly one group (a prompt/product-only generation) so callers never special-case
 * the empty selection.
 */
export type ReferenceGroupPlan = {
  index: number;
  /** null for the reference-less group. */
  reference: SelectedReference | null;
  /** Per-group /api/generate count — NOT the batch total. */
  requestCount: number;
};

export function planReferenceGroups(
  list: SelectedReference[],
  pinsPerReference: number,
): ReferenceGroupPlan[] {
  if (list.length === 0) {
    return [{ index: 0, reference: null, requestCount: pinsPerReference }];
  }
  return list.map((reference, index) => ({ index, reference, requestCount: pinsPerReference }));
}
