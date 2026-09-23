/**
 * test-publish-v82-capability.ts — task 5 at the real route boundary: the
 * fail-closed schema capability check, and terminal-notice CAS de-duplication
 * (发布可靠性 P0 技术设计 v0.1 §9 task 5, §4.4 step 5, T14, P15).
 *
 * Loads the ACTUAL `/api/cron/publish-due` GET handler, same as
 * test-publish-retry-worker.ts, and fakes only Supabase and the provider. No
 * database, no network.
 *
 * ── THE ORDER OF THESE CASES IS THE DESIGN'S, NOT A PREFERENCE ────────────────
 * Design §9 puts this task's own risk in one line: "fail closed written wrong will
 * block ordinary publishing too; the probe must only take effect with the flag on".
 * So the FIRST case is the flag-off one, and it does not merely assert that nothing
 * broke — it COUNTS the probe queries and requires zero. A check that ran and
 * happened to pass would satisfy "nothing broke" and still be the defect, because
 * production has not applied v82 and every one of those six probes would come back
 * missing. Zero queries is the only assertion that distinguishes the two.
 *
 * ── WHY THE FAKE MODELS ABSENCE AS PostgREST DOES ────────────────────────────
 * A missing function is not a thrown error; PostgREST answers it with a normal
 * response body carrying code PGRST202, and a missing table with PGRST205. Faking
 * absence as a throw would test a code path that production never takes and would
 * let a check that only catches exceptions pass. So `schemaPresent = false` makes the
 * fake return those exact codes, the same shape the real client hands back.
 *
 * ── WHY THE CAS IS IMPLEMENTED, NOT RECORDED ─────────────────────────────────
 * The point of `scheduled_publish_claim_terminal_notice_v82` is that it answers
 * `true` to exactly ONE caller and `false` to every other, whatever the concurrency.
 * A fake that merely counted calls could not tell a route that respects the answer
 * from one that ignores it — both would call it twice. So the fake stamps
 * `terminal_notified_at` on its own ledger row and returns whether it was the one
 * that stamped it, exactly as the migration's UPDATE … WHERE terminal_notified_at IS
 * NULL does. The assertion that matters is then not "the CAS was called" but "the
 * SECOND call returned false AND no second notification was sent".
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_METERING_MODE = "shadow";
process.env.USAGE_REQUEST_KEY_SALT = "test-salt";
process.env.CRON_SECRET = "test-cron-secret";

import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";

const OWNER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
const DRAFT = "pd_cap_1";
const CONN = "conn-pin-1";
const DUE_AT = "2026-09-01T09:00:00.000Z";

const V82_TABLES = new Set(["scheduled_publish_attempts", "publish_reconcile_checks"]);
const V82_RPCS = new Set([
  "scheduled_publish_attempt_record_v82",
  "scheduled_publish_claim_terminal_notice_v82",
  "publish_reconcile_record_v82",
  "publish_intent_confirm_prepare_v82",
]);

let passed = 0, failed = 0;

// ── Fake state ────────────────────────────────────────────────────────────────

type AttemptRecord = {
  id: string;
  provider: string;
  social_connection_id: string | null;
  attempt: number;
  retry_class: string;
  next_attempt_at: string | null;
  reconcile_required_at: string | null;
  reconciled_at: string | null;
  final_failure_at: string | null;
  /** The column the CAS stamps. Null means "nobody has notified for this row yet". */
  terminal_notified_at: string | null;
};

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
};

let draft: DraftRow;
let ledger: AttemptRecord[] = [];
let chargedKeys = new Set<string>();

/** Is v82 installed in this fake database? Flipped per case. */
let schemaPresent = true;
/** Every capability probe the route issued, so the flag-off case can require zero. */
let capabilityProbes: string[] = [];
/** Every CAS call and what the fake answered — the de-duplication evidence. */
let noticeClaims: Array<{ attemptRowId: string; granted: boolean }> = [];
let failedEvents: Array<{ code?: string; message?: string }> = [];
let publishPinCalls = 0;

