/**
 * Instagram (Instagram Login) API client (server-only). The ONLY place that issues
 * raw Instagram HTTP calls for the OAuth flow — route handlers never fetch
 * Instagram directly.
 *
 * Responsibilities:
 *   - OAuth code exchange (short-lived token + user_id) then short→long-lived
 *     exchange (~60 days).
 *   - Fetching the connected Instagram account's profile (user_id / username /
 *     account_type / name) for display and the PERSONAL-account gate.
 *
 * KEY DIFFERENCES vs the Facebook service:
 *   - Instagram's token endpoint is api.instagram.com/oauth/access_token and takes
 *     the code exchange as an application/x-www-form-urlencoded POST BODY
 *     (grant_type=authorization_code), NOT GET query params on graph.facebook.com.
 *   - The short-lived response ALSO returns the Instagram user_id alongside the
 *     token.
 *   - Short→long-lived uses grant_type=ig_exchange_token against
 *     graph.instagram.com (client_secret + access_token as query), NOT
 *     fb_exchange_token against graph.facebook.com.
 *   - Profile is read from graph.instagram.com/<ver>/me (user_id, username,
 *     account_type, name), NOT graph.facebook.com/me.
 *
 * Errors never include credentials. Tokens are never logged, and no request URL is
 * ever echoed in an error (both the POST body and the graph query carry secrets).
 */

import {
  INSTAGRAM_TOKEN_URL,
  INSTAGRAM_GRAPH_URL,
  INSTAGRAM_GRAPH_ROOT_URL,
  getInstagramEnv,
} from "./config";

export class InstagramApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = "instagram_error") {
    super(message);
    this.name = "InstagramApiError";
    this.status = status;
    this.code = code;
  }
}

export type InstagramTokenSet = {
  accessToken: string;
  /** Instagram's long-lived token is not a refresh token — kept null. */
  refreshToken: string | null;
  /** ISO timestamp for when the long-lived token expires (now + expires_in), or null. */
  accessTokenExpiresAt: string | null;
  /** The Instagram user id returned by the short-lived exchange. */
  userId: string;
  scopes: string[];
};

export type InstagramAccountType = "BUSINESS" | "MEDIA_CREATOR" | "PERSONAL" | string;

export type InstagramProfile = {
  /** Instagram-scoped user id (from graph.instagram.com/me?fields=user_id). */
  userId: string;
  username: string | null;
  /** BUSINESS / MEDIA_CREATOR / PERSONAL — drives the PERSONAL-account rejection. */
  accountType: InstagramAccountType | null;
  name: string | null;
};

type RawShortTokenResponse = {
  access_token?: string;
  user_id?: number | string;
  permissions?: string;
  error_type?: string;
  error_message?: string;
  error?: { message?: string; type?: string; code?: number } | string;
};

type RawLongTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string; type?: string; code?: number } | string;
};

