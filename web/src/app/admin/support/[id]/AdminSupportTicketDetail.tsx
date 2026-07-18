"use client";

/**
 * AdminSupportTicketDetail — /admin/support/:id. Context panel, conversation
 * (internal notes visually marked, never sent to the user API), reply box,
 * status/priority selectors, resolve/close shortcuts.
 *
 * Phase B: VibePin's support operators work in Chinese while customers
 * write in any language. This adds a Chinese AI summary of the ticket,
 * automatic user-message -> Chinese translation, and a reply composer
 * where the admin writes Chinese and gets an editable translated preview
 * before sending. Translation failures never block reading or replying —
 * "直接发送原文" always sends the Chinese draft untranslated.
 */

import { useEffect, useState } from "react";
import { Loader2, Send, Lock, Sparkles, Languages, RefreshCw, Paperclip, Mail, AlertTriangle } from "lucide-react";
import {
  SUPPORT_CATEGORY_LABELS, SUPPORT_PRIORITIES, SUPPORT_STATUSES,
  type SupportAttachment, type SupportEmail, type SupportMessage, type SupportPriority, type SupportStatus, type SupportTicket,
} from "@/lib/support/types";
import { escalationReasonLabelZh, isHighRiskReply } from "@/lib/support/inboxCore";

const EMAIL_STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  sent: { label: "sent", color: "#059669", bg: "rgba(5,150,105,0.12)" },
  sending: { label: "sending", color: "#D97706", bg: "rgba(217,119,6,0.12)" },
  failed: { label: "failed", color: "#DC2626", bg: "rgba(220,38,38,0.12)" },
};

const ESCALATION_STATE_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  needs_email_reply: { label: "待回复", color: "#2563EB", bg: "rgba(37,99,235,0.12)" },
  email_failed: { label: "发送失败", color: "#DC2626", bg: "rgba(220,38,38,0.12)" },
  email_sent: { label: "已发送", color: "#059669", bg: "rgba(5,150,105,0.12)" },
  processing: { label: "处理中", color: "#D97706", bg: "rgba(217,119,6,0.12)" },
  closed: { label: "已关闭", color: "var(--admin-text-muted)", bg: "var(--admin-surface-2)" },
};

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function AdminAttachmentThumb({ attachment }: { attachment: SupportAttachment }) {
  const isImage = !!attachment.fileType && attachment.fileType.startsWith("image/");
  if (isImage) {
    return (
      <a href={attachment.fileUrl} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.fileUrl}
          alt={attachment.fileName || "Attachment"}
          style={{ maxWidth: 180, maxHeight: 180, borderRadius: 8, cursor: "pointer", display: "block", border: "1px solid var(--admin-border)" }}
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
        border: "1px solid var(--admin-border)", background: "var(--admin-surface-2)", color: "var(--admin-text-secondary)", fontSize: 11.5, fontWeight: 600, textDecoration: "none",
      }}
    >
      <Paperclip size={11} />
      {attachment.fileName || "Attachment"}
    </a>
  );
}

const HIGHLIGHT_KEYS = new Set([
  "draftId", "publishJobId", "generationRequestId", "boardName", "publishErrorMessage",
  "creditsBefore", "creditsAfter", "subscriptionId", "connectionStatus",
]);

const selectStyle: React.CSSProperties = {
  padding: "7px 10px", borderRadius: 8, border: "1px solid var(--admin-border)", background: "var(--admin-surface)", color: "var(--admin-text)", fontSize: 12.5, fontWeight: 700,
};

