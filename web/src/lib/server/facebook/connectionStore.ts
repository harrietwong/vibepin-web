/**
 * Persistence for per-user Facebook connections (server-only).
 *
 * Unlike Pinterest (which owns a dedicated pinterest_connections table), Facebook
 * reuses the shared social_connections table:
 *   provider = 'facebook', auth_provider = 'official'.
 *
 * Tokens are encrypted (AES-256-GCM, "v1:" prefix) via the FACEBOOK_TOKEN_ENC_KEY
 * cipher before they touch the database and are only ever stored as ciphertext in
 * access_token_encrypted / refresh_token_encrypted. Plaintext tokens never leave
 * this module.
 *
 * The social_connections schema (migrate_v32) does NOT have disconnected_at,
 * needs_reconnect, or token_version columns. So:
 *   - "upsert" = find the existing (user, facebook) row and UPDATE it, else INSERT.
 *     There is no unique index on (user_id, provider) — the only unique index is on
 *     (provider, external_connection_id) — so we resolve the row by explicit query.
 *   - "disconnect" clears the token columns and sets connection_status='not_connected'
 *     (row kept), mirroring the Pinterest disconnect semantics as closely as this
 *     schema allows.
 *
 * FACEBOOK LOGIN FOR BUSINESS / INSTAGRAM (Phase 1)
 * The v32 CHECK constraint only permits connection_status in
 *   connected | not_connected | expired | revoked | error.
 * "reconnect_required" (missing business scopes) is therefore mapped to the DB
 * status 'expired' — the UI already renders 'expired' as "Reconnect needed" — and
 * the precise state ('reconnect_required' | 'no_instagram_account' | 'connected')
 * plus all the Facebook/IG discovery data is stored in the `metadata` jsonb column
 * (which v32 already has, so NO migration is needed). page_access_token values are
 * encrypted (same FACEBOOK_TOKEN_ENC_KEY cipher) before going into metadata, and
 * the client-facing projection (socialConnectionStore) never returns them.
 */

import { createServerClient } from "@/lib/supabase";
import { createTokenCipher } from "@/lib/server/crypto";
import type { DiscoveredInstagramAccount } from "./service";

const TABLE = "social_connections";
const PROVIDER = "facebook";

// Facebook tokens are encrypted with their own key, never Pinterest's.
const cipher = createTokenCipher("FACEBOOK_TOKEN_ENC_KEY");

/** Precise Facebook connection lifecycle (finer than the DB CHECK constraint). */
export type FacebookConnectionState =
  | "connected"
  | "reconnect_required" // missing required business scopes → user must re-auth
  | "no_instagram_account"; // scopes ok but no Page has a linked IG account

/**
 * Map our precise Facebook state to a DB-legal connection_status value.
 *   connected             → 'connected'
 *   reconnect_required    → 'expired'  (UI shows "Reconnect needed")
 *   no_instagram_account  → 'error'    (connected, but nothing publishable yet)
 */
function dbStatusFor(state: FacebookConnectionState): string {
  if (state === "connected") return "connected";
  if (state === "reconnect_required") return "expired";
  return "error"; // no_instagram_account
}

/**
 * Client-safe metadata for a Facebook connection. Encrypted page tokens live in a
 * SEPARATE server-only field (see FacebookConnectionMetadata below) that the
 * client projection strips. This shape holds only display-safe identifiers.
 */
export type FacebookCandidatePage = {
  pageId: string;
  pageName: string | null;
  instagramUserId: string;
  instagramUsername: string | null;
  instagramName: string | null;
};

function db() {
  return createServerClient();
}

