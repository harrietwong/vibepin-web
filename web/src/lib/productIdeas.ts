import { getCategoryMatchSet, catLabel } from "@/lib/categories";
import { looksLikeAmazon } from "@/lib/affiliate/amazon";
import { matchesCategory } from "@/lib/productIdeasCategoryMatch";
import type { ProductMetrics } from "@/lib/supabase";
import type { ProductOpportunityPublicMetrics } from "@/lib/productOpportunityCounts";
import {
  deriveProductSourceType,
  excludeRetired,
  OUTBOUND_DISCOVERY_METHODS,
  type ProductSourceTypeCode,
} from "@/lib/productTopTiers";
import {
  classifyDestination,
  shouldShowInProductIdeas,
  type AssetRoleV2,
  type DestinationType,
  type ItemType,
  type ProductSubtype,
  type ProductType,
  type RiskFlag,
  type SourceContext,
} from "@/lib/assetClassification";

export type ProductIdea = {
  id:                    string;
  product_name:          string;
  price:                 number | null;
  currency:              string | null;
  source_url:            string | null;
  domain:                string | null;
  merchant:              string | null;
  image_url:             string;
  save_count:            number | null;
  reaction_count:        number;
  source_pin_save_count: number | null;
  // Pinterest pin_id of the product's OWN Pin (null when the product card is not
  // itself a Pin). Presence means save_count is a genuine product-Pin metric.
  product_pin_id?:       string | null;
  // Target Product Pin fields (v30). The target Product Pin is the closeup reached
  // by clicking a Shop-the-Look / Shop-similar card. target_product_pin_save_count
  // is Pin-level data — NOT SKU-level product saves. UI label: "Product Pin Saves".
  target_product_pin_id?:         string | null;
  target_product_pin_url?:        string | null;
  target_product_pin_save_count?: number | null;
  section_type?:                  string | null;   // shop_the_look | shop_similar
  item_index?:                    number | null;
  extraction_status?:             string | null;
  // Honest, accurately-named product engagement evidence. See ProductMetrics.
  product_metrics?:      ProductMetrics;
  // Public Demand / Trend / Competition derived server-side (no unified
  // opportunity label/score — the user judges from the three metrics).
  public_metrics?:       ProductOpportunityPublicMetrics | null;
  // The suggestion keyword (pin_samples.source_keyword) that surfaced the source
  // pin — server-joined; completes Trend Keyword → Search Keyword provenance.
  search_keyword?:       string | null;
  // Validating source-pin ids (deduped across the product's URL identity group,
  // capped at 5) for the detail drawer's provenance list.
  source_pin_ids?:       string[];
  // User-facing source type derived server-side from provenance (the raw
  // discovery_method is never sent to the client). Authoritative when present.
  source_type?:          ProductSourceTypeCode | null;
  seed_keyword:          string | null;
  // Derived category id (e.g. 'womens-fashion') resolved server-side from
  // source_category for STL bootstrap products. Used only for category filtering.
  // This is NOT raw provenance — source_category itself is never exposed.
  category?:             string | null;
  parent_pin_id:         string;
  scraped_at:            string | null;
  opportunity_score:     number | null;
  trend_score:           number | null;
  save_velocity_score:   number | null;
  item_type?:            ItemType;
  product_type?:         ProductType;
  product_subtype?:      ProductSubtype;
  destination_type?:     DestinationType;
  asset_role?:           AssetRoleV2;
  source_context?:       SourceContext;
  risk_flags?:           RiskFlag[];
  // Internal ranking fields only — never rendered in the UI.
  discovery_method?:          string | null;
  discovery_method_detail?:   string | null;
  created_at?:                string | null;
};

export type ProductIdeaPickerAsset = {
  id:           string;
  imageUrl:     string;
  title:        string;
  source:       "product_ideas";
  assetRole:    "product_image";
  category?:    string;
  productUrl?:  string;
  sourceDomain?: string;
};

