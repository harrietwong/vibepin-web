import {
  contentMedia,
  destinationKey,
  type ContentMedia,
  type PublishDestination,
  type PublishProvider,
} from "../contentDraftModel";
import type { PinDraft } from "../pinDraftStore";
import {
  checkFacebookMedia,
  checkInstagramMedia,
  checkPinterestMedia,
  type MediaCheckFailureCode,
} from "../publish/mediaRules";

export type PublishConfirmationBlockerCode = "no_destinations" | "missing_board" | "no_account" | MediaCheckFailureCode;
export type PublishConfirmationBlocker = {
  code: PublishConfirmationBlockerCode;
  provider?: PublishProvider;
  destinationId?: string;
  accountLabel?: string;
  message: string;
};

export type PublishConfirmationMode =
  | { kind: "now" }
  | { kind: "schedule"; scheduledAt: string; timezone: string };

export type PublishConfirmationSnapshot = {
  intentId: string;
  fingerprint: string;
  draftId: string;
  contentId: string;
  sourceUpdatedAt: string;
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  media: ContentMedia[];
  mode: PublishConfirmationMode;
  destinations: PublishDestination[];
  publishableDestinations: PublishDestination[];
  blockers: PublishConfirmationBlocker[];
  onlyPending: boolean;
};

export type ConfirmedPublishReceipt = PublishConfirmationSnapshot & {
  confirmedAt: string;
};

function provider(value: string): PublishProvider | null {
  const normalized = value.toLowerCase();
  return normalized === "pinterest" || normalized === "instagram" || normalized === "facebook"
    ? normalized
    : null;
}

/** Canonical stored choices only. Legacy/default Pinterest inference is deliberately excluded. */
export function explicitPublishDestinations(draft: Pick<PinDraft, "scheduledDestinations">): PublishDestination[] {
  return (draft.scheduledDestinations ?? []).flatMap(item => {
    const p = provider(item.provider);
    const connectionId = item.socialConnectionId?.trim();
    if (!p) return [];
    return [{
      id: destinationKey(p, connectionId || null),
      provider: p,
      socialConnectionId: connectionId || null,
      ...(item.accountLabel?.trim() ? { accountLabel: item.accountLabel.trim() } : {}),
      ...(item.boardId?.trim() ? { boardId: item.boardId.trim() } : {}),
      ...(item.boardName?.trim() ? { boardName: item.boardName.trim() } : {}),
    }];
  });
}

