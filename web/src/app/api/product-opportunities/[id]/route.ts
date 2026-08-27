import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { resolvePlan } from "@/lib/server/entitlements";
import { getProductOpportunity } from "@/lib/server/productOpportunities";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromBearerOrCookies(request);
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const item = await getProductOpportunity(await resolvePlan(userId), id);
    if (!item) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ item });
  } catch (error) {
    console.error("[product-opportunities detail GET]", error instanceof Error ? error.message : error);
    return Response.json({ error: "Product details could not be loaded" }, { status: 503 });
  }
}
