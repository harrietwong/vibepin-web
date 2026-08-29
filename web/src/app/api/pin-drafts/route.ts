/**
 * /api/pin-drafts — WP0 server-authoritative Pin Draft storage (v38 pin_drafts).
 *
 * GET    ?cursor&limit=100        → { drafts: [{draftId, updatedAt, deletedAt?, payload}], nextCursor? }
 *                                   (updated_at desc, draft_id asc stable order; INCLUDES tombstones so
 *                                    clients can converge local deletes)
 * PUT    { drafts: [{draftId, updatedAt, payload}] } (≤50)
 *                                 → { applied, skippedStale }  (server LWW: incoming.updatedAt < row → skip)
 *                                 → 409 {code:"stale", stale:[{draftId, current}], current} when a row
 *                                   changed between the LWW read and the write (see the conditional write)
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
  unavailableScheduleDestinations,
  type ScheduleTarget,
} from "@/lib/server/social/scheduledDestinationsAvailable";
import {
  buildPromotedColumns,
  PROMOTED_COLUMN_KEYS,
  buildScheduleColumns,
  buildScheduledAt,
  blockedScheduleDestinations,
  requiredScheduleConnectionIds,
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
  // The RAW updated_at each draft was observed with — the compare-and-set value of
  // the conditional write below. Stored verbatim (never re-parsed or re-formatted):
  // the write predicate is a string equality against the same column, so anything
  // that changes the text turns the CAS into a permanent mismatch. A row present
  // with a NULL updated_at maps to null and is matched with `.is` instead of `.eq`.
  const observedUpdatedAt = new Map<string, string | null>(
    existing.map(r => [r.draft_id, (r.updated_at ?? null) as string | null]),
  );
  // draftId → whether a scheduled_at was ALREADY set on the stored row.
  const existingScheduled = new Map<string, boolean>(
    existing.map(r => [r.draft_id, !!(r.scheduled_at)]),
  );

  // Each entry pairs the columns to write with the draft they belong to, so the
  // conditional write below can aim its predicate at exactly that row.
  const rows: Array<{ draftId: string; row: Record<string, unknown> }> = [];
  let skippedStale = 0;
  // Drafts transitioning from NOT-scheduled → scheduled in THIS request (each is
  // one scheduled_post metered event). Only tracked when the scheduled_at column
  // exists; skipped entirely otherwise.
  const newlyScheduledDraftIds: string[] = [];
  // Drafts in this request that ask to be scheduled to a destination we cannot
  // honour at due time. Collected, then REFUSED below — never quietly stripped.
  const unschedulable: Array<{ draftId: string; providers: string[] }> = [];
  // Drafts being scheduled, with the connection ids their schedule will publish
  // through. Validated in ONE batch after the loop (see the destination gate).
  const scheduleTargets: ScheduleTarget[] = [];
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
      // A scheduled draft must also name accounts that still EXIST and can still
      // publish. Collected here (cheap, pure) and resolved in one batch below —
      // the actual lookup is a database read and must not run per draft.
      if (incomingScheduledAt) {
        const connectionIds = requiredScheduleConnectionIds(p);
        if (connectionIds.length) scheduleTargets.push({ draftId: d.draftId, connectionIds });
      }
    }
    rows.push({ draftId: d.draftId, row: {
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
    } });
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

  // ── Destination-EXISTS gate ───────────────────────────────────────────────
  // A schedule WRITTEN after the account went away. A tab open since before the
  // removal would otherwise persist a schedule naming a row that no longer
  // exists, and the cron would inherit an orphan no screen can explain. The
  // client cannot be the authority here, because a stale client IS the failure.
  //
  // This validation and the write below are SEPARATE TRANSACTIONS, so a removal
  // committing between them is accepted by both — and by the atomic remove (v67)
  // too, which found no schedule to block on at the time it ran. That
  // interleaving is an ACCEPTED RESIDUAL (owner decision, 2026-08-29): the whole
  // consequence is a schedule that fails at publish time with
  // `target_disconnected`, a visible failure on a Content that was never posted.
  // No duplicate post, no silent success. See scheduledDestinationsAvailable.ts.
  //
  // 422, like the gate above: the request is well formed, the destination is not
  // usable. A distinct code (`destination_unavailable`) because the remedy is
  // different — reconnect or pick another account, not "wait for the platform".
  if (scheduleTargets.length > 0) {
    const unavailable = await unavailableScheduleDestinations(userId, scheduleTargets);
    if (unavailable.length > 0) {
      const names = [...new Set(
        unavailable.map(u => (u.provider ? platformName(u.provider) : null)).filter((n): n is string => !!n),
      )];
      const disconnected = unavailable.some(u => u.reason === "disconnected");
      const userMessage = names.length === 0
        // The id resolves to nothing at all, so there is no platform to name.
        ? "One of the accounts this schedule publishes to is no longer connected. Pick another account, then schedule again."
        : disconnected
          ? `Your ${names.join(" and ")} account is no longer connected, so this can't be scheduled. Reconnect it, or pick another account.`
          : `The ${names.join(" and ")} account this schedule publishes to no longer exists. Pick another account, then schedule again.`;
      return Response.json(
        {
          error: "destination_unavailable",
          code: "destination_unavailable",
          drafts: unavailable,
          userMessage,
        },
        { status: 422 },
      );
    }
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

  // ── Conditional write (compare-and-set on updated_at) ─────────────────────
  // This used to be one unconditional upsert, and that is what let a published
  // schedule disappear. The sequence: a PUT reads the row, passes the LWW check
  // above, and then — while it is still validating destinations and quota — the
  // cron CAS-writes destinationResults and clears the schedule (or Remove
  // CAS-cancels it). The already-admitted PUT then lands and overwrites the row
  // with its own, older payload: the published results vanish and scheduled_at
  // comes back, so the pin is published a second time (or survives its own
  // removal). CAS on the cron and cancel writers cannot prevent this — they win
  // their own race and are then simply overwritten by a blind later write.
  //
  // So the LWW decision is no longer a read followed by a hope. Every write
  // carries the updated_at it decided against:
  //   row present at read → UPDATE … WHERE updated_at = <observed>  (`.is` for null)
  //   row absent at read  → INSERT, and a 23505 unique violation means someone
  //                         created it meanwhile
  // Either shape matching nothing means the row moved under us: that draft is not
  // written at all and comes back as 409 stale with the CURRENT row, so the client
  // can merge against what is actually stored and retry. Scheduled and unscheduled
  // drafts alike — an unscheduled draft carries destinationResults too.
  //
  // Per draft, not per batch: PostgREST cannot attach a different predicate to each
  // row of a bulk upsert. The writes are independent (there is no transaction to
  // roll back), so a conflict on one draft never discards a sibling's write.
  const staleConflicts: Array<{ draftId: string; current: CurrentRow | null }> = [];
  const written: string[] = [];

  for (const { draftId, row } of rows) {
    const observed = observedUpdatedAt.get(draftId) ?? null;
    const exists = observedUpdatedAt.has(draftId);

    // One attempt = the conditional write, re-runnable for the missing-column retry.
    // Returns the error (if any) and whether the predicate matched a row.
    const attempt = async (): Promise<{ error: { code?: string; message?: string } | null; matched: boolean }> => {
      if (exists) {
        let q = db.from(TABLE).update(row).eq("vibepin_user_id", userId).eq("draft_id", draftId);
        // `updated_at = NULL` is never true in SQL, so a null observation has to be
        // expressed as IS NULL or the write could never match its own row.
        q = observed === null ? q.is("updated_at", null) : q.eq("updated_at", observed);
        const { data, error } = await q.select("draft_id");
        return { error: error ?? null, matched: (data?.length ?? 0) > 0 };
      }
      const { error } = await db.from(TABLE).insert(row);
      return { error: error ?? null, matched: !error };
    };

    let { error: writeError, matched } = await attempt();

    // v41/v42 not applied yet: strip the promoted columns and retry once so the base
    // draft sync keeps working unchanged until the migration lands. A single missing
    // column raises PGRST204 for whichever column PostgREST checks first, so latch BOTH
    // uncertain sets on any missing-column error and strip both before the retry — the
    // one that actually exists is simply re-derived and re-added on the next request
    // after a restart (the latches self-heal on redeploy). Unchanged by the CAS: the
    // retry re-runs the SAME predicate, so it cannot smuggle a blind write back in.
    if (writeError && (!_promotedColumnsMissing || !_scheduleColumnsMissing) && isMissingColumnError(writeError)) {
      _promotedColumnsMissing = true;
      _scheduleColumnsMissing = true;
      for (const r of rows) {
        for (const key of PROMOTED_COLUMN_KEYS) delete r.row[key];
        for (const key of SCHEDULE_COLUMN_KEYS) delete r.row[key];
      }
      ({ error: writeError, matched } = await attempt());
    }

    if (writeError) {
      if (isMissingTableError(writeError)) return deferred();
      // The row was created between our read and our insert. That is the insert
      // half of the same race, and it gets the same answer as a lost CAS.
      if (isUniqueViolation(writeError)) {
        staleConflicts.push({ draftId, current: await readCurrentRow(db, userId, draftId, scheduledAtAvailable) });
        continue;
      }
      console.error("[pin-drafts PUT] write error:", writeError.message);
      return jsonError(503, "database_unavailable", "Draft storage is unavailable");
    }

    if (!matched) {
      // Predicate matched nothing: the row's updated_at is no longer what we read.
      staleConflicts.push({ draftId, current: await readCurrentRow(db, userId, draftId, scheduledAtAvailable) });
      continue;
    }
    written.push(draftId);
  }

  if (written.length > 0) {
    await enforceDraftCap(db, userId);

    // Meter each newly-scheduled draft AFTER a successful persist. Idempotency key
    // = scheduled_post:<userId>:<draftId> (userId-scoped so a client-generated
    // draftId cannot collide across users) — one metered schedule per draft ever
    // (re-scheduling / retrying the same draft never double-counts). Skip if the
    // write fallback dropped the scheduled_at column (schedule not persisted).
    // Restricted to drafts that were ACTUALLY written: a draft whose CAS lost was
    // not scheduled by this request, and charging it would bill a schedule that
    // does not exist. Awaited so the inserts complete before the response returns.
    const meterable = newlyScheduledDraftIds.filter(id => written.includes(id));
    if (scheduledAtAvailable && !_scheduleColumnsMissing && meterable.length > 0) {
      await Promise.all(
        meterable.map(draftId =>
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

  // 409 when anything lost its CAS. The non-conflicted drafts of the same batch
  // were already applied and are reported in `applied` — they are independent
  // writes, and re-sending them would be the blind overwrite we just removed.
  // `current` mirrors stale[0] so a single-draft client can read the specced
  // shape without unpacking the array.
  if (staleConflicts.length > 0) {
    return Response.json(
      {
        error: "Draft changed on the server since it was read — merge and retry",
        code: "stale",
        stale: staleConflicts,
        current: staleConflicts[0].current,
        applied: written.length,
        skippedStale,
      },
      { status: 409 },
    );
  }

  return Response.json({ applied: written.length, skippedStale });
}

/** The row shape returned to a client whose write lost the CAS. */
type CurrentRow = {
  payload: Record<string, unknown> | null;
  updated_at: string | null;
  scheduled_at: string | null;
  /**
   * The tombstone marker, and the reason it must be here. A DELETE writes ONLY the
   * columns (`deleted_at` + `updated_at`); it never rewrites `payload`. So a client
   * handed just the payload cannot tell a concurrently-deleted row from a live one:
   * it re-bases onto a payload that still looks alive, retries, and the draft the
   * merchant deleted on another device stays on this one. Nothing else in the 409
   * body carries this.
   */
  deleted_at: string | null;
};

