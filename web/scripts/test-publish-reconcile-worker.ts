/**
 * test-publish-reconcile-worker.ts — the v82 reconciliation pass at the real
 * route boundary (发布可靠性 P0 技术设计 v0.1 §8.3: P18, P19, P20, P28).
 *
 * Loads the ACTUAL `/api/cron/publish-due` GET handler and fakes only the
 * Supabase and provider boundaries, exactly like test-publish-retry-worker.ts.
 * Touches no database and makes no network call.
 *
 * ── WHAT EVERY CASE HERE IS REALLY ASSERTING ────────────────────────────────
 * One number: how many times a Pin was CREATED. Reconciliation exists because
 * a delivery whose outcome is unknown must not be re-sent on a guess, and the
 * only way to be wrong about that is to send a second time. So each exit gets
 * an explicit `publishPinCalls` assertion, and the counts are not incidental:
 *
 *   P18  found on Pinterest      ⇒ createPin == 1   (never a second send)
 *   P19  404, proven absent      ⇒ createPin == 2   (exactly one re-send,
 *                                                    and only AFTER the verdict)
 *   P20  ambiguous / errored     ⇒ createPin == 1   (forever)
 *   P28  still unknown, N ticks  ⇒ createPin == 1   (forever)
 *
 * A test that only checked the final state would pass against an implementation
 * that re-sent and then recorded the second Pin as the first. Counting the
 * provider calls is the only assertion that cannot be satisfied that way.
 *
 * ── WHY THE FAKE IMPLEMENTS RPC SEMANTICS ───────────────────────────────────
 * Same reason as the sibling file. `publish_reconcile_record_v82` stamps
 * `reconciled_at` on the attempt row for every outcome EXCEPT `still_unknown`,
 * and the route reads that back: it is what `hasOpenReconciliation` consults to
 * decide whether to keep holding the schedule. A record-only fake would make
 * P28 vacuous — it would pass whether or not the pass correctly leaves the
 * reconciliation open.
 *
 * ── TIME ────────────────────────────────────────────────────────────────────
 * `Date.now` is not mocked. Simulated elapsed time is produced by REWINDING
 * stored timestamps into the past, which is what real elapsed time would
 * produce, and avoids a global mock leaking between cases.
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
const DRAFT = "pd_reconcile_1";
const CONN = "conn-pin-1";
const BOARD = "b1";
const DUE_AT = "2026-09-01T09:00:00.000Z";
const DEST_KEY = `pinterest:${CONN}`;

let passed = 0, failed = 0;

// ── Fake state ────────────────────────────────────────────────────────────────

type AttemptRecord = {
  owner_user_id: string;
  draft_id: string;
  scheduled_at: string;
  provider: string;
  social_connection_id: string | null;
  attempt: number;
  retry_class: string;
  next_attempt_at: string | null;
  reconcile_required_at: string | null;
  reconciled_at: string | null;
  final_failure_at: string | null;
  last_media_id: string | null;
  created_at: string;
};

type CheckRecord = {
  id: string;
  owner_user_id: string;
  draft_id: string;
  scheduled_at: string;
  provider: string;
  attempt: number;
  outcome: string;
  remote_id: string | null;
  checked_at: string;
  /** The parent intent's DB id — null for images, required for a redeemable video proof. */
  publish_intent_id: string | null;
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
let checks: CheckRecord[] = [];
let publishPinCalls = 0;
let errorLogs: string[] = [];

/** Every provider read the reconcile pass performed, in order. */
let probeCalls: string[] = [];
/**
 * The pin id stored in v81 evidence for this destination, if any.
 *
 * Set per case, and served through the `pinterest_publish_evidence` read rather
 * than the draft payload — because that is where the real pass takes it from,
 * and the reason matters: a pin id read from the owner-writable payload could
 * be CHOSEN by the merchant, and a chosen id that 404s would mint a
 * `confirmed_absent` verdict, i.e. a self-service duplicate-Pin button.
 */
let evidencePinId: string | null = null;
/**
 * The v76 intent ledger rows for this draft, as the video lineage writes them.
 *
 * Empty by default: an IMAGE destination has no intent ledger row at all, which
 * is the state every pre-existing case in this file runs in. Only the video
 * cases populate it, so "images keep passing null" is tested by every other
 * case here rather than asserted once.
 */
