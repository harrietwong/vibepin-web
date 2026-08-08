"use client";
import Image from "next/image";
import { useState, useMemo, useEffect, useCallback } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import {
  Tag, ExternalLink, Search, ChevronDown, Package, X,
  RefreshCw, SlidersHorizontal, Bookmark, Activity, Box, Monitor, ArrowRight,
  Check, Sparkles, CalendarDays,
} from "lucide-react";
import { matchesNiche, NICHES } from "@/lib/niches";
import { useNicheScope } from "@/lib/useNicheScope";
import dynamic from "next/dynamic";
import {
  PRODUCT_VISIBLE_CATEGORIES,
  normalizeCategoryLabel,
  normalizePlatformLabel,
  computeVisiblePlatforms,
  type NormalizedCategory,
} from "@/lib/mvpTaxonomy";
import * as assetStore from "@/lib/assetStore";
import { toast } from "sonner";
import { buildPrefillFromProductSignal, openCreatePins } from "@/lib/createPinsPrefill";
import { type ProductIdea } from "@/lib/productIdeas";
import { OUTBOUND_DISCOVERY_METHODS, type ProductSourceTypeCode } from "@/lib/productTopTiers";
import { useProductIdeas, useProductIdeasCategoryMap } from "@/lib/useProductIdeas";
import { cleanProductTitle } from "@/lib/productTitle";
import type { PickerSelection } from "@/components/products/ProductOpportunityPicker";
import { looksLikeAmazon } from "@/lib/affiliate/amazon";
import {
  buildDemandThresholds,
  buildResultsSummary,
  competitionExplanation,
  demandExplanation,
  deriveProductOpportunityPublicMetrics,
  isDigitalProductType,
  reducedResultsMessage,
  summarizeActiveFilters,
  trendExplanation,
  type ProductOpportunityPublicMetrics,
} from "@/lib/productOpportunityCounts";
import { markDataReady } from "@/lib/navTiming";

// Lazily loaded — both already gated behind their own boolean, so this keeps
// their code out of the main route chunk without changing when they appear.
const NicheModal = dynamic(() =>
  import("@/components/ui/NicheModal").then(m => m.NicheModal), { ssr: false });
const ProductOpportunityPicker = dynamic(() =>
  import("@/components/products/ProductOpportunityPicker").then(m => m.ProductOpportunityPicker), { ssr: false });

// Types
type PinProduct  = ProductIdea;
type SortKey     = "relevance" | "most_saved" | "newest" | "price" | "rising" | "low_competition";
type ProductClass = "physical" | "digital";
type SubType     = "all" | "printables" | "templates" | "affiliate" | "url_imported";
type PriceBand   = "all" | "under25" | "25to100" | "over100";

const EMPTY_PRODUCTS: PinProduct[] = [];
const PER_PAGE_OPTIONS = [30, 60, 120];
const FILTER_SELECT_CLASS = "w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px] font-semibold text-gray-700 outline-none cursor-pointer focus:border-[#C026D3]";

// Helpers
function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
function fmtPrice(price: number | null, currency: string | null): string {
  if (!price) return "";
  const sym = currency === "EUR" ? "EUR " : currency === "GBP" ? "GBP " : "$";
  return `${sym}${price.toFixed(0)}`;
}
function merchantLabel(domain: string | null, tr: (key: MessageKey) => string): string {
  if (!domain) return tr("products.merchantFallback");
  const clean = domain.replace(/^www\./, "").split(".")[0];
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}
function interpolate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), template);
}
// Product type taxonomy
// Classification lives in one place (productOpportunityCounts) so the summary-card
// class totals and the grid's class filter can never drift apart.
function isDigitalProduct(p: PinProduct): boolean {
  // Title-driven, conservative classification (see productOpportunityCounts). The
  // upstream-derived product_type/subtype are noisy, so the title is the signal;
  // isAmazon is passed for context but Amazon still needs explicit digital evidence.
  return isDigitalProductType({
    name: p.product_name,
    productType: p.product_type,
    productSubtype: p.product_subtype,
    isAmazon: isAmazonProduct(p),
  });
}
const MARKETPLACE_DOMAINS = ["amazon", "etsy", "ebay", "walmart", "target", "aliexpress", "shareasale"];

// Pinterest source-type filter (user-language; provenance mapped, never raw fields)
// + Amazon as an external-marketplace quick toggle. Other external platforms are
// covered by the dedicated Platform filter.
type SourceFilter = "all" | "product_pin" | "stl" | "product_link" | "amazon";
const SOURCE_FILTER_KEYS: Record<SourceFilter, MessageKey> = {
  all: "products.source.all", product_pin: "products.source.productPin", stl: "products.source.stl",
  product_link: "products.source.productLink", amazon: "products.source.amazon",
};

// Amazon detection from existing pin_products fields (domain / source_url / merchant).
function isAmazonProduct(p: PinProduct): boolean {
  return looksLikeAmazon({ productUrl: p.source_url, sourceUrl: p.source_url, domain: p.domain, merchant: p.merchant });
}

function matchesSourceFilter(p: PinProduct, f: SourceFilter): boolean {
  if (f === "all") return true;
  if (f === "amazon") return isAmazonProduct(p);
  const code = sourceTypeCode(p);
  if (f === "product_pin") return code === "product_pin";
  if (f === "stl") return code === "shop_the_look";
  return code === "product_link_pin";
}

// ── Source type + validation evidence (stable codes; mapped to user-language
// labels via sourceTypeLabelKey + tr(), never raw upstream fields) ──
type SourceTypeCode = ProductSourceTypeCode;
function sourceTypeCode(p: PinProduct): SourceTypeCode {
  // The API derives this server-side from provenance (raw discovery_method is never
  // sent to the client). Trust it when present; otherwise fall back to the local
  // heuristic below (Supabase fallback path / older cached rows).
  if (p.source_type) return p.source_type;
  if (p.discovery_method === "stl" || p.section_type === "shop_the_look" || p.section_type === "shop_similar")
    return "shop_the_look";
  if (p.discovery_method && OUTBOUND_DISCOVERY_METHODS.includes(p.discovery_method as (typeof OUTBOUND_DISCOVERY_METHODS)[number]))
    return "product_link_pin";
  if (p.product_pin_id || p.target_product_pin_id) return "product_pin";
  return "pinterest_pin";
}
const SOURCE_TYPE_LABEL_KEYS: Record<SourceTypeCode, MessageKey> = {
  shop_the_look: "products.sourceType.shopTheLook",
  product_pin: "products.sourceType.productPin",
  product_link_pin: "products.sourceType.productLinkPin",
  pinterest_pin: "products.sourceType.pinterestPin",
};

function validatingSourceCount(p: PinProduct): number {
  return p.product_metrics?.productSourcePinCount ?? (p.parent_pin_id && p.parent_pin_id !== "0" ? 1 : 0);
}

// ── Demand / Trend / Competition chips (translucent glass, on-image safe) ──────
// Favorable → green, moderate → yellow, unfavorable → red, no data → gray.
const CHIP_GREEN  = { color: "#4ADE80" };
const CHIP_YELLOW = { color: "#FDE047" };
const CHIP_RED    = { color: "#F87171" };
const CHIP_GRAY   = { color: "#D1D5DB" };

function demandChip(m: ProductOpportunityPublicMetrics["demand"], tr: (key: MessageKey) => string) {
  if (m.label === "high")   return { text: tr("products.chip.demandHigh"),   ...CHIP_GREEN };
  if (m.label === "medium") return { text: tr("products.chip.demandMedium"), ...CHIP_YELLOW };
  if (m.label === "low")    return { text: tr("products.chip.demandLow"),    ...CHIP_RED };
  return { text: tr("products.chip.demandNoData"), ...CHIP_GRAY };
}
function trendChip(m: ProductOpportunityPublicMetrics["trend"], tr: (key: MessageKey) => string) {
  if (m.label === "rising")    return { text: tr("products.chip.trendRising"),    ...CHIP_GREEN };
  if (m.label === "stable")    return { text: tr("products.chip.trendStable"),    ...CHIP_YELLOW };
  if (m.label === "declining") return { text: tr("products.chip.trendDeclining"), ...CHIP_RED };
  return { text: tr("products.chip.trendNoData"), ...CHIP_GRAY };
}
function competitionChip(m: ProductOpportunityPublicMetrics["competition"], tr: (key: MessageKey) => string) {
  if (m.label === "low")    return { text: tr("products.chip.compLow"),    ...CHIP_GREEN };
  if (m.label === "medium") return { text: tr("products.chip.compMedium"), ...CHIP_YELLOW };
  if (m.label === "high")   return { text: tr("products.chip.compHigh"),   ...CHIP_RED };
  return { text: tr("products.chip.compNoData"), ...CHIP_GRAY };
}

