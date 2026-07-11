// Convert raw Supabase keyword rows into display-ready qualitative bands.
// Never exposes fake exact numbers — all outputs are bands or normalized 0–100 indices.

import type {
  Band,
  CompetitionBand,
  SaveSignalBand,
  TrendState,
  TrendPoint,
  DataSource,
  DataConfidence,
  DataProvenance,
} from "./types";

function volumeLabelToBand(level?: string | null): Band {
  const v = (level ?? "").toLowerCase();
  if (v === "very_high" || v === "high") return "High";
  if (v === "medium") return "Medium";
  if (v === "low") return "Low";
  return "Medium";
}

function volumeScoreToBand(score?: number | null): Band | null {
  if (score == null || Number.isNaN(score)) return null;
  if (score >= 3.5) return "High";
  if (score >= 2.2) return "Medium";
  if (score >= 1) return "Low";
  return null;
}

export function getPinterestInterestBand(
  searchVolumeLevel?: string | null,
  timeSeries?: TrendPoint[],
  volumeSignal?: string | null,
  volumeScore?: number | null,
): Band {
  // Prefer time-series: use average of the last 4 data points
  if (timeSeries && timeSeries.length >= 4) {
    const recentMax = Math.max(...timeSeries.slice(-4).map(p => p.value));
    if (recentMax >= 70) return "High";
    if (recentMax >= 35) return "Medium";
    return "Low";
  }
  const fromScore = volumeScoreToBand(volumeScore);
  if (fromScore) return fromScore;
  if (volumeSignal) return volumeLabelToBand(volumeSignal);
  return volumeLabelToBand(searchVolumeLevel);
}

export function getTrendState(
  timeSeries?: TrendPoint[],
  yoyGrowth?: number | null,
  weeklyChange?: number | null,
): TrendState {
  if (timeSeries && timeSeries.length >= 8) {
    const half = Math.floor(timeSeries.length / 2);
    const recentSlice = timeSeries.slice(half);
    const olderSlice = timeSeries.slice(0, half);
    const recentAvg = recentSlice.reduce((a, b) => a + b.value, 0) / recentSlice.length;
    const olderAvg = olderSlice.reduce((a, b) => a + b.value, 0) / olderSlice.length;
    const slope = recentAvg - olderAvg;

    if (slope > 15 || (yoyGrowth && yoyGrowth >= 80)) return "Rising";

    // Seasonal: high variance relative to mean
    const avg = timeSeries.reduce((a, b) => a + b.value, 0) / timeSeries.length;
    const variance = timeSeries.reduce((a, b) => a + (b.value - avg) ** 2, 0) / timeSeries.length;
    if (variance > 300 && avg > 20) return "Seasonal";

    return "Evergreen";
  }

  // Fallback to growth metrics when no time series
  if ((yoyGrowth ?? 0) >= 80 || (weeklyChange ?? 0) >= 25) return "Rising";
  if ((yoyGrowth ?? 0) >= 35 || (weeklyChange ?? 0) >= 12) return "Rising";
  if ((yoyGrowth ?? 0) <= -15 && (weeklyChange ?? 0) < 0) return "Seasonal";
  return "Evergreen";
}

export function getCompetitionBand(
  competitionLevel?: string | null,
  searchVolumeLevel?: string | null,
  volumeSignal?: string | null,
  volumeScore?: number | null,
  priorityScore?: number | null,
): CompetitionBand {
  const cl = (competitionLevel ?? "").toLowerCase();
  if (cl === "low") return "Low";
  if (cl === "high") return "High";
  if (cl === "medium") return "Medium";

  if (volumeScore != null) {
    if (volumeScore >= 3.8) return "High";
    if (volumeScore >= 2.5) return "Medium";
    return "Low";
  }

  const vl = (volumeSignal ?? searchVolumeLevel ?? "").toLowerCase();
  if (vl === "very_high") return "High";
  if (vl === "high") return "Medium";
  if (vl === "low") return "Low";

  if ((priorityScore ?? 0) >= 75) return "Medium";
  return "Low";
}