function isMissingTable(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

export type UpsertFacebookInput = {
  /** Long-lived USER access token (encrypted into access_token_encrypted). */
  accessToken: string;
  refreshToken?: string | null;
  /** ISO timestamp for token expiry, or null. */
  expiresAt: string | null;
  /** The permissions Facebook actually granted (stored in scopes[]). */
  scopes: string[];
  /** Facebook user id → provider_account_id. */
  accountId: string | null;
  /** Facebook user name → provider_account_name. */
  accountName: string | null;
  /** Precise Facebook lifecycle state (maps to a DB-legal connection_status). */
  state: FacebookConnectionState;
  /**
   * The Instagram-linked Pages discovered for this user. Each page_access_token
   * is encrypted here before storage. May be empty (reconnect_required /
   * no_instagram_account). The SELECTED page (see selected*) is chosen by the
   * callback — never auto-picked from index 0 when there are multiple.
   */
  pages?: DiscoveredInstagramAccount[];
  /** The page/IG chosen as active, when exactly one candidate exists (or user-selected later). */
  selected?: {
    pageId: string;
    pageName: string | null;
    instagramUserId: string;
    instagramUsername: string | null;
  } | null;
};

/**
 * The Facebook block persisted under social_connections.metadata.facebook.
 * `candidatePages[].pageAccessTokenEncrypted` is ciphertext (never plaintext).
 * The public projection (socialConnectionStore.rowToSafe) must strip the
 * encrypted token before returning to the client.
 */
export type FacebookConnectionMetadata = {
  authMethod: "facebook_login";
  connectionState: FacebookConnectionState;
  facebookUserId: string | null;
  facebookUserName: string | null;
  /** Chosen active page + IG, or null when none is selected yet. */
  selectedPageId: string | null;
  selectedPageName: string | null;
  selectedInstagramUserId: string | null;
  selectedInstagramUsername: string | null;
  /** All discovered IG-linked pages (display-safe fields + encrypted page token). */
  candidatePages: Array<
    FacebookCandidatePage & { pageAccessTokenEncrypted: string }
  >;
  updatedAt: string;
};

/**
 * Create or replace the user's Facebook connection, encrypting tokens. Reactivates
 * a previously disconnected row (sets connection_status='connected' and refills the
 * token columns). Because the table has no (user_id, provider) unique constraint we
 * resolve the target row by an explicit query, then UPDATE or INSERT.
 */
export async function upsertFacebookConnection(
  uid: string,
  input: UpsertFacebookInput,
): Promise<void> {
  const now = new Date().toISOString();
  const accessTokenEncrypted = cipher.encrypt(input.accessToken);
  const refreshTokenEncrypted = input.refreshToken ? cipher.encrypt(input.refreshToken) : null;

  // Encrypt every discovered page-scoped token BEFORE it goes near the DB. These
  // are what Phase 2 uses to publish to Instagram (page token, not user token).
  const candidatePages = (input.pages ?? []).map(p => ({
    pageId: p.pageId,
    pageName: p.pageName,
    instagramUserId: p.instagram.id,
    instagramUsername: p.instagram.username,
    instagramName: p.instagram.name,
    pageAccessTokenEncrypted: cipher.encrypt(p.pageAccessToken),
  }));

  const metadataFacebook: FacebookConnectionMetadata = {
    authMethod: "facebook_login",
    connectionState: input.state,
    facebookUserId: input.accountId,
    facebookUserName: input.accountName,
    selectedPageId: input.selected?.pageId ?? null,
    selectedPageName: input.selected?.pageName ?? null,
    selectedInstagramUserId: input.selected?.instagramUserId ?? null,
    selectedInstagramUsername: input.selected?.instagramUsername ?? null,
    candidatePages,
    updatedAt: now,
  };

  const { data: existing, error: readError } = await db()
    .from(TABLE)
    .select("id, metadata")
    .eq("user_id", uid)
    .eq("provider", PROVIDER)
    .maybeSingle();

  if (readError && !isMissingTable(readError.code)) {
    console.error("[facebook] read connection:", readError.message);
    throw new Error("Facebook connection storage is unavailable");
  }
  if (readError && isMissingTable(readError.code)) {
    throw new Error("Facebook connection storage is not set up");
  }

  // Preserve any unrelated keys already in metadata (defensive — Facebook owns
  // metadata.facebook, but never clobber a sibling key another feature may add).
  const existingMetadata =
    ((existing as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? {}) as Record<string, unknown>;

  const payload = {
    provider: PROVIDER,
    auth_provider: "official",
    connection_status: dbStatusFor(input.state),
    provider_account_id: input.accountId,
    provider_account_name: input.accountName,
    // Surface the selected IG handle as the account username when we have one.
    provider_account_username: input.selected?.instagramUsername ?? null,
    access_token_encrypted: accessTokenEncrypted,
    refresh_token_encrypted: refreshTokenEncrypted,
    token_expires_at: input.expiresAt,
    scopes: input.scopes,
    metadata: { ...existingMetadata, facebook: metadataFacebook },
    updated_at: now,
  };

  if ((existing as { id?: string } | null)?.id) {
    const { error } = await db()
      .from(TABLE)
      .update(payload)
      .eq("id", (existing as { id: string }).id)
      .eq("user_id", uid);
    if (error) {
      console.error("[facebook] update connection:", error.message);
      throw new Error("Facebook connection could not be saved");
    }
    return;
  }

  const { error } = await db()
    .from(TABLE)
    .insert({ user_id: uid, created_at: now, ...payload });
  if (error) {
    if (isMissingTable(error.code)) throw new Error("Facebook connection storage is not set up");
    console.error("[facebook] insert connection:", error.message);
    throw new Error("Facebook connection could not be saved");
  }
}

/**
 * Disconnect: null out the stored tokens and mark the row not_connected (kept).
 * Mirrors the Pinterest disconnect (invalidate tokens, keep the row) — the
 * social_connections schema has no disconnected_at column, so connection_status is
 * the disconnected marker here.
 */
export async function disconnectFacebookConnection(uid: string): Promise<void> {
  const { error } = await db()
    .from(TABLE)
    .update({
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      connection_status: "not_connected",
      // Drop the Facebook/IG block incl. every encrypted page token on disconnect.
      metadata: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", uid)
    .eq("provider", PROVIDER);

  if (error && !isMissingTable(error.code)) {
    console.error("[facebook] disconnect:", error.message);
    throw new Error("Facebook connection could not be disconnected");
  }
}
