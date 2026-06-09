"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CheckCircle2, Link2, RefreshCw, Search, Upload, X } from "lucide-react";
import * as assets from "@/lib/assetStore";
import {
  filterProductIdeas,
  mapProductIdeaToPickerAsset,
  PRODUCT_IDEA_PICKER_CATEGORIES,
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

export type InlineAssetItem = {
  id: string;
  imageUrl: string;
  title?: string;
  category?: string;
  keyword?: string;
  source: string;
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
] as const;

export const REFERENCE_PICKER_TABS = [
  { id: "my_references", label: "My References" },
  { id: "pin_ideas", label: "Pin Ideas" },
] as const;

const CATEGORIES = [...PRODUCT_IDEA_PICKER_CATEGORIES];
const REF_CATEGORIES = ["All categories", ...CATEGORIES.slice(1)];
const REF_FORMATS = ["All formats", "Room Scene", "Flat Lay", "On Body", "Shelf Styling", "Product Mockup", "Moodboard"];
const PIN_IDEA_CHIPS = [
  ...CATEGORIES.slice(1),
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
  card: "#101827",
  cardElev: "#151F32",
  border: "rgba(255,255,255,0.09)",
  borderStrong: "rgba(255,255,255,0.14)",
  text: "#E5E7EB",
  textSec: "#9CA3AF",
  muted: "#64748B",
  purple: "#8B5CF6",
  purpleBg: "rgba(139,92,246,0.16)",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

const SOURCE_LABEL_STYLE: Record<string, { color: string }> = {
  Uploaded:       { color: "#4ADE80" },
  "URL Imported": { color: "#60A5FA" },
  "Product Ideas": { color: "#FB923C" },
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
    <div data-testid="my-products-filter-chips" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
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
}: {
  item: assets.AssetItem;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const label = productSourceLabel(item);
  const title = productDisplayTitle(item);
  const labelColor = SOURCE_LABEL_STYLE[label]?.color ?? UI.textSec;
  const broken = isBrokenProductImport(item);

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
      <div data-testid="asset-card-image-wrap" style={{ width: "100%", aspectRatio: "1 / 1", minHeight: 112, background: "#0B1020", overflow: "hidden", flexShrink: 0 }}>
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
      </div>
      {!disabled && (
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
        <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: labelColor }}>{label}</p>
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

function sourceMatches(item: assets.AssetItem, source: string): boolean {
  if (source === "upload") return item.source === "upload";
  if (source === "url") return item.source === "url";
  if (source === "product_signal") return item.source === "product_signal" || item.source === "product_ideas";
  if (source === "viral_pin") return item.source === "viral_pin";
  if (source === "pin_opportunity") return item.source === "pin_opportunity";
  return true;
}

function matchesCategory(text: string, category: string): boolean {
  if (category === "All Products" || category === "All" || category === "All categories") return true;
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
          background: "#0B1020",
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
    const emptyCopy = categoryLabel === "All Products"
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
        return (
          <AssetCard
            key={product.id}
            id={product.id}
            imageUrl={mapped.imageUrl}
            title={mapped.title}
            label="Product Ideas"
            category={mapped.category}
            selected={isSelected}
            onToggle={() => onToggleProduct(product)}
          />
        );
      })}
    </div>
  );
}

function CompactSection({
  title, items, selected, onToggle, portrait, empty, maxItems = 5,
  expanded, onViewAll,
}: {
  title: string;
  items: assets.AssetItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  portrait?: boolean;
  empty?: string;
  maxItems?: number;
  expanded?: boolean;
  onViewAll?: () => void;
}) {
  const sectionId = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const displayItems = expanded ? items : items.slice(0, maxItems);
  const hasMore = items.length > maxItems;

  return (
    <section data-testid={`asset-section-${sectionId}`} style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 800, color: UI.text }}>{title}</h3>
        {hasMore && !expanded && onViewAll && (
          <button
            type="button"
            data-testid={`view-all-${sectionId}`}
            onClick={onViewAll}
            style={{ background: "none", border: "none", padding: 0, fontSize: 11, fontWeight: 700, color: UI.textSec, cursor: "pointer" }}
          >
            View all
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 11, color: UI.muted }}>{empty ?? "Nothing here yet."}</p>
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: portrait
            ? "repeat(5, minmax(0, 1fr))"
            : "repeat(auto-fill, minmax(112px, 1fr))",
          gap: 10,
        }}>
          {displayItems.map(item => (
            <AssetCard
              key={item.id}
              id={item.id}
              imageUrl={item.imageUrl}
              title={item.title}
              label={assetLabel(item.source)}
              selected={selected.has(item.id)}
              portrait={portrait}
              onToggle={() => onToggle(item.id)}
            />
          ))}
        </div>
      )}
    </section>
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
          background: "#0D1423",
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
        background: "#0D1423",
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

