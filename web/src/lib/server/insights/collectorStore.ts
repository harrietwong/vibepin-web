import "server-only";

/**
 * Persistence for the v64 Insights collection layer.
 *
 * Every function here degrades to a no-op when the v64 tables are absent. That is
 * not defensive habit, it is a deployment ordering requirement: this code ships to
 * production BEFORE the migration is applied there (the migration is applied to the
 * test project only, and production apply is a human decision). A collector that
 * threw on a missing table would take the live Insights dashboard down with it —
 * `ownerConnectionForPin` is called on the request path.
 *
 * The rule is therefore: a missing table means "no data", never an exception. A
 * REAL error (permissions, constraint violation, connectivity) still propagates —
 * silently swallowing those is how a collector ends up reporting healthy runs while
 * writing nothing.
 */

import { createServerClient } from "@/lib/supabase";
import type {
  ObservationDraft,
  PendingTask,
  PinTaskDraft,
  PinTaskKind,
  RegistryCursorState,
  RegistrySource,
} from "./collectorLogic";
import { OBSERVATION_API_VERSION, dedupeObservationDrafts, resolveRegistrySource } from "./collectorLogic";

type PostgrestErrorLike = { code?: string; message?: string } | null;

/**
 * Missing table/column/view — the v64 migration has not been applied here yet.
 * Mirrors `isMissingTable` in vibepinPublishedPins.ts and publish-due's
 * `isMissingSchemaError`; kept local so a change in one cannot silently alter the
 * others' behaviour.
 */
export function isMissingSchema(error: PostgrestErrorLike): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    error.code === "42P01"        // undefined_table
    || error.code === "PGRST205"  // PostgREST: table not found in schema cache
    || error.code === "PGRST204"  // PostgREST: column not found
    || error.code === "42703"     // undefined_column
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"))
    || (message.includes("Could not find the") && message.includes("column"))
  );
}

export type CollectionRunKind = "account_daily" | "registry" | "pin_task" | "on_demand";

export type CollectionRunSummary = {
  id: string | null;
  kind: CollectionRunKind;
  callsMade: number;
  callsBudget: number;
  skippedReason: string | null;
  error: string | null;
};

/** Opens a ledger row. A null id means the schema is absent: the run still executes
 *  and reports, it simply has nowhere to record itself. */
export async function startCollectionRun(
  connectionId: string,
  userId: string,
  kind: CollectionRunKind,
  callsBudget: number,
): Promise<string | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("collection_run")
    .insert({
      connection_id: connectionId,
      vibepin_user_id: userId,
      kind,
      calls_budget: callsBudget,
    })
    .select("id")
    .single();
  if (error) {
    if (isMissingSchema(error)) return null;
    throw new Error(`Unable to open collection_run: ${error.message}`);
  }
  return (data?.id as string) ?? null;
}

export async function finishCollectionRun(
  runId: string | null,
  summary: { callsMade: number; skippedReason?: string | null; error?: string | null },
): Promise<void> {
  if (!runId) return;
  const db = createServerClient();
  const { error } = await db
    .from("collection_run")
    .update({
      finished_at: new Date().toISOString(),
      calls_made: summary.callsMade,
      skipped_reason: summary.skippedReason ?? null,
      // Truncated: an upstream error body can be arbitrarily long and this column is
      // for diagnosis, not for storing responses.
      error: summary.error ? summary.error.slice(0, 500) : null,
    })
    .eq("id", runId);
  if (error && !isMissingSchema(error)) {
    throw new Error(`Unable to close collection_run: ${error.message}`);
  }
}

/** Calls already spent by this connection today (UTC), across every run. The daily
 *  budget is only meaningful if it is read from the ledger rather than assumed. */
