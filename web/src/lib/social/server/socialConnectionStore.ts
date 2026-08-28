/**
 * Server-only persistence + projection for multi-platform social connections.
 *
 * Responsibilities:
 *   - Read/write the social_connections table (service-role, RLS-bypassing).
 *   - Unify Pinterest's dedicated OAuth table (pinterest_connections) into the
 *     same SocialConnection shape, so the UI sees one consistent model.
 *   - Only ever return client-safe projections — token ciphertext never leaves
 *     this module.
 *   - Keep ONE listing rule per audience: `listConnections` (the default) answers
 *     with accounts that can publish right now, which is what every publish-side
 *     caller means; `listConnectionsForSettings` also returns the merchant’s
 *     DISCONNECTED rows, because those still hold a plan slot and only Remove
 *     frees it (PRD 0805 §11).
 *   - Degrade gracefully when the v32 tables have not been applied yet (missing
 *     table → treated as "no rows", never a 500).
 */

import { createServerClient } from "@/lib/supabase";
import {
  listActiveConnections,
  listConnections as listPinterestRows,
  toAccountIdentity,
  toSafeStatus,
} from "@/lib/server/pinterest/connectionStore";
import { getSocialProvider } from "../providers";
import {
  PLATFORMS,
  SOCIAL_PROVIDERS,
  type SocialProvider,
} from "../platforms";
import type {
  AuthProvider,
  ConnectionStatus,
  PlatformConnectionSummary,
  SocialConnection,
} from "../types";

const TABLE = "social_connections";

type SocialConnectionRow = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  provider: string;
  provider_account_id: string | null;
  provider_account_name: string | null;
  provider_account_username: string | null;
  provider_account_avatar_url: string | null;
  connection_status: string | null;
  auth_provider: string | null;
  external_connection_id: string | null;
  scopes: string[] | null;
  token_expires_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
};

function db() {
  return createServerClient();
}

function isMissingTable(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

function isMissingSocialConnectionsTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (
    isMissingTable(error.code) ||
    (typeof error.message === "string" && error.message.includes("social_connections"))
  );
}

/**
 * Rebuild a display-safe `metadata.facebook` block by WHITELIST — keeping only
 * Page identifiers / publish capability / state, and dropping every encrypted-token
 * field (`selectedPageTokenEncrypted` and each
 * `candidatePages[].pageAccessTokenEncrypted`), which, even encrypted, must NEVER
 * leave the server. Returns null when there is no facebook block.
 */
function sanitizeFacebook(
  fb: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!fb || typeof fb !== "object") return null;

  const rawPages = Array.isArray((fb as { candidatePages?: unknown }).candidatePages)
    ? ((fb as { candidatePages: unknown[] }).candidatePages)
    : [];
  const safePages = rawPages.map(p => {
    const page = (p ?? {}) as Record<string, unknown>;
    // Deliberately OMIT pageAccessTokenEncrypted — never send a token, encrypted or not.
    return {
      pageId: page.pageId ?? null,
      pageName: page.pageName ?? null,
      canPublish: page.canPublish ?? false,
    };
  });

  return {
    authMethod: (fb as { authMethod?: unknown }).authMethod ?? null,
    connectionState: (fb as { connectionState?: unknown }).connectionState ?? null,
    facebookUserId: (fb as { facebookUserId?: unknown }).facebookUserId ?? null,
    facebookUserName: (fb as { facebookUserName?: unknown }).facebookUserName ?? null,
    selectedPageId: (fb as { selectedPageId?: unknown }).selectedPageId ?? null,
    selectedPageName: (fb as { selectedPageName?: unknown }).selectedPageName ?? null,
    // selectedPageTokenEncrypted is deliberately dropped — never leaves the server.
    candidatePages: safePages,
  };
}

/**
 * Rebuild a display-safe `metadata.instagram` block by WHITELIST. Instagram never
 * stores any token in metadata (its only token lives, encrypted, in the top-level
 * access_token_encrypted column), so this block is already display-safe — but we
 * still reconstruct it from a fixed field set so a future field can never leak
 * something token-shaped by accident. Returns null when there is no instagram block.
 */
