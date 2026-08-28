import "server-only";

/**
 * Generating, storing and reading Insights reports.
 *
 * Four things this module is careful about.
 *
 * **It reads the ledger and nothing else.** The sources it builds have no live
 * Pinterest reader: `PinterestClient` is not imported here, and cannot be. A report
 * is frozen evidence, and evidence sampled live from an API at generation time is
 * exactly the kind that can never be re-derived when the user asks, three weeks
 * later, where the number came from. If the collection has not finished for this
 * connection, the honest output is no report at all.
 *
 * **It never updates a report's content.** Regeneration compares hashes: identical
 * means nothing happened, different means the old row is superseded and a new
 * version is inserted. The database enforces both halves (a partial unique index on
 * the current row, a trigger that closes content columns after send or view), so a
 * mistake here fails loudly instead of quietly rewriting what somebody already read.
 *
 * **It is a no-op for a free plan.** The gate lives in the generator, not only in the
 * read endpoints: rows that exist are rows that leak eventually — through a support
 * export, a debug endpoint, an email step written six weeks from now. A free account
 * still gets COLLECTED every night; it just does not get read.
 *
 * **A missing table is a normal answer.** v65 ships ahead of its apply, so every
 * query treats "relation does not exist" as an empty result rather than a 500. The
 * feature degrades to invisible instead of taking the page down with it.
 */

import { utcDateDaysAgo } from "@/lib/insights/businessRules";
import {
  readConnectionEvidence,
  type CollectionSources,
  type LiveAnalyticsSlice,
} from "@/lib/insights/collectionDashboard";
import {
  buildScorecardReport,
  buildWeeklyReport,
  hasScorecardMeasurement,
  headlineOf,
  isWeeklyDue,
  regenerationDecision,
  scorecardDueKind,
  type CurrentReportRow,
} from "@/lib/insights/reportBuilder";
import type {
  InsightReportDetail,
  InsightReportKind,
  InsightReportRecord,
  InsightReportSnapshot,
  InsightReportSummary,
  InsightNarrativeStatus,
  ScorecardMetrics,
} from "@/lib/insights/reportTypes";
import { insightsDiagnosisAllowed } from "@/lib/insights/paidGate";
import { resolvePlan } from "@/lib/server/entitlements";
import { listConnections } from "@/lib/social/server/socialConnectionStore";
import { createServerClient } from "@/lib/supabase";
import { EMPTY_KEYWORD_SET } from "@/lib/insights/keywordSet";
import { ownerConnectionsForPins } from "./collectorStore";
import {
  loadAccountMetrics,
  loadContentMetrics,
  loadLatestFinishedRun,
  loadLatestRun,
  loadObservationHistory,
  loadRegistry,
} from "./insightsReadStore";
import { loadAccountKeywordSet } from "./keywordSetStore";
import { listVibePinPublishedPinterestPins } from "./vibepinPublishedPins";

const REPORT_TABLE = "insight_report";
const FEEDBACK_TABLE = "insight_report_feedback";
/** The list endpoint's ceiling. A reader who needs more needs a different screen. */
export const REPORT_LIST_LIMIT = 20;

type PostgrestErrorish = { code?: string; message?: string } | null;

/** v65 is not applied everywhere yet; an absent relation is a normal answer. */
function isMissingSchemaError(error: PostgrestErrorish): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return error.code === "42P01"
    || error.code === "PGRST205"
    || error.code === "42703"
    || error.code === "PGRST204"
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"));
}

function isUniqueViolation(error: PostgrestErrorish): boolean {
  return error?.code === "23505";
}

// ── Sources: the ledger, and only the ledger ─────────────────────────────────

