/**
 * test-account-allowance.ts — the ONE rule that decides "may this user connect
 * another social account?" (lib/server/social/accountAllowance.ts).
 *
 * Run: npx tsx scripts/test-account-allowance.ts
 *
 * What this pins:
 *   1. the shared-pool formula, including the full acceptance walk-through from
 *      the design doc §5 (a Starter user with 1 included account per platform);
 *   2. the pool is SHARED across platforms — a slot spent on Pinterest is not
 *      available to Instagram;
 *   3. ROW counting: every account row the user holds occupies a slot, whatever its
 *      connection status — Disconnect keeps the account and its slot, only Remove
 *      (a hard delete) gives one back (PRD 0805 §11);
 *   4. fail-open on infrastructure trouble, but slots degrade to 0 rather than
 *      failing open — an unreadable add-on must not disable the ceiling;
 *   5. purchased slots = sum of `units` over ACCESS-GRANTING add-on subscriptions
 *      only (several subscriptions add up; a plan subscription is not an add-on;
 *      a lapsed scheduled_cancel grants nothing);
 *   6. nothing is revoked: someone already over the ceiling is refused a new
 *      account but keeps every one they have.
 *
 * "Free cannot buy" is enforced by the checkout route and is tested there
 * (test-creem-checkout-api.ts), where the refusal actually lives.
 */

// These modules build a Supabase client at import time; the placeholders keep that
// from throwing. Nothing here reaches a database — every IO path is injected.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
// The add-on products. isExtraAccountProduct reads env at CALL time, so a test may
// also clear these to exercise the "nothing to buy" path.
process.env.CREEM_PRODUCT_EXTRA_ACCOUNT_MONTHLY = "prod_extra_m";
process.env.CREEM_PRODUCT_EXTRA_ACCOUNT_YEARLY = "prod_extra_y";

