/**
 * Client-side helper for the internal /api/pinterest/* routes.
 *
 * Uses the Supabase SSR browser client (cookie session, same as login) to attach
 * `Authorization: Bearer <access token>` — matching the existing JSON API auth
 * convention. Tokens are never stored by this module; we read the live session
 * each call. The OAuth *connect* step is a plain browser navigation (see
 * startPinterestConnect) so the server can read the session cookie.
 */

import { invalidateBoardsCache } from "@/lib/pinterest/boardsCache";
import { invalidateConnectionsCache } from "@/lib/social/connectionsCache";
import { freshAccessToken, refreshSessionOnce } from "@/lib/supabaseBrowser";

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = await freshAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export type PinterestClientError = Error & {
  code?: string;
  needsReconnect?: boolean;
  /** Pinterest API's own code field (e.g. "2"), forwarded from the backend. */
  pinterestCode?: string;
  /** HTTP status from the internal API route (useful for fallback messages). */
  httpStatus?: number;
};

export type PinterestAccount = { id: string | null; username: string | null; accountType: string | null };
/** Where the "connected" signal comes from — only "db" is a real user connection. */
export type PinterestConnectionSource = "db" | "sandbox_demo" | "none";
export type PinterestStatus = {
  connected: boolean;
  account: PinterestAccount | null;
  scopes: string[];
  needsReconnect: boolean;
  /** Server-side connection updated_at when available. */
  lastSyncedAt?: string | null;
  /** Present when the server is in sandbox demo mode. Absent = production. */
  environment?: "sandbox" | "production";
  /**
   * "db" = active user connection record; "sandbox_demo" = no user connection but a
   * sandbox token unblocks publishing; "none" = nothing. The normal Settings UI must
   * only treat "db" as connected. Absent on older/production responses → fall back to
   * `connected`.
   */
  connectionSource?: PinterestConnectionSource;
  /** Which Pinterest environment the server targets. */
  apiEnv?: "sandbox" | "production";
};
export type PinterestBoard = { id: string; name: string; description?: string; privacy?: string };
export type PinterestDefaultBoard = { boardId: string; boardName: string | null };
export type PublishResult = {
  ok: true;
  pin: { id: string; url: string };
  board: { id: string; name: string };
  /** Which Pinterest environment the Pin was created in. Absent = production. */
  environment?: "sandbox" | "production";
  /** The connection this Pin published through — pinned onto the draft as its target
   *  when it had none yet (adopt-once, PRD §14). Absent in sandbox mode. */
  connectionId?: string;
};

