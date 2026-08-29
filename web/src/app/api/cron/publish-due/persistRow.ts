/**
 * persistRow.ts — every write the due-time publisher makes to a claimed row.
 *
 * ONE rule, and it is the reason this file exists: a persist must apply what this run
 * achieved onto the row as it is NOW, never onto the snapshot the run claimed minutes
 * earlier.
 *
 * The old persist wrote `payloadAfterOutcomes(row.payload, …)` — `row.payload` being
 * the copy read at claim time, before provider calls that can take a minute — with a
 * timestamp captured at the same moment. Two defects fell out of that, and they
 * compound:
 *
 *   1. An edit the merchant made WHILE the Content was publishing was overwritten
 *      wholesale. The publish did not merge into their draft; it replaced it.
 *   2. The `payload.updatedAt` it wrote was OLDER than the copy in the browser, so
 *      the client's last-write-wins merge (pinDraftStore mergeServerDrafts) pushed its
 *      own pre-publish copy back — scheduledDate, scheduledTime, plannedAt and all.
 *      The Content became due again and was published a SECOND time.
 *
 * So: re-read, merge onto that, and stamp at write time. And because the merchant may
 * have RESCHEDULED during the publish, the scheduling fields are cleared only when the
 * row's `scheduled_at` is still the one this run claimed. If it changed, their new
 * schedule stands and the results are recorded alongside it.
 *
 * The database is reached through two injected functions rather than a Supabase
 * client, so the merge rules above are testable with a fake row store — no network,
 * no service-role key, no PostgREST builder to imitate.
 */

import {
  casReadMergeWrite,
  CAS_ATTEMPTS,
  type ObservedRow,
} from "@/lib/server/db/casUpdate";
import {
  applyDestinationResults,
  payloadAfterFailure,
  payloadAfterOutcomes,
  type DestinationOutcomeLike,
  type PublishFailureInfo,
} from "./publishDueLogic";

/** Identifies the row, and carries the schedule this run CLAIMED. */
export interface DueRowRef {
  vibepin_user_id: string;
  draft_id: string;
  scheduled_at: string | null;
}

/** The row as it is right now. */
export interface RowSnapshot {
  payload: Record<string, unknown>;
  scheduled_at: string | null;
  publish_claimed_at: string | null;
  /**
   * The row's LWW stamp, exactly as the database returned it.
   *
   * Carried so the write can be made conditional on it. It must be passed back to the
   * filter as the SAME STRING it arrived as: Postgres timestamptz keeps microseconds,
   * and a value round-tripped through `new Date().toISOString()` is truncated to
   * milliseconds — which matches nothing, and would make every write a CAS miss.
   */
  updated_at: string | null;
}

/**
 * What the write was conditional ON — the row as the merge read it.
 *
 * Re-exported rather than redefined: the CAS loop itself now lives in
 * lib/server/db/casUpdate.ts, where the two schedule-cancel writers can use the
 * same one instead of each growing their own near-copy.
 */
export type { ObservedRow };
export { CAS_ATTEMPTS };

export type ReadRow = (row: DueRowRef) => Promise<{ snapshot: RowSnapshot | null; error: string | null }>;
/**
 * A COMPARE-AND-SET write: it must apply only while the row still looks like `observed`.
 *
 * `matched: false` means the row moved between the read and the write — not an error,
 * and emphatically not something to retry unconditionally. The merge is redone against
 * whatever it looks like now.
 */
export type UpdateRow = (
  row: DueRowRef,
  values: Record<string, unknown>,
  observed: ObservedRow,
) => Promise<{ error: string | null; matched: boolean }>;
export interface RowIo {
  read: ReadRow;
  update: UpdateRow;
}

export interface WriteResult {
  error: string | null;
  /** The row is gone (deleted while publishing). Nothing was written; not an error. */
  gone?: boolean;
}

/**
 * Read → merge → write, where the write applies only if the row is still what was read.
 *
 * Re-reading before the merge closed the long window (the publish itself) but left a
 * short one: between this function's read and its write, the merchant can reschedule.
 * The write was unconditional, so it clobbered whatever landed in that gap — deciding
 * `scheduleUnchanged` from a snapshot that was already stale and then clearing
 * `scheduled_at` on a slot it had never read. The merchant's new schedule vanished with
 * no error anywhere.
 *
 * The loop itself is `casReadMergeWrite`; this wrapper supplies the one thing that is
 * specific to publishing — `scheduleUnchanged`, which is compared against the schedule
 * this RUN claimed rather than against the previous attempt, because the question is
 * always "is this still the slot we published for?".
 *
 * Exhausted, it fails loudly and writes nothing: the caller (persistOutcomes) logs the
 * outcomes it could not store and deliberately keeps the claim, which is strictly safer
 * than overwriting a merchant's edit.
 */
