// Workspace-level static maps — tier metadata, monetize hints, title templates.
// Single source of truth for WorkspaceOpportunityCard, WeeklyPlanModal, Plan page.

export type WorkspaceTier = "blue_ocean" | "early_trend" | "hot_red_sea";

export const TIER_META: Record<WorkspaceTier, { label: string; color: string; bg: string }> = {
  blue_ocean:  { label: "BLUE OCEAN",  color: "#0891B2", bg: "rgba(8,145,178,0.09)"  },
  early_trend: { label: "EARLY TREND", color: "#059669", bg: "rgba(5,150,105,0.07)"  },
  hot_red_sea: { label: "HOT RED SEA", color: "#DC2626", bg: "rgba(220,38,38,0.07)"  },
};

// Maps category id (from CATEGORIES) → one-line monetize hint shown in card
export const MONETIZE_HINTS: Record<string, string> = {
  "home-decor":          "Affiliate (Wayfair, Amazon) · Printable wall art · Shopify dropship",
  "fashion":             "Amazon Fashion affiliate · Etsy vintage · LTK links",
  "womens-fashion":      "Amazon Fashion affiliate · Etsy · LTK links",
  "mens-fashion":        "Amazon Fashion affiliate · brand collabs",
  "kids-fashion":        "Amazon affiliate · Etsy handmade · gift guides",
  "beauty":              "Amazon Beauty affiliate · Etsy handmade · digital guides",
  "wedding":             "Etsy shop · printables · affiliate registries",
  "diy-crafts":          "Etsy digital downloads · Amazon supplies · printable patterns",
  "food-and-drink":      "Amazon Kitchen affiliate · recipe ebook · Etsy prints",
  "digital-products":    "Gumroad · Etsy digital · Ko-fi",
  "art":                 "Printable art · Etsy originals · print-on-demand",
  "health":              "Amazon health affiliate · digital guides · coaching",
  "gardening":           "Amazon gardening affiliate · printable planners · Etsy seeds",
  "parenting":           "Amazon affiliate · Etsy nursery · digital resources",
  "holidays-seasonal":   "Etsy seasonal · printables · affiliate gift guides",
  "event-planning":      "Etsy printables · affiliate décor · digital invites",
  "quotes":              "POD (Redbubble/Printify) · Etsy digital · wall art prints",
  "travel":              "Affiliate (Booking, Hotels) · travel guides · Etsy maps",
  "default":             "Affiliate links · Etsy shop · digital products",
};

// Lookup with fallback to default
export function getMonetizeHint(category: string): string {
  return MONETIZE_HINTS[category] ?? MONETIZE_HINTS.default;
}

// Static title templates per keyword — empty by default, v2 reads from prompt_templates table.
// buildTitleTemplates() generates fallbacks dynamically.
export const TITLE_TEMPLATES: Record<string, string[]> = {};

export function buildTitleTemplates(keyword: string): string[] {
  const kw = keyword.charAt(0).toUpperCase() + keyword.slice(1);
  return [
    `10 ${kw} Ideas You'll Want to Save`,
    `The Best ${kw} Inspiration for 2026`,
    `${kw}: Ideas That Actually Work`,
  ];
}

export function getTitleTemplates(keyword: string): string[] {
  return TITLE_TEMPLATES[keyword] ?? buildTitleTemplates(keyword);
}

// Maps score_tier from trend_opportunities_view → WorkspaceTier
export function scoreTierToWorkspaceTier(tier: string): WorkspaceTier {
  if (tier === "high")   return "blue_ocean";
  if (tier === "medium") return "early_trend";
  return "hot_red_sea";
}

// Maps WorkspaceTier → PrimaryBadge (for Weekly Plan, Create Pin, etc.)
export function workspaceTierToPrimaryBadge(tier: WorkspaceTier | string): PrimaryBadge {
  if (tier === "blue_ocean")  return "best_bet";
  if (tier === "early_trend") return "steady";
  return "competitive";
}

// ── Score breakdown (4 dimensions) ────────────────────────────────────────

export type ScoreBreakdown = {
  demand:       number; // 0-100  search volume × saves
  momentum:     number; // 0-100  velocity × freshness × YoY
  monetization: number; // 0-100  linked products × category potential
  saturation:   number; // 0-100  lower = less crowded = better
};

