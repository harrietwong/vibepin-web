/**
 * v82Capability.ts — does this database actually have the v82 objects the retry
 * worker is about to depend on? (发布可靠性 P0 技术设计 v0.1 §9 task 5, PRD Risk 3)
 *
 * ── WHY THIS IS FAIL-CLOSED WHEN EVERYTHING ELSE IN v82 IS FAIL-OPEN ────────────
 * `attemptLedger.ts` degrades to "no history" on any error, deliberately: a
 * bookkeeping outage must not become a delivery outage. That is the right call for a
 * TRANSIENT error on a database that HAS the tables. It is the wrong call for a
 * database that does not have them at all, because the two failures look identical
 * from inside a single call and mean opposite things:
 *
 *   · transient read error, tables present   ⇒ this round loses one attempt counter
 *   · tables absent, flag on                 ⇒ EVERY round loses EVERY counter
 *
 * The second is the evidence-less mode PRD Risk 3 names: the route believes it is
 * retrying with a five-attempt cap, an audit trail and a reconciliation ledger, and
 * in fact has none of them. A destination would be retried without limit, the
 * terminal notice would never de-duplicate, and `delivery_unknown` rows would be
 * held open by a §3.4(b) check reading a table that is not there. Silently running
 * the retry feature against a database that cannot record it is worse than not
 * running at all — so when the objects are missing, the route refuses the whole run
 * and says so loudly.
 *
 * ── AND WHY IT ONLY EXISTS WHEN THE FLAG IS ON ─────────────────────────────────
 * Design §9 puts the warning in the risk column in as many words: a fail-closed
 * check written wrong blocks ordinary publishing. With the flag off there is nothing
 * to check — the route never names a v82 object — so the probe must not run, must
 * not cost a round trip, and must not be able to fail. `ensureV82Capability` is only
 * ever called from inside a `retryEnabled` branch, and the flag-off case is asserted
 * by a test that counts probe queries and expects zero.
 *
 * ── HOW THE FOUR RPCs ARE PROBED WITHOUT CALLING THEM FOR REAL ─────────────────
 * Not by executing them: `attempt_record_v82` writes, `confirm_prepare_v82` can
 * create an intent. Each is instead called with arguments it is guaranteed to refuse
 * at its own first validation, BEFORE any side effect:
 *
 *   attempt_record_v82        all-null identity        ⇒ v82_attempt_input_invalid
 *   reconcile_record_v82      p_outcome='__probe__'    ⇒ v82_reconcile_outcome_invalid
 *   claim_terminal_notice_v82 two random uuids         ⇒ returns false, matches no row
 *   confirm_prepare_v82       non-null check id +
 *                             malformed fingerprint    ⇒ invalid_source_identity_fingerprint
 *
 * The discriminator is therefore NOT "did it error" — three of the four are expected
 * to. It is WHICH error: PostgREST answers a missing function with PGRST202 / 42883
 * ("Could not find the function", "does not exist"), and a present function answers
 * with its own validation message. An unrecognised error is treated as NOT PROVEN,
 * which routes to fail-closed — the conservative direction for a check whose whole
 * job is to refuse to guess.
 *
 * ★ `confirm_prepare_v82` MUST be probed with a NON-NULL `p_reconcile_check_id`. With
 * null it delegates straight to `publish_intent_confirm_prepare_v78` (migrate_v82's
 * first branch), so a null probe would exercise v78 and could really run — it would
 * prove the wrong function exists and might do work.
 *
 * ── CACHING: SUCCESS ONLY ──────────────────────────────────────────────────────
 * A confirmed-present schema is cached for the life of the process, because it cannot
 * become absent (v82 is additive and nothing drops it). A FAILURE is never cached: a
 * cached failure would mean applying the migration does not unblock publishing until
 * the next deploy, which turns a five-minute incident into an hours-long one. The
 * cost of not caching failure is six cheap queries per tick while broken — and while
 * broken, nothing is publishing anyway.
 */

import type { createServerClient } from "@/lib/supabase";

type Db = ReturnType<typeof createServerClient>;

/** The v82 tables the retry + reconciliation planes read and write. */
const REQUIRED_TABLES = [
  "scheduled_publish_attempts",
  "publish_reconcile_checks",
] as const;

/** The four `_v82` RPCs. Names, not signatures — PostgREST resolves by name + args. */
export const REQUIRED_RPCS = [
  "scheduled_publish_attempt_record_v82",
  "scheduled_publish_claim_terminal_notice_v82",
  "publish_reconcile_record_v82",
  "publish_intent_confirm_prepare_v82",
] as const;

export type V82Capability =
  | { ok: true }
  | { ok: false; missing: string[] };

/** Process-lifetime memo of a CONFIRMED-PRESENT schema. Never memoises absence. */
let cached: { ok: true } | null = null;

/** Test hook: the capability memo is process-global, and a shared-process test run
 *  would otherwise have its result depend on case ORDER. Never called in production. */
