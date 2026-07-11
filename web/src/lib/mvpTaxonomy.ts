// mvpTaxonomy.ts — Shared, presentation-layer taxonomy normalization for the MVP.
//
// SINGLE SOURCE OF TRUTH for how raw DB category slugs and raw platform values are
// normalized for DISPLAY and FILTERING in two DIFFERENT features:
//
//   • Pin Images (Pin Ideas / Viral Pins)  = UPSTREAM Pinterest demand-signal pool
//                                             (source: pin_samples).
//   • Product Opportunity                   = DOWNSTREAM product-opportunity pool
//                                             (source: pin_products).
//
// Both features use the SAME normalized taxonomy IDs/labels (so "Fashion" means the
// same thing everywhere), but they DO NOT expose the same visible filter list:
//   - Product Opportunity shows only categories that clear clean-product thresholds.
//   - Pin Images shows categories that clear source-pin thresholds, and additionally
//     hides clearly non-commerce categories by default.
//
// IMPORTANT — this is DISPLAY-ONLY normalization. It NEVER rewrites raw DB values.
// No migration, no schema change, no DB mass rewrite. Raw slugs stay in the DB; this
// module only decides how they are grouped, labeled, and shown in the UI.
//
// Visible sets below are derived from a live read-only DB audit (2026-07-05, after
// the source_pin_url backfill + unknown-category recovery). Counts are cited inline
// so the thresholds are auditable; they are stable config, not a live query.

// ── Thresholds ────────────────────────────────────────────────────────────────
export const PRODUCT_P0_MIN = 60; // clean product rows to be a prominent (P0) product category
export const PRODUCT_P1_MIN = 30; // clean product rows to be a secondary (P1) product category
export const PIN_P0_MIN = 180;    // source pins for a healthy (P0) pin category
export const PIN_P1_MIN = 90;     // source pins for a beta (P1) pin category
export const PLATFORM_SHOW_MIN = 25;   // clean product rows to show a platform on its own
export const PLATFORM_OTHER_MIN = 10;  // 10–24 clean rows → merged into "Other"
export const PLATFORM_OTHER_BUCKET_MIN = 30; // show the combined "Other" bucket only if ≥ this

// ── Normalized category taxonomy ────────────────────────────────────────────────
// Canonical labels shared by BOTH features. Raw DB slugs map into these labels.
export type NormalizedCategory =
  | "Digital Products"
  | "Home Decor"
  | "Fashion"
  | "Beauty & Wellness"
  | "DIY & Crafts"
  | "Kids & Parenting"
  | "Kitchen & Dining"
  | "Wedding"
  | "Gardening"
  | "Electronics";

// Emoji per normalized category (UI affordance only).
export const NORMALIZED_CATEGORY_EMOJI: Record<NormalizedCategory, string> = {
  "Digital Products": "🖥️",
  "Home Decor":       "🏠",
  "Fashion":          "👗",
  "Beauty & Wellness":"💄",
  "DIY & Crafts":     "✂️",
  "Kids & Parenting": "🧒",
  "Kitchen & Dining": "🍽️",
  "Wedding":          "💒",
  "Gardening":        "🌱",
  "Electronics":      "💻",
};

// A sentinel meaning "not surfaced to users for MVP".
export const HIDDEN = null;

// "art" is special: hidden as a standalone category, UNLESS the row is clearly a
// digital product (then it rolls into Digital Products). Handled at row level.
const ART_SLUG = "art";

