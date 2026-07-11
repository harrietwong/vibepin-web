"use client";

/**
 * AdminSupportTicketList — /admin/support. Filterable ticket table. Default
 * sort (Open + high priority first, newest first) is applied server-side by
 * GET /api/admin/support/tickets.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import {
  SUPPORT_CATEGORIES, SUPPORT_CATEGORY_LABELS, SUPPORT_PRIORITIES, SUPPORT_STATUSES,
  type SupportCategory, type SupportPriority, type SupportStatus, type SupportTicket,
} from "@/lib/support/types";

const PRIORITY_COLOR: Record<string, string> = { Urgent: "#F87171", High: "#FB923C", Normal: "#60A5FA", Low: "#94A3B8" };
const STATUS_COLOR: Record<string, string> = { Open: "#60A5FA", "In progress": "#FBBF24", "Waiting for user": "#A78BFA", Resolved: "#34D399", Closed: "#64748B" };

const selectStyle: React.CSSProperties = {
  padding: "7px 10px", borderRadius: 8, border: "1px solid #1E293B", background: "#0F172A", color: "#E2E8F0", fontSize: 12.5, fontWeight: 600,
};

export function AdminSupportTicketList() {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [status, setStatus] = useState<SupportStatus | "">("");
  const [priority, setPriority] = useState<SupportPriority | "">("");
  const [category, setCategory] = useState<SupportCategory | "">("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!cancelled) setTickets(null);
      const params = new URLSearchParams();
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
  }, [status, priority, category]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", color: "#E2E8F0" }}>
      <div style={{ padding: "18px 24px", borderBottom: "1px solid #1E293B", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Support tickets</h1>
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

      <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 24px" }}>
        {error && <p style={{ color: "#F87171", fontSize: 13 }}>{error}</p>}
        {!tickets && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#64748B", fontSize: 13, padding: "24px 0" }}>
            <Loader2 size={15} className="animate-spin" /> Loading tickets…
          </div>
        )}
        {tickets && tickets.length === 0 && <p style={{ color: "#64748B", fontSize: 13, padding: "24px 0" }}>No tickets match these filters.</p>}
        {tickets && tickets.length > 0 && (
          <table data-testid="admin-support-ticket-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748B", borderBottom: "1px solid #1E293B" }}>
                {["Ticket #", "User email", "Category", "Priority", "Status", "Source", "Created", "Updated"].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", fontWeight: 700 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} data-testid={`admin-support-row-${t.ticketNumber}`} style={{ borderBottom: "1px solid #1E293B" }}>
                  <td style={{ padding: "9px 10px" }}>
                    <Link href={`/admin/support/${t.id}`} style={{ color: "#818CF8", textDecoration: "none", fontWeight: 700 }}>{t.ticketNumber}</Link>
                  </td>
                  <td style={{ padding: "9px 10px" }}>{t.email}</td>
                  <td style={{ padding: "9px 10px" }}>{SUPPORT_CATEGORY_LABELS[t.category]}</td>
                  <td style={{ padding: "9px 10px", color: PRIORITY_COLOR[t.priority], fontWeight: 700 }}>{t.priority}</td>
                  <td style={{ padding: "9px 10px", color: STATUS_COLOR[t.status], fontWeight: 700 }}>{t.status}</td>
                  <td style={{ padding: "9px 10px", color: "#94A3B8" }}>{t.source || "—"}</td>
                  <td style={{ padding: "9px 10px", color: "#94A3B8" }}>{new Date(t.createdAt).toLocaleString()}</td>
                  <td style={{ padding: "9px 10px", color: "#94A3B8" }}>{new Date(t.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
