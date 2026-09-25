/**
 * GET /api/admin/instagram-auto-dm — the caller's OWN Instagram connections (with
 * comment-DM scope status), rules and recent events. Super admin only; never
 * returns another user's data.
 */

import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import {
  listOwnInstagramConnections,
  listOwnRules,
  listRecentEvents,
  toConnectionView,
} from "@/lib/server/instagram/commentDmAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const admin = await requireSuperAdminFromRequest(req);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const connections = await listOwnInstagramConnections(admin.id);
    const ids = connections.map(c => c.id);
    const [rules, events] = await Promise.all([listOwnRules(admin.id), listRecentEvents(ids, 100)]);
    return Response.json({
      connections: connections.map(toConnectionView),
      rules: rules.filter(r => ids.includes(r.connectionId)),
      events,
    });
  } catch (err) {
    console.error("[admin/instagram-auto-dm] load failed:", (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
