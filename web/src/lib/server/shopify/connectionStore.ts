/**
 * Persistence for per-user Shopify store connections (server-only, WP1).
 *
 * Mirrors web/src/lib/server/pinterest/connectionStore.ts: access tokens are
 * encrypted (AES-256-GCM, SHOPIFY_TOKEN_ENCRYPTION_KEY) before they touch the
 * database and decrypted only here, immediately before an Admin API call.
 * Tokens are NEVER returned to callers that build API responses — use
 * toSafeStatus() for anything client-facing.
 *
 * Sync state (决策 4 / 裁决 j): status + cursor + run id + lock expiry all live
 * on the store_connections row. Lock acquisition is a CAS-style conditional
 * UPDATE (see acquireSyncLock); chunk writes are guarded by sync_run_id so a
 * stale chunk from a superseded run can never clobber progress.
 */

import { createServerClient } from "../../supabase";
import { createTokenCipher } from "../crypto";

const TABLE = "store_connections";

/** Sync lock TTL (§3.4): each chunk renews it; an expired lock may be taken over. */
export const SYNC_LOCK_TTL_MS = 120_000;

/** Cipher bound to the Shopify token key (shared with WP2 oauthState sealing). */
export const shopifyTokenCipher = createTokenCipher("SHOPIFY_TOKEN_ENCRYPTION_KEY");

// ── Errors (isMissingTableError pattern from server/pinterest/errors.ts) ─────

export class StoreDatabaseError extends Error {
  code = "database_error";
  constructor(message = "Store connection storage is unavailable") {
    super(message);
    this.name = "StoreDatabaseError";
  }
}

