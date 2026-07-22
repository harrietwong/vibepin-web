/**
 * rateLimit.ts — SERVER-ONLY. Durable per-authenticated-user rate limiting for the
 * paid AI provider routes (Phase 1B PR2).
 *
 * Never import this from client code: it reaches Supabase with the service-role key
 * (createServerClient), the same boundary rule as lib/server/pinterest/connectionStore.ts
 * and lib/server/creem/creemStore.ts.
 *
 * WHY: PR1 added authentication to /api/ai-copy, /api/ai-copy/analyze and
 * /api/quality-judge. That converted unlimited ANONYMOUS provider spend into
 * unlimited PER-ACCOUNT provider spend — a disposable or compromised account can
 * still run up unbounded cost. This module is the cost ceiling.
 *
 * WHY POSTGRES AND NOT MEMORY: this app runs on Vercel Lambdas. Any in-process Map
 * (api/contact/route.ts says so in its own comment) or os.tmpdir() lock (the TTL lock
 * in api/generate/route.ts) is PER-INSTANCE EPHEMERAL: two concurrent requests on two
 * instances both pass. Only shared durable state can bound *total* spend. There is no
 * Redis/KV/Upstash dependency in this project, so Postgres (table
 * ai_rate_limit_windows, migrate_v53) is the store.
 *
 * ATOMICITY: never read-then-write. A slot is taken with a compare-and-swap UPDATE
 * guarded on the exact `hits` value we read (`.eq("hits", seen)` + `.select()` →
 * matched-rows tells us whether we won), the same idiom as the Pinterest token_version
 * CAS in lib/server/pinterest/connectionStore.ts. Creating the first row of a window
 * is a plain INSERT whose lost race surfaces as Postgres 23505 on the primary key,
 * the same idiom as markWebhookEventSeen in lib/server/creem/creemStore.ts. Two
 * simultaneous requests therefore cannot both take the last remaining slot.
 *
 * WINDOW TYPE: fixed window. Chosen over sliding because a sliding window cannot be
 * maintained atomically without an RPC/stored procedure, and `.rpc()` is used exactly
 * once in the entire web app — it is by far the weakest precedent here. The known
 * cost of a fixed window (up to 2x the nominal rate across a boundary) is irrelevant
 * for a cost ceiling set well above legitimate burst sizes.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAIL-OPEN IS THE DEFAULT — DELIBERATE. DO NOT "FIX" IT TO FAIL-CLOSED.
 * ═══════════════════════════════════════════════════════════════════════════════
 * If the limiter's own infrastructure is unavailable (Supabase unreachable, table
 * missing because v53 has not been applied yet, network timeout), the request is
 * ALLOWED and a structured warning is logged.
 *
 * This is the OPPOSITE of the prompt-moderation gate in /api/generate, which fails
 * CLOSED — and the difference is intentional. Moderation failing open would let
 * prohibited content through and breaks a compliance obligation. This limiter is a
 * COST CEILING against abuse, not a correctness or compliance control: if Supabase
 * is down, taking the whole product offline for every paying user in order to save
 * provider spend from a hypothetical abuser is strictly the worse outcome. Abuse
 * during a Supabase outage is bounded by the outage itself and is visible in the
 * `ai_rate_limit_unavailable` warnings.
 *
 * If you are here to make this fail-closed, that is a product decision that needs an
 * explicit owner sign-off, not a drive-by hardening.
 *
 * ── THE ONE DOCUMENTED EXCEPTION: `image_generation` ──────────────────────────
 * The `image_generation` bucket (/api/generate) is configured `failClosed: true`
 * and is the ONLY one. That divergence is deliberate and signed off, NOT an
 * oversight to be unified away:
 *
 *   - /api/generate is by a wide margin the most expensive route in the product.
 *     One admitted request buys up to MAX_IMAGES_PER_REQUEST paid image
 *     generations plus a moderation batch of up to MAX_MODERATION_CHECKS outbound
 *     Creem calls. The three text/vision routes above cost one model call each.
 *   - The blast radius of failing open is therefore asymmetric: an unmetered
 *     Supabase outage on /api/ai-copy costs cents per request; on /api/generate an
 *     automated caller can spend without any bound at all for the whole outage.
 *   - The availability argument that justifies fail-open elsewhere is much weaker
 *     here: /api/generate ALREADY hard-depends on Supabase in production
 *     (GENERATION_MODE=worker enqueues a generation_jobs row through the very same
 *     client). If the limiter's store is unreachable, the enqueue was going to fail
 *     anyway — refusing early costs the user a 503 they were going to get, and
 *     saves the paid moderation batch that sits in between.
 *
 * So: do NOT delete `failClosed`, and do NOT set the other three buckets to true.
 * Both halves of that split are the decision.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createServerClient } from "@/lib/supabase";

const TABLE = "ai_rate_limit_windows";

/** Logical route keys. Limits are per-route: exhausting one must not disable another. */
export type RateLimitedRoute = "ai_copy" | "ai_copy_analyze" | "quality_judge" | "image_generation";

