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
 * (connected | reconnect_required | page_discovery_empty | page_selection_required) is stored
 * in the `metadata` jsonb column (which v32 already has, so NO migration is
 * needed), while connection_status carries the DB-legal projection. Page
 * access-token values are encrypted (same FACEBOOK_TOKEN_ENC_KEY cipher) before
 * going into metadata, and the client-facing projection (socialConnectionStore)
 * never returns them.
 *
 * MANUAL PAGE FALLBACK
 * Meta's /me/accounts can legitimately return an EMPTY list for a user who does
 * administer a Page (Business-Portfolio-owned Pages omitted from the
 * Login-for-Business asset picker). That state is `page_discovery_empty` — an
 * authorized connection awaiting a manually-specified Page, NOT an error. The user
 * supplies the numeric Page id, the server resolves it via Graph, and
 * connectFacebookPageManually persists it (see below).
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
  | "page_discovery_empty" // scopes ok, but /me/accounts listed nothing → manual Page entry
  | "page_selection_required"; // several Pages found — user must pick one

/**
 * Map our precise Facebook state to a DB-legal connection_status value.
 *   connected                → 'connected'
 *   reconnect_required       → 'expired'         (UI shows "Reconnect needed")
 *   page_discovery_empty     → 'not_connected'   (authorized, awaiting a manual Page id)
 *   page_selection_required  → 'not_connected'   (connected, but no target chosen yet)
 *
 * Both pending states map to 'not_connected' (NOT 'error'): the authorization
 * succeeded and the user simply has a pending choice/entry, which the UI surfaces
 * as a picker or a manual-entry form rather than a failure. Marking
 * page_discovery_empty as an error would repeat the old bug of telling a user who
 * owns a Page that they have none.
 */
function dbStatusFor(state: FacebookConnectionState): string {
  if (state === "connected") return "connected";
  if (state === "reconnect_required") return "expired";
  return "not_connected"; // page_selection_required | page_discovery_empty
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
  /**
   * How this Page entered the candidate list:
   *   "discovered" — returned by /me/accounts during the OAuth callback (default);
   *   "manual"     — the user supplied its numeric id and the server resolved it
   *                  via GET /{page-id} after discovery came back empty.
   * Kept so the two provenances stay distinguishable (a manual Page has no `tasks`
   * from Graph, so its canPublish hint is necessarily unknown/false).
   */
  source?: "discovered" | "manual";
};

function db() {
  return createServerClient();
}

