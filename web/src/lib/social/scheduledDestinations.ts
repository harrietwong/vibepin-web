/**
 * Scheduled publish INTENT — the canonical read/write rules.
 *
 * Three separate business facts, kept separate on purpose (the P0 architecture
 * decision):
 *
 *   A. intent   where a Pin is MEANT to publish when its time comes.
 *               Lives on the draft (`payload.scheduledDestinations`).
 *   B. attempt  a publish execution that actually started.
 *               `social_publish_jobs`, created only when dispatch begins.
 *   C. result   what each destination of that attempt achieved.
 *               `social_publish_job_destinations`.
 *
 * Conflating A with B/C is what produced the defect this fixes: the merchant's
 * multi-platform choice existed only in React state, so a three-platform
 * schedule silently executed as Pinterest-only. Pre-creating job rows at
 * schedule time would have been the other wrong answer — `customer360` and
 * `adminOverview` both read every job row as publishing activity that already
 * happened, so future intent sitting in those tables would corrupt analytics.
 *
 * This module is import-safe on both server and client: no secrets, no Node
 * APIs, no DB access.
 */

import { isSocialProvider, type SocialProvider } from "./platforms";
import type { PinDraft, ScheduledDestination } from "../pinDraftStore";

/** Trim a possibly-undefined string field to a usable value, or "". */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Build the intent record for a Pinterest destination from the draft's existing
 * pinned target. This is the shape the drawer writes and the shape historical
 * drafts are read AS — it is deliberately the same code path, so a legacy Pin
 * and a freshly scheduled one behave identically at due time.
 */
export function pinterestDestinationFrom(
  draft: Partial<Pick<PinDraft, "targetConnectionId" | "targetAccountLabel" | "boardId" | "boardName">>,
  capturedAt: string,
): ScheduledDestination | null {
  const connectionId = str(draft.targetConnectionId);
  if (!connectionId) return null;
  const d: ScheduledDestination = {
    provider: "pinterest",
    socialConnectionId: connectionId,
    capturedAt,
  };
  const label = str(draft.targetAccountLabel);
  const boardId = str(draft.boardId);
  const boardName = str(draft.boardName);
  if (label) d.accountLabel = label;
  if (boardId) d.boardId = boardId;
  if (boardName) d.boardName = boardName;
  return d;
}

/** A stored entry is only usable if it names a real provider AND an account. */
export function isUsableDestination(d: unknown): d is ScheduledDestination {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return isSocialProvider(r.provider) && !!str(r.socialConnectionId);
}

/**
 * THE read rule. Everything that needs to know where a scheduled Pin should
 * publish — the due-time worker above all — must go through this.
 *
 * Stored intent wins. When there is none (every Pin scheduled before this
 * feature existed), the Pinterest target already pinned on the draft is derived
 * as an equivalent Pinterest-only intent.
 *
 * That derivation is deliberately READ-SIDE rather than a backfill migration:
 *
 *   - Rewriting ~3.7k historical payloads would bump every `updatedAt` and push
 *     a full LWW re-sync to every client — a large, irreversible cost for data
 *     we can compute exactly.
 *   - It is a pure function, so it is testable and cannot corrupt stored rows.
 *
 * It NEVER invents Instagram or Facebook. Those were never recorded for
 * historical Pins, so they cannot be recovered — and guessing them from the
 * currently-connected accounts or the workspace default would fabricate a
 * merchant decision that was never made.
 */
export function resolveScheduledDestinations(
  draft: Partial<
    Pick<
      PinDraft,
      "scheduledDestinations" | "targetConnectionId" | "targetAccountLabel" | "boardId" | "boardName"
    >
  >,
): ScheduledDestination[] {
  const stored = Array.isArray(draft.scheduledDestinations) ? draft.scheduledDestinations : [];
  const usable = stored.filter(isUsableDestination);
  if (usable.length) return usable;

  // Legacy Pin: derive Pinterest-only from the pinned target, if it has one.
  // `capturedAt` reflects that this was derived now, not chosen by the merchant.
  const derived = pinterestDestinationFrom(draft, new Date().toISOString());
  return derived ? [derived] : [];
}

/**
 * True when a draft carries destination intent the merchant explicitly chose,
 * as opposed to intent we derived from a legacy Pinterest target. Callers that
 * must not treat a derivation as a merchant decision (e.g. anything offering to
 * "keep your previous destinations") use this.
 */
export function hasExplicitIntent(draft: Partial<Pick<PinDraft, "scheduledDestinations">>): boolean {
  return Array.isArray(draft.scheduledDestinations)
    && draft.scheduledDestinations.filter(isUsableDestination).length > 0;
}

