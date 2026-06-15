"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Sparkles, ArrowRight, Check, ShoppingBag, Bookmark, Wand2, Search,
  CalendarDays, Plus, Link2, X, Layers,
} from "lucide-react";
import { pickByCategory, take, type LandingAsset } from "@/lib/landingAssets";

const VibeBtn = "btn-cta rounded-full font-bold text-white transition-transform hover:scale-[1.03] active:scale-100";

const CREATE_STEPS = [
  { icon: ShoppingBag, title: "Add products",                    desc: "Bring in the products or items you want to feature." },
  { icon: Bookmark,    title: "Add references",                  desc: "Use high-performing Pins as visual direction." },
  { icon: Sparkles,    title: "AI creative direction",           desc: "Guide the visual style, angle, composition, and mood." },
  { icon: Wand2,       title: "Generate Pinterest-native drafts", desc: "Turn the selected inputs into multiple ready-to-use Pins." },
];
const AI_CHIPS = ["Cozy room scene", "Lifestyle shot", "Natural light", "Earth tones", "Minimal decor"];
const PROMPT = "Create a Pinterest-native lifestyle image featuring this vase in a cozy boho living room. Warm natural light, neutral tones, textured materials, minimal styling.";
const WORKFLOW = [
  { n: 1, icon: Search,       accent: "#FF4D8D", title: "Discover the opportunity",    desc: "Use demand, Pin evidence, and product signals to identify what's worth creating." },
  { n: 2, icon: Sparkles,     accent: "#A855F7", title: "Create around proven demand", desc: "Generate drafts with products, references, and creative direction already attached." },
  { n: 3, icon: CalendarDays, accent: "#38BDF8", title: "Plan your week",              desc: "Move the best Pins into a schedule and organize your content week." },
];
const SUMMARY = [
  { icon: Sparkles, v: "7", l: "Pins generated",      c: "#E879F9" },
  { icon: CalendarDays, v: "5", l: "Scheduled",        c: "#38BDF8" },
  { icon: Link2,    v: "3", l: "Product links added",  c: "#FB7185" },
  { icon: Layers,   v: "2", l: "Opportunities covered", c: "#A855F7" },
];
const LEGEND: [string, string][] = [["Ready", "#10B981"], ["Need details", "#F59E0B"], ["Unscheduled", "#6B7280"], ["Posted", "#A855F7"]];

function AssetImg({ asset, label }: { asset?: LandingAsset; label?: string }) {
  if (asset?.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.imageUrl} alt={asset.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />;
  }
  return <div className="absolute inset-0 flex items-center justify-center text-[7px] font-semibold uppercase tracking-wide" style={{ background: "linear-gradient(135deg,#141622,#0b0d15)", color: "#2A2F3E" }}>{label ?? "VibePin"}</div>;
}

