import "server-only";

/**
 * Reads for the Insights dashboard: the v64 collection tables and views, and
 * nothing else.
 *
 * Two properties matter here and neither is obvious from the shape of the code.
 *
 * **1. A missing table means "no data", never an exception.** This code ships to
 * production BEFORE the v64 migration is applied there — the migration went to the
 * isolated test project, and applying it to production is a human decision. A reader
 * that threw on a missing relation would blank the live Insights page on deploy
 * day. Instead every reader degrades to empty, which makes `loadLatestFinishedRun`
 * return null, which puts the dashboard on the bounded live-sample path: the
 * behaviour users already have today, kept until the schema is really there. Real
 * errors (permissions, connectivity, constraint violations) still propagate —
 * swallowing those is how a page ends up quietly showing zeros forever.
 *
 * **2. The two run queries are deliberately separate.** The gate for "has collection
 * ever finished" must ask for a run WITH `finished_at`, not for the newest run and
 * then look at its column: a connection whose last ten invocations all crashed would
 * answer "no finished run" from a `limit 10` window and be sent back to spending
 * live Pinterest calls on every page view — exactly when that is most expensive and
 * least likely to help. `skipped_reason`, on the other hand, is a property of the
 * MOST RECENT attempt whether it finished or not, so it comes from its own query.
 */

import { createServerClient } from "@/lib/supabase";
import type {
  CollectionRunRow,
  ContentRegistryRow,
  LatestStatusRow,
  LatestValueRow,
  MetricRows,
  ObservationHistoryRow,
} from "@/lib/insights/collectionDashboard";
import { EMPTY_METRIC_ROWS } from "@/lib/insights/collectionDashboard";
import { isMissingSchema } from "./collectorStore";

/** Pin ids per PostgREST `in(...)` filter. A URL carrying 200 ids is long enough to
 *  hit proxy limits; batching keeps each request ordinary. */
const CONTENT_ID_CHUNK = 100;

/** Observation rows read per chunk of Pins. One Pin accumulates at most a handful of
 *  lifetime observations per metric per collection run, so this is a guard against a
 *  pathological history, not a working limit. */
const OBSERVATION_HISTORY_LIMIT = 2000;

const RUN_COLUMNS = "id,kind,started_at,finished_at,calls_made,calls_budget,skipped_reason,error";
const OBSERVATION_COLUMNS =
  "scope,platform_content_id,metric_name,period,period_date,metric_value,status,observed_at";

type Row = Record<string, unknown>;

function runFromRow(row: Row): CollectionRunRow {
  return {
    id: row.id == null ? null : String(row.id),
    kind: String(row.kind ?? ""),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    callsMade: Number(row.calls_made) || 0,
    callsBudget: Number(row.calls_budget) || 0,
    skippedReason: row.skipped_reason == null ? null : String(row.skipped_reason),
    error: row.error == null ? null : String(row.error),
  };
}

function valueFromRow(row: Row): LatestValueRow | null {
  const value = Number(row.metric_value);
  if (!Number.isFinite(value)) return null;
  return {
    scope: row.scope === "account" ? "account" : "content",
    platformContentId: row.platform_content_id == null ? null : String(row.platform_content_id),
    metricName: String(row.metric_name ?? ""),
    period: row.period === "day" ? "day" : "lifetime",
    periodDate: row.period_date == null ? null : String(row.period_date),
    metricValue: value,
    observedAt: String(row.observed_at ?? ""),
  };
}

function statusFromRow(row: Row): LatestStatusRow {
  const status = String(row.status ?? "");
  return {
    scope: row.scope === "account" ? "account" : "content",
    platformContentId: row.platform_content_id == null ? null : String(row.platform_content_id),
    metricName: String(row.metric_name ?? ""),
    period: row.period === "day" ? "day" : "lifetime",
    periodDate: row.period_date == null ? null : String(row.period_date),
    status: status === "ok" || status === "not_returned" || status === "no_permission"
      ? status
      : "not_collected",
    observedAt: String(row.observed_at ?? ""),
  };
}