function MetricChip({ text, color, title }: { text: string; color: string; title?: string }) {
  return (
    <span title={title}
      className="inline-flex items-center rounded-lg px-1.5 py-0.5 text-[9px] font-bold whitespace-nowrap"
      style={{ background: "rgba(10,15,25,0.55)", color, border: "1px solid rgba(255,255,255,0.10)", backdropFilter: "blur(6px)" }}>
      {text}
    </span>
  );
}

function productSavesValue(p: PinProduct): number | null {
  if (p.product_metrics?.productPinSaveCount != null) return p.product_metrics.productPinSaveCount;
  if (p.product_pin_id && p.save_count != null) return p.save_count;
  if (p.target_product_pin_id && p.target_product_pin_save_count != null) return p.target_product_pin_save_count;
  if (p.product_metrics?.aggregateProductPinSaves != null) return p.product_metrics.aggregateProductPinSaves;
  return null;
}

function sourcePinSavesValue(p: PinProduct): number | null {
  return p.source_pin_save_count ?? p.product_metrics?.sourcePinSaveCount ?? null;
}

// Provenance URLs — the Product's OWN Pin and the SOURCE pin it was found in
// are separate links (a Shop-the-Look product has both).
function productPinUrlOf(p: PinProduct): string | null {
  if (p.target_product_pin_url) return p.target_product_pin_url;
  const pinId = p.target_product_pin_id ?? p.product_pin_id;
  return pinId ? `https://www.pinterest.com/pin/${pinId}/` : null;
}
function sourcePinUrlOf(p: PinProduct): string | null {
  // parent_pin_id is the row's own source pin. source_pin_ids (server-aggregated
  // across the product's URL-identity group) is the fallback — never a Product Pin,
  // so it can't impersonate one.
  const pinId = (p.parent_pin_id && p.parent_pin_id !== "0")
    ? p.parent_pin_id
    : p.source_pin_ids?.find(id => id && id !== "0") ?? null;
  return pinId ? `https://www.pinterest.com/pin/${pinId}/` : null;
}

function createdOrFoundAt(p: PinProduct): string | null {
  return p.created_at ?? p.scraped_at ?? null;
}

// tr is threaded in (these are pure module-level helpers, not components/hooks).
function relativeTimeLabel(iso: string | null, tr: (key: MessageKey) => string): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const diffMs = Date.now() - time;
  if (diffMs < 0) return tr("products.time.justFound");
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return tr("products.time.justFound");
  if (mins < 60) return tr("products.time.minsAgo").replace("{n}", String(mins));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tr("products.time.hoursAgo").replace("{n}", String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return tr(days === 1 ? "products.time.dayAgo" : "products.time.daysAgo").replace("{n}", String(days));
  const months = Math.floor(days / 30);
  if (months < 12) return tr("products.time.moAgo").replace("{n}", String(months));
  const years = Math.floor(months / 12);
  return tr("products.time.yrAgo").replace("{n}", String(years));
}

function productSavesLabel(p: PinProduct, tr: (key: MessageKey) => string): string {
  const saves = productSavesValue(p);
  return saves == null ? tr("products.saves.unavailable") : tr("products.saves.count").replace("{n}", fmt(saves));
}

function productSavesShortLabel(p: PinProduct): string {
  const saves = productSavesValue(p);
  return saves == null ? "-" : fmt(saves);
}

function compactFoundLabel(iso: string | null, tr: (key: MessageKey) => string): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const diffMs = Date.now() - time;
  if (diffMs < 0) return tr("products.time.compactNow");
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return tr("products.time.compactNow");
  if (mins < 60) return tr("products.time.compactMins").replace("{n}", String(mins));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tr("products.time.compactHours").replace("{n}", String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return tr("products.time.compactDays").replace("{n}", String(days));
  const months = Math.floor(days / 30);
  if (months < 12) return tr("products.time.compactMonths").replace("{n}", String(months));
  const years = Math.floor(months / 12);
  return tr("products.time.compactYears").replace("{n}", String(years));
}

function saveProductToLibrary(p: PinProduct, title: string | null) {
  assetStore.saveAsset({
    role: "product", assetRole: "product_image",
    itemType: p.item_type ?? "product", productType: p.product_type ?? "physical_product",
    productSubtype: p.product_subtype ?? "unknown", destinationType: p.destination_type ?? "product_page",
    sourceContext: "saved_from_product_ideas", riskFlags: p.risk_flags, source: "product_signal",
    // title is optional on the asset; a NULL product_name carries through as no
    // title rather than a fabricated "Product".
    imageUrl: p.image_url, title: title ?? undefined,
    category: p.seed_keyword ?? undefined,
    sourceUrl: p.source_url ?? undefined, productUrl: p.source_url ?? undefined,
    sourceDomain: p.domain ?? undefined, store: p.merchant ?? p.domain ?? undefined,
    price: p.price != null ? String(p.price) : undefined, currency: p.currency ?? undefined,
  });
}

function PinterestGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="#E469A6" aria-hidden>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
    </svg>
  );
}

