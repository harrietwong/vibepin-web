/**
 * retrySchedule.ts — the scheduling-plane half of the v82 automatic-retry feature
 * (发布可靠性 P0 技术设计 v0.1 §4.1, §4.4, §7).
 *
 * Pure, DB-free, route-free. Everything here answers a question the route asks while
 * it holds a claimed row, and nothing here performs I/O — the same split that makes
 * `publishDueLogic.ts` testable under bare `tsx`.
 *
 * ── WHY THE FLAG IS READ PER CALL, NOT AT MODULE SCOPE ───────────────────────────
 * `DUE_LIMIT` in route.ts is frozen at import, which is correct for a value that
 * describes the deployment. This flag is not that: a rollback is "unset the env var
 * and the very next tick behaves like the baseline", and the tests flip it between
 * ticks inside ONE process (P26 is literally "what happens to an in-flight retry row
 * when the flag goes off"). A module-scope read would freeze whichever value the
 * first import happened to see and make that test assert nothing.
 *
 * ── THE ONE RULE THAT MATTERS WHEN THE FLAG IS OFF ───────────────────────────────
 * Flag off must mean the v82 column name `publish_next_attempt_at` NEVER appears in
 * any query this route builds. Not "present but vacuous", not "written as null".
 * Production has not applied v82, and a scan filter naming a column that does not
 * exist returns PostgREST 42703/PGRST204 — which route.ts:202-213 classifies as
 * `isMissingSchemaError` and degrades to an EMPTY RUN. That is not a degraded retry
 * feature, that is ALL SCHEDULED PUBLISHING SILENTLY STOPPING. Hence every helper
 * below that produces a query fragment or a write value returns `null`/`{}` when the
 * flag is off, and the route is written so the column is only ever named inside a
 * branch guarded by `publishRetryWorkerEnabled()`.
 */

import type { DestinationOutcome } from "@/lib/social/publishRules";
import type { RetryClass } from "@/lib/server/publish/retryClassification";

/** Design §2.2 C: `max_attempts = 5` is a database CHECK, mirrored here for copy. */
export const MAX_PUBLISH_ATTEMPTS = 5;

/**
 * Is the v82 retry worker enabled for THIS request?
 *
 * Strictly `=== "true"` (design §7.1). Any other value — unset, "1", "TRUE", "yes" —
 * is off. A feature that changes what a merchant is told about a failed publish does
 * not get to be enabled by a typo.
 *
 * Deliberately NOT `NEXT_PUBLIC_`: this is pure server behaviour, the client never
 * needs to know, and a `NEXT_PUBLIC_` name would be inlined at build time and could
 * not be rolled back without a redeploy.
 */
export function publishRetryWorkerEnabled(): boolean {
  return process.env.PUBLISH_RETRY_WORKER_ENABLED === "true";
}

// ── Attempt bookkeeping identity ────────────────────────────────────────────────

/**
 * The key of one retry lineage: (user, draft, schedule, provider, account).
 *
 * `scheduled_at` is IN the key on purpose, and it is the same reason the metering key
 * carries it (route.ts:477): a Content the merchant re-schedules is a NEW publish
 * lifecycle that starts over at attempt 1, not a continuation of the five attempts
 * the previous slot burned through.
 */
export function attemptKey(provider: string, socialConnectionId: string | null | undefined): string {
  const id = typeof socialConnectionId === "string" && socialConnectionId.trim()
    ? socialConnectionId.trim()
    : "";
  return `${provider}:${id}`;
}

/** One row of `scheduled_publish_attempts`, as much as the scheduler reads. */
export type AttemptRow = {
  provider: string;
  social_connection_id: string | null;
  attempt: number;
  retry_class: string | null;
  next_attempt_at: string | null;
  reconcile_required_at: string | null;
  reconciled_at: string | null;
  final_failure_at: string | null;
};

/**
 * Fold the attempt ledger into "latest attempt per destination".
 *
 * The lookup index (design §2.2 C `..._lookup_idx`, `attempt desc`) makes the read
 * cheap, but the route still has to pick the newest row per destination itself —
 * PostgREST has no DISTINCT ON. Ties cannot happen: `(…, attempt)` is unique.
 */
export function latestAttemptByDestination(rows: readonly AttemptRow[]): Map<string, AttemptRow> {
  const out = new Map<string, AttemptRow>();
  for (const row of rows) {
    const key = attemptKey(row.provider, row.social_connection_id);
    const prior = out.get(key);
    if (!prior || row.attempt > prior.attempt) out.set(key, row);
  }
  return out;
}

/**
 * The attempt number THIS round writes for a destination.
 *
 * `blocked_user` does not consume the five-attempt budget (PRD Story 5 AC-2, design
 * §4.2): the route passes the SAME number back, the RPC's unique index finds the
 * existing row and takes its `DO UPDATE` path, and the sequence does not advance. A
 * merchant whose token expired four times in a row has still spent zero of the five
 * attempts that exist to absorb Pinterest being flaky.
 *
 * Everything else advances by one; a destination with no ledger row starts at 1.
 */
