"use client";

/**
 * The one user-facing Product Picker.
 *
 * There used to be two: ProductPickerModal (a centred modal with its own
 * Recommended / Search / Shopify / Use-a-link / Create tabs and its own
 * ProductSelection type) and InlineCreateAssetPicker (the right-side drawer panel
 * with My Products / Product Ideas + source chips). They read different data, had
 * different tabs, and returned different shapes.
 *
 * This component makes InlineCreateAssetPicker's product mode the single canonical
 * picker and hosts it as an overlay for the callers that used the modal
 * (StudioBoard's "Select product", PinDetailsDrawer's Link / Change product). Every
 * entry point now returns CanonicalProductSelection, so there is exactly one picker
 * behaviour and one selection shape across the app.
 *
 * Product images and Style references remain separate roles (PRD Section D) — this
 * hosts the product role only.
 */

import { useLocale } from "@/lib/i18n/LocaleProvider";
import { InlineCreateAssetPicker, type InlineAssetItem } from "@/components/studio/InlineCreateAssetPicker";
import { selectionFromAsset, type CanonicalProductSelection } from "@/lib/studio/productSelection";
import { BUI } from "@/components/studio/boardUI";

export type CanonicalProductPickerProps = {
  /** Whether the Pin already has a primary product — the first pick becomes primary
   *  only when it does not. Carried onto each returned selection's asPrimary. */
  hasPrimary?: boolean;
  /**
   * Single-product entry points (top-level Select product, Link/Change product) set
   * this so the picker's CTA promises exactly what the caller will use. Without it
   * the footer could read "Add 3 products" while the caller silently kept only the
   * first — the UI lying about the outcome.
   */
  selectionMode?: "single" | "multiple";
  onSelect: (selections: CanonicalProductSelection[]) => void;
  onClose: () => void;
};

/** Map the picker's asset items to canonical selections, preserving all fields. */
export function selectionsFromInlineItems(
  items: InlineAssetItem[],
  hasPrimary: boolean,
): CanonicalProductSelection[] {
  return items.map((item, i) => ({
    ...selectionFromAsset(item),
    // First pick is primary only when the Pin has none yet; later picks are tagged.
    asPrimary: i === 0 ? !hasPrimary : false,
  }));
}

export function CanonicalProductPicker({ hasPrimary = false, selectionMode = "multiple", onSelect, onClose }: CanonicalProductPickerProps) {
  const { t: tr } = useLocale();
  return (
    <>
      <div
        data-testid="canonical-product-picker-backdrop"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(15,23,42,0.52)" }}
      />
      <div
        data-testid="canonical-product-picker"
        role="dialog"
        aria-label={tr("pinDrawer.asset.chooseProductImages")}
        style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 92, width: 760, maxWidth: "96vw", background: BUI.surface, borderLeft: `1px solid ${BUI.border}`, boxShadow: "-18px 0 54px rgba(15,23,42,0.24)", display: "flex", flexDirection: "column" }}
      >
        <InlineCreateAssetPicker
          role="product"
          selectionMode={selectionMode}
          onClose={onClose}
          onConfirm={items => {
            onSelect(selectionsFromInlineItems(items, hasPrimary));
            onClose();
          }}
        />
      </div>
    </>
  );
}
