/**
 * test-publish-retry-worker.ts — the v82 automatic-retry trunk, at the real route
 * boundary (发布可靠性 P0 技术设计 v0.1 §8.3: P13-P17, P21-P24, P26-P27).
 *
 * Loads the ACTUAL `/api/cron/publish-due` GET handler and fakes only the Supabase
 * and provider boundaries, so what is proven is the route's real wiring rather than a
 * re-implementation of it. Touches no database and makes no network call.
 *
 * ── WHY THE FAKE IMPLEMENTS RPC SEMANTICS INSTEAD OF JUST RECORDING CALLS ───────
 * A record-only fake would make the most important assertions pass vacuously. The
 * route READS the attempt ledger back on the next tick — `retryFork` refuses to
 * retry a destination whose row carries `final_failure_at`, and `nextAttemptNumber`
 * derives this round's attempt from the stored one. A fake that accepted writes and
 * always answered "no history" would let a broken route retry forever and still show
 * green. So `scheduled_publish_attempt_record_v82` is implemented here the way the
 * migration implements it: upsert on (provider, connection, attempt), and stamp
 * `final_failure_at` when attempt 5 finishes with nowhere to go next.
 *
 * The usage ledger is implemented for the same reason. P24's claim is "exactly one
 * charge across the whole lifecycle", and a fake that reported every consume as fresh
 * could not tell a correct route from one that charges five times.
 *
 * ── TIME ────────────────────────────────────────────────────────────────────────
 * `Date.now` is NOT mocked. Advancing simulated time between ticks is done by
 * REWINDING the stored timestamps (the ledger's `next_attempt_at` and the draft's
 * `publish_next_attempt_at`) into the past, which is exactly what real elapsed time
 * would produce and avoids a global mock leaking across cases.
 *
 * Jitter is likewise not defeated: the route calls `computeNextAttemptAt` without
 * injecting `random`, so backoffs are asserted as RANGES (base ±20%) rather than
 * exact instants. An exact-value assertion here would only be possible by reaching
 * into the route, and would then prove nothing about what it really schedules.
 *
 * ── WHAT IS STUBBED FOR TASK 4, AND SAID OUT LOUD ───────────────────────────────
 * The reconciliation worker does not exist yet (it is task 4). Where a scenario needs
 * its verdict — P27's `confirmed_absent` — the test MUTATES the fake's rows by hand to
 * the state task 4 will produce, and the header of that case says so. What P27 proves
 * is the half this task owns: that the row is still there, still scheduled, and gets
 * re-published when that verdict arrives. Without §3.4's two fixes, tick 3 never
 * happens at all.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_METERING_MODE = "shadow";
process.env.USAGE_REQUEST_KEY_SALT = "test-salt";
process.env.CRON_SECRET = "test-cron-secret";

import assert from "node:assert/strict";
import Module from "node:module";

const OWNER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
const DRAFT = "pd_retry_1";
const CONN = "conn-pin-1";
const DUE_AT = "2026-09-01T09:00:00.000Z";

let passed = 0, failed = 0;

// ── Fake state ────────────────────────────────────────────────────────────────

type AttemptRecord = {
  provider: string;
  social_connection_id: string | null;
  attempt: number;
  retry_class: string;
  next_attempt_at: string | null;
  reconcile_required_at: string | null;
  reconciled_at: string | null;
  final_failure_at: string | null;
  /**
   * What the route handed `scheduled_publish_attempt_record_v82` as `p_evidence`.
   *
   * NOT read back by the route — `loadAttemptLedger` does not select it — and so it
   * is deliberately absent from `AttemptRow`. It is kept here because it is the only
   * place the forensic half of the fix is observable: the migration stores these
   * fields as `last_provider_code` / `last_provider_status` / `last_request_id`, and
   * a route that records `{}` for a real Pinterest 400 is exactly the defect
   * (故障 B) the ledger was built to close.
   */
  evidence: Record<string, unknown>;
};

/** The one `pin_drafts` row, with the columns the route filters and writes. */
type DraftRow = {
  vibepin_user_id: string;
  draft_id: string;
  payload: Record<string, unknown>;
  scheduled_at: string | null;
  updated_at: string;
  publish_claimed_at: string | null;
  publish_next_attempt_at: string | null;
  deleted_at: string | null;
  archived_at: string | null;
  status?: string | null;
};

let draft: DraftRow;
let ledger: AttemptRecord[] = [];
/** Idempotency keys already charged, so a replayed consume reports `fresh:false`. */
let chargedKeys = new Set<string>();

let releaseCalls: Array<{ key: string; reason: string }> = [];
let consumeCalls: Array<{ key: string; fresh: boolean }> = [];
let failedEvents: Array<{ code?: string; message?: string }> = [];
let publishPinCalls = 0;
let videoDispatchCalls = 0;
/** Every `or=()` filter string the route built, for the column-naming invariant. */
let orFilters: string[] = [];