export {};

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${(err as Error)?.message ?? err}`);
  }
}

type AllowanceModule = typeof import("../src/lib/server/social/accountAllowance");

/** A snapshot in the shape the pure rule consumes. */
function snapshot(
  included: number | null,
  connectionsByProvider: Record<string, number>,
  purchasedSlots = 0,
  plan: "free" | "starter" | "pro" | "business" = "starter",
) {
  return { plan, included, connectionsByProvider, purchasedSlots };
}

(async () => {
  const A: AllowanceModule = await import("../src/lib/server/social/accountAllowance");
  const { evaluateAllowance, evaluateAccountAllowance, sumExtraAccountUnits } = A;

  console.log("\n=== the pool formula ===\n");

  await test("inside the plan's included accounts → allowed, no slot spent", () => {
    const v = evaluateAllowance(snapshot(2, { pinterest: 1 }), "pinterest");
    assert.equal(v.allowed, true);
    assert.equal(v.reason, "included");
    assert.equal(v.slotsInUse, 0);
  });

  await test("at the included number with no slots → refused", () => {
    const v = evaluateAllowance(snapshot(1, { pinterest: 1 }), "pinterest");
    assert.equal(v.allowed, false);
    assert.equal(v.reason, "limit_reached");
  });

  await test("at the included number with one purchased slot → allowed", () => {
    const v = evaluateAllowance(snapshot(1, { pinterest: 1 }, 1), "pinterest");
    assert.equal(v.allowed, true);
    assert.equal(v.reason, "extra_slot");
    assert.equal(v.slotsAvailable, 1);
  });

  await test("a slot spent on one platform is NOT available to another (shared pool)", () => {
    // 1 included per platform, 1 slot bought, already 2 Pinterest accounts.
    const s = snapshot(1, { pinterest: 2, instagram: 1 }, 1);
    assert.equal(evaluateAllowance(s, "instagram").allowed, false, "pool already spent on Pinterest");
    assert.equal(evaluateAllowance(s, "facebook").allowed, true, "facebook is still inside its included 1");
  });

  await test("an uncapped plan (included = null) always allows", () => {
    const v = evaluateAllowance(snapshot(null, { pinterest: 99 }), "pinterest");
    assert.equal(v.allowed, true);
    assert.equal(v.reason, "uncapped");
  });

  await test("already OVER the ceiling: refused a new one, keeps the ones they have", () => {
    const v = evaluateAllowance(snapshot(1, { facebook: 5 }), "facebook");
    assert.equal(v.allowed, false);
    assert.equal(v.held, 5, "the real count is reported, not clamped");
    assert.equal(v.included, 1);
    // Nothing in the verdict asks anyone to disconnect — grandfathering is the
    // absence of a revoke, and this module never revokes.
  });

  console.log("\n=== design doc §5 acceptance walk-through (Starter, 1 per platform) ===\n");

  await test("connect 1 Pinterest, then 1 Instagram (different platform) → both allowed", () => {
    assert.equal(evaluateAllowance(snapshot(1, {}), "pinterest").allowed, true, "first Pinterest");
    assert.equal(
      evaluateAllowance(snapshot(1, { pinterest: 1 }), "instagram").allowed,
      true,
      "Instagram has its own included account",
    );
  });

  await test("a SECOND Pinterest is refused before any slot is bought", () => {
    assert.equal(
      evaluateAllowance(snapshot(1, { pinterest: 1, instagram: 1 }), "pinterest").allowed,
      false,
    );
  });

  await test("buy 1 slot → the second Pinterest is allowed", () => {
    assert.equal(
      evaluateAllowance(snapshot(1, { pinterest: 1, instagram: 1 }, 1), "pinterest").allowed,
      true,
    );
  });

  await test("with that slot now spent, a second Instagram is still refused", () => {
    assert.equal(
      evaluateAllowance(snapshot(1, { pinterest: 2, instagram: 1 }, 1), "instagram").allowed,
      false,
    );
  });

  await test("buy a second slot → the second Instagram is allowed", () => {
    assert.equal(
      evaluateAllowance(snapshot(1, { pinterest: 2, instagram: 1 }, 2), "instagram").allowed,
      true,
    );
  });

  await test("canceling the add-on refuses new accounts but revokes nothing", () => {
    const v = evaluateAllowance(snapshot(1, { pinterest: 2, instagram: 2 }, 0), "pinterest");
    assert.equal(v.allowed, false, "no more new accounts");
    assert.equal(v.held, 2, "the four they already hold are untouched");
    assert.equal(v.slotsInUse, 2, "they are 2 over the included allowance");
  });

  console.log("\n=== counting: every row held, until it is REMOVED ===\n");

  await test("a disconnected row still occupies its slot — the query filters nothing", () => {
    // Source-level on purpose: what the count includes is a PostgREST predicate, so
    // no pure function can prove it. These are the filters that must NOT be there.
    const src = readFileSync("src/lib/server/social/accountAllowance.ts", "utf8");
    assert.ok(
      !src.includes('.is("disconnected_at", null)'),
      "a disconnected row keeps its slot — excluding it would hand back a slot it still holds",
    );
    assert.ok(
      !src.includes('.not("access_token_encrypted", "is", null)'),
      "a token-less row (a soft-disconnected FB/IG account) keeps its slot too",
    );
    assert.ok(
      src.includes("export async function countConnectionsByProvider("),
      "the counting function is named for what it counts: rows, not active rows",
    );
    assert.ok(
      !src.includes("countActiveConnectionsByProvider"),
      "the old active-only name must not survive alongside the new rule",
    );
  });

  await test("disconnect then reconnect: the slot was never released, so nothing new is spent", async () => {
    // A Starter (1 per platform) merchant who disconnects their only Pinterest row
    // still holds it, so a NEW account is refused. Reconnecting THAT row never reaches
    // this rule at all — it is an UPDATE (see the callback's addsAnAccount, asserted
    // in test-account-quota.ts), which is what stops the count from becoming a trap.
    const v = await evaluateAccountAllowance("u", "pinterest", {
      plan: "starter",
      countConnections: async () => ({ pinterest: 1 }),
      purchasedSlots: async () => 0,
    });
    assert.equal(v.allowed, false, "a disconnected row is not a free seat");
    assert.equal(v.held, 1);
  });

  await test("REMOVE frees the slot: the row leaves the table, so the count drops", async () => {
    // The counting rule and the hard delete are two halves of one decision — Remove
    // is the only action that changes this number.
    const v = await evaluateAccountAllowance("u", "pinterest", {
      plan: "starter",
      countConnections: async () => ({ pinterest: 0 }),
      purchasedSlots: async () => 0,
    });
    assert.equal(v.allowed, true, "after Remove the merchant can connect again");
  });

  await test("connectionLimit owns no count of its own — one rule, one query", () => {
    const src = readFileSync("src/lib/server/social/connectionLimit.ts", "utf8");
    assert.ok(
      !src.includes('{ count: "exact", head: true }'),
      "counting belongs to accountAllowance; a second query here is a second rule",
    );
    assert.ok(src.includes("evaluateAccountAllowance"), "it delegates to the one rule");
  });

  await test("swap an account at the limit: REMOVE A, connect B → allowed", async () => {
    // The way out of a full platform is Remove, not Disconnect: removing deletes the
    // row, so it leaves the count. This is why counting every row is not the old
    // one-way ratchet — then, nothing the user could do freed a seat.
    const v = await evaluateAccountAllowance("u", "facebook", {
      plan: "starter",
      countConnections: async () => ({ facebook: 0 }),
      purchasedSlots: async () => 0,
    });
    assert.equal(v.allowed, true);
  });

  console.log("\n=== failure semantics ===\n");

  await test("counts unavailable → fail OPEN (an outage must not block connecting)", async () => {
    const v = await evaluateAccountAllowance("u", "facebook", {
      plan: "free",
      countConnections: async () => null,
      purchasedSlots: async () => 0,
    });
    assert.equal(v.allowed, true);
    assert.equal(v.reason, "unavailable");
  });

  await test("a thrown plan lookup → fail OPEN", async () => {
    const v = await evaluateAccountAllowance("u", "facebook", {
      resolvePlanFn: async () => {
        throw new Error("entitlements unreachable");
      },
      countConnections: async () => ({ facebook: 9 }),
      purchasedSlots: async () => 0,
    });
    assert.equal(v.allowed, true);
  });

  await test("a caller-supplied count still enforces when the grouped query fails", async () => {
    // The OAuth callback counted the rows itself. Losing the cross-platform view
    // must not hand out a free pass on the platform we DO know about.
    const v = await evaluateAccountAllowance("u", "pinterest", {
      plan: "starter",
      countConnections: async () => null,
      countOverride: { provider: "pinterest", count: 1 },
      purchasedSlots: async () => 0,
    });
    assert.equal(v.allowed, false, "1 row held on a 1-account plan is still full");
  });

  await test("slots unavailable degrade to 0 — never to 'unlimited'", async () => {
    const v = await evaluateAccountAllowance("u", "facebook", {
      plan: "starter",
      countConnections: async () => ({ facebook: 1 }),
      purchasedSlots: async () => 0, // what getPurchasedExtraSlots returns on error
    });
    assert.equal(v.allowed, false, "an unreadable add-on must not disable the ceiling");
  });

  console.log("\n=== purchased slots = sum of units over granting add-on rows ===\n");

  const addOn = (over: Record<string, unknown> = {}) => ({
    creem_product_id: "prod_extra_m",
    units: 1 as unknown,
    plan: null,
    status: "active",
    last_event_at: "2026-08-01T00:00:00.000Z",
    current_period_end: null as string | null,
    ...over,
  });

  await test("units are summed across several add-on subscriptions", () => {
    assert.equal(
      sumExtraAccountUnits([addOn({ units: 2 }), addOn({ creem_product_id: "prod_extra_y", units: 3 })]),
      5,
    );
  });

  await test("a missing units value counts as 1, never as 0", () => {
    assert.equal(sumExtraAccountUnits([addOn({ units: undefined })]), 1);
  });

  await test("a PLAN subscription is not an add-on and adds no slots", () => {
    assert.equal(sumExtraAccountUnits([addOn({ creem_product_id: "prod_pro_m", units: 9 })]), 0);
  });

  await test("a canceled add-on grants nothing", () => {
    assert.equal(sumExtraAccountUnits([addOn({ status: "canceled", units: 4 })]), 0);
  });

  await test("trialing grants; scheduled_cancel grants until period end, then stops", () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    assert.equal(sumExtraAccountUnits([addOn({ status: "trialing", units: 2 })], now), 2);
    assert.equal(
      sumExtraAccountUnits(
        [addOn({ status: "scheduled_cancel", units: 2, current_period_end: "2026-09-30T00:00:00.000Z" })],
        now,
      ),
      2,
      "still inside the paid period",
    );
    assert.equal(
      sumExtraAccountUnits(
        [addOn({ status: "scheduled_cancel", units: 2, current_period_end: "2026-08-01T00:00:00.000Z" })],
        now,
      ),
      0,
      "period ended → the slots are gone",
    );
  });

  await test("with no add-on product configured, nothing can be a slot", () => {
    const monthly = process.env.CREEM_PRODUCT_EXTRA_ACCOUNT_MONTHLY;
    const yearly = process.env.CREEM_PRODUCT_EXTRA_ACCOUNT_YEARLY;
    delete process.env.CREEM_PRODUCT_EXTRA_ACCOUNT_MONTHLY;
    delete process.env.CREEM_PRODUCT_EXTRA_ACCOUNT_YEARLY;
    try {
      assert.equal(sumExtraAccountUnits([addOn({ units: 5 })]), 0);
    } finally {
      process.env.CREEM_PRODUCT_EXTRA_ACCOUNT_MONTHLY = monthly;
      process.env.CREEM_PRODUCT_EXTRA_ACCOUNT_YEARLY = yearly;
    }
  });

  await test("the add-on product is NOT in the plan map (it must never grant a plan)", async () => {
    const { resolveCreemProduct, isExtraAccountProduct } = await import(
      "../src/lib/server/creem/creemProducts"
    );
    assert.equal(resolveCreemProduct("prod_extra_m"), null, "an add-on resolves to no plan");
    assert.equal(isExtraAccountProduct("prod_extra_m"), true);
    assert.equal(isExtraAccountProduct("prod_pro_m"), false);
    assert.equal(isExtraAccountProduct(null), false);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
