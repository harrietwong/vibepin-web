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
import { casReadMergeWrite, type ObservedRow } from "@/lib/server/db/casUpdate";
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
  /** The slot the row was on when it was read — half of the compare-and-set. */
  scheduled_at?: string | null;
  /**
   * The row's LWW stamp, exactly as the database returned it — the other half.
   *
   * It must go back into the filter as the SAME STRING: Postgres timestamptz keeps
   * microseconds, and a value round-tripped through `new Date().toISOString()` is
   * truncated to milliseconds, matching nothing, making every write a CAS miss.
   */
  updated_at?: string | null;
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
    // scheduled_at/updated_at ride along so the cancel's first attempt already has
    // an observed state to condition its write on, with no extra round trip.
    .select("vibepin_user_id, draft_id, payload, scheduled_at, updated_at")
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

/**
 * Fetch the candidate rows.
 *
 * `readFailed` distinguishes the two ways this comes back empty, which the callers
 * must NOT treat alike:
 *   - missing table/column (the optional migration has not run) ⇒ there genuinely
 *     is nothing scheduled. Not a failure; a merchant must never be blocked from
 *     removing an account by a migration they cannot run.
 *   - a real query error ⇒ we have NO IDEA what is scheduled. Reporting "nothing"
 *     is a lie, and the remove route used to act on it.
 */
async function readCandidates(
  db: DbLike,
  uid: string,
  label: string,
): Promise<{ rows: ScheduledDraftRow[]; readFailed: boolean }> {
  const { data, error } = await candidateScheduledQuery(db, uid);
  if (error) {
    if (isMissingSchemaError(error)) return { rows: [], readFailed: false };
    console.error(`[social/disconnect] ${label} failed:`, error.message);
    return { rows: [], readFailed: true };
  }
  return { rows: (Array.isArray(data) ? data : []) as ScheduledDraftRow[], readFailed: false };
}

/**
 * The count, plus whether the read behind it actually worked.
 *
 * The plain number was ambiguous in the one place it mattered: a remove route
 * cannot tell "0 scheduled" apart from "the query failed, so I am telling you 0".
 * Acting on the second as if it were the first hard-deletes an account that live
 * schedules still target. A caller that must be SURE reads this instead.
 */
export type ScheduledCountOutcome = {
  /** Matching rows found. Meaningless when `readFailed` is true. */
  count: number;
  /**
   * The candidate read failed, so `count` describes nothing. A MISSING
   * table/column is NOT a failure — the optional migration simply has not run and
   * there is genuinely nothing scheduled.
   */
  readFailed: boolean;
};

/**
 * How many scheduled Contents still publish through this account, WITH the
 * read's own success in the answer.
 *
 * This is the form the remove route must use: it is the only one that can refuse
 * to delete on a transient failure instead of silently reading it as "nothing is
 * scheduled" (Codex #1).
 */
export async function countScheduledForSocialConnectionStrict(
  db: DbLike,
  uid: string,
  connectionId: string,
): Promise<ScheduledCountOutcome> {
  if (!str(connectionId)) return { count: 0, readFailed: false };
  const { rows, readFailed } = await readCandidates(db, uid, "scheduled count");
  if (readFailed) return { count: 0, readFailed: true };
  return {
    count: rows.filter(r => payloadTargetsSocialConnection(r.payload, connectionId)).length,
    readFailed: false,
  };
}

/**
 * How many scheduled Contents still publish through this account.
 *
 * Degrades to 0 when the schema isn't there — a merchant must never be blocked
 * from removing an account because an optional migration hasn't run — AND when the
 * read itself fails. That second degradation is why this must not be used to
 * decide a deletion; it exists for the advisory GET the dialog pre-loads with,
 * where a wrong 0 costs a prompt rather than a merchant's scheduled posts. The
 * authority is `countScheduledForSocialConnectionStrict`.
 */
export async function countScheduledForSocialConnection(
  db: DbLike,
  uid: string,
  connectionId: string,
): Promise<number> {
  const { count } = await countScheduledForSocialConnectionStrict(db, uid, connectionId);
  return count;
}

/**
 * The outcome of a cancel, in enough detail for the caller to decide whether the
 * account may now be deleted (Codex #6).
 *
 * `cleared` alone was not enough. This function used to swallow a read error as
 * "nothing is scheduled" and log-and-skip each failed update, then return a number
 * the remove route could not tell apart from real success — so a transient DB
 * failure produced a DELETED account whose schedules still pointed at it, and the
 * merchant was told the removal worked. The cron would then keep picking those rows
 * up. Failures have to be visible in the return value to be actionable.
 */
export type CancelScheduledOutcome = {
  /** Rows successfully updated. */
  cleared: number;
  /** Rows that matched but whose update FAILED. Any non-zero value blocks a delete. */
  failed: number;
  /** The candidate read itself failed, so `cleared`/`failed` describe nothing. */
  readFailed: boolean;
};

/**
 * Drop this account from every scheduled Content that targets it.
 *
 * A row keeps its schedule when other destinations survive; it is un-scheduled
 * (scheduled_at null, claim released) only when this account was its last one.
 *
 * Every matching row is still attempted even after one fails — a partial cancel is
 * strictly better than stopping early, and the caller refuses the delete either way.
 *
 * Known and accepted for MVP, inherited from the Pinterest module: a row the cron
 * has ALREADY claimed may still finish its in-flight publish. The window is minutes
 * and the outcome is one extra published post, not a corrupted row.
 *
 * `nowIso` is kept in the signature (both remove routes pass it) but each row is
 * now stamped at ITS OWN write time instead: a stamp taken before the loop is
 * already older than an edit made while the loop was running, and the client's LWW
 * merge would push that edit — destination and all — straight back.
 */
