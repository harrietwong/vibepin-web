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
};

const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendEmail(input: SendEmailInput): Promise<{ ok: boolean; skipped?: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SUPPORT_EMAIL_FROM || "VibePin Support <support@vibepin.co>";

  if (!apiKey) {
    console.info(`[support/email] No email provider configured — logging instead of sending.
  to: ${input.to}
  subject: ${input.subject}
  ---
  ${input.text}`);
    return { ok: true, skipped: true };
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html, text: input.text }),
    });
    if (!res.ok) {
      console.error("[support/email] send failed", res.status, await res.text().catch(() => ""));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error("[support/email] send threw", err);
    return { ok: false };
  }
}

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function wrap(bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1A2236;max-width:520px">${bodyHtml}</div>`;
}

export function userTicketConfirmationEmail(args: { ticketNumber: string; userNameOrEmail: string; subject: string }) {
  const subjectLine = `We received your support request ${args.ticketNumber}`;
  const text = `Hi ${args.userNameOrEmail},

We received your support request.

Ticket: ${args.ticketNumber}
Subject: ${args.subject}

We'll reply by email.`;
  const html = wrap(`
    <p>Hi ${escapeHtml(args.userNameOrEmail)},</p>
    <p>We received your support request.</p>
    <p><strong>Ticket:</strong> ${escapeHtml(args.ticketNumber)}<br/>
    <strong>Subject:</strong> ${escapeHtml(args.subject)}</p>
    <p>We'll reply by email.</p>
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

View ticket: ${ticketUrl}`;
  const html = wrap(`
    <p>${escapeHtml(args.adminReply).replace(/\n/g, "<br/>")}</p>
    <p><a href="${ticketUrl}">View ticket</a></p>
  `);
  return { subject: subjectLine, html, text };
}
