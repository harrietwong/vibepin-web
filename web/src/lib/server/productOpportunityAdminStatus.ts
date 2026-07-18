import { excludeRetired } from "@/lib/productTopTiers";

export type FreshnessStatus = "fresh" | "stale" | "unknown";

export type ProductDataFreshness = {
  status: FreshnessStatus;
  latestCreatedAt: string | null;
  latestScrapedAt: string | null;
  rowsCreatedLast24h: number;
  rowsCreatedLast48h: number;
  rowsCreatedLast5d: number;
  totalRows: number;
};

export type ScoreFreshness = {
  status: FreshnessStatus;
  latestScoredAt: string | null;
  scoresUpdatedLast24h: number;
  scoresUpdatedLast48h: number;
  scoresUpdatedLast5d: number;
  totalRows: number;
};

export type PipelineRunSummary = {
  jobType: string | null;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
};

export type PipelineSummary = {
  latestSuccessfulDailyRun: string | null;
  latestFailedDailyRun: string | null;
  latestAttemptedScoreRun: string | null;
  scoreRunStatus: string | null;
  scoreRunStillMarkedRunning: boolean;
  legacyDailyDeprecated: boolean;
  legacyDailyZeroYield: boolean;
  enabledSchedulerNames: string[];
  warnings: string[];
  details: {
    latestSuccessfulDailyRun: PipelineRunSummary | null;
    latestFailedDailyRun: PipelineRunSummary | null;
    latestAttemptedScoreRun: PipelineRunSummary | null;
  };
};

export type ProductOpportunityAdminStatus = {
  productDataFreshness: ProductDataFreshness;
  scoreFreshness: ScoreFreshness;
  pipelineSummary: PipelineSummary;
};

type PinProductFreshnessInput = {
  latestCreatedAt: string | null;
  latestScrapedAt: string | null;
  rowsCreatedLast24h: number;
  rowsCreatedLast48h: number;
  rowsCreatedLast5d: number;
  totalRows: number;
};

type ScoreFreshnessInput = {
  latestScoredAt: string | null;
  scoresUpdatedLast24h: number;
  scoresUpdatedLast48h: number;
  scoresUpdatedLast5d: number;
  totalRows: number;
};

type PipelineRunRow = {
  job_type: string | null;
  status: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
};

const FRESH_AFTER_HOURS = 48;

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function statusFromTimestamp(iso: string | null): FreshnessStatus {
  if (!iso) return "unknown";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "unknown";
  return Date.now() - time <= FRESH_AFTER_HOURS * 3_600_000 ? "fresh" : "stale";
}

function maxIso(values: Array<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => !!value);
  return present.length ? present.reduce((a, b) => (a > b ? a : b)) : null;
}

function runTimestamp(row: PipelineRunRow | null): string | null {
  return row?.finished_at ?? row?.started_at ?? row?.created_at ?? null;
}

function normalizeRun(row: PipelineRunRow | null): PipelineRunSummary | null {
  if (!row) return null;
  return {
    jobType: row.job_type ?? null,
    status: row.status ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at ?? null,
    errorMessage: row.error_message ?? null,
    metadata: row.metadata ?? null,
  };
}

function numericMetadata(metadata: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function booleanMetadata(metadata: Record<string, unknown> | null | undefined, keys: string[]): boolean {
  if (!metadata) return false;
  return keys.some(key => metadata[key] === true || metadata[key] === "true");
}

function hasZeroYieldStepMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  const steps = metadata?.steps;
  if (!Array.isArray(steps)) return false;
  let sawYieldSignal = false;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const row = step as Record<string, unknown>;
    for (const key of ["product_rows", "updated_rows", "created_or_updated", "inserted_rows", "rows_processed"]) {
      const value = row[key];
      if (typeof value === "number") {
        sawYieldSignal = true;
        if (value > 0) return false;
      }
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
        sawYieldSignal = true;
        if (Number(value) > 0) return false;
      }
    }
  }
  return sawYieldSignal;
}

