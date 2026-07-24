import { Suspense } from "react";
import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { BackButton } from "@/components/BackButton";
import ContactForm from "./ContactForm";

const CONTACT = "support@vibepin.co";

export const metadata = {
  title: "Contact — VibePin",
  description: "Get in touch with the VibePin team.",
};

const REASONS = [
  { title: "Product support", desc: "Questions about opportunities, Pin creation, weekly plans, or your account." },
  { title: "Billing & plans", desc: "Help with subscriptions, upgrades, invoices, or cancellations." },
  { title: "Partnerships & press", desc: "Collaborations, integrations, or media enquiries." },
];

export default function ContactPage() {
  return (
    <div className="min-h-screen antialiased" style={{ background: "#080C12", color: "#D1D5DB" }}>
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,12,18,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[1000px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <div className="flex items-center gap-4">
            <BackButton />
            <Link href="/" className="flex items-center gap-2 no-underline"><BrandLogo size={32} /><span className="font-black text-white text-[15px] tracking-tight">VibePin</span></Link>
          </div>
          <div className="flex items-center gap-4 text-[12px]" style={{ color: "#9097A0" }}>
            <Link href="/about" className="hover:text-white transition-colors">About</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
          </div>
        </div>
      </nav>

      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-24 right-[-10%] h-[420px] w-[420px] rounded-full blur-3xl" style={{ background: "radial-gradient(circle, rgba(217,70,239,0.14), transparent 70%)" }} />
        <div className="max-w-[1000px] mx-auto px-5 py-16 relative">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#A855F7" }}>Contact</p>
          <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight leading-[1.05] mb-4">
            Get in touch with{" "}
            <span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 55%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>the VibePin team.</span>
          </h1>
          <p className="text-[15px] leading-relaxed mb-12 max-w-[560px]" style={{ color: "#8B93A1" }}>
            We&apos;re a small team and we read every message. Tell us what you need and we&apos;ll get back to you, usually within 1–2 business days.
          </p>

          <div className="grid lg:grid-cols-[1fr_1.1fr] gap-8 items-start">
            {/* Left — reasons + email */}
            <div>
              <div className="rounded-2xl border p-6 mb-5" style={{ background: "linear-gradient(180deg,#0C1018,#0A0C14)", borderColor: "rgba(168,85,247,0.22)" }}>
                <p className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>Email us</p>
                <a href={`mailto:${CONTACT}`} className="text-xl font-black text-white hover:opacity-80 transition-opacity">{CONTACT}</a>
                <p className="text-[12px] mt-2" style={{ color: "#8B93A1" }}>The fastest way to reach us for anything.</p>
              </div>
              <div className="space-y-3">
                {REASONS.map(r => (
                  <div key={r.title} className="rounded-xl border p-4" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.08)" }}>
                    <p className="text-[13px] font-bold text-white mb-1">{r.title}</p>
                    <p className="text-[12px] leading-relaxed" style={{ color: "#8B93A1" }}>{r.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Right — form */}
            <Suspense fallback={null}>
              <ContactForm />
            </Suspense>
          </div>

          <div className="mt-16 pt-8 border-t flex flex-wrap gap-5 text-[12px]" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#5B6472" }}>
            <Link href="/" className="hover:text-white transition-colors">← Home</Link>
            <Link href="/about" className="hover:text-white transition-colors">About</Link>
            <Link href="/careers" className="hover:text-white transition-colors">Careers</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
            <Link href="/refund-policy" className="hover:text-white transition-colors">Refund Policy</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
