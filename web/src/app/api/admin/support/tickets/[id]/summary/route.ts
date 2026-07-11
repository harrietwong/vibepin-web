/**
 * POST /api/admin/support/tickets/:id/summary — generate (and persist) a
 * concise Chinese AI summary of the ticket for the support agent.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { safeContextSubset } from "@/lib/support/aiResponder";
import { getTicketById, listMessagesForAdmin, updateTicket } from "@/lib/support/db";
import type { SupportMessage } from "@/lib/support/types";
import { summarizeTicketZh } from "@/lib/support/translator";

export const dynamic = "force-dynamic";

/** Best Chinese-facing text for a message: user messages prefer the zh translation, admin messages prefer their Chinese original draft; both fall back to body. */
function bestText(m: SupportMessage): string {
  if (m.senderType === "user") return m.translatedText || m.body;
  if (m.senderType === "admin") return m.originalText || m.body;
  return m.body;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const ticket = await getTicketById(id);
    if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });

    const allMessages = await listMessagesForAdmin(id);
    const messages = allMessages.filter((m) => !m.isInternal).map((m) => ({ senderType: m.senderType, text: bestText(m) }));

    const summary = await summarizeTicketZh({
      // safeContextSubset: never leak email/userId/pageUrl/browser into the prompt.
      ticket: { category: ticket.category, subject: ticket.subject, description: ticket.description, context: safeContextSubset(ticket.context) },
      messages,
    });
    if (!summary) return Response.json({ error: "Failed to generate summary" }, { status: 500 });

    const updatedTicket = await updateTicket(id, { aiSummary: summary });
    return Response.json({ summary: updatedTicket.aiSummary, aiSummaryAt: updatedTicket.aiSummaryAt });
  } catch (err) {
    console.error("[admin/support/tickets/:id/summary POST]", err);
    return Response.json({ error: "Failed to generate summary" }, { status: 500 });
  }
}
