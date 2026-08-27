import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { getInsightsDashboard } from "@/lib/server/insights/dashboard";
import type { InsightsPlatform } from "@/lib/insights/types";

export const dynamic = "force-dynamic";

function isPlatform(value: string | null): value is InsightsPlatform {
  return value === "pinterest" || value === "instagram";
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
    const dashboard = await getInsightsDashboard(uid, platform, connectionId);
    return Response.json(
      { dashboard },
      { headers: { "Cache-Control": "private, max-age=0, must-revalidate" } },
    );
  } catch (error) {
    console.error("[insights] dashboard request failed", error);
    return Response.json({ error: "Insights could not be loaded" }, { status: 500 });
  }
}
