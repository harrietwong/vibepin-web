// ── Pipeline / Jobs v0 (READ-ONLY, internal admin) ───────────────────────────
//
// Powers /admin/pipeline. Shows, per job, the latest run's status/timing/row
// counts/error and last-success time, from the pipeline_runs table (migrate_v24).
// Read-only. No mutation controls (no run/requeue/apply/timer/scoring).
//
// pipeline_runs has: job_type, status, started_at, finished_at, duration_seconds,
// error_message, rows_processed, keywords_processed, created_by, metadata. It has
// NO dedicated skipped/failed-rows/error-code/retryable columns, so those are
// read from metadata when present and otherwise null (shown as n/a). If the
// table itself is absent, `available` is false and the page shows a warning.

type PgError = { code?: string; message?: string } | null;

export type PipelineJob = {
  jobName: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  processedRows: number | null;
  skippedRows: number | null;
  failedRows: number | null;
  errorCode: string | null;
  errorReason: string | null;
  retryable: boolean | null;
  lastSuccessAt: string | null;
};

export type PipelineStatus = {
  available: boolean;
  generatedAt: string;
  jobs: PipelineJob[];
  runsToday: number;
  failedToday: number;
  warnings: string[];
};

function isMissingRelation(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .* does not exist|could not find the table/i.test(error.message ?? "");
}

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
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

function strFromMeta(meta: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!meta) return null;
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function boolFromMeta(meta: Record<string, unknown> | null | undefined, keys: string[]): boolean | null {
  if (!meta) return null;
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

type Row = {
  job_type: string | null;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  rows_processed: number | null;
  metadata: Record<string, unknown> | null;
};

export async function getPipelineStatus(): Promise<PipelineStatus> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];
  const startToday = startOfTodayUtc();

  let rows: Row[] = [];
  try {
    const { data, error } = await db
      .from("pipeline_runs")
      .select("job_type,status,started_at,finished_at,duration_seconds,error_message,rows_processed,metadata")
      .order("started_at", { ascending: false })
      .limit(500);
    if (error) {
      if (isMissingRelation(error)) {
        warnings.push("Pipeline job history table not available yet.");
      } else {
        warnings.push(`pipeline_runs query failed: ${error.message ?? "unknown error"}`);
      }
      return { available: false, generatedAt: new Date().toISOString(), jobs: [], runsToday: 0, failedToday: 0, warnings };
    }
    rows = (data ?? []) as Row[];
  } catch {
    warnings.push("Pipeline job history table not available yet.");
    return { available: false, generatedAt: new Date().toISOString(), jobs: [], runsToday: 0, failedToday: 0, warnings };
  }

  const latestByJob = new Map<string, Row>();
  const lastSuccessByJob = new Map<string, string>();
  let runsToday = 0;
  let failedToday = 0;

  for (const r of rows) {
    const job = r.job_type ?? "unknown";
    if (!latestByJob.has(job)) latestByJob.set(job, r);
    if (r.status === "completed" && !lastSuccessByJob.has(job)) {
      lastSuccessByJob.set(job, r.finished_at ?? r.started_at ?? "");
    }
    if ((r.started_at ?? "") >= startToday) {
      runsToday += 1;
      if (r.status === "failed" || r.status === "error") failedToday += 1;
    }
  }

  const jobs: PipelineJob[] = Array.from(latestByJob.entries())
    .map(([job, r]) => ({
      jobName: job,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.finished_at,
      durationSeconds:
        typeof r.duration_seconds === "number"
          ? r.duration_seconds
          : r.started_at && r.finished_at
            ? Math.max(0, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000))
            : null,
      processedRows: r.rows_processed ?? numFromMeta(r.metadata, ["rows_processed", "rowsProcessed", "inserted_rows"]),
      skippedRows: numFromMeta(r.metadata, ["skipped_rows", "skippedRows", "skipped"]),
      failedRows: numFromMeta(r.metadata, ["failed_rows", "failedRows", "failed", "errors_count"]),
      errorCode: strFromMeta(r.metadata, ["error_code", "errorCode", "code"]),
      errorReason: r.error_message ?? strFromMeta(r.metadata, ["error_reason", "errorReason", "reason"]),
      retryable: boolFromMeta(r.metadata, ["retryable", "is_retryable", "canRetry"]),
      lastSuccessAt: lastSuccessByJob.get(job) ?? null,
    }))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  return { available: true, generatedAt: new Date().toISOString(), jobs, runsToday, failedToday, warnings };
}
