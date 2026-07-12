// Map raw trend_keywords + optional opportunity evidence → display rows.

import {
  getPinterestInterestBand,
  getTrendState,
  getCompetitionBand,
  getSaveSignalBand,
  getKeywordInsightBullets,
  buildProvenance,
} from "./normalizeKeywordMetrics";
import {
  adjustTrendStateDisplay,
  buildReadinessFromEvidence,
  parseReadinessFromInternalCodes,
  type ReadinessPayload,
} from "@/lib/opportunityReadiness";
import {
  officialTrendPoints,
  resolveTrendDisplay,
  isOfficialTrendSeries,
  isL3Estimated,
} from "./trendSeriesDisplay";
import type {
  KeywordSummary, RelatedKeywordRow, TrendPoint, TrendSeriesMeta,
  DataSourceLabel, Band, CompetitionBand, SaveSignalBand, TrendState,
} from "./types";

// ── Relative index helpers (0-100, NOT search volume) ─────────────────────────

function bandInterestIndex(band: Band, volumeScore?: number | null): number {
  // volume_score is on a ~1-5 scale from pipeline; normalize to 0-100
  if (volumeScore != null && volumeScore > 0)
    return Math.round(Math.min(99, Math.max(10, volumeScore * 18)));
  return { High: 76, Medium: 52, Low: 24 }[band];
}

function bandCompIndex(band: CompetitionBand): number {
  return { High: 74, Medium: 52, Low: 26 }[band];
}

function savesIndex(saves?: number | null, pins?: number | null): number {
  if (saves) {
    if (saves > 50_000) return 88;
    if (saves > 10_000) return 76;
    if (saves > 3_000)  return 64;
    if (saves > 400)    return 52;
  }
  if (pins && pins > 100) return 66;
  if (pins && pins > 20)  return 48;
  return 24;
}

function saveBandIndex(band: SaveSignalBand | undefined): number {
  return { Strong: 74, Medium: 50, Weak: 24 }[band ?? "Weak"];
}

function deriveDataSourceLabel(row: TrendKeywordDbRow): DataSourceLabel {
  if (isOfficialTrendSeries(row)) return "Official";
  if (isL3Estimated(row)) return "Estimated";
  return "Derived";
}

function interestSourceNote(dsl: DataSourceLabel): string {
  if (dsl === "Official") return "Pinterest Trends API · normalized 0–100";
  return "Relative interest · autocomplete + save signals · not search volume";
}

function compSourceNote(): string {
  return "Visual content density estimate · lower = less crowded";
}

function saveSourceNote(): string {
  return "Save activity of linked Pins in this keyword";
}

// (Opportunity label/score removed — v2.0 final: no unified opportunity verdicts.)

export type TrendKeywordDbRow = {
  id: string;
  keyword: string;
  category?: string | null;
  search_volume_level?: string | null;
  volume_signal?: string | null;
  competition_level?: string | null;
  yearly_change?: number | null;
  monthly_change?: number | null;
  weekly_change?: number | null;
  trend_history?: TrendPoint[] | null;
  priority_score?: number | null;
  volume_score?: number | null;
  created_at?: string | null;
  last_updated_at?: string | null;
  source?: string | null;
  source_layer?: string | null;
  data_quality?: string | null;
  confidence?: string | null;
  search_volume?: number | null;
  competition_source?: string | null;
  competition_confidence?: string | null;
  last_competition_enriched_at?: string | null;
  region?: string | null;
  trend_series?: TrendPoint[] | null;
  trend_series_granularity?: string | null;
  trend_series_source?: string | null;
  trend_series_updated_at?: string | null;
};

export type OppEvidence = {
  opportunity_score?: number | null;
  linked_pins_count?: number | null;
  linked_products_count?: number | null;
  total_source_saves?: number | null;
  primary_label?: string | null;
  trend_state?: string | null;
  internal_reason_codes?: unknown;
  readiness?: ReadinessPayload | null;
};

