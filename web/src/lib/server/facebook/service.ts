/**
 * Facebook (Meta Graph) API client (server-only). The ONLY place that issues raw
 * Facebook HTTP calls for the OAuth flow — route handlers never fetch Facebook
 * directly.
 *
 * Responsibilities:
 *   - OAuth code exchange (short-lived token) then short→long-lived exchange.
 *   - Fetching the connected user's profile (id + name) for display.
 *   - Reading the ACTUAL granted permissions (/me/permissions) to gate the
 *     connection on the Page-publishing business scopes.
 *   - Discovering the Facebook Pages the user manages (/me/accounts), returning
 *     each Page's page-scoped access token and management tasks. Instagram is
 *     fully decoupled — this module never touches instagram_business_account.
 *
 * KEY DIFFERENCES vs Pinterest:
 *   - Facebook's token endpoint takes client_id/client_secret/redirect_uri/code as
 *     QUERY params, NOT HTTP Basic auth.
 *   - Facebook issues a SHORT-lived token from the code; it must then be swapped
 *     for a ~60-day LONG-lived token via grant_type=fb_exchange_token. We persist
 *     the long-lived one.
 *
 * Errors never include credentials. Tokens are never logged. Every Graph call in
 * this module puts the access token in the query string, so error handling here
 * NEVER echoes the request URL — only the HTTP status / Meta message.
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

/**
 * Alias for fetchFacebookProfile — the connect flow refers to the connecting
 * person as the "Facebook user" (distinct from the Facebook Page it will publish
 * through). Same call (GET /me?fields=id,name), one canonical implementation.
 */
export async function fetchFacebookUser(userToken: string): Promise<FacebookProfile> {
  return fetchFacebookProfile(userToken);
}

/**
 * Read the permissions the user ACTUALLY granted, via GET /me/permissions.
 * Returns only the names of permissions whose status is "granted" (declined /
 * unknown are dropped). Used by the callback to gate the connection on the four
 * REQUIRED business scopes — Facebook's authorize response can succeed even when
 * the user unchecked some permissions, so we must verify the real grant.
 *
 * Never throws on an empty/partial permission list — returns [] so the caller can
 * decide (missing required scopes → reconnect_required). Only throws on a genuine
 * API failure (non-2xx). The token is in the query string; errors never echo it.
 */
export async function fetchGrantedPermissions(userToken: string): Promise<string[]> {
  const params = new URLSearchParams({ access_token: userToken });
  const res = await fetch(`${FACEBOOK_GRAPH_URL}/me/permissions?${params.toString()}`, { method: "GET" });
  const json = (await res.json().catch(() => ({}))) as {
    data?: Array<{ permission?: string; status?: string }>;
  } & Record<string, unknown>;

  if (!res.ok) {
    throw new FacebookApiError(
      extractError(json) || `Facebook permissions request failed (${res.status})`,
      res.status,
      "permissions_fetch_failed",
    );
  }

  const rows = Array.isArray(json.data) ? json.data : [];
  return rows
    .filter(r => r && typeof r.permission === "string" && r.status === "granted")
    .map(r => r.permission as string);
}

/** A Facebook Page the connecting user manages — a potential publishing target. */
export type ManagedPage = {
  pageId: string;
  pageName: string | null;
  /**
   * PAGE-scoped access token. Publishing a post to this Page must use this token,
   * NOT the user token. Plaintext here; the caller encrypts it before it ever
   * touches the DB and it is never logged.
   */
  pageAccessToken: string;
  /** The user's management roles on this Page (e.g. CREATE_CONTENT, MANAGE). */
  tasks: string[];
};

/**
 * True when the user's Page tasks include a role that permits publishing content.
 * "CREATE_CONTENT" is the direct content-publishing task; "MANAGE" (full admin)
 * implies it. Any other combination is treated as read-only for our purposes.
 */
export function canPublishToPage(tasks: readonly string[]): boolean {
  return tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE");
}

type RawPageRow = {
  id?: string;
  name?: string;
  access_token?: string;
  tasks?: string[];
};

type RawAccountsPage = {
  data?: RawPageRow[];
  paging?: { next?: string };
} & Record<string, unknown>;

/**
 * Discover the Facebook Pages the connecting user manages via:
 *   GET /me/accounts?fields=id,name,tasks,access_token
 *
 * Instagram is intentionally NOT requested — this flow targets Facebook Pages
 * only. Every Page with a real id + page-scoped token is returned (its tasks tell
 * the caller whether the user can publish). An empty `data` array (no managed
 * Pages) yields [] (never throws) so the callback can show an accurate "no Pages"
 * diagnostic instead of a hard error.
 *
 * Pagination: Graph returns Pages in batches with a `paging.next` cursor. We
 * follow it up to a small defensive cap (3 pages of results) so an account with
 * many Pages is enumerated without an unbounded fetch loop. The user token is in
 * the query string; errors never echo the URL.
 *
 * Every returned id/name comes from Graph — never from the client.
 */
export async function fetchManagedPages(userToken: string): Promise<ManagedPage[]> {
  const MAX_PAGES_OF_RESULTS = 3;
  const discovered: ManagedPage[] = [];

  // First request is built server-side; subsequent requests follow paging.next
  // (a full Graph URL that already carries the token + cursor).
  const initialParams = new URLSearchParams({
    fields: "id,name,tasks,access_token",
    access_token: userToken,
  });
  let nextUrl: string | null = `${FACEBOOK_GRAPH_URL}/me/accounts?${initialParams.toString()}`;

  for (let fetched = 0; nextUrl && fetched < MAX_PAGES_OF_RESULTS; fetched += 1) {
    const res = await fetch(nextUrl, { method: "GET" });
    const json = (await res.json().catch(() => ({}))) as RawAccountsPage;

    if (!res.ok) {
      throw new FacebookApiError(
        extractError(json) || `Facebook accounts request failed (${res.status})`,
        res.status,
        "accounts_fetch_failed",
      );
    }

    const rows = Array.isArray(json.data) ? json.data : [];
    for (const page of rows) {
      // Require a real Page id and a page-scoped token (needed to publish). Skip
      // anything missing rather than surfacing a dead option.
      if (
        !page ||
        typeof page.id !== "string" || !page.id ||
        typeof page.access_token !== "string" || !page.access_token
      ) {
        continue;
      }
      discovered.push({
        pageId: page.id,
        pageName: typeof page.name === "string" ? page.name : null,
        pageAccessToken: page.access_token,
        tasks: Array.isArray(page.tasks) ? page.tasks.filter((t): t is string => typeof t === "string") : [],
      });
    }

    const next = json.paging?.next;
    nextUrl = typeof next === "string" && next ? next : null;
  }

  return discovered;
}
