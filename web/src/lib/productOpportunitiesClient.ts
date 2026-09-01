"use client";

import { freshAccessToken } from "./supabaseBrowser";
import type {
  ProductOpportunityItem,
  ProductOpportunityListResult,
  SavedProductOpportunity,
} from "./server/productOpportunities";
import type { ProductOpportunityApiErrorCode } from "./server/productOpportunityApiResponse";

export type ProductOpportunityErrorInfo = {
  message: string;
  method: string;
  path: string;
  status: number | null;
  code: ProductOpportunityApiErrorCode;
  requestId: string | null;
  occurredAt: string;
  runtime: string | null;
  deployment: string | null;
};

export class ProductOpportunityClientError extends Error {
  readonly info: ProductOpportunityErrorInfo;

  constructor(info: ProductOpportunityErrorInfo) {
    super(info.message);
    this.name = "ProductOpportunityClientError";
    this.info = info;
  }
}

function clientError(
  message: string,
  path: string,
  code: ProductOpportunityApiErrorCode,
  status: number | null = null,
  requestId: string | null = null,
  method = "GET",
  environment: Partial<Pick<ProductOpportunityErrorInfo, "occurredAt" | "runtime" | "deployment">> = {},
): ProductOpportunityClientError {
  return new ProductOpportunityClientError({
    message, method, path, status, code, requestId,
    occurredAt: environment.occurredAt ?? new Date().toISOString(),
    runtime: environment.runtime ?? null,
    deployment: environment.deployment ?? null,
  });
}

export function productOpportunityErrorInfo(reason: unknown): ProductOpportunityErrorInfo {
  if (reason instanceof ProductOpportunityClientError) return reason.info;
  return {
    message: reason instanceof Error ? reason.message : "Product data could not be loaded",
    method: "GET",
    path: "/api/product-opportunities",
    status: null,
    code: "NETWORK_ERROR",
    requestId: null,
    occurredAt: new Date().toISOString(),
    runtime: null,
    deployment: null,
  };
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await freshAccessToken();
  const method = init.method ?? "GET";
  if (!token) throw clientError("Please sign in to view Product Opportunities", path, "AUTH_REQUIRED", 401, null, method);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(path, { ...init, headers, credentials: "same-origin", signal: controller.signal });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") {
      throw clientError("The product request timed out", path, "REQUEST_TIMEOUT", null, null, method);
    }
    throw clientError("The product request could not reach the server", path, "NETWORK_ERROR", null, null, method);
  } finally {
    window.clearTimeout(timeout);
  }
}

async function requireOk(response: Response, path: string, method = "GET"): Promise<Record<string, unknown>> {
  const requestId = response.headers.get("x-request-id");
  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw clientError("The product service returned an invalid response", path, "INVALID_RESPONSE", response.status, requestId, method);
  }
  if (!response.ok) {
    const code = typeof payload.code === "string" ? payload.code as ProductOpportunityApiErrorCode : "CATALOG_UNAVAILABLE";
    throw clientError(
      typeof payload.error === "string" ? payload.error : "Product request failed",
      path,
      code,
      response.status,
      typeof payload.requestId === "string" ? payload.requestId : requestId,
      method,
      {
        occurredAt: typeof payload.occurredAt === "string" ? payload.occurredAt : undefined,
        runtime: typeof payload.runtime === "string" ? payload.runtime : null,
        deployment: typeof payload.deployment === "string" ? payload.deployment : null,
      },
    );
  }
  return payload;
}

export type ProductOpportunityListResponse = {
  items: ProductOpportunityItem[];
  accessibleCount: number;
  hasLockedCatalog: boolean;
  metricControls: ProductOpportunityListResult["metricControls"];
  planAccess: "preview" | "full";
};

export async function fetchProductOpportunities(options: {
  limit?: number;
  offset?: number;
  family?: "physical" | "digital";
  search?: string;
  category?: string;
  platform?: string;
  demand?: "high_recent_demand";
  trend?: "rising" | "steady" | "cooling";
  sort?: "most_saved" | "newest" | "fastest_growing";
} = {}): Promise<ProductOpportunityListResponse> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.offset != null) params.set("offset", String(options.offset));
  if (options.family) params.set("family", options.family);
  if (options.search) params.set("search", options.search);
  if (options.category) params.set("category", options.category);
  if (options.platform) params.set("platform", options.platform);
  if (options.demand) params.set("demand", options.demand);
  if (options.trend) params.set("trend", options.trend);
  if (options.sort) params.set("sort", options.sort);
  const path = `/api/product-opportunities?${params.toString()}`;
  const payload = await requireOk(await authedFetch(path), path);
  return payload as ProductOpportunityListResponse;
}

export async function fetchProductOpportunity(id: string): Promise<ProductOpportunityItem> {
  const path = `/api/product-opportunities/${encodeURIComponent(id)}`;
  const payload = await requireOk(await authedFetch(path), path);
  return payload.item as ProductOpportunityItem;
}

export async function fetchSavedProductOpportunities(): Promise<SavedProductOpportunity[]> {
  const path = "/api/saved-product-opportunities";
  const payload = await requireOk(await authedFetch(path), path);
  return (payload.items ?? []) as SavedProductOpportunity[];
}

export async function setProductOpportunitySaved(
  productOpportunityId: string,
  saved: boolean,
): Promise<void> {
  const path = "/api/saved-product-opportunities";
  const method = saved ? "POST" : "DELETE";
  await requireOk(
    await authedFetch(path, {
      method,
      body: JSON.stringify({ productOpportunityId }),
    }),
    path,
    method,
  );
}