export function nextAttemptNumber(prior: AttemptRow | undefined, retryClass: RetryClass): number {
  const priorAttempt = prior && Number.isInteger(prior.attempt) ? prior.attempt : 0;
  if (retryClass === "blocked_user") return Math.max(1, priorAttempt);
  return Math.min(MAX_PUBLISH_ATTEMPTS, priorAttempt + 1);
}

/**
 * Has this destination's retry backoff elapsed?
 *
 * Absent/blank/unparseable ⇒ true (publish now). Every uncertain case resolves toward
 * attempting, because the alternative — a destination pinned "not yet" forever by one
 * malformed timestamp — is a publish that silently never happens. The five-attempt
 * cap, not this function, is what bounds retries.
 */
export function backoffElapsed(nextAttemptAt: string | null | undefined, nowMs: number): boolean {
  if (typeof nextAttemptAt !== "string" || !nextAttemptAt.trim()) return true;
  const ms = Date.parse(nextAttemptAt);
  if (Number.isNaN(ms)) return true;
  return ms <= nowMs;
}

/**
 * `pin_drafts.publish_next_attempt_at` for the row: the EARLIEST next attempt among
 * the destinations still owed (design §4.1).
 *
 * MIN, emphatically not MAX. Two destinations, one backing off 60 minutes and one
 * backing off 1 minute: taking the max would hold the whole row — and therefore the
 * one-minute destination — for an hour. Taking the min re-claims the row at one
 * minute, and the per-destination filter inside the row (`backoffElapsed`) defers the
 * one that is genuinely not due yet. Claiming a row slightly early costs one cheap
 * read; publishing a destination an hour late is the failure this feature exists to
 * prevent.
 *
 * Returns null when nothing is waiting on a timer, which is exactly the gate's
 * "unconstrained, publish whenever due" value (design §2.2 B: NULL = old behaviour).
 */
export function mergeNextAttemptAt(candidates: readonly (string | null | undefined)[]): string | null {
  let bestMs = Number.POSITIVE_INFINITY;
  let best: string | null = null;
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    const ms = Date.parse(c);
    if (Number.isNaN(ms)) continue;
    if (ms < bestMs) { bestMs = ms; best = c; }
  }
  return best;
}

// ── Customer-facing copy for a retry round (design §4.4 step 2) ─────────────────

/**
 * What the merchant is told while a destination is waiting to be retried.
 *
 * NEUTRAL on purpose. The whole point of P0 is to stop telling someone their post
 * failed when the system is going to try again four more times: "Pinterest rejected
 * this" after one 503 is a lie that costs the merchant an afternoon of debugging a
 * problem that fixed itself. The copy names the attempt and the next time so the
 * state is legible rather than merely reassuring.
 *
 * Carried on a `pending` outcome, which is a status that already means "not attempted
 * yet, still owed" everywhere in the pipeline (`pendingDestinations` leaves a pending
 * destination owed; `outcomeRows` refuses to persist it as a failure). No new status
 * enum is introduced — design §4.4 step 2 is explicit that this reuses the existing
 * shape.
 */
export function retryWaitMessage(attempt: number, nextAttemptAt: string | null): string {
  const base = `Publishing did not go through. Retrying automatically (attempt ${attempt} of ${MAX_PUBLISH_ATTEMPTS})`;
  if (!nextAttemptAt) return `${base}.`;
  const ms = Date.parse(nextAttemptAt);
  if (Number.isNaN(ms)) return `${base}.`;
  return `${base} — next attempt around ${new Date(ms).toISOString()}.`;
}

/** What the merchant is told while a delivery is being reconciled (design §3.2). */
export const RECONCILING_MESSAGE =
  "Checking with Pinterest whether this went out. Nothing will be re-sent until that is confirmed.";

/**
 * A destination's outcome for a round that ended in `retry_wait` or `reconciling`.
 *
 * ── WHY THE MARKER FIELD EXISTS (this is load-bearing, do not remove it) ────────
 * `status: "pending"` already means two different things in this route, and the two
 * must not be confused:
 *
 *   A. "the run ran out of time before starting this destination" (`deferredOutcome`)
 *   B. "this destination was attempted, it failed, and we are backing off"  ← new
 *
 * The difference matters at route.ts:812-821, whose early-exit fires when a round
 * produced ONLY pending outcomes: it releases the claim and writes NOTHING. For (A)
 * that is exactly right — nothing happened, so recording anything would only bump
 * `updatedAt` and push a pointless LWW re-sync to every client. For (B) it would be a
 * silent hole: the backoff gate would never be written to the row, the merchant would
 * never see the retry copy, and on a single-destination Content — the COMMON case —
 * the whole feature would do nothing observable while still looking like it worked.
 *
 * So a retry round is marked, and the route routes it past that branch into the
 * ordinary deferred persist. The field is stripped before the outcome reaches any
 * storage layer (see `stripRetryMarkers`), so nothing downstream can start depending
 * on a shape that only exists between two lines of the route.
 */
