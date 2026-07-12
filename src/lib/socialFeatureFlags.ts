/**
 * Client-safe social / Pinterest feature flags.
 *
 * These are read inside "use client" components, so any backing env var MUST be
 * NEXT_PUBLIC_* — non-public env vars do not exist in the browser bundle and would
 * silently read as undefined (i.e. "off"). Each flag takes its raw value as a
 * defaulted argument so it can be unit-tested without touching the environment.
 */

/**
 * Multi-account entry ("Add another Pinterest account" / "Add another account").
 * OFF by default. Turn on with NEXT_PUBLIC_ENABLE_MULTI_SOCIAL_ACCOUNTS=true.
 *
 * The product spec names this flag ENABLE_MULTI_SOCIAL_ACCOUNTS; the NEXT_PUBLIC_
 * prefix is required for it to be visible in these client components.
 */
export function isMultiSocialAccountsEnabled(
  raw: string | undefined = process.env.NEXT_PUBLIC_ENABLE_MULTI_SOCIAL_ACCOUNTS,
): boolean {
  return raw === "true";
}

/**
 * Developer / debug surfaces for the Pinterest connection (board defaults, manual
 * board sync, advanced setup, publishing-access detail). Hidden from normal users;
 * shown only outside production so the connection UI stays "Connect / Disconnect"
 * simple for everyone else.
 */
export function isSocialDevToolsEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return nodeEnv !== "production";
}