function reportSources(
  uid: string,
  connectionId: string,
  metadata: Record<string, unknown> | null,
  siblingConnectionIds: string[],
  startDate: string,
  endDate: string,
): CollectionSources {
  return {
    loadLatestFinishedRun: () => loadLatestFinishedRun(connectionId),
    loadLatestRun: () => loadLatestRun(connectionId),
    loadAccountMetrics: (from, to) => loadAccountMetrics(connectionId, from, to),
    loadRegistry: limit => loadRegistry(connectionId, limit),
    loadContentMetrics: (pinIds, options) => loadContentMetrics(connectionId, pinIds, options),
    loadObservationHistory: pinIds => loadObservationHistory(connectionId, pinIds),
    loadKeywordSet: inferenceTexts => loadAccountKeywordSet({
      uid,
      connectionId,
      metadata,
      inferenceTexts,
    }).catch(error => {
      console.error("[insights/reports] keyword set unavailable", error);
      return EMPTY_KEYWORD_SET;
    }),
    loadProvenance: async () => {
      const result = await listVibePinPublishedPinterestPins(uid);
      return { pins: Array.from(result.pins.values()), storageAvailable: result.storageAvailable };
    },
    loadRegistryOwners: pinIds => ownerConnectionsForPins(siblingConnectionIds, pinIds)
      .catch(() => new Map<string, string>()),
    // Never called: `readConnectionEvidence` returns null before the live fallback,
    // and a report must not exist that was built from a live sample. The empty map
    // is here to satisfy the shared source contract, not as a fallback.
    loadLiveAnalytics: async () => new Map<string, LiveAnalyticsSlice | null>(),
  };
}

// ── Writing ──────────────────────────────────────────────────────────────────

type WriteOutcome = "unchanged" | "created" | "versioned" | "unavailable";

type StoredRow = {
  id: string;
  kind: InsightReportKind;
  period_key: string;
  subject_content_id: string | null;
  subject_draft_id: string | null;
  version: number;
  evidence_hash: string;
  evidence_snapshot: unknown;
  rule_version: string | null;
  keyword_set_version: number | null;
  narrative_status: string | null;
  generated_at: string;
  viewed_at: string | null;
};

async function readCurrentRow(
  db: ReturnType<typeof createServerClient>,
  connectionId: string,
  record: InsightReportRecord,
): Promise<{ row: CurrentReportRow; available: boolean }> {
  let query = db
    .from(REPORT_TABLE)
    .select("id,version,evidence_hash")
    .eq("connection_id", connectionId)
    .eq("kind", record.kind)
    .eq("period_key", record.periodKey)
    .eq("status", "current");
  query = record.subjectContentId === null
    ? query.is("subject_content_id", null)
    : query.eq("subject_content_id", record.subjectContentId);

  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return { row: null, available: false };
    throw new Error(`insight_report read failed: ${error.message}`);
  }
  if (!data) return { row: null, available: true };
  return {
    row: { id: String(data.id), version: Number(data.version), evidenceHash: String(data.evidence_hash) },
    available: true,
  };
}

/**
 * Store one generated report, honouring the versioning contract.
 *
 * Supersede-then-insert, in that order, because the partial unique index allows only
 * one `current` row per identity — inserting first would collide with the row we are
 * about to retire. There is no transaction available through this client, so the
 * window between the two writes is real: it is closed by the unique index, and a
 * collision is retried ONCE against a re-read of the current row. A second failure is
 * raised rather than looped, because two concurrent generators mean something
 * upstream is wrong and a retry storm would hide it.
 */
