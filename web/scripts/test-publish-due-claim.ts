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
import { readFileSync } from "node:fs";
import {
  CLAIM_BUDGET_MS,
  CLAIM_STALE_MS,
  isClaimable,
  staleClaimCutoffIso,
  payloadToPublishInput,
  payloadAfterSuccess,
  payloadAfterFailure,
  payloadAfterOutcomes,
  destinationPublishInput,
  describeThrown,
  owedDestinations,
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

test("payloadAfterOutcomes: the failure CODE drives the category, not the wording", () => {
  // The outcome rows carry only a user-facing message. Categorizing from that alone
  // puts a differently-worded needs_reconnect in "transient" and offers the wrong fix.
  const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27" }, [
    { provider: "pinterest", status: "failed", socialConnectionId: "pin_A", error: "Something Pinterest said" },
  ], "2026-08-27T10:00:00.000Z", null, "needs_reconnect");
  assert.equal(after.errorCategory, "auth");
  assert.equal(after.publishErrorCode, "needs_reconnect");
});

test("payloadAfterOutcomes: a later success clears a previous attempt's error code", () => {
  const after = payloadAfterOutcomes(
    { scheduledDate: "2026-08-27", publishError: "old", publishErrorCode: "needs_reconnect", failureType: "publish" },
    [{ provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "p1" }],
    "2026-08-27T10:00:00.000Z",
  );
  assert.equal(after.publishErrorCode, undefined);
  assert.equal(after.failureType, undefined);
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


// ── A Content with NO Pinterest destination (Instagram/Facebook only) ────────
// Requiring a board for every scheduled Content made an Instagram-only schedule fail
// with "Missing image or board — cannot publish", without a single platform it named
// being attempted. A board is a PINTEREST requirement, not a Content requirement.
const IG_A = { provider: "instagram", socialConnectionId: "ig_A", capturedAt: "t" };
const PIN_NO_BOARD = { provider: "pinterest", socialConnectionId: "pin_A", capturedAt: "t" };

test("owedDestinations: a legacy draft derives its pinned Pinterest target", () => {
  const owed = owedDestinations({ targetConnectionId: "pin_A", boardId: "b-A" });
  assert.deepEqual(owed.map(d => `${d.provider}:${d.socialConnectionId}`), ["pinterest:pin_A"]);
  // No intent and no pinned target ⇒ nothing owed (Instagram is never invented).
  assert.deepEqual(owedDestinations({ imageUrl: "https://cdn/x.jpg" }), []);
});

test("owedDestinations: an account that already published is no longer owed", () => {
  const owed = owedDestinations({
    scheduledDestinations: [PIN_A, IG_A],
    destinationResults: [{ provider: "pinterest", status: "published", socialConnectionId: "pin_A" }],
  });
  assert.deepEqual(owed.map(d => d.provider), ["instagram"]);
});

test("payloadToPublishInput: an Instagram-only schedule publishes WITHOUT a board", () => {
  const input = payloadToPublishInput("u", {
    imageUrl: "https://cdn/x.jpg",
    scheduledDestinations: [IG_A],
  });
  assert.ok(input, "a Content that names no Pinterest destination needs no board");
  assert.equal(input!.boardId, undefined, "no board is owed, so none is invented");
  assert.deepEqual(input!.imageUrls, ["https://cdn/x.jpg"]);
});

test("payloadToPublishInput: a boardless Pinterest entry never blocks the platforms beside it", () => {
  const input = payloadToPublishInput("u", {
    imageUrl: "https://cdn/x.jpg",
    scheduledDestinations: [PIN_NO_BOARD, IG_A],
  });
  assert.ok(input, "Instagram must not be punished for Pinterest's missing board");
  // The Pinterest entry is still refused — individually, with its own failure row.
  assert.equal(destinationPublishInput(input!, { socialConnectionId: "pin_A" }, ""), null);
});

test("payloadToPublishInput: legacy rows unchanged — Pinterest still requires a board", () => {
  const img = "https://cdn/x.jpg";
  // explicit Pinterest-only intent …
  assert.equal(payloadToPublishInput("u", { imageUrl: img, scheduledDestinations: [PIN_NO_BOARD] }), null);
  // … intent derived from the legacy pinned target …
  assert.equal(payloadToPublishInput("u", { imageUrl: img, targetConnectionId: "pin_A" }), null);
  // … and a draft carrying no intent at all.
  assert.equal(payloadToPublishInput("u", { imageUrl: img }), null);
  // With a board it is publishable, exactly as before.
  assert.equal(payloadToPublishInput("u", { imageUrl: img, targetConnectionId: "pin_A", boardId: "b-A" })?.boardId, "b-A");
});

test("payloadAfterOutcomes: a social-only publish is posted, and invents no Pin", () => {
  const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27", plannedAt: "2026-08-27T09:30" }, [
    { provider: "instagram", status: "published", socialConnectionId: "ig_A", externalPostId: "ig-1", externalPostUrl: "https://ig/1" },
  ], "2026-08-27T10:00:00.000Z");
  assert.equal(after.postedAt, "2026-08-27T10:00:00.000Z");
  assert.equal(after.remotePinId, undefined, "there was no Pin — claiming one would be a lie");
  assert.equal(after.remotePinUrl, undefined);
  assert.equal(after.scheduledDate, "", "a posted Content leaves the due scan");
  const rows = after.destinationResults as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map(r => r.destinationId), ["instagram:ig_A"]);
  assert.equal(rows[0].postUrl, "https://ig/1");
});

