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

export type ProductOpportunityApiEvidence = {
  method: string;
  path: string;
  status: number;
  requestId: string;
  occurredAt: string;
  runtime: string | null;
  deployment: string | null;
};

export function productRequestId(): string {
  return crypto.randomUUID();
}

export function productApiError(
  requestId: string,
  code: ProductOpportunityApiErrorCode,
  error: string,
  status: number,
  request: Partial<Pick<ProductOpportunityApiEvidence, "method" | "path">> = {},
): Response {
  const occurredAt = new Date().toISOString();
  const runtime = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null;
  const deployment = process.env.VERCEL_DEPLOYMENT_ID || null;
  const evidence: ProductOpportunityApiEvidence = {
    method: request.method ?? "GET",
    path: request.path ?? "/api/product-opportunities",
    status,
    requestId,
    occurredAt,
    runtime,
    deployment,
  };
  return Response.json(
    { error, code, requestId, occurredAt, runtime, deployment, evidence },
    { status, headers: { "x-request-id": requestId } },
  );
}

export function productApiSuccess(
  requestId: string,
  body: Record<string, unknown>,
  status = 200,
  request: Partial<Pick<ProductOpportunityApiEvidence, "method" | "path">> = {},
): Response {
  const occurredAt = new Date().toISOString();
  const runtime = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null;
  const deployment = process.env.VERCEL_DEPLOYMENT_ID || null;
  const evidence: ProductOpportunityApiEvidence = {
    method: request.method ?? "GET",
    path: request.path ?? "/api/product-opportunities",
    status,
    requestId,
    occurredAt,
    runtime,
    deployment,
  };
  return Response.json(
    { ...body, requestId, occurredAt, runtime, deployment, evidence },
    { status, headers: { "x-request-id": requestId } },
  );
}
