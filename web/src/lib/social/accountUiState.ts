/**
 * The single source of truth for the customer-visible state of a connected
 * social account (PRD §5/§6 "Social accounts 与多 Pinterest Account").
 *
 * Before this module the app carried three parallel vocabularies: the Pinterest
 * Settings panel's 3 visual states (not_connected / connected / limited_access),
 * the Social accounts chip's 5 raw ConnectionStatus values, and a third simplified
 * wording in Publish destinations. `limited_access` alone meant two different
 * things (a missing scope, which a reconnect fixes, vs a transient sync failure,
 * which it does not), and in the worst case a single account could show several
 * contradictory badges at once.
 *
 * Everything customer-facing now funnels through `accountUiState`, which returns
 * EXACTLY ONE of four states. Internal/technical detail (raw scopes, provider
 * errors, API environment) stays server-side or in Internal Admin — it never
 * reaches this function's output.
 *
 * Client-safe: pure, no env reads, no server imports.
 */

import type { ConnectionStatus } from "@/lib/social/platforms";

export type AccountUiState =
  | "connected"
  | "needs_attention"
  | "needs_reconnect"
  | "disconnected";

/**
 * Scopes a Pinterest connection must hold to be usable. Mirrors
 * `PINTEREST_REQUIRED_SCOPES` in lib/server/pinterest/config.ts — duplicated here
 * (rather than imported) because that module is server-only, and this one is
 * bundled into client components. `scripts/test-account-ui-state.ts` asserts the
 * two lists stay identical, so a drift is a test failure, not a silent bug.
 */
export const REQUIRED_PINTEREST_SCOPES_UI = [
  "boards:read",
  // Required, not optional: Pinterest v5 POST /pins fails 401 code 3
  // "Missing: ['boards:write']" without it, so a connection lacking it publishes
  // nothing. It has always been in PRODUCTION_SCOPES; leaving it out of the floor
  // showed those connections as Connected while every publish failed.
  "boards:write",
  "pins:read",
  "pins:write",
] as const;

/** Required Pinterest scopes the connection is missing (empty = nothing missing). */
export function missingRequiredPinterestScopes(
  scopes: readonly string[] | null | undefined,
): string[] {
  const granted = new Set(scopes ?? []);
  return REQUIRED_PINTEREST_SCOPES_UI.filter(scope => !granted.has(scope));
}

/**
 * Everything the UI is allowed to consider when deciding what a customer sees.
 * Deliberately small: adding a field here means adding a customer-visible reason,
 * which needs a product decision, not a quiet code change.
 */
export type AccountUiStateInput = {
  /**
   * The stored lifecycle status for this account. For Pinterest this is derived
   * server-side from `pinterest_connections` (connected / expired); for the other
   * platforms it is `social_connections.connection_status`.
   */
  connectionStatus?: ConnectionStatus | null;
  /** Pinterest's explicit "the token is dead, re-authorize" flag. */
  needsReconnect?: boolean | null;
  /** Granted OAuth scopes, when the caller knows them (Pinterest only today). */
  scopes?: readonly string[] | null;
  /** True when scope completeness should be enforced (i.e. this is Pinterest). */
  enforcePinterestScopes?: boolean;
  /**
   * A status/sync read failed for this account — the connection itself may be
   * perfectly fine. Never an outright block, so it ranks below needs_reconnect.
   */
  statusFetchFailed?: boolean;
  /**
   * The account record exists but is not currently connected (Pinterest's
   * `disconnected_at` is set, or the provider revoked us).
   */
  disconnectedAt?: string | null;
};

/**
 * Map internal connection facts to the ONE state the customer sees.
 *
 * Priority (PRD §6) — first match wins, so contradictory badges are impossible:
 *   needs_reconnect → needs_attention → disconnected → connected
 *
 * Mapping (PRD §5 + 审计 2026-08-05):
 *   pinterest needsReconnect=true .................. needs_reconnect
 *   pinterest missing a required scope ............. needs_reconnect  (a reconnect
 *       re-grants it — see dba5753, where a missing boards:write broke publishing
 *       and only re-authorization could fix it)
 *   pinterest status fetch / sync failed ........... needs_attention
 *   pinterest connected with every scope ........... connected
 *   pinterest disconnected_at set .................. disconnected
 *   social "connected" ............................. connected
 *   social "expired" ............................... needs_reconnect
 *   social "revoked" ............................... disconnected
 *   social "error" ................................. needs_attention
 *
 * `not_connected` is intentionally NOT one of the four: an empty platform slot is
 * not an account. The platform grid keeps its own "Not connected" + Connect
 * affordance; these four states describe ACCOUNT CARDS only. A `not_connected`
 * input therefore maps to `disconnected` (a record with no live connection),
 * which is the closest honest account-level statement.
 */
export function accountUiState(input: AccountUiStateInput): AccountUiState {
  const status = input.connectionStatus ?? null;

  // 1. Needs reconnect — re-authorization is the only fix.
  if (input.needsReconnect === true) return "needs_reconnect";
  if (status === "expired") return "needs_reconnect";
  if (
    input.enforcePinterestScopes === true &&
    // Only a live connection can be "missing a scope"; a revoked/absent one is
    // already covered by the disconnected branch below.
    status !== "revoked" &&
    status !== "not_connected" &&
    !input.disconnectedAt &&
    missingRequiredPinterestScopes(input.scopes).length > 0
  ) {
    return "needs_reconnect";
  }

  // 2. Needs attention — the account is still there, but something may affect publishing.
  if (status === "error") return "needs_attention";
  if (input.statusFetchFailed === true) return "needs_attention";

  // 3. Disconnected — the record survives, the connection does not.
  if (status === "revoked") return "disconnected";
  if (input.disconnectedAt) return "disconnected";
  if (status === "not_connected") return "disconnected";

  // 4. Connected.
  return "connected";
}

/** i18n key for the chip label of each state. */
export const ACCOUNT_UI_STATE_LABEL_KEY = {
  connected: "socialPanel.accountState.connected",
  needs_attention: "socialPanel.accountState.needsAttention",
  needs_reconnect: "socialPanel.accountState.needsReconnect",
  disconnected: "socialPanel.accountState.disconnected",
} as const;

/** i18n key for the one-line explanation shown under each state. */
export const ACCOUNT_UI_STATE_DESCRIPTION_KEY = {
  connected: "socialPanel.accountState.connectedDesc",
  needs_attention: "socialPanel.accountState.needsAttentionDesc",
  needs_reconnect: "socialPanel.accountState.needsReconnectDesc",
  disconnected: "socialPanel.accountState.disconnectedDesc",
} as const;

export type AccountUiStateTone = "green" | "amber" | "grey";

/**
 * Chip tone per PRD §5: amber for both attention states (something to do), grey
 * for disconnected (nothing is broken, it is just off), green for connected.
 */
export const ACCOUNT_UI_STATE_TONE: Record<AccountUiState, AccountUiStateTone> = {
  connected: "green",
  needs_attention: "amber",
  needs_reconnect: "amber",
  disconnected: "grey",
};