function sanitizeInstagram(
  ig: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!ig || typeof ig !== "object") return null;
  return {
    authMethod: (ig as { authMethod?: unknown }).authMethod ?? null,
    connectionState: (ig as { connectionState?: unknown }).connectionState ?? null,
    accountType: (ig as { accountType?: unknown }).accountType ?? null,
  };
}

/**
 * Strip every token-shaped value out of a connection's metadata before it can
 * reach the client. Facebook (metadata.facebook) carries encrypted page tokens;
 * Instagram (metadata.instagram) carries only display fields. Both are rebuilt by
 * whitelist so nothing token-shaped can escape, and every other metadata key is
 * preserved unchanged.
 */
function sanitizeMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return metadata ?? null;
  const fb = (metadata as { facebook?: Record<string, unknown> }).facebook;
  const ig = (metadata as { instagram?: Record<string, unknown> }).instagram;
  if ((!fb || typeof fb !== "object") && (!ig || typeof ig !== "object")) return metadata;

  const next: Record<string, unknown> = { ...metadata };
  const safeFacebook = sanitizeFacebook(fb);
  if (safeFacebook) next.facebook = safeFacebook;
  const safeInstagram = sanitizeInstagram(ig);
  if (safeInstagram) next.instagram = safeInstagram;
  return next;
}

function rowToSafe(row: SocialConnectionRow): SocialConnection {
  return {
    id: row.id,
    provider: row.provider as SocialProvider,
    workspaceId: row.workspace_id,
    providerAccountId: row.provider_account_id,
    providerAccountName: row.provider_account_name,
    providerAccountUsername: row.provider_account_username,
    providerAccountAvatarUrl: row.provider_account_avatar_url,
    connectionStatus: (row.connection_status as ConnectionStatus) ?? "not_connected",
    authProvider: (row.auth_provider as AuthProvider) ?? null,
    externalConnectionId: row.external_connection_id,
    scopes: row.scopes ?? [],
    tokenExpiresAt: row.token_expires_at,
    metadata: sanitizeMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readDefaultBoardFromMetadata(metadata: Record<string, unknown> | null | undefined) {
  const boardId = typeof metadata?.default_board_id === "string" ? metadata.default_board_id.trim() : "";
  const boardName = typeof metadata?.default_board_name === "string" ? metadata.default_board_name.trim() : "";
  return boardId ? { boardId, boardName: boardName || null } : null;
}

/**
 * The Pinterest row a user-scoped call means, plus its metadata.
 *
 * Listed and reduced rather than `.maybeSingle()`: since v59 a user may hold several
 * Pinterest rows, and maybeSingle turns that from "pick one" into a query ERROR that
 * would silently empty the default board for every multi-account user. Preference
 * order matches connectionStore.pickDefaultConnection — the oldest live connection —
 * so a single-connection user resolves the exact row they always did.
 */
async function readPinterestRow(
  uid: string,
  /** Read THIS account's row instead of the user's default one. Still scoped to `uid`,
   *  so naming another user's connection id resolves nothing. */
  connectionId?: string,
): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
  const { data, error } = await db()
    .from(TABLE)
    .select("id, metadata, disconnected_at, created_at")
    .eq("user_id", uid)
    .eq("provider", "pinterest")
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingSocialConnectionsTable(error)) return null;
    console.error("[social] read pinterest row:", error.message);
    return null;
  }
  const rows = (data as unknown as Array<{ id: string; metadata: Record<string, unknown> | null; disconnected_at: string | null }> | null) ?? [];
  if (rows.length === 0) return null;
  // An explicitly named account resolves to that row or to nothing — never silently to a
  // different account's default board.
  if (connectionId) {
    const named = rows.find(r => r.id === connectionId);
    return named ? { id: named.id, metadata: (named.metadata ?? {}) as Record<string, unknown> } : null;
  }
  // Prefer a live connection; fall back to the oldest row so a user who has
  // disconnected everything still keeps the default board they had chosen.
  const chosen = rows.find(r => !r.disconnected_at) ?? rows[0];
  return { id: chosen.id, metadata: (chosen.metadata ?? {}) as Record<string, unknown> };
}

async function readPinterestMetadata(uid: string, connectionId?: string): Promise<Record<string, unknown>> {
  return (await readPinterestRow(uid, connectionId))?.metadata ?? {};
}

