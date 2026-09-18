import assert from "node:assert/strict";
import * as store from "../src/lib/pinDraftStore";
import type { PinDraft } from "../src/lib/pinDraftStore";
import { buildPublishConfirmation, confirmPublishSnapshot, receiptMatchesDispatch } from "../src/lib/studio/publishConfirmation";
import { videoPublishSourceIdentityFingerprint } from "../src/lib/server/publish/v76PinterestVideoPublish";
import { validateImmediatePublishReceipt } from "../src/lib/server/publish/confirmationReceipt";

const memory = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) },
  window: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
});
const media = { id: "clip", kind: "video" as const, url: "/api/storage-media?path=owner%2Fvideo.mp4", posterUrl: "/api/storage-media?path=owner/old.jpg", durationMs: 4000, width: 720, height: 1280, source: "upload" as const, altText: "A demonstration" };
const draft = { id: "cover-draft", contentId: "cover-draft", imageUrl: media.posterUrl, media: [media], coverMediaId: "clip", title: "Demo", description: "", altText: "", destinationUrl: "", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z", scheduledDestinations: [{ provider: "pinterest", socialConnectionId: "account", boardId: "board", capturedAt: "2026-09-17T00:00:00.000Z" }] } as PinDraft;
function reset() {
  memory.set("vp:pin_drafts:v1", JSON.stringify({ drafts: { [draft.id]: draft } }));
  store.__resetMemoryCacheForTests();
}
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`OK ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}`, e); }
}
test("poster replacement atomically preserves video identity and persists the selected timestamp", () => {
  reset();
  assert.equal(typeof store.replaceVideoPoster, "function", "dedicated poster mutation is required");
  const next = store.replaceVideoPoster(draft.id, media.id, { posterUrl: "/api/storage-media?path=owner/new.jpg", coverFrameTimeMs: 1250 })!;
  assert.deepEqual(next.media, [{ ...media, posterUrl: "/api/storage-media?path=owner/new.jpg", coverFrameTimeMs: 1250 }]);
  assert.equal(next.imageUrl, "/api/storage-media?path=owner/new.jpg");
  assert.equal(next.coverMediaId, "clip");
  store.__resetMemoryCacheForTests();
  assert.deepEqual(store.getDraft(draft.id)?.media, next.media);
});
test("zero, one second, fractional milliseconds and duration boundary are preserved; invalid times cannot mutate", () => {
  for (const time of [0, 1000, 1250.5, 4000]) {
    reset();
    const next = store.replaceVideoPoster(draft.id, media.id, { posterUrl: "/api/storage-media?path=owner/new.jpg", coverFrameTimeMs: time })!;
    assert.equal(next.media?.[0].kind === "video" && next.media[0].coverFrameTimeMs, time);
  }
  for (const time of [-1, NaN, Infinity, 4000.1]) {
    reset();
    assert.throws(() => store.replaceVideoPoster(draft.id, media.id, { posterUrl: "/api/storage-media?path=owner/new.jpg", coverFrameTimeMs: time }));
    assert.deepEqual(store.getDraft(draft.id)?.media, [media]);
  }
});
test("a cover mutation advances the sync revision even when the local clock is behind", () => {
  const future = { ...draft, updatedAt: "2099-01-01T00:00:00.000Z" };
  memory.set("vp:pin_drafts:v1", JSON.stringify({ drafts: { [draft.id]: future } }));
  store.__resetMemoryCacheForTests();
  const next = store.replaceVideoPoster(draft.id, media.id, { posterUrl: "/api/storage-image?path=studio/uploads/owner/new.jpg", coverFrameTimeMs: 0 })!;
  assert.ok(next.updatedAt > future.updatedAt, "sync must see a strictly newer media revision");
});
test("cover time changes both confirmation and durable source fingerprints even at the same revision", () => {
  const before = buildPublishConfirmation(draft);
  const changed = { ...draft, media: [{ ...media, coverFrameTimeMs: 1250 }] };
  const after = buildPublishConfirmation(changed);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.notEqual(videoPublishSourceIdentityFingerprint(confirmPublishSnapshot(before)), videoPublishSourceIdentityFingerprint(confirmPublishSnapshot(after)));
  assert.equal(receiptMatchesDispatch(confirmPublishSnapshot(before), changed), false);
});
test("server receipt preserves validated explicit timestamps and rejects tampered or invalid selection", () => {
  for (const time of [undefined, 0, 1000, 1250.5, 4000, -1, NaN, Infinity, 4001]) {
    const selected = { ...draft, media: [{ ...media, ...(time !== undefined ? { coverFrameTimeMs: time } : {}) }] };
    const receipt = confirmPublishSnapshot(buildPublishConfirmation(selected));
    const content = { draftId: draft.id, title: draft.title, description: draft.description, altText: draft.altText, destinationUrl: draft.destinationUrl, imageUrls: [media.url] };
    const result = validateImmediatePublishReceipt(receipt, content, receipt.dispatchDestinationIds);
    assert.equal(result.ok, time === undefined || (Number.isFinite(time) && time >= 0 && time <= 4000), JSON.stringify({ time, result }));
    if (result.ok) assert.equal(result.receipt.media[0].kind === "video" && result.receipt.media[0].coverFrameTimeMs, time);
    if (time === 1250.5) {
      assert.equal(validateImmediatePublishReceipt({ ...receipt, media: [{ ...receipt.media[0], coverFrameTimeMs: 0 }] }, content, receipt.dispatchDestinationIds).ok, false);
    }
  }
});
process.exitCode = failed ? 1 : 0;
