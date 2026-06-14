"use client";

/**
 * Centralized landing-page asset source.
 *
 * RULE: the landing page must NOT use external stock images (Unsplash/Pexels/etc.).
 * All photographic assets come from real VibePin data via the existing public APIs:
 *   - pin_samples       → /api/viral-pins      (Pin Ideas / references)
 *   - pin_products      → /api/products/top    (Product Opportunities)
 * When real assets are unavailable, callers fall back to dark placeholder tiles.
 */

import { useEffect, useState } from "react";

export type SourceType =
  | "pin_sample"
  | "product_opportunity"
  | "my_product"
  | "generated_pin"
  | "local_asset"
  | "placeholder_avatar"
  | "placeholder";

export interface LandingAsset {
  id: string;
  imageUrl: string | null; // null ⇒ render a placeholder tile
  title: string;
  category: string;
  sourceType: SourceType;
  url?: string;
  price?: string | null;
  score?: number | null;
}

const norm = (s?: string | null) => (s ?? "").toLowerCase();

/** Map raw seed keyword / category to a landing-page category bucket. */
export function bucketCategory(raw?: string | null): string {
  const c = norm(raw);
  if (/home|decor|interior|room|living|bedroom|kitchen|shelf|wall/.test(c)) return "Home Decor";
  if (/fashion|outfit|style|wardrobe|clothing|jewel|earring|dress/.test(c)) return "Fashion";
  if (/beauty|skin|makeup|nail|hair|serum|glow/.test(c)) return "Beauty";
  if (/food|drink|recipe|coffee|matcha|dinner|cook/.test(c)) return "Food & Drink";
  if (/digital|printable|template|notion|planner|canva|download/.test(c)) return "Digital Products";
  return "Other";
}

interface ApiPin { id: string; image_url: string; category?: string | null; title?: string | null; source_url?: string | null; outbound_link?: string | null; }
interface ApiProduct { id: string; image_url: string; product_name?: string | null; seed_keyword?: string | null; price?: number | null; currency?: string | null; source_url?: string | null; opportunity_score?: number | null; }

export function useLandingAssets() {
  const [pinSamples, setPinSamples] = useState<LandingAsset[]>([]);
  const [products, setProducts] = useState<LandingAsset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [pinsRes, prodRes] = await Promise.allSettled([
          fetch("/api/viral-pins?limit=60").then(r => (r.ok ? r.json() : null)),
          fetch("/api/products/top?limit=60&sort=opportunity").then(r => (r.ok ? r.json() : null)),
        ]);
        if (!alive) return;

        if (pinsRes.status === "fulfilled" && pinsRes.value) {
          const items = (pinsRes.value.items ?? pinsRes.value.data ?? []) as ApiPin[];
          setPinSamples(items.filter(p => !!p.image_url).map(p => ({
            id: String(p.id),
            imageUrl: p.image_url,
            title: p.title || "Pin idea",
            category: bucketCategory(p.category),
            sourceType: "pin_sample" as const,
            url: p.outbound_link ?? p.source_url ?? undefined,
          })));
        }
        if (prodRes.status === "fulfilled" && prodRes.value) {
          const items = (prodRes.value.items ?? prodRes.value.data ?? []) as ApiProduct[];
          setProducts(items.filter(p => !!p.image_url).map(p => ({
            id: String(p.id),
            imageUrl: p.image_url,
            title: p.product_name || "Product",
            category: bucketCategory(p.seed_keyword),
            sourceType: "product_opportunity" as const,
            url: p.source_url ?? undefined,
            price: p.price != null ? `${!p.currency || p.currency === "USD" ? "$" : ""}${p.price}` : null,
            score: p.opportunity_score ?? null,
          })));
        }
      } catch {
        /* network/parse failure ⇒ callers fall back to placeholders */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  return { pinSamples, products, loading };
}

export function placeholders(n: number, label: string, sourceType: SourceType = "placeholder"): LandingAsset[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ph-${label}-${i}`, imageUrl: null, title: label, category: "Other", sourceType,
  }));
}

/** Take n real assets, padding with placeholders if the pool is short. */
export function take(pool: LandingAsset[], n: number, label: string, offset = 0): LandingAsset[] {
  const slice = pool.slice(offset, offset + n);
  return slice.length >= n ? slice : [...slice, ...placeholders(n - slice.length, label)];
}

/** Prefer assets in a category; fall back to the wider pool, then placeholders. */
export function pickByCategory(pool: LandingAsset[], category: string, n: number, label: string): LandingAsset[] {
  const inCat = pool.filter(a => a.category === category);
  const chosen = (inCat.length ? inCat : pool).slice(0, n);
  return chosen.length >= n ? chosen : [...chosen, ...placeholders(n - chosen.length, label)];
}
