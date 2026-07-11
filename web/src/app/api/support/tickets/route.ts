/**
 * POST /api/support/tickets — create a support ticket (Contact Support form).
 * GET  /api/support/tickets — list the authenticated user's own tickets.
 */

import { getUserFromBearer } from "@/lib/server/superAdmin";
import { generateAiFirstResponse } from "@/lib/support/aiResponder";
import { buildSupportContext } from "@/lib/support/context";
import { addAttachments, addEvent, addMessage, createTicket, listTicketsForUser, nextTicketNumber } from "@/lib/support/db";
import { adminNewTicketEmail, sendEmail, userTicketConfirmationEmail } from "@/lib/support/email";
import { computeAutoPriority } from "@/lib/support/priority";
import { SUPPORT_CATEGORIES, SUPPORT_CATEGORY_LABELS, SUPPORT_SOURCES, type SupportCategory, type SupportSource } from "@/lib/support/types";

export const dynamic = "force-dynamic";

function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === "string" && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

function isSupportSource(value: unknown): value is SupportSource {
  return typeof value === "string" && (SUPPORT_SOURCES as readonly string[]).includes(value);
}

export async function POST(req: Request) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid request body" }, { status: 400 });

  const { category, subject, description, attachments } = body as {
    category?: unknown; subject?: unknown; description?: unknown; attachments?: unknown;
  };
  const source = isSupportSource(body.source) ? body.source : "help_center";

  if (!isSupportCategory(category)) return Response.json({ error: "A valid issue type is required" }, { status: 400 });
  if (typeof description !== "string" || !description.trim()) {
    return Response.json({ error: "A description is required" }, { status: 400 });
  }

  const clientContext = (body.clientContext && typeof body.clientContext === "object" ? body.clientContext : {}) as Record<string, unknown>;
  const { pageUrl, browser, os, timezone, ...extra } = clientContext;

  const { context, summary } = buildSupportContext({
    source,
    user,
    pageUrl: typeof pageUrl === "string" ? pageUrl : null,
    browser: typeof browser === "string" ? browser : null,
    os: typeof os === "string" ? os : null,
    timezone: typeof timezone === "string" ? timezone : null,
    extra,
  });

  const priority = computeAutoPriority(category, { scheduleFailed: extra.scheduleFailed === true });

  try {
    const ticketNumber = await nextTicketNumber();
    const ticket = await createTicket({
      ticketNumber,
      userId: user.id,
      email: user.email ?? "",
      category,
      priority,
      subject: typeof subject === "string" && subject.trim() ? subject.trim() : null,
      description: description.trim(),
      source,
      context,
    });

    const message = await addMessage({ ticketId: ticket.id, senderType: "user", senderId: user.id, body: ticket.description });

    if (Array.isArray(attachments) && attachments.length) {
      const clean = attachments
        .filter((a): a is { fileUrl: string; fileType?: string; fileName?: string } => !!a && typeof a === "object" && typeof (a as { fileUrl?: unknown }).fileUrl === "string")
        .slice(0, 5);
      if (clean.length) await addAttachments(ticket.id, message.id, clean);
    }

    await addEvent({ ticketId: ticket.id, eventType: "ticket_created", metadata: { category, priority, source } });

    // AI First Responder — best-effort, article-grounded first reply. Never
    // allowed to fail ticket creation: any error here is swallowed and
    // logged, and the ticket still returns 201 with aiReplied: false.
    let aiReplied = false;
    try {
      const aiResult = await generateAiFirstResponse({
        category,
        subject: ticket.subject,
        description: ticket.description,
        context: ticket.context,
      });
      if (aiResult?.canAnswer && aiResult.reply.trim()) {
        const aiMessage = await addMessage({ ticketId: ticket.id, senderType: "ai", body: aiResult.reply.trim(), isInternal: false });
        await addEvent({ ticketId: ticket.id, eventType: "ai_replied", metadata: { messageId: aiMessage.id } });
        aiReplied = true;
      }
    } catch (err) {
      console.error("[support/tickets POST] AI first response failed", err);
    }

    const userEmail = ticket.email;
    if (userEmail) {
      const confirmation = userTicketConfirmationEmail({
        ticketNumber: ticket.ticketNumber,
        userNameOrEmail: userEmail,
        subject: ticket.subject || SUPPORT_CATEGORY_LABELS[category],
      });
      void sendEmail({ to: userEmail, ...confirmation });
    }

    const adminNotifyEmail = process.env.SUPPORT_NOTIFICATION_EMAIL;
    if (adminNotifyEmail) {
      const notify = adminNewTicketEmail({
        ticketNumber: ticket.ticketNumber,
        category: SUPPORT_CATEGORY_LABELS[category],
        priority,
        userEmail: userEmail || "unknown",
        plan: (context.plan as string | null) ?? null,
        source,
        ticketId: ticket.id,
      });
      void sendEmail({ to: adminNotifyEmail, ...notify });
    }

    return Response.json({ id: ticket.id, ticketNumber: ticket.ticketNumber, status: ticket.status, contextSummary: summary, aiReplied }, { status: 201 });
  } catch (err) {
    console.error("[support/tickets POST]", err);
    return Response.json({ error: "Failed to create ticket" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const user = await getUserFromBearer(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const rawTickets = await listTicketsForUser(user.id);
    // Admin-only fields (customerLanguage/aiSummary/aiSummaryAt, Phase B)
    // must never reach the user — strip explicitly rather than relying on
    // JSON.stringify dropping them.
    const tickets = rawTickets.map(({ id, ticketNumber, userId, workspaceId, email, category, priority, status, subject, description, source, createdAt, updatedAt, resolvedAt, closedAt }) => ({
      id, ticketNumber, userId, workspaceId, email, category, priority, status, subject, description, source, createdAt, updatedAt, resolvedAt, closedAt,
    }));
    return Response.json({ tickets });
  } catch (err) {
    console.error("[support/tickets GET]", err);
    return Response.json({ error: "Failed to load tickets" }, { status: 500 });
  }
}