export async function cancelScheduledForSocialConnection(
  db: DbLike,
  uid: string,
  connectionId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  nowIso?: string,
): Promise<CancelScheduledOutcome> {
  if (!str(connectionId)) return { cleared: 0, failed: 0, readFailed: false };
  const { rows, readFailed } = await readCandidates(db, uid, "scheduled fetch");
  if (readFailed) return { cleared: 0, failed: 0, readFailed: true };

  let cleared = 0;
  let failed = 0;
  for (const row of rows) {
    if (!payloadTargetsSocialConnection(row.payload, connectionId)) continue;
    const result = await cancelOneRow(db, uid, row, connectionId);
    if (result.error) {
      console.error("[social/disconnect] schedule cancel failed:", result.error);
      failed++;
      continue;
    }
    // `gone` (row deleted underneath us) and `skipped` (the current payload no
    // longer targets this account — someone else already removed the destination)
    // are both no-op SUCCESS: the schedule this was cancelling does not exist any
    // more, which is the outcome that was asked for. Counting them as cleared
    // would overstate the work; counting them as failed would block a remove that
    // is now perfectly safe.
    if (result.gone || result.skipped) continue;
    cleared++;
  }
  return { cleared, failed, readFailed: false };
}

/**
 * Strip this account from ONE row, compare-and-set.
 *
 * The old write read the payload, edited a stale copy, and updated by user +
 * draft id alone. Anything the merchant did in between — an edit, a reschedule,
 * a destination added from another tab — was overwritten wholesale, with no error
 * anywhere. Since the outcome of this function decides whether the account may be
 * DELETED, a silent overwrite here is how a merchant loses a schedule they just
 * made and the account it published through, in one action.
 *
 * So: re-read, recompute from the row AS IT IS NOW, and condition the write on the
 * `scheduled_at`/`updated_at` that recomputation saw. A miss re-merges onto the new
 * row; three misses fail loudly and write nothing, which the caller counts as
 * `failed` — and a failed cancel refuses the remove. Refusing is the point: the
 * merchant retries and their account is still there.
 */
async function cancelOneRow(
  db: DbLike,
  uid: string,
  row: ScheduledDraftRow,
  connectionId: string,
) {
  type Patch = Record<string, unknown>;
  let attemptedRead = false;
  return casReadMergeWrite<ScheduledDraftRow, ScheduledDraftRow, Patch>(
    {
      // The first attempt reuses the snapshot the candidate scan already read —
      // re-reading it immediately would be a round trip per row for nothing. Every
      // LATER attempt is a genuine re-read, which is what makes the merge land on
      // the row as it now is.
      read: async ref => {
        if (!attemptedRead) {
          attemptedRead = true;
          return { snapshot: ref, error: null };
        }
        const { data, error } = await db
          .from(PIN_DRAFTS_TABLE)
          .select("vibepin_user_id, draft_id, payload, scheduled_at, updated_at")
          .eq("vibepin_user_id", uid)
          .eq("draft_id", ref.draft_id)
          .maybeSingle();
        if (error) {
          if (isMissingSchemaError(error)) return { snapshot: null, error: null };
          return { snapshot: null, error: error.message };
        }
        return { snapshot: (data ?? null) as ScheduledDraftRow | null, error: null };
      },
      update: async (ref, values, observed) => {
        let q = db
          .from(PIN_DRAFTS_TABLE)
          .update(values)
          .eq("vibepin_user_id", uid)
          .eq("draft_id", ref.draft_id);
        // `.eq` never matches NULL in SQL — an unscheduled row needs `.is`.
        q = observed.scheduled_at === null
          ? q.is("scheduled_at", null)
          : q.eq("scheduled_at", observed.scheduled_at);
        q = observed.updated_at === null
          ? q.is("updated_at", null)
          : q.eq("updated_at", observed.updated_at);
        // `.select` is what makes PostgREST report the affected rows; without it
        // there is no way to tell a no-match from a successful write.
        const { data, error } = await q.select("draft_id");
        if (error) return { error: error.message, matched: false };
        return { error: null, matched: Array.isArray(data) && data.length > 0 };
      },
    },
    row,
    (snapshot): ObservedRow => ({
      scheduled_at: snapshot.scheduled_at ?? null,
      updated_at: snapshot.updated_at ?? null,
    }),
    (snapshot, writeIso) => {
      // Recomputed from the CURRENT payload every attempt. This is where a
      // destination added while we were working is preserved: it is in `snapshot`,
      // so it survives into `remaining` instead of being erased by a stale copy.
      if (!payloadTargetsSocialConnection(snapshot.payload, connectionId)) return null;
      const { payload, remaining } = payloadAfterDestinationRemoved(
        snapshot.payload ?? {}, connectionId, writeIso,
      );
      const patch: Record<string, unknown> = {
        payload,
        updated_at: writeIso, // keep the column in step with payload.updatedAt (LWW)
      };
      if (remaining === 0) {
        patch.scheduled_at = null;       // drop out of the cron's due scan
        patch.publish_claimed_at = null; // release any stale lock so the row isn't half-held
      }
      return patch;
    },
    "social/disconnect",
    ref => `draft_id=${ref.draft_id} user=${uid}`,
  );
}
