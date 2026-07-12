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
