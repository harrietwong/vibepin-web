/**
 * Regression test for planOf() in customer360.ts.
 * Run: npx tsx scripts/test-customer360-plan.ts   (from web/)
 *
 * SECURITY REGRESSION (commit d8dbb9f): planOf() must trust ONLY app_metadata.plan
 * — the service-role-writable cache the Creem webhook refreshes. user_metadata is
 * USER-EDITABLE, so reading its `plan` would let a user set user_metadata.plan="pro"
 * on themselves and self-display as paid in the admin Customer 360 view. This mirrors
 * the isPaid trust-boundary fix (security(billing)). The plan value surfaced by
 * getUsersOverview / getUserDetail comes straight from planOf(), so testing planOf
 * directly is a faithful guard for what those entry points surface.
 *
 * planOf is a pure function; it is exported from customer360.ts solely for this test
 * (the entry points construct their own Supabase client internally and take no
 * injectable db, so they cannot be driven with the adminMockDb injection pattern
 * without stubbing a dynamic module import — exporting the pure function is the
 * minimal-risk path).
 */

import assert from "node:assert";
import { makeHarness } from "./adminMockDb";
import { planOf } from "../src/lib/server/customer360";

const { test, done } = makeHarness();

// planOf takes the module-internal AuthUserLite shape; construct minimal fixtures
// (id/email/created_at/last_sign_in_at + the two metadata bags) that satisfy it
// structurally.
function user(meta: {
  app?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
}) {
  return {
    id: "u1",
    email: "e@x.com",
    created_at: null,
    last_sign_in_at: null,
    app_metadata: meta.app ?? null,
    user_metadata: meta.user ?? null,
  };
}

// 1. Trusted service-role plan present → surfaced as "pro".
test("planOf: app_metadata.plan='pro' → 'pro'", () => {
  assert.equal(planOf(user({ app: { plan: "pro" } })), "pro");
});

// 1b. app_metadata wins even when user_metadata disagrees (must not read the union).
test("planOf: app_metadata.plan='pro' beats user_metadata.plan='free' → 'pro'", () => {
  assert.equal(planOf(user({ app: { plan: "pro" }, user: { plan: "free" } })), "pro");
});

// 2. SECURITY REGRESSION: only the user-editable user_metadata.plan is set.
// planOf must NOT trust it — the surfaced plan must be null (free), never "pro".
// Against the OLD two-source planOf (fromApp ?? fromUser) this returned "pro" and
// this assertion FAILS — that is the regression this test exists to catch.
test("planOf SECURITY: ONLY user_metadata.plan='pro' → null (NOT 'pro')", () => {
  const surfaced = planOf(user({ app: {}, user: { plan: "pro" } }));
  assert.notEqual(surfaced, "pro", "user_metadata.plan must NOT be trusted as paid");
  assert.equal(surfaced, null, "with no app_metadata.plan the surfaced plan is null (free)");
});

// 2b. Same regression with app_metadata entirely absent (null).
test("planOf SECURITY: user_metadata.plan='pro' with app_metadata=null → null", () => {
  assert.equal(planOf(user({ app: null, user: { plan: "pro" } })), null);
});

// 3. Neither present → null.
test("planOf: neither metadata carries a plan → null", () => {
  assert.equal(planOf(user({ app: {}, user: {} })), null);
});

// 3b. Non-string app_metadata.plan is ignored (guards the typeof check).
test("planOf: non-string app_metadata.plan → null", () => {
  assert.equal(planOf(user({ app: { plan: 42 } })), null);
});

void done();
