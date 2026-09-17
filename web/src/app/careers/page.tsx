import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { PublicLanguageTheme, PublicShell } from "@/components/public/PublicShell";
import { PublicCopy, PublicLocaleText } from "@/components/public/PublicLocaleSummary";

const CONTACT = "support@vibepin.co";

export const metadata = {
  title: "Careers — VibePin",
  description: "Work with the VibePin team.",
};

export default function CareersPage() {
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
            <Link href="/about" className="hover:text-white transition-colors"><PublicCopy id="public.nav.about" /></Link><Link href="/contact" className="hover:text-white transition-colors"><PublicCopy id="public.nav.contact" /></Link>
          </div>
          <PublicLanguageTheme />
        </div>
      </nav>

      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#A855F7" }}><PublicLocaleText route="careers" field="eyebrow" /></p>
        <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight leading-[1.06] mb-5">
          <PublicLocaleText route="careers" field="title" />
        </h1>
        <p className="text-[15px] leading-relaxed mb-5" style={{ color: "var(--public-text-muted)" }}><PublicLocaleText route="careers" field="body" /></p>
        <div className="space-y-5 text-[15px] leading-relaxed mb-10" style={{ color: "#8B93A1" }}>
          <p><PublicCopy id="public.careers.detail.1" /></p><p><PublicCopy id="public.careers.detail.2" /></p>
        </div>

        <div className="rounded-2xl border p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ background: "linear-gradient(135deg,#120E1E,#0A0C14)", borderColor: "rgba(168,85,247,0.22)" }}>
          <div>
            <p className="text-[15px] font-black text-white"><PublicCopy id="public.careers.contact.title" /></p><p className="text-[12px] mt-1" style={{ color: "#8B93A1" }}><PublicCopy id="public.careers.contact.body" /> <a href={`mailto:${CONTACT}`} className="hover:text-white" style={{ color: "#A855F7" }}>{CONTACT}</a>.</p>
          </div>
          <a href={`mailto:${CONTACT}?subject=Careers%20at%20VibePin`} className="btn-cta rounded-full px-6 py-3 text-[13px] font-bold text-white shrink-0"><PublicLocaleText route="careers" field="cta" /></a>
        </div>

        <div className="mt-14 pt-8 border-t flex flex-wrap gap-5 text-[12px]" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#5B6472" }}>
          <Link href="/" className="hover:text-white transition-colors"><PublicCopy id="public.common.home" /></Link><Link href="/about" className="hover:text-white transition-colors"><PublicCopy id="public.nav.about" /></Link><Link href="/contact" className="hover:text-white transition-colors"><PublicCopy id="public.nav.contact" /></Link><Link href="/privacy" className="hover:text-white transition-colors"><PublicLocaleText route="privacy" field="title" /></Link><Link href="/terms" className="hover:text-white transition-colors"><PublicLocaleText route="terms" field="title" /></Link><Link href="/refund-policy" className="hover:text-white transition-colors"><PublicLocaleText route="refund" field="title" /></Link>
        </div>
      </div>
    </div>
    </PublicShell>
  );
}
