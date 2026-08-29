/**
 * WS-B2a unit tests: the media/cover model for a Content.
 * Run: npx tsx scripts/test-content-media-model.ts   (from web/)
 *
 * The rule under test is a single invariant — THE COVER IS media[0] — plus the
 * three things that used to break it:
 *   1. setCoverMedia rewrote coverMediaId without moving the item, so the card
 *      showed image #4 while every publish path led with image #1.
 *   2. completeGeneratedDraft assigned `media: [the new image]`, deleting every
 *      other image on the Content the moment one generation finished.
 *   3. Drafts persisted before the rule still name an off-index cover, so load()
 *      has to repair them once — and exactly once, or every cold start pushes the
 *      whole board through the sync outbox.
 */

import assert from "node:assert";

// ── window + localStorage shim (same pattern as test-pin-draft-sync.ts) ───────
const mem = new Map<string, string>();
const listeners = new Set<() => void>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (_t: string, cb: () => void) => { listeners.add(cb); },
  removeEventListener: (_t: string, cb: () => void) => { listeners.delete(cb); },
  dispatchEvent: () => { listeners.forEach(fn => fn()); return true; },
};

import * as store from "../src/lib/pinDraftStore";
import type { PinDraft } from "../src/lib/pinDraftStore";
import { contentMedia, contentMediaIssues, coverMedia } from "../src/lib/contentDraftModel";
import type { ContentMedia } from "../src/lib/contentDraftModel";

// ── Tiny harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

/** Must match pinDraftStore's private STORE_KEY — the tests seed storage directly. */
const STORE_KEY = "vp:pin_drafts:v1";

function resetStore(): void {
  mem.clear();
  store.__resetMemoryCacheForTests();
}

function media(id: string, url: string, extra: Partial<ContentMedia> = {}): ContentMedia {
  return { id, kind: "image", url, ...extra };
}

/** Write drafts straight to localStorage, bypassing the store, then force a reload. */
function seedStorage(drafts: PinDraft[]): void {
  mem.set(STORE_KEY, JSON.stringify({ drafts: Object.fromEntries(drafts.map(d => [d.id, d])) }));
  store.__resetMemoryCacheForTests();
}

function draftRow(over: Partial<PinDraft> & { id: string }): PinDraft {
  const now = "2026-08-20T00:00:00.000Z";
  return {
    contentId: over.id, imageUrl: "", keyword: "", category: "", title: "", description: "",
    altText: "", destinationUrl: "", boardId: "", boardName: "", weeklyPlanItemId: "",
    generationSessionId: "", scheduledDate: "", status: "needs_review",
    createdAt: now, updatedAt: now, ...over,
  } as PinDraft;
}

function makeDraft(items: Array<Partial<ContentMedia> & { url: string }>): PinDraft {
  const created = store.createBoardDraft({
    imageUrl: items[0].url,
    media: items.map((item, i) => media(item.id ?? `m${i}`, item.url, item)),
    source: "uploaded_image",
  });
  return created;
}

// ── 1. Cover follows media[0] ─────────────────────────────────────────────────

test("setCoverMedia moves the chosen item to index 0 (cover is not a separate pointer)", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg" }, { url: "b.jpg" }, { url: "c.jpg" }]);
  const updated = store.setCoverMedia(d.id, "m2")!;
  const list = contentMedia(updated);
  assert.deepEqual(list.map(i => i.id), ["m2", "m0", "m1"], "chosen item must MOVE to the front");
  assert.equal(updated.coverMediaId, "m2");
  assert.equal(updated.imageUrl, "c.jpg", "legacy imageUrl follows media[0]");
  assert.equal(coverMedia(updated)!.id, "m2");
});

test("reorderMedia hands the cover to whatever lands at index 0", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg" }, { url: "b.jpg" }, { url: "c.jpg" }]);
  const updated = store.reorderMedia(d.id, ["m1", "m2", "m0"])!;
  assert.deepEqual(contentMedia(updated).map(i => i.id), ["m1", "m2", "m0"]);
  assert.equal(updated.coverMediaId, "m1");
  assert.equal(updated.imageUrl, "b.jpg");
});

test("removeMedia: dropping the cover promotes the next item; a Content keeps ≥1 media", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg" }, { url: "b.jpg" }]);
  const afterRemove = store.removeMedia(d.id, "m0")!;
  assert.deepEqual(contentMedia(afterRemove).map(i => i.id), ["m1"]);
  assert.equal(afterRemove.coverMediaId, "m1");
  assert.equal(afterRemove.imageUrl, "b.jpg");
  // The last item cannot be removed — a Content without media has nothing to publish.
  const afterLast = store.removeMedia(d.id, "m1")!;
  assert.equal(contentMedia(afterLast).length, 1);
});

test("addMedia appends and never steals the cover", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg" }]);
  const updated = store.addMedia(d.id, [{ kind: "image", url: "new.jpg", source: "upload" }])!;
  assert.equal(contentMedia(updated).length, 2);
  assert.equal(updated.coverMediaId, "m0", "cover unchanged by an append");
  assert.equal(updated.imageUrl, "a.jpg");
});

