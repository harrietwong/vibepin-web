import assert from "node:assert/strict";
import { resolveBuildSha } from "../src/lib/server/buildIdentity";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

test("uses the Vercel full commit when it is valid", () => {
  assert.equal(resolveBuildSha({ VERCEL_GIT_COMMIT_SHA: shaA, VIBEPIN_BUILD_SHA: shaB }), shaA);
});

test("falls back to the explicit full build SHA when Vercel omits its commit", () => {
  assert.equal(resolveBuildSha({ VIBEPIN_BUILD_SHA: shaB }), shaB);
});

test("rejects short or non-hex custom build identities", () => {
  assert.equal(resolveBuildSha({ VIBEPIN_BUILD_SHA: "abc1234" }), null);
  assert.equal(resolveBuildSha({ VIBEPIN_BUILD_SHA: "z".repeat(40) }), null);
});

test("never exposes an invalid Vercel value and can use a valid explicit fallback", () => {
  assert.equal(resolveBuildSha({ VERCEL_GIT_COMMIT_SHA: "short", VIBEPIN_BUILD_SHA: shaB }), shaB);
});

console.log(`\nBuild identity: ${passed} passed`);
