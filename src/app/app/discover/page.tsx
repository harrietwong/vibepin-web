"use client";
import Image from "next/image";
import { Suspense, useId, useState, useMemo, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import useSWR from "swr";
import {
  Flame, Sparkles, ChevronDown, X, ExternalLink, ShoppingBag,
  TrendingUp, LayoutGrid, List, Mail, Lock, Search,
  Bookmark, HelpCircle, SlidersHorizontal, ChevronLeft, ChevronRight,
  Clock, Heart, ArrowRight, Eye,
} from "lucide-react";
import { BookmarkButton } from "@/components/ui/BookmarkButton";
import { supabase, type ViralPin } from "@/lib/supabase";
import * as assetStore from "@/lib/assetStore";
import { toast } from "sonner";
import { EvidenceLine } from "@/components/ui/signals";
import { assessPin } from "@/lib/scoring"; // demo rows only — never production cards
import { matchesNiche } from "@/lib/niches";
import { useNicheScope } from "@/lib/useNicheScope";
import { CATEGORIES } from "@/lib/categories";
import {
  PIN_VISIBLE_CATEGORIES,
  NORMALIZED_CATEGORY_EMOJI,
  normalizeCategoryLabel,
  categoryMatchSlugs,
} from "@/lib/mvpTaxonomy";
import { buildPrefillFromViralPin, openCreatePins } from "@/lib/createPinsPrefill";
import dynamic from "next/dynamic";
import { PRIMARY_BADGE_META, type PrimaryBadge } from "@/lib/workspaceStatics";
import type { DestinationType, ItemType, ProductSubtype, RiskFlag } from "@/lib/assetClassification";
import { inferPinFormat, isSellableProductPin } from "@/lib/pinFormats";
import { markDataReady } from "@/lib/navTiming";

const SHOW_PIN_IDEAS_INTERNAL_METRICS =
  process.env.NODE_ENV !== "production" ||
  process.env.NEXT_PUBLIC_PIN_IDEAS_INTERNAL_METRICS === "true";

// Lazily loaded — already gated behind `showModal`, so this keeps the modal's
// code out of the main route chunk without changing when it appears.
const NicheModal = dynamic(() =>
  import("@/components/ui/NicheModal").then(m => m.NicheModal), { ssr: false });

// ── Pin signal helpers (demo rows only) ────────────────────────────────────────

function marketTagToSignalKey(tag: string): PrimaryBadge {
  if (tag === "hidden_supply" || tag === "new_account_friendly") return "best_bet";
  if (tag === "oversaturated") return "competitive";
  return "steady";
}

// ── Content-first signals (v2.0 final: NO market scoring on Pin Ideas) ─────────
// Every visible signal is either a real measured value (saves, velocity, age),
// a real DB field (keyword chain, visual_format), or a simple two-state label.
// Nothing here estimates demand, competition, or market volume.

// Commercial Signal — plain two-state label, never a score.
type CommercialSignal = "product" | "content";
function commercialSignalOf(pin: ViralPin): CommercialSignal {
  return pin.is_ecommerce || isSellableProductPin(pin) ? "product" : "content";
}

// Keyword trend badge — backed by a REAL trend_keywords row; no row → no badge.
type TrendKwRow = { keyword: string; yearly_change: number | null; category: string | null };
type KeywordTrendBadge = { label: string; color: string };
function keywordTrendBadge(row: TrendKwRow | undefined | null): KeywordTrendBadge | null {
  if (!row) return null;
  if (row.category === "holidays-seasonal") return { label: "Seasonal now", color: "#0EA5E9" };
  const yoy = row.yearly_change;
  if (yoy == null) return null;
  if (yoy >= 20)  return { label: "Rising keyword",    color: "#16A34A" };
  if (yoy <= -20) return { label: "Declining keyword", color: "#DC2626" };
  return { label: "Evergreen", color: "#6B7280" };
}

// Backend classifier's visual format, prettified for display. Null → no badge
// (the client-side inferPinFormat heuristic is never displayed).
function displayFormat(pin: ViralPin): string | null {
  const v = pin.visual_format;
  if (!v) return null;
  return v.replace(/[_-]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}

// ── Rule-based pin analysis (Why it works / Optimization / Publishing tip) ─────
// Every bullet is derived from a REAL measured field; dimensions without data
// are simply omitted — no canned per-category copy, no fabricated claims.

const FORMAT_WHY: Record<string, string> = {
  tutorial:      "Step-by-step content earns repeat saves and long shelf life on Pinterest.",
  collage:       "Collage layouts pack multiple ideas into one save — high reference value.",
  moodboard:     "Moodboard-style pins are saved as planning references, extending their lifespan.",
  quote:         "Typographic pins read instantly at feed size and travel across boards.",
  text_overlay:  "A clear text hook tells searchers exactly what they get before they click.",
  product_shot:  "A clean product hero makes the subject unmistakable in a crowded feed.",
  lifestyle:     "In-context scenes help users picture the idea in their own life — a strong save trigger.",
  before_after:  "Transformations create instant curiosity and are highly re-saved.",
  checklist:     "Checklist formats promise actionable value — a classic save-for-later trigger.",
  infographic:   "Dense, skimmable information earns saves as a reference to return to.",
};

function buildPinInsights(pin: ViralPin, trendRow: TrendKwRow | null | undefined, fastSaving: boolean): {
  why: string[]; optimize: string[]; publishingTip: string | null;
} {
  const why: string[] = [];
  const optimize: string[] = [];
  const saves    = pin.save_count ?? 0;
  const age      = pin.days_since_created ?? 0;
  const searchKw = pin.source_keyword ?? pin.seed_keyword ?? null;
  const title    = (pin.title ?? "").trim();
  const ratio    = pin.image_ratio ?? null;
  const overlay  = (pin.text_overlay_level ?? "").toLowerCase();
  const fmtKey   = (pin.visual_format ?? "").toLowerCase();
  const kwBadge  = keywordTrendBadge(trendRow);
  const catLabel = pinCatDisplay(pin.category).label;

  // ── Why it works ──
  if (fastSaving) why.push(`Saving faster than 90% of ${catLabel} pins loaded right now (${fmt(pin.save_velocity)}/day).`);
  else if (saves >= 10_000) why.push(`${fmt(saves)} users saved this pin — proven audience resonance.`);
  if (searchKw && title && title.toLowerCase().includes(searchKw.toLowerCase()))
    why.push(`Title contains the search term “${searchKw}” — matches real search intent.`);
  if (FORMAT_WHY[fmtKey]) why.push(FORMAT_WHY[fmtKey]);
  if (ratio != null && ratio >= 0.6 && ratio <= 0.72)
    why.push("2:3 vertical ratio — Pinterest's preferred format, gets full-height feed display.");
  if (overlay && overlay !== "none" && fmtKey !== "quote")
    why.push("Uses a text overlay, giving searchers an instant reason to save.");
  if (kwBadge?.label === "Rising keyword" && trendRow?.yearly_change != null)
    why.push(`Its trend keyword “${pin.seed_keyword}” is rising on Pinterest (+${Math.round(trendRow.yearly_change)}% year over year).`);
  if (age > 0 && age <= 30 && saves >= 1_000)
    why.push(`Collected ${fmt(saves)} saves within its first month — early momentum.`);

  // ── Optimization suggestions (for publishing a similar pin) ──
  if (searchKw) {
    if (!title) optimize.push(`Write a descriptive title (30–60 chars) that includes “${searchKw}”.`);
    else if (!title.toLowerCase().includes(searchKw.toLowerCase()))
      optimize.push(`Work the search term “${searchKw}” into your title and description.`);
  }
  if (ratio != null && (ratio > 0.8 || ratio < 0.5))
    optimize.push("Use a 2:3 vertical canvas (e.g. 1000×1500) — this pin's ratio loses feed real estate.");
  if ((!overlay || overlay === "none") && fmtKey !== "quote" && fmtKey !== "product_shot")
    optimize.push("Consider a short text overlay — a headline or list hook lifts saves for discovery content.");
  if (commercialSignalOf(pin) === "product")
    optimize.push("This is a product-related pin — attach your product/destination link so demand can convert.");
  if (kwBadge?.label === "Seasonal now")
    optimize.push(`Time your publication to the seasonal window for “${pin.seed_keyword}”.`);

  // ── Publishing tip (one plain sentence; omitted when no signal) ──
  let publishingTip: string | null = null;
  if (kwBadge?.label === "Rising keyword")
    publishingTip = "Good timing — this topic's searches are rising, publishing a similar pin now can ride the trend.";
  else if (kwBadge?.label === "Declining keyword")
    publishingTip = "This topic's searches are declining — consider a fresher angle or a related rising keyword.";
  else if (kwBadge?.label === "Seasonal now")
    publishingTip = "Seasonal topic — publish ahead of the peak window for the best reach.";
  else if (fastSaving)
    publishingTip = "This style is gaining saves quickly right now — a strong moment to publish your version.";

  return { why, optimize, publishingTip };
}

// On-image (dark glass) status colors for card metric icons.
const STATUS = { green: "#22C55E", yellow: "#EAB308", red: "#F87171", neutral: "#E5E7EB" } as const;
function velocityStatusColor(v: number): string {
  return v >= 100 ? STATUS.green : v >= 20 ? STATUS.yellow : STATUS.red;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

type RelatedProduct = {
  id: string; product_name: string; image_url: string | null;
  domain: string | null; price: number | null; source_url: string | null;
};

// ── Viral pin categories (NORMALIZED, shared MVP taxonomy) ──────────────────────
// Pin Images is the UPSTREAM Pinterest signal pool; Product Opportunity is the
// DOWNSTREAM product pool. Both use the same normalized taxonomy IDs, but Pin Images
// exposes its own visible list (source-pin depth) and hides non-commerce categories.
// `slugs` are the raw DB pin_samples.category values that feed each normalized group.
const VIRAL_CATS: { label: string; slugs: string[] }[] = [
  { label: "All", slugs: [] },
  ...PIN_VISIBLE_CATEGORIES.map(c => ({
    label: `${NORMALIZED_CATEGORY_EMOJI[c]} ${c}`,
    slugs: categoryMatchSlugs(c),
  })),
];

// Display a pin's raw category using the normalized label/emoji; falls back to the
// legacy per-slug definition only if a raw category is somehow not mapped.
function pinCatDisplay(rawCat: string): { emoji: string; label: string } {
  const norm = normalizeCategoryLabel(rawCat);
  if (norm) return { emoji: NORMALIZED_CATEGORY_EMOJI[norm], label: norm };
  const def = CATEGORIES.find(c => c.id === rawCat);
  return { emoji: def?.emoji ?? "📌", label: def?.label ?? rawCat };
}

type SortMode = "most_saved" | "fastest_saving" | "newest";
type ViewMode = "gallery" | "analysis";

// ── Fetchers ──────────────────────────────────────────────────────────────────
// Includes the real discovery chain (seed/source keyword), the backend
// classifier's visual_format, and is_ecommerce for the Commercial Signal.
const PIN_SELECT =
  "id,image_url,category,title,description,save_count,reaction_count,pin_id,source_url,outbound_link,pin_created_at,scraped_at,save_velocity,days_since_creation,seed_keyword,source_keyword,visual_format,is_ecommerce,image_ratio,text_overlay_level";

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

async function fetchByCategories(slugs: string[]): Promise<ViralPin[]> {
  // A normalized category (e.g. Fashion) can span several raw slugs
  // (fashion/womens-fashion/mens-fashion), so match the whole group with .in().
  const { data, error } = await supabase
    .from("pin_samples")
    .select(PIN_SELECT)
    .in("category", slugs)
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

// ── Compact labeled <select> for secondary filters ────────────────────────────
function FilterSelect({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex h-9 items-center gap-2 rounded-xl px-3"
      style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border)", boxShadow: "0 1px 2px var(--app-inset)" }}>
      <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: "var(--app-text-sec)" }}>{label}</span>
      <div className="relative">
        <select value={value} onChange={e => onChange(e.target.value)}
          className="h-7 appearance-none rounded-lg border border-transparent bg-transparent pl-1 pr-6 text-[11px] font-bold focus:outline-none cursor-pointer"
          style={{ color: "var(--app-text)" }}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown className="absolute right-1 top-1/2 -translate-y-1/2 h-3 w-3 pointer-events-none" style={{ color: "var(--app-text-muted)" }} />
      </div>
    </label>
  );
}

// ── Pin reference drawer (content evidence only — no market scoring) ──────────
function PinDrawer({ pin, trendRow, fastSaving, similarPins = [], onSelectSimilar, onClose }: {
  pin: ViralPin; trendRow?: TrendKwRow | null; fastSaving?: boolean;
  similarPins?: ViralPin[]; onSelectSimilar?: (p: ViralPin) => void; onClose: () => void;
}) {
  const age   = (pin.days_since_created ?? (pin as Record<string, unknown>).days_since_creation as number) ?? 0;
  const vel   = pin.save_velocity ?? 0;
  const saves = pin.save_count ?? 0;
  const cat   = pin.category;

  const signal   = commercialSignalOf(pin);
  const kwBadge  = keywordTrendBadge(trendRow);
  const format   = displayFormat(pin);
  const searchKw = pin.source_keyword ?? null;
  const trendKw  = pin.seed_keyword ?? null;
  const insights = buildPinInsights(pin, trendRow, fastSaving ?? false);

  const catDisp   = pinCatDisplay(cat);
  const pinUrl    = pin.pin_id ? `https://www.pinterest.com/pin/${pin.pin_id}/` : null;
  function handleCreatePin() {
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromViralPin({
      id: pin.id, image_url: pin.image_url, save_count: pin.save_count,
      source_keyword: pin.source_keyword ?? cat, category: cat,
    }));
  }

  // Suggestion rank (migrate_v36): the search keyword's 1-based position in
  // Pinterest's dropdown for this trend keyword. Pre-v36 schema or no row →
  // null → the row is simply omitted (never fabricated).
  const { data: dropdownRank } = useSWR(
    trendKw && searchKw && searchKw !== trendKw ? ["kw-rank", trendKw, searchKw] : null,
    async () => {
      const { data, error } = await supabase
        .from("keyword_expansions")
        .select("rank")
        .eq("seed_keyword", trendKw!)
        .eq("expanded_keyword", searchKw!)
        .maybeSingle();
      if (error) return null;
      return (data?.rank as number | null) ?? null;
    },
    { revalidateOnFocus: false },
  );

  // Related products: match on the pin's real keyword chain when present,
  // falling back to the category only when no keyword is stored.
  const relatedKw = pin.seed_keyword ?? pin.source_keyword ?? cat;
  const { data: relatedProducts } = useSWR(
    ["pin-drawer-products", relatedKw],
    async () => {
      const { data } = await supabase
        .from("pin_products")
        .select("id,product_name,image_url,domain,price,source_url")
        .ilike("seed_keyword", `%${relatedKw}%`)
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
            <p className="text-[11px] text-gray-500 mt-0.5 capitalize">{catDisp.emoji} {catDisp.label}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>

        <div className="flex-1 px-5 pt-4 pb-8 space-y-4">

          {/* Image + content signals (real fields only) */}
          <div className="flex gap-3">
            <div className="flex flex-col gap-2 shrink-0 max-w-[130px]">
              <span data-testid="drawer-commercial-signal"
                className="text-[10px] font-bold px-2.5 py-1 rounded-md whitespace-nowrap"
                style={signal === "product"
                  ? { background: "rgba(192,38,211,0.10)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.25)" }
                  : { background: "rgba(107,114,128,0.08)", color: "#6B7280", border: "1px solid rgba(107,114,128,0.18)" }}>
                {signal === "product" ? "Product Related" : "Content Only"}
              </span>
              {kwBadge && (
                <span className="text-[10px] font-semibold px-2.5 py-1 rounded-md whitespace-nowrap"
                  style={{ background: `${kwBadge.color}14`, color: kwBadge.color, border: `1px solid ${kwBadge.color}33` }}>
                  {kwBadge.label}
                </span>
              )}
              {fastSaving && (
                <span className="text-[10px] font-semibold px-2.5 py-1 rounded-md whitespace-nowrap"
                  style={{ background: "rgba(22,163,74,0.10)", color: "#16A34A", border: "1px solid rgba(22,163,74,0.25)" }}>
                  ⚡ Fast saving
                </span>
              )}
              {format && (
                <span className="text-[10px] font-semibold px-2.5 py-1 rounded-md whitespace-nowrap"
                  style={{ background: "rgba(37,99,235,0.08)", color: "#2563EB", border: "1px solid rgba(37,99,235,0.20)" }}>
                  {format}
                </span>
              )}
            </div>
            <div className="flex-1 relative rounded-2xl overflow-hidden" style={{ minHeight: 200 }}>
              <Image src={pin.image_url} alt="" fill className="object-cover" sizes="280px" unoptimized />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
              <div className="absolute top-2 left-2">
                <span className="rounded-full bg-white/90 px-2 py-0.5 text-[9px] font-bold text-gray-800 capitalize">{catDisp.label}</span>
              </div>
              <div className="absolute bottom-2 left-2 right-2">
                <EvidenceLine saves={saves} />
              </div>
            </div>
          </div>

          {/* Discovered via — the real keyword chain that surfaced this pin */}
          {(trendKw || searchKw) && (
            <div data-testid="drawer-discovered-via" className="rounded-xl p-3 bg-gray-50 border border-gray-100">
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Discovered via</p>
              <div className="space-y-1.5">
                {trendKw && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-gray-400 shrink-0">Trend keyword</span>
                    <span className="text-[11px] font-semibold text-gray-800 truncate" title={trendKw}>{trendKw}</span>
                  </div>
                )}
                {searchKw && searchKw !== trendKw && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-gray-400 shrink-0">Search keyword</span>
                    <span className="text-[11px] font-semibold text-gray-800 truncate" title={searchKw}>{searchKw}</span>
                  </div>
                )}
                {dropdownRank != null && (
                  <div className="flex items-center justify-between gap-3" data-testid="drawer-suggestion-rank">
                    <span className="text-[10px] text-gray-400 shrink-0">Dropdown rank</span>
                    <span className="text-[11px] font-semibold text-gray-800">#{dropdownRank} in Pinterest search suggestions</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Stats row — measured values only; missing data shows "—" */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Saves/day", value: vel > 0 ? `${fmt(vel)}/d` : "—",                              color: "#C026D3" },
              { label: "Age",       value: age > 0 ? `${age}d` : "—",                                    color: "#6B7280" },
              { label: "Reactions", value: (pin.reaction_count ?? 0) > 0 ? fmt(pin.reaction_count) : "—", color: "#EF4444" },
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

          {/* Why it works — rule-based, real fields only; empty → hidden */}
          {insights.why.length > 0 && (
            <div data-testid="drawer-why-it-works" className="rounded-xl p-3 bg-gray-50 border border-gray-100">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5">Why it works</p>
              <ul className="space-y-1">
                {insights.why.map((line, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px] text-gray-600 leading-snug">
                    <span className="shrink-0 mt-0.5 text-[#16A34A]">✓</span>{line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Optimization suggestions — actionable steps for a similar pin */}
          {insights.optimize.length > 0 && (
            <div data-testid="drawer-optimization" className="rounded-xl p-3 bg-gray-50 border border-gray-100">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5">Optimization Suggestions</p>
              <ul className="space-y-1">
                {insights.optimize.map((line, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px] text-gray-600 leading-snug">
                    <span className="shrink-0 mt-0.5 text-[#C026D3]">→</span>{line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Publishing tip — one plain-language timing hint */}
          {insights.publishingTip && (
            <div data-testid="drawer-publishing-tip" className="rounded-xl px-3 py-2.5"
              style={{ background: "rgba(37,99,235,0.06)", border: "1px solid rgba(37,99,235,0.15)" }}>
              <p className="text-[11px] leading-snug" style={{ color: "#1D4ED8" }}>💡 {insights.publishingTip}</p>
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

          {/* Similar pins — same search keyword within the loaded set */}
          {similarPins.length >= 3 && onSelectSimilar && (
            <div data-testid="drawer-similar-pins">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Similar Pins</p>
              <div className="grid grid-cols-3 gap-2">
                {similarPins.slice(0, 6).map(sp => (
                  <button key={sp.id} type="button" onClick={() => onSelectSimilar(sp)}
                    className="relative rounded-lg overflow-hidden border border-gray-200 bg-gray-100 text-left"
                    style={{ aspectRatio: "2/3" }}>
                    <Image src={sp.image_url} alt={sp.title ?? ""} fill className="object-cover" sizes="110px" unoptimized />
                    <div className="absolute inset-x-0 bottom-0 px-1.5 py-1"
                      style={{ background: "linear-gradient(to top, rgba(0,0,0,0.72), transparent)" }}>
                      <p className="text-[8px] font-bold text-white">{fmt(sp.save_count)} saves</p>
                    </div>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[9px] text-gray-400 leading-snug">
                Pins discovered via the same keyword, from the currently loaded set.
              </p>
            </div>
          )}

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
// Image-first: measured evidence (saves / saves-day / age) + real content
// signals (keyword, DB format, commercial signal). No market scoring.
function ViralCard({ pin, onSelect, selected, onToggleSelect, fastSaving }: {
  pin: ViralPin; onSelect: (p: ViralPin) => void; selected: boolean; onToggleSelect: (p: ViralPin) => void;
  fastSaving: boolean;
}) {
  const age        = pin.days_since_created ?? 0;
  const vel        = pin.save_velocity ?? 0;
  const saves      = pin.save_count ?? 0;
  const reactions  = pin.reaction_count ?? 0;
  const signal     = commercialSignalOf(pin);
  const format     = displayFormat(pin);
  const searchKw   = pin.source_keyword ?? pin.seed_keyword ?? null;
  // Never fabricate a title: fall back to the real search keyword, else a
  // neutral placeholder.
  const title      = (pin.title ?? "").trim() || searchKw || "Untitled pin";
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const refresh = () => setSaved(assetStore.getByRole("style_reference").some(a => a.imageUrl === pin.image_url));
    refresh();
    return assetStore.subscribe(refresh);
  }, [pin.image_url]);

  function toggleSave(e: React.MouseEvent) {
    e.stopPropagation();
    if (saved) {
      const found = assetStore.getByRole("style_reference").find(a => a.imageUrl === pin.image_url);
      if (found) {
        assetStore.removeAsset(found.id);
        toast.success("Removed from Reference Library");
      }
      return;
    }
    assetStore.saveAsset({
      role: "style_reference", assetRole: "pin_reference",
      itemType: (pin.item_type as ItemType | undefined) ?? "pin_idea",
      productType: "unknown",
      productSubtype: (pin.product_subtype as ProductSubtype | undefined) ?? "unknown",
      destinationType: (pin.destination_type as DestinationType | undefined) ?? "unknown",
      sourceContext: "saved_from_pin_ideas",
      riskFlags: (pin.risk_flags as RiskFlag[] | undefined) ?? [],
      source: "viral_pin", imageUrl: pin.image_url,
      title: pin.title ?? pin.category, keyword: pin.source_keyword ?? pin.category,
      category: pin.category, sourceUrl: pin.outbound_link ?? pin.source_url ?? undefined,
      visualFormat: format ?? undefined,
    });
    onToggleSelect(pin);
    toast.success("Saved to Reference Library");
  }

  return (
    <div
      className="group relative rounded-[16px] overflow-hidden cursor-pointer break-inside-avoid transition-all hover:-translate-y-0.5"
      style={{
        background: "var(--app-surface)",
        border: selected ? "1px solid var(--app-brand)" : "1px solid var(--app-border)",
        boxShadow: selected ? "0 0 0 3px var(--app-brand-soft), 0 12px 30px rgba(124,58,237,0.12)" : "0 1px 3px var(--app-inset)",
      }}
      onClick={() => onSelect(pin)}
    >
      <div className="relative overflow-hidden" style={{ aspectRatio: "2/3", background: "var(--app-surface-2)" }}>
        <Image src={pin.image_url} alt={title} fill unoptimized
          className="object-cover transition-transform duration-500 group-hover:scale-[1.02]"
          sizes="(max-width:640px) 46vw, 200px" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28" style={{ background: "linear-gradient(to top, rgba(10,15,25,0.42) 0%, rgba(10,15,25,0.12) 60%, transparent 100%)" }} />

        {/* Visual-format badge — backend classifier's visual_format (real DB
            field), shown publicly. Pins without a classified format show none. */}
        {format && (
          <span className="absolute top-2.5 left-2.5 z-10 rounded-lg px-2 py-1 text-[9px] font-black tracking-wide text-white uppercase select-none"
            style={{ background: "rgba(10,15,25,0.40)", border: "1px solid rgba(255,255,255,0.10)", backdropFilter: "blur(6px)" }}>
            {format}
          </span>
        )}

        {/* Save reference */}
        <button type="button" role="switch" aria-checked={saved}
          aria-label={saved ? "Remove from Reference Library" : "Save to Reference Library"}
          onClick={toggleSave}
          className="absolute top-2.5 right-2.5 z-10 flex items-center justify-center rounded-xl transition-all"
          style={saved || selected
            ? { width: 32, height: 32, background: "linear-gradient(135deg,#A855F7 0%,#7C3AED 100%)", border: "1px solid rgba(255,255,255,0.45)", boxShadow: "0 0 0 3px rgba(139,92,246,0.18)" }
            : { width: 32, height: 32, background: "rgba(255,255,255,0.86)", color: "#64748B", border: "1px solid rgba(255,255,255,0.72)", backdropFilter: "blur(8px)", boxShadow: "0 6px 18px rgba(15,23,42,0.18)" }}>
          <Bookmark className={`h-4 w-4 ${saved || selected ? "text-white fill-current" : ""}`} />
        </button>

        {/* Compact opportunity overlay — translucent (not opacity), keeps the
            image as the visual focus while staying readable over varied photos. */}
        <div className="absolute inset-x-2.5 bottom-2.5 z-10 rounded-xl px-2.5 py-2"
          style={{
            background: "rgba(10,15,25,0.42)",
            border: "1px solid rgba(255,255,255,0.10)",
            backdropFilter: "blur(6px)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.10)",
          }}
          onClick={e => e.stopPropagation()}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span data-testid="card-commercial-signal"
              className="inline-flex items-center rounded-lg px-2 py-1 text-[9px] font-bold"
              style={signal === "product"
                ? { background: "rgba(192,38,211,0.22)", color: "#F0ABFC" }
                : { background: "rgba(255,255,255,0.16)", color: "#E5E7EB" }}>
              {signal === "product" ? "Product Related" : "Content Only"}
            </span>
            {fastSaving && (
              <span data-testid="card-fast-saving"
                className="inline-flex items-center rounded-lg px-2 py-1 text-[9px] font-bold"
                style={{ background: "rgba(34,197,94,0.22)", color: "#86EFAC" }}>
                ⚡ Fast saving
              </span>
            )}
          </div>
          {/* Per-card performance stats — always shown on the image overlay
              (NOT gated by Test Metrics). Compact 2×2: views/grow— age/saves. */}
          <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <Eye className="h-3 w-3 shrink-0 text-white/68" />
              <span className="truncate text-[11px] font-extrabold text-white tabular-nums leading-none">{fmt(saves)}</span>
            </div>
            <div className="flex items-center justify-end gap-1 min-w-0">
              <TrendingUp className="h-3 w-3 shrink-0" style={{ color: velocityStatusColor(vel) }} />
              <span className="truncate text-[11px] font-extrabold text-white tabular-nums leading-none">{vel > 0 ? `${fmt(vel)}/d` : "—"}</span>
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <Clock className="h-3 w-3 shrink-0 text-white/62" />
              <span className="truncate text-[11px] font-extrabold text-white tabular-nums leading-none">{age > 0 ? `${age}d` : "—"}</span>
            </div>
            <div className="flex items-center justify-end gap-1 min-w-0">
              <Heart className="h-3 w-3 shrink-0 text-white/62" />
              {/* Reactions only — never substitute saves for a missing metric. */}
              <span className="truncate text-[11px] font-extrabold text-white tabular-nums leading-none">{reactions > 0 ? fmt(reactions) : "—"}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="px-3 py-2.5">
        <p className="line-clamp-2 min-h-[34px] text-[12px] font-semibold leading-[17px]" style={{ color: "var(--app-text)" }} title={title}>{title}</p>
        {searchKw && (
          <p className="mt-1 truncate text-[10px]" style={{ color: "var(--app-text-muted)" }} title={`Search keyword: ${searchKw}`}>
            🔎 {searchKw}
          </p>
        )}
      </div>
    </div>
  );
}

function PaginationBar({
  page, pageCount, pageSize, onPageChange,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const pages = Array.from(new Set([1, page - 1, page, page + 1, pageCount].filter(p => p >= 1 && p <= pageCount)));
  return (
    <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="mx-auto flex items-center gap-1 rounded-2xl p-1.5"
        style={{ background: "var(--app-surface)", border: "1px solid var(--app-border)", boxShadow: "0 4px 18px var(--app-inset)" }}>
        <button type="button" disabled={page === 1} onClick={() => onPageChange(Math.max(1, page - 1))}
          className="flex h-8 w-8 items-center justify-center rounded-xl disabled:opacity-40"
          style={{ color: "var(--app-text-sec)" }}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        {pages.map((p, i) => (
          <span key={p} className="flex items-center gap-1">
            {i > 0 && p - pages[i - 1] > 1 && <span className="px-2 text-[12px]" style={{ color: "var(--app-text-muted)" }}>...</span>}
            <button type="button" onClick={() => onPageChange(p)}
              className="h-8 min-w-8 rounded-xl px-2 text-[12px] font-bold"
              style={p === page
                ? { background: "var(--app-brand)", color: "#fff" }
                : { background: "transparent", color: "var(--app-text-sec)" }}>
              {p}
            </button>
          </span>
        ))}
        <button type="button" disabled={page === pageCount} onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          className="flex h-8 w-8 items-center justify-center rounded-xl disabled:opacity-40"
          style={{ color: "var(--app-text-sec)" }}>
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center justify-center gap-2 text-[12px]" style={{ color: "var(--app-text-sec)" }}>
        <span>Show</span>
        <span className="rounded-xl px-3 py-2 font-bold" style={{ background: "var(--app-surface)", border: "1px solid var(--app-border)", color: "var(--app-text)" }}>
          {pageSize}
        </span>
        <span>per page</span>
      </div>
    </div>
  );
}

// ── Analysis table row ─────────────────────────────────────────────────────────
// Real fields only: keyword chain, DB format, commercial signal, measured saves.
function AnalysisRow({ pin, onSelect }: { pin: ViralPin; onSelect: (p: ViralPin) => void }) {
  const vel      = pin.save_velocity ?? 0;
  const saves    = pin.save_count ?? 0;
  const signal   = commercialSignalOf(pin);
  const format   = displayFormat(pin);
  const searchKw = pin.source_keyword ?? pin.seed_keyword ?? null;
  const catDisp  = pinCatDisplay(pin.category);
  function handleAnalysisCreatePin(e: React.MouseEvent) {
    e.stopPropagation();
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromViralPin({
      id: pin.id, image_url: pin.image_url, save_count: pin.save_count,
      source_keyword: pin.source_keyword ?? pin.category, category: pin.category,
    }));
  }

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
          {catDisp.emoji} {catDisp.label}
        </span>
      </div>

      {/* Search keyword (real discovery chain) */}
      <div className="w-40 shrink-0 min-w-0">
        <span className="block truncate text-[11px] font-medium text-gray-700" title={searchKw ?? undefined}>
          {searchKw ?? "—"}
        </span>
      </div>

      {/* Format (backend classifier) */}
      <div className="w-28 shrink-0">
        {format ? (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md whitespace-nowrap"
            style={{ background: "rgba(37,99,235,0.08)", color: "#2563EB" }}>
            {format}
          </span>
        ) : <span className="text-[10px] text-gray-300">—</span>}
      </div>

      {/* Commercial signal */}
      <div className="w-28 shrink-0">
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
          style={signal === "product"
            ? { background: "rgba(192,38,211,0.10)", color: "#C026D3" }
            : { background: "rgba(107,114,128,0.08)", color: "#6B7280" }}>
          {signal === "product" ? "Product Related" : "Content Only"}
        </span>
      </div>

      {/* Saves */}
      <div className="w-16 shrink-0">
        <span className="text-[11px] font-semibold text-gray-800 tabular-nums">{fmt(saves)}</span>
      </div>

      {/* Saves/day */}
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
  const { t: tr }    = useLocale();
  const isDemo       = searchParams.get("demo") === "true";
  // Cross-page keyword protocol: /app/discover?keyword=<trend>&search_keyword=<suggestion>
  // (linked from Keyword Trends). Applied once as initial filters + a breadcrumb.
  const linkedTrendKw  = !isDemo ? (searchParams.get("keyword") ?? "").trim() : "";
  const linkedSearchKw = !isDemo ? (searchParams.get("search_keyword") ?? "").trim() : "";

  const [vCat,         setVCat]         = useState(isDemo ? "🏠 Home Decor" : "All");
  const [format,       setFormat]       = useState<string>("All");          // DB visual_format values
  const [signalFilter, setSignalFilter] = useState<"all" | CommercialSignal>("all");
  const [freshness,    setFreshness]    = useState<"all" | "7" | "30" | "90">("all");
  const [trendKwFilter,  setTrendKwFilter]  = useState<string>(linkedTrendKw || "All");
  const [searchKwFilter, setSearchKwFilter] = useState<string>(linkedSearchKw || "All");
  const [search,       setSearch]       = useState("");
  const [sort,         setSort]         = useState<SortMode>("most_saved");
  const [viewMode,     setViewMode]     = useState<ViewMode>(isDemo ? "analysis" : "gallery");
  const [showModal,    setShowModal]    = useState(false);
  const [nicheOpen,    setNicheOpen]    = useState(false);
  const [savedOnly,    setSavedOnly]    = useState(false);
  const [showHelp,     setShowHelp]     = useState(false);
  const [showTestMetrics, setShowTestMetrics] = useState(false);
  const [page,         setPage]         = useState(1);
  const pageSize = 24;

  // Saved references live in the Reference Library (assetStore, role "style_reference").
  const [savedRefUrls, setSavedRefUrls] = useState<Set<string>>(new Set());
  useEffect(() => {
    const refresh = () => setSavedRefUrls(new Set(assetStore.getByRole("style_reference").map(a => a.imageUrl)));
    refresh();
    return assetStore.subscribe(refresh);
  }, []);

  // Temporary multi-selection of references for the current Create Pins task.
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set());
  function toggleRef(pin: ViralPin) {
    setSelectedRefs(prev => { const n = new Set(prev); if (n.has(pin.id)) n.delete(pin.id); else n.add(pin.id); return n; });
  }
  function clearRefs() { setSelectedRefs(new Set()); }

  // Demo state
  const [selectedIds,  setSelectedIds]  = useState<string[]>([]);
  const [lockedClicks, setLockedClicks] = useState(0);
  const [showCapture,  setShowCapture]  = useState(false);
  const sessionId = useId().replace(/[^a-z0-9]/gi, "");

  function handleDemoSelect(pin: ViralPin) {
    setSelectedIds(prev => prev.includes(pin.id) ? prev : [...prev, pin.id]);
  }

  const { selectedNiches, isFiltering, setScope, saveNiches } = useNicheScope();

  const catSlugs = isDemo ? ["home-decor"] : (VIRAL_CATS.find(c => c.label === vCat)?.slugs ?? []);

  const { data: rawRising, isLoading } = useSWR(
    catSlugs.length ? `discover-cat-${catSlugs.join(",")}` : "discover-rising",
    catSlugs.length ? () => fetchByCategories(catSlugs) : fetchRising,
    { revalidateOnFocus: false, keepPreviousData: true },
  );

  useEffect(() => {
    if (!isLoading) markDataReady("/app/discover");
  }, [isLoading]);

  // ── Keyword trend context (REAL trend_keywords rows for the loaded pins) ─────
  const seedKeywords = useMemo(
    () => [...new Set((rawRising ?? []).map(p => p.seed_keyword).filter((k): k is string => !!k))].slice(0, 200),
    [rawRising],
  );
  const { data: trendRows } = useSWR(
    seedKeywords.length ? `discover-trendkw-${seedKeywords.join("|").slice(0, 800)}` : null,
    async () => {
      const { data } = await supabase
        .from("trend_keywords")
        .select("keyword,yearly_change,category")
        .in("keyword", seedKeywords);
      return (data ?? []) as TrendKwRow[];
    },
    { revalidateOnFocus: false },
  );
  const trendMap = useMemo(
    () => new Map((trendRows ?? []).map(r => [r.keyword, r])),
    [trendRows],
  );

  // ── Fast-saving threshold: top-10% saves/day within the same normalized
  // category of the LOADED set. Needs ≥10 measured velocities, else no tag
  // (never a forced judgment on thin data).
  const fastP90 = useMemo(() => {
    const byCat = new Map<string, number[]>();
    for (const p of rawRising ?? []) {
      const v = p.save_velocity ?? 0;
      if (v <= 0) continue;
      const key = normalizeCategoryLabel(p.category) ?? p.category;
      const arr = byCat.get(key) ?? [];
      arr.push(v);
      byCat.set(key, arr);
    }
    const out = new Map<string, number>();
    for (const [key, arr] of byCat) {
      if (arr.length < 10) continue;
      arr.sort((a, b) => a - b);
      out.set(key, arr[Math.floor((arr.length - 1) * 0.9)]);
    }
    return out;
  }, [rawRising]);
  const isFastSaving = useMemo(() => (p: ViralPin): boolean => {
    const v = p.save_velocity ?? 0;
    if (v <= 0) return false;
    const p90 = fastP90.get(normalizeCategoryLabel(p.category) ?? p.category);
    return p90 != null && v >= p90;
  }, [fastP90]);

  // Similar pins for the drawer — same search keyword first, then same trend
  // keyword, ranked by saves. Computed from the LOADED set (no extra queries).
  const [selectedPin,  setSelectedPin]  = useState<ViralPin | null>(null);
  const similarPins = useMemo(() => {
    if (!selectedPin) return [] as ViralPin[];
    const pool = (rawRising ?? []).filter(p => p.id !== selectedPin.id && !!p.image_url);
    const sameSearch = selectedPin.source_keyword
      ? pool.filter(p => p.source_keyword === selectedPin.source_keyword)
      : [];
    const searchIds = new Set(sameSearch.map(p => p.id));
    const sameSeed = selectedPin.seed_keyword
      ? pool.filter(p => p.seed_keyword === selectedPin.seed_keyword && !searchIds.has(p.id))
      : [];
    return [...sameSearch, ...sameSeed]
      .sort((a, b) => (b.save_count ?? 0) - (a.save_count ?? 0))
      .slice(0, 6);
  }, [selectedPin, rawRising]);

  const selectedRefPins = useMemo(() => (rawRising ?? []).filter(p => selectedRefs.has(p.id)), [rawRising, selectedRefs]);
  function addRefsToCreatePins() {
    const refs = selectedRefPins.filter(p => p.image_url);
    if (!refs.length) return;
    openCreatePins(url => { window.location.href = url; }, {
      source: "viral_pins",
      pinReferences: refs.map(p => ({
        id: p.id, imageUrl: p.image_url, source: "viral_pins" as const,
        category: p.category, keyword: p.source_keyword ?? p.category, saveCount: p.save_count,
        visualFormat: inferPinFormat(p),
      })),
    });
  }

  const viralCards = useMemo(() => {
    let list = rawRising ?? [];

    if (!isDemo) {
      // Hide non-commerce / hidden-taxonomy categories from the default MVP grid.
      // (fetchRising pulls top-saved pins across ALL raw categories, incl. hidden
      // ones like quotes/entertainment/animals; category-scoped fetches already
      // return only visible slugs, so this is a no-op there.)
      // NOTE: sellable product pins are NO LONGER filtered out — they surface
      // with the "Product Related" Commercial Signal instead (v2.0 final).
      list = list.filter(p => normalizeCategoryLabel(p.category) !== null);
    }
    if (isFiltering && !isDemo) {
      list = list.filter(p => matchesNiche([p.category, p.title], selectedNiches));
    }
    if (!isDemo && savedOnly) {
      list = list.filter(p => savedRefUrls.has(p.image_url));
    }
    if (!isDemo && format !== "All") {
      list = list.filter(p => displayFormat(p) === format);
    }
    if (!isDemo && signalFilter !== "all") {
      list = list.filter(p => commercialSignalOf(p) === signalFilter);
    }
    if (!isDemo && freshness !== "all") {
      const maxDays = Number(freshness);
      list = list.filter(p => (p.days_since_created ?? Number.POSITIVE_INFINITY) <= maxDays);
    }
    if (!isDemo && trendKwFilter !== "All") {
      list = list.filter(p => p.seed_keyword === trendKwFilter);
    }
    if (!isDemo && searchKwFilter !== "All") {
      list = list.filter(p => p.source_keyword === searchKwFilter);
    }
    if (!isDemo && search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        (p.title ?? "").toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.seed_keyword ?? "").toLowerCase().includes(q) ||
        (p.source_keyword ?? "").toLowerCase().includes(q),
      );
    }

    // Measured-evidence sorts only — no derived opportunity ranking.
    const sorted = [...list].sort((a, b) => {
      if (sort === "fastest_saving") return (b.save_velocity ?? 0) - (a.save_velocity ?? 0);
      if (sort === "newest")         return (a.days_since_created ?? 9999) - (b.days_since_created ?? 9999);
      return (b.save_count ?? 0) - (a.save_count ?? 0);   // most_saved (default)
    });

    return isDemo ? sorted.slice(0, 10) : sorted;
  }, [rawRising, sort, isFiltering, selectedNiches, isDemo, search, format, savedOnly, savedRefUrls, signalFilter, freshness, trendKwFilter, searchKwFilter]);

  // ── Aggregate stats for the internal Test Metrics strip — counts only ────────
  const stats = useMemo(() => ({
    found: viralCards.length,
    fastSaving: viralCards.filter(isFastSaving).length,
    productRelated: viralCards.filter(p => commercialSignalOf(p) === "product").length,
    withKeyword: viralCards.filter(p => !!(p.source_keyword ?? p.seed_keyword)).length,
  }), [viralCards, isFastSaving]);

  // Filter options derived from the loaded set (real values only).
  const formatOptions = useMemo(
    () => [...new Set((rawRising ?? []).map(displayFormat).filter((f): f is string => !!f))].sort(),
    [rawRising],
  );
  const trendKwOptions = useMemo(() => {
    const set = new Set((rawRising ?? []).map(p => p.seed_keyword).filter((k): k is string => !!k));
    if (trendKwFilter !== "All") set.add(trendKwFilter);   // keep a linked keyword selectable
    return [...set].sort();
  }, [rawRising, trendKwFilter]);
  const searchKwOptions = useMemo(() => {
    const set = new Set((rawRising ?? []).map(p => p.source_keyword).filter((k): k is string => !!k));
    if (searchKwFilter !== "All") set.add(searchKwFilter);
    return [...set].sort();
  }, [rawRising, searchKwFilter]);

  const SORT_OPTIONS: { value: SortMode; label: string }[] = [
    { value: "most_saved",     label: "Most saved" },
    { value: "fastest_saving", label: "Fastest saving" },
    { value: "newest",         label: "Newest found" },
  ];

  const hasActiveFilters =
    format !== "All" || signalFilter !== "all" || freshness !== "all" ||
    trendKwFilter !== "All" || searchKwFilter !== "All" ||
    search.trim() !== "" || savedOnly || (vCat !== "All" && !isDemo);

  function clearFilters() {
    setFormat("All"); setSignalFilter("all"); setFreshness("all");
    setTrendKwFilter("All"); setSearchKwFilter("All");
    setSearch(""); setVCat("All"); setSavedOnly(false); setScope("all_trends");
  }

  const NICHE_OPTIONS = VIRAL_CATS;                      // "All" + every category
  const plainLabel = (s: string) => s.replace(/^\P{L}+/u, "").trim() || s;  // strip leading emoji
  const currentNicheLabel = vCat === "All" ? "All Niches" : plainLabel(vCat);
  const pageCount = Math.max(1, Math.ceil(viralCards.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageCards = viralCards.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="app-page h-full overflow-y-auto">
      {isDemo && <DemoBanner />}
      {isDemo && (
        <DemoProgressBar selected={selectedIds.length} onBuild={() => setShowCapture(true)} />
      )}

      <main className="max-w-[1380px] mx-auto px-4 sm:px-5 lg:px-6 py-4">

        {/* ── Header row ── */}
        {!isDemo ? (
          <div className="mb-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h1 className="text-[19px] font-semibold tracking-tight leading-tight flex items-center gap-2" style={{ color: "var(--app-text)" }}>
                  {tr("page.ideas.title")}
                  <Bookmark className="h-4 w-4" style={{ color: "var(--app-text-muted)" }} />
                </h1>
                <p className="text-[12px] mt-0.5" style={{ color: "var(--app-text-sec)" }}>{tr("page.ideas.subtitle")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button type="button" onClick={() => setSavedOnly(s => !s)}
                  className="flex h-10 items-center gap-2 rounded-xl px-3.5 text-[12px] font-semibold transition-colors"
                  style={savedOnly
                    ? { background: "var(--app-brand-soft)", color: "var(--app-brand)", border: "1px solid rgba(139,92,246,0.28)" }
                    : { background: "var(--app-surface)", color: "var(--app-text)", border: "1px solid var(--app-border)" }}>
                  <Bookmark className="h-4 w-4" /> Saved ({savedRefUrls.size})
                </button>
                <button type="button" onClick={() => setShowHelp(h => !h)}
                  className="flex h-10 items-center gap-2 rounded-xl px-3.5 text-[12px] font-semibold transition-colors"
                  style={{ background: "var(--app-surface)", color: "var(--app-text)", border: "1px solid var(--app-border)" }}>
                  <HelpCircle className="h-4 w-4" /> How it works
                </button>
                <button type="button" onClick={() => document.getElementById("pin-idea-filters")?.scrollIntoView({ block: "nearest" })}
                  className="relative flex h-10 items-center gap-2 rounded-xl px-3.5 text-[12px] font-semibold transition-colors"
                  style={{ background: "var(--app-surface)", color: "var(--app-text)", border: "1px solid var(--app-border)" }}>
                  <SlidersHorizontal className="h-4 w-4" /> Filters
                  {hasActiveFilters && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full" style={{ background: "var(--app-brand)" }} />}
                </button>
                {SHOW_PIN_IDEAS_INTERNAL_METRICS && (
                  <button type="button" onClick={() => setShowTestMetrics(v => !v)}
                    className="flex h-10 items-center gap-2 rounded-xl px-3.5 text-[12px] font-semibold transition-colors"
                    style={showTestMetrics
                      ? { background: "var(--app-brand-soft)", color: "var(--app-brand)", border: "1px solid rgba(139,92,246,0.26)" }
                      : { background: "var(--app-surface)", color: "var(--app-text-sec)", border: "1px solid var(--app-border)" }}>
                    Test Metrics
                  </button>
                )}
              </div>
            </div>
            {showHelp && (
              <div className="mt-3 rounded-xl px-4 py-3 text-[12px] leading-relaxed"
                style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border)", color: "var(--app-text-sec)" }}>
                <span className="font-semibold" style={{ color: "var(--app-text)" }}>Pin Ideas</span> are visual references and content angles — layouts, formats, and creative inspiration.
                Filter by <span className="font-semibold">Format</span> to find a style, then <span className="font-semibold" style={{ color: "var(--app-brand)" }}>Use as Reference</span> to send it into Create Pins.
                Looking for products to promote? Head to <a href="/app/products" className="font-semibold" style={{ color: "var(--app-brand)" }}>Product Ideas</a>.
              </div>
            )}
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

        {/* ── Search + Gallery/Analysis toggle + Edit niches ── */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center mb-3">
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
            <>
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none" style={{ color: "var(--app-text-muted)" }} />
                <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search pin ideas, topics, styles, or keywords..."
                  className="h-11 w-full rounded-2xl pl-11 pr-4 text-[13px] focus:outline-none"
                  style={{
                    background: "var(--app-surface)",
                    border: "1px solid var(--app-border)",
                    color: "var(--app-text)",
                    boxShadow: "0 2px 8px var(--app-inset)",
                  }} />
              </div>

              <button type="button" onClick={() => setShowModal(true)}
                className="sm:ml-auto flex h-10 items-center justify-center gap-2 rounded-xl px-3.5 text-[12px] font-semibold transition-colors shrink-0"
                style={{ background: "var(--app-surface)", border: "1px solid var(--app-border)", color: "var(--app-text-sec)" }}>
                <SlidersHorizontal className="h-4 w-4" /> Manage niches
              </button>
            </>
          )}
        </div>

        {/* ── Cross-page keyword breadcrumb ── */}
        {!isDemo && (linkedTrendKw || linkedSearchKw) && (trendKwFilter === linkedTrendKw || searchKwFilter === linkedSearchKw) && (
          <div data-testid="keyword-breadcrumb" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl px-4 py-2.5"
            style={{ background: "rgba(37,99,235,0.06)", border: "1px solid rgba(37,99,235,0.15)" }}>
            <span className="text-[12px]" style={{ color: "var(--app-text-sec)" }}>
              From <a href="/app/trends" className="font-semibold" style={{ color: "#2563EB" }}>Keyword Trends</a>:
              {" "}<strong style={{ color: "var(--app-text)" }}>{linkedSearchKw || linkedTrendKw}</strong>
              {" "}— showing pins discovered via this keyword.
            </span>
            <button type="button" onClick={clearFilters}
              className="ml-auto rounded-full px-3 py-1 text-[11px] font-semibold"
              style={{ background: "rgba(37,99,235,0.10)", color: "#2563EB" }}>
              Clear
            </button>
          </div>
        )}

        {/* ── Compact insight + filter strip ── */}
        {!isDemo && (
          <div id="pin-idea-filters" className="mb-4 rounded-2xl p-2.5"
            style={{ background: "var(--app-surface)", border: "1px solid var(--app-border)", boxShadow: "0 4px 18px var(--app-inset)" }}>
            <div className="flex flex-wrap items-center gap-2">
              {SHOW_PIN_IDEAS_INTERNAL_METRICS && showTestMetrics && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 w-full xl:w-auto xl:min-w-[520px]">
                  {[
                    { value: stats.found.toLocaleString(),          label: "Ideas found",     color: "var(--app-brand)" },
                    { value: stats.fastSaving.toLocaleString(),     label: "Fast saving",     color: "#16A34A" },
                    { value: stats.productRelated.toLocaleString(), label: "Product related", color: "#C026D3" },
                    { value: stats.withKeyword.toLocaleString(),    label: "With keyword",    color: "#2563EB" },
                  ].map(s => (
                    <div key={s.label} className="h-[50px] rounded-xl px-3 py-2"
                      style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border)" }}>
                      <p className="text-[9px] font-semibold leading-none" style={{ color: "var(--app-text-sec)" }}>{s.label}</p>
                      <p className="mt-1.5 text-[15px] font-bold leading-none" style={{ color: s.color }}>{s.value}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex h-9 items-center gap-1 rounded-xl p-1 shrink-0" style={{ background: "var(--app-surface-2)" }}>
                <button type="button" onClick={() => setViewMode("gallery")}
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition-all"
                  style={viewMode === "gallery"
                    ? { background: "var(--app-surface)", color: "var(--app-brand)", boxShadow: "0 1px 3px var(--app-inset-hi)" }
                    : { color: "var(--app-text-sec)" }}>
                  <LayoutGrid className="w-3.5 h-3.5" /> Gallery
                </button>
                <button type="button" onClick={() => setViewMode("analysis")}
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition-all"
                  style={viewMode === "analysis"
                    ? { background: "var(--app-surface)", color: "var(--app-brand)", boxShadow: "0 1px 3px var(--app-inset-hi)" }
                    : { color: "var(--app-text-sec)" }}>
                  <List className="w-3.5 h-3.5" /> Analysis
                </button>
              </div>

              <FilterSelect label="Format" value={format} onChange={setFormat}
                options={[{ value: "All", label: "All" }, ...formatOptions.map(f => ({ value: f, label: f }))]} />

              <div className="relative">
                <button type="button" onClick={() => setNicheOpen(o => !o)}
                  className="flex h-9 items-center gap-2 rounded-xl px-3 text-[11px] font-semibold"
                  style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border)", color: "var(--app-text-sec)", boxShadow: "0 1px 2px var(--app-inset)" }}>
                  <span>Niche</span>
                  <strong style={{ color: "var(--app-text)" }}>{currentNicheLabel}</strong>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </button>
                {nicheOpen && (
                  <>
                    <button type="button" aria-label="Close" className="fixed inset-0 z-40 cursor-default" onClick={() => setNicheOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-50 rounded-xl overflow-hidden shadow-lg max-h-[300px] overflow-y-auto"
                      style={{ minWidth: 200, background: "var(--app-dropdown-bg)", border: "1px solid var(--app-dropdown-border)" }}>
                      {NICHE_OPTIONS.map(c => (
                        <button key={c.label} type="button"
                          onClick={() => { setVCat(c.label); setNicheOpen(false); }}
                          className="w-full text-left px-4 py-2 text-[12px] font-medium transition-colors"
                          style={{ color: vCat === c.label ? "var(--app-brand)" : "var(--app-dropdown-text)" }}>
                          {c.label === "All" ? "All Niches" : c.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              <FilterSelect label="Signal" value={signalFilter} onChange={v => setSignalFilter(v as "all" | CommercialSignal)}
                options={[{ value: "all", label: "All" }, { value: "product", label: "Product Related" }, { value: "content", label: "Content Only" }]} />
              <FilterSelect label="Freshness" value={freshness} onChange={v => setFreshness(v as "all" | "7" | "30" | "90")}
                options={[{ value: "all", label: "All" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }]} />
              {trendKwOptions.length > 0 && (
                <FilterSelect label="Trend keyword" value={trendKwFilter} onChange={setTrendKwFilter}
                  options={[{ value: "All", label: "All" }, ...trendKwOptions.map(k => ({ value: k, label: k }))]} />
              )}
              {searchKwOptions.length > 0 && (
                <FilterSelect label="Search keyword" value={searchKwFilter} onChange={setSearchKwFilter}
                  options={[{ value: "All", label: "All" }, ...searchKwOptions.map(k => ({ value: k, label: k }))]} />
              )}
              <div className="xl:ml-auto">
                <FilterSelect label="Sort by" value={sort} onChange={v => setSort(v as SortMode)} options={SORT_OPTIONS} />
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
            <>
              <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-3 space-y-3">
                {pageCards.map(pin => (
                  <ViralCard key={pin.id} pin={pin} onSelect={setSelectedPin}
                    selected={selectedRefs.has(pin.id)} onToggleSelect={toggleRef}
                    fastSaving={isFastSaving(pin)} />
                ))}
              </div>
              <PaginationBar page={safePage} pageCount={pageCount} pageSize={pageSize} onPageChange={setPage} />
            </>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                <div className="w-9 shrink-0" />
                <div className="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Category</div>
                <div className="w-40 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Search keyword</div>
                <div className="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Format</div>
                <div className="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Signal</div>
                <div className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Saves</div>
                <div className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Saves/day</div>
                <div className="ml-auto" />
              </div>
              {pageCards.map(pin => (
                <AnalysisRow key={pin.id} pin={pin} onSelect={setSelectedPin} />
              ))}
              <PaginationBar page={safePage} pageCount={pageCount} pageSize={pageSize} onPageChange={setPage} />
            </div>
          )
        )}
      </main>

      {/* Page-level selected-references action bar (temporary Create Pins selection) */}
      {!isDemo && selectedRefs.size > 0 && (
        <div data-testid="selected-reference-bar"
          className="fixed bottom-6 left-1/2 z-50 flex items-center gap-3 rounded-2xl px-4 py-3 bg-white border border-gray-200 max-w-[92vw]"
          style={{ transform: "translateX(-50%)", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
          <div className="flex items-center shrink-0">
            {selectedRefPins.slice(0, 3).map((p, i) => (
              <div key={p.id} className="relative rounded-lg overflow-hidden bg-gray-100 border-2 border-white"
                style={{ width: 32, height: 32, marginLeft: i === 0 ? 0 : -8, zIndex: 3 - i }}>
                <Image src={p.image_url} alt="" fill className="object-cover" sizes="32px" unoptimized />
              </div>
            ))}
            {selectedRefPins.length > 3 && (
              <span className="ml-1 text-[11px] font-bold text-gray-400">+{selectedRefPins.length - 3}</span>
            )}
          </div>
          <span className="text-[13px] font-bold text-gray-900 shrink-0">
            {selectedRefs.size} reference{selectedRefs.size !== 1 ? "s" : ""} selected
          </span>
          <button type="button" onClick={clearRefs}
            className="rounded-full px-3 py-2 text-[11px] font-semibold text-gray-400 hover:text-gray-600 shrink-0">
            Clear
          </button>
          <button type="button" data-testid="add-references-to-create-pins" onClick={addRefsToCreatePins}
            className="flex items-center gap-1.5 rounded-full px-5 py-2 text-[12px] font-bold text-white transition-opacity hover:opacity-90 shrink-0"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
            Add to Create Pins <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {selectedPin && (
        <PinDrawer pin={selectedPin}
          trendRow={selectedPin.seed_keyword ? trendMap.get(selectedPin.seed_keyword) ?? null : null}
          fastSaving={isFastSaving(selectedPin)}
          similarPins={similarPins}
          onSelectSimilar={setSelectedPin}
          onClose={() => setSelectedPin(null)} />
      )}
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
