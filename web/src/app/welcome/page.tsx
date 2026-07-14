import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";

export const metadata = {
  title: "Welcome — VibePin",
  description: "Your VibePin subscription is confirmed. Jump into your dashboard to get started.",
};

export default function WelcomePage() {
  return (
    <div className="min-h-screen antialiased" style={{ background: "#080C12", color: "#D1D5DB" }}>
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,12,18,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[860px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 no-underline"><BrandLogo size={24} /><span className="font-black text-white text-[15px] tracking-tight">VibePin</span></Link>
        </div>
      </nav>

      <div className="max-w-[720px] mx-auto px-5 py-24 sm:py-28 text-center">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#A855F7" }}>Subscription confirmed</p>
        <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight leading-[1.05] mb-5">
          You&apos;re in.
        </h1>
        <p className="text-[16px] leading-relaxed max-w-[540px] mx-auto mb-3" style={{ color: "#8B93A1" }}>
          Thanks for subscribing to VibePin. Your payment went through and your plan is active.
        </p>
        <p className="text-[14px] leading-relaxed max-w-[540px] mx-auto mb-10" style={{ color: "#6B7280" }}>
          We&apos;re setting up your access now — it usually takes just a moment. If anything looks
          off, refresh your dashboard in a minute.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link href="/app/studio" className="btn-cta rounded-full px-8 py-3.5 text-[14px] font-bold text-white">
            Start creating
          </Link>
          <Link
            href="/app/discover"
            className="rounded-full border px-8 py-3.5 text-[14px] font-semibold transition-colors hover:text-white hover:border-white/30"
            style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.14)" }}
          >
            Start discovering
          </Link>
        </div>
      </div>
    </div>
  );
}
