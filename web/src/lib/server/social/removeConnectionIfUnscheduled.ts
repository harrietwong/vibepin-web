/**
 * removeConnectionIfUnscheduled.ts — the ONE call that is allowed to delete a
 * social account row, and the reason it is not a plain delete.
 *
 * Both remove routes used to count the schedules pointing at an account and then,
 * a few milliseconds later, delete the row. A schedule created in another tab
 * inside that window survived the delete and went on naming a connection that no
 * longer exists: the cron picks it up forever, fails, and nothing in the product
 * can explain why, because the account it names is gone (Codex P0 #1).
 *
 * PostgREST has no read-modify-write transaction, so the fix is not another JS
 * ordering: the check and the delete are ONE SQL statement inside
 * `public.remove_social_connection_if_unscheduled` (backend/db/migrate_v67_*.sql),
 * evaluated against a single snapshot. This module is the only caller.
 *
 * FAIL CLOSED. When the function is not there (the migration has not been
 * applied) this reports `unavailable` and the routes answer 503. It deliberately
 * does NOT fall back to the plain delete: the fallback IS the bug, and a
 * migration lag would silently restore it on exactly the accounts it can hurt.
 * That is the opposite trade from the schedule COUNT readers, which degrade a
 * missing table to "nothing is scheduled" — those can only cost a prompt, this
 * costs a merchant's schedules.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const REMOVE_CONNECTION_RPC = "remove_social_connection_if_unscheduled";

/**
 * What the delete step did. Three outcomes, and the caller must not merge them:
 *
 *  - "deleted"      — the row is gone.
 *  - "blocked"      — live schedules still target it; NOTHING was deleted. The
 *                     count is the server's, taken at the instant of the attempt,
 *                     so it is the number the dialog must show.
 *  - "already_gone" — nothing matched. The row was deleted by an earlier attempt
 *                     (both routes are documented idempotent) or never belonged
 *                     to this user. Success, not a refusal.
 *  - "unavailable"  — the RPC is not deployed, or the call itself failed. We do
 *                     not know whether removing is safe, so we do not remove.
 */
export type RemoveConnectionResult =
  | { outcome: "deleted" }
  | { outcome: "blocked"; scheduledCount: number }
  | { outcome: "already_gone" }
  | { outcome: "unavailable"; reason: string };

/** The RPC surface, kept loose so tests can hand in a recorder instead of a client. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RpcLike {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: any; error: any }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The function is missing — the migration has not run on this database.
 *
 * Matched NARROWLY. A bad argument (22P02: the legacy synthetic `pinterest:<uid>`
 * id, or a provider-reported id, is not a uuid) is a different failure with a
 * different meaning, and folding it in here would report "the feature is not
 * deployed" for a request that was simply not about a stored row.
 */
function isMissingFunctionError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "42883"        // undefined_function
    || err.code === "PGRST202"  // PostgREST: function not found in schema cache
    || message.includes("Could not find the function")
  );
}

/** The row PostgREST returns for a `returns table(...)` function. */
type RpcRow = { deleted?: unknown; scheduled_count?: unknown };

/**
 * Delete the connection, but only while nothing is still scheduled through it.
 *
 * `p_user_id` is passed explicitly (rather than relying on auth.uid()) because the
 * caller is the service role: the function is `security definer` and its own
 * `user_id` predicate is what scopes the delete to this merchant.
 */
export async function removeConnectionIfUnscheduled(
  db: RpcLike | SupabaseClient,
  uid: string,
  connectionId: string,
): Promise<RemoveConnectionResult> {
  const { data, error } = await (db as RpcLike).rpc(REMOVE_CONNECTION_RPC, {
    p_user_id: uid,
    p_connection_id: connectionId,
  });

  if (error) {
    if (isMissingFunctionError(error)) {
      console.error(`[social/remove] ${REMOVE_CONNECTION_RPC} is not deployed — refusing to delete`);
      return { outcome: "unavailable", reason: "rpc_missing" };
    }
    console.error(`[social/remove] ${REMOVE_CONNECTION_RPC} failed:`, error.message);
    return { outcome: "unavailable", reason: error.message ?? "rpc_error" };
  }

  // `returns table(...)` arrives as an array of one row; a single-row shape is
  // accepted too so a client wrapper that unwraps it does not break the contract.
  const row: RpcRow | null = Array.isArray(data)
    ? ((data[0] ?? null) as RpcRow | null)
    : ((data ?? null) as RpcRow | null);
  if (!row) {
    // The function always projects exactly one row. No row means we did not
    // actually reach it, and guessing "deleted" here would be the fallback we
    // just removed.
    console.error(`[social/remove] ${REMOVE_CONNECTION_RPC} returned no row`);
    return { outcome: "unavailable", reason: "rpc_empty" };
  }

  const count = Number(row.scheduled_count ?? 0);
  const scheduledCount = Number.isFinite(count) && count > 0 ? count : 0;
  if (row.deleted === true) return { outcome: "deleted" };
  if (scheduledCount > 0) return { outcome: "blocked", scheduledCount };
  return { outcome: "already_gone" };
}

/**
 * The customer-readable refusal when the guard itself is not available.
 *
 * Deliberately does not mention migrations: the merchant can only retry, and the
 * one thing they must take away is that the account is STILL THERE.
 */
export function removeUnavailableMessage(): string {
  return "We couldn't safely remove this account right now, so nothing was changed. Please try again in a few minutes.";
}
