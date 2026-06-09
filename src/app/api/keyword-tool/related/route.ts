// GET /api/keyword-tool/related?keyword=cozy+bedroom+decor&region=US&limit=20
// Returns { rows: RelatedKeywordRow[] } ranked by semantic relevance to the query.

import { createServerClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";
import {
  getPinterestInterestBand,
  getTrendState,
  getCompetitionBand,
  getSaveSignalBand,
  buildProvenance,
} from "@/lib/keyword-data/normalizeKeywordMetrics";
import { getOpportunityLabel } from "@/lib/keyword-data/opportunityScoring";
import type { RelatedKeywordRow, TrendPoint, Band, CompetitionBand, TrendState } from "@/lib/keyword-data/types";

export const revalidate = 300;

// Only columns guaranteed to exist pre-migration. Enrichment columns are fetched
// separately so a missing migration never silences the whole query.
const FIELDS =
  "id,keyword,category,search_volume_level,competition_level," +
  "yearly_change,monthly_change,weekly_change,trend_history,priority_score,created_at";

// ── Semantic ranking ──────────────────────────────────────────────────────────

function normalizeWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2);
}

function wordOverlapScore(query: string, candidate: string): number {
  const setQ  = new Set(normalizeWords(query));
  const wordsC = normalizeWords(candidate);
  if (!setQ.size || !wordsC.length) return 0;
  const overlap = wordsC.filter(w => setQ.has(w)).length;
  return overlap / Math.max(setQ.size, wordsC.length);
}

function relatedKeywordScore(params: {
  query:         string;
  queryCategory: string | null;
  keyword:       string;
  category?:     string;
  interestBand:  Band;
  compBand:      CompetitionBand;
  trendState:    TrendState;
  hasTimeSeries: boolean;
}): number {
  const { query, queryCategory, keyword, category, interestBand, compBand, trendState, hasTimeSeries } = params;

  const sim     = wordOverlapScore(query, keyword);
  const catHit  = queryCategory && category === queryCategory ? 1 : 0;

  const iScore  = { High: 1, Medium: 0.6, Low: 0.2 }[interestBand]  ?? 0.2;
  const cAdv    = { Low:  1, Medium: 0.6, High: 0.2 }[compBand]     ?? 0.6;
  const tScore  = { Rising: 1, Evergreen: 0.6, Seasonal: 0.4 }[trendState] ?? 0.6;
  const evScore = hasTimeSeries ? 1 : 0;

  return (
    sim     * 30 +
    catHit  * 15 +
    iScore  * 12 +
    cAdv    * 10 +
    tScore  *  8 +
    evScore *  5
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const keyword       = searchParams.get("keyword")?.trim() ?? "";
  const region        = searchParams.get("region") ?? "US";
  const returnLimit   = Math.min(parseInt(searchParams.get("limit") ?? "20"), 50);
  const forceCategory = searchParams.get("category") ?? null;

  const db = createServerClient();

  // Resolve category of the searched keyword
  let resolvedCategory: string | null = forceCategory;
  if (!resolvedCategory && keyword) {
    const { data: mainKw } = await db
      .from("trend_keywords").select("category")
      .ilike("keyword", `%${keyword}%`)
      .eq("status", "active")
      .limit(1).maybeSingle();
    resolvedCategory = (mainKw as any)?.category ?? null;
  }

  // Fetch a larger pool so we can re-rank by relevance
  let query = db
    .from("trend_keywords")
    .select(FIELDS)
    .eq("status", "active")
    .order("priority_score", { ascending: false })
    .limit(Math.min(returnLimit * 3, 60)); // fetch 3× to re-rank

  if (resolvedCategory) query = query.eq("category", resolvedCategory);

  const { data: rawRows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = rawRows ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typedRows = rows as any[];
  const kwList = typedRows.map((r: any) => r.keyword as string);

  // Batch-fetch opportunity evidence
  const { data: oppRows } = kwList.length
    ? await db
        .from("trend_opportunities_view")
        .select("keyword,linked_pins_count,total_source_saves")
        .in("keyword", kwList)
    : { data: [] };

  const oppMap = Object.fromEntries(
    (oppRows ?? []).map(r => [r.keyword as string, r]),
  );

  // Build, score, and rank
  const scored = typedRows.map((row: any) => {
    const ts       = (row.trend_history as TrendPoint[] | null) ?? [];
    const opp      = oppMap[row.keyword as string];

    const iBand    = getPinterestInterestBand(row.search_volume_level as string, ts);
    const tState   = getTrendState(ts, row.yearly_change as number, row.weekly_change as number);
    const cBand    = getCompetitionBand(row.competition_level as string, row.search_volume_level as string);
    const sBand    = getSaveSignalBand(opp?.total_source_saves, opp?.linked_pins_count);
    const oppLabel = getOpportunityLabel(iBand, cBand, tState, sBand);

    const score = relatedKeywordScore({
      query:         keyword,
      queryCategory: resolvedCategory,
      keyword:       row.keyword as string,
      category:      row.category as string | undefined,
      interestBand:  iBand,
      compBand:      cBand,
      trendState:    tState,
      hasTimeSeries: ts.length >= 4,
    });

    // Enrichment columns may not exist until the SQL migration runs.
    // Fall back gracefully: provenance defaults to derived / Low confidence.
    const provenance = buildProvenance({
      hasTrendHistory:      ts.length >= 6,
      hasCompetitionSample: false,     // enrichment columns not fetched in batch query
      hasOppEvidence:       !!(opp?.total_source_saves || opp?.linked_pins_count),
      competitionSource:    null,
      competitionConfidence: null,
      lastFetchedAt:        (row.created_at as string | null),
    });

    const relRow: RelatedKeywordRow = {
      id:                    row.id as string,
      keyword:               row.keyword as string,
      category:              row.category as string | undefined,
      pinterestInterestBand: iBand,
      saveSignalBand:        sBand,
      competitionBand:       cBand,
      trendState:            tState,
      opportunityLabel:      oppLabel,
      timeSeries:            ts.length ? ts : undefined,
      provenance,
    };

    return { relRow, score };
  });

  // Sort by relevance score descending, then return top limit
  scored.sort((a, b) => b.score - a.score);
  const result: RelatedKeywordRow[] = scored.slice(0, returnLimit).map(s => s.relRow);

  return NextResponse.json({ rows: result, region });
}
