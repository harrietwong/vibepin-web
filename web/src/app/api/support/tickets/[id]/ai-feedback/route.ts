/**
 * POST /api/support/tickets/:id/ai-feedback — user feedback on the AI first
 * reply ("did this solve your issue?"). Owner-only, and only valid once the
 * ticket actually has a non-internal AI message. Idempotent: once a verdict
 * exists for the ticket, later calls return that verdict instead of
 * double-writing (button state also gets hidden client-side once set, but
 * the route enforces it independently).
 */

import { getUserFromBearer } from "@/lib/server/superAdmin";
import { addEvent, addMessage, getAiFeedbackVerdict, getTicketById, listMessagesForUser, updateTicket } from "@/lib/support/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const helped = body && typeof (body as { helped?: unknown }).helped === "boolean" ? (body as { helped: boolean }).helped : null;
  if (helped === null) return Response.json({ error: "helped (boolean) is required" }, { status: 400 });

  try {
    const ticket = await getTicketById(id);
    if (!ticket || ticket.userId !== user.id) return Response.json({ error: "Not found" }, { status: 404 });

    const messages = await listMessagesForUser(id);
    const hasAiMessage = messages.some((m) => m.senderType === "ai");
    if (!hasAiMessage) return Response.json({ error: "This ticket has no AI reply to give feedback on" }, { status: 400 });

    const existing = await getAiFeedbackVerdict(id);
    if (existing) return Response.json({ verdict: existing });

    if (helped) {
      await addEvent({ ticketId: id, eventType: "ai_resolved", metadata: {} });
      const patch: Parameters<typeof updateTicket>[1] = { resolutionMode: "resolved_by_ai" };
      if (ticket.status !== "Resolved" && ticket.status !== "Closed") {
        patch.status = "Resolved";
        patch.resolvedAt = new Date().toISOString();
      }
      try {
        await updateTicket(id, patch);
      } catch (err) {
        // migrate_v43 (resolution_mode column) may not be applied yet in
        // this environment — never let that break the older status
        // transition that already worked pre-v43.
        console.error("[support/tickets/:id/ai-feedback POST] resolutionMode update failed (is migrate_v43 applied?)", err);
        if (patch.status) {
          await updateTicket(id, { status: patch.status, resolvedAt: patch.resolvedAt }).catch((fallbackErr) =>
            console.error("[support/tickets/:id/ai-feedback POST] status fallback update also failed", fallbackErr),
          );
        }
      }
      return Response.json({ verdict: "helped" });
    }

    await addEvent({ ticketId: id, eventType: "ai_not_helpful", metadata: {} });
    await addMessage({
      ticketId: id,
      senderType: "system",
      body: "User marked the AI answer as not helpful — needs a human reply.",
      isInternal: true,
    });
    return Response.json({ verdict: "not_helpful" });
  } catch (err) {
    console.error("[support/tickets/:id/ai-feedback POST]", err);
    return Response.json({ error: "Failed to record feedback" }, { status: 500 });
  }
}
