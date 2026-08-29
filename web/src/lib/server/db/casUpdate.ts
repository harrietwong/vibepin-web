/**
 * casUpdate.ts — read → merge → write, where the write applies only if the row is
 * still what was read.
 *
 * PostgREST has no read-modify-write transaction. Every writer in this codebase
 * that has to modify part of a JSON `payload` therefore has the same shape of bug
 * available to it: read the payload, compute a new one, `update … .eq(user).eq(id)`.
 * Anything the merchant (or another request) wrote in between is overwritten
 * wholesale — not merged, replaced — and nothing anywhere reports it.
 *
 * The fix that works is not a lock but a CONDITION: filter the UPDATE on the
 * `updated_at` (and, where the schedule matters, `scheduled_at`) that were
 * observed, and ask PostgREST which rows it actually touched. Zero means the row
 * moved; the answer is to re-read and re-merge onto the NEW row, never to write
 * anyway.
 *
 * Bounded, because a row being rewritten faster than a run can read it is a
 * live-lock, not a retry. Exhausted, it writes NOTHING and says so: every caller
 * treats that as a failure the customer can see and retry, which is strictly safer
 * than silently clobbering an edit.
 *
 * Extracted from api/cron/publish-due/persistRow.ts, which had the only correct
 * implementation, so the two schedule-cancel writers could stop being the two
 * incorrect ones. persistRow re-exports these names, so its behaviour and public
 * surface are unchanged.
 */

/** What the write was conditional ON — the row as the merge read it. */
export interface ObservedRow {
  scheduled_at: string | null;
  /**
   * The row's LWW stamp, exactly as the database returned it.
   *
   * It must be passed back to the filter as the SAME STRING it arrived as:
   * Postgres timestamptz keeps microseconds, and a value round-tripped through
   * `new Date().toISOString()` is truncated to milliseconds — which matches
   * nothing, and would make every write a CAS miss.
   */
  updated_at: string | null;
}

/**
 * A COMPARE-AND-SET write: it must apply only while the row still looks like
 * `observed`.
 *
 * `matched: false` means the row moved between the read and the write — not an
 * error, and emphatically not something to retry unconditionally. The merge is
 * redone against whatever it looks like now.
 */
export type CasUpdate<TRef, TValues> = (
  ref: TRef,
  values: TValues,
  observed: ObservedRow,
) => Promise<{ error: string | null; matched: boolean }>;

/** Reads the row as it is RIGHT NOW. `null` snapshot means the row is gone. */
export type CasRead<TRef, TSnapshot> = (
  ref: TRef,
) => Promise<{ snapshot: TSnapshot | null; error: string | null }>;

export interface CasIo<TRef, TSnapshot, TValues> {
  read: CasRead<TRef, TSnapshot>;
  update: CasUpdate<TRef, TValues>;
}

export interface CasResult {
  error: string | null;
  /** The row is gone (deleted underneath us). Nothing was written; not an error. */
  gone?: boolean;
  /** The merge decided there was nothing to do. Nothing was written; not an error. */
  skipped?: boolean;
}

/** How many times a merge is redone when the row moves underneath it. */
export const CAS_ATTEMPTS = 3;

/**
 * What a merge decided to do with the row it just read.
 *
 * `null` means "nothing to do" — the reason a re-read exists at all is that the
 * situation may have resolved itself (the destination this run was cancelling was
 * removed by someone else), and writing anyway would undo their work.
 */
export type CasBuild<TSnapshot, TValues> = (
  snapshot: TSnapshot,
  nowIso: string,
) => TValues | null;

/**
 * How the loop reads the two CAS columns off a snapshot. Kept injectable because
 * the snapshot types differ per caller (the publisher's carries a claim, the
 * cancel writers' carries a draft id) and forcing one shape on all of them would
 * be a worse coupling than one small function.
 */
export type CasObserve<TSnapshot> = (snapshot: TSnapshot) => ObservedRow;

/**
 * Read → merge → write, retrying the MERGE (never the write) when the row moves.
 *
 * `build` receives the row as it is now and must recompute from it — that is the
 * entire point. A build that closes over the first snapshot re-introduces the bug
 * this function exists to remove.
 */
export async function casReadMergeWrite<TRef, TSnapshot, TValues>(
  io: CasIo<TRef, TSnapshot, TValues>,
  ref: TRef,
  observe: CasObserve<TSnapshot>,
  build: CasBuild<TSnapshot, TValues>,
  label: string,
  describe: (ref: TRef) => string,
): Promise<CasResult> {
  for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
    const { snapshot, error } = await io.read(ref);
    if (error) return { error };
    // Deleted underneath us. Re-creating it from this run's snapshot would
    // resurrect something that was deliberately thrown away.
    if (!snapshot) return { error: null, gone: true };
    const nowIso = new Date().toISOString();
    const values = build(snapshot, nowIso);
    if (values === null) return { error: null, skipped: true };
    const { error: writeError, matched } = await io.update(ref, values, observe(snapshot));
    if (writeError) return { error: writeError };
    if (matched) return { error: null };
    // CAS miss: the row changed between the read and the write. Loop to merge onto it.
  }
  const message =
    `row changed under every one of ${CAS_ATTEMPTS} merge attempts (${describe(ref)})`;
  console.error(`[${label}] CAS exhausted, nothing written: ${message}`);
  return { error: message };
}
