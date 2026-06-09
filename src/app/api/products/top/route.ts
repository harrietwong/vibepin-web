import { createServerClient } from "@/lib/supabase";
import type { ProductWithScore } from "@/lib/supabase";
import { classifyDestination, shouldShowInProductIdeas } from "@/lib/assetClassification";

export const revalidate = 120;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 600;

// In-memory cache so that dev-mode (where revalidate is ignored) still serves fast repeat requests.
// Cache key: full URL search param string → { body, expiresAt }
const _cache = new Map<string, { body: string; expiresAt: number }>();
const CACHE_TTL_MS = 90_000;

// GET /api/products/top
// Query params:
//   ?limit=20          — rows (default 20, max 100)
//   ?category=home     — filter by seed keyword category
//   ?min_score=0       — minimum opportunity_score
//   ?offset=0          — pagination
//   ?sort=opportunity  — sort field: opportunity | saves | velocity
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cacheKey = searchParams.toString();
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return new Response(cached.body, {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
    });
  }

  const limit     = Math.min(parseInt(searchParams.get("limit")     ?? String(DEFAULT_LIMIT), 10), MAX_LIMIT);
  const offset    = parseInt(searchParams.get("offset")    ?? "0", 10);
  const minScore  = parseFloat(searchParams.get("min_score") ?? "0");
  const sort      = searchParams.get("sort") ?? "opportunity";

  const db = createServerClient();

  // Join pin_products with product_scores
  let query = db
    .from("pin_products")
    .select(`
      id,
      product_name,
      price,
      currency,
      domain,
      merchant,
      image_url,
      source_url,
      save_count,
      source_pin_save_count,
      seed_keyword,
      scraped_at,
      product_scores (
        opportunity_score,
        trend_score,
        save_velocity_score,
        freshness_score,
        competition_score,
        scored_at
      )
    `, { count: "exact" })
    .not("product_scores", "is", null)
    .gte("product_scores.opportunity_score", minScore)
    .range(offset, offset + limit - 1);

  if (sort === "saves") {
    query = query.order("save_count", { ascending: false });
  } else if (sort === "velocity") {
    query = query.order("source_pin_save_count", { ascending: false });
  } else {
    query = query.order("product_scores(opportunity_score)", { ascending: false });
  }

  const { data, error, count } = await query;

  if (error) {
    console.error("[products/top] Supabase error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const enriched = (data ?? []).map((row: Record<string, unknown>) => {
    const scores = row.product_scores as Record<string, unknown> | null | undefined;
    const classified = classifyDestination({
      title: row.product_name as string | null,
      domain: row.domain as string | null,
      sourceUrl: row.source_url as string | null,
      price: row.price as number | null,
      currency: row.currency as string | null,
      category: row.seed_keyword as string | null,
      hasCommerceSignals: true,
    });
    return {
      id:                   row.id,
      product_name:         row.product_name,
      price:                row.price,
      currency:             row.currency,
      domain:               row.domain,
      merchant:             row.merchant,
      image_url:            row.image_url,
      source_url:           row.source_url,
      save_count:           row.save_count,
      source_pin_save_count: row.source_pin_save_count,
      seed_keyword:         row.seed_keyword,
      scraped_at:           row.scraped_at,
      opportunity_score:    scores?.opportunity_score ?? null,
      trend_score:          scores?.trend_score ?? null,
      save_velocity_score:  scores?.save_velocity_score ?? null,
      freshness_score:      scores?.freshness_score ?? null,
      competition_score:    scores?.competition_score ?? null,
      item_type:            classified.item_type,
      product_type:         classified.product_type,
      product_subtype:      classified.product_subtype,
      destination_type:     classified.destination_type,
      asset_role:           classified.asset_role,
      source_context:       classified.source_context,
      risk_flags:           classified.risk_flags,
    };
  }).filter(row => shouldShowInProductIdeas(row)) as ProductWithScore[];

  const scrapedTimes = enriched
    .map(p => p.scraped_at)
    .filter((t): t is string => !!t);
  const lastScraped = scrapedTimes.length
    ? scrapedTimes.reduce((a, b) => (a > b ? a : b))
    : null;

  let lastPipelineAt: string | null = null;
  try {
    const { data: runs } = await db
      .from("pipeline_runs")
      .select("finished_at")
      .eq("job_type", "stl-score")
      .eq("status", "completed")
      .order("finished_at", { ascending: false })
      .limit(1);
    lastPipelineAt = runs?.[0]?.finished_at ?? null;
  } catch {
    /* pipeline_runs may not exist yet */
  }

  const lastUpdatedAt = lastPipelineAt ?? lastScraped ?? new Date().toISOString();

  const body = JSON.stringify({
    items: enriched,
    data: enriched,
    count,
    limit,
    offset,
    itemCount: enriched.length,
    source: "product_ideas_api",
    lastUpdatedAt,
  });
  _cache.set(cacheKey, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
  });
}
