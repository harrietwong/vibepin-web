// ── Core enums ────────────────────────────────────────────────────────────────

export type MomentumLevel = "surging" | "steady" | "declining";

// MarketTag: the single seller-facing classification based on volume vs. commercial density.
export type MarketTag =
  | "hidden_supply"           // High audience volume, almost no commercial pins — clear entry gap
  | "new_account_friendly"    // Surging fast, not yet flooded with sellers
  | "oversaturated"           // Commercial density too high — many products already competing
  | "low_volume";             // Small/stale niche — limited audience reach

// ── MarketTag display metadata ────────────────────────────────────────────────

export interface MarketTagMeta {
  label:  string;
  emoji:  string;
  color:  string;
  bg:     string;
  border: string;
}

export const MARKET_TAG_META: Record<MarketTag, MarketTagMeta> = {
  hidden_supply:        { label: "High Demand, Hidden Supply", emoji: "✨", color: "#0891B2", bg: "rgba(8,145,178,0.09)",  border: "rgba(8,145,178,0.22)"  },
  new_account_friendly: { label: "New Account Friendly",       emoji: "⚡", color: "#059669", bg: "rgba(5,150,105,0.07)",  border: "rgba(5,150,105,0.2)"   },
  oversaturated:        { label: "Over-saturated Market",      emoji: "🔥", color: "#DC2626", bg: "rgba(220,38,38,0.07)",  border: "rgba(220,38,38,0.2)"   },
  low_volume:           { label: "Low Volume",                  emoji: "📉", color: "#9CA3AF", bg: "#F3F4F6",               border: "#E5E7EB"               },
};

// ── Unified assessment (shared across Keyword / Pin / Product) ────────────────

export interface OpportunityAssessment {
  marketTag:        MarketTag;
  estMonthlyVolume: number;   // saves × 12 — estimated monthly audience size
  commercialRatio:  number;   // products / max(pins, 1) — how commercial the niche already is
  momentum:         MomentumLevel;
  insight:          string;   // plain-English seller pain-point sentence
}

// ── Raw input signals ─────────────────────────────────────────────────────────

export interface KeywordRawSignals {
  saves:           number;
  pin_count:       number;
  linked_products: number;
  yoy_growth:      number;
  weekly_change:   number;
}

export interface PinRawSignals {
  save_count: number;
  velocity:   number;
  age_days:   number;
}

export interface ProductRawSignals {
  save_count:            number;
  source_pin_save_count: number;
  linked_keyword_growth: number;
}

// ── Display-ready entities ────────────────────────────────────────────────────

export interface KeywordOpportunity extends KeywordRawSignals {
  id:       string;
  keyword:  string;
  category: string;
  meta:     OpportunityAssessment;
}

export interface PinOpportunity extends PinRawSignals {
  id:        string;
  image_url: string;
  title:     string | null;
  category:  string;
  pin_id:    string | null;
  meta:      OpportunityAssessment;
}

export interface ProductOpportunity extends ProductRawSignals {
  id:           string;
  product_name: string;
  image_url:    string | null;
  domain:       string | null;
  price:        number | null;
  seed_keyword: string | null;
  meta:         OpportunityAssessment;
}
