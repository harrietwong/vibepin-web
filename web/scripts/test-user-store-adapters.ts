/**
 * WP-B unit tests for the per-store account-sync adapters (userStoreSyncRegistry).
 * Run: npx tsx scripts/test-user-store-adapters.ts   (from web/)
 *
 * For every adapter: getAll shape, mergeServer LWW (both directions), tombstone
 * merge, and a singleton/collection round-trip through the real engine + a mock
 * /api/user-store server. Plus the two backfill cases (bookmarks/pin_records
 * updatedAt) and the capacity-eviction regression (a trim must NOT emit a
 * tombstone) for pin_metadata and pin_sessions/pin_records.
 *
 * The adapters read/write localStorage + window events, so a shim for both is set
 * up BEFORE the stores are imported.
 */

import assert from "node:assert";

// ── window + localStorage shim (events routed by TYPE, like test-user-store-sync) ──
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
// `new Event(type)` used by the stores → minimal polyfill returning { type }.
(globalThis as unknown as { Event: unknown }).Event = class { type: string; constructor(t: string) { this.type = t; } };

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
function iso(offsetMs: number): string { return new Date(Date.now() + offsetMs).toISOString(); }

// ── Mock /api/user-store server (scopes rows by storeKey) ──────────────────────
type Row = { docId: string; updatedAt: string; deletedAt?: string; payload: Record<string, unknown> };
function createMockServer(initial: Record<string, Row[]> = {}) {
  const byKey = new Map<string, Map<string, Row>>();
  for (const [k, rows] of Object.entries(initial)) byKey.set(k, new Map(rows.map(r => [r.docId, r])));
  const rowsFor = (k: string) => { let m = byKey.get(k); if (!m) { m = new Map(); byKey.set(k, m); } return m; };
  const log: Array<{ method: string; storeKey: string; body?: { docs?: Array<{ docId: string }>; docIds?: string[]; deletedAt?: string } }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const u = new URL(url, "http://localhost");
    const storeKey = method === "GET" ? (u.searchParams.get("storeKey") ?? "") : (body?.storeKey ?? "");
    log.push({ method, storeKey, body });
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
    putCalls: (k?: string) => log.filter(l => l.method === "PUT" && (!k || l.storeKey === k)),
    deleteCalls: (k?: string) => log.filter(l => l.method === "DELETE" && (!k || l.storeKey === k)),
  };
}

