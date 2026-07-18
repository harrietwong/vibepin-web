import { createServerClient } from "@/lib/supabase";
import {
  getMonetizeHint,
  getTitleTemplates,
  scoreTierToWorkspaceTier,
  type WorkspaceTier,
} from "@/lib/workspaceStatics";
import { getDbCategory } from "@/lib/categories";
import { excludeRetired } from "@/lib/productTopTiers";

// Force dynamic rendering — never serve a cached response for paginated requests
export const dynamic  = "force-dynamic";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT     = 50;

type PinSample = {
  id: string;
  image_url: string;
  save_count: number;
  trend_keyword_id: string | null;
};

// Raw shape returned by trend_opportunities_view select
type RawOpp = {
  keyword_id:            string;
  keyword:               string;
  category:              string;
  opportunity_score:     number | null;
  avg_velocity_score:    number | null;
  avg_freshness_score:   number | null;
  linked_products_count: number;
  linked_pins_count:     number;
  total_source_saves:    number;
  score_tier:            string;
  pct_growth_yoy:        number | null;
  weekly_change:         number | null;
  search_volume_level:   string | null;
  trend_lifecycle:       string | null;
};

// Raw shape from keyword_product_map
type KpmRow = {
  keyword_id:      string;
  product_id:      string;
  relevance_score: number;
};

// Raw shape from pin_products
type RawProduct = {
  id:           string;
  product_name: string | null;
  domain:       string | null;
  merchant:     string | null;
  image_url:    string | null;
  source_url:   string | null;
};

// ── Public types ──────────────────────────────────────────────────────────────

export type ShopSignal = {
  id:           string;
  product_name: string;
  domain:       string;      // e.g. "etsy.com", "amazon.com"
  image_url:    string | null;
  source_url:   string | null;
};

export type WorkspaceFeedItem = {
  keyword_id:            string;
  keyword:               string;
  category:              string;
  tier:                  WorkspaceTier;
  opportunity_score:     number | null;
  avg_velocity_score:    number | null;
  avg_freshness_score:   number | null;
  linked_products_count: number;
  linked_pins_count:     number;
  total_source_saves:    number;
  score_tier:            string;
  pct_growth_yoy:        number | null;
  weekly_change:         number | null;
  search_volume_level:   string | null;
  trend_lifecycle:       string | null;
  pin_samples:           Pick<PinSample, "id" | "image_url" | "save_count">[];
  shop_signals:          ShopSignal[];
  monetize_hint:         string;
  title_templates:       string[];
};

