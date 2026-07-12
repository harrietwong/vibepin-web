/**
 * /api/user-store — WP-A generic account-level store storage (v40 user_store_docs).
 *
 * Same server-authoritative write-through model as /api/pin-drafts, generalized
 * with a mandatory `storeKey` dimension so many independent client stores share
 * one table. Every request scopes to a single (vibepin_user_id, storeKey).
 *
 * GET    ?storeKey&cursor&limit=100 → { docs: [{docId, updatedAt, deletedAt?, payload}], nextCursor? }
 *                                     (updated_at desc, doc_id asc stable order; INCLUDES tombstones)
 * PUT    { storeKey, docs: [{docId, updatedAt, payload}] } (≤50)
 *                                   → { applied, skippedStale }  (server LWW: incoming.updatedAt < row → skip)
 * DELETE { storeKey, docIds: string[], deletedAt } (≤50)
 *                                   → { applied }                (tombstone; stale deletes skipped)
 *
 * Auth: Authorization: Bearer <supabase access token> (getUserIdFromBearer).
 * Degradation: table not applied → GET returns empty list, PUT/DELETE return
 * 202 {deferred:true} so the client outbox retries later. Errors are {error, code}.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import {
  applyQuota,
  clampLimit,
  decodeCursor,
  encodeCursor,
  isMissingTableError,
  isStalePut,
  isTombstoneEligible,
  isValidStoreKey,
  parseMs,
  pgQuote,
  quotaFor,
  validateDocIds,
  validateDocs,
} from "./logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "user_store_docs";

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonError(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status });
}

function unauthorized(): Response {
  return jsonError(401, "unauthorized", "Unauthorized — include Authorization: Bearer <token>");
}

function badStoreKey(): Response {
  return jsonError(400, "bad_request", "storeKey is required and must match /^[a-z0-9_-]{1,64}$/");
}

function deferred(): Response {
  return Response.json({ deferred: true }, { status: 202 });
}

// ── GET — cursor-paginated listing (includes tombstones) ─────────────────────

export async function GET(req: Request) {
  const userId = await getUserIdFromBearer(req);
  if (!userId) return unauthorized();

  const url = new URL(req.url);
  const storeKey = url.searchParams.get("storeKey");
  if (!isValidStoreKey(storeKey)) return badStoreKey();

  const limit = clampLimit(url.searchParams.get("limit"));

  const cursorRaw = url.searchParams.get("cursor");
  let cursor: { u: string; d: string } | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) return jsonError(400, "bad_request", "Invalid cursor");
  }

  const db = createServerClient();
  let query = db
    .from(TABLE)
    .select("doc_id, updated_at, deleted_at, payload")
    .eq("vibepin_user_id", userId)
    .eq("store_key", storeKey)
    .order("updated_at", { ascending: false })
    .order("doc_id", { ascending: true })
    .limit(limit + 1);

  if (cursor) {
    // Keyset: updated_at < u OR (updated_at = u AND doc_id > d)
    query = query.or(
      `updated_at.lt.${pgQuote(cursor.u)},and(updated_at.eq.${pgQuote(cursor.u)},doc_id.gt.${pgQuote(cursor.d)})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) return Response.json({ docs: [] });
    console.error("[user-store GET] select error:", error.message);
    return jsonError(503, "database_unavailable", "Store storage is unavailable");
  }

  const rows = data ?? [];
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];

  return Response.json({
    docs: page.map(r => ({
      docId: r.doc_id as string,
      updatedAt: r.updated_at as string,
      ...(r.deleted_at ? { deletedAt: r.deleted_at as string } : {}),
      payload: r.payload as Record<string, unknown>,
    })),
    ...(hasMore && last ? { nextCursor: encodeCursor(last.updated_at as string, last.doc_id as string) } : {}),
  });
}

// ── PUT — batched LWW upsert ──────────────────────────────────────────────────

export async function PUT(req: Request) {
  const userId = await getUserIdFromBearer(req);
  if (!userId) return unauthorized();

  let body: { storeKey?: unknown; docs?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_request", "Invalid JSON body");
  }

  if (!isValidStoreKey(body.storeKey)) return badStoreKey();
  const storeKey = body.storeKey;

  const validated = validateDocs(body.docs);
  if (!validated.ok) {
    return validated.kind === "payload_too_large"
      ? jsonError(413, "payload_too_large", validated.error)
      : jsonError(400, "bad_request", validated.error);
  }
  const incoming = validated.value;

  const db = createServerClient();
  const ids = incoming.map(d => d.docId);

  const { data: existing, error: selectError } = await db
    .from(TABLE)
    .select("doc_id, updated_at")
    .eq("vibepin_user_id", userId)
    .eq("store_key", storeKey)
    .in("doc_id", ids);

  if (selectError) {
    if (isMissingTableError(selectError)) return deferred();
    console.error("[user-store PUT] select error:", selectError.message);
    return jsonError(503, "database_unavailable", "Store storage is unavailable");
  }

  const existingMs = new Map<string, number>(
    (existing ?? []).map(r => [r.doc_id as string, parseMs(r.updated_at as string) ?? 0]),
  );
  // Any doc_id already present (live OR tombstoned) is an update/revive — the quota
  // gate always lets those through; only brand-new inserts are capped.
  const existingDocIds = new Set<string>((existing ?? []).map(r => r.doc_id as string));

  // Current live (non-tombstoned) row count for this (user, storeKey) → headroom.
  const { count: liveCountRaw, error: countError } = await db
    .from(TABLE)
    .select("doc_id", { count: "exact", head: true })
    .eq("vibepin_user_id", userId)
    .eq("store_key", storeKey)
    .is("deleted_at", null);
  if (countError) {
    if (isMissingTableError(countError)) return deferred();
    console.error("[user-store PUT] count error:", countError.message);
    return jsonError(503, "database_unavailable", "Store storage is unavailable");
  }

  // Post-staleness rows to write, plus the quota decision over their doc_ids.
  const candidate: { docId: string; row: Record<string, unknown> }[] = [];
  let skippedStale = 0;
  for (const d of incoming) {
    const incMs = parseMs(d.updatedAt)!;
    if (isStalePut(incMs, existingMs.get(d.docId))) { skippedStale++; continue; } // server LWW
    candidate.push({
      docId: d.docId,
      row: {
        vibepin_user_id: userId,
        store_key:       storeKey,
        doc_id:          d.docId,
        payload:         d.payload,
        updated_at:      d.updatedAt,
        deleted_at:      null, // a newer PUT revives a tombstoned doc
        // created_at intentionally omitted: default now() on insert, unchanged on conflict-update.
      },
    });
  }

  const { acceptedDocIds, rejected } = applyQuota({
    quota: quotaFor(storeKey),
    liveCount: liveCountRaw ?? 0,
    existingDocIds,
    candidateDocIds: candidate.map(c => c.docId),
  });
  const accepted = new Set(acceptedDocIds);
  const rows = candidate.filter(c => accepted.has(c.docId)).map(c => c.row);

  if (rows.length > 0) {
    const { error: upsertError } = await db
      .from(TABLE)
      .upsert(rows, { onConflict: "vibepin_user_id,store_key,doc_id" });
    if (upsertError) {
      if (isMissingTableError(upsertError)) return deferred();
      console.error("[user-store PUT] upsert error:", upsertError.message);
      return jsonError(503, "database_unavailable", "Store storage is unavailable");
    }
  }

  // 200 even when some inserts were refused: the client acks (drops) `rejected` from
  // its outbox rather than retrying forever. `code` present only when there is a
  // refusal, so healthy responses are byte-for-byte unchanged.
  return Response.json({
    applied: rows.length,
    skippedStale,
    ...(rejected.length > 0 ? { rejected, code: "quota_exceeded" } : {}),
  });
}

// ── DELETE — batched tombstone ────────────────────────────────────────────────

export async function DELETE(req: Request) {
  const userId = await getUserIdFromBearer(req);
  if (!userId) return unauthorized();

  let body: { storeKey?: unknown; docIds?: unknown; deletedAt?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_request", "Invalid JSON body");
  }

  if (!isValidStoreKey(body.storeKey)) return badStoreKey();
  const storeKey = body.storeKey;

  const validated = validateDocIds(body.docIds);
  if (!validated.ok) return jsonError(400, "bad_request", validated.error);
  const docIds = validated.value;

  const deletedMs = parseMs(body.deletedAt);
  if (deletedMs === null) return jsonError(400, "bad_request", "deletedAt (ISO timestamp) is required");
  const deletedAt = body.deletedAt as string;

  const db = createServerClient();
  const { data: existing, error: selectError } = await db
    .from(TABLE)
    .select("doc_id, updated_at")
    .eq("vibepin_user_id", userId)
    .eq("store_key", storeKey)
    .in("doc_id", docIds);

  if (selectError) {
    if (isMissingTableError(selectError)) return deferred();
    console.error("[user-store DELETE] select error:", selectError.message);
    return jsonError(503, "database_unavailable", "Store storage is unavailable");
  }

  const existingRows = new Map<string, number>(
    (existing ?? []).map(r => [r.doc_id as string, parseMs(r.updated_at as string) ?? 0]),
  );

  // LWW on delete: only rows not newer than the tombstone get tombstoned.
  const eligible = docIds.filter(id => isTombstoneEligible(deletedMs, existingRows.get(id)));
  // Unknown ids: record the tombstone anyway so every device converges on the delete.
  const missing = docIds.filter(id => !existingRows.has(id));

  if (eligible.length > 0) {
    const { error: updateError } = await db
      .from(TABLE)
      .update({ deleted_at: deletedAt, updated_at: deletedAt })
      .eq("vibepin_user_id", userId)
      .eq("store_key", storeKey)
      .in("doc_id", eligible);
    if (updateError) {
      if (isMissingTableError(updateError)) return deferred();
      console.error("[user-store DELETE] update error:", updateError.message);
      return jsonError(503, "database_unavailable", "Store storage is unavailable");
    }
  }

  if (missing.length > 0) {
    const { error: insertError } = await db
      .from(TABLE)
      .upsert(
        missing.map(id => ({
          vibepin_user_id: userId,
          store_key:       storeKey,
          doc_id:          id,
          payload:         {},
          updated_at:      deletedAt,
          created_at:      deletedAt,
          deleted_at:      deletedAt,
        })),
        { onConflict: "vibepin_user_id,store_key,doc_id", ignoreDuplicates: true },
      );
    if (insertError) {
      if (isMissingTableError(insertError)) return deferred();
      console.error("[user-store DELETE] tombstone insert error:", insertError.message);
      return jsonError(503, "database_unavailable", "Store storage is unavailable");
    }
  }

  return Response.json({ applied: eligible.length + missing.length });
}
