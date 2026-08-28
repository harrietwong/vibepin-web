/**
 * Pure decision logic for the Insights collector (v64 collection layer).
 *
 * Everything here is a function of its arguments: no Supabase client, no Pinterest
 * client, no `server-only` import. That split is deliberate and load-bearing.
 * `collector.ts` owns the I/O and is unimportable outside a Next server runtime;
 * this module holds the parts that actually encode policy — how many calls a run may
 * spend, which measurement points exist and when they expire, what a missing metric
 * means — so they can be tested directly under tsx without a database or a network.
 *
 * If you are about to add an `await` to this file, it belongs in collector.ts instead.
 */

import type {
  PinterestOrganicAnalyticsSlice,
  PinterestOrganicMetricMap,
  PinterestOrganicMetricName,
} from "@/lib/server/pinterest/service";

// ── Budget ───────────────────────────────────────────────────────────────────

/**
 * Calls one connection may spend on Pinterest per day, split by purpose.
 *
 * Pinterest allows 60 organic-analytics calls per minute; the daily figure here is
 * a self-imposed ceiling per CONNECTION, not a platform limit. Two accounts of the
 * same user each get their own 60 — the platform meters by token, so sharing one
 * pool between them would throttle a second account for the first one's traffic.
 *
 * The three-way split is what keeps a busy day from starving the fixed work:
 *   FIXED   the daily account snapshot (2) plus the registry passes (≤5). These run
 *           first and always; without them the account-level series has a hole that
 *           can never be backfilled.
 *   RESERVE headroom for 429 backoff and retries. Not a spending allowance — it
 *           exists so a rate-limited run has somewhere to go other than "over budget".
 *   TASKS   whatever is left, for t1/t7/t30 point measurements.
 */
export const DAILY_BUDGET_FIXED = 7;
export const DAILY_BUDGET_RESERVE = 12;
export const DAILY_BUDGET_TASKS = 41;
export const DAILY_BUDGET_TOTAL = DAILY_BUDGET_FIXED + DAILY_BUDGET_RESERVE + DAILY_BUDGET_TASKS; // 60

/** Hard cap on `maxCalls` accepted from the cron caller (v5 §2.4). */
export const MAX_CALLS_PER_RUN = 30;

/** Pages of `GET /pins` a single day's full scan may consume. */
export const REGISTRY_FULL_PAGES_PER_DAY = 4;

/** Days between full registry scans. */
export const REGISTRY_FULL_INTERVAL_DAYS = 30;

/** Pinterest API version recorded on every observation, so a response-shape change
 *  is visible in the data rather than silently reinterpreted. */
export const OBSERVATION_API_VERSION = "v5";

/**
 * How many calls this run may make.
 *
 * The per-run cap and the per-day budget are different guarantees: the cap bounds
 * one invocation's wall time (it must finish inside the serverless limit), the daily
 * budget bounds what the connection spends across every invocation of the day. A run
 * gets the smaller of the two, and never a negative number — a day already over
 * budget yields 0, which the caller records as a skipped run rather than treating as
 * "unlimited".
 */
export function computeCallsBudget(
  maxCalls: number,
  callsSpentToday: number,
  dailyBudget: number = DAILY_BUDGET_TOTAL,
): number {
  const requested = Math.min(Math.floor(maxCalls), MAX_CALLS_PER_RUN);
  const remainingToday = dailyBudget - callsSpentToday;
  return Math.max(0, Math.min(requested, remainingToday));
}

// ── Measurement points (pin_task) ────────────────────────────────────────────

export type PinTaskKind = "t1" | "t7" | "t30";

/**
 * Age windows, in days from publication: [due, expiry).
 *
 * A window rather than a deadline because collection is best-effort — a run that
 * ran out of budget yesterday can still measure today. The window closes because a
 * "day 7" number taken on day 20 is not a day-7 number; recording it would corrupt
 * the very comparison the task exists to make. Expired tasks are cancelled with a
 * reason, which is also what bounds the pending backlog.
 */
