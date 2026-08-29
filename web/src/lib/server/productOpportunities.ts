import { createServerClient } from "../supabase";
import type { PlanKey } from "../pricingPlans";
import {
  canAccessProductOpportunity,
  canAccessSavedProductHistory,
  productCatalogScope,
  type ProductOpportunityAccessRow,
} from "./productOpportunityAccess";
import {
  metricsPublishedForFamily,
  resolveProductMetricControls,
  type ProductMetricCalibrationGate,
  type ProductMetricControls,
  type ProductMetricReleaseGate,
} from "./productOpportunityMetricControls";

export type ProductOpportunityItem = {
  id: string;
  productName: string | null;
  productImageUrl: string;
  productUrl: string;
  merchant: string | null;
  domain: string | null;
  category: string | null;
  productType: string | null;
  productFamily: "physical" | "digital";
  pinterestUrl: string;
  pinterestEvidenceType: "product_pin" | "source_pin";
  additionalPinterestEvidence: Array<{
    pinterestUrl: string;
    pinterestEvidenceType: "product_pin" | "source_pin";
  }>;
  latestPinterestSaves: number | null;
  latestPinterestSnapshotAt: string | null;
  savesGained30d: number | null;
  currentSavesGained7d: number | null;
  previousSavesGained7d: number | null;
  highRecentDemand: boolean | null;
  recentMomentum: "rising" | "steady" | "cooling" | null;
  momentumPercent: number | null;
};

type OpportunityRow = ProductOpportunityAccessRow & {
  id: string;
  product_name: string | null;
  product_image_url: string;
  external_product_url: string;
  merchant: string | null;
  domain: string | null;
  category: string | null;
  product_type: string | null;
  product_family: "physical" | "digital";
  activated_at: string | null;
};

type EvidenceRow = {
  id: string;
  product_opportunity_id: string;
  pinterest_pin_url: string;
  evidence_type: "product_pin" | "source_pin";
  is_primary?: boolean;
  evidence_status?: "active" | "invalid" | "retired";
  created_at?: string;
};

type MetricRow = {
  product_opportunity_id: string;
  evidence_id: string;
  metric_version: number;
  g30_status: string;
  trend_status: string;
  latest_save_count: number | null;
  latest_snapshot_at: string | null;
  g30_saves_gained: number | null;
  current_g7_gained: number | null;
  previous_g7_gained: number | null;
  momentum_direction: "rising" | "steady" | "cooling" | null;
  momentum_percent: number | null;
};

type CalibrationRow = {
  product_family: "physical" | "digital";
  metric_version: number;
  high_demand_g30_threshold: number | null;
  effective_from: string;
};

type CatalogRow = OpportunityRow & {
  search_text: string;
  evidence_id: string;
  pinterest_pin_url: string;
  evidence_type: "product_pin" | "source_pin";
  metric_evidence_id: string | null;
  metric_version: number | null;
  g30_status: string | null;
  trend_status: string | null;
  latest_save_count: number | null;
  latest_snapshot_at: string | null;
  g30_saves_gained: number | null;
  current_g7_gained: number | null;
  previous_g7_gained: number | null;
  momentum_direction: "rising" | "steady" | "cooling" | null;
  momentum_percent: number | null;
  high_recent_demand: boolean | null;
};

type OpportunityListQuery = {
  eq(column: string, value: unknown): OpportunityListQuery;
  not(column: string, operator: string, value: unknown): OpportunityListQuery;
  lte(column: string, value: unknown): OpportunityListQuery;
  ilike(column: string, pattern: string): OpportunityListQuery;
  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): OpportunityListQuery;
  range(from: number, to: number): PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
    count: number | null;
  }>;
};

const OPPORTUNITY_COLUMNS = [
  "id",
  "product_name",
  "product_image_url",
  "external_product_url",
  "merchant",
  "domain",
  "category",
  "product_type",
  "product_family",
  "free_preview_rank",
  "lifecycle_status",
  "activated_at",
].join(",");

