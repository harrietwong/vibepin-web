/**
 * test-mixed-video-split-ui.ts — T3 of the mixed Pinterest+Instagram single-video
 * split (design doc docs/coordination/0924-混合视频草稿自动拆分-技术设计-v0.1.md).
 *
 * This repo's UI tests assert source-level / pure-function behavior rather than
 * mounting components (see scripts/test-media-notice.ts) — there is no Playwright
 * browser available in this environment. Two layers are covered:
 *
 *   1. Pure gate functions PinBoardCard.tsx renders directly
 *      (shouldShowInstagramCaptionInput / shouldShowFieldOnInstagramChild):
 *      the caption box appears ONLY for a video going to both Pinterest and
 *      Instagram, and disappears when NEXT_PUBLIC_HIDE_IG_FB hides Instagram,
 *      or once the draft has already been split.
 *   2. The store-level split entry point (splitMixedVideoDraftInStore): writing
 *      exactly 2 rows, idempotent on replay, never clobbering an existing child.
 *   3. Source-level wiring checks: the card imports/uses these gates and passes
 *      the caption through onSchedule/onCustomSchedule; the sync-issue codes
 *      have a card-rendered path back to review/fix.
 *
 * Run: npx tsx scripts/test-mixed-video-split-ui.ts (from web/)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
/* eslint-enable @typescript-eslint/no-require-imports */
import type { PinDraft, ScheduledDestination } from "../src/lib/pinDraftStore";
import {
  shouldShowInstagramCaptionInput,
  shouldShowFieldOnInstagramChild,
  instagramCaptionIssues,
} from "../src/lib/studio/splitMixedVideoDraft";