test("copyMedia into slot 0 is clamped to slot 1 — a drag never changes the cover", () => {
  resetStore();
  const source = makeDraft([{ url: "src.jpg", width: 100, height: 100 }]);
  const target = makeDraft([{ url: "t0.jpg" }, { url: "t1.jpg" }]);
  const updated = store.copyMedia(source.id, contentMedia(source)[0].id, target.id, 0)!;
  const list = contentMedia(updated);
  assert.equal(list.length, 3);
  assert.equal(list[0].url, "t0.jpg", "existing cover stays at index 0");
  assert.equal(list[1].url, "src.jpg", "the copy lands right after the cover");
  assert.equal(updated.coverMediaId, list[0].id);
  // Dimensions ride along with the copy: it is the same image.
  assert.equal(list[1].width, 100);
  assert.equal(list[1].height, 100);
});

// ── 2. Load-time normalization ────────────────────────────────────────────────

test("normalization moves a stale off-index cover to the front on load", () => {
  resetStore();
  seedStorage([draftRow({
    id: "stale1", imageUrl: "a.jpg", coverMediaId: "m2",
    media: [media("m0", "a.jpg"), media("m1", "b.jpg"), media("m2", "c.jpg")],
  })]);
  const loaded = store.getDraft("stale1")!;
  assert.deepEqual(contentMedia(loaded).map(i => i.id), ["m2", "m0", "m1"], "the merchant's actual choice leads");
  assert.equal(loaded.coverMediaId, "m2");
  assert.equal(loaded.imageUrl, "c.jpg", "imageUrl repaired to match media[0]");
});

test("normalization is idempotent and does not bump updatedAt for already-correct drafts", () => {
  resetStore();
  seedStorage([draftRow({
    id: "clean1", imageUrl: "a.jpg", coverMediaId: "m0",
    media: [media("m0", "a.jpg"), media("m1", "b.jpg")],
  })]);
  const first = store.getDraft("clean1")!;
  assert.equal(first.updatedAt, "2026-08-20T00:00:00.000Z", "a no-op must not churn the sync outbox");

  // Re-load from the persisted result: the repair must not keep re-firing.
  store.__resetMemoryCacheForTests();
  const second = store.getDraft("clean1")!;
  assert.equal(second.updatedAt, first.updatedAt);
  assert.deepEqual(contentMedia(second).map(i => i.id), ["m0", "m1"]);
});

test("a repaired draft settles after one pass (second load changes nothing further)", () => {
  resetStore();
  seedStorage([draftRow({
    id: "stale2", imageUrl: "a.jpg", coverMediaId: "m1",
    media: [media("m0", "a.jpg"), media("m1", "b.jpg")],
  })]);
  const first = store.getDraft("stale2")!;
  assert.notEqual(first.updatedAt, "2026-08-20T00:00:00.000Z", "a real repair does bump updatedAt");
  store.__resetMemoryCacheForTests();
  const second = store.getDraft("stale2")!;
  assert.equal(second.updatedAt, first.updatedAt, "no further rewrites once normalized");
  assert.deepEqual(contentMedia(second).map(i => i.id), ["m1", "m0"]);
});

test("mergeServerDrafts normalizes rows arriving mid-session", () => {
  resetStore();
  seedStorage([]);
  store.mergeServerDrafts([draftRow({
    id: "srv1", imageUrl: "a.jpg", coverMediaId: "m1", updatedAt: "2026-08-25T00:00:00.000Z",
    media: [media("m0", "a.jpg"), media("m1", "b.jpg")],
  })], []);
  const merged = store.getDraft("srv1")!;
  assert.deepEqual(contentMedia(merged).map(i => i.id), ["m1", "m0"]);
  assert.equal(merged.imageUrl, "b.jpg");
});

// ── 3. replaceMedia ───────────────────────────────────────────────────────────

test("replaceMedia swaps one asset in place: same id, same position", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg" }, { url: "b.jpg" }, { url: "c.jpg" }]);
  const updated = store.replaceMedia(d.id, "m1", { url: "b2.jpg", width: 800, height: 600 })!;
  const list = contentMedia(updated);
  assert.deepEqual(list.map(i => i.id), ["m0", "m1", "m2"], "order and identity survive the swap");
  assert.equal(list[1].url, "b2.jpg");
  assert.equal(list[1].width, 800);
  assert.equal(updated.imageUrl, "a.jpg", "replacing a non-cover item leaves the cover alone");
});

test("replaceMedia on media[0] drags imageUrl along", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg", width: 100, height: 100 }, { url: "b.jpg" }]);
  const updated = store.replaceMedia(d.id, "m0", { url: "a2.jpg" })!;
  assert.equal(updated.imageUrl, "a2.jpg");
  assert.equal(updated.coverMediaId, "m0");
  const first = contentMedia(updated)[0];
  assert.equal(first.width, undefined, "stale dimensions are dropped, not carried onto a new asset");
});

// ── 4. completeGeneratedDraft ─────────────────────────────────────────────────

