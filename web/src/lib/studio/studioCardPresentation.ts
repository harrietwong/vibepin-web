import type { PinLifecycle } from "./pinLifecycle";

export type StudioCardPresentation = {
  fieldsVisible: boolean;
  fieldsEditable: boolean;
  readOnly: boolean;
  metadataFields: readonly ["title", "description", "websiteUrl", "boardId", "altText"];
};

export const STUDIO_CARD_METADATA_FIELDS = ["title", "description", "websiteUrl", "boardId", "altText"] as const;

/** Single lifecycle policy consumed by the card and its behavioral tests. */
export function studioCardPresentation(lifecycle: PinLifecycle): StudioCardPresentation {
  return {
    fieldsVisible: true,
    fieldsEditable: lifecycle !== "posted" && lifecycle !== "generating",
    readOnly: lifecycle === "posted",
    metadataFields: STUDIO_CARD_METADATA_FIELDS,
  };
}

/** A stale active id must never turn a posted card back into an editor. */
export function canEnterCardEdit(lifecycle: PinLifecycle): boolean {
  return lifecycle !== "posted";
}

/** Field-level visibility policy consumed directly by the card renderer. */
export function shouldShowStudioMetadataField(
  lifecycle: PinLifecycle,
  field: StudioCardPresentation["metadataFields"][number],
): boolean {
  return studioCardPresentation(lifecycle).metadataFields.includes(field);
}

/** `auto` leaves unknown media neutral until the element reports intrinsic size. */
export function resolveMediaAspectRatio(width?: number, height?: number): string {
  return Number.isFinite(width) && Number.isFinite(height) && (width ?? 0) > 0 && (height ?? 0) > 0
    ? `${width} / ${height}`
    : "auto";
}

/** Reset detected intrinsic size only when the media identity or declared size changes. */
export function mediaAspectResetKey(mediaId?: string, mediaUrl?: string, width?: number, height?: number): string {
  return `${mediaId ?? ""}|${mediaUrl ?? ""}|${width ?? ""}|${height ?? ""}`;
}
