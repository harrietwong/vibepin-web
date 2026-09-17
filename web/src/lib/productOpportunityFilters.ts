export type ProductOpportunityFamilyFilter = "all" | "physical" | "digital";
export type ProductOpportunityDemandFilter = "" | "high_recent_demand";
export type ProductOpportunityTrendFilter = "" | "rising" | "steady" | "cooling";
export type ProductOpportunitySort = "most_saved" | "newest" | "fastest_growing";

export type ProductOpportunityFilters = {
  family: ProductOpportunityFamilyFilter;
  search: string;
  category: string;
  platform: string;
  demand: ProductOpportunityDemandFilter;
  trend: ProductOpportunityTrendFilter;
  sort: ProductOpportunitySort;
};

export const DEFAULT_PRODUCT_OPPORTUNITY_FILTERS: ProductOpportunityFilters = {
  family: "all",
  search: "",
  category: "",
  platform: "",
  demand: "",
  trend: "",
  sort: "most_saved",
};

function bounded(value: string | null, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

export function parseProductOpportunityFilterQuery(search: string): ProductOpportunityFilters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const family = params.get("family");
  const demand = params.get("demand");
  const trend = params.get("trend");
  const sort = params.get("sort");
  return {
    family: family === "physical" || family === "digital" ? family : "all",
    search: bounded(params.get("q"), 80),
    category: bounded(params.get("category"), 80),
    platform: bounded(params.get("platform"), 120).toLowerCase(),
    demand: demand === "high_recent_demand" ? demand : "",
    trend: trend === "rising" || trend === "steady" || trend === "cooling" ? trend : "",
    sort: sort === "newest" || sort === "fastest_growing" ? sort : "most_saved",
  };
}

export function serializeProductOpportunityFilterQuery(filters: ProductOpportunityFilters): string {
  const params = new URLSearchParams();
  if (filters.family !== "all") params.set("family", filters.family);
  if (filters.search) params.set("q", bounded(filters.search, 80));
  if (filters.category) params.set("category", bounded(filters.category, 80));
  if (filters.platform) params.set("platform", bounded(filters.platform, 120).toLowerCase());
  if (filters.demand) params.set("demand", filters.demand);
  if (filters.trend) params.set("trend", filters.trend);
  if (filters.sort !== "most_saved") params.set("sort", filters.sort);
  return params.toString();
}
