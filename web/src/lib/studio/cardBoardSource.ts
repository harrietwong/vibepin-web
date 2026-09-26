/**
 * Which Pinterest account the Create Pins card's Board field lists boards for, and
 * what that field should say while those boards load / fail / come back empty.
 *
 * Boards belong to ONE Pinterest account. The card's Board field used to read the
 * user's DEFAULT account's boards no matter which account the draft publishes as —
 * for a merchant with two connected accounts that meant the field could list (or,
 * when the default account had no boards, fail to list) boards the chosen account
 * cannot publish to. It now follows the account the draft's explicit destination
 * names, and says which account that is.
 *
 * Pure so it can be tested without mounting the card.
 */

import type { PinDraft } from "@/lib/pinDraftStore";
import { explicitPublishDestinations } from "@/lib/studio/publishConfirmation";

/** Studio-internal QA / sandbox boards that must never appear in a customer board picker. */
export function isInternalBoardName(name: string | null | undefined): boolean {
  return /^(qa board|vibepin sandbox demo board|sandbox demo board)$/i.test(name?.trim() ?? "");
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The connection id whose boards the card's Board field lists, or null for "the user's
 * default account".
 *
 * Mirrors the entry the field WRITES to (withBoardOnPinterestEntry): the explicit
 * Pinterest destination whose account the draft's `targetConnectionId` names, else the
 * first explicit Pinterest destination with an account (the one legacyPinterestMirror
 * copies into `targetConnectionId`). A bare legacy `targetConnectionId` still counts, so
 * a draft pinned to an account before destinations existed keeps that account's boards.
 */
export function resolveCardBoardConnectionId(
  draft: Pick<PinDraft, "targetConnectionId"> & Parameters<typeof explicitPublishDestinations>[0],
): string | null {
  const pinterest = explicitPublishDestinations(draft)
    .filter(d => d.provider === "pinterest" && !!str(d.socialConnectionId));
  const target = str(draft.targetConnectionId);
  if (target && pinterest.some(d => str(d.socialConnectionId) === target)) return target;
  if (pinterest.length) return str(pinterest[0].socialConnectionId);
  return target || null;
}

export type CardBoardAccount = {
  id: string;
  providerAccountUsername?: string | null;
  providerAccountName?: string | null;
};

/**
 * The account label shown next to the Board field ("@h8rrietstudio"). With no explicit
 * account the default is the OLDEST usable account — index 0 of the server's
 * created_at-ascending list, which is exactly the row `pickDefaultConnection` resolves
 * for a boards request that names no connection. Null when the account is not (yet) known.
 */
export function cardBoardAccountLabel(
  connectionId: string | null,
  accounts: readonly CardBoardAccount[],
): string | null {
  const account = connectionId ? accounts.find(a => a.id === connectionId) : accounts[0];
  if (!account) return null;
  const username = str(account.providerAccountUsername);
  if (username) return username.startsWith("@") ? username : `@${username}`;
  return str(account.providerAccountName) || null;
}

export type CardBoardState = "loading" | "error" | "needs_reconnect" | "not_connected" | "empty" | "ready";

/**
 * One state for the Board field. Order matters: a loading request is never reported as
 * "no boards", and a failed request is never reported as "this account has no boards" —
 * those two used to look identical (an empty list with only the placeholder).
 */
export function cardBoardState(input: {
  loading: boolean;
  error: boolean;
  needsReconnect: boolean;
  disconnected: boolean;
  boardCount: number;
}): CardBoardState {
  if (input.boardCount > 0) return "ready";
  if (input.loading) return "loading";
  if (input.needsReconnect) return "needs_reconnect";
  if (input.disconnected) return "not_connected";
  if (input.error) return "error";
  return "empty";
}
