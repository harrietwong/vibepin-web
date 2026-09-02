/**
 * GET /api/cron/admin-alerts — pushes newly-opened customer blockers as a
 * single daily summary email.
 *
 * WHY THIS EXISTS
 * `getActionCenter()` already knows who is stuck; nothing pushed that out
 * before this route existed — the founder only found out by opening
 * /admin/today. This is the SEND trigger only: all selection, dedupe, and
 * assembly logic lives in `web/src/lib/server/adminAlerts.ts` (kept there so
 * it stays independently testable and to guarantee this route and the
 * /admin/today page can never diverge on WHO counts as blocked — see that
 * module's header for the hard constraints).
 *
 * TRIGGER: VPS crontab, same channel/pattern as
 * /api/cron/expire-reservations (NOT `vercel.json` crons — see that route's
 * header and docs/prd/后台异常提醒与功能评价体系-PRD-v0.1-20260902.md §2.5).
 * Frequency: once daily, per the PRD's "state-transition, not daily re-send"
 * dedupe design — running it more often is safe (idempotent) but pointless.
 *
 * FAILURE POSTURE: this must never 500 on a business-logic condition (no
 * recipient configured, email provider down, action center unavailable) —
 * those are all reported 200 with a structured summary so a VPS crontab does
 * not alarm on expected steady states. Only auth failures and an unexpected
 * thrown exception return non-200.
 */

import { runAdminAlerts } from "@/lib/server/adminAlerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function GET(req: Request): Promise<Response> {
  // ── Auth: bearer CRON_SECRET. Missing config ⇒ 503, never run unauthenticated. ──
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/admin-alerts] CRON_SECRET is not configured — refusing to run.");
    return json({ error: "cron_not_configured", code: "cron_not_configured" }, 503);
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }

  try {
    const result = await runAdminAlerts();

    if (!result.available) {
      console.warn("[cron/admin-alerts] action center unavailable — pushed nothing this run.");
    } else if (result.newlyNotified > 0) {
      console.log(
        `[cron/admin-alerts] scanned=${result.scanned} new=${result.newlyNotified} cleared=${result.cleared} ` +
          `stillOpen=${result.stillOpen} email.sent=${result.email.sent} email.skipped=${result.email.skipped} email.failed=${result.email.failed}`,
      );
    }
    if (result.email.failed) {
      console.error(`[cron/admin-alerts] email send failed: ${result.email.errorSummary ?? "unknown error"}`);
    }

    return json({
      available: result.available,
      scanned: result.scanned,
      newlyNotified: result.newlyNotified,
      cleared: result.cleared,
      stillOpen: result.stillOpen,
      email: result.email,
      warnings: result.warnings,
    });
  } catch (err) {
    // Never crash the crontab caller — report the failure as structured data.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/admin-alerts] run threw:", message);
    return json({ error: "run_failed", code: "internal_error", message }, 503);
  }
}
