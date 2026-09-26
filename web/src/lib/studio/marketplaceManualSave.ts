/**
 * marketplaceManualSave.ts — 0925 follow-up: pure logic for the "marketplace-manual"
 * card's inline save form in ProductUrlImportPanel (Temu / Shein / AliExpress /
 * TikTok Shop — the four hosts FR-04 gives a manual-entry fallback instead of a
 * fetch). Extracted so the "when is Save enabled" / "what gets saved" rules are
 * covered by fast unit tests instead of only a browser QA pass.
 *
 * Contract mirrors the ordinary success-path save item shape in
 * ProductUrlImportPanel.handleSaveSelected: same field names, `productUrl` is the
 * ORIGINAL pasted link, never rewritten (PRD FR-04-4).
 */

export type MarketplaceManualDraft = {
  title: string;
  /** Set once an image is chosen — either the Temu-derived candidate or an upload. */
  imageUrl: string | null;
};

export type MarketplaceManualSaveItem = {
  imageUrl: string;
  title: string;
  sourceUrl: string;
  sourceDomain: string;
  productUrl: string;
  extractionReason?: string;
};

/** Save is only ever enabled once there is a non-empty title AND an image — an
 *  empty-string title (all-whitespace) does not count as filled in. */
export function canSaveMarketplaceManualDraft(draft: MarketplaceManualDraft): boolean {
  return draft.title.trim().length > 0 && !!draft.imageUrl;
}

/**
 * Builds the same-shaped item `onSaveSelected` already accepts from the normal
 * candidate-selection flow. Returns null when the draft is not yet saveable — callers
 * must check `canSaveMarketplaceManualDraft` (or just check this for null) before
 * calling `onSaveSelected`.
 */
export function marketplaceManualSaveItem(
  draft: MarketplaceManualDraft,
  result: { sourceUrl: string; sourceDomain: string; extractionReason?: string },
): MarketplaceManualSaveItem | null {
  if (!canSaveMarketplaceManualDraft(draft)) return null;
  return {
    imageUrl:         draft.imageUrl!,
    title:            draft.title.trim(),
    sourceUrl:        result.sourceUrl,
    sourceDomain:     result.sourceDomain,
    // PRD FR-04-4: the destination link is always the user's own pasted URL, verbatim.
    productUrl:       result.sourceUrl,
    extractionReason: result.extractionReason ?? "direct_image_url",
  };
}
