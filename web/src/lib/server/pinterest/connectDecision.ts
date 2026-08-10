/**
 * The Pinterest OAuth callback's "which row does this authorization belong to?"
 * decision — as a pure function, so it can be tested without an HTTP round trip.
 *
 * Why this exists (PRD §9.2 / §10): before v59 the callback did no identity check at
 * all. It upserted on the user id and wrote NULL over the stored account fields, so
 * authorizing with a SECOND Pinterest account silently replaced the first one's
 * tokens — the user's Pins kept publishing, just to a different account, with no
 * error and nothing in the UI that could have shown the swap. A reconnect that lands
 * on the wrong account must be REFUSED, not absorbed.
 *
 * The route does the IO (fetch the identity, write the row, redirect); this decides.
 */

/** Identity of the Pinterest account that just authorized. */
export type AuthorizedAccount = {
  id: string | null;
  username: string | null;
  accountType: string | null;
};

/** What the callback needs to know about one connection the user already has. */
export type ExistingConnection = {
  connectionId: string;
  /** Pinterest's own account id. Null on a connection whose profile never synced. */
  accountId: string | null;
  username: string | null;
  /** True when the user disconnected it — reconnecting must revive THIS row. */
  disconnected: boolean;
};

export type ConnectDecision =
  /** No row matches this account → add it as a new connection. */
  | { action: "create"; account: AuthorizedAccount }
  /** This account already has a row → update that row in place (reconnect). */
  | { action: "update"; connectionId: string; account: AuthorizedAccount; revived: boolean }
  /**
   * A reconnect was aimed at one connection but a different account authorized.
   * Nothing is written; the UI offers PRD §10's two options.
   */
  | { action: "reject"; reason: "account_mismatch"; expectedUsername: string | null; gotUsername: string | null };

export type DecideInput = {
  /** Identity Pinterest reported for the token we just obtained. */
  account: AuthorizedAccount;
  /** Every Pinterest connection the user holds, disconnected ones included. */
  existing: ExistingConnection[];
  /**
   * The connection this authorization was meant to repair, when the flow was started
   * as a reconnect (carried through the sealed OAuth state). Undefined for a plain
   * "Connect" / "Add account".
   */
  reconnectTargetId?: string | null;
};

/** Same Pinterest account? Only a real id on BOTH sides can prove identity. */
function sameAccount(a: string | null, b: string | null): boolean {
  return !!a && !!b && a === b;
}

/**
 * Decide what the callback should do with a freshly authorized Pinterest account.
 *
 * Order matters:
 *  1. A reconnect aimed at a specific connection is checked FIRST — landing on a
 *     different account is a refusal even if that other account is also connected,
 *     because silently redirecting the write to the other row is the same surprise
 *     from the user's point of view.
 *  2. Otherwise, an account that already has a row updates that row (this is how a
 *     plain "Reconnect" with the right account, and a duplicate "Add account", both
 *     land on one record instead of two — PRD §9.1 "no second record").
 *  3. Otherwise it is a new account for this user → create.
 */
export function decideConnect(input: DecideInput): ConnectDecision {
  const { account, existing, reconnectTargetId } = input;

  if (reconnectTargetId) {
    const target = existing.find(c => c.connectionId === reconnectTargetId);
    if (target) {
      // An unidentified target (profile never synced, so we have nothing to compare)
      // cannot produce a mismatch — adopting the account that just authorized is the
      // only way it can ever gain an identity.
      if (!target.accountId) {
        return { action: "update", connectionId: target.connectionId, account, revived: target.disconnected };
      }
      if (sameAccount(target.accountId, account.id)) {
        return { action: "update", connectionId: target.connectionId, account, revived: target.disconnected };
      }
      return {
        action: "reject",
        reason: "account_mismatch",
        expectedUsername: target.username,
        gotUsername: account.username,
      };
    }
    // The targeted connection is gone (removed in another tab / another device).
    // Fall through: match by identity below, else treat as a fresh Add.
  }

  const byIdentity = existing.find(c => sameAccount(c.accountId, account.id));
  if (byIdentity) {
    return {
      action: "update",
      connectionId: byIdentity.connectionId,
      account,
      revived: byIdentity.disconnected,
    };
  }

  // No identity match. One special case: a single connection that never synced its
  // profile is this user's only candidate for "the row that means this account" —
  // otherwise every reconnect from before the identity sync landed would fork a
  // duplicate row. Requires exactly one such row and no other connections, so it can
  // never absorb a genuinely different account on a multi-account user.
  if (!account.id && existing.length === 1 && !existing[0].accountId) {
    return { action: "update", connectionId: existing[0].connectionId, account, revived: existing[0].disconnected };
  }

  return { action: "create", account };
}
