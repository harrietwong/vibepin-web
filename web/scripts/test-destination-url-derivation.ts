/**
 * Website URL derivation tests (create-pin PRD Section J).
 * Run: npx tsx scripts/test-destination-url-derivation.ts
 *
 * Covers: first-selection fill, product change, manual-override protection,
 * unlink-clearing, and the "no valid public URL" cases.
 */

import assert from "node:assert";
import {
  PRODUCT_DERIVED_URL_SOURCE,
  clearDestinationUrlForUnlink,
  deriveDestinationUrlForProduct,
  isAutoManaged,
  markDestinationUrlManual,
  reconcileProtectedUrl,
  type DestinationUrlState,
} from "../src/lib/studio/destinationUrlDerivation";
import type { CanonicalProductSelection } from "../src/lib/studio/productSelection";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

const shopA: CanonicalProductSelection = {
  title: "A", source: "shopify",
  canonicalUrl: "https://acme.example/products/a",
};
const shopB: CanonicalProductSelection = {
  title: "B", source: "shopify",
  canonicalUrl: "https://acme.example/products/b",
};
const ideaNoUrl: CanonicalProductSelection = { title: "Idea", source: "product_ideas" };
const adminOnly: CanonicalProductSelection = {
  title: "Admin", source: "shopify",
  canonicalUrl: "https://admin.shopify.com/store/acme/products/1",
};

// ── First selection ─────────────────────────────────────────────────────────

test("first selection fills an empty Website URL", () => {
  const change = deriveDestinationUrlForProduct({}, shopA);
  assert.equal(change?.destinationUrl, "https://acme.example/products/a");
  assert.equal(change?.destinationUrlSource, PRODUCT_DERIVED_URL_SOURCE);
});

test("Shopify fills the storefront URL, never the Admin URL", () => {
  const change = deriveDestinationUrlForProduct({}, adminOnly);
  // Admin-only product has no usable public URL, and the field was empty.
  assert.equal(change, null, "must not write an Admin URL");
});

test("Product Idea with no public URL leaves an empty field empty", () => {
  assert.equal(deriveDestinationUrlForProduct({}, ideaNoUrl), null);
});

// ── Changing products ───────────────────────────────────────────────────────

test("changing products updates an untouched product-derived URL", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://acme.example/products/a",
    destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
  };
  const change = deriveDestinationUrlForProduct(state, shopB);
  assert.equal(change?.destinationUrl, "https://acme.example/products/b");
});

test("changing to a product with no public URL clears the stale auto value", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://acme.example/products/a",
    destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
  };
  const change = deriveDestinationUrlForProduct(state, ideaNoUrl);
  assert.equal(change?.destinationUrl, "", "must not keep the OLD product's URL");
});

test("re-selecting the same product writes nothing", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://acme.example/products/a",
    destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
  };
  assert.equal(deriveDestinationUrlForProduct(state, shopA), null, "no redundant write");
});

// ── Manual override protection ──────────────────────────────────────────────

test("a manually edited URL is never overwritten by a product change", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://my-own.example/landing",
    destinationUrlSource: "manual",
    destinationUrlTouched: true,
  };
  assert.equal(deriveDestinationUrlForProduct(state, shopB), null);
});

test("touched flag protects even when the source looks auto-derived", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://acme.example/products/a",
    destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
    destinationUrlTouched: true,
  };
  assert.equal(deriveDestinationUrlForProduct(state, shopB), null, "user typed it — hands off");
});

test("a legacy manual URL with no touched flag is still protected by its source", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://my-own.example/landing",
    destinationUrlSource: "manual",
  };
  assert.equal(deriveDestinationUrlForProduct(state, shopB), null);
});

test("markDestinationUrlManual sets touched and manual provenance", () => {
  const change = markDestinationUrlManual("  https://typed.example/x  ");
  assert.equal(change.destinationUrl, "https://typed.example/x", "trimmed");
  assert.equal(change.destinationUrlSource, "manual");
  assert.equal(change.destinationUrlTouched, true);
  // And that state is then immune to derivation.
  assert.equal(deriveDestinationUrlForProduct(change, shopB), null);
});

test("isAutoManaged: empty is auto-managed, manual is not", () => {
  assert.equal(isAutoManaged({}), true);
  assert.equal(isAutoManaged({ destinationUrl: "   " }), true, "whitespace-only counts as empty");
  assert.equal(isAutoManaged({ destinationUrl: "https://x/y", destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE }), true);
  assert.equal(isAutoManaged({ destinationUrl: "https://x/y", destinationUrlTouched: true }), false);
  assert.equal(isAutoManaged({ destinationUrl: "https://x/y", destinationUrlSource: "manual" }), false);
  assert.equal(isAutoManaged({ destinationUrl: "https://x/y" }), false, "unknown provenance is not ours to overwrite");
});

