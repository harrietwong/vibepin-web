/**
 * GET /api/admin/instagram-auto-dm/media?connectionId=… — recent posts (at most 50,
 * last 30 days) of one of the caller's OWN Instagram connections, for the rule's
 * post picker. Read-only.
 */

import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import { getOwnInstagramConnection } from "@/lib/server/instagram/commentDmAdmin";
import { getInstagramAccessToken } from "@/lib/server/instagram/connectionStore";
import { listRecentMedia, MetaGraphError } from "@/lib/server/instagram/commentDm";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const admin = await requireSuperAdminFromRequest(req);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const connectionId = new URL(req.url).searchParams.get("connectionId") ?? "";
  try {
    const conn = await getOwnInstagramConnection(admin.id, connectionId);
    if (!conn?.provider_account_id) return Response.json({ error: "Unknown connection" }, { status: 404 });
    const token = await getInstagramAccessToken(admin.id, conn.id);
    if (!token) return Response.json({ error: "No usable Instagram token, reconnect" }, { status: 409 });
    const media = await listRecentMedia(conn.provider_account_id, token.accessToken);
    return Response.json({ media });
  } catch (err) {
    const status = err instanceof MetaGraphError ? 502 : 500;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
