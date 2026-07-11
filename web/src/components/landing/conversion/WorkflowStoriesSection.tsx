"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, TrendingUp } from "lucide-react";
import { TESTIMONIALS_ENABLED } from "@/lib/landing/conversionData";
import { pickByCategory, take, type LandingAsset } from "@/lib/landingAssets";
import { CONTAINER, GradientText, SECTION, SectionLabel, AssetImg } from "./shared";

// ── Types & data ──────────────────────────────────────────────────────────────
type Persona = "creators" | "sellers" | "affiliate" | "managers";
type Tab = "all" | Persona;
type Accent = "pink" | "green" | "purple" | "blue";

type Step =
  | { label: string; kind: "pins"; n: number; caption: string }
  | { label: string; kind: "calendar"; caption: string }
  | { label: string; kind: "stat"; title: string; value: string; sub: string; badge: string }
  | { label: string; kind: "product"; pIndex: number; name: string; sub: string; score: number; badge: string }
  | { label: string; kind: "compare"; rows: { name: string; score: number; comp: string }[] }
  | { label: string; kind: "status"; rows: { title: string; status: string; tone: "green" | "blue" | "neutral" }[] };

type Story = { id: Persona; tabLabel: string; eyebrow: string; headline: string; benefit: string; accent: Accent; steps: Step[] };

const ACCENT: Record<Accent, string> = { pink: "#E879F9", green: "#10B981", purple: "#C4B5FD", blue: "#38BDF8" };
const ORDER: Persona[] = ["creators", "sellers", "affiliate", "managers"];

const STORIES: Record<Persona, Story> = {
  creators: {
    id: "creators", tabLabel: "Creators", eyebrow: "CREATOR WORKFLOW", accent: "pink",
    headline: "Move from “What should I post?” to a complete weekly Pinterest plan without switching between research, design, scheduling, and publishing tools.",
    benefit: "Research, create, schedule, and publish in one connected workflow.",
    steps: [
      { label: "Pin Evidence", kind: "pins", n: 2, caption: "High save potential" },
      { label: "Create Pins", kind: "pins", n: 4, caption: "7 drafts generated" },
      { label: "Weekly Plan", kind: "calendar", caption: "5 scheduled" },
      { label: "Auto-Publish", kind: "status", rows: [{ title: "Boho Living Room", status: "Published", tone: "green" }, { title: "Summer Outfit", status: "Scheduled", tone: "blue" }, { title: "Product Roundup", status: "Review", tone: "neutral" }] },
    ],
  },
  sellers: {
    id: "sellers", tabLabel: "Sellers", eyebrow: "SELLER WORKFLOW", accent: "green",
    headline: "Connect Pinterest demand to your catalog and turn promising products into scheduled, product-aware campaigns.",
    benefit: "Demand-matched products, generated and scheduled in one place.",
    steps: [
      { label: "Demand Signal", kind: "stat", title: "Boho Home Decor", value: "+210%", sub: "Demand vs last 30 days", badge: "Rising" },
      { label: "Product Match", kind: "product", pIndex: 0, name: "Ceramic Stone Vase", sub: "Neutral Beige", score: 86, badge: "High Opportunity" },
      { label: "Product Pins", kind: "pins", n: 3, caption: "Product-aware Pins" },
      { label: "Publish", kind: "status", rows: [{ title: "Product Spotlight", status: "Published", tone: "green" }, { title: "Style Guide", status: "Scheduled", tone: "blue" }, { title: "Seasonal Collection", status: "Review", tone: "neutral" }] },
    ],
  },
  affiliate: {
    id: "affiliate", tabLabel: "Affiliate", eyebrow: "AFFILIATE WORKFLOW", accent: "purple",
    headline: "Compare product opportunities before creating, then turn the strongest offers into consistent Pinterest campaigns.",
    benefit: "Pick the strongest offers, then publish a steady campaign.",
    steps: [
      { label: "Opportunity", kind: "product", pIndex: 1, name: "Portable Blender", sub: "High-intent product", score: 84, badge: "High" },
      { label: "Compare Products", kind: "compare", rows: [{ name: "Portable Blender", score: 84, comp: "Low" }, { name: "Glass Tumbler Set", score: 78, comp: "Low" }, { name: "Matcha Whisk Kit", score: 71, comp: "Med" }] },
      { label: "Campaign", kind: "pins", n: 3, caption: "Promotional Pins" },
      { label: "Traffic", kind: "status", rows: [{ title: "Campaign", status: "Active", tone: "green" }, { title: "Pins", status: "Scheduled", tone: "blue" }, { title: "Destination link", status: "Connected", tone: "neutral" }] },
    ],
  },
  managers: {
    id: "managers", tabLabel: "Managers", eyebrow: "PINTEREST MANAGER WORKFLOW", accent: "blue",
    headline: "Research multiple directions, create Pins in batches, review campaigns, and publish across organized workflows.",
    benefit: "Run research, production, review, and publishing in one system.",
    steps: [
      { label: "Research", kind: "pins", n: 4, caption: "Multiple campaigns" },
      { label: "Batch Create", kind: "pins", n: 4, caption: "Batch drafts" },
      { label: "Review", kind: "status", rows: [{ title: "Boho Living Room", status: "Approved", tone: "green" }, { title: "Summer Outfit", status: "Needs edits", tone: "neutral" }, { title: "Gift Guide", status: "Review", tone: "blue" }] },
      { label: "Publish", kind: "status", rows: [{ title: "Campaign A", status: "Scheduled", tone: "blue" }, { title: "Campaign B", status: "Published", tone: "green" }, { title: "Campaign C", status: "Draft", tone: "neutral" }] },
    ],
  },
};

