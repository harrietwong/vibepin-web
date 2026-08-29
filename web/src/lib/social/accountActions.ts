/**
 * What a customer may DO to one connected account row (PRD 0809 §II / PRD 0805 §4-§11).
 *
 * The four customer-visible states live in `accountUiState.ts`; this module is the
 * other half of that contract — the actions each state offers. Keeping the mapping
 * here, pure and table-shaped, is deliberate:
 *
 *  · The panel used to derive its buttons from a SECOND set of booleans
 *    (`healthy` / `degraded`) computed alongside the chip. Two derivations of the
 *    same fact is exactly how a row ends up showing "Connected" next to a
 *    Reconnect button.
 *  · The actions are per-ACCOUNT, not per-platform. The old platform-level
 *    "Disconnect Pinterest" had no meaning once a merchant held two accounts:
 *    it tore down every connection at once.
 *
 * Client-safe: pure, no env reads, no server imports, no i18n lookups.
 */

import { accountUiState, type AccountUiState } from "./accountUiState";
import type { SocialProvider } from "./platforms";
import type { SocialConnection } from "./types";

/**
 * The three things a row can offer.
 *
 *  · disconnect — SOFT. Invalidate the stored credentials, keep the account record.
 *    Reversible by reconnecting; nothing the merchant configured is thrown away.
 *  · reconnect  — Re-authorize THIS account so it can publish again.
 *  · remove     — HARD. Delete the account record. Offered on every row because it
 *    is the only way to free a plan slot, and (unlike disconnect) it is what the
 *    merchant wants when the account is gone for good.
 */
export type AccountRowAction = "disconnect" | "reconnect" | "remove";

/**
 * State → actions. First-class data rather than branching in JSX so it can be
 * asserted directly (scripts/test-settings-account-actions.ts).
 *
 *   connected       → Disconnect  · Remove
 *   needs_attention → Reconnect   · Remove
 *   needs_reconnect → Reconnect   · Remove
 *   disconnected    → Reconnect   · Remove
 *
 * `needs_attention` deliberately offers Reconnect and NOT Disconnect: the state
 * means "something may stop this account publishing", and re-authorizing is the
 * one action that can fix it. Offering Disconnect there would present the
 * destructive option as the remedy for a problem it does not solve.
 *
 * Order is the render order: the repair-or-teardown action first, Remove last.
 */
export const ACCOUNT_ROW_ACTIONS: Record<AccountUiState, readonly AccountRowAction[]> = {
  connected: ["disconnect", "remove"],
  needs_attention: ["reconnect", "remove"],
  needs_reconnect: ["reconnect", "remove"],
  disconnected: ["reconnect", "remove"],
};

/** The actions offered for one account state. Never empty — Remove is always there. */
export function accountRowActions(state: AccountUiState): readonly AccountRowAction[] {
  return ACCOUNT_ROW_ACTIONS[state];
}

/**
 * Visual weight. Remove is secondary on every row: it is irreversible, and on a
 * healthy account the action the merchant almost always wants is Disconnect.
 */
export function isSecondaryAccountAction(action: AccountRowAction): boolean {
  return action === "remove";
}

/** i18n key for each action's button label. */
export const ACCOUNT_ROW_ACTION_LABEL_KEY = {
  disconnect: "socialPanel.account.disconnect",
  reconnect: "socialPanel.account.reconnect",
  remove: "socialPanel.account.remove",
} as const;

/** The subset of a connection this derivation is allowed to look at. */
export type AccountStateSource = Pick<SocialConnection, "connectionStatus" | "scopes">;

/**
 * ONE account row's customer-visible state.
 *
 * The per-platform `platformAccountState` in the panel answers a different
 * question ("what does this card say when it has to speak for the whole
 * platform"). A row speaks only for itself, so it reads only its own fields —
 * which is the entire point of per-account rows: a second account in
 * `needs_reconnect` must not be hidden behind a healthy first one.
 */
export function accountRowState(
  account: AccountStateSource,
  provider: SocialProvider,
): AccountUiState {
  return accountUiState({
    connectionStatus: account.connectionStatus,
    scopes: account.scopes,
    // Scope completeness is only knowable (and only required) for Pinterest today.
    enforcePinterestScopes: provider === "pinterest",
  });
}
