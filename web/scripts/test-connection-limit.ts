/**
 * Per-platform connected-account limit — the last advertised allowance that had
 * no enforcement (pricing has always said 1/1/2/3, code counted nothing).
 *
 * What this pins:
 *   - the ceiling comes from planEntitlements (one source), per plan
 *   - it is PER PLATFORM: being full on Facebook never blocks Instagram
 *   - only a NEW connection is checked; re-auth of an existing account is not,
 *     so an at-limit user can still repair a connection they already have
 *   - EVERY row held occupies a slot, disconnected ones included; only Remove
 *     (a hard delete) frees one (PRD 0805 §11)
 *   - it FAILS OPEN: a missing table / unreachable DB / unresolvable plan lets
 *     the connect through, because a broken limit check must not become a second
 *     availability dependency on OAuth
 *   - grandfathering: someone already over the ceiling is not revoked, only
 *     blocked from adding more
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert";
import { readFileSync } from "node:fs";

// connectionLimit pulls in @/lib/supabase, which constructs a client at module
// load, so it is imported INSIDE the async IIFE — after the env assignments above,
// and held as a module object (the tsx CJS transform has no top-level await).
type LimitModule = typeof import("../src/lib/server/social/connectionLimit");
let L: LimitModule;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${(err as Error)?.message ?? err}`); failed++; }
}

/** Drive the check with a fixed plan and a fixed existing-count. */
function deps(plan: string, count: number | null) {
  return {
    resolvePlanFn: (async () => plan) as never,
    countExisting: async () => count,
  };
}