export const TASK_WINDOWS: Record<PinTaskKind, { dueDays: number; untilDays: number; priority: number }> = {
  // t7 first: mid-life is the point the diagnosis compares against, so under budget
  // pressure it is the one worth keeping.
  t7: { dueDays: 7, untilDays: 10, priority: 1 },
  t30: { dueDays: 30, untilDays: 37, priority: 2 },
  t1: { dueDays: 1, untilDays: 3, priority: 3 },
};

/** Only Pins published within this many days get tasks created at all. */
export const TASK_ELIGIBILITY_DAYS = 37;

export type PinTaskDraft = {
  connectionId: string;
  platformContentId: string;
  kind: PinTaskKind;
  dueAt: string;
  windowUntil: string;
  priority: number;
};

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

/**
 * The tasks a freshly-seen VibePin Pin should have.
 *
 * Only VibePin-published Pins get tasks: a Pin discovered by the registry scan was
 * published who-knows-when, and back-dating measurement points for it would create
 * tasks that are already expired — noise in the ledger with no data behind them.
 * A window that has ALREADY closed at creation time is skipped for the same reason:
 * creating a task only to cancel it on the next daily pass records a failure that
 * never had a chance of succeeding.
 */
export function tasksForPublishedPin(
  connectionId: string,
  platformContentId: string,
  publishedAt: string,
  now: Date = new Date(),
): PinTaskDraft[] {
  const publishedMs = new Date(publishedAt).getTime();
  if (!Number.isFinite(publishedMs)) return [];
  const ageDays = (now.getTime() - publishedMs) / 86_400_000;
  if (ageDays > TASK_ELIGIBILITY_DAYS) return [];

  const drafts: PinTaskDraft[] = [];
  for (const kind of ["t1", "t7", "t30"] as PinTaskKind[]) {
    const window = TASK_WINDOWS[kind];
    const windowUntil = addDays(publishedAt, window.untilDays);
    if (new Date(windowUntil).getTime() <= now.getTime()) continue; // already closed
    drafts.push({
      connectionId,
      platformContentId,
      kind,
      dueAt: addDays(publishedAt, window.dueDays),
      windowUntil,
      priority: window.priority,
    });
  }
  return drafts;
}

export type PendingTask = {
  id: number;
  connectionId: string;
  platformContentId: string;
  kind: PinTaskKind;
  dueAt: string;
  windowUntil: string;
  priority: number;
  attempts: number;
};

/** Tasks whose window has closed. The daily run cancels these BEFORE spending any
 *  call, so budget is never burnt on a measurement that can no longer be valid. */
export function expiredTasks(tasks: PendingTask[], now: Date = new Date()): PendingTask[] {
  return tasks.filter(task => new Date(task.windowUntil).getTime() < now.getTime());
}

/**
 * Execution order: priority ascending (t7 → t30 → t1), then oldest due first.
 * Only tasks that are actually due and still inside their window are returned, so
 * the caller can execute the list top-down until the budget runs out.
 */
export function selectExecutableTasks(
  tasks: PendingTask[],
  limit: number,
  now: Date = new Date(),
): PendingTask[] {
  const nowMs = now.getTime();
  return tasks
    .filter(task => new Date(task.dueAt).getTime() <= nowMs)
    .filter(task => new Date(task.windowUntil).getTime() > nowMs)
    .sort((a, b) => (a.priority - b.priority)
      || a.dueAt.localeCompare(b.dueAt)
      || a.id - b.id)
    .slice(0, Math.max(0, limit));
}

// ── Observation status mapping ───────────────────────────────────────────────

export type ObservationStatus = "ok" | "not_returned" | "no_permission" | "not_collected";

export type ObservationDraft = {
  scope: "account" | "content";
  platformContentId: string | null;
  metricName: string;
  period: "day" | "lifetime";
  periodDate: string | null;
  metricValue: number | null;
  status: ObservationStatus;
};

/**
 * One metric's status.
 *
 * The whole point of the v64 schema is that "0", "Pinterest returned nothing",
 * "our token may not read this" and "we never asked" are four different facts. This
 * function is where they are told apart, so the invariant `status='ok' ⇔ value is
 * not null` (enforced by a CHECK constraint) holds by construction:
 *   - a permission failure never carries a value, even a zero;
 *   - an absent key is `not_returned` — Pinterest omits metrics it has no data for,
 *     and writing 0 there would invent a measurement;
 *   - a present, finite number is `ok`, including a genuine 0.
 */
