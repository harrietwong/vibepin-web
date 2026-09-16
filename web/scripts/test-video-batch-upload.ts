import assert from "node:assert/strict";
import {
  VIDEO_BATCH_UPLOAD_CONCURRENCY,
  createVideoBatchState,
  queueFailedVideoItems,
  reduceVideoBatch,
  runVideoBatch,
  selectRetryableVideoItems,
  summarizeVideoBatch,
  validateVideoBatchSelection,
  type VideoBatchItem,
} from "../src/lib/studio/videoBatchUpload";
import { probeVideoFile } from "../src/lib/studio/videoBrowserMedia";
import { listVideoRecovery, removeVideoRecovery, saveVideoRecovery } from "../src/lib/studio/videoBatchRecovery";
import { handleStudioUploadCleanup } from "../src/app/api/studio/upload/handler";

type FakeFile = { name: string; type: string; size: number };
const video = (name: string, type = "video/mp4", size = 1024): FakeFile => ({ name, type, size });
const image = (name: string): FakeFile => ({ name, type: "image/png", size: 1024 });

let passed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  passed++;
  console.log(`  OK ${name}`);
}

function item(id: string, state: VideoBatchItem["state"] = "queued"): VideoBatchItem {
  return {
    id, file: video(`${id}.mp4`) as File, state, ordinal: Number(id.replace(/\D/g, "") || 0),
    inspection: { contentType: "video/mp4", width: 1080, height: 1920, durationMs: 5_000, checksumSha256: "a".repeat(64) },
  };
}

