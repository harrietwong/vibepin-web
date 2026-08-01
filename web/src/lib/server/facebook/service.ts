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

import { createHash } from "node:crypto";
import { FACEBOOK_TOKEN_URL, FACEBOOK_GRAPH_URL, getFacebookEnv } from "./config";

/**
 * ── Diagnostics (development only) ──────────────────────────────────────────
 *
 * Meta's Graph API can return an EMPTY /me/accounts with NO error even when the
 * user demonstrably administers a Page (Business-Portfolio-owned Pages that were
 * not selected in the Login-for-Business asset picker behave this way). Without
 * per-request visibility that failure is indistinguishable from "user has no
 * Page", so these logs exist purely to tell those two apart during development.
 *
 * HARD RULES (never relax):
 *   - NEVER log an access token — not the user token, not a Page token. Tokens
 *     are only ever summarized through tokenFingerprint() (length + sha256 head),
 *     which is one-way and useless to an attacker but still lets us confirm that
 *     three consecutive Graph calls used the SAME token.
 *   - NEVER log a request URL. Every Graph call in this module carries the token
 *     in the query string, so a URL is a credential.
 *   - NEVER JSON.stringify a raw Graph object (a Page row contains access_token).
 *     Always hand-pick the fields to print.
 *   - Silent in production (NODE_ENV === "production") — zero output on Vercel.
 */
const FB_DEBUG_ENABLED = process.env.NODE_ENV !== "production";

function fbDebug(...parts: unknown[]): void {
  if (!FB_DEBUG_ENABLED) return;
  console.log("[facebook-oauth-debug]", ...parts);
}

/**
 * One-way summary of a token: its length plus the first 8 hex chars of its
 * SHA-256. Enough to prove two calls used the same token; not enough to
 * reconstruct any part of it. NEVER print the token itself.
 */
export function tokenFingerprint(token: string | null | undefined): string {
  if (!token) return "len=0 sha8=none";
  const sha8 = createHash("sha256").update(token).digest("hex").slice(0, 8);
  return `len=${token.length} sha8=${sha8}`;
}

/** Safe (token-free) description of a Graph error body, for logs only. */
function describeGraphError(json: unknown): string {
  const err = (json as { error?: unknown } | null | undefined)?.error;
  if (!err) return "ok";
  if (typeof err === "string") return `error=${err}`;
  const e = err as { code?: unknown; error_subcode?: unknown; type?: unknown; message?: unknown };
  return [
    `code=${e.code ?? "-"}`,
    `subcode=${e.error_subcode ?? "-"}`,
    `type=${e.type ?? "-"}`,
    `message=${typeof e.message === "string" ? e.message : "-"}`,
  ].join(" ");
}

/** True when a 2xx Graph body still carries an `error` object (Graph does this). */
function hasGraphError(json: unknown): boolean {
  const err = (json as { error?: unknown } | null | undefined)?.error;
  return Boolean(err);
}

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

  // Diagnostics: status + token fingerprint + the id/name Graph resolved. No URL,
  // no token — the fingerprint lets us confirm this is the same token /me/accounts
  // will use a moment later.
  fbDebug(
    `GET /me status=${res.status}`,
    `token[${tokenFingerprint(accessToken)}]`,
    describeGraphError(json),
    `id=${typeof json.id === "string" ? json.id : "-"}`,
    `name=${typeof json.name === "string" ? json.name : "-"}`,
  );

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

  const rows = Array.isArray(json.data) ? json.data : [];

  // Diagnostics: status + every permission with its granted/declined status. A
  // required scope silently declined on the consent screen is the #1 cause of an
  // empty /me/accounts, so we log the full grant map (no token, no URL).
  fbDebug(
    `GET /me/permissions status=${res.status}`,
    `token[${tokenFingerprint(userToken)}]`,
    describeGraphError(json),
    `permissions=[${rows
      .map(r => `${r?.permission ?? "?"}=${r?.status ?? "?"}`)
      .join(", ")}]`,
  );

  if (!res.ok) {
    throw new FacebookApiError(
      extractError(json) || `Facebook permissions request failed (${res.status})`,
      res.status,
      "permissions_fetch_failed",
    );
  }

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
 * Task names that permit publishing content to a Page.
 *
 * META USES TWO PARALLEL NAMINGS and /me/accounts can return either, depending on
 * whether the Page is on the classic Page roles model or the New Pages Experience
 * ("Profile Plus"):
 *
 *   classic       CREATE_CONTENT · MANAGE · MODERATE
 *   Profile Plus  PROFILE_PLUS_CREATE_CONTENT · PROFILE_PLUS_MANAGE ·
 *                 PROFILE_PLUS_MODERATE · PROFILE_PLUS_FULL_CONTROL ·
 *                 PROFILE_PLUS_FACEBOOK_ACCESS
 *
 * We normalize by stripping the `PROFILE_PLUS_` prefix and matching the remainder
 * against this whitelist, so both namings resolve to the same verdict. Matching
 * only the classic names (the previous behaviour) silently marked every New Pages
 * Experience Page as read-only.
 */
