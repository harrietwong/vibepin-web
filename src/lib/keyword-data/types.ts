// Shared types for the Keyword Tool data layer.
// Rule: all user-facing values are qualitative bands. No fake exact numbers.

// ── Display bands ──────────────────────────────────────────────────────────────

export type Band            = "High" | "Medium" | "Low";
// CompetitionBand is surfaced as "Content Saturation" (visual content density),
// never as market competition, and only in detail/auxiliary positions.
export type CompetitionBand = "Low"  | "Medium" | "High";
export type SaveSignalBand  = "Strong" | "Medium" | "Weak";
export type TrendState      = "Rising" | "Evergreen" | "Seasonal" | "Rising · Needs Products" | "Insight Only";

export type ReadinessStatus =
  | "insight_only"
  | "needs_products"
  | "testable"
  | "launch_ready"
  | "strong_opportunity";

export type AvailabilityTier = "none" | "weak" | "testable" | "strong" | "deep";

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

export type DataSourceLabel = "Official" | "Estimated" | "Derived";

export type MetricDetail = {
  label: string;
  relativeIndex: number;  // 0–100 relative index — NOT search volume
  sourceNote: string;
};

export type TrendDisplayMode =
  | "official_chart"
  | "resource_insight"
  | "estimated_signal"
  | "unavailable";

export type TrendSeriesMeta = {
  source?:           string | null;
  granularity?:      string | null;
  updatedAt?:        string | null;
  displayMode:       TrendDisplayMode;
  displayTitle:      string;
  displaySourceLine: string;
};

export type DataProvenance = {
  sources:       DataSource[];
  confidence:    DataConfidence;
  isEstimated:   boolean;          // true = no direct measurement; curve or band is reconstructed
  lastFetchedAt?: string;          // ISO timestamp of freshest underlying data
  sampleSize?:   number;           // only set when source includes pinterest_search_sample
  sourceLabel?:  string;           // e.g. pinterest_typeahead_estimated
  sourceLayer?:  string;           // L1 | L2 | L3
  dataQuality?:  string;           // official | resource | estimated
  trendSeries?:   TrendSeriesMeta;
};

export type KeywordTrendsMeta = {
  total:              number;
  limit:              number;
  offset:             number;
  showing:            number;
  lastUpdated:        string | null;
  pipelineLastRun:    string | null;
  mode:               "trending" | "search";
  query?:             string;
  region:             string;
};

// ── Core result types ──────────────────────────────────────────────────────────

export type KeywordSummary = {
  keyword:   string;
  keywordId?: string;   // trend_keywords.id of the seed row (for plan/save actions)
  platform:  "pinterest";
  region:    string;

  pinterestInterestBand: Band;
  saveSignalBand?:       SaveSignalBand;
  competitionBand:       CompetitionBand;
  trendState:            TrendState;

  // 0–100 normalized interest index (from trend_history), NOT search volume.
  // Label this as "Interest Index" in the UI, never "Search Volume".
  interestIndexCurrent?: number;

  pctGrowthWoW?: number;
  pctGrowthMoM?: number;
  pctGrowthYoY?: number;

  /** Official Pinterest time series only — empty when display is estimated/resource. */
  timeSeries: TrendPoint[];

  trendDisplay?: TrendSeriesMeta;

  category?:        string;
  updatedAt?:       string;   // last_updated_at — label as "Data updated"
  firstSeenAt?:     string;   // created_at (only populated when updatedAt is absent)
  evidenceSentence?: string;
  insightBullets?:  string[];

  // Set when the matched DB keyword differs from the user's query
  matchedKeyword?:  string;
  isExactMatch?:    boolean;

  provenance: DataProvenance;

  // eRank-style metric details
  dataSourceLabel?:  DataSourceLabel;
  interestMetric?:   MetricDetail;
  saveMetric?:       MetricDetail;
  competitionMetric?: MetricDetail;
};

export type RelatedKeywordRow = {
  id:       string;
  keyword:  string;
  category?: string;

  pinterestInterestBand: Band;
  saveSignalBand?:       SaveSignalBand;
  competitionBand:       CompetitionBand;
  trendState:            TrendState;

  timeSeries?:          TrendPoint[];
  trendDisplay?:        TrendSeriesMeta;
  evidenceSentence?:    string;
  dataSourceLabel?:     DataSourceLabel;

  // 0–100 relative indices (NOT search volume) — for compact metric bars.
  interestRelativeIndex?:    number;
  saveRelativeIndex?:        number;
  competitionRelativeIndex?: number;

  /** MVP launch readiness (from opportunities.internal_reason_codes or computed fallback) */
  readinessStatus?:       ReadinessStatus;
  readinessReasons?:      string[];
  productAvailabilityTier?: AvailabilityTier;
  referenceAvailabilityTier?: AvailabilityTier;

  provenance: DataProvenance;
};
