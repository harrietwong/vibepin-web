// ── Admin Home overview aggregation (READ-ONLY) ──────────────────────────────
//
// Powers the internal /admin dashboard. Every query is read-only and degrades
// gracefully: a missing table, a missing column, a permission error, or a
// rejected promise turns into a `null` metric plus a human-readable warning —
// the page never crashes. No mutations, no crawler/apply/requeue/timer/scoring
// controls live here. Founder/support/data-ops surface only.
//
// Data sources: pin_generations, pin_samples, pin_products, product_scores,
// visual_asset_reviews (v31, optional), pipeline_runs (v24, optional),
// publish_jobs / social_publish_jobs (optional), auth.users (service role),
// and getProductOpportunityAdminStatus() for product + scoring freshness.

import {
  getProductOpportunityAdminStatus,
  type FreshnessStatus,
} from "@/lib/server/productOpportunityAdminStatus";

type Db = ReturnType<typeof import("@/lib/supabase").createServerClient>;

export type OverallFreshness = "fresh" | "warning" | "stale" | "unknown";

export type AdminOverview = {
  generatedAt: string;
  sinceToday: string; // ISO start-of-day (UTC) used for "today" metrics
  warnings: string[];

  users: {
    available: boolean;
    totalUsers: number | null;
    activeToday: number | null;
    newToday: number | null;
    capped: boolean;
    workspacesAvailable: boolean;
    totalWorkspaces: number | null;
    activeWorkspacesToday: number | null;
  };

  generation: {
    available: boolean;
    statusAvailable: boolean;
    today: number | null;
    successToday: number | null;
    failedToday: number | null;
    failureRatePct: number | null;
    latestCreatedAt: string | null;
  };

  inventory: {
    pinSamples: number | null;
    pinProducts: number | null;
    productScores: number | null;
    productIdeas: number | null;
    productIdeasAvailable: boolean;
    visualReviews: number | null;
    visualReviewsAvailable: boolean;
  };

  freshness: {
    overall: OverallFreshness;
    samplesAvailable: boolean;
    samplesLast24h: number | null;
    samplesLast48h: number | null;
    samplesLast5d: number | null;
    samplesLatestAt: string | null;
    samplesStatus: FreshnessStatus;
    productsLast24h: number;
    productsLast48h: number;
    productsLast5d: number;
    productsLatestCreatedAt: string | null;
    productsLatestScrapedAt: string | null;
    productStatus: FreshnessStatus;
    scoringLatestAt: string | null;
    scoreStatus: FreshnessStatus;
  };

  visualReview: {
    available: boolean;
    reviewed: number | null;
    unreviewed: number | null;
    pass: number | null;
    review: number | null;
    reject: number | null;
    latestReviewedAt: string | null;
  };

  jobs: {
    available: boolean;
    runs: Array<{
      jobType: string;
      status: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      rowsProcessed: number | null;
      failedRows: number | null;
      errorMessage: string | null;
      lastSuccessAt: string | null;
    }>;
  };

  errors: {
    available: boolean;
    items: Array<{
      kind: "generation" | "pipeline" | "integration";
      source: string;
      message: string;
      at: string | null;
    }>;
  };
};

// ── low-level helpers ────────────────────────────────────────────────────────

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

type PgError = { code?: string; message?: string } | null;

function isMissingRelation(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true; // undefined_table
  return /relation .* does not exist/i.test(error.message ?? "");
}

// undefined_table OR undefined_column — either means "this shape isn't here yet".
function isMissingSchema(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "42703") return true;
  return /(relation|column) .* does not exist/i.test(error.message ?? "");
}

type CountOutcome = { n: number | null; missing: boolean };

async function countRows(
  qb: PromiseLike<{ count: number | null; error: PgError }>,
): Promise<CountOutcome> {
  try {
    const { count, error } = await qb;
    if (error) return { n: null, missing: isMissingSchema(error) };
    return { n: count ?? 0, missing: false };
  } catch {
    return { n: null, missing: false };
  }
}

