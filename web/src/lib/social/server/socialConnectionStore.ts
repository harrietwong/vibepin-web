/**
 * Server-only persistence + projection for multi-platform social connections.
 *
 * Responsibilities:
 *   - Read/write the social_connections table (service-role, RLS-bypassing).
 *   - Unify Pinterest's dedicated OAuth table (pinterest_connections) into the
 *     same SocialConnection shape, so the UI sees one consistent model.
 *   - Only ever return client-safe projections — token ciphertext never leaves
 *     this module.
 *   - Degrade gracefully when the v32 tables have not been applied yet (missing
 *     table → treated as "no rows", never a 500).
 */

import { createServerClient } from "@/lib/supabase";
import { getActiveConnection, toSafeStatus } from "@/lib/server/pinterest/connectionStore";
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
  // Prefer a live connection; fall back to the oldest row so a user who has
  // disconnected everything still keeps the default board they had chosen.
  const chosen = rows.find(r => !r.disconnected_at) ?? rows[0];
  return { id: chosen.id, metadata: (chosen.metadata ?? {}) as Record<string, unknown> };
}

async function readPinterestMetadata(uid: string): Promise<Record<string, unknown>> {
  return (await readPinterestRow(uid))?.metadata ?? {};
}

export async function getPinterestDefaultBoard(uid: string): Promise<{ boardId: string; boardName: string | null } | null> {
  return readDefaultBoardFromMetadata(await readPinterestMetadata(uid));
}

export async function savePinterestDefaultBoard(
  uid: string,
  board: { boardId: string; boardName?: string | null },
): Promise<{ boardId: string; boardName: string | null } | null> {
  const boardId = board.boardId.trim();
  if (!boardId) return null;
  const boardName = board.boardName?.trim() || null;
  const now = new Date().toISOString();

  const existing = await readPinterestRow(uid);

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
async function readPinterestConnection(uid: string): Promise<SocialConnection | null> {
  let row;
  let safe;
  try {
    row = await getActiveConnection(uid);
    safe = toSafeStatus(row);
  } catch {
    // Pinterest storage errors shouldn't sink the whole social view.
    return null;
  }
  if (!safe.connected || !row) return null;
  const status: ConnectionStatus = safe.needsReconnect ? "expired" : "connected";
  const metadata = await readPinterestMetadata(uid);
  if (safe.account?.accountType) metadata.accountType = safe.account.accountType;
  return {
    id: row.id,
    provider: "pinterest",
    workspaceId: null,
    providerAccountId: safe.account?.id ?? null,
    providerAccountName: safe.account?.username ? `@${safe.account.username}` : null,
    providerAccountUsername: safe.account?.username ?? null,
    providerAccountAvatarUrl: null,
    connectionStatus: status,
    authProvider: "official",
    externalConnectionId: null,
    scopes: safe.scopes,
    tokenExpiresAt: null,
    metadata,
    createdAt: null,
    updatedAt: safe.lastSyncedAt,
  };
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

/** Full list of connected accounts across every provider, safe to send to the client. */
export async function listConnections(uid: string): Promise<SocialConnection[]> {
  const [pinterest, stored, provider] = await Promise.all([
    readPinterestConnection(uid),
    readStoredConnections(uid),
    readProviderConnections(uid),
  ]);
  // De-dupe by id so a DB row and a provider-reported row don't both appear.
  const merged = new Map<string, SocialConnection>();
  for (const c of [...stored, ...provider]) merged.set(c.id, c);
  return [...(pinterest ? [pinterest] : []), ...merged.values()];
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
    return readPinterestConnection(uid);
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
