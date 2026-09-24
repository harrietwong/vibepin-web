/**
 * T1 unit tests for the mixed Pinterest+Instagram single-video draft
 * auto-split (design doc: docs/coordination/0924-混合视频草稿自动拆分-技术设计-v0.1.md).
 *
 * Pure-function layer only — no store, no localStorage, no UI, no API route.
 * Run: npx tsx scripts/test-split-mixed-video-draft.ts   (from web/)
 */
import assert from "node:assert/strict";
import {
  splitMixedVideoDraft,
  instagramCaptionIssues,
  parentIdOf,
  titleFromCaption,
} from "../src/lib/studio/splitMixedVideoDraft";
import type { PinDraft, ScheduledDestination } from "../src/lib/pinDraftStore";
import type { ContentMedia } from "../src/lib/contentDraftModel";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

const NOW = new Date("2026-09-24T12:00:00.000Z");

function dest(provider: string, connectionId: string, over: Partial<ScheduledDestination> = {}): ScheduledDestination {
  return { provider, socialConnectionId: connectionId, capturedAt: "2026-09-20T00:00:00.000Z", ...over };
}

function videoMedia(over: Partial<ContentMedia> = {}): ContentMedia {
  return { id: "m1", kind: "video", url: "https://cdn.example.com/v1.mp4", ...over } as ContentMedia;
}

function imageMedia(id = "m1", over: Partial<ContentMedia> = {}): ContentMedia {
  return { id, kind: "image", url: `https://cdn.example.com/${id}.jpg`, ...over } as ContentMedia;
}

function baseDraft(over: Partial<PinDraft> = {}): PinDraft {
  return {
    id: "draft-1",
    imageUrl: "https://cdn.example.com/poster.jpg",
    media: [videoMedia()],
    coverMediaId: "m1",
    keyword: "cozy living room",
    category: "home-decor",
    title: "Cozy Living Room Ideas",
    description: "Pinterest description with no link.",
    altText: "A cozy living room",
    destinationUrl: "https://merchant.example.com/product",
    boardId: "board-1",
    boardName: "Living Room",
    weeklyPlanItemId: "wpi-1",
    generationSessionId: "sess-1",
    scheduledDate: "2026-09-25",
    scheduledTime: "09:00",
    plannedAt: "2026-09-25T09:00",
    scheduleTimezone: "America/Los_Angeles",
    status: "ready",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    scheduledDestinations: [dest("pinterest", "pin-conn-1"), dest("instagram", "ig-conn-1", { accountLabel: "@shop" })],
    ...over,
  } as PinDraft;
}

const CAPTION = "Cozy corner refresh\n\nLink in bio for the rug!";

// ── Should split / should not split ─────────────────────────────────────────

test("splits a single-video draft targeting both pinterest and instagram", () => {
  const draft = baseDraft();
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.equal(result.child.id, "draft-1__ig");
  assert.equal(result.parent.id, "draft-1");
});

test("image-only mixed draft (pinterest + instagram) is not split", () => {
  const draft = baseDraft({ media: [imageMedia()] });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, false);
  assert.equal(result.parent, draft, "must return the exact same reference, unmodified");
});

test("single-platform video draft (pinterest only) is not split", () => {
  const draft = baseDraft({ scheduledDestinations: [dest("pinterest", "pin-conn-1")] });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, false);
  assert.equal(result.parent, draft);
});

test("single-platform video draft (instagram only) is not split", () => {
  const draft = baseDraft({ scheduledDestinations: [dest("instagram", "ig-conn-1")] });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, false);
  assert.equal(result.parent, draft);
});

test("multi-media video draft (2 videos) is not split even with both destinations", () => {
  const draft = baseDraft({ media: [videoMedia({ id: "m1" }), videoMedia({ id: "m2", url: "https://cdn.example.com/v2.mp4" })] });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, false);
  assert.equal(result.parent, draft);
});

test("multi-media mix (video + image) is not split", () => {
  const draft = baseDraft({ media: [videoMedia({ id: "m1" }), imageMedia("m2")] });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, false);
  assert.equal(result.parent, draft);
});

