"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { X, Search, Package, Link2, Upload, Loader2, ChevronDown } from "lucide-react";
import * as assetStore from "@/lib/assetStore";
import type { AssetItem } from "@/lib/assetStore";
import { type ProductIdea } from "@/lib/productIdeas";
import { cleanProductTitle } from "@/lib/productTitle";
import { CATEGORIES } from "@/lib/categories";
import { fetchProductUrlImport } from "@/lib/productUrlImportClient";
import { deriveProductSaveCount } from "@/lib/productOpportunityCounts";
import { toast } from "sonner";

// A product chosen in the picker, with the metadata Create Pins needs to preserve.
export type PickerSelection = {
  id?:          string;
  imageUrl:     string;
  title:        string;
  source:       "product_signals" | "product_ideas" | "uploaded" | "url" | "recent";
  category?:    string;
  productUrl?:  string;
  sourceDomain?: string;
  price?:       string;
};

type PickerTab = "my_products" | "opportunities" | "upload" | "link";

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
function fmtPrice(price: number | null | undefined, currency: string | null | undefined): string {
  if (!price) return "";
  const sym = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  return `${sym}${price.toFixed(0)}`;
}
function keyOf(s: PickerSelection): string { return s.id ?? s.imageUrl; }

// Build an HONEST product-evidence label. Pinterest exposes a genuine save count
// only for a product's own Pin; otherwise the only number available is the source
// "Shop the look" Pin's saves, which is NOT a product metric and is labelled as
// such. Clicks / outbound clicks / impressions are not exposed by Pinterest to
// third-party viewers, so they are never shown (not as 0, not as "—").
function productEvidence(p: ProductIdea): { label: string; tooltip: string } {
  const m = p.product_metrics;
  if (m && m.primarySaveKind === "product_pin" && m.aggregateProductPinSaves != null) {
    if (m.uniqueProductPinCount > 1) {
      return {
        label: `${fmt(m.aggregateProductPinSaves)} saves across ${m.uniqueProductPinCount} product Pins`,
        tooltip: `Saves aggregated across ${m.uniqueProductPinCount} Pinterest product Pins for this product `
               + `(deduplicated by ${m.dedupIdentity}). Source: Pinterest Shop the look.`,
      };
    }
    return {
      label: `${fmt(m.productPinSaveCount ?? m.aggregateProductPinSaves)} saves on this product Pin`,
      tooltip: `Saves on this product's own Pinterest product Pin. Source: Pinterest Shop the look.`,
    };
  }
  // Fallback: only source-Pin saves exist — explicitly a source metric.
  const base = `${fmt(m?.sourcePinSaveCount ?? p.source_pin_save_count)} saves on source Pin`;
  const label = m && m.productSourcePinCount > 1
    ? `${base} · ${m.productSourcePinCount} Pinterest sources`
    : base;
  return {
    label,
    tooltip: `Pinterest does not expose a separate save count for this product. `
           + `Shown: saves on the source "Shop the look" Pin it was found in — `
           + `source-Pin engagement, not product saves.`,
  };
}