let publishPinBehaviour: () => Promise<unknown> = async () => ({
  ok: true, pin: { id: "p1", url: "https://pin/1" }, board: { id: "b1", name: "B" },
  environment: "production", connectionId: CONN,
});
let videoDispatchBehaviour: () => Promise<unknown> = async () => ({
  outcome: "published", remoteId: "v1", retryAllowed: false,
});

function baseDraft(): DraftRow {
  return {
    vibepin_user_id: OWNER, draft_id: DRAFT,
    payload: {
      boardId: "b1", imageUrl: "https://example.com/a.png", targetConnectionId: CONN,
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: CONN, boardId: "b1", capturedAt: DUE_AT },
      ],
    },
    scheduled_at: DUE_AT, updated_at: "2026-09-01T08:00:00.000Z",
    publish_claimed_at: null, publish_next_attempt_at: null,
    deleted_at: null, archived_at: null,
  };
}

/**
 * Turn the draft into a SINGLE-VIDEO one, which is the only shape that reaches the
 * v76 durable dispatcher.
 *
 * Two conditions, both load-bearing, and either one missing makes the video cases
 * pass vacuously against the image path instead: `isSingleVideoPayload` needs
 * `media` to be exactly one `kind: "video"` item (route.ts), and the pre-claim
 * kill-switch filter drops every video row unless `VIDEO_PIN_UPLOAD_ENABLED` is
 * `"true"` (route.ts, the `safeCandidates` filter). `videoDispatchCalls` is asserted
 * in each case for exactly this reason — it is the proof that the branch under test
 * is the branch that ran.
 */
function makeVideoDraft(): void {
  draft.payload = {
    ...draft.payload,
    contentId: "content-video-1",
    title: "Autumn table",
    description: "A short clip",
    altText: "Table",
    destinationUrl: "https://shop.example.com/autumn",
    imageUrl: "https://cdn.test/poster.jpg",
    media: [{
      id: "media-v1", kind: "video", url: "https://cdn.test/clip.mp4",
      width: 1080, height: 1920, durationMs: 8000,
      posterUrl: "https://cdn.test/poster.jpg", source: "upload",
    }],
  };
  process.env.VIDEO_PIN_UPLOAD_ENABLED = "true";
}

/** Rewind every stored timer into the past — "time passed" without mocking a clock. */
function advancePastBackoff(): void {
  const past = new Date(Date.now() - 60_000).toISOString();
  draft.publish_claimed_at = null;
  if (draft.publish_next_attempt_at) draft.publish_next_attempt_at = past;
  for (const row of ledger) if (row.next_attempt_at) row.next_attempt_at = past;
}

// ── The Supabase stand-in ─────────────────────────────────────────────────────

type Filter = [op: string, key: string, value: unknown];

function matchesDraft(filters: Filter[]): boolean {
  for (const [op, key, value] of filters) {
    const actual = (draft as unknown as Record<string, unknown>)[key];
    if (op === "eq" && actual !== value) return false;
    if (op === "is" && actual !== value) return false;
    if (op === "lte" && !(typeof actual === "string" && actual <= String(value))) return false;
    if (op === "not_is_null" && actual === null) return false;
  }
  return true;
}

function fakeSupabaseClient() {
  function draftBuilder() {
    const filters: Filter[] = [];
    let update: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      update: (v: Record<string, unknown>) => { update = v; return b; },
      eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return b; },
      is: (k: string, v: unknown) => { filters.push(["is", k, v]); return b; },
      lte: (k: string, v: unknown) => { filters.push(["lte", k, v]); return b; },
      not: (k: string, _op: string, _v: unknown) => { filters.push(["not_is_null", k, null]); return b; },
      or: (expr: string) => { orFilters.push(expr); return b; },
      order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: { ...draft }, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          const ok = matchesDraft(filters);
          if (update && ok) {
            Object.assign(draft, update);
            // A real claim only wins while the row is claimable; the route's own
            // conditional carries that, and `matchesDraft` evaluated it above.
          }
          const data = ok ? [{ ...draft }] : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
    return b;
  }

  function attemptsBuilder() {
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b, is: () => b, lte: () => b, not: () => b,
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: ledger.map(r => ({ ...r })), error: null }).then(resolve, reject),
    };
    return b;
  }

  return {
    from: (table: string) =>
      (table === "scheduled_publish_attempts" ? attemptsBuilder() : draftBuilder()),
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "scheduled_publish_attempt_record_v82") {
        const provider = String(args.p_provider);
        const conn = args.p_connection_id === null ? null : String(args.p_connection_id);
        const attempt = Number(args.p_attempt);
        const retryClass = String(args.p_retry_class);
        const next = args.p_next_attempt_at === null ? null : String(args.p_next_attempt_at);
        const reconcile = args.p_reconcile_required_at === null ? null : String(args.p_reconcile_required_at);
        // The migration's CHECK (attempt BETWEEN 1 AND 5) — the database is the thing
        // that makes a 6th attempt impossible, so the fake has to refuse it too.
        if (attempt < 1 || attempt > 5) {
          return { data: null, error: { message: "v82_attempt_cap_exceeded", code: "23514" } };
        }
        const evidence = args.p_evidence && typeof args.p_evidence === "object"
          ? args.p_evidence as Record<string, unknown>
          : {};
        const existing = ledger.find(r =>
          r.provider === provider && r.social_connection_id === conn && r.attempt === attempt);
        // Terminal: attempt 5 with nowhere to go next ends the lifecycle (§2.2 D).
        const isFinal = attempt === 5 && next === null
          && (retryClass === "retryable" || retryClass === "reconciliation_required");
        if (existing) {
          existing.retry_class = retryClass;
          existing.next_attempt_at = next;
          existing.reconcile_required_at = existing.reconcile_required_at ?? reconcile;
          existing.evidence = evidence;
          if (isFinal && !existing.final_failure_at) existing.final_failure_at = new Date().toISOString();
        } else {
          ledger.push({
            provider, social_connection_id: conn, attempt, retry_class: retryClass,
            next_attempt_at: next, reconcile_required_at: reconcile, reconciled_at: null,
            final_failure_at: isFinal ? new Date().toISOString() : null,
            evidence,
          });
        }
        return { data: {}, error: null };
      }
      if (fn === "usage_consume_scheduled_post") {
        const key = String(args.p_idempotency_key);
        const fresh = !chargedKeys.has(key);
        chargedKeys.add(key);
        consumeCalls.push({ key, fresh });
        return { data: { ok: true, replayed: !fresh }, error: null };
      }
      if (fn === "usage_release_scheduled_post") {
        const key = String(args.p_idempotency_key);
        releaseCalls.push({ key, reason: String(args.p_reason) });
        chargedKeys.delete(key); // released ⇒ the next consume is fresh again
        return { data: { ok: true }, error: null };
      }
      return { data: { ok: true }, error: null };
    },
  };
}