export function __resetV82CapabilityCacheForTests(): void {
  cached = null;
}

/**
 * Does this error mean "that function/table is not in this database"?
 *
 * Kept separate from route.ts's `isMissingSchemaError` on purpose. That one also
 * treats a MISSING COLUMN (42703 / PGRST204) as "schema not ready", which is right
 * for its job (degrade the scan to an empty run) and wrong for this one: a missing
 * column on a present table is not evidence the object is absent, and folding the two
 * together would make the capability check answer a question it was not asked.
 */
function meansAbsent(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = err.code ?? "";
  const message = (err.message ?? "").toLowerCase();
  return (
    code === "PGRST202" || code === "42883"     // no such function
    || code === "PGRST205" || code === "42P01"  // no such table
    || message.includes("could not find the function")
    || message.includes("could not find the table")
    || (message.includes("function") && message.includes("does not exist"))
    || (message.includes("relation") && message.includes("does not exist"))
    || message.includes("schema cache")
  );
}

/** Probe arguments chosen so each RPC refuses at its FIRST validation, before any write. */
function probeArgs(rpc: string): Record<string, unknown> {
  switch (rpc) {
    case "scheduled_publish_attempt_record_v82":
      // Every identity field null ⇒ `v82_attempt_input_invalid` at the top of the body.
      return {
        p_user_id: null, p_draft_id: null, p_scheduled_at: null,
        p_provider: null, p_connection_id: null, p_attempt: null,
        p_retry_class: null, p_next_attempt_at: null,
        p_reconcile_required_at: null, p_evidence: {},
      };
    case "scheduled_publish_claim_terminal_notice_v82":
      // The only probe that legitimately SUCCEEDS: the CAS matches no row and
      // returns false. A random uuid pair cannot collide with a real attempt row.
      return {
        p_user_id: "00000000-0000-4000-8000-000000000000",
        p_attempt_row_id: "00000000-0000-4000-8000-000000000000",
      };
    case "publish_reconcile_record_v82":
      // Outcome outside the three-value domain ⇒ `v82_reconcile_outcome_invalid`,
      // raised before the INSERT.
      return {
        p_user_id: "00000000-0000-4000-8000-000000000000",
        p_draft_id: "__v82_capability_probe__",
        p_scheduled_at: "1970-01-01T00:00:00.000Z",
        p_provider: "pinterest", p_connection_id: null, p_attempt: 1,
        p_outcome: "__probe__",
      };
    case "publish_intent_confirm_prepare_v82":
    default:
      // NON-NULL check id (null would delegate to v78 and really run) plus a
      // fingerprint that fails the `^[0-9a-f]{64}$` test ⇒
      // `invalid_source_identity_fingerprint`, before any row is read or written.
      return {
        p_user_id: "00000000-0000-4000-8000-000000000000",
        p_receipt: {},
        p_source_identity_fingerprint: "__v82_capability_probe__",
        p_reconcile_check_id: "00000000-0000-4000-8000-000000000000",
      };
  }
}

/**
 * Confirm every v82 object this route depends on is installed.
 *
 * Returns `{ ok: false, missing }` listing what could not be proven present. The
 * caller refuses the run — it does NOT fall back to publishing without the evidence
 * plane, which is the whole point.
 *
 * A thrown probe (network, client) is also "not proven", for the same reason an
 * unrecognised error code is: this function's contract is that `ok:true` means
 * PROVEN, not "nothing obviously objected".
 */
export async function ensureV82Capability(db: Db): Promise<V82Capability> {
  if (cached) return cached;
  const missing: string[] = [];

  for (const table of REQUIRED_TABLES) {
    try {
      // `limit(0)` — PostgREST still resolves the relation and answers PGRST205 when
      // it does not exist, so the existence question is settled without reading a row.
      const { error } = await db.from(table).select("id").limit(0);
      if (error && meansAbsent(error)) missing.push(`table:${table}`);
      else if (error) {
        console.error(`[cron/publish-due] v82 capability: ${table} probe error:`, error.message);
        missing.push(`table:${table}`);
      }
    } catch (err) {
      console.error(`[cron/publish-due] v82 capability: ${table} probe threw:`, (err as Error).message);
      missing.push(`table:${table}`);
    }
  }

  for (const rpc of REQUIRED_RPCS) {
    try {
      const { error } = await db.rpc(rpc, probeArgs(rpc));
      // No error at all ⇒ present (the notice CAS answers false, legitimately).
      // An error that means "absent" ⇒ missing. Any OTHER error ⇒ the function ran
      // and rejected the probe arguments, which is exactly the proof wanted.
      if (error && meansAbsent(error)) missing.push(`rpc:${rpc}`);
    } catch (err) {
      console.error(`[cron/publish-due] v82 capability: ${rpc} probe threw:`, (err as Error).message);
      missing.push(`rpc:${rpc}`);
    }
  }

  if (missing.length) return { ok: false, missing };
  cached = { ok: true };
  return cached;
}
