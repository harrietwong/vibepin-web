/**
 * Settings → Social accounts mobile layout contract.
 *
 * The 390px Preview regression left the fixed 164px settings rail beside the
 * content column. After modal and content padding, provider cards had roughly
 * 121px to work with, so their status chips and account actions created a real
 * horizontal scroller. These assertions freeze the responsive structure without
 * opening a browser or touching provider/auth behaviour.
 *
 * Run: npx tsx scripts/test-settings-social-responsive.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8").replace(/\r\n?/g, "\n");

const settings = read("src/components/settings/SettingsModal.tsx");
const social = read("src/components/social/SocialAccountsPanel.tsx");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  OK  ${name}`);
}

console.log("\n=== 390px Settings modal uses a mobile structure ===");

test("both surfaces use the shared viewport breakpoint hook", () => {
  assert.match(settings, /useViewportBucket\(\) === "mobile"/);
  assert.match(social, /useViewportBucket\(\) === "mobile"/);
});

test("mobile modal uses 16px total viewport gutter and no desktop min-height", () => {
  assert.match(settings, /width: isMobile \? "calc\(100vw - 16px\)"/);
  assert.match(settings, /height: isMobile \? "calc\(100dvh - 16px\)"/);
  assert.match(settings, /minHeight: isMobile \? 0 : 620/);
});

test("mobile body stacks instead of retaining the fixed 164px rail", () => {
  assert.match(settings, /flexDirection: isMobile \? "column" : "row"/);
  assert.match(settings, /data-testid="settings-mobile-tab-select"/);
  assert.match(settings, /data-testid="settings-desktop-sidebar"/);
  const mobileBranch = settings.slice(
    settings.indexOf("{isMobile ? ("),
    settings.indexOf('data-testid="settings-desktop-sidebar"'),
  );
  assert.ok(mobileBranch.includes('data-testid="settings-mobile-tab-picker"'));
  assert.ok(!mobileBranch.includes("width: 164"), "mobile branch must not keep the fixed sidebar width");
});

test("mobile content removes the old 20px padding and cannot scroll horizontally", () => {
  assert.match(settings, /overflowY: "auto", overflowX: "hidden"/);
  assert.match(settings, /padding: isMobile \? "14px 12px 40px" : "18px 20px 52px"/);
});

test("390px leaves at least 300px inside a social card", () => {
  // 390 - 16 modal gutter - 2 modal border - 24 content padding
  //     - 2 card border - 24 card padding = 322px.
  const cardInnerWidth = 390 - 16 - 2 - (12 * 2) - 2 - (12 * 2);
  assert.equal(cardInnerWidth, 322);
  assert.ok(cardInnerWidth >= 300, `card content width regressed to ${cardInnerWidth}px`);
  assert.match(social, /padding: mobile \? "12px" : "16px 16px"/);
});

console.log("\n=== provider cards wrap without changing lifecycle behaviour ===");

test("provider header can shrink and wrap long labels", () => {
  assert.match(social, /data-testid=\{`social-card-header-\$\{summary\.provider\}`\}/);
  assert.match(social, /alignItems: mobile \? "flex-start" : "center"/);
  assert.match(social, /flexWrap: "wrap", minWidth: 0/);
  assert.match(social, /overflowWrap: "anywhere"/);
});

test("status chips may wrap and shrink on mobile", () => {
  assert.match(social, /whiteSpace: mobile \? "normal" : "nowrap"/);
  assert.match(social, /flexShrink: mobile \? 1 : 0/);
  assert.match(social, /<Chip chip=\{chip\} mobile=\{mobile\}/);
});

test("account rows stack and drop the 120px label floor on mobile", () => {
  assert.match(social, /flexDirection: mobile \? "column" : "row"/);
  assert.match(social, /minWidth: mobile \? 0 : 120/);
  assert.match(social, /width: mobile \? "100%" : "auto"/);
  assert.match(social, /whiteSpace: mobile \? "normal" : "nowrap"/);
});

test("account actions live in a full-width wrapping group on mobile", () => {
  assert.match(social, /data-testid=\{`social-account-actions-\$\{account\.id\}`\}/);
  assert.match(social, /display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0/);
  assert.match(social, /width: mobile \? "100%" : "auto"/);
});

test("customer-visible providers remain the canonical visible list", () => {
  assert.match(social, /VISIBLE_SOCIAL_PROVIDERS\.map\(provider =>/);
  const renderedPanel = social.slice(social.lastIndexOf("return ("));
  assert.doesNotMatch(renderedPanel, /SOCIAL_PROVIDERS\.map\(provider =>/);
});

test("connect, reconnect, disconnect and remove handlers remain present", () => {
  for (const handler of [
    "handleConnect",
    "handleReconnectAccount",
    "handleDisconnectAccount",
    "handleRemoveAccount",
  ]) {
    assert.match(social, new RegExp(`function ${handler}\\(`), `${handler} lifecycle handler disappeared`);
  }
});

console.log(`\nSettings Social responsive contract: ${passed} passed, 0 failed\n`);
