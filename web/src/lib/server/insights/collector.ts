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
  claimPinForConnection,
  clearReconciliation,
  createRateLimitGate,
  type ObservationDraft,
  type RateLimitGate,
} from "./collectorLogic";
import {
  callsSpentToday,
  cancelTasks,
  createPinTasks,
  finishCollectionRun,
  insertObservations,
  listPendingTasks,
  markTaskDone,
  ownerConnectionsForPins,
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

/** One 60s backoff on the run's first 429, then the run CONTINUES with its remaining
 *  claims; a second 429 stops it. The policy itself lives in `createRateLimitGate`,
 *  which explains why continuing is the right answer. */
const RATE_LIMIT_BACKOFF_MS = 60_000;

/** Serialise the backoff. Extracted so there is exactly one sleep site to audit. */
async function backOff(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
}

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
  gate: RateLimitGate,
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
        if (isRateLimited(thrown)) {
          // Not rethrown any more: a 429 on the account series used to abort the
          // whole day, registry and Pin tasks included. The account slice is lost
          // for this run either way — it is re-read whole tomorrow — but the rest
          // of the run is still worth making.
          if (gate.register429() === "stop") {
            skippedReason = "rate_limited";
          } else {
            await backOff();
            if (budget.expired) skippedReason = "deadline";
          }
        } else {
          permissionDenied = isPermissionDenied(thrown);
          if (!permissionDenied) error = errorMessage(thrown);
        }
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
      if (budget.canSpend() && !gate.stopped) {
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
          if (isRateLimited(thrown)) {
            if (gate.register429() === "stop") skippedReason = "rate_limited";
            else {
              await backOff();
              if (budget.expired) skippedReason = skippedReason ?? "deadline";
            }
          } else if (!isPermissionDenied(thrown)) {
            error = error ?? errorMessage(thrown);
          }
        }
      }

      // Always written, even after a 429: whatever the run did manage to read is
      // real data, and dropping it would make the backoff cost more than the limit.
      await insertObservations(connectionId, userId, runId, drafts);
    }
  } catch (thrown) {
    if (isRateLimited(thrown)) {
      // Only reachable if a 429 escapes a call site that does not handle it.
      if (gate.register429() === "stop") skippedReason = "rate_limited";
      else skippedReason = skippedReason ?? "rate_limited_backoff";
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
  gate: RateLimitGate,
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
    if (isRateLimited(thrown)) {
      // The refused page is abandoned, not retried: the cursor was not advanced for
      // it, so the next run asks for exactly the same page. On the run's first 429
      // this phase simply ends and the sequencer moves on to the Pin tasks.
      if (gate.register429() === "stop") {
        skippedReason = "rate_limited";
      } else {
        await backOff();
        skippedReason = "rate_limited_backoff";
      }
    }
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
  gate: RateLimitGate,
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
    //
    //    A Pin whose draft never recorded `targetConnectionId` (published before the
    //    app stored one) used to fail the `!== connectionId` test and was therefore
    //    registered and measured by NO account at all. Its owner is asked of the
    //    registry instead — one batched query, scoped to this connection so it can
    //    only ever confirm "mine", never probe another account. A Pin the registry
    //    has not listed yet is left for a later run rather than claimed on a guess:
    //    guessing would let every connection of a multi-account user register the
    //    same Pin and create a duplicate set of tasks for it.
    const provenance = await listVibePinPublishedPinterestPins(userId);
    const allPins = Array.from(provenance.pins.values());
    const unattributed = allPins.filter(pin => pin.targetConnectionId === null).map(pin => pin.pinId);
    const registryOwners = unattributed.length > 0
      ? await ownerConnectionsForPins([connectionId], unattributed).catch(() => new Map<string, string>())
      : new Map<string, string>();

    const registryEntries: RegistryUpsert[] = [];
    for (const pin of allPins) {
      const verdict = claimPinForConnection(
        pin.targetConnectionId,
        registryOwners.get(pin.pinId) ?? null,
        connectionId,
      );
      if (verdict !== "collect") continue;
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
          // One 60s backoff per RUN, then this loop keeps going with the next task.
          // The refused task stays PENDING with attempts+1 — its window is still
          // open, so a later run measures it. The second 429 of the run stops here:
          // two in a row means the limit is not clearing, and grinding through it
          // only deepens it while every task's state is already resumable.
          if (gate.register429() === "stop" || budget.expired) {
            skippedReason = "rate_limited";
            break;
          }
          await backOff();
          if (budget.expired) { skippedReason = "deadline"; break; }
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
    if (isRateLimited(thrown)) {
      if (gate.register429() === "stop") skippedReason = "rate_limited";
      else {
        await backOff();
        skippedReason = "rate_limited_backoff";
      }
    }
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

  // One 429 does not end the day. Pinterest's limit is per token and per minute, so
  // it clears while we wait: the run backs off 60s ONCE and then continues with the
  // claims it has not made yet. The phases that follow are the ones whose work cannot
  // be backfilled — the registry (an unregistered Pin is invisible to every later
  // step) and the Pin tasks (each measurement window closes on its own schedule) —
  // so abandoning them over a burst that is already over was the expensive choice.
  //
  // The second 429 of the same run is the one that stops it: two means the limit is
  // not clearing, every further call is a guaranteed failure that still costs wall
  // time, and nothing is lost by waiting because every step is resumable — the
  // account window is re-read whole, the registry keeps its cursor, and tasks stay
  // pending inside their windows.
  const gate = createRateLimitGate();

  runs.push(await runAccountDaily(client, connectionId, userId, budget, gate, now));
  if (!gate.stopped) runs.push(await runRegistry(client, connectionId, budget, userId, gate, now));
  if (!gate.stopped) runs.push(await runPinTasks(client, connectionId, userId, budget, gate, now));

  const rateLimited = gate.stopped;
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