async function readMergeWrite(
  io: RowIo,
  row: DueRowRef,
  build: (snapshot: RowSnapshot, nowIso: string, scheduleUnchanged: boolean) => Record<string, unknown>,
): Promise<WriteResult> {
  const result = await casReadMergeWrite<DueRowRef, RowSnapshot, Record<string, unknown>>(
    io,
    row,
    snapshot => ({
      scheduled_at: snapshot.scheduled_at ?? null,
      updated_at: snapshot.updated_at ?? null,
    }),
    (snapshot, nowIso) =>
      build(snapshot, nowIso, (snapshot.scheduled_at ?? null) === (row.scheduled_at ?? null)),
    "persistRow",
    ref => `draft_id=${ref.draft_id} user=${ref.vibepin_user_id}`,
  );
  // `skipped` cannot happen here — this build never returns null — so the shape the
  // publisher sees is exactly the one it saw before the loop was extracted.
  return result.gone ? { error: null, gone: true } : { error: result.error };
}

/**
 * Record ONE destination's outcome the instant it is known.
 *
 * This is what makes a process death survivable. Between a provider accepting a post
 * and the run's final persist there used to be every remaining destination — minutes,
 * during which a kill lost the record of a post that really exists, and the next run
 * published it again. With the outcome already stored, that run owes nothing for this
 * destination: `owedDestinations` reads the `published` row and skips it.
 *
 * Deliberately touches nothing but the results: no `postedAt`, no schedule, no claim.
 * The Content is not finished, and saying so is the final persist's job.
 */
export async function mergeOutcomesIntoRow(
  io: RowIo,
  row: DueRowRef,
  outcomes: readonly DestinationOutcomeLike[],
): Promise<WriteResult> {
  return readMergeWrite(io, row, (snapshot, nowIso) => {
    const next = { ...snapshot.payload };
    applyDestinationResults(next, snapshot.payload, outcomes, nowIso);
    // Written at WRITE time, so it is strictly newer than any edit made during the
    // publish and the client's LWW merge takes this row rather than pushing back a
    // copy that still carries the schedule.
    next.updatedAt = nowIso;
    return { payload: next, updated_at: nowIso };
  });
}

export interface FinalWriteOptions {
  /** Adopt-once: the connection an untargeted draft actually published through. */
  connectionId?: string | null;
  /** The first failure's stable platform code, for categorization. */
  failureCode?: string;
  /** A destination was deferred — the Content is still scheduled for it. */
  deferred?: boolean;
}

/** The row's final persist: results, posted/failure framing, schedule, claim. */
export async function writeOutcomes(
  io: RowIo,
  row: DueRowRef,
  outcomes: readonly DestinationOutcomeLike[],
  options: FinalWriteOptions = {},
): Promise<WriteResult> {
  return readMergeWrite(io, row, (snapshot, nowIso, scheduleUnchanged) => {
    const clearSchedule = !options.deferred && scheduleUnchanged;
    const payload = payloadAfterOutcomes(
      snapshot.payload, outcomes, nowIso, options.connectionId, options.failureCode,
      { deferred: options.deferred, clearSchedule },
    );
    return {
      payload,
      status: typeof payload.status === "string" ? payload.status : null,
      updated_at: nowIso,
      // Omitted, never written back, when the merchant rescheduled during the publish
      // or a destination is still owed: this run must not undo a schedule it did not
      // read, nor drop a Content whose platforms have not all gone out.
      ...(clearSchedule ? { scheduled_at: null } : {}),
      publish_claimed_at: null, // release the claim either way
    };
  });
}

/** The row's final persist for a Content-level failure (WP-B §11.5 fields). */
export async function writeFailure(
  io: RowIo,
  row: DueRowRef,
  fail: PublishFailureInfo,
  connectionId?: string | null,
): Promise<WriteResult> {
  return readMergeWrite(io, row, (snapshot, nowIso, scheduleUnchanged) => {
    const payload = payloadAfterFailure(snapshot.payload, fail, nowIso, connectionId,
      { clearSchedule: scheduleUnchanged });
    return {
      payload,
      status: typeof payload.status === "string" ? payload.status : null,
      updated_at: nowIso,
      ...(scheduleUnchanged ? { scheduled_at: null } : {}),
      publish_claimed_at: null,
    };
  });
}
