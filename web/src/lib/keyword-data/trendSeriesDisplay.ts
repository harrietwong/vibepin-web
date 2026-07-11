// Source-aware trend chart vs estimated-signal display rules.

import type { TrendPoint, TrendState, DataConfidence } from "./types";
import type { TrendKeywordDbRow } from "./mapTrendKeywordRow";

export type TrendDisplayMode =
  | "official_chart"    // L1 + real Pinterest time series → 12-month line chart
  | "resource_insight"  // L2 → growth insight, no full chart
  | "estimated_signal"  // L3 / derived → qualitative signal only
  | "unavailable";      // no usable trend data

export type TrendDisplayInfo = {
  mode: TrendDisplayMode;
  /** Only set when mode === official_chart */
  chartSeries?: TrendPoint[];
  title: string;
  sourceLine: string;
  showChart: boolean;
};

const OFFICIAL_SERIES_SOURCES = new Set([
  "pinterest_trends_api",
  "pinterest_trends_official",
]);

const DERIVED_SERIES_SOURCES = new Set([
  "derived_growth_metrics",
  "synthetic",
]);

export function isL3Estimated(row: Pick<TrendKeywordDbRow, "source_layer" | "source" | "data_quality">): boolean {
  return (
    row.source_layer === "L3" ||
    row.data_quality === "estimated" ||
    row.source === "pinterest_typeahead_estimated"
  );
}

export function isDerivedTrendSeries(seriesSource?: string | null): boolean {
  if (!seriesSource) return false;
  return DERIVED_SERIES_SOURCES.has(seriesSource);
}

export function isOfficialTrendSeries(row: TrendKeywordDbRow): boolean {
  const seriesSource = row.trend_series_source;
  if (seriesSource && isDerivedTrendSeries(seriesSource)) return false;

  const layer = row.source_layer;
  const source = row.source;

  if (layer === "L1" && source === "pinterest_trends_official") {
    if (seriesSource && OFFICIAL_SERIES_SOURCES.has(seriesSource)) return true;
    // Legacy rows: L1 official without series_source tag but real API write
    const pts = resolveSeriesPoints(row);
    return pts.length >= 6;
  }

  if (seriesSource && OFFICIAL_SERIES_SOURCES.has(seriesSource)) {
    return layer === "L1" || source === "pinterest_trends_official";
  }

  return false;
}

export function resolveSeriesPoints(row: TrendKeywordDbRow): TrendPoint[] {
  const raw = row.trend_series ?? row.trend_history;
  if (!raw || !Array.isArray(raw)) return [];
  return raw as TrendPoint[];
}

/** Points safe to use for band/scoring (never derived synthetic curves). */
export function officialTrendPoints(row: TrendKeywordDbRow): TrendPoint[] {
  return isOfficialTrendSeries(row) ? resolveSeriesPoints(row) : [];
}

export function resolveTrendDisplay(row: TrendKeywordDbRow, trendState: TrendState): TrendDisplayInfo {
  const confidence = (row.confidence ?? "low") as DataConfidence;
  const quality = row.data_quality ?? "estimated";

  if (isL3Estimated(row)) {
    return {
      mode: "estimated_signal",
      title: "Estimated trend signal",
      sourceLine: "Estimated from Pinterest autocomplete and saved Pin signals",
      showChart: false,
    };
  }

  if (isOfficialTrendSeries(row)) {
    const pts = resolveSeriesPoints(row);
    if (pts.length >= 6) {
      return {
        mode: "official_chart",
        chartSeries: pts,
        title: "Search Trend · Past 12 months",
        sourceLine: "Pinterest Trends API",
        showChart: true,
      };
    }
  }

  if (row.source_layer === "L2" || row.source === "pinterest_resource") {
    return {
      mode: "resource_insight",
      title: "Trend insight",
      sourceLine: "Pinterest internal resource trends · limited historical depth",
      showChart: false,
    };
  }

  const pts = resolveSeriesPoints(row);
  if (pts.length >= 6 && !isDerivedTrendSeries(row.trend_series_source)) {
    // Legacy official-ish rows (manual import, old pinterest_trends label) — no chart without L1 tag
    return {
      mode: "estimated_signal",
      title: "Estimated trend signal",
      sourceLine: "Directional signal from growth metrics — not official Pinterest 12-month history",
      showChart: false,
    };
  }

  if (isDerivedTrendSeries(row.trend_series_source) || pts.length >= 6) {
    return {
      mode: "estimated_signal",
      title: "Estimated trend signal",
      sourceLine: "Estimated from Pinterest autocomplete and saved Pin signals",
      showChart: false,
    };
  }

  return {
    mode: "unavailable",
    title: "Trend data unavailable",
    sourceLine: "No official Pinterest trend history for this keyword yet",
    showChart: false,
  };
}

export function formatTrendStateLabel(state: TrendState): string {
  return state;
}

export function formatQualityLabel(quality?: string | null, confidence?: string | null): string {
  const q = quality ?? "unknown";
  const c = confidence ?? "low";
  return `${q} · ${c} confidence`;
}
