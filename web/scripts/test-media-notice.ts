/**
 * test-media-notice.ts — what the card says when a platform refuses a media set.
 *
 * The properties that make the notice trustworthy rather than nagging (PRD §9/§13):
 *
 *   - one notice per PLATFORM, not per destination (two accounts on one platform
 *     share that platform's rule)
 *   - a platform that accepts the set produces NOTHING, even when a sibling platform
 *     refuses it — the per-platform rule may not become a whole-Content warning
 *   - unmeasured images produce nothing when the count rule passes: mediaRules
 *     returns ok/unverifiedRatio there, and a warning we cannot substantiate is noise
 *   - `too_many` still points at real thumbnails. contentMediaIssues attributes RATIO
 *     only, so its offendingMediaIds is empty for an overflow; the notice derives the
 *     items past the cap itself, or "2 images need adjustment" highlights nothing
 *
 * Pure: no DOM, no store, no network — mediaNotices takes a draft-shaped object.
 *
 * Run: npx tsx scripts/test-media-notice.ts (from web/)
 */

import assert from "node:assert";
import { mediaNotices, offendingMediaIds, PROVIDER_MEDIA_LIMITS } from "../src/lib/studio/mediaNotice";
import type { ContentDraftLike, ContentMedia } from "../src/lib/contentDraftModel";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  OK   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${(e as Error).message}`); }
}

const PIN_CONN = "conn-pin";
const IG_CONN = "conn-ig";

/** `ratios`: [w, h] per item, or null for an unmeasured one. */
function draftWith(
  ratios: Array<[number, number] | null>,
  providers: Array<{ provider: string; socialConnectionId: string }>,
): ContentDraftLike {
  const media: ContentMedia[] = ratios.map((dims, i) => ({
    id: `m${i}`,
    kind: "image",
    url: `https://cdn.test/${i}.jpg`,
    ...(dims ? { width: dims[0], height: dims[1] } : {}),
  }));
  return {
    id: "c1",
    imageUrl: media[0]?.url ?? "",
    media,
    boardId: "board-1",
    boardName: "Board",
    scheduledDestinations: providers.map(p => ({ ...p, capturedAt: "2026-08-27T10:00:00.000Z" })),
  } as ContentDraftLike;
}

const SQUARE: [number, number] = [1000, 1000];
const TALL: [number, number] = [1000, 1500];

console.log("\n=== a set every platform accepts is silent ===");

test("three same-ratio images on Pinterest + Instagram produce no notice", () => {
  const notices = mediaNotices(draftWith([TALL, TALL, TALL], [
    { provider: "pinterest", socialConnectionId: PIN_CONN },
    { provider: "instagram", socialConnectionId: IG_CONN },
  ]));
  assert.equal(notices.length, 0, `expected silence, got ${JSON.stringify(notices)}`);
});

test("a single image is never a carousel problem", () => {
  assert.equal(mediaNotices(draftWith([TALL], [{ provider: "pinterest", socialConnectionId: PIN_CONN }])).length, 0);
});

console.log("\n=== unknown dimensions never nag ===");

test("unmeasured images with a passing count produce nothing", () => {
  // This is the whole `unverifiedRatio` requirement: we did not measure, so we do not
  // know, so we do not warn. Pinterest's own rejection, if any, arrives as a real
  // publish failure with a real reason.
  const notices = mediaNotices(draftWith([null, null, null], [{ provider: "pinterest", socialConnectionId: PIN_CONN }]));
  assert.equal(notices.length, 0, `unverified ratio must stay silent, got ${JSON.stringify(notices)}`);
});

test("unmeasured images STILL notice when the count itself is wrong", () => {
  // Count is knowable without dimensions, so 6 items is a refusal either way.
  const notices = mediaNotices(draftWith([null, null, null, null, null, null], [{ provider: "pinterest", socialConnectionId: PIN_CONN }]));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].code, "too_many");
});

