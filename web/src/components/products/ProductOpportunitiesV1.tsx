"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown, ExternalLink, Heart,
  Loader2, Minus, PackageOpen, Search, Sparkles, X,
} from "lucide-react";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchProductOpportunity, fetchProductOpportunities, fetchSavedProductOpportunities,
  productOpportunityErrorInfo, productOpportunityViewState, setProductOpportunitySaved,
  type ProductOpportunityErrorInfo, type ProductOpportunityResponseEvidence,
} from "@/lib/productOpportunitiesClient";
import { track } from "@/lib/analytics";
import type {
  ProductOpportunityItem,
  ProductOpportunityViewState,
  SavedProductOpportunity,
} from "@/lib/server/productOpportunities";
import { buildPrefillFromProductOpportunity, openCreatePinsWithDraft } from "@/lib/createPinsPrefill";
import { freshAccessToken } from "@/lib/supabaseBrowser";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import styles from "./ProductOpportunitiesV1.module.css";
import { ProductImageSurface } from "./ProductImageSurface";

type Family = "all" | "physical" | "digital";
type Mode = "catalog" | "saved";
type SavedState = "loading" | "ready" | "error";
type Translator = ReturnType<typeof useLocale>["t"];
const PAGE_SIZE = 48;

function number(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

function dateTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function productDetailsLabel(item: ProductOpportunityItem, tr: Translator): string {
  const name = item.productName?.trim();
  return name
    ? `${tr("products.opportunities.productDetails")}: ${name}`
    : `${tr("products.opportunities.productDetailsFrom")} ${item.merchant || item.domain || tr("products.opportunities.merchantSite")}`;
}

const CATEGORY_LABEL_KEYS: Record<string, Parameters<Translator>[0]> = {
  fashion: "products.opportunities.categoryFashion",
  "home-decor": "products.opportunities.categoryHomeDecor",
  "wedding-celebrations": "products.opportunities.categoryWedding",
  gifts: "products.opportunities.categoryGifts",
  "jewelry-accessories": "products.opportunities.categoryJewelry",
  "digital-products": "products.opportunities.categoryDigital",
};

function categoryLabel(category: string | null, tr: Translator): string | null {
  if (!category) return null;
  const key = CATEGORY_LABEL_KEYS[category];
  return key ? tr(key) : null;
}

function metricsEnabled(item: ProductOpportunityItem): boolean {
  return item.productFamily === "physical"
    ? process.env.NEXT_PUBLIC_PRODUCT_METRICS_PHYSICAL_ENABLED === "true"
    : process.env.NEXT_PUBLIC_PRODUCT_METRICS_DIGITAL_ENABLED === "true";
}

function Momentum({ item }: { item: ProductOpportunityItem }) {
  const { t: tr, preferences } = useLocale();
  if (!item.recentMomentum) return null;
  const content = {
    rising: { icon: ArrowUpRight, text: tr("products.opportunities.rising"), className: styles.rising },
    steady: { icon: Minus, text: tr("products.opportunities.steady"), className: styles.steady },
    cooling: { icon: ArrowDownRight, text: tr("products.opportunities.cooling"), className: styles.cooling },
  }[item.recentMomentum];
  const Icon = content.icon;
  return <span className={`${styles.momentum} ${content.className}`}><Icon aria-hidden="true" />{content.text}{item.momentumPercent != null ? ` ${new Intl.NumberFormat(preferences.appLanguage, { maximumFractionDigits: 0 }).format(Math.abs(item.momentumPercent))}%` : ""}</span>;
}

function ProductImage({ item, large = false }: { item: ProductOpportunityItem; large?: boolean }) {
  return <ProductImageSurface className={large ? styles.detailImage : styles.cardImage} src={item.productImageUrl} alt={item.productName?.trim() || ""} />;
}

function ErrorEvidence({ error }: { error: ProductOpportunityErrorInfo }) {
  const { t: tr } = useLocale();
  const notReported = tr("products.opportunities.notReported");
  const safeMessage = error.code === "AUTH_REQUIRED"
    ? tr("products.opportunities.authRequiredBody")
    : error.code === "REQUEST_TIMEOUT"
      ? tr("products.opportunities.timeoutError")
      : error.code === "NETWORK_ERROR"
        ? tr("products.opportunities.networkError")
        : error.code === "INVALID_RESPONSE"
          ? tr("products.opportunities.invalidResponseError")
          : tr("products.opportunities.apiErrorBody");
  return (
    <div className={styles.errorCopy}>
      <span>{safeMessage}</span>
      <small data-testid="product-error-evidence">
        {`${tr("products.opportunities.evidenceMethod")} ${error.method} · ${tr("products.opportunities.evidencePath")} ${error.path} · ${tr("products.opportunities.evidenceStatus")} ${error.status ?? notReported} · ${tr("products.opportunities.evidenceCode")} ${error.code}`}
        {` · ${tr("products.opportunities.evidenceRequest")} ${error.requestId ?? notReported} · ${tr("products.opportunities.evidenceTime")} ${error.occurredAt}`}
        {` · ${tr("products.opportunities.evidenceRuntime")} ${error.runtime ?? notReported} · ${tr("products.opportunities.evidenceDeployment")} ${error.deployment ?? notReported}`}
      </small>
    </div>
  );
}

type ProductCardProps = {
  item: ProductOpportunityItem; saved: boolean; saving: boolean; savedState: SavedState;
  mode: Mode;
  onOpen: () => void; onSave: () => void; onCreate: () => void;
};

function ProductCard({ item, saved, saving, savedState, mode, onOpen, onSave, onCreate }: ProductCardProps) {
  const { t: tr, preferences } = useLocale();
  const showMetrics = metricsEnabled(item);
  return (
    <article className={styles.card} data-testid="product-opportunity-card">
      <button className={styles.imageButton} onClick={onOpen} aria-label={productDetailsLabel(item, tr)}>
        <ProductImage item={item} />
        <span className={styles.family}>{item.productFamily === "digital" ? tr("products.opportunities.typeDigital") : tr("products.opportunities.typePhysical")}</span>
        {showMetrics && item.highRecentDemand === true ? <span className={styles.highDemand} title={tr("products.opportunities.highDemandBasis")}>{tr("products.opportunities.highDemand")}</span> : null}
      </button>
      <div className={styles.cardBody}>
        <div className={styles.sourceLine}><span>{item.merchant || item.domain}</span>{item.productType ? <span>{item.productType}</span> : categoryLabel(item.category, tr) ? <span>{categoryLabel(item.category, tr)}</span> : null}</div>
        <p className={styles.provenance} data-testid="product-provenance">{tr("products.opportunities.provenanceOpportunity")} · {item.pinterestEvidenceType === "product_pin" ? tr("products.opportunities.productPinEvidence") : tr("products.opportunities.sourcePinEvidence")}{item.latestPinterestSnapshotAt ? ` · ${tr("products.opportunities.updated")} ${dateTime(item.latestPinterestSnapshotAt, preferences.appLanguage)}` : ""}</p>
        {item.productName?.trim() ? <button className={styles.cardTitle} onClick={onOpen}>{item.productName}</button> : null}
        {showMetrics && (item.savesGained30d != null || item.latestPinterestSaves != null || item.recentMomentum != null) ? <div className={styles.signalRow}>
          {item.savesGained30d != null ? (
            <div className={styles.signalBlock}><strong>+{number(item.savesGained30d, preferences.appLanguage)}</strong><span>{tr("products.opportunities.saves30d")}</span></div>
          ) : item.latestPinterestSaves != null ? (
            <div className={styles.signalBlock}><strong>{number(item.latestPinterestSaves, preferences.appLanguage)}</strong><span>{tr("products.opportunities.pinterestSaves")}</span></div>
          ) : null}
          <Momentum item={item} />
        </div> : null}
        <div className={styles.actions}>
          <button className={`${styles.saveButton} ${savedState === "ready" && saved ? styles.savedButton : ""}`} onClick={onSave} disabled={saving || savedState !== "ready"} aria-pressed={savedState === "ready" ? saved : undefined}>
            {saving || savedState === "loading" ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Heart aria-hidden="true" />}{savedState === "loading" ? tr("products.opportunities.checkingSaved") : savedState === "error" ? tr("products.opportunities.checkSaved") : saved ? tr("products.opportunities.saved") : tr("products.opportunities.save")}
          </button>
          <button className={styles.createButton} onClick={onCreate}><Sparkles aria-hidden="true" />{tr("products.opportunities.createPin")}</button>
        </div>
        <div className={styles.sourceTrail} aria-label={tr("products.opportunities.productLinks")}>
          <a href={item.pinterestUrl} target="_blank" rel="noreferrer" onClick={() => track("pinterest_evidence_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "card" })}>{tr("products.opportunities.pinterest")} <ExternalLink aria-hidden="true" /></a>
          <span aria-hidden="true" /><a href={item.productUrl} target="_blank" rel="noreferrer" onClick={() => track("external_product_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "card" })}>{tr("products.opportunities.viewProduct")} <ExternalLink aria-hidden="true" /></a>
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
  const { t: tr, preferences } = useLocale();
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
      <section className={styles.modal} role="dialog" aria-modal="true" aria-label={productDetailsLabel(item, tr)} onMouseDown={(event) => event.stopPropagation()}>
        <button className={styles.closeButton} onClick={onClose} aria-label={tr("products.opportunities.closeDetails")}><X aria-hidden="true" /></button>
        <div className={styles.modalMedia}><ProductImage item={item} large /></div>
        <div className={styles.modalBody}>
          <p className={styles.modalEyebrow}>{item.merchant || item.domain}</p>
          {item.productName?.trim() ? <h2>{item.productName}</h2> : null}
          <div className={styles.modalTags}><span>{item.productFamily === "digital" ? tr("products.opportunities.digitalProduct") : tr("products.opportunities.physicalProduct")}</span>{item.productType ? <span>{item.productType}</span> : null}{categoryLabel(item.category, tr) && categoryLabel(item.category, tr) !== item.productType ? <span>{categoryLabel(item.category, tr)}</span> : null}</div>
          {showMetrics && hasMetricFacts ? <div className={styles.detailSignals}>
            {item.savesGained30d != null ? <div><span>{tr("products.opportunities.saves30dGained")}</span><strong>+{number(item.savesGained30d, preferences.appLanguage)} {tr("products.opportunities.saves")}</strong><small>{tr("products.opportunities.saves30dBasis")}</small></div> : null}
            {item.latestPinterestSaves != null ? <div><span>{tr("products.opportunities.totalPinterestSaves")}</span><strong>{number(item.latestPinterestSaves, preferences.appLanguage)} {tr("products.opportunities.saves")}</strong></div> : null}
            {item.currentSavesGained7d != null ? <div><span>{tr("products.opportunities.current7d")}</span><strong>+{number(item.currentSavesGained7d, preferences.appLanguage)} {tr("products.opportunities.saves")}</strong></div> : null}
            {item.previousSavesGained7d != null ? <div><span>{tr("products.opportunities.previous7d")}</span><strong>+{number(item.previousSavesGained7d, preferences.appLanguage)} {tr("products.opportunities.saves")}</strong></div> : null}
            {item.recentMomentum ? <div><span>{tr("products.opportunities.recentDirection")}</span><strong><Momentum item={item} /></strong><small>{tr("products.opportunities.momentumBasis")}</small></div> : null}
            {item.latestPinterestSnapshotAt ? <div><span>{tr("products.opportunities.lastUpdated")}</span><strong>{dateTime(item.latestPinterestSnapshotAt, preferences.appLanguage)}</strong></div> : null}
          </div> : null}
          <div className={styles.modalLinks}><a href={item.pinterestUrl} target="_blank" rel="noreferrer" onClick={() => track("pinterest_evidence_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "modal", reference: "primary" })}>{item.pinterestEvidenceType === "product_pin" ? tr("products.opportunities.productPinOnPinterest") : tr("products.opportunities.sourcePinOnPinterest")} <ExternalLink aria-hidden="true" /></a></div>
          {detailsLoading ? <p className={styles.referenceStatus}><Loader2 className={styles.spin} aria-hidden="true" />{tr("products.opportunities.loadingReferences")}</p> : null}
          {detailsError ? <p className={styles.referenceStatus}>{tr("products.opportunities.referencesError")}</p> : null}
          {item.additionalPinterestEvidence.length > 0 ? <section className={styles.additionalReferences} aria-label={tr("products.opportunities.moreReferences")}>
            <h3>{tr("products.opportunities.moreReferences")}</h3>
            <div>{item.additionalPinterestEvidence.map((reference, index) => <a key={`${reference.pinterestUrl}:${index}`} href={reference.pinterestUrl} target="_blank" rel="noreferrer" onClick={() => track("pinterest_evidence_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "modal", reference: "additional" })}>{reference.pinterestEvidenceType === "product_pin" ? tr("products.opportunities.productPinReference") : tr("products.opportunities.sourcePinReference")} <ExternalLink aria-hidden="true" /></a>)}</div>
            <p>{tr("products.opportunities.additionalEvidenceNote")}</p>
          </section> : null}
          <div className={styles.modalLinks}><a href={item.productUrl} target="_blank" rel="noreferrer" onClick={() => track("external_product_clicked", { productOpportunityId: item.id, productFamily: item.productFamily, mode, surface: "modal" })}>{tr("products.opportunities.viewProductPage")} <ExternalLink aria-hidden="true" /></a></div>
          <div className={styles.modalActions}>
            <button className={`${styles.saveButton} ${savedState === "ready" && saved ? styles.savedButton : ""}`} onClick={onSave} disabled={saving || savedState !== "ready"} aria-pressed={savedState === "ready" ? saved : undefined}>{saving || savedState === "loading" ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Heart aria-hidden="true" />}{savedState === "loading" ? tr("products.opportunities.checkingSaved") : savedState === "error" ? tr("products.opportunities.checkSaved") : saved ? tr("products.opportunities.saved") : tr("products.opportunities.save")}</button>
            <button className={styles.createButton} onClick={onCreate}><Sparkles aria-hidden="true" />{tr("products.opportunities.createPin")}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SavedPlaceholder({ record, removing, onRemove }: {
  record: SavedProductOpportunity; removing: boolean; onRemove: () => void;
}) {
  const { t: tr, preferences } = useLocale();
  const upgrade = record.requiresUpgrade;
  const history = record.historyItem;
  return (
    <article className={styles.historyCard} data-testid="saved-product-history-card">
      {history ? <div className={styles.historyImage}><ProductImage item={history} /></div> : <div className={styles.historyIcon}><Heart aria-hidden="true" /></div>}
      <div>
        <strong>{upgrade ? tr("products.opportunities.upgradeSaved") : history?.productName?.trim() || tr("products.opportunities.savedItem")}</strong>
        <p>{upgrade ? tr("products.opportunities.upgradeSavedBody") : tr("products.opportunities.historySavedBody")}</p>
        <small>{tr("products.opportunities.savedOn")} {new Intl.DateTimeFormat(preferences.appLanguage, { dateStyle: "medium" }).format(new Date(record.savedAt))}</small>
        {history ? <div className={styles.historyLinks}><a href={history.productUrl} target="_blank" rel="noreferrer">{tr("products.opportunities.previousProductPage")} <ExternalLink aria-hidden="true" /></a><a href={history.pinterestUrl} target="_blank" rel="noreferrer">{tr("products.opportunities.pinterestReference")} <ExternalLink aria-hidden="true" /></a></div> : null}
      </div>
      <div className={styles.historyActions}>{upgrade ? <Link href="/pricing">{tr("products.opportunities.viewPlans")} <ArrowRight aria-hidden="true" /></Link> : null}<button onClick={onRemove} disabled={removing}>{removing ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Heart aria-hidden="true" />}{tr("products.opportunities.remove")}</button></div>
    </article>
  );
}

export function ProductOpportunitiesV1({ mode = "catalog" }: { mode?: Mode }) {
  const { t: tr } = useLocale();
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
  const savedRecordsRef = useRef<SavedProductOpportunity[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savedState, setSavedState] = useState<SavedState>("loading");
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ProductOpportunityItem | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ProductOpportunityErrorInfo | null>(null);
  const [dataState, setDataState] = useState<ProductOpportunityViewState>("syncing");
  const [lastEvidence, setLastEvidence] = useState<ProductOpportunityResponseEvidence | null>(null);
  const [accessibleCount, setAccessibleCount] = useState(0);
  const [hasLockedCatalog, setHasLockedCatalog] = useState(false);
  const [planAccess, setPlanAccess] = useState<"preview" | "full">("preview");

  const loadCatalog = useCallback(async (append = false) => {
    const requestId = ++requestSequence.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    setDataState(items.length > 0 ? "syncing" : "loading");
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
      setLastEvidence(result.evidence);
      setDataState(productOpportunityViewState(result, null, result.items.length > 0));
      if (!append && !catalogViewTracked.current) {
        catalogViewTracked.current = true;
        track("product_opportunities_viewed", {
          productFamily: family,
          itemsReturned: result.items.length,
          planAccess: result.planAccess,
        });
      }
    } catch (reason) {
      if (requestId === requestSequence.current) {
        const info = productOpportunityErrorInfo(reason);
        setError(info);
        setDataState(productOpportunityViewState(null, info, items.length > 0));
      }
    } finally {
      if (requestId === requestSequence.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [family, filters, items.length, sort]);

  const loadSaved = useCallback(async () => {
    setLoading(true); setSavedState("loading"); setError(null); setDataState(savedRecordsRef.current.length > 0 ? "syncing" : "loading");
    try {
      const records = await fetchSavedProductOpportunities();
      savedRecordsRef.current = records;
      setSavedRecords(records); setSavedIds(new Set(records.map((record) => record.productOpportunityId)));
      setSavedState("ready");
      setDataState(records.length > 0 ? "success" : "catalog-empty");
      if (!savedViewTracked.current) {
        savedViewTracked.current = true;
        track("saved_products_viewed", { savedCount: records.length });
      }
    }
    catch (reason) {
      setSavedState("error");
      const info = productOpportunityErrorInfo(reason);
      setError(info);
      setDataState(productOpportunityViewState(null, info, savedRecordsRef.current.length > 0));
    }
    finally { setLoading(false); }
  }, []);

  const loadCatalogSavedState = useCallback(async () => {
    setSavedState("loading");
    try {
      const records = await fetchSavedProductOpportunities();
      savedRecordsRef.current = records;
      setSavedRecords(records);
      setSavedIds(new Set(records.map((record) => record.productOpportunityId)));
      setSavedState("ready");
    } catch {
      setSavedState("error");
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- effects initiate the external catalog request. */
  useEffect(() => { if (mode === "saved") void loadSaved(); }, [loadSaved, mode]);
  useEffect(() => {
    if (mode !== "catalog") return;
    void loadCatalog(false);
    void loadCatalogSavedState();
    // loadCatalog owns reloads when the family changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, filters, loadCatalogSavedState, mode, sort]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const visibleSaved = useMemo(() => savedRecords.filter((record) => family === "all" || (record.item ?? record.historyItem)?.productFamily === family), [family, savedRecords]);
  const platformSuggestions = useMemo(() => [...new Set(items.map((item) => item.domain).filter((value): value is string => !!value))].sort(), [items]);

  const toggleSaved = useCallback(async (item: ProductOpportunityItem) => {
    if (savingIds.has(item.id) || savedState !== "ready") return;
    const next = !savedIds.has(item.id);
    setSavingIds((current) => new Set(current).add(item.id));
    setSavedIds((current) => {
      const updated = new Set(current);
      if (next) updated.add(item.id);
      else updated.delete(item.id);
      return updated;
    });
    try {
      await setProductOpportunitySaved(item.id, next);
      const analyticsPayload = {
        productOpportunityId: item.id,
        productFamily: item.productFamily,
        mode,
      };
      if (next) track("product_saved", analyticsPayload);
      else track("product_unsaved", analyticsPayload);
      toast.success(next ? tr("products.opportunities.savedToast") : tr("products.opportunities.removedToast"));
      if (mode === "saved") await loadSaved();
    }
    catch (reason) {
      setSavedIds((current) => {
        const updated = new Set(current);
        if (next) updated.delete(item.id);
        else updated.add(item.id);
        return updated;
      });
      setError(productOpportunityErrorInfo(reason));
    } finally { setSavingIds((current) => { const updated = new Set(current); updated.delete(item.id); return updated; }); }
  }, [loadSaved, mode, savedIds, savedState, savingIds, tr]);

  const removeSavedHistory = useCallback(async (productOpportunityId: string) => {
    if (savingIds.has(productOpportunityId)) return;
    setSavingIds((current) => new Set(current).add(productOpportunityId));
    try {
      await setProductOpportunitySaved(productOpportunityId, false);
      track("product_unsaved", { productOpportunityId, mode: "saved", surface: "history" });
      toast.success(tr("products.opportunities.removedToast"));
      await loadSaved();
    } catch (reason) {
      setError(productOpportunityErrorInfo(reason));
    } finally {
      setSavingIds((current) => { const updated = new Set(current); updated.delete(productOpportunityId); return updated; });
    }
  }, [loadSaved, savingIds, tr]);

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
      toast.success(tr("products.opportunities.addedToCreatePins"));
    } catch {
      setError(productOpportunityErrorInfo(new Error(tr("products.opportunities.createPinError"))));
      toast.error(tr("products.opportunities.createPinError"));
    }
  }, [mode, router, tr]);
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
        setDetailsError(reason instanceof Error ? reason.message : tr("products.opportunities.detailsError"));
      }
    } finally {
      if (detailRequestId === detailRequestSequence.current) setDetailsLoading(false);
    }
  }, [mode, tr]);
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
  const dataRequestFailed = dataState === "api-error" || dataState === "auth-required";
  const showStatusNotice = dataState === "partial" || dataState === "stale" || (dataState === "syncing" && catalogRows.length > 0);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div><h1>{mode === "saved" ? tr("products.opportunities.savedTitle") : tr("products.opportunities.title")}</h1><p className={styles.subtitle}>{mode === "saved" ? tr("products.opportunities.savedSubtitle") : tr("products.opportunities.subtitle")}</p></div>
        <Link className={styles.headerLink} href={mode === "saved" ? "/app/products" : "/app/products/saved"}>{mode === "saved" ? <PackageOpen aria-hidden="true" /> : <Heart aria-hidden="true" />}{mode === "saved" ? tr("products.opportunities.browse") : tr("products.opportunities.savedTitle")}</Link>
      </header>
      {mode === "catalog" ? <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
        <div className={styles.familyFilter} role="radiogroup" aria-label={tr("products.opportunities.filterProductType")}><span>{tr("products.opportunities.productType")}</span><div>{(["all", "physical", "digital"] as const).map((value) => <button type="button" role="radio" aria-checked={family === value} key={value} className={family === value ? styles.activeFilter : ""} onClick={() => chooseFamily(value)}>{value === "all" ? tr("products.opportunities.typeAll") : value === "physical" ? tr("products.opportunities.typePhysical") : tr("products.opportunities.typeDigital")}</button>)}</div></div>
        <label className={styles.searchField}><Search aria-hidden="true" /><input value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} placeholder={tr("products.opportunities.searchPlaceholder")} aria-label={tr("products.opportunities.searchLabel")} /></label>
        <label><span>{tr("products.opportunities.category")}</span><select value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)}><option value="">{tr("products.opportunities.allCategories")}</option>{Object.entries(CATEGORY_LABEL_KEYS).map(([value, key]) => <option key={value} value={value}>{tr(key)}</option>)}</select></label>
        <label><span>{tr("products.opportunities.platform")}</span><input list="product-opportunity-platforms" value={draftPlatform} onChange={(event) => setDraftPlatform(event.target.value)} placeholder={tr("products.opportunities.allPlatforms")} /></label>
        <datalist id="product-opportunity-platforms">{platformSuggestions.map((value) => <option key={value} value={value} />)}</datalist>
        {metricControls.available ? <label><span>{tr("products.opportunities.demand")}</span><select value={draftDemand} onChange={(event) => setDraftDemand(event.target.value === "high_recent_demand" ? "high_recent_demand" : "")}><option value="">{tr("products.opportunities.allDemand")}</option><option value="high_recent_demand">{tr("products.opportunities.highDemand")}</option></select></label> : null}
        {metricControls.available ? <label><span>{tr("products.opportunities.trend")}</span><select value={draftTrend} onChange={(event) => { const value = event.target.value; setDraftTrend(value === "rising" || value === "steady" || value === "cooling" ? value : ""); }}><option value="">{tr("products.opportunities.allTrends")}</option><option value="rising">{tr("products.opportunities.rising")}</option><option value="steady">{tr("products.opportunities.steady")}</option><option value="cooling">{tr("products.opportunities.cooling")}</option></select></label> : null}
        <label><span>{tr("products.opportunities.sort")}</span><select value={sort} onChange={(event) => { const value = event.target.value; setSort(value === "newest" || (value === "fastest_growing" && metricControls.available) ? value : "most_saved"); }}><option value="most_saved">{tr("products.opportunities.mostSaved")}</option><option value="newest">{tr("products.opportunities.newest")}</option>{metricControls.available ? <option value="fastest_growing">{tr("products.opportunities.fastestGrowing")}</option> : null}</select></label>
        <button type="submit">{tr("products.opportunities.apply")}</button>
        {hasCatalogFilters ? <button type="button" className={styles.clearFilters} onClick={clearFilters}>{tr("products.opportunities.clear")}</button> : null}
      </form> : <div className={styles.filters} role="group" aria-label={tr("products.opportunities.filterProductType")}><div className={styles.familyFilter} role="radiogroup"><span>{tr("products.opportunities.productType")}</span><div>{(["all", "physical", "digital"] as const).map((value) => <button type="button" role="radio" aria-checked={family === value} key={value} className={family === value ? styles.activeFilter : ""} onClick={() => chooseFamily(value)}>{value === "all" ? tr("products.opportunities.typeAll") : value === "physical" ? tr("products.opportunities.typePhysical") : tr("products.opportunities.typeDigital")}</button>)}</div></div></div>}
      {error ? <div className={styles.error} role="alert"><ErrorEvidence error={error} /><button onClick={() => mode === "saved" ? void loadSaved() : void loadCatalog(false)}>{tr("products.opportunities.retry")}</button></div> : null}
      {mode === "catalog" && savedState === "error" ? <div className={styles.error} role="alert">{tr("products.opportunities.savedCheckError")}<button onClick={() => void loadCatalogSavedState()}>{tr("products.opportunities.retry")}</button></div> : null}
      {showStatusNotice ? <div className={styles.statusNotice} data-testid={`product-state-${dataState}`} role="status">{dataState === "syncing" ? tr("products.opportunities.stateSyncing") : dataState === "stale" ? tr("products.opportunities.stateStale") : dataState === "partial" ? tr("products.opportunities.statePartial") : ""}{lastEvidence ? <small>{tr("products.opportunities.evidenceRequest")} {lastEvidence.requestId} · {tr("products.opportunities.evidenceTime")} {lastEvidence.occurredAt}</small> : null}</div> : null}
      {loading ? <div className={styles.loading} data-testid={`product-state-${dataState}`} aria-live="polite"><Loader2 className={styles.spin} aria-hidden="true" /><span>{dataState === "syncing" ? tr("products.opportunities.stateSyncing") : tr("products.opportunities.stateLoading")}</span></div>
        : dataRequestFailed && catalogRows.length === 0 ? <div className={styles.empty} data-testid={`product-state-${dataState}`}><PackageOpen aria-hidden="true" /><h2>{dataState === "auth-required" ? tr("products.opportunities.authRequiredTitle") : tr("products.opportunities.apiErrorTitle")}</h2><p>{dataState === "auth-required" ? tr("products.opportunities.authRequiredBody") : tr("products.opportunities.apiErrorBody")}</p></div>
        : catalogRows.length === 0 && (mode !== "saved" || visibleSaved.length === 0) ? <div className={styles.empty} data-testid={`product-state-${dataState}`}><PackageOpen aria-hidden="true" /><h2>{mode === "saved" ? savedFamilyHasNoMatches ? tr("products.opportunities.savedFilteredEmptyTitle") : tr("products.opportunities.savedEmptyTitle") : dataState === "filtered-empty" || hasCatalogFilters ? tr("products.opportunities.filteredEmptyTitle") : tr("products.opportunities.catalogEmptyTitle")}</h2><p>{mode === "saved" ? savedFamilyHasNoMatches ? tr("products.opportunities.savedFilteredEmptyBody") : tr("products.opportunities.savedEmptyBody") : dataState === "filtered-empty" || hasCatalogFilters ? tr("products.opportunities.filteredEmptyBody") : tr("products.opportunities.catalogEmptyBody")}</p>{mode === "saved" ? savedFamilyHasNoMatches ? <button type="button" onClick={() => chooseFamily("all")}>{tr("products.opportunities.showAllSaved")}</button> : <Link href="/app/products">{tr("products.opportunities.title")}</Link> : hasCatalogFilters ? <button type="button" onClick={clearFilters}>{tr("products.opportunities.clear")}</button> : null}</div>
        : <><section className={styles.grid} aria-label={mode === "saved" ? tr("products.opportunities.savedTitle") : tr("products.opportunities.title")}>{catalogRows.map((item) => <ProductCard key={item.id} item={item} saved={savedIds.has(item.id)} saving={savingIds.has(item.id)} savedState={savedState} mode={mode} onOpen={() => void openDetails(item)} onSave={() => void toggleSaved(item)} onCreate={() => createPin(item)} />)}</section>{mode === "saved" ? visibleSaved.filter((record) => !record.item).map((record) => <SavedPlaceholder key={record.productOpportunityId} record={record} removing={savingIds.has(record.productOpportunityId)} onRemove={() => void removeSavedHistory(record.productOpportunityId)} />) : null}</>}
      {hasLockedCatalog && mode === "catalog" ? <aside className={styles.upgradePanel}><div><Heart aria-hidden="true" /><span>{tr("products.opportunities.upgradeTitle")}</span></div><p>{tr("products.opportunities.upgradeBody")}</p><Link href="/pricing">{tr("products.opportunities.viewPlans")} <ArrowRight aria-hidden="true" /></Link></aside> : null}
      {canLoadMore ? <button className={styles.loadMore} onClick={() => void loadCatalog(true)} disabled={loadingMore}>{loadingMore ? <Loader2 className={styles.spin} aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}{loadingMore ? tr("products.opportunities.loadingMore") : tr("products.opportunities.loadMore")}</button> : null}
      {selected ? <ProductDetail item={selected} saved={savedIds.has(selected.id)} saving={savingIds.has(selected.id)} savedState={savedState} mode={mode} detailsLoading={detailsLoading} detailsError={detailsError} onClose={() => { detailRequestSequence.current += 1; setSelected(null); setDetailsLoading(false); setDetailsError(null); }} onOpen={() => undefined} onSave={() => void toggleSaved(selected)} onCreate={() => createPin(selected)} /> : null}
    </main>
  );
}
