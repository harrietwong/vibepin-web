import "server-only";

/**
 * The Insights collector: one connection's daily conversation with Pinterest.
 *
 * Runs account_daily → registry → pin_task, in that order, inside one shared call
 * budget. The order is the priority order: the account series and the registry are
 * fixed costs that cannot be backfilled if skipped (Pinterest's daily analytics
 * window moves, and an unregistered Pin is invisible to every later step), while
 * point measurements degrade gracefully because each carries its own window.
 *
 * Policy lives in collectorLogic.ts and persistence in collectorStore.ts; this file
 * is the sequencing and the Pinterest I/O. It never calls `PinterestClient.forUser`
 * — a Pin is readable only with its owning account's token, and a user-scoped client
 * would silently read the wrong account for anyone holding two.
 */

import {
  PinterestApiError,
  PinterestClient,
  type PinterestOrganicAnalyticsSlice,
} from "@/lib/server/pinterest/service";
import { listVibePinPublishedPinterestPins } from "./vibepinPublishedPins";
import {
  COLLECTED_METRICS,
  computeCallsBudget,
  DAILY_BUDGET_TOTAL,
  expiredTasks,
  observationsFromSlice,
  planRegistryRun,
  selectExecutableTasks,
  tasksForPublishedPin,
  advanceRegistryCursor,
  clearReconciliation,
  type ObservationDraft,
} from "./collectorLogic";
import {
  callsSpentToday,
  cancelTasks,
  createPinTasks,
  finishCollectionRun,
  insertObservations,
  listPendingTasks,
  markTaskDone,
  readRegistryCursor,
  recordTaskAttempt,
  startCollectionRun,
  upsertContentRegistry,
  writeRegistryCursor,
  type CollectionRunSummary,
  type RegistryUpsert,
} from "./collectorStore";

/** Days of account history requested each day. Re-reading the whole window (rather
 *  than only yesterday) is what lets Pinterest's ~72h revisions land as new
 *  observations instead of being missed. */
const ACCOUNT_WINDOW_DAYS = 90;

/** Wall-clock ceiling for one invocation. Below the route's maxDuration so the run
 *  can close its ledger rows rather than being killed mid-write. */
const RUN_DEADLINE_MS = 100_000;

/** One 60s backoff on 429, then stop. See the note in `runPinTasks`. */
const RATE_LIMIT_BACKOFF_MS = 60_000;

function utcDate(daysAgo: number, now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  return d.toISOString().slice(0, 10);
}

function isRateLimited(error: unknown): boolean {
  return error instanceof PinterestApiError && error.status === 429;
}

/** 403 / missing scope: the metric is not missing, we are not allowed to read it.
 *  Recorded as `no_permission` so the UI can say so instead of showing a blank. */
