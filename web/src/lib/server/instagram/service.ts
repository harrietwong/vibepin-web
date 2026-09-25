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
  permissions?: unknown;
  data?: unknown;
  error_type?: string;
  error_message?: string;
  error?: { message?: string; type?: string; code?: number } | string;
};

/**
 * Parse the granted-permissions field of the short-lived token exchange into a
 * deduped, trimmed list of scope strings.
 *
 * The exact shape of Instagram's response for this field is UNVERIFIED — Meta's
 * docs describe `{"data":[{"access_token","user_id","permissions":"a,b,c"}]}`, but
 * our code reads access_token/user_id at the TOP level (and that works), which
 * means the real response is flat and the real type/presence of `permissions` is
 * unknown. This function is defensive: it accepts every shape we can think of so a
 * format we haven't seen degrades to an empty list instead of throwing.
 *
 * Accepted shapes for the `permissions`-bearing value:
 *   - a comma-separated string ("instagram_business_basic,instagram_..._comments")
 *   - a string array (["instagram_business_basic", ...])
 *   - an object array ([{ permission: "...", status: "granted" }, ...] or
 *     [{ name: "...", status: "declined" }, ...]) — entries whose status is
 *     "declined" (case-insensitive) are excluded; entries without a status are kept
 */
export function parseGrantedPermissions(raw: unknown): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const trimmed = v.trim();
    if (trimmed) out.add(trimmed);
  };

  const collect = (value: unknown) => {
    if (typeof value === "string") {
      for (const part of value.split(",")) add(part);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          add(entry);
        } else if (entry && typeof entry === "object") {
          const status = (entry as { status?: unknown }).status;
          const declined = typeof status === "string" && status.trim().toLowerCase() === "declined";
          if (declined) continue;
          const name = (entry as { permission?: unknown; name?: unknown }).permission
            ?? (entry as { permission?: unknown; name?: unknown }).name;
          add(name);
        }
      }
    }
  };

  collect(raw);
  return Array.from(out);
}

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

  // Some responses may wrap the fields in `data: [{...}]` (Meta's documented shape)
  // instead of putting them at the top level. Top-level values take priority;
  // data[0] is only a fallback when the top-level field is absent.
  const dataWrapper = Array.isArray((shortJson as { data?: unknown }).data)
    ? ((shortJson as { data?: unknown[] }).data?.[0] as Record<string, unknown> | undefined)
    : undefined;
  const hasDataWrapper = dataWrapper !== undefined;

  const accessToken = shortJson.access_token ?? (dataWrapper?.access_token as string | undefined);
  const rawUserId = shortJson.user_id !== undefined && shortJson.user_id !== null
    ? shortJson.user_id
    : (dataWrapper?.user_id as number | string | undefined);

  if (!shortRes.ok || !accessToken || rawUserId === undefined || rawUserId === null) {
    // Never echo the body/params (contains secret + code).
    throw new InstagramApiError(
      extractError(shortJson as Record<string, unknown>) || `Instagram token request failed (${shortRes.status})`,
      shortRes.ok ? 400 : shortRes.status,
      "token_exchange_failed",
    );
  }
  const shortToken = accessToken;
  const userId = String(rawUserId);
  // Instagram returns the actually-granted permissions on the short-lived exchange.
  // The real shape of this field is unverified in production — see
  // parseGrantedPermissions for the shapes we defensively accept.
  const rawPermissions = shortJson.permissions !== undefined ? shortJson.permissions : dataWrapper?.permissions;
  const granted = parseGrantedPermissions(rawPermissions);
  if (granted.length === 0) {
    // Diagnostic only — never logs the token/code/secret. Helps confirm the real
    // response shape in production without guessing.
    console.warn(
      `[instagram/service] exchangeCodeForTokens: no granted permissions parsed ` +
      `(typeof permissions=${typeof rawPermissions}, dataWrapper=${hasDataWrapper})`,
    );
  }

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

export type InstagramRecentMedia = {
  id: string;
  permalink: string | null;
  caption: string | null;
  timestamp: string | null;
  mediaType: string | null;
};

/**
 * Read recent media for delivery reconciliation. Credentials are used only for
 * the upstream request and are never included in the returned evidence.
 */
