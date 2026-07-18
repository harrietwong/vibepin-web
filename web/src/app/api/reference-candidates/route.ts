import { createServerClient } from "@/lib/supabase";
import { catLabel } from "@/lib/categories";
import {
  rankReferences,
  toRecommendation,
  type ReferenceCandidateRow,
  type ReferenceScoringInput,
} from "@/lib/studio/referenceScoring";

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

// ── POST /api/reference-candidates ──────────────────────────────────────────
// Product-aware recommendations (PRD v0.2 §5.3 / Phase B). Accepts the draft's
// image analysis + optional product context, ranks reference-eligible pin_samples
// by RELEVANCE FIRST (category + scene/style), popularity strictly second, and
// returns display-safe items with a plain-language `reason`, Pinterest linkback,
// and prompt-safe pattern tags. Internal scores/classifier fields are never exposed.
// The original image is NEVER used as a generation input (compliance §4).

const POST_POOL_LIMIT = 200;
const POST_DEFAULT_RESULTS = 12;
const POST_MAX_RESULTS = 24;

// Keyword → P0 category inference. Used ONLY when the draft carries no category yet
// (image analysis not finished). Without a category the query would pull a cross-category
// pool ordered by popularity and surface off-topic pins (PRD §5.3 violation). Inferring the
// category from the product title/summary scopes the pool so recommendations stay relevant.
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  "home-decor": ["decor", "home", "room", "wall", "art", "print", "poster", "frame", "rug",
    "lamp", "shelf", "shelfie", "vase", "cushion", "pillow", "furniture", "table", "desk",
    "chair", "sofa", "couch", "cabinet", "dresser", "storage", "bedroom", "living", "kitchen",
    "bathroom", "entryway", "plant", "candle", "mirror", "curtain", "blanket", "throw",
    "gallery", "interior", "apartment", "cozy", "aesthetic", "styling"],
  "fashion": ["outfit", "outfits", "dress", "top", "shirt", "tee", "jeans", "pants", "jacket",
    "coat", "skirt", "shoes", "sneakers", "boots", "heels", "bag", "handbag", "purse", "tote",
    "accessory", "accessories", "jewelry", "bracelet", "necklace", "earrings", "ring", "watch",
    "scarf", "hat", "sunglasses", "wear", "wardrobe", "streetwear", "lookbook", "fit"],
  "beauty": ["makeup", "skincare", "cosmetic", "cosmetics", "lipstick", "foundation", "mascara",
    "nail", "nails", "manicure", "hair", "hairstyle", "haircut", "vanity", "serum", "moisturizer",
    "perfume", "beauty", "glow", "lashes", "brows", "eyeshadow", "blush"],
  "digital-products": ["printable", "printables", "template", "templates", "planner", "digital",
    "download", "downloadable", "ebook", "wallpaper", "svg", "canva", "spreadsheet", "worksheet",
    "notion", "checklist"],
};

/** Infer a P0 category from free text (product title + image summary) by keyword hits.
 *  Returns undefined on no clear winner so the caller keeps its safe fallback. */
function inferP0Category(text: string): string | undefined {
  const words = new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean));
  let best: string | undefined;
  let bestHits = 0;
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const hits = keywords.reduce((n, k) => n + (words.has(k) ? 1 : 0), 0);
    if (hits > bestHits) { bestHits = hits; best = cat; }
  }
  return bestHits >= 1 ? best : undefined;
}

type PostBody = {
  imageAnalysis?: {
    category?: string;
    style?: string;
    colors?: string[];
    visibleObjects?: string[];
    imageSummary?: string;
  };
  product?: { title?: string; productType?: string; productTags?: string[] };
  category?: string;
  limit?: number;
};

const SELECT_COLS =
  "id,image_url,category,title,source_keyword,seed_keyword,source_url,pinterest_url,save_count," +
  "reference_quality_score,visual_format,human_presence,text_overlay_level," +
  "watermark_detected,image_quality_band,composition_type,has_clear_subject";

type PostRow = {
  id: string;
  image_url: string | null;
  category: string | null;
  title: string | null;
  source_keyword: string | null;
  seed_keyword: string | null;
  source_url: string | null;
  pinterest_url: string | null;
  save_count: number | null;
  reference_quality_score: number | null;
  visual_format: string | null;
  human_presence: string | null;
  text_overlay_level: string | null;
  watermark_detected: boolean | null;
  image_quality_band: string | null;
  composition_type: string | null;
  has_clear_subject: boolean | null;
};

export async function POST(request: Request) {
  let body: PostBody = {};
  try {
    body = (await request.json()) as PostBody;
  } catch {
    body = {};
  }

  const analysis = body.imageAnalysis ?? {};
  const explicitCategory = (body.category ?? analysis.category ?? "").toLowerCase().replace(/[\s_]+/g, "-").trim();
  // When analysis hasn't classified the draft yet, infer the category from the product
  // title + image summary so the pool is scoped and recommendations stay on-topic.
  const inputCategory = explicitCategory
    || inferP0Category([body.product?.title, body.product?.productType, analysis.imageSummary,
        ...(analysis.visibleObjects ?? [])].filter(Boolean).join(" "))
    || "";
  const results = Math.min(Math.max(1, body.limit ?? POST_DEFAULT_RESULTS), POST_MAX_RESULTS);

  const scoringInput: ReferenceScoringInput = {
    category: inputCategory || undefined,
    style: analysis.style,
    colors: analysis.colors,
    visibleObjects: analysis.visibleObjects,
    imageSummary: analysis.imageSummary,
    productTitle: body.product?.title,
    productType: body.product?.productType,
    productTags: body.product?.productTags,
  };

  const db = createServerClient();
  let query = db
    .from(TABLE)
    .select(SELECT_COLS)
    .eq("is_reference_eligible", true)
    .not("image_url", "is", null)
    // Quality-first pool (uses idx_ps_reference_eligible); relevance ranking happens in JS.
    .order("reference_quality_score", { ascending: false, nullsFirst: false })
    .limit(POST_POOL_LIMIT);

  // Category-scoped when we know it; otherwise fall back to the P0 set.
  if (inputCategory && P0_CATEGORIES.includes(inputCategory)) {
    query = query.eq("category", inputCategory);
  } else {
    query = query.in("category", P0_CATEGORIES);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[reference-candidates POST] Supabase error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = ((data ?? []) as unknown as PostRow[]).map<ReferenceCandidateRow>(r => ({
    id: r.id,
    imageUrl: r.image_url as string,
    category: r.category,
    title: r.title,
    sourceKeyword: r.source_keyword ?? r.seed_keyword,
    sourceUrl: r.source_url,
    pinterestUrl: r.pinterest_url,
    saveCount: r.save_count,
    referenceQualityScore: r.reference_quality_score,
    visualFormat: r.visual_format,
    humanPresence: r.human_presence,
    textOverlayLevel: r.text_overlay_level,
    watermarkDetected: r.watermark_detected,
    imageQualityBand: r.image_quality_band,
    compositionType: r.composition_type,
    hasClearSubject: r.has_clear_subject,
  }));

  const items = rankReferences(rows, scoringInput, results).map(toRecommendation);

  return Response.json({
    items,
    itemCount: items.length,
    source: "reference_candidates_product_aware",
  });
}
