/**
 * Centralized Pinterest API client (server-only). The ONLY place that issues raw
 * Pinterest HTTP calls — route handlers and components never fetch Pinterest
 * directly.
 *
 * Responsibilities:
 *   - OAuth token exchange + refresh (Basic-auth token endpoint).
 *   - Authenticated v5 calls with Bearer access token.
 *   - Transparent refresh-before-expiry, plus one refresh+retry on a 401.
 *   - Persisting rotated access/refresh tokens and expiries after refresh.
 *   - Marking the connection as needs_reconnect when refresh permanently fails.
 *
 * Errors never include credentials. Tokens are never logged.
 */

import {
  PINTEREST_TOKEN_URL,
  basicAuthHeader,
  getPinterestApiBase,
  getPinterestEnv,
  getPinterestSandboxAccessToken,
  canAttemptSandboxPublish,
  missingPinterestScopes,
  type PinterestEnv,
} from "./config";
import {
  getActiveConnection,
  decryptTokens,
  updateTokens,
  markNeedsReconnect,
  type PinterestConnectionRow,
} from "./connectionStore";

// ── Errors ──────────────────────────────────────────────────────────────────

export class PinterestApiError extends Error {
  status: number;
  code: string;
  /** Pinterest API's own code field (numeric string like "2"), when present. Never a VibePin code. */
  pinterestApiCode?: string;
  constructor(message: string, status: number, code = "pinterest_error", pinterestApiCode?: string) {
    super(message);
    this.name = "PinterestApiError";
    this.status = status;
    this.code = code;
    this.pinterestApiCode = pinterestApiCode;
  }
}

/** Thrown when the connection can no longer be used and the user must re-auth. */
export class NeedsReconnectError extends PinterestApiError {
  constructor(message = "Pinterest connection expired — please reconnect") {
    super(message, 401, "needs_reconnect");
    this.name = "NeedsReconnectError";
  }
}

export class MissingPinterestScopesError extends NeedsReconnectError {
  missingScopes: string[];
  constructor(missingScopes: string[]) {
    super(
      `Pinterest needs reconnecting to grant the required publish permissions. Missing scopes: ${missingScopes.join(", ")}`,
    );
    this.name = "MissingPinterestScopesError";
    this.missingScopes = missingScopes;
  }
}

export class NotConnectedError extends PinterestApiError {
  constructor(message = "Pinterest account is not connected") {
    super(message, 409, "not_connected");
    this.name = "NotConnectedError";
  }
}

export class PinterestTrialAccessError extends PinterestApiError {
  constructor() {
    super(
      "Pinterest app is in Trial access, so Pinterest blocks production Pin creation. Use the Pinterest API sandbox for testing or request production access in the Pinterest Developer portal.",
      403,
      "pinterest_trial_access",
    );
    this.name = "PinterestTrialAccessError";
  }
}

// ── Token exchange / refresh ──────────────────────────────────────────────────

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
};

type RawTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

function expiryFromNow(seconds: number | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseTokenResponse(raw: RawTokenResponse): TokenSet {
  if (!raw.access_token) {
    throw new PinterestApiError(
      raw.error_description || raw.error || "Token endpoint returned no access token",
      400,
      "token_exchange_failed",
    );
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    accessTokenExpiresAt: expiryFromNow(raw.expires_in),
    refreshTokenExpiresAt: expiryFromNow(raw.refresh_token_expires_in),
    scopes: raw.scope ? raw.scope.split(/[\s,]+/).filter(Boolean) : [],
  };
}

async function postToken(env: PinterestEnv, body: URLSearchParams): Promise<RawTokenResponse> {
  const res = await fetch(PINTEREST_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as RawTokenResponse;
  if (!res.ok) {
    // Surface a safe message; never echo the request body (contains code/secret).
    throw new PinterestApiError(
      json.error_description || json.error || `Token request failed (${res.status})`,
      res.status,
      "token_exchange_failed",
    );
  }
  return json;
}

/** Exchange an authorization code for tokens (server-side, Basic auth). */
export async function exchangeCodeForTokens(code: string): Promise<TokenSet> {
  const env = getPinterestEnv();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.redirectUri,
  });
  return parseTokenResponse(await postToken(env, body));
}

