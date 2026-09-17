"use client";

import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { PublicLanguageTheme } from "./PublicShell";
import { PublicLocaleText, type PublicRouteCopyKey } from "./PublicLocaleSummary";

type DocumentRoute = Extract<PublicRouteCopyKey, "privacy" | "terms" | "refund" | "acceptableUse" | "pinterest">;

const documentKey = (route: DocumentRoute) => `public.document.${route}.body` as MessageKey;

function DocumentBody({ route }: { route: DocumentRoute }) {
  const { t } = useLocale();
  return (
    <div className="space-y-8 text-[14px] leading-relaxed" style={{ color: "var(--public-text-muted)" }}>
      {t(documentKey(route)).split("\n\n").map(section => {
        const [heading, ...paragraphs] = section.split("\n");
        const title = heading.replace(/^##\s*/, "");
        return <section key={title}><h2 className="text-[16px] font-bold mb-3" style={{ color: "var(--public-text)" }}>{title}</h2>{paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</section>;
      })}
    </div>
  );
}

export function PublicDocumentPage({ route, updated }: { route: DocumentRoute; updated: string }) {
  const { t } = useLocale();
  return (
    <div className="public-page-content min-h-screen antialiased" style={{ background: "var(--public-bg)", color: "var(--public-text)" }}>
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "var(--public-nav-bg)", borderColor: "var(--public-border)" }}>
        <div className="max-w-[860px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <div className="flex items-center gap-4"><Link href="/" className="text-[12px]" style={{ color: "var(--public-text-muted)" }}>{t("public.common.back")}</Link><Link href="/" className="flex items-center gap-2 no-underline"><BrandLogo size={32} /><span className="font-black text-[15px] tracking-tight" style={{ color: "var(--public-text)" }}>VibePin</span></Link></div>
          <div className="public-page-nav-links flex items-center gap-4 text-[12px]" style={{ color: "var(--public-text-muted)" }}><Link href="/privacy">{t("public.nav.privacy")}</Link><Link href="/pinterest-app">{t("public.route.pinterest.eyebrow")}</Link></div>
          <PublicLanguageTheme />
        </div>
      </nav>
      <main className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "var(--public-accent-strong)" }}><PublicLocaleText route={route} field="eyebrow" /></p>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight mb-2" style={{ color: "var(--public-text)" }}><PublicLocaleText route={route} field="title" /></h1>
        <p className="text-[13px] mb-8" style={{ color: "var(--public-text-muted)" }}>{t("public.common.lastUpdated")} {updated}</p>
        <p className="text-[14px] leading-relaxed mb-10" style={{ color: "var(--public-text-muted)" }}><PublicLocaleText route={route} field="body" /></p>
        <DocumentBody route={route} />
        <div className="mt-12"><Link href="/contact" className="btn-cta rounded-full px-6 py-3 text-[13px] font-bold text-white"><PublicLocaleText route={route} field="cta" /></Link></div>
      </main>
    </div>
  );
}