(async () => {
  L = await import("../src/lib/server/social/connectionLimit");
  const check = L.canConnectAnotherAccount;

  console.log("=== per-platform connected-account limit ===\n");

  await test("free allows 1: first connection passes, second is refused", async () => {
    assert.equal((await check("u", "facebook", deps("free", 0))).allowed, true);
    const v = await check("u", "facebook", deps("free", 1));
    assert.equal(v.allowed, false);
    if (!v.allowed) assert.equal(v.limit, 1);
  });

  await test("pro allows 2", async () => {
    assert.equal((await check("u", "facebook", deps("pro", 1))).allowed, true);
    assert.equal((await check("u", "facebook", deps("pro", 2))).allowed, false);
  });

  await test("business allows 3", async () => {
    assert.equal((await check("u", "facebook", deps("business", 2))).allowed, true);
    assert.equal((await check("u", "facebook", deps("business", 3))).allowed, false);
  });

  await test("starter allows 1 — paid tiers differ on volume, not on this", async () => {
    assert.equal((await check("u", "instagram", deps("starter", 0))).allowed, true);
    assert.equal((await check("u", "instagram", deps("starter", 1))).allowed, false);
  });

  await test("being full on one platform does NOT block another", async () => {
    // The count is scoped by provider: a full Facebook says nothing about Instagram.
    const fb = await check("u", "facebook", deps("free", 1));
    const ig = await check("u", "instagram", deps("free", 0));
    assert.equal(fb.allowed, false, "facebook is full");
    assert.equal(ig.allowed, true, "instagram must still be connectable");
  });

  await test("an uncountable table fails OPEN — never block on a broken count", async () => {
    assert.equal((await check("u", "facebook", deps("free", null))).allowed, true);
  });

  await test("an unresolvable plan fails OPEN", async () => {
    const v = await check("u", "facebook", {
      resolvePlanFn: (async () => { throw new Error("entitlements unreachable"); }) as never,
      countExisting: async () => 99,
    });
    assert.equal(v.allowed, true, "an entitlements outage must not break connecting");
  });

  await test("a thrown count fails OPEN", async () => {
    const v = await check("u", "facebook", {
      resolvePlanFn: (async () => "free") as never,
      countExisting: async () => { throw new Error("db down"); },
    });
    assert.equal(v.allowed, true);
  });

  await test("already OVER the ceiling is blocked from adding, not revoked", async () => {
    // Someone who connected 5 before this shipped keeps all 5 — nothing here
    // deletes anything — but cannot add a 6th.
    const v = await check("u", "facebook", deps("free", 5));
    assert.equal(v.allowed, false);
    if (!v.allowed) {
      assert.equal(v.current, 5, "the real count is reported, not clamped");
      assert.equal(v.limit, 1);
    }
  });

  await test("the refusal body carries a stable code and an actionable message", async () => {
    const v = await check("u", "facebook", deps("free", 1));
    assert.equal(v.allowed, false);
    if (v.allowed) return;
    const body = L.connectionLimitResponseBody(v);
    assert.equal(body.code, "connected_account_limit_reached");
    assert.equal(body.limit, 1);
    // Under the row-counting rule only Remove (a hard delete) frees a seat, so the
    // refusal must not send the merchant to Disconnect — that keeps both the row and
    // the slot, and they would come back no less full than before.
    assert.match(body.error, /Remove one, or upgrade/);
    assert.doesNotMatch(body.error, /Disconnect/i, "Disconnect no longer frees a seat, so it must not be the advice");
    assert.doesNotMatch(body.error, /credit/i, "the retired Credit vocabulary must not reappear");
  });

  await test("the error type carries the verdict for callers to map", () => {
    const err = new L.ConnectionLimitError({ allowed: false, limit: 2, current: 2, plan: "pro" });
    assert.equal(err.name, "ConnectionLimitError");
    assert.equal(err.verdict.limit, 2);
    assert.ok(err instanceof Error, "must stay catchable as a normal Error");
  });

  await test("the stores check the limit ONLY on the insert path", () => {
    // Both upserts return early from the UPDATE branch, so the check sits after
    // that return. Asserted from source so a refactor that hoists it above the
    // update — silently blocking re-auth — fails here.
    for (const path of [
      "src/lib/server/facebook/connectionStore.ts",
      "src/lib/server/instagram/connectionStore.ts",
    ]) {
      const src = readFileSync(path, "utf8");
      const atUpdate = src.indexOf(".update(payload)");
      const atCheck = src.lastIndexOf("await canConnectAnotherAccount(");
      const atInsert = src.indexOf(".insert({ user_id: uid");
      assert.ok(atUpdate > 0, `${path}: update branch not found`);
      assert.ok(atCheck > 0, `${path}: limit check not found`);
      assert.ok(atInsert > 0, `${path}: insert not found`);
      assert.ok(atCheck > atUpdate, `${path}: the check must come AFTER the update branch`);
      assert.ok(atCheck < atInsert, `${path}: the check must come BEFORE the insert`);
    }
  });

  await test("disconnected rows STILL count — Disconnect keeps the account and its slot", async () => {
    // Owner decision 2026-08-27 / PRD 0805 §11. Disconnect is reversible: the row
    // stays, listed in Settings as "Disconnected" with a Reconnect, and it goes on
    // holding the seat. So the count must not filter it out. Which rows are counted
    // is a PostgREST predicate, so it is asserted at the source — no pure function
    // can prove a query.
    const allowance = readFileSync("src/lib/server/social/accountAllowance.ts", "utf8");
    assert.ok(
      !allowance.includes('.is("disconnected_at", null)'),
      "a disconnected row keeps its slot (Pinterest writes disconnected_at)",
    );
    assert.ok(
      !allowance.includes('.not("access_token_encrypted", "is", null)'),
      "a soft-disconnected FB/IG row (token nulled) keeps its slot too",
    );
    assert.ok(
      allowance.includes("export async function countConnectionsByProvider("),
      "the count is of ROWS held, and is named so",
    );
    const limitSrc = readFileSync("src/lib/server/social/connectionLimit.ts", "utf8");
    assert.ok(
      !limitSrc.includes('{ count: "exact", head: true }'),
      "this module still owns no query of its own — one rule, one place",
    );
    // The consequence at the seat level: a Free user whose single account is merely
    // disconnected is still full.
    assert.equal((await check("u", "facebook", deps("free", 1))).allowed, false);
  });

  await test("a REMOVED row frees the slot — the row is deleted, so it leaves the count", async () => {
    // Remove is the hard delete (see test-per-account-disconnect.ts for the routes),
    // and the only action that gives a seat back. Once the row is gone the same Free
    // user can connect again — which is why counting every row is not the old
    // one-way ratchet, where nothing a user could do ever freed a seat.
    assert.equal((await check("u", "facebook", deps("free", 0))).allowed, true);
  });


  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
