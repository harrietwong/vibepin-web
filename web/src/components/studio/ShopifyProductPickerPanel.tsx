"use client";

/**
 * ShopifyProductPickerPanel — shared Shopify product-picking surface (WP5, §3.5/§7.3/§7.4
 * of the Phase 1 implementation plan). Embedded by two hosts with two different outputs:
 *
 *   - mode="select-product" (ProductPickerModal's Shopify tab, StudioBoard's product→pin
 *     flow): picking a row calls `onSelectProduct(selection, images)` once — `selection`
 *     is a ProductSelection-compatible object (id/title/imageUrl/url/…) and `images` is
 *     the full list of images the user had checked (defaults to just the primary image).
 *   - mode="select-images" (InlineCreateAssetPicker's "From Shopify" source, used by the
 *     AI Drawer's multi-image Product images picker): expanding a row and checking images
 *     calls `onSelectImages(images, product)` for that one product's checked images.
 *
 * Neither mode ever creates a Pin draft or writes to My Products itself — callers own
 * that (§2: opening/browsing the picker never has side effects; only an explicit
 * selection action does).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, ExternalLink, Loader2, Package, RefreshCw, Search } from "lucide-react";
import { getShopifyStatus, listShopifyProducts, getShopifyProduct } from "@/lib/shopifyClient";
import type { ShopifyProductListItem, ShopifyProductDetail } from "@/lib/shopifyClient";
import { SETTINGS_SHOPIFY_PATH } from "@/lib/settingsPaths";

const UI = {
  card:      "var(--app-surface, #161D2E)",
  cardElev:  "var(--app-surface-3, #1A2236)",
  bg2:       "var(--app-surface-2, #111827)",
  border:    "var(--app-border, rgba(255,255,255,0.09))",
  borderStr: "var(--app-border-hi, rgba(255,255,255,0.12))",
  text:      "var(--app-text, #E2E8F0)",
  textSec:   "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #64748B)",
  purple:    "#7C3AED",
  green:     "#95BF47",
  success:   "#10B981",
  warning:   "#F59E0B",
  error:     "#EF4444",
  gradient:  "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
} as const;

export type ShopifyPanelImage = { url: string; alt?: string };

/** ProductSelection-compatible payload — callers merge in asPrimary/saveToLibrary/source. */
export type ShopifyProductSelectionCompat = {
  id: string;
  title: string;
  imageUrl?: string;
  url?: string;
  canonicalUrl?: string;
  store?: string;
  price?: string;
  currency?: string;
};

type SelectProductModeProps = {
  mode: "select-product";
  onSelectProduct: (selection: ShopifyProductSelectionCompat, images: ShopifyPanelImage[]) => void;
};

type SelectImagesModeProps = {
  mode: "select-images";
  onSelectImages: (images: ShopifyPanelImage[], product: { title: string; productUrl?: string }) => void;
};

export type ShopifyProductPickerPanelProps = (SelectProductModeProps | SelectImagesModeProps) & {
  /** Shop domain to disambiguate the "store" label when multiple connections exist. */
  storeLabel?: string;
};

type StatusFilter = "all" | "active" | "draft" | "archived";
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "draft", label: "Draft" },
  { id: "archived", label: "Archived" },
];

type ConnState = "checking" | "not_connected" | "ready";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function formatPrice(price: ShopifyProductListItem["price"]): string | null {
  if (price.amount == null) return null;
  const amount = Number(price.amount).toFixed(2);
  return price.currency ? `${price.currency} ${amount}` : amount;
}

function statusLabel(status: string): string {
  if (status === "active") return "Active";
  if (status === "draft") return "Draft";
  if (status === "archived") return "Archived";
  return status;
}

/**
 * Pure row → ProductSelection-compatible mapping (§3.5). Exported (rather than kept
 * as a closure) so the mapping — including price/currency/store — is unit-testable
 * without rendering the panel; the component calls this with `props.storeLabel`.
 */
export function shopifyProductToSelection(
  product: ShopifyProductListItem,
  storeLabel?: string,
): ShopifyProductSelectionCompat {
  return {
    id: product.id,
    title: product.title || "Product",
    imageUrl: product.primaryImageUrl ?? undefined,
    url: product.productUrl ?? undefined,
    canonicalUrl: product.productUrl ?? undefined,
    store: storeLabel,
    price: product.price.amount != null ? Number(product.price.amount).toFixed(2) : undefined,
    currency: product.price.currency ?? undefined,
  };
}

