/**
 * Bulk actions contract tests (WS-F, PRD 0826 §19/§30).
 *
 * The invariants that matter to a merchant who selected 40 Pins and hit one button:
 *   1. A fully-published Content is NEVER handed to the publisher. `publishContent`
 *      falls back to re-attempting every destination when none is pending, so without
 *      this partition a Posted item in the selection would be double-posted.
 *   2. The sheet's "blocked" list and its reasons come from the same checks the
 *      publisher enforces — one blocked destination out of two does NOT block the
 *      Content (PRD §29 per-platform independence).
 *   3. Delete impact is grouped by what deletion MEANS per lifecycle, and Scheduled
 *      items are unscheduled before they are deleted.
 *
 * Run: npx tsx scripts/test-bulk-actions.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  partitionBulkPublish,
  summarizeDeleteImpact,
  summarizeBulkPublish,
  isFullyPublished,
  type BulkPublishOutcomeRow,
} from "../src/lib/studio/bulkActions";
import { explainPublishBlockers } from "../src/lib/studio/publishContent";
import type { PinDraft } from "../src/lib/pinDraftStore";

const UNTITLED = "Untitled Pin";

let seq = 0;
function draft(over: Partial<PinDraft> = {}): PinDraft {
  seq += 1;
  return {
    id: over.id ?? `d${seq}`,
    imageUrl: "https://cdn.example/one.jpg",
    title: "A Pin",
    ...over,
  } as PinDraft;
}

/** A Pinterest destination with a board — the plain publishable case. */
function pinterestReady(over: Partial<PinDraft> = {}): PinDraft {
  return draft({ boardId: "board-1", boardName: "Home", ...over });
}

function instagramDest(connectionId: string | null) {
  return [{
    provider: "instagram",
    socialConnectionId: connectionId as string,
    capturedAt: "2026-08-27T00:00:00.000Z",
  }];
}

// ── explainPublishBlockers ────────────────────────────────────────────────────

test("no destination at all is a whole-Content blocker", () => {
  const blockers = explainPublishBlockers(draft());
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "no_destinations");
  assert.equal(blockers[0].provider, undefined);
});

test("a Pinterest destination without a board reports missing_board", () => {
  // remotePinId forces the legacy Pinterest destination to exist without a board.
  const d = draft({ remotePinId: "" , publishError: "boom" });
  const blockers = explainPublishBlockers(d);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "missing_board");
  assert.equal(blockers[0].provider, "pinterest");
});

test("a ready Pinterest Content has no blockers", () => {
  assert.deepEqual(explainPublishBlockers(pinterestReady()), []);
});

test("an Instagram intent with no account is not a publishable destination", () => {
  // `isUsableDestination` drops a social entry with no connection id, so an ambiguous
  // account never survives into `contentDestinations`: the Content simply has nowhere
  // to publish. The sheet must therefore say "choose where to publish" rather than
  // promising an Instagram send that the publisher would never make.
  const d = draft({ scheduledDestinations: instagramDest(null) } as Partial<PinDraft>);
  const blockers = explainPublishBlockers(d);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "no_destinations");
});

test("a resolvable Instagram destination is publishable", () => {
  const d = draft({ scheduledDestinations: instagramDest("conn-1") } as Partial<PinDraft>);
  assert.deepEqual(explainPublishBlockers(d), []);
});

test("no media is reported per destination, with the media rule's own code", () => {
  const d = draft({ imageUrl: "", boardId: "board-1" });
  const blockers = explainPublishBlockers(d);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "no_media");
  assert.equal(blockers[0].provider, "pinterest");
});

// ── partitionBulkPublish ──────────────────────────────────────────────────────

test("ready and blocked are separated, blocked keeps its reasons", () => {
  const ok = pinterestReady({ id: "ok" });
  const bad = draft({ id: "bad" });
  const p = partitionBulkPublish([ok, bad], { untitled: UNTITLED });
  assert.deepEqual(p.ready.map(r => r.id), ["ok"]);
  assert.deepEqual(p.blocked.map(r => r.id), ["bad"]);
  assert.equal(p.blocked[0].blockers[0].code, "no_destinations");
});

