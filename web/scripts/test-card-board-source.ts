/**
 * test-card-board-source.ts — Create Pins card: destination picker + Board field
 * (fix/studio-accounts-boards-0926).
 *
 * Two bugs seen on the internal site with a user holding TWO connected Pinterest
 * accounts:
 *   1. "Choose publishing destinations" showed only the picker's title + subtitle.
 *      The picker was position:absolute inside the card root, which clips
 *      (overflow:hidden), so the account rows / per-account ticks / per-account Board
 *      selects overhanging the card's bottom edge were invisible.
 *   2. The card's Board dropdown listed the DEFAULT account's boards regardless of the
 *      account the draft publishes as, and loading / failure / "no boards" all looked
 *      the same (an empty list with just the placeholder).
 *
 * Like the other card UI tests in this repo (see test-mixed-video-split-ui.ts) this
 * asserts pure functions + source-level wiring; no browser is mounted.
 *
 * Run: npx tsx scripts/test-card-board-source.ts (from web/)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cardBoardAccountLabel,
  cardBoardState,
  isInternalBoardName,
  resolveCardBoardConnectionId,
} from "../src/lib/studio/cardBoardSource";
import type { PinDraft, ScheduledDestination } from "../src/lib/pinDraftStore";

let pass = 0, fail = 0;
function test(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  OK   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${(e as Error).stack ?? (e as Error).message}`); }
}

const A = "fc74313c-0000-0000-0000-000000000001"; // oldest = server default
const B = "3755cdec-0000-0000-0000-000000000002";
const IG = "e5053a49-0000-0000-0000-000000000003";

function draft(destinations: ScheduledDestination[] | undefined, targetConnectionId = ""): Parameters<typeof resolveCardBoardConnectionId>[0] {
  return { scheduledDestinations: destinations, targetConnectionId } as unknown as PinDraft;
}
function dest(provider: string, socialConnectionId: string, extra: Partial<ScheduledDestination> = {}): ScheduledDestination {
  return { provider, socialConnectionId, ...extra } as ScheduledDestination;
}

console.log("resolveCardBoardConnectionId — whose boards the card's Board field lists");
test("no destinations, no target → null (server default account)", () => {
  assert.equal(resolveCardBoardConnectionId(draft(undefined)), null);
  assert.equal(resolveCardBoardConnectionId(draft([])), null);
});
test("single explicit Pinterest destination → that account", () => {
  assert.equal(resolveCardBoardConnectionId(draft([dest("pinterest", B)])), B);
});
test("the SECOND account chosen → its boards, never the default account's", () => {
  assert.equal(resolveCardBoardConnectionId(draft([dest("instagram", IG), dest("pinterest", B)])), B);
});
test("two Pinterest destinations → the one targetConnectionId names (the entry the field writes to)", () => {
  assert.equal(resolveCardBoardConnectionId(draft([dest("pinterest", A), dest("pinterest", B)], B)), B);
});
test("two Pinterest destinations, target names neither → first Pinterest entry (legacy mirror rule)", () => {
  assert.equal(resolveCardBoardConnectionId(draft([dest("pinterest", A), dest("pinterest", B)], "stale")), A);
});
test("Instagram-only destinations → falls back to legacy target, else null", () => {
  assert.equal(resolveCardBoardConnectionId(draft([dest("instagram", IG)])), null);
  assert.equal(resolveCardBoardConnectionId(draft([dest("instagram", IG)], A)), A);
});
test("legacy target without destinations still scopes the boards", () => {
  assert.equal(resolveCardBoardConnectionId(draft(undefined, B)), B);
});

console.log("cardBoardAccountLabel — 'Boards of @account'");
const accounts = [
  { id: A, providerAccountUsername: "h8rrietstudio", providerAccountName: "@h8rrietstudio" },
  { id: B, providerAccountUsername: "cheerishh", providerAccountName: "@cheerishh" },
];
test("no explicit account → the oldest account (index 0 = pickDefaultConnection)", () => {
  assert.equal(cardBoardAccountLabel(null, accounts), "@h8rrietstudio");
});
test("explicit account → that account's @handle", () => {
  assert.equal(cardBoardAccountLabel(B, accounts), "@cheerishh");
});
test("unknown account / no accounts loaded → null (no misleading label)", () => {
  assert.equal(cardBoardAccountLabel("nope", accounts), null);
  assert.equal(cardBoardAccountLabel(null, []), null);
});
test("falls back to display name when there is no username", () => {
  assert.equal(cardBoardAccountLabel(A, [{ id: A, providerAccountUsername: null, providerAccountName: "Harriet Studio" }]), "Harriet Studio");
});

console.log("cardBoardState — loading / error / empty are distinct");
const base = { loading: false, error: false, needsReconnect: false, disconnected: false, boardCount: 0 };
test("loading with no boards yet → loading (never 'no boards')", () => {
  assert.equal(cardBoardState({ ...base, loading: true }), "loading");
});
test("failed read → error (never 'no boards')", () => {
  assert.equal(cardBoardState({ ...base, error: true }), "error");
});
test("settled, no error, zero boards → empty", () => {
  assert.equal(cardBoardState(base), "empty");
});
test("boards present → ready (even while revalidating)", () => {
  assert.equal(cardBoardState({ ...base, boardCount: 3 }), "ready");
  assert.equal(cardBoardState({ ...base, boardCount: 3, loading: true }), "ready");
});
test("connection states win over a generic error", () => {
  assert.equal(cardBoardState({ ...base, needsReconnect: true, error: true }), "needs_reconnect");
  assert.equal(cardBoardState({ ...base, disconnected: true }), "not_connected");
});
test("internal/sandbox boards are filtered, real ones are not", () => {
  assert.equal(isInternalBoardName("VibePin Sandbox Demo Board"), true);
  assert.equal(isInternalBoardName(" qa board "), true);
  assert.equal(isInternalBoardName("Living room ideas"), false);
});

console.log("PinBoardCard source wiring");
const card = readFileSync("src/components/studio/PinBoardCard.tsx", "utf8");
const popoverStart = card.indexOf('data-testid="card-destination-popover"');
const popoverTag = card.slice(popoverStart, card.indexOf(">", card.indexOf("style={{", popoverStart)));
test("destination picker is inline, never position:absolute / fixed click-catcher", () => {
  assert.ok(popoverStart > 0, "popover testid present");
  assert.ok(!/position:\s*"absolute"/.test(popoverTag), `picker must not be absolute: ${popoverTag}`);
  assert.ok(/data-layout="inline"/.test(popoverTag));
  // The ⋯ menu keeps its own click-catcher; the destinations one must be gone.
  assert.ok(!/onClick=\{\(\) => setDestinationsOpen\(false\)\}/.test(card), "destinations full-screen click-catcher removed");
});
test("picker renders AFTER the chips row, inside the Publish-to block (pushes content down)", () => {
  const publishTo = card.indexOf('data-testid="card-publish-to"');
  const noSaved = card.indexOf('data-testid="card-no-saved-destination"');
  assert.ok(publishTo > 0 && noSaved > publishTo && popoverStart > noSaved);
  assert.ok(/ref=\{publishToRef\} data-testid="card-publish-to"/.test(card));
});
test("click-outside and Escape still close the picker", () => {
  assert.ok(/document\.addEventListener\("mousedown", onPointerDown\)/.test(card));
  assert.ok(/event\.key === "Escape"\) setDestinationsOpen\(false\)/.test(card));
  assert.ok(/!root\.contains\(event\.target\)\) setDestinationsOpen\(false\)/.test(card));
});
test("card root overflow is unchanged (corners / media clipping untouched)", () => {
  assert.ok(/borderRadius: STUDIO_UI\.cardRadius, overflow: "hidden", boxShadow: props\.selected/.test(card));
});
test("Board field fetches boards for the draft's chosen account", () => {
  assert.ok(/resolveCardBoardConnectionId\(draft\)/.test(card));
  assert.ok(/usePinterestBoards\(boardConnectionId \?\? undefined\)/.test(card));
  assert.ok(/const boards = boardConnectionId \? scopedCustomerBoards : props\.boards/.test(card));
});
test("Board field shows account + loading / error(retry) / empty states", () => {
  for (const key of ["accountLabel", "loading", "error", "retry", "needsReconnect", "notConnected", "empty"]) {
    assert.ok(card.includes(`studioBoard.card.boardSource.${key}`), `card uses boardSource.${key}`);
  }
  assert.ok(card.includes('data-testid="board-card-board-source" data-state={boardState}'));
  assert.ok(card.includes('data-testid="board-card-board-retry"'));
});
test("StudioBoard reads Pinterest accounts once and passes them to every card", () => {
  const board = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
  assert.ok(/const \{ connections: pinterestAccounts \} = usePinterestConnections\(\)/.test(board));
  assert.ok(/pinterestAccounts=\{pinterestAccounts\}/.test(board));
  assert.ok(!/function isInternalBoardName/.test(board), "single shared filter");
});
test("i18n: every new key exists in en, zh-CN and zh-TW with matching {account}", () => {
  const en = readFileSync("src/lib/i18n/messages/en/studioBoard.ts", "utf8");
  const zhCN = readFileSync("src/lib/i18n/messages/zh-CN.ts", "utf8");
  const zhTW = readFileSync("src/lib/i18n/messages/zh-TW.ts", "utf8");
  for (const key of ["accountLabel", "loading", "error", "retry", "needsReconnect", "notConnected", "empty"]) {
    for (const [name, src] of [["en", en], ["zh-CN", zhCN], ["zh-TW", zhTW]] as const) {
      assert.ok(src.includes(`"studioBoard.card.boardSource.${key}"`), `${name} has ${key}`);
    }
  }
  assert.ok(/"studioBoard\.card\.boardSource\.accountLabel": "[^"]*\{account\}/.test(zhCN));
  assert.ok(/"studioBoard\.card\.boardSource\.accountLabel": "[^"]*\{account\}/.test(zhTW));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