function numFromMeta(meta: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (!meta) return null;
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

// ── section loaders ──────────────────────────────────────────────────────────

async function loadUsers(db: Db, startToday: string, warnings: string[]): Promise<AdminOverview["users"]> {
  const empty: AdminOverview["users"] = {
    available: false,
    totalUsers: null,
    activeToday: null,
    newToday: null,
    capped: false,
    workspacesAvailable: false,
    totalWorkspaces: null,
    activeWorkspacesToday: null,
  };

  // Users live in Supabase auth.users; listing requires the service-role key.
  try {
    const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error || !data) {
      warnings.push(
        "User metrics unavailable — auth.admin.listUsers failed (a SUPABASE_SERVICE_ROLE_KEY is required).",
      );
    } else {
      const users = data.users ?? [];
      const capped = users.length >= 1000;
      if (capped) warnings.push("User counts capped at 1000 (first page only).");
      empty.available = true;
      empty.totalUsers = users.length;
      empty.capped = capped;
      empty.activeToday = users.filter(u => (u.last_sign_in_at ?? "") >= startToday).length;
      empty.newToday = users.filter(u => (u.created_at ?? "") >= startToday).length;
    }
  } catch {
    warnings.push("User metrics unavailable — auth admin API threw.");
  }

  // Workspaces: no dedicated table exists yet in this schema. Attempt it so the
  // card lights up automatically if one is added later; degrade quietly if not.
  try {
    const total = await countRows(db.from("workspaces").select("id", { count: "exact", head: true }));
    if (total.missing) {
      empty.workspacesAvailable = false;
    } else {
      empty.workspacesAvailable = true;
      empty.totalWorkspaces = total.n;
      const active = await countRows(
        db.from("workspaces").select("id", { count: "exact", head: true }).gte("updated_at", startToday),
      );
      empty.activeWorkspacesToday = active.missing ? null : active.n;
    }
  } catch {
    empty.workspacesAvailable = false;
  }

  return empty;
}

async function loadGeneration(db: Db, startToday: string, warnings: string[]): Promise<AdminOverview["generation"]> {
  const out: AdminOverview["generation"] = {
    available: false,
    statusAvailable: false,
    today: null,
    successToday: null,
    failedToday: null,
    failureRatePct: null,
    latestCreatedAt: null,
  };

  const today = await countRows(
    db.from("pin_generations").select("id", { count: "exact", head: true }).gte("created_at", startToday),
  );
  if (today.missing) {
    warnings.push("Generation metrics unavailable — pin_generations table not found.");
    return out;
  }
  out.available = true;
  out.today = today.n;

  // status column was added after the base pin_generations migration; degrade
  // if this database predates it.
  const success = await countRows(
    db.from("pin_generations").select("id", { count: "exact", head: true }).gte("created_at", startToday).eq("status", "completed"),
  );
  const failed = await countRows(
    db.from("pin_generations").select("id", { count: "exact", head: true }).gte("created_at", startToday).eq("status", "failed"),
  );
  if (success.missing || failed.missing) {
    warnings.push("Generation success/failure split unavailable — pin_generations.status column not present.");
  } else {
    out.statusAvailable = true;
    out.successToday = success.n;
    out.failedToday = failed.n;
    const denom = (success.n ?? 0) + (failed.n ?? 0);
    out.failureRatePct = denom > 0 ? Math.round(((failed.n ?? 0) / denom) * 1000) / 10 : 0;
  }

  try {
    const { data, error } = await db
      .from("pin_generations")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (!error && data?.[0]?.created_at) out.latestCreatedAt = data[0].created_at as string;
  } catch {
    /* latest is best-effort */
  }

  return out;
}

async function loadInventory(db: Db, warnings: string[]): Promise<AdminOverview["inventory"]> {
  const [samples, products, scores, ideas, reviews] = await Promise.all([
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true })),
    countRows(db.from("pin_products").select("id", { count: "exact", head: true })),
    countRows(db.from("product_scores").select("id", { count: "exact", head: true })),
    countRows(db.from("product_ideas").select("id", { count: "exact", head: true })),
    countRows(db.from("visual_asset_reviews").select("id", { count: "exact", head: true })),
  ]);

  if (ideas.missing) warnings.push("product_ideas table not found — Product Ideas are derived from pin_products (no dedicated table).");
  if (reviews.missing) warnings.push("visual_asset_reviews table not found — migration v31 pending.");

  return {
    pinSamples: samples.n,
    pinProducts: products.n,
    productScores: scores.n,
    productIdeas: ideas.missing ? null : ideas.n,
    productIdeasAvailable: !ideas.missing,
    visualReviews: reviews.missing ? null : reviews.n,
    visualReviewsAvailable: !reviews.missing,
  };
}

async function loadSamplesFreshness(
  db: Db,
  bounds: { last24h: string; last48h: string; last5d: string },
): Promise<{ available: boolean; last24h: number | null; last48h: number | null; last5d: number | null; latestAt: string | null; status: FreshnessStatus }> {
  // pin_samples has no created_at column — scraped_at is the ingestion clock.
  const [c24, c48, c5d] = await Promise.all([
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).gte("scraped_at", bounds.last24h)),
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).gte("scraped_at", bounds.last48h)),
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).gte("scraped_at", bounds.last5d)),
  ]);
  if (c24.missing) {
    return { available: false, last24h: null, last48h: null, last5d: null, latestAt: null, status: "unknown" };
  }
  let latestAt: string | null = null;
  try {
    const { data, error } = await db
      .from("pin_samples")
      .select("scraped_at")
      .not("scraped_at", "is", null)
      .order("scraped_at", { ascending: false })
      .limit(1);
    if (!error && data?.[0]?.scraped_at) latestAt = data[0].scraped_at as string;
  } catch {
    /* best-effort */
  }
  const fresh = latestAt ? Date.now() - Date.parse(latestAt) <= 48 * 3_600_000 : false;
  return {
    available: true,
    last24h: c24.n,
    last48h: c48.n,
    last5d: c5d.n,
    latestAt,
    status: latestAt ? (fresh ? "fresh" : "stale") : "unknown",
  };
}

