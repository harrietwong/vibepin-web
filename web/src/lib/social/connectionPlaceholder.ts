/**
 * "Is this social_connections row an account at all?" — ONE predicate, shared by
 * every place that has to answer it.
 *
 * `savePinterestDefaultBoard` inserts a metadata-only row when a merchant picks a
 * default board before any Pinterest account is connected: no token, no
 * disconnect timestamp, no provider account id. It remembers a board; it is not an
 * account anybody ever connected.
 *
 * Two consumers, and they must never disagree:
 *   - the Settings listing (`social/server/socialConnectionStore.ts`) skips it, so the
 *     merchant is never shown a "Disconnected" row for an account that never existed;
 *   - the plan-slot count (`server/social/accountAllowance.ts`) skips it, so a legacy
 *     user carrying one is not refused their FIRST real account. Under the counting
 *     rule (PRD 0805 §11) every row held occupies a slot and only Remove frees one —
 *     but a row nobody ever connected holds nothing, and Settings offers no Remove for
 *     a row it does not list, so counting it would make that refusal inescapable.
 *
 * What is NOT a placeholder — each of these is a real account and keeps its slot:
 *   - a DISCONNECTED row: token cleared, disconnect timestamp set. It keeps its
 *     identity, its slot and a Reconnect.
 *   - a soft-disconnected Facebook/Instagram row: token cleared, identity kept.
 *   - a live row whose identity has not synced yet: the Pinterest callback may insert
 *     with a null provider account id and backfill it afterwards (`updateAccountInfo`),
 *     so "it holds a token" is the fact that saves it.
 *
 * Pure and dependency-free on purpose: no Supabase client, no env — both consumers and
 * their tests import the same three-line rule instead of restating it.
 */

/**
 * The three facts that decide it, named independently of any one table shape: the
 * Pinterest row type calls the account id `pinterest_user_id`, the raw
 * `social_connections` column is `provider_account_id`, and both map onto this.
 *
 * Every key is REQUIRED on purpose. An optional `providerAccountId` would let a caller
 * hand over a row that merely spells it differently, silently drop the identity fact,
 * and turn a real account into a placeholder.
 */
export type ConnectionRowFacts = {
  /** Whether the row holds an access token — the fact, never the ciphertext. */
  hasAccessToken: boolean;
  /** When the account was disconnected; null/undefined = never disconnected. */
  disconnectedAt: string | null | undefined;
  /** The provider-side account id, if this row was ever identified. */
  providerAccountId: string | null | undefined;
};

/** A row nobody ever connected: no token, never disconnected, no account behind it. */
export function isPlaceholderConnectionRow(facts: ConnectionRowFacts): boolean {
  return !facts.hasAccessToken && !facts.disconnectedAt && !facts.providerAccountId;
}
