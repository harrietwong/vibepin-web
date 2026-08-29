/**
 * test-reference-serve.ts — the pure serving layer of POST /api/reference-candidates.
 *
 * Three things here are contract, not implementation detail:
 *
 *  - **Every new request field is optional.** The drawer sends `requestId / imageKey /
 *    analysisSource / analysisStatus / seed / excludeIds`; every older caller and every
 *    existing fixture sends none of them. A parser that threw, or that echoed a bogus
 *    enum straight into analytics, would either break those callers or quietly poison the
 *    data the P0 exists to collect. So the tests hammer the degenerate inputs.
 *  - **The round-robin merge partitions by tier, it does not take a prefix.** With the
 *    keyword-cluster cap on, `rankReferencesTiered` returns Tier-1 keeps, Tier-2 keeps,
 *    Tier-1 overflow, Tier-2 overflow — product-evidence rows are NOT contiguous. Taking
 *    the head of each list would put category filler ahead of a genuine match from
 *    another category, which is exactly the dishonesty the basis logic protects against.
 *  - **`served` is complete.** It is the only record of what the user was shown; a field
 *    that silently goes missing turns a future diagnosis back into guesswork.
 */

import assert from "node:assert/strict";
import {
  utcDayStart,
  parseServeFields,
  defaultSeed,
  mergeRoundRobin,
  buildServed,
  boundedServedPayload,
  MAX_EXCLUDE_IDS,
  MAX_FIELD_CHARS,
  type TieredResult,
} from "../src/lib/studio/referenceServe";
import { poolHash } from "../src/lib/studio/referencePool";
import { MAX_PAYLOAD_BYTES, byteLength } from "../src/lib/analyticsIngest";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

/** Deterministic id generator so "the server filled it in" is observable. */
function gen(value = "generated-uuid") {
  let calls = 0;
  return { uuid: () => { calls++; return value; }, get calls() { return calls; } };
}

// ── parseServeFields ────────────────────────────────────────────────────────────

test("parseServeFields: empty body yields safe defaults and a generated requestId", () => {
  const g = gen();
  const f = parseServeFields({}, g);
  assert.equal(f.requestId, "generated-uuid");
  assert.equal(g.calls, 1);
  assert.equal(f.analysisSource, "none");
  assert.equal(f.analysisStatus, "none");
  assert.deepEqual(f.excludeIds, []);
  assert.equal(f.draftId, undefined);
  assert.equal(f.imageKey, undefined);
  assert.equal(f.seed, undefined);
});

test("parseServeFields: non-object bodies never throw (old/garbage callers)", () => {
  for (const body of [null, undefined, "nope", 42, true]) {
    const f = parseServeFields(body, gen());
    assert.equal(f.requestId, "generated-uuid");
    assert.equal(f.analysisSource, "none");
    assert.equal(f.analysisStatus, "none");
    assert.deepEqual(f.excludeIds, []);
  }
});

test("parseServeFields: a fully-populated body passes through verbatim", () => {
  const g = gen();
  const f = parseServeFields({
    draftId: "draft-1",
    requestId: "req-1",
    imageKey: "0123456789abcdef",
    analysisSource: "stateless",
    analysisStatus: "ready",
    seed: "draft-1:2026-08-27",
    excludeIds: ["a", "b"],
  }, g);
  assert.equal(g.calls, 0, "a client-supplied requestId must not be replaced");
  assert.deepEqual(f, {
    draftId: "draft-1",
    requestId: "req-1",
    imageKey: "0123456789abcdef",
    analysisSource: "stateless",
    analysisStatus: "ready",
    seed: "draft-1:2026-08-27",
    excludeIds: ["a", "b"],
  });
});

test("parseServeFields: every analysisSource / analysisStatus enum value survives", () => {
  for (const source of ["draft", "stateless", "none"]) {
    assert.equal(parseServeFields({ analysisSource: source }, gen()).analysisSource, source);
  }
  for (const status of ["ready", "pending", "failed", "none"]) {
    assert.equal(parseServeFields({ analysisStatus: status }, gen()).analysisStatus, status);
  }
});

