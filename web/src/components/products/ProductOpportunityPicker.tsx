"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { X, Search, Package, Link2, Upload, Loader2, ChevronDown } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import * as assetStore from "@/lib/assetStore";
import type { AssetItem } from "@/lib/assetStore";
import { type ProductIdea } from "@/lib/productIdeas";
import { cleanProductTitle } from "@/lib/productTitle";
import { CATEGORIES } from "@/lib/categories";
import { fetchProductUrlImport } from "@/lib/productUrlImportClient";
import { deriveProductSaveCount } from "@/lib/productOpportunityCounts";
import { uploadPinImage } from "@/lib/studio/uploadPinImage";
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

/** Read a File into a persistent data: URL (survives refresh, unlike a blob: URL). */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Build an HONEST product-evidence label. Pinterest exposes a genuine save count
// only for a product's own Pin; otherwise the only number available is the source
// "Shop the look" Pin's saves, which is NOT a product metric and is labelled as
// such. Clicks / outbound clicks / impressions are not exposed by Pinterest to
// third-party viewers, so they are never shown (not as 0, not as "—").
// tr is threaded in (this is a pure module-level helper, not a component/hook).
function productEvidence(p: ProductIdea, tr: (key: MessageKey) => string): { label: string; tooltip: string } {
  const m = p.product_metrics;
  if (m && m.primarySaveKind === "product_pin" && m.aggregateProductPinSaves != null) {
    if (m.uniqueProductPinCount > 1) {
      return {
        label: tr("products.evidence.savesAcrossPins").replace("{saves}", fmt(m.aggregateProductPinSaves)).replace("{n}", String(m.uniqueProductPinCount)),
        tooltip: tr("products.evidence.savesAcrossPinsTooltip").replace("{n}", String(m.uniqueProductPinCount)).replace("{identity}", m.dedupIdentity),
      };
    }
    return {
      label: tr("products.evidence.savesOnProductPin").replace("{saves}", fmt(m.productPinSaveCount ?? m.aggregateProductPinSaves)),
      tooltip: tr("products.evidence.savesOnProductPinTooltip"),
    };
  }
  // Fallback: only source-Pin saves exist — explicitly a source metric.
  const savesText = fmt(m?.sourcePinSaveCount ?? p.source_pin_save_count);
  const label = m && m.productSourcePinCount > 1
    ? tr("products.evidence.savesOnSourcePinWithSources").replace("{saves}", savesText).replace("{n}", String(m.productSourcePinCount))
    : tr("products.evidence.savesOnSourcePin").replace("{saves}", savesText);
  return {
    label,
    tooltip: tr("products.evidence.savesOnSourcePinTooltip"),
  };
}

