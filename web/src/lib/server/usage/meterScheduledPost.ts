/**
 * Scheduled-post metering — Phase 5B, the third and last usage type.
 *
 * The FIRST single-call CONSUME sibling: unlike images (meterGeneration) and text
 * (meterTextGeneration), which reserve-then-settle, a publish either happened or
 * it did not — there is no async settlement window. So this module wraps v55's
 * `usage_consume_scheduled_post`, a direct idempotent check-and-consume:
 * no reservation row, no release path, no expiry-sweeper interaction.
 *
 * ── THE FROZEN COUNTING CONTRACT (PRD v3.1 decisions 3 & 4) ─────────────────────
 *   One piece of content published        = 1, no matter how many platforms the
 *                                           client fans out to afterwards.
 *   Immediate ("publish now")             = 1 — otherwise it bypasses the quota.
 *   Drafts / previews                     = 0.
 *   Cron re-claims and client retries     = 0 extra (idempotency key, below).
 *   Business (null limit)                 = never rejected, still writes 1 event.
 *
 * Multi-platform costs 1 BY CONSTRUCTION, not by code here: the meter is wired
 * only at the Pinterest/primary action (/api/pinterest/pins and the cron claim).
 * The social fan-out shares the same draft and simply never calls this module.
 *
 * ── IDEMPOTENCY KEY (why scheduled_at, not claim time) ─────────────────────────
 * The cron path is at-least-once: if the process dies after Pinterest creates the
 * pin but before the success persist, the 10-minute stale window re-claims and
 * re-publishes the SAME draft. Claim timestamps are minted fresh per run, so a
 * key containing one would double-count exactly there. `scheduled_at` is written
 * once when the user schedules and only cleared by the success persist — so every
 * re-claim of an unfinished publish sees the SAME value and collapses onto the
 * SAME ledger row (v55's unique (user_id, idempotency_key)).
 *
 * For immediate publishes there is no scheduled_at; a UTC date bucket stands in.
 * An accidental double-click or client retry is free; a deliberate republish of
 * the same draft on a later day correctly counts again. The rare same-day
 * intentional republish under-counts — accepted, it errs toward the customer.
 *
 * ── FAIL-OPEN, LIKE THE OTHER METERS (shadow) ──────────────────────────────────
 * Metering is an accounting overlay. In `shadow`, ANY ledger failure (missing
 * account, RPC error, unreachable Supabase) is logged and the publish PROCEEDS.
 * This is the deliberate inverse of the fail-closed moderation gate: an
 * accounting outage must never cost a user a publish they were entitled to.
 * `enforce` (quota refusal) is reserved for Phase 6C and is NOT enabled anywhere.
 */

import crypto from "node:crypto";
import { ensureUsageAccount } from "./ensureAccount";
import {
  usageMeteringMode,
  logEvent,
  defaultRpc,
  type RpcRunner,
} from "./meterGeneration";

export { usageMeteringMode, type UsageMeteringMode } from "./meterGeneration";

/**
 * Stable identity for one publish action, salted like deriveRequestKey so a
 * tampered draft id cannot collide across users.
 *
 *   scheduled: deriveScheduledPostKey(userId, draftId, scheduledAtIso)
 *   immediate: deriveScheduledPostKey(userId, draftId)  → UTC date bucket
 */
export function deriveScheduledPostKey(
  userId: string,
  draftId: string,
  scheduledAtIso?: string | null,
): string {
  const bucket = scheduledAtIso && scheduledAtIso.trim()
    ? scheduledAtIso.trim()
    : new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const salt = process.env.USAGE_REQUEST_KEY_SALT ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "vibepin-usage";
  return crypto
    .createHash("sha256")
    .update(`${salt}|${userId}|post:${draftId}:${bucket}`)
    .digest("hex")
    .slice(0, 48);
}

export type ScheduledPostConsume =
  | { kind: "off" }
  | { kind: "consumed"; replayed: boolean }
  | { kind: "insufficient" }
  | { kind: "error"; message: string };

export type ConsumeScheduledPostArgs = {
  userId: string;
  /** From deriveScheduledPostKey — NEVER a raw client value. */
  key: string;
  /** e.g. the draft id; lands in usage_events.reference_id for audit. */
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
  deps?: { rpc?: RpcRunner; ensure?: (userId: string) => Promise<unknown> };
};

/**
 * Consume exactly ONE scheduled-post unit, idempotently.
 *
 * Quantity is hardwired to 1: v55 RAISES when the same key is replayed with a
 * different quantity, and the contract is one-content-one-unit anyway.
 */
export async function consumeScheduledPost(args: ConsumeScheduledPostArgs): Promise<ScheduledPostConsume> {
  const mode = usageMeteringMode();
  if (mode === "off") return { kind: "off" };

  const rpc = args.deps?.rpc ?? defaultRpc();
  const ensure = args.deps?.ensure ?? ensureUsageAccount;

  try {
    // The consume RPC raises when no usage_accounts row exists; ensure is
    // idempotent and lazily creates/rolls the account (Phase 3).
    await ensure(args.userId);

    // RpcRunner resolves to supabase-js's {data, error} envelope — the RPC's own
    // jsonb return lives in `data`. Unwrapping both layers is what the reserve/settle
    // siblings do (meterTextGeneration.ts:122); reading the envelope as the payload
    // would make every successful consume look like an unexpected result.
    const { data, error } = await rpc("usage_consume_scheduled_post", {
      p_user_id: args.userId,
      p_idempotency_key: args.key,
      p_quantity: 1,
      p_reference_id: args.referenceId ?? null,
      p_metadata: args.metadata ?? {},
    });

    if (error) {
      logEvent("scheduled_post_consume_failed", {
        userId: args.userId,
        mode,
        error: error.message.slice(0, 200),
      });
      return { kind: "error", message: error.message };
    }

    const result = data as { ok?: boolean; replayed?: boolean; reason?: string } | null;

    if (result?.ok) {
      logEvent("scheduled_post_consumed", {
        userId: args.userId,
        replayed: Boolean(result.replayed),
        mode,
      });
      return { kind: "consumed", replayed: Boolean(result.replayed) };
    }

    if (result?.reason === "insufficient") {
      logEvent("scheduled_post_insufficient", { userId: args.userId, mode });
      // In shadow this is observational only; the caller must not block.
      return { kind: "insufficient" };
    }

    logEvent("scheduled_post_consume_unexpected", {
      userId: args.userId,
      reason: result?.reason ?? "unknown",
      mode,
    });
    return { kind: "error", message: result?.reason ?? "unexpected_result" };
  } catch (err) {
    // Fail-open by design (see header). Log and let the publish proceed.
    logEvent("scheduled_post_consume_failed", {
      userId: args.userId,
      mode,
      error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
    return { kind: "error", message: err instanceof Error ? err.message : "unknown" };
  }
}

/**
 * The enforce-mode refusal body — shaped like the image/text limit bodies.
 * NOT wired anywhere yet: enforcement is Phase 6C. Exported now so the later
 * cutover changes one call site instead of inventing a shape under pressure.
 */
export function scheduledPostLimitResponseBody() {
  return {
    ok: false,
    error_type: "scheduled_post_limit_reached",
    code: "scheduled_post_limit_reached",
    error: "You have reached your scheduled post limit for this billing period.",
  };
}
