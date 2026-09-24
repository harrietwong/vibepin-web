/**
 * retry_class classification layer (发布可靠性 P0 技术设计 v0.1 §4.2/§4.3).
 *
 * Pure functions only — nothing here touches a route, a database, or a durable
 * attempt row. This module answers exactly one question for exactly one publish
 * attempt: "given what happened, is this retryable, does it need reconciliation
 * before anything else is sent, is the user blocked, or did it succeed?" Callers
 * (task 3's route wiring) decide what to DO with the answer; this module never
 * schedules, persists, or dispatches anything.
 *
 * ── WHY THIS IS A SEPARATE LAYER FROM `videoPinAdapter.ts`'s `classification` ────
 * The adapter's `classification` field (`succeeded | definite_validation |
 * definite_rejection | unknown`) is NOT the same taxonomy as `retry_class`, and the
 * two must never be conflated:
 *   - `classification` is validated by the v81 settle RPC's value whitelist
 *     (migrate_v81_pinterest_publish_evidence.sql ~line 89: exactly those 4 values).
 *     v81 is hash-guarded by v76/v78's integrity preflight — it cannot be changed
 *     for this feature.
 *   - `retry_class` is a scheduling-plane concept (design §1: "调度平面"). It is
 *     computed HERE, in the consumer, from `classification` + `providerStatus` +
 *     other evidence — never written back into the adapter's evidence object.
 * This is why 429 is "corrected" at this layer (design §4.3 defect 1) instead of by
 * teaching the adapter a 5th `classification` value: changing the adapter's enum
 * would cascade into the hash-guarded v81 RPC.
 *
 * ── THE OTHER HARD CONSTRAINT: retryAfterSeconds NEVER ENTERS SETTLE EVIDENCE ────
 * The v81 settle RPC does a KEY WHITELIST on the evidence object it is given
 * (migrate_v81_pinterest_publish_evidence.sql ~line 70: provider/reason/stage/
 * classification/mediaId/pinId/pinUrl/requestId/providerStatus/providerCode/
 * providerMessage — nothing else). Any extra key throws `provider_evidence_invalid`
 * and the attempt is stuck at `started` forever. `retryAfterSeconds` is therefore
 * carried on the OUTER return value of `publishPinterestVideo` (see
 * `PinterestVideoAdapterRetryAfter` in videoPinAdapter.ts) and on
 * `PinterestApiError.retryAfterSeconds` for the image path — never inside an
 * `evidence` object that flows to a settle RPC. This module's own output type does
 * not have an `evidence` field at all, for the same reason: nothing this module
 * returns should ever look like it is safe to spread into settle evidence.
 *
 * Uncovered typed codes default conservatively (explicitly authorized — not a
 * deviation): an unrecognized 4xx → `blocked_user` (symmetric with the video
 * path's "other 4xx" row, §4.2); a thrown/caught error with no observable
 * provider status → `reconciliation_required` (mirrors deliveryOutcome.ts's
 * "no status ⇒ keep the charge, don't assume non-delivery" rule, and the design's
 * own fetch-throw row). See `classifyGenericError` at the bottom.
 */

import {
  PinterestApiError,
  PinterestTrialAccessError,
  NotConnectedError,
  NeedsReconnectError,
} from "@/lib/server/pinterest/service";
import type { PinterestVideoEvidence } from "@/lib/server/pinterest/videoPinAdapter";
import type { DurableVideoPublishResult } from "./v76PinterestVideoPublish";

/**
 * Re-exported from the leaf module so callers of this file get Retry-After
 * parsing from the same place they get retry_class. See retryAfter.ts for why
 * the implementation itself lives in a separate, zero-import file (breaking a
 * three-way value-import cycle: this file imports service.ts's error classes,
 * service.ts imports videoPinAdapter.ts, and the adapter also needs this parser).
 */
export { parseRetryAfterSeconds } from "./retryAfter";