const CATALOG_COLUMNS = [
  OPPORTUNITY_COLUMNS,
  "search_text",
  "evidence_id",
  "pinterest_pin_url",
  "evidence_type",
  "metric_evidence_id",
  "metric_version",
  "g30_status",
  "trend_status",
  "latest_save_count",
  "latest_snapshot_at",
  "g30_saves_gained",
  "current_g7_gained",
  "previous_g7_gained",
  "momentum_direction",
  "momentum_percent",
  "high_recent_demand",
].join(",");

export type ProductOpportunityListResult = {
  items: ProductOpportunityItem[];
  accessibleCount: number;
  hasLockedCatalog: boolean;
  metricControls: ProductMetricControls;
};

function publicItem(
  opportunity: OpportunityRow,
  evidence: EvidenceRow,
  metric: MetricRow | undefined,
  calibration: CalibrationRow | undefined,
  additionalEvidence: EvidenceRow[] = [],
): ProductOpportunityItem {
  // Shadow metrics must be withheld at the API boundary, not merely hidden by
  // the browser. Direct API callers cannot bypass the family publication flags.
  const metricIsSafe = metricsPublishedForFamily(opportunity.product_family)
    && metric
    && metric.evidence_id === evidence.id
    && Number.isInteger(metric.metric_version)
    && metric.metric_version > 0
    && metric.g30_status !== "counter_regression"
    && metric.g30_status !== "stale";
  const trendFactsAreSafe = metricIsSafe
    && ["valid", "insufficient_activity", "calibration_pending"].includes(metric.trend_status);
  return {
    id: opportunity.id,
    productName: opportunity.product_name,
    productImageUrl: opportunity.product_image_url,
    productUrl: opportunity.external_product_url,
    merchant: opportunity.merchant,
    domain: opportunity.domain,
    category: opportunity.category,
    productType: opportunity.product_type,
    productFamily: opportunity.product_family,
    pinterestUrl: evidence.pinterest_pin_url,
    pinterestEvidenceType: evidence.evidence_type,
    additionalPinterestEvidence: additionalEvidence.map((row) => ({
      pinterestUrl: row.pinterest_pin_url,
      pinterestEvidenceType: row.evidence_type,
    })),
    latestPinterestSaves: metricIsSafe ? metric.latest_save_count : null,
    latestPinterestSnapshotAt: metricIsSafe ? metric.latest_snapshot_at : null,
    savesGained30d: metricIsSafe && metric.g30_status === "valid" ? metric.g30_saves_gained : null,
    currentSavesGained7d: trendFactsAreSafe ? metric.current_g7_gained : null,
    previousSavesGained7d: trendFactsAreSafe ? metric.previous_g7_gained : null,
    highRecentDemand:
      metricIsSafe
      && metric.g30_status === "valid"
      && calibration?.metric_version === metric?.metric_version
      && calibration.high_demand_g30_threshold != null
      && metric.g30_saves_gained != null
        ? metric.g30_saves_gained >= calibration.high_demand_g30_threshold
        : null,
    recentMomentum:
      metricIsSafe && metric.trend_status === "valid" ? metric.momentum_direction : null,
    momentumPercent:
      metricIsSafe && metric.trend_status === "valid" ? metric.momentum_percent : null,
  };
}

