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
test("the footer CTA and the toast action no longer link Pinterest on everyone's behalf", () => {
  // Both survived the per-destination rewrite: a footer <a data-testid="draft-cta-view-pin">
  // labelled t("pinDetails.viewPin"), and a toast action that opened whichever destination
  // happened to be first with a permalink under the same Pinterest noun. A publish that
  // reached three platforms therefore offered exactly one of them, misnamed.
  const drawer = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
  assert(!drawer.includes('data-testid="draft-cta-view-pin"'),
    "the global footer View Pin must be gone");
  assert(!drawer.includes('t("pinDetails.viewPin")'),
    "nothing may still render the Pinterest-only View Pin label");
  assert(!drawer.includes("const withLink = outcome.published.find"),
    "the toast must not pick one arbitrary destination to link");
  assert(drawer.includes("{ id: PUBLISH_TOAST_ID },"),
    "the success toast keeps its shared id and drops the action — the results block is the record");
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

console.log("\n=== a FAILED destination is never presented as Published ===");
test("a stored failed row keeps its status, raw reason and code", () => {
  // The regression this guards: PublishResults.tsx rendered CheckCircle2 +
  // "publishResults.published" for EVERY row regardless of status, so a publish where
  // Instagram failed reported all-green. The row data always said `failed` — only the
  // component ignored it — which is why the data-only tests above all passed while the
  // merchant-visible bug was live. Hence the source-contract assertions further down.
  const rows = publishResultRows({
    destinationResults: [
      { destinationId: "pinterest:c1", provider: "pinterest", socialConnectionId: "c1",
        status: "published", accountLabel: "harrietstudio", boardName: "Home",
        remoteId: "123", postUrl: "https://www.pinterest.com/pin/123/", publishedAt: "2026-08-10T02:00:00Z" },
      { destinationId: "instagram:c2", provider: "instagram", socialConnectionId: "c2",
        status: "failed", accountLabel: "@vibepin.co",
        errorCode: "invalid_image_url", errorMessage: "IG-4210 media upload rejected: aspect ratio" },
    ],
  });
  assert.deepEqual(rows.map(r => r.status), ["published", "failed"]);
  assert.equal(rows[1].errorMessage, "IG-4210 media upload rejected: aspect ratio");
  assert.equal(rows[1].errorCode, "invalid_image_url", "the stable code must survive: it picks the safe sentence");
  assert.equal(rows[1].accountName, "@vibepin.co");
});
test("a failed destination gets NO view action, even with a url on the row", () => {
  assert.equal(canViewExternally({ status: "failed", postUrl: "https://instagram.com/p/x" }), false,
    "a failed publish left nothing to view — a link would be a lie, not a convenience");
  assert.equal(canViewExternally({ status: "publishing", postUrl: "https://instagram.com/p/x" }), false);
  assert.equal(canViewExternally({ status: "pending", postUrl: "https://instagram.com/p/x" }), false);
});
test("in-flight and not-yet-attempted destinations survive as their own statuses", () => {
  const rows = publishResultRows({
    destinationResults: [
      { destinationId: "facebook:c3", provider: "facebook", socialConnectionId: "c3", status: "publishing" },
      { destinationId: "instagram:c4", provider: "instagram", socialConnectionId: "c4", status: "pending" },
    ],
  });
  assert.deepEqual(rows.map(r => r.status), ["publishing", "pending"]);
  assert.equal(rows.every(r => !canViewExternally(r)), true);
});

console.log("\n=== the component renders BY status, and never the raw reason ===");
const component = readFileSync("src/components/social/PublishResults.tsx", "utf8");
test("no unconditional success icon: the check mark is chosen by status, not hardcoded", () => {
  assert(!/<CheckCircle2\b/.test(component),
    "CheckCircle2 must not be rendered directly in JSX — it has to come from the status branch");
  assert(component.includes("statusPresentation"), "a single status→presentation map must decide icon/label/colour");
});
test("every status has its own words, not just its own colour", () => {
  for (const key of ["publishResults.published", "publishResults.failed", "publishResults.publishing", "publishResults.pending"]) {
    assert(component.includes(key), `${key} must be reachable from the component`);
  }
  assert(component.includes("AlertTriangle"), "the failed row needs a non-colour signal too");
});
test("the status element exposes data-status for QA/tests, keeping the old testids", () => {
  assert(component.includes("data-status={row.status}"));
  assert(component.includes("`publish-result-${row.provider}-status`"), "the existing testid must survive");
  assert(component.includes("`publish-result-${row.provider}-view`"), "the existing testid must survive");
});
test("the raw upstream errorMessage never reaches the DOM", () => {
  // publishErrorDisplay.ts owns this contract: `errorMessage` can carry API internals
  // and ids, so the row shows a fixed translated sentence chosen by category instead.
  assert(component.includes("getPublishErrorDisplayKey"),
    "the failed reason must be mapped to a customer-safe sentence");
  assert(!/\{\s*row\.errorMessage\s*\}/.test(component),
    "row.errorMessage must never be rendered verbatim");
});
test("the panel is only success-green when every destination published", () => {
  // A failed line inside an all-green box is the same untruth one level up.
  assert(component.includes("allPublished"),
    "the container tint must follow the worst row, not assume success");
});
test("the failed row points at the Retry that already exists, without adding a second one", () => {
  assert(component.includes("publishResults.retryHint"));
  assert(!/onRetry|onClick=\{\s*\(\)\s*=>\s*retry/i.test(component),
    "PublishResults must not grow its own retry path — the card and the drawer already own one");
});

console.log(`\nPublish results: ${passed} passed, 0 failed\n`);