// GET /api/workspace/feed?category=home-decor&limit=24&offset=0
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawCategory = searchParams.get("category") ?? "home-decor";
  const category    = getDbCategory(rawCategory);

  const limit  = Math.min(
    Math.max(parseInt(searchParams.get("limit")  ?? String(DEFAULT_LIMIT), 10), 1),
    MAX_LIMIT,
  );
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10), 0);

  // Fetch one extra row to determine whether more pages exist
  const fetchCount = limit + 1;

  const db = createServerClient();

  // 1. Fetch a page of Best Bet / Steady opportunities only (score_tier ≠ 'low').
  //    Requires migrate_v15 to be applied so score_tier = opportunity_tier
  //    (based on trend + pin evidence, not dependent on linked_products_count).
  const { data: rawOpps, error } = await db
    .from("trend_opportunities_view")
    .select(
      "keyword_id,keyword,category,opportunity_score,avg_velocity_score," +
      "avg_freshness_score,linked_products_count,linked_pins_count," +
      "total_source_saves,score_tier,pct_growth_yoy,weekly_change,search_volume_level," +
      "trend_lifecycle"
    )
    .eq("category", category)
    .neq("score_tier", "low")          // Watchlist filter: hide HOT RED SEA from main feed
    .order("opportunity_score",   { ascending: false, nullsFirst: false })
    .order("avg_velocity_score",  { ascending: false, nullsFirst: false })
    .range(offset, offset + fetchCount - 1);

  const opps = rawOpps as RawOpp[] | null;

  if (error) {
    console.error("[workspace/feed]", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const hasMore  = (opps?.length ?? 0) > limit;
  const pageOpps = (opps ?? []).slice(0, limit);

  if (!pageOpps.length) {
    return Response.json({ data: [], hasMore: false });
  }

  const keywordIds = pageOpps.map(o => o.keyword_id).filter(Boolean) as string[];

  // 2. Fetch viral pin thumbnails (max 3 per keyword)
  const { data: pins } = await db
    .from("pin_samples")
    .select("id,image_url,save_count,trend_keyword_id")
    .in("trend_keyword_id", keywordIds)
    .gte("save_count", 100)
    .not("image_url", "is", null)
    .order("save_count", { ascending: false })
    .limit(Math.min(keywordIds.length * 25, 600));

  const pinMap: Record<string, PinSample[]> = {};
  for (const pin of (pins ?? []) as PinSample[]) {
    if (!pin.trend_keyword_id) continue;
    if (!pinMap[pin.trend_keyword_id]) pinMap[pin.trend_keyword_id] = [];
    if (pinMap[pin.trend_keyword_id].length < 3) {
      pinMap[pin.trend_keyword_id].push(pin);
    }
  }

  // 3. Fetch shop signals via keyword_product_map → pin_products (two-step)
  //    Step 3a: get (keyword_id, product_id) pairs ordered by relevance
  const { data: kpmData } = await db
    .from("keyword_product_map")
    .select("keyword_id, product_id, relevance_score")
    .in("keyword_id", keywordIds)
    .order("relevance_score", { ascending: false })
    .limit(Math.min(keywordIds.length * 5, 120));

  const kpmRows = (kpmData ?? []) as KpmRow[];

  //    Step 3b: batch-fetch product details for all referenced product_ids
  const shopMap: Record<string, ShopSignal[]> = {};
  if (kpmRows.length > 0) {
    const productIds = [...new Set(kpmRows.map(r => r.product_id))];

    // excludeRetired: a keyword_product_map row may still point at a soft-retired
    // product (the map was not rewritten — retirement is expressed on pin_products
    // only). Such a product must not surface as a shop signal.
    const { data: productsData } = await excludeRetired(db
      .from("pin_products")
      .select("id, product_name, domain, merchant, image_url, source_url")
      .in("id", productIds)
      .not("product_name", "is", null));

    const productById: Record<string, ShopSignal> = {};
    for (const p of (productsData ?? []) as RawProduct[]) {
      if (!p.product_name) continue;
      productById[p.id] = {
        id:           p.id,
        product_name: p.product_name,
        domain:       (p.domain ?? p.merchant ?? "shop").replace(/^www\./, ""),
        image_url:    p.image_url,
        source_url:   p.source_url,
      };
    }

    // Walk kpm rows in relevance order to build per-keyword lists (max 3 each)
    for (const row of kpmRows) {
      const sig = productById[row.product_id];
      if (!sig) continue;
      if (!shopMap[row.keyword_id]) shopMap[row.keyword_id] = [];
      if (shopMap[row.keyword_id].length < 3) {
        shopMap[row.keyword_id].push(sig);
      }
    }
  }

  // 4. Assemble response
  const data: WorkspaceFeedItem[] = pageOpps.map(o => ({
    ...o,
    tier:            scoreTierToWorkspaceTier(o.score_tier),
    trend_lifecycle: o.trend_lifecycle ?? null,
    pin_samples:     (pinMap[o.keyword_id] ?? []).map(p => ({
      id:         p.id,
      image_url:  p.image_url,
      save_count: p.save_count,
    })),
    shop_signals:    shopMap[o.keyword_id] ?? [],
    monetize_hint:   getMonetizeHint(category),
    title_templates: getTitleTemplates(o.keyword),
  }));

  const dev = process.env.NODE_ENV !== "production"
    ? {
        requestedLimit:   limit,
        requestedOffset:  offset,
        rawOppCount:      opps?.length ?? 0,
        returnedCount:    data.length,
        category,
        shopSignalsTotal: Object.values(shopMap).reduce((n, a) => n + a.length, 0),
      }
    : undefined;

  return Response.json(dev ? { data, hasMore, debug: dev } : { data, hasMore });
}
