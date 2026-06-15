"use client";

import BrandLogo from "@/components/BrandLogo";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight, ArrowLeft, Check, Sparkles, Plus, Bookmark, ImageIcon,
  Search, Wand2, CalendarDays, ShoppingBag, Rocket, Signal, TrendingUp, X,
} from "lucide-react";
import { useLandingAssets, take, placeholders, type LandingAsset } from "@/lib/landingAssets";
import OpportunityIntelligence from "@/components/landing/OpportunityIntelligence";
import IntelligenceInAction from "@/components/landing/IntelligenceInAction";
import ExecutionSystem from "@/components/landing/ExecutionSystem";
import { LandingConversionBlock } from "@/components/landing/conversion/LandingConversionBlock";

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace" };
const scoreColor = (s: number) => (s >= 80 ? "#10B981" : s >= 60 ? "#F59E0B" : "#EF4444");
const VibeBtn = "btn-cta rounded-full font-bold text-white transition-transform hover:scale-[1.03] active:scale-100";
const PIN_FORMATS = ["Lifestyle", "Close-up", "Text Overlay", "Tutorial", "Moodboard", "Blog Style", "Product Showcase"];

// ── Text-only data (no images) ────────────────────────────────────────────────
const INTEL_ROWS = [
  { rank: 1, name: "Boho Living Room",   trend: "+214%", competition: "Low", score: 94 },
  { rank: 2, name: "Japandi Interiors",  trend: "+98%",  competition: "Med", score: 87 },
  { rank: 3, name: "Summer Nails 2026",  trend: "+187%", competition: "Low", score: 92 },
  { rank: 4, name: "Minimalist Outfits", trend: "+128%", competition: "Low", score: 80 },
  { rank: 5, name: "Coastal Decor",      trend: "+76%",  competition: "Med", score: 72 },
];
const TL_KEYWORDS = [
  { k: "spring wreath ideas",      t: "+246%", d: "High",   c: "Low",    o: 94 },
  { k: "modern farmhouse decor",   t: "+195%", d: "High",   c: "Medium", o: 87 },
  { k: "spring mantel styling",    t: "+138%", d: "Medium", c: "Low",    o: 82 },
  { k: "boho living room ideas",   t: "+129%", d: "High",   c: "Low",    o: 79 },
  { k: "outdoor wall decor ideas", t: "+96%",  d: "Medium", c: "Low",    o: 72 },
];
const SIGNAL_STATS = [
  { value: "12K+",  label: "High-save Pins analyzed",       grad: "#FF4D8D,#D946EF" },
  { value: "2K+",   label: "Product signals discovered",    grad: "#D946EF,#A855F7" },
  { value: "1.3K+", label: "Pinterest keywords researched", grad: "#A855F7,#7C3AED" },
  { value: "Daily", label: "Signal intelligence updates",   grad: "#38BDF8,#22D3EE" },
];
const TICKERS = [
  { emoji: "🌿", name: "Boho Living Room",  yoy: "+214%" }, { emoji: "💅", name: "Summer Nails 2026", yoy: "+187%" },
  { emoji: "👗", name: "Minimalist Outfits", yoy: "+128%" }, { emoji: "🪨", name: "Japandi Interiors", yoy: "+98%" },
  { emoji: "🖼️", name: "Gallery Wall Art",  yoy: "+145%" }, { emoji: "🕯️", name: "Cottagecore Kitchen", yoy: "+120%" },
  { emoji: "💎", name: "Quiet Luxury",       yoy: "+310%" }, { emoji: "☕", name: "Slow Mornings",      yoy: "+176%" },
];
// ── Primitives ────────────────────────────────────────────────────────────────
function AssetImg({ asset, label }: { asset?: LandingAsset; label?: string }) {
  if (asset?.imageUrl) {
    // Real VibePin asset (pin_sample / product_opportunity). Plain <img> loads any
    // CDN host and is hotlink-friendly for Pinterest images.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.imageUrl} alt={asset.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />;
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1" style={{ background: "linear-gradient(135deg,#141622,#0b0d15)" }}>
      <ImageIcon className="w-4 h-4" style={{ color: "#2A2F3E" }} />
      {label && <span className="text-[7px] font-semibold uppercase tracking-wide" style={{ color: "#323848" }}>{label}</span>}
    </div>
  );
}

function GenTile({ label = "AI draft" }: { label?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5" style={{ background: "linear-gradient(135deg,rgba(217,70,239,0.10),rgba(124,58,237,0.06))" }}>
      <Sparkles className="w-4 h-4" style={{ color: "rgba(217,70,239,0.5)" }} />
      <span className="text-[7px] font-semibold uppercase tracking-wide" style={{ color: "rgba(217,70,239,0.55)" }}>{label}</span>
    </div>
  );
}

function Pill({ label, tone }: { label: string; tone: "green" | "cyan" | "amber" | "magenta" }) {
  const map = { green: { bg: "rgba(16,185,129,0.15)", color: "#10B981" }, cyan: { bg: "rgba(8,145,178,0.15)", color: "#38BDF8" }, amber: { bg: "rgba(245,158,11,0.15)", color: "#F59E0B" }, magenta: { bg: "rgba(217,70,239,0.15)", color: "#E879F9" } }[tone];
  return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold leading-none whitespace-nowrap" style={{ background: map.bg, color: map.color }}>{label}</span>;
}

function ScoreChip({ score }: { score: number }) {
  const c = scoreColor(score);
  return <span className="inline-flex items-center justify-center rounded-lg px-2 py-1 text-[11px] font-black tabular-nums" style={{ ...MONO, color: c, background: `${c}1A`, border: `1px solid ${c}40`, minWidth: 32 }}>{score}</span>;
}

function Rail({ children, accent }: { children: React.ReactNode; accent: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * 340, behavior: "smooth" });
  return (
    <div className="relative">
      <div ref={ref} className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory no-scrollbar" style={{ scrollbarWidth: "none" }}>{children}</div>
      <button type="button" onClick={() => scroll(-1)} aria-label="Previous" className="hidden sm:flex absolute -left-4 top-1/2 -translate-y-1/2 h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition-transform hover:scale-110" style={{ background: "rgba(8,14,11,0.85)", borderColor: `${accent}55`, color: accent }}><ArrowLeft className="w-4 h-4" /></button>
      <button type="button" onClick={() => scroll(1)} aria-label="Next" className="hidden sm:flex absolute -right-4 top-1/2 -translate-y-1/2 h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition-transform hover:scale-110" style={{ background: "rgba(8,14,11,0.85)", borderColor: `${accent}55`, color: accent }}><ArrowRight className="w-4 h-4" /></button>
    </div>
  );
}

