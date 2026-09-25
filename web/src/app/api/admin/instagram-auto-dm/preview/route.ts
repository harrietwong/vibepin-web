/**
 * POST /api/admin/instagram-auto-dm/preview { connectionId } — DRY RUN for one of the
 * caller's OWN connections: scans comments and lists who WOULD get a DM under which
 * rule. Sends nothing and writes nothing. Every rule of the connection is treated
 * as enabled, so a new (disabled) rule can be checked before switching it on.
 */

import { createServerClient } from "@/lib/supabase";
import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import { getOwnInstagramConnection, listOwnRules } from "@/lib/server/instagram/commentDmAdmin";
import { getInstagramAccessToken } from "@/lib/server/instagram/connectionStore";
import { runCommentDmForConnection } from "@/lib/server/instagram/commentDmRun";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Same 25s start-new-work budget as the cron (see its route): pages are 15s-bounded.
const PREVIEW_BUDGET_MS = 25_000;

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const admin = await requireSuperAdminFromRequest(req);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { connectionId?: unknown } | null;
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
  try {
    const conn = await getOwnInstagramConnection(admin.id, connectionId);
    if (!conn) return Response.json({ error: "Unknown connection" }, { status: 404 });
    const rules = (await listOwnRules(admin.id))
      .filter(r => r.connectionId === conn.id)
      .map(r => ({ ...r, enabled: true }));
    const result = await runCommentDmForConnection(
      {
        db: createServerClient(),
        getToken: async (userId, id) => {
          const t = await getInstagramAccessToken(userId, id);
          return t ? { accessToken: t.accessToken } : null;
        },
      },
      conn,
      rules,
      { dryRun: true, deadlineAt: startedAt + PREVIEW_BUDGET_MS },
    );
    return Response.json({ result });
  } catch (err) {
    console.error("[admin/instagram-auto-dm] preview failed:", (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
