/**
 * test-publish-capability.ts — "Connected" is not "can publish" (PRD 0809 §4).
 *
 * Two separate guarantees:
 *   1. A platform we cannot publish to is never selectable, so a merchant cannot tick it
 *      and only discover the truth in the publish result.
 *   2. If one is requested anyway (stale persisted selection, direct API call), the
 *      server refuses it BEFORE calling the provider — so the provider's internal
 *      "Publishing not yet wired for this platform." never reaches a customer.
 *
 * Run: npx tsx scripts/test-publish-capability.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLATFORMS, SOCIAL_PROVIDERS } from "../src/lib/social/platforms";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }

const route = readFileSync("src/app/api/publish/social/route.ts", "utf8");
const dests = readFileSync("src/components/social/PublishDestinations.tsx", "utf8");
const official = readFileSync("src/lib/social/providers/official.ts", "utf8");

console.log("\n=== capability flags match what actually has a publish path ===");
test("Pinterest, Instagram and Facebook are publishable; TikTok is not", () => {
  // Instagram publishes for real (publishToInstagramAccount) — this asserts the flags
  // stay honest about that. Marking a working platform "coming soon" is a regression too.
  assert.equal(PLATFORMS.pinterest.liveConnect, true);
  assert.equal(PLATFORMS.instagram.liveConnect, true);
  assert.equal(PLATFORMS.facebook.liveConnect, true);
  assert.equal(PLATFORMS.tiktok.liveConnect, false);
});
test("the official provider really does route Instagram to an implementation", () => {
  assert.match(official, /provider === "instagram"[\s\S]{0,120}publishToInstagramAccount/);
});

console.log("\n=== 1. not selectable in the UI ===");
test("toggle() refuses a non-publishable provider", () => {
  assert.match(dests, /function toggle\([\s\S]{0,200}if \(!PLATFORMS\[provider\]\.liveConnect\) return;/);
});
test("a stale non-publishable selection is stripped, not published", () => {
  assert.match(dests, /selected\.filter\(p => PLATFORMS\[p\]\.liveConnect\)/);
});

console.log("\n=== 2. refused server-side, before the provider is called ===");
test("the route checks liveConnect and skips with a customer-readable reason", () => {
  assert.match(route, /if \(!PLATFORMS\[provider\]\.liveConnect\)/, "server must gate on capability");
  const gate = route.indexOf("if (!PLATFORMS[provider].liveConnect)");
  const call = route.indexOf("publishPost({");
  assert(gate > 0 && gate < call, "the capability gate must come BEFORE the provider call");
});
test("the gate's message is customer language, not internal wiring", () => {
  const i = route.indexOf("if (!PLATFORMS[provider].liveConnect)");
  const block = route.slice(i, i + 400);
  assert(block.includes("is coming soon"), "must say coming soon in the customer's terms");
  assert(!block.includes("not yet wired"), "must never surface the provider's internal string");
});
test("a not_implemented result is retranslated rather than passed through", () => {
  assert.match(route, /result\.status === "not_implemented"[\s\S]{0,120}is coming soon/);
});

console.log("\n=== the technical string never reaches a customer surface ===");
test("'not yet wired' appears only in the provider that defines it", () => {
  for (const f of ["src/components/social/PublishDestinations.tsx", "src/components/plan/DraftDetailsDrawer.tsx"]) {
    assert(!readFileSync(f, "utf8").includes("not yet wired"), `${f} must not carry the internal string`);
  }
});
test("every provider is covered by exactly one of the two paths", () => {
  for (const p of SOCIAL_PROVIDERS) {
    assert.equal(typeof PLATFORMS[p].liveConnect, "boolean", `${p} must declare a capability`);
  }
});

console.log(`\nPublish capability: ${passed} passed, 0 failed\n`);
