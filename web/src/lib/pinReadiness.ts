/**
 * pinReadiness.ts — single source of truth for "is this Pin ready to publish?"
 *
 * Shared by Weekly Plan counts and the Batch Edit publish gate so both surfaces
 * agree on what "Ready" / "Needs details" means. A Pin is Ready when it has a
 * publishable image, title, description, alt text, and a REAL Pinterest board
 * selected (boardId). The Website URL / destination link is OPTIONAL (recommended
 * for product Pins) and never blocks readiness. Pure functions — safe in render
 * and on server.
 */

export type RequiredField = "image" | "title" | "description" | "altText" | "board";
export type PinDetailsStatus = "ready" | "need_details";
export type PinPlanStatus = "not_planned" | "needs_date" | "scheduled" | "posted";

export type ReadinessInput = {
  imageUrl?:        string | null;
  title?:           string | null;
  description?:     string | null;
  altText?:         string | null;
  destinationUrl?:  string | null;
  boardId?:         string | null;
  /** Optional — only surfaced as a non-blocking warning. */
  primaryProductId?: string | null;
  plannedDate?: string | null;
  plannedAt?: string | null;
  postedAt?: string | null;
  planningStatus?: string | null;
  /** Set when a pin has been added to plan but not yet given a date/time. */
  addedToPlanAt?: string | null;
};

export const REQUIRED_FIELD_LABELS: Record<RequiredField, string> = {
  image:          "Image",
  title:          "Title",
  description:    "Description",
  altText:        "Alt text",
  board:          "Pinterest board",
};

const REQUIRED_ORDER: RequiredField[] = ["image", "title", "description", "altText", "board"];

function clean(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  if (!s || s === "undefined" || s === "null") return "";
  return s;
}

/** A Pinterest-publishable image must be a public http(s) URL (no blob/data/localhost). */
export function isPublishableImage(url: string | null | undefined): boolean {
  const u = clean(url);
  if (!/^https?:\/\//i.test(u)) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(u)) return false;
  return true;
}

/**
 * Website / destination URL format check (PRD §10.3.6 / §14.2): must be a syntactically
 * valid http(s) URL. An EMPTY value is valid here — the destination link is optional
 * (PRD §10) — this only rejects a non-empty value that is malformed or non-http(s).
 */
export function isValidDestinationUrl(url: string | null | undefined): boolean {
  const u = clean(url);
  if (!u) return true; // optional field — empty is not an error
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

/** Required publishing fields that are still missing, in display order. */
export function pinMissingFields(d: ReadinessInput): RequiredField[] {
  const missing: RequiredField[] = [];
  if (!isPublishableImage(d.imageUrl))   missing.push("image");
  if (!clean(d.title))                   missing.push("title");
  if (!clean(d.description))             missing.push("description");
  if (!clean(d.altText))                 missing.push("altText");
  // Website URL / destination link is optional — never a blocker (recommended only).
  if (!clean(d.boardId))                 missing.push("board");
  return REQUIRED_ORDER.filter(f => missing.includes(f));
}

export function pinMissingFieldLabels(d: ReadinessInput): string[] {
  return pinMissingFields(d).map(f => REQUIRED_FIELD_LABELS[f]);
}

export function isPinReady(d: ReadinessInput): boolean {
  return pinMissingFields(d).length === 0;
}

/** Normalized publishing and planning state built on the canonical required fields. */
export function getPinReadiness(d: ReadinessInput): {
  detailsStatus: PinDetailsStatus;
  planStatus: PinPlanStatus;
  missingFields: RequiredField[];
} {
  const missingFields = pinMissingFields(d);
  const posted = !!clean(d.postedAt) || d.planningStatus === "posted";
  const scheduled = !!clean(d.plannedAt) || !!clean(d.plannedDate);
  const addedToPlan = !!clean(d.addedToPlanAt) || d.planningStatus === "added_to_plan";
  return {
    detailsStatus: missingFields.length === 0 ? "ready" : "need_details",
    planStatus: posted ? "posted" : scheduled ? "scheduled" : addedToPlan ? "needs_date" : "not_planned",
    missingFields,
  };
}

/** Optional, non-blocking: true when no primary product is linked. */
export function isMissingPrimaryProduct(d: ReadinessInput): boolean {
  return !clean(d.primaryProductId);
}
