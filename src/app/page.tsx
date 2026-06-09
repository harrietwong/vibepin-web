"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, TrendingUp, TrendingDown, Minus, Check,
  Database, Package, BarChart2, Clock, Zap, Target, Sparkles,
  ChevronRight, AlertTriangle, ShieldCheck,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type TagKey          = "hidden_supply" | "new_account_friendly" | "oversaturated" | "low_volume";
type Momentum        = "surging" | "steady" | "declining";
type MonLevel        = "HIGH" | "MID" | "LOW";
type SatStatus       = "blue_ocean" | "early_trend" | "saturated" | "avoid";
type TerminalTab     = "discover" | "viral" | "products";

interface OpportunityRow {
  rank: number; keyword: string; tag: TagKey;
  vol: string; yoy: string; momentum: Momentum;
  score: number; cat: string;
  vel: string;        // save velocity e.g. "3.2K/wk"
  mon: MonLevel;      // monetization level
  monRange: string;   // "$30–$90"
}
interface DecisionCard {
  keyword: string; score: number; tag: TagKey;
  why: string[]; monetization: string[]; actions: string[];
}
interface SatEntry {
  keyword: string; status: SatStatus; score: number;
  reasons: string[]; rec: string;
}
interface ViralPin {
  src: string; saves: string; vel: string; cat: string;
  format: string; domain: string;
}
interface ProductRow {
  name: string; domain: string; price: string; score: number;
  keyword: string; affiliate: MonLevel;
}
type PinFormat = "Close-up" | "Moodboard" | "Text Overlay" | "Tutorial" | "Blog Style" | "Lifestyle";
interface PinIdea {
  title: string; format: PinFormat; imgId: string;
  demand: "High Demand" | "Rising" | "Evergreen";
  competition: "Low Competition" | "Moderate"; saves: string;
}
interface ProductIdea {
  title: string; source: "Etsy" | "Shopify" | "Gumroad";
  productType: "Physical" | "Digital" | "Printable";
  category: string; price: string; score: number;
  demand: "High Demand" | "Rising"; competition: "Low Competition" | "Moderate"; imgId: string;
}
interface PlanDay {
  day: string; date: number; title: string; board: string;
  time: string; status: "Ready" | "Needs details" | "Planned"; imgId: string;
}

// ── Config maps ───────────────────────────────────────────────────────────────
const TAG: Record<TagKey, { label: string; bg: string; color: string; dot: string }> = {
  hidden_supply:        { label: "Blue Ocean",  bg: "rgba(8,145,178,0.15)",   color: "#38BDF8", dot: "#0891B2" },
  new_account_friendly: { label: "Early Trend", bg: "rgba(217,119,6,0.15)",   color: "#FCD34D", dot: "#D97706" },
  oversaturated:        { label: "Saturated",   bg: "rgba(220,38,38,0.15)",   color: "#F87171", dot: "#DC2626" },
  low_volume:           { label: "Avoid",       bg: "rgba(107,114,128,0.15)", color: "#9CA3AF", dot: "#6B7280" },
};

const MON: Record<MonLevel, { color: string; bg: string }> = {
  HIGH: { color: "#10B981", bg: "rgba(16,185,129,0.12)"  },
  MID:  { color: "#F59E0B", bg: "rgba(245,158,11,0.12)"  },
  LOW:  { color: "#6B7280", bg: "rgba(107,114,128,0.12)" },
};

const SAT: Record<SatStatus, { label: string; color: string; bg: string; border: string }> = {
  blue_ocean:  { label: "Blue Ocean",  color: "#38BDF8", bg: "rgba(8,145,178,0.08)",   border: "rgba(8,145,178,0.22)"   },
  early_trend: { label: "Early Trend", color: "#FCD34D", bg: "rgba(217,119,6,0.08)",   border: "rgba(217,119,6,0.22)"   },
  saturated:   { label: "Saturated",   color: "#F87171", bg: "rgba(220,38,38,0.08)",   border: "rgba(220,38,38,0.22)"   },
  avoid:       { label: "Avoid",       color: "#9CA3AF", bg: "rgba(107,114,128,0.08)", border: "rgba(107,114,128,0.22)" },
};

function scoreColor(s: number) {
  if (s >= 80) return "#10B981";
  if (s >= 60) return "#F59E0B";
  return "#EF4444";
}