const PUBLISHABLE_PAGE_TASKS = new Set([
  "CREATE_CONTENT",
  "MANAGE",
  "MODERATE",
  // Profile Plus only — no classic equivalent. FULL_CONTROL is the strongest
  // role; FACEBOOK_ACCESS grants acting as the Page on Facebook (incl. posting).
  "FULL_CONTROL",
  "FACEBOOK_ACCESS",
]);

/** Strip Meta's `PROFILE_PLUS_` prefix and normalize case/whitespace. */
function normalizePageTask(task: string): string {
  const upper = task.trim().toUpperCase();
  return upper.startsWith("PROFILE_PLUS_") ? upper.slice("PROFILE_PLUS_".length) : upper;
}

/**
 * True when the user's Page tasks include a role that permits publishing content,
 * under EITHER of Meta's two task namings (see PUBLISHABLE_PAGE_TASKS).
 *
 * Note: this is a display/capability HINT only. An empty or unrecognized task list
 * never removes a Page from the candidate list — Graph sometimes omits `tasks`
 * entirely, and dropping the Page would leave the user with no publish target at
 * all. See fetchManagedPages.
 */
export function canPublishToPage(tasks: readonly string[]): boolean {
  return tasks.some(t => typeof t === "string" && PUBLISHABLE_PAGE_TASKS.has(normalizePageTask(t)));
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
 * follow it up to a small defensive cap (5 pages of results) so an account with
 * many Pages is enumerated without an unbounded fetch loop; results are de-duped
 * by pageId (a cursor replay can repeat a row). The user token is in the query
 * string; errors never echo the URL.
 *
 * Every returned id/name comes from Graph — never from the client.
 */
export async function fetchManagedPages(userToken: string): Promise<ManagedPage[]> {
  const MAX_PAGES_OF_RESULTS = 5;
  // Keyed by pageId so a repeated cursor row cannot produce a duplicate Page.
  const discovered = new Map<string, ManagedPage>();
  let requests = 0;

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
    requests += 1;

    const rows = Array.isArray(json.data) ? json.data : [];

    // Diagnostics: status, row count, and each Page's id/name/tasks. Fields are
    // hand-picked ON PURPOSE — a raw Page row carries `access_token`, so it must
    // never be stringified wholesale. No URL is logged (the cursor carries the token).
    fbDebug(
      `GET /me/accounts[req#${requests}] status=${res.status}`,
      `token[${tokenFingerprint(userToken)}]`,
      describeGraphError(json),
      `rows=${rows.length}`,
      `pages=[${rows
        .map(p => `{id=${p?.id ?? "-"} name=${p?.name ?? "-"} tasks=${Array.isArray(p?.tasks) ? p!.tasks!.join("|") : "-"}}`)
        .join(", ")}]`,
    );

    if (!res.ok) {
      throw new FacebookApiError(
        extractError(json) || `Facebook accounts request failed (${res.status})`,
        res.status,
        "accounts_fetch_failed",
      );
    }

    // Graph occasionally returns HTTP 200 with an `error` object and no data.
    // Treating that as "no Pages" would show the user a false "you have no Page"
    // diagnostic, so surface it as a genuine API failure.
    if (hasGraphError(json)) {
      throw new FacebookApiError(
        extractError(json) || "Facebook accounts request returned an error",
        502,
        "accounts_fetch_failed",
      );
    }

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
      // NOTE: an empty/unknown `tasks` array is deliberately NOT a reason to drop
      // the Page — tasks only decide the canPublish HINT (see canPublishToPage).
      discovered.set(page.id, {
        pageId: page.id,
        pageName: typeof page.name === "string" ? page.name : null,
        pageAccessToken: page.access_token,
        tasks: Array.isArray(page.tasks) ? page.tasks.filter((t): t is string => typeof t === "string") : [],
      });
    }

    const next = json.paging?.next;
    nextUrl = typeof next === "string" && next ? next : null;

    if (nextUrl && fetched + 1 >= MAX_PAGES_OF_RESULTS) {
      // Hit the defensive cap with a cursor still pending — the enumeration is
      // truncated. Worth knowing: it would look like "some Pages are missing".
      fbDebug(
        `GET /me/accounts pagination cap reached (max=${MAX_PAGES_OF_RESULTS} requests) —`,
        `more results remain unfetched; discovered=${discovered.size}`,
      );
    }
  }

  fbDebug(`fetchManagedPages done requests=${requests} unique_pages=${discovered.size}`);
  return [...discovered.values()];
}