test("parseServeFields: illegal enums degrade to \"none\" instead of reaching analytics", () => {
  for (const bad of ["READY", "swapped", "", 1, null, {}, ["draft"]]) {
    const f = parseServeFields({ analysisSource: bad, analysisStatus: bad }, gen());
    assert.equal(f.analysisSource, "none", `analysisSource for ${JSON.stringify(bad)}`);
    assert.equal(f.analysisStatus, "none", `analysisStatus for ${JSON.stringify(bad)}`);
  }
});

test("parseServeFields: blank / non-string strings count as absent", () => {
  const g = gen();
  const f = parseServeFields({ requestId: "   ", draftId: "", imageKey: 7, seed: "  " }, g);
  assert.equal(f.requestId, "generated-uuid", "a whitespace requestId is not a requestId");
  assert.equal(g.calls, 1);
  assert.equal(f.draftId, undefined);
  assert.equal(f.imageKey, undefined);
  assert.equal(f.seed, undefined);
  assert.equal(parseServeFields({ seed: " s:2026-08-27 " }, gen()).seed, "s:2026-08-27", "seeds are trimmed");
});

test("parseServeFields: excludeIds — non-array is empty, entries are filtered and deduped", () => {
  for (const bad of ["a,b", 5, null, { 0: "a" }]) {
    assert.deepEqual(parseServeFields({ excludeIds: bad }, gen()).excludeIds, []);
  }
  const f = parseServeFields({ excludeIds: ["a", "a", null, 3, "", "b", undefined, "a"] }, gen());
  assert.deepEqual(f.excludeIds, ["a", "b"], "junk dropped, order-preserving dedupe");
});

test("parseServeFields: excludeIds truncates to 72 AFTER filtering and deduping", () => {
  const many = Array.from({ length: 200 }, (_, i) => `id-${i}`);
  assert.equal(parseServeFields({ excludeIds: many }, gen()).excludeIds.length, MAX_EXCLUDE_IDS);
  assert.equal(MAX_EXCLUDE_IDS, 72);
  assert.deepEqual(parseServeFields({ excludeIds: many }, gen()).excludeIds, many.slice(0, 72),
    "the oldest 72 kept ids survive in order");

  // 90 real ids padded with junk and repeats: the cap must still admit 72 REAL ids,
  // not 72 slots half-wasted on nulls.
  const padded: unknown[] = [];
  for (let i = 0; i < 90; i++) padded.push(`real-${i}`, null, `real-${i}`, 0);
  const f = parseServeFields({ excludeIds: padded }, gen());
  assert.equal(f.excludeIds.length, 72);
  assert.equal(new Set(f.excludeIds).size, 72);
  assert.ok(f.excludeIds.every(id => id.startsWith("real-")));
});

test("parseServeFields: an oversized requestId is truncated, not replaced with a new uuid", () => {
  const g = gen();
  const huge = "r".repeat(5000);
  const f = parseServeFields({ requestId: huge }, g);
  assert.equal(g.calls, 0, "a present (if oversized) requestId must not trigger generation");
  assert.equal(f.requestId.length, MAX_FIELD_CHARS);
  assert.equal(f.requestId, huge.slice(0, MAX_FIELD_CHARS), "truncated value keeps the original prefix");
  assert.ok(huge.startsWith(f.requestId), "the client's own truncated copy can still be correlated");
});

test("parseServeFields: a missing requestId still generates a uuid (unchanged behaviour)", () => {
  const g = gen();
  const f = parseServeFields({}, g);
  assert.equal(f.requestId, "generated-uuid");
  assert.equal(g.calls, 1);
});

