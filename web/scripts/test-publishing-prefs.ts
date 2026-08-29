/**
 * Create Pins Settings preferences — PRD 0826 §12 (multiple-image uploads), §17
 * (default publishing destinations) and the prefill rule those two share.
 *
 * Run: npx tsx scripts/test-publishing-prefs.ts (from web/)
 *
 * What is worth asserting here, and why:
 *
 *  - The sanitizer. `publishingPrefsStore` is read back not only from its own writes
 *    but from whatever the account-sync engine drops into the same localStorage key,
 *    so a half-record written by an older or newer client reaches draft creation. A
 *    destination with no `socialConnectionId` is not "a default with a missing field";
 *    it is content pinned to nothing, which only surfaces as a publish failure days
 *    later. It must degrade to "no default" on the way in.
 *
 *  - The prefill boundary. The load-time effect this feature replaces rewrote every
 *    boardless draft on the board each time Create Pins mounted. §17 is explicit that
 *    a default "only prefills NEW content; never rewrites existing Draft/Scheduled/
 *    Posted", so the regression to guard is not "does the prefill work" but "can
 *    changing the default ever touch a draft that already exists". The last test
 *    creates a draft, changes the defaults, creates another, and asserts the first
 *    is byte-identical.
 *
 *  - Connected-only filtering, including the unknown case. `resolveDefaultDestinations`
 *    is given `null` when the connections cache has not loaded. Seeding from an
 *    unverified default can pin new content to an account that has since been
 *    disconnected; no prefill is recoverable, a wrong one is not.
 *
 * Browser globals are stubbed BEFORE the modules are imported, because both stores
 * capture `typeof window` behaviour at call time and read localStorage on first load.
 */

import assert from "node:assert";

let passed = 0, failed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  OK ${name}`); })
    .catch((e: unknown) => {
      failed++;
      console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? String(e)}`);
    });
}

// ── Browser stubs (installed before any module import) ────────────────────────

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