test("a fully published Content is skipped, never re-published", () => {
  // The trap: publishContent({ onlyPending: true }) re-attempts EVERY destination when
  // none is pending. A Posted item swept into a bulk publish would double-post.
  const posted = pinterestReady({
    id: "posted",
    postedAt: "2026-08-27T10:00:00.000Z",
    remotePinId: "pin-1",
    destinationResults: [{
      destinationId: "pinterest:legacy", provider: "pinterest", socialConnectionId: null,
      boardId: "board-1", status: "published", publishedAt: "2026-08-27T10:00:00.000Z",
    }],
  } as Partial<PinDraft>);
  const p = partitionBulkPublish([posted], { untitled: UNTITLED });
  assert.deepEqual(p.ready, []);
  assert.deepEqual(p.alreadyPublished.map(r => r.id), ["posted"]);
  assert.equal(isFullyPublished(posted), true);
});

test("a partially published Content stays ready — the failed half must be retried", () => {
  const partial = pinterestReady({
    id: "partial",
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "c1", boardId: "board-1", capturedAt: "2026-08-27T00:00:00.000Z" },
      { provider: "instagram", socialConnectionId: "c2", capturedAt: "2026-08-27T00:00:00.000Z" },
    ],
    destinationResults: [
      { destinationId: "pinterest:c1", provider: "pinterest", socialConnectionId: "c1", status: "published" },
      { destinationId: "instagram:c2", provider: "instagram", socialConnectionId: "c2", status: "failed", errorMessage: "Rate limited." },
    ],
  } as Partial<PinDraft>);
  const p = partitionBulkPublish([partial], { untitled: UNTITLED });
  assert.deepEqual(p.ready.map(r => r.id), ["partial"]);
  assert.deepEqual(p.alreadyPublished, []);
});

test("one bad destination out of two does not block the Content (PRD §29)", () => {
  // 6 images: Pinterest's carousel maxes at 5 and refuses, Instagram allows 10 and
  // accepts. A per-platform rule may not become a whole-Content block, so this is
  // ready — the publisher will send Instagram and record Pinterest as failed.
  const media = Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`, kind: "image" as const, url: `https://cdn.example/${i}.jpg`,
    source: "upload" as const, width: 1000, height: 1500,
  }));
  const mixed = draft({
    id: "mixed",
    boardId: "board-1",
    media,
    coverMediaId: "m0",
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "c1", boardId: "board-1", capturedAt: "2026-08-27T00:00:00.000Z" },
      { provider: "instagram", socialConnectionId: "c2", capturedAt: "2026-08-27T00:00:00.000Z" },
    ],
  } as Partial<PinDraft>);
  const blockers = explainPublishBlockers(mixed);
  assert.equal(blockers.length, 1, "exactly one destination is refused");
  assert.equal(blockers[0].provider, "pinterest");
  const p = partitionBulkPublish([mixed], { untitled: UNTITLED });
  assert.deepEqual(p.ready.map(r => r.id), ["mixed"]);
  assert.deepEqual(p.blocked, []);
});

test("when EVERY destination is refused the Content is blocked", () => {
  const both = draft({
    id: "both",
    imageUrl: "",
    boardId: "board-1",
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "c1", boardId: "board-1", capturedAt: "2026-08-27T00:00:00.000Z" },
      { provider: "instagram", socialConnectionId: "c2", capturedAt: "2026-08-27T00:00:00.000Z" },
    ],
  } as Partial<PinDraft>);
  const p = partitionBulkPublish([both], { untitled: UNTITLED });
  assert.deepEqual(p.ready, []);
  assert.equal(p.blocked[0].blockers.length, 2);
  assert.deepEqual(p.blocked[0].blockers.map(b => b.code), ["no_media", "no_media"]);
});