test("parseServeFields: oversized seed / imageKey / draftId are each truncated to MAX_FIELD_CHARS", () => {
  const hugeSeed = "s".repeat(1000);
  const hugeImageKey = "k".repeat(1000);
  const hugeDraftId = "d".repeat(1000);
  const f = parseServeFields({ seed: hugeSeed, imageKey: hugeImageKey, draftId: hugeDraftId }, gen());
  assert.equal(f.seed, hugeSeed.slice(0, MAX_FIELD_CHARS));
  assert.equal(f.imageKey, hugeImageKey.slice(0, MAX_FIELD_CHARS));
  assert.equal(f.draftId, hugeDraftId.slice(0, MAX_FIELD_CHARS));
  assert.equal(f.seed!.length, MAX_FIELD_CHARS);
  assert.equal(f.imageKey!.length, MAX_FIELD_CHARS);
  assert.equal(f.draftId!.length, MAX_FIELD_CHARS);
});

test("parseServeFields: an oversized excludeIds entry is truncated in place", () => {
  const hugeId = "x".repeat(1000);
  const f = parseServeFields({ excludeIds: [hugeId, "short-id"] }, gen());
  assert.deepEqual(f.excludeIds, [hugeId.slice(0, MAX_FIELD_CHARS), "short-id"]);
  assert.equal(f.excludeIds[0].length, MAX_FIELD_CHARS);
});

// ── defaultSeed ─────────────────────────────────────────────────────────────────

test("defaultSeed: `${canonical}:${YYYY-MM-DD}` and null canonical becomes \"unknown\"", () => {
  assert.equal(defaultSeed("fashion", new Date("2026-08-27T12:00:00.000Z")), "fashion:2026-08-27");
  assert.equal(defaultSeed(null, new Date("2026-08-27T12:00:00.000Z")), "unknown:2026-08-27");
  assert.match(defaultSeed("beauty", new Date("2026-01-05T00:00:00.000Z")), /^beauty:\d{4}-\d{2}-\d{2}$/);
  assert.equal(defaultSeed("beauty", new Date("2026-01-05T00:00:00.000Z")), "beauty:2026-01-05");
});

test("defaultSeed: the day is UTC, not the server's local zone (both boundary directions)", () => {
  // 20:00Z is already the next day in UTC+8 (the team's zone) — must still be the 27th.
  assert.equal(defaultSeed("home-decor", new Date("2026-08-27T20:00:00.000Z")), "home-decor:2026-08-27");
  // 02:00Z is still the previous day in UTC-8 — must still be the 27th.
  assert.equal(defaultSeed("home-decor", new Date("2026-08-27T02:00:00.000Z")), "home-decor:2026-08-27");
  // The rollover happens exactly at midnight UTC.
  assert.equal(defaultSeed("home-decor", new Date("2026-08-27T23:59:59.999Z")), "home-decor:2026-08-27");
  assert.equal(defaultSeed("home-decor", new Date("2026-08-28T00:00:00.000Z")), "home-decor:2026-08-28");
});

test("defaultSeed: an unusable clock degrades instead of throwing", () => {
  assert.equal(defaultSeed("fashion", new Date("not-a-date")), "fashion:invalid-date");
});

// ── mergeRoundRobin ─────────────────────────────────────────────────────────────

const T1 = (id: string): TieredResult => ({ id, recommendationTier: "product_evidence" });
const T2 = (id: string): TieredResult => ({ id, recommendationTier: "category_fallback" });
const ids = (list: TieredResult[]) => list.map(r => r.id);

test("mergeRoundRobin: all Tier-1 first, interleaved across lists, then all Tier-2", () => {
  const out = mergeRoundRobin([
    [T1("a1"), T2("a2")],
    [T1("b1"), T2("b2")],
    [T1("c1"), T2("c2")],
  ], 0);
  assert.deepEqual(ids(out), ["a1", "b1", "c1", "a2", "b2", "c2"]);
});

