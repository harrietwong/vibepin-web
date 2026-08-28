/**
 * test-reference-pool.ts — stratifiedSample / poolHash / seeded PRNG (P0 reference pool).
 *
 * The sampler decides WHICH candidates the scorer ever sees, so three properties are
 * load-bearing and all of them are asserted here:
 *
 *  - Determinism: the same (rows, seed, now) always yields the same batch — otherwise
 *    "Show different ideas" could not be a deliberate seed change, and a reload would
 *    silently reshuffle the drawer.
 *  - Freshness floors: proportional quotas alone let a huge legacy tier drown the rows
 *    scraped this week (the exact failure this P0 exists to fix), so the fresh tiers get
 *    a guaranteed 20% / 30% whenever they have the rows.
 *  - Injected clock: no Date.now() inside the module, so tier membership is testable.
 */

import assert from "node:assert/strict";
import {
  fnv1a32,
  mulberry32,
  poolHash,
  stratifiedSample,
  type PoolRow,
} from "../src/lib/studio/referencePool";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const BASE = new Date("2026-08-27T00:00:00.000Z");
const DAY = 86_400_000;

/** A pool row scraped `daysAgo` before BASE (null = unknown scrape time). */
function mk(id: string, daysAgo: number | null, quality: number | null = 0.5): PoolRow {
  return {
    id,
    scrapedAt: daysAgo === null ? null : new Date(BASE.getTime() - daysAgo * DAY).toISOString(),
    referenceQualityScore: quality,
  };
}

/** Build `n` rows with a shared id prefix, all at the same age. */
function band(prefix: string, n: number, daysAgo: number | null): PoolRow[] {
  return Array.from({ length: n }, (_, i) => mk(`${prefix}${String(i).padStart(2, "0")}`, daysAgo));
}

const countPrefix = (rows: PoolRow[], prefix: string) => rows.filter(r => r.id.startsWith(prefix)).length;
const ids = (rows: PoolRow[]) => rows.map(r => r.id);

// A mixed pool: 10 fresh (2d), 10 mid (20d), 80 old (100d).
const mixed = [...band("f", 10, 2), ...band("r", 10, 20), ...band("o", 80, 100)];

test("fnv1a32: stable, unsigned 32-bit, sensitive to input", () => {
  assert.equal(fnv1a32("abc"), fnv1a32("abc"));
  assert.notEqual(fnv1a32("abc"), fnv1a32("abd"));
  assert.ok(fnv1a32("") >= 0 && fnv1a32("home-decor:2026-08-27") <= 0xffffffff);
  assert.ok(Number.isInteger(fnv1a32("seed:fresh")));
});

