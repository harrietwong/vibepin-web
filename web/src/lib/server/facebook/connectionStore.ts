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
 * FACEBOOK LOGIN FOR BUSINESS / PAGE PUBLISHING
 * The publishing target is a Facebook PAGE (Instagram is fully decoupled and runs
 * through its own flow). The v32 CHECK constraint only permits connection_status
 * in connected | not_connected | expired | revoked | error. Our finer state set
 * (connected | reconnect_required | no_pages | page_selection_required) is stored
 * in the `metadata` jsonb column (which v32 already has, so NO migration is
 * needed), while connection_status carries the DB-legal projection. Page
 * access-token values are encrypted (same FACEBOOK_TOKEN_ENC_KEY cipher) before
 * going into metadata, and the client-facing projection (socialConnectionStore)
 * never returns them.
 */

import { createServerClient } from "@/lib/supabase";
import { createTokenCipher } from "@/lib/server/crypto";
import type { ManagedPage } from "./service";
import { canPublishToPage } from "./service";
import { canConnectAnotherAccount, ConnectionLimitError } from "@/lib/server/social/connectionLimit";

const TABLE = "social_connections";
const PROVIDER = "facebook";

// Facebook tokens are encrypted with their own key, never Pinterest's.
const cipher = createTokenCipher("FACEBOOK_TOKEN_ENC_KEY");

/** Precise Facebook connection lifecycle (finer than the DB CHECK constraint). */
export type FacebookConnectionState =
  | "connected" // a Page is selected and publishable
  | "reconnect_required" // missing required Page scopes → user must re-auth
  | "no_pages" // scopes ok but the user manages no Facebook Page
  | "page_selection_required"; // several Pages found — user must pick one

/**
 * Map our precise Facebook state to a DB-legal connection_status value.
 *   connected                → 'connected'
 *   reconnect_required       → 'expired'         (UI shows "Reconnect needed")
 *   no_pages                 → 'error'           (connected, but nothing publishable)
 *   page_selection_required  → 'not_connected'   (connected, but no target chosen yet)
 *
 * page_selection_required maps to 'not_connected' (not 'error'): the auth
 * succeeded and the user simply has a pending choice, which the UI surfaces as a
 * Page picker rather than a failure.
 */
function dbStatusFor(state: FacebookConnectionState): string {
  if (state === "connected") return "connected";
  if (state === "reconnect_required") return "expired";
  if (state === "page_selection_required") return "not_connected";
  return "error"; // no_pages
}

/**
 * Client-safe metadata for a candidate Facebook Page. The encrypted page token
 * lives in a SEPARATE server-only field (see FacebookConnectionMetadata below)
 * that the client projection strips. This shape holds only display-safe fields.
 */
export type FacebookCandidatePage = {
  pageId: string;
  pageName: string | null;
  /** Whether the user's Page tasks allow publishing (CREATE_CONTENT / MANAGE). */
  canPublish: boolean;
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
  /** Facebook user id → provider_account_id (until a Page is selected). */
  accountId: string | null;
  /** Facebook user name → provider_account_name (until a Page is selected). */
  accountName: string | null;
  /** Precise Facebook lifecycle state (maps to a DB-legal connection_status). */
  state: FacebookConnectionState;
  /**
   * The Pages the user manages. Each page_access_token is encrypted here before
   * storage. May be empty (reconnect_required / no_pages). The SELECTED page (see
   * `selected`) is chosen by the callback — never auto-picked from index 0 when
   * there are multiple.
   */
  pages?: ManagedPage[];
  /** The Page chosen as the publishing target, when exactly one candidate exists. */
  selected?: {
    pageId: string;
    pageName: string | null;
  } | null;
};

/**
 * The Facebook block persisted under social_connections.metadata.facebook.
 * `candidatePages[].pageAccessTokenEncrypted` and `selectedPageTokenEncrypted` are
 * ciphertext (never plaintext). The public projection
 * (socialConnectionStore.rowToSafe) must strip both encrypted tokens before
 * returning to the client.
 */
