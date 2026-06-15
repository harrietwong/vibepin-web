import Link from "next/link";
import { ArrowRight, Bookmark, CalendarDays, Check, Sparkles, TrendingUp, Wand2 } from "lucide-react";
import { FINAL_CTA_TRUST } from "@/lib/landing/conversionData";
import { CONTAINER, GradientText } from "./shared";

function CtaPreview() {
  return (
    <div className="relative hidden lg:block w-full max-w-[380px] ml-auto" aria-hidden>
      <div
        className="absolute -top-4 right-8 rounded-xl border p-3 w-[140px] rotate-3"
        style={{ background: "#0A0E16", borderColor: "rgba(168,85,247,0.25)", boxShadow: "0 16px 48px rgba(0,0,0,0.35)" }}
      >
        <div className="flex items-center gap-1.5 mb-2">
          <TrendingUp className="w-3 h-3" style={{ color: "#A855F7" }} />
          <span className="text-[8px] font-bold uppercase" style={{ color: "#6B7280" }}>Opportunity</span>
        </div>
        <div className="h-1.5 rounded-full w-full mb-1" style={{ background: "rgba(168,85,247,0.25)" }} />
        <p className="text-[9px] font-semibold text-white">Boho Living Room</p>
        <p className="text-[8px]" style={{ color: "#10B981" }}>Score 94</p>
      </div>
      <div
        className="absolute top-12 left-0 rounded-xl border p-2 w-[110px] -rotate-6"
        style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.08)" }}
      >
        <div className="grid grid-cols-2 gap-1">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="rounded-md" style={{ aspectRatio: "2/3", background: "rgba(217,70,239,0.12)" }} />
          ))}
        </div>
        <div className="flex items-center gap-1 mt-1.5">
          <Wand2 className="w-2.5 h-2.5" style={{ color: "#FF4D8D" }} />
          <span className="text-[7px] font-semibold" style={{ color: "#6B7280" }}>7 Pins</span>
        </div>
      </div>
      <div
        className="relative mt-16 rounded-xl border p-3"
        style={{ background: "linear-gradient(135deg,#120E1E,#0A0E16)", borderColor: "rgba(217,70,239,0.22)" }}
      >
        <div className="flex items-center gap-2 mb-2">
          <CalendarDays className="w-3.5 h-3.5" style={{ color: "#38BDF8" }} />
          <span className="text-[9px] font-bold text-white">Weekly Plan</span>
          <span
            className="ml-auto rounded-full px-2 py-0.5 text-[7px] font-bold flex items-center gap-0.5"
            style={{ background: "rgba(16,185,129,0.15)", color: "#10B981" }}
          >
            <Sparkles className="w-2 h-2" /> Scheduled
          </span>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <div key={`${d}-${i}`} className="text-center">
              <p className="text-[6px] mb-0.5" style={{ color: "#4B5563" }}>{d}</p>
              <div
                className="rounded"
                style={{
                  aspectRatio: "2/3",
                  background: i < 5 ? "rgba(217,70,239,0.18)" : "rgba(255,255,255,0.04)",
                  border: i === 4 ? "1px solid rgba(16,185,129,0.4)" : "1px solid transparent",
                }}
              />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 mt-2">
          <Bookmark className="w-2.5 h-2.5" style={{ color: "#E879F9" }} />
          <span className="text-[7px]" style={{ color: "#6B7280" }}>Pin Evidence → Auto-Publish</span>
        </div>
      </div>
    </div>
  );
}

export function FinalConversionCTA() {
  return (
    <section className="py-24 lg:py-32 relative overflow-hidden border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className={CONTAINER}>
        <div
          className="relative rounded-3xl border overflow-hidden p-8 sm:p-10 lg:p-12 grid lg:grid-cols-[1fr_minmax(0,400px)] gap-10 items-center"
          style={{
            background: "linear-gradient(135deg,#1A0B2E 0%,#12081F 40%,#0E1018 100%)",
            borderColor: "rgba(168,85,247,0.30)",
            boxShadow: "0 32px 100px rgba(124,58,237,0.18)",
          }}
        >
          <div
            className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full blur-3xl"
            style={{ background: "radial-gradient(circle, rgba(217,70,239,0.25), transparent 70%)" }}
          />
          <div className="relative">
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.08] mb-4">
              Ready to turn Pinterest signals into{" "}
              <GradientText>your next week of content?</GradientText>
            </h2>
            <p className="text-[15px] leading-relaxed mb-8 max-w-[520px]" style={{ color: "#8B93A1" }}>
              Find an opportunity, generate 7 Pinterest-native Pins, build your weekly plan, and
              auto-publish on schedule—all in one workflow.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mb-6">
              <Link
                href="/app/discover?demo=true"
                className="flex items-center justify-center gap-2 rounded-full px-8 py-4 text-[15px] font-bold transition-transform hover:scale-[1.03] active:scale-100"
                style={{ background: "#fff", color: "#1A0B2E" }}
              >
                Build my next 7 Pins <ArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="#create"
                className="flex items-center justify-center gap-2 rounded-full border px-8 py-4 text-[15px] font-bold transition-colors hover:text-white hover:border-white/30"
                style={{ borderColor: "rgba(255,255,255,0.20)", color: "#C8CDD6" }}
              >
                Explore this week&apos;s opportunities
              </a>
            </div>
            <div className="flex flex-col sm:flex-row flex-wrap gap-x-6 gap-y-2">
              {FINAL_CTA_TRUST.map(t => (
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
          <CtaPreview />
        </div>
      </div>
    </section>
  );
}
