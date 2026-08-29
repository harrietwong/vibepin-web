import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { resolvePlan } from "@/lib/server/entitlements";
import {
  listSavedProductOpportunities,
  removeSavedProductOpportunity,
  saveProductOpportunity,
} from "@/lib/server/productOpportunities";

export const dynamic = "force-dynamic";

async function authenticated(request: Request) {
  const userId = await getUserIdFromBearerOrCookies(request);
  return userId ? { userId, plan: await resolvePlan(userId) } : null;
}

async function productId(request: Request): Promise<string | null> {
  try {
    const body = await request.json() as Record<string, unknown>;
    return typeof body.productOpportunityId === "string" && body.productOpportunityId.trim()
      ? body.productOpportunityId.trim()
      : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await authenticated(request);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json({ items: await listSavedProductOpportunities(auth.userId, auth.plan) });
  } catch (error) {
    console.error("[saved-product-opportunities GET]", error instanceof Error ? error.message : error);
    return Response.json({ error: "Saved products could not be loaded" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticated(request);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const id = await productId(request);
  if (!id) return Response.json({ error: "productOpportunityId is required" }, { status: 400 });
  try {
    if (!(await saveProductOpportunity(auth.userId, auth.plan, id))) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ saved: true }, { status: 201 });
  } catch (error) {
    console.error("[saved-product-opportunities POST]", error instanceof Error ? error.message : error);
    return Response.json({ error: "Product could not be saved" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const auth = await authenticated(request);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const id = await productId(request);
  if (!id) return Response.json({ error: "productOpportunityId is required" }, { status: 400 });
  try {
    await removeSavedProductOpportunity(auth.userId, id);
    return Response.json({ saved: false });
  } catch (error) {
    console.error("[saved-product-opportunities DELETE]", error instanceof Error ? error.message : error);
    return Response.json({ error: "Saved product could not be removed" }, { status: 503 });
  }
}