let intentDestinations: Array<{
  publish_intent_id: string;
  destination_id: string;
  status: string;
  updated_at: string;
  publish_intents: { id: string; user_id: string; draft_id: string };
}> = [];
/** What the fake Pinterest client answers. Set per case. */
let getPinBehaviour: (id: string) => Promise<unknown> = async () => null;
let listBoardPinsBehaviour: (id: string) => Promise<unknown> = async () => ({ items: [], bookmark: null });
let getMediaStatusBehaviour: (id: string) => Promise<unknown> = async () => null;

let publishPinBehaviour: () => Promise<unknown> = async () => ({
  ok: true, pin: { id: "p-new", url: "https://pin/new" }, board: { id: BOARD, name: "B" },
  environment: "production", connectionId: CONN,
});

function baseDraft(): DraftRow {
  return {
    vibepin_user_id: OWNER, draft_id: DRAFT,
    payload: {
      boardId: BOARD, imageUrl: "https://example.com/a.png", targetConnectionId: CONN,
      title: "Autumn table",
      destinationUrl: "https://shop.example.com/autumn",
      scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: CONN, boardId: BOARD, capturedAt: DUE_AT },
      ],
      // The state a delivery_unknown round leaves behind.
      destinationResults: [{
        destinationId: DEST_KEY, provider: "pinterest", socialConnectionId: CONN,
        status: "delivery_unknown", submittedAt: DUE_AT,
        errorMessage: "Checking with Pinterest whether this went out.",
      }],
    },
    scheduled_at: DUE_AT, updated_at: "2026-09-01T09:05:00.000Z",
    publish_claimed_at: null, publish_next_attempt_at: null,
    deleted_at: null, archived_at: null,
  };
}

