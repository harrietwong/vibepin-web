import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { BackButton } from "@/components/BackButton";

export const metadata = {
  title: "About — VibePin",
  description: "What VibePin is and who it's for.",
};

const VALUES = [
  { title: "Evidence before effort", desc: "Start from real Pinterest demand and proven Pin performance — not a blank prompt." },
  { title: "You stay in control", desc: "VibePin drafts and plans, but you review and confirm every Pin before it publishes." },
  { title: "One connected workflow", desc: "Discover, create, and plan in one place instead of switching between disconnected tools." },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen antialiased" style={{ background: "#080C12", color: "#D1D5DB" }}>
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,12,18,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[860px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <div className="flex items-center gap-4">
            <BackButton />
            <Link href="/" className="flex items-center gap-2 no-underline"><BrandLogo size={24} /><span className="font-black text-white text-[15px] tracking-tight">VibePin</span></Link>
          </div>
          <div className="flex items-center gap-4 text-[12px]" style={{ color: "#9097A0" }}>
            <Link href="/careers" className="hover:text-white transition-colors">Careers</Link>
            <Link href="/contact" className="hover:text-white transition-colors">Contact</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#A855F7" }}>About</p>
        <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight leading-[1.06] mb-5">
          Pinterest growth that{" "}
          <span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 55%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>starts with signals.</span>
        </h1>
        <div className="space-y-5 text-[15px] leading-relaxed" style={{ color: "#8B93A1" }}>
          <p>VibePin is a Pinterest opportunity-intelligence and content-planning tool for creators, ecommerce sellers, affiliate marketers, and Pinterest managers.</p>
          <p>Most tools push you to make more content. VibePin helps you decide what&apos;s worth making first — by surfacing real Pinterest demand, proven Pin performance, and related product signals, then turning the best opportunities into product-aware Pin drafts and a reviewable weekly plan.</p>
          <p>We&apos;re an independent team building VibePin to make Pinterest growth feel deliberate instead of guesswork. VibePin is not affiliated with or endorsed by Pinterest.</p>
        </div>

        <div className="grid sm:grid-cols-3 gap-4 mt-12">
          {VALUES.map(v => (
            <div key={v.title} className="rounded-xl border p-5" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.08)" }}>
              <p className="text-[13px] font-bold text-white mb-1.5">{v.title}</p>
              <p className="text-[12px] leading-relaxed" style={{ color: "#8B93A1" }}>{v.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-2xl border p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ background: "linear-gradient(135deg,#120E1E,#0A0C14)", borderColor: "rgba(168,85,247,0.22)" }}>
          <div>
            <p className="text-[15px] font-black text-white">Questions or feedback?</p>
            <p className="text-[12px] mt-1" style={{ color: "#8B93A1" }}>We&apos;d love to hear from you.</p>
          </div>
          <Link href="/contact" className="btn-cta rounded-full px-6 py-3 text-[13px] font-bold text-white shrink-0">Contact us</Link>
        </div>

        <div className="mt-14 pt-8 border-t flex flex-wrap gap-5 text-[12px]" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#5B6472" }}>
          <Link href="/" className="hover:text-white transition-colors">← Home</Link>
          <Link href="/careers" className="hover:text-white transition-colors">Careers</Link>
          <Link href="/contact" className="hover:text-white transition-colors">Contact</Link>
          <Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
          <Link href="/refund-policy" className="hover:text-white transition-colors">Refund Policy</Link>
        </div>
      </div>
    </div>
  );
}