/** True when the failure means the v39 tables are not applied yet (裁决 i). */
export function isMissingTableError(code: string | undefined, message: string): boolean {
  return (
    code === "PGRST205"
    || code === "42P01"
    || message.includes("Could not find the table")
    || /relation .* does not exist/i.test(message)
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type StoreConnectionStatus =
  | "connected"
  | "degraded"
  | "reauth_required"
  | "disconnected";

export type SyncStatus = "idle" | "running" | "completed" | "limit_reached" | "error";

export type StoreConnectionRow = {
  id: string;
  vibepin_user_id: string;
  provider: string;
  shop_domain: string;
  shop_name: string | null;
  primary_domain: string | null;
  access_token_encrypted: string | null;
  scopes: string[] | null;
  status: StoreConnectionStatus;
  sync_status: SyncStatus;
  sync_cursor: string | null;
  sync_run_id: string | null;
  sync_lock_expires_at: string | null;
  sync_started_at: string | null;
  sync_error: string | null;
  synced_count: number;
  total_count: number | null;
  last_full_sync_at: string | null;
  last_incremental_sync_at: string | null;
  uninstalled_at: string | null;
  disconnected_at: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertConnectionInput = {
  shopDomain: string;
  accessToken: string;
  scopes: string[];
  shopName?: string | null;
  primaryDomain?: string | null;
};

export type SafeSyncStatus = {
  status: SyncStatus;
  syncedCount: number;
  totalCount: number | null;
  cursor: string | null;
  error: string | null;
  startedAt: string | null;
  /** True when an errored run kept its cursor and "Sync now" can resume it. */
  resumable: boolean;
};

/** Client-safe projection of a connection row — token material never appears. */
export type SafeConnectionStatus = {
  id: string;
  shopDomain: string;
  shopName: string | null;
  primaryDomain: string | null;
  status: StoreConnectionStatus;
  scopes: string[];
  lastFullSyncAt: string | null;
  uninstalledAt: string | null;
  disconnectedAt: string | null;
  updatedAt: string | null;
  sync: SafeSyncStatus;
};

// ── DB client (test-injectable) ───────────────────────────────────────────────

type DbClient = ReturnType<typeof createServerClient>;

let dbOverride: DbClient | null = null;

/** Test-only: inject a mock Supabase client (pass null to restore the real one). */
export function __setDbClientForTests(client: unknown): void {
  dbOverride = (client as DbClient | null) ?? null;
}

function db(): DbClient {
  return dbOverride ?? createServerClient();
}

export function normalizeShopDomain(shopDomain: string): string {
  return shopDomain.trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function dbError(action: string, code: string | undefined, message: string): StoreDatabaseError {
  if (isMissingTableError(code, message)) {
    return new StoreDatabaseError("Shopify store storage is not set up");
  }
  console.error(`[shopify] failed to ${action}:`, message);
  return new StoreDatabaseError("Shopify store connection could not be loaded");
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create or replace the user's connection for a shop, encrypting the token.
 * Reconnect (决策 13) reuses this path: credentials are overwritten and the
 * disconnected/uninstalled markers cleared; sync state and synced products
 * are left untouched.
 */
export async function upsertConnection(
  userId: string,
  input: UpsertConnectionInput,
): Promise<StoreConnectionRow> {
  const row = {
    vibepin_user_id: userId,
    provider: "shopify",
    shop_domain: normalizeShopDomain(input.shopDomain),
    shop_name: input.shopName ?? null,
    primary_domain: input.primaryDomain ?? null,
    access_token_encrypted: shopifyTokenCipher.encrypt(input.accessToken),
    scopes: input.scopes,
    status: "connected",
    uninstalled_at: null,
    disconnected_at: null,
    updated_at: nowIso(),
  };

  const { data, error } = await db()
    .from(TABLE)
    .upsert(row, { onConflict: "vibepin_user_id,shop_domain" })
    .select("*")
    .single();

  if (error || !data) {
    throw dbError("persist store connection", error?.code, error?.message ?? "no row returned");
  }
  return data as StoreConnectionRow;
}

/**
 * All of the user's connections (including disconnected ones — Settings shows
 * history). Missing table (v39 not applied) degrades to [] (裁决 i).
 */
export async function listConnections(userId: string): Promise<StoreConnectionRow[]> {
  const { data, error } = await db()
    .from(TABLE)
    .select("*")
    .eq("vibepin_user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingTableError(error.code, error.message)) return [];
    throw dbError("list store connections", error.code, error.message);
  }
  return (data ?? []) as StoreConnectionRow[];
}

/** One connection by id, scoped to the user. Missing table → null. */
export async function getConnection(
  userId: string,
  id: string,
): Promise<StoreConnectionRow | null> {
  const { data, error } = await db()
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .eq("vibepin_user_id", userId)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error.code, error.message)) return null;
    throw dbError("read store connection", error.code, error.message);
  }
  return (data as StoreConnectionRow | null) ?? null;
}

/** One connection by shop domain, scoped to the user. Missing table → null. */
export async function getByShopDomain(
  userId: string,
  shopDomain: string,
): Promise<StoreConnectionRow | null> {
  const { data, error } = await db()
    .from(TABLE)
    .select("*")
    .eq("vibepin_user_id", userId)
    .eq("shop_domain", normalizeShopDomain(shopDomain))
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error.code, error.message)) return null;
    throw dbError("read store connection", error.code, error.message);
  }
  return (data as StoreConnectionRow | null) ?? null;
}

/** Decrypt the stored Admin API access token. Throws if the row has none. */
export function decryptAccessToken(row: StoreConnectionRow): string {
  if (!row.access_token_encrypted) {
    throw new Error("Store connection has no stored access token");
  }
  return shopifyTokenCipher.decrypt(row.access_token_encrypted);
}

// ── Sync state primitives (§3.4 state machine) ───────────────────────────────

/**
 * CAS lock acquisition: atomically move the row to running + a fresh lock, but
 * ONLY when it is not already running with a live lock:
 *
 *   update ... set sync_status='running', sync_run_id=:runId, lock=now()+TTL
 *   where id=:id and vibepin_user_id=:userId
 *     and (sync_status <> 'running' or sync_lock_expires_at < now())
 *
 * Supabase REST has no transactions, but a single conditional UPDATE is atomic
 * in Postgres; the returned row tells us whether we won the race. Returns the
 * updated row when the lock was acquired, null when another run holds a live
 * lock (route maps that to 409 sync_in_progress).
 *
 * `freshRun: true` starts a new run (cursor/counters/error reset and
 * sync_started_at stamped — terminal-state restart per §3.4). Without it the
 * caller resumes from the persisted cursor (error retry / expired-lock takeover),
 * keeping sync_started_at so the completion tombstone sweep still covers the
 * whole logical run.
 */