export async function fetchRecentInstagramMedia(input: {
  accessToken: string;
  igUserId: string;
  since: string;
  limit?: number;
}): Promise<InstagramRecentMedia[]> {
  const sinceMs = Date.parse(input.since);
  if (!Number.isFinite(sinceMs)) {
    throw new InstagramApiError("Invalid reconciliation timestamp", 400, "invalid_since");
  }
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 25)));
  const params = new URLSearchParams({
    fields: "id,permalink,caption,timestamp,media_type",
    limit: String(limit),
    access_token: input.accessToken,
  });
  const res = await fetch(`${INSTAGRAM_GRAPH_URL}/${encodeURIComponent(input.igUserId)}/media?${params.toString()}`, {
    method: "GET",
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: Array<{
      id?: unknown;
      permalink?: unknown;
      caption?: unknown;
      timestamp?: unknown;
      media_type?: unknown;
    }>;
  } & Record<string, unknown>;
  if (!res.ok) {
    throw new InstagramApiError(
      extractError(json) || `Instagram media request failed (${res.status})`,
      res.status,
      "media_fetch_failed",
    );
  }

  return (Array.isArray(json.data) ? json.data : [])
    .filter(item => typeof item.id === "string" && item.id.length > 0)
    .filter(item => typeof item.timestamp === "string" && Date.parse(item.timestamp) >= sinceMs)
    .map(item => ({
      id: item.id as string,
      permalink: typeof item.permalink === "string" ? item.permalink : null,
      caption: typeof item.caption === "string" ? item.caption : null,
      timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
      mediaType: typeof item.media_type === "string" ? item.media_type : null,
    }));
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
  /** The cover image. Also the whole post when `imageUrls` is absent or has one entry. */
  imageUrl?: string;
  /**
   * The full media set in display order (cover first). ≥2 entries publish a real
   * Instagram CAROUSEL; 1 or absent keeps the single-image request byte-for-byte as
   * before. Count limits are the caller's (checkInstagramMedia) — nothing is dropped here.
   */
  imageUrls?: string[];
  /** A single Instagram Reel video. Video and image inputs are mutually exclusive. */
  videoUrl?: string;
  caption?: string;
  /**
   * Destination URL. Instagram captions render links as plain text — they are
   * NOT clickable — but dropping the link entirely would silently lose the
   * merchant's traffic path, so it is appended to the caption where a reader can
   * still see and copy it.
   */
  destinationUrl?: string;
};

export type InstagramPublishResult = {
  mediaId: string;
  permalink: string | null;
  /** Observed successful Graph API status; durable callers require a 2xx receipt. */
  providerStatus: number;
  /** Correlates the UI, the logs, and this publish. Safe to display. */
  traceId: string;
};

/**
 * Non-production publish diagnostic. Records the shape of the attempt — status
 * codes, ids, the image HOST (never the full signed URL) — so a failed publish
 * can be traced end to end. Never logs the token, the secret, or the caption
 * body.
 */
function igPublishDebug(record: Record<string, unknown>): void {
  if (process.env.VERCEL_ENV === "production") return;
  console.log("[instagram-publish]", JSON.stringify(record));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

/** Compose the caption Instagram will show; destination URLs are intentionally omitted. */
export function buildInstagramCaption(caption?: string, destinationUrl?: string): string {
  const body = (caption ?? "").trim();
  // Instagram captions do not make destination URLs clickable. More importantly,
  // this provider contract deliberately never copies a destination URL into a
  // social caption: the destination remains available to Pinterest only.
  void destinationUrl;
  return body;
}

/**
 * How long ALL container processing for one publish may take, and how often we ask.
 *
 * ONE shared budget, not one per container: a 10-item carousel polled sequentially
 * at 45s each would allow 450s of waiting, which overruns the cron route's
 * maxDuration (300s) and would kill the whole due-publish batch mid-run.
 */
const CONTAINER_DEADLINE_MS = 45_000;
const REEL_CONTAINER_DEADLINE_MS = 120_000;
const CONTAINER_POLL_MS = 2_000;

/** POST /{ig-user-id}/media with the given fields. Returns the container id. */
async function createContainer(
  accessToken: string,
  igUserId: string,
  fields: Record<string, string>,
): Promise<string> {
  const body = new URLSearchParams({ ...fields, access_token: accessToken });
  const res = await fetch(`${INSTAGRAM_GRAPH_URL}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const created = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string; code?: number };
  };
  if (!res.ok || !created.id) {
    throw new InstagramApiError(
      created.error?.message ?? "Instagram rejected the media container",
      res.status,
      "container_failed",
    );
  }
  return created.id;
}

/**
 * Poll every container until each reports FINISHED, against ONE shared deadline.
 *
 * Instagram processes containers asynchronously and refuses to publish (or to
 * accept as a carousel child) anything not yet FINISHED. ERROR and EXPIRED are
 * terminal — reported, never retried. `deadlineAt` is an absolute instant so the
 * children and the carousel container share a single budget.
 */
async function awaitContainersReady(
  accessToken: string,
  containerIds: readonly string[],
  deadlineAt: number,
  traceId: string,
): Promise<void> {
  const pending = new Set(containerIds);
  for (;;) {
    if (Date.now() > deadlineAt) {
      throw new InstagramApiError(
        "Instagram is still processing the media — please try again",
        504,
        "container_timeout",
      );
    }
    for (const containerId of [...pending]) {
      const statusRes = await fetch(
        `${INSTAGRAM_GRAPH_URL}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
      );
      const status = (await statusRes.json().catch(() => ({}))) as { status_code?: string };
      // A response that arrived after the shared deadline is not safe to publish:
      // the route budget has already expired and a late success must not turn into
      // an untracked provider delivery.
      if (status.status_code === "FINISHED" && Date.now() <= deadlineAt) {
        igPublishDebug({ traceId, containerId, finalContainerStatus: "FINISHED" });
        pending.delete(containerId);
        continue;
      }
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        igPublishDebug({ traceId, containerId, finalContainerStatus: status.status_code });
        throw new InstagramApiError(
          "Instagram could not process the image for this post",
          502,
          "container_processing_failed",
        );
      }
    }
    if (pending.size === 0) return;
    if (Date.now() > deadlineAt) {
      throw new InstagramApiError(
        "Instagram is still processing the image — please try again",
        504,
        "container_timeout",
      );
    }
    await new Promise(r => setTimeout(r, CONTAINER_POLL_MS));
  }
}