export const PRODUCT_IDEAS_SWR_KEY = "pin_products_scored";

export type ProductIdeasFetchResult = {
  products: ProductIdea[];
  lastUpdatedAt: string | null;
  source: string;
  itemCount: number;
  meta?: {
    // Product-first freshness (Product Opportunity v1 readiness — replaces scoring).
    productDataLastUpdatedAt?: string | null;
    totalPinProducts?: number | null;
    productRowsLast24h?: number | null;
    productRowsLast48h?: number | null;
    productRowsLast5d?: number | null;
    missingImageUrlCount?: number | null;
    missingProductUrlCount?: number | null;
    categoryCounts?: Record<string, number>;
    // Stable, full-dataset platform filter options (computed server-side over ALL
    // clean user-facing rows; does not change with the loaded subset).
    platformVisible?: string[];
    platformCounts?: Record<string, number>;
    latestProductCreatedAt?: string | null;
    latestPinScrapedAt?: string | null;
    latestDemandUpdatedAt?: string | null;
    latestCompetitionUpdatedAt?: string | null;
    // Optional / deprecated: not required for Product Opportunity.
    latestScoreUpdatedAt?: string | null;
    scoredCount?: number;
    unscoredCount?: number;
    totalVisibleCount?: number;
  };
};

export const PRODUCT_IDEA_PICKER_CATEGORIES = [
  "All Categories",
  "Home Decor",
  "Fashion",
  "Beauty",
  "DIY & Crafts",
  "Digital Products",
  "Food & Drink",
  "Wedding",
  "Travel",
] as const;

export const PRODUCT_IDEA_SOURCE_FILTERS = [
  "All Sources",
  "Amazon",
] as const;

const LABEL_TO_CAT_ID: Record<string, string> = {
  "Home Decor":       "home-decor",
  "Fashion":          "fashion",
  "Beauty":           "beauty",
  "DIY & Crafts":     "diy-crafts",
  "Digital Products": "digital-products",
  "Food & Drink":     "food-and-drink",
  "Wedding":          "wedding",
  "Travel":           "travel",
};

// User-facing product rows must correspond to a REAL Pinterest source pin. E2E test
// fixtures were seeded with parent_pin_id='0' (no real pin, so no valid Pinterest pin
// URL can be constructed) — they fail the MVP "clean row" bar and must never surface
// in the Product Opportunity UI. They are intentionally NOT deleted from pin_products
// (that is a separate, approval-gated cleanup); this only filters them out of display.
export function isUserFacingProductRow(p: { parent_pin_id?: string | null }): boolean {
  return p.parent_pin_id !== "0";
}

export function isAmazonProductIdea(product: ProductIdea): boolean {
  return looksLikeAmazon({
    productUrl: product.source_url,
    sourceUrl:  product.source_url,
    domain:     product.domain,
    merchant:   product.merchant,
  });
}

