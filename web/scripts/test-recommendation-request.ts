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
  classifyAnalysisError,
  dailySeed,
  deriveAnalysisState,
  djb2Hex,
  isCurrentResult,
  mergeExcludeIds,
  mergeRefreshedRecommendations,
  parseRetryAfter,
  resolveBasis,
  selectionTags,
  shouldApplyAnalysis,
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

test("basis: an EMPTY item list collapses to category_fallback even if the field claims otherwise", () => {
  // Nothing to back a product-level claim → never assert one (Codex finding #11).
  assert.equal(resolveBasis("product_analysis", 0), "category_fallback");
  assert.equal(resolveBasis("product_text", 0), "category_fallback");
  // With items, the field is honoured.
  assert.equal(resolveBasis("product_analysis", 6), "product_analysis");
  assert.equal(resolveBasis("product_text", 1), "product_text");
  // Unknown count keeps the previous behaviour.
  assert.equal(resolveBasis("product_analysis"), "product_analysis");
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

// ── Analysis state: what the CLIENT knows, not what the server ranked with ──

test("draft image, never analysed → none / draft (nothing was ever started)", () => {
  const s = deriveAnalysisState({ draftImageSelected: true, primaryUrl: "https://cdn/D.jpg" });
  assert.deepEqual(s, { status: "none", source: "draft" });
});

test("draft image, analysis in flight → pending / draft", () => {
  const s = deriveAnalysisState({ draftImageSelected: true, draftStatus: "pending" });
  assert.equal(s.status, "pending");
  assert.equal(s.source, "draft");
});

test("draft image, analysis stored → ready / draft, with no leftover error", () => {
  const s = deriveAnalysisState({ draftImageSelected: true, draftStatus: "ready" });
  assert.deepEqual(s, { status: "ready", source: "draft" });
});

test("draft image, rate-limited failure carries its code and countdown", () => {
  const s = deriveAnalysisState({
    draftImageSelected: true,
    draftStatus: "failed",
    draftError: "rate_limited",
    draftRetryAfter: 42,
  });
  assert.deepEqual(s, { status: "failed", source: "draft", errorCode: "rate_limited", retryAfter: 42 });
});

test("swapped product with no analysis record yet → pending / stateless", () => {
  // The request is in flight (or about to be issued) — NOT a failure, and not "ready".
  const s = deriveAnalysisState({ draftImageSelected: false, swapped: null, primaryUrl: "https://cdn/B.jpg" });
  assert.deepEqual(s, { status: "pending", source: "stateless" });
});

test("an analysis record for a DIFFERENT url is not this product's state", () => {
  const s = deriveAnalysisState({
    draftImageSelected: false,
    swapped: { url: "https://cdn/A.jpg", analysis: { style: "editorial" } },
    primaryUrl: "https://cdn/B.jpg",
  });
  assert.deepEqual(s, { status: "pending", source: "stateless" }, "A's analysis must not describe B");
});

test("swapped product with an analysis → ready / stateless", () => {
  const s = deriveAnalysisState({
    draftImageSelected: false,
    swapped: { url: "https://cdn/B.jpg", analysis: { imageSummary: "a blue mug" } },
    primaryUrl: "https://cdn/B.jpg",
  });
  assert.deepEqual(s, { status: "ready", source: "stateless" });
});

test("a legacy {url}-only failure record is honestly 'failed' with an unknown reason", () => {
  // Older code recorded a failure as a bare {url} with no reason attached. That is a
  // failure, not a pending state — but we must not invent a cause for it.
  const s = deriveAnalysisState({
    draftImageSelected: false,
    swapped: { url: "https://cdn/B.jpg" },
    primaryUrl: "https://cdn/B.jpg",
  });
  assert.deepEqual(s, { status: "failed", source: "stateless", errorCode: "other" });
});

test("a swapped failure passes its own code and Retry-After through", () => {
  const s = deriveAnalysisState({
    draftImageSelected: false,
    swapped: { url: "https://cdn/B.jpg", error: "rate_limited", retryAfter: 17 },
    primaryUrl: "https://cdn/B.jpg",
  });
  assert.deepEqual(s, { status: "failed", source: "stateless", errorCode: "rate_limited", retryAfter: 17 });
});

test("no primary image at all → none / none (there is nothing to analyse)", () => {
  assert.deepEqual(deriveAnalysisState({ draftImageSelected: false }), { status: "none", source: "none" });
  assert.deepEqual(
    deriveAnalysisState({ draftImageSelected: false, swapped: null, primaryUrl: "" }),
    { status: "none", source: "none" },
  );
});

// ── Failure classification: only causes we actually observed ────────────────

test("HTTP status decides first: 429 = rate limited, 401 = signed out", () => {
  assert.equal(classifyAnalysisError(new Error("boom"), 429), "rate_limited");
  assert.equal(classifyAnalysisError(new Error("boom"), 401), "unauthenticated");
});

test("an abort / timeout is a timeout, not an analysis failure", () => {
  assert.equal(classifyAnalysisError({ name: "AbortError", message: "The user aborted a request." }), "timeout");
  assert.equal(classifyAnalysisError(new Error("Request timeout after 30s")), "timeout");
  assert.equal(classifyAnalysisError(new Error("signal is aborted without reason")), "timeout");
});

test("a fetch-level TypeError is a network problem", () => {
  assert.equal(classifyAnalysisError(new TypeError("Failed to fetch")), "network");
  assert.equal(classifyAnalysisError({ message: "NetworkError when attempting to fetch resource." }), "network");
});

test("the markers this helper's own thrower uses are recognised without a status", () => {
  // startImageAnalysis throws new Error("rate_limited") / ("unauthenticated").
  assert.equal(classifyAnalysisError(new Error("rate_limited")), "rate_limited");
  assert.equal(classifyAnalysisError(new Error("unauthenticated")), "unauthenticated");
});

test("anything unrecognised stays 'other' — no invented cause", () => {
  assert.equal(classifyAnalysisError(new Error("analyze_http_500"), 500), "other");
  assert.equal(classifyAnalysisError(undefined), "other");
  assert.equal(classifyAnalysisError({}), "other");
});

test("Retry-After: whole seconds, or nothing at all", () => {
  assert.equal(parseRetryAfter("30"), 30);
  assert.equal(parseRetryAfter("  30  "), 30);
  assert.equal(parseRetryAfter("1.9"), 1, "seconds are whole; never round a wait UP into a lie");
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter("-5"), undefined);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"), undefined, "the date form is not seconds");
});

// ── Daily seed: stable within a UTC day, different across it ────────────────

test("dailySeed is stable within a UTC day and rotates at the UTC boundary", () => {
  const key = "draft-1";
  const beforeMidnight = dailySeed(key, new Date("2026-08-28T23:30:00Z"));
  const alsoThatDay    = dailySeed(key, new Date("2026-08-28T00:00:00Z"));
  const afterMidnight  = dailySeed(key, new Date("2026-08-29T00:30:00Z"));
  assert.equal(beforeMidnight, "draft-1:2026-08-28");
  assert.equal(alsoThatDay, beforeMidnight, "same UTC day → identical seed → identical sample");
  assert.equal(afterMidnight, "draft-1:2026-08-29");
  assert.notEqual(afterMidnight, beforeMidnight);
});

test("dailySeed keys on the caller's key, so two drafts never share a sample", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  assert.notEqual(dailySeed("draft-1", now), dailySeed("draft-2", now));
});

