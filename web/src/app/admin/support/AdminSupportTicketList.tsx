"use client";

/**
 * AdminSupportTicketList — /admin/support. The "Support Inbox": a filtered
 * view of support_tickets rows, defaulting to conversations escalated and
 * awaiting an email reply (PRD §6.1/§6.2). The segmented tabs drive the
 * `inbox` query param; the pre-existing status/priority/category selects
 * remain as secondary filters layered on top. Default sort (Open + high
 * priority first, newest first) is applied server-side by
 * GET /api/admin/support/tickets.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import {
  SUPPORT_CATEGORIES, SUPPORT_CATEGORY_LABELS, SUPPORT_PRIORITIES, SUPPORT_STATUSES,
  type SupportCategory, type SupportPriority, type SupportStatus, type SupportTicket,
} from "@/lib/support/types";
import { agingBadge, type SupportMetrics } from "@/lib/support/metricsCore";
import { escalationReasonLabelZh, INBOX_TABS, type InboxTab } from "@/lib/support/inboxCore";

const PRIORITY_COLOR: Record<string, string> = { Urgent: "#DC2626", High: "#D97706", Normal: "#2563EB", Low: "var(--admin-text-secondary)" };
const STATUS_COLOR: Record<string, string> = { Open: "#2563EB", "In progress": "#D97706", "Waiting for user": "#7C3AED", Resolved: "#059669", Closed: "var(--admin-text-muted)" };

const INBOX_TAB_LABELS: Record<InboxTab, string> = { pending: "待回复", failed: "发送失败", sent: "已发送", all: "全部" };

const ESCALATION_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  needs_email_reply: { label: "待回复", color: "#2563EB", bg: "rgba(37,99,235,0.12)" },
  email_failed: { label: "发送失败", color: "#DC2626", bg: "rgba(220,38,38,0.12)" },
  email_sent: { label: "已发送", color: "#059669", bg: "rgba(5,150,105,0.12)" },
};

function EscalationBadgePill({ state }: { state?: string | null }) {
  if (!state || state === "none" || state === "processing" || state === "closed") {
    return <span style={{ color: "var(--admin-text-muted)" }}>—</span>;
  }
  const meta = ESCALATION_BADGE[state];
  if (!meta) return <span style={{ color: "var(--admin-text-muted)" }}>{state}</span>;
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 10.5, fontWeight: 800, background: meta.bg, color: meta.color }}>
      {meta.label}
    </span>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "7px 10px", borderRadius: 8, border: "1px solid var(--admin-border)", background: "var(--admin-surface)", color: "var(--admin-text)", fontSize: 12.5, fontWeight: 600,
};

function formatPercent(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

function formatHours(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${v}h`;
}

function metricCards(m: SupportMetrics | null): { label: string; value: string; color?: string }[] {
  return [
    { label: "New (7d)", value: m ? String(m.newLast7d) : "—" },
    { label: "Open >48h", value: m ? String(m.staleOpenOver48h) : "—", color: m && m.staleOpenOver48h > 0 ? "#DC2626" : undefined },
    { label: "AI reply rate (30d)", value: formatPercent(m?.aiReplyRate30d) },
    { label: "AI resolved (30d)", value: formatPercent(m?.aiResolvedRate30d) },
    { label: "First reply (30d)", value: formatHours(m?.avgFirstHumanReplyHours30d) },
  ];
}

function AgingBadgePill({ updatedAt }: { updatedAt: string }) {
  const badge = agingBadge(updatedAt);
  if (!badge) return null;
  const isStale = badge === "48h+";
  return (
    <span
      data-testid="admin-support-aging-badge"
      style={{
        marginLeft: 7,
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 800,
        background: isStale ? "rgba(220,38,38,0.15)" : "rgba(217,119,6,0.15)",
        color: isStale ? "#DC2626" : "#D97706",
      }}
    >
      {badge}
    </span>
  );
}

export function AdminSupportTicketList() {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [inboxTab, setInboxTab] = useState<InboxTab>("pending");
  const [status, setStatus] = useState<SupportStatus | "">("");
  const [priority, setPriority] = useState<SupportPriority | "">("");
  const [category, setCategory] = useState<SupportCategory | "">("");
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SupportMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!cancelled) setTickets(null);
      const params = new URLSearchParams();
      params.set("inbox", inboxTab);
      if (status) params.set("status", status);
      if (priority) params.set("priority", priority);
      if (category) params.set("category", category);
      try {
        const res = await fetch(`/api/admin/support/tickets?${params.toString()}`, { credentials: "include" });
        const d = await res.json();
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        setTickets(d.tickets);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [inboxTab, status, priority, category]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch("/api/admin/support/metrics", { credentials: "include" });
        const d = await res.json();
        if (!cancelled && !d.error) setMetrics(d as SupportMetrics);
      } catch {
        // Silent-fail — cards fall back to "—".
      }
    }
    void run();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", color: "var(--admin-text)" }}>
      <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--admin-border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Support Inbox</h1>
          <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 10, background: "var(--admin-surface-2)", border: "1px solid var(--admin-border)" }}>
            {INBOX_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                data-testid={`admin-inbox-tab-${tab}`}
                onClick={() => setInboxTab(tab)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 7,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12.5,
                  fontWeight: 700,
                  background: inboxTab === tab ? "var(--admin-accent)" : "transparent",
                  color: inboxTab === tab ? "#fff" : "var(--admin-text-secondary)",
                }}
              >
                {INBOX_TAB_LABELS[tab]}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select data-testid="admin-support-filter-status" value={status} onChange={(e) => setStatus(e.target.value as SupportStatus | "")} style={selectStyle}>
            <option value="">All statuses</option>
            {SUPPORT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select data-testid="admin-support-filter-priority" value={priority} onChange={(e) => setPriority(e.target.value as SupportPriority | "")} style={selectStyle}>
            <option value="">All priorities</option>
            {SUPPORT_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select data-testid="admin-support-filter-category" value={category} onChange={(e) => setCategory(e.target.value as SupportCategory | "")} style={selectStyle}>
            <option value="">All categories</option>
            {SUPPORT_CATEGORIES.map((c) => <option key={c} value={c}>{SUPPORT_CATEGORY_LABELS[c]}</option>)}
          </select>
        </div>
      </div>

      <div data-testid="admin-support-metrics" style={{ display: "flex", gap: 10, padding: "14px 24px 0" }}>
        {metricCards(metrics).map((c) => (
          <div key={c.label} style={{ flex: 1, background: "var(--admin-surface)", border: "1px solid var(--admin-border)", borderRadius: 10, padding: "10px 14px" }}>
            <p style={{ margin: "0 0 4px", fontSize: 10.5, fontWeight: 700, color: "var(--admin-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {c.label}
            </p>
            <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: c.color ?? "var(--admin-text)" }}>{c.value}</p>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 24px" }}>
        {error && <p style={{ color: "var(--admin-danger)", fontSize: 13 }}>{error}</p>}
        {!tickets && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--admin-text-muted)", fontSize: 13, padding: "24px 0" }}>
            <Loader2 size={15} className="animate-spin" /> Loading tickets…
          </div>
        )}
        {tickets && tickets.length === 0 && inboxTab === "pending" && (
          <p data-testid="admin-inbox-empty-pending" style={{ color: "var(--admin-text-muted)", fontSize: 13, padding: "24px 0" }}>没有待回复的会话 🎉</p>
        )}
        {tickets && tickets.length === 0 && inboxTab !== "pending" && (
          <p style={{ color: "var(--admin-text-muted)", fontSize: 13, padding: "24px 0" }}>No tickets match these filters.</p>
        )}
        {tickets && tickets.length > 0 && (
          <table data-testid="admin-support-ticket-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--admin-text-muted)", borderBottom: "1px solid var(--admin-border)" }}>
                {["Ticket #", "User email", "Category", "Priority", "Status", "Language", "Escalation", "Source", "Created", "Updated"].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", fontWeight: 700 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} data-testid={`admin-support-row-${t.ticketNumber}`} style={{ borderBottom: "1px solid var(--admin-border)" }}>
                  <td style={{ padding: "9px 10px" }}>
                    <Link href={`/admin/support/${t.id}`} style={{ color: "var(--admin-accent)", textDecoration: "none", fontWeight: 700 }}>{t.ticketNumber}</Link>
                  </td>
                  <td style={{ padding: "9px 10px" }}>{t.email}</td>
                  <td style={{ padding: "9px 10px" }}>{SUPPORT_CATEGORY_LABELS[t.category]}</td>
                  <td style={{ padding: "9px 10px", color: PRIORITY_COLOR[t.priority], fontWeight: 700 }}>{t.priority}</td>
                  <td style={{ padding: "9px 10px", color: STATUS_COLOR[t.status], fontWeight: 700 }}>
                    {t.status}
                    {t.status === "Open" && <AgingBadgePill updatedAt={t.updatedAt} />}
                  </td>
                  <td style={{ padding: "9px 10px", color: "var(--admin-text-secondary)" }}>{t.customerLanguage ?? "—"}</td>
                  <td style={{ padding: "9px 10px", color: "var(--admin-text-secondary)" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                      <EscalationBadgePill state={t.escalationState} />
                      {t.escalationReason && <span style={{ fontSize: 10.5 }}>{escalationReasonLabelZh(t.escalationReason)}</span>}
                    </div>
                  </td>
                  <td style={{ padding: "9px 10px", color: "var(--admin-text-secondary)" }}>{t.source || "—"}</td>
                  <td style={{ padding: "9px 10px", color: "var(--admin-text-secondary)" }}>{new Date(t.createdAt).toLocaleString()}</td>
                  <td style={{ padding: "9px 10px", color: "var(--admin-text-secondary)" }}>{new Date(t.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