export async function callsSpentToday(connectionId: string, now = new Date()): Promise<number> {
  const db = createServerClient();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { data, error } = await db
    .from("collection_run")
    .select("calls_made")
    .eq("connection_id", connectionId)
    .gte("started_at", startOfDay.toISOString());
  if (error) {
    if (isMissingSchema(error)) return 0;
    throw new Error(`Unable to read today's collection budget: ${error.message}`);
  }
  return (data ?? []).reduce((total, row) => total + (Number(row.calls_made) || 0), 0);
}

/**
 * Append observations.
 *
 * A plain INSERT, deliberately — not an upsert. The run-scoped unique index is on
 * COALESCE expressions (the sentinels that make the two nullable columns
 * deduplicate), and PostgREST's `on_conflict` can only name plain columns, which
 * Postgres cannot match to an expression index: every call would fail with 42P10
 * ("no unique or exclusion constraint matching the ON CONFLICT specification"). The
 * index is an integrity backstop here, not an upsert target.
 *
 * Retry safety therefore comes from two places instead: drafts are deduplicated in
 * memory before the insert, and a 23505 from the database is treated as "these rows
 * are already recorded" rather than an error. Collisions are near-impossible in
 * practice because each invocation opens a fresh collection_run id and the key is
 * run-scoped, but a retried insert inside one run must not fail the run.
 */
export async function insertObservations(
  connectionId: string,
  userId: string,
  runId: string | null,
  drafts: ObservationDraft[],
): Promise<number> {
  if (!runId || drafts.length === 0) return 0;
  const db = createServerClient();
  const rows = dedupeObservationDrafts(drafts).map(draft => ({
    connection_id: connectionId,
    vibepin_user_id: userId,
    scope: draft.scope,
    platform_content_id: draft.platformContentId,
    metric_name: draft.metricName,
    period: draft.period,
    period_date: draft.periodDate,
    metric_value: draft.metricValue,
    status: draft.status,
    collection_run_id: runId,
    api_version: OBSERVATION_API_VERSION,
    organic: true,
  }));
  const { error } = await db.from("metric_observation").insert(rows);
  if (error) {
    if (isMissingSchema(error)) return 0;
    // 23505: the run already wrote these observations. Append-only history means the
    // stored rows are the same rows, so there is nothing to repair and nothing to report.
    if (error.code === "23505") return 0;
    throw new Error(`Unable to write observations: ${error.message}`);
  }
  return rows.length;
}

export type RegistryUpsert = {
  platformContentId: string;
  sourceEndpoint: RegistrySource;
  vibepinDraftId?: string | null;
  publishedAt?: string | null;
  format?: string | null;
  title?: string | null;
  description?: string | null;
  linkUrl?: string | null;
  imageUrl?: string | null;
  boardId?: string | null;
  boardName?: string | null;
};

/**
 * Upsert registry rows, preserving `vibepin_publish` provenance.
 *
 * The existing source is read first because PostgREST's upsert cannot express
 * "keep the stronger label": a plain upsert would overwrite `vibepin_publish` with
 * `pins_list` on every daily scan, destroying the attribution the dashboard depends
 * on. Reading first costs one query per batch and keeps the precedence explicit.
 */
