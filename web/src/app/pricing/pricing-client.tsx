"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { ArrowRight, Check, Minus } from "lucide-react";
import BrandLogo from "@/components/BrandLogo";
import {
  ACCOUNTS_HELPER_TEXT,
  COMPARISON_SECTIONS,
  ENTERPRISE_PLAN,
  PRICING_FAQ,
  PRICING_REASSURANCE,
  PRICING_TIERS,
  type PlanKey,
} from "@/lib/pricingPlans";
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

/** Only the paid tiers can be purchased; free routes to signup. */
type PaidPlan = Exclude<PlanKey, "free">;
const PAID_PLANS: readonly PaidPlan[] = ["starter", "pro", "business"];
function isPaidPlan(id: PlanKey): id is PaidPlan {
  return (PAID_PLANS as readonly PlanKey[]).includes(id);
}

/** Thrown when checkout is deliberately turned off (CREEM_MODE=disabled → 503). */
class BillingDisabledError extends Error {
  constructor() {
    super("billing_disabled");
    this.name = "BillingDisabledError";
  }
}

/**
 * Start an authenticated Creem checkout for the signed-in buyer. Resolves to the
 * hosted checkout URL. Throws BillingDisabledError when checkout is turned off
 * (503 billing_disabled → the CTA shows a "coming soon" state), or a plain Error
 * on any other failure so the caller can surface the retryable banner.
 */
