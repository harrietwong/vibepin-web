// Independent Round 2 safety assertions. Hermetic: no external calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as batch from "../src/lib/studio/videoBatchUpload";
import * as recovery from "../src/lib/studio/videoBatchRecovery";
import * as store from "../src/lib/pinDraftStore";
import { probeVideoFile } from "../src/lib/studio/videoBrowserMedia";
import { handleStudioUploadCleanup } from "../src/app/api/studio/upload/handler";

const A = { ownerUserId: "11111111-1111-4111-8111-111111111111", workspaceId: "default" };
const B = { ownerUserId: "22222222-2222-4222-8222-222222222222", workspaceId: "default" };
const memory = new Map<string, string>();
let quotaDraft = false;
Object.assign(globalThis, { localStorage: {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { if (quotaDraft && !k.includes("video-batch-recovery")) throw new Error("quota"); memory.set(k, v); },
  removeItem: (k: string) => memory.delete(k),
}, window: { dispatchEvent: () => true, setTimeout, clearTimeout } });
const file = (name = "clip.mp4") => new File(["video"], name, { type: "video/mp4" });
const photo = () => new File(["image"], "image.png", { type: "image/png" });
const inspection = { contentType: "video/mp4" as const, width: 1080, height: 1920, durationMs: 5000, checksumSha256: "a".repeat(64) };
const item = (ordinal = 0): batch.VideoBatchItem => ({ id: String(ordinal), ordinal, file: file(`${ordinal}.mp4`), state: "queued", inspection });
const signed = (ordinal: number) => ({ ordinal, path: `${A.ownerUserId}/${ordinal}.mp4`, token: "REVIEW_TOKEN", signedUrl: `https://storage.invalid/object/upload/sign/generated-private/${A.ownerUserId}/${ordinal}.mp4?token=REVIEW_TOKEN`, contentType: "video/mp4", upsert: false as const });
const finalize = async (_id: string, ordinal: number) => ({ proxyUrl: `/api/storage-media?path=${A.ownerUserId}%2F${ordinal}.mp4`, requestId: `req_${ordinal}` });
const prepare = async (ds: batch.VideoUploadDescriptor[]) => ({ batchId: `batch_${ds[0].ordinal}`, uploads: ds.map(d => signed(d.ordinal)) });
const err = (code: string) => Object.assign(new Error(code), { code });
function reset() { memory.clear(); quotaDraft = false; store.__resetMemoryCacheForTests(); store.setPinDraftOwnerScope(A.ownerUserId); }
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

function callbacks(overrides: Record<string, unknown> = {}, mutate?: (source: string) => string) {
  const source = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
  const begin = source.indexOf("  const executeVideoBatch = useCallback");
  const end = source.indexOf("  const handleFiles = useCallback", begin);
  const effects: Array<() => void | (() => void)> = [];
  let current: batch.VideoBatchState | undefined;
  const videoQueueRef: { current: { scope: typeof A; queue: batch.AppendableVideoUploadQueue } | null } = { current: null };
  const context = {
    ...batch, ...recovery, useCallback: (fn: unknown) => fn, useEffect: (fn: () => void | (() => void)) => { effects.push(fn); },
    videoQueueRef, videoQueueItemSequenceRef: { current: 0 }, ownerScopeKey: A.ownerUserId,
    setUploading: () => {}, setVideoBatch: (s: batch.VideoBatchState) => { current = s; }, setUploadProgress: () => {},
    prepareVideoDirectUpload: async (_key: string, ds: batch.VideoUploadDescriptor[]) => prepare(ds),
    uploadVideoToSignedStorage: async () => {}, finalizeVideoDirectUpload: finalize,
    pinDraftStore: store, defaultDestinationsForNewContent: () => [], flashSaved: () => {}, startImageAnalysis: () => {},
    toast: { success: () => {}, error: () => {} }, probeVideoFile: async () => inspection,
    uploadPinImage: async () => ({ proxyUrl: `/api/storage-image?path=studio%2Fuploads%2F${A.ownerUserId}%2Fcover.jpg`, path: `studio/uploads/${A.ownerUserId}/cover.jpg` }),
    requestPinImageCleanup: async () => {}, sha256: async () => inspection.checksumSha256,
    retainVideoPosterOperation: async () => {},
    track: () => {}, processFiles: async () => {}, videoBatch: undefined, uploading: false, ...overrides,
  };
  let text = source.slice(begin, end); if (mutate) text = mutate(text);
  const js = ts.transpileModule(text + "\nreturn { executeVideoBatch, getVideoQueue, startVideoBatch, processMixedVideoSelection, retryVideoItem, cancelVideoItem, cancelVideoBatch };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const methods = new Function(...Object.keys(context), js)(...Object.values(context));
  return { ...methods, state: () => current, videoQueueRef, recover: async () => { effects.forEach(fn => fn()); await flush(); await flush(); } };
}
const results: Array<{ name: string; okay: boolean; evidence?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, okay: true }); console.log(`PASS ${name}`); }
  catch (e) { const evidence = (e as Error).message; results.push({ name, okay: false, evidence }); console.log(`FAIL ${name}: ${evidence}`); }
}

