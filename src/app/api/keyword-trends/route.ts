// GET /api/keyword-trends

// Query params: q, region, category, limit, offset, source_layer, freshness, opportunity_focus



import { createServerClient } from "@/lib/supabase";

import { NextRequest, NextResponse } from "next/server";

import { CONTENT_OPPORTUNITY_CATEGORIES } from "@/lib/categories";

import {

  mapToKeywordSummary,

  mapToRelatedRow,

  trendingSortScore,

  wordOverlapScore,

  type TrendKeywordDbRow,

  type OppEvidence,

} from "@/lib/keyword-data/mapTrendKeywordRow";

import {

  pickBestMatch,

  type MatchType,

  type RankedMatch,

} from "@/lib/keyword-data/keywordMatch";

import type { KeywordSummary, KeywordTrendsMeta, RelatedKeywordRow } from "@/lib/keyword-data/types";



export const revalidate = 300;



const BASE_FIELDS =

  "id,keyword,category,search_volume_level,competition_level," +

  "yearly_change,monthly_change,weekly_change,trend_history,priority_score," +

  "created_at,source,source_layer,data_quality,confidence,volume_signal," +

  "volume_score,search_volume,last_updated_at,region," +
  "trend_series,trend_series_granularity,trend_series_source,trend_series_updated_at";



const ENRICHMENT_FIELDS =

  "competition_source,competition_confidence,last_competition_enriched_at";



type Db = ReturnType<typeof createServerClient>;



function parseFreshnessDays(freshness: string | null): number | null {

  if (!freshness) return null;

  const m = freshness.match(/^(\d+)d$/i);

  return m ? parseInt(m[1], 10) : null;

}



async function fetchPipelineLastRun(db: Db): Promise<string | null> {

  const { data } = await db

    .from("pipeline_runs")

    .select("finished_at")

    .eq("job_type", "trends")

    .eq("status", "completed")

    .order("finished_at", { ascending: false })

    .limit(1)

    .maybeSingle();

  return (data?.finished_at as string | null) ?? null;

}



async function fetchLatestKeywordUpdate(db: Db): Promise<string | null> {

  const { data } = await db

    .from("trend_keywords")

    .select("last_updated_at")

    .eq("status", "active")

    .order("last_updated_at", { ascending: false, nullsFirst: false })

    .limit(1)

    .maybeSingle();

  return (data?.last_updated_at as string | null) ?? null;

}



async function fetchOppMap(db: Db, keywords: string[]): Promise<Record<string, OppEvidence>> {

  if (!keywords.length) return {};

  const [{ data: viewData }, { data: oppData }] = await Promise.all([
    db
      .from("trend_opportunities_view")
      .select("keyword,opportunity_score,linked_pins_count,linked_products_count,total_source_saves")
      .in("keyword", keywords),
    db
      .from("opportunities")
      .select("canonical_keyword,primary_label,trend_state,internal_reason_codes")
      .in("canonical_keyword", keywords),
  ]);

  const oppByKeyword = Object.fromEntries(
    (oppData ?? []).map(r => [r.canonical_keyword as string, r]),
  );

  return Object.fromEntries(
    (viewData ?? []).map(r => {
      const kw = r.keyword as string;
      const extra = oppByKeyword[kw];
      return [kw, {
        opportunity_score:      r.opportunity_score,
        linked_pins_count:      r.linked_pins_count,
        linked_products_count:  r.linked_products_count,
        total_source_saves:     r.total_source_saves,
        primary_label:          extra?.primary_label ?? null,
        trend_state:            extra?.trend_state ?? null,
        internal_reason_codes:  extra?.internal_reason_codes ?? null,
      } satisfies OppEvidence];
    }),
  );

}



async function enrichRows(db: Db, rows: TrendKeywordDbRow[]): Promise<TrendKeywordDbRow[]> {

  if (!rows.length) return rows;

  const ids = rows.map(r => r.id);

  const { data: enrich } = await db

    .from("trend_keywords")

    .select(`id,${ENRICHMENT_FIELDS}`)

    .in("id", ids);

  const enrichMap = Object.fromEntries(

    (enrich ?? []).map(r => [r.id as string, r]),

  );

  return rows.map(r => ({ ...r, ...(enrichMap[r.id] ?? {}) }));

}