export function getScoreBreakdown(item: {
  avg_velocity_score:    number | null;
  avg_freshness_score:   number | null;
  pct_growth_yoy:        number | null;
  linked_products_count: number;
  linked_pins_count:     number;
  total_source_saves:    number;
  search_volume_level:   string | null;
}): ScoreBreakdown {
  const volScore  = item.search_volume_level === "high" ? 85
    : item.search_volume_level === "medium" ? 58 : 32;
  const savesNorm = Math.min(100, (item.total_source_saves / 400) * 100);
  const demand    = Math.round(volScore * 0.6 + savesNorm * 0.4);

  const vel      = item.avg_velocity_score  ?? 50;
  const fresh    = item.avg_freshness_score ?? 50;
  const yoyNorm  = Math.min(100, Math.max(0, 50 + (item.pct_growth_yoy ?? 0) / 4));
  const momentum = Math.round(vel * 0.5 + fresh * 0.3 + yoyNorm * 0.2);

  const prodNorm     = Math.min(100, (item.linked_products_count / 15) * 100);
  const monetization = Math.round(Math.max(25, prodNorm));

  const saturation = Math.min(100, Math.round((item.linked_pins_count / 150) * 100));

  return { demand, momentum, monetization, saturation };
}

// ── Primary opportunity badge ──────────────────────────────────────────────
// Research thresholds: Best Bet ≥75, Steady 55–74, Competitive <55
// Falls back to internal tier when opportunity_score is null (pipeline not run yet).

export type PrimaryBadge = "best_bet" | "steady" | "competitive";

export const PRIMARY_BADGE_META: Record<PrimaryBadge, {
  label: string; color: string; bg: string; description: string;
}> = {
  best_bet:    {
    label: "Best Bet",
    color: "#16A34A", bg: "rgba(22,163,74,0.09)",
    description: "Strong Pinterest interest and good room to win this week.",
  },
  steady:      {
    label: "Steady",
    color: "#2563EB", bg: "rgba(37,99,235,0.08)",
    description: "Reliable demand and a solid fit for your weekly plan.",
  },
  competitive: {
    label: "Competitive",
    color: "#D97706", bg: "rgba(217,119,6,0.09)",
    description: "Demand is real, but you'll need a stronger angle to stand out.",
  },
};

export function getPrimaryBadge(item: {
  opportunity_score: number | null;
  tier: WorkspaceTier;
}): PrimaryBadge {
  const score = item.opportunity_score;
  if (score != null) {
    if (score >= 75) return "best_bet";
    if (score >= 55) return "steady";
    return "competitive";
  }
  // No product pipeline score yet — derive from view tier
  if (item.tier === "blue_ocean")  return "best_bet";
  if (item.tier === "early_trend") return "steady";
  return "competitive";
}

// ── Trend state chip ───────────────────────────────────────────────────────
// Rising is fully derivable from current data.
// Evergreen is the default for stable non-accelerating keywords.
// Seasonal requires 12-month history data — reserved for a later pipeline phase.

export type TrendStateChip = "rising" | "evergreen" | "seasonal";

export const TREND_CHIP_META: Record<TrendStateChip, { label: string; color: string; description: string }> = {
  rising:    {
    label: "Rising",
    color: "#059669",
    description: "Searches and saves are accelerating now.",
  },
  evergreen: {
    label: "Evergreen",
    color: "#0284C7",
    description: "Consistent demand over time, not dependent on a short spike.",
  },
  seasonal:  {
    label: "Seasonal",
    color: "#9333EA",
    description: "A recurring opportunity where timing matters.",
  },
};

export function getTrendStateChip(item: {
  pct_growth_yoy:  number | null;
  weekly_change:   number | null;
  trend_lifecycle?: string | null;
}): TrendStateChip {
  // Use backend-computed lifecycle when available (requires classify_trends.py run)
  if (item.trend_lifecycle === "rising")   return "rising";
  if (item.trend_lifecycle === "seasonal") return "seasonal";
  if (item.trend_lifecycle === "evergreen") return "evergreen";

  // Heuristic fallback when trend_lifecycle is null or 'unclear'
  const yoy    = item.pct_growth_yoy ?? 0;
  const weekly = item.weekly_change  ?? 0;
  if (yoy >= 200) return "rising";
  if (yoy >= 100 && weekly >= 0) return "rising";
  return "evergreen";
}

// ── Why Now sentence ───────────────────────────────────────────────────────

