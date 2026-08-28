/**
 * test-social-reconnect-identity.ts — Codex #5: a Facebook/Instagram Reconnect is
 * bound to the account it was aimed at.
 *
 * Run: npx tsx scripts/test-social-reconnect-identity.ts
 *
 * The bug this locks down: both connect routes accepted `reconnect=<id>`, but only
 * ever used it to skip the plan gate. It was never carried to the callback, so when
 * the merchant authorized as a DIFFERENT account the store fell back to matching by
 * identity, found no row, and INSERTED one — a plan slot spent on an account they
 * never meant to add, while the account they were repairing stayed disconnected,
 * with nothing on screen saying so.
 *
 * Four things have to hold, and each of them can regress independently:
 *   1. The target id survives the OAuth round trip (sealed state, both providers),
 *      and a cookie sealed BEFORE the field existed still unseals as a plain connect.
 *   2. The decision is right: same account → update that row; different account →
 *      refuse; target gone → plain connect; target with no recorded identity → adopt.
 *   3. The stores obey it against a faked Supabase — a reconnect that matches does
 *      ZERO inserts, and an unidentified target row is updated rather than duplicated
 *      even when the user has two rows on that platform.
 *   4. The callbacks refuse BEFORE any write. The Facebook callback has FIVE upsert
 *      call sites (including the missing-scopes branch that runs before Page
 *      discovery); a gate that only covers the last one still persists a mismatched
 *      authorization.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Module from "node:module";

// Env must be set BEFORE the server modules load: the oauthState/store modules
// build their cipher at import time. Mirrors test-facebook-pages.ts.
process.env.FACEBOOK_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
process.env.INSTAGRAM_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
(process.env as Record<string, string | undefined>).NODE_ENV = "production";

// ── Faked Supabase, same seam as test-facebook-pages.ts ──────────────────────
// Intercepting `createServerClient` is what makes these behavioural rather than
// source-text assertions: we can see WHICH row a write landed on, and whether an
// insert happened at all.
type FakeRow = Record<string, unknown> & { id: string };
type FakeOp = { op: "select" | "update" | "insert"; eq: Array<[string, unknown]>; matched: string[] };
let fakeRows: FakeRow[] = [];
let fakeOps: FakeOp[] = [];

function fakeServerClient() {
  return {
    from(_table: string) {
      const eq: Array<[string, unknown]> = [];
      let op: FakeOp["op"] = "select";
      let payload: Record<string, unknown> | undefined;
      const settle = () => {
        // Every recorded .eq() is applied, so a query that DROPPED .eq("user_id")
        // would visibly match rows it must not see.
        const matched = fakeRows.filter(r => eq.every(([col, val]) => r[col] === val));
        if (op === "update" && payload) for (const row of matched) Object.assign(row, payload);
        fakeOps.push({ op, eq: [...eq], matched: matched.map(r => r.id) });
        return Promise.resolve({
          data: op === "select" ? matched.map(r => ({ ...r })) : null,
          error: null,
        });
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (p: Record<string, unknown>) => { op = "update"; payload = p; return builder; },
        insert: (p: Record<string, unknown>) => { op = "insert"; payload = p; return settle(); },
        eq: (col: string, val: unknown) => { eq.push([col, val]); return builder; },
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => settle().then(ok, err),
      };
      return builder;
    },
  };
}

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: unknown, isMain: boolean
) {
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase")) {
    return { createServerClient: fakeServerClient, createClient: fakeServerClient };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

export {};

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Source with comments removed.
 *
 * Needed because several assertions below say "this pattern must NOT appear" — and
 * the comments explaining why it was removed naturally quote the very pattern. A
 * prose mention is not a code path.
 */
function stripComments(src: string): string {
  const block = String.raw`/\*[\s\S]*?\*/`;
  // The newline is written as a two-character escape for the RegExp
  // constructor; a raw newline inside the class works but reads like a typo.
  const line = "//[^\n]*";
  return src.replace(new RegExp(block + "|" + line, "g"), "");
}

