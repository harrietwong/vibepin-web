import type { LinkedProduct, PinMetadataDraft } from "./pinMetadata";
import { resolvePinProducts } from "./pinMetadata";
import {
  getPinReadiness as getCanonicalReadiness,
  type PinDetailsStatus as CanonicalPinDetailsStatus,
} from "./pinReadiness";

export type PinDetailsSource = "create_pins" | "weekly_plan" | "my_pins";
export type PinDetailsMode = "details" | "plan" | "publish";
export type PinDetailsStatus = CanonicalPinDetailsStatus;
export type PinPlanStatus = "not_planned" | "needs_date" | "scheduled" | "posted";

export type PinDetailsDraft = {
  imageUrl: string;
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  linkedProducts: LinkedProduct[];
  primaryProductId: string;
  /** Real Pinterest boardId from the connected account. Empty string means no board selected.
   *  NEVER populate this from boardSuggestion — that is a content recommendation, not a board. */
  boardId: string;
  /** Display name for the selected board. Informational only. */
  boardName: string;
  /** Content-based board recommendation text. NOT a real Pinterest boardId.
   *  Must never be used as boardId. Preserved for display hinting only. */
  boardSuggestion: string;
  /** ISO date "YYYY-MM-DD". Empty when not yet scheduled. */
  plannedDate: string;
  /** 24-hour time "HH:mm". Empty when no specific time is set. */
  plannedTime: string;
  /** Composed local datetime "YYYY-MM-DDTHH:mm". Derived from plannedDate + plannedTime. */
  plannedAt: string;
  /** ISO datetime set when a pin is added to a plan but no date/time is yet assigned.
   *  Presence without plannedDate/plannedAt indicates needs_date plan status. */
  addedToPlanAt: string;
  planStatus: PinPlanStatus;
  detailsStatus: PinDetailsStatus;
};

export type PinReadiness = {
  detailsStatus: PinDetailsStatus;
  planStatus: PinPlanStatus;
  canPublish: boolean;
  missing: Array<"image" | "boardId">;
};

export function getPinPlanStatus(input: {
  addedToPlanAt?: string | null;
  scheduledDate?: string | null;
  postedAt?: string | null;
}): PinPlanStatus {
  if (input.postedAt) return "posted";
  if (input.scheduledDate) return "scheduled";
  if (input.addedToPlanAt) return "needs_date";
  return "not_planned";
}

export function getPinReadiness(input: {
  imageUrl?: string | null;
  title?: string | null;
  description?: string | null;
  altText?: string | null;
  destinationUrl?: string | null;
  boardId?: string | null;
  addedToPlanAt?: string | null;
  scheduledDate?: string | null;
  postedAt?: string | null;
}): PinReadiness {
  const canonical = getCanonicalReadiness(input);
  const missing = canonical.missingFields.map(field => field === "board" ? "boardId" : field) as PinReadiness["missing"];
  return {
    detailsStatus: canonical.detailsStatus,
    planStatus: getPinPlanStatus(input),
    canPublish: canonical.detailsStatus === "ready",
    missing,
  };
}

export function combinePlannedAt(date: string, time: string): string {
  const d = date.trim();
  if (!d) return "";
  return `${d}T${time.trim() || "00:00"}`;
}

// ── Mapper input shapes ───────────────────────────────────────────────────────
// Structural (duck-typed) to avoid circular imports with page-level types.

export type StudioPinLike = {
  url: string;
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  plannedDate: string;
  plannedTime?: string | null;
  plannedAt?: string | null;
  /** Studio plan state: "not_added" | "added_to_plan" | "needs_review" | "ready" | "posted" | "skipped" */
  planningStatus: string;
  metadataDraft?: PinMetadataDraft | null;
};

export type PinDraftLike = {
  imageUrl: string;
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  plannedAt?: string | null;
  addedToPlanAt?: string | null;
  postedAt?: string | null;
  boardId?: string | null;
  boardName?: string | null;
  linkedProducts?: LinkedProduct[] | null;
  primaryProductId?: string | null;
  metadataDraft?: PinMetadataDraft | null;
};

// ── Mappers ───────────────────────────────────────────────────────────────────

/**
 * Map a Studio-generated pin to the canonical PinDetailsDraft.
 *
 * SAFETY RULES enforced here:
 * - boardSuggestion is NEVER mapped to boardId.
 * - boardId is only sourced from metadataDraft.boardId (a real Pinterest board).
 * - destinationUrl is preserved as-is; productUrl is never substituted in.
 * - plannedDate and plannedTime are kept separate.
 * - needs_date is returned when the pin is added to plan but has no date/time.
 */
