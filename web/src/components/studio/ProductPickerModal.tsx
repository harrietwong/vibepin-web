"use client";

import React, { useEffect, useState } from "react";
import { X, Search, Package, Link2, Plus, ArrowLeft, Loader2 } from "lucide-react";
import * as assetStore from "@/lib/assetStore";
import type { AssetItem } from "@/lib/assetStore";
import {
  fetchProductUrlImport,
  reasonLabel,
} from "@/lib/productUrlImportClient";
import type { ProductUrlImportApiResponse } from "@/lib/productUrlImportClient";

type FetchedResult = ProductUrlImportApiResponse["results"][0];

const UI = {
  card:      "var(--app-surface, #161D2E)",
  cardElev:  "var(--app-surface-3, #1A2236)",
  bg:        "var(--app-bg, #0B0E17)",
  bg2:       "var(--app-surface-2, #111827)",
  border:    "var(--app-border, rgba(255,255,255,0.09))",
  borderStr: "var(--app-border-hi, rgba(255,255,255,0.12))",
  text:      "var(--app-text, #E2E8F0)",
  textSec:   "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #64748B)",
  purple:    "#7C3AED",
  success:   "#10B981",
  warning:   "#F59E0B",
  error:     "#EF4444",
  gradient:  "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
} as const;

// ── Public types ───────────────────────────────────────────────────────────────

export type ProductSelection = {
  id?:           string;
  title:         string;
  imageUrl?:     string;
  url?:          string;
  canonicalUrl?: string;
  store?:        string;
  price?:        string;
  currency?:     string;
  source:        string;
  /** Whether this product should become the Pin's Primary product. */
  asPrimary:     boolean;
  /** Whether a reusable product record was saved to My Products. */
  saveToLibrary: boolean;
};

export type RecommendedProduct = {
  id?:           string;
  title:         string;
  imageUrl?:     string;
  url?:          string;
  source:        string;
  isAutoLinked?: boolean;
  isMostRelevant?: boolean;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function sourceBadge(source: string): { label: string; bg: string; color: string } {
  if (source === "url" || source === "url_imported")
    return { label: "URL Imported",  bg: "rgba(99,102,241,0.18)",  color: "#A5B4FC" };
  if (source === "product_signal" || source === "product_ideas")
    return { label: "Product Ideas", bg: "rgba(16,185,129,0.15)",  color: "#6EE7B7" };
  return   { label: "My Products",   bg: "rgba(124,58,237,0.18)",  color: "#C4B5FD" };
}

function truncateUrl(url: string, len = 40): string {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname).slice(0, len);
  } catch { return url.slice(0, len); }
}

type PickerTab = "recommended" | "my_products" | "use_link" | "create";
type LinkStep  = "input" | "fetching" | "review";

// ── Sub-components ─────────────────────────────────────────────────────────────