const storage = new MemoryStorage();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = storage;
g.window = { localStorage: storage, dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
g.Event = class { constructor(public type: string) {} };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prefsStore = require("../src/lib/publishingPrefsStore") as typeof import("../src/lib/publishingPrefsStore");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pinDraftStore = require("../src/lib/pinDraftStore") as typeof import("../src/lib/pinDraftStore");

const {
  LEGACY_MULTI_UPLOAD_KEY,
  defaultPublishingPrefs,
  getPublishingPrefs,
  migrateMultiUploadMode,
  patchPublishingPrefs,
  resolveDefaultDestinations,
  sanitizeDefaultDestinations,
  savePublishingPrefs,
} = prefsStore;

const PREFS_KEY = "vp:publishing_prefs:v1";

/** Only the prefs key is reset; pinDraftStore keeps an in-memory mirror of its own
 *  store that a localStorage wipe would not clear, and every draft test creates its
 *  own draft and asserts on that id, so leftovers are harmless. */
function reset(): void {
  storage.removeItem(PREFS_KEY);
  storage.removeItem(LEGACY_MULTI_UPLOAD_KEY);
}

async function main(): Promise<void> {

  // ── §12 defaults + sanitizer ─────────────────────────────────────────────────

  await test("defaults: multi-upload asks, and there are no default destinations", () => {
    reset();
    const d = defaultPublishingPrefs();
    assert.equal(d.multiUploadDefault, "ask");
    assert.deepEqual(d.defaultDestinations, []);
    // A user who has never opened Settings reads the same thing.
    assert.equal(getPublishingPrefs().multiUploadDefault, "ask");
  });

  await test("read: an unrecognised stored mode falls back to ask rather than being trusted", () => {
    reset();
    storage.setItem(PREFS_KEY, JSON.stringify({ multiUploadDefault: "whatever" }));
    assert.equal(getPublishingPrefs().multiUploadDefault, "ask");
  });

  await test("read: new fields survive a round trip (they are not dropped by the whitelist)", () => {
    reset();
    savePublishingPrefs({
      ...defaultPublishingPrefs(),
      multiUploadDefault: "together",
      defaultDestinations: [{ provider: "pinterest", socialConnectionId: "c1", boardId: "b1", boardName: "Kitchen" }],
    });
    const back = getPublishingPrefs();
    assert.equal(back.multiUploadDefault, "together");
    assert.deepEqual(back.defaultDestinations, [
      { provider: "pinterest", socialConnectionId: "c1", boardId: "b1", boardName: "Kitchen" },
    ]);
  });

  await test("sanitizer: entries with no account, or an unknown platform, are dropped", () => {
    const out = sanitizeDefaultDestinations([
      { provider: "pinterest", socialConnectionId: "c1" },
      { provider: "pinterest", socialConnectionId: "   " },  // whitespace is not an id
      { provider: "myspace",   socialConnectionId: "c2" },   // not a platform we publish to
      { provider: "instagram" },                              // no account at all
      "nonsense",
      null,
    ]);
    assert.deepEqual(out, [{ provider: "pinterest", socialConnectionId: "c1" }]);
  });

  await test("sanitizer: SEVERAL accounts on one platform are all kept (WS-B3)", () => {
    // Each account is its own destination, so new content may default to both. Keying
    // the dedupe on the provider silently discarded the second account.
    const out = sanitizeDefaultDestinations([
      { provider: "pinterest", socialConnectionId: "c1", boardId: "b1" },
      { provider: "pinterest", socialConnectionId: "c2", boardId: "b2" },
      { provider: "instagram", socialConnectionId: "ig1" },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out.filter(d => d.provider === "pinterest").map(d => d.boardId), ["b1", "b2"],
      "each Pinterest default keeps its own board");
  });

  await test("sanitizer: the same ACCOUNT twice still collapses to one", () => {
    const out = sanitizeDefaultDestinations([
      { provider: "pinterest", socialConnectionId: "c1", boardId: "b1" },
      { provider: "pinterest", socialConnectionId: "c1", boardId: "b2" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].boardId, "b2", "the last entry for that account wins");
  });

  await test("createBoardDraft seeds every default, and mirrors the FIRST Pinterest one", () => {
    const draft = pinDraftStore.createBoardDraft({
      imageUrl: "https://cdn.test/x.jpg",
      source: "uploaded_image",
      defaultDestinations: [
        { provider: "pinterest", socialConnectionId: "c1", boardId: "b1", boardName: "One" },
        { provider: "pinterest", socialConnectionId: "c2", boardId: "b2", boardName: "Two" },
        { provider: "instagram", socialConnectionId: "ig1" },
      ],
    });
    assert.equal(draft.scheduledDestinations?.length, 3, "all three defaults seed the new Content");
    assert.equal(draft.targetConnectionId, "c1");
    assert.equal(draft.boardId, "b1", "the legacy mirror follows the first Pinterest default");
  });

  // ── §12 migration off the old browser key ────────────────────────────────────

  await test("migration: an answer given before this feature is adopted, then the key is removed", () => {
    reset();
    storage.setItem(LEGACY_MULTI_UPLOAD_KEY, "separate");
    const after = migrateMultiUploadMode();
    assert.equal(after.multiUploadDefault, "separate");
    assert.equal(storage.getItem(LEGACY_MULTI_UPLOAD_KEY), null, "the old key must not linger");
    assert.equal(getPublishingPrefs().multiUploadDefault, "separate", "and it must be persisted");
  });

  await test("migration: a Settings answer wins over a stale browser key", () => {
    reset();
    patchPublishingPrefs({ multiUploadDefault: "together" });
    storage.setItem(LEGACY_MULTI_UPLOAD_KEY, "separate");
    assert.equal(migrateMultiUploadMode().multiUploadDefault, "together");
    assert.equal(storage.getItem(LEGACY_MULTI_UPLOAD_KEY), null);
  });

  await test("migration: idempotent, and a junk value is discarded rather than adopted", () => {
    reset();
    storage.setItem(LEGACY_MULTI_UPLOAD_KEY, "sideways");
    assert.equal(migrateMultiUploadMode().multiUploadDefault, "ask");
    assert.equal(migrateMultiUploadMode().multiUploadDefault, "ask");
  });

  await test("patch: writing one field does not revert another surface's write", () => {
    reset();
    patchPublishingPrefs({ multiUploadDefault: "together" });
    patchPublishingPrefs({ weeklyGoal: 9 });
    const back = getPublishingPrefs();
    assert.equal(back.multiUploadDefault, "together");
    assert.equal(back.weeklyGoal, 9);
  });

  // ── §17 connected-only resolution ────────────────────────────────────────────

  await test("resolve: only accounts that are still connected are offered as defaults", () => {
    reset();
    savePublishingPrefs({
      ...defaultPublishingPrefs(),
      defaultDestinations: [
        { provider: "pinterest", socialConnectionId: "live", boardId: "b1" },
        { provider: "instagram", socialConnectionId: "gone" },
      ],
    });
    const out = resolveDefaultDestinations(new Set(["live"]));
    assert.equal(out.length, 1);
    assert.equal(out[0].socialConnectionId, "live");
  });

  await test("resolve: unknown connections (null) yield nothing, not an unverified guess", () => {
    reset();
    savePublishingPrefs({
      ...defaultPublishingPrefs(),
      defaultDestinations: [{ provider: "pinterest", socialConnectionId: "c1" }],
    });
    assert.deepEqual(resolveDefaultDestinations(null), []);
  });

  // ── §17 prefill: new content only ────────────────────────────────────────────

  const PIN_DEFAULT = [{
    provider: "pinterest", socialConnectionId: "conn-1",
    boardId: "board-1", boardName: "Kitchen", accountLabel: "@shop",
  }];

  await test("prefill: new content adopts the default, mirrored into the legacy Pinterest fields", () => {
    reset();
    const draft = pinDraftStore.createBoardDraft({
      imageUrl: "https://example.test/a.png", source: "uploaded_image",
      defaultDestinations: PIN_DEFAULT,
    });
    assert.equal(draft.scheduledDestinations?.length, 1);
    const dest = draft.scheduledDestinations![0];
    assert.equal(dest.provider, "pinterest");
    assert.equal(dest.socialConnectionId, "conn-1");
    assert.equal(dest.boardId, "board-1");
    assert.ok(dest.capturedAt, "intent must record when it was captured");
    // The due-time worker and un-migrated read paths must see the same destination.
    assert.equal(draft.boardId, "board-1");
    assert.equal(draft.boardName, "Kitchen");
    assert.equal(draft.targetConnectionId, "conn-1");
    assert.equal(draft.targetAccountLabel, "@shop");
  });

  await test("prefill: no defaults leaves new content boardless and without intent", () => {
    reset();
    const draft = pinDraftStore.createBoardDraft({
      imageUrl: "https://example.test/b.png", source: "uploaded_image",
    });
    assert.equal(draft.scheduledDestinations, undefined);
    assert.equal(draft.boardId, "");
    assert.equal(draft.targetConnectionId, undefined);
  });

  await test("prefill: changing the default NEVER rewrites content that already exists", () => {
    reset();
    const existing = pinDraftStore.createBoardDraft({
      imageUrl: "https://example.test/c.png", source: "uploaded_image",
      defaultDestinations: PIN_DEFAULT,
    });
    const snapshot = JSON.stringify(existing);

    // The merchant now points their default at a different account and board.
    const changed = [{
      provider: "pinterest", socialConnectionId: "conn-2",
      boardId: "board-9", boardName: "Garden", accountLabel: "@other",
    }];
    const fresh = pinDraftStore.createBoardDraft({
      imageUrl: "https://example.test/d.png", source: "uploaded_image",
      defaultDestinations: changed,
    });

    assert.equal(fresh.boardId, "board-9", "new content follows the new default");
    assert.equal(
      JSON.stringify(pinDraftStore.getDraft(existing.id)),
      snapshot,
      "the earlier draft must be untouched — this is the §17 regression the load-time prefill caused",
    );
  });

  await test("prefill: a boardless default still records the account (board stays unset)", () => {
    reset();
    const draft = pinDraftStore.createBoardDraft({
      imageUrl: "https://example.test/e.png", source: "uploaded_image",
      defaultDestinations: [{ provider: "pinterest", socialConnectionId: "conn-3" }],
    });
    assert.equal(draft.targetConnectionId, "conn-3");
    assert.equal(draft.boardId, "", "no board was chosen, so none is invented");
    assert.equal(draft.scheduledDestinations![0].boardId, undefined);
  });

  await test("prefill: a non-Pinterest default does not populate the Pinterest fields", () => {
    reset();
    const draft = pinDraftStore.createBoardDraft({
      imageUrl: "https://example.test/f.png", source: "uploaded_image",
      defaultDestinations: [{ provider: "instagram", socialConnectionId: "ig-1", accountLabel: "@ig" }],
    });
    assert.equal(draft.scheduledDestinations?.length, 1);
    assert.equal(draft.scheduledDestinations![0].provider, "instagram");
    assert.equal(draft.boardId, "");
    assert.equal(draft.targetConnectionId, undefined);
  });

}

void main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