test("mulberry32: same seed replays the same [0,1) sequence, different seed diverges", () => {
  const a = mulberry32(fnv1a32("seed-a"));
  const b = mulberry32(fnv1a32("seed-a"));
  const c = mulberry32(fnv1a32("seed-b"));
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  const seqC = Array.from({ length: 20 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  assert.ok(seqA.every(v => v >= 0 && v < 1), "values must stay in [0, 1)");
});

test("poolHash: 16 hex chars, order- and duplicate-independent, stable, set-sensitive", () => {
  const h = poolHash(["b", "a", "c"]);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, poolHash(["c", "b", "a"]), "order must not matter");
  assert.equal(h, poolHash(["a", "b", "c", "a"]), "duplicates must not matter");
  assert.equal(h, poolHash(["a", "b", "c"]), "must be stable across calls");
  assert.notEqual(h, poolHash(["a", "b", "d"]), "a different id set must hash differently");
  assert.match(poolHash([]), /^[0-9a-f]{16}$/, "empty pool still hashes");
});

test("same seed -> identical batch (twice), and input order does not matter", () => {
  const opts = { size: 12, seed: "fashion:2026-08-27", now: BASE };
  const first = stratifiedSample(mixed, opts);
  const second = stratifiedSample(mixed, opts);
  assert.deepEqual(ids(first), ids(second), "same seed must replay the same batch");
  const shuffledInput = [...mixed].reverse();
  assert.deepEqual(
    ids(stratifiedSample(shuffledInput, opts)),
    ids(first),
    "sample must not depend on the order the DB returned rows in",
  );
});

test("different seed -> a different batch", () => {
  const a = stratifiedSample(mixed, { size: 12, seed: "fashion:2026-08-27", now: BASE });
  const b = stratifiedSample(mixed, { size: 12, seed: "fashion:2026-08-28", now: BASE });
  assert.equal(a.length, b.length);
  assert.notDeepEqual(new Set(ids(a)), new Set(ids(b)), "a new seed must move at least one row");
});

test("freshness floors hold when the tiers are deep enough (20% / 30%)", () => {
  const size = 20;
  const out = stratifiedSample(mixed, { size, seed: "s", now: BASE });
  assert.equal(out.length, size);
  const fresh = countPrefix(out, "f");
  const recent = countPrefix(out, "r");
  assert.ok(fresh >= Math.ceil(size * 0.2), `fresh tier ${fresh} < 20% floor`);
  assert.ok(recent >= Math.ceil(size * 0.3), `mid tier ${recent} < 30% floor`);
  // Proportional quotas alone would have given 2 / 2 / 16 here.
  assert.deepEqual([fresh, recent, countPrefix(out, "o")], [4, 6, 10]);
});

test("quotas stay proportional to tier size once the floors are already satisfied", () => {
  const pool = [...band("f", 50, 1), ...band("r", 30, 15), ...band("o", 20, 90)];
  const out = stratifiedSample(pool, { size: 20, seed: "s", now: BASE });
  assert.deepEqual(
    [countPrefix(out, "f"), countPrefix(out, "r"), countPrefix(out, "o")],
    [10, 6, 4],
    "a satisfied floor must not distort the proportional split",
  );
});

test("short tiers hand their balance over; total is still min(size, rows)", () => {
  const pool = [...band("f", 1, 3), ...band("r", 2, 12), ...band("o", 50, 200)];
  const out = stratifiedSample(pool, { size: 20, seed: "s", now: BASE });
  assert.equal(out.length, 20, "a short fresh tier must not shrink the sample");
  assert.equal(countPrefix(out, "f"), 1, "cannot sample more than the tier holds");
  assert.equal(countPrefix(out, "r"), 2);
  assert.equal(countPrefix(out, "o"), 17);
});

test("rows without a usable scrapedAt count as the oldest tier", () => {
  const pool = [...band("f", 10, 1), ...band("o", 40, null), ...band("x", 10, 999)];
  const out = stratifiedSample(pool, { size: 10, seed: "s", now: BASE });
  assert.equal(out.length, 10);
  assert.equal(countPrefix(out, "f"), 2, "fresh floor is 20% of 10");
  // `o` (null scrapedAt) and `x` (999 days) share the oldest tier.
  assert.equal(countPrefix(out, "o") + countPrefix(out, "x"), 8);
});

test("the injected clock decides tier membership (no hidden Date.now())", () => {
  const pool = [...band("f", 10, 1), ...band("r", 10, 20), ...band("o", 10, 100)];
  const atBase = stratifiedSample(pool, { size: 10, seed: "s", now: BASE });
  const later = stratifiedSample(pool, { size: 10, seed: "s", now: new Date(BASE.getTime() + 60 * DAY) });
  assert.deepEqual(
    [countPrefix(atBase, "f"), countPrefix(atBase, "r"), countPrefix(atBase, "o")],
    [4, 3, 3],
    "at BASE the three bands sit in three different tiers",
  );
  // 60 days later every band is older than 30 days: one tier, so the quota split changes.
  assert.notDeepEqual(new Set(ids(atBase)), new Set(ids(later)), "moving the clock must move the batch");
  assert.equal(later.length, 10);
});

test("rows.length <= size returns everything, sorted deterministically", () => {
  const pool: PoolRow[] = [
    mk("b", 2, 0.9),
    mk("a", 2, 0.9),          // same quality + scrapedAt as b -> id asc wins
    mk("c", 10, 0.9),         // same quality, older -> after a/b
    mk("d", 1, 0.5),
    mk("f", null, 0.5),       // same quality, unknown scrape time -> after d
    mk("e", 1, null),         // null quality sorts last
  ];
  const out = stratifiedSample(pool, { size: 10, seed: "s", now: BASE });
  assert.equal(out.length, pool.length, "nothing may be dropped when the pool fits");
  assert.deepEqual(ids(out), ["a", "b", "c", "d", "f", "e"]);
});

test("sampled output is sorted by quality desc, then scrapedAt desc, then id asc", () => {
  const pool = Array.from({ length: 40 }, (_, i) => mk(`p${String(i).padStart(2, "0")}`, i % 40, (i % 5) / 5));
  const out = stratifiedSample(pool, { size: 12, seed: "s", now: BASE });
  assert.equal(out.length, 12);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].referenceQualityScore ?? Number.NEGATIVE_INFINITY;
    const cur = out[i].referenceQualityScore ?? Number.NEGATIVE_INFINITY;
    assert.ok(prev >= cur, `quality must be non-increasing at index ${i}`);
    if (prev === cur) {
      const pt = Date.parse(out[i - 1].scrapedAt ?? "");
      const ct = Date.parse(out[i].scrapedAt ?? "");
      assert.ok(pt >= ct, `scrapedAt must be non-increasing within equal quality at index ${i}`);
      if (pt === ct) assert.ok(out[i - 1].id < out[i].id, `id must ascend at index ${i}`);
    }
  }
});

test("degenerate inputs: empty pool, size 0, no duplicates in the batch", () => {
  assert.deepEqual(stratifiedSample([], { size: 10, seed: "s", now: BASE }), []);
  assert.deepEqual(stratifiedSample(mixed, { size: 0, seed: "s", now: BASE }), []);
  const out = stratifiedSample(mixed, { size: 25, seed: "s", now: BASE });
  assert.equal(new Set(ids(out)).size, out.length, "sampling must be without replacement");
});

console.log(`\n${passed} reference-pool tests passed.`);
