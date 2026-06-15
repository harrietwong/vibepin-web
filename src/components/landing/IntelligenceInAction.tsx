"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Search, Bookmark, Check, TrendingUp, ArrowRight, X, Sparkles, ShoppingBag,
  Home, BarChart2, Wand2, Layers,
} from "lucide-react";
import { pickByCategory, type LandingAsset } from "@/lib/landingAssets";

const VibeBtn = "btn-cta rounded-full font-bold text-white transition-transform hover:scale-[1.03] active:scale-100";

// ── Preview data (titles/metrics are illustrative; images come from real assets) ─
const PIN_PREVIEW = [
  { title: "Cozy boho living room ideas you'll love", format: "Lifestyle",     saves: "34K" },
  { title: "Simple decor changes that transform a room", format: "Detail",     saves: "28K" },
  { title: "Small corner, big boho vibe",             format: "Before / After", saves: "21K" },
  { title: "Layered lighting for warm evenings",      format: "Tutorial",      saves: "18K" },
  { title: "Natural textures that feel expensive",    format: "Lifestyle",     saves: "16K" },
  { title: "Plant styling for cozy corners",          format: "Detail",        saves: "14K" },
];
const PRODUCT_PREVIEW = [
  { title: "Castage 8x10 Area Rug, Washable Green Rug for Living Room", marketplace: "Amazon", saves: "14K", score: 60, sub: "whimsical apartment aesthetic" },
  { title: "Olive Artificial Hanging Plant with Pot, Faux Greenery",   marketplace: "Amazon", saves: "9.3K", score: 58, sub: "cozy corner styling" },
  { title: "Handcrafted Moroccan Geometric Ceiling Light",            marketplace: "Etsy",   saves: "7.1K", score: 62, sub: "warm layered lighting" },
  { title: "Rattan Accent Chair with Natural Weave",                  marketplace: "Amazon", saves: "6.4K", score: 57, sub: "natural texture seating" },
  { title: "Ceramic Table Vase Set, Matte Neutral Tones",            marketplace: "Etsy",   saves: "5.2K", score: 55, sub: "neutral tablescape" },
  { title: "Woven Wall Basket Decor Set",                            marketplace: "Amazon", saves: "4.8K", score: 54, sub: "textured wall styling" },
];
const NAV_ICONS = [Home, Sparkles, Bookmark, ShoppingBag, Wand2, BarChart2, Layers];

// ── Primitives ────────────────────────────────────────────────────────────────
function AssetImg({ asset, label }: { asset?: LandingAsset; label?: string }) {
  if (asset?.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.imageUrl} alt={asset.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />;
  }
  return <div className="absolute inset-0 flex items-center justify-center text-[7px] font-semibold uppercase tracking-wide" style={{ background: "linear-gradient(135deg,#141622,#0b0d15)", color: "#2A2F3E" }}>{label ?? "VibePin"}</div>;
}

function MiniSidebar() {
  return (
    <div className="hidden sm:flex flex-col items-center gap-3 py-3 px-2 border-r shrink-0" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A0E16" }}>
      <div className="h-6 w-6 rounded-md flex items-center justify-center" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}><span className="text-[10px] font-black text-white">V</span></div>
      {NAV_ICONS.map((Icon, i) => <span key={i} className="h-7 w-7 rounded-md flex items-center justify-center" style={i === 2 ? { background: "rgba(217,70,239,0.16)", color: "#E879F9" } : { color: "#4B5563" }}><Icon className="w-3.5 h-3.5" /></span>)}
    </div>
  );
}

function FilterPill({ label, caret }: { label: string; caret?: boolean }) {
  return <span className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[10px] font-semibold whitespace-nowrap shrink-0" style={{ background: "#0A0E16", border: "1px solid rgba(255,255,255,0.08)", color: "#9097A0" }}>{label}{caret && <span style={{ color: "#4B5563" }}>▾</span>}</span>;
}

