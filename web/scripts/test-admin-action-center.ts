/**
 * Unit tests for the admin Action Center derivation layer (adminActionCenter.ts).
 * Run: npx tsx scripts/test-admin-action-center.ts   (from web/)
 *
 * Covers each of the 5 blocker predicates (positive + negative), exact-vs-inferred
 * precedence (a failed publish EVENT beats a draft's publishError), health banding
 * (green/yellow/red + drivers), paid-first + age sort, and the pagination loop
 * (a source returning >1000 rows must NOT be truncated).
 */

import assert from "node:assert";
import { makeMockDb, makeHarness } from "./adminMockDb";
import {
  evaluateBlockers,
  computeHealth,
  getActionCenter,
  getUserBlockers,
  type BlockerType,
} from "../src/lib/server/adminActionCenter";
import { paginateRows } from "../src/lib/server/adminQueryUtils";

const { test, done } = makeHarness();

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

// ── Facts builder for the pure predicate tests ────────────────────────────────
// evaluateBlockers/computeHealth take an internal UserFacts. We construct it via a
// cast so the pure logic is testable without a DB.
type AnyFacts = Parameters<typeof evaluateBlockers>[0];

function facts(partial: {
  id?: string;
  createdAt?: string | null;
  publish?: Partial<AnyFacts["publish"]>;
  draft?: Partial<AnyFacts["draft"]>;
  conn?: Partial<AnyFacts["conn"]>;
  gen?: Partial<AnyFacts["gen"]>;
  lastSignIn?: string | null;
}): AnyFacts {
  return {
    user: { id: partial.id ?? "u1", email: "e@x.com", created_at: partial.createdAt ?? hoursAgo(1), last_sign_in_at: partial.lastSignIn ?? null },
    publish: { lastFailedAt: null, lastFailedCode: null, lastFailedDraftId: null, failedCountInWindow: 0, lastSucceededAt: null, firstSucceededAt: null, ...partial.publish },
    draft: { publishErrorDraftId: null, publishErrorCode: null, overdueDraftId: null, overdueScheduledAt: null, firstPostedAt: null, lastPostedAt: null, hasAnyDraft: false, lastDraftUpdatedAt: null, ...partial.draft },
    conn: { createdAt: null, needsReconnect: false, disconnectedAt: null, hasRow: false, ...partial.conn },
    gen: { lastFailedAt: null, lastSucceededAt: null, failedCountInWindow: 0, lastCreatedAt: null, totalCount: 0, ...partial.gen },
  } as AnyFacts;
}

const windowStart = hoursAgo(24);
const has = (types: BlockerType[], t: BlockerType) => types.includes(t);
const typesOf = (f: AnyFacts) => evaluateBlockers(f, windowStart).map(b => b.blockerType);

// ── 1. publish_failure ────────────────────────────────────────────────────────
test("publish_failure EXACT: failed in window, no later success", () => {
  const t = typesOf(facts({ publish: { lastFailedAt: hoursAgo(2), lastFailedCode: "board_not_owned", lastFailedDraftId: "d1", failedCountInWindow: 3 } }));
  assert.ok(has(t, "publish_failure"));
});
test("publish_failure NEGATIVE: a success AFTER the failure clears it", () => {
  const t = typesOf(facts({ publish: { lastFailedAt: hoursAgo(5), lastSucceededAt: hoursAgo(2) } }));
  assert.ok(!has(t, "publish_failure"));
});
test("publish_failure NEGATIVE: failure older than 24h window", () => {
  const t = typesOf(facts({ publish: { lastFailedAt: hoursAgo(30) } }));
  assert.ok(!has(t, "publish_failure"));
});
test("publish_failure EXACT beats INFERRED: dataQuality is 'exact' + code from event", () => {
  const items = evaluateBlockers(
    facts({ publish: { lastFailedAt: hoursAgo(2), lastFailedCode: "auth_expired", lastFailedDraftId: "d9", failedCountInWindow: 2 }, draft: { publishErrorDraftId: "dX", publishErrorCode: "content_error", lastDraftUpdatedAt: hoursAgo(1) } }),
    windowStart,
  ).filter(b => b.blockerType === "publish_failure");
  assert.equal(items.length, 1);
  assert.equal(items[0].dataQuality, "exact");
  assert.equal(items[0].evidence.publishErrorCode, "auth_expired");
  assert.equal(items[0].evidence.failedPublishCount, 2);
});
test("publish_failure INFERRED: draft publishError when no exact event", () => {
  const items = evaluateBlockers(
    facts({ draft: { publishErrorDraftId: "dX", publishErrorCode: "content_error", lastDraftUpdatedAt: hoursAgo(1) } }),
    windowStart,
  ).filter(b => b.blockerType === "publish_failure");
  assert.equal(items.length, 1);
  assert.equal(items[0].dataQuality, "inferred");
  assert.equal(items[0].evidence.draftId, "dX");
});
test("publish_failure INFERRED: overdue scheduled draft with no postedAt", () => {
  const items = evaluateBlockers(
    facts({ draft: { overdueDraftId: "dO", overdueScheduledAt: hoursAgo(3) } }),
    windowStart,
  ).filter(b => b.blockerType === "publish_failure");
  assert.equal(items.length, 1);
  assert.equal(items[0].dataQuality, "inferred");
});

