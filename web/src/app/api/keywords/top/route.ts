import { createServerClient } from "@/lib/supabase";
import type { TrendOpportunity } from "@/lib/supabase";

export const revalidate = 120;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// GET /api/keywords/top
// Query params:
//   ?limit=20               — rows (default 20, max 100)
//   ?category=home          — filter by category
//   ?min_score=0            — minimum opportunity_score
//   ?min_products=1         — only keywords with at least N linked products
//   ?confidence=medium      — filter by data_confidence ('high'|'medium'|'low')
//   ?offset=0               — pagination
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const limit       = Math.min(parseInt(searchParams.get("limit")        ?? String(DEFAULT_LIMIT), 10), MAX_LIMIT);
  const offset      = parseInt(searchParams.get("offset")      ?? "0", 10);
  const category    = searchParams.get("category");
  const minScore    = parseFloat(searchParams.get("min_score")  ?? "0");
  const minProducts = parseInt(searchParams.get("min_products") ?? "1",  10);
  const confidence  = searchParams.get("confidence");

  const db = createServerClient();

  const FIELDS =
    "keyword_id,keyword,category,pct_growth_yoy,search_volume_level,priority_score," +
    "linked_products_count,linked_pins_count,total_source_saves," +
    "opportunity_score,avg_velocity_score,avg_trend_score,avg_freshness_score," +
    "score_tier,data_confidence,confidence_reason,top_product_ids,last_scored_at";

  let query = db
    .from("trend_opportunities_view")
    .select(FIELDS, { count: "exact" })
    .gte("opportunity_score", minScore)
    .gte("linked_products_count", minProducts)
    .order("opportunity_score", { ascending: false })
    .range(offset, offset + limit - 1);

  if (category && category !== "all") {
    query = query.eq("category", category.toLowerCase());
  }
  if (confidence && confidence !== "all") {
    query = query.eq("data_confidence", confidence.toLowerCase());
  }

  const { data, error, count } = await query;

  if (error) {
    console.error("[keywords/top] Supabase error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({
    data: (data ?? []) as unknown as TrendOpportunity[],
    count,
    limit,
    offset,
  });
}
