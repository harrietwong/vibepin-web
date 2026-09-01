/**
 * test-publish-error-display.ts
 *
 * Guards the display-layer sanitization of publish failures: a failed Pin card must
 * NEVER render the raw upstream `publishError` (cron/batch store err.message straight
 * from the Pinterest API), only a fixed, translatable sentence chosen by category.
 * Run: npx tsx scripts/test-publish-error-display.ts (from web/)
 */

import assert from "node:assert/strict";
import en from "../src/lib/i18n/messages/en";
import { getPublishErrorDisplayKey, resolvePublishErrorCategory } from "../src/lib/studio/publishErrorDisplay";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// A realistic raw message from the cron path — the kind of string that must not reach
// the DOM (upstream API internals / request-shaped detail).
const RAW = "Pinterest API 401: {\"code\":2,\"message\":\"Authentication failed\",\"request_id\":\"abc123\"} authorization=Bearer pina_XYZ";

test("persisted errorCategory wins: auth → auth key", () => {
  assert.equal(getPublishErrorDisplayKey({ publishError: RAW, errorCategory: "auth", publishErrorCode: undefined }),
    "studioBoard.card.publishError.auth");
});

test("persisted errorCategory: content → content key", () => {
  assert.equal(getPublishErrorDisplayKey({ publishError: RAW, errorCategory: "content", publishErrorCode: undefined }),
    "studioBoard.card.publishError.content");
});

test("persisted errorCategory: transient → transient key", () => {
  assert.equal(getPublishErrorDisplayKey({ publishError: RAW, errorCategory: "transient", publishErrorCode: undefined }),
    "studioBoard.card.publishError.transient");
});

test("no category but a code: re-derived (needs_reconnect → auth)", () => {
  assert.equal(getPublishErrorDisplayKey({ publishError: RAW, errorCategory: undefined, publishErrorCode: "needs_reconnect" }),
    "studioBoard.card.publishError.auth");
});

test("no category but a code: board_not_owned → content", () => {
  assert.equal(getPublishErrorDisplayKey({ publishError: "board 12 not owned", errorCategory: undefined, publishErrorCode: "board_not_owned" }),
    "studioBoard.card.publishError.content");
});

test("publishError with no category/code and no auth-or-content signal → transient", () => {
  assert.equal(getPublishErrorDisplayKey({ publishError: "socket hang up", errorCategory: undefined, publishErrorCode: undefined }),
    "studioBoard.card.publishError.transient");
});

test("legacy draft (nothing recorded) → honest unknown fallback", () => {
  assert.equal(resolvePublishErrorCategory({ publishError: undefined, errorCategory: undefined, publishErrorCode: undefined }), null);
  assert.equal(getPublishErrorDisplayKey({ publishError: "   ", errorCategory: undefined, publishErrorCode: undefined }),
    "studioBoard.card.publishError.unknown");
});

test("every returned key exists in the English catalog and never echoes the raw error", () => {
  const cases = [
    { publishError: RAW, errorCategory: "auth" as const, publishErrorCode: undefined },
    { publishError: RAW, errorCategory: "content" as const, publishErrorCode: undefined },
    { publishError: RAW, errorCategory: "transient" as const, publishErrorCode: undefined },
    { publishError: undefined, errorCategory: undefined, publishErrorCode: undefined },
  ];
  for (const c of cases) {
    const key = getPublishErrorDisplayKey(c);
    const copy = en[key];
    assert.ok(typeof copy === "string" && copy.trim(), `missing English copy for ${key}`);
    assert.ok(!copy.includes("Bearer"), "copy leaked a credential fragment");
    assert.ok(!copy.includes("pina_"), "copy leaked a token fragment");
    assert.ok(!copy.includes("request_id"), "copy leaked upstream request detail");
    assert.notEqual(copy, c.publishError);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
