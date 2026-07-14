import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";

// TODO: replace with final support email after domain purchase
const CONTACT = "support@vibepin.co";
const UPDATED = "June 9, 2026";

export const metadata = {
  title: "Privacy Policy — VibePin",
  description: "How VibePin collects, uses, and protects your data.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen antialiased" style={{ background: "#080E0B", color: "#D1D5DB" }}>

      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md"
        style={{ background: "rgba(8,14,11,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[860px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 no-underline">
            <BrandLogo size={24} />
            <span className="font-black text-white text-[15px] tracking-tight">VibePin</span>
          </Link>
          <div className="flex items-center gap-4 text-[12px]" style={{ color: "#6B7280" }}>
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
            <Link href="/pinterest-app" className="hover:text-white transition-colors">Pinterest App</Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Legal</p>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-[13px] mb-12" style={{ color: "#4D5E58" }}>Last updated: {UPDATED}</p>

        <div className="space-y-10 text-[14px] leading-relaxed" style={{ color: "#8B9E97" }}>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">1. Overview</h2>
            <p>
              VibePin (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) is a Pinterest intelligence and content planning tool.
              This Privacy Policy explains what data we collect, how we use it, and your rights regarding that data.
              By using VibePin, you agree to the practices described here.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">2. Pinterest OAuth Integration</h2>
            <p className="mb-3">
              VibePin uses Pinterest OAuth to allow users to optionally connect their Pinterest account.
              This connection is activated only when a user explicitly chooses to authorize access.
            </p>
            <p className="mb-3">
              VibePin does not automatically publish Pins, bulk post content, or take actions on a
              user&apos;s Pinterest account without explicit user confirmation.
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "VibePin requests only the Pinterest permissions needed to provide the selected feature.",
                "We only request Pinterest permissions after you explicitly authorize access.",
                "With your authorization, VibePin may access Pinterest profile information, boards, and Pins to support account connection, board selection, Pin planning, and user-confirmed publishing features.",
                "VibePin may publish Pins only after you explicitly review and confirm each publish action.",
                "Pinterest OAuth tokens are stored securely and are not sold or shared with third parties.",
                "You can disconnect your Pinterest account at any time from your VibePin Settings page. When disconnected, VibePin will stop accessing Pinterest data and will delete or invalidate stored OAuth tokens where applicable.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">3. Data We Collect</h2>
            <ul className="space-y-2 pl-4">
              {[
                "Account data: email address used to create your VibePin account.",
                "Usage data: pages visited, features used, and interactions within the app (for product improvement).",
                "Pinterest data: profile information, board list, and pin data — only if you connect Pinterest and only for the purpose of providing app features.",
                "Content data: Pin drafts, titles, and descriptions you create inside VibePin.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">4. How We Use Your Data</h2>
            <ul className="space-y-2 pl-4">
              {[
                "To operate and improve the VibePin service.",
                "To publish Pins on your behalf when you explicitly request it.",
                "To personalize opportunity recommendations based on your selected niches.",
                "To send product updates and feature announcements (you can opt out at any time).",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">5. Data Sharing</h2>
            <p className="mb-3">
              We do not sell, rent, or trade your personal data to any third party.
            </p>
            <p>
              We may share data with trusted infrastructure providers, such as database hosting,
              authentication, analytics, and email service providers, strictly to operate the service.
              These providers are bound by their own privacy policies and may not use your data for any
              other purpose.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">6. Data Retention</h2>
            <p>
              We retain your data for as long as your account is active. You may request deletion of your
              account and associated data at any time by contacting us at the email below.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">7. Your Rights</h2>
            <ul className="space-y-2 pl-4">
              {[
                "Access: request a copy of the data we hold about you.",
                "Correction: request correction of inaccurate data.",
                "Deletion: request deletion of your account and personal data.",
                "Disconnect: remove Pinterest access at any time from Settings.",
                "Opt-out: unsubscribe from marketing emails at any time.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">8. Contact</h2>
            <p>
              For any privacy-related questions or requests, contact us at:{" "}
              <a href={`mailto:${CONTACT}`} className="font-semibold hover:text-white transition-colors"
                style={{ color: "#0891B2" }}>
                {CONTACT}
              </a>
            </p>
          </section>

        </div>

        {/* Footer links */}
        <div className="mt-16 pt-8 border-t flex flex-wrap gap-5 text-[12px]"
          style={{ borderColor: "rgba(255,255,255,0.07)", color: "#374151" }}>
          <Link href="/" className="hover:text-white transition-colors">← Home</Link>
          <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
          <Link href="/refund-policy" className="hover:text-white transition-colors">Refund Policy</Link>
          <Link href="/pinterest-app" className="hover:text-white transition-colors">Pinterest App</Link>
        </div>
      </div>
    </div>
  );
}