function currentReturnTo(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export type PinterestConnectResult =
  | { ok: true; redirected: true }
  | { ok: false; code?: string; message: string };

const DEV = process.env.NODE_ENV !== "production";
const SLOW_STEP_MS = 500;

/** Reads the route's `Server-Timing` header (dev/staging only) and warns on any step over SLOW_STEP_MS. */
function warnOnSlowServerSteps(res: Response): void {
  const header = res.headers.get("Server-Timing");
  if (!header) return;
  for (const part of header.split(",")) {
    const match = part.trim().match(/^([\w-]+);dur=([\d.]+)$/);
    if (!match) continue;
    const dur = Number(match[2]);
    if (dur > SLOW_STEP_MS) {
      console.warn(`[Pinterest OAuth] slow server step "${match[1]}": ${dur.toFixed(1)}ms`);
    }
  }
}

/**
 * Begin OAuth by navigating the browser to Pinterest.
 *
 * Fires the connect request immediately with no pre-flight async work — no board
 * sync, no status refresh, no profile fetch, and (unlike other /api/pinterest/*
 * calls) no client-side session lookup either. This is a same-origin fetch, so the
 * Supabase SSR session cookie is already attached automatically; the server's
 * `resolveUserId` falls back to that cookie whenever no Bearer header is present.
 * That lets us skip `authHeaders()` (which awaits `auth.getSession()`) entirely on
 * this hot path and go straight to the network call.
 *
 * `reconnectConnectionId` declares "repair THIS connection" rather than "connect an
 * account". The callback needs it to tell a reconnect that landed on the wrong
 * Pinterest account (refuse — PRD §10) apart from an intentional second account
 * (accept). Omit it for Connect and for "Add another account".
 */
export async function startPinterestConnect(
  returnTo?: string,
  reconnectConnectionId?: string | null,
): Promise<PinterestConnectResult> {
  const next = returnTo ?? currentReturnTo();
  const tDirect = DEV ? performance.now() : 0;
  try {
    if (DEV) console.log(`[Pinterest OAuth Start] direct navigation assigned: ${(performance.now() - tDirect).toFixed(1)}ms`);
    const reconnectParam = reconnectConnectionId
      ? `&reconnect=${encodeURIComponent(reconnectConnectionId)}`
      : "";
    window.location.assign(`/api/auth/pinterest/connect?next=${encodeURIComponent(next)}${reconnectParam}`);
    return { ok: true, redirected: true };
  } catch {
    return { ok: false, message: "Could not open Pinterest authorization." };
  }
  // tClick is captured first thing: there is NO pre-work (no status/board/sync/
  // profile fetch) between the click and the OAuth-start request, so click->request
  // should always be ~0ms.
  const tClick = DEV ? performance.now() : 0;
  try {
    const tRequest = DEV ? performance.now() : 0;
    const res = await fetch("/api/auth/pinterest/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next }),
    });
    const tResponse = DEV ? performance.now() : 0;
    if (DEV) {
      const clickToRequest = tRequest - tClick;
      const requestToResponse = tResponse - tRequest;
      console.log(`[Pinterest OAuth Start] click -> request: ${clickToRequest.toFixed(1)}ms`);
      console.log(`[Pinterest OAuth Start] request -> response: ${requestToResponse.toFixed(1)}ms`);
      if (requestToResponse > SLOW_STEP_MS) {
        // In dev this is usually Next.js compiling the /api/auth/pinterest/connect
        // route on first hit, not real app latency — warm it once before recording.
        console.warn(`[Pinterest OAuth Start] slow step (request -> response ${requestToResponse.toFixed(1)}ms) — likely Next.js dev compile on first hit`);
      }
      warnOnSlowServerSteps(res);
    }
    let body: { url?: string; error?: string; code?: string } = {};
    try {
      body = await res.json() as { url?: string; error?: string; code?: string };
    } catch {
      /* non-JSON error page */
    }
    if (res.ok && body.url) {
      if (DEV) console.log(`[Pinterest OAuth Start] total: ${(performance.now() - tClick).toFixed(1)}ms`);
      window.location.assign(body.url ?? "");
      return { ok: true, redirected: true };
    }
    if (res.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return { ok: true, redirected: true };
    }
    const message = body.error ?? "";
    const code = body.code;
    // Only surface an error for definitive server-side config problems (PINTEREST_APP_ID etc.
    // missing). For all other failures — unexpected 5xx, no JSON body, etc. — fall through to
    // the cookie-based GET navigation below, which is more likely to succeed.
    if (code === "config_error" || code === "configuration_error") {
      return { ok: false, code, message: message || "Pinterest is not configured on the server. Check PINTEREST_APP_ID, PINTEREST_APP_SECRET, and PINTEREST_REDIRECT_URI in .env.local." };
    }
    // Any other non-ok response: try GET fallback (falls through to below).
  } catch {
    /* fall through to cookie navigation */
  }

  // Cookie-based GET navigation. Simpler auth path — works as long as the user has a
  // valid Supabase session cookie. On config or auth failure the server redirects to
  // the Integrations page with a status flag so the user sees a meaningful next step.
  try {
    if (DEV) console.log(`[Pinterest OAuth Start] total (GET fallback): ${(performance.now() - tClick).toFixed(1)}ms`);
    window.location.assign(`/api/auth/pinterest/connect?next=${encodeURIComponent(next)}`);
    return { ok: true, redirected: true };
  } catch {
    return { ok: false, message: "Could not open Pinterest authorization." };
  }
}

