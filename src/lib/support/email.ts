/**
 * Minimal email abstraction for the support ticket system.
 *
 * No email provider exists elsewhere in this codebase (greenfield). This
 * wraps the Resend HTTP API (no SDK dependency needed) behind a tiny
 * `sendEmail()` so Postmark/SendGrid can be swapped in later by editing only
 * this file. When RESEND_API_KEY isn't configured (local dev), emails are
 * logged instead of sent so the ticket flow still works end-to-end.
 */

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

const RESEND_API_URL = "https://api.resend.com/emails";

export type SendEmailResult = {
  ok: boolean;
  skipped?: boolean;
  providerMessageId?: string;
  // Short, safe-to-store/log summary of a provider failure (status code +
  // truncated body) — never the raw response, per PRD §13 ("日志只记录安全
  // 错误摘要").
  errorSummary?: string;
};

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SUPPORT_EMAIL_FROM || "VibePin Support <support@vibepin.co>";

  if (!apiKey) {
    console.info(`[support/email] No email provider configured — logging instead of sending.
  to: ${input.to}
  subject: ${input.subject}
  ---
  ${input.text}`);
    return { ok: true, skipped: true, providerMessageId: "dev-logged" };
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const errorSummary = `HTTP ${res.status}: ${bodyText.slice(0, 300)}`;
      console.error("[support/email] send failed", res.status, bodyText);
      return { ok: false, errorSummary };
    }
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, providerMessageId: data?.id };
  } catch (err) {
    console.error("[support/email] send threw", err);
    return { ok: false, errorSummary: err instanceof Error ? err.message.slice(0, 300) : "Unknown error" };
  }
}

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export function wrap(bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1A2236;max-width:520px">${bodyHtml}</div>`;
}

/**
 * Admin's translated reply to an escalated chat conversation, sent via
 * POST /api/admin/support/tickets/:id/send-email. Unlike the older
 * adminReplyEmail() template above (which points users back to a ticket
 * page and says "don't reply"), this one's Reply-To is a real, monitored
 * inbox (support@vibepin.co) — replying by email is the intended flow here
 * (PRD §8.1), so the copy invites a reply instead of discouraging one.
 */
export function chatEscalationReplyEmail(args: { translatedText: string; ticketNumber: string }) {
  const subjectLine = `Re: Your VibePin support request [${args.ticketNumber}]`;
  const text = `${args.translatedText}

Reply to this email and our team will follow up.`;
  const html = wrap(`
    <p>${escapeHtml(args.translatedText).replace(/\n/g, "<br/>")}</p>
    <p style="color:#5B6472">Reply to this email and our team will follow up.</p>
  `);
  return { subject: subjectLine, html, text };
}

export function userTicketConfirmationEmail(args: { ticketNumber: string; userNameOrEmail: string; subject: string; ticketId: string }) {
  const ticketUrl = `${appBaseUrl()}/app/support/tickets/${args.ticketId}`;
  const subjectLine = `We received your support request ${args.ticketNumber}`;
  const text = `Hi ${args.userNameOrEmail},

We received your support request.

Ticket: ${args.ticketNumber}
Subject: ${args.subject}

We'll reply by email. We usually reply within 24 hours.

Please don't reply to this email — to add details or follow the conversation, open your ticket:
${ticketUrl}`;
  const html = wrap(`
    <p>Hi ${escapeHtml(args.userNameOrEmail)},</p>
    <p>We received your support request.</p>
    <p><strong>Ticket:</strong> ${escapeHtml(args.ticketNumber)}<br/>
    <strong>Subject:</strong> ${escapeHtml(args.subject)}</p>
    <p>We'll reply by email. We usually reply within 24 hours.</p>
    <p>Please don't reply to this email — to add details or follow the conversation, <a href="${ticketUrl}">open your ticket</a>.</p>
  `);
  return { subject: subjectLine, html, text };
}

export function adminNewTicketEmail(args: {
  ticketNumber: string;
  category: string;
  priority: string;
  userEmail: string;
  plan: string | null;
  source: string | null;
  ticketId: string;
}) {
  const adminUrl = `${appBaseUrl()}/admin/support/${args.ticketId}`;
  const subjectLine = `New support ticket: ${args.category} · ${args.priority}`;
  const text = `New support ticket ${args.ticketNumber}

Category: ${args.category}
Priority: ${args.priority}
User: ${args.userEmail}
Plan: ${args.plan ?? "—"}
Source: ${args.source ?? "—"}

View: ${adminUrl}`;
  const html = wrap(`
    <p>New support ticket <strong>${escapeHtml(args.ticketNumber)}</strong></p>
    <p>
      Category: ${escapeHtml(args.category)}<br/>
      Priority: ${escapeHtml(args.priority)}<br/>
      User: ${escapeHtml(args.userEmail)}<br/>
      Plan: ${escapeHtml(args.plan ?? "—")}<br/>
      Source: ${escapeHtml(args.source ?? "—")}
    </p>
    <p><a href="${adminUrl}">View ticket</a></p>
  `);
  return { subject: subjectLine, html, text };
}

export function adminReplyEmail(args: { ticketSubject: string; adminReply: string; ticketId: string }) {
  const ticketUrl = `${appBaseUrl()}/app/support/tickets/${args.ticketId}`;
  const subjectLine = `Re: ${args.ticketSubject}`;
  const text = `${args.adminReply}

Please don't reply directly to this email — use the link below to respond.
View ticket: ${ticketUrl}`;
  const html = wrap(`
    <p>${escapeHtml(args.adminReply).replace(/\n/g, "<br/>")}</p>
    <p>Please don't reply directly to this email — use the link below to respond.</p>
    <p><a href="${ticketUrl}">View ticket</a></p>
  `);
  return { subject: subjectLine, html, text };
}

/**
 * Public marketing-site "Contact us" form (POST /api/contact). Reply-To is
 * set to the submitter's email so the team can just hit reply — see the
 * optional `replyTo` on SendEmailInput above.
 */
export function contactFormEmail(args: { name: string; email: string; subject: string; message: string }) {
  const subjectLine = `Contact form: ${args.subject || "New message"}`;
  const text = `New message from the VibePin contact form.

Name: ${args.name || "—"}
Email: ${args.email}
Subject: ${args.subject || "—"}

${args.message}`;
  const html = wrap(`
    <p><strong>New message from the VibePin contact form.</strong></p>
    <p>
      Name: ${escapeHtml(args.name || "—")}<br/>
      Email: ${escapeHtml(args.email)}<br/>
      Subject: ${escapeHtml(args.subject || "—")}
    </p>
    <p>${escapeHtml(args.message).replace(/\n/g, "<br/>")}</p>
  `);
  return { subject: subjectLine, html, text };
}
