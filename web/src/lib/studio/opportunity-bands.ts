// Band types and helpers for opportunity scoring display.
// Shared between lib/studio and components/studio.

export type DemandBand      = "High" | "Medium" | "Low";
export type CompetitionBand = "Low"  | "Medium" | "High";
export type TrendState      = "Rising" | "Evergreen" | "Seasonal";

export type OpportunityRow = {
  id:                   string;
  keyword:              string;
  category:             string;
  search_volume_level:  string | null;
  priority_score:       number | null;
  yearly_change:        number | null;
};

export function getDemandBand(row: OpportunityRow): DemandBand {
  const lvl = row.search_volume_level;
  if (lvl === "very_high" || lvl === "high") return "High";
  if (lvl === "medium") return "Medium";
  const ps = row.priority_score ?? 0;
  if (ps >= 80) return "High";
  if (ps >= 50) return "Medium";
  return "Low";
}

export function getCompetitionBand(row: OpportunityRow): CompetitionBand {
  const ps = row.priority_score ?? 0;
  if (ps >= 75) return "Low";
  if (ps >= 45) return "Medium";
  return "High";
}

export function getTrendStateBand(row: OpportunityRow): TrendState {
  if ((row.yearly_change ?? 0) >= 50) return "Rising";
  return "Evergreen";
}

export function getEvidenceSentence(demand: DemandBand, trend: TrendState): string {
  if (trend === "Rising" && demand === "High") return "Strong save signal and rising interest — good timing";
  if (trend === "Rising")  return "Rising interest — good time to enter";
  if (demand === "High")   return "Consistent high demand — proven content type";
  if (demand === "Low")    return "Low competition niche — early mover advantage";
  return "Product-friendly style match";
}

export function demandBandColor(band: DemandBand): string {
  if (band === "High")   return "#16A34A";
  if (band === "Medium") return "#2563EB";
  return "#94A3B8";
}

export function competitionBandColor(band: CompetitionBand): string {
  if (band === "Low")    return "#16A34A";
  if (band === "Medium") return "#D97706";
  return "#DC2626";
}

export function trendStateColor(state: TrendState): string {
  if (state === "Rising")   return "#059669";
  if (state === "Seasonal") return "#D97706";
  return "#2563EB";
}

export function trendStateIcon(state: TrendState): string {
  if (state === "Rising")   return "↑ ";
  if (state === "Seasonal") return "◎ ";
  return "∞ ";
}