/** The attempt row a `reconciliation_required` round writes. */
function openReconciliation(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    owner_user_id: OWNER, draft_id: DRAFT, scheduled_at: DUE_AT,
    provider: "pinterest", social_connection_id: CONN,
    attempt: 1, retry_class: "reconciliation_required",
    next_attempt_at: null,
    reconcile_required_at: "2026-09-01T09:05:00.000Z",
    reconciled_at: null, final_failure_at: null,
    last_media_id: null,
    created_at: "2026-09-01T09:05:00.000Z",
    ...overrides,
  };
}

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
      not: (k: string) => { filters.push(["not_is_null", k, null]); return b; },
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => {
        // The reconcile pass reads the draft through `.maybeSingle()`; so does
        // the persist layer. Both must see the CAS filters honoured, or a write
        // conditional on a stale `updated_at` would apply anyway and the CAS
        // this feature relies on would be untested.
        const ok = matchesDraft(filters);
        if (update && ok) Object.assign(draft, update);
        return Promise.resolve({ data: ok ? { ...draft } : null, error: null });
      },
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
   * A row builder that honours `.eq()` and `.order()`, including the embedded
   * `publish_intents.<col>` form PostgREST uses for a filtered inner join.
   */
  function filteringRowsBuilder(rows: () => Array<Record<string, unknown>>) {
    const eqs: Array<[string, unknown]> = [];
    let orderKey: string | null = null;
    let ascending = true;
    const apply = () => {
      let out = rows().filter(row => eqs.every(([key, value]) => {
        const [head, tail] = key.includes(".") ? key.split(".") : [key, null];
        const target = tail
          ? (row[head] as Record<string, unknown> | undefined)?.[tail]
          : row[head];
        return target === value;
      }));
      if (orderKey) {
        const k = orderKey;
        out = [...out].sort((a, b2) => {
          const x = String(a[k] ?? ""); const y = String(b2[k] ?? "");
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      return out;
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => { eqs.push([k, v]); return b; },
      is: () => b, lte: () => b, not: () => b, or: () => b, limit: () => b,
      order: (k: string, opts?: { ascending?: boolean }) => {
        orderKey = k; ascending = opts?.ascending !== false; return b;
      },
      maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
    };
    return b;
  }

  function rowsBuilder(rows: () => unknown[]) {
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b, is: () => b, lte: () => b, not: () => b,
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: (rows()[0] as unknown) ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "scheduled_publish_attempts") {
        return rowsBuilder(() => ledger.map(r => ({ ...r })));
      }
      if (table === "publish_reconcile_checks") {
        // Newest first, as the route's `.order(checked_at desc)` asks.
        return rowsBuilder(() => [...checks]
          .sort((a, b2) => (a.checked_at < b2.checked_at ? 1 : -1))
          .map(r => ({ ...r })));
      }
      if (table === "pinterest_publish_evidence") {
        return rowsBuilder(() => (evidencePinId
          ? [{ evidence: { pinId: evidencePinId } }]
          : []));
      }
      if (table === "publish_intent_destinations") {
        // ★ Filters are APPLIED here, unlike the other row builders. The whole
        // point of the lookup under test is that it narrows to the intent
        // holding THIS destination at delivery_unknown — a builder that ignored
        // `.eq()` would return the first row whatever was asked for, and the
        // scoping (one draft, several intents) would go untested.
        return filteringRowsBuilder(() => intentDestinations.map(r => ({ ...r })));
      }
      return draftBuilder();
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "scheduled_publish_attempt_record_v82") {
        const provider = String(args.p_provider);
        const conn = args.p_connection_id === null ? null : String(args.p_connection_id);
        const attempt = Number(args.p_attempt);
        const next = args.p_next_attempt_at === null ? null : String(args.p_next_attempt_at);
        const reconcile = args.p_reconcile_required_at === null ? null : String(args.p_reconcile_required_at);
        if (attempt < 1 || attempt > 5) {
          return { data: null, error: { message: "v82_attempt_cap_exceeded", code: "23514" } };
        }
        const existing = ledger.find(r =>
          r.provider === provider && r.social_connection_id === conn && r.attempt === attempt);
        const isFinal = attempt === 5 && next === null
          && ["retryable", "reconciliation_required"].includes(String(args.p_retry_class));
        if (existing) {
          existing.retry_class = String(args.p_retry_class);
          existing.next_attempt_at = next;
          existing.reconcile_required_at = existing.reconcile_required_at ?? reconcile;
          if (isFinal && !existing.final_failure_at) existing.final_failure_at = new Date().toISOString();
        } else {
          ledger.push(openReconciliation({
            provider, social_connection_id: conn, attempt,
            retry_class: String(args.p_retry_class),
            next_attempt_at: next, reconcile_required_at: reconcile,
            final_failure_at: isFinal ? new Date().toISOString() : null,
            created_at: new Date().toISOString(),
          }));
        }
        return { data: {}, error: null };
      }
      if (fn === "publish_reconcile_record_v82") {
        const outcome = String(args.p_outcome);
        const id = `chk-${checks.length + 1}`;
        checks.push({
          id, owner_user_id: String(args.p_user_id), draft_id: String(args.p_draft_id),
          scheduled_at: String(args.p_scheduled_at), provider: String(args.p_provider),
          attempt: Number(args.p_attempt), outcome,
          remote_id: args.p_remote_id === null ? null : String(args.p_remote_id),
          checked_at: new Date().toISOString(),
          publish_intent_id: typeof args.p_intent_row_id === "string" && args.p_intent_row_id
            ? args.p_intent_row_id
            : null,
        });
        // ★ The migration's own semantics (§2.2 E): the attempt row's
        // reconciliation is closed for every outcome EXCEPT still_unknown, which
        // stays pending on purpose so the schedule keeps being held and the
        // question is asked again. P28 is vacuous without this.
        if (outcome !== "still_unknown") {
          for (const row of ledger) {
            if (row.owner_user_id === args.p_user_id && row.draft_id === args.p_draft_id
              && row.scheduled_at === args.p_scheduled_at && row.provider === args.p_provider
              && row.attempt === Number(args.p_attempt)) {
              row.reconciled_at = new Date().toISOString();
            }
          }
        }
        return { data: { id, outcome }, error: null };
      }
      if (fn === "usage_consume_scheduled_post") return { data: { ok: true, replayed: false }, error: null };
      return { data: { ok: true }, error: null };
    },
  };
}

