/**
 * Unit tests for the WP-A due-time publisher pure logic (no DB / HTTP).
 * Run: npx tsx scripts/test-publish-due-claim.ts   (from web/)
 *
 * Covers:
 *   - the claim predicate boundary (unclaimed / stale / live claim) that the route's
 *     atomic conditional UPDATE encodes,
 *   - payload → publishPinForUser input mapping (incl. hard-requirement gating),
 *   - success / failure payload transforms + mapPublishErrorToCategory integration,
 *   - buildScheduledAt (promote.ts): plannedAt / date+time / posted-guard / null cases.
 */

import assert from "node:assert";
import {
  CLAIM_STALE_MS,
  isClaimable,
  staleClaimCutoffIso,
  payloadToPublishInput,
  payloadAfterSuccess,
  payloadAfterFailure,
  payloadAfterOutcomes,
  destinationPublishInput,
  describeThrown,
} from "../src/app/api/cron/publish-due/publishDueLogic";
import { pendingDestinations } from "../src/lib/social/publishRules";
import { buildScheduledAt, buildScheduleColumns, SCHEDULE_COLUMN_KEYS } from "../src/app/api/pin-drafts/promote";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

const NOW = Date.parse("2026-07-11T12:00:00.000Z");

// ── claim predicate ──────────────────────────────────────────────────────────
test("isClaimable: unclaimed row is claimable", () => {
  assert.equal(isClaimable(null, NOW), true);
  assert.equal(isClaimable(undefined, NOW), true);
  assert.equal(isClaimable("", NOW), true);
});

test("isClaimable: a fresh claim (within 10 min) is NOT claimable", () => {
  const oneMinAgo = new Date(NOW - 60 * 1000).toISOString();
  assert.equal(isClaimable(oneMinAgo, NOW), false);
  const justNow = new Date(NOW).toISOString();
  assert.equal(isClaimable(justNow, NOW), false);
});

test("isClaimable: a stale claim (> 10 min) is reclaimable", () => {
  const elevenMinAgo = new Date(NOW - 11 * 60 * 1000).toISOString();
  assert.equal(isClaimable(elevenMinAgo, NOW), true);
});

test("isClaimable: exactly at the boundary is still live (strict <)", () => {
  const exactly = new Date(NOW - CLAIM_STALE_MS).toISOString();
  // claimedMs === now - 10min ⇒ NOT (claimedMs < now-10min) ⇒ still held.
  assert.equal(isClaimable(exactly, NOW), false);
  const oneMsOlder = new Date(NOW - CLAIM_STALE_MS - 1).toISOString();
  assert.equal(isClaimable(oneMsOlder, NOW), true);
});

test("isClaimable: unparseable lock treated as claimable (never wedged)", () => {
  assert.equal(isClaimable("not-a-date", NOW), true);
});

test("staleClaimCutoffIso: is exactly 10 minutes before now", () => {
  assert.equal(staleClaimCutoffIso(NOW), new Date(NOW - CLAIM_STALE_MS).toISOString());
});

// ── payload → publish input ────────────────────────────────────────────────────
test("payloadToPublishInput: maps studio fields", () => {
  const input = payloadToPublishInput("user-1", {
    imageUrl: " https://cdn/x.jpg ",
    boardId: "board-9",
    title: " My Pin ",
    description: "desc",
    destinationUrl: "https://shop/x",
    altText: "alt",
  });
  assert.ok(input);
  assert.equal(input!.uid, "user-1");
  assert.equal(input!.imageUrl, "https://cdn/x.jpg");
  assert.equal(input!.boardId, "board-9");
  assert.equal(input!.title, "My Pin");
  assert.equal(input!.link, "https://shop/x"); // destinationUrl → link
  assert.equal(input!.altText, "alt");
});

