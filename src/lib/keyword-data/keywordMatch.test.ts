import { describe, it, expect } from "vitest";
import {
  computeMatchSimilarity,
  isAcceptableMatch,
  pickBestMatch,
} from "./keywordMatch";
import type { TrendKeywordDbRow } from "./mapTrendKeywordRow";

const row = (keyword: string): TrendKeywordDbRow => ({
  id: keyword,
  keyword,
});

describe("keywordMatch", () => {
  it("accepts broad prefix match for home", () => {
    expect(computeMatchSimilarity("home", "home decor collage")).toBeGreaterThan(0.4);
    expect(isAcceptableMatch("home", "home decor collage", "prefix")).toBe(true);
  });

  it("rejects unrelated gibberish", () => {
    const best = pickBestMatch("zzzzzztest", [
      { row: row("cozy bedroom decor"), matchType: "contains" },
    ]);
    expect(best).toBeNull();
  });

  it("prefers closer match when multiple candidates exist", () => {
    const best = pickBestMatch("home", [
      { row: row("home decor collage"), matchType: "prefix" },
      { row: row("smart home gadgets"), matchType: "contains" },
    ]);
    expect(best?.row.keyword).toBe("home decor collage");
  });
});
