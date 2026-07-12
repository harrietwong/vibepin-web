"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SupportTicketList } from "@/components/support/SupportTicketList";

export default function MySupportTicketsPage() {
  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--app-bg, #0B0E17)", padding: "24px 20px 60px", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "min(640px, 100%)", display: "flex", flexDirection: "column", gap: 16 }}>
        <Link href="/app/help" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--app-text-sec, #8892A4)", textDecoration: "none" }}>
          <ArrowLeft size={14} /> Help &amp; Support
        </Link>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "var(--app-text, #E2E8F0)" }}>My support tickets</h1>
        <SupportTicketList />
      </div>
    </div>
  );
}
