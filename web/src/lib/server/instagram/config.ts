/**
 * Centralized Instagram OAuth configuration (server-only).
 *
 * This is the "Instagram API with Instagram Login" (Business Login for Instagram)
 * flow — FULLY DECOUPLED from Facebook Login. It authenticates directly against
 * Instagram's own domains (www.instagram.com / api.instagram.com /
 * graph.instagram.com), NOT graph.facebook.com, and needs neither a Facebook Page
 * nor a linked Facebook account.
 *
 * Reads credentials from the Next.js server environment (web/.env.local):
 *   INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_REDIRECT_URI,
 *   INSTAGRAM_TOKEN_ENC_KEY
 *
 * KEY DIFFERENCES vs the Facebook config:
 *   - Authorize host is www.instagram.com/oauth/authorize (not
 *     www.facebook.com/<ver>/dialog/oauth).
 *   - The token endpoint is api.instagram.com/oauth/access_token and takes the
 *     exchange as form-urlencoded POST BODY (not GET query params).
 *   - Permissions are ALWAYS a `scope` param — Instagram Login has no `config_id`
 *     concept. There is no Login-for-Business Configuration to select.
 *   - Short-lived → long-lived exchange uses grant_type=ig_exchange_token against
 *     graph.instagram.com (not fb_exchange_token against graph.facebook.com).
 *
 * This module never exposes secrets — the values live only in env and in the
 * built authorize/token URLs constructed server-side.
 */

import { ConfigurationError } from "@/lib/server/pinterest/errors";

// Graph API version for the graph.instagram.com profile/exchange calls.
export const INSTAGRAM_API_VERSION = "v25.0";

// Instagram-native OAuth endpoints. NOTE the distinct hosts vs Facebook.
export const INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
export const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
export const INSTAGRAM_GRAPH_URL = `https://graph.instagram.com/${INSTAGRAM_API_VERSION}`;
// The long-lived-token exchange lives at the graph root (unversioned).
export const INSTAGRAM_GRAPH_ROOT_URL = "https://graph.instagram.com";

/**
 * Requested scopes for the Instagram publishing flow.
 *
 *   instagram_business_basic            — read the connected IG account's basic
 *                                         profile (user_id, username, account_type)
 *   instagram_business_content_publish  — publish posts to the connected IG account
 *
 * We deliberately do NOT request instagram_business_manage_insights,
 * instagram_business_manage_comments, or instagram_business_manage_messages — none
 * of those product features exist yet, and requesting them only bloats App Review
 * and the consent screen. We NEVER request any Facebook pages_* / ads_* /
 * business_management scopes here — this flow never touches a Facebook Page.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
] as const;

/** Comma-joined scope string for the authorize request. */
export function instagramScopeString(): string {
  return INSTAGRAM_SCOPES.join(",");
}

export type InstagramEnv = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

/**
 * Resolve OAuth credentials. Throws a clear ConfigurationError if any of the
 * required three are missing so routes can return a safe error (never echoing
 * secret values). There is NO optional config_id — Instagram Login is always the
 * scope-based flow.
 *
 * Note: INSTAGRAM_TOKEN_ENC_KEY is validated separately by the crypto layer
 * (createTokenCipher) — it is not part of the OAuth-credential triple here.
 */
export function getInstagramEnv(): InstagramEnv {
  const appId = process.env.INSTAGRAM_APP_ID?.trim() ?? "";
  const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim() ?? "";
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI?.trim() ?? "";

  const missing: string[] = [];
  if (!appId) missing.push("INSTAGRAM_APP_ID");
  if (!appSecret) missing.push("INSTAGRAM_APP_SECRET");
  if (!redirectUri) missing.push("INSTAGRAM_REDIRECT_URI");
  if (missing.length) {
    throw new ConfigurationError(`Missing Instagram env: ${missing.join(", ")}`);
  }

  return { appId, appSecret, redirectUri };
}

/** True when all OAuth env vars are present (for safe diagnostics). */
export function isInstagramConfigured(): boolean {
  try {
    getInstagramEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the Instagram authorization URL for a given opaque state token.
 *
 * Instagram Login is ALWAYS scope-based (no config_id). The authorize dialog is
 * hosted on www.instagram.com and carries client_id / redirect_uri /
 * response_type=code / scope / state.
 *
 * `state` is opaque random and never contains a user id.
 */
export function buildAuthorizeUrl(env: InstagramEnv, state: string): string {
  const params = new URLSearchParams({
    client_id: env.appId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    scope: instagramScopeString(),
    state,
  });
  return `${INSTAGRAM_AUTHORIZE_URL}?${params.toString()}`;
}
