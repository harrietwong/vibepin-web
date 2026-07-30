/**
 * Unit tests for the admin AI Adoption derivation layer.
 * Run: npx tsx scripts/test-ai-adoption.ts   (from web/)
 *
 * Covers extractOutputUrls (pin_urls ∪ groups_json images), the linkage precedence
 * (sourceGenerationId EXACT beats URL-match INFERRED), the published-draft gate
 * (event OR postedAt), rate math, the 7-day direction sign, and an end-to-end run
 * through the injected mock DB including a >1000-row scan (no truncation).
 */

import assert from "node:assert";
import { makeMockDb, makeHarness } from "./adminMockDb";
import {
  extractOutputUrls,
  computeAdoption,
  getAiAdoption,
  type GenerationLite,
  type DraftLite,
} from "../src/lib/server/adminAiAdoption";

const { test, done } = makeHarness();

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 3_600_000).toISOString();

// ── extractOutputUrls ─────────────────────────────────────────────────────────
test("extractOutputUrls: unions pin_urls and groups_json images, dedupes", () => {
  const urls = extractOutputUrls({
    pin_urls: ["https://a/1.png", "https://a/2.png"],
    groups_json: [{ refUrl: "r", images: ["https://a/2.png", "https://a/3.png"] }],
  });
  assert.deepEqual(new Set(urls), new Set(["https://a/1.png", "https://a/2.png", "https://a/3.png"]));
});
test("extractOutputUrls: handles missing/garbage shapes", () => {
  assert.deepEqual(extractOutputUrls({}), []);
  assert.deepEqual(extractOutputUrls({ pin_urls: null, groups_json: "x" }), []);
});

// ── computeAdoption: linkage precedence + published gate ──────────────────────
const gen = (id: string, urls: string[], status = "completed", createdAt = daysAgo(1)): GenerationLite => ({ id, createdAt, status, outputUrls: urls });
const draft = (o: Partial<DraftLite>): DraftLite => ({ draftId: "d", sourceGenerationId: null, imageUrls: [], published: false, ...o });

test("computeAdoption: EXACT link via sourceGenerationId, draft published by event", () => {
  const r = computeAdoption([gen("g1", ["https://x/1.png"])], [draft({ draftId: "d1", sourceGenerationId: "g1", published: true })]);
  assert.equal(r.completed, 1);
  assert.equal(r.adopted, 1);
  assert.equal(r.exactLinks, 1);
  assert.equal(r.inferredLinks, 0);
});

test("computeAdoption: sourceGenerationId EXACT beats URL match", () => {
  // Two drafts could match g1: one by id (exact), one by url (inferred). Exact wins;
  // the generation is counted once via the exact path.
  const r = computeAdoption(
    [gen("g1", ["https://x/1.png"])],
    [
      draft({ draftId: "dExact", sourceGenerationId: "g1", published: true }),
      draft({ draftId: "dUrl", imageUrls: ["https://x/1.png"], published: true }),
    ],
  );
  assert.equal(r.adopted, 1);
  assert.equal(r.exactLinks, 1);
  assert.equal(r.inferredLinks, 0, "must not double-count via the URL path");
});

test("computeAdoption: INFERRED link via URL when no sourceGenerationId", () => {
  const r = computeAdoption(
    [gen("g1", ["https://x/1.png"])],
    [draft({ draftId: "dUrl", sourceGenerationId: null, imageUrls: ["https://x/1.png"], published: true })],
  );
  assert.equal(r.adopted, 1);
  assert.equal(r.inferredLinks, 1);
  assert.equal(r.exactLinks, 0);
});

test("computeAdoption: an UNPUBLISHED draft does not adopt", () => {
  const r = computeAdoption([gen("g1", ["https://x/1.png"])], [draft({ draftId: "d1", sourceGenerationId: "g1", published: false })]);
  assert.equal(r.adopted, 0);
  assert.equal(r.completed, 1);
});

