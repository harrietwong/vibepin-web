// ── Admin usage & plan visibility — READ-ONLY derivation over usage_accounts ──
//
// Powers three surfaces, all from ONE loader + ONE pure summarizer:
//   * Customer 360's "Usage & Plan" card,
//   * the /admin/users list's Plan column + plan filter,
//   * /admin/today's "Quota Watch" card.
//
// ═══════════════════════════════════════════════════════════════════════════════
// DATA SOURCE — v55/v56 lineage ONLY
// ═══════════════════════════════════════════════════════════════════════════════
// Production runs the reserve/settle ledger: `usage_accounts` (one row per user,
// created LAZILY on the user's first metered action) plus a `usage_events`
// journal whose columns are user_id / account_id / reservation_id /
// balance_before / balance_after / source.
//
// There is a SECOND, incompatible design in the repo — `web/src/lib/server/
// usage.ts` (the v57 migration's owner_id / owner_type shape). That table shape
// does NOT exist in production: every write it makes fails with 42703 and is
// swallowed, and every read it makes returns nothing. **Never import it here.**
// Reading usage through it would render a confident, silent, permanent 0 for
// every user — the single most dangerous failure mode for this feature, because
// it looks exactly like a correct answer.
//
// This module therefore reads `usage_accounts` directly, with the SAME column
// choices as the user-facing GET /api/billing/usage:
//   * `*_used` (settled) is "used"; `*_reserved` is IN-FLIGHT work that may be
//     released, so it is NOT counted. Counting it would make the admin number
//     disagree with the number the customer sees in Settings.
//   * `balance_before` / `balance_after` on usage_events are snapshots of TOTAL
//     OCCUPIED capacity (used + reserved) and increase monotonically — they are
//     NOT a remaining balance despite the name. Remaining is always computed
//     here as `limit - used`.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THREE STATES — "we measured 0" ≠ "we never measured" ≠ "we don't know"
// ═══════════════════════════════════════════════════════════════════════════════
//   metered      a usage_accounts row exists → real numbers, and a real 0 is
//                shown AS 0.
//   unmetered    the query SUCCEEDED and returned no row → the user has never
//                triggered metering. Shows the plan's included allowances with
//                an explicit badge, and NO progress bar (there is no measured
//                fraction to draw).
//   unavailable  the query FAILED (missing table/column, permission, timeout,
//                network) → we do not know. Shows a sync-error state.
//
// Collapsing `unavailable` into `unmetered` is the honesty bug this module is
// built to prevent: one says "confirmed nothing happened", the other says
// "we couldn't look". They must never render the same.
//
// SECURITY: plan is read from the usage account snapshot or app_metadata.plan
// only — NEVER user_metadata, which the user can edit on themselves (the
// e2543f6 / d8dbb9f trust boundary). This module contains no write path and no
// account-creation path: an admin GET must never mint billing state.

import {
  createAdminDb,
  isMissingSchema,
  paginateRows,
  type PgError,
  type SupabaseLikeDb,
} from "./adminQueryUtils";
import { normalizePlanKey, type PlanKey } from "./entitlements";
import { PLAN_ENTITLEMENTS } from "./planEntitlements";

// ── row shape (exactly the columns that exist in production) ─────────────────

export interface UsageAccountRow {
  user_id: string;
  plan_key: string | null;
  period_start: string | null;
  period_end: string | null;
  ai_images_used: number | null;
  ai_images_limit: number | null;
  ai_text_generations_used: number | null;
  ai_text_generations_limit: number | null;
  scheduled_posts_used: number | null;
  scheduled_posts_limit: number | null;
  bonus_images_balance: number | null;
}

/**
 * The columns selected. `*_reserved` is deliberately absent: not selecting it
 * makes "reserved is not part of used" structurally true rather than a rule
 * someone has to remember downstream.
 */
export const USAGE_ACCOUNT_COLUMNS =
  "user_id, plan_key, period_start, period_end, " +
  "ai_images_used, ai_images_limit, " +
  "ai_text_generations_used, ai_text_generations_limit, " +
  "scheduled_posts_used, scheduled_posts_limit, " +
  "bonus_images_balance";

// ── loader contract ──────────────────────────────────────────────────────────