/** The newest run that actually finished. The gate for the live fallback. */
export async function loadLatestFinishedRun(connectionId: string): Promise<CollectionRunRow | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("collection_run")
    .select(RUN_COLUMNS)
    .eq("connection_id", connectionId)
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingSchema(error)) return null;
    throw new Error(`Unable to read collection_run: ${error.message}`);
  }
  const row = (data ?? [])[0];
  return row ? runFromRow(row as Row) : null;
}

/** The newest attempt of any kind — where `skipped_reason` comes from. */
export async function loadLatestRun(connectionId: string): Promise<CollectionRunRow | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("collection_run")
    .select(RUN_COLUMNS)
    .eq("connection_id", connectionId)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingSchema(error)) return null;
    throw new Error(`Unable to read collection_run: ${error.message}`);
  }
  const row = (data ?? [])[0];
  return row ? runFromRow(row as Row) : null;
}

/**
 * Account-level daily observations for the visible window.
 *
 * Only daily rows: the summary is the sum of the days shown, so reading lifetime
 * account totals as well would give the page two different answers to "how many
 * views in these 30 days" and no rule for choosing.
 */
export async function loadAccountMetrics(
  connectionId: string,
  startDate: string,
  endDate: string,
): Promise<MetricRows> {
  const db = createServerClient();
  const query = (view: string) => db
    .from(view)
    .select(OBSERVATION_COLUMNS)
    .eq("connection_id", connectionId)
    .eq("scope", "account")
    .eq("period", "day")
    .gte("period_date", startDate)
    .lte("period_date", endDate);

  const [valueResult, statusResult] = await Promise.all([
    query("metric_latest_value"),
    query("metric_latest_status"),
  ]);
  if (valueResult.error) {
    if (isMissingSchema(valueResult.error)) return EMPTY_METRIC_ROWS;
    throw new Error(`Unable to read account metrics: ${valueResult.error.message}`);
  }
  if (statusResult.error && !isMissingSchema(statusResult.error)) {
    throw new Error(`Unable to read account metric status: ${statusResult.error.message}`);
  }
  return {
    values: (valueResult.data ?? []).map(row => valueFromRow(row as Row))
      .filter((row): row is LatestValueRow => row !== null),
    statuses: (statusResult.data ?? []).map(row => statusFromRow(row as Row)),
  };
}

/**
 * The registered Pins of one connection, newest first.
 *
 * Ordered by `published_at` with nulls last: a Pin whose publish date we never
 * learned is not "the oldest", it is unknown, and sorting it to the top would push
 * the Pins the user just published off a bounded list.
 */
export async function loadRegistry(connectionId: string, limit: number): Promise<ContentRegistryRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("content_registry")
    .select("platform_content_id,vibepin_draft_id,published_at,format,title,description,link_url,board_name,source_endpoint,last_seen_at")
    .eq("connection_id", connectionId)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw new Error(`Unable to read content_registry: ${error.message}`);
  }
  return (data ?? []).map(raw => {
    const row = raw as Row;
    const source = String(row.source_endpoint ?? "pins_list");
    return {
      platformContentId: String(row.platform_content_id ?? ""),
      vibepinDraftId: row.vibepin_draft_id == null ? null : String(row.vibepin_draft_id),
      publishedAt: row.published_at == null ? null : String(row.published_at),
      format: row.format == null ? null : String(row.format),
      title: row.title == null ? null : String(row.title),
      description: row.description == null ? null : String(row.description),
      linkUrl: row.link_url == null ? null : String(row.link_url),
      boardName: row.board_name == null ? null : String(row.board_name),
      sourceEndpoint: source === "top_pins" || source === "vibepin_publish" ? source : "pins_list",
      lastSeenAt: row.last_seen_at == null ? null : String(row.last_seen_at),
    } satisfies ContentRegistryRow;
  }).filter(row => row.platformContentId !== "");
}

