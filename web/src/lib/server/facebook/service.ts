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

// ── Publishing to a Page ──────────────────────────────────────────────────────

/** What a Page publish accepts. Kept platform-neutral at the call site. */
export type PublishToPageInput = {
  /** Post copy (Graph `message`). Optional — a photo post may be caption-less. */
  message?: string | null;
  /**
   * Publicly reachable image URL. Present → photo post (POST /{page-id}/photos
   * with `url`); absent → plain text post (POST /{page-id}/feed).
   *
   * Graph FETCHES this URL itself, so it must be a public http(s) address —
   * blob:/data:/localhost URLs cannot work and are rejected before we call out.
   */
  imageUrl?: string | null;
  /**
   * The full media set in display order (cover first). ≥2 entries publish a real
   * MULTI-PHOTO feed post; 1 or absent falls back to `imageUrl` and the request is
   * byte-for-byte what it has always been. Count limits belong to the caller
   * (checkFacebookMedia) — nothing is dropped here.
   */
  imageUrls?: readonly string[] | null;
  /**
   * Destination link, appended to the message for a photo post. Graph's `link`
   * param belongs to /feed only — on /photos it is silently ignored, and on a
   * /feed post it is REJECTED alongside `attached_media` — so for any photo post
   * we fold the URL into the message instead of pretending it took.
   */
  link?: string | null;
};

export type PublishToPageResult = {
  /** The Page post id (`{page-id}_{post-id}`) — what a permalink resolves from. */
  externalPostId: string;
  /** Direct link to the published post on facebook.com. Never null. */
  permalink: string;
  /**
   * True when Graph did not return a permalink_url and we constructed
   * `https://www.facebook.com/{externalPostId}` instead (it 302s to the post).
   */
  permalinkFallback: boolean;
};

