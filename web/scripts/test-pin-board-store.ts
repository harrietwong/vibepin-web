/**
 * Phase‑0 unit tests for the Create Pins board data layer (studioBoardV2).
 * Run: npx tsx scripts/test-pin-board-store.ts
 *
 * Covers: createBoardDraft idempotency (key, not imageUrl), duplicateDraft reset,
 * lifecycle order, readiness, source badge, board selectors, stable snapshot, and
 * the Weekly‑Plan leak guard (board uploads stay out of the plan tray).
 */

import assert from "node:assert";

// Minimal window + localStorage shim so the localStorage‑backed store runs in node.
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

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

async function main() {
  const store = await import("../src/lib/pinDraftStore");
  const life = await import("../src/lib/studio/pinLifecycle");

  // The store keeps an in-memory session cache (source of truth) above
  // localStorage — reset both between cases.
  function reset() { mem.clear(); store.__resetMemoryCacheForTests(); }

  await test("createBoardDraft: sets source, no plan/schedule fields", () => {
    reset();
    const d = store.createBoardDraft({ imageUrl: "https://x/a.png", source: "uploaded_image", title: "T" });
    assert.equal(d.source, "uploaded_image");
    assert.equal(d.title, "T");
    assert.equal(d.scheduledDate, "");
    assert.ok(!d.addedToPlanAt, "upload must not be added to plan");
    assert.equal(store.isBoardSource(d), true);
  });

  await test("createBoardDraft: dedup by explicit idempotencyKey ONLY", () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/same.png", source: "uploaded_image", idempotencyKey: "batch:0" });
    const b = store.createBoardDraft({ imageUrl: "https://x/same.png", source: "uploaded_image", idempotencyKey: "batch:0" });
    assert.equal(a.id, b.id, "same key → same draft");
    // Same imageUrl, DIFFERENT key → a NEW draft (not deduped by imageUrl).
    const c = store.createBoardDraft({ imageUrl: "https://x/same.png", source: "uploaded_image", idempotencyKey: "batch:1" });
    assert.notEqual(c.id, a.id, "different key → new draft even if imageUrl matches");
    // No key → always new.
    const e = store.createBoardDraft({ imageUrl: "https://x/same.png", source: "uploaded_image" });
    const f = store.createBoardDraft({ imageUrl: "https://x/same.png", source: "uploaded_image" });
    assert.notEqual(e.id, f.id, "no key → always a new draft");
  });

  await test("duplicateDraft: new id, cleared lifecycle/schedule/publish", () => {
    reset();
    const src = store.createBoardDraft({ imageUrl: "https://x/d.png", source: "uploaded_image", title: "Orig", tags: ["a"] });
    store.updateDraft(src.id, { postedAt: "2026-01-01T00:00:00Z", remotePinId: "rp1", remotePinUrl: "https://www.pinterest.com/pin/rp1/", scheduledDate: "2026-02-02", addedToPlanAt: "2026-01-01T00:00:00Z" });
    store.updateDraft(src.id, { publishError: "boom" });
    const dup = store.duplicateDraft(src.id)!;
    assert.notEqual(dup.id, src.id);
    assert.equal(dup.title, "Orig");
    assert.deepEqual(dup.tags, ["a"]);
    for (const f of ["postedAt", "remotePinId", "remotePinUrl", "publishError", "plannedAt"] as const) {
      assert.ok(!dup[f], `duplicate must clear ${f}`);
    }
    assert.equal(dup.scheduledDate, "");
    assert.ok(!dup.addedToPlanAt, "duplicate must clear addedToPlanAt");
  });

  await test("updateDraft: remotePinUrl round-trips through the store (persist + reload)", () => {
    reset();
    const d = store.createBoardDraft({ imageUrl: "https://x/url.png", source: "uploaded_image" });
    assert.ok(!d.remotePinUrl, "remotePinUrl absent until published");
    store.updateDraft(d.id, { postedAt: "2026-01-01T00:00:00Z", remotePinId: "rp9", remotePinUrl: "https://www.pinterest.com/pin/rp9/" });
    assert.equal(store.getDraft(d.id)!.remotePinUrl, "https://www.pinterest.com/pin/rp9/");
    // Persists across a fresh read from the same (localStorage-shimmed) store.
    const reloaded = store.getAllDrafts().find(x => x.id === d.id);
    assert.equal(reloaded?.remotePinUrl, "https://www.pinterest.com/pin/rp9/", "remotePinUrl must persist");
  });

  await test("duplicateDraft: AI keeps parentDraftId; uploaded gets none", () => {
    reset();
    const ai = store.createBoardDraft({ imageUrl: "https://x/ai.png", source: "ai_generated_from_upload", parentDraftId: "parent1" });
    assert.equal(store.duplicateDraft(ai.id)!.parentDraftId, "parent1");
    const up = store.createBoardDraft({ imageUrl: "https://x/up.png", source: "uploaded_image", parentDraftId: "shouldDrop" });
    assert.ok(!store.duplicateDraft(up.id)!.parentDraftId, "uploaded duplicate gets no parent");
  });

  await test("lifecycle: generating/posted > failed > scheduled > unscheduled", () => {
    reset();
    const d = store.createBoardDraft({ imageUrl: "https://x/l.png", source: "uploaded_image" });
    assert.equal(life.getPinLifecycle(store.getDraft(d.id)!), "unscheduled");
    // scheduled
    store.updateDraft(d.id, { scheduledDate: "2026-03-03" });
    assert.equal(life.getPinLifecycle(store.getDraft(d.id)!), "scheduled");
    // failed beats scheduled
    store.updateDraft(d.id, { publishError: "x" });
    assert.equal(life.getPinLifecycle(store.getDraft(d.id)!), "failed");
    // posted beats failed
    store.updateDraft(d.id, { remotePinId: "rp" });
    assert.equal(life.getPinLifecycle(store.getDraft(d.id)!), "posted");
    // generating (AI pin mid-generation) wins over everything
    const g = store.createBoardDraft({ imageUrl: "https://x/g.png", source: "ai_generated_from_upload" });
    store.updateDraft(g.id, { generationStatus: "generating" });
    assert.equal(life.getPinLifecycle(store.getDraft(g.id)!), "generating");
  });

  await test("in‑flight registry: begin dedupes, end releases, version bumps", () => {
    const v0 = life.getInFlightVersion();
    assert.equal(life.beginPublish("z1"), true);
    assert.equal(life.beginPublish("z1"), false, "second begin is rejected (dedupe)");
    assert.equal(life.isPublishInFlight("z1"), true);
    assert.ok(life.getInFlightVersion() > v0);
    life.endPublish("z1");
    assert.equal(life.isPublishInFlight("z1"), false);
  });

  await test("source + status badges are separate", () => {
    reset();
    const up = store.createBoardDraft({ imageUrl: "https://x/s.png", source: "uploaded_image", title: "t", description: "d" });
    assert.deepEqual(life.getSourceBadge(store.getDraft(up.id)!), { label: "Uploaded" });
    const ai = store.createBoardDraft({ imageUrl: "https://x/s2.png", source: "ai_generated_from_upload" });
    assert.deepEqual(life.getSourceBadge(store.getDraft(ai.id)!), { label: "AI Generated" });
    // status badge is derived independently (missing fields never make it "need details")
    assert.equal(life.getStatusBadge(store.getDraft(up.id)!).lifecycle, "unscheduled");
  });

  await test("selectors: board excludes archived; planned = added|dated", () => {
    reset();
    const a = store.createBoardDraft({ imageUrl: "https://x/b1.png", source: "uploaded_image" });
    const b = store.createBoardDraft({ imageUrl: "https://x/b2.png", source: "uploaded_image" });
    store.archiveDraft(b.id);
    const boardIds = store.getBoardDrafts().map(d => d.id);
    assert.ok(boardIds.includes(a.id) && !boardIds.includes(b.id), "archived excluded from board");
    assert.equal(store.getBoardDrafts({ includeArchived: true }).length, 2);
    // planned
    assert.equal(store.getPlannedDrafts().length, 0, "no upload is planned by default");
    store.updateDraft(a.id, { addedToPlanAt: "2026-01-01T00:00:00Z" });
    assert.equal(store.getPlannedDrafts().some(d => d.id === a.id), true);
  });

  await test("Weekly‑Plan guard: board upload stays OUT of the plan tray", () => {
    reset();
    // Board upload (no date, not added) → must NOT appear in getUnaddedGeneratedDrafts.
    const up = store.createBoardDraft({ imageUrl: "https://x/g1.png", source: "uploaded_image", category: "diy" });
    assert.equal(store.getUnaddedGeneratedDrafts().some(d => d.id === up.id), false, "board upload leaked into plan tray");
    // Legacy generated draft (non‑board source) → still shows in the tray.
    const legacy = store.createDraft({ imageUrl: "https://x/g2.png", keyword: "kw", category: "diy" });
    assert.equal(store.getUnaddedGeneratedDrafts().some(d => d.id === legacy.id), true, "legacy tray behavior preserved");
    // Once added to plan, the upload IS planned.
    store.markAddedToWeeklyPlan(up.id);
    assert.equal(store.getPlannedDrafts().some(d => d.id === up.id), true);
  });

  await test("getSnapshot: stable reference until a write", () => {
    reset();
    const s1 = store.getSnapshot();
    const s2 = store.getSnapshot();
    assert.strictEqual(s1, s2, "same reference between writes");
    store.createBoardDraft({ imageUrl: "https://x/snap.png", source: "uploaded_image" });
    const s3 = store.getSnapshot();
    assert.notStrictEqual(s2, s3, "new reference after a write");
  });

  await test("persist failure: edits survive in memory, failure observable, retry recovers", () => {
    reset();
    const d = store.createBoardDraft({ imageUrl: "https://x/quota.png", source: "uploaded_image", title: "Before" });
    assert.equal(store.hasPersistFailure(), false, "healthy storage → no failure");

    // Simulate quota exhaustion: every setItem throws.
    const ls = (globalThis as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage;
    const realSetItem = ls.setItem;
    ls.setItem = () => { throw new Error("QuotaExceededError"); };

    const updated = store.updateDraft(d.id, { title: "After quota failure" });
    assert.ok(updated, "update returns the draft");
    assert.equal(store.hasPersistFailure(), true, "failed persist is observable");
    // The edit must NOT be lost: reads reflect the in-memory state.
    assert.equal(store.getDraft(d.id)?.title, "After quota failure", "edit survives in memory");
    // Retry while storage is still broken stays failed.
    assert.equal(store.retryPersist(), false, "retry fails while storage is broken");
    assert.equal(store.hasPersistFailure(), true);

    // Storage recovers → retry succeeds and the durable copy matches memory.
    ls.setItem = realSetItem;
    assert.equal(store.retryPersist(), true, "retry succeeds after recovery");
    assert.equal(store.hasPersistFailure(), false);
    const raw = mem.get("vp:pin_drafts:v1");
    assert.ok(raw && raw.includes("After quota failure"), "durable copy contains the edit after retry");
  });

  // ── Board filter: an in-flight generation must never be filtered out ──────────
  // Regression guard. Filters used to be strict lifecycle equality, and
  // "generating" matches none of the four resting buckets — so the moment a user
  // hit Generate, the new card vanished from the default ("unscheduled") board and
  // the product's core button looked dead until the image came back.
  // End-to-end over the REAL pipeline the board hook uses to build `items`:
  //   createBoardDraft → isBoardSource → getPinLifecycle → matchesFilter
  // so this cannot pass on a hand-made fixture while the real flow still hides the card.
  await test("board filter: a just-generated Pin is visible on the DEFAULT board", async () => {
    reset();
    const { matchesFilter } = await import("../src/hooks/usePinBoardDrafts");
    const parent = store.createBoardDraft({ imageUrl: "https://x/p.png", source: "uploaded_image", title: "Parent" });
    // Exactly what StudioBoard does when the user hits Generate.
    const gen = store.createBoardDraft({
      imageUrl: parent.imageUrl,
      source: "ai_generated_from_upload",
      idempotencyKey: "gen:req1:0",
      generationStatus: "generating",
      parentDraftId: parent.id,
    });

    const fresh = store.getDraft(gen.id)!;
    assert.ok(store.isBoardSource(fresh), "generating Pin must be a board-source draft");
    assert.equal(life.getPinLifecycle(fresh), "generating");

    const item = { draft: fresh, lifecycle: life.getPinLifecycle(fresh) };

    // Visible where it belongs: the board lands on "unscheduled" by default, so the
    // card must survive that filter or Generate looks like it did nothing.
    assert.ok(matchesFilter(item, "unscheduled"),
      "generating Pin hidden on the default board — Generate looks like it did nothing");
    assert.ok(matchesFilter(item, "all"), "generating Pin missing from All");

    // ...and nowhere else. Scheduled / Posted / Failed are claims about a SETTLED
    // outcome; an in-flight Pin has none yet, so listing it there would be a lie.
    for (const f of ["scheduled", "posted", "failed"] as const) {
      assert.ok(!matchesFilter(item, f), `generating Pin must NOT appear under "${f}"`);
    }
  });

  await test("board filter: resting lifecycles still match only their own bucket", async () => {
    const { matchesFilter } = await import("../src/hooks/usePinBoardDrafts");
    for (const l of ["unscheduled", "scheduled", "posted", "failed"] as const) {
      const item = { draft: { id: l } as never, lifecycle: l };
      assert.ok(matchesFilter(item, l), `${l} should match its own filter`);
      assert.ok(matchesFilter(item, "all"), `${l} should match "all"`);
      for (const other of ["unscheduled", "scheduled", "posted", "failed"] as const) {
        if (other === l) continue;
        assert.ok(!matchesFilter(item, other), `${l} must NOT leak into the "${other}" filter`);
      }
    }
  });

  console.log(`\nPin board store: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
