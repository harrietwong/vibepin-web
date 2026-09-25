/**
 * POST /api/admin/instagram-auto-dm/rules — create a rule on one of the caller's
 * OWN Instagram connections. New rules default to DISABLED.
 */

import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import { createOwnRule, getOwnInstagramConnection } from "@/lib/server/instagram/commentDmAdmin";
import { parseRuleInput, type RuleInput } from "@/lib/server/instagram/commentDmLogic";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const admin = await requireSuperAdminFromRequest(req);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
  try {
    const conn = await getOwnInstagramConnection(admin.id, connectionId);
    if (!conn) return Response.json({ error: "Unknown connection" }, { status: 404 });
    const parsed = parseRuleInput(body, { partial: false });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const rule = await createOwnRule(admin.id, conn.id, parsed.value as RuleInput);
    return Response.json({ rule }, { status: 201 });
  } catch (err) {
    console.error("[admin/instagram-auto-dm] create rule failed:", (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
