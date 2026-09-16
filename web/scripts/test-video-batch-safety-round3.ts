// Independent Round 3 adversarial assertions. No external calls or production edits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as batch from "../src/lib/studio/videoBatchUpload";
import * as recovery from "../src/lib/studio/videoBatchRecovery";
import * as store from "../src/lib/pinDraftStore";
import * as browserMedia from "../src/lib/studio/videoBrowserMedia";
import * as cleanup from "../src/app/api/studio/upload/handler";

// Reuse only the reviewed formal test's real-callback loader, never its assertions.
const formal = readFileSync("scripts/test-video-batch-safety.ts", "utf8");
const helpers = formal.slice(0, formal.indexOf("async function main()"));
const js = ts.transpileModule(helpers + "\nreturn { callbacks, reset, memory, A, B, item, file, photo, inspection, finalize, prepare, deferred, flush };", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const modules: Record<string, unknown> = { "node:assert/strict": assert, "node:fs": { readFileSync }, typescript: ts,
  "../src/lib/studio/videoBatchUpload": batch, "../src/lib/studio/videoBatchRecovery": recovery, "../src/lib/pinDraftStore": store,
  "../src/lib/studio/videoBrowserMedia": browserMedia, "../src/app/api/studio/upload/handler": cleanup };
const h = new Function("require", "exports", js)((name: string) => { assert(name in modules, `Unexpected import ${name}`); return modules[name]; }, {});
let passed = 0; let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${(error as Error).message}`); }
}
async function main() {
  await check("finalize is write-ahead durable before request dispatch, including abrupt close", async () => {
    h.reset(); const response = h.deferred(); const dispatched = h.deferred();
    const ui = h.callbacks({ finalizeVideoDirectUpload: async (id: string, n: number) => { dispatched.resolve(); await response.promise; return h.finalize(id, n); } });
    const run = ui.executeVideoBatch(batch.createVideoBatchState("during-finalize", [{ ...h.item(), posterFile: h.photo() }]));
    await dispatched.promise;
    const phase = recovery.listVideoRecovery(h.A)[0]?.attempt?.phase;
    response.resolve(); await run;
    assert.equal(phase, "finalize_pending", "a closed tab cannot execute the finalize catch handler");
  });
  await check("recovery rechecks owner AFTER awaited finalize and BEFORE writing draft", async () => {
    h.reset(); const record = { version: 1 as const, owner: h.A, logicalId: "pending-owner", draftIdempotencyKey: "pending-owner", filename: "v.mp4", title: "v", inspection: h.inspection,
      attempt: { id: "attempt", batchId: "batch", ordinal: 0, phase: "finalize_pending" as const }, createdAt: "2026-09-16" };
    assert.equal(recovery.saveVideoRecovery(record), true);
    const ui = h.callbacks({ finalizeVideoDirectUpload: async (id: string, n: number) => { store.setPinDraftOwnerScope(h.B.ownerUserId); return h.finalize(id, n); } });
    await ui.recover();
    assert.equal(store.getAllDrafts().length, 0, "B must receive no A recovery draft during the await window");
  });
  await check("mixed-image cancellation releases lock and settles queued videos", async () => {
    h.reset(); const images = h.deferred(); let transferred = 0;
    const ui = h.callbacks({ processFiles: async () => images.promise, uploadVideoToSignedStorage: async () => { transferred++; } });
    const first = ui.processMixedVideoSelection([h.photo(), h.file()]);
    ui.cancelVideoBatch(); images.resolve(); await first;
    const locked = Boolean(ui.operationRef.current);
    await ui.startVideoBatch([h.file("next.mp4")]);
    assert.equal(locked, false, "cancel must release the mixed-operation lock");
    assert.equal(transferred, 1, "the next user selection must work after cancellation");
  });
  await check("cleanup refuses an already referenced uploaded image, even while provenance remains draft", async () => {
    h.reset(); let rows = 0;
    const path = `studio/uploads/${h.A.ownerUserId}/cover.jpg`;
    // This is the actual persisted shape of a normal live Studio upload/cover.
    store.createBoardDraft({ imageUrl: `/api/storage-image?path=${encodeURIComponent(path)}`, source: "uploaded_image", idempotencyKey: "attached-image" });
    const response = await cleanup.handleStudioUploadCleanup(new Request("https://app.invalid/cleanup", { method: "POST", body: JSON.stringify({ path }) }), {
      getUserId: async () => h.A.ownerUserId, configured: true,
      findProvenance: async () => ({ source_type: "upload", lifecycle_state: "draft" }),
      recordCleanup: async () => { rows++; },
    });
    assert.equal(response.status, 409, "draft provenance is not evidence that a poster is unattached"); assert.equal(rows, 0);
  });
  await check("malformed stored owner bucket cannot throw from save/remove or erase a valid later record", async () => {
    h.reset(); h.memory.set("vibepin:video-batch-recovery:v1", JSON.stringify({ [`${h.A.ownerUserId}:default`]: {} }));
    const record = { version: 1 as const, owner: h.A, logicalId: "valid", draftIdempotencyKey: "valid", filename: "v.mp4", title: "v", inspection: h.inspection, finalized: await h.finalize("b", 1), createdAt: "2026-09-16" };
    assert.doesNotThrow(() => recovery.saveVideoRecovery(record));
    assert.doesNotThrow(() => recovery.removeVideoRecovery(h.A, "valid"));
  });
  await check("recovery requires exact media-path owner, not an owner string elsewhere in query", async () => {
    h.reset(); const wrong = `/api/storage-media?path=${h.B.ownerUserId}%2Fsecret.mp4&unrelated=${h.A.ownerUserId}%2F`;
    const record = { version: 1 as const, owner: h.A, logicalId: "bad-path", draftIdempotencyKey: "bad-path", filename: "v.mp4", title: "v", inspection: h.inspection, finalized: { proxyUrl: wrong, requestId: "req" }, createdAt: "2026-09-16" };
    assert.equal(recovery.saveVideoRecovery(record), false);
  });
  await check("new mutation: removing cleanup provenance gate is killed by missing-provenance test", async () => {
    const source = readFileSync("src/app/api/studio/upload/handler.ts", "utf8");
    const needle = '!provenance || provenance.source_type !== "upload" || provenance.lifecycle_state !== "draft"';
    assert(source.includes(needle));
    const module = { exports: {} as typeof cleanup };
    const compiled = ts.transpileModule(source.replace(needle, "false /* MUTANT */"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("exports", "module", compiled)(module.exports, module);
    const send = (handler: typeof cleanup.handleStudioUploadCleanup) => handler(new Request("https://app.invalid/cleanup", { method: "POST", body: JSON.stringify({ path: `studio/uploads/${h.A.ownerUserId}/cover.jpg` }) }), { getUserId: async () => h.A.ownerUserId, configured: true, findProvenance: async () => null, recordCleanup: async () => {} });
    assert.equal((await send(cleanup.handleStudioUploadCleanup)).status, 400);
    const mutant = await send(module.exports.handleStudioUploadCleanup);
    assert.throws(() => assert.equal(mutant.status, 400));
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
