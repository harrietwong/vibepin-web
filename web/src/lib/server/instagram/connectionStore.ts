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
): Promise<void> {
  const now = new Date().toISOString();
  const accessTokenEncrypted = cipher.encrypt(input.accessToken);

  const metadataInstagram: InstagramConnectionMetadata = {
    authMethod: "instagram_login",
    connectionState: input.state,
    accountType: input.accountType,
    updatedAt: now,
  };

  const { data: existing, error: readError } = await db()
    .from(TABLE)
    .select("id, metadata")
    .eq("user_id", uid)
    .eq("provider", PROVIDER)
    .maybeSingle();

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
 * Disconnect: null out the stored token and mark the row not_connected (kept).
 * Mirrors the Facebook/Pinterest disconnect (invalidate tokens, keep the row) —
 * the social_connections schema has no disconnected_at column, so connection_status
 * is the disconnected marker here. Only ever touches the provider='instagram' row.
 */
export async function disconnectInstagramConnection(uid: string): Promise<void> {
  const { error } = await db()
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
): Promise<{ accessToken: string; userId: string | null; username: string | null } | null> {
  const { data, error } = await db()
    .from(TABLE)
    .select("connection_status, access_token_encrypted, provider_account_id, provider_account_name")
    .eq("user_id", uid)
    .eq("provider", PROVIDER)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error.code)) return null;
    console.error("[instagram] read token:", error.message);
    return null;
  }

  const row = data as {
    connection_status?: string | null;
    access_token_encrypted?: string | null;
    provider_account_id?: string | null;
    provider_account_name?: string | null;
  } | null;

  if (!row || row.connection_status !== "connected" || !row.access_token_encrypted) return null;

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
