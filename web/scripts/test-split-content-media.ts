/**
 * test-split-content-media.ts — "Publish separately" (PRD §13).
 *
 * The escape hatch for a media set a platform will not take as one post, while the
 * crop tool is deferred. What must hold for it to be safe to offer on a card:
 *
 *   - the split items LEAVE the source. Copying them would leave the source with the
 *     same refusal it had, plus duplicates elsewhere — the merchant clicked it to FIX
 *     the source, not to duplicate the problem.
 *   - the source is never emptied. Splitting "everything" keeps media[0], because a
 *     Content with no media is a broken card, not a Content.
 *   - each new Content is the same POST differently framed: title, description,
 *     website URL and the destination intent carry over.
 *   - and it is a NEW post, not a copy of an attempt: no result rows, no remote ids,
 *     no failure fields, and above all no schedule. N posts inheriting one slot would
 *     fire them all at the same minute, which is the opposite of "separately".
 *
 * Run: npx tsx scripts/test-split-content-media.ts (from web/)
 */

import assert from "node:assert";

// ── localStorage stand-in, installed BEFORE pinDraftStore is imported ────────────
class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  get length(): number { return this.map.size; }
}
const storage = new FakeStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = {
  localStorage: storage,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
};

/* eslint-disable @typescript-eslint/no-require-imports */
const pinDraftStore = require("../src/lib/pinDraftStore") as typeof import("../src/lib/pinDraftStore");
const { contentMedia, contentDestinations } = require("../src/lib/contentDraftModel") as typeof import("../src/lib/contentDraftModel");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { PinDraft } from "../src/lib/pinDraftStore";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  OK   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${(e as Error).message}`); }
}

const PIN_CONN = "conn-pin";
const IG_CONN = "conn-ig";
const NOW = "2026-08-27T10:00:00.000Z";

function seed(mediaCount: number, patch: Partial<PinDraft> = {}): PinDraft {
  storage.clear();
  const created = pinDraftStore.createBoardDraft({
    imageUrl: "https://cdn.test/img-0.jpg",
    source: "uploaded_image",
    title: "Autumn table",
    description: "Five ways to lay it",
    destinationUrl: "https://shop.test/table",
  });
  const media = Array.from({ length: mediaCount }, (_, i) => ({
    id: `${created.id}:media:${i}`,
    kind: "image" as const,
    url: `https://cdn.test/img-${i}.jpg`,
    width: 1000,
    height: i === 0 ? 1500 : 1000,
  }));
  return pinDraftStore.updateDraft(created.id, {
    media,
    coverMediaId: media[0].id,
    boardId: "board-1",
    boardName: "Home decor",
    targetConnectionId: PIN_CONN,
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN, boardId: "board-1", boardName: "Home decor", capturedAt: NOW },
      { provider: "instagram", socialConnectionId: IG_CONN, capturedAt: NOW },
    ],
    ...patch,
  })!;
}

console.log("\n=== the split items leave the source ===");

test("splitting 2 of 4 leaves the source with 2 and creates 2 Contents", () => {
  const draft = seed(4);
  const ids = [contentMedia(draft)[2].id, contentMedia(draft)[3].id];
  const created = pinDraftStore.splitContentMedia(draft.id, ids);

  assert.equal(created.length, 2, "one new Content per split item");
  const source = pinDraftStore.getDraft(draft.id)!;
  assert.equal(contentMedia(source).length, 2, "the split items are GONE from the source");
  assert.ok(!contentMedia(source).some(m => ids.includes(m.id)), "specifically these ones");
  for (const child of created) assert.equal(contentMedia(child).length, 1, "each new Content holds exactly one image");
});

test("each new Content gets a FRESH media id, never the source's", () => {
  const draft = seed(3);
  const splitId = contentMedia(draft)[2].id;
  const [child] = pinDraftStore.splitContentMedia(draft.id, [splitId]);
  const childMedia = contentMedia(child)[0];
  assert.equal(childMedia.url, "https://cdn.test/img-2.jpg", "same asset");
  assert.notEqual(childMedia.id, splitId, "a shared id makes two posts' items indistinguishable");
});

console.log("\n=== the source is never emptied ===");

test("splitting EVERY item keeps media[0] on the source", () => {
  const draft = seed(3);
  const all = contentMedia(draft).map(m => m.id);
  const created = pinDraftStore.splitContentMedia(draft.id, all);

  assert.equal(created.length, 2, "the cover is not split off when it would empty the Content");
  const source = pinDraftStore.getDraft(draft.id)!;
  assert.equal(contentMedia(source).length, 1);
  assert.equal(contentMedia(source)[0].id, all[0], "and it is still the same cover");
});