async function hydrate(
  rows: OpportunityRow[],
  options: { includeAdditionalEvidence?: boolean } = {},
): Promise<ProductOpportunityItem[]> {
  if (!rows.length) return [];
  const db = createServerClient();
  const ids = rows.map((row) => row.id);
  const evidenceRows: EvidenceRow[] = [];
  const metricRows: MetricRow[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    let evidenceQuery = db
        .from("product_opportunity_evidence")
        .select(
          "id,product_opportunity_id,pinterest_pin_url,evidence_type," +
          "is_primary,evidence_status,created_at",
        )
        .in("product_opportunity_id", chunk)
        .eq("evidence_status", "active");
    if (!options.includeAdditionalEvidence) {
      evidenceQuery = evidenceQuery.eq("is_primary", true);
    }
    const [{ data: evidenceData, error: evidenceError }, { data: metricData, error: metricError }] = await Promise.all([
      evidenceQuery,
      db
        .from("product_opportunity_metrics")
        .select(
          "product_opportunity_id,evidence_id,metric_version,g30_status,trend_status," +
          "latest_save_count,latest_snapshot_at,g30_saves_gained,current_g7_gained," +
          "previous_g7_gained,momentum_direction,momentum_percent",
        )
        .in("product_opportunity_id", chunk),
    ]);
    if (evidenceError) throw new Error(`primary evidence query failed: ${evidenceError.message}`);
    if (metricError) throw new Error(`product metric query failed: ${metricError.message}`);
    evidenceRows.push(...((evidenceData ?? []) as unknown as EvidenceRow[]));
    metricRows.push(...((metricData ?? []) as unknown as MetricRow[]));
  }

  const evidenceByProduct = new Map<string, EvidenceRow>();
  const additionalEvidenceByProduct = new Map<string, EvidenceRow[]>();
  for (const row of evidenceRows) {
    if (row.is_primary) {
      evidenceByProduct.set(row.product_opportunity_id, row);
      continue;
    }
    const additional = additionalEvidenceByProduct.get(row.product_opportunity_id) ?? [];
    additional.push(row);
    additionalEvidenceByProduct.set(row.product_opportunity_id, additional);
  }
  for (const additional of additionalEvidenceByProduct.values()) {
    additional.sort((left, right) => {
      const typeOrder = Number(right.evidence_type === "product_pin")
        - Number(left.evidence_type === "product_pin");
      if (typeOrder !== 0) return typeOrder;
      const createdOrder = (right.created_at ?? "").localeCompare(left.created_at ?? "");
      return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
    });
  }
  const metricByProduct = new Map(
    metricRows.map((row) => [row.product_opportunity_id, row]),
  );
  const calibrationByFamilyVersion = await approvedCalibrationMap();
  // An active product without a persisted active Primary Evidence fails closed.
  return rows.flatMap((row) => {
    const evidence = evidenceByProduct.get(row.id);
    return evidence
      ? [publicItem(
          row,
          evidence,
          metricByProduct.get(row.id),
          calibrationByFamilyVersion.get(`${row.product_family}:${metricByProduct.get(row.id)?.metric_version}`),
          additionalEvidenceByProduct.get(row.id) ?? [],
        )]
      : [];
  });
}

async function approvedCalibrationMap(): Promise<Map<string, CalibrationRow>> {
  const { data, error } = await createServerClient()
    .from("product_metric_calibrations")
    .select("product_family,metric_version,high_demand_g30_threshold,effective_from")
    .not("approved_at", "is", null)
    .lte("effective_from", new Date().toISOString())
    .order("effective_from", { ascending: false });
  if (error) throw new Error(`product calibration query failed: ${error.message}`);
  const result = new Map<string, CalibrationRow>();
  for (const row of (data ?? []) as unknown as CalibrationRow[]) {
    const key = `${row.product_family}:${row.metric_version}`;
    if (!result.has(key)) result.set(key, row);
  }
  return result;
}

function catalogItem(row: CatalogRow, calibrations: Map<string, CalibrationRow>): ProductOpportunityItem {
  const metric: MetricRow | undefined = row.metric_evidence_id && row.metric_version != null
    ? {
        product_opportunity_id: row.id,
        evidence_id: row.metric_evidence_id,
        metric_version: row.metric_version,
        g30_status: row.g30_status ?? "insufficient_history",
        trend_status: row.trend_status ?? "insufficient_history",
        latest_save_count: row.latest_save_count,
        latest_snapshot_at: row.latest_snapshot_at,
        g30_saves_gained: row.g30_saves_gained,
        current_g7_gained: row.current_g7_gained,
        previous_g7_gained: row.previous_g7_gained,
        momentum_direction: row.momentum_direction,
        momentum_percent: row.momentum_percent,
      }
    : undefined;
  return publicItem(
    row,
    {
      id: row.evidence_id,
      product_opportunity_id: row.id,
      pinterest_pin_url: row.pinterest_pin_url,
      evidence_type: row.evidence_type,
    },
    metric,
    calibrations.get(`${row.product_family}:${row.metric_version}`),
  );
}

