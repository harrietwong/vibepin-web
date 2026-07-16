/**
 * POST /api/support/conversations/:id/messages — a follow-up user chat
 * turn. While the conversation hasn't escalated yet, this triggers another
 * AI turn (with the full conversation history so the model can notice
 * repeated failed attempts). Once escalated, messages are stored for the
 * admin to see over email and no further AI calls are made.
 */

import { getUserFromBearer } from "@/lib/server/superAdmin";
import { type ChatMessageInput, generateChatReply } from "@/lib/support/chatResponder";
import { addEvent, addMessage, getTicketById, listMessagesForUser } from "@/lib/support/db";
import { escalateConversation } from "@/lib/support/escalation";

export const dynamic = "force-dynamic";

function toSafeMessage(m: Awaited<ReturnType<typeof listMessagesForUser>>[number]) {
  return { id: m.id, senderType: m.senderType, body: m.body, createdAt: m.createdAt };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const text = body && typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text.trim() : "";
  if (!text) return Response.json({ error: "text is required" }, { status: 400 });

  try {
    const ticket = await getTicketById(id);
    if (!ticket || ticket.userId !== user.id) return Response.json({ error: "Not found" }, { status: 404 });

    const userMessage = await addMessage({ ticketId: id, senderType: "user", senderId: user.id, body: text, isInternal: false });
    await addEvent({ ticketId: id, eventType: "user_replied", metadata: { messageId: userMessage.id } });

    const alreadyEscalated = (ticket.escalationState ?? "none") !== "none";
    let escalated = alreadyEscalated;

    if (!alreadyEscalated) {
      const history = (await listMessagesForUser(id))
        .filter((m) => m.senderType !== "system")
        .map((m): ChatMessageInput => ({ role: m.senderType === "ai" ? "assistant" : "user", text: m.body }));

      let aiResult: Awaited<ReturnType<typeof generateChatReply>> = null;
      try {
        aiResult = await generateChatReply({ messages: history, context: ticket.context });
      } catch (err) {
        console.error("[support/conversations/:id/messages POST] generateChatReply failed", err);
      }

      if (aiResult) {
        if (aiResult.reply.trim()) {
          const aiMessage = await addMessage({ ticketId: id, senderType: "ai", body: aiResult.reply.trim(), isInternal: false });
          await addEvent({ ticketId: id, eventType: "ai_replied", metadata: { messageId: aiMessage.id } });
        }
        if (aiResult.shouldEscalate) {
          const result = await escalateConversation(id, aiResult.escalationReason);
          escalated = result.escalated;
          if (escalated) {
            await addMessage({
              ticketId: id,
              senderType: "system",
              body: "This issue requires human review. We've sent the details to our support team. We'll reply by email.",
              isInternal: false,
            });
          }
        }
      }
    }

    const messages = (await listMessagesForUser(id)).map(toSafeMessage);
    return Response.json({ messages, escalated, accountEmail: user.email ?? null }, { status: 201 });
  } catch (err) {
    console.error("[support/conversations/:id/messages POST]", err);
    return Response.json({ error: "Failed to add message" }, { status: 500 });
  }
}
