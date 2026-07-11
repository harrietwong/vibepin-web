/**
 * Persistence for per-user Pinterest connections (server-only).
 *
 * Tokens are encrypted (AES-256-GCM) before they touch the database and decrypted
 * only here, immediately before an API call. Tokens are NEVER returned to callers
 * that build API responses — use toSafeStatus() for anything client-facing.
 */

import { createServerClient } from "../../supabase";
import { encryptSecret, decryptSecret } from "../crypto";
import { DatabaseError, isMissingTableError } from "./errors";
import { hasRequiredPinterestScopes } from "./config";

const TABLE = "pinterest_connections";

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
};

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
// Cache the most recent row per user briefly. Every write below drops the entry,
// so within one server process a change is visible immediately; across instances
// staleness is bounded by CACHE_TTL_MS. Rows hold only ENCRYPTED tokens — the
// same bytes that transit memory on every uncached read.
// 120s: long enough to cover the review-then-Publish gap after the drawer's boards
// call warmed the row (30s regularly expired right before the Publish click, adding
// a ~2s row re-read to publish). Every write below still drops the entry immediately,
// so within one process a change is always visible; the TTL only bounds staleness
// across instances (single-instance deploy today).
const CONNECTION_CACHE_TTL_MS = 120_000;
const connectionRowCache = new Map<string, { at: number; row: PinterestConnectionRow | null }>();

function dropCachedConnection(uid: string): void {
  connectionRowCache.delete(uid);
}

/** Create or replace the user's connection, encrypting tokens. Reactivates if previously disconnected. */
export async function upsertConnection(uid: string, input: UpsertInput): Promise<void> {
  const now = new Date().toISOString();
  const row = {
    vibepin_user_id: uid,
    provider: "pinterest",
    pinterest_user_id: input.pinterestUserId,
    pinterest_username: input.pinterestUsername,
    pinterest_account_type: input.pinterestAccountType,
    access_token_encrypted: encryptSecret(input.accessToken),
    refresh_token_encrypted: input.refreshToken ? encryptSecret(input.refreshToken) : null,
    access_token_expires_at: input.accessTokenExpiresAt,
    refresh_token_expires_at: input.refreshTokenExpiresAt,
    scopes: input.scopes,
    needs_reconnect: false,
    disconnected_at: null,
    updated_at: now,
  };

  const { error } = await db()
    .from(TABLE)
    .upsert(row, { onConflict: "vibepin_user_id" });

  if (error) throw dbError("persist connection", error.code, error.message);
  dropCachedConnection(uid);
  // Warm the cache in the background (never blocks the OAuth callback redirect):
  // by the time the browser lands back on the app and asks /api/pinterest/status,
  // the fresh row is already in memory instead of costing another slow DB read.
  void getActiveConnection(uid).catch(() => {});
}

/** Active (non-disconnected) connection with a stored access token, or null. */
export async function getActiveConnection(uid: string): Promise<PinterestConnectionRow | null> {
  const cached = connectionRowCache.get(uid);
  if (cached && Date.now() - cached.at < CONNECTION_CACHE_TTL_MS) return cached.row;

  const { data, error } = await db()
    .from(TABLE)
    .select("*")
    .eq("vibepin_user_id", uid)
    .is("disconnected_at", null)
    .maybeSingle();

  if (error) throw dbError("read connection", error.code, error.message);
  const raw = (data as PinterestConnectionRow | null) ?? null;
  const row = raw?.access_token_encrypted ? raw : null;
  connectionRowCache.set(uid, { at: Date.now(), row });
  return row;
}

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

/** Persist refreshed tokens (and expiries) after a successful token refresh. */
export async function updateTokens(
  uid: string,
  tokens: {
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    access_token_encrypted: encryptSecret(tokens.accessToken),
    access_token_expires_at: tokens.accessTokenExpiresAt,
    needs_reconnect: false,
    updated_at: new Date().toISOString(),
  };
  if (tokens.refreshToken) {
    patch.refresh_token_encrypted = encryptSecret(tokens.refreshToken);
    patch.refresh_token_expires_at = tokens.refreshTokenExpiresAt;
  }

  const { error } = await db().from(TABLE).update(patch).eq("vibepin_user_id", uid);
  if (error) throw dbError("update tokens", error.code, error.message);
  dropCachedConnection(uid);
}

/**
 * Backfill the Pinterest account id/username/account_type only — a lightweight
 * partial UPDATE with no token re-encryption. Used by the deferred post-callback
 * profile sync, which intentionally runs AFTER the user is redirected back into
 * the app (never blocks the OAuth callback redirect).
 */
export async function updateAccountInfo(uid: string, account: ConnectionAccount): Promise<void> {
  const { error } = await db()
    .from(TABLE)
    .update({
      pinterest_user_id: account.id,
      pinterest_username: account.username,
      pinterest_account_type: account.accountType,
      updated_at: new Date().toISOString(),
    })
    .eq("vibepin_user_id", uid);

  if (error) throw dbError("update account info", error.code, error.message);
  dropCachedConnection(uid);
}

/** Flag a connection as needing re-authorization (e.g. refresh permanently failed). */
export async function markNeedsReconnect(uid: string): Promise<void> {
  await db()
    .from(TABLE)
    .update({ needs_reconnect: true, updated_at: new Date().toISOString() })
    .eq("vibepin_user_id", uid);
  dropCachedConnection(uid);
}

/** Disconnect: invalidate stored tokens and mark the row disconnected. */
export async function disconnect(uid: string): Promise<void> {
  const { error } = await db()
    .from(TABLE)
    .update({
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      needs_reconnect: false,
      disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("vibepin_user_id", uid);

  if (error) throw dbError("disconnect", error.code, error.message);
  dropCachedConnection(uid);
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
