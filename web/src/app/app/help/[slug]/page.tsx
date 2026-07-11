"use client";

/**
 * Generic Help Center article template. Content lives in helpArticles.ts (no
 * CMS) — this file only renders it: short answer / common causes / what to
 * try / when to contact support / Contact Support CTA.
 */

import { use, useState } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ContactSupportModal } from "@/components/support/ContactSupportModal";
import { getHelpArticle } from "@/lib/support/helpArticles";

const UI = {
  card: "var(--app-surface, #161D2E)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

export default function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const article = getHelpArticle(slug);
  const [contactOpen, setContactOpen] = useState(false);

  if (!article) notFound();

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--app-bg, #0B0E17)", padding: "28px 20px 60px", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "min(640px, 100%)", display: "flex", flexDirection: "column", gap: 18 }}>
        <Link href="/app/help" data-testid="help-article-back" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: UI.textSec, textDecoration: "none" }}>
          <ArrowLeft size={14} /> Help &amp; Support
        </Link>

        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: UI.text }}>{article.title}</h1>

        <section>
          <p style={{ margin: 0, fontSize: 14, color: UI.text, lineHeight: 1.6 }}>{article.shortAnswer}</p>
        </section>

        {article.commonCauses.length > 0 && (
          <section>
            <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 800, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.04em" }}>Common causes</p>
            <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
              {article.commonCauses.map((c) => <li key={c} style={{ fontSize: 13.5, color: UI.text, lineHeight: 1.5 }}>{c}</li>)}
            </ul>
          </section>
        )}

        {article.whatToTry.length > 0 && (
          <section>
            <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 800, color: UI.textSec, textTransform: "uppercase", letterSpacing: "0.04em" }}>What you can try</p>
            <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
              {article.whatToTry.map((c) => <li key={c} style={{ fontSize: 13.5, color: UI.text, lineHeight: 1.5 }}>{c}</li>)}
            </ul>
          </section>
        )}

        <section style={{ padding: "16px 18px", borderRadius: 12, border: `1px solid ${UI.border}`, background: UI.card, display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13, color: UI.textSec, lineHeight: 1.5 }}>{article.whenToContactSupport}</p>
          <button
            type="button"
            data-testid="help-article-contact-support"
            onClick={() => setContactOpen(true)}
            style={{ alignSelf: "flex-start", padding: "9px 16px", borderRadius: 9, border: "none", background: UI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}
          >
            Contact Support
          </button>
        </section>
      </div>

      <ContactSupportModal
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        source="help_center"
        defaultCategory={article.supportCategory}
        defaultSubject={article.title}
      />
    </div>
  );
}
