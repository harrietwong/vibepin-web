/**
 * scheduledForConnection.ts — "what is still scheduled to publish through THIS
 * Pinterest connection", plus the payload patch that cancels it.
 *
 * Why this exists (Phase D ③): removing one account of several must not silently
 * strand the Pins that were pinned to it. Before the Remove we count them; the user
 * then chooses Keep (leave them scheduled — Phase C's `target_disconnected` retry
 * block is what stops them at publish time) or Cancel (un-schedule them here).
 *
 * The口径 that matters: a scheduled Pin's server-side truth is a `pin_drafts` row
 * with a non-null `scheduled_at` (the v42 promoted column the cron scans), and its
 * target lives inside the JSON `payload.targetConnectionId` (Phase C). The client
 * store (pinDraftStore) holds the same fields but the cron never reads it — so both
 * the count and the cancel MUST be done against the table, or the cron keeps
 * publishing from rows the UI believes it cancelled.
 *
 * The filters below deliberately mirror the cron's own due-scan predicate
 * (api/cron/publish-due/route.ts): scheduled_at not null, deleted_at null,
 * archived_at null. Drafts with NO targetConnectionId are excluded on purpose —
 * they are not pinned to this account, they resolve a default connection at publish
 * time and will simply resolve to a surviving account after the removal.
 */

export const PIN_DRAFTS_TABLE = "pin_drafts";

/**
 * The payload patch that un-schedules a draft.
 *
 * Clears the three client-visible scheduling fields AND bumps `updatedAt`. The bump
 * is load-bearing, not cosmetic: the client's mergeServerDrafts is last-write-wins on
 * `payload.updatedAt` (pinDraftStore, local wins on tie). Without it, the browser's
 * copy still looks newer, gets pushed back on the next sync, and re-arms
 * `scheduled_at` — the Pin the user just cancelled publishes anyway. Same reason
 * payloadAfterSuccess/payloadAfterFailure bump it.
 *
 * It does NOT touch targetConnectionId: the Pin stays pinned to the account it was
 * always meant for, so a later reconnect of that account restores the intent instead
 * of silently re-pointing the Pin somewhere else.
 */
export function payloadAfterScheduleCancelled(
  payload: Record<string, unknown>,
  nowIso: string,
): Record<string, unknown> {
  return {
    ...payload,
    updatedAt: nowIso,
    scheduledDate: "",
    scheduledTime: "",
    plannedAt: "",
  };
}

/** Trimmed string or "" — mirrors the helper style used across the publish path. */
function str(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/**
 * Does this stored payload name `connectionId` as its publish target?
 *
 * Exported so the count and the cancel agree by construction (and so the rule is
 * directly testable without a database).
 */
export function payloadTargetsConnection(
  payload: Record<string, unknown> | null | undefined,
  connectionId: string,
): boolean {
  const id = str(connectionId);
  if (!id || !payload) return false;
  return str(payload.targetConnectionId) === id;
}

/** Minimal row shape the count/cancel work with. */
export interface ScheduledDraftRow {
  vibepin_user_id: string;
  draft_id: string;
  payload: Record<string, unknown>;
  publish_claimed_at?: string | null;
}

/**
 * The query surface we use, kept deliberately loose.
 *
 * PostgREST's generated builder types are structurally enormous and differ between
 * the select and update chains; pinning them here would either fail to accept the
 * real client or force the unit test to construct a full Supabase mock. `any` at this
 * one boundary buys a fake that records the exact filter chain — which is the thing
 * actually worth asserting (a wrong filter here means either a missed warning or a
 * cancelled schedule that belonged to another account).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DbLike {
  from(table: string): any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Apply the "still scheduled through this connection" filters. One function so the
 * count and the fetch-before-cancel can never drift apart.
 */
function scheduledForConnectionQuery(db: DbLike, uid: string, connectionId: string, cols: string) {
  return db
    .from(PIN_DRAFTS_TABLE)
    .select(cols)
    .eq("vibepin_user_id", uid)
    .eq("payload->>targetConnectionId", connectionId)
    .not("scheduled_at", "is", null)
    .is("deleted_at", null)
    .is("archived_at", null);
}

/** Missing table/column (v38/v42 not applied) ⇒ "nothing is scheduled", never a 500. */
function isMissingSchemaError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "PGRST205" || err.code === "42P01"     // missing table
    || err.code === "PGRST204" || err.code === "42703"  // missing column
    || message.includes("Could not find the table")
    || message.includes("does not exist")
  );
}

/**
 * The count, plus whether the read behind it actually worked. Identical contract
 * to the multi-platform module's `ScheduledCountOutcome`, deliberately — the two
 * remove routes make the same decision and must not disagree about what
 * "nothing is scheduled" means.
 *
 * The plain number was ambiguous exactly where it mattered: a remove route cannot
 * tell "0 scheduled" apart from "the query failed, so I am telling you 0".
 */