// ── Create Pins showcase ──────────────────────────────────────────────────────
function CreatePinsFeature({ product, refs, outputs }: { product?: LandingAsset; refs: LandingAsset[]; outputs: LandingAsset[] }) {
  const [sel, setSel] = useState(-1);
  return (
    <div className="grid lg:grid-cols-[minmax(0,30%)_minmax(0,70%)] gap-8 lg:gap-10 items-start">
      {/* text */}
      <div className="lg:pt-4">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] mb-3" style={{ color: "#FF4D8D" }}>Create</p>
        <h3 className="text-3xl font-black text-white tracking-tight mb-4 leading-[1.1]">Turn an opportunity into<br /><span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 60%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>Pinterest-native Pins.</span></h3>
        <p className="text-[14px] leading-relaxed mb-6" style={{ color: "#8B93A1" }}>Bring products, Pin references, and creative direction into one workspace—so every draft starts with real signal, not a blank prompt.</p>
        <ul className="space-y-4 mb-7">
          {CREATE_STEPS.map((s, i) => (
            <li key={s.title} className="flex items-start gap-3">
              <span className="relative shrink-0 h-9 w-9 rounded-xl flex items-center justify-center" style={{ background: "rgba(217,70,239,0.12)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.20)" }}>
                <s.icon className="w-4 h-4" />
                <span className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full flex items-center justify-center text-[9px] font-black text-white" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}>{i + 1}</span>
              </span>
              <div><p className="text-[13px] font-bold text-white">{s.title}</p><p className="text-[12px] leading-snug" style={{ color: "#8B93A1" }}>{s.desc}</p></div>
            </li>
          ))}
        </ul>
        <Link href="/app/studio?demo=true" className={`${VibeBtn} inline-flex items-center gap-2 px-6 py-3 text-[13px]`}>Start creating Pins <ArrowRight className="w-4 h-4" /></Link>
      </div>

      {/* Create Pins preview */}
      <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)", boxShadow: "0 24px 70px rgba(0,0,0,0.30)" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A0E16" }}>
          <span className="text-[14px] font-black text-white">Create Pins</span>
          <div className="flex items-center gap-2 text-[10px] font-semibold" style={{ color: "#6B7280" }}><span className="rounded-md px-2 py-1" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>Save draft</span><span className="rounded-md px-2 py-1" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>History</span></div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[230px_1fr]">
          {/* input panel */}
          <div className="p-4 lg:border-r" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
            <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>Products <span style={{ color: "#4B5563" }}>(1)</span></p>
            <div className="flex items-center gap-2 rounded-lg p-1.5 mb-2" style={{ background: "#0A0E16", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="relative rounded-md overflow-hidden shrink-0" style={{ width: 36, height: 36 }}><AssetImg asset={product} label="Vase" /></div>
              <div className="flex-1 min-w-0"><p className="text-[11px] font-bold text-white truncate">Ceramic Stone Vase</p><p className="text-[9px]" style={{ color: "#6B7280" }}>Neutral Beige</p></div>
              <X className="w-3.5 h-3.5 shrink-0" style={{ color: "#4B5563" }} />
            </div>
            <div className="rounded-lg py-1.5 text-center text-[10px] font-semibold mb-4" style={{ border: "1px dashed rgba(255,255,255,0.14)", color: "#6B7280" }}>+ Add product images</div>

            <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>References <span style={{ color: "#4B5563" }}>(3)</span></p>
            <div className="grid grid-cols-3 gap-1.5 mb-2">{refs.slice(0, 3).map((a, i) => <div key={i} className="relative rounded-md overflow-hidden" style={{ aspectRatio: "1/1" }}><AssetImg asset={a} label="Ref" /></div>)}</div>
            <div className="rounded-lg py-1.5 text-center text-[10px] font-semibold mb-4" style={{ border: "1px dashed rgba(255,255,255,0.14)", color: "#6B7280" }}>+ Add pin references</div>

            <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>Prompt</p>
            <div className="rounded-lg px-2.5 py-2 mb-4 text-[10px] leading-relaxed" style={{ background: "#0A0E16", border: "1px solid rgba(255,255,255,0.08)", color: "#8B93A1" }}>{PROMPT}<span className="block text-right mt-1 text-[8px]" style={{ color: "#374151" }}>162 / 1200</span></div>

            <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>AI Direction <span style={{ color: "#4B5563" }}>(Style &amp; Composition)</span></p>
            <div className="flex flex-wrap gap-1.5 mb-4">{AI_CHIPS.map(c => <span key={c} className="rounded-full px-2 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(217,70,239,0.12)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.22)" }}>{c}</span>)}<span className="rounded-full h-5 w-5 flex items-center justify-center text-[11px]" style={{ background: "rgba(255,255,255,0.05)", color: "#6B7280" }}>+</span></div>

            <button type="button" className={`${VibeBtn} w-full py-2.5 text-[12px] flex items-center justify-center gap-1.5`}><Sparkles className="w-3.5 h-3.5" /> Generate 7 Pins</button>
          </div>

          {/* generated outputs */}
          <div className="p-4">
            <div className="flex items-center gap-4 mb-3 text-[11px] font-semibold border-b pb-2 overflow-x-auto no-scrollbar" style={{ borderColor: "rgba(255,255,255,0.06)", scrollbarWidth: "none" }}>
              {["All", "Generating", "Completed", "Failed", "Added to Plan"].map((t, i) => <span key={t} className="whitespace-nowrap pb-2" style={i === 0 ? { color: "#fff", borderBottom: "2px solid #E879F9" } : { color: "#4B5563" }}>{t}</span>)}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {outputs.slice(0, 7).map((a, i) => (
                <button type="button" key={i} onClick={() => setSel(i === sel ? -1 : i)} className="text-left relative rounded-xl overflow-hidden transition-transform hover:-translate-y-0.5" style={{ aspectRatio: "2/3", border: i === sel ? "1px solid rgba(217,70,239,0.6)" : "1px solid rgba(255,255,255,0.08)" }}>
                  <AssetImg asset={a} label="Generated" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/30" />
                  <span className="absolute top-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[7px] font-bold flex items-center gap-1" style={{ background: "rgba(8,12,18,0.8)", color: i === sel ? "#10B981" : "#9097A0" }}><span className="h-1 w-1 rounded-full" style={{ background: i === sel ? "#10B981" : "#6B7280" }} />{i === sel ? "Added to plan" : "Not planned"}</span>
                  <span className="absolute bottom-1.5 left-1.5 right-1.5 text-[7px] font-semibold" style={{ color: "#C8CDD6" }}>{i + 1} of 7 · 2:3 · GPT Image</span>
                </button>
              ))}
              <div className="rounded-xl flex flex-col items-center justify-center gap-1 text-center" style={{ aspectRatio: "2/3", border: "1px dashed rgba(255,255,255,0.14)", color: "#6B7280" }}><Plus className="w-4 h-4" /><span className="text-[8px] font-semibold px-2">Generate more variations</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Workflow strip ────────────────────────────────────────────────────────────
