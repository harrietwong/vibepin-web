"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createBrowserClient } from "@supabase/ssr";
import { ArrowRight, Check, Minus } from "lucide-react";
import type { Paddle } from "@paddle/paddle-js";
import BrandLogo from "@/components/BrandLogo";
import {
  ACCOUNTS_HELPER_TEXT,
  COMPARISON_SECTIONS,
  ENTERPRISE_PLAN,
  PRICING_FAQ,
  PRICING_REASSURANCE,
  PRICING_TIERS,
  type PricingTier,
} from "@/lib/pricingPlans";
import { getPaddle } from "@/lib/paddle/paddleClient";
import { CONTAINER, GradientText, SectionLabel, VibeBtn } from "@/components/landing/conversion/shared";
import { FaqAccordionItem } from "@/components/landing/conversion/FaqSection";
import { LandingFooter } from "@/components/landing/conversion/LandingFooter";

const MONO: React.CSSProperties = {
  fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace",
};

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

/** Map of Paddle price id → localized, currency-formatted total string. */
type PriceMap = Record<string, string>;

function openCheckout(
  paddle: Paddle,
  priceId: string,
  email: string | null,
  userId: string | null,
) {
  paddle.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    settings: {
      displayMode: "overlay",
      variant: "one-page",
      successUrl: `${window.location.origin}/welcome`,
    },
    ...(email ? { customer: { email } } : {}),
    // Server webhook prefers custom_data.userId to link the Paddle customer to
    // this VibePin user. Only sent when signed in; anonymous checkout omits it.
    ...(userId ? { customData: { userId } } : {}),
  });
}

function BillingToggle({ yearly, onChange }: { yearly: boolean; onChange: (v: boolean) => void }) {
  return (
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
          onClick={() => onChange(o.val)}
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
  );
}