// ── 2. pinterest_disconnected ─────────────────────────────────────────────────
test("pinterest_disconnected POSITIVE: disconnected_at set → reason 'disconnected'", () => {
  const items = evaluateBlockers(facts({ conn: { hasRow: true, disconnectedAt: hoursAgo(1), createdAt: hoursAgo(200) } }), windowStart)
    .filter(b => b.blockerType === "pinterest_disconnected");
  assert.equal(items[0].evidence.disconnectReason, "disconnected");
});
test("pinterest_disconnected POSITIVE: needs_reconnect → reason 'needs_reconnect'", () => {
  const items = evaluateBlockers(facts({ conn: { hasRow: true, needsReconnect: true, createdAt: hoursAgo(200) } }), windowStart)
    .filter(b => b.blockerType === "pinterest_disconnected");
  assert.equal(items[0].evidence.disconnectReason, "needs_reconnect");
});
test("pinterest_disconnected NEGATIVE: healthy connection", () => {
  const t = typesOf(facts({ conn: { hasRow: true, createdAt: hoursAgo(200) } }));
  assert.ok(!has(t, "pinterest_disconnected"));
});

// ── 3. generation_failures ────────────────────────────────────────────────────
test("generation_failures POSITIVE: ≥2 fails in window, no later success", () => {
  const t = typesOf(facts({ gen: { failedCountInWindow: 2, lastFailedAt: hoursAgo(1), totalCount: 5 } }));
  assert.ok(has(t, "generation_failures"));
});
test("generation_failures NEGATIVE: only 1 failure", () => {
  const t = typesOf(facts({ gen: { failedCountInWindow: 1, lastFailedAt: hoursAgo(1) } }));
  assert.ok(!has(t, "generation_failures"));
});
test("generation_failures NEGATIVE: success after last failure", () => {
  const t = typesOf(facts({ gen: { failedCountInWindow: 3, lastFailedAt: hoursAgo(4), lastSucceededAt: hoursAgo(1) } }));
  assert.ok(!has(t, "generation_failures"));
});

// ── 4. signup_not_connected ───────────────────────────────────────────────────
test("signup_not_connected POSITIVE: signup >48h ago, no connection row", () => {
  const t = typesOf(facts({ createdAt: hoursAgo(60), conn: { hasRow: false } }));
  assert.ok(has(t, "signup_not_connected"));
});
test("signup_not_connected NEGATIVE: signed up <48h ago", () => {
  const t = typesOf(facts({ createdAt: hoursAgo(10), conn: { hasRow: false } }));
  assert.ok(!has(t, "signup_not_connected"));
});
test("signup_not_connected NEGATIVE: has a connection row", () => {
  const t = typesOf(facts({ createdAt: hoursAgo(60), conn: { hasRow: true, createdAt: hoursAgo(50) } }));
  assert.ok(!has(t, "signup_not_connected"));
});