async function main() {
  console.log("\nVideo batch upload orchestration\n");

  await test("flag-off selection keeps video out of the image-only input contract", () => {
    const result = validateVideoBatchSelection([image("still.png") as File, video("clip.mp4") as File], false);
    assert.equal(result.kind, "rejected");
    assert.equal(result.error?.code, "video_upload_disabled");
  });

  await test("video and mixed selections are always one-draft-per-file, never a carousel", () => {
    const videos = validateVideoBatchSelection([video("a.mp4") as File, video("b.mov", "video/quicktime") as File], true);
    assert.equal(videos.kind, "video");
    assert.equal(videos.draftMode, "separate");
    const mixed = validateVideoBatchSelection([image("still.png") as File, video("clip.mp4") as File], true);
    assert.equal(mixed.kind, "mixed");
    assert.equal(mixed.draftMode, "separate");
  });

  await test("selection rejects the twenty-first file, unsafe container, and oversize video before prepare", () => {
    const tooMany = validateVideoBatchSelection(Array.from({ length: 21 }, (_, index) => video(`${index}.mp4`) as File), true);
    assert.equal(tooMany.error?.code, "batch_limit_exceeded");
    assert.equal(validateVideoBatchSelection([video("clip.avi", "video/x-msvideo") as File], true).error?.code, "invalid_video_type");
    assert.equal(validateVideoBatchSelection([video("disguised.avi", "video/mp4") as File], true).error?.code, "invalid_video_type");
    assert.equal(validateVideoBatchSelection([video("huge.mp4", "video/mp4", 100 * 1024 * 1024 + 1) as File], true).error?.code, "video_too_large");
  });

  await test("a successful item creates exactly one draft even if completion is observed twice", async () => {
    const state = createVideoBatchState("batch-a", [item("1")]);
    const drafts: string[] = [];
    let descriptorKey = "";
    const next = await runVideoBatch(state, {
      prepare: async descriptors => { descriptorKey = descriptors[0]?.idempotencyKey ?? ""; return { batchId: "server-a", uploads: descriptors.map(descriptor => ({ ordinal: descriptor.ordinal, path: `owner/${descriptor.ordinal}.mp4`, token: "redacted", signedUrl: `https://storage.test/object/upload/sign/generated-private/owner/${descriptor.ordinal}.mp4?token=redacted`, contentType: descriptor.contentType, upsert: false as const })) }; },
      upload: async () => undefined,
      finalize: async () => ({ proxyUrl: "/api/storage-media?path=owner%2F0.mp4", requestId: "req-finalize" }),
      createDraft: async current => { drafts.push(current.id); },
    });
    assert.equal(next.items[0].state, "succeeded");
    assert.match(descriptorKey, /^[A-Za-z0-9_-]{1,128}$/, "prepare idempotency keys must satisfy the server contract");
    assert.deepEqual(drafts, ["1"]);
    const replay = reduceVideoBatch(next, { type: "succeeded", id: "1", requestId: "duplicate-event" });
    assert.equal(replay.items[0].state, "succeeded");
    assert.deepEqual(drafts, ["1"]);
  });

  await test("a sibling failure is partial and does not roll back the completed draft", async () => {
    const state = createVideoBatchState("batch-b", [item("1"), item("2")]);
    const created: string[] = [];
    const final = await runVideoBatch(state, {
      prepare: async descriptors => ({ batchId: "server-b", uploads: descriptors.map(descriptor => ({ ordinal: descriptor.ordinal, path: `owner/${descriptor.ordinal}.mp4`, token: "redacted", signedUrl: `https://storage.test/object/upload/sign/generated-private/owner/${descriptor.ordinal}.mp4?token=redacted`, contentType: descriptor.contentType, upsert: false as const })) }),
      upload: async (_upload, current) => { if (current.id === "2") throw Object.assign(new Error("signed-token must not surface"), { code: "video_upload_failed", requestId: "req-two" }); },
      finalize: async () => ({ proxyUrl: "/api/storage-media?path=owner%2F0.mp4", requestId: "req-finalize" }),
      createDraft: async current => { created.push(current.id); },
    });
    assert.equal(summarizeVideoBatch(final), "partial");
    assert.deepEqual(created, ["1"]);
    assert.equal(final.items[0].state, "succeeded");
    assert.equal(final.items[1].state, "failed");
    assert.equal(final.items[1].error?.code, "video_upload_failed");
    assert.doesNotMatch(JSON.stringify(final), /signed-token|storage\.test/);
  });

  await test("work is capped at two concurrent video transfers", async () => {
    const state = createVideoBatchState("batch-c", [item("0"), item("1"), item("2"), item("3"), item("4")]);
    let active = 0; let peak = 0;
    const final = await runVideoBatch(state, {
      prepare: async descriptors => ({ batchId: "server-c", uploads: descriptors.map(descriptor => ({ ordinal: descriptor.ordinal, path: `owner/${descriptor.ordinal}.mp4`, token: "redacted", signedUrl: `https://storage.test/object/upload/sign/generated-private/owner/${descriptor.ordinal}.mp4?token=redacted`, contentType: descriptor.contentType, upsert: false as const })) }),
      upload: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; },
      finalize: async () => ({ proxyUrl: "/api/storage-media?path=owner%2F0.mp4", requestId: "req-finalize" }),
      createDraft: async () => undefined,
    });
    assert.equal(peak, VIDEO_BATCH_UPLOAD_CONCURRENCY);
    assert.equal(summarizeVideoBatch(final), "completed");
  });

  await test("retry selects only failed work and preserves successful items", () => {
    const state = createVideoBatchState("batch-d", [item("1", "succeeded"), item("2", "failed"), item("3", "cancelled")]);
    assert.deepEqual(selectRetryableVideoItems(state).map(current => current.id), ["2"]);
  });

  await test("retry never requeues a local decode failure without an inspection", () => {
    const state = createVideoBatchState("batch-decode", [
      { ...item("1", "failed"), inspection: undefined, error: { code: "video_decode_failed" } },
      { ...item("2", "failed"), error: { code: "video_upload_failed" } },
    ]);
    assert.deepEqual(selectRetryableVideoItems(state).map(current => current.id), ["2"]);
  });

  await test("a draft writer that cannot durably acknowledge persistence is retryable, not succeeded", async () => {
    const final = await runVideoBatch(createVideoBatchState("batch-persist", [item("1")]), {
      prepare: async descriptors => ({ batchId: "server-persist", uploads: descriptors.map(descriptor => ({ ordinal: descriptor.ordinal, path: `owner/${descriptor.ordinal}.mp4`, token: "redacted", signedUrl: `https://storage.test/object/upload/sign/generated-private/owner/${descriptor.ordinal}.mp4?token=redacted`, contentType: descriptor.contentType, upsert: false as const })) }),
      upload: async () => undefined,
      finalize: async () => ({ proxyUrl: "/api/storage-media?path=owner%2F0.mp4", requestId: "req-persist" }),
      createDraft: async () => ({ persisted: false }),
    });
    assert.equal(final.items[0].state, "failed");
    assert.equal(final.items[0].error?.code, "draft_persist_failed");
  });

  await test("a lost finalize response is replayed without a second signed upload", async () => {
    let prepares = 0; let uploads = 0; let finalizes = 0; let drafts = 0;
    const deps = {
      prepare: async (descriptors: import("../src/lib/studio/videoBatchUpload").VideoUploadDescriptor[]) => {
        prepares++;
        return { batchId: "server-replay", uploads: descriptors.map(descriptor => ({ ordinal: descriptor.ordinal, path: `owner/${descriptor.ordinal}.mp4`, token: "redacted", signedUrl: `https://storage.test/object/upload/sign/generated-private/owner/${descriptor.ordinal}.mp4?token=redacted`, contentType: descriptor.contentType, upsert: false as const })) };
      },
      upload: async () => { uploads++; },
      finalize: async () => { finalizes++; if (finalizes === 1) throw Object.assign(new Error("network_error"), { code: "network_error" }); return { proxyUrl: "/api/storage-media?path=owner%2F0.mp4", requestId: "req-replayed" }; },
      createDraft: async () => { drafts++; return { persisted: true, draftId: "draft-replayed" }; },
    };
    const first = await runVideoBatch(createVideoBatchState("batch-replay", [item("1")]), deps);
    assert.equal(first.items[0].state, "failed");
    const second = await runVideoBatch(queueFailedVideoItems(first), deps);
    assert.equal(second.items[0].state, "succeeded");
    assert.equal(prepares, 1); assert.equal(uploads, 1); assert.equal(finalizes, 2); assert.equal(drafts, 1);
  });

  await test("a cancellation racing after server finalize creates the idempotent draft instead of orphaning ready media", async () => {
    const controller = new AbortController();
    let drafts = 0;
    const final = await runVideoBatch(createVideoBatchState("batch-finalize-race", [item("1")]), {
      signal: controller.signal,
      prepare: async descriptors => ({ batchId: "server-finalize-race", uploads: descriptors.map(descriptor => ({ ordinal: descriptor.ordinal, path: `owner/${descriptor.ordinal}.mp4`, token: "redacted", signedUrl: `https://storage.test/object/upload/sign/generated-private/owner/${descriptor.ordinal}.mp4?token=redacted`, contentType: descriptor.contentType, upsert: false as const })) }),
      upload: async () => undefined,
      finalize: async () => { controller.abort(); return { proxyUrl: "/api/storage-media?path=owner%2F0.mp4", requestId: "req-finalized" }; },
      createDraft: async () => { drafts++; },
    });
    assert.equal(final.items[0].state, "succeeded");
    assert.equal(drafts, 1);
  });

  await test("cancel aborts in-flight work and marks queued work cancelled without deleting success", async () => {
    const controller = new AbortController();
    const state = createVideoBatchState("batch-e", [item("1", "succeeded"), item("2"), item("3"), item("4")]);
    const pending = runVideoBatch(state, {
      signal: controller.signal,
      prepare: async descriptors => ({ batchId: "server-e", uploads: descriptors.map(descriptor => ({ ordinal: descriptor.ordinal, path: `owner/${descriptor.ordinal}.mp4`, token: "redacted", signedUrl: `https://storage.test/object/upload/sign/generated-private/owner/${descriptor.ordinal}.mp4?token=redacted`, contentType: descriptor.contentType, upsert: false as const })) }),
      upload: async (_upload, _current, _batchId, signal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "video_upload_aborted" })), { once: true })),
      finalize: async () => ({ proxyUrl: "/api/storage-media?path=owner%2F0.mp4", requestId: "req-finalize" }),
      createDraft: async () => undefined,
    });
    setTimeout(() => controller.abort(), 0);
    const resolved = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancel did not settle")), 50))]);
    assert.equal(resolved.items[0].state, "succeeded");
    assert.equal(resolved.items[1].state, "cancelled");
    assert.equal(resolved.items[2].state, "cancelled");
    assert.equal(resolved.items[3].state, "cancelled", "queued work must not start after cancellation");
    assert.equal(summarizeVideoBatch(resolved), "cancelled");
  });

  await test("metadata alone is insufficient when the required first video frame cannot decode", async () => {
    class MockVideo extends EventTarget {
      readyState = 1; duration = 5; videoWidth = 1080; videoHeight = 1920; preload = ""; muted = false; playsInline = false; src = ""; private position = 0;
      get currentTime() { return this.position; }
      set currentTime(value: number) { this.position = value; queueMicrotask(() => this.dispatchEvent(new Event("error"))); }
      removeAttribute() {} load() {}
    }
    const original = { document: globalThis.document, HTMLMediaElement: globalThis.HTMLMediaElement, window: globalThis.window };
    Object.assign(globalThis, { HTMLMediaElement: { HAVE_METADATA: 1 }, window: { setTimeout, clearTimeout }, document: { createElement: () => new MockVideo() } });
    try {
      const decoded = new File(["video"], "frame-error.mp4", { type: "video/mp4" });
      await assert.rejects(() => probeVideoFile(decoded), /video_decode_failed/);
    } finally {
      Object.assign(globalThis, original);
    }
  });

  await test("finalized recovery receipts are owner scoped and never retain signed capabilities", () => {
    const data = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.assign(globalThis, { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) } });
    try {
      const ownerA = { ownerUserId: "11111111-1111-4111-8111-111111111111", workspaceId: "default" };
      assert.equal(saveVideoRecovery({ version: 1, logicalId: "a", draftIdempotencyKey: "video:a", owner: ownerA, filename: "clip.mp4", title: "clip", inspection: { width: 1, height: 2, durationMs: 5000 }, finalized: { proxyUrl: `/api/storage-media?path=${ownerA.ownerUserId}%2Fclip.mp4`, requestId: "req-a" }, createdAt: "2026-09-16T00:00:00.000Z" }), true);
      assert.equal(listVideoRecovery({ ownerUserId: "22222222-2222-4222-8222-222222222222", workspaceId: "default" }).length, 0);
      assert.equal(listVideoRecovery(ownerA).length, 1);
      assert.doesNotMatch(JSON.stringify(listVideoRecovery(ownerA)), /signedUrl|token|REVIEW_TOKEN/);
      assert.equal(removeVideoRecovery(ownerA, "a"), true);
      assert.equal(listVideoRecovery(ownerA).length, 0);
    } finally { Object.assign(globalThis, { localStorage: original }); }
  });

  await test("poster cleanup is a durable owner-bound outbox request", async () => {
    const recorded: Array<{ owner_user_id: string; object_path: string }> = [];
    const response = await handleStudioUploadCleanup(new Request("https://app.invalid/cleanup", {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": "cleanup_1" },
      body: JSON.stringify({ path: "studio/uploads/owner-a/cover.jpg" }),
    }), {
      getUserId: async () => "owner-a", configured: true,
      findProvenance: async () => ({ source_type: "upload", lifecycle_state: "draft" }),
      canCleanupPoster: async () => true,
      recordCleanup: async entry => { recorded.push(entry); },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(recorded, [{ owner_user_id: "owner-a", bucket_id: "generated-private", object_path: "studio/uploads/owner-a/cover.jpg", reason: "unattached_video_poster" }]);
    const rejected = await handleStudioUploadCleanup(new Request("https://app.invalid/cleanup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "studio/uploads/owner-b/cover.jpg" }),
    }), { getUserId: async () => "owner-a", configured: true, findProvenance: async () => ({ source_type: "upload", lifecycle_state: "draft" }), canCleanupPoster: async () => true, recordCleanup: async entry => { recorded.push(entry); } });
    assert.equal(rejected.status, 400);
  });

  console.log(`\n${passed} video batch upload checks passed.\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