function useInView(threshold = 0.2): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const o = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVis(true); o.disconnect(); } }, { threshold });
    o.observe(el);
    return () => o.disconnect();
  }, [threshold]);
  return [ref, vis];
}

// ── Hero composer ─────────────────────────────────────────────────────────────
function HeroComposer({ products, refs }: { products: LandingAsset[]; refs: LandingAsset[] }) {
  return (
    <div className="rounded-2xl border overflow-hidden shadow-2xl" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)" }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A0E16", borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5" style={{ color: "#E879F9" }} /><span className="text-[12px] font-bold text-white">Create Pins</span></div>
        <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(255,255,255,0.06)", color: "#6B7280" }}>New draft</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2">
        <div className="p-4 lg:border-r" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: "#4B5563" }}><ImageIcon className="w-3 h-3" /> Product Images</p>
          <div className="flex gap-1.5 mb-4">
            {products.map((a, i) => <div key={i} className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 44, height: 44, border: "1px solid rgba(255,255,255,0.10)" }}><AssetImg asset={a} /></div>)}
            <div className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 44, height: 44, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-4 h-4" /></div>
          </div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: "#4B5563" }}><Bookmark className="w-3 h-3" /> Pin References</p>
          <div className="flex gap-1.5 mb-4">
            {refs.map((a, i) => <div key={i} className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 44, height: 44, border: "1px solid rgba(255,255,255,0.10)" }}><AssetImg asset={a} /></div>)}
            <div className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 44, height: 44, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-4 h-4" /></div>
          </div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Creative Direction</p>
          <div className="rounded-lg px-3 py-2.5 mb-4 text-[11px] leading-relaxed" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.07)", color: "#8B93A1" }}>
            Modern boho living room, warm natural light, earthy tones, cozy minimal style.<span className="block text-right mt-1 text-[9px]" style={{ color: "#374151", ...MONO }}>84 / 300</span>
          </div>
          <button type="button" className={`${VibeBtn} w-full py-2.5 text-[12px] flex items-center justify-center gap-2`}>Generate Pins <Sparkles className="w-3.5 h-3.5" /></button>
        </div>
        <div className="p-4 relative">
          <div className="flex items-center justify-between mb-3"><p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#4B5563" }}>Generated Pins</p><span className="text-[9px] font-semibold" style={{ color: "#38BDF8" }}>View all drafts →</span></div>
          <div className="grid grid-cols-2 gap-2.5">{placeholders(4, "AI draft", "generated_pin").map((_, i) => <div key={i} className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "4/5" }}><GenTile /></div>)}</div>
          <div className="absolute left-1/2 -translate-x-1/2 top-[46%] -translate-y-1/2"><span className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white shadow-lg flex items-center gap-1.5" style={{ background: "rgba(8,12,18,0.92)", border: "1px solid rgba(255,255,255,0.15)" }}><Plus className="w-3 h-3" /> Add to Plan</span></div>
        </div>
      </div>
    </div>
  );
}

// ── Hero opportunity card ─────────────────────────────────────────────────────
function ScoreRing({ score }: { score: number }) {
  const r = 24, circ = 2 * Math.PI * r, off = circ * (1 - score / 100);
  return (
    <div className="relative" style={{ width: 60, height: 60 }}>
      <svg width="60" height="60" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="30" cy="30" r={r} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="4" />
        <circle cx="30" cy="30" r={r} fill="none" stroke="url(#scoreGrad)" strokeWidth="4" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} />
        <defs><linearGradient id="scoreGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FF4D8D" /><stop offset="1" stopColor="#A855F7" /></linearGradient></defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none"><span className="text-[15px] font-black text-white" style={MONO}>{score}</span><span className="text-[7px]" style={{ color: "#6B7280" }}>/100</span></div>
    </div>
  );
}