export async function acquireSyncLock(
  id: string,
  userId: string,
  runId: string,
  opts?: { freshRun?: boolean },
): Promise<StoreConnectionRow | null> {
  const now = new Date();
  const nowValue = now.toISOString();
  const patch: Record<string, unknown> = {
    sync_status: "running",
    sync_run_id: runId,
    sync_lock_expires_at: new Date(now.getTime() + SYNC_LOCK_TTL_MS).toISOString(),
    updated_at: nowValue,
  };
  if (opts?.freshRun) {
    patch.sync_cursor = null;
    patch.synced_count = 0;
    patch.total_count = null;
    patch.sync_error = null;
    patch.sync_started_at = nowValue;
  }

  const { data, error } = await db()
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .eq("vibepin_user_id", userId)
    .or(`sync_status.neq.running,sync_lock_expires_at.lt."${nowValue}"`)
    .select("*")
    .maybeSingle();

  if (error) throw dbError("acquire sync lock", error.code, error.message);
  return (data as StoreConnectionRow | null) ?? null;
}

/**
 * Heartbeat: extend the lock for the given run. Returns false when the run no
 * longer owns the row (superseded run id or no longer running).
 */
export async function renewSyncLock(id: string, runId: string): Promise<boolean> {
  const { data, error } = await db()
    .from(TABLE)
    .update({
      sync_lock_expires_at: new Date(Date.now() + SYNC_LOCK_TTL_MS).toISOString(),
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("sync_run_id", runId)
    .eq("sync_status", "running")
    .select("id")
    .maybeSingle();

  if (error) throw dbError("renew sync lock", error.code, error.message);
  return Boolean(data);
}

/**
 * Persist chunk progress (cursor + running total) and renew the lock. The
 * update is guarded by sync_run_id so a stale chunk from a superseded run
 * writes nothing (§3.4). Returns the updated row, or null when the run was
 * superseded — the caller must abandon the run.
 */
export async function updateSyncProgress(
  id: string,
  runId: string,
  progress: { cursor: string | null; syncedCount: number },
): Promise<StoreConnectionRow | null> {
  const { data, error } = await db()
    .from(TABLE)
    .update({
      sync_cursor: progress.cursor,
      synced_count: progress.syncedCount,
      sync_lock_expires_at: new Date(Date.now() + SYNC_LOCK_TTL_MS).toISOString(),
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("sync_run_id", runId)
    .eq("sync_status", "running")
    .select("*")
    .maybeSingle();

  if (error) throw dbError("update sync progress", error.code, error.message);
  return (data as StoreConnectionRow | null) ?? null;
}

/**
 * Non-terminal pause (WP3 §3.4 限流退避 / 分片预算): a chunk that stops with more
 * pages left (budget hit, page cap, or a persistent THROTTLED) keeps the run
 * `running` with its cursor, but expires the lock NOW so the driving client's
 * immediate next /sync chunk can take over (acquireSyncLock's expired-lock
 * branch) and resume from the cursor instead of hitting 409 sync_in_progress.
 * Guarded by sync_run_id + running so a superseded run releases nothing → false.
 */
export async function releaseSyncLock(id: string, runId: string): Promise<boolean> {
  const { data, error } = await db()
    .from(TABLE)
    .update({
      sync_lock_expires_at: new Date(Date.now() - 1_000).toISOString(),
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("sync_run_id", runId)
    .eq("sync_status", "running")
    .select("id")
    .maybeSingle();

  if (error) throw dbError("release sync lock", error.code, error.message);
  return Boolean(data);
}

export type SyncOutcome = "completed" | "limit_reached" | "error";

/**
 * Move the run to a terminal state (§3.4):
 *   completed     → cursor/lock cleared, last_full_sync_at stamped
 *   limit_reached → cursor/lock cleared, total_count recorded ("X of Y")
 *   error         → lock cleared, cursor KEPT so "Sync now" can resume
 * Guarded by sync_run_id (stale runs write nothing → null).
 */
export async function finishSync(
  id: string,
  runId: string,
  outcome: SyncOutcome,
  fields?: { error?: string | null; totalCount?: number | null; syncedCount?: number },
): Promise<StoreConnectionRow | null> {
  const now = nowIso();
  const patch: Record<string, unknown> = {
    sync_status: outcome,
    sync_lock_expires_at: null,
    updated_at: now,
  };
  if (fields?.syncedCount !== undefined) patch.synced_count = fields.syncedCount;
  if (fields?.totalCount !== undefined) patch.total_count = fields.totalCount;

  if (outcome === "completed") {
    patch.sync_cursor = null;
    patch.sync_error = null;
    patch.last_full_sync_at = now;
  } else if (outcome === "limit_reached") {
    patch.sync_cursor = null;
    patch.sync_error = null;
  } else {
    // error: keep sync_cursor for resume.
    patch.sync_error = fields?.error ?? "Sync failed";
  }

  const { data, error } = await db()
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .eq("sync_run_id", runId)
    .select("*")
    .maybeSingle();

  if (error) throw dbError("finish sync", error.code, error.message);
  return (data as StoreConnectionRow | null) ?? null;
}

// ── Status transitions ───────────────────────────────────────────────────────

/** Flag a connection whose token was rejected (401/invalid) — UI shows Reconnect. */
export async function markReauthRequired(id: string): Promise<boolean> {
  const { data, error } = await db()
    .from(TABLE)
    .update({ status: "reauth_required", updated_at: nowIso() })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) throw dbError("mark reauth required", error.code, error.message);
  return Boolean(data);
}

/**
 * app/uninstalled webhook: mark every active connection for the shop domain
 * as uninstalled + disconnected and drop the (already revoked) token. Returns
 * the affected (id, user) pairs so the caller can tombstone products.
 * Missing table degrades to [] — webhooks must never 500 on that.
 */
export async function markUninstalled(
  shopDomain: string,
): Promise<Array<{ id: string; vibepin_user_id: string }>> {
  const now = nowIso();
  const { data, error } = await db()
    .from(TABLE)
    .update({
      status: "disconnected",
      access_token_encrypted: null,
      uninstalled_at: now,
      disconnected_at: now,
      sync_status: "idle",
      sync_cursor: null,
      sync_run_id: null,
      sync_lock_expires_at: null,
      updated_at: now,
    })
    .eq("shop_domain", normalizeShopDomain(shopDomain))
    .is("disconnected_at", null)
    .select("id, vibepin_user_id");

  if (error) {
    if (isMissingTableError(error.code, error.message)) return [];
    throw dbError("mark uninstalled", error.code, error.message);
  }
  return (data ?? []) as Array<{ id: string; vibepin_user_id: string }>;
}

/**
 * User-initiated disconnect: drop the token and mark the row disconnected
 * (token revocation + product tombstoning happen in the route/store above
 * this call). Returns false when no matching row existed.
 */
export async function disconnect(id: string, userId: string): Promise<boolean> {
  const now = nowIso();
  const { data, error } = await db()
    .from(TABLE)
    .update({
      status: "disconnected",
      access_token_encrypted: null,
      disconnected_at: now,
      sync_status: "idle",
      sync_cursor: null,
      sync_run_id: null,
      sync_lock_expires_at: null,
      updated_at: now,
    })
    .eq("id", id)
    .eq("vibepin_user_id", userId)
    .select("id")
    .maybeSingle();

  if (error) throw dbError("disconnect store", error.code, error.message);
  return Boolean(data);
}

// ── Safe projection ──────────────────────────────────────────────────────────

/**
 * Client-safe status projection — token material NEVER appears. Fields are
 * constructed explicitly (never spread from the row) so new sensitive columns
 * can't leak by accident.
 */
export function toSafeStatus(row: StoreConnectionRow): SafeConnectionStatus {
  const status: StoreConnectionStatus = row.disconnected_at
    ? "disconnected"
    : !row.access_token_encrypted
      ? "reauth_required"
      : row.status;

  return {
    id: row.id,
    shopDomain: row.shop_domain,
    shopName: row.shop_name ?? null,
    primaryDomain: row.primary_domain ?? null,
    status,
    scopes: row.scopes ?? [],
    lastFullSyncAt: row.last_full_sync_at ?? null,
    uninstalledAt: row.uninstalled_at ?? null,
    disconnectedAt: row.disconnected_at ?? null,
    updatedAt: row.updated_at ?? null,
    sync: {
      status: row.sync_status,
      syncedCount: row.synced_count ?? 0,
      totalCount: row.total_count ?? null,
      cursor: row.sync_cursor ?? null,
      error: row.sync_error ?? null,
      startedAt: row.sync_started_at ?? null,
      resumable: row.sync_status === "error" && Boolean(row.sync_cursor),
    },
  };
}