/** 23505 = unique_violation: our INSERT hit the (vibepin_user_id, draft_id) key. */
function isUniqueViolation(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "23505" || (err.message ?? "").includes("duplicate key value");
}

/**
 * Re-read the row a losing write was aiming at, so the 409 can hand the client the
 * state it must merge against instead of just saying "no".
 *
 * `scheduled_at` is only selected when the v42 column is known to exist — asking for
 * it on a database without it would turn the conflict response itself into a 500.
 * `deleted_at` needs no such latch: the GET path selects it unconditionally, so the
 * column is guaranteed wherever this table exists.
 * A null result (the row vanished entirely between the failed write and this read)
 * is still a conflict; the client gives up for this cycle rather than guessing.
 */
async function readCurrentRow(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  draftId: string,
  scheduledAtAvailable: boolean,
): Promise<CurrentRow | null> {
  const cols = scheduledAtAvailable
    ? "payload, updated_at, deleted_at, scheduled_at"
    : "payload, updated_at, deleted_at";
  const { data, error } = (await db
    .from(TABLE)
    .select(cols)
    .eq("vibepin_user_id", userId)
    .eq("draft_id", draftId)
    .maybeSingle()) as unknown as {
      data: { payload?: unknown; updated_at?: unknown; scheduled_at?: unknown; deleted_at?: unknown } | null;
      error: { message?: string } | null;
    };
  if (error || !data) return null;
  return {
    payload:      (data.payload ?? null) as Record<string, unknown> | null,
    updated_at:   (data.updated_at ?? null) as string | null,
    scheduled_at: (data.scheduled_at ?? null) as string | null,
    deleted_at:   (data.deleted_at ?? null) as string | null,
  };
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
