/**
 * Persistence for per-user Instagram connections (server-only).
 *
 * Like Facebook, Instagram reuses the shared social_connections table, but with a
 * DIFFERENT provider value so the two rows are FULLY INDEPENDENT and never touch
 * each other:
 *   provider = 'instagram', auth_provider = 'official'.
 *
 * Tokens are encrypted (AES-256-GCM, "v1:" prefix) via the INSTAGRAM_TOKEN_ENC_KEY
 * cipher before they touch the database and are only ever stored as ciphertext in
 * access_token_encrypted. Plaintext tokens never leave this module.
 *
 * The social_connections schema (migrate_v32) has no per-provider unique index on
 * (user_id, provider), so:
 *   - "upsert" = find the existing (user, instagram) row and UPDATE it, else INSERT.
 *   - "disconnect" clears the token columns and sets connection_status='not_connected'
 *     (row kept), mirroring the Facebook / Pinterest disconnect semantics.
 *
 * Unlike Facebook there is NO Page concept and NO page-scoped token — an Instagram
 * connection targets exactly one Instagram professional account. The connection is
 * usable ('connected') the moment a Business/Creator account authorizes. There are
 * NO encrypted tokens in metadata (only the top-level access_token_encrypted), so
 * the metadata block is entirely display-safe.
 */

import { createServerClient } from "@/lib/supabase";
import { createTokenCipher } from "@/lib/server/crypto";
import type { InstagramAccountType } from "./service";
import { canConnectAnotherAccount, ConnectionLimitError } from "@/lib/server/social/connectionLimit";

const TABLE = "social_connections";
const PROVIDER = "instagram";

// Instagram tokens are encrypted with their own key, never Facebook's/Pinterest's.
const cipher = createTokenCipher("INSTAGRAM_TOKEN_ENC_KEY");

/** Precise Instagram connection lifecycle (finer than the DB CHECK constraint). */
export type InstagramConnectionState =
  | "connected" // a Business/Creator account is authorized and publishable
  | "reconnect_required"; // token invalidated / re-auth needed

/**
 * Map our precise Instagram state to a DB-legal connection_status value. The v32
 * CHECK constraint only permits connected | not_connected | expired | revoked |
 * error, so reconnect_required projects onto 'expired' (UI shows "Reconnect").
 */
function dbStatusFor(state: InstagramConnectionState): string {
  if (state === "connected") return "connected";
  return "expired"; // reconnect_required
}

function db() {
  return createServerClient();
}

