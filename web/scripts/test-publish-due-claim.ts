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
  RUN_DEADLINE_MS,
  DESTINATION_RESERVE_MS,
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
import { pendingDestinations, publishedForSchedule } from "../src/lib/social/publishRules";
import {
  mergeOutcomesIntoRow,
  writeFailure,
  writeOutcomes,
} from "../src/app/api/cron/publish-due/persistRow";
import { buildScheduledAt, buildScheduleColumns, SCHEDULE_COLUMN_KEYS } from "../src/app/api/pin-drafts/promote";

let passed = 0, failed = 0;
/** Async cases are queued and awaited at the end, so `tsx` needs no top-level await. */
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  const ok = () => { passed++; console.log(`  OK ${name}`); };
  const bad = (e: unknown) => {
    failed++;
    console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`);
  };
  try {
    const result = fn();
    if (result instanceof Promise) pending.push(result.then(ok, bad));
    else ok();
  } catch (e) { bad(e); }
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
const persistSrc = readFileSync("src/app/api/cron/publish-due/persistRow.ts", "utf8");

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
  const loopBody = routeSrc.slice(
    routeSrc.indexOf("for (const candidate of candidates) {"),
    routeSrc.indexOf("if (deferred > 0) {"),
  );
  assert.ok(!/[^w], nowIso/.test(loopBody),
    "no call inside the row loop may still take the start-of-run clock");
});

test("no persist carries a clock captured before the publish", () => {
  // This supersedes the row-clock fix (a per-ROW stamp taken at claim time). Even that
  // is already stale by the time a slow publish returns: it is older than an edit the
  // merchant made while their Content was going out, so the client's LWW merge pushes
  // that edit back — scheduledDate, plannedAt and all — and the Pin publishes twice.
  // The only stamp that cannot lose is one taken at WRITE time.
  assert.ok(!/rowNowIso/.test(routeSrc),
    "a clock captured at claim time is stale by the time the persist runs");
  assert.ok(!/payloadAfter(Outcomes|Failure)\(/.test(routeSrc),
    "the route must not build a payload itself — persistRow re-reads the row first");
  assert.match(persistSrc, /const nowIso = new Date\(\)\.toISOString\(\);/,
    "the timestamp must be taken between the re-read and the write");
});

test("every persist merges onto the RE-READ payload, never the claimed snapshot", () => {
  // The claimed snapshot is minutes old by the time a publish returns. Writing it back
  // does not merge the results into the merchant's draft, it REPLACES their draft.
  const at = persistSrc.indexOf("async function readMergeWrite(");
  assert.ok(at > 0, "there must be one read-merge-write path, not one per call site");
  const body = persistSrc.slice(at, persistSrc.indexOf("export async function mergeOutcomesIntoRow("));
  assert.match(body, /const \{ snapshot, error \} = await io\.read\(row\);/,
    "it must re-read the row");
  assert.ok(body.indexOf("io.read(row)") < body.indexOf("io.update(row"),
    "the read must precede the write");
  assert.match(body, /if \(!snapshot\) return \{ error: null, gone: true \};/,
    "a row deleted during the publish must not be re-created from this run's copy");
  // Structural, not stylistic: the row REFERENCE carries no payload at all, so there
  // is no stale copy for a persist to reach for even by accident.
  const ref = persistSrc.slice(
    persistSrc.indexOf("export interface DueRowRef"),
    persistSrc.indexOf("export interface RowSnapshot"),
  );
  assert.ok(ref.length > 0 && !/payload/.test(ref),
    "DueRowRef must identify the row and its claimed schedule — never carry its payload");
});

test("the schedule clears only when it is still the one this run claimed", () => {
  assert.match(persistSrc, /const scheduleUnchanged = \(snapshot\.scheduled_at \?\? null\) === \(row\.scheduled_at \?\? null\);/,
    "rescheduling during a publish must not be silently cancelled by that publish");
  assert.match(persistSrc, /const clearSchedule = !options\.deferred && scheduleUnchanged;/);
  assert.match(persistSrc, /\.\.\.\(clearSchedule \? \{ scheduled_at: null \} : \{\}\)/,
    "when it must not clear, the column is OMITTED — never written back from this run's copy");
  assert.match(persistSrc, /publish_claimed_at: null/,
    "the claim is released either way, so the next run can finish what is still owed");
});

test("each destination's outcome is stored the moment it is known", () => {
  // Between a provider's ack and the end of the row sat every remaining destination.
  // A kill in that window lost the record of a post that really exists — and the next
  // run, owing it again, published it a second time.
  assert.match(routeSrc, /const persistOne = async \(outcome: DestinationOutcome\): Promise<void> => \{/);
  assert.match(routeSrc, /await mergeOutcomesIntoRow\(io, row, \[outcome\]\)/,
    "one outcome, merged onto the row as it is now");
  assert.match(routeSrc, /onOutcome: persistOne/,
    "the fan-out must report each destination as it finishes, not the batch at the end");
  const pinterestLoop = routeSrc.slice(
    routeSrc.indexOf("for (const destination of pinterestTargets) {"),
    routeSrc.indexOf("// Every attempted Pinterest destination was blocked"),
  );
  assert.ok(!/outcomes\.push\(/.test(pinterestLoop),
    "a Pinterest outcome collected without being stored is one a process death loses");
  assert.equal((pinterestLoop.match(/await record\(/g) ?? []).length, 5,
    "every branch of the Pinterest loop must go through the recorder");
  const incremental = persistSrc.slice(persistSrc.indexOf("export async function mergeOutcomesIntoRow("));
  const upToFinal = incremental.slice(0, incremental.indexOf("export interface FinalWriteOptions"));
  assert.ok(!/scheduled_at|publish_claimed_at|postedAt/.test(upToFinal),
    "the incremental write records results ONLY — the Content is not finished yet");
});

// ── the merge rules, against a fake row store ────────────────────────────────
// persistRow.ts reaches the database through two injected functions precisely so the
// rules above can be executed rather than pattern-matched.

type Stored = { payload: Record<string, unknown>; scheduled_at: string | null; publish_claimed_at: string | null };
function fakeStore(initial: Stored) {
  const state: Stored = { ...initial, payload: { ...initial.payload } };
  const writes: Array<Record<string, unknown>> = [];
  const io = {
    read: async () => ({ snapshot: { ...state, payload: { ...state.payload } }, error: null }),
    update: async (_row: unknown, values: Record<string, unknown>) => {
      writes.push(values);
      if ("payload" in values) state.payload = values.payload as Record<string, unknown>;
      if ("scheduled_at" in values) state.scheduled_at = values.scheduled_at as string | null;
      return { error: null };
    },
  };
  return { io, state, writes };
}
const CLAIMED_AT = "2026-07-11T09:00:00.000Z";
const REF = { vibepin_user_id: "u1", draft_id: "d1", scheduled_at: CLAIMED_AT };
const PIN_OK = {
  provider: "pinterest", status: "published", socialConnectionId: "pin_A",
  externalPostId: "pin-9", externalPostUrl: "https://pin/9",
} as const;

test("merge: an edit made DURING the publish survives, and gets the results", async () => {
  // The exact data loss: the merchant retitles their Content while it is going out.
  // The old persist wrote back the payload it had claimed minutes earlier.
  const { io, state, writes } = fakeStore({
    payload: { title: "edited while publishing", updatedAt: "2026-07-11T11:59:00.000Z" },
    scheduled_at: CLAIMED_AT, publish_claimed_at: CLAIMED_AT,
  });
  await mergeOutcomesIntoRow(io, REF, [PIN_OK]);
  assert.equal(state.payload.title, "edited while publishing", "their edit must not be overwritten");
  const rows = state.payload.destinationResults as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].postUrl, "https://pin/9", "and the publish that happened is recorded");
  assert.equal(writes.length, 1);
  assert.ok(!("scheduled_at" in writes[0]) && !("publish_claimed_at" in writes[0]),
    "an incremental write touches results only");
});

test("merge: the stamp is newer than the edit, so the client's LWW takes the server row", async () => {
  const edited = new Date(Date.now() - 1000).toISOString();
  const { io, state } = fakeStore({
    payload: { title: "t", updatedAt: edited }, scheduled_at: CLAIMED_AT, publish_claimed_at: CLAIMED_AT,
  });
  await mergeOutcomesIntoRow(io, REF, [PIN_OK]);
  assert.ok(String(state.payload.updatedAt) > edited,
    "a stamp older than the browser's copy loses the merge — and the client pushes the schedule back");
});

test("final: a schedule the merchant changed mid-publish is kept, results and all", async () => {
  const { io, state, writes } = fakeStore({
    payload: { scheduledDate: "2026-08-01", plannedAt: "2026-08-01T10:00" },
    scheduled_at: "2026-08-01T10:00:00.000Z", // rescheduled while publishing
    publish_claimed_at: CLAIMED_AT,
  });
  await writeOutcomes(io, REF, [PIN_OK]);
  assert.ok(!("scheduled_at" in writes[0]),
    "the column must be omitted — this run never read the slot they just chose");
  assert.equal(state.payload.scheduledDate, "2026-08-01", "their new schedule stands");
  assert.equal(state.payload.postedAt !== undefined, true, "and the publish is still recorded");
  assert.equal(writes[0].publish_claimed_at, null, "the claim is released regardless");
});

test("final: an unchanged schedule clears exactly as it always did", async () => {
  const { io, state, writes } = fakeStore({
    payload: { scheduledDate: "2026-07-11", plannedAt: "2026-07-11T09:00" },
    scheduled_at: CLAIMED_AT, publish_claimed_at: CLAIMED_AT,
  });
  await writeOutcomes(io, REF, [PIN_OK]);
  assert.equal(writes[0].scheduled_at, null);
  assert.equal(state.payload.scheduledDate, "");
  assert.equal(state.payload.plannedAt, "");
});

test("final: a deferred row keeps its schedule even when nothing changed", async () => {
  const { io, state, writes } = fakeStore({
    payload: { scheduledDate: "2026-07-11", plannedAt: "2026-07-11T09:00" },
    scheduled_at: CLAIMED_AT, publish_claimed_at: CLAIMED_AT,
  });
  const deferredIg = {
    provider: "instagram", status: "pending", socialConnectionId: "ig_A", error: "Deferred",
  } as const;
  await writeOutcomes(io, REF, [PIN_OK, deferredIg], { deferred: true });
  assert.ok(!("scheduled_at" in writes[0]), "Instagram has not gone out — the Content is still due");
  assert.equal(state.payload.scheduledDate, "2026-07-11");
  assert.equal(state.payload.remotePinUrl, "https://pin/9", "the Pin that did publish keeps its permalink");
});

test("final: the incremental row it already wrote is not archived as superseded", async () => {
  // The final persist re-reads, so it sees its OWN incremental row as the prior one.
  // Archiving that would put the live Pin in previousResults as well — "Earlier
  // publishes" listing a post nothing has replaced.
  const { io, state } = fakeStore({
    payload: {}, scheduled_at: CLAIMED_AT, publish_claimed_at: CLAIMED_AT,
  });
  await mergeOutcomesIntoRow(io, REF, [PIN_OK]);
  await writeOutcomes(io, REF, [PIN_OK]);
  assert.equal(state.payload.previousResults, undefined,
    "the same post recorded twice is one post, not a supersession");
  assert.equal((state.payload.destinationResults as unknown[]).length, 1);
});

test("final: a genuinely superseded post IS archived, even after an incremental write", async () => {
  const { io, state } = fakeStore({
    payload: { destinationResults: [PUBLISHED_PIN] }, scheduled_at: CLAIMED_AT, publish_claimed_at: CLAIMED_AT,
  });
  await mergeOutcomesIntoRow(io, REF, [PIN_OK]);
  await writeOutcomes(io, REF, [PIN_OK]);
  const previous = state.payload.previousResults as Array<Record<string, unknown>>;
  assert.equal(previous?.length, 1, "the Pin that is still live on Pinterest keeps its permalink");
  assert.equal(previous[0].postUrl, "https://pin/1");
});

test("failure: a row deleted mid-publish is not resurrected", async () => {
  let updates = 0;
  const io = {
    read: async () => ({ snapshot: null, error: null }),
    update: async () => { updates++; return { error: null }; },
  };
  const outcome = await writeOutcomes(io, REF, [PIN_OK]);
  assert.equal(outcome.gone, true);
  assert.equal(updates, 0, "writing would re-create a Content the merchant threw away");
});

test("failure: the failure persist also merges onto the re-read payload", async () => {
  const { io, state } = fakeStore({
    payload: { title: "edited while failing", scheduledDate: "2026-07-11" },
    scheduled_at: CLAIMED_AT, publish_claimed_at: CLAIMED_AT,
  });
  await writeFailure(io, REF, { message: "Reconnect your Pinterest account.", code: "needs_reconnect" });
  assert.equal(state.payload.title, "edited while failing");
  assert.equal(state.payload.publishError, "Reconnect your Pinterest account.");
  assert.equal(state.payload.errorCategory, "auth");
  assert.equal(state.payload.scheduledDate, "");
});



test("a deferred row is reported, never silently dropped", () => {
  assert.match(routeSrc, /deferred\+\+/, "deferred rows must be counted");
  assert.match(routeSrc, /claimed: claimedCount, published, failed, skipped, deferred/,
    "the count must reach the response so a run that keeps deferring is visible");
});

// ── rescheduling a Posted Content must republish (Codex #3) ──────────────────
// "Already published" was read as a property of the DESTINATION. It is a property of
// the destination AND the schedule. So a Posted Content the merchant re-scheduled owed
// nothing at all: the cron cleared the slot they had just chosen, published nothing,
// failed nothing, and reported nothing. The archival into previousResults — which is
// what keeps the earlier post reachable — never ran either, because nothing replaced
// anything.
const POSTED_JULY = {
  destinationId: "pinterest:pin_A", provider: "pinterest", socialConnectionId: "pin_A",
  status: "published", remoteId: "pin-1", postUrl: "https://pin/1",
  publishedAt: "2026-07-01T09:00:00.000Z",
};
const POSTED_IG = {
  destinationId: "instagram:ig_A", provider: "instagram", socialConnectionId: "ig_A",
  status: "published", remoteId: "ig-1", postUrl: "https://ig/1",
  publishedAt: "2026-07-01T09:00:00.000Z",
};
const RESCHEDULED = "2026-08-01T10:00:00.000Z";   // after the original publish
const RECLAIMED = "2026-07-01T08:00:00.000Z";     // the schedule that publish was FOR

test("owedDestinations: a Posted Content re-scheduled later owes every destination", () => {
  const payload = {
    imageUrl: "https://cdn/x.jpg", boardId: "b-A",
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", capturedAt: "2026-07-01T00:00:00.000Z" },
      { provider: "instagram", socialConnectionId: "ig_A", capturedAt: "2026-07-01T00:00:00.000Z" },
    ],
    destinationResults: [POSTED_JULY, POSTED_IG],
  };
  const owed = owedDestinations(payload, { scheduledAt: RESCHEDULED });
  assert.equal(owed.length, 2, "both platforms were published in July — August is a new publish");
  assert.deepEqual(owed.map(d => d.provider).sort(), ["instagram", "pinterest"]);
});

test("owedDestinations: a stale re-claim of THAT publish still owes nothing", () => {
  // The protection that must not be lost: the run died after publishing, the claim
  // went stale, and the row is taken again. `publishedAt` is after this row's
  // scheduled_at, so it was published FOR this schedule.
  const owed = owedDestinations({
    imageUrl: "https://cdn/x.jpg", boardId: "b-A",
    scheduledDestinations: [{ provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", capturedAt: RECLAIMED }],
    destinationResults: [POSTED_JULY],
  }, { scheduledAt: RECLAIMED });
  assert.deepEqual(owed, [], "re-publishing here is the double post the rule exists to prevent");
});

test("owedDestinations: the partial case still retries only what did not go out", () => {
  const owed = owedDestinations({
    imageUrl: "https://cdn/x.jpg", boardId: "b-A",
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", capturedAt: RECLAIMED },
      { provider: "instagram", socialConnectionId: "ig_A", capturedAt: RECLAIMED },
    ],
    destinationResults: [
      POSTED_JULY,
      { destinationId: "instagram:ig_A", provider: "instagram", socialConnectionId: "ig_A", status: "failed" },
    ],
  }, { scheduledAt: RECLAIMED });
  assert.equal(owed.length, 1);
  assert.equal(owed[0].provider, "instagram");
});

test("owedDestinations: a legacy Content can be re-scheduled too", () => {
  // The board-only path had its own hard-coded "any published pinterest row ⇒ nothing
  // owed", so without the same rule a legacy Posted Content could never republish.
  const payload = {
    imageUrl: "https://cdn/x.jpg", boardId: "b-A",
    destinationResults: [{ destinationId: "pinterest:legacy", provider: "pinterest", status: "published", publishedAt: "2026-07-01T09:00:00.000Z" }],
  };
  assert.equal(owedDestinations(payload, { scheduledAt: RESCHEDULED }).length, 1,
    "re-scheduled after that publish ⇒ owed again");
  assert.deepEqual(owedDestinations(payload, { scheduledAt: RECLAIMED }), [],
    "re-claimed for the schedule it already published for ⇒ still nothing owed");
});

test("owedDestinations: rows with no publishedAt keep their old meaning exactly", () => {
  // Written before per-destination timestamps existed. There is no way to tell which
  // schedule they belong to, and guessing "an earlier one" would double-post.
  const legacyRow = { destinationId: "pinterest:pin_A", provider: "pinterest", socialConnectionId: "pin_A", status: "published" };
  const payload = {
    imageUrl: "https://cdn/x.jpg", boardId: "b-A",
    scheduledDestinations: [{ provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", capturedAt: RECLAIMED }],
    destinationResults: [legacyRow],
  };
  assert.deepEqual(owedDestinations(payload, { scheduledAt: RESCHEDULED }), []);
  assert.deepEqual(owedDestinations(payload), [], "and with no schedule given at all");
});

test("publishedForSchedule: the boundary is the schedule instant itself", () => {
  const row = { provider: "pinterest", status: "published", publishedAt: RECLAIMED };
  assert.equal(publishedForSchedule(row, RECLAIMED), true, "published AT the schedule ⇒ for it");
  assert.equal(publishedForSchedule({ ...row, publishedAt: "2026-07-01T07:59:59.999Z" }, RECLAIMED), false);
  assert.equal(publishedForSchedule({ provider: "pinterest", status: "failed", publishedAt: RESCHEDULED }, RECLAIMED), false,
    "only a published row can close a destination");
  assert.equal(publishedForSchedule({ ...row, publishedAt: "not-a-date" }, RECLAIMED), true,
    "an unreadable timestamp resolves to 'already done' — never to a second post");
});

test("payloadToPublishInput: boardRequired reads the SAME owed set", () => {
  // A re-scheduled Instagram-only Content: owed again, and it needs no board. Reading
  // a different owed set here would refuse it with "Missing image or board".
  const payload = {
    imageUrl: "https://cdn/x.jpg",
    scheduledDestinations: [{ provider: "instagram", socialConnectionId: "ig_A", capturedAt: RECLAIMED }],
    destinationResults: [POSTED_IG],
  };
  assert.ok(payloadToPublishInput("u", payload, { scheduledAt: RESCHEDULED }),
    "owed again, and no board is required for Instagram");
  // The reverse proves the two really share one owed set: with nothing owed, every()
  // is vacuously true, a board IS required, and this board-less Content is refused.
  // (That is the rule as it has always been for a stale re-claim, unchanged here — a
  // row whose destinations have all published no longer reaches this code by any
  // other route.)
  assert.equal(payloadToPublishInput("u", payload, { scheduledAt: RECLAIMED }), null,
    "if boardRequired read a different owed set, these two could not disagree");
});

test("republishing archives the earlier post instead of dropping its permalink", () => {
  // End to end: owed again ⇒ published ⇒ the row describing the July Pin, still live
  // on Pinterest, moves to previousResults rather than being overwritten.
  const payload = {
    imageUrl: "https://cdn/x.jpg", boardId: "b-A",
    scheduledDestinations: [{ provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", capturedAt: "2026-07-01T00:00:00.000Z" }],
    destinationResults: [POSTED_JULY],
    scheduledDate: "2026-08-01",
  };
  const owed = owedDestinations(payload, { scheduledAt: RESCHEDULED });
  assert.equal(owed.length, 1, "the destination must actually be attempted, or nothing supersedes anything");
  const after = payloadAfterOutcomes(payload, [
    { provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "pin-2", externalPostUrl: "https://pin/2" },
  ], "2026-08-01T10:00:05.000Z");
  const current = after.destinationResults as Array<Record<string, unknown>>;
  assert.equal(current.length, 1);
  assert.equal(current[0].postUrl, "https://pin/2", "the card shows the Pin this run created");
  const previous = after.previousResults as Array<Record<string, unknown>>;
  assert.equal(previous?.length, 1);
  assert.equal(previous[0].postUrl, "https://pin/1", "and the July Pin is still reachable");
});

test("the route threads the row's schedule into BOTH owed calls", () => {
  assert.match(routeSrc, /const owedFor = \{ scheduledAt: row\.scheduled_at \};/);
  assert.match(routeSrc, /payloadToPublishInput\(row\.vibepin_user_id, row\.payload, owedFor\)/,
    "or a re-scheduled Instagram-only Content is refused for a board it never needed");
  assert.match(routeSrc, /owedDestinations\(row\.payload, owedFor\)/,
    "the schedule is what makes a prior publish stale — without it, rescheduling is a no-op");
});

// ── the run's DESTINATION deadline (Codex #2) ────────────────────────────────
// CLAIM_BUDGET_MS bounds when the run stops taking ROWS. It cannot bound the row it
// already holds: one Content with three Instagram accounts is three ~45s container
// polls inside a single claim. Killed part-way, the accounts that already published
// keep the schedule and the claim, and are published AGAIN ten minutes later.

test("RUN_DEADLINE_MS leaves room for a destination to finish AND persist", () => {
  const declared = /export const maxDuration = (\d+)/.exec(routeSrc);
  assert.ok(declared, "the route must declare maxDuration");
  const ceilingMs = Number(declared![1]) * 1000;
  assert.ok(RUN_DEADLINE_MS > 0 && RUN_DEADLINE_MS < ceilingMs,
    `the deadline (${RUN_DEADLINE_MS}ms) must fall before the platform's kill (${ceilingMs}ms)`);
  // A destination may only START at `deadline - DESTINATION_RESERVE_MS` and takes at
  // most one reserve, so the LATEST it can finish is the deadline itself. What must be
  // left after that is room to persist the outcome (the write plus its one retry) —
  // being killed between the provider's ack and that write is the double post.
  assert.ok(ceilingMs - RUN_DEADLINE_MS >= 20_000,
    `too little room to persist after the last destination: ${ceilingMs - RUN_DEADLINE_MS}ms`);
  assert.ok(DESTINATION_RESERVE_MS >= 45_000,
    "the reserve must cover the slowest single provider call (Instagram's container poll)");
  assert.ok(RUN_DEADLINE_MS > CLAIM_BUDGET_MS,
    "the run must be allowed to finish the last row it was permitted to claim");
});

