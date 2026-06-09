import type {
  OpportunityAssessment,
  MarketTag,
  MomentumLevel,
  KeywordRawSignals,
  PinRawSignals,
  ProductRawSignals,
} from "@/types/opportunity";

// ─────────────────────────────────────────────────────────────────────────────
// MOMENTUM — velocity of trend growth; drives "new account friendly" path
// ─────────────────────────────────────────────────────────────────────────────
export function getMomentum(yoyGrowth: number, weeklyChange: number): MomentumLevel {
  if (yoyGrowth >= 100 || weeklyChange >= 50) return "surging";
  if (yoyGrowth <= -20 && weeklyChange <= -10) return "declining";
  return "steady";
}

// ─────────────────────────────────────────────────────────────────────────────
// EST. MONTHLY VOLUME
// Observed saves × 12 gives a rough monthly audience-size estimate.
// Rounded to nearest 100 for clean display.
// ─────────────────────────────────────────────────────────────────────────────
export function estMonthlyVol(saves: number): number {
  return Math.round(saves * 12 / 100) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKET TAG
// Classifies a niche by the gap between audience size and commercial density.
// Priority order: hidden_supply → new_account_friendly → oversaturated → low_volume
// ─────────────────────────────────────────────────────────────────────────────
export function getMarketTag(
  saves:          number,
  pinCount:       number,
  linkedProducts: number,
  momentum:       MomentumLevel,
): MarketTag {
  const vol   = estMonthlyVol(saves);
  const ratio = pinCount > 0 ? linkedProducts / pinCount : 0;

  const isHighVol      = vol >= 60_000;   // ~5 000 saves observed
  const isMedVol       = vol >= 12_000;   // ~1 000 saves observed
  const isSparse       = linkedProducts < 15 && ratio < 0.2;
  const isOversaturated = ratio > 0.5 || linkedProducts >= 40;

  // Best case: big audience but almost no one selling into it
  if ((isHighVol || (isMedVol && momentum === "surging")) && isSparse)
    return "hidden_supply";

  // Fast-rising niche not yet flooded with sellers
  if (momentum === "surging" && !isOversaturated)
    return "new_account_friendly";

  // Commercial density too high
  if (isOversaturated)
    return "oversaturated";

  return "low_volume";
}

// ─────────────────────────────────────────────────────────────────────────────
// INSIGHT — one seller-focused sentence explaining the supply/demand gap
// ─────────────────────────────────────────────────────────────────────────────
export function generateInsight(
  tag:            MarketTag,
  saves:          number,
  linkedProducts: number,
  pinCount:       number,
  yoyGrowth:      number,
): string {
  if (tag === "hidden_supply") {
    if (linkedProducts === 0)
      return "Users are saving this heavily, but zero commercial pins detected. Test with a digital product or affiliate link before committing.";
    if (linkedProducts <= 3)
      return `Users are saving this heavily, but only ${linkedProducts} pin${linkedProducts === 1 ? "" : "s"} on the front page have store links. Clear gap — low barrier to rank.`;
    return `High traffic with only ${linkedProducts} commercial pins in top results. The audience is there; you just need to show up.`;
  }

  if (tag === "new_account_friendly") {
    const growthLabel = yoyGrowth >= 50 ? `+${yoyGrowth.toFixed(0)}% YoY` : "fast-rising";
    return `${growthLabel} with manageable commercial density — algorithm is rewarding fresh content. New accounts can still rank here without a following.`;
  }

  if (tag === "oversaturated") {
    if (linkedProducts >= 40)
      return `${linkedProducts} products already competing for this audience. Win on niche focus, price point, or unique angle — or skip.`;
    const pct = pinCount > 0 ? Math.round((linkedProducts / pinCount) * 100) : 0;
    return `${pct}% of top pins are commercial. High ad density means users are filter-blind. Differentiate hard or skip.`;
  }

  // low_volume
  if (saves < 500)
    return "Very low save count. Niche appeal only — entry cost is low but audience reach is limited.";
  return "Moderate saves with little commercial signal. Good for building authority before competition arrives.";
}

// ─────────────────────────────────────────────────────────────────────────────
// TOP-LEVEL ASSESSORS — one per entity type
// ─────────────────────────────────────────────────────────────────────────────

export function assessKeyword(signals: KeywordRawSignals): OpportunityAssessment {
  const momentum         = getMomentum(signals.yoy_growth, signals.weekly_change);
  const marketTag        = getMarketTag(signals.saves, signals.pin_count, signals.linked_products, momentum);
  const estMonthlyVolume = estMonthlyVol(signals.saves);
  const commercialRatio  = signals.pin_count > 0 ? signals.linked_products / signals.pin_count : 0;
  const insight          = generateInsight(marketTag, signals.saves, signals.linked_products, signals.pin_count, signals.yoy_growth);
  return { marketTag, estMonthlyVolume, commercialRatio, momentum, insight };
}

export function assessPin(signals: PinRawSignals): OpportunityAssessment {
  const momentum: MomentumLevel =
    signals.velocity >= 100 ? "surging" :
    signals.velocity <= 5   ? "declining" : "steady";

  const marketTag        = getMarketTag(signals.save_count, 0, 0, momentum);
  const estMonthlyVolume = estMonthlyVol(signals.save_count);
  const commercialRatio  = 0;
  const insight          = generateInsight(marketTag, signals.save_count, 0, 0, 0);
  return { marketTag, estMonthlyVolume, commercialRatio, momentum, insight };
}

export function assessProduct(signals: ProductRawSignals): OpportunityAssessment {
  const momentum: MomentumLevel =
    signals.linked_keyword_growth >= 100 ? "surging" :
    signals.linked_keyword_growth <= -20  ? "declining" : "steady";

  const commercialRatio   = signals.source_pin_save_count > 0
    ? signals.save_count / signals.source_pin_save_count : 0;

  // Estimate commercial density from the ratio rather than raw product count
  const estProducts = commercialRatio > 0.05 ? 40 : commercialRatio > 0.01 ? 15 : 2;
  const estPins     = 50;
  const marketTag        = getMarketTag(signals.source_pin_save_count, estPins, estProducts, momentum);
  const estMonthlyVolume = estMonthlyVol(signals.source_pin_save_count);
  const insight          = generateInsight(marketTag, signals.source_pin_save_count, estProducts, estPins, signals.linked_keyword_growth);
  return { marketTag, estMonthlyVolume, commercialRatio, momentum, insight };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA — three canonical test scenarios
// ─────────────────────────────────────────────────────────────────────────────
export const MOCK_OPPORTUNITIES = {
  scenarioA_hiddenSupply:       assessKeyword({ saves: 82_000,  pin_count: 18,  linked_products: 4,  yoy_growth: 340, weekly_change: 62 }),
  scenarioB_oversaturated:      assessKeyword({ saves: 420_000, pin_count: 280, linked_products: 95, yoy_growth: 12,  weekly_change: 3  }),
  scenarioC_newAccountFriendly: assessKeyword({ saves: 3_200,   pin_count: 11,  linked_products: 2,  yoy_growth: 180, weekly_change: 90 }),
} as const;