test("mergeRoundRobin: tiers need not be contiguous inside a list (cluster-cap output)", () => {
  // This is the real shape rankReferencesTiered emits with keywordClusterCap on:
  // Tier-1 keeps, Tier-2 keeps, Tier-1 overflow, Tier-2 overflow.
  const capped = [T1("a1"), T2("a2"), T1("a3"), T2("a4")];
  const other = [T2("b1"), T1("b2")];
  const out = mergeRoundRobin([capped, other], 0);
  assert.deepEqual(ids(out), ["a1", "b2", "a3", "a2", "b1", "a4"],
    "a3 (evidence, 3rd in its list) must outrank b1 (filler, 1st in its list)");
});

test("mergeRoundRobin: a genuine match in the LAST list beats filler in the first", () => {
  const out = mergeRoundRobin([
    [T2("filler-1"), T2("filler-2"), T2("filler-3")],
    [], [],
    [T1("match")],
  ], 3);
  assert.equal(out[0].id, "match");
  assert.deepEqual(ids(out), ["match", "filler-1", "filler-2"]);
});

test("mergeRoundRobin: deduped by id across lists, first occurrence wins", () => {
  const out = mergeRoundRobin([
    [T1("dup"), T2("a2")],
    [T1("dup"), T2("a2")],
    [T2("b1")],
  ], 0);
  assert.deepEqual(ids(out), ["dup", "a2", "b1"]);
  assert.equal(new Set(ids(out)).size, out.length);
});

test("mergeRoundRobin: limit truncates, limit <= 0 keeps everything", () => {
  const lists = [[T1("a1"), T2("a2")], [T1("b1"), T2("b2")]];
  assert.deepEqual(ids(mergeRoundRobin(lists, 3)), ["a1", "b1", "a2"]);
  assert.deepEqual(ids(mergeRoundRobin(lists, 1)), ["a1"]);
  assert.equal(mergeRoundRobin(lists, 0).length, 4);
  assert.equal(mergeRoundRobin(lists, -5).length, 4);
  assert.equal(mergeRoundRobin(lists, 99).length, 4, "limit above supply is not padded");
});

test("mergeRoundRobin: uneven and empty lists drain without gaps", () => {
  const out = mergeRoundRobin([
    [T1("a1"), T1("a2"), T1("a3")],
    [],
    [T1("c1")],
  ], 0);
  assert.deepEqual(ids(out), ["a1", "c1", "a2", "a3"]);
});

test("mergeRoundRobin: degenerate inputs return an empty list, never throw", () => {
  assert.deepEqual(mergeRoundRobin([], 12), []);
  assert.deepEqual(mergeRoundRobin([[], [], [], []], 12), []);
  // Untiered rows (rankReferences legacy shape) are treated as non-evidence, not dropped.
  const untiered = mergeRoundRobin([[{ id: "x" }, { id: "y" }]], 12);
  assert.deepEqual(ids(untiered), ["x", "y"]);
});

// ── buildServed ─────────────────────────────────────────────────────────────────

const SERVED_KEYS = [
  "requestId", "categoryInput", "categoryCanonical", "poolMode", "poolSize", "poolHash",
  "excludedCount", "tier1Count", "tier2Count", "ids", "recommendationBasis",
].sort();

test("buildServed: carries every contract field, with counts derived from the results", () => {
  const poolIds = ["p1", "p2", "p3", "p4"];
  const served = buildServed({
    requestId: "req-1",
    categoryInput: "womens-fashion",
    categoryCanonical: "fashion",
    poolMode: "merged-fashion",
    poolIds,
    excludedCount: 5,
    results: [T1("p1"), T2("p2"), T1("p3")],
    recommendationBasis: "product_analysis",
  });
  assert.deepEqual(Object.keys(served).sort(), SERVED_KEYS);
  assert.equal(served.requestId, "req-1");
  assert.equal(served.categoryInput, "womens-fashion");
  assert.equal(served.categoryCanonical, "fashion");
  assert.equal(served.poolMode, "merged-fashion");
  assert.equal(served.poolSize, 4);
  assert.equal(served.poolHash, poolHash(poolIds));
  assert.match(served.poolHash, /^[0-9a-f]{16}$/);
  assert.equal(served.excludedCount, 5);
  assert.equal(served.tier1Count, 2);
  assert.equal(served.tier2Count, 1);
  assert.deepEqual(served.ids, ["p1", "p2", "p3"]);
  assert.equal(served.recommendationBasis, "product_analysis");
});

