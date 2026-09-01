export type ProductOpportunityApiErrorCode =
  | "AUTH_REQUIRED"
  | "CATALOG_FORBIDDEN"
  | "METRIC_FILTER_NOT_READY"
  | "PRODUCT_NOT_FOUND"
  | "RATE_LIMITED"
  | "CATALOG_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "REQUEST_TIMEOUT"
  | "INVALID_RESPONSE"
  | "WRONG_ENVIRONMENT";

export function productRequestId(): string {
  return crypto.randomUUID();
}

export function productApiError(
  requestId: string,
  code: ProductOpportunityApiErrorCode,
  error: string,
  status: number,
): Response {
  const occurredAt = new Date().toISOString();
  const runtime = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null;
  const deployment = process.env.VERCEL_DEPLOYMENT_ID || null;
  return Response.json(
    { error, code, requestId, occurredAt, runtime, deployment },
    { status, headers: { "x-request-id": requestId } },
  );
}

export function productApiSuccess(
  requestId: string,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(
    { ...body, requestId },
    { status, headers: { "x-request-id": requestId } },
  );
}