export function mapMetricStatus(
  metrics: PinterestOrganicMetricMap | undefined,
  metricName: string,
  options: { permissionDenied?: boolean; collected?: boolean } = {},
): { status: ObservationStatus; value: number | null } {
  if (options.collected === false) return { status: "not_collected", value: null };
  if (options.permissionDenied) return { status: "no_permission", value: null };
  const raw = metrics?.[metricName];
  if (raw === undefined || raw === null) return { status: "not_returned", value: null };
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return { status: "not_returned", value: null };
  return { status: "ok", value };
}

/** Metrics collected for both account and content scope. OUTBOUND_CLICK_RATE is
 *  omitted on purpose: it is derivable from the two counts, and storing a platform
 *  ratio alongside our own would create two answers to one question. */
export const COLLECTED_METRICS: PinterestOrganicMetricName[] = [
  "IMPRESSION",
  "SAVE",
  "PIN_CLICK",
  "OUTBOUND_CLICK",
  "TOTAL_COMMENTS",
  "TOTAL_REACTIONS",
  "ENGAGEMENT",
];

/**
 * Flatten one analytics slice into observation drafts.
 *
 * Daily rows and the lifetime/summary total are both emitted because they answer
 * different questions and Pinterest does not let us reconstruct one from the other:
 * the daily series is windowed (older days fall out of reach), while summary_metrics
 * is the running total. Every requested metric produces a row even when absent —
 * that absence is the observation.
 */
export function observationsFromSlice(
  slice: PinterestOrganicAnalyticsSlice | null,
  options: {
    scope: "account" | "content";
    platformContentId: string | null;
    metrics: readonly string[];
    permissionDenied?: boolean;
    collected?: boolean;
  },
): ObservationDraft[] {
  const { scope, platformContentId, metrics } = options;
  const out: ObservationDraft[] = [];
  const base = { scope, platformContentId } as const;

  if (options.collected === false || options.permissionDenied || slice === null) {
    for (const metricName of metrics) {
      const { status, value } = mapMetricStatus(undefined, metricName, {
        permissionDenied: options.permissionDenied,
        collected: options.collected,
      });
      out.push({
        ...base,
        metricName,
        period: "lifetime",
        periodDate: null,
        metricValue: value,
        // A null slice with no explicit reason means Pinterest answered without data.
        status: options.collected === false || options.permissionDenied ? status : "not_returned",
      });
    }
    return out;
  }

  for (const row of slice.daily_metrics ?? []) {
    if (typeof row.date !== "string" || !row.date) continue;
    for (const metricName of metrics) {
      const { status, value } = mapMetricStatus(row.metrics, metricName);
      out.push({ ...base, metricName, period: "day", periodDate: row.date, metricValue: value, status });
    }
  }

  for (const metricName of metrics) {
    const { status, value } = mapMetricStatus(slice.summary_metrics, metricName);
    out.push({ ...base, metricName, period: "lifetime", periodDate: null, metricValue: value, status });
  }

  return out;
}

/**
 * Collapse drafts that would collide on the run-scoped unique key.
 *
 * The key is (collection_run_id, scope, platform_content_id, metric_name, period,
 * period_date). Two drafts sharing it are the same measurement written twice — a
 * repeated pin in one top_pins response is the realistic case — and the database
 * would reject the second with a unique violation, taking the whole batch with it.
 * First occurrence wins: within a single run the duplicates are identical, so there
 * is nothing to choose between them.
 */
export function dedupeObservationDrafts(drafts: ObservationDraft[]): ObservationDraft[] {
  const seen = new Set<string>();
  const out: ObservationDraft[] = [];
  for (const draft of drafts) {
    const key = [
      draft.scope,
      draft.platformContentId ?? "",
      draft.metricName,
      draft.period,
      draft.periodDate ?? "",
    ].join("\u001f");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(draft);
  }
  return out;
}

// ── Registry cursor state machine ────────────────────────────────────────────

export type RegistryCursorState = {
  bookmark: string | null;
  fullStartedAt: string | null;
  fullCompletedAt: string | null;
  pagesFetched: number;
  reconciliationPending: boolean;
};