function expiryFromNow(seconds: number | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Extract a safe error message from an Instagram error body without echoing any
 * request data. Handles both the api.instagram.com shape
 * ({ error_type, error_message }) and the graph.instagram.com shape
 * ({ error: { message } }).
 */
function extractError(json: Record<string, unknown>): string | null {
  const errMsg = (json as { error_message?: unknown }).error_message;
  if (typeof errMsg === "string" && errMsg) return errMsg;
  const err = (json as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return null;
}

/**
 * Exchange an authorization code for a LONG-lived Instagram token (two steps):
 *   1. code → short-lived token + user_id via POST api.instagram.com/oauth/access_token
 *      (application/x-www-form-urlencoded body:
 *       client_id / client_secret / grant_type=authorization_code / redirect_uri / code).
 *   2. short-lived → long-lived (~60 days) via GET
 *      graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=…&access_token=…
 * The long-lived token is what we persist; expiry = now + its expires_in.
 */
export async function exchangeCodeForTokens(code: string): Promise<InstagramTokenSet> {
  const env = getInstagramEnv();

  // ── Step 1: code → short-lived token (+ user_id). FORM-URLENCODED POST BODY. ──
  const shortBody = new URLSearchParams({
    client_id: env.appId,
    client_secret: env.appSecret,
    grant_type: "authorization_code",
    redirect_uri: env.redirectUri,
    code,
  });
  const shortRes = await fetch(INSTAGRAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: shortBody.toString(),
  });
  const shortJson = (await shortRes.json().catch(() => ({}))) as RawShortTokenResponse;
  if (!shortRes.ok || !shortJson.access_token || shortJson.user_id === undefined || shortJson.user_id === null) {
    // Never echo the body/params (contains secret + code).
    throw new InstagramApiError(
      extractError(shortJson as Record<string, unknown>) || `Instagram token request failed (${shortRes.status})`,
      shortRes.ok ? 400 : shortRes.status,
      "token_exchange_failed",
    );
  }
  const shortToken = shortJson.access_token;
  const userId = String(shortJson.user_id);
  // Instagram returns the actually-granted permissions on the short-lived exchange.
  const granted = typeof shortJson.permissions === "string" && shortJson.permissions
    ? shortJson.permissions.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  // ── Step 2: short-lived → long-lived (~60 days). GET graph.instagram.com. ─────
  const longParams = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: env.appSecret,
    access_token: shortToken,
  });
  const longRes = await fetch(`${INSTAGRAM_GRAPH_ROOT_URL}/access_token?${longParams.toString()}`, {
    method: "GET",
  });
  const longJson = (await longRes.json().catch(() => ({}))) as RawLongTokenResponse;
  if (!longRes.ok || !longJson.access_token) {
    throw new InstagramApiError(
      extractError(longJson as Record<string, unknown>) || `Instagram long-lived token request failed (${longRes.status})`,
      longRes.ok ? 400 : longRes.status,
      "long_token_exchange_failed",
    );
  }

  return {
    accessToken: longJson.access_token,
    refreshToken: null,
    accessTokenExpiresAt: expiryFromNow(longJson.expires_in),
    userId,
    scopes: granted,
  };
}

/**
 * Fetch the connected Instagram account's profile with a user access token:
 *   GET graph.instagram.com/<ver>/me?fields=user_id,username,account_type,name
 *
 * Used to populate provider_account_id / _username / _name AND to gate the
 * connection: a PERSONAL account is rejected by the callback (VibePin supports
 * only Business / Creator accounts). The token is in the query string; errors
 * never echo it.
 */
export async function fetchInstagramProfile(accessToken: string): Promise<InstagramProfile> {
  const params = new URLSearchParams({
    fields: "user_id,username,account_type,name",
    access_token: accessToken,
  });
  const res = await fetch(`${INSTAGRAM_GRAPH_URL}/me?${params.toString()}`, { method: "GET" });
  const json = (await res.json().catch(() => ({}))) as {
    user_id?: string | number;
    id?: string | number;
    username?: string;
    account_type?: string;
    name?: string;
  } & Record<string, unknown>;

  // Prefer user_id; fall back to id (some responses return the IG-scoped id there).
  const rawId = json.user_id ?? json.id;
  if (!res.ok || rawId === undefined || rawId === null || String(rawId) === "") {
    throw new InstagramApiError(
      extractError(json) || `Instagram profile request failed (${res.status})`,
      res.ok ? 502 : res.status,
      "profile_fetch_failed",
    );
  }

  return {
    userId: String(rawId),
    username: typeof json.username === "string" ? json.username : null,
    accountType: typeof json.account_type === "string" ? json.account_type : null,
    name: typeof json.name === "string" ? json.name : null,
  };
}

/**
 * True when the Instagram account type is one VibePin supports (Business or
 * Creator). PERSONAL accounts cannot use content publishing, so the callback
 * rejects them. An unknown/missing account_type is treated as NOT acceptable
 * (fail-closed) so we never mark a non-professional account as connected.
 */
export function isProfessionalAccount(accountType: InstagramAccountType | null | undefined): boolean {
  return accountType === "BUSINESS" || accountType === "MEDIA_CREATOR";
}

// ── Publishing ──────────────────────────────────────────────────────────────

/** Only a public http(s) image can be fetched by Instagram's servers. */
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

