import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { listConnections } from "@/lib/social/server/socialConnectionStore";
import {
  listKeywordCategories,
  readStoredCategory,
  writeConnectionCategory,
} from "@/lib/server/insights/keywordSetStore";
import { invalidateInsightsCache } from "@/lib/server/insights/dashboard";
import { resolvePlan } from "@/lib/server/entitlements";
import { insightsDiagnosisAllowed, INSIGHTS_DIAGNOSIS_LOCKED } from "@/lib/insights/paidGate";

export const dynamic = "force-dynamic";

/**
 * The account category the evidence engine measures against.
 *
 * GET returns the current value, whether it was inferred, and the categories that can
 * be chosen. PATCH sets it.
 *
 * Three things this route refuses to do.
 *
 * **It will not accept a category we have no keywords for.** The list comes from the
 * distinct categories of `trend_keywords`, so a user cannot name "vintage motorcycles",
 * get a cheerful 200, and then wonder why every observation says `insufficient`
 * forever. A rejected value with the valid list attached is a worse-feeling and much
 * more honest answer.
 *
 * **It will not write to a connection it has not verified belongs to the caller.**
 * Ownership is resolved through `listConnections(uid)` — the same projection the rest
 * of the social layer uses — rather than by trusting the id in the body.
 *
 * **It will not leave a stale diagnosis on screen.** The dashboard is cached for ten
 * minutes per connection; changing the category and being shown the old category
 * numbers is indistinguishable from the setting being ignored, so the cache entries
 * for that connection are dropped in the same request.
 */
export async function GET(req: Request) {
  try {
    const uid = await getUserIdFromSameOriginSession(req);
    if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const connectionId = url.searchParams.get("connectionId");
    const connections = (await listConnections(uid)).filter(item => item.provider === "pinterest");
    const connection = connectionId
      ? connections.find(item => item.id === connectionId)
      : connections[0];
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });

    const stored = readStoredCategory(connection.metadata);
    return Response.json({
      connectionId: connection.id,
      category: stored.category,
      inferred: stored.inferred,
      categories: await listKeywordCategories(),
    });
  } catch (error) {
    console.error("[insights] category read failed", error);
    return Response.json({ error: "Category could not be read" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const uid = await getUserIdFromSameOriginSession(req);
    if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // The category exists to aim the diagnosis. On a plan that receives no diagnosis
    // there is nothing to aim, and accepting the write would store a preference whose
    // only visible effect is one the user cannot see.
    const plan = await resolvePlan(uid).catch(() => "free" as const);
    if (!insightsDiagnosisAllowed(plan)) {
      return Response.json({ ...INSIGHTS_DIAGNOSIS_LOCKED, error: "Upgrade required" }, { status: 403 });
    }

    const body = await req.json().catch(() => null) as { connectionId?: unknown; category?: unknown } | null;
    const connectionId = typeof body?.connectionId === "string" ? body.connectionId.trim() : "";
    const category = typeof body?.category === "string" ? body.category.trim() : "";
    if (!connectionId || !category) {
      return Response.json({ error: "connectionId and category are required" }, { status: 400 });
    }

    const connections = (await listConnections(uid)).filter(item => item.provider === "pinterest");
    const connection = connections.find(item => item.id === connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });

    const categories = await listKeywordCategories();
    if (!categories.includes(category)) {
      return Response.json(
        { error: "Unknown category", categories },
        { status: 400 },
      );
    }

    // `inferred: false` is the point of the write: from here on this is the user's
    // answer, and the nightly inference must never overwrite it.
    const written = await writeConnectionCategory(uid, connection.id, category, false);
    if (!written) return Response.json({ error: "Category could not be saved" }, { status: 500 });

    invalidateInsightsCache(uid, connection.id);
    return Response.json({ connectionId: connection.id, category, inferred: false });
  } catch (error) {
    console.error("[insights] category update failed", error);
    return Response.json({ error: "Category could not be saved" }, { status: 500 });
  }
}
