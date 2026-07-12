/**
 * GET /api/support/tickets/:id — a single ticket owned by the authenticated
 * user, with its non-internal messages. Never returns internal notes or the
 * raw context JSON (context is admin-only).
 */

import { getUserFromBearer } from "@/lib/server/superAdmin";
import { getAiFeedbackVerdict, getTicketById, listAttachmentsForTicket, listMessagesForUser } from "@/lib/support/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const ticket = await getTicketById(id);
    if (!ticket || ticket.userId !== user.id) return Response.json({ error: "Not found" }, { status: 404 });

    const rawMessages = await listMessagesForUser(id);
    // Admin-only fields (originalText/translatedText/etc, Phase B) must
    // never reach the user-facing API even though listMessagesForUser's
    // SupportMessage type carries them — strip explicitly, don't rely on
    // JSON.stringify happening to drop undefined.
    const messages = rawMessages.map(({ id: messageId, ticketId, senderType, senderId, body, isInternal, createdAt: messageCreatedAt }) => ({
      id: messageId,
      ticketId,
      senderType,
      senderId,
      body,
      isInternal,
      createdAt: messageCreatedAt,
    }));
    const rawAttachments = await listAttachmentsForTicket(id);
    const attachments = rawAttachments.map(({ id: attachmentId, messageId, fileUrl, fileName, fileType, createdAt: attachmentCreatedAt }) => ({
      id: attachmentId,
      messageId,
      fileUrl,
      fileName,
      fileType,
      createdAt: attachmentCreatedAt,
    }));
    const aiFeedback = await getAiFeedbackVerdict(id);
    const { id: ticketId, ticketNumber, userId, workspaceId, email, category, priority, status, subject, description, source, createdAt, updatedAt, resolvedAt, closedAt } = ticket;
    const safeTicket = { id: ticketId, ticketNumber, userId, workspaceId, email, category, priority, status, subject, description, source, createdAt, updatedAt, resolvedAt, closedAt };
    return Response.json({ ticket: safeTicket, messages, attachments, aiFeedback });
  } catch (err) {
    console.error("[support/tickets/:id GET]", err);
    return Response.json({ error: "Failed to load ticket" }, { status: 500 });
  }
}