function cleanFilter(value: string | undefined, maxLength: number): string | undefined {
  const cleaned = value?.trim().slice(0, maxLength).replace(/[%_]/g, "");
  return cleaned || undefined;
}

export class ProductMetricControlsNotReadyError extends Error {}

async function loadMetricControls(
  db: ReturnType<typeof createServerClient>,
  family: "physical" | "digital" | undefined,
): Promise<ProductMetricControls> {
  if (!family || !metricsPublishedForFamily(family)) {
    return resolveProductMetricControls(family, []);
  }
  const result = await db
    .from("product_metric_release_gates")
    .select(
      "product_family,metric_version,valid_g30_g7_coverage,visible_product_count,quality_review_passed,demand_trend_filters_enabled,approved_at",
    );
  const { data, error } = result as unknown as {
    data: ProductMetricReleaseGate[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`product metric release gate query failed: ${error.message}`);
  const gate = (data ?? []).find((row) => row.product_family === family);
  if (!gate) return resolveProductMetricControls(family, []);
  const calibrationResult = await db
    .from("product_metric_calibrations")
    .select("product_family,metric_version,effective_from,approved_at")
    .eq("product_family", family)
    .eq("metric_version", gate.metric_version)
    .not("approved_at", "is", null)
    .lte("effective_from", new Date().toISOString());
  const { data: calibrationData, error: calibrationError } = calibrationResult as unknown as {
    data: ProductMetricCalibrationGate[] | null;
    error: { message: string } | null;
  };
  if (calibrationError) {
    throw new Error(`product metric control calibration query failed: ${calibrationError.message}`);
  }
  return resolveProductMetricControls(family, data ?? [], calibrationData ?? []);
}

async function hasRowsOutsideFreePreview(
  db: ReturnType<typeof createServerClient>,
  freeLimit: number | null,
): Promise<boolean> {
  if (freeLimit === null) return false;
  // The upgrade panel claims that a larger catalog exists. Prove that globally
  // instead of inferring it from the user's plan or the current filtered page.
  const query = db
    .from("product_opportunity_catalog_v1")
    .select("id", { count: "exact" })
    .eq("lifecycle_status", "active")
    .not("product_image_url", "is", null) as unknown as OpportunityListQuery;
  const { error, count } = await query.range(0, 0);
  if (error) throw new Error(`product opportunity catalog count failed: ${error.message}`);
  return (count ?? 0) > freeLimit;
}

export async function listProductOpportunities(
  plan: PlanKey,
  options: {
    limit?: number;
    offset?: number;
    family?: "physical" | "digital";
    search?: string;
    category?: string;
    platform?: string;
    demand?: "high_recent_demand";
    trend?: "rising" | "steady" | "cooling";
    sort?: "most_saved" | "newest" | "fastest_growing";
  } = {},
): Promise<ProductOpportunityListResult> {
  const db = createServerClient();
  const scope = productCatalogScope(plan);
  const hasLockedCatalogPromise = hasRowsOutsideFreePreview(db, scope.limit);
  const metricControlsPromise = loadMetricControls(db, options.family);
  const requestedLimit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const offset = Math.max(0, options.offset ?? 0);
  const effectiveLimit = scope.limit === null
    ? requestedLimit
    : Math.min(requestedLimit, Math.max(0, scope.limit - offset));
  const metricControls = await metricControlsPromise;
  const metricControlRequested = Boolean(
    options.demand || options.trend || options.sort === "fastest_growing",
  );
  if (metricControlRequested && !metricControls.available) {
    throw new ProductMetricControlsNotReadyError(
      "Demand and trend filters are not ready for this product family yet",
    );
  }
  if (effectiveLimit === 0) {
    return {
      items: [],
      accessibleCount: scope.limit ?? 0,
      hasLockedCatalog: await hasLockedCatalogPromise,
      metricControls,
    };
  }

  // The generated Supabase schema does not include the unapplied v63 tables yet.
  // Keep the cast at this DB boundary; response rows are narrowed immediately.
  let query = db
    .from("product_opportunity_catalog_v1")
    .select(CATALOG_COLUMNS, { count: "exact" })
    .eq("lifecycle_status", "active")
    .not("product_image_url", "is", null) as unknown as OpportunityListQuery;
  if (options.family) query = query.eq("product_family", options.family);
  const search = cleanFilter(options.search, 80);
  const category = cleanFilter(options.category, 80);
  const platform = cleanFilter(options.platform, 120)?.toLowerCase();
  if (search) query = query.ilike("search_text", `%${search}%`);
  if (category) query = query.eq("category", category);
  if (platform) query = query.eq("domain", platform);
  if (metricControlRequested) {
    query = query.eq("metric_version", metricControls.metricVersion!);
  }
  if (options.demand === "high_recent_demand") {
    query = query.eq("high_recent_demand", true);
  }
  if (options.trend) {
    query = query
      .eq("trend_status", "valid")
      .eq("momentum_direction", options.trend);
  }
  if (scope.requiresFreePreviewRank) {
    query = query
      .not("free_preview_rank", "is", null)
      .lte("free_preview_rank", scope.limit!);
  }
  query = options.sort === "newest"
    ? query.order("activated_at", { ascending: false, nullsFirst: false })
    : options.sort === "fastest_growing"
      ? query
          .eq("trend_status", "valid")
          .order("momentum_percent", { ascending: false, nullsFirst: false })
      : query.order("latest_save_count", { ascending: false, nullsFirst: false });
  query = query.order("id", { ascending: true });
  const { data, error, count } = await query.range(offset, offset + effectiveLimit - 1);
  if (error) throw new Error(`product opportunity query failed: ${error.message}`);
  const rows = (data ?? []) as unknown as CatalogRow[];
  const calibrations = await approvedCalibrationMap();
  return {
    items: rows.map((row) => catalogItem(row, calibrations)),
    accessibleCount: count ?? rows.length,
    hasLockedCatalog: await hasLockedCatalogPromise,
    metricControls,
  };
}

export async function getProductOpportunity(
  plan: PlanKey,
  id: string,
): Promise<ProductOpportunityItem | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("product_opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`product opportunity query failed: ${error.message}`);
  const row = data as unknown as OpportunityRow | null;
  if (!row || !canAccessProductOpportunity(plan, row)) return null;
  return (await hydrate([row], { includeAdditionalEvidence: true }))[0] ?? null;
}

export type SavedProductOpportunity = {
  productOpportunityId: string;
  savedAt: string;
  requiresUpgrade: boolean;
  item: ProductOpportunityItem | null;
  historyItem: ProductOpportunityItem | null;
};

async function hydrateSavedHistory(rows: OpportunityRow[]): Promise<ProductOpportunityItem[]> {
  const eligible = rows.filter((row) => Boolean(row.product_image_url && row.external_product_url));
  if (!eligible.length) return [];
  const db = createServerClient();
  const ids = eligible.map((row) => row.id);
  const evidenceRows: EvidenceRow[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error } = await db
      .from("product_opportunity_evidence")
      .select(
        "id,product_opportunity_id,pinterest_pin_url,evidence_type," +
        "is_primary,evidence_status,created_at",
      )
      .in("product_opportunity_id", ids.slice(start, start + 100))
      .order("created_at", { ascending: false });
    if (error) throw new Error(`saved product evidence query failed: ${error.message}`);
    evidenceRows.push(...((data ?? []) as unknown as EvidenceRow[]));
  }
  const evidenceByProduct = new Map<string, EvidenceRow>();
  for (const evidence of evidenceRows) {
    const current = evidenceByProduct.get(evidence.product_opportunity_id);
    const priority = Number(evidence.is_primary) * 2 + Number(evidence.evidence_status === "active");
    const currentPriority = current
      ? Number(current.is_primary) * 2 + Number(current.evidence_status === "active")
      : -1;
    if (!current || priority > currentPriority) {
      evidenceByProduct.set(evidence.product_opportunity_id, evidence);
    }
  }
  return eligible.flatMap((row) => {
    const evidence = evidenceByProduct.get(row.id);
    return evidence ? [publicItem(row, evidence, undefined, undefined)] : [];
  });
}

