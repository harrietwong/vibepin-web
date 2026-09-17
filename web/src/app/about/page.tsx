import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { LEGAL_ENTITY_NAME, LEGAL_WEBSITE_URL } from "@/lib/legalEntity";
import { PublicLanguageTheme, PublicShell } from "@/components/public/PublicShell";
import { PublicCopy, PublicLocaleText } from "@/components/public/PublicLocaleSummary";

export const metadata = {
  title: "About — VibePin",
  description: "What VibePin is and who it's for.",
};

const VALUES = [
  { title: "public.about.value.evidence.title", desc: "public.about.value.evidence.body" },
  { title: "public.about.value.control.title", desc: "public.about.value.control.body" },
  { title: "public.about.value.workflow.title", desc: "public.about.value.workflow.body" },
];

export default function AboutPage() {
  return (
    <PublicShell>
    <div className="public-page-content min-h-screen antialiased" style={{ background: "var(--public-bg)", color: "var(--public-text)" }}>
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,12,18,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[860px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-[12px]" style={{ color: "var(--public-text-muted)" }}><PublicCopy id="public.common.back" /></Link>
            <Link href="/" className="flex items-center gap-2 no-underline"><BrandLogo size={32} /><span className="font-black text-white text-[15px] tracking-tight">VibePin</span></Link>
          </div>
          <div className="public-page-nav-links flex items-center gap-4 text-[12px]" style={{ color: "#9097A0" }}>
            <Link href="/careers" className="hover:text-white transition-colors"><PublicCopy id="public.nav.careers" /></Link>
            <Link href="/contact" className="hover:text-white transition-colors"><PublicCopy id="public.nav.contact" /></Link>
          </div>
          <PublicLanguageTheme />
        </div>
      </nav>

      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#A855F7" }}><PublicLocaleText route="about" field="eyebrow" /></p>
        <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight leading-[1.06] mb-5">
          <PublicLocaleText route="about" field="title" />
        </h1>
        <p className="text-[15px] leading-relaxed mb-5" style={{ color: "var(--public-text-muted)" }}><PublicLocaleText route="about" field="body" /></p>
        <div className="space-y-5 text-[15px] leading-relaxed" style={{ color: "#8B93A1" }}>
          <p><PublicCopy id="public.about.detail.1" /></p><p><PublicCopy id="public.about.detail.2" /></p><p><PublicCopy id="public.about.detail.3" /></p>
        </div>

        <div className="grid sm:grid-cols-3 gap-4 mt-12">
          {VALUES.map(v => (
            <div key={v.title} className="rounded-xl border p-5" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.08)" }}>
              <p className="text-[13px] font-bold text-white mb-1.5"><PublicCopy id={v.title as never} /></p><p className="text-[12px] leading-relaxed" style={{ color: "#8B93A1" }}><PublicCopy id={v.desc as never} /></p>
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-2xl border p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ background: "linear-gradient(135deg,#120E1E,#0A0C14)", borderColor: "rgba(168,85,247,0.22)" }}>
          <div>
            <p className="text-[15px] font-black text-white"><PublicCopy id="public.about.contact.title" /></p><p className="text-[12px] mt-1" style={{ color: "#8B93A1" }}><PublicCopy id="public.about.contact.body" /></p>
          </div>
          <Link href="/contact" className="btn-cta rounded-full px-6 py-3 text-[13px] font-bold text-white shrink-0"><PublicLocaleText route="about" field="cta" /></Link>
        </div>

        <div className="mt-14 pt-8 border-t flex flex-wrap gap-5 text-[12px]" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#5B6472" }}>
          <Link href="/" className="hover:text-white transition-colors"><PublicCopy id="public.common.home" /></Link><Link href="/careers" className="hover:text-white transition-colors"><PublicCopy id="public.nav.careers" /></Link><Link href="/contact" className="hover:text-white transition-colors"><PublicCopy id="public.nav.contact" /></Link><Link href="/privacy" className="hover:text-white transition-colors"><PublicLocaleText route="privacy" field="title" /></Link><Link href="/terms" className="hover:text-white transition-colors"><PublicLocaleText route="terms" field="title" /></Link><Link href="/refund-policy" className="hover:text-white transition-colors"><PublicLocaleText route="refund" field="title" /></Link>
        </div>

        <div className="mt-6 pt-6 border-t text-[11px] leading-relaxed" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#4B5563" }}>
          <p className="mb-0.5"><PublicCopy id="public.common.legalEntity" /> {LEGAL_ENTITY_NAME}</p><p className="mb-0.5"><PublicCopy id="public.common.brand" /> VibePin</p><p><PublicCopy id="public.common.website" /> {LEGAL_WEBSITE_URL}</p>
        </div>
      </div>
    </div>
    </PublicShell>
  );
}