/** Refresh an access token using a stored refresh token. */
export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const env = getPinterestEnv();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return parseTokenResponse(await postToken(env, body));
}

// ── Authenticated client (bound to a user) ────────────────────────────────────

export type PinterestUser = {
  id: string | null;
  username: string | null;
  accountType: string | null;
};

export type PinterestBoard = {
  id: string;
  name: string;
  description?: string;
  privacy?: string;
};

export type CreatePinInput = {
  boardId: string;
  title?: string;
  description?: string;
  link?: string;
  altText?: string;
  imageUrl: string;
};

export type CreatedPin = {
  id: string;
  boardId: string;
  url: string;
};

const REFRESH_SKEW_MS = 60_000; // refresh if the access token expires within 60s

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Injectable seams (production defaults). Overridable only via forTest(). */
type ClientHooks = {
  fetchImpl: FetchLike;
  refreshFn: (refreshToken: string) => Promise<TokenSet>;
  persistTokens: (uid: string, t: {
    accessToken: string; refreshToken: string | null;
    accessTokenExpiresAt: string | null; refreshTokenExpiresAt: string | null;
  }, expectedVersion?: number) => Promise<{ applied: boolean }>;
  markReconnect: (uid: string) => Promise<void>;
  /** Re-read the persisted connection — used after a lost refresh CAS to adopt the
   *  tokens another instance just rotated in, instead of failing. */
  reloadConnection: (uid: string) => Promise<ReloadedConnection | null>;
};

/** What a re-read of the connection yields for adopting another instance's refresh. */
type ReloadedConnection = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: string | null;
  tokenVersion: number;
};

async function reloadConnectionTokens(uid: string): Promise<ReloadedConnection | null> {
  const row = await getActiveConnection(uid);
  if (!row || !row.access_token_encrypted) return null;
  const t = decryptTokens(row);
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresAt: t.accessTokenExpiresAt,
    tokenVersion: row.token_version,
  };
}

const DEFAULT_HOOKS: ClientHooks = {
  fetchImpl: (input, init) => fetch(input, init),
  refreshFn: refreshAccessToken,
  persistTokens: updateTokens,
  markReconnect: markNeedsReconnect,
  reloadConnection: reloadConnectionTokens,
};

/** The refreshed token values a single refresh produced, shared by coalesced callers. */
type RefreshResult = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: string | null;
  tokenVersion: number;
};

// ── Concurrent-refresh coalescing ─────────────────────────────────────────────
// Pinterest rotates the refresh token on every refresh: the OLD refresh token is
// invalidated the moment a new one is issued. If two requests for the same user
// refresh concurrently, the second would send an already-consumed refresh token
// (invalid_grant → false needs_reconnect) or clobber the newer token with an older
// persist. We coalesce concurrent refreshes for the same user onto ONE shared
// in-flight refresh so exactly one token exchange + one atomic persist happens; all
// callers then adopt the same fresh tokens. The entry clears when the refresh
// settles, so a later, genuinely-needed refresh still runs.
const _refreshInFlight = new Map<string, Promise<RefreshResult>>();

export class PinterestClient {
  private uid: string;
  private row: PinterestConnectionRow;
  private accessToken: string;
  private refreshToken: string | null;
  private accessExpiresAt: string | null;
  /** token_version at the time this client last read/refreshed — the CAS baseline. */
  private tokenVersion: number;
  private hooks: ClientHooks;
  /** Whether this client coalesces refresh via the shared per-user lock (prod: yes). */
  private shareRefresh: boolean;

  private constructor(uid: string, row: PinterestConnectionRow, hooks: ClientHooks = DEFAULT_HOOKS) {
    this.uid = uid;
    this.row = row;
    this.hooks = hooks;
    this.shareRefresh = hooks === DEFAULT_HOOKS;
    const t = decryptTokens(row);
    this.accessToken = t.accessToken;
    this.refreshToken = t.refreshToken;
    this.accessExpiresAt = t.accessTokenExpiresAt;
    this.tokenVersion = row.token_version;
  }

