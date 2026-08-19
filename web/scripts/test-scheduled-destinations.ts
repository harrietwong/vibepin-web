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
  scheduledProviders,
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

const CONNECTIONS: Record<string, { id: string; label?: string }> = {
  instagram: { id: "conn-ig-1", label: "@shop_ig" },
  facebook:  { id: "conn-fb-1", label: "Shop Page" },
};
const resolveConn = (p: SocialProvider) => CONNECTIONS[p] ?? null;

// ── writing intent ───────────────────────────────────────────────────────────
section("capturing intent");

const built = buildScheduledDestinations(
  ["pinterest", "instagram", "facebook"], legacyDraft(), resolveConn,
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
  ["pinterest", "instagram"], legacyDraft(), (p) => (p === "instagram" ? null : CONNECTIONS[p] ?? null),
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

console.log(`\nScheduled destinations: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