export type FacebookConnectionMetadata = {
  authMethod: "facebook_login";
  connectionState: FacebookConnectionState;
  facebookUserId: string | null;
  facebookUserName: string | null;
  /** Chosen Page (publishing target), or null when none is selected yet. */
  selectedPageId: string | null;
  selectedPageName: string | null;
  /** Page-scoped token for the selected Page (ciphertext), or null. */
  selectedPageTokenEncrypted: string | null;
  /** All managed Pages (display-safe fields + encrypted page token). */
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
  // are what publishing uses to post to the Page (page token, not user token).
  const candidatePages = (input.pages ?? []).map(p => ({
    pageId: p.pageId,
    pageName: p.pageName,
    canPublish: canPublishToPage(p.tasks),
    pageAccessTokenEncrypted: cipher.encrypt(p.pageAccessToken),
  }));

  // When the callback selects a single Page, capture that Page's encrypted token
  // as the active publishing target. Resolved from the candidate list (same
  // ciphertext), so we never store a plaintext token here.
  const selectedPageTokenEncrypted = input.selected
    ? candidatePages.find(p => p.pageId === input.selected!.pageId)?.pageAccessTokenEncrypted ?? null
    : null;

  const metadataFacebook: FacebookConnectionMetadata = {
    authMethod: "facebook_login",
    connectionState: input.state,
    facebookUserId: input.accountId,
    facebookUserName: input.accountName,
    selectedPageId: input.selected?.pageId ?? null,
    selectedPageName: input.selected?.pageName ?? null,
    selectedPageTokenEncrypted,
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
    // The publishing target is a Page: when one is selected, the row identity is
    // the Page (id + name). Before a Page is chosen (no_pages /
    // page_selection_required / reconnect_required), fall back to the Facebook
    // user id/name so the row still identifies who connected.
    provider_account_id: input.selected?.pageId ?? input.accountId,
    provider_account_name: input.selected?.pageName ?? input.accountName,
    // Instagram no longer belongs to this connection — never set a username here.
    provider_account_username: null,
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

  // Only a NEW connection consumes a per-platform slot. The update branch above
  // returned already, so re-authing an account you already have is never blocked
  // — an at-limit user can still repair an existing connection.
  const verdict = await canConnectAnotherAccount(uid, "facebook");
  if (!verdict.allowed) {
    throw new ConnectionLimitError(verdict);
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
 * Result of a Page selection — the display-safe id/name of the chosen Page.
 */
export type SelectFacebookPageResult = {
  pageId: string;
  pageName: string | null;
};

/**
 * Select one of the previously-stored candidate Pages as the active publishing
 * target for this user's Facebook connection.
 *
 * ANTI-FORGERY: the pageId MUST already exist in the stored candidatePages (which
 * came from Graph via /me/accounts during the callback). A client cannot inject
 * an arbitrary pageId — we only ever promote a Page the server itself discovered
 * and persisted (with its encrypted page token). An unknown pageId throws.
 *
 * On success this writes selectedPageId/Name + selectedPageTokenEncrypted (copied
 * from the matching candidate's ciphertext), flips connectionState to
 * "connected", updates the top-level provider_account_id/name to the Page, and
 * sets connection_status='connected'.
 */
export async function selectFacebookPage(
  uid: string,
  pageId: string,
): Promise<SelectFacebookPageResult> {
  const { data: existing, error: readError } = await db()
    .from(TABLE)
    .select("id, metadata")
    .eq("user_id", uid)
    .eq("provider", PROVIDER)
    .maybeSingle();

  if (readError) {
    if (isMissingTable(readError.code)) throw new Error("Facebook connection storage is not set up");
    console.error("[facebook] read connection (select page):", readError.message);
    throw new Error("Facebook connection storage is unavailable");
  }

  const row = existing as { id?: string; metadata?: Record<string, unknown> | null } | null;
  if (!row?.id) {
    throw new Error("No Facebook connection to select a Page for");
  }

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const fb = metadata.facebook as FacebookConnectionMetadata | undefined;
  const candidates = Array.isArray(fb?.candidatePages) ? fb!.candidatePages : [];
  const chosen = candidates.find(p => p.pageId === pageId);
  if (!chosen) {
    // Client asked for a Page we never discovered/stored — reject (anti-forgery).
    throw new Error("PAGE_NOT_A_CANDIDATE");
  }

  const now = new Date().toISOString();
  const nextFacebook: FacebookConnectionMetadata = {
    ...(fb as FacebookConnectionMetadata),
    connectionState: "connected",
    selectedPageId: chosen.pageId,
    selectedPageName: chosen.pageName,
    selectedPageTokenEncrypted: chosen.pageAccessTokenEncrypted,
    updatedAt: now,
  };

  const { error } = await db()
    .from(TABLE)
    .update({
      connection_status: "connected",
      provider_account_id: chosen.pageId,
      provider_account_name: chosen.pageName,
      provider_account_username: null,
      metadata: { ...metadata, facebook: nextFacebook },
      updated_at: now,
    })
    .eq("id", row.id)
    .eq("user_id", uid);

  if (error) {
    console.error("[facebook] select page update:", error.message);
    throw new Error("Facebook Page selection could not be saved");
  }

  return { pageId: chosen.pageId, pageName: chosen.pageName };
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
      // Drop the Facebook metadata block incl. every encrypted page token on disconnect.
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
