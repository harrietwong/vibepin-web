/**
 * test-scheduled-account-identity.ts — a scheduled publish must go out as the
 * account the merchant chose, not "whichever connected account is first".
 *
 * Before multi-account shipped, one connected account per platform meant
 * "first connected" and "the one they meant" were the same row. They are not any
 * more: a merchant with two Instagram accounts who picks B must get B, in three
 * weeks' time, from a schedule saved today.
 *
 * The rule (resolveScheduledAccount):
 *   1. an explicit pick always wins;
 *   2. exactly one connected account is unambiguous, so use it;
 *   3. several connected and no pick THROWS — guessing would publish weeks of
 *      content to the wrong account before anyone noticed.
 *
 * Run: npx tsx scripts/test-scheduled-account-identity.ts
 */
import {
  resolveScheduledAccount,
  AmbiguousScheduleAccountError,
  buildScheduledDestinations,
  type ConnectableAccount,
} from "../src/lib/social/scheduledDestinations";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

const A: ConnectableAccount = { id: "ig_A", connectionStatus: "connected", providerAccountUsername: "acct_a" };
const B: ConnectableAccount = { id: "ig_B", connectionStatus: "connected", providerAccountUsername: "acct_b" };
const DEAD: ConnectableAccount = { id: "ig_dead", connectionStatus: "expired", providerAccountUsername: "acct_dead" };

section("INT-P0-03 — an explicit pick wins over account order");
{
  const r = resolveScheduledAccount("instagram", [A, B], "ig_B");
  check("choosing B returns B, not the first connected", r?.id === "ig_B", `got ${JSON.stringify(r)}`);
  check("its label rides along for display", r?.label === "acct_b");
}
{
  // Order must not decide the outcome. Same inputs, reversed list.
  const r = resolveScheduledAccount("instagram", [B, A], "ig_A");
  check("reversing the list does not change the answer", r?.id === "ig_A", `got ${JSON.stringify(r)}`);
}

section("several connected and NO pick must be refused, never guessed");
{
  let threw: unknown = null;
  try { resolveScheduledAccount("instagram", [A, B]); } catch (e) { threw = e; }
  check("it throws rather than returning one", threw instanceof AmbiguousScheduleAccountError,
    `got ${threw === null ? "no throw — it picked one" : String(threw)}`);
  check("the error names the platform", (threw as AmbiguousScheduleAccountError)?.provider === "instagram");
  check("and how many were connected", (threw as AmbiguousScheduleAccountError)?.count === 2);
}
{
  // The counter-proof: first-connected WOULD have returned A here. That is the
  // exact wrong answer this rule exists to prevent.
  const firstConnected = [A, B].find(a => a.connectionStatus === "connected");
  check("the old rule would have silently chosen A", firstConnected?.id === "ig_A");
}

section("a single connected account stays effortless");
{
  const r = resolveScheduledAccount("instagram", [A]);
  check("one connected account resolves with no explicit pick", r?.id === "ig_A");
}
{
  const r = resolveScheduledAccount("instagram", [A, DEAD]);
  check("a disconnected account does not create ambiguity", r?.id === "ig_A", `got ${JSON.stringify(r)}`);
}

section("nothing connected, and stale picks");
{
  check("no connected account returns null (not an error)",
    resolveScheduledAccount("instagram", [DEAD]) === null);
  check("an empty list returns null", resolveScheduledAccount("instagram", []) === null);
}
{
  // A pick that is no longer connected must NOT fall through to another account —
  // that is the same wrong-account failure arriving by a different route.
  const r = resolveScheduledAccount("instagram", [A, B], "ig_gone");
  check("a stale explicit pick returns null instead of substituting", r === null,
    `got ${JSON.stringify(r)} — substituting another account would republish elsewhere`);
}

section("INT-P0-05/06 — the saved schedule is immune to later changes");
{
  // Saved today with B chosen. Tomorrow a third account appears and the default
  // moves. The stored intent must still name B.
  const saved = buildScheduledDestinations(
    ["instagram"],
    {},
    (provider) => resolveScheduledAccount(provider, [A, B], "ig_B"),
  );
  check("intent records the specific connection id", saved[0]?.socialConnectionId === "ig_B",
    JSON.stringify(saved));
  check("intent is not merely a platform name", !!saved[0]?.socialConnectionId);
  check("the account label is snapshotted for display", saved[0]?.accountLabel === "acct_b");
}

section("Pinterest keeps account AND board");
{
  const saved = buildScheduledDestinations(
    ["pinterest"],
    { targetConnectionId: "pin_conn_1", targetAccountLabel: "harrietstudio", boardId: "813814663854885698", boardName: "家居" },
    () => null,
  );
  const p = saved[0];
  check("board id is persisted", p?.boardId === "813814663854885698", JSON.stringify(p));
  check("account id is persisted", p?.socialConnectionId === "pin_conn_1");
  check("board name is a display snapshot", p?.boardName === "家居");
}

console.log(`\nScheduled account identity: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