/** The unchanged single-image flow: one container carrying the caption. */
async function createSingleImageContainer(
  accessToken: string,
  igUserId: string,
  imageUrl: string,
  caption: string,
  traceId: string,
): Promise<string> {
  const containerId = await createContainer(accessToken, igUserId, {
    image_url: imageUrl,
    ...(caption ? { caption } : {}),
  });
  igPublishDebug({ traceId, igUserId, imageHost: hostOf(imageUrl), containerId });
  await awaitContainersReady(accessToken, [containerId], Date.now() + CONTAINER_DEADLINE_MS, traceId);
  return containerId;
}

async function createReelContainer(
  accessToken: string,
  igUserId: string,
  videoUrl: string,
  caption: string,
  traceId: string,
): Promise<string> {
  const containerId = await createContainer(accessToken, igUserId, {
    media_type: "REELS",
    video_url: videoUrl,
    ...(caption ? { caption } : {}),
  });
  igPublishDebug({ traceId, igUserId, videoHost: hostOf(videoUrl), containerId });
  await awaitContainersReady(accessToken, [containerId], Date.now() + REEL_CONTAINER_DEADLINE_MS, traceId);
  return containerId;
}

/**
 * Build the CAROUSEL container for a 2–10 image post.
 *
 * Instagram's shape, in order:
 *   1. one child container per image — `is_carousel_item=true`, NO caption (a
 *      child's caption is never shown; the caption belongs to the carousel);
 *   2. every child must be FINISHED before step 3 — an unready child is rejected
 *      as a carousel member, so all children are awaited under one shared deadline;
 *   3. the carousel container — media_type=CAROUSEL, children=<ids in order>,
 *      caption — which itself processes asynchronously and is awaited too.
 *
 * Children are created in the SAME order as the URLs: that order is the slide
 * order the merchant sees, and Instagram honours the `children` sequence.
 */
async function createCarouselContainer(
  accessToken: string,
  igUserId: string,
  imageUrls: readonly string[],
  caption: string,
  traceId: string,
): Promise<string> {
  const deadlineAt = Date.now() + CONTAINER_DEADLINE_MS;

  const childIds: string[] = [];
  for (const url of imageUrls) {
    childIds.push(await createContainer(accessToken, igUserId, {
      image_url: url,
      is_carousel_item: "true",
    }));
  }
  igPublishDebug({
    traceId,
    igUserId,
    carouselItems: imageUrls.length,
    imageHosts: imageUrls.map(hostOf),
    childContainerIds: childIds,
  });

  await awaitContainersReady(accessToken, childIds, deadlineAt, traceId);

  const carouselId = await createContainer(accessToken, igUserId, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    ...(caption ? { caption } : {}),
  });
  igPublishDebug({ traceId, igUserId, carouselContainerId: carouselId });

  // The carousel container is processed asynchronously too — publishing it before
  // it is FINISHED fails exactly the way an unready single-image container does.
  await awaitContainersReady(accessToken, [carouselId], deadlineAt, traceId);
  return carouselId;
}