async function main() {
  await check("R1 in-memory lost finalize is replayed without reupload", async () => {
    reset(); let transfers = 0; let finalizes = 0;
    const ui = callbacks({ uploadVideoToSignedStorage: async () => { transfers++; }, finalizeVideoDirectUpload: async (id: string, n: number) => { if (++finalizes === 1) throw err("network_error"); return finalize(id, n); } });
    await ui.executeVideoBatch(batch.createVideoBatchState("lost", [item()]));
    await ui.executeVideoBatch(batch.queueFailedVideoItems(ui.state()!));
    assert.equal(transfers, 1); assert.equal(store.getAllDrafts().length, 1);
  });
  await check("R2 quota draft failure remains recoverable and restores once on reload", async () => {
    reset(); quotaDraft = true; const ui = callbacks();
    await ui.executeVideoBatch(batch.createVideoBatchState("quota", [item()]));
    assert.equal(ui.state()?.status, "failed"); assert.equal(recovery.listVideoRecovery(A).length, 1);
    quotaDraft = false; store.__resetMemoryCacheForTests(); store.setPinDraftOwnerScope(A.ownerUserId);
    await ui.recover(); await ui.recover(); assert.equal(store.getAllDrafts().length, 1);
  });
  await check("retained finalized retry calls durable retryPersist without a second transfer", async () => {
    reset(); let transfers = 0; quotaDraft = true; const ui = callbacks({ uploadVideoToSignedStorage: async () => { transfers++; } });
    await ui.executeVideoBatch(batch.createVideoBatchState("same-page-quota", [item()]));
    assert.equal(ui.state()?.status, "failed"); quotaDraft = false;
    await ui.executeVideoBatch(batch.queueFailedVideoItems(ui.state()!));
    assert.equal(transfers, 1); assert.equal(store.hasPersistFailure(), false); assert.equal(store.getAllDrafts().length, 1);
  });
  await check("R2 lost finalize survives reload and is reconciled before deleting poster receipt", async () => {
    reset(); let finalizes = 0; let cleaned = 0;
    const ui = callbacks({ finalizeVideoDirectUpload: async (id: string, n: number) => { if (++finalizes === 1) throw err("network_error"); return finalize(id, n); }, requestPinImageCleanup: async () => { cleaned++; } });
    await ui.executeVideoBatch(batch.createVideoBatchState("reload-lost", [{ ...item(), posterFile: photo() }]));
    assert.equal(ui.state()?.items[0].attempt?.phase, "finalize_pending");
    store.__resetMemoryCacheForTests(); store.setPinDraftOwnerScope(A.ownerUserId); await ui.recover();
    assert.equal(cleaned, 0, "unknown finalized media must retain its poster");
    assert.equal(store.getAllDrafts().length, 1, "recovery must replay finalize and write the successful draft");
  });
  await check("R2 pending no-poster record must not stop later finalized recovery", async () => {
    reset(); const common = { version: 1 as const, owner: A, filename: "clip.mp4", title: "clip", inspection, createdAt: "2026-09-16" };
    recovery.saveVideoRecovery({ ...common, logicalId: "pending", draftIdempotencyKey: "pending", attempt: { id: "attempt", batchId: "batch", ordinal: 0, phase: "prepared" } });
    recovery.saveVideoRecovery({ ...common, logicalId: "done", draftIdempotencyKey: "done", finalized: await finalize("b", 1) });
    await callbacks().recover(); assert.equal(store.getAllDrafts().length, 1);
  });
  await check("R3 video-only second entry appends and cancel-all stops both preflights", async () => {
    reset(); const probe = deferred(); let transfers = 0;
    const ui = callbacks({ probeVideoFile: async () => { await probe.promise; return inspection; }, uploadVideoToSignedStorage: async () => { transfers++; } });
    const first = ui.startVideoBatch([file()]); const second = ui.startVideoBatch([file("second.mp4")]);
    await flush(); ui.cancelVideoBatch(); probe.resolve(); await Promise.all([first, second]);
    assert.equal(transfers, 0); assert.equal(store.getAllDrafts().length, 0);
    assert.equal(ui.state()?.items.length, 2); assert(ui.state()?.items.every((candidate: batch.VideoBatchItem) => candidate.state === "cancelled"));
  });
  await check("R3 mixed selection enqueues video before image await and a later video also appends", async () => {
    reset(); const image = deferred(); const transfer = deferred(); let transfers = 0;
    const ui = callbacks({ processFiles: async () => image.promise, uploadVideoToSignedStorage: async () => { transfers++; await transfer.promise; } });
    const mixed = ui.processMixedVideoSelection([photo(), file("mixed.mp4")]);
    await flush();
    const second = ui.startVideoBatch([file("second.mp4")]); await flush();
    assert.equal(transfers, 2, "both videos start without waiting for the mixed selection's image");
    image.resolve(); transfer.resolve(); await Promise.all([mixed, second]);
    assert.equal(ui.state()?.items.length, 2);
  });
  await check("R3 more than twenty lifetime selections reuse singleton transport ordinal zero", async () => {
    reset(); const ordinals: number[] = []; const cancelledProbe = deferred();
    const ui = callbacks({
      prepareVideoDirectUpload: async (_key: string, descriptors: batch.VideoUploadDescriptor[]) => {
        ordinals.push(descriptors[0].ordinal);
        return prepare(descriptors);
      },
      probeVideoFile: async (candidate: File) => {
        if (candidate.name === "cancelled.mp4") await cancelledProbe.promise;
        return inspection;
      },
    });
    for (let index = 0; index < 21; index++) await ui.startVideoBatch([file(`valid-${index}.mp4`)]);
    await ui.startVideoBatch([file("invalid.mp4")], { code: "invalid_video_type" });
    const cancelled = ui.startVideoBatch([file("cancelled.mp4")]);
    await flush();
    const cancelledId = ui.state()!.items.at(-1)!.id;
    ui.cancelVideoItem(cancelledId);
    cancelledProbe.resolve();
    await cancelled;
    await ui.startVideoBatch([file("valid-21.mp4")]);
    await ui.startVideoBatch([file("valid-22.mp4")]);
    assert.equal(ordinals.length, 23, "invalid and cancelled items must not consume a server transport slot");
    assert.ok(ordinals.every(ordinal => ordinal === 0), `singleton transport ordinals must stay zero: ${ordinals.join(",")}`);
  });
  await check("R3 finalize-pending queue retry preserves poster and skips browser preflight", async () => {
    reset(); let probes = 0; let hashes = 0; let finalizes = 0;
    const posterUrl = `/api/storage-image?path=studio%2Fuploads%2F${A.ownerUserId}%2Fcover.jpg`;
    const ui = callbacks({
      probeVideoFile: async () => { probes++; return { ...inspection, posterFile: photo() }; },
      sha256: async () => { hashes++; return inspection.checksumSha256; },
      finalizeVideoDirectUpload: async (id: string, ordinal: number) => {
        if (++finalizes === 1) throw err("network_error");
        return finalize(id, ordinal);
      },
    });
    await ui.startVideoBatch([file("finalize-replay.mp4")]);
    const failed = ui.state()!.items[0];
    assert.equal(failed.attempt?.phase, "finalize_pending");
    assert.equal(failed.inspection?.posterUrl, posterUrl);
    await ui.videoQueueRef.current!.queue.retry(failed.id);
    assert.equal(probes, 1); assert.equal(hashes, 1);
    assert.equal(ui.state()!.items[0].inspection?.posterUrl, posterUrl);
    assert.equal(store.getAllDrafts()[0].media?.[0].kind, "video");
    assert.equal(store.getAllDrafts()[0].imageUrl, posterUrl);
  });
  await check("R3 finalized receipt queue retry preserves poster and skips browser preflight", async () => {
    reset(); let probes = 0; let hashes = 0; quotaDraft = true;
    const posterUrl = `/api/storage-image?path=studio%2Fuploads%2F${A.ownerUserId}%2Fcover.jpg`;
    const ui = callbacks({
      probeVideoFile: async () => { probes++; return { ...inspection, posterFile: photo() }; },
      sha256: async () => { hashes++; return inspection.checksumSha256; },
    });
    await ui.startVideoBatch([file("finalized-replay.mp4")]);
    const failed = ui.state()!.items[0];
    assert.ok(failed.finalized);
    assert.equal(failed.inspection?.posterUrl, posterUrl);
    quotaDraft = false;
    await ui.videoQueueRef.current!.queue.retry(failed.id);
    assert.equal(probes, 1); assert.equal(hashes, 1);
    assert.equal(ui.state()!.items[0].inspection?.posterUrl, posterUrl);
  });
  await check("R4 A-to-B-to-A replacement rejects stale publications from the old A queue", async () => {
    reset(); const oldFinalizeEntered = deferred(); const releaseOldFinalize = deferred(); let finalizeCalls = 0;
    const ui = callbacks({ finalizeVideoDirectUpload: async (id: string, ordinal: number) => {
      if (finalizeCalls++ === 0) { oldFinalizeEntered.resolve(); await releaseOldFinalize.promise; }
      return finalize(id, ordinal);
    } });
    const oldA = ui.startVideoBatch([file("old-a.mp4")]);
    await oldFinalizeEntered.promise;
    store.setPinDraftOwnerScope(B.ownerUserId);
    await ui.startVideoBatch([file("owner-b.mp4")]);
    store.setPinDraftOwnerScope(A.ownerUserId);
    await ui.startVideoBatch([file("new-a.mp4")]);
    const currentId = ui.state()!.items[0].id;
    assert.equal(ui.state()!.items[0].file.name, "new-a.mp4");
    releaseOldFinalize.resolve();
    await oldA;
    assert.equal(ui.state()!.items[0].id, currentId);
    assert.equal(ui.state()!.items[0].file.name, "new-a.mp4");
  });
  await check("R4 owner switch after finalize cannot write B immediately or through Retry", async () => {
    reset(); const ui = callbacks({ finalizeVideoDirectUpload: async (id: string, n: number) => { store.setPinDraftOwnerScope(B.ownerUserId); return finalize(id, n); } });
    await ui.executeVideoBatch(batch.createVideoBatchState("owner", [item()]));
    assert.equal(store.getAllDrafts().length, 0, "initial write should reject B");
    await ui.executeVideoBatch(batch.queueFailedVideoItems(ui.state()!));
    assert.equal(store.getAllDrafts().length, 0, "Retry under B must not rebind A's finalized item");
  });
  await check("R5 bad sibling cannot poison retry of inspected file", async () => {
    reset(); let transfers = 0;
    const input = batch.createVideoBatchState("bad", [{ ...item(0), state: "failed", inspection: undefined }, { ...item(1), state: "failed" }]);
    const out = await batch.runVideoBatch(batch.queueFailedVideoItems(input), { prepare, upload: async () => { transfers++; }, finalize, createDraft: () => ({ persisted: true, draftId: "one" }) });
    assert.equal(transfers, 1); assert.equal(out.items[0].state, "failed"); assert.equal(out.items[1].state, "succeeded");
  });
  await check("R6 required decode error rejects, optional JPEG failure degrades", async () => {
    class MockVideo extends EventTarget {
      readyState = 1; duration = 5; videoWidth = 1080; videoHeight = 1920; private position = 0; failure = true;
      get currentTime() { return this.position; } set currentTime(v: number) { this.position = v; queueMicrotask(() => this.dispatchEvent(new Event(this.failure ? "error" : "seeked"))); }
      removeAttribute() {} load() {}
    }
    const mock = new MockVideo();
    Object.assign(globalThis, { HTMLMediaElement: { HAVE_METADATA: 1 }, document: { createElement: (type: string) => type === "video" ? mock : { getContext: () => null } } });
    await assert.rejects(() => probeVideoFile(file()), /video_decode_failed/);
    mock.failure = false; const result = await probeVideoFile(file()); assert.equal(result.posterFile, undefined);
    Reflect.deleteProperty(globalThis, "document");
  });
  await check("R7 server flag off stores no poster", async () => {
    reset(); let posters = 0; const ui = callbacks({ prepareVideoDirectUpload: async () => { throw err("video_upload_disabled"); }, uploadPinImage: async () => { posters++; return {}; } });
    await ui.executeVideoBatch(batch.createVideoBatchState("off", [{ ...item(), posterFile: photo() }])); assert.equal(posters, 0);
  });
  await check("R7 upload cancel after poster association queues poster cleanup", async () => {
    reset(); let cleaned = 0; const controller = new AbortController();
    const initial = batch.createVideoBatchState("cancel-poster", [{ ...item(), posterFile: photo() }]);
    const out = await batch.runVideoBatch(initial, { signal: controller.signal, prepare, preparePoster: async () => ({ path: `studio/uploads/${A.ownerUserId}/cover.jpg`, proxyUrl: "/api/storage-image?path=cover" }), upload: async () => { controller.abort(); }, finalize, createDraft: () => {}, cleanupPoster: async () => { cleaned++; } });
    assert.equal(out.items[0].state, "cancelled"); assert.equal(cleaned, 1);
  });
  await check("R7 corrupt cleanup paths and null payload fail closed before outbox", async () => {
    let enqueued = 0; const deps = { getUserId: async () => A.ownerUserId, configured: true, findProvenance: async () => ({ source_type: "upload", lifecycle_state: "draft" }), recordCleanup: async () => { enqueued++; } };
    const paths = [`studio/uploads/${A.ownerUserId}/../${B.ownerUserId}/cover.jpg`, `studio/uploads/${A.ownerUserId}/%2e%2e/${B.ownerUserId}/cover.jpg`, `studio/uploads/${A.ownerUserId}//cover.jpg`, `studio/uploads/${A.ownerUserId}/cover.jpg\u0000`];
    const statuses = [];
    for (const path of paths) {
      const response = await handleStudioUploadCleanup(new Request("https://app.invalid/cleanup", { method: "POST", body: JSON.stringify({ path }) }), deps);
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [400, 400, 400, 400]);
    assert.equal(enqueued, 0);
  });
  await check("R7 cleanup null JSON returns a bounded 400 response", async () => {
    let enqueued = 0; const deps = { getUserId: async () => A.ownerUserId, configured: true, findProvenance: async () => ({ source_type: "upload", lifecycle_state: "draft" }), recordCleanup: async () => { enqueued++; } };
    const nil = await handleStudioUploadCleanup(new Request("https://app.invalid/cleanup", { method: "POST", body: "null" }), deps);
    assert.equal(nil.status, 400); assert.equal(enqueued, 0);
  });
  await check("R7 authenticated valid cleanup is queued, foreign/anonymous cleanup denied, successful poster retained", async () => {
    reset(); const rows: unknown[] = []; const deps = { getUserId: async () => A.ownerUserId, configured: true, findProvenance: async () => ({ source_type: "upload", lifecycle_state: "draft" }), canCleanupPoster: async () => true, recordCleanup: async (row: unknown) => { rows.push(row); } };
    const request = (owner: string) => new Request("https://app.invalid/cleanup", { method: "POST", body: JSON.stringify({ path: `studio/uploads/${owner}/cover.jpg` }) });
    assert.equal((await handleStudioUploadCleanup(request(A.ownerUserId), deps)).status, 200);
    assert.equal((await handleStudioUploadCleanup(request(B.ownerUserId), deps)).status, 403);
    assert.equal((await handleStudioUploadCleanup(request(A.ownerUserId), { ...deps, getUserId: async () => null })).status, 401);
    assert.equal(rows.length, 1);
    let cleaned = 0;
    const ui = callbacks({ requestPinImageCleanup: async () => { cleaned++; } });
    await ui.executeVideoBatch(batch.createVideoBatchState("good-cover", [{ ...item(), posterFile: photo() }]));
    assert.equal(cleaned, 0); assert.equal(store.getAllDrafts()[0].media?.[0].kind, "video");
    assert.ok(store.getAllDrafts()[0].imageUrl);
  });
  await check("recovery schema validation isolates malformed and foreign-owner records", async () => {
    reset();
    memory.set("vibepin:video-batch-recovery:v1", JSON.stringify({ [`${B.ownerUserId}:default`]: [{ version: 1, owner: A, finalized: { proxyUrl: "https://foreign.invalid/video" } }] }));
    assert.deepEqual(recovery.listVideoRecovery(B), []);
  });
  await check("recovery ledger never silently evicts an unresolved finalized receipt", async () => {
    reset();
    for (let n = 0; n < 51; n++) {
      const record = { version: 1 as const, owner: A, logicalId: String(n), draftIdempotencyKey: String(n), filename: "v.mp4", title: "v", inspection, finalized: await finalize("b", n), createdAt: "2026-09-16" };
      const saved = recovery.saveVideoRecovery(record);
      if (!saved) break;
    }
    assert.ok(recovery.listVideoRecovery(A).some(r => r.logicalId === "0"), "capacity must fail closed rather than lose the oldest live receipt");
  });
  await check("R1 terminal finalize failure can allocate a fresh retry attempt", async () => {
    reset(); let prepares = 0;
    const initial = batch.createVideoBatchState("terminal", [{ ...item(), state: "failed", attempt: { id: "old", batchId: "old", ordinal: 0, phase: "finalize_pending" } }]);
    const out = await batch.runVideoBatch(batch.queueFailedVideoItems(initial), { prepare: async ds => { prepares++; return prepare(ds); }, upload: async () => {}, finalize: async (id, n) => { if (id === "old") throw err("video_upload_not_finalizable"); return finalize(id, n); }, createDraft: () => ({ persisted: true }) });
    assert.equal(prepares, 1); assert.equal(out.items[0].state, "succeeded");
  });
  await check("mutation removing owner check at draft commit is killed", async () => {
    reset();
    const ui = callbacks({ finalizeVideoDirectUpload: async (id: string, n: number) => { store.setPinDraftOwnerScope(B.ownerUserId); return finalize(id, n); } }, text => {
      const boundary = text.indexOf("      createDraft:");
      const needle = 'if (!ownerIsCurrent()) throw Object.assign(new Error("video_owner_changed"), { code: "video_owner_changed" });';
      assert(text.slice(boundary).includes(needle)); return text.slice(0, boundary) + text.slice(boundary).replace(needle, "/* MUTANT: owner guard removed */");
    });
    await ui.executeVideoBatch(batch.createVideoBatchState("mutant", [item()]));
    assert.throws(() => assert.equal(store.getAllDrafts().length, 0));
  });
  console.log(JSON.stringify({ passed: results.filter(x => x.okay).length, failed: results.filter(x => !x.okay).length, results }, null, 2));
  if (results.some(x => !x.okay)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
