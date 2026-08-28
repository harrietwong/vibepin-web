/**
 * GET /api/cron/insights-connections — the work list for the Insights collector.
 *
 * Returns every Pinterest connection that is currently usable, across ALL users, so
 * the VPS crontab can loop over them and POST /api/cron/insights-collect once per
 * connection. It is deliberately a separate endpoint from the collector: the budget
 * in v5 §2.3 is per CONNECTION, so the loop has to be outside the per-connection run
 * for two accounts of the same user to get their own allowance instead of splitting
 * one. See docs/运维/Insights采集-cron配置.md.
 *
 * This cannot reuse `listConnections(uid)`: that is user-scoped and there is no uid
 * here. It reads social_connections directly with the service-role key, mirroring
 * the "usable" predicate of listActiveConnections — not disconnected, and holding a
 * token. Ownership is NOT decided here; `PinterestClient.forConnection(uid, id)`
 * re-asserts the (user, connection) pair when the collector actually runs, and the
 * uid handed to it comes from this row, never from a caller.
 *
 * TRIGGER: VPS crontab with the bearer CRON_SECRET, the same channel as
 * /api/cron/publish-due and /api/cron/expire-reservations (Vercel Hobby cron fires
 * once a day, which is what this whole channel exists to work around).
 */

import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** social_connections missing/changed → report an empty work list, not a 500. The
 *  crontab must not alarm every night because a schema is mid-rollout. */
function isMissingSchemaError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "42P01" || err.code === "PGRST205"
    || err.code === "42703" || err.code === "PGRST204"
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"))
    || (message.includes("Could not find the") && message.includes("column"))
  );
}

export async function GET(req: Request): Promise<Response> {
  // ── Auth: bearer CRON_SECRET. Missing config ⇒ 503, never run unauthenticated. ──
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/insights-connections] CRON_SECRET is not configured — refusing to run.");
    return json({ error: "cron_not_configured", code: "cron_not_configured" }, 503);
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }

  const db = createServerClient();
  const { data, error } = await db
    .from("social_connections")
    .select("id,user_id,provider_account_username,access_token_encrypted,disconnected_at")
    .eq("provider", "pinterest")
    .is("disconnected_at", null)
    .not("access_token_encrypted", "is", null)
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingSchemaError(error)) {
      console.warn("[cron/insights-connections] social_connections is not available — empty work list.");
      return json([], 200);
    }
    console.error("[cron/insights-connections] read failed:", error.message);
    return json({ error: "read_failed", code: "database_unavailable" }, 503);
  }

  // Only the two fields the loop needs. No token material, no account metadata:
  // this response travels over a curl in a crontab and lands in a log file.
  const connections = (data ?? [])
    .filter(row => row.id && row.user_id)
    .map(row => ({
      connectionId: String(row.id),
      userId: String(row.user_id),
    }));

  return json(connections, 200);
}