async function storeReport(
  db: ReturnType<typeof createServerClient>,
  uid: string,
  connectionId: string,
  record: InsightReportRecord,
  attempt = 0,
): Promise<{ outcome: WriteOutcome; id: string | null }> {
  const { row: current, available } = await readCurrentRow(db, connectionId, record);
  if (!available) return { outcome: "unavailable", id: null };

  const decision = regenerationDecision(current, record.evidenceHash);
  if (decision.action === "noop") return { outcome: "unchanged", id: current?.id ?? null };

  if (decision.supersedeId) {
    const { error } = await db
      .from(REPORT_TABLE)
      .update({ status: "superseded" })
      .eq("id", decision.supersedeId)
      .eq("status", "current");
    if (error && !isMissingSchemaError(error)) {
      throw new Error(`insight_report supersede failed: ${error.message}`);
    }
  }

  const { data, error } = await db
    .from(REPORT_TABLE)
    .insert({
      vibepin_user_id: uid,
      connection_id: connectionId,
      kind: record.kind,
      subject_content_id: record.subjectContentId,
      subject_draft_id: record.subjectDraftId,
      period_key: record.periodKey,
      version: decision.version,
      evidence_snapshot: record.snapshot,
      evidence_hash: record.evidenceHash,
      evidence_version: record.evidenceVersion,
      rule_version: record.ruleVersion,
      keyword_set_version: record.keywordSetVersion,
      narrative_status: "template",
      status: "current",
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (isMissingSchemaError(error)) return { outcome: "unavailable", id: null };
    if (isUniqueViolation(error) && attempt === 0) {
      return storeReport(db, uid, connectionId, record, attempt + 1);
    }
    throw new Error(`insight_report insert failed: ${error.message}`);
  }

  return {
    outcome: decision.supersedeId ? "versioned" : "created",
    id: data ? String(data.id) : null,
  };
}

// ── Generation ───────────────────────────────────────────────────────────────

export type ReportGenerationResult = {
  connectionId: string;
  /** Why nothing was written, when nothing was. */
  skipped: "plan" | "connection_not_found" | "no_finished_run" | "schema_unavailable" | null;
  weekly: { due: boolean; created: number; unchanged: number };
  scorecards: { due: number; created: number; unchanged: number };
  reportIds: string[];
};

const EMPTY_RESULT = (connectionId: string, skipped: ReportGenerationResult["skipped"]): ReportGenerationResult => ({
  connectionId,
  skipped,
  weekly: { due: false, created: 0, unchanged: 0 },
  scorecards: { due: 0, created: 0, unchanged: 0 },
  reportIds: [],
});

/**
 * Generate this connection's due reports: the weekly one on Mondays, plus every
 * scorecard whose Pin has come of age.
 *
 * Written to be safe to run every night. Everything it produces is decided by the
 * evidence hash, so a second run on the same day writes nothing at all.
 */
export async function generateReportsForConnection(
  uid: string,
  connectionId: string,
  options: { now?: Date; force?: boolean } = {},
): Promise<ReportGenerationResult> {
  const now = options.now ?? new Date();
  const force = options.force === true;

  const plan = await resolvePlan(uid).catch(() => "free" as const);
  if (!insightsDiagnosisAllowed(plan)) return EMPTY_RESULT(connectionId, "plan");

  const connections = (await listConnections(uid)).filter(item => item.provider === "pinterest");
  const connection = connections.find(item => item.id === connectionId);
  if (!connection) return EMPTY_RESULT(connectionId, "connection_not_found");

  const startDate = utcDateDaysAgo(29);
  const endDate = utcDateDaysAgo(0);
  const sources = reportSources(
    uid,
    connection.id,
    connection.metadata ?? null,
    connections.map(item => item.id),
    startDate,
    endDate,
  );

  const read = await readConnectionEvidence(
    {
      scope: "account",
      connection: {
        id: connection.id,
        providerAccountId: connection.providerAccountId,
        providerAccountName: connection.providerAccountName,
        providerAccountUsername: connection.providerAccountUsername,
      },
      startDate,
      endDate,
    },
    sources,
  );
  if (!read) return EMPTY_RESULT(connectionId, "no_finished_run");

  const db = createServerClient();
  const result = EMPTY_RESULT(connectionId, null);
  let schemaAvailable = true;

  const apply = (outcome: WriteOutcome, id: string | null, bucket: { created: number; unchanged: number }) => {
    if (outcome === "unavailable") { schemaAvailable = false; return; }
    if (outcome === "unchanged") bucket.unchanged += 1;
    else bucket.created += 1;
    if (id) result.reportIds.push(id);
  };

  // ── Weekly ──
  result.weekly.due = isWeeklyDue(now, force);
  if (result.weekly.due) {
    const record = buildWeeklyReport({
      set: read.set,
      diagnosis: read.diagnosis,
      now,
      dataThrough: read.dataUpdatedAt,
    });
    const { outcome, id } = await storeReport(db, uid, connection.id, record);
    apply(outcome, id, result.weekly);
  }

  // ── Scorecards ──
  // Only Pins VibePin published: a scorecard says "the thing you made, seven days
  // later", and a Pin the user posted from their phone was never a VibePin action.
  for (const pin of read.published) {
    if (!schemaAvailable) break;
    const kind = scorecardDueKind(pin.publishedAt, now);
    if (!kind) continue;
    const metrics: ScorecardMetrics = {
      impressions: read.lookup.value("content", pin.pinId, "IMPRESSION", "lifetime", null),
      saves: read.lookup.value("content", pin.pinId, "SAVE", "lifetime", null),
      pinClicks: read.lookup.value("content", pin.pinId, "PIN_CLICK", "lifetime", null),
      outboundClicks: read.lookup.value("content", pin.pinId, "OUTBOUND_CLICK", "lifetime", null),
    };
    // Nothing measured yet: a scorecard reporting four dashes is not a scorecard,
    // and freezing one would waste the period_key this Pin gets exactly once.
    if (!hasScorecardMeasurement(metrics)) continue;
    result.scorecards.due += 1;

    const record = buildScorecardReport({
      kind,
      subject: {
        contentId: pin.pinId,
        draftId: pin.draftId || null,
        title: pin.title ?? null,
        publishedAt: pin.publishedAt ?? null,
        postUrl: pin.postUrl ?? null,
      },
      pinEvidence: read.set.byPin.get(pin.pinId) ?? [],
      metrics,
      set: read.set,
      accountHeadline: read.diagnosis.headline,
      now,
      dataThrough: read.dataUpdatedAt,
    });
    const { outcome, id } = await storeReport(db, uid, connection.id, record);
    apply(outcome, id, result.scorecards);
  }

  if (!schemaAvailable) return EMPTY_RESULT(connectionId, "schema_unavailable");
  return result;
}

// ── Reading ──────────────────────────────────────────────────────────────────

function snapshotOf(raw: unknown): InsightReportSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as InsightReportSnapshot;
  if (!candidate.content || typeof candidate.kind !== "string") return null;
  return candidate;
}

