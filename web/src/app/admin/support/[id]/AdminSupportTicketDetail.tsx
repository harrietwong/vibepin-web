"use client";

/**
 * AdminSupportTicketDetail — /admin/support/:id. Context panel, conversation
 * (internal notes visually marked, never sent to the user API), reply box,
 * status/priority selectors, resolve/close shortcuts.
 */

import { useEffect, useState } from "react";
import { Loader2, Send, Lock } from "lucide-react";
import {
  SUPPORT_CATEGORY_LABELS, SUPPORT_PRIORITIES, SUPPORT_STATUSES,
  type SupportMessage, type SupportPriority, type SupportStatus, type SupportTicket,
} from "@/lib/support/types";

const HIGHLIGHT_KEYS = new Set([
  "draftId", "publishJobId", "generationRequestId", "boardName", "publishErrorMessage",
  "creditsBefore", "creditsAfter", "subscriptionId", "connectionStatus",
]);

const selectStyle: React.CSSProperties = {
  padding: "7px 10px", borderRadius: 8, border: "1px solid #1E293B", background: "#0F172A", color: "#E2E8F0", fontSize: 12.5, fontWeight: 700,
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
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    jsonFetch<{ ticket: SupportTicket; messages: SupportMessage[] }>(`/api/admin/support/tickets/${ticketId}`)
      .then((d) => { setTicket(d.ticket); setMessages(d.messages); })
      .catch((e) => setError(e.message));
  }

  useEffect(load, [ticketId]);

  async function patch(body: Partial<{ status: SupportStatus; priority: SupportPriority }>) {
    if (!ticket) return;
    setBusy(true);
    try {
      const d = await jsonFetch<{ ticket: SupportTicket }>(`/api/admin/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify(body) });
      setTicket(d.ticket);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function sendReply() {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      const d = await jsonFetch<{ message: SupportMessage }>(`/api/admin/support/tickets/${ticketId}/reply`, { method: "POST", body: JSON.stringify({ body: reply.trim() }) });
      setMessages((prev) => [...prev, d.message]);
      setReply("");
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
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

  if (error && !ticket) return <div style={{ padding: 24, color: "#F87171", fontSize: 13 }}>{error}</div>;
  if (!ticket) return <div style={{ padding: 24, display: "flex", alignItems: "center", gap: 8, color: "#64748B", fontSize: 13 }}><Loader2 size={15} className="animate-spin" /> Loading ticket…</div>;

  const contextEntries = Object.entries(ticket.context ?? {});

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", color: "#E2E8F0" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
        <div>
          <p style={{ margin: 0, fontSize: 12, color: "#64748B", fontWeight: 700 }}>{ticket.ticketNumber}</p>
          <h1 style={{ margin: "2px 0 0", fontSize: 19, fontWeight: 800 }}>{ticket.subject || SUPPORT_CATEGORY_LABELS[ticket.category]}</h1>
          <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "#94A3B8" }}>
            {ticket.email} · {SUPPORT_CATEGORY_LABELS[ticket.category]} · {ticket.source || "—"}
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.map((m) => (
            <div key={m.id} data-testid={m.isInternal ? "admin-internal-note" : "admin-message"} style={{
              padding: "10px 13px", borderRadius: 10,
              background: m.isInternal ? "rgba(251,191,36,0.08)" : m.senderType === "admin" ? "rgba(99,102,241,0.12)" : "#111827",
              border: m.isInternal ? "1px dashed rgba(251,191,36,0.4)" : "1px solid #1E293B",
            }}>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{m.body}</p>
              <p style={{ margin: "4px 0 0", fontSize: 10, color: "#64748B", display: "flex", alignItems: "center", gap: 4 }}>
                {m.isInternal && <Lock size={10} />}
                {m.senderType === "admin" ? "Admin" : m.senderType === "user" ? "User" : "System"}{m.isInternal ? " · internal note" : ""}
              </p>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11.5, fontWeight: 700, color: "#64748B" }}>Reply to user</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input data-testid="admin-support-reply-input" value={reply} onChange={(e) => setReply(e.target.value)}
              style={{ flex: 1, padding: "9px 12px", borderRadius: 8, border: "1px solid #1E293B", background: "#0F172A", color: "#E2E8F0", fontSize: 13 }} />
            <button type="button" data-testid="admin-support-reply-submit" onClick={() => void sendReply()} disabled={busy || !reply.trim()}
              style={{ padding: "0 14px", borderRadius: 8, border: "none", background: "#4338CA", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center" }}>
              <Send size={14} />
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11.5, fontWeight: 700, color: "#64748B" }}>Internal note (never emailed, never shown to user)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input data-testid="admin-support-note-input" value={note} onChange={(e) => setNote(e.target.value)}
              style={{ flex: 1, padding: "9px 12px", borderRadius: 8, border: "1px dashed rgba(251,191,36,0.4)", background: "#0F172A", color: "#E2E8F0", fontSize: 13 }} />
            <button type="button" data-testid="admin-support-note-submit" onClick={() => void addNote()} disabled={busy || !note.trim()}
              style={{ padding: "0 14px", borderRadius: 8, border: "1px solid rgba(251,191,36,0.4)", background: "transparent", color: "#FBBF24", cursor: "pointer" }}>
              Add note
            </button>
          </div>
        </div>
      </div>

      <div style={{ width: 300, flexShrink: 0, borderLeft: "1px solid #1E293B", padding: 20, display: "flex", flexDirection: "column", gap: 18, overflowY: "auto" }}>
        <div>
          <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase" }}>Status</p>
          <select data-testid="admin-support-status-select" value={ticket.status} disabled={busy}
            onChange={(e) => void patch({ status: e.target.value as SupportStatus })} style={{ ...selectStyle, width: "100%" }}>
            {SUPPORT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase" }}>Priority</p>
          <select data-testid="admin-support-priority-select" value={ticket.priority} disabled={busy}
            onChange={(e) => void patch({ priority: e.target.value as SupportPriority })} style={{ ...selectStyle, width: "100%" }}>
            {SUPPORT_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" data-testid="admin-support-resolve" onClick={() => void patch({ status: "Resolved" })} disabled={busy}
            style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "1px solid rgba(52,211,153,0.4)", background: "rgba(52,211,153,0.1)", color: "#34D399", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Resolve
          </button>
          <button type="button" data-testid="admin-support-close" onClick={() => void patch({ status: "Closed" })} disabled={busy}
            style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#94A3B8", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Close
          </button>
        </div>

        <div>
          <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase" }}>Context</p>
          {contextEntries.length === 0 ? (
            <p style={{ fontSize: 12, color: "#475569" }}>No context attached.</p>
          ) : (
            <div data-testid="admin-support-context-panel" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {contextEntries.map(([key, value]) => (
                <div key={key} style={{
                  padding: "6px 8px", borderRadius: 6,
                  background: HIGHLIGHT_KEYS.has(key) ? "rgba(99,102,241,0.12)" : "transparent",
                  border: HIGHLIGHT_KEYS.has(key) ? "1px solid rgba(99,102,241,0.3)" : "1px solid transparent",
                }}>
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "#64748B" }}>{key}</p>
                  <p style={{ margin: "1px 0 0", fontSize: 12, color: "#E2E8F0", wordBreak: "break-word" }}>{String(value)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
