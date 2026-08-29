/**
 * pinterestErrorResponse: the `extra` payload can ADD fields but must never set the
 * fields this helper itself decides — error, code, needsReconnect, pinterestCode.
 *
 * Codex round 4 flagged that `...extra` was spread after the canonical fields; the
 * fix spread it first, which protected error/code on every branch but still let a
 * caller inject needsReconnect / pinterestCode on branches that do not set them
 * (Codex round 5). Reserved keys are now stripped from `extra` outright, so the
 * guarantee no longer depends on write order. These cases pin every reserved key on
 * the branch that would otherwise have left it open.
 *
 * The modules under test transitively load lib/supabase, which validates
 * NEXT_PUBLIC_SUPABASE_URL at import time — so they are loaded with a dynamic
 * import AFTER the placeholder env is set (static imports are hoisted above it).
 *
 * Run: npx tsx scripts/test-pinterest-route-helpers.ts   (from web/)
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert";

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${(e as Error).message}`); }
}

const SPOOF = {
  error: "spoofed message",
  code: "spoofed_code",
  needsReconnect: true,
  pinterestCode: "SPOOF-1",
  meteringBucket: "2026-08-28",
  meteringBucketSig: "deadbeef",
  meteringBucketMintedAt: 1234567890,
};

(async () => {
  console.log("=== pinterestErrorResponse: reserved keys cannot be injected via extra ===\n");
  const { pinterestErrorResponse } = await import("../src/lib/server/pinterest/routeHelpers");
  const { NotConnectedError, NeedsReconnectError, PinterestApiError } = await import("../src/lib/server/pinterest/service");

  await test("NotConnectedError (branch sets neither needsReconnect nor pinterestCode): both stay absent, error/code are the helper's, metering extras survive", async () => {
    const err = new NotConnectedError();
    const res = pinterestErrorResponse(err, SPOOF);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, err.message, "error is the thrown message, not the spoof");
    assert.equal(body.code, err.code, "code is the error's code, not the spoof");
    assert.equal(body.needsReconnect, undefined, "needsReconnect must not be injectable");
    assert.equal(body.pinterestCode, undefined, "pinterestCode must not be injectable");
    assert.equal(body.meteringBucket, "2026-08-28", "non-reserved extras pass through");
    assert.equal(body.meteringBucketSig, "deadbeef", "non-reserved extras pass through");
    assert.equal(body.meteringBucketMintedAt, 1234567890, "non-reserved extras pass through");
  });

  await test("NeedsReconnectError: needsReconnect is the helper's true, even when extra says false", async () => {
    const res = pinterestErrorResponse(new NeedsReconnectError(), { ...SPOOF, needsReconnect: false });
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.needsReconnect, true, "helper-decided value wins");
    assert.equal(body.code, new NeedsReconnectError().code, "code is the error's");
  });

  await test("PinterestApiError with a provider code: pinterestCode is the real provider code, not the spoof", async () => {
    const err = new PinterestApiError("upstream said no", 502, "pinterest_api_error", "PA-REAL");
    const res = pinterestErrorResponse(err, SPOOF);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.pinterestCode, "PA-REAL", "real provider code");
    assert.equal(body.code, "pinterest_api_error", "real code");
    assert.equal(body.error, "upstream said no", "real message");
    assert.equal(body.meteringBucket, "2026-08-28", "extras still pass");
  });

  await test("PinterestApiError WITHOUT a provider code: pinterestCode stays absent despite extra", async () => {
    const res = pinterestErrorResponse(new PinterestApiError("no code", 502), SPOOF);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.pinterestCode, undefined, "must not be injectable");
  });

  await test("unknown Error: code is internal_error and status 500, spoof ignored", async () => {
    const res = pinterestErrorResponse(new Error("boom"), SPOOF);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 500);
    assert.equal(body.code, "internal_error");
    assert.notEqual(body.error, "spoofed message", "message is the safe internal message");
    assert.equal(body.needsReconnect, undefined);
    assert.equal(body.pinterestCode, undefined);
  });

  await test("no extra at all: unchanged behaviour", async () => {
    const res = pinterestErrorResponse(new NotConnectedError());
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.code, new NotConnectedError().code);
    assert.equal(Object.keys(body).sort().join(","), "code,error", "exactly the canonical fields");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