export interface UsageAccountsLoad {
  /** userId → row. Only users who actually have a row appear. */
  byUser: Map<string, UsageAccountRow>;
  /**
   * false when the query failed. Every requested user is then `unavailable`;
   * an empty `byUser` must NOT be read as "nobody is metered".
   */
  available: boolean;
  warnings: string[];
  /** Users seen with more than one account row (a data-quality anomaly). */
  duplicateUserIds: string[];
}

const METRIC_KEYS = ["aiImages", "aiTextGenerations", "scheduledPosts"] as const;
export type UsageMetricKey = (typeof METRIC_KEYS)[number];
export const USAGE_METRIC_KEYS: readonly UsageMetricKey[] = METRIC_KEYS;

export type UsageState = "metered" | "unmetered" | "unavailable";

export interface UsageMetricView {
  key: UsageMetricKey;
  /** Settled usage. null ⇒ not measured (unmetered / unavailable). */
  used: number | null;
  /** Enforced cap on the account this period. null ⇒ unlimited OR unknown. */
  limit: number | null;
  /** What the plan advertises. null ⇒ unlimited. Always known from the plan. */
  included: number | null;
  /** max(limit - used, 0). null when unlimited or not measured. */
  remaining: number | null;
  /** used - limit when used > limit, else null. Never folded into `remaining`. */
  overage: number | null;
  /** used / limit, 0..1+ . null when unlimited or not measured. */
  ratio: number | null;
  /** true when limit === null on a metered row (unlimited: no bar, no 80%). */
  unlimited: boolean;
  /** true when a progress bar may be drawn (metered + finite positive limit). */
  showProgress: boolean;
}

export interface UsageSummaryView {
  userId: string;
  state: UsageState;
  /** Convenience mirror of `state === "metered"`. */
  metered: boolean;
  /** The plan to display/filter by. Never null — falls back to "free". */
  plan: PlanKey;
  /** Where `plan` came from. */
  planSource: "account" | "appMetadata" | "default";
  /** true when the account snapshot and app_metadata name different plans. */
  planDrift: boolean;
  /** The app_metadata plan, normalized. null when absent/unrecognized. */
  appMetadataPlan: PlanKey | null;
  /** The account snapshot plan, normalized. null when no row / unrecognized. */
  accountPlan: PlanKey | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** null unless metered. */
  bonusImages: number | null;
  metrics: Record<UsageMetricKey, UsageMetricView>;
  /** Data-quality notes (negative counters, duplicate rows, broken period …). */
  anomalies: string[];
}

/** Included-allowance lookup per metric, straight from the canonical plan table. */
function includedFor(plan: PlanKey, key: UsageMetricKey): number | null {
  const e = PLAN_ENTITLEMENTS[plan];
  switch (key) {
    case "aiImages": return e.monthlyAiImages;
    case "aiTextGenerations": return e.monthlyAiTextGenerations;
    case "scheduledPosts": return e.monthlyScheduledPosts;
  }
}

function rawUsed(row: UsageAccountRow, key: UsageMetricKey): number | null {
  switch (key) {
    case "aiImages": return row.ai_images_used;
    case "aiTextGenerations": return row.ai_text_generations_used;
    case "scheduledPosts": return row.scheduled_posts_used;
  }
}

function rawLimit(row: UsageAccountRow, key: UsageMetricKey): number | null {
  switch (key) {
    case "aiImages": return row.ai_images_limit;
    case "aiTextGenerations": return row.ai_text_generations_limit;
    case "scheduledPosts": return row.scheduled_posts_limit;
  }
}

/**
 * A counter column that is NULL in the DB defaults to 0 (the column default) —
 * on a row that exists, "no value written yet" genuinely means zero consumed.
 * A non-finite or negative value is surfaced as-is by the caller so the anomaly
 * is visible; it is NOT laundered into 0 here.
 */