let pass = 0, fail = 0;
function test(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  OK   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${(e as Error).stack ?? (e as Error).message}`); }
}

const NOW = "2026-09-25T10:00:00.000Z";
const PIN_CONN = "conn-pin";
const IG_CONN = "conn-ig";

function dest(provider: string, connectionId: string, over: Partial<ScheduledDestination> = {}): ScheduledDestination {
  return { provider, socialConnectionId: connectionId, capturedAt: NOW, ...over };
}

function videoDraft(over: Partial<PinDraft> = {}): PinDraft {
  return {
    id: "draft-1",
    imageUrl: "https://cdn.test/poster.jpg",
    media: [{ id: "m1", kind: "video", url: "https://cdn.test/v1.mp4" }],
    coverMediaId: "m1",
    title: "Cozy corner",
    description: "Pinterest description",
    altText: "",
    destinationUrl: "https://merchant.test/product",
    boardId: "board-1",
    boardName: "Living Room",
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    scheduledDestinations: [dest("pinterest", PIN_CONN), dest("instagram", IG_CONN)],
    ...over,
  } as PinDraft;
}

console.log("\n=== 1. shouldShowInstagramCaptionInput (the box gate) ===");

test("shows for a single video with both Pinterest and Instagram ticked", () => {
  assert.equal(shouldShowInstagramCaptionInput(videoDraft(), { igFbHidden: false }), true);
});

test("hidden when NEXT_PUBLIC_HIDE_IG_FB hides Instagram — even though IG could not be selected either", () => {
  assert.equal(shouldShowInstagramCaptionInput(videoDraft(), { igFbHidden: true }), false);
});

test("hidden for a Pinterest-only video (no Instagram destination)", () => {
  const draft = videoDraft({ scheduledDestinations: [dest("pinterest", PIN_CONN)] });
  assert.equal(shouldShowInstagramCaptionInput(draft, { igFbHidden: false }), false);
});

test("hidden for an image draft even with both destinations (design §4: images are out of scope)", () => {
  const draft = videoDraft({ media: [{ id: "m1", kind: "image", url: "https://cdn.test/i1.jpg" }] });
  assert.equal(shouldShowInstagramCaptionInput(draft, { igFbHidden: false }), false);
});

test("hidden once the draft has already been split (parent no longer carries Instagram)", () => {
  const parentAfterSplit = videoDraft({ scheduledDestinations: [dest("pinterest", PIN_CONN)] });
  assert.equal(shouldShowInstagramCaptionInput(parentAfterSplit, { igFbHidden: false }), false);
});

console.log("\n=== 2. shouldShowFieldOnInstagramChild (child card field visibility) ===");

test("a normal (non-child) draft shows title/websiteUrl/boardId", () => {
  const draft = videoDraft();
  assert.equal(shouldShowFieldOnInstagramChild(draft, "title"), true);
  assert.equal(shouldShowFieldOnInstagramChild(draft, "websiteUrl"), true);
  assert.equal(shouldShowFieldOnInstagramChild(draft, "boardId"), true);
});

test("an Instagram split child (copyProfile marker) hides title/websiteUrl/boardId", () => {
  const child = { copyProfile: "instagram_caption" as const };
  assert.equal(shouldShowFieldOnInstagramChild(child, "title"), false);
  assert.equal(shouldShowFieldOnInstagramChild(child, "websiteUrl"), false);
  assert.equal(shouldShowFieldOnInstagramChild(child, "boardId"), false);
});

console.log("\n=== 3. splitMixedVideoDraftInStore (store-level insert, T3 save path) ===");

/** Fully reset the store between tests: `_memData` is an in-memory cache that
 *  `storage.clear()` alone does not invalidate (pinDraftStore.ts:476-484) — only
 *  clearPinDraftOwnerScope() forces the next load() to re-read (cleared) storage. */
function resetStore(): void {
  storage.clear();
  pinDraftStore.clearPinDraftOwnerScope();
}

function seedMixedVideoDraft(): PinDraft {
  resetStore();
  const created = pinDraftStore.createBoardDraft({
    imageUrl: "https://cdn.test/poster.jpg",
    media: [{ id: "seed", kind: "video", url: "https://cdn.test/v1.mp4" } as never],
    source: "uploaded_image",
    title: "Cozy corner",
    description: "Pinterest description",
    destinationUrl: "https://merchant.test/product",
  });
  return pinDraftStore.updateDraft(created.id, {
    boardId: "board-1",
    boardName: "Living Room",
    targetConnectionId: PIN_CONN,
    scheduledDate: "2026-09-26",
    scheduledTime: "09:00",
    scheduledDestinations: [dest("pinterest", PIN_CONN), dest("instagram", IG_CONN, { accountLabel: "@shop" })],
  })!;
}

test("splitting writes exactly 2 rows (parent stays, child __ig is created)", () => {
  const draft = seedMixedVideoDraft();
  const result = pinDraftStore.splitMixedVideoDraftInStore(draft.id, { instagramCaption: "Comment SHOP for the link" });
  assert.equal(result.split, true);
  if (!result.split) return;

  const parent = pinDraftStore.getDraft(draft.id)!;
  const child = pinDraftStore.getDraft(`${draft.id}__ig`)!;
  assert.ok(parent, "parent still exists");
  assert.ok(child, "child was created");
  assert.equal(pinDraftStore.getAllDrafts().length, 2, "exactly 2 rows total, no more");
  assert.equal(child.description, "Comment SHOP for the link");
  assert.equal(child.copyProfile, "instagram_caption");
  assert.equal((parent.scheduledDestinations ?? []).some(d => d.provider === "instagram"), false, "parent lost its Instagram destination");
});

test("scheduling twice (replay) never produces a 3rd row", () => {
  const draft = seedMixedVideoDraft();
  pinDraftStore.splitMixedVideoDraftInStore(draft.id, { instagramCaption: "Comment SHOP for the link" });
  // Re-run against the (now Pinterest-only) parent — same call a duplicate/retried
  // Schedule click would make.
  pinDraftStore.splitMixedVideoDraftInStore(draft.id, { instagramCaption: "Comment SHOP for the link" });
  assert.equal(pinDraftStore.getAllDrafts().length, 2, "still exactly 2 rows");
});

test("an existing (merchant-edited) child is never overwritten by a second split", () => {
  const draft = seedMixedVideoDraft();
  pinDraftStore.splitMixedVideoDraftInStore(draft.id, { instagramCaption: "Comment SHOP for the link" });
  const childId = `${draft.id}__ig`;
  pinDraftStore.updateDraft(childId, { description: "Merchant edited this caption by hand" });

  // Re-seed the parent with both destinations again (simulating a stale client that
  // still thinks it needs to split) and split again.
  pinDraftStore.updateDraft(draft.id, {
    scheduledDestinations: [dest("pinterest", PIN_CONN), dest("instagram", IG_CONN)],
  });
  pinDraftStore.splitMixedVideoDraftInStore(draft.id, { instagramCaption: "A NEW caption that must not win" });

  const child = pinDraftStore.getDraft(childId)!;
  assert.equal(child.description, "Merchant edited this caption by hand", "existing child is never clobbered");
  assert.equal(pinDraftStore.getAllDrafts().length, 2, "still exactly 2 rows");
});

test("a Pinterest-only draft is a no-op (nothing to split)", () => {
  resetStore();
  const created = pinDraftStore.createBoardDraft({
    imageUrl: "https://cdn.test/poster.jpg",
    media: [{ id: "seed", kind: "video", url: "https://cdn.test/v1.mp4" } as never],
    source: "uploaded_image",
  });
  pinDraftStore.updateDraft(created.id, { scheduledDestinations: [dest("pinterest", PIN_CONN)] });
  const result = pinDraftStore.splitMixedVideoDraftInStore(created.id, { instagramCaption: "" });
  assert.equal(result.split, false);
  assert.equal(pinDraftStore.getAllDrafts().length, 1);
});

test("a missing draft id is a safe no-op (never throws)", () => {
  resetStore();
  const result = pinDraftStore.splitMixedVideoDraftInStore("does-not-exist", { instagramCaption: "x" });
  assert.equal(result.split, false);
});

console.log("\n=== 4. Card wiring (source-level: PinBoardCard.tsx uses the gates + threads the caption) ===");

const cardSource = readFileSync("src/components/studio/PinBoardCard.tsx", "utf8");

test("PinBoardCard imports the T3 gate functions and the IG-hidden flag", () => {
  assert.match(cardSource, /shouldShowInstagramCaptionInput/);
  assert.match(cardSource, /shouldShowFieldOnInstagramChild/);
  assert.match(cardSource, /igFbHidden/);
});

test("doSchedule/doCustomSchedule block on instagramCaptionErrors before calling onSchedule/onCustomSchedule", () => {
  assert.match(cardSource, /if \(showInstagramCaptionInput && instagramCaptionErrors\.length\) \{\s*\n\s*setInstagramCaptionTouched\(true\);\s*\n\s*return;/);
});

test("onSchedule/onCustomSchedule receive the caption only when the box is shown", () => {
  assert.match(cardSource, /props\.onSchedule\(draft\.id, showInstagramCaptionInput \? \{ instagramCaption \} : undefined\)/);
  assert.match(cardSource, /props\.onCustomSchedule\(draft\.id, customDate, customTime, showInstagramCaptionInput \? \{ instagramCaption \} : undefined\)/);
});

test("the compact card renders the caption textarea with a data-testid", () => {
  assert.match(cardSource, /data-testid="board-card-instagram-caption"/);
});

test("the expanded card renders the caption textarea with a data-testid", () => {
  assert.match(cardSource, /data-testid="board-field-instagram-caption"/);
});

test("card-level caption box uses instagramCaptionIssues for its inline error (same function the server/script use)", () => {
  assert.match(cardSource, /instagramCaptionIssues\(instagramCaption\)/);
});

test("the IG child's description label swaps to the Instagram caption label", () => {
  assert.match(cardSource, /isInstagramCaptionChild \? tr\("studioBoard\.card\.instagramCaption\.label"\) : tr\("studioBoard\.card\.fields\.description"\)/);
});

test("the expanded card hides title/websiteUrl/board via PinFieldsForm's hiddenFields for the IG child", () => {
  assert.match(cardSource, /hiddenFields=\{isInstagramCaptionChild \? \["title", "websiteUrl", "board"\] : undefined\}/);
});

test("a mixed_video_requires_split sync issue on an already-locally-scheduled card gets an inline split-and-schedule action", () => {
  assert.match(cardSource, /data-testid="card-split-and-schedule"/);
  assert.match(cardSource, /syncIssue\?\.code === "mixed_video_requires_split"/);
});

const studioBoardSource = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");

test("StudioBoard.handleSchedule accepts the instagramCaption option and calls splitMixedVideoDraftInStore AFTER the slot is assigned", () => {
  assert.match(studioBoardSource, /const handleSchedule = useCallback\(\(id: string, options\?: \{ instagramCaption\?: string \}\)/);
  const scheduleBody = studioBoardSource.slice(
    studioBoardSource.indexOf("const handleSchedule = useCallback"),
    studioBoardSource.indexOf("const handleCustomSchedule = useCallback"),
  );
  const slotIdx = scheduleBody.indexOf("ensureScheduledPlanTime(id)");
  const splitIdx = scheduleBody.indexOf("splitMixedVideoDraftInStore(id");
  assert.ok(slotIdx > -1 && splitIdx > -1, "both calls are present");
  assert.ok(splitIdx > slotIdx, "the split call comes AFTER the schedule slot is written, so the IG child inherits it");
});

test("StudioBoard.handleCustomSchedule accepts the instagramCaption option and calls splitMixedVideoDraftInStore AFTER the slot is assigned", () => {
  assert.match(studioBoardSource, /const handleCustomSchedule = useCallback\(\(id: string, date: string, time: string, options\?: \{ instagramCaption\?: string \}\)/);
  const customBody = studioBoardSource.slice(studioBoardSource.indexOf("const handleCustomSchedule = useCallback"));
  const slotIdx = customBody.indexOf("smartScheduleDraft(id");
  const splitIdx = customBody.indexOf("splitMixedVideoDraftInStore(id");
  assert.ok(slotIdx > -1 && splitIdx > -1, "both calls are present");
  assert.ok(splitIdx > slotIdx, "the split call comes AFTER the schedule slot is written, so the IG child inherits it");
});

test("StudioBoard wires onSchedule/onCustomSchedule straight to these handlers (no separate untouched pair)", () => {
  assert.match(studioBoardSource, /onSchedule=\{handleSchedule\} onCustomSchedule=\{handleCustomSchedule\}/);
});

const formSource = readFileSync("src/components/pins/PinFieldsForm.tsx", "utf8");

test("PinFieldsForm supports hiddenFields for title/websiteUrl/board", () => {
  assert.match(formSource, /hiddenFields\?: ReadonlyArray<"title" \| "websiteUrl" \| "board">/);
  assert.match(formSource, /!hidden\("title"\)/);
  assert.match(formSource, /!hidden\("websiteUrl"\)/);
  assert.match(formSource, /!hidden\("board"\)/);
});

test("PinFieldsForm supports an overridable description label (for the IG caption label)", () => {
  assert.match(formSource, /descriptionLabel\?: string/);
  assert.match(formSource, /descriptionLabel \?\? tr\("pinForm\.description"\)/);
});

console.log("\n=== 5. i18n keys exist (source-level; validate-i18n-catalogs/coverage cover full-catalog checks) ===");

const enStudioBoard = readFileSync("src/lib/i18n/messages/en/studioBoard.ts", "utf8");
for (const key of [
  "studioBoard.card.instagramCaption.label",
  "studioBoard.card.instagramCaption.help",
  "studioBoard.card.instagramCaption.placeholder",
  "studioBoard.card.instagramCaption.errorRequired",
  "studioBoard.card.instagramCaption.errorLink",
  "studioBoard.card.instagramCaption.splitNotice",
  "studioBoard.card.instagramCaption.splitAction",
]) {
  test(`en/studioBoard.ts defines ${key}`, () => {
    assert.match(enStudioBoard, new RegExp(`"${key.replace(/\./g, "\\.")}":`));
  });
}

console.log(`\nMixed video split UI (T3): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
