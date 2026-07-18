/**
 * GET /api/admin/creative-intelligence/calibration — internal Judge-calibration list.
 *
 * Returns the most recent ~30 generation_judged analytics events (deduped per draft,
 * newest verdict wins), joined to pin_drafts payload for a renderable thumbnail +
 * title. Drafts that were deleted or have no usable image are skipped (per spec).
 * Existing calibration reviews are merged in from visual_asset_reviews via the
 * namespaced source_id (see lib/judgeCalibration.ts for the full field mapping).
 *
 * WRITES go through the existing POST /api/admin/visual-review (same super-admin gate,
 * server-authoritative derived fields, idempotent upsert) — this route is read-only.
 */

import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import { JUDGE_VERSION, type QualityVerdict } from "@/lib/ai-copy/judgeVerdict";
import {
  buildCalibrationSourceId,
  CALIBRATION_SOURCE_TYPE,
  parseCalibrationNote,
  usableCalibrationImageUrl,
  type CalibrationItem,
  type CalibrationResponse,
} from "@/lib/judgeCalibration";

export const dynamic = "force-dynamic";

/** Raw generation_judged events fetched (before dedupe/join/skips). */
const RAW_EVENT_LIMIT = 120;
/** Final list size shown in the calibration section. */
const MAX_ITEMS = 30;

type PgError = { code?: string; message?: string } | null;

function isMissingRelation(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .* does not exist|could not find the table/i.test(error.message ?? "");
}

function verdictOf(payload: Record<string, unknown> | null): QualityVerdict | null {
  const v = payload?.verdict;
  return v === "ok" || v === "borderline" || v === "invalid" ? v : null;
}

function judgeVersionOf(payload: Record<string, unknown> | null): string {
  const versions = payload?.versions;
  if (versions && typeof versions === "object") {
    const jv = (versions as { judgeVersion?: unknown }).judgeVersion;
    if (typeof jv === "string" && jv.trim()) return jv.trim();
  }
  // Events recorded before the versions stamp landed — the judge has only ever run
  // as JUDGE_VERSION, so this fallback is accurate today.
  return JUDGE_VERSION;
}

export async function GET(request: Request) {
  const admin = await requireSuperAdminFromRequest(request);
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];

  // 1) Recent generation_judged events.
  const { data: eventRows, error: eventsError } = await db
    .from("analytics_events")
    .select("draft_id,user_id,payload,created_at")
    .eq("event_name", "generation_judged")
    .order("created_at", { ascending: false })
    .limit(RAW_EVENT_LIMIT);

  if (eventsError) {
    const missing = isMissingRelation(eventsError as PgError);
    warnings.push(missing
      ? "analytics_events table not found — apply migrate_v41_creative_intelligence.sql."
      : `generation_judged query failed: ${(eventsError as PgError)?.message ?? "unknown error"}`);
    const body: CalibrationResponse = { available: false, persistenceAvailable: true, items: [], warnings };
    return Response.json(body);
  }

  // 2) Dedupe by draft (rows are newest-first, so first hit per draft = latest verdict).
  type EventRow = { draft_id: string | null; user_id: string | null; payload: Record<string, unknown> | null; created_at: string | null };
  const byDraft = new Map<string, EventRow>();
  for (const r of (eventRows ?? []) as EventRow[]) {
    const id = typeof r.draft_id === "string" && r.draft_id ? r.draft_id : null;
    if (!id || byDraft.has(id)) continue;
    if (!verdictOf(r.payload)) continue; // unusable payload → skip
    byDraft.set(id, r);
  }
  const draftIds = [...byDraft.keys()];

  // 3) Join pin_drafts for image + title (deleted drafts drop out naturally).
  const draftById = new Map<string, { imageUrl: string; title: string | null; userId: string | null }>();
  if (draftIds.length > 0) {
    const { data: draftRows, error: draftsError } = await db
      .from("pin_drafts")
      .select("vibepin_user_id,draft_id,payload")
      .in("draft_id", draftIds)
      .is("deleted_at", null);
    if (draftsError) {
      warnings.push(isMissingRelation(draftsError as PgError)
        ? "pin_drafts table not found — draft thumbnails unavailable."
        : `pin_drafts join failed: ${(draftsError as PgError)?.message ?? "unknown error"}`);
    } else {
      for (const row of (draftRows ?? []) as Array<{ vibepin_user_id: string | null; draft_id: string; payload: Record<string, unknown> | null }>) {
        const p = row.payload;
        const imageUrl = p?.imageUrl;
        if (!usableCalibrationImageUrl(imageUrl)) continue; // no renderable image → skip
        const title = typeof p?.title === "string" && p.title.trim() ? p.title.trim() : null;
        draftById.set(row.draft_id, { imageUrl, title, userId: row.vibepin_user_id ?? null });
      }
    }
  }

  // 4) Assemble items (skip drafts without a usable image / mismatched owner).
  const items: CalibrationItem[] = [];
  for (const [draftId, ev] of byDraft) {
    const draft = draftById.get(draftId);
    if (!draft) continue;
    // Guard against client-generated draft-id collisions across users.
    if (ev.user_id && draft.userId && ev.user_id !== draft.userId) continue;
    const payload = ev.payload;
    const overall = typeof payload?.overall === "number" && Number.isFinite(payload.overall) ? payload.overall : null;
    items.push({
      draftId,
      imageUrl: draft.imageUrl,
      title: draft.title,
      verdict: verdictOf(payload) as QualityVerdict,
      overall,
      judgeVersion: judgeVersionOf(payload),
      judgedAt: ev.created_at,
      agreement: null,
      reviewedAt: null,
    });
    if (items.length >= MAX_ITEMS) break;
  }

  // 5) Merge existing calibration reviews (dedup key = draftId + judgeVersion).
  let persistenceAvailable = true;
  if (items.length > 0) {
    const sourceIds = items.map(it => buildCalibrationSourceId(it.draftId, it.judgeVersion));
    const { data: reviewRows, error: reviewsError } = await db
      .from("visual_asset_reviews")
      .select("source_id,reviewer_note,updated_at")
      .eq("source_type", CALIBRATION_SOURCE_TYPE)
      .in("source_id", sourceIds);
    if (reviewsError) {
      if (isMissingRelation(reviewsError as PgError)) {
        persistenceAvailable = false;
        warnings.push("visual_asset_reviews table not found — calibration votes cannot be saved (migration v31).");
      } else {
        warnings.push(`visual_asset_reviews query failed: ${(reviewsError as PgError)?.message ?? "unknown error"}`);
      }
    } else {
      const bySourceId = new Map<string, { note: ReturnType<typeof parseCalibrationNote>; updatedAt: string | null }>();
      for (const row of (reviewRows ?? []) as Array<{ source_id: string; reviewer_note: string | null; updated_at: string | null }>) {
        bySourceId.set(row.source_id, { note: parseCalibrationNote(row.reviewer_note), updatedAt: row.updated_at });
      }
      for (const it of items) {
        const hit = bySourceId.get(buildCalibrationSourceId(it.draftId, it.judgeVersion));
        if (hit?.note) {
          it.agreement = hit.note.agreement;
          it.reviewedAt = hit.updatedAt;
        }
      }
    }
  }

  const body: CalibrationResponse = { available: true, persistenceAvailable, items, warnings };
  return Response.json(body);
}