/** A connected account as the destination picker reports it. */
export type ConnectableAccount = {
  id: string;
  connectionStatus: string;
  providerAccountUsername?: string | null;
  providerAccountName?: string | null;
};

/** Raised when a platform has several connected accounts and none was chosen. */
export class AmbiguousScheduleAccountError extends Error {
  constructor(public readonly provider: SocialProvider, public readonly count: number) {
    super(`Choose which ${provider} account to publish as — ${count} are connected.`);
    this.name = "AmbiguousScheduleAccountError";
  }
}

/**
 * Which account a scheduled publish should go out as.
 *
 * The order matters and is the whole point:
 *
 *   1. An account the merchant EXPLICITLY picked always wins. Once several
 *      accounts can be connected per platform, "the first connected one" stops
 *      being a synonym for "the one they meant".
 *   2. Exactly one connected account ⇒ use it. Unambiguous, and it keeps the
 *      single-account experience free of a choice nobody needs to make.
 *   3. Several connected and no explicit pick ⇒ THROW. Picking the first would
 *      quietly schedule months of posts to the wrong account, and the merchant
 *      would only find out by seeing them appear there.
 *
 * Returns null only when the platform has no connected account at all, which the
 * caller reports as "not connected" rather than an ambiguity.
 */
export function resolveScheduledAccount(
  provider: SocialProvider,
  accounts: readonly ConnectableAccount[],
  explicitId?: string | null,
): { id: string; label?: string } | null {
  const connected = accounts.filter(a => a.connectionStatus === "connected");
  const labelOf = (a: ConnectableAccount) =>
    str(a.providerAccountUsername) || str(a.providerAccountName) || undefined;

  const chosen = str(explicitId);
  if (chosen) {
    const hit = connected.find(a => a.id === chosen);
    if (hit) return { id: hit.id, label: labelOf(hit) };
    // An explicit pick that is no longer connected must not silently fall back to
    // a different account — that is the same wrong-account failure by another route.
    return null;
  }

  if (connected.length === 0) return null;
  if (connected.length === 1) return { id: connected[0].id, label: labelOf(connected[0]) };
  throw new AmbiguousScheduleAccountError(provider, connected.length);
}

/**
 * One destination the merchant ticked, as the picker reports it.
 *
 * `socialConnectionId` is optional ONLY for the single-account case: a platform row
 * ticked when exactly one account is connected needs no second click, and the account
 * is resolved here. With several connected accounts the picker must name one — an
 * unnamed pick then throws rather than guessing (see `resolveScheduledAccount`).
 *
 * Pinterest picks carry their OWN board: two Pinterest accounts are two destinations
 * with two different boards, and a board id means nothing on the other account.
 */
export type DestinationPick = {
  provider: SocialProvider;
  socialConnectionId?: string | null;
  accountLabel?: string | null;
  boardId?: string | null;
  boardName?: string | null;
};

/** How the picker reports each platform's connected accounts to the builder. */
export type AccountsByProvider =
  | ReadonlyArray<{ provider: string; accounts: readonly ConnectableAccount[] }>
  | ((provider: SocialProvider) => readonly ConnectableAccount[]);

function accountsFor(source: AccountsByProvider, provider: SocialProvider): readonly ConnectableAccount[] {
  if (typeof source === "function") return source(provider);
  return source.find(s => s.provider === provider)?.accounts ?? [];
}

/**
 * THE write rule: turn the merchant's current selection into frozen intent.
 *
 * N entries per provider are allowed — two Pinterest accounts, two Instagram accounts,
 * each its own destination with its own board and its own result row. Entries are
 * deduped by `${provider}:${socialConnectionId}`, so a picker that reports the same
 * account twice (platform row + account row) records it once.
 *
 * A pick that resolves to no account is DROPPED rather than stored as a half-record
 * that would fail at due time with nothing to point at; a pick that is ambiguous
 * THROWS (`AmbiguousScheduleAccountError`) so the caller can refuse the selection
 * instead of quietly publishing to the wrong account. Callers that prefer to collect
 * the error per-provider catch it around their own loop.
 */