function HeroOpportunityCard({ mainImg, signals, refs }: { mainImg?: LandingAsset; signals: LandingAsset[]; refs: LandingAsset[] }) {
  const metrics = [
    { icon: <TrendingUp className="w-4 h-4" />,  v: "+210%", l: "Demand (vs last 30 days)", c: "#10B981" },
    { icon: <Bookmark className="w-4 h-4" />,    v: "18",    l: "High-save Pins",           c: "#E879F9" },
    { icon: <ShoppingBag className="w-4 h-4" />, v: "7",     l: "Matched products",         c: "#38BDF8" },
  ];
  return (
    <div className="rounded-2xl border overflow-hidden shadow-2xl" style={{ background: "linear-gradient(180deg,#0E1018,#0A0C14)", borderColor: "rgba(168,85,247,0.28)", boxShadow: "0 0 70px rgba(168,85,247,0.14)" }}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-1" style={{ color: "#E879F9" }}>Recommended Opportunity</p>
            <h3 className="text-[22px] font-black text-white tracking-tight">Boho Living Room</h3>
          </div>
          <div className="flex flex-col items-center shrink-0"><ScoreRing score={94} /><span className="text-[9px] mt-1" style={{ color: "#6B7280" }}>Opportunity score</span></div>
        </div>
        <div className="grid grid-cols-[1.4fr_1fr] gap-3 mb-4">
          <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "4/3" }}><AssetImg asset={mainImg} label="Boho Living Room" /></div>
          <div className="flex flex-col justify-center gap-2.5">
            {metrics.map(m => (
              <div key={m.l} className="flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${m.c}1A`, color: m.c }}>{m.icon}</span>
                <div className="min-w-0"><p className="text-[15px] font-black text-white leading-none" style={MONO}>{m.v}</p><p className="text-[9px] mt-0.5" style={{ color: "#6B7280" }}>{m.l}</p></div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Top Product Signals</p>
        <div className="flex gap-1.5 mb-3">{signals.slice(0, 7).map((a, i) => <div key={i} className="relative rounded-lg overflow-hidden flex-1" style={{ aspectRatio: "1/1", border: "1px solid rgba(255,255,255,0.08)" }}><AssetImg asset={a} /></div>)}</div>
        <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Top Pin References</p>
        <div className="flex gap-1.5 mb-4">
          {refs.slice(0, 5).map((a, i) => <div key={i} className="relative rounded-lg overflow-hidden flex-1" style={{ aspectRatio: "1/1", border: "1px solid rgba(255,255,255,0.08)" }}><AssetImg asset={a} /></div>)}
          <div className="rounded-lg flex-1 flex items-center justify-center text-center text-[8px] font-bold leading-tight" style={{ aspectRatio: "1/1", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#6B7280" }}>+15<br />more</div>
        </div>
        <div className="rounded-xl p-3 mb-4" style={{ background: "rgba(168,85,247,0.07)", border: "1px solid rgba(168,85,247,0.18)" }}>
          <p className="text-[9px] font-bold uppercase tracking-wider mb-1 flex items-center gap-1.5" style={{ color: "#C4B5FD" }}><Sparkles className="w-3 h-3" /> Creative Direction</p>
          <p className="text-[11px] leading-relaxed" style={{ color: "#C8CDD6" }}>Warm neutrals, natural textures, layered lighting. Lifestyle angles showing cozy, lived-in spaces.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <button type="button" className={`${VibeBtn} flex-1 py-2.5 text-[12px] flex items-center justify-center gap-1.5`}><Sparkles className="w-3.5 h-3.5" /> Generate 7 Pins</button>
          <button type="button" className="flex-1 rounded-full py-2.5 text-[12px] font-semibold border flex items-center justify-center gap-1.5 transition-colors hover:text-white hover:border-white/30" style={{ borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }}><CalendarDays className="w-3.5 h-3.5" /> Add to weekly plan</button>
        </div>
      </div>
    </div>
  );
}

// ── Timeline mocks ────────────────────────────────────────────────────────────
function Mock({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border overflow-hidden shadow-xl transition-transform duration-300 hover:-translate-y-1.5" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)" }}>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ background: "#0A0E16", borderColor: "rgba(255,255,255,0.06)" }}>
        <span style={{ color: "#E879F9" }}>{icon}</span><span className="text-[12px] font-bold text-white">{title}</span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function KeywordTrendsMock() {
  const cols = "1fr 3rem 3.4rem 4.2rem 2.4rem";
  return (
    <Mock title="Keyword Trends" icon={<Search className="w-3.5 h-3.5" />}>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.08)" }}><Search className="w-3 h-3" style={{ color: "#4B5563" }} /><span className="text-[11px]" style={{ color: "#8B93A1" }}>spring home decor</span></div>
        <span className="rounded-lg px-3 py-1.5 text-[11px] font-bold text-white" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}>Search</span>
      </div>
      <div className="grid items-center px-1 py-1.5 border-b" style={{ gridTemplateColumns: cols, gap: "0.4rem", borderColor: "rgba(255,255,255,0.06)" }}>
        {["Keyword / topic", "Trend", "Demand", "Competition", "Opp."].map(h => <span key={h} className="text-[8px] font-bold uppercase tracking-wider" style={{ color: "#374151", ...MONO }}>{h}</span>)}
      </div>
      {TL_KEYWORDS.map(r => (
        <div key={r.k} className="grid items-center px-1 py-2 border-b last:border-0" style={{ gridTemplateColumns: cols, gap: "0.4rem", borderColor: "rgba(255,255,255,0.04)" }}>
          <span className="text-[11px] font-semibold text-white truncate">{r.k}</span>
          <span className="text-[10px] font-bold tabular-nums text-emerald-400" style={MONO}>↑{r.t}</span>
          <Pill label={r.d} tone={r.d === "High" ? "green" : "amber"} />
          <Pill label={r.c} tone={r.c === "Low" ? "green" : "amber"} />
          <span className="text-[11px] font-black tabular-nums text-right" style={{ color: scoreColor(r.o), ...MONO }}>{r.o}</span>
        </div>
      ))}
    </Mock>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function PinIdeasMock({ assets }: { assets: LandingAsset[] }) {
  return (
    <Mock title="Pin Ideas" icon={<Bookmark className="w-3.5 h-3.5" />}>
      <div className="flex items-center gap-3 mb-2.5 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        {["Pin Ideas", "Boards", "Collections"].map((t, i) => <span key={t} className="text-[11px] font-semibold pb-2" style={i === 0 ? { color: "#E879F9", borderBottom: "2px solid #E879F9" } : { color: "#4B5563" }}>{t}</span>)}
      </div>
      <div className="flex items-center gap-1.5 mb-2.5">
        {["Living Room", "Kitchen", "Wall Decor", "Table Setting", "Outdoor"].map((c, i) => <span key={c} className="rounded-full px-2 py-0.5 text-[9px] font-semibold whitespace-nowrap shrink-0" style={i === 0 ? { background: "rgba(217,70,239,0.18)", color: "#E879F9" } : { background: "rgba(255,255,255,0.05)", color: "#6B7280" }}>{c}</span>)}
        <span className="rounded-full h-5 w-5 flex items-center justify-center shrink-0 text-[12px]" style={{ background: "rgba(255,255,255,0.05)", color: "#6B7280" }}>+</span>
      </div>
      <div className="grid grid-cols-5 gap-1.5">{assets.map((a, i) => <div key={i} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "3/4" }}><AssetImg asset={a} label="Pin" /></div>)}</div>
    </Mock>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CreatePinsMock({ products, refs }: { products: LandingAsset[]; refs: LandingAsset[] }) {
  return (
    <Mock title="Create Pins" icon={<Wand2 className="w-3.5 h-3.5" />}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Product Images</p>
          <div className="flex gap-1 mb-2.5">{products.map((a, i) => <div key={i} className="relative rounded overflow-hidden shrink-0" style={{ width: 30, height: 30 }}><AssetImg asset={a} /></div>)}<div className="flex items-center justify-center rounded shrink-0" style={{ width: 30, height: 30, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-3 h-3" /></div></div>
          <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Pin References</p>
          <div className="flex gap-1 mb-2.5">{refs.map((a, i) => <div key={i} className="relative rounded overflow-hidden shrink-0" style={{ width: 30, height: 30 }}><AssetImg asset={a} /></div>)}<div className="flex items-center justify-center rounded shrink-0" style={{ width: 30, height: 30, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-3 h-3" /></div></div>
          <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Creative Direction</p>
          <div className="rounded px-2 py-1.5 text-[9px] leading-relaxed" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.07)", color: "#8B93A1" }}>Warm minimal living room, soft natural light, neutral tones.</div>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Generated Pins</p>
          <div className="grid grid-cols-3 gap-1 mb-2">{placeholders(3, "AI", "generated_pin").map((_, i) => <div key={i} className="relative rounded overflow-hidden" style={{ aspectRatio: "3/4" }}><GenTile label="" /></div>)}</div>
          <div className="flex items-center justify-between"><span className="rounded-full px-2 py-1 text-[9px] font-bold text-white" style={{ background: "rgba(8,12,18,0.92)", border: "1px solid rgba(255,255,255,0.15)" }}>+ Add to Plan</span><span className="text-[8px] font-semibold" style={{ color: "#38BDF8" }}>View all →</span></div>
        </div>
      </div>
    </Mock>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function WeeklyPlanMock({ assets }: { assets: LandingAsset[] }) {
  const days = ["Mon 12", "Tue 13", "Wed 14", "Thu 15", "Fri 16", "Sat 17"];
  const statuses = ["Scheduled", "Scheduled", "Draft", "Review", "Scheduled", "Draft"];
  const stStyle = (s: string) => s === "Scheduled" ? { bg: "rgba(16,185,129,0.18)", c: "#10B981" } : s === "Review" ? { bg: "rgba(245,158,11,0.18)", c: "#F59E0B" } : { bg: "rgba(148,151,160,0.16)", c: "#9097A0" };
  return (
    <Mock title="Weekly Plan" icon={<CalendarDays className="w-3.5 h-3.5" />}>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[10px] font-semibold" style={{ color: "#8B93A1" }}>May 12 – May 18, 2025</span>
        <div className="flex gap-1"><span className="rounded px-2 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(255,255,255,0.06)", color: "#9097A0" }}>Week</span><span className="rounded px-2 py-0.5 text-[9px] font-semibold" style={{ color: "#4B5563" }}>Today</span></div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d, i) => { const st = stStyle(statuses[i]); return (
          <div key={d}>
            <p className="text-[7px] font-bold mb-1" style={{ color: "#4B5563" }}>{d}</p>
            <div className="relative rounded overflow-hidden mb-1" style={{ aspectRatio: "3/4" }}><AssetImg asset={assets[i]} label="Pin" /></div>
            <span className="block rounded-full px-1 py-0.5 text-[6px] font-bold text-center" style={{ background: st.bg, color: st.c }}>{statuses[i]}</span>
          </div>
        ); })}
        <div>
          <p className="text-[7px] font-bold mb-1" style={{ color: "#4B5563" }}>Sun 18</p>
          <div className="rounded flex items-center justify-center mb-1" style={{ aspectRatio: "3/4", border: "1px dashed rgba(255,255,255,0.14)", color: "#374151" }}><Plus className="w-3 h-3" /></div>
          <span className="block text-[6px] font-bold text-center" style={{ color: "#374151" }}>Empty</span>
        </div>
      </div>
    </Mock>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function TimelineStep({ n, title, copy, bullets, mock, flip }: { n: number; title: string; copy: string; bullets: string[]; mock: React.ReactNode; flip: boolean }) {
  const [ref, vis] = useInView(0.25);
  return (
    <div ref={ref} className="relative grid lg:grid-cols-2 gap-6 lg:gap-16 items-center pb-12 lg:pb-16">
      <div className="hidden lg:flex absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 z-20 h-10 w-10 rounded-full items-center justify-center text-[15px] font-black text-white" style={{ background: vis ? "linear-gradient(135deg,#D946EF,#7C3AED)" : "#161A26", border: "3px solid var(--bg)", boxShadow: vis ? "0 0 0 4px rgba(217,70,239,0.16), 0 0 22px rgba(217,70,239,0.45)" : "none", transition: "all .45s ease", ...MONO }}>{n}</div>
      <div className={`${flip ? "lg:order-2 lg:pl-16" : "lg:pr-16"}`} style={{ opacity: vis ? 1 : 0, transform: vis ? "none" : "translateY(22px)", transition: "all .55s ease" }}>
        <div className="flex items-center gap-2 mb-3"><span className="lg:hidden h-7 w-7 rounded-full flex items-center justify-center text-[12px] font-black text-white" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)", ...MONO }}>{n}</span><span className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "#A855F7" }}>Step {n}</span></div>
        <h3 className="text-2xl font-black text-white tracking-tight mb-3">{title}</h3>
        <p className="text-[14px] leading-relaxed mb-4" style={{ color: "#8B93A1" }}>{copy}</p>
        <ul className="space-y-2">{bullets.map(b => <li key={b} className="flex items-center gap-2.5 text-[12px]" style={{ color: "#C8CDD6" }}><Check className="w-3.5 h-3.5 shrink-0" style={{ color: "#A855F7" }} />{b}</li>)}</ul>
      </div>
      <div className={`${flip ? "lg:order-1 lg:pr-16" : "lg:pl-16"}`} style={{ opacity: vis ? 1 : 0, transform: vis ? "none" : `translateX(${flip ? -22 : 22}px)`, transition: "all .55s ease .1s" }}>{mock}</div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
function WorkflowKeywordTrendsMock() {
  const cols = "1fr 3rem 3.4rem 4.2rem 2.4rem";
  return (
    <Mock title="Keyword Trends" icon={<Search className="w-3.5 h-3.5" />}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="flex-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5 min-w-0" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.08)" }}><Search className="w-3 h-3 shrink-0" style={{ color: "#4B5563" }} /><span className="text-[11px] truncate" style={{ color: "#8B93A1" }}>spring home decor</span></div>
          <span className="rounded-lg px-3 py-1.5 text-[11px] font-bold text-white shrink-0" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}>Search</span>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1 text-[9px] font-bold shrink-0" style={{ color: "#A855F7" }}>View all <ArrowRight className="w-3 h-3" /></span>
      </div>
      <div className="grid items-center px-1 py-1.5 border-b" style={{ gridTemplateColumns: cols, gap: "0.4rem", borderColor: "rgba(255,255,255,0.06)" }}>
        {["Keyword / topic", "Trend", "Demand", "Competition", "Opp."].map(h => <span key={h} className="text-[8px] font-bold uppercase tracking-wider" style={{ color: "#374151", ...MONO }}>{h}</span>)}
      </div>
      {TL_KEYWORDS.map(r => (
        <div key={r.k} className="grid items-center px-1 py-2 border-b last:border-0" style={{ gridTemplateColumns: cols, gap: "0.4rem", borderColor: "rgba(255,255,255,0.04)" }}>
          <span className="text-[11px] font-semibold text-white truncate">{r.k}</span>
          <span className="text-[10px] font-bold tabular-nums text-emerald-400" style={MONO}>{r.t}</span>
          <Pill label={r.d} tone={r.d === "High" ? "green" : "amber"} />
          <Pill label={r.c} tone={r.c === "Low" ? "green" : "amber"} />
          <span className="text-[11px] font-black tabular-nums text-right" style={{ color: scoreColor(r.o), ...MONO }}>{r.o}</span>
        </div>
      ))}
    </Mock>
  );
}

function WorkflowProductOpportunitiesMock({ assets }: { assets: LandingAsset[] }) {
  return (
    <Mock title="Product Opportunities" icon={<ShoppingBag className="w-3.5 h-3.5" />}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5"><Pill label="Matched to demand" tone="green" /><Pill label="Low competition" tone="cyan" /></div>
        <span className="inline-flex items-center gap-1 text-[9px] font-bold" style={{ color: "#A855F7" }}>View all <ArrowRight className="w-3 h-3" /></span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {assets.map((a, i) => {
          const score = Math.round(a.score ?? [94, 87, 82, 76][i % 4]);
          return (
            <div key={a.id} className="rounded-xl overflow-hidden" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="relative" style={{ aspectRatio: "1/1" }}><AssetImg asset={a} label="Product" /><span className="absolute top-1.5 right-1.5"><ScoreChip score={score} /></span></div>
              <div className="p-2">
                <p className="text-[9px] font-bold text-white leading-tight line-clamp-2 min-h-[2.4em]">{a.title}</p>
                <div className="mt-1.5 flex flex-wrap gap-1"><Pill label={i % 2 === 0 ? "High demand" : "Rising"} tone="green" /><Pill label={i === 1 ? "Medium" : "Low comp"} tone={i === 1 ? "amber" : "cyan"} /></div>
              </div>
            </div>
          );
        })}
      </div>
    </Mock>
  );
}

function WorkflowPinIdeasMock({ assets }: { assets: LandingAsset[] }) {
  return (
    <Mock title="Pin Ideas" icon={<Bookmark className="w-3.5 h-3.5" />}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 overflow-hidden">
          {["Lifestyle", "Close-up", "Text Overlay", "Tutorial", "Moodboard"].map((c, i) => <span key={c} className="rounded-full px-2 py-0.5 text-[9px] font-semibold whitespace-nowrap shrink-0" style={i === 0 ? { background: "rgba(217,70,239,0.18)", color: "#E879F9" } : { background: "rgba(255,255,255,0.05)", color: "#6B7280" }}>{c}</span>)}
        </div>
        <span className="hidden sm:inline-flex items-center gap-1 text-[9px] font-bold ml-2 shrink-0" style={{ color: "#A855F7" }}>Explore all <ArrowRight className="w-3 h-3" /></span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
        {assets.map((a, i) => (
          <div key={a.id} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "3/4" }}>
            <AssetImg asset={a} label="Pin" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent pointer-events-none" />
            <span className="absolute left-1 bottom-1 rounded-full px-1.5 py-0.5 text-[7px] font-bold" style={{ background: "rgba(0,0,0,0.72)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.28)" }}>{PIN_FORMATS[i % PIN_FORMATS.length]}</span>
          </div>
        ))}
      </div>
    </Mock>
  );
}

