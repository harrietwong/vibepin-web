/**
 * POST /api/cron/insights-collect — run one connection's daily collection.
 *
 * Body: `{ "connectionId": "<uuid>", "maxCalls": 30 }`. One connection per call, by
 * design: the daily budget is per connection (v5 §2.3), and a single request that
 * looped over every account would blow the serverless time limit long before it blew
 * the API allowance. The crontab loops; this endpoint does one unit of work and says
 * exactly what it spent. See docs/运维/Insights采集-cron配置.md.
 *
 * The user id is resolved HERE from the connection row and is never accepted from
 * the caller. `PinterestClient.forConnection(uid, connectionId)` then re-asserts the
 * pair, so even a caller holding the cron secret cannot aim a collection run at a
 * connection under someone else's identity.
 *
 * Returns the collection_run summaries so a crontab log line is enough to tell
 * "collected nothing because there was nothing to do" from "collected nothing
 * because Pinterest rate-limited us" — the distinction the v64 ledger exists for.
 */

import { collectForConnection } from "@/lib/server/insights/collector";
import { MAX_CALLS_PER_RUN } from "@/lib/server/insights/collectorLogic";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 300 = current Vercel Hobby cap. The collector holds its own ~100s deadline so it
 *  finishes and closes its ledger rows; the headroom above it exists so a single 60s
 *  rate-limit backoff near the end cannot get the process killed mid-write. */
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

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

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/insights-collect] CRON_SECRET is not configured — refusing to run.");
    return json({ error: "cron_not_configured", code: "cron_not_configured" }, 503);
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }

  let body: { connectionId?: unknown; maxCalls?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body", code: "invalid_body" }, 400);
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  if (!connectionId) {
    return json({ error: "connectionId is required", code: "invalid_body" }, 400);
  }
  // Capped, never trusted: an unbounded maxCalls would let one run exhaust the
  // account's whole allowance and time out on the way.
  const requested = Number(body.maxCalls);
  const maxCalls = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_CALLS_PER_RUN)
    : MAX_CALLS_PER_RUN;

  // Resolve the owner server-side. A connection that is disconnected or tokenless is
  // not an error — it is simply not collectable, and saying so beats a 500.
  const db = createServerClient();
  const { data: row, error } = await db
    .from("social_connections")
    .select("id,user_id,disconnected_at,access_token_encrypted")
    .eq("id", connectionId)
    .eq("provider", "pinterest")
    .maybeSingle();

  if (error) {
    if (isMissingSchemaError(error)) {
      return json({ connectionId, skipped: "schema_unavailable", runs: [] }, 200);
    }
    console.error("[cron/insights-collect] connection read failed:", error.message);
    return json({ error: "read_failed", code: "database_unavailable" }, 503);
  }
  if (!row || !row.user_id) {
    return json({ error: "connection_not_found", code: "not_found" }, 404);
  }
  if (row.disconnected_at || !row.access_token_encrypted) {
    return json({ connectionId, skipped: "not_connected", runs: [] }, 200);
  }

  try {
    const result = await collectForConnection(String(row.user_id), connectionId, maxCalls);
    if (result.stoppedEarly) {
      console.log(
        `[cron/insights-collect] connection=${connectionId} stopped early (${result.stopReason}) `
        + `calls=${result.callsMade}/${result.callsBudget}`,
      );
    }
    return json({
      connectionId: result.connectionId,
      callsMade: result.callsMade,
      callsBudget: result.callsBudget,
      stoppedEarly: result.stoppedEarly,
      stopReason: result.stopReason,
      runs: result.runs,
    }, 200);
  } catch (thrown) {
    // A real collection failure is a 503, never a green 200: a collector that
    // reports success while collecting nothing is the failure this ledger exists to
    // make impossible.
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`[cron/insights-collect] connection=${connectionId} failed:`, message);
    return json({ error: "collection_failed", code: "collection_failed", message }, 503);
  }
}
