import assert from "node:assert/strict";
import * as browserMedia from "../src/lib/studio/videoBrowserMedia";
import * as store from "../src/lib/pinDraftStore";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The strip pulls in the locale provider (via the cover dialog), which builds a
// Supabase browser client at import time; stub its env and import the strip lazily.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const mem = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) },
  window: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout },
});
const media = { id: "clip", kind: "video" as const, url: "/api/storage-media?path=owner/video.mp4", posterUrl: "/api/storage-image?path=studio/uploads/owner/old.jpg", durationMs: 4000, width: 720, height: 1280, source: "upload" as const };
const draft = { id: "cover", media: [media], imageUrl: media.posterUrl, coverMediaId: media.id, createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z" };
function reset() { mem.clear(); mem.set("vp:pin_drafts:v1", JSON.stringify({ drafts: { cover: draft } })); store.__resetMemoryCacheForTests(); }
async function main() {
  const { ContentMediaStrip } = await import("../src/components/studio/ContentMediaStrip");
  const html = renderToStaticMarkup(createElement(ContentMediaStrip, { draft: draft as never }));
  assert.match(html, /aria-label="Choose cover frame"/, "single-video cover must expose a meaningful frame selection action");
  assert.equal(typeof browserMedia.confirmVideoCoverFrame, "function", "confirmation must own capture/upload/atomic replace");
  for (const fail of ["capture", "upload", "none"]) {
    reset();
    let uploads = 0;
    const deps = {
      capture: async () => { if (fail === "capture") throw new Error("decode"); return new File(["poster"], "cover.jpg", { type: "image/jpeg" }); },
      upload: async (...args: unknown[]) => {
        uploads++;
        assert.equal(args.length, 1, "replacement must never reuse finalized v80 batch/ordinal association");
        assert.deepEqual(store.getDraft("cover")?.media, [media], "no draft change before upload success");
        if (fail === "upload") throw new Error("upload");
        return { proxyUrl: "/api/storage-image?path=studio/uploads/owner/new.jpg" };
      },
    };
    const operation = browserMedia.confirmVideoCoverFrame("cover", media, {} as HTMLVideoElement, 1250, deps);
    if (fail !== "none") {
      await assert.rejects(operation);
      assert.deepEqual(store.getDraft("cover")?.media, [media]);
      assert.equal(store.getDraft("cover")?.imageUrl, media.posterUrl);
    } else {
      await operation;
      assert.equal(store.getDraft("cover")?.imageUrl, "/api/storage-image?path=studio/uploads/owner/new.jpg");
      assert.deepEqual(store.getDraft("cover")?.media, [{ ...media, posterUrl: "/api/storage-image?path=studio/uploads/owner/new.jpg", coverFrameTimeMs: 1250 }]);
    }
    assert.equal(uploads, fail === "capture" ? 0 : 1);
  }
  reset();
  await assert.rejects(browserMedia.confirmVideoCoverFrame("cover", media, {} as HTMLVideoElement, 1250, {
    capture: async () => new File(["poster"], "cover.jpg", { type: "image/jpeg" }),
    upload: async () => {
      store.replaceVideoPoster("cover", "clip", { posterUrl: "/api/storage-image?path=studio/uploads/owner/other.jpg", coverFrameTimeMs: 2000 });
      return { proxyUrl: "/api/storage-image?path=studio/uploads/owner/new.jpg" };
    },
  }), /changed/);
  assert.equal(store.getDraft("cover")?.imageUrl, "/api/storage-image?path=studio/uploads/owner/other.jpg");
  for (const change of ["unmount", "owner"] as const) {
    for (const stage of ["capture", "upload"] as const) {
      reset();
      if (change === "owner") store.setPinDraftOwnerScope("owner-a");
      const lifetime = new AbortController();
      let uploads = 0;
      const invalidate = () => change === "unmount" ? lifetime.abort() : store.setPinDraftOwnerScope("owner-b");
      await assert.rejects(browserMedia.confirmVideoCoverFrame("cover", media, {} as HTMLVideoElement, 1250, {
        capture: async () => { if (stage === "capture") invalidate(); return new File(["poster"], "cover.jpg", { type: "image/jpeg" }); },
        upload: async () => { uploads++; if (stage === "upload") invalidate(); return { proxyUrl: "/api/storage-image?path=studio/uploads/owner/new.jpg" }; },
      }, lifetime.signal), /changed|cancelled/, `${change} during ${stage} must not commit`);
      if (change === "owner") {
        assert.equal(store.getDraft("cover"), null, "replacement must not appear in the new owner's store");
        store.setPinDraftOwnerScope("owner-a");
      }
      assert.deepEqual(store.getDraft("cover")?.media, [media]);
      assert.equal(store.getDraft("cover")?.imageUrl, media.posterUrl);
      assert.equal(uploads, stage === "capture" ? 0 : 1);
    }
  }
  reset();
  store.replaceVideoPoster("cover", "clip", { posterUrl: media.posterUrl, coverFrameTimeMs: 1250 });
  const events = new EventTarget();
  let position = 0;
  let capturedAt = -1;
  const video = Object.assign(events, { duration: 4, readyState: 2, videoWidth: 720, videoHeight: 1280, seeking: false, pause() {} });
  Object.defineProperty(video, "currentTime", { get: () => position, set: (value: number) => { position = value; queueMicrotask(() => video.dispatchEvent(new Event("seeked"))); } });
  Object.assign(globalThis, { document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => { capturedAt = position; } }), toBlob: (cb: (blob: Blob) => void) => cb(new Blob(["jpeg"], { type: "image/jpeg" })) }) } });
  const captured = await browserMedia.captureVideoCoverFrame(video as unknown as HTMLVideoElement, 1250, 4000);
  assert.equal(capturedAt, 1.25, "canvas captures after the chosen seek completes");
  assert.equal(captured.type, "image/jpeg");
  await assert.rejects(browserMedia.captureVideoCoverFrame(video as unknown as HTMLVideoElement, 4001, 4000));
  const { generatePinterestPinCopy } = await import("../src/lib/ai-copy/generatePinCopy");
  await assert.rejects(generatePinterestPinCopy({ draftId: "cover", imageUrl: media.posterUrl } as never), /sync/i, "AI cannot use a merely local confirmed cover");
  console.log("OK capture/upload failures preserve prior cover; confirmed replacement uses generic upload; stale edit cannot overwrite newer cover");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
