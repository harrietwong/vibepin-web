/**
 * POST /api/admin/support/tickets/:id/retry-email — re-attempt a FAILED
 * send. Reuses the same support_emails row (same idempotency_key) rather
 * than minting a new one, per PRD §8.4 — a retry is not a new send
 * attempt's identity, it's the same one succeeding late.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { addEvent, addMessage, getSupportEmailById, getTicketById, updateSupportEmail, updateTicket } from "@/lib/support/db";
import { chatEscalationReplyEmail, sendEmail } from "@/lib/support/email";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const emailId = typeof (body as { emailId?: unknown })?.emailId === "string" ? (body as { emailId: string }).emailId : "";
  if (!emailId) return Response.json({ error: "emailId is required" }, { status: 400 });

  try {
    const ticket = await getTicketById(id);
    if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });

    const emailRow = await getSupportEmailById(emailId);
    if (!emailRow || emailRow.ticketId !== id) return Response.json({ error: "Not found" }, { status: 404 });
    if (emailRow.status !== "failed") {
      return Response.json({ error: `Email is not in a failed state (status=${emailRow.status})` }, { status: 400 });
    }

    await updateSupportEmail(emailRow.id, { status: "sending", retryCount: emailRow.retryCount + 1 });

    const { subject, html, text } = chatEscalationReplyEmail({ translatedText: emailRow.translatedText, ticketNumber: ticket.ticketNumber });
    const result = await sendEmail({ to: emailRow.toEmail, subject, html, text });

    if (result.ok) {
      const updated = await updateSupportEmail(emailRow.id, {
        status: "sent",
        providerMessageId: result.providerMessageId ?? "dev-logged",
        sentAt: new Date().toISOString(),
        failureCode: null,
        failureMessage: null,
      });

      await addMessage({
        ticketId: id,
        senderType: "admin",
        senderId: session.user.id,
        body: emailRow.translatedText,
        isInternal: false,
        originalText: emailRow.adminSourceTextZh,
        originalLanguage: emailRow.adminSourceTextZh ? "zh" : undefined,
        translatedText: emailRow.translatedText,
        translatedLanguage: emailRow.targetLanguage,
        translationStatus: "success",
        translationManuallyEdited: emailRow.translationEdited,
      });

      await updateTicket(id, { escalationState: "email_sent", status: "Waiting for user" }).catch((err) =>
        console.error("[admin/support/tickets/:id/retry-email POST] escalationState update failed (v43 applied?)", err),
      );
      await addEvent({ ticketId: id, eventType: "email_sent", metadata: { emailId: updated.id, actor: session.user.id, retry: true } });

      return Response.json({ email: updated });
    }

    const updated = await updateSupportEmail(emailRow.id, {
      status: "failed",
      failureMessage: result.errorSummary ?? "Unknown error",
    });
    await updateTicket(id, { escalationState: "email_failed" }).catch((err) =>
      console.error("[admin/support/tickets/:id/retry-email POST] escalationState update failed (v43 applied?)", err),
    );
    await addEvent({ ticketId: id, eventType: "email_failed", metadata: { emailId: updated.id, actor: session.user.id, retry: true } });

    return Response.json({ error: "Email could not be sent", failure: result.errorSummary ?? null, email: updated }, { status: 502 });
  } catch (err) {
    console.error("[admin/support/tickets/:id/retry-email POST]", err);
    return Response.json({ error: "Failed to retry email" }, { status: 500 });
  }
}