test("payloadToPublishInput: falls back to sourceImageUrl, link optional", () => {
  const input = payloadToPublishInput("u", { sourceImageUrl: "https://cdn/y.jpg", boardId: "b" });
  assert.ok(input);
  assert.equal(input!.imageUrl, "https://cdn/y.jpg");
  assert.equal(input!.link, undefined); // no destinationUrl ⇒ omitted (link is optional)
  assert.equal(input!.title, undefined);
});

test("payloadToPublishInput: null when image or board missing", () => {
  assert.equal(payloadToPublishInput("u", { boardId: "b" }), null);
  assert.equal(payloadToPublishInput("u", { imageUrl: "https://cdn/x.jpg" }), null);
  assert.equal(payloadToPublishInput("u", {}), null);
});

// ── success transform ──────────────────────────────────────────────────────────
test("payloadAfterSuccess: marks posted, captures pin, clears scheduling + failure", () => {
  const before = {
    title: "t",
    scheduledDate: "2026-07-11",
    scheduledTime: "09:00",
    plannedAt: "2026-07-11T09:00",
    publishError: "old error",
    failureType: "publish",
    errorCategory: "transient",
    publishErrorCode: "network_error",
  };
  const after = payloadAfterSuccess(before, { id: "pin-1", url: "https://pin/1" }, "2026-07-11T12:00:00.000Z");
  assert.equal(after.postedAt, "2026-07-11T12:00:00.000Z");
  assert.equal(after.remotePinId, "pin-1");
  assert.equal(after.remotePinUrl, "https://pin/1");
  assert.equal(after.scheduledDate, "");
  assert.equal(after.scheduledTime, "");
  assert.equal(after.plannedAt, "");
  assert.ok(!("publishError" in after), "cleared prior publishError");
  assert.ok(!("failureType" in after));
  assert.ok(!("errorCategory" in after));
  assert.ok(!("publishErrorCode" in after));
  // does not mutate the input
  assert.equal(before.publishError, "old error");
});

test("payloadAfterSuccess: bumps payload.updatedAt to nowIso (client LWW merge key)", () => {
  const before = { title: "t", updatedAt: "2020-01-01T00:00:00.000Z" };
  const after = payloadAfterSuccess(before, { id: "pin-1", url: "https://pin/1" }, "2026-07-11T12:00:00.000Z");
  assert.equal(after.updatedAt, "2026-07-11T12:00:00.000Z");
});

// ── failure transform + categorization ──────────────────────────────────────────
test("payloadAfterFailure: auth error → errorCategory auth, preserves scheduled time (as ISO)", () => {
  const before = { title: "t", plannedAt: "2026-07-11T09:00", scheduledDate: "2026-07-11", scheduledTime: "09:00" };
  const after = payloadAfterFailure(before, { message: "Pinterest connection expired — please reconnect", code: "needs_reconnect" }, "2026-07-11T12:00:00.000Z");
  assert.equal(after.failureType, "publish");
  assert.equal(after.errorCategory, "auth");
  assert.equal(after.publishErrorCode, "needs_reconnect");
  assert.equal(after.publishError, "Pinterest connection expired — please reconnect");
  assert.equal(after.previousScheduledTime, "2026-07-11T09:00:00.000Z"); // plannedAt preferred, now ISO
  assert.equal(after.scheduledDate, "");
  assert.equal(after.plannedAt, "");
});

test("payloadAfterFailure: board_not_owned → content", () => {
  const after = payloadAfterFailure({ scheduledDate: "2026-07-11" }, { message: "Board not found", code: "board_not_owned" }, "2026-07-11T12:00:00.000Z");
  assert.equal(after.errorCategory, "content");
  assert.equal(after.publishErrorCode, "board_not_owned");
  assert.equal(after.previousScheduledTime, "2026-07-11T00:00:00.000Z"); // scheduledDate fallback, ISO midnight
});

test("payloadAfterFailure: unknown/no code → transient (never blocks retry)", () => {
  const after = payloadAfterFailure({}, { message: "Something odd happened" }, "2026-07-11T12:00:00.000Z");
  assert.equal(after.errorCategory, "transient");
  assert.ok(!("publishErrorCode" in after), "no code ⇒ no publishErrorCode written");
});

