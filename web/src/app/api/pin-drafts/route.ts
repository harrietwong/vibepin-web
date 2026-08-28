/**
 * /api/pin-drafts — WP0 server-authoritative Pin Draft storage (v38 pin_drafts).
 *
 * GET    ?cursor&limit=100        → { drafts: [{draftId, updatedAt, deletedAt?, payload}], nextCursor? }
 *                                   (updated_at desc, draft_id asc stable order; INCLUDES tombstones so
 *                                    clients can converge local deletes)
 * PUT    { drafts: [{draftId, updatedAt, payload}] } (≤50)
 *                                 → { applied, skippedStale }  (server LWW: incoming.updatedAt < row → skip)
 * DELETE { draftIds: string[], deletedAt } (≤50)
 *                                 → { applied }                (tombstone; stale deletes skipped)
 *
 * Auth: Authorization: Bearer <supabase access token> (getUserIdFromBearer).
 * Degradation (§8.3): table not applied → GET returns empty list, PUT/DELETE return
 * 202 {deferred:true} so the client outbox retries later. Errors are {error, code}.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { resolvePlan } from "@/lib/server/entitlements";
import { checkAllowance, recordUsage } from "@/lib/server/usage";
import { platformName } from "@/lib/social/platforms";
import {
  buildPromotedColumns,
  PROMOTED_COLUMN_KEYS,
  buildScheduleColumns,
  buildScheduledAt,
  blockedScheduleDestinations,
  SCHEDULE_COLUMN_KEYS,
} from "./promote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "pin_drafts";
const MAX_BATCH = 50;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
const MAX_PAYLOAD_BYTES = 200 * 1024; // 200KB per draft payload
const MAX_DRAFTS_PER_USER = 500;      // mirror of pinDraftStore MAX_DRAFTS

type IncomingDraft = { draftId: string; updatedAt: string; payload: Record<string, unknown> };

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonError(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status });
}

function unauthorized(): Response {
  return jsonError(401, "unauthorized", "Unauthorized — include Authorization: Bearer <token>");
}

/** v38 not applied yet → degrade instead of 500 (pattern: pinterest/errors.ts isMissingTableError). */
function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "PGRST205"
    || err.code === "42P01"
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"))
  );
}

/** v41 promoted columns not applied yet → strip them and retry (PostgREST PGRST204 /
 *  "Could not find the '<col>' column of '<table>' in the schema cache"). */
function isMissingColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "PGRST204"
    || err.code === "42703"
    || (message.includes("Could not find the") && message.includes("column"))
    || (message.includes("column") && message.includes("does not exist"))
  );
}

/** Process-lifetime latch: once we learn the v41 promoted columns are absent, skip
 *  them on subsequent writes (self-heals on the next deploy/restart after apply). */
let _promotedColumnsMissing = false;

/** Same latch for the v42 scheduling column (scheduled_at). Independent of v41 so a
 *  partial migration (one set applied, the other not) still degrades correctly. */
let _scheduleColumnsMissing = false;

function deferred(): Response {
  return Response.json({ deferred: true }, { status: 202 });
}

function parseMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// Cursor = base64url({ u: updated_at, d: draft_id }) of the last row of the page.
function encodeCursor(u: string, d: string): string {
  return Buffer.from(JSON.stringify({ u, d }), "utf8").toString("base64url");
}

function decodeCursor(raw: string): { u: string; d: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { u?: unknown; d?: unknown };
    if (typeof parsed.u !== "string" || typeof parsed.d !== "string") return null;
    if (parseMs(parsed.u) === null) return null;
    return { u: parsed.u, d: parsed.d };
  } catch {
    return null;
  }
}

