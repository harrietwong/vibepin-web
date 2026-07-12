"use client";

/**
 * SupportTicketList — the user's own tickets ("My tickets"). Optional P0
 * surface (email reply already closes the loop), kept lightweight.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { fetchMySupportTickets } from "@/lib/support/client";
import { SUPPORT_CATEGORY_LABELS, type SupportTicket } from "@/lib/support/types";

const UI = {
  card: "var(--app-surface, #161D2E)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #4A5568)",
};

const STATUS_COLOR: Record<string, string> = {
  Open: "#60A5FA",
  "In progress": "#FBBF24",
  "Waiting for user": "#A78BFA",
  Resolved: "#34D399",
  Closed: "#8892A4",
};

export function SupportTicketList() {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMySupportTickets().then(setTickets).catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <p style={{ fontSize: 13, color: "#EF4444" }}>{error}</p>;
  if (!tickets) return <div style={{ display: "flex", alignItems: "center", gap: 8, color: UI.textSec, fontSize: 13 }}><Loader2 size={15} className="animate-spin" /> Loading tickets…</div>;
  if (!tickets.length) return <p style={{ fontSize: 13, color: UI.textMuted }}>You haven&apos;t created any support tickets yet.</p>;

  return (
    <div data-testid="support-ticket-list" style={{ display: "flex", flexDirection: "column", borderRadius: 12, border: `1px solid ${UI.border}`, overflow: "hidden" }}>
      {tickets.map((t, i) => (
        <Link
          key={t.id}
          href={`/app/support/tickets/${t.id}`}
          data-testid={`support-ticket-row-${t.ticketNumber}`}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            padding: "12px 16px", textDecoration: "none", background: UI.card,
            borderBottom: i < tickets.length - 1 ? `1px solid ${UI.border}` : "none",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t.subject || SUPPORT_CATEGORY_LABELS[t.category]}
            </p>
            <p style={{ margin: "2px 0 0", fontSize: 11.5, color: UI.textMuted }}>{t.ticketNumber} · {SUPPORT_CATEGORY_LABELS[t.category]}</p>
          </div>
          <span style={{ fontSize: 11, fontWeight: 800, color: STATUS_COLOR[t.status] ?? UI.textSec, flexShrink: 0 }}>{t.status}</span>
        </Link>
      ))}
    </div>
  );
}
