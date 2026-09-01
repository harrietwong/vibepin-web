/**
 * test-publish-results.ts — per-destination publish results (PRD 0809 §5/§6).
 * Run: npx tsx scripts/test-publish-results.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publishResultRows, canViewExternally, hasPublishResults } from "../src/lib/studio/publishResults";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }

console.log("\n=== one row per destination, Pinterest first ===");
test("a multi-platform publish yields a row per platform", () => {
  const rows = publishResultRows({
    postedAt: "2026-08-10T02:00:00Z",
    remotePinId: "123",
    remotePinUrl: "https://www.pinterest.com/pin/123/",
    boardName: "家居",
    targetAccountLabel: "harrietstudio",
    socialPosts: [
      { provider: "instagram", postId: "ig1", postUrl: "https://instagram.com/p/ig1", accountName: "@vibepin.co" },
      { provider: "facebook", postId: "fb1", postUrl: "https://facebook.com/fb1", accountName: "vibepin.co" },
    ],
  });
  assert.deepEqual(rows.map(r => r.provider), ["pinterest", "instagram", "facebook"]);
  assert.equal(rows[0].boardName, "家居");
  assert.equal(rows[0].accountName, "harrietstudio");
  assert.equal(rows[1].accountName, "@vibepin.co");
});
test("Pinterest-only publish still produces its row (nothing that showed a result stops)", () => {
  const rows = publishResultRows({ postedAt: "2026-08-10T02:00:00Z", remotePinId: "9", remotePinUrl: "https://www.pinterest.com/pin/9/" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "pinterest");
});
test("social-only publish (Pinterest unchecked) has NO pinterest row", () => {
  const rows = publishResultRows({ socialPosts: [{ provider: "facebook", postId: "fb1", postUrl: "https://facebook.com/fb1" }] });
  assert.deepEqual(rows.map(r => r.provider), ["facebook"]);
});
test("an unpublished draft has no results at all", () => {
  assert.deepEqual(publishResultRows({}), []);
  assert.equal(hasPublishResults({}), false);
  assert.equal(hasPublishResults(null), false);
});
test("a pinterest entry inside socialPosts is not duplicated", () => {
  const rows = publishResultRows({
    remotePinId: "123",
    socialPosts: [{ provider: "pinterest", postId: "123", postUrl: "https://www.pinterest.com/pin/123/" }],
  });
  assert.equal(rows.filter(r => r.provider === "pinterest").length, 1);
});

console.log("\n=== a view action requires a REAL permalink ===");
test("only a published row with an http(s) url gets a view action", () => {
  assert.equal(canViewExternally({ status: "published", postUrl: "https://instagram.com/p/x" }), true);
  assert.equal(canViewExternally({ status: "published", postUrl: "" }), false, "empty url ⇒ no button, not a broken link");
  assert.equal(canViewExternally({ status: "published", postUrl: null }), false);
  assert.equal(canViewExternally({ status: "published", postUrl: "not-a-url" }), false, "malformed url must not become a link");
  assert.equal(canViewExternally({ status: "published", postUrl: "javascript:alert(1)" }), false, "non-http scheme must never be linked");
});
test("legacy Pinterest drafts without remotePinUrl fall back to the canonical Pin URL", () => {
  const rows = publishResultRows({ postedAt: "2026-08-10T02:00:00Z", remotePinId: "777" });
  assert.equal(rows[0].postUrl, "https://www.pinterest.com/pin/777/");
  assert.equal(canViewExternally(rows[0]), true);
});
test("a platform that returned no permalink still shows as published, just without a link", () => {
  const rows = publishResultRows({ socialPosts: [{ provider: "instagram", postId: "ig1", postUrl: "" }] });
  assert.equal(rows[0].status, "published");
  assert.equal(canViewExternally(rows[0]), false);
});

console.log("\n=== never invent an identity ===");
test("absent account/board are omitted rather than filled with a placeholder", () => {
  const rows = publishResultRows({ remotePinId: "1", socialPosts: [{ provider: "facebook", postId: "f", postUrl: "https://x/y" }] });
  assert.equal(rows[0].accountName, null);
  assert.equal(rows[1].accountName, null);
});
test("blank strings are treated as absent, not as a name", () => {
  const rows = publishResultRows({ remotePinId: "1", targetAccountLabel: "   ", boardName: "  " });
  assert.equal(rows[0].accountName, null);
  assert.equal(rows[0].boardName, null);
});

console.log("\n=== the old global 'View Pin' is gone ===");
test("the drawer no longer renders a single Pinterest-only view link", () => {
  const drawer = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
  assert(!drawer.includes('data-testid="draft-view-link"'),
    "the one global View Pin must be replaced by per-destination actions");
  assert(drawer.includes("PublishResults"), "the drawer must render per-destination results");
});

console.log("\n=== rendered once, never twice ===");
test("a published Pin shows Publish results ONCE, not once per render site", () => {
  // Two blocks render the same component: the published summary (for an already-posted
  // Pin) and the just-published block (for a publish completing in this drawer). Both
  // were live for a posted Pin, so the whole block appeared twice. Each was correct on
  // its own, which is exactly why the unit tests did not catch it.
  const drawer = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
  const sites = [...drawer.matchAll(/<PublishResults/g)];
  assert.equal(sites.length, 2, "expected exactly the summary + just-published render sites");
  const i = drawer.indexOf("const rows = publishResultRows({");
  const before = drawer.slice(Math.max(0, i - 400), i);
  assert(before.includes("{!isPosted && (() => {"),
    "the just-published block must be gated on !isPosted so a posted Pin renders it once");
});

console.log(`\nPublish results: ${passed} passed, 0 failed\n`);