export type RateLimitRule = {
  /** Maximum admitted requests per window. */
  limit: number;
  /** Fixed-window length in seconds. */
  windowSeconds: number;
  /**
   * When true, an infrastructure failure REFUSES the request instead of admitting
   * it. Only `image_generation` sets this — see the fail-open block at the top of
   * this file for why that one route diverges and why the others must not.
   * Absent/false keeps the module-wide fail-open default.
   */
  failClosed?: boolean;
};

/**
 * ── LIMITS ─────────────────────────────────────────────────────────────────────
 * All limits live here so they can be tuned without touching a route handler.
 *
 * These are ABUSE CEILINGS, not product quotas. Usage/credit metering is a later
 * phase; this PR must not throttle a single legitimate flow. Every number below is
 * justified against a measured legitimate burst, with deliberate headroom.
 */
export const RATE_LIMITS: Record<RateLimitedRoute, RateLimitRule> = {
  /**
   * POST /api/ai-copy — one vision-or-text model call per request.
   *
   * Legitimate worst case: BatchEditDrawer.handleGenerateCopyBatch loops one call
   * per checked Pin, SEQUENTIALLY, and the Batch surface caps selection at 50 Pins →
   * 50 calls, each taking seconds of model latency (so realistically well over a
   * minute of wall clock, but a fast text-path run could compress into one window).
   * A user may also retry a failed batch, and single-Pin generate/regenerate from
   * PinAICopyPanel runs on the same route.
   *
   * 150/5min = 30/min sustained, and lets three back-to-back 50-Pin batches through
   * inside one window. That is 3x the largest legitimate burst.
   */
  ai_copy: { limit: 150, windowSeconds: 300 },

  /**
   * POST /api/ai-copy/analyze — one vision call per request.
   *
   * Legitimate worst case: StudioBoard.handleFiles fires startImageAnalysis for every
   * uploaded file (unawaited, so several overlap), and it also fires once per
   * GENERATED image. A large upload session is the driver here: a 20-image upload is
   * 20 calls in a short burst, and nothing stops a user from uploading several
   * batches in a row, or uploading while a generation run is also producing images.
   *
   * 200/5min = 40/min sustained, i.e. ten 20-image uploads inside a single window.
   * Comfortably above the ~40/min floor below which real flows break.
   */
  ai_copy_analyze: { limit: 200, windowSeconds: 300 },

  /**
   * POST /api/quality-judge — one grading call per generated image.
   *
   * Naturally the most bounded of the three: it only runs on AI-GENERATED results,
   * inline, capped by MAX_IMAGES_PER_REQUEST (default 2, hard cap 4) per generation.
   * A user cannot generate faster than the image provider returns.
   *
   * 120/5min = 24/min sustained, i.e. 30 back-to-back 4-image generations inside one
   * window — far more than the image pipeline can physically produce in five minutes.
   */
  quality_judge: { limit: 120, windowSeconds: 300 },

  /**
   * POST /api/generate — the image generation route. THE most expensive request in
   * the product: one admitted call buys up to MAX_IMAGES_PER_REQUEST paid image
   * generations (route.ts:44-47 — default 2, hard cap 4) PLUS a moderation batch of
   * up to MAX_MODERATION_CHECKS = 56 outbound Creem calls.
   *
   * This is a REQUEST-VELOCITY / ABUSE CEILING, not allowance metering. Metering
   * ("1 successful image = 1 allowance, flat") is a separate, later phase and must
   * not be inferred from this number: this bucket counts ADMITTED REQUESTS, charges
   * the same for a failed one, and is per fixed window rather than per billing
   * period.
   *
   * ── 40 / 5min = 8/min sustained. Why that is far above every legitimate flow ──
   * Every client call site issues ONE request per user action, never a fan-out loop:
   *   - the main Create Pins generate (studio/page.tsx:588),
   *   - Remix / regenerate-with-remix (studio/page.tsx:3662),
   *   - single-output retry (`mode: "retry_single_output"`, one request per retried
   *     card),
   *   - the Board V2 AiVersions helper (lib/studio/generateAiVersions.ts:112/160).
   * There is no batch surface that loops this route the way BatchEditDrawer loops
   * /api/ai-copy — which is why this ceiling is an order of magnitude below ai_copy's.
   *
   * And each of those requests is SLOW: production runs GENERATION_MODE=worker, a
   * VPS worker fulfils the job in tens of seconds, and the route additionally holds a
   * per-user TTL lock on the inline path. A human clicking Generate, watching, and
   * retrying individual outputs produces single-digit requests per minute. 40 in five
   * minutes allows a user to retry every output of ten consecutive 4-image runs
   * inside one window and still not trip.
   *
   * Deliberately conservative in absolute terms: at the hard cap of 4 images this
   * bucket still bounds one account to 160 paid images / 5 min, which is the point.
   *
   * failClosed: TRUE — the one bucket that diverges from this module's fail-open
   * default. See the block comment at the top of the file; do not unify it.
   */
  image_generation: { limit: 40, windowSeconds: 300, failClosed: true },
};