test("payloadAfterFailure: bumps payload.updatedAt to nowIso (client LWW merge key)", () => {
  const before = { title: "t", updatedAt: "2020-01-01T00:00:00.000Z" };
  const after = payloadAfterFailure(before, { message: "boom" }, "2026-07-11T12:00:00.000Z");
  assert.equal(after.updatedAt, "2026-07-11T12:00:00.000Z");
});

test("describeThrown: pulls message + code off a thrown PinterestApiError-shape", () => {
  const info = describeThrown(Object.assign(new Error("token expired"), { code: "needs_reconnect" }));
  assert.equal(info.message, "token expired");
  assert.equal(info.code, "needs_reconnect");
  const bare = describeThrown({});
  assert.equal(bare.message, "Publish failed");
  assert.equal(bare.code, undefined);
});

// ── buildScheduledAt (promote.ts) ────────────────────────────────────────────────
test("buildScheduledAt: plannedAt local wall-clock → UTC iso", () => {
  assert.equal(buildScheduledAt({ plannedAt: "2026-07-11T09:30" }), "2026-07-11T09:30:00.000Z");
});

test("buildScheduledAt: scheduledDate + scheduledTime fallback", () => {
  assert.equal(buildScheduledAt({ scheduledDate: "2026-07-11", scheduledTime: "14:05" }), "2026-07-11T14:05:00.000Z");
  assert.equal(buildScheduledAt({ scheduledDate: "2026-07-11" }), "2026-07-11T00:00:00.000Z"); // midnight default
});

test("buildScheduledAt: unscheduled → null", () => {
  assert.equal(buildScheduledAt({}), null);
  assert.equal(buildScheduledAt({ plannedAt: "", scheduledDate: "" }), null);
});

test("buildScheduledAt: already posted → null (never re-scanned as due)", () => {
  assert.equal(buildScheduledAt({ plannedAt: "2026-07-11T09:30", postedAt: "2026-07-11T10:00:00.000Z" }), null);
  assert.equal(buildScheduledAt({ plannedAt: "2026-07-11T09:30", remotePinId: "pin-1" }), null);
});

test("buildScheduleColumns: only scheduled_at (never publish_claimed_at)", () => {
  const cols = buildScheduleColumns({ plannedAt: "2026-07-11T09:30" });
  assert.deepEqual(Object.keys(cols), ["scheduled_at"]);
  assert.equal(cols.scheduled_at, "2026-07-11T09:30:00.000Z");
  assert.deepEqual([...SCHEDULE_COLUMN_KEYS], ["scheduled_at"]);
  assert.ok(!("publish_claimed_at" in cols), "client write path never touches the cron claim lock");
});

