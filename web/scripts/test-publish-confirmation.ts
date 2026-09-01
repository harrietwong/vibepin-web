/** MC-A31..A35: immediate publish is impossible without an exact user-confirmed snapshot. */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
  key(index: number) { return Array.from(this.map.keys())[index] ?? null; }
  get length() { return this.map.size; }
}
const storage = new FakeStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };

/* eslint-disable @typescript-eslint/no-require-imports */
const pinDraftStore = require("../src/lib/pinDraftStore") as typeof import("../src/lib/pinDraftStore");
const { publishContent } = require("../src/lib/studio/publishContent") as typeof import("../src/lib/studio/publishContent");
const { buildPublishConfirmation, confirmPublishSnapshot, explicitPublishDestinations } = require("../src/lib/studio/publishConfirmation") as typeof import("../src/lib/studio/publishConfirmation");
const { contentDestinations } = require("../src/lib/contentDraftModel") as typeof import("../src/lib/contentDraftModel");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { PinDraft } from "../src/lib/pinDraftStore";
import type { PublishContentDeps } from "../src/lib/studio/publishContent";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  OK   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${(error as Error).message}`); }
}

const NOW = "2026-09-01T12:00:00.000Z";
function seed(opts: { destinations?: PinDraft["scheduledDestinations"]; legacyOnly?: boolean } = {}): PinDraft {
  storage.clear();
  const created = pinDraftStore.createBoardDraft({ imageUrl: "https://cdn.test/cover.jpg", source: "uploaded_image", title: "Exact title", description: "Exact caption", altText: "Exact alt", destinationUrl: "https://shop.test/item" });
  return pinDraftStore.updateDraft(created.id, {
    boardId: "legacy-board",
    targetConnectionId: "legacy-account",
    scheduledDestinations: opts.legacyOnly ? [] : (opts.destinations ?? [
      { provider: "pinterest", socialConnectionId: "pin-account", accountLabel: "vibepinvibepin", boardId: "board-42", boardName: "Launches", capturedAt: NOW },
      { provider: "instagram", socialConnectionId: "ig-account", accountLabel: "sensalab__", capturedAt: NOW },
      { provider: "facebook", socialConnectionId: "fb-page", accountLabel: "vibepin.co", capturedAt: NOW },
    ]),
  })!;
}

function deps(options: { ambiguous?: boolean } = {}) {
  const pinCalls: Array<Record<string, unknown>> = [];
  const socialCalls: Array<Record<string, unknown>> = [];
  const value: Partial<PublishContentDeps> = {
    now: () => NOW,
    publishPin: (async (input: Record<string, unknown>) => {
      pinCalls.push(input);
      if (options.ambiguous) throw new Error("socket closed");
      return { ok: true, pin: { id: "remote-pin", url: "https://pinterest.test/pin/remote-pin" }, board: { id: "board-42", name: "Launches" }, connectionId: "pin-account" };
    }) as unknown as PublishContentDeps["publishPin"],
    publishToSocial: (async (input: { destinations: Array<{ provider: string; socialConnectionId?: string | null }> }) => {
      socialCalls.push(input as unknown as Record<string, unknown>);
      return { ok: true, jobId: "job-1", status: "published", destinations: input.destinations.map(destination => ({ provider: destination.provider, status: "published", externalPostId: `${destination.provider}-remote`, externalPostUrl: `https://${destination.provider}.test/post`, accountName: destination.socialConnectionId, error: null })) };
    }) as PublishContentDeps["publishToSocial"],
  };
  return { value, pinCalls, socialCalls };
}

