import assert from "node:assert/strict";
import {
  VIDEO_BATCH_UPLOAD_CONCURRENCY,
  createAppendableVideoUploadQueue,
  createVideoBatchState,
  queueFailedVideoItems,
  reduceVideoBatch,
  runVideoBatch,
  selectVisibleVideoQueueItems,
  selectRetryableVideoItems,
  summarizeVideoBatch,
  validateVideoBatchSelection,
  type VideoBatchItem,
} from "../src/lib/studio/videoBatchUpload";
import { probeVideoFile } from "../src/lib/studio/videoBrowserMedia";
import { sha256 } from "../src/lib/studio/videoDirectUpload";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function main() {
  console.log("\nVideo batch upload orchestration\n");

  await test("later selections append to one FIFO queue with at most three complete tasks active", async () => {
    assert.equal(VIDEO_BATCH_UPLOAD_CONCURRENCY, 3);
    const releases = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const queue = createAppendableVideoUploadQueue("append-fifo", {
      runItem: async current => {
        started.push(current.id);
        active++;
        peak = Math.max(peak, active);
        const gate = deferred();
        releases.set(current.id, gate);
        await gate.promise;
        active--;
        return { ...current, state: "succeeded" };
      },
    });

    const first = queue.append([item("0"), item("1"), item("2")]);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = queue.append([item("3"), item("4")]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(started, ["0", "1", "2"]);
    assert.equal(peak, 3);
    assert.deepEqual(queue.getSummary(), { active: 3, queued: 2, completed: 0, failed: 0, cancelled: 0, total: 5 });

    releases.get("1")!.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(started, ["0", "1", "2", "3"], "the first item from the appended selection starts in FIFO order");
    releases.get("0")!.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(started, ["0", "1", "2", "3", "4"]);
    for (const id of ["2", "3", "4"]) releases.get(id)!.resolve();
    await Promise.all([first, second]);
    assert.equal(queue.getSummary().completed, 5);
  });

  await test("one item failure does not pause siblings or later appended work", async () => {
    const completed: string[] = [];
    const queue = createAppendableVideoUploadQueue("isolated-failure", {
      runItem: async current => {
        if (current.id === "bad") throw Object.assign(new Error("private detail"), { code: "video_upload_failed", requestId: "req_bad" });
        completed.push(current.id);
        return { ...current, state: "succeeded" };
      },
    });
    await queue.append([item("good-1"), item("bad"), item("good-2"), item("later")]);
    assert.deepEqual(completed, ["good-1", "good-2", "later"]);
    assert.equal(queue.getState().items.find(current => current.id === "bad")?.error?.code, "video_upload_failed");
    assert.deepEqual(queue.getSummary(), { active: 0, queued: 0, completed: 3, failed: 1, cancelled: 0, total: 4 });
  });

  await test("retry requeues only one failed item with its stable draft key and a fresh transport attempt", async () => {
    const seen: Array<{ id: string; draftKey?: string; attemptId?: string }> = [];
    const queue = createAppendableVideoUploadQueue("independent-retry", {
      runItem: async current => {
        seen.push({ id: current.id, draftKey: current.draftIdempotencyKey, attemptId: current.attempt?.id });
        if (seen.length === 1) return {
          ...current,
          state: "failed",
          attempt: { id: "attempt_1", batchId: "batch_1", ordinal: current.ordinal, phase: "prepared" },
          error: { code: "video_upload_failed" },
        };
        return {
          ...current,
          state: "succeeded",
          attempt: { id: "attempt_2", batchId: "batch_2", ordinal: current.ordinal, phase: "finalize_pending" },
          error: undefined,
        };
      },
    });
    await queue.append([item("retry-me")]);
    const before = queue.getState().items[0];
    await queue.retry("retry-me");
    const after = queue.getState().items[0];
    assert.equal(after.state, "succeeded");
    assert.equal(after.draftIdempotencyKey, before.draftIdempotencyKey);
    assert.deepEqual(seen.map(value => value.attemptId), [undefined, undefined], "a terminal pre-finalize attempt is not replayed");
    assert.equal(after.attempt?.id, "attempt_2");
  });

  await test("per-item cancel aborts pending or transfer work without cancelling siblings", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const aborted: string[] = [];
    const queue = createAppendableVideoUploadQueue("independent-cancel", {
      runItem: async (current, signal) => {
        const gate = deferred();
        gates.set(current.id, gate);
        await Promise.race([
          gate.promise,
          new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
            aborted.push(current.id);
            reject(Object.assign(new Error("aborted"), { code: "video_upload_aborted" }));
          }, { once: true })),
        ]);
        return { ...current, state: "succeeded" };
      },
    });
    const settled = queue.append([item("keep-a"), item("cancel-active"), item("keep-b"), item("cancel-pending")]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(queue.cancel("cancel-pending"), true);
    assert.equal(queue.cancel("cancel-active"), true);
    gates.get("keep-a")!.resolve();
    gates.get("keep-b")!.resolve();
    await settled;
    assert.deepEqual(aborted, ["cancel-active"]);
    assert.equal(queue.getState().items.find(current => current.id === "cancel-active")?.state, "cancelled");
    assert.equal(queue.getState().items.find(current => current.id === "cancel-pending")?.state, "cancelled");
    assert.equal(queue.getSummary().completed, 2);
  });

  await test("per-item cancel lets finalize-pending and finalized recovery settle", async () => {
    let prepares = 0;
    let uploads = 0;
    let drafts = 0;
    const finalizing = deferred();
    const queue = createAppendableVideoUploadQueue("finalize-settle", {
      runItem: (current, signal, onState) => runVideoBatch(createVideoBatchState("finalize-settle", [{ ...current, state: "queued" }]), {
        signal,
        prepare: async descriptors => { prepares++; return { batchId: "server-finalize", uploads: descriptors.map(descriptor => ({ ordinal: descriptor.ordinal, path: `owner/${descriptor.ordinal}.mp4`, token: "redacted", signedUrl: "https://storage.test/signed", contentType: descriptor.contentType, upsert: false as const })) }; },
        upload: async () => { uploads++; },
        onAttempt: async (candidate, attempt) => {
          onState({ ...candidate, state: "uploading", attempt });
          if (attempt.phase === "finalize_pending") await finalizing.promise;
        },
        finalize: async () => ({ proxyUrl: "/api/storage-media?path=owner%2F0.mp4", requestId: "req-finalize" }),
        createDraft: async () => { drafts++; return { persisted: true, draftId: "draft-finalized" }; },
        onState: state => onState(state.items[0]),
      }).then(state => state.items[0]),
    });
    const settled = queue.append([item("finalizing")]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(queue.cancel("finalizing"), false, "finalize-pending work must be allowed to settle");
    finalizing.resolve();
    await settled;
    assert.equal(queue.getState().items[0].state, "succeeded");
    assert.equal(prepares, 1);
    assert.equal(uploads, 1);
    assert.equal(drafts, 1);
  });

  await test("disposing a queue aborts eligible work, never pumps pending work, and lets finalization settle", async () => {
    const finalizing = deferred();
    const started: string[] = [];
    const aborted: string[] = [];
    const queue = createAppendableVideoUploadQueue("dispose-lifecycle", {
      runItem: async (current, signal, onState) => {
        started.push(current.id);
        if (current.id === "finalizing") {
          onState({ ...current, state: "uploading", attempt: { id: "attempt", batchId: "batch", ordinal: 0, phase: "finalize_pending" } });
          await finalizing.promise;
          return { ...current, state: "succeeded" };
        }
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
          aborted.push(current.id);
          reject(Object.assign(new Error("aborted"), { code: "video_upload_aborted" }));
        }, { once: true }));
        return { ...current, state: "succeeded" };
      },
    });
    const settled = queue.append([item("finalizing"), item("active-a"), item("active-b"), item("never-started")]);
    await new Promise(resolve => setTimeout(resolve, 0));
    queue.dispose();
    assert.deepEqual(started, ["finalizing", "active-a", "active-b"]);
    assert.deepEqual(aborted.sort(), ["active-a", "active-b"]);
    assert.equal(queue.getState().items.find(current => current.id === "never-started")?.state, "cancelled");
    finalizing.resolve();
    await settled;
    assert.deepEqual(started, ["finalizing", "active-a", "active-b"], "disposed pending work must never pump");
    assert.equal(queue.getState().items.find(current => current.id === "finalizing")?.state, "succeeded");
  });

  await test("an old finalization keeps its global slot across dispose and remount", async () => {
    const oldFinalize = deferred();
    const oldStarted: string[] = [];
    const replacementStarted: string[] = [];
    const replacementGates = new Map<string, ReturnType<typeof deferred>>();
    const oldQueue = createAppendableVideoUploadQueue("old-owner-queue", {
      runItem: async (current, signal, onState) => {
        oldStarted.push(current.id);
        if (current.id === "old-finalizing") {
          onState({ ...current, state: "uploading", attempt: { id: "attempt", batchId: "batch", ordinal: 0, phase: "finalize_pending" } });
          await oldFinalize.promise;
          return { ...current, state: "succeeded" };
        }
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "video_upload_aborted" })), { once: true }));
        return { ...current, state: "succeeded" };
      },
    });
    const oldSettled = oldQueue.append([item("old-finalizing"), item("old-a"), item("old-b")]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(oldStarted.length, 3);
    oldQueue.dispose();

    const replacement = createAppendableVideoUploadQueue("replacement-owner-queue", {
      runItem: async current => {
        replacementStarted.push(current.id);
        const gate = deferred();
        replacementGates.set(current.id, gate);
        await gate.promise;
        return { ...current, state: "succeeded" };
      },
    });
    const replacementSettled = replacement.append([item("new-a"), item("new-b"), item("new-c")]);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(replacementStarted.length, 2, "the settling old finalize still owns one of the three global slots");
    oldFinalize.resolve();
    await oldSettled;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(replacementStarted.length, 3);
    for (const gate of replacementGates.values()) gate.resolve();
    await replacementSettled;
  });

  await test("all later terminal queue rows remain reachable after the eighth item", () => {
    const state = createVideoBatchState("visible-terminal-rows", Array.from({ length: 12 }, (_, index) => ({
      ...item(`terminal-${index}`, index % 2 ? "cancelled" : "failed"),
      error: index % 2 ? undefined : { code: "video_upload_failed" },
    })));
    const visible = selectVisibleVideoQueueItems(state);
    assert.equal(visible.length, 12);
    assert.equal(visible.at(-1)?.id, "terminal-11");
  });

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

  await test("work is capped at three concurrent video transfers", async () => {
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

  await test("preflight decode and checksum fail fast when their item is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = (error: unknown) => (error as { code?: string }).code === "video_upload_aborted";
    await assert.rejects(() => probeVideoFile(new File(["video"], "cancel.mp4", { type: "video/mp4" }), controller.signal), cancelled);
    await assert.rejects(() => sha256(new Blob(["video"]), controller.signal), cancelled);
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
  await test("terminal finalize replay cleans the old poster and makes a fresh attempt upload a new one", async () => {
    const oldPath = "studio/uploads/owner-a/old.png"; const newPath = "studio/uploads/owner-a/new.png";
    const base = item("fresh", "failed");
    const state = createVideoBatchState("fresh-poster", [{ ...base, posterFile: image("cover.png") as File, posterPath: oldPath,
      inspection: { ...base.inspection!, posterUrl: `/api/storage-image?path=${encodeURIComponent(oldPath)}` }, attempt: { id: "old", batchId: "old", ordinal: 0, phase: "finalize_pending" } }]);
    let cleaned = 0; let preparedPoster = 0;
    const output = await runVideoBatch(queueFailedVideoItems(state), {
      prepare: async descriptors => ({ batchId: "new", uploads: [{ ordinal: descriptors[0].ordinal, path: "owner-a/new.mp4", token: "new", signedUrl: "https://storage.test/object/upload/sign/generated-private/owner-a/new.mp4?token=new", contentType: "video/mp4", upsert: false as const }] }), upload: async () => {},
      finalize: async (batchId) => { if (batchId === "old") throw Object.assign(new Error("terminal"), { code: "video_upload_not_finalizable" }); return { proxyUrl: "/api/storage-media?path=owner-a%2Fnew.mp4", requestId: "new" }; },
      preparePoster: async () => { preparedPoster++; return { path: newPath, proxyUrl: `/api/storage-image?path=${encodeURIComponent(newPath)}` }; },
      cleanupPoster: async candidate => { assert.equal(candidate.posterPath, oldPath); cleaned++; }, createDraft: () => ({ persisted: true, draftId: "fresh" }),
    });
    assert.equal(cleaned, 1); assert.equal(preparedPoster, 1); assert.equal(output.items[0].posterPath, newPath);
  });

  console.log(`\n${passed} video batch upload checks passed.\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
