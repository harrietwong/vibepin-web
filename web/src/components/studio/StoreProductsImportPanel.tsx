"use client";

/**
 * FR-06 stage 1 — Shopify store / collection batch import, rendered inside the
 * existing link-import panel (not a second import flow). Lists up to 100 products
 * with thumbnail, title, price and a checkbox; the chosen ones are handed to the
 * caller, which saves them to "My Products" only — no drafts, no schedule, no
 * generation (PRD C1/C4).
 */

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { fetchStoreProductsImport } from "@/lib/productUrlImportClient";
import type { StoreProductsImportResponse } from "@/lib/productUrlImport/storeBatchShared";
import {
  initialStoreSelection,
  isSelectableStoreProduct,
  selectAllStoreProducts,
  selectedStoreProductCount,
  selectNoStoreProducts,
  storeProductPriceLabel,
  toggleStoreSelection,
  toStoreAssetSaveItems,
  type StoreBatchSaveItem,
} from "@/lib/studio/storeBatchImport";

const UI = {
  cardElev:     "var(--app-surface-3, #151F32)",
  surface:      "var(--app-surface-2, #0D1423)",
  border:       "var(--app-border, rgba(255,255,255,0.09))",
  borderStrong: "var(--app-border-hi, rgba(255,255,255,0.14))",
  text:         "var(--app-text, #E5E7EB)",
  textSec:      "var(--app-text-sec, #9CA3AF)",
  muted:        "var(--app-text-muted, #64748B)",
  purple:       "#8B5CF6",
  gradient:     "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

type Phase = "input" | "loading" | "review";

export type StoreProductsImportPanelProps = {
  initialUrl?: string;
  /** Start loading immediately (the user already pasted a store/collection link). */
  autoLoad?:   boolean;
  onSave:      (items: StoreBatchSaveItem[]) => void;
  onBack:      () => void;
};

const secondaryBtn = {
  minHeight: 44, padding: "0 14px", borderRadius: 9,
  border: `1px solid ${UI.borderStrong}`, background: "transparent",
  color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer",
} as const;

export function StoreProductsImportPanel({ initialUrl = "", autoLoad = false, onSave, onBack }: StoreProductsImportPanelProps) {
  const { t } = useLocale();
  const [url,       setUrl]       = useState(initialUrl);
  const [phase,     setPhase]     = useState<Phase>(autoLoad && initialUrl ? "loading" : "input");
  const [response,  setResponse]  = useState<StoreProductsImportResponse | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [error,     setError]     = useState<string | null>(null);
  const autoLoaded = useRef(false);

  async function load(target: string) {
    const trimmed = target.trim();
    if (!trimmed) return;
    setPhase("loading");
    setError(null);
    setResponse(null);
    setSelection(new Set());
    try {
      const data = await fetchStoreProductsImport(trimmed);
      setResponse(data);
      setSelection(data.status === "success" ? initialStoreSelection(data.products) : new Set());
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("studioModals.storeImport.failed"));
      setPhase("input");
    }
  }

  useEffect(() => {
    // Guarded so React StrictMode's double effect cannot fire two batch requests.
    if (!autoLoad || !initialUrl || autoLoaded.current) return;
    autoLoaded.current = true;
    void load(initialUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const products = response?.status === "success" ? response.products : [];
  const selectedCount = selectedStoreProductCount(selection, products);

  function handleSave() {
    if (!response || response.status !== "success") return;
    const items = toStoreAssetSaveItems(response, selection);
    if (!items.length) return;
    onSave(items);
  }

  return (
    <div data-testid="store-import-panel" style={{ minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: UI.text }}>{t("studioModals.storeImport.title")}</p>
      <p style={{ margin: "4px 0 10px", fontSize: 11, color: UI.textSec, lineHeight: 1.5 }}>{t("studioModals.storeImport.hint")}</p>

      {(phase === "input" || phase === "loading") && (
        <>
          <input
            data-testid="store-import-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder={t("studioModals.storeImport.placeholder")}
            disabled={phase === "loading"}
            style={{
              width: "100%", boxSizing: "border-box", minHeight: 44, borderRadius: 10,
              border: `1px solid ${UI.borderStrong}`, background: UI.surface,
              color: UI.text, padding: "0 12px", fontSize: 12, outline: "none", fontFamily: "inherit",
            }}
          />
          {error && <p data-testid="store-import-error" style={{ margin: "8px 0 0", fontSize: 11, color: "#F87171" }}>{error}</p>}
          {phase === "loading" && (
            <p data-testid="store-import-loading" style={{ margin: "8px 0 0", fontSize: 11, color: UI.muted }}>{t("studioModals.storeImport.loading")}</p>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              data-testid="store-import-load"
              disabled={!url.trim() || phase === "loading"}
              onClick={() => load(url)}
              style={{
                minHeight: 44, padding: "0 16px", borderRadius: 9, border: "none",
                background: url.trim() && phase !== "loading" ? UI.gradient : "rgba(148,163,184,0.12)",
                color:      url.trim() && phase !== "loading" ? "#fff" : UI.muted,
                fontSize: 12, fontWeight: 800,
                cursor: url.trim() && phase !== "loading" ? "pointer" : "not-allowed",
              }}
            >
              {t("studioModals.storeImport.load")}
            </button>
            <button type="button" data-testid="store-import-back" onClick={onBack} style={secondaryBtn}>
              {t("studioModals.storeImport.back")}
            </button>
          </div>
        </>
      )}

      {phase === "review" && response && response.status !== "success" && (
        <div data-testid="store-import-unsupported" style={{
          padding: 12, borderRadius: 10,
          border: "1px solid rgba(251,191,36,0.25)", background: "rgba(251,191,36,0.06)",
        }}>
          <p style={{ margin: 0, fontSize: 12, color: "#FDE68A", fontWeight: 700, lineHeight: 1.5 }}>
            {response.status === "unsupported" ? t("studioModals.storeImport.unsupported") : t("studioModals.storeImport.failed")}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <button type="button" data-testid="store-import-edit" onClick={() => setPhase("input")} style={secondaryBtn}>
              {t("studioModals.storeImport.load")}
            </button>
            <button type="button" data-testid="store-import-back-review" onClick={onBack} style={secondaryBtn}>
              {t("studioModals.storeImport.back")}
            </button>
          </div>
        </div>
      )}

      {phase === "review" && response?.status === "success" && (
        <div data-testid="store-import-results" style={{ minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <p data-testid="store-import-found" style={{ margin: 0, flex: "1 1 160px", minWidth: 0, fontSize: 11, color: UI.textSec, fontWeight: 700, overflowWrap: "anywhere" }}>
              {t("studioModals.storeImport.foundCount").replace("{n}", String(products.length)).replace("{store}", response.store.domain)}
            </p>
            <button type="button" data-testid="store-import-select-all" onClick={() => setSelection(selectAllStoreProducts(products))} style={{ ...secondaryBtn, minHeight: 36, padding: "0 10px", fontSize: 11 }}>
              {t("studioModals.storeImport.selectAll")}
            </button>
            <button type="button" data-testid="store-import-select-none" onClick={() => setSelection(selectNoStoreProducts())} style={{ ...secondaryBtn, minHeight: 36, padding: "0 10px", fontSize: 11 }}>
              {t("studioModals.storeImport.selectNone")}
            </button>
          </div>
          {response.truncated && (
            <p data-testid="store-import-truncated" style={{ margin: "0 0 8px", fontSize: 11, color: "#FBBF24", fontWeight: 700 }}>
              {t("studioModals.storeImport.truncated")}
            </p>
          )}
          {products.length === 0 && (
            <p data-testid="store-import-empty" style={{ margin: "0 0 8px", fontSize: 11, color: UI.muted }}>{t("studioModals.storeImport.empty")}</p>
          )}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto", overflowX: "hidden" }}>
            {products.map(p => {
              const selectable = isSelectableStoreProduct(p);
              const checked = selectable && selection.has(p.handle);
              const price = storeProductPriceLabel(p);
              return (
                <li key={p.handle}>
                  <label
                    data-testid="store-import-row"
                    style={{
                      display: "flex", alignItems: "center", gap: 10, minWidth: 0, minHeight: 44,
                      padding: 6, borderRadius: 10, boxSizing: "border-box",
                      border: checked ? `1px solid ${UI.purple}` : `1px solid ${UI.border}`,
                      background: UI.cardElev, cursor: selectable ? "pointer" : "default",
                      opacity: selectable ? 1 : 0.75,
                    }}
                  >
                    <input
                      type="checkbox"
                      data-testid="store-import-checkbox"
                      checked={checked}
                      disabled={!selectable}
                      onChange={() => setSelection(prev => toggleStoreSelection(prev, p.handle, products))}
                      aria-label={p.title}
                      style={{ width: 18, height: 18, flexShrink: 0, accentColor: UI.purple }}
                    />
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.imageUrl} alt="" loading="lazy" style={{ width: 56, height: 56, flexShrink: 0, objectFit: "cover", borderRadius: 8, display: "block" }} />
                    ) : (
                      <span style={{ width: 56, height: 56, flexShrink: 0, borderRadius: 8, background: "rgba(255,255,255,0.05)", border: `1px dashed ${UI.borderStrong}` }} />
                    )}
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                      {price && <span style={{ fontSize: 11, color: UI.textSec }}>{price}</span>}
                      {!selectable && (
                        <span data-testid="store-import-no-image" style={{ fontSize: 10, color: "#FBBF24", fontWeight: 700 }}>{t("studioModals.storeImport.noImage")}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p style={{ margin: "8px 0 0", fontSize: 10, color: UI.muted }}>{t("studioModals.storeImport.savedOnlyNote")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 10 }}>
            <span data-testid="store-import-selected-count" style={{ flex: "1 1 100px", minWidth: 0, color: selectedCount ? "#C4B5FD" : UI.textSec, fontSize: 12, fontWeight: 800 }}>
              {t("studioModals.storeImport.selectedCount").replace("{n}", String(selectedCount))}
            </span>
            <button type="button" data-testid="store-import-back-results" onClick={onBack} style={secondaryBtn}>
              {t("studioModals.storeImport.back")}
            </button>
            <button
              type="button"
              data-testid="store-import-save"
              disabled={selectedCount === 0}
              onClick={handleSave}
              style={{
                minHeight: 44, padding: "0 16px", borderRadius: 9, border: "none",
                background: selectedCount ? UI.gradient : "rgba(148,163,184,0.12)",
                color:      selectedCount ? "#fff" : UI.muted,
                fontSize: 12, fontWeight: 800,
                cursor: selectedCount ? "pointer" : "not-allowed",
              }}
            >
              {t("studioModals.storeImport.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