test("payloadAfterOutcomes: a social-only publish that failed is a Content failure", () => {
  const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27", plannedAt: "2026-08-27T09:30" }, [
    { provider: "instagram", status: "failed", socialConnectionId: "ig_A", error: "Reconnect your Instagram account to publish this Pin." },
  ], "2026-08-27T10:00:00.000Z");
  assert.equal(after.postedAt, undefined);
  assert.equal(after.failureType, "publish");
  assert.equal(after.publishError, "Reconnect your Instagram account to publish this Pin.");
  assert.equal(after.previousScheduledTime, "2026-08-27T09:30:00.000Z", "the lost slot is preserved");
  assert.equal(after.scheduledDate, "", "but it still leaves the due scan — no retry storm");
});

// ── The draft that names no account at all (pre-adopt-once Pins) ────────────
// resolveScheduledDestinations can only derive intent from a PINNED target, so a draft
// with a board and no targetConnectionId resolves to nothing owed — and once
// destinations drove the publish, that made the row leave the due scan as "completed"
// after being metered, having published nothing at all.
test("owedDestinations: a draft with a board but no account owes one Pinterest publish", () => {
  const owed = owedDestinations({ imageUrl: "https://cdn/x.jpg", boardId: "b-A", boardName: "Board A" });
  assert.equal(owed.length, 1, "a scheduled Pin must never silently publish nowhere");
  assert.equal(owed[0].provider, "pinterest");
  assert.ok(!owed[0].socialConnectionId, "it names no account — the publish adopts the default one");
  assert.equal(owed[0].boardId, "b-A");
  assert.equal(owed[0].boardName, "Board A");
});

test("owedDestinations: that legacy destination publishes with adopt-once, into its board", () => {
  const payload = { imageUrl: "https://cdn/x.jpg", boardId: "b-A" };
  const base = payloadToPublishInput("u", payload)!;
  assert.equal(base.boardId, "b-A", "a board-only draft is still publishable, exactly as before");
  const perDestination = destinationPublishInput(base, owedDestinations(payload)[0], "")!;
  assert.equal(perDestination.boardId, "b-A");
  assert.equal(perDestination.connectionId, undefined,
    "no connection is named, so publishPinForUser resolves the default and the route adopts it");
});

test("owedDestinations: no board and no intent ⇒ nothing owed, and the Content is refused", () => {
  assert.deepEqual(owedDestinations({ imageUrl: "https://cdn/x.jpg" }), []);
  assert.equal(payloadToPublishInput("u", { imageUrl: "https://cdn/x.jpg" }), null,
    "still the 'Missing image or board' failure — a board-less Pinterest Pin is unpublishable");
});

test("owedDestinations: a legacy draft that already published owes nothing (no double post)", () => {
  const owed = owedDestinations({
    imageUrl: "https://cdn/x.jpg",
    boardId: "b-A",
    destinationResults: [{ destinationId: "pinterest:legacy", provider: "pinterest", status: "published" }],
  });
  assert.deepEqual(owed, [], "a stale re-claim must not re-publish the Pin this row already created");
});

test("owedDestinations: a draft that DOES name an account is untouched by the legacy path", () => {
  const owed = owedDestinations({ imageUrl: "https://cdn/x.jpg", boardId: "b-A", targetConnectionId: "pin_A" });
  assert.equal(owed.length, 1);
  assert.equal(owed[0].socialConnectionId, "pin_A", "derived intent still wins — nothing synthetic is added");
});