const aiButtonStyle: React.CSSProperties = {
  padding: "7px 12px", borderRadius: 8, border: "1px solid rgba(13,148,136,0.35)", background: "rgba(13,148,136,0.1)",
  color: "#0D9488", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export function AdminSupportTicketDetail({ ticketId }: { ticketId: string }) {
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [attachments, setAttachments] = useState<SupportAttachment[]>([]);
  const [emails, setEmails] = useState<SupportEmail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Reply composer state (Chinese draft -> translated preview -> send).
  const [replyZh, setReplyZh] = useState("");
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewOriginal, setPreviewOriginal] = useState<string | null>(null);
  const [previewTargetLanguage, setPreviewTargetLanguage] = useState<string | null>(null);
  const [previewSkipped, setPreviewSkipped] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);

  // Email-reply mode (escalation_state needs_email_reply | email_failed).
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => newIdempotencyKey());
  const [sendEmailBusy, setSendEmailBusy] = useState(false);
  const [sendEmailError, setSendEmailError] = useState<string | null>(null);
  const [retryBusyIds, setRetryBusyIds] = useState<Set<string>>(new Set());

  // AI summary state.
  const [summaryBusy, setSummaryBusy] = useState(false);

  // Per-message retry-translation state.
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());

  function mergeMessages(updated: SupportMessage[]) {
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of updated) byId.set(m.id, m);
      return prev.map((m) => byId.get(m.id) ?? m);
    });
  }

  // Silent, non-blocking: translate any user messages that don't already
  // have a successful translation. Failures are swallowed — the message
  // bubble itself shows a "翻译失败" state with a manual retry.
  async function autoTranslate(currentMessages: SupportMessage[]) {
    const needsTranslation = currentMessages.some((m) => m.senderType === "user" && !m.isInternal && m.translationStatus !== "success");
    if (!needsTranslation) return;
    try {
      const d = await jsonFetch<{ messages: SupportMessage[]; customerLanguage: string | null }>(
        `/api/admin/support/tickets/${ticketId}/translate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      mergeMessages(d.messages);
      if (d.customerLanguage) setTicket((prev) => (prev ? { ...prev, customerLanguage: d.customerLanguage } : prev));
    } catch {
      // Silent — translation is best-effort and must never block the UI.
    }
  }

  function load() {
    jsonFetch<{ ticket: SupportTicket; messages: SupportMessage[]; attachments: SupportAttachment[]; emails: SupportEmail[] }>(`/api/admin/support/tickets/${ticketId}`)
      .then((d) => {
        setTicket(d.ticket);
        setMessages(d.messages);
        setAttachments(d.attachments ?? []);
        setEmails(d.emails ?? []);
        void autoTranslate(d.messages);
      })
      .catch((e) => setError(e.message));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` intentionally re-runs only on ticketId; autoTranslate is a stable-enough helper closed over ticketId, not reactive state.
  useEffect(load, [ticketId]);

  async function retryTranslate(messageId: string) {
    setRetryingIds((prev) => new Set(prev).add(messageId));
    try {
      const d = await jsonFetch<{ messages: SupportMessage[]; customerLanguage: string | null }>(
        `/api/admin/support/tickets/${ticketId}/translate`,
        { method: "POST", body: JSON.stringify({ messageIds: [messageId] }) },
      );
      mergeMessages(d.messages);
      if (d.customerLanguage) setTicket((prev) => (prev ? { ...prev, customerLanguage: d.customerLanguage } : prev));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetryingIds((prev) => { const next = new Set(prev); next.delete(messageId); return next; });
    }
  }

  async function patch(body: Partial<{ status: SupportStatus; priority: SupportPriority }>) {
    if (!ticket) return;
    setBusy(true);
    try {
      const d = await jsonFetch<{ ticket: SupportTicket }>(`/api/admin/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify(body) });
      setTicket(d.ticket);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function generateSummary() {
    setSummaryBusy(true);
    try {
      const d = await jsonFetch<{ summary: string; aiSummaryAt: string }>(`/api/admin/support/tickets/${ticketId}/summary`, { method: "POST" });
      setTicket((prev) => (prev ? { ...prev, aiSummary: d.summary, aiSummaryAt: d.aiSummaryAt } : prev));
    } catch (e) { setError((e as Error).message); } finally { setSummaryBusy(false); }
  }

  async function suggestReply() {
    setSuggestBusy(true);
    try {
      const d = await jsonFetch<{ suggestion: string }>(`/api/admin/support/tickets/${ticketId}/suggest-reply`, { method: "POST" });
      setReplyZh(d.suggestion);
    } catch (e) { setError((e as Error).message); } finally { setSuggestBusy(false); }
  }

  async function previewTranslation() {
    if (!replyZh.trim()) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const d = await jsonFetch<{ translatedText: string; targetLanguage: string; skipped?: boolean }>(
        `/api/admin/support/tickets/${ticketId}/preview-translation`,
        { method: "POST", body: JSON.stringify({ zhText: replyZh.trim() }) },
      );
      setPreviewText(d.translatedText);
      setPreviewOriginal(d.translatedText);
      setPreviewTargetLanguage(d.targetLanguage);
      setPreviewSkipped(!!d.skipped);
    } catch (e) {
      setPreviewError((e as Error).message || "Translation failed");
    } finally {
      setPreviewBusy(false);
    }
  }

  function resetComposer() {
    setReplyZh("");
    setPreviewText(null);
    setPreviewOriginal(null);
    setPreviewTargetLanguage(null);
    setPreviewSkipped(false);
    setPreviewError(null);
    setSendEmailError(null);
    setIdempotencyKey(newIdempotencyKey());
  }

  async function sendReply() {
    if (!previewText || !replyZh.trim()) return;
    setSendBusy(true);
    try {
      const d = await jsonFetch<{ message: SupportMessage }>(`/api/admin/support/tickets/${ticketId}/reply`, {
        method: "POST",
        body: JSON.stringify({
          body: previewText,
          originalZh: replyZh.trim(),
          translatedLanguage: previewTargetLanguage ?? undefined,
          manuallyEdited: previewOriginal !== null && previewText !== previewOriginal,
        }),
      });
      setMessages((prev) => [...prev, d.message]);
      resetComposer();
      load();
    } catch (e) { setError((e as Error).message); } finally { setSendBusy(false); }
  }

  async function sendRaw() {
    if (!replyZh.trim()) return;
    setSendBusy(true);
    try {
      const d = await jsonFetch<{ message: SupportMessage }>(`/api/admin/support/tickets/${ticketId}/reply`, {
        method: "POST",
        body: JSON.stringify({ body: replyZh.trim() }),
      });
      setMessages((prev) => [...prev, d.message]);
      resetComposer();
      load();
    } catch (e) { setError((e as Error).message); } finally { setSendBusy(false); }
  }

  // Email reply mode (escalation_state needs_email_reply | email_failed):
  // primary send action becomes a real email through POST send-email, gated
  // on a successful translation preview (PRD §7.3 — send stays disabled
  // until the translated version has been reviewed). The button disables
  // itself immediately via sendEmailBusy; a fresh idempotencyKey is minted
  // whenever the draft changes so a retried click can never double-send.
  async function sendEmailNow() {
    if (!previewText || !replyZh.trim() || sendEmailBusy) return;
    setSendEmailBusy(true);
    setSendEmailError(null);
    const key = idempotencyKey;
    try {
      const res = await fetch(`/api/admin/support/tickets/${ticketId}/send-email`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          translatedText: previewText,
          originalZh: replyZh.trim(),
          targetLanguage: previewTargetLanguage ?? undefined,
          translationEdited: previewOriginal !== null && previewText !== previewOriginal,
          idempotencyKey: key,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.email) {
        setEmails((prev) => {
          const exists = prev.some((e) => e.id === data.email.id);
          return exists ? prev.map((e) => (e.id === data.email.id ? data.email : e)) : [...prev, data.email];
        });
      }
      if (res.ok) {
        resetComposer();
        load();
      } else {
        setSendEmailError(data.error || `Request failed (${res.status})`);
      }
    } catch (e) {
      setSendEmailError((e as Error).message);
    } finally {
      setSendEmailBusy(false);
    }
  }

  async function retryEmail(emailId: string) {
    setRetryBusyIds((prev) => new Set(prev).add(emailId));
    try {
      const res = await fetch(`/api/admin/support/tickets/${ticketId}/retry-email`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailId }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.email) {
        setEmails((prev) => prev.map((e) => (e.id === data.email.id ? data.email : e)));
      }
      if (res.ok) load();
      else setError(data.error || `Request failed (${res.status})`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetryBusyIds((prev) => { const next = new Set(prev); next.delete(emailId); return next; });
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      const d = await jsonFetch<{ message: SupportMessage }>(`/api/admin/support/tickets/${ticketId}/internal-note`, { method: "POST", body: JSON.stringify({ body: note.trim() }) });
      setMessages((prev) => [...prev, d.message]);
      setNote("");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (error && !ticket) return <div style={{ padding: 24, color: "var(--admin-danger)", fontSize: 13 }}>{error}</div>;
  if (!ticket) return <div style={{ padding: 24, display: "flex", alignItems: "center", gap: 8, color: "var(--admin-text-muted)", fontSize: 13 }}><Loader2 size={15} className="animate-spin" /> Loading ticket…</div>;

  const contextEntries = Object.entries(ticket.context ?? {});
  const canSend = !!(previewText && replyZh.trim());
  const isEmailMode = ticket.escalationState === "needs_email_reply" || ticket.escalationState === "email_failed";
  const canSendEmail = !!(previewText && replyZh.trim() && !sendEmailBusy);
  const isHighRisk = isHighRiskReply({ category: ticket.category, escalationReason: ticket.escalationReason, draftText: replyZh });
  const firstUserMessageId = messages.find((m) => m.senderType === "user")?.id ?? null;
  const unassignedAttachments = attachments.filter((a) => a.messageId === null);

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", color: "var(--admin-text)" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
        <div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--admin-text-muted)", fontWeight: 700 }}>{ticket.ticketNumber}</p>
          <h1 style={{ margin: "2px 0 0", fontSize: 19, fontWeight: 800 }}>{ticket.subject || SUPPORT_CATEGORY_LABELS[ticket.category]}</h1>
          <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--admin-text-secondary)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span>{ticket.email} · {SUPPORT_CATEGORY_LABELS[ticket.category]} · {ticket.source || "—"}</span>
            {ticket.customerLanguage && (
              <span data-testid="admin-support-customer-language" style={{
                padding: "1px 7px", borderRadius: 999, background: "rgba(67,56,202,0.14)", border: "1px solid rgba(67,56,202,0.35)",
                color: "var(--admin-accent)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase",
              }}>
                {ticket.customerLanguage}
              </span>
            )}
          </p>
        </div>

        {/* Escalation banner — visible for any conversation that has been escalated, even after email_sent/closed. */}
        {ticket.escalationState && ticket.escalationState !== "none" && (
          <div data-testid="admin-inbox-escalation-banner" style={{
            padding: "10px 14px", borderRadius: 10, background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.3)",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <AlertTriangle size={14} color="#D97706" />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--admin-text)" }}>
                升级原因：{escalationReasonLabelZh(ticket.escalationReason)}
              </span>
              {ticket.escalatedAt && (
                <span style={{ fontSize: 11, color: "var(--admin-text-muted)" }}>
                  升级于 {new Date(ticket.escalatedAt).toLocaleString()}
                </span>
              )}
            </div>
            {(() => {
              const meta = ESCALATION_STATE_BADGE[ticket.escalationState as string];
              if (!meta) return null;
              return (
                <span data-testid="admin-inbox-escalation-state" style={{ padding: "2px 9px", borderRadius: 999, fontSize: 11, fontWeight: 800, background: meta.bg, color: meta.color }}>
                  {meta.label}
                </span>
              );
            })()}
          </div>
        )}

        {/* AI summary card */}
        <div data-testid="admin-support-summary-card" style={{ padding: "12px 14px", borderRadius: 10, background: "rgba(67,56,202,0.08)", border: "1px solid rgba(67,56,202,0.25)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: "var(--admin-accent)", textTransform: "uppercase" }}>AI 摘要</p>
            <button type="button" data-testid="admin-support-summary-btn" onClick={() => void generateSummary()} disabled={summaryBusy}
              style={{ ...aiButtonStyle, borderColor: "rgba(67,56,202,0.35)", background: "rgba(67,56,202,0.12)", color: "var(--admin-accent)", padding: "4px 10px" }}>
              {summaryBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {ticket.aiSummary ? "刷新摘要" : "生成摘要"}
            </button>
          </div>
          {ticket.aiSummary ? (
            <>
              <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--admin-text)" }}>{ticket.aiSummary}</p>
              {ticket.aiSummaryAt && <p style={{ margin: "6px 0 0", fontSize: 10, color: "var(--admin-text-muted)" }}>更新于 {new Date(ticket.aiSummaryAt).toLocaleString()}</p>}
            </>
          ) : (
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--admin-text-muted)" }}>尚未生成摘要。</p>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.map((m) => {
            const isRetrying = retryingIds.has(m.id);
            const messageAttachments = attachments.filter((a) => a.messageId === m.id);
            const showUnassigned = m.id === firstUserMessageId && unassignedAttachments.length > 0;
            return (
              <div key={m.id} data-testid={m.isInternal ? "admin-internal-note" : "admin-message"} style={{
                padding: "10px 13px", borderRadius: 10,
                background: m.isInternal ? "rgba(217,119,6,0.08)" : m.senderType === "admin" ? "rgba(67,56,202,0.12)" : m.senderType === "ai" ? "rgba(13,148,136,0.12)" : "var(--admin-surface)",
                border: m.isInternal ? "1px dashed rgba(217,119,6,0.4)" : m.senderType === "ai" ? "1px solid rgba(13,148,136,0.35)" : "1px solid var(--admin-border)",
                color: "var(--admin-text)",
              }}>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{m.body}</p>

                {(messageAttachments.length > 0 || showUnassigned) && (
                  <div data-testid="admin-support-attachments" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                    {messageAttachments.map((a) => <AdminAttachmentThumb key={a.id} attachment={a} />)}
                    {showUnassigned && unassignedAttachments.map((a) => <AdminAttachmentThumb key={a.id} attachment={a} />)}
                  </div>
                )}

                {m.senderType === "user" && !m.isInternal && m.translatedText && (
                  <div data-testid="admin-support-message-translation" style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--admin-border)" }}>
                    <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "var(--admin-text-muted)" }}>中文翻译</p>
                    <p style={{ margin: "3px 0 0", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--admin-text-secondary)" }}>{m.translatedText}</p>
                  </div>
                )}
                {m.senderType === "user" && !m.isInternal && m.translationStatus === "failed" && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed rgba(220,38,38,0.3)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--admin-danger)" }}>翻译失败</span>
                    <button type="button" data-testid={`admin-support-retry-translate-${m.id}`} onClick={() => void retryTranslate(m.id)} disabled={isRetrying}
                      style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 6, border: "1px solid var(--admin-border)", background: "transparent", color: "var(--admin-text-secondary)", fontSize: 11, cursor: "pointer" }}>
                      {isRetrying ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                      重试
                    </button>
                  </div>
                )}
                {m.senderType === "admin" && m.originalText && (
                  <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--admin-text-muted)", whiteSpace: "pre-wrap" }}>原文(中文): {m.originalText}</p>
                )}

                <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--admin-text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  {m.isInternal && <Lock size={10} />}
                  {m.senderType === "admin" ? "Admin" : m.senderType === "user" ? "User" : m.senderType === "ai" ? "AI" : "System"}{m.isInternal ? " · internal note" : ""}
                </p>
              </div>
            );
          })}
        </div>

        {/* Reply composer: Chinese draft -> editable translated preview -> send.
            In email mode (escalation_state needs_email_reply|email_failed) the
            primary action sends a real email instead of an in-app reply, and
            translation preview is mandatory (no "直接发送原文" bypass). */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 11.5, fontWeight: 700, color: "var(--admin-text-muted)" }}>{isEmailMode ? "Reply by email" : "Reply to user"}</label>
          <textarea data-testid="admin-support-reply-zh" value={replyZh} onChange={(e) => { setReplyZh(e.target.value); setPreviewText(null); setPreviewOriginal(null); setPreviewError(null); setSendEmailError(null); setIdempotencyKey(newIdempotencyKey()); }}
            placeholder="用中文输入回复…" rows={3}
            style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid var(--admin-border)", background: "var(--admin-surface)", color: "var(--admin-text)", fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" data-testid="admin-support-suggest-btn" onClick={() => void suggestReply()} disabled={suggestBusy}
              style={aiButtonStyle}>
              {suggestBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              建议回复
            </button>
            <button type="button" data-testid="admin-support-preview-btn" onClick={() => void previewTranslation()} disabled={previewBusy || !replyZh.trim()}
              style={aiButtonStyle}>
              {previewBusy ? <Loader2 size={12} className="animate-spin" /> : <Languages size={12} />}
              翻译预览
            </button>
            {isEmailMode ? (
              <button type="button" data-testid="admin-inbox-send-email" onClick={() => void sendEmailNow()} disabled={!canSendEmail}
                style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "var(--admin-accent)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: canSendEmail ? "pointer" : "not-allowed", opacity: canSendEmail ? 1 : 0.6, display: "flex", alignItems: "center", gap: 6 }}>
                {sendEmailBusy ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
                发送邮件
              </button>
            ) : (
              <>
                <button type="button" data-testid="admin-support-send-btn" onClick={() => void sendReply()} disabled={sendBusy || !canSend}
                  style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "var(--admin-accent)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                  <Send size={12} />
                  发送
                </button>
                <button type="button" data-testid="admin-support-send-raw-btn" onClick={() => void sendRaw()} disabled={sendBusy || !replyZh.trim()}
                  style={{ padding: "7px 10px", borderRadius: 8, border: "none", background: "transparent", color: "var(--admin-text-muted)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>
                  直接发送原文
                </button>
              </>
            )}
          </div>

          {previewError && (
            <p style={{ margin: 0, fontSize: 11.5, color: "var(--admin-danger)" }}>
              {previewError}{isEmailMode ? " — 邮件模式下必须先成功生成译文预览才能发送。" : " — 可编辑上方中文后点击“直接发送原文”。"}
            </p>
          )}

          {isEmailMode && isHighRisk && (
            <p data-testid="admin-inbox-highrisk-note" style={{
              margin: 0, padding: "8px 12px", borderRadius: 8, fontSize: 11.5, lineHeight: 1.5,
              background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.3)", color: "#DC2626", display: "flex", gap: 6, alignItems: "flex-start",
            }}>
              <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
              This reply contains billing, account, or irreversible-action information. Please review the translated version before sending.
            </p>
          )}

          {previewText !== null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--admin-text-muted)" }}>
                {previewSkipped ? "预览（客户语言为中文，无需翻译）" : `预览（${previewTargetLanguage ?? "目标语言"}）— 可编辑`}
              </label>
              <textarea data-testid="admin-support-reply-preview" value={previewText} onChange={(e) => setPreviewText(e.target.value)} rows={3}
                style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid rgba(5,150,105,0.35)", background: "var(--admin-surface)", color: "var(--admin-text)", fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
            </div>
          )}

          {sendEmailError && <p style={{ margin: 0, fontSize: 11.5, color: "var(--admin-danger)" }}>Email could not be sent. {sendEmailError} The conversation remains in the pending list — review the error and try again.</p>}
        </div>

        {/* Email history — one row per send/retry attempt (support_emails). */}
        {emails.length > 0 && (
          <div data-testid="admin-inbox-email-history" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: "var(--admin-text-muted)" }}>Email history</label>
            {emails.map((em) => {
              const meta = EMAIL_STATUS_BADGE[em.status] ?? { label: em.status, color: "var(--admin-text-muted)", bg: "var(--admin-surface-2)" };
              const isRetrying = retryBusyIds.has(em.id);
              return (
                <div key={em.id} data-testid={`admin-inbox-email-row-${em.id}`} style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid var(--admin-border)", background: "var(--admin-surface)", display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ padding: "1px 8px", borderRadius: 999, fontSize: 10.5, fontWeight: 800, background: meta.bg, color: meta.color }}>{meta.label}</span>
                      <span style={{ fontSize: 12, color: "var(--admin-text)" }}>{em.toEmail}</span>
                    </div>
                    {em.status === "failed" && (
                      <button type="button" data-testid={`admin-inbox-retry-email-${em.id}`} onClick={() => void retryEmail(em.id)} disabled={isRetrying}
                        style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 6, border: "1px solid rgba(220,38,38,0.35)", background: "transparent", color: "#DC2626", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        {isRetrying ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                        重试
                      </button>
                    )}
                  </div>
                  <p style={{ margin: 0, fontSize: 11.5, color: "var(--admin-text-secondary)" }}>{em.subject}</p>
                  <p style={{ margin: 0, fontSize: 10.5, color: "var(--admin-text-muted)" }}>
                    {em.sentAt ? `Sent ${new Date(em.sentAt).toLocaleString()}` : `Created ${new Date(em.createdAt).toLocaleString()}`}
                    {em.retryCount > 0 && ` · retry ${em.retryCount}`}
                  </p>
                  {em.status === "failed" && em.failureMessage && (
                    <p style={{ margin: 0, fontSize: 10.5, color: "#DC2626" }}>{em.failureMessage}</p>
                  )}
                  {em.providerMessageId && (
                    <p style={{ margin: 0, fontSize: 10, fontFamily: "monospace", color: "var(--admin-text-muted)" }}>{em.providerMessageId}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11.5, fontWeight: 700, color: "var(--admin-text-muted)" }}>Internal note (never emailed, never shown to user)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input data-testid="admin-support-note-input" value={note} onChange={(e) => setNote(e.target.value)}
              style={{ flex: 1, padding: "9px 12px", borderRadius: 8, border: "1px dashed rgba(217,119,6,0.4)", background: "var(--admin-surface)", color: "var(--admin-text)", fontSize: 13 }} />
            <button type="button" data-testid="admin-support-note-submit" onClick={() => void addNote()} disabled={busy || !note.trim()}
              style={{ padding: "0 14px", borderRadius: 8, border: "1px solid rgba(217,119,6,0.4)", background: "transparent", color: "#D97706", cursor: "pointer" }}>
              Add note
            </button>
          </div>
        </div>
      </div>

      <div style={{ width: 300, flexShrink: 0, borderLeft: "1px solid var(--admin-border)", padding: 20, display: "flex", flexDirection: "column", gap: 18, overflowY: "auto" }}>
        <div>
          <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "var(--admin-text-muted)", textTransform: "uppercase" }}>Status</p>
          <select data-testid="admin-support-status-select" value={ticket.status} disabled={busy}
            onChange={(e) => void patch({ status: e.target.value as SupportStatus })} style={{ ...selectStyle, width: "100%" }}>
            {SUPPORT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "var(--admin-text-muted)", textTransform: "uppercase" }}>Priority</p>
          <select data-testid="admin-support-priority-select" value={ticket.priority} disabled={busy}
            onChange={(e) => void patch({ priority: e.target.value as SupportPriority })} style={{ ...selectStyle, width: "100%" }}>
            {SUPPORT_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" data-testid="admin-support-resolve" onClick={() => void patch({ status: "Resolved" })} disabled={busy}
            style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "1px solid rgba(5,150,105,0.4)", background: "rgba(5,150,105,0.1)", color: "#059669", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Resolve
          </button>
          <button type="button" data-testid="admin-support-close" onClick={() => void patch({ status: "Closed" })} disabled={busy}
            style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "1px solid var(--admin-border)", background: "transparent", color: "var(--admin-text-secondary)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Close
          </button>
        </div>

        <div>
          <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "var(--admin-text-muted)", textTransform: "uppercase" }}>Context</p>
          {contextEntries.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--admin-text-muted)" }}>No context attached.</p>
          ) : (
            <div data-testid="admin-support-context-panel" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {contextEntries.map(([key, value]) => (
                <div key={key} style={{
                  padding: "6px 8px", borderRadius: 6,
                  background: HIGHLIGHT_KEYS.has(key) ? "rgba(67,56,202,0.12)" : "transparent",
                  border: HIGHLIGHT_KEYS.has(key) ? "1px solid rgba(67,56,202,0.3)" : "1px solid transparent",
                }}>
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "var(--admin-text-muted)" }}>{key}</p>
                  <p style={{ margin: "1px 0 0", fontSize: 12, color: "var(--admin-text)", wordBreak: "break-word" }}>{String(value)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