function Sparkline({ color }: { color: string }) {
  return <svg viewBox="0 0 40 14" width="40" height="14" fill="none" className="shrink-0"><polyline points="0,11 8,8 14,10 20,5 28,7 34,3 40,2" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// ── Pin Ideas panel + evidence drawer ─────────────────────────────────────────
function PinIdeasFeature({ pins }: { pins: LandingAsset[] }) {
  const [sel, setSel] = useState(0);
  const selPin = PIN_PREVIEW[sel];
  return (
    <div className="grid lg:grid-cols-[minmax(0,32%)_minmax(0,68%)] gap-8 lg:gap-10 items-start">
      {/* text */}
      <div className="lg:pt-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] mb-3 flex items-center gap-1.5" style={{ color: "#E879F9" }}><Sparkles className="w-3.5 h-3.5" /> Pin Evidence</p>
        <h3 className="text-3xl font-black text-white tracking-tight mb-4 leading-[1.1]">See what&apos;s already<br /><span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 60%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>earning saves.</span></h3>
        <p className="text-[14px] leading-relaxed mb-5" style={{ color: "#8B93A1" }}>Explore high-performing Pinterest Pins, understand why they work, and use the strongest ideas as creative references.</p>
        <ul className="space-y-3 mb-6">{["Spot high-demand, low-competition ideas", "Understand why a Pin is performing", "Create from the idea or use it as a reference"].map(t => <li key={t} className="flex items-center gap-2.5 text-[13px]" style={{ color: "#C8CDD6" }}><span className="h-5 w-5 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(217,70,239,0.16)", color: "#E879F9" }}><Check className="w-3 h-3" /></span>{t}</li>)}</ul>
        <Link href="/app/discover?demo=true" className={`${VibeBtn} inline-flex items-center gap-2 px-6 py-3 text-[13px]`}>Explore Pin Ideas <ArrowRight className="w-4 h-4" /></Link>
      </div>

      {/* UI: panel + evidence drawer */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(0,290px)] gap-3 items-start">
        <div className="rounded-2xl border overflow-hidden flex" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)", boxShadow: "0 24px 70px rgba(0,0,0,0.30)" }}>
          <MiniSidebar />
          <div className="flex-1 min-w-0 p-4">
            <p className="text-[15px] font-black text-white">Pin Ideas</p>
            <p className="text-[10px] mb-3" style={{ color: "#6B7280" }}>Find high-performing Pins and proven content angles.</p>
            <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 mb-2.5" style={{ background: "#0A0E16", border: "1px solid rgba(255,255,255,0.08)" }}><Search className="w-3.5 h-3.5" style={{ color: "#4B5563" }} /><span className="text-[11px]" style={{ color: "#4B5563" }}>Search niches, keywords, or Pin titles...</span></div>
            <div className="flex items-center gap-1.5 mb-3 overflow-x-auto no-scrollbar" style={{ scrollbarWidth: "none" }}><FilterPill label="Format" caret /><FilterPill label="Niche: Room Decor" caret /><FilterPill label="Demand" caret /><FilterPill label="Competition" caret /><FilterPill label="More filters" /></div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {pins.slice(0, 6).map((a, i) => {
                const meta = PIN_PREVIEW[i];
                const active = i === sel;
                return (
                  <button type="button" key={i} onClick={() => setSel(i)} className="text-left rounded-xl overflow-hidden transition-transform hover:-translate-y-0.5" style={{ background: "#0A0E16", border: active ? "1px solid rgba(217,70,239,0.55)" : "1px solid rgba(255,255,255,0.08)", boxShadow: active ? "0 0 0 1px rgba(217,70,239,0.35)" : "none" }}>
                    <div className="relative" style={{ aspectRatio: "1/1" }}>
                      <AssetImg asset={a} label="Pin" />
                      <span className="absolute top-1.5 left-1.5 rounded-md px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(16,185,129,0.85)", color: "#04140d" }}>{meta.format}</span>
                      <span className="absolute top-1.5 right-1.5 h-5 w-5 rounded-md flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}><Bookmark className="w-2.5 h-2.5 text-white" /></span>
                    </div>
                    <div className="p-2">
                      <p className="text-[9.5px] font-bold text-white leading-tight line-clamp-2 mb-1.5" style={{ minHeight: "2.4em" }}>{meta.title}</p>
                      <div className="flex items-center justify-between mb-1"><span className="text-[9px] font-bold text-white">{meta.saves} saves</span><Sparkline color="#10B981" /></div>
                      <p className="text-[8px] font-semibold" style={{ color: "#10B981" }}>High demand · <span style={{ color: "#38BDF8" }}>Low comp.</span></p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Evidence drawer */}
        <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1018", borderColor: "rgba(217,70,239,0.28)", boxShadow: "0 24px 70px rgba(217,70,239,0.12)" }}>
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A0E16" }}>
            <div><p className="text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: "#E879F9" }}>View Evidence</p><p className="text-[12px] font-bold text-white">Home Decor</p></div>
            <X className="w-4 h-4" style={{ color: "#4B5563" }} />
          </div>
          <div className="p-4">
            <div className="relative rounded-xl overflow-hidden mb-3" style={{ aspectRatio: "4/3" }}>
              <AssetImg asset={pins[sel]} label="Pin" />
              <span className="absolute top-2 left-2 rounded-md px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(16,185,129,0.85)", color: "#04140d" }}>{selPin.format}</span>
              <span className="absolute bottom-2 left-2 text-[11px] font-black text-white" style={{ textShadow: "0 1px 4px rgba(0,0,0,0.6)" }}>{selPin.saves} saves</span>
              <span className="absolute bottom-2 right-2 h-6 w-6 rounded-md flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}><Bookmark className="w-3 h-3 text-white" /></span>
            </div>
            <div className="space-y-1.5 mb-3">
              <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold" style={{ background: "rgba(16,185,129,0.10)", color: "#10B981" }}><Check className="w-3.5 h-3.5" /> High Demand</div>
              <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold" style={{ background: "rgba(56,189,248,0.10)", color: "#38BDF8" }}><Check className="w-3.5 h-3.5" /> Low Competition</div>
              <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold" style={{ background: "rgba(217,70,239,0.10)", color: "#E879F9" }}><TrendingUp className="w-3.5 h-3.5" /> Rising</div>
            </div>
            <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8B93A1" }}>💡 Users are saving this heavily while commercial competition remains low.</p>
            <Link href="/app/studio?demo=true" className={`${VibeBtn} w-full py-2.5 text-[12px] flex items-center justify-center gap-1.5 mb-2`}><Sparkles className="w-3.5 h-3.5" /> Create Pin from this idea</Link>
            <Link href="/app/discover?demo=true" className="w-full rounded-full py-2.5 text-[12px] font-semibold border flex items-center justify-center gap-1.5 transition-colors hover:text-white hover:border-white/30" style={{ borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }}><Bookmark className="w-3.5 h-3.5" /> Use as Pin Reference</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function RelationshipBar() {
  return (
    <div className="rounded-2xl border px-6 py-5" style={{ background: "linear-gradient(135deg,#0C1018,#100B1A)", borderColor: "rgba(255,255,255,0.09)" }}>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-5 sm:gap-8">
        <div className="flex items-center gap-3">
          <span className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(217,70,239,0.16)", color: "#E879F9" }}><Sparkles className="w-5 h-5" /></span>
          <div><p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "#E879F9" }}>Pin Evidence</p><p className="text-[13px] font-bold text-white">How to create</p></div>
        </div>
        <span className="hidden sm:flex items-center" style={{ color: "#4B5563" }}><span className="h-px w-10" style={{ background: "linear-gradient(90deg,#E879F9,#38BDF8)" }} /><ArrowRight className="w-4 h-4 mx-1" /><span className="h-px w-10" style={{ background: "linear-gradient(90deg,#E879F9,#38BDF8)" }} /></span>
        <div className="flex items-center gap-3">
          <span className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(56,189,248,0.16)", color: "#38BDF8" }}><ShoppingBag className="w-5 h-5" /></span>
          <div><p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "#38BDF8" }}>Product Signals</p><p className="text-[13px] font-bold text-white">What to promote</p></div>
        </div>
      </div>
      <p className="text-center text-[12px] mt-4" style={{ color: "#6B7280" }}>Together, they turn Pinterest activity into an actionable content decision.</p>
    </div>
  );
}

