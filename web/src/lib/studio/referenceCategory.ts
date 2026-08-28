/**
 * referenceCategory.ts — one canonical name for the four P0 reference categories.
 *
 * Category strings reach the recommender from three unaligned sources: the product
 * record (`womens-fashion`, `home-decor`, …), the vision analysis (free-form:
 * `lifestyle`, `jewelry`, `nails`, `printables`, …) and keyword text inference.
 * Scoring only knows the four P0 buckets, so anything else silently degraded into a
 * category fallback. This maps every known synonym onto a single canonical bucket and
 * tells the caller which DB `category` values to query for it.
 *
 * `dbCategories` is a function of the CANONICAL, not of the raw token: the fashion
 * pool is physically split across `fashion` and `womens-fashion` rows, so every input
 * that canonicalizes to fashion must read both. Pure, dependency-free.
 */

export type P0Canonical = "fashion" | "home-decor" | "beauty" | "digital-products";

/** DB `category` values to query for each canonical bucket (fashion is a merged pool). */
const DB_CATEGORIES: Record<P0Canonical, string[]> = {
  "fashion":           ["fashion", "womens-fashion"],
  "home-decor":        ["home-decor"],
  "beauty":            ["beauty"],
  "digital-products":  ["digital-products"],
};

/** Synonym → canonical. Keys are already normalized (lowercase, hyphen-separated). */
const SYNONYMS: Record<string, P0Canonical> = {
  // the four P0 names map to themselves
  "fashion":            "fashion",
  "home-decor":         "home-decor",
  "beauty":             "beauty",
  "digital-products":   "digital-products",
  // merged fashion pool
  "womens-fashion":     "fashion",
  // home / interiors
  "lifestyle":          "home-decor",
  "kitchen":            "home-decor",
  "furniture":          "home-decor",
  "garden":             "home-decor",
  "living-room":        "home-decor",
  "bedroom":            "home-decor",
  "home":               "home-decor",
  "interior":           "home-decor",
  "home-decoration":    "home-decor",
  // apparel / accessories
  "jewelry":            "fashion",
  "jewellery":          "fashion",
  "accessories":        "fashion",
  "shoes":              "fashion",
  "bags":               "fashion",
  "mens-fashion":       "fashion",
  "clothing":           "fashion",
  "apparel":            "fashion",
  "outfit":             "fashion",
  "outfits":            "fashion",
  // beauty
  "nails":              "beauty",
  "hair":               "beauty",
  "skincare":           "beauty",
  "makeup":             "beauty",
  "cosmetics":          "beauty",
  "beauty-products":    "beauty",
  // digital / info products
  "marketing":          "digital-products",
  "business":           "digital-products",
  "technology":         "digital-products",
  "education":          "digital-products",
  "printables":         "digital-products",
  "digital":            "digital-products",
  "templates":          "digital-products",
  "digital-marketing":  "digital-products",
  "social-media":       "digital-products",
};

/** lowercase; whitespace and underscores become hyphens; collapse/trim hyphens. */
function normalizeToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve any category-ish string to a P0 bucket plus the DB categories to query.
 * Unknown input is honest: `{ canonical: null, dbCategories: [] }` — the caller
 * decides what to do (round-robin across all four pools), rather than being handed
 * a wrong bucket.
 */
export function canonicalizeCategory(raw?: string | null): { canonical: P0Canonical | null; dbCategories: string[] } {
  if (typeof raw !== "string") return { canonical: null, dbCategories: [] };
  const token = normalizeToken(raw);
  if (!token) return { canonical: null, dbCategories: [] };
  const canonical = SYNONYMS[token];
  if (!canonical) return { canonical: null, dbCategories: [] };
  return { canonical, dbCategories: [...DB_CATEGORIES[canonical]] };
}