function isMissingTable(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

/**
 * Thrown when a user holds SEVERAL Facebook rows and the caller did not say which
 * one it is acting on. Before multi-account (B3/d3ed390) every read here used
 * `.maybeSingle()`, which PostgREST fails outright once a second row exists — so
 * connecting a second Facebook account broke BOTH accounts (page selection, token
 * lookup, stored selection). Now the callers name their row and we only ever fall
 * back to "the sole row" when there genuinely is exactly one.
 *
 * Guessing is not an option: publishing to, or re-pointing, the WRONG Facebook
 * Page is a silent, customer-visible data error. Fail closed instead.
 */
export const MULTIPLE_FACEBOOK_CONNECTIONS = "MULTIPLE_FACEBOOK_CONNECTIONS";

/** Minimal shape every row resolution needs. */
type FacebookRowBase = { id: string; metadata?: Record<string, unknown> | null };

/**
 * Which Facebook row a caller means. Exactly one identity is needed:
 *   - `connectionId` — the social_connections row id. What the UI/publisher has:
 *     the account the customer clicked, or the account a Pin is published as.
 *   - `facebookUserId` — the Facebook USER id (metadata.facebook.facebookUserId).
 *     What the OAuth callback has: mid-callback the row may not exist yet, so
 *     there is no id to pass. This is the same key `upsertFacebookConnection`
 *     uses to find the row it is about to update, so the two can never disagree.
 * Neither given = the legacy single-account contract (see resolveFacebookRow).
 */
export type FacebookRowTarget = {
  connectionId?: string;
  facebookUserId?: string | null;
};

/** metadata.facebook.facebookUserId for a row, or null when it predates B3. */
function facebookUserIdOf(row: FacebookRowBase): string | null {
  return (
    (row.metadata as { facebook?: { facebookUserId?: string | null } } | null)?.facebook
      ?.facebookUserId ?? null
  );
}

/**
 * Pick the row belonging to one Facebook user. IDENTICAL rule to the one
 * `upsertFacebookConnection` applies, deliberately shared so a read and the write
 * that follows it can never resolve to different rows: match on the recorded
 * facebookUserId, else adopt a lone row that has no id recorded yet (written
 * before multi-account, or still mid-OAuth), else nothing.
 */
function pickRowForFacebookUser<T extends FacebookRowBase>(
  rows: T[],
  facebookUserId: string | null | undefined,
): T | null {
  const match = rows.find(r => facebookUserIdOf(r) && facebookUserIdOf(r) === facebookUserId);
  if (match) return match;
  if (rows.length === 1 && !facebookUserIdOf(rows[0])) return rows[0];
  return null;
}

/**
 * Read the ONE Facebook row a caller is acting on.
 *
 * SECURITY: `user_id` + `provider` are filtered unconditionally, and a
 * caller-supplied `connectionId` is an ADDITIONAL filter — never a replacement.
 * connectionId arrives from a request body, so on its own it would let a forged
 * id reach another user's row.
 *
 * Resolution:
 *   - `connectionId` given → that row (already narrowed by the query), or null.
 *   - `facebookUserId` given → pickRowForFacebookUser (upsert's rule).
 *   - neither → the sole row when there is exactly one (the pre-multi-account
 *     contract, unchanged); NONE when there are none; and with several we THROW
 *     MULTIPLE_FACEBOOK_CONNECTIONS rather than silently pick one.
 *
 * Throws on storage errors (missing table / unavailable) with `context` in the log.
 */
async function resolveFacebookRow<T extends FacebookRowBase>(
  uid: string,
  columns: string,
  target: FacebookRowTarget | undefined,
  context: string,
): Promise<T | null> {
  const query = db()
    .from(TABLE)
    .select(columns)
    .eq("user_id", uid)
    .eq("provider", PROVIDER);

  const { data, error } = target?.connectionId
    ? await query.eq("id", target.connectionId)
    : await query;

  if (error) {
    if (isMissingTable(error.code)) throw new Error("Facebook connection storage is not set up");
    console.error(`[facebook] read connection (${context}):`, error.message);
    throw new Error("Facebook connection storage is unavailable");
  }

  // `as unknown` first: PostgREST's select() return type is a union that includes
  // GenericStringError[], which does not overlap a generic T[].
  const rows = ((data as unknown as T[] | null) ?? []).filter(r => Boolean(r?.id));
  if (target?.connectionId) return rows[0] ?? null;
  if (target?.facebookUserId !== undefined && target?.facebookUserId !== null) {
    return pickRowForFacebookUser(rows, target.facebookUserId);
  }
  if (rows.length > 1) {
    // Several accounts and nobody said which — refuse. The caller must thread the
    // id of the row the customer is acting on.
    console.error(`[facebook] several connections and no target given (${context})`);
    throw new Error(MULTIPLE_FACEBOOK_CONNECTIONS);
  }
  return rows[0] ?? null;
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
   * storage. May be empty (reconnect_required / page_discovery_empty). The SELECTED page (see
   * `selected`) is chosen by the callback — never auto-picked from index 0 when
   * there are multiple.
   */
  pages?: ManagedPage[];
  /** The Page chosen as the publishing target, when exactly one candidate exists. */
  selected?: {
    pageId: string;
    pageName: string | null;
  } | null;
  /**
   * Carried forward on a FAILED reconnect auto-restore: preserves the previously
   * selected Page id/name in metadata (lastKnownPageId/Name) without selecting
   * it — the invalid-for-now Page must not look connected, but its id must
   * survive for the next restore attempt. Ignored when `selected` is set
   * (a live selection always refreshes lastKnown itself).
   */
  lastKnownPage?: {
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
  /**
   * The last Page this user EVER had selected (server-only, survives a failed
   * reconnect auto-restore). When a re-auth's /me/accounts comes back empty we
   * verify this id with the fresh user token; on verification failure the
   * selection is cleared but this record is kept, so the saved Page id is never
   * wiped and a later retry (or manual entry) can still find it.
   */
  lastKnownPageId: string | null;
  lastKnownPageName: string | null;
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
    source: "discovered" as const,
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
    // A live selection refreshes lastKnown; otherwise carry the caller's value
    // (failed-restore path) so the saved Page id is never wiped by a reconnect.
    lastKnownPageId: input.selected?.pageId ?? input.lastKnownPage?.pageId ?? null,
    lastKnownPageName: input.selected?.pageName ?? input.lastKnownPage?.pageName ?? null,
    candidatePages,
    updatedAt: now,
  };

  // Identify the row by WHICH Facebook account this is, not just by platform.
  // Keyed on provider alone, connecting a second account overwrote the first —
  // the table has no (user_id, provider) unique constraint, so that single-row
  // assumption lived only here. metadata.facebook.facebookUserId is the stable
  // identity: provider_account_id switches to the Page id once one is selected,
  // so it cannot serve as the key.
  const { data: rows, error: readError } = await db()
    .from(TABLE)
    .select("id, metadata")
    .eq("user_id", uid)
    .eq("provider", PROVIDER);

  const allRows = (rows as FacebookRowBase[] | null) ?? [];
  // Shared with every READ in this module (getStoredFacebookSelection's callback
  // path), so the row this write lands on is the row those reads returned.
  const existing = pickRowForFacebookUser(allRows, input.accountId);

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
    // the Page (id + name). Before a Page is chosen (page_discovery_empty /
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
  /**
   * Which connected Facebook account the customer is picking a Page FOR. With
   * several connected, omitting it would re-point an arbitrary account at this
   * Page — so the picker names its row and we fail closed without one.
   * Omitted with exactly one row: the pre-multi-account behaviour, unchanged.
   */
  connectionId?: string,
): Promise<SelectFacebookPageResult> {
  const row = await resolveFacebookRow<{ id: string; metadata?: Record<string, unknown> | null }>(
    uid,
    "id, metadata",
    { connectionId },
    "select page",
  );
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
    lastKnownPageId: chosen.pageId,
    lastKnownPageName: chosen.pageName,
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
 * Read + decrypt the stored USER access token for this user's Facebook connection.
 *
 * SERVER-ONLY. The plaintext token is returned to the caller (a route handler) so
 * it can make ONE Graph call on the user's behalf — it must never be logged,
 * echoed into a response body, or sent to the browser.
 *
 * Returns null when there is no Facebook row or the row has no stored token (e.g.
 * after a disconnect). Callers treat null as NO_FACEBOOK_CONNECTION.
 */
export async function getFacebookUserToken(
  uid: string,
  /**
   * Whose user token to read. With several Facebook accounts connected the wrong
   * token resolves the wrong Pages, so the caller names its row; without one and
   * with several rows this THROWS MULTIPLE_FACEBOOK_CONNECTIONS. It must not
   * return null there — null means "no connection at all", which would tell a
   * multi-account customer to "connect Facebook first".
   */
  connectionId?: string,
): Promise<string | null> {
  const row = await resolveFacebookRow<{
    id: string;
    access_token_encrypted?: string | null;
  }>(uid, "id, access_token_encrypted", { connectionId }, "read user token");

  const encrypted = row?.access_token_encrypted;
  if (!encrypted) return null;
  return cipher.decrypt(encrypted);
}

/**
 * The decrypted PAGE-scoped token for the user's currently selected Page, plus
 * the Page's display-safe identity. Publishing uses this — never the user token.
 */
export type SelectedPageToken = {
  pageId: string;
  pageName: string | null;
  /** PLAINTEXT page access token. SERVER-ONLY — never log/return/serialize it. */
  pageAccessToken: string;
};

/**
 * Read + decrypt the PAGE-scoped access token for this user's selected Facebook
 * Page.
 *
 * SERVER-ONLY. The plaintext token is returned so the publisher can make Graph
 * calls as the Page — it must never be logged, echoed into a response body, put
 * in a URL, or crossed over an API route boundary to the browser.
 *
 * Returns null (never throws) for every "not publishable yet" state, so callers
 * can map a single null to a clean "connect a Page first" outcome:
 *   - no Facebook row at all / row deleted;
 *   - disconnected (metadata nulled by disconnectFacebookConnection);
 *   - connection_status !== 'connected' (expired / reconnect required / pending);
 *   - connectionState !== 'connected' (page_selection_required, page_discovery_empty);
 *   - no selectedPageId or no selectedPageTokenEncrypted;
 *   - the stored ciphertext fails to decrypt (rotated/mismatched key).
 *
 * The DB status AND the finer metadata state are BOTH required to be "connected":
 * dbStatusFor() collapses two distinct pending states onto 'not_connected', so
 * trusting either one alone would let a half-configured connection publish.
 */
export async function getSelectedPageToken(
  uid: string,
  /**
   * Which connected Facebook account to publish as. With several connected,
   * omitting it would silently pick one — so the caller names the target and we
   * fail closed if that row is gone. Omitted (single-account callers, and the
   * pre-multi-account contract), the sole publishable row is used; with several
   * and no id, we refuse rather than guess.
   */
  connectionId?: string,
): Promise<SelectedPageToken | null> {
  const query = db()
    .from(TABLE)
    .select("id, connection_status, metadata")
    .eq("user_id", uid)
    .eq("provider", PROVIDER);

  const { data, error } = connectionId ? await query.eq("id", connectionId) : await query;

  if (error) {
    if (isMissingTable(error.code)) return null;
    console.error("[facebook] read page token:", error.message);
    return null;
  }

  const rows = (data as Array<{ id: string; connection_status?: string | null; metadata?: Record<string, unknown> | null }> | null) ?? [];
  // Only rows that can actually publish are candidates, so "which one?" is asked
  // of real options rather than of half-configured leftovers.
  const publishable = rows.filter(r => {
    const fb = (r.metadata as { facebook?: FacebookConnectionMetadata } | null)?.facebook;
    return r.connection_status === "connected" && fb?.connectionState === "connected"
      && Boolean(fb?.selectedPageId) && Boolean(fb?.selectedPageTokenEncrypted);
  });
  if (publishable.length > 1 && !connectionId) {
    console.error("[facebook] several publishable accounts and no target given");
    return null;
  }
  const row = publishable[0] ?? null;
  if (!row) return null;

  // Re-read through the same guards the filter applied: they hold by
  // construction, and repeating them narrows the optional fields for TS.
  const fb = (row.metadata as { facebook?: FacebookConnectionMetadata } | null)?.facebook;
  if (!fb?.selectedPageId || !fb.selectedPageTokenEncrypted) return null;

  let pageAccessToken: string;
  try {
    pageAccessToken = cipher.decrypt(fb.selectedPageTokenEncrypted);
  } catch {
    // A rotated/mismatched FACEBOOK_TOKEN_ENC_KEY makes the stored token
    // unusable — never surface the ciphertext or the decrypt error detail.
    console.error("[facebook] selected page token could not be decrypted");
    return null;
  }
  if (!pageAccessToken) return null;

  return {
    pageId: fb.selectedPageId,
    pageName: fb.selectedPageName ?? null,
    pageAccessToken,
  };
}

/**
 * Persist a MANUALLY-specified Facebook Page as the active publishing target.
 *
 * Used when Graph's /me/accounts enumeration came back empty (page_discovery_empty)
 * but the user knows their numeric Page id: the route resolves that id through
 * GET /{page-id} (service.fetchPageById), which yields a real page-scoped token,
 * and hands the resulting ManagedPage here.
 *
 * INVARIANTS:
 *   - The USER access token (access_token_encrypted) is NOT touched. A manual
 *     connect must never overwrite the user token with the page token, and must
 *     never drop it — it is what future re-resolutions/refreshes depend on.
 *   - The page token is encrypted with the same cipher before it reaches the DB
 *     and is never returned to the caller.
 *   - The Page is also appended to candidatePages (tagged source:"manual") so the
 *     Page picker and any later re-selection see it exactly like a discovered one.
 *     An existing entry with the same id is REPLACED (its token is refreshed).
 *   - No Facebook row at all (user never completed OAuth) → NO_FACEBOOK_CONNECTION.
 */
export async function connectFacebookPageManually(
  uid: string,
  page: ManagedPage,
  /**
   * Which connected Facebook account this manually-entered Page belongs to.
   * Omitted with several rows → MULTIPLE_FACEBOOK_CONNECTIONS: attaching a Page
   * to the wrong Facebook account would publish as a Page that account cannot
   * even see. Omitted with exactly one row: unchanged single-account behaviour.
   */
  connectionId?: string,
): Promise<SelectFacebookPageResult> {
  const row = await resolveFacebookRow<{ id: string; metadata?: Record<string, unknown> | null }>(
    uid,
    "id, metadata",
    { connectionId },
    "manual page",
  );
  if (!row?.id) {
    throw new Error("NO_FACEBOOK_CONNECTION");
  }

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const fb = metadata.facebook as FacebookConnectionMetadata | undefined;

  // Encrypt the page-scoped token BEFORE it goes anywhere near the DB.
  const pageAccessTokenEncrypted = cipher.encrypt(page.pageAccessToken);

  const manualCandidate: FacebookCandidatePage & { pageAccessTokenEncrypted: string } = {
    pageId: page.pageId,
    pageName: page.pageName,
    // A Page read directly from its node has no `tasks` (that field only exists on
    // the /me/accounts edge), so the publish hint is whatever the empty list says.
    canPublish: canPublishToPage(page.tasks),
    source: "manual",
    pageAccessTokenEncrypted,
  };

  const previousCandidates = Array.isArray(fb?.candidatePages) ? fb!.candidatePages : [];
  const candidatePages = [
    ...previousCandidates.filter(p => p.pageId !== page.pageId),
    manualCandidate,
  ];

  const now = new Date().toISOString();
  const nextFacebook: FacebookConnectionMetadata = {
    // Preserve everything already recorded by the OAuth callback (authMethod,
    // facebookUserId/Name, ...) — a manual Page selection is not a re-auth.
    authMethod: fb?.authMethod ?? "facebook_login",
    facebookUserId: fb?.facebookUserId ?? null,
    facebookUserName: fb?.facebookUserName ?? null,
    ...(fb ?? {}),
    connectionState: "connected",
    selectedPageId: page.pageId,
    selectedPageName: page.pageName,
    selectedPageTokenEncrypted: pageAccessTokenEncrypted,
    lastKnownPageId: page.pageId,
    lastKnownPageName: page.pageName,
    candidatePages,
    updatedAt: now,
  };

  const { error } = await db()
    .from(TABLE)
    .update({
      connection_status: "connected",
      provider_account_id: page.pageId,
      provider_account_name: page.pageName,
      provider_account_username: null,
      // access_token_encrypted is deliberately ABSENT from this payload — the user
      // token stays exactly as stored.
      metadata: { ...metadata, facebook: nextFacebook },
      updated_at: now,
    })
    .eq("id", row.id)
    .eq("user_id", uid);

  if (error) {
    console.error("[facebook] manual page update:", error.message);
    throw new Error("Facebook Page connection could not be saved");
  }

  return { pageId: page.pageId, pageName: page.pageName };
}

/**
 * The Page this user last had selected (live selection first, else the
 * preserved lastKnown record). Server-only — feeds the reconnect auto-restore.
 * Returns null when there is no prior connection or no Page was ever selected;
 * a first-time connect therefore NEVER guesses a Page id from anywhere.
 */
export async function getStoredFacebookSelection(
  uid: string,
  /**
   * Whose prior Page to restore. The OAuth callback passes
   * `{ facebookUserId }` — mid-callback the row may not exist yet, so there is no
   * connection id to pass, and reading ANOTHER account's saved Page would restore
   * a Page this Facebook user does not administer. Omitted with several rows,
   * resolveFacebookRow throws and the caller degrades to a first-connect.
   */
  target?: FacebookRowTarget,
): Promise<{ pageId: string; pageName: string | null } | null> {
  const row = await resolveFacebookRow<{
    id: string;
    metadata?: Record<string, unknown> | null;
  }>(uid, "id, metadata", target, "stored selection");
  if (!row) return null;
  const fb = (row.metadata as { facebook?: FacebookConnectionMetadata } | null)?.facebook;
  if (!fb) return null;
  const pageId = fb.selectedPageId ?? fb.lastKnownPageId ?? null;
  if (!pageId) return null;
  const pageName = fb.selectedPageId ? fb.selectedPageName : fb.lastKnownPageName;
  return { pageId, pageName: pageName ?? null };
}

/**
 * Disconnect: null out the stored tokens and mark the row not_connected (kept).
 * Mirrors the Pinterest disconnect (invalidate tokens, keep the row) — the
 * social_connections schema has no disconnected_at column, so connection_status is
 * the disconnected marker here.
 */
export async function disconnectFacebookConnection(
  uid: string,
  /**
   * Which connection to disconnect. Omitted, every Facebook row for this user is
   * cleared — the single-account contract. With several connected, removing one
   * must not sign the others out, so callers pass the id.
   */
  connectionId?: string,
): Promise<void> {
  // Read first: every CREDENTIAL is dropped below, but the Page the merchant
  // already identified (lastKnownPageId/Name — a public id, not a secret) is
  // carried over. Without it a reconnect would have to ask for the Page id by
  // hand again, even for a Page we had already resolved. Everything token-shaped
  // — selectedPageTokenEncrypted and every candidatePages[].pageAccessTokenEncrypted
  // — is deliberately NOT copied forward.
  const readQuery = db()
    .from(TABLE)
    .select("id, metadata")
    .eq("user_id", uid)
    .eq("provider", PROVIDER);
  const { data: existingRows } = connectionId ? await readQuery.eq("id", connectionId) : await readQuery;

  // With several rows and no id, this clears them all, so remembering any one
  // Page would be arbitrary — only a single, unambiguous row contributes one.
  const rowsForRead = (existingRows as Array<{ id: string; metadata?: Record<string, unknown> | null }> | null) ?? [];
  const soleRow = rowsForRead.length === 1 ? rowsForRead[0] : null;
  const prior = (soleRow?.metadata as { facebook?: FacebookConnectionMetadata } | null)?.facebook;
  const rememberedPageId = prior?.selectedPageId ?? prior?.lastKnownPageId ?? null;
  const rememberedPageName = prior?.selectedPageId
    ? prior.selectedPageName
    : (prior?.lastKnownPageName ?? null);

  const metadata = rememberedPageId
    ? {
        facebook: {
          authMethod: "facebook_login" as const,
          connectionState: "page_discovery_empty" as const,
          facebookUserId: null,
          facebookUserName: null,
          selectedPageId: null,
          selectedPageName: null,
          selectedPageTokenEncrypted: null,
          lastKnownPageId: rememberedPageId,
          lastKnownPageName: rememberedPageName,
          candidatePages: [],
          updatedAt: new Date().toISOString(),
        } satisfies FacebookConnectionMetadata,
      }
    : null;

  const updateQuery = db()
    .from(TABLE)
    .update({
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      connection_status: "not_connected",
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", uid)
    .eq("provider", PROVIDER);
  const { error } = connectionId ? await updateQuery.eq("id", connectionId) : await updateQuery;

  if (error && !isMissingTable(error.code)) {
    console.error("[facebook] disconnect:", error.message);
    throw new Error("Facebook connection could not be disconnected");
  }
}