export async function listSavedProductOpportunities(
  userId: string,
  plan: PlanKey,
): Promise<SavedProductOpportunity[]> {
  const db = createServerClient();
  const { data: savedData, error: savedError } = await db
    .from("saved_product_opportunities")
    .select("product_opportunity_id,saved_at")
    .eq("user_id", userId)
    .eq("save_status", "saved")
    .order("saved_at", { ascending: false });
  if (savedError) throw new Error(`saved product query failed: ${savedError.message}`);
  const saved = (savedData ?? []) as unknown as Array<{ product_opportunity_id: string; saved_at: string }>;
  if (!saved.length) return [];

  const products: OpportunityRow[] = [];
  const savedIds = saved.map((row) => row.product_opportunity_id);
  for (let start = 0; start < savedIds.length; start += 100) {
    const { data: productData, error: productError } = await db
      .from("product_opportunities")
      .select(OPPORTUNITY_COLUMNS)
      .in("id", savedIds.slice(start, start + 100));
    if (productError) throw new Error(`saved product detail query failed: ${productError.message}`);
    products.push(...((productData ?? []) as unknown as OpportunityRow[]));
  }
  const byId = new Map(products.map((row) => [row.id, row]));
  const accessible = products.filter((row) => canAccessProductOpportunity(plan, row));
  const hydrated = new Map((await hydrate(accessible)).map((item) => [item.id, item]));
  // Paid users keep a truthful read-only record after a product leaves the
  // discovery catalog. Metrics are deliberately omitted because their last
  // computed status may no longer be fresh. Free access remains restricted to
  // the current curated ten, so Saved Products cannot bypass the plan boundary.
  const historicalRows = products.filter((row) => canAccessSavedProductHistory(plan, row));
  const historical = new Map(
    (await hydrateSavedHistory(historicalRows)).map((item) => [item.id, item]),
  );

  return saved.map((record) => {
    const row = byId.get(record.product_opportunity_id);
    const item = hydrated.get(record.product_opportunity_id) ?? null;
    const requiresUpgrade = Boolean(
      !item
      && row?.lifecycle_status === "active"
      && !canAccessProductOpportunity(plan, row),
    );
    return {
      productOpportunityId: record.product_opportunity_id,
      savedAt: record.saved_at,
      requiresUpgrade,
      item,
      historyItem: !item && !requiresUpgrade
        ? historical.get(record.product_opportunity_id) ?? null
        : null,
    };
  });
}

export async function saveProductOpportunity(
  userId: string,
  plan: PlanKey,
  productOpportunityId: string,
): Promise<boolean> {
  if (!(await getProductOpportunity(plan, productOpportunityId))) return false;
  const { error } = await createServerClient()
    .from("saved_product_opportunities")
    .upsert(
      {
        user_id: userId,
        product_opportunity_id: productOpportunityId,
        save_status: "saved",
        saved_at: new Date().toISOString(),
        removed_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,product_opportunity_id" },
    );
  if (error) throw new Error(`save product failed: ${error.message}`);
  return true;
}

export async function removeSavedProductOpportunity(
  userId: string,
  productOpportunityId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await createServerClient()
    .from("saved_product_opportunities")
    .update({ save_status: "removed", removed_at: now, updated_at: now })
    .eq("user_id", userId)
    .eq("product_opportunity_id", productOpportunityId);
  if (error) throw new Error(`remove saved product failed: ${error.message}`);
}
