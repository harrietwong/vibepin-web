// ── Admin Feature Adoption — "has anyone actually used this?" (READ-ONLY) ────
//
// PRD: docs/prd/后台异常提醒与功能评价体系-PRD-v0.1-20260902.md §3 (Part B).
//
// Answers a DIFFERENT question than adminAiAdoption.ts (which measures generation
// → published-draft CONVERSION). This module measures, per declared FEATURE,
// whether real customers have ever touched it at all, and if so how deeply
// (first use / repeat use / cross-week retention) — the last three legs of the
// funnel in PRD §3.3:
//
//     exposure → first use → repeat use (>=2) → retention (active in >=2 weeks)
//
// "exposure" (did the user ever SEE the entry point) is not tracked anywhere in
// this codebase — no negative events exist — so it is NEVER computed here. Every
// feature's exposure segment is hard-coded `not_measured`. Synthesizing a number
// for it (e.g. "0" or "total users") would be exactly the false-precision this
// PRD's diagnostics culture forbids (§3.6).
//
// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE → EVENT MAP (documented, not guessed — each line cites its source)
// ═══════════════════════════════════════════════════════════════════════════════
// Event vocabulary is the literal `AnalyticsEvent` union in `src/lib/analytics.ts`
// (client-fired) plus the three server-fired publish events in
// `adminActionCenter.ts` / `publishEvents.ts`. Every event below is grep-confirmed
// to exist in that union; nothing here is invented.
//
//   AI image generation   generation_judged, generation_kept, regenerate_clicked
//                          — the three events that only fire once a generation
//                          exists and the user acted on its output.
//   Reference recommender  reference_selected, reference_rejected
//                          — the only two events the reference-recs UI fires.
//   Creative direction     direction_selected, direction_rejected
//                          — direction_rejected exists in the enum but is a P0-3
//                          addition (PRD §0.2 F4): 0 rows in production until the
//                          branch carrying it ships. Still MEASURED (not
//                          not_measured) once deployed, because the SIGNAL is
//                          real — a genuine zero would mean "deployed, unused".
//   AI copy                ai_copy_generate_clicked, ai_copy_success
//                          — click-through + a successful generation; explicitly
//                          excludes the rate-limited/provider-failed variants,
//                          which are failure telemetry, not usage.
//   Image analysis          image_analysis_started, image_analysis_ready
//                          — excludes image_analysis_failed/rate_limited for the
//                          same reason.
//   Keyword recommendations recommended_keywords_ready, keyword_removed
//                          — keyword_removed is an explicit interaction signal
//                          (the user engaged enough to prune a suggestion), not
//                          a negative/failure event.
//   Publish (Pinterest)     pinterest_publish_attempted, pinterest_publish_succeeded
//                          — server-fired (publishEvents.ts), not in the client
//                          AnalyticsEvent union; confirmed present in
//                          adminActionCenter.ts's PUBLISH_EVENT_* constants.
//   Scheduling               draft_scheduled
//                          — PRD §0.2 F4: code is deployed but production has 0
//                          rows as of this writing because the branch carrying it
//                          has not shipped. See NOT_YET_DEPLOYED below — this is
//                          the canonical "not_measured, not zero" case this
//                          module exists to get right.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THREE STATES (adminUsage.ts's paradigm, generalized — PRD §3.6)
// ═══════════════════════════════════════════════════════════════════════════════
//   measured       the analytics_events scan SUCCEEDED. A real zero renders as 0.
//   not_measured   the scan succeeded but this signal was never collected: either
//                  (a) the exposure segment (never instrumented at all), or
//                  (b) a feature whose events are known to be UNDEPLOYED — see
//                  NOT_YET_DEPLOYED. Zero rows here is NOT "zero usage", it is
//                  "we have not started counting yet".
//   unavailable    the analytics_events scan FAILED (missing table, permission,
//                  timeout). We do not know. NEVER collapsed into not_measured —
//                  that would let a query failure masquerade as "not tracked",
//                  the single most dangerous confusion this module can make.
//
// ═══════════════════════════════════════════════════════════════════════════════
// ZERO-USAGE DETECTION vs "NOT YET DEPLOYED" (PRD §3.4)
// ═══════════════════════════════════════════════════════════════════════════════
// A feature is flagged `zeroUsage: true` when it is `measured`, real customers
// exist, and the feature had NO events at all in the last `windowDays` (default
// 14). A feature in NOT_YET_DEPLOYED is NEVER flagged zeroUsage — it is reported
// `not_measured` instead, specifically so "nobody uses scheduling" (a product
// finding) is never confused with "scheduling's telemetry has not shipped yet"
// (a deploy-timing fact). Once NOT_YET_DEPLOYED is edited to drop an entry (i.e.
// the carrying branch ships), that feature becomes eligible for real zero-usage
// detection like any other.

