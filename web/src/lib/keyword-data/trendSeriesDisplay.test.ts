import { describe, it, expect } from "vitest";
import {
  resolveTrendDisplay,
  isOfficialTrendSeries,
  isL3Estimated,
} from "./trendSeriesDisplay";
import type { TrendKeywordDbRow } from "./mapTrendKeywordRow";

const base = (overrides: Partial<TrendKeywordDbRow>): TrendKeywordDbRow => ({
  id: "1",
  keyword: "test",
  ...overrides,
});

describe("trendSeriesDisplay", () => {
  it("L3 estimated never shows official chart", () => {
    const row = base({
      source_layer: "L3",
      source: "pinterest_typeahead_estimated",
      data_quality: "estimated",
      trend_history: Array.from({ length: 52 }, (_, i) => ({ date: `2025-${i}`, value: 50 })),
      trend_series_source: "derived_growth_metrics",
    });
    expect(isL3Estimated(row)).toBe(true);
    const d = resolveTrendDisplay(row, "Rising");
    expect(d.showChart).toBe(false);
    expect(d.mode).toBe("estimated_signal");
    expect(d.title).toBe("Estimated trend signal");
  });

  it("derived growth metrics never counts as official", () => {
    const row = base({
      source_layer: "L1",
      source: "pinterest_trends_official",
      trend_series_source: "derived_growth_metrics",
      trend_history: Array.from({ length: 52 }, (_, i) => ({ date: `2025-${i}`, value: 60 })),
    });
    expect(isOfficialTrendSeries(row)).toBe(false);
    const d = resolveTrendDisplay(row, "Evergreen");
    expect(d.showChart).toBe(false);
  });

  it("L1 official API series shows 12-month chart", () => {
    const pts = Array.from({ length: 52 }, (_, i) => ({ date: `2025-W${i}`, value: 40 + i }));
    const row = base({
      source_layer: "L1",
      source: "pinterest_trends_official",
      trend_series_source: "pinterest_trends_api",
      trend_series: pts,
    });
    expect(isOfficialTrendSeries(row)).toBe(true);
    const d = resolveTrendDisplay(row, "Rising");
    expect(d.showChart).toBe(true);
    expect(d.title).toContain("Past 12 months");
    expect(d.sourceLine).toContain("Pinterest Trends API");
  });
});