// ── Stale-analysis guard ────────────────────────────────────────────────────

test("an analysis is applied only to the image it was started for", () => {
  assert.equal(shouldApplyAnalysis("https://cdn/A.jpg", "https://cdn/A.jpg"), true);
  assert.equal(shouldApplyAnalysis("https://cdn/A.jpg", "https://cdn/B.jpg"), false, "image swapped → discard");
  assert.equal(shouldApplyAnalysis("https://cdn/A.jpg", undefined), false);
  assert.equal(shouldApplyAnalysis("https://cdn/A.jpg", null), false);
});

// ── Image key ───────────────────────────────────────────────────────────────

test("djb2Hex is a stable 8-hex key that distinguishes urls", () => {
  const a = djb2Hex("https://cdn/A.jpg");
  assert.equal(a, djb2Hex("https://cdn/A.jpg"), "same url → same key");
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, djb2Hex("https://cdn/B.jpg"));
  assert.match(djb2Hex(""), /^[0-9a-f]{8}$/, "even an empty string yields a well-formed key");
});

// ── excludeIds accumulation ─────────────────────────────────────────────────

test("mergeExcludeIds de-duplicates and keeps insertion order", () => {
  assert.deepEqual(mergeExcludeIds(["a", "b"], ["b", "c"]), ["a", "b", "c"],
    "a re-added id keeps ONE entry, at its most recent position");
  assert.deepEqual(mergeExcludeIds(["a", "b", "c"], ["a"]), ["b", "c", "a"],
    "re-adding moves that id to the most-recent end");
  assert.deepEqual(mergeExcludeIds([], []), []);
  assert.deepEqual(mergeExcludeIds(["a", "", "  ", "b"], []), ["a", "b"], "blank ids are not ids");
});