  /** Build a client for a user, or throw NotConnectedError. */
  static async forUser(uid: string): Promise<PinterestClient> {
    const row = await getActiveConnection(uid);
    if (!row || !row.access_token_encrypted) throw new NotConnectedError();
    if (row.needs_reconnect) throw new NeedsReconnectError();
    const missingScopes = missingPinterestScopes(row.scopes);
    if (missingScopes.length) {
      await markNeedsReconnect(uid);
      throw new MissingPinterestScopesError(missingScopes);
    }
    return new PinterestClient(uid, row);
  }

  /**
   * Explicit sandbox-demo client. This is intentionally NOT used by forUser():
   * disconnecting a real Pinterest account must make boards/publish unavailable.
   */
  static async forSandboxDemo(uid: string): Promise<PinterestClient> {
    if (!canAttemptSandboxPublish()) throw new NotConnectedError();
    const sandboxToken = getPinterestSandboxAccessToken();
    if (!sandboxToken) throw new NotConnectedError();
    return PinterestClient.forTest({
      uid,
      accessToken: sandboxToken,
      refreshToken: null,
      accessExpiresAt: null,
    });
  }

  /**
   * Client for READ operations (boards / profile). Behaves like forUser(), but when
   * there is no real user connection AND sandbox mode is available it falls back to
   * the sandbox client. This keeps board reads consistent with /api/pinterest/status,
   * which reports "connected" via the sandbox_demo fallback in exactly that state —
   * otherwise Plan shows "connected" while Create Pins shows "not connected" (409).
   *
   * Only a genuine NotConnectedError (no stored connection) falls back; a real
   * connection that needs_reconnect or is missing scopes still surfaces its error.
   */
  static async forReading(uid: string): Promise<PinterestClient> {
    try {
      return await PinterestClient.forUser(uid);
    } catch (err) {
      if (err instanceof NotConnectedError && canAttemptSandboxPublish()) {
        return PinterestClient.forSandboxDemo(uid);
      }
      throw err;
    }
  }

  /**
   * Test-only factory: builds a client with explicit tokens and injectable
   * hooks (no DB / no decryption). Not used in production code paths.
   */
  static forTest(opts: {
    uid?: string;
    accessToken: string;
    refreshToken?: string | null;
    accessExpiresAt?: string | null;
    hooks?: Partial<ClientHooks>;
    /** Opt into the shared per-user refresh lock (default false for test isolation). */
    shareRefresh?: boolean;
  }): PinterestClient {
    const c = Object.create(PinterestClient.prototype) as PinterestClient;
    c.uid = opts.uid ?? "test-user";
    c.row = {} as PinterestConnectionRow;
    c.accessToken = opts.accessToken;
    c.refreshToken = opts.refreshToken ?? null;
    c.accessExpiresAt = opts.accessExpiresAt ?? null;
    c.tokenVersion = 0;
    c.hooks = { ...DEFAULT_HOOKS, ...(opts.hooks ?? {}) };
    c.shareRefresh = opts.shareRefresh ?? false;
    return c;
  }

  private isExpiringSoon(): boolean {
    if (!this.accessExpiresAt) return false;
    return new Date(this.accessExpiresAt).getTime() - Date.now() <= REFRESH_SKEW_MS;
  }

  /**
   * Refresh tokens and persist, coalescing concurrent refreshes for the same user.
   * Marks needs_reconnect + throws on permanent failure. After a successful refresh
   * this client adopts the shared fresh tokens (whether it ran the refresh or waited
   * on another request's).
   */
  private async doRefresh(): Promise<void> {
    if (!this.refreshToken) {
      await this.hooks.markReconnect(this.uid);
      throw new NeedsReconnectError();
    }

    // Only coalesce the real, shared refresh path. Injected test hooks stay
    // per-instance so unit tests keep deterministic call counts, unless a test opts
    // in via forTest({ shareRefresh: true }).
    const shareable = this.shareRefresh;
    let promise = shareable ? _refreshInFlight.get(this.uid) : undefined;
    if (!promise) {
      promise = this.performRefresh(this.refreshToken);
      if (shareable) {
        _refreshInFlight.set(this.uid, promise);
        // Clear the entry once settled so a later needed refresh can run again.
        promise.finally(() => {
          if (_refreshInFlight.get(this.uid) === promise) _refreshInFlight.delete(this.uid);
        }).catch(() => {});
      }
    }

    const result = await promise;
    // Adopt the shared fresh tokens (and the new CAS baseline) onto this instance.
    this.accessToken = result.accessToken;
    this.refreshToken = result.refreshToken ?? this.refreshToken;
    this.accessExpiresAt = result.accessExpiresAt;
    this.tokenVersion = result.tokenVersion;
  }