// ── 5. connected_not_creating ─────────────────────────────────────────────────
test("connected_not_creating POSITIVE: connected >72h, zero gen + zero drafts", () => {
  const t = typesOf(facts({ conn: { hasRow: true, createdAt: hoursAgo(80) }, gen: { totalCount: 0 }, draft: { hasAnyDraft: false } }));
  assert.ok(has(t, "connected_not_creating"));
});
test("connected_not_creating NEGATIVE: has generations", () => {
  const t = typesOf(facts({ conn: { hasRow: true, createdAt: hoursAgo(80) }, gen: { totalCount: 4 } }));
  assert.ok(!has(t, "connected_not_creating"));
});
test("connected_not_creating NEGATIVE: has a draft", () => {
  const t = typesOf(facts({ conn: { hasRow: true, createdAt: hoursAgo(80) }, draft: { hasAnyDraft: true } }));
  assert.ok(!has(t, "connected_not_creating"));
});

// ── health banding ────────────────────────────────────────────────────────────
test("health GREEN: all four signals true", () => {
  const f = facts({ lastSignIn: hoursAgo(1), conn: { hasRow: true, createdAt: hoursAgo(200) }, publish: { lastSucceededAt: hoursAgo(2) } });
  const h = computeHealth(f, []);
  assert.equal(h.band, "green");
  assert.deepEqual(h.drivers, []);
});
test("health YELLOW: exactly one signal false", () => {
  // active + publish + pinterest ok, but one open blocker → noOpenBlockers false.
  const f = facts({ lastSignIn: hoursAgo(1), conn: { hasRow: true, createdAt: hoursAgo(200) }, publish: { lastSucceededAt: hoursAgo(2) } });
  const h = computeHealth(f, [{ userId: "u1", email: null, blockerType: "publish_failure", firstSeenAt: null, dataQuality: "exact", evidence: {} }]);
  assert.equal(h.band, "yellow");
  assert.deepEqual(h.drivers, ["noOpenBlockers"]);
});
test("health RED: two or more signals false", () => {
  // no recent activity + no publish; pinterest ok, no blockers → 2 false.
  const f = facts({ lastSignIn: hoursAgo(24 * 20), conn: { hasRow: true, createdAt: hoursAgo(400) } });
  const h = computeHealth(f, []);
  assert.equal(h.band, "red");
  assert.ok(h.drivers.includes("activeLast7d"));
  assert.ok(h.drivers.includes("publishedLast14d"));
});

// ── pagination: a >1000-row source must NOT truncate ──────────────────────────
test("pagination: paginateRows fetches ALL rows across .range() windows (>1000)", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ user_id: `u${i}`, created_at: hoursAgo(i % 100), status: "completed" }));
  const { db } = makeMockDb({ pin_generations: { rows } });
  const res = await paginateRows<{ user_id: string }>(db, "pin_generations", { columns: "user_id,created_at,status", orderColumn: "created_at", ascending: false });
  assert.equal(res.missing, false);
  assert.equal(res.rows.length, 2500, `expected all 2500 rows, got ${res.rows.length}`);
});

// ── end-to-end getActionCenter with the injected mock DB ──────────────────────
test("getActionCenter: paid users sort before free; both have signup_not_connected", async () => {
  const authUsers = [
    { id: "free1", email: "f@x.com", created_at: hoursAgo(100), last_sign_in_at: null, app_metadata: {}, user_metadata: {} },
    { id: "paid1", email: "p@x.com", created_at: hoursAgo(100), last_sign_in_at: null, app_metadata: { plan: "pro" }, user_metadata: {} },
  ];
  const { db } = makeMockDb(
    { analytics_events: { rows: [] }, pin_drafts: { rows: [] }, pinterest_connections: { rows: [] }, pin_generations: { rows: [] } },
    authUsers,
  );
  const res = await getActionCenter(db);
  assert.ok(res.available);
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].userId, "paid1", "paid user must lead");
  assert.ok(res.items.every(i => i.blockerType === "signup_not_connected"));
});

