/**
 * WP-A unit tests for the generic account-level write-through sync engine
 * (userStoreSync.ts). Run: npx tsx scripts/test-user-store-sync.ts   (from web/)
 *
 * Covers: multiple store instances isolated from one another, LWW merge (both
 * directions), tombstone convergence (both directions), cursor-paginated pull,
 * first-load migration (local-only docs uploaded), >50 batch chunking, backoff
 * retry (never drops the outbox), 202 deferred degradation, the 200KB payload
 * guard, singleton (single doc_id) store round-trip, and register/init ordering.
 *
 * The engine is exercised through a generic in-memory doc store defined here — it
 * is NOT bound to any product store (that is WP-B).
 */

import assert from "node:assert";
import type { StoreSyncAdapter } from "../src/lib/userStoreSync";

// ── window shim that routes by event TYPE (so per-store events stay isolated) ──
const listenersByType = new Map<string, Set<() => void>>();
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (t: string, cb: () => void) => {
    let s = listenersByType.get(t);
    if (!s) { s = new Set(); listenersByType.set(t, s); }
    s.add(cb);
  },
  removeEventListener: (t: string, cb: () => void) => { listenersByType.get(t)?.delete(cb); },
  dispatchEvent: (evt: { type: string }) => { listenersByType.get(evt.type)?.forEach(fn => fn()); return true; },
};
function dispatch(type: string) {
  (globalThis as unknown as { window: { dispatchEvent: (e: { type: string }) => void } })
    .window.dispatchEvent({ type });
}

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

// ── Generic in-memory doc store (stands in for a product store) ────────────────
interface Doc { id: string; updatedAt: string; value?: string; [k: string]: unknown }