function ProductThumb({ src, size = 40 }: { src?: string; size?: number }) {
  const [err, setErr] = useState(false);
  const dim = { width: size, height: size };
  return err || !src ? (
    <div style={{ ...dim, borderRadius: 6, background: UI.card, border: `1px solid ${UI.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <Package style={{ width: size * 0.45, height: size * 0.45, color: UI.textMuted }} />
    </div>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" onError={() => setErr(true)}
      style={{ ...dim, borderRadius: 6, objectFit: "cover", flexShrink: 0, border: `1px solid ${UI.border}` }} />
  );
}

function SourceChip({ source }: { source: string }) {
  const b = sourceBadge(source);
  return (
    <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: b.bg, color: b.color, display: "inline-block", flexShrink: 0 }}>
      {b.label}
    </span>
  );
}

// ── Candidate image card ───────────────────────────────────────────────────────

function CandidateCard({
  candidate, selected, onSelect,
}: {
  candidate: NonNullable<FetchedResult["candidates"]>[number];
  selected:  boolean;
  onSelect:  () => void;
}) {
  const [imgErr, setImgErr] = useState(false);
  const label = reasonLabel(candidate.reason);
  const isMain = candidate.reason === "og_image" || candidate.reason === "twitter_image"
               || candidate.reason === "shopify_product_json" || candidate.reason === "jsonld_product_image";
  return (
    <button type="button" onClick={onSelect}
      style={{
        border: `2px solid ${selected ? UI.purple : UI.border}`,
        borderRadius: 10, background: selected ? "rgba(124,58,237,0.10)" : UI.card,
        cursor: "pointer", padding: 0, overflow: "hidden", textAlign: "left" as const,
        outline: "none", position: "relative", transition: "border-color 0.12s",
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = UI.borderStr; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.borderColor = UI.border; }}
    >
      {/* Selection ring */}
      {selected && (
        <div style={{ position: "absolute", top: 6, right: 6, zIndex: 2, width: 18, height: 18, borderRadius: "50%", background: UI.gradient, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 800 }}>✓</div>
      )}
      {isMain && !selected && (
        <div style={{ position: "absolute", top: 6, left: 6, zIndex: 2, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,0.85)", fontSize: 8, fontWeight: 800, color: "#fff" }}>
          Main image
        </div>
      )}
      <div style={{ aspectRatio: "1/1", background: "var(--app-surface-3, #0B1020)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {imgErr ? (
          <Package style={{ width: 32, height: 32, color: UI.textMuted }} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={candidate.imageUrl} alt="" onError={() => setImgErr(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        )}
      </div>
      <div style={{ padding: "5px 7px" }}>
        <p style={{ margin: 0, fontSize: 9, color: UI.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </p>
        {candidate.width && candidate.height && (
          <p style={{ margin: "1px 0 0", fontSize: 8, color: UI.textMuted }}>{candidate.width}×{candidate.height}</p>
        )}
      </div>
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ProductPickerModal({
  title    = "Add product",
  subtitle = "Link a product to this Pin",
  bulkCount,
  recommendedProducts,
  hasPrimary = false,
  onSelect,
  onClose,
}: {
  title?:               string;
  subtitle?:            string;
  bulkCount?:           number;
  recommendedProducts?: RecommendedProduct[];
  /** Whether the Pin already has a Primary product (affects the default link mode). */
  hasPrimary?:          boolean;
  onSelect:             (p: ProductSelection) => void;
  onClose:              () => void;
}) {
  const hasRecommended = (recommendedProducts?.length ?? 0) > 0;

  // Link mode: a new product becomes Primary by default only when none exists yet.
  const [makePrimary,   setMakePrimary]   = useState<boolean>(!hasPrimary);
  const [saveToLibrary, setSaveToLibrary] = useState<boolean>(true);

  const [tab,              setTab]              = useState<PickerTab>(hasRecommended ? "recommended" : "my_products");
  const [search,           setSearch]           = useState("");

  // Use a Link state
  const [linkUrl,          setLinkUrl]          = useState("");
  const [linkStep,         setLinkStep]         = useState<LinkStep>("input");
  const [fetchError,       setFetchError]       = useState("");
  const [fetchedResult,    setFetchedResult]    = useState<FetchedResult | null>(null);
  const [selectedCandId,   setSelectedCandId]   = useState<string | null>(null);

  // Create manually state
  const [createTitle, setCreateTitle] = useState("");
  const [createUrl,   setCreateUrl]   = useState("");
  const [createImg,   setCreateImg]   = useState("");

  // Asset list (subscription)
  const [allProducts,    setAllProducts]    = useState<AssetItem[]>(() => assetStore.getByRole("product") as AssetItem[]);
  const [recentProducts, setRecentProducts] = useState<AssetItem[]>(() => assetStore.getRecentProducts(5) as AssetItem[]);

  useEffect(() => {
    const refresh = () => {
      setAllProducts(assetStore.getByRole("product") as AssetItem[]);
      setRecentProducts(assetStore.getRecentProducts(5) as AssetItem[]);
    };
    const unsub = assetStore.subscribe(refresh);
    refresh();
    return unsub;
  }, []);

  // Reset link state when switching to/from use_link tab
  useEffect(() => {
    if (tab !== "use_link") {
      /* eslint-disable react-hooks/set-state-in-effect */
      setLinkStep("input");
      setFetchError("");
      setFetchedResult(null);
      setSelectedCandId(null);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [tab]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (linkStep === "review") { setLinkStep("input"); }
        else { onClose(); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, linkStep]);

  // ── Asset list derived ────────────────────────────────────────────────────

  const filtered = allProducts.filter(p =>
    !search.trim() ||
    (p.title ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (p.productUrl ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (p.sourceDomain ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const recPinIds = new Set((recommendedProducts ?? []).map(r => r.id).filter(Boolean));
  const recentsForDisplay = recentProducts.filter(p => !recPinIds.has(p.id)).slice(0, 4);

  // ── Actions ───────────────────────────────────────────────────────────────

  function selectFromAsset(p: AssetItem) {
    assetStore.markUsed(p.id);
    onSelect({
      id: p.id, title: p.title ?? "", imageUrl: p.imageUrl,
      url: p.productUrl ?? p.sourceUrl, canonicalUrl: p.canonicalUrl,
      store: p.store ?? p.sourceDomain, price: p.price, currency: p.currency,
      source: p.source, asPrimary: makePrimary, saveToLibrary: true,
    });
  }

  function selectRecommended(r: RecommendedProduct) {
    if (r.id) assetStore.markUsed(r.id);
    onSelect({ id: r.id, title: r.title, imageUrl: r.imageUrl, url: r.url, source: r.source, asPrimary: makePrimary, saveToLibrary: true });
  }

  async function handleFetchProduct() {
    const url = linkUrl.trim();
    if (!url) return;
    setLinkStep("fetching");
    setFetchError("");
    try {
      const resp = await fetchProductUrlImport([url]);
      const result = resp.results[0];
      if (!result || result.status === "error" || result.status === "failed") {
        setFetchError(result?.error ?? "Could not extract product data from this URL.");
        setLinkStep("input");
      } else {
        setFetchedResult(result);
        // Auto-select top-scored candidate
        const sorted = [...(result.candidates ?? [])].sort((a, b) => b.score - a.score);
        setSelectedCandId(sorted[0]?.id ?? null);
        setLinkStep("review");
      }
    } catch (e) {
      setFetchError(String(e));
      setLinkStep("input");
    }
  }

  function handleUseFetchedProduct() {
    if (!fetchedResult) return;
    const candidates = fetchedResult.candidates ?? [];
    const chosen = candidates.find(c => c.id === selectedCandId) ?? candidates[0];
    const imageUrl = chosen?.imageUrl ?? linkUrl.trim();
    const productTitle = fetchedResult.title || fetchedResult.sourceDomain || linkUrl.trim();
    const url = fetchedResult.normalizedUrl ?? fetchedResult.originalUrl ?? linkUrl.trim();
    const status: "ready" | "import_issue" = fetchedResult.status === "success" ? "ready" : "import_issue";

    let savedId: string | undefined;
    if (saveToLibrary) {
      const saved = assetStore.saveAsset({
        role:        "product",
        source:      "url",
        imageUrl,
        title:       productTitle,
        productUrl:  url,
        sourceDomain: fetchedResult.sourceDomain,
        store:       fetchedResult.sourceDomain,
        allImages:   candidates.map(c => c.imageUrl),
        status,
      });
      savedId = saved.id;
    }
    onSelect({
      id: savedId, title: productTitle, imageUrl, url,
      store: fetchedResult.sourceDomain, source: "url",
      asPrimary: makePrimary, saveToLibrary,
    });
  }

  function handleCreate() {
    const t = createTitle.trim();
    if (!t) return;
    const u = createUrl.trim() || undefined;
    const imgUrl = createImg.trim() || u || ("manual-" + Date.now());
    let savedId: string | undefined;
    if (saveToLibrary) {
      const saved = assetStore.saveAsset({ role: "product", source: "upload", imageUrl: imgUrl, title: t, productUrl: u });
      savedId = saved.id;
    }
    onSelect({ id: savedId, title: t, imageUrl: createImg.trim() || undefined, url: u, source: "manual", asPrimary: makePrimary, saveToLibrary });
  }

  // ── CTA label (changes for bulk) ─────────────────────────────────────────

  const ctaLabel = bulkCount != null && bulkCount > 1
    ? (makePrimary ? `Set primary for ${bulkCount} Pins` : `Tag on ${bulkCount} Pins`)
    : (makePrimary ? "Use as Primary Product" : "Add as Tagged Product");

  // ── Tab list ─────────────────────────────────────────────────────────────

  const TABS: { id: PickerTab; label: string; count?: number }[] = [
    ...(hasRecommended ? [{ id: "recommended" as const, label: "Recommended", count: recommendedProducts!.length }] : []),
    { id: "my_products", label: "Search products" },
    { id: "use_link",    label: "Use a link" },
    { id: "create",      label: "Create manually" },
  ];

  const field: React.CSSProperties = {
    width: "100%", boxSizing: "border-box" as const, padding: "8px 10px", borderRadius: 8,
    border: `1px solid ${UI.borderStr}`, fontSize: 11, color: UI.text,
    background: "var(--app-surface-2, #0D1423)", outline: "none",
  };

  const actionBtn: React.CSSProperties = {
    padding: "6px 12px", borderRadius: 7, border: `1px solid ${UI.borderStr}`,
    background: UI.cardElev, color: UI.text, fontSize: 11, fontWeight: 700, cursor: "pointer",
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 498 }} />

      {/* Modal */}
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        zIndex: 499, width: 560, maxWidth: "94vw", maxHeight: "86vh",
        background: UI.bg2, borderRadius: 14, border: `1px solid ${UI.borderStr}`,
        boxShadow: "0 24px 60px rgba(0,0,0,0.8)", display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "16px 20px 10px", borderBottom: `1px solid ${UI.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: UI.text }}>{title}</h3>
              <p style={{ margin: "3px 0 0", fontSize: 11, color: UI.textMuted }}>{subtitle}</p>
            </div>
            <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: UI.textMuted, padding: 4, marginTop: -2 }}>
              <X style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: `1px solid ${UI.border}`, padding: "0 20px", flexShrink: 0, overflowX: "auto" }}>
          {TABS.map(t => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              style={{
                padding: "10px 12px", fontSize: 11, fontWeight: 700, border: "none",
                background: "none", cursor: "pointer", marginBottom: -1, whiteSpace: "nowrap",
                color: tab === t.id ? UI.text : UI.textMuted,
                borderBottom: tab === t.id ? `2px solid ${UI.purple}` : "2px solid transparent",
                display: "flex", alignItems: "center", gap: 5,
              }}>
              {t.label}
              {t.count != null && (
                <span style={{ fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 10, background: "rgba(124,58,237,0.2)", color: "#C4B5FD" }}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Link-mode bar — Primary vs Tagged + (for new records) Save to My Products */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 20px", borderBottom: `1px solid ${UI.border}`, flexShrink: 0, background: "var(--app-surface-2, #0D1423)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: UI.textMuted, flexShrink: 0 }}>Link as</span>
            <div style={{ display: "flex", border: `1px solid ${UI.borderStr}`, borderRadius: 7, overflow: "hidden", flexShrink: 0 }}>
              {([["Primary", true], ["Tagged", false]] as const).map(([label, val]) => (
                <button key={label} type="button" onClick={() => setMakePrimary(val)}
                  style={{
                    padding: "4px 11px", border: "none", cursor: "pointer", fontSize: 10, fontWeight: 700,
                    background: makePrimary === val ? UI.gradient : "transparent",
                    color: makePrimary === val ? "#fff" : UI.textSec,
                  }}>
                  {label}
                </button>
              ))}
            </div>
            {!hasPrimary && !makePrimary && (
              <span style={{ fontSize: 9, color: UI.warning }}>No primary set yet</span>
            )}
          </div>
          {(tab === "use_link" || tab === "create") && (
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: UI.textSec, cursor: "pointer", flexShrink: 0 }}>
              <input type="checkbox" checked={saveToLibrary} onChange={e => setSaveToLibrary(e.target.checked)} style={{ accentColor: UI.purple, cursor: "pointer" }} />
              Save to My Products
            </label>
          )}
        </div>

        {/* ── RECOMMENDED tab ─────────────────────────────────────────────────── */}
        {tab === "recommended" && hasRecommended && (
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 16px" }}>
              <div style={{ marginBottom: 16 }}>
                <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 800, color: UI.text }}>Recommended for this Pin</p>
                <p style={{ margin: "0 0 10px", fontSize: 10, color: UI.textMuted }}>Based on selected product images and recent activity.</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                  {recommendedProducts!.map((r, i) => (
                    <button key={r.id ?? i} type="button" onClick={() => selectRecommended(r)}
                      style={{ border: `1px solid ${UI.border}`, borderRadius: 10, background: UI.card, cursor: "pointer", padding: 0, overflow: "hidden", textAlign: "left" as const, position: "relative" }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = UI.borderStr)}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = UI.border)}
                    >
                      {r.isMostRelevant && (
                        <div style={{ position: "absolute", top: 6, left: 6, zIndex: 1, padding: "2px 6px", borderRadius: 4, background: "rgba(124,58,237,0.85)", fontSize: 8, fontWeight: 800, color: "#fff" }}>Most relevant</div>
                      )}
                      <div style={{ aspectRatio: "1/1", background: "var(--app-surface-3, #0B1020)", overflow: "hidden" }}>
                        <ProductThumb src={r.imageUrl} size={160} />
                      </div>
                      <div style={{ padding: "8px 10px" }}>
                        <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 700, color: UI.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title || "Product"}</p>
                        <SourceChip source={r.source} />
                        {r.url && <p style={{ margin: "3px 0 0", fontSize: 9, color: UI.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{truncateUrl(r.url)}</p>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              {recentsForDisplay.length > 0 && (
                <>
                  <div style={{ height: 1, background: UI.border, margin: "0 0 12px" }} />
                  <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 800, color: UI.text }}>Recently used</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {recentsForDisplay.map(p => (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.card }}>
                        <ProductThumb src={p.imageUrl} size={36} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: UI.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.title || "Product"}</p>
                          <SourceChip source={p.source} />
                        </div>
                        <button type="button" onClick={() => selectFromAsset(p)} style={{ ...actionBtn, flexShrink: 0 }}>Select</button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div style={{ padding: "10px 20px", borderTop: `1px solid ${UI.border}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", background: UI.card }}>
              <p style={{ margin: 0, fontSize: 10, color: UI.textMuted }}>
                Need another?{" "}
                <button type="button" onClick={() => setTab("use_link")} style={{ background: "none", border: "none", cursor: "pointer", color: "#818CF8", fontSize: 10, padding: 0 }}>Use a link</button>
                {" "}or{" "}
                <button type="button" onClick={() => setTab("my_products")} style={{ background: "none", border: "none", cursor: "pointer", color: "#818CF8", fontSize: 10, padding: 0 }}>search My Products</button>.
              </p>
              <button type="button" onClick={onClose} style={{ ...actionBtn, color: UI.textSec }}>Cancel</button>
            </div>
          </div>
        )}

        {/* ── MY PRODUCTS tab ─────────────────────────────────────────────────── */}
        {tab === "my_products" && (
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px 20px 8px", flexShrink: 0, position: "relative" }}>
              <Search style={{ position: "absolute", left: 31, top: "50%", transform: "translateY(-50%)", width: 13, height: 13, color: UI.textMuted, pointerEvents: "none" }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by title, URL, or store…"
                style={{ ...field, paddingLeft: 32 }} />
            </div>
            {filtered.length === 0 ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", gap: 10 }}>
                <Package style={{ width: 32, height: 32, color: UI.textMuted }} />
                <p style={{ margin: 0, fontSize: 12, color: UI.textMuted, textAlign: "center" }}>
                  {allProducts.length === 0 ? "No saved products yet." : "No products match your search."}
                </p>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" onClick={() => setTab("use_link")} style={actionBtn}>Use a link</button>
                  <button type="button" onClick={() => setTab("create")} style={actionBtn}>Create manually</button>
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, overflowY: "auto", padding: "4px 20px 16px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {filtered.map(p => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.card }}>
                      <ProductThumb src={p.imageUrl} size={44} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 700, color: UI.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {p.title || "Product"}
                        </p>
                        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                          <SourceChip source={p.source} />
                          {p.sourceDomain && <span style={{ fontSize: 9, color: UI.textMuted }}>{p.sourceDomain}</span>}
                          {p.price && <span style={{ fontSize: 9, color: UI.textMuted }}>{p.currency ?? ""}{p.price}</span>}
                        </div>
                        {p.productUrl && (
                          <p style={{ margin: "2px 0 0", fontSize: 9, color: UI.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {truncateUrl(p.productUrl)}
                          </p>
                        )}
                      </div>
                      <button type="button" onClick={() => selectFromAsset(p)}
                        style={{ ...actionBtn, flexShrink: 0, padding: "5px 14px", background: UI.gradient, border: "none", color: "#fff" }}>
                        Select
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── USE A LINK tab ──────────────────────────────────────────────────── */}
        {tab === "use_link" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* STEP 1 — Input */}
            {(linkStep === "input" || linkStep === "fetching") && (
              <div style={{ flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <Link2 style={{ width: 13, height: 13, color: UI.textMuted }} />
                    <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Product URL</label>
                  </div>
                  <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
                    placeholder="https://example.com/product"
                    style={field}
                    disabled={linkStep === "fetching"}
                    onKeyDown={e => { if (e.key === "Enter" && linkUrl.trim() && linkStep === "input") handleFetchProduct(); }}
                  />
                </div>

                {fetchError && (
                  <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)" }}>
                    <p style={{ margin: 0, fontSize: 10, color: "#FCA5A5" }}>{fetchError}</p>
                  </div>
                )}

                <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)" }}>
                  <p style={{ margin: 0, fontSize: 10, color: "#A5B4FC", lineHeight: 1.5 }}>
                    We&apos;ll extract product images, title, price, and store from this link.
                  </p>
                </div>

                <button type="button" onClick={handleFetchProduct}
                  disabled={!linkUrl.trim() || linkStep === "fetching"}
                  style={{
                    padding: "10px 16px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 700,
                    background: (!linkUrl.trim() || linkStep === "fetching") ? UI.cardElev : UI.gradient,
                    color: (!linkUrl.trim() || linkStep === "fetching") ? UI.textMuted : "#fff",
                    cursor: (!linkUrl.trim() || linkStep === "fetching") ? "not-allowed" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                  }}>
                  {linkStep === "fetching" ? (
                    <><Loader2 style={{ width: 14, height: 14, animation: "spin 0.8s linear infinite" }} /> Fetching product…</>
                  ) : (
                    "Fetch product"
                  )}
                </button>
              </div>
            )}

            {/* STEP 2 — Review */}
            {linkStep === "review" && fetchedResult && (() => {
              const candidates = [...(fetchedResult.candidates ?? [])].sort((a, b) => b.score - a.score);
              const chosen = candidates.find(c => c.id === selectedCandId) ?? candidates[0];
              const productTitle = fetchedResult.title || fetchedResult.sourceDomain || linkUrl;
              const productUrl   = fetchedResult.normalizedUrl ?? fetchedResult.originalUrl ?? linkUrl;

              return (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  {/* Back button */}
                  <div style={{ padding: "8px 20px", borderBottom: `1px solid ${UI.border}`, flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
                    <button type="button" onClick={() => { setLinkStep("input"); setFetchedResult(null); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: UI.textMuted, display: "flex", alignItems: "center", gap: 4, fontSize: 10, padding: 0 }}>
                      <ArrowLeft style={{ width: 12, height: 12 }} /> Back
                    </button>
                    <span style={{ fontSize: 10, color: UI.textMuted }}>·</span>
                    {fetchedResult.status === "success" ? (
                      <span style={{ fontSize: 10, fontWeight: 700, color: UI.success }}>Extracted successfully</span>
                    ) : (
                      <span style={{ fontSize: 10, fontWeight: 700, color: UI.warning }}>Partial data — some fields missing</span>
                    )}
                  </div>

                  <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
                    {/* Product info card */}
                    <div style={{ borderRadius: 10, border: `1px solid ${UI.border}`, background: UI.card, padding: "12px 14px" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <div style={{ width: 52, height: 52, borderRadius: 8, overflow: "hidden", flexShrink: 0, border: `1px solid ${UI.border}` }}>
                          {chosen ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={chosen.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          ) : (
                            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: UI.bg2 }}>
                              <Package style={{ width: 22, height: 22, color: UI.textMuted }} />
                            </div>
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: "0 0 3px", fontSize: 12, fontWeight: 800, color: UI.text, lineHeight: 1.3 }}>
                            {productTitle}
                          </p>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 3 }}>
                            <SourceChip source="url" />
                            {fetchedResult.sourceDomain && (
                              <span style={{ fontSize: 9, color: UI.textMuted }}>{fetchedResult.sourceDomain}</span>
                            )}
                          </div>
                          <p style={{ margin: 0, fontSize: 9, color: UI.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {truncateUrl(productUrl, 52)}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Image picker */}
                    {candidates.length > 0 && (
                      <div>
                        <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 800, color: UI.text }}>
                          Choose product image
                          <span style={{ fontSize: 10, fontWeight: 400, color: UI.textMuted, marginLeft: 6 }}>
                            {candidates.length} image{candidates.length !== 1 ? "s" : ""} found
                          </span>
                        </p>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7 }}>
                          {candidates.map(c => (
                            <CandidateCard key={c.id} candidate={c}
                              selected={selectedCandId === c.id}
                              onSelect={() => setSelectedCandId(c.id)} />
                          ))}
                        </div>
                        {candidates.length === 1 && (
                          <p style={{ margin: "6px 0 0", fontSize: 9, color: UI.textMuted }}>Only one image was found at this URL.</p>
                        )}
                      </div>
                    )}

                    {candidates.length === 0 && (
                      <div style={{ padding: "12px", borderRadius: 8, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)" }}>
                        <p style={{ margin: 0, fontSize: 10, color: "#FCD34D" }}>No product images found. The product record will be saved without an image thumbnail.</p>
                      </div>
                    )}
                  </div>

                  {/* Footer CTA */}
                  <div style={{ padding: "12px 20px", borderTop: `1px solid ${UI.border}`, flexShrink: 0, background: UI.card, display: "flex", gap: 8, alignItems: "center" }}>
                    <button type="button" onClick={handleUseFetchedProduct}
                      style={{ flex: 1, padding: "10px 16px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 800, background: UI.gradient, color: "#fff", cursor: "pointer" }}>
                      {ctaLabel}
                    </button>
                    <button type="button" onClick={onClose}
                      style={{ ...actionBtn, color: UI.textSec, flexShrink: 0 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── CREATE MANUALLY tab ─────────────────────────────────────────────── */}
        {tab === "create" && (
          <div style={{ flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
            <div>
              <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec, display: "block", marginBottom: 5 }}>
                Product title <span style={{ color: UI.error, marginLeft: 2 }}>*</span>
              </label>
              <input value={createTitle} onChange={e => setCreateTitle(e.target.value)}
                placeholder="e.g. Rattan Hanging Chair"
                style={field}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec, display: "block", marginBottom: 5 }}>
                Product URL <span style={{ color: UI.textMuted, fontWeight: 400 }}>(optional)</span>
              </label>
              <input value={createUrl} onChange={e => setCreateUrl(e.target.value)}
                placeholder="https://…" style={field}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec, display: "block", marginBottom: 5 }}>
                Image URL <span style={{ color: UI.textMuted, fontWeight: 400 }}>(optional)</span>
              </label>
              <input value={createImg} onChange={e => setCreateImg(e.target.value)}
                placeholder="https://…/image.jpg" style={field}
              />
            </div>
            <button type="button" onClick={handleCreate} disabled={!createTitle.trim()}
              style={{
                padding: "10px 16px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 700,
                background: !createTitle.trim() ? UI.cardElev : UI.gradient,
                color: !createTitle.trim() ? UI.textMuted : "#fff",
                cursor: !createTitle.trim() ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 6,
              }}>
              <Plus style={{ width: 14, height: 14 }} /> Create & Link
            </button>
          </div>
        )}
      </div>
    </>
  );
}
