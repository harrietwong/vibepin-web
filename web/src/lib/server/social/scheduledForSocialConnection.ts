/**
 * scheduledForSocialConnection.ts — "what is still scheduled to publish through
 * THIS social account", for ANY provider, plus the cancel that clears it.
 *
 * Sits next to `server/pinterest/scheduledForConnection.ts` rather than replacing
 * it. Pinterest's module reads `payload.targetConnectionId` — the legacy, single
 * target every historical Pin carries — and that is still the right 口径 there.
 * This one reads the multi-platform record, `payload.scheduledDestinations[]`,
 * which is the only place a Facebook or Instagram target has ever been written.
 *
 * ── The account match is done in JS, on purpose ───────────────────────────────
 * The Pinterest module can push its predicate into PostgREST because
 * `payload->>targetConnectionId` is a scalar. Matching an ELEMENT of a JSON array
 * would need a jsonb containment filter, and this module's error convention (like
 * Pinterest's) degrades a query error to "nothing is scheduled". A filter that is
 * subtly wrong would therefore not fail loudly — it would silently suppress the
 * warning dialog forever, which is precisely the failure this feature exists to
 * prevent. So the DB does the cheap, certainly-correct narrowing (this user, still
 * scheduled, not deleted/archived) and a pure exported predicate does the rest.
 *
 * ── Cancelling one destination must not cancel the others ─────────────────────
 * A Content scheduled to [Pinterest A, Facebook B] whose Facebook account is being
 * removed keeps its Pinterest leg. So the cancel STRIPS the matching entries and
 * only un-schedules the row when nothing usable is left. Clearing `scheduled_at`
 * while destinations remain would silently drop a publish the merchant still
 * wants; the reverse (empty destinations, `scheduled_at` still set) is worse still
 * — `resolveScheduledDestinations` would fall back to deriving a Pinterest intent
 * from `targetConnectionId` and the cron would publish anyway.
 */

import { isUsableDestination } from "@/lib/social/scheduledDestinations";
import type { ScheduledDestination } from "@/lib/pinDraftStore";

export const PIN_DRAFTS_TABLE = "pin_drafts";

/** Trimmed string or "" — same helper style as the Pinterest module. */
function str(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/** The stored destination list, filtered to entries that actually name an account. */
export function usableDestinations(
  payload: Record<string, unknown> | null | undefined,
): ScheduledDestination[] {
  const raw = payload?.scheduledDestinations;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isUsableDestination);
}

/**
 * Does this stored payload send anything to `connectionId`?
 *
 * Exported so the count, the cancel and the tests all agree by construction — a
 * drift here means either a missing warning or a cancelled schedule that belonged
 * to a different account.
 */
export function payloadTargetsSocialConnection(
  payload: Record<string, unknown> | null | undefined,
  connectionId: string,
): boolean {
  const id = str(connectionId);
  if (!id || !payload) return false;
  return usableDestinations(payload).some(d => str(d.socialConnectionId) === id);
}

/**
 * The payload after this account's destinations are stripped out.
 *
 * `updatedAt` is bumped unconditionally: the client's mergeServerDrafts is
 * last-write-wins on `payload.updatedAt`, so without the bump the browser's older
 * copy is pushed back on the next sync and the destination (or the whole schedule)
 * comes back to life. Same reason the Pinterest module bumps it.
 *
 * When nothing usable remains, the three client-visible scheduling fields are
 * cleared too, so the calendar and the row agree with `scheduled_at` being null.
 */
export function payloadAfterDestinationRemoved(
  payload: Record<string, unknown>,
  connectionId: string,
  nowIso: string,
): { payload: Record<string, unknown>; remaining: number } {
  const id = str(connectionId);
  const remaining = usableDestinations(payload).filter(d => str(d.socialConnectionId) !== id);
  const next: Record<string, unknown> = {
    ...payload,
    updatedAt: nowIso,
    scheduledDestinations: remaining,
  };
  if (remaining.length === 0) {
    next.scheduledDate = "";
    next.scheduledTime = "";
    next.plannedAt = "";
  }
  return { payload: next, remaining: remaining.length };
}

