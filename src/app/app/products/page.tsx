"use client";
import Image from "next/image";
import { useState, useMemo, useEffect, useCallback } from "react";
import { Tag, ExternalLink, Search, ChevronDown, ChevronUp, Package, X } from "lucide-react";
import { BookmarkButton } from "@/components/ui/BookmarkButton";
import { assessProduct } from "@/lib/scoring";
import type { MarketTag } from "@/types/opportunity";
import { matchesNiche, NICHES } from "@/lib/niches";
import { useNicheScope } from "@/lib/useNicheScope";
import { NicheModal } from "@/components/ui/NicheModal";
import { ScopeBar } from "@/components/ui/ScopeBar";
import { CATEGORIES, getCategoryMatchSet } from "@/lib/categories";
import { DigitalSignalGrid } from "@/components/digital/DigitalSignalGrid";
import * as assetStore from "@/lib/assetStore";
import { toast } from "sonner";
import { buildPrefillFromProductSignal, openCreatePins } from "@/lib/createPinsPrefill";
import { type ProductIdea } from "@/lib/productIdeas";
import { useProductIdeas, useProductIdeasCategoryMap } from "@/lib/useProductIdeas";

// ── Types ──────────────────────────────────────────────────────────────────────
type PinProduct = ProductIdea;

type SortKey    = "opportunity" | "save_count" | "source_pin_save_count" | "price";
type SortDir    = "asc" | "desc";
type ProductTab = "physical" | "digital";

const EMPTY_PRODUCTS: PinProduct[] = [];

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function fmtPrice(price: number | null, currency: string | null): string {
  if (!price) return "";
  const sym = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  return `${sym}${price.toFixed(0)}`;
}