function isPermissionDenied(error: unknown): boolean {
  return error instanceof PinterestApiError && (error.status === 403 || error.status === 401);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared mutable budget for one invocation: every Pinterest call decrements it. */
class CallBudget {
  private spent = 0;
  constructor(private readonly limit: number, private readonly deadline: number) {}
  get made(): number { return this.spent; }
  get remaining(): number { return Math.max(0, this.limit - this.spent); }
  get expired(): boolean { return Date.now() >= this.deadline; }
  /** True when a call may be made now. Time and budget are the same gate: a run out
   *  of either must stop cleanly and say which. */
  canSpend(): boolean { return this.remaining > 0 && !this.expired; }
  spend(n = 1): void { this.spent += n; }
}

export type CollectResult = {
  connectionId: string;
  userId: string;
  runs: CollectionRunSummary[];
  callsMade: number;
  callsBudget: number;
  stoppedEarly: boolean;
  stopReason: string | null;
};

// ── account_daily ────────────────────────────────────────────────────────────

async function runAccountDaily(
  client: PinterestClient,
  connectionId: string,
  userId: string,
  budget: CallBudget,
  now: Date,
): Promise<CollectionRunSummary> {
  const runId = await startCollectionRun(connectionId, userId, "account_daily", budget.remaining);
  const startBudget = budget.remaining;
  let made = 0;
  let skippedReason: string | null = null;
  let error: string | null = null;
  const startDate = utcDate(ACCOUNT_WINDOW_DAYS - 1, now);
  const endDate = utcDate(0, now);

  try {
    if (!budget.canSpend()) {
      skippedReason = budget.expired ? "deadline" : "budget_exhausted";
    } else {
      // 1. Account-level daily series.
      let accountSlice: PinterestOrganicAnalyticsSlice | null = null;
      let permissionDenied = false;
      try {
        budget.spend(); made += 1;
        const response = await client.getOrganicAccountAnalytics(startDate, endDate, [...COLLECTED_METRICS]);
        // The account response is keyed by split; with split_field=NO_SPLIT there is
        // one entry whose name Pinterest does not guarantee, so take the first object.
        accountSlice = response.ALL
          ?? Object.values(response).find(value => value && typeof value === "object")
          ?? null;
      } catch (thrown) {
        if (isRateLimited(thrown)) throw thrown;
        permissionDenied = isPermissionDenied(thrown);
        if (!permissionDenied) error = errorMessage(thrown);
      }

      const drafts: ObservationDraft[] = observationsFromSlice(accountSlice, {
        scope: "account",
        platformContentId: null,
        metrics: COLLECTED_METRICS,
        permissionDenied,
      });

      // 2. Top Pins → content-scope observations plus registry rows. Their period is
      //    the requested range, which Pinterest returns as a lifetime-style total,
      //    so they are recorded as 'lifetime' rather than pretending to be daily.
      if (budget.canSpend()) {
        try {
          budget.spend(); made += 1;
          const topPins = await client.getOrganicTopPins(startDate, endDate, [...COLLECTED_METRICS]);
          const registryEntries: RegistryUpsert[] = [];
          for (const pin of topPins.pins ?? []) {
            if (typeof pin.pin_id !== "string" || !pin.pin_id) continue;
            registryEntries.push({ platformContentId: pin.pin_id, sourceEndpoint: "top_pins" });
            drafts.push(...observationsFromSlice({ summary_metrics: pin.metrics ?? {} }, {
              scope: "content",
              platformContentId: pin.pin_id,
              metrics: COLLECTED_METRICS,
            }));
          }
          await upsertContentRegistry(connectionId, registryEntries);
        } catch (thrown) {
          if (isRateLimited(thrown)) throw thrown;
          if (!isPermissionDenied(thrown)) error = error ?? errorMessage(thrown);
        }
      }

      await insertObservations(connectionId, userId, runId, drafts);
    }
  } catch (thrown) {
    if (isRateLimited(thrown)) {
      skippedReason = "rate_limited";
    } else {
      error = errorMessage(thrown);
    }
  }

  await finishCollectionRun(runId, { callsMade: made, skippedReason, error });
  return { id: runId, kind: "account_daily", callsMade: made, callsBudget: startBudget, skippedReason, error };
}

// ── registry ─────────────────────────────────────────────────────────────────

async function runRegistry(
  client: PinterestClient,
  connectionId: string,
  budget: CallBudget,
  userId: string,
  now: Date,
): Promise<CollectionRunSummary> {
  const runId = await startCollectionRun(connectionId, userId, "registry", budget.remaining);
  const startBudget = budget.remaining;
  let made = 0;
  let skippedReason: string | null = null;
  let error: string | null = null;

  try {
    const cursor = await readRegistryCursor(connectionId);
    const plan = planRegistryRun(cursor, now);

    // The incremental first page runs every day in every state — the cheapest way to
    // notice new Pins, and skipping it during a long full scan would blind the
    // account to its newest content for days.
    if (plan.incremental && budget.canSpend()) {
      budget.spend(); made += 1;
      const page = await client.listPinMetadata();
      await upsertContentRegistry(connectionId, page.items.map(item => ({
        platformContentId: item.id,
        sourceEndpoint: "pins_list" as const,
        publishedAt: item.createdAt,
        format: item.mediaType,
        title: item.title,
        description: item.description,
        linkUrl: item.link,
        // Captured here so the dashboard never has to ask Pinterest for a thumbnail.
        imageUrl: item.imageUrl,
      })));
      if (plan.reconciling && cursor) {
        // This pass IS the reconciliation; the previous full scan is now complete.
        await writeRegistryCursor(connectionId, clearReconciliation(cursor));
      }
    }

    // Resumable full scan, bounded to ≤4 pages per day.
    if (plan.fullPages > 0) {
      let bookmark = plan.resumeBookmark ?? undefined;
      let pages = 0;
      let exhausted = false;
      while (pages < plan.fullPages && budget.canSpend()) {
        budget.spend(); made += 1;
        const page = await client.listPinMetadata(bookmark);
        pages += 1;
        await upsertContentRegistry(connectionId, page.items.map(item => ({
          platformContentId: item.id,
          sourceEndpoint: "pins_list" as const,
          publishedAt: item.createdAt,
          format: item.mediaType,
          title: item.title,
          description: item.description,
          linkUrl: item.link,
          imageUrl: item.imageUrl,
        })));
        if (!page.bookmark) { exhausted = true; bookmark = undefined; break; }
        bookmark = page.bookmark;
      }
      if (pages > 0) {
        await writeRegistryCursor(
          connectionId,
          advanceRegistryCursor(cursor, exhausted ? null : (bookmark ?? null), pages, now),
        );
      }
      if (!budget.canSpend() && !exhausted) {
        skippedReason = budget.expired ? "deadline" : "budget_exhausted";
      }
    }
  } catch (thrown) {
    if (isRateLimited(thrown)) skippedReason = "rate_limited";
    else if (isPermissionDenied(thrown)) skippedReason = "no_permission";
    else error = errorMessage(thrown);
  }

  await finishCollectionRun(runId, { callsMade: made, skippedReason, error });
  return { id: runId, kind: "registry", callsMade: made, callsBudget: startBudget, skippedReason, error };
}

// ── pin_task ─────────────────────────────────────────────────────────────────

async function runPinTasks(
  client: PinterestClient,
  connectionId: string,
  userId: string,
  budget: CallBudget,
  now: Date,
): Promise<CollectionRunSummary> {
  const runId = await startCollectionRun(connectionId, userId, "pin_task", budget.remaining);
  const startBudget = budget.remaining;
  let made = 0;
  let skippedReason: string | null = null;
  let error: string | null = null;

  try {
    // 1. Create tasks for VibePin-published Pins of THIS connection. Registry-only
    //    Pins get none: their publish date is historical, so every point would be
    //    born expired.
    const provenance = await listVibePinPublishedPinterestPins(userId);
    const registryEntries: RegistryUpsert[] = [];
    for (const pin of provenance.pins.values()) {
      if (pin.targetConnectionId !== connectionId) continue;
      registryEntries.push({
        platformContentId: pin.pinId,
        sourceEndpoint: "vibepin_publish",
        vibepinDraftId: pin.draftId,
        publishedAt: pin.publishedAt,
        format: pin.mediaType,
        title: pin.title,
      });
      if (pin.publishedAt) {
        await createPinTasks(tasksForPublishedPin(connectionId, pin.pinId, pin.publishedAt, now));
      }
    }
    await upsertContentRegistry(connectionId, registryEntries);

    // 2. Cancel expired pending tasks BEFORE spending anything — a closed window
    //    cannot produce a valid measurement, so paying for one is pure waste.
    const pending = await listPendingTasks(connectionId);
    const expired = expiredTasks(pending, now);
    if (expired.length > 0) await cancelTasks(expired.map(task => task.id), "window_expired");

    // 3. Execute by (priority, due_at) until budget or time runs out.
    const executable = selectExecutableTasks(pending, budget.remaining, now);
    const startDate = utcDate(ACCOUNT_WINDOW_DAYS - 1, now);
    const endDate = utcDate(0, now);
    let backedOff = false;

    for (const task of executable) {
      if (!budget.canSpend()) {
        skippedReason = skippedReason ?? (budget.expired ? "deadline" : "budget_exhausted");
        break;
      }
      try {
        budget.spend(); made += 1;
        const response = await client.getOrganicPinAnalytics(
          task.platformContentId, startDate, endDate, [...COLLECTED_METRICS],
        );
        const slice = response.ALL
          ?? Object.values(response).find(value => value && typeof value === "object")
          ?? null;
        await insertObservations(connectionId, userId, runId, observationsFromSlice(slice, {
          scope: "content",
          platformContentId: task.platformContentId,
          metrics: COLLECTED_METRICS,
        }));
        await markTaskDone(task.id, task.attempts + 1);
      } catch (thrown) {
        await recordTaskAttempt(task.id, task.attempts + 1);
        if (isRateLimited(thrown)) {
          // One 60s backoff, then stop the run. Tasks stay PENDING with attempts+1:
          // their windows are still open, so tomorrow's run (or the second run of
          // today) retries them. Grinding through a rate limit would only deepen it.
          if (backedOff || budget.expired) { skippedReason = "rate_limited"; break; }
          backedOff = true;
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
          if (budget.expired) { skippedReason = "rate_limited"; break; }
          continue;
        }
        if (isPermissionDenied(thrown)) {
          await insertObservations(connectionId, userId, runId, observationsFromSlice(null, {
            scope: "content",
            platformContentId: task.platformContentId,
            metrics: COLLECTED_METRICS,
            permissionDenied: true,
          }));
          continue;
        }
        error = error ?? errorMessage(thrown);
      }
    }
  } catch (thrown) {
    if (isRateLimited(thrown)) skippedReason = "rate_limited";
    else error = errorMessage(thrown);
  }

  await finishCollectionRun(runId, { callsMade: made, skippedReason, error });
  return { id: runId, kind: "pin_task", callsMade: made, callsBudget: startBudget, skippedReason, error };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Collect one connection's daily data.
 *
 * `userId` must come from the connection row on the server, never from the caller:
 * `forConnection` asserts the pair, so a mismatched uid is refused rather than
 * silently reading someone else's account.
 */
export async function collectForConnection(
  userId: string,
  connectionId: string,
  maxCalls: number,
  now: Date = new Date(),
): Promise<CollectResult> {
  const spentToday = await callsSpentToday(connectionId, now);
  const callsBudget = computeCallsBudget(maxCalls, spentToday, DAILY_BUDGET_TOTAL);
  const runs: CollectionRunSummary[] = [];

  if (callsBudget === 0) {
    return {
      connectionId, userId, runs, callsMade: 0, callsBudget: 0,
      stoppedEarly: true, stopReason: "daily_budget_exhausted",
    };
  }

  const budget = new CallBudget(callsBudget, Date.now() + RUN_DEADLINE_MS);
  const client = await PinterestClient.forConnection(userId, connectionId);

  // Once Pinterest has rate-limited us, the remaining steps are not "worth a try":
  // the limit is per token and per minute, so every further call is a guaranteed 429
  // that still costs wall time and would be recorded as a failed run. Stop, and let
  // the next invocation (or tomorrow's) pick the work up — every step's state is
  // resumable by design: the account window is re-read whole, the registry keeps its
  // cursor, and tasks stay pending inside their windows.
  const wasRateLimited = () => runs.some(run => run.skippedReason === "rate_limited");

  runs.push(await runAccountDaily(client, connectionId, userId, budget, now));
  if (!wasRateLimited()) runs.push(await runRegistry(client, connectionId, budget, userId, now));
  if (!wasRateLimited()) runs.push(await runPinTasks(client, connectionId, userId, budget, now));

  const rateLimited = wasRateLimited();
  const stopReason = rateLimited
    ? "rate_limited"
    : budget.expired
      ? "deadline"
      : budget.remaining === 0
        ? "budget_exhausted"
        : null;

  return {
    connectionId,
    userId,
    runs,
    callsMade: budget.made,
    callsBudget,
    stoppedEarly: stopReason !== null,
    stopReason,
  };
}