test("buildServed: an all-fallback list reports zero Tier-1 (the honest-label signal)", () => {
  const served = buildServed({
    requestId: "req-2",
    categoryInput: null,
    categoryCanonical: null,
    poolMode: "unknown-roundrobin",
    poolIds: ["a", "b"],
    excludedCount: 0,
    results: [T2("a"), T2("b")],
    recommendationBasis: "category_fallback",
  });
  assert.equal(served.tier1Count, 0);
  assert.equal(served.tier2Count, 2);
  assert.equal(served.categoryInput, null);
  assert.equal(served.categoryCanonical, null);
  assert.equal(served.poolMode, "unknown-roundrobin");
});

test("buildServed: empty pool and empty results still produce a well-formed block", () => {
  const served = buildServed({
    requestId: "req-3",
    categoryInput: "beauty",
    categoryCanonical: "beauty",
    poolMode: "single",
    poolIds: [],
    excludedCount: 0,
    results: [],
    recommendationBasis: "category_fallback",
  });
  assert.deepEqual(Object.keys(served).sort(), SERVED_KEYS);
  assert.equal(served.poolSize, 0);
  assert.equal(served.tier1Count, 0);
  assert.equal(served.tier2Count, 0);
  assert.deepEqual(served.ids, []);
  assert.match(served.poolHash, /^[0-9a-f]{16}$/, "an empty pool still hashes, so logs never carry undefined");
});

test("buildServed: poolHash is order-independent, so two code paths compare equal", () => {
  const base = {
    requestId: "req-4",
    categoryInput: null,
    categoryCanonical: null,
    poolMode: "unknown-roundrobin" as const,
    excludedCount: 0,
    results: [] as TieredResult[],
    recommendationBasis: "category_fallback" as const,
  };
  const a = buildServed({ ...base, poolIds: ["x", "y", "z"] });
  const b = buildServed({ ...base, poolIds: ["z", "x", "y"] });
  assert.equal(a.poolHash, b.poolHash);
  const c = buildServed({ ...base, poolIds: ["x", "y", "w"] });
  assert.notEqual(a.poolHash, c.poolHash, "a different pool must be a different hash");
});

test("utcDayStart: quantizes to the UTC day so the sampler tiers cannot drift within a day", () => {
  const a = utcDayStart(new Date("2026-08-28T00:00:01.000Z"));
  const b = utcDayStart(new Date("2026-08-28T23:59:59.999Z"));
  assert.equal(a.toISOString(), "2026-08-28T00:00:00.000Z");
  assert.equal(a.getTime(), b.getTime(), "same UTC day must quantize to the same instant");
  const c = utcDayStart(new Date("2026-08-29T00:00:00.000Z"));
  assert.notEqual(a.getTime(), c.getTime(), "the next UTC day is a different instant");
  // The seed and the tiers rotate on the same boundary.
  assert.equal(defaultSeed("fashion", a), defaultSeed("fashion", new Date("2026-08-28T15:30:00.000Z")));
  assert.notEqual(defaultSeed("fashion", a), defaultSeed("fashion", c));
});

// ── buildServed: degradedPools ────────────────────────────────────────────────────

test("buildServed: degradedPools is absent by default (contract stays exactly SERVED_KEYS)", () => {
  const served = buildServed({
    requestId: "req-degraded-absent",
    categoryInput: null,
    categoryCanonical: null,
    poolMode: "unknown-roundrobin",
    poolIds: ["a"],
    excludedCount: 0,
    results: [T2("a")],
    recommendationBasis: "category_fallback",
  });
  assert.equal("degradedPools" in served, false);
});