// Raw DB slug → normalized label (or HIDDEN). Slugs are lowercased, "_"/space → "-".
// Any slug not present here is HIDDEN by default (fail-closed for the MVP UI).
const RAW_TO_NORMALIZED: Record<string, NormalizedCategory | null> = {
  "digital-products": "Digital Products",

  "home-decor": "Home Decor",
  "home":       "Home Decor",

  "fashion":         "Fashion",
  "womens-fashion":  "Fashion",
  "women's-fashion": "Fashion",
  "mens-fashion":    "Fashion",
  "men's-fashion":   "Fashion",

  "kids-fashion": "Kids & Parenting",
  "parenting":    "Kids & Parenting",
  "education":    "Kids & Parenting",

  "beauty": "Beauty & Wellness",
  "health": "Beauty & Wellness",

  "diy-crafts": "DIY & Crafts",
  "diy":        "DIY & Crafts",

  "food-and-drink": "Kitchen & Dining",
  "food":           "Kitchen & Dining",

  "wedding":        "Wedding",
  "event-planning": "Wedding",
  "events":         "Wedding",

  "gardening": "Gardening",

  "electronics": "Electronics",

  // Explicitly hidden for MVP (non-commerce / no-conversion / low value).
  "holidays-seasonal": HIDDEN,
  "travel":            HIDDEN,
  "quotes":            HIDDEN,
  "architecture":      HIDDEN,
  "design":            HIDDEN,
  "finance":           HIDDEN,
  "sports":            HIDDEN,
  "sport":             HIDDEN,
  "automotive":        HIDDEN,
  "entertainment":     HIDDEN,
  "animals":           HIDDEN,
  "unknown":           HIDDEN,
  // "art" intentionally omitted — handled by the ART_SLUG special case.
};

/** Normalize a raw category slug to canonical form (lowercase, "_"/space → "-"). */
export function normalizeCategorySlug(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  return String(raw).trim().toLowerCase().replace(/[_\s]+/g, "-") || "unknown";
}

export type ProductClassHint = "physical" | "digital" | undefined;

/**
 * Map a raw category slug → normalized category label, or HIDDEN (null).
 *
 * `productType` only matters for the "art" special case: art rows that are clearly
 * digital roll into Digital Products; otherwise art is hidden. Pin rows (no product
 * type) therefore always hide art.
 */
export function normalizeCategoryLabel(
  raw: string | null | undefined,
  productType: ProductClassHint = undefined,
): NormalizedCategory | null {
  const slug = normalizeCategorySlug(raw);
  if (slug === ART_SLUG) {
    return productType === "digital" ? "Digital Products" : HIDDEN;
  }
  // `undefined` means "slug not in map" → hidden; explicit `null` also → hidden.
  return RAW_TO_NORMALIZED[slug] ?? HIDDEN;
}

// Inverse map: normalized label → the raw slugs that feed it (excludes the special
// "art" slug, which is row-conditional and must not be matched at slug level).
const NORMALIZED_TO_RAW: Record<NormalizedCategory, string[]> = (() => {
  const out = {} as Record<NormalizedCategory, string[]>;
  for (const [slug, label] of Object.entries(RAW_TO_NORMALIZED)) {
    if (label == null) continue;
    (out[label] ??= []).push(slug);
  }
  return out;
})();

/** Raw DB slugs that should match when the user selects a normalized category. */
export function categoryMatchSlugs(label: NormalizedCategory): string[] {
  return NORMALIZED_TO_RAW[label] ?? [];
}

// ── Visible category sets (from the 2026-07-05 audit) ───────────────────────────
// Product Opportunity — clean product rows per normalized category:
//   Digital Products 1510 (P0), Home Decor 391 (P0), Fashion 311 (P0),
//   Beauty & Wellness 249 (P0), DIY & Crafts 123 (P0), Gardening 50 (P1),
//   Kids & Parenting 23, Wedding 18, Kitchen & Dining 5, Electronics 3 (all < P1).
export const PRODUCT_VISIBLE_P0: NormalizedCategory[] = [
  "Digital Products",
  "Home Decor",
  "Fashion",
  "Beauty & Wellness",
  "DIY & Crafts",
];
export const PRODUCT_VISIBLE_P1: NormalizedCategory[] = ["Gardening"];
export const PRODUCT_VISIBLE_CATEGORIES: NormalizedCategory[] = [
  ...PRODUCT_VISIBLE_P0,
  ...PRODUCT_VISIBLE_P1,
];

