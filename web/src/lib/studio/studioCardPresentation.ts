import type { PinLifecycle } from "./pinLifecycle";

export type StudioCardPresentation = {
  fieldsVisible: boolean;
  fieldsEditable: boolean;
  readOnly: boolean;
};

/** Single lifecycle policy consumed by the card and its behavioral tests. */
export function studioCardPresentation(lifecycle: PinLifecycle): StudioCardPresentation {
  return {
    fieldsVisible: true,
    fieldsEditable: lifecycle !== "posted" && lifecycle !== "generating",
    readOnly: lifecycle === "posted",
  };
}

/** A stale active id must never turn a posted card back into an editor. */
export function canEnterCardEdit(lifecycle: PinLifecycle): boolean {
  return lifecycle !== "posted";
}

/** `auto` leaves unknown media neutral until the element reports intrinsic size. */
export function resolveMediaAspectRatio(width?: number, height?: number): string {
  return Number.isFinite(width) && Number.isFinite(height) && (width ?? 0) > 0 && (height ?? 0) > 0
    ? `${width} / ${height}`
    : "auto";
}