test("buildServed: degradedPools is absent when explicitly passed as an empty array", () => {
  const served = buildServed({
    requestId: "req-degraded-empty",
    categoryInput: null,
    categoryCanonical: null,
    poolMode: "unknown-roundrobin",
    poolIds: ["a"],
    excludedCount: 0,
    results: [T2("a")],
    recommendationBasis: "category_fallback",
    degradedPools: [],
  });
  assert.equal("degradedPools" in served, false);
});

test("buildServed: degradedPools surfaces the failed canonicals when provided", () => {
  const served = buildServed({
    requestId: "req-degraded-present",
    categoryInput: null,
    categoryCanonical: null,
    poolMode: "unknown-roundrobin",
    poolIds: ["a"],
    excludedCount: 0,
    results: [T2("a")],
    recommendationBasis: "category_fallback",
    degradedPools: ["beauty", "digital-products"],
  });
  assert.deepEqual(served.degradedPools, ["beauty", "digital-products"]);
});

// ── boundedServedPayload ───────────────────────────────────────────────────────────

test("boundedServedPayload: a payload under budget is returned untouched (same reference)", () => {
  const payload = {
    requestId: "req-small",
    categoryInput: "beauty",
    categoryCanonical: "beauty",
    poolMode: "single",
    poolSize: 3,
    poolHash: poolHash(["a", "b", "c"]),
    excludedCount: 0,
    tier1Count: 1,
    tier2Count: 2,
    ids: ["a", "b", "c"],
    recommendationBasis: "product_analysis",
  };
  const out = boundedServedPayload(payload, MAX_PAYLOAD_BYTES);
  assert.equal(out, payload, "untouched payload should be the same object reference");
});

test("boundedServedPayload: an oversized ids array is elided to a count, core fields survive", () => {
  const hugeIds = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const payload = {
    requestId: "req-huge-ids",
    categoryInput: "fashion",
    categoryCanonical: "fashion",
    poolMode: "unknown-roundrobin",
    poolSize: hugeIds.length,
    poolHash: poolHash(hugeIds),
    excludedCount: 4,
    tier1Count: 8,
    tier2Count: 4,
    ids: hugeIds,
    recommendationBasis: "product_analysis",
  };
  const before = JSON.stringify(payload);
  const out = boundedServedPayload(payload, MAX_PAYLOAD_BYTES);
  assert.equal(JSON.stringify(payload), before, "input payload must not be mutated");
  assert.equal("ids" in out, false);
  assert.equal(out.idsCount, hugeIds.length);
  assert.equal(out._idsElided, true);
  assert.equal(out.requestId, "req-huge-ids");
  assert.equal(out.recommendationBasis, "product_analysis");
  assert.equal(out.poolMode, "unknown-roundrobin");
  assert.equal(out.tier1Count, 8);
  assert.equal(out.tier2Count, 4);
  assert.ok(byteLength(out) < MAX_PAYLOAD_BYTES, `bounded payload must fit under budget, got ${byteLength(out)}`);
});

test("boundedServedPayload: an extreme payload (huge categoryInput too) still fits the floor", () => {
  const hugeIds = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const payload = {
    requestId: "req-extreme",
    categoryInput: "x".repeat(10 * 1024),
    categoryCanonical: "fashion",
    poolMode: "unknown-roundrobin",
    poolSize: hugeIds.length,
    poolHash: poolHash(hugeIds),
    excludedCount: 1,
    tier1Count: 2,
    tier2Count: 3,
    ids: hugeIds,
    recommendationBasis: "category_fallback",
    analysisSource: "draft",
    analysisStatus: "ready",
  };
  const before = JSON.stringify(payload);
  const out = boundedServedPayload(payload, MAX_PAYLOAD_BYTES);
  assert.equal(JSON.stringify(payload), before, "input payload must not be mutated");
  assert.ok(byteLength(out) < MAX_PAYLOAD_BYTES, `extreme payload must still fit, got ${byteLength(out)}`);
  assert.equal(out.requestId, "req-extreme");
  assert.equal(out.recommendationBasis, "category_fallback");
  assert.equal(out.poolMode, "unknown-roundrobin");
  assert.equal(out.tier1Count, 2);
  assert.equal(out.tier2Count, 3);
  assert.equal(out.idsCount, hugeIds.length);
  assert.equal(out._idsElided, true);
});