/**
 * How long a window row is kept before the opportunistic sweep removes it. Must be
 * comfortably longer than the largest windowSeconds so an in-flight window is never
 * deleted out from under a live counter.
 */
const RATE_LIMIT_ROW_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Bounded CAS retries. Each loss means another request took a slot in between, so the
 * budget has to cover realistic simultaneous concurrency on ONE (user, route) window.
 *
 * WHY 32 AND NOT 5: with N racers contending on the same window only one CAS wins per
 * round, so N simultaneous requests need up to N rounds to all settle. A budget of 5
 * measurably UNDERCOUNTED — 10 concurrent first-requests recorded only 5 hits, i.e.
 * half the burst evaded the counter entirely and the ceiling silently drifted upward.
 * 32 covers every burst size these routes actually see (the largest is a 20-image
 * upload) with room to spare, and the jittered backoff below means racers
 * de-synchronise rather than colliding round after round.
 */
const MAX_CAS_ATTEMPTS = 32;

/**
 * Jittered backoff between lost CAS rounds. Without it, contending requests re-read in
 * lockstep and keep colliding; a small random delay spreads them out so each round
 * settles one writer. Kept tiny — this only ever runs on an already-lost race, and the
 * whole loop is bounded by MAX_CAS_ATTEMPTS.
 */
