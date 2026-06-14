"use client";

import Image from "next/image";
import BrandLogo from "@/components/BrandLogo";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, ArrowLeft, Check, Sparkles, Plus, Bookmark, ImageIcon,
  Search, Lightbulb, Wand2, CalendarDays, Star,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type PinFormat   = "Close-up" | "Moodboard" | "Lifestyle" | "Text Overlay" | "Tutorial" | "Blog Style" | "Product Showcase";
type ProductType = "Physical" | "Digital" | "Printable" | "Template";

interface IntelRow { rank: number; name: string; trend: string; demand: "High" | "Med"; competition: "Low" | "Med"; score: number; }
interface PinIdea { title: string; format: PinFormat; img: string; overlay?: string; demand: "High Demand" | "Rising"; competition: "Low Competition" | "Moderate"; }
interface ProductIdea { title: string; source: "Etsy" | "Shopify" | "Gumroad"; type: ProductType; price: string; demand: "High Demand" | "Rising"; competition: "Low Competition" | "Moderate"; img: string; }
interface GenPin { title: string; img: string; }
interface Testimonial { quote: string; name: string; role: string; group: string; }
interface UseCase { cat: string; headline: string; desc: string; workflow: string; imgs: string[]; }

// ── Helpers ───────────────────────────────────────────────────────────────────
const u = (id: string, w: number, h: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=${h}&q=80`;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace" };
const SERIF: React.CSSProperties = { fontFamily: "'Playfair Display',Georgia,serif" };
const scoreColor = (s: number) => (s >= 80 ? "#10B981" : s >= 60 ? "#F59E0B" : "#EF4444");
const VibeBtn = "btn-cta rounded-full font-bold text-white transition-transform hover:scale-[1.03] active:scale-100";

/* Images are sourced ONLY from the curated library in src/app/data/styles.ts
   (STYLE_CARDS). 17 verified-valid IDs; the 4 library IDs that 404 are unused. */

// Hero / Create-Pins composer
const COMPOSER = {
  products: ["1607344645866-009c320b63e0", "1549465220-1a8b9238cd48", "1512207736890-6ffed8a84e8d"],
  refs:     ["1611532736597-de2d4265fba3", "1490481651871-ab68de25d43d", "1483985988355-763728e1935b"],
  direction: "Modern boho living room, warm natural light, earthy tones, cozy minimal style.",
  gen: [
    { title: "Simple Boho Living",  img: "1586023492125-27b2c045efd7" },
    { title: "Slow Living Space",   img: "1484101403633-562f891dc89a" },
    { title: "Shelf Styling Ideas", img: "1555041469-a586c61ea9bc" },
    { title: "Slow Living Aesthetic", img: "1504257432389-52343af06ae3" },
  ] as GenPin[],
};

const STATS_BIG = [
  { value: "240,909+", label: "opportunities discovered" },
  { value: "14,258+",  label: "creators & businesses" },
  { value: "400+",     label: "niches tracked" },
  { value: "32",       label: "languages supported" },
];
const BRAND_ROW = ["Etsy", "Shopify", "Stan.", "Creative Market", "Teachable", "Gumroad"];

const STEPS = [
  { n: 1, icon: Search,       title: "Find Opportunities",       desc: "Get Pinterest demand signals and discover keywords and products worth making." },
  { n: 2, icon: Lightbulb,    title: "Save & Organize Ideas",    desc: "Save Pin ideas, references, and product ideas into a reusable content library." },
  { n: 3, icon: Wand2,        title: "Create High-Converting Pins", desc: "Generate product-aware Pins from your product images and references — faster." },
  { n: 4, icon: CalendarDays, title: "Plan Your Week",           desc: "Drop Pins into a weekly plan, review every Pin, and stay consistent with less effort." },
];

const INTEL_ROWS: IntelRow[] = [
  { rank: 1, name: "Boho Living Room",   trend: "+214%", demand: "High", competition: "Low", score: 94 },
  { rank: 2, name: "Japandi Interiors",  trend: "+98%",  demand: "High", competition: "Med", score: 87 },
  { rank: 3, name: "Summer Nails 2026",  trend: "+187%", demand: "High", competition: "Low", score: 92 },
  { rank: 4, name: "Minimalist Outfits", trend: "+128%", demand: "High", competition: "Low", score: 80 },
  { rank: 5, name: "Coastal Decor",      trend: "+76%",  demand: "Med",  competition: "Med", score: 72 },
];

const PIN_IDEAS: PinIdea[] = [
  { title: "Slow mornings, done right", format: "Text Overlay",     img: "1504674900247-0877df9cc836", overlay: "Slow\nmornings,\ndone right.", demand: "Rising",      competition: "Low Competition" },
  { title: "Clean beauty close-up",     format: "Close-up",         img: "1522335789203-aabd1fc54bc9", demand: "High Demand", competition: "Low Competition" },
  { title: "10-minute weeknight dinner",format: "Tutorial",         img: "1490645935967-10de6ba17061", overlay: "10-MINUTE\nDINNER", demand: "High Demand", competition: "Moderate" },
  { title: "Summer outfit lifestyle",   format: "Lifestyle",        img: "1515886657613-9f3515b0c78f", demand: "High Demand", competition: "Moderate" },
  { title: "Neutral tones moodboard",   format: "Moodboard",        img: "1596462502278-27bfdc403348", demand: "Rising",      competition: "Low Competition" },
  { title: "How to style the trend",    format: "Blog Style",       img: "1483985988355-763728e1935b", overlay: "How to\nstyle the\ntrend", demand: "Rising",      competition: "Low Competition" },
  { title: "Cozy gift set showcase",    format: "Product Showcase", img: "1549465220-1a8b9238cd48", demand: "High Demand", competition: "Low Competition" },
];

const PRODUCT_IDEAS: ProductIdea[] = [
  { title: "Daily Glow Serum",        source: "Shopify", type: "Physical",  price: "$18–$39",  demand: "High Demand", competition: "Low Competition", img: "1512207736890-6ffed8a84e8d" },
  { title: "Printable Daily Planner", source: "Gumroad", type: "Printable", price: "$7–$15",   demand: "High Demand", competition: "Low Competition", img: "1611532736597-de2d4265fba3" },
  { title: "Gold Layering Set",       source: "Etsy",    type: "Physical",  price: "$24–$68",  demand: "High Demand", competition: "Moderate",        img: "1506629082955-511b1aa562c8" },
  { title: "Curated Gift Box",        source: "Etsy",    type: "Physical",  price: "$28–$60",  demand: "Rising",      competition: "Low Competition", img: "1607344645866-009c320b63e0" },
  { title: "Capsule Wardrobe Edit",   source: "Shopify", type: "Physical",  price: "$40–$120", demand: "High Demand", competition: "Low Competition", img: "1490481651871-ab68de25d43d" },
  { title: "Wellness Ritual Kit",     source: "Etsy",    type: "Physical",  price: "$22–$55",  demand: "Rising",      competition: "Low Competition", img: "1545205597-3d9d02c29597" },
];

const PLAN_STEP = {
  products: ["1586023492125-27b2c045efd7", "1484101403633-562f891dc89a", "1555041469-a586c61ea9bc"],
  refs:     ["1504257432389-52343af06ae3", "1515886657613-9f3515b0c78f", "1483985988355-763728e1935b"],
  gen:      ["1607344645866-009c320b63e0", "1549465220-1a8b9238cd48", "1490645935967-10de6ba17061", "1504674900247-0877df9cc836"],
  plan:     [{ day: "Mon 12", img: "1512207736890-6ffed8a84e8d" }, { day: "Tue 13", img: "1506629082955-511b1aa562c8" }, { day: "Wed 14", img: "1611532736597-de2d4265fba3" }],
};

const USE_CASES: UseCase[] = [
  { cat: "Home Decor",        headline: "Make rooms people want to save", desc: "Turn trending room styles into Pins that drive saves and shop clicks.", workflow: "Find decor trends → save moodboards → generate room Pins → plan the week.", imgs: ["1484101403633-562f891dc89a", "1586023492125-27b2c045efd7", "1555041469-a586c61ea9bc"] },
  { cat: "Fashion",           headline: "Style Pins that convert",        desc: "Spot outfit trends early and turn product shots into editorial Pins.",      workflow: "Find outfit trends → save references → generate looks → schedule drops.", imgs: ["1515886657613-9f3515b0c78f", "1490481651871-ab68de25d43d", "1483985988355-763728e1935b"] },
  { cat: "Beauty",            headline: "Glow-worthy routine Pins",       desc: "Build clean-beauty Pins from your product images and references.",            workflow: "Find beauty trends → save formats → generate routine Pins → plan posts.", imgs: ["1512207736890-6ffed8a84e8d", "1522335789203-aabd1fc54bc9", "1596462502278-27bfdc403348"] },
  { cat: "Food & Drink",      headline: "Recipe Pins that get made",      desc: "Turn recipes into tutorial and text-overlay Pins built for saves.",          workflow: "Find recipe trends → save layouts → generate Pins → plan a week of food.", imgs: ["1490645935967-10de6ba17061", "1504674900247-0877df9cc836", "1545205597-3d9d02c29597"] },
  { cat: "Digital Products",  headline: "Sell templates & printables",    desc: "Match digital products to real demand and Pin them with destination URLs.",    workflow: "Find product demand → link product → generate Pins → plan promotion.", imgs: ["1611532736597-de2d4265fba3", "1607344645866-009c320b63e0", "1549465220-1a8b9238cd48"] },
  { cat: "Pinterest Managers",headline: "Plan client weeks fast",         desc: "Build a reviewable weekly plan per client — you confirm every Pin.",          workflow: "Find opportunities → batch create → plan boards → review & schedule.", imgs: ["1504257432389-52343af06ae3", "1506629082955-511b1aa562c8", "1490481651871-ab68de25d43d"] },
];

const TESTIMONIALS: Testimonial[] = [
  { quote: "VibePin tells me what to create next. I stopped guessing and my saves went up.", name: "Emma J.",  role: "Home Decor Creator",   group: "Creators" },
  { quote: "I collect references and draft Pins in one place. It's my daily workflow now.",   name: "Jason P.",  role: "Etsy Seller",          group: "Sellers" },
  { quote: "Product-aware Pins made my listings look so much better. More clicks, less work.", name: "Sarah K.", role: "Digital Product Seller", group: "Sellers" },
  { quote: "Managing multiple clients is finally organized — one plan, everything in view.",   name: "Daniel M.", role: "Pinterest Manager",     group: "Agencies" },
  { quote: "The weekly plan keeps me consistent without burning a whole afternoon.",           name: "Priya N.",  role: "Fashion Creator",       group: "Creators" },
  { quote: "Demand signals before I create saved me from chasing crowded niches.",             name: "Leo R.",    role: "Agency Lead",           group: "Agencies" },
];
const TEST_GROUPS = ["All", "Creators", "Sellers", "Agencies"];

const TICKERS = [
  { emoji: "🌿", name: "Boho Living Room",  yoy: "+214%" }, { emoji: "💅", name: "Summer Nails 2026", yoy: "+187%" },
  { emoji: "👗", name: "Minimalist Outfits", yoy: "+128%" }, { emoji: "🪨", name: "Japandi Interiors", yoy: "+98%" },
  { emoji: "🖼️", name: "Gallery Wall Art",  yoy: "+145%" }, { emoji: "🕯️", name: "Cottagecore Kitchen", yoy: "+120%" },
  { emoji: "💎", name: "Quiet Luxury",       yoy: "+310%" }, { emoji: "☕", name: "Slow Mornings",      yoy: "+176%" },
];

const PRICING = [
  { plan: "Free",    monthly: "$0",  yearly: "$0",  period: "",    planKey: "free",    desc: "Discover opportunities and try the workflow.", features: ["Top opportunities (limited)", "Pin Ideas (limited)", "Product Opportunities (limited)", "Manual export"], highlighted: false, cta: "Get started" },
  { plan: "Creator", monthly: "$19", yearly: "$15", period: "/mo", planKey: "creator", desc: "Find, create, and plan as a solo creator.",     features: ["Full opportunity feed", "Pin Ideas + references", "Create Pins (150/mo)", "Weekly Plan board"], highlighted: false, cta: "Start free trial" },
  { plan: "Growth",  monthly: "$49", yearly: "$39", period: "/mo", planKey: "growth",  desc: "Scale product-aware content for your store.",    features: ["Everything in Creator", "Create Pins (500/mo)", "Linked-product Pins + URLs", "Priority support"], highlighted: true, cta: "Start free trial" },
  { plan: "Agency",  monthly: "$99", yearly: "$79", period: "/mo", planKey: "pro",     desc: "Plan Pinterest content for multiple brands.",    features: ["Everything in Growth", "Team workspace (3 seats)", "Unlimited Weekly Plans", "API access (coming soon)"], highlighted: false, cta: "Start free trial" },
];

const FAQ = [
  { q: "What does VibePin actually do?", a: "It finds high-signal Pinterest opportunities, turns them into product-aware Pin drafts, and helps you plan a week of content you review before publishing." },
  { q: "Pin Ideas vs Product Opportunities?", a: "Pin Ideas are content references (formats and angles). Product Opportunities are physical or digital products with real demand you can promote or sell." },
  { q: "Does it publish automatically?", a: "No. You review and confirm every Pin. VibePin never bulk-posts or acts on your account without approval." },
  { q: "Do I need to connect Pinterest?", a: "No. Intelligence, Pin Ideas, and Product Opportunities are read-only. You connect only when you choose to publish." },
  { q: "Where does the data come from?", a: "Pinterest public data and the official Trends API, scored for demand, competition, and trend velocity. Scores are a timing signal, not a guarantee." },
];

// ── Hooks & primitives ────────────────────────────────────────────────────────
function useAutoRotate(count: number, ms: number, paused: boolean): [number, (n: number) => void] {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (paused || count <= 1) return;
    const t = setInterval(() => setI(p => (p + 1) % count), ms);
    return () => clearInterval(t);
  }, [count, ms, paused]);
  return [i % count, setI];
}

function Pill({ label, tone }: { label: string; tone: "green" | "cyan" | "amber" | "magenta" }) {
  const map = { green: { bg: "rgba(16,185,129,0.15)", color: "#10B981" }, cyan: { bg: "rgba(8,145,178,0.15)", color: "#38BDF8" }, amber: { bg: "rgba(245,158,11,0.15)", color: "#F59E0B" }, magenta: { bg: "rgba(217,70,239,0.15)", color: "#E879F9" } }[tone];
  return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold leading-none whitespace-nowrap" style={{ background: map.bg, color: map.color }}>{label}</span>;
}

function ScoreChip({ score }: { score: number }) {
  const c = scoreColor(score);
  return <span className="inline-flex items-center justify-center rounded-lg px-2.5 py-1 text-[12px] font-black tabular-nums" style={{ ...MONO, color: c, background: `${c}1A`, border: `1px solid ${c}40`, minWidth: 40 }}>{score}</span>;
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border overflow-hidden transition-colors" style={{ borderColor: open ? "rgba(217,70,239,0.30)" : "rgba(255,255,255,0.08)", background: open ? "rgba(217,70,239,0.04)" : "transparent" }}>
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-5 py-4 text-left text-[14px] font-semibold transition-colors hover:text-white" style={{ color: "#D1D5DB" }}>
        {q}<span className={`ml-4 text-xl leading-none transition-transform duration-200 shrink-0 ${open ? "rotate-45" : ""}`} style={{ color: open ? "#E879F9" : "#4B5563" }}>+</span>
      </button>
      {open && <p className="px-5 pb-5 text-[13px] leading-relaxed max-w-2xl" style={{ color: "#6B7280" }}>{a}</p>}
    </div>
  );
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

function GenPinCard({ pin }: { pin: GenPin }) {
  return (
    <div className="relative rounded-xl overflow-hidden group/g" style={{ aspectRatio: "4/5" }}>
      <Image src={u(pin.img, 280, 350)} alt={pin.title} fill className="object-cover" sizes="160px" unoptimized />
      <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/5 to-black/25" />
      <p className="absolute top-2.5 left-3 right-3 text-[14px] font-black text-white leading-tight" style={{ textShadow: "0 1px 6px rgba(0,0,0,0.55)", ...SERIF }}>{pin.title}</p>
    </div>
  );
}

// Hero Create-Pins composer
function CreatePinsComposer() {
  return (
    <div className="rounded-2xl border overflow-hidden shadow-2xl" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)" }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A0E16", borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5" style={{ color: "#E879F9" }} /><span className="text-[12px] font-bold text-white">Create Pins</span></div>
        <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(255,255,255,0.06)", color: "#6B7280" }}>New draft</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2">
        {/* composer */}
        <div className="p-4 lg:border-r" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: "#4B5563" }}><ImageIcon className="w-3 h-3" /> Product Images</p>
          <div className="flex gap-1.5 mb-4">
            {COMPOSER.products.map((id, i) => <div key={i} className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 44, height: 44, border: "1px solid rgba(255,255,255,0.10)" }}><Image src={u(id, 88, 88)} alt="" fill className="object-cover" sizes="44px" unoptimized /></div>)}
            <div className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 44, height: 44, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-4 h-4" /></div>
          </div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: "#4B5563" }}><Bookmark className="w-3 h-3" /> Pin References</p>
          <div className="flex gap-1.5 mb-4">
            {COMPOSER.refs.map((id, i) => <div key={i} className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 44, height: 44, border: "1px solid rgba(255,255,255,0.10)" }}><Image src={u(id, 88, 88)} alt="" fill className="object-cover" sizes="44px" unoptimized /></div>)}
            <div className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 44, height: 44, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-4 h-4" /></div>
          </div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Creative Direction</p>
          <div className="rounded-lg px-3 py-2.5 mb-4 text-[11px] leading-relaxed" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.07)", color: "#8B93A1" }}>
            {COMPOSER.direction}<span className="block text-right mt-1 text-[9px]" style={{ color: "#374151", ...MONO }}>84 / 500</span>
          </div>
          <button type="button" className={`${VibeBtn} w-full py-2.5 text-[12px] flex items-center justify-center gap-2`}>Generate Pins <Sparkles className="w-3.5 h-3.5" /></button>
        </div>
        {/* generated */}
        <div className="p-4 relative">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#4B5563" }}>Generated Pins</p>
            <span className="text-[9px] font-semibold" style={{ color: "#38BDF8" }}>View all drafts →</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">{COMPOSER.gen.map((g, i) => <GenPinCard key={i} pin={g} />)}</div>
          <div className="absolute left-1/2 -translate-x-1/2 top-[46%] -translate-y-1/2">
            <span className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white shadow-lg flex items-center gap-1.5" style={{ background: "rgba(8,12,18,0.92)", border: "1px solid rgba(255,255,255,0.15)" }}><Plus className="w-3 h-3" /> Add to Plan</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepCard({ icon, accent, label, children }: { icon: React.ReactNode; accent: string; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border p-4 transition-transform hover:-translate-y-1" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.08)" }}>
      <div className="flex items-center gap-2 mb-3"><span className="h-7 w-7 rounded-lg flex items-center justify-center" style={{ background: `${accent}22`, color: accent }}>{icon}</span><p className="text-[12px] font-bold text-white">{label}</p></div>
      {children}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const [showSticky, setShowSticky] = useState(false);
  const [yearly, setYearly] = useState(false);
  const [useCaseHover, setUseCaseHover] = useState(false);
  const [testHover, setTestHover] = useState(false);
  const [testGroup, setTestGroup] = useState("All");
  const router = useRouter();

  useEffect(() => {
    const h = () => setShowSticky(window.scrollY > 700);
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);

  const [ucIndex, setUcIndex] = useAutoRotate(USE_CASES.length, 5000, useCaseHover);
  const uc = USE_CASES[ucIndex];
  const filteredTests = testGroup === "All" ? TESTIMONIALS : TESTIMONIALS.filter(t => t.group === testGroup);
  const [tIndex, setTIndex] = useAutoRotate(Math.max(filteredTests.length, 1), 4500, testHover);
  useEffect(() => { setTIndex(0); }, [testGroup, setTIndex]);
  const tCard = filteredTests[tIndex % filteredTests.length];

  const srcColor = (s: string) => (s === "Etsy" ? "#F87171" : s === "Gumroad" ? "#A78BFA" : "#34D399");
  const typeStyle = (t: ProductType) => ({ Physical: { bg: "rgba(245,158,11,0.18)", color: "#FCD34D" }, Printable: { bg: "rgba(8,145,178,0.18)", color: "#38BDF8" }, Digital: { bg: "rgba(139,92,246,0.18)", color: "#C4B5FD" }, Template: { bg: "rgba(236,72,153,0.18)", color: "#F9A8D4" } }[t]);

  return (
    <div className="lp min-h-screen antialiased" style={{ background: "var(--bg)", color: "var(--text)" }}>

      {/* ══ NAV ════════════════════════════════════════════════════════════════ */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,14,11,0.9)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[1240px] mx-auto px-5 h-[60px] flex items-center justify-between">
          <div className="flex items-center gap-2"><BrandLogo size={28} /><span className="font-black text-white tracking-tight text-[17px]">VibePin</span></div>
          <div className="hidden md:flex items-center gap-6 text-[13px] font-medium" style={{ color: "#9097A0" }}>
            <a href="#intelligence" className="hover:text-white transition-colors">Intelligence</a>
            <a href="#pin-ideas" className="hover:text-white transition-colors">Pin Ideas</a>
            <a href="#products" className="hover:text-white transition-colors">Product Opportunities</a>
            <a href="#create" className="hover:text-white transition-colors">Create Pins</a>
            <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
          </div>
          <div className="flex items-center gap-2.5">
            <Link href="/login" className="hidden sm:inline text-[13px] font-medium border rounded-full px-4 py-1.5 transition-colors hover:text-white" style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.12)" }}>Log in</Link>
            <Link href="/app/discover?demo=true" className={`${VibeBtn} px-4 py-2 text-[13px] flex items-center gap-1.5`}>Build my next 7 Pins <ArrowRight className="w-3.5 h-3.5" /></Link>
          </div>
        </div>
      </nav>

      {/* ══ HERO (reference 2 — composer) ══════════════════════════════════════ */}
      <section className="relative pt-16 pb-12 lg:pt-20 lg:pb-14 overflow-hidden">
        <div className="pointer-events-none absolute -top-32 right-[-8%] h-[460px] w-[460px] rounded-full blur-3xl" style={{ background: "radial-gradient(circle, rgba(217,70,239,0.16), transparent 70%)" }} />
        <div className="max-w-[1240px] mx-auto px-5 grid grid-cols-1 lg:grid-cols-[0.92fr_1.18fr] gap-10 lg:gap-12 items-center relative">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 mb-6" style={{ background: "rgba(217,70,239,0.08)", borderColor: "rgba(217,70,239,0.25)" }}>
              <Sparkles className="w-3 h-3" style={{ color: "#E879F9" }} />
              <span className="text-[11px] font-semibold tracking-wide" style={{ color: "#E879F9" }}>Pinterest Intelligence · Pins · Plan</span>
            </div>
            <h1 className="text-[2.5rem] sm:text-[3.2rem] lg:text-[3.5rem] font-black text-white leading-[1.04] tracking-[-0.045em] mb-5">
              Find what&apos;s worth<br />making.<br />
              <span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 60%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>Turn it into Pinterest Pins. Plan your week.</span>
            </h1>
            <p className="text-[15px] sm:text-[16px] leading-relaxed mb-7 max-w-[440px]" style={{ color: "#8B93A1" }}>
              VibePin helps creators and sellers discover Pinterest demand, create product-aware Pins, and plan a week of content before publishing.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mb-5">
              <Link href="/app/discover?demo=true" className={`${VibeBtn} px-7 py-3.5 text-[14px] flex items-center justify-center gap-2`}>Build my next 7 Pins <ArrowRight className="w-4 h-4" /></Link>
              <a href="#intelligence" className="flex items-center justify-center gap-2 rounded-full px-7 py-3.5 text-[14px] font-semibold border transition-colors hover:text-white hover:border-white/30" style={{ color: "#9097A0", borderColor: "rgba(255,255,255,0.14)" }}>See this week&apos;s opportunities</a>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {["No credit card required", "You review every Pin", "Cancel anytime"].map(t => (
                <span key={t} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#6B7280" }}><Check className="w-3 h-3" style={{ color: "#10B981" }} /> {t}</span>
              ))}
            </div>
          </div>
          <CreatePinsComposer />
        </div>
      </section>

      {/* ══ LIVE SIGNALS TICKER ════════════════════════════════════════════════ */}
      <div className="overflow-hidden border-y py-2.5" style={{ borderColor: "rgba(255,255,255,0.07)", background: "#080C12" }}>
        <div className="marquee-track text-[12px] font-semibold" style={{ color: "#4B5563" }}>
          {[...TICKERS, ...TICKERS].map((t, i) => (
            <span key={i} className="inline-flex items-center gap-2 px-6">
              <span style={{ color: "#E879F9" }}>● Live</span>
              <span>{t.emoji} <span style={{ color: "#9097A0" }}>{t.name}</span></span>
              <span className="font-bold tabular-nums" style={{ color: "#10B981", ...MONO }}>{t.yoy} this week</span>
              <span style={{ color: "#1F2937" }}>·</span>
            </span>
          ))}
        </div>
      </div>

      {/* ══ STATS + TRUSTED LOGOS (reference 3) ════════════════════════════════ */}
      <section className="py-12 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden mb-10" style={{ background: "rgba(255,255,255,0.06)" }}>
            {STATS_BIG.map(s => (
              <div key={s.label} className="px-6 py-7 text-center" style={{ background: "var(--bg)" }}>
                <p className="text-3xl sm:text-4xl font-black tracking-tight mb-1" style={{ background: "linear-gradient(120deg,#FF4D8D,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", ...MONO }}>{s.value}</p>
                <p className="text-[12px]" style={{ color: "#8B93A1" }}>{s.label}</p>
              </div>
            ))}
          </div>
          <p className="text-center text-[11px] font-semibold uppercase tracking-[0.18em] mb-5" style={{ color: "#4B5563" }}>Trusted by creators and brands around the world</p>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {BRAND_ROW.map(b => <span key={b} className="text-[18px] font-black tracking-tight transition-opacity hover:opacity-100" style={{ color: "#5B6472", opacity: 0.65 }}>{b}</span>)}
          </div>
        </div>
      </section>

      {/* ══ PROBLEM ════════════════════════════════════════════════════════════ */}
      <section className="py-20 relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-72 mx-auto max-w-3xl rounded-full blur-3xl" style={{ background: "radial-gradient(ellipse, rgba(124,58,237,0.10), transparent 70%)" }} />
        <div className="max-w-[900px] mx-auto px-5 relative">
          <div className="text-center mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#4B5563" }}>The problem</p>
            <h2 className="text-3xl sm:text-[2.4rem] font-black text-white tracking-tight leading-[1.12]">Most tools help you make more.<br />VibePin helps you decide what&apos;s worth making.</h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="rounded-2xl border p-6" style={{ background: "rgba(220,38,38,0.04)", borderColor: "rgba(220,38,38,0.18)" }}>
              <div className="flex items-center gap-2.5 mb-4"><span className="h-7 w-7 rounded-full flex items-center justify-center text-[14px]" style={{ background: "rgba(220,38,38,0.15)", color: "#F87171" }}>✕</span><div><p className="text-[14px] font-bold text-white">Generate more content</p><p className="text-[11px]" style={{ color: "#6B7280" }}>More volume, more guessing.</p></div></div>
              <ul className="space-y-2">{["No demand signals", "Hard to know what people want", "More content, less results"].map(t => <li key={t} className="flex items-center gap-2 text-[12px]" style={{ color: "#6B7280" }}><span className="h-1 w-1 rounded-full" style={{ background: "#6B7280" }} />{t}</li>)}</ul>
            </div>
            <div className="rounded-2xl border p-6" style={{ background: "rgba(124,58,237,0.07)", borderColor: "rgba(168,85,247,0.30)" }}>
              <div className="flex items-center gap-2.5 mb-4"><span className="h-7 w-7 rounded-full flex items-center justify-center" style={{ background: "rgba(168,85,247,0.20)" }}><Check className="w-4 h-4" style={{ color: "#C4B5FD" }} /></span><div><p className="text-[14px] font-bold text-white">Find it, create it, plan it</p><p className="text-[11px]" style={{ color: "#9097A0" }}>One workflow from signal to scheduled Pin.</p></div></div>
              <ul className="space-y-2">{["Real Pinterest demand signals", "Product-aware Pin creation", "Weekly content planning"].map(t => <li key={t} className="flex items-center gap-2 text-[12px]" style={{ color: "#C8CDD6" }}><Check className="w-3 h-3 shrink-0" style={{ color: "#A855F7" }} />{t}</li>)}</ul>
            </div>
          </div>
        </div>
      </section>

      {/* ══ 4 SIMPLE STEPS (reference 2) ═══════════════════════════════════════ */}
      <section className="py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#A855F7" }}>How it works</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">From idea to Pin in 4 simple steps.</h2>
            <p className="text-[14px] max-w-xl mx-auto" style={{ color: "#8B93A1" }}>Go from a Pinterest demand signal to a planned, review-ready Pin — without the guesswork.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {STEPS.map((s, i) => (
              <div key={s.n} className="relative rounded-2xl border p-6 transition-transform hover:-translate-y-1" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.08)" }}>
                {i < STEPS.length - 1 && <div className="hidden lg:block absolute top-1/2 -right-2 z-10 h-5 w-5 rounded-full items-center justify-center" style={{ background: "var(--surface)" }}><ArrowRight className="w-4 h-4" style={{ color: "#4B5563" }} /></div>}
                <div className="flex items-center justify-between mb-4">
                  <span className="h-10 w-10 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,rgba(217,70,239,0.18),rgba(124,58,237,0.18))", color: "#E879F9" }}><s.icon className="w-5 h-5" /></span>
                  <span className="text-[28px] font-black leading-none" style={{ color: "rgba(255,255,255,0.06)", ...MONO }}>{s.n}</span>
                </div>
                <p className="text-[15px] font-bold text-white mb-2">{s.title}</p>
                <p className="text-[12px] leading-relaxed" style={{ color: "#8B93A1" }}>{s.desc}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center"><Link href="/app/discover?demo=true" className={`${VibeBtn} inline-flex items-center gap-2 px-7 py-3.5 text-[14px]`}>Start your free workflow <ArrowRight className="w-4 h-4" /></Link></div>
        </div>
      </section>

      {/* ══ INTELLIGENCE ═══════════════════════════════════════════════════════ */}
      <section id="intelligence" className="py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1060px] mx-auto px-5 grid lg:grid-cols-[0.8fr_1.2fr] gap-10 items-center">
          <div>
            <div className="flex items-center gap-2 mb-3"><span className="h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-black" style={{ background: "rgba(8,145,178,0.15)", color: "#38BDF8" }}>1</span><p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "#38BDF8" }}>Intelligence</p></div>
            <h2 className="text-3xl font-black text-white tracking-tight mb-3">Start with Pinterest demand signals.</h2>
            <p className="text-[14px] leading-relaxed mb-5" style={{ color: "#8B93A1" }}>Discover keywords and topics ranked by demand, competition, and trend direction.</p>
            <Link href="/app/discover?demo=true" className="inline-flex items-center gap-1.5 text-[13px] font-bold rounded-full border px-4 py-2 transition-colors hover:text-white hover:border-cyan-500/40" style={{ color: "#38BDF8", borderColor: "rgba(8,145,178,0.30)" }}>View all opportunities <ArrowRight className="w-3.5 h-3.5" /></Link>
          </div>
          <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)" }}>
            <div className="hidden sm:grid items-center px-5 py-2.5 border-b" style={{ gridTemplateColumns: "1fr 4.5rem 5rem 4rem 4rem", gap: "0.75rem", borderColor: "rgba(255,255,255,0.06)", background: "#0A0E16" }}>
              {["keyword / topic", "demand", "competition", "trend", "score"].map(h => <span key={h} className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: "#374151", ...MONO }}>{h}</span>)}
            </div>
            {INTEL_ROWS.map(r => (
              <div key={r.rank} className="grid items-center px-5 py-3 border-b last:border-0 transition-colors hover:bg-white/[0.02]" style={{ gridTemplateColumns: "1fr 4.5rem 5rem 4rem 4rem", gap: "0.75rem", borderColor: "rgba(255,255,255,0.04)" }}>
                <div className="flex items-center gap-2 min-w-0"><span className="text-[11px] tabular-nums" style={{ color: "#374151", ...MONO }}>{r.rank}</span><span className="text-[13px] font-semibold text-white truncate">{r.name}</span></div>
                <span className="text-[11px] font-bold tabular-nums text-emerald-400" style={MONO}>↗ {r.trend}</span>
                <Pill label={r.competition === "Low" ? "Low" : "Medium"} tone={r.competition === "Low" ? "green" : "amber"} />
                <svg viewBox="0 0 48 16" className="h-4 w-12" fill="none"><polyline points="0,13 10,11 20,12 30,5 40,7 48,3" stroke="#38BDF8" strokeWidth="1.6" /></svg>
                <ScoreChip score={r.score} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ PIN IDEAS ══════════════════════════════════════════════════════════ */}
      <section id="pin-ideas" className="py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="flex items-end justify-between gap-4 mb-6">
            <div>
              <div className="flex items-center gap-2 mb-3"><span className="h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-black" style={{ background: "rgba(217,70,239,0.15)", color: "#E879F9" }}>2</span><p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "#E879F9" }}>Pin Ideas</p></div>
              <h2 className="text-3xl font-black text-white tracking-tight mb-2">Find Pin formats before you create.</h2>
              <p className="text-[14px] leading-relaxed max-w-md" style={{ color: "#8B93A1" }}>Save the references, layouts, and angles that already fit Pinterest behavior.</p>
            </div>
            <Link href="/app/discover?demo=true" className="hidden sm:inline-flex items-center gap-1.5 text-[12px] font-bold transition-opacity hover:opacity-80 shrink-0" style={{ color: "#E879F9" }}>Explore all ideas <ArrowRight className="w-3.5 h-3.5" /></Link>
          </div>
          <Rail accent="#E879F9">
            {PIN_IDEAS.map((p, i) => (
              <div key={i} className="snap-start shrink-0 rounded-xl overflow-hidden group/pin transition-transform hover:-translate-y-1" style={{ width: 188, background: "#0C1018", border: "1px solid rgba(255,255,255,0.08)" }}>
                <div className="relative" style={{ aspectRatio: "3/4" }}>
                  <Image src={u(p.img, 280, 373)} alt={p.title} fill className="object-cover transition-transform duration-500 group-hover/pin:scale-105" sizes="188px" unoptimized />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/10" />
                  <span className="absolute top-1.5 left-1.5 rounded-full px-2 py-0.5 text-[8px] font-bold" style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.30)" }}>{p.format}</span>
                  <span className="absolute top-1.5 right-1.5 h-6 w-6 rounded-full flex items-center justify-center opacity-0 group-hover/pin:opacity-100 transition-opacity" style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)" }}><Bookmark className="w-3 h-3 text-white" /></span>
                  {p.overlay && <p className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[13px] font-black text-white leading-tight whitespace-pre-line" style={{ textShadow: "0 1px 6px rgba(0,0,0,0.6)", ...SERIF }}>{p.overlay}</p>}
                </div>
                <div className="p-2.5">
                  <p className="text-[11px] font-bold text-white leading-tight mb-2 line-clamp-1">{p.title}</p>
                  <div className="flex flex-wrap gap-1"><Pill label={p.demand === "High Demand" ? "High signal" : "Rising"} tone="green" /><Pill label={p.competition === "Low Competition" ? "Low comp" : "Moderate"} tone={p.competition === "Low Competition" ? "cyan" : "amber"} /></div>
                </div>
              </div>
            ))}
          </Rail>
        </div>
      </section>

      {/* ══ PRODUCT OPPORTUNITIES ══════════════════════════════════════════════ */}
      <section id="products" className="py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="flex items-end justify-between gap-4 mb-6">
            <div>
              <div className="flex items-center gap-2 mb-3"><span className="h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-black" style={{ background: "rgba(16,185,129,0.15)", color: "#10B981" }}>3</span><p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "#10B981" }}>Product Opportunities</p></div>
              <h2 className="text-3xl font-black text-white tracking-tight mb-2">Find products worth promoting.</h2>
              <p className="text-[14px] leading-relaxed max-w-md" style={{ color: "#8B93A1" }}>Discover physical and digital products with real Pinterest demand behind them.</p>
            </div>
            <Link href="/app/discover?demo=true" className="hidden sm:inline-flex items-center gap-1.5 text-[12px] font-bold transition-opacity hover:opacity-80 shrink-0" style={{ color: "#10B981" }}>Explore all products <ArrowRight className="w-3.5 h-3.5" /></Link>
          </div>
          <Rail accent="#10B981">
            {PRODUCT_IDEAS.map((p, i) => {
              const ts = typeStyle(p.type);
              return (
                <div key={i} className="snap-start shrink-0 rounded-xl overflow-hidden transition-transform hover:-translate-y-1" style={{ width: 188, background: "#0C1018", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="relative" style={{ aspectRatio: "1/1" }}>
                    <Image src={u(p.img, 280, 280)} alt={p.title} fill className="object-cover" sizes="188px" unoptimized />
                    <span className="absolute top-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: ts.bg, color: ts.color }}>{p.type}</span>
                  </div>
                  <div className="p-2.5">
                    <p className="text-[11px] font-bold text-white leading-tight mb-0.5 line-clamp-1">{p.title}</p>
                    <p className="text-[9px] font-bold mb-1.5" style={{ color: srcColor(p.source) }}>{p.source} · <span style={{ color: "#E5E7EB", ...MONO }}>{p.price}</span></p>
                    <div className="flex flex-wrap gap-1 mb-2"><Pill label={p.demand === "High Demand" ? "High Demand" : "Rising"} tone="green" /><Pill label={p.competition === "Low Competition" ? "Low Comp" : "Moderate"} tone={p.competition === "Low Competition" ? "cyan" : "amber"} /></div>
                    <div className="flex items-center gap-3 text-[9px] font-semibold pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", color: "#6B7280" }}><span className="flex items-center gap-1 hover:text-white transition-colors"><Bookmark className="w-2.5 h-2.5" /> Save</span><span className="flex items-center gap-1 hover:text-white transition-colors"><ImageIcon className="w-2.5 h-2.5" /> Use in Pins</span></div>
                  </div>
                </div>
              );
            })}
          </Rail>
        </div>
      </section>

      {/* ══ CREATE + PLAN ══════════════════════════════════════════════════════ */}
      <section id="create" className="py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-9">
            <div className="inline-flex items-center gap-2 mb-3"><span className="h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-black" style={{ background: "rgba(251,146,60,0.15)", color: "#FB923C" }}>4</span><p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "#FB923C" }}>Create + Plan</p></div>
            <h2 className="text-3xl font-black text-white tracking-tight mb-2">Create product-aware Pins, then plan the week.</h2>
            <p className="text-[14px] leading-relaxed max-w-xl mx-auto" style={{ color: "#8B93A1" }}>Add products and references, generate Pinterest-native drafts, and drop the best ones into your weekly plan — you review every Pin.</p>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StepCard icon={<Plus className="w-4 h-4" />} accent="#FB923C" label="Add products">
              <div className="grid grid-cols-2 gap-1.5">{PLAN_STEP.products.concat("add").slice(0, 4).map((id, i) => id === "add" ? <div key={i} className="rounded-lg flex items-center justify-center" style={{ aspectRatio: "1/1", border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-4 h-4" /></div> : <div key={i} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "1/1" }}><Image src={u(id, 90, 90)} alt="" fill className="object-cover" sizes="90px" unoptimized /></div>)}</div>
            </StepCard>
            <StepCard icon={<ImageIcon className="w-4 h-4" />} accent="#E879F9" label="Add references">
              <div className="grid grid-cols-2 gap-1.5">{PLAN_STEP.refs.concat("add").slice(0, 4).map((id, i) => id === "add" ? <div key={i} className="rounded-lg flex items-center justify-center" style={{ aspectRatio: "1/1", border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}><Plus className="w-4 h-4" /></div> : <div key={i} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "1/1" }}><Image src={u(id, 90, 90)} alt="" fill className="object-cover" sizes="90px" unoptimized /></div>)}</div>
            </StepCard>
            <StepCard icon={<Wand2 className="w-4 h-4" />} accent="#A855F7" label="Generate Pins">
              <div className="grid grid-cols-2 gap-1.5">{PLAN_STEP.gen.map((id, i) => <div key={i} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "3/4" }}><Image src={u(id, 90, 120)} alt="" fill className="object-cover" sizes="90px" unoptimized /><div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" /></div>)}</div>
            </StepCard>
            <StepCard icon={<CalendarDays className="w-4 h-4" />} accent="#38BDF8" label="Plan your week">
              <div className="space-y-1.5">{PLAN_STEP.plan.map((d, i) => <div key={i} className="flex items-center gap-2 rounded-lg p-1.5" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.06)" }}><div className="relative rounded overflow-hidden shrink-0" style={{ width: 26, height: 26 }}><Image src={u(d.img, 52, 52)} alt="" fill className="object-cover" sizes="26px" unoptimized /></div><div className="min-w-0"><p className="text-[9px] font-bold text-white leading-none">{d.day}</p><p className="text-[8px] mt-0.5" style={{ color: "#4B5563" }}>10:00 AM</p></div></div>)}</div>
            </StepCard>
          </div>
          <div className="mt-6 text-center"><Link href="/app/discover?demo=true" className={`${VibeBtn} inline-flex items-center gap-2 px-7 py-3.5 text-[14px]`}>See it in action <ArrowRight className="w-4 h-4" /></Link></div>
        </div>
      </section>

      {/* ══ USE VIBEPIN FOR (tabbed) ═══════════════════════════════════════════ */}
      <section className="py-20 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }} onMouseEnter={() => setUseCaseHover(true)} onMouseLeave={() => setUseCaseHover(false)}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-8"><p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#A855F7" }}>Use VibePin for</p><h2 className="text-3xl font-black text-white tracking-tight">Built for your kind of Pinterest.</h2></div>
          <div className="flex items-center justify-center gap-2 mb-7 flex-wrap">
            {USE_CASES.map((c, i) => <button key={c.cat} type="button" onClick={() => setUcIndex(i)} className="rounded-full px-4 py-2 text-[12px] font-semibold transition-all" style={i === ucIndex ? { background: "linear-gradient(135deg,#D946EF,#7C3AED)", color: "#fff" } : { background: "rgba(255,255,255,0.04)", color: "#9097A0", border: "1px solid rgba(255,255,255,0.08)" }}>{c.cat}</button>)}
          </div>
          <div key={uc.cat} className="rounded-2xl border overflow-hidden grid lg:grid-cols-[0.85fr_1.15fr]" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)" }}>
            <div className="p-7 flex flex-col justify-center">
              <h3 className="text-2xl font-black text-white tracking-tight mb-3">{uc.headline}</h3>
              <p className="text-[14px] leading-relaxed mb-5" style={{ color: "#8B93A1" }}>{uc.desc}</p>
              <div className="rounded-xl p-3.5 mb-5" style={{ background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.20)" }}><p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#C4B5FD" }}>The workflow</p><p className="text-[12px] leading-relaxed" style={{ color: "#C8CDD6" }}>{uc.workflow}</p></div>
              <Link href="/app/discover?demo=true" className="inline-flex items-center gap-1.5 text-[13px] font-bold" style={{ color: "#E879F9" }}>Explore {uc.cat} <ArrowRight className="w-3.5 h-3.5" /></Link>
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-3" style={{ background: "#0A0E16" }}>{uc.imgs.map((id, i) => <div key={i} className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "3/4" }}><Image src={u(id, 220, 293)} alt={uc.cat} fill className="object-cover" sizes="220px" unoptimized /><div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" /></div>)}</div>
          </div>
        </div>
      </section>

      {/* ══ TESTIMONIALS ═══════════════════════════════════════════════════════ */}
      <section className="py-20 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }} onMouseEnter={() => setTestHover(true)} onMouseLeave={() => setTestHover(false)}>
        <div className="max-w-[1000px] mx-auto px-5">
          <div className="text-center mb-8"><p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#E879F9" }}>What creators say</p><h2 className="text-3xl font-black text-white tracking-tight">Loved by creators, sellers, and agencies.</h2></div>
          <div className="flex items-center justify-center gap-2 mb-8">{TEST_GROUPS.map(g => <button key={g} type="button" onClick={() => setTestGroup(g)} className="rounded-full px-4 py-1.5 text-[12px] font-semibold transition-all" style={g === testGroup ? { background: "rgba(217,70,239,0.18)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.35)" } : { background: "rgba(255,255,255,0.04)", color: "#9097A0", border: "1px solid rgba(255,255,255,0.08)" }}>{g}</button>)}</div>
          {tCard && (
            <div key={testGroup + tIndex} className="max-w-2xl mx-auto rounded-2xl border p-8 text-center" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)" }}>
              <div className="flex justify-center gap-0.5 mb-4">{[...Array(5)].map((_, i) => <Star key={i} className="w-4 h-4" style={{ color: "#FB923C", fill: "#FB923C" }} />)}</div>
              <p className="text-[18px] font-semibold text-white leading-relaxed mb-6" style={SERIF}>&ldquo;{tCard.quote}&rdquo;</p>
              <div className="flex items-center justify-center gap-3"><span className="h-10 w-10 rounded-full flex items-center justify-center text-[14px] font-black text-white" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}>{tCard.name.charAt(0)}</span><div className="text-left"><p className="text-[13px] font-bold text-white">{tCard.name}</p><p className="text-[11px]" style={{ color: "#6B7280" }}>{tCard.role}</p></div></div>
              <div className="flex justify-center gap-1.5 mt-6">{filteredTests.map((_, i) => <button key={i} type="button" onClick={() => setTIndex(i)} aria-label={`Testimonial ${i + 1}`} className="h-1.5 rounded-full transition-all" style={{ width: i === tIndex % filteredTests.length ? 20 : 6, background: i === tIndex % filteredTests.length ? "#E879F9" : "rgba(255,255,255,0.15)" }} />)}</div>
            </div>
          )}
          <p className="text-center text-[10px] mt-4" style={{ color: "#374151" }}>Illustrative customer quotes — replace with verified testimonials before launch.</p>
        </div>
      </section>

      {/* ══ PRICING ════════════════════════════════════════════════════════════ */}
      <section id="pricing" className="py-20 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-9">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#4B5563" }}>Pricing</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-5">Choose the plan that grows with you.</h2>
            <div className="inline-flex items-center gap-1 rounded-full border p-1.5" style={{ background: "#080C12", borderColor: "rgba(255,255,255,0.08)" }}>
              {[{ label: "Monthly", val: false }, { label: "Yearly", val: true }].map(o => <button key={o.label} type="button" onClick={() => setYearly(o.val)} className="rounded-full px-5 py-2 text-[13px] font-bold transition-all flex items-center gap-2" style={yearly === o.val ? { background: "var(--surface-2)", color: "#E5E7EB" } : { color: "#4B5563" }}>{o.label}{o.val && <span className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}>Save 20%</span>}</button>)}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch">
            {PRICING.map(c => (
              <div key={c.plan} className="relative flex flex-col rounded-2xl p-6 transition-transform hover:-translate-y-1" style={c.highlighted ? { background: "linear-gradient(180deg,rgba(124,58,237,0.14),rgba(217,70,239,0.05))", border: "1px solid rgba(168,85,247,0.40)" } : { background: "var(--surface-2)", border: "1px solid rgba(255,255,255,0.08)" }}>
                {c.highlighted && <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[10px] font-bold text-white" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}>Most popular</span>}
                <p className="text-[12px] font-bold uppercase tracking-widest mb-3" style={{ color: "#9097A0" }}>{c.plan}</p>
                <div className="flex items-end gap-1 mb-1"><span className="text-4xl font-black text-white" style={MONO}>{yearly ? c.yearly : c.monthly}</span><span className="pb-1.5 text-sm" style={{ color: "#4B5563" }}>{c.period}</span></div>
                <p className="text-[12px] mb-5 leading-relaxed" style={{ color: "#6B7280" }}>{c.desc}</p>
                <ul className="flex-1 space-y-2.5 mb-6">{c.features.map(f => <li key={f} className="flex items-start gap-2.5 text-[12px]"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: c.highlighted ? "#A855F7" : "#10B981" }} /><span style={{ color: "#C8CDD6" }}>{f}</span></li>)}</ul>
                <button type="button" onClick={() => router.push(c.planKey === "free" ? "/app/discover?demo=true" : `/signup?plan=${c.planKey}`)} className={`w-full rounded-full py-3 text-[13px] font-bold transition-all ${c.highlighted ? VibeBtn : "border hover:text-white hover:border-white/30"}`} style={c.highlighted ? {} : { borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }}>{c.cta}</button>
              </div>
            ))}
          </div>
          <p className="text-center text-[11px] mt-6" style={{ color: "#4B5563" }}>No credit card required · Cancel anytime</p>
        </div>
      </section>

      {/* ══ FAQ ════════════════════════════════════════════════════════════════ */}
      <section className="py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-2xl mx-auto px-5">
          <h2 className="text-3xl font-black text-white tracking-tight text-center mb-8">Questions, answered.</h2>
          <div className="space-y-2.5">{FAQ.map(f => <FaqItem key={f.q} q={f.q} a={f.a} />)}</div>
        </div>
      </section>

      {/* ══ FINAL CTA ══════════════════════════════════════════════════════════ */}
      <section className="py-24 relative overflow-hidden border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 50% 60% at 50% 50%, rgba(217,70,239,0.12), transparent 70%)" }} />
        <div className="max-w-2xl mx-auto px-5 text-center relative">
          <h2 className="text-4xl sm:text-5xl font-black text-white tracking-tight mb-4 leading-[1.05]">Ready to find what&apos;s worth making?</h2>
          <p className="text-[15px] mb-9" style={{ color: "#8B93A1" }}>Build your next 7 Pins and plan your week — all in one intelligent workflow.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/app/discover?demo=true" className={`${VibeBtn} flex items-center justify-center gap-2 px-9 py-4 text-[15px]`}>Build my next 7 Pins <ArrowRight className="w-4 h-4" /></Link>
            <a href="#intelligence" className="flex items-center justify-center gap-2 rounded-full border px-9 py-4 text-[15px] font-bold transition-colors hover:text-white hover:border-white/30" style={{ borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }}>See this week&apos;s opportunities</a>
          </div>
          <p className="mt-5 text-[11px]" style={{ color: "#4B5563" }}>No credit card required · You review every Pin before publishing</p>
        </div>
      </section>

      {/* ══ FOOTER ═════════════════════════════════════════════════════════════ */}
      <footer className="border-t pt-14 pb-8" style={{ borderColor: "rgba(255,255,255,0.07)", background: "var(--surface)" }}>
        <div className="max-w-[1200px] mx-auto px-5 grid grid-cols-2 md:grid-cols-5 gap-8 mb-10">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-3"><BrandLogo size={28} /><span className="font-black text-white text-sm tracking-tight">VibePin</span></div>
            <p className="text-[11px] leading-relaxed mb-4" style={{ color: "#4B5563" }}>AI-powered Pinterest workflow for creators and businesses.</p>
            <div className="flex items-center gap-3">{["P", "I", "Y", "T"].map(s => <span key={s} className="h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors hover:text-white" style={{ background: "rgba(255,255,255,0.05)", color: "#4B5563" }}>{s}</span>)}</div>
          </div>
          {[
            { title: "Product", links: [["Intelligence", "#intelligence"], ["Pin Ideas", "#pin-ideas"], ["Product Opportunities", "#products"], ["Create Pins", "#create"], ["Pricing", "#pricing"]] },
            { title: "Company", links: [["About", "#"], ["Blog", "#"], ["Careers", "#"], ["Contact", "mailto:support@vibepin.co"]] },
            { title: "Resources", links: [["Help Center", "#"], ["Tutorials", "#"], ["Pinterest Guide", "#"]] },
            { title: "Legal", links: [["Privacy", "/privacy"], ["Terms", "/terms"], ["Pinterest App", "/pinterest-app"]] },
          ].map(col => (
            <div key={col.title}>
              <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: "#4B5563" }}>{col.title}</p>
              <ul className="space-y-2.5">{col.links.map(([l, h]) => <li key={l}><a href={h} className="text-[12px] transition-colors hover:text-gray-300" style={{ color: "#5B6472" }}>{l}</a></li>)}</ul>
            </div>
          ))}
        </div>
        <div className="max-w-[1200px] mx-auto px-5 border-t pt-6 flex flex-col sm:flex-row justify-between gap-2 text-[11px]" style={{ borderColor: "rgba(255,255,255,0.06)", color: "#374151" }}>
          <p>© 2026 VibePin. Find it. Create it. Plan it.</p>
          <p>You review every Pin before publishing</p>
        </div>
      </footer>

      {/* ══ STICKY CTA ═════════════════════════════════════════════════════════ */}
      <div className={`fixed bottom-0 left-0 right-0 z-50 border-t backdrop-blur-md px-5 py-3 flex items-center justify-between gap-4 transition-all duration-300 ${showSticky ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"}`} style={{ background: "rgba(8,12,18,0.95)", borderColor: "rgba(255,255,255,0.09)" }}>
        <p className="font-bold text-white text-[13px] hidden sm:block">Find it. Create it. Plan your Pinterest week.</p>
        <p className="font-bold text-white text-[12px] sm:hidden">Plan your Pinterest week</p>
        <Link href="/app/discover?demo=true" className={`${VibeBtn} shrink-0 px-5 py-2.5 text-[13px]`}>Build my next 7 Pins</Link>
      </div>
    </div>
  );
}
