/**
 * attemptLedger.ts — the only place the route touches `scheduled_publish_attempts`.
 *
 * The attempt ledger is the AUTHORITY for "how many times has this destination been
 * tried", and it lives in a service-role-only table for one reason worth restating:
 * `pin_drafts` is writable by its owner under RLS and merged last-write-wins from the
 * browser (persistRow.ts's file header). Putting the attempt counter in the payload
 * would let a merchant reset their own retry budget by editing a draft. So the count
 * is here, behind a SECURITY DEFINER RPC that is the table's only write path, and
 * `pin_drafts.publish_next_attempt_at` is only ever a scan-acceleration HINT whose
 * worst-case tampering outcome is "the row gets claimed a bit early" — at which point
 * the per-destination filter and this ledger still hold the line (design §4.1).
 *
 * Every function here is failure-tolerant in the same direction: a ledger problem must
 * never take down a publish. Reads degrade to "no history" and writes are logged and
 * swallowed. That is deliberately the OPPOSITE of fail-closed, and it is correct for
 * this stage: a fail-closed capability check belongs to task 5, and building it here
 * would mean a missing table stops publishing altogether — the exact outage the scan
 * gate in stage A was written to avoid.
 */

import type { createServerClient } from "@/lib/supabase";
import type { RetryClass } from "@/lib/server/publish/retryClassification";
import { latestAttemptByDestination, type AttemptRow } from "./retrySchedule";

const ATTEMPTS_TABLE = "scheduled_publish_attempts";
const RECORD_RPC = "scheduled_publish_attempt_record_v82";

type Db = ReturnType<typeof createServerClient>;

/**
 * Every attempt row for one (user, draft, schedule), keyed by destination.
 *
 * Read ONCE per row rather than once per destination: the route already holds the
 * claim, and N round-trips inside a claimed row is N chances to spend the destination
 * budget on bookkeeping instead of publishing.
 *
 * Returns an EMPTY map on any error. A row whose ledger cannot be read is treated as a
 * row with no retry history, which means it publishes exactly as it does today — the
 * safe degradation, since the alternative (refusing to publish) turns a bookkeeping
 * outage into a delivery outage.
 */
export async function loadAttemptLedger(
  db: Db,
  userId: string,
  draftId: string,
  scheduledAt: string | null,
): Promise<Map<string, AttemptRow>> {
  if (!scheduledAt) return new Map();
  try {
    const { data, error } = await db
      .from(ATTEMPTS_TABLE)
      .select(
        "provider, social_connection_id, attempt, retry_class, next_attempt_at,"
        + " reconcile_required_at, reconciled_at, final_failure_at",
      )
      .eq("owner_user_id", userId)
      .eq("draft_id", draftId)
      .eq("scheduled_at", scheduledAt);
    if (error) {
      console.error("[cron/publish-due] attempt ledger read:", error.message);
      return new Map();
    }
    // Cast through `unknown`: the generated Supabase types do not know the v82 table
    // (it is not in the checked-in schema types), so the client infers the
    // select-string error shape. The runtime answer is the row set above.
    return latestAttemptByDestination((data ?? []) as unknown as AttemptRow[]);
  } catch (err) {
    console.error("[cron/publish-due] attempt ledger read threw:", (err as Error).message);
    return new Map();
  }
}

/** The evidence the RPC stores alongside an attempt — diagnostic only, never settle evidence. */
export type AttemptEvidence = {
  stage?: string;
  providerStatus?: number;
  providerCode?: string;
  requestId?: string;
  mediaId?: string;
};

/**
 * Record one attempt (design §2.2 D). The table's ONLY write path.
 *
 * ── WHY `retryAfterSeconds` IS NOT IN `AttemptEvidence` ────────────────────────
 * It genuinely could be — this evidence goes to the v82 RPC, not to the v81 settle
 * RPC whose key whitelist would reject it. It is left out anyway so that there is
 * exactly one evidence shape in the codebase and no future reader has to work out
 * which of two near-identical objects is safe to hand to which RPC. Retry-After has a
 * home already: it feeds `next_attempt_at`, which is the only thing it can affect.
 *
 * Terminal semantics: `nextAttemptAt: null` at attempt 5 is what makes the RPC stamp
 * `final_failure_at` (§2.2 D). The caller does not set that column; it asks for the
 * fifth attempt with nowhere to go next, and the database concludes the lifecycle.
 *
 * Swallows errors after logging. The publish already happened (or already failed);
 * losing the bookkeeping must not change what the merchant is told about it. The cost
 * is bounded and known: a lost write means the next round re-uses the same attempt
 * number, and the unique index makes that an idempotent DO UPDATE rather than a
 * double count.
 */
export async function recordAttempt(
  db: Db,
  args: {
    userId: string;
    draftId: string;
    scheduledAt: string;
    provider: string;
    connectionId: string | null;
    attempt: number;
    retryClass: RetryClass;
    nextAttemptAt: string | null;
    reconcileRequiredAt: string | null;
    evidence?: AttemptEvidence;
  },
): Promise<void> {
  try {
    const { error } = await db.rpc(RECORD_RPC, {
      p_user_id: args.userId,
      p_draft_id: args.draftId,
      p_scheduled_at: args.scheduledAt,
      p_provider: args.provider,
      p_connection_id: args.connectionId,
      p_attempt: args.attempt,
      p_retry_class: args.retryClass,
      p_next_attempt_at: args.nextAttemptAt,
      p_reconcile_required_at: args.reconcileRequiredAt,
      p_evidence: args.evidence ?? {},
    });
    if (error) console.error("[cron/publish-due] attempt record:", error.message);
  } catch (err) {
    console.error("[cron/publish-due] attempt record threw:", (err as Error).message);
  }
}
