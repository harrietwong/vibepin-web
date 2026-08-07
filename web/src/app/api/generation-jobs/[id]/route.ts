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
    .select("id,status,results,vibepin_user_id,usage_reservation_id")
    .eq("id", id)
    .maybeSingle();

  if (error || !data || data.vibepin_user_id !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

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