export function getWhyNow(item: {
  pct_growth_yoy:      number | null;
  avg_velocity_score:  number | null;
  avg_freshness_score: number | null;
  score_tier:          string;
  search_volume_level: string | null;
  linked_pins_count:   number;
  opportunity_score?:  number | null;
  weekly_change?:      number | null;
  trend_lifecycle?:    string | null;
}): string {
  const badge = getPrimaryBadge({
    opportunity_score: item.opportunity_score ?? null,
    tier: scoreTierToWorkspaceTier(item.score_tier),
  });
  const chip = getTrendStateChip({
    pct_growth_yoy:  item.pct_growth_yoy,
    weekly_change:   item.weekly_change ?? null,
    trend_lifecycle: item.trend_lifecycle ?? null,
  });
  const pins = item.linked_pins_count;
  const vol  = item.search_volume_level;
  const yoy  = item.pct_growth_yoy ?? 0;

  if (chip === "seasonal") {
    return badge === "best_bet"
      ? "Peak season is approaching — strong recurring demand with good room to win."
      : badge === "steady"
        ? "Seasonal opportunity with reliable recurring demand — plan content now."
        : "Seasonal demand is real, but expect more competition during the peak window.";
  }
  if (badge === "best_bet" && chip === "rising") {
    return pins <= 30
      ? "Searches and saves are accelerating, and similar Pins are still not crowded."
      : "Strong growth and high save velocity — a well-timed opportunity.";
  }
  if (badge === "best_bet" && chip === "evergreen") {
    return (vol === "very_high" || vol === "high")
      ? "Reliable demand year-round with high search volume and product signal."
      : "Reliable demand and a solid fit for your weekly plan.";
  }
  if (badge === "steady" && chip === "rising") {
    return yoy >= 100
      ? `Up ${Math.round(yoy)}% year-over-year — rising interest with room to grow.`
      : "Interest is building — good window to get in before it peaks.";
  }
  if (badge === "steady" && chip === "evergreen") {
    return (vol === "very_high" || vol === "high")
      ? "Consistent high-volume demand — a dependable evergreen slot."
      : "Steady interest over time, not dependent on a short spike.";
  }
  if (badge === "competitive") {
    return pins > 100
      ? "High demand, but this space is crowded — lean into a specific niche angle."
      : "Demand is real, but you'll need a stronger angle to stand out.";
  }
  return "Consistent performer with steady engagement.";
}

// ── Monetization paths ─────────────────────────────────────────────────────

export type MonetizationPath =
  | "Affiliate" | "Etsy" | "Shopify" | "Digital Product"
  | "Printable" | "POD" | "Coaching" | "LTK";

const MONETIZATION_PATHS_MAP: Record<string, MonetizationPath[]> = {
  "home-decor":          ["Affiliate", "Printable", "Shopify"],
  "fashion":             ["Affiliate", "LTK", "Etsy"],
  "womens-fashion":      ["Affiliate", "LTK", "Etsy"],
  "mens-fashion":        ["Affiliate", "Shopify"],
  "kids-fashion":        ["Affiliate", "Etsy", "Printable"],
  "beauty":              ["Affiliate", "Etsy", "Digital Product"],
  "wedding":             ["Etsy", "Printable", "Affiliate"],
  "diy-crafts":          ["Etsy", "Printable", "Affiliate"],
  "food-and-drink":      ["Affiliate", "Digital Product", "Etsy"],
  "digital-products":    ["Digital Product", "Etsy", "Shopify"],
  "art":                 ["POD", "Etsy", "Printable"],
  "health":              ["Affiliate", "Digital Product", "Coaching"],
  "gardening":           ["Affiliate", "Etsy", "Printable"],
  "parenting":           ["Affiliate", "Etsy", "Digital Product"],
  "holidays-seasonal":   ["Etsy", "Printable", "Affiliate"],
  "event-planning":      ["Etsy", "Printable", "Affiliate"],
  "quotes":              ["POD", "Etsy", "Printable"],
  "travel":              ["Affiliate", "Digital Product", "Etsy"],
};

export function getMonetizationPaths(category: string): MonetizationPath[] {
  return MONETIZATION_PATHS_MAP[category] ?? ["Affiliate", "Etsy", "Digital Product"];
}

// ── Content type suggestions ───────────────────────────────────────────────

export type ContentType =
  | "Gift Guide" | "How-to" | "Roundup" | "Moodboard"
  | "Product Spotlight" | "Tutorial" | "Before/After";