function settled(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ── effectivePlan: the ONE plan resolution every surface must use ────────────

export interface PlanResolution {
  plan: PlanKey;
  source: "account" | "appMetadata" | "default";
  drift: boolean;
  accountPlan: PlanKey | null;
  appMetadataPlan: PlanKey | null;
}

/**
 * Resolve the plan to display for a user.
 *
 * Precedence: the usage account snapshot (`usage_accounts.plan_key`) wins,
 * because it is the allowance actually being ENFORCED against the user for this
 * period — even if billing has since moved them to another tier, the caps in
 * force right now are the snapshot's. `app_metadata.plan` (the service-role-only
 * cache the Creem webhook refreshes) is the fallback, and "free" is the floor.
 *
 * When the two disagree the snapshot is shown AND `drift` is set, so a mid-period
 * upgrade/downgrade is visible rather than silently papered over.
 *
 * `appMetadata` is passed in as the raw bag; `user_metadata` is intentionally not
 * a parameter of this function, so it cannot be read by accident.
 */
export function effectivePlan(
  accountPlanKey: string | null | undefined,
  appMetadata: Record<string, unknown> | null | undefined,
): PlanResolution {
  const accountPlan = normalizePlanKey(accountPlanKey);
  const appMetadataPlan = normalizePlanKey(appMetadata?.["plan"]);
  const drift =
    accountPlan !== null && appMetadataPlan !== null && accountPlan !== appMetadataPlan;

  if (accountPlan) return { plan: accountPlan, source: "account", drift, accountPlan, appMetadataPlan };
  if (appMetadataPlan) return { plan: appMetadataPlan, source: "appMetadata", drift, accountPlan, appMetadataPlan };
  return { plan: "free", source: "default", drift, accountPlan, appMetadataPlan };
}

// ── summarizeUsage: pure ─────────────────────────────────────────────────────

export interface SummarizeInput {
  userId: string;
  /** The account row, or null when the query SUCCEEDED with zero rows. */
  row: UsageAccountRow | null;
  /** Raw app_metadata bag (never user_metadata). */
  appMetadata?: Record<string, unknown> | null;
  /**
   * true when the usage_accounts read FAILED for this user. Overrides `row`:
   * an unavailable read can never be reported as unmetered.
   */
  unavailable?: boolean;
  /** true when >1 account row was seen for this user (surfaced as an anomaly). */
  duplicate?: boolean;
}

/**
 * Pure. Given one account row (or its absence, or the fact the read failed),
 * produce everything the three admin surfaces render.
 */
export function summarizeUsage(input: SummarizeInput): UsageSummaryView {
  const { userId, row, appMetadata = null } = input;
  const unavailable = input.unavailable === true;
  const anomalies: string[] = [];

  const resolution = effectivePlan(unavailable ? null : row?.plan_key ?? null, appMetadata);
  const state: UsageState = unavailable ? "unavailable" : row ? "metered" : "unmetered";

  if (input.duplicate) anomalies.push("duplicate_account_rows");
  if (resolution.drift) anomalies.push("plan_drift");

  const metrics = {} as Record<UsageMetricKey, UsageMetricView>;

  for (const key of METRIC_KEYS) {
    const included = includedFor(resolution.plan, key);

    if (state !== "metered" || !row) {
      // Not measured: no used, no limit, no ratio, no bar. `included` still
      // answers "what does this plan come with", which is knowable either way.
      metrics[key] = {
        key,
        used: null,
        limit: null,
        included,
        remaining: null,
        overage: null,
        ratio: null,
        unlimited: included === null,
        showProgress: false,
      };
      continue;
    }

    const usedRaw = rawUsed(row, key);
    const limit = rawLimit(row, key);
    const used = settled(usedRaw);

    if (typeof usedRaw === "number" && Number.isFinite(usedRaw)) {
      if (usedRaw < 0) anomalies.push(`negative_used:${key}`);
      else if (!Number.isInteger(usedRaw)) anomalies.push(`non_integer_used:${key}`);
    }
    if (typeof limit === "number" && (!Number.isFinite(limit) || limit < 0)) {
      anomalies.push(`invalid_limit:${key}`);
    }

    const unlimited = limit === null;
    // A finite limit of 0 means "this plan does not offer the feature": it is a
    // real cap, but dividing by it is undefined, so no ratio and no bar.
    const finitePositiveLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;

    const remaining = unlimited || typeof limit !== "number" || !Number.isFinite(limit)
      ? null
      : Math.max(limit - used, 0);
    const overage = typeof limit === "number" && Number.isFinite(limit) && used > limit
      ? used - limit
      : null;
    const ratio = finitePositiveLimit ? used / (limit as number) : null;

    if (overage !== null) anomalies.push(`over_limit:${key}`);

    metrics[key] = {
      key,
      used,
      limit,
      included,
      remaining,
      overage,
      ratio,
      unlimited,
      showProgress: finitePositiveLimit,
    };
  }

  if (state === "metered" && row) {
    const startMs = row.period_start ? Date.parse(row.period_start) : NaN;
    const endMs = row.period_end ? Date.parse(row.period_end) : NaN;
    if (!row.period_start || !row.period_end || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      anomalies.push("missing_period");
    } else if (endMs <= startMs) {
      anomalies.push("invalid_period");
    }
  }

  return {
    userId,
    state,
    metered: state === "metered",
    plan: resolution.plan,
    planSource: resolution.source,
    planDrift: resolution.drift,
    appMetadataPlan: resolution.appMetadataPlan,
    accountPlan: resolution.accountPlan,
    periodStart: state === "metered" ? row?.period_start ?? null : null,
    periodEnd: state === "metered" ? row?.period_end ?? null : null,
    bonusImages: state === "metered" && row ? settled(row.bonus_images_balance) : null,
    metrics,
    anomalies,
  };
}

// ── quota watch (a SEPARATE operator signal, never a blocker) ────────────────

/**
 * How full a bucket must be before it is worth an operator's attention. This is
 * a commercial heuristic ("might need an upgrade"), NOT a fault threshold: it
 * must never feed the blocker list or the health score, whose job is "this
 * user's creation flow is broken".
 */
export const QUOTA_WATCH_THRESHOLD = 0.8;

export interface QuotaWatchMetric {
  key: UsageMetricKey;
  used: number;
  limit: number;
  remaining: number;
  ratio: number;
  overage: number | null;
}

export interface QuotaWatchItem {
  userId: string;
  email: string | null;
  plan: PlanKey;
  periodEnd: string | null;
  /** ms until period_end; null when unknown. Negative ⇒ the period lapsed. */
  msUntilPeriodEnd: number | null;
  /** Every bucket at/over the threshold, worst first. */
  metrics: QuotaWatchMetric[];
  /** The highest ratio across `metrics` — the sort key. */
  topRatio: number;
}

/**
 * Pick the buckets that deserve attention for one user.
 *
 * Included ONLY when the user is `metered` AND the bucket has a finite POSITIVE
 * limit. Unlimited (`limit === null`), unmetered, and unavailable users are
 * excluded by construction — a percentage of an unknown or absent denominator is
 * not a number an operator can act on.
 */
export function quotaWatchMetricsFor(
  summary: UsageSummaryView,
  threshold: number = QUOTA_WATCH_THRESHOLD,
): QuotaWatchMetric[] {
  if (summary.state !== "metered") return [];
  const out: QuotaWatchMetric[] = [];
  for (const key of METRIC_KEYS) {
    const m = summary.metrics[key];
    if (m.unlimited || !m.showProgress) continue;
    if (m.used === null || m.limit === null || m.ratio === null || m.remaining === null) continue;
    if (m.ratio < threshold) continue;
    out.push({ key, used: m.used, limit: m.limit, remaining: m.remaining, ratio: m.ratio, overage: m.overage });
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

/** Build the /admin/today Quota Watch list from already-summarized users. */
export function buildQuotaWatch(
  summaries: Iterable<UsageSummaryView>,
  emailByUser: Map<string, string | null>,
  now: number = Date.now(),
  threshold: number = QUOTA_WATCH_THRESHOLD,
): QuotaWatchItem[] {
  const items: QuotaWatchItem[] = [];
  for (const s of summaries) {
    const metrics = quotaWatchMetricsFor(s, threshold);
    if (metrics.length === 0) continue;
    const endMs = s.periodEnd ? Date.parse(s.periodEnd) : NaN;
    items.push({
      userId: s.userId,
      email: emailByUser.get(s.userId) ?? null,
      plan: s.plan,
      periodEnd: s.periodEnd,
      msUntilPeriodEnd: Number.isFinite(endMs) ? endMs - now : null,
      metrics,
      topRatio: metrics[0].ratio,
    });
  }
  items.sort((a, b) => b.topRatio - a.topRatio || a.userId.localeCompare(b.userId));
  return items;
}

// ── batch loader (no N+1, no truncation) ─────────────────────────────────────

const IN_CHUNK = 200; // keep the `in(...)` URL well under PostgREST's limits

/**
 * Load every requested user's usage account in ONE paginated scan per chunk of
 * ids — never one query per user. Chunking bounds the URL length; the paginated
 * loader inside each chunk defeats supabase-js's silent 1000-row cap.
 *
 * A failed read sets `available: false` and yields a warning. Callers MUST NOT
 * treat the resulting empty map as "no one is metered" — pass `unavailable` into
 * summarizeUsage so those users render as `unavailable`, not `unmetered`.
 */
export async function loadUsageAccounts(
  userIds: string[],
  injectedDb?: SupabaseLikeDb,
): Promise<UsageAccountsLoad> {
  const byUser = new Map<string, UsageAccountRow>();
  const warnings: string[] = [];
  const duplicates = new Set<string>();

  const unique = Array.from(new Set(userIds.filter(id => typeof id === "string" && id.length > 0)));
  if (unique.length === 0) return { byUser, available: true, warnings, duplicateUserIds: [] };

  const db = injectedDb ?? (await createAdminDb());

  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    let result;
    try {
      result = await paginateRows<UsageAccountRow>(db, "usage_accounts", {
        columns: USAGE_ACCOUNT_COLUMNS,
        orderColumn: "user_id",
        ascending: true,
        filters: qb => qb.in("user_id", chunk),
      });
    } catch (e) {
      warnings.push(describeUsageFailure({ message: e instanceof Error ? e.message : String(e) }));
      return { byUser: new Map(), available: false, warnings, duplicateUserIds: [] };
    }

    if (result.error) {
      // Missing table, missing column, permission, timeout — all the same answer:
      // we do not know. Degrade the WHOLE load rather than returning a partial map
      // that would silently read as "these users have no usage".
      warnings.push(describeUsageFailure(result.error));
      return { byUser: new Map(), available: false, warnings, duplicateUserIds: [] };
    }

    for (const row of result.rows) {
      const uid = row?.user_id;
      if (typeof uid !== "string" || uid.length === 0) continue;
      if (byUser.has(uid)) duplicates.add(uid);
      else byUser.set(uid, row);
    }

    if (result.saturated) {
      warnings.push("Usage account scan hit the pagination ceiling — some users may be missing usage data.");
    }
  }

  if (duplicates.size > 0) {
    warnings.push(`${duplicates.size} user(s) have more than one usage_accounts row — showing the first.`);
  }

  return { byUser, available: true, warnings, duplicateUserIds: Array.from(duplicates) };
}

function describeUsageFailure(error: PgError): string {
  if (isMissingSchema(error)) {
    return "Usage unavailable — the usage_accounts table/columns are not present in this database.";
  }
  return `Usage unavailable — usage_accounts could not be read: ${error?.message ?? "unknown error"}`;
}

// ── convenience: load + summarize a cohort in one call ───────────────────────

export interface UsageCohort {
  byUser: Map<string, UsageSummaryView>;
  available: boolean;
  warnings: string[];
}

export interface CohortUser {
  id: string;
  app_metadata?: Record<string, unknown> | null;
}

/**
 * Summarize a whole cohort. Every requested user gets an entry — a user with no
 * row is `unmetered`, and if the read failed EVERY user is `unavailable`. There
 * is no code path where a missing entry has to be interpreted by the caller.
 */
export async function summarizeUsageForUsers(
  users: CohortUser[],
  injectedDb?: SupabaseLikeDb,
): Promise<UsageCohort> {
  const load = await loadUsageAccounts(users.map(u => u.id), injectedDb);
  const duplicates = new Set(load.duplicateUserIds);
  const byUser = new Map<string, UsageSummaryView>();
  for (const u of users) {
    byUser.set(
      u.id,
      summarizeUsage({
        userId: u.id,
        row: load.available ? load.byUser.get(u.id) ?? null : null,
        appMetadata: u.app_metadata ?? null,
        unavailable: !load.available,
        duplicate: duplicates.has(u.id),
      }),
    );
  }
  return { byUser, available: load.available, warnings: load.warnings };
}

/** Single-user variant for Customer 360. Same states, same rules. */
export async function getUserUsageSummary(
  user: CohortUser,
  injectedDb?: SupabaseLikeDb,
): Promise<{ summary: UsageSummaryView; warnings: string[] }> {
  const cohort = await summarizeUsageForUsers([user], injectedDb);
  const summary =
    cohort.byUser.get(user.id) ??
    summarizeUsage({ userId: user.id, row: null, appMetadata: user.app_metadata ?? null, unavailable: true });
  return { summary, warnings: cohort.warnings };
}