/** HTTP-status-based fallback messages shown when Pinterest returns no usable message. */
function statusFallback(status: number): string {
  if (status === 401) return "Pinterest connection expired. Please reconnect Pinterest.";
  if (status === 403) return "Pinterest did not allow this request. Your app may need Standard access or additional permissions.";
  if (status === 404) return "Pinterest could not find the selected board. Please refresh boards and choose again.";
  if (status === 429) return "Pinterest rate limit reached. Please try again later.";
  if (status >= 500) return "Pinterest is temporarily unavailable. Please try again later.";
  return "Couldn't reach Pinterest. Please check your connection and try again.";
}

type ParsedError = {
  message: string;
  code?: string;
  needsReconnect?: boolean;
  pinterestCode?: string;
  httpStatus: number;
};

async function parseErrorResponse(res: Response): Promise<ParsedError> {
  const httpStatus = res.status;
  try {
    const body = await res.json() as Record<string, unknown> | null;
    // Pinterest message comes through as body.error (our backend forwards it).
    // Use it when present; fall back to HTTP-status message.
    const bodyError = typeof body?.error === "string" && body.error ? body.error : null;
    return {
      message: bodyError ?? statusFallback(httpStatus),
      code: (typeof body?.code === "string" ? body.code : undefined) ?? (httpStatus === 409 ? "not_connected" : undefined),
      needsReconnect: body?.needsReconnect === true,
      pinterestCode: typeof body?.pinterestCode === "string" ? body.pinterestCode : undefined,
      httpStatus,
    };
  } catch {
    return {
      message: statusFallback(httpStatus),
      code: httpStatus === 409 ? "not_connected" : undefined,
      httpStatus,
    };
  }
}

function toClientError(body: ParsedError): PinterestClientError {
  const err = new Error(body.message) as PinterestClientError;
  err.code = body.code;
  err.needsReconnect = body.needsReconnect;
  err.pinterestCode = body.pinterestCode;
  err.httpStatus = body.httpStatus;
  return err;
}

function toNetworkClientError(message = "Pinterest request failed. Please try again."): PinterestClientError {
  const err = new Error(message) as PinterestClientError;
  err.code = "network_error";
  return err;
}

async function fetchPinterestApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    // Browser extensions and local network interruptions can throw a raw
    // TypeError("Failed to fetch"). Convert it to our typed client error so
    // callers can render an inline retry state instead of tripping Next's overlay.
    throw toNetworkClientError();
  }
}

/**
 * GET a Pinterest API route with a single automatic auth retry.
 *
 * This is what makes firing status + boards CONCURRENTLY safe right after an OAuth
 * return: if the very first request carries a just-expired Supabase token, the server
 * answers 401. Instead of surfacing that, we force ONE token refresh (via the same
 * single-flight refreshSessionOnce() every other caller shares — so this retry can
 * never itself race a concurrent refresh) and retry exactly once — never a loop. A 401
 * specifically means "auth token rejected" (a genuinely disconnected Pinterest account
 * comes back as 409/`not_connected`, which we do NOT retry). Any non-401 response is
 * returned untouched for the caller's normal handling.
 */
async function authedPinterestGet(path: string, signal?: AbortSignal): Promise<Response> {
  // First request MUST carry the Bearer token (authHeaders → freshAccessToken). Sending
  // it unauthenticated forced every call into a needless 401 → refresh → retry cycle,
  // and that refresh is exactly the step that can stall on the Supabase auth lock (→ the
  // 8s board-load timeout we were seeing). Authing up-front makes the first request
  // succeed outright; the retry below is only a fallback for a genuinely stale token.
  let res = await fetchPinterestApi(path, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    signal,
  });
  if (res.status === 401) {
    const token = await refreshSessionOnce();
    if (token) {
      res = await fetchPinterestApi(path, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal,
      });
    }
  }
  return res;
}

export async function fetchPinterestStatus(signal?: AbortSignal): Promise<PinterestStatus> {
  // no-store: after returning from OAuth we must read live connection state, never a
  // cached "disconnected" response from before the redirect. `signal` lets callers
  // enforce a timeout / cancel a superseded request (e.g. after Disconnect).
  const res = await authedPinterestGet("/api/pinterest/status", signal);
  if (!res.ok) throw toClientError(await parseErrorResponse(res));
  return res.json();
}

