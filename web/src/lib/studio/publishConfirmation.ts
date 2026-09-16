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
  /** Previous durable intent whose retry entitlement this new action consumes. */
  priorIntentId: string | null;
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
  /** Exact destinations this confirmation authorizes this action to dispatch. */
  dispatchDestinationIds: string[];
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

export function stablePublishString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableString(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Kept as a local alias so the canonical implementation above can be exported to
// the server receipt validator without making the existing call sites noisy.
const stableString = stablePublishString;

// Synchronous SHA-256 for a client-safe confirmation builder. WebCrypto's digest is
// async, while opening the dialog must capture one atomic snapshot in the click turn.
// This compact implementation follows FIPS 180-4 and is covered by known-vector tests.
export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (n: number, x: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(7, w[index - 15]) ^ rotr(18, w[index - 15]) ^ (w[index - 15] >>> 3);
      const s1 = rotr(17, w[index - 2]) ^ rotr(19, w[index - 2]) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[index] + w[index]) >>> 0;
      const s0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
  }
  return Array.from(h, word => word.toString(16).padStart(8, "0")).join("");
}

export type PublishConfirmationFingerprintInput = {
  priorIntentId: string | null;
  draftId: string;
  contentId: string;
  sourceUpdatedAt: string;
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  media: Array<{
    id: string;
    url: string;
    kind?: "image" | "video";
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    posterUrl?: string | null;
    altText?: string | null;
  }>;
  mode: PublishConfirmationMode;
  destinations: Array<{
    id: string;
    provider: PublishProvider;
    socialConnectionId?: string | null;
    accountLabel?: string | null;
    boardId?: string | null;
    boardName?: string | null;
  }>;
  dispatchDestinationIds: string[];
  blockers: Array<{ code: PublishConfirmationBlockerCode; destinationId?: string | null }>;
  onlyPending: boolean;
};

/**
 * The exact, environment-independent identity the dialog fingerprints and the API
 * verifies.  Keeping this in the client-safe module prevents the browser and server
 * from slowly acquiring different ideas of what the merchant confirmed.
 */
