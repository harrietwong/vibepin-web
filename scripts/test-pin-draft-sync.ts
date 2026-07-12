/**
 * WP0 unit tests for the Pin Draft server-persistence write-through engine.
 * Run: npx tsx scripts/test-pin-draft-sync.ts   (from web/)
 *
 * Covers: diff/outbox, LWW merge (local newer / server newer / equal), tombstone
 * convergence (both directions), first-load migration, cursor-paginated pull,
 * >50 batch chunking, backoff retry queue (never drops the outbox), 202 deferred
 * degradation, the 200KB payload guard, and idempotent init.
 */

import assert from "node:assert";

// ── window + localStorage shim (same pattern as test-pin-board-store.ts) ───────
const mem = new Map<string, string>();
const listeners = new Set<() => void>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (_t: string, cb: () => void) => { listeners.add(cb); },
  removeEventListener: (_t: string, cb: () => void) => { listeners.delete(cb); },
  dispatchEvent: () => { listeners.forEach(fn => fn()); return true; },
};

// ── Tiny harness ───────────────────────────────────────────────────────────────
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

// ── Mock /api/pin-drafts server ────────────────────────────────────────────────
type Row = { draftId: string; updatedAt: string; deletedAt?: string; payload: Record<string, unknown> };

function createMockServer(initial: Row[] = []) {
  const rows = new Map<string, Row>(initial.map(r => [r.draftId, r]));
  const log: Array<{ method: string; url: string; body?: { drafts?: Array<{ draftId: string }>; draftIds?: string[]; deletedAt?: string } }> = [];
  let failCount = 0;
  let deferWrites = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    log.push({ method, url, body });
    if (failCount > 0) { failCount--; return json({ error: "boom", code: "database_unavailable" }, 503); }
    if (method === "GET") {
      const u = new URL(url, "http://localhost");
      const limit = parseInt(u.searchParams.get("limit") ?? "100", 10);
      const offset = parseInt(u.searchParams.get("cursor") ?? "0", 10) || 0;
      const all = [...rows.values()].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.draftId.localeCompare(b.draftId),
      );
      const page = all.slice(offset, offset + limit);
      const next = offset + limit < all.length ? String(offset + limit) : undefined;
      return json({ drafts: page, ...(next ? { nextCursor: next } : {}) });
    }
    if (deferWrites) return json({ deferred: true }, 202);
    if (method === "PUT") {
      let applied = 0, skippedStale = 0;
      for (const d of body.drafts as Array<{ draftId: string; updatedAt: string; payload: Record<string, unknown> }>) {
        const ex = rows.get(d.draftId);
        if (ex && Date.parse(d.updatedAt) < Date.parse(ex.updatedAt)) { skippedStale++; continue; }
        rows.set(d.draftId, { draftId: d.draftId, updatedAt: d.updatedAt, payload: d.payload });
        applied++;
      }
      return json({ applied, skippedStale });
    }
    if (method === "DELETE") {
      let applied = 0;
      for (const id of body.draftIds as string[]) {
        const ex = rows.get(id);
        if (ex && Date.parse(ex.updatedAt) > Date.parse(body.deletedAt as string)) continue;
        rows.set(id, { draftId: id, updatedAt: body.deletedAt, deletedAt: body.deletedAt, payload: ex?.payload ?? {} });
        applied++;
      }
      return json({ applied });
    }
    return json({ error: "not found", code: "not_found" }, 404);
  }) as typeof fetch;

  return {
    rows, log, fetchImpl,
    failNext: (n: number) => { failCount = n; },
    defer: (on: boolean) => { deferWrites = on; },
    live: () => [...rows.values()].filter(r => !r.deletedAt),
    putCalls: () => log.filter(l => l.method === "PUT"),
    deleteCalls: () => log.filter(l => l.method === "DELETE"),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const store = await import("../src/lib/pinDraftStore");
  const sync = await import("../src/lib/pinDraftSync");

  const FAST = { debounceMs: 5, backoffBaseMs: 15, backoffMaxMs: 60, pageSize: 100 };
  const getToken = async () => "test-token";

  function reset() {
    sync.__resetPinDraftSyncForTests();
    mem.clear();
    store.__resetMemoryCacheForTests();
  }

  function serverDraft(id: string, updatedAt: string, patch?: Record<string, unknown>): Row {
    const payload = {
      id, imageUrl: `https://x/${id}.png`, keyword: "", category: "",
      title: `srv-${id}`, description: "d", altText: "a", destinationUrl: "",
      boardId: "", boardName: "", weeklyPlanItemId: "", generationSessionId: "",
      scheduledDate: "", status: "needs_review",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt,
      source: "uploaded_image",
      ...patch,
    };
    return { draftId: id, updatedAt, payload };
  }

  // ── mergeServerDrafts (LWW 三态 + tombstone) ────────────────────────────────

  await test("merge LWW: server strictly newer overwrites local", () => {
    reset();
    const d = store.createBoardDraft({ imageUrl: "https://x/m1.png", source: "uploaded_image", title: "local" });
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = store.mergeServerDrafts(
      [serverDraft(d.id, future, { title: "from-server" }).payload as never], [],
    );
    assert.equal(res.applied, 1);
    assert.equal(store.getDraft(d.id)!.title, "from-server");
    assert.equal(store.getDraft(d.id)!.updatedAt, future);
  });

  await test("merge LWW: local newer kept unchanged", () => {
    reset();
    const d = store.createBoardDraft({ imageUrl: "https://x/m2.png", source: "uploaded_image", title: "local" });
    const res = store.mergeServerDrafts(
      [serverDraft(d.id, "2000-01-01T00:00:00.000Z", { title: "stale-server" }).payload as never], [],
    );
    assert.equal(res.applied, 0);
    assert.equal(store.getDraft(d.id)!.title, "local");
  });

  await test("merge LWW: equal timestamps → no-op (local kept)", () => {
    reset();
    const d = store.createBoardDraft({ imageUrl: "https://x/m3.png", source: "uploaded_image", title: "local" });
    const same = store.getDraft(d.id)!.updatedAt;
    const res = store.mergeServerDrafts(
      [serverDraft(d.id, same, { title: "equal-server" }).payload as never], [],
    );
    assert.equal(res.applied, 0);
    assert.equal(store.getDraft(d.id)!.title, "local");
  });

  await test("merge: unknown server draft is inserted", () => {
    reset();
    const res = store.mergeServerDrafts([serverDraft("pd_new_1", "2026-06-01T00:00:00.000Z").payload as never], []);
    assert.equal(res.applied, 1);
    assert.equal(store.getDraft("pd_new_1")!.title, "srv-pd_new_1");
  });

  await test("merge tombstone: removes older local, keeps newer local", () => {
    reset();
    const dead = store.createBoardDraft({ imageUrl: "https://x/t1.png", source: "uploaded_image" });
    const alive = store.createBoardDraft({ imageUrl: "https://x/t2.png", source: "uploaded_image" });
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = "2000-01-01T00:00:00.000Z";
    const res = store.mergeServerDrafts([], [
      { id: dead.id, deletedAt: future },   // newer delete → local removed
      { id: alive.id, deletedAt: past },    // stale delete → local survives
      { id: "pd_ghost", deletedAt: future }, // unknown id → no-op
    ]);
    assert.equal(res.removed, 1);
    assert.equal(store.getDraft(dead.id), null);
    assert.ok(store.getDraft(alive.id), "newer local edit must survive a stale tombstone");
  });

  // ── Startup pull (pagination) + first-load migration ────────────────────────

  await test("startup pull: paginates all pages into the local store", async () => {
    reset();
    const rows: Row[] = [];
    for (let i = 0; i < 25; i++) rows.push(serverDraft(`pd_srv_${String(i).padStart(2, "0")}`, `2026-05-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`));
    const srv = createMockServer(rows);
    sync.initPinDraftSync(getToken, { ...FAST, pageSize: 10, fetchImpl: srv.fetchImpl });
    assert.ok(await sync.__waitForPinDraftSyncReady(), "pull must complete");
    assert.equal(store.getAllDrafts().length, 25);
    const gets = srv.log.filter(l => l.method === "GET");
    assert.ok(gets.length >= 3, `expected >=3 GET pages, saw ${gets.length}`);
  });

  await test("first-load migration: local-only drafts are uploaded", async () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/u1.png", source: "uploaded_image", title: "A" });
    const b = store.createBoardDraft({ imageUrl: "https://x/u2.png", source: "uploaded_image", title: "B" });
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 2);
    const ids = srv.live().map(r => r.draftId).sort();
    assert.deepEqual(ids, [a.id, b.id].sort());
    assert.equal(sync.__getPinDraftSyncDebug().outboxSize, 0, "outbox drained after ack");
  });

  await test("diff/outbox: only the changed draft is PUT after an edit", async () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/d1.png", source: "uploaded_image", title: "A" });
    store.createBoardDraft({ imageUrl: "https://x/d2.png", source: "uploaded_image", title: "B" });
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 2);
    const putsBefore = srv.putCalls().length;

    store.updateDraft(a.id, { title: "A-edited" });
    await until(() => (srv.rows.get(a.id)?.payload as { title?: string })?.title === "A-edited");
    const newPuts = srv.putCalls().slice(putsBefore);
    assert.equal(newPuts.length, 1, "one incremental PUT");
    assert.deepEqual(newPuts[0].body!.drafts!.map(d => d.draftId), [a.id], "only the edited draft is sent");
  });

  await test("tombstone push: local delete → server DELETE tombstone", async () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/del1.png", source: "uploaded_image" });
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 1);

    store.deleteDraft(a.id);
    await until(() => !!srv.rows.get(a.id)?.deletedAt);
    assert.equal(srv.deleteCalls().length, 1);
    assert.deepEqual(srv.deleteCalls()[0].body!.draftIds, [a.id]);
    assert.equal(sync.__getPinDraftSyncDebug().outboxSize, 0);
  });

  await test("tombstone convergence at startup: newer server tombstone removes local; newer local revives server", async () => {
    reset();
    const dead = store.createBoardDraft({ imageUrl: "https://x/tc1.png", source: "uploaded_image" });
    const alive = store.createBoardDraft({ imageUrl: "https://x/tc2.png", source: "uploaded_image" });
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = "2000-01-01T00:00:00.000Z";
    const srv = createMockServer([
      { draftId: dead.id, updatedAt: future, deletedAt: future, payload: {} },
      { draftId: alive.id, updatedAt: past, deletedAt: past, payload: {} },
    ]);
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.ok(await sync.__waitForPinDraftSyncReady());
    assert.equal(store.getDraft(dead.id), null, "newer server tombstone wins locally");
    assert.ok(store.getDraft(alive.id), "newer local draft survives stale tombstone");
    await until(() => !srv.rows.get(alive.id)?.deletedAt, 3_000); // re-uploaded → revived
  });

  await test("server LWW: skippedStale response still drains the outbox", async () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/lww.png", source: "uploaded_image", title: "A" });
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 1);

    // Poke the server row into the future (another device wrote a newer version).
    const future = new Date(Date.now() + 120_000).toISOString();
    srv.rows.set(a.id, serverDraft(a.id, future, { title: "newer-elsewhere" }));

    store.updateDraft(a.id, { title: "stale-local-edit" });
    await until(() => sync.__getPinDraftSyncDebug().outboxSize === 0, 3_000);
    assert.equal((srv.rows.get(a.id)!.payload as { title?: string }).title, "newer-elsewhere", "server keeps the newer copy");
  });

  await test("batching: 120 drafts are flushed in ≤50-draft PUT chunks", async () => {
    reset();
    for (let i = 0; i < 120; i++) {
      store.createBoardDraft({ imageUrl: `https://x/b${i}.png`, source: "uploaded_image", title: `t${i}` });
    }
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 120, 5_000);
    const puts = srv.putCalls();
    assert.equal(puts.length, 3, `expected 3 PUT chunks, saw ${puts.length}`);
    for (const p of puts) assert.ok(p.body!.drafts!.length <= 50, "each chunk ≤50");
    assert.equal(puts.reduce((n, p) => n + p.body!.drafts!.length, 0), 120);
  });

  await test("backoff retry: failed flush keeps the outbox and retries until success", async () => {
    reset();
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.ok(await sync.__waitForPinDraftSyncReady());

    srv.failNext(2); // next two requests 503
    const a = store.createBoardDraft({ imageUrl: "https://x/r1.png", source: "uploaded_image" });
    await until(() => sync.__getPinDraftSyncDebug().failureCount >= 1, 3_000);
    assert.ok(sync.__getPinDraftSyncDebug().outboxSize >= 1, "outbox must be retained on failure");
    await until(() => srv.live().some(r => r.draftId === a.id), 5_000); // backoff retry lands it
    assert.equal(sync.__getPinDraftSyncDebug().outboxSize, 0);
    assert.equal(sync.__getPinDraftSyncDebug().failureCount, 0, "failure counter resets on success");
  });

  await test("202 deferred (table not applied): outbox retained, retried after recovery", async () => {
    reset();
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.ok(await sync.__waitForPinDraftSyncReady());

    srv.defer(true);
    const a = store.createBoardDraft({ imageUrl: "https://x/def1.png", source: "uploaded_image" });
    await until(() => srv.putCalls().length >= 1, 3_000);
    await sleep(30);
    assert.equal(srv.live().length, 0);
    assert.ok(sync.__getPinDraftSyncDebug().outboxSize >= 1, "202 must not drop the outbox");
    srv.defer(false);
    await until(() => srv.live().some(r => r.draftId === a.id), 5_000);
    assert.equal(sync.__getPinDraftSyncDebug().outboxSize, 0);
  });

  await test("200KB guard: oversized draft is skipped, the rest keeps syncing", async () => {
    reset();
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    assert.ok(await sync.__waitForPinDraftSyncReady());

    const big = store.createBoardDraft({
      imageUrl: "https://x/big.png", source: "uploaded_image",
      description: "x".repeat(210 * 1024),
    });
    const small = store.createBoardDraft({ imageUrl: "https://x/small.png", source: "uploaded_image" });
    await until(() => srv.live().some(r => r.draftId === small.id), 3_000);
    assert.ok(!srv.rows.has(big.id), "oversized draft never sent");
    assert.equal(sync.__getPinDraftSyncDebug().outboxSize, 0, "oversized entry dropped, not stuck retrying");
  });

  await test("init is idempotent: second init is a no-op (single subscription, first fetchImpl kept)", async () => {
    reset();
    const srv1 = createMockServer();
    const srv2 = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv1.fetchImpl });
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv2.fetchImpl });
    assert.ok(await sync.__waitForPinDraftSyncReady());
    const a = store.createBoardDraft({ imageUrl: "https://x/i1.png", source: "uploaded_image" });
    await until(() => srv1.live().some(r => r.draftId === a.id), 3_000);
    assert.equal(srv2.log.length, 0, "second init's fetch must never be used");
    assert.equal(srv1.putCalls().length, 1, "exactly one PUT — no double subscription");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
