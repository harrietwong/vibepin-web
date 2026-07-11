"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CheckCircle2, Link2, RefreshCw, Search, Upload, X } from "lucide-react";
import * as assets from "@/lib/assetStore";
import {
  filterProductIdeas,
  isAmazonProductIdea,
  mapProductIdeaToPickerAsset,
  PRODUCT_IDEA_PICKER_CATEGORIES,
  PRODUCT_IDEA_SOURCE_FILTERS,
  type ProductIdea,
} from "@/lib/productIdeas";
import { useProductIdeas, useProductIdeasCategoryMap } from "@/lib/useProductIdeas";
import { mapPinIdeaToPickerAsset, type PinIdea } from "@/lib/pinIdeas";
import { ProductUrlImportPanel } from "@/components/studio/ProductUrlImportPanel";
import { usePinIdeas } from "@/lib/usePinIdeas";
import {
  countBrokenImports,
  filterMyProducts,
  MY_PRODUCTS_FILTERS,
  productDisplayTitle,
  productSourceLabel,
  isAmazonProductAsset,
  type MyProductsFilter,
  isBrokenProductImport,
} from "@/lib/myProductsPicker";
import { formatUpdatedAgo, isDataStale } from "@/lib/freshness";
import {
  isProductPickerAsset,
  isReferencePickerAsset,
  normalizeLegacyAssetRole,
  shouldShowInPinIdeas,
} from "@/lib/assetClassification";
import { ProductHoverPreview } from "@/components/studio/ProductPreview";
import { toPreviewProduct, asinForAsset } from "@/lib/studio/productPreview";
import { isShopifyIntegrationEnabled } from "@/lib/shopifyFlag";
import { ShopifyProductPickerPanel } from "@/components/studio/ShopifyProductPickerPanel";
import type { ShopifyPanelImage } from "@/components/studio/ShopifyProductPickerPanel";

export type InlineAssetItem = {
  id: string;
  imageUrl: string;
  title?: string;
  category?: string;
  keyword?: string;
  source: string;
  productUrl?: string;
  sourceUrl?: string;
};

export type InlineCreateAssetPickerProps = {
  role: "product" | "style_reference";
  onClose: () => void;
  onConfirm: (items: InlineAssetItem[]) => void;
  currentSelectedUrls?: string[];
};

export const PRODUCT_PICKER_TABS = [
  { id: "my_products", label: "My Products" },
  { id: "product_ideas", label: "Product Ideas" },
  { id: "shopify", label: "From Shopify" },
] as const;

export const REFERENCE_PICKER_TABS = [
  { id: "my_references", label: "My References" },
  { id: "pin_ideas", label: "Pin Ideas" },
] as const;

const CATEGORIES = [...PRODUCT_IDEA_PICKER_CATEGORIES];
const PRODUCT_IDEA_SOURCES = [...PRODUCT_IDEA_SOURCE_FILTERS];
const REF_CATEGORY_CHIPS = CATEGORIES.slice(1);
const REF_CATEGORIES = ["All categories", ...REF_CATEGORY_CHIPS];
const REF_FORMATS = ["All formats", "Room Scene", "Flat Lay", "On Body", "Shelf Styling", "Product Mockup", "Moodboard"];
const PIN_IDEA_CHIPS = [
  ...REF_CATEGORY_CHIPS,
  "Room Scene", "Flat Lay", "Product Mockup", "Moodboard",
];

const CAT_KEYS: Record<string, string[]> = {
  "Home Decor": ["home", "decor", "interior", "living", "bedroom", "lamp", "rug", "candle", "mirror"],
  "Fashion": ["fashion", "outfit", "apparel", "clothing", "dress", "bag", "shoe"],
  "Beauty": ["beauty", "makeup", "skincare", "wellness", "hair", "nail"],
  "DIY & Crafts": ["diy", "craft", "handmade", "art", "paint", "crochet"],
  "Digital Products": ["digital", "template", "printable", "planner", "notion", "canva"],
  "Food & Drink": ["food", "drink", "recipe", "coffee", "cake", "kitchen"],
  "Wedding": ["wedding", "bridal", "bride", "bouquet"],
  "Travel": ["travel", "hotel", "vacation", "beach"],
};

const FORMAT_KEYS: Record<string, string[]> = {
  "Room Scene": ["room", "scene", "interior", "living", "bedroom"],
  "Flat Lay": ["flat", "lay", "overhead", "flatlay"],
  "On Body": ["body", "outfit", "wear", "model"],
  "Shelf Styling": ["shelf", "styling", "display"],
  "Product Mockup": ["mockup", "product"],
  "Moodboard": ["mood", "moodboard", "collage"],
};