function combineFreshness(product: FreshnessStatus, score: FreshnessStatus, sample: FreshnessStatus): OverallFreshness {
  const states = [product, score, sample];
  if (states.every(s => s === "unknown")) return "unknown";
  if (product === "fresh" && score === "fresh") return "fresh";
  if (product === "stale") return "stale";
  return "warning";
}

async function loadVisualReview(
  db: Db,
  inventory: AdminOverview["inventory"],
  warnings: string[],
): Promise<AdminOverview["visualReview"]> {
  const out: AdminOverview["visualReview"] = {
    available: false,
    reviewed: null,
    unreviewed: null,
    pass: null,
    review: null,
    reject: null,
    latestReviewedAt: null,
  };

  // Approximate candidate pool = images available to review across both sources.
  const [prodImgs, sampleImgs] = await Promise.all([
    countRows(db.from("pin_products").select("id", { count: "exact", head: true }).not("image_url", "is", null)),
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).not("image_url", "is", null)),
  ]);
  const candidatePool = (prodImgs.n ?? 0) + (sampleImgs.n ?? 0);

  if (!inventory.visualReviewsAvailable) {
    // Table missing: everything is unreviewed.
    out.unreviewed = candidatePool || null;
    return out;
  }

  const reviewed = inventory.visualReviews ?? 0;
  out.available = true;
  out.reviewed = reviewed;
  out.unreviewed = Math.max(0, candidatePool - reviewed);

  const [pass, review, reject] = await Promise.all([
    countRows(db.from("visual_asset_reviews").select("id", { count: "exact", head: true }).eq("decision_label", "PASS")),
    countRows(db.from("visual_asset_reviews").select("id", { count: "exact", head: true }).eq("decision_label", "REVIEW")),
    countRows(db.from("visual_asset_reviews").select("id", { count: "exact", head: true }).eq("decision_label", "REJECT")),
  ]);
  out.pass = pass.n;
  out.review = review.n;
  out.reject = reject.n;

  try {
    const { data, error } = await db
      .from("visual_asset_reviews")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (!error && data?.[0]?.updated_at) out.latestReviewedAt = data[0].updated_at as string;
  } catch {
    /* best-effort */
  }

  void warnings;
  return out;
}

type PipelineRow = {
  job_type: string | null;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  rows_processed: number | null;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
};

async function loadJobs(db: Db, warnings: string[]): Promise<AdminOverview["jobs"]> {
  try {
    const { data, error } = await db
      .from("pipeline_runs")
      .select("job_type,status,started_at,finished_at,rows_processed,error_message,metadata")
      .order("started_at", { ascending: false })
      .limit(300);

    if (error) {
      if (isMissingRelation(error)) {
        warnings.push("pipeline_runs table not found — job status unavailable.");
      } else {
        warnings.push(`pipeline_runs query failed: ${error.message ?? "unknown error"}`);
      }
      return { available: false, runs: [] };
    }

    const rows = (data ?? []) as PipelineRow[];
    const latestByJob = new Map<string, PipelineRow>();
    const lastSuccessByJob = new Map<string, string>();
    for (const r of rows) {
      const job = r.job_type ?? "unknown";
      if (!latestByJob.has(job)) latestByJob.set(job, r);
      if (r.status === "completed" && !lastSuccessByJob.has(job)) {
        lastSuccessByJob.set(job, r.finished_at ?? r.started_at ?? "");
      }
    }

    const runs = Array.from(latestByJob.entries())
      .map(([job, r]) => ({
        jobType: job,
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        rowsProcessed: r.rows_processed ?? numFromMeta(r.metadata, ["rows_processed", "rowsProcessed", "inserted_rows"]),
        failedRows: numFromMeta(r.metadata, ["failed_rows", "failedRows", "failed", "errors_count"]),
        errorMessage: r.error_message ?? null,
        lastSuccessAt: lastSuccessByJob.get(job) ?? null,
      }))
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

    return { available: true, runs };
  } catch {
    warnings.push("pipeline_runs query threw — job status unavailable.");
    return { available: false, runs: [] };
  }
}