async function main() {
  console.log("\n=== confirmation boundary ===");
  await test("no receipt means zero provider/API calls", async () => {
    const draft = seed(); const fake = deps();
    const result = await publishContent(draft.id, { deps: fake.value });
    assert.equal(result.blocked, "confirmation_required");
    assert.equal(fake.pinCalls.length + fake.socialCalls.length, 0);
  });
  await test("legacy board/account never becomes a default Pinterest destination", async () => {
    const draft = seed({ legacyOnly: true }); const fake = deps();
    assert.equal(contentDestinations(draft).length, 1, "legacy result projection remains available for historical records");
    assert.equal(explicitPublishDestinations(draft).length, 0, "legacy projection is not a saved publishing decision");
    const snapshot = buildPublishConfirmation(draft);
    assert.equal(snapshot.publishableDestinations.length, 0);
    assert(snapshot.blockers.some(item => item.code === "no_destinations"));
    const result = await publishContent(draft.id, { confirmation: confirmPublishSnapshot(snapshot, NOW), deps: fake.value });
    assert.equal(result.blocked, "invalid_confirmation");
    assert.equal(fake.pinCalls.length + fake.socialCalls.length, 0);
  });
  await test("confirmed exact account/Board/content is the dispatch payload", async () => {
    const draft = seed(); const fake = deps();
    const snapshot = buildPublishConfirmation(draft, { onlyPending: false });
    const result = await publishContent(draft.id, { confirmation: confirmPublishSnapshot(snapshot, NOW), destinations: snapshot.publishableDestinations, deps: fake.value });
    assert.equal(result.published.length, 3);
    assert.equal(fake.pinCalls[0].connectionId, "pin-account");
    assert.equal(fake.pinCalls[0].boardId, "board-42");
    assert.equal(fake.pinCalls[0].title, "Exact title");
    const social = fake.socialCalls[0] as { destinations: Array<{ socialConnectionId: string }> };
    assert.deepEqual(social.destinations.map(item => item.socialConnectionId), ["ig-account", "fb-page"]);
  });
  await test("a disabled destination is recorded but never dispatched while valid siblings publish", async () => {
    const draft = seed({ destinations: [
      { provider: "pinterest", socialConnectionId: "pin-account", accountLabel: "vibepinvibepin", capturedAt: NOW },
      { provider: "instagram", socialConnectionId: "ig-account", accountLabel: "sensalab__", capturedAt: NOW },
    ] });
    const fake = deps(); const snapshot = buildPublishConfirmation(draft, { onlyPending: false });
    assert(snapshot.blockers.some(item => item.code === "missing_board"));
    const result = await publishContent(draft.id, { confirmation: confirmPublishSnapshot(snapshot, NOW), onlyPending: false, deps: fake.value });
    assert.equal(fake.pinCalls.length, 0, "missing Board must prevent every Pinterest provider call");
    assert.equal(fake.socialCalls.length, 1, "the exact valid Instagram sibling still dispatches");
    assert(result.failed.some(item => item.provider === "pinterest" && item.errorCode === "missing_board"));
    assert(result.published.some(item => item.provider === "instagram"));
  });
  await test("malformed receipt fails closed", async () => {
    const draft = seed(); const fake = deps(); const snapshot = buildPublishConfirmation(draft);
    const receipt = { ...confirmPublishSnapshot(snapshot, NOW), intentId: `${snapshot.intentId}-tampered` };
    const result = await publishContent(draft.id, { confirmation: receipt, deps: fake.value });
    assert.equal(result.blocked, "invalid_confirmation");
    assert.equal(fake.pinCalls.length + fake.socialCalls.length, 0);
  });
  await test("tampered publishable subset and caller retry widening fail closed", async () => {
    const draft = seed(); const fake = deps(); const snapshot = buildPublishConfirmation(draft, { onlyPending: true });
    const missingDestination = confirmPublishSnapshot({ ...snapshot, publishableDestinations: snapshot.publishableDestinations.slice(0, 1) }, NOW);
    const malformed = await publishContent(draft.id, { confirmation: missingDestination, onlyPending: true, deps: fake.value });
    assert.equal(malformed.blocked, "invalid_confirmation");
    const widened = await publishContent(draft.id, { confirmation: confirmPublishSnapshot(snapshot, NOW), onlyPending: false, deps: fake.value });
    assert.equal(widened.blocked, "invalid_confirmation");
    assert.equal(fake.pinCalls.length + fake.socialCalls.length, 0);
  });
  await test("content/destination change after opening makes the receipt stale", async () => {
    const draft = seed(); const fake = deps(); const receipt = confirmPublishSnapshot(buildPublishConfirmation(draft), NOW);
    await new Promise(resolve => setTimeout(resolve, 2));
    pinDraftStore.updateDraft(draft.id, { title: "Changed after confirmation" });
    const result = await publishContent(draft.id, { confirmation: receipt, deps: fake.value });
    assert.equal(result.blocked, "invalid_confirmation");
    assert.equal(fake.pinCalls.length + fake.socialCalls.length, 0);
  });
  await test("destination replacement after opening is also stale", async () => {
    const draft = seed(); const fake = deps(); const receipt = confirmPublishSnapshot(buildPublishConfirmation(draft), NOW);
    await new Promise(resolve => setTimeout(resolve, 2));
    pinDraftStore.updateDraft(draft.id, { scheduledDestinations: [{ provider: "pinterest", socialConnectionId: "other-account", boardId: "other-board", capturedAt: NOW }] });
    const result = await publishContent(draft.id, { confirmation: receipt, deps: fake.value });
    assert.equal(result.blocked, "invalid_confirmation");
    assert.equal(fake.pinCalls.length + fake.socialCalls.length, 0);
  });
  await test("duplicate confirmation never dispatches twice and keeps a stable intent", async () => {
    const draft = seed(); const fake = deps(); const snapshot = buildPublishConfirmation(draft, { onlyPending: false }); const receipt = confirmPublishSnapshot(snapshot, NOW);
    await publishContent(draft.id, { confirmation: receipt, deps: fake.value });
    const replay = await publishContent(draft.id, { confirmation: receipt, deps: fake.value });
    assert.equal(fake.pinCalls.length, 1);
    // Store timestamps have millisecond resolution. If the first publish finishes in
    // the same millisecond as the snapshot, receipt validation can still match; the
    // completed intent must then resolve as an idempotent no-op. A later timestamp
    // invalidates the receipt instead. Both paths are safe only when neither dispatches.
    assert(
      replay.blocked === "invalid_confirmation" || replay.nothingToRetry === true,
      "a duplicate confirmation must fail closed or resolve as a completed no-op",
    );
    assert.equal(buildPublishConfirmation(pinDraftStore.getDraft(draft.id)!, { onlyPending: true }).intentId, snapshot.intentId);
  });
  await test("ambiguous delivery locks resubmit under the same intent", async () => {
    const draft = seed({ destinations: [{ provider: "pinterest", socialConnectionId: "pin-account", boardId: "board-42", capturedAt: NOW }] });
    const fake = deps({ ambiguous: true }); const snapshot = buildPublishConfirmation(draft);
    const first = await publishContent(draft.id, { confirmation: confirmPublishSnapshot(snapshot, NOW), deps: fake.value });
    assert.equal(first.recoveryPending, true);
    assert.equal(pinDraftStore.getDraft(draft.id)?.publishIntentStatus, "recovery_pending");
    const retry = buildPublishConfirmation(pinDraftStore.getDraft(draft.id)!, { onlyPending: true });
    const second = await publishContent(draft.id, { confirmation: confirmPublishSnapshot(retry, NOW), deps: fake.value });
    assert.equal(second.blocked, "recovery_pending");
    assert.equal(fake.pinCalls.length, 1);
  });

  console.log("\n=== every immediate entry point uses the receipt ===");
  const sources = ["src/components/studio/StudioBoard.tsx", "src/components/studio/BatchEditDrawer.tsx", "src/components/plan/DraftDetailsDrawer.tsx"];
  await test("all product publishContent call sites pass confirmation", () => {
    for (const path of sources) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      for (const match of source.matchAll(/await\s+publishContent\s*\(/g)) {
        const call = source.slice(match.index, match.index + 700);
        assert(call.includes("confirmation:"), `${path}:${source.slice(0, match.index).split("\n").length} lacks confirmation`);
      }
    }
  });
  await test("UI entry points cannot call provider clients or provider POST routes directly", () => {
    for (const path of sources) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      assert(!/\bpublishPin\s*\(/.test(source), `${path} calls publishPin directly`);
      assert(!/\bpublishToSocial\s*\(/.test(source), `${path} calls publishToSocial directly`);
      assert(!/fetch\s*\(\s*["']\/api\/pinterest\/pins/.test(source), `${path} calls Pinterest route directly`);
      assert(!/fetch\s*\(\s*["']\/api\/publish\/social/.test(source), `${path} calls social route directly`);
    }
  });
  await test("Cancel, Escape, close and backdrop are zero-dispatch UI paths", () => {
    const dialog = readFileSync(join(process.cwd(), "src/components/shared/ConfirmPublishDialog.tsx"), "utf8");
    assert(dialog.includes('event.key === "Escape"'));
    assert(dialog.includes("event.target === event.currentTarget"));
    assert(dialog.includes('data-testid="confirm-publish-close"'));
    assert(dialog.includes('data-testid="confirm-publish-cancel"'));
    assert(!dialog.includes("publishContent("), "dialog dismissal must not own dispatch");
  });
  await test("keyboard/focus/i18n/390px overflow contracts are present", () => {
    const dialog = readFileSync(join(process.cwd(), "src/components/shared/ConfirmPublishDialog.tsx"), "utf8");
    assert(dialog.includes("restoreFocusRef")); assert(dialog.includes('event.key !== "Tab"'));
    assert(dialog.includes('aria-labelledby="confirm-publish-title"')); assert(dialog.includes('aria-live="polite"'));
    assert(dialog.includes('width: "min(560px, 100%)"')); assert(dialog.includes('overflowX: "hidden"'));
    assert(dialog.includes('t("publishConfirm.title")')); assert(!dialog.includes(">Publish now<"));
  });
  await test("CP-14 card and Batch presentation use explicit destination authority", () => {
    const card = readFileSync(join(process.cwd(), "src/components/studio/PinBoardCard.tsx"), "utf8");
    const board = readFileSync(join(process.cwd(), "src/components/studio/StudioBoard.tsx"), "utf8");
    const batch = readFileSync(join(process.cwd(), "src/components/studio/BatchEditDrawer.tsx"), "utf8");
    assert(card.includes("const destinations = explicitPublishDestinations(draft)"));
    assert(card.includes('data-testid="card-no-saved-destination"'));
    assert(card.includes('data-testid="card-publish-entry-issue"'));
    assert(!card.includes("const destinations = contentDestinations(draft)"));
    assert(board.includes("publishTo: explicitPublishDestinations(draft)"));
    assert(!board.includes('|| "pinterest"'));
    assert(batch.includes('data-empty={!p.publishTo ? "true" : "false"}'));
    assert(!batch.includes('p.publishTo || platformName("pinterest")'));
  });
  await test("CP-14 persistent blocker and three-locale copy contracts are present", () => {
    const board = readFileSync(join(process.cwd(), "src/components/studio/StudioBoard.tsx"), "utf8");
    assert(board.includes('"image_unavailable"'));
    assert(board.includes('"field_too_long"'));
    assert(board.includes("setPublishEntryIssues"));
    for (const path of ["src/lib/i18n/messages/en/studioBoard.ts", "src/lib/i18n/messages/zh-CN.ts", "src/lib/i18n/messages/zh-TW.ts"]) {
      const messages = readFileSync(join(process.cwd(), path), "utf8");
      assert(messages.includes('"studioBoard.card.noSavedDestination"'), `${path} missing no-destination copy`);
      assert(messages.includes('"studioBoard.card.publishBlocked.imageUnavailable"'), `${path} missing media blocker copy`);
      assert(messages.includes('"studioBoard.card.publishBlocked.fieldTooLong"'), `${path} missing field blocker copy`);
    }
  });

  console.log(`\nPublish confirmation: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
main().catch(error => { console.error(error); process.exit(1); });