function buildTrendSeriesMeta(row: TrendKeywordDbRow, trendState: ReturnType<typeof getTrendState>): TrendSeriesMeta {
  const display = resolveTrendDisplay(row, trendState);
  return {
    source:           row.trend_series_source ?? null,
    granularity:      row.trend_series_granularity ?? null,
    updatedAt:        row.trend_series_updated_at ?? row.last_updated_at ?? null,
    displayMode:      display.mode,
    displayTitle:     display.title,
    displaySourceLine: display.sourceLine,
  };
}

export function mapToRelatedRow(
  row: TrendKeywordDbRow,
  opp?: OppEvidence | null,
): RelatedKeywordRow {
  const officialTs = officialTrendPoints(row);
  const volLevel = row.volume_signal ?? row.search_volume_level;

  const interestBand = getPinterestInterestBand(
    volLevel, officialTs, row.volume_signal, row.volume_score,
  );
  const trendStateBase = getTrendState(
    officialTs, row.yearly_change, row.weekly_change,
  );
  const compBand   = getCompetitionBand(
    row.competition_level, volLevel, row.volume_signal,
    row.volume_score, row.priority_score,
  );
  const saveBand = getSaveSignalBand(opp?.total_source_saves, opp?.linked_pins_count);

  let readiness: ReadinessPayload | null = opp?.readiness ?? null;
  if (!readiness && opp?.internal_reason_codes) {
    readiness = parseReadinessFromInternalCodes(
      typeof opp.internal_reason_codes === "string"
        ? JSON.parse(opp.internal_reason_codes)
        : opp.internal_reason_codes,
    );
  }
  if (!readiness) {
    readiness = buildReadinessFromEvidence({
      keywordId: row.id,
      category: row.category,
      linkedProductsCount: opp?.linked_products_count,
      linkedPinsCount: opp?.linked_pins_count,
      totalSourceSaves: opp?.total_source_saves,
      yearlyChange: row.yearly_change,
      trendState: opp?.trend_state ?? trendStateBase,
    });
  }

  const rising = trendStateBase === "Rising" || (row.yearly_change ?? 0) >= 80;
  const trendState: TrendState = opp?.trend_state
    ? (opp.trend_state as TrendState)
    : (adjustTrendStateDisplay(trendStateBase, readiness.readinessStatus, rising) as TrendState);

  const trendDisplay = buildTrendSeriesMeta(row, trendStateBase);
  const chartPts = resolveTrendDisplay(row, trendStateBase).chartSeries;

  const provenance = buildProvenance({
    hasTrendHistory:      officialTs.length >= 6,
    hasCompetitionSample: !!row.competition_source,
    hasOppEvidence:       !!(opp?.total_source_saves || opp?.linked_pins_count),
    competitionSource:     row.competition_source,
    competitionConfidence: row.competition_confidence,
    lastFetchedAt:
      row.last_updated_at ??
      row.last_competition_enriched_at ??
      row.created_at,
    sourceLabel:  row.source,
    sourceLayer:  row.source_layer,
    dataQuality:  row.data_quality,
    dbConfidence: row.confidence,
  });
  provenance.trendSeries = trendDisplay;

  const dsl = deriveDataSourceLabel(row);

  return {
    id:                    row.id,
    keyword:               row.keyword,
    category:              row.category ?? undefined,
    pinterestInterestBand: interestBand,
    saveSignalBand:        saveBand,
    competitionBand:       compBand,
    trendState:            trendState,
    timeSeries:            chartPts?.length ? chartPts : undefined,
    trendDisplay,
    provenance,
    dataSourceLabel:       dsl,
    interestRelativeIndex:    bandInterestIndex(interestBand, row.volume_score),
    saveRelativeIndex:        savesIndex(opp?.total_source_saves, opp?.linked_pins_count) || saveBandIndex(saveBand),
    competitionRelativeIndex: bandCompIndex(compBand),
    readinessStatus:          readiness.readinessStatus,
    readinessReasons:         readiness.readinessReasons,
    productAvailabilityTier:  readiness.productAvailabilityTier,
    referenceAvailabilityTier: readiness.referenceAvailabilityTier,
  };
}