const CONTENT_TYPE_MAP: Record<string, ContentType[]> = {
  "home-decor":          ["Moodboard", "Roundup", "Product Spotlight"],
  "fashion":             ["Moodboard", "Roundup", "Gift Guide"],
  "womens-fashion":      ["Moodboard", "Roundup", "Gift Guide"],
  "mens-fashion":        ["Roundup", "Product Spotlight", "Gift Guide"],
  "kids-fashion":        ["Roundup", "Gift Guide", "Moodboard"],
  "beauty":              ["How-to", "Roundup", "Tutorial"],
  "wedding":             ["Moodboard", "How-to", "Gift Guide"],
  "diy-crafts":          ["How-to", "Tutorial", "Before/After"],
  "food-and-drink":      ["How-to", "Roundup", "Gift Guide"],
  "digital-products":    ["Product Spotlight", "How-to", "Roundup"],
  "art":                 ["Roundup", "Moodboard", "Product Spotlight"],
  "health":              ["How-to", "Roundup", "Tutorial"],
  "gardening":           ["How-to", "Before/After", "Roundup"],
  "parenting":           ["Roundup", "How-to", "Gift Guide"],
  "holidays-seasonal":   ["Gift Guide", "Roundup", "How-to"],
  "event-planning":      ["Moodboard", "How-to", "Roundup"],
  "quotes":              ["Roundup", "Product Spotlight", "Moodboard"],
  "travel":              ["Roundup", "Moodboard", "Gift Guide"],
};

export function getContentTypes(category: string): ContentType[] {
  return CONTENT_TYPE_MAP[category] ?? ["Roundup", "How-to", "Product Spotlight"];
}

// ── Visual direction ───────────────────────────────────────────────────────

const VISUAL_DIRECTIONS: Record<string, string> = {
  "home-decor":          "Styled room shot or flat lay · neutral/warm palette · soft natural light",
  "fashion":             "Clean background or lifestyle shot · warm tones · outfit flat lay",
  "womens-fashion":      "Lifestyle or flat lay · pastel or neutral tones",
  "mens-fashion":        "Minimal lifestyle shot · muted tones · clean composition",
  "kids-fashion":        "Bright, cheerful · natural light · lifestyle with kids",
  "beauty":              "Close-up product shot · pastel flat lay · bright & clean",
  "diy-crafts":          "Step-by-step or before/after · bright natural light · process detail",
  "food-and-drink":      "Overhead flat lay or close-up · warm food tones · minimal props",
  "wedding":             "Romantic soft tones · florals · white/blush palette",
  "gardening":           "Bright outdoor shot · lush greens · natural setting",
  "health":              "Clean minimal aesthetic · soft greens or whites",
  "digital-products":    "Mockup on screen or tablet · clean minimal background",
  "art":                 "Product on white or minimal wall · gallery-style display",
  "parenting":           "Warm, cheerful · natural light · lifestyle with children",
  "travel":              "Scenic shot · vibrant colors · destination landmark",
  "holidays-seasonal":   "Festive styling · rich seasonal colors · cozy setting",
  "event-planning":      "Elegant detail shot · styled tablescape · soft focus",
  "quotes":              "Typography on clean background · complementary color palette",
  "architecture":        "Wide-angle exterior or interior · golden hour light",
  "design":              "Flat lay tools or finished work · clean minimal background",
};

export function getVisualDirection(category: string): string {
  return VISUAL_DIRECTIONS[category]
    ?? "Clean, well-lit composition · relevant lifestyle context";
}

// ── Description angle ──────────────────────────────────────────────────────

export function getDescriptionAngle(
  keyword: string,
  category: string,
  tier: WorkspaceTier,
  monPaths: MonetizationPath[],
): string {
  const tierLabel = tier === "blue_ocean"  ? "blue-ocean opportunity"
    : tier === "early_trend" ? "early-trend keyword"
    : "high-demand keyword";
  const earn = monPaths.slice(0, 2).join(" and ");
  const kw = keyword.charAt(0).toUpperCase() + keyword.slice(1);
  return `${kw} is a ${tierLabel} in ${category.replace(/-/g, " ")}. Lead with aspirational, high-quality imagery. Drive saves with clear value. Earn via ${earn}.`;
}

// ── CTA suggestion ─────────────────────────────────────────────────────────

const CTA_MAP: Partial<Record<ContentType, string>> = {
  "Gift Guide":        "Add affiliate links in bio · tag products in pin",
  "How-to":           "Link to blog post or YouTube tutorial",
  "Roundup":          "Link to your collection page or blog roundup",
  "Moodboard":        "Link to shop, Etsy listing, or lookbook",
  "Product Spotlight": "Direct link to product page or Etsy listing",
  "Tutorial":         "Link to full tutorial (blog / YouTube)",
  "Before/After":     "Link to service page, blog post, or case study",
};

export function getCTASuggestion(contentType: ContentType): string {
  return CTA_MAP[contentType] ?? "Add relevant link in bio or use Pinterest link sticker";
}