export type ScheduledCountOutcome = {
  /** Matching rows found. Meaningless when `readFailed` is true. */
  count: number;
  /**
   * The read failed, so `count` describes nothing. A MISSING table/column is NOT
   * a failure — the optional migration simply has not run.
   */
  readFailed: boolean;
};

/**
 * How many Pins are still scheduled through this connection, WITH the read's own
 * success in the answer.
 *
 * The form the remove route must use: the only one that can refuse to delete on a
 * transient failure rather than silently reading it as "nothing is scheduled"
 * (Codex #1).
 */
export async function countScheduledForConnectionStrict(
  db: DbLike,
  uid: string,
  connectionId: string,
): Promise<ScheduledCountOutcome> {
  if (!str(connectionId)) return { count: 0, readFailed: false };
  const { data, error } = await scheduledForConnectionQuery(db, uid, connectionId, "draft_id");
  if (error) {
    if (isMissingSchemaError(error)) return { count: 0, readFailed: false };
    console.error("[pinterest/disconnect] scheduled count failed:", error.message);
    return { count: 0, readFailed: true };
  }
  return { count: Array.isArray(data) ? data.length : 0, readFailed: false };
}

/**
 * How many Pins are still scheduled to publish through this connection.
 *
 * Degrades to 0 when the schema isn't there — a user must never be blocked from
 * removing an account because an optional migration hasn't run — AND when the read
 * itself fails. That second degradation is why this must not decide a deletion; it
 * serves the advisory GET the Remove dialog pre-loads with, where a wrong 0 costs a
 * prompt rather than a user's scheduled Pins. The authority is
 * `countScheduledForConnectionStrict`.
 */
export async function countScheduledForConnection(
  db: DbLike,
  uid: string,
  connectionId: string,
): Promise<number> {
  const { count } = await countScheduledForConnectionStrict(db, uid, connectionId);
  return count;
}

/**
 * The outcome of a cancel, in enough detail for the caller to decide whether the
 * account may now be deleted (Codex #6). Identical contract to the multi-platform
 * module's `CancelScheduledOutcome`, deliberately — the two remove routes make the
 * same decision and must not disagree about what "it worked" means.
 *
 * `cleared` alone was not enough: a read error was swallowed as "nothing is
 * scheduled" and each failed update was logged and skipped, so the route deleted
 * the connection anyway and told the merchant it had cancelled their schedules.
 */
export type CancelScheduledOutcome = {
  /** Rows successfully un-scheduled. */
  cleared: number;
  /** Rows that matched but whose update FAILED. Any non-zero value blocks a delete. */
  failed: number;
  /**
   * The candidate read itself failed, so `cleared`/`failed` describe nothing. A
   * MISSING table/column is NOT a failure — the optional migration simply has not
   * run and there is genuinely nothing scheduled.
   */
  readFailed: boolean;
};

/**
 * Un-schedule every Pin pinned to this connection.
 *
 * Every matching row is still attempted even after one fails — a partial cancel is
 * strictly better than stopping early, and the caller refuses the delete either way.
 *
 * Known and accepted for MVP: a row the cron has ALREADY claimed
 * (`publish_claimed_at` inside the 10-minute stale window) may still complete its
 * in-flight publish after this runs. Cancelling mid-flight would need a second
 * claim-aware guard in the cron; the window is minutes and the outcome is one extra
 * published Pin, not a corrupted row.
 */
export async function cancelScheduledForConnection(
  db: DbLike,
  uid: string,
  connectionId: string,
  nowIso: string,
): Promise<CancelScheduledOutcome> {
  if (!str(connectionId)) return { cleared: 0, failed: 0, readFailed: false };
  const { data, error } = await scheduledForConnectionQuery(
    db, uid, connectionId, "vibepin_user_id, draft_id, payload",
  );
  if (error) {
    if (isMissingSchemaError(error)) return { cleared: 0, failed: 0, readFailed: false };
    console.error("[pinterest/disconnect] scheduled fetch failed:", error.message);
    return { cleared: 0, failed: 0, readFailed: true };
  }

  const rows = (Array.isArray(data) ? data : []) as ScheduledDraftRow[];
  let cleared = 0;
  let failed = 0;
  for (const row of rows) {
    const { error: updateError } = await db
      .from(PIN_DRAFTS_TABLE)
      .update({
        payload: payloadAfterScheduleCancelled(row.payload ?? {}, nowIso),
        scheduled_at: null,        // drop out of the cron's due scan
        publish_claimed_at: null,  // release any stale lock so the row isn't half-held
        updated_at: nowIso,        // keep the column in step with payload.updatedAt (LWW)
      })
      .eq("vibepin_user_id", uid)
      .eq("draft_id", row.draft_id);
    if (updateError) {
      console.error("[pinterest/disconnect] schedule cancel failed:", updateError.message);
      failed++;
      continue;
    }
    cleared++;
  }
  return { cleared, failed, readFailed: false };
}
