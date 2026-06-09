"use client";

import {
  InlineCreateAssetPicker,
  type InlineAssetItem,
} from "@/components/studio/InlineCreateAssetPicker";

export type AssetItem = InlineAssetItem;

export type CreateAssetPickerProps = {
  role: "product" | "style_reference";
  open: boolean;
  onClose: () => void;
  onConfirm: (items: AssetItem[]) => void;
  currentSelectedUrls?: string[];
};

// Backward-compatible export. This intentionally renders the new inline picker
// instead of the removed centered modal, so legacy imports cannot revive the old
// asset-selection information architecture.
export function CreateAssetPicker({
  role,
  open,
  onClose,
  onConfirm,
  currentSelectedUrls,
}: CreateAssetPickerProps) {
  if (!open) return null;
  return (
    <InlineCreateAssetPicker
      role={role}
      onClose={onClose}
      onConfirm={onConfirm}
      currentSelectedUrls={currentSelectedUrls}
    />
  );
}