/** Quote a value for a PostgREST or=() filter (timestamps contain ':' and '+'). */
function pgQuote(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

// ── GET — cursor-paginated listing (includes tombstones) ─────────────────────

export async function GET(req: Request) {
  const userId = await getUserIdFromBearer(req);
  if (!userId) return unauthorized();

  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw, 1), MAX_LIMIT);

  const cursorRaw = url.searchParams.get("cursor");
  let cursor: { u: string; d: string } | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) return jsonError(400, "bad_request", "Invalid cursor");
  }

  const db = createServerClient();
  let query = db
    .from(TABLE)
    .select("draft_id, updated_at, deleted_at, payload")
    .eq("vibepin_user_id", userId)
    .order("updated_at", { ascending: false })
    .order("draft_id", { ascending: true })
    .limit(limit + 1);

  if (cursor) {
    // Keyset: updated_at < u OR (updated_at = u AND draft_id > d)
    query = query.or(
      `updated_at.lt.${pgQuote(cursor.u)},and(updated_at.eq.${pgQuote(cursor.u)},draft_id.gt.${pgQuote(cursor.d)})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) return Response.json({ drafts: [] });
    console.error("[pin-drafts GET] select error:", error.message);
    return jsonError(503, "database_unavailable", "Draft storage is unavailable");
  }

  const rows = data ?? [];
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];

  return Response.json({
    drafts: page.map(r => ({
      draftId: r.draft_id as string,
      updatedAt: r.updated_at as string,
      ...(r.deleted_at ? { deletedAt: r.deleted_at as string } : {}),
      payload: r.payload as Record<string, unknown>,
    })),
    ...(hasMore && last ? { nextCursor: encodeCursor(last.updated_at as string, last.draft_id as string) } : {}),
  });
}

// ── PUT — batched LWW upsert ──────────────────────────────────────────────────

export async function PUT(req: Request) {
  const userId = await getUserIdFromBearer(req);
  if (!userId) return unauthorized();

  let body: { drafts?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_request", "Invalid JSON body");
  }

  const raw = Array.isArray(body.drafts) ? body.drafts : null;
  if (!raw || raw.length === 0) return jsonError(400, "bad_request", "drafts array is required");
  if (raw.length > MAX_BATCH) return jsonError(400, "bad_request", `At most ${MAX_BATCH} drafts per request`);

  const incoming: IncomingDraft[] = [];
  for (const item of raw) {
    const d = item as Partial<IncomingDraft> | null;
    if (
      !d || typeof d.draftId !== "string" || !d.draftId || d.draftId.length > 200
      || parseMs(d.updatedAt) === null
      || !d.payload || typeof d.payload !== "object" || Array.isArray(d.payload)
    ) {
      return jsonError(400, "bad_request", "Each draft needs draftId, updatedAt (ISO) and payload (object)");
    }
    if (Buffer.byteLength(JSON.stringify(d.payload), "utf8") > MAX_PAYLOAD_BYTES) {
      return jsonError(413, "payload_too_large", `Draft ${d.draftId} payload exceeds 200KB`);
    }
    incoming.push({ draftId: d.draftId, updatedAt: d.updatedAt as string, payload: d.payload as Record<string, unknown> });
  }

  const db = createServerClient();
  const ids = incoming.map(d => d.draftId);

  // Select scheduled_at too so we can detect a draft going from NOT-scheduled to
  // scheduled (the metering transition). If the v42 column is not applied yet the
  // select fails with a missing-column error → retry without it and skip scheduled
  // metering entirely (scheduledAtAvailable=false).
  type ExistingRow = { draft_id: string; updated_at: string; scheduled_at?: string | null };
  let scheduledAtAvailable = !_scheduleColumnsMissing;
  let existing: ExistingRow[] = [];
  {
    // Dynamic column string → run the select through an untyped view of the client
    // so PostgREST's compile-time column parser doesn't reject the runtime string.
    const selectCols = async (cols: string) =>
      (await db
        .from(TABLE)
        .select(cols)
        .eq("vibepin_user_id", userId)
        .in("draft_id", ids)) as unknown as { data: ExistingRow[] | null; error: { code?: string; message?: string } | null };

    let { data, error: selectError } = await selectCols(
      scheduledAtAvailable ? "draft_id, updated_at, scheduled_at" : "draft_id, updated_at",
    );
    if (selectError && scheduledAtAvailable && isMissingColumnError(selectError)) {
      _scheduleColumnsMissing = true;
      scheduledAtAvailable = false;
      ({ data, error: selectError } = await selectCols("draft_id, updated_at"));
    }
    if (selectError) {
      if (isMissingTableError(selectError)) return deferred();
      console.error("[pin-drafts PUT] select error:", selectError.message);
      return jsonError(503, "database_unavailable", "Draft storage is unavailable");
    }
    existing = data ?? [];
  }

  const existingMs = new Map<string, number>(
    existing.map(r => [r.draft_id, parseMs(r.updated_at) ?? 0]),
  );
  // draftId → whether a scheduled_at was ALREADY set on the stored row.
  const existingScheduled = new Map<string, boolean>(
    existing.map(r => [r.draft_id, !!(r.scheduled_at)]),
  );

  const rows: Record<string, unknown>[] = [];
  let skippedStale = 0;
  // Drafts transitioning from NOT-scheduled → scheduled in THIS request (each is
  // one scheduled_post metered event). Only tracked when the scheduled_at column
  // exists; skipped entirely otherwise.
  const newlyScheduledDraftIds: string[] = [];
  // Drafts in this request that ask to be scheduled to a destination we cannot
  // honour at due time. Collected, then REFUSED below — never quietly stripped.
  const unschedulable: Array<{ draftId: string; providers: string[] }> = [];
  for (const d of incoming) {
    const rowMs = existingMs.get(d.draftId);
    const incMs = parseMs(d.updatedAt)!;
    if (rowMs !== undefined && incMs < rowMs) { skippedStale++; continue; } // server LWW
    const p = d.payload;
    if (scheduledAtAvailable) {
      const incomingScheduledAt = buildScheduledAt(p);
      const wasScheduled = existingScheduled.get(d.draftId) ?? false;
      if (incomingScheduledAt && !wasScheduled) newlyScheduledDraftIds.push(d.draftId);
      // A future-dated Pin may only name destinations whose intent we can actually
      // persist and replay. That is now every platform with a publish path: intent
      // rides the draft as scheduledDestinations[] and the due worker reads it back.
      // What is still refused is a platform we cannot execute at due time (liveSchedule
      // false — TikTok today), because accepting it would drop the choice in silence.
      // Refusing here (not just in the UI) is the point — the client can be stale or
      // bypassed entirely. The rule reads scheduledDestinations[], the field that is
      // actually persisted; it used to read a `socialDestinations` field nothing wrote,
      // so it never refused anything at all.
      const blocked = blockedScheduleDestinations(p);
      if (blocked.length) unschedulable.push({ draftId: d.draftId, providers: blocked });
    }
    rows.push({
      vibepin_user_id: userId,
      draft_id:        d.draftId,
      payload:         p,
      status:          typeof p.status === "string" ? p.status : null,
      updated_at:      d.updatedAt,
      created_at:      parseMs(p.createdAt) !== null ? (p.createdAt as string) : new Date().toISOString(),
      archived_at:     parseMs(p.archivedAt) !== null ? (p.archivedAt as string) : null,
      deleted_at:      null, // a newer PUT revives a tombstoned draft
      // v41 promoted Creative-Intelligence columns (payload stays authority).
      ...(_promotedColumnsMissing ? {} : buildPromotedColumns(p)),
      // v42 promoted scheduling column. NOTE: publish_claimed_at is intentionally NOT
      // written here — it is a cron-only claim lock. Because this is a partial-column
      // upsert (PostgREST only updates the keys present in each row object), omitting
      // publish_claimed_at leaves any existing lock on the row untouched.
      ...(_scheduleColumnsMissing ? {} : buildScheduleColumns(p)),
    });
  }

  // ── Schedulable-destination gate ──────────────────────────────────────────
  // Before the upsert, so an unsupported scheduled destination is never persisted
  // and never silently discarded. 422 (not 400): the request is well-formed, the
  // capability is temporarily unavailable.
  if (unschedulable.length > 0) {
    const names = [...new Set(unschedulable.flatMap(u => u.providers))]
      .map(p => platformName(p as Parameters<typeof platformName>[0]));
    return Response.json(
      {
        error: "destination_not_schedulable",
        code: "destination_not_schedulable",
        drafts: unschedulable,
        userMessage:
          names.length === 1
            ? `Scheduling to ${names[0]} is temporarily unavailable. You can still publish now.`
            : `Scheduling to ${names.join(" and ")} is temporarily unavailable. You can still publish now.`,
      },
      { status: 422 },
    );
  }

  // ── Scheduled-post quota gate ─────────────────────────────────────────────
  // Enforce BEFORE the upsert so an over-limit schedule is never persisted. Only
  // when this batch introduces new schedules. Publish-now is a different path
  // (this endpoint only stores scheduled_at derived from plannedAt/scheduledDate)
  // and is never metered here. Fails OPEN on a metering error.
  if (newlyScheduledDraftIds.length > 0) {
    try {
      const plan = await resolvePlan(userId);
      const allowance = await checkAllowance(userId, "scheduled_post", newlyScheduledDraftIds.length, plan);
      if (!allowance.allowed) {
        return Response.json(
          {
            error: "quota_exceeded",
            code: "quota_exceeded",
            quota: { used: allowance.used, limit: allowance.limit },
            userMessage:
              "You've reached this month's scheduled-post limit for your plan. Upgrade your plan or wait until next month to schedule more.",
          },
          { status: 429 },
        );
      }
    } catch (err) {
      console.error("[pin-drafts PUT] scheduled_post allowance error:", (err as Error)?.message ?? String(err));
    }
  }

  if (rows.length > 0) {
    let { error: upsertError } = await db
      .from(TABLE)
      .upsert(rows, { onConflict: "vibepin_user_id,draft_id" });

    // v41/v42 not applied yet: strip the promoted columns and retry once so the base
    // draft sync keeps working unchanged until the migration lands. A single missing
    // column raises PGRST204 for whichever column PostgREST checks first, so latch BOTH
    // uncertain sets on any missing-column error and strip both before the retry — the
    // one that actually exists is simply re-derived and re-added on the next request
    // after a restart (the latches self-heal on redeploy).
    if (upsertError && (!_promotedColumnsMissing || !_scheduleColumnsMissing) && isMissingColumnError(upsertError)) {
      _promotedColumnsMissing = true;
      _scheduleColumnsMissing = true;
      for (const row of rows) {
        for (const key of PROMOTED_COLUMN_KEYS) delete (row as Record<string, unknown>)[key];
        for (const key of SCHEDULE_COLUMN_KEYS) delete (row as Record<string, unknown>)[key];
      }
      ({ error: upsertError } = await db
        .from(TABLE)
        .upsert(rows, { onConflict: "vibepin_user_id,draft_id" }));
    }

    if (upsertError) {
      if (isMissingTableError(upsertError)) return deferred();
      console.error("[pin-drafts PUT] upsert error:", upsertError.message);
      return jsonError(503, "database_unavailable", "Draft storage is unavailable");
    }
    await enforceDraftCap(db, userId);

    // Meter each newly-scheduled draft AFTER a successful persist. Idempotency key
    // = scheduled_post:<userId>:<draftId> (userId-scoped so a client-generated
    // draftId cannot collide across users) — one metered schedule per draft ever
    // (re-scheduling / retrying the same draft never double-counts). Skip if the
    // upsert fallback dropped the scheduled_at column (schedule not persisted).
    // Awaited so the inserts complete before the serverless response returns.
    if (scheduledAtAvailable && !_scheduleColumnsMissing && newlyScheduledDraftIds.length > 0) {
      await Promise.all(
        newlyScheduledDraftIds.map(draftId =>
          recordUsage({
            ownerId: userId,
            usageType: "scheduled_post",
            operation: "consume",
            quantity: 1,
            referenceType: "pin_draft",
            referenceId: draftId,
            idempotencyKey: `scheduled_post:${userId}:${draftId}`,
          }),
        ),
      );
    }
  }

  return Response.json({ applied: rows.length, skippedStale });
}

/** Mirror pinDraftStore's MAX_DRAFTS: beyond 500 live drafts, tombstone the oldest (by payload createdAt). */
async function enforceDraftCap(db: ReturnType<typeof createServerClient>, userId: string): Promise<void> {
  const { data, error } = await db
    .from(TABLE)
    .select("draft_id, created_at")
    .eq("vibepin_user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("draft_id", { ascending: true });
  if (error || !data || data.length <= MAX_DRAFTS_PER_USER) return;

  const excess = data.slice(MAX_DRAFTS_PER_USER).map(r => r.draft_id as string);
  const now = new Date().toISOString();
  const { error: updateError } = await db
    .from(TABLE)
    .update({ deleted_at: now, updated_at: now })
    .eq("vibepin_user_id", userId)
    .in("draft_id", excess);
  if (updateError) console.error("[pin-drafts PUT] cap enforcement error:", updateError.message);
}

// ── DELETE — batched tombstone ────────────────────────────────────────────────

export async function DELETE(req: Request) {
  const userId = await getUserIdFromBearer(req);
  if (!userId) return unauthorized();

  let body: { draftIds?: unknown; deletedAt?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_request", "Invalid JSON body");
  }

  const draftIds = Array.isArray(body.draftIds)
    ? (body.draftIds as unknown[]).filter((x): x is string => typeof x === "string" && !!x && x.length <= 200)
    : [];
  if (draftIds.length === 0) return jsonError(400, "bad_request", "draftIds array is required");
  if (draftIds.length > MAX_BATCH) return jsonError(400, "bad_request", `At most ${MAX_BATCH} draftIds per request`);
  const deletedMs = parseMs(body.deletedAt);
  if (deletedMs === null) return jsonError(400, "bad_request", "deletedAt (ISO timestamp) is required");
  const deletedAt = body.deletedAt as string;

  const db = createServerClient();
  const { data: existing, error: selectError } = await db
    .from(TABLE)
    .select("draft_id, updated_at")
    .eq("vibepin_user_id", userId)
    .in("draft_id", draftIds);

  if (selectError) {
    if (isMissingTableError(selectError)) return deferred();
    console.error("[pin-drafts DELETE] select error:", selectError.message);
    return jsonError(503, "database_unavailable", "Draft storage is unavailable");
  }

  const existingRows = new Map<string, number>(
    (existing ?? []).map(r => [r.draft_id as string, parseMs(r.updated_at as string) ?? 0]),
  );

  // LWW on delete: only rows not newer than the tombstone get tombstoned.
  const eligible = draftIds.filter(id => existingRows.has(id) && existingRows.get(id)! <= deletedMs);
  // Unknown ids: record the tombstone anyway so every device converges on the delete.
  const missing = draftIds.filter(id => !existingRows.has(id));

  if (eligible.length > 0) {
    const { error: updateError } = await db
      .from(TABLE)
      .update({ deleted_at: deletedAt, updated_at: deletedAt })
      .eq("vibepin_user_id", userId)
      .in("draft_id", eligible);
    if (updateError) {
      if (isMissingTableError(updateError)) return deferred();
      console.error("[pin-drafts DELETE] update error:", updateError.message);
      return jsonError(503, "database_unavailable", "Draft storage is unavailable");
    }
  }

  if (missing.length > 0) {
    const { error: insertError } = await db
      .from(TABLE)
      .upsert(
        missing.map(id => ({
          vibepin_user_id: userId,
          draft_id:        id,
          payload:         {},
          status:          null,
          updated_at:      deletedAt,
          created_at:      deletedAt,
          archived_at:     null,
          deleted_at:      deletedAt,
        })),
        { onConflict: "vibepin_user_id,draft_id", ignoreDuplicates: true },
      );
    if (insertError) {
      if (isMissingTableError(insertError)) return deferred();
      console.error("[pin-drafts DELETE] tombstone insert error:", insertError.message);
      return jsonError(503, "database_unavailable", "Draft storage is unavailable");
    }
  }

  return Response.json({ applied: eligible.length + missing.length });
}
