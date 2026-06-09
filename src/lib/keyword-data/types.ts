// Shared types for the Keyword Tool data layer.
// Rule: all user-facing values are qualitative bands. No fake exact numbers.

// ── Display bands ──────────────────────────────────────────────────────────────

export type Band            = "High" | "Medium" | "Low";
export type CompetitionBand = "Low"  | "Medium" | "High";
export type SaveSignalBand  = "Strong" | "Medium" | "Weak";
export type TrendState      = "Rising" | "Evergreen" | "Seasonal";
export type OpportunityLabel = "Best Bet" | "Steady" | "Competitive";

export type TrendPoint = {
  date: string;
  value: number; // normalized 0–100 interest index, NOT raw search volume
};

// ── Data provenance ────────────────────────────────────────────────────────────

export type DataSource =
  | "pinterest_trends"          // trend_keywords scraped from Pinterest Trends
  | "pinterest_search_sample"   // competition estimated from a sampled search result page
  | "manual_import"             // hand-curated data
  | "derived"                   // computationally reconstructed from other fields
  | "demo";                     // fixture / placeholder data (dev only)

export type DataConfidence = "High" | "Medium" | "Low";

export type DataProvenance = {
  sources:       DataSource[];
  confidence:    DataConfidence;
  isEstimated:   boolean;          // true = no direct measurement; curve or band is reconstructed
  lastFetchedAt?: string;          // ISO timestamp of freshest underlying data
  sampleSize?:   number;           // only set when source includes pinterest_search_sample
};

// ── Core result types ──────────────────────────────────────────────────────────

export type KeywordSummary = {
  keyword:  string;
  platform: "pinterest";
  region:   string;

  pinterestInterestBand: Band;
  saveSignalBand?:       SaveSignalBand;
  competitionBand:       CompetitionBand;
  trendState:            TrendState;
  opportunityLabel:      OpportunityLabel;

  // 0–100 normalized interest index (from trend_history), NOT search volume.
  // Label this as "Interest Index" in the UI, never "Search Volume".
  interestIndexCurrent?: number;

  pctGrowthWoW?: number;
  pctGrowthMoM?: number;
  pctGrowthYoY?: number;

  timeSeries: TrendPoint[];

  category?:        string;
  evidenceSentence?: string;
  insightBullets?:  string[];

  // Set when the matched DB keyword differs from the user's query
  matchedKeyword?:  string;
  isExactMatch?:    boolean;

  provenance: DataProvenance;
};

export type RelatedKeywordRow = {
  id:       string;
  keyword:  string;
  category?: string;

  pinterestInterestBand: Band;
  saveSignalBand?:       SaveSignalBand;
  competitionBand:       CompetitionBand;
  trendState:            TrendState;
  opportunityLabel:      OpportunityLabel;

  timeSeries?:       TrendPoint[];
  evidenceSentence?: string;

  provenance: DataProvenance;
};
