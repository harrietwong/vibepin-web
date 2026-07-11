// Canonical category list — matches trend_keywords.category and pin_samples.category in DB.
// Single source of truth used by Trend Radar, Viral Pins, Shop Signals, and Workspace.

/**
 * Readiness thresholds:
 *   ready:  50+ opportunities, 300+ pin samples (save_count ≥ 100), 80+ products
 *   beta:   20+ opportunities, 100+ pin samples,                     20+ products
 *   soon:   in pipeline, not yet at beta threshold
 *   hidden: not enough data, not surfaced to users
 */
export type CategoryStatus = "ready" | "beta" | "soon" | "hidden";

export type CategoryDef = {
  id:     string;   // exact DB value
  label:  string;
  emoji:  string;
  status: CategoryStatus;
  default?: boolean;
  // Optional readiness metadata (populated when known)
  opportunity_count?: number;
  pin_count?:         number;
  product_count?:     number;
};

export const CATEGORIES: CategoryDef[] = [
  // ── Ready (full signal coverage) ───────────────────────────────────────────
  { id: "home-decor",         label: "Home Decor",       emoji: "🏠", status: "ready", default: true,
    opportunity_count: 48, pin_count: 310, product_count: 95 },

  // ── Beta (signals still expanding) ─────────────────────────────────────────
  { id: "fashion",            label: "Fashion",          emoji: "👗", status: "beta" },
  { id: "beauty",             label: "Beauty",           emoji: "💄", status: "beta" },
  { id: "wedding",            label: "Wedding",          emoji: "💒", status: "beta" },
  { id: "diy-crafts",         label: "DIY & Crafts",     emoji: "✂️", status: "beta" },
  { id: "food-and-drink",     label: "Food & Drink",     emoji: "🍽️", status: "beta" },
  { id: "digital-products",   label: "Digital Products", emoji: "🖥️", status: "beta" },

  // ── Coming Soon ─────────────────────────────────────────────────────────────
  { id: "travel",             label: "Travel",           emoji: "✈️", status: "soon" },
  { id: "gardening",          label: "Gardening",        emoji: "🌱", status: "soon" },
  { id: "parenting",          label: "Parenting",        emoji: "👶", status: "soon" },
  { id: "education",          label: "Education",        emoji: "📚", status: "soon" },
  { id: "holidays-seasonal",  label: "Holidays",         emoji: "🎄", status: "soon" },

  // ── Hidden (not surfaced to users) ─────────────────────────────────────────
  { id: "art",                label: "Art",              emoji: "🎨", status: "hidden" },
  { id: "womens-fashion",     label: "Women's Fashion",  emoji: "👗", status: "hidden" },
  { id: "mens-fashion",       label: "Men's Fashion",    emoji: "👔", status: "hidden" },
  { id: "kids-fashion",       label: "Kids Fashion",     emoji: "🧒", status: "hidden" },
  { id: "health",             label: "Health",           emoji: "💊", status: "hidden" },
  { id: "event-planning",     label: "Events",           emoji: "🎉", status: "hidden" },
  { id: "quotes",             label: "Quotes",           emoji: "💬", status: "hidden" },
  { id: "architecture",       label: "Architecture",     emoji: "🏗️", status: "hidden" },
  { id: "design",             label: "Design",           emoji: "🖌️", status: "hidden" },
  { id: "finance",            label: "Finance",          emoji: "💰", status: "hidden" },
  { id: "sports",             label: "Sports",           emoji: "⚽", status: "hidden" },
  { id: "automotive",         label: "Automotive",       emoji: "🚗", status: "hidden" },
  { id: "electronics",        label: "Electronics",      emoji: "💻", status: "hidden" },
  { id: "entertainment",      label: "Entertainment",    emoji: "🎬", status: "hidden" },
  { id: "animals",            label: "Animals",          emoji: "🐾", status: "hidden" },
];

export const CAT_MAP: Record<string, CategoryDef> = Object.fromEntries(
  CATEGORIES.map(c => [c.id, c]),
);

// Filtered views by status
export const READY_CATEGORIES = CATEGORIES.filter(c => c.status === "ready");
export const BETA_CATEGORIES  = CATEGORIES.filter(c => c.status === "beta");
export const SOON_CATEGORIES  = CATEGORIES.filter(c => c.status === "soon");
// Workspace-accessible = ready + beta
export const ACTIVE_CATEGORIES = CATEGORIES.filter(c => c.status === "ready" || c.status === "beta");

// Default category for new users / fallback
export const DEFAULT_CATEGORY = CATEGORIES.find(c => c.default)?.id ?? "home-decor";

/** Keyword Trends — "Content" opportunity focus (non-product intent). */
export const CONTENT_OPPORTUNITY_CATEGORIES = [
  "quotes", "entertainment", "education", "parenting",
  "wedding", "event-planning", "health", "travel",
] as const;

export function getCategoryStatus(id: string): CategoryStatus {
  return CAT_MAP[id]?.status ?? "hidden";
}

export function isCategoryReady(id: string): boolean {
  const s = getCategoryStatus(id);
  return s === "ready" || s === "beta";
}

export function catEmoji(id: string): string {
  return CAT_MAP[id]?.emoji ?? "📌";
}

export function catLabel(id: string): string {
  return CAT_MAP[id]?.label ?? id;
}

// Maps URL slug → DB category value when they differ.
export const CATEGORY_DB_MAP: Record<string, string> = {
  // e.g. "womens-fashion": "womens_fashion",
};

export function getDbCategory(slug: string): string {
  return CATEGORY_DB_MAP[slug] ?? slug;
}

// Parent → sub-category aliases from Pinterest's taxonomy.
// Clicking a parent filter should also surface products tagged under its sub-categories.
export const CATEGORY_CHILDREN: Record<string, string[]> = {
  "fashion": ["womens-fashion", "mens-fashion", "kids-fashion"],
};

/** Returns all DB category values that should match when the user selects `id`. */
export function getCategoryMatchSet(id: string): Set<string> {
  return new Set([id, ...(CATEGORY_CHILDREN[id] ?? [])]);
}
