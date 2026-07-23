/**
 * Facebook (Meta Graph) API client (server-only). The ONLY place that issues raw
 * Facebook HTTP calls for the OAuth flow — route handlers never fetch Facebook
 * directly.
 *
 * Responsibilities:
 *   - OAuth code exchange (short-lived token) then short→long-lived exchange.
 *   - Fetching the connected user's profile (id + name) for display.
 *
 * KEY DIFFERENCES vs Pinterest:
 *   - Facebook's token endpoint takes client_id/client_secret/redirect_uri/code as
 *     QUERY params, NOT HTTP Basic auth.
 *   - Facebook issues a SHORT-lived token from the code; it must then be swapped
 *     for a ~60-day LONG-lived token via grant_type=fb_exchange_token. We persist
 *     the long-lived one.
 *
 * Errors never include credentials. Tokens are never logged.
 */

import { FACEBOOK_TOKEN_URL, FACEBOOK_GRAPH_URL, getFacebookEnv } from "./config";

export class FacebookApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = "facebook_error") {
    super(message);
    this.name = "FacebookApiError";
    this.status = status;
    this.code = code;
  }
}

export type FacebookTokenSet = {
  accessToken: string;
  /** Facebook's long-lived user token is not a refresh token — kept null. */
  refreshToken: string | null;
  /** ISO timestamp for when the long-lived token expires (now + expires_in), or null. */
  accessTokenExpiresAt: string | null;
  scopes: string[];
};

export type FacebookProfile = {
  id: string;
  name: string | null;
};

type RawTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string; type?: string; code?: number } | string;
};

function expiryFromNow(seconds: number | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function extractError(json: RawTokenResponse | Record<string, unknown>): string | null {
  const err = (json as RawTokenResponse).error;
  if (!err) return null;
  if (typeof err === "string") return err;
  if (typeof err === "object" && typeof err.message === "string") return err.message;
  return "Facebook returned an error";
}

/**
 * GET the Facebook token endpoint with the given query params. Facebook accepts
 * the code/secret exchange on GET with query params. Returns parsed JSON; throws a
 * safe FacebookApiError on non-2xx (never echoing the query, which holds secrets).
 */
async function getToken(params: URLSearchParams): Promise<RawTokenResponse> {
  const res = await fetch(`${FACEBOOK_TOKEN_URL}?${params.toString()}`, { method: "GET" });
  const json = (await res.json().catch(() => ({}))) as RawTokenResponse;
  if (!res.ok || !json.access_token) {
    // Surface a safe message; never echo the request URL/params (contains secret + code).
    throw new FacebookApiError(
      extractError(json) || `Facebook token request failed (${res.status})`,
      res.ok ? 400 : res.status,
      "token_exchange_failed",
    );
  }
  return json;
}

/**
 * Exchange an authorization code for a LONG-lived Facebook token (two steps):
 *   1. code → short-lived token (client_id/client_secret/redirect_uri/code query params).
 *   2. short-lived → long-lived (~60 days) via grant_type=fb_exchange_token.
 * The long-lived token is what we persist; expiry = now + its expires_in.
 */
export async function exchangeCodeForTokens(code: string): Promise<FacebookTokenSet> {
  const env = getFacebookEnv();

  // Step 1: code → short-lived token.
  const shortRaw = await getToken(
    new URLSearchParams({
      client_id: env.appId,
      client_secret: env.appSecret,
      redirect_uri: env.redirectUri,
      code,
    }),
  );
  const shortToken = shortRaw.access_token as string;

  // Step 2: short-lived → long-lived (~60 days) token.
  const longRaw = await getToken(
    new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: env.appId,
      client_secret: env.appSecret,
      fb_exchange_token: shortToken,
    }),
  );

  return {
    accessToken: longRaw.access_token as string,
    refreshToken: null,
    accessTokenExpiresAt: expiryFromNow(longRaw.expires_in),
    // Scopes are confirmed via /me/permissions if needed later; at connect time we
    // record the requested scope set from config (see connectionStore caller).
    scopes: [],
  };
}

/**
 * Fetch the connected user's basic profile (id + name) with a user access token.
 * Used to populate provider_account_id / provider_account_name.
 */
export async function fetchFacebookProfile(accessToken: string): Promise<FacebookProfile> {
  const params = new URLSearchParams({ fields: "id,name", access_token: accessToken });
  const res = await fetch(`${FACEBOOK_GRAPH_URL}/me?${params.toString()}`, { method: "GET" });
  const json = (await res.json().catch(() => ({}))) as { id?: string; name?: string } & Record<string, unknown>;
  if (!res.ok || typeof json.id !== "string" || !json.id) {
    throw new FacebookApiError(
      extractError(json) || `Facebook profile request failed (${res.status})`,
      res.ok ? 502 : res.status,
      "profile_fetch_failed",
    );
  }
  return { id: json.id, name: typeof json.name === "string" ? json.name : null };
}
