/**
 * GET /api/cron/instagram-comment-dm — Instagram comment keyword → private reply (DM).
 *
 * TRIGGER: a VPS crontab hits this every 5 minutes with the same bearer CRON_SECRET
 * as /api/cron/publish-due and /api/cron/expire-reservations (comment webhooks need
 * Advanced Access + a Live app, which we don't have — so phase 1 POLLS).
 * See docs/运维/IG评论私信-cron配置.md.
 *
 * For every Instagram connection with ≥1 enabled rule: scope gate → token →
 * reclaim stale claims → scan recent comments → claim (unique connection_id +
 * comment_id) → private reply → optional public reply. All logic lives in
 * lib/server/instagram/commentDmRun.ts; this file is only auth + budget.
 *
 * `?dryRun=1` → no claims, no sends, no writes; returns the would-send list.
 *
 * Safe at any frequency and from more than one caller: the unique claim is OUR
 * idempotency guarantee. (Meta's docs say each comment can only get one private
 * reply; the actual error code for a duplicate send is still unverified, to be
 * checked in Phase 0 — do not rely on Meta to reject a second send.)
 *
 * NOTE: route files may export ONLY Next.js handlers/config — a helper export here
 * breaks the production build.
 */

import { createServerClient } from "@/lib/supabase";
import { getInstagramAccessToken } from "@/lib/server/instagram/connectionStore";
import { runCommentDmCron, MAX_SENDS_PER_CONNECTION } from "@/lib/server/instagram/commentDmRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Stop STARTING new work (media scan, comment page, claim, send) after 25s of the
 * 60s maxDuration. Every Graph call has a 15s timeout, so the worst in-flight tail
 * — a DM started at 24.9s (≤15s) plus its public reply (≤15s) plus row writes —
 * still finishes before Vercel kills the function. Being killed between a sent DM
 * and its `sent` write would leave the row `claimed` and retry it 15 min later.
 */
const RUN_BUDGET_MS = 25_000;

function isMissingTable(message: string): boolean {
  return /instagram_comment_dm_(rules|events)/.test(message)
    && /(does not exist|could not find the table|schema cache)/i.test(message);
}

export async function GET(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // ── Auth: bearer CRON_SECRET. Missing config ⇒ 503, never run unauthenticated. ──
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/instagram-comment-dm] CRON_SECRET is not configured — refusing to run.");
    return Response.json({ error: "cron_not_configured", code: "cron_not_configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized", code: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRunParam = url.searchParams.get("dryRun");
  const dryRun = dryRunParam === "1" || dryRunParam === "true";

  try {
    const summary = await runCommentDmCron(
      {
        db: createServerClient(),
        getToken: async (userId, connectionId) => {
          const t = await getInstagramAccessToken(userId, connectionId);
          return t ? { accessToken: t.accessToken } : null;
        },
      },
      { dryRun, deadlineAt: startedAt + RUN_BUDGET_MS, maxSends: MAX_SENDS_PER_CONNECTION },
    );
    const sent = summary.connections.reduce((n, c) => n + c.sent, 0);
    const failed = summary.connections.reduce((n, c) => n + c.failed, 0);
    if (sent > 0 || failed > 0) {
      console.log(`[cron/instagram-comment-dm] sent=${sent} failed=${failed} connections=${summary.connections.length}`);
    }
    return Response.json({ ok: true, elapsedMs: Date.now() - startedAt, ...summary });
  } catch (err) {
    const message = (err as Error).message ?? "unknown";
    if (isMissingTable(message)) {
      // v83 not applied on this environment yet: a deployment-ordering fact, not a fault.
      console.warn("[cron/instagram-comment-dm] v83 tables are not deployed yet — nothing to do.");
      return Response.json({ ok: true, available: false, connections: [] });
    }
    console.error("[cron/instagram-comment-dm] run failed:", message);
    return Response.json({ error: "run_failed", code: "database_unavailable" }, { status: 503 });
  }
}