// ── Module interception ───────────────────────────────────────────────────────
//
// `service.ts` is deliberately NOT stubbed: the route and the tests both rely on
// `PinterestApiError` CLASS IDENTITY (`err instanceof PinterestApiError`), and a
// replacement module would create a second class that fails every instanceof.
// The provider surface is injected into the reconcile pass instead, by
// intercepting the pass module and pre-binding a fake probe factory.

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
    return { ...real, recordPublishEvent: async () => {}, recordFailedPublishEvent: async () => {} };
  }
  if (request.endsWith("/social/publishFanout")) {
    const real = origLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, createPublishJob: async () => null, recordOutcomes: async () => {}, fanOutDestinations: async () => [] };
  }
  // Wrap the reconcile pass so the route's call gets a fake provider client.
  // The REAL pass runs — only the three GETs are faked.
  if (request.endsWith("/publish-due/reconcilePass") || request === "./reconcilePass") {
    const real = origLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const realRun = real.runReconcilePass as (...a: unknown[]) => unknown;
    return {
      ...real,
      runReconcilePass: (db: unknown, io: unknown, options: Record<string, unknown>) =>
        realRun(db, io, {
          ...options,
          probeFactory: async () => ({
            getPin: async (id: string) => { probeCalls.push(`getPin:${id}`); return getPinBehaviour(id); },
            getMediaStatus: async (id: string) => { probeCalls.push(`getMediaStatus:${id}`); return getMediaStatusBehaviour(id); },
            listBoardPins: async (id: string) => { probeCalls.push(`listBoardPins:${id}`); return listBoardPinsBehaviour(id); },
          }),
        }),
    };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

function cronReq(): Request {
  return {
    url: "https://app.example.com/api/cron/publish-due",
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer test-cron-secret" : null) },
  } as unknown as Request;
}

type RunBody = {
  claimed: number; published: number; failed: number; skipped: number; deferred: number;
  reconciled?: {
    examined: number; confirmedPublished: number; confirmedAbsent: number;
    stillUnknown: number; deferred: number;
  };
};

const origError = console.error;

async function test(name: string, fn: () => Promise<void>) {
  draft = baseDraft();
  ledger = [openReconciliation()];
  checks = [];
  publishPinCalls = 0;
  probeCalls = [];
  errorLogs = [];
  evidencePinId = null;
  intentDestinations = [];
  getPinBehaviour = async () => null;
  listBoardPinsBehaviour = async () => ({ items: [], bookmark: null });
  getMediaStatusBehaviour = async () => null;
  publishPinBehaviour = async () => ({
    ok: true, pin: { id: "p-new", url: "https://pin/new" }, board: { id: BOARD, name: "B" },
    environment: "production", connectionId: CONN,
  });
  process.env.PUBLISH_RETRY_WORKER_ENABLED = "true";
  console.error = (...args: unknown[]) => { errorLogs.push(args.map(String).join(" ")); };
  try { await fn(); console.error = origError; console.log(`  PASS  ${name}`); passed++; }
  catch (e) {
    console.error = origError;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack ?? (e as Error).message}`);
    failed++;
  }
  finally { console.error = origError; delete process.env.PUBLISH_RETRY_WORKER_ENABLED; }
}

function resultRows(): Array<Record<string, unknown>> {
  return Array.isArray(draft.payload.destinationResults)
    ? (draft.payload.destinationResults as Array<Record<string, unknown>>)
    : [];
}

(async () => {
  console.log("=== cron/publish-due — v82 reconciliation (route-level, no database) ===\n");

  const { GET } = await import("../src/app/api/cron/publish-due/route") as { GET: (r: Request) => Promise<Response> };
  const run = async (): Promise<RunBody> => (await GET(cronReq())).json() as Promise<RunBody>;

  // ── P18 ────────────────────────────────────────────────────────────────────
  await test("P18: reconcile finds the Pin → published, createPin stays 1", async () => {
    getPinBehaviour = async () => ({
      id: "pin-777", boardId: BOARD, url: "https://www.pinterest.com/pin/777/",
      title: "Autumn table", link: "https://shop.example.com/autumn",
      createdAt: "2026-09-01T09:04:00.000Z",
    });
    // The anchor the provider gave us before the answer was lost. It lives in
    // v81 evidence (service-role), never in the client-writable payload.
    evidencePinId = "pin-777";

    const body = await run();
    assert.equal(body.reconciled?.confirmedPublished, 1, "the verdict is confirmed_published");
    assert.equal(
      publishPinCalls, 0,
      `reconciliation must never create a Pin, saw ${publishPinCalls} create call(s)`,
    );
    const row = resultRows().find(r => r.destinationId === DEST_KEY);
    assert.equal(row?.status, "published", "the stored row now says published");
    assert.equal(row?.remoteId, "pin-777", "carrying the real remote id");
    assert.equal(row?.postUrl, "https://www.pinterest.com/pin/777/", "and the permalink");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].outcome, "confirmed_published");
    assert.ok(ledger[0].reconciled_at, "the reconciliation is closed");

    // The whole point: a later tick must not send it again.
    advancePastBackoff();
    const before = publishPinCalls;
    await run();
    assert.equal(
      publishPinCalls, before,
      `a destination confirmed published must never be sent again, saw ${publishPinCalls}`,
    );
    console.log(`        P18 evidence: createPin during+after reconcile=${publishPinCalls} (the original send is not counted here — this harness starts from the delivery_unknown state it left), probes=${JSON.stringify(probeCalls)}`);
  });

  // ── P19 ────────────────────────────────────────────────────────────────────
  await test("P19: reconcile 404 → absent → back to pending → re-sent once (createPin==2)", async () => {
    evidencePinId = "pin-404";
    getPinBehaviour = async () => null; // a clean 404 from the user's own token

    const body = await run();
    assert.equal(body.reconciled?.confirmedAbsent, 1, "the verdict is confirmed_absent");
    // ★ ORDERING: the re-send must come AFTER the verdict, never in the same
    // breath. Stage 0 only removes the stored row; stage 1 of a LATER tick is
    // what publishes. Asserting the count here proves stage 0 itself sent
    // nothing — a final count of 2 alone could also be produced by a stage 0
    // that published directly.
    assert.equal(
      publishPinCalls, 0,
      `stage 0 must not publish; the verdict only re-opens the destination. saw ${publishPinCalls}`,
    );
    assert.equal(
      resultRows().find(r => r.destinationId === DEST_KEY), undefined,
      "the delivery_unknown row is REMOVED — a pending row would be filtered out by "
      + "outcomeRows and the destination would stay closed forever",
    );
    assert.equal(draft.scheduled_at, DUE_AT, "and the row is still due");
    assert.equal(checks[0].outcome, "confirmed_absent");
    assert.ok(ledger[0].reconciled_at, "the reconciliation is closed");
    assert.ok(ledger[0].next_attempt_at, "a retry is scheduled");
    assert.equal(ledger[0].attempt, 1, "on the SAME attempt number — this round sent nothing");

    // The next tick, once the backoff has elapsed, re-sends exactly once.
    advancePastBackoff();
    const second = await run();
    assert.equal(second.published, 1, "the Pin reconciliation proved absent is published");
    assert.equal(
      publishPinCalls, 1,
      `exactly one re-send across the whole chain, saw ${publishPinCalls}`,
    );
    assert.equal(resultRows().find(r => r.destinationId === DEST_KEY)?.status, "published");
    console.log(`        P19 evidence: createPin=${publishPinCalls} — 0 during the verdict tick, exactly 1 on the tick after. With the original send that is the design's "createPin == 2".`);
  });

  // ── P20 ────────────────────────────────────────────────────────────────────
  await test("P20: ambiguous/errored probe → still_unknown, payload untouched, createPin==1", async () => {
    // No pin anchor; the board listing returns two plausible matches. Which one
    // is ours is unknowable, and one of them may already be a duplicate.
    evidencePinId = null;
    listBoardPinsBehaviour = async () => ({
      items: [
        { id: "pin-a", boardId: BOARD, url: "https://pin/a", title: "Autumn table",
          link: "https://shop.example.com/autumn", createdAt: "2026-09-01T09:04:00.000Z" },
        { id: "pin-b", boardId: BOARD, url: "https://pin/b", title: "Autumn table",
          link: "https://shop.example.com/autumn", createdAt: "2026-09-01T09:06:00.000Z" },
      ],
      bookmark: null,
    });
    const resultsBefore = JSON.parse(JSON.stringify(resultRows()));
    const { destinationResults: _drop, ...restBefore } = draft.payload as Record<string, unknown>;
    void _drop;
    const contentBefore = JSON.parse(JSON.stringify(
      Object.fromEntries(Object.entries(restBefore).filter(([k]) => k !== "updatedAt"))));

    const body = await run();
    assert.equal(body.reconciled?.stillUnknown, 1, "the verdict is still_unknown");
    assert.equal(publishPinCalls, 0, `nothing may be sent, saw ${publishPinCalls}`);
    // ★ "payload 一字不改" — the RESULT rows and the content, which is what the
    // merchant sees and what every downstream decision reads.
    //
    // ── WHY `updatedAt` IS EXCLUDED, AND WHY THAT IS NOT A WEAKENING ─────────
    // Proven by isolation (scripts/tmp probe, recorded in the task report):
    // stage 0 performs ZERO writes on this path — `runReconcilePass` driven
    // directly against a recording IO makes no update call at all and leaves the
    // payload byte-identical. The `updatedAt` bump observed here is stage 1's:
    // the row is still due, so it is claimed, owes nothing (delivery_unknown
    // counts as closed), and takes the §3.4(b) hold-exit — the persist that
    // EXISTS to keep `scheduled_at` alive while a reconciliation is open. That
    // write is task 3's, is asserted by P27, and is required: without it the
    // schedule is cleared and the row becomes invisible forever.
    // Asserting "no byte anywhere changed" would therefore be asserting that
    // §3.4(b) does not work.
    assert.deepEqual(
      resultRows(), resultsBefore,
      "still_unknown must not touch the stored result rows — not the status, "
      + "not the message, nothing the merchant is shown",
    );
    const { destinationResults: _drop2, ...restAfter } = draft.payload as Record<string, unknown>;
    void _drop2;
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        Object.fromEntries(Object.entries(restAfter).filter(([k]) => k !== "updatedAt")))),
      contentBefore,
      "nor any other content field",
    );
    assert.equal(draft.scheduled_at, DUE_AT, "the schedule is held");
    assert.equal(checks[0].outcome, "still_unknown");
    assert.equal(
      ledger[0].reconciled_at, null,
      "the reconciliation stays OPEN — that is what keeps holding the schedule",
    );
    // The alarm (design §10: console.error is P0's channel).
    const alarm = errorLogs.find(l => l.includes("still_unknown"));
    assert.ok(alarm, `an alarm must be raised, saw: ${JSON.stringify(errorLogs)}`);
    assert.ok(alarm.includes(DRAFT), "naming the draft");
    assert.ok(alarm.includes("ambiguous"), `and the reason, saw: ${alarm}`);

    // And a second tick changes nothing, including the count.
    draft.publish_claimed_at = null;
    await run();
    assert.equal(publishPinCalls, 0, "still nothing sent on the next tick");
    console.log(`        P20 evidence: createPin=${publishPinCalls} result rows byte-identical, alarm raised`);
  });

  // ── P20c: stage 0 itself performs ZERO writes on still_unknown ─────────────
  //
  // The sharper form of P20's claim, driven against `runReconcilePass` directly
  // so stage 1 cannot be mistaken for it. P20 has to tolerate stage 1's §3.4(b)
  // hold-persist (which is required, and which P27 asserts); this case does not,
  // because nothing but the pass runs. If stage 0 ever grows a pin_drafts write
  // on the unknown path, this goes red and P20 stays green — which is exactly
  // why both exist.
  await test("P20c: the reconcile pass makes no pin_drafts write at all when unknown", async () => {
    const { runReconcilePass } = await import("../src/app/api/cron/publish-due/reconcilePass");
    const writes: string[] = [];
    const payloadBefore = JSON.stringify(draft.payload);
    const io = {
      read: async () => ({
        snapshot: {
          payload: draft.payload, scheduled_at: draft.scheduled_at,
          publish_claimed_at: null, updated_at: draft.updated_at,
        },
        error: null,
      }),
      update: async (_ref: unknown, values: Record<string, unknown>) => {
        writes.push(JSON.stringify(Object.keys(values)));
        return { error: null, matched: true };
      },
    };
    const result = await runReconcilePass(fakeSupabaseClient() as never, io as never, {
      startedMs: Date.now(),
      probeFactory: async () => ({
        getPin: async () => null,
        getMediaStatus: async () => null,
        // Truncated listing: zero matches is NOT proof of absence.
        listBoardPins: async () => ({ items: [], bookmark: "page-2" }),
      }),
    });
    assert.equal(result.stillUnknown, 1, "the verdict is still_unknown");
    assert.deepEqual(
      writes, [],
      `stage 0 must not write to pin_drafts on an unknown verdict, saw ${JSON.stringify(writes)}. `
      + `Any write bumps payload.updatedAt — the field the browser's LWW merge compares — so a `
      + `pass that touched the row would push a re-sync to every connected client every tick.`,
    );
    assert.equal(JSON.stringify(draft.payload), payloadBefore, "and the payload is byte-identical");
    console.log(`        P20c evidence: stage-0 writes=${writes.length}, payload byte-identical`);
  });

  // ── P18b: a Pin on the WRONG board is not this destination's publish ───────
  //
  // Found by mutation: deleting the board check left every case green, which
  // means nothing was testing it. The anchor can be stale (a recycled id, an
  // evidence row belonging to a different attempt), and a 200 on a stale id
  // would otherwise be recorded as THIS Content's publish — attaching a
  // stranger's permalink to the merchant's Pin and closing the destination so
  // the real publish never happens.
  await test("P18b: a Pin found on a DIFFERENT board is still_unknown, not published", async () => {
    evidencePinId = "pin-stale";
    getPinBehaviour = async () => ({
      id: "pin-stale", boardId: "some-other-board", url: "https://pin/stale",
      title: "Something else", link: null, createdAt: "2026-09-01T09:04:00.000Z",
    });

    const body = await run();
    assert.equal(
      body.reconciled?.confirmedPublished, 0,
      "a Pin on another board must NOT be recorded as this destination's publish",
    );
    assert.equal(body.reconciled?.stillUnknown, 1, "it is unknown — the anchor is stale");
    assert.equal(checks[0].outcome, "still_unknown");
    assert.ok(
      errorLogs.some(l => l.includes("pin_board_mismatch")),
      `the alarm must name the mismatch, saw: ${JSON.stringify(errorLogs)}`,
    );
    assert.equal(
      resultRows().find(r => r.destinationId === DEST_KEY)?.status, "delivery_unknown",
      "the stored row is untouched",
    );
    assert.equal(publishPinCalls, 0, "and nothing is sent");
  });

  // ── P20b: a timed-out probe is also still_unknown (never absent) ───────────
  await test("P20b: a probe that ERRORS is still_unknown, never confirmed_absent", async () => {
    evidencePinId = "pin-timeout";
    getPinBehaviour = async () => { throw new Error("socket hang up"); };
    // With the pin probe failing, the board listing is tried; make it fail too.
    listBoardPinsBehaviour = async () => { throw new Error("upstream 503"); };

    const body = await run();
    assert.equal(
      body.reconciled?.confirmedAbsent, 0,
      "a failed probe must NEVER be read as proof the Pin is absent — that is the "
      + "duplicate-Pin bug this whole feature exists to prevent",
    );
    assert.equal(body.reconciled?.stillUnknown, 1);
    assert.equal(publishPinCalls, 0);
    assert.equal(resultRows().find(r => r.destinationId === DEST_KEY)?.status, "delivery_unknown",
      "the stored row is untouched");
    assert.equal(ledger[0].reconciled_at, null, "and the question stays open");
  });

  // ── P28 ────────────────────────────────────────────────────────────────────
  await test("P28 (core): still_unknown across ticks — schedule held, createPin==1 forever", async () => {
    evidencePinId = null;
    // Nothing decisive: the listing is truncated, so zero matches is NOT proof
    // of absence (an unread page may hold the Pin).
    listBoardPinsBehaviour = async () => ({ items: [], bookmark: "page-2" });

    for (let tick = 1; tick <= 3; tick++) {
      draft.publish_claimed_at = null;
      const body = await run();
      assert.equal(body.reconciled?.stillUnknown, 1, `tick ${tick}: still unknown`);
      assert.equal(
        draft.scheduled_at, DUE_AT,
        `tick ${tick}: the schedule must survive — an open reconciliation holds it `
        + `(§3.4(b)), and losing it makes the row invisible to the due scan forever`,
      );
      assert.equal(
        resultRows().find(r => r.destinationId === DEST_KEY)?.status, "delivery_unknown",
        `tick ${tick}: the stored row is unchanged`,
      );
      assert.equal(
        ledger[0].reconciled_at, null,
        `tick ${tick}: the reconciliation stays pending, by design`,
      );
      assert.equal(
        publishPinCalls, 0,
        `tick ${tick}: an unknown delivery is NEVER re-sent, saw ${publishPinCalls}`,
      );
    }
    assert.equal(checks.length, 3, "one check row per tick — the age is auditable");
    assert.ok(
      errorLogs.filter(l => l.includes("still_unknown")).length >= 3,
      "and an alarm every tick",
    );
    console.log(`        P28 evidence: 3 ticks, createPin=${publishPinCalls}, scheduled_at held, checks=${checks.length}`);
  });

  // ── Flag off ───────────────────────────────────────────────────────────────
  await test("flag off: stage 0 does not run and no v82 object is named", async () => {
    delete process.env.PUBLISH_RETRY_WORKER_ENABLED;
    evidencePinId = "pin-777";
    getPinBehaviour = async () => { throw new Error("must not be probed"); };
    const body = await run();
    assert.equal(body.reconciled, undefined,
      "the response is byte-identical to the baseline's shape");
    assert.equal(probeCalls.length, 0, `no provider read at all, saw ${JSON.stringify(probeCalls)}`);
    assert.equal(checks.length, 0, "and nothing recorded");
  });

  // ── Terminal guard ─────────────────────────────────────────────────────────
  await test("confirmed_absent on a SPENT budget does not re-open the destination", async () => {
    // Attempt 5 already terminal: re-opening would be a sixth send.
    ledger = [openReconciliation({
      attempt: 5, final_failure_at: "2026-09-01T10:00:00.000Z",
    })];
    evidencePinId = "pin-404";
    getPinBehaviour = async () => null;

    const body = await run();
    assert.equal(body.reconciled?.confirmedAbsent, 1, "the verdict is still recorded");
    assert.equal(checks[0].outcome, "confirmed_absent", "knowing it never went out is worth storing");
    assert.equal(
      resultRows().find(r => r.destinationId === DEST_KEY)?.status, "delivery_unknown",
      "but the row is NOT re-opened — the five-attempt budget is spent",
    );
    advancePastBackoff();
    await run();
    assert.equal(publishPinCalls, 0, `and there is no sixth send, saw ${publishPinCalls}`);
  });

  // ── P29: the video proof must be REDEEMABLE, not merely recorded ───────────
  //
  // `publish_intent_confirm_prepare_v82` refuses unless
  // `v_parent.id = v_check.publish_intent_id` (migrate_v82:458). A check row
  // written with a null intent id is therefore proof nobody can ever spend: the
  // verdict is correct, the bookkeeping is correct, and the retry it authorizes
  // is unreachable forever. This asserts the id is on the row — the one thing
  // that distinguishes a usable proof from a decorative one.
  await test("P29: a video confirmed_absent check carries the parent intent's DB id", async () => {
    intentDestinations = [{
      publish_intent_id: "intent-row-video-1",
      destination_id: DEST_KEY,
      status: "delivery_unknown",
      updated_at: "2026-09-01T09:05:00.000Z",
      publish_intents: { id: "intent-row-video-1", user_id: OWNER, draft_id: DRAFT },
    }];
    evidencePinId = "pin-404";
    getPinBehaviour = async () => null;

    const body = await run();
    assert.equal(body.reconciled?.confirmedAbsent, 1, "the verdict is confirmed_absent");
    assert.equal(checks.length, 1, "exactly one check row");
    assert.equal(
      checks[0].publish_intent_id, "intent-row-video-1",
      `the check must carry the parent intent row id, saw ${String(checks[0].publish_intent_id)}`,
    );
    console.log(`        P29 evidence: publish_intent_id=${String(checks[0].publish_intent_id)} (was null before this fix → RPC would refuse with retry_not_allowed)`);
  });

  // ── P29b: the lookup is scoped, not "latest intent for this draft" ─────────
  //
  // One draft can carry several intents. Picking the most recent one would bind
  // the proof to an intent that never held this destination's unknown delivery,
  // and the RPC would then refuse at redemption — the same dead end as null,
  // but harder to see. The row that must win is the one holding THIS
  // destination at delivery_unknown, whatever its recency.
  await test("P29b: the intent lookup picks the destination's own unknown row, not the newest", async () => {
    intentDestinations = [
      {
        // Newer, but a different destination and already published — a
        // draft-only lookup would pick exactly this one and be wrong.
        publish_intent_id: "intent-row-other",
        destination_id: "pinterest:conn-pin-2",
        status: "published",
        updated_at: "2026-09-01T11:00:00.000Z",
        publish_intents: { id: "intent-row-other", user_id: OWNER, draft_id: DRAFT },
      },
      {
        publish_intent_id: "intent-row-correct",
        destination_id: DEST_KEY,
        status: "delivery_unknown",
        updated_at: "2026-09-01T09:05:00.000Z",
        publish_intents: { id: "intent-row-correct", user_id: OWNER, draft_id: DRAFT },
      },
    ];
    evidencePinId = "pin-404";
    getPinBehaviour = async () => null;

    await run();
    assert.equal(
      checks[0].publish_intent_id, "intent-row-correct",
      `scoped to the delivery_unknown destination, saw ${String(checks[0].publish_intent_id)}`,
    );
  });

  // ── P29c: images are unchanged ─────────────────────────────────────────────
  //
  // The image path has no intent ledger row. The lookup must find nothing and
  // pass null — exactly what was passed unconditionally before this fix — so
  // this change is provably inert for every image destination.
  await test("P29c: an image destination still records a null intent id", async () => {
    intentDestinations = [];
    evidencePinId = "pin-404";
    getPinBehaviour = async () => null;

    await run();
    assert.equal(checks.length, 1, "the verdict is still recorded");
    assert.equal(
      checks[0].publish_intent_id, null,
      `images have no intent row, so null is correct, saw ${String(checks[0].publish_intent_id)}`,
    );
    assert.equal(publishPinCalls, 0, "and no provider create happened during the verdict tick");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  (Module as unknown as { _load: unknown })._load = origLoad;
  process.exit(failed ? 1 : 0);
})();
