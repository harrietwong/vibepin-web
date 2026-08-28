/**
 * GET /api/insights/reports — this user's current reports, newest first.
 *
 * Query: `connectionId` (optional), `kind` (optional: weekly | scorecard_t7 |
 * scorecard_t30).
 *
 * `connectionId` is optional on purpose, and it is the one place this route departs
 * from the original work order. The Plan board shows Pin cards from every connected
 * account at once and needs to know which of them carry a scorecard; forcing a
 * connection id would mean one request per account on a page that has no reason to
 * know how many accounts exist. Omitting it means "every Pinterest connection I own",
 * resolved server-side from the session — never from anything the caller sends.
 *
 * The rows are SUMMARIES: id, period, headline. The body lives behind
 * /api/insights/reports/[id], because reading the body is what marks a report viewed,
 * and a list render is not a reading. That split is also why a list of twenty
 * scorecards does not silently freeze twenty reports.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { INSIGHTS_DIAGNOSIS_LOCKED, insightsDiagnosisAllowed } from "@/lib/insights/paidGate";
import { resolvePlan } from "@/lib/server/entitlements";
import {
  listCurrentReports,
  pinterestConnectionIds,
  REPORT_LIST_LIMIT,
} from "@/lib/server/insights/reportStore";
import type { InsightReportKind } from "@/lib/insights/reportTypes";

export const dynamic = "force-dynamic";

function readKind(value: string | null): InsightReportKind | undefined {
  return value === "weekly" || value === "scorecard_t7" || value === "scorecard_t30"
    ? value
    : undefined;
}

export async function GET(req: Request) {
  try {
    const uid = await getUserIdFromSameOriginSession(req);
    if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // Free plans get the placeholder and an empty list — not a filtered list, and
    // not a headline in a field the client is asked not to render.
    const plan = await resolvePlan(uid).catch(() => "free" as const);
    if (!insightsDiagnosisAllowed(plan)) {
      return Response.json({ ...INSIGHTS_DIAGNOSIS_LOCKED, reports: [] });
    }

    const url = new URL(req.url);
    const connectionIds = await pinterestConnectionIds(uid, url.searchParams.get("connectionId"));
    const reports = await listCurrentReports(uid, {
      connectionIds,
      kind: readKind(url.searchParams.get("kind")),
      limit: REPORT_LIST_LIMIT,
    });

    return Response.json(
      { reports },
      { headers: { "Cache-Control": "private, max-age=0, must-revalidate" } },
    );
  } catch (error) {
    console.error("[insights] report list failed", error);
    return Response.json({ error: "Reports could not be loaded" }, { status: 500 });
  }
}
