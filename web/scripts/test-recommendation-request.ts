/**
 * Behavioral tests for the drawer's recommendation request flow (corrective, 2026-07-21).
 * Run: npx tsx scripts/test-recommendation-request.ts
 *
 * These exercise LOGIC, not source strings: request-body construction for a
 * scratch/Select-product product, current-vs-previous product fields, honest basis
 * resolution, and a stale-response guard (A's late response discarded after A→B).
 */

import assert from "node:assert";
import {
  buildReferenceRequestBody,
  isCurrentResult,
  resolveBasis,
  selectionTags,
} from "../src/lib/studio/recommendationRequest";
import type { CanonicalProductSelection } from "../src/lib/studio/productSelection";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

function product(over: Partial<CanonicalProductSelection> = {}): CanonicalProductSelection {
  return { title: "Yellow Cami", source: "shopify", imageUrl: "https://cdn/A.jpg", ...over };
}

// ── A scratch (draft-less) product still produces a real request ────────────

test("a Select-product product with NO draft still builds a request", () => {
  const body = buildReferenceRequestBody({
    primary: product({ productType: "top", category: "fashion", tags: ["summer", "cami"] }),
    draftImageSelected: false, // no draft
  });
  assert.ok(body.product, "must include the product block");
  assert.equal(body.product?.title, "Yellow Cami");
  assert.equal(body.product?.type, "top");
  assert.deepEqual(body.product?.tags, ["summer", "cami"]);
  assert.equal(body.category, "fashion");
});

test("request carries the product's own analysis when it is not the draft image", () => {
  const body = buildReferenceRequestBody({
    primary: product(),
    draftImageSelected: false,
    productAnalysis: { category: "fashion", style: "editorial", imageSummary: "a yellow cami" },
  });
  assert.equal(body.imageAnalysis?.imageSummary, "a yellow cami");
  assert.equal(body.imageAnalysis?.style, "editorial");
});

test("request uses the DRAFT analysis only when the primary IS the draft image", () => {
  const draftBody = buildReferenceRequestBody({
    primary: product(),
    draftImageSelected: true,
    draftAnalysis: { title: "Draft Pin", category: "home", imageSummary: "draft summary" },
    productAnalysis: { imageSummary: "SHOULD NOT BE USED" },
  });
  assert.equal(draftBody.imageAnalysis?.imageSummary, "draft summary", "draft analysis wins when it's the draft image");
});

test("no analysis available → imageAnalysis omitted (API answers category_fallback)", () => {
  const body = buildReferenceRequestBody({ primary: product(), draftImageSelected: false });
  assert.equal(body.imageAnalysis, undefined);
  assert.ok(body.product, "the product block is still sent (title/type/tags)");
});

// ── Honest fields, no fabrication ───────────────────────────────────────────

test("tags come from the selection's own tags first", () => {
  assert.deepEqual(selectionTags(product({ tags: ["a", "b"] })), ["a", "b"]);
});

test("tags fall back to category/keyword/visualFormat, never invented", () => {
  assert.deepEqual(
    selectionTags(product({ category: "fashion", keyword: "cami", visualFormat: "on_model" })),
    ["fashion", "cami", "on_model"],
  );
  assert.deepEqual(selectionTags(product()), [], "no signal → no tags, not a guess");
});

test("a product with no type/tags sends undefined, not empty artefacts", () => {
  const body = buildReferenceRequestBody({ primary: product(), draftImageSelected: false });
  assert.equal(body.product?.type, undefined);
  assert.equal(body.product?.tags, undefined);
});

// ── Honest basis ────────────────────────────────────────────────────────────

test("basis: only product-level values pass through", () => {
  assert.equal(resolveBasis("product_analysis"), "product_analysis");
  assert.equal(resolveBasis("product_text"), "product_text");
});

test("basis: category_fallback / missing / unknown all become category_fallback", () => {
  assert.equal(resolveBasis("category_fallback"), "category_fallback");
  assert.equal(resolveBasis(undefined), "category_fallback");
  assert.equal(resolveBasis(null), "category_fallback");
  assert.equal(resolveBasis("something_else"), "category_fallback");
});

// ── Stale-response guard: A→B, A's late response is discarded ────────────────

test("a late response for the PREVIOUS product is discarded", () => {
  // Simulate: request for A issued, product switches to B, A resolves last.
  const applied: Record<string, string[]> = { refs: [] };
  const apply = (resultKey: string, currentKey: string, items: string[]) => {
    if (!isCurrentResult(resultKey, currentKey)) return; // the drawer's guard
    applied.refs = items;
  };

  let currentKey = "false|https://cdn/A.jpg";
  // B becomes current before A resolves.
  currentKey = "false|https://cdn/B.jpg";
  // A's late response:
  apply("false|https://cdn/A.jpg", currentKey, ["A1", "A2"]);
  assert.deepEqual(applied.refs, [], "A's stale result must NOT be written");
  // B's response:
  apply("false|https://cdn/B.jpg", currentKey, ["B1", "B2"]);
  assert.deepEqual(applied.refs, ["B1", "B2"], "B's result is applied");
});

test("A resolving BEFORE abort cleanup is still discarded by the key guard (4.9)", () => {
  // The scenario AbortController alone does not cover: A's fetch resolves while the
  // product is already B, but React has not yet run the effect cleanup that aborts
  // it. signal.aborted is still false — only the key check saves us.
  const state = { refs: [] as string[], basis: "category_fallback", status: "loading" };
  const keyRef = { current: "A|imgA" };
  const signal = { aborted: false }; // cleanup has NOT run yet

  const requestKeyA = "A|imgA";
  // User switches to B; the ref updates during render, before cleanup fires.
  keyRef.current = "B|imgB";

  const isStale = (requestKey: string) => signal.aborted || !isCurrentResult(requestKey, keyRef.current);
  // A's response lands now:
  if (!isStale(requestKeyA)) {
    state.refs = ["A1"]; state.basis = "product_analysis"; state.status = "idle";
  }
  assert.deepEqual(state.refs, [], "A's refs must not land");
  assert.equal(state.basis, "category_fallback", "A's basis must not land");
  assert.equal(state.status, "loading", "A's status must not land");
  assert.equal(signal.aborted, false, "…and abort alone would NOT have caught this");

  // B's response, with the matching key, does land.
  if (!isStale("B|imgB")) {
    state.refs = ["B1"]; state.basis = "product_text"; state.status = "idle";
  }
  assert.deepEqual(state.refs, ["B1"]);
  assert.equal(state.basis, "product_text");
});

test("the guard also protects basis and status by the same key check", () => {
  const state = { basis: "category_fallback", status: "loading" };
  const applyBasis = (resultKey: string, currentKey: string, basis: string, status: string) => {
    if (!isCurrentResult(resultKey, currentKey)) return;
    state.basis = basis; state.status = status;
  };
  const currentKey = "false|B";
  applyBasis("false|A", currentKey, "product_analysis", "idle"); // stale
  assert.equal(state.basis, "category_fallback", "stale basis discarded");
  assert.equal(state.status, "loading", "stale status discarded");
  applyBasis("false|B", currentKey, "product_text", "idle"); // current
  assert.equal(state.basis, "product_text");
  assert.equal(state.status, "idle");
});

console.log(`\nRecommendation request: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