// ── WS-B3: N Pinterest destinations on one Content ──────────────────────────
const PIN_A = { provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", capturedAt: "t" };
const PIN_B = { provider: "pinterest", socialConnectionId: "pin_B", boardId: "b-B", capturedAt: "t" };

test("destinationPublishInput: each entry publishes to its OWN account and board", () => {
  const base = payloadToPublishInput("u", { imageUrl: "https://cdn/x.jpg", boardId: "b-A", targetConnectionId: "pin_A" })!;
  const a = destinationPublishInput(base, PIN_A, "pin_A")!;
  const b = destinationPublishInput(base, PIN_B, "pin_A")!;
  assert.equal(a.boardId, "b-A");
  assert.equal(a.connectionId, "pin_A");
  assert.equal(b.boardId, "b-B", "the second account must publish to its own board");
  assert.equal(b.connectionId, "pin_B");
});

test("destinationPublishInput: a second account never inherits the legacy board", () => {
  const base = payloadToPublishInput("u", { imageUrl: "https://cdn/x.jpg", boardId: "b-A", targetConnectionId: "pin_A" })!;
  const boardless = destinationPublishInput(base, { socialConnectionId: "pin_B" }, "pin_A");
  assert.equal(boardless, null, "b-A belongs to pin_A — publishing pin_B into it is the wrong-board defect");
  // The entry that IS the legacy target still inherits it.
  assert.equal(destinationPublishInput(base, { socialConnectionId: "pin_A" }, "pin_A")?.boardId, "b-A");
  // So does a legacy destination that names no account at all.
  assert.equal(destinationPublishInput(base, {}, "pin_A")?.boardId, "b-A");
});

test("payloadToPublishInput: a Content whose board lives on its entry is publishable", () => {
  // No legacy payload.boardId at all — the board is a property of the destination.
  const input = payloadToPublishInput("u", {
    imageUrl: "https://cdn/x.jpg",
    scheduledDestinations: [PIN_B],
  });
  assert.ok(input, "refusing this would fail a publish that is perfectly well specified");
});

test("payloadAfterOutcomes: two Pinterest accounts get two result rows", () => {
  const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27" }, [
    { provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "p1", externalPostUrl: "https://pin/1" },
    { provider: "pinterest", status: "published", socialConnectionId: "pin_B", externalPostId: "p2", externalPostUrl: "https://pin/2" },
  ], "2026-08-27T10:00:00.000Z");
  const rows = after.destinationResults as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.destinationId), ["pinterest:pin_A", "pinterest:pin_B"]);
  assert.equal(after.postedAt, "2026-08-27T10:00:00.000Z");
  assert.equal(after.remotePinId, "p1", "the legacy fields name the FIRST published Pinterest entry");
  assert.equal(after.scheduledDate, "", "a published Content leaves the due scan");
});

test("payloadAfterOutcomes: one account failing does not un-publish the other", () => {
  const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27" }, [
    { provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "p1" },
    { provider: "pinterest", status: "failed", socialConnectionId: "pin_B", error: "Board not found" },
  ], "2026-08-27T10:00:00.000Z");
  assert.equal(after.postedAt, "2026-08-27T10:00:00.000Z", "a partial success stays posted");
  assert.equal(after.publishError, undefined, "and is not framed as a Content-level failure");
  assert.equal(after.scheduledDate, "", "a partial success must NOT re-fire and double-post pin_A");
  const rows = after.destinationResults as Array<Record<string, unknown>>;
  assert.equal(rows.find(r => r.destinationId === "pinterest:pin_B")?.errorMessage, "Board not found",
    "the failure is still recorded, per destination");
});

test("payloadAfterOutcomes: nothing published ⇒ WP-B failure semantics + the lost slot", () => {
  const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27", scheduledTime: "09:30", plannedAt: "2026-08-27T09:30" }, [
    { provider: "pinterest", status: "failed", socialConnectionId: "pin_A", error: "Pinterest connection expired — please reconnect" },
  ], "2026-08-27T10:00:00.000Z");
  assert.equal(after.failureType, "publish");
  assert.equal(after.errorCategory, "auth");
  assert.equal(after.previousScheduledTime, "2026-08-27T09:30:00.000Z");
  assert.equal(after.postedAt, undefined);
  assert.equal(after.scheduledDate, "", "drops out of the due scan — no retry storm");
});

test("payloadAfterOutcomes: nothing owed ⇒ completed, never marked failed", () => {
  // A stale-claim re-run where every destination had already published.
  const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27" }, [], "2026-08-27T10:00:00.000Z");
  assert.equal(after.publishError, undefined, "an empty attempt is not a failure");
  assert.equal(after.failureType, undefined);
  assert.equal(after.scheduledDate, "", "but it must still leave the due scan");
});

test("pendingDestinations: two accounts on one platform retry independently", () => {
  const owed = pendingDestinations([PIN_A, PIN_B], [
    { provider: "pinterest", status: "published", socialConnectionId: "pin_A" },
  ]);
  assert.deepEqual(owed.map(d => d.socialConnectionId), ["pin_B"],
    "re-publishing pin_A after a stale claim would double-post it");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