test("mergeExcludeIds caps at 72, dropping the OLDEST (FIFO)", () => {
  const prev = Array.from({ length: 100 }, (_, i) => `id-${i}`);
  const capped = mergeExcludeIds(prev, ["new-1"]);
  assert.equal(capped.length, 72);
  assert.equal(capped[capped.length - 1], "new-1", "the newest id is kept");
  assert.equal(capped[0], "id-29", "the 29 oldest ids were dropped, nothing recent was");
  assert.ok(!capped.includes("id-0"), "the first-seen id is the first to go");
});

test("an id seen again survives the cap (recency refreshes, it is not stale)", () => {
  const prev = Array.from({ length: 100 }, (_, i) => `id-${i}`);
  // id-0 is the oldest, but it is on screen again this round.
  const capped = mergeExcludeIds(prev, ["id-0"]);
  assert.equal(capped.length, 72);
  assert.ok(capped.includes("id-0"), "a still-shown id must not be evicted for being old");
  assert.equal(capped[capped.length - 1], "id-0");
  assert.ok(capped.includes("id-29"), "…while ids it did not evict are still there");
  assert.ok(!capped.includes("id-1"), "the next-oldest is dropped instead");
});

test("mergeExcludeIds with a non-positive cap excludes nothing (never the whole list)", () => {
  assert.deepEqual(mergeExcludeIds(["a", "b"], ["c"], 0), []);
  assert.deepEqual(mergeExcludeIds(["a", "b"], ["c"], 2), ["b", "c"]);
});

// ── Serving context on the request body ─────────────────────────────────────

test("serve context rides along on the request body verbatim", () => {
  const body = buildReferenceRequestBody({
    primary: product({ category: "fashion" }),
    draftImageSelected: false,
    serve: {
      draftId: "draft-1",
      requestId: "req-1",
      imageKey: "0123456789abcdef",
      analysisSource: "stateless",
      analysisStatus: "ready",
      seed: "draft-1:2026-08-28",
      excludeIds: ["x1", "x2", "x1"],
    },
  });
  assert.equal(body.draftId, "draft-1");
  assert.equal(body.requestId, "req-1");
  assert.equal(body.imageKey, "0123456789abcdef");
  assert.equal(body.analysisSource, "stateless");
  assert.equal(body.analysisStatus, "ready");
  assert.equal(body.seed, "draft-1:2026-08-28");
  assert.deepEqual(body.excludeIds, ["x2", "x1"], "de-duplicated, most-recent position kept");
  // The pre-existing fields are untouched by the new context.
  assert.equal(body.category, "fashion");
  assert.equal(body.limit, 9);
});

