// Opportunity ranking for product-led Create Pin mode.
// Uses product intent signals to score and filter DB opportunity rows.

export type {
  DemandBand, CompetitionBand, TrendState, OpportunityRow,
} from "./opportunity-bands";

import {
  getDemandBand, getCompetitionBand, getTrendStateBand, getEvidenceSentence,
  type DemandBand, type CompetitionBand, type TrendState, type OpportunityRow,
} from "./opportunity-bands";
import { extractProductIntent, type ProductSignalInput } from "./product-intent";

// ── Shared types ──────────────────────────────────────────────────────────────

export type PinSample = {
  id:         string;
  image_url:  string;
  save_count: number;
};

export type ProductSignal = {
  id:           string;
  product_name: string;
  image_url:    string | null;
  domain:       string | null;
  price:        number | null;
};

export type ScoredOpportunity = OpportunityRow & {
  score:            number;
  demandBand:       DemandBand;
  competitionBand:  CompetitionBand;
  trendState:       TrendState;
  evidenceSentence: string;
};

export type ProductLedOpportunity = {
  keyword:          string;
  category:         string;
  demandBand:       DemandBand;
  competitionBand:  CompetitionBand;
  trendState:       TrendState;
  evidenceSentence: string;
  referencePins:    PinSample[];
};

// ── Scoring ───────────────────────────────────────────────────────────────────

function normCat(cat: string): string {
  return cat.toLowerCase().replace(/\s+/g, "-");
}

export function getRecommendedOpportunitiesForProducts(
  products:           ProductSignal[],
  rows:               OpportunityRow[],
  refCountByKeyword?: Record<string, number>,
): ScoredOpportunity[] {
  if (!products.length || !rows.length) return [];

  const intent = extractProductIntent(products as ProductSignalInput[]);

  const scored: ScoredOpportunity[] = rows.map(row => {
    const kw      = row.keyword.toLowerCase();
    const rowCat  = normCat(row.category);
    const demand  = getDemandBand(row);
    const comp    = getCompetitionBand(row);
    const trend   = getTrendStateBand(row);

    let score = 0;

    // 1. Category match (20 pts)
    if (intent.category) {
      if (rowCat === intent.category || rowCat.includes(intent.category.replace(/-/g," "))) score += 20;
      else if (intent.category === "fashion" && rowCat.includes("fashion")) score += 20;
    }

    // 2. Product type match (18 pts)
    const typeHits = intent.productTypes.filter(t => kw.includes(t)).length;
    score += Math.min(typeHits * 9, 18);

    // 3. Use-case match (16 pts)
    const ucHits = intent.useCases.filter(u => kw.includes(u)).length;
    score += Math.min(ucHits * 8, 16);

    // 4. Style match (14 pts)
    const styleHits = intent.styles.filter(s => kw.includes(s)).length;
    score += Math.min(styleHits * 7, 14);

    // 5. Color / visual attribute match (8 pts)
    const colorHits = intent.colors.filter(c => kw.includes(c)).length;
    score += Math.min(colorHits * 4, 8);

    // 6. Raw token overlap (10 pts)  — tokens > 3 chars
    const tokHits = intent.rawTokens.filter(t => t.length > 3 && kw.includes(t)).length;
    score += Math.min(tokHits * 2, 10);

    // 7. Demand (12 pts)
    score += demand === "High" ? 12 : demand === "Medium" ? 7 : 3;

    // 8. Competition advantage (10 pts)
    score += comp === "Low" ? 10 : comp === "Medium" ? 6 : 2;

    // 9. Trend score (8 pts)
    score += trend === "Rising" ? 8 : 4;

    // 10. Has reference pins (10 pts)
    if ((refCountByKeyword?.[row.keyword] ?? 0) > 0) score += 10;

    // ── Hard exclusion: clearly wrong category ────────────────────────────────
    if (intent.category) {
      const mismatch = (
        (intent.category === "fashion" && (rowCat.includes("home") || rowCat.includes("decor"))) ||
        (intent.category === "home-decor" && rowCat.includes("fashion")) ||
        (intent.category === "beauty" && (rowCat.includes("home") || rowCat.includes("food"))) ||
        (intent.category === "digital-products" && (rowCat.includes("home") || rowCat.includes("fashion")))
      );
      if (mismatch) score = Math.min(score, 12);
    }

    return {
      ...row,
      score,
      demandBand:       demand,
      competitionBand:  comp,
      trendState:       trend,
      evidenceSentence: getEvidenceSentence(demand, trend),
    };
  });

  // Primary sort: score desc; break ties with priority_score
  return scored
    .sort((a, b) => b.score !== a.score
      ? b.score - a.score
      : (b.priority_score ?? 0) - (a.priority_score ?? 0)
    )
    .slice(0, 8);
}