export type RetryPendingOutcome = DestinationOutcome & {
  /** Present only on (B) above. Never persisted; never leaves the route. */
  vibepinRetryRound?: { retryClass: RetryClass; attempt: number; nextAttemptAt: string | null };
};

export function retryPendingOutcome(
  destination: { provider: string; socialConnectionId?: string | null },
  round: { retryClass: RetryClass; attempt: number; nextAttemptAt: string | null },
): RetryPendingOutcome {
  const id = typeof destination.socialConnectionId === "string" && destination.socialConnectionId.trim()
    ? destination.socialConnectionId.trim()
    : null;
  return {
    provider: "pinterest",
    status: "pending",
    socialConnectionId: id,
    error: round.retryClass === "reconciliation_required"
      ? RECONCILING_MESSAGE
      : retryWaitMessage(round.attempt, round.nextAttemptAt),
    vibepinRetryRound: round,
  };
}

/** Does this outcome describe a round that was attempted and is now backing off? */
export function isRetryRound(outcome: DestinationOutcome): boolean {
  return !!(outcome as RetryPendingOutcome).vibepinRetryRound;
}

/**
 * Drop the in-route marker before anything persists or classifies the outcome.
 *
 * Belt and braces: `outcomeRows` filters `pending` out of the payload anyway, so the
 * marker could not reach the database through that path today. It is stripped anyway
 * because "today's filter happens to save us" is not a property worth depending on,
 * and because the fan-out's `recordOutcomes` writes a different table with different
 * rules.
 */
export function stripRetryMarkers(outcomes: readonly DestinationOutcome[]): DestinationOutcome[] {
  return outcomes.map(o => {
    if (!isRetryRound(o)) return o;
    const { vibepinRetryRound: _drop, ...rest } = o as RetryPendingOutcome;
    void _drop;
    return rest as DestinationOutcome;
  });
}

// ── The two settlement questions the route asks once per row ───────────────────

/**
 * Must `settleMetering()` be SKIPPED for this round? (design §4.4, the exemption table)
 *
 * The defect being fixed: round 1 fails with a 503, `settleMetering` sees a fresh
 * consume and a refundable outcome, and RELEASES the unit. Round 2 therefore consumes
 * fresh again, fails again, releases again — the exact "churn release/re-consume pairs
 * every five minutes" that route.ts:530-535 already calls out and that the
 * trial-access branch already has a bespoke exemption for (route.ts:715-724). A retry
 * round is the same situation with a different cause: the schedule has not ended, the
 * same key will be charged again, and the refund question simply is not answerable yet.
 *
 * So: any round that leaves a destination waiting (retry_wait or reconciling) settles
 * NOTHING. The refund decision is made once, at the terminal round, by the unchanged
 * three-state rules. Net effect across a five-round lifecycle: exactly one charge,
 * zero releases in rounds 1-4.
 *
 * P24 asserts the release COUNT is zero rather than only checking the final balance —
 * a net-zero balance is also what a release/re-consume churn produces, so counting is
 * the only assertion that can tell the fix from the defect.
 */
export function shouldSkipSettlement(outcomes: readonly DestinationOutcome[]): boolean {
  return outcomes.some(isRetryRound);
}

/**
 * Is there an unsettled reconciliation on this row? (design §3.4(b))
 *
 * The bug this answers: a `delivery_unknown` round leaves no `pending` outcome, so the
 * final persist gets `deferred:false`, `clearSchedule` becomes true, and `scheduled_at`
 * is written to NULL. The next tick then cannot even see the row (the due scan filters
 * `scheduled_at is not null`), so when reconciliation later concludes "no, that Pin was
 * never created" there is no row left to re-publish. The entire reconciliation chain is
 * dead on arrival without this.
 *
 * Two places need the answer and they are different shapes, which is why this takes
 * the payload rows rather than this round's outcomes: §3.4(a) is about the round that
 * JUST produced `delivery_unknown`, while §3.4(b) is about a LATER tick where the round
 * produced nothing at all and the only evidence is the stored result row plus a still-
 * open ledger entry. Both require BOTH halves — a stored `delivery_unknown` row AND an
 * attempt row with `reconcile_required_at` set and `reconciled_at` null. A stored row
 * alone is not enough: once reconciliation concludes, the ledger entry closes and the
 * row must be allowed to finish normally rather than keeping its slot forever.
 */
export function hasOpenReconciliation(
  priorResults: readonly unknown[],
  attempts: ReadonlyMap<string, AttemptRow>,
): boolean {
  const unknownKeys = new Set<string>();
  for (const raw of priorResults) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { provider?: unknown; status?: unknown; socialConnectionId?: unknown };
    if (r.status !== "delivery_unknown") continue;
    if (typeof r.provider !== "string") continue;
    unknownKeys.add(attemptKey(r.provider, typeof r.socialConnectionId === "string" ? r.socialConnectionId : null));
  }
  if (!unknownKeys.size) return false;
  for (const key of unknownKeys) {
    const row = attempts.get(key);
    if (row && row.reconcile_required_at && !row.reconciled_at) return true;
  }
  return false;
}
