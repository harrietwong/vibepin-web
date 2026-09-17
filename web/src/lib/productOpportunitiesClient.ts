"use client";

import { freshAccessToken } from "./supabaseBrowser";
import type {
  ProductOpportunityItem,
  ProductOpportunityCatalogState,
  ProductOpportunityListResult,
  ProductOpportunityPartialReason,
  ProductOpportunityViewState,
  SavedProductOpportunity,
} from "./server/productOpportunities";
import type { ProductOpportunityApiErrorCode } from "./server/productOpportunityApiResponse";

export type ProductOpportunityResponseEvidence = {
  method: string;
  path: string;
  status: number;
  requestId: string;
  occurredAt: string;
  runtime: string | null;
  deployment: string | null;
};

const PRODUCT_CATALOG_STATES = new Set<ProductOpportunityCatalogState>([
  "ready", "partial", "catalog-empty", "filtered-empty",
]);
const PRODUCT_API_ERROR_CODES = new Set<ProductOpportunityApiErrorCode>([
  "AUTH_REQUIRED", "CATALOG_FORBIDDEN", "METRIC_FILTER_NOT_READY", "PRODUCT_NOT_FOUND",
  "RATE_LIMITED", "CATALOG_UNAVAILABLE", "NETWORK_ERROR", "REQUEST_TIMEOUT",
  "INVALID_RESPONSE", "WRONG_ENVIRONMENT",
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeProductOpportunityPath(path: string): string {
  try {
    return new URL(path, "http://product-opportunity.local").pathname || "/";
  } catch {
    return path.split(/[?#]/, 1)[0] || "/";
  }
}

function invalidResponse(
  path: string,
  method: string,
  status: number,
  requestId: string | null = null,
): ProductOpportunityClientError {
  return clientError(
    "The product service returned an invalid response",
    safeProductOpportunityPath(path),
    "INVALID_RESPONSE",
    status,
    requestId,
    method,
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function normalizeProductOpportunityOccurredAt(value: unknown, fallback = new Date().toISOString()): string {
  return isIsoDate(value) ? value : fallback;
}

function decodeEvidence(
  value: unknown,
  path: string,
  method: string,
  status: number,
): ProductOpportunityResponseEvidence {
  const expectedPath = safeProductOpportunityPath(path);
  if (!isRecord(value)) throw invalidResponse(path, method, status);
  const evidencePath = value.path;
  const evidenceMethod = value.method;
  if (
    typeof evidenceMethod !== "string"
    || !/^[A-Z]+$/.test(evidenceMethod)
    || evidenceMethod !== method.toUpperCase()
    || typeof evidencePath !== "string"
    || evidencePath !== expectedPath
    || /[?#]/.test(evidencePath)
    || !Number.isInteger(value.status)
    || (value.status as number) < 100
    || (value.status as number) > 599
    || value.status !== status
    || typeof value.requestId !== "string"
    || !value.requestId.trim()
    || !isIsoDate(value.occurredAt)
    || !(value.runtime === null || typeof value.runtime === "string")
    || !(value.deployment === null || typeof value.deployment === "string")
  ) {
    throw invalidResponse(path, method, status, typeof value.requestId === "string" ? value.requestId : null);
  }
  return {
    method: evidenceMethod,
    path: evidencePath,
    status: value.status,
    requestId: value.requestId,
    occurredAt: value.occurredAt,
    runtime: value.runtime,
    deployment: value.deployment,
  };
}

function decodeEvidenceFromPayload(
  payload: UnknownRecord,
  path: string,
  method: string,
  status: number,
): ProductOpportunityResponseEvidence {
  return decodeEvidence(payload.evidence, path, method, status);
}

function isProductOpportunityItem(value: unknown): value is ProductOpportunityItem {
  if (!isRecord(value)) return false;
  const family = value.productFamily;
  const evidenceType = value.pinterestEvidenceType;
  const momentum = value.recentMomentum;
  const additional = value.additionalPinterestEvidence;
  return typeof value.id === "string" && value.id.trim().length > 0
    && isNullableString(value.productName)
    && typeof value.productImageUrl === "string" && value.productImageUrl.trim().length > 0
    && typeof value.productUrl === "string" && value.productUrl.trim().length > 0
    && isNullableString(value.merchant) && isNullableString(value.domain)
    && isNullableString(value.category) && isNullableString(value.productType)
    && (family === "physical" || family === "digital")
    && typeof value.pinterestUrl === "string" && value.pinterestUrl.trim().length > 0
    && (evidenceType === "product_pin" || evidenceType === "source_pin")
    && Array.isArray(additional)
    && additional.every((entry) => isRecord(entry)
      && typeof entry.pinterestUrl === "string" && entry.pinterestUrl.trim().length > 0
      && (entry.pinterestEvidenceType === "product_pin" || entry.pinterestEvidenceType === "source_pin"))
    && (value.latestPinterestSaves === null || (typeof value.latestPinterestSaves === "number" && Number.isFinite(value.latestPinterestSaves)))
    && (value.latestPinterestSnapshotAt === null || isIsoDate(value.latestPinterestSnapshotAt))
    && (value.savesGained30d === null || (typeof value.savesGained30d === "number" && Number.isFinite(value.savesGained30d)))
    && (value.currentSavesGained7d === null || (typeof value.currentSavesGained7d === "number" && Number.isFinite(value.currentSavesGained7d)))
    && (value.previousSavesGained7d === null || (typeof value.previousSavesGained7d === "number" && Number.isFinite(value.previousSavesGained7d)))
    && (value.highRecentDemand === null || typeof value.highRecentDemand === "boolean")
    && (momentum === null || momentum === "rising" || momentum === "steady" || momentum === "cooling")
    && (value.momentumPercent === null || (typeof value.momentumPercent === "number" && Number.isFinite(value.momentumPercent)));
}

function decodeMetricControls(value: unknown): ProductOpportunityListResult["metricControls"] {
  if (!isRecord(value)
    || typeof value.available !== "boolean"
    || !(value.family === null || value.family === "physical" || value.family === "digital")
    || !(value.metricVersion === null || (Number.isInteger(value.metricVersion) && (value.metricVersion as number) > 0))
    || (value.available && (value.family === null || value.metricVersion === null))
    || (!value.available && (value.family !== null || value.metricVersion !== null))
  ) throw new Error("metric controls");
  return {
    available: value.available,
    family: value.family as "physical" | "digital" | null,
    metricVersion: value.metricVersion as number | null,
  };
}

function decodeItemOrNull(value: unknown): ProductOpportunityItem | null {
  return value === null ? null : isProductOpportunityItem(value) ? value : (() => { throw new Error("item"); })();
}

export function decodeProductOpportunityListResponse(
  payload: unknown,
  path: string,
  method: string,
  status: number,
): ProductOpportunityListResponse {
  if (!isRecord(payload)) throw invalidResponse(path, method, status);
  let evidence: ProductOpportunityResponseEvidence | undefined;
  try {
    evidence = decodeEvidenceFromPayload(payload, path, method, status);
    if (!Array.isArray(payload.items) || !payload.items.every(isProductOpportunityItem)
      || !Number.isInteger(payload.accessibleCount) || (payload.accessibleCount as number) < 0
      || (payload.accessibleCount as number) < payload.items.length
      || typeof payload.hasLockedCatalog !== "boolean"
      || !["preview", "full"].includes(payload.planAccess as string)
      || !PRODUCT_CATALOG_STATES.has(payload.state as ProductOpportunityCatalogState)
      || !(payload.stateReason === null || payload.stateReason === "incomplete-count")
      || (payload.state === "partial" ? payload.stateReason !== "incomplete-count" : payload.stateReason !== null)
      || (payload.state === "ready" && payload.items.length === 0)
      || (payload.state === "partial" && payload.items.length === 0)
      || ((payload.state === "catalog-empty" || payload.state === "filtered-empty") && payload.items.length > 0)
      || ((payload.state === "catalog-empty" || payload.state === "filtered-empty") && payload.accessibleCount !== 0)
    ) throw new Error("list shape");
    const metricControls = decodeMetricControls(payload.metricControls);
    return {
      items: payload.items as ProductOpportunityItem[],
      accessibleCount: payload.accessibleCount as number,
      hasLockedCatalog: payload.hasLockedCatalog as boolean,
      metricControls,
      planAccess: payload.planAccess as "preview" | "full",
      state: payload.state as ProductOpportunityCatalogState,
      stateReason: payload.stateReason as ProductOpportunityPartialReason | null,
      evidence,
    };
  } catch (reason) {
    if (reason instanceof ProductOpportunityClientError) throw reason;
    throw invalidResponse(path, method, status, evidence?.requestId ?? null);
  }
}

export function decodeProductOpportunityDetailResponse(
  payload: unknown,
  path: string,
  method: string,
  status: number,
): { item: ProductOpportunityItem; evidence: ProductOpportunityResponseEvidence } {
  if (!isRecord(payload)) throw invalidResponse(path, method, status);
  try {
    const evidence = decodeEvidenceFromPayload(payload, path, method, status);
    if (!isProductOpportunityItem(payload.item)) throw new Error("detail shape");
    return { item: payload.item, evidence };
  } catch (reason) {
    if (reason instanceof ProductOpportunityClientError) throw reason;
    throw invalidResponse(path, method, status);
  }
}

export function decodeSavedProductOpportunitiesResponse(
  payload: unknown,
  path: string,
  method: string,
  status: number,
): { items: SavedProductOpportunity[]; evidence: ProductOpportunityResponseEvidence } {
  if (!isRecord(payload)) throw invalidResponse(path, method, status);
  try {
    const evidence = decodeEvidenceFromPayload(payload, path, method, status);
    if (!Array.isArray(payload.items)) throw new Error("saved shape");
    const items = payload.items.map((value) => {
      if (!isRecord(value)
        || typeof value.productOpportunityId !== "string" || !value.productOpportunityId.trim()
        || !isIsoDate(value.savedAt)
        || typeof value.requiresUpgrade !== "boolean"
      ) throw new Error("saved record");
      return {
        productOpportunityId: value.productOpportunityId,
        savedAt: value.savedAt,
        requiresUpgrade: value.requiresUpgrade,
        item: decodeItemOrNull(value.item),
        historyItem: decodeItemOrNull(value.historyItem),
      };
    });
    return { items, evidence };
  } catch (reason) {
    if (reason instanceof ProductOpportunityClientError) throw reason;
    throw invalidResponse(path, method, status);
  }
}

export function decodeProductOpportunitySaveResponse(
  payload: unknown,
  path: string,
  method: string,
  status: number,
  expectedSaved: boolean,
): { saved: boolean; evidence: ProductOpportunityResponseEvidence } {
  if (!isRecord(payload)) throw invalidResponse(path, method, status);
  try {
    const evidence = decodeEvidenceFromPayload(payload, path, method, status);
    if (typeof payload.saved !== "boolean" || payload.saved !== expectedSaved) throw new Error("save intent mismatch");
    return { saved: payload.saved, evidence };
  } catch (reason) {
    if (reason instanceof ProductOpportunityClientError) throw reason;
    throw invalidResponse(path, method, status);
  }
}

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
  evidence?: ProductOpportunityResponseEvidence;
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
  evidence?: ProductOpportunityResponseEvidence,
): ProductOpportunityClientError {
  return new ProductOpportunityClientError({
    message, method, path: safeProductOpportunityPath(path), status, code, requestId,
    occurredAt: environment.occurredAt ?? new Date().toISOString(),
    runtime: environment.runtime ?? null,
    deployment: environment.deployment ?? null,
    evidence,
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

async function requireOk(response: Response, path: string, method = "GET"): Promise<UnknownRecord> {
  const requestId = response.headers.get("x-request-id");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw clientError("The product service returned an invalid response", path, "INVALID_RESPONSE", response.status, requestId, method);
  }
  if (!response.ok) {
    const record = isRecord(payload) ? payload : {};
    const code = typeof record.code === "string" && PRODUCT_API_ERROR_CODES.has(record.code as ProductOpportunityApiErrorCode)
      ? record.code as ProductOpportunityApiErrorCode
      : "CATALOG_UNAVAILABLE";
    throw clientError(
      typeof record.error === "string" ? record.error : "Product request failed",
      path,
      code,
      response.status,
      typeof record.requestId === "string" ? record.requestId : requestId,
      method,
      {
        occurredAt: normalizeProductOpportunityOccurredAt(record.occurredAt),
        runtime: typeof record.runtime === "string" ? record.runtime : null,
        deployment: typeof record.deployment === "string" ? record.deployment : null,
      },
      (() => {
        try {
          return decodeEvidence(record.evidence, path, method, response.status);
        } catch {
          return undefined;
        }
      })(),
    );
  }
  if (!isRecord(payload)) {
    throw invalidResponse(path, method, response.status, requestId);
  }
  return payload;
}

export type ProductOpportunityListResponse = {
  items: ProductOpportunityItem[];
  accessibleCount: number;
  hasLockedCatalog: boolean;
  metricControls: ProductOpportunityListResult["metricControls"];
  planAccess: "preview" | "full";
  state: ProductOpportunityCatalogState;
  stateReason: ProductOpportunityPartialReason | null;
  evidence: ProductOpportunityResponseEvidence;
};

export function productOpportunityViewState(
  result: ProductOpportunityListResponse | null,
  error: ProductOpportunityErrorInfo | null,
  hasExistingItems: boolean,
  syncing = false,
): ProductOpportunityViewState {
  if (syncing) return "syncing";
  if (error) return error.code === "AUTH_REQUIRED"
    ? "auth-required"
    : hasExistingItems ? "stale" : "api-error";
  if (!result) return hasExistingItems ? "stale" : "loading";
  if ((result.state === "ready" || result.state === "partial") && result.items.length === 0) return "api-error";
  if ((result.state === "catalog-empty" || result.state === "filtered-empty") && result.items.length > 0) return "api-error";
  return result.state === "ready" ? "success" : result.state;
}

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
  const query = params.toString();
  const path = query ? `/api/product-opportunities?${query}` : "/api/product-opportunities";
  const response = await authedFetch(path);
  const payload = await requireOk(response, path);
  return decodeProductOpportunityListResponse(payload, path, "GET", response.status);
}

export async function fetchProductOpportunity(id: string): Promise<ProductOpportunityItem> {
  const path = `/api/product-opportunities/${encodeURIComponent(id)}`;
  const response = await authedFetch(path);
  const payload = await requireOk(response, path);
  return decodeProductOpportunityDetailResponse(payload, path, "GET", response.status).item;
}

export async function fetchSavedProductOpportunities(): Promise<SavedProductOpportunity[]> {
  const path = "/api/saved-product-opportunities";
  const response = await authedFetch(path);
  const payload = await requireOk(response, path);
  return decodeSavedProductOpportunitiesResponse(payload, path, "GET", response.status).items;
}

export async function setProductOpportunitySaved(
  productOpportunityId: string,
  saved: boolean,
): Promise<void> {
  const path = "/api/saved-product-opportunities";
  const method = saved ? "POST" : "DELETE";
  const response = await authedFetch(path, {
      method,
      body: JSON.stringify({ productOpportunityId }),
    });
  const payload = await requireOk(response, path, method);
  decodeProductOpportunitySaveResponse(payload, path, method, response.status, saved);
}