// ── Product finder panel + drawer ─────────────────────────────────────────────
function ProductOpportunitiesFeature({ products }: { products: LandingAsset[] }) {
  const [sel, setSel] = useState(0);
  const selProd = PRODUCT_PREVIEW[sel];
  return (
    <div className="grid lg:grid-cols-[minmax(0,68%)_minmax(0,32%)] gap-8 lg:gap-10 items-start">
      {/* UI: panel + drawer */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(0,290px)] gap-3 items-start order-2 lg:order-1">
        <div className="rounded-2xl border overflow-hidden flex" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.10)", boxShadow: "0 24px 70px rgba(0,0,0,0.30)" }}>
          <MiniSidebar />
          <div className="flex-1 min-w-0 p-4">
            <p className="text-[15px] font-black text-white">Product Opportunity Finder</p>
            <p className="text-[10px] mb-3" style={{ color: "#6B7280" }}>Discover high-potential products from Pinterest demand signals.</p>
            <div className="flex gap-2 mb-2.5">
              <span className="flex-1 rounded-lg px-2.5 py-1.5 text-[10px] font-bold" style={{ background: "rgba(217,70,239,0.14)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.30)" }}>Physical Products <span style={{ color: "#6B7280" }}>· 12K</span></span>
              <span className="flex-1 rounded-lg px-2.5 py-1.5 text-[10px] font-semibold" style={{ background: "#0A0E16", color: "#6B7280", border: "1px solid rgba(255,255,255,0.08)" }}>Digital Products · 1.7K</span>
            </div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex-1 flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ background: "#0A0E16", border: "1px solid rgba(255,255,255,0.08)" }}><Search className="w-3.5 h-3.5" style={{ color: "#4B5563" }} /><span className="text-[10px]" style={{ color: "#4B5563" }}>Search products, keywords, or niches...</span></div>
              <FilterPill label="Sort: Opportunity" caret />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {products.slice(0, 6).map((a, i) => {
                const meta = PRODUCT_PREVIEW[i];
                const active = i === sel;
                return (
                  <button type="button" key={i} onClick={() => setSel(i)} className="text-left rounded-xl overflow-hidden transition-transform hover:-translate-y-0.5" style={{ background: "#0A0E16", border: active ? "1px solid rgba(56,189,248,0.55)" : "1px solid rgba(255,255,255,0.08)", boxShadow: active ? "0 0 0 1px rgba(56,189,248,0.35)" : "none" }}>
                    <div className="relative" style={{ aspectRatio: "1/1" }}>
                      <AssetImg asset={a} label="Product" />
                      <span className="absolute top-1.5 left-1.5 rounded-md px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(217,70,239,0.85)", color: "#fff" }}>High Opportunity</span>
                      <span className="absolute top-1.5 right-1.5 h-5 w-5 rounded-md flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}><Bookmark className="w-2.5 h-2.5 text-white" /></span>
                    </div>
                    <div className="p-2">
                      <p className="text-[9.5px] font-bold text-white leading-tight line-clamp-2 mb-1" style={{ minHeight: "2.4em" }}>{meta.title}</p>
                      <p className="text-[8px] mb-1" style={{ color: "#6B7280" }}>{meta.marketplace}</p>
                      <div className="flex items-center justify-between mb-1.5 text-[8px] font-bold"><span className="text-white">{meta.saves} saves</span><span style={{ color: "#38BDF8" }}>Score {meta.score}</span></div>
                      <span className="block w-full rounded-md py-1 text-center text-[8px] font-bold text-white" style={{ background: "linear-gradient(135deg,#D946EF,#7C3AED)" }}>Use in Create Pins</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Product drawer */}
        <div className="rounded-2xl border overflow-hidden" style={{ background: "#0C1018", borderColor: "rgba(56,189,248,0.28)", boxShadow: "0 24px 70px rgba(56,189,248,0.10)" }}>
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0A0E16" }}>
            <div><p className="text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: "#38BDF8" }}>Product Opportunity</p><p className="text-[12px] font-bold text-white">{selProd.marketplace}</p></div>
            <X className="w-4 h-4" style={{ color: "#4B5563" }} />
          </div>
          <div className="p-4">
            <div className="relative rounded-xl overflow-hidden mb-3" style={{ aspectRatio: "4/3" }}><AssetImg asset={products[sel]} label="Product" /></div>
            <div className="flex gap-1.5 mb-2"><span className="rounded-full px-2 py-0.5 text-[9px] font-bold" style={{ background: "rgba(217,70,239,0.16)", color: "#E879F9" }}>High Opportunity</span><span className="rounded-full px-2 py-0.5 text-[9px] font-bold" style={{ background: "rgba(16,185,129,0.14)", color: "#10B981" }}>Strong Fit</span></div>
            <p className="text-[12.5px] font-bold text-white leading-snug mb-0.5">{selProd.title}</p>
            <p className="text-[10px] mb-3" style={{ color: "#6B7280" }}>{selProd.sub}</p>
            <div className="rounded-xl p-3 mb-3" style={{ background: "#0A0E16", border: "1px solid rgba(255,255,255,0.07)" }}>
              <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>Product assessment</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div><p className="text-[15px] font-black text-white">{selProd.saves}</p><p className="text-[8px]" style={{ color: "#6B7280" }}>Source Pin saves</p></div>
                <div><p className="text-[15px] font-black" style={{ color: "#38BDF8" }}>{selProd.score}</p><p className="text-[8px]" style={{ color: "#6B7280" }}>Opportunity score</p></div>
                <div><p className="text-[15px] font-black" style={{ color: "#10B981" }}>Low</p><p className="text-[8px]" style={{ color: "#6B7280" }}>Commercial competition</p></div>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#8B93A1" }}>💡 Strong Pinterest interest with limited commercial competition creates a clear opportunity to promote.</p>
            <Link href="#" className="w-full rounded-full py-2.5 text-[12px] font-semibold border flex items-center justify-center gap-1.5 mb-2 transition-colors hover:text-white hover:border-white/30" style={{ borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }}>View on {selProd.marketplace}</Link>
            <Link href="/app/studio?demo=true" className={`${VibeBtn} w-full py-2.5 text-[12px] flex items-center justify-center gap-1.5`}><Sparkles className="w-3.5 h-3.5" /> Use in Create Pins</Link>
          </div>
        </div>
      </div>

      {/* text */}
      <div className="lg:pt-6 order-1 lg:order-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] mb-3 flex items-center gap-1.5" style={{ color: "#38BDF8" }}><ShoppingBag className="w-3.5 h-3.5" /> Product Signals</p>
        <h3 className="text-3xl font-black text-white tracking-tight mb-4 leading-[1.1]">Find products<br /><span style={{ background: "linear-gradient(100deg,#38BDF8,#818CF8 60%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>people already want.</span></h3>
        <p className="text-[14px] leading-relaxed mb-5" style={{ color: "#8B93A1" }}>Discover physical and digital products connected to real Pinterest demand—not random marketplace listings.</p>
        <ul className="space-y-3 mb-6">{["Match products to Pinterest interest", "See demand and competition evidence", "Send products directly into Create Pins"].map(t => <li key={t} className="flex items-center gap-2.5 text-[13px]" style={{ color: "#C8CDD6" }}><span className="h-5 w-5 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(56,189,248,0.16)", color: "#38BDF8" }}><Check className="w-3 h-3" /></span>{t}</li>)}</ul>
        <Link href="/app/discover?demo=true" className={`${VibeBtn} inline-flex items-center gap-2 px-6 py-3 text-[13px]`}>Explore Product Opportunities <ArrowRight className="w-4 h-4" /></Link>
      </div>
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────
export default function IntelligenceInAction({ pinSamples, products }: { pinSamples: LandingAsset[]; products: LandingAsset[] }) {
  const pins = pickByCategory(pinSamples, "Home Decor", 6, "Pin");
  const prods = pickByCategory(products, "Home Decor", 6, "Product");
  return (
    <section className="py-24 lg:py-28 border-t relative overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.06)", background: "var(--surface)" }}>
      <div className="pointer-events-none absolute inset-x-0 top-10 h-72 blur-3xl" style={{ background: "radial-gradient(ellipse at 50% 20%, rgba(217,70,239,0.10), transparent 68%)" }} />
      <div className="max-w-[1280px] mx-auto px-6 lg:px-8 relative">
        <div className="text-center max-w-[680px] mx-auto mb-14">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] mb-4" style={{ color: "#A855F7" }}>Intelligence in action</p>
          <h2 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-[1.05] mb-5">Start with proof,<br /><span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 60%,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>not a blank prompt.</span></h2>
          <p className="text-[14px] sm:text-[15px] leading-relaxed" style={{ color: "#8B93A1" }}>Use proven Pin performance and product demand signals to decide what to create and what to promote.</p>
        </div>

        <div className="mb-10"><PinIdeasFeature pins={pins} /></div>
        <div className="mb-10"><RelationshipBar /></div>
        <div className="mb-14"><ProductOpportunitiesFeature products={prods} /></div>

        {/* Bottom CTA */}
        <div className="rounded-2xl border p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6" style={{ background: "linear-gradient(135deg,#0E1018,#140B22)", borderColor: "rgba(168,85,247,0.24)", boxShadow: "0 24px 80px rgba(0,0,0,0.28)" }}>
          <div className="flex items-center gap-4">
            <span className="h-12 w-12 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(217,70,239,0.16)", color: "#E879F9", border: "1px solid rgba(217,70,239,0.22)" }}><Sparkles className="w-5 h-5" /></span>
            <div>
              <h3 className="text-xl sm:text-2xl font-black text-white tracking-tight">Turn proven signals into <span style={{ background: "linear-gradient(100deg,#FF4D8D,#A855F7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>your next Pins.</span></h3>
              <p className="text-[13px] mt-1" style={{ color: "#8B93A1" }}>Choose a winning idea, add a high-potential product, and create Pinterest-native content in one workflow.</p>
            </div>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <Link href="/app/studio?demo=true" className={`${VibeBtn} inline-flex items-center gap-2 px-7 py-3.5 text-[14px]`}>Start creating Pins <ArrowRight className="w-4 h-4" /></Link>
            <div className="hidden xl:flex items-center gap-2.5">
              <div className="flex -space-x-2">{["#FF4D8D", "#D946EF", "#A855F7", "#7C3AED"].map((g, i) => <span key={i} className="h-7 w-7 rounded-full border-2" style={{ borderColor: "var(--surface)", background: `linear-gradient(135deg,${g},#0C1018)` }} />)}</div>
              <span className="text-[11px] max-w-[140px]" style={{ color: "#6B7280" }}>Built for creators, sellers and marketing managers</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
