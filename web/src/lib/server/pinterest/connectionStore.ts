/**
 * Persistence for Pinterest connections (server-only).
 *
 * Storage is `social_connections` (provider = 'pinterest') as of migration v59 —
 * the same table every other platform uses. Before v59 Pinterest owned a private
 * `pinterest_connections` table whose unique index was on the USER, which made "one
 * Pinterest account per VibePin user" a physical constraint rather than a product
 * decision. The unified table is keyed by (user_id, provider, provider_account_id),
 * so one user can hold N Pinterest connections that never overwrite each other.
 *
 * Every function here is CONNECTION-scoped: it identifies a connection by its row
 * id, not by the user. `getActiveConnection(uid)` survives as a compatibility layer
 * (the single/default connection for a user) so single-connection callers — which is
 * all of them today — behave exactly as before.
 *
 * Tokens are encrypted (AES-256-GCM) before they touch the database and decrypted
 * only here, immediately before an API call. Tokens are NEVER returned to callers
 * that build API responses — use toSafeStatus() for anything client-facing.
 */

import { createServerClient } from "../../supabase";
import { encryptSecret, decryptSecret } from "../crypto";
import { DatabaseError, isMissingTableError } from "./errors";
import { hasRequiredPinterestScopes } from "./config";

const TABLE = "social_connections";
const PROVIDER = "pinterest";

/**
 * A Pinterest connection in the shape the rest of the Pinterest code works with.
 *
 * This is deliberately NOT the raw `social_connections` column set: the field names
 * are Pinterest's own (pinterest_user_id, access_token_expires_at, …) and every
 * consumer — service.ts, the routes, toSafeStatus — already speaks them. Rows are
 * translated at the storage boundary (rowFromStorage) so moving the table in v59
 * changed where the bytes live, not what the code above this file sees.
 *
 * `id` is the social_connections row id — the connection id that Phase C's
 * per-Pin publish targets will reference.
 */
export type PinterestConnectionRow = {
  id: string;
  vibepin_user_id: string;
  provider: string;
  pinterest_user_id: string | null;
  pinterest_username: string | null;
  pinterest_account_type: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  scopes: string[] | null;
  needs_reconnect: boolean;
  created_at: string;
  updated_at: string;
  disconnected_at: string | null;
  /** Monotonic refresh counter (v49, per-connection since v59). Used for
   *  cross-instance CAS on token refresh: updateTokens writes only while this is
   *  unchanged, then bumps it. */
  token_version: number;
};

/** Raw `social_connections` columns this module reads. */
type StorageRow = {
  id: string;
  user_id: string;
  provider: string;
  provider_account_id: string | null;
  provider_account_username: string | null;
  connection_status: string | null;
  scopes: string[] | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  needs_reconnect: boolean | null;
  token_version: number | null;
  disconnected_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
};

const STORAGE_COLUMNS =
  "id, user_id, provider, provider_account_id, provider_account_username, connection_status, " +
  "scopes, access_token_encrypted, refresh_token_encrypted, token_expires_at, " +
  "refresh_token_expires_at, needs_reconnect, token_version, disconnected_at, metadata, " +
  "created_at, updated_at";

/** Pinterest's account_type rides in metadata — social_connections has no column for it. */
function readAccountType(metadata: Record<string, unknown> | null): string | null {
  const v = metadata?.accountType;
  return typeof v === "string" && v ? v : null;
}

function rowFromStorage(row: StorageRow): PinterestConnectionRow {
  return {
    id: row.id,
    vibepin_user_id: row.user_id,
    provider: row.provider,
    pinterest_user_id: row.provider_account_id,
    pinterest_username: row.provider_account_username,
    pinterest_account_type: readAccountType(row.metadata),
    access_token_encrypted: row.access_token_encrypted,
    refresh_token_encrypted: row.refresh_token_encrypted,
    access_token_expires_at: row.token_expires_at,
    refresh_token_expires_at: row.refresh_token_expires_at,
    scopes: row.scopes,
    needs_reconnect: row.needs_reconnect ?? false,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
    disconnected_at: row.disconnected_at,
    token_version: row.token_version ?? 0,
  };
}

export type DecryptedTokens = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
};

export type ConnectionAccount = {
  id: string | null;
  username: string | null;
  accountType: string | null;
  /** Human-readable account name (Pinterest `business_name`), preferred for display. */
  businessName?: string | null;
  /** Avatar URL (Pinterest `profile_image`). */
  avatarUrl?: string | null;
};