function WorkflowCreatePinsMock({ products, refs }: { products: LandingAsset[]; refs: LandingAsset[] }) {
  return (
    <Mock title="Create Pins" icon={<Wand2 className="w-3.5 h-3.5" />}>
      <div className="grid grid-cols-1 sm:grid-cols-[0.9fr_1.1fr] gap-3">
        <div>
          <div className="rounded-xl p-2 mb-2.5" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.07)" }}>
            <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: "#4B5563" }}><ShoppingBag className="w-3 h-3" /> Product Images</p>
            <div className="flex gap-1">{products.map((a, i) => <div key={i} className="relative rounded overflow-hidden shrink-0" style={{ width: 34, height: 34 }}><AssetImg asset={a} /></div>)}<div className="flex items-center justify-center rounded shrink-0" style={{ width: 34, height: 34, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-3 h-3" /></div></div>
          </div>
          <div className="rounded-xl p-2 mb-2.5" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.07)" }}>
            <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: "#4B5563" }}><Bookmark className="w-3 h-3" /> Pin References</p>
            <div className="flex gap-1">{refs.map((a, i) => <div key={i} className="relative rounded overflow-hidden shrink-0" style={{ width: 34, height: 34 }}><AssetImg asset={a} /></div>)}<div className="flex items-center justify-center rounded shrink-0" style={{ width: 34, height: 34, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-3 h-3" /></div></div>
          </div>
          <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Creative Direction</p>
          <div className="rounded px-2 py-1.5 text-[9px] leading-relaxed" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.07)", color: "#8B93A1" }}>Modern, minimal, warm natural light, soft neutrals, cozy spring vibes.</div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5"><p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "#4B5563" }}>Generated Pins</p><span className="text-[8px] font-semibold" style={{ color: "#38BDF8" }}>View all drafts <ArrowRight className="inline w-2.5 h-2.5" /></span></div>
          <div className="grid grid-cols-3 gap-1 mb-2">{placeholders(3, "AI", "generated_pin").map((_, i) => <div key={i} className="relative rounded overflow-hidden" style={{ aspectRatio: "3/4" }}><GenTile label={i === 1 ? "Draft" : ""} /></div>)}</div>
          <span className="inline-flex rounded-full px-2.5 py-1 text-[9px] font-bold text-white items-center gap-1" style={{ background: "rgba(8,12,18,0.92)", border: "1px solid rgba(255,255,255,0.15)" }}><Plus className="w-3 h-3" /> Add to Plan</span>
        </div>
      </div>
    </Mock>
  );
}

