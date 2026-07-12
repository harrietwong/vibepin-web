/**
 * POST /api/admin/support/tickets/:id/translate — translate user messages
 * to Chinese for the admin UI. Body: { messageIds?: string[] }. When
 * messageIds is omitted, translates all user messages on the ticket that
 * don't already have a successful translation (capped at 20 per call).
 *
 * Never blocks on failure: each message that fails translation is stored
 * with translation_status="failed" and simply comes back untranslated —
 * callers (the admin UI) handle failed/null translatedText by showing the
 * original body with a retry affordance.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { getTicketById, listMessagesForAdmin, updateMessageTranslation, updateTicket } from "@/lib/support/db";
import { translateToZh } from "@/lib/support/translator";

export const dynamic = "force-dynamic";

const MAX_MESSAGES_PER_CALL = 20;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const requestedIds = Array.isArray((body as { messageIds?: unknown })?.messageIds)
    ? ((body as { messageIds: unknown[] }).messageIds.filter((v): v is string => typeof v === "string"))
    : null;

  try {
    const ticket = await getTicketById(id);
    if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });

    const allMessages = await listMessagesForAdmin(id);
    let targets = allMessages.filter((m) => m.senderType === "user" && !m.isInternal);
    if (requestedIds) {
      const idSet = new Set(requestedIds);
      targets = targets.filter((m) => idSet.has(m.id));
    } else {
      targets = targets.filter((m) => m.translationStatus !== "success");
    }
    targets = targets.slice(0, MAX_MESSAGES_PER_CALL);

    let customerLanguage = ticket.customerLanguage ?? null;
    const updated = [];
    for (const message of targets) {
      const result = await translateToZh(message.body);
      if (result) {
        const saved = await updateMessageTranslation(message.id, {
          translatedText: result.zh,
          translatedLanguage: "zh",
          originalLanguage: result.detectedLanguage,
          translationStatus: "success",
        });
        updated.push(saved);
        if (!customerLanguage) customerLanguage = result.detectedLanguage;
      } else {
        const saved = await updateMessageTranslation(message.id, { translationStatus: "failed" });
        updated.push(saved);
      }
    }

    if (customerLanguage && customerLanguage !== ticket.customerLanguage) {
      await updateTicket(id, { customerLanguage });
    }

    return Response.json({ messages: updated, customerLanguage });
  } catch (err) {
    console.error("[admin/support/tickets/:id/translate POST]", err);
    return Response.json({ error: "Failed to translate messages" }, { status: 500 });
  }
}
