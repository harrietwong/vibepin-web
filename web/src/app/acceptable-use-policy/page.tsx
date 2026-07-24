import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { BackButton } from "@/components/BackButton";

const CONTACT = "support@vibepin.co";
// Plain string constant (NOT a runtime Date()) so the page stays statically
// prerendered and the date never drifts. Update on material policy changes.
const UPDATED = "July 19, 2026";

export const metadata = {
  title: "Acceptable Use Policy — VibePin",
  description: "How VibePin may and may not be used, including prohibited content and prompt screening.",
};

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
      {children}
    </li>
  );
}

export default function AcceptableUsePolicyPage() {
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
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/pinterest-app" className="hover:text-white transition-colors">Pinterest App</Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Legal</p>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-2">Acceptable Use Policy</h1>
        <p className="text-[13px] mb-12" style={{ color: "#4D5E58" }}>Last updated: {UPDATED}</p>

        <div className="space-y-10 text-[14px] leading-relaxed" style={{ color: "#8B9E97" }}>

          <section>
            <p className="mb-3">
              This Acceptable Use Policy explains how VibePin may and may not be used. It applies to all users,
              visitors, accounts, prompts, uploads, generated content, and other activity involving the VibePin
              service.
            </p>
            <p>
              By accessing or using VibePin, you agree to comply with this policy.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">1. Permitted Use</h2>
            <p>
              VibePin may be used for lawful creative, commercial, educational, research, design, marketing, and
              productivity purposes, provided that the use does not violate this policy, our Terms of Service,
              applicable law, or the rights of another person.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">2. Sexual and Adult Content</h2>
            <p className="mb-3">
              You may not use VibePin to request, create, upload, promote, distribute, or assist with:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Pornography or sexually explicit content.",
                "Nudity created or presented for sexual purposes.",
                "Erotic, fetish, or sexually suggestive content.",
                "NSFW content.",
                "Sexual services or sexual exploitation.",
                "Sexualized depictions of real or fictional persons.",
                "Any sexual content involving or appearing to involve a minor.",
              ].map(item => <Bullet key={item}>{item}</Bullet>)}
            </ul>
            <p className="mt-3">
              Content involving the sexual exploitation, abuse, grooming, or endangerment of children is strictly
              prohibited and may be reported to the appropriate authorities where required by law.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">3. Face Manipulation and Deceptive Media</h2>
            <p className="mb-3">
              You may not use VibePin to create or facilitate:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Face swaps.",
                "Deepfakes.",
                "Non-consensual intimate imagery.",
                "Deceptive impersonation.",
                "Manipulated media intended to mislead people about a real person's actions, identity, or statements.",
                "Sexualized or harmful manipulation of a real person's likeness.",
              ].map(item => <Bullet key={item}>{item}</Bullet>)}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">4. Violence, Harm, and Illegal Activity</h2>
            <p className="mb-3">
              You may not use VibePin to create, promote, instruct, or assist with:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Credible threats or encouragement of violence.",
                "Terrorism or violent extremist activity.",
                "Self-harm or suicide encouragement.",
                "Abuse, exploitation, trafficking, or coercion.",
                "Illegal weapons, controlled substances, fraud, or other unlawful activity.",
                "Instructions intended to cause physical, financial, or technological harm.",
              ].map(item => <Bullet key={item}>{item}</Bullet>)}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">5. Harassment, Hate, and Exploitation</h2>
            <p className="mb-3">
              You may not use VibePin to generate or distribute content that:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Harasses, threatens, stalks, humiliates, or targets another person.",
                "Promotes hatred or violence against protected individuals or groups.",
                "Exploits vulnerable individuals.",
                "Reveals private, confidential, or highly sensitive personal information without authorization.",
              ].map(item => <Bullet key={item}>{item}</Bullet>)}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">6. Intellectual Property and Third-Party Rights</h2>
            <p className="mb-3">
              You may not use VibePin to:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Infringe copyrights, trademarks, publicity rights, privacy rights, or other proprietary rights.",
                "Falsely claim ownership or authorization.",
                "Reproduce or distribute content when you do not have the necessary rights or permissions.",
                "Impersonate another person, organization, brand, or public authority in a misleading manner.",
              ].map(item => <Bullet key={item}>{item}</Bullet>)}
            </ul>
            <p className="mt-3">
              You are responsible for ensuring that you have the rights necessary for prompts, reference materials,
              uploads, and generated outputs used through the service.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">7. Platform Abuse</h2>
            <p className="mb-3">
              You may not:
            </p>
            <ul className="space-y-2 pl-4">
              {[
                "Bypass or attempt to bypass safety systems, content moderation, usage limits, authentication, or access controls.",
                "Probe the service for prohibited-generation methods.",
                "Automate abusive requests or overload the platform.",
                "Distribute malware, phishing content, spam, or deceptive commercial material.",
                "Resell, sublicense, or misuse access contrary to your subscription or our Terms of Service.",
              ].map(item => <Bullet key={item}>{item}</Bullet>)}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">8. Prompt Screening and Enforcement</h2>
            <p className="mb-3">
              User-submitted prompts may be screened before they are sent to an AI image-generation provider.
            </p>
            <p className="mb-3">
              VibePin may block a request, restrict features, suspend an account, terminate access, preserve
              relevant records, or take other reasonable action when we believe activity violates this policy, our
              Terms of Service, applicable law, or the rights and safety of others.
            </p>
            <p>
              We may also cooperate with lawful investigations and reporting obligations where required.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">9. Reporting Violations</h2>
            <p className="mb-3">
              Suspected violations of this policy may be reported using the support contact shown on the VibePin
              website:{" "}
              <a href={`mailto:${CONTACT}`} className="font-semibold hover:text-white transition-colors"
                style={{ color: "#0891B2" }}>
                {CONTACT}
              </a>
              .
            </p>
            <p>
              Please include enough information for us to identify and review the relevant activity. Do not send
              unnecessary sensitive personal information.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">10. Changes to This Policy</h2>
            <p>
              We may update this Acceptable Use Policy as VibePin, applicable laws, safety practices, or platform
              requirements evolve. Material changes will be reflected by updating the &quot;Last updated&quot; date
              on this page.
            </p>
          </section>

        </div>

        {/* Footer links */}
        <div className="mt-16 pt-8 border-t flex flex-wrap gap-5 text-[12px]"
          style={{ borderColor: "rgba(255,255,255,0.07)", color: "#374151" }}>
          <Link href="/" className="hover:text-white transition-colors">← Home</Link>
          <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
          <Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
          <Link href="/pinterest-app" className="hover:text-white transition-colors">Pinterest App</Link>
        </div>
      </div>
    </div>
  );
}