function WorkflowWeeklyPlanMock({ assets }: { assets: LandingAsset[] }) {
  const days = ["Mon 12", "Tue 13", "Wed 14", "Thu 15", "Fri 16", "Sat 17", "Sun 18"];
  const statuses = ["Scheduled", "Ready", "Needs review", "Scheduled", "Draft", "Draft", "Scheduled"];
  const stStyle = (s: string) => s === "Scheduled" ? { bg: "rgba(16,185,129,0.18)", c: "#10B981" } : s === "Ready" ? { bg: "rgba(8,145,178,0.18)", c: "#38BDF8" } : s === "Needs review" ? { bg: "rgba(245,158,11,0.18)", c: "#F59E0B" } : { bg: "rgba(148,151,160,0.16)", c: "#9097A0" };
  return (
    <Mock title="Weekly Plan" icon={<CalendarDays className="w-3.5 h-3.5" />}>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[10px] font-semibold" style={{ color: "#8B93A1" }}>May 12 - May 18, 2025</span>
        <div className="flex gap-1"><span className="rounded px-2 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(124,58,237,0.55)", color: "#fff" }}>Week</span><span className="rounded px-2 py-0.5 text-[9px] font-semibold" style={{ color: "#4B5563" }}>Today</span></div>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
        {days.map((d, i) => { const st = stStyle(statuses[i]); return (
          <div key={d}>
            <p className="text-[7px] font-bold mb-1" style={{ color: "#4B5563" }}>{d}</p>
            <div className="relative rounded overflow-hidden mb-1" style={{ aspectRatio: "3/4" }}><AssetImg asset={assets[i]} label="Pin" /></div>
            <span className="block rounded-full px-1 py-0.5 text-[6px] font-bold text-center truncate" style={{ background: st.bg, color: st.c }}>{statuses[i]}</span>
          </div>
        ); })}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg py-1.5" style={{ background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.18)" }}><p className="text-[9px] font-bold" style={{ color: "#E879F9" }}>5.2/day</p><p className="text-[7px]" style={{ color: "#6B7280" }}>Cadence</p></div>
        <div className="rounded-lg py-1.5" style={{ background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.18)" }}><p className="text-[9px] font-bold" style={{ color: "#10B981" }}>On track</p><p className="text-[7px]" style={{ color: "#6B7280" }}>Plan health</p></div>
        <div className="rounded-lg py-1.5" style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.18)" }}><p className="text-[9px] font-bold" style={{ color: "#F59E0B" }}>8:30 PM</p><p className="text-[7px]" style={{ color: "#6B7280" }}>Best slot</p></div>
      </div>
    </Mock>
  );
}

