import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleStudioUploadCleanup } from "../src/app/api/studio/upload/handler";
import { handleStudioUpload } from "../src/app/api/studio/upload/handler";
import { handleVideoUploadPrepare, type VideoUploadHandlerDeps } from "../src/lib/server/media/videoUploadHandler";
import { listVideoRecovery, saveVideoRecovery } from "../src/lib/studio/videoBatchRecovery";
import { createVideoPosterOperationStore } from "../src/lib/server/media/videoPosterOperationStore";

const memory = new Map<string, string>();
let quota = false;
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { if (quota) throw new Error("quota"); memory.set(key, value); },
    removeItem: (key: string) => memory.delete(key),
  },
  window: { dispatchEvent: () => true },
});

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`  OK ${name}`); }
const ownerA = { ownerUserId: "11111111-1111-4111-8111-111111111111", workspaceId: "default" };
const ownerB = { ownerUserId: "22222222-2222-4222-8222-222222222222", workspaceId: "default" };

async function pgliteHelpers() {
  const requireFromBackend = createRequire(resolve(process.cwd(), "../backend/tests/pglite_v37/package.json"));
  const { PGlite } = requireFromBackend("@electric-sql/pglite") as { PGlite: unknown };
  const verifier = readFileSync(resolve(process.cwd(), "../backend/tests/pglite_v37/verify-v77-video-media.mjs"), "utf8");
  const begin = verifier.indexOf("async function bootstrap");
  const end = verifier.indexOf("async function run()");
  const root = resolve(process.cwd(), "..");
  const load = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n?/g, "\n");
  type PGliteDb = { exec(sql: string): Promise<void>; close(): Promise<void> };
  return new Function("PGlite", "load", `${verifier.slice(begin, end)}\nreturn { dbWithV76, prepareBatch, prepareItem, claimItem, finalizeItem };`)(PGlite, load) as {
    dbWithV76(): Promise<PGliteDb>;
    prepareBatch(db: PGliteDb, owner: string, key: string): Promise<{ batchId: string }>;
    prepareItem(db: PGliteDb, owner: string, batchId: string, ordinal: number, key: string): Promise<{ itemId: string; status: string }>;
    claimItem(db: PGliteDb, owner: string, batchId: string, ordinal: number, token: string): Promise<{ status: string }>;
    finalizeItem(db: PGliteDb, owner: string, batchId: string, ordinal: number, token: string): Promise<{ status: string }>;
  };
}

