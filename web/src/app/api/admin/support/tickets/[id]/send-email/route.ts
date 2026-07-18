/**
 * POST /api/admin/support/tickets/:id/send-email — admin sends the
 * translated reply to an escalated chat conversation as a real email
 * (Resend). Per PRD §8.4 this is idempotency-key gated so a duplicate
 * click (or a retried network request) can never send a second email for
 * the same reply; POST retry-email/route.ts is the only path allowed to
 * re-attempt a failed send, and it reuses the same support_emails row.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { addEvent, addMessage, getEmailByIdempotencyKey, getTicketById, insertSupportEmail, updateSupportEmail, updateTicket } from "@/lib/support/db";
import { chatEscalationReplyEmail, sendEmail } from "@/lib/support/email";

export const dynamic = "force-dynamic";

const DEFAULT_SUPPORT_EMAIL = "support@vibepin.co";

function parseFromEmail(): string {
  const raw = process.env.SUPPORT_EMAIL_FROM;
  if (!raw) return `VibePin Support <${DEFAULT_SUPPORT_EMAIL}>`;
  return raw;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid request body" }, { status: 400 });

  const translatedText = typeof (body as { translatedText?: unknown }).translatedText === "string" ? (body as { translatedText: string }).translatedText.trim() : "";
  const originalZh = typeof (body as { originalZh?: unknown }).originalZh === "string" ? (body as { originalZh: string }).originalZh.trim() : null;
  const targetLanguage = typeof (body as { targetLanguage?: unknown }).targetLanguage === "string" ? (body as { targetLanguage: string }).targetLanguage : null;
  const translationEdited = typeof (body as { translationEdited?: unknown }).translationEdited === "boolean" ? (body as { translationEdited: boolean }).translationEdited : false;
  const idempotencyKey = typeof (body as { idempotencyKey?: unknown }).idempotencyKey === "string" ? (body as { idempotencyKey: string }).idempotencyKey.trim() : "";

  if (!translatedText) return Response.json({ error: "translatedText is required" }, { status: 400 });
  if (!idempotencyKey) return Response.json({ error: "idempotencyKey is required" }, { status: 400 });

  try {
    const ticket = await getTicketById(id);
    if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });

    // Idempotency dedupe MUST be checked before the escalation_state guard
    // below: a retried request (double-click, network retry) for a reply
    // that already sent successfully has, by definition, already moved the
    // ticket out of needs_email_reply/email_failed. Checking state first
    // would reject that retry with a 400 instead of the deduped response
    // PRD §8.4 requires ("重复请求不得发送第二封邮件").
    const existing = await getEmailByIdempotencyKey(idempotencyKey);
    if (existing) {
      return Response.json({ email: existing, deduped: true });
    }

    const escalationState = ticket.escalationState ?? "none";
    if (escalationState !== "needs_email_reply" && escalationState !== "email_failed") {
      return Response.json({ error: `Ticket is not awaiting an email reply (escalation_state=${escalationState})` }, { status: 400 });
    }
    if (!ticket.email) return Response.json({ error: "Ticket has no account email on file" }, { status: 400 });

    const fromEmailRaw = parseFromEmail();
    const fromEmailAddress = fromEmailRaw.match(/<([^>]+)>/)?.[1] ?? fromEmailRaw ?? DEFAULT_SUPPORT_EMAIL;
    const { subject, html, text } = chatEscalationReplyEmail({ translatedText, ticketNumber: ticket.ticketNumber });

    let emailRow = await insertSupportEmail({
      ticketId: id,
      toEmail: ticket.email,
      fromEmail: fromEmailAddress,
      replyToEmail: DEFAULT_SUPPORT_EMAIL,
      subject,
      adminSourceTextZh: originalZh,
      translatedText,
      targetLanguage,
      translationEngine: "linapi",
      translationEdited,
      status: "sending",
      idempotencyKey,
    });

    const result = await sendEmail({ to: ticket.email, subject, html, text });

    if (result.ok) {
      emailRow = await updateSupportEmail(emailRow.id, {
        status: "sent",
        providerMessageId: result.providerMessageId ?? "dev-logged",
        sentAt: new Date().toISOString(),
      });

      await addMessage({
        ticketId: id,
        senderType: "admin",
        senderId: session.user.id,
        body: translatedText,
        isInternal: false,
        originalText: originalZh,
        originalLanguage: originalZh ? "zh" : undefined,
        translatedText,
        translatedLanguage: targetLanguage,
        translationStatus: "success",
        translationManuallyEdited: translationEdited,
      });

      await updateTicket(id, { escalationState: "email_sent", status: "Waiting for user" }).catch((err) =>
        console.error("[admin/support/tickets/:id/send-email POST] escalationState update failed (v43 applied?)", err),
      );
      await addEvent({ ticketId: id, eventType: "email_sent", metadata: { emailId: emailRow.id, actor: session.user.id } });

      return Response.json({ email: emailRow }, { status: 201 });
    }

    emailRow = await updateSupportEmail(emailRow.id, {
      status: "failed",
      failureMessage: result.errorSummary ?? "Unknown error",
    });
    await updateTicket(id, { escalationState: "email_failed" }).catch((err) =>
      console.error("[admin/support/tickets/:id/send-email POST] escalationState update failed (v43 applied?)", err),
    );
    await addEvent({ ticketId: id, eventType: "email_failed", metadata: { emailId: emailRow.id, actor: session.user.id } });

    return Response.json({ error: "Email could not be sent", failure: result.errorSummary ?? null, email: emailRow }, { status: 502 });
  } catch (err) {
    console.error("[admin/support/tickets/:id/send-email POST]", err);
    return Response.json({ error: "Failed to send email" }, { status: 500 });
  }
}
