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
  applyQuota,
  clampLimit,
  decodeCursor,
  DEFAULT_COLLECTION_QUOTA,
  DEFAULT_LIMIT,
  encodeCursor,
  isKnownStoreKey,
  isMissingTableError,
  isStalePut,
  isTombstoneEligible,
  isValidStoreKey,
  MAX_BATCH,
  MAX_LIMIT,
  parseMs,
  payloadTooLarge,
  quotaFor,
  SINGLETON_QUOTA,
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

// ── known-storeKey whitelist (abuse-surface guard) ──────────────────────────────
test("isKnownStoreKey accepts exactly the 15 quota-table stores", () => {
  const known = [
    "smart_schedule", "notification_prefs", "publishing_prefs", "brand_profile",
    "amazon_affiliate_settings", "niches", "basket",
    "pin_metadata", "pin_records", "pin_sessions", "bookmarks",
    "creator_product_links", "product_library", "reference_library", "assets",
  ];
  for (const k of known) assert.ok(isKnownStoreKey(k), `${k} must be known`);
  assert.equal(known.length, 15, "the whitelist is exactly the 15 registered stores");
});
test("isKnownStoreKey rejects well-formed-but-unknown keys (no unbounded storeKey × 500 abuse)", () => {
  // Passes the shape regex but is NOT a registered store → must be refused.
  assert.ok(isValidStoreKey("shopify_connections"), "sanity: well-formed shape");
  assert.ok(!isKnownStoreKey("shopify_connections"), "unknown store rejected");
  assert.ok(!isKnownStoreKey("evil_key"));
  assert.ok(!isKnownStoreKey("a-b_c9"));
  assert.ok(!isKnownStoreKey("x".repeat(64)));
  // Malformed keys are rejected too.
  assert.ok(!isKnownStoreKey("HasUpper"));
  assert.ok(!isKnownStoreKey(""));
  assert.ok(!isKnownStoreKey(null));
  assert.ok(!isKnownStoreKey(123));
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

// ── quota table + decision ───────────────────────────────────────────────────
test("quotaFor: singletons=4, known collections, unknown default", () => {
  assert.equal(quotaFor("smart_schedule"), SINGLETON_QUOTA);
  assert.equal(quotaFor("basket"), SINGLETON_QUOTA);
  assert.equal(quotaFor("amazon_affiliate_settings"), SINGLETON_QUOTA);
  assert.equal(quotaFor("pin_metadata"), 2000);
  assert.equal(quotaFor("pin_records"), 5000);
  assert.equal(quotaFor("assets"), 1000);
  assert.equal(quotaFor("product_library"), 2000);
  assert.equal(quotaFor("something_unknown"), DEFAULT_COLLECTION_QUOTA);
});

test("applyQuota: updates to existing docIds always accepted, even at/over cap", () => {
  const r = applyQuota({
    quota: 4,
    liveCount: 4, // already full
    existingDocIds: new Set(["a", "b"]),
    candidateDocIds: ["a", "b"], // both are updates
  });
  assert.deepEqual(r.acceptedDocIds, ["a", "b"]);
  assert.deepEqual(r.rejected, []);
});

test("applyQuota: new inserts fill headroom; the tail is rejected in order", () => {
  const r = applyQuota({
    quota: 4,
    liveCount: 2, // headroom = 2
    existingDocIds: new Set(),
    candidateDocIds: ["n1", "n2", "n3", "n4"],
  });
  assert.deepEqual(r.acceptedDocIds, ["n1", "n2"]);
  assert.deepEqual(r.rejected, ["n3", "n4"]);
});

test("applyQuota: mix of updates + new inserts — updates never consume headroom", () => {
  const r = applyQuota({
    quota: 3,
    liveCount: 3, // full via existing live rows
    existingDocIds: new Set(["u1", "u2"]),
    candidateDocIds: ["u1", "new1", "u2", "new2"],
  });
  // both updates pass; both new inserts rejected (no headroom).
  assert.deepEqual(r.acceptedDocIds, ["u1", "u2"]);
  assert.deepEqual(r.rejected, ["new1", "new2"]);
});

test("applyQuota: headroom clamps at 0 when liveCount exceeds quota", () => {
  const r = applyQuota({
    quota: 4,
    liveCount: 10, // somehow over (e.g. cap lowered later)
    existingDocIds: new Set(["keep"]),
    candidateDocIds: ["keep", "new"],
  });
  assert.deepEqual(r.acceptedDocIds, ["keep"]);
  assert.deepEqual(r.rejected, ["new"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
