"use client";
import Image from "next/image";
import { Suspense, useId, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  Flame, Sparkles, ChevronDown, X, ExternalLink, ShoppingBag,
  TrendingUp, LayoutGrid, List, Mail, Lock, Search, MoreHorizontal,
} from "lucide-react";
import { BookmarkButton } from "@/components/ui/BookmarkButton";
import { supabase, type ViralPin } from "@/lib/supabase";
import * as refLib from "@/lib/productLibraryStore";
import * as assetStore from "@/lib/assetStore";
import { toast } from "sonner";
import { EvidenceLine } from "@/components/ui/signals";
import { assessPin } from "@/lib/scoring";
import type { MarketTag } from "@/types/opportunity";
import { MomentumIcon } from "@/components/ui/OpportunityCard";
import { matchesNiche } from "@/lib/niches";
import { useNicheScope } from "@/lib/useNicheScope";
import { CATEGORIES } from "@/lib/categories";
import { buildPrefillFromViralPin, openCreatePins } from "@/lib/createPinsPrefill";
import { NicheModal } from "@/components/ui/NicheModal";
import { ScopeBar } from "@/components/ui/ScopeBar";
import {
  PRIMARY_BADGE_META, TREND_CHIP_META,
  type PrimaryBadge, type TrendStateChip,
} from "@/lib/workspaceStatics";
import type { DestinationType, ItemType, ProductSubtype, RiskFlag } from "@/lib/assetClassification";

// ── Pin signal helpers ─────────────────────────────────────────────────────────

function marketTagToSignalKey(tag: string): PrimaryBadge {
  if (tag === "hidden_supply" || tag === "new_account_friendly") return "best_bet";
  if (tag === "oversaturated") return "competitive";
  return "steady";
}

function momentumToTrendKey(momentum: string, category: string): TrendStateChip {
  if (category === "holidays-seasonal") return "seasonal";
  return momentum === "surging" ? "rising" : "evergreen";
}

const MARKET_TAG_DETAIL: Record<MarketTag, string> = {
  hidden_supply:        "High demand with limited supply",
  new_account_friendly: "Fast-rising, not yet flooded",
  oversaturated:        "High commercial density",
  low_volume:           "Limited audience reach",
};

// ── Opportunity band helpers ───────────────────────────────────────────────────

type DemandBand = "High" | "Medium" | "Low";
type CompBand   = "Low" | "Medium" | "High";

function getDemandBand(pin: ViralPin): DemandBand {
  const saves = pin.save_count ?? 0;
  const vel   = pin.save_velocity ?? 0;
  if (saves >= 10000 || vel >= 100) return "High";
  if (saves >= 2000  || vel >= 20)  return "Medium";
  return "Low";
}

function getCompetitionBand(marketTag: string): CompBand {
  if (marketTag === "oversaturated")        return "High";
  if (marketTag === "hidden_supply")        return "Low";
  if (marketTag === "new_account_friendly") return "Low";
  return "Medium";
}

function getEvidenceSentence(trendKey: TrendStateChip, marketTag: string): string {
  const trend = trendKey === "rising" ? "Rising" : trendKey === "seasonal" ? "Seasonal" : "Evergreen";
  const sig   = marketTag === "hidden_supply" || marketTag === "new_account_friendly"
    ? "Strong save signal"
    : marketTag === "oversaturated"
    ? "High competition area"
    : "Repeatable visual pattern";
  return `${trend} · ${sig}`;
}

const DEMAND_BAND_STYLE = {
  High:   { bg: "rgba(16,185,129,0.10)",  color: "#059669" },
  Medium: { bg: "rgba(245,158,11,0.10)",  color: "#D97706" },
  Low:    { bg: "rgba(156,163,175,0.10)", color: "#6B7280" },
} as const;