function casBackoffMs(attempt: number): number {
  return Math.min(20, 1 + attempt) * Math.random();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export type RateLimitDecision =
  | { allowed: true; reason: "under_limit" | "limiter_unavailable"; remaining: number | null }
  | { allowed: false; reason: "limit_exceeded"; retryAfterSeconds: number; limit: number; windowSeconds: number }
  /**
   * Only produced for a `failClosed` rule (today: `image_generation`). The limiter
   * could not reach its durable state, so the request is REFUSED rather than
   * admitted. Kept as its own reason so a caller can answer 503 "temporarily
   * unavailable" instead of 429 "you went too fast" — an outage is not the user's
   * fault and Retry-After is a guess, not a window boundary.
   */
  | { allowed: false; reason: "limiter_unavailable"; retryAfterSeconds: number };

type WindowRow = { hits: number };

/** Injection seam so tests can supply a store that models Postgres constraints. */
export type RateLimitStore = {
  /** Read the current hit count, or null when the window row does not exist. */
  read(key: WindowKey): Promise<WindowRow | null>;
  /** Create the window row at hits=1. Returns false on a unique violation (23505). */
  create(key: WindowKey): Promise<boolean>;
  /** CAS: bump hits from `seen` to `seen + 1`. Returns false when another writer won. */
  bump(key: WindowKey, seen: number): Promise<boolean>;
  /** Best-effort prune of this (user, route)'s rows older than `olderThanIso`. */
  prune(key: WindowKey, olderThanIso: string): Promise<void>;
};

export type WindowKey = {
  userId: string;
  route: RateLimitedRoute;
  /** ISO timestamp of the fixed-window bucket start. */
  windowStart: string;
};

// ── Supabase-backed store ───────────────────────────────────────────────────────

function supabaseStore(): RateLimitStore {
  const db = () => createServerClient();
  const where = (key: WindowKey) => ({
    vibepin_user_id: key.userId,
    route: key.route,
    window_start: key.windowStart,
  });

  return {
    async read(key) {
      const { data, error } = await db()
        .from(TABLE)
        .select("hits")
        .eq("vibepin_user_id", key.userId)
        .eq("route", key.route)
        .eq("window_start", key.windowStart)
        .maybeSingle();
      if (error) throw new Error(`rate_limit_read_failed: ${error.message}`);
      return (data as WindowRow | null) ?? null;
    },

    async create(key) {
      // Plain INSERT. A concurrent creator wins the PK race and we get 23505 —
      // exactly the admission-control idiom used by markWebhookEventSeen. Anything
      // else is genuine infrastructure failure and must reach the fail-open handler.
      const { error } = await db().from(TABLE).insert({ ...where(key), hits: 1 });
      if (!error) return true;
      if (error.code === "23505") return false; // lost the creation race → fall back to CAS
      throw new Error(`rate_limit_create_failed: ${error.message}`);
    },

    async bump(key, seen) {
      // CAS: the write only lands while `hits` is still the value we read. `.select`
      // returns the matched rows so a win (1) is distinguishable from a lost race (0).
      const { data, error } = await db()
        .from(TABLE)
        .update({ hits: seen + 1 })
        .eq("vibepin_user_id", key.userId)
        .eq("route", key.route)
        .eq("window_start", key.windowStart)
        .eq("hits", seen)
        .select("hits");
      if (error) throw new Error(`rate_limit_bump_failed: ${error.message}`);
      return Array.isArray(data) && data.length > 0;
    },

    async prune(key, olderThanIso) {
      await db()
        .from(TABLE)
        .delete()
        .eq("vibepin_user_id", key.userId)
        .eq("route", key.route)
        .lt("created_at", olderThanIso);
    },
  };
}

let storeOverride: RateLimitStore | null = null;

/** TEST SEAM ONLY. Swap the durable store for one that models Postgres constraints. */
export function __setRateLimitStoreForTests(store: RateLimitStore | null): void {
  storeOverride = store;
}

function store(): RateLimitStore {
  return storeOverride ?? supabaseStore();
}

// ── Window maths ────────────────────────────────────────────────────────────────

/** Fixed-window bucket start for `nowMs`, aligned to the epoch. */
export function windowStartMs(nowMs: number, windowSeconds: number): number {
  const w = windowSeconds * 1000;
  return Math.floor(nowMs / w) * w;
}

/** Whole seconds until the current window closes (always >= 1, for Retry-After). */
export function secondsUntilWindowEnd(nowMs: number, windowSeconds: number): number {
  const end = windowStartMs(nowMs, windowSeconds) + windowSeconds * 1000;
  return Math.max(1, Math.ceil((end - nowMs) / 1000));
}

// ── The check ───────────────────────────────────────────────────────────────────

/**
 * Consume one slot for (userId, route). Call this immediately after the route's
 * 401 check and BEFORE body parsing, provider configuration and any outbound call.
 *
 * Returns `allowed: false` only when the user genuinely exceeded their window. Every
 * infrastructure failure returns `allowed: true` with reason "limiter_unavailable"
 * (see the fail-open note at the top of this file).
 */
export async function consumeRateLimit(
  userId: string,
  route: RateLimitedRoute,
  nowMs: number = Date.now(),
): Promise<RateLimitDecision> {
  const rule = RATE_LIMITS[route];
  const startMs = windowStartMs(nowMs, rule.windowSeconds);
  const key: WindowKey = { userId, route, windowStart: new Date(startMs).toISOString() };
  const s = store();

  try {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const row = await s.read(key);

      if (!row) {
        // First request of this window. Creating the row also means an older window
        // just rolled over → opportunistically sweep this (user, route)'s stale rows.
        // Best-effort and never awaited into the critical path or the failure path.
        if (await s.create(key)) {
          void Promise.resolve(
            s.prune(key, new Date(nowMs - RATE_LIMIT_ROW_TTL_MS).toISOString()),
          ).catch(() => {});
          return { allowed: true, reason: "under_limit", remaining: rule.limit - 1 };
        }
        // 23505: another request created it first. Re-read and take the CAS path.
        await sleep(casBackoffMs(attempt));
        continue;
      }

      if (row.hits >= rule.limit) {
        return {
          allowed: false,
          reason: "limit_exceeded",
          retryAfterSeconds: secondsUntilWindowEnd(nowMs, rule.windowSeconds),
          limit: rule.limit,
          windowSeconds: rule.windowSeconds,
        };
      }

      if (await s.bump(key, row.hits)) {
        return { allowed: true, reason: "under_limit", remaining: rule.limit - (row.hits + 1) };
      }
      // Lost the CAS — someone else took a slot. Back off briefly so contending
      // requests de-synchronise, then re-read and try again.
      await sleep(casBackoffMs(attempt));
    }

    // Exhausted 32 backed-off rounds on a SINGLE (user, route) window. That means one
    // account had far more simultaneous in-flight requests than any real client flow
    // produces (the largest is a 20-image upload), sustained across every round.
    //
    // Fail OPEN here, consistent with the rest of this module. Note the trade-off
    // deliberately taken: an admission that reaches this line is NOT counted, so it
    // does not consume a slot. That is bounded — reaching it requires losing 32
    // consecutive races, and each of those losses means 32 OTHER requests were counted,
    // so the window fills (and starts denying) far faster than uncounted requests can
    // slip past. Made visible as `ai_rate_limit_contention` so a real occurrence is
    // diagnosable rather than silent.
    console.warn(
      "[rate-limit] contention",
      JSON.stringify({ event: "ai_rate_limit_contention", route, attempts: MAX_CAS_ATTEMPTS }),
    );
    return unavailableDecision(rule, nowMs);
  } catch (err) {
    // FAIL OPEN by default — deliberate. See the block comment at the top of this
    // file before changing this: a limiter outage must not take the product down.
    // The single exception is a `failClosed` rule (image_generation), handled in
    // unavailableDecision below.
    console.warn(
      "[rate-limit] unavailable",
      JSON.stringify({
        event: "ai_rate_limit_unavailable",
        route,
        failClosed: rule.failClosed === true,
        error: (err as Error)?.message?.slice(0, 200) ?? "unknown",
      }),
    );
    return unavailableDecision(rule, nowMs);
  }
}