// ── Shared status read (single-flight + short TTL) ──────────────────────────
// Opening the publish flow mounts several surfaces (destinations list, details
// drawer, batch drawer) that each check status independently — each a full
// auth + DB round trip. Serve them one shared result instead. Staleness is
// bounded three ways: a fresh OAuth connect is a full page navigation (module
// state resets), disconnect invalidates below, and everything else ages out in
// STATUS_FRESH_MS. Freshness-critical surfaces (Settings panels) keep calling
// fetchPinterestStatus() directly.
const STATUS_FRESH_MS = 10_000;
let statusCacheEntry: { at: number; status: PinterestStatus } | null = null;
let statusInflight: Promise<PinterestStatus> | null = null;

export function invalidatePinterestStatusCache(): void {
  statusCacheEntry = null;
  statusInflight = null;
}

export async function fetchPinterestStatusCached(): Promise<PinterestStatus> {
  if (statusCacheEntry && Date.now() - statusCacheEntry.at < STATUS_FRESH_MS) {
    return statusCacheEntry.status;
  }
  if (!statusInflight) {
    statusInflight = fetchPinterestStatus()
      .then(status => {
        statusCacheEntry = { at: Date.now(), status };
        return status;
      })
      .finally(() => {
        statusInflight = null;
      });
  }
  return statusInflight;
}

/**
 * Optimistically seed the shared status cache as CONNECTED, then revalidate.
 *
 * Call ONLY on the `?pinterest=connected` OAuth return: the callback redirects
 * with that flag strictly AFTER the tokens are persisted, so "connected" is a
 * fact the client already knows — surfaces mounting right after the return
 * (destinations row, publish drawer) must not sit on "Checking…" or, worse,
 * flip to "Not connected" because the status round trip is slow through a
 * proxy. The account username is unknown here (left null); the real fetch
 * fired underneath replaces the seed as soon as it lands.
 */
export function seedPinterestStatusConnected(): void {
  statusCacheEntry = {
    at: Date.now(),
    status: { connected: true, account: null, scopes: [], needsReconnect: false, connectionSource: "db" },
  };
  statusInflight = fetchPinterestStatus()
    .then(status => {
      statusCacheEntry = { at: Date.now(), status };
      return status;
    })
    .finally(() => {
      statusInflight = null;
    });
  statusInflight.catch(() => {}); // background revalidation must never surface as unhandled
}

// `fetchPinterestDebugStatus` / `PinterestDebugStatus` were removed with the
// Developer tools section (PRD §7). /api/pinterest/debug-status still exists but is
// super-admin gated now — it is an operator tool, and no customer-facing client
// code may call it.

/**
 * Fire-and-forget profile enrichment. Call once after landing back from a
 * successful Pinterest OAuth connect (`?pinterest=connected`) so the account
 * username/type backfill happens in the background — the OAuth callback itself
 * intentionally skips this to keep the redirect fast. Never throws: a failure here
 * just means the display name stays a generic fallback until the next successful
 * sync, which never blocks publishing.
 */
export async function syncPinterestAccount(): Promise<boolean> {
  try {
    const res = await fetch("/api/pinterest/sync-account", { method: "POST", headers: await authHeaders() });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return !!body.ok;
  } catch {
    return false;
  }
}

// Single-flight for the FIRST boards page: right after an OAuth return the plan
// page's warm-up and the reopened drawer both ask for boards at once — share one
// request instead of hitting Pinterest twice. Only signal-less calls join the
// shared flight (a caller-supplied AbortSignal must never cancel someone else's
// request); bookmarked pages are unique and always fetch directly.
/** First-page coalescing is per TARGET account: two accounts have different boards, so
 *  they must never share one in-flight promise. Key "" = the default connection. */
const boardsFirstPageInflight = new Map<string, Promise<{ items: PinterestBoard[]; bookmark: string | null }>>();

