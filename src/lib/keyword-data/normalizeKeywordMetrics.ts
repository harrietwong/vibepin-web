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

export function getPinterestInterestBand(
  searchVolumeLevel?: string | null,
  timeSeries?: TrendPoint[],
): Band {
  // Prefer time-series: use average of the last 4 data points
  if (timeSeries && timeSeries.length >= 4) {
    const recentMax = Math.max(...timeSeries.slice(-4).map(p => p.value));
    if (recentMax >= 70) return "High";
    if (recentMax >= 35) return "Medium";
    return "Low";
  }
  const level = (searchVolumeLevel ?? "").toLowerCase();
  if (level === "very_high" || level === "high") return "High";
  if (level === "medium") return "Medium";
  return "Low";
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
  if ((yoyGrowth ?? 0) >= 50 || (weeklyChange ?? 0) >= 20) return "Rising";
  return "Evergreen";
}

export function getCompetitionBand(
  competitionLevel?: string | null,
  searchVolumeLevel?: string | null,
): CompetitionBand {
  const cl = (competitionLevel ?? "").toLowerCase();
  if (cl === "low") return "Low";
  if (cl === "high") return "High";
  if (cl === "medium") return "Medium";

  // Fallback: high volume ≈ more competition
  const vl = (searchVolumeLevel ?? "").toLowerCase();
  if (vl === "very_high") return "High";
  if (vl === "high") return "Medium";
  return "Low";
}

export function getSaveSignalBand(
  totalSaves?: number | null,
  linkedPins?: number | null,
): SaveSignalBand {
  if (!totalSaves) return "Weak";
  const savesPerPin = linkedPins && linkedPins > 0 ? totalSaves / linkedPins : 0;
  if (totalSaves > 20_000 || savesPerPin > 300) return "Strong";
  if (totalSaves > 5_000) return "Medium";
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
}): DataProvenance {
  const {
    hasTrendHistory, hasCompetitionSample, hasOppEvidence,
    competitionSource, competitionConfidence, lastFetchedAt, sampleSize,
  } = params;

  const sources: DataSource[] = ["pinterest_trends"];
  if (hasCompetitionSample || competitionSource === "pinterest_search_sample") {
    sources.push("pinterest_search_sample");
  }
  if (!hasTrendHistory) {
    sources.push("derived"); // trend curve reconstructed from growth metrics
  }

  let confidence: DataConfidence;
  if (competitionConfidence === "High") {
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
    isEstimated: !hasTrendHistory,
    lastFetchedAt: lastFetchedAt ?? undefined,
    sampleSize: sampleSize ?? undefined,
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
      "Competitive space — differentiate with a strong visual signature and niche angle.",
    );
  }

  return bullets;
}