function ProductCard({
  p, metrics, onClick, isSelected = false, onToggle, onUseForPins,
}: {
  p: PinProduct; metrics: ProductOpportunityPublicMetrics; onClick: () => void;
  isSelected?: boolean; onToggle: () => void; onUseForPins?: () => void;
}) {
  const { t: tr } = useLocale();
  const [imgError, setImgError] = useState(false);
  const title  = cleanProductTitle(p.product_name);
  const foundAt = createdOrFoundAt(p);
  const foundLabel = compactFoundLabel(foundAt, tr);
  const foundTitle = relativeTimeLabel(foundAt, tr);
  const savesText = productSavesShortLabel(p);
  const savesTitle = productSavesLabel(p, tr);

  // Save Product → Product Library (assetStore, role "product"); available in the
  // Create Pins Product Picker. Deduped by image+role.
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const check = () => setSaved(assetStore.getByRole("product").some(a => a.imageUrl === p.image_url));
    check();
    return assetStore.subscribe(check);
  }, [p.image_url]);
  function toggleSave(e: React.MouseEvent) {
    e.stopPropagation();
    if (saved) {
      const found = assetStore.getByRole("product").find(a => a.imageUrl === p.image_url);
      if (found) { assetStore.removeAsset(found.id); toast.success(tr("products.card.removedFromLibrary")); }
      return;
    }
    saveProductToLibrary(p, title);
    toast.success(tr("products.card.savedToLibrary"));
  }

  return (
    <div
      data-testid="product-card"
      data-product-id={p.id}
      className="group relative cursor-pointer overflow-hidden rounded-2xl bg-gray-100 transition-all"
      style={{
        border: isSelected ? "1px solid #C026D3" : "1px solid #E5E7EB",
        boxShadow: isSelected ? "0 0 0 3px rgba(192,38,211,0.18), 0 6px 22px rgba(192,38,211,0.14)" : "0 10px 30px rgba(15,23,42,0.08)",
        aspectRatio: "4 / 5",
      }}
      onClick={onClick}
    >
      {!imgError && p.image_url ? (
        <Image src={p.image_url} alt={title ?? ""} fill className="object-cover transition-transform duration-300 group-hover:scale-[1.03]" sizes="(max-width:640px) 48vw, 260px" unoptimized onError={() => setImgError(true)} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><Package className="h-8 w-8 text-gray-300" /></div>
      )}
      <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />

      <button
        type="button" role="checkbox" aria-checked={isSelected}
        aria-label={isSelected ? tr("products.card.deselect") : tr("products.card.select")}
        data-testid="product-checkbox"
        onClick={e => { e.stopPropagation(); onToggle(); }}
        className="absolute left-3 top-3 z-20 flex h-5 w-5 items-center justify-center rounded-md transition-all"
        style={isSelected
          ? { background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)", border: "1px solid rgba(255,255,255,0.7)", boxShadow: "0 0 0 2px rgba(192,38,211,0.2)" }
          : { background: "rgba(17,24,39,0.22)", border: "1px solid rgba(255,255,255,0.72)", backdropFilter: "blur(8px)" }}>
        {isSelected && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
      </button>

      <div
        data-testid="product-card-metrics-strip"
        className="absolute left-0 top-[74px] z-20 flex w-[52px] flex-col items-start gap-4 rounded-r-xl px-3 py-3 text-white"
        style={{
          background: "linear-gradient(to right, rgba(0,0,0,0.44), rgba(0,0,0,0.22), rgba(0,0,0,0.06))",
          backdropFilter: "blur(6px)",
        }}
      >
        <span
          data-testid="product-card-saves"
          title={tr("products.card.savesTitle").replace("{n}", savesTitle)}
          aria-label={tr("products.card.savesTitle").replace("{n}", savesTitle)}
          className="inline-flex flex-col items-start gap-1 text-[15px] font-black leading-none drop-shadow"
        >
          <PinterestGlyph />
          <span data-save-source={productSavesValue(p) == null ? "unknown" : "product"}>{savesText}</span>
        </span>
        {foundLabel && (
          <span
            data-testid="product-card-found"
            title={foundTitle ? tr("products.card.foundTitle").replace("{time}", foundTitle) : tr("products.card.foundTitleUnavailable")}
            aria-label={foundTitle ? tr("products.card.foundTitle").replace("{time}", foundTitle) : tr("products.card.foundTitleUnavailable")}
            className="inline-flex flex-col items-start gap-1 text-[14px] font-black leading-none drop-shadow"
          >
            <CalendarDays className="h-4 w-4" />
            <span>{foundLabel}</span>
          </span>
        )}
      </div>

      {/* Demand / Trend / Competition + source evidence — the three public
          metrics the user judges from (no unified opportunity label/score). */}
      <div data-testid="product-card-signals"
        className="absolute left-3 right-3 bottom-3 z-10 pointer-events-none flex flex-col items-start gap-1 pr-[88px]">
        <div className="flex flex-wrap gap-1">
          <MetricChip {...demandChip(metrics.demand, tr)} title={demandExplanation(metrics.demand)} />
          <MetricChip {...trendChip(metrics.trend, tr)} title={trendExplanation(metrics.trend)} />
          <MetricChip {...competitionChip(metrics.competition, tr)} title={competitionExplanation(metrics.competition)} />
        </div>
        <span className="inline-flex items-center rounded-lg px-1.5 py-0.5 text-[9px] font-semibold text-white/90 whitespace-nowrap"
          style={{ background: "rgba(10,15,25,0.55)", border: "1px solid rgba(255,255,255,0.10)", backdropFilter: "blur(6px)" }}>
          {tr(SOURCE_TYPE_LABEL_KEYS[sourceTypeCode(p)])}{validatingSourceCount(p) > 1 ? ` · ${tr("products.sourceType.sourcePinsSuffix").replace("{n}", String(validatingSourceCount(p)))}` : ""}
        </span>
      </div>

      <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2">
        <button type="button" data-testid="product-card-generate" title={tr("products.card.generatePin")} aria-label={tr("products.card.generatePin")}
          onClick={e => { e.stopPropagation(); onUseForPins?.(); }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#C026D3] shadow-lg transition-transform hover:scale-[1.06]"
          style={{ background: "rgba(255,255,255,0.92)", border: "1px solid rgba(255,255,255,0.75)", backdropFilter: "blur(10px)" }}>
          <Sparkles className="h-4 w-4" />
        </button>
        <button type="button" data-testid="product-card-save" role="switch" aria-checked={saved}
          title={saved ? tr("products.card.removeFromLibrary") : tr("products.card.saveProduct")}
          aria-label={saved ? tr("products.card.removeFromLibrary") : tr("products.card.saveProduct")}
          onClick={toggleSave}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg shadow-lg transition-transform hover:scale-[1.06]"
          style={{ background: saved ? "rgba(8,145,178,0.94)" : "rgba(255,255,255,0.92)", color: saved ? "#FFFFFF" : "#111827", border: "1px solid rgba(255,255,255,0.75)", backdropFilter: "blur(10px)" }}>
          <Bookmark className="h-4 w-4" style={{ fill: saved ? "#FFFFFF" : "transparent" }} />
        </button>
      </div>
    </div>
  );
}

// Plain badge style for the drawer (light background, not on-image glass).
const DRAWER_BADGE: Record<"green" | "yellow" | "red" | "gray", { color: string; bg: string }> = {
  green:  { color: "#16A34A", bg: "rgba(22,163,74,0.10)" },
  yellow: { color: "#CA8A04", bg: "rgba(202,138,4,0.10)" },
  red:    { color: "#DC2626", bg: "rgba(220,38,38,0.10)" },
  gray:   { color: "#6B7280", bg: "rgba(107,114,128,0.10)" },
};

function DrawerSignalRow({ name, label, tone, explanation }: {
  name: string; label: string; tone: keyof typeof DRAWER_BADGE; explanation: string;
}) {
  const s = DRAWER_BADGE[tone];
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-gray-500">{name}</span>
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-md" style={{ color: s.color, background: s.bg }}>{label}</span>
      </div>
      <p className="mt-0.5 text-[10px] leading-snug text-gray-400">{explanation}</p>
    </div>
  );
}

