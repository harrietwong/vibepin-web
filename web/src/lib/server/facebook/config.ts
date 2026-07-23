/**
 * Centralized Facebook (Meta Graph) OAuth configuration (server-only).
 *
 * Reads credentials from the Next.js server environment (web/.env.local):
 *   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_REDIRECT_URI, FACEBOOK_TOKEN_ENC_KEY
 *
 * Modeled on the Pinterest config, but Facebook has key differences:
 *   - The token endpoint takes client_id/client_secret/redirect_uri/code as QUERY
 *     params (not HTTP Basic auth).
 *   - A short-lived token must be exchanged for a 60-day long-lived token.
 *
 * This module never exposes secrets — the values live only in env and in the
 * built authorize/token URLs constructed server-side.
 */

import { ConfigurationError } from "@/lib/server/pinterest/errors";

// Graph API version. Kept as a single constant so every URL stays in lockstep.
export const FACEBOOK_API_VERSION = "v21.0";
export const FACEBOOK_AUTHORIZE_URL = `https://www.facebook.com/${FACEBOOK_API_VERSION}/dialog/oauth`;
export const FACEBOOK_TOKEN_URL = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/oauth/access_token`;
export const FACEBOOK_GRAPH_URL = `https://graph.facebook.com/${FACEBOOK_API_VERSION}`;

/**
 * Requested scopes. Minimum viable: `public_profile` only — it needs no Meta App
 * Review and is granted to every app by default, so the connect flow works the
 * moment credentials are set.
 *
 * FUTURE: publishing to a Facebook Page requires additional scopes that go
 * through Meta App Review, e.g.:
 *   "pages_show_list", "pages_manage_posts", "pages_read_engagement",
 *   "business_management"
 * Add them here (and re-submit for review) when Page publishing is wired.
 */
export const FACEBOOK_SCOPES = ["public_profile"] as const;

/** Comma-joined scope string for the authorize request. */
export function facebookScopeString(): string {
  return FACEBOOK_SCOPES.join(",");
}

export type FacebookEnv = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

/**
 * Resolve OAuth credentials. Throws a clear ConfigurationError if any are missing
 * so routes can return a safe error (never echoing secret values).
 *
 * Note: FACEBOOK_TOKEN_ENC_KEY is validated separately by the crypto layer
 * (createTokenCipher) — it is not part of the OAuth-credential triple here.
 */
export function getFacebookEnv(): FacebookEnv {
  const appId = process.env.FACEBOOK_APP_ID?.trim() ?? "";
  const appSecret = process.env.FACEBOOK_APP_SECRET?.trim() ?? "";
  const redirectUri = process.env.FACEBOOK_REDIRECT_URI?.trim() ?? "";

  const missing: string[] = [];
  if (!appId) missing.push("FACEBOOK_APP_ID");
  if (!appSecret) missing.push("FACEBOOK_APP_SECRET");
  if (!redirectUri) missing.push("FACEBOOK_REDIRECT_URI");
  if (missing.length) {
    throw new ConfigurationError(`Missing Facebook env: ${missing.join(", ")}`);
  }

  return { appId, appSecret, redirectUri };
}

/** True when all OAuth env vars are present (for safe diagnostics). */
export function isFacebookConfigured(): boolean {
  try {
    getFacebookEnv();
    return true;
  } catch {
    return false;
  }
}

/** Build the Facebook authorization URL for a given opaque state token. */
export function buildAuthorizeUrl(env: FacebookEnv, state: string): string {
  const params = new URLSearchParams({
    client_id: env.appId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    scope: facebookScopeString(),
    state,
  });
  return `${FACEBOOK_AUTHORIZE_URL}?${params.toString()}`;
}
