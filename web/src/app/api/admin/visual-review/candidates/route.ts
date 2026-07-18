import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import {
  computeDecisionLabel,
  computeVisualAssetScore,
  type CandidatesResponse,
  type VisualReviewCandidate,
  type VisualReviewDecision,
  type VisualReviewRecord,
  type VisualReviewScores,
  type VisualReviewSourceType,
  type VisualReviewTag,
  VISUAL_REVIEW_TAGS,
} from "@/lib/visualReview";
import { excludeRetired } from "@/lib/productTopTiers";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 120;

// Postgres "relation does not exist" — the migration for visual_asset_reviews
// hasn't been applied yet. We degrade to read-only (candidates, no reviews).
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return /relation .*visual_asset_reviews.* does not exist/i.test(error.message ?? "");
}

function usableImageUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function loadProductCandidates(
  db: ReturnType<typeof import("@/lib/supabase").createServerClient>,
  limit: number,
  warnings: string[],
): Promise<VisualReviewCandidate[]> {
  // Soft-retired rows (lifecycle_status='retired', migrate_v46) are NOT review
  // candidates: they are never shown to a user, so scoring their images is wasted work
  // (and the T10 batch's images are known-fake Pin screenshots by definition).
  const { data, error } = await excludeRetired(db
    .from("pin_products")
    .select("id, product_name, image_url, seed_keyword, product_pin_id, created_at")
    .not("image_url", "is", null))
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    warnings.push(`pin_products query failed: ${error.message}`);
    return [];
  }

  return (data ?? [])
    .filter(row => usableImageUrl(row.image_url))
    .map(row => ({
      source_type: "pin_product" as VisualReviewSourceType,
      source_id: String(row.id),
      image_url: row.image_url as string,
      title: asString(row.product_name),
      category: asString(row.seed_keyword),
      source_pin_id: asString(row.product_pin_id),
      created_at: asString(row.created_at),
    }));
}

async function loadSampleCandidates(
  db: ReturnType<typeof import("@/lib/supabase").createServerClient>,
  limit: number,
  warnings: string[],
): Promise<VisualReviewCandidate[]> {
  const { data, error } = await db
    .from("pin_samples")
    .select("id, title, category, image_url, pin_id, scraped_at, created_at_source")
    .not("image_url", "is", null)
    .order("scraped_at", { ascending: false })
    .limit(limit);

  if (error) {
    warnings.push(`pin_samples query failed: ${error.message}`);
    return [];
  }

  return (data ?? [])
    .filter(row => usableImageUrl(row.image_url))
    .map(row => ({
      source_type: "pin_sample" as VisualReviewSourceType,
      source_id: String(row.id),
      image_url: row.image_url as string,
      title: asString(row.title),
      category: asString(row.category),
      source_pin_id: asString(row.pin_id),
      created_at: asString(row.created_at_source) ?? asString(row.scraped_at),
    }));
}

function normalizeScores(row: Record<string, unknown>): VisualReviewScores {
  const num = (key: string, fallback: number) =>
    typeof row[key] === "number" ? (row[key] as number) : fallback;
  return {
    human_shot_authenticity_score: num("human_shot_authenticity_score", 3),
    ai_likeness_score: num("ai_likeness_score", 0),
    product_visibility_score: num("product_visibility_score", 3),
    pinterest_native_score: num("pinterest_native_score", 3),
    commercial_clarity_score: num("commercial_clarity_score", 3),
  };
}

function normalizeTags(value: unknown): VisualReviewTag[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(VISUAL_REVIEW_TAGS);
  return value.filter((t): t is VisualReviewTag => typeof t === "string" && allowed.has(t));
}

export async function GET(request: Request) {
  const admin = await requireSuperAdminFromRequest(request);
  if (!admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const sourceParam = url.searchParams.get("source");
  const source: "pin_products" | "pin_samples" | "all" =
    sourceParam === "pin_products" || sourceParam === "pin_samples" ? sourceParam : "all";
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : 60;

  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];

  // Load candidates from the requested source(s). Prefer pin_products when
  // "all" so the primary Product Ideas supply surfaces first.
  let candidates: VisualReviewCandidate[] = [];
  if (source === "pin_products") {
    candidates = await loadProductCandidates(db, limit, warnings);
  } else if (source === "pin_samples") {
    candidates = await loadSampleCandidates(db, limit, warnings);
  } else {
    const [products, samples] = await Promise.all([
      loadProductCandidates(db, limit, warnings),
      loadSampleCandidates(db, limit, warnings),
    ]);
    candidates = [...products, ...samples]
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
      .slice(0, limit);
  }

  // Merge any existing reviews for the shown candidates.
  let reviews: VisualReviewRecord[] = [];
  let persistenceAvailable = true;
  if (candidates.length > 0) {
    const ids = candidates.map(c => c.source_id);
    const { data, error } = await db
      .from("visual_asset_reviews")
      .select("*")
      .in("source_id", ids);

    if (error) {
      if (isMissingTable(error)) {
        persistenceAvailable = false;
        warnings.push("visual_asset_reviews table not found — migration v31 pending; scores are UI-only until applied.");
      } else {
        warnings.push(`visual_asset_reviews query failed: ${error.message}`);
      }
    } else {
      reviews = (data ?? []).map(row => {
        const scores = normalizeScores(row);
        const visual = typeof row.visual_asset_score === "number"
          ? row.visual_asset_score
          : computeVisualAssetScore(scores);
        const decision = (row.decision_label as VisualReviewDecision | undefined)
          ?? computeDecisionLabel(visual, scores.ai_likeness_score);
        return {
          ...scores,
          source_type: row.source_type as VisualReviewSourceType,
          source_id: String(row.source_id),
          image_url: asString(row.image_url),
          visual_asset_score: visual,
          decision_label: decision,
          tags: normalizeTags(row.tags),
          reviewer_note: asString(row.reviewer_note),
          updated_at: asString(row.updated_at),
        };
      });
    }
  }

  const categories = Array.from(
    new Set(candidates.map(c => c.category).filter((c): c is string => !!c)),
  ).sort((a, b) => a.localeCompare(b));

  const body: CandidatesResponse = {
    candidates,
    reviews,
    persistenceAvailable,
    categories,
    warnings,
  };
  return Response.json(body);
}