// ── Output type ──────────────────────────────────────────────────────────────

/**
 * The PRD's three retry classes plus the two states that fall outside retry
 * scheduling entirely (design §2.2 C `scheduled_publish_attempts_class_valid`
 * only accepts the first four; `not_applicable` is this module's own signal
 * and is never written to that column — see `classifyPinterestApiError` below).
 */
export type RetryClass = "retryable" | "reconciliation_required" | "blocked_user" | "succeeded";

export type RetryClassification = {
  retryClass: RetryClass;
  /** Present only when the provider (or our own parsing of its response) gave a
   *  concrete resume time. Absent means "use the base backoff table" (§4.1). */
  retryAfterSeconds?: number;
};

/**
 * `PinterestTrialAccessError` is explicitly excluded from retry_class scheduling
 * (design §4.2 image table: "既不计 attempt 也不 retry_class"; design §3.4 T13:
 * "既有行为，不计 attempt"). The trial-access path releases the claim and keeps
 * the schedule untouched today, and P0 does not change that. Rather than force
 * this into one of the four RetryClass values (any of which would be a lie — it
 * is not retryable-with-backoff, not blocked in the recoverable sense, not
 * awaiting reconciliation, and did not succeed), this function returns the
 * literal string `"not_applicable"` so a caller cannot accidentally treat it as
 * any real class without an explicit check. It is intentionally NOT part of the
 * `RetryClass` union (and therefore never flows into `scheduled_publish_attempts
 * .retry_class`, whose CHECK constraint only allows the four real values).
 */
export type PinterestApiErrorClassification =
  | { kind: "trial_access" }
  | { kind: "classified"; result: RetryClassification };

// ── Video path: adapter evidence → retry_class ──────────────────────────────

/**
 * Classify one `PinterestVideoEvidence` (the adapter-boundary result — stage +
 * classification + providerStatus). This is the §4.2 "视频路径" table, row for
 * row. `retryAfterSeconds` is threaded in separately because the adapter's
 * evidence object itself must never carry it (see module header).
 */