/**
 * The default board of one account. Default boards are per-account because board ids are:
 * account A's default board id means nothing on account B. `connectionId` omitted ⇒ the
 * user's default connection, exactly as before.
 */
export async function getPinterestDefaultBoard(uid: string, connectionId?: string): Promise<{ boardId: string; boardName: string | null } | null> {
  return readDefaultBoardFromMetadata(await readPinterestMetadata(uid, connectionId));
}

export async function savePinterestDefaultBoard(
  uid: string,
  board: { boardId: string; boardName?: string | null },
  connectionId?: string,
): Promise<{ boardId: string; boardName: string | null } | null> {
  const boardId = board.boardId.trim();
  if (!boardId) return null;
  const boardName = board.boardName?.trim() || null;
  const now = new Date().toISOString();

  const existing = await readPinterestRow(uid, connectionId);
  // A named account that isn't this user's resolves to nothing — never fall through to
  // creating a placeholder row or stamping the default account's board.
  if (connectionId && !existing) return null;

  const metadata = {
    ...(existing?.metadata ?? {}),
    default_board_id: boardId,
    default_board_name: boardName,
  };

  if (existing) {
    const { error } = await db()
      .from(TABLE)
      .update({ metadata, updated_at: now })
      .eq("id", existing.id)
      .eq("user_id", uid);
    if (error) {
      console.error("[social] update pinterest default board:", error.message);
      return null;
    }
  } else {
    const { error } = await db()
      .from(TABLE)
      .insert({
        user_id: uid,
        provider: "pinterest",
        connection_status: "not_connected",
        auth_provider: "official",
        metadata,
        created_at: now,
        updated_at: now,
      });
    if (error) {
      if (!isMissingSocialConnectionsTable(error)) console.error("[social] insert pinterest default board:", error.message);
      return null;
    }
  }

  return { boardId, boardName };
}

/**
 * Map the live Pinterest connection into a SocialConnection (never tokens).
 *
 * The `id` is the real social_connections row id since v59. It used to be a
 * SYNTHESIZED `pinterest:<uid>` string, because Pinterest lived in its own table and
 * had no id the rest of the social layer could use — which also meant every caller
 * that addressed a connection by id (disconnect, publish targets) could only ever
 * name "this user's Pinterest", not a specific account. Now that the row is in the
 * same table as everyone else's, it carries the same kind of id, and callers can
 * point at one account out of several.
 */
async function readPinterestConnections(
  uid: string,
  opts?: ListConnectionsOptions,
): Promise<SocialConnection[]> {
  let rows;
  try {
    // EVERY usable Pinterest account, not just the default one. A Pin's publish target
    // names one specific account (PRD §13), so the client has to be able to see them
    // all — showing only the default made "which account does this Pin go to?"
    // unanswerable. Order is created_at ascending, so index 0 is the account
    // pickDefaultConnection resolves for a user-scoped call: the client's fallback
    // matches the server's without duplicating the rule.
    rows = opts?.includeDisconnected
      ? await listPinterestRows(uid)
      : await listActiveConnections(uid);
  } catch {
    // Pinterest storage errors shouldn't sink the whole social view.
    return [];
  }

  const out: SocialConnection[] = [];
  for (const row of rows) {
    const safe = toSafeStatus(row);
    // Publish-side reads keep the old rule: only rows that can publish right now.
    if (!safe.connected && !opts?.includeDisconnected) continue;
    // A row that was NEVER connected is not an account. `savePinterestDefaultBoard`
    // inserts a metadata-only placeholder (no token, no disconnected_at, no account
    // id) to remember a default board; listing it would show the merchant a
    // "Disconnected" row for an account that never existed, named by a mask.
    if (!safe.connected && !row.disconnected_at && !row.pinterest_user_id) continue;
    // A disconnected row reports the same status Facebook/Instagram write for theirs
    // ("not_connected" + no token), so `accountUiState` reads all three as the one
    // customer-visible state: Disconnected, with a Reconnect.
    const status: ConnectionStatus = !safe.connected
      ? "not_connected"
      : safe.needsReconnect ? "expired" : "connected";
    // Identity survives a disconnect (toAccountIdentity), because the row does: the
    // merchant must see WHICH account they are about to reconnect or remove.
    const account = toAccountIdentity(row);
    // Metadata (incl. the default board) is per-account, read by this row's id.
    const metadata = await readPinterestMetadata(uid, row.id);
    if (account.accountType) metadata.accountType = account.accountType;
    out.push({
      id: row.id,
      provider: "pinterest",
      workspaceId: null,
      providerAccountId: account.id ?? null,
      // Use the STORED display name (Pinterest business_name) — synthesising "@username"
      // here discarded it, so a merchant saw "@5522278466b6972" for an account actually
      // called "harrietstudio". Fall back to @username only when there is no display name.
      providerAccountName:
        account.businessName
        || (account.username ? `@${account.username}` : null),
      providerAccountUsername: account.username ?? null,
      providerAccountAvatarUrl: account.avatarUrl ?? null,
      connectionStatus: status,
      authProvider: "official",
      externalConnectionId: null,
      // Scopes are the ones the dead row last held; a disconnected row is never
      // scope-judged (accountUiState skips the scope check for not_connected).
      scopes: safe.connected ? safe.scopes : (row.scopes ?? []),
      tokenExpiresAt: null,
      metadata,
      createdAt: row.created_at ?? null,
      updatedAt: safe.connected ? safe.lastSyncedAt : (row.updated_at || null),
    });
  }
  return out;
}