test("no argument means 'all', and obeys the same floor", () => {
  const draft = seed(2);
  const created = pinDraftStore.splitContentMedia(draft.id);
  assert.equal(created.length, 1);
  assert.equal(contentMedia(pinDraftStore.getDraft(draft.id)!).length, 1);
});

test("a single-image Content cannot be split at all", () => {
  const draft = seed(1);
  assert.equal(pinDraftStore.splitContentMedia(draft.id).length, 0);
  assert.equal(contentMedia(pinDraftStore.getDraft(draft.id)!).length, 1);
});

test("ids this Content does not have are ignored, not an error", () => {
  const draft = seed(3);
  const created = pinDraftStore.splitContentMedia(draft.id, ["not-a-real-id"]);
  assert.equal(created.length, 0);
  assert.equal(contentMedia(pinDraftStore.getDraft(draft.id)!).length, 3, "nothing was removed either");
});

test("splitting the COVER promotes its neighbour rather than dangling coverMediaId", () => {
  const draft = seed(3);
  const cover = contentMedia(draft)[0];
  const second = contentMedia(draft)[1];
  pinDraftStore.splitContentMedia(draft.id, [cover.id]);
  const source = pinDraftStore.getDraft(draft.id)!;
  assert.equal(contentMedia(source)[0].id, second.id);
  assert.equal(source.coverMediaId, second.id, "cover ≡ media[0] survives the split");
  assert.equal(source.imageUrl, second.url, "and the legacy lead image follows it");
});

console.log("\n=== the new Content is the same post, differently framed ===");

test("title / description / website URL / destinations carry over", () => {
  const draft = seed(3);
  const [child] = pinDraftStore.splitContentMedia(draft.id, [contentMedia(draft)[2].id]);

  assert.equal(child.title, "Autumn table");
  assert.equal(child.description, "Five ways to lay it");
  assert.equal(child.destinationUrl, "https://shop.test/table");
  assert.equal(child.boardId, "board-1", "the legacy Pinterest board the worker still reads");
  assert.equal(child.boardName, "Home decor");

  const destinations = contentDestinations(child);
  assert.equal(destinations.length, 2, "both destinations came along");
  assert.deepEqual(
    destinations.map(d => `${d.provider}:${d.socialConnectionId}`).sort(),
    [`instagram:${IG_CONN}`, `pinterest:${PIN_CONN}`],
    "including WHICH account each publishes as",
  );
});

console.log("\n=== but it is a new post, not a copy of an attempt ===");

test("new Contents are unscheduled, whatever the source's schedule was", () => {
  const draft = seed(3, {
    scheduledDate: "2026-09-01",
    scheduledTime: "09:00",
    plannedAt: "2026-09-01T09:00:00.000Z",
    addedToPlanAt: NOW,
    weeklyPlanItemId: "wpi-1",
  });
  const [child] = pinDraftStore.splitContentMedia(draft.id, [contentMedia(draft)[2].id]);

  assert.ok(!child.scheduledDate, `scheduledDate leaked: ${child.scheduledDate}`);
  assert.ok(!child.scheduledTime, `scheduledTime leaked: ${child.scheduledTime}`);
  assert.ok(!child.plannedAt, `plannedAt leaked: ${child.plannedAt}`);
  assert.ok(!child.addedToPlanAt, "addedToPlanAt leaked — the child would appear in Plan");
  assert.ok(!child.weeklyPlanItemId, "weeklyPlanItemId leaked");
  // The source keeps its own slot: splitting is not unscheduling.
  assert.equal(pinDraftStore.getDraft(draft.id)!.scheduledDate, "2026-09-01");
});

test("publish results, remote ids and failure fields never carry over", () => {
  const draft = seed(3, {
    destinationResults: [
      { destinationId: `pinterest:${PIN_CONN}`, provider: "pinterest", socialConnectionId: PIN_CONN, status: "published", submittedAt: NOW, publishedAt: NOW, remoteId: "pin-1" },
    ],
    remotePinId: "pin-1",
    remotePinUrl: "https://www.pinterest.com/pin/pin-1/",
    postedAt: NOW,
    publishError: "Pinterest rejected the Pin.",
    publishErrorCode: "bad_request",
    failureType: "publish",
  });
  const [child] = pinDraftStore.splitContentMedia(draft.id, [contentMedia(draft)[2].id]);

  assert.ok(!child.destinationResults?.length, "a fresh Content has published nowhere");
  assert.ok(!child.remotePinId, "remote pin id leaked — the child would link to another post");
  assert.ok(!child.remotePinUrl);
  assert.ok(!child.postedAt, "postedAt leaked — the child would render as Posted");
  assert.ok(!child.publishError, "publishError leaked — the child would render as Failed");
  assert.ok(!child.failureType);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
