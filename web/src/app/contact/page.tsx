import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";

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
          <Link href="/" className="flex items-center gap-2 no-underline"><BrandLogo size={24} /><span className="font-black text-white text-[15px] tracking-tight">VibePin</span></Link>
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

            {/* Right — form (mailto) */}
            <form action={`mailto:${CONTACT}`} method="post" encType="text/plain"
              className="rounded-2xl border p-6 sm:p-7" style={{ background: "linear-gradient(180deg,#0C1018,#0A0C14)", borderColor: "rgba(255,255,255,0.10)", boxShadow: "0 24px 70px rgba(0,0,0,0.28)" }}>
              <p className="text-[15px] font-black text-white mb-4">Send us a message</p>
              <div className="grid sm:grid-cols-2 gap-3 mb-3">
                <Field label="Name" name="name" placeholder="Your name" />
                <Field label="Email" name="email" type="email" placeholder="you@example.com" />
              </div>
              <Field label="Subject" name="subject" placeholder="How can we help?" />
              <div className="mt-3">
                <label className="block text-[11px] font-semibold mb-1.5" style={{ color: "#9097A0" }}>Message</label>
                <textarea name="message" rows={5} placeholder="Tell us a bit more…"
                  className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-fuchsia-500/50 transition-colors"
                  style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.10)", color: "#E5E7EB", resize: "vertical" }} />
              </div>
              <button type="submit" className="btn-cta w-full mt-5 rounded-full py-3 text-[14px] font-bold text-white transition-transform hover:scale-[1.02]">
                Send message
              </button>
              <p className="text-[11px] text-center mt-3" style={{ color: "#4B5563" }}>
                Opens your email app. Prefer email? Write to <a href={`mailto:${CONTACT}`} className="hover:text-white" style={{ color: "#A855F7" }}>{CONTACT}</a>.
              </p>
            </form>
          </div>

          <div className="mt-16 pt-8 border-t flex flex-wrap gap-5 text-[12px]" style={{ borderColor: "rgba(255,255,255,0.07)", color: "#5B6472" }}>
            <Link href="/" className="hover:text-white transition-colors">← Home</Link>
            <Link href="/about" className="hover:text-white transition-colors">About</Link>
            <Link href="/careers" className="hover:text-white transition-colors">Careers</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, name, type = "text", placeholder }: { label: string; name: string; type?: string; placeholder?: string }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold mb-1.5" style={{ color: "#9097A0" }}>{label}</label>
      <input type={type} name={name} placeholder={placeholder}
        className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-fuchsia-500/50 transition-colors"
        style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.10)", color: "#E5E7EB" }} />
    </div>
  );
}
