/**
 * GET /api/cron/expire-reservations — releases capacity held by reservations whose
 * work never finished, and — before it does that — settles worker-path jobs that
 * quietly DID finish but nobody was there to close out.
 *
 * WHY THIS EXISTS
 * Image and text generation RESERVE quota up front and SETTLE when the work lands.
 * Anything that dies in between (browser closed mid-render, worker crash) leaves the
 * reservation `pending` and its capacity held. `usage_settle_reservation_item` refuses
 * a reservation past `expires_at`, so nothing else ever releases those slots — the
 * database function `usage_expire_reservations` is the only thing that does, and until
 * now nothing called it.
 *
 * Today metering runs in SHADOW mode, where a stuck reservation is invisible: usage is
 * recorded, never enforced. The moment enforcement is switched on, the same stuck rows
 * become a one-way quota leak — a user's allowance would only ever shrink. So this must
 * be live and PROVEN to run before enforcement, not at the same time.
 *
 * THE GAP THIS STEP CLOSES (found 2026-09-25)
 * settleGenerationJob only ever runs from GET /api/generation-jobs/[id] — i.e. while a
 * client is polling. A worker-path job (GENERATION_MODE=worker) whose user closes the
 * tab after submitting still renders on the VPS and reaches `done`/`failed`, but with
 * no poller left to settle it. Nobody notices until this sweep's OTHER half — the
 * expiry RPC — fires 30 minutes later, hands the reservation's capacity back as
 * "expired", and the user keeps their images while paying nothing for them. So before
 * expiring anything, this route now looks for reservations that are still `pending`,
 * not yet expired, and whose job already finished, and settles them the same way a
 * poll would have. This is PRE-EXPIRY SETTLEMENT, not a replacement for the poll path
 * (which still settles sooner, the instant a watching user sees their images) or for
 * the worker itself learning to settle (the durable fix, not yet built).
 *
 * RESIDUAL WINDOW: a job that finishes AFTER this tick's query but BEFORE the next
 * tick still slips through and gets expired instead of settled — this only shrinks
 * the miss window to the crontab interval, it does not close it to zero. Shortening
 * the crontab interval shrinks the window further; only a worker-side settle removes
 * it entirely.
 *
 * TRIGGER: a VPS crontab hits this with the bearer secret, the same channel that drives
 * /api/cron/publish-due (Vercel Hobby cron fires once a day, which is useless for a
 * sweeper). See docs/运维/过期预留扫描-cron配置.md. Consequently this endpoint must be
 * safe to call at any frequency, from more than one caller, forever.
 *
 * SAFETY — all of it lives in the SQL function, deliberately, because only the database
 * can make these guarantees atomically. This route is a thin, authenticated trigger:
 *   - it takes a row lock on the account, so a settle already in flight wins and this
 *     sweep finds the slot no longer pending;
 *   - a `running` job with a fresh worker heartbeat is PROOF OF LIFE and is skipped, so
 *     a slow-but-alive render is never cancelled out from under the user;
 *   - each expiry writes one `usage_events` row keyed `expire:<reservation_id>`, so a
 *     double-fire cannot double-count.
 * A run that expires nothing is the expected steady state, not a failure.
 *
 * The pre-settle step above this is deliberately BEST-EFFORT and separate from that
 * guarantee: it reuses settleGenerationJob (same idempotent RPC, same fail-open
 * contract as the poll route), so a lookup error or a settle failure here never blocks
 * or changes the response code of the expiry sweep that follows it.
 */

import { createServerClient } from "@/lib/supabase";
import { settleGenerationJob } from "@/lib/server/usage/settleGenerationJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reservations per run. Bounded so one invocation stays far under maxDuration; the
 *  crontab interval provides the throughput, not the batch size. */
const SWEEP_LIMIT = 100;

/** Pending, not-yet-expired reservations checked for an already-finished job per run,
 *  BEFORE the expiry sweep below. Kept well under SWEEP_LIMIT: each hit here is a
 *  settleGenerationJob call that can issue one RPC per result slot, so this bounds how
 *  much sequential RPC work can run before the expiry sweep — the guarantee this route
 *  exists for — gets its turn inside maxDuration. */
const PRESETTLE_LIMIT = 25;

/** How fresh a worker heartbeat must be to count as proof of life (seconds). Matches
 *  the generation worker's heartbeat cadence with room to spare — too short and a
 *  briefly-stalled worker loses its slots mid-render. */
const LEASE_SECONDS = 300;

type ExpireResult = {
  ok?: boolean;
  expired_count?: number;
  skipped_count?: number;
  reservation_ids?: string[];
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** The v55 usage primitives may not be applied on a given environment yet. A missing
 *  function is a deployment-ordering fact, not a runtime fault: report it and exit 200
 *  so the crontab does not alarm on every tick before the migration lands. */
function isMissingFunctionError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "PGRST202"                      // PostgREST: function not found in schema cache
    || err.code === "42883"                      // Postgres: undefined_function
    || message.includes("Could not find the function")
    || (message.includes("function") && message.includes("does not exist"))
  );
}

