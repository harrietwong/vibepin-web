"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown, ExternalLink, Heart,
  ImageOff, Loader2, Minus, PackageOpen, Search, Sparkles, X,
} from "lucide-react";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchProductOpportunity, fetchProductOpportunities, fetchSavedProductOpportunities,
  setProductOpportunitySaved,
} from "@/lib/productOpportunitiesClient";
import { track } from "@/lib/analytics";
import type { ProductOpportunityItem, SavedProductOpportunity } from "@/lib/server/productOpportunities";
import { buildPrefillFromProductOpportunity, openCreatePinsWithDraft } from "@/lib/createPinsPrefill";
import { freshAccessToken } from "@/lib/supabaseBrowser";
import styles from "./ProductOpportunitiesV1.module.css";

type Family = "all" | "physical" | "digital";
type Mode = "catalog" | "saved";
type SavedState = "loading" | "ready" | "error";
const PAGE_SIZE = 48;

function number(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function productDetailsLabel(item: ProductOpportunityItem): string {
  const name = item.productName?.trim();
  return name
    ? `Product details: ${name}`
    : `Product details from ${item.merchant || item.domain || "merchant site"}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  fashion: "Fashion",
  "home-decor": "Home Decor",
  "wedding-celebrations": "Wedding & Celebrations",
  gifts: "Gifts",
  "jewelry-accessories": "Jewelry & Accessories",
  "digital-products": "Digital Products",
};

function categoryLabel(category: string | null): string | null {
  if (!category) return null;
  return CATEGORY_LABELS[category] ?? null;
}

function metricsEnabled(item: ProductOpportunityItem): boolean {
  return item.productFamily === "physical"
    ? process.env.NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED === "true"
    : process.env.NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED === "true";
}

function Momentum({ item }: { item: ProductOpportunityItem }) {
  if (!item.recentMomentum) return null;
  const content = {
    rising: { icon: ArrowUpRight, text: "Growing faster", className: styles.rising },
    steady: { icon: Minus, text: "Holding steady", className: styles.steady },
    cooling: { icon: ArrowDownRight, text: "Slowing recently", className: styles.cooling },
  }[item.recentMomentum];
  const Icon = content.icon;
  return <span className={`${styles.momentum} ${content.className}`}><Icon aria-hidden="true" />{content.text}{item.momentumPercent != null ? ` ${Math.abs(item.momentumPercent).toFixed(0)}%` : ""}</span>;
}

function ProductImage({ item, large = false }: { item: ProductOpportunityItem; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className={`${styles.imageFallback} ${large ? styles.imageFallbackLarge : ""}`}><ImageOff aria-hidden="true" /><span>Image could not be loaded</span></div>;
  return (
    // Merchant image hosts are dynamic and cannot be exhaustively listed in next/image config.
    // eslint-disable-next-line @next/next/no-img-element
    <img className={large ? styles.detailImage : styles.cardImage} src={item.productImageUrl} alt={item.productName?.trim() || ""} onError={() => setFailed(true)} />
  );
}

type ProductCardProps = {
  item: ProductOpportunityItem; saved: boolean; saving: boolean; savedState: SavedState;
  mode: Mode;
  onOpen: () => void; onSave: () => void; onCreate: () => void;
};

function ProductCard({ item, saved, saving, savedState, mode, onOpen, onSave, onCreate }: ProductCardProps) {
  const showMetrics = metricsEnabled(item);
  return (
    <article className={styles.card} data-testid="product-opportunity-card">
      <button className={styles.imageButton} onClick={onOpen} aria-label={productDetailsLabel(item)}>
        <ProductImage item={item} />
        <span className={styles.family}>{item.productFamily === "digital" ? "Digital" : "Physical"}</span>
        {showMetrics && item.highRecentDemand === true ? <span className={styles.highDemand} title="Based on Pinterest saves gained in the last 30 days">High recent demand</span> : null}
      </button>
      <div className={styles.cardBody}>
        <div className={styles.sourceLine}><span>{item.merchant || item.domain}</span>{item.productType ? <span>{item.productType}</span> : categoryLabel(item.category) ? <span>{categoryLabel(item.category)}</span> : null}</div>
        {item.productName?.trim() ? <button className={styles.cardTitle} onClick={onOpen}>{item.productName}</button> : null}
        {showMetrics && (item.savesGained30d != null || item.latestPinterestSaves != null || item.recentMomentum != null) ? <div className={styles.signalRow}>
          {item.savesGained30d != null ? (
            <div className={styles.signalBlock}><strong>+{number(item.savesGained30d)}</strong><span>Pinterest saves in 30 days</span></div>
          ) : item.latestPinterestSaves != null ? (
            <div className={styles.signalBlock}><strong>{number(item.latestPinterestSaves)}</strong><span>Pinterest saves</span></div>
          ) : null}
          <Momentum item={item} />
        </div> : null}
        <div className={styles.actions}>
          <button className={`${styles.saveButton} ${savedState === "ready" && saved ? styles.savedButton : ""}`} onClick={onSave} disabled={saving || savedState !== "ready"} aria-pressed={savedState === "ready" ? saved : undefined}>
            {saving || savedState === "loading" ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Heart aria-hidden="true" />}{savedState === "loading" ? "Checking…" : savedState === "error" ? "Check saved items" : saved ? "Saved" : "Save"}
          </button>
          <button className={styles.createButton} onClick={onCreate}><Sparkles aria-hidden="true" />Create Pin</button>
        </div>
        <div className={styles.sourceTrail} aria-label="Product and Pinterest links">
          <a href={item.pinterestUrl} target="_blank" rel="noreferrer" onClick={() => track("pinterest_evidence_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "card" })}>Pinterest <ExternalLink aria-hidden="true" /></a>
          <span aria-hidden="true" /><a href={item.productUrl} target="_blank" rel="noreferrer" onClick={() => track("external_product_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "card" })}>View Product <ExternalLink aria-hidden="true" /></a>
        </div>
      </div>
    </article>
  );
}

function ProductDetail({ item, saved, saving, savedState, mode, detailsLoading, detailsError, onClose, onSave, onCreate }: ProductCardProps & {
  detailsLoading: boolean;
  detailsError: string | null;
  onClose: () => void;
}) {
  const showMetrics = metricsEnabled(item);
  const hasMetricFacts = item.savesGained30d != null
    || item.latestPinterestSaves != null
    || item.currentSavesGained7d != null
    || item.previousSavesGained7d != null;
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className={styles.modalBackdrop} onMouseDown={onClose}>
      <section className={styles.modal} role="dialog" aria-modal="true" aria-label={productDetailsLabel(item)} onMouseDown={(event) => event.stopPropagation()}>
        <button className={styles.closeButton} onClick={onClose} aria-label="Close product details"><X aria-hidden="true" /></button>
        <div className={styles.modalMedia}><ProductImage item={item} large /></div>
        <div className={styles.modalBody}>
          <p className={styles.modalEyebrow}>{item.merchant || item.domain}</p>
          {item.productName?.trim() ? <h2>{item.productName}</h2> : null}
          <div className={styles.modalTags}><span>{item.productFamily === "digital" ? "Digital product" : "Physical product"}</span>{item.productType ? <span>{item.productType}</span> : null}{categoryLabel(item.category) && categoryLabel(item.category) !== item.productType ? <span>{categoryLabel(item.category)}</span> : null}</div>
          {showMetrics && hasMetricFacts ? <div className={styles.detailSignals}>
            {item.savesGained30d != null ? <div><span>30-day saves gained</span><strong>+{number(item.savesGained30d)} saves</strong><small>Based on Pinterest saves gained in the last 30 days</small></div> : null}
            {item.latestPinterestSaves != null ? <div><span>Total Pinterest saves</span><strong>{number(item.latestPinterestSaves)} saves</strong></div> : null}
            {item.currentSavesGained7d != null ? <div><span>Current 7 days</span><strong>+{number(item.currentSavesGained7d)} saves</strong></div> : null}
            {item.previousSavesGained7d != null ? <div><span>Previous 7 days</span><strong>+{number(item.previousSavesGained7d)} saves</strong></div> : null}
            {item.recentMomentum ? <div><span>Recent direction</span><strong><Momentum item={item} /></strong><small>Compares the latest 7 days with the 7 days before</small></div> : null}
            {item.latestPinterestSnapshotAt ? <div><span>Last updated</span><strong>{dateTime(item.latestPinterestSnapshotAt)}</strong></div> : null}
          </div> : null}
          <div className={styles.modalLinks}><a href={item.pinterestUrl} target="_blank" rel="noreferrer" onClick={() => track("pinterest_evidence_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "modal", reference: "primary" })}>{item.pinterestEvidenceType === "product_pin" ? "Product Pin on Pinterest" : "Source Pin on Pinterest"} <ExternalLink aria-hidden="true" /></a></div>
          {detailsLoading ? <p className={styles.referenceStatus}><Loader2 className={styles.spin} aria-hidden="true" />Loading more Pinterest references…</p> : null}
          {detailsError ? <p className={styles.referenceStatus}>More Pinterest references could not be loaded.</p> : null}
          {item.additionalPinterestEvidence.length > 0 ? <section className={styles.additionalReferences} aria-label="More Pinterest references">
            <h3>More Pinterest references</h3>
            <div>{item.additionalPinterestEvidence.map((reference, index) => <a key={`${reference.pinterestUrl}:${index}`} href={reference.pinterestUrl} target="_blank" rel="noreferrer" onClick={() => track("pinterest_evidence_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "modal", reference: "additional" })}>{reference.pinterestEvidenceType === "product_pin" ? "Product Pin reference" : "Source Pin reference"} <ExternalLink aria-hidden="true" /></a>)}</div>
            <p>These links help verify the product. Trend figures use only the primary Pinterest reference above.</p>
          </section> : null}
          <div className={styles.modalLinks}><a href={item.productUrl} target="_blank" rel="noreferrer" onClick={() => track("external_product_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "modal" })}>View product page <ExternalLink aria-hidden="true" /></a></div>
          <div className={styles.modalActions}>
            <button className={`${styles.saveButton} ${savedState === "ready" && saved ? styles.savedButton : ""}`} onClick={onSave} disabled={saving || savedState !== "ready"} aria-pressed={savedState === "ready" ? saved : undefined}>{saving || savedState === "loading" ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Heart aria-hidden="true" />}{savedState === "loading" ? "Checking…" : savedState === "error" ? "Check saved items" : saved ? "Saved" : "Save"}</button>
            <button className={styles.createButton} onClick={onCreate}><Sparkles aria-hidden="true" />Create Pin</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SavedPlaceholder({ record, removing, onRemove }: {
  record: SavedProductOpportunity; removing: boolean; onRemove: () => void;
}) {
  const upgrade = record.requiresUpgrade;
  const history = record.historyItem;
  return (
    <article className={styles.historyCard} data-testid="saved-product-history-card">
      {history ? <div className={styles.historyImage}><ProductImage item={history} /></div> : <div className={styles.historyIcon}><Heart aria-hidden="true" /></div>}
      <div>
        <strong>{upgrade ? "Upgrade to view this saved item" : history?.productName?.trim() || "Saved item"}</strong>
        <p>{upgrade ? "Your saved record is still here. A paid plan restores the product details." : "This product is no longer in the discovery catalog. We kept the product and Pinterest references you saved."}</p>
        <small>Saved {new Date(record.savedAt).toLocaleDateString()}</small>
        {history ? <div className={styles.historyLinks}><a href={history.productUrl} target="_blank" rel="noreferrer">Previous product page <ExternalLink aria-hidden="true" /></a><a href={history.pinterestUrl} target="_blank" rel="noreferrer">Pinterest reference <ExternalLink aria-hidden="true" /></a></div> : null}
      </div>
      <div className={styles.historyActions}>{upgrade ? <Link href="/pricing">View plans <ArrowRight aria-hidden="true" /></Link> : null}<button onClick={onRemove} disabled={removing}>{removing ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Heart aria-hidden="true" />}Remove</button></div>
    </article>
  );
}

export function ProductOpportunitiesV1({ mode = "catalog" }: { mode?: Mode }) {
  const router = useRouter();
  const requestSequence = useRef(0);
  const detailRequestSequence = useRef(0);
  const catalogViewTracked = useRef(false);
  const savedViewTracked = useRef(false);
  const [family, setFamily] = useState<Family>("all");
  const [draftSearch, setDraftSearch] = useState("");
  const [draftCategory, setDraftCategory] = useState("");
  const [draftPlatform, setDraftPlatform] = useState("");
  const [draftDemand, setDraftDemand] = useState<"" | "high_recent_demand">("");
  const [draftTrend, setDraftTrend] = useState<"" | "rising" | "steady" | "cooling">("");
  const [filters, setFilters] = useState({ search: "", category: "", platform: "", demand: "" as "" | "high_recent_demand", trend: "" as "" | "rising" | "steady" | "cooling" });
  const [sort, setSort] = useState<"most_saved" | "newest" | "fastest_growing">("most_saved");
  const [metricControls, setMetricControls] = useState({ available: false, family: null as "physical" | "digital" | null, metricVersion: null as number | null });
  const [items, setItems] = useState<ProductOpportunityItem[]>([]);
  const [savedRecords, setSavedRecords] = useState<SavedProductOpportunity[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savedState, setSavedState] = useState<SavedState>("loading");
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ProductOpportunityItem | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessibleCount, setAccessibleCount] = useState(0);
  const [hasLockedCatalog, setHasLockedCatalog] = useState(false);
  const [planAccess, setPlanAccess] = useState<"preview" | "full">("preview");

  const loadCatalog = useCallback(async (append = false) => {
    const requestId = ++requestSequence.current;
    append ? setLoadingMore(true) : setLoading(true); setError(null);
    try {
      const result = await fetchProductOpportunities({
        limit: PAGE_SIZE,
        offset: append ? items.length : 0,
        family: family === "all" ? undefined : family,
        search: filters.search || undefined,
        category: filters.category || undefined,
        platform: filters.platform || undefined,
        demand: filters.demand || undefined,
        trend: filters.trend || undefined,
        sort,
      });
      if (requestId !== requestSequence.current) return;
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setAccessibleCount(result.accessibleCount); setHasLockedCatalog(result.hasLockedCatalog); setPlanAccess(result.planAccess); setMetricControls(result.metricControls);
      if (!append && !catalogViewTracked.current) {
        catalogViewTracked.current = true;
        track("product_opportunities_viewed", {
          productFamily: family,
          itemsReturned: result.items.length,
          planAccess: result.planAccess,
        });
      }
    } catch (reason) {
      if (requestId === requestSequence.current) setError(reason instanceof Error ? reason.message : "Product opportunities could not be loaded");
    } finally {
      if (requestId === requestSequence.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [family, filters, items.length, sort]);

  const loadSaved = useCallback(async () => {
    setLoading(true); setSavedState("loading"); setError(null);
    try {
      const records = await fetchSavedProductOpportunities();
      setSavedRecords(records); setSavedIds(new Set(records.map((record) => record.productOpportunityId)));
      setSavedState("ready");
      if (!savedViewTracked.current) {
        savedViewTracked.current = true;
        track("saved_products_viewed", { savedCount: records.length });
      }
    }
    catch (reason) { setSavedState("error"); setError(reason instanceof Error ? reason.message : "Saved products could not be loaded"); }
    finally { setLoading(false); }
  }, []);

  const loadCatalogSavedState = useCallback(async () => {
    setSavedState("loading");
    try {
      const records = await fetchSavedProductOpportunities();
      setSavedRecords(records);
      setSavedIds(new Set(records.map((record) => record.productOpportunityId)));
      setSavedState("ready");
    } catch {
      setSavedState("error");
    }
  }, []);

  useEffect(() => { if (mode === "saved") void loadSaved(); }, [loadSaved, mode]);
  useEffect(() => {
    if (mode !== "catalog") return;
    void loadCatalog(false);
    void loadCatalogSavedState();
    // loadCatalog owns reloads when the family changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, filters, loadCatalogSavedState, mode, sort]);

  const visibleSaved = useMemo(() => savedRecords.filter((record) => family === "all" || (record.item ?? record.historyItem)?.productFamily === family), [family, savedRecords]);
  const platformSuggestions = useMemo(() => [...new Set(items.map((item) => item.domain).filter((value): value is string => !!value))].sort(), [items]);

  const toggleSaved = useCallback(async (item: ProductOpportunityItem) => {
    if (savingIds.has(item.id) || savedState !== "ready") return;
    const next = !savedIds.has(item.id);
    setSavingIds((current) => new Set(current).add(item.id));
    setSavedIds((current) => { const updated = new Set(current); next ? updated.add(item.id) : updated.delete(item.id); return updated; });
    try {
      await setProductOpportunitySaved(item.id, next);
      const analyticsPayload = {
        productOpportunityId: item.id,
        productFamily: item.productFamily,
        mode,
      };
      if (next) track("product_saved", analyticsPayload);
      else track("product_unsaved", analyticsPayload);
      toast.success(next ? "Saved to Saved Products" : "Removed from Saved Products");
      if (mode === "saved") await loadSaved();
    }
    catch (reason) {
      setSavedIds((current) => { const updated = new Set(current); next ? updated.delete(item.id) : updated.add(item.id); return updated; });
      setError(reason instanceof Error ? reason.message : "Your saved products could not be updated");
    } finally { setSavingIds((current) => { const updated = new Set(current); updated.delete(item.id); return updated; }); }
  }, [loadSaved, mode, savedIds, savedState, savingIds]);

  const removeSavedHistory = useCallback(async (productOpportunityId: string) => {
    if (savingIds.has(productOpportunityId)) return;
    setSavingIds((current) => new Set(current).add(productOpportunityId));
    try {
      await setProductOpportunitySaved(productOpportunityId, false);
      track("product_unsaved", { productOpportunityId, mode: "saved", surface: "history" });
      toast.success("Removed from Saved Products");
      await loadSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your saved products could not be updated");
    } finally {
      setSavingIds((current) => { const updated = new Set(current); updated.delete(productOpportunityId); return updated; });
    }
  }, [loadSaved, savingIds]);

  const createPin = useCallback(async (item: ProductOpportunityItem) => {
    track("create_pin_from_product_clicked", {
      productOpportunityId: item.id,
      productFamily: item.productFamily,
      mode,
    });
    let token: string | null = null;
    try { token = await freshAccessToken(); } catch { /* sessionStorage fallback remains available */ }
    try {
      await openCreatePinsWithDraft(
        (url) => router.push(url),
        buildPrefillFromProductOpportunity(item),
        token,
      );
      toast.success("Product added to Create Pins");
    } catch {
      setError("This product could not be added to Create Pins. Please try again.");
      toast.error("Could not add product to Create Pins");
    }
  }, [mode, router]);
  const openDetails = useCallback(async (item: ProductOpportunityItem) => {
    const detailRequestId = ++detailRequestSequence.current;
    track("product_card_opened", { productOpportunityId: item.id, productFamily: item.productFamily, mode });
    setSelected(item);
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const detailed = await fetchProductOpportunity(item.id);
      if (detailRequestId === detailRequestSequence.current) {
        setSelected((current) => current?.id === item.id ? detailed : current);
      }
    } catch (reason) {
      if (detailRequestId === detailRequestSequence.current) {
        setDetailsError(reason instanceof Error ? reason.message : "Product details could not be loaded");
      }
    } finally {
      if (detailRequestId === detailRequestSequence.current) setDetailsLoading(false);
    }
  }, [mode]);
  const catalogRows = mode === "catalog" ? items : visibleSaved.flatMap((record) => record.item ? [record.item] : []);
  const canLoadMore = mode === "catalog" && planAccess === "full" && items.length < accessibleCount;
  const chooseFamily = (value: Family) => {
    setFamily(value);
    setMetricControls({ available: false, family: null, metricVersion: null });
    setDraftDemand("");
    setDraftTrend("");
    setFilters((current) => ({ ...current, demand: "", trend: "" }));
    setSort((current) => current === "fastest_growing" ? "most_saved" : current);
  };
  const applyFilters = () => {
    if (draftDemand) {
      track("demand_filter_used", { productFamily: family, demand: draftDemand });
    }
    if (draftTrend) {
      track("trend_filter_used", { productFamily: family, trend: draftTrend });
    }
    setFilters({
      search: draftSearch.trim(),
      category: draftCategory.trim(),
      platform: draftPlatform.trim(),
      demand: draftDemand,
      trend: draftTrend,
    });
  };
  const clearFilters = () => {
    setDraftSearch("");
    setDraftCategory("");
    setDraftPlatform("");
    setDraftDemand("");
    setDraftTrend("");
    chooseFamily("all");
    setFilters({ search: "", category: "", platform: "", demand: "", trend: "" });
  };
  const hasCatalogFilters = family !== "all"
    || Boolean(filters.search || filters.category || filters.platform || filters.demand || filters.trend);
  const savedFamilyHasNoMatches = mode === "saved"
    && family !== "all"
    && savedRecords.length > 0
    && visibleSaved.length === 0;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>{mode === "saved" ? "Your shortlist" : "Daily product tracking"}</p><h1>{mode === "saved" ? "Saved Products" : "Product Opportunities"}</h1><p className={styles.subtitle}>{mode === "saved" ? "Return to products you want to compare or turn into a Pin." : "Real products with merchant images, Pinterest interest, and daily trend tracking."}</p></div>
        <Link className={styles.headerLink} href={mode === "saved" ? "/app/products" : "/app/products/saved"}>{mode === "saved" ? <PackageOpen aria-hidden="true" /> : <Heart aria-hidden="true" />}{mode === "saved" ? "Browse opportunities" : "Saved Products"}</Link>
      </header>
      <div className={styles.toolbar} role="group" aria-label="Product type">{(["all", "physical", "digital"] as const).map((value) => <button key={value} className={family === value ? styles.activeFilter : ""} onClick={() => chooseFamily(value)}>{value === "all" ? "All products" : value === "physical" ? "Physical" : "Digital"}</button>)}</div>
      {mode === "catalog" ? <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
        <label className={styles.searchField}><Search aria-hidden="true" /><input value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} placeholder="Search products, merchants, or categories" aria-label="Search Product Opportunities" /></label>
        <label><span>Category</span><select value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)}><option value="">All categories</option>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Platform</span><input list="product-opportunity-platforms" value={draftPlatform} onChange={(event) => setDraftPlatform(event.target.value)} placeholder="All platforms" /></label>
        <datalist id="product-opportunity-platforms">{platformSuggestions.map((value) => <option key={value} value={value} />)}</datalist>
        {metricControls.available ? <label><span>Demand</span><select value={draftDemand} onChange={(event) => setDraftDemand(event.target.value === "high_recent_demand" ? "high_recent_demand" : "")}><option value="">All demand levels</option><option value="high_recent_demand">High recent demand</option></select></label> : null}
        {metricControls.available ? <label><span>Trend</span><select value={draftTrend} onChange={(event) => { const value = event.target.value; setDraftTrend(value === "rising" || value === "steady" || value === "cooling" ? value : ""); }}><option value="">All recent trends</option><option value="rising">Growing faster</option><option value="steady">Holding steady</option><option value="cooling">Slowing recently</option></select></label> : null}
        <label><span>Sort</span><select value={sort} onChange={(event) => { const value = event.target.value; setSort(value === "newest" || (value === "fastest_growing" && metricControls.available) ? value : "most_saved"); }}><option value="most_saved">Most Saved</option><option value="newest">Newest Discovered</option>{metricControls.available ? <option value="fastest_growing">Fastest Growing</option> : null}</select></label>
        <button type="submit">Apply</button>
        {hasCatalogFilters ? <button type="button" className={styles.clearFilters} onClick={clearFilters}>Clear</button> : null}
      </form> : null}
      {error ? <div className={styles.error} role="alert">{error}<button onClick={() => mode === "saved" ? void loadSaved() : void loadCatalog(false)}>Try again</button></div> : null}
      {mode === "catalog" && savedState === "error" ? <div className={styles.error} role="alert">Your saved products could not be checked. Save buttons are paused so existing records are not shown incorrectly.<button onClick={() => void loadCatalogSavedState()}>Try again</button></div> : null}
      {loading ? <div className={styles.loading}><Loader2 className={styles.spin} aria-hidden="true" /><span>Loading product opportunities…</span></div>
        : catalogRows.length === 0 && (mode !== "saved" || visibleSaved.length === 0) ? <div className={styles.empty}><PackageOpen aria-hidden="true" /><h2>{mode === "saved" ? savedFamilyHasNoMatches ? "No saved products match this product type" : "No saved products yet" : hasCatalogFilters ? "No products match these filters" : "No products to show yet"}</h2><p>{mode === "saved" ? savedFamilyHasNoMatches ? "Choose All products to see every saved item." : "Save an opportunity to keep it here for later." : hasCatalogFilters ? "Try changing or clearing your filters." : "New qualified products will appear after product discovery and review."}</p>{mode === "saved" ? savedFamilyHasNoMatches ? <button type="button" onClick={() => chooseFamily("all")}>Show all saved products</button> : <Link href="/app/products">Browse Product Opportunities</Link> : hasCatalogFilters ? <button type="button" onClick={clearFilters}>Clear filters</button> : null}</div>
        : <><section className={styles.grid} aria-label={mode === "saved" ? "Saved products" : "Product opportunities"}>{catalogRows.map((item) => <ProductCard key={item.id} item={item} saved={savedIds.has(item.id)} saving={savingIds.has(item.id)} savedState={savedState} mode={mode} onOpen={() => void openDetails(item)} onSave={() => void toggleSaved(item)} onCreate={() => createPin(item)} />)}</section>{mode === "saved" ? visibleSaved.filter((record) => !record.item).map((record) => <SavedPlaceholder key={record.productOpportunityId} record={record} removing={savingIds.has(record.productOpportunityId)} onRemove={() => void removeSavedHistory(record.productOpportunityId)} />) : null}</>}
      {hasLockedCatalog && mode === "catalog" ? <aside className={styles.upgradePanel}><div><Heart aria-hidden="true" /><span>Free includes 10 complete Product Opportunities</span></div><p>Paid plans unlock the full catalog while keeping the same real product and trend data.</p><Link href="/pricing">View plans <ArrowRight aria-hidden="true" /></Link></aside> : null}
      {canLoadMore ? <button className={styles.loadMore} onClick={() => void loadCatalog(true)} disabled={loadingMore}>{loadingMore ? <Loader2 className={styles.spin} aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}{loadingMore ? "Loading…" : "Load more"}</button> : null}
      {selected ? <ProductDetail item={selected} saved={savedIds.has(selected.id)} saving={savingIds.has(selected.id)} savedState={savedState} mode={mode} detailsLoading={detailsLoading} detailsError={detailsError} onClose={() => { detailRequestSequence.current += 1; setSelected(null); setDetailsLoading(false); setDetailsError(null); }} onOpen={() => undefined} onSave={() => void toggleSaved(selected)} onCreate={() => createPin(selected)} /> : null}
    </main>
  );
}