export function mapStudioPinToDetailsDraft(pin: StudioPinLike): PinDetailsDraft {
  const { primary, tagged } = resolvePinProducts(pin.metadataDraft ?? null);
  const linkedProducts: LinkedProduct[] = primary ? [primary, ...tagged] : [...tagged];

  const boardId = pin.metadataDraft?.boardId ?? "";
  const boardName = pin.metadataDraft?.boardName ?? "";
  const boardSuggestion = pin.metadataDraft?.boardSuggestion ?? "";

  const isPosted = pin.planningStatus === "posted" || pin.planningStatus === "skipped";
  const isAdded = !isPosted && pin.planningStatus !== "not_added";

  const readiness = getCanonicalReadiness({
    imageUrl: pin.url,
    title: pin.title,
    description: pin.description,
    altText: pin.altText,
    destinationUrl: pin.destinationUrl,
    boardId,
    postedAt: isPosted ? "posted" : undefined,
    plannedDate: pin.plannedDate?.trim() || undefined,
    plannedAt: pin.plannedAt?.trim() || undefined,
    addedToPlanAt: isAdded ? "added" : undefined,
  });

  return {
    imageUrl: pin.url,
    title: pin.title,
    description: pin.description,
    altText: pin.altText,
    destinationUrl: pin.destinationUrl,
    linkedProducts,
    primaryProductId: primary?.productId ?? "",
    boardId,
    boardName,
    boardSuggestion,
    plannedDate: pin.plannedDate ?? "",
    plannedTime: pin.plannedTime ?? "",
    plannedAt: pin.plannedAt ?? "",
    addedToPlanAt: isAdded ? "added" : "",
    planStatus: readiness.planStatus,
    detailsStatus: readiness.detailsStatus,
  };
}

/**
 * Map a Weekly Plan PinDraft to the canonical PinDetailsDraft.
 *
 * SAFETY RULES enforced here:
 * - boardId is sourced from draft.boardId or metadataDraft.boardId (real Pinterest boards only).
 * - boardSuggestion is read from metadataDraft for display only, never as boardId.
 * - destinationUrl is preserved; productUrl from linked products is NOT substituted in.
 * - plannedDate (from scheduledDate) and plannedTime (from scheduledTime) are kept separate.
 * - addedToPlanAt drives needs_date status via the canonical getPinReadiness.
 */
export function mapPinDraftToDetailsDraft(draft: PinDraftLike): PinDetailsDraft {
  const { primary, tagged } = resolvePinProducts(draft.metadataDraft ?? null);
  const storedLinked = draft.linkedProducts ?? [];
  const linkedProducts: LinkedProduct[] = storedLinked.length > 0
    ? storedLinked
    : primary ? [primary, ...tagged] : [...tagged];

  const boardId = (draft.boardId?.trim() || draft.metadataDraft?.boardId?.trim()) ?? "";
  const boardName = (draft.boardName?.trim() || draft.metadataDraft?.boardName?.trim()) ?? "";
  const boardSuggestion = draft.metadataDraft?.boardSuggestion ?? "";

  const scheduledDate = draft.scheduledDate?.trim() ?? "";
  const scheduledTime = draft.scheduledTime?.trim() ?? "";

  const readiness = getCanonicalReadiness({
    imageUrl: draft.imageUrl,
    title: draft.title,
    description: draft.description,
    altText: draft.altText,
    destinationUrl: draft.destinationUrl,
    boardId,
    postedAt: draft.postedAt ?? undefined,
    plannedDate: scheduledDate || undefined,
    plannedAt: draft.plannedAt?.trim() || undefined,
    addedToPlanAt: draft.addedToPlanAt?.trim() || undefined,
  });

  return {
    imageUrl: draft.imageUrl,
    title: draft.title,
    description: draft.description,
    altText: draft.altText,
    destinationUrl: draft.destinationUrl,
    linkedProducts,
    primaryProductId: draft.primaryProductId?.trim()
      ?? primary?.productId
      ?? "",
    boardId,
    boardName,
    boardSuggestion,
    plannedDate: scheduledDate,
    plannedTime: scheduledTime,
    plannedAt: draft.plannedAt?.trim() ?? "",
    addedToPlanAt: draft.addedToPlanAt?.trim() ?? "",
    planStatus: readiness.planStatus,
    detailsStatus: readiness.detailsStatus,
  };
}