export function mapToKeywordSummary(
  row: TrendKeywordDbRow,
  opp: OppEvidence | null | undefined,
  region: string,
  match?: { matchedKeyword?: string; isExactMatch?: boolean },
): KeywordSummary {
  const rel = mapToRelatedRow(row, opp);
  const ts  = rel.timeSeries ?? [];
  const display = rel.trendDisplay!;
  const dsl = rel.dataSourceLabel ?? "Estimated";

  const interestIdx = display.displayMode === "official_chart" && ts.length >= 6
    ? Math.round(ts[ts.length - 1].value)
    : bandInterestIndex(rel.pinterestInterestBand, row.volume_score);

  const saveIdx = savesIndex(opp?.total_source_saves, opp?.linked_pins_count) ||
    saveBandIndex(rel.saveSignalBand);

  const compIdx = bandCompIndex(rel.competitionBand);

  return {
    keyword:               row.keyword,
    keywordId:             row.id,
    platform:              "pinterest",
    region,
    pinterestInterestBand: rel.pinterestInterestBand,
    saveSignalBand:        rel.saveSignalBand,
    competitionBand:       rel.competitionBand,
    trendState:            rel.trendState,
    interestIndexCurrent:  display.displayMode === "official_chart" && ts.length >= 6
      ? ts[ts.length - 1].value
      : undefined,
    pctGrowthYoY:          row.yearly_change  ?? undefined,
    pctGrowthMoM:          row.monthly_change ?? undefined,
    pctGrowthWoW:          row.weekly_change  ?? undefined,
    timeSeries:            ts,
    trendDisplay:          display,
    category:              row.category ?? undefined,
    updatedAt:             row.last_updated_at ?? undefined,
    firstSeenAt:           !row.last_updated_at ? (row.created_at ?? undefined) : undefined,
    matchedKeyword:        match?.matchedKeyword,
    isExactMatch:          match?.isExactMatch,
    insightBullets: getKeywordInsightBullets({
      keyword:         row.keyword,
      trendState:      rel.trendState,
      interestBand:    rel.pinterestInterestBand,
      competitionBand: rel.competitionBand,
      category:        row.category,
      yoyGrowth:       row.yearly_change,
    }),
    provenance: rel.provenance,
    dataSourceLabel: dsl,
    interestMetric: {
      label: rel.pinterestInterestBand,
      relativeIndex: interestIdx,
      sourceNote: interestSourceNote(dsl),
    },
    saveMetric: {
      label: rel.saveSignalBand ?? "Weak",
      relativeIndex: saveIdx,
      sourceNote: saveSourceNote(),
    },
    competitionMetric: {
      label: rel.competitionBand,
      relativeIndex: compIdx,
      sourceNote: compSourceNote(),
    },
  };
}

export function trendingSortScore(row: TrendKeywordDbRow, opp?: OppEvidence | null): number {
  const oppScore = opp?.opportunity_score ?? 0;
  const priority = row.priority_score ?? 0;
  const volume   = row.volume_score ?? 0;
  const yoy      = row.yearly_change ?? 0;
  const fresh    = row.last_updated_at ? new Date(row.last_updated_at).getTime() / 1e10 : 0;
  return oppScore * 100 + priority + volume * 5 + yoy * 0.1 + fresh;
}

export function normalizeWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2);
}

export function wordOverlapScore(query: string, candidate: string): number {
  const setQ   = new Set(normalizeWords(query));
  const wordsC = normalizeWords(candidate);
  if (!setQ.size || !wordsC.length) return 0;
  const overlap = wordsC.filter(w => setQ.has(w)).length;
  return overlap / Math.max(setQ.size, wordsC.length);
}