/** Fake token — never a real credential. */
const TOKEN = "TEST-TOKEN-not-a-real-credential";

function resetDb(rows: FakeRow[]) {
  fakeRows = rows.map(r => ({ ...r }));
  fakeOps = [];
}
const inserts = () => fakeOps.filter(o => o.op === "insert");
const updates = () => fakeOps.filter(o => o.op === "update");

async function main() {
  const { decideReconnect } = await import("../src/lib/server/social/reconnectIdentity");
  const fbState = await import("../src/lib/server/facebook/oauthState");
  const igState = await import("../src/lib/server/instagram/oauthState");
  const fbStore = await import("../src/lib/server/facebook/connectionStore");
  const igStore = await import("../src/lib/server/instagram/connectionStore");

  // ══ 1) The decision itself ════════════════════════════════════════════════
  console.log("\n=== 1) decideReconnect ===");

  await test("no reconnect target → plain connect (the store keeps deciding)", () => {
    const d = decideReconnect({
      reconnectTargetId: null,
      target: null,
      authorizedAccountId: "acc-1",
      authorizedLabel: "one",
    });
    assertEq(d.action, "proceed", "a plain Connect must never be refused");
    assert(d.action === "proceed" && d.targetConnectionId === null,
      "no row is named, so the store matches by identity exactly as before");
  });

  await test("reconnect + SAME account → update that exact row", () => {
    const d = decideReconnect({
      reconnectTargetId: "c1",
      target: { connectionId: "c1", accountId: "acc-1", label: "one" },
      authorizedAccountId: "acc-1",
      authorizedLabel: "one",
    });
    assert(d.action === "proceed" && d.targetConnectionId === "c1",
      "the repair must land on the row the merchant pressed Reconnect on");
  });

  await test("reconnect + DIFFERENT account → reject, carrying both labels", () => {
    const d = decideReconnect({
      reconnectTargetId: "c1",
      target: { connectionId: "c1", accountId: "acc-1", label: "one" },
      authorizedAccountId: "acc-2",
      authorizedLabel: "two",
    });
    assertEq(d.action, "reject", "this is the whole defect: it used to insert a second row");
    assert(d.action === "reject" && d.reason === "account_mismatch", "reason names the case");
    assert(d.action === "reject" && d.expectedLabel === "one" && d.gotLabel === "two",
      "both labels ride to the banner so it can name the two accounts");
  });

  await test("reconnect whose identity we could NOT read → reject, not adopt", () => {
    // Writing an unidentifiable token over a known account is the same silent swap
    // the gate exists to prevent, so a null identity is a refusal.
    const d = decideReconnect({
      reconnectTargetId: "c1",
      target: { connectionId: "c1", accountId: "acc-1", label: "one" },
      authorizedAccountId: null,
      authorizedLabel: null,
    });
    assertEq(d.action, "reject", "unknown ≠ matching");
  });

  await test("target row GONE (removed in another tab) → plain connect, not a refusal", () => {
    const d = decideReconnect({
      reconnectTargetId: "c1",
      target: null,
      authorizedAccountId: "acc-1",
      authorizedLabel: "one",
    });
    assert(d.action === "proceed" && d.targetConnectionId === null,
      "refusing would strand the merchant; the store's insert branch re-checks the plan");
  });

  await test("target with NO recorded identity → adopt it by id", () => {
    // Nothing to compare, and adopting is the only way that row ever gains an
    // identity. Naming the row is load-bearing — see the store test below.
    const d = decideReconnect({
      reconnectTargetId: "c1",
      target: { connectionId: "c1", accountId: null, label: null },
      authorizedAccountId: "acc-9",
      authorizedLabel: "nine",
    });
    assert(d.action === "proceed" && d.targetConnectionId === "c1", "must name the row explicitly");
  });

  // ══ 2) The OAuth state round trip ═════════════════════════════════════════
  console.log("\n=== 2) 密封 state 必须把重连目标带到 callback ===");

  for (const [name, mod] of [["facebook", fbState], ["instagram", igState]] as const) {
    await test(`${name}: sealState → verifyState carries the reconnect target`, () => {
      const state = mod.generateState();
      const sealed = mod.sealState(state, "user-1", "/app/settings/social", "conn-42");
      const verdict = mod.verifyState(sealed, state, "user-1");
      assert(verdict.ok, "a well-formed round trip must verify");
      assert(verdict.ok && verdict.reconnectConnectionId === "conn-42",
        "without this the callback cannot tell a repair from an 'add a second account'");
      assert(verdict.ok && verdict.returnTo === "/app/settings/social", "returnTo still survives");
    });

    await test(`${name}: a plain connect reads back as null, never undefined`, () => {
      const state = mod.generateState();
      const sealed = mod.sealState(state, "user-1", "/app/settings/social");
      const verdict = mod.verifyState(sealed, state, "user-1");
      assert(verdict.ok && verdict.reconnectConnectionId === null,
        "undefined would be truthy-checked wrong somewhere down the line");
    });

    await test(`${name}: the target is NOT readable from the state param itself`, () => {
      const state = mod.generateState();
      mod.sealState(state, "user-1", "/app/settings/social", "conn-42");
      assert(!state.includes("conn-42"),
        "the param handed to the provider stays opaque; only the sealed cookie carries it");
    });

    await test(`${name}: another user's session cannot redeem the sealed target`, () => {
      const state = mod.generateState();
      const sealed = mod.sealState(state, "user-1", "/app/settings/social", "conn-42");
      const verdict = mod.verifyState(sealed, state, "user-2");
      assert(!verdict.ok, "uid binding must still be checked before anything else");
    });
  }

  // ══ 3) The stores ═════════════════════════════════════════════════════════
  console.log("\n=== 3) store:重连命中 = UPDATE(零 insert)===");

  await test("facebook: reconnect + same identity → updates that row, ZERO inserts", async () => {
    resetDb([
      { id: "fb-a", user_id: "u1", provider: "facebook", metadata: { facebook: { facebookUserId: "FB1" } } },
      { id: "fb-b", user_id: "u1", provider: "facebook", metadata: { facebook: { facebookUserId: "FB2" } } },
    ]);
    await fbStore.upsertFacebookConnection("u1", {
      accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes: ["pages_show_list"],
      accountId: "FB1", accountName: "One", state: "connected", pages: [], selected: null,
    }, "fb-a");
    assertEq(inserts().length, 0, "re-authing an account you already have must never consume a slot");
    const ids = updates().flatMap(o => o.matched);
    assert(ids.includes("fb-a") && !ids.includes("fb-b"),
      "the write must land on the named row and only that row");
  });

  await test("facebook: an UNIDENTIFIED target row is updated, not duplicated", async () => {
    // The regression this exists for. The store's own rule only adopts a LONE
    // unidentified row; with a second row present it would fall through to INSERT.
    resetDb([
      { id: "fb-old", user_id: "u1", provider: "facebook", metadata: {} },
      { id: "fb-other", user_id: "u1", provider: "facebook", metadata: { facebook: { facebookUserId: "FB2" } } },
    ]);
    await fbStore.upsertFacebookConnection("u1", {
      accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes: [],
      accountId: "FB9", accountName: "Nine", state: "connected", pages: [], selected: null,
    }, "fb-old");
    assertEq(inserts().length, 0, "a repair must not fork a duplicate row (and eat a plan slot)");
    assert(updates().flatMap(o => o.matched).includes("fb-old"), "it must adopt the row it was aimed at");
  });

  await test("facebook: an explicit target whose identity DISAGREES is ignored", async () => {
    // Defence in depth: the callback already refused this case. If a target ever
    // reaches the store anyway, identity — not the caller's id — decides.
    resetDb([
      { id: "fb-a", user_id: "u1", provider: "facebook", metadata: { facebook: { facebookUserId: "FB1" } } },
      { id: "fb-b", user_id: "u1", provider: "facebook", metadata: { facebook: { facebookUserId: "FB2" } } },
    ]);
    await fbStore.upsertFacebookConnection("u1", {
      accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes: [],
      accountId: "FB2", accountName: "Two", state: "connected", pages: [], selected: null,
    }, "fb-a");
    const ids = updates().flatMap(o => o.matched);
    assert(ids.includes("fb-b"), "identity wins: FB2's own row is the one written");
    assert(!ids.includes("fb-a"), "the mismatched target must NOT be overwritten");
  });

  await test("facebook: a target id belonging to nobody resolves to nothing", async () => {
    resetDb([
      { id: "fb-a", user_id: "u1", provider: "facebook", metadata: { facebook: { facebookUserId: "FB1" } } },
    ]);
    await fbStore.upsertFacebookConnection("u1", {
      accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes: [],
      accountId: "FB1", accountName: "One", state: "connected", pages: [], selected: null,
    }, "not-this-users-row");
    assertEq(inserts().length, 0, "it still falls back to identity matching, which finds FB1's row");
    assert(updates().flatMap(o => o.matched).includes("fb-a"), "identity matching still applies");
  });

  await test("facebook: plain connect (no target) is unchanged — new account inserts", async () => {
    resetDb([
      { id: "fb-a", user_id: "u1", provider: "facebook", metadata: { facebook: { facebookUserId: "FB1" } } },
    ]);
    await fbStore.upsertFacebookConnection("u1", {
      accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes: [],
      accountId: "FB2", accountName: "Two", state: "connected", pages: [], selected: null,
    });
    assertEq(inserts().length, 1, "adding a genuinely new account must still create a row");
  });

  await test("facebook: getFacebookReconnectTarget is scoped to the caller's own rows", async () => {
    resetDb([
      { id: "fb-a", user_id: "u1", provider: "facebook", provider_account_name: "One",
        metadata: { facebook: { facebookUserId: "FB1", facebookUserName: "One" } } },
      { id: "fb-x", user_id: "u2", provider: "facebook", provider_account_name: "Someone else",
        metadata: { facebook: { facebookUserId: "FBX" } } },
    ]);
    const mine = await fbStore.getFacebookReconnectTarget("u1", "fb-a");
    assertEq(mine?.accountId, "FB1", "the compared field is metadata.facebook.facebookUserId");
    assertEq(mine?.label, "One", "the label names who signed in");
    const theirs = await fbStore.getFacebookReconnectTarget("u1", "fb-x");
    assertEq(theirs, null, "a forged id must never reach another merchant's row");
  });

  await test("facebook: a selected Page id must NOT be mistaken for the account identity", async () => {
    // provider_account_id becomes the PAGE id once a Page is chosen. Comparing it
    // against a Facebook USER id would report a mismatch on every healthy account.
    resetDb([
      { id: "fb-a", user_id: "u1", provider: "facebook", provider_account_id: "PAGE-123",
        provider_account_name: "My Page",
        metadata: { facebook: { facebookUserId: "FB1", facebookUserName: "One" } } },
    ]);
    const t = await fbStore.getFacebookReconnectTarget("u1", "fb-a");
    assertEq(t?.accountId, "FB1", "must read the user id, not PAGE-123");
    const d = decideReconnect({
      reconnectTargetId: "fb-a", target: t, authorizedAccountId: "FB1", authorizedLabel: "One",
    });
    assertEq(d.action, "proceed", "the same person reconnecting must not be refused");
  });

  await test("instagram: reconnect + same identity → updates that row, ZERO inserts", async () => {
    resetDb([
      { id: "ig-a", user_id: "u1", provider: "instagram", provider_account_id: "IG1", metadata: {} },
      { id: "ig-b", user_id: "u1", provider: "instagram", provider_account_id: "IG2", metadata: {} },
    ]);
    await igStore.upsertInstagramConnection("u1", {
      accessToken: TOKEN, expiresAt: null, scopes: [], accountId: "IG1",
      username: "one", name: "One", accountType: "BUSINESS", state: "connected",
    }, "ig-a");
    assertEq(inserts().length, 0, "a repair must never consume a slot");
    const ids = updates().flatMap(o => o.matched);
    assert(ids.includes("ig-a") && !ids.includes("ig-b"), "only the named row is written");
  });

  await test("instagram: an UNIDENTIFIED target row is updated, not duplicated", async () => {
    resetDb([
      { id: "ig-old", user_id: "u1", provider: "instagram", metadata: {} },
      { id: "ig-other", user_id: "u1", provider: "instagram", provider_account_id: "IG2", metadata: {} },
    ]);
    await igStore.upsertInstagramConnection("u1", {
      accessToken: TOKEN, expiresAt: null, scopes: [], accountId: "IG9",
      username: "nine", name: "Nine", accountType: "BUSINESS", state: "connected",
    }, "ig-old");
    assertEq(inserts().length, 0, "no duplicate row");
    assert(updates().flatMap(o => o.matched).includes("ig-old"), "adopts the row it was aimed at");
  });

  await test("instagram: an explicit target whose identity DISAGREES is ignored", async () => {
    resetDb([
      { id: "ig-a", user_id: "u1", provider: "instagram", provider_account_id: "IG1", metadata: {} },
      { id: "ig-b", user_id: "u1", provider: "instagram", provider_account_id: "IG2", metadata: {} },
    ]);
    await igStore.upsertInstagramConnection("u1", {
      accessToken: TOKEN, expiresAt: null, scopes: [], accountId: "IG2",
      username: "two", name: "Two", accountType: "BUSINESS", state: "connected",
    }, "ig-a");
    const ids = updates().flatMap(o => o.matched);
    assert(ids.includes("ig-b") && !ids.includes("ig-a"), "identity stays the source of truth");
  });

  await test("instagram: plain connect (no target) is unchanged — new account inserts", async () => {
    resetDb([
      { id: "ig-a", user_id: "u1", provider: "instagram", provider_account_id: "IG1", metadata: {} },
    ]);
    await igStore.upsertInstagramConnection("u1", {
      accessToken: TOKEN, expiresAt: null, scopes: [], accountId: "IG2",
      username: "two", name: "Two", accountType: "BUSINESS", state: "connected",
    });
    assertEq(inserts().length, 1, "adding a genuinely new account must still create a row");
  });

  await test("instagram: getInstagramReconnectTarget is scoped to the caller's own rows", async () => {
    resetDb([
      { id: "ig-a", user_id: "u1", provider: "instagram", provider_account_id: "IG1",
        provider_account_username: "one", metadata: {} },
      { id: "ig-x", user_id: "u2", provider: "instagram", provider_account_id: "IGX", metadata: {} },
    ]);
    const mine = await igStore.getInstagramReconnectTarget("u1", "ig-a");
    assertEq(mine?.accountId, "IG1", "the compared field is provider_account_id");
    assertEq(mine?.label, "one", "@handle names the account in the banner");
    assertEq(await igStore.getInstagramReconnectTarget("u1", "ig-x"), null,
      "a forged id must never reach another merchant's row");
  });

  // ══ 4) The callbacks refuse before any write ══════════════════════════════
  console.log("\n=== 4) callback:错配时一个字都不写 ===");

  const fbCb = read("src/app/api/auth/facebook/callback/route.ts");
  const igCb = read("src/app/api/auth/instagram/callback/route.ts");
  const fbConnect = read("src/app/api/auth/facebook/connect/route.ts");
  const igConnect = read("src/app/api/auth/instagram/connect/route.ts");

  await test("facebook connect seals the reconnect id into the state cookie", () => {
    assert(fbConnect.includes("sealState(state, uid, returnTo, reconnectConnectionId)"),
      "the id must ride in the sealed cookie, not just gate the quota check");
    assert(fbConnect.includes("attachOAuthStateCookie(res, req, payload.state, uid, returnTo, reconnectId)"),
      "both GET and POST entry points must pass it");
    assertEq(fbConnect.split("uid, returnTo, reconnectId)").length - 1, 2,
      "GET (browser nav) and POST (Bearer fetch) are two separate call sites");
  });

  await test("instagram connect seals the reconnect id into the state cookie", () => {
    assert(igConnect.includes("sealState(state, uid, returnTo, reconnectConnectionId)"), "sealed");
    assertEq(igConnect.split("uid, returnTo, reconnectId)").length - 1, 2, "GET + POST");
  });

  for (const [name, src] of [["facebook", fbCb], ["instagram", igCb]] as const) {
    await test(`${name} callback: mismatch redirects account_mismatch with expected/got`, () => {
      assert(src.includes('redirectAfterOAuth(req, "account_mismatch", verdict.returnTo, {'),
        "the panel keys its banner off this exact flag");
      assert(src.includes("expected: decision.expectedLabel"), "expected label rides in the query");
      assert(src.includes("got: decision.gotLabel"), "got label rides in the query");
    });

    await test(`${name} callback: the gate runs BEFORE every write`, () => {
      const gateAt = src.indexOf('decision.action === "reject"');
      assert(gateAt > 0, "the refusal must exist");
      // Every upsert in the file has to come after the gate — the Facebook callback
      // writes in its missing-scopes branch too, long before Page discovery.
      const upsert = name === "facebook" ? "upsertFacebookConnection(uid" : "upsertInstagramConnection(uid";
      let i = src.indexOf(upsert);
      assert(i > 0, "there is at least one write");
      while (i > 0) {
        assert(i > gateAt, `an upsert at ${i} precedes the mismatch gate — a refused reconnect would still persist`);
        i = src.indexOf(upsert, i + 1);
      }
    });

    await test(`${name} callback: a failed target read refuses instead of writing blind`, () => {
      assert(src.includes("reconnect target read failed"),
        "if we cannot read the row we are repairing, writing is the overwrite this prevents");
    });
  }

  await test("facebook callback: ALL FIVE upsert call sites carry the target row", () => {
    // Threading only the main one leaves the other four able to insert a duplicate.
    const threaded = fbCb.split("}, reconnectTargetId);").length - 1;
    assertEq(threaded, 5, "reconnect_required / auto-restore / restore-failed / first-connect / main");
    const calls = fbCb.split("upsertFacebookConnection(uid").length - 1;
    assertEq(calls, 5, "if a new write path appears it must be threaded too");
  });

  await test("instagram callback: compares the SAME id expression the upsert stores", () => {
    assert(igCb.includes("const authorizedAccountId = profile.userId || tokens.userId;"),
      "one expression, used by both the check and the write, so they cannot disagree");
    assert(igCb.includes("accountId: authorizedAccountId,"), "the upsert reuses it verbatim");
    assert(igCb.includes("}, reconnectTargetId);"), "and the target row is threaded through");
  });

  // ══ 5) The panel ══════════════════════════════════════════════════════════
  console.log("\n=== 5) 面板:三家共用同一张横幅 ===");

  const panel = read("src/components/social/SocialAccountsPanel.tsx");

  await test("the mismatch banner is raised for facebook and instagram too", () => {
    for (const p of ["pinterest", "facebook", "instagram"]) {
      assert(panel.includes(`setAccountMismatch({\n        provider: "${p}",`),
        `${p} must be able to raise the banner`);
    }
  });

  await test("the banner's CTAs act on the mismatched platform, not always Pinterest", () => {
    // 变量名从 `target` 变成 `resolvedReconnectTarget`:重试指向的不再是"记得的 id",
    // 而是"在当前连接列表里核验过还存在的那一行"(Codex #3)。语义没变:还是重连同一行。
    assert(
      panel.includes("void handleConnect(accountMismatch.provider, resolvedReconnectTarget);"),
      "Sign in to the original restarts a RECONNECT on the same row",
    );
    assert(panel.includes("void handleConnect(accountMismatch.provider);"),
      "Add as a new account is a PLAIN connect (so the plan gate applies)");
    assert(!panel.includes('void handleConnect("pinterest", target)'), "the hard-coded provider must be gone");
  });

  await test("the flag is consumed before the toast map, so it never falls through", () => {
    for (const p of ["facebook", "instagram"]) {
      const effectAt = panel.indexOf(`const flag = params.get("${p}");`);
      const gateAt = panel.indexOf('flag === "account_mismatch"', effectAt);
      const mapAt = panel.indexOf(`${p.toUpperCase()}_CALLBACK_MESSAGES[flag]`, effectAt);
      assert(effectAt > 0 && gateAt > effectAt && mapAt > gateAt,
        `${p}: the mismatch early-return must sit before the message-map lookup`);
    }
  });

  await test("the banner copy is provider-neutral", () => {
    const en = read("src/lib/i18n/messages/en/socialPanel.ts");
    assert(en.includes('"socialPanel.mismatch.title": "That\'s a different {platform} account"'),
      "the title must take the platform as a placeholder, not hard-code Pinterest");
    assert(!/socialPanel\.mismatch\.[A-Za-z]+": "[^"]*Pinterest/.test(en),
      "no mismatch string may name one platform any more");
    assert(panel.includes('.replace("{platform}", PLATFORMS[provider].name)'), "and it must be filled in");
    // Facebook names a person/Page — "@Name" would simply be wrong there.
    assert(panel.includes('return provider === "facebook" ? value : `@${value}`;'),
      "the @handle prefix must not be applied to Facebook");
  });

  await test("Pinterest keeps its existing test ids", () => {
    assert(panel.includes("data-testid={`${provider}-account-mismatch`}"),
      "parameterised, so pinterest still renders pinterest-account-mismatch");
    for (const t of ["signin-original", "add-new", "dismiss"]) {
      assert(panel.includes("data-testid={`${provider}-mismatch-" + t + "`}"), t);
    }
  });

  // ── Codex #3: the target survives the OAuth round trip ─────────────────────
  // Connect is a FULL-PAGE navigation. The panel's `reconnectTargetId` state does
  // not survive it, so on the way back the mismatch banner had no idea which row was
  // being repaired and fell back to `accounts[0]`. For a merchant fixing their
  // SECOND Instagram account that is the wrong row every single time — and the retry
  // then re-authorizes against an account they never chose.
  console.log("\n=== 5) the reconnect target rides back with the refusal ===");

  await test("all three mismatch redirects carry target=<connectionId>", () => {
    const pinCb = read("src/app/api/auth/pinterest/callback/route.ts");

    // FB/IG hand it to the shared redirect helper, which only sets truthy values —
    // so a plain (non-reconnect) connect never grows a stray empty param.
    for (const [name, src] of [["facebook", fbCb], ["instagram", igCb]] as const) {
      const at = src.indexOf('redirectAfterOAuth(req, "account_mismatch"');
      assert(at > 0, `${name}: mismatch redirect not found`);
      const block = src.slice(at, at + 900);
      assert(block.includes("target: verdict.reconnectConnectionId"),
        `${name}: the refusal must name the row being repaired`);
    }

    // Pinterest builds its URL by hand, so it sets the param directly.
    assert(
      pinCb.includes('url.searchParams.set("target", verdict.reconnectConnectionId)'),
      "pinterest: the refusal must carry the target too",
    );
    // Guard: only when there IS one. A plain connect has no target, and an empty
    // `target=` would be an id the panel then has to reject at every use site.
    assert(
      pinCb.includes('if (verdict.reconnectConnectionId) url.searchParams.set("target"'),
      "pinterest must not emit an empty target on a plain connect",
    );
  });

  await test("the panel restores the target from the flag, for all three providers", () => {
    // Once per provider handler — and BEFORE router.replace strips the query.
    const restores = panel.split('setReconnectTargetId(params.get("target"))').length - 1;
    assert(restores === 3, `expected 3 target restores (fb/pinterest/instagram), found ${restores}`);
    for (const provider of ["facebook", "pinterest", "instagram"]) {
      const at = panel.indexOf(`provider: "${provider}",\n        expected: params.get("expected")`);
      assert(at > 0, `${provider}: mismatch handler not found`);
      const block = panel.slice(at, at + 900);
      const restoreAt = block.indexOf('setReconnectTargetId(params.get("target"))');
      const stripAt = block.indexOf("router.replace(SETTINGS_SOCIAL_PATH)");
      assert(restoreAt > 0, `${provider}: must restore the target from the URL`);
      assert(stripAt > restoreAt,
        `${provider}: the target must be read BEFORE the query is stripped`);
    }
  });

  await test("the target is verified against the live list, never trusted blind", () => {
    // The id is the user's own and was validated server-side, but the row can be
    // removed in another tab while the flow is away — and as far as this component
    // is concerned the query string is untrusted input.
    const at = panel.indexOf("const resolvedReconnectTarget = useMemo(");
    assert(at > 0, "the resolved target must be derived, not read straight from state");
    const block = panel.slice(at, at + 700);
    assert(
      block.includes("platform?.accounts.some(a => a.id === reconnectTargetId)"),
      "the id must be matched against the CURRENT connection list",
    );
    assert(block.includes("? reconnectTargetId : null"),
      "an id that is not in the list must resolve to null, not to some other row");
  });

  await test("an unknown target disables the retry — it never falls back to accounts[0]", () => {
    // This is the whole defect. `accounts[0]` is a guess that looks like an answer.
    const at = panel.indexOf("<AccountMismatchNotice");
    assert(at > 0, "the mismatch banner must still be rendered");
    const block = panel.slice(at, at + 1600);
    assert(block.includes("canSignInToOriginal={!!resolvedReconnectTarget}"),
      "the button's enablement must come from the RESOLVED target");
    assert(block.includes("if (!resolvedReconnectTarget) return;"),
      "with no resolved target the handler must do nothing at all");
    assert(block.includes("void handleConnect(accountMismatch.provider, resolvedReconnectTarget)"),
      "the retry must aim at the resolved row");
    // 只看代码:注释里正解释着“曾经回退到 accounts[0]”,那句话本身不是回退。
    const code = stripComments(block);
    assert(!/accounts\[0\]/.test(code),
      "the accounts[0] fallback must be gone from the mismatch CTA");

    // And the button itself must actually be disabled + explain why.
    const btnAt = panel.indexOf("data-testid={`${provider}-mismatch-signin-original`}");
    assert(btnAt > 0, "the retry button must still exist");
    const btn = panel.slice(btnAt, btnAt + 700);
    assert(btn.includes("disabled={signInDisabled}"), "the retry must be disabled, not just inert");
    assert(btn.includes('tr("socialPanel.mismatch.targetUnknown")'),
      "a disabled button with no explanation is a dead end");
    assert(
      panel.includes("const signInDisabled = busy || !canSignInToOriginal;"),
      "disabled = busy OR unresolvable",
    );

    const en = read("src/lib/i18n/messages/en/socialPanel.ts");
    assert(en.includes('"socialPanel.mismatch.targetUnknown"'), "the explanation needs a real key");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

void main();