function isMissingTable(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

export type UpsertInstagramInput = {
  /** Long-lived Instagram access token (encrypted into access_token_encrypted). */
  accessToken: string;
  /** ISO timestamp for token expiry, or null. */
  expiresAt: string | null;
  /** The permissions Instagram actually granted (stored in scopes[]). */
  scopes: string[];
  /** Instagram user id → provider_account_id. */
  accountId: string;
  /** Instagram @username → provider_account_username. */
  username: string | null;
  /** Instagram display name → provider_account_name. */
  name: string | null;
  /** BUSINESS / MEDIA_CREATOR (never PERSONAL — the callback rejects those). */
  accountType: InstagramAccountType | null;
  /** Precise Instagram lifecycle state (maps to a DB-legal connection_status). */
  state: InstagramConnectionState;
};

/**
 * The Instagram block persisted under social_connections.metadata.instagram. It is
 * entirely display-safe — there is NO token field here (the only token lives,
 * encrypted, in the top-level access_token_encrypted column).
 */
export type InstagramConnectionMetadata = {
  authMethod: "instagram_login";
  connectionState: InstagramConnectionState;
  accountType: InstagramAccountType | null;
  updatedAt: string;
};

/**
 * Create or replace the user's Instagram connection, encrypting the token.
 * Reactivates a previously disconnected row (sets connection_status + refills the
 * token column). Because the table has no (user_id, provider) unique constraint we
 * resolve the target row by an explicit query, then UPDATE or INSERT.
 *
 * This ONLY ever touches the provider='instagram' row — a user's Facebook row
 * (provider='facebook') is never read or written here, so the two connections are
 * fully independent.
 */
export async function upsertInstagramConnection(
  uid: string,
  input: UpsertInstagramInput,
  /**
   * The row a Reconnect was aimed at (sealed into the OAuth state, re-read by the
   * callback against this user's own rows). Given, the write lands on THAT row —
   * the UPDATE branch, so it never consumes a plan slot. Omitted, the identity rule
   * below decides exactly as before.
   */
  targetConnectionId?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const accessTokenEncrypted = cipher.encrypt(input.accessToken);

  const metadataInstagram: InstagramConnectionMetadata = {
    authMethod: "instagram_login",
    connectionState: input.state,
    accountType: input.accountType,
    updatedAt: now,
  };

  // Identify the row by WHICH Instagram account this is, not just by platform.
  // Keyed on provider alone, connecting a second account overwrote the first.
  // Unlike Facebook — whose provider_account_id switches to the Page id once a
  // Page is chosen — Instagram's stays the IG user id throughout, so it is the
  // key directly.
  const { data: rows, error: readError } = await db()
    .from(TABLE)
    .select("id, metadata, provider_account_id")
    .eq("user_id", uid)
    .eq("provider", PROVIDER);

  type IgRow = { id: string; metadata?: Record<string, unknown> | null; provider_account_id?: string | null };
  const allRows = (rows as IgRow[] | null) ?? [];
  const byIdentity =
    allRows.find(r => r.provider_account_id && r.provider_account_id === input.accountId) ??
    // A row predating multi-account (no id recorded): adopt it rather than
    // leaving it orphaned beside a new one.
    (allRows.length === 1 && !allRows[0].provider_account_id ? allRows[0] : null);
  // A Reconnect may name the row it is repairing. It is honoured ONLY when that
  // row's recorded identity is absent or the SAME account, so the identity rule
  // above stays the source of truth and the target can only select among this
  // user's own rows (they are already filtered by user_id + provider, so a forged
  // id matches nothing). Without this, reconnecting a row that never recorded an
  // account id, on a user who has two Instagram rows, would fall through to INSERT
  // — a duplicate row that also eats a plan slot (Codex #5).
  const targetRow = targetConnectionId
    ? allRows.find(r => r.id === targetConnectionId) ?? null
    : null;
  const existing =
    targetRow && (!targetRow.provider_account_id || targetRow.provider_account_id === input.accountId)
      ? targetRow
      : byIdentity;

  if (readError && !isMissingTable(readError.code)) {
    console.error("[instagram] read connection:", readError.message);
    throw new Error("Instagram connection storage is unavailable");
  }
  if (readError && isMissingTable(readError.code)) {
    throw new Error("Instagram connection storage is not set up");
  }

  // Preserve any unrelated keys already in metadata (defensive — Instagram owns
  // metadata.instagram, but never clobber a sibling key another feature may add).
  const existingMetadata =
    ((existing as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? {}) as Record<string, unknown>;

  const payload = {
    provider: PROVIDER,
    auth_provider: "official",
    connection_status: dbStatusFor(input.state),
    provider_account_id: input.accountId,
    provider_account_name: input.name,
    provider_account_username: input.username,
    access_token_encrypted: accessTokenEncrypted,
    // Instagram long-lived tokens are not refresh tokens.
    refresh_token_encrypted: null,
    token_expires_at: input.expiresAt,
    scopes: input.scopes,
    metadata: { ...existingMetadata, instagram: metadataInstagram },
    updated_at: now,
  };

  if ((existing as { id?: string } | null)?.id) {
    const { error } = await db()
      .from(TABLE)
      .update(payload)
      .eq("id", (existing as { id: string }).id)
      .eq("user_id", uid);
    if (error) {
      console.error("[instagram] update connection:", error.message);
      throw new Error("Instagram connection could not be saved");
    }
    return;
  }

  // Only a NEW connection consumes a per-platform slot — the update branch above
  // already returned, so re-authing an existing account is never blocked.
  const verdict = await canConnectAnotherAccount(uid, PROVIDER);
  if (!verdict.allowed) {
    throw new ConnectionLimitError(verdict);
  }

  const { error } = await db()
    .from(TABLE)
    .insert({ user_id: uid, created_at: now, ...payload });
  if (error) {
    if (isMissingTable(error.code)) throw new Error("Instagram connection storage is not set up");
    console.error("[instagram] insert connection:", error.message);
    throw new Error("Instagram connection could not be saved");
  }
}

/**
 * The identity of the row a Reconnect was aimed at, for the OAuth callback's
 * "is this the same account?" check (Codex #5).
 *
 * SECURITY: the id comes from the sealed OAuth state, but it is still only ever an
 * ADDITIONAL filter on top of `user_id` + `provider` — it can never reach another
 * merchant's connection. Returns null when the row is gone (removed in another
 * tab), which the callback treats as a plain connect.
 *
 * The compared field is `provider_account_id`: unlike Facebook's — which switches
 * to the Page id once a Page is chosen — Instagram's stays the IG account id for
 * the life of the row, and it is the very key `upsertInstagramConnection` matches
 * on, so the check and the write can never disagree.
 *
 * Throws on storage errors — the callback must refuse rather than write blind.
 */
export async function getInstagramReconnectTarget(
  uid: string,
  connectionId: string,
): Promise<{ connectionId: string; accountId: string | null; label: string | null } | null> {
  if (!connectionId) return null;
  const { data, error } = await db()
    .from(TABLE)
    .select("id, provider_account_id, provider_account_username, provider_account_name")
    .eq("user_id", uid)
    .eq("provider", PROVIDER)
    .eq("id", connectionId);

  if (error) {
    if (isMissingTable(error.code)) throw new Error("Instagram connection storage is not set up");
    console.error("[instagram] read reconnect target:", error.message);
    throw new Error("Instagram connection storage is unavailable");
  }

  type TargetRow = {
    id: string;
    provider_account_id?: string | null;
    provider_account_username?: string | null;
    provider_account_name?: string | null;
  };
  const row = ((data as TargetRow[] | null) ?? []).find(r => Boolean(r?.id));
  if (!row) return null;
  return {
    connectionId: row.id,
    accountId: row.provider_account_id ?? null,
    label: row.provider_account_username ?? row.provider_account_name ?? null,
  };
}

/**
 * Disconnect: null out the stored token and mark the row not_connected (kept).
 * Mirrors the Facebook/Pinterest disconnect (invalidate tokens, keep the row) —
 * the social_connections schema has no disconnected_at column, so connection_status
 * is the disconnected marker here. Only ever touches the provider='instagram' row.
 */
export async function disconnectInstagramConnection(
  uid: string,
  /**
   * Which connection to disconnect. Omitted, EVERY Instagram row for this user is
   * cleared — correct while one account exists, and how the single-account
   * contract behaved. With several connected, removing one must not silently
   * sign the others out, so callers pass the id.
   */
  connectionId?: string,
): Promise<void> {
  const base = db()
    .from(TABLE)
    .update({
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      connection_status: "not_connected",
      // Drop the Instagram metadata block on disconnect.
      metadata: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", uid)
    .eq("provider", PROVIDER);

  const { error } = connectionId ? await base.eq("id", connectionId) : await base;

  if (error && !isMissingTable(error.code)) {
    console.error("[instagram] disconnect:", error.message);
    throw new Error("Instagram connection could not be disconnected");
  }
}

/**
 * Decrypted Instagram access token for publishing — SERVER-ONLY.
 *
 * Returns null unless the connection is currently `connected`: an expired or
 * disconnected row must never yield a usable credential. The plaintext token is
 * returned to the caller and never logged, stored, or sent to the client.
 */
export async function getInstagramAccessToken(
  uid: string,
  /**
   * Which connected Instagram account to publish as. With several connected,
   * omitting it would silently pick one, so we refuse instead — posting as the
   * wrong brand is worse than not posting. Omitted with a single account (the
   * pre-multi-account contract), that account is used.
   */
  connectionId?: string,
): Promise<{ accessToken: string; userId: string | null; username: string | null } | null> {
  const base = db()
    .from(TABLE)
    .select("id, connection_status, access_token_encrypted, provider_account_id, provider_account_name")
    .eq("user_id", uid)
    .eq("provider", PROVIDER);

  const { data, error } = connectionId ? await base.eq("id", connectionId) : await base;

  if (error) {
    if (isMissingTable(error.code)) return null;
    console.error("[instagram] read token:", error.message);
    return null;
  }

  const rows = (data as Array<{
    id: string;
    connection_status?: string | null;
    access_token_encrypted?: string | null;
    provider_account_id?: string | null;
    provider_account_name?: string | null;
  }> | null) ?? [];

  const publishable = rows.filter(r => r.connection_status === "connected" && r.access_token_encrypted);
  if (publishable.length > 1 && !connectionId) {
    console.error("[instagram] several connected accounts and no target given");
    return null;
  }
  const row = publishable[0] ?? null;
  if (!row?.access_token_encrypted) return null;

  try {
    return {
      accessToken: cipher.decrypt(row.access_token_encrypted),
      userId: row.provider_account_id ?? null,
      username: row.provider_account_name ?? null,
    };
  } catch {
    // A token encrypted under a rotated key is unusable — treat as not connected
    // rather than throwing a crypto error into the publish path.
    console.error("[instagram] token decrypt failed");
    return null;
  }
}
