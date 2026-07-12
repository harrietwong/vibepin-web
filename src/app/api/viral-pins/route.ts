import { createServerClient, type ViralPin } from "@/lib/supabase";
import { classifySourcePin, shouldShowInPinIdeas } from "@/lib/assetClassification";

// ── Config ─────────────────────────────────────────────────────────────────────
const TABLE = "pin_samples";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 300;

type PinSampleRow = {
  id: string;
  pin_id?: string | null;
  image_url: string;
  category: string;
  title?: string | null;
  description?: string | null;
  save_count?: number | null;
  reaction_count?: number | null;
  save_velocity?: number | null;
  days_since_creation?: number | null;
  outbound_link?: string | null;
  source_url?: string | null;
  pin_created_at?: string | null;
  scraped_at?: string | null;
};

// Cache response for 60 s so repeated page loads don't hammer Supabase, but
// trend data still refreshes frequently.
export const revalidate = 60;

// ── GET /api/viral-pins ────────────────────────────────────────────────────────
// Query params:
//   ?limit=25        — number of rows (default 50, max 100)
//   ?category=Boho   — filter by category (omit or "All" for no filter)
//   ?offset=0        — pagination offset (default 0)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const limit = Math.min(
    parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10),
    MAX_LIMIT
  );
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);
  const category = searchParams.get("category");

  const db = createServerClient();

  let query = db
    .from(TABLE)
    .select(
      "id,pin_id,image_url,category,title,description,save_count,reaction_count," +
      "save_velocity,days_since_creation,outbound_link,source_url,pin_created_at,scraped_at",
      { count: "exact" }
    )
    .order("save_count", { ascending: false })
    .range(offset, offset + limit - 1);

  if (category && category !== "All") {
    query = query.eq("category", category.toLowerCase());
  }

  const { data, error, count } = await query;

  if (error) {
    console.error("[viral-pins] Supabase error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const now = Date.now();
  const enriched = ((data ?? []) as unknown as PinSampleRow[]).map(pin => {
    // Use pre-computed fields when available, derive from pin_created_at as fallback
    const daysSince = pin.days_since_creation ??
      (pin.pin_created_at
        ? Math.max(1, Math.round((now - new Date(pin.pin_created_at).getTime()) / 86_400_000))
        : 30);
    const classified = classifySourcePin({
      title: pin.title,
      description: pin.description,
      sourceUrl: pin.source_url,
      destinationUrl: pin.outbound_link ?? pin.source_url,
      category: pin.category,
      isPinterestPin: true,
    });
    return {
      ...pin,
      is_high_growth: (pin.save_count ?? 0) >= 10_000,
      save_velocity: pin.save_velocity ?? Math.round((pin.save_count ?? 0) / daysSince),
      days_since_created: daysSince,
      item_type: classified.item_type,
      product_type: classified.product_type,
      product_subtype: classified.product_subtype,
      destination_type: classified.destination_type,
      asset_role: classified.asset_role,
      source_context: classified.source_context,
      risk_flags: classified.risk_flags,
    };
  }).filter(pin => shouldShowInPinIdeas(pin));

  // Use actual data freshness (max scraped_at from returned pins), not pipeline run time.
  // Pipeline run time can be misleading when crawl completes but writes no new rows.
  const scrapedTimes = (enriched as { scraped_at?: string | null }[])
    .map(p => p.scraped_at)
    .filter((t): t is string => !!t);
  const lastScraped = scrapedTimes.length
    ? scrapedTimes.reduce((a, b) => (a > b ? a : b))
    : null;

  const pins = enriched as ViralPin[];
  const lastUpdatedAt = lastScraped ?? new Date().toISOString();

  return Response.json({
    items: pins,
    data: pins,
    count,
    limit,
    offset,
    itemCount: pins.length,
    source: "pin_ideas_api",
    lastUpdatedAt,
  });
}
