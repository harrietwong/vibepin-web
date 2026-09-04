/**
 * WP-C unit tests for the media-offload sweep (mediaOffload.ts).
 * Run: npx tsx scripts/test-media-offload.ts   (from web/)
 *
 * Covers: data URL → stable URL replacement with an updatedAt bump; exponential
 * backoff retry on upload failure; blob: handling (fetchable → uploaded, dead →
 * skipped + left local); malformed data URL skipped; idempotent/self-terminating
 * stop; no-token silent wait+retry; and cross-store coverage (product + asset +
 * basket) in a single sweep.
 *
 * localStorage + window are shimmed BEFORE the stores are imported. File/Blob/
 * FormData/atob/Response come from Node 20 globals; fetch is fully mocked.
 */

import assert from "node:assert";
import {
  authorizeStudioStoragePath,
  generationJobImageUrls,
  generationJobImageProxyUrls,
  ownedGenerationJobsContainPath,
} from "../src/lib/server/storagePathAuth";

// ── window + localStorage shim (events routed by type) ─────────────────────────
const _ls = new Map<string, string>();
const listenersByType = new Map<string, Set<() => void>>();
const localStorageShim = {
  getItem: (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem: (k: string, v: string) => { _ls.set(k, String(v)); },
  removeItem: (k: string) => { _ls.delete(k); },
  clear: () => { _ls.clear(); },
};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = localStorageShim;
g.window = {
  localStorage: localStorageShim,
  addEventListener: (t: string, cb: () => void) => {
    let s = listenersByType.get(t);
    if (!s) { s = new Set(); listenersByType.set(t, s); }
    s.add(cb);
  },
  removeEventListener: (t: string, cb: () => void) => { listenersByType.get(t)?.delete(cb); },
  dispatchEvent: (evt: { type: string }) => { listenersByType.get(evt.type)?.forEach(fn => fn()); return true; },
};
(globalThis as unknown as { Event: unknown }).Event = class { type: string; constructor(t: string) { this.type = t; } };

// ── Harness ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// Tiny 1x1 PNG data URL.
const PNG_1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type UploadLog = { url: string; method: string };

/** Build a mock fetch. `failFirst` fails the first N upload POSTs (503) then succeeds. */
function makeFetch(opts: { publicUrl?: string; failFirst?: number; blobBytes?: (url: string) => Uint8Array | null } = {}) {
  const log: UploadLog[] = [];
  let uploadCalls = 0;
  const publicUrl = opts.publicUrl ?? "https://cdn.example.com/generated/studio/uploads/u1/x.png";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    log.push({ url, method });
    if (url.startsWith("blob:")) {
      const bytes = opts.blobBytes ? opts.blobBytes(url) : new Uint8Array([1, 2, 3]);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(new Blob([new Uint8Array(bytes)], { type: "image/png" }), { status: 200 });
    }
    // Upload endpoint.
    uploadCalls++;
    if (opts.failFirst && uploadCalls <= opts.failFirst) {
      return new Response(JSON.stringify({ error: "boom" }), { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true, publicUrl, proxyUrl: "/api/storage-image?path=x" }), { status: 201 });
  }) as typeof fetch;
  return { fetchImpl, log, uploadCount: () => uploadCalls };
}

