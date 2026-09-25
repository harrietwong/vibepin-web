/**
 * POST /api/admin/instagram-auto-dm/retry-failed { connectionId } — "Retry failed
 * items" for one of the caller's OWN Instagram connections: `failed` events whose
 * comment is still inside the 7-day private-reply window go back to `claimed`
 * (attempts 0, updated_at far in the past) so the next cron run retries them.
 * Nothing is sent from this request.
 */

import { createServerClient } from "@/lib/supabase";
import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import { getOwnInstagramConnection } from "@/lib/server/instagram/commentDmAdmin";
import { resetRetryableFailedEvents } from "@/lib/server/instagram/commentDmRun";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const admin = await requireSuperAdminFromRequest(req);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { connectionId?: unknown } | null;
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
  try {
    const conn = await getOwnInstagramConnection(admin.id, connectionId);
    if (!conn) return Response.json({ error: "Unknown connection" }, { status: 404 });
    const reset = await resetRetryableFailedEvents(createServerClient(), conn.id);
    return Response.json({ reset });
  } catch (err) {
    console.error("[admin/instagram-auto-dm] retry failed items failed:", (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
