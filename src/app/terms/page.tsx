import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";

// TODO: replace with final support email after domain purchase
const CONTACT = "support@vibepin.co";
const UPDATED = "June 9, 2026";

export const metadata = {
  title: "Terms of Service — VibePin",
  description: "Terms and conditions for using VibePin.",
};

export default function TermsPage() {
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
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/pinterest-app" className="hover:text-white transition-colors">Pinterest App</Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Legal</p>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-2">Terms of Service</h1>
        <p className="text-[13px] mb-12" style={{ color: "#4D5E58" }}>Last updated: {UPDATED}</p>

        <div className="space-y-10 text-[14px] leading-relaxed" style={{ color: "#8B9E97" }}>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using VibePin (&quot;the Service&quot;), you agree to be bound by these Terms of Service.
              If you do not agree to these terms, do not use the Service.
              VibePin is operated by the VibePin team (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;).
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">2. Description of Service</h2>
            <p className="mb-3">
              VibePin is a Pinterest opportunity intelligence and content planning tool. It helps creators,
              ecommerce sellers, and content marketers discover content opportunities, review demand and
              competition signals, create Pin drafts, and plan weekly Pinterest content.
            </p>
            <p>
              When publishing features are available, all publishing actions are initiated only after user
              review and confirmation. The Service is intended for lawful content creation and marketing
              purposes only.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">3. User Responsibilities</h2>
            <p className="mb-3">
              You are solely responsible for all content you create, draft, approve, and publish through VibePin.
              This includes Pin titles, descriptions, images, links, and any associated metadata.
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "You must ensure that all content you publish complies with Pinterest's Community Guidelines and Terms of Service.",
                "You are responsible for obtaining all rights, licenses, and permissions required for any content you publish.",
                "You must not use VibePin to infringe on the intellectual property rights of any third party.",
                "You must not publish misleading, deceptive, or false content through the Service.",
                "You must not use VibePin to spam Pinterest or artificially inflate engagement metrics.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">4. Prohibited Content</h2>
            <p className="mb-3">
              You may not use VibePin to create, draft, or publish any content that:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Constitutes spam, bulk posting, or artificial amplification.",
                "Infringes any copyright, trademark, patent, trade secret, or other intellectual property right.",
                "Is misleading, deceptive, fraudulent, or designed to manipulate search rankings artificially.",
                "Violates any applicable local, national, or international law or regulation.",
                "Contains hate speech, harassment, or content that targets individuals or groups.",
                "Promotes illegal products, services, or activities.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">5. No Guarantee of Results</h2>
            <p className="mb-3">
              VibePin provides data, trend signals, and content planning tools. We do not guarantee any specific
              outcome, including but not limited to:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Pinterest search ranking or impression volume for any Pin.",
                "Traffic, clicks, saves, or engagement on published Pins.",
                "Sales, revenue, or affiliate commissions resulting from content planned or published via VibePin.",
                "Continued availability of trend signals, keyword data, or Pinterest API features.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-3">
              VibePin provides opportunity signals, content planning tools, and Pin draft workflows for
              informational and creative assistance purposes. We do not guarantee any specific Pinterest
              ranking, impression volume, traffic, saves, clicks, sales, revenue, affiliate commission,
              or other business outcome. All signals and opportunity scores are provided for informational
              purposes only. Past performance of similar content does not guarantee future results.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">6. Account Suspension and Termination</h2>
            <p className="mb-3">
              We reserve the right to suspend or terminate your account, with or without notice, if we determine
              that you have:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Violated these Terms of Service or Pinterest's Terms of Service.",
                "Used the Service to publish prohibited content.",
                "Engaged in abusive, fraudulent, or harmful behavior.",
                "Attempted to circumvent the Service's technical controls or rate limits.",
                "Used the Service in a way that may harm VibePin's ability to access the Pinterest API.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">7. Pinterest Integration</h2>
            <p className="mb-3">
              VibePin&apos;s Pinterest publishing features are built on Pinterest&apos;s official API and are subject to
              Pinterest&apos;s Developer Terms. When publishing features are available, all publishing actions
              require explicit user review and confirmation — VibePin does not automatically publish, bulk
              post, or take actions on your Pinterest account without your approval.
            </p>
            <p>
              Your use of Pinterest-connected features must also comply with Pinterest&apos;s Community Guidelines
              and Terms of Service. We may revoke Pinterest integration access at any time if required to do
              so by Pinterest or if you violate applicable terms.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">8. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by applicable law, VibePin and its operators shall not be liable
              for any indirect, incidental, special, consequential, or punitive damages arising from your use
              of or inability to use the Service, including loss of profits, data, or business opportunities.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">9. Changes to Terms</h2>
            <p>
              We may update these Terms of Service from time to time. We will notify registered users of
              material changes via email. Continued use of the Service after changes are posted constitutes
              your acceptance of the revised terms.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">10. Contact</h2>
            <p>
              For questions about these Terms, contact us at:{" "}
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
          <Link href="/refund-policy" className="hover:text-white transition-colors">Refund Policy</Link>
          <Link href="/pinterest-app" className="hover:text-white transition-colors">Pinterest App</Link>
        </div>
      </div>
    </div>
  );
}
