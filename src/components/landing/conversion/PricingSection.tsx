"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { PRICING_PLANS, PRICING_REASSURANCE } from "@/lib/landing/conversionData";
import { CONTAINER, GradientText, SECTION, SectionLabel, VibeBtn } from "./shared";

const MONO: React.CSSProperties = {
  fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace",
};

export function PricingSection() {
  const [yearly, setYearly] = useState(false);
  const router = useRouter();

  return (
    <section
      id="pricing"
      className={`${SECTION}`}
      style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}
    >
      <div className={CONTAINER}>
        <div className="text-center max-w-[720px] mx-auto mb-12">
          <SectionLabel>SIMPLE PRICING</SectionLabel>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.08] mb-4">
            Start free. <GradientText>Scale your Pinterest workflow</GradientText> when you&apos;re ready.
          </h2>
          <p className="text-[14px] leading-relaxed mb-6" style={{ color: "#8B93A1" }}>
            Explore opportunities for free, then upgrade as you create more Pins, run more campaigns,
            manage more accounts, and auto-publish at scale.
          </p>
          <div
            className="inline-flex items-center gap-1 rounded-full border p-1.5"
            style={{ background: "#080C12", borderColor: "rgba(255,255,255,0.08)" }}
          >
            {[
              { label: "Monthly", val: false },
              { label: "Yearly", val: true },
            ].map(o => (
              <button
                key={o.label}
                type="button"
                onClick={() => setYearly(o.val)}
                className="rounded-full px-5 py-2 text-[13px] font-bold transition-all flex items-center gap-2"
                style={
                  yearly === o.val
                    ? { background: "var(--surface-2)", color: "#E5E7EB" }
                    : { color: "#4B5563" }
                }
              >
                {o.label}
                {o.val && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                    style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}
                  >
                    Save 20%
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch mb-8">
          {PRICING_PLANS.map(plan => {
            const price = yearly ? plan.priceYearly : plan.priceMonthly;
            const priceLabel = price === 0 ? "$0" : `$${price}`;
            return (
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
                  className="text-[12px] font-bold uppercase tracking-widest mb-1"
                  style={{ color: "#9097A0" }}
                >
                  {plan.name}
                </p>
                <p className="text-[11px] mb-3" style={{ color: "#6B7280" }}>
                  Best for {plan.bestFor}
                </p>
                <div className="flex items-end gap-1 mb-2">
                  <span className="text-4xl font-black text-white" style={MONO}>
                    {priceLabel}
                  </span>
                  {price > 0 && (
                    <span className="pb-1.5 text-sm" style={{ color: "#4B5563" }}>
                      /mo
                    </span>
                  )}
                </div>
                <p className="text-[12px] mb-5 leading-relaxed" style={{ color: "#8B93A1" }}>
                  {plan.valueStatement}
                </p>
                <ul className="flex-1 space-y-2.5 mb-6">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-2.5 text-[12px]">
                      <Check
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        style={{ color: plan.highlighted ? "#A855F7" : "#10B981" }}
                      />
                      <span style={{ color: "#C8CDD6" }}>{f}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      plan.planKey === "free"
                        ? "/app/discover?demo=true"
                        : `/signup?plan=${plan.planKey}`,
                    )
                  }
                  className={`w-full rounded-full py-3 text-[13px] font-bold transition-all ${
                    plan.highlighted ? VibeBtn : "border hover:text-white hover:border-white/30"
                  }`}
                  style={
                    plan.highlighted
                      ? {}
                      : { borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }
                  }
                >
                  {plan.cta}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {PRICING_REASSURANCE.map(t => (
            <span
              key={t}
              className="flex items-center gap-1.5 text-[11px]"
              style={{ color: "#6B7280" }}
            >
              <Check className="w-3 h-3 shrink-0" style={{ color: "#10B981" }} />
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}