/**
 * Fetch ONE specific Facebook Page by id with the user token:
 *   GET /{page-id}?fields=id,name,access_token
 *
 * WHY THIS EXISTS (the manual-Page fallback):
 * Meta's /me/accounts edge can return HTTP 200 with `{"data":[]}` and NO error even
 * when the user demonstrably administers a Page — Business-Portfolio-owned Pages
 * that were not selected in the Login-for-Business asset picker behave exactly this
 * way. The same user token nevertheless resolves the Page node directly AND yields
 * its page-scoped access token. So "enumeration empty" is NOT "user has no Page",
 * and this call is the escape hatch: the user supplies the numeric Page id and we
 * verify + resolve it against Graph.
 *
 * (/me/businesses would enumerate those Pages, but it requires business_management,
 * a scope this project deliberately does not request.)
 *
 * FIELD NOTE — `tasks` MUST NOT be requested here. `tasks` is a field of the
 * /me/accounts EDGE (the user's role on each Page), not of the Page NODE. Asking
 * for it on a direct Page read fails the whole request with
 * `(#100) Tried accessing nonexisting field (tasks) on node type (Page)`. We
 * therefore return `tasks: []`; the caller treats an empty task list as "unknown
 * role", which only downgrades the canPublish display hint (see canPublishToPage)
 * and never drops the Page.
 *
 * VALIDATION (all mandatory — a soft pass here would persist a dead Page):
 *   - the returned `id` must EXACTLY equal the requested pageId (no aliasing);
 *   - `name` must be present;
 *   - `access_token` (the page-scoped token) must be present — without it we cannot
 *     publish, so a Page without one is rejected rather than stored.
 *
 * ERROR CODES (the route maps these to HTTP):
 *   page_not_found      — Graph code 100 / 803, or HTTP 404 (bad or invisible id)
 *   page_access_denied  — OAuthException permission failure (code 10 / 200 / 190)
 *   page_no_access_token— Page resolved but Graph returned no page-scoped token
 *   page_id_mismatch    — Graph answered with a different node id
 *   page_name_missing   — Graph answered without a name
 *   graph_api_error     — anything else
 *
 * The token is in the query string, so (as everywhere in this module) errors and
 * logs NEVER echo the URL, and the page token is only ever logged as a boolean.
 */
