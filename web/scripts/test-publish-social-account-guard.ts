/**
 * test-publish-social-account-guard.ts — /api/publish/social must never guess WHICH
 * account a destination meant (PRD 0826 §16).
 *
 * The defect: a destination arriving without a `socialConnectionId` fell back to
 * `accounts.find(a => a.connectionStatus === "connected")` — the first connected
 * account of that platform. For a single-account merchant that is right by
 * construction. For a merchant with two connected Instagram accounts it publishes to
 * an account they never chose, and the only way they learn about it is by seeing the
 * post appear there. A publish that asks is recoverable; the wrong audience is not.
 *
 * Run: npx tsx scripts/test-publish-social-account-guard.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveDestinationConnection,
  connectAccountMessage,
  chooseAccountMessage,
} from "../src/lib/social/server/resolveDestinationConnection";
import type { SocialConnection } from "../src/lib/social/types";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  OK   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error).message}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

const account = (id: string, connectionStatus: SocialConnection["connectionStatus"] = "connected"): SocialConnection => ({
  id,
  provider: "instagram",
  workspaceId: null,
  providerAccountId: id,
  providerAccountName: id,
  providerAccountUsername: id,
  providerAccountAvatarUrl: null,
  connectionStatus,
  authProvider: "official",
  externalConnectionId: null,
  scopes: [],
  tokenExpiresAt: null,
  metadata: null,
  createdAt: null,
  updatedAt: null,
});

const summaryOf = (...accounts: SocialConnection[]) => ({ accounts });

// ── the single-account merchant keeps working ────────────────────────────────
section("one connected account needs no choice");

test("exactly one connected account is used", () => {
  const choice = resolveDestinationConnection(summaryOf(account("ig-1")), {});
  assert.equal(choice.kind, "only");
  assert.equal(choice.kind === "only" ? choice.connection.id : null, "ig-1");
});

test("an expired sibling neither publishes nor makes the usable one ambiguous", () => {
  const choice = resolveDestinationConnection(
    summaryOf(account("ig-dead", "expired"), account("ig-1")),
    {},
  );
  assert.equal(choice.kind, "only");
  assert.equal(choice.kind === "only" ? choice.connection.id : null, "ig-1");
});

// ── the merchant's own choice always wins ────────────────────────────────────
section("an explicitly named account is taken as given");

test("a named account is returned for the caller's user-scoped lookup", () => {
  const choice = resolveDestinationConnection(
    summaryOf(account("ig-1"), account("ig-2")),
    { socialConnectionId: " ig-2 " },
  );
  assert.deepEqual(choice, { kind: "explicit", connectionId: "ig-2" });
});

test("a named account is NOT resolved from the summary — the caller verifies ownership", () => {
  // Deliberately an id the summary does not contain: the resolver must not decide it
  // is invalid, because `findConnection` is what scopes the lookup to this user.
  const choice = resolveDestinationConnection(summaryOf(account("ig-1")), { socialConnectionId: "someone-elses" });
  assert.deepEqual(choice, { kind: "explicit", connectionId: "someone-elses" });
});

test("a blank or non-string id counts as 'not named'", () => {
  assert.equal(resolveDestinationConnection(summaryOf(account("ig-1")), { socialConnectionId: "   " }).kind, "only");
  assert.equal(resolveDestinationConnection(summaryOf(account("ig-1")), { socialConnectionId: 42 }).kind, "only");
  assert.equal(resolveDestinationConnection(summaryOf(account("ig-1")), { socialConnectionId: null }).kind, "only");
});

// ── the defect ───────────────────────────────────────────────────────────────
section("two connected accounts and no choice ⇒ refuse, never guess");

test("several connected accounts ⇒ ambiguous, with the count", () => {
  const choice = resolveDestinationConnection(summaryOf(account("ig-1"), account("ig-2")), {});
  assert.deepEqual(choice, { kind: "ambiguous", count: 2 });
});

test("the first connected account is never silently chosen", () => {
  const choice = resolveDestinationConnection(summaryOf(account("ig-1"), account("ig-2")), {});
  assert.notEqual(choice.kind, "only", "this is exactly the wrong-account publish PRD 0826 §16 forbids");
});

// ── nothing to publish to ────────────────────────────────────────────────────
section("no connected account is a plain 'connect one'");

test("zero accounts ⇒ none", () => {
  assert.deepEqual(resolveDestinationConnection(summaryOf(), {}), { kind: "none" });
  assert.deepEqual(resolveDestinationConnection(undefined, {}), { kind: "none" });
  assert.deepEqual(resolveDestinationConnection(null, {}), { kind: "none" });
});

test("only unusable accounts ⇒ none, not ambiguous", () => {
  const choice = resolveDestinationConnection(
    summaryOf(account("ig-dead", "expired"), account("ig-gone", "revoked")),
    {},
  );
  assert.deepEqual(choice, { kind: "none" });
});

// ── what the merchant reads ──────────────────────────────────────────────────
section("both messages say what to do next, in platform terms");

test("the messages name the platform and the action", () => {
  assert.equal(connectAccountMessage("instagram"), "Connect an Instagram account first.");
  assert.equal(connectAccountMessage("pinterest"), "Connect a Pinterest account first.");
  assert.equal(connectAccountMessage("facebook"), "Connect a Facebook Page account first.");
  assert.equal(chooseAccountMessage("instagram"), "Choose which Instagram account to publish to.");
  // PLATFORMS[provider].name — "Facebook Page", the same wording every other
  // publish-side message uses.
  assert.equal(chooseAccountMessage("facebook"), "Choose which Facebook Page account to publish to.");
});

// ── the route is wired to it ─────────────────────────────────────────────────
// The route needs Supabase + a bearer session, so its wiring is asserted on the
// source: this is the exact line that used to guess.
section("/api/publish/social actually uses it");

const route = readFileSync("src/app/api/publish/social/route.ts", "utf8");

test("the first-connected-account fallback is gone", () => {
  assert.ok(
    !/accounts\.find\(a => a\.connectionStatus === "connected"\)/.test(route),
    "the route must not pick an account for the merchant",
  );
});

test("the route resolves each destination through the shared rule", () => {
  assert.match(route, /resolveDestinationConnection\(summary, raw as \{ socialConnectionId\?: unknown \}\)/);
});

test("an ambiguous destination is refused BEFORE the provider is called", () => {
  const guard = route.indexOf("choice.kind === \"none\" || choice.kind === \"ambiguous\"");
  const call = route.indexOf("publishPost({");
  assert.ok(guard > 0 && guard < call, "nothing may be published while the account is unknown");
  const block = route.slice(guard, call);
  assert.match(block, /continue;/, "the destination must be abandoned, not published");
  assert.match(block, /chooseAccountMessage\(provider\)/);
  assert.match(block, /connectAccountMessage\(provider\)/);
});

test("an explicitly named account still goes through the user-scoped lookup", () => {
  assert.match(route, /choice\.kind === "explicit"\s*\r?\n?\s*\? await findConnection\(uid, choice\.connectionId\)/);
});

test("an explicit id that is no longer connected fails — it never falls back to another account", () => {
  // The resolver hands the id back and the route resolves it; when that account cannot
  // publish, the destination FAILS. Quietly publishing to a different connected account
  // instead would be the same wrong-account defect by another route.
  const guard = route.indexOf('if (!connection || connection.connectionStatus !== "connected")');
  const call = route.indexOf("publishPost({");
  assert.ok(guard > 0 && guard < call, "a disconnected account must be refused before the provider call");
  const block = route.slice(guard, call);
  assert.match(block, /status: "failed"/);
  assert.match(block, /account in Settings to publish here./);
  assert.match(block, /continue;/, "and nothing is published for that destination");
  // The resolver itself never substitutes a different account for a named one.
  const choice = resolveDestinationConnection(summaryOf(account("ig-1")), { socialConnectionId: "ig-gone" });
  assert.deepEqual(choice, { kind: "explicit", connectionId: "ig-gone" });
});

// ── the publish is metered exactly once, like every other publish ────────────
// The frozen 5B contract: ONE unit per piece of content published, whatever it fans
// out to. This route was never metered, so a social-only publish cost nothing while
// the same Content published to Pinterest was charged — a free bypass of the quota.
section("/api/publish/social meters the Content it publishes");

const pinsRoute = readFileSync("src/app/api/pinterest/pins/route.ts", "utf8");

test("the Content is consumed exactly once per request", () => {
  const calls = route.split("consumeScheduledPost(").length - 1;
  assert.equal(calls, 1, "a second consume would charge one publish twice");
});

test("the meter runs BEFORE any destination is dispatched", () => {
  const meterAt = route.indexOf("await consumeScheduledPost(");
  const loopAt = route.indexOf("for (const raw of requested)");
  const publishAt = route.indexOf("publishPost({");
  assert.ok(meterAt > 0 && loopAt > meterAt && publishAt > meterAt,
    "metering after dispatch loses the action whenever the run dies mid-publish");
});

test("it uses the SAME key derivation as the Pinterest route (draft id + UTC day)", () => {
  // Same two arguments, no provider and no connection id: that identity is what makes a
  // Pinterest + Instagram publish of ONE Content collapse onto ONE ledger row.
  const shape = /deriveScheduledPostKey[(]uid, [A-Za-z][A-Za-z0-9]*[)]/;
  assert.match(route, shape);
  assert.match(pinsRoute, shape, "the Pinterest route must still derive it the same way");
  assert.ok(!/deriveScheduledPostKey[(][^)]*provider/.test(route),
    "keying per platform would charge a fan-out once per destination");
  assert.ok(!/deriveScheduledPostKey[(][^)]*connection/i.test(route),
    "keying per account would charge a two-account platform twice");
});

test("a request that dispatches nothing is not charged", () => {
  const guard = /if [(]postId && publishableRequests[.]length > 0[)]/;
  assert.match(route, guard, "no publishable destination ⇒ no unit consumed");
  // Pinterest is published (and metered) by its own route, so it must not be what makes
  // this one charge — otherwise a Pinterest-only request pays twice.
  const filterAt = route.indexOf("const publishableRequests");
  const filterBody = route.slice(filterAt, route.indexOf("});", filterAt));
  assert.match(filterBody, /provider !== "pinterest"/);
  assert.match(filterBody, /liveConnect/, "a platform with no publish path is never charged");
});

test("metering never blocks the publish (shadow / fail-open)", () => {
  const meterAt = route.indexOf("await consumeScheduledPost(");
  const after = route.slice(meterAt, meterAt + 400);
  assert.ok(!/status: 4[0-9][0-9]/.test(after), "enforcement is Phase 6C — nothing here may refuse");
  assert.ok(!route.includes("scheduled_post_limit_reached"),
    "the limit body must not be wired into this route yet");
});


console.log(`\nPublish social account guard: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
