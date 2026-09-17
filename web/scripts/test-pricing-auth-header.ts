import assert from "node:assert/strict";
import {
  createPricingAuthState,
  getPricingHeaderState,
  getVerifiedPricingUserId,
  pricingAuthReducer,
} from "../src/lib/auth/pricingHeaderAuth";
import { hasPublicSessionCookie } from "../src/lib/auth/publicSessionHint";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

test("an unverified cookie hint can render the Studio header but cannot authorize checkout", () => {
  const state = createPricingAuthState(true);
  assert.deepEqual(getPricingHeaderState(state), { showLogIn: false, showStudio: true });
  assert.equal(getVerifiedPricingUserId(state), null);
});

test("a failed verification clears the stale cookie hint and restores anonymous actions", () => {
  const staleHint = createPricingAuthState(true);
  const state = pricingAuthReducer(staleHint, { type: "verified", userId: null });
  assert.deepEqual(getPricingHeaderState(state), { showLogIn: true, showStudio: false });
  assert.equal(getVerifiedPricingUserId(state), null);
});

test("a verified user is the only state allowed to launch checkout", () => {
  const state = pricingAuthReducer(createPricingAuthState(true), { type: "verified", userId: "verified-user" });
  assert.deepEqual(getPricingHeaderState(state), { showLogIn: false, showStudio: true });
  assert.equal(getVerifiedPricingUserId(state), "verified-user");
});

test("a signed-out event clears an earlier hint before a later header render", () => {
  const state = pricingAuthReducer(createPricingAuthState(true), { type: "signed-out" });
  assert.deepEqual(getPricingHeaderState(state), { showLogIn: true, showStudio: false });
  assert.equal(getVerifiedPricingUserId(state), null);
});

test("the server hint only checks Supabase session cookie presence, never its token", () => {
  assert.equal(hasPublicSessionCookie([{ name: "sb-e2e-auth-token", value: "opaque" }]), true);
  assert.equal(hasPublicSessionCookie([{ name: "sb-e2e-auth-token.0", value: "opaque" }]), true);
  assert.equal(hasPublicSessionCookie([{ name: "theme", value: "dark" }]), false);
  assert.equal(hasPublicSessionCookie([{ name: "sb-e2e-auth-token", value: "" }]), false);
});

console.log(`\nPricing auth header: ${passed} passed`);