const u = (id: string, w: number, h: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=${h}&q=80`;

// ── Demo data ─────────────────────────────────────────────────────────────────
const HERO_ROWS: OpportunityRow[] = [
  { rank: 1, keyword: "boho living room",          tag: "hidden_supply",        vol: "450K", yoy: "+214%", momentum: "surging",  score: 94, cat: "Home Decor", vel: "3.2K/wk", mon: "HIGH", monRange: "$30–$90"  },
  { rank: 2, keyword: "cottagecore kitchen decor",  tag: "new_account_friendly", vol: "180K", yoy: "+156%", momentum: "surging",  score: 87, cat: "Home Decor", vel: "2.1K/wk", mon: "HIGH", monRange: "$20–$60"  },
  { rank: 3, keyword: "quiet luxury aesthetic",     tag: "hidden_supply",        vol: "320K", yoy: "+310%", momentum: "surging",  score: 81, cat: "Fashion",    vel: "1.8K/wk", mon: "HIGH", monRange: "$50–$200" },
  { rank: 4, keyword: "japandi interior design",    tag: "new_account_friendly", vol: "95K",  yoy: "+98%",  momentum: "steady",   score: 74, cat: "Home Decor", vel: "0.9K/wk", mon: "MID",  monRange: "$40–$120" },
  { rank: 5, keyword: "dark academia bedroom",      tag: "new_account_friendly", vol: "210K", yoy: "+127%", momentum: "surging",  score: 68, cat: "Lifestyle",  vel: "1.4K/wk", mon: "MID",  monRange: "$25–$80"  },
];

const DECISION_CARDS: DecisionCard[] = [
  {
    keyword: "boho living room", score: 94, tag: "hidden_supply",
    why: ["Save velocity accelerating at 3.2K saves/wk", "Supply still fragmented — no dominant sellers", "Pinterest carousel format underutilized in niche"],
    monetization: ["Etsy decor items ($30–$90 avg)", "Amazon home goods affiliate links", "Roundup blog posts + AdSense"],
    actions: ["Create 3-Pin carousel batch in Studio", "Use lifestyle scene format (highest saves)", "Target Etsy buyers with #boho #homedecor"],
  },
  {
    keyword: "quiet luxury aesthetic", score: 81, tag: "hidden_supply",
    why: ["YoY growth of +310% — still early", "High buyer intent (premium price tolerance)", "Few sellers have nailed the visual format yet"],
    monetization: ["High-end fashion affiliate ($50–$200)", "Curated product roundups", "LTK / affiliate networks"],
    actions: ["Focus on moodboard format (performs best)", "Source from Nordstrom / Net-a-Porter affiliate", "Post 5+ Pins in first 2 weeks to build authority"],
  },
  {
    keyword: "cottagecore kitchen decor", score: 87, tag: "new_account_friendly",
    why: ["New account friendly — low competition density", "Trending at +156% YoY with room to run", "Strong seasonal amplification (spring + fall)"],
    monetization: ["Etsy vintage / handmade items ($20–$60)", "Amazon kitchen accessories (high volume)", "DIY tutorial pins (AdSense + affiliate)"],
    actions: ["Start with 3 product spotlights this week", "Add seasonal timing tag for autumn push", "Mix product pins with how-to format"],
  },
];

const SAT_ENTRIES: SatEntry[] = [
  { keyword: "cottagecore kitchen decor", status: "blue_ocean",  score: 87, reasons: ["Low seller density vs. high search intent", "Save velocity growing +156% YoY", "Few quality Pins currently in the feed"], rec: "Enter now — post 5+ this week to claim early position." },
  { keyword: "quiet luxury aesthetic",    status: "early_trend", score: 81, reasons: ["Accelerating fast but still discoverable", "High-intent buyers with premium price tolerance", "Competition will catch up within 60–90 days"], rec: "Build position immediately before competition peaks." },
  { keyword: "dark academia bedroom",     status: "early_trend", score: 68, reasons: ["Growing steadily, niche is still accessible", "Strong engagement from student/college audience", "Low monetization ceiling limits ROI"], rec: "Worth testing — low risk, moderate reward." },
  { keyword: "wall art aesthetic",        status: "saturated",   score: 31, reasons: ["Extreme seller competition — thousands of Pins daily", "Low conversion efficiency despite high save counts", "Affiliate ROI declining as CPCs rise"], rec: "Avoid. Use long-tail variations like 'gallery wall boho' instead." },
  { keyword: "home organization ideas",  status: "avoid",        score: 14, reasons: ["Completely dominated by large accounts", "Save decay rate accelerating — trend fatigue", "Near-zero affiliate opportunity vs. effort"], rec: "Skip entirely. Redirect energy to emerging niches." },
];

const TERMINAL_ROWS: OpportunityRow[] = [
  ...HERO_ROWS,
  { rank: 6, keyword: "coastal grandmother style", tag: "hidden_supply", vol: "140K", yoy: "+89%", momentum: "steady", score: 62, cat: "Fashion", vel: "0.7K/wk", mon: "MID", monRange: "$35–$120" },
];

const VIRAL_PINS: ViralPin[] = [
  { src: u("1586023492125-27b2c045efd7", 300, 450), saves: "38.2K", vel: "+3.1K/wk", cat: "Home Decor", format: "Lifestyle Scene",  domain: "etsy.com"    },
  { src: u("1515886657613-9f3515b0c78f", 300, 450), saves: "22.8K", vel: "+1.8K/wk", cat: "Fashion",    format: "Product Collage", domain: "amazon.com"  },
  { src: u("1573408301185-9519f945b18d", 300, 450), saves: "18.4K", vel: "+2.4K/wk", cat: "Jewelry",    format: "Product Spot",    domain: "etsy.com"    },
  { src: u("1596462502278-27bfdc403348", 300, 450), saves: "15.1K", vel: "+0.9K/wk", cat: "Beauty",     format: "Moodboard",       domain: "sephora.com" },
  { src: u("1490645935967-10de6ba17061", 300, 450), saves: "12.9K", vel: "+1.2K/wk", cat: "Home Decor", format: "How to Style",    domain: "wayfair.com" },
  { src: u("1504257432389-52343af06ae3", 300, 450), saves: "11.7K", vel: "+0.7K/wk", cat: "Lifestyle",  format: "Lifestyle Scene",  domain: "blog.com"   },
];

const PRODUCTS_TABLE: ProductRow[] = [
  { name: "Ceramic Wave Vase",   domain: "etsy.com",    price: "$34", score: 94, keyword: "boho living room",      affiliate: "HIGH" },
  { name: "Linen Throw Blanket", domain: "wayfair.com", price: "$67", score: 81, keyword: "coastal grandmother",   affiliate: "HIGH" },
  { name: "Rattan Wall Mirror",  domain: "amazon.com",  price: "$52", score: 78, keyword: "japandi interior",      affiliate: "MID"  },
  { name: "Soy Candle Set",      domain: "etsy.com",    price: "$28", score: 71, keyword: "cottagecore kitchen",   affiliate: "MID"  },
];

const PRODUCT_SIGNALS = [
  { name: "Ceramic Wave Vase — Matte Sage", domain: "etsy.com",           price: "$34", saves: "38.2K", score: 94, keyword: "boho living room",      affiliate: "HIGH" as MonLevel },
  { name: "Linen Throw Blanket — Oatmeal",  domain: "wayfair.com",        price: "$67", saves: "22.8K", score: 81, keyword: "coastal grandmother",   affiliate: "HIGH" as MonLevel },
  { name: "Rattan Wall Mirror 24\"",         domain: "amazon.com",         price: "$52", saves: "18.4K", score: 78, keyword: "japandi interior",      affiliate: "MID"  as MonLevel },
  { name: "Soy + Beeswax Candle Set",        domain: "etsy.com",           price: "$28", saves: "15.1K", score: 71, keyword: "cottagecore kitchen",   affiliate: "MID"  as MonLevel },
  { name: "Minimalist Bookend Pair",         domain: "urbanoutfitters.com", price: "$42", saves: "12.9K", score: 63, keyword: "dark academia bedroom", affiliate: "LOW"  as MonLevel },
];

const PIN_IDEAS: PinIdea[] = [
  { title: "Neutral Nails Inspo",                  format: "Close-up",     imgId: "1573408301185-9519f945b18d", demand: "High Demand", competition: "Low Competition", saves: "12.4K" },
  { title: "Cozy Bedroom Aesthetic",               format: "Moodboard",    imgId: "1586023492125-27b2c045efd7", demand: "Rising",      competition: "Low Competition", saves: "8.7K"  },
  { title: "5 Morning Habits That Shift Everything",format: "Text Overlay", imgId: "1504257432389-52343af06ae3", demand: "High Demand", competition: "Moderate",       saves: "22.1K" },
  { title: "Japandi Living Room Ideas",            format: "Lifestyle",    imgId: "1600585154340-be6161a56a0c", demand: "Rising",      competition: "Low Competition", saves: "15.3K" },
  { title: "Iced Matcha Step-by-Step",             format: "Tutorial",     imgId: "1490645935967-10de6ba17061", demand: "Rising",      competition: "Low Competition", saves: "9.8K"  },
  { title: "Small Room Office Setup",              format: "Blog Style",   imgId: "1515886657613-9f3515b0c78f", demand: "High Demand", competition: "Low Competition", saves: "18.6K" },
];

const PRODUCT_IDEAS: ProductIdea[] = [
  { title: "Minimalist Wall Art Set",   source: "Etsy",    productType: "Printable", category: "Home Decor",       price: "$12–$28", score: 91, demand: "High Demand", competition: "Low Competition", imgId: "1490645935967-10de6ba17061" },
  { title: "Boho Rattan Pendant Light", source: "Etsy",    productType: "Physical",  category: "Home Decor",       price: "$45–$89", score: 87, demand: "High Demand", competition: "Low Competition", imgId: "1586023492125-27b2c045efd7" },
  { title: "Printable Daily Planner",   source: "Gumroad", productType: "Printable", category: "Printables",       price: "$7–$15",  score: 82, demand: "Rising",      competition: "Low Competition", imgId: "1504257432389-52343af06ae3" },
  { title: "Notion Finance Tracker",    source: "Gumroad", productType: "Digital",   category: "Digital Products", price: "$15–$29", score: 78, demand: "Rising",      competition: "Low Competition", imgId: "1515886657613-9f3515b0c78f" },
  { title: "Gold Hoop Earrings",        source: "Etsy",    productType: "Physical",  category: "Jewelry",          price: "$24–$68", score: 85, demand: "High Demand", competition: "Low Competition", imgId: "1573408301185-9519f945b18d" },
  { title: "Fantasy Map Pack Assets",   source: "Gumroad", productType: "Digital",   category: "Digital Products", price: "$8–$22",  score: 73, demand: "Rising",      competition: "Low Competition", imgId: "1596462502278-27bfdc403348" },
];

const WEEKLY_PLAN: PlanDay[] = [
  { day: "Mon", date: 9,  title: "Boho Living Room Ideas",    board: "Living Room", time: "10:00 AM", status: "Ready",         imgId: "1586023492125-27b2c045efd7" },
  { day: "Tue", date: 10, title: "Small Space Storage Hacks", board: "Home Ideas",  time: "08:30 AM", status: "Ready",         imgId: "1490645935967-10de6ba17061" },
  { day: "Wed", date: 11, title: "Cottagecore Kitchen Inspo", board: "Home Decor",  time: "11:00 AM", status: "Needs details", imgId: "1513694153872-ec09ab67aab2" },
  { day: "Thu", date: 12, title: "Quiet Luxury Outfits",      board: "Fashion",     time: "07:00 PM", status: "Ready",         imgId: "1515886657613-9f3515b0c78f" },
  { day: "Fri", date: 13, title: "Japandi Bedroom Inspo",     board: "Bedroom",     time: "09:00 AM", status: "Planned",       imgId: "1600585154340-be6161a56a0c" },
  { day: "Sat", date: 14, title: "Desk Setup Aesthetic",      board: "Home Office", time: "09:00 AM", status: "Ready",         imgId: "1504257432389-52343af06ae3" },
  { day: "Sun", date: 15, title: "Weekend Moodboard",         board: "Lifestyle",   time: "11:30 AM", status: "Planned",       imgId: "1596462502278-27bfdc403348" },
];

const TREND_TICKERS = [
  { emoji: "🔥", name: "Moody Home Decor",     yoy: "+214%", mon: "HIGH" },
  { emoji: "🌿", name: "Boho Living Room",      yoy: "+87%",  mon: "HIGH" },
  { emoji: "🖼️", name: "Wall Art Decor",       yoy: "+145%", mon: "LOW — saturated" },
  { emoji: "✨", name: "Coastal Minimalism",   yoy: "+193%", mon: "HIGH" },
  { emoji: "🕯️", name: "Cottagecore Kitchen", yoy: "+120%", mon: "HIGH" },
  { emoji: "💎", name: "Quiet Luxury Style",   yoy: "+310%", mon: "HIGH" },
  { emoji: "🌸", name: "Soft Romantic Decor",  yoy: "+176%", mon: "MID"  },
  { emoji: "🪨", name: "Japandi Interiors",    yoy: "+98%",  mon: "MID"  },
];

const PRICING = [
  {
    plan: "Free", monthly: "$0", yearly: "$0", period: "", planKey: "free",
    desc: "See the top signals. Validate your first bet.",
    features: ["Top 3 opportunities / day", "Limited product view (5 items)", "Limited Pin Ideas (9 items)", "Pinterest sandbox publish"],
    highlighted: false, cta: "Start free",
  },
  {
    plan: "Creator", monthly: "$19", yearly: "$15", period: "/mo", planKey: "creator",
    desc: "Full intelligence access for solo operators.",
    features: ["Full Discover feed (all 18 categories)", "Pin Idea analysis + save velocity", "Basic Product Signals database", "150 Studio credits / month"],
    highlighted: false, cta: "Choose Creator",
  },
  {
    plan: "Growth", monthly: "$49", yearly: "$39", period: "/mo", planKey: "growth",
    desc: "Full monetization layer for scaling stores.",
    features: ["Everything in Creator", "Full monetization signals + affiliate map", "Product + keyword CSV export", "Trend velocity alerts + weekly batch planner"],
    highlighted: true, cta: "Choose Growth",
  },
  {
    plan: "Agency", monthly: "$99", yearly: "$79", period: "/mo", planKey: "pro",
    desc: "Multi-account intelligence for agencies.",
    features: ["Everything in Growth", "API access (read-only signals)", "Team workspace (3 seats)", "White-label opportunity reports"],
    highlighted: false, cta: "Talk to us",
  },
];

const FAQ = [
  { q: "Where does the data come from?", a: "VibePin runs a 5-stage data pipeline: interest discovery → trend keyword collection → Pin signal analysis → product discovery → multi-dimensional scoring. All signals come from Pinterest's public data and official Trends API — not user-submitted inputs, not estimates." },
  { q: "How is the opportunity score calculated?", a: "Each keyword is scored across four dimensions: trend momentum (YoY + weekly growth), save velocity (new saves per unit time), competitive density (estimated seller saturation), and data freshness. High score = high demand + low seller saturation. The score is not a popularity metric — it's a timing signal." },
  { q: "What does the Monetization signal mean?", a: "The monetization signal (HIGH / MID / LOW) estimates affiliate and resale potential based on the product price range of items that appear in the top-saving Pins for that keyword, the domain mix (Etsy / Amazon / specialty boutique), and the conversion patterns we observe across similar niches. HIGH means $30+ avg products with established affiliate programs." },
  { q: "Is this different from Pinterest's own Trends tool?", a: "Yes. Pinterest Trends shows what's trending but gives no competitive context, no product-level data, no scoring, and no 'avoid' signals. VibePin specifically tells you which niches are too crowded, which ones are still early, and what the monetization ceiling looks like — before you spend time creating content." },
  { q: "Do I need to connect Pinterest to see intelligence data?", a: "No. Discover, Pin Ideas, and Product Signals are all read-only. No Pinterest connection required. You only connect your account when you're ready to publish through Studio." },
  { q: "How often is the data refreshed?", a: "The pipeline runs daily. Save velocity uses a rolling 7-day window. The freshness timestamp in the app reflects the last completed scrape cycle." },
];

// ── Shared micro-components ───────────────────────────────────────────────────
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace" };

function MomentumIcon({ level }: { level: Momentum }) {
  if (level === "surging")   return <TrendingUp   className="w-2.5 h-2.5 text-emerald-400" />;
  if (level === "declining") return <TrendingDown className="w-2.5 h-2.5 text-red-400" />;
  return                            <Minus        className="w-2.5 h-2.5 text-gray-500" />;
}

function ScoreBar({ score, delay = 0, width = 56 }: { score: number; delay?: number; width?: number }) {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setPct(score), delay + 250);
    return () => clearTimeout(t);
  }, [score, delay]);
  const color = scoreColor(score);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 rounded-full overflow-hidden" style={{ width, background: "rgba(255,255,255,0.07)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color, transition: "width 0.65s cubic-bezier(0.4,0,0.2,1)" }} />
      </div>
      <span className="text-[11px] font-black tabular-nums w-5 text-right" style={{ ...MONO, color }}>{score}</span>
    </div>
  );
}

function TagBadge({ tag, size = "sm" }: { tag: TagKey; size?: "xs" | "sm" }) {
  const t = TAG[tag];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-bold leading-none whitespace-nowrap ${
        size === "xs" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]"
      }`}
      style={{ background: t.bg, color: t.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: t.dot }} />
      {t.label}
    </span>
  );
}