/** All non-Pinterest connections stored in social_connections for a user. */
async function readStoredConnections(uid: string): Promise<SocialConnection[]> {
  const { data, error } = await db()
    .from(TABLE)
    .select(
      "id, user_id, workspace_id, provider, provider_account_id, provider_account_name, " +
        "provider_account_username, provider_account_avatar_url, connection_status, auth_provider, " +
        "external_connection_id, scopes, token_expires_at, metadata, created_at, updated_at",
    )
    .eq("user_id", uid);

  if (error) {
    if (isMissingSocialConnectionsTable(error)) return []; // v32 not applied yet
    console.error("[social] read connections:", error.message);
    return [];
  }
  return ((data as unknown as SocialConnectionRow[] | null) ?? [])
    .filter(r => r.provider !== "pinterest") // Pinterest comes from its dedicated table
    .map(rowToSafe);
}

/**
 * Live accounts reported by the active publishing provider (e.g. Zernio).
 * Pinterest is dropped here because the native Pinterest OAuth flow owns that
 * platform's card. Mock returns nothing, so behaviour is unchanged by default.
 * Never throws — a provider outage must not sink the whole social view.
 */
async function readProviderConnections(uid: string): Promise<SocialConnection[]> {
  try {
    const accounts = await getSocialProvider().getConnections({ userId: uid });
    return accounts.filter(a => a.provider !== "pinterest");
  } catch (err) {
    console.error("[social] provider getConnections failed:", (err as Error).message);
    return [];
  }
}

/**
 * Whether rows the merchant has DISCONNECTED are part of the answer.
 *
 * Off by default, and that default is the contract: every publish-side reader
 * (publish/social, destinations/validate, findConnection’s legacy synthetic id)
 * calls the plain form and must keep seeing only accounts that can publish now.
 * Settings is the one surface that asks for them — see listConnectionsForSettings.
 */
export type ListConnectionsOptions = { includeDisconnected?: boolean };

/** Full list of connected accounts across every provider, safe to send to the client. */
export async function listConnections(
  uid: string,
  opts?: ListConnectionsOptions,
): Promise<SocialConnection[]> {
  const [pinterest, stored, provider] = await Promise.all([
    readPinterestConnections(uid, opts),
    readStoredConnections(uid),
    readProviderConnections(uid),
  ]);
  // De-dupe by id so a DB row and a provider-reported row don't both appear. Pinterest
  // rows live in social_connections too since v59; both generic readers already drop
  // provider === "pinterest", and this id check keeps that guarantee independent of them
  // (a duplicated account would let the user target the same account twice).
  const pinterestIds = new Set(pinterest.map(c => c.id));
  const merged = new Map<string, SocialConnection>();
  for (const c of [...stored, ...provider]) {
    if (pinterestIds.has(c.id)) continue;
    merged.set(c.id, c);
  }
  return [...pinterest, ...merged.values()];
}