function Thumb({ src, size = 60 }: { src?: string | null; size?: number }) {
  const [err, setErr] = useState(false);
  const dim = { width: size, height: size };
  if (err || !src) {
    return (
      <div style={{ ...dim, borderRadius: 8, background: UI.cardElev, border: `1px solid ${UI.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Package style={{ width: size * 0.4, height: size * 0.4, color: UI.textMuted }} />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" onError={() => setErr(true)}
      style={{ ...dim, borderRadius: 8, objectFit: "cover", flexShrink: 0, border: `1px solid ${UI.border}` }} />
  );
}

function SkeletonRow() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.card }}>
      <div style={{ width: 60, height: 60, borderRadius: 8, background: "rgba(255,255,255,0.05)", animation: "vp-shopify-pulse 1.2s ease-in-out infinite", flexShrink: 0 }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ height: 10, width: "60%", borderRadius: 4, background: "rgba(255,255,255,0.06)" }} />
        <div style={{ height: 8, width: "35%", borderRadius: 4, background: "rgba(255,255,255,0.04)" }} />
      </div>
    </div>
  );
}

// ── Row detail (multi-image select + description + View in Shopify) ───────────

function RowDetail({
  detail, loading, error, checked, onToggleImage, onRetry,
}: {
  detail: ShopifyProductDetail | null;
  loading: boolean;
  error: string | null;
  checked: Set<string>;
  onToggleImage: (url: string) => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, color: UI.textMuted, fontSize: 11 }}>
        <Loader2 style={{ width: 13, height: 13, animation: "spin 0.8s linear infinite" }} /> Loading details…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <p style={{ margin: 0, fontSize: 11, color: UI.error }}>{error}</p>
        <button type="button" onClick={onRetry} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: `1px solid ${UI.borderStr}`, borderRadius: 7, padding: "4px 9px", color: UI.text, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
          <RefreshCw style={{ width: 11, height: 11 }} /> Retry
        </button>
      </div>
    );
  }
  if (!detail) return null;

  const desc = (detail.description ?? "").trim();
  const descSnippet = desc.length > 180 ? `${desc.slice(0, 180).trimEnd()}…` : desc;

  return (
    <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 10, borderTop: `1px solid ${UI.border}` }}>
      {detail.images.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(52px, 1fr))", gap: 6 }}>
          {detail.images.map(img => {
            const isChecked = checked.has(img.url);
            return (
              <button
                key={img.id}
                type="button"
                onClick={() => onToggleImage(img.url)}
                style={{
                  position: "relative", padding: 0, border: `2px solid ${isChecked ? UI.purple : UI.border}`,
                  borderRadius: 7, overflow: "hidden", cursor: "pointer", aspectRatio: "1/1", background: UI.bg2,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.altText ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                {isChecked && (
                  <div style={{ position: "absolute", top: 3, right: 3, width: 14, height: 14, borderRadius: "50%", background: UI.gradient, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#fff", fontWeight: 800 }}>✓</div>
                )}
              </button>
            );
          })}
        </div>
      )}
      {descSnippet && <p style={{ margin: 0, fontSize: 11, color: UI.textSec, lineHeight: 1.5 }}>{descSnippet}</p>}
      {detail.adminUrl && (
        <a href={detail.adminUrl} target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, color: "#818CF8", textDecoration: "none", width: "fit-content" }}>
          View in Shopify <ExternalLink style={{ width: 10, height: 10 }} />
        </a>
      )}
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────────────────

export function ShopifyProductPickerPanel(props: ShopifyProductPickerPanelProps) {
  const [connState, setConnState] = useState<ConnState>("checking");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [items, setItems] = useState<ShopifyProductListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, ShopifyProductDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [detailError, setDetailError] = useState<Record<string, string>>({});
  const [checkedByProduct, setCheckedByProduct] = useState<Record<string, Set<string>>>({});

  // Guards against a slow, superseded request clobbering a newer one's result.
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getShopifyStatus();
        if (cancelled) return;
        setConnState(status.configured && status.connections.length > 0 ? "ready" : "not_connected");
      } catch {
        if (!cancelled) setConnState("not_connected");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const runQuery = useCallback(async (cursor: string | null) => {
    const seq = ++requestSeq.current;
    if (cursor) setLoadingMore(true); else { setLoading(true); setError(null); }
    try {
      const result = await listShopifyProducts({
        q: debouncedSearch,
        status: statusFilter === "all" ? undefined : statusFilter,
        cursor,
        limit: 30,
      });
      if (seq !== requestSeq.current) return; // superseded
      setItems(prev => (cursor ? [...prev, ...result.products] : result.products));
      setNextCursor(result.nextCursor);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError((e as Error).message || "Could not load products.");
    } finally {
      if (seq === requestSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    if (connState !== "ready") return;
    void runQuery(null);
  }, [connState, runQuery]);

  function toggleExpand(product: ShopifyProductListItem) {
    const willExpand = expandedId !== product.id;
    setExpandedId(willExpand ? product.id : null);
    if (!willExpand) return;
    // Default check the primary image so a quick confirm always has ≥1 image.
    setCheckedByProduct(prev => (prev[product.id] ? prev : {
      ...prev,
      [product.id]: new Set(product.primaryImageUrl ? [product.primaryImageUrl] : []),
    }));
    if (detailCache[product.id] || detailLoading[product.id]) return;
    void loadDetail(product.id);
  }

  async function loadDetail(id: string) {
    setDetailLoading(prev => ({ ...prev, [id]: true }));
    setDetailError(prev => ({ ...prev, [id]: "" }));
    try {
      const detail = await getShopifyProduct(id);
      setDetailCache(prev => ({ ...prev, [id]: detail }));
      setCheckedByProduct(prev => {
        const existing = prev[id];
        if (existing && existing.size > 0) return prev;
        const first = detail.images[0]?.url ?? detail.primaryImageUrl ?? null;
        return { ...prev, [id]: new Set(first ? [first] : []) };
      });
    } catch (e) {
      setDetailError(prev => ({ ...prev, [id]: (e as Error).message || "Could not load product details." }));
    } finally {
      setDetailLoading(prev => ({ ...prev, [id]: false }));
    }
  }

  function toggleImage(productId: string, url: string) {
    setCheckedByProduct(prev => {
      const next = new Set(prev[productId] ?? []);
      if (next.has(url)) next.delete(url); else next.add(url);
      return { ...prev, [productId]: next };
    });
  }

  function imagesFor(product: ShopifyProductListItem): ShopifyPanelImage[] {
    const checked = checkedByProduct[product.id];
    const detail = detailCache[product.id];
    if (checked && checked.size > 0 && detail) {
      return detail.images.filter(img => checked.has(img.url)).map(img => ({ url: img.url, alt: img.altText ?? undefined }));
    }
    return product.primaryImageUrl ? [{ url: product.primaryImageUrl }] : [];
  }

  function handleQuickSelect(product: ShopifyProductListItem) {
    const images = imagesFor(product);
    if (props.mode === "select-product") {
      props.onSelectProduct(shopifyProductToSelection(product, props.storeLabel), images);
    } else {
      props.onSelectImages(images, { title: product.title || "Product", productUrl: product.productUrl ?? undefined });
    }
  }

  const showSkeleton = connState === "checking" || (connState === "ready" && loading && items.length === 0 && !error);
  const isEmptyStore = connState === "ready" && !loading && !error && items.length === 0
    && !debouncedSearch.trim() && statusFilter === "all";
  const isEmptyFiltered = connState === "ready" && !loading && !error && items.length === 0
    && (!!debouncedSearch.trim() || statusFilter !== "all");

  return (
    <div data-testid="shopify-picker-panel" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
      {connState === "ready" && (
        <>
          <div style={{ position: "relative" }}>
            <Search style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", width: 13, height: 13, color: UI.textMuted, pointerEvents: "none" }} />
            <input
              data-testid="shopify-picker-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search your Shopify products…"
              style={{
                width: "100%", boxSizing: "border-box", padding: "8px 10px 8px 30px", borderRadius: 8,
                border: `1px solid ${UI.borderStr}`, fontSize: 11, color: UI.text, background: UI.bg2, outline: "none",
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 5 }}>
            {STATUS_FILTERS.map(f => (
              <button key={f.id} type="button" data-testid={`shopify-picker-status-${f.id}`}
                onClick={() => setStatusFilter(f.id)}
                style={{
                  padding: "4px 10px", borderRadius: 999, border: `1px solid ${statusFilter === f.id ? UI.purple : UI.borderStr}`,
                  background: statusFilter === f.id ? "rgba(124,58,237,0.16)" : "transparent",
                  color: statusFilter === f.id ? "#C4B5FD" : UI.textSec, fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                }}>
                {f.label}
              </button>
            ))}
          </div>
        </>
      )}

      {connState === "not_connected" && (
        <div data-testid="shopify-picker-disconnected" style={{ padding: "24px 16px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <Package style={{ width: 28, height: 28, color: UI.textMuted }} />
          <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.6 }}>
            Connect your Shopify store in Settings to pick products here.
          </p>
          <Link href={SETTINGS_SHOPIFY_PATH} data-testid="shopify-picker-open-settings"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 8, border: "none", background: UI.gradient, color: "#fff", fontSize: 11.5, fontWeight: 700, textDecoration: "none" }}>
            Open Settings
          </Link>
        </div>
      )}

      {showSkeleton && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} />)}
        </div>
      )}

      {connState === "ready" && !showSkeleton && error && (
        <div data-testid="shopify-picker-error" style={{ padding: "20px 16px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: UI.textSec }}>{error}</p>
          <button type="button" data-testid="shopify-picker-retry" onClick={() => void runQuery(null)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, border: `1px solid ${UI.borderStr}`, background: UI.cardElev, color: UI.text, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
            <RefreshCw style={{ width: 12, height: 12 }} /> Retry
          </button>
        </div>
      )}

      {isEmptyStore && (
        <div data-testid="shopify-picker-empty-store" style={{ padding: "24px 16px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <Package style={{ width: 28, height: 28, color: UI.textMuted }} />
          <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.6 }}>
            No products synced yet — Sync now in Settings.
          </p>
          <Link href={SETTINGS_SHOPIFY_PATH} data-testid="shopify-picker-open-settings-sync"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 8, border: `1px solid ${UI.borderStr}`, background: UI.cardElev, color: UI.text, fontSize: 11.5, fontWeight: 700, textDecoration: "none" }}>
            Open Settings
          </Link>
        </div>
      )}

      {isEmptyFiltered && (
        <p data-testid="shopify-picker-empty-filtered" style={{ margin: 0, padding: "18px 12px", textAlign: "center", fontSize: 11.5, color: UI.textMuted }}>
          No products match your search.
        </p>
      )}

      {connState === "ready" && !showSkeleton && !error && items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map(product => {
            const expanded = expandedId === product.id;
            const price = formatPrice(product.price);
            const checked = checkedByProduct[product.id] ?? new Set<string>();
            return (
              <div key={product.id} data-testid="shopify-picker-row" style={{ borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.card, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}>
                  <Thumb src={product.primaryImageUrl} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: "0 0 3px", fontSize: 12, fontWeight: 700, color: UI.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {product.title || "Product"}
                    </p>
                    <p style={{ margin: 0, fontSize: 10.5, color: UI.textMuted }}>
                      <span style={{ color: UI.green, fontWeight: 700 }}>Shopify</span>
                      {" · "}{statusLabel(product.status)}
                      {price && <>{" · "}{price}</>}
                      {" · "}{product.imageCount} image{product.imageCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button type="button" data-testid="shopify-picker-expand" onClick={() => toggleExpand(product)}
                    aria-label={expanded ? "Hide details" : "Show details"}
                    style={{ background: "none", border: "none", cursor: "pointer", color: UI.textMuted, padding: 4, flexShrink: 0 }}>
                    {expanded ? <ChevronUp style={{ width: 14, height: 14 }} /> : <ChevronDown style={{ width: 14, height: 14 }} />}
                  </button>
                  <button type="button" data-testid="shopify-picker-select" onClick={() => handleQuickSelect(product)}
                    style={{ flexShrink: 0, padding: "6px 14px", borderRadius: 7, border: "none", background: UI.gradient, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                    {props.mode === "select-product" ? "Select" : `Add${checked.size > 1 ? ` (${checked.size})` : ""}`}
                  </button>
                </div>
                {expanded && (
                  <RowDetail
                    detail={detailCache[product.id] ?? null}
                    loading={!!detailLoading[product.id]}
                    error={detailError[product.id] || null}
                    checked={checked}
                    onToggleImage={url => toggleImage(product.id, url)}
                    onRetry={() => void loadDetail(product.id)}
                  />
                )}
              </div>
            );
          })}
          {nextCursor && (
            <button type="button" data-testid="shopify-picker-load-more" onClick={() => void runQuery(nextCursor)} disabled={loadingMore}
              style={{ alignSelf: "center", marginTop: 4, padding: "7px 16px", borderRadius: 8, border: `1px solid ${UI.borderStr}`, background: UI.cardElev, color: UI.text, fontSize: 11.5, fontWeight: 700, cursor: loadingMore ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {loadingMore ? <Loader2 style={{ width: 12, height: 12, animation: "spin 0.8s linear infinite" }} /> : null}
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
      <style>{`@keyframes vp-shopify-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
    </div>
  );
}