export function buildFreshnessStatusFromInputs(input: {
  productData: PinProductFreshnessInput;
  scoreData: ScoreFreshnessInput;
  latestSuccessfulDailyRun?: PipelineRunRow | null;
  latestFailedDailyRun?: PipelineRunRow | null;
  latestAttemptedScoreRun?: PipelineRunRow | null;
  enabledSchedulerNames?: string[];
  warnings?: string[];
}): ProductOpportunityAdminStatus {
  const latestProductAt = maxIso([
    input.productData.latestScrapedAt,
    input.productData.latestCreatedAt,
  ]);
  const productDataFreshness: ProductDataFreshness = {
    ...input.productData,
    status: statusFromTimestamp(latestProductAt),
  };

  const scoreFreshness: ScoreFreshness = {
    ...input.scoreData,
    status: statusFromTimestamp(input.scoreData.latestScoredAt),
  };

  const latestSuccessfulDailyRun = input.latestSuccessfulDailyRun ?? null;
  const latestFailedDailyRun = input.latestFailedDailyRun ?? null;
  const latestAttemptedScoreRun = input.latestAttemptedScoreRun ?? null;
  const latestDailyMetadata = latestSuccessfulDailyRun?.metadata ?? latestFailedDailyRun?.metadata ?? null;
  const rowsProcessed = numericMetadata(latestDailyMetadata, ["rows_processed", "rowsProcessed", "inserted_rows", "insertedRows"]);
  const legacyDailyDeprecated = booleanMetadata(latestDailyMetadata, ["deprecated", "legacy_deprecated", "legacyDeprecated"]);
  const legacyDailyZeroYield = rowsProcessed === 0 || hasZeroYieldStepMetadata(latestDailyMetadata);
  const warnings = [...(input.warnings ?? [])];

  if (scoreFreshness.status === "stale") {
    warnings.push("Score freshness is stale while product rows may still be fresh.");
  }
  if (legacyDailyDeprecated && legacyDailyZeroYield) {
    warnings.push("Legacy daily pipeline metadata marks it deprecated with zero processed rows.");
  }
  for (const name of input.enabledSchedulerNames ?? []) {
    if (/daily|pipeline|score/i.test(name) && !/approved|prod/i.test(name)) {
      warnings.push(`Enabled scheduler '${name}' needs production-use approval before relying on it.`);
    }
  }

  return {
    productDataFreshness,
    scoreFreshness,
    pipelineSummary: {
      latestSuccessfulDailyRun: runTimestamp(latestSuccessfulDailyRun),
      latestFailedDailyRun: runTimestamp(latestFailedDailyRun),
      latestAttemptedScoreRun: runTimestamp(latestAttemptedScoreRun),
      scoreRunStatus: latestAttemptedScoreRun?.status ?? null,
      scoreRunStillMarkedRunning: latestAttemptedScoreRun?.status === "running",
      legacyDailyDeprecated,
      legacyDailyZeroYield,
      enabledSchedulerNames: input.enabledSchedulerNames ?? [],
      warnings,
      details: {
        latestSuccessfulDailyRun: normalizeRun(latestSuccessfulDailyRun),
        latestFailedDailyRun: normalizeRun(latestFailedDailyRun),
        latestAttemptedScoreRun: normalizeRun(latestAttemptedScoreRun),
      },
    },
  };
}

function countValue(result: { count: number | null } | null | undefined): number {
  return result?.count ?? 0;
}

function firstTimestamp<T extends Record<string, unknown>>(rows: T[] | null | undefined, field: keyof T): string | null {
  const value = rows?.[0]?.[field];
  return typeof value === "string" ? value : null;
}

function firstRun(rows: PipelineRunRow[] | null | undefined): PipelineRunRow | null {
  return rows?.[0] ?? null;
}