/** Only a public http(s) image can be fetched by Graph. */
function isPubliclyFetchableImage(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

/**
 * Classify a Graph error body from a PUBLISH call into a FacebookApiError.
 * Mirrors fetchPageById's mapping so callers get one consistent code vocabulary.
 * NEVER echoes the request URL (it carries the page token in the query string).
 */
function publishGraphError(json: unknown, httpStatus: number): FacebookApiError {
  const err = (json as { error?: { code?: unknown; type?: unknown; message?: unknown } }).error;
  const graphCode = typeof err?.code === "number" ? err.code : null;
  const graphType = typeof err?.type === "string" ? err.type : "";
  const graphMessage = typeof err?.message === "string" ? err.message : "";

  // 190 invalid/expired token · 200 insufficient permission · 10 permission denied.
  if (
    graphCode === 190 ||
    graphCode === 200 ||
    graphCode === 10 ||
    (graphType === "OAuthException" && /permission|token|expired|session/i.test(graphMessage))
  ) {
    return new FacebookApiError(
      graphMessage || "Facebook denied permission to publish to that Page",
      403,
      "publish_permission_denied",
    );
  }
  // 100 = nonexistent node/field, 803 = unresolvable alias.
  if (graphCode === 100 || graphCode === 803 || httpStatus === 404) {
    return new FacebookApiError(
      graphMessage || "Facebook could not find that Page",
      404,
      "page_not_found",
    );
  }
  // 4 / 17 / 32 / 613 are Meta's rate-limit family.
  if (graphCode === 4 || graphCode === 17 || graphCode === 32 || graphCode === 613 || httpStatus === 429) {
    return new FacebookApiError(
      graphMessage || "Facebook is rate limiting this Page right now",
      429,
      "publish_rate_limited",
    );
  }
  return new FacebookApiError(
    graphMessage || `Facebook publish failed (${httpStatus})`,
    httpStatus >= 400 ? httpStatus : 502,
    "publish_failed",
  );
}

/**
 * Read the direct permalink for a just-created post: GET /{id}?fields=permalink_url
 * with the SAME page token that created it.
 *
 * Returns null on ANY failure (Graph occasionally has not materialized the node
 * yet, or omits the field). Never throws — the post already exists, so a missing
 * permalink must degrade to the constructed fallback, not fail the publish.
 */
async function fetchPostPermalink(pageToken: string, postId: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ fields: "permalink_url", access_token: pageToken });
    const res = await fetch(`${FACEBOOK_GRAPH_URL}/${encodeURIComponent(postId)}?${params.toString()}`, {
      method: "GET",
    });
    const json = (await res.json().catch(() => ({}))) as { permalink_url?: unknown } & Record<string, unknown>;
    const permalink = typeof json.permalink_url === "string" && json.permalink_url ? json.permalink_url : null;

    // Hand-picked fields only; no URL (it carries the page token), no token.
    fbDebug(
      `GET /{postId}?fields=permalink_url status=${res.status}`,
      `token[${tokenFingerprint(pageToken)}]`,
      describeGraphError(json),
      `post_id=${postId}`,
      `hasPermalink=${Boolean(permalink)}`,
    );

    if (!res.ok || hasGraphError(json)) return null;
    return permalink;
  } catch (err) {
    // A permalink read must never break a successful publish.
    fbDebug(`fetchPostPermalink threw: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Publish a post to a Facebook Page using that Page's PAGE-SCOPED access token.
 *
 * TWO ENDPOINTS, chosen by whether an image is supplied:
 *
 *   imageUrl present → POST /{page-id}/photos   body: url, caption
 *       Graph fetches `url` server-side (so it must be public http(s)) and answers
 *       `{ id: <photo-id>, post_id: <page-post-id> }`. The PHOTO id is NOT the
 *       feed post — `post_id` is. We therefore prefer `post_id` for both the
 *       stored external id and the permalink lookup, falling back to `id` only
 *       when Graph omits post_id (older API behaviour).
 *
 *   no imageUrl      → POST /{page-id}/feed     body: message, link
 *       Answers `{ id: "<page-id>_<post-id>" }`.
 *
 * `link` is a /feed-only parameter. On a photo post it is folded into the caption
 * instead of being sent as a param that Graph would silently drop.
 *
 * The response id is then resolved to a real permalink via
 * GET /{id}?fields=permalink_url (same page token). When that read yields nothing
 * we fall back to `https://www.facebook.com/{externalPostId}`, which 302s to the
 * post — a working link is better than none, and the fallback is recorded both in
 * the return value (`permalinkFallback`) and in fbDebug.
 *
 * SECURITY: the page token goes in the POST BODY (not the query string) so it is
 * never part of a URL; errors and logs never echo the body, the URL, or the token.
 */
export async function publishToPage(
  pageToken: string,
  pageId: string,
  input: PublishToPageInput,
): Promise<PublishToPageResult> {
  const message = (input.message ?? "").trim();
  const link = (input.link ?? "").trim();
  // The media set in display order. `imageUrl` stays the single-image contract, so a
  // caller that never learned about `imageUrls` behaves exactly as it did before.
  const imageUrls = (input.imageUrls ?? [])
    .map(u => (typeof u === "string" ? u.trim() : ""))
    .filter(Boolean);
  const imageUrl = imageUrls[0] ?? (input.imageUrl ?? "").trim();
  const allImages = imageUrls.length ? imageUrls : imageUrl ? [imageUrl] : [];

  for (const url of allImages) {
    if (!isPubliclyFetchableImage(url)) {
      throw new FacebookApiError(
        "The image must be a publicly reachable http(s) URL for Facebook to fetch it",
        422,
        "publish_image_not_public",
      );
    }
  }

  // ≥2 images is a different Graph shape entirely (unpublished photos + a feed post
  // that attaches them), so it gets its own function rather than branching this one.
  if (allImages.length > 1) {
    return publishMultiPhotoToPage(pageToken, pageId, allImages, message, link);
  }

  if (!imageUrl && !message) {
    throw new FacebookApiError(
      "A Facebook post needs either text or an image",
      422,
      "publish_empty_post",
    );
  }

  const body = new URLSearchParams({ access_token: pageToken });
  let edge: "photos" | "feed";

  if (imageUrl) {
    edge = "photos";
    body.set("url", imageUrl);
    // /photos takes `caption`, not `message`; `link` is not honoured here, so the
    // destination URL is appended to the caption to stay truthful.
    const caption = [message, link].filter(Boolean).join("\n\n");
    if (caption) body.set("caption", caption);
  } else {
    edge = "feed";
    body.set("message", message);
    if (link) body.set("link", link);
  }

  const res = await fetch(`${FACEBOOK_GRAPH_URL}/${encodeURIComponent(pageId)}/${edge}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: unknown;
    post_id?: unknown;
  } & Record<string, unknown>;

  const rawId = typeof json.id === "string" && json.id ? json.id : null;
  const rawPostId = typeof json.post_id === "string" && json.post_id ? json.post_id : null;

  // Hand-picked fields ONLY — never stringify a Graph body wholesale, and never
  // log the request (its body carries the page token).
  fbDebug(
    `POST /{pageId}/${edge} status=${res.status}`,
    `token[${tokenFingerprint(pageToken)}]`,
    describeGraphError(json),
    `page_id=${pageId}`,
    `hasImage=${Boolean(imageUrl)}`,
    `id=${rawId ?? "-"}`,
    `post_id=${rawPostId ?? "-"}`,
  );

  // A 2xx body can still carry `error` (Graph does this) — check both.
  if (!res.ok || hasGraphError(json)) {
    throw publishGraphError(json, res.status);
  }

  // Prefer post_id (the Page FEED post) over id (a photo node id on /photos).
  const externalPostId = rawPostId ?? rawId;
  if (!externalPostId) {
    throw new FacebookApiError(
      "Facebook accepted the post but returned no post id",
      502,
      "publish_no_post_id",
    );
  }

  const permalink = await fetchPostPermalink(pageToken, externalPostId);
  if (permalink) {
    return { externalPostId, permalink, permalinkFallback: false };
  }

  // Graph gave us no permalink — construct the canonical redirect form. Recorded
  // as a fallback so the difference stays visible in diagnostics.
  const fallback = `https://www.facebook.com/${externalPostId}`;
  fbDebug(
    `permalink_url unavailable — falling back to constructed URL`,
    `post_id=${externalPostId}`,
  );
  return { externalPostId, permalink: fallback, permalinkFallback: true };
}

/**
 * Publish a MULTI-PHOTO feed post (2+ images in one post).
 *
 * Graph's shape, in order:
 *   1. POST /{page-id}/photos with `url` and `published=false` for each image →
 *      an UNPUBLISHED photo id per image. Unpublished on purpose: a published
 *      photo would appear as its own post, so the merchant would see N separate
 *      single-photo posts instead of one gallery.
 *   2. POST /{page-id}/feed with `message` and
 *      `attached_media=[{"media_fbid":…},…]` in the SAME order — that array is
 *      the display order of the gallery.
 *
 * `link` is NOT sent: Graph rejects `link` together with `attached_media`, so the
 * destination URL is folded into the message exactly as the single-photo path
 * folds it into the caption. Sending it would fail the whole post.
 *
 * ALL-OR-NOTHING: if any photo upload fails, the error propagates and no feed post
 * is created. A partial gallery would publish a Content the merchant never
 * approved — and the already-uploaded photos stay unpublished, so nothing of it is
 * visible on the Page.
 *
 * SECURITY: the page token rides in the POST body, never a URL; errors and logs
 * never echo the body, the URL, or the token.
 */
async function publishMultiPhotoToPage(
  pageToken: string,
  pageId: string,
  imageUrls: readonly string[],
  message: string,
  link: string,
): Promise<PublishToPageResult> {
  // 1 — upload each photo unpublished, in order.
  const mediaFbids: string[] = [];
  for (const url of imageUrls) {
    const photoBody = new URLSearchParams({
      access_token: pageToken,
      url,
      published: "false",
    });
    const photoRes = await fetch(`${FACEBOOK_GRAPH_URL}/${encodeURIComponent(pageId)}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: photoBody.toString(),
    });
    const photoJson = (await photoRes.json().catch(() => ({}))) as { id?: unknown } & Record<string, unknown>;

    fbDebug(
      `POST /{pageId}/photos[published=false] status=${photoRes.status}`,
      `token[${tokenFingerprint(pageToken)}]`,
      describeGraphError(photoJson),
      `page_id=${pageId}`,
      `photo_index=${mediaFbids.length}`,
      `id=${typeof photoJson.id === "string" ? photoJson.id : "-"}`,
    );

    if (!photoRes.ok || hasGraphError(photoJson)) {
      throw publishGraphError(photoJson, photoRes.status);
    }
    const photoId = typeof photoJson.id === "string" && photoJson.id ? photoJson.id : null;
    if (!photoId) {
      throw new FacebookApiError(
        "Facebook accepted an image but returned no photo id",
        502,
        "publish_no_post_id",
      );
    }
    mediaFbids.push(photoId);
  }

  // 2 — one feed post attaching them all, in the same order.
  const feedBody = new URLSearchParams({ access_token: pageToken });
  // `link` is deliberately absent (Graph refuses it beside attached_media) — the
  // destination URL is appended to the message so the merchant's traffic path survives.
  const fullMessage = [message, link].filter(Boolean).join("\n\n");
  if (fullMessage) feedBody.set("message", fullMessage);
  feedBody.set("attached_media", JSON.stringify(mediaFbids.map(id => ({ media_fbid: id }))));

  const feedRes = await fetch(`${FACEBOOK_GRAPH_URL}/${encodeURIComponent(pageId)}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: feedBody.toString(),
  });
  const feedJson = (await feedRes.json().catch(() => ({}))) as {
    id?: unknown;
    post_id?: unknown;
  } & Record<string, unknown>;

  fbDebug(
    `POST /{pageId}/feed[attached_media] status=${feedRes.status}`,
    `token[${tokenFingerprint(pageToken)}]`,
    describeGraphError(feedJson),
    `page_id=${pageId}`,
    `photo_count=${mediaFbids.length}`,
    `id=${typeof feedJson.id === "string" ? feedJson.id : "-"}`,
  );

  if (!feedRes.ok || hasGraphError(feedJson)) {
    throw publishGraphError(feedJson, feedRes.status);
  }

  const externalPostId =
    (typeof feedJson.post_id === "string" && feedJson.post_id ? feedJson.post_id : null)
    ?? (typeof feedJson.id === "string" && feedJson.id ? feedJson.id : null);
  if (!externalPostId) {
    throw new FacebookApiError(
      "Facebook accepted the post but returned no post id",
      502,
      "publish_no_post_id",
    );
  }

  const permalink = await fetchPostPermalink(pageToken, externalPostId);
  if (permalink) return { externalPostId, permalink, permalinkFallback: false };

  fbDebug(
    `permalink_url unavailable — falling back to constructed URL`,
    `post_id=${externalPostId}`,
  );
  return { externalPostId, permalink: `https://www.facebook.com/${externalPostId}`, permalinkFallback: true };
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