export function publishConfirmationFingerprint(input: PublishConfirmationFingerprintInput): string {
  return sha256Hex(stableString({
    contentId: input.contentId,
    draftId: input.draftId,
    priorIntentId: input.priorIntentId,
    sourceUpdatedAt: input.sourceUpdatedAt,
    mode: input.mode,
    title: input.title,
    description: input.description,
    altText: input.altText,
    destinationUrl: input.destinationUrl,
    media: input.media.map(item => item.kind === "video"
      ? {
          id: item.id,
          url: item.url,
          kind: "video",
          width: item.width ?? null,
          height: item.height ?? null,
          durationMs: item.durationMs ?? null,
          posterUrl: item.posterUrl?.trim() || null,
          altText: item.altText?.trim() || null,
        }
      // Byte-for-byte compatibility with the pre-video identity is deliberate:
      // adding even null video-only keys would invalidate every frozen image receipt.
      : {
          id: item.id,
          url: item.url,
          width: item.width ?? null,
          height: item.height ?? null,
        }),
    destinations: input.destinations.map(item => ({
      id: item.id,
      provider: item.provider,
      socialConnectionId: item.socialConnectionId,
      accountLabel: item.accountLabel ?? null,
      boardId: item.boardId ?? null,
      boardName: item.boardName ?? null,
    })),
    dispatchDestinationIds: [...input.dispatchDestinationIds].sort(),
    blockers: input.blockers.map(item => ({ code: item.code, destinationId: item.destinationId ?? null })),
    onlyPending: input.onlyPending,
  }));
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
  const media = contentMedia(draft).map(item => {
    if (item.kind !== "video") return item;
    const { altText, posterUrl, ...video } = item;
    const canonicalAltText = altText?.trim();
    const canonicalPosterUrl = posterUrl?.trim();
    return {
      ...video,
      ...(canonicalAltText ? { altText: canonicalAltText } : {}),
      ...(canonicalPosterUrl ? { posterUrl: canonicalPosterUrl } : {}),
    };
  });
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
  const priorIntentId = onlyPending && draft.publishIntentId?.trim()
    ? draft.publishIntentId.trim()
    : null;
  const resultByDestination = new Map(
    (draft.destinationResults ?? []).map(result => [result.destinationId, result]),
  );
  const dispatchDestinationIds = publishableDestinations
    .filter(destination => {
      if (!onlyPending) return true;
      const result = resultByDestination.get(destination.id);
      return result?.status !== "published" && result?.status !== "delivery_unknown";
    })
    .map(destination => destination.id)
    .sort();
  const identity = {
    priorIntentId,
    contentId: draft.contentId?.trim() || draft.id,
    draftId: draft.id,
    sourceUpdatedAt: draft.updatedAt,
    mode,
    title: draft.title?.trim() || "Untitled content",
    description: draft.description ?? "",
    altText: draft.altText ?? "",
    destinationUrl: draft.destinationUrl ?? "",
    media: media.map(item => ({
      id: item.id,
      url: item.url,
      kind: item.kind,
      width: item.width ?? null,
      height: item.height ?? null,
      ...(item.kind === "video" ? {
        durationMs: item.durationMs ?? null,
        posterUrl: item.posterUrl?.trim() || null,
        altText: item.altText?.trim() || null,
      } : {}),
    })),
    destinations: destinations.map(item => ({
      id: item.id,
      provider: item.provider,
      socialConnectionId: item.socialConnectionId,
      accountLabel: item.accountLabel ?? null,
      boardId: item.boardId ?? null,
      boardName: item.boardName ?? null,
    })),
    dispatchDestinationIds,
    blockers: blockers.map(item => ({ code: item.code, destinationId: item.destinationId ?? null })),
    onlyPending,
  };

  const fingerprint = publishConfirmationFingerprint(identity);
  const generatedActionId = options.actionId?.trim()
    || globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  // Every explicit confirmation is a distinct merchant action. A retry links to
  // the prior intent instead of reusing its id, so the database can consume each
  // prior destination's retry entitlement exactly once across server instances.
  const intentId = `publish:${identity.contentId}:${generatedActionId}`;
  return {
    intentId,
    priorIntentId,
    fingerprint,
    draftId: draft.id,
    contentId: identity.contentId,
    sourceUpdatedAt: identity.sourceUpdatedAt,
    title: identity.title,
    description: draft.description ?? "",
    altText: draft.altText ?? "",
    destinationUrl: draft.destinationUrl ?? "",
    media,
    mode,
    destinations,
    publishableDestinations,
    dispatchDestinationIds,
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
  const sameRevision = receipt.sourceUpdatedAt === draft.updatedAt
    || draft.publishIntentFingerprint === receipt.fingerprint;
  if (receipt.draftId !== draft.id || !sameRevision || !receipt.publishableDestinations.length) return false;
  const confirmedAt = Date.parse(receipt.confirmedAt);
  if (!Number.isFinite(confirmedAt)) return false;
  const ids = new Set(receipt.publishableDestinations.map(destination => destination.id));
  if (ids.size !== receipt.publishableDestinations.length) return false;
  const rebuilt = buildPublishConfirmation({
    ...draft,
    // Runtime lifecycle metadata may advance updatedAt after the first provider
    // returns. Rebuild the user-approved snapshot against its original revision;
    // the stored intent fingerprint is the proof that only metadata changed.
    updatedAt: receipt.sourceUpdatedAt,
    title: receipt.title,
    description: receipt.description,
    altText: receipt.altText,
    destinationUrl: receipt.destinationUrl,
    media: receipt.media,
    imageUrl: receipt.media[0]?.url ?? draft.imageUrl,
    // publishContent persists the NEW intent before either provider route is
    // called. Rebuild the exact merchant-approved pre-dispatch snapshot with its
    // parent, otherwise the second route in a mixed fan-out would mistake the
    // current action for its own retry parent.
    publishIntentId: receipt.priorIntentId ?? undefined,
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
  if (stableString(receipt.dispatchDestinationIds) !== stableString(rebuilt.dispatchDestinationIds)) return false;
  if (stableString(receipt.blockers) !== stableString(rebuilt.blockers)) return false;
  return receipt.publishableDestinations.every(destination =>
    !!destination.socialConnectionId?.trim()
    && (destination.provider !== "pinterest" || !!destination.boardId?.trim()));
}