function WorkflowTimelineStep({ n, title, copy, bullets, mock, icon }: { n: number; title: string; copy: string; bullets: string[]; mock: React.ReactNode; icon: React.ReactNode }) {
  const [ref, vis] = useInView(0.25);
  return (
    <div ref={ref} className="relative grid lg:grid-cols-[minmax(0,0.92fr)_72px_minmax(0,1.08fr)] gap-5 lg:gap-0 items-stretch pb-8 lg:pb-9">
      <div className="rounded-2xl border p-5 sm:p-6 transition-all duration-300 hover:-translate-y-1" style={{ background: "linear-gradient(180deg,rgba(12,16,24,0.96),rgba(8,12,18,0.96))", borderColor: vis ? "rgba(217,70,239,0.24)" : "rgba(255,255,255,0.08)", boxShadow: vis ? "0 18px 60px rgba(0,0,0,0.28)" : "none", transition: "all .55s ease" }}>
        <div className="flex items-start gap-4">
          <span className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(217,70,239,0.15)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.20)" }}>{icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2"><span className="lg:hidden h-7 w-7 rounded-full flex items-center justify-center text-[12px] font-black text-white" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)", ...MONO }}>{n}</span><span className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "#A855F7" }}>Step {n}</span></div>
            <h3 className="text-2xl font-black text-white tracking-tight mb-3">{title}</h3>
            <p className="text-[14px] leading-relaxed mb-4" style={{ color: "#8B93A1" }}>{copy}</p>
            <ul className="space-y-2">{bullets.map(b => <li key={b} className="flex items-start gap-2.5 text-[12px]" style={{ color: "#C8CDD6" }}><Check className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "#A855F7" }} />{b}</li>)}</ul>
          </div>
        </div>
      </div>
      <div className="hidden lg:flex relative items-center justify-center">
        <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px" style={{ background: "linear-gradient(180deg,rgba(217,70,239,0.08),rgba(217,70,239,0.45),rgba(124,58,237,0.42),rgba(217,70,239,0.08))" }} />
        <div className="z-20 h-11 w-11 rounded-full flex items-center justify-center text-[15px] font-black text-white" style={{ background: vis ? "linear-gradient(135deg,#D946EF,#7C3AED)" : "#161A26", border: "4px solid var(--surface)", boxShadow: vis ? "0 0 0 5px rgba(217,70,239,0.15), 0 0 28px rgba(217,70,239,0.55)" : "none", transition: "all .45s ease", ...MONO }}>{n}</div>
      </div>
      <div style={{ transition: "all .55s ease .1s" }}>{mock}</div>
    </div>
  );
}

