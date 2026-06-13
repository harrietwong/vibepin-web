"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, TrendingUp, Check, Sparkles, Plus, X,
  Clock, Package, Database, BarChart2, Bookmark, ImageIcon,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type PinFormat   = "Close-up" | "Moodboard" | "Lifestyle" | "Text Overlay" | "Tutorial" | "Blog Style" | "Product Showcase";
type ProductType = "Physical" | "Digital" | "Printable" | "Template";
type Status      = "Ready" | "Needs details" | "Needs date" | "Planned" | "Added to Plan";

interface IntelRow {
  rank: number; name: string; saves: string;
  trend: string; demand: "High" | "Med"; competition: "Low" | "Med" | "High"; score: number;
}
interface PinIdea {
  title: string; format: PinFormat; imgId: string; overlay?: string;
  demand: "High Demand" | "Rising"; competition: "Low Competition" | "Moderate";
}
interface ProductIdea {
  title: string; source: "Etsy" | "Shopify" | "Gumroad";
  type: ProductType; category: string; price: string;
  demand: "High Demand" | "Rising"; competition: "Low Competition" | "Moderate"; imgId: string;
}
interface GenPin { title: string; imgId: string; }
interface PlanDay {
  day: string; date: number; title: string; board: string; status: Status; imgId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const u = (id: string, w: number, h: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=${h}&q=80`;

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace" };

function scoreColor(s: number) {
  if (s >= 80) return "#10B981";
  if (s >= 60) return "#F59E0B";
  return "#EF4444";
}

// ── Demo data ─────────────────────────────────────────────────────────────────
const INTEL_ROWS: IntelRow[] = [
  { rank: 1, name: "Boho Living Room",        saves: "3.2K weekly saves", trend: "+214%", demand: "High", competition: "Low", score: 94 },
  { rank: 2, name: "Cottagecore Kitchen Decor", saves: "2.1K weekly saves", trend: "+156%", demand: "High", competition: "Low", score: 87 },
  { rank: 3, name: "Quiet Luxury Aesthetic",  saves: "1.8K weekly saves", trend: "+310%", demand: "High", competition: "Low", score: 81 },
];

const PRODUCT_THUMBS = ["1586023492125-27b2c045efd7", "1600585154340-be6161a56a0c", "1513694153872-ec09ab67aab2", "1504257432389-52343af06ae3"];
const PINREF_THUMBS  = ["1490645935967-10de6ba17061", "1515886657613-9f3515b0c78f", "1573408301185-9519f945b18d", "1596462502278-27bfdc403348"];

const GEN_PINS: GenPin[] = [
  { title: "Simple Boho Living",               imgId: "1586023492125-27b2c045efd7" },
  { title: "Slow down. Create a space you love.", imgId: "1600585154340-be6161a56a0c" },
  { title: "Neutral tones. Natural light.",    imgId: "1513694153872-ec09ab67aab2" },
  { title: "Cozy details that matter.",        imgId: "1504257432389-52343af06ae3" },
];

const PIN_IDEAS: PinIdea[] = [
  { title: "Neutral Calm Moodboard",   format: "Moodboard",        imgId: "1586023492125-27b2c045efd7",                          demand: "Rising",      competition: "Low Competition" },
  { title: "Warm Minimal Living Room", format: "Lifestyle",        imgId: "1600585154340-be6161a56a0c",                          demand: "High Demand", competition: "Low Competition" },
  { title: "Make your space feel like you", format: "Text Overlay", imgId: "1504257432389-52343af06ae3", overlay: "Make your\nspace feel\nlike you.", demand: "High Demand", competition: "Moderate" },
  { title: "Texture + Detail Close-up", format: "Close-up",        imgId: "1573408301185-9519f945b18d",                          demand: "Rising",      competition: "Low Competition" },
  { title: "3 Easy Ways to Style a Shelf", format: "Tutorial",     imgId: "1490645935967-10de6ba17061", overlay: "3 EASY WAYS\nTO STYLE\nA SHELF", demand: "High Demand", competition: "Low Competition" },
  { title: "How to create a calm home on a budget", format: "Blog Style", imgId: "1515886657613-9f3515b0c78f", overlay: "How to create\na calm home\non a budget", demand: "Rising", competition: "Low Competition" },
  { title: "Boho Vase Product Showcase", format: "Product Showcase", imgId: "1596462502278-27bfdc403348",                       demand: "High Demand", competition: "Low Competition" },
];

const PRODUCT_IDEAS: ProductIdea[] = [
  { title: "Boho Ceramic Vase Set",    source: "Etsy",    type: "Physical",  category: "Home Decor",       price: "$30–$90", demand: "High Demand", competition: "Low Competition", imgId: "1586023492125-27b2c045efd7" },
  { title: "Printable Wall Art Set",   source: "Gumroad", type: "Printable", category: "Printables",       price: "$9–$19",  demand: "High Demand", competition: "Low Competition", imgId: "1490645935967-10de6ba17061" },
  { title: "Notion Finance Tracker",   source: "Gumroad", type: "Digital",   category: "Digital Products", price: "$12–$29", demand: "Rising",      competition: "Low Competition", imgId: "1515886657613-9f3515b0c78f" },
  { title: "Minimal Gold Hoop Earrings", source: "Etsy",  type: "Physical",  category: "Jewelry",          price: "$18–$45", demand: "High Demand", competition: "Moderate",        imgId: "1573408301185-9519f945b18d" },
  { title: "Brand Kit Canva Template", source: "Gumroad", type: "Template",  category: "Templates",        price: "$15–$39", demand: "Rising",      competition: "Low Competition", imgId: "1504257432389-52343af06ae3" },
  { title: "Soy Candle Making Guide",  source: "Gumroad", type: "Digital",   category: "Digital Products", price: "$8–$22",  demand: "High Demand", competition: "Moderate",        imgId: "1596462502278-27bfdc403348" },
];

const WEEKLY_PLAN: PlanDay[] = [
  { day: "Mon", date: 9,  title: "Simple Boho Living",     board: "Living Room", status: "Ready",         imgId: "1586023492125-27b2c045efd7" },
  { day: "Tue", date: 10, title: "Cozy Breakfast Flatlay", board: "Food",        status: "Needs details", imgId: "1490645935967-10de6ba17061" },
  { day: "Wed", date: 11, title: "Minimal Shelf Styling",  board: "Home Decor",  status: "Needs date",    imgId: "1513694153872-ec09ab67aab2" },
  { day: "Thu", date: 12, title: "Neutral Tones Pin",      board: "Home Decor",  status: "Planned",       imgId: "1504257432389-52343af06ae3" },
  { day: "Fri", date: 13, title: "Quiet Luxury Outfit",    board: "Fashion",     status: "Added to Plan", imgId: "1515886657613-9f3515b0c78f" },
  { day: "Sat", date: 14, title: "Japandi Bedroom",        board: "Bedroom",     status: "Planned",       imgId: "1600585154340-be6161a56a0c" },
  { day: "Sun", date: 15, title: "Weekend Moodboard",      board: "Lifestyle",   status: "Ready",         imgId: "1596462502278-27bfdc403348" },
];

const STATUS_STYLE: Record<Status, { bg: string; color: string }> = {
  "Ready":          { bg: "rgba(16,185,129,0.18)", color: "#10B981" },
  "Needs details":  { bg: "rgba(245,158,11,0.18)", color: "#F59E0B" },
  "Needs date":     { bg: "rgba(234,179,8,0.18)",  color: "#EAB308" },
  "Planned":        { bg: "rgba(8,145,178,0.18)",  color: "#38BDF8" },
  "Added to Plan":  { bg: "rgba(139,92,246,0.18)", color: "#A78BFA" },
};

const TREND_TICKERS = [
  { emoji: "🔥", name: "Moody Home Decor",    yoy: "+214%", mon: "HIGH" },
  { emoji: "🌿", name: "Boho Living Room",     yoy: "+87%",  mon: "HIGH" },
  { emoji: "🖼️", name: "Wall Art Decor",      yoy: "+145%", mon: "LOW — saturated" },
  { emoji: "✨", name: "Coastal Minimalism",  yoy: "+193%", mon: "HIGH" },
  { emoji: "🕯️", name: "Cottagecore Kitchen", yoy: "+120%", mon: "HIGH" },
  { emoji: "💎", name: "Quiet Luxury Style",  yoy: "+310%", mon: "HIGH" },
  { emoji: "🌸", name: "Soft Romantic Decor", yoy: "+176%", mon: "MID"  },
  { emoji: "🪨", name: "Japandi Interiors",   yoy: "+98%",  mon: "MID"  },
];

const PRICING = [
  {
    plan: "Free", monthly: "$0", yearly: "$0", period: "", planKey: "free",
    desc: "See the top signals. Validate your first bet.",
    features: ["Top 3 opportunities / day", "Limited Product Ideas (5 items)", "Limited Pin Ideas (9 items)", "Pinterest sandbox publish"],
    highlighted: false, cta: "Start free",
  },
  {
    plan: "Creator", monthly: "$19", yearly: "$15", period: "/mo", planKey: "creator",
    desc: "Full intelligence + Create Pins for solo operators.",
    features: ["Full opportunity feed (all 18 categories)", "Pin Idea analysis + save velocity", "Create Pins (150 credits / month)", "Weekly Plan board"],
    highlighted: false, cta: "Choose Creator",
  },
  {
    plan: "Growth", monthly: "$49", yearly: "$39", period: "/mo", planKey: "growth",
    desc: "Full monetization layer for scaling stores.",
    features: ["Everything in Creator", "Full Product Ideas + affiliate map", "Product + keyword CSV export", "Trend velocity alerts + batch planner"],
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
  { q: "Where does the data come from?", a: "VibePin runs a multi-stage data pipeline: interest discovery → trend keyword collection → Pin signal analysis → product discovery → multi-dimensional scoring. All signals come from Pinterest's public data and official Trends API — not user-submitted inputs, not estimates." },
  { q: "How is the opportunity score calculated?", a: "Each keyword is scored across four dimensions: trend momentum (YoY + weekly growth), save velocity (new saves per unit time), competitive density (estimated seller saturation), and data freshness. High score = high demand + low seller saturation. The score is a timing signal, not a popularity metric." },
  { q: "What's the difference between Pin Ideas and Product Ideas?", a: "Pin Ideas are visual content references — formats, layouts, and angles you can use as inspiration when you create a Pin. Product Ideas are physical or digital products (from Etsy, Shopify, Gumroad and more) with demand and competition signals that you can promote or sell. Pin Ideas inform what to make; Product Ideas inform what to monetize." },
  { q: "Does VibePin publish to Pinterest automatically?", a: "No. VibePin helps you create Pin drafts and plan a week of content, but every publish action requires your explicit review and confirmation. You review each Pin before anything goes to your boards. VibePin never bulk-posts or acts on your account without your approval." },
  { q: "Do I need to connect Pinterest to use the intelligence features?", a: "No. Opportunity intelligence, Pin Ideas, and Product Ideas are all read-only and require no Pinterest connection. You only connect your account when you're ready to publish — and only with your explicit authorization." },
  { q: "How often is the data refreshed?", a: "The pipeline runs daily. Save velocity uses a rolling 7-day window. The freshness timestamp in the app reflects the last completed signal collection cycle." },
];

// ── Shared micro-components ───────────────────────────────────────────────────
function ScoreChip({ score }: { score: number }) {
  const c = scoreColor(score);
  return (
    <span className="inline-flex items-center justify-center rounded-lg px-2.5 py-1 text-[12px] font-black tabular-nums"
      style={{ ...MONO, color: c, background: `${c}1A`, border: `1px solid ${c}40`, minWidth: 38 }}>
      {score}
    </span>
  );
}

function Pill({ label, tone }: { label: string; tone: "green" | "cyan" | "amber" | "gray" }) {
  const map = {
    green: { bg: "rgba(16,185,129,0.15)", color: "#10B981" },
    cyan:  { bg: "rgba(8,145,178,0.15)",  color: "#38BDF8" },
    amber: { bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
    gray:  { bg: "rgba(107,114,128,0.15)",color: "#9CA3AF" },
  }[tone];
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold leading-none whitespace-nowrap"
      style={{ background: map.bg, color: map.color }}>
      {label}
    </span>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between py-5 text-left text-[15px] font-semibold transition-colors hover:text-white"
        style={{ color: "#D1D5DB" }}>
        {q}
        <span className={`ml-4 text-xl leading-none transition-transform duration-200 shrink-0 ${open ? "rotate-45" : ""}`} style={{ color: "#4B5563" }}>+</span>
      </button>
      {open && <p className="pb-6 text-sm leading-relaxed max-w-2xl" style={{ color: "#6B7280" }}>{a}</p>}
    </div>
  );
}

const VLogo = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 20 20" fill="none" style={{ width: size, height: size }} aria-hidden>
    <path d="M4 5.5L10 15L16 5.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ── Generated Pin card (used in composer mockups) ─────────────────────────────
function GenPinCard({ pin }: { pin: GenPin }) {
  return (
    <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "4/5" }}>
      <Image src={u(pin.imgId, 280, 350)} alt="" fill className="object-cover" sizes="160px" unoptimized />
      <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-black/25" />
      <p className="absolute top-2.5 left-3 right-3 text-[15px] font-black text-white leading-tight tracking-tight"
        style={{ textShadow: "0 1px 6px rgba(0,0,0,0.5)", fontFamily: "'Playfair Display',Georgia,serif" }}>
        {pin.title}
      </p>
    </div>
  );
}

// ── Create Pins composer (shared by hero + Create Pins section) ───────────────
function CreatePinsComposer({ standalone = false }: { standalone?: boolean }) {
  return (
    <div className="rounded-2xl border overflow-hidden shadow-2xl" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
      {/* Chrome */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5" style={{ color: "#E879F9" }} />
          <span className="text-[12px] font-bold text-white">Create Pins</span>
          <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(255,255,255,0.06)", color: "#6B7280" }}>New draft</span>
        </div>
        <span className="text-[9px]" style={{ color: "#374151", ...MONO }}>studio</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2">
        {/* Composer */}
        <div className="p-4 lg:border-r" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          {/* Product images */}
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Product Images</p>
          <div className="flex gap-1.5 mb-4">
            {PRODUCT_THUMBS.map((id, i) => (
              <div key={i} className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 44, height: 44, border: "1px solid rgba(255,255,255,0.08)" }}>
                <Image src={u(id, 88, 88)} alt="" fill className="object-cover" sizes="44px" unoptimized />
              </div>
            ))}
          </div>

          {/* Pin references */}
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Pin References</p>
          <div className="flex gap-1.5 mb-4">
            {PINREF_THUMBS.map((id, i) => (
              <div key={i} className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 44, height: 44, border: "1px solid rgba(255,255,255,0.08)" }}>
                <Image src={u(id, 88, 88)} alt="" fill className="object-cover" sizes="44px" unoptimized />
              </div>
            ))}
            <div className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 44, height: 44, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}>
              <Plus className="w-4 h-4" />
            </div>
          </div>

          {/* Creative direction */}
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Creative Direction</p>
          <div className="rounded-lg px-3 py-2.5 mb-4 text-[11px] leading-relaxed" style={{ background: "#080E0B", border: "1px solid rgba(255,255,255,0.07)", color: "#8B9E97" }}>
            Create warm, minimal lifestyle Pins for a modern boho living room. Natural light, earthy tones, clean composition, and subtle text overlays.
            <span className="block text-right mt-1 text-[9px]" style={{ color: "#374151", ...MONO }}>128 / 500</span>
          </div>

          {/* Count + aspect */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Image count</p>
              <div className="rounded-lg px-3 py-2 text-[12px] font-semibold text-white flex items-center justify-between" style={{ background: "#080E0B", border: "1px solid rgba(255,255,255,0.07)" }}>
                4 <span style={{ color: "#374151" }}>▾</span>
              </div>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Aspect ratio</p>
              <div className="flex gap-1">
                {["2:3", "4:5", "1:1", "16:9"].map((r, i) => (
                  <span key={r} className="flex-1 text-center rounded-lg py-2 text-[10px] font-bold"
                    style={i === 0
                      ? { background: "rgba(8,145,178,0.18)", color: "#38BDF8", border: "1px solid rgba(8,145,178,0.35)" }
                      : { background: "#080E0B", color: "#4B5563", border: "1px solid rgba(255,255,255,0.07)" }}>
                    {r}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Model */}
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Model</p>
          <div className="flex gap-2 mb-4">
            <span className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-bold"
              style={{ background: "rgba(16,185,129,0.14)", color: "#10B981", border: "1px solid rgba(16,185,129,0.30)" }}>
              <Check className="w-3 h-3" /> GPT Image
            </span>
            <span className="rounded-lg px-3 py-2 text-[11px] font-semibold"
              style={{ background: "#080E0B", color: "#4B5563", border: "1px solid rgba(255,255,255,0.07)" }}>
              Nano Banana
            </span>
          </div>

          <button type="button" className="btn-cta w-full rounded-full py-2.5 text-[12px] font-bold text-white flex items-center justify-center gap-2">
            Generate Pins <Sparkles className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Generated */}
        <div className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: "#4B5563" }}>Generated Pins</p>
          <div className="grid grid-cols-2 gap-2.5 mb-3">
            {GEN_PINS.map((pin, i) => <GenPinCard key={i} pin={pin} />)}
          </div>
          <div className="flex gap-2">
            <button type="button" className="flex-1 btn-cta rounded-full py-2 text-[11px] font-bold text-white">Add to Plan</button>
            <button type="button" className="flex-1 rounded-full py-2 text-[11px] font-semibold border" style={{ borderColor: "rgba(255,255,255,0.12)", color: "#8B9E97" }}>Edit details</button>
          </div>
          {standalone && (
            <p className="mt-3 text-[10px] leading-relaxed" style={{ color: "#374151" }}>
              You review every generated Pin before it&apos;s added to your plan or published.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pin Details (Plan) panel ──────────────────────────────────────────────────
function PinDetailsPanel() {
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
        <span className="text-[12px] font-bold text-white">Pin Details</span>
        <X className="w-3.5 h-3.5" style={{ color: "#4B5563" }} />
      </div>
      {/* Tabs */}
      <div className="flex gap-1 px-4 pt-3">
        <span className="rounded-lg px-3 py-1.5 text-[11px] font-semibold" style={{ color: "#4B5563" }}>Details</span>
        <span className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold"
          style={{ background: "rgba(8,145,178,0.14)", color: "#38BDF8", border: "1px solid rgba(8,145,178,0.30)" }}>
          <Check className="w-3 h-3" /> Plan
        </span>
      </div>

      <div className="p-4 space-y-3.5">
        {/* Linked product */}
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Linked Product</p>
          <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2" style={{ background: "#080E0B", border: "1px solid rgba(255,255,255,0.07)" }}>
            <div className="relative rounded-md overflow-hidden shrink-0" style={{ width: 36, height: 36 }}>
              <Image src={u("1586023492125-27b2c045efd7", 72, 72)} alt="" fill className="object-cover" sizes="36px" unoptimized />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold text-white truncate">Boho Ceramic Vase Set</p>
              <p className="text-[10px]" style={{ color: "#4B5563" }}>Etsy</p>
            </div>
            <span className="text-[10px] font-bold rounded-full px-2.5 py-1" style={{ color: "#38BDF8", border: "1px solid rgba(8,145,178,0.30)" }}>Change</span>
          </div>
        </div>

        <Field label="Destination URL" value="https://etsy.com/listing/boho-ceramic-vase-set" mono />
        <label className="flex items-center gap-2 text-[11px] cursor-default" style={{ color: "#8B9E97" }}>
          <span className="flex items-center justify-center rounded h-4 w-4" style={{ background: "rgba(8,145,178,0.20)", border: "1px solid rgba(8,145,178,0.40)" }}>
            <Check className="w-3 h-3" style={{ color: "#38BDF8" }} />
          </span>
          Use linked product URL
        </label>
        <Field label="Title" value="Simple Boho Living" />
        <Field label="Description" value="Create a calm, cozy space with natural textures and warm neutrals." multiline />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Planned Date" value="Jun 12, 2026" />
          <Field label="Board / Category" value="Home Decor" />
        </div>

        <button type="button" className="btn-cta w-full rounded-full py-2.5 text-[12px] font-bold text-white">Add to Plan</button>
      </div>
    </div>
  );
}

function Field({ label, value, mono, multiline }: { label: string; value: string; mono?: boolean; multiline?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>{label}</p>
      <div className={`rounded-lg px-3 py-2 text-[11px] ${multiline ? "leading-relaxed" : "truncate"}`}
        style={{ background: "#080E0B", border: "1px solid rgba(255,255,255,0.07)", color: mono ? "#38BDF8" : "#D1D5DB", ...(mono ? MONO : {}) }}>
        {value}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const [showStickyCta, setShowStickyCta] = useState(false);
  const [yearlyBilling, setYearlyBilling] = useState(false);
  const [pinFilter, setPinFilter]         = useState("All Formats");
  const [prodFilter, setProdFilter]       = useState("All Categories");
  const router = useRouter();

  useEffect(() => {
    const h = () => setShowStickyCta(window.scrollY > 600);
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);

  const pinFormats = ["All Formats", "Close-up", "Moodboard", "Lifestyle", "Text Overlay", "Tutorial", "Blog Style", "Product Showcase"];
  const prodCats   = ["All Categories", "Home Decor", "Printables", "Digital Products", "Jewelry", "Templates"];
  const pinList  = pinFilter === "All Formats" ? PIN_IDEAS : PIN_IDEAS.filter(p => p.format === pinFilter);
  const prodList = prodFilter === "All Categories" ? PRODUCT_IDEAS : PRODUCT_IDEAS.filter(p => p.category === prodFilter);
  const pinDisplay  = pinList.length  ? pinList  : PIN_IDEAS;
  const prodDisplay = prodList.length ? prodList : PRODUCT_IDEAS;

  const srcColor  = (s: string) => s === "Etsy" ? "#F87171" : s === "Gumroad" ? "#A78BFA" : "#60A5FA";
  const typeStyle = (t: ProductType) => ({
    Physical:  { bg: "rgba(245,158,11,0.18)", color: "#FCD34D" },
    Printable: { bg: "rgba(8,145,178,0.18)",  color: "#38BDF8" },
    Digital:   { bg: "rgba(139,92,246,0.18)", color: "#C4B5FD" },
    Template:  { bg: "rgba(236,72,153,0.18)", color: "#F9A8D4" },
  }[t]);

  return (
    <div className="lp min-h-screen antialiased" style={{ background: "var(--bg)", color: "var(--text)" }}>

      {/* ══ NAV ════════════════════════════════════════════════════════════════ */}
      <nav className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ background: "rgba(8,14,11,0.92)", borderColor: "rgba(255,255,255,0.07)" }}>
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
          <div className="hidden md:flex items-center gap-6 text-[13px] font-medium" style={{ color: "#6B7280" }}>
            <a href="#intelligence"  className="hover:text-white transition-colors">Intelligence</a>
            <a href="#pin-ideas"      className="hover:text-white transition-colors">Pin Ideas</a>
            <a href="#product-ideas"  className="hover:text-white transition-colors">Product Ideas</a>
            <a href="#create-pins"    className="hover:text-white transition-colors">Create Pins</a>
            <a href="#pricing"        className="hover:text-white transition-colors">Pricing</a>
          </div>
          <div className="flex items-center gap-2.5">
            <Link href="/login" className="hidden sm:inline text-[13px] font-medium border rounded-full px-4 py-1.5 transition-colors hover:text-white"
              style={{ color: "#6B7280", borderColor: "rgba(255,255,255,0.10)" }}>
              Log In
            </Link>
            <Link href="/app/discover?demo=true" className="btn-cta rounded-full px-4 py-2 text-[13px] font-bold text-white">Build my 7 Pins</Link>
          </div>
        </div>
      </nav>

      {/* ══ HERO ═══════════════════════════════════════════════════════════════ */}
      <section className="pt-14 pb-12 lg:pt-20 lg:pb-16 overflow-hidden">
        <div className="max-w-[1280px] mx-auto px-5 grid grid-cols-1 lg:grid-cols-[0.9fr_1.25fr] gap-10 lg:gap-12 items-start">
          {/* Left */}
          <div className="lg:pt-4">
            <div className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 mb-6"
              style={{ background: "rgba(8,145,178,0.08)", borderColor: "rgba(8,145,178,0.22)" }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-500" />
              </span>
              <span className="text-[11px] font-semibold tracking-wide" style={{ color: "#0891B2" }}>Pinterest Opportunity Terminal</span>
            </div>

            <h1 className="text-[2.5rem] sm:text-[3.2rem] lg:text-[3.5rem] font-black text-white leading-[1.05] tracking-[-0.04em] mb-5">
              Find Pinterest opportunities worth creating before the market gets crowded.
            </h1>

            <p className="text-[15px] sm:text-[16px] leading-relaxed mb-7 max-w-[460px]" style={{ color: "#8B9E97" }}>
              VibePin helps creators and ecommerce sellers discover high-signal opportunities,
              create Pins that people save, and plan a week of content in minutes.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 mb-7">
              <Link href="/app/discover?demo=true" className="btn-cta flex items-center justify-center gap-2 rounded-full px-7 py-3.5 text-[14px] font-bold text-white">
                Build my next 7 Pins <ArrowRight className="w-4 h-4" />
              </Link>
              <a href="#intelligence" className="flex items-center justify-center gap-2 rounded-full px-7 py-3.5 text-[14px] font-semibold border transition-colors hover:text-white"
                style={{ color: "#6B7280", borderColor: "rgba(255,255,255,0.12)" }}>
                See this week&apos;s opportunities
              </a>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {["Evidence-backed signals", "Creator-first workflow", "You review every Pin before publishing"].map(item => (
                <span key={item} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4D5E58" }}>
                  <span className="h-1 w-1 rounded-full" style={{ background: "#374151" }} />
                  {item}
                </span>
              ))}
            </div>
          </div>

          {/* Right — Create Pins workflow mockup */}
          <CreatePinsComposer />
        </div>
      </section>

      {/* ══ PROOF BAR ══════════════════════════════════════════════════════════ */}
      <section className="border-y" style={{ borderColor: "rgba(255,255,255,0.07)", background: "var(--surface)" }}>
        <div className="max-w-[1280px] mx-auto px-5 py-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px" style={{ background: "rgba(255,255,255,0.06)" }}>
            {[
              { icon: Clock,     value: "Daily",  label: "Refreshed opportunity signals"         },
              { icon: Package,   value: "18",     label: "Categories tracked"                    },
              { icon: Database,  value: "Signal", label: "Opportunity scoring engine"            },
              { icon: BarChart2, value: "Demand", label: "Competition + monetization indicators" },
            ].map(({ icon: Icon, value, label }) => (
              <div key={label} className="flex flex-col items-center text-center px-6 py-5" style={{ background: "var(--surface)" }}>
                <div className="h-8 w-8 rounded-lg flex items-center justify-center mb-3 border" style={{ background: "rgba(8,145,178,0.10)", borderColor: "rgba(8,145,178,0.20)" }}>
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
                <span style={{ color: t.mon === "HIGH" ? "#10B981" : t.mon.includes("LOW") ? "#EF4444" : "#F59E0B" }}>MON: {t.mon}</span>
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
              By the time a niche looks obvious elsewhere, it&apos;s already crowded on Pinterest, and the window to stake an early position has closed.
            </p>
            <p className="text-[15px] leading-relaxed" style={{ color: "#8B9E97" }}>
              Content tools make this worse. They push you to produce more — more Pins, more formats, more variations.
              But volume without signal is noise. VibePin solves the upstream problem: before you create anything, you know what&apos;s worth making, when to enter, and whether the monetization ceiling justifies the effort.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex items-center gap-3 rounded-xl border px-5 py-4" style={{ background: "rgba(220,38,38,0.05)", borderColor: "rgba(220,38,38,0.15)" }}>
              <span className="text-[18px]">❌</span>
              <div>
                <p className="text-[13px] font-bold text-white">Generate more content</p>
                <p className="text-[11px] mt-0.5" style={{ color: "#4B5563" }}>Volume without signal is wasted effort</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border px-5 py-4" style={{ background: "rgba(8,145,178,0.06)", borderColor: "rgba(8,145,178,0.20)" }}>
              <span className="text-[18px]">✔</span>
              <div>
                <p className="text-[13px] font-bold text-white">Select what&apos;s worth making this week</p>
                <p className="text-[11px] mt-0.5" style={{ color: "#4D5E58" }}>Evidence first. Then create.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ INTELLIGENCE (single compact table) ════════════════════════════════ */}
      <section id="intelligence" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#0891B2" }}>Intelligence</p>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Know what is worth making.</h2>
              <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
                High-signal opportunities ranked by demand, competition and trend velocity.
              </p>
            </div>
            <Link href="/app/discover?demo=true" className="flex items-center gap-1.5 text-[12px] font-bold transition-colors hover:text-cyan-400" style={{ color: "#0891B2" }}>
              View all opportunities <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
            {/* header */}
            <div className="hidden sm:grid items-center px-5 py-2.5 border-b"
              style={{ gridTemplateColumns: "1.5rem 1fr 5rem 4rem 5rem 3.5rem", gap: "1rem", borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              {["#", "opportunity", "trend", "demand", "competition", "score"].map(h => (
                <span key={h} className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: "#374151", ...MONO }}>{h}</span>
              ))}
            </div>
            {INTEL_ROWS.map(row => (
              <div key={row.rank} className="grid items-center px-5 py-4 border-b last:border-0"
                style={{ gridTemplateColumns: "1.5rem 1fr 5rem 4rem 5rem 3.5rem", gap: "1rem", borderColor: "rgba(255,255,255,0.04)" }}>
                <span className="text-[12px] font-black tabular-nums" style={{ color: "#4B5563", ...MONO }}>{row.rank}</span>
                <div className="min-w-0">
                  <p className="text-[14px] font-bold text-white">{row.name}</p>
                  <p className="text-[10px] mt-0.5" style={{ color: "#4B5563", ...MONO }}>{row.saves}</p>
                </div>
                <span className="text-[12px] font-bold tabular-nums text-emerald-400" style={MONO}>↗ {row.trend}</span>
                <Pill label={row.demand} tone="green" />
                <Pill label={row.competition} tone={row.competition === "Low" ? "green" : row.competition === "Med" ? "amber" : "gray"} />
                <ScoreChip score={row.score} />
              </div>
            ))}
            <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Updated 3h ago</span>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Sample of top opportunities · 18 categories</span>
            </div>
          </div>
        </div>
      </section>

      {/* ══ PIN IDEAS ══════════════════════════════════════════════════════════ */}
      <section id="pin-ideas" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#D946EF" }}>Pin Ideas</p>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Pin Ideas that match what people already save.</h2>
              <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
                Pinterest-native formats, layouts, and angles proven to get saves.
              </p>
            </div>
            <Link href="/app/discover?demo=true" className="flex items-center gap-1.5 text-[12px] font-bold transition-opacity hover:opacity-80" style={{ color: "#E879F9" }}>
              Explore all ideas <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {/* filter chips */}
          <div className="flex items-center gap-1.5 mb-5 overflow-x-auto pb-1">
            {pinFormats.map(f => (
              <button key={f} type="button" onClick={() => setPinFilter(f)}
                className="rounded-full px-3 py-1.5 text-[11px] font-semibold whitespace-nowrap shrink-0 transition-all"
                style={pinFilter === f
                  ? { background: "rgba(217,70,239,0.18)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.35)" }
                  : { background: "rgba(255,255,255,0.04)", color: "#6B7280", border: "1px solid rgba(255,255,255,0.07)" }}>
                {f}
              </button>
            ))}
          </div>

          {/* pin cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {pinDisplay.map((idea, i) => (
              <div key={i} className="rounded-xl overflow-hidden group/pin"
                style={{ background: "#0C1410", border: "1px solid rgba(255,255,255,0.07)" }}>
                <div className="relative" style={{ aspectRatio: "4/5" }}>
                  <Image src={u(idea.imgId, 280, 350)} alt="" fill className="object-cover transition-transform duration-500 group-hover/pin:scale-105" sizes="180px" unoptimized />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/10" />
                  <span className="absolute top-1.5 left-1.5 rounded-full px-2 py-0.5 text-[8px] font-bold"
                    style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.30)" }}>
                    {idea.format}
                  </span>
                  {idea.overlay && (
                    <p className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[13px] font-black text-white leading-tight whitespace-pre-line"
                      style={{ textShadow: "0 1px 6px rgba(0,0,0,0.6)", fontFamily: "'Playfair Display',Georgia,serif" }}>
                      {idea.overlay}
                    </p>
                  )}
                </div>
                <div className="p-2.5">
                  <p className="text-[11px] font-bold text-white leading-tight mb-2 line-clamp-2" style={{ minHeight: "2.2em" }}>{idea.title}</p>
                  <div className="flex flex-wrap gap-1 mb-2.5">
                    <Pill label={idea.demand === "High Demand" ? "High Demand" : "Rising"} tone="green" />
                    <Pill label={idea.competition === "Low Competition" ? "Low Comp" : "Moderate"} tone={idea.competition === "Low Competition" ? "cyan" : "amber"} />
                  </div>
                  <div className="flex items-center gap-2 text-[9px] font-semibold">
                    <span className="flex items-center gap-1 transition-colors hover:text-white" style={{ color: "#6B7280" }}><Bookmark className="w-2.5 h-2.5" /> Save</span>
                    <span style={{ color: "#1F2937" }}>·</span>
                    <span className="transition-colors hover:text-white" style={{ color: "#6B7280" }}>Use as reference</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ PRODUCT IDEAS ══════════════════════════════════════════════════════ */}
      <section id="product-ideas" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#10B981" }}>Product Ideas</p>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Product Ideas worth promoting or selling.</h2>
              <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
                Find physical and digital products with demand, low competition, and clear content angles.
              </p>
            </div>
            <Link href="/app/discover?demo=true" className="flex items-center gap-1.5 text-[12px] font-bold transition-opacity hover:opacity-80" style={{ color: "#10B981" }}>
              Explore all products <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {/* category chips */}
          <div className="flex items-center gap-1.5 mb-5 overflow-x-auto pb-1">
            {prodCats.map(c => (
              <button key={c} type="button" onClick={() => setProdFilter(c)}
                className="rounded-full px-3 py-1.5 text-[11px] font-semibold whitespace-nowrap shrink-0 transition-all"
                style={prodFilter === c
                  ? { background: "rgba(16,185,129,0.18)", color: "#10B981", border: "1px solid rgba(16,185,129,0.35)" }
                  : { background: "rgba(255,255,255,0.04)", color: "#6B7280", border: "1px solid rgba(255,255,255,0.07)" }}>
                {c}
              </button>
            ))}
          </div>

          {/* product cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {prodDisplay.map((prod, i) => {
              const ts = typeStyle(prod.type);
              return (
                <div key={i} className="rounded-xl overflow-hidden"
                  style={{ background: "#0C1410", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div className="relative" style={{ aspectRatio: "1/1" }}>
                    <Image src={u(prod.imgId, 240, 240)} alt="" fill className="object-cover" sizes="160px" unoptimized />
                    <span className="absolute top-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: ts.bg, color: ts.color }}>{prod.type}</span>
                  </div>
                  <div className="p-2.5">
                    <p className="text-[11px] font-bold text-white leading-tight mb-0.5 line-clamp-2" style={{ minHeight: "2.2em" }}>{prod.title}</p>
                    <p className="text-[9px] font-bold mb-1.5" style={{ color: srcColor(prod.source) }}>{prod.source} · <span style={{ color: "#E5E7EB", ...MONO }}>{prod.price}</span></p>
                    <div className="flex flex-wrap gap-1 mb-2.5">
                      <Pill label={prod.demand === "High Demand" ? "High Demand" : "Rising"} tone="green" />
                      <Pill label={prod.competition === "Low Competition" ? "Low Comp" : "Moderate"} tone={prod.competition === "Low Competition" ? "cyan" : "amber"} />
                    </div>
                    <div className="flex items-center gap-1.5 text-[9px] font-semibold">
                      <span className="flex items-center gap-1 transition-colors hover:text-white" style={{ color: "#6B7280" }}><Bookmark className="w-2.5 h-2.5" /> Save</span>
                      <span style={{ color: "#1F2937" }}>·</span>
                      <span className="flex items-center gap-1 transition-colors hover:text-white" style={{ color: "#6B7280" }}><ImageIcon className="w-2.5 h-2.5" /> Use image</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ══ CREATE PINS ════════════════════════════════════════════════════════ */}
      <section id="create-pins" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="mb-8">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#FB923C" }}>Create Pins</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Create Pins in minutes.</h2>
            <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
              Add your product images and Pin references, set the creative direction, choose your model,
              and generate scroll-stopping Pins — then link the product, plan the date, and review before you publish.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-5 items-start">
            <CreatePinsComposer standalone />
            <PinDetailsPanel />
          </div>
        </div>
      </section>

      {/* ══ WEEKLY PLAN ════════════════════════════════════════════════════════ */}
      <section id="weekly-plan" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Weekly Plan</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">From ideas to 7 Pins in one weekly plan.</h2>
            <p className="max-w-xl mx-auto text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
              Plan, schedule, and publish with confidence — you review and confirm every Pin.
            </p>
          </div>

          <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
            {/* header */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
              <span className="rounded-full px-3 py-1 text-[11px] font-semibold border" style={{ color: "#E5E7EB", borderColor: "rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)" }}>
                Jun 9 – Jun 15, 2026
              </span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px]" style={{ color: "#6B7280", ...MONO }}>
                {(Object.keys(STATUS_STYLE) as Status[]).map(s => (
                  <span key={s} className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_STYLE[s].color }} />{s}
                  </span>
                ))}
              </div>
            </div>

            {/* 7-day columns */}
            <div className="overflow-x-auto">
              <div className="grid min-w-[720px]" style={{ gridTemplateColumns: "repeat(7,1fr)", gap: "1px", background: "rgba(255,255,255,0.05)" }}>
                {WEEKLY_PLAN.map((d, i) => (
                  <div key={i} style={{ background: "#0C1410" }}>
                    <div className="px-2 py-2 border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                      <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "#4B5563" }}>{d.day}</p>
                      <p className="text-[18px] font-black text-white leading-none">{d.date}</p>
                    </div>
                    <div className="p-2">
                      <div className="relative rounded-lg overflow-hidden mb-2" style={{ aspectRatio: "4/5" }}>
                        <Image src={u(d.imgId, 160, 200)} alt="" fill className="object-cover" sizes="100px" unoptimized />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent" />
                      </div>
                      <p className="text-[9px] font-bold text-white leading-tight mb-1 line-clamp-2" style={{ minHeight: "2.2em" }}>{d.title}</p>
                      <p className="text-[8px] mb-1.5" style={{ color: "#4B5563" }}>{d.board}</p>
                      <span className="inline-block rounded-full px-2 py-0.5 text-[7px] font-bold" style={{ background: STATUS_STYLE[d.status].bg, color: STATUS_STYLE[d.status].color }}>{d.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* unscheduled drafts */}
            <div className="px-5 py-3 border-t flex items-center justify-between gap-3" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-semibold shrink-0" style={{ color: "#4B5563", ...MONO }}>Unscheduled drafts (3)</span>
                <div className="flex items-center gap-2">
                  {["1513694153872-ec09ab67aab2", "1596462502278-27bfdc403348", "1573408301185-9519f945b18d"].map((id, i) => (
                    <div key={i} className="relative shrink-0 rounded-lg overflow-hidden" style={{ width: 34, height: 34 }}>
                      <Image src={u(id, 68, 68)} alt="" fill className="object-cover" sizes="34px" unoptimized />
                    </div>
                  ))}
                  <div className="shrink-0 h-[34px] w-[34px] rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.04)", border: "1px dashed rgba(255,255,255,0.12)", color: "#374151" }}>
                    <Plus className="w-3.5 h-3.5" />
                  </div>
                </div>
              </div>
              <Link href="/app/plan?demo=true" className="text-[11px] font-bold transition-colors hover:text-cyan-400 flex items-center gap-1" style={{ color: "#38BDF8" }}>
                View all drafts <ArrowRight className="w-3 h-3" />
              </Link>
            </div>

            <div className="flex items-center justify-between px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#080E0B" }}>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Review each Pin before publishing · You confirm every action</span>
              <Link href="/app/discover?demo=true" className="btn-cta flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold text-white">
                Build my next 7 Pins <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ══ PRICING ════════════════════════════════════════════════════════════ */}
      <section id="pricing" className="py-20 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Access model</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">You&apos;re buying intelligence access. Not credits.</h2>
            <p className="max-w-lg mx-auto text-[14px] leading-relaxed mb-6" style={{ color: "#6B7280" }}>
              Paid plans unlock signal depth — more categories, full monetization layer, exports, and alerts. Not usage caps that block your workflow.
            </p>
            <div className="inline-flex items-center gap-1 rounded-full border p-1.5" style={{ background: "#080E0B", borderColor: "rgba(255,255,255,0.08)" }}>
              {[{ label: "Monthly", val: false }, { label: "Yearly", val: true }].map(opt => (
                <button key={opt.label} type="button" onClick={() => setYearlyBilling(opt.val)}
                  className="rounded-full px-5 py-2 text-[13px] font-bold transition-all flex items-center gap-2"
                  style={yearlyBilling === opt.val ? { background: "var(--surface-2)", color: "#E5E7EB" } : { color: "#4B5563" }}>
                  {opt.label}
                  {opt.val && <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "#0891B2", color: "white" }}>–20%</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch">
            {PRICING.map(card => (
              <div key={card.plan} className="relative flex flex-col rounded-2xl p-7"
                style={card.highlighted
                  ? { background: "rgba(8,145,178,0.08)", border: "1px solid rgba(8,145,178,0.25)" }
                  : { background: "var(--surface-2)", border: "1px solid rgba(255,255,255,0.07)" }}>
                {card.highlighted && (
                  <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full px-4 py-1 text-[11px] font-bold" style={{ background: "#0891B2", color: "white" }}>Most popular</span>
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
            <h2 className="text-3xl font-black text-white tracking-tight">About VibePin</h2>
          </div>
          {FAQ.map(item => <FaqItem key={item.q} q={item.q} a={item.a} />)}
        </div>
      </section>

      {/* ══ FINAL CTA ══════════════════════════════════════════════════════════ */}
      <section className="py-28 relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-80" style={{ background: "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(217,70,239,0.08) 0%, transparent 100%)" }} />
        <div className="max-w-2xl mx-auto px-5 text-center relative">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-4" style={{ color: "#0891B2" }}>Discover → Pin Ideas → Product Ideas → Create Pins → Weekly Plan</p>
          <h2 className="text-4xl sm:text-5xl font-black text-white tracking-tight mb-5 leading-[1.05]">Start with what is<br />worth creating.</h2>
          <p className="text-[15px] mb-10 leading-relaxed" style={{ color: "#6B7280" }}>
            Select high-signal opportunities, turn them into Pins people save, and organise them into one weekly plan you review and publish on your terms.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/app/discover?demo=true" className="btn-cta flex items-center justify-center gap-2 rounded-full px-9 py-4 text-[14px] font-bold text-white">
              Build my 7 Pins →
            </Link>
            <a href="#intelligence" className="flex items-center justify-center gap-2 rounded-full border px-9 py-4 text-[14px] font-bold transition-colors hover:text-white"
              style={{ borderColor: "rgba(255,255,255,0.12)", color: "#8B9E97" }}>
              See this week&apos;s opportunities
            </a>
          </div>
          <p className="mt-5 text-[11px]" style={{ color: "#374151" }}>No credit card required · Cancel anytime · 7 Pins, one weekly plan</p>
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
            { title: "Product", links: [
              { label: "Intelligence",  href: "#intelligence" },
              { label: "Pin Ideas",     href: "#pin-ideas" },
              { label: "Product Ideas", href: "#product-ideas" },
              { label: "Create Pins",   href: "#create-pins" },
            ]},
            { title: "Resources", links: [
              { label: "Pricing",         href: "#pricing" },
              { label: "Help Center",     href: "#" },
              { label: "Pinterest Guide", href: "#" },
            ]},
            { title: "Legal", links: [
              { label: "Privacy",       href: "/privacy" },
              { label: "Terms",         href: "/terms" },
              { label: "Pinterest App", href: "/pinterest-app" },
              { label: "Contact",       href: "mailto:support@vibepin.co" },
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
        <div className="max-w-[1200px] mx-auto px-5 border-t pt-6 flex flex-col sm:flex-row justify-between gap-2 text-[11px]" style={{ borderColor: "rgba(255,255,255,0.06)", color: "#374151" }}>
          <p>© 2026 VibePin. All rights reserved.</p>
          <p>Pinterest data pipeline · Refreshed daily · Real signals</p>
        </div>
      </footer>

      {/* ══ STICKY CTA ═════════════════════════════════════════════════════════ */}
      <div className={`fixed bottom-0 left-0 right-0 z-50 border-t backdrop-blur-md px-5 py-3.5 flex items-center justify-between gap-4 transition-all duration-300 ${
        showStickyCta ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"}`}
        style={{ background: "rgba(8,14,11,0.95)", borderColor: "rgba(255,255,255,0.09)" }}>
        <div>
          <p className="font-bold text-white text-[13px]">Discover opportunities, create Pins, and plan your week — in one flow.</p>
          <p className="text-[11px] mt-0.5" style={{ color: "#374151" }}>No credit card required · You review every Pin before publishing</p>
        </div>
        <Link href="/app/discover?demo=true" className="btn-cta shrink-0 rounded-full px-5 py-2.5 text-[13px] font-bold text-white">Build my 7 Pins</Link>
      </div>

    </div>
  );
}