function MonBadge({ level, range }: { level: MonLevel; range?: string }) {
  const m = MON[level];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold leading-none whitespace-nowrap"
      style={{ background: m.bg, color: m.color }}
    >
      {level}{range ? ` ${range}` : ""}
    </span>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
      <button
        type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between py-5 text-left text-[15px] font-semibold transition-colors hover:text-white"
        style={{ color: "#D1D5DB" }}
      >
        {q}
        <span className={`ml-4 text-xl leading-none transition-transform duration-200 shrink-0 ${open ? "rotate-45" : ""}`} style={{ color: "#4B5563" }}>+</span>
      </button>
      {open && <p className="pb-6 text-sm leading-relaxed max-w-2xl" style={{ color: "#6B7280" }}>{a}</p>}
    </div>
  );
}

// ── Hero Leaderboard ──────────────────────────────────────────────────────────
function HeroLeaderboard() {
  return (
    <div className="rounded-2xl border overflow-hidden shadow-2xl" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
      {/* Terminal chrome */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-[10px] font-bold tracking-[0.16em] uppercase" style={{ color: "#4B5563", ...MONO }}>opportunity_feed · today</span>
        </div>
        <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>updated 3h ago</span>
      </div>

      {/* Column headers — desktop */}
      <div className="hidden sm:grid items-center px-4 py-2 border-b"
        style={{ gridTemplateColumns: "1.2rem 1fr 5.5rem 2.8rem 3.5rem 4.5rem", gap: "0.5rem", borderColor: "rgba(255,255,255,0.05)" }}>
        {["#", "keyword + velocity", "tier", "yoy", "mon.", "score"].map(h => (
          <span key={h} className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: "#374151", ...MONO }}>{h}</span>
        ))}
      </div>

      {/* Rows */}
      {HERO_ROWS.map((row, i) => (
        <Link key={row.rank} href="/app/discover?demo=true" className="no-underline block group/row"
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
          {/* Desktop row */}
          <div className="hidden sm:grid items-center px-4 py-2.5 border-b last:border-0"
            style={{ gridTemplateColumns: "1.2rem 1fr 5.5rem 2.8rem 3.5rem 4.5rem", gap: "0.5rem", borderColor: "rgba(255,255,255,0.04)" }}>
            <span className="text-[10px] font-black tabular-nums" style={{ color: "#374151", ...MONO }}>{row.rank}</span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold capitalize truncate" style={{ color: "#E5E7EB" }}>{row.keyword}</p>
              <p className="text-[9px] mt-0.5 flex items-center gap-1" style={{ color: "#4B5563" }}>
                <MomentumIcon level={row.momentum} />
                <span style={MONO}>{row.vel} saves</span>
              </p>
            </div>
            <TagBadge tag={row.tag} size="xs" />
            <span className="text-[11px] font-bold tabular-nums text-emerald-400" style={MONO}>{row.yoy}</span>
            <MonBadge level={row.mon} />
            <ScoreBar score={row.score} delay={i * 80} />
          </div>
          {/* Mobile row */}
          <div className="sm:hidden flex items-center gap-3 px-4 py-2.5 border-b last:border-0" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
            <span className="text-[10px] font-black tabular-nums w-4 shrink-0" style={{ color: "#374151", ...MONO }}>{row.rank}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold capitalize truncate" style={{ color: "#E5E7EB" }}>{row.keyword}</p>
              <p className="text-[9px] mt-0.5 flex items-center gap-2" style={{ color: "#4B5563" }}>
                <TagBadge tag={row.tag} size="xs" />
                <span style={{ color: "#10B981", ...MONO }}>{row.yoy}</span>
              </p>
            </div>
            <ScoreBar score={row.score} delay={i * 80} width={40} />
          </div>
        </Link>
      ))}

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-3 border-t" style={{ borderColor: "rgba(255,255,255,0.05)", background: "#0A1210" }}>
        <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>18 categories · 48 opportunities ranked today</span>
        <Link href="/app/discover?demo=true" className="flex items-center gap-1 text-[10px] font-bold transition-colors hover:text-cyan-400" style={{ color: "#0891B2" }}>
          View all <ArrowRight className="w-2.5 h-2.5" />
        </Link>
      </div>
    </div>
  );
}

// ── Terminal panels ───────────────────────────────────────────────────────────
function DiscoverPanel() {
  return (
    <div style={{ maxHeight: 360, overflow: "auto" }}>
      <div className="hidden sm:grid items-center px-4 py-2 border-b"
        style={{ gridTemplateColumns: "1.2rem 1fr 5.5rem 2.8rem 3.5rem 4.5rem", gap: "0.5rem", borderColor: "rgba(255,255,255,0.05)" }}>
        {["#", "keyword", "tier", "yoy", "mon.", "score"].map(h => (
          <span key={h} className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: "#374151", ...MONO }}>{h}</span>
        ))}
      </div>
      {TERMINAL_ROWS.map((row, i) => (
        <div key={row.rank}
          className="grid items-center px-4 py-2.5 border-b last:border-0 cursor-pointer"
          style={{ gridTemplateColumns: "1.2rem 1fr 5.5rem 2.8rem 3.5rem 4.5rem", gap: "0.5rem", borderColor: "rgba(255,255,255,0.04)", transition: "background 0.12s ease" }}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
          <span className="text-[10px] font-black tabular-nums" style={{ color: "#374151", ...MONO }}>{row.rank}</span>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold capitalize truncate" style={{ color: "#E5E7EB" }}>{row.keyword}</p>
            <p className="text-[9px] mt-0.5" style={{ color: "#4B5563", ...MONO }}>{row.vel} saves/wk</p>
          </div>
          <TagBadge tag={row.tag} size="xs" />
          <span className="text-[11px] font-bold tabular-nums text-emerald-400" style={MONO}>{row.yoy}</span>
          <MonBadge level={row.mon} />
          <ScoreBar score={row.score} delay={i * 60} />
        </div>
      ))}
    </div>
  );
}