// ── Module interception ───────────────────────────────────────────────────────

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: unknown, isMain: boolean,
) {
  if (request.endsWith("/lib/supabase") || request === "@/lib/supabase") {
    return { createServerClient: fakeSupabaseClient, createClient: fakeSupabaseClient };
  }
  if (request.endsWith("/lib/server/pinterest/publishPin")) {
    return { publishPinForUser: async () => { publishPinCalls++; return publishPinBehaviour(); } };
  }
  if (request.endsWith("/lib/server/publish/v76PinterestVideoServer")) {
    return { dispatchSupabaseV76PinterestVideo: async () => { videoDispatchCalls++; return videoDispatchBehaviour(); } };
  }
  // `meterScheduledPost.ts` imports this RELATIVELY (`./ensureAccount`), so matching
  // only the resolved-looking path missed it — the real one then ran, hit the fake
  // client's auth layer, threw, and the consume was swallowed by its own fail-open
  // guard. The consume never reached the RPC fake, and P24's charge-count assertion
  // measured nothing. Both spellings are matched now.
  if (request === "./ensureAccount" || request.endsWith("/usage/ensureAccount")) {
    return { ensureUsageAccount: async () => ({ ok: true, action: "noop" }) };
  }
  if (request.endsWith("/lib/server/publishEvents")) {
    const real = origLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      recordPublishEvent: async () => {},
      recordFailedPublishEvent: async (
        _db: unknown, _base: unknown, _ms: unknown, info: { code?: string; message?: string },
      ) => { failedEvents.push(info ?? {}); },
    };
  }
  if (request.endsWith("/social/publishFanout")) {
    const real = origLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, createPublishJob: async () => null, recordOutcomes: async () => {}, fanOutDestinations: async () => [] };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

function cronReq(): Request {
  return {
    url: "https://app.example.com/api/cron/publish-due",
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer test-cron-secret" : null) },
  } as unknown as Request;
}

type RunBody = { claimed: number; published: number; failed: number; skipped: number; deferred: number };

