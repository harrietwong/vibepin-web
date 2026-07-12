import { createServerClient } from "@/lib/supabase";
import type { ProductWithScore, ProductMetrics } from "@/lib/supabase";
import { classifyDestination, shouldShowInProductIdeas } from "@/lib/assetClassification";
import { mergeProductTiers, resolveProductCategory, STL_BOOTSTRAP_DETAIL } from "@/lib/productTopTiers";
import {
  buildDemandThresholds,
  deriveProductOpportunityPublicMetrics,
  deriveProductSaveCount,
  type ProductOpportunityPublicMetrics,
} from "@/lib/productOpportunityCounts";
import { computeVisiblePlatforms } from "@/lib/mvpTaxonomy";

export const revalidate = 120;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 600;
// Conservative cap for the dedicated bootstrap-detail tier (newest-first), so
// freshly-inserted product-card rows surface without competing inside the legacy
// top-300 source_pin_save_count window. STL_BOOTSTRAP_DETAIL is the
// discovery_method_detail label set by shop_the_look_expand; source_category is
// surfaced only as the derived (non-provenance) `category` filter field.
const BOOTSTRAP_DETAIL_LIMIT = 300;

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

  // Base columns shared by both scored and bootstrap fetches.
  // product_pin_id distinguishes a genuine product-Pin save count from inherited
  // source-Pin saves; product_url_hash / canonical_product_url drive dedup
  // aggregation of product evidence across multiple Pins of the same product.
  const BASE_COLS = `
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
    product_pin_id,
    parent_pin_id,
    canonical_product_url,
    product_url_hash,
    seed_keyword,
    scraped_at,
    created_at,
    discovery_method_detail,
    source_category
  `;

  // Primary fetch: top product rows by direct Pinterest signal. product_scores is
  // an OPTIONAL embed (left join) — Product Opportunity v1 does not depend on it,
  // so rows with no score still surface here. A caller may still request a minimum
  // opportunity_score via ?min_score=N, which upgrades the embed to an inner join
  // (!inner) and re-applies the legacy score filter for backward compatibility.
  const wantScoreFilter = minScore > 0;
  let scoredQuery = db
    .from("pin_products")
    .select(`${BASE_COLS}, product_scores${wantScoreFilter ? "!inner" : ""} (
        opportunity_score,
        trend_score,
        save_velocity_score,
        freshness_score,
        competition_score,
        scored_at
      )`, { count: "exact" })
    .not("image_url", "is", null)
    .range(offset, offset + limit - 1);
  if (wantScoreFilter) {
    scoredQuery = scoredQuery.gte("product_scores.opportunity_score", minScore);
  }

  if (sort === "saves" || sort === "demand" || sort === "most_saved") {
    scoredQuery = scoredQuery.order("save_count", { ascending: false });
  } else if (sort === "velocity") {
    scoredQuery = scoredQuery.order("source_pin_save_count", { ascending: false });
  } else if (sort === "newest") {
    scoredQuery = scoredQuery.order("created_at", { ascending: false });
  } else {
    // Public Opportunity is derived after scored + unscored rows are merged.
    scoredQuery = scoredQuery.order("source_pin_save_count", { ascending: false });
  }

  // Bootstrap fetch: Shop-the-Look product-card rows that have not been scored yet.
  // discovery_method='stl' is set by shop_the_look_expand. We also check
  // discovery_method_detail (available after v28) for forward-compatibility.
  // save_count=0 is explicitly allowed — these products inherit save evidence
  // from the source pin, not the product row itself.
  const bootstrapQuery = db
    .from("pin_products")
    .select(BASE_COLS)
    .eq("discovery_method", "stl")
    .not("image_url", "is", null)
    .not("source_url", "is", null)
    .order("source_pin_save_count", { ascending: false })
    .limit(300);

  // Bootstrap-detail fetch: product-card rows (discovery_method_detail =
  // pinterest_product_card_bootstrap) ordered newest-first, so recently-inserted
  // rows surface even when their inherited source_pin_save_count ranks below the
  // legacy top-300 window above. Same image_url / source_url gating; deduped on
  // merge by row id AND product identity so nothing is duplicated across tiers.
  const bootstrapDetailQuery = db
    .from("pin_products")
    .select(BASE_COLS)
    .eq("discovery_method_detail", STL_BOOTSTRAP_DETAIL)
    .not("image_url", "is", null)
    .not("source_url", "is", null)
    .order("created_at", { ascending: false })
    .order("source_pin_save_count", { ascending: false })
    .limit(BOOTSTRAP_DETAIL_LIMIT);

  // Aggregation fetch: lightweight scan of all product rows to dedup product
  // identity (by product_url_hash → canonical_product_url) and count distinct
  // source Pins / product Pins and sum genuine product-Pin saves. Non-fatal.
  const aggQuery = db
    .from("pin_products")
    .select("product_url_hash,canonical_product_url,parent_pin_id,product_pin_id,save_count");

  const [
    { data: scoredData, error: scoredError, count },
    { data: bootstrapData, error: bootstrapError },
    { data: bootstrapDetailData, error: bootstrapDetailError },
    { data: aggData, error: aggError },
  ] = await Promise.all([scoredQuery, bootstrapQuery, bootstrapDetailQuery, aggQuery]);

  if (scoredError) {
    console.error("[products/top] Supabase scored error:", scoredError.message);
    return Response.json({ error: scoredError.message }, { status: 500 });
  }
  if (bootstrapError) {
    // Bootstrap fetch is non-fatal — log and continue with scored results only.
    console.warn("[products/top] Supabase bootstrap error (non-fatal):", bootstrapError.message);
  }
  if (bootstrapDetailError) {
    // Bootstrap-detail fetch is non-fatal — log and continue without that tier.
    console.warn("[products/top] Supabase bootstrap-detail error (non-fatal):", bootstrapDetailError.message);
  }
  if (aggError) {
    console.warn("[products/top] Supabase aggregation error (non-fatal):", aggError.message);
  }

  // Build product-identity aggregates. Key by the strongest available identity:
  // product_url_hash > canonical_product_url. Rows lacking both aggregate alone.
  type Agg = {
    sourcePins: Set<string>;
    productPins: Set<string>;
    productPinSaves: Map<string, number>; // product_pin_id -> genuine product-Pin saves
  };
  const aggByIdentity = new Map<string, Agg>();
  const identityKey = (r: Record<string, unknown>): string | null => {
    const h = r.product_url_hash as string | null;
    if (h) return `h:${h}`;
    const c = r.canonical_product_url as string | null;
    if (c) return `c:${c}`;
    return null;
  };
  for (const raw of aggData ?? []) {
    const r = raw as Record<string, unknown>;
    const key = identityKey(r);
    if (!key) continue;
    let a = aggByIdentity.get(key);
    if (!a) { a = { sourcePins: new Set(), productPins: new Set(), productPinSaves: new Map() }; aggByIdentity.set(key, a); }
    const parent = r.parent_pin_id as string | null;
    if (parent) a.sourcePins.add(parent);
    const ppid = r.product_pin_id as string | null;
    if (ppid) {
      a.productPins.add(ppid);
      // Genuine product-Pin saves (only meaningful when product_pin_id exists).
      a.productPinSaves.set(ppid, Math.max(a.productPinSaves.get(ppid) ?? 0, (r.save_count as number) ?? 0));
    }
  }

  function enrichRow(row: Record<string, unknown>, scores: Record<string, unknown> | null | undefined) {
    const classified = classifyDestination({
      title: row.product_name as string | null,
      domain: row.domain as string | null,
      sourceUrl: row.source_url as string | null,
      price: row.price as number | null,
      currency: row.currency as string | null,
      category: row.seed_keyword as string | null,
      hasCommerceSignals: true,
    });
    // Resolve a category for filtering. STL bootstrap rows carry source_category
    // (e.g. 'womens-fashion') and usually have no seed_keyword — this derived
    // field is the only way they expose a category. Raw provenance fields
    // (discovery_method, discovery_method_detail, source_category) are NOT returned.
    const category = resolveProductCategory(
      row.discovery_method_detail as string | null | undefined,
      row.source_category as string | null | undefined,
    );

    // ── Honest product evidence ────────────────────────────────────────────
    // A genuine product-Pin save count exists only when this row IS a product
    // Pin (has product_pin_id). Otherwise save_count was inherited from the
    // source "Shop the look" Pin and is a SOURCE metric, not a product metric.
    const productPinId   = (row.product_pin_id as string | null) ?? null;
    const rowSaveCount   = (row.save_count as number) ?? 0;
    const sourcePinSaves = (row.source_pin_save_count as number) ?? 0;
    const hasProductPin  = !!productPinId;

    const h = row.product_url_hash as string | null;
    const c = row.canonical_product_url as string | null;
    const key = h ? `h:${h}` : c ? `c:${c}` : null;
    const dedupIdentity: ProductMetrics["dedupIdentity"] =
      h ? "product_url_hash" : c ? "canonical_product_url" : "pin_product_id";
    const agg = key ? aggByIdentity.get(key) : undefined;

    const productPinSaveValues = agg ? [...agg.productPinSaves.values()] : (hasProductPin ? [rowSaveCount] : []);
    const aggregateProductPinSaves = productPinSaveValues.length
      ? productPinSaveValues.reduce((s, v) => s + v, 0)
      : null;

    const product_metrics: ProductMetrics = {
      productPinSaveCount:      hasProductPin ? rowSaveCount : null,
      sourcePinSaveCount:       sourcePinSaves,
      productSourcePinCount:    agg ? agg.sourcePins.size : (row.parent_pin_id ? 1 : 0),
      uniqueProductPinCount:    agg ? agg.productPins.size : (hasProductPin ? 1 : 0),
      aggregateProductPinSaves,
      primarySaveKind:          hasProductPin ? "product_pin" : "source_pin",
      metricSource:             "pinterest_stl",
      dedupIdentity,
    };

    // Validating source-pin ids (deduped across the product's URL identity
    // group, capped at 5) — lets the detail drawer list the actual Pinterest
    // pins that validated this product.
    const rowParent = row.parent_pin_id as string | null;
    const source_pin_ids = agg
      ? [...agg.sourcePins].filter(id => id && id !== "0").slice(0, 5)
      : (rowParent && rowParent !== "0" ? [rowParent] : []);

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
      product_pin_id:       productPinId,
      product_metrics,
      source_pin_ids,
      seed_keyword:         row.seed_keyword,
      // Derived, non-provenance category for filtering (see comment above).
      category,
      scraped_at:           row.scraped_at,
      created_at:           row.created_at,
      opportunity_score:    scores?.opportunity_score ?? null,
      trend_score:          scores?.trend_score ?? null,
      save_velocity_score:  scores?.save_velocity_score ?? null,
      freshness_score:      scores?.freshness_score ?? null,
      competition_score:    scores?.competition_score ?? null,
      scored_at:            scores?.scored_at ?? null,
      item_type:            classified.item_type,
      product_type:         classified.product_type,
      product_subtype:      classified.product_subtype,
      destination_type:     classified.destination_type,
      asset_role:           classified.asset_role,
      source_context:       classified.source_context,
      risk_flags:           classified.risk_flags,
    };
  }

  // Merge the three tiers (scored → legacy bootstrap → newest bootstrap-detail),
  // deduped by row id and product identity, imageless rows dropped. product_scores
  // live only on scored rows, so capture them before the merge erases tier origin.
  const scoresById = new Map<unknown, Record<string, unknown> | null>();
  for (const row of scoredData ?? []) {
    const r = row as Record<string, unknown>;
    scoresById.set(r.id, (r.product_scores as Record<string, unknown> | null) ?? null);
  }
  const mergedRows = mergeProductTiers({
    scored: (scoredData ?? []) as Record<string, unknown>[],
    bootstrap: (bootstrapData ?? []) as Record<string, unknown>[],
    bootstrapDetail: (bootstrapDetailData ?? []) as Record<string, unknown>[],
  });
  const enrichedRows = mergedRows.map(r => enrichRow(r, scoresById.get(r.id) ?? null));

  const enrichedUnsorted = enrichedRows.filter(row => shouldShowInProductIdeas(row)) as ProductWithScore[];
  const demandThresholds = buildDemandThresholds(enrichedUnsorted);
  // Attach the public Demand / Trend / Competition metrics to every row so the
  // UI renders exactly what the API derived (no unified opportunity label/score
  // — the v2.0 direction lets the user judge from the three metrics).
  const metricsById = new Map<unknown, ProductOpportunityPublicMetrics>();
  for (const row of enrichedUnsorted) {
    metricsById.set(row.id, deriveProductOpportunityPublicMetrics(row, demandThresholds));
  }
  const trendRank: Record<ProductOpportunityPublicMetrics["trend"]["label"], number> = {
    rising: 3,
    stable: 2,
    declining: 1,
    unknown: 0,
  };
  const competitionRank: Record<ProductOpportunityPublicMetrics["competition"]["label"], number> = {
    low: 3,
    medium: 2,
    high: 1,
    unknown: 0,
  };
  const rowTime = (p: ProductWithScore) =>
    Date.parse((p as ProductWithScore & { created_at?: string | null }).created_at ?? p.scraped_at ?? "") || 0;
  const sortValue = (p: ProductWithScore): number => {
    const metrics = metricsById.get(p.id) ?? deriveProductOpportunityPublicMetrics(p, demandThresholds);
    const demand = metrics.demand.saveCount ?? -1;
    if (sort === "newest") return rowTime(p);
    if (sort === "rising") return trendRank[metrics.trend.label] * 1_000_000 + demand;
    if (sort === "low_competition") return competitionRank[metrics.competition.label] * 1_000_000 + demand;
    // Default (and saves/demand/most_saved/velocity/legacy "opportunity"): most saved.
    return deriveProductSaveCount(p).value ?? -1;
  };
  const enriched = [...enrichedUnsorted]
    .sort((a, b) => sortValue(b) - sortValue(a))
    .map(p => ({ ...p, public_metrics: metricsById.get(p.id) ?? null }));

  // Search-keyword join: the actual suggestion keyword (pin_samples.source_keyword)
  // that surfaced each product's SOURCE pin — completes the provenance chain
  // Trend Keyword → Search Keyword → Source Pin → Product. Chunked + non-fatal.
  try {
    const parentIds = [...new Set(
      enriched
        .map(p => (p as { parent_pin_id?: string | null }).parent_pin_id)
        .filter((id): id is string => !!id && id !== "0"),
    )];
    const kwByPin = new Map<string, string>();
    const KW_CHUNK = 150;
    for (let i = 0; i < parentIds.length; i += KW_CHUNK) {
      const { data: kwRows, error: kwError } = await db
        .from("pin_samples")
        .select("pin_id,source_keyword")
        .in("pin_id", parentIds.slice(i, i + KW_CHUNK));
      if (kwError) throw kwError;
      for (const r of (kwRows ?? []) as { pin_id: string | number; source_keyword: string | null }[]) {
        if (r.source_keyword) kwByPin.set(String(r.pin_id), r.source_keyword);
      }
    }
    for (const p of enriched as Array<{ parent_pin_id?: string | null; search_keyword?: string | null }>) {
      p.search_keyword = p.parent_pin_id ? kwByPin.get(String(p.parent_pin_id)) ?? null : null;
    }
  } catch (e) {
    console.warn("[products/top] search-keyword join failed (non-fatal):", e instanceof Error ? e.message : e);
  }

  // Public freshness follows product/demand recency, not legacy score freshness.
  // Score freshness remains available separately in meta for admin/internal health.
  const scoredTimes = (enriched as { scored_at?: string | null }[])
    .map(p => p.scored_at)
    .filter((t): t is string => !!t);
  const lastScored = scoredTimes.length
    ? scoredTimes.reduce((a, b) => (a > b ? a : b))
    : null;

  const createdTimes = (enriched as { created_at?: string | null }[])
    .map(p => p.created_at)
    .filter((t): t is string => !!t);
  const lastProductCreated = createdTimes.length
    ? createdTimes.reduce((a, b) => (a > b ? a : b))
    : null;

  const scrapedTimes = (enriched as { scraped_at?: string | null }[])
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
      .in("job_type", ["stl-score", "daily"])
      .eq("status", "completed")
      .order("finished_at", { ascending: false })
      .limit(1);
    lastPipelineAt = runs?.[0]?.finished_at ?? null;
  } catch {
    /* pipeline_runs may not exist yet */
  }

  const lastUpdatedAt = lastProductCreated ?? lastScraped ?? lastPipelineAt ?? lastScored ?? new Date().toISOString();
  const scoredCount = (enriched as Array<ProductWithScore & { scored_at?: string | null }>).filter(p => p.scored_at).length;
  const unscoredCount = enriched.length - scoredCount;

  // Product-first freshness counters for Product Opportunity v1. These describe the
  // whole pin_products table (not just the visible page) and are the readiness
  // signal that REPLACES product_scores freshness. Cheap head-only counts; the
  // 90s response cache absorbs the extra round-trips. All non-fatal.
  const nowMs = Date.now();
  const sinceIso = (hours: number) => new Date(nowMs - hours * 3_600_000).toISOString();
  const headCount = async (
    q: PromiseLike<{ count: number | null; error: unknown }>,
  ): Promise<number | null> => {
    try {
      const { count: c } = await q;
      return c ?? null;
    } catch {
      return null;
    }
  };
  const pp = () => db.from("pin_products").select("*", { count: "exact", head: true });
  const [
    totalPinProducts,
    productRowsLast24h,
    productRowsLast48h,
    productRowsLast5d,
    missingImageUrlCount,
    missingProductUrlCount,
  ] = await Promise.all([
    headCount(pp()),
    headCount(pp().gte("created_at", sinceIso(24))),
    headCount(pp().gte("created_at", sinceIso(48))),
    headCount(pp().gte("created_at", sinceIso(120))),
    headCount(pp().is("image_url", null)),
    headCount(pp().is("source_url", null)),
  ]);

  // categoryCounts over the returned (visible) items — honest, no extra query.
  const categoryCounts: Record<string, number> = {};
  for (const p of enriched as Array<ProductWithScore & { category?: string | null; seed_keyword?: string | null }>) {
    const cat = p.category ?? p.seed_keyword ?? "uncategorized";
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }

  // ── STABLE platform filter (full-dataset, not the loaded page/subset) ──────────
  // The visible platform options must NOT change with which slice of products the
  // client happened to fetch. Aggregate platforms over the WHOLE clean, user-facing
  // pin_products set (image_url present, source_url present, real source pin i.e.
  // parent_pin_id != '0' — the four E2E fixtures use '0'), normalize domain-first via
  // the shared MVP taxonomy, and apply the same show/Other/hide thresholds. Paginated
  // (>1000 rows) so nothing is silently capped. Non-fatal: on any error the client
  // falls back to computing from its loaded set.
  const PLATFORM_PAGE = 1000;
  let platformVisible: string[] | undefined;
  let platformCounts: Record<string, number> | undefined;
  try {
    const platformRows: Array<{ sourceUrl?: string | null; domain?: string | null }> = [];
    for (let from = 0; from <= 100_000; from += PLATFORM_PAGE) {
      const { data, error } = await db
        .from("pin_products")
        .select("source_url,domain")
        .not("image_url", "is", null)
        .not("source_url", "is", null)
        .neq("parent_pin_id", "0")
        .range(from, from + PLATFORM_PAGE - 1);
      if (error) throw error;
      const batch = (data ?? []) as Array<{ source_url: string | null; domain: string | null }>;
      for (const r of batch) platformRows.push({ sourceUrl: r.source_url, domain: r.domain });
      if (batch.length < PLATFORM_PAGE) break;
    }
    const pv = computeVisiblePlatforms(platformRows);
    platformVisible = pv.showOther ? [...pv.visible, "Other"] : pv.visible;
    platformCounts = pv.counts;
  } catch {
    /* platform aggregation is non-fatal; client falls back to its loaded subset */
  }

  const meta = {
    // Product-first freshness (the Product Opportunity v1 readiness signal).
    productDataLastUpdatedAt: lastProductCreated ?? lastScraped,
    totalPinProducts,
    productRowsLast24h,
    productRowsLast48h,
    productRowsLast5d,
    missingImageUrlCount,
    missingProductUrlCount,
    categoryCounts,
    // Stable, full-dataset platform filter options (see aggregation above).
    platformVisible,
    platformCounts,
    latestProductCreatedAt: lastProductCreated,
    latestPinScrapedAt: lastScraped,
    latestDemandUpdatedAt: lastScraped ?? lastProductCreated,
    latestCompetitionUpdatedAt: lastProductCreated ?? lastScraped,
    // Optional / deprecated: product scoring is NOT required for Product Opportunity.
    latestScoreUpdatedAt: lastScored,
    scoredCount,
    unscoredCount,
    totalVisibleCount: enriched.length,
  };

  const body = JSON.stringify({
    items: enriched,
    data: enriched,
    count,
    limit,
    offset,
    itemCount: enriched.length,
    source: "product_ideas_api",
    lastUpdatedAt,
    meta,
  });
  _cache.set(cacheKey, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
  });
}