test("no media at all is not split", () => {
  const draft = baseDraft({ media: [] });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, false);
  assert.equal(result.parent, draft);
});

test("pinterest + facebook + instagram: parent keeps facebook, only instagram is split off", () => {
  const draft = baseDraft({
    scheduledDestinations: [
      dest("pinterest", "pin-conn-1"),
      dest("facebook", "fb-conn-1"),
      dest("instagram", "ig-conn-1"),
    ],
  });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  const parentProviders = (result.parent.scheduledDestinations ?? []).map(d => d.provider).sort();
  assert.deepEqual(parentProviders, ["facebook", "pinterest"]);
  const childProviders = (result.child.scheduledDestinations ?? []).map(d => d.provider);
  assert.deepEqual(childProviders, ["instagram"]);
});

test("two instagram accounts: both land on the one child, none stay on parent", () => {
  const draft = baseDraft({
    scheduledDestinations: [
      dest("pinterest", "pin-conn-1"),
      dest("instagram", "ig-conn-1", { accountLabel: "@shop-a" }),
      dest("instagram", "ig-conn-2", { accountLabel: "@shop-b" }),
    ],
  });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.equal((result.parent.scheduledDestinations ?? []).length, 1);
  assert.equal((result.child.scheduledDestinations ?? []).length, 2);
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test("idempotent: calling again on the returned parent (IG stripped) produces no child", () => {
  const draft = baseDraft();
  const first = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(first.split, true);
  if (!first.split) return;
  const second = splitMixedVideoDraft(first.parent, { instagramCaption: CAPTION, now: NOW });
  assert.equal(second.split, false);
  assert.equal(second.parent, first.parent);
});

test("idempotent: calling on the child itself returns it unchanged (no __ig__ig)", () => {
  const draft = baseDraft();
  const first = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(first.split, true);
  if (!first.split) return;
  const again = splitMixedVideoDraft(first.child, { instagramCaption: "different caption", now: NOW });
  assert.equal(again.split, false);
  assert.equal(again.parent, first.child, "child must come back byte-identical, by reference");
});

test("idempotent: a draft whose id already carries __ig (marker stripped) is never re-split", () => {
  // Defensive case: same id shape as a produced child, but the copyProfile marker
  // is missing (e.g. a caller forgot to persist it). Must still not become
  // "draft-1__ig__ig" if somehow it also carried both destinations.
  const draft = baseDraft({ id: "draft-1__ig", copyProfile: undefined } as Partial<PinDraft>);
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, false);
  assert.equal(result.parent, draft);
});

test("repeated calls with the same `now` are deep-equal (deterministic, replayable)", () => {
  const draft = baseDraft();
  const a = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  const b = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.deepEqual(a, b);
});

// ── Field inheritance / non-inheritance ─────────────────────────────────────

test("child inherits media, cover, poster, schedule, and IG destination fields", () => {
  const draft = baseDraft();
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.deepEqual(result.child.media, draft.media);
  assert.equal(result.child.coverMediaId, draft.coverMediaId);
  assert.equal(result.child.imageUrl, draft.imageUrl, "poster alias carried over");
  assert.equal(result.child.scheduledDate, draft.scheduledDate);
  assert.equal(result.child.scheduledTime, draft.scheduledTime);
  assert.equal(result.child.plannedAt, draft.plannedAt);
  assert.equal(result.child.scheduleTimezone, draft.scheduleTimezone);
  const igEntry = (result.child.scheduledDestinations ?? [])[0];
  assert.equal(igEntry.provider, "instagram");
  assert.equal(igEntry.socialConnectionId, "ig-conn-1");
  assert.equal(igEntry.accountLabel, "@shop");
});

test("child media is a deep copy, not the same array/object references", () => {
  const draft = baseDraft();
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.notEqual(result.child.media, draft.media, "different array instance");
  assert.notEqual(result.child.media![0], draft.media![0], "different item instance");
  assert.deepEqual(result.child.media, draft.media, "same values though");
});

test("child does NOT inherit board, destinationUrl, targetConnectionId, or any publish result/intent field", () => {
  const draft = baseDraft({
    targetConnectionId: "pin-conn-1",
    targetAccountLabel: "@storefront",
    destinationResults: [{ destinationId: "pinterest:pin-conn-1", provider: "pinterest", socialConnectionId: "pin-conn-1", status: "published" }],
    publishIntentId: "intent-abc",
    remotePinId: "999",
    remotePinUrl: "https://pinterest.com/pin/999",
    socialPosts: [{ provider: "instagram", postId: "ig-1", postUrl: "https://instagram.com/p/ig-1", publishedAt: "2026-09-01T00:00:00Z" }],
    parentDraftId: "some-ai-source-draft",
    postedAt: "2026-09-01T00:00:00Z",
  } as Partial<PinDraft>);
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  const child = result.child as unknown as Record<string, unknown>;
  assert.equal(child.boardId, "");
  assert.equal(child.boardName, "");
  assert.equal(child.destinationUrl, "");
  assert.equal("targetConnectionId" in child, false);
  assert.equal("targetAccountLabel" in child, false);
  assert.equal("destinationResults" in child, false);
  assert.equal("publishIntentId" in child, false);
  assert.equal("remotePinId" in child, false);
  assert.equal("remotePinUrl" in child, false);
  assert.equal("socialPosts" in child, false);
  assert.equal("parentDraftId" in child, false);
  assert.equal("postedAt" in child, false);
});

test("child carries copyProfile + splitFromDraftId markers; parent is untouched by them", () => {
  const draft = baseDraft();
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.equal(result.child.copyProfile, "instagram_caption");
  assert.equal(result.child.splitFromDraftId, "draft-1");
  assert.equal("copyProfile" in result.parent, false);
  assert.equal("splitFromDraftId" in result.parent, false);
});

test("child metadataTouched marks title+description touched (never shows as AI-unedited)", () => {
  const draft = baseDraft();
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.equal(result.child.metadataTouched?.titleTouched, true);
  assert.equal(result.child.metadataTouched?.descriptionTouched, true);
});

test("parent keeps its own Pinterest title, description, and destination link unchanged", () => {
  const draft = baseDraft();
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.equal(result.parent.title, draft.title);
  assert.equal(result.parent.description, draft.description);
  assert.equal(result.parent.destinationUrl, draft.destinationUrl);
  assert.equal(result.parent.boardId, draft.boardId);
});

test("child passes the same readiness rule as recomputeDraftStatus (title+description+date all present)", () => {
  const draft = baseDraft();
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.equal(result.child.status, "ready", "non-empty title (from caption) + description + inherited date ⇒ ready, never needs_review");
  assert.ok(result.child.title.length > 0, "title must not be empty — this is the whole point of Fable ruling 2");
});

test("child falls back to needs_review (not a crash) when the inherited schedule date is missing", () => {
  const draft = baseDraft({ scheduledDate: "" });
  const result = splitMixedVideoDraft(draft, { instagramCaption: CAPTION, now: NOW });
  assert.equal(result.split, true);
  if (!result.split) return;
  assert.equal(result.child.status, "needs_review");
});

// ── Caption → title derivation ──────────────────────────────────────────────

test("titleFromCaption: single line caption becomes the title verbatim", () => {
  assert.equal(titleFromCaption("Cozy corner refresh"), "Cozy corner refresh");
});

test("titleFromCaption: multi-line caption uses only the first line", () => {
  assert.equal(titleFromCaption("Cozy corner refresh\n\nLink in bio for the rug!"), "Cozy corner refresh");
});

test("titleFromCaption: caption opening with blank line(s) skips to the first non-blank line", () => {
  assert.equal(titleFromCaption("\n\nCozy corner refresh\nmore text"), "Cozy corner refresh");
  assert.equal(titleFromCaption("   \n\t\nActual first line"), "Actual first line");
});

test("titleFromCaption: all-whitespace / empty caption yields empty title", () => {
  assert.equal(titleFromCaption(""), "");
  assert.equal(titleFromCaption("   "), "");
  assert.equal(titleFromCaption("\n\n\n   \n"), "");
});

test("titleFromCaption: over-100-char first line is truncated to exactly 100 chars", () => {
  const longLine = "A".repeat(150);
  const result = titleFromCaption(`${longLine}\nsecond line`);
  assert.equal(result.length, 100);
  assert.equal(result, "A".repeat(100));
});

test("titleFromCaption: exactly-100-char first line is kept whole, not truncated further", () => {
  const line = "B".repeat(100);
  assert.equal(titleFromCaption(line), line);
});

test("titleFromCaption: leading/trailing whitespace on the first line is trimmed", () => {
  assert.equal(titleFromCaption("   Cozy corner refresh   \nmore"), "Cozy corner refresh");
});

// ── instagramCaptionIssues ───────────────────────────────────────────────────

test("instagramCaptionIssues: empty or whitespace-only caption is required-missing", () => {
  assert.deepEqual(instagramCaptionIssues(""), ["instagram_caption_required"]);
  assert.deepEqual(instagramCaptionIssues("   "), ["instagram_caption_required"]);
  assert.deepEqual(instagramCaptionIssues(null), ["instagram_caption_required"]);
  assert.deepEqual(instagramCaptionIssues(undefined), ["instagram_caption_required"]);
});

test("instagramCaptionIssues: clean caption with no link has no issues", () => {
  assert.deepEqual(instagramCaptionIssues("Cozy corner refresh, link in bio!"), []);
});

test("instagramCaptionIssues: rejects http:// and https:// links", () => {
  assert.deepEqual(instagramCaptionIssues("Shop now http://example.com/x"), ["instagram_caption_contains_link"]);
  assert.deepEqual(instagramCaptionIssues("Shop now https://example.com/x"), ["instagram_caption_contains_link"]);
});

test("instagramCaptionIssues: rejects www. prefix even without a scheme", () => {
  assert.deepEqual(instagramCaptionIssues("Visit www.example.com today"), ["instagram_caption_contains_link"]);
});

test("instagramCaptionIssues: rejects a bare domain like cheerish.co", () => {
  assert.deepEqual(instagramCaptionIssues("More at cheerish.co for details"), ["instagram_caption_contains_link"]);
});

test("instagramCaptionIssues: bare-domain check is case-insensitive", () => {
  assert.deepEqual(instagramCaptionIssues("More at Cheerish.CO for details"), ["instagram_caption_contains_link"]);
});

test("instagramCaptionIssues: rejects amazon.com/dp/x style commerce links", () => {
  assert.deepEqual(instagramCaptionIssues("Grab it at amazon.com/dp/B000123"), ["instagram_caption_contains_link"]);
});

test("instagramCaptionIssues: does not false-positive on decimals or abbreviations", () => {
  assert.deepEqual(instagramCaptionIssues("Rated 3.5 stars by shoppers"), []);
  assert.deepEqual(instagramCaptionIssues("Cozy vibes, e.g. this blanket"), []);
  assert.deepEqual(instagramCaptionIssues("Love it. Check the details in comments"), []);
});

// ── parentIdOf ───────────────────────────────────────────────────────────────

test("parentIdOf: strips the __ig suffix from a real child id", () => {
  assert.equal(parentIdOf("draft-1__ig"), "draft-1");
});

test("parentIdOf: rejects a doubled suffix (a__ig__ig) so it cannot be used to bypass idempotency", () => {
  assert.equal(parentIdOf("draft-1__ig__ig"), null);
});

test("parentIdOf: rejects the bare suffix with no prefix", () => {
  assert.equal(parentIdOf("__ig"), null);
});

test("parentIdOf: rejects wrong case (case-sensitive match only)", () => {
  assert.equal(parentIdOf("draft-1__IG"), null);
});

test("parentIdOf: rejects a trailing space after the suffix", () => {
  assert.equal(parentIdOf("draft-1__ig "), null);
});

test("parentIdOf: rejects an id with no suffix at all", () => {
  assert.equal(parentIdOf("draft-1"), null);
});

test("parentIdOf: rejects non-string input", () => {
  assert.equal(parentIdOf(undefined), null);
  assert.equal(parentIdOf(null), null);
  assert.equal(parentIdOf(123), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