/**
 * The "limiter could not decide" outcome. Fail-open (admit) for every ordinary
 * bucket; fail-CLOSED (refuse) for a rule that opts in.
 *
 * Both branches live in ONE function on purpose: the divergence is a single
 * documented flag rather than duplicated control flow, so it cannot drift and
 * cannot be half-applied to one exit path but not the other.
 */
function unavailableDecision(rule: RateLimitRule, nowMs: number): RateLimitDecision {
  if (rule.failClosed) {
    return {
      allowed: false,
      reason: "limiter_unavailable",
      // Not a window boundary — the window is exactly what we could not read. A short
      // fixed backoff invites a retry once the outage clears without hammering.
      retryAfterSeconds: Math.min(60, rule.windowSeconds),
    };
  }
  return { allowed: true, reason: "limiter_unavailable", remaining: null };
}

/**
 * Stable user-facing message for a 429. Deliberately blames nothing and asks for a
 * short wait — this is a ceiling against abuse, so a legitimate user who somehow
 * reaches it should read it as "busy", not as an accusation or a paywall.
 */
export const RATE_LIMITED_MESSAGE =
  "You're doing that a bit too fast. Please wait a moment and try again.";

/** Stable machine-readable error code returned in the JSON body of every 429. */
export const RATE_LIMITED_ERROR = "rate_limited";
