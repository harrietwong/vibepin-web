"use client";

/**
 * SupportTicketDetail — user-facing ticket view. Messages exclude internal
 * notes at the API layer (not just here) so there's no risk of leaking them.
 */

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { fetchMySupportTicket, replyToMySupportTicket } from "@/lib/support/client";
import { SUPPORT_CATEGORY_LABELS, type SupportMessage, type SupportTicket } from "@/lib/support/types";

const UI = {
  card: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2236)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #4A5568)",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

export function SupportTicketDetail({ ticketId }: { ticketId: string }) {
  const [ticket, setTicket] = useState<Omit<SupportTicket, "context"> | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetchMySupportTicket(ticketId)
      .then((data) => { setTicket(data.ticket); setMessages(data.messages); })
      .catch((e) => setError((e as Error).message));
  }, [ticketId]);

  // Lightweight polling so an admin (or AI) reply shows up without a manual
  // refresh. Silent on failure — a missed poll shouldn't surface an error
  // banner over an otherwise-working page — and never touches the reply
  // input, so an in-progress draft reply is never lost mid-poll.
  useEffect(() => {
    const interval = setInterval(() => {
      fetchMySupportTicket(ticketId)
        .then((data) => { setTicket(data.ticket); setMessages(data.messages); })
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

  if (error) return <p style={{ fontSize: 13, color: "#EF4444" }}>{error}</p>;
  if (!ticket) return <div style={{ display: "flex", alignItems: "center", gap: 8, color: UI.textSec, fontSize: 13 }}><Loader2 size={15} className="animate-spin" /> Loading ticket…</div>;

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
          return (
            <div key={m.id} style={{
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
