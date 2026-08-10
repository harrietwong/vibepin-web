/**
 * test-account-identity.ts — how an account is named in the UI (PRD 0809 §2).
 * Run: npx tsx scripts/test-account-identity.ts
 */

import assert from "node:assert/strict";
import { accountDisplayLabel, maskAccountId, hasRealIdentity } from "../src/lib/social/accountIdentity";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }

const opts = {
  maskedTemplate: (l4: string) => `Pinterest account ••••${l4}`,
  unidentifiedLabel: "Account connected",
};

console.log("\n=== priority: display name → @username → masked id ===");
test("provider display name wins over username", () => {
  assert.equal(accountDisplayLabel({ displayName: "VibePin", username: "5522278466b6972", accountId: "813814732573114958" }, opts), "VibePin");
});
test("username is used when there is no display name, always @-prefixed once", () => {
  assert.equal(accountDisplayLabel({ username: "vibepinvibepin", accountId: "804455689597649673" }, opts), "@vibepinvibepin");
  assert.equal(accountDisplayLabel({ username: "@vibepinvibepin" }, opts), "@vibepinvibepin", "must not double the @");
});
test("no identity at all → masked id, NOT a fabricated name", () => {
  assert.equal(accountDisplayLabel({ accountId: "813814732573114958" }, opts), "Pinterest account ••••4958");
});
test("no identity and no id → honest placeholder", () => {
  assert.equal(accountDisplayLabel({}, opts), "Account connected");
});

console.log("\n=== the real-world case this exists for ===");
test("a non-human-readable username still shows as the username, never as a raw id lead", () => {
  // The live account really does have username "5522278466b6972". Without a display name
  // that IS the best identity we hold, so it is shown — but it is never replaced by the
  // 18-digit numeric account id, which is what the PRD forbids leading with.
  const label = accountDisplayLabel({ username: "5522278466b6972", accountId: "813814732573114958" }, opts);
  assert.equal(label, "@5522278466b6972");
  assert(!label.includes("813814732573114958"), "must never lead with the raw numeric id");
});
test("two identity-less accounts stay distinguishable by their masks", () => {
  const a = accountDisplayLabel({ accountId: "813814732573114958" }, opts);
  const b = accountDisplayLabel({ accountId: "804455689597649673" }, opts);
  assert.notEqual(a, b, "identical labels would make two rows impossible to tell apart");
});

console.log("\n=== whitespace / mask edges ===");
test("blank-but-present fields are treated as absent", () => {
  assert.equal(accountDisplayLabel({ displayName: "   ", username: "  ", accountId: "813814732573114958" }, opts), "Pinterest account ••••4958");
});
test("maskAccountId returns last 4, or the whole thing when shorter", () => {
  assert.equal(maskAccountId("813814732573114958"), "4958");
  assert.equal(maskAccountId("12"), "12");
  assert.equal(maskAccountId(null), "");
});
test("hasRealIdentity is false for a mask-only account", () => {
  assert.equal(hasRealIdentity({ accountId: "813814732573114958" }), false);
  assert.equal(hasRealIdentity({ username: "vibepinvibepin" }), true);
  assert.equal(hasRealIdentity({ displayName: "VibePin" }), true);
});

console.log(`\nAccount identity: ${passed} passed, 0 failed\n`);
