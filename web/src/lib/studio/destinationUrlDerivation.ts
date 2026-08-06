/**
 * Website URL derivation from the linked product (create-pin PRD Section J).
 *
 * The Pin's destination URL is derived from the product the user linked, but a
 * user's own edit must never be silently overwritten. Rather than add a new flag,
 * this reuses the two fields that already exist:
 *
 *   - `destinationUrlTouched` (metadataTouched)  — the user typed in the field.
 *   - `destinationUrlSource`  (metadata/draft)   — provenance of the current value.
 *
 * The rules, in the PRD's words:
 *   - the first product selection may populate an EMPTY Website URL;
 *   - changing products may update the URL only while it is still the untouched
 *     product-derived value;
 *   - a manually edited URL is never silently overwritten;
 *   - unlinking clears the URL only when it still equals that product's derived URL.
 *
 * There is deliberately no "force" path here: overwriting a user's URL is a
 * decision for an explicit UI action, not a derivation rule.
 */

import { resolveProductPublicUrl, type CanonicalProductSelection } from "@/lib/studio/productSelection";

/** Marks a destination URL as auto-derived from the linked product. */
export const PRODUCT_DERIVED_URL_SOURCE = "product";

export type DestinationUrlState = {
  /** Current value of the Website URL field. */
  destinationUrl?: string;
  /** Provenance of that value (PRODUCT_DERIVED_URL_SOURCE, "manual", …). */
  destinationUrlSource?: string;
  /** True once the user has edited the field by hand. */
  destinationUrlTouched?: boolean;
};

export type DestinationUrlChange = {
  /** The new field value. undefined means "clear it". */
  destinationUrl?: string;
  destinationUrlSource?: string;
};

function normalise(url: string | undefined | null): string {
  return (url ?? "").trim();
}

/**
 * True when the current value is safe for automation to replace: either empty, or
 * still exactly the value automation itself put there.
 *
 * `destinationUrlTouched` alone is not sufficient — a draft restored from an older
 * record may carry a manual URL without the flag — so the source and the value are
 * both checked. Conversely the flag alone protects a user who typed a URL that
 * happens to equal the product's.
 */
export function isAutoManaged(state: DestinationUrlState): boolean {
  const current = normalise(state.destinationUrl);
  if (!current) return true;
  if (state.destinationUrlTouched) return false;
  return state.destinationUrlSource === PRODUCT_DERIVED_URL_SOURCE;
}

/**
 * Apply a product selection to the destination URL.
 *
 * Returns null when nothing should change — the caller then writes nothing at all,
 * which keeps a manual URL byte-identical rather than rewriting it to itself.
 */
export function deriveDestinationUrlForProduct(
  state: DestinationUrlState,
  selection: CanonicalProductSelection,
): DestinationUrlChange | null {
  if (!isAutoManaged(state)) return null;

  const derived = resolveProductPublicUrl(selection);
  const current = normalise(state.destinationUrl);

  // No valid public URL for this product (e.g. a Product Idea without one).
  if (!derived) {
    // Clear a previously auto-filled URL so it cannot point at the OLD product,
    // but never touch an empty field (avoids a pointless write).
    if (!current) return null;
    return { destinationUrl: "", destinationUrlSource: undefined };
  }

  if (current === derived) return null;
  return { destinationUrl: derived, destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE };
}

/**
 * Apply unlinking a product. Clears the URL only when it still equals that
 * product's derived URL — a manual URL, or one derived from a different product,
 * survives.
 */
export function clearDestinationUrlForUnlink(
  state: DestinationUrlState,
  unlinked: CanonicalProductSelection,
): DestinationUrlChange | null {
  const current = normalise(state.destinationUrl);
  if (!current) return null;
  if (!isAutoManaged(state)) return null;

  const derived = resolveProductPublicUrl(unlinked);
  if (!derived || current !== derived) return null;

  return { destinationUrl: "", destinationUrlSource: undefined };
}

/**
 * When an automated URL fill lands, the Pin has TWO existing copies of the URL —
 * the session Pin and its board draft — and either (or both) may be a hand-edited
 * value the fill must not clobber. They can also disagree. This computes the single
 * authoritative value every surface must be reconciled to.
 *
 * Extracted from the studio page handler precisely because the bug recurred three
 * times there: each attempt protected one surface and let another keep the stale
 * automated value, which Save then wrote back. As a pure function the conflicting
 * states are directly testable.
 *
 * Returns:
 *   - `null` when neither copy is manual → the automated fill proceeds unchanged;
 *   - otherwise the authoritative manual `{ url, source }`, plus which side owned it,
 *     so the caller sets the touched flag on the right surface.
 */
export function reconcileProtectedUrl(
  board: DestinationUrlState | null,
  session: DestinationUrlState | null,
): {
  url: string | undefined;
  source: string | undefined;
  /**
   * The touched flag EVERY receiving surface must adopt. When the authoritative value
   * is a hand-edited product-derived URL (`source:"product"`, `touched:true`), its
   * manual-ness lives ONLY in the touched flag — copying it to another surface with
   * touched:false would make that surface auto-managed (isAutoManaged returns true for
   * source:"product" when untouched) and the next fill would overwrite it. So the flag
   * travels with the value; it is always true here (the owner is, by definition, manual).
   */
  touched: boolean;
  boardManual: boolean;
  sessionManual: boolean;
} | null {
  const boardManual = !!board && !isAutoManaged(board);
  const sessionManual = !!session && !isAutoManaged(session);
  if (!boardManual && !sessionManual) return null;
  // Both independently manual → the board draft is the publish-time source of truth.
  const owner = boardManual ? board! : session!;
  return {
    url: owner.destinationUrl,
    source: owner.destinationUrlSource,
    // The reconciled value is manual on every surface it lands on. Preserve manual
    // semantics explicitly rather than relying on source alone (source may be
    // "product" for an edited product URL, which is only manual WITH the flag).
    touched: true,
    boardManual,
    sessionManual,
  };
}

/**
 * Record a manual edit. Called from every hand-entry point so the touched flag is
 * set consistently — the field's provenance becomes "manual" and automation stops
 * touching it from here on.
 */
export function markDestinationUrlManual(url: string): DestinationUrlChange & { destinationUrlTouched: true } {
  return {
    destinationUrl: url.trim(),
    destinationUrlSource: "manual",
    destinationUrlTouched: true,
  };
}