import {
  createAdminDb,
  isoHoursAgo,
  listAllAuthUsers,
  paginateRows,
  type SupabaseLikeDb,
} from "./adminQueryUtils";
import { classifyAccount, emptyExcluded, type ExcludedCounts } from "./adminAccountKind";

// ── feature catalog ───────────────────────────────────────────────────────────

export type FeatureKey =
  | "aiImageGeneration"
  | "referenceRecommendations"
  | "creativeDirection"
  | "aiCopy"
  | "imageAnalysis"
  | "keywordRecommendations"
  | "publish"
  | "scheduling";

export const FEATURE_KEYS: readonly FeatureKey[] = [
  "aiImageGeneration",
  "referenceRecommendations",
  "creativeDirection",
  "aiCopy",
  "imageAnalysis",
  "keywordRecommendations",
  "publish",
  "scheduling",
];

/**
 * Usage-signal events per feature. See the module header for the citation of
 * each line. Order is not significant.
 */
export const FEATURE_EVENTS: Record<FeatureKey, readonly string[]> = {
  aiImageGeneration: ["generation_judged", "generation_kept", "regenerate_clicked"],
  referenceRecommendations: ["reference_selected", "reference_rejected"],
  creativeDirection: ["direction_selected", "direction_rejected"],
  aiCopy: ["ai_copy_generate_clicked", "ai_copy_success"],
  imageAnalysis: ["image_analysis_started", "image_analysis_ready"],
  keywordRecommendations: ["recommended_keywords_ready", "keyword_removed"],
  publish: ["pinterest_publish_attempted", "pinterest_publish_succeeded"],
  scheduling: ["draft_scheduled"],
};

/**
 * Features whose event code is deployed but has never run in production (PRD
 * §0.2 F4). Their events are still declared in FEATURE_EVENTS (so the mapping
 * stays honest about WHAT is instrumented), but this module reports them
 * `not_measured` unconditionally rather than trusting a literal 0-row scan
 * result, and they are exempt from zero-usage flagging.
 *
 * Edit this set (remove an entry) once that feature's carrying branch is
 * confirmed live in production — do not leave a shipped feature parked here,
 * or its zero-usage detector stays permanently disabled.
 */
export const NOT_YET_DEPLOYED: ReadonlySet<FeatureKey> = new Set<FeatureKey>(["scheduling"]);

// ── funnel segment types ──────────────────────────────────────────────────────

export type SegmentState = "measured" | "not_measured" | "unavailable";

/**
 * One funnel leg's absolute counts. Deliberately NO percentage field anywhere in
 * this file — PRD §3.6 forbids it outright at n<10. `usersWithSignal` and
 * `totalCustomers` are both absolute counts; the UI renders "N of M", never a
 * ratio.
 */
export interface FunnelSegment {
  state: SegmentState;
  /** Users counted as having reached this leg. null when not measured/unavailable. */
  usersWithSignal: number | null;
  /** Total real-customer cohort size this leg was evaluated against. */
  totalCustomers: number;
}

export interface FeatureAdoptionView {
  feature: FeatureKey;
  events: readonly string[];
  /** True for features in NOT_YET_DEPLOYED — the whole view is not_measured. */
  notYetDeployed: boolean;
  exposure: FunnelSegment; // always not_measured — see module header.
  firstUse: FunnelSegment;
  repeatUse: FunnelSegment;
  retention: FunnelSegment;
  /**
   * true only when: measured, not notYetDeployed, totalCustomers > 0, and zero
   * customers had any event for this feature in the scan window. This is the
   * PRD §3.4 "flag it" signal.
   */
  zeroUsage: boolean;
}

export interface FeatureAdoptionResult {
  available: boolean;
  generatedAt: string;
  windowDays: number;
  totalCustomers: number;
  features: FeatureAdoptionView[];
  warnings: string[];
  excluded: ExcludedCounts;
}

// ── pure aggregation ──────────────────────────────────────────────────────────

export interface UserEventHit {
  userId: string;
  /** ISO timestamp of one event occurrence for this user+feature. */
  createdAt: string;
}

/** Monday-anchored (UTC) ISO-week key, e.g. "2026-W36". Pure, deterministic. */
export function isoWeekKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid";
  // Copy + normalize to the Thursday of this ISO week (standard ISO-8601 algorithm).
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Given every event hit for ONE feature (already filtered to real customers),
 * compute the three measurable funnel legs. Pure — no I/O, independently
 * testable without a DB. `cohort` is every real-customer user id considered
 * (denominator for each leg), so a user who never appears in `hits` still
 * counts toward `totalCustomers`.
 */
