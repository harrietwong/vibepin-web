/**
 * Centralized Facebook (Meta Graph) OAuth configuration (server-only).
 *
 * Reads credentials from the Next.js server environment (web/.env.local):
 *   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_REDIRECT_URI, FACEBOOK_TOKEN_ENC_KEY
 *   FACEBOOK_LOGIN_CONFIG_ID (optional — Facebook Login for Business config)
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
// Bumped to v25.0 for Facebook Login for Business + Instagram content publishing.
export const FACEBOOK_API_VERSION = "v25.0";
export const FACEBOOK_AUTHORIZE_URL = `https://www.facebook.com/${FACEBOOK_API_VERSION}/dialog/oauth`;
export const FACEBOOK_TOKEN_URL = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/oauth/access_token`;
export const FACEBOOK_GRAPH_URL = `https://graph.facebook.com/${FACEBOOK_API_VERSION}`;

/**
 * Requested scopes for the Instagram Business publishing flow.
 *
 *   pages_show_list           — enumerate the user's Facebook Pages (/me/accounts)
 *   pages_read_engagement     — read Page details incl. the linked IG account
 *   instagram_basic           — read the IG Business account (id/username)
 *   instagram_content_publish — publish media to the IG Business account (Phase 2)
 *
 * `public_profile` is kept so we can still fetch the connecting user's id/name
 * for display; it needs no App Review and is granted by default.
 *
 * NOTE: the four business scopes go through Meta App Review. When VibePin uses
 * Facebook Login for Business, these are NOT sent as a `scope` param — the
 * granted permission set is decided by the Login Configuration (config_id) in the
 * Meta dashboard. See buildAuthorizeUrl below. The scope list here is the
 * fallback for the classic (config-less) Facebook Login flow.
 */
export const FACEBOOK_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
] as const;

/**
 * The permissions that MUST be granted for the connection to be usable. If the
 * user unchecks any of these on the Facebook consent screen we cannot discover /
 * publish to their Instagram Business account, so the connection is marked
 * "reconnect required" rather than active. `public_profile` is intentionally NOT
 * in this list — it is display-only and always granted.
 */
export const REQUIRED_FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
] as const;

/** Comma-joined scope string for the (fallback) classic authorize request. */
export function facebookScopeString(): string {
  return FACEBOOK_SCOPES.join(",");
}

/**
 * Given the set of scopes Facebook actually granted (from /me/permissions),
 * return which REQUIRED scopes are still missing. Empty array = all present.
 */
export function missingRequiredScopes(granted: readonly string[]): string[] {
  const grantedSet = new Set(granted);
  return REQUIRED_FACEBOOK_SCOPES.filter(s => !grantedSet.has(s));
}

export type FacebookEnv = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  /**
   * Facebook Login for Business configuration id. When present, the authorize
   * URL uses `config_id` and the granted permissions are governed by that
   * Configuration in the Meta dashboard (NOT by a `scope` param). Optional —
   * absence falls back to the classic scope-based Facebook Login flow.
   */
  loginConfigId?: string;
};

/**
 * Resolve OAuth credentials. Throws a clear ConfigurationError if any of the
 * required three are missing so routes can return a safe error (never echoing
 * secret values). FACEBOOK_LOGIN_CONFIG_ID is OPTIONAL — its absence must not
 * throw; it simply selects the classic scope-based flow.
 *
 * Note: FACEBOOK_TOKEN_ENC_KEY is validated separately by the crypto layer
 * (createTokenCipher) — it is not part of the OAuth-credential triple here.
 */
export function getFacebookEnv(): FacebookEnv {
  const appId = process.env.FACEBOOK_APP_ID?.trim() ?? "";
  const appSecret = process.env.FACEBOOK_APP_SECRET?.trim() ?? "";
  const redirectUri = process.env.FACEBOOK_REDIRECT_URI?.trim() ?? "";
  const loginConfigId = process.env.FACEBOOK_LOGIN_CONFIG_ID?.trim() || undefined;

  const missing: string[] = [];
  if (!appId) missing.push("FACEBOOK_APP_ID");
  if (!appSecret) missing.push("FACEBOOK_APP_SECRET");
  if (!redirectUri) missing.push("FACEBOOK_REDIRECT_URI");
  if (missing.length) {
    throw new ConfigurationError(`Missing Facebook env: ${missing.join(", ")}`);
  }

  return { appId, appSecret, redirectUri, loginConfigId };
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

/**
 * Build the Facebook authorization URL for a given opaque state token.
 *
 * Two mutually exclusive paths, chosen by whether FACEBOOK_LOGIN_CONFIG_ID is set:
 *
 *   1. Facebook Login for Business (PREFERRED — when env.loginConfigId is set):
 *      the URL carries `config_id` and does NOT carry a `scope` param. With Login
 *      for Business the permission set is defined by the Login Configuration in
 *      the Meta dashboard, so sending `scope` is wrong (Meta ignores/rejects it).
 *      The Configuration is what pins the business permissions
 *      (pages_show_list / pages_read_engagement / instagram_basic /
 *      instagram_content_publish) that IG publishing needs.
 *
 *   2. Classic Facebook Login (FALLBACK — when no config_id is configured):
 *      the URL carries the comma-joined `scope` list (the four business scopes +
 *      public_profile). This keeps the connect flow working before a Login
 *      Configuration exists, but the business scopes still require App Review.
 *
 * `state`, `redirect_uri`, and `response_type=code` are always present.
 */
export function buildAuthorizeUrl(env: FacebookEnv, state: string): string {
  const params = new URLSearchParams({
    client_id: env.appId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    state,
  });

  if (env.loginConfigId) {
    // Login for Business: permissions come from the Configuration, not `scope`.
    params.set("config_id", env.loginConfigId);
  } else {
    // Classic Facebook Login fallback: request the scopes explicitly.
    params.set("scope", facebookScopeString());
  }

  return `${FACEBOOK_AUTHORIZE_URL}?${params.toString()}`;
}
