/**
 * WP-C unit tests for the image-bearing account-sync adapters:
 *   product_library, reference_library, assets, basket.
 * Run: npx tsx scripts/test-user-store-media-adapters.ts   (from web/)
 *
 * For each adapter: getAll shape + the KEY defense line (docs still holding a
 * data:/blob: image are excluded from the sync set), mergeServer LWW (both
 * directions), tombstone merge, capacity-prune-without-tombstone (assets), the
 * basket singleton round-trip + no-restamp-on-merge, and one product_library
 * round-trip through the real engine + a mock /api/user-store server.
 *
 * localStorage + window are shimmed BEFORE the stores are imported.
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
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await sleep(5);
  if (!cond()) throw new Error("condition not met in time");
}
function iso(offsetMs: number): string { return new Date(Date.now() + offsetMs).toISOString(); }

// ── Mock /api/user-store server (scopes rows by storeKey) ──────────────────────
type Row = { docId: string; updatedAt: string; deletedAt?: string; payload: Record<string, unknown> };
function createMockServer(initial: Record<string, Row[]> = {}) {
  const byKey = new Map<string, Map<string, Row>>();
  for (const [k, rows] of Object.entries(initial)) byKey.set(k, new Map(rows.map(r => [r.docId, r])));
  const rowsFor = (k: string) => { let m = byKey.get(k); if (!m) { m = new Map(); byKey.set(k, m); } return m; };
  const log: Array<{ method: string; storeKey: string }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const u = new URL(url, "http://localhost");
    const storeKey = method === "GET" ? (u.searchParams.get("storeKey") ?? "") : (body?.storeKey ?? "");
    log.push({ method, storeKey });
    if (method === "GET") {
      const rows = rowsFor(storeKey);
      const all = [...rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.docId.localeCompare(b.docId));
      return json({ docs: all });
    }
    const rows = rowsFor(storeKey);
    if (method === "PUT") {
      for (const d of body.docs as Array<{ docId: string; updatedAt: string; payload: Record<string, unknown> }>) {
        const ex = rows.get(d.docId);
        if (ex && Date.parse(d.updatedAt) < Date.parse(ex.updatedAt)) continue;
        rows.set(d.docId, { docId: d.docId, updatedAt: d.updatedAt, payload: d.payload });
      }
      return json({ applied: (body.docs as unknown[]).length });
    }
    if (method === "DELETE") {
      for (const id of body.docIds as string[]) {
        const ex = rows.get(id);
        if (ex && Date.parse(ex.updatedAt) > Date.parse(body.deletedAt as string)) continue;
        rows.set(id, { docId: id, updatedAt: body.deletedAt, deletedAt: body.deletedAt, payload: ex?.payload ?? {} });
      }
      return json({ applied: (body.docIds as unknown[]).length });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;

  return {
    log, fetchImpl,
    live: (k: string) => [...rowsFor(k).values()].filter(r => !r.deletedAt),
    row: (k: string, id: string) => rowsFor(k).get(id),
    deleteCalls: (k?: string) => log.filter(l => l.method === "DELETE" && (!k || l.storeKey === k)),
  };
}

const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const FAST = { debounceMs: 5, backoffBaseMs: 15, backoffMaxMs: 60 };
const getToken = async () => "test-token";

async function main() {
  const sync = await import("../src/lib/userStoreSync");
  const lib = await import("../src/lib/productLibraryStore");
  const assets = await import("../src/lib/assetStore");
  const basket = await import("../src/lib/basketStore");

  function reset() {
    sync.__resetUserStoreSyncForTests();
    _ls.clear();
    listenersByType.clear();
    lib.__resetProductLibraryForTests();
    assets.__resetAssetStoreForTests();
    basket.__resetBasketForTests();
  }

  // ── product_library: getAll shape + data-URL exclusion ─────────────────────
  await test("product_library getAll: kind-tagged docs, prefixed ids, excludes data-URL products", () => {
    reset();
    const good = lib.addProduct({ title: "good", imageUrl: "https://cdn/a.png", category: "c", collection: "", tags: [] });
    const bad = lib.addProduct({ title: "bad", imageUrl: DATA_URL, category: "c", collection: "", tags: [] });
    lib.createSet("S", [good.id]);
    const all = lib.productLibrarySyncAdapter.getAll();
    const ids = new Set(all.map(d => d.id));
    assert.ok(ids.has(`product:${good.id}`), "https product syncs");
    assert.ok(!ids.has(`product:${bad.id}`), "data-URL product excluded");
    assert.equal(lib.__getProductLibrarySyncDebug().excludedProducts, 1);
    assert.ok(all.some(d => d.id.startsWith("set:") && (d.doc as { kind: string }).kind === "set"));
    assert.ok(all.some(d => d.id.startsWith("collection:") && (d.doc as { kind: string }).kind === "collection"));
    assert.equal((all.find(d => d.id === `product:${good.id}`)!.doc as { kind: string }).kind, "product");
  });

  // ── product_library: LWW (product + set + collection) ──────────────────────
  await test("product_library mergeServer LWW: newer wins, stale ignored, collection added", () => {
    reset();
    const p = lib.addProduct({ title: "local", imageUrl: "https://cdn/a.png", category: "c", collection: "", tags: [] });
    lib.productLibrarySyncAdapter.mergeServer(
      [{ kind: "product", ...p, title: "server", imageUrl: "https://cdn/b.png", updatedAt: iso(60_000) } as never,
       { kind: "collection", name: "Server Coll" } as never], []);
    assert.equal(lib.getProducts().find(x => x.id === p.id)!.title, "server", "newer server product wins");
    assert.ok(lib.getCollections().includes("Server Coll"), "server collection added");
    // Stale server product ignored.
    lib.productLibrarySyncAdapter.mergeServer([{ kind: "product", ...p, title: "stale", updatedAt: iso(-60_000) } as never], []);
    assert.equal(lib.getProducts().find(x => x.id === p.id)!.title, "server", "stale product must not clobber");
  });

  // ── product_library: tombstone by prefix ───────────────────────────────────
  await test("product_library mergeServer tombstone: product / set / collection by id prefix", () => {
    reset();
    const p = lib.addProduct({ title: "p", imageUrl: "https://cdn/a.png", category: "c", collection: "", tags: [] });
    const s = lib.createSet("S", [p.id]);
    lib.addCollection("Temp");
    lib.productLibrarySyncAdapter.mergeServer([], [
      { id: `product:${p.id}`, deletedAt: iso(60_000) },
      { id: `set:${s.id}`, deletedAt: iso(60_000) },
      { id: `collection:${encodeURIComponent("Temp")}`, deletedAt: iso(60_000) },
    ]);
    assert.equal(lib.getProducts().find(x => x.id === p.id), undefined, "product tombstoned");
    assert.equal(lib.getSets().find(x => x.id === s.id), undefined, "set tombstoned");
    assert.ok(!lib.getCollections().includes("Temp"), "collection tombstoned");
  });

  // ── product_library: engine round-trip never uploads a data-URL doc ────────
  await test("product_library round-trip: https product + set sync; data-URL product does not", async () => {
    reset();
    const good = lib.addProduct({ title: "good", imageUrl: "https://cdn/a.png", category: "c", collection: "", tags: [] });
    const bad = lib.addProduct({ title: "bad", imageUrl: DATA_URL, category: "c", collection: "", tags: [] });
    const srv = createMockServer();
    sync.registerStoreSync(lib.productLibrarySyncAdapter, { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("product_library"));
    await until(() => !!srv.row("product_library", `product:${good.id}`), 3_000);
    assert.ok(srv.row("product_library", `product:${good.id}`), "https product uploaded");
    assert.equal(srv.row("product_library", `product:${bad.id}`), undefined, "data-URL product NOT uploaded");
  });

  // ── reference_library: updatedAt backfill + exclusion + LWW + tombstone ────
  await test("reference_library: updatedAt from savedAt; excludes data-URL; LWW; tombstone", () => {
    reset();
    const ref = lib.saveReference({ imageUrl: "https://cdn/r.png", source: "uploaded" });
    const bad = lib.saveReference({ imageUrl: DATA_URL, source: "uploaded" });
    const all = lib.referenceLibrarySyncAdapter.getAll();
    assert.equal(all.length, 1, "data-URL reference excluded");
    assert.equal(all[0].updatedAt, ref.savedAt, "updatedAt backfilled from savedAt");
    assert.equal(lib.__getProductLibrarySyncDebug().excludedReferences, 1);
    // Newer server ref wins.
    lib.referenceLibrarySyncAdapter.mergeServer([{ ...ref, keyword: "srv", updatedAt: iso(60_000) } as never], []);
    assert.equal(lib.getReferences().find(r => r.id === ref.id)!.keyword, "srv");
    // Newer tombstone removes.
    lib.referenceLibrarySyncAdapter.mergeServer([], [{ id: ref.id, deletedAt: iso(120_000) }]);
    assert.equal(lib.getReferences().find(r => r.id === ref.id), undefined);
    void bad;
  });

  // ── assets: exclusion (data + blob) + LWW + tombstone ──────────────────────
  await test("assets getAll excludes data:/blob: images; LWW + tombstone", () => {
    reset();
    const good = assets.saveAsset({ role: "product", source: "upload", imageUrl: "https://cdn/a.png", title: "g" });
    assets.saveAsset({ role: "product", source: "upload", imageUrl: DATA_URL, title: "d" });
    assets.saveAsset({ role: "product", source: "upload", imageUrl: "blob:x", title: "b" });
    const ids = new Set(assets.assetsSyncAdapter.getAll().map(d => d.id));
    assert.equal(ids.size, 1, "only the https asset syncs");
    assert.ok(ids.has(good.id));
    assert.equal(assets.__getAssetsSyncDebug().excluded, 2);
    // Newer server asset wins.
    assets.assetsSyncAdapter.mergeServer([{ ...good, title: "server", updatedAt: iso(60_000) } as never], []);
    assert.equal(assets.getAssets().find(a => a.id === good.id)!.title, "server");
    // Newer tombstone removes.
    assets.assetsSyncAdapter.mergeServer([], [{ id: good.id, deletedAt: iso(120_000) }]);
    assert.equal(assets.getAssets().find(a => a.id === good.id), undefined);
  });

  // ── assets: capacity prune keeps evicted in the sync set (no tombstone) ────
  await test("assets prune keeps evicted assets in the sync set (no tombstone storm)", () => {
    reset();
    assets.__setMaxAssetsForTests(3);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const a = assets.saveAsset({ role: "product", source: "upload", imageUrl: `https://cdn/${i}.png`, title: `t${i}` });
      seen.add(a.id);
    }
    for (let i = 3; i < 6; i++) {
      assets.saveAsset({ role: "product", source: "upload", imageUrl: `https://cdn/${i}.png`, title: `t${i}` });
    }
    const after = new Set(assets.assetsSyncAdapter.getAll().map(d => d.id));
    assert.equal(after.size, 6, "all 6 assets reported (evicted → shadow, no delete)");
    for (const id of seen) assert.ok(after.has(id), `${id} must not vanish after eviction`);
  });

  await test("assets prune through the engine emits PUTs only, never a DELETE", async () => {
    reset();
    assets.__setMaxAssetsForTests(3);
    const srv = createMockServer();
    sync.registerStoreSync(assets.assetsSyncAdapter, { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("assets"));
    for (let i = 0; i < 6; i++) {
      assets.saveAsset({ role: "product", source: "upload", imageUrl: `https://cdn/${i}.png`, title: `t${i}` });
    }
    await until(() => srv.live("assets").length === 6, 4_000);
    assert.equal(srv.deleteCalls("assets").length, 0, "capacity eviction must never DELETE server-side");
  });

  // ── basket: singleton getAll + exclusion + no-restamp merge ────────────────
  await test("basket getAll: [] when empty; excludes data-URL; single doc otherwise", () => {
    reset();
    assert.deepEqual(basket.basketSyncAdapter.getAll(), [], "empty basket must not sync");
    basket.addProducts([{ id: "p1", title: "P", imageUrl: DATA_URL }]);
    assert.deepEqual(basket.basketSyncAdapter.getAll(), [], "data-URL basket excluded");
    assert.equal(basket.__getBasketSyncDebug().excluded, true);
    basket.addProducts([{ id: "p2", title: "P2", imageUrl: "https://cdn/a.png" }]);
    // Still excluded: p1 (data URL) is present.
    assert.deepEqual(basket.basketSyncAdapter.getAll(), []);
    basket.removeProduct("p1");
    const all = basket.basketSyncAdapter.getAll();
    assert.equal(all.length, 1, "clean basket syncs as one doc");
    assert.equal(all[0].id, "basket");
  });

  await test("basket mergeServer LWW does not re-stamp updatedAt (no ping-pong)", () => {
    reset();
    basket.addProducts([{ id: "p1", title: "P", imageUrl: "https://cdn/a.png" }]);
    const serverUpdatedAt = iso(60_000);
    basket.basketSyncAdapter.mergeServer(
      [{ opportunities: [], products: [{ id: "s1", title: "srv", imageUrl: "https://cdn/s.png" }], references: [], updatedAt: serverUpdatedAt } as never],
      []);
    const b = basket.getBasket();
    assert.equal(b.products[0].id, "s1", "newer server basket wins");
    assert.equal(b.updatedAt, serverUpdatedAt, "merge preserved the server timestamp (no restamp)");
    // Stale server basket ignored.
    basket.basketSyncAdapter.mergeServer(
      [{ opportunities: [], products: [{ id: "old", title: "old", imageUrl: "https://cdn/o.png" }], references: [], updatedAt: iso(-60_000) } as never],
      []);
    assert.equal(basket.getBasket().products[0].id, "s1", "stale basket must not clobber");
  });

  await test("basket round-trip through the engine (local write → server singleton)", async () => {
    reset();
    const srv = createMockServer();
    sync.registerStoreSync(basket.basketSyncAdapter, { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("basket"));
    basket.addProducts([{ id: "p1", title: "P", imageUrl: "https://cdn/a.png" }]);
    await until(() => srv.live("basket").length === 1, 3_000);
    assert.equal((srv.row("basket", "basket")!.payload as { products: unknown[] }).products.length, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