function merchantLabel(domain: string | null): string {
  if (!domain) return "Shop";
  const clean = domain.replace(/^www\./, "").split(".")[0];
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// ── "Why it matters" static map ──────────────────────────────────────────────
const WHY_IT_MATTERS: Record<string, string> = {
  "home-decor":       "Products in high-save decor pins signal proven purchase intent",
  "fashion":          "Viral fashion pins drive direct product discovery and saves",
  "beauty":           "Top-saving beauty pins convert readers into buyers",
  "wedding":          "Wedding products see 12–18 month planning cycles — early content wins",
  "diy-crafts":       "Craft supply links in tutorial pins earn consistent affiliate clicks",
  "food-and-drink":   "Recipe ingredient links convert at 2× blog traffic",
  "digital-products": "Digital products have no inventory risk — high-margin opportunity",
  "travel":           "Travel gear linked in destination pins drives high-intent clicks",
  "gardening":        "Seasonal garden products spike in spring — timing is everything",
};

function getWhyItMatters(seedKeyword: string | null): string {
  if (!seedKeyword) return "Products found in viral pins signal confirmed purchase intent";
  const kw = seedKeyword.toLowerCase();
  for (const [key, val] of Object.entries(WHY_IT_MATTERS)) {
    if (kw.includes(key) || key.includes(kw.split(" ")[0])) return val;
  }
  return "Products found in high-save pins indicate proven consumer demand";
}

// ── Workspace-aligned badge helpers ───────────────────────────────────────────

function oppToPrimaryBadge(score: number | null, tag: MarketTag): { label: string; color: string; bg: string } {
  if (score != null) {
    if (score >= 75) return { label: "Best Bet",    color: "#16A34A", bg: "rgba(22,163,74,0.09)"  };
    if (score >= 55) return { label: "Steady",      color: "#2563EB", bg: "rgba(37,99,235,0.08)"  };
    return           { label: "Competitive", color: "#D97706", bg: "rgba(217,119,6,0.09)"  };
  }
  // Fallback from market tag
  if (tag === "hidden_supply" || tag === "new_account_friendly")
    return { label: "Best Bet", color: "#16A34A", bg: "rgba(22,163,74,0.09)" };
  if (tag === "oversaturated")
    return { label: "Competitive", color: "#D97706", bg: "rgba(217,119,6,0.09)" };
  return { label: "Steady", color: "#2563EB", bg: "rgba(37,99,235,0.08)" };
}

function productFitChip(tag: MarketTag): { label: string; color: string } {
  if (tag === "hidden_supply")        return { label: "Strong Fit", color: "#16A34A" };
  if (tag === "new_account_friendly") return { label: "Good Fit",   color: "#059669" };
  if (tag === "oversaturated")        return { label: "Weak Fit",   color: "#D97706" };
  return                                     { label: "Good Fit",   color: "#2563EB" };
}

// ── Sort button ────────────────────────────────────────────────────────────────
function SortBtn({ label, col, active, dir, onClick }: {
  label: string; col: SortKey; active: boolean; dir: SortDir; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
        active
          ? "text-[#C026D3]"
          : "text-gray-500 hover:text-gray-700"
      }`}
      style={active ? { background: "rgba(192,38,211,0.08)", border: "1px solid rgba(192,38,211,0.2)" } : { background: "#F9FAFB", border: "1px solid #E5E7EB" }}
    >
      {label}
      {active ? (dir === "desc" ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />) : null}
    </button>
  );
}

// ── Product card ───────────────────────────────────────────────────────────────
function ProductCard({
  p,
  onClick,
  selectionMode = false,
  isSelected = false,
  onToggle,
  onEnterSelection,
}: {
  p: PinProduct;
  onClick: () => void;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggle?: () => void;
  onEnterSelection?: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  const assessment = assessProduct({ save_count: p.save_count, source_pin_save_count: p.source_pin_save_count ?? 0, linked_keyword_growth: 0 });
  const price      = fmtPrice(p.price, p.currency);
  const merch      = merchantLabel(p.domain);
  const whyText    = getWhyItMatters(p.seed_keyword);
  function handleCreatePin(e: React.MouseEvent) {
    e.stopPropagation();
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromProductSignal(p));
  }

  return (
    <div
      data-testid="product-card"
      className="group rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-md bg-white"
      style={{
        border: isSelected ? "2px solid #C026D3" : "1px solid #E5E7EB",
        boxShadow: isSelected ? "0 0 0 3px rgba(192,38,211,0.12)" : undefined,
      }}
      onClick={() => selectionMode ? onToggle?.() : onClick()}
    >
      {/* Image — score overlaid bottom-right */}
      <div className="relative bg-gray-100" style={{ aspectRatio: "1/1" }}>
        {/* Checkbox — visible on hover or when in selection mode / already selected */}
        <div
          data-testid="product-checkbox"
          className={`absolute top-2 left-2 z-10 flex items-center justify-center cursor-pointer transition-opacity ${selectionMode || isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{
            width: 20, height: 20, borderRadius: 5,
            background: isSelected ? "#C026D3" : "rgba(255,255,255,0.9)",
            border: `2px solid ${isSelected ? "#C026D3" : "rgba(0,0,0,0.25)"}`,
            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
          }}
          onClick={e => {
            e.stopPropagation();
            if (!selectionMode) onEnterSelection?.();
            onToggle?.();
          }}
        >
          {isSelected && (
            <span style={{ color: "#fff", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>
          )}
        </div>

        {!imgError ? (
          <Image
            src={p.image_url}
            alt={p.product_name}
            fill
            className="object-cover"
            sizes="(max-width:640px) 48vw, 220px"
            unoptimized
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Package className="h-8 w-8 text-gray-300" />
          </div>
        )}
        {/* Primary badge — overlaid bottom-right */}
        <div className="absolute bottom-2 right-2">
          {(() => { const b = oppToPrimaryBadge(p.opportunity_score, assessment.marketTag); return (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap backdrop-blur-sm" style={{ background: b.bg, color: b.color, border: `1px solid ${b.color}44` }}>{b.label}</span>
          ); })()}
        </div>
        {/* Hover overlay — standard mode */}
        {!selectionMode && (
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-end p-3 gap-1.5"
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.78) 50%, transparent 100%)" }}>
            <button type="button" onClick={handleCreatePin}
              className="w-full rounded-full py-1.5 text-[10px] font-bold text-center text-white"
              style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
              Use as Product Image
            </button>
            <button type="button" onClick={e => {
              e.stopPropagation();
              assetStore.saveAsset({
                role: "product",
                assetRole: "product_image",
                itemType: p.item_type ?? "product",
                productType: p.product_type ?? "physical_product",
                productSubtype: p.product_subtype ?? "unknown",
                destinationType: p.destination_type ?? "product_page",
                sourceContext: "saved_from_product_ideas",
                riskFlags: p.risk_flags,
                source: "product_signal",
                imageUrl: p.image_url,
                title: p.product_name,
                category: p.seed_keyword ?? undefined,
                sourceUrl: p.source_url ?? undefined,
              });
              toast.success("Product saved — available in Create Pin Studio");
            }}
              className="w-full rounded-full py-1.5 text-[10px] font-bold text-white/90"
              style={{ background: "rgba(255,255,255,0.14)", border: "1px solid rgba(255,255,255,0.18)" }}>
              Save to My Products
            </button>
          </div>
        )}
        {/* Hover overlay — selection mode (view details only) */}
        {selectionMode && (
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-end p-3"
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.52) 30%, transparent 100%)" }}>
            <button type="button" onClick={e => { e.stopPropagation(); onClick(); }}
              className="w-full rounded-full py-1.5 text-[10px] font-bold text-white/90"
              style={{ background: "rgba(255,255,255,0.15)" }}>
              View Details
            </button>
          </div>
        )}
      </div>

      {/* Card body — 3 lines max */}
      <div className="p-3">
        {/* Merchant + bookmark */}
        <div className="flex items-center justify-between mb-1">
          <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">{merch}{price ? ` · ${price}` : ""}</p>
          {!selectionMode && (
            <span onClick={e => e.stopPropagation()}>
              <BookmarkButton
                item={{
                  id: p.id,
                  type: "product",
                  title: p.product_name,
                  image_url: p.image_url,
                  domain: p.domain ?? undefined,
                  marketTag: assessment.marketTag,
                }}
              />
            </span>
          )}
        </div>
        {/* Product name */}
        <p className="text-[12px] font-semibold text-gray-900 leading-snug line-clamp-2 mb-1.5">{p.product_name}</p>
        {/* Evidence */}
        <p className="text-[10px] text-gray-500 mb-1">
          {fmt(p.save_count)} saves · Pin: {fmt(p.source_pin_save_count)}
        </p>
        {/* Why it matters */}
        <p className="text-[9px] text-gray-400 leading-snug line-clamp-2">{whyText}</p>
      </div>
    </div>
  );
}