export function aggregateFeatureUsage(
  hits: UserEventHit[],
  cohort: ReadonlySet<string>,
): { firstUse: number; repeatUse: number; retention: number; anyUsage: boolean } {
  const countByUser = new Map<string, number>();
  const weeksByUser = new Map<string, Set<string>>();

  for (const h of hits) {
    if (!cohort.has(h.userId)) continue; // non-customer rows never counted
    countByUser.set(h.userId, (countByUser.get(h.userId) ?? 0) + 1);
    const weeks = weeksByUser.get(h.userId) ?? new Set<string>();
    weeks.add(isoWeekKey(h.createdAt));
    weeksByUser.set(h.userId, weeks);
  }

  let firstUse = 0, repeatUse = 0, retention = 0;
  for (const uid of countByUser.keys()) {
    firstUse += 1;
    if ((countByUser.get(uid) ?? 0) >= 2) repeatUse += 1;
    if ((weeksByUser.get(uid)?.size ?? 0) >= 2) retention += 1;
  }

  return { firstUse, repeatUse, retention, anyUsage: countByUser.size > 0 };
}

// ── scan ────────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 14;

interface AnalyticsScanRow {
  user_id: string | null;
  event_name: string | null;
  created_at: string | null;
}

async function loadNonCustomerIds(
  db: SupabaseLikeDb,
  warnings: string[],
): Promise<{ ids: Set<string>; excluded: ExcludedCounts; allCustomerIds: Set<string> | null }> {
  const ids = new Set<string>();
  const excluded = emptyExcluded();
  const users = await listAllAuthUsers(db, warnings);
  if (users === null) {
    warnings.push("Auth user list unavailable — feature adoption could not exclude test/internal accounts and covers ALL users.");
    return { ids, excluded, allCustomerIds: null };
  }
  const allCustomerIds = new Set<string>();
  for (const u of users) {
    const kind = classifyAccount(u);
    if (kind === "customer") {
      allCustomerIds.add(u.id);
      continue;
    }
    excluded[kind] += 1;
    ids.add(u.id);
  }
  return { ids, excluded, allCustomerIds };
}

/**
 * Build the /admin/today feature-adoption summary.
 *
 * One paginated scan of analytics_events across ALL feature event names (not
 * one query per feature — avoids N+1), then partitioned in memory per feature.
 */
