import { assessKeyword, assessPin, assessProduct } from "@/lib/scoring";
import type { KeywordOpportunity, PinOpportunity, ProductOpportunity } from "@/types/opportunity";

// Raw DB row shapes ────────────────────────────────────────────────────────────

interface RawKeyword {
  id: string;
  keyword: string;
  category: string;
  subcategory?: string | null;
  weekly_change?: number | null;
  yearly_change?: number | null;
  search_volume_level?: string | null;
}

// Pinterest search volume tiers → synthetic save proxy for demand scoring.
// Used when real save counts are unavailable (pipeline not yet run).
const VOL_LEVEL_SAVES: Record<string, number> = {
  very_high: 100_000,
  high:       25_000,
  medium:      6_000,
  low:             0,
};
function volLevelToSaves(level: string | null | undefined): number {
  return VOL_LEVEL_SAVES[level?.toLowerCase() ?? ""] ?? 0;
}

interface RawOppRow {
  total_source_saves?: number | null;
  linked_pins_count?: number | null;
  linked_products_count?: number | null;
  pct_growth_yoy?: number | null;
  weekly_change?: number | null;
}

interface RawPin {
  id: string;
  image_url: string;
  title: string | null;
  category: string;
  pin_id: string | null;
  save_count?: number | null;
  save_velocity?: number | null;
  days_since_creation?: number | null;
}

interface RawProduct {
  id: string;
  product_name: string;
  image_url?: string | null;
  domain?: string | null;
  price?: number | null;
  save_count?: number | null;
  source_pin_save_count?: number | null;
  seed_keyword?: string | null;
}

// ── Mapping functions ──────────────────────────────────────────────────────────

// DB fields: total_source_saves → saves, linked_pins_count → pin_count,
//            linked_products_count → linked_products, pct_growth_yoy → yoy_growth
export function mapKeywordToOpportunity(
  kw: RawKeyword,
  opp?: RawOppRow | null,
): KeywordOpportunity {
  const rawSaves        = opp?.total_source_saves     ?? 0;
  // When no save data exists yet, use search_volume_level as demand proxy
  const saves           = rawSaves > 0 ? rawSaves : volLevelToSaves(kw.search_volume_level);
  const pin_count       = opp?.linked_pins_count      ?? 0;
  const linked_products = opp?.linked_products_count  ?? 0;
  const yoy_growth      = opp?.pct_growth_yoy         ?? kw.yearly_change  ?? 0;
  const weekly_change   = opp?.weekly_change           ?? kw.weekly_change  ?? 0;

  return {
    id: kw.id,
    keyword: kw.keyword,
    category: kw.category,
    saves,
    pin_count,
    linked_products,
    yoy_growth,
    weekly_change,
    meta: assessKeyword({ saves, pin_count, linked_products, yoy_growth, weekly_change }),
  };
}

// DB fields: save_count → save_count, save_velocity → velocity,
//            days_since_creation → age_days
export function mapPinToOpportunity(pin: RawPin): PinOpportunity {
  const save_count = pin.save_count ?? 0;
  const velocity   = pin.save_velocity ?? 0;
  const age_days   = pin.days_since_creation ?? 30;

  return {
    id: pin.id,
    image_url: pin.image_url,
    title: pin.title,
    category: pin.category,
    pin_id: pin.pin_id,
    save_count,
    velocity,
    age_days,
    meta: assessPin({ save_count, velocity, age_days }),
  };
}

// DB fields: save_count → save_count, source_pin_save_count → source_pin_save_count
//            keywordGrowth → linked_keyword_growth (pass yoy from seed keyword if known)
export function mapProductToOpportunity(
  prod: RawProduct,
  keywordGrowth = 0,
): ProductOpportunity {
  const save_count            = prod.save_count            ?? 0;
  const source_pin_save_count = prod.source_pin_save_count ?? 0;

  return {
    id: prod.id,
    product_name: prod.product_name,
    image_url: prod.image_url ?? null,
    domain: prod.domain ?? null,
    price: prod.price ?? null,
    seed_keyword: prod.seed_keyword ?? null,
    save_count,
    source_pin_save_count,
    linked_keyword_growth: keywordGrowth,
    meta: assessProduct({ save_count, source_pin_save_count, linked_keyword_growth: keywordGrowth }),
  };
}
