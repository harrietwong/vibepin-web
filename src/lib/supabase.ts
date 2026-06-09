import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Server-side routes use the service role key when available so they bypass
// Row Level Security. Falls back to the anon key for local dev.
const supabaseServerKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? supabaseAnonKey;

// Browser-safe singleton (anon key — exposed to client bundle intentionally).
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-only client (service role key — never exported to client code).
export function createServerClient() {
  return createClient(supabaseUrl, supabaseServerKey, {
    auth: { persistSession: false },
  });
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type ViralPin = {
  id: string;
  pin_id?: string | null;
  pinterest_url?: string | null;
  image_url: string;
  category: string;
  title?: string | null;
  description?: string | null;
  save_count: number;
  reaction_count: number;
  comment_count?: number | null;
  source_url?: string | null;
  outbound_link?: string | null;
  is_ecommerce?: boolean;
  pin_created_at?: string | null;
  scraped_at?: string | null;
  days_since_creation?: number | null;
  save_velocity?: number | null;
  intent_ratio?: number | null;
  is_high_growth?: boolean;
  age_days?: number | null;
  trend_stage?: "emerging" | "growing" | "viral" | "stable" | null;
  source_interest?: string | null;
  seed_keyword?: string | null;
  source_keyword?: string | null;
  source_type?: string | null;
  days_since_created?: number;
  item_type?: string;
  product_type?: string;
  product_subtype?: string;
  destination_type?: string;
  asset_role?: string;
  source_context?: string;
  risk_flags?: string[];
};

// ── Product Intelligence types ─────────────────────────────────────────────────

export type ProductScore = {
  opportunity_score:   number;
  trend_score:         number;
  save_velocity_score: number;
  freshness_score:     number;
  competition_score:   number;
  scored_at:           string;
};

export type ProductWithScore = {
  id:                    string;
  product_name:          string;
  price:                 number | null;
  currency:              string | null;
  domain:                string | null;
  merchant:              string | null;
  image_url:             string | null;
  source_url:            string | null;
  save_count:            number;
  source_pin_save_count: number;
  seed_keyword:          string | null;
  scraped_at:            string | null;
  opportunity_score:     number | null;
  trend_score:           number | null;
  save_velocity_score:   number | null;
  freshness_score:       number | null;
  competition_score:     number | null;
  item_type?:            string;
  product_type?:         string;
  product_subtype?:      string;
  destination_type?:     string;
  asset_role?:           string;
  source_context?:       string;
  risk_flags?:           string[];
};

export type TrendOpportunity = {
  keyword_id:             string;
  keyword:                string;
  category:               string;
  pct_growth_yoy:         number | null;
  search_volume_level:    string | null;
  priority_score:         number | null;
  // evidence counts (from keyword_product_map, not text join)
  linked_products_count:  number;
  linked_pins_count:      number;
  total_source_saves:     number;
  // score aggregates
  opportunity_score:      number | null;
  avg_velocity_score:     number | null;
  avg_trend_score:        number | null;
  avg_freshness_score:    number | null;
  last_scored_at:         string | null;
  // tiers (independent axes)
  score_tier:             "high" | "medium" | "low";
  data_confidence:        "high" | "medium" | "low";
  confidence_reason:      string;
  top_product_ids:        string[] | null;
};

export type KeywordRef = {
  keyword_id:          string | null;
  keyword:             string | null;
  category:            string | null;
  pct_growth_yoy:      number | null;
  search_volume_level: string | null;
  priority_score:      number | null;
  relevance_score:     number;
  total_pins:          number;
  total_saves:         number;
};

export type SiblingProduct = {
  id:           string;
  product_name: string;
  price:        number | null;
  domain:       string | null;
  image_url:    string | null;
  save_count:   number;
};

export type ProductIntelligence = {
  product: {
    id:                    string;
    product_pin_id:        string | null;
    parent_pin_id:         string;
    product_name:          string;
    price:                 number | null;
    currency:              string | null;
    source_url:            string | null;
    domain:                string | null;
    merchant:              string | null;
    image_url:             string | null;
    save_count:            number;
    reaction_count:        number;
    source_pin_save_count: number;
    seed_keyword:          string | null;
    scraped_at:            string | null;
  };
  score:           ProductScore | null;
  source_pin:      Partial<ViralPin> | null;
  keywords:        KeywordRef[];
  sibling_products: SiblingProduct[];
};
