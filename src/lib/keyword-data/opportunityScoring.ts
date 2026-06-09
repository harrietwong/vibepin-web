// Opportunity label scoring.
// Formula is intentionally not exposed in the main UI (spec §12).

import type {
  Band,
  CompetitionBand,
  SaveSignalBand,
  TrendState,
  OpportunityLabel,
} from "./types";

export function getOpportunityLabel(
  interestBand: Band,
  competitionBand: CompetitionBand,
  trendState: TrendState,
  saveSignalBand?: SaveSignalBand,
): OpportunityLabel {
  const iScore: Record<Band, number> = { High: 100, Medium: 60, Low: 20 };
  const mScore: Record<TrendState, number> = { Rising: 100, Evergreen: 60, Seasonal: 40 };
  // Competition advantage is inverted: low competition = high advantage
  const cScore: Record<CompetitionBand, number> = { Low: 100, Medium: 60, High: 20 };
  const sScore: Record<SaveSignalBand, number> = { Strong: 100, Medium: 60, Weak: 20 };

  const score =
    0.35 * iScore[interestBand] +
    0.25 * mScore[trendState] +
    0.20 * cScore[competitionBand] +
    0.10 * sScore[saveSignalBand ?? "Medium"] +
    0.10 * 60; // shop-signal placeholder

  if (score >= 75) return "Best Bet";
  if (score >= 55) return "Steady";
  return "Competitive";
}
