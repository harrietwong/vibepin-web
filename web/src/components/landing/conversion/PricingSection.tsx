import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { PRICING_TIERS, type PricingTier } from "@/lib/pricingPlans";
import { CONTAINER, GradientText, SECTION, SectionLabel, VibeBtn } from "./shared";

const MONO: React.CSSProperties = {
  fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace",
};

/**
 * Landing paid CTAs must carry the buyer's purchase intent through signup, the
 * same way /pricing does for signed-out clicks: `/signup?plan=<id>&next=<encoded
 * /pricing?checkout=<id>&period=month>`. Without the `next`, signup falls back to
 * /app/studio and the buyer never reaches checkout.
 *
 * This section has no month/year toggle (it only renders `priceMonthly`), so the
 * period is always `month`. Free keeps its plain `/signup?plan=free`.
 */
function planCtaHref(plan: PricingTier): string {
  if (plan.id === "free") return plan.ctaHref;
  const resumeNext = `/pricing?checkout=${encodeURIComponent(plan.id)}&period=month`;
  return `/signup?plan=${encodeURIComponent(plan.id)}&next=${encodeURIComponent(resumeNext)}`;
}

/** Light pricing preview for the landing page. The real pricing page lives at
 *  /pricing — this section only shows the tiers and links there. */
export function PricingSection() {
  return (
    <section
      className={SECTION}
      style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}
    >
      <div className={CONTAINER}>
        <div className="text-center max-w-[720px] mx-auto mb-12">
          <SectionLabel>SIMPLE PRICING</SectionLabel>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.08] mb-4">
            Start free. <GradientText>Create more when you&apos;re ready.</GradientText>
          </h2>
          <p className="text-[14px] leading-relaxed" style={{ color: "#8B93A1" }}>
            Explore high-save products, trending Pins, and keyword ideas for free. Upgrade when you
            need more AI generation, scheduling, and publishing across Pinterest, Instagram,
            TikTok, and Facebook.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch mb-10">
          {PRICING_TIERS.map(plan => (
            <div
              key={plan.id}
              className="relative flex flex-col rounded-2xl p-6 transition-transform hover:-translate-y-1"
              style={
                plan.highlighted
                  ? {
                      background:
                        "linear-gradient(180deg,rgba(124,58,237,0.14),rgba(217,70,239,0.05))",
                      border: "1px solid rgba(168,85,247,0.40)",
                      boxShadow: "0 0 40px rgba(168,85,247,0.12)",
                    }
                  : {
                      background: "var(--surface-2)",
                      border: "1px solid rgba(255,255,255,0.08)",
                    }
              }
            >
              {plan.badge && (
                <span
                  className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[10px] font-bold text-white tracking-wide"
                  style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}
                >
                  {plan.badge}
                </span>
              )}
              <p
                className="text-[12px] font-bold uppercase tracking-widest mb-3"
                style={{ color: "#9097A0" }}
              >
                {plan.name}
              </p>
              <div className="flex items-end gap-1 mb-3">
                <span className="text-4xl font-black text-white" style={MONO}>
                  ${plan.priceMonthly}
                </span>
                <span className="pb-1.5 text-sm" style={{ color: "#4B5563" }}>
                  /mo
                </span>
              </div>
              <p className="text-[12px] mb-5 leading-relaxed" style={{ color: "#8B93A1" }}>
                {plan.description}
              </p>
              <ul className="flex-1 space-y-2.5 mb-6">
                {plan.previewBullets.map(f => (
                  <li key={f} className="flex items-start gap-2.5 text-[12px]">
                    <Check
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                      style={{ color: plan.highlighted ? "#A855F7" : "#10B981" }}
                    />
                    <span style={{ color: "#C8CDD6" }}>{f}</span>
                  </li>
                ))}
              </ul>
              <Link
                href={planCtaHref(plan)}
                className={`w-full rounded-full py-3 text-[13px] font-bold text-center transition-all ${
                  plan.highlighted ? VibeBtn : "border hover:text-white hover:border-white/30"
                }`}
                style={
                  plan.highlighted
                    ? {}
                    : { borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }
                }
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>

        <div className="text-center">
          <Link
            href="/pricing"
            className="inline-flex items-center gap-2 rounded-full border px-7 py-3 text-[13px] font-bold transition-colors hover:text-white hover:border-white/30"
            style={{ borderColor: "rgba(255,255,255,0.16)", color: "#C8CDD6" }}
          >
            View full pricing <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