/**
 * Publish an image post — one image, or a 2–10 image CAROUSEL — to an Instagram
 * professional account.
 *
 * Two-step by design on Instagram's side: create a media CONTAINER, then publish
 * it. The container is processed asynchronously, so between the two we poll
 * status_code until it reports FINISHED — publishing an IN_PROGRESS container
 * fails. ERROR and EXPIRED are terminal and reported as such rather than retried.
 */
export async function publishToInstagram(input: InstagramPublishInput): Promise<InstagramPublishResult> {
  const videoUrl = input.videoUrl?.trim() || "";
  const imageUrls = input.imageUrls?.filter(url => typeof url === "string" && url.trim()) ?? [];
  const legacyImageUrl = input.imageUrl?.trim() || "";
  if (videoUrl && (imageUrls.length || legacyImageUrl)) {
    throw new InstagramApiError("Instagram Reels cannot mix video and images", 400, "mixed_media");
  }
  if (videoUrl && !isPubliclyFetchableImage(videoUrl)) {
    throw new InstagramApiError("Video URL must be publicly reachable for Instagram to fetch it", 400, "invalid_video_url");
  }
  if (videoUrl) {
    const traceId = (globalThis.crypto?.randomUUID?.() ?? String(Date.now())).slice(0, 8);
    const caption = buildInstagramCaption(input.caption, input.destinationUrl);
    let containerId: string;
    try {
      containerId = await createReelContainer(input.accessToken, input.igUserId, videoUrl, caption, traceId);
    } catch (error) {
      // Never expose Meta's message: it may echo the provider URL, including a
      // signed token. Persist only this stable, token-free outcome.
      if (error instanceof InstagramApiError && error.code === "container_timeout") throw error;
      throw new InstagramApiError("Instagram could not prepare this Reel", 502, "container_failed");
    }
    let publishRes: Response;
    try {
      publishRes = await fetch(`${INSTAGRAM_GRAPH_URL}/${input.igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: containerId, access_token: input.accessToken }).toString(),
      });
    } catch {
      throw new InstagramApiError("Could not publish this Reel to Instagram", 502, "publish_failed");
    }
    const publishedJson = (await publishRes.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!publishRes.ok || !publishedJson.id) {
      throw new InstagramApiError("Instagram rejected this Reel", publishRes.status, "publish_failed");
    }
    let permalink: string | null = null;
    try {
      const permaRes = await fetch(`${INSTAGRAM_GRAPH_URL}/${publishedJson.id}?fields=permalink&access_token=${encodeURIComponent(input.accessToken)}`);
      const perma = (await permaRes.json().catch(() => ({}))) as { permalink?: string };
      if (typeof perma.permalink === "string" && perma.permalink) permalink = perma.permalink;
    } catch { /* permalink is best effort */ }
    igPublishDebug({ traceId, igUserId: input.igUserId, mediaId: publishedJson.id, permalinkResolved: permalink !== null });
    return { mediaId: publishedJson.id, permalink, providerStatus: publishRes.status, traceId };
  }
  // The media set in display order; `imageUrl` remains the single-image contract.
  const urls = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];
  if (!urls.length) {
    throw new InstagramApiError("Instagram posts need an image", 400, "missing_image");
  }
  for (const url of urls) {
    if (!isPubliclyFetchableImage(url)) {
      throw new InstagramApiError(
        "Image URL must be publicly reachable for Instagram to fetch it",
        400,
        "invalid_image_url",
      );
    }
  }

  const traceId = (globalThis.crypto?.randomUUID?.() ?? String(Date.now())).slice(0, 8);
  const caption = buildInstagramCaption(input.caption, input.destinationUrl);

  const containerId = urls.length > 1
    ? await createCarouselContainer(input.accessToken, input.igUserId, urls, caption, traceId)
    : await createSingleImageContainer(input.accessToken, input.igUserId, urls[0], caption, traceId);

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

  igPublishDebug({
    traceId,
    igUserId: input.igUserId,
    mediaId: publishedJson.id,
    permalinkResolved: permalink !== null,
  });

  return { mediaId: publishedJson.id, permalink, providerStatus: publishRes.status, traceId };
}