function narrativeStatusOf(raw: string | null): InsightNarrativeStatus {
  return raw === "llm" || raw === "llm_failed_fallback" ? raw : "template";
}

function summaryOf(row: StoredRow): InsightReportSummary | null {
  const snapshot = snapshotOf(row.evidence_snapshot);
  if (!snapshot) return null;
  return {
    id: row.id,
    kind: row.kind,
    periodKey: row.period_key,
    subjectContentId: row.subject_content_id,
    subjectDraftId: row.subject_draft_id,
    version: Number(row.version),
    generatedAt: row.generated_at,
    viewedAt: row.viewed_at,
    narrativeStatus: narrativeStatusOf(row.narrative_status),
    headline: headlineOf(snapshot),
    dataThrough: snapshot.meta?.dataThrough ?? null,
  };
}

const ROW_COLUMNS =
  "id,kind,period_key,subject_content_id,subject_draft_id,version,evidence_hash,evidence_snapshot,rule_version,keyword_set_version,narrative_status,generated_at,viewed_at";

/**
 * This user's current reports, newest first.
 *
 * `connectionIds` is always supplied by the caller from a verified ownership list,
 * and the query filters on `vibepin_user_id` as well — belt and braces, because a
 * report id is the one handle that leaves the server.
 */
export async function listCurrentReports(
  uid: string,
  options: { connectionIds: string[]; kind?: InsightReportKind; limit?: number } = { connectionIds: [] },
): Promise<InsightReportSummary[]> {
  if (options.connectionIds.length === 0) return [];
  const db = createServerClient();
  let query = db
    .from(REPORT_TABLE)
    .select(ROW_COLUMNS)
    .eq("vibepin_user_id", uid)
    .in("connection_id", options.connectionIds)
    .eq("status", "current")
    .order("generated_at", { ascending: false })
    .limit(Math.min(options.limit ?? REPORT_LIST_LIMIT, REPORT_LIST_LIMIT));
  if (options.kind) query = query.eq("kind", options.kind);

  const { data, error } = await query;
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new Error(`insight_report list failed: ${error.message}`);
  }
  return (data ?? [])
    .map(row => summaryOf(row as unknown as StoredRow))
    .filter((row): row is InsightReportSummary => row !== null);
}