function stableString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableString(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function blocker(
  code: PublishConfirmationBlockerCode,
  message: string,
  destination?: PublishDestination,
): PublishConfirmationBlocker {
  return {
    code,
    message,
    ...(destination ? {
      provider: destination.provider,
      destinationId: destination.id,
      accountLabel: destination.accountLabel,
    } : {}),
  };
}

export function buildPublishConfirmation(
  draft: PinDraft,
  options: { onlyPending?: boolean; mode?: PublishConfirmationMode; actionId?: string } = {},
): PublishConfirmationSnapshot {
  const destinations = explicitPublishDestinations(draft);
  const media = contentMedia(draft);
  const blockers: PublishConfirmationBlocker[] = [];
  const publishableDestinations: PublishDestination[] = [];

  if (!destinations.length) {
    blockers.push(blocker("no_destinations", "Choose where to publish before publishing."));
  }
  for (const destination of destinations) {
    if (!destination.socialConnectionId?.trim()) {
      blockers.push(blocker("no_account", `Choose which ${destination.provider} account to publish as.`, destination));
      continue;
    }
    if (destination.provider === "pinterest" && !destination.boardId?.trim()) {
      blockers.push(blocker("missing_board", "Choose a Pinterest board before publishing.", destination));
      continue;
    }
    const publishMedia = media.map(item => ({ url: item.url, width: item.width, height: item.height }));
    const check = destination.provider === "pinterest"
      ? checkPinterestMedia(publishMedia)
      : destination.provider === "instagram"
        ? checkInstagramMedia(publishMedia)
        : checkFacebookMedia(publishMedia);
    if (!check.ok) {
      blockers.push(blocker(check.code, check.message, destination));
      continue;
    }
    publishableDestinations.push(destination);
  }

  const mode = options.mode ?? { kind: "now" as const };
  const onlyPending = options.onlyPending ?? true;
  const identity = {
    contentId: draft.contentId?.trim() || draft.id,
    draftId: draft.id,
    mode,
    title: draft.title ?? "",
    description: draft.description ?? "",
    altText: draft.altText ?? "",
    destinationUrl: draft.destinationUrl ?? "",
    media: media.map(item => ({ id: item.id, url: item.url, width: item.width ?? null, height: item.height ?? null })),
    destinations: destinations.map(item => ({
      id: item.id,
      provider: item.provider,
      socialConnectionId: item.socialConnectionId,
      accountLabel: item.accountLabel ?? null,
      boardId: item.boardId ?? null,
      boardName: item.boardName ?? null,
    })),
    blockers: blockers.map(item => ({ code: item.code, destinationId: item.destinationId ?? null })),
    onlyPending,
  };

  const fingerprint = fnv1a(stableString(identity));
  const generatedActionId = options.actionId?.trim()
    || globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const intentId = options.onlyPending && draft.publishIntentId
    ? draft.publishIntentId
    : `publish:${identity.contentId}:${generatedActionId}`;
  return {
    intentId,
    fingerprint,
    draftId: draft.id,
    contentId: identity.contentId,
    sourceUpdatedAt: draft.updatedAt,
    title: draft.title?.trim() || "Untitled content",
    description: draft.description ?? "",
    altText: draft.altText ?? "",
    destinationUrl: draft.destinationUrl ?? "",
    media,
    mode,
    destinations,
    publishableDestinations,
    blockers,
    onlyPending,
  };
}

export function confirmPublishSnapshot(
  snapshot: PublishConfirmationSnapshot,
  confirmedAt = new Date().toISOString(),
): ConfirmedPublishReceipt {
  return { ...snapshot, confirmedAt };
}

export function receiptMatchesDispatch(receipt: ConfirmedPublishReceipt, draft: PinDraft): boolean {
  if (receipt.draftId !== draft.id || receipt.sourceUpdatedAt !== draft.updatedAt || !receipt.publishableDestinations.length) return false;
  const confirmedAt = Date.parse(receipt.confirmedAt);
  if (!Number.isFinite(confirmedAt)) return false;
  const ids = new Set(receipt.publishableDestinations.map(destination => destination.id));
  if (ids.size !== receipt.publishableDestinations.length) return false;
  const rebuilt = buildPublishConfirmation({
    ...draft,
    title: receipt.title,
    description: receipt.description,
    altText: receipt.altText,
    destinationUrl: receipt.destinationUrl,
    media: receipt.media,
    imageUrl: receipt.media[0]?.url ?? draft.imageUrl,
    scheduledDestinations: receipt.destinations.map(destination => ({
      provider: destination.provider,
      socialConnectionId: destination.socialConnectionId ?? "",
      accountLabel: destination.accountLabel,
      boardId: destination.boardId,
      boardName: destination.boardName,
      capturedAt: receipt.confirmedAt,
    })),
  }, { onlyPending: receipt.onlyPending, mode: receipt.mode, actionId: "receipt-check" });
  if (rebuilt.fingerprint !== receipt.fingerprint) return false;
  const expectedPrefix = `publish:${receipt.contentId}:`;
  const actionId = receipt.intentId.startsWith(expectedPrefix) ? receipt.intentId.slice(expectedPrefix.length) : "";
  if (!/^[a-z0-9]{8,64}$/i.test(actionId)) return false;
  if (stableString(receipt.destinations) !== stableString(rebuilt.destinations)) return false;
  if (stableString(receipt.publishableDestinations) !== stableString(rebuilt.publishableDestinations)) return false;
  if (stableString(receipt.blockers) !== stableString(rebuilt.blockers)) return false;
  return receipt.publishableDestinations.every(destination =>
    !!destination.socialConnectionId?.trim()
    && (destination.provider !== "pinterest" || !!destination.boardId?.trim()));
}