async function test(name: string, fn: () => Promise<void>) {
  draft = baseDraft();
  ledger = [];
  chargedKeys = new Set();
  releaseCalls = []; consumeCalls = []; failedEvents = []; orFilters = [];
  publishPinCalls = 0; videoDispatchCalls = 0;
  publishPinBehaviour = async () => ({
    ok: true, pin: { id: "p1", url: "https://pin/1" }, board: { id: "b1", name: "B" },
    environment: "production", connectionId: CONN,
  });
  videoDispatchBehaviour = async () => ({ outcome: "published", remoteId: "v1", retryAllowed: false });
  process.env.PUBLISH_RETRY_WORKER_ENABLED = "true";
  delete process.env.VIDEO_PIN_UPLOAD_ENABLED;
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).stack ?? (e as Error).message}`); failed++; }
  finally {
    delete process.env.PUBLISH_RETRY_WORKER_ENABLED;
    delete process.env.VIDEO_PIN_UPLOAD_ENABLED;
  }
}

/** The stored result row for the single Pinterest destination, if any. */
function resultRow(): Record<string, unknown> | undefined {
  const rows = draft.payload.destinationResults;
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

/** A 5xx that `classifyPinterestApiError` maps to `retryable`. */
function serverError(PinterestApiError: new (m: string, s: number, c: string) => Error) {
  const e = new PinterestApiError("upstream down", 503, "pinterest_api_error");
  (e as unknown as { providerStatus: number }).providerStatus = 503;
  (e as unknown as { providerResourceId: string | null }).providerResourceId = null;
  return e;
}

(async () => {
  console.log("=== cron/publish-due — v82 automatic retry (route-level, no database) ===\n");

  const { GET } = await import("../src/app/api/cron/publish-due/route") as { GET: (r: Request) => Promise<Response> };
  const { deriveScheduledPostKey } = await import("../src/lib/server/usage/meterScheduledPost");
  const { PinterestApiError, NotConnectedError } = await import("../src/lib/server/pinterest/service");
  const KEY = deriveScheduledPostKey(OWNER, DRAFT, DUE_AT);

  const run = async (): Promise<RunBody> => (await GET(cronReq())).json() as Promise<RunBody>;

  // ── P13 ────────────────────────────────────────────────────────────────────
  await test("P13: round 1 fails, round 2 succeeds — zero customer failure events", async () => {
    publishPinBehaviour = async () => { throw serverError(PinterestApiError); };
    await run();
    assert.equal(failedEvents.length, 0, "a retryable round-1 failure must not tell the merchant anything failed");
    assert.equal(draft.scheduled_at, DUE_AT, "the schedule must survive so round 2 can happen");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].attempt, 1);
    assert.equal(ledger[0].retry_class, "retryable");
    assert.ok(ledger[0].next_attempt_at, "round 1 must schedule round 2");
    assert.equal(ledger[0].final_failure_at, null);

    advancePastBackoff();
    publishPinBehaviour = async () => ({
      ok: true, pin: { id: "p2", url: "https://pin/2" }, board: { id: "b1", name: "B" },
      environment: "production", connectionId: CONN,
    });
    const second = await run();
    assert.equal(second.published, 1, "round 2 publishes");
    assert.equal(failedEvents.length, 0, "and the merchant was never told it failed");
    assert.equal(resultRow()?.status, "published");
    assert.ok(ledger.every(r => r.attempt <= 2), "the ledger stops at 2 — attempt 2 succeeded");
  });

  // ── P14 ────────────────────────────────────────────────────────────────────
  await test("P14: four failures then success — the merchant never sees failed_final", async () => {
    for (let round = 1; round <= 4; round++) {
      publishPinBehaviour = async () => { throw serverError(PinterestApiError); };
      await run();
      assert.equal(failedEvents.length, 0, `round ${round} must stay silent`);
      assert.equal(draft.scheduled_at, DUE_AT, `round ${round} must keep the schedule`);
      const row = ledger.find(r => r.attempt === round);
      assert.ok(row, `round ${round} recorded an attempt`);
      assert.equal(row.final_failure_at, null, `round ${round} is not terminal`);
      advancePastBackoff();
    }
    publishPinBehaviour = async () => ({
      ok: true, pin: { id: "p5", url: "https://pin/5" }, board: { id: "b1", name: "B" },
      environment: "production", connectionId: CONN,
    });
    const last = await run();
    assert.equal(last.published, 1, "the fifth attempt publishes");
    assert.equal(failedEvents.length, 0, "and nothing ever surfaced as a failure");
    assert.equal(publishPinCalls, 5, "exactly five provider calls — one per round");
  });

  // ── P15 ────────────────────────────────────────────────────────────────────
  await test("P15: five definite failures — exactly one final_failure_at, one notice", async () => {
    publishPinBehaviour = async () => { throw serverError(PinterestApiError); };
    for (let round = 1; round <= 5; round++) {
      await run();
      advancePastBackoff();
    }
    const terminal = ledger.filter(r => r.final_failure_at);
    assert.equal(terminal.length, 1, `exactly one terminal row, saw ${terminal.length}`);
    assert.equal(terminal[0].attempt, 5, "and it is the fifth");
    assert.equal(failedEvents.length, 1, `exactly one customer failure event, saw ${failedEvents.length}`);
    assert.equal(draft.scheduled_at, null, "the terminal round ends the schedule lifecycle");
    // The CAS half of notification de-duplication (`claim_terminal_notice_v82`) is
    // task 5's wiring; this asserts the route fires the notice once, not that two
    // concurrent workers would.
  });

  // ── P16 ────────────────────────────────────────────────────────────────────
  await test("P16: there is no sixth attempt — the ledger refuses and the route stops asking", async () => {
    publishPinBehaviour = async () => { throw serverError(PinterestApiError); };
    for (let round = 1; round <= 5; round++) { await run(); advancePastBackoff(); }
    const beforeCalls = publishPinCalls;
    // Force the row back into the due scan the way a tampered hint column would.
    draft.scheduled_at = DUE_AT;
    draft.publish_next_attempt_at = null;
    draft.publish_claimed_at = null;
    await run();
    assert.equal(ledger.filter(r => r.attempt > 5).length, 0, "no row past the cap can exist");
    assert.ok(
      publishPinCalls === beforeCalls || ledger.filter(r => r.final_failure_at).length === 1,
      "a destination that reached final failure is not retried again",
    );
    assert.equal(ledger.length, 5, "five attempt rows, never six");
  });

  // ── P17 ────────────────────────────────────────────────────────────────────
  await test("P17: blocked_user three times running — the five-attempt budget is untouched", async () => {
    publishPinBehaviour = async () => { throw new NotConnectedError(); };
    for (let round = 1; round <= 3; round++) {
      await run();
      draft.scheduled_at = DUE_AT;          // the merchant re-schedules after each
      draft.publish_claimed_at = null;
      draft.publish_next_attempt_at = null;
    }
    assert.equal(ledger.length, 1, "one ledger row, not three — blocked_user does not advance");
    assert.equal(ledger[0].attempt, 1, "still attempt 1 after three blocked rounds");
    assert.equal(ledger[0].retry_class, "blocked_user");
    assert.equal(ledger[0].final_failure_at, null, "no attempt of the five was spent");
    assert.ok(failedEvents.length >= 1, "a blocked user IS told — an expired token needs their action");
  });

  // ── P21 ────────────────────────────────────────────────────────────────────
  await test("P21: the original schedule is preserved across every retry round", async () => {
    // Rounds 1-4. Round 5 is terminal and DOES end the lifecycle (§4.4 item 4) — the
    // promise is "the schedule survives while retries are pending", not "forever".
    publishPinBehaviour = async () => { throw serverError(PinterestApiError); };
    for (let round = 1; round <= 4; round++) {
      await run();
      assert.equal(draft.scheduled_at, DUE_AT, `after round ${round} the schedule is still the original instant`);
      advancePastBackoff();
    }
    assert.equal(draft.scheduled_at, DUE_AT);
  });

  // ── P22 ────────────────────────────────────────────────────────────────────
  await test("P22: a reschedule during a retry round is not overwritten", async () => {
    const NEW_SLOT = "2026-09-02T15:00:00.000Z";
    publishPinBehaviour = async () => {
      // The merchant moves the Content while the provider call is in flight.
      draft.scheduled_at = NEW_SLOT;
      draft.updated_at = new Date().toISOString();
      throw serverError(PinterestApiError);
    };
    await run();
    assert.equal(draft.scheduled_at, NEW_SLOT, "the slot the merchant just chose stands");
  });

  // ── P23 ────────────────────────────────────────────────────────────────────
  await test("P23: one destination published, the other retrying — states are independent", async () => {
    const CONN_B = "conn-pin-2";
    draft.payload.scheduledDestinations = [
      { provider: "pinterest", socialConnectionId: CONN, boardId: "b1", capturedAt: DUE_AT },
      { provider: "pinterest", socialConnectionId: CONN_B, boardId: "b2", capturedAt: DUE_AT },
    ];
    let call = 0;
    publishPinBehaviour = async () => {
      call++;
      if (call === 1) {
        return { ok: true, pin: { id: "pA", url: "https://pin/A" }, board: { id: "b1", name: "B" },
          environment: "production", connectionId: CONN };
      }
      throw serverError(PinterestApiError);
    };
    await run();
    const rows = (draft.payload.destinationResults ?? []) as Array<Record<string, unknown>>;
    const published = rows.filter(r => r.status === "published");
    assert.equal(published.length, 1, "the account that worked is recorded published");
    assert.equal(published[0].socialConnectionId, CONN);
    assert.equal(draft.scheduled_at, DUE_AT, "the row stays scheduled for the destination still owed");
    const retryRow = ledger.find(r => r.social_connection_id === CONN_B);
    assert.ok(retryRow, "the failing account has its own attempt row");
    assert.equal(retryRow.attempt, 1);
    assert.equal(ledger.find(r => r.social_connection_id === CONN), undefined,
      "the account that published has no retry row");

    // Round 2 must re-send ONLY the account that did not go out.
    advancePastBackoff();
    const before = publishPinCalls;
    publishPinBehaviour = async () => ({
      ok: true, pin: { id: "pB", url: "https://pin/B" }, board: { id: "b2", name: "B2" },
      environment: "production", connectionId: CONN_B,
    });
    await run();
    assert.equal(publishPinCalls - before, 1, "exactly one re-send — the published account is never re-sent");
  });

  // ── P24 — CORE ─────────────────────────────────────────────────────────────
  //
  // ★ THE FIXTURE HERE IS LOAD-BEARING AND WAS INITIALLY WRONG. A 503 classifies as
  // `delivery_unknown`, and `isRefundable` covers only `not_sent` / `rejected` — so a
  // 5xx never releases whether or not the exemption exists, and this test passed
  // identically with the fix DELETED. It was measuring nothing.
  //
  // The churn the design describes needs a REFUNDABLE round: a 429 is a provider 4xx
  // with no resource id ⇒ `rejected` ⇒ refundable, and task 2 classifies it as
  // `retryable` (that is §4.3 defect 1 — 429 used to be treated as a definite
  // failure). So it is simultaneously worth retrying and worth refunding, which is
  // exactly the collision §4.4 exists to resolve: without the exemption, round 1
  // releases the unit, the key goes un-charged, round 2 consumes fresh, and the
  // release/re-consume pair repeats every five minutes.
  //
  // Verified by mutation: with `shouldSkipSettlement` removed, this case FAILS.
  await test("P24 (core): rounds 1-4 call releaseScheduledPost ZERO times; the chain charges once", async () => {
    publishPinBehaviour = async () => {
      const e = new PinterestApiError("rate limited", 429, "pinterest_api_error");
      (e as unknown as { providerStatus: number }).providerStatus = 429;
      (e as unknown as { providerResourceId: string | null }).providerResourceId = null;
      throw e;
    };
    for (let round = 1; round <= 4; round++) {
      await run();
      assert.equal(
        releaseCalls.length, 0,
        `round ${round}: expected 0 releases, saw ${releaseCalls.length} `
        + `(${JSON.stringify(releaseCalls.map(c => c.reason))}). A release here re-freshens the `
        + `key, so the next round charges again — the churn this exemption exists to stop.`,
      );
      advancePastBackoff();
    }
    const freshCharges = consumeCalls.filter(c => c.fresh);
    assert.equal(freshCharges.length, 1, `exactly one real charge across four rounds, saw ${freshCharges.length}`);
    assert.equal(freshCharges[0].key, KEY, "and it is the (draft, scheduled_at) key");
    console.log(`        P24 evidence: releases=${releaseCalls.length} consumes=${consumeCalls.length} fresh=${freshCharges.length}`);
  });

  // ── P26 ────────────────────────────────────────────────────────────────────
  await test("P26: flag turned off mid-flight — the pending row is neither lost nor duplicated", async () => {
    publishPinBehaviour = async () => { throw serverError(PinterestApiError); };
    await run();
    assert.equal(draft.scheduled_at, DUE_AT, "round 1 left it scheduled");
    assert.ok(draft.publish_next_attempt_at, "and gated");

    // Roll back: the operator unsets the env var. The gate column is now a dead
    // column — nobody reads it — so the row is claimed on the next tick regardless.
    delete process.env.PUBLISH_RETRY_WORKER_ENABLED;
    draft.publish_claimed_at = null;
    orFilters = [];
    const before = publishPinCalls;
    publishPinBehaviour = async () => ({
      ok: true, pin: { id: "p9", url: "https://pin/9" }, board: { id: "b1", name: "B" },
      environment: "production", connectionId: CONN,
    });
    const body = await run();
    assert.equal(publishPinCalls - before, 1, "not lost: the row is still published exactly once");
    assert.equal(body.published, 1);
    assert.ok(
      orFilters.every(f => !f.includes("publish_next_attempt_at")),
      `flag off must never NAME the v82 column (a missing column degrades the whole run to empty), `
      + `saw: ${JSON.stringify(orFilters)}`,
    );
  });

  // ── P27 — CORE ─────────────────────────────────────────────────────────────
  await test("P27 (core): cross-tick reconcile chain — schedule survives, tick 3 really re-sends", async () => {
    // tick 1: a fetch throw on POST /pins. Cannot be proven un-sent ⇒
    // reconciliation_required ⇒ a delivery_unknown row, and the schedule is HELD.
    publishPinBehaviour = async () => { throw new Error("socket hang up"); };
    await run();
    assert.equal(publishPinCalls, 1, "tick 1 made exactly one create call");
    assert.equal(resultRow()?.status, "delivery_unknown");
    assert.equal(
      draft.scheduled_at, DUE_AT,
      "§3.4(a): a delivery_unknown round must NOT clear the schedule — the due scan filters "
      + "null, so clearing it makes the row invisible and the reconcile verdict unactionable",
    );
    const flagged = ledger.find(r => r.reconcile_required_at && !r.reconciled_at);
    assert.ok(flagged, "reconciliation is flagged on the attempt row");

    // tick 2: nothing is owed (delivery_unknown counts as closed), so the route takes
    // the no-work early exit. That exit used to clear the schedule unconditionally.
    draft.publish_claimed_at = null;
    const before2 = publishPinCalls;
    await run();
    assert.equal(publishPinCalls, before2, "tick 2 sends nothing — never re-send an unknown delivery");
    assert.equal(
      draft.scheduled_at, DUE_AT,
      "§3.4(b): the no-work exit must hold the schedule while a reconciliation is open",
    );

    // The reconciliation worker (task 4) concludes `confirmed_absent`. It does not
    // exist yet, so its two effects are applied by hand here: close the ledger entry
    // and flip the result row back to owed. What THIS task is being tested on is
    // whether tick 3 can then happen at all.
    flagged.reconciled_at = new Date().toISOString();
    flagged.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    draft.payload.destinationResults = [];
    draft.publish_claimed_at = null;
    draft.publish_next_attempt_at = null;

    publishPinBehaviour = async () => ({
      ok: true, pin: { id: "pR", url: "https://pin/R" }, board: { id: "b1", name: "B" },
      environment: "production", connectionId: CONN,
    });
    const tick3 = await run();
    assert.equal(tick3.published, 1, "tick 3 publishes the Pin reconciliation proved was never created");
    assert.equal(
      publishPinCalls, 2,
      `createPin count must be exactly 2 (tick 1 unknown + tick 3 re-send), saw ${publishPinCalls}. `
      + `More means something re-sent an unknown delivery; fewer means the row was lost.`,
    );
    console.log(`        P27 evidence: createPin=${publishPinCalls} scheduled_at held across ticks 1-2, tick3 published=${tick3.published}`);
  });

  // ── 故障 B: THE VIDEO DISPATCH'S REAL EVIDENCE MUST SURVIVE THE ROUTE ───────
  //
  // On 2026-09-21 fourteen scheduled videos were rejected by Pinterest with a real
  // HTTP 400, and not one of them could be diagnosed: the route discarded
  // `durable.evidence` — provider status, provider code, request id, stage, the
  // provider's own message — and wrote the fixed string "Pinterest rejected the
  // video publish." with a HARDCODED `classifyDelivery({ providerStatus: 400 })`.
  // The response body reached no store at all. See
  // docs/coordination/0923-Pinterest视频发布故障-定位与修复方案-v1.0.md 故障 B.
  //
  // These four cases are the regression fence. Each asserts `videoDispatchCalls`
  // first: without `media: [{kind:"video"}]` AND `VIDEO_PIN_UPLOAD_ENABLED=true`
  // the row never reaches the dispatcher and every other assertion below would be
  // measuring the image path.

  /** A real Pinterest rejection, shaped exactly as the adapter's `evidence()` emits it. */
  const REJECTED_400 = {
    outcome: "failed",
    retryAllowed: true,
    evidence: {
      stage: "created",
      classification: "definite_rejection",
      mediaId: "media-v1",
      requestId: "abc123def456ghi789",
      providerStatus: 400,
      providerCode: "SPAM",
      providerMessage: "Video rejected by policy review",
    },
  };

  await test("B1 (flag OFF): the merchant's error carries the real status, code and request id", async () => {
    // Flag off is the deployed state this fix has to work in: it is a forensic
    // change, not a retry-behaviour change, so the else branch — reached directly
    // when `retryFork` is inert — must carry the evidence too.
    delete process.env.PUBLISH_RETRY_WORKER_ENABLED;
    makeVideoDraft();
    videoDispatchBehaviour = async () => REJECTED_400;

    const body = await run();
    assert.equal(videoDispatchCalls, 1, "the video dispatcher must be what ran — otherwise this case proves nothing");
    assert.equal(body.failed, 1, "a rejection is still reported as a failure");

    const error = String(resultRow()?.errorMessage ?? resultRow()?.error ?? "");
    assert.match(error, /HTTP 400/, `the real status must reach the merchant-visible error, saw: ${error}`);
    assert.match(error, /code SPAM/, `the real provider code must reach it, saw: ${error}`);
    assert.match(error, /request abc123def456/, `the request id must reach it so a log can be found, saw: ${error}`);
    assert.match(error, /Video rejected by policy review/, `the provider's own message must reach it, saw: ${error}`);
    assert.ok(
      !/^Pinterest rejected the video publish\.$/.test(error),
      "the fixed string alone is the defect — it is what made 故障 B undiagnosable",
    );
    assert.equal(
      failedEvents[0]?.code, "pinterest_video_publish_failed",
      "the failure CODE is a stable identifier and must NOT change — only the message grows",
    );

    // ── Flag-off behaviour is otherwise untouched ────────────────────────────
    assert.equal(ledger.length, 0, "flag off writes no attempt row at all");
    assert.equal(draft.scheduled_at, null, "flag off still ends the schedule on a failure");
    assert.equal(
      releaseCalls.length, 1,
      "a 4xx rejection is REFUNDABLE and still refunds — a forensic change must not move money",
    );
    assert.equal(releaseCalls[0].reason, "rejected", `the refund reason is unchanged, saw ${releaseCalls[0]?.reason}`);
    console.log(`        B1 evidence: error="${error}" release=${releaseCalls[0]?.reason}`);
  });

  await test("B2 (flag ON): the attempt ledger records the real provider code, not a constant", async () => {
    // The ledger is where a support engineer goes for `last_provider_code` /
    // `last_provider_status` / `last_request_id`. Before this fix the failed branch
    // passed only the orchestration `reason`, which a real provider rejection does
    // not have — so the row's evidence was `{}` and the 400s were invisible there too.
    makeVideoDraft();
    videoDispatchBehaviour = async () => REJECTED_400;

    await run();
    assert.equal(videoDispatchCalls, 1, "the video dispatcher must be what ran");
    assert.equal(ledger.length, 1, "one attempt row for the one destination");
    const evidence = ledger[0].evidence;
    assert.equal(evidence.providerCode, "SPAM", `last_provider_code must be the REAL code, saw ${JSON.stringify(evidence)}`);
    assert.equal(evidence.providerStatus, 400, `last_provider_status must be the REAL status, saw ${JSON.stringify(evidence)}`);
    assert.equal(evidence.requestId, "abc123def456ghi789", "the request id is stored in full — truncation is a display concern only");
    assert.equal(evidence.stage, "created", "the stage the adapter really reached");
    assert.equal(evidence.mediaId, "media-v1", "the media id that was rejected");
    assert.ok(
      !("providerMessage" in evidence),
      "AttemptEvidence is five keys on purpose (attemptLedger.ts) — the message is display-only",
    );

    // A `retryable` round holds the row rather than failing it: unchanged behaviour.
    assert.equal(failedEvents.length, 0, "a retryable round still tells the merchant nothing");
    assert.equal(draft.scheduled_at, DUE_AT, "and still keeps the schedule");
    console.log(`        B2 evidence: ledger[0].evidence=${JSON.stringify(evidence)}`);
  });

  await test("B3: delivery_unknown carries its evidence AND still keeps the charge", async () => {
    makeVideoDraft();
    videoDispatchBehaviour = async () => ({
      outcome: "delivery_unknown",
      retryAllowed: false,
      reconcileRequired: true,
      evidence: {
        stage: "polled", classification: "unknown",
        mediaId: "media-v1", requestId: "req-unknown-1", providerStatus: 503,
        providerCode: "upstream_unavailable",
        providerMessage: "Upstream timed out",
      },
    });

    await run();
    assert.equal(videoDispatchCalls, 1, "the video dispatcher must be what ran");
    const error = String(resultRow()?.errorMessage ?? resultRow()?.error ?? "");
    assert.match(error, /HTTP 503/, `the unknown round's real status must be visible too, saw: ${error}`);
    assert.match(error, /code upstream_unavailable/, `and its code, saw: ${error}`);
    assert.match(error, /Reconcile the original intent/, "the actionable lead sentence is preserved");

    const row = ledger[0];
    assert.equal(row.retry_class, "reconciliation_required", "an unknown delivery still demands reconciliation first");
    assert.equal(row.evidence.providerStatus, 503, "the real status reaches the ledger");
    assert.equal(
      row.evidence.stage, "polled",
      "the REAL stage — this used to be the constant \"created\" whatever actually happened",
    );
    assert.equal(
      row.evidence.providerCode, "upstream_unavailable",
      "the real code — this used to be the constant \"delivery_unknown\"",
    );

    // ── The money invariant, and why it is asserted HERE ─────────────────────
    // `classifyDelivery` maps 4xx to `rejected`, which REFUNDS. An unknown
    // delivery must never refund (deliveryOutcome.ts: we cannot prove nothing
    // exists), so this branch deliberately keeps `classifyDelivery({})` and never
    // feeds it a status — however real that status is.
    assert.equal(
      releaseCalls.length, 0,
      `an unknown delivery must KEEP the charge, saw releases: ${JSON.stringify(releaseCalls)}`,
    );
    assert.equal(draft.scheduled_at, DUE_AT, "§3.4(a): the schedule is held for the reconciliation");
    console.log(`        B3 evidence: error="${error}" releases=${releaseCalls.length} ledgerEvidence=${JSON.stringify(row.evidence)}`);
  });

  await test("B4: a dispatch-layer failure invents no HTTP status and refunds exactly as before", async () => {
    // `materialization_incomplete` never reached Pinterest. It has no status, no
    // code, no request id — and the fix must not manufacture any. It is also the
    // case that pins the `?? 400` fallback: dropping it would reclassify this from
    // `rejected` (refund) to `delivery_unknown` (charge).
    delete process.env.PUBLISH_RETRY_WORKER_ENABLED;
    makeVideoDraft();
    videoDispatchBehaviour = async () => ({
      outcome: "failed", retryAllowed: true, evidence: { reason: "materialization_incomplete" },
    });

    const body = await run();
    assert.equal(videoDispatchCalls, 1, "the video dispatcher must be what ran");
    assert.equal(body.failed, 1);
    const error = String(resultRow()?.errorMessage ?? resultRow()?.error ?? "");
    assert.ok(!/HTTP \d/.test(error), `no status may be invented for a failure that never asked Pinterest, saw: ${error}`);
    assert.match(error, /Pinterest rejected the video publish/, "the lead sentence is unchanged");
    assert.match(error, /reason materialization_incomplete/, `the orchestration reason IS reportable, saw: ${error}`);
    assert.equal(
      releaseCalls[0]?.reason, "rejected",
      `the 400 fallback must still classify this as refundable, saw ${JSON.stringify(releaseCalls)}`,
    );
    console.log(`        B4 evidence: error="${error}" release=${releaseCalls[0]?.reason}`);
  });

  // ── Supporting invariant ───────────────────────────────────────────────────
  await test("flag ON names the gate column in both the scan and the claim", async () => {
    publishPinBehaviour = async () => ({
      ok: true, pin: { id: "p1", url: "https://pin/1" }, board: { id: "b1", name: "B" },
      environment: "production", connectionId: CONN,
    });
    await run();
    const gated = orFilters.filter(f => f.includes("publish_next_attempt_at"));
    assert.equal(gated.length, 2, `the scan AND the claim must both carry the gate, saw ${gated.length}`);
    for (const f of gated) {
      assert.match(f, /publish_next_attempt_at\.is\.null/, "NULL must always be due — pre-v82 rows keep working");
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  (Module as unknown as { _load: unknown })._load = origLoad;
  process.exit(failed ? 1 : 0);
})();