let publishPinBehaviour: () => Promise<unknown> = async () => ({
  ok: true, pin: { id: "p1", url: "https://pin/1" }, board: { id: "b1", name: "B" },
  environment: "production", connectionId: CONN,
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

/** Rewind stored timers into the past — "time passed" without mocking a clock. */
function advancePastBackoff(): void {
  const past = new Date(Date.now() - 60_000).toISOString();
  draft.publish_claimed_at = null;
  if (draft.publish_next_attempt_at) draft.publish_next_attempt_at = past;
  for (const row of ledger) if (row.next_attempt_at) row.next_attempt_at = past;
}

/** What PostgREST answers for an object this database does not have. */
const ABSENT_TABLE = { message: "Could not find the table 'public.x' in the schema cache", code: "PGRST205" };
const ABSENT_RPC = { message: "Could not find the function public.x in the schema cache", code: "PGRST202" };

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
      not: (k: string) => { filters.push(["not_is_null", k, null]); return b; },
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: { ...draft }, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          const ok = matchesDraft(filters);
          if (update && ok) Object.assign(draft, update);
          return Promise.resolve({ data: ok ? [{ ...draft }] : [], error: null }).then(resolve, reject);
        } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
    return b;
  }

  /**
   * `scheduled_publish_attempts`, honouring the filters the route actually sends.
   *
   * The generic "return every row" stand-in used by the retry-trunk suite is not
   * enough here: `findTerminalAttemptId` filters on provider, connection and
   * `final_failure_at is not null`, and if those are ignored it would find a
   * non-terminal row, hand its id to the CAS, and the de-duplication test would be
   * measuring the wrong row.
   */
  function attemptsBuilder(table: string) {
    const filters: Filter[] = [];
    let limit = Infinity;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return b; },
      is: (k: string, v: unknown) => { filters.push(["is", k, v]); return b; },
      lte: () => b,
      not: (k: string) => { filters.push(["not_is_null", k, null]); return b; },
      or: () => b, order: () => b,
      limit: (n: number) => { limit = n; return b; },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        // A capability probe is `select("id").limit(0)` with no filters — recorded
        // so the flag-off case can require that none were ever issued.
        if (limit === 0 && !filters.length) capabilityProbes.push(`table:${table}`);
        if (!schemaPresent) {
          return Promise.resolve({ data: null, error: ABSENT_TABLE }).then(resolve, reject);
        }
        if (table !== "scheduled_publish_attempts") {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        }
        const rows = ledger.filter(r => {
          for (const [op, key, value] of filters) {
            if (key === "owner_user_id" || key === "draft_id" || key === "scheduled_at") continue;
            const actual = (r as unknown as Record<string, unknown>)[key];
            if (op === "eq" && actual !== value) return false;
            if (op === "is" && actual !== value) return false;
            if (op === "not_is_null" && actual === null) return false;
          }
          return true;
        }).map(r => ({ ...r }));
        rows.sort((a, z) => z.attempt - a.attempt);
        const data = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (table: string) =>
      (V82_TABLES.has(table) ? attemptsBuilder(table) : draftBuilder()),
    async rpc(fn: string, args: Record<string, unknown>) {
      // ── Capability probes ──────────────────────────────────────────────────
      // Recognised by their deliberately-invalid arguments, which is exactly how
      // the real RPCs recognise them: each refuses at its first validation.
      if (V82_RPCS.has(fn)) {
        const isProbe =
          (fn === "scheduled_publish_attempt_record_v82" && args.p_user_id === null)
          || (fn === "publish_reconcile_record_v82" && args.p_outcome === "__probe__")
          || (fn === "publish_intent_confirm_prepare_v82"
            && args.p_source_identity_fingerprint === "__v82_capability_probe__")
          || (fn === "scheduled_publish_claim_terminal_notice_v82"
            && args.p_attempt_row_id === "00000000-0000-4000-8000-000000000000");
        if (isProbe) {
          capabilityProbes.push(`rpc:${fn}`);
          if (!schemaPresent) return { data: null, error: ABSENT_RPC };
          // Present: each answers with its OWN validation refusal, except the CAS
          // which legitimately returns false for a row that does not exist.
          if (fn === "scheduled_publish_claim_terminal_notice_v82") {
            return { data: false, error: null };
          }
          return { data: null, error: { message: "v82_probe_rejected", code: "22023" } };
        }
      }
      if (!schemaPresent && V82_RPCS.has(fn)) return { data: null, error: ABSENT_RPC };

      if (fn === "scheduled_publish_attempt_record_v82") {
        const provider = String(args.p_provider);
        const conn = args.p_connection_id === null ? null : String(args.p_connection_id);
        const attempt = Number(args.p_attempt);
        const retryClass = String(args.p_retry_class);
        const next = args.p_next_attempt_at === null ? null : String(args.p_next_attempt_at);
        const reconcile = args.p_reconcile_required_at === null ? null : String(args.p_reconcile_required_at);
        if (attempt < 1 || attempt > 5) {
          return { data: null, error: { message: "v82_attempt_cap_exceeded", code: "23514" } };
        }
        const existing = ledger.find(r =>
          r.provider === provider && r.social_connection_id === conn && r.attempt === attempt);
        const isFinal = attempt === 5 && next === null
          && (retryClass === "retryable" || retryClass === "reconciliation_required");
        if (existing) {
          existing.retry_class = retryClass;
          existing.next_attempt_at = next;
          existing.reconcile_required_at = existing.reconcile_required_at ?? reconcile;
          if (isFinal && !existing.final_failure_at) existing.final_failure_at = new Date().toISOString();
        } else {
          ledger.push({
            id: randomUUID(), provider, social_connection_id: conn, attempt,
            retry_class: retryClass, next_attempt_at: next,
            reconcile_required_at: reconcile, reconciled_at: null,
            final_failure_at: isFinal ? new Date().toISOString() : null,
            terminal_notified_at: null,
          });
        }
        return { data: {}, error: null };
      }

      // ── The CAS, implemented the way the migration implements it ────────────
      // UPDATE … SET terminal_notified_at = now() WHERE id = $2 AND owner = $1
      //   AND final_failure_at IS NOT NULL AND terminal_notified_at IS NULL
      // returning whether a row was affected. One winner, always.
      if (fn === "scheduled_publish_claim_terminal_notice_v82") {
        const id = String(args.p_attempt_row_id);
        const row = ledger.find(r => r.id === id);
        const granted = !!row && !!row.final_failure_at && row.terminal_notified_at === null;
        if (granted && row) row.terminal_notified_at = new Date().toISOString();
        noticeClaims.push({ attemptRowId: id, granted });
        return { data: granted, error: null };
      }

      if (fn === "usage_consume_scheduled_post") {
        const key = String(args.p_idempotency_key);
        const fresh = !chargedKeys.has(key);
        chargedKeys.add(key);
        return { data: { ok: true, replayed: !fresh }, error: null };
      }
      if (fn === "usage_release_scheduled_post") {
        chargedKeys.delete(String(args.p_idempotency_key));
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
    return { dispatchSupabaseV76PinterestVideo: async () => ({ outcome: "published", remoteId: "v1", retryAllowed: false }) };
  }
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

let resetCapabilityCache: () => void = () => {};

async function test(name: string, fn: () => Promise<void>) {
  draft = baseDraft();
  ledger = [];
  chargedKeys = new Set();
  capabilityProbes = []; noticeClaims = []; failedEvents = [];
  publishPinCalls = 0;
  schemaPresent = true;
  // The capability memo lives for the life of the PROCESS, so without this reset a
  // case's result would depend on whether an earlier case happened to warm it.
  resetCapabilityCache();
  publishPinBehaviour = async () => ({
    ok: true, pin: { id: "p1", url: "https://pin/1" }, board: { id: "b1", name: "B" },
    environment: "production", connectionId: CONN,
  });
  process.env.PUBLISH_RETRY_WORKER_ENABLED = "true";
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).stack ?? (e as Error).message}`); failed++; }
  finally { delete process.env.PUBLISH_RETRY_WORKER_ENABLED; }
}

function serverError(PinterestApiError: new (m: string, s: number, c: string) => Error) {
  const e = new PinterestApiError("upstream down", 503, "pinterest_api_error");
  (e as unknown as { providerStatus: number }).providerStatus = 503;
  (e as unknown as { providerResourceId: string | null }).providerResourceId = null;
  return e;
}

(async () => {
  console.log("=== cron/publish-due — v82 capability check + terminal-notice CAS ===\n");

  const { GET } = await import("../src/app/api/cron/publish-due/route") as { GET: (r: Request) => Promise<Response> };
  const cap = await import("../src/app/api/cron/publish-due/v82Capability");
  resetCapabilityCache = cap.__resetV82CapabilityCacheForTests;
  const { PinterestApiError } = await import("../src/lib/server/pinterest/service");

  const run = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await GET(cronReq());
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  // ── C1 — THE FIRST CASE ON PURPOSE ────────────────────────────────────────
  await test("C1: flag OFF ⇒ the capability check does not exist — zero probes, zero effect", async () => {
    delete process.env.PUBLISH_RETRY_WORKER_ENABLED;
    // The state that would fail the check hardest: v82 is NOT installed, which is
    // production's actual state today. If the probe ran at all it would come back
    // missing and this row would never publish.
    schemaPresent = false;
    const { status, body } = await run();
    assert.equal(capabilityProbes.length, 0,
      `flag off must issue NO capability probe, saw ${JSON.stringify(capabilityProbes)}`);
    assert.equal(status, 200, "and the run must not be refused");
    assert.equal(body.published, 1, "the row published exactly as it does on the baseline");
    assert.equal(publishPinCalls, 1);
    assert.ok(!("reconciled" in body), "the response body stays byte-identical to the baseline");
  });

  // ── C2 ─────────────────────────────────────────────────────────────────────
  await test("C2: flag ON + v82 MISSING ⇒ fail closed — 503, and nothing is published", async () => {
    schemaPresent = false;
    const { status, body } = await run();
    assert.equal(status, 503, `a missing evidence plane must refuse the run, got ${status}`);
    assert.equal(body.code, "v82_capability_missing", JSON.stringify(body));
    // The assertion that makes this more than a status check: the route must not
    // have silently fallen back to publishing WITHOUT the attempt ledger. That
    // fallback is the evidence-less mode — retries with no cap, notices with no
    // de-duplication — and it is what fail-closed exists to prevent.
    assert.equal(publishPinCalls, 0, "fail closed means no provider call happened at all");
    assert.equal(draft.publish_claimed_at, null, "and no row was even claimed");
    assert.equal(ledger.length, 0);
  });

  // ── C3 ─────────────────────────────────────────────────────────────────────
  await test("C3: flag ON + v82 PRESENT ⇒ all six objects probed, then the run proceeds", async () => {
    const { status, body } = await run();
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.published, 1);
    const probes = new Set(capabilityProbes);
    for (const t of ["table:scheduled_publish_attempts", "table:publish_reconcile_checks"]) {
      assert.ok(probes.has(t), `expected a probe for ${t}, saw ${JSON.stringify([...probes])}`);
    }
    for (const r of V82_RPCS) {
      assert.ok(probes.has(`rpc:${r}`), `expected a probe for rpc:${r}`);
    }
    assert.equal(probes.size, 6, `exactly six objects, saw ${JSON.stringify([...probes])}`);
  });

  // ── C4 ─────────────────────────────────────────────────────────────────────
  await test("C4: a proven schema is probed ONCE per process, not once per tick", async () => {
    await run();
    const first = capabilityProbes.length;
    assert.equal(first, 6);
    draft = baseDraft();
    await run();
    assert.equal(capabilityProbes.length, first,
      "a confirmed-present schema cannot become absent — re-probing every tick is pure cost");
  });

  // ── C5 ─────────────────────────────────────────────────────────────────────
  await test("C5: a FAILED check is never cached — applying the migration unblocks the next tick", async () => {
    schemaPresent = false;
    assert.equal((await run()).status, 503);
    // The operator applies v82. Without a redeploy, the very next tick must work:
    // caching the failure would turn a five-minute incident into one that lasts
    // until somebody notices and redeploys.
    schemaPresent = true;
    draft = baseDraft();
    const second = await run();
    assert.equal(second.status, 200, "the tick after the migration lands must proceed");
    assert.equal(second.body.published, 1);
  });

  // ── P15 (task 5's half) ────────────────────────────────────────────────────
  await test("P15: two workers reach the same fifth attempt — one CAS grant, one notice", async () => {
    publishPinBehaviour = async () => { throw serverError(PinterestApiError); };
    for (let round = 1; round <= 5; round++) { await run(); advancePastBackoff(); }

    const terminal = ledger.filter(r => r.final_failure_at);
    assert.equal(terminal.length, 1, `exactly one terminal row, saw ${terminal.length}`);
    assert.equal(terminal[0].attempt, 5);
    assert.equal(noticeClaims.length, 1, `the terminal round claims the notice once, saw ${noticeClaims.length}`);
    assert.equal(noticeClaims[0].granted, true, "and wins it");
    assert.equal(failedEvents.length, 1, `exactly one customer failure event, saw ${failedEvents.length}`);
    assert.ok(terminal[0].terminal_notified_at, "the CAS stamped the row");

    // ── The concurrency the CAS exists for ──────────────────────────────────
    // A second worker arrives at the SAME already-terminal destination: an
    // overrunning tick, a stale ten-minute claim, a manual invocation. It is put
    // back into the due scan the way a re-claim would, and runs the round again.
    // Driven through the REAL route, not by calling the CAS helper directly: what
    // is being tested is that the route consults it on this path at all. It very
    // nearly did not — `retryFork` returns early for a destination already carrying
    // `final_failure_at`, which is the exact path a second worker takes, and the
    // first version of this wiring skipped the CAS there and sent a second notice.
    const noticesBefore = failedEvents.length;
    draft.scheduled_at = DUE_AT;
    draft.publish_claimed_at = null;
    draft.publish_next_attempt_at = null;
    await run();
    assert.equal(noticeClaims.length, 2, "the second worker asks the CAS too");
    assert.equal(noticeClaims[1].granted, false, "and is REFUSED — the row is already stamped");
    assert.equal(noticeClaims.filter(c => c.granted).length, 1,
      "exactly one grant across both workers — that is the whole guarantee");
    assert.equal(failedEvents.length, noticesBefore,
      "and the merchant was not told twice that the same post failed");
    assert.equal(ledger.filter(r => r.final_failure_at).length, 1,
      "still exactly one terminal row — the second worker consumed no attempt");
    console.log(`        P15 evidence: grants=${noticeClaims.filter(c => c.granted).length}`
      + ` claims=${noticeClaims.length} notices=${failedEvents.length}`);
  });

  // ── P15b ───────────────────────────────────────────────────────────────────
  await test("P15b: a route round that LOSES the CAS sends no notice", async () => {
    publishPinBehaviour = async () => { throw serverError(PinterestApiError); };
    for (let round = 1; round <= 4; round++) { await run(); advancePastBackoff(); }
    assert.equal(failedEvents.length, 0, "rounds 1-4 stay silent");
    // Another worker got to the terminal notice first. Modelled the only way it can
    // be: the row is already stamped when this round's CAS asks.
    //
    // Pre-stamping the row REQUIRES pre-stamping `final_failure_at` too, because the
    // CAS only ever answers about a terminal row. Both are what the other worker's
    // fifth round would have written.
    const now = new Date().toISOString();
    ledger.push({
      id: randomUUID(), provider: "pinterest", social_connection_id: CONN, attempt: 5,
      retry_class: "retryable", next_attempt_at: null, reconcile_required_at: null,
      reconciled_at: null, final_failure_at: now, terminal_notified_at: now,
    });
    await run();
    assert.equal(failedEvents.length, 0,
      "the round that lost the CAS must not duplicate the notification");
    assert.ok(noticeClaims.length >= 1, "it did ask");
    assert.equal(noticeClaims.every(c => !c.granted), true, "and was refused every time");
    console.log(`        P15b evidence: claims=${noticeClaims.length}`
      + ` grants=${noticeClaims.filter(c => c.granted).length} notices=${failedEvents.length}`);
  });

  // ── C6 ─────────────────────────────────────────────────────────────────────
  await test("C6: a non-terminal failure keeps today's behaviour — no CAS, notice sent", async () => {
    // `blocked_user`: a real failure the merchant must act on. It does not end a
    // five-attempt lifecycle, has no `final_failure_at` row, and must not be routed
    // through a de-duplicator that has nothing to de-duplicate against.
    const { NotConnectedError } = await import("../src/lib/server/pinterest/service");
    publishPinBehaviour = async () => { throw new NotConnectedError("pinterest"); };
    await run();
    assert.equal(noticeClaims.length, 0, "a blocked_user round must not touch the CAS");
    assert.ok(failedEvents.length >= 1, "and the merchant IS told — an expired token needs their action");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