async function startCreemCheckout(plan: PaidPlan, interval: "month" | "year"): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch("/api/billing/creem/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ plan, interval }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 503 && err.error === "billing_disabled") {
      throw new BillingDisabledError();
    }
    throw new Error(`checkout endpoint returned ${res.status}`);
  }
  const json = (await res.json()) as { url?: string };
  if (!json.url) throw new Error("checkout endpoint returned no url");
  return json.url;
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
  onPlanCta,
  selectedPlanId,
  pendingPlanId,
  billingEnabled,
}: {
  yearly: boolean;
  onPlanCta: (planId: PlanKey) => void;
  selectedPlanId: PlanKey | null;
  pendingPlanId: PlanKey | null;
  billingEnabled: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch">
      {PRICING_TIERS.map(plan => {
        // Static USD prices from pricingPlans (single source of truth).
        const staticPrice = yearly ? plan.priceYearly : plan.priceMonthly;
        const isSelected = selectedPlanId === plan.id;
        const purchasable = isPaidPlan(plan.id);

        return (
          <div
            key={plan.id}
            className="relative flex flex-col rounded-2xl p-6 transition-transform hover:-translate-y-1"
            style={
              isSelected
                ? {
                    background:
                      "linear-gradient(180deg,rgba(124,58,237,0.14),rgba(217,70,239,0.05))",
                    border: "1px solid rgba(232,121,249,0.65)",
                    boxShadow: "0 0 0 1px rgba(232,121,249,0.35), 0 0 40px rgba(168,85,247,0.16)",
                  }
                : plan.highlighted
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

            {purchasable && !billingEnabled ? (
              // Checkout is turned off (CREEM_MODE=disabled): show the disabled
              // "Coming soon" state at FIRST paint so neither anonymous nor
              // signed-in visitors are routed through signup only to hit a 503.
              <button
                type="button"
                disabled
                aria-disabled="true"
                className={`w-full rounded-full py-3 text-[13px] font-bold text-center opacity-60 cursor-not-allowed ${
                  plan.highlighted ? VibeBtn : "border"
                }`}
                style={
                  plan.highlighted ? {} : { borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }
                }
              >
                Coming soon
              </button>
            ) : purchasable ? (
              <button
                type="button"
                onClick={() => onPlanCta(plan.id)}
                disabled={pendingPlanId === plan.id}
                className={`w-full rounded-full py-3 text-[13px] font-bold text-center transition-all disabled:opacity-60 disabled:cursor-wait ${
                  plan.highlighted ? VibeBtn : "border hover:text-white hover:border-white/30"
                }`}
                style={
                  plan.highlighted ? {} : { borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }
                }
              >
                {pendingPlanId === plan.id ? "Loading…" : plan.cta}
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

function PricingPageContent({ billingEnabled }: { billingEnabled: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [yearly, setYearly] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<PlanKey | null>(null);
  const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);
  // Checkout deliberately turned off (CREEM_MODE=disabled) — a distinct, calmer
  // "coming soon" state rather than the retryable "temporarily unavailable" banner.
  const [checkoutComingSoon, setCheckoutComingSoon] = useState(false);
  // The plan a signed-in buyer is currently launching checkout for (button spinner).
  const [pendingPlanId, setPendingPlanId] = useState<PlanKey | null>(null);
  // A CTA click that arrived before auth resolved. Consumed by the effect below
  // the instant `authReady` catches up.
  const [pendingIntent, setPendingIntent] = useState<{ planId: PaidPlan } | null>(null);

  // Resolve the session so we know whether to checkout directly or route through
  // signup. `authReady` distinguishes "still loading" from "confirmed logged out".
  useEffect(() => {
    let active = true;
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (active) setUserId(data.user?.id ?? null);
      })
      .catch(() => {
        /* anonymous visitor — ignore */
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Launch a signed-in buyer's checkout. On any failure, surface the retryable
  // banner (never leave a dead button).
  const launchCheckout = useCallback(
    async (planId: PaidPlan) => {
      setPendingPlanId(planId);
      setCheckoutUnavailable(false);
      setCheckoutComingSoon(false);
      const interval = yearly ? "year" : "month";
      try {
        const url = await startCreemCheckout(planId, interval);
        window.location.assign(url);
        // Navigation follows — keep the spinner until the page unloads.
      } catch (err) {
        console.error(err instanceof Error ? err.message : "checkout failed");
        setPendingPlanId(null);
        setSelectedPlanId(planId);
        if (err instanceof BillingDisabledError) {
          setCheckoutComingSoon(true);
        } else {
          setCheckoutUnavailable(true);
        }
      }
    },
    [yearly],
  );

  // Route a signed-out buyer to signup carrying plan + period so we can resume
  // checkout automatically once they return signed in.
  const routeToSignup = useCallback(
    (planId: PaidPlan) => {
      const period = yearly ? "year" : "month";
      const resumeNext = `/pricing?checkout=${encodeURIComponent(planId)}&period=${period}`;
      router.push(`/signup?plan=${encodeURIComponent(planId)}&next=${encodeURIComponent(resumeNext)}`);
    },
    [yearly, router],
  );

  // The single entry point for both the plan cards and the bottom Pro CTA.
  //  - auth still loading → record the intent + show a spinner; the effect below
  //    fires the instant auth resolves.
  //  - confirmed signed out → send to signup carrying the intended plan/period.
  //  - confirmed signed in → launch checkout directly.
  const handlePlanCta = useCallback(
    (planId: PlanKey) => {
      if (!isPaidPlan(planId)) return; // free routes via <Link>, never here
      // Billing turned off (CREEM_MODE=disabled): surface the calm "coming soon"
      // banner and go no further — never navigate to /signup, never call the
      // checkout endpoint. The buttons are already disabled; this is the
      // belt-and-braces guard for any programmatic caller.
      if (!billingEnabled) {
        setCheckoutComingSoon(true);
        return;
      }
      if (!authReady) {
        setPendingIntent({ planId });
        return;
      }
      if (userId) {
        void launchCheckout(planId);
      } else {
        routeToSignup(planId);
      }
    },
    [billingEnabled, authReady, userId, launchCheckout, routeToSignup],
  );

  // Consume a pending intent the instant auth resolves.
  useEffect(() => {
    if (!pendingIntent || !authReady) return;
    const { planId } = pendingIntent;
    setPendingIntent(null);
    if (userId) {
      void launchCheckout(planId);
    } else {
      routeToSignup(planId);
    }
  }, [pendingIntent, authReady, userId, launchCheckout, routeToSignup]);

  // Timeout fallback: if auth never resolves, don't spin forever — degrade to
  // the "unavailable" banner after a bounded wait.
  useEffect(() => {
    if (!pendingIntent) return;
    const planId = pendingIntent.planId;
    const timer = window.setTimeout(() => {
      setPendingIntent(null);
      setSelectedPlanId(planId);
      setCheckoutUnavailable(true);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [pendingIntent]);

  // Resume an intent-carrying return from signup/login:
  // `?checkout=<planId>&period=<month|year>`. Fire the checkout once, then clean
  // the URL. Mirrors the previous autoCheckoutFired logic, minus Paddle.
  const autoCheckoutFired = useRef(false);
  useEffect(() => {
    const checkoutPlanId = searchParams.get("checkout");
    if (!checkoutPlanId || autoCheckoutFired.current) return;
    // Billing turned off: a crafted `/pricing?checkout=pro` return must NOT
    // auto-open checkout. Show the "coming soon" banner and clean the URL.
    if (!billingEnabled) {
      autoCheckoutFired.current = true;
      setCheckoutComingSoon(true);
      router.replace("/pricing", { scroll: false });
      return;
    }
    // Wait for the auth signal — treating a still-loading session as "logged
    // out" would wrongly drop the intent.
    if (!authReady) return;

    const period = searchParams.get("period") === "year" ? "year" : "month";
    const plan = PRICING_TIERS.find(t => t.id === checkoutPlanId);

    if (!userId) {
      // Landed back here still not signed in (e.g. direct link) — nothing to
      // resume; leave the URL alone rather than silently discarding intent.
      return;
    }

    autoCheckoutFired.current = true;
    setYearly(period === "year");

    if (!plan || !isPaidPlan(plan.id)) {
      // Unknown / non-purchasable plan is a permanent condition — degrade.
      setSelectedPlanId((plan?.id as PlanKey | undefined) ?? (checkoutPlanId as PlanKey));
      setCheckoutUnavailable(true);
      router.replace("/pricing", { scroll: false });
      return;
    }

    void launchCheckout(plan.id);
    router.replace("/pricing", { scroll: false });
  }, [searchParams, billingEnabled, authReady, userId, launchCheckout, router]);

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
            <Link href="/app/products" className="hover:text-white transition-colors">Product Opportunities</Link>
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
            <Link href="/app/studio" className={`${VibeBtn} px-4 py-2 text-[13px] flex items-center gap-1.5`}>
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
          {checkoutComingSoon && (
            <div
              role="status"
              className="mb-8 rounded-xl border px-5 py-3.5 text-center text-[13px] font-medium"
              style={{
                background: "rgba(255,255,255,0.04)",
                borderColor: "rgba(255,255,255,0.14)",
                color: "#C8CDD6",
              }}
            >
              Paid plans are coming soon — checkout isn&apos;t open just yet. Want early
              access? {" "}
              <Link href="mailto:support@vibepin.co" className="underline hover:opacity-80">
                Contact us
              </Link>
              .
            </div>
          )}
          {checkoutUnavailable && (
            <div
              role="alert"
              className="mb-8 rounded-xl border px-5 py-3.5 text-center text-[13px] font-medium"
              style={{
                background: "rgba(217,70,239,0.08)",
                borderColor: "rgba(217,70,239,0.30)",
                color: "#E5C9F5",
              }}
            >
              Checkout is temporarily unavailable — please try again in a moment or{" "}
              <Link href="mailto:support@vibepin.co" className="underline hover:opacity-80">
                contact support
              </Link>
              . We&apos;ve kept your{" "}
              {selectedPlanId ? PRICING_TIERS.find(t => t.id === selectedPlanId)?.name ?? "plan" : "plan"}{" "}
              selection below — just click it again once ready.
            </div>
          )}
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
            <PlanCards
              yearly={yearly}
              onPlanCta={handlePlanCta}
              selectedPlanId={selectedPlanId}
              pendingPlanId={pendingPlanId ?? pendingIntent?.planId ?? null}
              billingEnabled={billingEnabled}
            />
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
            <Link href="/app/studio" className={`${VibeBtn} px-8 py-3.5 text-[14px] flex items-center gap-2`}>
              Get started free <ArrowRight className="w-4 h-4" />
            </Link>
            {!billingEnabled ? (
              // Same first-paint "coming soon" treatment as the paid cards.
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="rounded-full border px-8 py-3.5 text-[14px] font-semibold opacity-60 cursor-not-allowed"
                style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.14)" }}
              >
                Coming soon
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handlePlanCta("pro")}
                disabled={(pendingPlanId ?? pendingIntent?.planId) === "pro"}
                className="rounded-full border px-8 py-3.5 text-[14px] font-semibold transition-colors hover:text-white hover:border-white/30 disabled:opacity-60 disabled:cursor-wait"
                style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.14)" }}
              >
                {(pendingPlanId ?? pendingIntent?.planId) === "pro" ? "Loading…" : "Start Pro"}
              </button>
            )}
          </div>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}

export default function PricingPageClient({ billingEnabled }: { billingEnabled: boolean }) {
  return (
    <Suspense fallback={null}>
      <PricingPageContent billingEnabled={billingEnabled} />
    </Suspense>
  );
}