/**
 * The user's Pinterest boards. `connectionId` names WHICH connected account to read from
 * (a Pin's publish target); omitted ⇒ the default connection, i.e. exactly what every
 * single-account user got before multi-account existed.
 */
export async function fetchPinterestBoards(bookmark?: string, signal?: AbortSignal, connectionId?: string): Promise<{ items: PinterestBoard[]; bookmark: string | null }> {
  if (!bookmark && !signal) {
    const key = connectionId ?? "";
    const inflight = boardsFirstPageInflight.get(key);
    if (inflight) return inflight;
    const started = fetchPinterestBoardsDirect(undefined, undefined, connectionId).finally(() => {
      boardsFirstPageInflight.delete(key);
    });
    boardsFirstPageInflight.set(key, started);
    return started;
  }
  return fetchPinterestBoardsDirect(bookmark, signal, connectionId);
}

export async function fetchPinterestDefaultBoard(signal?: AbortSignal, connectionId?: string): Promise<PinterestDefaultBoard | null> {
  const qs = connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : "";
  const res = await authedPinterestGet(`/api/pinterest/default-board${qs}`, signal);
  if (!res.ok) throw toClientError(await parseErrorResponse(res));
  const body = await res.json() as { board?: PinterestDefaultBoard | null };
  return body.board ?? null;
}

export async function savePinterestDefaultBoard(board: PinterestDefaultBoard, connectionId?: string): Promise<PinterestDefaultBoard | null> {
  const payload = JSON.stringify(connectionId ? { ...board, connectionId } : board);
  const res = await fetch("/api/pinterest/default-board", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  if (res.status === 401) {
    const token = await refreshSessionOnce();
    if (token) {
      const retry = await fetch("/api/pinterest/default-board", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: payload,
      });
      if (!retry.ok) throw toClientError(await parseErrorResponse(retry));
      const retryBody = await retry.json() as { board?: PinterestDefaultBoard | null };
      return retryBody.board ?? null;
    }
  }
  if (!res.ok) throw toClientError(await parseErrorResponse(res));
  const body = await res.json() as { board?: PinterestDefaultBoard | null };
  return body.board ?? null;
}

async function fetchPinterestBoardsDirect(bookmark?: string, signal?: AbortSignal, connectionId?: string): Promise<{ items: PinterestBoard[]; bookmark: string | null }> {
  const params = new URLSearchParams();
  if (bookmark) params.set("bookmark", bookmark);
  if (connectionId) params.set("connectionId", connectionId);
  const qs = params.toString() ? `?${params.toString()}` : "";
  // no-store + 401-retry-once (authedPinterestGet): always load the freshly-connected
  // account's real boards, and self-heal a just-expired token so firing this
  // concurrently with fetchPinterestStatus right after OAuth return can't 401-stick.
  const res = await authedPinterestGet(`/api/pinterest/boards${qs}`, signal);
  if (!res.ok) throw toClientError(await parseErrorResponse(res));
  return res.json();
}

/** VibePin-side product attachment (NOT a Pinterest product tag). */
export type AttachedProduct = {
  id: string;
  title: string;
  imageUrl?: string;
  productUrl?: string;
  sourceDomain?: string;
  price?: string;
};

export type PublishPinInput = {
  boardId: string;
  imageUrl: string;
  title?: string;
  description?: string;
  link?: string;
  altText?: string;
  sourcePinId?: string;
  // ── Server-side publish-event instrumentation (optional; never affects publish) ──
  /** pinDraftStore id this publish is for — lets publish events join back to the draft. */
  draftId?: string;
  /** Where the publish was initiated. Server defaults to "immediate" when omitted. */
  source?: "immediate" | "scheduled-cron";

  /** The Pin's pinned publish target (social_connections row id). Omitted ⇒ the server
   *  resolves the user's default connection and reports it back for adopt-once. */
  connectionId?: string;
  // ── VibePin-side commerce metadata (stored/used internally; never sent to the
  //    Pinterest API as official product tags) ──────────────────────────────────
  attachedProducts?: AttachedProduct[];
  primaryProductUrl?: string;
  productAttachmentMode?: "vibepin_metadata_v1";
};