// ── Product Drawer ─────────────────────────────────────────────────────────────
function ProductDrawer({ p, onClose }: { p: PinProduct; onClose: () => void }) {
  const assessment  = assessProduct({ save_count: p.save_count, source_pin_save_count: p.source_pin_save_count ?? 0, linked_keyword_growth: 0 });
  const drawerBadge = oppToPrimaryBadge(p.opportunity_score, assessment.marketTag);
  const drawerFit   = productFitChip(assessment.marketTag);
  const price = fmtPrice(p.price, p.currency);
  const merch = merchantLabel(p.domain);
  const pinUrl = p.parent_pin_id ? `https://www.pinterest.com/pin/${p.parent_pin_id}/` : null;
  function handleDrawerCreatePin() {
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromProductSignal(p));
  }

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-[400px] z-50 flex flex-col overflow-hidden bg-white border-l border-gray-200 shadow-xl">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-0.5">Product Signal</p>
            <p className="text-[11px] font-semibold text-gray-600">{merch}{price ? ` · ${price}` : ""}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">

          {/* Primary badge + fit chip + name */}
          <div className="flex items-start gap-4">
            <div className="shrink-0 flex flex-col gap-1">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap" style={{ background: drawerBadge.bg, color: drawerBadge.color, border: `1px solid ${drawerBadge.color}33` }}>{drawerBadge.label}</span>
              <span className="text-[9px] font-semibold whitespace-nowrap" style={{ color: drawerFit.color }}>{drawerFit.label}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-bold text-gray-900 leading-snug line-clamp-3">{p.product_name}</p>
              {p.seed_keyword && (
                <div className="flex items-center gap-1 mt-1.5">
                  <Tag className="h-3 w-3 text-gray-400" />
                  <span className="text-[10px] text-gray-500">{p.seed_keyword}</span>
                </div>
              )}
            </div>
          </div>

          {/* Seller intelligence */}
          <div className="rounded-xl p-3 bg-gray-50 border border-gray-100">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2.5">Product Assessment</p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="rounded-lg p-2 bg-white border border-gray-100">
                <p className="text-[9px] text-gray-400 uppercase tracking-widest">Est. Monthly Vol</p>
                <p className="text-[12px] font-black mt-0.5 text-gray-900">
                  👁️ {assessment.estMonthlyVolume >= 1_000
                    ? `${(assessment.estMonthlyVolume / 1_000).toFixed(0)}K`
                    : String(assessment.estMonthlyVolume)}
                </p>
              </div>
              <div className="rounded-lg p-2 bg-white border border-gray-100">
                <p className="text-[9px] text-gray-400 uppercase tracking-widest">Commercial Density</p>
                <p className="text-[12px] font-black mt-0.5 text-gray-900">
                  {assessment.commercialRatio > 0
                    ? `${Math.round(assessment.commercialRatio * 100)}%`
                    : "—"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest w-16 shrink-0">Fit</span>
              <span className="text-[9px] font-semibold" style={{ color: drawerFit.color }}>{drawerFit.label}</span>
            </div>
            <p className="text-[10px] text-gray-500 leading-relaxed">💡 {assessment.insight}</p>
          </div>

          {/* Evidence */}
          <div className="rounded-xl p-3.5 space-y-2.5 bg-gray-50 border border-gray-100">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Evidence</p>
            {[
              { label: "Product saves",  value: fmt(p.save_count) },
              { label: "Source pin saves", value: fmt(p.source_pin_save_count) },
              { label: "Reactions",      value: fmt(p.reaction_count) },
            ].map(row => (
              <div key={row.label} className="flex items-center justify-between">
                <span className="text-[11px] text-gray-500">{row.label}</span>
                <span className="text-[12px] font-bold text-gray-900 tabular-nums">{row.value}</span>
              </div>
            ))}
          </div>

          {/* Raw scores (if available from DB) */}
          {p.opportunity_score != null && (
            <div className="rounded-xl p-3.5 space-y-2 bg-gray-50 border border-gray-100">
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">DB Scores</p>
              {[
                { label: "Opportunity",    value: p.opportunity_score },
                { label: "Trend",          value: p.trend_score },
                { label: "Save velocity",  value: p.save_velocity_score },
              ].filter(r => r.value != null).map(row => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">{row.label}</span>
                  <span className="text-[11px] font-bold tabular-nums text-gray-700">{row.value?.toFixed(0)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="space-y-2 pt-1">
            {p.source_url ? (
              <a href={p.source_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-full py-3 text-[12px] font-bold no-underline transition-all hover:opacity-90 text-white"
                style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                <ExternalLink className="h-3.5 w-3.5" />
                View on {merch}
              </a>
            ) : (
              <span className="flex items-center justify-center rounded-full py-3 text-[12px] font-bold text-gray-400 bg-gray-50 border border-gray-200">
                No product link
              </span>
            )}
            {pinUrl && (
              <a href={pinUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-full py-2.5 text-[11px] font-bold no-underline transition-colors"
                style={{ background: "rgba(107,114,128,0.06)", color: "#6B7280", border: "1px solid rgba(107,114,128,0.15)" }}>
                View Source Pin
              </a>
            )}
            <button type="button" onClick={handleDrawerCreatePin}
              className="flex items-center justify-center gap-2 rounded-full py-2.5 text-[11px] font-bold transition-all hover:opacity-90 text-white w-full"
              style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)", border: "none", cursor: "pointer" }}>
              ✨ Create with product
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ProductsPage() {
  const [tab,           setTab]          = useState<ProductTab>("physical");
  const [catFilter,     setCatFilter]    = useState("All");
  const [domainFilter,  setDomainFilter] = useState("All");
  const [kwFilter,      setKwFilter]     = useState("All");
  const [search,        setSearch]       = useState(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("keyword") ?? ""
      : "",
  );
  const [sortKey,       setSortKey]      = useState<SortKey>("opportunity");
  const [sortDir,       setSortDir]      = useState<SortDir>("desc");
  const [selected,      setSelected]     = useState<PinProduct | null>(null);
  const [showModal,     setShowModal]    = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds,   setSelectedIds]   = useState<Set<string>>(new Set());

  function toggleProduct(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function navigateToStudioWithSelected() {
    const selectedProds = products.filter(p => selectedIds.has(p.id)).filter(p => p.image_url);
    if (!selectedProds.length) return;
    const kw = kwFilter !== "All" ? kwFilter : search.trim() || undefined;
    const prefill = buildPrefillFromProductSignal(selectedProds[0]);
    if (selectedProds.length > 1) {
      prefill.productImages = selectedProds.map(p => ({
        id: p.id, imageUrl: p.image_url, title: p.product_name,
        source: "product_signals" as const, category: p.seed_keyword ?? undefined,
        productUrl: p.source_url ?? undefined, sourceDomain: p.domain ?? undefined,
      }));
    }
    if (kw) prefill.opportunity = { title: kw, keyword: kw };
    openCreatePins(url => { window.location.href = url; }, prefill);
  }

  const { selectedNiches, scope, isFiltering, initialized, setScope, saveNiches } = useNicheScope();


  const { data: productMeta, isLoading } = useProductIdeas();
  const rawProducts = productMeta?.products ?? EMPTY_PRODUCTS;

  const { data: kwCatMap } = useProductIdeasCategoryMap();

  const domainOptions = useMemo(() => {
    const counts: Record<string, number> = {};
    (rawProducts ?? []).forEach(p => { if (p.domain) counts[p.domain] = (counts[p.domain] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, n]) => ({ domain: d, count: n }));
  }, [rawProducts]);

  const kwOptions = useMemo(() => {
    const counts: Record<string, number> = {};
    (rawProducts ?? []).forEach(p => { if (p.seed_keyword) counts[p.seed_keyword] = (counts[p.seed_keyword] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([kw, n]) => ({ kw, count: n }));
  }, [rawProducts]);

  const products = (() => {
    const matchSet = catFilter !== "All" && kwCatMap ? getCategoryMatchSet(catFilter) : null;
    const q = search.trim().toLowerCase();
    const list = rawProducts.filter(p =>
      (p.product_type ?? "physical_product") !== "digital_product" &&
      (!isFiltering || matchesNiche([p.seed_keyword, p.product_name], selectedNiches)) &&
      (!matchSet || (p.seed_keyword != null && matchSet.has(kwCatMap![p.seed_keyword]))) &&
      (domainFilter === "All" || !!p.domain?.includes(domainFilter)) &&
      (kwFilter === "All" || p.seed_keyword === kwFilter) &&
      (!q ||
        p.product_name.toLowerCase().includes(q) ||
        (p.seed_keyword ?? "").toLowerCase().includes(q) ||
        (p.domain ?? "").toLowerCase().includes(q))
    );
    const TAG_RANK: Record<string, number> = { hidden_supply: 4, new_account_friendly: 3, oversaturated: 2, low_volume: 1 };
    const oppScore = (p: PinProduct) => {
      if (p.opportunity_score != null) return p.opportunity_score;
      const tag = assessProduct({ save_count: p.save_count, source_pin_save_count: p.source_pin_save_count ?? 0, linked_keyword_growth: 0 }).marketTag;
      return TAG_RANK[tag] * 25;
    };
    return [...list].sort((a, b) => {
      const va = sortKey === "opportunity" ? oppScore(a)
        : sortKey === "price" ? (a.price ?? 0)
        : (a[sortKey] as number) ?? 0;
      const vb = sortKey === "opportunity" ? oppScore(b)
        : sortKey === "price" ? (b.price ?? 0)
        : (b[sortKey] as number) ?? 0;
      return sortDir === "desc" ? vb - va : va - vb;
    });
  })();

  const digitalProducts = rawProducts.filter(p => p.product_type === "digital_product");

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(col); setSortDir("desc"); }
  }

  const closeDrawer = useCallback(() => setSelected(null), []);

  return (
    <div className="app-page h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto px-6 py-8">

        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Product Signals</p>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">
              Product Opportunity Finder
            </h1>
            <p className="text-[13px] text-gray-500 mt-1">
              {isFiltering
                ? `Showing product signals for: ${selectedNiches.map(id => NICHES.find(n => n.id === id)?.label).filter(Boolean).join(", ")}`
                : "Find products from Pinterest signals and turn them into Pins."
              }
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {/* Physical / Digital tab */}
            <div className="flex rounded-xl overflow-hidden border border-gray-200 bg-white">
              <button type="button" onClick={() => setTab("physical")}
                className={`px-4 py-2 text-[11px] font-bold transition-colors ${tab === "physical" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
                style={tab === "physical" ? { background: "#C026D3" } : {}}>
                📦 Physical
              </button>
              <button type="button" onClick={() => setTab("digital")}
                className={`px-4 py-2 text-[11px] font-bold transition-colors ${tab === "digital" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
                style={tab === "digital" ? { background: "#C026D3" } : {}}>
                💻 Digital
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-xl px-4 py-3 bg-white border border-gray-200 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-[#C026D3] animate-pulse" />
              <span className="text-[11px] font-semibold text-gray-600">
                {isLoading ? "Loading signals…" : "Product signals available"}
              </span>
            </div>
          </div>
        </div>

        {/* Scope bar */}
        {initialized && (
          <ScopeBar
            scope={scope}
            selectedNiches={selectedNiches}
            onScopeChange={setScope}
            onEditNiches={() => setShowModal(true)}
          />
        )}

        {/* Controls — only shown for physical products */}
        {tab === "digital" ? <div className="mb-7" /> : null}
        <div className={`space-y-2.5 mb-7 ${tab === "digital" ? "hidden" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative min-w-[180px] max-w-[260px] flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search products…"
                className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-4 py-2 text-[12px] text-gray-800 shadow-sm focus:border-[#C026D3]/50 focus:outline-none placeholder:text-gray-400" />
            </div>
            {/* Sort */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-gray-400 mr-0.5">Sort:</span>
              <SortBtn label="Opportunity" col="opportunity"          active={sortKey === "opportunity"}          dir={sortDir} onClick={() => toggleSort("opportunity")} />
              <SortBtn label="Saves"       col="save_count"           active={sortKey === "save_count"}           dir={sortDir} onClick={() => toggleSort("save_count")} />
              <SortBtn label="Pin viral"   col="source_pin_save_count" active={sortKey === "source_pin_save_count"} dir={sortDir} onClick={() => toggleSort("source_pin_save_count")} />
              <SortBtn label="Price"       col="price"                active={sortKey === "price"}                dir={sortDir} onClick={() => toggleSort("price")} />
            </div>
            {/* Select products toggle */}
            <button
              type="button"
              onClick={() => {
                if (selectionMode) { exitSelectionMode(); } else { setSelectionMode(true); }
              }}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors whitespace-nowrap"
              style={selectionMode
                ? { background: "rgba(192,38,211,0.1)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.3)" }
                : { background: "#F9FAFB", color: "#6b7280", border: "1px solid #E5E7EB" }}>
              {selectionMode
                ? `✓ Selecting${selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}`
                : "Select products"}
            </button>
          </div>

          {/* Category filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-gray-400 mr-0.5">Category:</span>
            {["All", ...CATEGORIES.map(c => c.id)].map(cat => {
              const def = CATEGORIES.find(c => c.id === cat);
              return (
                <button key={cat} type="button" onClick={() => setCatFilter(cat)}
                  className="rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors whitespace-nowrap"
                  style={catFilter === cat
                    ? { background: "rgba(8,145,178,0.08)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.2)" }
                    : { background: "#F9FAFB", color: "#6b7280", border: "1px solid #E5E7EB" }}>
                  {cat === "All" ? "All" : `${def?.emoji ?? "📌"} ${def?.label ?? cat}`}
                </button>
              );
            })}
          </div>

          {/* Domain filter */}
          {domainOptions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-gray-400 mr-0.5">Platform:</span>
              {["All", ...domainOptions.map(d => d.domain)].map(d => (
                <button key={d} type="button" onClick={() => setDomainFilter(d)}
                  className="rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors"
                  style={domainFilter === d
                    ? { background: "rgba(8,145,178,0.08)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.2)" }
                    : { background: "#F9FAFB", color: "#6b7280", border: "1px solid #E5E7EB" }}>
                  {d === "All" ? "All" : merchantLabel(d)}
                </button>
              ))}
            </div>
          )}

          {/* Keyword/niche filter */}
          {kwOptions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-gray-400 mr-0.5">Niche:</span>
              {["All", ...kwOptions.map(k => k.kw)].map(kw => (
                <button key={kw} type="button" onClick={() => setKwFilter(kw)}
                  className="rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors"
                  style={kwFilter === kw
                    ? { background: "rgba(8,145,178,0.08)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.2)" }
                    : { background: "#F9FAFB", color: "#6b7280", border: "1px solid #E5E7EB" }}>
                  {kw === "All" ? "All niches" : kw}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Digital Products tab ──────────────────────────────────────────── */}
        {tab === "digital" && (
          <DigitalSignalGrid products={digitalProducts} isLoading={isLoading} />
        )}
        {/* ── Physical Products tab ─────────────────────────────────────────── */}
        {tab === "physical" && isLoading && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {Array.from({ length: 15 }).map((_, i) => (
              <div key={i} className="rounded-xl overflow-hidden border border-gray-200 bg-white">
                <div className="animate-pulse bg-gray-100" style={{ aspectRatio: "1/1" }} />
                <div className="p-3 space-y-2">
                  <div className="h-2.5 w-16 rounded bg-gray-100 animate-pulse" />
                  <div className="h-3 w-full rounded bg-gray-100 animate-pulse" />
                  <div className="h-3 w-4/5 rounded bg-gray-100 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "physical" && !isLoading && products.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {products.map(p => (
              <ProductCard
                key={p.id}
                p={p}
                onClick={() => setSelected(p)}
                selectionMode={selectionMode}
                isSelected={selectedIds.has(p.id)}
                onToggle={() => toggleProduct(p.id)}
                onEnterSelection={() => setSelectionMode(true)}
              />
            ))}
          </div>
        )}

        {tab === "physical" && !isLoading && products.length === 0 && (
          <div className="flex flex-col items-center justify-center py-28 text-center">
            <Package className="h-10 w-10 text-gray-300 mb-4" />
            {isFiltering ? (
              <>
                <p className="text-[14px] font-semibold text-gray-500">No products found for your selected niches.</p>
                <p className="text-[12px] text-gray-400 mt-1.5 mb-3">Try switching to All Trends or adjusting your niche selection.</p>
                <button
                  type="button"
                  onClick={() => setScope("all_trends")}
                  className="px-4 py-2 rounded-full text-[11px] font-semibold"
                  style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3" }}
                >
                  Show All Trends
                </button>
              </>
            ) : (
              <>
                <p className="text-[14px] font-semibold text-gray-500">No products found</p>
                <p className="text-[12px] text-gray-400 mt-1.5">
                  {rawProducts && rawProducts.length > 0
                    ? "Try clearing your filters above"
                    : "Product signals are updated weekly — check back soon"}
                </p>
              </>
            )}
          </div>
        )}

        {tab === "physical" && (
          <p className="text-center text-[10px] text-gray-400 mt-8">
            Sourced from Pinterest &ldquo;Shop the Look&rdquo; · save_count ≥ 10
          </p>
        )}
      </div>

      {/* Multi-select sticky action bar */}
      {selectionMode && selectedIds.size > 0 && (
        <div
          data-testid="selected-product-bar"
          className="fixed bottom-6 left-1/2 z-50 flex items-center gap-3 rounded-2xl px-5 py-3.5 bg-white border border-gray-200"
          style={{ transform: "translateX(-50%)", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", whiteSpace: "nowrap" }}
        >
          <span className="text-[13px] font-bold text-gray-900">
            {selectedIds.size} product{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <button
            type="button"
            data-testid="create-pins-with-selected-products"
            onClick={navigateToStudioWithSelected}
            className="rounded-full px-4 py-2 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
            Use as Product Images
          </button>
          <button
            type="button"
            onClick={() => {
              const selected = products.filter(p => selectedIds.has(p.id));
              selected.forEach(p => assetStore.saveAsset({
                role: "product", source: "product_signal",
                assetRole: "product_image",
                itemType: p.item_type ?? "product",
                productType: p.product_type ?? "physical_product",
                productSubtype: p.product_subtype ?? "unknown",
                destinationType: p.destination_type ?? "product_page",
                sourceContext: "saved_from_product_ideas",
                riskFlags: p.risk_flags,
                imageUrl: p.image_url, title: p.product_name,
                category: p.seed_keyword ?? undefined,
                sourceUrl: p.source_url ?? undefined,
              }));
              toast.success(`${selected.length} product${selected.length !== 1 ? "s" : ""} saved for Create Pin`);
              setSelectionMode(false);
            }}
            className="rounded-full px-4 py-2 text-[11px] font-semibold border border-gray-200 transition-colors hover:bg-gray-50">
            Save to My Products
          </button>
          <button
            type="button"
            onClick={() => {
              const kw = kwFilter !== "All" ? kwFilter : search.trim() || undefined;
              window.location.href = `/app/discover${kw ? `?keyword=${encodeURIComponent(kw)}` : ""}`;
            }}
            className="rounded-full px-4 py-2 text-[11px] font-semibold transition-colors"
            style={{ background: "#F9FAFB", color: "#374151", border: "1px solid #E5E7EB" }}>
            Find matching Pin opportunities
          </button>
          <button
            type="button"
            onClick={exitSelectionMode}
            className="rounded-full px-3 py-2 text-[11px] font-semibold text-gray-400 transition-colors hover:text-gray-600"
            style={{ background: "#F9FAFB", border: "1px solid #E5E7EB" }}>
            Clear
          </button>
        </div>
      )}

      {selected && <ProductDrawer p={selected} onClose={closeDrawer} />}
      {showModal && (
        <NicheModal
          initial={selectedNiches}
          onSave={(niches) => { saveNiches(niches); setShowModal(false); }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
