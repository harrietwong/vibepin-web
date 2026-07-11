/**
 * GET /api/support/tickets/:id — a single ticket owned by the authenticated
 * user, with its non-internal messages. Never returns internal notes or the
 * raw context JSON (context is admin-only).
 */

import { getUserFromBearer } from "@/lib/server/superAdmin";
import { getTicketById, listMessagesForUser } from "@/lib/support/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const ticket = await getTicketById(id);
    if (!ticket || ticket.userId !== user.id) return Response.json({ error: "Not found" }, { status: 404 });

    const messages = await listMessagesForUser(id);
    const { id: ticketId, ticketNumber, userId, workspaceId, email, category, priority, status, subject, description, source, createdAt, updatedAt, resolvedAt, closedAt } = ticket;
    const safeTicket = { id: ticketId, ticketNumber, userId, workspaceId, email, category, priority, status, subject, description, source, createdAt, updatedAt, resolvedAt, closedAt };
    return Response.json({ ticket: safeTicket, messages });
  } catch (err) {
    console.error("[support/tickets/:id GET]", err);
    return Response.json({ error: "Failed to load ticket" }, { status: 500 });
  }
}
