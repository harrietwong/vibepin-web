import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import { BackButton } from "@/components/BackButton";

const CONTACT = "support@vibepin.co";
const UPDATED = "July 13, 2026";

export const metadata = {
  title: "Refund Policy — VibePin",
  description: "How refunds, cancellations, and billing disputes are handled for VibePin subscriptions.",
};

export default function RefundPolicyPage() {
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
            <Link href="/about" className="hover:text-white transition-colors">About</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <div className="max-w-[860px] mx-auto px-5 py-16">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Legal</p>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-2">Refund and Cancellation Policy</h1>
        <p className="text-[13px] mb-12" style={{ color: "#4D5E58" }}>Last updated: {UPDATED}</p>

        <div className="space-y-10 text-[14px] leading-relaxed" style={{ color: "#8B9E97" }}>

          <section>
            <p className="mb-3">
              This Refund and Cancellation Policy applies to paid subscriptions purchased for VibePin.
            </p>
            <p className="mb-3">
              VibePin offers monthly and annual subscription plans. We do not currently offer a free trial.
            </p>
            <p>
              Payments, invoices, taxes, subscription billing, and approved refunds are processed by{" "}
              <strong className="text-white">Paddle</strong>, our Merchant of Record.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">1. Canceling Your Subscription</h2>
            <p className="mb-3">
              You may cancel your subscription at any time through the Paddle customer portal or the billing
              section of your VibePin account.
            </p>
            <p className="mb-3">After cancellation:</p>
            <ul className="space-y-2 pl-4">
              {[
                "Your subscription will not renew for the next billing period.",
                "You will normally continue to have access until the end of the billing period you have already paid for.",
                "Canceling your subscription does not automatically create a refund for unused time.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">2. First-Purchase Refunds</h2>
            <p className="mb-3">
              Because VibePin does not offer a free trial, first-time paid subscriptions may qualify for a
              limited refund:
            </p>
            <ul className="space-y-2 pl-4 mb-3">
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                <span><strong className="text-white">Monthly subscriptions:</strong> Refund requests must be submitted within 7 calendar days of the first payment.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                <span><strong className="text-white">Annual subscriptions:</strong> Refund requests must be submitted within 14 calendar days of the first payment.</span>
              </li>
            </ul>
            <p className="mb-3">
              A first-purchase refund may be denied if the account has already been materially used.
            </p>
            <p className="mb-3">Material use may include:</p>
            <ul className="space-y-2 pl-4 mb-3">
              {[
                "Significant use of AI image credits or other usage-based allowances.",
                "Substantial generation, export, scheduling, or publishing activity.",
                "Substantial use of product research, analytics, Shopify, or other paid workflows.",
                "Any other usage showing that the paid service has already been substantially consumed.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
            <p>
              Each request will be reviewed individually and remains subject to applicable law and Paddle&apos;s
              refund procedures.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">3. Subscription Renewal Refunds</h2>
            <p className="mb-3">Subscription renewals are generally non-refundable.</p>
            <p className="mb-3">We may review an accidental renewal request when all of the following conditions are met:</p>
            <ul className="space-y-2 pl-4 mb-3">
              {[
                "For a monthly renewal, you contact us within 72 hours of the renewal charge.",
                "For an annual renewal, you contact us within 7 calendar days of the renewal charge.",
                "The service has not been materially used after the renewal.",
                "The account has not previously received a similar courtesy refund.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
            <p>
              Approval is not guaranteed and remains subject to applicable law and Paddle&apos;s processing
              requirements.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">4. No Prorated Refunds</h2>
            <p className="mb-3">
              We do not provide partial or prorated refunds when a subscription is canceled during an active
              billing period.
            </p>
            <p>
              You will normally retain access until the end of the period already paid for, and the
              subscription will not renew afterward.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">5. Duplicate Charges and Billing Errors</h2>
            <p className="mb-3">
              If you believe you were charged more than once for the same purchase, or that an obvious billing
              error occurred, please contact us.
            </p>
            <p>
              Once confirmed, we will work with Paddle to issue the appropriate refund to the original payment
              method.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">6. Service Availability Issues</h2>
            <p className="mb-3">
              If VibePin&apos;s core paid service was materially unavailable because of a problem directly caused
              by VibePin, and the issue was not resolved within a reasonable period after you notified us, we
              may provide one of the following:
            </p>
            <ul className="space-y-2 pl-4 mb-3">
              {[
                "A refund for the affected charge.",
                "A service extension.",
                "An account credit or other reasonable compensation.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mb-3">This does not normally apply to:</p>
            <ul className="space-y-2 pl-4">
              {[
                "Minor bugs or temporary interruptions.",
                "Problems caused by your device, browser, internet connection, or account configuration.",
                "Outages or restrictions caused by third-party platforms or services outside VibePin's control.",
                "Changes, limitations, or suspensions imposed by Pinterest, Shopify, or other third-party services.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">7. How to Request a Refund</h2>
            <p className="mb-4">To request a refund, contact us using the button below.</p>

            <div className="rounded-xl border p-5 mb-4 flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between"
              style={{ background: "linear-gradient(135deg,#0E1D18,#0A0C14)", borderColor: "rgba(8,145,178,0.25)" }}>
              <div>
                <p className="text-[13px] font-bold text-white mb-1">Ready to request a refund?</p>
                <p className="text-[12px]" style={{ color: "#8B9E97" }}>
                  We&apos;ll route your request to the right place. You can also email us directly at{" "}
                  <a href={`mailto:${CONTACT}`} className="font-semibold hover:text-white transition-colors"
                    style={{ color: "#0891B2" }}>
                    {CONTACT}
                  </a>.
                </p>
              </div>
              <Link href="/contact?subject=Refund%20Request"
                className="btn-cta rounded-full px-6 py-3 text-[13px] font-bold text-white shrink-0 text-center">
                Contact us to request a refund
              </Link>
            </div>

            <p className="mb-3">Please include:</p>
            <ul className="space-y-2 pl-4 mb-3">
              {[
                "The email address associated with your VibePin account.",
                "Your Paddle receipt or transaction number.",
                "The date and amount of the charge.",
                "A brief explanation of your request.",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 rounded-full shrink-0" style={{ background: "#0891B2" }} />
                  {item}
                </li>
              ))}
            </ul>
            <p>
              You may also use the subscription-management or support links included in your Paddle receipt or
              billing email.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">8. Refund Processing</h2>
            <p className="mb-3">Approved refunds will be returned to the original payment method.</p>
            <p className="mb-3">
              Refund processing times depend on Paddle, your bank, card issuer, and payment method. It may take
              several business days for an approved refund to appear on your account statement.
            </p>
            <p>VibePin cannot guarantee immediate refund processing.</p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">9. Payment Disputes and Chargebacks</h2>
            <p className="mb-3">
              If you believe a charge is incorrect, please contact VibePin Support before filing a dispute with
              your bank or card issuer.
            </p>
            <p>
              We will make reasonable efforts to investigate and resolve legitimate billing issues. Filing a
              chargeback may temporarily restrict account access while the dispute is reviewed.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">10. Statutory Consumer Rights</h2>
            <p className="mb-3">
              Nothing in this policy limits any mandatory consumer rights available under the laws of your
              country or region.
            </p>
            <p className="mb-3">
              Where applicable law provides a longer refund, withdrawal, or cancellation period than this
              policy, the applicable legal requirement will take priority.
            </p>
            <p>
              Refunds may also be reviewed and processed by Paddle in accordance with its buyer terms, refund
              procedures, and responsibilities as Merchant of Record.
            </p>
          </section>

          <section>
            <h2 className="text-[16px] font-bold text-white mb-3">11. Policy Changes</h2>
            <p className="mb-3">
              We may update this Refund and Cancellation Policy from time to time.
            </p>
            <p>
              Changes will apply from the updated effective date shown at the top of this page and will not
              reduce any mandatory rights that applied to purchases made before the update.
            </p>
          </section>

        </div>

        {/* Footer links */}
        <div className="mt-16 pt-8 border-t flex flex-wrap gap-5 text-[12px]"
          style={{ borderColor: "rgba(255,255,255,0.07)", color: "#374151" }}>
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
