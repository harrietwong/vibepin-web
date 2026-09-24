/**
 * pinConfirmList.ts — the per-Pin confirmation list shown before a schedule / publish
 * is submitted (Fable ruling 4, 2026-09-24; T4).
 *
 * Ruling 4 replaced a mandatory per-card "reviewed" gate with a confirmation list:
 * every selected Pin is shown (thumbnail, title, destination link, account / Board),
 * the user can remove any of them, scrolls through, and only then confirms. Pins whose
 * AI copy was never edited get a hint badge — informational, never blocking. This is
 * how the Pinterest API "the user selects each Pin" requirement is met without killing
 * bulk efficiency.
 *
 * Pure: no React, no store. The same model drives the bulk sheets and the single-Pin
 * dialog (a list of one).
 */

import type { PublishDestination } from "../contentDraftModel";
import type { MetadataTouchedFlags, PinMetadataDraft } from "../pinMetadata";

export type ConfirmListItem = {
  id: string;
  thumbnailUrl: string | null;
  title: string;
  /** The Pin's destination link (Website URL); "" when none. */
  destinationUrl: string;
  /** Human labels of where it goes: "Pinterest · @acct · Board". */
  targets: string[];
  /** AI-written copy that the user has not edited (hint badge; never blocks). */
  aiUnedited: boolean;
};

type CopyState = {
  title?: string | null;
  description?: string | null;
  metadataDraft?: Pick<PinMetadataDraft, "selectedTitle" | "selectedDescription" | "copyGenerationMeta"> | null;
  metadataTouched?: Partial<MetadataTouchedFlags> | null;
};

/**
 * True when the Pin still carries AI-written copy nobody edited: copy was generated
 * AND the current title or description is still exactly the AI text AND that field
 * was not touched by the user.
 */
export function isAiCopyUnedited(state: CopyState): boolean {
  const meta = state.metadataDraft;
  if (!meta?.copyGenerationMeta) return false;
  const title = (state.title ?? "").trim();
  const description = (state.description ?? "").trim();
  const aiTitle = !!title && title === (meta.selectedTitle ?? "").trim() && !state.metadataTouched?.titleTouched;
  const aiDescription = !!description && description === (meta.selectedDescription ?? "").trim() && !state.metadataTouched?.descriptionTouched;
  return aiTitle || aiDescription;
}

/** "Pinterest · @acct · Board" labels, same wording the existing sheets use. */
export function destinationLabels(destinations: PublishDestination[], platformName: (provider: PublishDestination["provider"]) => string): string[] {
  return destinations.map(destination => {
    const account = destination.accountLabel || destination.socialConnectionId || "";
    const board = destination.provider === "pinterest" ? ` · ${destination.boardName || destination.boardId || ""}` : "";
    return `${platformName(destination.provider)}${account ? ` · ${account}` : ""}${board}`.trim();
  });
}

/** Selected ids minus the ones the user removed, in the original order. */
export function remainingIds(ids: readonly string[], excluded: ReadonlySet<string>): string[] {
  return ids.filter(id => !excluded.has(id));
}

/** Toggle one id in the removed set (returns a new set). */
export function toggleExcluded(excluded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(excluded);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/**
 * "Scrolled through": the list's end is visible. A list that does not overflow counts
 * as read immediately (a list of one never makes the user scroll).
 */
export function hasReachedListEnd(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 4): boolean {
  return metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - slack;
}

/** The confirm button's state: something left to submit AND the list was scrolled through. */
export function canSubmitConfirmList(ids: readonly string[], excluded: ReadonlySet<string>, reachedEnd: boolean): boolean {
  return reachedEnd && remainingIds(ids, excluded).length > 0;
}

/**
 * THE submit filter: what is actually scheduled / published is the confirmed list
 * minus what the user removed. Every host calls this right before submitting, so the
 * list the user saw and the set that is submitted cannot drift apart.
 */
export function selectConfirmedTargets<T>(targets: readonly T[], excluded: ReadonlySet<string>, idOf: (target: T) => string): T[] {
  return targets.filter(target => !excluded.has(idOf(target)));
}

type SnapshotLike = {
  draftId: string;
  title: string;
  description?: string;
  destinationUrl: string;
  media: Array<{ url?: string | null; posterUrl?: string | null }>;
  publishableDestinations: PublishDestination[];
};

/** A confirm-list row from a frozen publish confirmation snapshot (+ the draft for the badge). */
export function confirmItemFromSnapshot(
  snapshot: SnapshotLike,
  draft: CopyState | null | undefined,
  platformName: (provider: PublishDestination["provider"]) => string,
  fallbackTitle = "",
): ConfirmListItem {
  const cover = snapshot.media[0];
  return {
    id: snapshot.draftId,
    thumbnailUrl: cover?.posterUrl || cover?.url || null,
    title: snapshot.title || fallbackTitle,
    destinationUrl: snapshot.destinationUrl ?? "",
    targets: destinationLabels(snapshot.publishableDestinations, platformName),
    // The badge reads the snapshot's own text (what will go out), with the draft's
    // generation record and touched flags.
    aiUnedited: draft ? isAiCopyUnedited({ ...draft, title: snapshot.title, description: snapshot.description ?? draft.description }) : false,
  };
}
