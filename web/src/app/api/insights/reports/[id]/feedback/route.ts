/**
 * POST /api/insights/reports/:id/feedback — body `{ "helpful": true | false }`.
 *
 * One thumb per user per report, upserted: clicking the other one is a changed mind,
 * not a second vote. This is the only signal that separates a report which is
 * technically true and completely useless from one that changed what somebody did,
 * and every later decision about which rules to keep depends on it existing.
 *
 * `helpful` must be a boolean. A missing or malformed value is a 400 rather than a
 * coerced `false`: recording an opinion nobody expressed would poison the only
 * measurement this endpoint exists to take.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { INSIGHTS_DIAGNOSIS_LOCKED, insightsDiagnosisAllowed } from "@/lib/insights/paidGate";
import { resolvePlan } from "@/lib/server/entitlements";
import { saveReportFeedback } from "@/lib/server/insights/reportStore";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await getUserIdFromSameOriginSession(req);
    if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const plan = await resolvePlan(uid).catch(() => "free" as const);
    if (!insightsDiagnosisAllowed(plan)) {
      return Response.json({ ...INSIGHTS_DIAGNOSIS_LOCKED }, { status: 403 });
    }

    const body = await req.json().catch(() => null) as { helpful?: unknown } | null;
    if (typeof body?.helpful !== "boolean") {
      return Response.json({ error: "helpful must be true or false" }, { status: 400 });
    }

    const { id } = await params;
    const saved = await saveReportFeedback(uid, id, body.helpful);
    if (!saved) return Response.json({ error: "Report not found" }, { status: 404 });

    return Response.json({ reportId: id, helpful: body.helpful });
  } catch (error) {
    console.error("[insights] report feedback failed", error);
    return Response.json({ error: "Feedback could not be saved" }, { status: 500 });
  }
}