// ── Unlinking ───────────────────────────────────────────────────────────────

test("unlinking clears the URL when it still matches that product", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://acme.example/products/a",
    destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
  };
  const change = clearDestinationUrlForUnlink(state, shopA);
  assert.equal(change?.destinationUrl, "");
  assert.equal(change?.destinationUrlSource, undefined);
});

test("unlinking does NOT clear a manually edited URL", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://my-own.example/landing",
    destinationUrlSource: "manual",
    destinationUrlTouched: true,
  };
  assert.equal(clearDestinationUrlForUnlink(state, shopA), null);
});

test("unlinking does NOT clear a URL derived from a DIFFERENT product", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://acme.example/products/b",
    destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
  };
  assert.equal(clearDestinationUrlForUnlink(state, shopA), null, "URL belongs to product B");
});

test("unlinking an already-empty field writes nothing", () => {
  assert.equal(clearDestinationUrlForUnlink({}, shopA), null);
});

test("unlinking a product with no public URL writes nothing", () => {
  const state: DestinationUrlState = {
    destinationUrl: "https://acme.example/products/a",
    destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
  };
  assert.equal(clearDestinationUrlForUnlink(state, ideaNoUrl), null);
});

// ── Attribution parameters survive ──────────────────────────────────────────

test("attribution query parameters are preserved verbatim", () => {
  const affiliate: CanonicalProductSelection = {
    title: "Aff", source: "product_ideas",
    publicUrl: "https://shop.example/p/7?tag=aff-20&ref=vibepin",
  };
  const change = deriveDestinationUrlForProduct({}, affiliate);
  assert.equal(change?.destinationUrl, "https://shop.example/p/7?tag=aff-20&ref=vibepin");
});

// ── reconcileProtectedUrl: the two-copy conflict that recurred three times ──────
// Round 4 protected the board copy but overwrote the session; round 5 protected both
// stores but let the form resurrect the value on Save; round 6 dropped the field but
// still left a stale form value. These assert the ACTUAL conflicting states, which
// the source-structure tests never executed.

const MANUAL: DestinationUrlState = { destinationUrl: "https://mine.example/lp", destinationUrlSource: "manual", destinationUrlTouched: true };
const AUTO: DestinationUrlState = { destinationUrl: "https://acme.example/products/a", destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE };
const EMPTY: DestinationUrlState = {};

test("reconcile: both auto-managed → null (fill proceeds)", () => {
  assert.equal(reconcileProtectedUrl(AUTO, AUTO), null);
  assert.equal(reconcileProtectedUrl(EMPTY, EMPTY), null);
  assert.equal(reconcileProtectedUrl(null, EMPTY), null, "brand-new session Pin, no board draft");
});

test("reconcile: board manual, session stale-auto → board value wins on BOTH", () => {
  const r = reconcileProtectedUrl(MANUAL, AUTO);
  assert.ok(r, "must protect");
  assert.equal(r!.url, "https://mine.example/lp", "the manual board URL is authoritative");
  assert.equal(r!.source, "manual");
  assert.equal(r!.boardManual, true);
  assert.equal(r!.sessionManual, false);
});

test("reconcile: session manual, board auto → SESSION value wins (not the auto board)", () => {
  // This is the reverse conflict round 6 got wrong: it always preferred the board.
  const r = reconcileProtectedUrl(AUTO, MANUAL);
  assert.ok(r, "must protect");
  assert.equal(r!.url, "https://mine.example/lp", "the manual SESSION URL is authoritative, not the auto board");
  assert.equal(r!.boardManual, false);
  assert.equal(r!.sessionManual, true);
});

test("reconcile: session manual, NO board draft → session value protected", () => {
  const r = reconcileProtectedUrl(null, MANUAL);
  assert.ok(r, "a session-only Pin's manual URL must still be protected");
  assert.equal(r!.url, "https://mine.example/lp");
  assert.equal(r!.sessionManual, true);
});

test("reconcile: both manually edited but DIFFERENT → board is source of truth", () => {
  const sessionManual: DestinationUrlState = { destinationUrl: "https://mine.example/session", destinationUrlSource: "manual", destinationUrlTouched: true };
  const boardManual: DestinationUrlState = { destinationUrl: "https://mine.example/board", destinationUrlSource: "manual", destinationUrlTouched: true };
  const r = reconcileProtectedUrl(boardManual, sessionManual);
  assert.equal(r!.url, "https://mine.example/board", "publish reads the board, so it wins a two-manual conflict");
  assert.equal(r!.boardManual, true);
  assert.equal(r!.sessionManual, true);
});

console.log(`\nDestination URL derivation: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