export function buildScheduledDestinations(
  picks: readonly DestinationPick[],
  draft: Partial<Pick<PinDraft, "targetConnectionId" | "targetAccountLabel" | "boardId" | "boardName">>,
  accounts: AccountsByProvider,
  now: Date = new Date(),
): ScheduledDestination[] {
  const capturedAt = now.toISOString();
  const out: ScheduledDestination[] = [];
  const seen = new Set<string>();
  for (const pick of picks) {
    if (!isSocialProvider(pick.provider)) continue;
    const explicit = str(pick.socialConnectionId);
    // An explicit id is the merchant's own choice and is taken as given — but it is
    // still checked against the connected list so a disconnected account cannot be
    // frozen as intent (resolveScheduledAccount returns null for that).
    const resolved = resolveScheduledAccount(pick.provider, accountsFor(accounts, pick.provider), explicit || null);
    if (!resolved || !str(resolved.id)) continue;
    const key = `${pick.provider}:${resolved.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d: ScheduledDestination = {
      provider: pick.provider,
      socialConnectionId: resolved.id,
      capturedAt,
    };
    const label = str(pick.accountLabel) || str(resolved.label);
    if (label) d.accountLabel = label;
    if (pick.provider === "pinterest") {
      // The board this ENTRY publishes to. The draft-level board is only a fallback
      // for the entry that IS the legacy target — never for a second account, whose
      // board would then be another account's board.
      const isLegacyTarget = resolved.id === str(draft.targetConnectionId);
      const boardId = str(pick.boardId) || (isLegacyTarget ? str(draft.boardId) : "");
      const boardName = str(pick.boardName) || (isLegacyTarget ? str(draft.boardName) : "");
      if (boardId) d.boardId = boardId;
      if (boardName) d.boardName = boardName;
    }
    out.push(d);
  }
  return out;
}

/**
 * The legacy Pinterest mirror for a set of entries: the FIRST Pinterest entry.
 *
 * The mirror describes ONE Pinterest target, and every un-migrated reader (the plan
 * drawer's board field, admin views, older cron code paths) reads it as such. With N
 * Pinterest entries there is no honest single answer, so the first entry — the one the
 * merchant sees first on the chip row — is the one mirrored, and the rest live only in
 * `scheduledDestinations`. Returns cleared fields when there is no Pinterest entry, so
 * unticking Pinterest cannot leave a stale target pinned to the draft.
 */
export function legacyPinterestMirror(
  destinations: readonly ScheduledDestination[],
): Pick<PinDraft, "targetConnectionId" | "targetAccountLabel" | "boardId" | "boardName"> {
  const first = destinations.find(d => d.provider === "pinterest" && !!str(d.socialConnectionId));
  return {
    targetConnectionId: first ? first.socialConnectionId : "",
    targetAccountLabel: first ? str(first.accountLabel) : "",
    boardId: first ? str(first.boardId) : "",
    boardName: first ? str(first.boardName) : "",
  };
}

/**
 * Move the board onto the ONE Pinterest entry the card's board field speaks for.
 *
 * The card shows a single Board field, and editing it IS changing where this Pin
 * publishes (owner decision, 2026-08-27). Writing only the legacy `boardId`/`boardName`
 * left the stored entry — the thing the cron actually publishes to — on the previous
 * board, so the card showed the new board while the Pin went to the old one. Silently,
 * and only discoverable after it had already happened.
 *
 * WHICH entry: the one whose account the draft's legacy target names, because that is
 * the target the card's field describes. With no match (or nothing to match on) the
 * FIRST Pinterest entry is used — the same entry `legacyPinterestMirror` mirrors, so
 * the two views of "the card's Pinterest target" cannot drift apart. A second Pinterest
 * account's entry is never touched: a board id means nothing on the other account.
 *
 * With NO Pinterest entry the list comes back unchanged. The legacy fields alone are
 * then correct, since `resolveScheduledDestinations` derives Pinterest-only intent from
 * them for exactly that case.
 *
 * Pure: a new array, one copied entry, only its board fields changed — `capturedAt` and
 * `accountLabel` stay as captured. Clearing the board clears those keys rather than
 * storing "", which is how every other writer in this module records them.
 */
export function withBoardOnPinterestEntry(
  destinations: readonly ScheduledDestination[] | null | undefined,
  targetConnectionId: string | null | undefined,
  board: { boardId?: string | null; boardName?: string | null },
): ScheduledDestination[] {
  const list = Array.isArray(destinations) ? destinations.slice() : [];
  const isPinterest = (d: ScheduledDestination) => d.provider === "pinterest" && !!str(d.socialConnectionId);
  const target = str(targetConnectionId);
  let idx = target ? list.findIndex(d => isPinterest(d) && str(d.socialConnectionId) === target) : -1;
  if (idx < 0) idx = list.findIndex(isPinterest);
  if (idx < 0) return list;
  const boardId = str(board.boardId);
  const boardName = str(board.boardName);
  const next: ScheduledDestination = { ...list[idx] };
  if (boardId) next.boardId = boardId; else delete next.boardId;
  if (boardName) next.boardName = boardName; else delete next.boardName;
  list[idx] = next;
  return list;
}

/** The providers named by a draft's effective intent, in order. */
export function scheduledProviders(
  draft: Parameters<typeof resolveScheduledDestinations>[0],
): SocialProvider[] {
  return resolveScheduledDestinations(draft)
    .map(d => d.provider)
    .filter(isSocialProvider);
}