test("completeGeneratedDraft replaces media[0] and PRESERVES the other images", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg" }, { url: "b.jpg" }, { url: "c.jpg" }]);
  const updated = store.completeGeneratedDraft(d.id, "generated.jpg")!;
  const list = contentMedia(updated);
  assert.equal(list.length, 3, "generation must not wipe the Content's other media");
  assert.equal(list[0].url, "generated.jpg");
  assert.equal(list[0].source, "ai");
  assert.deepEqual(list.slice(1).map(i => i.url), ["b.jpg", "c.jpg"]);
  assert.equal(updated.imageUrl, "generated.jpg");
  assert.equal(updated.generationStatus, "completed");
});

test("completeGeneratedDraft honours replaceMediaId and leaves the cover untouched", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg" }, { url: "b.jpg" }]);
  const updated = store.completeGeneratedDraft(d.id, "gen.jpg", { replaceMediaId: "m1", generationId: "g1" })!;
  const list = contentMedia(updated);
  assert.deepEqual(list.map(i => i.url), ["a.jpg", "gen.jpg"]);
  assert.equal(updated.imageUrl, "a.jpg", "a non-cover slot was regenerated; the cover does not move");
  assert.equal(updated.coverMediaId, "m0");
  assert.equal(updated.sourceGenerationId, "g1");
});

test("completeGeneratedDraft still creates the single item when the draft has no media", () => {
  resetStore();
  const created = store.createBoardDraft({ imageUrl: "", source: "ai_generated_from_upload" });
  const updated = store.completeGeneratedDraft(created.id, "only.jpg", { assetKey: "k1" })!;
  const list = contentMedia(updated);
  assert.equal(list.length, 1);
  assert.equal(list[0].url, "only.jpg");
  assert.equal(updated.coverMediaId, list[0].id);
  assert.equal(updated.imageUrl, "only.jpg");
  assert.equal(updated.sourceAssetKey, "k1");
});

// ── 5. contentMediaIssues ─────────────────────────────────────────────────────

test("contentMediaIssues names the offending images for a mixed-ratio Pinterest carousel", () => {
  resetStore();
  const d = makeDraft([
    { url: "a.jpg", width: 1000, height: 1500 },  // 2:3 reference
    { url: "b.jpg", width: 1000, height: 1000 },  // square → offender
    { url: "c.jpg", width: 1000, height: 1500 },  // matches
    { url: "d.jpg", width: 1600, height: 900 },   // wide → offender
  ]);
  const issues = contentMediaIssues(d, "pinterest");
  assert.equal(issues.result.ok, false);
  assert.equal(issues.result.ok === false && issues.result.code, "aspect_mismatch");
  assert.deepEqual(issues.offendingMediaIds, ["m1", "m3"]);
  assert.equal(issues.unverifiedRatio, false);
  assert.match(issues.result.ok === false ? issues.result.message : "", /2 images need adjustment/);
});

test("contentMediaIssues: Instagram tolerates mixed ratios but still names them", () => {
  resetStore();
  const d = makeDraft([
    { url: "a.jpg", width: 1000, height: 1000 },
    { url: "b.jpg", width: 1000, height: 1500 },
  ]);
  const issues = contentMediaIssues(d, "instagram");
  assert.equal(issues.result.ok, true, "Instagram crops rather than rejecting");
  assert.deepEqual(issues.offendingMediaIds, ["m1"], "the UI can still warn about the crop");
});

test("contentMediaIssues returns unverifiedRatio when a size is unknown and blames nobody", () => {
  resetStore();
  const d = makeDraft([
    { url: "a.jpg", width: 1000, height: 1500 },
    { url: "b.jpg" }, // never measured
  ]);
  const issues = contentMediaIssues(d, "pinterest");
  assert.equal(issues.result.ok, true, "an unmeasured image must not block a publish");
  assert.equal(issues.result.ok === true && issues.result.unverifiedRatio, true);
  assert.deepEqual(issues.offendingMediaIds, [], "unmeasured is not the same as offending");
  assert.equal(issues.unverifiedRatio, true);
});

test("contentMediaIssues reports the per-platform count limits", () => {
  resetStore();
  const six = Array.from({ length: 6 }, (_, i) => ({ url: `${i}.jpg`, width: 100, height: 100 }));
  const d = makeDraft(six);
  const pinterest = contentMediaIssues(d, "pinterest");
  assert.equal(pinterest.result.ok, false);
  assert.equal(pinterest.result.ok === false && pinterest.result.code, "too_many");
  assert.equal(contentMediaIssues(d, "instagram").result.ok, true, "Instagram allows up to 10");
  assert.equal(contentMediaIssues(d, "facebook").result.ok, true, "Facebook allows up to 10");
});

// ── 6. Deterministic media ids ────────────────────────────────────────────────

test("media ids do not collide across a remove-then-add cycle", () => {
  resetStore();
  const d = makeDraft([{ url: "a.jpg" }, { url: "b.jpg" }, { url: "c.jpg" }]);
  store.removeMedia(d.id, "m1");
  const afterAdd = store.addMedia(d.id, [
    { kind: "image", url: "x.jpg" },
    { kind: "image", url: "y.jpg" },
  ])!;
  const ids = contentMedia(afterAdd).map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, "every media id in one Content must be unique");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