// ── Selectable card ────────────────────────────────────────────────────────────
function PickCard({ sel, selected, meta, metaTooltip, onToggle }: {
  sel: PickerSelection; selected: boolean; meta?: string; metaTooltip?: string;
  onToggle: () => void;
}) {
  return (
    <button type="button" onClick={onToggle}
      data-testid="picker-product-card"
      className="group relative text-left rounded-xl overflow-hidden transition-all bg-white"
      style={{
        border: selected ? "2px solid #C026D3" : "1px solid #E5E7EB",
        boxShadow: selected ? "0 0 0 3px rgba(192,38,211,0.12)" : undefined,
      }}>
      <div className="absolute top-2 left-2 z-10 flex items-center justify-center"
        style={{
          width: 20, height: 20, borderRadius: 5,
          background: selected ? "#C026D3" : "rgba(255,255,255,0.9)",
          border: `2px solid ${selected ? "#C026D3" : "rgba(0,0,0,0.25)"}`,
        }}>
        {selected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
      </div>
      <div className="relative bg-gray-100" style={{ aspectRatio: "1/1" }}>
        {sel.imageUrl
          ? <Image src={sel.imageUrl} alt={sel.title} fill className="object-cover" sizes="180px" unoptimized />
          : <div className="absolute inset-0 flex items-center justify-center"><Package className="h-7 w-7 text-gray-300" /></div>}
      </div>
      <div className="p-2.5">
        <p className="text-[11px] font-semibold text-gray-900 leading-snug line-clamp-2">{sel.title}</p>
        <p className="text-[9px] text-gray-400 mt-1 truncate">
          {[sel.sourceDomain, sel.price].filter(Boolean).join(" · ") || sel.category || "Product"}
        </p>
        {/* Honest product evidence — separate line, with source tooltip. */}
        {meta && (
          <p className="text-[9px] text-gray-500 mt-0.5 truncate" title={metaTooltip}>{meta}</p>
        )}
      </div>
    </button>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────────
export function ProductOpportunityPicker({
  products, kwCatMap, onClose, onConfirm, confirmLabel = "Add Selected",
}: {
  products:   ProductIdea[];
  kwCatMap?:  Record<string, string>;
  onClose:    () => void;
  onConfirm:  (selections: PickerSelection[]) => void;
  confirmLabel?: string;
}) {
  const [tab,      setTab]      = useState<PickerTab>("opportunities");
  const [search,   setSearch]   = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [sort,     setSort]     = useState<"saves" | "price">("saves");
  const [catOpen,  setCatOpen]  = useState(false);
  const [selected, setSelected] = useState<Record<string, PickerSelection>>({});

  // Use a Link state
  const [linkUrl,   setLinkUrl]   = useState("");
  const [linkBusy,  setLinkBusy]  = useState(false);
  const [linkError, setLinkError] = useState("");

  const [myProducts, setMyProducts] = useState<AssetItem[]>(() => assetStore.getByRole("product"));
  useEffect(() => {
    const refresh = () => setMyProducts(assetStore.getByRole("product"));
    const unsub = assetStore.subscribe(refresh);
    refresh();
    return unsub;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fileRef = useRef<HTMLInputElement>(null);

  function toggle(sel: PickerSelection) {
    setSelected(prev => {
      const next = { ...prev };
      const k = keyOf(sel);
      if (next[k]) delete next[k]; else next[k] = sel;
      return next;
    });
  }

  // ── Product Opportunities (selectable) ──────────────────────────────────────
  const oppSelections = useMemo<{ sel: PickerSelection; meta: string; metaTooltip: string }[]>(() => {
    const catId = catFilter !== "All" ? catFilter : null;
    const q = search.trim().toLowerCase();
    let list = products.filter(p => !!p.image_url);
    if (q) list = list.filter(p =>
      cleanProductTitle(p.product_name).toLowerCase().includes(q) ||
      (p.seed_keyword ?? "").toLowerCase().includes(q) ||
      (p.domain ?? "").toLowerCase().includes(q));
    if (catId) list = list.filter(p => p.seed_keyword != null && kwCatMap?.[p.seed_keyword] === catId);
    // "Saves" sort (also the default) uses genuine product-Pin saves when present,
    // else source-Pin saves — consistent with the labelled evidence on each card.
    // No opportunity-label ranking: users judge from the visible evidence.
    const saveSortValue = (p: ProductIdea) => deriveProductSaveCount(p).value ?? -1;
    list = [...list].sort((a, b) =>
      sort === "price" ? ((b.price ?? 0) - (a.price ?? 0))
      : (saveSortValue(b) - saveSortValue(a)));
    return list.slice(0, 60).map(p => {
      const ev = productEvidence(p);
      return {
        sel: {
          id: p.id, imageUrl: p.image_url, title: cleanProductTitle(p.product_name),
          source: "product_ideas" as const, category: p.seed_keyword ?? undefined,
          productUrl: p.source_url ?? undefined, sourceDomain: p.domain ?? undefined,
          price: fmtPrice(p.price, p.currency) || undefined,
        },
        meta: ev.label,
        metaTooltip: ev.tooltip,
      };
    });
  }, [products, kwCatMap, catFilter, search, sort]);

  const myProductSelections = useMemo<PickerSelection[]>(() => {
    const q = search.trim().toLowerCase();
    return myProducts
      .filter(p => !q || (p.title ?? "").toLowerCase().includes(q) || (p.sourceDomain ?? "").toLowerCase().includes(q))
      .map(p => ({
        id: p.id, imageUrl: p.imageUrl, title: cleanProductTitle(p.title),
        source: "recent" as const, productUrl: p.productUrl ?? p.sourceUrl,
        sourceDomain: p.store ?? p.sourceDomain, price: p.price,
      }));
  }, [myProducts, search]);

  function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    const added: PickerSelection[] = [];
    Array.from(files).forEach(file => {
      const url = URL.createObjectURL(file);
      const title = cleanProductTitle(file.name.replace(/\.[a-z0-9]+$/i, ""));
      assetStore.saveAsset({ role: "product", source: "upload", imageUrl: url, title });
      added.push({ imageUrl: url, title, source: "uploaded" });
    });
    setSelected(prev => {
      const next = { ...prev };
      added.forEach(s => { next[keyOf(s)] = s; });
      return next;
    });
    toast.success(`${added.length} image${added.length !== 1 ? "s" : ""} added`);
  }

  async function handleLink() {
    const url = linkUrl.trim();
    if (!url) return;
    setLinkBusy(true); setLinkError("");
    try {
      const resp = await fetchProductUrlImport([url]);
      const r = resp.results[0];
      if (!r || r.status === "error" || r.status === "failed") {
        setLinkError(r?.error ?? "Could not extract product data from this URL.");
      } else {
        const top = [...(r.candidates ?? [])].sort((a, b) => b.score - a.score)[0];
        const imageUrl = top?.imageUrl ?? url;
        const title = cleanProductTitle(r.title || r.sourceDomain || url);
        const productUrl = r.normalizedUrl ?? r.originalUrl ?? url;
        const saved = assetStore.saveAsset({
          role: "product", source: "url", imageUrl, title, productUrl,
          sourceDomain: r.sourceDomain, store: r.sourceDomain,
        });
        const sel: PickerSelection = {
          id: saved.id, imageUrl, title, source: "url",
          productUrl, sourceDomain: r.sourceDomain ?? undefined,
        };
        setSelected(prev => ({ ...prev, [keyOf(sel)]: sel }));
        setLinkUrl("");
        toast.success("Product added from link");
      }
    } catch (e) {
      setLinkError(String(e));
    } finally {
      setLinkBusy(false);
    }
  }

  const selectedList = Object.values(selected);
  const TABS: { id: PickerTab; label: string; count?: number }[] = [
    { id: "my_products",   label: "My Products", count: myProducts.length },
    { id: "opportunities", label: "Product Opportunities" },
    { id: "upload",        label: "Upload Images" },
    { id: "link",          label: "Use a Link" },
  ];

  return (
    <>
      <div className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-x-0 bottom-0 z-[81] flex justify-center" data-testid="product-opportunity-picker">
        <div className="w-full max-w-[1040px] rounded-t-2xl bg-white border border-gray-200 shadow-2xl flex flex-col"
          style={{ maxHeight: "88vh" }} onClick={e => e.stopPropagation()}>

          {/* Header */}
          <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-gray-100 shrink-0">
            <div>
              <h2 className="text-[16px] font-black text-gray-900">Product Picker for Create Pins</h2>
              <p className="text-[12px] text-gray-500 mt-0.5">Choose products to include in your pin generation.</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1.5 px-6 pt-3 shrink-0 flex-wrap">
            {TABS.map(t => {
              const Icon = t.id === "my_products" ? Package : t.id === "opportunities" ? Search : t.id === "upload" ? Upload : Link2;
              const active = tab === t.id;
              return (
                <button key={t.id} type="button" onClick={() => setTab(t.id)}
                  className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors"
                  style={active
                    ? { background: "rgba(192,38,211,0.1)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.3)" }
                    : { background: "#F9FAFB", color: "#6B7280", border: "1px solid #E5E7EB" }}>
                  <Icon className="h-3.5 w-3.5" /> {t.label}
                  {t.count != null && t.count > 0 && <span className="opacity-60">({t.count})</span>}
                </button>
              );
            })}
          </div>

          {/* Sub-controls for product-grid tabs */}
          {(tab === "opportunities" || tab === "my_products") && (
            <div className="flex items-center gap-2 px-6 pt-3 shrink-0 flex-wrap">
              <div className="relative min-w-[200px] flex-1 max-w-[320px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products or niches..."
                  className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-4 py-2 text-[12px] text-gray-800 focus:border-[#C026D3] focus:outline-none placeholder:text-gray-400" />
              </div>
              {tab === "opportunities" && (
                <>
                  <div className="relative">
                    <button type="button" onClick={() => setCatOpen(o => !o)}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold bg-white border border-gray-200 text-gray-600">
                      Category: <span style={{ color: "#C026D3" }}>{catFilter === "All" ? "All" : (CATEGORIES.find(c => c.id === catFilter)?.label ?? catFilter)}</span>
                      <ChevronDown className="h-3 w-3" />
                    </button>
                    {catOpen && (
                      <>
                        <button type="button" aria-label="close" className="fixed inset-0 z-40" onClick={() => setCatOpen(false)} />
                        <div className="absolute left-0 top-full mt-1 z-50 rounded-xl bg-white border border-gray-200 shadow-lg max-h-[260px] overflow-y-auto" style={{ minWidth: 180 }}>
                          {["All", ...CATEGORIES.map(c => c.id)].map(c => (
                            <button key={c} type="button" onClick={() => { setCatFilter(c); setCatOpen(false); }}
                              className="w-full text-left px-4 py-2 text-[12px] hover:bg-gray-50"
                              style={{ color: catFilter === c ? "#C026D3" : "#6b7280" }}>
                              {c === "All" ? "All categories" : (CATEGORIES.find(x => x.id === c)?.label ?? c)}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <select value={sort} onChange={e => setSort(e.target.value as typeof sort)}
                    className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-600 cursor-pointer focus:outline-none">
                    <option value="saves">Sort: Saves</option>
                    <option value="price">Sort: Price</option>
                  </select>
                </>
              )}
            </div>
          )}

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {tab === "opportunities" && (
              oppSelections.length === 0 ? (
                <p className="text-center text-[13px] text-gray-400 py-16">No product opportunities match your search.</p>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {oppSelections.map(({ sel, meta, metaTooltip }) => (
                    <PickCard key={keyOf(sel)} sel={sel} meta={meta} metaTooltip={metaTooltip} selected={!!selected[keyOf(sel)]} onToggle={() => toggle(sel)} />
                  ))}
                </div>
              )
            )}

            {tab === "my_products" && (
              myProductSelections.length === 0 ? (
                <div className="text-center py-16">
                  <Package className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                  <p className="text-[13px] text-gray-400">No saved products yet. Add some from Product Opportunities, Upload, or a Link.</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {myProductSelections.map(sel => (
                    <PickCard key={keyOf(sel)} sel={sel} selected={!!selected[keyOf(sel)]} onToggle={() => toggle(sel)} />
                  ))}
                </div>
              )
            )}

            {tab === "upload" && (
              <div className="flex flex-col items-center justify-center py-12">
                <button type="button" onClick={() => fileRef.current?.click()}
                  className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-gray-300 px-12 py-10 hover:border-[#C026D3] transition-colors">
                  <Upload className="h-8 w-8 text-gray-400" />
                  <span className="text-[13px] font-semibold text-gray-600">Click to upload product images</span>
                  <span className="text-[11px] text-gray-400">PNG / JPG · added to your selection and saved to My Products</span>
                </button>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                  onChange={e => handleUpload(e.target.files)} />
              </div>
            )}

            {tab === "link" && (
              <div className="max-w-[460px] mx-auto py-8">
                <label className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 mb-2">
                  <Link2 className="h-3.5 w-3.5" /> Product URL
                </label>
                <div className="flex gap-2">
                  <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !linkBusy) handleLink(); }}
                    placeholder="https://example.com/product"
                    className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-800 focus:border-[#C026D3] focus:outline-none" />
                  <button type="button" onClick={handleLink} disabled={!linkUrl.trim() || linkBusy}
                    className="rounded-xl px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                    {linkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Fetch"}
                  </button>
                </div>
                {linkError && <p className="text-[11px] text-red-500 mt-2">{linkError}</p>}
                <p className="text-[11px] text-gray-400 mt-3">We&apos;ll extract the product image, title, and store from the link and add it to your selection.</p>
              </div>
            )}
          </div>

          {/* Footer — selection chips + CTA */}
          <div className="border-t border-gray-100 px-6 py-3.5 shrink-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[13px] font-bold text-gray-900 shrink-0" data-testid="picker-selected-count">
                {selectedList.length} product{selectedList.length !== 1 ? "s" : ""} selected
              </span>
              <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
                {selectedList.slice(0, 6).map(s => (
                  <span key={keyOf(s)} className="inline-flex items-center gap-1 rounded-full pl-2.5 pr-1.5 py-1 text-[11px] font-semibold"
                    style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.2)" }}>
                    {s.title.length > 22 ? s.title.slice(0, 22) + "…" : s.title}
                    <button type="button" onClick={() => toggle(s)} className="hover:opacity-70"><X className="h-3 w-3" /></button>
                  </span>
                ))}
                {selectedList.length > 6 && <span className="text-[11px] text-gray-400">+{selectedList.length - 6} more</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-auto">
                <button type="button" onClick={onClose}
                  className="rounded-full px-4 py-2 text-[12px] font-semibold text-gray-500 border border-gray-200 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button type="button" disabled={selectedList.length === 0}
                  data-testid="picker-add-selected"
                  onClick={() => { onConfirm(selectedList); }}
                  className="rounded-full px-5 py-2 text-[12px] font-bold text-white disabled:opacity-50 transition-opacity"
                  style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                  {confirmLabel} ({selectedList.length}){confirmLabel === "Add Selected" ? " to Create Pins" : ""}
                </button>
              </div>
            </div>
            <p className="text-[10px] text-gray-400 mt-2">Selected products are saved to My Products for future use.</p>
          </div>
        </div>
      </div>
    </>
  );
}