  /**
   * Perform ONE token exchange and persist the rotated tokens atomically. The new
   * access token, rotated refresh token, and expiry are written in a single
   * updateTokens() call so a reader never sees a half-updated pair. On a 4xx
   * (e.g. invalid_grant) marks the connection needs_reconnect and throws.
   */
  private async performRefresh(refreshToken: string): Promise<RefreshResult> {
    const baseVersion = this.tokenVersion;
    let next: TokenSet;
    try {
      next = await this.hooks.refreshFn(refreshToken);
    } catch (err) {
      const status = err instanceof PinterestApiError ? err.status : 500;
      if (status >= 400 && status < 500) {
        // invalid_grant can mean the token is truly dead — OR that another instance
        // rotated it out from under us (cross-instance race). Re-read first: if the
        // stored version has moved past ours, someone else refreshed successfully;
        // adopt their tokens rather than falsely marking needs_reconnect.
        const reloaded = await this.hooks.reloadConnection(this.uid);
        if (reloaded && reloaded.tokenVersion > baseVersion) {
          return { ...reloaded };
        }
        await this.hooks.markReconnect(this.uid);
        throw new NeedsReconnectError();
      }
      throw err;
    }

    // Compare-and-swap persist: write only while token_version is still ours, then
    // bump it. This is the cross-instance mutex the in-process Map can't provide.
    const { applied } = await this.hooks.persistTokens(this.uid, {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      accessTokenExpiresAt: next.accessTokenExpiresAt,
      refreshTokenExpiresAt: next.refreshTokenExpiresAt,
    }, baseVersion);

    if (!applied) {
      // Lost the race: another instance persisted a newer refresh between our read and
      // write. Our `next` tokens may already be invalidated by Pinterest's rotation, so
      // discard them and adopt whatever is now stored.
      const reloaded = await this.hooks.reloadConnection(this.uid);
      if (reloaded) return { ...reloaded };
      // No connection to reload → genuinely gone.
      await this.hooks.markReconnect(this.uid);
      throw new NeedsReconnectError();
    }

    return {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      accessExpiresAt: next.accessTokenExpiresAt,
      tokenVersion: baseVersion + 1,
    };
  }

