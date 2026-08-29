"use client";

import { freshAccessToken } from "./supabaseBrowser";
import type {
  ProductOpportunityItem,
  ProductOpportunityListResult,
  SavedProductOpportunity,
} from "./server/productOpportunities";

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await freshAccessToken();
  if (!token) throw new Error("Please sign in to view Product Opportunities");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

async function requireOk(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Request failed");
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
  const payload = await requireOk(
    await authedFetch(`/api/product-opportunities?${params.toString()}`),
  );
  return payload as ProductOpportunityListResponse;
}

export async function fetchProductOpportunity(id: string): Promise<ProductOpportunityItem> {
  const payload = await requireOk(
    await authedFetch(`/api/product-opportunities/${encodeURIComponent(id)}`),
  );
  return payload.item as ProductOpportunityItem;
}

export async function fetchSavedProductOpportunities(): Promise<SavedProductOpportunity[]> {
  const payload = await requireOk(await authedFetch("/api/saved-product-opportunities"));
  return (payload.items ?? []) as SavedProductOpportunity[];
}

export async function setProductOpportunitySaved(
  productOpportunityId: string,
  saved: boolean,
): Promise<void> {
  await requireOk(
    await authedFetch("/api/saved-product-opportunities", {
      method: saved ? "POST" : "DELETE",
      body: JSON.stringify({ productOpportunityId }),
    }),
  );
}