// ── A1-1: a republish must not erase the post it replaces ────────────────────
// A Content that was Posted, then edited and re-scheduled, publishes into the SAME
// destination again. The card path has always kept the superseded row (with its
// permalink) under previousResults; the cron dropped it, so the earlier Pin became
// unreachable from the app only when the scheduler was the publisher.
const PUBLISHED_PIN = {
  destinationId: "pinterest:pin_A", provider: "pinterest", socialConnectionId: "pin_A",
  status: "published", remoteId: "pin-1", postUrl: "https://pin/1",
  publishedAt: "2026-07-01T09:00:00.000Z",
};
const NOW_ISO = "2026-07-11T12:00:00.000Z";

test("payloadAfterOutcomes: a republish keeps the old permalink in previousResults", () => {
  const after = payloadAfterOutcomes(
    { destinationResults: [PUBLISHED_PIN], scheduledDate: "2026-07-11", plannedAt: "2026-07-11T09:00" },
    [{ provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "pin-2", externalPostUrl: "https://pin/2" }],
    NOW_ISO,
  );
  const rows = after.destinationResults as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, "the destination still has exactly one CURRENT row");
  assert.equal(rows[0].postUrl, "https://pin/2", "which is the Pin this run created");
  const previous = after.previousResults as Array<Record<string, unknown>>;
  assert.equal(previous.length, 1);
  assert.equal(previous[0].postUrl, "https://pin/1", "the earlier Pin is still live — its permalink must survive");
  assert.equal(previous[0].status, "published");
});

test("payloadAfterOutcomes: a first publish records no history at all", () => {
  const after = payloadAfterOutcomes({}, [
    { provider: "instagram", status: "published", socialConnectionId: "ig_A", externalPostId: "ig-1", externalPostUrl: "https://ig/1" },
  ], NOW_ISO);
  assert.equal(after.previousResults, undefined, "nothing was replaced, so nothing is archived");
});

test("payloadAfterOutcomes: an untouched destination is never archived", () => {
  const after = payloadAfterOutcomes(
    { destinationResults: [PUBLISHED_PIN] },
    [{ provider: "instagram", status: "published", socialConnectionId: "ig_A", externalPostId: "ig-1" }],
    NOW_ISO,
  );
  assert.equal(after.previousResults, undefined, "the Pinterest row was kept, not replaced");
  const rows = after.destinationResults as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.destinationId === "pinterest:pin_A")?.postUrl, "https://pin/1");
});

test("payloadAfterOutcomes: a FAILED re-attempt still archives the live post it replaced", () => {
  const after = payloadAfterOutcomes(
    { destinationResults: [PUBLISHED_PIN] },
    [{ provider: "pinterest", status: "failed", socialConnectionId: "pin_A", error: "Reconnect your Pinterest account." }],
    NOW_ISO,
  );
  const previous = after.previousResults as Array<Record<string, unknown>>;
  assert.equal(previous?.length, 1, "the earlier Pin is still on Pinterest, however the retry went");
  assert.equal(previous[0].postUrl, "https://pin/1");
});

test("payloadAfterOutcomes: history accumulates across republishes", () => {
  const after = payloadAfterOutcomes(
    {
      destinationResults: [{ ...PUBLISHED_PIN, remoteId: "pin-2", postUrl: "https://pin/2" }],
      previousResults: [PUBLISHED_PIN],
    },
    [{ provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "pin-3", externalPostUrl: "https://pin/3" }],
    NOW_ISO,
  );
  const previous = after.previousResults as Array<Record<string, unknown>>;
  assert.deepEqual(previous.map(r => r.postUrl), ["https://pin/1", "https://pin/2"]);
  assert.equal((after.destinationResults as Array<Record<string, unknown>>)[0].postUrl, "https://pin/3");
});

test("payloadAfterSuccess: the Pinterest-only path archives the superseded Pin too", () => {
  const after = payloadAfterSuccess(
    { destinationResults: [PUBLISHED_PIN], targetConnectionId: "pin_A" },
    { id: "pin-2", url: "https://pin/2" },
    NOW_ISO,
  );
  const previous = after.previousResults as Array<Record<string, unknown>>;
  assert.equal(previous?.length, 1);
  assert.equal(previous[0].postUrl, "https://pin/1");
  assert.equal(after.remotePinUrl, "https://pin/2");
});