async function main() {
  await test("production prepare handler accepts a fresh transfer attempt while keeping each attempt server-isolated", async () => {
    let batches = 0;
    const item = { ordinal: 0, idempotencyKey: "item_0", filename: "clip.mp4", contentType: "video/mp4", byteSize: 1024, checksumSha256: "a".repeat(64), width: 1080, height: 1920, durationMs: 5000 };
    const deps: VideoUploadHandlerDeps = {
      getUserId: async () => ownerA.ownerUserId, enabled: true, configured: true,
      store: {
        prepareBatch: async () => ({ batchId: `batch_${++batches}` }), prepareItem: async () => ({ status: "prepared" }),
        confirmCapability: async () => ({ status: "prepared", cleanupScheduled: true }),
        findItem: async (_owner, batchId, ordinal) => ({ batchId, ordinal, status: "prepared", privatePath: `${ownerA.ownerUserId}/uploads/${batchId}/${ordinal}.mp4`, declaredContentType: "video/mp4", declaredByteSize: 1024, declaredChecksumSha256: "a".repeat(64), declaredWidth: 1080, declaredHeight: 1920, declaredDurationMs: 5000, expiresAt: "2099-01-01T00:00:00Z" }),
        claimItem: async () => { throw new Error("unused"); }, finalizeItem: async () => { throw new Error("unused"); }, failItem: async () => { throw new Error("unused"); },
      },
      createSignedUpload: async ({ path }) => ({ token: "token", signedUrl: `https://storage.invalid/object/upload/sign/generated-private/${path}?token=token` }),
    };
    const send = async (idempotencyKey: string) => {
      const response = await handleVideoUploadPrepare(new Request("https://app.invalid/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey, files: [item] }) }), deps);
      assert.equal(response.status, 200); return (await response.json() as { batchId: string }).batchId;
    };
    assert.notEqual(await send("attempt_a"), await send("attempt_b"));
  });

  await test("v77 permits a fresh failed-only attempt after a sibling finalizes, without reviving the old item", async () => {
    const runtimeWindow = globalThis.window;
    Reflect.deleteProperty(globalThis, "window");
    const h = await pgliteHelpers(); const db = await h.dbWithV76();
    try {
      await db.exec(readFileSync(resolve(process.cwd(), "../backend/db/migrate_v77_video_media.sql"), "utf8"));
      const first = await h.prepareBatch(db, ownerA.ownerUserId, "logical-a-attempt-1");
      await h.prepareItem(db, ownerA.ownerUserId, first.batchId, 0, "first");
      await h.prepareItem(db, ownerA.ownerUserId, first.batchId, 1, "sibling");
      await h.claimItem(db, ownerA.ownerUserId, first.batchId, 0, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      await h.finalizeItem(db, ownerA.ownerUserId, first.batchId, 0, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      await assert.rejects(() => h.prepareItem(db, ownerA.ownerUserId, first.batchId, 1, "sibling"), /video_upload_batch_not_preparable/);
      const retry = await h.prepareBatch(db, ownerA.ownerUserId, "logical-a-attempt-2");
      const newItem = await h.prepareItem(db, ownerA.ownerUserId, retry.batchId, 1, "sibling");
      assert.equal(newItem.status, "prepared");
      assert.notEqual(retry.batchId, first.batchId);
    } finally { await db.close(); Object.assign(globalThis, { window: runtimeWindow }); }
  });

  await test("recovery receipt survives quota draft failure and remains invisible to another owner", async () => {
    memory.clear(); quota = false;
    const record = { version: 1 as const, logicalId: "logical-1", draftIdempotencyKey: "video:logical-1", owner: ownerA,
      filename: "clip.mp4", title: "clip", inspection: { width: 1080, height: 1920, durationMs: 5000 },
      finalized: { proxyUrl: `/api/storage-media?path=${ownerA.ownerUserId}%2Fclip.mp4`, requestId: "req-a" }, createdAt: "2026-09-16T00:00:00.000Z" };
    assert.equal(saveVideoRecovery(record), true);
    quota = true;
    const store = await import("../src/lib/pinDraftStore"); store.__resetMemoryCacheForTests(); store.setPinDraftOwnerScope(ownerA.ownerUserId);
    store.createBoardDraft({ imageUrl: "", source: "uploaded_image", idempotencyKey: record.draftIdempotencyKey });
    assert.equal(store.hasPersistFailure(), true);
    store.__resetMemoryCacheForTests();
    store.setPinDraftOwnerScope(ownerB.ownerUserId);
    assert.equal(store.getAllDrafts().length, 0, "a scope switch cannot materialize owner A media into B's board");
    assert.equal(listVideoRecovery(ownerA).length, 1, "finalized receipt survives a failed local draft write");
    assert.equal(listVideoRecovery(ownerB).length, 0, "owner B cannot read owner A recovery metadata");
    quota = false;
  });

  await test("poster cleanup handler authenticates, enforces owner prefix, and records only a safe outbox row", async () => {
    const rows: Array<{ owner_user_id: string; bucket_id: string; object_path: string; reason: string }> = [];
    const deps = { configured: true, getUserId: async () => ownerA.ownerUserId, findProvenance: async () => ({ source_type: "upload", lifecycle_state: "draft" }), canCleanupPoster: async () => true, recordCleanup: async (row: typeof rows[number]) => { rows.push(row); } };
    const good = await handleStudioUploadCleanup(new Request("https://app.invalid/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `studio/uploads/${ownerA.ownerUserId}/cover.jpg` }) }), deps);
    assert.equal(good.status, 200); assert.equal(rows.length, 1); assert.equal(rows[0].reason, "unattached_video_poster");
    const foreign = await handleStudioUploadCleanup(new Request("https://app.invalid/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `studio/uploads/${ownerB.ownerUserId}/cover.jpg` }) }), deps);
    assert.equal(foreign.status, 403); assert.equal(rows.length, 1);
    const anonymous = await handleStudioUploadCleanup(new Request("https://app.invalid/cleanup", { method: "POST", body: JSON.stringify({ path: `studio/uploads/${ownerA.ownerUserId}/cover.jpg` }) }), { ...deps, getUserId: async () => null });
    assert.equal(anonymous.status, 401);
  });
  await test("v80 poster cleanup is a service-owned positive authorization, not a browser lifecycle claim", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = { rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: name === "video_poster_cleanup_authorize" ? { allowed: false, reason: "operation_not_terminal" } : { ok: true }, error: null };
    } };
    const operation = createVideoPosterOperationStore(db);
    const input = { ownerUserId: ownerA.ownerUserId, batchId: "11111111-1111-4111-8111-111111111111", ordinal: 0, bucketId: "generated-private", objectPath: `studio/uploads/${ownerA.ownerUserId}/poster.png` };
    await operation.associate(input);
    await operation.retain(input);
    assert.equal(await operation.canCleanup({ ownerUserId: input.ownerUserId, bucketId: input.bucketId, objectPath: input.objectPath }), false);
    assert.deepEqual(calls.map(call => call.name), ["video_poster_operation_associate", "video_poster_operation_retain", "video_poster_cleanup_authorize"]);
    assert(calls.every(call => call.args.p_owner_user_id === ownerA.ownerUserId));
    assert.equal("state" in calls[2].args, false, "the client cannot declare an operation failed/cancelled");
  });
  await test("v80 binds a poster during the server upload transaction and compensates an association failure", async () => {
    const form = new FormData(); form.append("file", new File([new Uint8Array([1])], "poster.png", { type: "image/png" }));
    form.append("videoBatchId", "11111111-1111-4111-8111-111111111111"); form.append("videoOrdinal", "0");
    let associated = 0;
    const okay = await handleStudioUpload(new Request("https://app.invalid/upload", { method: "POST", body: form }), {
      getUserId: async () => ownerA.ownerUserId, configured: true, uploadObject: async () => ({ error: null }), registerProvenance: async () => true,
      associatePosterOperation: async input => { associated++; return input.owner_user_id === ownerA.ownerUserId && input.ordinal === 0; }, removeObject: async () => {},
    });
    assert.equal(okay.status, 201); assert.equal(associated, 1);
    const failed = new FormData(); failed.append("file", new File([new Uint8Array([1])], "poster.png", { type: "image/png" }));
    failed.append("videoBatchId", "11111111-1111-4111-8111-111111111111"); failed.append("videoOrdinal", "0");
    let removed = 0; const reasons: string[] = [];
    const unavailable = await handleStudioUpload(new Request("https://app.invalid/upload", { method: "POST", body: failed }), {
      getUserId: async () => ownerA.ownerUserId, configured: true, uploadObject: async () => ({ error: null }), registerProvenance: async () => true,
      associatePosterOperation: async () => false, removeObject: async () => { removed++; throw new Error("temporary"); }, recordCleanup: async row => { reasons.push(row.reason); },
    });
    assert.equal(unavailable.status, 503); assert.equal(removed, 1); assert.deepEqual(reasons, ["poster_association_failed"]);
  });
  console.log(`\n${passed} video batch runtime checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
