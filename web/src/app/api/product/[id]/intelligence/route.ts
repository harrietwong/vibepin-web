import { createServerClient } from "@/lib/supabase";
import type { ProductIntelligence } from "@/lib/supabase";
import { excludeRetired } from "@/lib/productTopTiers";

export const revalidate = 120;

// GET /api/product/:id/intelligence
// Returns full intelligence breakdown for a single product.
// :id is the pin_products.id (uuid)
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || typeof id !== "string") {
    return Response.json({ error: "Missing product id" }, { status: 400 });
  }

  const db = createServerClient();

  // ── 1. Product base + score ─────────────────────────────────────────────
  // Soft-retired rows (lifecycle_status='retired', migrate_v46) are NOT resolvable
  // here: a retired product must 404 rather than render a detail page for a row that
  // no discovery surface lists. maybeSingle() so the excluded case is a clean "not
  // found" instead of a PostgREST 0-rows error.
  const { data: product, error: prodErr } = await excludeRetired(db
    .from("pin_products")
    .select(`
      id,
      product_pin_id,
      parent_pin_id,
      product_name,
      price,
      currency,
      source_url,
      domain,
      merchant,
      image_url,
      save_count,
      reaction_count,
      source_pin_save_count,
      seed_keyword,
      scraped_at,
      product_scores (
        opportunity_score,
        trend_score,
        save_velocity_score,
        freshness_score,
        competition_score,
        scored_at
      )
    `)
    .eq("id", id))
    .maybeSingle();

  if (prodErr || !product) {
    return Response.json({ error: prodErr?.message ?? "Product not found" }, { status: 404 });
  }

  // ── 2. Source pin context ───────────────────────────────────────────────
  const { data: sourcePin } = await db
    .from("pin_samples")
    .select("pin_id,title,image_url,save_count,save_velocity,age_days,trend_stage,source_interest,seed_keyword,source_keyword,pinterest_url,pin_created_at")
    .eq("pin_id", (product as any).parent_pin_id)
    .maybeSingle();

  // ── 3. Linked keywords (via keyword_product_map) ────────────────────────
  const { data: kwLinks } = await db
    .from("keyword_product_map")
    .select(`
      relevance_score,
      total_pins,
      total_saves,
      trend_keywords (
        id,
        keyword,
        category,
        yearly_change,
        search_volume_level,
        priority_score
      )
    `)
    .eq("product_id", id)
    .order("relevance_score", { ascending: false })
    .limit(10);

  // ── 4. Sibling products from same source pin ────────────────────────────
  // Retired siblings must not surface in the source-relationship section either.
  const { data: siblings } = await excludeRetired(db
    .from("pin_products")
    .select("id,product_name,price,domain,image_url,save_count")
    .eq("parent_pin_id", (product as any).parent_pin_id)
    .neq("id", id))
    .order("save_count", { ascending: false })
    .limit(5);

  const score = (product as any).product_scores;

  const response: ProductIntelligence = {
    product: {
      id:                    (product as any).id,
      product_pin_id:        (product as any).product_pin_id,
      parent_pin_id:         (product as any).parent_pin_id,
      product_name:          (product as any).product_name,
      price:                 (product as any).price,
      currency:              (product as any).currency,
      source_url:            (product as any).source_url,
      domain:                (product as any).domain,
      merchant:              (product as any).merchant,
      image_url:             (product as any).image_url,
      save_count:            (product as any).save_count,
      reaction_count:        (product as any).reaction_count,
      source_pin_save_count: (product as any).source_pin_save_count,
      seed_keyword:          (product as any).seed_keyword,
      scraped_at:            (product as any).scraped_at,
    },
    score: score
      ? {
          opportunity_score:   score.opportunity_score,
          trend_score:         score.trend_score,
          save_velocity_score: score.save_velocity_score,
          freshness_score:     score.freshness_score,
          competition_score:   score.competition_score,
          scored_at:           score.scored_at,
        }
      : null,
    source_pin: sourcePin ?? null,
    keywords: (kwLinks ?? []).map((link: any) => ({
      keyword_id:          link.trend_keywords?.id,
      keyword:             link.trend_keywords?.keyword,
      category:            link.trend_keywords?.category,
      pct_growth_yoy:      link.trend_keywords?.yearly_change,
      search_volume_level: link.trend_keywords?.search_volume_level,
      priority_score:      link.trend_keywords?.priority_score,
      relevance_score:     link.relevance_score,
      total_pins:          link.total_pins,
      total_saves:         link.total_saves,
    })),
    sibling_products: (siblings ?? []).map((s: any) => ({
      id:           s.id,
      product_name: s.product_name,
      price:        s.price,
      domain:       s.domain,
      image_url:    s.image_url,
      save_count:   s.save_count,
    })),
  };

  return Response.json(response);
}