async function fetchCandidates(

  db: Db,

  query: string,

  matchType: MatchType,

  limit = 8,

): Promise<TrendKeywordDbRow[]> {

  if (matchType === "none") return [];

  const base = () =>

    db.from("trend_keywords").select(BASE_FIELDS).eq("status", "active")

      .order("priority_score", { ascending: false }).limit(limit);



  if (matchType === "exact") {

    const { data } = await base().ilike("keyword", query);

    return (data ?? []) as unknown as TrendKeywordDbRow[];

  }

  if (matchType === "prefix") {

    const { data } = await base().ilike("keyword", `${query}%`);

    return (data ?? []) as unknown as TrendKeywordDbRow[];

  }

  if (matchType === "contains") {

    const { data } = await base().ilike("keyword", `%${query}%`);

    return (data ?? []) as unknown as TrendKeywordDbRow[];

  }

  const words = query.split(/\s+/).filter(w => w.length > 3).sort((a, b) => b.length - a.length);

  const pivot = words[0];

  if (!pivot) return [];

  const { data } = await base().ilike("keyword", `%${pivot}%`);

  return (data ?? []) as unknown as TrendKeywordDbRow[];

}



async function findBestMatch(db: Db, query: string): Promise<RankedMatch | null> {

  const stages: MatchType[] = ["exact", "prefix", "contains", "word"];

  const allCandidates: Array<{ row: TrendKeywordDbRow; matchType: MatchType }> = [];

  const seen = new Set<string>();



  for (const matchType of stages) {

    const rows = await fetchCandidates(db, query, matchType);

    for (const row of rows) {

      if (seen.has(row.id)) continue;

      seen.add(row.id);

      allCandidates.push({ row, matchType });

    }

    const best = pickBestMatch(query, allCandidates);

    if (best) return best;

  }



  return pickBestMatch(query, allCandidates);

}



function applyFilters(

  // eslint-disable-next-line @typescript-eslint/no-explicit-any

  query: any,

  params: {

    region: string;

    category: string | null;

    sourceLayer: string | null;

    freshnessDays: number | null;

    opportunityFocus: string | null;

  },

) {

  let q = query;

  if (params.region) q = q.or(`region.eq.${params.region},region.is.null`);

  if (params.category) q = q.eq("category", params.category);

  if (params.sourceLayer) q = q.eq("source_layer", params.sourceLayer);

  if (params.freshnessDays) {

    const since = new Date(Date.now() - params.freshnessDays * 864e5).toISOString();

    q = q.gte("last_updated_at", since);

  }

  if (params.opportunityFocus === "digital") {

    q = q.eq("category", "digital-products");

  } else if (params.opportunityFocus === "physical") {

    q = q.neq("category", "digital-products");

  } else if (params.opportunityFocus === "content") {

    q = q.in("category", [...CONTENT_OPPORTUNITY_CATEGORIES]);

  }

  return q;

}



async function fetchTrendingPool(

  db: Db,

  filters: {

    region: string;

    category: string | null;

    sourceLayer: string | null;

    freshnessDays: number | null;

    opportunityFocus: string | null;

  },

  poolSize: number,

): Promise<TrendKeywordDbRow[]> {

  let query = applyFilters(

    db.from("trend_keywords").select(BASE_FIELDS, { count: "exact" }).eq("status", "active"),

    filters,

  );

  query = query

    .order("priority_score", { ascending: false })

    .order("volume_score", { ascending: false, nullsFirst: false })

    .order("yearly_change", { ascending: false })

    .limit(poolSize);



  const { data, error } = await query;

  if (error) throw new Error(error.message);

  return (data ?? []) as unknown as TrendKeywordDbRow[];

}



