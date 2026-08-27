import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { resolvePlan } from "@/lib/server/entitlements";
import {
  listProductOpportunities,
  ProductMetricControlsNotReadyError,
} from "@/lib/server/productOpportunities";

export const dynamic = "force-dynamic";

function boundedInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedText(value: string | null, maxLength: number): string | undefined {
  const normalized = value?.trim().slice(0, maxLength);
  return normalized || undefined;
}

export async function GET(request: Request) {
  const userId = await getUserIdFromBearerOrCookies(request);
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const familyValue = url.searchParams.get("family");
  const family = familyValue === "physical" || familyValue === "digital"
    ? familyValue
    : undefined;
  const demandValue = url.searchParams.get("demand");
  const trendValue = url.searchParams.get("trend");
  const sortValue = url.searchParams.get("sort");
  try {
    const plan = await resolvePlan(userId);
    const result = await listProductOpportunities(plan, {
      limit: boundedInt(url.searchParams.get("limit"), 50),
      offset: boundedInt(url.searchParams.get("offset"), 0),
      family,
      search: boundedText(url.searchParams.get("search"), 80),
      category: boundedText(url.searchParams.get("category"), 80),
      platform: boundedText(url.searchParams.get("platform"), 120),
      demand: demandValue === "high_recent_demand" ? demandValue : undefined,
      trend: trendValue === "rising" || trendValue === "steady" || trendValue === "cooling"
        ? trendValue
        : undefined,
      sort: sortValue === "newest" || sortValue === "fastest_growing"
        ? sortValue
        : "most_saved",
    });
    return Response.json({ ...result, planAccess: plan === "free" ? "preview" : "full" });
  } catch (error) {
    console.error("[product-opportunities GET]", error instanceof Error ? error.message : error);
    if (error instanceof ProductMetricControlsNotReadyError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: "Product opportunities could not be loaded" }, { status: 503 });
  }
}