export function classifyVideoEvidence(
  evidence: PinterestVideoEvidence,
  retryAfterSeconds?: number,
): RetryClassification {
  const { stage, classification, providerStatus } = evidence;

  if (classification === "succeeded") return { retryClass: "succeeded" };

  if (classification === "definite_validation") {
    // Local validation failure (bad cover-frame time, empty file, etc). Never a
    // provider call was made — this is a material/parameter problem the user
    // must fix, not a transient condition.
    return { retryClass: "blocked_user" };
  }

  if (classification === "definite_rejection") {
    // §4.3 defect 1: 429 is a definite_rejection at the adapter layer (any 4xx is),
    // but it is the textbook retryable case. Corrected here, at the consumer —
    // the adapter's `classification` enum is not touched (see module header).
    if (providerStatus === 429) {
      return { retryClass: "retryable", ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
    }
    // 401/403 (auth/permission) and 404-on-board are both "user must act" —
    // §4.2 groups them together under blocked_user. Every other 4xx (422 field
    // validation, etc.) is likewise blocked_user per the table's last video row.
    return { retryClass: "blocked_user" };
  }

  // classification === "unknown": stage decides.
  if (stage === "created") {
    // Success with no pinId, or a network exception during/after POST /pins —
    // both land the adapter in stage "created" + classification "unknown".
    // Cannot prove non-delivery ⇒ must reconcile before ever sending again.
    return { retryClass: "reconciliation_required" };
  }
  // stage ∈ {registered, uploaded, polled}: confirmed not to have reached (or
  // reached but not concluded) the create-Pin step — safe to retry from scratch.
  return { retryClass: "retryable", ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
}

/**
 * Classify a dispatch-layer `DurableVideoPublishResult` (the four kinds that
 * originate in v76PinterestVideoPublish.ts's orchestration, not the adapter:
 * provider_boundary_exception, provider_settlement_unavailable,
 * process_loss_after_provider_attempt, materialization_incomplete). These never
 * reach `classifyVideoEvidence` because they are not adapter evidence — they are
 * produced when the orchestration layer itself cannot complete a dispatch.
 */
export function classifyDurableVideoResult(result: DurableVideoPublishResult): RetryClassification {
  if (result.outcome === "published") return { retryClass: "succeeded" };

  const reason = typeof result.evidence?.reason === "string" ? result.evidence.reason : undefined;

  if (reason === "materialization_incomplete") {
    // Never reached the provider — plain retry.
    return { retryClass: "retryable" };
  }
  if (
    reason === "provider_boundary_exception"
    || reason === "provider_settlement_unavailable"
    || reason === "process_loss_after_provider_attempt"
  ) {
    // All three are "the provider may have acted and we cannot prove otherwise"
    // (design §4.2 dispatch-layer rows) — must reconcile before retrying.
    return { retryClass: "reconciliation_required" };
  }

  // `delivery_unknown` outcome without one of the three named reasons above, or
  // any other unrecognized dispatch-layer shape: conservative default per the
  // coordinator's explicit instruction — no observable provider status here
  // (this is an orchestration-layer result, not a raw HTTP response), so treat
  // it the same as a fetch throw: reconciliation_required, never assume
  // non-delivery.
  if (result.outcome === "delivery_unknown" || result.reconcileRequired) {
    return { retryClass: "reconciliation_required" };
  }

  // outcome === "failed" with retryAllowed and no recognized dispatch reason:
  // trust the orchestration layer's own retryAllowed signal.
  return { retryClass: result.retryAllowed ? "retryable" : "blocked_user" };
}

// ── Image path: PinterestApiError / typed validation failures → retry_class ────

/**
 * Classify a thrown error from the image publish path (`publishPinForUser` /
 * `PinterestClient.request`). Covers `PinterestApiError` and its subclasses per
 * the §4.2 "图片路径" table. `PinterestTrialAccessError` is called out
 * explicitly and returns `{ kind: "trial_access" }` rather than a RetryClass —
 * see the `PinterestApiErrorClassification` doc comment above.
 */
export function classifyPinterestApiError(err: unknown): PinterestApiErrorClassification {
  // Order matters: PinterestTrialAccessError, NotConnectedError, and
  // NeedsReconnectError (which MissingPinterestScopesError extends) all extend
  // PinterestApiError, so the most specific classes must be checked first.
  if (err instanceof PinterestTrialAccessError) {
    return { kind: "trial_access" };
  }
  if (err instanceof NotConnectedError || err instanceof NeedsReconnectError) {
    // NotConnectedError (409) / NeedsReconnectError incl. MissingPinterestScopesError
    // (401) are OUR classification of our own connection state, never a provider
    // response — deliveryOutcome.ts's two-field rule treats these as pre-network
    // by class, and so does retry_class: the user must reconnect/grant scopes.
    return { kind: "classified", result: { retryClass: "blocked_user" } };
  }
  if (err instanceof PinterestApiError) {
    // providerResourceId present ⇒ the error body carried a created resource id
    // despite the throw. This wins unconditionally, even over a 429 status —
    // mirrors deliveryOutcome.ts's "resource id present ⇒ sent" rule. The Pin
    // may already exist; never blindly retry, always reconcile first.
    if (typeof err.providerResourceId === "string" && err.providerResourceId.trim()) {
      return { kind: "classified", result: { retryClass: "reconciliation_required" } };
    }

    const status = err.providerStatus;
    const retryAfterSeconds = err.retryAfterSeconds;

    if (status === 429) {
      return {
        kind: "classified",
        result: { retryClass: "retryable", ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) },
      };
    }
    if (typeof status === "number" && status >= 500 && status < 600) {
      // 5xx with no resourceId: PRD Retryable #3 — can confirm nothing was
      // created (POST /pins either returns 201 with an id, or the error body
      // would have carried providerResourceId, per the check above).
      return {
        kind: "classified",
        result: { retryClass: "retryable", ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) },
      };
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      // Any other 4xx (401/403 not already caught above as NeedsReconnectError,
      // and any typed 4xx not covered by the table) — user must act.
      return { kind: "classified", result: { retryClass: "blocked_user" } };
    }

    // No providerStatus at all: err came from `request()` but never observed a
    // real HTTP response (defensive branch; `request()` always sets
    // providerStatus when it throws a PinterestApiError from a response). Same
    // conservative default as a thrown fetch error — see classifyGenericError.
    return { kind: "classified", result: classifyGenericError() };
  }

  // Typed `PublishValidationFailure` from `publishPinForUser` (bad_request,
  // invalid_image_url, invalid_link, board_not_owned, carousel_*) is not thrown
  // — the route inspects `result.ok === false` directly. Every code in that
  // union is a pre-network / provider-rejected-with-no-resource case, so a
  // caller holding one of those `code` strings should treat it as blocked_user
  // directly rather than routing it through this function. This function only
  // classifies THROWN values; a non-Error input (or an Error not matching any
  // Pinterest error class above) falls back to the same conservative default a
  // fetch throw gets.
  return { kind: "classified", result: classifyGenericError() };
}

