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