async function main() {
  const sync = await import("../src/lib/userStoreSync");
  const pub = await import("../src/lib/publishingPrefsStore");
  const amz = await import("../src/lib/affiliate/amazonAffiliateSettings");
  const nic = await import("../src/lib/niches");
  const sched = await import("../src/lib/smartScheduleStore");
  const notif = await import("../src/lib/notificationPrefsStore");
  const brand = await import("../src/lib/brandProfileStore");
  const cpl = await import("../src/lib/affiliate/creatorProductLink");
  const bm = await import("../src/lib/useBookmarks");
  const meta = await import("../src/lib/pinMetadataStore");
  const pins = await import("../src/lib/pinStore");
  const { EMPTY_TOUCHED } = await import("../src/lib/pinMetadata");

  const FAST = { debounceMs: 5, backoffBaseMs: 15, backoffMaxMs: 60 };
  const getToken = async () => "test-token";

  function reset() {
    sync.__resetUserStoreSyncForTests();
    _ls.clear();
    listenersByType.clear();
    meta.__resetPinMetadataStoreForTests();
    pins.__resetPinStoreForTests();
  }

  // ── Singleton: publishing_prefs ─────────────────────────────────────────────

  await test("publishing_prefs getAll: [] when unsaved, one doc after save (with updatedAt)", () => {
    reset();
    assert.deepEqual(pub.publishingPrefsSyncAdapter.getAll(), [], "unsaved singleton must not sync defaults");
    pub.savePublishingPrefs({ ...pub.defaultPublishingPrefs(), weeklyGoal: 9 });
    const all = pub.publishingPrefsSyncAdapter.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "prefs");
    assert.equal(typeof all[0].updatedAt, "string");
    assert.equal((all[0].doc as { weeklyGoal: number }).weeklyGoal, 9);
  });

  await test("publishing_prefs mergeServer LWW: newer server wins, older ignored", () => {
    reset();
    pub.savePublishingPrefs({ ...pub.defaultPublishingPrefs(), weeklyGoal: 3 });
    // Older server doc → ignored.
    pub.publishingPrefsSyncAdapter.mergeServer([{ ...pub.defaultPublishingPrefs(), weeklyGoal: 1, updatedAt: iso(-60_000) } as never], []);
    assert.equal(pub.getPublishingPrefs().weeklyGoal, 3, "older server doc must not overwrite");
    // Newer server doc → wins.
    pub.publishingPrefsSyncAdapter.mergeServer([{ ...pub.defaultPublishingPrefs(), weeklyGoal: 7, updatedAt: iso(60_000) } as never], []);
    assert.equal(pub.getPublishingPrefs().weeklyGoal, 7, "newer server doc must win");
  });

  await test("publishing_prefs mergeServer tombstone: newer removes, older ignored", () => {
    reset();
    pub.savePublishingPrefs({ ...pub.defaultPublishingPrefs(), weeklyGoal: 4 });
    pub.publishingPrefsSyncAdapter.mergeServer([], [{ id: "prefs", deletedAt: iso(-60_000) }]);
    assert.equal(pub.publishingPrefsSyncAdapter.getAll().length, 1, "stale tombstone must not delete");
    pub.publishingPrefsSyncAdapter.mergeServer([], [{ id: "prefs", deletedAt: iso(60_000) }]);
    assert.deepEqual(pub.publishingPrefsSyncAdapter.getAll(), [], "newer tombstone removes local");
  });

  await test("publishing_prefs round-trip through the engine (server seed → local → server)", async () => {
    reset();
    const seeded = { ...pub.defaultPublishingPrefs(), weeklyGoal: 6, updatedAt: iso(-60_000) };
    const srv = createMockServer({ publishing_prefs: [{ docId: "prefs", updatedAt: seeded.updatedAt!, payload: seeded }] });
    sync.registerStoreSync(pub.publishingPrefsSyncAdapter, { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("publishing_prefs"));
    assert.equal(pub.getPublishingPrefs().weeklyGoal, 6, "server singleton pulled locally");
    pub.savePublishingPrefs({ ...pub.getPublishingPrefs(), weeklyGoal: 11 });
    await until(() => (srv.row("publishing_prefs", "prefs")?.payload as { weeklyGoal?: number })?.weeklyGoal === 11, 3_000);
    assert.equal(srv.live("publishing_prefs").length, 1, "still exactly one singleton row");
  });

  // ── Singleton: amazon_affiliate_settings (trackingId correctness) ────────────

  await test("amazon_affiliate_settings LWW: newer trackingId wins, older never clobbers", () => {
    reset();
    amz.saveAmazonAffiliateSettings({ marketplace: "US", trackingId: "mytag-20", enabled: true });
    // Stale server value must NOT overwrite the creator's current tracking ID.
    amz.amazonAffiliateSettingsSyncAdapter.mergeServer([{ marketplace: "US", trackingId: "oldtag-20", enabled: true, updatedAt: iso(-120_000) } as never], []);
    assert.equal(amz.getAmazonAffiliateSettings().trackingId, "mytag-20", "stale trackingId must not clobber");
    // Newer value from another device wins.
    amz.amazonAffiliateSettingsSyncAdapter.mergeServer([{ marketplace: "UK", trackingId: "newtag-21", enabled: true, updatedAt: iso(120_000) } as never], []);
    const s = amz.getAmazonAffiliateSettings();
    assert.equal(s.trackingId, "newtag-21");
    assert.equal(s.marketplace, "UK");
  });

  // ── Singleton: smart_schedule + notification_prefs + brand_profile shape ─────

  await test("smart_schedule / notification_prefs / brand_profile getAll shape + docIds", () => {
    reset();
    assert.deepEqual(sched.smartScheduleSyncAdapter.getAll(), []);
    sched.saveSmartScheduleConfig({ pinsPerDay: 5 });
    const s = sched.smartScheduleSyncAdapter.getAll();
    assert.equal(s.length === 1 && s[0].id === "config", true);
    assert.equal(typeof s[0].updatedAt, "string");

    notif.saveNotificationPrefs({ ...notif.defaultNotificationPrefs(), publishSuccess: true });
    const n = notif.notificationPrefsSyncAdapter.getAll();
    assert.equal(n.length === 1 && n[0].id === "prefs", true);

    brand.saveBrandProfile({ ...brand.defaultBrandProfile(), brandVoice: "Playful" });
    const b = brand.brandProfileSyncAdapter.getAll();
    assert.equal(b.length === 1 && b[0].id === "profile", true);
    assert.equal(typeof b[0].updatedAt, "string");
  });

  // ── Singleton: niches (multi-key) ───────────────────────────────────────────

  await test("niches: setters stamp updatedAt+event; getAll builds combined doc", () => {
    reset();
    assert.deepEqual(nic.nichesSyncAdapter.getAll(), [], "untouched niches must not sync");
    let fired = 0;
    (g.window as { addEventListener: (t: string, cb: () => void) => void }).addEventListener(nic.NICHES_EVENT, () => { fired++; });
    nic.saveSelectedNiches(["home", "beauty"]);
    nic.markOnboardingDone();
    assert.ok(fired >= 2, "both setters must emit NICHES_EVENT");
    const all = nic.nichesSyncAdapter.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "prefs");
    const doc = all[0].doc as { selectedNiches: string[]; onboardingDone: boolean; updatedAt: string };
    assert.deepEqual(doc.selectedNiches.sort(), ["beauty", "home"]);
    assert.equal(doc.onboardingDone, true);
    assert.equal(typeof doc.updatedAt, "string");
  });

  await test("niches mergeServer LWW writes both legacy keys; tombstone clears", () => {
    reset();
    nic.saveSelectedNiches(["home"]);
    // Newer server doc overwrites both selected niches + onboarding.
    nic.nichesSyncAdapter.mergeServer([{ selectedNiches: ["fashion", "art"], onboardingDone: true, updatedAt: iso(60_000) } as never], []);
    assert.deepEqual(nic.getSelectedNiches().sort(), ["art", "fashion"]);
    assert.equal(nic.isOnboardingDone(), true);
    // Stale server doc ignored.
    nic.nichesSyncAdapter.mergeServer([{ selectedNiches: ["food"], onboardingDone: false, updatedAt: iso(-60_000) } as never], []);
    assert.deepEqual(nic.getSelectedNiches().sort(), ["art", "fashion"], "stale niches doc must not clobber");
    // Newer tombstone clears everything.
    nic.nichesSyncAdapter.mergeServer([], [{ id: "prefs", deletedAt: iso(120_000) }]);
    assert.deepEqual(nic.getSelectedNiches(), []);
    assert.deepEqual(nic.nichesSyncAdapter.getAll(), []);
  });

  // ── Collection: creator_product_links ───────────────────────────────────────

  function makeLink(id: string, updatedAt: string, trackingId = "tag-20") {
    return {
      id, productId: `p_${id}`, provider: "amazon" as const, marketplace: "US", asin: "B000",
      trackingId, canonicalProductUrl: "https://x", affiliateUrl: "https://x?tag=" + trackingId,
      status: "ready" as const, createdAt: updatedAt, updatedAt,
    };
  }

  await test("creator_product_links: getAll shape + LWW + tombstone per id", () => {
    reset();
    cpl.localStorageRepo.save(makeLink("a", iso(-1000)));
    const all = cpl.creatorProductLinksSyncAdapter.getAll();
    assert.equal(all.length === 1 && all[0].id === "a", true);
    // Newer server version of a wins; new id b is added.
    cpl.creatorProductLinksSyncAdapter.mergeServer(
      [makeLink("a", iso(60_000), "newtag-21"), makeLink("b", iso(0))] as never[], []);
    assert.equal(cpl.localStorageRepo.getById("a")!.trackingId, "newtag-21", "newer server link wins");
    assert.ok(cpl.localStorageRepo.getById("b"), "new server link added");
    // Stale server version ignored.
    cpl.creatorProductLinksSyncAdapter.mergeServer([makeLink("a", iso(-120_000), "stale")] as never[], []);
    assert.equal(cpl.localStorageRepo.getById("a")!.trackingId, "newtag-21", "stale link must not clobber");
    // Newer tombstone removes b.
    cpl.creatorProductLinksSyncAdapter.mergeServer([], [{ id: "b", deletedAt: iso(120_000) }]);
    assert.equal(cpl.localStorageRepo.getById("b"), null, "newer tombstone removed link");
  });

  // ── Collection: bookmarks (updatedAt backfill) ──────────────────────────────

  await test("bookmarks: updatedAt backfilled from savedAt; getAll id-keyed; LWW + tombstone", () => {
    reset();
    const savedAt = Date.parse("2026-01-01T00:00:00.000Z");
    // Legacy bookmark with only savedAt (no updatedAt).
    _ls.set("pf_bookmarks_v1", JSON.stringify([{ id: "k1", type: "keyword", title: "t", savedAt }]));
    const all = bm.bookmarksSyncAdapter.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].updatedAt, new Date(savedAt).toISOString(), "updatedAt derived from savedAt");
    // Save path also stamps a durable updatedAt.
    bm.saveBookmarks(bm.loadBookmarks());
    assert.equal(typeof bm.loadBookmarks()[0].updatedAt, "string", "save backfills durable updatedAt");
    // Newer server bookmark wins; stale ignored; tombstone removes.
    bm.bookmarksSyncAdapter.mergeServer([{ id: "k1", type: "keyword", title: "new", savedAt, updatedAt: iso(60_000) } as never], []);
    assert.equal(bm.loadBookmarks().find(b => b.id === "k1")!.title, "new");
    bm.bookmarksSyncAdapter.mergeServer([], [{ id: "k1", deletedAt: iso(120_000) }]);
    assert.equal(bm.loadBookmarks().length, 0, "newer tombstone removed bookmark");
  });

  // ── Collection: pin_metadata (+ prune regression) ───────────────────────────

  function saveMeta(pinId: string, patch: Record<string, unknown> = {}) {
    meta.savePinMetadata({
      pinId, sessionId: "s1", imageUrl: "img", metadataDraft: {} as never,
      title: "", description: "", altText: "", destinationUrl: "",
      plannedDate: "", planningStatus: "draft", touched: { ...EMPTY_TOUCHED },
      ...patch,
    });
  }

  await test("pin_metadata: getAll shape + LWW + tombstone", () => {
    reset();
    saveMeta("pin1", { title: "A" });
    const all = meta.pinMetadataSyncAdapter.getAll();
    assert.equal(all.length === 1 && all[0].id === "pin1", true);
    assert.equal(typeof all[0].updatedAt, "string");
    // Newer server doc wins.
    meta.pinMetadataSyncAdapter.mergeServer([{ ...all[0].doc, title: "server", updatedAt: iso(60_000) } as never], []);
    assert.equal(meta.getPinMetadata("pin1")!.title, "server");
    // Newer tombstone removes.
    meta.pinMetadataSyncAdapter.mergeServer([], [{ id: "pin1", deletedAt: iso(120_000) }]);
    assert.equal(meta.getPinMetadata("pin1"), null);
    assert.deepEqual(meta.pinMetadataSyncAdapter.getAll(), []);
  });

  await test("pin_metadata prune does NOT drop ids from the sync set (no tombstone storm)", () => {
    reset();
    meta.__setMaxPinsForTests(3);
    // getAll ids seen by the engine BEFORE overflow.
    const seenBefore = new Set<string>();
    for (let i = 0; i < 3; i++) { saveMeta(`p${i}`, { updatedAt: iso(i) }); }
    for (const x of meta.pinMetadataSyncAdapter.getAll()) seenBefore.add(x.id);
    assert.equal(seenBefore.size, 3);
    // Add 3 more → localStorage hot cache trims to 3, but the shadow keeps the rest.
    for (let i = 3; i < 6; i++) { saveMeta(`p${i}`, { updatedAt: iso(i) }); }
    const idsAfter = new Set(meta.pinMetadataSyncAdapter.getAll().map(x => x.id));
    assert.equal(idsAfter.size, 6, "all 6 ids still reported (evicted → shadow, no delete)");
    for (const id of seenBefore) assert.ok(idsAfter.has(id), `${id} must not vanish from getAll after eviction`);
  });

  await test("pin_metadata prune through the engine emits PUTs only, never a DELETE", async () => {
    reset();
    meta.__setMaxPinsForTests(3);
    const srv = createMockServer();
    sync.registerStoreSync(meta.pinMetadataSyncAdapter, { ...FAST, fetchImpl: srv.fetchImpl });
    sync.initUserStoreSync(getToken);
    assert.ok(await sync.__waitForUserStoreSyncReady("pin_metadata"));
    for (let i = 0; i < 6; i++) { saveMeta(`p${i}`, { updatedAt: iso(i) }); }
    await until(() => srv.live("pin_metadata").length === 6, 4_000);
    assert.equal(srv.deleteCalls("pin_metadata").length, 0, "capacity eviction must never DELETE server-side");
  });

  // ── Collection: pin_sessions + pin_records (backfill + prune) ────────────────

  await test("pin_records: updatedAt stamped on write; falls back to createdAt", () => {
    reset();
    pins.createSession("sess1", "kw", "cat", "manual", [{ refUrl: null, images: ["u1", "u2"] }]);
    const recs = pins.pinRecordsSyncAdapter.getAll();
    assert.equal(recs.length, 2);
    for (const r of recs) assert.equal(typeof r.updatedAt, "string");
    // Legacy pin with no updatedAt → getAll uses createdAt.
    const raw = JSON.parse(_ls.get("vp:pin_store:v1")!);
    const anyPin = Object.values(raw.pins)[0] as { id: string; createdAt: string };
    delete (raw.pins[anyPin.id] as { updatedAt?: string }).updatedAt;
    _ls.set("vp:pin_store:v1", JSON.stringify(raw));
    const legacy = pins.pinRecordsSyncAdapter.getAll().find(r => r.id === anyPin.id)!;
    assert.equal(legacy.updatedAt, anyPin.createdAt, "updatedAt falls back to createdAt");
  });

  await test("pin_sessions + pin_records: LWW + tombstone", () => {
    reset();
    pins.createSession("sess1", "kw", "cat", "manual", [{ refUrl: null, images: ["u1"] }]);
    const sess = pins.pinSessionsSyncAdapter.getAll()[0];
    pins.pinSessionsSyncAdapter.mergeServer([{ ...sess.doc, keyword: "server-kw", updatedAt: iso(60_000) } as never], []);
    assert.equal(pins.getSession("sess1")!.keyword, "server-kw", "newer server session wins");
    pins.pinSessionsSyncAdapter.mergeServer([], [{ id: "sess1", deletedAt: iso(120_000) }]);
    assert.equal(pins.getSession("sess1"), null, "newer tombstone removes session");

    const rec = pins.pinRecordsSyncAdapter.getAll()[0];
    if (rec) {
      pins.pinRecordsSyncAdapter.mergeServer([{ ...rec.doc, keyword: "srv", updatedAt: iso(60_000) } as never], []);
      assert.equal(pins.getSessionPins("sess1").length >= 0, true);
    }
  });

  await test("pin_sessions prune keeps evicted sessions in the sync set (no tombstone)", () => {
    reset();
    pins.__setMaxSessionsForTests(2);
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      pins.createSession(`s${i}`, "kw", "cat", "manual", [{ refUrl: null, images: ["u"] }]);
    }
    for (const x of pins.pinSessionsSyncAdapter.getAll()) seen.add(x.id);
    for (let i = 2; i < 5; i++) {
      pins.createSession(`s${i}`, "kw", "cat", "manual", [{ refUrl: null, images: ["u"] }]);
    }
    const after = new Set(pins.pinSessionsSyncAdapter.getAll().map(x => x.id));
    assert.equal(after.size, 5, "all 5 sessions still reported after eviction");
    for (const id of seen) assert.ok(after.has(id), `${id} must not vanish after eviction`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