const UI = {
  card:         "var(--app-surface, #101827)",
  cardElev:     "var(--app-surface-3, #151F32)",
  border:       "var(--app-border, rgba(255,255,255,0.09))",
  borderStrong: "var(--app-border-hi, rgba(255,255,255,0.14))",
  text:         "var(--app-text, #E5E7EB)",
  textSec:      "var(--app-text-sec, #9CA3AF)",
  muted:        "var(--app-text-muted, #64748B)",
  purple:       "#8B5CF6",
  purpleBg:     "rgba(139,92,246,0.16)",
  gradient:     "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

const SOURCE_LABEL_STYLE: Record<string, { color: string }> = {
  Uploaded:       { color: "#4ADE80" },
  "URL Imported": { color: "#60A5FA" },
  "Product Ideas": { color: "#FB923C" },
  Amazon: { color: "#FB923C" },
  "Pin Ideas": { color: "#A78BFA" },
};

function normalizeCardTitle(title: string | null | undefined, fallback: string): string {
  const clean = title?.trim();
  return clean && clean.length > 0 ? clean : fallback;
}

function MyProductsFilterChips({
  active,
  brokenCount,
  onChange,
}: {
  active: MyProductsFilter;
  brokenCount: number;
  onChange: (f: MyProductsFilter) => void;
}) {
  const chips = brokenCount > 0
    ? [...MY_PRODUCTS_FILTERS, { id: "import_issues" as const, label: `Import issues ${brokenCount}` }]
    : MY_PRODUCTS_FILTERS;

  return (
    <div data-testid="my-products-filter-chips" style={{ display: "flex", gap: 5, flexWrap: "nowrap", overflowX: "auto", marginBottom: 8 }}>
      {chips.map(chip => {
        const isActive = active === chip.id;
        return (
          <button
            key={chip.id}
            type="button"
            data-testid={`my-products-filter-${chip.id}`}
            onClick={() => onChange(chip.id)}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              border: `1px solid ${isActive ? UI.purple : UI.borderStrong}`,
              background: isActive ? UI.purpleBg : "transparent",
              color: isActive ? "#C4B5FD" : UI.textSec,
              fontSize: 11,
              fontWeight: isActive ? 800 : 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

function ProductLibraryCard({
  item,
  selected,
  disabled,
  onToggle,
  hideCheckbox,
}: {
  item: assets.AssetItem;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
  /** Hide the checkbox for one-step product actions. */
  hideCheckbox?: boolean;
}) {
  const label = productSourceLabel(item);
  const title = productDisplayTitle(item);
  const labelColor = SOURCE_LABEL_STYLE[label]?.color ?? UI.textSec;
  const broken = isBrokenProductImport(item);
  const isAmazon = isAmazonProductAsset(item);
  const asin = isAmazon ? asinForAsset(item) : null;

  return (
    <button
      type="button"
      data-testid={broken ? "my-products-issue-card" : "asset-card"}
      disabled={disabled}
      onClick={() => { if (!disabled) onToggle(); }}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "auto",
        minHeight: broken ? 154 : 156,
        minWidth: 0,
        position: "relative",
        padding: 0,
        overflow: "hidden",
        borderRadius: 10,
        background: UI.cardElev,
        border: selected ? `2px solid ${UI.purple}` : `1px solid ${UI.border}`,
        boxShadow: selected ? "0 0 0 3px rgba(139,92,246,0.18)" : "none",
        cursor: disabled ? "not-allowed" : "pointer",
        textAlign: "left",
        opacity: disabled ? 0.72 : 1,
      }}
    >
      <div data-testid="asset-card-image-wrap" style={{ width: "100%", aspectRatio: "1 / 1", minHeight: 112, background: "var(--app-bg, #0B1020)", overflow: "hidden", flexShrink: 0 }}>
        {broken ? (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 10, textAlign: "center", boxSizing: "border-box" }}>
            <p style={{ margin: 0, fontSize: 10, color: UI.textSec, lineHeight: 1.45 }}>
              Image unavailable. Try re-importing or upload manually.
            </p>
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img data-testid="asset-card-image" src={item.imageUrl} alt={title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={e => { e.currentTarget.style.opacity = "0.3"; }} />
        )}
        {isAmazon && (
          <span data-testid="asset-card-amazon-badge" style={{
            position: "absolute", top: 8, left: 8, padding: "2px 7px", borderRadius: 999,
            background: "rgba(255,153,0,0.95)", color: "#1A2235", fontSize: 9, fontWeight: 900,
            letterSpacing: "0.02em",
          }}>
            Amazon
          </span>
        )}
      </div>
      {!disabled && !hideCheckbox && (
        <span style={{
          position: "absolute", top: 8, right: 8, width: 18, height: 18,
          borderRadius: "50%", border: selected ? "none" : "1.5px solid rgba(255,255,255,0.75)",
          background: selected ? UI.purple : "rgba(15,23,42,0.32)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {selected && <CheckCircle2 style={{ width: 13, height: 13, color: "#fff" }} />}
        </span>
      )}
      <div style={{ padding: "7px 8px 8px" }}>
        <p style={{ margin: "0 0 3px", fontSize: 11, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: isAmazon ? "#FB923C" : labelColor }}>{isAmazon ? "Amazon" : label}</p>
          {asin && (
            <span data-testid="product-card-asin" style={{ fontSize: 9, fontWeight: 700, color: UI.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {"\u00B7 ASIN "}{asin}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function assetLabel(source: string): string {
  if (source === "upload") return "Uploaded";
  if (source === "url") return "URL Imported";
  if (source === "product_signal" || source === "product_ideas") return "Product Ideas";
  if (source === "viral_pin") return "Pin Ideas";
  if (source === "pin_opportunity") return "Pin Opportunities";
  return "Recent";
}


function matchesCategory(text: string, category: string): boolean {
  if (category === "All Categories" || category === "All Products" || category === "All" || category === "All categories") return true;
  const keys = CAT_KEYS[category] ?? [];
  const haystack = text.toLowerCase();
  return keys.some(k => haystack.includes(k));
}

function matchesFormat(text: string, format: string): boolean {
  if (format === "All formats") return true;
  const keys = FORMAT_KEYS[format] ?? [format.toLowerCase()];
  const haystack = text.toLowerCase();
  return keys.some(k => haystack.includes(k));
}

function AssetCard({
  id, imageUrl, title, label, category, selected, portrait, onToggle,
}: {
  id: string;
  imageUrl: string;
  title?: string;
  label: string;
  category?: string;
  selected: boolean;
  portrait?: boolean;
  onToggle: () => void;
}) {
  void id;
  const displayTitle = normalizeCardTitle(title, label === "Product Ideas" ? "Untitled product idea" : "Untitled pin idea");
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="asset-card"
      onClick={onToggle}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "auto",
        minHeight: portrait ? 224 : 196,
        minWidth: 0,
        position: "relative",
        padding: 0,
        overflow: "hidden",
        borderRadius: 10,
        background: UI.cardElev,
        border: selected ? `2px solid ${UI.purple}` : `1px solid ${UI.border}`,
        boxShadow: selected ? "0 0 0 3px rgba(139,92,246,0.18)" : "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <div
        data-testid="asset-card-image-wrap"
        style={{
          width: "100%",
          aspectRatio: portrait ? "2 / 3" : "1 / 1",
          minHeight: portrait ? 168 : 150,
          background: "var(--app-bg, #0B1020)",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          data-testid="asset-card-image"
          src={imageUrl}
          alt={displayTitle}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={e => { e.currentTarget.style.opacity = "0.3"; }} />
      </div>
      <span style={{
        position: "absolute", top: 8, right: 8, width: 18, height: 18,
        borderRadius: "50%", border: selected ? "none" : "1.5px solid rgba(255,255,255,0.75)",
        background: selected ? UI.purple : "rgba(15,23,42,0.32)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {selected && <CheckCircle2 style={{ width: 13, height: 13, color: "#fff" }} />}
      </span>
      <div style={{ padding: "7px 8px 8px" }}>
        <p style={{ margin: "0 0 3px", fontSize: 11, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayTitle}
        </p>
        <p style={{ margin: 0, fontSize: 10, color: UI.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</p>
        {category && (
          <p style={{ margin: "2px 0 0", fontSize: 9, color: UI.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{category}</p>
        )}
      </div>
    </div>
  );
}

function ProductIdeaSkeletonCard() {
  return (
    <div data-testid="product-idea-skeleton" style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${UI.border}`, background: UI.cardElev }}>
      <div style={{
        width: "100%",
        aspectRatio: "1/1",
        background: "linear-gradient(90deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.03) 100%)",
        animation: "pulse 1.25s ease-in-out infinite",
      }} />
      <div style={{ padding: "8px 8px 10px" }}>
        <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.06)", marginBottom: 6 }} />
        <div style={{ height: 6, width: "55%", borderRadius: 4, background: "rgba(255,255,255,0.04)" }} />
      </div>
    </div>
  );
}

export function ProductIdeasPickerGrid({
  search,
  sourceLabel,
  categoryLabel,
  selected,
  allAssets,
  onToggleProduct,
  products,
  loading,
  error,
  kwCatMap,
  onRetry,
}: {
  search: string;
  sourceLabel: string;
  categoryLabel: string;
  selected: Set<string>;
  allAssets: assets.AssetItem[];
  onToggleProduct: (idea: ProductIdea) => void;
  products: ProductIdea[];
  loading: boolean;
  error: string | null;
  kwCatMap?: Record<string, string>;
  onRetry: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      console.log("[ProductIdeas]", {
        isLoading: loading,
        error,
        itemCount: products.length,
        first3: products.slice(0, 3).map(p => ({
          id: p.id,
          title: p.product_name,
          imageUrl: p.image_url,
          source: "product_ideas",
          category: p.seed_keyword,
        })),
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, products.length]);

  const filtered = filterProductIdeas(products, {
    search,
    sourceLabel,
    categoryLabel,
    kwCatMap,
  });

  const showSkeleton = loading && products.length === 0 && !error;

  if (showSkeleton) {
    return (
      <div data-testid="product-ideas-grid" className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", alignContent: "start", gap: 16 }}>
        {Array.from({ length: 8 }).map((_, i) => <ProductIdeaSkeletonCard key={i} />)}
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="product-ideas-grid" style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center" }}>
        <div>
          <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 800, color: UI.text }}>Could not load Product Ideas</p>
          <button type="button" data-testid="product-ideas-retry" onClick={onRetry}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            <RefreshCw style={{ width: 13, height: 13 }} /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (!filtered.length) {
    const emptyCopy = sourceLabel === "All Sources" && categoryLabel === "All Categories"
      ? "No product ideas found\nTry another category or refresh the product ideas source."
      : `No product ideas found for this category.\nTry another category or refresh the product ideas source.`;
    return (
      <div data-testid="product-ideas-grid" style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center" }}>
        <p style={{ margin: 0, fontSize: 13, color: UI.textSec, lineHeight: 1.6, whiteSpace: "pre-line" }}>{emptyCopy}</p>
      </div>
    );
  }

  return (
    <div data-testid="product-ideas-grid" className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", alignContent: "start", gap: 16 }}>
      {filtered.map(product => {
        const mapped = mapProductIdeaToPickerAsset(product, kwCatMap);
        const existing = allAssets.find(a => a.role === "product" && a.imageUrl === product.image_url);
        const isSelected = existing ? selected.has(existing.id) : false;
        const isAmazon = isAmazonProductIdea(product);
        return (
          <AssetCard
            key={product.id}
            id={product.id}
            imageUrl={mapped.imageUrl}
            title={mapped.title}
            label={isAmazon ? "Amazon" : "Product Ideas"}
            category={mapped.category}
            selected={isSelected}
            onToggle={() => onToggleProduct(product)}
          />
        );
      })}
    </div>
  );
}


function SearchInput({ value, onChange, placeholder, testId }: { value: string; onChange: (v: string) => void; placeholder: string; testId?: string }) {
  return (
    <div style={{ position: "relative", flex: 1, minWidth: 140 }}>
      <Search style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: UI.textSec }} />
      <input
        data-testid={testId}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          boxSizing: "border-box",
          borderRadius: 10,
          border: `1px solid ${UI.borderStrong}`,
          background: "var(--app-surface-2, #0D1423)",
          color: UI.text,
          padding: "10px 12px 10px 36px",
          outline: "none",
          fontSize: 12,
        }}
      />
    </div>
  );
}

function FilterSelect({ value, onChange, options, testId }: { value: string; onChange: (v: string) => void; options: string[]; testId?: string }) {
  return (
    <select
      data-testid={testId}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        borderRadius: 10,
        border: `1px solid ${UI.borderStrong}`,
        background: "var(--app-surface-2, #0D1423)",
        color: UI.text,
        padding: "9px 12px",
        fontSize: 12,
        fontWeight: 600,
        outline: "none",
        cursor: "pointer",
        minWidth: 130,
      }}
    >
      {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
  );
}

// 闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴?My References filter 闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍?

type MyRefsFilter = "all" | "uploaded" | "url_imported" | "pin_ideas" | "recent" | "used_before";

const MY_REFS_FILTERS: { id: MyRefsFilter; label: string }[] = [
  { id: "all",          label: "All" },
  { id: "uploaded",     label: "Uploaded" },
  { id: "url_imported", label: "URL Imported" },
  { id: "pin_ideas",    label: "Saved from Pin Ideas" },
  { id: "recent",       label: "Recent" },
  { id: "used_before",  label: "Used before" },
];

function filterMyReferences(items: assets.AssetItem[], filter: MyRefsFilter, search: string): assets.AssetItem[] {
  const q = search.trim().toLowerCase();
  const seen = new Set<string>();
  const deduped = items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
  let list = [...deduped];

  if (filter === "uploaded") {
    list = list.filter(i => i.source === "upload");
  } else if (filter === "url_imported") {
    list = list.filter(i => i.source === "url");
  } else if (filter === "pin_ideas") {
    list = list.filter(i => i.source === "viral_pin" || i.source === "pin_opportunity");
  } else if (filter === "recent") {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    list = list.filter(i => new Date(i.lastUsedAt).getTime() > cutoff);
  } else if (filter === "used_before") {
    list = list.filter(i => i.lastUsedAt !== i.createdAt);
  }

  list = list.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());

  if (q) {
    list = list.filter(i =>
      (i.title ?? "").toLowerCase().includes(q) ||
      (i.keyword ?? "").toLowerCase().includes(q) ||
      (i.category ?? "").toLowerCase().includes(q),
    );
  }
  return list;
}

function MyReferencesFilterChips({ active, onChange }: {
  active: MyRefsFilter;
  onChange: (f: MyRefsFilter) => void;
}) {
  return (
    <div
      data-testid="my-references-filter-chips"
      style={{ display: "flex", gap: 5, flexWrap: "nowrap", overflowX: "auto", marginBottom: 8 }}
    >
      {MY_REFS_FILTERS.map(chip => {
        const isActive = active === chip.id;
        return (
          <button
            key={chip.id}
            type="button"
            data-testid={`my-refs-filter-${chip.id}`}
            onClick={() => onChange(chip.id)}
            style={{
              padding: "5px 12px", borderRadius: 999,
              border: `1px solid ${isActive ? UI.purple : UI.borderStrong}`,
              background: isActive ? UI.purpleBg : "transparent",
              color: isActive ? "#C4B5FD" : UI.textSec,
              fontSize: 11, fontWeight: isActive ? 800 : 600,
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

// 闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴?Main picker 闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛瀣崌閺屽秹宕楁径濠佸闂備礁鍟块崢婊堝磻閹剧粯鐓冮柛蹇擃槸娴滈箖姊洪崘鎻掑辅闁稿鎹囬弻宥夊礂婢跺﹣澹曢梻浣稿暱閸樻粓宕戦幘缁樼厓闁稿繐顦禍楣冩⒑閸愭彃甯ㄩ柛?

export function InlineCreateAssetPicker({
  role, onClose, onConfirm, currentSelectedUrls = [],
}: InlineCreateAssetPickerProps) {
  const allAssets = useSyncExternalStore(assets.subscribe, assets.getAssets, assets.getServerAssets);
  const fileRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [productTab, setProductTab] = useState<typeof PRODUCT_PICKER_TABS[number]["id"]>("my_products");
  const [referenceTab, setReferenceTab] = useState<typeof REFERENCE_PICKER_TABS[number]["id"]>("my_references");
  // Tracks whether the user manually chose a reference tab 闂?so the empty-state
  // default-to-"Pin Ideas" behavior never overrides an explicit choice.
  const userPickedRefTab = useRef(false);
  const [productSource, setProductSource] = useState("All Sources");
  const [productCategory, setProductCategory] = useState("All Categories");
  const [referenceCategory, setReferenceCategory] = useState("All categories");
  const [referenceFormat, setReferenceFormat] = useState("All formats");
  const [showProductUrlImport, setShowProductUrlImport] = useState(false);
  const [productFilter, setProductFilter] = useState<MyProductsFilter>("all");
  const [refFilter,    setRefFilter]    = useState<MyRefsFilter>("all");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlText, setUrlText] = useState("");
  const isProduct = role === "product";
  const {
    data: productMeta,
    error: productIdeasSwError,
    isLoading: productIdeasLoading,
    mutate: mutateProductIdeas,
  } = useProductIdeas();
  const { data: kwCatMapData } = useProductIdeasCategoryMap();
  const {
    data: pinMeta,
    error: pinIdeasSwError,
    isLoading: pinIdeasLoading,
    mutate: mutatePinIdeas,
  } = usePinIdeas();

  const productIdeas = productMeta?.products ?? [];
  const productLastUpdated = productMeta?.lastUpdatedAt ?? null;
  const productIdeasError = productIdeasSwError
    ? (productIdeasSwError instanceof Error ? productIdeasSwError.message : "Failed to load product ideas")
    : null;
  const pinIdeas = pinMeta?.pins ?? [];
  const pinLastUpdated = pinMeta?.lastUpdatedAt ?? null;
  const pinIdeasError = pinIdeasSwError
    ? (pinIdeasSwError instanceof Error ? pinIdeasSwError.message : "Failed to load pin ideas")
    : null;
  const kwCatMap = kwCatMapData ?? {};
  const myAssets = allAssets.filter(a =>
    role === "product"
      ? a.role === "product" && isProductPickerAsset(a)
      : a.role === "style_reference" && isReferencePickerAsset(a),
  );
  const selectedUrlsKey = currentSelectedUrls.join("\u001f");

  useEffect(() => {
    // Sync draft selection only when the picker opens or committed URLs change 闂?not on every asset-store write.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(new Set(assets.getAssets().filter(a => a.role === role && currentSelectedUrls.includes(a.imageUrl)).map(a => a.id)));
    setSearch("");
    setShowUrlInput(false);
    setProductTab("my_products");
    setReferenceTab("my_references");
    userPickedRefTab.current = false;
    setShowProductUrlImport(false);
    setProductFilter("all");
    setProductSource("All Sources");
    setProductCategory("All Categories");
    setRefFilter("all");
  }, [role, selectedUrlsKey, currentSelectedUrls]);

  useEffect(() => {
    // Default the reference picker to "Pin Ideas" when "My References" is empty
    // and VibePin Pin Ideas have loaded results. Keep "My References" when the
    // user has any saved references, and never override a manual tab choice.
    if (isProduct || userPickedRefTab.current) return;
    if (referenceTab !== "my_references") return;
    if (myAssets.length === 0 && pinIdeas.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReferenceTab("pin_ideas");
    }
  }, [isProduct, referenceTab, myAssets.length, pinIdeas.length]);

  const loadProductIdeas = useCallback(() => {
    void mutateProductIdeas();
  }, [mutateProductIdeas]);

  const loadPinIdeas = useCallback(() => {
    void mutatePinIdeas();
  }, [mutatePinIdeas]);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const savedIds: string[] = [];
    for (const file of Array.from(files)) {
      const imageUrl = await readFileAsDataUrl(file);
      const saved = assets.saveAsset({
        role,
        assetRole: role === "product" ? "product_image" : "pin_reference",
        itemType: role === "product" ? "product" : "pin_idea",
        source: "upload",
        imageUrl,
        title: file.name.replace(/\.[^.]+$/, ""),
      });
      savedIds.push(saved.id);
    }
    setSelected(prev => new Set([...prev, ...savedIds]));
  }

  function importUrls() {
    const urls = urlText.split(/[\n,]+/).map(v => v.trim()).filter(v => /^https?:\/\//i.test(v));
    if (!urls.length) return;
    const savedIds = urls.slice(0, 20).map(url => assets.saveAsset({
      role,
      assetRole: role === "product" ? "product_image" : "pin_reference",
      itemType: role === "product" ? "product" : "pin_idea",
      source: "url",
      imageUrl: url,
      sourceUrl: url,
      productUrl: url,
      sourceContext: role === "product" ? "url_imported" : "url_imported",
    }).id);
    setSelected(prev => new Set([...prev, ...savedIds]));
    setUrlText("");
    setShowUrlInput(false);
  }

  function saveUrlImportedProducts(items: Array<{
    imageUrl: string;
    title: string;
    sourceUrl: string;
    sourceDomain: string;
    productUrl: string;
    extractionReason?: string;
  }>) {
    const savedIds: string[] = [];
    for (const item of items) {
      const saved = assets.saveAsset({
        role:             "product",
        assetRole:        "product_image",
        itemType:         "product",
        productType:      "physical_product",
        destinationType:  "product_page",
        sourceContext:    "url_imported",
        source:           "url",
        imageUrl:         item.imageUrl,
        title:            item.title,
        sourceUrl:        item.sourceUrl,
        productUrl:       item.productUrl,
        sourceDomain:     item.sourceDomain,
        extractionReason: item.extractionReason,
      });
      savedIds.push(saved.id);
    }
    setSelected(prev => new Set([...prev, ...savedIds]));
    setShowProductUrlImport(false);
  }

  function selectProductIdea(product: ProductIdea) {
    const mapped = mapProductIdeaToPickerAsset(product, kwCatMap);
    const existing = allAssets.find(a => a.role === "product" && a.imageUrl === product.image_url);
    const saved = existing ?? assets.saveAsset({
      role: "product",
      assetRole: mapped.assetRole,
      itemType: product.item_type ?? "product",
      productType: product.product_type ?? "physical_product",
      productSubtype: product.product_subtype ?? "unknown",
      destinationType: product.destination_type ?? "product_page",
      sourceContext: "saved_from_product_ideas",
      riskFlags: product.risk_flags,
      source: "product_ideas",
      imageUrl: mapped.imageUrl,
      title: mapped.title,
      keyword: product.seed_keyword ?? undefined,
      category: mapped.category,
      sourceUrl: mapped.productUrl,
      productUrl: mapped.productUrl,
      sourceDomain: mapped.sourceDomain,
      store: product.merchant ?? product.domain ?? undefined,
    });
    toggle(saved.id);
  }

  function saveShopifyImages(images: ShopifyPanelImage[], product: { title: string; productUrl?: string }) {
    const savedIds: string[] = [];
    for (const img of images) {
      const existing = allAssets.find(a => a.role === "product" && a.imageUrl === img.url);
      const saved = existing ?? assets.saveAsset({
        role:            "product",
        assetRole:       "product_image",
        itemType:        "product",
        productType:     "physical_product",
        destinationType: "product_page",
        sourceContext:   "url_imported",
        source:          "shopify",
        imageUrl:        img.url,
        title:           product.title,
        productUrl:      product.productUrl,
        store:           "Shopify",
      });
      savedIds.push(saved.id);
    }
    setSelected(prev => new Set([...prev, ...savedIds]));
  }

  function selectPinIdea(pin: PinIdea) {
    const mapped = mapPinIdeaToPickerAsset(pin);
    const existing = allAssets.find(a => a.role === "style_reference" && a.imageUrl === pin.image_url);
    const saved = existing ?? assets.saveAsset({
      role: "style_reference",
      assetRole: mapped.assetRole,
      itemType: pin.item_type ?? "pin_idea",
      productType: pin.product_type ?? "unknown",
      productSubtype: pin.product_subtype ?? "unknown",
      destinationType: pin.destination_type ?? "unknown",
      sourceContext: "saved_from_pin_ideas",
      riskFlags: pin.risk_flags,
      source: "viral_pin",
      imageUrl: mapped.imageUrl,
      title: mapped.title,
      keyword: mapped.keyword,
      category: mapped.category,
    });
    toggle(saved.id);
  }

  function confirm() {
    const items = assets.getAssets()
      .filter(item =>
        item.role === role &&
        selected.has(item.id) &&
        normalizeLegacyAssetRole(item.role, item.assetRole) === (role === "product" ? "product_image" : "pin_reference"),
      )
      .map(item => ({ id: item.id, imageUrl: item.imageUrl, title: item.title, category: item.category, keyword: item.keyword, source: item.source, productUrl: item.productUrl, sourceUrl: item.sourceUrl }));
    items.forEach(item => assets.markUsed(item.id));
    onConfirm(items);
    setSelected(new Set());
  }

  // 1-step "Use for Pins" 闂?lock a single product into Create Pins without the
  // multi-select checkbox 闂?Add Selected round-trip. Used by the hover/click
  // preview actions.
  function chooseProductForPins(item: assets.AssetItem) {
    assets.markUsed(item.id);
    onConfirm([{ id: item.id, imageUrl: item.imageUrl, title: item.title, category: item.category, keyword: item.keyword, source: item.source, productUrl: item.productUrl, sourceUrl: item.sourceUrl }]);
    setSelected(new Set());
  }

  function handleChipClick(chip: string) {
    if (REF_FORMATS.slice(1).includes(chip)) {
      setReferenceFormat(chip);
      return;
    }
    setReferenceCategory(chip);
  }

  const query = search.trim().toLowerCase();
  const filteredPinIdeas = pinIdeas.filter(pin => {
    const text = `${pin.title ?? ""} ${pin.source_keyword ?? ""} ${pin.category ?? ""}`;
    return shouldShowInPinIdeas(pin)
      && (!query || text.toLowerCase().includes(query))
      && matchesCategory(text, referenceCategory)
      && matchesFormat(text, referenceFormat);
  });

  const brokenImportCount = countBrokenImports(myAssets);
  const filteredMyProducts = filterMyProducts(myAssets, productFilter, search);
  const filteredMyRefs     = filterMyReferences(myAssets, refFilter, search);

  const shopifyEnabled = isShopifyIntegrationEnabled();
  const title = isProduct ? "Choose Product Images" : "Choose Pin References";
  const tabs = (isProduct ? PRODUCT_PICKER_TABS : REFERENCE_PICKER_TABS)
    .filter(t => t.id !== "shopify" || shopifyEnabled);
  const activeTab = isProduct ? productTab : referenceTab;
  const setActiveTab = (tab: string) => {
    setSearch("");
    if (isProduct) setProductTab(tab as typeof PRODUCT_PICKER_TABS[number]["id"]);
    else { userPickedRefTab.current = true; setReferenceTab(tab as typeof REFERENCE_PICKER_TABS[number]["id"]); }
  };

  const selectedCountLabel = isProduct
    ? `${selected.size} product${selected.size === 1 ? "" : "s"} selected`
    : `${selected.size} reference${selected.size === 1 ? "" : "s"} selected`;

  return (
    <section
      data-testid={isProduct ? "product-picker" : "reference-picker"}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: UI.card, borderLeft: `1px solid ${UI.border}`, overflow: "hidden" }}
    >
      <header style={{ padding: "0 14px", borderBottom: `1px solid ${UI.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 40 }}>
          <h2 style={{ margin: 0, color: UI.text, fontSize: 13, fontWeight: 800 }}>{title}</h2>
          <button
            type="button"
            data-testid="asset-picker-close"
            onClick={onClose}
            aria-label="Close picker"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 6, border: "none", background: "transparent", color: UI.textSec, cursor: "pointer", flexShrink: 0 }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = UI.cardElev; (e.currentTarget as HTMLButtonElement).style.color = UI.text; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = UI.textSec; }}
          >
            <X style={{ width: 15, height: 15 }} />
          </button>
        </div>
        <div data-testid="asset-picker-top-tabs" style={{ display: "flex", gap: 16 }}>
          {tabs.map(tab => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`picker-tab-${tab.id}`}
                aria-label={tab.label}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: "0 0 8px",
                  background: "none",
                  border: "none",
                  borderBottom: active ? `2px solid ${UI.purple}` : "2px solid transparent",
                  color: active ? "#C4B5FD" : UI.textSec,
                  fontSize: 11,
                  fontWeight: active ? 800 : 700,
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      {isProduct && productTab === "my_products" && (
        <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search my products..." />
            <button type="button" data-testid="compact-upload-product" onClick={() => fileRef.current?.click()}
              style={{ padding: "0 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Upload style={{ width: 13, height: 13 }} /> Upload product
            </button>
            <button type="button" data-testid="compact-import-url" onClick={() => setShowProductUrlImport(v => !v)}
              style={{ padding: "0 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: showProductUrlImport ? UI.purpleBg : UI.cardElev, color: showProductUrlImport ? "#C4B5FD" : UI.text, fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Link2 style={{ width: 13, height: 13 }} /> Import from URL
            </button>
          </div>
          {showProductUrlImport && (
            <ProductUrlImportPanel
              role="product"
              onSaveSelected={items => { saveUrlImportedProducts(items); setShowProductUrlImport(false); }}
              onCancel={() => setShowProductUrlImport(false)}
            />
          )}
          <MyProductsFilterChips
            active={productFilter}
            brokenCount={brokenImportCount}
            onChange={setProductFilter}
          />
          <p data-testid="my-products-count" style={{ margin: "0 0 10px", fontSize: 11, color: UI.muted }}>
            Showing {filteredMyProducts.length} product{filteredMyProducts.length === 1 ? "" : "s"}
          </p>
          <div
            data-testid="my-products-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
              gap: 10,
              alignContent: "start",
            }}
          >
            {filteredMyProducts.length === 0 ? (
              <p data-testid="my-products-empty" style={{ gridColumn: "1 / -1", margin: 0, fontSize: 12, color: UI.textSec, textAlign: "center", padding: "24px 12px" }}>
                {productFilter === "import_issues"
                  ? "No import issues found."
                  : productFilter === "amazon"
                    ? "No Amazon products found yet. Import an Amazon product URL or save one from Product Opportunities."
                    : search.trim()
                      ? "No products match your search."
                      : "No saved products yet. Upload product images or import products."}
              </p>
            ) : filteredMyProducts.map(item => (
              <ProductHoverPreview key={item.id} product={toPreviewProduct(item)} onUse={() => chooseProductForPins(item)}>
                <ProductLibraryCard
                  item={item}
                  selected={selected.has(item.id)}
                  disabled={isBrokenProductImport(item)}
                  onToggle={() => toggle(item.id)}
                />
              </ProductHoverPreview>
            ))}
          </div>
        </div>
      )}

      {isProduct && productTab === "product_ideas" && (
        <>
          <div style={{ padding: "10px 12px", borderBottom: `1px solid ${UI.border}` }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search product ideas..." />
            <div data-testid="product-ideas-source-filters" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              <span style={{ color: UI.textSec, fontSize: 11, fontWeight: 800, marginRight: 2 }}>Source:</span>
              {PRODUCT_IDEA_SOURCES.map(source => {
                const active = productSource === source;
                return (
                  <button
                    key={source}
                    type="button"
                    data-testid={`product-ideas-source-${source.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                    onClick={() => setProductSource(source)}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 999,
                      border: `1px solid ${active ? UI.purple : UI.borderStrong}`,
                      background: active ? UI.purpleBg : "transparent",
                      color: active ? "#C4B5FD" : UI.textSec,
                      fontSize: 11,
                      fontWeight: active ? 800 : 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {source}
                  </button>
                );
              })}
            </div>
            <div data-testid="product-ideas-category-filters" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <span style={{ color: UI.textSec, fontSize: 11, fontWeight: 800, marginRight: 2 }}>Category:</span>
              {CATEGORIES.map(cat => {
                const active = productCategory === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    data-testid={`product-ideas-category-${cat.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                    onClick={() => setProductCategory(cat)}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 999,
                      border: `1px solid ${active ? UI.purple : UI.borderStrong}`,
                      background: active ? UI.purpleBg : "transparent",
                      color: active ? "#C4B5FD" : UI.textSec,
                      fontSize: 11,
                      fontWeight: active ? 800 : 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
            {formatUpdatedAgo(productLastUpdated) && (
              <p data-testid="product-ideas-freshness" style={{ margin: "8px 0 0", fontSize: 10, color: isDataStale(productLastUpdated) ? "#F59E0B" : UI.muted }}>
                {formatUpdatedAgo(productLastUpdated)}
                {isDataStale(productLastUpdated) ? " \u00B7 Data may be stale." : ""}
              </p>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
            <ProductIdeasPickerGrid
              search={search}
              sourceLabel={productSource}
              categoryLabel={productCategory}
              selected={selected}
              allAssets={allAssets}
              onToggleProduct={selectProductIdea}
              products={productIdeas}
              loading={productIdeasLoading}
              error={productIdeasError}
              kwCatMap={kwCatMap}
              onRetry={loadProductIdeas}
            />
          </div>
          <p style={{ margin: 0, padding: "0 18px 10px", color: UI.textSec, fontSize: 11 }}>Selected items are also saved to My Products.</p>
        </>
      )}

      {isProduct && productTab === "shopify" && shopifyEnabled && (
        <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
          <ShopifyProductPickerPanel mode="select-images" onSelectImages={saveShopifyImages} />
          <p style={{ margin: "10px 0 0", color: UI.textSec, fontSize: 11 }}>Selected images are also saved to My Products.</p>
        </div>
      )}

      {!isProduct && referenceTab === "my_references" && (
        <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
          {/* Search + upload + import */}
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search my references..." testId="search-my-references" />
            <button
              type="button"
              data-testid="compact-upload-reference"
              onClick={() => fileRef.current?.click()}
              style={{ padding: "0 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Upload style={{ width: 13, height: 13 }} /> Upload reference
            </button>
            <button
              type="button"
              data-testid="compact-import-url"
              onClick={() => setShowUrlInput(v => !v)}
              style={{ padding: "0 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: showUrlInput ? UI.purpleBg : UI.cardElev, color: showUrlInput ? "#C4B5FD" : UI.text, fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Link2 style={{ width: 13, height: 13 }} /> Import from URL
            </button>
          </div>

          {/* URL import inline panel */}
          {showUrlInput && (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                value={urlText}
                onChange={e => setUrlText(e.target.value)}
                placeholder="Paste image URL(s), one per line"
                style={{ flex: 1, borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: "var(--app-surface-2, #0D1423)", color: UI.text, padding: "9px 12px", outline: "none", fontSize: 12 }}
              />
              <button type="button" onClick={importUrls} style={{ borderRadius: 9, border: "none", background: UI.gradient, color: "#fff", padding: "0 14px", fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>Import</button>
            </div>
          )}

          {/* Filter chips */}
          <MyReferencesFilterChips active={refFilter} onChange={f => { setRefFilter(f); setSearch(""); }} />

          {/* Count */}
          <p data-testid="my-references-count" style={{ margin: "0 0 10px", fontSize: 11, color: UI.muted }}>
            Showing {filteredMyRefs.length} reference{filteredMyRefs.length === 1 ? "" : "s"}
          </p>

          {/* Unified grid */}
          <div
            data-testid="my-references-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
              gap: 10,
              alignContent: "start",
            }}
          >
            {filteredMyRefs.length === 0 ? (
              <div style={{ gridColumn: "1 / -1", padding: "28px 12px", textAlign: "center" }}>
                {refFilter === "all" ? (
                  <>
                    <p style={{ margin: "0 0 10px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
                      No references saved yet.{"\n"}Upload or import a reference, or save one from Pin Ideas.
                    </p>
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      style={{ padding: "8px 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                      <Upload style={{ width: 13, height: 13 }} /> Upload reference
                    </button>
                  </>
                ) : refFilter === "uploaded" ? (
                  <>
                    <p style={{ margin: "0 0 10px", fontSize: 12, color: UI.textSec }}>No uploaded references yet.</p>
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      style={{ padding: "8px 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                      <Upload style={{ width: 13, height: 13 }} /> Upload reference
                    </button>
                  </>
                ) : refFilter === "url_imported" ? (
                  <>
                    <p style={{ margin: "0 0 10px", fontSize: 12, color: UI.textSec }}>No URL-imported references yet.</p>
                    <button
                      type="button"
                      onClick={() => setShowUrlInput(true)}
                      style={{ padding: "8px 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                      <Link2 style={{ width: 13, height: 13 }} /> Import from URL
                    </button>
                  </>
                ) : refFilter === "pin_ideas" ? (
                  <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
                    No Pin Ideas references saved yet.{"\n"}Select references in the Pin Ideas tab to save them here.
                  </p>
                ) : (
                  <p style={{ margin: 0, fontSize: 12, color: UI.textSec }}>No references match this filter.</p>
                )}
              </div>
            ) : (
              filteredMyRefs.map(item => (
                <AssetCard
                  key={item.id}
                  id={item.id}
                  imageUrl={item.imageUrl}
                  title={item.title}
                  label={assetLabel(item.source)}
                  category={item.category}
                  selected={selected.has(item.id)}
                  portrait
                  onToggle={() => toggle(item.id)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {!isProduct && referenceTab === "pin_ideas" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
            <div data-testid="pin-ideas-filters" style={{ marginBottom: 10 }}>
              {formatUpdatedAgo(pinLastUpdated) && (
                <p data-testid="pin-ideas-freshness" style={{ margin: "0 0 8px", fontSize: 10, color: isDataStale(pinLastUpdated) ? "#F59E0B" : UI.muted }}>
                  {formatUpdatedAgo(pinLastUpdated)}
                  {isDataStale(pinLastUpdated) ? " \u00B7 Data may be stale." : ""}
                </p>
              )}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <SearchInput value={search} onChange={setSearch} placeholder="Search Pin ideas..." testId="search-pin-ideas" />
                <FilterSelect value={referenceCategory} onChange={setReferenceCategory} options={REF_CATEGORIES} testId="pin-ideas-category-filter" />
                <FilterSelect value={referenceFormat} onChange={setReferenceFormat} options={REF_FORMATS} testId="pin-ideas-format-filter" />
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {PIN_IDEA_CHIPS.map(chip => {
                  const isCategory = !REF_FORMATS.slice(1).includes(chip);
                  const active = isCategory ? referenceCategory === chip : referenceFormat === chip;
                  return (
                    <button
                      key={chip}
                      type="button"
                      data-testid={`pin-idea-chip-${chip.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                      onClick={() => handleChipClick(chip)}
                      style={{
                        padding: "5px 10px",
                        borderRadius: 999,
                        border: `1px solid ${active ? UI.purple : UI.borderStrong}`,
                        background: active ? UI.purpleBg : "transparent",
                        color: active ? "#C4B5FD" : UI.textSec,
                        fontSize: 11,
                        fontWeight: active ? 800 : 600,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {chip}
                    </button>
                  );
                })}
              </div>
            </div>
            {pinIdeasLoading && pinIdeas.length === 0 && !pinIdeasError ? (
              <div data-testid="pin-ideas-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))", gap: 12 }}>
                {Array.from({ length: 8 }).map((_, i) => <ProductIdeaSkeletonCard key={i} />)}
              </div>
            ) : pinIdeasError ? (
              <div data-testid="pin-ideas-grid" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center" }}>
                <div>
                  <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 800, color: UI.text }}>Could not load Pin Ideas</p>
                  <button type="button" data-testid="pin-ideas-retry" onClick={loadPinIdeas}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    <RefreshCw style={{ width: 13, height: 13 }} /> Retry
                  </button>
                </div>
              </div>
            ) : !filteredPinIdeas.length ? (
              <div data-testid="pin-ideas-grid" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center" }}>
                <p style={{ margin: 0, fontSize: 13, color: UI.textSec, lineHeight: 1.6, whiteSpace: "pre-line" }}>
                  No pin ideas found{"\n"}Try another category or refresh the pin ideas source.
                </p>
              </div>
            ) : (
              <div
                data-testid="pin-ideas-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))",
                  gap: 12,
                  alignContent: "start",
                }}
              >
                {filteredPinIdeas.map(pin => {
                  const mapped = mapPinIdeaToPickerAsset(pin);
                  const existing = allAssets.find(a => a.role === "style_reference" && a.imageUrl === pin.image_url);
                  const isSelected = existing ? selected.has(existing.id) : false;
                  return (
                    <AssetCard
                      key={pin.id}
                      id={pin.id}
                      imageUrl={mapped.imageUrl}
                      title={mapped.title}
                      label="Pin Ideas"
                      category={mapped.category}
                      selected={isSelected}
                      portrait
                      onToggle={() => selectPinIdea(pin)}
                    />
                  );
                })}
              </div>
            )}
          </div>
          <p style={{ margin: 0, padding: "0 18px 10px", color: UI.textSec, fontSize: 11, flexShrink: 0 }}>
            Selected references are also saved to My References.
          </p>
        </div>
      )}

      <footer style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderTop: `1px solid ${UI.border}`, flexShrink: 0, background: UI.card }}>
        <span data-testid="asset-picker-selected-count" style={{ flex: 1, color: selected.size ? "#C4B5FD" : UI.textSec, fontSize: 12, fontWeight: 800 }}>
          {selectedCountLabel}
        </span>
        <button type="button" data-testid="asset-picker-cancel" onClick={() => { setSelected(new Set()); onClose(); }} style={{ padding: "9px 18px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: "transparent", color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          Cancel
        </button>
        <button type="button" data-testid="asset-picker-confirm" disabled={selected.size === 0} onClick={confirm} style={{ padding: "9px 20px", borderRadius: 9, border: "none", background: selected.size ? UI.gradient : "rgba(148,163,184,0.12)", color: selected.size ? "#fff" : UI.muted, fontSize: 12, fontWeight: 800, cursor: selected.size ? "pointer" : "not-allowed" }}>
          Add Selected
        </button>
      </footer>
      <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => handleFiles(e.currentTarget.files)} />
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
    </section>
  );
}