// ── The run's time budget (source contract) ──────────────────────────────────
// The route needs Supabase and a bearer secret, so the wiring is asserted on the
// source. What must never regress: the budget exists, it leaves headroom under the
// platform's kill time, and it is checked BEFORE a row is claimed — a claimed row we
// are killed before persisting is re-published 10 minutes later (a real double post).
const routeSrc = readFileSync("src/app/api/cron/publish-due/route.ts", "utf8");

test("CLAIM_BUDGET_MS leaves headroom under maxDuration", () => {
  const declared = /export const maxDuration = (\d+)/.exec(routeSrc);
  assert.ok(declared, "the route must declare maxDuration");
  const ceilingMs = Number(declared![1]) * 1000;
  assert.ok(CLAIM_BUDGET_MS > 0, "a budget of 0 would claim nothing");
  assert.ok(CLAIM_BUDGET_MS < ceilingMs,
    `the budget (${CLAIM_BUDGET_MS}ms) must stop the run before the platform does (${ceilingMs}ms)`);
  // Enough room for the slowest single row (an Instagram container poll, ~45s).
  assert.ok(ceilingMs - CLAIM_BUDGET_MS >= 45_000,
    "too little headroom: the row being published when the budget runs out could still be killed");
});

test("the budget is checked BEFORE each claim, not after", () => {
  const budgetAt = routeSrc.indexOf("CLAIM_BUDGET_MS");
  const claimAt = routeSrc.indexOf("publish_claimed_at: claimIso");
  assert.ok(budgetAt > 0 && claimAt > 0, "both the budget check and the claim must exist");
  assert.ok(routeSrc.lastIndexOf("CLAIM_BUDGET_MS") < claimAt,
    "checking the budget after claiming would leave the claimed row exposed to the kill");
  assert.match(routeSrc, /Date\.now\(\) - startedMs >= CLAIM_BUDGET_MS/,
    "the check must measure wall clock from the top of the run");
});

test("claiming and publishing are interleaved, so the budget can actually fire", () => {
  // Claiming every row up front takes milliseconds — a budget check there could never
  // be true, which is how a guard ships dead. One loop: check → claim → publish.
  const claimAt = routeSrc.indexOf("publish_claimed_at: claimIso");
  const publishAt = routeSrc.indexOf("await publishPinForUser(");
  assert.ok(claimAt > 0 && publishAt > claimAt, "the publish must follow the claim in the SAME loop");
  const between = routeSrc.slice(claimAt, publishAt);
  assert.ok(!/for \(const row of claimed\)/.test(between),
    "a second loop over pre-claimed rows means the time check cannot defer anything");
});

test("each row is claimed on ITS own clock, so a late claim keeps a full lock", () => {
  // With claiming interleaved a row can be claimed minutes into the run; stamping it
  // with the start of the run would shorten its 10-minute lock by exactly that much.
  assert.match(routeSrc, /const claimIso = new Date\(\)\.toISOString\(\);/);
  assert.match(routeSrc, /const rowNowIso = new Date\(\)\.toISOString\(\);/,
    "and its persist must carry a current updatedAt, or a mid-run client edit wins the LWW merge");
});

test("a deferred row is reported, never silently dropped", () => {
  assert.match(routeSrc, /deferred\+\+/, "deferred rows must be counted");
  assert.match(routeSrc, /claimed: claimedCount, published, failed, skipped, deferred/,
    "the count must reach the response so a run that keeps deferring is visible");
});

// ── persist must never lose the record of a publish that happened ────────────
test("persistOutcomes retries once and then logs the outcomes it could not store", () => {
  const at = routeSrc.indexOf("async function persistOutcomes(");
  assert.ok(at > 0);
  const body = routeSrc.slice(at, routeSrc.indexOf("async function persistFailure("));
  assert.match(body, /for \(let attempt = 1; attempt <= 2; attempt\+\+\)/, "exactly one retry");
  assert.match(body, /PERSIST_RETRY_DELAY_MS/, "the retry waits before trying again");
  assert.match(body, /JSON\.stringify\(outcomes\)/,
    "the final failure must log what could not be stored, or the publish is unreconstructable");
  assert.match(body, /draft_id=/, "and which row it belongs to");
  assert.ok(!/publish_claimed_at: null[\s\S]*catch/.test(body.slice(body.indexOf("for (let attempt"))),
    "the claim must not be released on failure — that hands the row back to be re-published");
  // A real `throw` statement — not the word in a comment.
  assert.ok(!/\bthrow\s+(new\b|err\b|error\b)/.test(body),
    "a throw would reach the row catch, which persists a FAILURE over a delivered publish");
});


console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
