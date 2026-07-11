/**
 * GET   /api/admin/support/tickets/:id — full ticket (incl. context + internal notes).
 * PATCH /api/admin/support/tickets/:id — change status and/or priority.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { addEvent, getTicketById, listMessagesForAdmin, updateTicket } from "@/lib/support/db";
import { SUPPORT_PRIORITIES, SUPPORT_STATUSES, type SupportPriority, type SupportStatus } from "@/lib/support/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const ticket = await getTicketById(id);
    if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });
    const messages = await listMessagesForAdmin(id);
    return Response.json({ ticket, messages });
  } catch (err) {
    console.error("[admin/support/tickets/:id GET]", err);
    return Response.json({ error: "Failed to load ticket" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid request body" }, { status: 400 });

  const statusIn = (body as { status?: unknown }).status;
  const priorityIn = (body as { priority?: unknown }).priority;
  const status = typeof statusIn === "string" && (SUPPORT_STATUSES as readonly string[]).includes(statusIn) ? (statusIn as SupportStatus) : undefined;
  const priority = typeof priorityIn === "string" && (SUPPORT_PRIORITIES as readonly string[]).includes(priorityIn) ? (priorityIn as SupportPriority) : undefined;
  if (!status && !priority) return Response.json({ error: "status or priority is required" }, { status: 400 });

  try {
    const existing = await getTicketById(id);
    if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

    const patch: Parameters<typeof updateTicket>[1] = {};
    if (status) {
      patch.status = status;
      if (status === "Resolved") patch.resolvedAt = new Date().toISOString();
      if (status === "Closed") patch.closedAt = new Date().toISOString();
    }
    if (priority) patch.priority = priority;

    const ticket = await updateTicket(id, patch);

    if (status && status !== existing.status) {
      const eventType = status === "Resolved" ? "ticket_resolved" : status === "Closed" ? "ticket_closed" : "status_changed";
      await addEvent({ ticketId: id, eventType, metadata: { from: existing.status, to: status, actor: session.user.id } });
    }
    if (priority && priority !== existing.priority) {
      await addEvent({ ticketId: id, eventType: "priority_changed", metadata: { from: existing.priority, to: priority, actor: session.user.id } });
    }

    return Response.json({ ticket });
  } catch (err) {
    console.error("[admin/support/tickets/:id PATCH]", err);
    return Response.json({ error: "Failed to update ticket" }, { status: 500 });
  }
}