export type RegistryPlan = {
  /** Always true: the first page is fetched every day, even mid-full-scan. */
  incremental: boolean;
  /** Pages of the resumable full scan to fetch this run (0 when none is due). */
  fullPages: number;
  /** Where the full scan resumes; null starts a new one. */
  resumeBookmark: string | null;
  /** True when this run should start a brand-new full scan. */
  startFull: boolean;
  /** True when this run only has to clear a pending reconciliation. */
  reconciling: boolean;
};

/**
 * What the registry step should do today.
 *
 * Three states, in priority order:
 *   1. a full scan is in progress (bookmark set) → resume it, ≤4 pages;
 *   2. a scan just finished and left `reconciliation_pending` → today's first-page
 *      pass is the reconciliation, and no full pages are spent. Pins created DURING
 *      a multi-day scan can be missed by the scan itself (they land on page 1 while
 *      the cursor is deep in the list), so the pass after it is what closes the gap;
 *   3. otherwise → incremental only, unless the last full scan is 30+ days old or
 *      there has never been one (first connect), in which case start a new full scan.
 *
 * The incremental first page is unconditional in every state: it is the cheapest
 * possible way to notice new Pins, and skipping it during a long scan would blind
 * the account to its newest content for days.
 */
export function planRegistryRun(
  cursor: RegistryCursorState | null,
  now: Date = new Date(),
  pagesPerDay: number = REGISTRY_FULL_PAGES_PER_DAY,
): RegistryPlan {
  const base = { incremental: true, fullPages: 0, resumeBookmark: null, startFull: false, reconciling: false };

  if (!cursor) return { ...base, fullPages: pagesPerDay, startFull: true };

  if (cursor.bookmark) {
    return { ...base, fullPages: pagesPerDay, resumeBookmark: cursor.bookmark };
  }

  if (cursor.reconciliationPending) {
    return { ...base, reconciling: true };
  }

  const lastFull = cursor.fullCompletedAt ? new Date(cursor.fullCompletedAt).getTime() : null;
  const dueForFull = lastFull === null
    || (now.getTime() - lastFull) / 86_400_000 >= REGISTRY_FULL_INTERVAL_DAYS;
  if (dueForFull) return { ...base, fullPages: pagesPerDay, startFull: true };

  return base;
}

/**
 * The cursor after a full-scan page batch.
 *
 * `bookmark === null` from Pinterest means the list is exhausted: the scan is
 * complete, but `reconciliation_pending` is raised rather than declaring victory,
 * because a scan that spanned days cannot have seen Pins created after it passed
 * page 1. The next day's first-page pass clears the flag.
 */
export function advanceRegistryCursor(
  cursor: RegistryCursorState | null,
  nextBookmark: string | null,
  pagesFetchedThisRun: number,
  now: Date = new Date(),
): RegistryCursorState {
  const nowIso = now.toISOString();
  const previous: RegistryCursorState = cursor ?? {
    bookmark: null,
    fullStartedAt: null,
    fullCompletedAt: null,
    pagesFetched: 0,
    reconciliationPending: false,
  };
  const resuming = Boolean(previous.bookmark);
  return {
    bookmark: nextBookmark,
    fullStartedAt: resuming ? previous.fullStartedAt : nowIso,
    fullCompletedAt: nextBookmark === null ? nowIso : previous.fullCompletedAt,
    // pages_fetched is monotonic within one scan and restarts with a new one, so a
    // stalled scan is visible as a count that stops moving.
    pagesFetched: (resuming ? previous.pagesFetched : 0) + pagesFetchedThisRun,
    reconciliationPending: nextBookmark === null ? true : previous.reconciliationPending,
  };
}

/** The reconciliation pass ran; the scan is now genuinely complete. */
export function clearReconciliation(cursor: RegistryCursorState): RegistryCursorState {
  return { ...cursor, reconciliationPending: false };
}

// ── Registry upsert precedence ───────────────────────────────────────────────

export type RegistrySource = "pins_list" | "top_pins" | "vibepin_publish";

/**
 * `vibepin_publish` is the only source that carries a draft id, and it is the
 * evidence that THIS connection published the Pin. A later list/top-pins pass sees
 * the same Pin from a discovery endpoint and must not overwrite that provenance
 * with the weaker label — doing so would erase the attribution the dashboard relies
 * on. Between the two discovery endpoints the source is simply the most recent.
 */