/** Minimal row shape the count/cancel work with. */
export interface ScheduledDraftRow {
  vibepin_user_id: string;
  draft_id: string;
  payload: Record<string, unknown>;
}

/**
 * The query surface, kept loose for the same reason as the Pinterest module: the
 * generated PostgREST builder types are enormous and differ between chains, and
 * pinning them would force the unit test to build a full Supabase mock instead of
 * a fake that records the exact filter chain.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DbLike {
  from(table: string): any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Rows that COULD be affected: this user's, still scheduled, not deleted, not
 * archived. Deliberately the same predicate the cron's due-scan uses
 * (api/cron/publish-due/route.ts) — anything it would publish, we must consider.
 * The account match itself is applied in JS by `payloadTargetsSocialConnection`.
 */
function candidateScheduledQuery(db: DbLike, uid: string) {
  return db
    .from(PIN_DRAFTS_TABLE)
    .select("vibepin_user_id, draft_id, payload")
    .eq("vibepin_user_id", uid)
    .not("scheduled_at", "is", null)
    .is("deleted_at", null)
    .is("archived_at", null);
}

/** Missing table/column (v38/v42 not applied) means "nothing is scheduled", never a 500. */
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

/** Fetch the candidate rows, or [] when the schema/query is unavailable. */
async function readCandidates(db: DbLike, uid: string, label: string): Promise<ScheduledDraftRow[]> {
  const { data, error } = await candidateScheduledQuery(db, uid);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    console.error(`[social/disconnect] ${label} failed:`, error.message);
    return [];
  }
  return (Array.isArray(data) ? data : []) as ScheduledDraftRow[];
}

/**
 * How many scheduled Contents still publish through this account.
 *
 * Degrades to 0 when the schema isn't there — a merchant must never be blocked
 * from removing an account because an optional migration hasn't run.
 */
export async function countScheduledForSocialConnection(
  db: DbLike,
  uid: string,
  connectionId: string,
): Promise<number> {
  if (!str(connectionId)) return 0;
  const rows = await readCandidates(db, uid, "scheduled count");
  return rows.filter(r => payloadTargetsSocialConnection(r.payload, connectionId)).length;
}

/**
 * Drop this account from every scheduled Content that targets it. Returns how many
 * rows were changed.
 *
 * A row keeps its schedule when other destinations survive; it is un-scheduled
 * (scheduled_at null, claim released) only when this account was its last one.
 *
 * Known and accepted for MVP, inherited from the Pinterest module: a row the cron
 * has ALREADY claimed may still finish its in-flight publish. The window is minutes
 * and the outcome is one extra published post, not a corrupted row.
 */
export async function cancelScheduledForSocialConnection(
  db: DbLike,
  uid: string,
  connectionId: string,
  nowIso: string,
): Promise<number> {
  if (!str(connectionId)) return 0;
  const rows = await readCandidates(db, uid, "scheduled fetch");

  let cleared = 0;
  for (const row of rows) {
    if (!payloadTargetsSocialConnection(row.payload, connectionId)) continue;
    const { payload, remaining } = payloadAfterDestinationRemoved(
      row.payload ?? {}, connectionId, nowIso,
    );
    const patch: Record<string, unknown> = {
      payload,
      updated_at: nowIso, // keep the column in step with payload.updatedAt (LWW)
    };
    if (remaining === 0) {
      patch.scheduled_at = null;       // drop out of the cron's due scan
      patch.publish_claimed_at = null; // release any stale lock so the row isn't half-held
    }
    const { error } = await db
      .from(PIN_DRAFTS_TABLE)
      .update(patch)
      .eq("vibepin_user_id", uid)
      .eq("draft_id", row.draft_id);
    if (error) {
      console.error("[social/disconnect] schedule cancel failed:", error.message);
      continue;
    }
    cleared++;
  }
  return cleared;
}
