/**
 * POST /api/support/conversations — start a new AI Help-page chat.
 *
 * Per docs/prd/客服系统简化版v1.1.txt §5/§10: the user-facing surface is a
 * chat, not a ticket form — no ticket number is ever returned here. Under
 * the hood one support_tickets row IS the conversation record (see
 * migrate_v43_support_chat_email.sql header comment for why we reuse that
 * table instead of a parallel model).
 */

import { getUserFromBearer } from "@/lib/server/superAdmin";
import { DEFAULT_CHAT_CATEGORY, generateChatReply } from "@/lib/support/chatResponder";
import { buildSupportContext } from "@/lib/support/context";
import { addEvent, addMessage, createTicket, listMessagesForUser, nextTicketNumber } from "@/lib/support/db";
import { escalateConversation } from "@/lib/support/escalation";
import { computeAutoPriority } from "@/lib/support/priority";
import { SUPPORT_SOURCES, type SupportSource } from "@/lib/support/types";

export const dynamic = "force-dynamic";

function isSupportSource(value: unknown): value is SupportSource {
  return typeof value === "string" && (SUPPORT_SOURCES as readonly string[]).includes(value);
}

function toSafeMessage(m: Awaited<ReturnType<typeof listMessagesForUser>>[number]) {
  return { id: m.id, senderType: m.senderType, body: m.body, createdAt: m.createdAt };
}

export async function POST(req: Request) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid request body" }, { status: 400 });

  const firstMessage = typeof (body as { firstMessage?: unknown }).firstMessage === "string" ? (body as { firstMessage: string }).firstMessage.trim() : "";
  if (!firstMessage) return Response.json({ error: "firstMessage is required" }, { status: 400 });

  const clientContext = (body as { clientContext?: unknown }).clientContext;
  const clientContextObj = (clientContext && typeof clientContext === "object" ? clientContext : {}) as Record<string, unknown>;
  const { pageUrl, browser, os, timezone, source: rawSource, ...extra } = clientContextObj;
  const source = isSupportSource(rawSource) ? rawSource : "help_center";

  const { context } = buildSupportContext({
    source,
    user,
    pageUrl: typeof pageUrl === "string" ? pageUrl : null,
    browser: typeof browser === "string" ? browser : null,
    os: typeof os === "string" ? os : null,
    timezone: typeof timezone === "string" ? timezone : null,
    extra,
  });

  try {
    // One AI call decides both the category (used to create the ticket) and
    // the first reply — no need to call the model twice.
    let aiResult: Awaited<ReturnType<typeof generateChatReply>> = null;
    try {
      aiResult = await generateChatReply({ messages: [{ role: "user", text: firstMessage }], context });
    } catch (err) {
      console.error("[support/conversations POST] generateChatReply failed", err);
    }

    const category = aiResult?.category ?? DEFAULT_CHAT_CATEGORY;
    const priority = computeAutoPriority(category, { scheduleFailed: extra.scheduleFailed === true });

    const ticketNumber = await nextTicketNumber();
    const ticket = await createTicket({
      ticketNumber,
      userId: user.id,
      email: user.email ?? "",
      category,
      priority,
      subject: null,
      description: firstMessage,
      source,
      context,
    });

    await addMessage({ ticketId: ticket.id, senderType: "user", senderId: user.id, body: firstMessage });
    await addEvent({ ticketId: ticket.id, eventType: "ticket_created", metadata: { category, priority, source, channel: "chat" } });

    let escalated = false;
    if (aiResult) {
      if (aiResult.reply.trim()) {
        const aiMessage = await addMessage({ ticketId: ticket.id, senderType: "ai", body: aiResult.reply.trim(), isInternal: false });
        await addEvent({ ticketId: ticket.id, eventType: "ai_replied", metadata: { messageId: aiMessage.id } });
      }
      if (aiResult.shouldEscalate) {
        const result = await escalateConversation(ticket.id, aiResult.escalationReason);
        escalated = result.escalated;
        if (escalated) {
          await addMessage({
            ticketId: ticket.id,
            senderType: "system",
            body: "This issue requires human review. We've sent the details to our support team. We'll reply by email.",
            isInternal: false,
          });
        }
      }
    }
    // aiResult === null → canAnswer=false by convention; no AI message is
    // posted and the frontend shows the "request email help" offer itself.

    const messages = (await listMessagesForUser(ticket.id)).map(toSafeMessage);
    return Response.json({ conversationId: ticket.id, messages, escalated, accountEmail: user.email ?? null }, { status: 201 });
  } catch (err) {
    console.error("[support/conversations POST]", err);
    return Response.json({ error: "Failed to start conversation" }, { status: 500 });
  }
}
