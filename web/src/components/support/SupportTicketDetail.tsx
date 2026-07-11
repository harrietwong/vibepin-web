"use client";

/**
 * SupportTicketDetail — user-facing ticket view. Messages exclude internal
 * notes at the API layer (not just here) so there's no risk of leaking them.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Send, Paperclip } from "lucide-react";
import { fetchMySupportTicket, replyToMySupportTicket, sendAiFeedback } from "@/lib/support/client";
import { SUPPORT_CATEGORY_LABELS, type SupportAttachment, type SupportMessage, type SupportTicket } from "@/lib/support/types";

const UI = {
  card: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2236)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #4A5568)",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

type TicketAttachment = Omit<SupportAttachment, "ticketId">;
type AiFeedbackVerdict = "helped" | "not_helpful" | null;

function AttachmentThumb({ attachment }: { attachment: TicketAttachment }) {
  const isImage = !!attachment.fileType && attachment.fileType.startsWith("image/");
  if (isImage) {
    return (
      <a href={attachment.fileUrl} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.fileUrl}
          alt={attachment.fileName || "Attachment"}
          style={{ maxWidth: 180, maxHeight: 180, borderRadius: 8, cursor: "pointer", display: "block", border: `1px solid ${UI.border}` }}
        />
      </a>
    );
  }
  return (
    <a
      href={attachment.fileUrl}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999,
        border: `1px solid ${UI.border}`, background: UI.surface2, color: UI.textSec, fontSize: 11.5, fontWeight: 600, textDecoration: "none",
      }}
    >
      <Paperclip size={11} />
      {attachment.fileName || "Attachment"}
    </a>
  );
}

export function SupportTicketDetail({ ticketId }: { ticketId: string }) {
  const [ticket, setTicket] = useState<Omit<SupportTicket, "context"> | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [aiFeedback, setAiFeedback] = useState<AiFeedbackVerdict>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetchMySupportTicket(ticketId)
      .then((data) => {
        setTicket(data.ticket);
        setMessages(data.messages);
        setAttachments(data.attachments ?? []);
        setAiFeedback(data.aiFeedback ?? null);
      })
      .catch((e) => setError((e as Error).message));
  }, [ticketId]);

  // Lightweight polling so an admin (or AI) reply shows up without a manual
  // refresh. Silent on failure — a missed poll shouldn't surface an error
  // banner over an otherwise-working page — and never touches the reply
  // input, so an in-progress draft reply is never lost mid-poll.
  useEffect(() => {
    const interval = setInterval(() => {
      fetchMySupportTicket(ticketId)
        .then((data) => {
          setTicket(data.ticket);
          setMessages(data.messages);
          setAttachments(data.attachments ?? []);
          // Ratchet only: once a verdict is recorded locally (e.g. the POST
          // just completed but this poll raced in with stale data), never
          // let a poll clear it back to null and resurrect the feedback
          // buttons.
          setAiFeedback((prev) => data.aiFeedback ?? prev);
        })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [ticketId]);

  async function handleReply() {
    if (!reply.trim()) return;
    setSending(true);
    try {
      const message = await replyToMySupportTicket(ticketId, reply.trim());
      setMessages((prev) => [...prev, message]);
      setReply("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function handleAiFeedback(helped: boolean) {
    setFeedbackBusy(true);
    try {
      const verdict = await sendAiFeedback(ticketId, helped);
      setAiFeedback(verdict);
      if (verdict === "helped") {
        setTicket((prev) => (prev ? { ...prev, status: "Resolved" } : prev));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFeedbackBusy(false);
    }
  }

  const firstUserMessageId = useMemo(() => messages.find((m) => m.senderType === "user")?.id ?? null, [messages]);
  const lastAiMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].senderType === "ai") return messages[i].id;
    }
    return null;
  }, [messages]);
  const unassignedAttachments = useMemo(() => attachments.filter((a) => a.messageId === null), [attachments]);

  if (error) return <p style={{ fontSize: 13, color: "#EF4444" }}>{error}</p>;
  if (!ticket) return <div style={{ display: "flex", alignItems: "center", gap: 8, color: UI.textSec, fontSize: 13 }}><Loader2 size={15} className="animate-spin" /> Loading ticket…</div>;

  const showFeedbackPrompt = ticket.status !== "Resolved" && ticket.status !== "Closed";

  return (
    <div data-testid="support-ticket-detail" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: UI.textMuted }}>{ticket.ticketNumber}</p>
        <h1 style={{ margin: "2px 0 0", fontSize: 19, fontWeight: 800, color: UI.text }}>{ticket.subject || SUPPORT_CATEGORY_LABELS[ticket.category]}</h1>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: UI.textSec }}>
          {SUPPORT_CATEGORY_LABELS[ticket.category]} · <span data-testid="support-ticket-status">{ticket.status}</span>
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.map((m) => {
          const isAgent = m.senderType === "admin" || m.senderType === "ai";
          const messageAttachments = attachments.filter((a) => a.messageId === m.id);
          const showUnassigned = m.id === firstUserMessageId && unassignedAttachments.length > 0;
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: isAgent ? "flex-start" : "flex-end" }}>
              <div style={{
                alignSelf: isAgent ? "flex-start" : "flex-end",
                maxWidth: "80%", padding: "10px 13px", borderRadius: 12,
                background: isAgent ? UI.surface2 : UI.gradient,
                color: isAgent ? UI.text : "#fff",
              }}>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{m.body}</p>
                <p style={{ margin: "4px 0 0", fontSize: 10, opacity: 0.7 }}>
                  {m.senderType === "admin" ? "Support" : m.senderType === "ai" ? "VibePin AI · automated reply" : "You"}
                </p>
              </div>

              {(messageAttachments.length > 0 || showUnassigned) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxWidth: "80%" }}>
                  {messageAttachments.map((a) => <AttachmentThumb key={a.id} attachment={a} />)}
                  {showUnassigned && unassignedAttachments.map((a) => <AttachmentThumb key={a.id} attachment={a} />)}
                </div>
              )}

              {m.id === lastAiMessageId && (
                <div data-testid="support-ai-feedback" style={{ maxWidth: "80%", marginTop: 2 }}>
                  {aiFeedback === "helped" ? (
                    <p style={{ margin: 0, fontSize: 12, color: "#34D399" }}>Great — this ticket has been marked resolved.</p>
                  ) : aiFeedback === "not_helpful" ? (
                    <p style={{ margin: 0, fontSize: 12, color: UI.textSec }}>Thanks — a teammate will follow up by email.</p>
                  ) : showFeedbackPrompt ? (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        data-testid="support-ai-feedback-yes"
                        onClick={() => void handleAiFeedback(true)}
                        disabled={feedbackBusy}
                        style={{
                          padding: "5px 12px", borderRadius: 999, border: "1px solid rgba(52,211,153,0.4)",
                          background: "rgba(52,211,153,0.1)", color: "#34D399", fontSize: 11.5, fontWeight: 700, cursor: "pointer", opacity: feedbackBusy ? 0.6 : 1,
                        }}
                      >
                        ✓ This solved my issue
                      </button>
                      <button
                        type="button"
                        data-testid="support-ai-feedback-no"
                        onClick={() => void handleAiFeedback(false)}
                        disabled={feedbackBusy}
                        style={{
                          padding: "5px 12px", borderRadius: 999, border: `1px solid ${UI.border}`,
                          background: "transparent", color: UI.textSec, fontSize: 11.5, fontWeight: 700, cursor: "pointer", opacity: feedbackBusy ? 0.6 : 1,
                        }}
                      >
                        ✗ I still need help
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {ticket.status !== "Closed" && (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            data-testid="support-ticket-reply-input"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Write a reply…"
            style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.surface2, color: UI.text, fontSize: 13 }}
            onKeyDown={(e) => { if (e.key === "Enter") void handleReply(); }}
          />
          <button type="button" data-testid="support-ticket-reply-submit" onClick={() => void handleReply()} disabled={sending || !reply.trim()}
            style={{ padding: "0 16px", borderRadius: 9, border: "none", background: UI.gradient, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", opacity: sending ? 0.7 : 1 }}>
            <Send size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