function PlanCards({
  yearly,
  paddle,
  priceMap,
  email,
  userId,
}: {
  yearly: boolean;
  paddle: Paddle | null;
  priceMap: PriceMap;
  email: string | null;
  userId: string | null;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch">
      {PRICING_TIERS.map(plan => {
        // Static USD fallback (also used for the Free card and whenever the
        // Paddle preview hasn't loaded).
        const staticPrice = yearly ? plan.priceYearly : plan.priceMonthly;

        // Localized price string from Paddle, when available for this toggle.
        const paddlePriceId = plan.paddlePriceIds
          ? yearly
            ? plan.paddlePriceIds.year
            : plan.paddlePriceIds.month
          : undefined;
        const localizedTotal = paddlePriceId ? priceMap[paddlePriceId] : undefined;

        // Checkout only when Paddle is ready AND this tier has catalog IDs.
        const canCheckout = !!paddle && !!plan.paddlePriceIds;

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
              className="text-[12px] font-bold uppercase tracking-widest mb-3"
              style={{ color: "#9097A0" }}
            >
              {plan.name}
            </p>

            {localizedTotal ? (
              // Localized: show Paddle's formatted total verbatim + period label.
              <>
                <div className="flex items-end gap-1 mb-1">
                  <span className="text-4xl font-black text-white" style={MONO}>
                    {localizedTotal}
                  </span>
                  <span className="pb-1.5 text-sm" style={{ color: "#4B5563" }}>
                    {yearly ? "/yr" : "/mo"}
                  </span>
                </div>
                <p className="text-[11px] mb-3 min-h-[1em]" style={{ color: "#6B7280" }}>
                  {yearly ? "billed annually" : ""}
                </p>
              </>
            ) : (
              // Static USD fallback (unchanged from the pre-Paddle rendering).
              <>
                <div className="flex items-end gap-1 mb-1">
                  <span className="text-4xl font-black text-white" style={MONO}>
                    ${staticPrice}
                  </span>
                  <span className="pb-1.5 text-sm" style={{ color: "#4B5563" }}>
                    /mo
                  </span>
                </div>
                <p className="text-[11px] mb-3 min-h-[1em]" style={{ color: "#6B7280" }}>
                  {plan.priceMonthly > 0
                    ? yearly
                      ? "billed annually"
                      : `$${plan.priceYearly}/mo billed annually`
                    : "free forever"}
                </p>
              </>
            )}

            <p className="text-[12px] mb-5 leading-relaxed" style={{ color: "#8B93A1" }}>
              {plan.description}
            </p>
            <ul className="flex-1 space-y-2.5 mb-6">
              {plan.bullets.map(f => (
                <li key={f} className="flex items-start gap-2.5 text-[12px]">
                  <Check
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    style={{ color: plan.highlighted ? "#A855F7" : "#10B981" }}
                  />
                  <span style={{ color: "#C8CDD6" }}>{f}</span>
                </li>
              ))}
            </ul>

            {canCheckout && paddle && paddlePriceId ? (
              <button
                type="button"
                onClick={() => openCheckout(paddle, paddlePriceId, email, userId)}
                className={`w-full rounded-full py-3 text-[13px] font-bold text-center transition-all ${
                  plan.highlighted ? VibeBtn : "border hover:text-white hover:border-white/30"
                }`}
                style={
                  plan.highlighted ? {} : { borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }
                }
              >
                {plan.cta}
              </button>
            ) : (
              <Link
                href={plan.ctaHref}
                className={`w-full rounded-full py-3 text-[13px] font-bold text-center transition-all ${
                  plan.highlighted ? VibeBtn : "border hover:text-white hover:border-white/30"
                }`}
                style={
                  plan.highlighted ? {} : { borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }
                }
              >
                {plan.cta}
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EnterpriseBanner() {
  return (
    <div
      className="rounded-2xl border p-6 sm:p-7 flex flex-col lg:flex-row lg:items-center gap-5"
      style={{
        background: "linear-gradient(135deg,#120E1E,#0A0C14)",
        borderColor: "rgba(168,85,247,0.22)",
      }}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: "#A855F7" }}>
          Enterprise / Agency
        </p>
        <p className="text-[16px] font-black text-white mb-1.5">{ENTERPRISE_PLAN.title}</p>
        <p className="text-[13px] leading-relaxed mb-4" style={{ color: "#8B93A1" }}>
          {ENTERPRISE_PLAN.description}
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {ENTERPRISE_PLAN.bullets.map(b => (
            <span key={b} className="flex items-center gap-1.5 text-[12px]" style={{ color: "#C8CDD6" }}>
              <Check className="w-3 h-3 shrink-0" style={{ color: "#A855F7" }} />
              {b}
            </span>
          ))}
        </div>
      </div>
      <Link
        href={ENTERPRISE_PLAN.ctaHref}
        className="shrink-0 rounded-full border px-7 py-3 text-[13px] font-bold text-center transition-colors hover:text-white hover:border-white/30"
        style={{ borderColor: "rgba(255,255,255,0.16)", color: "#C8CDD6" }}
      >
        {ENTERPRISE_PLAN.cta}
      </Link>
    </div>
  );
}

function CellValue({ value, highlighted }: { value: string; highlighted: boolean }) {
  if (value === "✓") {
    return (
      <Check
        aria-label="Included"
        className="h-4 w-4 mx-auto"
        style={{ color: highlighted ? "#A855F7" : "#10B981" }}
      />
    );
  }
  if (value === "—") {
    return <Minus aria-label="Not included" className="h-4 w-4 mx-auto" style={{ color: "#374151" }} />;
  }
  if (value === "Limited" || value === "Basic") {
    return (
      <span className="text-[11px] font-semibold" style={{ color: "#8B93A1" }}>
        {value}
      </span>
    );
  }
  return (
    <span className="text-[12px] font-bold text-white tabular-nums" style={MONO}>
      {value}
    </span>
  );
}

function ComparisonTable() {
  return (
    <div className="overflow-x-auto rounded-2xl border" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
      <table className="w-full min-w-[760px] border-collapse" style={{ background: "var(--surface-2)" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.10)" }}>
            <th className="text-left px-5 py-4 text-[12px] font-bold uppercase tracking-widest w-[32%]" style={{ color: "#6B7280" }}>
              Features
            </th>
            {PRICING_TIERS.map(plan => (
              <th
                key={plan.id}
                className="px-4 py-4 text-center w-[17%]"
                style={plan.highlighted ? { background: "rgba(124,58,237,0.10)" } : undefined}
              >
                <span className="block text-[13px] font-black text-white">{plan.name}</span>
                <span className="block text-[11px] mt-0.5" style={{ color: "#6B7280", ...MONO }}>
                  ${plan.priceMonthly}/mo
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {COMPARISON_SECTIONS.map(section => (
          <tbody key={section.title}>
            <tr>
              <td
                colSpan={5}
                className="px-5 pt-6 pb-2 text-[11px] font-bold uppercase tracking-[0.16em]"
                style={{ color: "#A855F7" }}
              >
                {section.title}
              </td>
            </tr>
            {section.rows.map(row => (
              <tr key={row.label} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <td className="px-5 py-3 text-[13px]" style={{ color: "#C8CDD6" }}>
                  {row.label}
                  {row.note && (
                    <span className="block text-[11px] mt-0.5" style={{ color: "#6B7280" }}>
                      {row.note}
                    </span>
                  )}
                </td>
                {row.values.map((value, i) => (
                  <td
                    key={PRICING_TIERS[i].id}
                    className="px-4 py-3 text-center"
                    style={PRICING_TIERS[i].highlighted ? { background: "rgba(124,58,237,0.10)" } : undefined}
                  >
                    <CellValue value={value} highlighted={!!PRICING_TIERS[i].highlighted} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

export default function PricingPageClient({ country }: { country?: string }) {
  const [yearly, setYearly] = useState(false);
  const [paddle, setPaddle] = useState<Paddle | null>(null);
  const [priceMap, setPriceMap] = useState<PriceMap>({});
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Prefill checkout email + link the Paddle customer to this VibePin user
  // (anonymous is normal — both stay null).
  useEffect(() => {
    let active = true;
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (active) {
          setEmail(data.user?.email ?? null);
          setUserId(data.user?.id ?? null);
        }
      })
      .catch(() => {
        /* anonymous visitor — ignore */
      });
    return () => {
      active = false;
    };
  }, []);

  // Initialize Paddle + fetch localized price previews. On any failure
  // (missing env, load error, preview error) we stay in static fallback mode:
  // the page renders exactly as before with static USD prices and /signup CTAs.
  useEffect(() => {
    let active = true;

    (async () => {
      let instance: Paddle;
      try {
        instance = await getPaddle();
      } catch (err) {
        console.error(
          err instanceof Error ? err.message : "Paddle failed to initialize.",
        );
        return; // fallback mode
      }
      if (!active) return;
      setPaddle(instance);

      // Every catalog price id across the paid tiers (month + year).
      const items = PRICING_TIERS.flatMap((plan: PricingTier) =>
        plan.paddlePriceIds
          ? [
              { priceId: plan.paddlePriceIds.month, quantity: 1 },
              { priceId: plan.paddlePriceIds.year, quantity: 1 },
            ]
          : [],
      );
      if (items.length === 0) return;

      try {
        const preview = await instance.PricePreview({
          items,
          ...(country ? { address: { countryCode: country } } : {}),
        });
        if (!active) return;
        const map: PriceMap = {};
        for (const lineItem of preview.data.details.lineItems) {
          map[lineItem.price.id] = lineItem.formattedTotals.total;
        }
        setPriceMap(map);
      } catch (err) {
        console.error(
          err instanceof Error ? err.message : "Paddle PricePreview failed.",
        );
        // Keep priceMap empty → static prices remain shown; checkout still works.
      }
    })();

    return () => {
      active = false;
    };
  }, [country]);

  const proTier = PRICING_TIERS.find(t => t.id === "pro");
  const proPriceId = proTier?.paddlePriceIds
    ? yearly
      ? proTier.paddlePriceIds.year
      : proTier.paddlePriceIds.month
    : undefined;
  const canCheckoutPro = !!paddle && !!proPriceId;

  return (
    <div className="lp min-h-screen antialiased" style={{ background: "var(--bg)", color: "var(--text)" }}>
      {/* ══ NAV ══ */}
      <nav
        className="sticky top-0 z-50 border-b backdrop-blur-md"
        style={{ background: "rgba(8,14,11,0.9)", borderColor: "rgba(255,255,255,0.07)" }}
      >
        <div className="max-w-[1240px] mx-auto px-5 h-[60px] flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <BrandLogo size={28} />
            <span className="font-black text-white tracking-tight text-[17px]">VibePin</span>
          </Link>
          <div className="hidden md:flex items-center gap-6 text-[13px] font-medium" style={{ color: "#9097A0" }}>
            <Link href="/#create" className="hover:text-white transition-colors">How it works</Link>
            <Link href="/app/products?demo=true" className="hover:text-white transition-colors">Product Opportunities</Link>
            <span className="text-white font-semibold">Pricing</span>
          </div>
          <div className="flex items-center gap-2.5">
            <Link
              href="/login?next=/pricing"
              className="hidden sm:inline text-[13px] font-medium border rounded-full px-4 py-1.5 transition-colors hover:text-white"
              style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.12)" }}
            >
              Log in
            </Link>
            <Link href="/app/discover?demo=true" className={`${VibeBtn} px-4 py-2 text-[13px] flex items-center gap-1.5`}>
              Get started <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </nav>

      {/* ══ HERO + CARDS ══ */}
      <section className="relative pt-16 pb-16 lg:pt-20 overflow-hidden">
        <div
          className="pointer-events-none absolute -top-32 right-[-8%] h-[460px] w-[460px] rounded-full blur-3xl"
          style={{ background: "radial-gradient(circle, rgba(217,70,239,0.14), transparent 70%)" }}
        />
        <div className={`${CONTAINER} relative`}>
          <div className="text-center max-w-[760px] mx-auto mb-12">
            <SectionLabel>PRICING</SectionLabel>
            <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-[1.08] mb-4">
              Simple pricing for{" "}
              <GradientText>
                product discovery, AI content creation, and multi-platform publishing.
              </GradientText>
            </h1>
            <p className="text-[15px] leading-relaxed mb-7" style={{ color: "#8B93A1" }}>
              Start free. Upgrade when you need more AI generation, more scheduled posts, and more
              accounts per platform.
            </p>
            <BillingToggle yearly={yearly} onChange={setYearly} />
          </div>

          <div className="mb-6">
            <PlanCards yearly={yearly} paddle={paddle} priceMap={priceMap} email={email} userId={userId} />
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mb-8">
            {PRICING_REASSURANCE.map(t => (
              <span key={t} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#6B7280" }}>
                <Check className="w-3 h-3 shrink-0" style={{ color: "#10B981" }} />
                {t}
              </span>
            ))}
          </div>

          <EnterpriseBanner />
        </div>
      </section>

      {/* ══ COMPARISON TABLE ══ */}
      <section className="py-16 lg:py-20 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className={CONTAINER}>
          <div className="text-center max-w-[720px] mx-auto mb-10">
            <SectionLabel>COMPARE PLANS</SectionLabel>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.08] mb-4">
              Everything in every plan, <GradientText>side by side.</GradientText>
            </h2>
            <p className="text-[14px] leading-relaxed" style={{ color: "#8B93A1" }}>
              Discover high-save products, trending Pins, and keyword ideas. Generate content with
              AI. Publish to Pinterest, Instagram, TikTok, and Facebook.
            </p>
          </div>
          <ComparisonTable />
          <p className="text-[12px] leading-relaxed text-center max-w-[640px] mx-auto mt-5" style={{ color: "#6B7280" }}>
            {ACCOUNTS_HELPER_TEXT}
          </p>
        </div>
      </section>

      {/* ══ FAQ ══ */}
      <section className="py-16 lg:py-20 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className={CONTAINER}>
          <div className="grid lg:grid-cols-[35%_1fr] gap-10 lg:gap-16 items-start">
            <div>
              <SectionLabel>PRICING FAQ</SectionLabel>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.08] mb-4">
                Questions about <GradientText>plans and limits.</GradientText>
              </h2>
              <p className="text-[14px] leading-relaxed mb-6" style={{ color: "#8B93A1" }}>
                How AI image credits, scheduled posts, accounts per platform, and discovery
                features work across plans.
              </p>
              <Link
                href="mailto:support@vibepin.co"
                className="inline-flex items-center gap-1.5 text-[13px] font-bold transition-opacity hover:opacity-80"
                style={{ color: "#E879F9" }}
              >
                Contact support <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
            <div className="space-y-2.5">
              {PRICING_FAQ.map((item, i) => (
                <FaqAccordionItem
                  key={item.question}
                  question={item.question}
                  answer={item.answer}
                  defaultOpen={i === 0}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══ FINAL CTA ══ */}
      <section className="py-16 lg:py-20 border-t text-center" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className={CONTAINER}>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.08] mb-4">
            Create more content. <GradientText>Publish everywhere.</GradientText>
          </h2>
          <p className="text-[14px] leading-relaxed max-w-[560px] mx-auto mb-8" style={{ color: "#8B93A1" }}>
            Discover products and Pin ideas, generate content with AI, and publish to Pinterest,
            Instagram, TikTok, and Facebook.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/app/discover?demo=true" className={`${VibeBtn} px-8 py-3.5 text-[14px] flex items-center gap-2`}>
              Get started free <ArrowRight className="w-4 h-4" />
            </Link>
            {canCheckoutPro && paddle && proPriceId ? (
              <button
                type="button"
                onClick={() => openCheckout(paddle, proPriceId, email, userId)}
                className="rounded-full border px-8 py-3.5 text-[14px] font-semibold transition-colors hover:text-white hover:border-white/30"
                style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.14)" }}
              >
                Start Pro
              </button>
            ) : (
              <Link
                href="/signup?plan=pro&next=/pricing"
                className="rounded-full border px-8 py-3.5 text-[14px] font-semibold transition-colors hover:text-white hover:border-white/30"
                style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.14)" }}
              >
                Start Pro
              </Link>
            )}
          </div>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
