import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { resolvePlan } from "@/lib/server/entitlements";
import { getProductOpportunity } from "@/lib/server/productOpportunities";
import { productApiError, productApiSuccess, productRequestId } from "@/lib/server/productOpportunityApiResponse";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = productRequestId();
  const evidenceRequest = { method: request.method, path: new URL(request.url).pathname };
  const userId = await getUserIdFromBearerOrCookies(request);
  if (!userId) return productApiError(requestId, "AUTH_REQUIRED", "Unauthorized", 401, evidenceRequest);
  const { id } = await context.params;
  try {
    const item = await getProductOpportunity(await resolvePlan(userId), id);
    if (!item) return productApiError(requestId, "PRODUCT_NOT_FOUND", "Not found", 404, evidenceRequest);
    return productApiSuccess(requestId, { item }, 200, evidenceRequest);
  } catch (error) {
    console.error(`[product-opportunities detail GET][${requestId}]`, error instanceof Error ? error.message : "unknown error");
    return productApiError(requestId, "CATALOG_UNAVAILABLE", "Product details could not be loaded", 503, evidenceRequest);
  }
}