/**
 * One report, and the moment it stops being editable.
 *
 * Marking `viewed_at` is the ONLY update this module makes to a report row, and it
 * happens exactly once — the guard trigger closes the content columns from here on.
 * That ordering is the point: a report becomes immutable when a human has seen it,
 * not when a job decides it is finished.
 */
export async function readReport(uid: string, reportId: string): Promise<InsightReportDetail | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from(REPORT_TABLE)
    .select(ROW_COLUMNS)
    .eq("id", reportId)
    .eq("vibepin_user_id", uid)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new Error(`insight_report read failed: ${error.message}`);
  }
  if (!data) return null;

  const row = data as unknown as StoredRow;
  const summary = summaryOf(row);
  const snapshot = snapshotOf(row.evidence_snapshot);
  if (!summary || !snapshot) return null;

  let viewedAt = row.viewed_at;
  if (!viewedAt) {
    const stamp = new Date().toISOString();
    const { error: markError } = await db
      .from(REPORT_TABLE)
      .update({ viewed_at: stamp })
      .eq("id", reportId)
      .is("viewed_at", null);
    // A failed mark must not withhold the report: the user asked to read it, and
    // bookkeeping is our problem, not theirs.
    if (markError) console.error("[insights/reports] viewed_at mark failed:", markError.message);
    else viewedAt = stamp;
  }

  const { data: feedback } = await db
    .from(FEEDBACK_TABLE)
    .select("helpful")
    .eq("report_id", reportId)
    .eq("vibepin_user_id", uid)
    .maybeSingle();

  return {
    ...summary,
    viewedAt,
    evidenceHash: row.evidence_hash,
    ruleVersion: row.rule_version,
    keywordSetVersion: row.keyword_set_version,
    snapshot,
    helpful: typeof feedback?.helpful === "boolean" ? feedback.helpful : null,
  };
}

/**
 * A thumb, up or down. Upsert on the (report, user) key: a changed mind replaces the
 * old answer instead of stacking a second one, which is what makes the ratio of
 * helpful to unhelpful mean anything.
 *
 * Returns false when the report is not this user's — the caller turns that into a
 * 404 rather than a 403, so a report id cannot be probed for existence.
 */
export async function saveReportFeedback(
  uid: string,
  reportId: string,
  helpful: boolean,
): Promise<boolean> {
  const db = createServerClient();
  const { data: owned, error: ownedError } = await db
    .from(REPORT_TABLE)
    .select("id")
    .eq("id", reportId)
    .eq("vibepin_user_id", uid)
    .maybeSingle();
  if (ownedError) {
    if (isMissingSchemaError(ownedError)) return false;
    throw new Error(`insight_report ownership check failed: ${ownedError.message}`);
  }
  if (!owned) return false;

  const { error } = await db
    .from(FEEDBACK_TABLE)
    .upsert(
      { report_id: reportId, vibepin_user_id: uid, helpful },
      { onConflict: "report_id,vibepin_user_id" },
    );
  if (error) {
    if (isMissingSchemaError(error)) return false;
    throw new Error(`insight_report_feedback write failed: ${error.message}`);
  }
  return true;
}

/** The Pinterest connection ids this user owns — the ownership list every read uses. */
export async function pinterestConnectionIds(uid: string, only?: string | null): Promise<string[]> {
  const connections = (await listConnections(uid)).filter(item => item.provider === "pinterest");
  if (only) return connections.filter(item => item.id === only).map(item => item.id);
  return connections.map(item => item.id);
}
