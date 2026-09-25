/**
 * PATCH / DELETE /api/admin/instagram-auto-dm/rules/[id] — edit or remove one of the
 * caller's OWN rules (a foreign or unknown id is a 404).
 */

import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";
import { deleteOwnRule, getOwnRule, updateOwnRule } from "@/lib/server/instagram/commentDmAdmin";
import { parseRuleInput } from "@/lib/server/instagram/commentDmLogic";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const admin = await requireSuperAdminFromRequest(req);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  try {
    const existing = await getOwnRule(admin.id, id);
    if (!existing) return Response.json({ error: "Unknown rule" }, { status: 404 });
    const parsed = parseRuleInput(body, { partial: true });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const patch = { ...parsed.value };
    // Public reply on requires text — check against the stored values too.
    const publicOn = patch.publicReplyEnabled ?? existing.publicReplyEnabled;
    const publicText = "publicReplyText" in patch ? patch.publicReplyText : existing.publicReplyText;
    if (publicOn && !publicText) {
      return Response.json({ error: "Public reply text is required when public reply is on" }, { status: 400 });
    }
    const rule = await updateOwnRule(admin.id, id, patch);
    if (!rule) return Response.json({ error: "Unknown rule" }, { status: 404 });
    return Response.json({ rule });
  } catch (err) {
    console.error("[admin/instagram-auto-dm] update rule failed:", (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const admin = await requireSuperAdminFromRequest(req);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  try {
    const existing = await getOwnRule(admin.id, id);
    if (!existing) return Response.json({ error: "Unknown rule" }, { status: 404 });
    await deleteOwnRule(admin.id, id);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[admin/instagram-auto-dm] delete rule failed:", (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