export type SafeStatus = {
  connected: boolean;
  account: ConnectionAccount | null;
  scopes: string[];
  needsReconnect: boolean;
  /** Connection row updated_at — proxy for last OAuth refresh / persist time. */
  lastSyncedAt: string | null;
};

export type UpsertInput = {
  pinterestUserId: string | null;
  pinterestUsername: string | null;
  pinterestAccountType: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
};

function db() {
  return createServerClient();
}

// ── In-process connection-row cache ──────────────────────────────────────────
// The row read (Supabase REST) costs ~1.5–2s from high-latency regions and sits on
// the critical path of EVERY /api/pinterest/* request (status, boards, publish).
// Cache the most recent row per CONNECTION briefly. Every write below drops the
// entry, so within one server process a change is visible immediately; across
// instances staleness is bounded by CACHE_TTL_MS. Rows hold only ENCRYPTED tokens —
// the same bytes that transit memory on every uncached read.
// 120s: long enough to cover the review-then-Publish gap after the drawer's boards
// call warmed the row (30s regularly expired right before the Publish click, adding
// a ~2s row re-read to publish). Every write below still drops the entry immediately,
// so within one process a change is always visible; the TTL only bounds staleness
// across instances (single-instance deploy today).
//
// Keys are connection ids since v59 (they were user ids while a user could only have
// one connection). A separate small index maps a user to the connection id the
// compatibility layer resolved for them, so a user-scoped read can still hit the
// cache without re-running the resolution query.
const CONNECTION_CACHE_TTL_MS = 120_000;
const connectionRowCache = new Map<string, { at: number; row: PinterestConnectionRow | null }>();
const userConnectionIndex = new Map<string, { at: number; connectionId: string | null }>();

function dropCachedConnection(connectionId: string): void {
  connectionRowCache.delete(connectionId);
}

/** Drop every cache entry belonging to a user (used when the row set itself changes). */
function dropCachedUser(uid: string): void {
  const indexed = userConnectionIndex.get(uid);
  if (indexed?.connectionId) connectionRowCache.delete(indexed.connectionId);
  userConnectionIndex.delete(uid);
}

/** Test-only: clear both caches so a case can't inherit another's warm row. */
export function __clearConnectionCaches(): void {
  connectionRowCache.clear();
  userConnectionIndex.clear();
}

function statusForRow(hasToken: boolean, needsReconnect: boolean): string {
  if (!hasToken) return "not_connected";
  return needsReconnect ? "expired" : "connected";
}

/**
 * Create a new Pinterest connection, or revive/refresh an existing one.
 *
 * `connectionId`, when given, targets EXACTLY that row — this is the reconnect path,
 * and the callback only supplies an id after it has verified that the account
 * Pinterest just returned is the same account that row belongs to. Without an id the
 * write targets the row matching (user, provider, account id), creating one when
 * there is none: connecting a second, different Pinterest account adds a row instead
 * of overwriting the first.
 *
 * Returns the connection id written, so the caller can address that connection.
 */
export async function upsertConnection(
  uid: string,
  input: UpsertInput,
  connectionId?: string,
): Promise<string> {
  const now = new Date().toISOString();
  const tokenFields = {
    access_token_encrypted: encryptSecret(input.accessToken),
    refresh_token_encrypted: input.refreshToken ? encryptSecret(input.refreshToken) : null,
    token_expires_at: input.accessTokenExpiresAt,
    refresh_token_expires_at: input.refreshTokenExpiresAt,
    scopes: input.scopes,
    needs_reconnect: false,
    disconnected_at: null,
    connection_status: statusForRow(true, false),
    auth_provider: "official",
    updated_at: now,
  };

  const target = connectionId
    ? await readById(uid, connectionId)
    : await findByAccount(uid, input.pinterestUserId);

  if (target) {
    // Identity fields: only ever WIDEN what we know. The callback may persist tokens
    // before the profile call has resolved (pinterestUserId null); that must never
    // erase an id/username already stored — the pre-v59 callback did exactly this,
    // writing nulls over a live account on every reconnect.
    const patch: Record<string, unknown> = { ...tokenFields };
    if (input.pinterestUserId) patch.provider_account_id = input.pinterestUserId;
    if (input.pinterestUsername) {
      patch.provider_account_username = input.pinterestUsername;
      patch.provider_account_name = `@${input.pinterestUsername}`;
    }
    if (input.pinterestAccountType) {
      patch.metadata = { ...(target.metadata ?? {}), accountType: input.pinterestAccountType };
    }

    const { error } = await db().from(TABLE).update(patch).eq("id", target.id).eq("user_id", uid);
    if (error) throw dbError("persist connection", error.code, error.message);
    dropCachedConnection(target.id);
    dropCachedUser(uid);
    // Warm the cache in the background (never blocks the OAuth callback redirect):
    // by the time the browser lands back on the app and asks /api/pinterest/status,
    // the fresh row is already in memory instead of costing another slow DB read.
    void getActiveConnection(uid).catch(() => {});
    return target.id;
  }

  const insert = {
    user_id: uid,
    provider: PROVIDER,
    provider_account_id: input.pinterestUserId,
    provider_account_username: input.pinterestUsername,
    provider_account_name: input.pinterestUsername ? `@${input.pinterestUsername}` : null,
    metadata: input.pinterestAccountType ? { accountType: input.pinterestAccountType } : {},
    created_at: now,
    ...tokenFields,
  };

  const { data, error } = await db().from(TABLE).insert(insert).select("id").maybeSingle();
  if (error) throw dbError("persist connection", error.code, error.message);
  const newId = (data as { id?: string } | null)?.id ?? "";
  dropCachedUser(uid);
  void getActiveConnection(uid).catch(() => {});
  return newId;
}