const TONES = { green: { c: "#10B981", bg: "rgba(16,185,129,0.16)" }, blue: { c: "#38BDF8", bg: "rgba(56,189,248,0.16)" }, neutral: { c: "#9097A0", bg: "rgba(148,151,160,0.16)" } };

// ── Step preview renderer ─────────────────────────────────────────────────────
function StepCard({ step, pins, products, offset }: { step: Step; pins: LandingAsset[]; products: LandingAsset[]; offset: number }) {
  return (
    <div className="rounded-xl border p-3" style={{ background: "#101624", borderColor: "rgba(255,255,255,0.10)" }}>
      <p className="text-[8px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>{step.label}</p>
      {step.kind === "pins" && (
        <>
          <div className={`grid gap-1 mb-2 ${step.n === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
            {pins.slice(offset, offset + step.n).map((a, i) => <div key={i} className="relative rounded-md overflow-hidden" style={{ aspectRatio: step.n === 4 ? "1/1" : "3/4" }}><AssetImg asset={a} label="Pin" /></div>)}
          </div>
          <span className="text-[7px] font-semibold" style={{ color: "#E879F9" }}>{step.caption}</span>
        </>
      )}
      {step.kind === "calendar" && (
        <>
          <div className="grid grid-cols-3 gap-1 mb-1">
            {["Mon", "Wed", "Fri"].map((d, i) => (
              <div key={d}><p className="text-[6px] text-center mb-0.5" style={{ color: "#4B5563" }}>{d}</p><div className="relative rounded-md overflow-hidden" style={{ aspectRatio: "3/4" }}><AssetImg asset={pins[offset + i] ?? pins[i]} label="Pin" /></div></div>
            ))}
          </div>
          <span className="text-[7px] font-semibold" style={{ color: "#38BDF8" }}>{step.caption}</span>
        </>
      )}
      {step.kind === "stat" && (
        <div>
          <p className="text-[10px] font-bold text-white leading-tight">{step.title}</p>
          <p className="text-[16px] font-black leading-none my-1" style={{ color: "#10B981", fontFamily: "'JetBrains Mono',monospace" }}>{step.value}</p>
          <p className="text-[7px] mb-1.5" style={{ color: "#6B7280" }}>{step.sub}</p>
          <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold" style={{ background: "rgba(16,185,129,0.16)", color: "#10B981" }}>● {step.badge}</span>
        </div>
      )}
      {step.kind === "product" && (
        <div className="flex items-center gap-2">
          <div className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 44, height: 44 }}><AssetImg asset={products[step.pIndex]} label="Product" /></div>
          <div className="min-w-0">
            <p className="text-[9px] font-bold text-white leading-tight truncate">{step.name}</p>
            <p className="text-[7px] mb-0.5" style={{ color: "#6B7280" }}>{step.sub}</p>
            <div className="flex items-center gap-1"><span className="text-[11px] font-black" style={{ color: "#10B981", fontFamily: "'JetBrains Mono',monospace" }}>{step.score}</span><span className="rounded-full px-1 py-0.5 text-[6px] font-bold" style={{ background: "rgba(16,185,129,0.16)", color: "#10B981" }}>{step.badge}</span></div>
          </div>
        </div>
      )}
      {step.kind === "compare" && (
        <div className="space-y-1.5">
          {step.rows.map(r => (
            <div key={r.name} className="flex items-center justify-between gap-1.5">
              <span className="text-[8px] font-semibold text-white truncate">{r.name}</span>
              <span className="flex items-center gap-1 shrink-0"><span className="text-[9px] font-black" style={{ color: "#10B981", fontFamily: "'JetBrains Mono',monospace" }}>{r.score}</span><span className="text-[6px]" style={{ color: "#6B7280" }}>{r.comp} comp</span></span>
            </div>
          ))}
        </div>
      )}
      {step.kind === "status" && (
        <div className="space-y-1.5">
          {step.rows.map(r => {
            const t = TONES[r.tone];
            return <div key={r.title} className="flex items-center justify-between gap-2"><span className="text-[8px] font-semibold text-white truncate">{r.title}</span><span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold shrink-0" style={{ background: t.bg, color: t.c }}>{r.status}</span></div>;
          })}
        </div>
      )}
    </div>
  );
}

function FeaturedCard({ story, pins, products, reduced }: { story: Story; pins: LandingAsset[]; products: LandingAsset[]; reduced: boolean }) {
  const accent = ACCENT[story.accent];
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (reduced) { setShown(true); return; }
    setShown(false);
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, [story.id, reduced]);
  const stepLabels = story.steps.map(s => s.label);
  return (
    <div
      role="tabpanel" id={`wf-panel-${story.id}`} aria-labelledby={`wf-tab-${story.id}`}
      className="rounded-2xl border p-6 sm:p-8 grid lg:grid-cols-[0.82fr_1.18fr] gap-8 items-center min-h-[430px] lg:min-h-[470px]"
      style={{ background: "linear-gradient(135deg,#0E1018,#120E1E)", borderColor: `${accent}3D`, boxShadow: "0 24px 80px rgba(0,0,0,0.22)", opacity: shown ? 1 : 0, transform: shown ? "none" : "translateX(8px)", transition: reduced ? "none" : "opacity .3s ease, transform .3s ease" }}
    >
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: accent }}>{story.eyebrow}</p>
        <p className="text-xl lg:text-2xl font-semibold text-white leading-relaxed mb-5">{story.headline}</p>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {stepLabels.map((s, i) => (
            <span key={s} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="w-3 h-3" style={{ color: "#4B5563" }} />}
              <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: i === stepLabels.length - 1 ? `${accent}26` : "rgba(255,255,255,0.05)", color: i === stepLabels.length - 1 ? accent : "#C8CDD6", border: "1px solid rgba(255,255,255,0.08)" }}>{s}</span>
            </span>
          ))}
        </div>
        <p className="text-[12px] font-bold" style={{ color: accent }}>{story.benefit}</p>
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
        {story.steps.map((s, i) => <StepCard key={s.label} step={s} pins={pins} products={products} offset={i * 2} />)}
      </div>
    </div>
  );
}

function AllOverview({ pins, products }: { pins: LandingAsset[]; products: LandingAsset[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-h-[430px] lg:min-h-[470px]" role="tabpanel" id="wf-panel-all" aria-labelledby="wf-tab-all">
      {ORDER.map((id, idx) => {
        const s = STORIES[id]; const accent = ACCENT[s.accent];
        return (
          <div key={id} className="rounded-2xl border p-5 flex flex-col" style={{ background: "linear-gradient(135deg,#0E1018,#120E1E)", borderColor: `${accent}33` }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-2" style={{ color: accent }}>{s.eyebrow}</p>
            <p className="text-[13px] font-semibold text-white leading-snug mb-3 flex-1">{s.headline}</p>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <StepCard step={s.steps[0]} pins={pins} products={products} offset={idx} />
              <StepCard step={s.steps[2]} pins={pins} products={products} offset={idx + 2} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {s.steps.map((st, i) => <span key={st.label} className="flex items-center gap-1.5">{i > 0 && <ArrowRight className="w-2.5 h-2.5" style={{ color: "#4B5563" }} />}<span className="text-[9px] font-semibold" style={{ color: "#C8CDD6" }}>{st.label}</span></span>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────
export function WorkflowStoriesSection({ pinSamples, products }: { pinSamples: LandingAsset[]; products: LandingAsset[] }) {
  const [tab, setTab] = useState<Tab>("creators");
  const sectionRef = useRef<HTMLElement | null>(null);
  const interactingRef = useRef(false);
  const inViewRef = useRef(true);
  const manualUntilRef = useRef(0);
  const tabRef = useRef<Tab>("creators");
  const reducedRef = useRef(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => { tabRef.current = tab; }, [tab]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => { reducedRef.current = mq.matches; setReduced(mq.matches); };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  useEffect(() => {
    const el = sectionRef.current; if (!el) return;
    const o = new IntersectionObserver(([e]) => { inViewRef.current = e.isIntersecting; }, { threshold: 0.2 });
    o.observe(el);
    return () => o.disconnect();
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (reducedRef.current || interactingRef.current || !inViewRef.current) return;
      if (Date.now() < manualUntilRef.current) return;
      if (tabRef.current === "all") return;
      const cur = ORDER.indexOf(tabRef.current as Persona);
      setTab(ORDER[(cur + 1) % ORDER.length]);
    }, 6000);
    return () => clearInterval(t);
  }, []);

  const selectTab = (id: Tab) => { setTab(id); manualUntilRef.current = Date.now() + 12000; };

  const pins = pickByCategory(pinSamples, "Home Decor", 10, "Pin");
  const prods = take(products, 4, "Product");

  if (TESTIMONIALS_ENABLED) return null;
  const tabs: Tab[] = ["all", ...ORDER];

  return (
    <section
      ref={sectionRef as React.RefObject<HTMLElement>}
      className={SECTION}
      style={{ borderColor: "rgba(255,255,255,0.06)" }}
      onMouseEnter={() => { interactingRef.current = true; }}
      onMouseLeave={() => { interactingRef.current = false; }}
      onFocusCapture={() => { interactingRef.current = true; }}
      onBlurCapture={() => { interactingRef.current = false; }}
    >
      <div className={CONTAINER}>
        <div className="text-center max-w-[680px] mx-auto mb-10">
          <SectionLabel>WORKFLOWS FOR EVERY KIND OF PINTEREST GROWER</SectionLabel>
          <h2 className="text-4xl lg:text-5xl font-black text-white tracking-tight leading-[1.08] mb-4">
            See how VibePin fits <GradientText>the way you work.</GradientText>
          </h2>
          <p className="text-[14px] leading-relaxed" style={{ color: "#8B93A1" }}>
            From opportunity research to auto-publishing, VibePin adapts to creators, sellers,
            affiliate marketers, and Pinterest managers.
          </p>
        </div>

        <div role="tablist" aria-label="Workflow personas" className="flex flex-wrap items-center justify-center gap-2 mb-8">
          {tabs.map(id => {
            const active = tab === id;
            const label = id === "all" ? "All" : STORIES[id as Persona].tabLabel;
            return (
              <button key={id} role="tab" id={`wf-tab-${id}`} aria-selected={active} aria-controls={`wf-panel-${id}`} type="button" onClick={() => selectTab(id)}
                className="relative rounded-full px-4 py-2 text-[12px] font-semibold transition-all"
                style={active ? { background: "linear-gradient(135deg,#D946EF,#7C3AED)", color: "#fff" } : { background: "rgba(255,255,255,0.04)", color: "#9097A0", border: "1px solid rgba(255,255,255,0.08)" }}>
                {label}
              </button>
            );
          })}
        </div>

        {tab === "all" ? <AllOverview pins={pins} products={prods} /> : <FeaturedCard story={STORIES[tab]} pins={pins} products={prods} reduced={reduced} />}
      </div>
    </section>
  );
}
