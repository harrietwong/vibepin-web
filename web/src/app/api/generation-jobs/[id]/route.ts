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
    .select("id,status,results,vibepin_user_id")
    .eq("id", id)
    .maybeSingle();

  if (error || !data || data.vibepin_user_id !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    id: data.id,
    status: data.status,
    results: data.results,
  });
}