function tsMs(v: string | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function makeStore(eventName: string) {
  const docs = new Map<string, Doc>();
  const held = new Set<string>();
  const emit = () => dispatch(eventName);
  return {
    eventName,
    getAll: () => [...docs.values()].map(d => ({ id: d.id, updatedAt: d.updatedAt, doc: d, ...(held.has(d.id) ? { hold: true } : {}) })),
    peek: (id: string) => docs.get(id) ?? null,
    all: () => [...docs.values()],
    /** Mark/unmark a doc as held (not-yet-uploadable) and emit so the engine re-diffs. */
    hold(id: string, on: boolean) { if (on) held.add(id); else held.delete(id); emit(); },
    /** Local write (create/update) — emits. */
    put(id: string, patch: Partial<Doc> = {}) {
      const now = new Date(Date.now() + 1).toISOString(); // strictly-monotonic-ish
      docs.set(id, { id, value: "", ...docs.get(id), ...patch, updatedAt: now });
      emit();
      return docs.get(id)!;
    },
    putAt(id: string, updatedAt: string, patch: Partial<Doc> = {}) {
      docs.set(id, { id, value: "", ...docs.get(id), ...patch, updatedAt });
      emit();
      return docs.get(id)!;
    },
    /** Local delete — emits. */
    remove(id: string) { if (docs.delete(id)) emit(); },
    /** Seed without emitting (pre-init local state). */
    seed(id: string, updatedAt: string, patch: Partial<Doc> = {}) {
      docs.set(id, { id, value: "", ...patch, updatedAt });
    },
    /** LWW merge server state into local (single emit) — the adapter.mergeServer. */
    mergeServer(live: Doc[], deleted: Array<{ id: string; deletedAt: string }>) {
      let changed = false;
      for (const inc of live) {
        if (!inc || typeof inc.id !== "string") continue;
        const local = docs.get(inc.id);
        if (local && tsMs(inc.updatedAt) <= tsMs(local.updatedAt)) continue;
        docs.set(inc.id, inc);
        changed = true;
      }
      for (const t of deleted) {
        const local = docs.get(t.id);
        if (!local) continue;
        if (tsMs(local.updatedAt) >= tsMs(t.deletedAt)) continue;
        docs.delete(t.id);
        changed = true;
      }
      if (changed) emit();
    },
  };
}
type Store = ReturnType<typeof makeStore>;

// ── Mock /api/user-store server (scopes rows by storeKey) ──────────────────────
type Row = { docId: string; updatedAt: string; deletedAt?: string; payload: Record<string, unknown> };

function createMockServer(initial: Record<string, Row[]> = {}) {
  const byKey = new Map<string, Map<string, Row>>();
  for (const [k, rows] of Object.entries(initial)) byKey.set(k, new Map(rows.map(r => [r.docId, r])));
  const rowsFor = (k: string) => { let m = byKey.get(k); if (!m) { m = new Map(); byKey.set(k, m); } return m; };

  const log: Array<{ method: string; storeKey: string; body?: { docs?: Array<{ docId: string }>; docIds?: string[]; deletedAt?: string } }> = [];
  let failCount = 0;
  let deferWrites = false;
  const rejectDocIds = new Set<string>(); // simulate server per-store quota refusal
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const u = new URL(url, "http://localhost");
    const storeKey = method === "GET" ? (u.searchParams.get("storeKey") ?? "") : (body?.storeKey ?? "");
    log.push({ method, storeKey, body });
    if (failCount > 0) { failCount--; return json({ error: "boom", code: "database_unavailable" }, 503); }

    if (method === "GET") {
      const rows = rowsFor(storeKey);
      const limit = parseInt(u.searchParams.get("limit") ?? "100", 10);
      const offset = parseInt(u.searchParams.get("cursor") ?? "0", 10) || 0;
      const all = [...rows.values()].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.docId.localeCompare(b.docId),
      );
      const page = all.slice(offset, offset + limit);
      const next = offset + limit < all.length ? String(offset + limit) : undefined;
      return json({ docs: page, ...(next ? { nextCursor: next } : {}) });
    }
    if (deferWrites) return json({ deferred: true }, 202);
    const rows = rowsFor(storeKey);
    if (method === "PUT") {
      let applied = 0, skippedStale = 0;
      const rejected: string[] = [];
      for (const d of body.docs as Array<{ docId: string; updatedAt: string; payload: Record<string, unknown> }>) {
        const ex = rows.get(d.docId);
        if (ex && Date.parse(d.updatedAt) < Date.parse(ex.updatedAt)) { skippedStale++; continue; }
        if (rejectDocIds.has(d.docId) && !ex) { rejected.push(d.docId); continue; } // over-quota new insert
        rows.set(d.docId, { docId: d.docId, updatedAt: d.updatedAt, payload: d.payload });
        applied++;
      }
      return json({ applied, skippedStale, ...(rejected.length ? { rejected, code: "quota_exceeded" } : {}) });
    }
    if (method === "DELETE") {
      let applied = 0;
      for (const id of body.docIds as string[]) {
        const ex = rows.get(id);
        if (ex && Date.parse(ex.updatedAt) > Date.parse(body.deletedAt as string)) continue;
        rows.set(id, { docId: id, updatedAt: body.deletedAt, deletedAt: body.deletedAt, payload: ex?.payload ?? {} });
        applied++;
      }
      return json({ applied });
    }
    return json({ error: "not found", code: "not_found" }, 404);
  }) as typeof fetch;

  return {
    log, fetchImpl,
    failNext: (n: number) => { failCount = n; },
    defer: (on: boolean) => { deferWrites = on; },
    rejectNewInserts: (ids: string[]) => { rejectDocIds.clear(); ids.forEach(id => rejectDocIds.add(id)); },
    live: (k: string) => [...rowsFor(k).values()].filter(r => !r.deletedAt),
    row: (k: string, id: string) => rowsFor(k).get(id),
    putCalls: (k?: string) => log.filter(l => l.method === "PUT" && (!k || l.storeKey === k)),
    deleteCalls: (k?: string) => log.filter(l => l.method === "DELETE" && (!k || l.storeKey === k)),
    getCalls: (k?: string) => log.filter(l => l.method === "GET" && (!k || l.storeKey === k)),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const sync = await import("../src/lib/userStoreSync");

  const FAST = { debounceMs: 5, backoffBaseMs: 15, backoffMaxMs: 60, pageSize: 100 };
  const getToken = async () => "test-token";

  function adapterFor(store: Store, storeKey: string): StoreSyncAdapter<Doc> {
    return { storeKey, eventName: store.eventName, getAll: store.getAll, mergeServer: store.mergeServer };
  }

  function reset() { sync.__resetUserStoreSyncForTests(); listenersByType.clear(); }

  function serverRow(id: string, updatedAt: string, patch?: Record<string, unknown>): Row {
    return { docId: id, updatedAt, payload: { id, updatedAt, value: `srv-${id}`, ...patch } };
  }

  // ── Multi-instance isolation ────────────────────────────────────────────────

  await test("two stores sync independently to their own storeKey (no cross-talk)", async () => {
    reset();
    const srv = createMockServer();
    const a = makeStore("evt:store_a");
    const b = makeStore("evt:store_b");
    sync.registerStoreSync(adapterFor(a, "store_a"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.registerStoreSync(adapterFor(b, "store_b"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("store_a"));
    assert.ok(await sync.__waitForUserStoreSyncReady("store_b"));

    a.put("a1", { value: "A" });
    await until(() => srv.live("store_a").some(r => r.docId === "a1"));
    await sleep(30);
    assert.equal(srv.live("store_b").length, 0, "store_b must receive nothing when only store_a changed");
    assert.equal(srv.putCalls("store_b").length, 0, "no PUT ever hit store_b");

    b.put("b1", { value: "B" });
    await until(() => srv.live("store_b").some(r => r.docId === "b1"));
    assert.deepEqual(srv.live("store_a").map(r => r.docId), ["a1"]);
    assert.deepEqual(srv.live("store_b").map(r => r.docId), ["b1"]);
    assert.equal(sync.__getUserStoreSyncDebug("store_a")!.outboxSize, 0);
    assert.equal(sync.__getUserStoreSyncDebug("store_b")!.outboxSize, 0);
  });

  await test("failure isolation: a failing store never stalls a healthy one", async () => {
    reset();
    const srvA = createMockServer();
    const srvB = createMockServer();
    const a = makeStore("evt:iso_a");
    const b = makeStore("evt:iso_b");
    sync.registerStoreSync(adapterFor(a, "iso_a"), { ...FAST, fetchImpl: srvA.fetchImpl });
    sync.registerStoreSync(adapterFor(b, "iso_b"), { ...FAST, fetchImpl: srvB.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("iso_a"));
    assert.ok(await sync.__waitForUserStoreSyncReady("iso_b"));

    srvA.failNext(50); // store A's server is down
    a.put("a1", { value: "A" });
    b.put("b1", { value: "B" });
    await until(() => srvB.live("iso_b").some(r => r.docId === "b1"), 3_000); // B still syncs
    await until(() => sync.__getUserStoreSyncDebug("iso_a")!.failureCount >= 1, 3_000);
    assert.ok(sync.__getUserStoreSyncDebug("iso_a")!.outboxSize >= 1, "failing store retains its outbox");
    assert.equal(sync.__getUserStoreSyncDebug("iso_b")!.outboxSize, 0, "healthy store drained");
  });

  // ── LWW both directions ─────────────────────────────────────────────────────

  await test("LWW: server strictly newer overwrites local at startup", async () => {
    reset();
    const s = makeStore("evt:lww1");
    s.seed("d1", "2020-01-01T00:00:00.000Z", { value: "local-old" });
    const future = new Date(Date.now() + 60_000).toISOString();
    const srv = createMockServer({ lww1: [serverRow("d1", future, { value: "server-new" })] });
    sync.registerStoreSync(adapterFor(s, "lww1"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("lww1"));
    assert.equal(s.peek("d1")!.value, "server-new", "newer server doc wins locally");
    await sleep(30);
    assert.equal(sync.__getUserStoreSyncDebug("lww1")!.outboxSize, 0, "no spurious re-upload of a server-won doc");
  });

  await test("LWW: local strictly newer is kept and re-uploaded (revives server)", async () => {
    reset();
    const s = makeStore("evt:lww2");
    const future = new Date(Date.now() + 120_000).toISOString();
    s.seed("d1", future, { value: "local-new" });
    const srv = createMockServer({ lww2: [serverRow("d1", "2020-01-01T00:00:00.000Z", { value: "server-old" })] });
    sync.registerStoreSync(adapterFor(s, "lww2"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("lww2"));
    assert.equal(s.peek("d1")!.value, "local-new", "newer local kept");
    await until(() => (srv.row("lww2", "d1")?.payload as { value?: string })?.value === "local-new", 3_000);
    assert.equal(sync.__getUserStoreSyncDebug("lww2")!.outboxSize, 0);
  });

  await test("server LWW: a skippedStale response still drains the outbox", async () => {
    reset();
    const s = makeStore("evt:lww3");
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "lww3"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("lww3"));
    s.put("d1", { value: "v1" });
    await until(() => srv.live("lww3").some(r => r.docId === "d1"));

    // Another device wrote a newer version; our stale edit is skipped server-side.
    srv.row("lww3", "d1")!.updatedAt = new Date(Date.now() + 120_000).toISOString();
    srv.row("lww3", "d1")!.payload = { id: "d1", value: "newer-elsewhere" };
    s.put("d1", { value: "stale-local" });
    await until(() => sync.__getUserStoreSyncDebug("lww3")!.outboxSize === 0, 3_000);
    assert.equal((srv.row("lww3", "d1")!.payload as { value?: string }).value, "newer-elsewhere");
  });

  // ── Tombstone both directions ───────────────────────────────────────────────

  await test("tombstone push: local delete → server DELETE tombstone", async () => {
    reset();
    const s = makeStore("evt:tomb1");
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "tomb1"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("tomb1"));
    s.put("d1", { value: "x" });
    await until(() => srv.live("tomb1").some(r => r.docId === "d1"));

    s.remove("d1");
    await until(() => !!srv.row("tomb1", "d1")?.deletedAt);
    assert.equal(srv.deleteCalls("tomb1").length, 1);
    assert.deepEqual(srv.deleteCalls("tomb1")[0].body!.docIds, ["d1"]);
    assert.equal(sync.__getUserStoreSyncDebug("tomb1")!.outboxSize, 0);
  });

  await test("tombstone convergence at startup: newer server tombstone removes local; newer local revives", async () => {
    reset();
    const s = makeStore("evt:tomb2");
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = "2000-01-01T00:00:00.000Z";
    s.seed("dead", "2000-01-01T00:00:00.000Z", { value: "dead-local" });   // older than tombstone → removed
    s.seed("alive", future, { value: "alive-local" });                     // newer than tombstone → survives
    const srv = createMockServer({
      tomb2: [
        { docId: "dead", updatedAt: future, deletedAt: future, payload: {} },
        { docId: "alive", updatedAt: past, deletedAt: past, payload: {} },
      ],
    });
    sync.registerStoreSync(adapterFor(s, "tomb2"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("tomb2"));
    assert.equal(s.peek("dead"), null, "newer server tombstone wins locally");
    assert.ok(s.peek("alive"), "newer local survives a stale tombstone");
    await until(() => !srv.row("tomb2", "alive")?.deletedAt, 3_000); // re-uploaded → revived
  });

  // ── Held docs (media not yet offloaded): never tombstone, never PUT ─────────

  await test("held doc: a newly-added held doc is neither PUT nor DELETEd; release uploads it", async () => {
    reset();
    const s = makeStore("evt:hold_new");
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "hold_new"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("hold_new"));

    s.hold("c", true);            // mark held BEFORE it exists
    s.put("c", { value: "inline" }); // add while held (e.g. still a data: URL)
    await sleep(40);
    assert.ok(!srv.row("hold_new", "c"), "held doc must NOT be uploaded");
    assert.equal(srv.deleteCalls("hold_new").length, 0, "held doc must NOT be tombstoned");

    s.hold("c", false);           // sweep externalized → release
    await until(() => (srv.row("hold_new", "c")?.payload as { value?: string })?.value === "inline", 3_000);
    assert.equal(srv.deleteCalls("hold_new").length, 0, "still no DELETE after release");
  });

  await test("held doc: an already-synced doc that becomes held is never deleted; edits during hold flush on release as one PUT with the latest", async () => {
    reset();
    const s = makeStore("evt:hold_edit");
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "hold_edit"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("hold_edit"));

    s.put("a", { value: "v1" });
    await until(() => srv.live("hold_edit").some(r => r.docId === "a"), 3_000);

    s.hold("a", true);            // e.g. user replaced the image with an inline data: URL
    s.put("a", { value: "v2" });  // edited while held → must NOT upload v2 yet
    await sleep(40);
    assert.equal((srv.row("hold_edit", "a")!.payload as { value?: string }).value, "v1", "held edit not uploaded");
    assert.equal(srv.deleteCalls("hold_edit").length, 0, "held doc never tombstoned");

    const putsBefore = srv.putCalls("hold_edit").length;
    s.hold("a", false);           // release → one PUT carrying the latest content
    await until(() => (srv.row("hold_edit", "a")?.payload as { value?: string })?.value === "v2", 3_000);
    assert.ok(srv.putCalls("hold_edit").length > putsBefore, "release triggered a PUT");
    assert.equal(srv.deleteCalls("hold_edit").length, 0, "no DELETE across the whole hold cycle");
  });

  await test("held doc at startup: a locally-held doc present on the server is not re-uploaded while held, no DELETE, uploads on release", async () => {
    reset();
    const s = makeStore("evt:hold_start");
    s.seed("d", new Date(Date.now() - 60_000).toISOString(), { value: "local" });
    s.hold("d", true); // held before the engine mounts (inline image awaiting the sweep)
    // Server holds an OLDER copy → local is kept by LWW but must stay un-uploaded while held.
    const srv = createMockServer({ hold_start: [serverRow("d", "2000-01-01T00:00:00.000Z", { value: "server-old" })] });
    sync.registerStoreSync(adapterFor(s, "hold_start"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("hold_start"));
    await sleep(40);
    assert.equal((srv.row("hold_start", "d")!.payload as { value?: string }).value, "server-old", "held local not uploaded at startup");
    assert.equal(srv.deleteCalls("hold_start").length, 0, "held-at-startup doc never tombstoned");

    s.hold("d", false); // release → the kept-local value finally uploads
    await until(() => (srv.row("hold_start", "d")?.payload as { value?: string })?.value === "local", 3_000);
    assert.equal(srv.deleteCalls("hold_start").length, 0, "no DELETE after release");
  });

  // ── Pagination + first-load migration ───────────────────────────────────────

  await test("startup pull paginates all pages into the local store", async () => {
    reset();
    const s = makeStore("evt:page");
    const rows: Row[] = [];
    for (let i = 0; i < 25; i++) rows.push(serverRow(`srv_${String(i).padStart(2, "0")}`, `2026-05-01T00:00:${String(i).padStart(2, "0")}.000Z`));
    const srv = createMockServer({ page: rows });
    sync.registerStoreSync(adapterFor(s, "page"), { ...FAST, pageSize: 10, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("page"));
    assert.equal(s.all().length, 25);
    assert.ok(srv.getCalls("page").length >= 3, `expected >=3 GET pages, saw ${srv.getCalls("page").length}`);
  });

  await test("first-load migration: local-only docs are uploaded", async () => {
    reset();
    const s = makeStore("evt:mig");
    s.seed("m1", new Date().toISOString(), { value: "A" });
    s.seed("m2", new Date().toISOString(), { value: "B" });
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "mig"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    await until(() => srv.live("mig").length === 2, 3_000);
    assert.deepEqual(srv.live("mig").map(r => r.docId).sort(), ["m1", "m2"]);
    assert.equal(sync.__getUserStoreSyncDebug("mig")!.outboxSize, 0, "outbox drained after ack");
  });

  await test("diff/outbox: only the changed doc is PUT after an edit", async () => {
    reset();
    const s = makeStore("evt:diff");
    s.seed("a", new Date().toISOString(), { value: "A" });
    s.seed("b", new Date().toISOString(), { value: "B" });
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "diff"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    await until(() => srv.live("diff").length === 2, 3_000);
    const before = srv.putCalls("diff").length;

    s.put("a", { value: "A2" });
    await until(() => (srv.row("diff", "a")?.payload as { value?: string })?.value === "A2");
    const newPuts = srv.putCalls("diff").slice(before);
    assert.equal(newPuts.length, 1, "one incremental PUT");
    assert.deepEqual(newPuts[0].body!.docs!.map(d => d.docId), ["a"], "only the edited doc is sent");
  });

  // ── Batching / backoff / deferred / oversize ────────────────────────────────

  await test("batching: 120 docs flush in ≤50-doc PUT chunks", async () => {
    reset();
    const s = makeStore("evt:batch");
    for (let i = 0; i < 120; i++) s.seed(`b${i}`, new Date().toISOString(), { value: `t${i}` });
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "batch"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    await until(() => srv.live("batch").length === 120, 5_000);
    const puts = srv.putCalls("batch");
    assert.equal(puts.length, 3, `expected 3 PUT chunks, saw ${puts.length}`);
    for (const p of puts) assert.ok(p.body!.docs!.length <= 50, "each chunk ≤50");
    assert.equal(puts.reduce((n, p) => n + p.body!.docs!.length, 0), 120);
  });

  await test("backoff retry: a failed flush keeps the outbox and retries until success", async () => {
    reset();
    const s = makeStore("evt:retry");
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "retry"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("retry"));

    srv.failNext(2);
    s.put("r1", { value: "x" });
    await until(() => sync.__getUserStoreSyncDebug("retry")!.failureCount >= 1, 3_000);
    assert.ok(sync.__getUserStoreSyncDebug("retry")!.outboxSize >= 1, "outbox retained on failure");
    await until(() => srv.live("retry").some(r => r.docId === "r1"), 5_000);
    assert.equal(sync.__getUserStoreSyncDebug("retry")!.outboxSize, 0);
    assert.equal(sync.__getUserStoreSyncDebug("retry")!.failureCount, 0, "failure counter resets on success");
  });

  await test("202 deferred (table not applied): outbox retained, retried after recovery", async () => {
    reset();
    const s = makeStore("evt:defer");
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "defer"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("defer"));

    srv.defer(true);
    s.put("d1", { value: "x" });
    await until(() => srv.putCalls("defer").length >= 1, 3_000);
    await sleep(30);
    assert.equal(srv.live("defer").length, 0);
    assert.ok(sync.__getUserStoreSyncDebug("defer")!.outboxSize >= 1, "202 must not drop the outbox");
    srv.defer(false);
    await until(() => srv.live("defer").some(r => r.docId === "d1"), 5_000);
    assert.equal(sync.__getUserStoreSyncDebug("defer")!.outboxSize, 0);
  });

  await test("200KB guard: an oversized doc is skipped, the rest keeps syncing", async () => {
    reset();
    const s = makeStore("evt:big");
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "big"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("big"));

    s.put("big", { value: "x".repeat(210 * 1024) });
    s.put("small", { value: "ok" });
    await until(() => srv.live("big").some(r => r.docId === "small"), 3_000);
    assert.ok(!srv.row("big", "big"), "oversized doc never sent");
    assert.equal(sync.__getUserStoreSyncDebug("big")!.outboxSize, 0, "oversized entry dropped, not stuck retrying");
  });

  // ── Server quota rejection ──────────────────────────────────────────────────

  await test("server rejects over-quota inserts → outbox drained, no infinite retry, later docs still sync", async () => {
    reset();
    const s = makeStore("evt:quota");
    const srv = createMockServer();
    sync.registerStoreSync(adapterFor(s, "quota"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("quota"));

    // Server will refuse two specific new inserts (simulated quota_exceeded).
    srv.rejectNewInserts(["over1", "over2"]);
    s.put("ok1", { value: "a" });
    s.put("over1", { value: "b" });
    s.put("over2", { value: "c" });

    // The accepted doc lands; the rejected ones never do.
    await until(() => srv.live("quota").some(r => r.docId === "ok1"), 3_000);
    // Outbox must drain (rejected entries are acked/dropped, not retried forever).
    await until(() => sync.__getUserStoreSyncDebug("quota")!.outboxSize === 0, 3_000);
    assert.ok(!srv.row("quota", "over1"), "rejected doc not stored");
    assert.ok(!srv.row("quota", "over2"), "rejected doc not stored");
    assert.equal(sync.__getUserStoreSyncDebug("quota")!.rejectedCount, 2, "rejectedCount accumulates");

    // The PUT count must stabilize (proves no infinite retry of the rejected docs).
    const putsAfterDrain = srv.putCalls("quota").length;
    await sleep(80);
    assert.equal(srv.putCalls("quota").length, putsAfterDrain, "no further PUT retries after drain");
    assert.equal(sync.__getUserStoreSyncDebug("quota")!.failureCount, 0, "rejection is not a failure");

    // A subsequent, non-rejected doc syncs normally.
    s.put("ok2", { value: "d" });
    await until(() => srv.live("quota").some(r => r.docId === "ok2"), 3_000);
    assert.equal(sync.__getUserStoreSyncDebug("quota")!.outboxSize, 0);
  });

  // ── Singleton (single doc_id) store round-trip ──────────────────────────────

  await test("singleton store: one doc_id round-trips (server → local → server)", async () => {
    reset();
    const s = makeStore("evt:single");
    // Server already holds the singleton (local store empty) → it must land locally
    // on pull; a subsequent local edit (fresh, newer timestamp) must push back.
    const seeded = new Date(Date.now() - 60_000).toISOString();
    const srv = createMockServer({ singleton: [serverRow("__doc__", seeded, { count: 7 })] });
    sync.registerStoreSync(adapterFor(s, "singleton"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("singleton"));
    assert.equal((s.peek("__doc__") as unknown as { count: number }).count, 7, "server singleton pulled locally");

    s.put("__doc__", { count: 8 });
    await until(() => (srv.row("singleton", "__doc__")?.payload as { count?: number })?.count === 8, 3_000);
    assert.equal(srv.live("singleton").length, 1, "still exactly one doc row");
  });

  // ── Registration / init ordering ────────────────────────────────────────────

  await test("register AFTER init also mounts (init is not a one-shot gate)", async () => {
    reset();
    const srv = createMockServer();
    sync.initUserStoreSync(getToken); // init first, no stores yet
    const s = makeStore("evt:late");
    s.seed("l1", new Date().toISOString(), { value: "L" });
    sync.registerStoreSync(adapterFor(s, "late"), { ...FAST, fetchImpl: srv.fetchImpl });
    assert.ok(await sync.__waitForUserStoreSyncReady("late"), "late-registered store still pulls");
    await until(() => srv.live("late").some(r => r.docId === "l1"), 3_000);
  });

  await test("init is idempotent + double-register returns the same handle", async () => {
    reset();
    const srv1 = createMockServer();
    const srv2 = createMockServer();
    const s = makeStore("evt:idem");
    const h1 = sync.registerStoreSync(adapterFor(s, "idem"), { ...FAST, fetchImpl: srv1.fetchImpl });
    const h2 = sync.registerStoreSync(adapterFor(s, "idem"), { ...FAST, fetchImpl: srv2.fetchImpl });
    assert.strictEqual(h1.storeKey, h2.storeKey);
    sync.initUserStoreSync(getToken);
    sync.initUserStoreSync(async () => "other"); // second init ignored
    assert.ok(await sync.__waitForUserStoreSyncReady("idem"));
    s.put("i1", { value: "x" });
    await until(() => srv1.live("idem").some(r => r.docId === "i1"), 3_000);
    assert.equal(srv2.log.length, 0, "second register's fetch must never be used");
  });

  // ── WP-E: aggregate status + change-only notifications ──────────────────────

  await test("aggregate status: synced → syncing → synced, ref-stable, notifies only on change", async () => {
    reset();
    const srv = createMockServer();
    const s = makeStore("evt:agg1");

    let notifications = 0;
    const unsub = sync.subscribeSyncStatus(() => { notifications++; });

    // No registered stores yet → synced.
    assert.equal(sync.getAggregateSyncStatus().state, "synced");

    // A registered-but-not-ready instance shifts the aggregate to "syncing".
    sync.registerStoreSync(adapterFor(s, "agg1"), { ...FAST, fetchImpl: srv.fetchImpl });
    assert.equal(sync.getAggregateSyncStatus().state, "syncing");
    const snap = sync.getAggregateSyncStatus();
    assert.strictEqual(sync.getAggregateSyncStatus(), snap, "snapshot ref stays identical between changes");

    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("agg1"));
    await until(() => sync.getAggregateSyncStatus().state === "synced", 3_000);
    assert.equal(sync.getAggregateSyncStatus().pendingCount, 0);

    // A local write is reflected synchronously as pending/syncing, then drains.
    s.put("d1", { value: "x" });
    assert.equal(sync.getAggregateSyncStatus().state, "syncing", "pending write → syncing immediately");
    assert.ok(sync.getAggregateSyncStatus().pendingCount >= 1);
    await until(() => sync.getAggregateSyncStatus().state === "synced", 3_000);
    assert.equal(sync.getAggregateSyncStatus().pendingCount, 0);

    // A no-op store event (nothing changed) must NOT notify subscribers.
    const before = notifications;
    dispatch("evt:agg1");
    await sleep(25);
    assert.equal(notifications, before, "no notification when the computed status is unchanged");
    assert.ok(notifications > 0, "subscribers were notified on real transitions");
    unsub();
  });

  await test("aggregate status: 3 consecutive failures enter error(errorStores), recovery returns to synced", async () => {
    reset();
    const srv = createMockServer();
    const s = makeStore("evt:agg2");
    sync.registerStoreSync(adapterFor(s, "agg2"), { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("agg2"));
    await until(() => sync.getAggregateSyncStatus().state === "synced", 3_000);

    // Server is down for many flush attempts → failureCount climbs past the threshold.
    srv.failNext(10);
    s.put("e1", { value: "x" });
    await until(() => sync.getAggregateSyncStatus().state === "error", 6_000);
    assert.deepEqual(sync.getAggregateSyncStatus().errorStores, ["agg2"], "error store listed");
    assert.ok(sync.__getUserStoreSyncDebug("agg2")!.failureCount >= 3);

    // Once the server heals the retry lands and the aggregate recovers.
    await until(() => srv.live("agg2").some(r => r.docId === "e1"), 10_000);
    await until(() => sync.getAggregateSyncStatus().state === "synced", 3_000);
    assert.deepEqual(sync.getAggregateSyncStatus().errorStores, [], "errorStores cleared on recovery");
    assert.equal(sync.getAggregateSyncStatus().pendingCount, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
