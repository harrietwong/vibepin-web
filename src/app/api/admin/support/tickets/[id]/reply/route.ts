/**
 * POST /api/admin/support/tickets/:id/reply — admin reply to the user.
 * Sets status to "Waiting for user" (unless already Resolved/Closed) and
 * emails the user.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { addEvent, addMessage, getTicketById, updateTicket } from "@/lib/support/db";
import { adminReplyEmail, sendEmail } from "@/lib/support/email";
import { SUPPORT_CATEGORY_LABELS, type SupportCategory } from "@/lib/support/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const text = body && typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return Response.json({ error: "Reply body is required" }, { status: 400 });

  // Optional: present when the admin composed the reply in Chinese and it
  // was translated to the customer's language before sending (see
  // preview-translation). `body` above is always what's actually sent.
  const originalZh = body && typeof body.originalZh === "string" ? body.originalZh.trim() : undefined;
  const translatedLanguage = body && typeof body.translatedLanguage === "string" ? body.translatedLanguage : undefined;
  const manuallyEdited = body && typeof body.manuallyEdited === "boolean" ? body.manuallyEdited : undefined;

  try {
    const ticket = await getTicketById(id);
    if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });

    const translationFields = originalZh
      ? {
          originalText: originalZh,
          originalLanguage: "zh",
          translatedText: text,
          translatedLanguage: translatedLanguage ?? null,
          translationStatus: "success" as const,
          translationManuallyEdited: manuallyEdited ?? false,
        }
      : {};
    const message = await addMessage({ ticketId: id, senderType: "admin", senderId: session.user.id, body: text, isInternal: false, ...translationFields });
    await addEvent({ ticketId: id, eventType: "admin_replied", metadata: { messageId: message.id, actor: session.user.id } });

    if (ticket.status !== "Resolved" && ticket.status !== "Closed") {
      await updateTicket(id, { status: "Waiting for user" });
    }

    if (ticket.email) {
      const subjectSource = ticket.subject || SUPPORT_CATEGORY_LABELS[ticket.category as SupportCategory] || "your support request";
      const emailPayload = adminReplyEmail({ ticketSubject: subjectSource, adminReply: text, ticketId: ticket.id });
      void sendEmail({ to: ticket.email, ...emailPayload });
    }

    return Response.json({ message }, { status: 201 });
  } catch (err) {
    console.error("[admin/support/tickets/:id/reply POST]", err);
    return Response.json({ error: "Failed to send reply" }, { status: 500 });
  }
}
