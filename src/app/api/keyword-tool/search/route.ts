// GET /api/keyword-tool/search?keyword=cozy+bedroom+decor&platform=pinterest&region=US
// Returns: { summary: KeywordSummary | null, matchedKeyword?: string, isExactMatch?: boolean, message?: string }

import { createServerClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";
import {
  getPinterestInterestBand,
  getTrendState,
  getCompetitionBand,
  getSaveSignalBand,
  getKeywordInsightBullets,
  buildProvenance,
} from "@/lib/keyword-data/normalizeKeywordMetrics";
import { getOpportunityLabel } from "@/lib/keyword-data/opportunityScoring";
import type { KeywordSummary, TrendPoint } from "@/lib/keyword-data/types";

export const revalidate = 300;

// Only select columns guaranteed to exist before the enrichment migration runs.
// New columns (competition_source, competition_confidence, last_competition_enriched_at)
// are selected separately and gracefully absent until the migration is applied.
const FIELDS =
  "id,keyword,category,search_volume_level,competition_level," +
  "yearly_change,monthly_change,weekly_change,trend_history,priority_score,created_at";

// Enrichment columns added by add_competition_columns.sql — may not exist yet
const ENRICHMENT_FIELDS =
  "competition_source,competition_confidence,last_competition_enriched_at";

// ── Matching cascade: exact → prefix → contains → per-word ────────────────────

type KwRow = Record<string, unknown>;

async function findBestMatch(db: ReturnType<typeof createServerClient>, query: string): Promise<{
  row: KwRow | null;
  matchType: "exact" | "prefix" | "contains" | "word" | "none";
}> {
  const base = () =>
    db.from("trend_keywords").select(FIELDS).eq("status", "active")
      .order("priority_score", { ascending: false }).limit(1);

  // 1. Exact (case-insensitive)
  const { data: exact } = await base().ilike("keyword", query).maybeSingle();
  if (exact) return { row: exact as unknown as KwRow, matchType: "exact" };

  // 2. Starts-with
  const { data: prefix } = await base().ilike("keyword", `${query}%`).maybeSingle();
  if (prefix) return { row: prefix as unknown as KwRow, matchType: "prefix" };

  // 3. Contains
  const { data: contains } = await base().ilike("keyword", `%${query}%`).maybeSingle();
  if (contains) return { row: contains as unknown as KwRow, matchType: "contains" };

  // 4. Per-word — single pass: try the longest significant word only.
  //    Capping at one DB round trip keeps worst-case latency predictable.
  const words = query.split(/\s+/)
    .filter(w => w.length > 3)
    .sort((a, b) => b.length - a.length); // longest first — most specific
  const pivotWord = words[0];
  if (pivotWord) {
    const { data: wordMatch } = await base().ilike("keyword", `%${pivotWord}%`).maybeSingle();
    if (wordMatch) return { row: wordMatch as unknown as KwRow, matchType: "word" };
  }

  return { row: null, matchType: "none" };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawKeyword = searchParams.get("keyword")?.trim();
  const region     = searchParams.get("region") ?? "US";

  if (!rawKeyword) {
    return NextResponse.json({ error: "keyword is required" }, { status: 400 });
  }

  const db = createServerClient();
  const { row: kwRow, matchType } = await findBestMatch(db, rawKeyword);

  if (!kwRow) {
    return NextResponse.json({
      summary:  null,
      message:  "No keyword data found yet. Try a related term or browse trending keywords.",
    });
  }

  const isExactMatch   = matchType === "exact";
  const matchedKeyword = kwRow.keyword as string;

  // Opportunity evidence
  const { data: oppRow } = await db
    .from("trend_opportunities_view")
    .select("opportunity_score,linked_pins_count,total_source_saves")
    .eq("keyword", matchedKeyword)
    .maybeSingle();

  // Try to fetch enrichment columns — may not exist until migration runs, which is fine.
  let enrichRow: Record<string, unknown> = {};
  try {
    const { data: enr } = await db
      .from("trend_keywords")
      .select(ENRICHMENT_FIELDS)
      .eq("id", kwRow.id as string)
      .maybeSingle();
    if (enr) enrichRow = enr as unknown as Record<string, unknown>;
  } catch { /* migration not yet applied */ }

  const timeSeries = (kwRow.trend_history as TrendPoint[] | null) ?? [];
  const hasTrendHistory      = timeSeries.length >= 6;
  const hasCompetitionSample = !!(enrichRow.competition_source);
  const hasOppEvidence       = !!(oppRow?.total_source_saves || oppRow?.linked_pins_count);

  const interestBand    = getPinterestInterestBand(kwRow.search_volume_level as string, timeSeries);
  const trendState      = getTrendState(timeSeries, kwRow.yearly_change as number, kwRow.weekly_change as number);
  const competitionBand = getCompetitionBand(kwRow.competition_level as string, kwRow.search_volume_level as string);
  const saveSignalBand  = getSaveSignalBand(oppRow?.total_source_saves, oppRow?.linked_pins_count);
  const opportunityLabel = getOpportunityLabel(interestBand, competitionBand, trendState, saveSignalBand);

  const provenance = buildProvenance({
    hasTrendHistory,
    hasCompetitionSample,
    hasOppEvidence,
    competitionSource:     (enrichRow.competition_source as string | null) ?? null,
    competitionConfidence: (enrichRow.competition_confidence as string | null) ?? null,
    lastFetchedAt:
      (enrichRow.last_competition_enriched_at as string | null) ??
      (kwRow.created_at as string | null),
    sampleSize: undefined,
  });

  const summary: KeywordSummary = {
    keyword:  matchedKeyword,
    platform: "pinterest",
    region,
    pinterestInterestBand: interestBand,
    saveSignalBand,
    competitionBand,
    trendState,
    opportunityLabel,
    interestIndexCurrent: hasTrendHistory ? timeSeries[timeSeries.length - 1].value : undefined,
    pctGrowthYoY: (kwRow.yearly_change  as number) ?? undefined,
    pctGrowthMoM: (kwRow.monthly_change as number) ?? undefined,
    pctGrowthWoW: (kwRow.weekly_change  as number) ?? undefined,
    timeSeries,
    category: (kwRow.category as string) ?? undefined,
    insightBullets: getKeywordInsightBullets({
      keyword:        matchedKeyword,
      trendState,
      interestBand,
      competitionBand,
      category:       kwRow.category as string,
      yoyGrowth:      kwRow.yearly_change as number,
    }),
    matchedKeyword,
    isExactMatch,
    provenance,
  };

  return NextResponse.json({ summary, matchedKeyword, isExactMatch });
}
