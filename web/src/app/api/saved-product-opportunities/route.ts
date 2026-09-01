import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { resolvePlan } from "@/lib/server/entitlements";
import {
  listSavedProductOpportunities,
  removeSavedProductOpportunity,
  saveProductOpportunity,
} from "@/lib/server/productOpportunities";
import { productApiError, productApiSuccess, productRequestId } from "@/lib/server/productOpportunityApiResponse";

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
  const requestId = productRequestId();
  const auth = await authenticated(request);
  if (!auth) return productApiError(requestId, "AUTH_REQUIRED", "Unauthorized", 401);
  try {
    return productApiSuccess(requestId, { items: await listSavedProductOpportunities(auth.userId, auth.plan) });
  } catch (error) {
    console.error("[saved-product-opportunities GET]", error instanceof Error ? error.message : error);
    return productApiError(requestId, "CATALOG_UNAVAILABLE", "Saved products could not be loaded", 503);
  }
}

export async function POST(request: Request) {
  const requestId = productRequestId();
  const auth = await authenticated(request);
  if (!auth) return productApiError(requestId, "AUTH_REQUIRED", "Unauthorized", 401);
  const id = await productId(request);
  if (!id) return productApiError(requestId, "INVALID_RESPONSE", "productOpportunityId is required", 400);
  try {
    if (!(await saveProductOpportunity(auth.userId, auth.plan, id))) {
      return productApiError(requestId, "PRODUCT_NOT_FOUND", "Not found", 404);
    }
    return productApiSuccess(requestId, { saved: true }, 201);
  } catch (error) {
    console.error("[saved-product-opportunities POST]", error instanceof Error ? error.message : error);
    return productApiError(requestId, "CATALOG_UNAVAILABLE", "Product could not be saved", 503);
  }
}

export async function DELETE(request: Request) {
  const requestId = productRequestId();
  const auth = await authenticated(request);
  if (!auth) return productApiError(requestId, "AUTH_REQUIRED", "Unauthorized", 401);
  const id = await productId(request);
  if (!id) return productApiError(requestId, "INVALID_RESPONSE", "productOpportunityId is required", 400);
  try {
    await removeSavedProductOpportunity(auth.userId, id);
    return productApiSuccess(requestId, { saved: false });
  } catch (error) {
    console.error("[saved-product-opportunities DELETE]", error instanceof Error ? error.message : error);
    return productApiError(requestId, "CATALOG_UNAVAILABLE", "Saved product could not be removed", 503);
  }
}