// Product Drawer
function ProductDrawer({ p, metrics, similar, onSelectSimilar, onClose }: {
  p: PinProduct; metrics: ProductOpportunityPublicMetrics;
  similar: PinProduct[]; onSelectSimilar: (p: PinProduct) => void; onClose: () => void;
}) {
  const { t: tr } = useLocale();
  const [imgError, setImgError] = useState(false);
  const title = cleanProductTitle(p.product_name);
  const price = fmtPrice(p.price, p.currency);
  const merch = merchantLabel(p.domain, tr);
  const productUrl = p.source_url;
  const productPinUrl = productPinUrlOf(p);
  const sourcePinUrl = sourcePinUrlOf(p);
  // Normalized (display-only) category + platform for the drawer chips.
  const drawerCategory = normalizeCategoryLabel(p.category, isDigitalProduct(p) ? "digital" : "physical");
  const drawerPlatform = normalizePlatformLabel({ sourceUrl: p.source_url, domain: p.domain });
  const foundLabel = relativeTimeLabel(createdOrFoundAt(p), tr);
  const productSaves = productSavesValue(p);
  const sourcePinSaves = sourcePinSavesValue(p);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const check = () => setSaved(assetStore.getByRole("product").some(a => a.imageUrl === p.image_url));
    check();
    return assetStore.subscribe(check);
  }, [p.image_url]);
  function handleDrawerCreatePin() {
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromProductSignal({ ...p, product_name: title }));
  }
  function handleDrawerSave() {
    if (saved) {
      const found = assetStore.getByRole("product").find(a => a.imageUrl === p.image_url);
      if (found) { assetStore.removeAsset(found.id); toast.success(tr("products.card.removedFromLibrary")); }
      return;
    }
    saveProductToLibrary(p, title);
    toast.success(tr("products.card.savedToLibrary"));
  }
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40" onClick={onClose} />
      <div data-testid="product-opportunity-drawer" className="fixed right-0 top-0 h-full w-full max-w-[400px] z-50 flex flex-col overflow-hidden bg-white border-l border-gray-200 shadow-xl">
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-0.5">{tr("page.products.drawer.productOpportunity")}</p>
            <p className="text-[11px] font-semibold text-gray-600">{merch}{price ? ` - ${price}` : ""}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="relative overflow-hidden rounded-2xl bg-gray-100" style={{ aspectRatio: "4 / 5" }}>
            {!imgError && p.image_url ? (
              <Image src={p.image_url} alt={title ?? ""} fill className="object-cover" sizes="400px" unoptimized onError={() => setImgError(true)} />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center"><Package className="h-10 w-10 text-gray-300" /></div>
            )}
          </div>

          <div className="min-w-0">
            {/* NULL product_name = merchant page unreadable; render no title row
                rather than a fabricated placeholder. Category/platform chips below
                still convey what we honestly know. */}
            {title && <p className="text-[14px] font-bold text-gray-900 leading-snug line-clamp-3">{title}</p>}
            {/* Normalized category + platform chips (display-only; never raw slugs).
                Falls back to the seed keyword only when no category resolves. */}
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {drawerCategory && (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600">
                  <Tag className="h-3 w-3 text-gray-400" />{drawerCategory}
                </span>
              )}
              {drawerPlatform && (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600">
                  {drawerPlatform}
                </span>
              )}
              {!drawerCategory && p.seed_keyword && (
                <span className="inline-flex items-center gap-1 text-[10px] text-gray-500">
                  <Tag className="h-3 w-3 text-gray-400" />{p.seed_keyword}
                </span>
              )}
            </div>
          </div>

          {/* Demand / Trend / Competition — each with a plain-language explanation.
              No unified opportunity conclusion: the user judges from the three. */}
          <div data-testid="drawer-signals" className="rounded-xl p-3.5 space-y-3 bg-gray-50 border border-gray-100">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">{tr("products.drawer.signals")}</p>
            <DrawerSignalRow name={tr("products.drawer.demand")}
              label={metrics.demand.label === "unknown" ? tr("products.drawer.notEnoughData") : tr(metrics.demand.label === "high" ? "products.drawer.levelHigh" : metrics.demand.label === "medium" ? "products.drawer.levelMedium" : "products.drawer.levelLow")}
              tone={metrics.demand.label === "high" ? "green" : metrics.demand.label === "medium" ? "yellow" : metrics.demand.label === "low" ? "red" : "gray"}
              explanation={demandExplanation(metrics.demand)} />
            <DrawerSignalRow name={tr("products.drawer.trend")}
              label={metrics.trend.label === "unknown" ? tr("products.drawer.notEnoughData") : tr(metrics.trend.label === "rising" ? "products.drawer.trendRising" : metrics.trend.label === "stable" ? "products.drawer.trendStable" : "products.drawer.trendDeclining")}
              tone={metrics.trend.label === "rising" ? "green" : metrics.trend.label === "stable" ? "yellow" : metrics.trend.label === "declining" ? "red" : "gray"}
              explanation={trendExplanation(metrics.trend)} />
            <DrawerSignalRow name={tr("products.drawer.competition")}
              label={metrics.competition.label === "unknown" ? tr("products.drawer.notEnoughData") : tr(metrics.competition.label === "high" ? "products.drawer.levelHigh" : metrics.competition.label === "medium" ? "products.drawer.levelMedium" : "products.drawer.levelLow")}
              tone={metrics.competition.label === "low" ? "green" : metrics.competition.label === "medium" ? "yellow" : metrics.competition.label === "high" ? "red" : "gray"}
              explanation={competitionExplanation(metrics.competition)} />
          </div>

          <div className="rounded-xl p-3.5 space-y-2.5 bg-gray-50 border border-gray-100">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">{tr("page.products.drawer.evidence")}</p>
            {[
              { label: tr("page.products.drawer.productSaves"),    value: productSaves == null ? tr("products.saves.unavailable") : fmt(productSaves) },
              { label: tr("page.products.drawer.sourcePinSaves"), value: sourcePinSaves == null ? tr("products.saves.unavailable") : fmt(sourcePinSaves) },
              { label: tr("products.drawer.sourceType"), value: tr(SOURCE_TYPE_LABEL_KEYS[sourceTypeCode(p)]) },
              ...(validatingSourceCount(p) > 0 ? [{ label: tr("products.drawer.validatingSourcePins"), value: String(validatingSourceCount(p)) }] : []),
              ...(p.seed_keyword ? [{ label: tr("products.drawer.trendKeyword"), value: p.seed_keyword }] : []),
              ...(p.search_keyword ? [{ label: tr("products.drawer.searchKeyword"), value: p.search_keyword }] : []),
              ...(foundLabel ? [{ label: tr("products.drawer.found"), value: foundLabel }] : []),
            ].map(row => (
              <div key={row.label} className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-gray-500 shrink-0">{row.label}</span>
                <span className="text-[12px] font-bold text-gray-900 tabular-nums truncate" title={row.value}>{row.value}</span>
              </div>
            ))}
          </div>

          {(productUrl || productPinUrl || sourcePinUrl) && (
            <div data-testid="drawer-provenance" className="rounded-xl p-3.5 space-y-2.5 bg-gray-50 border border-gray-100">
              {productPinUrl && (
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{tr("products.drawer.productPinUrl")}</p>
                  <p className="mt-1 truncate text-[11px] font-semibold text-gray-700" title={productPinUrl}>{productPinUrl}</p>
                </div>
              )}
              {sourcePinUrl && (
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{tr("products.drawer.sourcePinUrl")}</p>
                  <p className="mt-1 truncate text-[11px] font-semibold text-gray-700" title={sourcePinUrl}>{sourcePinUrl}</p>
                </div>
              )}
              {productUrl && (
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{tr("products.drawer.externalProductUrl")}</p>
                  <p className="mt-1 truncate text-[11px] font-semibold text-gray-700" title={productUrl}>{productUrl}</p>
                </div>
              )}
              {/* Multi-source validation: the actual pins that surfaced this product */}
              {(p.source_pin_ids?.length ?? 0) > 1 && (
                <div className="min-w-0" data-testid="drawer-validating-sources">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                    {tr("products.drawer.validatingSourcePinsCount").replace("{n}", String(p.source_pin_ids!.length))}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.source_pin_ids!.map((id, i) => (
                      <a key={id} href={`https://www.pinterest.com/pin/${id}/`} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold no-underline"
                        style={{ background: "rgba(192,38,211,0.07)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.18)" }}>
                        <ExternalLink className="h-2.5 w-2.5" /> {tr("products.drawer.pinIndex").replace("{n}", String(i + 1))}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Similar products — same keyword/category within the loaded set */}
          {similar.length >= 3 && (
            <div data-testid="drawer-similar-products">
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">{tr("products.drawer.similarProducts")}</p>
              <div className="grid grid-cols-3 gap-2">
                {similar.slice(0, 6).map(sp => (
                  <button key={sp.id} type="button" onClick={() => onSelectSimilar(sp)}
                    className="relative rounded-lg overflow-hidden border border-gray-200 bg-gray-100 text-left"
                    style={{ aspectRatio: "4/5" }}>
                    {sp.image_url && (
                      <Image src={sp.image_url} alt={cleanProductTitle(sp.product_name) ?? ""} fill className="object-cover" sizes="110px" unoptimized />
                    )}
                    <div className="absolute inset-x-0 bottom-0 px-1.5 py-1"
                      style={{ background: "linear-gradient(to top, rgba(0,0,0,0.72), transparent)" }}>
                      <p className="text-[8px] font-bold text-white">{tr("products.drawer.savesSuffix").replace("{n}", productSavesShortLabel(sp))}</p>
                    </div>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[9px] text-gray-400 leading-snug">
                {tr("products.drawer.similarProductsHint")}
              </p>
            </div>
          )}

          <div className="space-y-2 pt-1">
            {productUrl ? (
              <a href={productUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-full py-3 text-[12px] font-bold no-underline transition-all hover:opacity-90 text-white"
                style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                <ExternalLink className="h-3.5 w-3.5" /> {interpolate(tr("page.products.drawer.viewOn"), { merchant: merch })}
              </a>
            ) : (
              <span className="flex items-center justify-center rounded-full py-3 text-[12px] font-bold text-gray-400 bg-gray-50 border border-gray-200">{tr("page.products.drawer.noProductLink")}</span>
            )}
            {productPinUrl && (
              <a href={productPinUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-full py-2.5 text-[11px] font-bold no-underline transition-colors"
                style={{ background: "rgba(107,114,128,0.06)", color: "#6B7280", border: "1px solid rgba(107,114,128,0.15)" }}>
                <ExternalLink className="h-3.5 w-3.5" /> {tr("products.drawer.openProductPin")}
              </a>
            )}
            {sourcePinUrl && (
              <a href={sourcePinUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-full py-2.5 text-[11px] font-bold no-underline transition-colors"
                style={{ background: "rgba(107,114,128,0.06)", color: "#6B7280", border: "1px solid rgba(107,114,128,0.15)" }}>
                <ExternalLink className="h-3.5 w-3.5" /> {tr("products.drawer.openSourcePin")}
              </a>
            )}
            <button type="button" onClick={handleDrawerCreatePin}
              className="flex items-center justify-center gap-2 rounded-full py-2.5 text-[11px] font-bold transition-all hover:opacity-90 text-white w-full"
              style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)", border: "none", cursor: "pointer" }}>
              <Sparkles className="h-3.5 w-3.5" /> {tr("page.products.drawer.useInCreatePins")}
            </button>
            <button type="button" onClick={handleDrawerSave}
              className="flex items-center justify-center gap-2 rounded-full py-2.5 text-[11px] font-bold transition-colors w-full"
              style={saved
                ? { background: "rgba(8,145,178,0.08)", color: "#0891B2", border: "1px solid rgba(8,145,178,0.24)" }
                : { background: "rgba(107,114,128,0.06)", color: "#374151", border: "1px solid rgba(107,114,128,0.16)" }}>
              <Bookmark className="h-3.5 w-3.5" style={{ fill: saved ? "#0891B2" : "transparent" }} />
              {saved ? tr("products.drawer.savedProduct") : tr("products.drawer.saveProduct")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Pin Ideas (Viral Inspiration) intentionally lives on its own dedicated page
// (/app/discover) and in the Create Pins reference picker -NOT here. The Product
// Opportunity Finder focuses solely on product discovery/selection, so this page
// only surfaces a small CTA ({@link PinIdeasCta}) pointing to that dedicated area.
// This avoids conflating Product Opportunity filters with Pin Ideas filters.
function PinIdeasCta() {
  const { t: tr } = useLocale();
  return (
    <div data-testid="pin-ideas-cta" className="mt-8 flex justify-center">
      <a href="/app/discover"
        className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-semibold transition-colors"
        style={{ background: "rgba(192,38,211,0.07)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.18)" }}>
        {tr("products.pinIdeasCta")} <ArrowRight className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

// Page
export default function ProductsPage() {
  const { t: tr } = useLocale();
  const [productClass, setProductClass] = useState<ProductClass>("physical");
  const [catFilter,    setCatFilter]    = useState("All");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [platformFilter, setPlatformFilter] = useState("All");
  const [priceFilter,  setPriceFilter]  = useState<PriceBand>("all");
  const [subType,      setSubType]      = useState<SubType>("all");
  // Cross-page keyword protocol: /app/products?keyword=<trend>&search_keyword=<suggestion>
  // (linked from Keyword Trends). The keyword lands in the search box (matches
  // seed keywords, names and domains) plus a breadcrumb back to Keyword Trends.
  const [linkedKeyword] = useState(() => {
    if (typeof window === "undefined") return "";
    const sp = new URLSearchParams(window.location.search);
    return (sp.get("search_keyword") ?? sp.get("keyword") ?? "").trim();
  });
  const [search,       setSearch]       = useState(() => linkedKeyword);
  // V0 default: "Relevance" when there's a keyword/niche/query context, else "Most
  // saved". `sortTouched` stops the auto-default from overriding a manual choice.
  const [sortKey,      setSortKey]      = useState<SortKey>("most_saved");
  const [sortTouched,  setSortTouched]  = useState(false);
  const [selected,     setSelected]     = useState<PinProduct | null>(null);
  const [showNiche,    setShowNiche]    = useState(false);
  const [selectedIds,  setSelectedIds]  = useState<Set<string>>(new Set());
  const [filtersOpen,  setFiltersOpen]  = useState(false);
  const [pickerOpen,   setPickerOpen]   = useState(false);
  const [page,         setPage]         = useState(1);
  const [perPage,      setPerPage]      = useState(60);

  const { selectedNiches, isFiltering, setScope, saveNiches } = useNicheScope();
  const { data: productMeta, isLoading, mutate } = useProductIdeas();
  const rawProducts   = productMeta?.products ?? EMPTY_PRODUCTS;
  const { data: kwCatMap } = useProductIdeasCategoryMap();

  useEffect(() => {
    if (!isLoading) markDataReady("/app/products");
  }, [isLoading]);

  // V0 default sort (derived, no state sync): "Relevance" when there's a keyword /
  // niche / query context, else "Most saved" — until the user picks a sort.
  const hasQueryContext = search.trim() !== "" || isFiltering || catFilter !== "All";
  const effectiveSort: SortKey = sortTouched ? sortKey : (hasQueryContext ? "relevance" : "most_saved");

  function toggleProduct(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelectedIds(new Set()); }

  const physicalCount = useMemo(() => rawProducts.filter(p => !isDigitalProduct(p)).length, [rawProducts]);
  const digitalCount  = useMemo(() => rawProducts.filter(p =>  isDigitalProduct(p)).length, [rawProducts]);

  // Public Demand / Trend / Competition per row. Prefer the API-derived metrics
  // (full-dataset thresholds); fall back to a local derivation only when the
  // Supabase direct-fetch path returned rows without public_metrics.
  const demandThresholds = useMemo(() => buildDemandThresholds(rawProducts), [rawProducts]);
  const metricsFor = useCallback(
    (p: PinProduct): ProductOpportunityPublicMetrics =>
      p.public_metrics ?? deriveProductOpportunityPublicMetrics(p, demandThresholds),
    [demandThresholds],
  );

  // Normalized platform filter options (domain-first; social/invalid hidden; tail →
  // Other). Uses the shared MVP taxonomy so the filter never shows dirty parser
  // values, duplicate Etsy/Amazon, or "Us".
  //
  // STABLE across pagination: prefer the API's full-dataset aggregation
  // (meta.platformVisible), which is computed over ALL clean user-facing rows so the
  // options don't change with which 60-card subset happened to load. Fall back to
  // computing from the loaded set only when meta is unavailable (e.g. the Supabase
  // direct-fetch fallback path in fetchProductIdeasWithMeta).
  const platformOptions = useMemo(() => {
    const stable = productMeta?.meta?.platformVisible;
    if (stable && stable.length) return stable;
    const { visible, showOther } = computeVisiblePlatforms(
      rawProducts.map(p => ({ sourceUrl: p.source_url, domain: p.domain })),
    );
    return showOther ? [...visible, "Other"] : visible;
  }, [productMeta, rawProducts]);

  function matchesSubType(p: PinProduct): boolean {
    switch (subType) {
      case "printables":   return p.product_subtype === "printable";
      case "templates":    return p.product_subtype === "template";
      case "affiliate":    return MARKETPLACE_DOMAINS.some(d => (p.domain ?? "").toLowerCase().includes(d));
      case "url_imported": return p.source_context === "url_imported";
      default:             return true;
    }
  }
  function matchesPrice(p: PinProduct): boolean {
    const pr = p.price ?? 0;
    switch (priceFilter) {
      case "under25":  return pr > 0 && pr < 25;
      case "25to100":  return pr >= 25 && pr <= 100;
      case "over100":  return pr > 100;
      default:         return true;
    }
  }

  const products = useMemo(() => {
    // Category filter now works on NORMALIZED labels (shared MVP taxonomy). Resolve
    // each product's raw category (source_category-derived p.category, else the
    // keyword→category map) then normalize it, so "Fashion" matches womens/mens/etc.
    const selectedCat: NormalizedCategory | null = catFilter !== "All" ? (catFilter as NormalizedCategory) : null;
    const q = search.trim().toLowerCase();
    const list = rawProducts.filter(p => {
      if (productClass === "digital" ? !isDigitalProduct(p) : isDigitalProduct(p)) return false;
      if (p.risk_flags?.includes("ip_sensitive")) return false;
      if (!matchesSourceFilter(p, sourceFilter)) return false;
      if (!matchesSubType(p)) return false;
      if (!matchesPrice(p)) return false;
      if (isFiltering && !matchesNiche([p.seed_keyword, p.product_name], selectedNiches)) return false;
      if (selectedCat) {
        const rawCat = p.category ?? (p.seed_keyword != null ? kwCatMap?.[p.seed_keyword] : undefined);
        const normalized = normalizeCategoryLabel(rawCat, isDigitalProduct(p) ? "digital" : "physical");
        if (normalized !== selectedCat) return false;
      }
      if (platformFilter !== "All" && normalizePlatformLabel({ sourceUrl: p.source_url, domain: p.domain }) !== platformFilter) return false;
      const cleanName = (cleanProductTitle(p.product_name) ?? "").toLowerCase();
      if (q && !cleanName.includes(q) && !(p.seed_keyword ?? "").toLowerCase().includes(q) && !(p.domain ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    // V0 PUBLIC sort — evidence only. Never uses product_score or any unified
    // opportunity label/score. Rising / Low competition rank by the visible
    // Demand/Trend/Competition badges themselves.
    const createdOrScrapedTime = (p: PinProduct) => Date.parse(p.created_at ?? p.scraped_at ?? "") || 0;
    const savesValue = (p: PinProduct) => productSavesValue(p) ?? -1;              // product-level only; nulls last
    const priceValue = (p: PinProduct) => p.price ?? Number.POSITIVE_INFINITY;     // price asc; missing last
    const TREND_RANK = { rising: 3, stable: 2, declining: 1, unknown: 0 } as const;
    const COMP_RANK  = { low: 3, medium: 2, high: 1, unknown: 0 } as const;
    if (effectiveSort === "most_saved") return [...list].sort((a, b) => savesValue(b) - savesValue(a));
    if (effectiveSort === "newest")     return [...list].sort((a, b) => createdOrScrapedTime(b) - createdOrScrapedTime(a));
    if (effectiveSort === "price")      return [...list].sort((a, b) => priceValue(a) - priceValue(b) || savesValue(b) - savesValue(a));
    if (effectiveSort === "rising")
      return [...list].sort((a, b) =>
        (TREND_RANK[metricsFor(b).trend.label] - TREND_RANK[metricsFor(a).trend.label]) || (savesValue(b) - savesValue(a)));
    if (effectiveSort === "low_competition")
      return [...list].sort((a, b) =>
        (COMP_RANK[metricsFor(b).competition.label] - COMP_RANK[metricsFor(a).competition.label]) || (savesValue(b) - savesValue(a)));
    // "relevance": preserve the incoming filtered order (query/niche relevance from
    // the fetch layer); no product_score re-sort in the public UI.
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawProducts, productClass, subType, priceFilter, catFilter, sourceFilter, platformFilter, search, effectiveSort, isFiltering, selectedNiches, kwCatMap, metricsFor]);

  // Pagination (clamp page to range during render is unsafe; derive a safe slice)
  const pageCount = Math.max(1, Math.ceil(products.length / perPage));
  const safePage  = Math.min(page, pageCount);
  const pageItems = products.slice((safePage - 1) * perPage, safePage * perPage);

  const selectedProducts = useMemo(() => rawProducts.filter(p => selectedIds.has(p.id)), [rawProducts, selectedIds]);

  // Active filter chips
  const activeChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (catFilter !== "All") activeChips.push({ key: "cat", label: tr("products.chipLabel.category").replace("{value}", catFilter), onRemove: () => setCatFilter("All") });
  if (isFiltering) activeChips.push({ key: "niche", label: tr("products.chipLabel.niche").replace("{value}", selectedNiches.map(id => NICHES.find(n => n.id === id)?.label).filter(Boolean).join(", ") || tr("products.chipLabel.nicheSelected")), onRemove: () => setScope("all_trends") });
  if (platformFilter !== "All") activeChips.push({ key: "plat", label: tr("products.chipLabel.platform").replace("{value}", platformFilter), onRemove: () => setPlatformFilter("All") });
  if (priceFilter !== "all") activeChips.push({ key: "price", label: tr("products.chipLabel.price").replace("{value}", priceFilter === "under25" ? tr("products.filters.under25") : priceFilter === "25to100" ? tr("products.filters.25to100") : tr("products.filters.over100")), onRemove: () => setPriceFilter("all") });
  if (subType !== "all") activeChips.push({ key: "type", label: tr("products.chipLabel.type").replace("{value}", subType === "url_imported" ? tr("products.filters.urlImported") : tr(subType === "printables" ? "products.filters.printables" : subType === "templates" ? "products.filters.templates" : "products.filters.affiliate")), onRemove: () => setSubType("all") });
  const filterCount = activeChips.length;
  // Any product-scoped filter narrowing the grid (chips + source + search). Used to
  // explain a reduced grid and offer a one-click reset.
  const anyFilterActive = filterCount > 0 || sourceFilter !== "all" || search.trim() !== "";

  // Count clarity: the summary card shows the TOTAL for the selected class; the grid
  // shows the FILTERED count. classTotal ties the "Showing X of Y" copy to the card.
  const classTotal = productClass === "digital" ? digitalCount : physicalCount;
  const resultsSummary = buildResultsSummary(productClass, products.length, classTotal);
  const filterSummary = summarizeActiveFilters([
    ...activeChips.map(c => c.label),
    search.trim() ? `Search: ${search.trim()}` : null,
    sourceFilter !== "all" ? `Source: ${tr(SOURCE_FILTER_KEYS[sourceFilter])}` : null,
  ]);

  function clearAllFilters() {
    setCatFilter("All"); setPlatformFilter("All"); setPriceFilter("all"); setSubType("all"); setSourceFilter("all"); setScope("all_trends"); setSearch("");
  }

  const closeDrawer = useCallback(() => setSelected(null), []);

  // Similar products for the drawer — same keyword first, then same category,
  // ranked by real saves. Computed from the LOADED set (no extra queries; the
  // drawer labels the scope honestly).
  const similarProducts = useMemo(() => {
    if (!selected) return [] as PinProduct[];
    const pool = rawProducts.filter(p => p.id !== selected.id && !!p.image_url);
    const sameKw = selected.seed_keyword
      ? pool.filter(p => p.seed_keyword === selected.seed_keyword)
      : [];
    const kwIds = new Set(sameKw.map(p => p.id));
    const sameCat = selected.category
      ? pool.filter(p => p.category === selected.category && !kwIds.has(p.id))
      : [];
    return [...sameKw, ...sameCat]
      .sort((a, b) => (productSavesValue(b) ?? -1) - (productSavesValue(a) ?? -1))
      .slice(0, 6);
  }, [selected, rawProducts]);

  // Amazon "Use for Pins": persist with the Amazon product URL so the studio can
  // build the creator's affiliate destination, then route into Create Pins.
  function handleUseForPins(p: PinProduct) {
    if (!p.image_url) return;
    const title = cleanProductTitle(p.product_name);
    assetStore.saveAsset({
      role: "product", assetRole: "product_image", source: "product_signal",
      itemType: "product", productType: "physical_product", productSubtype: "unknown", destinationType: "product_page",
      // NULL product_name carries through as no title, never a fabricated "Product".
      sourceContext: "saved_from_product_ideas", imageUrl: p.image_url, title: title ?? undefined,
      category: p.seed_keyword ?? undefined,
      sourceUrl: p.source_url ?? undefined, productUrl: p.source_url ?? undefined,
      sourceDomain: p.domain ?? undefined, store: p.merchant ?? p.domain ?? undefined,
    });
    const prefill = buildPrefillFromProductSignal({ ...p, product_name: title });
    openCreatePins(url => { window.location.href = url; }, prefill);
  }

  function useSelectedInCreatePins() {
    const prods = selectedProducts.filter(p => p.image_url);
    if (!prods.length) return;
    const prefill = buildPrefillFromProductSignal({ ...prods[0], product_name: cleanProductTitle(prods[0].product_name) });
    if (prods.length > 1) {
      prefill.productImages = prods.map(p => ({
        id: p.id, imageUrl: p.image_url, title: cleanProductTitle(p.product_name) ?? undefined,
        source: "product_signals" as const, category: p.seed_keyword ?? undefined,
        productUrl: p.source_url ?? undefined, sourceDomain: p.domain ?? undefined,
      }));
    }
    openCreatePins(url => { window.location.href = url; }, prefill);
  }

  function handlePickerConfirm(selections: PickerSelection[]) {
    if (!selections.length) { setPickerOpen(false); return; }
    // Persist to My Products and route into Create Pins with full metadata.
    selections.forEach(s => assetStore.saveAsset({
      role: "product", assetRole: "product_image", source: "product_signal",
      itemType: "product", productType: "physical_product", productSubtype: "unknown", destinationType: "product_page",
      sourceContext: "saved_from_product_ideas", imageUrl: s.imageUrl, title: s.title,
      category: s.category, sourceUrl: s.productUrl, productUrl: s.productUrl, sourceDomain: s.sourceDomain, price: s.price,
    }));
    const first = selections[0];
    const prefill = buildPrefillFromProductSignal({
      id: first.id ?? first.imageUrl, product_name: first.title, image_url: first.imageUrl,
      seed_keyword: first.category ?? null, source_url: first.productUrl ?? null, domain: first.sourceDomain ?? null,
    });
    prefill.productImages = selections.map(s => ({
      id: s.id, imageUrl: s.imageUrl, title: s.title, source: "product_ideas" as const,
      category: s.category, productUrl: s.productUrl, sourceDomain: s.sourceDomain,
    }));
    setPickerOpen(false);
    openCreatePins(url => { window.location.href = url; }, prefill);
  }

  return (
    <div className="app-page h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto px-6 py-7">

        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
          <div>
            <h1 className="text-[24px] font-black text-gray-900 tracking-tight">{tr("page.products.heading")}</h1>
            <p className="text-[13px] text-gray-500 mt-1">
              {tr("page.products.subtitle")}
              <a href="/app/discover" className="ml-2 font-semibold inline-flex items-center gap-1" style={{ color: "#C026D3" }}>
                <Activity className="h-3 w-3" /> {tr("products.header.howItWorks")}
              </a>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={() => mutate()} title={tr("products.header.refresh")}
              className="flex items-center justify-center h-9 w-9 rounded-full bg-white border border-gray-200 text-gray-500 hover:text-gray-800 hover:border-gray-300 transition-colors">
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Type cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          <button type="button" onClick={() => { setProductClass("physical"); setPage(1); }}
            className="flex items-center gap-3 rounded-2xl px-5 py-4 text-left transition-all"
            style={productClass === "physical"
              ? { background: "linear-gradient(135deg, rgba(124,58,237,0.16), rgba(192,38,211,0.10))", border: "1px solid rgba(192,38,211,0.4)" }
              : { background: "#FFFFFF", border: "1px solid #E5E7EB" }}>
            <div className="flex items-center justify-center h-10 w-10 rounded-xl shrink-0" style={{ background: "rgba(192,38,211,0.12)", color: "#C026D3" }}><Box className="h-5 w-5" /></div>
            <div>
              <p className="text-[13px] font-black text-gray-900">{tr("products.typeCard.physical")}</p>
              <p className="text-[11px] text-gray-500" data-testid="physical-total">{tr("products.typeCard.totalOpportunities").replace("{n}", physicalCount.toLocaleString())}</p>
            </div>
          </button>
          <button type="button" onClick={() => { setProductClass("digital"); setPage(1); }}
            className="flex items-center gap-3 rounded-2xl px-5 py-4 text-left transition-all"
            style={productClass === "digital"
              ? { background: "linear-gradient(135deg, rgba(124,58,237,0.16), rgba(192,38,211,0.10))", border: "1px solid rgba(192,38,211,0.4)" }
              : { background: "#FFFFFF", border: "1px solid #E5E7EB" }}>
            <div className="flex items-center justify-center h-10 w-10 rounded-xl shrink-0" style={{ background: "rgba(37,99,235,0.12)", color: "#2563EB" }}><Monitor className="h-5 w-5" /></div>
            <div>
              <p className="text-[13px] font-black text-gray-900">{tr("products.typeCard.digital")}</p>
              <p className="text-[11px] text-gray-500" data-testid="digital-total">{tr("products.typeCard.totalOpportunities").replace("{n}", digitalCount.toLocaleString())}</p>
            </div>
          </button>
        </div>

        {/* Cross-page keyword breadcrumb */}
        {linkedKeyword && search === linkedKeyword && (
          <div data-testid="keyword-breadcrumb" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl px-4 py-2.5"
            style={{ background: "rgba(37,99,235,0.06)", border: "1px solid rgba(37,99,235,0.15)" }}>
            <span className="text-[12px] text-gray-600">
              {tr("products.breadcrumb.from")} <a href="/app/trends" className="font-semibold" style={{ color: "#2563EB" }}>{tr("products.breadcrumb.keywordTrends")}</a>:
              {" "}<strong className="text-gray-900">{linkedKeyword}</strong>
              {" "}{tr("products.breadcrumb.showingMatches")}
            </span>
            <button type="button" onClick={() => setSearch("")}
              className="ml-auto rounded-full px-3 py-1 text-[11px] font-semibold"
              style={{ background: "rgba(37,99,235,0.10)", color: "#2563EB" }}>
              {tr("products.breadcrumb.clear")}
            </button>
          </div>
        )}

        {/* Control row */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="relative min-w-[220px] max-w-[360px] flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder={tr("products.search.placeholder")}
              className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-4 py-2 text-[12px] text-gray-800 shadow-sm focus:border-[#C026D3] focus:outline-none placeholder:text-gray-400" />
          </div>

          {/* Source segmented filter — Pinterest source types + Amazon quick toggle */}
          <div data-testid="source-filter" className="flex items-center rounded-lg border border-gray-200 bg-white p-0.5">
            {(Object.entries(SOURCE_FILTER_KEYS) as [SourceFilter, MessageKey][]).map(([id, key]) => (
              <button key={id} type="button" data-testid={`source-filter-${id}`}
                onClick={() => { setSourceFilter(id); setPage(1); }}
                className="rounded-md px-3 py-1.5 text-[11px] font-bold transition-colors whitespace-nowrap"
                style={sourceFilter === id
                  ? { background: "#1A2235", color: "#fff" }
                  : { background: "transparent", color: "#6b7280" }}>
                {tr(key)}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 ml-auto">
            <span className="text-[11px] font-semibold text-gray-500">{tr("products.sort.label")}</span>
            <div className="relative">
              <select value={effectiveSort} onChange={e => { setSortKey(e.target.value as SortKey); setSortTouched(true); }}
                className="appearance-none rounded-lg border border-gray-200 bg-white pl-3 pr-7 py-1.5 text-[11px] font-semibold text-gray-700 cursor-pointer focus:outline-none">
                <option value="relevance">{tr("products.sort.relevance")}</option>
                <option value="most_saved">{tr("products.sort.mostSaved")}</option>
                <option value="rising">{tr("products.sort.rising")}</option>
                <option value="low_competition">{tr("products.sort.lowCompetition")}</option>
                <option value="newest">{tr("products.sort.newest")}</option>
                <option value="price">{tr("products.sort.price")}</option>
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400 pointer-events-none" />
            </div>
          </label>
          <div className="relative">
            <button type="button" onClick={() => setFiltersOpen(o => !o)}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold bg-white border border-gray-200 text-gray-600 hover:border-gray-300 transition-colors">
              <SlidersHorizontal className="h-3.5 w-3.5" /> {tr("products.filters.button")}
              {filterCount > 0 && <span className="rounded-full px-1.5 text-[9px] font-bold text-white" style={{ background: "#C026D3" }}>{filterCount}</span>}
            </button>
            {filtersOpen && (
              <>
                <button type="button" aria-label={tr("products.filters.closeAria")} className="fixed inset-0 z-40" onClick={() => setFiltersOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-[260px] rounded-xl bg-white border border-gray-200 shadow-xl p-3 space-y-3">
                  <FilterRow label={tr("products.filters.category")}>
                    <select value={catFilter} onChange={e => { setCatFilter(e.target.value); setPage(1); }} className={FILTER_SELECT_CLASS}>
                      <option value="All">{tr("products.filters.allCategories")}</option>
                      {PRODUCT_VISIBLE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </FilterRow>
                  <FilterRow label={tr("products.filters.platform")}>
                    <select value={platformFilter} onChange={e => { setPlatformFilter(e.target.value); setPage(1); }} className={FILTER_SELECT_CLASS}>
                      <option value="All">{tr("products.filters.allPlatforms")}</option>
                      {platformOptions.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </FilterRow>
                  <FilterRow label={tr("products.filters.price")}>
                    <select value={priceFilter} onChange={e => { setPriceFilter(e.target.value as PriceBand); setPage(1); }} className={FILTER_SELECT_CLASS}>
                      <option value="all">{tr("products.filters.allPrices")}</option>
                      <option value="under25">{tr("products.filters.under25")}</option>
                      <option value="25to100">{tr("products.filters.25to100")}</option>
                      <option value="over100">{tr("products.filters.over100")}</option>
                    </select>
                  </FilterRow>
                  <FilterRow label={tr("products.filters.type")}>
                    <select value={subType} onChange={e => { setSubType(e.target.value as SubType); setPage(1); }} className={FILTER_SELECT_CLASS}>
                      <option value="all">{tr("products.filters.allTypes")}</option>
                      <option value="printables">{tr("products.filters.printables")}</option>
                      <option value="templates">{tr("products.filters.templates")}</option>
                      <option value="affiliate">{tr("products.filters.affiliate")}</option>
                      <option value="url_imported">{tr("products.filters.urlImported")}</option>
                    </select>
                  </FilterRow>
                  <button type="button" onClick={() => { setShowNiche(true); setFiltersOpen(false); }}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg py-2 text-[11px] font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50">
                    <SlidersHorizontal className="h-3.5 w-3.5" /> {tr("products.filters.editNiches")}
                  </button>
                </div>
              </>
            )}
          </div>
          <button type="button" onClick={() => toast.success(tr("products.saveViewToast"))}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold bg-white border border-gray-200 text-gray-600 hover:border-gray-300 transition-colors">
            <Bookmark className="h-3.5 w-3.5" /> {tr("products.saveView")}
          </button>
          <button type="button" onClick={() => setPickerOpen(true)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
            <Package className="h-3.5 w-3.5" /> {tr("products.productPicker")}
          </button>
        </div>

        {/* Active filter chips */}
        {activeChips.length > 0 && (
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
            {activeChips.map(chip => (
              <span key={chip.key} className="inline-flex items-center gap-1 rounded-full pl-2.5 pr-1.5 py-1 text-[11px] font-semibold"
                style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.2)" }}>
                {chip.label}
                <button type="button" onClick={chip.onRemove} className="hover:opacity-70"><X className="h-3 w-3" /></button>
              </span>
            ))}
            <button type="button" onClick={clearAllFilters} className="text-[11px] font-semibold text-gray-400 hover:text-gray-600 ml-1">{tr("products.clearAll")}</button>
          </div>
        )}

        {/* Grid */}
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {Array.from({ length: 15 }).map((_, i) => (
              <div key={i} className="rounded-xl overflow-hidden border border-gray-200 bg-white">
                <div className="animate-pulse bg-gray-100" style={{ aspectRatio: "4/3" }} />
                <div className="p-3 space-y-2"><div className="h-3 w-full rounded bg-gray-100 animate-pulse" /><div className="h-3 w-4/5 rounded bg-gray-100 animate-pulse" /></div>
              </div>
            ))}
          </div>
        ) : products.length === 0 ? (
          <div data-testid="products-empty" className="flex flex-col items-center justify-center py-24 text-center">
            <Package className="h-10 w-10 text-gray-300 mb-4" />
            <p className="text-[14px] font-semibold text-gray-500">
              {sourceFilter !== "all" && classTotal === 0
                ? tr("products.empty.noSourceProducts").replace("{source}", tr(SOURCE_FILTER_KEYS[sourceFilter]))
                : reducedResultsMessage(productClass, 0, classTotal, filterSummary)}
            </p>
            {classTotal > 0 && anyFilterActive && (
              <p className="text-[12px] text-gray-400 mt-1" data-testid="empty-total-hint">
                {tr("products.empty.totalHint").replace("{n}", classTotal.toLocaleString()).replace("{class}", productClass)}
              </p>
            )}
            <button type="button" data-testid="clear-filters-empty" onClick={clearAllFilters} className="mt-3 px-4 py-2 rounded-full text-[11px] font-semibold" style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3" }}>{tr("products.empty.clearFilters")}</button>
          </div>
        ) : (
          <>
            {anyFilterActive && resultsSummary.reduced && (
              <div data-testid="filtered-results-notice" className="flex flex-wrap items-center justify-between gap-2 mb-4 rounded-xl px-4 py-3"
                style={{ background: "rgba(37,99,235,0.06)", border: "1px solid rgba(37,99,235,0.15)" }}>
                <div className="flex items-center gap-2 min-w-0">
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" style={{ color: "#2563EB" }} />
                  <span className="text-[12px] text-gray-700 min-w-0" data-testid="filtered-results-text">
                    <span className="font-bold text-gray-900">{resultsSummary.line}.</span>{" "}
                    <span className="text-gray-500">{reducedResultsMessage(productClass, products.length, classTotal, filterSummary)}</span>
                  </span>
                </div>
                <button type="button" data-testid="clear-filters" onClick={clearAllFilters}
                  className="shrink-0 text-[11px] font-bold rounded-full px-3 py-1 text-white transition-opacity hover:opacity-90"
                  style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                  {tr("products.results.clearFilters")}
                </button>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {pageItems.map(p => (
                <ProductCard
                  key={p.id}
                  p={p}
                  metrics={metricsFor(p)}
                  onClick={() => setSelected(p)}
                  isSelected={selectedIds.has(p.id)}
                  onToggle={() => toggleProduct(p.id)}
                  onUseForPins={() => handleUseForPins(p)}
                />
              ))}
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between gap-4 mt-6 flex-wrap">
              <span className="text-[12px] text-gray-500" data-testid="grid-count-footer">
                {selectedIds.size > 0 ? tr("products.pagination.selectedPrefix").replace("{n}", String(selectedIds.size)) : ""}
                {anyFilterActive
                  ? resultsSummary.line
                  : tr("products.pagination.productsCount").replace("{n}", products.length.toLocaleString()).replace("{class}", productClass)}
              </span>
              <div className="flex items-center gap-1">
                <button type="button" disabled={safePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
                  className="rounded-lg px-2.5 py-1.5 text-[12px] font-semibold border border-gray-200 text-gray-600 disabled:opacity-40 hover:bg-gray-50">{tr("products.pagination.prev")}</button>
                {pageWindow(safePage, pageCount).map((n, i) => n === "..." ? (
                  <span key={`e${i}`} className="px-1.5 text-[12px] text-gray-400">...</span>
                ) : (
                  <button key={n} type="button" onClick={() => setPage(n as number)}
                    className="rounded-lg min-w-[30px] px-2 py-1.5 text-[12px] font-semibold border transition-colors"
                    style={n === safePage ? { background: "#C026D3", borderColor: "#C026D3", color: "#fff" } : { borderColor: "#E5E7EB", color: "#6b7280" }}>{n}</button>
                ))}
                <button type="button" disabled={safePage >= pageCount} onClick={() => setPage(p => Math.min(pageCount, p + 1))}
                  className="rounded-lg px-2.5 py-1.5 text-[12px] font-semibold border border-gray-200 text-gray-600 disabled:opacity-40 hover:bg-gray-50">{tr("products.pagination.next")}</button>
              </div>
              <label className="flex items-center gap-1.5 text-[12px] text-gray-500">
                {tr("products.pagination.show")}
                <select value={perPage} onChange={e => { setPerPage(Number(e.target.value)); setPage(1); }}
                  className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[12px] font-semibold text-gray-700 cursor-pointer focus:outline-none">
                  {PER_PAGE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
          </>
        )}

        <p className="text-center text-[10px] text-gray-400 mt-6">
          {tr("products.footerNote")}
        </p>

        {/* Lightweight link to the dedicated Pin Ideas page -no cards, tabs, or filters. */}
        <PinIdeasCta />
      </div>

      {/* Page-level selected-products action bar (temporary Create Pins selection) */}
      {selectedIds.size > 0 && (
        <div data-testid="selected-product-bar"
          className="fixed bottom-6 left-1/2 z-50 flex items-center gap-3 rounded-2xl px-4 py-3 bg-white border border-gray-200 max-w-[92vw]"
          style={{ transform: "translateX(-50%)", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
          {/* Stacked thumbnails (up to 3) */}
          <div className="flex items-center shrink-0">
            {selectedProducts.slice(0, 3).map((p, i) => (
              <div key={p.id} className="relative rounded-lg overflow-hidden bg-gray-100 border-2 border-white"
                style={{ width: 32, height: 32, marginLeft: i === 0 ? 0 : -8, zIndex: 3 - i }}>
                {p.image_url
                  ? <Image src={p.image_url} alt="" fill className="object-cover" sizes="32px" unoptimized />
                  : <div className="absolute inset-0 flex items-center justify-center"><Package className="h-3.5 w-3.5 text-gray-300" /></div>}
              </div>
            ))}
            {selectedProducts.length > 3 && (
              <span className="ml-1 text-[11px] font-bold text-gray-400">+{selectedProducts.length - 3}</span>
            )}
          </div>
          <span className="text-[13px] font-bold text-gray-900 shrink-0">
            {tr("products.actionBar.selectedCount").replace("{n}", String(selectedIds.size)).replace("{plural}", selectedIds.size !== 1 ? "s" : "")}
          </span>
          <button type="button" onClick={clearSelection}
            className="rounded-full px-3 py-2 text-[11px] font-semibold text-gray-400 hover:text-gray-600 shrink-0">
            {tr("products.actionBar.clear")}
          </button>
          <button type="button" data-testid="create-pins-with-selected-products" onClick={useSelectedInCreatePins}
            className="flex items-center gap-1.5 rounded-full px-5 py-2 text-[12px] font-bold text-white transition-opacity hover:opacity-90 shrink-0"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
            {tr("products.actionBar.createPins")} <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {selected && (
        <ProductDrawer p={selected} metrics={metricsFor(selected)}
          similar={similarProducts} onSelectSimilar={setSelected} onClose={closeDrawer} />
      )}
      {pickerOpen && (
        <ProductOpportunityPicker products={rawProducts} kwCatMap={kwCatMap} onClose={() => setPickerOpen(false)} onConfirm={handlePickerConfirm} />
      )}
      {showNiche && (
        <NicheModal initial={selectedNiches} onSave={n => { saveNiches(n); setShowNiche(false); }} onClose={() => setShowNiche(false)} />
      )}
    </div>
  );
}

// Small helpers
function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</p>
      {children}
    </div>
  );
}

function pageWindow(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | "...")[] = [1];
  const start = Math.max(2, current - 1);
  const end   = Math.min(total - 1, current + 1);
  if (start > 2) out.push("...");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push("...");
  out.push(total);
  return out;
}
