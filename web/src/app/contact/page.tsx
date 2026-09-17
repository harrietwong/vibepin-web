import { Suspense } from "react";
import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { BackButton } from "@/components/BackButton";
import ContactForm, { ContactDetails, ContactPageIntro } from "./ContactForm";
import { LEGAL_ENTITY_NAME, LEGAL_WEBSITE_URL } from "@/lib/legalEntity";
import { PublicLanguageTheme, PublicNavLinks, PublicShell } from "@/components/public/PublicShell";
import { PublicCopy, PublicLocaleText } from "@/components/public/PublicLocaleSummary";

const CONTACT = "support@vibepin.co";

export const metadata = {
  title: "Contact — VibePin",
  description: "Get in touch with the VibePin team.",
};

export default function ContactPage() {
  return (
    <PublicShell>
    <div className="public-page-content min-h-screen antialiased" style={{ background: "var(--public-bg)", color: "var(--public-text)" }}>
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,12,18,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[1000px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <div className="flex items-center gap-4">
            <BackButton />
            <Link href="/" className="flex items-center gap-2 no-underline"><BrandLogo size={32} /><span className="font-black text-white text-[15px] tracking-tight">VibePin</span></Link>
          </div>
          <div className="flex items-center gap-2">
            <div className="public-page-nav-links flex items-center gap-4 text-[12px]" style={{ color: "#9097A0" }}>
              <PublicNavLinks compact />
            </div>
            <PublicLanguageTheme />
          </div>
        </div>
      </nav>

      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-24 right-[-10%] h-[420px] w-[420px] rounded-full blur-3xl" style={{ background: "radial-gradient(circle, rgba(217,70,239,0.14), transparent 70%)" }} />
        <div className="max-w-[1000px] mx-auto px-5 py-16 relative">
          <ContactPageIntro />

          <div className="grid lg:grid-cols-[1fr_1.1fr] gap-8 items-start">
            {/* Left — reasons + email */}
            <ContactDetails />

            {/* Right — form */}
            <Suspense fallback={null}>
              <ContactForm />
            </Suspense>
          </div>

          <div className="mt-16 pt-8 border-t flex flex-wrap gap-5 text-[12px]" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#5B6472" }}>
            <Link href="/" className="hover:text-white transition-colors"><PublicCopy id="public.common.home" /></Link><Link href="/about" className="hover:text-white transition-colors"><PublicCopy id="public.nav.about" /></Link><Link href="/careers" className="hover:text-white transition-colors"><PublicCopy id="public.nav.careers" /></Link><Link href="/privacy" className="hover:text-white transition-colors"><PublicLocaleText route="privacy" field="title" /></Link><Link href="/terms" className="hover:text-white transition-colors"><PublicLocaleText route="terms" field="title" /></Link><Link href="/refund-policy" className="hover:text-white transition-colors"><PublicLocaleText route="refund" field="title" /></Link>
          </div>

          <div className="mt-6 pt-6 border-t text-[11px] leading-relaxed" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#4B5563" }}>
            <p className="mb-0.5"><PublicCopy id="public.common.legalEntity" /> {LEGAL_ENTITY_NAME}</p><p className="mb-0.5"><PublicCopy id="public.common.brand" /> VibePin</p><p className="mb-0.5"><PublicCopy id="public.common.website" /> {LEGAL_WEBSITE_URL}</p><p><PublicCopy id="public.common.support" /> {CONTACT}</p>
          </div>
        </div>
      </div>
    </div>
    </PublicShell>
  );
}
