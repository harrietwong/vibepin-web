/**
 * Unit tests for the admin Activation Funnel derivation layer.
 * Run: npx tsx scripts/test-activation-funnel.ts   (from web/)
 *
 * Covers milestone ordering / monotonic funnel roll-up, the stuck-per-stage count,
 * exact-beats-inferred publish sourcing + the repeat-within-7d rule, the exact/
 * inferred split, and an end-to-end run through the injected mock DB including a
 * >1000-user cohort (no truncation).
 */

import assert from "node:assert";
import { makeMockDb, makeHarness } from "./adminMockDb";
import {
  resolvePublishMilestones,
  buildMilestones,
  rollUp,
  getActivationFunnel,
  FUNNEL_STAGES,
} from "../src/lib/server/adminActivationFunnel";

const { test, done } = makeHarness();

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 3_600_000).toISOString();
const iso = (ms: number) => new Date(ms).toISOString();

// ── resolvePublishMilestones: exact-beats-inferred + repeat-within-7d ──────────
test("publish: EXACT events win over inferred postedAt", () => {
  const r = resolvePublishMilestones([daysAgo(5), daysAgo(3)], [daysAgo(10)]);
  assert.equal(r.firstPublishSource, "exact");
  assert.equal(r.firstPublish, daysAgo(5));
  assert.equal(r.repeatPublishSource, "exact");
});
test("publish: repeat requires a 2nd publish WITHIN 7 days of the first", () => {
  const first = NOW - 20 * 24 * 3_600_000;
  const within = first + 6 * 24 * 3_600_000;
  const beyond = first + 9 * 24 * 3_600_000;
  const ok = resolvePublishMilestones([iso(first), iso(within)], undefined);
  assert.equal(ok.repeatPublish, iso(within));
  const tooLate = resolvePublishMilestones([iso(first), iso(beyond)], undefined);
  assert.equal(tooLate.repeatPublish, null);
});
test("publish: INFERRED fallback when no exact events", () => {
  const r = resolvePublishMilestones(undefined, [daysAgo(4), daysAgo(2)]);
  assert.equal(r.firstPublishSource, "inferred");
  assert.equal(r.repeatPublishSource, "inferred");
});
test("publish: none → all null", () => {
  const r = resolvePublishMilestones(undefined, undefined);
  assert.equal(r.firstPublish, null);
  assert.equal(r.repeatPublish, null);
});

// ── rollUp: monotonic funnel + stuck counts + split ───────────────────────────
function m(overrides: Partial<ReturnType<typeof buildMilestones>>) {
  return { signup: daysAgo(10), pinterestConnected: null, firstGeneration: null, firstPublish: null, firstPublishSource: null, repeatPublish: null, repeatPublishSource: null, ...overrides } as ReturnType<typeof buildMilestones>;
}

test("rollUp: monotonic — a later milestone requires all prior ones", () => {
  // This user has firstGeneration but NO pinterestConnected → must NOT count as reached at firstGeneration.
  const { stages } = rollUp([m({ firstGeneration: daysAgo(2) })]);
  const byStage = Object.fromEntries(stages.map(s => [s.stage, s.reached]));
  assert.equal(byStage.signup, 1);
  assert.equal(byStage.pinterestConnected, 0);
  assert.equal(byStage.firstGeneration, 0, "broken chain must not reach firstGeneration");
});

test("rollUp: full-chain user reaches every stage", () => {
  const full = m({ pinterestConnected: daysAgo(9), firstGeneration: daysAgo(8), firstPublish: daysAgo(7), firstPublishSource: "exact", repeatPublish: daysAgo(6), repeatPublishSource: "exact" });
  const { stages } = rollUp([full]);
  for (const s of stages) assert.equal(s.reached, 1, `${s.stage} should be reached`);
});

