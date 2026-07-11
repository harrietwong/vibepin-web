import { createServerClient } from "@/lib/supabase";
import type { TrendOpportunity } from "@/lib/supabase";
import {
  buildReadinessFromEvidence,
  parseReadinessFromInternalCodes,
} from "@/lib/opportunityReadiness";

export const revalidate = 120;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// GET /api/opportunities
// Query params:
//   ?limit=20               — rows (default 20, max 100)
//   ?category=fashion       — filter by category
//   ?min_score=0            — minimum opportunity_score (0-100)
//   ?min_products=0         — minimum linked_products_count
//   ?confidence=high        — filter by data_confidence ('high'|'medium'|'low')
//   ?offset=0               — pagination
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const limit      = Math.min(parseInt(searchParams.get("limit")    ?? String(DEFAULT_LIMIT), 10), MAX_LIMIT);
  const offset     = parseInt(searchParams.get("offset")   ?? "0", 10);
  const category   = searchParams.get("category");
  const minScore   = parseFloat(searchParams.get("min_score")   ?? "0");
  const minProds   = parseInt(searchParams.get("min_products")  ?? "0", 10);
  const confidence = searchParams.get("confidence");

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
    .order("opportunity_score", { ascending: false })
    .range(offset, offset + limit - 1);

  if (category && category !== "all") {
    query = query.eq("category", category.toLowerCase());
  }
  if (minProds > 0) {
    query = query.gte("linked_products_count", minProds);
  }
  if (confidence && confidence !== "all") {
    query = query.eq("data_confidence", confidence.toLowerCase());
  }

  const { data, error, count } = await query;

  if (error) {
    console.error("[opportunities] Supabase error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as TrendOpportunity[];
  const keywords = rows.map(r => r.keyword).filter(Boolean);
  let oppMeta: Record<string, {
    primary_label?: string | null;
    trend_state?: string | null;
    internal_reason_codes?: unknown;
  }> = {};

  if (keywords.length) {
    const { data: oppRows } = await db
      .from("opportunities")
      .select("canonical_keyword,category,primary_label,trend_state,internal_reason_codes")
      .in("canonical_keyword", keywords);
    for (const o of oppRows ?? []) {
      const key = `${o.canonical_keyword as string}::${(o.category as string | null) ?? ""}`;
      oppMeta[key] = o;
    }
  }

  const enriched = rows.map(row => {
    const key = `${row.keyword}::${row.category ?? ""}`;
    const meta = oppMeta[key] ?? oppMeta[`${row.keyword}::`];
    const readiness = meta?.internal_reason_codes
      ? parseReadinessFromInternalCodes(meta.internal_reason_codes)
      : buildReadinessFromEvidence({
          keywordId: row.keyword_id,
          category: row.category,
          linkedProductsCount: row.linked_products_count,
          linkedPinsCount: row.linked_pins_count,
          totalSourceSaves: row.total_source_saves,
          yearlyChange: row.pct_growth_yoy,
          trendState: meta?.trend_state ?? undefined,
        });

    return {
      ...row,
      primary_label: meta?.primary_label ?? null,
      trend_state: meta?.trend_state ?? null,
      readinessStatus: readiness?.readinessStatus ?? null,
      readinessReasons: readiness?.readinessReasons ?? [],
      productAvailabilityTier: readiness?.productAvailabilityTier ?? null,
      referenceAvailabilityTier: readiness?.referenceAvailabilityTier ?? null,
    };
  });

  return Response.json({
    data: enriched,
    count,
    limit,
    offset,
  });
}