test("getActionCenter: EXACT publish_failure end-to-end (event beats postedAt)", async () => {
  const authUsers = [{ id: "u1", email: "e@x.com", created_at: hoursAgo(300), last_sign_in_at: hoursAgo(1), app_metadata: {}, user_metadata: {} }];
  const { db } = makeMockDb(
    {
      analytics_events: { rows: [
        { user_id: "u1", draft_id: "d1", event_name: "pinterest_publish_failed", payload: { errorCode: "board_not_owned" }, created_at: hoursAgo(2) },
      ] },
      // draft ALSO has a postedAt (would look published) — the failed event must win as a blocker.
      pin_drafts: { rows: [{ vibepin_user_id: "u1", draft_id: "d1", payload: { postedAt: hoursAgo(50) }, updated_at: hoursAgo(2), scheduled_at: null, deleted_at: null }] },
      pinterest_connections: { rows: [{ vibepin_user_id: "u1", needs_reconnect: false, disconnected_at: null, created_at: hoursAgo(300) }] },
      pin_generations: { rows: [] },
    },
    authUsers,
  );
  const res = await getActionCenter(db);
  const pf = res.items.find(i => i.blockerType === "publish_failure");
  assert.ok(pf, "expected a publish_failure item");
  assert.equal(pf!.dataQuality, "exact");
  assert.equal(pf!.evidence.publishErrorCode, "board_not_owned");
});

test("getActionCenter: unavailable when auth admin fails", async () => {
  const { db } = makeMockDb({}, [], { authError: true });
  const res = await getActionCenter(db);
  assert.equal(res.available, false);
  assert.equal(res.items.length, 0);
});

test("getActionCenter: analytics_events missing → inferred publish_failure from draft", async () => {
  const authUsers = [{ id: "u1", email: "e@x.com", created_at: hoursAgo(300), last_sign_in_at: hoursAgo(1), app_metadata: {}, user_metadata: {} }];
  const { db } = makeMockDb(
    {
      // analytics_events table absent (not in the spec map) → missing relation.
      pin_drafts: { rows: [{ vibepin_user_id: "u1", draft_id: "dERR", payload: { publishError: "boom", publishErrorCode: "content_error" }, updated_at: hoursAgo(1), scheduled_at: null, deleted_at: null }] },
      pinterest_connections: { rows: [{ vibepin_user_id: "u1", needs_reconnect: false, disconnected_at: null, created_at: hoursAgo(300) }] },
      pin_generations: { rows: [] },
    },
    authUsers,
  );
  const res = await getActionCenter(db);
  const pf = res.items.find(i => i.blockerType === "publish_failure");
  assert.ok(pf);
  assert.equal(pf!.dataQuality, "inferred");
  assert.equal(pf!.evidence.draftId, "dERR");
  assert.ok(res.warnings.some(w => /analytics_events/.test(w)));
});

test("getActionCenter: >1000 blocked users are all returned (no 1000 truncation)", async () => {
  const authUsers = Array.from({ length: 1500 }, (_, i) => ({
    id: `u${i}`, email: `u${i}@x.com`, created_at: hoursAgo(100), last_sign_in_at: null, app_metadata: {}, user_metadata: {},
  }));
  const { db } = makeMockDb(
    { analytics_events: { rows: [] }, pin_drafts: { rows: [] }, pinterest_connections: { rows: [] }, pin_generations: { rows: [] } },
    authUsers,
  );
  const res = await getActionCenter(db);
  assert.equal(res.items.length, 1500, `expected 1500 blocked users, got ${res.items.length}`);
});

test("getUserBlockers: shares predicate logic; returns health band", async () => {
  const authUsers = [{ id: "u1", email: "e@x.com", created_at: hoursAgo(300), last_sign_in_at: hoursAgo(1), app_metadata: {}, user_metadata: {} }];
  const { db } = makeMockDb(
    {
      analytics_events: { rows: [{ user_id: "u1", draft_id: null, event_name: "pinterest_publish_succeeded", payload: {}, created_at: hoursAgo(3) }] },
      pin_drafts: { rows: [] },
      pinterest_connections: { rows: [{ vibepin_user_id: "u1", needs_reconnect: false, disconnected_at: null, created_at: hoursAgo(300) }] },
      pin_generations: { rows: [{ user_id: "u1", created_at: hoursAgo(2), status: "completed" }] },
    },
    authUsers,
  );
  const res = await getUserBlockers("u1", db);
  assert.equal(res.userId, "u1");
  assert.equal(res.blockers.length, 0, "healthy user has no blockers");
  assert.equal(res.health.band, "green");
});

void done();