export function InlineCreateAssetPicker({
  role, onClose, onConfirm, currentSelectedUrls = [],
}: InlineCreateAssetPickerProps) {
  const allAssets = useSyncExternalStore(assets.subscribe, assets.getAssets, assets.getServerAssets);
  const fileRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [productTab, setProductTab] = useState<typeof PRODUCT_PICKER_TABS[number]["id"]>("my_products");
  const [referenceTab, setReferenceTab] = useState<typeof REFERENCE_PICKER_TABS[number]["id"]>("my_references");
  const [productCategory, setProductCategory] = useState("All Products");
  const [referenceCategory, setReferenceCategory] = useState("All categories");
  const [referenceFormat, setReferenceFormat] = useState("All formats");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showProductUrlImport, setShowProductUrlImport] = useState(false);
  const [productFilter, setProductFilter] = useState<MyProductsFilter>("all");
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
    // Sync draft selection only when the picker opens or committed URLs change — not on every asset-store write.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(new Set(assets.getAssets().filter(a => a.role === role && currentSelectedUrls.includes(a.imageUrl)).map(a => a.id)));
    setSearch("");
    setShowUrlInput(false);
    setExpandedSections(new Set());
    setProductTab("my_products");
    setReferenceTab("my_references");
    setShowProductUrlImport(false);
    setProductFilter("all");
  }, [role, selectedUrlsKey, currentSelectedUrls]);

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

  function expandSection(key: string) {
    setExpandedSections(prev => new Set([...prev, key]));
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
    const mapped = mapProductIdeaToPickerAsset(product);
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
    });
    toggle(saved.id);
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
      .map(item => ({ id: item.id, imageUrl: item.imageUrl, title: item.title, category: item.category, keyword: item.keyword, source: item.source }));
    items.forEach(item => assets.markUsed(item.id));
    onConfirm(items);
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

  const uploadSource = myAssets.filter(a => sourceMatches(a, "upload"));
  const pinIdeasSource = myAssets.filter(a => sourceMatches(a, "viral_pin"));
  const urlSource = myAssets.filter(a => sourceMatches(a, "url"));
  const recentSource = [...myAssets].sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  const brokenImportCount = countBrokenImports(myAssets);
  const filteredMyProducts = filterMyProducts(myAssets, productFilter, search);

  const title = isProduct ? "Choose Product Images" : "Choose Pin References";
  const subtitle = isProduct
    ? "Select products or items to feature in your generated Pins."
    : referenceTab === "pin_ideas"
      ? "Browse Pin references for style, layout, mood, and composition."
      : "Select Pin images to guide style, layout, mood, and composition.";
  const tabs = isProduct ? PRODUCT_PICKER_TABS : REFERENCE_PICKER_TABS;
  const activeTab = isProduct ? productTab : referenceTab;
  const setActiveTab = (tab: string) => {
    setSearch("");
    if (isProduct) setProductTab(tab as typeof PRODUCT_PICKER_TABS[number]["id"]);
    else setReferenceTab(tab as typeof REFERENCE_PICKER_TABS[number]["id"]);
  };

  const selectedCountLabel = isProduct
    ? `${selected.size} product${selected.size === 1 ? "" : "s"} selected`
    : `${selected.size} reference${selected.size === 1 ? "" : "s"} selected`;

  return (
    <section
      data-testid={isProduct ? "product-picker" : "reference-picker"}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: UI.card, borderLeft: `1px solid ${UI.border}`, overflow: "hidden" }}
    >
      <header style={{ padding: "18px 20px 10px", borderBottom: `1px solid ${UI.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, color: UI.text, fontSize: 18, fontWeight: 800 }}>{title}</h2>
          <button
            type="button"
            data-testid="asset-picker-close"
            onClick={onClose}
            aria-label="Close picker"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, border: "none", background: "transparent", color: UI.textSec, cursor: "pointer", flexShrink: 0, marginTop: 2 }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = UI.cardElev; (e.currentTarget as HTMLButtonElement).style.color = UI.text; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = UI.textSec; }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>
        <p style={{ margin: "5px 0 14px", color: UI.textSec, fontSize: 12 }}>{subtitle}</p>
        <div data-testid="asset-picker-top-tabs" style={{ display: "flex", gap: 20 }}>
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
                  padding: "0 0 10px",
                  background: "none",
                  border: "none",
                  borderBottom: active ? `2px solid ${UI.purple}` : "2px solid transparent",
                  color: active ? "#C4B5FD" : UI.textSec,
                  fontSize: 12,
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
        <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
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
              <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 12, color: UI.textSec, textAlign: "center", padding: "24px 12px" }}>
                {productFilter === "import_issues"
                  ? "No import issues found."
                  : "No products match this filter yet."}
              </p>
            ) : filteredMyProducts.map(item => (
              <ProductLibraryCard
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                disabled={isBrokenProductImport(item)}
                onToggle={() => toggle(item.id)}
              />
            ))}
          </div>
        </div>
      )}

      {isProduct && productTab === "product_ideas" && (
        <>
          <div style={{ padding: 16, borderBottom: `1px solid ${UI.border}` }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search product ideas..." />
            {formatUpdatedAgo(productLastUpdated) && (
              <p data-testid="product-ideas-freshness" style={{ margin: "8px 0 0", fontSize: 10, color: isDataStale(productLastUpdated) ? "#F59E0B" : UI.muted }}>
                {formatUpdatedAgo(productLastUpdated)}
                {isDataStale(productLastUpdated) ? " · Data may be stale." : ""}
              </p>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
            <aside data-testid="product-ideas-category-sidebar" style={{ width: 148, flexShrink: 0, borderRight: `1px solid ${UI.border}`, padding: 12, overflowY: "auto" }}>
              {CATEGORIES.map(cat => (
                <button key={cat} type="button" onClick={() => setProductCategory(cat)}
                  style={{ width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 8, border: "none", background: productCategory === cat ? UI.purpleBg : "transparent", color: productCategory === cat ? "#C4B5FD" : UI.textSec, fontSize: 12, fontWeight: productCategory === cat ? 800 : 600, cursor: "pointer" }}>
                  {cat}
                </button>
              ))}
            </aside>
            <ProductIdeasPickerGrid
              search={search}
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

      {!isProduct && referenceTab === "my_references" && (
        <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search my references..." testId="search-my-references" />
            <button type="button" data-testid="compact-upload-reference" onClick={() => fileRef.current?.click()}
              style={{ padding: "0 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Upload style={{ width: 13, height: 13 }} /> Upload reference
            </button>
            <button type="button" data-testid="compact-import-url" onClick={() => setShowUrlInput(v => !v)}
              style={{ padding: "0 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, color: UI.text, fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Link2 style={{ width: 13, height: 13 }} /> Import from URL
            </button>
          </div>
          {showUrlInput && (
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <input value={urlText} onChange={e => setUrlText(e.target.value)} placeholder="Paste image URL..." style={{ flex: 1, borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: "#0D1423", color: UI.text, padding: "9px 12px", outline: "none" }} />
              <button type="button" onClick={importUrls} style={{ borderRadius: 9, border: "none", background: UI.gradient, color: "#fff", padding: "0 14px", fontWeight: 800, cursor: "pointer" }}>Import</button>
            </div>
          )}
          <CompactSection title="Recent" items={recentSource} selected={selected} onToggle={toggle} portrait expanded={expandedSections.has("recent")} onViewAll={() => expandSection("recent")} />
          <CompactSection title="Saved from Pin Ideas" items={pinIdeasSource} selected={selected} onToggle={toggle} portrait expanded={expandedSections.has("saved-from-pin-ideas")} onViewAll={() => expandSection("saved-from-pin-ideas")} />
          <CompactSection title="Uploaded References" items={uploadSource} selected={selected} onToggle={toggle} portrait expanded={expandedSections.has("uploaded-references")} onViewAll={() => expandSection("uploaded-references")} />
          <CompactSection title="URL Imported" items={urlSource} selected={selected} onToggle={toggle} portrait expanded={expandedSections.has("url-imported")} onViewAll={() => expandSection("url-imported")} />
        </div>
      )}

      {!isProduct && referenceTab === "pin_ideas" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="studio-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
            <div data-testid="pin-ideas-filters" style={{ marginBottom: 14 }}>
              {formatUpdatedAgo(pinLastUpdated) && (
                <p data-testid="pin-ideas-freshness" style={{ margin: "0 0 8px", fontSize: 10, color: isDataStale(pinLastUpdated) ? "#F59E0B" : UI.muted }}>
                  {formatUpdatedAgo(pinLastUpdated)}
                  {isDataStale(pinLastUpdated) ? " · Data may be stale." : ""}
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
