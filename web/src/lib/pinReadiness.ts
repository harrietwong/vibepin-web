/**
 * pinReadiness.ts — single source of truth for "is this Pin ready to publish?"
 *
 * Shared by Weekly Plan counts and the Batch Edit publish gate so both surfaces
 * agree on what "Ready" / "Needs details" means. A Pin is Ready when it has a
 * publishable image and a REAL Pinterest board selected (boardId). Copy, alt text,
 * Website URL, and product metadata remain editable recommendations, but never
 * block scheduling or publishing. Pure functions — safe in render and on server.
 */

export type RequiredField = "image" | "board";
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
  board:          "Pinterest board",
};

const REQUIRED_ORDER: RequiredField[] = ["image", "board"];

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

// Hosts Pinterest's servers can never reach — kept in sync with the server gate in
// server/pinterest/validatePublish.ts (validateOptionalLink). A client-side check that
// were more lax than the server would let a Pin look schedulable, then fail at publish.
const PRIVATE_HOST_RE =
  /^(localhost$|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1$|\[::1\]|172\.(1[6-9]|2\d|3[0-1])\.)/i;

/**
 * The optional Website URL (destination link). EMPTY is valid — the link is never
 * required and never blocks scheduling or publishing. When present it must be a public
 * http(s) URL, matching the server's validateOptionalLink so the client can't schedule
 * a destination the server will reject.
 */
export function isValidDestinationUrl(url: string | null | undefined): boolean {
  // NB: deliberately NOT clean() — that treats the literal strings "undefined"/"null"
  // as empty, but the server's validateOptionalLink does not, so routing them through
  // clean() would pass here and fail at publish. Only a real null/undefined/blank is
  // the empty (optional) case; "undefined"/"null" fall through to URL parsing (rejected).
  const value = String(url ?? "").trim();
  if (!value) return true; // empty is allowed (optional field)
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return false;
  return true;
}

/** Required publishing fields that are still missing, in display order. */
export function pinMissingFields(d: ReadinessInput): RequiredField[] {
  const missing: RequiredField[] = [];
  if (!isPublishableImage(d.imageUrl))   missing.push("image");
  // Copy, alt text, Website URL, and product metadata are recommendations only.
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
