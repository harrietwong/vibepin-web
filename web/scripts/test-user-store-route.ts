/**
 * WP-A unit tests for the /api/user-store pure server logic (route/logic.ts).
 * Run: npx tsx scripts/test-user-store-route.ts   (from web/)
 *
 * Covers the framework-free pieces of the route: storeKey validation, timestamp
 * parsing, payload-size guard, server LWW / tombstone-eligibility decisions, limit
 * clamping, missing-table detection, cursor round-trip + tamper rejection, and the
 * PUT `docs` / DELETE `docIds` body validators.
 */

import assert from "node:assert";
import {
  clampLimit,
  decodeCursor,
  DEFAULT_LIMIT,
  encodeCursor,
  isMissingTableError,
  isStalePut,
  isTombstoneEligible,
  isValidStoreKey,
  MAX_BATCH,
  MAX_LIMIT,
  parseMs,
  payloadTooLarge,
  validateDocIds,
  validateDocs,
} from "../src/app/api/user-store/logic";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// ── storeKey validation ────────────────────────────────────────────────────────
test("isValidStoreKey accepts lowercase/digits/_/- up to 64", () => {
  assert.ok(isValidStoreKey("shopify_connections"));
  assert.ok(isValidStoreKey("a"));
  assert.ok(isValidStoreKey("a-b_c9"));
  assert.ok(isValidStoreKey("x".repeat(64)));
});
test("isValidStoreKey rejects empty, too long, uppercase, spaces, symbols, non-string", () => {
  assert.ok(!isValidStoreKey(""));
  assert.ok(!isValidStoreKey("x".repeat(65)));
  assert.ok(!isValidStoreKey("HasUpper"));
  assert.ok(!isValidStoreKey("has space"));
  assert.ok(!isValidStoreKey("has.dot"));
  assert.ok(!isValidStoreKey("slash/key"));
  assert.ok(!isValidStoreKey(null));
  assert.ok(!isValidStoreKey(123));
});

// ── parseMs ────────────────────────────────────────────────────────────────────
test("parseMs parses ISO, rejects junk / empty / non-string", () => {
  assert.equal(parseMs("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(parseMs("2026-01-01T00:00:00+00:00"), Date.parse("2026-01-01T00:00:00+00:00"));
  assert.equal(parseMs("not-a-date"), null);
  assert.equal(parseMs(""), null);
  assert.equal(parseMs(undefined), null);
  assert.equal(parseMs(12345), null);
});

// ── payload size guard ─────────────────────────────────────────────────────────
test("payloadTooLarge flags >200KB only", () => {
  assert.ok(!payloadTooLarge({ a: "small" }));
  assert.ok(!payloadTooLarge({ a: "x".repeat(199 * 1024) }));
  assert.ok(payloadTooLarge({ a: "x".repeat(210 * 1024) }));
});

// ── server LWW ─────────────────────────────────────────────────────────────────
test("isStalePut: incoming strictly older is stale; equal/newer/absent are not", () => {
  assert.ok(isStalePut(100, 200), "older → stale");
  assert.ok(!isStalePut(200, 200), "equal → overwrite (idempotent)");
  assert.ok(!isStalePut(300, 200), "newer → apply");
  assert.ok(!isStalePut(100, undefined), "no existing row → apply");
});

test("isTombstoneEligible: existing not-newer is eligible; newer local wins", () => {
  assert.ok(isTombstoneEligible(200, 100), "existing older → tombstone");
  assert.ok(isTombstoneEligible(200, 200), "equal → tombstone");
  assert.ok(!isTombstoneEligible(200, 300), "existing newer → survives (revives)");
  assert.ok(!isTombstoneEligible(200, undefined), "unknown row → not eligible via this path");
});

// ── limit clamp ────────────────────────────────────────────────────────────────
test("clampLimit clamps to [1, MAX_LIMIT] and defaults on junk", () => {
  assert.equal(clampLimit(null), DEFAULT_LIMIT);
  assert.equal(clampLimit("abc"), DEFAULT_LIMIT);
  assert.equal(clampLimit("0"), 1);
  assert.equal(clampLimit("-5"), 1);
  assert.equal(clampLimit("50"), 50);
  assert.equal(clampLimit(String(MAX_LIMIT + 500)), MAX_LIMIT);
});

// ── missing-table detection ────────────────────────────────────────────────────
test("isMissingTableError matches the known degradation signals only", () => {
  assert.ok(isMissingTableError({ code: "PGRST205" }));
  assert.ok(isMissingTableError({ code: "42P01" }));
  assert.ok(isMissingTableError({ message: "Could not find the table 'public.user_store_docs'" }));
  assert.ok(isMissingTableError({ message: 'relation "user_store_docs" does not exist' }));
  assert.ok(!isMissingTableError({ code: "23505", message: "duplicate key" }));
  assert.ok(!isMissingTableError(null));
});

// ── cursor codec ───────────────────────────────────────────────────────────────
test("cursor round-trips and rejects tampered / malformed input", () => {
  const c = encodeCursor("2026-01-01T00:00:00+00:00", "doc_42");
  assert.deepEqual(decodeCursor(c), { u: "2026-01-01T00:00:00+00:00", d: "doc_42" });
  assert.equal(decodeCursor("!!!not-base64!!!"), null);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ u: "bad", d: "x" })).toString("base64url")), null, "invalid timestamp rejected");
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ u: "2026-01-01T00:00:00Z" })).toString("base64url")), null, "missing d rejected");
});

// ── body validators ────────────────────────────────────────────────────────────
test("validateDocs accepts a well-formed batch", () => {
  const r = validateDocs([{ docId: "d1", updatedAt: "2026-01-01T00:00:00.000Z", payload: { a: 1 } }]);
  assert.ok(r.ok && r.value.length === 1 && r.value[0].docId === "d1");
});
test("validateDocs rejects empty, oversize batch, bad shape, oversize payload", () => {
  assert.ok(!validateDocs([]).ok);
  assert.ok(!validateDocs("nope").ok);
  const tooMany = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ docId: `d${i}`, updatedAt: "2026-01-01T00:00:00.000Z", payload: {} }));
  assert.ok(!validateDocs(tooMany).ok);
  assert.ok(!validateDocs([{ docId: "", updatedAt: "2026-01-01T00:00:00.000Z", payload: {} }]).ok, "empty docId");
  assert.ok(!validateDocs([{ docId: "d1", updatedAt: "bad", payload: {} }]).ok, "bad updatedAt");
  assert.ok(!validateDocs([{ docId: "d1", updatedAt: "2026-01-01T00:00:00.000Z", payload: [] }]).ok, "array payload");
  assert.ok(!validateDocs([{ docId: "d1", updatedAt: "2026-01-01T00:00:00.000Z", payload: null }]).ok, "null payload");
  const big = validateDocs([{ docId: "d1", updatedAt: "2026-01-01T00:00:00.000Z", payload: { a: "x".repeat(210 * 1024) } }]);
  assert.ok(!big.ok && big.error.includes("200KB"));
});
test("validateDocIds filters non-strings, rejects empty & oversize batch", () => {
  const r = validateDocIds(["a", "b", 1, "", null, "c"]);
  assert.ok(r.ok && r.value.length === 3);
  assert.ok(!validateDocIds([]).ok);
  assert.ok(!validateDocIds([1, 2, 3]).ok, "all non-strings → empty → rejected");
  assert.ok(!validateDocIds(Array.from({ length: MAX_BATCH + 1 }, (_, i) => `d${i}`)).ok);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