function ViralPanel() {
  const formats = ["All Formats", "Close-up", "Moodboard", "Lifestyle", "Text Overlay", "Tutorial", "Blog Style"];
  const [activeFormat, setActiveFormat] = useState("All Formats");
  const filtered = activeFormat === "All Formats" ? PIN_IDEAS : PIN_IDEAS.filter(p => p.format === activeFormat);
  const display = filtered.length > 0 ? filtered : PIN_IDEAS;
  return (
    <div style={{ maxHeight: 380, overflow: "auto" }}>
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b overflow-x-auto" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
        {formats.map(f => (
          <button key={f} type="button" onClick={() => setActiveFormat(f)}
            className="rounded-full px-2.5 py-1 text-[10px] font-semibold whitespace-nowrap shrink-0 transition-all"
            style={activeFormat === f
              ? { background: "rgba(217,70,239,0.18)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.30)" }
              : { background: "rgba(255,255,255,0.04)", color: "#4B5563", border: "1px solid rgba(255,255,255,0.07)" }}>
            {f}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 p-4">
        {display.map((idea, i) => (
          <div key={i} className="relative rounded-xl overflow-hidden cursor-pointer group/pin" style={{ aspectRatio: "2/3" }}>
            <Image src={u(idea.imgId, 300, 450)} alt="" fill className="object-cover transition-transform duration-500 group-hover/pin:scale-105" sizes="110px" unoptimized />
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/15 to-transparent" />
            <div className="absolute top-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[8px] font-bold"
              style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", color: "#D1D5DB" }}>
              {idea.format}
            </div>
            <div className="absolute top-1.5 right-1.5 rounded-full px-1.5 py-0.5 text-[7px] font-bold"
              style={{ background: idea.demand === "High Demand" ? "rgba(16,185,129,0.25)" : "rgba(8,145,178,0.25)",
                       color: idea.demand === "High Demand" ? "#10B981" : "#38BDF8" }}>
              {idea.demand === "High Demand" ? "↑ High" : "Rising"}
            </div>
            <div className="absolute bottom-0 left-0 right-0 p-2">
              <p className="text-[9px] font-bold text-white leading-tight mb-1 line-clamp-2">{idea.title}</p>
              <div className="flex items-center justify-between">
                <span className="text-[7px] font-semibold" style={{ color: idea.competition === "Low Competition" ? "#10B981" : "#F59E0B" }}>
                  {idea.competition === "Low Competition" ? "Low Comp" : "Moderate"}
                </span>
                <span className="text-[8px] font-black text-white">💾 {idea.saves}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductsPanel() {
  const categories = ["All Categories", "Home Decor", "Jewelry", "Printables", "Digital Products"];
  const [activeCat, setActiveCat] = useState("All Categories");
  const filtered = activeCat === "All Categories" ? PRODUCT_IDEAS : PRODUCT_IDEAS.filter(p => p.category === activeCat);
  const display = filtered.length > 0 ? filtered : PRODUCT_IDEAS;
  const srcColor = (src: string) => src === "Etsy" ? "#F87171" : src === "Gumroad" ? "#A78BFA" : "#60A5FA";
  const typeColor = (t: string) => t === "Physical" ? "#FCD34D" : t === "Printable" ? "#38BDF8" : "#C4B5FD";
  const typeBg   = (t: string) => t === "Physical" ? "rgba(245,158,11,0.20)" : t === "Printable" ? "rgba(8,145,178,0.20)" : "rgba(139,92,246,0.20)";
  return (
    <div style={{ maxHeight: 380, overflow: "auto" }}>
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b overflow-x-auto" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
        {categories.map(c => (
          <button key={c} type="button" onClick={() => setActiveCat(c)}
            className="rounded-full px-2.5 py-1 text-[10px] font-semibold whitespace-nowrap shrink-0 transition-all"
            style={activeCat === c
              ? { background: "rgba(16,185,129,0.18)", color: "#10B981", border: "1px solid rgba(16,185,129,0.30)" }
              : { background: "rgba(255,255,255,0.04)", color: "#4B5563", border: "1px solid rgba(255,255,255,0.07)" }}>
            {c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 p-4">
        {display.map((prod, i) => (
          <div key={i} className="rounded-xl overflow-hidden cursor-pointer group/prod"
            style={{ background: "#080E0B", border: "1px solid rgba(255,255,255,0.06)", transition: "border-color 0.15s ease" }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(16,185,129,0.25)")}
            onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)")}>
            <div className="relative" style={{ aspectRatio: "1/1" }}>
              <Image src={u(prod.imgId, 200, 200)} alt="" fill className="object-cover" sizes="100px" unoptimized />
              <div className="absolute top-1 right-1 rounded-full px-1.5 py-0.5 text-[7px] font-bold"
                style={{ background: "rgba(0,0,0,0.78)", color: srcColor(prod.source), backdropFilter: "blur(4px)" }}>
                {prod.source}
              </div>
              <div className="absolute top-1 left-1 rounded-full px-1.5 py-0.5 text-[7px] font-bold"
                style={{ background: typeBg(prod.productType), color: typeColor(prod.productType) }}>
                {prod.productType}
              </div>
            </div>
            <div className="p-2">
              <p className="text-[10px] font-bold text-white leading-tight mb-0.5 line-clamp-2">{prod.title}</p>
              <p className="text-[10px] font-black mb-1" style={{ color: "#E5E7EB", ...MONO }}>{prod.price}</p>
              <div className="flex flex-wrap gap-1">
                <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold"
                  style={{ background: "rgba(16,185,129,0.15)", color: "#10B981" }}>
                  {prod.demand === "High Demand" ? "↑ Demand" : "Rising"}
                </span>
                <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold"
                  style={{ background: "rgba(8,145,178,0.15)", color: "#38BDF8" }}>
                  Low Comp
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Pin Ideas full section ────────────────────────────────────────────────────
function PinIdeasSection() {
  const formats = ["All Formats", "Close-up", "Moodboard", "Lifestyle", "Text Overlay", "Tutorial", "Blog Style"];
  const [activeFormat, setActiveFormat] = useState("All Formats");
  const filtered = activeFormat === "All Formats" ? PIN_IDEAS : PIN_IDEAS.filter(p => p.format === activeFormat);
  const display = filtered.length > 0 ? filtered : PIN_IDEAS;
  return (
    <section id="pin-ideas" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className="max-w-[1060px] mx-auto px-5">
        <div className="mb-8">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#D946EF" }}>Pin Ideas</p>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
            Pin Ideas that match what people already save.
          </h2>
          <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
            Find Pinterest-native formats, layouts, and content angles before you create.
          </p>
        </div>

        <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "#D946EF" }} />
                <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: "#D946EF" }} />
              </span>
              <span className="text-[10px] font-bold tracking-[0.16em] uppercase" style={{ color: "#4B5563", ...MONO }}>pin_ideas_feed</span>
            </div>
            <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>save velocity tracked · daily refresh</span>
          </div>

          {/* Filter chips */}
          <div className="flex items-center gap-1.5 px-4 py-3 border-b overflow-x-auto" style={{ borderColor: "rgba(255,255,255,0.05)", background: "#0A1210" }}>
            {formats.map(f => (
              <button key={f} type="button" onClick={() => setActiveFormat(f)}
                className="rounded-full px-3 py-1.5 text-[11px] font-semibold whitespace-nowrap shrink-0 transition-all"
                style={activeFormat === f
                  ? { background: "rgba(217,70,239,0.18)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.35)" }
                  : { background: "rgba(255,255,255,0.04)", color: "#4B5563", border: "1px solid rgba(255,255,255,0.07)" }}>
                {f}
              </button>
            ))}
          </div>

          {/* Pin cards grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 p-5">
            {display.map((idea, i) => (
              <div key={i} className="relative rounded-xl overflow-hidden cursor-pointer group/pin" style={{ aspectRatio: "2/3" }}>
                <Image src={u(idea.imgId, 300, 450)} alt="" fill className="object-cover transition-transform duration-500 group-hover/pin:scale-105" sizes="160px" unoptimized />
                <div className="absolute inset-0 bg-gradient-to-t from-black/92 via-black/20 to-transparent" />
                <div className="absolute top-1.5 left-1.5 rounded-full px-2 py-0.5 text-[8px] font-bold"
                  style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", color: "#D1D5DB", border: "1px solid rgba(255,255,255,0.10)" }}>
                  {idea.format}
                </div>
                <div className="absolute top-1.5 right-1.5 rounded-full px-1.5 py-0.5 text-[7px] font-bold"
                  style={{ background: idea.demand === "High Demand" ? "rgba(16,185,129,0.28)" : "rgba(8,145,178,0.28)",
                           color: idea.demand === "High Demand" ? "#10B981" : "#38BDF8" }}>
                  {idea.demand === "High Demand" ? "↑ Demand" : "Rising"}
                </div>
                <div className="absolute bottom-0 left-0 right-0 p-2.5">
                  <p className="text-[9px] font-bold text-white leading-tight mb-1.5 line-clamp-2">{idea.title}</p>
                  <div className="flex items-center justify-between gap-1">
                    <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold"
                      style={{ background: idea.competition === "Low Competition" ? "rgba(16,185,129,0.18)" : "rgba(245,158,11,0.18)",
                               color: idea.competition === "Low Competition" ? "#10B981" : "#F59E0B" }}>
                      {idea.competition === "Low Competition" ? "Low Comp" : "Moderate"}
                    </span>
                    <span className="text-[8px] font-black text-white">💾 {idea.saves}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
            <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Save to References · Use as Pin reference</span>
            <Link href="/app/discover?demo=true"
              className="flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold text-white transition-opacity hover:opacity-80"
              style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}>
              Explore Pin Ideas <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Product Ideas full section ─────────────────────────────────────────────────
function ProductIdeasSection() {
  const categories = ["All Categories", "Home Decor", "Jewelry", "Printables", "Digital Products"];
  const [activeCat, setActiveCat] = useState("All Categories");
  const filtered = activeCat === "All Categories" ? PRODUCT_IDEAS : PRODUCT_IDEAS.filter(p => p.category === activeCat);
  const display = filtered.length > 0 ? filtered : PRODUCT_IDEAS;
  const srcColor = (src: string) => src === "Etsy" ? "#F87171" : src === "Gumroad" ? "#A78BFA" : "#60A5FA";
  const typeBg   = (t: string) => t === "Physical" ? "rgba(245,158,11,0.20)" : t === "Printable" ? "rgba(8,145,178,0.20)" : "rgba(139,92,246,0.20)";
  const typeColor= (t: string) => t === "Physical" ? "#FCD34D" : t === "Printable" ? "#38BDF8" : "#C4B5FD";
  return (
    <section id="product-ideas" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
      <div className="max-w-[1060px] mx-auto px-5">
        <div className="mb-8">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#10B981" }}>Product Ideas</p>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
            Product Ideas worth promoting or selling.
          </h2>
          <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
            Find physical and digital products with demand signals, low competition, and clear content angles.
          </p>
        </div>

        <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-[10px] font-bold tracking-[0.16em] uppercase" style={{ color: "#4B5563", ...MONO }}>product_ideas_feed</span>
            </div>
            <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>affiliate potential scored · daily refresh</span>
          </div>

          {/* Filter chips */}
          <div className="flex items-center gap-1.5 px-4 py-3 border-b overflow-x-auto" style={{ borderColor: "rgba(255,255,255,0.05)", background: "#0A1210" }}>
            {categories.map(c => (
              <button key={c} type="button" onClick={() => setActiveCat(c)}
                className="rounded-full px-3 py-1.5 text-[11px] font-semibold whitespace-nowrap shrink-0 transition-all"
                style={activeCat === c
                  ? { background: "rgba(16,185,129,0.18)", color: "#10B981", border: "1px solid rgba(16,185,129,0.35)" }
                  : { background: "rgba(255,255,255,0.04)", color: "#4B5563", border: "1px solid rgba(255,255,255,0.07)" }}>
                {c}
              </button>
            ))}
          </div>

          {/* Product cards grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 p-5">
            {display.map((prod, i) => (
              <div key={i} className="rounded-xl overflow-hidden cursor-pointer"
                style={{ background: "#080E0B", border: "1px solid rgba(255,255,255,0.07)", transition: "border-color 0.15s" }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(16,185,129,0.30)")}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)")}>
                <div className="relative" style={{ aspectRatio: "1/1" }}>
                  <Image src={u(prod.imgId, 200, 200)} alt="" fill className="object-cover" sizes="120px" unoptimized />
                  <div className="absolute top-1 right-1 rounded-full px-1.5 py-0.5 text-[7px] font-bold"
                    style={{ background: "rgba(0,0,0,0.80)", color: srcColor(prod.source), backdropFilter: "blur(4px)" }}>
                    {prod.source}
                  </div>
                  <div className="absolute top-1 left-1 rounded-full px-1.5 py-0.5 text-[7px] font-bold"
                    style={{ background: typeBg(prod.productType), color: typeColor(prod.productType) }}>
                    {prod.productType}
                  </div>
                </div>
                <div className="p-2.5">
                  <p className="text-[10px] font-bold text-white leading-tight mb-0.5 line-clamp-2">{prod.title}</p>
                  <p className="text-[11px] font-black mb-1.5" style={{ color: "#E5E7EB", ...MONO }}>{prod.price}</p>
                  <div className="flex flex-wrap gap-1">
                    <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold" style={{ background: "rgba(16,185,129,0.15)", color: "#10B981" }}>
                      {prod.demand === "High Demand" ? "↑ Demand" : "Rising"}
                    </span>
                    <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold" style={{ background: "rgba(8,145,178,0.15)", color: "#38BDF8" }}>
                      Low Comp
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
            <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Save to My Products · Use as product image</span>
            <Link href="/app/discover?demo=true"
              className="flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold text-white transition-opacity hover:opacity-80"
              style={{ background: "linear-gradient(135deg,#10B981,#0891B2)" }}>
              Explore Product Ideas <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Weekly Plan visual section ─────────────────────────────────────────────────
const STATUS_STYLE: Record<"Ready"|"Needs details"|"Planned", { bg: string; color: string }> = {
  "Ready":        { bg: "rgba(16,185,129,0.18)",  color: "#10B981" },
  "Needs details":{ bg: "rgba(245,158,11,0.18)",  color: "#F59E0B" },
  "Planned":      { bg: "rgba(8,145,178,0.18)",   color: "#38BDF8" },
};

function WeeklyPlanSection() {
  return (
    <section id="weekly-plan" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className="max-w-[1060px] mx-auto px-5">
        <div className="text-center mb-10">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Weekly Plan</p>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
            From ideas to 7 Pins in one weekly plan.
          </h2>
          <p className="max-w-xl mx-auto text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
            Select what is worth making, then organise the week visually.
          </p>
        </div>

        <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
          {/* Calendar header */}
          <div className="flex items-center justify-between px-5 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
            <div className="flex items-center gap-3">
              <span className="rounded-full px-3 py-1 text-[11px] font-semibold border" style={{ color: "#E5E7EB", borderColor: "rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)" }}>
                Jun 9 – Jun 15, 2026
              </span>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>This week</span>
            </div>
            <div className="flex items-center gap-2 text-[10px]" style={{ color: "#374151", ...MONO }}>
              {(["Ready","Needs details","Planned"] as const).map(s => (
                <span key={s} className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_STYLE[s].color }} />
                  {s}
                </span>
              ))}
            </div>
          </div>

          {/* 7-day columns */}
          <div className="overflow-x-auto">
            <div className="grid min-w-[700px]" style={{ gridTemplateColumns: "repeat(7,1fr)", gap: "1px", background: "rgba(255,255,255,0.05)" }}>
              {WEEKLY_PLAN.map((day, i) => (
                <div key={i} style={{ background: "#0C1410" }}>
                  {/* Day header */}
                  <div className="px-2 py-2 border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                    <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#4B5563" }}>{day.day}</p>
                    <p className="text-[18px] font-black text-white leading-none">{day.date}</p>
                  </div>
                  {/* Pin card */}
                  <div className="p-2">
                    <div className="relative rounded-lg overflow-hidden mb-2" style={{ aspectRatio: "4/5" }}>
                      <Image src={u(day.imgId, 160, 200)} alt="" fill className="object-cover" sizes="100px" unoptimized />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                    </div>
                    <p className="text-[9px] font-bold text-white leading-tight mb-1 line-clamp-2">{day.title}</p>
                    <p className="text-[8px] mb-1.5" style={{ color: "#4B5563" }}>{day.board} · {day.time}</p>
                    <span className="inline-block rounded-full px-2 py-0.5 text-[7px] font-bold"
                      style={{ background: STATUS_STYLE[day.status].bg, color: STATUS_STYLE[day.status].color }}>
                      {day.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Unscheduled row */}
          <div className="px-5 py-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-semibold shrink-0" style={{ color: "#4B5563", ...MONO }}>Unscheduled Ideas (3)</span>
              <div className="flex items-center gap-2 overflow-x-auto">
                {[
                  { imgId: "1513694153872-ec09ab67aab2", title: "Boho Art Print" },
                  { imgId: "1596462502278-27bfdc403348", title: "Skincare Routine" },
                  { imgId: "1573408301185-9519f945b18d", title: "Gold Jewellery" },
                ].map((item, i) => (
                  <div key={i} className="relative shrink-0 rounded-lg overflow-hidden" style={{ width: 36, height: 36 }}>
                    <Image src={u(item.imgId, 72, 72)} alt={item.title} fill className="object-cover" sizes="36px" unoptimized />
                  </div>
                ))}
                <div className="shrink-0 h-9 w-9 rounded-lg flex items-center justify-center text-[14px]"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px dashed rgba(255,255,255,0.10)", color: "#374151" }}>
                  +
                </div>
              </div>
            </div>
          </div>

          {/* Footer CTA */}
          <div className="flex items-center justify-between px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#080E0B" }}>
            <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Review each Pin before publishing · You confirm every action</span>
            <Link href="/app/discover?demo=true"
              className="btn-cta flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold text-white">
              Build my next 7 Pins <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── VibePin V mark ────────────────────────────────────────────────────────────
const VLogo = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 20 20" fill="none" style={{ width: size, height: size }} aria-hidden>
    <path d="M4 5.5L10 15L16 5.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ── Main ──────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const [showStickyCta, setShowStickyCta] = useState(false);
  const [yearlyBilling, setYearlyBilling] = useState(false);
  const [activeTab, setActiveTab]         = useState<TerminalTab>("discover");
  const router = useRouter();

  useEffect(() => {
    const h = () => setShowStickyCta(window.scrollY > 600);
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);

  return (
    <div className="lp min-h-screen antialiased" style={{ background: "var(--bg)", color: "var(--text)" }}>

      {/* ══ NAV ════════════════════════════════════════════════════════════════ */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md"
        style={{ background: "rgba(8,14,11,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
        <div className="max-w-[1280px] mx-auto px-5 h-[60px] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
              <VLogo size={14} />
            </div>
            <span className="font-black text-white tracking-tight text-[17px]">VibePin</span>
            <span className="hidden sm:inline ml-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest border"
              style={{ color: "#0891B2", borderColor: "rgba(8,145,178,0.25)", background: "rgba(8,145,178,0.08)" }}>
              Opportunity Terminal
            </span>
          </div>
          <div className="hidden md:flex items-center gap-7 text-[13px] font-medium" style={{ color: "#6B7280" }}>
            <a href="#terminal"      className="hover:text-white transition-colors">Intelligence</a>
            <a href="#pin-ideas"     className="hover:text-white transition-colors">Pin Ideas</a>
            <a href="#product-ideas" className="hover:text-white transition-colors">Product Ideas</a>
            <a href="#pricing"       className="hover:text-white transition-colors">Pricing</a>
          </div>
          <div className="flex items-center gap-2.5">
            <Link href="/login"
              className="hidden sm:inline text-[13px] font-medium border rounded-full px-4 py-1.5 transition-colors hover:text-white"
              style={{ color: "#6B7280", borderColor: "rgba(255,255,255,0.10)" }}>
              Log In
            </Link>
            <Link href="/app/discover?demo=true" className="btn-cta rounded-full px-4 py-2 text-[13px] font-bold text-white">
              Build my 7 Pins
            </Link>
          </div>
        </div>
      </nav>

      {/* ══ HERO ═══════════════════════════════════════════════════════════════ */}
      <section className="pt-16 pb-12 lg:pt-24 lg:pb-20 overflow-hidden">
        <div className="max-w-[1280px] mx-auto px-5 grid grid-cols-1 lg:grid-cols-[1fr_1.15fr] gap-10 lg:gap-14 items-start">

          {/* Left */}
          <div className="lg:pt-3">
            <div className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 mb-6"
              style={{ background: "rgba(8,145,178,0.08)", borderColor: "rgba(8,145,178,0.22)" }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-500" />
              </span>
              <span className="text-[11px] font-semibold tracking-wide" style={{ color: "#0891B2" }}>
                Pinterest Opportunity Terminal
              </span>
            </div>

            <h1 className="text-[2.6rem] sm:text-[3.4rem] lg:text-[3.8rem] font-black text-white leading-[1.04] tracking-[-0.04em] mb-5">
              Find Pinterest opportunities<br />worth creating before<br />the market gets crowded.
            </h1>

            <p className="text-[15px] sm:text-[17px] leading-relaxed mb-3 max-w-[480px]" style={{ color: "#8B9E97" }}>
              VibePin helps Pinterest creators, ecommerce sellers, and content marketers discover
              content opportunities, review demand and competition signals, create Pin drafts, and
              plan weekly Pinterest content.
            </p>
            <p className="text-[14px] font-semibold mb-8" style={{ color: "#4D5E58" }}>
              Not inspiration. Not volume. <span style={{ color: "#E5E7EB" }}>Evidence-backed opportunities.</span>
            </p>

            <div className="flex flex-col sm:flex-row gap-3 mb-8">
              <Link href="/app/discover?demo=true"
                className="btn-cta flex items-center justify-center gap-2 rounded-full px-7 py-3.5 text-[14px] font-bold text-white">
                Build my next 7 Pins
                <ArrowRight className="w-4 h-4" />
              </Link>
              <a href="#breakdown"
                className="flex items-center justify-center gap-2 rounded-full px-7 py-3.5 text-[14px] font-semibold border transition-colors hover:text-white"
                style={{ color: "#6B7280", borderColor: "rgba(255,255,255,0.12)" }}>
                See this week&apos;s opportunities
              </a>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {["Demand + competition signals", "Pin opportunity discovery", "You review every Pin before publishing"].map(item => (
                <span key={item} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4D5E58" }}>
                  <span className="h-1 w-1 rounded-full" style={{ background: "#374151" }} />
                  {item}
                </span>
              ))}
            </div>
          </div>

          {/* Right */}
          <div>
            <HeroLeaderboard />
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                { value: "18",     label: "categories tracked" },
                { value: "Daily",  label: "signal refresh"     },
                { value: "5-step", label: "data pipeline"      },
              ].map(s => (
                <div key={s.label} className="rounded-xl px-3 py-2.5 text-center border"
                  style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.06)" }}>
                  <p className="text-[15px] font-black text-white" style={MONO}>{s.value}</p>
                  <p className="text-[9px] mt-0.5 uppercase tracking-wider" style={{ color: "#374151" }}>{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══ PROOF BAR ══════════════════════════════════════════════════════════ */}
      <section className="border-y" style={{ borderColor: "rgba(255,255,255,0.07)", background: "var(--surface)" }}>
        <div className="max-w-[1280px] mx-auto px-5 py-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px" style={{ background: "rgba(255,255,255,0.06)" }}>
            {[
              { icon: Clock,    value: "Daily",   label: "Refreshed opportunity signals"         },
              { icon: Package,  value: "18",      label: "Categories tracked"                    },
              { icon: Database, value: "Signal",  label: "Opportunity scoring engine"            },
              { icon: BarChart2,value: "Demand",  label: "Competition + monetization indicators" },
            ].map(({ icon: Icon, value, label }) => (
              <div key={label} className="flex flex-col items-center text-center px-6 py-5" style={{ background: "var(--surface)" }}>
                <div className="h-8 w-8 rounded-lg flex items-center justify-center mb-3 border"
                  style={{ background: "rgba(8,145,178,0.10)", borderColor: "rgba(8,145,178,0.20)" }}>
                  <Icon className="h-4 w-4" style={{ color: "#0891B2" }} strokeWidth={1.8} />
                </div>
                <p className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-1" style={MONO}>{value}</p>
                <p className="text-[11px] font-medium" style={{ color: "#4D5E58" }}>{label}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="overflow-hidden border-t py-3" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#080E0B" }}>
          <div className="marquee-track text-[12px] font-semibold" style={{ color: "#4D5E58" }}>
            {[...TREND_TICKERS, ...TREND_TICKERS].map((t, i) => (
              <span key={i} className="inline-flex items-center gap-3 px-6">
                <span>{t.emoji} <span style={{ color: "#9CA3AF" }}>{t.name}</span></span>
                <span className="font-bold tabular-nums" style={{ color: "#10B981", ...MONO }}>YoY {t.yoy}</span>
                <span style={{ color: "#374151" }}>·</span>
                <span style={{ color: t.mon === "HIGH" ? "#10B981" : t.mon.includes("LOW") ? "#EF4444" : "#F59E0B" }}>
                  MON: {t.mon}
                </span>
                <span style={{ color: "#1F2937" }}>·</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ══ PROBLEM ════════════════════════════════════════════════════════════ */}
      <section className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[860px] mx-auto px-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-4" style={{ color: "#4D5E58" }}>The problem</p>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-8 leading-[1.1]">
            Pinterest rewards early movers.<br />Most tools reward content volume.
          </h2>
          <div className="space-y-5 mb-10">
            <p className="text-[15px] leading-relaxed" style={{ color: "#8B9E97" }}>
              Trends appear early on Pinterest — but they&apos;re invisible until they reach critical mass.
              By the time a niche looks obvious on Google Trends or in creator communities, it&apos;s already crowded on Pinterest.
              The window to stake an early position has closed.
            </p>
            <p className="text-[15px] leading-relaxed" style={{ color: "#8B9E97" }}>
              Content tools make this worse. They push you to produce more — more Pins, more formats, more variations.
              But volume without signal is noise. You spend time creating content for niches that are already saturated,
              while high-opportunity gaps go unnoticed because no one told you to look there.
            </p>
            <p className="text-[15px] leading-relaxed" style={{ color: "#8B9E97" }}>
              VibePin solves the upstream problem. Before you create anything, you need to know
              what&apos;s worth creating, when to enter, and whether the monetization ceiling justifies the effort.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex items-center gap-3 rounded-xl border px-5 py-4"
              style={{ background: "rgba(220,38,38,0.05)", borderColor: "rgba(220,38,38,0.15)" }}>
              <span className="text-[18px]">❌</span>
              <div>
                <p className="text-[13px] font-bold text-white">Generate more content</p>
                <p className="text-[11px] mt-0.5" style={{ color: "#4B5563" }}>Volume without signal is wasted effort</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border px-5 py-4"
              style={{ background: "rgba(8,145,178,0.06)", borderColor: "rgba(8,145,178,0.20)" }}>
              <span className="text-[18px]">✔</span>
              <div>
                <p className="text-[13px] font-bold text-white">Select what&apos;s worth making this week</p>
                <p className="text-[11px] mt-0.5" style={{ color: "#4D5E58" }}>Evidence first. Then create.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ KEYWORD BREAKDOWN PREVIEW ══════════════════════════════════════════ */}
      <section id="breakdown" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="mb-8">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Sample opportunity breakdown</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
              Why this opportunity is worth making.
            </h2>
            <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
              Each opportunity surfaces five signals: demand level, competition window, monetization path, Pin engagement evidence, and a ready-to-use content angle.
            </p>
          </div>

          <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
            {/* Card header */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
              <div className="flex items-center gap-3">
                <TagBadge tag="hidden_supply" />
                <span className="text-[16px] font-black text-white capitalize">boho living room</span>
                <MonBadge level="HIGH" range="$30–$90" />
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[11px] tabular-nums text-emerald-400" style={MONO}>+214% YoY</span>
                <ScoreBar score={94} />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1px_1fr] gap-0">
              {/* Left: Pin thumbnails */}
              <div className="p-5">
                <p className="text-[9px] font-bold uppercase tracking-widest mb-3" style={{ color: "#374151" }}>Pin engagement evidence — 3.2K saves/wk · demand confirmed</p>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { id: "1586023492125-27b2c045efd7", saves: "38K" },
                    { id: "1513694153872-ec09ab67aab2", saves: "22K" },
                    { id: "1490645935967-10de6ba17061", saves: "18K" },
                    { id: "1600585154340-be6161a56a0c", saves: "12K" },
                  ].map((pin, i) => (
                    <div key={i} className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "2/3" }}>
                      <Image
                        src={u(pin.id, 200, 300)} alt="" fill
                        className="object-cover" sizes="100px" unoptimized
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                      <div className="absolute bottom-1.5 left-1.5 right-1.5">
                        <p className="text-[8px] font-bold text-white">💾 {pin.saves}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 mt-3 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  <div className="flex items-center gap-1.5">
                    <MomentumIcon level="surging" />
                    <span className="text-[10px] text-emerald-400 font-semibold">Surging</span>
                  </div>
                  <span className="text-[10px]" style={{ color: "#374151" }}>·</span>
                  <span className="text-[10px]" style={{ color: "#4B5563" }}>Lifestyle Scene format performs best</span>
                </div>
              </div>

              {/* Divider */}
              <div className="hidden lg:block w-px" style={{ background: "rgba(255,255,255,0.06)" }} />

              {/* Right: Monetization + title templates */}
              <div className="p-5 pt-0 lg:pt-5">
                <p className="text-[9px] font-bold uppercase tracking-widest mb-3" style={{ color: "#374151" }}>Opportunity signals</p>
                <div className="space-y-0 mb-5">
                  {[
                    { label: "Demand signal",       value: "+214% YoY · Accelerating" },
                    { label: "Competition window",  value: "Blue Ocean — low seller density" },
                    { label: "Monetization path",   value: "Etsy + Amazon Affiliate" },
                    { label: "Avg price range",     value: "$30–$90 per item" },
                  ].map(row => (
                    <div key={row.label} className="flex items-center justify-between py-2 border-b" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
                      <span className="text-[10px]" style={{ color: "#4B5563" }}>{row.label}</span>
                      <span className="text-[11px] font-semibold text-white">{row.value}</span>
                    </div>
                  ))}
                </div>

                <p className="text-[9px] font-bold uppercase tracking-widest mb-3" style={{ color: "#374151" }}>Suggested content angle</p>
                <div className="space-y-2">
                  <div className="rounded-lg px-3 py-2.5 text-[11px] font-medium text-white" style={{ background: "rgba(8,145,178,0.10)", border: "1px solid rgba(8,145,178,0.20)" }}>
                    📌 10 Boho Living Room Ideas That Will Transform Your Space
                  </div>
                  {[
                    "The Boho Aesthetic: Complete Decor Guide for 2026",
                    "Boho Living Room on a Budget: Products Worth Saving",
                  ].map(t => (
                    <div key={t} className="relative rounded-lg px-3 py-2.5 text-[11px] overflow-hidden" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <span className="block text-[11px] select-none" style={{ filter: "blur(4px)", color: "#6B7280" }}>{t}</span>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-[9px] font-bold rounded-full px-2.5 py-1" style={{ background: "rgba(8,145,178,0.15)", color: "#38BDF8", border: "1px solid rgba(8,145,178,0.25)" }}>
                          🔒 Unlock
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer CTA */}
            <div className="flex items-center justify-between px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>18 categories · Unlimited breakdowns with full access</span>
              <Link href="/app/discover?demo=true"
                className="btn-cta flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold text-white">
                Explore demo <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ══ CORE SYSTEM — OPPORTUNITY TERMINAL ═════════════════════════════════ */}
      <section id="terminal" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="text-center mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>The intelligence system</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
              Three ranked feeds. One decision pipeline.
            </h2>
            <p className="max-w-xl mx-auto text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
              Each feed is scored, ranked, and linked to monetization potential. Browse opportunities. Check Pin evidence. Identify shoppable products.
            </p>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 rounded-xl p-1.5 mb-0 mx-auto w-fit border"
            style={{ background: "#080E0B", borderColor: "rgba(255,255,255,0.07)" }}>
            {(["discover", "viral", "products"] as TerminalTab[]).map(tab => {
              const labels: Record<TerminalTab, string> = {
                discover: "📡  Discover",
                viral:    "🔥  Pin Ideas",
                products: "🛒  Products",
              };
              return (
                <button key={tab} type="button" onClick={() => setActiveTab(tab)}
                  className="rounded-lg px-5 py-2.5 text-[13px] font-semibold transition-all"
                  style={activeTab === tab
                    ? { background: "var(--surface-2)", color: "#E5E7EB", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }
                    : { color: "#4B5563" }}>
                  {labels[tab]}
                </button>
              );
            })}
          </div>

          <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
            {/* Panel header */}
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <span className="text-[10px] font-bold tracking-[0.16em] uppercase" style={{ color: "#4B5563", ...MONO }}>
                  {activeTab === "discover" ? "keyword_opportunities" : activeTab === "viral" ? "pin_idea_intelligence" : "product_signals"}
                </span>
              </div>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>
                {activeTab === "discover" ? "48 results · scored + ranked" : activeTab === "viral" ? "save velocity tracked" : "affiliate potential scored"}
              </span>
            </div>

            {activeTab === "discover" && <DiscoverPanel />}
            {activeTab === "viral"    && <ViralPanel />}
            {activeTab === "products" && <ProductsPanel />}

            <div className="flex items-center justify-between px-4 py-3 border-t" style={{ borderColor: "rgba(255,255,255,0.05)", background: "#0A1210" }}>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Sample · Sign up for full access to all 18 categories</span>
              <Link href="/app/discover?demo=true" className="flex items-center gap-1 text-[10px] font-bold transition-colors hover:text-cyan-400" style={{ color: "#0891B2" }}>
                Open terminal <ArrowRight className="w-2.5 h-2.5" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <PinIdeasSection />
      <ProductIdeasSection />

      {/* ══ DECISION CARDS — "WHAT TO DO TODAY" ════════════════════════════════ */}
      <section id="decisions" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Decision layer</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
              Each opportunity comes with a ready-to-use action brief.
            </h2>
            <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
              Why now. What to monetize. Which format drives the highest saves.
              Everything you need to select your 7 ideas for the week.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {DECISION_CARDS.map((card, ci) => (
              <div key={card.keyword}
                className="rounded-2xl border flex flex-col overflow-hidden"
                style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
                {/* Card header */}
                <div className="px-5 py-4 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <TagBadge tag={card.tag} />
                    <ScoreBar score={card.score} delay={ci * 100} width={48} />
                  </div>
                  <p className="text-[14px] font-bold text-white capitalize">{card.keyword}</p>
                </div>

                {/* Why now */}
                <div className="px-5 py-3.5 border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  <p className="text-[9px] font-bold uppercase tracking-[0.14em] mb-2.5" style={{ color: "#374151" }}>Why now</p>
                  <ul className="space-y-1.5">
                    {card.why.map(w => (
                      <li key={w} className="flex items-start gap-2 text-[11px]" style={{ color: "#8B9E97" }}>
                        <span className="mt-1 h-1 w-1 rounded-full shrink-0" style={{ background: "#10B981" }} />
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Monetization */}
                <div className="px-5 py-3.5 border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  <p className="text-[9px] font-bold uppercase tracking-[0.14em] mb-2.5" style={{ color: "#374151" }}>Monetization</p>
                  <ul className="space-y-1.5">
                    {card.monetization.map(m => (
                      <li key={m} className="flex items-start gap-2 text-[11px]" style={{ color: "#8B9E97" }}>
                        <span className="mt-1 h-1 w-1 rounded-full shrink-0" style={{ background: "#F59E0B" }} />
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Recommended actions */}
                <div className="px-5 py-3.5 border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  <p className="text-[9px] font-bold uppercase tracking-[0.14em] mb-2.5" style={{ color: "#374151" }}>Recommended action</p>
                  <ul className="space-y-1.5">
                    {card.actions.map(a => (
                      <li key={a} className="flex items-start gap-2 text-[11px]" style={{ color: "#8B9E97" }}>
                        <ChevronRight className="w-3 h-3 shrink-0 mt-0.5" style={{ color: "#0891B2" }} />
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* CTAs */}
                <div className="flex gap-2 p-4 mt-auto">
                  <Link href="/app/discover?demo=true"
                    className="flex-1 rounded-full border py-2 text-center text-[11px] font-semibold transition-colors hover:border-white/25 hover:text-white"
                    style={{ borderColor: "rgba(255,255,255,0.10)", color: "#6B7280" }}>
                    View Pin evidence
                  </Link>
                  <Link href="/app/discover?demo=true"
                    className="flex-1 btn-cta rounded-full py-2 text-center text-[11px] font-bold text-white">
                    Add to weekly plan
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ SATURATION INTELLIGENCE ════════════════════════════════════════════ */}
      <section id="saturation" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Saturation intelligence</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
              Not every trend is worth chasing.
            </h2>
            <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
              VibePin tells you which niches to enter, which are past peak, and which to avoid entirely —
              based on competition density, save decay rate, and affiliate ROI signals.
            </p>
          </div>

          <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
            {/* Table header */}
            <div className="grid items-center px-5 py-3 border-b"
              style={{ gridTemplateColumns: "1fr 7.5rem 4.5rem", gap: "1rem", borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              {["keyword + reasoning", "status", "score"].map(h => (
                <span key={h} className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: "#374151", ...MONO }}>{h}</span>
              ))}
            </div>

            {SAT_ENTRIES.map((entry, i) => {
              const s = SAT[entry.status];
              const isGood = entry.status === "blue_ocean" || entry.status === "early_trend";
              return (
                <div key={entry.keyword}
                  className="grid items-start px-5 py-4 border-b last:border-0 cursor-pointer"
                  style={{ gridTemplateColumns: "1fr 7.5rem 4.5rem", gap: "1rem", borderColor: "rgba(255,255,255,0.04)", transition: "background 0.12s ease" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      {isGood
                        ? <ShieldCheck className="w-3.5 h-3.5 shrink-0" style={{ color: s.color }} />
                        : <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: s.color }} />
                      }
                      <p className="text-[13px] font-bold capitalize" style={{ color: "#E5E7EB" }}>{entry.keyword}</p>
                    </div>
                    <ul className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
                      {entry.reasons.map(r => (
                        <li key={r} className="flex items-center gap-1.5 text-[10px]" style={{ color: "#4B5563" }}>
                          <span className="h-1 w-1 rounded-full shrink-0" style={{ background: s.color, opacity: 0.6 }} />
                          {r}
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] italic" style={{ color: s.color }}>→ {entry.rec}</p>
                  </div>
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold whitespace-nowrap self-start"
                    style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
                    {s.label}
                  </span>
                  <div className="self-start pt-0.5">
                    <ScoreBar score={entry.score} delay={i * 60} width={48} />
                  </div>
                </div>
              );
            })}

            <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Saturation map updated daily · All 18 categories</span>
              <Link href="/app/discover?demo=true" className="flex items-center gap-1 text-[10px] font-bold transition-colors hover:text-cyan-400" style={{ color: "#0891B2" }}>
                Full saturation map <ArrowRight className="w-2.5 h-2.5" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <WeeklyPlanSection />

      {/* ══ DATA PIPELINE ══════════════════════════════════════════════════════ */}
      <section className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="rounded-2xl border p-8" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.07)" }}>
            <div className="flex flex-col lg:flex-row items-start lg:items-center gap-8">
              <div className="shrink-0">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-2" style={{ color: "#4D5E58" }}>Data pipeline</p>
                <p className="text-[22px] font-black text-white leading-tight">Powered by real Pinterest<br />signal ingestion.</p>
                <p className="text-[13px] mt-2" style={{ color: "#4D5E58" }}>Not user-submitted guesses.</p>
              </div>
              <div className="flex-1 overflow-x-auto">
                <div className="flex items-center gap-0 min-w-max">
                  {[
                    { label: "Trend Detection",  sub: "trend_interests"    },
                    { label: "Signal Collection", sub: "pin_samples"        },
                    { label: "Save Velocity",     sub: "7-day rolling"      },
                    { label: "Product Mapping",   sub: "pin_products"       },
                    { label: "Scoring Engine",    sub: "opportunity_score",  accent: true },
                  ].map((node, i) => (
                    <div key={node.label} className="flex items-center gap-0">
                      {i > 0 && <div className="w-5 h-px shrink-0" style={{ background: "rgba(255,255,255,0.12)" }} />}
                      <div className="rounded-xl border px-3 py-2.5 text-center"
                        style={{
                          background: node.accent ? "rgba(8,145,178,0.12)" : "var(--surface-2)",
                          borderColor: node.accent ? "rgba(8,145,178,0.30)" : "rgba(255,255,255,0.07)",
                          minWidth: 110,
                        }}>
                        <p className="text-[11px] font-bold" style={{ color: node.accent ? "#38BDF8" : "#E5E7EB" }}>{node.label}</p>
                        <p className="text-[9px] mt-0.5" style={{ color: "#374151", ...MONO }}>{node.sub}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ PRICING ════════════════════════════════════════════════════════════ */}
      <section id="pricing" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Access model</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
              You&apos;re buying intelligence access. Not credits.
            </h2>
            <p className="max-w-lg mx-auto text-[14px] leading-relaxed mb-6" style={{ color: "#6B7280" }}>
              Paid plans unlock signal depth — more categories, full monetization layer, exports, and alerts.
              Not usage caps that block your workflow.
            </p>
            <div className="inline-flex items-center gap-1 rounded-full border p-1.5"
              style={{ background: "#080E0B", borderColor: "rgba(255,255,255,0.08)" }}>
              {[{ label: "Monthly", val: false }, { label: "Yearly", val: true }].map(opt => (
                <button key={opt.label} type="button" onClick={() => setYearlyBilling(opt.val)}
                  className="rounded-full px-5 py-2 text-[13px] font-bold transition-all flex items-center gap-2"
                  style={yearlyBilling === opt.val
                    ? { background: "var(--surface-2)", color: "#E5E7EB" }
                    : { color: "#4B5563" }}>
                  {opt.label}
                  {opt.val && (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "#0891B2", color: "white" }}>–20%</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch">
            {PRICING.map(card => (
              <div key={card.plan}
                className="relative flex flex-col rounded-2xl p-7"
                style={card.highlighted
                  ? { background: "rgba(8,145,178,0.08)", border: "1px solid rgba(8,145,178,0.25)" }
                  : { background: "var(--surface-2)", border: "1px solid rgba(255,255,255,0.07)" }}>
                {card.highlighted && (
                  <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full px-4 py-1 text-[11px] font-bold"
                    style={{ background: "#0891B2", color: "white" }}>
                    Most popular
                  </span>
                )}
                <p className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: "#4D5E58" }}>{card.plan}</p>
                <div className="flex items-end gap-1 mb-1">
                  <span className="text-4xl font-black text-white" style={MONO}>{yearlyBilling ? card.yearly : card.monthly}</span>
                  <span className="pb-1.5 text-sm" style={{ color: "#4B5563" }}>{card.period}</span>
                </div>
                {yearlyBilling && card.monthly !== card.yearly && (
                  <p className="text-[11px] line-through mb-0.5" style={{ color: "#374151" }}>{card.monthly}{card.period}</p>
                )}
                <p className="text-[13px] mb-6" style={{ color: "#4B5563" }}>{card.desc}</p>
                <ul className="flex-1 space-y-2.5 mb-7">
                  {card.features.map(f => (
                    <li key={f} className="flex items-start gap-2.5 text-[13px]">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "#0891B2" }} />
                      <span style={{ color: "#8B9E97" }}>{f}</span>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => router.push(card.planKey === "free" ? "/app/discover?demo=true" : `/signup?plan=${card.planKey}`)}
                  className={`w-full rounded-full py-3 text-[13px] font-bold transition-colors ${card.highlighted ? "btn-cta text-white" : "border hover:text-white"}`}
                  style={card.highlighted ? {} : { borderColor: "rgba(255,255,255,0.12)", color: "#8B9E97" }}>
                  {card.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ FAQ ════════════════════════════════════════════════════════════════ */}
      <section className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-2xl mx-auto px-5">
          <div className="text-center mb-12">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>FAQ</p>
            <h2 className="text-3xl font-black text-white tracking-tight">About the data</h2>
          </div>
          {FAQ.map(item => <FaqItem key={item.q} q={item.q} a={item.a} />)}
        </div>
      </section>

      {/* ══ FINAL CTA ══════════════════════════════════════════════════════════ */}
      <section className="py-28 relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-80"
          style={{ background: "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(8,145,178,0.07) 0%, transparent 100%)" }} />
        <div className="max-w-2xl mx-auto px-5 text-center relative">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-4" style={{ color: "#0891B2" }}>
            Pinterest Opportunity Terminal
          </p>
          <h2 className="text-4xl sm:text-5xl font-black text-white tracking-tight mb-5 leading-[1.05]">
            Start with what is<br />worth creating.
          </h2>
          <p className="text-[15px] mb-10 leading-relaxed" style={{ color: "#6B7280" }}>
            Browse this week&apos;s ranked opportunities. Select the 7 that fit your niche.
            Walk away with a Pinterest plan backed by real signal.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/app/discover?demo=true"
              className="btn-cta flex items-center justify-center gap-2 rounded-full px-9 py-4 text-[14px] font-bold text-white">
              Build my next 7 Pins →
            </Link>
            <a href="#breakdown"
              className="flex items-center justify-center gap-2 rounded-full border px-9 py-4 text-[14px] font-bold transition-colors hover:text-white"
              style={{ borderColor: "rgba(255,255,255,0.12)", color: "#8B9E97" }}>
              See this week&apos;s opportunities
            </a>
          </div>
          <p className="mt-5 text-[11px]" style={{ color: "#374151" }}>
            Real Pinterest signals · Demand + saturation scored · No credit card for demo
          </p>
        </div>
      </section>

      {/* ══ FOOTER ═════════════════════════════════════════════════════════════ */}
      <footer className="border-t pt-14 pb-8" style={{ borderColor: "rgba(255,255,255,0.07)", background: "var(--surface)" }}>
        <div className="max-w-[1200px] mx-auto px-5 grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="h-7 w-7 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                <VLogo size={14} />
              </div>
              <span className="font-black text-white text-sm tracking-tight">VibePin</span>
            </div>
            <p className="text-[11px] leading-relaxed" style={{ color: "#374151" }}>
              VibePin helps creators and sellers discover Pinterest opportunities, create Pin drafts, and plan content with user review and approval.
            </p>
          </div>
          {[
            { title: "Intelligence", links: [
              { label: "Discover",        href: "#" },
              { label: "Trend Radar",     href: "#" },
              { label: "Product Signals", href: "#" },
              { label: "Pricing",         href: "#" },
            ]},
            { title: "Resources", links: [
              { label: "Blog",            href: "#" },
              { label: "Help Center",     href: "#" },
              { label: "Pinterest Guide", href: "#" },
            ]},
            { title: "Legal", links: [
              { label: "Privacy",         href: "/privacy" },
              { label: "Terms",           href: "/terms" },
              { label: "Pinterest App",   href: "/pinterest-app" },
              { label: "Contact",         href: "mailto:support@vibepin.co" },
            ]},
          ].map(col => (
            <div key={col.title}>
              <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: "#374151" }}>{col.title}</p>
              <ul className="space-y-2.5">
                {col.links.map(l => (
                  <li key={l.label}><a href={l.href} className="text-[12px] transition-colors hover:text-gray-300" style={{ color: "#374151" }}>{l.label}</a></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="max-w-[1200px] mx-auto px-5 border-t pt-6 flex flex-col sm:flex-row justify-between gap-2 text-[11px]"
          style={{ borderColor: "rgba(255,255,255,0.06)", color: "#374151" }}>
          <p>© 2026 VibePin. All rights reserved.</p>
          <p>5-stage Pinterest data pipeline · Updated every 3 hours · Real signals</p>
        </div>
      </footer>

      {/* ══ STICKY CTA ═════════════════════════════════════════════════════════ */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 border-t backdrop-blur-md px-5 py-3.5 flex items-center justify-between gap-4 transition-all duration-300 ${
          showStickyCta ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"
        }`}
        style={{ background: "rgba(8,14,11,0.95)", borderColor: "rgba(255,255,255,0.09)" }}>
        <div>
          <p className="font-bold text-white text-[13px]">48 ranked opportunities this week. Select 7. Build your Pin plan.</p>
          <p className="text-[11px] mt-0.5" style={{ color: "#374151" }}>No credit card required · Real Pinterest signals</p>
        </div>
        <Link href="/app/discover?demo=true" className="btn-cta shrink-0 rounded-full px-5 py-2.5 text-[13px] font-bold text-white">
          Build my 7 Pins
        </Link>
      </div>

    </div>
  );
}