console.log("\n=== a per-platform rule stays per-platform ===");

test("6 images: Pinterest is noticed, Instagram (max 10) is not", () => {
  const notices = mediaNotices(draftWith([TALL, TALL, TALL, TALL, TALL, TALL], [
    { provider: "pinterest", socialConnectionId: PIN_CONN },
    { provider: "instagram", socialConnectionId: IG_CONN },
  ]));
  assert.equal(notices.length, 1, "only the platform that refuses");
  assert.equal(notices[0].provider, "pinterest");
  assert.equal(notices[0].code, "too_many");
  assert.equal(notices[0].limit.max, PROVIDER_MEDIA_LIMITS.pinterest.max);
});

test("too_many points at the items PAST the cap, which contentMediaIssues cannot know", () => {
  const notices = mediaNotices(draftWith([TALL, TALL, TALL, TALL, TALL, TALL, TALL], [
    { provider: "pinterest", socialConnectionId: PIN_CONN },
  ]));
  // 7 items, cap 5 → the 6th and 7th are the overflow.
  assert.deepEqual(notices[0].offendingMediaIds, ["m5", "m6"]);
});

test("aspect_mismatch points at the ratio outliers, not at media[0]", () => {
  const notices = mediaNotices(draftWith([TALL, SQUARE, TALL, SQUARE], [
    { provider: "pinterest", socialConnectionId: PIN_CONN },
  ]));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].code, "aspect_mismatch");
  assert.deepEqual(notices[0].offendingMediaIds, ["m1", "m3"], "the reference item is never an offender");
});

test("Instagram never reports a ratio mismatch — it crops instead of refusing", () => {
  const notices = mediaNotices(draftWith([TALL, SQUARE], [{ provider: "instagram", socialConnectionId: IG_CONN }]));
  assert.equal(notices.length, 0, "blocking here would refuse content Instagram accepts");
});

console.log("\n=== one notice per platform, whatever the account count ===");

test("two Instagram accounts on one Content produce ONE Instagram notice", () => {
  const many = Array.from({ length: 12 }, () => TALL as [number, number]);
  const notices = mediaNotices(draftWith(many, [
    { provider: "instagram", socialConnectionId: IG_CONN },
    { provider: "instagram", socialConnectionId: "conn-ig-2" },
  ]));
  assert.equal(notices.length, 1, "the rule is a property of the platform, not the account");
  assert.equal(notices[0].provider, "instagram");
});

test("two platforms failing for different reasons produce two lines", () => {
  const many = Array.from({ length: 12 }, () => TALL as [number, number]);
  const notices = mediaNotices(draftWith(many, [
    { provider: "pinterest", socialConnectionId: PIN_CONN },
    { provider: "instagram", socialConnectionId: IG_CONN },
  ]));
  assert.equal(notices.length, 2, "two different fixes need two lines");
});

console.log("\n=== the highlight set is the union, deduped ===");

test("offendingMediaIds unions across notices without repeating an id", () => {
  const many = Array.from({ length: 12 }, () => TALL as [number, number]);
  const notices = mediaNotices(draftWith(many, [
    { provider: "pinterest", socialConnectionId: PIN_CONN },
    { provider: "instagram", socialConnectionId: IG_CONN },
  ]));
  const ids = offendingMediaIds(notices);
  // Pinterest overflows past 5, Instagram past 10 — the union is everything past 5,
  // each id counted once.
  assert.equal(ids.size, 7, `expected m5..m11, got ${Array.from(ids).join(",")}`);
  assert.ok(ids.has("m5") && ids.has("m11"));
  assert.ok(!ids.has("m4"), "an item that fits every platform is never ringed");
});

test("a Content with no destinations says nothing at all", () => {
  const draft = { id: "c9", imageUrl: "", media: [] } as unknown as ContentDraftLike;
  assert.equal(mediaNotices(draft).length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
