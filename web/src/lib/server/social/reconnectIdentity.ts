/**
 * "Did this reconnect land on the account it was aimed at?" — as a pure function,
 * so both the Facebook and the Instagram callback can decide it without an HTTP
 * round trip, and a test can drive every branch directly.
 *
 * Why this exists (Codex #5): Facebook and Instagram accepted a `reconnect=<id>`
 * on the connect start, but only ever used it to skip the plan gate. It was never
 * carried to the callback, so when the merchant authorized as a DIFFERENT account
 * the store fell back to matching by identity, found nothing, and INSERTED — a new
 * row that ate a free slot while the row they were trying to repair stayed
 * disconnected. Nothing in the UI said so. Pinterest already refuses that case
 * (server/pinterest/connectDecision.ts); this is the same refusal for the two
 * providers that share the social_connections table.
 *
 * Deliberately NOT a copy of Pinterest's `decideConnect`. That one also owns
 * "which row does a PLAIN connect belong to?", a question the Facebook and
 * Instagram stores already answer for themselves (pickRowForFacebookUser /
 * provider_account_id matching). Duplicating it here would create a second,
 * drifting answer. This module answers exactly one question — reconnect identity —
 * and hands the rest back to the store.
 */

/** What the callback needs to know about the row a reconnect was aimed at. */
export type ReconnectTargetRow = {
  /** The social_connections row id. */
  connectionId: string;
  /**
   * The provider's own account id recorded on that row — Instagram's
   * `provider_account_id`, Facebook's `metadata.facebook.facebookUserId`. Null on a
   * row that never recorded one (written before multi-account, or still mid-OAuth).
   */
  accountId: string | null;
  /** Human label for the banner (@username / Page name / account name). */
  label: string | null;
};

export type ReconnectDecision =
  /**
   * Write is allowed. `targetConnectionId` names the row the store must UPDATE
   * (never consumes a slot); null means "no specific row — let the store match by
   * identity as it always has", which is the plain-connect path.
   */
  | { action: "proceed"; targetConnectionId: string | null }
  /**
   * A reconnect aimed at one account, but a different one authorized. NOTHING may
   * be written — no token refresh, no insert. The panel offers the same two
   * options Pinterest's mismatch banner does.
   */
  | { action: "reject"; reason: "account_mismatch"; expectedLabel: string | null; gotLabel: string | null };

export type DecideReconnectInput = {
  /**
   * The connection id sealed into the OAuth state at connect time, or null for a
   * plain Connect / Add another account.
   */
  reconnectTargetId: string | null | undefined;
  /**
   * That row, as read back from the store scoped to THIS user and provider — or
   * null when it no longer exists (removed in another tab / on another device).
   * The caller must never resolve it from the client-supplied id alone.
   */
  target: ReconnectTargetRow | null;
  /** The provider account id that actually authorized just now. */
  authorizedAccountId: string | null;
  /** Its display label, for the mismatch banner. */
  authorizedLabel: string | null;
};

/** Same account? Only a real id on BOTH sides can prove identity. */
function sameAccount(a: string | null, b: string | null): boolean {
  return !!a && !!b && a === b;
}

/**
 * Decide whether a freshly authorized account may be written to the row a
 * reconnect was aimed at.
 *
 * The branches, and why each is what it is:
 *  1. No reconnect target → plain connect. Unchanged behaviour: the store matches
 *     by identity and inserts when there is no such row (quota-checked there).
 *  2. Target row is GONE → also plain connect. Refusing would strand a merchant
 *     whose row was removed in another tab; the store's insert branch re-checks the
 *     plan limit, which matters here because the connect START skipped that gate
 *     for a reconnect. Mirrors Pinterest's decideConnect fall-through.
 *  3. Target has no recorded identity → adopt it. There is nothing to compare, and
 *     adopting is the only way that row can ever gain an identity. Naming the row
 *     explicitly is load-bearing: with two rows on the platform the store's own
 *     "lone unidentified row" rule would NOT match, so it would insert a duplicate.
 *  4. Identity matches → update that exact row.
 *  5. Anything else — including an authorization whose identity we could not read —
 *     is a refusal. Writing an unidentifiable token over a known account is exactly
 *     the silent swap this exists to prevent.
 */
export function decideReconnect(input: DecideReconnectInput): ReconnectDecision {
  const { reconnectTargetId, target, authorizedAccountId, authorizedLabel } = input;

  if (!reconnectTargetId) return { action: "proceed", targetConnectionId: null };
  if (!target) return { action: "proceed", targetConnectionId: null };

  if (!target.accountId) {
    return { action: "proceed", targetConnectionId: target.connectionId };
  }
  if (sameAccount(target.accountId, authorizedAccountId)) {
    return { action: "proceed", targetConnectionId: target.connectionId };
  }

  return {
    action: "reject",
    reason: "account_mismatch",
    expectedLabel: target.label,
    gotLabel: authorizedLabel,
  };
}
