import assert from "node:assert/strict";
import {
  BOARD_IDS,
  buildReviewPatch,
  classifyExistingDraft,
  reconcileDrafts,
  type ExistingDraft,
  type ManifestRow,
} from "./lib/reconcile-cheerish-drafts";

const row = (n: number, overrides: Partial<ManifestRow> = {}): ManifestRow => ({
  mappingId: `map-${n}`,
  sha256: `${n}`.padStart(64, "0"),
  localFilePath: `D:/videos/${n}.mp4`,
  sourceLocalFileName: `${n}.mp4`,
  title: `Title ${n}`,
  description: `Description ${n}`,
  destinationUrl: `https://cheerish.co/products/product-${n}`,
  boardName: "Home & Kitchen Finds",
  scheduledAt: `2026-09-20T10:${String(n).padStart(2, "0")}:00-04:00`,
  ...overrides,
});

const existing = (n: number, overrides: Partial<ExistingDraft> = {}): ExistingDraft => {
  const source = row(n);
  return {
    userId: "user-1",
    draftId: `draft-${n}`,
    status: "ready",
    scheduledAt: null,
    payload: {
      title: source.title,
      description: source.description,
      destinationUrl: source.destinationUrl,
      boardName: source.boardName,
      scheduledDate: "2026-09-20",
      scheduledTime: `10:${String(n).padStart(2, "0")}`,
      media: [{ id: `media-${n}`, kind: "video", url: `/api/storage-media?path=${n}` }],
    },
    ...overrides,
  };
};

assert.equal(classifyExistingDraft(existing(1)), "draft");
assert.equal(classifyExistingDraft(existing(1, { scheduledAt: "2026-09-20T10:01:00-04:00" })), "scheduled");
assert.equal(classifyExistingDraft(existing(1, { payload: { ...existing(1).payload, remotePinId: "pin-1" } })), "posted");

const matched = reconcileDrafts([row(1)], [existing(1)]);
assert.equal(matched.ok, true);
assert.equal(matched.items.length, 1);
assert.equal(matched.items[0].draftId, "draft-1");
assert.equal(matched.items[0].mediaId, "media-1");
assert.equal(matched.items[0].boardId, BOARD_IDS["Home & Kitchen Finds"]);

const patch = buildReviewPatch(matched.items[0], "a273f91c-4589-4fce-b19c-e24f2bdf6c99", "cheerishh");
assert.equal(patch.draftId, "draft-1");
assert.deepEqual(patch.media, { id: "media-1", kind: "video", url: "/api/storage-media?path=1" });
assert.equal(patch.set.scheduled_at, "2026-09-20T10:01:00-04:00");
assert.equal(patch.set.payload.boardId, BOARD_IDS["Home & Kitchen Finds"]);
assert.equal(patch.set.payload.targetConnectionId, "a273f91c-4589-4fce-b19c-e24f2bdf6c99");

const ambiguous = reconcileDrafts([row(1)], [existing(1), existing(1, { draftId: "draft-duplicate" })]);
assert.equal(ambiguous.ok, false);
assert.match(ambiguous.failures[0], /ambiguous/);

const missing = reconcileDrafts([row(2)], [existing(1)]);
assert.equal(missing.ok, false);
assert.match(missing.failures[0], /missing/);

const blocked = reconcileDrafts([row(1)], [existing(1, { scheduledAt: "2026-09-20T10:01:00-04:00" })]);
assert.equal(blocked.ok, false);
assert.match(blocked.failures[0], /not_draft/);

console.log("reconcile-cheerish-drafts tests passed");