  /** Authenticated request with refresh-before-expiry and one 401 refresh+retry. */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    retriedAfter401 = false,
  ): Promise<T> {
    if (!retriedAfter401 && this.isExpiringSoon()) {
      await this.doRefresh();
    }

    const res = await this.hooks.fetchImpl(`${getPinterestApiBase()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 401 && !retriedAfter401) {
      await this.doRefresh();
      return this.request<T>(path, init, true); // exactly one retry
    }

    const text = await res.text();
    const json = text ? safeJsonParse(text) : {};

    if (!res.ok) {
      const body = json as Record<string, unknown> | null;
      const msg =
        (body && typeof body.message === "string" ? body.message : null)
        || `Pinterest API error (${res.status})`;
      // Preserve Pinterest's own code field (e.g. numeric "2") for frontend error display.
      const pinterestApiCode =
        body && ("code" in body) ? String(body.code) : undefined;
      if (isMissingScopeResponse(res.status, json, msg)) {
        await this.hooks.markReconnect(this.uid);
        throw new MissingPinterestScopesError(extractMissingScopes(json));
      }
      if (isTrialAccessResponse(res.status, json, msg)) {
        throw new PinterestTrialAccessError();
      }
      throw new PinterestApiError(msg, res.status, "pinterest_api_error", pinterestApiCode);
    }
    return json as T;
  }

  async getCurrentPinterestUser(): Promise<PinterestUser> {
    const data = await this.request<Record<string, unknown>>("/user_account", { method: "GET" });
    return {
      id: typeof data.id === "string" ? data.id : (this.row.pinterest_user_id ?? null),
      username: typeof data.username === "string" ? data.username : null,
      accountType: typeof data.account_type === "string" ? data.account_type : null,
    };
  }

  async listBoards(bookmark?: string): Promise<{ items: PinterestBoard[]; bookmark: string | null }> {
    const qs = new URLSearchParams({ page_size: "100" });
    if (bookmark) qs.set("bookmark", bookmark);
    const data = await this.request<{ items?: unknown[]; bookmark?: string | null }>(
      `/boards?${qs.toString()}`,
      { method: "GET" },
    );
    const items: PinterestBoard[] = (data.items ?? [])
      .map((b) => b as Record<string, unknown>)
      .filter((b) => typeof b.id === "string" && typeof b.name === "string")
      .map((b) => ({
        id: b.id as string,
        name: b.name as string,
        description: typeof b.description === "string" ? b.description : undefined,
        privacy: typeof b.privacy === "string" ? b.privacy : undefined,
      }));
    return { items, bookmark: data.bookmark ?? null };
  }

  /**
   * Fetch a single board by id. Returns null on 404 (board not owned / not found).
   * Using the user's own token means a 200 also proves ownership. Useful as a
   * fallback when the paged board list is momentarily stale (sandbox is eventually
   * consistent after board creation).
   */
  async getBoard(boardId: string): Promise<PinterestBoard | null> {
    try {
      const data = await this.request<Record<string, unknown>>(
        `/boards/${encodeURIComponent(boardId)}`,
        { method: "GET" },
      );
      const id = typeof data.id === "string" ? data.id : "";
      if (!id) return null;
      return {
        id,
        name: typeof data.name === "string" ? data.name : "",
        description: typeof data.description === "string" ? data.description : undefined,
        privacy: typeof data.privacy === "string" ? data.privacy : undefined,
      };
    } catch (err) {
      if (err instanceof PinterestApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Create a board on the connected account. Used by the sandbox demo-board helper. */
  async createBoard(name: string, description?: string): Promise<PinterestBoard> {
    const body: Record<string, unknown> = { name };
    if (description) body.description = description;
    const data = await this.request<Record<string, unknown>>("/boards", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) throw new PinterestApiError("Pinterest did not return a board id", 502);
    return {
      id,
      name: typeof data.name === "string" ? data.name : name,
      description: typeof data.description === "string" ? data.description : undefined,
      privacy: typeof data.privacy === "string" ? data.privacy : undefined,
    };
  }

  async createPin(input: CreatePinInput): Promise<CreatedPin> {
    const body: Record<string, unknown> = {
      board_id: input.boardId,
      media_source: { source_type: "image_url", url: input.imageUrl },
    };
    if (input.title) body.title = input.title;
    if (input.description) body.description = input.description;
    if (input.link) body.link = input.link;
    if (input.altText) body.alt_text = input.altText;

    const data = await this.request<Record<string, unknown>>("/pins", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) throw new PinterestApiError("Pinterest did not return a Pin id", 502);
    // Prefer Pinterest's own canonical URL when the response includes one. NOT
    // `data.link` — that's the Pin's destination link (where the Pin points to),
    // not the Pin's own Pinterest URL. Fall back to the constructed URL otherwise.
    const canonicalUrl = typeof data.url === "string" && data.url ? data.url : undefined;
    return {
      id,
      boardId: typeof data.board_id === "string" ? data.board_id : input.boardId,
      url: canonicalUrl ?? `https://www.pinterest.com/pin/${id}/`,
    };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isMissingScopeResponse(status: number, json: unknown, message: string): boolean {
  if (status !== 403) return false;
  const text = `${message} ${JSON.stringify(json)}`.toLowerCase();
  return text.includes("scope") || text.includes("permission") || text.includes("not sufficient");
}

function isTrialAccessResponse(status: number, json: unknown, message: string): boolean {
  if (status !== 403) return false;
  const text = `${message} ${JSON.stringify(json)}`.toLowerCase();
  return text.includes("trial access") && text.includes("api-sandbox.pinterest.com");
}

function extractMissingScopes(json: unknown): string[] {
  const matches = JSON.stringify(json).match(/[a-z_]+:[a-z_]+/g) ?? [];
  return [...new Set(matches.length ? matches : missingPinterestScopes([]))];
}
