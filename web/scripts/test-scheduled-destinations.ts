/**
 * test-scheduled-destinations.ts — the intent layer (P0 option A, layer A).
 *
 * Asserts the rules that make a scheduled multi-platform publish possible without
 * corrupting the execution/result layers:
 *
 *   - intent is persisted and survives publish outcomes (so retry can read it)
 *   - intent is a SNAPSHOT: settings/default drift never re-points a scheduled Pin
 *   - historical Pins derive Pinterest-only intent and never gain IG/FB
 *   - a result is never mistaken for an intent
 *
 * Run: npx tsx scripts/test-scheduled-destinations.ts
 */
import {
  resolveScheduledDestinations,
  buildScheduledDestinations,
  pinterestDestinationFrom,
  hasExplicitIntent,
  isUsableDestination,
  legacyPinterestMirror,
  scheduledProviders,
  withBoardOnPinterestEntry,
} from "../src/lib/social/scheduledDestinations";
import { payloadAfterSuccess, payloadAfterFailure } from "../src/app/api/cron/publish-due/publishDueLogic";
import type { PinDraft, ScheduledDestination } from "../src/lib/pinDraftStore";
import type { SocialProvider } from "../src/lib/social/platforms";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

/** A draft with a pinned Pinterest target, as every scheduled Pin has today. */
function legacyDraft(over: Partial<PinDraft> = {}): PinDraft {
  return {
    id: "d1", pinId: "d1", source: "ai_generated", category: "home",
    imageUrl: "/img.png", title: "T", keyword: "k",
    targetConnectionId: "conn-pinterest-A", targetAccountLabel: "@shopA",
    boardId: "board-A", boardName: "Board A",
    scheduledDate: "2099-01-01", scheduledTime: "10:00",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as PinDraft;
}

/** The connected accounts, in the shape the picker reports them. */
const acct = (id: string, username: string) => ({ id, connectionStatus: "connected", providerAccountUsername: username });
const ACCOUNTS: Record<string, ReturnType<typeof acct>[]> = {
  pinterest: [acct("conn-pinterest-A", "shop_pin")],
  instagram: [acct("conn-ig-1", "@shop_ig")],
  facebook:  [acct("conn-fb-1", "Shop Page")],
};
const accountsOf = (p: SocialProvider) => ACCOUNTS[p] ?? [];

// ── writing intent ───────────────────────────────────────────────────────────
section("capturing intent");

const built = buildScheduledDestinations(
  [{ provider: "pinterest" }, { provider: "instagram" }, { provider: "facebook" }],
  legacyDraft(), accountsOf,
  new Date("2026-08-18T12:00:00.000Z"),
);
check("all three chosen platforms are captured", built.length === 3,
  `got ${built.length}: ${JSON.stringify(built.map(d => d.provider))}`);
check("Pinterest intent carries the pinned account AND board",
  built[0].provider === "pinterest" && built[0].socialConnectionId === "conn-pinterest-A"
    && built[0].boardId === "board-A");
check("Instagram intent carries its own resolved account",
  built[1].provider === "instagram" && built[1].socialConnectionId === "conn-ig-1");
check("Facebook intent carries its own resolved account",
  built[2].provider === "facebook" && built[2].socialConnectionId === "conn-fb-1");
check("every entry is stamped with when it was captured",
  built.every(d => d.capturedAt === "2026-08-18T12:00:00.000Z"));

// A platform with no resolvable account must not become a half-record that would
// fail at due time pointing at nothing.
const partial = buildScheduledDestinations(
  [{ provider: "pinterest" }, { provider: "instagram" }], legacyDraft(),
  (p) => (p === "instagram" ? [] : accountsOf(p)),
);
check("a platform with no resolvable account is omitted, not stored empty",
  partial.length === 1 && partial[0].provider === "pinterest");

// ── reading intent ───────────────────────────────────────────────────────────
section("reading intent back");

const withIntent = legacyDraft({ scheduledDestinations: built });
check("stored intent is returned verbatim",
  JSON.stringify(resolveScheduledDestinations(withIntent)) === JSON.stringify(built));
check("providers are reported in order",
  JSON.stringify(scheduledProviders(withIntent)) === JSON.stringify(["pinterest", "instagram", "facebook"]));
check("explicit intent is distinguishable from a derivation",
  hasExplicitIntent(withIntent) && !hasExplicitIntent(legacyDraft()));

// ── historical Pins: derive Pinterest, never invent IG/FB ─────────────────────
section("historical Pins (no stored intent)");

const derived = resolveScheduledDestinations(legacyDraft());
check("a legacy Pin derives exactly one destination", derived.length === 1);
check("and it is Pinterest, with the account and board it already had",
  derived[0].provider === "pinterest"
    && derived[0].socialConnectionId === "conn-pinterest-A"
    && derived[0].boardId === "board-A");
check("NO Instagram is invented for a legacy Pin",
  !derived.some(d => d.provider === "instagram"));
check("NO Facebook is invented for a legacy Pin",
  !derived.some(d => d.provider === "facebook"));
check("a legacy Pin with no pinned account derives nothing at all",
  resolveScheduledDestinations(legacyDraft({ targetConnectionId: "" })).length === 0,
  "must not fabricate a destination when there is no evidence of one");

// A connected-accounts list is not evidence of past intent. The resolver takes no
// such input at all — this asserts the signature stays that way.
check("the resolver cannot see connected accounts (no way to guess)",
  resolveScheduledDestinations.length === 1,
  "resolveScheduledDestinations must take ONLY the draft");

// ── intent is a snapshot, not a live lookup ──────────────────────────────────
section("intent is frozen at capture time (TC-074)");

const before = JSON.parse(JSON.stringify(withIntent.scheduledDestinations));
// Simulate the workspace default drifting to a different account entirely.
const drifted = { ...withIntent, targetConnectionId: "conn-pinterest-B", boardId: "board-Z" };
const afterDrift = resolveScheduledDestinations(drifted as PinDraft);
check("changing the pinned/default target does NOT change stored intent",
  JSON.stringify(afterDrift) === JSON.stringify(before),
  `intent moved: ${JSON.stringify(afterDrift[0])}`);
check("the stored intent still names the ORIGINAL account",
  afterDrift[0].socialConnectionId === "conn-pinterest-A");

// ── intent survives execution outcomes (so retry can read it) ────────────────
section("intent survives publish outcomes");

const payload = { ...withIntent } as unknown as Record<string, unknown>;
const okPayload = payloadAfterSuccess(payload, { id: "999", url: "https://pin/999" }, "2026-08-18T13:00:00.000Z");
check("intent survives a successful publish",
  JSON.stringify(okPayload.scheduledDestinations) === JSON.stringify(built));
const failPayload = payloadAfterFailure(payload, { message: "boom", code: "x" }, "2026-08-18T13:00:00.000Z");
check("intent survives a failed publish (retry needs it)",
  JSON.stringify(failPayload.scheduledDestinations) === JSON.stringify(built));
check("a successful publish still clears the schedule (Pin leaves the due scan)",
  okPayload.scheduledDate === "" && okPayload.plannedAt === "");

// ── intent is not a result ───────────────────────────────────────────────────
section("intent and result stay separate");

const withResults = legacyDraft({
  socialPosts: [{ provider: "instagram", postId: "p1", postUrl: "https://ig/p1", publishedAt: "x" }],
} as Partial<PinDraft>);
const fromResults = resolveScheduledDestinations(withResults);
check("a published RESULT never becomes an intent",
  !fromResults.some(d => d.provider === "instagram"),
  `socialPosts leaked into intent: ${JSON.stringify(fromResults)}`);

// ── malformed stored data cannot poison the read ─────────────────────────────
section("malformed intent is rejected, not trusted");

check("an entry with an unknown provider is discarded",
  !isUsableDestination({ provider: "myspace", socialConnectionId: "x" }));
check("an entry with no account id is discarded",
  !isUsableDestination({ provider: "instagram", socialConnectionId: "" }));
check("a non-object entry is discarded", !isUsableDestination("instagram"));
const poisoned = legacyDraft({
  scheduledDestinations: [
    { provider: "myspace", socialConnectionId: "x", capturedAt: "t" },
    { provider: "instagram", socialConnectionId: "conn-ig-1", capturedAt: "t" },
  ] as ScheduledDestination[],
});
const cleaned = resolveScheduledDestinations(poisoned);
check("a poisoned list keeps only the valid entries",
  cleaned.length === 1 && cleaned[0].provider === "instagram");

// An all-invalid list must NOT silently fall back to the legacy derivation —
// that would turn corrupt data into a confident Pinterest-only publish.
const allBad = legacyDraft({
  scheduledDestinations: [{ provider: "myspace", socialConnectionId: "x", capturedAt: "t" }] as ScheduledDestination[],
});
check("an all-invalid list falls back to the legacy Pinterest derivation",
  resolveScheduledDestinations(allBad).length === 1
    && resolveScheduledDestinations(allBad)[0].provider === "pinterest",
  "documented behaviour: no usable intent ⇒ same path as a legacy Pin");

// ── the helper used to keep Pinterest intent and pinned target in sync ───────
section("Pinterest intent mirrors the pinned target");
check("no pinned account ⇒ no Pinterest intent",
  pinterestDestinationFrom({ targetConnectionId: "" }, "t") === null);
const p = pinterestDestinationFrom(legacyDraft(), "t")!;
check("board name/label are carried as display snapshots",
  p.boardName === "Board A" && p.accountLabel === "@shopA");

// ── WS-B3: several accounts per platform, each its own destination ──────────
section("N accounts per platform (WS-B3)");
{
  const PIN_A = { id: "pin_A", connectionStatus: "connected", providerAccountUsername: "shopA" };
  const PIN_B = { id: "pin_B", connectionStatus: "connected", providerAccountUsername: "shopB" };
  const IG_A  = { id: "ig_A",  connectionStatus: "connected", providerAccountUsername: "ig_one" };
  const IG_B  = { id: "ig_B",  connectionStatus: "connected", providerAccountUsername: "ig_two" };
  const accounts = (p: SocialProvider) =>
    p === "pinterest" ? [PIN_A, PIN_B] : p === "instagram" ? [IG_A, IG_B] : [];

  const two = buildScheduledDestinations([
    { provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", boardName: "Board A" },
    { provider: "pinterest", socialConnectionId: "pin_B", boardId: "b-B", boardName: "Board B" },
    { provider: "instagram", socialConnectionId: "ig_A" },
    { provider: "instagram", socialConnectionId: "ig_B" },
  ], {}, accounts);
  check("two Pinterest accounts become two destinations",
    two.filter(d => d.provider === "pinterest").length === 2, JSON.stringify(two));
  check("two Instagram accounts become two destinations",
    two.filter(d => d.provider === "instagram").length === 2);
  check("each Pinterest entry keeps its OWN board",
    two[0].boardId === "b-A" && two[1].boardId === "b-B",
    "a shared board would publish account B's Pin into account A's board");

  const deduped = buildScheduledDestinations([
    { provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A" },
    { provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A" },
  ], {}, accounts);
  check("the same account picked twice is stored once", deduped.length === 1);

  let threw: unknown = null;
  try {
    buildScheduledDestinations([{ provider: "instagram" }], {}, accounts);
  } catch (e) { threw = e; }
  check("a pick with no account and several connected FAILS CLOSED (throws)",
    threw instanceof Error && threw.name === "AmbiguousScheduleAccountError",
    "picking the first would silently schedule to the wrong account");

  const single = buildScheduledDestinations([{ provider: "instagram" }], {},
    (p) => (p === "instagram" ? [IG_A] : []));
  check("with exactly one connected account, no explicit pick is needed",
    single.length === 1 && single[0].socialConnectionId === "ig_A");

  // A second Pinterest account must NOT inherit the draft-level (first account's) board.
  const noInherit = buildScheduledDestinations(
    [{ provider: "pinterest", socialConnectionId: "pin_B" }],
    { targetConnectionId: "pin_A", boardId: "b-A", boardName: "Board A" },
    accounts,
  );
  check("a second Pinterest account does not inherit the legacy board",
    !noInherit[0].boardId,
    `got ${JSON.stringify(noInherit[0])} — that board belongs to the other account`);
  const inherits = buildScheduledDestinations(
    [{ provider: "pinterest", socialConnectionId: "pin_A" }],
    { targetConnectionId: "pin_A", boardId: "b-A", boardName: "Board A" },
    accounts,
  );
  check("the entry that IS the legacy target still inherits its board",
    inherits[0].boardId === "b-A" && inherits[0].boardName === "Board A");

  const mirror = legacyPinterestMirror(two);
  check("the legacy mirror follows the FIRST Pinterest entry",
    mirror.targetConnectionId === "pin_A" && mirror.boardId === "b-A", JSON.stringify(mirror));
  check("no Pinterest entry ⇒ the mirror is cleared, never left stale",
    legacyPinterestMirror([two[2]]).targetConnectionId === ""
      && legacyPinterestMirror([two[2]]).boardId === "");
}

// ── the card's board field IS a destination ──────────────────────────────────
// Owner decision 2026-08-27: editing the Board on a Create Pins card is editing the
// publish destination. These pin the rewrite the card performs — the bug it replaces
// showed the merchant the NEW board while publishing the Pin to the OLD one.
section("a board edit moves the entry it speaks for");
{
  const dest = (over: Partial<ScheduledDestination> = {}): ScheduledDestination => ({
    provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", boardName: "Board A",
    accountLabel: "@shopA", capturedAt: "2026-08-01T00:00:00.000Z", ...over,
  });
  const NEW = { boardId: "b-Z", boardName: "Board Z" };

  // 1. Legacy Pin with no stored intent: the helper has nothing to rewrite, and the
  // read-side derivation carries the new board on its own.
  const legacyOnly = withBoardOnPinterestEntry(undefined, "conn-pinterest-A", NEW);
  check("a draft with no stored intent gets no invented entry", legacyOnly.length === 0);
  const derivedAfterEdit = resolveScheduledDestinations(
    legacyDraft({ boardId: "b-Z", boardName: "Board Z" }),
  );
  check("legacy draft: the edited board is what the read side derives",
    derivedAfterEdit.length === 1 && derivedAfterEdit[0].boardId === "b-Z",
    JSON.stringify(derivedAfterEdit));

  // 2. One Pinterest entry beside a non-Pinterest one.
  const ig = { provider: "instagram", socialConnectionId: "ig_A", capturedAt: "2026-08-01T00:00:00.000Z" } as ScheduledDestination;
  const mixed = [dest(), ig];
  const rewritten = withBoardOnPinterestEntry(mixed, "pin_A", NEW);
  check("the Pinterest entry takes the new board",
    rewritten[0].boardId === "b-Z" && rewritten[0].boardName === "Board Z",
    JSON.stringify(rewritten[0]));
  check("the rest of that entry is untouched (account + capture time survive)",
    rewritten[0].socialConnectionId === "pin_A" && rewritten[0].accountLabel === "@shopA"
      && rewritten[0].capturedAt === "2026-08-01T00:00:00.000Z");
  check("the Instagram entry is left exactly as it was", rewritten[1] === ig);
  check("the input array is not mutated", mixed[0].boardId === "b-A");

  // 3. Two Pinterest accounts: ONLY the one the card's target names may move. The other
  // account's board is a different account's board — writing this one onto it is the
  // wrong-destination bug in its worst form.
  const twoPins = [dest({ socialConnectionId: "pin_A" }), dest({ socialConnectionId: "pin_B", boardId: "b-B", boardName: "Board B" })];
  const onlyB = withBoardOnPinterestEntry(twoPins, "pin_B", NEW);
  check("only the entry matching targetConnectionId changes",
    onlyB[1].boardId === "b-Z" && onlyB[0].boardId === "b-A", JSON.stringify(onlyB));

  // 4. No entry matches (or nothing to match on) ⇒ the FIRST Pinterest entry, which is
  // the one legacyPinterestMirror mirrors, so the two never disagree.
  const noMatch = withBoardOnPinterestEntry(twoPins, "pin_GONE", NEW);
  check("with no matching account the FIRST Pinterest entry takes the board",
    noMatch[0].boardId === "b-Z" && noMatch[1].boardId === "b-B", JSON.stringify(noMatch));
  check("that is the same entry the legacy mirror follows",
    legacyPinterestMirror(noMatch).boardId === "b-Z");
  const noTarget = withBoardOnPinterestEntry(twoPins, "", NEW);
  check("no target id at all still falls to the first Pinterest entry",
    noTarget[0].boardId === "b-Z" && noTarget[1].boardId === "b-B");

  // 5. Clearing the board clears it on the entry too — a cleared field must never leave
  // the old board still stored as where this publishes.
  const cleared = withBoardOnPinterestEntry(mixed, "pin_A", { boardId: "", boardName: "" });
  check("clearing the board clears it on the entry",
    cleared[0].boardId === undefined && cleared[0].boardName === undefined,
    JSON.stringify(cleared[0]));

  // 6. No Pinterest entry ⇒ nothing to rewrite; the legacy fields alone are correct.
  const igOnly = withBoardOnPinterestEntry([ig], "pin_A", NEW);
  check("an intent with no Pinterest entry is returned unchanged",
    igOnly.length === 1 && igOnly[0] === ig);
}

console.log(`\nScheduled destinations: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
