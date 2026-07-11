"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SupportTicketDetail } from "@/components/support/SupportTicketDetail";

export default function SupportTicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--app-bg, #0B0E17)", padding: "24px 20px 60px", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "min(640px, 100%)", display: "flex", flexDirection: "column", gap: 16 }}>
        <Link href="/app/support/tickets" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--app-text-sec, #8892A4)", textDecoration: "none" }}>
          <ArrowLeft size={14} /> My tickets
        </Link>
        <SupportTicketDetail ticketId={id} />
      </div>
    </div>
  );
}