export function getSaveSignalBand(
  totalSaves?: number | null,
  linkedPins?: number | null,
): SaveSignalBand {
  if (!totalSaves || totalSaves <= 0) return "Weak";
  const savesPerPin = linkedPins && linkedPins > 0 ? totalSaves / linkedPins : 0;
  if (totalSaves > 15_000 || savesPerPin > 250) return "Strong";
  if (totalSaves > 3_000 || savesPerPin > 80) return "Medium";
  if (totalSaves > 400) return "Medium";
  return "Weak";
}

// ── Data provenance builder ───────────────────────────────────────────────────

export function buildProvenance(params: {
  hasTrendHistory:      boolean;
  hasCompetitionSample: boolean;
  hasOppEvidence:       boolean;
  competitionSource?:   string | null;
  competitionConfidence?: string | null;
  lastFetchedAt?:       string | null;
  sampleSize?:          number | null;
  sourceLabel?:         string | null;
  sourceLayer?:         string | null;
  dataQuality?:         string | null;
  dbConfidence?:        string | null;
}): DataProvenance {
  const {
    hasTrendHistory, hasCompetitionSample, hasOppEvidence,
    competitionSource, competitionConfidence, lastFetchedAt, sampleSize,
    sourceLabel, sourceLayer, dataQuality, dbConfidence,
  } = params;

  const isL3Estimated =
    sourceLayer === "L3" ||
    dataQuality === "estimated" ||
    sourceLabel === "pinterest_typeahead_estimated";

  const sources: DataSource[] = ["pinterest_trends"];
  if (hasCompetitionSample || competitionSource === "pinterest_search_sample") {
    sources.push("pinterest_search_sample");
  }
  if (!hasTrendHistory || isL3Estimated) {
    sources.push("derived"); // band reconstructed from signals, not measured volume
  }

  let confidence: DataConfidence;
  const dbConf = (dbConfidence ?? "").toLowerCase();
  if (dbConf === "high") {
    confidence = "High";
  } else if (dbConf === "medium") {
    confidence = "Medium";
  } else if (dbConf === "low" || isL3Estimated) {
    confidence = "Low";
  } else if (competitionConfidence === "High") {
    confidence = hasTrendHistory ? "High" : "Medium";
  } else if (hasTrendHistory && hasOppEvidence) {
    confidence = "High";
  } else if (hasTrendHistory || hasOppEvidence) {
    confidence = "Medium";
  } else {
    confidence = "Low";
  }

  return {
    sources,
    confidence,
    isEstimated: !hasTrendHistory || isL3Estimated,
    lastFetchedAt: lastFetchedAt ?? undefined,
    sampleSize: sampleSize ?? undefined,
    sourceLabel: sourceLabel ?? undefined,
    sourceLayer: sourceLayer ?? undefined,
    dataQuality: dataQuality ?? undefined,
  };
}

export function getKeywordInsightBullets(params: {
  keyword: string;
  trendState: TrendState;
  interestBand: Band;
  competitionBand: CompetitionBand;
  category?: string | null;
  yoyGrowth?: number | null;
}): string[] {
  const { trendState, interestBand, competitionBand, category, yoyGrowth } = params;
  const bullets: string[] = [];

  if (trendState === "Rising") {
    const detail =
      yoyGrowth && yoyGrowth > 0
        ? `Interest is up ${Math.round(yoyGrowth)}% vs. a year ago.`
        : "Interest has been rising steadily in recent months.";
    bullets.push(`Rising steadily — ${detail}`);
  } else if (trendState === "Seasonal") {
    bullets.push(
      "Seasonal pattern detected — plan content 2–3 weeks ahead of the peak window.",
    );
  } else {
    bullets.push("Consistent search presence — reliable audience reach year-round.");
  }

  if (category) {
    const catLabel = category.replace(/-/g, " ");
    bullets.push(
      `Strong ${catLabel} overlap — high engagement with ${catLabel} communities.`,
    );
  }

  if (competitionBand === "Low" || competitionBand === "Medium") {
    bullets.push(
      "Good fit for product-led Pins — room to stand out with styled, editorial content.",
    );
  } else {
    bullets.push(
      "High content saturation — many similar pins exist; differentiate with a strong visual signature and niche angle.",
    );
  }

  return bullets;
}
