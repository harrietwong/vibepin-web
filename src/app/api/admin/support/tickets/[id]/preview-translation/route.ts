/**
 * POST /api/admin/support/tickets/:id/preview-translation — translate a
 * Chinese admin draft into the customer's language for an editable
 * preview before sending. Body: { zhText: string }.
 *
 * If the customer's language isn't known yet, this detects it from the
 * latest user message (and persists it on the ticket) before deciding
 * whether a translation is even needed. Chinese customers are a real
 * case — when the target is "zh" (or still unknown after detection) the
 * Chinese draft is returned unchanged with skipped:true so the UI can
 * send it directly without a redundant translation call.
 */

import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { getTicketById, listMessagesForAdmin, updateTicket } from "@/lib/support/db";
import { translateFromZh, translateToZh } from "@/lib/support/translator";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(req);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const zhText = body && typeof body.zhText === "string" ? body.zhText.trim() : "";
  if (!zhText) return Response.json({ error: "zhText is required" }, { status: 400 });

  try {
    const ticket = await getTicketById(id);
    if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });

    let target = ticket.customerLanguage ?? null;
    if (!target) {
      const messages = await listMessagesForAdmin(id);
      const latestUserMessage = [...messages].reverse().find((m) => m.senderType === "user" && !m.isInternal);
      if (latestUserMessage) {
        const detected = await translateToZh(latestUserMessage.body);
        if (detected) {
          target = detected.detectedLanguage;
          await updateTicket(id, { customerLanguage: target });
        }
      }
    }

    if (!target || target === "zh") {
      return Response.json({ translatedText: zhText, targetLanguage: target ?? "zh", skipped: true });
    }

    const translated = await translateFromZh(zhText, target);
    if (!translated) return Response.json({ error: "Translation failed" }, { status: 500 });

    return Response.json({ translatedText: translated, targetLanguage: target });
  } catch (err) {
    console.error("[admin/support/tickets/:id/preview-translation POST]", err);
    return Response.json({ error: "Translation failed" }, { status: 500 });
  }
}