const FAST = { backoffBaseMs: 3, backoffMaxMs: 12 } as const;
const getToken = async () => "test-token";

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test-placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-placeholder-anon-key";
  const { handleStorageImageGet } = await import("../src/lib/server/storageImageHandler");
  const { handleHistoryStorageGet } = await import("../src/lib/server/historyStorageHandler");
  const mo = await import("../src/lib/mediaOffload");
  const lib = await import("../src/lib/productLibraryStore");
  const assets = await import("../src/lib/assetStore");
  const basket = await import("../src/lib/basketStore");

  function reset() {
    mo.__resetMediaOffloadForTests();
    _ls.clear();
    listenersByType.clear();
    lib.__resetProductLibraryForTests();
    assets.__resetAssetStoreForTests();
    basket.__resetBasketForTests();
  }

  // ── storage path authorization ─────────────────────────────────────────────
  await test("storage scope accepts legacy files and the current user's upload subtree", () => {
    assert.deepStrictEqual(
      authorizeStudioStoragePath("studio/legacy-file.png", "user-1"),
      { ok: true, path: "studio/legacy-file.png", scope: "legacy-job" },
    );
    assert.deepStrictEqual(
      authorizeStudioStoragePath("studio/uploads/user-1/image.png", "user-1"),
      { ok: true, path: "studio/uploads/user-1/image.png", scope: "owned-upload" },
    );
  });

  await test("legacy storage access accepts only exact done outputs from the owner's jobs", () => {
    const rows = [{ results: [
      { status: "done", imageUrl: "https://example.supabase.co/storage/v1/object/public/generated/studio/owned.png" },
      { status: "failed", imageUrl: "https://example.supabase.co/storage/v1/object/public/generated/studio/failed.png" },
      { status: "done", imageUrl: "/api/storage-image?path=studio%2Fproxy.png" },
    ] }];

    assert.deepStrictEqual(generationJobImageUrls(rows[0]), [
      "https://example.supabase.co/storage/v1/object/public/generated/studio/owned.png",
      "/api/storage-image?path=studio%2Fproxy.png",
    ]);
    assert.equal(ownedGenerationJobsContainPath(rows, "studio/owned.png", "https://example.supabase.co"), true);
    assert.equal(ownedGenerationJobsContainPath(rows, "studio/proxy.png", "https://example.supabase.co"), true);
    assert.equal(ownedGenerationJobsContainPath(rows, "studio/failed.png", "https://example.supabase.co"), false);
    assert.equal(ownedGenerationJobsContainPath(rows, "studio/other-user.png", "https://example.supabase.co"), false);
    assert.equal(ownedGenerationJobsContainPath([{ results: "client-value" }], "studio/owned.png", "https://example.supabase.co"), false);
    assert.deepStrictEqual(
      generationJobImageProxyUrls({ results: [
        { status: "done", imageUrl: "/api/storage-image?path=studio%2Fproxy.png" },
        { status: "done", imageUrl: "/api/storage-image?path=studio%2Fproxy.png&extra=1" },
        { status: "done", imageUrl: "https://evil.example/storage/v1/object/public/generated/studio/forged.png" },
      ] }, "user-1", "https://example.supabase.co"),
      ["/api/storage-image?path=studio%2Fproxy.png"],
    );
  });

  await test("storage scope rejects another user's upload subtree", () => {
    assert.deepStrictEqual(
      authorizeStudioStoragePath("studio/uploads/user-2/image.png", "user-1"),
      { ok: false, status: 403 },
    );
  });

  await test("storage scope rejects traversal, encoded, malformed, and non-studio paths", () => {
    for (const path of [
      "../studio/image.png",
      "/studio/image.png",
      "studio/image.png/",
      "studio//image.png",
      "studio\\image.png",
      "studio/%2e%2e/image.png",
      "studio/uploads/user-1",
      "generated/image.png",
      "studio/uploads/user-1/evil\u0000.png",
    ]) {
      assert.deepStrictEqual(
        authorizeStudioStoragePath(path, "user-1"),
        { ok: false, status: 400 },
        path,
      );
    }
  });

  await test("storage-image checks auth and owner before DB or Storage I/O", async () => {
    let dbCalls = 0;
    let storageCalls = 0;
    const baseDeps = {
      loadGenerationResults: async () => { dbCalls++; return { data: [], error: false }; },
      fetchImpl: async () => { storageCalls++; return new Response(); },
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "test-key",
    };

    const unauthenticated = await handleStorageImageGet(
      new Request("https://app.test/api/storage-image?path=studio%2Flegacy.png"),
      { ...baseDeps, getUserId: async () => null },
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal(dbCalls, 0);
    assert.equal(storageCalls, 0);

    const crossOwner = await handleStorageImageGet(
      new Request("https://app.test/api/storage-image?path=studio%2Fuploads%2Fuser-2%2Fimage.png"),
      { ...baseDeps, getUserId: async () => "user-1" },
    );
    assert.equal(crossOwner.status, 403);
    assert.equal(dbCalls, 0);
    assert.equal(storageCalls, 0);
  });

  await test("storage-image legacy access fails closed and successful responses are private/nosniff", async () => {
    let storageCalls = 0;
    const request = new Request("https://app.test/api/storage-image?path=studio%2Fowned.png");
    const shared = {
      getUserId: async () => "user-1",
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "test-key",
      fetchImpl: async () => {
        storageCalls++;
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "3" },
        });
      },
    };

    const unmatched = await handleStorageImageGet(request, {
      ...shared,
      loadGenerationResults: async () => ({ data: [], error: false }),
    });
    assert.equal(unmatched.status, 403);
    assert.equal(storageCalls, 0);

    const dbFailure = await handleStorageImageGet(request, {
      ...shared,
      loadGenerationResults: async () => ({ data: [], error: true }),
    });
    assert.equal(dbFailure.status, 403);
    assert.equal(storageCalls, 0);

    const matched = await handleStorageImageGet(request, {
      ...shared,
      loadGenerationResults: async userId => {
        assert.equal(userId, "user-1");
        return { data: [{ results: [{ status: "done", imageUrl: "/api/storage-image?path=studio%2Fowned.png" }] }], error: false };
      },
    });
    assert.equal(matched.status, 200);
    assert.equal(storageCalls, 1);
    assert.equal(matched.headers.get("cache-control"), "private, max-age=86400, immutable");
    assert.equal(matched.headers.get("vary"), "Authorization, Cookie");
    assert.equal(matched.headers.get("x-content-type-options"), "nosniff");
  });

  await test("storage-image rejects untrusted MIME and oversized streamed bodies", async () => {
    const request = new Request("https://app.test/api/storage-image?path=studio%2Fuploads%2Fuser-1%2Fimage.png");
    const shared = {
      getUserId: async () => "user-1",
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "test-key",
    };
    const html = await handleStorageImageGet(request, {
      ...shared,
      fetchImpl: async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    assert.equal(html.status, 404);

    const empty = await handleStorageImageGet(request, {
      ...shared,
      fetchImpl: async () => new Response(null, { status: 200, headers: { "content-type": "image/png" } }),
    });
    assert.equal(empty.status, 404);

    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.close();
      },
    });
    const oversized = await handleStorageImageGet(request, {
      ...shared,
      fetchImpl: async () => new Response(oversizedStream, { status: 200, headers: { "content-type": "image/png" } }),
    });
    assert.equal(oversized.status, 404);
  });

  await test("history-storage is auth-first, user-scoped, proxy-only, and fail-closed on DB errors", async () => {
    let loadCalls = 0;
    const unauthenticated = await handleHistoryStorageGet(new Request("https://app.test/api/history-storage"), {
      getUserId: async () => null,
      loadGenerationJobs: async () => { loadCalls++; return { data: [], error: false }; },
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(loadCalls, 0);

    const failed = await handleHistoryStorageGet(new Request("https://app.test/api/history-storage"), {
      getUserId: async () => "user-1",
      loadGenerationJobs: async userId => {
        loadCalls++;
        assert.equal(userId, "user-1");
        return { data: [], error: true };
      },
    });
    assert.deepStrictEqual(await failed.json(), { entries: [] });

    const ok = await handleHistoryStorageGet(new Request("https://app.test/api/history-storage"), {
      getUserId: async () => "user-1",
      loadGenerationJobs: async userId => {
        assert.equal(userId, "user-1");
        return {
          error: false,
          data: [{
            id: "job-1",
            created_at: "2026-09-04T00:00:00.000Z",
            status: "done",
            params: { keyword: "lamp", product_images: ["p"] },
            results: [
              { status: "done", imageUrl: "/api/storage-image?path=studio%2Flegacy.png" },
              { status: "done", imageUrl: "https://evil.example/storage/v1/object/public/generated/studio/forged.png" },
            ],
          }],
        };
      },
    });
    const body = await ok.json() as { entries: Array<{ groups: Array<{ images: string[] }> }> };
    assert.deepStrictEqual(body.entries[0].groups[0].images, ["/api/storage-image?path=studio%2Flegacy.png"]);
    assert.equal(loadCalls, 1);
  });

  // ── data URL → stable URL, with updatedAt bump ─────────────────────────────
  await test("sweep replaces a product data URL with a stable URL and bumps updatedAt", async () => {
    reset();
    const p = lib.addProduct({ title: "T", imageUrl: PNG_1x1, category: "c", collection: "", tags: [] });
    const beforeUpdated = lib.getProducts()[0].updatedAt;
    // Held (returned but not synced) while it holds a data URL.
    const heldEntry = lib.productLibrarySyncAdapter.getAll().find(d => d.id === `product:${p.id}`);
    assert.ok(heldEntry && heldEntry.hold === true, "product held while it carries a data URL");
    assert.equal(lib.__getProductLibrarySyncDebug().excludedProducts, 1);

    const srv = makeFetch();
    await mo.startMediaOffloadSweep(getToken, { ...FAST, fetchImpl: srv.fetchImpl });

    const after = lib.getProducts()[0];
    assert.ok(after.imageUrl.startsWith("https://"), "image externalized to https");
    assert.ok(!mo.isLocalMediaUrl(after.imageUrl), "no longer a local URL");
    assert.notEqual(after.updatedAt, beforeUpdated, "updatedAt bumped so the diff re-uploads it");
    // Now included in the sync set.
    assert.ok(lib.productLibrarySyncAdapter.getAll().some(d => d.id === `product:${p.id}`), "now syncs");
    assert.equal(lib.__getProductLibrarySyncDebug().excludedProducts, 0);
  });

  // ── retry with backoff ─────────────────────────────────────────────────────
  await test("sweep retries with backoff on upload failure then succeeds", async () => {
    reset();
    lib.addProduct({ title: "T", imageUrl: PNG_1x1, category: "c", collection: "", tags: [] });
    const srv = makeFetch({ failFirst: 2 });
    await mo.startMediaOffloadSweep(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.ok(srv.uploadCount() >= 3, `expected retries, got ${srv.uploadCount()} upload attempts`);
    assert.ok(lib.getProducts()[0].imageUrl.startsWith("https://"), "eventually externalized");
  });

  // ── blob: handling ─────────────────────────────────────────────────────────
  await test("sweep uploads a fetchable blob: and skips a dead blob: (left local, excluded)", async () => {
    reset();
    const ok = assets.saveAsset({ role: "product", source: "upload", imageUrl: "blob:ok", title: "ok" });
    const dead = assets.saveAsset({ role: "product", source: "upload", imageUrl: "blob:dead", title: "dead" });
    const srv = makeFetch({ blobBytes: (url) => (url === "blob:dead" ? null : new Uint8Array([9, 9, 9])) });
    await mo.startMediaOffloadSweep(getToken, { ...FAST, fetchImpl: srv.fetchImpl });

    const okAsset = assets.getAssets().find(a => a.id === ok.id)!;
    const deadAsset = assets.getAssets().find(a => a.id === dead.id)!;
    assert.ok(okAsset.imageUrl.startsWith("https://"), "fetchable blob externalized");
    assert.equal(deadAsset.imageUrl, "blob:dead", "dead blob left local");
    // Dead blob stays HELD (returned, never dropped/tombstoned); the ok one now syncs.
    const byId = new Map(assets.assetsSyncAdapter.getAll().map(d => [d.id, d]));
    assert.ok(byId.has(ok.id) && !byId.get(ok.id)!.hold, "externalized asset syncs (not held)");
    assert.ok(byId.has(dead.id) && byId.get(dead.id)!.hold === true, "dead-blob asset held (still local), not dropped");
  });

  // ── malformed data URL is skipped permanently ──────────────────────────────
  await test("sweep skips a malformed data URL without infinite retry", async () => {
    reset();
    assets.saveAsset({ role: "product", source: "upload", imageUrl: "data:garbage-not-a-real-data-url", title: "bad" });
    const srv = makeFetch();
    await mo.startMediaOffloadSweep(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.equal(srv.uploadCount(), 0, "malformed data URL never hits the upload endpoint");
    assert.equal(mo.__getMediaOffloadDebug().skipped, 1, "recorded as a permanent skip");
  });

  // ── idempotent / self-terminating ──────────────────────────────────────────
  await test("sweep is idempotent, re-entrant and self-terminating", async () => {
    reset();
    lib.addProduct({ title: "T", imageUrl: PNG_1x1, category: "c", collection: "", tags: [] });
    const srv = makeFetch();
    const a = mo.startMediaOffloadSweep(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    const b = mo.startMediaOffloadSweep(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.strictEqual(a, b, "concurrent start returns the in-flight promise");
    await Promise.all([a, b]);
    assert.equal(mo.__getMediaOffloadDebug().running, false, "stopped when no work remains");
    assert.equal(mo.__getMediaOffloadDebug().pending, 0, "no offloadable images left");
    // A fresh start with nothing to do resolves immediately and does not upload.
    const before = srv.uploadCount();
    await mo.startMediaOffloadSweep(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.equal(srv.uploadCount(), before, "no-op sweep does not re-upload");
  });

  // ── no token → silent wait + retry ─────────────────────────────────────────
  await test("sweep waits silently for a token then externalizes", async () => {
    reset();
    lib.addProduct({ title: "T", imageUrl: PNG_1x1, category: "c", collection: "", tags: [] });
    let calls = 0;
    const lateToken = async () => (++calls >= 3 ? "tok" : null);
    const srv = makeFetch();
    await mo.startMediaOffloadSweep(lateToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.ok(calls >= 3, "kept polling for a token");
    assert.ok(lib.getProducts()[0].imageUrl.startsWith("https://"), "externalized once token arrived");
  });

  // ── cross-store single sweep (product + asset + basket) ────────────────────
  await test("one sweep externalizes product, asset and basket images together", async () => {
    reset();
    lib.addProduct({ title: "P", imageUrl: PNG_1x1, category: "c", collection: "", tags: [] });
    assets.saveAsset({ role: "style_reference", source: "upload", imageUrl: PNG_1x1, title: "A" });
    basket.addProducts([{ id: "b1", title: "B", imageUrl: PNG_1x1 }]);
    const beforeBasketUpdated = basket.getBasket().updatedAt;
    // Basket HELD while it holds a data URL (returned with hold, never dropped).
    const heldBasket = basket.basketSyncAdapter.getAll();
    assert.equal(heldBasket.length, 1, "held basket returned, not dropped");
    assert.equal(heldBasket[0].hold, true, "basket held while it carries a data URL");
    assert.equal(basket.__getBasketSyncDebug().excluded, true);

    const srv = makeFetch();
    await mo.startMediaOffloadSweep(getToken, { ...FAST, fetchImpl: srv.fetchImpl });

    assert.ok(lib.getProducts()[0].imageUrl.startsWith("https://"));
    assert.ok(assets.getAssets()[0].imageUrl.startsWith("https://"));
    const b = basket.getBasket();
    assert.ok(b.products[0].imageUrl.startsWith("https://"), "basket image externalized");
    assert.notEqual(b.updatedAt, beforeBasketUpdated, "basket updatedAt bumped");
    assert.equal(basket.basketSyncAdapter.getAll().length, 1, "basket now syncs");
    assert.equal(srv.uploadCount(), 3, "one upload per image");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