function WorkflowStrip() {
  return (
    <div className="rounded-2xl border p-5 sm:p-6" style={{ background: "linear-gradient(135deg,#0C1018,#100B1A)", borderColor: "rgba(255,255,255,0.09)" }}>
      <div className="grid sm:grid-cols-3 gap-5 sm:gap-3 relative">
        {WORKFLOW.map((s, i) => (
          <div key={s.n} className="relative flex items-start gap-3 group/step">
            {i < WORKFLOW.length - 1 && <span className="hidden sm:block absolute top-4 left-[calc(100%-8px)] w-[calc(100%-2.5rem)] border-t border-dashed z-0" style={{ borderColor: "rgba(255,255,255,0.12)" }} />}
            <span className="relative z-10 h-9 w-9 rounded-xl flex items-center justify-center shrink-0 transition-shadow" style={{ background: `${s.accent}1A`, color: s.accent, border: `1px solid ${s.accent}33` }}><s.icon className="w-4 h-4" /></span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1"><span className="h-4 w-4 rounded-full flex items-center justify-center text-[9px] font-black text-white" style={{ background: s.accent }}>{s.n}</span><p className="text-[13px] font-bold text-white">{s.title}</p></div>
              <p className="text-[11px] leading-snug" style={{ color: "#8B93A1" }}>{s.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Weekly plan showcase ──────────────────────────────────────────────────────
function WeeklyPlanFeature({ pins }: { pins: LandingAsset[] }) {
  const days = [
    { day: "Mon", date: "Jun 14", items: [] as number[] },
    { day: "Tue", date: "Jun 15", items: [0, 1] },
    { day: "Wed", date: "Jun 16", items: [2, 3] },
    { day: "Thu", date: "Jun 17", items: [4] },
    { day: "Fri", date: "Jun 18", items: [5] },
    { day: "Sat", date: "Jun 19", items: [6] },
    { day: "Sun", date: "Jun 20", items: [] as number[] },
  ];
  return (
    <div className="grid lg:grid-cols-[minmax(0,30%)_minmax(0,70%)] gap-8 lg:gap-10 items-start">
      {/* text */}
      <div className="lg:pt-4">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] mb-3" style={{ color: "#38BDF8" }}>Plan</p>
        <h3 className="text-3xl font-black text-white tracking-tight mb-4 leading-[1.1]">Your Pinterest week,<br /><span style={{ background: "linear-gradient(100deg,#38BDF8,#818CF8 55%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>ready to go.</span></h3>
        <p className="text-[14px] leading-relaxed mb-5" style={{ color: "#8B93A1" }}>Review the drafts you want to publish, add product links, and organize your next seven days of Pinterest content in one plan.</p>
        <div className="grid grid-cols-2 gap-2.5 mb-6">
          {SUMMARY.map(s => (
            <div key={s.l} className="rounded-xl p-3" style={{ background: "#0C1018", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="flex items-center gap-1.5 mb-1"><s.icon className="w-3.5 h-3.5" style={{ color: s.c }} /><span className="text-xl font-black text-white leading-none">{s.v}</span></div>
              <p className="text-[10px]" style={{ color: "#8B93A1" }}>{s.l}</p>
            </div>
          ))}
        </div>
        <Link href="/app/plan?demo=true" className={`${VibeBtn} inline-flex items-center gap-2 px-6 py-3 text-[13px] mb-3`}>Build my weekly plan <ArrowRight className="w-4 h-4" /></Link>
        <p className="flex items-center gap-1.5 text-[11px]" style={{ color: "#6B7280" }}><Check className="w-3.5 h-3.5" style={{ color: "#10B981" }} /> Everything in one place. Always on track.</p>
      </div>

      {/* Weekly plan preview */}
      <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)", boxShadow: "0 24px 70px rgba(0,0,0,0.30)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A0E16" }}>
          <div className="flex items-center gap-2.5">
            <div><p className="text-[14px] font-black text-white">Weekly Plan</p><p className="text-[9px]" style={{ color: "#6B7280" }}>Week of Jun 14 – Jun 20, 2026</p></div>
            <span className="rounded-md px-2 py-1 text-[10px] font-semibold flex items-center gap-1" style={{ background: "rgba(217,70,239,0.12)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.22)" }}>🏠 Home Decor ▾</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold" style={{ color: "#9097A0" }}><span className="rounded-md px-2 py-1" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>Today</span><span className="rounded-md px-2 py-1" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>Week ▾</span></div>
        </div>
        <div className="overflow-x-auto">
          <div className="grid min-w-[760px]" style={{ gridTemplateColumns: "repeat(7,1fr)", gap: "1px", background: "rgba(255,255,255,0.05)" }}>
            {days.map((d, di) => (
              <div key={d.day} className="p-2" style={{ background: "#0C1018" }}>
                <p className="text-[9px] font-bold" style={{ color: di === 1 ? "#E879F9" : "#6B7280" }}>{d.day}</p>
                <p className="text-[11px] font-black text-white mb-2">{d.date}</p>
                {d.items.length === 0 ? (
                  <div className="rounded-lg flex flex-col items-center justify-center gap-1 py-6" style={{ border: "1px dashed rgba(255,255,255,0.10)" }}>
                    <span className="text-[8px]" style={{ color: "#4B5563" }}>No Pins planned</span>
                    <span className="text-[8px] font-bold" style={{ color: "#E879F9" }}>+ Add Pin</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {d.items.map(idx => (
                      <div key={idx} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "4/5" }}>
                        <AssetImg asset={pins[idx]} label="Pin" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                        <span className="absolute bottom-1 left-1 right-1 flex items-center justify-between">
                          <span className="rounded px-1.5 py-0.5 text-[7px] font-bold" style={{ background: "rgba(16,185,129,0.9)", color: "#04140d" }}>Ready</span>
                          <Link2 className="w-2.5 h-2.5 text-white" />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A0E16" }}>
          {LEGEND.map(([l, c]) => <span key={l} className="flex items-center gap-1.5 text-[9px]" style={{ color: "#6B7280" }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />{l}</span>)}
        </div>
      </div>
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────
export default function ExecutionSystem({ pinSamples, products }: { pinSamples: LandingAsset[]; products: LandingAsset[] }) {
  const pool = pickByCategory(pinSamples, "Home Decor", 7, "Pin");
  const product = products.find(p => p.category === "Home Decor") ?? products[0];
  const refs = take(pinSamples, 3, "Reference", 7);

  return (
    <section className="py-24 lg:py-28 border-t relative overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className="pointer-events-none absolute inset-x-0 top-10 h-72 blur-3xl" style={{ background: "radial-gradient(ellipse at 50% 20%, rgba(217,70,239,0.10), transparent 68%)" }} />
      <div className="max-w-[1280px] mx-auto px-6 lg:px-8 relative">
        {/* Header */}
        <div className="text-center max-w-[760px] mx-auto mb-14">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] mb-4" style={{ color: "#A855F7" }}>Execution System</p>
          <h2 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-[1.05] mb-5">Create around proven demand.<br /><span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 60%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>Plan your week with confidence.</span></h2>
          <p className="text-[14px] sm:text-[15px] leading-relaxed" style={{ color: "#8B93A1" }}>VibePin brings products, references, and creative direction into one generation workflow—then turns the best outputs into a weekly Pinterest plan.</p>
        </div>

        <div className="mb-10"><CreatePinsFeature product={product} refs={refs} outputs={pool} /></div>
        <div className="mb-10"><WorkflowStrip /></div>
        <div><WeeklyPlanFeature pins={pool} /></div>
      </div>
    </section>
  );
}
