/**
 * test-card-lifecycle-view.ts — the pure view model behind the Create Pins card
 * (PRD 0826 §3–§6, §20, §25–§26).
 *
 * Run: npx tsx scripts/test-card-lifecycle-view.ts
 *
 * What this pins down is the thing the card kept getting wrong when each branch of
 * the JSX decided for itself: a Content whose Pinterest row published and whose
 * Instagram row failed is POSTED and needs attention — it is not a failed card, and
 * its primary action is Retry (the failed destination only), not Publish. The four
 * clean lifecycles are here mostly to keep that fifth case honest.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCardViewModel,
  cardVariant,
  relativePublishedParts,
  type LifecycleInput,
} from "../src/lib/studio/cardView";
import {
  supersededResults,
  MAX_PREVIOUS_RESULTS,
  type ContentDraftLike,
  type DestinationPublishResult,
} from "../src/lib/contentDraftModel";

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Deliberately built as ContentDraftLike (not full PinDraft): the view model must
// work off the content-level contract, so a shape change on the persisted record
// cannot silently change what a card shows.

function draft(overrides: Partial<ContentDraftLike> = {}): ContentDraftLike {
  return {
    id: "d1",
    imageUrl: "https://cdn.test/one.jpg",
    media: [{ id: "m1", kind: "image", url: "https://cdn.test/one.jpg" }],
    ...overrides,
  };
}

function media(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`, kind: "image" as const, url: `https://cdn.test/${i + 1}.jpg`,
  }));
}

const pinterestPublished: DestinationPublishResult = {
  destinationId: "pinterest:conn-a", provider: "pinterest", socialConnectionId: "conn-a",
  accountLabel: "@shop", boardName: "Gift ideas", status: "published",
  publishedAt: "2026-08-27T10:00:00.000Z", remoteId: "pin-1",
  postUrl: "https://www.pinterest.com/pin/pin-1/",
};
const instagramFailed: DestinationPublishResult = {
  destinationId: "instagram:conn-b", provider: "instagram", socialConnectionId: "conn-b",
  accountLabel: "@shopgram", status: "failed",
  errorCode: "invalid_image_url", errorMessage: "RAW upstream: 400 /media/publish rejected",
};

// ── 1. The four lifecycles ────────────────────────────────────────────────────

test("draft (unscheduled): Schedule primary, no results, no attention", () => {
  const vm = buildCardViewModel(draft(), "unscheduled");
  assert.equal(vm.variant, "draft");
  assert.equal(vm.primaryAction, "schedule");
  assert.deepEqual(vm.resultRows, []);
  assert.equal(vm.needsAttention, false);
  assert.equal(vm.hasPublished, false);
  assert.equal(vm.latestPublishedAt, null);
});

test("scheduled: Publish primary (§20 — never 'Publish now')", () => {
  const vm = buildCardViewModel(
    draft({ scheduledDestinations: [{ provider: "pinterest", socialConnectionId: "conn-a", capturedAt: "2026-08-26T09:00:00.000Z" }] }),
    "scheduled",
  );
  assert.equal(vm.variant, "scheduled");
  assert.equal(vm.primaryAction, "publish");
  assert.equal(vm.needsAttention, false);
});

test("posted: Publish primary, one published row with its permalink", () => {
  const vm = buildCardViewModel(draft({ destinationResults: [pinterestPublished] }), "posted");
  assert.equal(vm.variant, "posted");
  assert.equal(vm.primaryAction, "publish");
  assert.equal(vm.hasPublished, true);
  assert.equal(vm.needsAttention, false);
  assert.equal(vm.resultRows.length, 1);
  assert.equal(vm.resultRows[0].status, "published");
  assert.equal(vm.resultRows[0].postUrl, "https://www.pinterest.com/pin/pin-1/");
  assert.equal(vm.latestPublishedAt, "2026-08-27T10:00:00.000Z");
});

test("failed: Retry primary and attention, with NO link on the failed row", () => {
  const vm = buildCardViewModel(draft({ destinationResults: [instagramFailed] }), "failed");
  assert.equal(vm.variant, "failed");
  assert.equal(vm.primaryAction, "retry");
  assert.equal(vm.needsAttention, true);
  assert.equal(vm.hasPublished, false);
  assert.equal(vm.resultRows[0].postUrl, undefined, "a failed row never offers a link");
  // The raw upstream message rides along for the CALLER to map — the card renders
  // getPublishErrorDisplayKey(), never this string.
  assert.equal(vm.resultRows[0].errorCode, "invalid_image_url");
});

test("generating: its own variant, nothing actionable", () => {
  const vm = buildCardViewModel(draft(), "generating");
  assert.equal(vm.variant, "generating");
  assert.equal(vm.primaryAction, "generating");
});

// ── 2. Partial success — the case the inline JSX kept getting wrong ───────────

test("partial success is POSTED + needs attention, and its primary is Retry", () => {
  const vm = buildCardViewModel(
    draft({ destinationResults: [pinterestPublished, instagramFailed] }),
    "posted",
  );
  assert.equal(vm.variant, "posted", "posted beats failed");
  assert.equal(vm.needsAttention, true, "the failed destination still needs attention");
  assert.equal(vm.hasPublished, true);
  assert.equal(vm.primaryAction, "retry", "Retry re-sends only the failed destination");
  assert.equal(vm.resultRows.length, 2);
});

test("a failed destination outranks the editing state's Publish primary", () => {
  const vm = buildCardViewModel(
    draft({ destinationResults: [pinterestPublished, instagramFailed] }),
    "posted",
    { editing: true },
  );
  assert.equal(vm.primaryAction, "retry");
});

test("editing a clean Posted card offers Publish (a fresh publish of what is on screen)", () => {
  const vm = buildCardViewModel(draft({ destinationResults: [pinterestPublished] }), "posted", { editing: true });
  assert.equal(vm.primaryAction, "publish");
});

// ── 3. Counter: cover is always 1 ─────────────────────────────────────────────

test("counter is null for one image and '1 / N' for many (cover ≡ media[0])", () => {
  assert.equal(buildCardViewModel(draft(), "unscheduled").counter, null);
  const many = buildCardViewModel(draft({ media: media(4) }), "unscheduled");
  assert.equal(many.counter, "1 / 4");
  assert.equal(many.mediaCount, 4);
});

test("a legacy draft with no media[] still counts its one synthesized image", () => {
  const vm = buildCardViewModel({ id: "legacy", imageUrl: "https://cdn.test/legacy.jpg" }, "posted");
  assert.equal(vm.mediaCount, 1);
  assert.equal(vm.counter, null);
});

// ── 4. Legacy drafts derive rows from the legacy fields ──────────────────────

test("a pre-model published draft still shows a published row", () => {
  const vm = buildCardViewModel(
    { id: "legacy", imageUrl: "https://cdn.test/l.jpg", remotePinId: "9", postedAt: "2026-08-20T08:00:00.000Z", boardName: "Home" },
    "posted",
  );
  assert.equal(vm.hasPublished, true);
  assert.equal(vm.resultRows[0].postUrl, "https://www.pinterest.com/pin/9/");
});

// ── 5. Earlier publishes (history preserved across a republish) ───────────────

test("previousResults surface as superseded rows under 'Earlier publishes'", () => {
  const republished = { ...pinterestPublished, remoteId: "pin-2", postUrl: "https://www.pinterest.com/pin/pin-2/", publishedAt: "2026-08-27T12:00:00.000Z" };
  const vm = buildCardViewModel(
    draft({ destinationResults: [republished], previousResults: [pinterestPublished] }),
    "posted",
  );
  assert.equal(vm.earlierResultRows.length, 1);
  assert.equal(vm.earlierResultRows[0].superseded, true);
  assert.equal(vm.earlierResultRows[0].postUrl, "https://www.pinterest.com/pin/pin-1/", "the earlier Pin keeps its own permalink");
  assert.equal(vm.latestPublishedAt, "2026-08-27T12:00:00.000Z");
});

test("supersededResults keeps only published rows the fresh attempt replaces", () => {
  const fresh = [{ ...pinterestPublished, remoteId: "pin-2" }, instagramFailed];
  const kept = supersededResults([pinterestPublished, instagramFailed], fresh, []);
  assert.equal(kept.length, 1, "the failed prior row describes no live post — not history");
  assert.equal(kept[0].remoteId, "pin-1");
});

test("supersededResults leaves untouched destinations alone and is capped", () => {
  // Retrying only Instagram must not push the still-current Pinterest row into history.
  assert.deepEqual(supersededResults([pinterestPublished], [instagramFailed], []), []);
  const history = Array.from({ length: MAX_PREVIOUS_RESULTS + 5 }, (_, i) => ({ ...pinterestPublished, remoteId: `old-${i}` }));
  const capped = supersededResults([pinterestPublished], [{ ...pinterestPublished, remoteId: "new" }], history);
  assert.equal(capped.length, MAX_PREVIOUS_RESULTS);
  assert.equal(capped[capped.length - 1].remoteId, "pin-1", "the newest superseded row is last");
});

// ── 6. Variant naming + relative time ────────────────────────────────────────

test("cardVariant renames only 'unscheduled' → 'draft'", () => {
  const cases: Array<[LifecycleInput, string]> = [
    ["unscheduled", "draft"], ["scheduled", "scheduled"], ["posted", "posted"],
    ["failed", "failed"], ["generating", "generating"],
  ];
  for (const [input, expected] of cases) assert.equal(cardVariant(input), expected);
});

test("relativePublishedParts buckets by minute/hour/day and never goes negative", () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  assert.deepEqual(relativePublishedParts("2026-08-27T11:59:40.000Z", now), { unit: "now", value: 0 });
  assert.deepEqual(relativePublishedParts("2026-08-27T11:30:00.000Z", now), { unit: "minute", value: 30 });
  assert.deepEqual(relativePublishedParts("2026-08-27T09:00:00.000Z", now), { unit: "hour", value: 3 });
  assert.deepEqual(relativePublishedParts("2026-08-25T12:00:00.000Z", now), { unit: "day", value: 2 });
  // Clock skew: a future stamp reads "just now", not a negative age.
  assert.deepEqual(relativePublishedParts("2026-08-27T12:05:00.000Z", now), { unit: "now", value: 0 });
  assert.equal(relativePublishedParts(null, now), null);
  assert.equal(relativePublishedParts("not-a-date", now), null);
});
