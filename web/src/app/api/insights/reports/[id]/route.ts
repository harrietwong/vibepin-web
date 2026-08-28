/**
 * GET /api/insights/reports/:id — one report's body.
 *
 * Reading marks `viewed_at`, once, and that mark is what freezes the row: from then
 * on the database refuses to change its content columns. This is the only update any
 * read path in Insights performs, and it is deliberate — a report becomes immutable
 * when a human has seen it, not when a job decides it is done.
 *
 * A report belonging to another user returns 404, not 403: a 403 would confirm the id
 * exists, and report ids are the only handles this feature hands out.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { INSIGHTS_DIAGNOSIS_LOCKED, insightsDiagnosisAllowed } from "@/lib/insights/paidGate";
import { resolvePlan } from "@/lib/server/entitlements";
import { readReport } from "@/lib/server/insights/reportStore";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await getUserIdFromSameOriginSession(req);
    if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const plan = await resolvePlan(uid).catch(() => "free" as const);
    if (!insightsDiagnosisAllowed(plan)) {
      // No report, and no viewed_at either: a plan that cannot read the body must
      // not be able to freeze it.
      return Response.json({ ...INSIGHTS_DIAGNOSIS_LOCKED }, { status: 403 });
    }

    const { id } = await params;
    const report = await readReport(uid, id);
    if (!report) return Response.json({ error: "Report not found" }, { status: 404 });

    return Response.json(
      { report },
      { headers: { "Cache-Control": "private, max-age=0, must-revalidate" } },
    );
  } catch (error) {
    console.error("[insights] report read failed", error);
    return Response.json({ error: "Report could not be loaded" }, { status: 500 });
  }
}
