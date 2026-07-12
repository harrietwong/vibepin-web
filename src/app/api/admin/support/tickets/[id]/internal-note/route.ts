/**
 * POST /api/admin/support/tickets/:id/internal-note — admin-only internal
 * note. Never emailed, never exposed through the user-facing API
 * (listMessagesForUser filters on is_internal = false at the query layer).
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { addEvent, addMessage, getTicketById } from "@/lib/support/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const text = body && typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return Response.json({ error: "Note body is required" }, { status: 400 });

  try {
    const ticket = await getTicketById(id);
    if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });

    const message = await addMessage({ ticketId: id, senderType: "admin", senderId: session.user.id, body: text, isInternal: true });
    await addEvent({ ticketId: id, eventType: "internal_note_added", metadata: { messageId: message.id, actor: session.user.id } });

    return Response.json({ message }, { status: 201 });
  } catch (err) {
    console.error("[admin/support/tickets/:id/internal-note POST]", err);
    return Response.json({ error: "Failed to add internal note" }, { status: 500 });
  }
}
