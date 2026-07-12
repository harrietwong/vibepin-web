/**
 * POST /api/support/tickets/:id/messages — user follow-up reply on their own
 * ticket. Always non-internal (users can never write internal notes).
 */

import { getUserFromBearer } from "@/lib/server/superAdmin";
import { addEvent, addMessage, getTicketById, updateTicket } from "@/lib/support/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const text = body && typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return Response.json({ error: "Message body is required" }, { status: 400 });

  try {
    const ticket = await getTicketById(id);
    if (!ticket || ticket.userId !== user.id) return Response.json({ error: "Not found" }, { status: 404 });

    const message = await addMessage({ ticketId: id, senderType: "user", senderId: user.id, body: text, isInternal: false });
    await addEvent({ ticketId: id, eventType: "user_replied", metadata: { messageId: message.id } });

    // A user reply on a resolved/closed ticket doesn't silently reopen it —
    // move it back to "Open" only from the active "waiting for user" state.
    if (ticket.status === "Waiting for user") {
      await updateTicket(id, { status: "Open" });
    }

    // Admin-only fields (Phase B) must never reach the user, even as nulls.
    const { id: messageId, ticketId, senderType, senderId, body: messageBody, isInternal, createdAt } = message;
    const safeMessage = { id: messageId, ticketId, senderType, senderId, body: messageBody, isInternal, createdAt };
    return Response.json({ message: safeMessage }, { status: 201 });
  } catch (err) {
    console.error("[support/tickets/:id/messages POST]", err);
    return Response.json({ error: "Failed to add message" }, { status: 500 });
  }
}
