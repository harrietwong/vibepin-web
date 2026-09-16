import assert from "node:assert/strict";
import Module from "node:module";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(64);
const MP4_FTYP = new Uint8Array([
  0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
  0x69, 0x73, 0x6f, 0x32,
]);

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
  return { ordinal, idempotencyKey: `item_${ordinal}`, filename: "clip.mp4", contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, checksumSha256: SHA, width: 1080, height: 1920, durationMs: 5_000, ...overrides };
}

function preparedItem(overrides: Record<string, unknown> = {}) {
  return { batchId: "11111111-1111-4111-8111-111111111111", ordinal: 0, status: "prepared", privatePath: `${OWNER}/video/a.mp4`, declaredContentType: "video/mp4", declaredByteSize: MP4_FTYP.byteLength, declaredChecksumSha256: SHA, declaredWidth: 1080, declaredHeight: 1920, declaredDurationMs: 5_000, expiresAt: "2099-01-01T00:00:00.000Z", ...overrides };
}

function storeStub(overrides: Record<string, unknown> = {}) {
  const item = preparedItem();
  return {
    prepareBatch: async () => ({ batchId: item.batchId }),
    prepareItem: async () => ({ status: "prepared" }),
    findItem: async () => item,
    claimItem: async (input: { claimToken: string }) => ({ status: "finalizing", claimToken: input.claimToken }),
    finalizeItem: async () => ({ status: "finalized", provenanceReady: true }),
    failItem: async () => ({ status: "failed", cleanupAllowed: true, cleanupScheduled: true }),
    ...overrides,
  };
}

