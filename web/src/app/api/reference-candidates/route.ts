import { createServerClient } from "@/lib/supabase";
import { catLabel } from "@/lib/categories";
import {
  rankReferencesTiered,
  toRecommendation,
  hasProductAnalysisSignal,
  hasProductTextSignal,
  deriveRecommendationBasis,
  type ReferenceCandidateRow,
  type ReferenceScoringInput,
  type ScoredReference,
} from "@/lib/studio/referenceScoring";
import { canonicalizeCategory, inferP0Category, type P0Canonical } from "@/lib/studio/referenceCategory";
import { stratifiedSample } from "@/lib/studio/referencePool";
import {
  parseServeFields,
  defaultSeed,
  mergeRoundRobin,
  buildServed,
  boundedServedPayload,
  utcDayStart,
  type PoolMode,
} from "@/lib/studio/referenceServe";
import { recordAnalyticsEvents } from "@/lib/server/recordEvent";
import { MAX_PAYLOAD_BYTES } from "@/lib/analyticsIngest";

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

// Pool sizing. The DB read is quality-ordered and wide (1000) so the freshness-stratified
// sampler has something to choose from; only the 300-row SAMPLE is scored. Before P0 the
// route scored a fixed top-200 by quality, which is exactly why the same product saw the
// same references forever and nothing crawled this week could ever surface.
const POST_POOL_LIMIT = 1000;
const POST_SAMPLE_SIZE = 300;
/** Unknown category: four smaller pools, one per P0 bucket, ranked independently. */
const UNKNOWN_POOL_LIMIT = 250;
const UNKNOWN_SAMPLE_SIZE = 100;
const POST_DEFAULT_RESULTS = 12;
const POST_MAX_RESULTS = 24;
/** At most 2 leading slots per source_keyword cluster, so one crawl query cannot fill the
 *  drawer with near-identical pins. Overflow is demoted, never dropped. */
const KEYWORD_CLUSTER_CAP = 2;
/** The canonical buckets probed when the category is unknown (NOT P0_CATEGORIES: that list
 *  holds DB values and contains `womens-fashion`, which canonicalizes into `fashion`). */
const P0_CANONICALS: P0Canonical[] = ["fashion", "home-decor", "beauty", "digital-products"];

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
  // Observability / batching fields. ALL optional and never trusted: they are re-read
  // from the raw body by parseServeFields, which supplies safe defaults. Declared here
  // only so the wire contract is visible at the route.
  draftId?: string;
  requestId?: string;
  imageKey?: string;
  analysisSource?: string;
  analysisStatus?: string;
  seed?: string;
  excludeIds?: string[];
};

const SELECT_COLS =
  "id,image_url,category,title,source_keyword,seed_keyword,source_url,pinterest_url,save_count," +
  "scraped_at,reference_quality_score,visual_format,human_presence,text_overlay_level," +
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
  scraped_at: string | null;
  reference_quality_score: number | null;
  visual_format: string | null;
  human_presence: string | null;
  text_overlay_level: string | null;
  watermark_detected: boolean | null;
  image_quality_band: string | null;
  composition_type: string | null;
  has_clear_subject: boolean | null;
};

