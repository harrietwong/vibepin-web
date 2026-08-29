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
 * ── THE MIDNIGHT HAZARD AND THE BUCKET RELAY (mintedAt-bound, Codex round 4) ────
 * For an immediate ("publish now") multi-platform publish the client calls the
 * Pinterest route FIRST and the social route SECOND. Both derive an immediate
 * key from a UTC date bucket (below) computed independently at each call's own
 * "now" — if that pair straddles UTC midnight (or the two requests land on
 * instances with skewed clocks), the routes would compute DIFFERENT buckets for
 * the identical Content, the keys would differ, and the shared-key protection
 * above would not save them: a genuine double charge. So the Pinterest route
 * MINTS the bucket once, via `immediateBucketForNow()`, records the SAME instant
 * as `meteringBucketMintedAt`, and returns both plus a signature binding all
 * three (`userId`, `draftId`, `bucket`, `mintedAtMs`) in its response (success or
 * typed failure); the client relays all three to the social route, which passes
 * them here — but only once `verifyImmediateBucket` has proven the signature AND
 * that the relay happened within `IMMEDIATE_BUCKET_MAX_RELAY_MS` of the mint AND
 * that the bucket really is `immediateBucketForNow(mintedAtMs)` (the mint
 * instant's OWN UTC date — this is what makes a UTC-midnight straddle safe: the
 * day-binding check uses the FROZEN mint instant, never the verifying route's own
 * "now", so a relay that crosses midnight still resolves to the day it was
 * minted on, not the day it happened to arrive).
 *
 * This replaced an earlier design (`isAcceptableImmediateBucket`) that only
 * checked the bucket was a real `YYYY-MM-DD` string within one calendar day of
 * the VERIFYING route's own "now" — unsigned, unbound to a mint time, so any
 * authenticated caller could hand the social route an accepted-but-unearned
 * bucket (yesterday's, still inside the old ±1-day window) days after the fact,
 * as long as they replayed it before that window rolled past. Binding the
 * signature to a specific mint instant and bounding how long a relay may take
 * closes both gaps: an unsigned/tampered bucket fails signature verification, and
 * a genuinely-signed one that is simply too old (the relay took more than 15
 * minutes) is rejected as stale — independent of what the calendar date happens
 * to be. A missing, malformed, stale, or unauthenticated bucket is never trusted:
 * the social route silently falls back to computing its own date, exactly as it
 * did before this relay existed.
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
 * `verifyImmediateBucket` below can validate a relayed value against the
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
 * `verifyImmediateBucket` before passing it here — this function does not
 * re-validate it, so an unchecked value would let a caller mint an arbitrary key.
 */
/**
 * The one server-side salt every identity derived in this module is keyed with —
 * `deriveScheduledPostKey`'s idempotency key AND (below) `signImmediateBucket`'s
 * HMAC both read it from here, so the two never drift onto different secrets.
 * No new env var: same fallback chain deriveScheduledPostKey has always used.
 */
/** The configured salt, or null when neither env var carries a usable value. Blank
 *  and whitespace-only values are ABSENT here — Codex round 5: `??` let
 *  `USAGE_REQUEST_KEY_SALT=""` select the empty string as the HMAC key while the
 *  default-salt guard (truthiness) said a real salt was in use. Both the salt and the
 *  "is this the public default?" answer now come from this one function. */
function configuredUsageSalt(): string | null {
  const primary = (process.env.USAGE_REQUEST_KEY_SALT ?? "").trim();
  if (primary) return primary;
  const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (service) return service;
  return null;
}

function usageRequestSalt(): string {
  return configuredUsageSalt() ?? "vibepin-usage";
}

/** True when neither real salt env var is set, so `usageRequestSalt()` fell all the
 *  way through to the hardcoded `"vibepin-usage"` default — a value that is public
 *  (it lives in this source file) and therefore not a secret at all. */
function isUsingDefaultUsageSalt(): boolean {
  return configuredUsageSalt() === null;
}

/** Emits `usage_meter_salt_default` at most once per process (Fix 5 below signs
 *  nothing in production on the default salt, request after request — this must
 *  not spam the log once per publish). */
let saltDefaultLogged = false;
function logSaltDefaultOnce(): void {
  if (saltDefaultLogged) return;
  saltDefaultLogged = true;
  logEvent("usage_meter_salt_default", {
    reason: "USAGE_REQUEST_KEY_SALT and SUPABASE_SERVICE_ROLE_KEY are both unset in production",
  });
}

export function deriveScheduledPostKey(
  userId: string,
  draftId: string,
  scheduledAtIso?: string | null,
  bucketOverride?: string,
): string {
  const bucket = scheduledAtIso && scheduledAtIso.trim()
    ? scheduledAtIso.trim()
    : (bucketOverride ?? immediateBucketForNow());
  return crypto
    .createHash("sha256")
    .update(`${usageRequestSalt()}|${userId}|post:${draftId}:${bucket}`)
    .digest("hex")
    .slice(0, 48);
}

/**
 * How long a relayed immediate-publish bucket may take to travel from the pins
 * route's mint (`signImmediateBucket`) to the social route's verify
 * (`verifyImmediateBucket`) before it is treated as stale rather than a genuine
 * same-publish relay. 15 minutes comfortably covers the pins call, the client's
 * own round-trip, and the social call, while still being far too short for a
 * signed bucket to be usefully replayed against a LATER, unrelated publish.
 */
export const IMMEDIATE_BUCKET_MAX_RELAY_MS = 15 * 60 * 1000;

/**
 * Authenticates a relayed immediate-publish bucket (Codex round 4, Medium —
 * supersedes the round-3 signature, which bound only (userId, draftId, bucket)
 * and left a signed-but-unbound-in-time bucket reusable for up to two days
 * against the old ±1-day calendar window).
 *
 * `signImmediateBucket` is computed once by the pins route right after it mints
 * BOTH the bucket (`immediateBucketForNow()`) and the mint instant
 * (`Date.now()`), and returns all three (bucket, mintedAtMs, sig) to the client.
 * `verifyImmediateBucket` is what the social route runs before trusting a
 * relayed bucket at all — see `classifyImmediateBucket` below for what it
 * actually checks. Keyed with the SAME salt `deriveScheduledPostKey` already
 * uses — no new secret to provision or rotate.
 */
/**
 * Returns `null` — refuses to sign at all — when running in production
 * (`VERCEL_ENV === "production"`) with NEITHER `USAGE_REQUEST_KEY_SALT` nor
 * `SUPABASE_SERVICE_ROLE_KEY` set, i.e. `usageRequestSalt()` would otherwise sign
 * with the hardcoded, publicly-readable `"vibepin-usage"` fallback (Codex round 4,
 * Fix 5). Signing with a public string is not signing — anyone could forge a
 * bucket the social route would then trust, defeating the whole point of
 * `verifyImmediateBucket`. The pins route treats `null` as "omit sig AND
 * mintedAt from the response" (the bucket itself may still be returned; the
 * social route just falls back to its own date, same as any other rejected
 * relay). Outside production the historical fallback behaviour is unchanged —
 * local/dev/preview keep working with zero extra config.
 */
export function signImmediateBucket(userId: string, draftId: string, bucket: string, mintedAtMs: number): string | null {
  if (process.env.VERCEL_ENV === "production" && isUsingDefaultUsageSalt()) {
    logSaltDefaultOnce();
    return null;
  }
  return crypto
    .createHmac("sha256", usageRequestSalt())
    .update(`${userId}|${draftId}|${bucket}|${mintedAtMs}`)
    .digest("hex");
}

/**
 * Classifies WHY a relayed (bucket, sig, mintedAtMs) triple is or is not
 * trustworthy — the social route logs the reason on rejection, and a single
 * boolean (see `verifyImmediateBucket` below) would throw that away.
 *
 *   malformed     — the bucket is not a real `YYYY-MM-DD` string, or mintedAtMs is
 *                    not even a plausible timestamp — never reached the HMAC
 *                    comparison at all.
 *   bad_signature — the bucket/mintedAtMs are well-formed but sig is missing, not
 *                    a hex string, or does not match the HMAC: the bucket,
 *                    draftId, userId or mintedAtMs was tampered, the bucket was
 *                    never signed by this server for this pair, or — Fix 5 — the
 *                    pins route itself omitted the sig because it refused to sign
 *                    with the unsafe default salt in production.
 *   stale         — a GENUINE signature, but either the relay took longer than
 *                    `IMMEDIATE_BUCKET_MAX_RELAY_MS` (or `nowMs` is somehow
 *                    before `mintedAtMs`, i.e. clock skew beyond tolerance), or —
 *                    defense in depth — the bucket is not the mint instant's OWN
 *                    UTC date (`immediateBucketForNow(mintedAtMs)`). This is the
 *                    check that REPLACES the old ±1-day calendar window: it binds
 *                    "which day this counts as" to the frozen mint instant, not to
 *                    whichever route happens to be asking, so a relay that
 *                    straddles UTC midnight still resolves correctly (see the
 *                    module header).
 *   ok            — passed every check; the caller may trust the bucket.
 *
 * Never throws: any malformed/mistyped input classifies as `malformed` rather
 * than throwing, exactly as the old regex+Date.parse gate did.
 */
export function classifyImmediateBucket(
  userId: string,
  draftId: string,
  candidate: unknown,
  sig: unknown,
  mintedAtMs: unknown,
  nowMs: number = Date.now(),
): "ok" | "malformed" | "bad_signature" | "stale" {
  if (typeof candidate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return "malformed";
  const candidateMs = Date.parse(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(candidateMs)) return "malformed";
  // Reject calendar-invalid dates a naive regex+Date.parse pair lets through — e.g.
  // "2026-02-30" or "2026-13-01" normalize FORWARD into a real (wrong) date instead
  // of failing to parse, so the round-trip through ISO string comparison is the only
  // reliable check: a real date's own YYYY-MM-DD slice always equals its input.
  if (new Date(`${candidate}T00:00:00Z`).toISOString().slice(0, 10) !== candidate) return "malformed";
  if (typeof mintedAtMs !== "number" || !Number.isFinite(mintedAtMs) || mintedAtMs <= 0) return "malformed";
  // A missing/non-string/non-hex sig is a signature problem, not a bucket-format one --
  // classified bad_signature (not malformed) so "no sig sent at all" (Fix 5, default-salt
  // fail-closed) reads the same as "a sig was sent but does not verify".
  if (typeof sig !== "string" || !/^[0-9a-f]+$/i.test(sig)) return "bad_signature";

  const expectedSig = signImmediateBucket(userId, draftId, candidate, mintedAtMs);
  // If THIS server would refuse to sign right now (Fix 5's unsafe-default-salt
  // guard), it can never have produced a genuine sig for anything either — nothing
  // this candidate is compared against could possibly be valid.
  if (expectedSig === null) return "bad_signature";
  let sigOk = false;
  try {
    const expected = Buffer.from(expectedSig, "hex");
    const actual = Buffer.from(sig, "hex");
    sigOk = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return "bad_signature";

  const age = nowMs - mintedAtMs;
  if (age < 0 || age > IMMEDIATE_BUCKET_MAX_RELAY_MS) return "stale";
  if (candidate !== immediateBucketForNow(mintedAtMs)) return "stale";

  return "ok";
}

/**
 * Boolean gate built on `classifyImmediateBucket` — true only for "ok". Never
 * throws: a missing/tampered/expired/out-of-band relay is simply "not valid",
 * exactly like a rejected bucket, and must fall back to the caller's own date
 * rather than ever surface as a request error.
 */
export function verifyImmediateBucket(
  userId: string,
  draftId: string,
  bucket: string,
  sig: unknown,
  mintedAtMs: unknown,
  nowMs: number = Date.now(),
): boolean {
  return classifyImmediateBucket(userId, draftId, bucket, sig, mintedAtMs, nowMs) === "ok";
}

export type ScheduledPostConsume =
  | { kind: "off" }
  /**
   * `replayed` — the ledger already had an event under this attempt's effective key,
   * so nothing was charged by THIS call.
   * `fresh` — its exact inverse (`!replayed`), named for what the refund gate actually
   * needs to ask: "did THIS request charge a unit?" v68's consume writes under the key
   * family's CURRENT arm (K when the family has no releases, K:r<n> after n of them),
   * so a consume that lands on a newly re-armed key after a prior refund is `fresh:true`
   * — it really did charge again — while a second route (or a same-day retry) collapsing
   * onto an existing event is `fresh:false`.
   *
   * ONLY a fresh consume may be released. See `releaseScheduledPost`'s header.
   */
  | { kind: "consumed"; replayed: boolean; fresh: boolean }
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
      const replayed = Boolean(result.replayed);
      logEvent("scheduled_post_consumed", {
        userId: args.userId,
        replayed,
        mode,
      });
      // `fresh` is the RPC's own answer, not a guess: v68 returns replayed:false ONLY
      // when it inserted a new consume event under the family's current arm (K, or
      // K:r<n> after n refunds). That is precisely "this request charged a unit", which
      // is the only condition under which the caller may later release one.
      return { kind: "consumed", replayed, fresh: !replayed };
    }

    // v55's RPC answers with `insufficient_capacity`; the shorter `insufficient`
    // is what the in-memory fakes and the sibling meters use. Accepting BOTH is not
    // tolerance for sloppiness — before v68 this branch only matched the short form,
    // so against the real database an over-limit publish fell through to the
    // `unexpected` branch below and returned `kind: "error"`. Every fake-db test
    // still passed. With enforcement now keyed on `kind === "insufficient"` (the
    // A.4.0 blocking sites), that mismatch would have meant a limit gate that is
    // green in tests and silently open in production.
    if (result?.reason === "insufficient" || result?.reason === "insufficient_capacity") {
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

/**
 * ── REFUND (v68) ───────────────────────────────────────────────────────────────
 *
 * A publish is charged BEFORE the provider call (see consumeScheduledPost above),
 * which is right for the crash case and wrong for the two cases where nothing was
 * ever created. PRD v3.2 §5.3/§5.4 (decisions #4 and #8) fixes what happens:
 *
 *   not_sent          the request never left us                     → refund
 *   rejected          provider returned 4xx and created nothing     → refund
 *   sent              provider returned a resource id               → keep the charge
 *   delivery_unknown  timeout / 5xx / no status code at all         → keep the charge,
 *                     never refunded and never re-charged
 *
 * `delivery_unknown` is deliberately charged: a timeout is trivially reproducible,
 * so refunding it would be an advertised free-publish bypass. The product accepts
 * over-charging in that narrow case rather than under-charging in the general one.
 *
 * ── ONLY A FRESH CONSUME MAY BE RELEASED (Codex round 7, High 1 + High 2) ──────
 * The key K is SHARED: /api/pinterest/pins and /api/publish/social both derive it
 * for the same Content, and a same-day retry of an immediate publish derives it
 * again. Exactly one of those calls charges a unit; every other call collapses into
 * a replay. But `usage_release_scheduled_post` takes only (user, K, reason) — it has
 * no attempt identity, so it refunds the family's standing consume no matter WHICH
 * caller asks. That let a route give back a unit it never charged:
 *
 *   HIGH 1  pins consumes K fresh and DELIVERS (sent → keep) → social consumes the
 *           SAME K (replayed) → all social targets rejected → social releases K,
 *           refunding a Pin that is live. Same shape refunds a preceding
 *           `delivery_unknown` Pinterest attempt.
 *   HIGH 2  publish succeeds once (K kept) → retry the same draft later the same day
 *           with a deliberately invalid destination → consume replays K → refundable
 *           failure → release refunds the EARNED unit. A repeatable free publish.
 *
 * The rule that closes both, in ONE place — the route gate, not here:
 *
 *     a route may call releaseScheduledPost ONLY when its OWN consume in THIS
 *     request came back `kind === "consumed"` with `fresh === true`.
 *
 * A replayed consume means the unit was already earned by, or is owned by, another
 * attempt — never release it. (`off` / `insufficient` / `error` consumes are not
 * fresh either, and are equally not releasable: none of them charged anything, and
 * calling release after one of them would target a PRIOR attempt's consume.)
 *
 * RESIDUAL, deliberately deferred: two CONCURRENT attempts on the same key where the
 * fresh one fails and the replaying one succeeds still refunds a delivered publish —
 * the fresh attempt legitimately owns the unit it charged, and nothing in the current
 * ledger tells it that a sibling in flight delivered. Fixing that needs publish-action
 * identity (PRD v3.2 §21 5A) so the release names an ATTEMPT rather than a family.
 * A same-day retry after a prior SUCCESS is NOT a residual: it is correctly
 * non-refundable, because the unit was earned by the publish that landed.
 *
 * The caller passes the SAME key it consumed with — never a re-derived one (an
 * immediate publish's key contains a UTC date bucket that may have been relayed
 * from another route, and re-deriving it here could resolve to a different day and
 * refund nothing). v68's RPC owns the attempt arithmetic: it finds the latest
 * un-released consume in key family K, decrements once, and writes a `release`
 * event keyed `K:release:<n>`. A later successful publish under the same K is then
 * charged again, because the RPC re-arms the family to `K:r<n>` — that is what makes
 * "refunded, then published → charged again" true without any caller carrying an
 * attempt counter.
 */
export type ScheduledPostReleaseReason = "not_sent" | "rejected";

export type ScheduledPostRelease =
  | { kind: "off" }
  | { kind: "released"; replayed: boolean }
  | { kind: "nothing_to_release" }
  | { kind: "error"; message: string };

export type ReleaseScheduledPostArgs = {
  userId: string;
  /** The EXACT key the matching consumeScheduledPost used — never re-derived here. */
  key: string;
  reason: ScheduledPostReleaseReason;
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
  deps?: { rpc?: RpcRunner };
};

/**
 * Give back one scheduled-post unit, idempotently.
 *
 * FAIL-OPEN, and more strictly than consume: this runs on a path that has ALREADY
 * failed, and the caller is about to answer the user about that failure. A ledger
 * problem here must never change the response, never throw, and never mask the real
 * publish error — it logs `usage_meter_release_error` and returns. The worst case of
 * a lost refund is one over-charged unit, visible in `usage_events`; the worst case
 * of a thrown refund is a publish route that 500s on top of an already-failed
 * publish.
 *
 * No `ensureUsageAccount` call: a refund is only ever meaningful when a consume
 * already ran, and that consume provisioned the account. Provisioning one HERE would
 * create a fresh row and then try to refund a charge that row never had.
 */
export async function releaseScheduledPost(args: ReleaseScheduledPostArgs): Promise<ScheduledPostRelease> {
  const mode = usageMeteringMode();
  if (mode === "off") return { kind: "off" };

  try {
    const rpc = args.deps?.rpc ?? defaultRpc();
    const { data, error } = await rpc("usage_release_scheduled_post", {
      p_user_id: args.userId,
      p_idempotency_key: args.key,
      p_reason: args.reason,
      p_reference_id: args.referenceId ?? null,
      p_metadata: args.metadata ?? {},
    });

    if (error) {
      logEvent("usage_meter_release_error", {
        userId: args.userId,
        reason: args.reason,
        mode,
        error: error.message.slice(0, 200),
      });
      return { kind: "error", message: error.message };
    }

    const result = data as { ok?: boolean; replayed?: boolean; reason?: string } | null;

    if (result?.ok) {
      logEvent("scheduled_post_released", {
        userId: args.userId,
        reason: args.reason,
        replayed: Boolean(result.replayed),
        mode,
      });
      return { kind: "released", replayed: Boolean(result.replayed) };
    }

    if (result?.reason === "nothing_to_release") {
      // Not an error and not rare: metering may be off for this user, the consume
      // may have been refused (enforce), or the failure happened before it ran.
      logEvent("scheduled_post_nothing_to_release", { userId: args.userId, mode });
      return { kind: "nothing_to_release" };
    }

    logEvent("usage_meter_release_error", {
      userId: args.userId,
      reason: args.reason,
      mode,
      error: `unexpected_result:${result?.reason ?? "unknown"}`,
    });
    return { kind: "error", message: result?.reason ?? "unexpected_result" };
  } catch (err) {
    logEvent("usage_meter_release_error", {
      userId: args.userId,
      reason: args.reason,
      mode,
      error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
    return { kind: "error", message: err instanceof Error ? err.message : "unknown" };
  }
}
