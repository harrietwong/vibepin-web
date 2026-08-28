export const socialPanelMessages = {
  // ── Customer-visible account states (PRD §5) — the only four a customer sees.
  //    Rendered from lib/social/accountUiState.ts; never combined with each other.
  "socialPanel.accountState.connected": "Connected",
  "socialPanel.accountState.connectedDesc": "This account is connected and ready to publish.",
  "socialPanel.accountState.needsAttention": "Needs attention",
  "socialPanel.accountState.needsAttentionDesc": "There's an issue with this account that may affect publishing.",
  "socialPanel.accountState.needsReconnect": "Needs reconnect",
  "socialPanel.accountState.needsReconnectDesc": "Reconnect this account to continue publishing. Your drafts and scheduled content will stay safe.",
  "socialPanel.accountState.disconnected": "Disconnected",
  "socialPanel.accountState.disconnectedDesc": "This account is not currently connected.",

  // ── Status chip labels ──
  "socialPanel.status.reconnectNeeded": "Reconnect needed",
  "socialPanel.status.disconnected": "Disconnected",
  "socialPanel.status.connectionError": "Connection error",
  "socialPanel.status.setupPending": "Setup pending",

  // ── Card subtitle ──
  "socialPanel.card.accountConnected": "Account connected",
  "socialPanel.card.accountMasked": "Pinterest account ••••{last4}",
  //    Same fallback, for the account rows that now render on EVERY platform —
  //    the Pinterest-worded one above would mislabel an Instagram row.
  "socialPanel.card.accountMaskedAnyPlatform": "{platform} account ••••{last4}",
  "socialPanel.card.accountUnidentified": "Account connected",
  "socialPanel.card.eachAccountBelow": "Each account's status is shown below",
  "publishResults.title": "Publish results",
  "publishResults.published": "Published",
  "publishResults.viewOnPrefix": "View on ",
  // A destination that did NOT publish states so in its own words. Rendering every
  // row as "Published" told merchants a post existed that never did.
  "publishResults.failed": "Failed",
  "publishResults.publishing": "Publishing…",
  "publishResults.pending": "Not published yet",
  "publishResults.retryHint": "Retry publishing to send this destination again.",
  "socialPanel.card.connectToPublish": "Connect to publish approved content here.",
  "socialPanel.card.setupPendingComingSoon": "Connection setup pending — coming soon.",
  "socialPanel.card.accountsCountSuffix": " accounts",

  // ── Card actions ──
  "socialPanel.action.addAnotherAccountPrefix": "Add another ",
  "socialPanel.action.addAnotherAccountSuffix": " account",
  "socialPanel.action.redirectingToPrefix": "Redirecting to ",
  "socialPanel.action.redirectingToSuffix": "...",
  "socialPanel.action.reconnectPrefix": "Reconnect ",
  "socialPanel.action.connect": "Connect",
  "socialPanel.action.disconnectPrefix": "Disconnect ",

  // ── Panel header ──
  "socialPanel.title": "Social accounts",
  "socialPanel.description": "Connect the channels you want to repurpose approved product posts across. You publish only after reviewing and approving the content — nothing posts automatically.",

  // ── Load error ──
  "socialPanel.loadError": "Couldn't refresh your connection status. Showing platforms as not connected.",

  // ── Loading state ──
  "socialPanel.loading": "Loading social accounts…",

  // ── Reconnect landed on a different Pinterest account (PRD §10) ──
  //    Split into prefix/middle/suffix so the two @usernames can be interpolated
  //    without HTML in the catalog; translators keep the sentence natural in their
  //    own word order by moving the punctuation between the parts.
  "socialPanel.mismatch.title": "That's a different {platform} account",
  "socialPanel.mismatch.bodyPrefix": "You signed in as ",
  "socialPanel.mismatch.bodyMiddle": ", but you were reconnecting ",
  "socialPanel.mismatch.bodySuffix":
    ". Nothing was changed — your existing connection is untouched. Choose what you'd like to do.",
  "socialPanel.mismatch.signInPrefix": "Sign in to ",
  "socialPanel.mismatch.addPrefix": "Add ",
  "socialPanel.mismatch.addSuffix": " as a new account",
  "socialPanel.mismatch.dismiss": "Not now",
  "socialPanel.mismatch.theOriginalAccount": "the original account",
  "socialPanel.mismatch.aDifferentAccount": "a different account",

  // ── Plan account limit reached (PRD §9.2 / §18) ──
  //    Shown as a persistent banner, not a toast: the user has a real decision
  //    (upgrade, or remove an account they no longer use), and nothing was written.
  "socialPanel.limit.title": "You've reached your social account limit",
  "socialPanel.limit.body":
    "Your current plan doesn't include another connected Pinterest account. Upgrade for more, or remove an account you no longer publish to. Nothing was changed — your existing accounts are untouched.",
  "socialPanel.limit.upgrade": "Upgrade",
  "socialPanel.limit.dismiss": "Not now",
  //    Paid plans get a second, cheaper option than upgrading: buy one extra
  //    account slot, usable on any platform. Composed as
  //    "<addSlot> · $<price><perMonth>" so the number stays in pricingPlans.ts.
  "socialPanel.limit.bodyPaid":
    "Every account your plan includes is already connected. Add an extra account slot to connect one more on any platform, or remove an account you no longer publish to. Nothing was changed — your existing accounts are untouched.",
  "socialPanel.limit.addSlot": "Add another account",
  "socialPanel.limit.perMonth": "/month",
  "socialPanel.limit.addSlotBusy": "Opening checkout…",
  "socialPanel.limit.addSlotFailed": "Could not open checkout. Please try again.",
  "socialPanel.limit.addSlotUnavailable": "Extra accounts are not available for purchase yet.",
  //    The add-on is billed on the SAME interval as the buyer's plan (决策 A), so the
  //    button must name the price they will actually be charged. Two variants, not one
  //    string plus a suffix: "$5 / month · billed yearly" reads as a single promise,
  //    and a yearly subscriber shown "$7 / month" would simply be told the wrong price.
  "socialPanel.limit.addSlotMonthly": "Add another account · ${price} / month",
  "socialPanel.limit.addSlotYearly": "Add another account · ${price} / month · billed yearly",

  // ── Extra account slot purchased (决策 B) ──
  //    Shown on return from Creem checkout (?addon=success). The slot is provisioned
  //    by a webhook that can land seconds AFTER this redirect, so the copy promises
  //    activation rather than claiming it already happened — and the panel re-reads
  //    the allowance once more a few seconds later.
  "socialPanel.addon.successTitle": "Thanks — your extra account slot is being activated",
  "socialPanel.addon.successBody":
    "You can add another account as soon as it appears here.",
  "socialPanel.addon.dismiss": "Got it",

  // ── Per-account rows + their actions (PRD 0809 §II / PRD 0805 §4-§11) ──
  //    Derived from lib/social/accountActions.ts, one action set per row state.
  "socialPanel.account.disconnect": "Disconnect",
  "socialPanel.account.reconnect": "Reconnect",
  "socialPanel.account.remove": "Remove",
  //    Composed as: "<account><bodyPrefix><count><bodySuffix>".
  "socialPanel.removeDialog.title": "This account still has scheduled Pins",
  "socialPanel.removeDialog.bodyPrefix": " has ",
  "socialPanel.removeDialog.bodySuffix":
    " Pin(s) scheduled to publish through it. Keep them scheduled (they'll stop until you connect the account again), or cancel those schedules now.",
  "socialPanel.removeDialog.keep": "Keep them scheduled",
  "socialPanel.removeDialog.cancelSchedules": "Cancel those schedules",
  "socialPanel.removeDialog.dismiss": "Don't remove",

  // ── Toasts ──
  "socialPanel.toast.accountRemoved": "Account removed",
  "socialPanel.toast.accountRemoveFailed": "Could not remove that account. Please try again.",
  "socialPanel.toast.scheduleCheckFailed":
    "We couldn't check what's still scheduled through this account, so it wasn't removed. Please try again.",
  "socialPanel.toast.accountDisconnected": "Account disconnected",
  "socialPanel.toast.accountDisconnectFailed": "Could not disconnect that account. Please try again.",
  "socialPanel.toast.pinterestDisconnected": "Pinterest disconnected",
  "socialPanel.toast.pinterestDisconnectFailed": "Could not disconnect Pinterest. Please try again.",
  "socialPanel.toast.connectionComingSoonSuffix": " connection is coming soon.",
  "socialPanel.toast.couldNotStartConnection": "Could not start connection",
  "socialPanel.toast.disconnectedSuffix": " disconnected",
  "socialPanel.toast.couldNotDisconnect": "Could not disconnect",
} as const;