export async function upsertContentRegistry(
  connectionId: string,
  entries: RegistryUpsert[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const db = createServerClient();
  const ids = entries.map(entry => entry.platformContentId);
  const { data: existingRows, error: readError } = await db
    .from("content_registry")
    .select("platform_content_id,source_endpoint,vibepin_draft_id,image_url")
    .eq("connection_id", connectionId)
    .in("platform_content_id", ids);
  if (readError) {
    if (isMissingSchema(readError)) return 0;
    throw new Error(`Unable to read content_registry: ${readError.message}`);
  }
  const existing = new Map((existingRows ?? []).map(row => [
    String(row.platform_content_id),
    {
      source: row.source_endpoint as RegistrySource,
      draftId: row.vibepin_draft_id as string | null,
      imageUrl: (row as { image_url?: string | null }).image_url ?? null,
    },
  ]));

  const nowIso = new Date().toISOString();
  const rows = entries.map(entry => {
    const prior = existing.get(entry.platformContentId) ?? null;
    return {
      connection_id: connectionId,
      platform_content_id: entry.platformContentId,
      source_endpoint: resolveRegistrySource(prior?.source ?? null, entry.sourceEndpoint),
      // Never null out a draft id a previous publish row established.
      vibepin_draft_id: entry.vibepinDraftId ?? prior?.draftId ?? null,
      published_at: entry.publishedAt ?? null,
      format: entry.format ?? null,
      title: entry.title ?? null,
      description: entry.description ?? null,
      link_url: entry.linkUrl ?? null,
      // Same rule as the draft id: a pass that did not carry an image (top_pins
      // returns metrics only) must not erase the URL a listing pass already stored.
      // The thumbnail is the whole reason the page no longer calls Pinterest.
      image_url: entry.imageUrl ?? prior?.imageUrl ?? null,
      board_id: entry.boardId ?? null,
      board_name: entry.boardName ?? null,
      last_seen_at: nowIso,
      last_metadata_refresh_at: nowIso,
    };
  });

  const { error } = await db
    .from("content_registry")
    .upsert(rows, { onConflict: "connection_id,platform_content_id" });
  if (error) {
    if (isMissingSchema(error)) return 0;
    throw new Error(`Unable to write content_registry: ${error.message}`);
  }
  return rows.length;
}

export async function readRegistryCursor(connectionId: string): Promise<RegistryCursorState | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("registry_cursor")
    .select("bookmark,full_started_at,full_completed_at,pages_fetched,reconciliation_pending")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return null;
    throw new Error(`Unable to read registry_cursor: ${error.message}`);
  }
  if (!data) return null;
  return {
    bookmark: (data.bookmark as string | null) ?? null,
    fullStartedAt: (data.full_started_at as string | null) ?? null,
    fullCompletedAt: (data.full_completed_at as string | null) ?? null,
    pagesFetched: Number(data.pages_fetched) || 0,
    reconciliationPending: Boolean(data.reconciliation_pending),
  };
}

export async function writeRegistryCursor(
  connectionId: string,
  cursor: RegistryCursorState,
): Promise<void> {
  const db = createServerClient();
  const { error } = await db
    .from("registry_cursor")
    .upsert({
      connection_id: connectionId,
      bookmark: cursor.bookmark,
      full_started_at: cursor.fullStartedAt,
      full_completed_at: cursor.fullCompletedAt,
      pages_fetched: cursor.pagesFetched,
      reconciliation_pending: cursor.reconciliationPending,
    }, { onConflict: "connection_id" });
  if (error && !isMissingSchema(error)) {
    throw new Error(`Unable to write registry_cursor: ${error.message}`);
  }
}

/** Create measurement points. Do-nothing on conflict: the tasks for a Pin are
 *  created once and their history (attempts, cancellations) must survive re-runs. */
export async function createPinTasks(drafts: PinTaskDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const db = createServerClient();
  const { error } = await db
    .from("pin_task")
    .upsert(drafts.map(draft => ({
      connection_id: draft.connectionId,
      platform_content_id: draft.platformContentId,
      kind: draft.kind,
      due_at: draft.dueAt,
      window_until: draft.windowUntil,
      priority: draft.priority,
    })), { onConflict: "connection_id,platform_content_id,kind", ignoreDuplicates: true });
  if (error) {
    if (isMissingSchema(error)) return 0;
    throw new Error(`Unable to create pin_task rows: ${error.message}`);
  }
  return drafts.length;
}

export async function listPendingTasks(connectionId: string): Promise<PendingTask[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("pin_task")
    .select("id,connection_id,platform_content_id,kind,due_at,window_until,priority,attempts")
    .eq("connection_id", connectionId)
    .eq("status", "pending")
    .order("priority", { ascending: true })
    .order("due_at", { ascending: true })
    .limit(500);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw new Error(`Unable to read pin_task rows: ${error.message}`);
  }
  return (data ?? []).map(row => ({
    id: Number(row.id),
    connectionId: String(row.connection_id),
    platformContentId: String(row.platform_content_id),
    kind: row.kind as PinTaskKind,
    dueAt: String(row.due_at),
    windowUntil: String(row.window_until),
    priority: Number(row.priority),
    attempts: Number(row.attempts) || 0,
  }));
}