async function loadErrors(db: Db, warnings: string[]): Promise<AdminOverview["errors"]> {
  const items: AdminOverview["errors"]["items"] = [];
  let anyAvailable = false;

  // Generation failures.
  try {
    const { data, error } = await db
      .from("pin_generations")
      .select("created_at,error_message,error_type,keyword")
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(8);
    if (!error) {
      anyAvailable = true;
      for (const r of data ?? []) {
        items.push({
          kind: "generation",
          source: `generation${r.keyword ? ` · ${r.keyword}` : ""}`,
          message: (r.error_message as string) || (r.error_type as string) || "Generation failed",
          at: (r.created_at as string) ?? null,
        });
      }
    }
  } catch {
    /* degrade */
  }

  // Pipeline failures.
  try {
    const { data, error } = await db
      .from("pipeline_runs")
      .select("job_type,status,error_message,finished_at,started_at")
      .in("status", ["failed", "error"])
      .order("started_at", { ascending: false })
      .limit(8);
    if (!error) {
      anyAvailable = true;
      for (const r of data ?? []) {
        items.push({
          kind: "pipeline",
          source: `pipeline · ${(r.job_type as string) ?? "unknown"}`,
          message: (r.error_message as string) || `Job ${r.status}`,
          at: (r.finished_at as string) ?? (r.started_at as string) ?? null,
        });
      }
    }
  } catch {
    /* degrade */
  }

  // Integration / publish failures (optional tables).
  for (const table of ["publish_jobs", "social_publish_jobs"]) {
    try {
      const { data, error } = await db
        .from(table)
        .select("platform,status,error_message,created_at")
        .eq("status", "failed")
        .order("created_at", { ascending: false })
        .limit(5);
      if (!error) {
        anyAvailable = true;
        for (const r of data ?? []) {
          items.push({
            kind: "integration",
            source: `${table}${r.platform ? ` · ${r.platform}` : ""}`,
            message: (r.error_message as string) || "Publish failed",
            at: (r.created_at as string) ?? null,
          });
        }
      }
    } catch {
      /* optional */
    }
  }

  if (!anyAvailable) warnings.push("No error-event sources available (generation/pipeline/publish tables absent or empty).");

  items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return { available: anyAvailable, items: items.slice(0, 12) };
}

// ── entry point ──────────────────────────────────────────────────────────────

export async function getAdminOverview(): Promise<AdminOverview> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];
  const startToday = startOfTodayUtc();
  const bounds = { last24h: isoHoursAgo(24), last48h: isoHoursAgo(48), last5d: isoHoursAgo(24 * 5) };

  // Run the independent sections concurrently. productOpportunityAdminStatus
  // already covers product + scoring freshness (read-only), so reuse it.
  const [
    users,
    generation,
    inventory,
    productStatusResult,
    samplesFreshness,
    jobs,
    errors,
  ] = await Promise.all([
    loadUsers(db, startToday, warnings),
    loadGeneration(db, startToday, warnings),
    loadInventory(db, warnings),
    getProductOpportunityAdminStatus().catch(() => null),
    loadSamplesFreshness(db, bounds),
    loadJobs(db, warnings),
    loadErrors(db, warnings),
  ]);

  // Visual review needs the inventory count first (reviewed total).
  const visualReview = await loadVisualReview(db, inventory, warnings);

  const product = productStatusResult?.productDataFreshness;
  const score = productStatusResult?.scoreFreshness;
  if (!productStatusResult) warnings.push("Product/scoring freshness query failed.");
  for (const w of productStatusResult?.pipelineSummary.warnings ?? []) warnings.push(w);

  const productStatus: FreshnessStatus = product?.status ?? "unknown";
  const scoreStatus: FreshnessStatus = score?.status ?? "unknown";

  return {
    generatedAt: new Date().toISOString(),
    sinceToday: startToday,
    warnings,
    users,
    generation,
    inventory,
    freshness: {
      overall: combineFreshness(productStatus, scoreStatus, samplesFreshness.status),
      samplesAvailable: samplesFreshness.available,
      samplesLast24h: samplesFreshness.last24h,
      samplesLast48h: samplesFreshness.last48h,
      samplesLast5d: samplesFreshness.last5d,
      samplesLatestAt: samplesFreshness.latestAt,
      samplesStatus: samplesFreshness.status,
      productsLast24h: product?.rowsCreatedLast24h ?? 0,
      productsLast48h: product?.rowsCreatedLast48h ?? 0,
      productsLast5d: product?.rowsCreatedLast5d ?? 0,
      productsLatestCreatedAt: product?.latestCreatedAt ?? null,
      productsLatestScrapedAt: product?.latestScrapedAt ?? null,
      productStatus,
      scoringLatestAt: score?.latestScoredAt ?? null,
      scoreStatus,
    },
    visualReview,
    jobs,
    errors,
  };
}
