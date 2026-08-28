/**
 * POST /api/cron/insights-reports — write one connection's due reports.
 *
 * Body: `{ "connectionId": "<uuid>", "force": false }`. One connection per call, the
 * same shape as insights-collect, and for the same reason: the crontab loops, this
 * endpoint does one unit of work and says exactly what it wrote. Run it AFTER the
 * collection for that connection — it reads the ledger the collector just filled, and
 * running it first would freeze yesterday's evidence into today's report.
 *
 * The user id is resolved HERE from the connection row and is never accepted from the
 * caller, so a caller holding the cron secret still cannot aim a generation at
 * someone else's account.
 *
 * Two things it deliberately does NOT do. It does not send anything: writing a report
 * and delivering it are separate steps with separate ledgers (v65 insight_email_send),
 * and a generator that emailed would have no way to be re-run safely. And it does not
 * generate for a free plan — the gate is inside the generator, so a row that should
 * not exist never does.
 */

import { generateReportsForConnection } from "@/lib/server/insights/reportStore";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Reports read the ledger and write a handful of rows; the ceiling is generous
 *  because the evidence build behind them is the same one the dashboard does. */
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
  );
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/insights-reports] CRON_SECRET is not configured — refusing to run.");
    return json({ error: "cron_not_configured", code: "cron_not_configured" }, 503);
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }

  let body: { connectionId?: unknown; force?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body", code: "invalid_body" }, 400);
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  if (!connectionId) {
    return json({ error: "connectionId is required", code: "invalid_body" }, 400);
  }
  // `force` only overrides the Monday rule for the weekly report. It cannot make a
  // scorecard due early, because "seven days old" is a fact about the Pin.
  const force = body.force === true;

  const db = createServerClient();
  const { data: row, error } = await db
    .from("social_connections")
    .select("id,user_id,disconnected_at")
    .eq("id", connectionId)
    .eq("provider", "pinterest")
    .maybeSingle();

  if (error) {
    if (isMissingSchemaError(error)) {
      return json({ connectionId, skipped: "schema_unavailable" }, 200);
    }
    console.error("[cron/insights-reports] connection read failed:", error.message);
    return json({ error: "read_failed", code: "database_unavailable" }, 503);
  }
  if (!row || !row.user_id) {
    return json({ error: "connection_not_found", code: "not_found" }, 404);
  }
  // A disconnected account is NOT skipped: reports are built from the ledger, and the
  // history of an account someone disconnected on Tuesday is still their history.

  try {
    const result = await generateReportsForConnection(String(row.user_id), connectionId, { force });
    if (result.skipped) {
      console.log(`[cron/insights-reports] connection=${connectionId} skipped (${result.skipped})`);
    }
    return json(result, 200);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`[cron/insights-reports] connection=${connectionId} failed:`, message);
    return json({ error: "generation_failed", code: "generation_failed", message }, 503);
  }
}
