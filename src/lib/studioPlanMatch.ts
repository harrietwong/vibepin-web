/**
 * studioPlanMatch.ts — single source of truth for matching a Create Pins (Studio)
 * generated output to its Weekly Plan draft, and deriving the card's plan state
 * from that draft.
 *
 * Why this exists: Studio cards used to read plan state from the in-memory
 * StudioPin.planningStatus, which is NOT reconciled with pinDraftStore (the real
 * Weekly Plan source of truth). A pin scheduled in Weekly Plan stayed "Not planned"
 * in Create Pins. These helpers make both surfaces agree by deriving status from the
 * matched draft using the canonical getPinReadiness.
 */

import type { PinDraft } from "./pinDraftStore";
import { getPinReadiness, type PinPlanStatus } from "./pinReadiness";

export type StudioCardPlanState = PinPlanStatus; // "not_planned" | "needs_date" | "scheduled" | "posted"

export type StudioOutputLike = {
  /** Studio output id, e.g. `${sessionId}_g${gi}_p${ii}`. Becomes draft.pinId on handoff. */
  id?: string | null;
  /** Generated image URL. */
  url?: string | null;
};

export type StudioPlanMatchReason = "pinId" | "imageUrl" | "none";

export type StudioCardPlanResult = {
  state: StudioCardPlanState;
  draft: PinDraft | null;
  matchReason: StudioPlanMatchReason;
  /** Effective planned date for the badge ("Scheduled <date>"). */
  plannedDate: string;
  plannedTime: string;
  plannedAt: string;
  addedToPlanAt: string;
};

export function normalizePinSourceId(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  if (!s || s === "undefined" || s === "null") return "";
  return s;
}

/**
 * Find the Weekly Plan draft that corresponds to a Studio output.
 * Priority: draft.pinId === output.id, then draft.imageUrl === output.url.
 */
export function findDraftForStudioOutput(
  output: StudioOutputLike,
  drafts: PinDraft[],
): { draft: PinDraft | null; reason: StudioPlanMatchReason } {
  const id = normalizePinSourceId(output.id);
  const url = normalizePinSourceId(output.url);

  if (id) {
    const byPinId = drafts.find(d => normalizePinSourceId(d.pinId) === id);
    if (byPinId) return { draft: byPinId, reason: "pinId" };
  }
  if (url) {
    const byUrl = drafts.find(d => normalizePinSourceId(d.imageUrl) === url);
    if (byUrl) return { draft: byUrl, reason: "imageUrl" };
  }
  return { draft: null, reason: "none" };
}

/** Derive the canonical plan state from a matched draft. */
export function deriveCardStatusFromDraft(draft: PinDraft): StudioCardPlanState {
  const { planStatus } = getPinReadiness({
    imageUrl: draft.imageUrl,
    title: draft.title,
    description: draft.description,
    altText: draft.altText,
    destinationUrl: draft.destinationUrl,
    boardId: draft.boardId,
    plannedDate: draft.scheduledDate,
    plannedAt: draft.plannedAt,
    addedToPlanAt: draft.addedToPlanAt,
    postedAt: draft.postedAt,
    planningStatus: draft.postedAt ? "posted" : undefined,
  });
  return planStatus;
}

/**
 * Resolve a Studio card's plan state against the live Weekly Plan drafts.
 * When a matching draft exists, status + dates come from that draft (the source of
 * truth). When no draft exists, the caller's fallback (the in-memory pin state) is used.
 */
export function getStudioCardPlanState(
  output: StudioOutputLike,
  drafts: PinDraft[],
  fallback: { state: StudioCardPlanState; plannedDate?: string; plannedTime?: string; plannedAt?: string },
): StudioCardPlanResult {
  const { draft, reason } = findDraftForStudioOutput(output, drafts);
  if (!draft) {
    return {
      state: fallback.state,
      draft: null,
      matchReason: "none",
      plannedDate: fallback.plannedDate ?? "",
      plannedTime: fallback.plannedTime ?? "",
      plannedAt: fallback.plannedAt ?? "",
      addedToPlanAt: "",
    };
  }
  return {
    state: deriveCardStatusFromDraft(draft),
    draft,
    matchReason: reason,
    plannedDate: draft.scheduledDate ?? "",
    plannedTime: draft.scheduledTime ?? "",
    plannedAt: draft.plannedAt ?? "",
    addedToPlanAt: draft.addedToPlanAt ?? "",
  };
}