/** A `usage_reservations` row this step cares about — just enough to look up and
 *  re-key the matching `generation_jobs` row for settleGenerationJob. */
type PendingImageReservation = {
  id: string;
  generation_job_id: string | null;
};

type GenerationJobRow = {
  id: string;
  status: string | null;
  results: unknown;
};

/**
 * PRE-EXPIRY SETTLEMENT (see file header). Finds worker-path image reservations that
 * are still `pending` and not yet expired whose job already reached a terminal state,
 * and closes them out via the exact same settleGenerationJob the poll route uses —
 * this is not a reimplementation, it is the same idempotent, fail-open call site with
 * a different trigger (a crontab tick instead of a browser poll).
 *
 * BEST-EFFORT, ALWAYS. Every failure path here — a query error, a settle error, a
 * malformed row — is caught, logged, and treated as zero. This must never throw,
 * never change this route's status code, and never delay or skip the expiry sweep
 * that follows it: that sweep is this endpoint's one hard guarantee, and it must run
 * whether or not this optional step found anything.
 */
async function presettleFinishedWorkerJobs(
  db: ReturnType<typeof createServerClient>,
): Promise<number> {
  try {
    const { data: reservations, error: resError } = await db
      .from("usage_reservations")
      .select("id,generation_job_id")
      .eq("state", "pending")
      .eq("usage_type", "ai_image")
      .not("generation_job_id", "is", null)
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: true })
      .limit(PRESETTLE_LIMIT);

    if (resError) {
      console.warn("[cron/expire-reservations] presettle: reservation lookup failed, skipping:", resError.message);
      return 0;
    }

    const rows = (reservations ?? []) as PendingImageReservation[];
    const jobIdToReservationId = new Map<string, string>();
    for (const row of rows) {
      if (row.generation_job_id) jobIdToReservationId.set(row.generation_job_id, row.id);
    }
    const jobIds = Array.from(jobIdToReservationId.keys());
    if (jobIds.length === 0) return 0;

    const { data: jobs, error: jobsError } = await db
      .from("generation_jobs")
      .select("id,status,results")
      .in("id", jobIds);

    if (jobsError) {
      console.warn("[cron/expire-reservations] presettle: job lookup failed, skipping:", jobsError.message);
      return 0;
    }

    let settledBeforeExpiry = 0;
    for (const job of (jobs ?? []) as GenerationJobRow[]) {
      const reservationId = jobIdToReservationId.get(job.id);
      if (!reservationId) continue;
      try {
        // settleGenerationJob itself gates on status === "done" | "failed" — a
        // running/queued job is a no-op here, exactly as it is on the poll path.
        const outcome = await settleGenerationJob({
          reservationId,
          status: job.status,
          results: job.results,
        });
        settledBeforeExpiry += outcome.settledSuccess + outcome.settledFailed;
      } catch (err) {
        // settleGenerationJob already fails open internally; this catch is a second
        // line of defense so a defect there can never take down the expiry sweep.
        console.warn(
          "[cron/expire-reservations] presettle: settle threw for job",
          job.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return settledBeforeExpiry;
  } catch (err) {
    console.warn(
      "[cron/expire-reservations] presettle: unexpected failure, skipping:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

export async function GET(req: Request): Promise<Response> {
  // ── Auth: bearer CRON_SECRET. Missing config ⇒ 503, never run unauthenticated. ──
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/expire-reservations] CRON_SECRET is not configured — refusing to run.");
    return json({ error: "cron_not_configured", code: "cron_not_configured" }, 503);
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }

  const db = createServerClient();

  const settledBeforeExpiry = await presettleFinishedWorkerJobs(db);

  const { data, error } = await db.rpc("usage_expire_reservations", {
    p_limit: SWEEP_LIMIT,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (error) {
    if (isMissingFunctionError(error)) {
      console.warn("[cron/expire-reservations] usage_expire_reservations is not deployed yet — nothing swept.");
      return json({ expired: 0, skipped: 0, available: false, settledBeforeExpiry });
    }
    // A real failure: 503 so the crontab's own logging surfaces it. Never 200 on an
    // error — a sweeper that reports success while sweeping nothing is the one failure
    // mode this endpoint exists to prevent.
    console.error("[cron/expire-reservations] sweep failed:", error.message);
    return json({ error: "sweep_failed", code: "database_unavailable" }, 503);
  }

  const result = (data ?? {}) as ExpireResult;
  const expired = result.expired_count ?? 0;
  const skipped = result.skipped_count ?? 0;

  // Only log when something actually happened; a quiet steady state should not fill logs.
  if (expired > 0 || settledBeforeExpiry > 0) {
    console.log(`[cron/expire-reservations] settledBeforeExpiry=${settledBeforeExpiry} expired=${expired} skipped=${skipped}`);
  }

  return json({ expired, skipped, available: true, settledBeforeExpiry });
}