/**
 * The Settings listing: every account row the merchant HOLDS, disconnected ones
 * included (PRD 0805 §11).
 *
 * Disconnect keeps the row on every platform now, so the row has to stay visible —
 * it still occupies the merchant’s plan slot, and Remove (a hard delete) is the only
 * way to free it. A row they cannot see is a slot they cannot get back.
 *
 * Facebook/Instagram never needed this branch: their disconnect leaves the row in
 * `social_connections` with `connection_status = not_connected`, and the generic
 * reader has always returned it. Pinterest’s rows were the asymmetry — they
 * vanished from Settings the moment they were disconnected.
 *
 * Deliberately a SEPARATE entry point rather than a widened `listConnections`:
 * the publish paths must not silently start seeing dead accounts because someone
 * changed a default.
 */
export async function listConnectionsForSettings(uid: string): Promise<SocialConnection[]> {
  return listConnections(uid, { includeDisconnected: true });
}

/** Per-platform summary for all four platforms (connected + not-connected). */
export async function summarizeConnections(uid: string): Promise<PlatformConnectionSummary[]> {
  const connections = await listConnections(uid);
  return summarizeConnectionList(connections);
}

export function summarizeConnectionList(connections: SocialConnection[]): PlatformConnectionSummary[] {
  return SOCIAL_PROVIDERS.map((provider): PlatformConnectionSummary => {
    const accounts = connections.filter(c => c.provider === provider);
    const usable = accounts.filter(a => a.connectionStatus === "connected");
    const primary = usable[0] ?? accounts[0] ?? null;
    return {
      provider,
      status: primary?.connectionStatus ?? "not_connected",
      connected: usable.length > 0,
      // Every row the merchant holds on this platform — a disconnected account is
      // still an account, and still holds its plan slot until it is removed. (For
      // the publish-side callers the two numbers are identical: they never see a
      // disconnected row in the first place.)
      accountCount: accounts.length,
      accountName:
        primary?.providerAccountName ?? primary?.providerAccountUsername ?? null,
      liveConnect: PLATFORMS[provider].liveConnect,
      accounts,
    };
  });
}

/** Find one connection by id for the current user (used by publish/disconnect). */
export async function findConnection(
  uid: string,
  connectionId: string,
): Promise<SocialConnection | null> {
  // Legacy synthetic id, still held by any client page loaded before this deploy.
  // Kept so an in-flight Disconnect click resolves instead of 404-ing; new reads
  // hand out the real row id, which falls through to the table lookup below.
  if (connectionId === `pinterest:${uid}`) {
    // The synthetic id could only ever mean "this user's Pinterest", i.e. the default
    // account — index 0 of the created_at-ascending list, which is what the old
    // getActiveConnection resolved for a single-account user.
    return (await readPinterestConnections(uid))[0] ?? null;
  }
  // Provider-reported (e.g. Zernio) accounts aren't stored in our DB — resolve
  // them live from the active provider.
  if (connectionId.includes(":")) {
    const provider = await readProviderConnections(uid);
    const hit = provider.find(c => c.id === connectionId);
    if (hit) return hit;
  }
  const { data, error } = await db()
    .from(TABLE)
    .select(
      "id, user_id, workspace_id, provider, provider_account_id, provider_account_name, " +
        "provider_account_username, provider_account_avatar_url, connection_status, auth_provider, " +
        "external_connection_id, scopes, token_expires_at, metadata, created_at, updated_at",
    )
    .eq("user_id", uid)
    .eq("id", connectionId)
    .maybeSingle();

  if (error) {
    if (isMissingSocialConnectionsTable(error)) return null;
    console.error("[social] find connection:", error.message);
    return null;
  }
  return data ? rowToSafe(data as unknown as SocialConnectionRow) : null;
}

/** Remove a stored connection (Pinterest disconnect is handled by its own route). */
export async function deleteConnection(uid: string, connectionId: string): Promise<void> {
  const { error } = await db().from(TABLE).delete().eq("user_id", uid).eq("id", connectionId);
  if (error && !isMissingSocialConnectionsTable(error)) {
    throw new Error(error.message);
  }
}