export async function getProductOpportunityAdminStatus(): Promise<ProductOpportunityAdminStatus> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const last24h = isoHoursAgo(24);
  const last48h = isoHoursAgo(48);
  const last5d = isoHoursAgo(24 * 5);

  // Soft-retired rows (lifecycle_status='retired', migrate_v46) are excluded from every
  // pin_products counter here: this is the Product Opportunity READINESS signal, and
  // Product Opportunity reads pin_products directly — a row that can never surface must
  // not count toward "how much product supply do we have".
  const productTotalQuery = excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }));
  const product24Query = excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).gte("created_at", last24h));
  const product48Query = excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).gte("created_at", last48h));
  const product5dQuery = excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).gte("created_at", last5d));
  const latestCreatedQuery = excludeRetired(db.from("pin_products").select("created_at")).order("created_at", { ascending: false }).limit(1);
  const latestScrapedQuery = excludeRetired(db.from("pin_products").select("scraped_at").not("scraped_at", "is", null)).order("scraped_at", { ascending: false }).limit(1);

  const scoreTotalQuery = db.from("product_scores").select("id", { count: "exact", head: true });
  const score24Query = db.from("product_scores").select("id", { count: "exact", head: true }).gte("scored_at", last24h);
  const score48Query = db.from("product_scores").select("id", { count: "exact", head: true }).gte("scored_at", last48h);
  const score5dQuery = db.from("product_scores").select("id", { count: "exact", head: true }).gte("scored_at", last5d);
  const latestScoreQuery = db.from("product_scores").select("scored_at").not("scored_at", "is", null).order("scored_at", { ascending: false }).limit(1);

  const pipelineFields = "job_type,status,started_at,finished_at,error_message,metadata";
  const latestSuccessfulDailyQuery = db
    .from("pipeline_runs")
    .select(pipelineFields)
    .eq("job_type", "daily")
    .eq("status", "completed")
    .order("finished_at", { ascending: false })
    .limit(1);
  const latestFailedDailyQuery = db
    .from("pipeline_runs")
    .select(pipelineFields)
    .eq("job_type", "daily")
    .in("status", ["failed", "error"])
    .order("finished_at", { ascending: false })
    .limit(1);
  const latestAttemptedScoreQuery = db
    .from("pipeline_runs")
    .select(pipelineFields)
    .eq("job_type", "stl-score")
    .order("started_at", { ascending: false })
    .limit(1);

  const results = await Promise.allSettled([
    productTotalQuery,
    product24Query,
    product48Query,
    product5dQuery,
    latestCreatedQuery,
    latestScrapedQuery,
    scoreTotalQuery,
    score24Query,
    score48Query,
    score5dQuery,
    latestScoreQuery,
    latestSuccessfulDailyQuery,
    latestFailedDailyQuery,
    latestAttemptedScoreQuery,
  ]);

  const warnings: string[] = [];
  const value = <T,>(index: number): T | null => {
    const result = results[index];
    if (result.status === "rejected") {
      warnings.push("A read-only admin status query failed.");
      return null;
    }
    const data = result.value as unknown as T & { error?: { message?: string } | null };
    if (data?.error) {
      warnings.push(data.error.message ?? "A read-only admin status query failed.");
      return null;
    }
    return data;
  };

  const productTotal = value<{ count: number | null }>(0);
  const product24 = value<{ count: number | null }>(1);
  const product48 = value<{ count: number | null }>(2);
  const product5d = value<{ count: number | null }>(3);
  const latestCreated = value<{ data: Array<{ created_at: string | null }> | null }>(4);
  const latestScraped = value<{ data: Array<{ scraped_at: string | null }> | null }>(5);
  const scoreTotal = value<{ count: number | null }>(6);
  const score24 = value<{ count: number | null }>(7);
  const score48 = value<{ count: number | null }>(8);
  const score5d = value<{ count: number | null }>(9);
  const latestScore = value<{ data: Array<{ scored_at: string | null }> | null }>(10);
  const latestSuccessfulDaily = value<{ data: PipelineRunRow[] | null }>(11);
  const latestFailedDaily = value<{ data: PipelineRunRow[] | null }>(12);
  const latestAttemptedScore = value<{ data: PipelineRunRow[] | null }>(13);

  return buildFreshnessStatusFromInputs({
    productData: {
      latestCreatedAt: firstTimestamp(latestCreated?.data, "created_at"),
      latestScrapedAt: firstTimestamp(latestScraped?.data, "scraped_at"),
      rowsCreatedLast24h: countValue(product24),
      rowsCreatedLast48h: countValue(product48),
      rowsCreatedLast5d: countValue(product5d),
      totalRows: countValue(productTotal),
    },
    scoreData: {
      latestScoredAt: firstTimestamp(latestScore?.data, "scored_at"),
      scoresUpdatedLast24h: countValue(score24),
      scoresUpdatedLast48h: countValue(score48),
      scoresUpdatedLast5d: countValue(score5d),
      totalRows: countValue(scoreTotal),
    },
    latestSuccessfulDailyRun: firstRun(latestSuccessfulDaily?.data),
    latestFailedDailyRun: firstRun(latestFailedDaily?.data),
    latestAttemptedScoreRun: firstRun(latestAttemptedScore?.data),
    enabledSchedulerNames: [],
    warnings,
  });
}