export async function cancelTasks(ids: number[], reason: string): Promise<number> {
  if (ids.length === 0) return 0;
  const db = createServerClient();
  const { error } = await db
    .from("pin_task")
    .update({ status: "cancelled", cancel_reason: reason })
    .in("id", ids)
    .eq("status", "pending");
  if (error) {
    if (isMissingSchema(error)) return 0;
    throw new Error(`Unable to cancel pin_task rows: ${error.message}`);
  }
  return ids.length;
}

export async function markTaskDone(id: number, attempts: number): Promise<void> {
  const db = createServerClient();
  const { error } = await db
    .from("pin_task")
    .update({
      status: "done",
      done_at: new Date().toISOString(),
      last_attempt_at: new Date().toISOString(),
      attempts,
    })
    .eq("id", id);
  if (error && !isMissingSchema(error)) {
    throw new Error(`Unable to complete pin_task: ${error.message}`);
  }
}

/** A failed attempt leaves the task PENDING: the window is what decides whether it
 *  is still worth trying, not the number of failures. */
export async function recordTaskAttempt(id: number, attempts: number): Promise<void> {
  const db = createServerClient();
  const { error } = await db
    .from("pin_task")
    .update({ attempts, last_attempt_at: new Date().toISOString() })
    .eq("id", id);
  if (error && !isMissingSchema(error)) {
    throw new Error(`Unable to record pin_task attempt: ${error.message}`);
  }
}

/**
 * The connection that owns a Pin, per the registry — the durable answer used to
 * attribute legacy drafts whose payload never recorded a target.
 *
 * Scoped to the user's own connections by the caller's connection id list, so this
 * cannot be used to probe another account's ownership.
 */
export async function ownerConnectionForPin(
  connectionIds: string[],
  platformContentId: string,
): Promise<string | null> {
  if (connectionIds.length === 0) return null;
  const db = createServerClient();
  const { data, error } = await db
    .from("content_registry")
    .select("connection_id,platform_content_id,source_endpoint")
    .in("connection_id", connectionIds)
    .eq("platform_content_id", platformContentId);
  if (error) {
    if (isMissingSchema(error)) return null;
    throw new Error(`Unable to read content_registry ownership: ${error.message}`);
  }
  const rows = (data ?? []).map(row => ({
    connectionId: String(row.connection_id),
    platformContentId: String(row.platform_content_id),
    sourceEndpoint: row.source_endpoint as RegistrySource,
  }));
  if (rows.length === 0) return null;
  const published = rows.find(row => row.sourceEndpoint === "vibepin_publish");
  return (published ?? rows[0]).connectionId;
}

/** Registry ownership for MANY Pins at once — the dashboard needs one query, not
 *  one per Pin. Returns pinId → owning connection id. */
export async function ownerConnectionsForPins(
  connectionIds: string[],
  platformContentIds: string[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (connectionIds.length === 0 || platformContentIds.length === 0) return owners;
  const db = createServerClient();
  const { data, error } = await db
    .from("content_registry")
    .select("connection_id,platform_content_id,source_endpoint")
    .in("connection_id", connectionIds)
    .in("platform_content_id", platformContentIds);
  if (error) {
    if (isMissingSchema(error)) return owners;
    throw new Error(`Unable to read content_registry ownership: ${error.message}`);
  }
  for (const row of data ?? []) {
    const pinId = String(row.platform_content_id);
    const isPublish = row.source_endpoint === "vibepin_publish";
    // vibepin_publish wins over a discovery row for the same Pin.
    if (!owners.has(pinId) || isPublish) owners.set(pinId, String(row.connection_id));
  }
  return owners;
}