function mapApiRow(r: Record<string, unknown>): ProductIdea {
  return {
    id:                    r.id as string,
    product_name:          r.product_name as string,
    price:                 r.price as number | null,
    currency:              r.currency as string | null,
    source_url:            r.source_url as string | null,
    domain:                r.domain as string | null,
    merchant:              r.merchant as string | null,
    image_url:             (r.image_url as string) ?? "",
    save_count:            typeof r.save_count === "number" ? r.save_count : null,
    reaction_count:        0,
    source_pin_save_count: typeof r.source_pin_save_count === "number" ? r.source_pin_save_count : null,
    product_pin_id:        (r.product_pin_id as string | null) ?? null,
    target_product_pin_id:         (r.target_product_pin_id as string | null) ?? null,
    target_product_pin_url:        (r.target_product_pin_url as string | null) ?? null,
    target_product_pin_save_count: (r.target_product_pin_save_count as number | null) ?? null,
    section_type:                  (r.section_type as string | null) ?? null,
    item_index:                    (r.item_index as number | null) ?? null,
    extraction_status:             (r.extraction_status as string | null) ?? null,
    product_metrics:       (r.product_metrics as ProductMetrics | undefined) ?? undefined,
    public_metrics:        (r.public_metrics as ProductOpportunityPublicMetrics | null | undefined) ?? null,
    search_keyword:        (r.search_keyword as string | null | undefined) ?? null,
    source_pin_ids:        (r.source_pin_ids as string[] | undefined) ?? undefined,
    source_type:           (r.source_type as ProductSourceTypeCode | null | undefined) ?? null,
    seed_keyword:          r.seed_keyword as string | null,
    category:              (r.category as string | null) ?? null,
    parent_pin_id:         (r.parent_pin_id as string | null) ?? "",
    scraped_at:            r.scraped_at as string | null,
    opportunity_score:     r.opportunity_score as number | null,
    trend_score:           r.trend_score as number | null,
    save_velocity_score:   r.save_velocity_score as number | null,
    item_type:             r.item_type as ItemType | undefined,
    product_type:          r.product_type as ProductType | undefined,
    product_subtype:       r.product_subtype as ProductSubtype | undefined,
    destination_type:      r.destination_type as DestinationType | undefined,
    asset_role:            r.asset_role as AssetRoleV2 | undefined,
    source_context:        r.source_context as SourceContext | undefined,
    risk_flags:            r.risk_flags as RiskFlag[] | undefined,
    discovery_method:          (r.discovery_method as string | null) ?? null,
    discovery_method_detail:   (r.discovery_method_detail as string | null) ?? null,
    created_at:                (r.created_at as string | null) ?? null,
  };
}

// Bootstrap-first ranking for Product Ideas. Surfaces freshly-harvested products
// ahead of legacy inventory WITHOUT hiding anything:
//   0) outbound_link_bootstrap
//   1) Shop-the-Look product-card bootstrap (discovery_method='stl',
//      discovery_method_detail='pinterest_product_card_bootstrap') — near parity with tier 0
//   2) other recent STL rows
//   3) everything else
// Within each tier: higher source_pin_save_count first (inherited evidence),
// then higher save_count, then more recent created_at.
// discovery_method is used only for ordering; it is never shown in the UI.
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const STL_BOOTSTRAP_DETAIL = "pinterest_product_card_bootstrap";

function isOutboundMethod(m: string | null | undefined): boolean {
  return !!m && (OUTBOUND_DISCOVERY_METHODS as readonly string[]).includes(m);
}

function sourceRank(p: ProductIdea): number {
  // The API path never returns discovery_method; it returns the derived source_type.
  // The Supabase fallback path still has the raw field. Accept either.
  if (p.source_type === "product_link_pin" || isOutboundMethod(p.discovery_method)) return 0;
  if (p.discovery_method === "stl") {
    const created = p.created_at ? Date.parse(p.created_at) : NaN;
    const isRecent = Number.isFinite(created) && (Date.now() - created) < RECENT_MS;
    // Product-card bootstrap products rank alongside outbound_link_bootstrap.
    if (p.discovery_method_detail === STL_BOOTSTRAP_DETAIL) return 1;
    if (isRecent) return 2;
  }
  return 3;
}

export function rankProductIdeas(products: ProductIdea[]): ProductIdea[] {
  return [...products].sort((a, b) => {
    const r = sourceRank(a) - sourceRank(b);
    if (r !== 0) return r;
    // STL bootstrap products have save_count=0 on the product row; use
    // source_pin_save_count (inherited evidence from source pin) instead.
    const spsc = (b.source_pin_save_count ?? 0) - (a.source_pin_save_count ?? 0);
    if (spsc !== 0) return spsc;
    const sv = (b.save_count ?? 0) - (a.save_count ?? 0);
    if (sv !== 0) return sv;
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  });
}

