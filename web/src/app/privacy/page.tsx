import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { BackButton } from "@/components/BackButton";

const CONTACT = "support@vibepin.co";
const UPDATED = "July 20, 2026";

export const metadata = {
  title: "Privacy Policy — VibePin",
  description: "How VibePin collects, uses, and protects your data, including Pinterest OAuth information.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen antialiased" style={{ background: "#080E0B", color: "#D1D5DB" }}>

      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md"
        style={{ background: "rgba(8,14,11,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[860px] mx-auto px-5 h-[56px] flex items-center justify-between">
          <div className="flex items-center gap-4">
            <BackButton />
            <Link href="/" className="flex items-center gap-2 no-underline">
              <BrandLogo size={24} />
              <span className="font-black text-white text-[15px] tracking-tight">VibePin</span>
            </Link>
          </div>
          <div className="flex items-center gap-4 text-[12px]" style={{ color: "#6B7280" }}>
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
            <Link href="/acceptable-use-policy" className="hover:text-white transition-colors">Acceptable Use</Link>
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
            <p className="mb-3">
              VibePin (&quot;VibePin,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) is a merchant-facing ecommerce content creation, planning, and publishing workflow platform. VibePin helps ecommerce merchants create and manage social-ready product content from product information and content they control.
            </p>
            <p>
              This Privacy Policy explains what information we collect, how we use and protect it, how we handle Pinterest-related information, and the choices and rights available to users. By using VibePin, you acknowledge the practices described in this Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">2. Pinterest API and OAuth Integration</h2>
            <p className="mb-3">
              VibePin uses the official Pinterest API and Pinterest OAuth to allow an authorized merchant to connect the merchant&apos;s own Pinterest Business account and use Pinterest-related features within VibePin.
            </p>
            <p className="mb-3">
              Connecting a Pinterest account is optional and occurs only after the user initiates Pinterest&apos;s official OAuth authorization flow and grants the requested permissions. VibePin does not request or store Pinterest passwords.
            </p>
            <p className="mb-3">
              VibePin requests only the Pinterest permissions reasonably necessary to provide the features selected by the user. Depending on the permissions granted, VibePin may access limited Pinterest account information, profile information, boards, Pins, and publishing-related information to support account connection, board selection, content review, and user-approved publishing.
            </p>
            <p className="mb-3">
              VibePin does not publish a Pin without the user&apos;s explicit action. Before publishing, the user can review the content, selected board, destination URL (if provided), and other applicable publishing settings, and must explicitly approve the publish action.
            </p>
            <p className="mb-3">
              VibePin does not use the Pinterest API to automate engagement, follows, comments, messages, or other artificial activity. VibePin does not scrape Pinterest or use Pinterest data for unauthorized competitor monitoring.
            </p>
            <p>
              VibePin is not endorsed by, sponsored by, or affiliated with Pinterest. Pinterest is a trademark of Pinterest, Inc.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">3. Information We Collect</h2>
            <p className="mb-4">We may collect the following categories of information:</p>
            <div className="space-y-4">
              {[
                { t: "Account information:", d: "Information used to create and manage a VibePin account, such as name, email address, account identifiers, and authentication information." },
                { t: "Merchant and product information:", d: "Product titles, descriptions, images, product URLs, store information, and other content imported from or provided by the merchant." },
                { t: "Content information:", d: "Draft images, titles, descriptions, captions, links, publishing selections, and other content created, uploaded, edited, or approved through VibePin." },
                { t: "Pinterest-related information:", d: "If a user connects Pinterest, we may receive limited information made available through the Pinterest API and the permissions granted by the user, such as Pinterest account identifiers, profile information, board information, Pin information, publishing status, and OAuth tokens." },
                { t: "Usage and technical information:", d: "Information about how users interact with VibePin, such as pages visited, features used, device and browser information, IP address, logs, and error information." },
                { t: "Communications:", d: "Information users provide when contacting customer support or communicating with us." },
              ].map(item => (
                <div key={item.t}>
                  <p className="font-semibold text-white mb-1">{item.t}</p>
                  <p>{item.d}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">4. How We Use Information</h2>
            <p className="mb-4">We use information to:</p>
            <ul className="space-y-2 pl-4">
              {[
                "Provide, operate, maintain, and secure VibePin.",
                "Authenticate users and manage connected accounts.",
                "Import and organize merchant-provided product information.",
                "Create, save, edit, and manage content drafts.",
                "Display Pinterest boards and other authorized account information.",
                "Publish content only after the user explicitly reviews and approves the publish action.",
                "Display publishing status and help diagnose publishing errors.",
                "Improve product functionality, reliability, usability, and security.",
                "Respond to support requests and communicate service-related information.",
                "Send product updates or marketing communications where permitted, with an option to opt out.",
                "Comply with legal obligations and enforce our terms and policies.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">5. Pinterest Data Handling</h2>
            <p className="mb-3">
              Pinterest-related information is used only to provide features requested and authorized by the user.
            </p>
            <p className="mb-3">
              VibePin does not sell, rent, license, resell, redistribute, or otherwise provide Pinterest content or Pinterest-derived data to third parties for their independent use, advertising, data brokerage, or other unrelated purposes.
            </p>
            <p className="mb-3">
              We do not use Pinterest-derived data to create profiles for unrelated advertising purposes. We do not combine Pinterest-derived data with data from unrelated sources for sale or redistribution.
            </p>
            <p>
              We may use service providers that process information on our behalf solely as necessary to host, secure, maintain, monitor, and operate VibePin. These providers may not use Pinterest-related information for their own independent purposes and are subject to contractual or legal confidentiality and data-protection obligations.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">6. AI Prompts, Content Moderation, and Third-Party AI Services</h2>
            <p className="mb-3">
              When a user requests AI image generation, VibePin processes the user-controlled inputs associated with
              that request. These may include keywords, prompts, creative direction, category selections, tags, and
              related descriptive text the user enters or selects.
            </p>
            <p className="mb-3">
              Image-generation prompts and related user-controlled inputs may be transmitted to third-party
              content-moderation and artificial-intelligence service providers solely to screen requests and provide
              the requested generation features.
            </p>
            <p className="mb-3">
              Before generation begins, these inputs are transmitted to a content-moderation service, which is used
              to determine whether the request is permitted under our Acceptable Use Policy. If the request is
              permitted, the related inputs are then sent to a third-party AI image-generation service in order to
              produce the requested images. If the request is not permitted, or cannot be evaluated, generation does
              not proceed.
            </p>
            <p className="mb-3">
              These third-party providers process the inputs under their own terms and privacy policies, and we do
              not control their independent data practices or retention periods. We do not make any representation
              about how long a third-party moderation or AI provider retains request data.
            </p>
            <p className="mb-3">
              VibePin&apos;s own API credentials and provider keys are held server-side. They are never written to
              logs, never returned in API responses, and never exposed in client-side code.
            </p>
            <p>
              VibePin is an independent product that integrates third-party artificial-intelligence services. It is
              not affiliated with or endorsed by the providers of those AI models. See our{" "}
              <Link href="/acceptable-use-policy" className="font-semibold hover:text-white transition-colors" style={{ color: "#0891B2" }}>Acceptable Use Policy</Link>
              {" "}for the rules that govern generation requests.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">7. Disconnecting Pinterest and Deletion of Pinterest-Related Data</h2>
            <p className="mb-3">
              A user may disconnect their Pinterest account from VibePin at any time through VibePin Settings or by revoking access through Pinterest.
            </p>
            <p className="mb-3">After a Pinterest account is disconnected or authorization is revoked:</p>
            <ul className="space-y-2 pl-4 mb-3">
              {[
                "VibePin stops making new Pinterest API requests using that authorization.",
                "Stored Pinterest OAuth access and refresh tokens associated with the connection are deleted, invalidated, or otherwise made unusable.",
                "Pinterest-derived account, board, Pin, and publishing information stored solely to provide the connected Pinterest features is deleted or anonymized within 30 days.",
                "Limited records may be retained where reasonably necessary for security, fraud prevention, dispute resolution, legal compliance, or the establishment, exercise, or defense of legal claims.",
                "Residual copies may remain temporarily in encrypted backups and are removed through the ordinary backup-retention cycle, generally within 90 days, unless a longer period is legally required.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mb-3">
              Disconnecting Pinterest does not automatically delete content that the user independently created or uploaded to VibePin, such as product information or draft content, unless the user separately requests its deletion.
            </p>
            <p>
              Users may request earlier deletion of eligible Pinterest-related data by contacting{" "}
              <a href={`mailto:${CONTACT}`} className="font-semibold hover:text-white transition-colors" style={{ color: "#0891B2" }}>{CONTACT}</a>.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">8. Data Sharing and Service Providers</h2>
            <p className="mb-3">We do not sell, rent, or trade personal information.</p>
            <p className="mb-3">
              We may disclose limited information to trusted service providers that help us operate VibePin, including providers of cloud hosting, databases, authentication, security, analytics, communications, and customer support. They may process information only to provide services to VibePin and subject to applicable confidentiality and data-protection obligations.
            </p>
            <p className="mb-3">We may also disclose information:</p>
            <ul className="space-y-2 pl-4">
              {[
                "When required by law, regulation, legal process, or a valid governmental request.",
                "To protect the rights, safety, security, and integrity of VibePin, our users, or others.",
                "In connection with a merger, acquisition, financing, reorganization, or sale of assets, subject to appropriate safeguards and notice where required.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">9. Data Retention</h2>
            <p className="mb-3">
              We retain personal information only for as long as reasonably necessary to provide VibePin, fulfill the purposes described in this Privacy Policy, comply with legal obligations, resolve disputes, and enforce agreements.
            </p>
            <p className="mb-3">
              Account and merchant content may generally be retained while the account remains active. Users may request deletion of their account and associated eligible information at any time.
            </p>
            <p>
              Pinterest-related information is handled according to the disconnection and deletion practices described in Section 7.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">10. Data Security</h2>
            <p className="mb-3">
              We use reasonable administrative, technical, and organizational safeguards designed to protect information against unauthorized access, loss, misuse, alteration, or disclosure.
            </p>
            <p>
              Pinterest OAuth tokens are stored using appropriate security controls and are not exposed to other users or included in public client-side code. However, no system or method of transmission is completely secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">11. International Processing</h2>
            <p>
              VibePin and its service providers may process information in countries other than the user&apos;s country of residence. Where required, we use appropriate safeguards for international data transfers.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">12. Your Choices and Rights</h2>
            <p className="mb-4">Depending on applicable law, users may have the right to:</p>
            <ul className="space-y-2 pl-4 mb-4">
              {[
                "Request access to personal information we hold about them.",
                "Request correction of inaccurate or incomplete information.",
                "Request deletion of eligible personal information.",
                "Request restriction of or object to certain processing.",
                "Request a portable copy of certain information.",
                "Withdraw consent where processing is based on consent.",
                "Disconnect Pinterest or revoke Pinterest authorization at any time.",
                "Opt out of marketing communications.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
            <p>
              To exercise a privacy right, contact{" "}
              <a href={`mailto:${CONTACT}`} className="font-semibold hover:text-white transition-colors" style={{ color: "#0891B2" }}>{CONTACT}</a>.
              We may need to verify the requester&apos;s identity before completing a request.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">13. Children&apos;s Privacy</h2>
            <p>
              VibePin is not directed to children under 13, or a higher minimum age where required by applicable law. We do not knowingly collect personal information from children in violation of applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">14. Changes to This Privacy Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. When we make material changes, we will update the &quot;Last updated&quot; date and provide additional notice where required.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">15. Contact</h2>
            <p className="mb-2">For privacy questions, requests, or concerns, contact:</p>
            <p className="mb-1 text-white font-semibold">VibePin</p>
            <p className="mb-1">
              Email:{" "}
              <a href={`mailto:${CONTACT}`} className="font-semibold hover:text-white transition-colors" style={{ color: "#0891B2" }}>{CONTACT}</a>
            </p>
            <p>
              Website:{" "}
              <a href="https://www.vibepin.co" className="font-semibold hover:text-white transition-colors" style={{ color: "#0891B2" }}>https://www.vibepin.co</a>
            </p>
          </section>

        </div>

        {/* Footer links */}
        <div className="mt-16 pt-8 border-t flex flex-wrap gap-5 text-[12px]"
          style={{ borderColor: "rgba(255,255,255,0.07)", color: "#374151" }}>
          <Link href="/" className="hover:text-white transition-colors">← Home</Link>
          <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
          <Link href="/acceptable-use-policy" className="hover:text-white transition-colors">Acceptable Use Policy</Link>
          <Link href="/refund-policy" className="hover:text-white transition-colors">Refund Policy</Link>
          <Link href="/pinterest-app" className="hover:text-white transition-colors">Pinterest App</Link>
        </div>
      </div>
    </div>
  );
}