test("computeAdoption: non-completed generations excluded from the denominator", () => {
  const r = computeAdoption([gen("g1", ["u"], "failed"), gen("g2", ["u2"], "running")], []);
  assert.equal(r.completed, 0);
  assert.equal(r.adopted, 0);
});

// ── end-to-end getAiAdoption via injected mock DB ─────────────────────────────
test("getAiAdoption: rate + link split + published-by-event", async () => {
  const { db } = makeMockDb({
    pin_generations: { rows: [
      { id: "g1", created_at: daysAgo(1), status: "completed", pin_urls: ["https://x/1.png"], groups_json: [] },
      { id: "g2", created_at: daysAgo(1), status: "completed", pin_urls: ["https://x/2.png"], groups_json: [] },
    ] },
    // d1 → g1 by id, published via event; d2 → g2 by URL, published via postedAt.
    pin_drafts: { rows: [
      { draft_id: "d1", vibepin_user_id: "u1", payload: { sourceGenerationId: "g1" }, deleted_at: null, updated_at: daysAgo(1) },
      { draft_id: "d2", vibepin_user_id: "u1", payload: { imageUrl: "https://x/2.png", postedAt: daysAgo(1) }, deleted_at: null, updated_at: daysAgo(1) },
    ] },
    analytics_events: { rows: [
      { draft_id: "d1", event_name: "pinterest_publish_succeeded", created_at: daysAgo(1) },
    ] },
  });
  const res = await getAiAdoption(db);
  assert.ok(res.available);
  assert.equal(res.completed, 2);
  assert.equal(res.adopted, 2);
  assert.equal(res.rate, 1);
  assert.equal(res.linkSplit.exact, 1);
  assert.equal(res.linkSplit.inferred, 1);
});

test("getAiAdoption: unavailable when pin_generations table is missing", async () => {
  const { db } = makeMockDb({ pin_drafts: { rows: [] }, analytics_events: { rows: [] } });
  const res = await getAiAdoption(db);
  assert.equal(res.available, false);
  assert.equal(res.rate, null);
});

test("getAiAdoption: 7-day direction sign (improving)", async () => {
  // prior 7d (8-14d ago): 1 completed, 0 adopted → rate 0.
  // last 7d (0-7d ago): 1 completed, 1 adopted → rate 1. direction should be +1.
  const { db } = makeMockDb({
    pin_generations: { rows: [
      { id: "gPrior", created_at: daysAgo(10), status: "completed", pin_urls: ["https://x/p.png"], groups_json: [] },
      { id: "gLast", created_at: daysAgo(2), status: "completed", pin_urls: ["https://x/l.png"], groups_json: [] },
    ] },
    pin_drafts: { rows: [
      { draft_id: "dLast", vibepin_user_id: "u1", payload: { sourceGenerationId: "gLast", postedAt: daysAgo(1) }, deleted_at: null, updated_at: daysAgo(1) },
    ] },
    analytics_events: { rows: [] },
  });
  const res = await getAiAdoption(db);
  assert.equal(res.trend.direction, 1, `expected improving, got ${res.trend.direction} (last=${res.trend.last7dRate}, prior=${res.trend.prior7dRate})`);
  assert.equal(res.trend.prior7dRate, 0);
  assert.equal(res.trend.last7dRate, 1);
});

test("getAiAdoption: >1000 generations scanned without truncation", async () => {
  const rows = Array.from({ length: 1300 }, (_, i) => ({ id: `g${i}`, created_at: daysAgo(1), status: "completed", pin_urls: [`https://x/${i}.png`], groups_json: [] }));
  const { db } = makeMockDb({ pin_generations: { rows }, pin_drafts: { rows: [] }, analytics_events: { rows: [] } });
  const res = await getAiAdoption(db);
  assert.equal(res.completed, 1300, `expected 1300 completed generations, got ${res.completed}`);
  assert.equal(res.adopted, 0);
  assert.equal(res.rate, 0);
});

void done();