// Pin Images — source pins per normalized category (ALL clear P0 ≥180):
//   Digital Products 3425, Beauty & Wellness 3249, Home Decor 1562, Fashion 1506,
//   Kids & Parenting 983, Wedding 962, DIY & Crafts 740, Kitchen & Dining 478,
//   Electronics 431, Gardening 334. Non-commerce categories (quotes, finance,
//   entertainment, architecture, design, animals, automotive, sports) are already
//   HIDDEN by the taxonomy map, so they never appear regardless of pin depth.
export const PIN_VISIBLE_CATEGORIES: NormalizedCategory[] = [
  "Digital Products",
  "Beauty & Wellness",
  "Home Decor",
  "Fashion",
  "Kids & Parenting",
  "Wedding",
  "DIY & Crafts",
  "Kitchen & Dining",
  "Electronics",
  "Gardening",
];

/** Data-driven visibility: given clean counts, which categories clear a threshold. */
export function computeVisibleCategories(
  counts: Partial<Record<NormalizedCategory, number>>,
  min: number,
): NormalizedCategory[] {
  return (Object.keys(NORMALIZED_CATEGORY_EMOJI) as NormalizedCategory[])
    .filter(c => (counts[c] ?? 0) >= min)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
}

// ── Platform normalization (Product Opportunity only) ───────────────────────────
// Source of truth is the product/source URL domain, NOT the dirty raw source_platform
// label. Social/content domains and invalid fragments are hidden from the platform
// filter. Everything else valid falls into "Other".
export type PlatformResult =
  | { kind: "platform"; label: string }
  | { kind: "other" }
  | { kind: "hidden" };

const SOCIAL_HIDE = new Set([
  "instagram.com", "x.com", "twitter.com", "facebook.com", "tumblr.com",
  "tiktok.com", "youtube.com", "m.youtube.com", "youtu.be", "medium.com",
  "i.pinimg.com", "drive.google.com", "pinterest.com",
]);

// Raw fragments that are parser garbage, never a real platform.
const INVALID_FRAGMENTS = new Set([
  "us", "com", "shop", "www", "store", "sites", "es", "fr", "m", "i",
  "blog", "amp", "edit", "digital", "template", "youtu", "drive", "gdoc",
  "bit", "l8r", "kmy", "vk", "mom",
]);

const DOMAIN_PLATFORM_RULES: { rx: RegExp; label: string }[] = [
  { rx: /(^|\.)etsy\.(com|me)$/,        label: "Etsy" },
  { rx: /(^|\.)amazon\.[a-z.]+$/,       label: "Amazon" },
  { rx: /(^|\.)amzn\.to$/,              label: "Amazon" },
  { rx: /(^|\.)ebay\.[a-z.]+$/,         label: "eBay" },
  { rx: /(^|\.)wayfair\.[a-z.]+$/,      label: "Wayfair" },
  { rx: /(^|\.)poshmark\.com$/,         label: "Poshmark" },
  { rx: /(^|\.)target\.com$/,           label: "Target" },
  { rx: /(^|\.)shein\.[a-z.]+$/,        label: "SHEIN" },
  { rx: /(^|\.)payhip\.com$/,           label: "Payhip" },
  { rx: /(^|\.)teacherspayteachers\.com$/, label: "Teachers Pay Teachers" },
  { rx: /(^|\.)worksheeto\.com$/,       label: "Worksheeto" },
  { rx: /(^|\.)canva\.com$/,            label: "Canva" },
  { rx: /(^|\.)walmart\.com$/,          label: "Walmart" },
  { rx: /(^|\.)nordstrom\.com$/,        label: "Nordstrom" },
];

const RAWLABEL_PLATFORM: Record<string, string> = {
  etsy: "Etsy", amazon: "Amazon", ebay: "eBay", wayfair: "Wayfair",
  poshmark: "Poshmark", target: "Target", shein: "SHEIN", payhip: "Payhip",
  tpt: "Teachers Pay Teachers", worksheeto: "Worksheeto", canva: "Canva",
  walmart: "Walmart", nordstrom: "Nordstrom",
};

