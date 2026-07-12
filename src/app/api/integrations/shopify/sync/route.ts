/**
 * Shopify sync chunk driver (WP3, §6.6). Bearer.
 *
 * POST { connectionId, fresh? } processes one sync chunk and returns the §6.6
 * result. The client re-POSTs while `hasMore` is true until a terminal state.
 *
 * freshRun decision (§3.4 state machine): a new run starts from a fresh state
 * (idle / completed / limit_reached) or when the caller forces `fresh: true`;
 * an `error` state resumes from its kept cursor; a live `running` lock is left
 * to the engine's CAS (→ SyncInProgressError → 409). Missing table / missing /
 * disconnected connection → 409 not_connected.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearer } from "@/lib/server/authUser";
import { getConnection, StoreDatabaseError } from "@/lib/server/shopify/connectionStore";
import {
  runSyncChunk,
  SyncInProgressError,
  SyncNotConnectedError,
  SyncSupersededError,
} from "@/lib/server/shopify/syncEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  let connectionId: string | null = null;
  let fresh = false;
  try {
    const body = (await req.json()) as { connectionId?: string; fresh?: boolean };
    connectionId = body?.connectionId ?? null;
    fresh = body?.fresh === true;
  } catch {
    /* invalid body → handled below */
  }
  if (!connectionId) {
    return NextResponse.json(
      { error: "connectionId is required", code: "bad_request" },
      { status: 400 },
    );
  }

  try {
    const conn = await getConnection(uid, connectionId);
    if (!conn || conn.disconnected_at != null || conn.status === "disconnected") {
      return NextResponse.json(
        { error: "Shopify store is not connected", code: "not_connected" },
        { status: 409 },
      );
    }

    const s = conn.sync_status;
    const freshRun = fresh || s === "idle" || s === "completed" || s === "limit_reached";

    const result = await runSyncChunk(uid, connectionId, { freshRun });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SyncInProgressError || err instanceof SyncSupersededError) {
      return NextResponse.json({ error: err.message, code: "sync_in_progress" }, { status: 409 });
    }
    if (err instanceof SyncNotConnectedError) {
      return NextResponse.json({ error: err.message, code: "not_connected" }, { status: 409 });
    }
    if (err instanceof StoreDatabaseError) {
      return NextResponse.json(
        { error: "Shopify store storage is unavailable", code: "database_unavailable" },
        { status: 503 },
      );
    }
    console.error("[shopify/sync] chunk failed:", (err as Error).message);
    return NextResponse.json(
      { error: "Sync failed", code: "server_error" },
      { status: 500 },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
