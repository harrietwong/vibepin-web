"use client";

/**
 * SupportChat — the chat-first Help page panel (docs/prd/客服系统简化版v1.1.txt
 * §5/§15). One support_tickets row is the conversation record under the hood
 * (migrate_v43), but this surface never shows a ticket number, "View
 * ticket", or a queue/status string — only a chat and, once escalated, a
 * plain confirmation that support will reply by email.
 *
 * Persistence: the active conversationId (+ a locally-tracked escalated
 * flag, since the safe GET /api/support/tickets/:id shape doesn't expose
 * escalationState) lives in sessionStorage so a reload restores the thread
 * instead of silently starting a new ticket.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import {
  escalateSupportConversation,
  fetchMySupportTicket,
  sendAiFeedback,
  sendSupportChatMessage,
  startSupportConversation,
  type SupportChatMessage,
} from "@/lib/support/client";
import { useSupportContext } from "@/lib/support/useSupportContext";

const UI = {
  card: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2236)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #4A5568)",
  error: "#EF4444",
  success: "#34D399",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

const STORAGE_KEY = "vp:support-chat:conversation";

type StoredConversation = { conversationId: string; escalated: boolean };

function readStored(): StoredConversation | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredConversation>;
    if (typeof parsed.conversationId !== "string" || !parsed.conversationId) return null;
    return { conversationId: parsed.conversationId, escalated: !!parsed.escalated };
  } catch {
    return null;
  }
}

function writeStored(conversationId: string, escalated: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ conversationId, escalated }));
  } catch {
    /* ignore (private mode / quota) */
  }
}

function clearStored() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function TypingRow({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: UI.textMuted, fontSize: 11.5, padding: "2px 2px" }}>
      <Loader2 size={12} className="animate-spin" /> {label}
    </div>
  );
}

function MessageBubble({ message }: { message: SupportChatMessage }) {
  if (message.senderType === "system") {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "2px 0" }}>
        <div style={{ maxWidth: "88%", textAlign: "center", padding: "9px 13px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: `1px solid ${UI.border}` }}>
          <p style={{ margin: 0, fontSize: 9.5, fontWeight: 800, color: UI.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            VibePin Support · Automatic confirmation
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 12.5, color: UI.textSec, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{message.body}</p>
        </div>
      </div>
    );
  }

  const isUser = message.senderType === "user";
  const label = message.senderType === "ai" ? "VibePin AI · Automated answer" : message.senderType === "admin" ? "VibePin Support" : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: isUser ? "flex-end" : "flex-start" }}>
      {label && <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: UI.textMuted }}>{label}</p>}
      <div
        style={{
          maxWidth: "82%",
          padding: "10px 13px",
          borderRadius: 12,
          background: isUser ? UI.gradient : UI.surface2,
          color: isUser ? "#fff" : UI.text,
        }}
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{message.body}</p>
      </div>
    </div>
  );
}

export type SupportChatProps = {
  initialContext?: Record<string, unknown>;
  seedText?: string;
  compact?: boolean;
};