/**
 * Conservative default for anything outside the §4.2 tables: fetch throws,
 * timeouts, or any other error with no observable provider status. Mirrors
 * deliveryOutcome.ts's rule ("no status ⇒ delivery_unknown ⇒ keep the charge")
 * and the design's own row for `POST /pins` connection failures (§4.2 image
 * table, "fetch 抛错 / 超时 / 无 providerStatus" → reconciliation_required):
 * a single-shot `POST /pins` cannot be proven un-sent, so never blindly retry.
 */
function classifyGenericError(): RetryClassification {
  return { retryClass: "reconciliation_required" };
}

// ── Backoff schedule (design §4.1) ──────────────────────────────────────────

/** Minutes to wait before the Nth retry, indexed by (attempt just completed - 1). */
const BASE_BACKOFF_MINUTES = [1, 5, 15, 60] as const;

/**
 * Compute `next_attempt_at` for the attempt that follows `attempt` (the attempt
 * number that JUST failed/deferred, 1-based). Returns `null` for `attempt >= 5`:
 * there is no 6th attempt to schedule — the caller owns the terminal decision
 * (design §2.2 D: attempt 5 with no next_attempt_at is the final-failure trigger).
 *
 * Formula (§4.1):
 *   base = BASE_BACKOFF_MINUTES[attempt - 1] minutes
 *   jittered = base * (0.8 + random() * 0.4)          // ±20% jitter
 *   candidate = now + jittered
 *   next_attempt_at = max(candidate, retryAfterDeadline)   // Retry-After only ever pushes LATER
 *
 * `random` is injectable so tests can assert exact values; defaults to
 * `Math.random`. `now` is injectable (defaults to `Date.now()`) for the same
 * reason `videoPinAdapter.ts` injects `now`.
 */
export function computeNextAttemptAt(
  attempt: number,
  retryAfterSeconds?: number,
  now: number = Date.now(),
  random: () => number = Math.random,
): Date | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > BASE_BACKOFF_MINUTES.length) return null;

  const baseMinutes = BASE_BACKOFF_MINUTES[attempt - 1];
  const jitterFactor = 0.8 + random() * 0.4; // [0.8, 1.2)
  const jitteredMs = baseMinutes * 60_000 * jitterFactor;
  const candidateMs = now + jitteredMs;

  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    const retryAfterDeadlineMs = now + retryAfterSeconds * 1_000;
    return new Date(Math.max(candidateMs, retryAfterDeadlineMs));
  }
  return new Date(candidateMs);
}