test("rollUp: stuck-per-stage = reached here minus reached next", () => {
  const cohort = [
    m({}), // stuck at signup
    m({ pinterestConnected: daysAgo(9) }), // stuck at connected
    m({ pinterestConnected: daysAgo(9), firstGeneration: daysAgo(8) }), // stuck at generation
  ];
  const { stages } = rollUp(cohort);
  const byStage = Object.fromEntries(stages.map(s => [s.stage, s]));
  assert.equal(byStage.signup.reached, 3);
  assert.equal(byStage.signup.stuck, 1);
  assert.equal(byStage.pinterestConnected.reached, 2);
  assert.equal(byStage.pinterestConnected.stuck, 1);
  assert.equal(byStage.firstGeneration.reached, 1);
  assert.equal(byStage.firstGeneration.stuck, 1);
  assert.equal(byStage.firstPublish.reached, 0);
});

test("rollUp: exact/inferred split for the two publish stages", () => {
  const exactUser = m({ pinterestConnected: daysAgo(9), firstGeneration: daysAgo(8), firstPublish: daysAgo(7), firstPublishSource: "exact", repeatPublish: daysAgo(6), repeatPublishSource: "exact" });
  const inferredUser = m({ pinterestConnected: daysAgo(9), firstGeneration: daysAgo(8), firstPublish: daysAgo(7), firstPublishSource: "inferred" });
  const { publishSplit } = rollUp([exactUser, inferredUser]);
  const first = publishSplit.find(s => s.stage === "firstPublish")!;
  const repeat = publishSplit.find(s => s.stage === "repeatPublish")!;
  assert.equal(first.exact, 1);
  assert.equal(first.inferred, 1);
  assert.equal(repeat.exact, 1);
  assert.equal(repeat.inferred, 0);
});

test("FUNNEL_STAGES: canonical 5-stage order", () => {
  assert.deepEqual([...FUNNEL_STAGES], ["signup", "pinterestConnected", "firstGeneration", "firstPublish", "repeatPublish"]);
});

// ── end-to-end getActivationFunnel via injected mock DB ───────────────────────
test("getActivationFunnel: cohort filtered to last 30d; milestones joined", async () => {
  const authUsers = [
    { id: "recent", email: "r@x.com", created_at: daysAgo(5), last_sign_in_at: null },
    { id: "old", email: "o@x.com", created_at: daysAgo(90), last_sign_in_at: null }, // outside cohort
  ];
  const { db } = makeMockDb(
    {
      pinterest_connections: { rows: [{ vibepin_user_id: "recent", created_at: daysAgo(4) }] },
      pin_generations: { rows: [{ user_id: "recent", created_at: daysAgo(3) }] },
      analytics_events: { rows: [{ user_id: "recent", event_name: "pinterest_publish_succeeded", created_at: daysAgo(2) }] },
      pin_drafts: { rows: [] },
    },
    authUsers,
  );
  const res = await getActivationFunnel(db);
  assert.ok(res.available);
  assert.equal(res.cohortSize, 1, "only the recent signup is in the 30d cohort");
  const byStage = Object.fromEntries(res.stages.map(s => [s.stage, s.reached]));
  assert.equal(byStage.signup, 1);
  assert.equal(byStage.pinterestConnected, 1);
  assert.equal(byStage.firstGeneration, 1);
  assert.equal(byStage.firstPublish, 1);
  assert.equal(byStage.repeatPublish, 0);
  const first = res.publishSplit.find(s => s.stage === "firstPublish")!;
  assert.equal(first.exact, 1);
});

test("getActivationFunnel: unavailable when auth admin fails", async () => {
  const { db } = makeMockDb({}, [], { authError: true });
  const res = await getActivationFunnel(db);
  assert.equal(res.available, false);
});

test("getActivationFunnel: >1000-user cohort is not truncated", async () => {
  const authUsers = Array.from({ length: 1200 }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.com`, created_at: daysAgo(3), last_sign_in_at: null }));
  const { db } = makeMockDb(
    { pinterest_connections: { rows: [] }, pin_generations: { rows: [] }, analytics_events: { rows: [] }, pin_drafts: { rows: [] } },
    authUsers,
  );
  const res = await getActivationFunnel(db);
  assert.equal(res.cohortSize, 1200);
  assert.equal(res.stages.find(s => s.stage === "signup")!.reached, 1200);
});

void done();
