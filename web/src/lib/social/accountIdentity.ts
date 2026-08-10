/**
 * How an account is named in the UI (PRD 0809 §2).
 *
 * Priority: provider display name → @username → a masked, honest fallback.
 *
 * Two rules this exists to enforce:
 *
 *  1. Never fabricate. If the provider gave us no identity, the UI says so in a form the
 *     merchant can still tell apart ("Pinterest account ••••6972") rather than inventing
 *     a name or printing a bare "Account connected" for every row — which is unusable the
 *     moment a merchant connects a second account.
 *
 *  2. Never lead with a raw numeric id. The mask shows the last four characters only, so
 *     two accounts remain distinguishable without putting an opaque 18-digit id in front
 *     of someone. Note the username is NOT always human-readable either — a live account
 *     here has username "5522278466b6972" — which is exactly why the provider's display
 *     name (Pinterest `business_name`) is preferred over it.
 */

/** Last 4 characters of an id, for the masked fallback. */
export function maskAccountId(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  if (!s) return "";
  return s.length <= 4 ? s : s.slice(-4);
}

export type AccountIdentityInput = {
  /** Provider display name (Pinterest business_name, Facebook Page name, …). */
  displayName?: string | null;
  username?: string | null;
  accountId?: string | null;
};

/**
 * The label to show for one account row.
 *
 * `platformLabel` is the already-localised platform word and `maskedTemplate` the
 * already-localised "{platform} account ••••{last4}" string, so this stays free of i18n
 * imports and is testable as a pure function.
 */
export function accountDisplayLabel(
  account: AccountIdentityInput,
  opts: { maskedTemplate: (last4: string) => string; unidentifiedLabel: string },
): string {
  const display = (account.displayName ?? "").trim();
  if (display) return display;

  const username = (account.username ?? "").trim();
  if (username) return username.startsWith("@") ? username : `@${username}`;

  const last4 = maskAccountId(account.accountId);
  if (last4) return opts.maskedTemplate(last4);

  // Nothing at all — not even an id. Honest, and still not a fabricated name.
  return opts.unidentifiedLabel;
}

/** True when we hold a real, provider-supplied identity (not a mask/placeholder). */
export function hasRealIdentity(account: AccountIdentityInput): boolean {
  return Boolean((account.displayName ?? "").trim() || (account.username ?? "").trim());
}