async function fetchWithTimeout(input: RequestInfo | URL, ms = 30000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Same fetch path as /app/products (Product Ideas page). */
export async function fetchProductIdeasWithMeta(): Promise<ProductIdeasFetchResult> {
  try {
    const resp = await fetchWithTimeout("/api/products/top?limit=400&sort=most_saved");
    if (resp.ok) {
      const json = await resp.json() as Record<string, unknown>;
      const rows = (json.items ?? json.data ?? []) as Record<string, unknown>[];
      const products = rankProductIdeas(rows.map(mapApiRow).filter(p => !!p.image_url && isUserFacingProductRow(p) && shouldShowInProductIdeas(p)));
      return {
        products,
        lastUpdatedAt: (json.lastUpdatedAt as string | null) ?? null,
        source: (json.source as string) ?? "product_ideas_api",
        itemCount: typeof json.itemCount === "number" ? json.itemCount : products.length,
        meta: (json.meta as ProductIdeasFetchResult["meta"]) ?? undefined,
      };
    }
  } catch {
    /* fall through to Supabase */
  }

  try {
    const { supabase } = await import("@/lib/supabase");
    // discovery_method_detail added in v28; returns null for older rows — safe to request.
    // target_product_pin_* / section_type / item_index / extraction_status added in
    // v30; null for older rows — safe to request.
    const SELECT =
      "id,product_name,price,currency,source_url,domain,merchant,image_url,save_count," +
      "reaction_count,source_pin_save_count,product_pin_id,canonical_product_url,product_url_hash," +
      "seed_keyword,parent_pin_id,scraped_at," +
      "discovery_method,discovery_method_detail,source_category,created_at";

    // Bootstrap-first: fetch harvested products explicitly (they have lower inherited
    // saves and would otherwise fall outside the top-400-by-saves window), then fill
    // with the rest. Merge + dedupe; legacy is kept, just ranked lower.
    //
    // STL bootstrap query is separate because:
    //   - save_count may be 0 on the product row (evidence is on source_pin_save_count)
    //   - product_scores may not exist yet (newly extracted)
    //   - Both must NOT exclude these rows.
    const [bootRes, stlRes, restRes] = await Promise.all([
      // Soft-retired rows are excluded by lifecycle_status (excludeRetired), the same
      // state filter /api/products/top uses — so this fallback path cannot leak the
      // legacy dirty outbound rows either. (This replaced a created_at floor; the
      // dirty batch has no clean time boundary, so only state can fence it off.)
      excludeRetired(supabase.from("pin_products").select(SELECT)
        .in("discovery_method", [...OUTBOUND_DISCOVERY_METHODS])
        .not("image_url", "is", null))
        .order("created_at", { ascending: false })
        .limit(300),
      excludeRetired(supabase.from("pin_products").select(SELECT)
        .eq("discovery_method", "stl")
        .not("image_url", "is", null)
        .not("source_url", "is", null))
        .order("source_pin_save_count", { ascending: false })
        .limit(300),
      excludeRetired(supabase.from("pin_products").select(SELECT)
        .gte("save_count", 10)
        .not("image_url", "is", null))
        .order("save_count", { ascending: false })
        .limit(400),
    ]);
    if (bootRes.error) throw new Error(bootRes.error.message);
    // stlRes failure is non-fatal; proceed without STL rows if unavailable.
    if (restRes.error) throw new Error(restRes.error.message);

    type PinProductRow = {
      id: string; product_name: string; price: number | null; currency: string | null;
      source_url: string | null; domain: string | null; merchant: string | null;
      image_url: string | null; save_count: number | null; reaction_count: number | null;
      source_pin_save_count: number | null; seed_keyword: string | null;
      product_pin_id: string | null; canonical_product_url: string | null; product_url_hash: string | null;
      parent_pin_id: string | null; scraped_at: string | null;
      discovery_method: string | null; discovery_method_detail: string | null;
      source_category: string | null;
      created_at: string | null;
    };
    const bootData = (bootRes.data ?? []) as unknown as PinProductRow[];
    const stlData  = (stlRes.error ? [] : (stlRes.data ?? [])) as unknown as PinProductRow[];
    const restData = (restRes.data ?? []) as unknown as PinProductRow[];
    const seenIds = new Set<string>();
    const data: PinProductRow[] = [];
    // Merge order: outbound_link_bootstrap → stl bootstrap → rest (saves ≥ 10).
    for (const r of [...bootData, ...stlData, ...restData]) {
      if (!seenIds.has(r.id)) { seenIds.add(r.id); data.push(r); }
    }

    // Build product-identity aggregates from the fetched rows (dedup by the
    // strongest available identity: product_url_hash > canonical_product_url).
    const aggMap = new Map<string, { sourcePins: Set<string>; productPinSaves: Map<string, number> }>();
    const idKey = (r: PinProductRow): string | null =>
      r.product_url_hash ? `h:${r.product_url_hash}` : r.canonical_product_url ? `c:${r.canonical_product_url}` : null;
    for (const r of data) {
      const k = idKey(r);
      if (!k) continue;
      let a = aggMap.get(k);
      if (!a) { a = { sourcePins: new Set(), productPinSaves: new Map() }; aggMap.set(k, a); }
      if (r.parent_pin_id) a.sourcePins.add(r.parent_pin_id);
      if (r.product_pin_id) a.productPinSaves.set(r.product_pin_id, Math.max(a.productPinSaves.get(r.product_pin_id) ?? 0, r.save_count ?? 0));
    }
    const buildMetrics = (r: PinProductRow): ProductMetrics => {
      const k = idKey(r);
      const a = k ? aggMap.get(k) : undefined;
      const hasProductPin = !!r.product_pin_id;
      const dedupIdentity: ProductMetrics["dedupIdentity"] =
        r.product_url_hash ? "product_url_hash" : r.canonical_product_url ? "canonical_product_url" : "pin_product_id";
      const productPinSaveValues = a ? [...a.productPinSaves.values()] : (hasProductPin ? [r.save_count ?? 0] : []);
      const aggregateProductPinSaves = productPinSaveValues.length ? productPinSaveValues.reduce((s, v) => s + v, 0) : null;
      return {
        productPinSaveCount:      hasProductPin ? (r.save_count ?? 0) : null,
        sourcePinSaveCount:       r.source_pin_save_count ?? 0,
        productSourcePinCount:    a ? a.sourcePins.size : (r.parent_pin_id ? 1 : 0),
        uniqueProductPinCount:    a ? a.productPinSaves.size : (hasProductPin ? 1 : 0),
        aggregateProductPinSaves,
        primarySaveKind:          hasProductPin ? "product_pin" : "source_pin",
        metricSource:             "pinterest_stl",
        dedupIdentity,
      };
    };

    const products = rankProductIdeas((data ?? []).map(r => {
      const classified = classifyDestination({
        title: r.product_name,
        domain: r.domain,
        sourceUrl: r.source_url,
        price: r.price,
        currency: r.currency,
        category: r.seed_keyword,
        hasCommerceSignals: true,
      });
      // Resolve a category for filtering from source_category (STL bootstrap only),
      // then drop raw provenance / dedup-identity fields so they never reach the UI.
      const { source_category, canonical_product_url, product_url_hash, ...rest } = r;
      void canonical_product_url; void product_url_hash;
      const category =
        r.discovery_method_detail === STL_BOOTSTRAP_DETAIL && source_category
          ? source_category
          : null;
      return {
        ...rest,
        category,
        source_type:           deriveProductSourceType(r),
        product_metrics:       buildMetrics(r),
        opportunity_score:     null,
        trend_score:           null,
        save_velocity_score:   null,
        item_type:             classified.item_type,
        product_type:          classified.product_type,
        product_subtype:       classified.product_subtype,
        destination_type:      classified.destination_type,
        asset_role:            classified.asset_role,
        source_context:        classified.source_context,
        risk_flags:            classified.risk_flags,
      };
    }).filter(p => isUserFacingProductRow(p) && shouldShowInProductIdeas(p)) as ProductIdea[]);

    const scraped = products.map(p => p.scraped_at).filter(Boolean) as string[];
    const lastUpdatedAt = scraped.length ? scraped.sort().reverse()[0] : null;

    return {
      products,
      lastUpdatedAt,
      source: "pin_products_fallback",
      itemCount: products.length,
    };
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Failed to load product ideas");
  }
}

export async function fetchProductIdeas(): Promise<ProductIdea[]> {
  const result = await fetchProductIdeasWithMeta();
  return result.products;
}

export async function fetchProductIdeasCategoryMap(): Promise<Record<string, string>> {
  const { supabase } = await import("@/lib/supabase");
  const map: Record<string, string> = {};

  const { data: kws } = await supabase
    .from("trend_keywords")
    .select("keyword,category")
    .eq("status", "active")
    .limit(3000);
  (kws ?? []).forEach((r: { keyword: string | null; category: string | null }) => {
    if (r.keyword && r.category) map[r.keyword] = r.category;
  });

  const { data: exps } = await supabase
    .from("keyword_expansions")
    .select("expanded_keyword,source_interest")
    .limit(5000);
  (exps ?? []).forEach((r: { expanded_keyword: string | null; source_interest: string | null }) => {
    if (!r.expanded_keyword || !r.source_interest) return;
    const cat = r.source_interest.split(":")[1];
    if (cat && !map[r.expanded_keyword]) map[r.expanded_keyword] = cat;
  });

  return map;
}

export function filterProductIdeas(
  products: ProductIdea[],
  opts: { search: string; categoryLabel: string; sourceLabel?: string; kwCatMap?: Record<string, string> },
): ProductIdea[] {
  let list = products.filter(p => !!p.image_url && shouldShowInProductIdeas(p));
  const q = opts.search.trim().toLowerCase();

  if (q) {
    list = list.filter(p =>
      p.product_name.toLowerCase().includes(q) ||
      (p.seed_keyword ?? "").toLowerCase().includes(q) ||
      (p.domain ?? "").toLowerCase().includes(q),
    );
  }

  if (opts.sourceLabel === "Amazon") {
    list = list.filter(isAmazonProductIdea);
  }

  if (opts.categoryLabel !== "All Categories") {
    const catId = LABEL_TO_CAT_ID[opts.categoryLabel];
    if (catId && opts.kwCatMap) {
      const matchSet = getCategoryMatchSet(catId);
      const kwCatMap = opts.kwCatMap;
      list = list.filter(p => {
        // STL bootstrap products carry a resolved category (from source_category)
        // and usually have no seed_keyword. Prefer it so womens-fashion surfaces
        // under Fashion via the parent→child match set; fall back to the keyword
        // map for legacy rows (behaviour unchanged for them).
        const resolved = p.category ?? (p.seed_keyword != null ? kwCatMap[p.seed_keyword] : undefined);
        return resolved != null && matchSet.has(resolved);
      });
    } else {
      list = list.filter(p =>
        matchesCategory(`${p.product_name} ${p.seed_keyword ?? ""}`, opts.categoryLabel),
      );
    }
  }

  return list;
}

export function mapProductIdeaToPickerAsset(
  idea: ProductIdea,
  kwCatMap?: Record<string, string>,
): ProductIdeaPickerAsset {
  const dbCat = idea.seed_keyword && kwCatMap?.[idea.seed_keyword]
    ? kwCatMap[idea.seed_keyword]
    : undefined;

  return {
    id:           idea.id,
    imageUrl:     idea.image_url,
    title:        idea.product_name,
    source:       "product_ideas",
    assetRole:    "product_image",
    category:     dbCat ? catLabel(dbCat) : undefined,
    productUrl:   idea.source_url ?? undefined,
    sourceDomain: idea.domain ?? undefined,
  };
}