export function SupportChat({ initialContext, seedText, compact }: SupportChatProps) {
  const { gatherAmbientContext } = useSupportContext();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SupportChatMessage[]>([]);
  const [escalated, setEscalated] = useState(false);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [input, setInput] = useState(seedText ?? "");
  // Lazy-initialized from sessionStorage so mounting never needs a synchronous
  // setState call inside the restore effect below — it starts true only when
  // there's actually something to restore.
  const [restoring, setRestoring] = useState(() => !!readStored());
  const [sending, setSending] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [escalateBusy, setEscalateBusy] = useState(false);
  const [feedbackGivenForMessageId, setFeedbackGivenForMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Ambient context is gathered once per mount — the caller's initialContext
  // (draftId, publishJobId, …) is source-specific and shouldn't change under
  // this component's feet mid-conversation.
  const ambientContext = useMemo(() => gatherAmbientContext(initialContext), [gatherAmbientContext, initialContext]);

  useEffect(() => {
    const stored = readStored();
    if (!stored) return;
    fetchMySupportTicket(stored.conversationId)
      .then((data) => {
        const restoredMessages: SupportChatMessage[] = data.messages.map((m) => ({
          id: m.id,
          senderType: m.senderType,
          body: m.body,
          createdAt: m.createdAt,
        }));
        setConversationId(stored.conversationId);
        setMessages(restoredMessages);
        // Trust the stored flag OR the presence of a system confirmation
        // message — either is sufficient evidence the conversation already
        // escalated, since the safe ticket shape doesn't expose escalationState.
        setEscalated(stored.escalated || restoredMessages.some((m) => m.senderType === "system"));
        setAccountEmail(data.ticket.email ?? null);
      })
      .catch(() => {
        // Stale/invalid id (deleted, belongs to another session, etc) — drop it
        // and let the panel fall back to a fresh empty conversation.
        clearStored();
      })
      .finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  const lastAiMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].senderType === "ai") return messages[i].id;
    }
    return null;
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    setSending(true);

    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [...prev, { id: tempId, senderType: "user", body: text, createdAt: new Date().toISOString() }]);

    try {
      if (!conversationId) {
        const res = await startSupportConversation(text, ambientContext);
        setConversationId(res.conversationId);
        setMessages(res.messages);
        setEscalated(res.escalated);
        setAccountEmail(res.accountEmail);
        writeStored(res.conversationId, res.escalated);
      } else {
        const res = await sendSupportChatMessage(conversationId, text);
        setMessages(res.messages);
        setEscalated(res.escalated);
        setAccountEmail((prev) => res.accountEmail ?? prev);
        writeStored(conversationId, res.escalated);
      }
    } catch (e) {
      setError((e as Error).message || "Failed to send your message. Please try again.");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(text);
    } finally {
      setSending(false);
    }
  }, [ambientContext, conversationId, input, sending]);

  const handleSolved = useCallback(async () => {
    if (!conversationId || feedbackBusy) return;
    setFeedbackBusy(true);
    setError(null);
    try {
      await sendAiFeedback(conversationId, true);
      setFeedbackGivenForMessageId(lastAiMessageId);
    } catch (e) {
      setError((e as Error).message || "Failed to record feedback.");
    } finally {
      setFeedbackBusy(false);
    }
  }, [conversationId, feedbackBusy, lastAiMessageId]);

  const handleNeedHelp = useCallback(async () => {
    if (!conversationId || escalateBusy) return;
    setEscalateBusy(true);
    setError(null);
    try {
      const res = await escalateSupportConversation(conversationId);
      setEscalated(res.escalated);
      setAccountEmail((prev) => res.accountEmail ?? prev);
      writeStored(conversationId, res.escalated);
    } catch (e) {
      setError((e as Error).message || "Failed to request human help.");
    } finally {
      setEscalateBusy(false);
    }
  }, [conversationId, escalateBusy]);

  function handleStartNew() {
    clearStored();
    setConversationId(null);
    setMessages([]);
    setEscalated(false);
    setAccountEmail(null);
    setFeedbackGivenForMessageId(null);
    setError(null);
    setInput("");
  }

  const showFeedbackPills = !escalated && lastAiMessageId !== null && feedbackGivenForMessageId !== lastAiMessageId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 10 : 14, minHeight: 0 }}>
      {restoring && <TypingRow label="Loading your conversation…" />}

      {!restoring && messages.length === 0 && (
        <p style={{ margin: 0, fontSize: 12.5, color: UI.textSec, lineHeight: 1.5 }}>
          Ask about publishing, Pinterest connection, credits, billing…
        </p>
      )}

      {!restoring && messages.length > 0 && (
        <div
          ref={listRef}
          className="studio-scroll"
          data-testid="support-chat-messages"
          style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: compact ? 320 : 420, overflowY: "auto", padding: "2px 2px" }}
        >
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}

          {sending && !escalated && <TypingRow label="VibePin AI is typing…" />}

          {showFeedbackPills && (
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <button
                type="button"
                data-testid="support-chat-solved"
                onClick={() => void handleSolved()}
                disabled={feedbackBusy}
                style={{
                  padding: "6px 13px", borderRadius: 999, border: "1px solid rgba(52,211,153,0.4)",
                  background: "rgba(52,211,153,0.1)", color: UI.success, fontSize: 11.5, fontWeight: 700,
                  cursor: feedbackBusy ? "not-allowed" : "pointer", opacity: feedbackBusy ? 0.6 : 1,
                }}
              >
                This solved my issue
              </button>
              <button
                type="button"
                data-testid="support-chat-need-help"
                onClick={() => void handleNeedHelp()}
                disabled={escalateBusy}
                style={{
                  padding: "6px 13px", borderRadius: 999, border: `1px solid ${UI.border}`,
                  background: "transparent", color: UI.textSec, fontSize: 11.5, fontWeight: 700,
                  cursor: escalateBusy ? "not-allowed" : "pointer", opacity: escalateBusy ? 0.6 : 1,
                }}
              >
                {escalateBusy ? "Requesting…" : "I still need help"}
              </button>
            </div>
          )}

          {feedbackGivenForMessageId === lastAiMessageId && feedbackGivenForMessageId !== null && (
            <p style={{ margin: 0, fontSize: 12, color: UI.success }}>Great — glad that helped.</p>
          )}
        </div>
      )}

      {escalated && (
        <div
          data-testid="support-chat-escalated-banner"
          style={{ padding: "14px 16px", borderRadius: 12, border: "1px solid rgba(124,58,237,0.35)", background: "rgba(124,58,237,0.08)", display: "flex", flexDirection: "column", gap: 4 }}
        >
          <p style={{ margin: 0, fontSize: 13.5, fontWeight: 800, color: UI.text }}>Request sent</p>
          <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
            We&apos;ve sent your message to the VibePin support team.
          </p>
          <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
            We&apos;ll reply to your account email: <strong style={{ color: UI.text }}>{accountEmail ?? "your account email"}</strong>
          </p>
          <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>You don&apos;t need to keep this page open.</p>
        </div>
      )}

      {error && <p style={{ margin: 0, fontSize: 12, color: UI.error }}>{error}</p>}

      {escalated && (
        <p style={{ margin: 0, fontSize: 11, color: UI.textMuted }}>Add more details — our team will see them before replying</p>
      )}

      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <input
          data-testid="support-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about publishing, Pinterest connection, credits, billing…"
          disabled={sending || restoring}
          onKeyDown={(e) => { if (e.key === "Enter") void handleSend(); }}
          style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.surface2, color: UI.text, fontSize: 13 }}
        />
        <button
          type="button"
          data-testid="support-chat-send"
          onClick={() => void handleSend()}
          disabled={sending || restoring || !input.trim()}
          style={{
            padding: "0 16px", borderRadius: 9, border: "none", background: UI.gradient, color: "#fff",
            display: "flex", alignItems: "center", cursor: (sending || !input.trim()) ? "not-allowed" : "pointer",
            opacity: (sending || !input.trim()) ? 0.7 : 1,
          }}
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>

      {conversationId && (
        <button
          type="button"
          data-testid="support-chat-start-new"
          onClick={handleStartNew}
          style={{ alignSelf: "flex-start", background: "none", border: "none", padding: 0, fontSize: 11, color: UI.textMuted, textDecoration: "underline", cursor: "pointer" }}
        >
          Start new conversation
        </button>
      )}
    </div>
  );
}