test("excludeIds are capped at 72 in the body, keeping the most recent", () => {
  const many = Array.from({ length: 90 }, (_, i) => `id-${i}`);
  const body = buildReferenceRequestBody({
    primary: product(),
    draftImageSelected: false,
    serve: { requestId: "req-2", analysisSource: "none", analysisStatus: "none", excludeIds: many },
  });
  assert.equal(body.excludeIds?.length, 72);
  assert.equal(body.excludeIds?.[71], "id-89");
  assert.ok(!body.excludeIds?.includes("id-0"));
});

test("an empty exclude list is omitted rather than sent as []", () => {
  const body = buildReferenceRequestBody({
    primary: product(),
    draftImageSelected: false,
    serve: { requestId: "req-3", analysisSource: "draft", analysisStatus: "pending", excludeIds: [] },
  });
  assert.equal(body.excludeIds, undefined);
  assert.equal(body.analysisStatus, "pending", "the rest of the context is still sent");
});

test("a call with NO serve context is byte-identical to the old body", () => {
  // Old clients / existing fixtures must not start sending empty context keys.
  const body = buildReferenceRequestBody({ primary: product(), draftImageSelected: false });
  assert.deepEqual(Object.keys(body).sort(), ["category", "imageAnalysis", "limit", "product"]);
  assert.ok(!("requestId" in body));
  assert.ok(!("excludeIds" in body));
});

// -- "Show different ideas": a refresh keeps what the user picked ------------

type Card = { id: string };
const cards = (...ids: string[]): Card[] => ids.map(id => ({ id }));
const idsOf = (list: Card[]) => list.map(c => c.id);

test("a refresh keeps selected cards in their original slots", () => {
  const merged = mergeRefreshedRecommendations(
    cards("a", "b", "c"), ["b"], cards("x", "y", "z"), 3,
  );
  assert.equal(idsOf(merged)[1], "b", "the picked card must not move");
  assert.deepEqual(idsOf(merged), ["x", "b", "y"]);
});

test("a refresh never repeats an id that is still on screen", () => {
  // The server may return a kept card again (the client excludes ids best-effort).
  const merged = mergeRefreshedRecommendations(
    cards("a", "b", "c"), ["b"], cards("b", "x", "a"), 3,
  );
  assert.deepEqual(idsOf(merged), ["x", "b", "a"]);
  assert.equal(new Set(idsOf(merged)).size, merged.length, "no duplicates");
});

test("too few fresh ideas backfill from the previous list instead of collapsing", () => {
  const merged = mergeRefreshedRecommendations(
    cards("a", "b", "c"), ["c"], cards("x"), 3,
  );
  assert.equal(merged.length, 3, "the grid keeps its size");
  assert.deepEqual(idsOf(merged), ["x", "a", "c"], "leftovers fill the rest, c stays put");
});

test("the merged result is truncated to the limit", () => {
  const merged = mergeRefreshedRecommendations(
    cards("a", "b", "c"), ["a"], cards("x", "y", "z", "w"), 3,
  );
  assert.equal(merged.length, 3);
  assert.deepEqual(idsOf(merged), ["a", "x", "y"]);
});

test("with nothing selected a refresh is a straight replacement", () => {
  const merged = mergeRefreshedRecommendations(
    cards("a", "b", "c"), [], cards("x", "y", "z", "w"), 3,
  );
  assert.deepEqual(idsOf(merged), ["x", "y", "z"], "old items only appear as backfill");
});

test("an empty response leaves the previous grid intact", () => {
  // A refresh that finds nothing new must not blank the section the user is reading.
  const merged = mergeRefreshedRecommendations(cards("a", "b", "c"), ["b"], [], 3);
  assert.deepEqual(idsOf(merged), ["a", "b", "c"]);
});

test("a selected card beyond the limit is not re-pinned, and nothing crashes", () => {
  const merged = mergeRefreshedRecommendations(
    cards("a", "b", "c", "d"), ["d"], cards("x", "y"), 2,
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(idsOf(merged), ["x", "y"]);
});

test("a non-positive limit yields an empty list", () => {
  assert.deepEqual(mergeRefreshedRecommendations(cards("a"), [], cards("x"), 0), []);
});

console.log(`\nRecommendation request: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