export type InstagramPublishInput = {
  accessToken: string;
  /** IG user id (the professional account's own id, from the profile call). */
  igUserId: string;
  imageUrl: string;
  caption?: string;
  /**
   * Destination URL. Instagram captions render links as plain text — they are
   * NOT clickable — but dropping the link entirely would silently lose the
   * merchant's traffic path, so it is appended to the caption where a reader can
   * still see and copy it.
   */
  destinationUrl?: string;
};

export type InstagramPublishResult = { mediaId: string; permalink: string | null };

/** Compose the caption Instagram will show, with the destination URL appended. */
export function buildInstagramCaption(caption?: string, destinationUrl?: string): string {
  const body = (caption ?? "").trim();
  const link = (destinationUrl ?? "").trim();
  if (!link) return body;
  return body ? `${body}\n\n${link}` : link;
}

/**
 * Publish a single image to an Instagram professional account.
 *
 * Two-step by design on Instagram's side: create a media CONTAINER, then publish
 * it. The container is processed asynchronously, so between the two we poll
 * status_code until it reports FINISHED — publishing an IN_PROGRESS container
 * fails. ERROR and EXPIRED are terminal and reported as such rather than retried.
 */
export async function publishToInstagram(input: InstagramPublishInput): Promise<InstagramPublishResult> {
  if (!isPubliclyFetchableImage(input.imageUrl)) {
    throw new InstagramApiError(
      "Image URL must be publicly reachable for Instagram to fetch it",
      400,
      "invalid_image_url",
    );
  }

  const caption = buildInstagramCaption(input.caption, input.destinationUrl);

  // 1 — create the container.
  const createBody = new URLSearchParams({
    image_url: input.imageUrl,
    access_token: input.accessToken,
  });
  if (caption) createBody.set("caption", caption);

  const createRes = await fetch(`${INSTAGRAM_GRAPH_URL}/${input.igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createBody.toString(),
  });
  const created = (await createRes.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string; code?: number };
  };
  if (!createRes.ok || !created.id) {
    throw new InstagramApiError(
      created.error?.message ?? "Instagram rejected the media container",
      createRes.status,
      "container_failed",
    );
  }
  const containerId = created.id;

  // 2 — wait for Instagram to finish fetching/processing the image.
  const DEADLINE_MS = 45_000;
  const POLL_MS = 2_000;
  const startedAt = Date.now();
  for (;;) {
    const statusRes = await fetch(
      `${INSTAGRAM_GRAPH_URL}/${containerId}?fields=status_code&access_token=${encodeURIComponent(input.accessToken)}`,
    );
    const status = (await statusRes.json().catch(() => ({}))) as { status_code?: string };
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new InstagramApiError(
        "Instagram could not process the image for this post",
        502,
        "container_processing_failed",
      );
    }
    if (Date.now() - startedAt > DEADLINE_MS) {
      throw new InstagramApiError(
        "Instagram is still processing the image — please try again",
        504,
        "container_timeout",
      );
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  // 3 — publish the finished container.
  const publishRes = await fetch(`${INSTAGRAM_GRAPH_URL}/${input.igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: containerId, access_token: input.accessToken }).toString(),
  });
  const publishedJson = (await publishRes.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };
  if (!publishRes.ok || !publishedJson.id) {
    throw new InstagramApiError(
      publishedJson.error?.message ?? "Instagram rejected the publish",
      publishRes.status,
      "publish_failed",
    );
  }

  // 4 — best-effort permalink. A missing permalink never fails a live post.
  let permalink: string | null = null;
  try {
    const permaRes = await fetch(
      `${INSTAGRAM_GRAPH_URL}/${publishedJson.id}?fields=permalink&access_token=${encodeURIComponent(input.accessToken)}`,
    );
    const perma = (await permaRes.json().catch(() => ({}))) as { permalink?: string };
    if (typeof perma.permalink === "string" && perma.permalink) permalink = perma.permalink;
  } catch {
    /* permalink is a nicety, not part of the publish contract */
  }

  return { mediaId: publishedJson.id, permalink };
}
