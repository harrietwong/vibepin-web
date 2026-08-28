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
 * Multi-platform costs 1 BY CONSTRUCTION, not by code here: BOTH the Pinterest
 * publish (/api/pinterest/pins, and the cron claim) and the social fan-out
 * (/api/publish/social) call this module for the SAME Content, and both derive
 * the SAME key — deriveScheduledPostKey(uid, draftId) — so whichever call lands
 * second collapses into a replay under v55's UNIQUE(user_id, idempotency_key),
 * never a second unit.
 *
 * ── THE MIDNIGHT HAZARD AND THE BUCKET RELAY ────────────────────────────────────
 * For an immediate ("publish now") multi-platform publish the client calls the
 * Pinterest route FIRST and the social route SECOND. Both derive an immediate
 * key from a UTC date bucket (below) computed independently at each call's own
 * "now" — if that pair straddles UTC midnight (or the two requests land on
 * instances with skewed clocks), the routes would compute DIFFERENT buckets for
 * the identical Content, the keys would differ, and the shared-key protection
 * above would not save them: a genuine double charge. So the Pinterest route
 * MINTS the bucket once, via `immediateBucketForNow()`, and returns it in its
 * response (success or typed failure); the client relays it to the social route
 * as `meteringBucket`, which passes it here as `deriveScheduledPostKey`'s
 * `bucketOverride` arg INSTEAD OF computing its own — but only once
 * `isAcceptableImmediateBucket` has validated it (a `YYYY-MM-DD` string, UTC,
 * within one day either side of that route's own "now"). A missing, malformed,
 * or out-of-window bucket is never trusted: the social route silently falls back
 * to computing its own date, exactly as it did before this relay existed.
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

export { usageMeteringMode, type UsageMeteringMode, usageEnforceFor, type UsageEnforceType } from "./meterGeneration";

/**
 * Today's UTC date bucket, `YYYY-MM-DD` — the value an immediate publish's key is
 * built from when no `scheduledAtIso` applies. Exported as its own pure function
 * (rather than inlined) so the Pinterest route can mint ONE bucket and hand it to
 * both its own key derivation and the client relay (see the module header), and so
 * `isAcceptableImmediateBucket` below can validate a relayed value against the
 * SAME computation without duplicating the date-slicing logic.
 */
export function immediateBucketForNow(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/**
 * Stable identity for one publish action, salted like deriveRequestKey so a
 * tampered draft id cannot collide across users.
 *
 *   scheduled: deriveScheduledPostKey(userId, draftId, scheduledAtIso)
 *   immediate: deriveScheduledPostKey(userId, draftId)  → this call's own UTC date bucket
 *   immediate, bucket relayed from the pins route:
 *              deriveScheduledPostKey(userId, draftId, undefined, bucketOverride)
 *
 * `bucketOverride` is used INSTEAD OF the locally computed date, and only takes
 * effect on the immediate path (a real `scheduledAtIso` always wins — a scheduled
 * publish's key must stay tied to its schedule, never to when it happened to run).
 * Callers MUST validate an externally-supplied override with
 * `isAcceptableImmediateBucket` before passing it here — this function does not
 * re-validate it, so an unchecked value would let a caller mint an arbitrary key.
 */
export function deriveScheduledPostKey(
  userId: string,
  draftId: string,
  scheduledAtIso?: string | null,
  bucketOverride?: string,
): string {
  const bucket = scheduledAtIso && scheduledAtIso.trim()
    ? scheduledAtIso.trim()
    : (bucketOverride ?? immediateBucketForNow());
  const salt = process.env.USAGE_REQUEST_KEY_SALT ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "vibepin-usage";
  return crypto
    .createHash("sha256")
    .update(`${salt}|${userId}|post:${draftId}:${bucket}`)
    .digest("hex")
    .slice(0, 48);
}

/**
 * Is `candidate` a trustworthy relayed immediate-publish bucket?
 *
 * True only when it is a `YYYY-MM-DD` string AND within ±1 UTC day of this call's
 * own `immediateBucketForNow(nowMs)` — i.e. exactly {yesterday, today, tomorrow}.
 * That window is deliberately narrow: it exists solely to absorb the pins-route
 * call and the social-route call landing a few seconds apart across a UTC-midnight
 * boundary (or a small clock skew between instances), not to let a client dictate
 * an arbitrary bucket. Anything wider would let a stale or forged value keep
 * matching long after it stopped describing "the other half of this same publish".
 */
export function isAcceptableImmediateBucket(candidate: unknown, nowMs: number = Date.now()): candidate is string {
  if (typeof candidate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const candidateMs = Date.parse(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(candidateMs)) return false;
  const todayMs = Date.parse(`${immediateBucketForNow(nowMs)}T00:00:00.000Z`);
  const diffDays = Math.round((candidateMs - todayMs) / 86_400_000);
  return diffDays >= -1 && diffDays <= 1;
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