export async function getFeatureAdoption(
  injectedDb?: SupabaseLikeDb,
  options: { windowDays?: number; includeNonCustomers?: boolean } = {},
): Promise<FeatureAdoptionResult> {
  const db = injectedDb ?? (await createAdminDb());
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const includeNonCustomers = options.includeNonCustomers === true;
  const warnings: string[] = [];
  const generatedAt = new Date().toISOString();
  const since = isoHoursAgo(windowDays * 24);

  const nonCustomers = includeNonCustomers
    ? { ids: new Set<string>(), excluded: emptyExcluded(), allCustomerIds: null as Set<string> | null }
    : await loadNonCustomerIds(db, warnings);

  const allEventNames = Array.from(new Set(FEATURE_KEYS.flatMap(f => FEATURE_EVENTS[f])));

  const { rows, error, missing } = await paginateRows<AnalyticsScanRow>(db, "analytics_events", {
    columns: "user_id,event_name,created_at",
    filters: qb => qb.in("event_name", allEventNames).gte("created_at", since),
    orderColumn: "created_at",
    ascending: true,
  });

  if (missing) {
    warnings.push("analytics_events unavailable — feature adoption cannot be computed.");
    return emptyUnavailable(generatedAt, windowDays, warnings, nonCustomers.excluded);
  }
  if (error) {
    warnings.push(`analytics_events scan failed: ${error.message ?? "unknown"} — feature adoption cannot be computed.`);
    return emptyUnavailable(generatedAt, windowDays, warnings, nonCustomers.excluded);
  }

  // Cohort denominator: every real-customer id we know about. When the auth
  // list itself was unavailable, `allCustomerIds` is null — cohort size is then
  // unknown, so `totalCustomers` degrades to the count of DISTINCT users seen in
  // the scan (a floor, never inflated) and is surfaced via a warning rather than
  // pretending we know the true denominator.
  let cohort: Set<string>;
  let totalCustomers: number;
  if (includeNonCustomers) {
    cohort = new Set(rows.map(r => r.user_id).filter((v): v is string => !!v));
    totalCustomers = cohort.size;
  } else if (nonCustomers.allCustomerIds) {
    cohort = nonCustomers.allCustomerIds;
    totalCustomers = cohort.size;
  } else {
    cohort = new Set(rows.map(r => r.user_id).filter((v): v is string => !!v && !nonCustomers.ids.has(v)));
    totalCustomers = cohort.size;
    warnings.push("Real customer cohort size is a floor (auth user list unavailable) — only users with at least one event are counted.");
  }

  const byFeatureHits = new Map<FeatureKey, UserEventHit[]>();
  for (const f of FEATURE_KEYS) byFeatureHits.set(f, []);
  const eventToFeature = new Map<string, FeatureKey[]>();
  for (const f of FEATURE_KEYS) {
    for (const ev of FEATURE_EVENTS[f]) {
      const list = eventToFeature.get(ev) ?? [];
      list.push(f);
      eventToFeature.set(ev, list);
    }
  }

  for (const r of rows) {
    if (!r.user_id || !r.event_name || !r.created_at) continue;
    if (!includeNonCustomers && nonCustomers.ids.has(r.user_id)) continue;
    const features = eventToFeature.get(r.event_name);
    if (!features) continue;
    for (const f of features) {
      byFeatureHits.get(f)!.push({ userId: r.user_id, createdAt: r.created_at });
    }
  }

  const features: FeatureAdoptionView[] = FEATURE_KEYS.map(f => {
    const notYetDeployed = NOT_YET_DEPLOYED.has(f);
    const exposure: FunnelSegment = { state: "not_measured", usersWithSignal: null, totalCustomers };

    if (notYetDeployed) {
      const notMeasured: FunnelSegment = { state: "not_measured", usersWithSignal: null, totalCustomers };
      return {
        feature: f,
        events: FEATURE_EVENTS[f],
        notYetDeployed: true,
        exposure,
        firstUse: notMeasured,
        repeatUse: notMeasured,
        retention: notMeasured,
        zeroUsage: false,
      };
    }

    const agg = aggregateFeatureUsage(byFeatureHits.get(f) ?? [], cohort);
    return {
      feature: f,
      events: FEATURE_EVENTS[f],
      notYetDeployed: false,
      exposure,
      firstUse: { state: "measured", usersWithSignal: agg.firstUse, totalCustomers },
      repeatUse: { state: "measured", usersWithSignal: agg.repeatUse, totalCustomers },
      retention: { state: "measured", usersWithSignal: agg.retention, totalCustomers },
      zeroUsage: totalCustomers > 0 && !agg.anyUsage,
    };
  });

  return {
    available: true,
    generatedAt,
    windowDays,
    totalCustomers,
    features,
    warnings,
    excluded: nonCustomers.excluded,
  };
}

function emptyUnavailable(
  generatedAt: string,
  windowDays: number,
  warnings: string[],
  excluded: ExcludedCounts,
): FeatureAdoptionResult {
  const unavailableSegment: FunnelSegment = { state: "unavailable", usersWithSignal: null, totalCustomers: 0 };
  const features: FeatureAdoptionView[] = FEATURE_KEYS.map(f => ({
    feature: f,
    events: FEATURE_EVENTS[f],
    notYetDeployed: NOT_YET_DEPLOYED.has(f),
    exposure: unavailableSegment,
    firstUse: unavailableSegment,
    repeatUse: unavailableSegment,
    retention: unavailableSegment,
    zeroUsage: false,
  }));
  return { available: false, generatedAt, windowDays, totalCustomers: 0, features, warnings, excluded };
}

// ── /admin/today summary derivation (only surfaces when there IS an anomaly) ──

export interface FeatureAdoptionAnomaly {
  feature: FeatureKey;
  kind: "zero_usage" | "unavailable";
}

/**
 * PRD §3.4: the /admin/today card renders NOTHING when there is no anomaly.
 * This picks out exactly the rows worth surfacing: a feature that is `measured`
 * but had zero real-customer usage in the window, or the whole result being
 * `unavailable` (surfaced as one anomaly per feature so the UI can still name
 * which features it could not evaluate).
 */
export function selectFeatureAdoptionAnomalies(result: FeatureAdoptionResult): FeatureAdoptionAnomaly[] {
  if (!result.available) {
    return result.features.map(f => ({ feature: f.feature, kind: "unavailable" as const }));
  }
  const out: FeatureAdoptionAnomaly[] = [];
  for (const f of result.features) {
    if (f.zeroUsage) out.push({ feature: f.feature, kind: "zero_usage" });
  }
  return out;
}