export function resolveRegistrySource(
  existing: RegistrySource | null,
  incoming: RegistrySource,
): RegistrySource {
  if (existing === "vibepin_publish") return "vibepin_publish";
  return incoming;
}

// ── Rate limiting ────────────────────────────────────────────────────────────

export type RateLimitVerdict = "backoff_and_continue" | "stop";

export type RateLimitGate = {
  /** Record a 429 and get the run's answer. First hit: back off, keep working.
   *  Second hit anywhere in the same run: stop. */
  register429(): RateLimitVerdict;
  /** True once the run has decided to stop — read by the phase sequencer. */
  readonly stopped: boolean;
  readonly hits: number;
};

/**
 * One run's 429 policy, shared by all three phases.
 *
 * The rule it encodes is "back off once, then continue", and the reason it is a
 * RUN-level object rather than a per-phase flag is the reason F5 exists at all. A
 * per-phase flag made the first 429 — wherever it landed — abort every later phase,
 * so a rate limit while reading the account series meant the registry never ran and
 * no Pin task was measured that day. Pinterest's limit is per token per minute: it
 * clears while we wait. Abandoning a whole day's remaining work over one 429 throws
 * away collection windows that cannot be backfilled (the daily analytics window
 * moves on, and an unregistered Pin is invisible to every later step), while the
 * only thing continuing costs is the 60 seconds we already agreed to spend.
 *
 * The second 429 is treated differently on purpose: one is a burst we rode out, two
 * in the same run means the limit is not clearing and further calls are guaranteed
 * failures that still burn wall time and get written down as failed runs. Every
 * phase is resumable by design — the account window is re-read whole, the registry
 * keeps its cursor, tasks stay pending inside their windows — so stopping loses
 * nothing that the next invocation cannot pick up.
 *
 * Note what a verdict does NOT say: retry the claim that was refused. The refused
 * call is abandoned (a task keeps its pending state and an incremented attempt
 * count) and the run moves to the next claim. Retrying the same call immediately
 * after the backoff would spend the recovered budget on the one request we already
 * know Pinterest is unhappy about.
 */
export function createRateLimitGate(): RateLimitGate {
  let hits = 0;
  return {
    register429() {
      hits += 1;
      return hits >= 2 ? "stop" : "backoff_and_continue";
    },
    get stopped() { return hits >= 2; },
    get hits() { return hits; },
  };
}

// ── Ownership attribution ────────────────────────────────────────────────────

export type RegistryOwnerRow = {
  connectionId: string;
  platformContentId: string;
  sourceEndpoint: RegistrySource;
};

/** What the collector should do with one VibePin-published Pin this run. */
export type PinClaimVerdict = "collect" | "not_mine" | "unknown_owner";

/**
 * Should THIS connection register and measure this Pin?
 *
 * The draft's own recorded target wins whenever it exists: it is what the publish
 * path actually did, and no later observation can be better evidence than the act
 * itself. Drafts published before the app recorded `targetConnectionId` have no such
 * evidence, and the old code simply skipped them (`targetConnectionId !== id` is true
 * for `null`), so a legacy Pin was never registered and never measured by ANY
 * account — invisible to the whole feature rather than merely mis-attributed.
 *
 * The registry supplies the missing answer: the account whose own token listed the
 * Pin is the account that owns it. When it has not listed the Pin yet the verdict is
 * `unknown_owner`, and the honest action is to do nothing THIS run. Guessing "mine"
 * would let two connections both register the same Pin and both create tasks for it,
 * which is the multi-account duplication this whole path exists to remove; the
 * registry's incremental pass runs every day, so the Pin is claimed within a day of
 * becoming knowable.
 */
export function claimPinForConnection(
  targetConnectionId: string | null,
  registryOwnerConnectionId: string | null,
  collectingConnectionId: string,
): PinClaimVerdict {
  if (targetConnectionId) {
    return targetConnectionId === collectingConnectionId ? "collect" : "not_mine";
  }
  if (registryOwnerConnectionId) {
    return registryOwnerConnectionId === collectingConnectionId ? "collect" : "not_mine";
  }
  return "unknown_owner";
}

