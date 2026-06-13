"use client";

import Image from "next/image";
import BrandLogo from "@/components/BrandLogo";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, Check, Sparkles, Plus, X,
  Clock, Package, BarChart2, Bookmark, ImageIcon,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type PinFormat   = "Close-up" | "Moodboard" | "Lifestyle" | "Text Overlay" | "Tutorial" | "Blog Style" | "Product Showcase";
type ProductType = "Physical" | "Digital" | "Printable" | "Template";
type Status      = "Ready" | "Needs details" | "Needs date" | "Planned" | "Added to Plan";

interface IntelRow {
  rank: number; name: string; saves: string;
  trend: string; demand: "High" | "Med"; competition: "Low" | "Med"; score: number;
}
interface PinIdea {
  title: string; format: PinFormat; img: string; overlay?: string;
  demand: "High Demand" | "Rising"; competition: "Low Competition" | "Moderate";
}
interface ProductIdea {
  title: string; source: "Etsy" | "Shopify" | "Gumroad";
  type: ProductType; category: string; price: string;
  demand: "High Demand" | "Rising"; competition: "Low Competition" | "Moderate"; img: string;
}
interface GenPin { title: string; img: string; }
interface PlanDay {
  day: string; date: number; title: string; board: string; status: Status; img: string;
}
interface ComposerData {
  accent: string; brand: string; products: string[]; refs: string[];
  direction: string; gen: GenPin[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const u = (id: string, w: number, h: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=${h}&q=80`;

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace" };
const SERIF: React.CSSProperties = { fontFamily: "'Playfair Display',Georgia,serif" };

function scoreColor(s: number) {
  if (s >= 80) return "#10B981";
  if (s >= 60) return "#F59E0B";
  return "#EF4444";
}

/* ───────────────────────────────────────────────────────────────────────────
   IMAGE ALLOCATION — every photo ID below is unique across the whole page and
   verified to return HTTP 200 from images.unsplash.com. Do not reuse an ID in
   two slots; that breaks the de-duplication guarantee.
   ─────────────────────────────────────────────────────────────────────────── */

// Hero composer — home-decor seller theme
const HERO_COMPOSER: ComposerData = {
  accent: "#E879F9", brand: "Boho Home Studio",
  products: ["1602143407151-7111542de6e8", "1517705008128-361805f42e86", "1616627561950-9f746e330187"],
  refs:     ["1616486338812-3dadae4b4ace", "1583847268964-b28dc8f51f92", "1484101403633-562f891dc89a"],
  direction: "Create warm, minimal lifestyle Pins for a modern boho living room. Natural light, earthy tones, clean composition, subtle text overlays.",
  gen: [
    { title: "Simple Boho Living",  img: "1586023492125-27b2c045efd7" },
    { title: "Slow Living Space",   img: "1555041469-a586c61ea9bc" },
    { title: "Warm Neutral Tones",  img: "1567016432779-094069958ea5" },
    { title: "Cozy Corner Styling", img: "1522708323590-d24dbb6b0267" },
  ],
};

// Create Pins section composer — clean-beauty seller theme (disjoint images)
const CREATE_COMPOSER: ComposerData = {
  accent: "#FB923C", brand: "Clean Beauty Co.",
  products: ["1595425970377-c9703cf48b6d", "1571781926291-c477ebfd024b", "1631730486572-226d1f595b68"],
  refs:     ["1512207736890-6ffed8a84e8d", "1522335789203-aabd1fc54bc9", "1493666438817-866a91353ca9"],
  direction: "Generate clean, editorial skincare Pins. Soft daylight, calm tones, and subtle text overlays for a daily self-care routine.",
  gen: [
    { title: "Your Daily Glow",     img: "1545205597-3d9d02c29597" },
    { title: "Slow Morning Ritual", img: "1504257432389-52343af06ae3" },
    { title: "Clean Beauty Edit",   img: "1506629082955-511b1aa562c8" },
    { title: "Self-Care Sunday",    img: "1596462502278-27bfdc403348" },
  ],
};

const INTEL_ROWS: IntelRow[] = [
  { rank: 1, name: "Boho Living Room",          saves: "3.2K weekly saves", trend: "+214%", demand: "High", competition: "Low", score: 94 },
  { rank: 2, name: "Cottagecore Kitchen Decor", saves: "2.1K weekly saves", trend: "+156%", demand: "High", competition: "Low", score: 87 },
  { rank: 3, name: "Quiet Luxury Aesthetic",    saves: "1.8K weekly saves", trend: "+310%", demand: "High", competition: "Low", score: 81 },
  { rank: 4, name: "Japandi Interiors",         saves: "0.9K weekly saves", trend: "+98%",  demand: "Med",  competition: "Med", score: 74 },
];

const PIN_IDEAS: PinIdea[] = [
  { title: "Neutral Calm Moodboard",    format: "Moodboard",        img: "1556905055-8f358a7a47b2",                          demand: "Rising",      competition: "Low Competition" },
  { title: "Texture & Detail Close-up", format: "Close-up",         img: "1523170335258-f5ed11844a49",                       demand: "High Demand", competition: "Low Competition" },
  { title: "Warm Autumn Lifestyle",     format: "Lifestyle",        img: "1515886657613-9f3515b0c78f",                       demand: "High Demand", competition: "Moderate" },
  { title: "Slow Mornings, Done Right", format: "Text Overlay",     img: "1504674900247-0877df9cc836", overlay: "Slow\nmornings,\ndone right.", demand: "High Demand", competition: "Low Competition" },
  { title: "10-Minute Dinner Tutorial", format: "Tutorial",         img: "1490645935967-10de6ba17061", overlay: "10-MIN\nWEEKNIGHT\nDINNER",  demand: "Rising",      competition: "Low Competition" },
  { title: "How to Style the Trend",    format: "Blog Style",       img: "1483985988355-763728e1935b", overlay: "How to\nstyle the\ntrend",   demand: "Rising",      competition: "Low Competition" },
  { title: "Sneaker Product Showcase",  format: "Product Showcase", img: "1542291026-7eec264c27ff",                          demand: "High Demand", competition: "Moderate" },
];

const PRODUCT_IDEAS: ProductIdea[] = [
  { title: "Daily Glow Serum",         source: "Shopify", type: "Physical",  category: "Beauty",           price: "$18–$39", demand: "High Demand", competition: "Low Competition", img: "1556228720-195a672e8a03" },
  { title: "Printable Daily Planner",  source: "Gumroad", type: "Printable", category: "Printables",       price: "$7–$15",  demand: "High Demand", competition: "Low Competition", img: "1611532736597-de2d4265fba3" },
  { title: "Notion Finance Dashboard", source: "Gumroad", type: "Digital",   category: "Digital Products", price: "$12–$29", demand: "Rising",      competition: "Low Competition", img: "1499951360447-b19be8fe80f5" },
  { title: "Gold Layering Set",        source: "Etsy",    type: "Physical",  category: "Jewelry",          price: "$24–$68", demand: "High Demand", competition: "Moderate",        img: "1606760227091-3dd870d97f1d" },
  { title: "Brand Kit Canva Template", source: "Gumroad", type: "Template",  category: "Templates",        price: "$15–$39", demand: "Rising",      competition: "Low Competition", img: "1497032628192-86f99bcd76bc" },
  { title: "Everyday Knit Sneakers",   source: "Shopify", type: "Physical",  category: "Fashion",          price: "$40–$85", demand: "High Demand", competition: "Low Competition", img: "1560769629-975ec94e6a86" },
];

const WEEKLY_PLAN: PlanDay[] = [
  { day: "Mon", date: 9,  title: "Slow Living Loft Tour", board: "Living Room", status: "Ready",         img: "1600585154340-be6161a56a0c" },
  { day: "Tue", date: 10, title: "Cozy Reading Nook",     board: "Home Decor",  status: "Needs details", img: "1493663284031-b7e3aefcae8e" },
  { day: "Wed", date: 11, title: "Gallery Wall Styling",  board: "Wall Art",    status: "Needs date",    img: "1556228453-efd6c1ff04f6" },
  { day: "Thu", date: 12, title: "Minimal Accent Chair",  board: "Furniture",   status: "Planned",       img: "1542435503-956c469947f6" },
  { day: "Fri", date: 13, title: "Morning Matcha Ritual", board: "Lifestyle",   status: "Added to Plan", img: "1522771739844-6a9f6d5f14af" },
  { day: "Sat", date: 14, title: "Weekend Cooking Reel",  board: "Food",        status: "Planned",       img: "1556909114-f6e7ad7d3136" },
  { day: "Sun", date: 15, title: "Capsule Wardrobe Edit", board: "Fashion",     status: "Ready",         img: "1490481651871-ab68de25d43d" },
];

const UNSCHEDULED = ["1531346878377-a5be20888e57", "1526170375885-4d8ecf77b99f"];

// Pin Details mockup
const PIN_DETAILS = {
  previewImg: "1538688525198-9b88f6f53126",
  previewTitle: "Cozy Corner Styling",
  productImg: "1567538096630-e0c55bd6374c",
  productName: "Boucle Accent Chair",
  source: "Etsy",
  url: "https://etsy.com/listing/boucle-accent-chair",
  title: "Cozy Corner Styling",
  description: "Style a calm corner with a boucle accent chair, warm light, and natural textures.",
  plannedDate: "Jun 12, 2026",
  board: "Home Decor",
};

const STATUS_STYLE: Record<Status, { bg: string; color: string }> = {
  "Ready":         { bg: "rgba(16,185,129,0.18)", color: "#10B981" },
  "Needs details": { bg: "rgba(245,158,11,0.18)", color: "#F59E0B" },
  "Needs date":    { bg: "rgba(234,179,8,0.18)",  color: "#EAB308" },
  "Planned":       { bg: "rgba(8,145,178,0.18)",  color: "#38BDF8" },
  "Added to Plan": { bg: "rgba(139,92,246,0.18)", color: "#A78BFA" },
};

const TREND_TICKERS = [
  { emoji: "🔥", name: "Moody Home Decor",     yoy: "+214%", mon: "HIGH" },
  { emoji: "🌿", name: "Boho Living Room",      yoy: "+87%",  mon: "HIGH" },
  { emoji: "🖼️", name: "Gallery Wall Art",     yoy: "+145%", mon: "MID"  },
  { emoji: "✨", name: "Coastal Minimalism",   yoy: "+193%", mon: "HIGH" },
  { emoji: "🕯️", name: "Cottagecore Kitchen",  yoy: "+120%", mon: "HIGH" },
  { emoji: "💎", name: "Quiet Luxury Style",   yoy: "+310%", mon: "HIGH" },
  { emoji: "🌸", name: "Clean Beauty Routine",  yoy: "+176%", mon: "MID"  },
  { emoji: "🪨", name: "Japandi Interiors",    yoy: "+98%",  mon: "MID"  },
];

const PRICING = [
  {
    plan: "Free", monthly: "$0", yearly: "$0", period: "", planKey: "free",
    desc: "Discover opportunities and try the workflow.",
    features: ["Top 3 opportunities / day", "Limited Pin Ideas (9 items)", "Limited Product Ideas (5 items)", "Create Pins sandbox (no publish)"],
    highlighted: false, cta: "Start free",
  },
  {
    plan: "Creator", monthly: "$19", yearly: "$15", period: "/mo", planKey: "creator",
    desc: "Find, create, and plan as a solo creator.",
    features: ["Full opportunity feed (18 categories)", "Pin Ideas + Product Ideas access", "Create Pins — 150 credits / month", "Weekly Plan board"],
    highlighted: false, cta: "Choose Creator",
  },
  {
    plan: "Growth", monthly: "$49", yearly: "$39", period: "/mo", planKey: "growth",
    desc: "Scale product-aware content for your store.",
    features: ["Everything in Creator", "Linked-product Pins + destination URLs", "500 Create Pins credits / month", "CSV export + trend alerts"],
    highlighted: true, cta: "Choose Growth",
  },
  {
    plan: "Agency", monthly: "$99", yearly: "$79", period: "/mo", planKey: "pro",
    desc: "Plan Pinterest content for multiple brands.",
    features: ["Everything in Growth", "Team workspace (3 seats)", "Unlimited Weekly Plans", "White-label opportunity reports"],
    highlighted: false, cta: "Talk to us",
  },
];

const FAQ = [
  { q: "What can I actually do with VibePin?", a: "VibePin walks you through a full Pinterest workflow: discover high-signal opportunities, collect Pin Ideas (content references) and Product Ideas (products to promote or sell), generate Pinterest-native Pin drafts from your product images and references, link products and destination URLs, then organise everything into a weekly plan you review and publish." },
  { q: "What's the difference between Pin Ideas and Product Ideas?", a: "Pin Ideas are visual content references — formats, layouts, and angles you can use as inspiration when you create a Pin. Product Ideas are physical or digital products (from Etsy, Shopify, Gumroad and more) with demand and competition signals that you can promote or sell. Pin Ideas inform what to make; Product Ideas inform what to monetize." },
  { q: "How does Create Pins work?", a: "You add Product Images and Pin References — kept visually separate — write a short creative direction, pick an image count, aspect ratio, and model (GPT Image or Nano Banana). VibePin generates Pinterest-native draft Pins you can review and edit. You can link a product and destination URL in Pin Details before adding the Pin to your weekly plan." },
  { q: "Does VibePin publish to Pinterest automatically?", a: "No. Every publish action requires your explicit review and confirmation. You review each Pin before anything goes to your boards. VibePin never bulk-posts or acts on your account without your approval." },
  { q: "Do I need to connect Pinterest to use the intelligence features?", a: "No. Opportunity intelligence, Pin Ideas, and Product Ideas are all read-only and require no Pinterest connection. You only connect your account when you're ready to publish — and only with your explicit authorization." },
  { q: "Where does the opportunity data come from?", a: "Signals come from Pinterest's public data and official Trends API, then run through a multi-stage scoring pipeline for demand, competition, and trend velocity. The score is a timing signal — not a guarantee of ranking, saves, or sales." },
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

function GenPinCard({ pin }: { pin: GenPin }) {
  return (
    <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "4/5" }}>
      <Image src={u(pin.img, 280, 350)} alt={pin.title} fill className="object-cover" sizes="160px" unoptimized />
      <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/5 to-black/25" />
      <p className="absolute top-2.5 left-3 right-3 text-[15px] font-black text-white leading-tight tracking-tight"
        style={{ textShadow: "0 1px 6px rgba(0,0,0,0.55)", ...SERIF }}>
        {pin.title}
      </p>
    </div>
  );
}

// ── Create Pins composer ──────────────────────────────────────────────────────
function CreatePinsComposer({ data, showControls = true }: { data: ComposerData; showControls?: boolean }) {
  return (
    <div className="rounded-2xl border overflow-hidden shadow-2xl" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5" style={{ color: data.accent }} />
          <span className="text-[12px] font-bold text-white">Create Pins</span>
          <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold" style={{ background: "rgba(255,255,255,0.06)", color: "#6B7280" }}>{data.brand}</span>
        </div>
        <span className="text-[9px]" style={{ color: "#374151", ...MONO }}>studio</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2">
        {/* Composer */}
        <div className="p-4 lg:border-r" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: "#4B5563" }}>
            <Package className="w-3 h-3" /> Product Images
          </p>
          <div className="flex gap-1.5 mb-4">
            {data.products.map((id, i) => (
              <div key={i} className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 46, height: 46, border: "1px solid rgba(255,255,255,0.10)" }}>
                <Image src={u(id, 92, 92)} alt="" fill className="object-cover" sizes="46px" unoptimized />
              </div>
            ))}
            <div className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 46, height: 46, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}>
              <Plus className="w-4 h-4" />
            </div>
          </div>

          <p className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: "#4B5563" }}>
            <ImageIcon className="w-3 h-3" /> Pin References
          </p>
          <div className="flex gap-1.5 mb-4">
            {data.refs.map((id, i) => (
              <div key={i} className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 46, height: 46, border: "1px solid rgba(255,255,255,0.10)" }}>
                <Image src={u(id, 92, 92)} alt="" fill className="object-cover" sizes="46px" unoptimized />
              </div>
            ))}
            <div className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 46, height: 46, border: "1px dashed rgba(255,255,255,0.14)", color: "#4B5563" }}>
              <Plus className="w-4 h-4" />
            </div>
          </div>

          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Creative Direction</p>
          <div className="rounded-lg px-3 py-2.5 mb-4 text-[11px] leading-relaxed" style={{ background: "#080E0B", border: "1px solid rgba(255,255,255,0.07)", color: "#8B9E97" }}>
            {data.direction}
            <span className="block text-right mt-1 text-[9px]" style={{ color: "#374151", ...MONO }}>{data.direction.length} / 500</span>
          </div>

          {showControls && (
            <>
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
                    {["2:3", "4:5", "1:1", "9:16"].map((r, i) => (
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

              <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#4B5563" }}>Model</p>
              <div className="flex gap-2 mb-4">
                <span className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-bold" style={{ background: "rgba(16,185,129,0.14)", color: "#10B981", border: "1px solid rgba(16,185,129,0.30)" }}>
                  <Check className="w-3 h-3" /> GPT Image
                </span>
                <span className="rounded-lg px-3 py-2 text-[11px] font-semibold" style={{ background: "#080E0B", color: "#4B5563", border: "1px solid rgba(255,255,255,0.07)" }}>
                  Nano Banana
                </span>
              </div>
            </>
          )}

          <button type="button" className="btn-cta w-full rounded-full py-2.5 text-[12px] font-bold text-white flex items-center justify-center gap-2">
            Generate Pins <Sparkles className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Generated */}
        <div className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: "#4B5563" }}>Generated Pins</p>
          <div className="grid grid-cols-2 gap-2.5 mb-3">
            {data.gen.map((pin, i) => <GenPinCard key={i} pin={pin} />)}
          </div>
          <div className="flex gap-2">
            <button type="button" className="flex-1 btn-cta rounded-full py-2 text-[11px] font-bold text-white">Add to Plan</button>
            <button type="button" className="flex-1 rounded-full py-2 text-[11px] font-semibold border" style={{ borderColor: "rgba(255,255,255,0.12)", color: "#8B9E97" }}>Edit Details</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pin Details (Plan) panel ──────────────────────────────────────────────────
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

function PinDetailsPanel() {
  const d = PIN_DETAILS;
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#0A1210", borderColor: "rgba(255,255,255,0.06)" }}>
        <span className="text-[12px] font-bold text-white">Pin Details</span>
        <X className="w-3.5 h-3.5" style={{ color: "#4B5563" }} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr]">
        {/* Preview */}
        <div className="p-4 sm:border-r" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Preview</p>
          <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "4/5" }}>
            <Image src={u(d.previewImg, 240, 300)} alt={d.previewTitle} fill className="object-cover" sizes="120px" unoptimized />
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 to-transparent" />
            <p className="absolute top-2 left-2.5 right-2.5 text-[12px] font-black text-white leading-tight" style={{ ...SERIF, textShadow: "0 1px 5px rgba(0,0,0,0.6)" }}>{d.previewTitle}</p>
          </div>
        </div>

        {/* Fields */}
        <div className="p-4">
          <div className="flex gap-1 mb-3">
            <span className="rounded-lg px-3 py-1.5 text-[11px] font-semibold" style={{ color: "#4B5563" }}>Details</span>
            <span className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold" style={{ background: "rgba(8,145,178,0.14)", color: "#38BDF8", border: "1px solid rgba(8,145,178,0.30)" }}>
              <Check className="w-3 h-3" /> Plan
            </span>
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Linked Product</p>
              <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2" style={{ background: "#080E0B", border: "1px solid rgba(255,255,255,0.07)" }}>
                <div className="relative rounded-md overflow-hidden shrink-0" style={{ width: 36, height: 36 }}>
                  <Image src={u(d.productImg, 72, 72)} alt={d.productName} fill className="object-cover" sizes="36px" unoptimized />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-white truncate">{d.productName}</p>
                  <p className="text-[10px]" style={{ color: "#4B5563" }}>{d.source}</p>
                </div>
                <span className="text-[10px] font-bold rounded-full px-2.5 py-1" style={{ color: "#38BDF8", border: "1px solid rgba(8,145,178,0.30)" }}>Change</span>
              </div>
            </div>

            <Field label="Product URL" value={d.url} mono />
            <label className="flex items-center gap-2 text-[11px] cursor-default" style={{ color: "#8B9E97" }}>
              <span className="flex items-center justify-center rounded h-4 w-4" style={{ background: "rgba(8,145,178,0.20)", border: "1px solid rgba(8,145,178,0.40)" }}>
                <Check className="w-3 h-3" style={{ color: "#38BDF8" }} />
              </span>
              Use product URL as destination
            </label>
            <Field label="Title" value={d.title} />
            <Field label="Description" value={d.description} multiline />
            <Field label="Destination URL" value={d.url} mono />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Planned Date" value={d.plannedDate} />
              <Field label="Board / Category" value={d.board} />
            </div>
            <button type="button" className="btn-cta w-full rounded-full py-2.5 text-[12px] font-bold text-white">Add to Plan</button>
          </div>
        </div>
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
  const prodCats   = ["All Categories", "Beauty", "Jewelry", "Fashion", "Printables", "Digital Products", "Templates"];
  const pinList  = pinFilter === "All Formats" ? PIN_IDEAS : PIN_IDEAS.filter(p => p.format === pinFilter);
  const prodList = prodFilter === "All Categories" ? PRODUCT_IDEAS : PRODUCT_IDEAS.filter(p => p.category === prodFilter);
  const pinDisplay  = pinList.length  ? pinList  : PIN_IDEAS;
  const prodDisplay = prodList.length ? prodList : PRODUCT_IDEAS;

  const srcColor  = (s: string) => s === "Etsy" ? "#F87171" : s === "Gumroad" ? "#A78BFA" : "#34D399";
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
            <BrandLogo size={28} />
            <span className="font-black text-white tracking-tight text-[17px]">VibePin</span>
          </div>
          <div className="hidden md:flex items-center gap-5 text-[13px] font-medium" style={{ color: "#6B7280" }}>
            <a href="#intelligence"  className="hover:text-white transition-colors">Intelligence</a>
            <a href="#pin-ideas"      className="hover:text-white transition-colors">Pin Ideas</a>
            <a href="#product-ideas"  className="hover:text-white transition-colors">Product Ideas</a>
            <a href="#create-pins"    className="hover:text-white transition-colors">Create Pins</a>
            <a href="#weekly-plan"    className="hover:text-white transition-colors">Weekly Plan</a>
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
        <div className="max-w-[1280px] mx-auto px-5 grid grid-cols-1 lg:grid-cols-[0.92fr_1.22fr] gap-10 lg:gap-12 items-start">
          {/* Left */}
          <div className="lg:pt-4">
            <div className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 mb-6"
              style={{ background: "rgba(8,145,178,0.08)", borderColor: "rgba(8,145,178,0.22)" }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-500" />
              </span>
              <span className="text-[11px] font-semibold tracking-wide" style={{ color: "#0891B2" }}>The Pinterest workflow for creators &amp; sellers</span>
            </div>

            <h1 className="text-[2.4rem] sm:text-[3rem] lg:text-[3.3rem] font-black text-white leading-[1.06] tracking-[-0.04em] mb-5">
              Find Pinterest opportunities.<br />
              <span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 55%,#7C3AED)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>Turn them into Pins.</span><br />
              Plan your week.
            </h1>

            <p className="text-[15px] sm:text-[16px] leading-relaxed mb-7 max-w-[470px]" style={{ color: "#8B9E97" }}>
              VibePin helps Pinterest creators, ecommerce sellers, and content marketers discover
              high-signal opportunities, collect Pin and Product Ideas, generate Pinterest-native
              Pin drafts, and plan weekly content.
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
              {["Opportunity signals", "Product-aware Pin drafts", "You review every Pin before publishing"].map(item => (
                <span key={item} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4D5E58" }}>
                  <span className="h-1 w-1 rounded-full" style={{ background: "#374151" }} />
                  {item}
                </span>
              ))}
            </div>
          </div>

          {/* Right — Create Pins workflow mockup */}
          <CreatePinsComposer data={HERO_COMPOSER} showControls={false} />
        </div>
      </section>

      {/* ══ PROOF BAR ══════════════════════════════════════════════════════════ */}
      <section className="border-y" style={{ borderColor: "rgba(255,255,255,0.07)", background: "var(--surface)" }}>
        <div className="max-w-[1280px] mx-auto px-5 py-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px" style={{ background: "rgba(255,255,255,0.06)" }}>
            {[
              { icon: Clock,     value: "Daily",  label: "Refreshed opportunity signals"   },
              { icon: Sparkles,  value: "AI",     label: "Product-aware Pin drafts"        },
              { icon: Package,   value: "18",     label: "Categories tracked"              },
              { icon: BarChart2, value: "Weekly", label: "Plan you review before publish"  },
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
                <span style={{ color: t.mon === "HIGH" ? "#10B981" : "#F59E0B" }}>signal: {t.mon}</span>
                <span style={{ color: "#1F2937" }}>·</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ══ PROBLEM ════════════════════════════════════════════════════════════ */}
      <section className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[860px] mx-auto px-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-4" style={{ color: "#4D5E58" }}>The problem</p>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-6 leading-[1.1]">
            Most tools push you to make more.<br />VibePin helps you decide what&apos;s worth making.
          </h2>
          <p className="text-[15px] leading-relaxed mb-8 max-w-2xl" style={{ color: "#8B9E97" }}>
            Producing more Pins doesn&apos;t help if you&apos;re creating for niches that are already crowded.
            VibePin starts upstream — find a real opportunity, collect the right Pin and Product Ideas,
            then generate and plan the Pins worth your time.
          </p>
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
                <p className="text-[13px] font-bold text-white">Find it, create it, plan it</p>
                <p className="text-[11px] mt-0.5" style={{ color: "#4D5E58" }}>One workflow, evidence first</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ INTELLIGENCE (single compact table) ════════════════════════════════ */}
      <section id="intelligence" className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#0891B2" }}>Step 1 · Intelligence</p>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Know what is worth making.</h2>
              <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
                Keyword trends and opportunities ranked by demand, competition, and trend velocity.
              </p>
            </div>
            <Link href="/app/discover?demo=true" className="flex items-center gap-1.5 text-[12px] font-bold transition-colors hover:text-cyan-400" style={{ color: "#0891B2" }}>
              View all opportunities <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
            <div className="hidden sm:grid items-center px-5 py-2.5 border-b"
              style={{ gridTemplateColumns: "1.5rem 1fr 5rem 4rem 5rem 3.5rem", gap: "1rem", borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              {["#", "keyword / opportunity", "trend", "demand", "competition", "score"].map(h => (
                <span key={h} className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: "#374151", ...MONO }}>{h}</span>
              ))}
            </div>
            {INTEL_ROWS.map(row => (
              <div key={row.rank} className="grid items-center px-5 py-3.5 border-b last:border-0"
                style={{ gridTemplateColumns: "1.5rem 1fr 5rem 4rem 5rem 3.5rem", gap: "1rem", borderColor: "rgba(255,255,255,0.04)" }}>
                <span className="text-[12px] font-black tabular-nums" style={{ color: "#4B5563", ...MONO }}>{row.rank}</span>
                <div className="min-w-0">
                  <p className="text-[14px] font-bold text-white">{row.name}</p>
                  <p className="text-[10px] mt-0.5" style={{ color: "#4B5563", ...MONO }}>{row.saves}</p>
                </div>
                <span className="text-[12px] font-bold tabular-nums text-emerald-400" style={MONO}>↗ {row.trend}</span>
                <Pill label={row.demand} tone={row.demand === "High" ? "green" : "amber"} />
                <Pill label={row.competition} tone={row.competition === "Low" ? "green" : "amber"} />
                <ScoreChip score={row.score} />
              </div>
            ))}
            <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Updated 3h ago · Pinterest Trends signal</span>
              <span className="text-[10px]" style={{ color: "#374151", ...MONO }}>Sample of top opportunities · 18 categories</span>
            </div>
          </div>
        </div>
      </section>

      {/* ══ PIN IDEAS ══════════════════════════════════════════════════════════ */}
      <section id="pin-ideas" className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#D946EF" }}>Step 2 · Pin Ideas</p>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Find Pin formats before you create.</h2>
              <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
                Pin formats, layouts, and content angles — the references you save and reuse.
              </p>
            </div>
            <Link href="/app/discover?demo=true" className="flex items-center gap-1.5 text-[12px] font-bold transition-opacity hover:opacity-80" style={{ color: "#E879F9" }}>
              Explore all ideas <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

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

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {pinDisplay.map((idea, i) => (
              <div key={i} className="rounded-xl overflow-hidden group/pin" style={{ background: "#0C1410", border: "1px solid rgba(255,255,255,0.07)" }}>
                <div className="relative" style={{ aspectRatio: "4/5" }}>
                  <Image src={u(idea.img, 280, 350)} alt={idea.title} fill className="object-cover transition-transform duration-500 group-hover/pin:scale-105" sizes="180px" unoptimized />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/10" />
                  <span className="absolute top-1.5 left-1.5 rounded-full px-2 py-0.5 text-[8px] font-bold"
                    style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.30)" }}>
                    {idea.format}
                  </span>
                  {idea.overlay && (
                    <p className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[13px] font-black text-white leading-tight whitespace-pre-line"
                      style={{ textShadow: "0 1px 6px rgba(0,0,0,0.6)", ...SERIF }}>
                      {idea.overlay}
                    </p>
                  )}
                </div>
                <div className="p-2.5">
                  <p className="text-[11px] font-bold text-white leading-tight mb-2 line-clamp-2" style={{ minHeight: "2.2em" }}>{idea.title}</p>
                  <div className="flex flex-wrap gap-1 mb-2.5">
                    <Pill label={idea.demand === "High Demand" ? "High save signal" : "Rising"} tone="green" />
                    <Pill label={idea.competition === "Low Competition" ? "Low competition" : "Moderate"} tone={idea.competition === "Low Competition" ? "cyan" : "amber"} />
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
      <section id="product-ideas" className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1060px] mx-auto px-5">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#10B981" }}>Step 3 · Product Ideas</p>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Find products worth promoting or selling.</h2>
              <p className="max-w-xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
                Physical and digital products with demand, competition, and monetization signals.
              </p>
            </div>
            <Link href="/app/discover?demo=true" className="flex items-center gap-1.5 text-[12px] font-bold transition-opacity hover:opacity-80" style={{ color: "#10B981" }}>
              Explore all products <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

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

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {prodDisplay.map((prod, i) => {
              const ts = typeStyle(prod.type);
              return (
                <div key={i} className="rounded-xl overflow-hidden" style={{ background: "#0C1410", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div className="relative" style={{ aspectRatio: "1/1" }}>
                    <Image src={u(prod.img, 240, 240)} alt={prod.title} fill className="object-cover" sizes="160px" unoptimized />
                    <span className="absolute top-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: ts.bg, color: ts.color }}>{prod.type}</span>
                  </div>
                  <div className="p-2.5">
                    <p className="text-[11px] font-bold text-white leading-tight mb-0.5 line-clamp-2" style={{ minHeight: "2.2em" }}>{prod.title}</p>
                    <p className="text-[9px] font-bold mb-1.5" style={{ color: srcColor(prod.source) }}>{prod.source} · <span style={{ color: "#E5E7EB", ...MONO }}>{prod.price}</span></p>
                    <div className="flex flex-wrap gap-1 mb-2.5">
                      <Pill label={prod.demand === "High Demand" ? "High Demand" : "Rising"} tone="green" />
                      <Pill label={prod.competition === "Low Competition" ? "Low comp" : "Moderate"} tone={prod.competition === "Low Competition" ? "cyan" : "amber"} />
                    </div>
                    <div className="flex items-center gap-1.5 text-[9px] font-semibold">
                      <span className="flex items-center gap-1 transition-colors hover:text-white" style={{ color: "#6B7280" }}><Bookmark className="w-2.5 h-2.5" /> Save to My Products</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[9px] font-semibold mt-1">
                      <span className="flex items-center gap-1 transition-colors hover:text-white" style={{ color: "#6B7280" }}><ImageIcon className="w-2.5 h-2.5" /> Use as Product Image</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ══ CREATE PINS ════════════════════════════════════════════════════════ */}
      <section id="create-pins" className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="mb-8">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#FB923C" }}>Step 4 · Create Pins</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Combine products with references. Generate drafts.</h2>
            <p className="max-w-2xl text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
              Combine product images with Pin references. VibePin generates Pinterest-native drafts you can review, edit, and plan —
              Product Images and Pin References stay visually separate, so every draft stays on-brand.
            </p>
          </div>
          <CreatePinsComposer data={CREATE_COMPOSER} showControls />
        </div>
      </section>

      {/* ══ PIN DETAILS ════════════════════════════════════════════════════════ */}
      <section id="pin-details" className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="grid grid-cols-1 lg:grid-cols-[0.85fr_1.15fr] gap-10 items-center">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#38BDF8" }}>Step 5 · Pin Details</p>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-4">Link the product, set the destination, plan the date.</h2>
              <p className="text-[15px] leading-relaxed mb-5" style={{ color: "#6B7280" }}>
                VibePin isn&apos;t just an image generator. Each Pin connects a linked product, a destination URL,
                a title and description, a planned date, and a board — so your Pins drive traffic where you want it.
              </p>
              <ul className="space-y-2.5">
                {["Linked product + product URL", "Destination URL for traffic", "Title, description, board & planned date", "Add to your weekly plan — you confirm publishing"].map(t => (
                  <li key={t} className="flex items-start gap-2.5 text-[13px]" style={{ color: "#8B9E97" }}>
                    <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#38BDF8" }} /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <PinDetailsPanel />
          </div>
        </div>
      </section>

      {/* ══ WEEKLY PLAN ════════════════════════════════════════════════════════ */}
      <section id="weekly-plan" className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-9">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#A78BFA" }}>Step 6 · Weekly Plan</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Turn scattered drafts into one weekly plan.</h2>
            <p className="max-w-xl mx-auto text-[15px] leading-relaxed" style={{ color: "#6B7280" }}>
              Schedule a week of Pins across your boards — you review and confirm every Pin before it publishes.
            </p>
          </div>

          <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1410", borderColor: "rgba(255,255,255,0.09)" }}>
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
                        <Image src={u(d.img, 160, 200)} alt={d.title} fill className="object-cover" sizes="100px" unoptimized />
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

            <div className="px-5 py-3 border-t flex items-center justify-between gap-3" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A1210" }}>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-semibold shrink-0" style={{ color: "#4B5563", ...MONO }}>Unscheduled drafts ({UNSCHEDULED.length})</span>
                <div className="flex items-center gap-2">
                  {UNSCHEDULED.map((id, i) => (
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
      <section id="pricing" className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
        <div className="max-w-[1100px] mx-auto px-5">
          <div className="text-center mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>Pricing</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Create and plan Pinterest content with product-aware AI.</h2>
            <p className="max-w-lg mx-auto text-[14px] leading-relaxed mb-6" style={{ color: "#6B7280" }}>
              One plan covers the whole workflow — opportunities, Pin Ideas, Product Ideas, Create Pins, and Weekly Plan.
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
      <section className="py-16 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-2xl mx-auto px-5">
          <div className="text-center mb-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3" style={{ color: "#4D5E58" }}>FAQ</p>
            <h2 className="text-3xl font-black text-white tracking-tight">How VibePin works</h2>
          </div>
          {FAQ.map(item => <FaqItem key={item.q} q={item.q} a={item.a} />)}
        </div>
      </section>

      {/* ══ FINAL CTA ══════════════════════════════════════════════════════════ */}
      <section className="py-28 relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-80" style={{ background: "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(217,70,239,0.08) 0%, transparent 100%)" }} />
        <div className="max-w-2xl mx-auto px-5 text-center relative">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-4" style={{ color: "#0891B2" }}>Opportunities → Pin Ideas → Product Ideas → Create Pins → Pin Details → Weekly Plan</p>
          <h2 className="text-4xl sm:text-5xl font-black text-white tracking-tight mb-5 leading-[1.05]">Start planning this<br />week&apos;s Pinterest content.</h2>
          <p className="text-[15px] mb-10 leading-relaxed" style={{ color: "#6B7280" }}>
            Find high-signal opportunities, turn them into Pinterest-native Pins, and organise them into one weekly plan you review and publish on your terms.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/app/discover?demo=true" className="btn-cta flex items-center justify-center gap-2 rounded-full px-9 py-4 text-[14px] font-bold text-white">
              Build your next 7 Pins →
            </Link>
            <a href="#intelligence" className="flex items-center justify-center gap-2 rounded-full border px-9 py-4 text-[14px] font-bold transition-colors hover:text-white"
              style={{ borderColor: "rgba(255,255,255,0.12)", color: "#8B9E97" }}>
              See this week&apos;s opportunities
            </a>
          </div>
          <p className="mt-5 text-[11px]" style={{ color: "#374151" }}>No credit card required · Cancel anytime · You review every Pin before publishing</p>
        </div>
      </section>

      {/* ══ FOOTER ═════════════════════════════════════════════════════════════ */}
      <footer className="border-t pt-14 pb-8" style={{ borderColor: "rgba(255,255,255,0.07)", background: "var(--surface)" }}>
        <div className="max-w-[1200px] mx-auto px-5 grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <BrandLogo size={28} />
              <span className="font-black text-white text-sm tracking-tight">VibePin</span>
            </div>
            <p className="text-[11px] leading-relaxed" style={{ color: "#374151" }}>
              VibePin helps creators and sellers discover Pinterest opportunities, create Pin drafts, and plan content with user review and approval.
            </p>
          </div>
          {[
            { title: "Workflow", links: [
              { label: "Intelligence",  href: "#intelligence" },
              { label: "Pin Ideas",     href: "#pin-ideas" },
              { label: "Product Ideas", href: "#product-ideas" },
              { label: "Create Pins",   href: "#create-pins" },
              { label: "Weekly Plan",   href: "#weekly-plan" },
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
          <p>Pinterest data pipeline · Refreshed daily · You review every Pin</p>
        </div>
      </footer>

      {/* ══ STICKY CTA ═════════════════════════════════════════════════════════ */}
      <div className={`fixed bottom-0 left-0 right-0 z-50 border-t backdrop-blur-md px-5 py-3.5 flex items-center justify-between gap-4 transition-all duration-300 ${
        showStickyCta ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"}`}
        style={{ background: "rgba(8,14,11,0.95)", borderColor: "rgba(255,255,255,0.09)" }}>
        <div>
          <p className="font-bold text-white text-[13px]">Discover, create, and plan your Pinterest week — in one flow.</p>
          <p className="text-[11px] mt-0.5" style={{ color: "#374151" }}>No credit card required · You review every Pin before publishing</p>
        </div>
        <Link href="/app/discover?demo=true" className="btn-cta shrink-0 rounded-full px-5 py-2.5 text-[13px] font-bold text-white">Build my 7 Pins</Link>
      </div>

    </div>
  );
}
