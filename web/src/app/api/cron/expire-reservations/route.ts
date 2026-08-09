/**
 * GET /api/cron/expire-reservations — releases capacity held by reservations whose
 * work never finished.
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
 */

import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reservations per run. Bounded so one invocation stays far under maxDuration; the
 *  crontab interval provides the throughput, not the batch size. */
const SWEEP_LIMIT = 100;

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

  const { data, error } = await db.rpc("usage_expire_reservations", {
    p_limit: SWEEP_LIMIT,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (error) {
    if (isMissingFunctionError(error)) {
      console.warn("[cron/expire-reservations] usage_expire_reservations is not deployed yet — nothing swept.");
      return json({ expired: 0, skipped: 0, available: false });
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
  if (expired > 0) {
    console.log(`[cron/expire-reservations] expired=${expired} skipped=${skipped}`);
  }

  return json({ expired, skipped, available: true });
}
