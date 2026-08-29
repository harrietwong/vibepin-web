/**
 * WP0 unit tests for the Pin Draft server-persistence write-through engine.
 * Run: npx tsx scripts/test-pin-draft-sync.ts   (from web/)
 *
 * Covers: diff/outbox, LWW merge (local newer / server newer / equal), tombstone
 * convergence (both directions), first-load migration, cursor-paginated pull,
 * >50 batch chunking, backoff retry queue (never drops the outbox), 202 deferred
 * degradation, the 200KB payload guard, idempotent init, and the 409-stale
 * reconciliation (re-base onto the server's current row FIELD-LEVEL, retry ONCE,
 * then defer).
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

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
  // Drafts the next PUT(s) must answer 409 stale for, and the row the client is
  // handed as `current`. This is the server having lost its compare-and-set:
  // the stored row moved between the LWW read and the conditional write.
  let staleIds = new Set<string>();
  let staleFor = 0;              // how many more PUTs still answer 409
  const staleCurrent = new Map<string, Row>();
  // Runs INSIDE a PUT, after the request body is captured and before the response
  // resolves — i.e. while the request is genuinely in flight. The defect under test
  // only exists in that window: the merchant edits after the payload has left the
  // client but before its 409 comes back, so `sent` and the local draft diverge.
  // Without this the edit lands before the PUT and the two are identical, which is
  // a different (already-correct) scenario.
  let onPut: (() => void) | null = null;
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
      const drafts = body.drafts as Array<{ draftId: string; updatedAt: string; payload: Record<string, unknown> }>;
      if (onPut) { const fn = onPut; onPut = null; fn(); }
      const conflicts = staleFor > 0 ? drafts.filter(d => staleIds.has(d.draftId)) : [];
      if (staleFor > 0) staleFor--;
      let applied = 0, skippedStale = 0;
      for (const d of drafts) {
        if (conflicts.some(c => c.draftId === d.draftId)) continue; // conditional write matched nothing
        const ex = rows.get(d.draftId);
        if (ex && Date.parse(d.updatedAt) < Date.parse(ex.updatedAt)) { skippedStale++; continue; }
        rows.set(d.draftId, { draftId: d.draftId, updatedAt: d.updatedAt, payload: d.payload });
        applied++;
      }
      if (conflicts.length > 0) {
        const stale = conflicts.map(c => {
          const cur = staleCurrent.get(c.draftId) ?? rows.get(c.draftId) ?? null;
          return {
            draftId: c.draftId,
            // The COLUMNS, as readCurrentRow returns them. `updated_at` is the row's
            // own clock (which a column-only write moves without touching the
            // payload) and `deleted_at` is the only place a tombstone shows up.
            current: cur
              ? {
                  payload: cur.payload,
                  updated_at: cur.updatedAt,
                  scheduled_at: null,
                  deleted_at: cur.deletedAt ?? null,
                }
              : null,
          };
        });
        return json({ error: "stale", code: "stale", stale, current: stale[0].current, applied, skippedStale }, 409);
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
    /** Answer 409 stale for these drafts on the next `times` PUT(s), handing back `current`. */
    staleNext: (ids: string[], times: number, current?: Row[]) => {
      staleIds = new Set(ids);
      staleFor = times;
      staleCurrent.clear();
      for (const r of current ?? []) staleCurrent.set(r.draftId, r);
      // The server copy the client must converge on IS the stored row.
      for (const r of current ?? []) rows.set(r.draftId, r);
    },
    /** Run `fn` during the NEXT PUT, while that request is still in flight. */
    duringNextPut: (fn: () => void) => { onPut = fn; },
    live: () => [...rows.values()].filter(r => !r.deletedAt),
    putCalls: () => log.filter(l => l.method === "PUT"),
    deleteCalls: () => log.filter(l => l.method === "DELETE"),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const store = await import("../src/lib/pinDraftStore");
  const sync = await import("../src/lib/pinDraftSync");
  // The route's promotion rule, applied to a retry payload: the client can send a
  // perfect payload and still end up unrunnable if `scheduled_at` promotes to null.
  const { buildScheduledAt } = await import("../src/app/api/pin-drafts/promote");

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

  // ── 409 stale reconciliation ────────────────────────────────────────────────
  // The server refuses a write whose compare-and-set lost. What must NOT happen is
  // the client shrugging: an unhandled 409 would land in the generic error path,
  // back off, and re-send the very same older payload for as long as it takes to
  // win — which is exactly the blind overwrite the server change exists to stop.

  await test("409 stale: client merges the server's current row and retries ONCE", async () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/s1.png", source: "uploaded_image", title: "local" });
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 1, 3_000);
    const putsBefore = srv.putCalls().length;

    // Another writer moved the row forward; the next PUT loses its CAS once.
    const future = new Date(Date.now() + 120_000).toISOString();
    srv.staleNext([a.id], 1, [serverDraft(a.id, future, { title: "server-won" })]);

    store.updateDraft(a.id, { title: "local-edit" });
    await until(() => sync.__getPinDraftSyncDebug().outboxSize === 0, 4_000);

    const puts = srv.putCalls().slice(putsBefore);
    assert.equal(puts.length, 2, `409 → exactly one retry (saw ${puts.length} PUTs)`);
    assert.deepEqual(puts[1].body!.drafts!.map(d => d.draftId), [a.id], "the retry carries only the conflicted draft");
    // Nothing was edited between the send and the 409, so the delta is empty and the
    // server's row is adopted whole. (It is newer here too, but that is no longer what
    // decides it — see the re-base cases below.)
    assert.equal(store.getDraft(a.id)!.title, "server-won", "the server's newer copy must be merged in, not ignored");
  });

  await test("409 twice: the cycle stops at two PUTs — deferred to the NEXT pass, never dropped", async () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/s2.png", source: "uploaded_image", title: "local" });
    const srv = createMockServer();
    // A visible cycle boundary: the debounce is what separates "this cycle" from
    // "the next pass", so it has to be longer than the window we measure in.
    const SLOW = { ...FAST, debounceMs: 250 };
    sync.initPinDraftSync(getToken, { ...SLOW, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 1, 3_000);
    const putsBefore = srv.putCalls().length;

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const future = new Date(Date.now() + 120_000).toISOString();
      srv.staleNext([a.id], 2, [serverDraft(a.id, future, { title: "server-won" })]);
      store.updateDraft(a.id, { title: "local-edit-2" });
      await until(() => srv.putCalls().length - putsBefore >= 2, 4_000);
      await sleep(120); // well inside the 250ms debounce → any third PUT here is a third ATTEMPT
      assert.equal(
        srv.putCalls().length - putsBefore, 2,
        `a second 409 must stop THIS cycle at 2 PUTs (saw ${srv.putCalls().length - putsBefore})`,
      );
      assert.ok(
        warnings.some(w => w.includes("still stale") && w.includes(a.id)),
        "giving up silently would look exactly like a successful sync — it must warn",
      );
      assert.ok(sync.__getPinDraftSyncDebug().outboxSize >= 1, "the entry must stay in the outbox, not be dropped");

      // …and it must come BACK. A stranded outbox entry (pendingCount stuck at 1
      // until some unrelated edit happens) is the silent drop, just slower. The
      // next pass carries the merged payload, so it converges instead of re-sending
      // the losing copy — which is why re-arming is not a hot loop.
      await until(() => srv.putCalls().length - putsBefore >= 3, 3_000);
      const third = srv.putCalls().slice(putsBefore)[2];
      assert.deepEqual(third.body!.drafts!.map(d => d.draftId), [a.id]);
      assert.equal(
        (third.body!.drafts![0] as unknown as { payload: { title?: string } }).payload.title,
        "server-won",
        "the next pass must send the MERGED payload, not the older local copy",
      );
      await until(() => sync.__getPinDraftSyncDebug().outboxSize === 0, 3_000);
    } finally {
      console.warn = realWarn;
      sync.__resetPinDraftSyncForTests();
    }
  });

  // ── The re-base rule (Codex round 5) ────────────────────────────────────────
  // The sequence that whole-payload LWW cannot survive, and the reason this path
  // no longer uses it. Note what is NOT in these fixtures: an artificially FUTURE
  // server timestamp. The old test stamped the server row at now+120s, so LWW won
  // on timestamp alone and the assertions passed while the defect sat untouched.
  // Here the server row is stamped BEFORE the local edit — exactly as it happens
  // in life, where the merchant types while the cron's write is already stored —
  // so the local copy is genuinely newer and only a field-level merge can be right.

  /**
   * Run the whole race for one draft and return the payload the RETRY carried.
   *
   * The order matters and is the reason for the in-flight hook: the merchant's edit
   * has to happen AFTER the PUT left the client. If it lands before, `sent` already
   * contains it, the delta is empty, and the test proves nothing about the defect.
   *
   *  1. a scheduled draft is synced, so the server has it and the next PUT's payload
   *     is the pre-publish copy (schedule and all);
   *  2. an edit arms the outbox and the PUT goes out carrying that copy;
   *  3. WHILE it is in flight the cron result becomes the stored row (published,
   *     schedule cleared) and the merchant edits again → local draft B, strictly
   *     newer than the row, still based on the pre-publish payload;
   *  4. the PUT comes back 409 stale with that row as `current`.
   */
  async function raceDuringPublish(
    key: string,
    /** The merchant's in-flight edit; `null` = they touched nothing during the PUT. */
    edit: Parameters<typeof store.updateDraft>[1] | null,
    serverPatch: Record<string, unknown> = {},
  ) {
    const srv = createMockServer();
    const a = store.createBoardDraft({ imageUrl: `https://x/${key}.png`, source: "uploaded_image", title: "sched" });
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 1, 3_000);
    store.updateDraft(a.id, {
      scheduledDate: "2026-07-01", scheduledTime: "09:00", plannedAt: "2026-07-01T09:00",
    });
    await until(() => sync.__getPinDraftSyncDebug().outboxSize === 0, 3_000);
    const putsBefore = srv.putCalls().length;

    let published!: Row;
    srv.duringNextPut(() => {
      // The cron's write, stamped now — NOT at some artificial future offset. The old
      // fixture used now+120s, which let whole-payload LWW win on the timestamp and
      // hid the defect completely.
      const serverAt = new Date().toISOString();
      published = serverDraft(a.id, serverAt, {
        scheduledDate: "", scheduledTime: "", plannedAt: "",
        title: "sched", // untouched since the send → never part of a delta
        destinationResults: [{ provider: "pinterest", status: "published", remotePinUrl: "https://pin/9" }],
        previousResults: [{ provider: "pinterest", status: "published" }],
        postedAt: serverAt, remotePinId: "pin9", remotePinUrl: "https://pin/9",
        ...serverPatch,
      });
      srv.staleNext([a.id], 1, [published]);
      // The merchant edits while the request is still out. Their draft is now newer
      // than the stored row — which is exactly what LWW gets wrong.
      if (edit) store.updateDraft(a.id, edit);
    });

    store.updateDraft(a.id, { altText: `touch-${key}` }); // arms the outbox → the PUT goes out
    await until(() => srv.putCalls().length > putsBefore, 3_000);
    await until(() => sync.__getPinDraftSyncDebug().outboxSize === 0, 4_000);

    const retry = srv.putCalls().slice(putsBefore).at(-1)! .body!.drafts![0] as unknown as
      { payload: Record<string, unknown>; updatedAt: string };
    return { srv, id: a.id, published, retry, puts: srv.putCalls().length - putsBefore };
  }

  await test("409 re-base: an edit made DURING the publish keeps its field — and nothing else", async () => {
    reset();
    const { srv, id, retry } = await raceDuringPublish("r1", { title: "edited-during-publish" });
    assert.ok(
      Date.parse(store.getDraft(id)!.updatedAt) >= Date.parse(srv.rows.get(id)!.updatedAt),
      "fixture check: the local edit must not be OLDER than the server row, or the defect is masked",
    );

    // The one field they changed survives…
    assert.equal(retry.payload.title, "edited-during-publish", "the merchant's edit must not be lost");
    // …and every field they did NOT touch comes from the server.
    assert.equal(retry.payload.scheduledDate, "", "an untouched schedule must stay as the server left it");
    assert.equal(retry.payload.scheduledTime, "");
    assert.equal(retry.payload.plannedAt, "");
    assert.deepEqual(retry.payload.destinationResults,
      [{ provider: "pinterest", status: "published", remotePinUrl: "https://pin/9" }],
      "the publish results must ride the retry, not be erased by it");
    assert.deepEqual(retry.payload.previousResults, [{ provider: "pinterest", status: "published" }]);
    assert.equal(retry.payload.remotePinId, "pin9");
    assert.equal(retry.payload.remotePinUrl, "https://pin/9");

    // The store must show the server's truth too — leaving the UI on B would tell the
    // merchant their Content is still scheduled while it is already live.
    const local = store.getDraft(id)! as unknown as Record<string, unknown>;
    assert.equal(local.title, "edited-during-publish");
    assert.equal(local.scheduledDate, "", "the local store must not stay on the pre-publish copy");
    assert.ok(local.destinationResults, "the merchant must see the publish results");
    assert.equal(local.status, "needs_review", "status is derived: no schedule left ⇒ not ready");
  });

  await test("409 re-base: a RESCHEDULE made during the publish is real intent and wins", async () => {
    reset();
    // This time they DID touch the schedule. Keeping the server's cleared one would
    // silently discard an instruction the merchant actually gave.
    //
    // The date must be in the FUTURE relative to the publish this races with: the
    // server row is stamped `postedAt = now`, and the promoted `scheduled_at` a
    // reschedule earns is the one that is strictly LATER than that post. A hardcoded
    // past date would be nulled for the right reason and prove nothing.
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const { published, retry } = await raceDuringPublish("r2", { scheduledDate: day, scheduledTime: "14:30" });
    assert.equal(retry.payload.scheduledDate, day, "a schedule the merchant re-set must survive");
    assert.equal(retry.payload.scheduledTime, "14:30");
    assert.equal(retry.payload.plannedAt, `${day}T14:30`,
      "the group moves together — plannedAt comes from the same side");
    assert.ok(retry.payload.destinationResults, "their reschedule still must not erase what was published");

    // ── and the RETRY must promote to a runnable schedule ───────────────────
    // Asserting the payload fields alone was not enough: the payload carried the new
    // time all along, and the route still promoted `scheduled_at = null` because the
    // re-based retry (correctly) also carries the server's postedAt/remotePinId. The
    // cron scans that COLUMN, so the merchant's reschedule silently never ran. This
    // asserts what the route actually writes for this exact retry payload.
    assert.ok((published.payload as Record<string, unknown>).postedAt,
      "fixture check: the server row must be posted, or this asserts nothing");
    const promoted = buildScheduledAt(retry.payload);
    assert.ok(promoted, "the re-based retry must promote a NON-NULL scheduled_at — the cron scans it");
    // Equality against the merchant's chosen time, resolved through the same zone the
    // store stamped on the draft (never a hardcoded UTC instant: `updateDraft` restamps
    // scheduleTimezone with the machine's zone, so the instant is machine-dependent).
    const expected = buildScheduledAt({
      plannedAt: `${day}T14:30`,
      scheduleTimezone: retry.payload.scheduleTimezone,
    });
    assert.equal(promoted, expected, "the promoted instant must be the merchant's new time");
    assert.ok(Date.parse(promoted!) > Date.parse((published.payload as Record<string, string>).postedAt),
      "and it must be later than the post it supersedes — that is what makes it honoured");
  });

  await test("409 re-base: a STALE pre-publish schedule still promotes to null", async () => {
    reset();
    // The other side of the same rule. Here the merchant touched something else, so
    // the schedule group comes from the SERVER (cleared by the publish) — and even a
    // payload that somehow kept a pre-publish time must not become due again.
    const { retry } = await raceDuringPublish("r2b", { title: "edited" });
    assert.equal(buildScheduledAt(retry.payload), null,
      "nothing the merchant did asks for a new run, so nothing may be scheduled");
    assert.equal(
      buildScheduledAt({ ...retry.payload, plannedAt: "2026-07-01T09:00", scheduleTimezone: "UTC" }),
      null,
      "a stale client still holding the pre-publish time must not resurrect the schedule");
  });

  await test("409 re-base: no edit during the flight ⇒ the server's row is adopted whole", async () => {
    reset();
    // Nothing was edited between the send and the 409: there is no local intent to
    // preserve, so nothing local may survive.
    const { published, retry } = await raceDuringPublish("r3", null);
    for (const k of ["title", "scheduledDate", "scheduledTime", "plannedAt", "destinationResults", "postedAt"]) {
      assert.deepEqual(retry.payload[k], (published.payload as Record<string, unknown>)[k],
        `with no local delta the server's ${k} must be sent back unchanged`);
    }
  });

  await test("409 re-base: a FAILED publish's cleared schedule is not resurrected either", async () => {
    reset();
    // writeFailure clears the schedule WITHOUT setting postedAt, so the server's
    // "already published ⇒ never due" guard does not cover this case. The group rule
    // is the only thing between this and a silently re-scheduled retry.
    const { retry } = await raceDuringPublish("r4", { description: "edited-after-failure" }, {
      destinationResults: [{ provider: "pinterest", status: "failed" }],
      previousResults: undefined, postedAt: "", remotePinId: "", remotePinUrl: "",
      publishError: "board_not_owned", failureType: "publish", errorCategory: "content",
      publishErrorCode: "board_not_owned",
    });
    assert.equal(retry.payload.description, "edited-after-failure");
    assert.equal(retry.payload.scheduledDate, "", "a schedule cleared by a FAILED publish must stay cleared");
    assert.equal(retry.payload.plannedAt, "");
    assert.equal(retry.payload.publishError, "board_not_owned", "the failure framing must reach the merchant");
    assert.equal(retry.payload.failureType, "publish");
  });

  await test("409 re-base: untouched scheduledDestinations come from the server", async () => {
    reset();
    const { retry } = await raceDuringPublish("r5", { title: "t" },
      { scheduledDestinations: [{ provider: "pinterest", connectionId: "c-server" }] });
    assert.deepEqual(retry.payload.scheduledDestinations, [{ provider: "pinterest", connectionId: "c-server" }],
      "the merchant did not touch destinations, so the server's intent stands");
  });

  await test("409 re-base: the declared updatedAt is max(local, server) — never older, never invented", async () => {
    reset();
    const { srv, id, retry } = await raceDuringPublish("r6", { title: "t" });
    const serverAt = srv.rows.get(id)!.updatedAt;
    // Older than the row would be silently skipped by the server's LWW (a green 200
    // that writes nothing); a fresh Date.now() would race the cron's next write.
    assert.ok(Date.parse(retry.updatedAt) >= Date.parse(serverAt),
      `the retry must never declare a stamp OLDER than the row it re-based onto (${retry.updatedAt} vs ${serverAt})`);
    assert.equal(retry.payload.updatedAt, retry.updatedAt, "payload and envelope must agree");
    assert.equal(store.getDraft(id)!.updatedAt, retry.updatedAt,
      "the stamp is the store's, not one invented at send time");
  });

  // ── The row's OWN columns, which the payload does not always agree with ────

  await test("409: the retry stamp uses the row's updated_at COLUMN, not just payload.updatedAt", async () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/s7.png", source: "uploaded_image", title: "local" });
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 1, 3_000);
    const putsBefore = srv.putCalls().length;

    // A write that moved the COLUMN without rewriting the payload — a tombstone, the
    // draft-cap sweep, any column-only UPDATE. The payload's own updatedAt is left
    // behind, so a retry stamped from the payload alone is OLDER than the row: the
    // route answers 200 skippedStale, the client treats that as success and drops the
    // outbox entry, and the write is silently gone.
    const columnAt = new Date(Date.now() + 120_000).toISOString();
    const stalePayloadAt = new Date(Date.now() - 120_000).toISOString();
    const row = serverDraft(a.id, columnAt, { title: "server-won" });
    (row.payload as Record<string, unknown>).updatedAt = stalePayloadAt;
    srv.staleNext([a.id], 1, [row]);

    store.updateDraft(a.id, { title: "local-edit" });
    await until(() => sync.__getPinDraftSyncDebug().outboxSize === 0, 4_000);

    const puts = srv.putCalls().slice(putsBefore);
    assert.equal(puts.length, 2, `409 → exactly one retry (saw ${puts.length} PUTs)`);
    const retry = puts[1].body!.drafts![0] as unknown as { updatedAt: string; payload: Record<string, unknown> };
    assert.ok(
      Date.parse(retry.updatedAt) >= Date.parse(columnAt),
      `the retry must clear the ROW's clock, not the payload's (${retry.updatedAt} vs column ${columnAt})`,
    );
    assert.equal(retry.payload.updatedAt, retry.updatedAt, "payload and envelope must agree");
    // …and the server must therefore have ACCEPTED it rather than skipping it stale.
    assert.equal(srv.rows.get(a.id)!.updatedAt, retry.updatedAt,
      "a retry older than the row is answered 200 skippedStale — acknowledged, never written");
    // The edit landed BEFORE the PUT went out, so it is part of `sent`: the delta is
    // empty and the server's row is adopted whole (the s1 case above, unchanged). What
    // this test is about is the STAMP, and the stamp must be the row's.
    assert.equal(store.getDraft(a.id)!.title, "server-won",
      "with no in-flight edit the server's copy is adopted — only the stamp comes from the column");
    assert.equal(store.getDraft(a.id)!.updatedAt, retry.updatedAt,
      "the stamp is the store's, not one invented at send time");
  });

  await test("409: a row TOMBSTONED on the server is applied locally, never retried back to life", async () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/s8.png", source: "uploaded_image", title: "local" });
    const srv = createMockServer();
    sync.initPinDraftSync(getToken, { ...FAST, fetchImpl: srv.fetchImpl });
    await until(() => srv.live().length === 1, 3_000);
    const putsBefore = srv.putCalls().length;

    // Deleted on another device while this write was in flight. The DELETE writes
    // COLUMNS only — the payload still looks perfectly alive — so `deleted_at` is the
    // one thing that can tell the client. Stamped ahead of the local edit, which is
    // the case where the deletion is what the merchant last asked for.
    const deletedAt = new Date(Date.now() + 120_000).toISOString();
    const tombstone = { ...serverDraft(a.id, deletedAt), deletedAt };
    srv.staleNext([a.id], 1, [tombstone]);

    store.updateDraft(a.id, { title: "local-edit" });
    await until(() => sync.__getPinDraftSyncDebug().outboxSize === 0, 4_000);
    await sleep(60); // any retry PUT would have gone out inside this window

    const puts = srv.putCalls().slice(putsBefore);
    assert.equal(puts.length, 1,
      `a tombstoned row must not be re-sent — route.ts writes deleted_at: null on a newer PUT, `
      + `so the retry would revive the draft the merchant deleted (saw ${puts.length} PUTs)`);
    assert.equal(store.getDraft(a.id), null,
      "the local draft must be dropped the same way the startup pull applies a server deletion");
    assert.equal(sync.__getPinDraftSyncDebug().outboxSize, 0,
      "the outbox entry must be dropped, not orphaned — rebuildChunk skips a missing draft, "
      + "so leaving it would hold pendingCount at 1 forever with nothing left to send");
    assert.ok(srv.rows.get(a.id)!.deletedAt, "the server row must still be a tombstone");
  });

  // ── Source contract ─────────────────────────────────────────────────────────

  await test("source: reconcileStale re-bases field-level and never LWWs a live server payload", () => {
    const src = fs
      .readFileSync(path.join(__dirname_, "../src/lib/pinDraftSync.ts"), "utf8")
      .replace(/\r\n?/g, "\n");
    const start = src.indexOf("async function reconcileStale");
    assert.ok(start > 0, "reconcileStale must still exist");
    const body = src.slice(start, src.indexOf("function rebuildChunk"));
    // The defect this guards is whole-PAYLOAD LWW: handing a server payload to
    // mergeServerDrafts here keeps the local pre-publish copy (it is newer) and the
    // retry resurrects the cleared schedule. Applying a TOMBSTONE through the same
    // helper is the opposite — no payload is merged, and it is how the pull path
    // already applies a server deletion. So the contract is the first argument being
    // empty, not the helper being unmentioned.
    for (const call of body.match(/\bmergeServerDrafts\s*\([\s\S]{0,40}/g) ?? []) {
      assert.match(call, /mergeServerDrafts\s*\(\s*\[\s*\]/,
        "the 409 path may only apply DELETIONS through mergeServerDrafts, never server payloads: "
        + "a local edit made during a publish is NEWER, so LWW would keep the entire pre-publish "
        + `copy and the retry would resurrect the cleared schedule (found: ${call.trim()})`,
      );
    }
    assert.ok(/\brebaseDraftOnServer\s*\(/.test(body), "the 409 path must re-base field-level");
    assert.ok(/sentById|c\.draft/.test(body),
      "the delta needs the payload that was SENT — without that snapshot there is nothing to diff against");
    // The pull path is where LWW's question ("whose copy is newer") is the right one.
    assert.ok(/mergeServerDrafts\s*\(/.test(src.slice(0, start)), "the startup pull must still use LWW");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