async function main() {
  const { handleVideoUploadPrepare, handleVideoUploadFinalize } = await import("../src/lib/server/media/videoUploadHandler");
  const { createVideoUploadStore } = await import("../src/lib/server/media/videoUploadStore");
  const { createSupabaseVideoStorage } = await import("../src/lib/server/media/supabaseVideoStorage");
  const { handleStorageMediaGet } = await import("../src/lib/server/media/storageMediaHandler");

  await test("production Storage adapter never promotes uploader-controlled SHA metadata", async () => {
    const storage = createSupabaseVideoStorage({ supabaseUrl: "https://storage.invalid", serviceRoleKey: "test-key",
      fetchImpl: async () => new Response(null, { status: 200, headers: { "content-length": "12", "content-type": "video/mp4", "x-amz-meta-sha256": SHA } }) });
    const stat = await storage.stat({ bucket: "generated-private", path: `${OWNER}/video/a.mp4` });
    assert.equal("checksumSha256" in stat, false);
    assert.equal(stat.verifiedChecksumSha256, undefined);
  });

  await test("production store routes claim, atomic finalize, and failure through owner-scoped v77 RPCs", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "video_upload_item_claim") return { data: { status: "finalizing", claimToken: args.p_claim_token }, error: null };
        if (name === "video_upload_item_finalize") return { data: { status: "finalized", provenanceReady: true }, error: null };
        if (name === "video_upload_item_fail") return { data: { status: "failed", cleanupAllowed: true, cleanupScheduled: true }, error: null };
        throw new Error(`unexpected RPC ${name}`);
      },
      from: () => { throw new Error("direct table write is forbidden for lifecycle transitions"); },
    };
    const store = createVideoUploadStore(db);
    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await store.claimItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken, claimExpiresAt: "2099-01-01T00:00:00.000Z" });
    await store.finalizeItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken,
      bucketId: "generated-private", contentType: "video/mp4", byteSize: 12, checksumSha256: null });
    const failed = await store.failItem({ ownerUserId: OWNER, batchId: preparedItem().batchId, ordinal: 0, claimToken, code: "invalid_video_container" });
    assert.deepEqual(calls.map(call => call.name), ["video_upload_item_claim", "video_upload_item_finalize", "video_upload_item_fail"]);
    assert.equal(calls[1].args.p_verified_checksum_sha256, null);
    assert.equal("p_verified_width" in calls[1].args, false);
    assert.equal("p_verified_duration_ms" in calls[1].args, false);
    assert.equal(calls[2].args.p_claim_token, claimToken);
    assert(calls.every(call => call.args.p_owner_user_id === OWNER), "every lifecycle RPC must carry the verified owner");
    assert.equal(failed.cleanupScheduled, true);
  });

  await test("expired or terminal prepare replay never issues another signed capability", async () => {
    const existing = { ...preparedItem(), status: "failed", expiresAt: "2000-01-01T00:00:00.000Z" };
    let signed = 0;
    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_replay", files: [descriptor()] }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: storeStub({ prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async () => ({ status: "failed" }), findItem: async () => existing }),
      createSignedUpload: async () => { signed++; return { token: "must-not-issue", signedUrl: "https://storage.test/must-not-issue" }; },
    });
    assert.equal(response.status, 409);
    assert.equal(signed, 0);
  });

  await test("prepare ledger covers the fixed two-hour signed-upload capability", async () => {
    let expiresAt = "";
    const now = new Date("2030-01-01T00:00:00.000Z");
    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_ttl", files: [descriptor()] }), {
      getUserId: async () => OWNER, enabled: true, configured: true, now: () => now,
      store: storeStub({ prepareBatch: async (input: { expiresAt: string }) => { expiresAt = input.expiresAt; return { batchId: preparedItem().batchId }; }, findItem: async () => null }),
      createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/signed" }),
    });
    assert.equal(response.status, 200);
    assert.equal(expiresAt, "2030-01-01T02:00:00.000Z");
  });

  await test("a losing finalize race cannot delete an object finalized by the winner", async () => {
    const item = preparedItem();
    let statCalls = 0; let removed = 0; let claimed = false;
    const deps = {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: storeStub({
        findItem: async () => item,
        claimItem: async (input: { claimToken: string }) => {
          if (claimed) throw new Error("video_upload_item_claimed");
          claimed = true;
          return { status: "finalizing", claimToken: input.claimToken };
        },
      }),
      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
      storage: { stat: async () => { statCalls++; return { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }; }, readRange: async ({ start, end }: { start: number; end: number }) => new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }), remove: async () => { removed++; } },
      recordCleanup: async () => {},
    };
    const winner = handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
    const loser = handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
    assert.equal((await winner).status, 200);
    assert.equal((await loser).status, 409);
    assert.equal(removed, 0);
    assert.equal(statCalls, 1);
  });

  await test("finalized replay fails closed when atomic provenance is incomplete", async () => {
    const item = { ...preparedItem(), status: "finalized" };
    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: storeStub({ findItem: async () => item, claimItem: async () => { throw new Error("video_upload_provenance_incomplete"); } }),
      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }), storage: { stat: async () => { throw new Error("must not stat"); }, readRange: async () => { throw new Error("must not read"); }, remove: async () => {} },
      recordCleanup: async () => {},
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, "provenance_unavailable");
  });

  await test("prepare authenticates before parsing, storage, or database side effects", async () => {
    let effects = 0;
    const response = await handleVideoUploadPrepare(new Request("https://app.test/api/studio/video-upload/prepare", { method: "POST", body: "not json" }), {
      getUserId: async () => null, enabled: true, configured: true,
      store: storeStub({ prepareBatch: async () => { effects++; throw new Error("unexpected"); }, prepareItem: async () => { effects++; throw new Error("unexpected"); }, findItem: async () => null }),
      createSignedUpload: async () => { effects++; throw new Error("unexpected"); },
    });
    assert.equal(response.status, 401);
    assert.equal(effects, 0);
    assert.deepEqual(await response.json(), { code: "unauthorized", requestId: "" });
  });

  await test("feature and configuration gates deny prepare before database or Storage work", async () => {
    let effects = 0;
    const base = { getUserId: async () => OWNER, store: storeStub({ prepareBatch: async () => { effects++; return { batchId: "unexpected" }; }, findItem: async () => null }), createSignedUpload: async () => { effects++; return { token: "unexpected", signedUrl: "https://storage.test/unexpected" }; } };
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
      store: storeStub({ prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), findItem: async () => null }),
      createSignedUpload: async () => { signed++; return { token: "secret-token", signedUrl: "https://storage.test/secret" }; },
    };
    for (const files of [[], Array.from({ length: 21 }, (_, ordinal) => descriptor(ordinal)), [descriptor(0, { contentType: "video/webm" })],
      [descriptor(0, { byteSize: 104857601 })], [descriptor(0, { durationMs: 3_999 })], [descriptor(0, { durationMs: 300_001 })], [descriptor(0), descriptor(0)]]) {
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
      store: storeStub({
        prepareBatch: async (input: unknown) => { calls.push(input); return { batchId: "11111111-1111-4111-8111-111111111111" }; },
        prepareItem: async (input: unknown) => { calls.push(input); return { status: "prepared" }; }, findItem: async () => null,
      }),
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
      store: storeStub({ prepareBatch: async () => ({ batchId: "11111111-1111-4111-8111-111111111111" }), findItem: async () => null }),
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
      store: storeStub({ prepareBatch: async () => ({ batchId: existing.batchId }), prepareItem: async (input: { privatePath: string }) => { preparedPath = input.privatePath; return { status: "prepared" }; }, findItem: async () => existing }),
      createSignedUpload: async () => ({ token: "fresh-capability", signedUrl: "https://storage.test/fresh" }),
      pathFactory: () => `${OWNER}/should-not-be-used.mp4`,
    });
    assert.equal(response.status, 200);
    assert.equal(preparedPath, existing.privatePath);
    assert.equal((await response.json() as { uploads: Array<{ path: string }> }).uploads[0].path, existing.privatePath);
  });

  await test("prepare maps stable idempotency conflicts without provider leakage", async () => {
    const response = await handleVideoUploadPrepare(request("https://app.test/prepare", { idempotencyKey: "batch_conflict", files: [descriptor()] }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: storeStub({ findItem: async () => null, prepareItem: async () => { throw new Error("video_upload_item_idempotency_conflict"); } }),
      createSignedUpload: async () => { throw new Error("must not sign"); },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: "video_upload_conflict", requestId: "req_1" });
  });

  await test("finalize owns an atomic claim before any Storage read", async () => {
    const item = preparedItem();
    let claims = 0;
    const deps = {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: {
        prepareBatch: async () => ({ batchId: item.batchId }), prepareItem: async () => ({ status: "prepared" }), findItem: async () => item,
        claimItem: async (input: { claimToken: string }) => { claims++; return { status: "finalizing", claimToken: input.claimToken }; },
        finalizeItem: async () => ({ status: "finalized", provenanceReady: true }), failItem: async () => ({ status: "failed", cleanupAllowed: true, cleanupScheduled: true }),
      },
      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
      storage: {
        stat: async () => { assert.equal(claims, 1); return { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }; },
        readRange: async ({ start, end }: { start: number; end: number }) => new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }), remove: async () => {},
      },
      recordCleanup: async () => {},
    };
    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
    assert.equal(response.status, 200);
    assert.equal(claims, 1);
  });

  await test("finalize passes only server-verified facts to atomic settlement and complete replay skips Storage", async () => {
    let reads = 0;
    let finalizedInput: Record<string, unknown> = {};
    let replay = false;
    const item = preparedItem();
    const deps = {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: storeStub({
        findItem: async () => ({ ...item, status: replay ? "finalized" : "prepared" }),
        claimItem: async (input: { claimToken: string }) => replay
          ? { status: "finalized", claimToken: null, provenanceReady: true }
          : { status: "finalizing", claimToken: input.claimToken },
        finalizeItem: async (input: Record<string, unknown>) => { finalizedInput = input; return { status: "finalized", provenanceReady: true }; },
      }),
      createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
      storage: {
        stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength }),
        readRange: async ({ start, end }: { start: number; end: number }) => { reads++; return new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }); },
        remove: async () => {},
      },
      recordCleanup: async () => {},
    };
    const success = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
    assert.equal(success.status, 200);
    assert.equal(reads, 1);
    assert.equal(finalizedInput?.checksumSha256, null, "a browser declaration must not become a verified checksum");
    assert.equal("width" in (finalizedInput ?? {}), false);
    assert.equal("height" in (finalizedInput ?? {}), false);
    assert.equal("durationMs" in (finalizedInput ?? {}), false);

    replay = true;
    const replayResponse = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), deps);
    assert.equal(replayResponse.status, 200);
    assert.equal(reads, 1, "successful replay must not re-read Storage");
  });

  await test("finalize fails closed and compensates an invalid object through durable cleanup", async () => {
    let removed = 0;
    let cleanup: unknown;
    const item = preparedItem();
    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: storeStub({ findItem: async () => item }),
      createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }), readRange: async ({ start, end }) => new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }), remove: async () => { removed++; throw new Error("storage failure"); } },
      recordCleanup: async input => { cleanup = input; },
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json() as { code: string }).code, "invalid_video_container");
    assert.equal(removed, 1);
    assert.equal(cleanup, undefined, "the atomic fail RPC owns durable delayed cleanup before best-effort delete");
  });

  await test("finalize never deletes unless the atomic fail transition confirms durable cleanup", async () => {
    let removed = 0;
    const item = preparedItem();
    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: storeStub({ findItem: async () => item, failItem: async () => ({ status: "failed", cleanupAllowed: true, cleanupScheduled: false }) }),
      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength }), readRange: async () => new Response(new Uint8Array(3)), remove: async () => { removed++; } },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, "cleanup_not_scheduled");
    assert.equal(removed, 0);
  });

  await test("cleanup scheduling failure cannot be hidden by a delete attempt", async () => {
    let removed = 0;
    const item = preparedItem();
    const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
      getUserId: async () => OWNER, enabled: true, configured: true,
      store: storeStub({ findItem: async () => item, failItem: async () => { throw new Error("video_upload_store_error"); } }),
      createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
      storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength }), readRange: async () => new Response(new Uint8Array(3)), remove: async () => { removed++; } },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, "video_upload_unavailable");
    assert.equal(removed, 0, "an unscheduled cleanup must never become a destructive best-effort delete");
  });

  await test("finalize rejects missing, empty, mismatched, expired, and cross-owner objects before ready provenance", async () => {
    const item = preparedItem();
    for (const [name, stat, itemOverride, expected] of [
      ["missing", { exists: false }, {}, 404],
      ["empty", { exists: true, contentType: "video/mp4", byteSize: 0, verifiedChecksumSha256: SHA }, {}, 422],
      ["type", { exists: true, contentType: "video/quicktime", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }, {}, 422],
      ["size", { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength + 1, verifiedChecksumSha256: SHA }, {}, 422],
      ["expired", { exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength, verifiedChecksumSha256: SHA }, { expiresAt: "2000-01-01T00:00:00.000Z" }, 422],
    ] as const) {
      let finalized = 0; let reads = 0;
      const result = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
        getUserId: async () => OWNER, enabled: true, configured: true,
        store: storeStub({ findItem: async () => ({ ...item, ...itemOverride }), finalizeItem: async () => { finalized++; return { status: "finalized", provenanceReady: true }; } }),
        createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
        storage: { stat: async () => stat, readRange: async ({ start, end }) => { reads++; return new Response(MP4_FTYP.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } }); }, remove: async () => {} },
      });
      assert.equal(result.status, expected, name);
      assert.equal(finalized, 0, `${name} must not atomically register ready provenance`);
      if (name !== "expired") assert.equal(reads, 0, `${name} must fail before ftyp`);
    }
    const crossOwner = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
      getUserId: async () => OTHER_OWNER, enabled: true, configured: true,
      store: storeStub({ findItem: async () => null }), createSignedUpload: async () => ({ token: "token", signedUrl: "https://storage.test/token" }),
      storage: { stat: async () => { throw new Error("must not stat"); }, readRange: async () => { throw new Error("must not read"); }, remove: async () => {} },
    });
    assert.equal(crossOwner.status, 404);
  });

  await test("finalize validates the real initial range and a complete allowed ftyp box", async () => {
    const item = preparedItem();
    const cases: Array<[string, () => Response]> = [
      ["upstream 500", () => new Response(MP4_FTYP, { status: 500 })],
      ["wrong range", () => new Response(MP4_FTYP, { status: 206, headers: { "content-range": `bytes 1-${MP4_FTYP.byteLength}/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } })],
      ["truncated box", () => new Response(MP4_FTYP.slice(0, 15), { status: 206, headers: { "content-range": `bytes 0-14/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } })],
      ["fake magic", () => new Response(new Uint8Array([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...new Uint8Array(8)]), { status: 206, headers: { "content-range": `bytes 0-19/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } })],
      ["disallowed brand", () => new Response(new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x62, 0x61, 0x64, 0x21, 0, 0, 0, 0, 0x62, 0x61, 0x64, 0x21]), { status: 206, headers: { "content-range": `bytes 0-19/${MP4_FTYP.byteLength}`, "content-type": "video/mp4" } })],
    ];
    for (const [name, responseFactory] of cases) {
      let finalized = 0;
      const response = await handleVideoUploadFinalize(request("https://app.test/finalize", { batchId: item.batchId, ordinal: 0 }), {
        getUserId: async () => OWNER, enabled: true, configured: true,
        store: storeStub({ findItem: async () => item, finalizeItem: async () => { finalized++; return { status: "finalized", provenanceReady: true }; } }),
        createSignedUpload: async () => ({ token: "unused", signedUrl: "https://storage.test/unused" }),
        storage: { stat: async () => ({ exists: true, contentType: "video/mp4", byteSize: MP4_FTYP.byteLength }), readRange: async () => responseFactory(), remove: async () => {} },
      });
      assert.equal(response.status, name === "upstream 500" || name === "wrong range" || name === "truncated box" ? 503 : 422, name);
      assert.equal(finalized, 0, `${name} must not finalize`);
    }
  });

  await test("video proxy enforces exact ready provenance and serves a single bounded range without provider leakage", async () => {
    let fetches = 0;
    const path = `${OWNER}/videos/a.mp4`;
    const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), {
      getUserId: async () => OWNER, configured: true,
      findProvenance: async () => ({ owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 }),
      readRange: async input => { fetches++; assert.deepEqual(input, { bucket: "generated-private", path, start: 4, end: 7 }); return new Response(new Uint8Array([0x66, 0x74, 0x79, 0x70]), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "video/mp4" } }); },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 4-7/12");
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(response.headers.get("vary"), "Cookie, Authorization, Range");
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
    const deps = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance, readRange: async ({ start, end }: { start: number; end: number }) => { calls.push({ start, end }); return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/12`, "content-type": "video/mp4" } }); } };
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
    const bounded = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=0-3" } }), { ...deps, readRange: async () => new Response(new Uint8Array(9), { status: 206, headers: { "content-range": "bytes 0-3/12", "content-type": "video/mp4" } }) });
    await assert.rejects(() => bounded.arrayBuffer(), /range body exceeded/i, "the proxy must not expose bytes beyond the selected range");
  });

  await test("video proxy rejects upstream status, MIME, range, total, and short-body lies", async () => {
    const path = `${OWNER}/videos/a.mp4`;
    const provenance = { owner_user_id: OWNER, bucket_id: "generated-private", object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: "video/mp4", byte_size: 12 };
    const base = { getUserId: async () => OWNER, configured: true, findProvenance: async () => provenance };
    for (const [name, upstream] of [
      ["status", new Response(new Uint8Array(4), { status: 200, headers: { "content-type": "video/mp4" } })],
      ["mime", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "text/plain" } })],
      ["range", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 0-3/12", "content-type": "video/mp4" } })],
      ["total", new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 4-7/99", "content-type": "video/mp4" } })],
    ] as const) {
      const response = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), { ...base, readRange: async () => upstream });
      assert.equal(response.status, 502, name);
    }
    const short = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`, { headers: { range: "bytes=4-7" } }), { ...base,
      readRange: async () => new Response(new Uint8Array(3), { status: 206, headers: { "content-range": "bytes 4-7/12", "content-type": "video/mp4" } }) });
    assert.equal(short.status, 206);
    await assert.rejects(() => short.arrayBuffer(), /range body incomplete/i);

    const full200 = await handleStorageMediaGet(new Request(`https://app.test/api/storage-media?path=${encodeURIComponent(path)}`), { ...base,
      readRange: async () => new Response(new Uint8Array(12), { status: 200, headers: { "content-length": "12", "content-type": "video/mp4" } }) });
    assert.equal(full200.status, 200, "an exact full-object 200 is allowed only for a no-Range request");
  });

  await test("production storage-media route wires verified bearer-or-cookie auth", async () => {
    let captured: Record<string, unknown> | null = null;
    const verified = async () => OWNER;
    const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function(this: unknown, request: string, parent: unknown, isMain: boolean) {
      if (request.includes("server/authUser")) return { getUserIdFromBearer: async () => null, getUserIdFromBearerOrCookies: verified };
      if (request.includes("media/storageMediaHandler")) return { handleStorageMediaGet: async (_req: Request, deps: Record<string, unknown>) => { captured = deps; return new Response("wired"); } };
      if (request.includes("server/mediaProvenance")) return { createMediaProvenanceStore: () => ({ findExact: async () => null }) };
      if (request.includes("media/supabaseVideoStorage")) return { createSupabaseVideoStorage: () => ({ readRange: async () => new Response() }) };
      if (request.includes("media/videoUploadHandler")) return { VIDEO_UPLOAD_BUCKET: "generated-private" };
      return originalLoad.call(this, request, parent, isMain);
    } as never;
    try {
      const route = await import("../src/app/api/storage-media/route");
      const response = await route.GET(new Request("https://app.test/api/storage-media?path=x"));
      assert.equal(await response.text(), "wired");
      assert.equal((captured as Record<string, unknown> | null)?.["getUserId"], verified);
    } finally {
      (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
    }
  });

  await test("production browser client preserves private bucket, token, path, and upsert=false", async () => {
    const calls: unknown[] = [];
    const fakeClient = {
      auth: { getSession: async () => ({ data: { session: { access_token: "access-token" } } }) },
      storage: { from: (bucket: string) => ({ uploadToSignedUrl: async (path: string, token: string, file: File, options: unknown) => {
        calls.push({ bucket, path, token, file, options }); return { error: null };
      } }) },
    };
    const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function(this: unknown, request: string, parent: unknown, isMain: boolean) {
      if (request === "@supabase/ssr") return { createBrowserClient: () => fakeClient };
      return originalLoad.call(this, request, parent, isMain);
    } as never;
    try {
      const { uploadVideoToSignedStorage } = await import("../src/lib/studio/videoDirectUpload");
      const file = new File([MP4_FTYP], "clip.mp4", { type: "video/mp4" });
      await uploadVideoToSignedStorage({ ordinal: 0, path: `${OWNER}/videos/a.mp4`, token: "signed-token", signedUrl: "https://storage.test/signed", contentType: "video/mp4", upsert: false }, file);
      assert.deepEqual(calls, [{ bucket: "generated-private", path: `${OWNER}/videos/a.mp4`, token: "signed-token", file, options: { contentType: "video/mp4", upsert: false } }]);
    } finally {
      (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
    }
  });

  await test("browser SHA-256 is incremental and does not allocate the entire video", async () => {
    const { sha256 } = await import("../src/lib/studio/videoDirectUpload");
    const source = new Blob([new TextEncoder().encode("abc")]);
    Object.defineProperty(source, "arrayBuffer", { value: () => { throw new Error("whole-file allocation forbidden"); } });
    assert.equal(await sha256(source), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  console.log(`\nPrivate video upload: ${passed} passed, 0 failed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
