import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import {
  computeDecisionLabel,
  computeVisualAssetScore,
  type VisualReviewRecord,
  type VisualReviewScores,
  type VisualReviewSourceType,
  type VisualReviewTag,
  VISUAL_REVIEW_TAGS,
} from "@/lib/visualReview";

export const dynamic = "force-dynamic";

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return /relation .*visual_asset_reviews.* does not exist/i.test(error.message ?? "");
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeTags(value: unknown): VisualReviewTag[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(VISUAL_REVIEW_TAGS);
  const seen = new Set<string>();
  const out: VisualReviewTag[] = [];
  for (const t of value) {
    if (typeof t === "string" && allowed.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t as VisualReviewTag);
    }
  }
  return out;
}

export async function POST(request: Request) {
  const admin = await requireSuperAdminFromRequest(request);
  if (!admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sourceType = payload.source_type;
  const sourceId = payload.source_id;
  if (sourceType !== "pin_sample" && sourceType !== "pin_product") {
    return Response.json({ error: "source_type must be pin_sample or pin_product" }, { status: 400 });
  }
  if (typeof sourceId !== "string" || !sourceId.trim()) {
    return Response.json({ error: "source_id is required" }, { status: 400 });
  }

  const scores: VisualReviewScores = {
    human_shot_authenticity_score: clampInt(payload.human_shot_authenticity_score, 1, 5, 3),
    ai_likeness_score: clampInt(payload.ai_likeness_score, 0, 5, 0),
    product_visibility_score: clampInt(payload.product_visibility_score, 1, 5, 3),
    pinterest_native_score: clampInt(payload.pinterest_native_score, 1, 5, 3),
    commercial_clarity_score: clampInt(payload.commercial_clarity_score, 1, 5, 3),
  };

  // Server is authoritative for the derived fields.
  const visualAssetScore = computeVisualAssetScore(scores);
  const decisionLabel = computeDecisionLabel(visualAssetScore, scores.ai_likeness_score);
  const tags = sanitizeTags(payload.tags);
  const reviewerNote =
    typeof payload.reviewer_note === "string" && payload.reviewer_note.trim()
      ? payload.reviewer_note.trim().slice(0, 2000)
      : null;
  const imageUrl = typeof payload.image_url === "string" && payload.image_url.trim() ? payload.image_url : null;

  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();

  const row = {
    source_type: sourceType as VisualReviewSourceType,
    source_id: sourceId,
    image_url: imageUrl,
    ...scores,
    visual_asset_score: visualAssetScore,
    decision_label: decisionLabel,
    tags,
    reviewer_note: reviewerNote,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("visual_asset_reviews")
    .upsert(row, { onConflict: "source_type,source_id" })
    .select("*")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      return Response.json(
        {
          error: "persistence_unavailable",
          detail: "visual_asset_reviews table not found. Apply migrate_v31_visual_asset_reviews.sql to enable saving.",
        },
        { status: 503 },
      );
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  const record: VisualReviewRecord = {
    ...scores,
    source_type: sourceType as VisualReviewSourceType,
    source_id: sourceId,
    image_url: (data?.image_url as string | null) ?? imageUrl,
    visual_asset_score: visualAssetScore,
    decision_label: decisionLabel,
    tags,
    reviewer_note: reviewerNote,
    updated_at: (data?.updated_at as string | null) ?? row.updated_at,
  };
  return Response.json({ review: record });
}
