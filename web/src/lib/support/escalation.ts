/**
 * escalation.ts — shared "hand this conversation to a human, by email"
 * routine (server-only). Used by both the explicit
 * POST /api/support/conversations/:id/escalate endpoint and the automatic
 * escalation path inside the chat routes (generateChatReply returning
 * shouldEscalate=true).
 *
 * Idempotent: calling this on an already-escalated conversation is a no-op
 * (returns the existing state, no duplicate event/side effects) — see PRD
 * §14 ("会话已升级后再次点击" must not create a duplicate escalation).
 *
 * Failure posture: the CORE escalation write (escalation_state /
 * resolution_mode / escalated_at / escalation_reason) is the one thing this
 * function must not silently swallow — callers need to know if it didn't
 * persist. But it still never throws: any DB error (including, notably,
 * "column does not exist" if migrate_v43 hasn't been applied yet in this
 * environment) is caught and reported back via `persisted: false` instead of
 * propagating, so a broken/unmigrated schema degrades the chat UX rather
 * than 500ing it.
 *
 * The translation + Chinese-summary follow-up is unconditionally
 * best-effort per PRD §14 ("翻译或摘要失败不能导致客户升级请求丢失") —
 * failures there are logged and otherwise ignored.
 */

import { addEvent, getTicketById, listMessagesForUser, updateMessageTranslation, updateTicket } from "./db";
import { resolveEscalationReason } from "./escalationCore";
import { summarizeTicketZh, translateToZh } from "./translator";

export { resolveEscalationReason };

export type EscalateResult = {
  // Whether the conversation IS escalated (already was, or this call just
  // made it so). False only in the degraded case where this was a fresh
  // escalation attempt and the core write failed to persist.
  escalated: boolean;
  alreadyEscalated: boolean;
  accountEmail: string | null;
  // Whether the core escalation-state write succeeded. Callers/tests can
  // use this to distinguish "already escalated" from "wrote it just now"
  // from "tried to write it and the schema rejected it."
  persisted: boolean;
};

export async function escalateConversation(ticketId: string, reason?: string | null): Promise<EscalateResult> {
  const ticket = await getTicketById(ticketId);
  if (!ticket) throw new Error("escalateConversation: ticket not found");

  const currentState = ticket.escalationState ?? "none";
  if (currentState !== "none") {
    return { escalated: true, alreadyEscalated: true, accountEmail: ticket.email, persisted: true };
  }

  const finalReason = resolveEscalationReason(reason);

  let persisted = true;
  try {
    await updateTicket(ticketId, {
      escalationState: "needs_email_reply",
      resolutionMode: "email_escalated",
      escalatedAt: new Date().toISOString(),
      escalationReason: finalReason,
    });
    await addEvent({ ticketId, eventType: "escalated", metadata: { reason: finalReason } });
  } catch (err) {
    persisted = false;
    console.error(
      "[support/escalation] failed to persist escalation state — is migrate_v43_support_chat_email.sql applied?",
      err,
    );
  }

  // Best-effort: translate the latest user message to Chinese + generate a
  // Chinese summary for the admin. Never allowed to affect the response.
  try {
    const messages = await listMessagesForUser(ticketId);
    const latestUser = [...messages].reverse().find((m) => m.senderType === "user");
    if (latestUser) {
      const translated = await translateToZh(latestUser.body);
      if (translated) {
        try {
          await updateMessageTranslation(latestUser.id, {
            translatedText: translated.zh,
            translatedLanguage: "zh",
            originalLanguage: translated.detectedLanguage,
            translationStatus: "success",
          });
        } catch (err) {
          console.error("[support/escalation] failed to persist message translation", err);
        }
        if (translated.detectedLanguage) {
          await updateTicket(ticketId, { customerLanguage: translated.detectedLanguage }).catch((err) =>
            console.error("[support/escalation] failed to persist customerLanguage", err),
          );
        }
      }
    }

    const summary = await summarizeTicketZh({
      ticket: { category: ticket.category, subject: ticket.subject, description: ticket.description, context: ticket.context },
      messages: messages.map((m) => ({ senderType: m.senderType, text: m.body })),
    });
    if (summary) {
      await updateTicket(ticketId, { aiSummary: summary }).catch((err) =>
        console.error("[support/escalation] failed to persist aiSummary", err),
      );
    }
  } catch (err) {
    console.error("[support/escalation] best-effort translate/summarize step failed", err);
  }

  return { escalated: persisted, alreadyEscalated: false, accountEmail: ticket.email, persisted };
}
