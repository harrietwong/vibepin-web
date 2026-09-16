import assert from "node:assert/strict";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(64);
const MP4_FTYP = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

function request(url: string, body?: unknown, headers: HeadersInit = {}) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "req_1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}

function descriptor(ordinal = 0, overrides: Record<string, unknown> = {}) {
  return { ordinal, idempotencyKey: `item_${ordinal}`, filename: "clip.mp4", contentType: "video/mp4", byteSize: 12, checksumSha256: SHA, width: 1080, height: 1920, durationMs: 5_000, ...overrides };
}

function preparedItem(overrides: Record<string, unknown> = {}) {
  return { batchId: "11111111-1111-4111-8111-111111111111", ordinal: 0, status: "prepared", privatePath: `${OWNER}/video/a.mp4`, declaredContentType: "video/mp4", declaredByteSize: 12, declaredChecksumSha256: SHA, declaredWidth: 1080, declaredHeight: 1920, declaredDurationMs: 5_000, expiresAt: "2099-01-01T00:00:00.000Z", ...overrides };
}

async function main() {
  const { handleVideoUploadPrepare, handleVideoUploadFinalize } = await import("../src/lib/server/media/videoUploadHandler");
  const { handleStorageMediaGet } = await import("../src/lib/server/media/storageMediaHandler");

  await test("prepare authenticates before parsing, storage, or database side effects", async () => {
    let effects = 0;
    const response = await handleVideoUploadPrepare(new Request("https://app.test/api/studio/video-upload/prepare", { method: "POST", body: "not json" }), {
      getUserId: async () => null, enabled: true, configured: true,
      store: { prepareBatch: async () => { effects++; throw new Error("unexpected"); }, prepareItem: async () => { effects++; throw new Error("unexpected"); }, findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
      createSignedUpload: async () => { effects++; throw new Error("unexpected"); },
    });
    assert.equal(response.status, 401);
    assert.equal(effects, 0);
    assert.deepEqual(await response.json(), { code: "unauthorized", requestId: "" });
  });

  await test("feature and configuration gates deny prepare before database or Storage work", async () => {
    let effects = 0;
    const base = { getUserId: async () => OWNER, store: { prepareBatch: async () => { effects++; return { batchId: "unexpected" }; }, prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} }, createSignedUpload: async () => { effects++; return { token: "unexpected", signedUrl: "https://storage.test/unexpected" }; } };
    const disabled = await handleVideoUploadPrepare(request("https://app.test/prepare", { bad: "body" }), { ...base, enabled: false, configured: true });
    const unconfigured = await handleVideoUploadPrepare(request("https://app.test/prepare", { bad: "body" }), { ...base, enabled: true, configured: false });
    assert.equal(disabled.status, 404);
    assert.equal(unconfigured.status, 503);
    assert.equal(effects, 0);
  });

  await test("prepare bounds the batch and rejects unsafe facts before issuing capabilities", async () => {
    let signed = 0;
    const deps = {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: { prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
      createSignedUpload: async () => { signed++; return { token: "secret-token", signedUrl: "https://storage.test/secret" }; },
    };
    for (const files of [[], Array.from({ length: 21 }, (_, ordinal) => descriptor(ordinal)), [descriptor(0, { contentType: "video/webm" })], [descriptor(0, { byteSize: 104857601 })], [descriptor(0), descriptor(0)]]) {
      const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_1", files }), deps);
      assert.equal(response.status, files.length === 21 ? 413 : 400);
      assert.equal((await response.json() as { code: string }).code, files.length === 21 ? "batch_limit_exceeded" : "invalid_video_upload");
    }
    assert.equal(signed, 0);
  });

  await test("prepare creates owner-scoped paths, uses upsert false, and never puts a token in an error", async () => {
    const calls: unknown[] = [];
    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_1", files: [descriptor()] }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      pathFactory: (owner, batch, ordinal) => `${owner}/videos/${batch}/${ordinal}.mp4`,
      store: {
        prepareBatch: async input => { calls.push(input); return { batchId: "11111111-1111-4111-8111-111111111111" }; },
        prepareItem: async input => { calls.push(input); return { status: "prepared" }; }, findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {},
      },
      createSignedUpload: async input => { calls.push(input); return { token: "signed-token", signedUrl: "https://storage.test/signed" }; },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { uploads: Array<{ token: string; path: string; upsert: boolean }> };
    assert.equal(body.uploads[0].token, "signed-token");
    assert.equal(body.uploads[0].path, `${OWNER}/videos/11111111-1111-4111-8111-111111111111/0.mp4`);
    assert.deepEqual(calls.at(-1), { bucket: "generated-private", path: body.uploads[0].path, contentType: "video/mp4", upsert: false });
  });

  await test("prepare accepts exactly twenty ordered items but refuses unsafe paths and replay conflicts without leaking capabilities", async () => {
    let signed = 0;
    const base = {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: { prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
      createSignedUpload: async () => { signed++; return { token: "capability-token", signedUrl: "https://storage.test/capability" }; },
    };
    const twenty = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_twenty", files: Array.from({ length: 20 }, (_, ordinal) => descriptor(ordinal)) }), base);
    assert.equal(twenty.status, 200);
    assert.equal((await twenty.json() as { uploads: unknown[] }).uploads.length, 20);
    const unsafe = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_unsafe", files: [descriptor()] }), { ...base, pathFactory: () => `${OTHER_OWNER}/escape.mp4` });
    assert.equal(unsafe.status, 503);
    const conflict = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_conflict", files: [descriptor()] }), { ...base, store: { ...base.store, prepareItem: async () => { throw new Error("provider says token=capability-token"); } } });
    assert.equal(conflict.status, 502);
    assert.doesNotMatch(await conflict.text(), /capability-token|provider/i);
  });

  await test("matching prepare replay reuses the server-owned path while conflicting declared facts stay closed", async () => {
    const existing = preparedItem();
    let preparedPath = "";
    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_replay", files: [descriptor()] }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: { prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async input => { preparedPath = input.privatePath; return { status: "prepared" }; }, findItem: async () => existing, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
      createSignedUpload: async () => ({ token: "fresh-capability", signedUrl: "https://storage.test/fresh" }),
      pathFactory: () => `${OWNER}/should-not-be-used.mp4`,
    });
    assert.equal(response.status, 200);
    assert.equal(preparedPath, existing.privatePath);
    assert.equal((await response.json() as { uploads: Array<{ path: string }> }).uploads[0].path, existing.privatePath);
  });

  await test("finalize checks only server-loaded facts, validates ftyp, registers exact video provenance, and is idempotent", async () => {
    let reads = 0;
    let registered: unknown;
    const item = preparedItem();
    const deps = {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
      createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
      storage: {
        stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }),
        readRange: async () => { reads++; return new Response(MP4_FTYP); },
        remove: async () => {},
      },
      registerProvenance: async (input: unknown) => { registered = input; return true; }, recordCleanup: async () => {},
    };
    const success = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
    assert.equal(success.status, 200);
    assert.equal(reads, 1);
    assert.deepEqual(registered, { owner_user_id: OWNER, bucket_id: "generated-private", object_path: item.privatePath, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12, checksum_sha256: SHA, width: 1080, height: 1920, duration_ms: 5_000 });

    const replay = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), { ...deps, store: { ...deps.store, findItem: async () => ({ ...item, status: "finalized" }) } });
    assert.equal(replay.status, 200);
    assert.equal(reads, 1, "successful replay must not re-read Storage");
  });

  await test("finalize fails closed and compensates an invalid object through durable cleanup", async () => {
    let removed = 0;
    let cleanup: unknown;
    const item = preparedItem();
    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
      createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }), readRange: async () => new Response(new Uint8Array([1, 2, 3])), remove: async () => { removed++; throw new Error("storage failure"); } },
      registerProvenance: async () => true, recordCleanup: async input => { cleanup = input; },
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json() as { code: string }).code, "invalid_video_container");
    assert.equal(removed, 1);
    assert.deepEqual(cleanup, { owner_user_id: OWNER, bucket_id: "generated-private", object_path: item.privatePath, reason: "invalid_video_container" });
  });

  await test("finalize rejects missing, empty, mismatched, expired, and cross-owner objects before ready provenance", async () => {
    const item = preparedItem();
    for (const [name, stat, itemOverride, expected] of [
      ["missing", { exists: false }, {}, 404],
      ["empty", { exists: true, contentType: "video/mp4", byteSize: 0, checksumSha256: SHA }, {}, 422],
      ["type", { exists: true, contentType: "video/quicktime", byteSize: 12, checksumSha256: SHA }, {}, 422],
      ["size", { exists: true, contentType: "video/mp4", byteSize: 13, checksumSha256: SHA }, {}, 422],
      ["expired", { exists: true, contentType: "video/mp4", byteSize: 12, checksumSha256: SHA }, { expiresAt: "2000-01-01T00:00:00.000Z" }, 422],
    ] as const) {
      let registered = 0; let reads = 0;
      const result = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
        getUserId: async () => OWNER, enabled: true, configured: true,
        store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => ({ ...item, ...itemOverride }), finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} },
        createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
        storage: { stat: async () => stat, readRange: async () => { reads++; return new Response(MP4_FTYP); }, remove: async () => {} }, registerProvenance: async () => { registered++; return true; },
      });
      assert.equal(result.status, expected, name);
      assert.equal(registered, 0, `${name} must not register ready provenance`);
      if (name !== "expired") assert.equal(reads, 0, `${name} must fail before ftyp`);
    }
    const crossOwner = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
      getUserId: async () => OTHER_OWNER, enabled: true, configured: true,
      store: { prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => null, finalizeItem: async () => ({ status: "finalized" }), failItem: async () => {} }, createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
      storage: { stat: async () => { throw new Error("must not stat"); }, readRange: async () => { throw new Error("must not read"); }, remove: async () => {} }, registerProvenance: async () => true,
    });
    assert.equal(crossOwner.status, 404);
  });

  await test("video proxy enforces exact ready provenance and serves a single bounded range without provider leakage", async () => {
    let fetches = 0;
    const path = `${OWNER}/videos/a.mp4`;
    const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), {
      getUserId: async () => OWNER, configured: true,
      findProvenance: async () => ({ owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 }),
      readRange: async input => { fetches++; assert.deepEqual(input, { bucket: "generated-private", path, start: 4, end: 7 }); return new Response(new Uint8Array([0x66, 0x74, 0x79, 0x70])); },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 4-7/12");
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(response.headers.get("vary"), "Authorization, Range");
    assert.equal(await response.text(), "ftyp");
    assert.equal(fetches, 1);

    const denied = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), {
      getUserId: async () => OTHER_OWNER, configured: true,
      findProvenance: async () => null,
      readRange: async () => { throw new Error("must not read"); },
    });
    assert.equal(denied.status, 403);
  });

  await test("video proxy rejects multi and unsatisfiable ranges and redacts upstream failures", async () => {
    const path = `${OWNER}/videos/a.mp4`;
    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => ({ owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 }), readRange: async () => { throw new Error("https://storage.test/raw?token=secret"); } };
    const multi = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-1,3-4" } }), deps);
    assert.equal(multi.status, 416);
    const failed = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), deps);
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /storage|secret|token/i);
  });

  await test("video proxy supports full, open, and suffix ranges, blocks unsafe lifecycle, and bounds an oversized upstream body", async () => {
    const path = `${OWNER}/videos/a.mp4`;
    const provenance = { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 };
    const calls: Array<{ start: number; end: number }> = [];
    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance, readRange: async ({ start, end }: { start: number; end: number }) => { calls.push({ start, end }); return new Response(new Uint8Array(end - start + 1)); } };
    const full = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), deps);
    assert.equal(full.status, 200);
    const open = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=8-" } }), deps);
    assert.equal(open.status, 206);
    const suffix = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=-3" } }), deps);
    assert.equal(suffix.status, 206);
    assert.deepEqual(calls, [{ start: 0, end: 11 }, { start: 8, end: 11 }, { start: 9, end: 11 }]);
    const lifecycle = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...deps, findProvenance: async () => ({ ...provenance, lifecycle_state: "failed" }) });
    assert.equal(lifecycle.status, 403);
    const unknownLifecycle = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...deps, findProvenance: async () => ({ ...provenance, lifecycle_state: "finalizing" }) });
    assert.equal(unknownLifecycle.status, 403, "only explicitly allowed video lifecycle states may be proxied");
    const bounded = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-3" } }), { ...deps, readRange: async () => new Response(new Uint8Array(9)) });
    await assert.rejects(() => bounded.arrayBuffer(), /range body exceeded/i, "the proxy must not expose bytes beyond the selected range");
  });

  console.log(`\nPrivate video upload: ${passed} passed, 0 failed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