test("scheduled ready items are counted so the sheet can warn they publish now", () => {
  const scheduled = pinterestReady({ id: "s1", scheduledDate: "2026-09-01", scheduledTime: "09:00" });
  const now = pinterestReady({ id: "u1" });
  const p = partitionBulkPublish([scheduled, now], { untitled: UNTITLED });
  assert.equal(p.scheduledNowCount, 1);
  assert.equal(p.ready.length, 2);
});

test("generating Contents are skipped, not reported as merchant errors", () => {
  const gen = draft({ id: "g1", generationStatus: "generating" } as Partial<PinDraft>);
  const p = partitionBulkPublish([gen], { untitled: UNTITLED });
  assert.deepEqual(p.generating.map(r => r.id), ["g1"]);
  assert.deepEqual(p.blocked, []);
  assert.deepEqual(p.ready, []);
});

test("an untitled Pin gets the caller's fallback name, not an empty label", () => {
  const p = partitionBulkPublish([pinterestReady({ id: "x", title: "   " })], { untitled: UNTITLED });
  assert.equal(p.ready[0].title, UNTITLED);
});

// ── summarizeDeleteImpact ─────────────────────────────────────────────────────

test("delete impact groups by what deletion means for each lifecycle", () => {
  const unscheduled = draft({ id: "d1" });
  const scheduled = draft({ id: "d2", scheduledDate: "2026-09-01" });
  const posted = draft({ id: "d3", postedAt: "2026-08-01T00:00:00.000Z", remotePinId: "p1" });
  const impact = summarizeDeleteImpact([unscheduled, scheduled, posted]);
  assert.equal(impact.total, 3);
  assert.equal(impact.draftCount, 1);
  assert.equal(impact.scheduledCount, 1);
  assert.equal(impact.postedCount, 1);
  assert.deepEqual(impact.ids, ["d1", "d2", "d3"]);
});

test("only scheduled ids are unscheduled before deletion", () => {
  const impact = summarizeDeleteImpact([
    draft({ id: "a", scheduledDate: "2026-09-01" }),
    draft({ id: "b" }),
  ]);
  assert.deepEqual(impact.unscheduleIds, ["a"]);
});

test("a posted-and-rescheduled Content counts once, as posted", () => {
  const impact = summarizeDeleteImpact([
    draft({ id: "z", postedAt: "2026-08-01T00:00:00.000Z", scheduledDate: "2026-09-01" }),
  ]);
  assert.equal(impact.postedCount, 1);
  assert.equal(impact.scheduledCount, 0);
  assert.deepEqual(impact.unscheduleIds, []);
});

test("a failed Content deletes as a plain draft", () => {
  const impact = summarizeDeleteImpact([draft({ id: "f", publishError: "boom" })]);
  assert.equal(impact.draftCount, 1);
});

// ── summarizeBulkPublish ──────────────────────────────────────────────────────

const rows: BulkPublishOutcomeRow[] = [
  { id: "1", title: "One", status: "published", publishedProviders: ["pinterest"] },
  { id: "2", title: "Two", status: "failed", message: "Pinterest rejected the image." },
  { id: "3", title: "Three", status: "skipped", message: "Already publishing." },
];

test("the summary counts each outcome and surfaces only the problems", () => {
  const s = summarizeBulkPublish(rows);
  assert.equal(s.publishedCount, 1);
  assert.equal(s.failedCount, 1);
  assert.equal(s.skippedCount, 1);
  assert.deepEqual(s.problems.map(r => r.id), ["2", "3"]);
  assert.equal(s.tone, "partial");
});

test("every problem row carries a reason — never a bare failure", () => {
  const s = summarizeBulkPublish(rows);
  for (const problem of s.problems) {
    assert.ok(problem.message && problem.message.trim().length > 0, `${problem.id} has no reason`);
  }
});

test("tone distinguishes all-published from nothing-published", () => {
  assert.equal(summarizeBulkPublish([rows[0]]).tone, "all_published");
  assert.equal(summarizeBulkPublish([rows[1]]).tone, "none_published");
  assert.equal(summarizeBulkPublish([]).tone, "none_published");
});
