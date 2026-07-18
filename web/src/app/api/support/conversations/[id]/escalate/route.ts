/**
 * POST /api/support/conversations/:id/escalate — "I still need help" / user
 * explicitly asks for a human. Idempotent (PRD §14: re-clicking after an
 * already-escalated conversation must not create a duplicate escalation).
 */

import { getUserFromBearer } from "@/lib/server/superAdmin";
import { getTicketById } from "@/lib/support/db";
import { escalateConversation } from "@/lib/support/escalation";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const reason = body && typeof (body as { reason?: unknown }).reason === "string" ? (body as { reason: string }).reason.trim() : null;

  try {
    const ticket = await getTicketById(id);
    if (!ticket || ticket.userId !== user.id) return Response.json({ error: "Not found" }, { status: 404 });

    const result = await escalateConversation(id, reason || "user_requested_human");
    return Response.json({ escalated: result.escalated, accountEmail: result.accountEmail ?? user.email ?? null });
  } catch (err) {
    console.error("[support/conversations/:id/escalate POST]", err);
    return Response.json({ error: "Failed to escalate conversation" }, { status: 500 });
  }
}
