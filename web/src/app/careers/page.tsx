import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";

const CONTACT = "support@vibepin.co";

export const metadata = {
  title: "Careers — VibePin",
  description: "Work with the VibePin team.",
};

export default function CareersPage() {
  return (
    <div className="min-h-screen antialiased" style={{ background: "#080C12", color: "#D1D5DB" }}>
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,12,18,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[860px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 no-underline"><BrandLogo size={24} /><span className="font-black text-white text-[15px] tracking-tight">VibePin</span></Link>
          <div className="flex items-center gap-4 text-[12px]" style={{ color: "#9097A0" }}>
            <Link href="/about" className="hover:text-white transition-colors">About</Link>
            <Link href="/contact" className="hover:text-white transition-colors">Contact</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#A855F7" }}>Careers</p>
        <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight leading-[1.06] mb-5">
          Help build{" "}
          <span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 55%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>VibePin.</span>
        </h1>
        <div className="space-y-5 text-[15px] leading-relaxed mb-10" style={{ color: "#8B93A1" }}>
          <p>We&apos;re a small, focused team building Pinterest growth intelligence for creators and businesses. We don&apos;t have open roles posted right now — but we&apos;re always glad to meet thoughtful people who care about design, data, and helping creators grow.</p>
          <p>If that sounds like you, introduce yourself and tell us what you&apos;d want to work on.</p>
        </div>

        <div className="rounded-2xl border p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ background: "linear-gradient(135deg,#120E1E,#0A0C14)", borderColor: "rgba(168,85,247,0.22)" }}>
          <div>
            <p className="text-[15px] font-black text-white">No open roles — but we&apos;re listening.</p>
            <p className="text-[12px] mt-1" style={{ color: "#8B93A1" }}>Send a note to <a href={`mailto:${CONTACT}`} className="hover:text-white" style={{ color: "#A855F7" }}>{CONTACT}</a>.</p>
          </div>
          <a href={`mailto:${CONTACT}?subject=Careers%20at%20VibePin`} className="btn-cta rounded-full px-6 py-3 text-[13px] font-bold text-white shrink-0">Introduce yourself</a>
        </div>

        <div className="mt-14 pt-8 border-t flex flex-wrap gap-5 text-[12px]" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#5B6472" }}>
          <Link href="/" className="hover:text-white transition-colors">← Home</Link>
          <Link href="/about" className="hover:text-white transition-colors">About</Link>
          <Link href="/contact" className="hover:text-white transition-colors">Contact</Link>
          <Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
        </div>
      </div>
    </div>
  );
}