test("boundedServedPayload: floor guarantee holds for a battery of extreme inputs (byteLength <= maxBytes)", () => {
  const hugeIds = Array.from({ length: 5000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const basePayload = {
    requestId: "req-battery",
    categoryInput: "fashion",
    categoryCanonical: "fashion",
    poolMode: "unknown-roundrobin",
    poolSize: hugeIds.length,
    poolHash: poolHash(hugeIds),
    excludedCount: 2,
    tier1Count: 5,
    tier2Count: 7,
    ids: hugeIds,
    recommendationBasis: "category_fallback",
    analysisSource: "draft",
    analysisStatus: "ready",
  };

  const cases: Record<string, Record<string, unknown>> = {
    "huge requestId": { ...basePayload, requestId: "r".repeat(20_000) },
    "huge categoryInput": { ...basePayload, categoryInput: "x".repeat(10 * 1024) },
    "huge poolMode": { ...basePayload, poolMode: "p".repeat(20_000) },
    "5000-element ids (already covered by hugeIds, kept for clarity)": { ...basePayload },
    "everything huge at once": {
      ...basePayload,
      requestId: "r".repeat(20_000),
      categoryInput: "x".repeat(10 * 1024),
      poolMode: "p".repeat(20_000),
      recommendationBasis: "b".repeat(20_000),
    },
  };

  for (const [label, payload] of Object.entries(cases)) {
    const before = JSON.stringify(payload);
    const out = boundedServedPayload(payload, MAX_PAYLOAD_BYTES);
    assert.equal(JSON.stringify(payload), before, `input must not be mutated (${label})`);
    assert.ok(
      byteLength(out) <= MAX_PAYLOAD_BYTES,
      `${label}: bounded payload must fit under budget, got ${byteLength(out)}`,
    );
  }
});

test("boundedServedPayload: a pathologically tiny maxBytes still returns something at-or-under budget", () => {
  const payload = {
    requestId: "r".repeat(20_000),
    categoryInput: "x".repeat(10 * 1024),
    categoryCanonical: "fashion",
    poolMode: "unknown-roundrobin",
    poolSize: 5000,
    poolHash: "deadbeef",
    excludedCount: 1,
    tier1Count: 1,
    tier2Count: 1,
    ids: Array.from({ length: 5000 }, (_, i) => `id-${i}`),
    recommendationBasis: "category_fallback",
  };
  for (const maxBytes of [200, 64, 32, 10, 2]) {
    const out = boundedServedPayload(payload, maxBytes);
    assert.ok(
      byteLength(out) <= maxBytes,
      `maxBytes=${maxBytes}: bounded payload must fit, got ${byteLength(out)}`,
    );
  }
  // Below the smallest possible non-empty JSON object (`{}` is 2 bytes), there is nothing
  // left to shed — the function returns `{}` rather than violate the budget.
  assert.deepEqual(boundedServedPayload(payload, 1), {});
  assert.deepEqual(boundedServedPayload(payload, 0), {});
});

test("boundedServedPayload: a normal payload under budget is still returned untouched (regression)", () => {
  const payload = {
    requestId: "req-normal",
    categoryInput: "home-decor",
    categoryCanonical: "home-decor",
    poolMode: "single",
    poolSize: 5,
    poolHash: poolHash(["a", "b", "c", "d", "e"]),
    excludedCount: 0,
    tier1Count: 2,
    tier2Count: 3,
    ids: ["a", "b", "c", "d", "e"],
    recommendationBasis: "product_analysis",
  };
  const before = JSON.stringify(payload);
  const out = boundedServedPayload(payload, MAX_PAYLOAD_BYTES);
  assert.equal(out, payload, "untouched payload should be the same object reference");
  assert.equal(JSON.stringify(payload), before, "input must not be mutated");
});

console.log(`\n${passed} reference-serve tests passed.`);