export async function GET(req: NextRequest) {

  const { searchParams } = new URL(req.url);

  const q                 = searchParams.get("q")?.trim() ?? "";

  const region            = searchParams.get("region") ?? "US";

  const category          = searchParams.get("category");

  const sourceLayer       = searchParams.get("source_layer");

  const freshness         = searchParams.get("freshness");

  const opportunityFocus  = searchParams.get("opportunity_focus");

  const limit             = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 50);

  const offset            = Math.max(parseInt(searchParams.get("offset") ?? "0", 10), 0);

  const freshnessDays     = parseFreshnessDays(freshness);



  const db = createServerClient();



  try {

    const [pipelineLastRun, lastUpdated] = await Promise.all([

      fetchPipelineLastRun(db),

      fetchLatestKeywordUpdate(db),

    ]);



    const filterParams = {

      region,

      category,

      sourceLayer,

      freshnessDays,

      opportunityFocus,

    };



    const metaBase: Omit<KeywordTrendsMeta, "total" | "showing" | "mode" | "query"> = {

      limit,

      offset,

      lastUpdated:     lastUpdated ?? pipelineLastRun,

      pipelineLastRun,

      region,

    };



    if (q) {

      const match = await findBestMatch(db, q);



      if (!match) {

        const meta: KeywordTrendsMeta = {

          ...metaBase,

          total: 0,

          showing: 0,

          mode: "search",

          query: q,

        };

        return NextResponse.json({

          rows: [],

          summary: null,

          meta,

          message: "No keyword data found yet. Try a related term or browse trending keywords.",

        });

      }



      const [enriched] = await enrichRows(db, [match.row]);

      const oppMap = await fetchOppMap(db, [enriched.keyword]);

      const summary: KeywordSummary = mapToKeywordSummary(

        enriched,

        oppMap[enriched.keyword],

        region,

        {

          matchedKeyword: enriched.keyword,

          isExactMatch:   match.matchType === "exact",

        },

      );



      const relatedPoolSize = Math.min(Math.max(offset + limit + 80, 150), 250);

      let relatedQuery = applyFilters(

        db.from("trend_keywords").select(BASE_FIELDS).eq("status", "active"),

        { ...filterParams, category: category ?? enriched.category ?? null },

      );

      relatedQuery = relatedQuery

        .neq("id", enriched.id)

        .order("priority_score", { ascending: false })

        .limit(relatedPoolSize);



      const { data: pool } = await relatedQuery;

      const poolRows = await enrichRows(db, (pool ?? []) as unknown as TrendKeywordDbRow[]);

      const kwList   = poolRows.map(r => r.keyword);

      const oppAll   = await fetchOppMap(db, kwList);



      const scored = poolRows.map(row => {

        const rel = mapToRelatedRow(row, oppAll[row.keyword]);

        const relevance =

          wordOverlapScore(q, row.keyword) * 40 +

          (row.category === enriched.category ? 15 : 0) +

          trendingSortScore(row, oppAll[row.keyword]) * 0.05;

        return { rel, relevance };

      });

      scored.sort((a, b) => b.relevance - a.relevance);



      const sliced: RelatedKeywordRow[] = scored.slice(offset, offset + limit).map(s => s.rel);

      const total = scored.length;



      const meta: KeywordTrendsMeta = {

        ...metaBase,

        total,

        showing: sliced.length,

        mode: "search",

        query: q,

      };



      return NextResponse.json({

        rows: sliced,

        summary,

        meta,

        match: {

          type: match.matchType,

          similarity: match.similarity,

        },

      });

    }



    const poolSize = Math.min(Math.max(offset + limit + 60, 120), 300);

    const poolRows = await fetchTrendingPool(db, filterParams, poolSize);



    const enriched = await enrichRows(db, poolRows);

    const kwList   = enriched.map(r => r.keyword);

    const oppAll   = await fetchOppMap(db, kwList);



    const scored = enriched.map(row => ({

      rel: mapToRelatedRow(row, oppAll[row.keyword]),

      score: trendingSortScore(row, oppAll[row.keyword]),

    }));

    scored.sort((a, b) => b.score - a.score);



    const countQuery = applyFilters(

      db.from("trend_keywords").select("id", { count: "exact", head: true }).eq("status", "active"),

      filterParams,

    );

    const { count: totalCount } = await countQuery;



    const total  = totalCount ?? scored.length;

    const sliced = scored.slice(offset, offset + limit).map(s => s.rel);



    const meta: KeywordTrendsMeta = {

      ...metaBase,

      total,

      showing: sliced.length,

      mode: "trending",

    };



    return NextResponse.json({ rows: sliced, summary: null, meta });

  } catch (err) {

    const message = err instanceof Error ? err.message : "Failed to load keyword trends";

    console.error("[keyword-trends]", message);

    return NextResponse.json({ error: message }, { status: 500 });

  }

}


