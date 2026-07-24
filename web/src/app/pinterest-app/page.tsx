import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { BackButton } from "@/components/BackButton";

// TODO: replace with final support email after domain purchase
const CONTACT = "support@vibepin.co";
const UPDATED = "June 9, 2026";

export const metadata = {
  title: "How VibePin Uses Pinterest — VibePin",
  description: "A transparent explanation of how VibePin integrates with Pinterest to help you plan and publish content.",
};

export default function PinterestAppPage() {
  return (
    <div className="min-h-screen antialiased" style={{ background: "#080E0B", color: "#D1D5DB" }}>

      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md"
        style={{ background: "rgba(8,14,11,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[860px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <div className="flex items-center gap-4">
            <BackButton />
            <Link href="/" className="flex items-center gap-2 no-underline">
              <BrandLogo size={32} />
              <span className="font-black text-white text-[15px] tracking-tight">VibePin</span>
            </Link>
          </div>
          <div className="flex items-center gap-4 text-[12px]" style={{ color: "#6B7280" }}>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Pinterest Integration</p>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-2">How VibePin Uses Pinterest</h1>
        <p className="text-[13px] mb-12" style={{ color: "#4D5E58" }}>Last updated: {UPDATED}</p>

        <div className="space-y-10 text-[14px] leading-relaxed" style={{ color: "#8B9E97" }}>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">What VibePin Does</h2>
            <p>
              VibePin is a Pinterest content intelligence and weekly planning tool for creators,
              affiliate marketers, Etsy sellers, and Shopify brands. It helps you identify high-opportunity
              Pinterest topics, build a structured weekly Pin plan, and optionally publish approved Pins
              directly to your Pinterest account via Pinterest&apos;s official API.
            </p>
            <p className="mt-3">
              Connecting Pinterest is entirely optional. You can use all of VibePin&apos;s planning and
              discovery features without ever linking a Pinterest account. Pinterest integration is activated
              only when you choose to connect.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">How the Integration Works</h2>
            <div className="space-y-6">

              <div>
                <h3 className="text-[14px] font-semibold text-white mb-2">1. Discover Opportunities</h3>
                <p>
                  VibePin surfaces high-potential Pinterest topics by analyzing trend signals, search demand,
                  and save velocity data from its own data pipeline. This step does not require you to
                  connect a Pinterest account.
                </p>
              </div>

              <div>
                <h3 className="text-[14px] font-semibold text-white mb-2">2. Build a Weekly Plan</h3>
                <p>
                  You select opportunities and add them to a weekly Pin plan. VibePin organizes your
                  selections into a structured schedule — what to create and when to publish — without
                  touching your Pinterest account.
                </p>
              </div>

              <div>
                <h3 className="text-[14px] font-semibold text-white mb-2">3. Draft Pin Content</h3>
                <p>
                  VibePin helps you draft Pin titles, descriptions, and content angles based on the signals
                  it collects. Drafts are stored within VibePin only. Nothing is sent to Pinterest until
                  you explicitly review and approve a publish action.
                </p>
              </div>

              <div>
                <h3 className="text-[14px] font-semibold text-white mb-2">4. Connect Your Pinterest Account</h3>
                <p className="mb-2">
                  When you choose to publish, VibePin connects to Pinterest through Pinterest&apos;s standard
                  OAuth authorization flow. VibePin requests only the permissions required for the features
                  you use. The authorization screen is hosted by Pinterest, not VibePin.
                </p>
                <ul className="space-y-2 pl-4">
                  {[
                    "VibePin never asks for your Pinterest password.",
                    "Authorization is handled entirely by Pinterest's own secure OAuth screens.",
                    "You can review and revoke VibePin's access at any time from your Pinterest account settings.",
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2">
                      <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="text-[14px] font-semibold text-white mb-2">5. Review, Select a Board, and Publish</h3>
                <p className="mb-2">
                  When you are ready to publish a Pin draft, VibePin reads your list of Pinterest boards
                  so you can choose a destination. You review the draft, confirm the board, and initiate
                  the publish action yourself. VibePin then calls the Pinterest API to create the Pin.
                </p>
                <ul className="space-y-2 pl-4">
                  {[
                    "Every publish action requires your explicit review and confirmation.",
                    "VibePin does not auto-post, bulk-post, or schedule Pins without your approval.",
                    "Publishing is always a deliberate, user-initiated step.",
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2">
                      <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

            </div>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">Permissions We Request</h2>
            <p className="mb-4">
              VibePin requests only the minimum Pinterest permissions needed to deliver the features you use.
            </p>
            <div className="rounded-lg overflow-hidden border" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
              {[
                {
                  scope: "boards:read",
                  purpose: "Read your list of Pinterest boards so you can choose a destination when publishing a Pin.",
                },
                {
                  scope: "boards:write",
                  purpose: "Publish a Pin to the board you select. VibePin does not create boards or publish without your confirmation.",
                },
                {
                  scope: "pins:read",
                  purpose: "Read your existing Pins to help you avoid duplicating content you have already published.",
                },
                {
                  scope: "pins:write",
                  purpose: "Publish new Pins to a board you select, only after you explicitly review and confirm each action.",
                },
                {
                  scope: "user_accounts:read",
                  purpose: "Read basic profile information (name, username) to confirm which Pinterest account is connected.",
                },
              ].map((row, i) => (
                <div key={row.scope} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 px-4 py-3 border-b last:border-0"
                  style={{ borderColor: "rgba(255,255,255,0.05)", background: i % 2 === 0 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                  <span className="shrink-0 font-mono text-[12px] font-bold w-[160px]" style={{ color: "#0891B2" }}>{row.scope}</span>
                  <span className="text-[13px]" style={{ color: "#6B7280" }}>{row.purpose}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">What VibePin Does Not Do</h2>
            <ul className="space-y-2 pl-4">
              {[
                "VibePin does not collect or store your Pinterest password.",
                "VibePin does not publish Pins automatically or without your explicit review and approval.",
                "VibePin does not bulk-post or run high-volume automated publishing.",
                "VibePin does not sell or share your Pinterest data with third parties.",
                "VibePin does not access Pinterest data beyond what is needed for the features you actively use.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">Disconnecting at Any Time</h2>
            <p>
              You can disconnect your Pinterest account from VibePin at any time from your account Settings
              page. Disconnecting immediately revokes VibePin&apos;s access token and removes our ability to
              read your boards or publish on your behalf. You can also revoke access directly from your
              Pinterest account settings under &quot;Apps with access.&quot;
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">Questions</h2>
            <p>
              If you have questions about how VibePin uses the Pinterest API, contact us at:{" "}
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
          <Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
        </div>
      </div>
    </div>
  );
}
