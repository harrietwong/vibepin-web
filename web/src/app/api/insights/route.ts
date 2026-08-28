import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { getInsightsDashboard } from "@/lib/server/insights/dashboard";
import { resolvePlan } from "@/lib/server/entitlements";
import { shapeDashboardForPlan } from "@/lib/insights/paidGate";
import type { InsightsPlatform, InsightsScope } from "@/lib/insights/types";

export const dynamic = "force-dynamic";

function isPlatform(value: string | null): value is InsightsPlatform {
  return value === "pinterest" || value === "instagram";
}

/**
 * `scope` defaults to `vibepin` rather than rejecting an absent value: every client
 * that existed before this parameter asked for the VibePin publish set, and a
 * default that changed their answer would be a silent reinterpretation of old links
 * and bookmarks. An unrecognised value falls back the same way — this selects a
 * reading of the user data, so guessing is worse than the documented default.
 */
function readScope(value: string | null): InsightsScope {
  return value === "account" ? "account" : "vibepin";
}

export async function GET(req: Request) {
  try {
    const uid = await getUserIdFromSameOriginSession(req);
    if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const platform = url.searchParams.get("platform");
    if (!isPlatform(platform)) {
      return Response.json({ error: "platform must be pinterest or instagram" }, { status: 400 });
    }

    const connectionId = url.searchParams.get("connectionId");
    const scope = readScope(url.searchParams.get("scope"));
    // The plan is resolved server-side and the payload is SHAPED by it — the client
    // is never sent a diagnosis with a flag asking it not to look. A free plan gets
    // the same metrics and the same rows; what it does not get is the reading.
    const [dashboard, plan] = await Promise.all([
      getInsightsDashboard(uid, platform, connectionId, scope),
      resolvePlan(uid).catch(() => "free" as const),
    ]);
    return Response.json(
      { dashboard: shapeDashboardForPlan(dashboard, plan) },
      { headers: { "Cache-Control": "private, max-age=0, must-revalidate" } },
    );
  } catch (error) {
    console.error("[insights] dashboard request failed", error);
    return Response.json({ error: "Insights could not be loaded" }, { status: 500 });
  }
}