/** Extract a bare hostname (no leading www.) from a URL or host string. */
export function hostnameOf(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = String(value).trim().toLowerCase();
  if (host.includes("/") || host.includes(":")) {
    try {
      host = new URL(host.startsWith("http") ? host : `https://${host}`).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, "");
  return host || null;
}

export interface PlatformInput {
  sourceUrl?: string | null;
  canonicalUrl?: string | null;
  domain?: string | null;
  productSourceDomain?: string | null;
  sourcePlatform?: string | null; // dirty raw label — used ONLY as last-resort fallback
}

/** Normalize a product's platform for display/filtering. Domain is source of truth. */
export function normalizePlatform(input: PlatformInput): PlatformResult {
  const host =
    hostnameOf(input.sourceUrl) ||
    hostnameOf(input.canonicalUrl) ||
    hostnameOf(input.productSourceDomain) ||
    hostnameOf(input.domain);

  if (host) {
    if (SOCIAL_HIDE.has(host)) return { kind: "hidden" };
    for (const { rx, label } of DOMAIN_PLATFORM_RULES) {
      if (rx.test(host)) return { kind: "platform", label };
    }
  }

  const raw = (input.sourcePlatform ?? "").trim().toLowerCase();
  if (raw && RAWLABEL_PLATFORM[raw]) return { kind: "platform", label: RAWLABEL_PLATFORM[raw] };
  if (raw && INVALID_FRAGMENTS.has(raw)) return { kind: "hidden" };

  if (host && host.includes(".")) return { kind: "other" }; // valid low-volume commerce domain
  if (raw && !INVALID_FRAGMENTS.has(raw)) return { kind: "other" };
  return { kind: "hidden" };
}

/** Convenience: normalized platform label, or null if hidden. "Other" for the tail. */
export function normalizePlatformLabel(input: PlatformInput): string | null {
  const r = normalizePlatform(input);
  if (r.kind === "hidden") return null;
  if (r.kind === "other") return "Other";
  return r.label;
}

export interface PlatformVisibility {
  /** Platforms to show as their own filter option, most-populous first. */
  visible: string[];
  /** True when the combined "Other" bucket clears its floor and should be shown. */
  showOther: boolean;
  /** Per-platform display counts after applying show/Other/hide rules. */
  counts: Record<string, number>;
}

/**
 * Apply the platform display rules to a set of products:
 *   ≥ PLATFORM_SHOW_MIN (25)      → own filter option
 *   PLATFORM_OTHER_MIN..24 (10-24)→ folded into Other
 *   < PLATFORM_OTHER_MIN (<10)    → folded into Other (still commerce, just tiny)
 *   hidden (social/invalid)       → dropped entirely
 * The combined Other bucket is shown only if it totals ≥ PLATFORM_OTHER_BUCKET_MIN.
 */
export function computeVisiblePlatforms(products: PlatformInput[]): PlatformVisibility {
  const named: Record<string, number> = {};
  let otherTotal = 0;
  for (const p of products) {
    const r = normalizePlatform(p);
    if (r.kind === "hidden") continue;
    if (r.kind === "other") { otherTotal += 1; continue; }
    named[r.label] = (named[r.label] ?? 0) + 1;
  }
  // Platforms below the show floor fold into Other.
  const visible: string[] = [];
  for (const [label, n] of Object.entries(named)) {
    if (n >= PLATFORM_SHOW_MIN) visible.push(label);
    else otherTotal += n;
  }
  visible.sort((a, b) => named[b] - named[a]);
  const counts: Record<string, number> = {};
  for (const label of visible) counts[label] = named[label];
  const showOther = otherTotal >= PLATFORM_OTHER_BUCKET_MIN;
  if (showOther) counts["Other"] = otherTotal;
  return { visible, showOther, counts };
}