// ── Selectable card ────────────────────────────────────────────────────────────
function PickCard({ sel, selected, meta, metaTooltip, onToggle }: {
  sel: PickerSelection; selected: boolean; meta?: string; metaTooltip?: string;
  onToggle: () => void;
}) {
  const { t: tr } = useLocale();
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
          {[sel.sourceDomain, sel.price].filter(Boolean).join(" · ") || sel.category || tr("products.picker.defaultProductLabel")}
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
  products, kwCatMap, onClose, onConfirm, confirmLabel,
}: {
  products:   ProductIdea[];
  kwCatMap?:  Record<string, string>;
  onClose:    () => void;
  onConfirm:  (selections: PickerSelection[]) => void;
  confirmLabel?: string;
}) {
  const { t: tr } = useLocale();
  const isDefaultConfirmLabel = confirmLabel == null;
  const resolvedConfirmLabel = confirmLabel ?? tr("products.picker.addSelected");
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
      const ev = productEvidence(p, tr);
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
  }, [products, kwCatMap, catFilter, search, sort, tr]);

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

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    const added: PickerSelection[] = [];
    for (const file of Array.from(files)) {
      const title = cleanProductTitle(file.name.replace(/\.[a-z0-9]+$/i, ""));
      // Externalize to a stable hosted URL. Fall back to a data: URL on failure (NOT
      // a blob: URL, which dies on refresh and can never sync) — the media-offload
      // sweep externalizes it later, matching InlineCreateAssetPicker.
      let imageUrl: string;
      try {
        imageUrl = (await uploadPinImage(file)).publicUrl;
      } catch {
        imageUrl = await readFileAsDataUrl(file);
      }
      const saved = assetStore.saveAsset({ role: "product", source: "upload", imageUrl, title });
      added.push({ id: saved.id, imageUrl, title, source: "uploaded" });
    }
    setSelected(prev => {
      const next = { ...prev };
      added.forEach(s => { next[keyOf(s)] = s; });
      return next;
    });
    toast.success(tr("products.picker.imagesAdded").replace("{n}", String(added.length)).replace("{plural}", added.length !== 1 ? "s" : ""));
  }

  async function handleLink() {
    const url = linkUrl.trim();
    if (!url) return;
    setLinkBusy(true); setLinkError("");
    try {
      const resp = await fetchProductUrlImport([url]);
      const r = resp.results[0];
      if (!r || r.status === "error" || r.status === "failed") {
        setLinkError(r?.error ?? tr("products.picker.linkImportError"));
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
        toast.success(tr("products.picker.productAddedFromLink"));
      }
    } catch (e) {
      setLinkError(String(e));
    } finally {
      setLinkBusy(false);
    }
  }

  const selectedList = Object.values(selected);
  const TABS: { id: PickerTab; label: string; count?: number }[] = [
    { id: "my_products",   label: tr("products.picker.tabMyProducts"), count: myProducts.length },
    { id: "opportunities", label: tr("products.picker.tabOpportunities") },
    { id: "upload",        label: tr("products.picker.tabUpload") },
    { id: "link",          label: tr("products.picker.tabLink") },
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
              <h2 className="text-[16px] font-black text-gray-900">{tr("products.picker.title")}</h2>
              <p className="text-[12px] text-gray-500 mt-0.5">{tr("products.picker.subtitle")}</p>
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
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder={tr("products.picker.searchProducts")}
                  className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-4 py-2 text-[12px] text-gray-800 focus:border-[#C026D3] focus:outline-none placeholder:text-gray-400" />
              </div>
              {tab === "opportunities" && (
                <>
                  <div className="relative">
                    <button type="button" onClick={() => setCatOpen(o => !o)}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold bg-white border border-gray-200 text-gray-600">
                      {tr("products.picker.categoryPrefix")} <span style={{ color: "#C026D3" }}>{catFilter === "All" ? tr("products.picker.allCategories") : (CATEGORIES.find(c => c.id === catFilter)?.label ?? catFilter)}</span>
                      <ChevronDown className="h-3 w-3" />
                    </button>
                    {catOpen && (
                      <>
                        <button type="button" aria-label={tr("products.filters.closeAria")} className="fixed inset-0 z-40" onClick={() => setCatOpen(false)} />
                        <div className="absolute left-0 top-full mt-1 z-50 rounded-xl bg-white border border-gray-200 shadow-lg max-h-[260px] overflow-y-auto" style={{ minWidth: 180 }}>
                          {["All", ...CATEGORIES.map(c => c.id)].map(c => (
                            <button key={c} type="button" onClick={() => { setCatFilter(c); setCatOpen(false); }}
                              className="w-full text-left px-4 py-2 text-[12px] hover:bg-gray-50"
                              style={{ color: catFilter === c ? "#C026D3" : "#6b7280" }}>
                              {c === "All" ? tr("products.picker.allCategories") : (CATEGORIES.find(x => x.id === c)?.label ?? c)}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <select value={sort} onChange={e => setSort(e.target.value as typeof sort)}
                    className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-600 cursor-pointer focus:outline-none">
                    <option value="saves">{tr("products.picker.sortSaves")}</option>
                    <option value="price">{tr("products.picker.sortPrice")}</option>
                  </select>
                </>
              )}
            </div>
          )}

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {tab === "opportunities" && (
              oppSelections.length === 0 ? (
                <p className="text-center text-[13px] text-gray-400 py-16">{tr("products.picker.noOpportunities")}</p>
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
                  <p className="text-[13px] text-gray-400">{tr("products.picker.noSavedProducts")}</p>
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
                  <span className="text-[13px] font-semibold text-gray-600">{tr("products.picker.uploadCta")}</span>
                  <span className="text-[11px] text-gray-400">{tr("products.picker.uploadHint")}</span>
                </button>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                  onChange={e => { void handleUpload(e.target.files); }} />
              </div>
            )}

            {tab === "link" && (
              <div className="max-w-[460px] mx-auto py-8">
                <label className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 mb-2">
                  <Link2 className="h-3.5 w-3.5" /> {tr("products.picker.productUrlLabel")}
                </label>
                <div className="flex gap-2">
                  <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !linkBusy) handleLink(); }}
                    placeholder={tr("products.picker.linkPlaceholder")}
                    className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-800 focus:border-[#C026D3] focus:outline-none" />
                  <button type="button" onClick={handleLink} disabled={!linkUrl.trim() || linkBusy}
                    className="rounded-xl px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                    {linkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : tr("products.picker.fetch")}
                  </button>
                </div>
                {linkError && <p className="text-[11px] text-red-500 mt-2">{linkError}</p>}
                <p className="text-[11px] text-gray-400 mt-3">{tr("products.picker.linkHint")}</p>
              </div>
            )}
          </div>

          {/* Footer — selection chips + CTA */}
          <div className="border-t border-gray-100 px-6 py-3.5 shrink-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[13px] font-bold text-gray-900 shrink-0" data-testid="picker-selected-count">
                {tr("products.picker.selectedCount").replace("{n}", String(selectedList.length)).replace("{plural}", selectedList.length !== 1 ? "s" : "")}
              </span>
              <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
                {selectedList.slice(0, 6).map(s => (
                  <span key={keyOf(s)} className="inline-flex items-center gap-1 rounded-full pl-2.5 pr-1.5 py-1 text-[11px] font-semibold"
                    style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3", border: "1px solid rgba(192,38,211,0.2)" }}>
                    {s.title.length > 22 ? s.title.slice(0, 22) + "…" : s.title}
                    <button type="button" onClick={() => toggle(s)} className="hover:opacity-70"><X className="h-3 w-3" /></button>
                  </span>
                ))}
                {selectedList.length > 6 && <span className="text-[11px] text-gray-400">{tr("products.picker.moreCount").replace("{n}", String(selectedList.length - 6))}</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-auto">
                <button type="button" onClick={onClose}
                  className="rounded-full px-4 py-2 text-[12px] font-semibold text-gray-500 border border-gray-200 hover:bg-gray-50 transition-colors">
                  {tr("products.picker.cancel")}
                </button>
                <button type="button" disabled={selectedList.length === 0}
                  data-testid="picker-add-selected"
                  onClick={() => { onConfirm(selectedList); }}
                  className="rounded-full px-5 py-2 text-[12px] font-bold text-white disabled:opacity-50 transition-opacity"
                  style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                  {resolvedConfirmLabel} ({selectedList.length}){isDefaultConfirmLabel ? tr("products.picker.addSelectedToCreatePins") : ""}
                </button>
              </div>
            </div>
            <p className="text-[10px] text-gray-400 mt-2">{tr("products.picker.footerHint")}</p>
          </div>
        </div>
      </div>
    </>
  );
}
