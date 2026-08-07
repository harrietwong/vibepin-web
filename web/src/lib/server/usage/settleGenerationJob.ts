/**
 * Close out the reservation for a WORKER-PATH image job.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * The worker path was metered on only one side. /api/generate reserves capacity and
 * enqueues the job in a single transaction (usage_reserve_generation_job), then the
 * VPS worker renders the images — and the VPS worker is a separate codebase that
 * never learned to settle. So every metered image job reserved capacity and then
 * dangled: `ai_images_reserved` went up, `ai_images_used` stayed 0, and the reservation
 * sat `pending` until the expiry sweeper handed the capacity back. Images generated
 * fine; they were simply never recorded as used. (The inline path, which settles
 * in-process, was always correct — which is why text metering looked right while
 * image metering read zero.)
 *
 * Settling HERE — where the client polls for the job's result — closes that gap
 * without touching the VPS worker: by the time a job reports `done`/`failed`, its
 * per-slot outcomes are readable from the same row the poll already fetches.
 *
 * ── THE KNOWN LIMIT ────────────────────────────────────────────────────────────
 * This is poll-driven, so a user who closes the tab before the job finishes leaves it
 * unsettled (the sweeper reclaims the capacity; the usage is never counted). That
 * under-counts, never over-counts, and no user is ever charged for it. Settling in the
 * worker itself is the durable fix; this covers everything that finishes while someone
 * is watching, which is the normal case. `reservation_expired` refusals are logged as
 * `usage_settle_expired`, so the miss rate is measurable rather than assumed.
 *
 * ── IDEMPOTENCY IS THE RPC'S JOB, NOT OURS ─────────────────────────────────────
 * The client polls every 4s and several tabs may poll at once, so this runs many times
 * over for the same job. We do NOT guard with a lock or a "settled?" pre-check:
 * usage_settle_reservation_item is idempotent per (reservation, slot) via a guarded
 * UPDATE on state='pending'. A replay returns ok/replayed and moves nothing. Racing
 * callers are serialized on the account row inside the RPC.
 */
import type { RpcRunner } from "./meterGeneration";
import { defaultRpc, logEvent } from "./meterGeneration";

/** One entry of generation_jobs.results — the worker's per-slot report. */
export type GenerationJobResultRow = {
  slot: number;
  status: "pending" | "done" | "failed";
  imageUrl: string | null;
  error: string | null;
};

export type SettleJobOutcome = {
  /** Slots newly moved reserved → used. */
  settledSuccess: number;
  /** Slots newly moved reserved → available (terminal render failures). */
  settledFailed: number;
  /** Slots the ledger declined to settle (already terminal, expired, or swept). */
  refused: number;
};

/**
 * Reservation slot keys are `s0, s1, …` (slotKeysForCount), and the worker numbers its
 * results from 0 in the same order, so the join is positional. Verified against the
 * live rows in usage_reservation_items — a mismatch here would make every settle throw
 * "unknown slot", so it is worth stating explicitly rather than inlining.
 */
function slotKeyFor(slot: number): string {
  return `s${slot}`;
}

/**
 * Settle every terminal slot of a finished job. Safe to call on any job, in any state,
 * any number of times.
 *
 * FAILS OPEN, ALWAYS. This runs inside a poll whose real job is returning the user's
 * images; metering must never be able to break that. Every failure path returns counts
 * of zero instead of throwing, and the caller ignores the result on error.
 */
export async function settleGenerationJob(args: {
  reservationId: string | null | undefined;
  status: string | null | undefined;
  results: unknown;
  deps?: { rpc?: RpcRunner };
}): Promise<SettleJobOutcome> {
  const empty: SettleJobOutcome = { settledSuccess: 0, settledFailed: 0, refused: 0 };

  // Gate on the RESERVATION, not on the current metering mode. A job reserved while
  // metering was on must still be closed even if the mode was flipped off afterwards —
  // otherwise flipping the switch would strand capacity that is already held.
  if (!args.reservationId) return empty;

  // Only terminal jobs settle. A running job's slots may still be pending, and
  // settling a pending slot early would bank an image that was never produced.
  if (args.status !== "done" && args.status !== "failed") return empty;

  if (!Array.isArray(args.results)) return empty;
  const rows = args.results as GenerationJobResultRow[];

  const rpc = args.deps?.rpc ?? defaultRpc();
  const out: SettleJobOutcome = { settledSuccess: 0, settledFailed: 0, refused: 0 };

  for (const row of rows) {
    if (!row || typeof row.slot !== "number") continue;

    // A slot still 'pending' on a terminal job never ran (worker died, job cancelled).
    // Leave it to the sweeper rather than guessing: 'succeeded' would bill an image
    // that does not exist, and 'terminal_failed' would assert a failure we did not
    // observe. Its capacity returns when the reservation expires.
    if (row.status !== "done" && row.status !== "failed") continue;

    const outcome = row.status === "done" ? "succeeded" : "terminal_failed";

    try {
      const { data, error } = await rpc("usage_settle_reservation_item", {
        p_reservation_id: args.reservationId,
        p_slot_key: slotKeyFor(row.slot),
        p_outcome: outcome,
        p_reference_id: row.imageUrl ?? null,
      });

      if (error) {
        // Includes "unknown slot" (P0002) — a real contract break worth seeing, but
        // still not worth failing the user's poll over.
        logEvent("usage_settle_error", {
          path: "worker_poll",
          slot: row.slot,
          outcome,
          code: error.code,
          error: error.message?.slice(0, 200),
        });
        out.refused += 1;
        continue;
      }

      const payload = (data ?? {}) as { ok?: boolean; replayed?: boolean; reason?: string };

      if (payload.ok !== true) {
        // The two refusals that matter: `reservation_expired` (the sweeper won — this
        // is the poll-driven miss this design accepts) and `reservation_not_pending`.
        // Logged as data, because the miss rate is the number that decides whether the
        // durable worker-side settle is worth building.
        logEvent("usage_settle_expired", {
          path: "worker_poll",
          slot: row.slot,
          outcome,
          reason: payload.reason,
        });
        out.refused += 1;
        continue;
      }

      // A replay is a no-op that already happened — counting it would inflate the
      // response on every subsequent poll of the same finished job.
      if (payload.replayed === true) continue;

      if (outcome === "succeeded") out.settledSuccess += 1;
      else out.settledFailed += 1;
    } catch (err) {
      logEvent("usage_settle_threw", {
        path: "worker_poll",
        slot: row.slot,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      out.refused += 1;
    }
  }

  return out;
}