/** Raw storage read of one connection, scoped to its owner. */
async function readById(uid: string, connectionId: string): Promise<StorageRow | null> {
  const { data, error } = await db()
    .from(TABLE)
    .select(STORAGE_COLUMNS)
    .eq("id", connectionId)
    .eq("user_id", uid)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw dbError("read connection", error.code, error.message);
  return (data as unknown as StorageRow | null) ?? null;
}

/** Raw storage read of the row holding a given Pinterest account (including disconnected). */
async function findByAccount(uid: string, pinterestUserId: string | null): Promise<StorageRow | null> {
  let q = db()
    .from(TABLE)
    .select(STORAGE_COLUMNS)
    .eq("user_id", uid)
    .eq("provider", PROVIDER);
  // A null account id matches only the not-yet-identified row (the unique index is
  // NULLS NOT DISTINCT, so at most one such row can exist per user+provider).
  q = pinterestUserId ? q.eq("provider_account_id", pinterestUserId) : q.is("provider_account_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) throw dbError("read connection", error.code, error.message);
  return (data as unknown as StorageRow | null) ?? null;
}

/** Every Pinterest connection this user holds, disconnected ones included, newest first. */
export async function listConnections(uid: string): Promise<PinterestConnectionRow[]> {
  const { data, error } = await db()
    .from(TABLE)
    .select(STORAGE_COLUMNS)
    .eq("user_id", uid)
    .eq("provider", PROVIDER)
    .order("created_at", { ascending: true });
  if (error) throw dbError("read connection", error.code, error.message);
  return ((data as unknown as StorageRow[] | null) ?? []).map(rowFromStorage);
}

/** The user's usable (non-disconnected, token-bearing) Pinterest connections. */
export async function listActiveConnections(uid: string): Promise<PinterestConnectionRow[]> {
  return (await listConnections(uid)).filter(r => !r.disconnected_at && !!r.access_token_encrypted);
}

/** One connection by id, scoped to its owner. Null when it isn't theirs or isn't usable. */
export async function getConnectionById(
  uid: string,
  connectionId: string,
): Promise<PinterestConnectionRow | null> {
  const cached = connectionRowCache.get(connectionId);
  if (cached && Date.now() - cached.at < CONNECTION_CACHE_TTL_MS) {
    const row = cached.row;
    // A cached row is only usable for THIS caller if it belongs to them.
    if (!row || row.vibepin_user_id === uid) return row;
  }
  const raw = await readById(uid, connectionId);
  const mapped = raw ? rowFromStorage(raw) : null;
  const row = mapped && !mapped.disconnected_at && mapped.access_token_encrypted ? mapped : null;
  connectionRowCache.set(connectionId, { at: Date.now(), row });
  return row;
}

/**
 * Re-read a connection by id ALONE, without an owner check.
 *
 * Only for server-internal re-reads of a connection the caller already holds and has
 * already been authorized for (the token-refresh CAS reload path in service.ts).
 * Never reachable from a request parameter: a route resolves connections through
 * getConnectionById / getActiveConnection, both of which are owner-scoped.
 */
export async function reloadConnectionRow(connectionId: string): Promise<PinterestConnectionRow | null> {
  const { data, error } = await db()
    .from(TABLE)
    .select(STORAGE_COLUMNS)
    .eq("id", connectionId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw dbError("read connection", error.code, error.message);
  const raw = (data as unknown as StorageRow | null) ?? null;
  if (!raw) return null;
  const row = rowFromStorage(raw);
  return !row.disconnected_at && row.access_token_encrypted ? row : null;
}

/**
 * Compatibility layer: the ONE Pinterest connection a user-scoped caller means.
 *
 * Defined as the user's single active connection, or — once a user holds several —
 * the one flagged default in metadata, falling back to the oldest active connection
 * so the answer is stable rather than arbitrary. With zero active connections this
 * returns null and callers raise NotConnectedError exactly as before.
 *
 * For every single-connection user (all of them today) this resolves to the same row
 * the pre-v59 `.eq(vibepin_user_id).is(disconnected_at, null).maybeSingle()` did.
 */
export async function getActiveConnection(uid: string): Promise<PinterestConnectionRow | null> {
  const indexed = userConnectionIndex.get(uid);
  if (indexed && Date.now() - indexed.at < CONNECTION_CACHE_TTL_MS) {
    if (!indexed.connectionId) return null;
    const cached = connectionRowCache.get(indexed.connectionId);
    if (cached && Date.now() - cached.at < CONNECTION_CACHE_TTL_MS) return cached.row;
  }

  const active = await listActiveConnections(uid);
  const row = pickDefaultConnection(active);
  userConnectionIndex.set(uid, { at: Date.now(), connectionId: row?.id ?? null });
  if (row) connectionRowCache.set(row.id, { at: Date.now(), row });
  return row;
}

/**
 * Which of several active connections a user-scoped call means: the explicitly
 * default one when there is one, else the oldest (listActiveConnections is ordered
 * by created_at ascending, so [0] is the first account the user ever connected —
 * the one every pre-v59 behaviour was built on).
 */
export function pickDefaultConnection(
  active: PinterestConnectionRow[],
  defaultIds: ReadonlySet<string> = EMPTY_DEFAULTS,
): PinterestConnectionRow | null {
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  return active.find(r => defaultIds.has(r.id)) ?? active[0];
}

const EMPTY_DEFAULTS: ReadonlySet<string> = new Set<string>();

/** Decrypt the stored tokens for an active connection. Throws if no access token. */
export function decryptTokens(row: PinterestConnectionRow): DecryptedTokens {
  if (!row.access_token_encrypted) {
    throw new Error("Connection has no stored access token");
  }
  return {
    accessToken: decryptSecret(row.access_token_encrypted),
    refreshToken: row.refresh_token_encrypted ? decryptSecret(row.refresh_token_encrypted) : null,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
  };
}

/**
 * Persist refreshed tokens (and expiries) after a successful token refresh.
 *
 * Scoped to ONE connection id: with several connections per user, a user-scoped
 * write would hand every one of them the tokens of whichever connection happened to
 * refresh — a cross-account token leak, not merely a stale row.
 */
export async function updateTokens(
  connectionId: string,
  tokens: {
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
  },
  /** When set, persist as a compare-and-swap: write only while token_version still
   *  equals this value, then bump it. Returns { applied:false } if another instance
   *  already rotated the token (zero rows matched). Omit for an unconditional write. */
  expectedVersion?: number,
): Promise<{ applied: boolean }> {
  const patch: Record<string, unknown> = {
    access_token_encrypted: encryptSecret(tokens.accessToken),
    token_expires_at: tokens.accessTokenExpiresAt,
    needs_reconnect: false,
    connection_status: statusForRow(true, false),
    updated_at: new Date().toISOString(),
  };
  if (tokens.refreshToken) {
    patch.refresh_token_encrypted = encryptSecret(tokens.refreshToken);
    patch.refresh_token_expires_at = tokens.refreshTokenExpiresAt;
  }
  if (expectedVersion !== undefined) {
    patch.token_version = expectedVersion + 1;
  }

  let q = db().from(TABLE).update(patch).eq("id", connectionId);
  if (expectedVersion !== undefined) {
    // CAS: only the instance that still sees the pre-refresh version wins. `.select`
    // returns the updated rows so we can tell a match (1) from a lost race (0).
    q = q.eq("token_version", expectedVersion);
    const { data, error } = await q.select("id");
    if (error) throw dbError("update tokens", error.code, error.message);
    dropCachedConnection(connectionId);
    return { applied: Array.isArray(data) && data.length > 0 };
  }

  const { error } = await q;
  if (error) throw dbError("update tokens", error.code, error.message);
  dropCachedConnection(connectionId);
  return { applied: true };
}

/**
 * Backfill the Pinterest account id/username/account_type only — a lightweight
 * partial UPDATE with no token re-encryption. Used by the deferred post-callback
 * profile sync, which intentionally runs AFTER the user is redirected back into
 * the app (never blocks the OAuth callback redirect).
 *
 * Refuses to rewrite an identity that is already set to a DIFFERENT account: this
 * write races the callback, and a late sync belonging to a previous authorization
 * must never relabel a connection that has since been re-pointed. Returns whether
 * the write happened.
 */
export async function updateAccountInfo(
  connectionId: string,
  account: ConnectionAccount,
): Promise<{ applied: boolean }> {
  const { data, error: readError } = await db()
    .from(TABLE)
    .select("id, provider_account_id, metadata")
    .eq("id", connectionId)
    .maybeSingle();
  if (readError) throw dbError("update account info", readError.code, readError.message);
  const existing = data as { provider_account_id?: string | null; metadata?: Record<string, unknown> | null } | null;
  if (!existing) return { applied: false };

  const current = existing.provider_account_id ?? null;
  if (current && account.id && current !== account.id) {
    // Identity mismatch — someone else owns this row now. Leave it untouched.
    return { applied: false };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (account.id) patch.provider_account_id = account.id;
  if (account.username) {
    patch.provider_account_username = account.username;
  }
  // provider_account_name is the DISPLAY name. Prefer Pinterest's business_name — a
  // username is not always human-readable (a live account here is "5522278466b6972").
  // Only fall back to @username so the column is never empty for an identified account.
  if (account.businessName) {
    patch.provider_account_name = account.businessName;
  } else if (account.username) {
    patch.provider_account_name = `@${account.username}`;
  }
  if (account.avatarUrl) {
    patch.provider_account_avatar_url = account.avatarUrl;
  }
  if (account.accountType) {
    patch.metadata = { ...(existing.metadata ?? {}), accountType: account.accountType };
  }

  let write = db().from(TABLE).update(patch).eq("id", connectionId);
  // Re-assert the identity precondition at WRITE time so a callback that re-pointed
  // this row between our read and our write still wins the race. When the row already
  // carries the id we are writing, requiring equality is enough; when it is still
  // unidentified, require that it stayed that way.
  write = current ? write.eq("provider_account_id", current) : write.is("provider_account_id", null);

  const { error } = await write;
  if (error) throw dbError("update account info", error.code, error.message);
  dropCachedConnection(connectionId);
  return { applied: true };
}

/** Flag a connection as needing re-authorization (e.g. refresh permanently failed). */
export async function markNeedsReconnect(connectionId: string): Promise<void> {
  await db()
    .from(TABLE)
    .update({
      needs_reconnect: true,
      connection_status: "expired",
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);
  dropCachedConnection(connectionId);
}

/** Disconnect: invalidate stored tokens and mark the row disconnected. */
export async function disconnect(uid: string, connectionId?: string): Promise<void> {
  const now = new Date().toISOString();
  const patch = {
    access_token_encrypted: null,
    refresh_token_encrypted: null,
    token_expires_at: null,
    refresh_token_expires_at: null,
    needs_reconnect: false,
    connection_status: "not_connected",
    disconnected_at: now,
    updated_at: now,
  };

  let q = db().from(TABLE).update(patch).eq("user_id", uid).eq("provider", PROVIDER);
  if (connectionId) {
    q = q.eq("id", connectionId);
  } else {
    // User-scoped disconnect (the Settings "Disconnect" button, unchanged behaviour):
    // clears the connections that are actually live, leaving already-disconnected rows
    // and their original disconnected_at timestamps alone.
    q = q.is("disconnected_at", null);
  }

  const { error } = await q;
  if (error) throw dbError("disconnect", error.code, error.message);
  if (connectionId) dropCachedConnection(connectionId);
  dropCachedUser(uid);
}

function dbError(action: string, code: string | undefined, message: string): DatabaseError {
  if (isMissingTableError(code, message)) {
    return new DatabaseError("Pinterest connection storage is not set up");
  }
  console.error(`[pinterest] failed to ${action}:`, message);
  return new DatabaseError("Pinterest connection could not be loaded");
}

/** Client-safe status projection — never includes tokens. */
export function toSafeStatus(row: PinterestConnectionRow | null): SafeStatus {
  if (!row || row.disconnected_at || !row.access_token_encrypted) {
    return { connected: false, account: null, scopes: [], needsReconnect: false, lastSyncedAt: null };
  }
  return {
    connected: true,
    account: {
      id: row.pinterest_user_id,
      username: row.pinterest_username,
      accountType: row.pinterest_account_type,
    },
    scopes: row.scopes ?? [],
    needsReconnect: row.needs_reconnect || !hasRequiredPinterestScopes(row.scopes),
    lastSyncedAt: row.updated_at ?? null,
  };
}