/** One quality-ordered read of the reference-eligible pool for a set of DB categories. */
async function fetchPool(
  db: ReturnType<typeof createServerClient>,
  dbCategories: string[],
  limit: number,
) {
  return db
    .from(TABLE)
    .select(SELECT_COLS)
    .eq("is_reference_eligible", true)
    .not("image_url", "is", null)
    .in("category", dbCategories)
    // Quality-first read (uses idx_ps_reference_eligible); sampling and relevance ranking
    // both happen in JS afterwards.
    .order("reference_quality_score", { ascending: false, nullsFirst: false })
    // Deterministic tie order: quality scores are coarse integers with hundreds of ties, so
    // without a secondary key the 1000-row window (and therefore the sample) could drift
    // between two calls with the same seed.
    .order("scraped_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(limit);
}

/** DB row → scorer row. `scrapedAt` feeds the sampler's freshness tiers and the ranker's
 *  tie-break; it is stripped again by toRecommendation() and never reaches the wire. */
function toCandidateRow(r: PostRow): ReferenceCandidateRow {
  return {
    id: r.id,
    imageUrl: r.image_url as string,
    category: r.category,
    title: r.title,
    sourceKeyword: r.source_keyword ?? r.seed_keyword,
    sourceUrl: r.source_url,
    pinterestUrl: r.pinterest_url,
    saveCount: r.save_count,
    scrapedAt: r.scraped_at,
    referenceQualityScore: r.reference_quality_score,
    visualFormat: r.visual_format,
    humanPresence: r.human_presence,
    textOverlayLevel: r.text_overlay_level,
    watermarkDetected: r.watermark_detected,
    imageQualityBand: r.image_quality_band,
    compositionType: r.composition_type,
    hasClearSubject: r.has_clear_subject,
  };
}

export async function POST(request: Request) {
  let body: PostBody = {};
  try {
    body = (await request.json()) as PostBody;
  } catch {
    body = {};
  }

  // One clock for the whole request: the sampler's freshness tiers and the default seed
  // must agree, and neither may call Date.now() somewhere deep in a helper.
  // Quantized to the UTC day: the sampler's freshness tiers (<=7d / <=30d) are relative to
  // `now`, so a per-request wall clock let rows cross a tier boundary between two calls with
  // the same daily seed and change the sample. Same UTC day => same tiers => same sample.
  const now = utcDayStart(new Date());
  const fields = parseServeFields(body, { uuid: () => crypto.randomUUID() });
  const excluded = new Set(fields.excludeIds);

  const analysis = body.imageAnalysis ?? {};

  // Honest-basis inputs are read from the RAW body, BEFORE any category inference.
  // Inference synthesizes a category out of product words; if it ran first we could not
  // tell a genuine product signal from a category we invented. Note `analysis.category`
  // is deliberately NOT a product-analysis signal — a category alone is not product detail.
  const hasAnalysis = hasProductAnalysisSignal(analysis);
  const hasText = hasProductTextSignal(body.product);

  // Logged verbatim as `served.categoryInput` so a canonicalization miss is visible in the
  // data (input "lifestyle" → canonical "home-decor" is the mapping we want to audit).
  const categoryInput = body.category ?? analysis.category ?? null;
  const explicit = canonicalizeCategory(categoryInput);
  // When analysis hasn't classified the draft yet, infer the category from the product
  // title + image summary so the pool is scoped and recommendations stay on-topic. The
  // inferred token goes through the SAME canonicalizer — one bucket vocabulary, not two.
  const resolved = explicit.canonical
    ? explicit
    : canonicalizeCategory(inferP0Category([body.product?.title, body.product?.productType,
        analysis.imageSummary, ...(analysis.visibleObjects ?? [])].filter(Boolean).join(" ")));
  const canonical = resolved.canonical;
  const dbCategories = resolved.dbCategories;

  const results = Math.min(Math.max(1, body.limit ?? POST_DEFAULT_RESULTS), POST_MAX_RESULTS);

  const scoringInput: ReferenceScoringInput = {
    category: canonical ?? undefined,
    style: analysis.style,
    colors: analysis.colors,
    visibleObjects: analysis.visibleObjects,
    imageSummary: analysis.imageSummary,
    productTitle: body.product?.title,
    productType: body.product?.productType,
    productTags: body.product?.productTags,
  };

  const db = createServerClient();

  let poolMode: PoolMode;
  let poolIds: string[];
  let excludedCount: number;
  let ranked: ScoredReference[];
  // Only set on the unknown-roundrobin path when at least one of the four category pools
  // failed to fetch; the survivors still serve so a single flaky query doesn't 500 the drawer.
  let degradedPools: string[] | undefined;

  if (canonical) {
    // ── Known category ───────────────────────────────────────────────────────────
    // Read wide by quality, then sample across freshness tiers so this week's crawl can
    // actually reach the drawer, then drop what the client has already been shown.
    const seed = fields.seed ?? defaultSeed(canonical, now);
    const { data, error } = await fetchPool(db, dbCategories, POST_POOL_LIMIT);
    if (error) {
      console.error("[reference-candidates POST] Supabase error:", error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }
    const sampled = stratifiedSample(((data ?? []) as unknown as PostRow[]).map(toCandidateRow),
      { size: POST_SAMPLE_SIZE, seed, now });
    const kept = sampled.filter(r => !excluded.has(r.id));
    excludedCount = sampled.length - kept.length;
    // The fashion pool is physically split across `fashion` and `womens-fashion` rows;
    // scoring only knows the canonical bucket, so normalize before ranking or half the
    // merged pool would lose its in-category relevance signal.
    const scoped = kept.map<ReferenceCandidateRow>(r => ({ ...r, category: canonical }));
    poolIds = scoped.map(r => r.id);
    poolMode = dbCategories.length > 1 ? "merged-fashion" : "single";
    ranked = rankReferencesTiered(scoped, { ...scoringInput, category: canonical }, results,
      { keywordClusterCap: KEYWORD_CLUSTER_CAP });
  } else {
    // ── Unknown category ─────────────────────────────────────────────────────────
    // Never score four categories as one pool: popularity would hand every slot to the
    // biggest bucket. Rank each category on its own terms, then interleave. The per-
    // category seed suffix matters — one shared seed would correlate the four samples.
    const seedBase = fields.seed ?? defaultSeed(null, now);
    const pools = await Promise.all(P0_CANONICALS.map(async c => {
      const { data, error } = await fetchPool(db, canonicalizeCategory(c).dbCategories, UNKNOWN_POOL_LIMIT);
      if (error) return { canonical: c, error, excludedCount: 0, poolIds: [] as string[], ranked: [] as ScoredReference[] };
      const sampled = stratifiedSample(((data ?? []) as unknown as PostRow[]).map(toCandidateRow),
        { size: UNKNOWN_SAMPLE_SIZE, seed: `${seedBase}:${c}`, now });
      const kept = sampled
        .filter(r => !excluded.has(r.id))
        .map<ReferenceCandidateRow>(r => ({ ...r, category: c }));
      return {
        canonical: c,
        error: null,
        excludedCount: sampled.length - kept.length,
        poolIds: kept.map(r => r.id),
        // limit 0 = rank everything; the round-robin merge does the truncation.
        ranked: rankReferencesTiered(kept, { ...scoringInput, category: c }, 0,
          { keywordClusterCap: KEYWORD_CLUSTER_CAP }),
      };
    }));
    const failedPools = pools.filter(p => p.error);
    for (const p of failedPools) {
      console.error("[reference-candidates POST] Supabase error:", p.canonical, p.error!.message);
    }
    if (failedPools.length === pools.length) {
      // Every pool failed: nothing to serve, preserve the previous all-500 behavior.
      return Response.json({ error: failedPools[0].error!.message }, { status: 500 });
    }
    const healthyPools = pools.filter(p => !p.error);
    excludedCount = healthyPools.reduce((n, p) => n + p.excludedCount, 0);
    poolIds = healthyPools.flatMap(p => p.poolIds);
    poolMode = "unknown-roundrobin";
    ranked = mergeRoundRobin(healthyPools.map(p => p.ranked), results);
    if (failedPools.length > 0) {
      degradedPools = failedPools.map(p => p.canonical);
    }
  }

  const items = ranked.map(toRecommendation);

  // Honest provenance: what the list was ACTUALLY based on. Decided ONLY by whether the
  // FINAL merged output contains a Tier-1 (product_evidence) item — a Tier-2 backfill can
  // still carry scene_match/style signals from scoring, and must not resurrect product_*.
  // Always present on a successful response so the client never has to guess whether
  // "Recommended for this product" is a truthful label.
  const recommendationBasis = deriveRecommendationBasis({ hasAnalysis, hasText, results: ranked });

  const served = buildServed({
    requestId: fields.requestId,
    categoryInput,
    categoryCanonical: canonical,
    poolMode,
    poolIds,
    excludedCount,
    results: ranked,
    recommendationBasis,
    degradedPools,
  });

  // Best-effort telemetry. recordAnalyticsEvents already swallows everything (and drops
  // silently when there is no session), but the response must not be able to die here, so
  // the call is belt-and-braces wrapped: `served` and the event are independent. The
  // payload is bounded here (not via analyticsIngest's all-or-nothing truncation) so an
  // oversized `ids` list degrades gracefully instead of losing every field.
  try {
    await recordAnalyticsEvents(request, [{
      event_name: "reference_recs_served",
      draft_id: fields.draftId ?? null,
      payload: boundedServedPayload({
        ...served,
        analysisSource: fields.analysisSource,
        analysisStatus: fields.analysisStatus,
        imageKey: fields.imageKey ?? null,
        hasImageAnalysis: hasAnalysis,
        hasMeaningfulTitle: hasText,
        seedPresent: Boolean(fields.seed),
        limit: results,
      }, MAX_PAYLOAD_BYTES),
    }]);
  } catch (err) {
    console.error("[reference-candidates POST] event sink error:", err instanceof Error ? err.message : err);
  }

  return Response.json({
    items,
    itemCount: items.length,
    source: "reference_candidates_product_aware",
    recommendationBasis,
    served,
  });
}