export async function publishPin(input: PublishPinInput): Promise<PublishResult> {
  const body = JSON.stringify(input);
  let res = await fetch("/api/pinterest/pins", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (res.status === 401) {
    const token = await refreshSessionOnce();
    if (token) {
      res = await fetch("/api/pinterest/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
      });
    }
  }
  if (!res.ok) throw toClientError(await parseErrorResponse(res));
  return res.json() as Promise<PublishResult>;
}

/**
 * Sandbox-only: create a single demo board so the publish selector isn't empty.
 * Returns the created board. Throws a PinterestClientError (safe message) on failure.
 */
export async function createSandboxDemoBoard(): Promise<{ id: string; name: string }> {
  const res = await fetch("/api/pinterest/sandbox/create-demo-board", {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!res.ok) throw toClientError(await parseErrorResponse(res));
  const body = await res.json() as { board: { id: string; name: string } };
  return body.board;
}

/**
 * Fired on window right after a successful disconnect. Invalidating the shared
 * caches (above) only affects FUTURE reads — a surface that's already mounted (e.g.
 * an open Plan "Edit scheduled Pin" drawer sitting behind the Settings modal) holds
 * its own React state and has no reason to re-fetch on its own. Listeners
 * (PublishDestinations, DraftDetailsDrawer) use this to immediately drop their local
 * "connected" state and re-validate, so disconnecting in Settings is reflected live
 * in any other open surface without requiring it to be closed and reopened.
 */
export const PINTEREST_DISCONNECTED_EVENT = "vp:pinterest_disconnected";

/**
 * Disconnect Pinterest.
 *
 * `connectionId` narrows this to ONE account (the per-account Remove). Omitting it
 * keeps the original meaning — disconnect every live Pinterest connection — which is
 * what the platform-level "Disconnect" button has always done and still does.
 *
 * `cancelScheduled` un-schedules the Pins pinned to that account before removing it
 * (the "Cancel schedules" answer in the Remove dialog). Only meaningful together with
 * a connectionId; the "Keep" answer passes nothing, because a kept Pin is already
 * blocked at publish time by the `target_disconnected` retry reason.
 *
 * Both ride in the query string: DELETE request bodies are unreliable across proxies
 * and fetch implementations.
 */
export async function disconnectPinterest(
  connectionId?: string | null,
  opts?: { cancelScheduled?: boolean },
): Promise<void> {
  const params = new URLSearchParams();
  const id = typeof connectionId === "string" ? connectionId.trim() : "";
  if (id) params.set("connectionId", id);
  if (id && opts?.cancelScheduled) params.set("cancelScheduled", "1");
  const qs = params.toString();

  // keepalive: callers are optimistic (UI flips before this settles) — the request
  // must survive the user immediately navigating away from Settings.
  const res = await fetch(`/api/pinterest/disconnect${qs ? `?${qs}` : ""}`, { method: "DELETE", headers: await authHeaders(), keepalive: true });
  if (!res.ok) throw toClientError(await parseErrorResponse(res));
  invalidateBoardsCache();
  invalidateConnectionsCache();
  invalidatePinterestStatusCache();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PINTEREST_DISCONNECTED_EVENT));
}

/**
 * How many Pins are still scheduled to publish through this connection — asked before
 * a per-account Remove so the user is never silently stripped of pending work.
 *
 * Read-only and best-effort: a failure here answers 0 rather than blocking the Remove.
 * The consequence of a wrong 0 is a missing prompt, not a lost Pin (Phase C still
 * blocks publishing to a disconnected target).
 */
export async function getScheduledCountForConnection(connectionId: string): Promise<number> {
  const id = connectionId.trim();
  if (!id) return 0;
  try {
    const res = await fetch(
      `/api/pinterest/disconnect?connectionId=${encodeURIComponent(id)}`,
      { headers: await authHeaders() },
    );
    if (!res.ok) return 0;
    const body = await res.json() as { scheduledCount?: number };
    return typeof body.scheduledCount === "number" && body.scheduledCount > 0 ? body.scheduledCount : 0;
  } catch {
    return 0;
  }
}
