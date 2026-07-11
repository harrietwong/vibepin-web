"use client";

/**
 * Help & Support — the official support entry point. Search + popular help
 * articles + Contact Support. This is NOT the Ask VibePin AI page assistant
 * (bottom-right widget) — that stays a separate, currently-disabled surface.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { LifeBuoy, Search } from "lucide-react";
import { ContactSupportModal } from "@/components/support/ContactSupportModal";
import { HELP_ARTICLES } from "@/lib/support/helpArticles";

const UI = {
  card: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2236)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #4A5568)",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

export default function HelpSupportPage() {
  const [query, setQuery] = useState("");
  const [contactOpen, setContactOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return HELP_ARTICLES;
    return HELP_ARTICLES.filter((a) => a.title.toLowerCase().includes(q));
  }, [query]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--app-bg, #0B0E17)", overflow: "hidden", minHeight: 0 }}>
      <div style={{ padding: "0 16px", height: 44, background: UI.surface2, borderBottom: `1px solid ${UI.border}`, flexShrink: 0, display: "flex", alignItems: "center" }}>
        <p data-testid="page-header-title" style={{ margin: 0, fontSize: 14, fontWeight: 800, color: UI.text }}>Help &amp; Support</p>
      </div>

      <div className="studio-scroll" style={{ flex: 1, overflowY: "auto", padding: "28px 20px 60px", display: "flex", justifyContent: "center" }}>
        <div style={{ width: "min(680px, 100%)", display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 14, alignItems: "center" }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: UI.text }}>Help &amp; Support</h1>
            <div style={{ position: "relative", width: "min(420px, 100%)" }}>
              <Search size={15} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: UI.textMuted }} />
              <input
                data-testid="help-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search help articles..."
                style={{ width: "100%", padding: "10px 12px 10px 34px", borderRadius: 10, border: `1px solid ${UI.border}`, background: UI.surface2, color: UI.text, fontSize: 13 }}
              />
            </div>
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
              <p style={{ margin: 0, fontSize: 11.5, fontWeight: 700, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Popular help
              </p>
              <Link
                href="/app/support/tickets"
                data-testid="help-my-tickets-link"
                style={{ fontSize: 12, color: UI.textSec, textDecoration: "none" }}
              >
                My tickets →
              </Link>
            </div>
            <div data-testid="help-article-list" style={{ display: "flex", flexDirection: "column", borderRadius: 12, border: `1px solid ${UI.border}`, overflow: "hidden" }}>
              {filtered.length === 0 && (
                <p style={{ margin: 0, padding: 16, fontSize: 12.5, color: UI.textMuted }}>No articles match &quot;{query}&quot;.</p>
              )}
              {filtered.map((article, i) => (
                <Link
                  key={article.slug}
                  href={`/app/help/${article.slug}`}
                  data-testid={`help-article-link-${article.slug}`}
                  style={{
                    display: "block", padding: "13px 16px", fontSize: 13, fontWeight: 600, color: UI.text,
                    textDecoration: "none", background: UI.card,
                    borderBottom: i < filtered.length - 1 ? `1px solid ${UI.border}` : "none",
                  }}
                >
                  {article.title}
                </Link>
              ))}
            </div>
          </div>

          <div style={{ textAlign: "center", padding: "22px 20px", borderRadius: 14, border: `1px solid ${UI.border}`, background: UI.card, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <LifeBuoy size={22} style={{ color: "#A78BFA" }} />
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: UI.text }}>Still need help?</p>
            <button
              type="button"
              data-testid="help-contact-support-button"
              onClick={() => setContactOpen(true)}
              style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: UI.gradient, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}
            >
              Contact Support
            </button>
          </div>
        </div>
      </div>

      <ContactSupportModal open={contactOpen} onClose={() => setContactOpen(false)} source="help_center" defaultCategory="other" />
    </div>
  );
}
