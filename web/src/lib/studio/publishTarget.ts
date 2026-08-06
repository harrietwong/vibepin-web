/**
 * publishTarget.ts — the publish TARGET of a Pin: which connected Pinterest account
 * (and, through it, which Board) a draft publishes to.
 *
 * Pure logic, no React / no network / no DB, so the four invariants of PRD §13/§14/§17
 * can be asserted directly (scripts/test-publish-target.ts):
 *
 *   1. PINNED — once a draft carries `targetConnectionId`, nothing re-routes it. Changing
 *      the default account, changing the default board, or connecting another account
 *      leaves already-targeted drafts pointing exactly where they pointed
 *      (`resolvePublishTarget` returns the stored id, `adopted: false`).
 *   2. ADOPT-ONCE — a draft with no target (every draft created before this feature)
 *      falls back to `pickDefaultConnection`, which is precisely the pre-v59 behaviour,
 *      and the resolution is WRITTEN BACK (`adopted: true` ⇒ caller persists
 *      `targetPatch`). From that write on, rule 1 applies: the draft is pinned.
 *   3. SWITCHING ACCOUNTS CLEARS THE BOARD — `switchTargetPatch` always blanks
 *      boardId/boardName. Board ids are per-account; we never guess an equivalent board
 *      on the new account by name.
 *   4. SINGLE-CONNECTION USERS SEE NOTHING NEW — `shouldShowAccountPicker` is false for
 *      0 or 1 active connections, and with one connection the adopt-once resolution
 *      lands on the same row `forUser()` would have used, so behaviour is unchanged.
 */

/** The minimum a caller must know about a connection to target it. Structurally
 *  satisfied by both the server row (PinterestConnectionRow) and the client-side
 *  SocialConnection, so both sides share this logic. */
export interface TargetableConnection {
  id: string;
  /** Display handle of the account. Optional: freshly connected rows sync it later. */
  username?: string | null;
}

/** The two fields a resolved target writes onto the draft. */
export interface PublishTargetPatch {
  targetConnectionId: string;
  targetAccountLabel: string;
}

/** What a draft needs to expose for its target to be resolved. */
export interface TargetedDraftLike {
  targetConnectionId?: string;
  targetAccountLabel?: string;
}

export type PublishTargetResolution =
  | {
      /** The connection this Pin publishes to. */
      connectionId: string;
      /** True when the target was just decided (caller MUST persist `targetPatch`). */
      adopted: boolean;
      /** Present only when `adopted` — the fields to write back onto the draft. */
      targetPatch?: PublishTargetPatch;
    }
  | {
      /** No usable connection at all: the caller raises "not connected" as before. */
      connectionId: null;
      adopted: false;
      targetPatch?: undefined;
    };

/** A stored target id counts only when it is a non-blank string. */
export function readStoredTarget(draft: TargetedDraftLike | null | undefined): string {
  const raw = draft?.targetConnectionId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}

/**
 * Which account this draft publishes to.
 *
 * `active` must be the user's usable connections in the SAME order the server's
 * `listActiveConnections` returns them (created_at ascending), and `fallback` the row
 * `pickDefaultConnection` chose from them — so an adoption reproduces the pre-v59 target
 * exactly.
 *
 * A stored target that is no longer in `active` (the account was disconnected) is
 * deliberately KEPT, not silently re-pointed: the Pin still belongs to that account and
 * the retry guard asks the user to reconnect it (PRD §17). Re-routing it to another
 * account would publish to the wrong Pinterest profile.
 */
export function resolvePublishTarget(
  draft: TargetedDraftLike | null | undefined,
  fallback: TargetableConnection | null | undefined,
): PublishTargetResolution {
  const stored = readStoredTarget(draft);
  if (stored) return { connectionId: stored, adopted: false };
  if (!fallback) return { connectionId: null, adopted: false };
  return {
    connectionId: fallback.id,
    adopted: true,
    targetPatch: targetPatchFor(fallback),
  };
}

/** The draft patch that pins a Pin to `connection`. */
export function targetPatchFor(connection: TargetableConnection): PublishTargetPatch {
  return {
    targetConnectionId: connection.id,
    targetAccountLabel: (connection.username ?? "").trim(),
  };
}

/**
 * The draft patch for "the user picked a different account for this Pin".
 *
 * PRD §13: switching accounts ALWAYS clears the selected Board — board ids belong to one
 * account and mean nothing on another, and we do not match by name (two accounts can both
 * have a "Home decor" board that are entirely different boards). The user re-picks.
 */
export function switchTargetPatch(connection: TargetableConnection): PublishTargetPatch & {
  boardId: string;
  boardName: string;
} {
  return { ...targetPatchFor(connection), boardId: "", boardName: "" };
}

/**
 * Whether the account selector is rendered at all.
 *
 * C0.4: a user with one Pinterest account (all of them today) must see the exact UI they
 * saw before multi-account existed — no account row, no "publishing to @x" noise.
 */
export function shouldShowAccountPicker(active: readonly TargetableConnection[]): boolean {
  return active.length > 1;
}

/**
 * The connection a picker should show as selected: the pinned target when it is still
 * usable, else the default (what an adopt-once would land on). Returns null when the
 * pinned account is gone — the caller renders the reconnect guard rather than quietly
 * showing a different account as if it were this Pin's target.
 */
export function selectedTargetConnection(
  draft: TargetedDraftLike | null | undefined,
  active: readonly TargetableConnection[],
  fallback: TargetableConnection | null | undefined,
): TargetableConnection | null {
  const stored = readStoredTarget(draft);
  if (stored) return active.find(c => c.id === stored) ?? null;
  return fallback ?? null;
}

/** Reasons a targeted Pin cannot be retried as-is (PRD §17 retry guards). */
export type RetryBlockReason = "target_disconnected" | "board_unavailable";

export interface RetryGuardInput {
  draft: (TargetedDraftLike & { boardId?: string; boardName?: string }) | null | undefined;
  /** The user's usable connections right now. */
  active: readonly TargetableConnection[];
  /** Board ids currently readable on the TARGET account. `null` = not loaded yet
   *  (unknown ⇒ never block: an unloaded board list is not evidence of a missing board). */
  targetBoardIds: readonly string[] | null;
}

/**
 * Why a failed Pin can't be retried yet, or null when retry may proceed.
 *
 * Order matters: a disconnected target explains a missing board list too, so the
 * reconnect message wins — telling someone to "choose another Board" on an account they
 * can't reach is a dead end.
 */
export function retryBlockReason(input: RetryGuardInput): RetryBlockReason | null {
  const stored = readStoredTarget(input.draft);
  // No pinned target: retry adopts the default connection just like a first publish.
  if (!stored) return null;
  if (!input.active.some(c => c.id === stored)) return "target_disconnected";

  const boardId = typeof input.draft?.boardId === "string" ? input.draft.boardId.trim() : "";
  if (!boardId) return null;               // no board chosen yet — the editor asks for one
  if (input.targetBoardIds === null) return null; // unknown ⇒ don't block on a guess
  return input.targetBoardIds.includes(boardId) ? null : "board_unavailable";
}

/** The @handle to render in the retry guard, from the draft's own snapshot. */
export function targetAccountHandle(draft: TargetedDraftLike | null | undefined): string {
  const raw = draft?.targetAccountLabel;
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!label) return "";
  return label.startsWith("@") ? label : `@${label}`;
}