export default function HomePage() {
  const { pinSamples, products } = useLandingAssets();

  // Asset derivations (real data → placeholder fallback)
  const heroMainImg  = pinSamples.find(a => a.category === "Home Decor") ?? pinSamples[0];
  const heroSignals  = take(products, 7, "Product");
  const heroRefs     = take(pinSamples, 5, "Reference", 1);
  const tlCreateProd = take(products, 3, "Product", 3);
  const tlCreateRefs = take(pinSamples, 3, "Reference", 13);
  const tlWeek       = take(pinSamples, 7, "Planned Pin", 18);

  return (
    <div className="lp min-h-screen antialiased" style={{ background: "var(--bg)", color: "var(--text)" }}>

      {/* ══ NAV ══ */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,14,11,0.9)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[1240px] mx-auto px-5 h-[60px] flex items-center justify-between">
          <div className="flex items-center gap-2"><BrandLogo size={28} /><span className="font-black text-white tracking-tight text-[17px]">VibePin</span></div>
          <div className="hidden md:flex items-center gap-6 text-[13px] font-medium" style={{ color: "#9097A0" }}>
            <a href="#create" className="hover:text-white transition-colors">How it works</a>
            <Link href="/app/products?demo=true" className="hover:text-white transition-colors">Product Opportunities</Link>
            <a href="#create" className="hover:text-white transition-colors">Create Pins</a>
            <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
          </div>
          <div className="flex items-center gap-2.5">
            <Link href="/login" className="hidden sm:inline text-[13px] font-medium border rounded-full px-4 py-1.5 transition-colors hover:text-white" style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.12)" }}>Log in</Link>
            <Link href="/app/discover?demo=true" className={`${VibeBtn} px-4 py-2 text-[13px] flex items-center gap-1.5`}>Build my next 7 Pins <ArrowRight className="w-3.5 h-3.5" /></Link>
          </div>
        </div>
      </nav>

      {/* ══ HERO ══ */}
      <section className="relative pt-16 pb-12 lg:pt-20 lg:pb-14 overflow-hidden">
        <div className="pointer-events-none absolute -top-32 right-[-8%] h-[460px] w-[460px] rounded-full blur-3xl" style={{ background: "radial-gradient(circle, rgba(217,70,239,0.16), transparent 70%)" }} />
        <div className="max-w-[1240px] mx-auto px-5 grid grid-cols-1 lg:grid-cols-[0.92fr_1.18fr] gap-10 lg:gap-12 items-center relative">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 mb-6" style={{ background: "rgba(217,70,239,0.08)", borderColor: "rgba(217,70,239,0.25)" }}><Sparkles className="w-3 h-3" style={{ color: "#E879F9" }} /><span className="text-[11px] font-semibold tracking-wide" style={{ color: "#E879F9" }}>Pinterest Growth Intelligence</span></div>
            <h1 className="text-[2.6rem] sm:text-[3.3rem] lg:text-[3.6rem] font-black text-white leading-[1.03] tracking-[-0.045em] mb-5">Pinterest growth starts with signals.<br /><span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 60%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>VibePin turns demand into content.</span></h1>
            <p className="text-[15px] sm:text-[16px] leading-relaxed mb-7 max-w-[460px]" style={{ color: "#8B93A1" }}>VibePin discovers what people want, shows which products and Pin formats are already working, then turns them into ready-to-publish Pins and a weekly content plan.</p>
            <div className="flex flex-col sm:flex-row gap-3 mb-6">
              <Link href="/app/discover?demo=true" className={`${VibeBtn} px-7 py-3.5 text-[14px] flex items-center justify-center gap-2`}>Build my next 7 Pins <ArrowRight className="w-4 h-4" /></Link>
              <a href="#create" className="flex items-center justify-center gap-2 rounded-full px-7 py-3.5 text-[14px] font-semibold border transition-colors hover:text-white hover:border-white/30" style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.14)" }}>See this week&apos;s opportunities</a>
            </div>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex -space-x-2">{["#FF4D8D", "#D946EF", "#A855F7", "#7C3AED"].map((g, i) => <span key={i} className="h-8 w-8 rounded-full border-2" style={{ borderColor: "var(--bg)", background: `linear-gradient(135deg,${g},#0C1018)` }} />)}</div>
              <span className="text-[12px]" style={{ color: "#8B93A1" }}>Built for Pinterest creators, sellers and managers</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">{["No credit card required", "Cancel anytime", "Set up in 30 seconds"].map(t => <span key={t} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#6B7280" }}><Check className="w-3 h-3" style={{ color: "#10B981" }} /> {t}</span>)}</div>
          </div>
          <HeroOpportunityCard mainImg={heroMainImg} signals={heroSignals} refs={heroRefs} />
        </div>
      </section>

      {/* ══ LIVE TICKER ══ */}
      <div className="overflow-hidden border-y py-2.5" style={{ borderColor: "rgba(255,255,255,0.07)", background: "#080C12" }}>
        <div className="marquee-track text-[12px] font-semibold" style={{ color: "#4B5563" }}>
          {[...TICKERS, ...TICKERS].map((t, i) => <span key={i} className="inline-flex items-center gap-2 px-6"><span style={{ color: "#E879F9" }}>● Live</span><span>{t.emoji} <span style={{ color: "#9097A0" }}>{t.name}</span></span><span className="font-bold tabular-nums" style={{ color: "#10B981", ...MONO }}>{t.yoy} this week</span><span style={{ color: "#1F2937" }}>·</span></span>)}
        </div>
      </div>

      {/* ══ STATS — SIGNAL ANALYSIS ══ */}
      <section className="py-12 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="rounded-2xl border overflow-hidden" style={{ background: "linear-gradient(180deg,#0C1018,#0A0C14)", borderColor: "rgba(255,255,255,0.08)", boxShadow: "0 0 50px rgba(168,85,247,0.06)" }}>
            <p className="text-center text-[11px] font-semibold uppercase tracking-[0.2em] pt-6" style={{ color: "#6B7280" }}>Powered by continuous Pinterest signal analysis</p>
            <div className="grid grid-cols-2 lg:grid-cols-4 px-4 pt-4 pb-7">
              {SIGNAL_STATS.map((s, i) => (
                <div key={s.label} className="px-6 py-4 text-center" style={{ borderLeft: i === 0 ? "none" : "1px solid rgba(255,255,255,0.07)" }}>
                  <p className="text-3xl sm:text-4xl font-black tracking-tight mb-1" style={{ background: `linear-gradient(120deg,${s.grad})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", ...MONO }}>{s.value}</p>
                  <p className="text-[12px]" style={{ color: "#8B93A1" }}>{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══ PROBLEM / COMPARISON ══ */}
      <section className="py-20 relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-72 mx-auto max-w-3xl rounded-full blur-3xl" style={{ background: "radial-gradient(ellipse, rgba(124,58,237,0.10), transparent 70%)" }} />
        <div className="max-w-[1000px] mx-auto px-5 relative">
          <div className="text-center mb-12"><p className="text-[11px] font-bold uppercase tracking-[0.18em] mb-3" style={{ color: "#4B5563" }}>The problem</p><h2 className="text-3xl sm:text-[2.5rem] font-black text-white tracking-tight leading-[1.1]">Most tools help you make more.<br /><span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 60%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>VibePin helps you decide what&apos;s worth making.</span></h2></div>
          <div className="grid sm:grid-cols-2 gap-5">
            <div className="rounded-2xl border p-6 sm:p-7 transition-transform hover:-translate-y-1" style={{ background: "linear-gradient(180deg,rgba(220,38,38,0.05),rgba(12,16,24,0.35))", borderColor: "rgba(220,38,38,0.20)" }}>
              <div className="flex items-center gap-3 mb-5"><span className="h-9 w-9 rounded-full flex items-center justify-center" style={{ background: "rgba(220,38,38,0.18)", color: "#F87171" }}><X className="w-5 h-5" /></span><div><p className="text-[16px] font-black text-white">Other tools</p><p className="text-[12px]" style={{ color: "#F87171" }}>More content, more guessing.</p></div></div>
              <ul className="space-y-3">{["Start from a blank prompt", "Generate more content", "Guess what might work", "Use separate tools", "Hard to know what will perform"].map(t => <li key={t} className="flex items-center gap-3 text-[13px]" style={{ color: "#9097A0" }}><span className="h-6 w-6 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(220,38,38,0.10)", color: "#F87171" }}><X className="w-3.5 h-3.5" /></span>{t}</li>)}</ul>
            </div>
            <div className="rounded-2xl border p-6 sm:p-7 transition-transform hover:-translate-y-1" style={{ background: "linear-gradient(180deg,rgba(124,58,237,0.12),rgba(12,16,24,0.35))", borderColor: "rgba(168,85,247,0.34)", boxShadow: "0 0 40px rgba(168,85,247,0.08)" }}>
              <div className="flex items-center gap-3 mb-5"><span className="h-9 w-9 rounded-full flex items-center justify-center" style={{ background: "rgba(168,85,247,0.22)", color: "#C4B5FD" }}><Check className="w-5 h-5" /></span><div><p className="text-[16px] font-black text-white">VibePin</p><p className="text-[12px]" style={{ color: "#C4B5FD" }}>Better decisions, better results.</p></div></div>
              <ul className="space-y-3">{["Start from real Pinterest demand", "See why an opportunity matters", "Bring products and references together", "Turn decisions into Pins and a weekly plan", "Focus on what will perform"].map(t => <li key={t} className="flex items-center gap-3 text-[13px]" style={{ color: "#C8CDD6" }}><span className="h-6 w-6 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(168,85,247,0.16)", color: "#C4B5FD" }}><Check className="w-3.5 h-3.5" /></span>{t}</li>)}</ul>
            </div>
          </div>
        </div>
      </section>

      {/* ══ OPPORTUNITY INTELLIGENCE ══ */}
      <OpportunityIntelligence pinSamples={pinSamples} products={products} />

      {/* ══ INTELLIGENCE IN ACTION ══ */}
      <IntelligenceInAction pinSamples={pinSamples} products={products} />

      {/* ══ EXECUTION SYSTEM ══ */}
      <ExecutionSystem pinSamples={pinSamples} products={products} />

      <LandingConversionBlock />

    </div>
  );
}