test("the route bounds the run and passes that bound INTO the fan-out", () => {
  assert.match(routeSrc, /const deadlineMs = startedMs \+ RUN_DEADLINE_MS;/,
    "the deadline must be absolute and measured from the top of the run");
  assert.match(routeSrc, /fanOutDestinations\([\s\S]{0,700}\{ deadlineMs,/,
    "a deadline the fan-out never receives bounds nothing — the fan-out is where the time goes");
  const pinterestLoop = routeSrc.slice(
    routeSrc.indexOf("for (const destination of pinterestTargets) {"),
    routeSrc.indexOf("await publishPinForUser("),
  );
  assert.match(pinterestLoop, /hasTimeForDestination\(Date\.now\(\), deadlineMs\)/,
    "each Pinterest account is its own publish and its own share of the run's time");
  assert.match(pinterestLoop, /deferredOutcome\(destination\)/);
});

test("a fully deferred row is released, not written — and never marked failed", () => {
  const at = routeSrc.indexOf("if (pending.length && !reported.length) {");
  assert.ok(at > 0, "the route must recognise a row where nothing was attempted");
  const body = routeSrc.slice(at, at + 700);
  assert.match(body, /await releaseClaim\(db, row\);/,
    "the claim must be released or the row waits 10 minutes for nothing");
  assert.ok(!/persistFailure|persistOutcomes/.test(body),
    "nothing happened, so nothing may be written over the merchant's payload");
});

test("a deferred persist omits scheduled_at instead of clearing it", () => {
  assert.match(persistSrc, /const clearSchedule = !options\.deferred && scheduleUnchanged;/,
    "clearing the schedule of a Content whose destinations have not gone out is the lost publish");
  assert.match(persistSrc, /publish_claimed_at: null/,
    "the claim is still released — the next run must be able to finish the job");
});

// The payload half of the same rule.
const DEFER = { status: "pending", socialConnectionId: "ig_A", provider: "instagram", error: "Deferred" } as const;

test("payloadAfterOutcomes(deferred): keeps the schedule, records what published", () => {
  const after = payloadAfterOutcomes(
    { scheduledDate: "2026-07-11", scheduledTime: "09:00", plannedAt: "2026-07-11T09:00" },
    [
      { provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "p1", externalPostUrl: "https://pin/1" },
      DEFER,
    ],
    NOW_ISO,
    null,
    undefined,
    { deferred: true },
  );
  assert.equal(after.scheduledDate, "2026-07-11", "the Content is still scheduled — Instagram has not gone out");
  assert.equal(after.plannedAt, "2026-07-11T09:00");
  assert.equal(after.postedAt, undefined, "a Content with a destination still owed is not posted");
  assert.equal(after.publishError, undefined, "and it did not fail — nothing was sent to Instagram");
  assert.equal(after.remotePinUrl, "https://pin/1",
    "the Pin that DID publish must keep its permalink: the completing run no longer owes it");
  const rows = after.destinationResults as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, "the deferred destination gets no result row — nothing happened to record");
  assert.equal(rows[0].destinationId, "pinterest:pin_A");
  assert.equal(rows[0].status, "published");
});

test("payloadAfterOutcomes: a deferred destination is never recorded as FAILED", () => {
  const after = payloadAfterOutcomes({}, [DEFER], NOW_ISO, null, undefined, { deferred: true });
  assert.deepEqual(after.destinationResults, [],
    "writing it as failed would tell the merchant a platform rejected a post nobody sent");
  assert.equal(after.publishError, undefined);
});

test("payloadAfterOutcomes: with nothing deferred the schedule clears exactly as today", () => {
  const after = payloadAfterOutcomes(
    { scheduledDate: "2026-07-11", plannedAt: "2026-07-11T09:00" },
    [{ provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "p1" },
     { provider: "instagram", status: "failed", socialConnectionId: "ig_A", error: "Token expired" }],
    NOW_ISO,
  );
  assert.equal(after.scheduledDate, "");
  assert.equal(after.plannedAt, "");
  assert.equal(after.postedAt, NOW_ISO);
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


Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
