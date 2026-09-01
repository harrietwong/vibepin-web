/**
 * GET /api/generation-jobs/[id] — poll a WP3-P1 generation_jobs row.
 *
 * Auth: bearer token or SSR cookie session (same convention as /api/generate).
 * Ownership: the row's vibepin_user_id must equal the caller — anyone else's job
 * (or a typo'd id) 404s, never leaking existence or another user's results.
 * Reads with the service-role client because the table carries no RLS policy
 * (WP3 design doc §4) — ownership is enforced here in the route, not by Postgres.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getUserIdFromBearer, getUserIdFromCookies } from "@/lib/server/authUser";
import { settleGenerationJob } from "@/lib/server/usage/settleGenerationJob";
import { finalizeGenerationRecord, type GenerationFinalizeStatus } from "@/lib/server/generationRecord";

/**
 * generation_jobs.status → pin_generations.status. Source: migrate_v51_generation_jobs.sql
 * comment block + api/app/worker.py::terminal_status. 'queued'/'running' are not
 * terminal and are excluded — see finalizeTerminalGenerationRecord below.
 */
const TERMINAL_STATUS_MAP: Record<string, GenerationFinalizeStatus> = {
  done: "completed",
  partial: "partial",
  failed: "failed",
};

/** One per-slot entry of generation_jobs.results — same shape settleGenerationJob reads. */
type JobResultRow = { slot?: unknown; status?: unknown; imageUrl?: unknown; error?: unknown };

/**
 * Close out the `pin_generations` row the worker enqueue path left `running`, now
 * that this poll observes a terminal generation_jobs status. Mirrors settleGenerationJob's
 * shape: BEST-EFFORT, never awaited in a way that can reject the response, never
 * throws out to the caller. A finalize problem must never turn a successful poll
 * (the user's images) into a failed one.
 */
async function finalizeTerminalGenerationRecord(
  db: ReturnType<typeof createServerClient>,
  job: { id: string; status: unknown; results: unknown; params: unknown },
): Promise<void> {
  const mapped = typeof job.status === "string" ? TERMINAL_STATUS_MAP[job.status] : undefined;
  if (!mapped) return; // not terminal (queued/running) — nothing to finalize yet

  // The running pin_generations row is keyed on generationRequestId (the client-
  // supplied string echoed into jobParams at enqueue time — see /api/generate's
  // recordRunningWorkerGeneration), NOT job.id (generation_jobs' own uuid PK). Those
  // are two different values; reusing job.id here would silently finalize nothing.
  const paramsObj = job.params && typeof job.params === "object" ? job.params as Record<string, unknown> : null;
  const generationRequestId = paramsObj && typeof paramsObj.generationRequestId === "string"
    ? paramsObj.generationRequestId
    : null;
  if (!generationRequestId) return; // no known join key — nothing to finalize

  const rows: JobResultRow[] = Array.isArray(job.results) ? (job.results as JobResultRow[]) : [];
  // Only counted when the results array itself is present and array-shaped — an
  // absent/malformed results field means "unknown", not "zero", so totalPins/pinUrls
  // are left undefined (omitted from the patch) rather than fabricated as 0/[].
  const hasResults = Array.isArray(job.results);
  const doneUrls = hasResults
    ? rows.filter(r => r.status === "done" && typeof r.imageUrl === "string" && r.imageUrl)
      .map(r => r.imageUrl as string)
    : undefined;
  const totalPins = hasResults ? doneUrls!.length : undefined;

  let errorType: string | undefined;
  let errorMessage: string | undefined;
  if (mapped === "failed" && hasResults) {
    const firstError = rows.find(r => r.status === "failed" && typeof r.error === "string" && r.error);
    if (firstError) {
      errorType = "generation_failed";
      errorMessage = firstError.error as string;
    }
  }

  try {
    await finalizeGenerationRecord(db, {
      generationRequestId,
      status: mapped,
      totalPins,
      pinUrls: doneUrls,
      errorType,
      errorMessage,
    });
  } catch {
    // finalizeGenerationRecord is already total (never throws) — this catch exists so
    // that even a future regression there cannot break the poll response.
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const bearerUser = await getUserIdFromBearer(req).catch(() => null);
  const cookieUser = bearerUser ? null : await getUserIdFromCookies().catch(() => null);
  const userId = bearerUser ?? cookieUser;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const db = createServerClient();
  const { data, error } = await db
    .from("generation_jobs")
    // `params` is selected ONLY to recover generationRequestId — the join key the
    // running pin_generations row was written under at enqueue time (job.id, the
    // generation_jobs primary key, is a DIFFERENT value — see finalizeTerminalGenerationRecord).
    .select("id,status,results,params,vibepin_user_id,usage_reservation_id")
    .eq("id", id)
    .maybeSingle();

  if (error || !data || data.vibepin_user_id !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Close out the `pin_generations` row this job left `running` at enqueue time, now
  // that a terminal generation_jobs status is observable here. See
  // finalizeTerminalGenerationRecord for the terminal-status mapping, the join key,
  // and the idempotency/no-regression guarantees. BEST-EFFORT and awaited (so the
  // history row is durably written before the response goes out on the FIRST poll
  // that observes the terminal status) but the function itself never throws and a
  // failure here must never affect what is returned below.
  await finalizeTerminalGenerationRecord(db, {
    id: data.id as string,
    status: data.status,
    results: data.results,
    params: (data as { params?: unknown }).params,
  });

  // Phase 4I: OPTIONAL, purely additive `usage` block. Present only when the job was
  // metered (has a usage_reservation_id). Clients that don't know about it ignore
  // unknown keys, so this is safe to ship in shadow mode. Cheap: one reservation-row
  // read of the already-tracked counters (requested/consumed/released). A failure to
  // read usage NEVER affects the job payload — the poll still returns status+results.
  const reservationId = (data as { usage_reservation_id?: string | null }).usage_reservation_id ?? null;
  let usage: { reserved: number; settledSuccess: number; settledFailed: number } | undefined;
  if (reservationId) {
    // Close the reservation for a FINISHED job before reading the counters below, so
    // this same response already reflects what was just banked — the user sees the
    // count the moment their images arrive, not one poll later.
    //
    // The worker path had no settle at all until this call existed (the VPS worker is a
    // separate codebase and only ever reserved), which is why metered image jobs used
    // to dangle until they expired. See settleGenerationJob.ts.
    //
    // Idempotent per slot inside the RPC, so polling it repeatedly is harmless, and it
    // never throws — a metering problem must not break a poll that owes the user images.
    await settleGenerationJob({
      reservationId,
      status: data.status as string | null,
      results: data.results,
    });

    const { data: resRow } = await db
      .from("usage_reservations")
      .select("requested_quantity,consumed_quantity,released_quantity")
      .eq("id", reservationId)
      .maybeSingle();
    if (resRow) {
      const r = resRow as { requested_quantity: number; consumed_quantity: number; released_quantity: number };
      usage = {
        reserved: r.requested_quantity,
        settledSuccess: r.consumed_quantity,
        settledFailed: r.released_quantity,
      };
    }
  }

  return NextResponse.json({
    id: data.id,
    status: data.status,
    results: data.results,
    ...(usage ? { usage } : {}),
  });
}