/**
 * Raw lifetime observations for a set of Pins — the ONLY source of age-pinned values.
 *
 * `metric_latest_value` deliberately keeps one row per measurement key, so a Pin's
 * day-1 reading and its day-7 reading of the same metric are indistinguishable there:
 * the later one simply wins. Growth from day 1 to day 7 is therefore unanswerable
 * from the views, and answerable from the append-only ledger they are built on. The
 * engine decides which window each observation falls in (it knows `published_at`);
 * this reader only fetches, ordered oldest-first so a truncated read loses the newest
 * rows rather than a random half of the history.
 */
export async function loadObservationHistory(
  connectionId: string,
  pinIds: string[],
): Promise<ObservationHistoryRow[]> {
  if (pinIds.length === 0) return [];
  const db = createServerClient();
  const rows: ObservationHistoryRow[] = [];
  for (let index = 0; index < pinIds.length; index += CONTENT_ID_CHUNK) {
    const chunk = pinIds.slice(index, index + CONTENT_ID_CHUNK);
    const { data, error } = await db
      .from("metric_observation")
      .select("platform_content_id,metric_name,metric_value,observed_at")
      .eq("connection_id", connectionId)
      .eq("scope", "content")
      .eq("period", "lifetime")
      .eq("status", "ok")
      .in("platform_content_id", chunk)
      .order("observed_at", { ascending: true })
      .limit(OBSERVATION_HISTORY_LIMIT);
    if (error) {
      if (isMissingSchema(error)) return [];
      throw new Error(`Unable to read metric_observation: ${error.message}`);
    }
    for (const raw of data ?? []) {
      const row = raw as Row;
      const value = Number(row.metric_value);
      const pinId = row.platform_content_id == null ? "" : String(row.platform_content_id);
      if (!pinId || !Number.isFinite(value)) continue;
      rows.push({
        pinId,
        metricName: String(row.metric_name ?? ""),
        metricValue: value,
        observedAt: String(row.observed_at ?? ""),
      });
    }
  }
  return rows;
}

/**
 * Per-Pin observations.
 *
 * `includeDaily` is what keeps the account scope cheap: its heatmap comes from the
 * account report, so pulling 200 Pins times 30 days times 6 metrics of daily rows
 * would be tens of thousands of rows read to be thrown away.
 */
export async function loadContentMetrics(
  connectionId: string,
  pinIds: string[],
  options: { startDate: string; endDate: string; includeDaily: boolean },
): Promise<MetricRows> {
  if (pinIds.length === 0) return EMPTY_METRIC_ROWS;
  const db = createServerClient();
  const values: LatestValueRow[] = [];
  const statuses: LatestStatusRow[] = [];

  for (let index = 0; index < pinIds.length; index += CONTENT_ID_CHUNK) {
    const chunk = pinIds.slice(index, index + CONTENT_ID_CHUNK);
    const lifetime = (view: string) => db
      .from(view)
      .select(OBSERVATION_COLUMNS)
      .eq("connection_id", connectionId)
      .eq("scope", "content")
      .eq("period", "lifetime")
      .in("platform_content_id", chunk);
    const daily = (view: string) => db
      .from(view)
      .select(OBSERVATION_COLUMNS)
      .eq("connection_id", connectionId)
      .eq("scope", "content")
      .eq("period", "day")
      .gte("period_date", options.startDate)
      .lte("period_date", options.endDate)
      .in("platform_content_id", chunk);

    const results = await Promise.all([
      lifetime("metric_latest_value"),
      lifetime("metric_latest_status"),
      ...(options.includeDaily ? [daily("metric_latest_value"), daily("metric_latest_status")] : []),
    ]);

    for (const [position, result] of results.entries()) {
      if (result.error) {
        if (isMissingSchema(result.error)) return EMPTY_METRIC_ROWS;
        throw new Error(`Unable to read content metrics: ${result.error.message}`);
      }
      const isStatusView = position % 2 === 1;
      for (const raw of result.data ?? []) {
        if (isStatusView) {
          statuses.push(statusFromRow(raw as Row));
        } else {
          const value = valueFromRow(raw as Row);
          if (value) values.push(value);
        }
      }
    }
  }

  return { values, statuses };
}