export async function fetchPageById(userToken: string, pageId: string): Promise<ManagedPage> {
  // `tasks` intentionally omitted — see FIELD NOTE above.
  const params = new URLSearchParams({ fields: "id,name,access_token", access_token: userToken });
  const res = await fetch(`${FACEBOOK_GRAPH_URL}/${encodeURIComponent(pageId)}?${params.toString()}`, {
    method: "GET",
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: unknown;
    name?: unknown;
    access_token?: unknown;
  } & Record<string, unknown>;

  const returnedId = typeof json.id === "string" ? json.id : null;
  const returnedName = typeof json.name === "string" ? json.name : null;
  const pageToken = typeof json.access_token === "string" && json.access_token ? json.access_token : null;

  // Diagnostics: hand-picked fields ONLY. The page-scoped token is reduced to a
  // boolean — never printed, never fingerprinted into the same line as the id.
  fbDebug(
    `GET /{pageId} requested_page_id=${pageId} status=${res.status}`,
    `token[${tokenFingerprint(userToken)}]`,
    describeGraphError(json),
    `id=${returnedId ?? "-"}`,
    `name=${returnedName ?? "-"}`,
    `hasPageToken=${Boolean(pageToken)}`,
  );

  // Graph errors first: a 2xx body can still carry `error`, so check both.
  if (!res.ok || hasGraphError(json)) {
    const err = (json as { error?: { code?: unknown; type?: unknown; message?: unknown } }).error;
    const graphCode = typeof err?.code === "number" ? err.code : null;
    const graphType = typeof err?.type === "string" ? err.type : "";
    const graphMessage = typeof err?.message === "string" ? err.message : "";

    // 100 = nonexistent field/node, 803 = "Some of the aliases you requested do not
    // exist" — both mean "this id is not a Page we can see".
    if (graphCode === 100 || graphCode === 803 || res.status === 404) {
      throw new FacebookApiError(
        graphMessage || `Facebook could not find that Page (${res.status})`,
        404,
        "page_not_found",
      );
    }
    // Permission-class OAuthException: 10 = permission denied, 200 = insufficient
    // permission, 190 = invalid/expired token.
    if (
      graphCode === 10 ||
      graphCode === 200 ||
      graphCode === 190 ||
      (graphType === "OAuthException" && /permission/i.test(graphMessage))
    ) {
      throw new FacebookApiError(
        graphMessage || "Facebook denied access to that Page",
        403,
        "page_access_denied",
      );
    }
    throw new FacebookApiError(
      graphMessage || `Facebook Page request failed (${res.status})`,
      res.ok ? 502 : res.status,
      "graph_api_error",
    );
  }

  // ── Strict shape validation ────────────────────────────────────────────────
  if (!returnedId) {
    throw new FacebookApiError("Facebook returned no Page id", 502, "graph_api_error");
  }
  if (returnedId !== pageId) {
    // Graph resolved a DIFFERENT node than the one asked for — never persist that.
    throw new FacebookApiError(
      "Facebook returned a different Page than requested",
      502,
      "page_id_mismatch",
    );
  }
  if (!returnedName) {
    throw new FacebookApiError("Facebook returned no Page name", 502, "page_name_missing");
  }
  if (!pageToken) {
    // The node exists but yields no page-scoped token — usually the user is not an
    // admin of it, or the Page scopes were not granted. Publishing would be
    // impossible, so this is a hard failure rather than a partial success.
    throw new FacebookApiError(
      "Facebook did not return a Page access token for that Page",
      422,
      "page_no_access_token",
    );
  }

  return {
    pageId: returnedId,
    pageName: returnedName,
    pageAccessToken: pageToken,
    // Empty ON PURPOSE: `tasks` cannot be read from a Page node (see FIELD NOTE).
    tasks: [],
  };
}

/**
 * RECONNECT AUTO-RESTORE: after a re-authorization whose /me/accounts came back
 * empty, try to re-validate the user's PREVIOUSLY selected Page with the FRESH
 * user token. Delegates to fetchPageById, which already enforces everything the
 * restore needs: returned id === saved id, name present, page access_token
 * present, Graph errors classified — and never embeds a token in messages/URLs.
 *
 * Never throws: any verification failure (denied / not found / Graph error /
 * unexpected) returns null so the caller can fall back to manual Page entry
 * WITHOUT wiping the saved Page id. The old stored Page token is deliberately
 * never used as evidence here — only the fresh user token decides.
 */
export async function restorePreviousPage(
  userToken: string,
  savedPageId: string,
): Promise<ManagedPage | null> {
  try {
    const page = await fetchPageById(userToken, savedPageId);
    fbDebug(`restorePreviousPage ok page=${page.pageId} name=${page.pageName ?? "-"} has_token=true`);
    return page;
  } catch (err) {
    if (err instanceof FacebookApiError) {
      fbDebug(`restorePreviousPage failed code=${err.code} status=${err.status}`);
    } else {
      fbDebug(`restorePreviousPage threw: ${(err as Error).message}`);
    }
    return null;
  }
}

/**
 * DEVELOPMENT-ONLY diagnostic probe: read ONE specific Page by id with the user
 * token (GET /{page-id}?fields=id,name,tasks).
 *
 * Purpose: when /me/accounts comes back empty with no error, this distinguishes
 * "the user really administers nothing" from "the Page exists and is reachable
 * with this very token, but Meta excluded it from the accounts edge" (typically a
 * Business-Portfolio-owned Page that was not selected in the Login-for-Business
 * asset picker). That distinction is invisible from /me/accounts alone.
 *
 * The Page id comes ONLY from the FACEBOOK_DEBUG_PAGE_ID env var — never
 * hard-coded, never from a request, never from a user record. It has NO effect on
 * the connection outcome: nothing here is persisted, returned to the browser, or
 * used to select a Page. It writes fbDebug lines and nothing else, and it is a
 * no-op in production (fbDebug is silent) — but we also skip the network call
 * entirely so production never issues an extra Graph request.
 */
export async function debugProbePageById(userToken: string): Promise<void> {
  if (!FB_DEBUG_ENABLED) return;
  const pageId = process.env.FACEBOOK_DEBUG_PAGE_ID?.trim();
  if (!pageId) {
    fbDebug("debugProbePageById skipped — FACEBOOK_DEBUG_PAGE_ID is not set");
    return;
  }

  try {
    const params = new URLSearchParams({ fields: "id,name,tasks", access_token: userToken });
    const res = await fetch(`${FACEBOOK_GRAPH_URL}/${encodeURIComponent(pageId)}?${params.toString()}`, {
      method: "GET",
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      tasks?: unknown;
    } & Record<string, unknown>;

    // Hand-picked fields only (a Page node can echo tokens on other edges).
    fbDebug(
      `GET /{FACEBOOK_DEBUG_PAGE_ID} status=${res.status}`,
      `token[${tokenFingerprint(userToken)}]`,
      describeGraphError(json),
      `id=${typeof json.id === "string" ? json.id : "-"}`,
      `name=${typeof json.name === "string" ? json.name : "-"}`,
      `tasks=${Array.isArray(json.tasks) ? json.tasks.join("|") : "-"}`,
    );
  } catch (err) {
    // A diagnostic must never break the connect flow.
    fbDebug("debugProbePageById threw:", (err as Error).message);
  }
}