const COMP_BAND_STYLE = {
  Low:    { bg: "rgba(16,185,129,0.10)",  color: "#059669" },
  Medium: { bg: "rgba(245,158,11,0.10)",  color: "#D97706" },
  High:   { bg: "rgba(239,68,68,0.10)",   color: "#DC2626" },
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

// Simple deterministic sparkline from pin index
const SPARKLINE_PATHS = [
  "M0,8 C10,4 20,12 30,5 C40,2 50,10 60,7",
  "M0,10 C10,6 20,9 30,4 C40,2 50,8 60,5",
  "M0,6 C10,11 20,4 30,9 C40,12 50,5 60,8",
  "M0,9 C10,12 20,5 30,10 C40,6 50,9 60,4",
  "M0,5 C10,9 20,3 30,7 C40,11 50,4 60,8",
];

function Sparkline({ seed = 0 }: { seed?: number }) {
  const path = SPARKLINE_PATHS[((seed % SPARKLINE_PATHS.length) + SPARKLINE_PATHS.length) % SPARKLINE_PATHS.length];
  return (
    <svg width="48" height="16" viewBox="0 0 60 16" fill="none" aria-hidden>
      <path d={path} stroke="#C026D3" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

type RelatedProduct = {
  id: string; product_name: string; image_url: string | null;
  domain: string | null; price: number | null; source_url: string | null;
};

// ── Viral pin categories ───────────────────────────────────────────────────────
const VIRAL_CATS: { label: string; db: string }[] = [
  { label: "All", db: "" },
  ...CATEGORIES.map(c => ({ label: `${c.emoji} ${c.label}`, db: c.id })),
];

type SortMode = "opportunity" | "save_signal" | "freshness" | "product_signal";
type ViewMode = "gallery" | "analysis";

// ── Fetchers ──────────────────────────────────────────────────────────────────
const PIN_SELECT =
  "id,image_url,category,title,description,save_count,reaction_count,pin_id,source_url,outbound_link,pin_created_at,scraped_at,save_velocity,days_since_creation";

function enrichPin(p: Record<string, unknown>): ViralPin {
  const daysAgo: number =
    (p.days_since_creation as number | null) ??
    Math.max(1, Math.round(
      (new Date((p.scraped_at as string) || Date.now()).getTime() -
        new Date((p.pin_created_at as string) || (p.scraped_at as string) || Date.now()).getTime()) / 86400000,
    ));
  return {
    ...(p as unknown as ViralPin),
    days_since_created: daysAgo,
    save_velocity: (p.save_velocity as number | null) ?? Math.round((p.save_count as number) / daysAgo),
    is_high_growth: (p.save_count as number) >= 10000,
  };
}

async function fetchRising(): Promise<ViralPin[]> {
  const { data, error } = await supabase
    .from("pin_samples")
    .select(PIN_SELECT)
    .gte("save_count", 100)
    .order("save_count", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []).map(enrichPin);
}

async function fetchByCategory(cat: string): Promise<ViralPin[]> {
  const { data, error } = await supabase
    .from("pin_samples")
    .select(PIN_SELECT)
    .eq("category", cat)
    .order("save_count", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []).map(enrichPin);
}

// ── Demo mode helpers ─────────────────────────────────────────────────────────
const MON_HINT: Record<string, string> = {
  hidden_supply:        "Affiliate Products (Etsy + Amazon) — High ROI",
  new_account_friendly: "Product Roundups — Growing Demand",
  oversaturated:        "Niche Sub-category Affiliate",
  low_volume:           "Low-volume Testing Ground",
};

const SAT_EVIDENCE: Record<string, string> = {
  hidden_supply:        "Blue Ocean — few sellers in feed, low competition density. Good entry window right now.",
  new_account_friendly: "Early Trend — still accessible for new accounts. Competition will intensify within 30–60 days.",
  oversaturated:        "Red Sea — high competition, conversion efficiency declining. Consider long-tail sub-niches instead.",
  low_volume:           "Low volume — limited search demand. High risk, limited return.",
};

const MON_ROUTE: Record<string, string> = {
  hidden_supply:        "Etsy + Amazon affiliate — high-ROI products confirmed in top-saving Pins.",
  new_account_friendly: "Amazon product roundups — growing category, easier to rank for new accounts.",
  oversaturated:        "Niche sub-category affiliate — avoid broad terms, go specific to convert.",
  low_volume:           "Low-volume test market — validate interest before committing budget.",
};

function getWhyItWorks(category: string): string {
  const WHY: Record<string, string> = {
    "home-decor":       "High-save decor pins drive consistent affiliate clicks year-round",
    "fashion":          "Style saves convert to product intent at 2–3× other categories",
    "beauty":           "Tutorial-style pins earn long shelf life in beauty feeds",
    "wedding":          "Evergreen saves — brides pin 18+ months before the event",
    "diy-crafts":       "Tutorial formats get reshared across multiple boards",
    "food-and-drink":   "Recipe pins drive high outbound clicks to blogs and products",
    "digital-products": "Mockup-style pins sell without physical inventory",
    "travel":           "Destination pins resave for years as aspiration boards",
    "gardening":        "Seasonal saves spike in spring — timing multiplies reach",
    "parenting":        "High-trust category with strong affiliate purchase intent",
  };
  return WHY[category.toLowerCase()] ?? "High-save pins signal confirmed audience demand";
}

function demoTitleTemplate(cat: string): string {
  const c = cat.toLowerCase();
  if (c.includes("home") || c.includes("decor") || c.includes("interior"))
    return `10 ${cat} Ideas That Will Transform Your Space`;
  if (c.includes("fashion") || c.includes("style") || c.includes("outfit"))
    return `The ${cat} Look for 2026: Everything Worth Pinning`;
  if (c.includes("beauty") || c.includes("makeup") || c.includes("skincare"))
    return `${cat} Essentials: A Curated Pinterest Guide`;
  if (c.includes("wedding") || c.includes("bride"))
    return `${cat} Inspiration: Ideas Every Planner Is Saving`;
  return `The Best ${cat} Ideas Worth Pinning This Season`;
}

// ── Filter chip helpers ───────────────────────────────────────────────────────
function FilterChip({
  label, active, color, bg, onClick,
}: { label: string; active: boolean; color?: string; bg?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="rounded-full px-3 py-1 text-[11px] font-semibold transition-all whitespace-nowrap"
      style={active
        ? { background: bg ?? "rgba(192,38,211,0.08)", color: color ?? "#C026D3", border: `1px solid ${color ?? "#C026D3"}40` }
        : { background: "#F9FAFB", border: "1px solid #E5E7EB", color: "#6B7280" }}>
      {label}
    </button>
  );
}

// ── Pin Intelligence Drawer ───────────────────────────────────────────────────
function PinDrawer({ pin, onClose }: { pin: ViralPin; onClose: () => void }) {
  const age   = (pin.days_since_created ?? (pin as Record<string, unknown>).days_since_creation as number) ?? 60;
  const vel   = pin.save_velocity ?? 0;
  const saves = pin.save_count ?? 0;
  const cat   = pin.category;

  const assessment  = assessPin({ save_count: saves, velocity: vel, age_days: age });
  const trendKey    = momentumToTrendKey(assessment.momentum, cat);
  const trendMeta   = TREND_CHIP_META[trendKey];
  const trendPrefix = trendKey === "rising" ? "↑ " : trendKey === "seasonal" ? "◎ " : "∞ ";
  const tagDetail   = MARKET_TAG_DETAIL[assessment.marketTag as MarketTag] ?? "";
  const demand      = getDemandBand(pin);
  const comp        = getCompetitionBand(assessment.marketTag);

  const catDef    = CATEGORIES.find(c => c.id === cat);
  const pinUrl    = pin.pin_id ? `https://www.pinterest.com/pin/${pin.pin_id}/` : null;
  function handleCreatePin() {
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromViralPin({
      id: pin.id, image_url: pin.image_url, save_count: pin.save_count,
      source_keyword: cat, category: cat,
    }));
  }

  const { data: relatedProducts } = useSWR(
    ["pin-drawer-products", cat],
    async () => {
      const { data } = await supabase
        .from("pin_products")
        .select("id,product_name,image_url,domain,price,source_url")
        .ilike("seed_keyword", `%${cat}%`)
        .gte("save_count", 5)
        .order("save_count", { ascending: false })
        .limit(4);
      return (data ?? []) as RelatedProduct[];
    },
    { revalidateOnFocus: false },
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-[440px] h-full flex flex-col shadow-2xl overflow-y-auto bg-white border-l border-gray-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 shrink-0 sticky top-0 z-10 bg-white border-b border-gray-100">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-[#C026D3]">View Evidence</p>
            <p className="text-[11px] text-gray-500 mt-0.5 capitalize">{catDef?.emoji ?? "📌"} {catDef?.label ?? cat}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>

        <div className="flex-1 px-5 pt-4 pb-8 space-y-4">

          {/* Demand + Competition + image */}
          <div className="flex gap-3">
            <div className="flex flex-col gap-2 shrink-0">
              <span className="text-[10px] font-bold px-2.5 py-1 rounded-md whitespace-nowrap"
                style={{ background: DEMAND_BAND_STYLE[demand].bg, color: DEMAND_BAND_STYLE[demand].color, border: `1px solid ${DEMAND_BAND_STYLE[demand].color}33` }}>
                {demand} Demand
              </span>
              <span className="text-[10px] font-semibold px-2.5 py-1 rounded-md whitespace-nowrap"
                style={{ background: COMP_BAND_STYLE[comp].bg, color: COMP_BAND_STYLE[comp].color, border: `1px solid ${COMP_BAND_STYLE[comp].color}33` }}>
                {comp} Competition
              </span>
              <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
                style={{ background: `${trendMeta.color}12`, color: trendMeta.color }}>
                {trendPrefix}{trendMeta.label}
              </span>
              <span className="text-[9px] text-gray-400 leading-snug">{tagDetail}</span>
            </div>
            <div className="flex-1 relative rounded-2xl overflow-hidden" style={{ minHeight: 200 }}>
              <Image src={pin.image_url} alt="" fill className="object-cover" sizes="280px" unoptimized />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
              <div className="absolute top-2 left-2">
                <span className="rounded-full bg-white/90 px-2 py-0.5 text-[9px] font-bold text-gray-800 capitalize">{catDef?.label ?? cat}</span>
              </div>
              <div className="absolute bottom-2 left-2 right-2">
                <EvidenceLine saves={saves} />
              </div>
            </div>
          </div>

          {/* Pin Assessment */}
          <div className="rounded-xl p-3 bg-gray-50 border border-gray-100">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2.5">Pin Assessment</p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="rounded-lg p-2 bg-white border border-gray-100">
                <p className="text-[9px] text-gray-400 uppercase tracking-widest">Est. Monthly Vol</p>
                <p className="text-[12px] font-black mt-0.5 text-gray-900">
                  👁️ {assessment.estMonthlyVolume >= 1_000 ? `${(assessment.estMonthlyVolume / 1_000).toFixed(0)}K` : String(assessment.estMonthlyVolume)}
                </p>
              </div>
              <div className="rounded-lg p-2 bg-white border border-gray-100">
                <p className="text-[9px] text-gray-400 uppercase tracking-widest">Momentum</p>
                <div className="flex items-center gap-1 mt-0.5">
                  <MomentumIcon level={assessment.momentum} />
                  <span className="text-[11px] font-bold" style={{ color: trendMeta.color }}>
                    {trendPrefix}{trendMeta.label}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-[10px] text-gray-500 leading-relaxed">💡 {assessment.insight}</p>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Velocity",  value: vel > 0 ? `${fmt(vel)}/d` : "—",    color: "#C026D3" },
              { label: "Age",       value: age > 0 ? `${age}d` : "—",          color: "#6B7280" },
              { label: "Reactions", value: fmt(pin.reaction_count),             color: "#EF4444" },
            ].map(s => (
              <div key={s.label} className="rounded-xl p-2.5 text-center bg-gray-50 border border-gray-100">
                <p className="text-[13px] font-black" style={{ color: s.color }}>{s.value}</p>
                <p className="text-[9px] text-gray-400 mt-0.5 uppercase tracking-widest">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Pin title */}
          {pin.title && (
            <div className="rounded-xl p-3 bg-gray-50 border border-gray-100">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5">Pin Title</p>
              <p className="text-[12px] text-gray-700 leading-relaxed line-clamp-3">{pin.title}</p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={handleCreatePin}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-full py-2.5 text-[12px] font-bold transition-all hover:opacity-90 text-white"
              style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)", border: "none", cursor: "pointer" }}>
              <Sparkles className="h-3.5 w-3.5" /> Create Pin from this idea
            </button>
            <button type="button" onClick={handleCreatePin}
              className="flex items-center justify-center gap-1 rounded-full px-4 py-2.5 text-[12px] font-bold text-gray-500 border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
              style={{ cursor: "pointer" }}>
              Use as Pin Reference
            </button>
            <a href="/app/trends"
              className="flex items-center justify-center gap-1 rounded-full px-4 py-2.5 text-[12px] font-bold text-gray-500 border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors">
              <TrendingUp className="h-3.5 w-3.5" />
            </a>
            {pinUrl && (
              <a href={pinUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-1 rounded-full px-4 py-2.5 text-[12px] font-bold"
                style={{ background: "rgba(107,114,128,0.06)", border: "1px solid rgba(107,114,128,0.15)", color: "#6B7280" }}>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>

          {/* Related Products */}
          {(relatedProducts ?? []).length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-1.5">
                <ShoppingBag className="h-3 w-3" /> Related Products
              </p>
              <div className="grid grid-cols-2 gap-2">
                {(relatedProducts ?? []).map(p => (
                  <a key={p.id}
                    href={p.source_url ?? "/app/products"}
                    target={p.source_url ? "_blank" : undefined}
                    rel={p.source_url ? "noopener noreferrer" : undefined}
                    className="rounded-xl overflow-hidden no-underline transition-all bg-white border border-gray-100 hover:border-gray-200 hover:shadow-sm">
                    <div className="relative overflow-hidden" style={{ aspectRatio: "1/1" }}>
                      {p.image_url
                        ? <Image src={p.image_url} alt="" fill className="object-cover" sizes="150px" unoptimized />
                        : <div className="absolute inset-0 flex items-center justify-center bg-gray-50"><ShoppingBag className="h-5 w-5 text-gray-300" /></div>}
                      {p.price && (
                        <span className="absolute bottom-1.5 right-1.5 text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-white/90 text-gray-800 border border-gray-100">
                          ${p.price.toFixed(0)}
                        </span>
                      )}
                    </div>
                    <div className="p-2">
                      <p className="text-[10px] font-semibold text-gray-800 line-clamp-2 leading-snug">{p.product_name}</p>
                      <p className="text-[9px] text-gray-400 mt-0.5">{p.domain?.replace(/^www\./, "")}</p>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Gallery card ──────────────────────────────────────────────────────────────
function ViralCard({ pin, index, onSelect }: { pin: ViralPin; index: number; onSelect: (p: ViralPin) => void }) {
  const age        = pin.days_since_created ?? 60;
  const vel        = pin.save_velocity ?? 0;
  const saves      = pin.save_count ?? 0;
  const assessment = assessPin({ save_count: saves, velocity: vel, age_days: age });
  const trendKey   = momentumToTrendKey(assessment.momentum, pin.category);
  const demand     = getDemandBand(pin);
  const comp       = getCompetitionBand(assessment.marketTag);
  const evidence   = getEvidenceSentence(trendKey, assessment.marketTag);
  const catDef     = CATEGORIES.find(c => c.id === pin.category);
  const pinUrl     = pin.pin_id ? `https://www.pinterest.com/pin/${pin.pin_id}/` : undefined;
  function handleCreatePinCard(e: React.MouseEvent) {
    e.stopPropagation();
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromViralPin({
      id: pin.id, image_url: pin.image_url, save_count: pin.save_count,
      source_keyword: pin.category, category: pin.category,
    }));
  }

  return (
    <div
      className="group relative rounded-2xl bg-white border border-gray-100 shadow-sm hover:shadow-md hover:border-gray-200 transition-all duration-300 cursor-pointer break-inside-avoid"
      onClick={() => onSelect(pin)}
    >
      {/* Image */}
      <div className="relative overflow-hidden rounded-t-2xl" style={{ aspectRatio: "520/780" }}>
        <Image src={pin.image_url} alt="" fill unoptimized
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          sizes="(max-width:640px) 46vw, 200px" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-black/5 to-transparent" />

        {/* Category chip + bookmark */}
        <div className="absolute top-2.5 left-2.5 right-2.5 flex items-start justify-between">
          <span className="rounded-full bg-white/90 px-2.5 py-0.5 text-[10px] font-bold text-neutral-800 capitalize shadow-sm">
            {catDef?.label ?? pin.category}
          </span>
          <span onClick={e => e.stopPropagation()} className="shrink-0">
            <BookmarkButton
              item={{
                id: pin.id,
                type: "pin",
                title: pin.title ?? pin.category,
                category: pin.category,
                image_url: pin.image_url,
                pin_id: pin.pin_id ?? undefined,
                marketTag: assessment.marketTag,
              }}
              className="bg-white/90 hover:bg-white shadow-sm"
            />
          </span>
        </div>

        {/* Hover action bar */}
        <div
          className="absolute inset-x-0 bottom-0 translate-y-full group-hover:translate-y-0 transition-transform duration-200 px-2.5 py-2.5 pointer-events-none group-hover:pointer-events-auto"
          style={{ background: "linear-gradient(to top, rgba(0,0,0,0.82) 60%, transparent 100%)" }}
        >
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={handleCreatePinCard}
              className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[10px] font-bold text-white hover:opacity-90 transition-opacity"
              style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)", border: "none", cursor: "pointer" }}>
              <Sparkles className="h-3 w-3 shrink-0" /> Create Pin from this idea
            </button>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                refLib.saveReference({ imageUrl: pin.image_url, source: "viral_pin", keyword: pin.category });
                assetStore.saveAsset({
                  role: "style_reference",
                  assetRole: "pin_reference",
                  itemType: (pin.item_type as ItemType | undefined) ?? "pin_idea",
                  productType: "unknown",
                  productSubtype: (pin.product_subtype as ProductSubtype | undefined) ?? "unknown",
                  destinationType: (pin.destination_type as DestinationType | undefined) ?? "unknown",
                  sourceContext: "saved_from_pin_ideas",
                  riskFlags: (pin.risk_flags as RiskFlag[] | undefined) ?? [],
                  source: "viral_pin",
                  imageUrl: pin.image_url,
                  title: pin.title ?? pin.category,
                  keyword: pin.source_keyword ?? pin.category,
                  category: pin.category,
                  sourceUrl: pin.outbound_link ?? pin.source_url ?? undefined,
                });
                toast.success("Saved to Reference Library");
              }}
              className="rounded-full px-3 py-1.5 text-[10px] font-semibold text-white/90 hover:text-white transition-colors whitespace-nowrap"
              style={{ background: "rgba(255,255,255,0.14)", border: "1px solid rgba(255,255,255,0.18)" }}>
              Save to References
            </button>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onSelect(pin); }}
              className="ml-auto rounded-full p-1.5 hover:bg-white/20 transition-colors"
              style={{ color: "rgba(255,255,255,0.85)" }}
              title="More actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Card footer */}
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-1 flex-wrap">
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
            style={{ background: DEMAND_BAND_STYLE[demand].bg, color: DEMAND_BAND_STYLE[demand].color, border: `1px solid ${DEMAND_BAND_STYLE[demand].color}33` }}>
            {demand} Demand
          </span>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md whitespace-nowrap"
            style={{ background: COMP_BAND_STYLE[comp].bg, color: COMP_BAND_STYLE[comp].color, border: `1px solid ${COMP_BAND_STYLE[comp].color}33` }}>
            {comp} Competition
          </span>
          {pinUrl && (
            <a href={pinUrl} target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="ml-auto flex items-center justify-center rounded-full w-5 h-5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
              style={{ background: "rgba(230,0,35,0.85)" }}>
              <svg viewBox="0 0 24 24" className="w-3 h-3" fill="white" aria-hidden>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
              </svg>
            </a>
          )}
        </div>
        <p className="text-[9px] text-gray-400">{evidence}</p>
      </div>
    </div>
  );
}

// ── Analysis table row ─────────────────────────────────────────────────────────
function AnalysisRow({ pin, onSelect }: { pin: ViralPin; onSelect: (p: ViralPin) => void }) {
  const age        = pin.days_since_created ?? 60;
  const vel        = pin.save_velocity ?? 0;
  const saves      = pin.save_count ?? 0;
  const assessment  = assessPin({ save_count: saves, velocity: vel, age_days: age });
  const trendKey    = momentumToTrendKey(assessment.momentum, pin.category);
  const trendMeta   = TREND_CHIP_META[trendKey];
  const trendPrefix = trendKey === "rising" ? "↑ " : trendKey === "seasonal" ? "◎ " : "∞ ";
  const catDef      = CATEGORIES.find(c => c.id === pin.category);
  function handleAnalysisCreatePin(e: React.MouseEvent) {
    e.stopPropagation();
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromViralPin({
      id: pin.id, image_url: pin.image_url, save_count: pin.save_count,
      source_keyword: pin.category, category: pin.category,
    }));
  }
  const demand      = getDemandBand(pin);
  const comp        = getCompetitionBand(assessment.marketTag);

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer group transition-colors border-b border-gray-100 last:border-0"
      onClick={() => onSelect(pin)}
    >
      {/* Pin preview */}
      <div className="relative h-12 w-9 rounded-lg overflow-hidden shrink-0 bg-gray-100">
        <Image src={pin.image_url} alt="" fill className="object-cover" sizes="36px" unoptimized />
      </div>

      {/* Category */}
      <div className="w-28 shrink-0">
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize whitespace-nowrap">
          {catDef?.emoji ?? "📌"} {catDef?.label ?? pin.category}
        </span>
      </div>

      {/* Demand */}
      <div className="w-24 shrink-0">
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
          style={{ background: DEMAND_BAND_STYLE[demand].bg, color: DEMAND_BAND_STYLE[demand].color, border: `1px solid ${DEMAND_BAND_STYLE[demand].color}33` }}>
          {demand}
        </span>
      </div>

      {/* Competition */}
      <div className="w-24 shrink-0">
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md whitespace-nowrap"
          style={{ background: COMP_BAND_STYLE[comp].bg, color: COMP_BAND_STYLE[comp].color, border: `1px solid ${COMP_BAND_STYLE[comp].color}33` }}>
          {comp}
        </span>
      </div>

      {/* Trend */}
      <div className="w-24 shrink-0 flex items-center gap-1">
        <MomentumIcon level={assessment.momentum} />
        <span className="text-[9px] font-semibold whitespace-nowrap" style={{ color: trendMeta.color }}>
          {trendPrefix}{trendMeta.label}
        </span>
      </div>

      {/* Save signal */}
      <div className="w-20 shrink-0">
        <span className="text-[11px] font-semibold" style={{ color: vel > 0 ? "#C026D3" : "#9CA3AF" }}>
          {vel > 0 ? `${fmt(vel)}/d` : "—"}
        </span>
      </div>

      {/* Actions */}
      <div className="ml-auto shrink-0 flex items-center gap-1.5">
        <button type="button" onClick={handleAnalysisCreatePin}
          className="opacity-0 group-hover:opacity-100 transition-opacity rounded-full px-3 py-1.5 text-[10px] font-bold whitespace-nowrap text-white"
          style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)", border: "none", cursor: "pointer" }}>
          Create Pin from this idea
        </button>
        <button type="button" onClick={handleAnalysisCreatePin}
          className="opacity-0 group-hover:opacity-100 transition-opacity rounded-full px-3 py-1.5 text-[10px] font-semibold whitespace-nowrap"
          style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3", border: "none", cursor: "pointer" }}>
          Use as Pin Reference
        </button>
        <button type="button" onClick={e => { e.stopPropagation(); onSelect(pin); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity rounded-full px-3 py-1.5 text-[10px] font-semibold whitespace-nowrap text-gray-500 border border-gray-200 hover:bg-gray-50">
          Evidence
        </button>
        <span onClick={e => e.stopPropagation()}>
          <BookmarkButton
            item={{
              id: pin.id,
              type: "pin",
              title: pin.title ?? pin.category,
              category: pin.category,
              image_url: pin.image_url,
              pin_id: pin.pin_id ?? undefined,
              marketTag: assessment.marketTag,
            }}
          />
        </span>
      </div>
    </div>
  );
}

// ── Demo: email capture modal ─────────────────────────────────────────────────
function CaptureModal({
  onClose, selectedKeywords, lockedClicks, sessionId,
}: {
  onClose: () => void; selectedKeywords: string[]; lockedClicks: number; sessionId: string;
}) {
  const [email, setEmail]   = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    try {
      await fetch("/api/demo-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email, selected_keywords: selectedKeywords,
          selected_count: selectedKeywords.length, category: "home-decor",
          intent: "weekly_plan", source_cta: "build_weekly_plan",
          locked_clicks: lockedClicks, session_id: sessionId,
          lead_stage: `selected_${Math.min(selectedKeywords.length, 7)}`,
        }),
      });
    } catch (_) { /* non-fatal */ }
    setStatus("done");
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative z-10 bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6" onClick={e => e.stopPropagation()}>
        {status === "done" ? (
          <div className="text-center py-6">
            <p className="text-3xl mb-3">✅</p>
            <p className="text-[16px] font-black text-gray-900 mb-2">You&apos;re on the list.</p>
            <p className="text-[13px] text-gray-500 mb-5 leading-relaxed">
              We&apos;ll use your {selectedKeywords.length} selections to prepare your weekly Pinterest plan when beta access opens.
            </p>
            <button type="button" onClick={onClose}
              className="rounded-full px-5 py-2.5 text-[12px] font-bold text-white"
              style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
              Continue demo
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 mb-4">
              <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: "rgba(192,38,211,0.08)", border: "1px solid rgba(192,38,211,0.22)" }}>
                <Mail className="h-4 w-4" style={{ color: "#C026D3" }} />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-0.5" style={{ color: "#C026D3" }}>
                  Weekly Pin Plan · {selectedKeywords.length} of 7 selected
                </p>
                <p className="text-[15px] font-black text-gray-900 leading-tight">Get your 7-day Pinterest plan</p>
              </div>
            </div>
            <p className="text-[12px] text-gray-500 mb-5 leading-relaxed">
              We&apos;ll send a weekly plan with 7 trend-backed Pin ideas, title angles, and monetization signals — based on your Home Decor selections.
            </p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 text-[13px] focus:outline-none focus:border-[#C026D3] focus:ring-1 focus:ring-[#C026D3] transition-colors" />
              <button type="submit" disabled={status === "loading"}
                className="w-full rounded-full py-3 text-[13px] font-bold text-white transition-opacity hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                {status === "loading" ? "Sending…" : "Send my weekly plan"}
              </button>
            </form>
            <button type="button" onClick={onClose}
              className="mt-3 w-full text-center text-[12px] text-gray-400 hover:text-gray-600 transition-colors">
              Continue demo
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function DemoBanner() {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2 shrink-0 text-white"
      style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
      </span>
      <span className="text-[11px] font-semibold">Demo · Home Decor · 10 of 48 opportunities shown</span>
      <span className="text-white/40 text-[11px]">·</span>
      <span className="text-[11px] text-white/75">Select 7 to build your weekly Pin plan</span>
    </div>
  );
}

function DemoAnalysisRow({
  pin, isSelected, onSelect, onViewPins, rowIndex, sessionId,
}: {
  pin: ViralPin; isSelected: boolean; onSelect: () => void;
  onViewPins: (p: ViralPin) => void; rowIndex: number; sessionId: string;
}) {
  const [showEvidence, setShowEvidence] = useState(false);

  const age        = pin.days_since_created ?? 60;
  const vel        = pin.save_velocity ?? 0;
  const saves      = pin.save_count ?? 0;
  const assessment = assessPin({ save_count: saves, velocity: vel, age_days: age });
  const signalKey  = marketTagToSignalKey(assessment.marketTag);
  const signalMeta = PRIMARY_BADGE_META[signalKey];
  const monHint    = MON_HINT[assessment.marketTag] ?? "Affiliate Products";
  const titleTpl   = demoTitleTemplate(pin.category);

  const demandText = saves >= 10_000
    ? `${fmt(saves)} saves · ${fmt(vel)}/day velocity — high confirmed demand`
    : saves >= 1_000
    ? `${fmt(saves)} saves · ${fmt(vel)}/day velocity — growing demand`
    : `${fmt(saves)} saves — early-stage interest, monitor for growth`;

  const satText = SAT_EVIDENCE[assessment.marketTag] ?? SAT_EVIDENCE.low_volume;
  const monText = MON_ROUTE[assessment.marketTag]    ?? MON_ROUTE.low_volume;

  async function handleEvidenceToggle() {
    const next = !showEvidence;
    setShowEvidence(next);
    if (next) {
      try {
        await supabase.from("demo_events").insert({
          event_type: "opened_evidence",
          session_id: sessionId,
          payload: { keyword: pin.category, tier: assessment.marketTag, row_index: rowIndex },
        });
      } catch (_) { /* non-fatal */ }
    }
  }

  return (
    <div className={`px-4 py-4 border-b border-gray-100 last:border-0 transition-colors ${isSelected ? "bg-emerald-50/60" : "hover:bg-gray-50"}`}>
      <div className="flex items-start gap-3">
        <div className="relative h-[72px] w-[52px] rounded-xl overflow-hidden shrink-0 bg-gray-100">
          <Image src={pin.image_url} alt="" fill className="object-cover" sizes="52px" unoptimized />
          {isSelected && (
            <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/80 rounded-xl">
              <span className="text-white text-[16px]">✓</span>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
              style={{ background: signalMeta.bg, color: signalMeta.color, border: `1px solid ${signalMeta.color}33` }}>
              {signalMeta.label}
            </span>
            <span className="text-[11px] font-semibold text-gray-700 capitalize">{pin.category}</span>
            <span className="ml-auto text-[10px] text-gray-400 shrink-0">💾 {fmt(saves)}</span>
          </div>
          <p className="text-[11px] text-gray-500 leading-snug mb-2 line-clamp-2">💡 {assessment.insight}</p>
          <div className="mb-2.5">
            <span className="text-[10px] font-semibold rounded-full px-2.5 py-1"
              style={{ background: "rgba(16,185,129,0.08)", color: "#059669", border: "1px solid rgba(16,185,129,0.15)" }}>
              💰 {monHint}
            </span>
          </div>
          <div className="space-y-1.5 mb-3">
            <div className="rounded-lg px-3 py-2 text-[11px] font-medium text-gray-800 bg-gray-50 border border-gray-200">
              📌 {titleTpl}
            </div>
            <div className="relative rounded-lg px-3 py-2 overflow-hidden" style={{ background: "#F9FAFB", border: "1px solid #F3F4F6", minHeight: 34 }}>
              <span className="text-[11px] text-gray-300 select-none" style={{ filter: "blur(4px)" }}>
                {`How to Style ${pin.category} on a Budget: Expert Tips`}
              </span>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="flex items-center gap-1 text-[9px] font-bold rounded-full px-2 py-0.5"
                  style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.22)" }}>
                  <Lock className="w-2.5 h-2.5" /> Unlock
                </span>
              </div>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <button type="button" onClick={() => onViewPins(pin)}
              className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[10px] font-semibold transition-colors"
              style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.15)" }}>
              🖼️ View Pins
            </button>
            <button type="button" onClick={isSelected ? undefined : onSelect} disabled={isSelected}
              className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[10px] font-semibold transition-all"
              style={isSelected
                ? { background: "rgba(16,185,129,0.12)", color: "#059669", border: "1px solid rgba(16,185,129,0.30)", cursor: "default" }
                : { background: "rgba(8,145,178,0.06)", color: "#374151", border: "1px solid #E5E7EB" }}>
              {isSelected ? "✓ Selected" : "+ Select for weekly plan"}
            </button>
            <button type="button" onClick={handleEvidenceToggle}
              className="ml-auto text-[10px] font-semibold transition-colors"
              style={{ color: showEvidence ? "#C026D3" : "#9CA3AF" }}>
              {showEvidence ? "Hide ▲" : "Why this? ▼"}
            </button>
          </div>
          {showEvidence && (
            <div className="mt-2 rounded-lg overflow-hidden border" style={{ borderColor: "rgba(8,145,178,0.18)" }}>
              {([
                { label: "Demand",       text: demandText },
                { label: "Saturation",   text: satText    },
                { label: "Monetization", text: monText    },
              ] as { label: string; text: string }[]).map(row => (
                <div key={row.label} className="flex items-start gap-2 px-3 py-2 border-b last:border-0"
                  style={{ borderColor: "rgba(192,38,211,0.08)", background: row.label === "Demand" ? "rgba(8,145,178,0.03)" : "transparent" }}>
                  <span className="shrink-0 text-[9px] font-bold uppercase tracking-widest pt-0.5 w-[72px]" style={{ color: "#C026D3" }}>
                    {row.label}
                  </span>
                  <span className="text-[11px] leading-snug" style={{ color: "#4B5563" }}>{row.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const DEMO_GOAL = 7;

function DemoProgressBar({ selected, onBuild }: { selected: number; onBuild: () => void }) {
  const done = selected >= DEMO_GOAL;
  return (
    <div className="px-6 py-2.5 flex items-center gap-4 border-b"
      style={{ background: done ? "rgba(16,185,129,0.04)" : "#FAFAFA", borderColor: done ? "rgba(16,185,129,0.18)" : "#F3F4F6" }}>
      <div className="flex items-center gap-2.5 flex-1 min-w-0">
        <span className="text-[11px] font-semibold shrink-0" style={{ color: done ? "#059669" : "#6B7280" }}>
          {done ? "✅ Weekly plan complete" : "📋 Weekly plan"}
        </span>
        <div className="flex items-center gap-1">
          {Array.from({ length: DEMO_GOAL }).map((_, i) => (
            <div key={i} className="rounded-full transition-all duration-300"
              style={{ width: i < selected ? 10 : 8, height: i < selected ? 10 : 8, background: i < selected ? "#D946EF" : "#E5E7EB" }} />
          ))}
        </div>
        <span className="text-[11px] shrink-0" style={{ color: done ? "#059669" : "#9CA3AF" }}>
          {selected}/{DEMO_GOAL} selected
        </span>
        {!done && (
          <span className="text-[10px] text-gray-400 truncate hidden sm:block">
            · Select {DEMO_GOAL - selected} more {DEMO_GOAL - selected === 1 ? "opportunity" : "opportunities"} to build your plan
          </span>
        )}
      </div>
      {done && (
        <button type="button" onClick={onBuild}
          className="shrink-0 rounded-full px-4 py-2 text-[12px] font-bold text-white transition-all hover:brightness-105"
          style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
          Get my 7-day Pin plan →
        </button>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
function DiscoverPageInner() {
  const searchParams = useSearchParams();
  const isDemo       = searchParams.get("demo") === "true";

  const [vCat,         setVCat]         = useState(isDemo ? "🏠 Home Decor" : "All");
  const [demandFilter, setDemandFilter] = useState<"all" | DemandBand>("all");
  const [compFilter,   setCompFilter]   = useState<"all" | CompBand>("all");
  const [trendFilter,  setTrendFilter]  = useState<"all" | TrendStateChip>("all");
  const [search,       setSearch]       = useState("");
  const [sort,         setSort]         = useState<SortMode>("opportunity");
  const [sortOpen,     setSortOpen]     = useState(false);
  const [viewMode,     setViewMode]     = useState<ViewMode>(isDemo ? "analysis" : "gallery");
  const [selectedPin,  setSelectedPin]  = useState<ViralPin | null>(null);
  const [showModal,    setShowModal]    = useState(false);

  // Demo state
  const [selectedIds,  setSelectedIds]  = useState<string[]>([]);
  const [lockedClicks, setLockedClicks] = useState(0);
  const [showCapture,  setShowCapture]  = useState(false);
  const sessionId = useId().replace(/[^a-z0-9]/gi, "");

  function handleDemoSelect(pin: ViralPin) {
    setSelectedIds(prev => prev.includes(pin.id) ? prev : [...prev, pin.id]);
  }

  const { selectedNiches, scope, isFiltering, initialized, setScope, saveNiches } = useNicheScope();

  const catDb = isDemo ? "home-decor" : (VIRAL_CATS.find(c => c.label === vCat)?.db ?? "");

  const { data: rawRising, isLoading } = useSWR(
    catDb ? `discover-cat-${catDb}` : "discover-rising",
    catDb ? () => fetchByCategory(catDb) : fetchRising,
    { revalidateOnFocus: false, keepPreviousData: true },
  );

  const TAG_RANK: Record<string, number> = { hidden_supply: 4, new_account_friendly: 3, oversaturated: 2, low_volume: 1 };

  const viralCards = useMemo(() => {
    let list = rawRising ?? [];

    if (isFiltering && !isDemo) {
      list = list.filter(p => matchesNiche([p.category, p.title], selectedNiches));
    }
    if (!isDemo && search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        (p.title ?? "").toLowerCase().includes(q) || p.category.toLowerCase().includes(q),
      );
    }
    if (!isDemo && demandFilter !== "all") {
      list = list.filter(p => getDemandBand(p) === demandFilter);
    }
    if (!isDemo && compFilter !== "all") {
      list = list.filter(p => {
        const ass = assessPin({ save_count: p.save_count ?? 0, velocity: p.save_velocity ?? 0, age_days: p.days_since_created ?? 60 });
        return getCompetitionBand(ass.marketTag) === compFilter;
      });
    }
    if (!isDemo && trendFilter !== "all") {
      list = list.filter(p => {
        const ass = assessPin({ save_count: p.save_count ?? 0, velocity: p.save_velocity ?? 0, age_days: p.days_since_created ?? 60 });
        return momentumToTrendKey(ass.momentum, p.category) === trendFilter;
      });
    }

    const sorted = [...list].sort((a, b) => {
      if (sort === "opportunity") {
        const rankOf = (p: ViralPin) => {
          const tag = assessPin({ save_count: p.save_count ?? 0, velocity: p.save_velocity ?? 0, age_days: p.days_since_created ?? 60 }).marketTag;
          return (TAG_RANK[tag] ?? 0) * 1_000_000 + (p.save_count ?? 0);
        };
        return rankOf(b) - rankOf(a);
      }
      if (sort === "save_signal") return (b.save_velocity ?? 0) - (a.save_velocity ?? 0);
      if (sort === "freshness")   return (a.days_since_created ?? 9999) - (b.days_since_created ?? 9999);
      return (b.reaction_count ?? 0) - (a.reaction_count ?? 0);
    });

    return isDemo ? sorted.slice(0, 10) : sorted;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRising, sort, isFiltering, selectedNiches, isDemo, search, demandFilter, compFilter, trendFilter]);

  const SORT_OPTIONS: { value: SortMode; label: string }[] = [
    { value: "opportunity",    label: "Best Opportunity" },
    { value: "save_signal",    label: "Save signal"    },
    { value: "freshness",      label: "Freshness"      },
    { value: "product_signal", label: "Product signal" },
  ];

  const hasActiveFilters =
    demandFilter !== "all" || compFilter !== "all" || trendFilter !== "all" || search.trim() !== "" || (vCat !== "All" && !isDemo);

  function clearFilters() {
    setDemandFilter("all"); setCompFilter("all"); setTrendFilter("all"); setSearch(""); setVCat("All");
    setScope("all_trends");
  }

  return (
    <div className="app-page h-full overflow-y-auto">
      {isDemo && <DemoBanner />}
      {isDemo && (
        <DemoProgressBar selected={selectedIds.length} onBuild={() => setShowCapture(true)} />
      )}

      <main className="max-w-[1380px] mx-auto px-6 py-7">

        {/* ── Header row ── */}
        {!isDemo ? (
          <div className="flex items-start justify-between gap-6 mb-5">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 mb-1">Pin Ideas</p>
              <h1 className="text-[22px] font-black text-gray-900 tracking-tight leading-tight">Pin Ideas</h1>
              <p className="text-[13px] text-gray-500 mt-1">Find Pinterest-native content angles, layouts, and visual references.</p>
            </div>
          </div>
        ) : (
          <div className="mb-4">
            <h1 className="text-xl font-black text-gray-900 tracking-tight">
              Pin Ideas <span className="text-gray-400 font-normal">— Home Decor · Demo</span>
            </h1>
            <p className="text-gray-500 text-[12px] mt-0.5">
              Top Home Decor opportunities · tier + monetization + title template per pin · 10 of 48 shown
            </p>
          </div>
        )}

        {/* Scope bar */}
        {!isDemo && initialized && (
          <ScopeBar scope={scope} selectedNiches={selectedNiches} onScopeChange={setScope} onEditNiches={() => setShowModal(true)} />
        )}

        {/* ── Search + Gallery/Analysis toggle + Sort ── */}
        <div className="flex items-center gap-3 mb-4">
          {isDemo ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full px-3 py-1 text-[11px] font-semibold"
                style={{ background: "rgba(192,38,211,0.08)", border: "1px solid rgba(8,145,178,0.2)", color: "#C026D3" }}>
                🏠 Home Decor
              </span>
              <span className="flex items-center gap-1 text-[10px] text-gray-400">
                <Lock className="w-3 h-3" /> 17 more categories locked
              </span>
            </div>
          ) : (
            <div className="relative max-w-[360px] flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search pins..."
                className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-4 py-2 text-[12px] text-gray-800 focus:border-[#C026D3] focus:outline-none placeholder:text-gray-400 shadow-sm" />
            </div>
          )}

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {/* Gallery / Analysis toggle */}
            <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5">
              <button type="button" onClick={() => setViewMode("gallery")}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all"
                style={viewMode === "gallery"
                  ? { background: "#FFFFFF", color: "#C026D3", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }
                  : { color: "#9CA3AF" }}>
                <LayoutGrid className="w-3 h-3" /> Gallery
              </button>
              <button type="button" onClick={() => setViewMode("analysis")}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all"
                style={viewMode === "analysis"
                  ? { background: "#FFFFFF", color: "#C026D3", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }
                  : { color: "#9CA3AF" }}>
                <List className="w-3 h-3" /> Analysis
              </button>
            </div>

            {/* Sort dropdown */}
            <div className="relative">
              <button type="button" onClick={() => setSortOpen(o => !o)}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold bg-white border border-gray-200 text-gray-600 hover:border-gray-300 transition-colors">
                Sort by: <span style={{ color: "#C026D3" }}>{SORT_OPTIONS.find(o => o.value === sort)?.label}</span>
                <ChevronDown className="h-3 w-3 text-gray-400" />
              </button>
              {sortOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 rounded-xl overflow-hidden shadow-lg bg-white border border-gray-200" style={{ minWidth: 180 }}>
                  {SORT_OPTIONS.map(o => (
                    <button key={o.value} type="button"
                      onClick={() => { setSort(o.value); setSortOpen(false); }}
                      className="w-full text-left px-4 py-2.5 text-[12px] font-medium transition-colors hover:bg-gray-50"
                      style={{ color: sort === o.value ? "#C026D3" : "#6b7280" }}>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Filter rows: Category | Signal | Trend ── */}
        {!isDemo && (
          <div className="space-y-2.5 mb-5">
            {/* Category row */}
            <div className="flex items-start gap-4">
              <span className="text-[11px] font-semibold text-gray-500 pt-1 w-16 shrink-0">Category</span>
              <div className="flex flex-wrap gap-1.5">
                {VIRAL_CATS.map(c => (
                  <FilterChip key={c.label} label={c.label} active={vCat === c.label}
                    color="#C026D3" bg="rgba(192,38,211,0.08)"
                    onClick={() => setVCat(c.label)} />
                ))}
              </div>
            </div>

            {/* Demand row */}
            <div className="flex items-center gap-4">
              <span className="text-[11px] font-semibold text-gray-500 w-16 shrink-0">Demand</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(["all", "High", "Medium", "Low"] as const).map(k => (
                  <FilterChip key={k} label={k}
                    active={demandFilter === k}
                    color={k !== "all" ? DEMAND_BAND_STYLE[k].color : undefined}
                    bg={k !== "all" ? DEMAND_BAND_STYLE[k].bg : undefined}
                    onClick={() => setDemandFilter(k)} />
                ))}
              </div>
            </div>

            {/* Competition row */}
            <div className="flex items-center gap-4">
              <span className="text-[11px] font-semibold text-gray-500 w-16 shrink-0">Competition</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(["all", "Low", "Medium", "High"] as const).map(k => (
                  <FilterChip key={k} label={k}
                    active={compFilter === k}
                    color={k !== "all" ? COMP_BAND_STYLE[k].color : undefined}
                    bg={k !== "all" ? COMP_BAND_STYLE[k].bg : undefined}
                    onClick={() => setCompFilter(k)} />
                ))}
              </div>
            </div>

            {/* Trend row */}
            <div className="flex items-center gap-4">
              <span className="text-[11px] font-semibold text-gray-500 w-16 shrink-0">Trend</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(["all", "rising", "evergreen", "seasonal"] as const).map(k => {
                  const m      = k !== "all" ? TREND_CHIP_META[k] : null;
                  const ICON: Record<string, string> = { rising: "↑ ", evergreen: "∞ ", seasonal: "◎ " };
                  const label  = k === "all" ? "All" : `${ICON[k]}${m!.label}`;
                  return (
                    <FilterChip key={k} label={label} active={trendFilter === k}
                      color={m?.color} bg={m ? `${m.color}15` : undefined}
                      onClick={() => setTrendFilter(k)} />
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Content area ── */}

        {/* Demo view */}
        {isDemo && (
          <>
            {isLoading && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-[160px] animate-pulse bg-gray-50 border-b border-gray-100" />
                ))}
              </div>
            )}
            {!isLoading && viralCards.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                {viralCards.map((pin, i) => {
                  const locked = i >= DEMO_GOAL;
                  const lockMessages = [
                    { title: "1 more Blue Ocean hidden",             sub: "Low competition · High save velocity" },
                    { title: "8 shoppable product signals locked",   sub: "Etsy + Amazon affiliate opportunities" },
                    { title: "Unlock 40+ more weekly opportunities", sub: "Build 14-day and 30-day Pin plans" },
                  ];
                  const lm = lockMessages[Math.min(i - DEMO_GOAL, lockMessages.length - 1)];
                  return (
                    <div key={pin.id} className="relative">
                      {locked && (
                        <div className="absolute inset-0 z-20 flex items-center justify-center"
                          style={{ backdropFilter: "blur(5px)", background: "rgba(255,255,255,0.78)" }}
                          onClick={() => setLockedClicks(c => c + 1)}>
                          <div className="text-center px-4">
                            <Lock className="h-4 w-4 text-gray-400 mx-auto mb-1.5" />
                            <p className="text-[12px] font-bold text-gray-800 mb-0.5">{lm.title}</p>
                            <p className="text-[10px] text-gray-400 mb-2.5">{lm.sub}</p>
                            <a href="/signup"
                              className="inline-block rounded-full px-4 py-1.5 text-[11px] font-bold text-white"
                              style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
                              onClick={e => e.stopPropagation()}>
                              Sign up free →
                            </a>
                          </div>
                        </div>
                      )}
                      <DemoAnalysisRow pin={pin} isSelected={selectedIds.includes(pin.id)}
                        onSelect={() => handleDemoSelect(pin)} onViewPins={p => setSelectedPin(p)}
                        rowIndex={i} sessionId={sessionId} />
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Non-demo view */}
        {!isDemo && (
          isLoading && !viralCards.length ? (
            viewMode === "gallery" ? (
              <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-3 space-y-3">
                {Array.from({ length: 18 }).map((_, i) => (
                  <div key={i} className="break-inside-avoid rounded-2xl bg-gray-100 animate-pulse"
                    style={{ height: `${260 + (i % 3) * 80}px` }} />
                ))}
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="h-[60px] animate-pulse bg-gray-50 border-b border-gray-100" />
                ))}
              </div>
            )
          ) : viralCards.length === 0 ? (
            <div className="text-center py-24">
              <Flame className="h-10 w-10 mx-auto mb-3 text-gray-200" />
              {isFiltering ? (
                <>
                  <p className="text-[13px] text-gray-600 font-medium">No viral pins found for your selected niches.</p>
                  <p className="text-[11px] mt-1 mb-3 text-gray-400">Try switching to All Trends or a different category.</p>
                  <button type="button" onClick={() => setScope("all_trends")}
                    className="px-4 py-1.5 rounded-full text-[11px] font-semibold"
                    style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3" }}>
                    Show All Trends
                  </button>
                </>
              ) : hasActiveFilters ? (
                <>
                  <p className="text-[13px] text-gray-600 font-medium">No pins match the current filters.</p>
                  <button type="button" onClick={clearFilters}
                    className="mt-2 px-4 py-1.5 rounded-full text-[11px] font-semibold"
                    style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3" }}>
                    Clear Filters
                  </button>
                </>
              ) : (
                <p className="text-[13px] text-gray-500">No viral pins in this category yet.</p>
              )}
            </div>
          ) : viewMode === "gallery" ? (
            <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-3 space-y-3">
              {viralCards.map((pin, i) => (
                <ViralCard key={pin.id} pin={pin} index={i} onSelect={setSelectedPin} />
              ))}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                <div className="w-9 shrink-0" />
                <div className="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Category</div>
                <div className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Demand</div>
                <div className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Competition</div>
                <div className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Trend</div>
                <div className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Save signal</div>
                <div className="ml-auto" />
              </div>
              {viralCards.map(pin => (
                <AnalysisRow key={pin.id} pin={pin} onSelect={setSelectedPin} />
              ))}
            </div>
          )
        )}
      </main>

      {selectedPin && <PinDrawer pin={selectedPin} onClose={() => setSelectedPin(null)} />}
      {showCapture && (
        <CaptureModal onClose={() => setShowCapture(false)} selectedKeywords={selectedIds}
          lockedClicks={lockedClicks} sessionId={sessionId} />
      )}
      {showModal && (
        <NicheModal initial={selectedNiches}
          onSave={(niches) => { saveNiches(niches); setShowModal(false); }}
          onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}

export default function DiscoverPage() {
  return (
    <Suspense fallback={
      <div className="app-page flex items-center justify-center h-full" style={{ color: "var(--app-text-muted)" }}>
        <span className="text-[13px]">Loading…</span>
      </div>
    }>
      <DiscoverPageInner />
    </Suspense>
  );
}
