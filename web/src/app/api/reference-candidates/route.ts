import { createServerClient } from "@/lib/supabase";
import { catLabel } from "@/lib/categories";

// ── GET /api/reference-candidates ───────────────────────────────────────────
// Returns reference-eligible pins for the Create Pins reference picker.
// Source: pin_samples WHERE is_reference_eligible = true AND image_url IS NOT NULL,
// restricted to P0 categories (or ?category=), optionally to the recent crawl
// window (?sinceHours=). Ordered by save_count desc.
//
// The response is intentionally CLEAN: it never exposes backend/classifier
// internals (is_reference_eligible, reference_quality_score, source bucket,
// confidence, etc.). Only display-safe fields are returned.
//
// Query params:
//   ?limit=60          rows (default 60, max 300)
//   ?category=beauty   single P0 category (omit for all P0)
//   ?sinceHours=24     only pins scraped within N hours (omit for all eligible)

const TABLE = "pin_samples";
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 300;
const P0_CATEGORIES = ["fashion", "womens-fashion", "home-decor", "beauty", "digital-products"];

export const revalidate = 30;

type Row = {
  id: string;
  image_url: string | null;
  category: string | null;
  title: string | null;
  source_keyword: string | null;
  seed_keyword: string | null;
  save_count: number | null;
  pinterest_url: string | null;
  scraped_at: string | null;
};

function buildTags(saveCount: number, categoryLabel: string): string[] {
  const tags: string[] = [];
  if (saveCount >= 10_000) tags.push("Popular");
  else if (saveCount >= 1_000) tags.push("Trending");
  if (categoryLabel) tags.push(categoryLabel);
  return tags;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10), MAX_LIMIT);
  const category = searchParams.get("category");
  const sinceHours = parseInt(searchParams.get("sinceHours") ?? "0", 10);

  const db = createServerClient();
  let query = db
    .from(TABLE)
    .select("id,image_url,category,title,source_keyword,seed_keyword,save_count,pinterest_url,scraped_at")
    .eq("is_reference_eligible", true)
    .not("image_url", "is", null)
    .order("save_count", { ascending: false })
    .limit(limit);

  if (category && category !== "All") {
    query = query.eq("category", category.toLowerCase());
  } else {
    query = query.in("category", P0_CATEGORIES);
  }

  if (sinceHours > 0) {
    const cutoff = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
    query = query.gte("scraped_at", cutoff);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[reference-candidates] Supabase error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Row[];
  const items = rows
    .filter(r => !!r.image_url)
    .map(r => {
      const cat = r.category ? catLabel(r.category) : "";
      const keyword = r.source_keyword ?? r.seed_keyword ?? null;
      const saveCount = r.save_count ?? 0;
      return {
        id: r.id,
        imageUrl: r.image_url as string,
        category: cat,
        title: (r.title || "").trim() || (cat ? `${cat} reference` : "Reference pin"),
        sourceUrl: r.pinterest_url ?? null,       // safe: links to the Pinterest pin, not a merchant
        saveCount,                                 // internal signal (display tags derived below)
        tags: buildTags(saveCount, cat),
        parentKeyword: keyword,                    // internal
      };
    });

  const scraped = rows.map(r => r.scraped_at).filter((t): t is string => !!t);
  const lastUpdatedAt = scraped.length ? scraped.reduce((a, b) => (a > b ? a : b)) : new Date().toISOString();

  return Response.json({
    items,
    data: items,
    itemCount: items.length,
    source: "reference_candidates_api",
    lastUpdatedAt,
  });
}
