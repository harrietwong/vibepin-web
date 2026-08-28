/**
 * referencePool.ts — deterministic, freshness-aware sampling of the reference pool.
 *
 * The recommender used to score a fixed "top N by quality" slice, so the same product
 * saw the same references forever and nothing scraped this week could ever surface.
 * This module picks the slice instead: split candidates into freshness tiers, give the
 * fresh tiers a guaranteed floor, and sample inside each tier with a seeded PRNG so the
 * result is stable for a given (seed, pool, clock) triple and changes when the client
 * asks for a different batch.
 *
 * Pure and clock-injected on purpose: `now` is a parameter, never `Date.now()`, so the
 * tests can move the clock and the route can pin one timestamp per request. No imports.
 */

/** Minimum row shape the sampler needs; callers pass their own richer rows through. */
export interface PoolRow {
  id: string;
  scrapedAt?: string | null;
  referenceQualityScore?: number | null;
}

/** Tier labels; also salt the per-tier PRNG so tiers shuffle independently. */
const TIER_NAMES = ["fresh", "recent", "older"] as const;

/** Guaranteed share of the sample for the ≤tiersDays[0] and ≤tiersDays[1] tiers. */
const TIER_FLOOR_SHARE = [0.2, 0.3, 0] as const;

const MS_PER_DAY = 86_400_000;

/** FNV-1a 32-bit — string to seed. Stable across runs and platforms. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, well-distributed seeded PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

/**
 * Short, stable fingerprint of a sampled pool: sort + dedupe the ids, then two
 * differently-salted FNV-1a passes concatenated into 16 hex chars. Order-independent,
 * so the same pool logged from two code paths compares equal.
 */
export function poolHash(ids: string[]): string {
  const source = Array.isArray(ids) ? ids : [];
  const unique = Array.from(new Set(source.filter(id => typeof id === "string" && id.length > 0)));
  const joined = unique.sort().join("|");
  return hex8(fnv1a32("vp-pool-a:" + joined)) + hex8(fnv1a32(joined + ":vp-pool-b"));
}

/** Parsed scrape time in ms, or null when absent/unparseable (treated as oldest). */
function scrapedMs(row: PoolRow): number | null {
  const raw = row?.scrapedAt;
  if (typeof raw !== "string" || !raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** 0 = at most d1 days old (incl. future-dated), 1 = at most d2 days old, 2 = older/unknown. */
function tierIndexOf(row: PoolRow, nowMs: number, d1: number, d2: number): number {
  const ms = scrapedMs(row);
  if (ms === null) return 2;
  const ageDays = (nowMs - ms) / MS_PER_DAY;
  if (ageDays <= d1) return 0;
  if (ageDays <= d2) return 1;
  return 2;
}

/** Largest-remainder proportional split of `total` across tier sizes, capped by them. */
function proportionalQuota(total: number, capacities: number[]): number[] {
  const supply = capacities.reduce((a, b) => a + b, 0);
  if (total <= 0 || supply === 0) return capacities.map(() => 0);
  const exact = capacities.map(c => (total * c) / supply);
  const quota = exact.map((e, i) => Math.min(capacities[i], Math.floor(e)));
  let left = total - quota.reduce((a, b) => a + b, 0);
  // Remaining units go to the largest fractional parts first; ties by tier order.
  const order = capacities.map((_, i) => i).sort((a, b) => {
    const fa = exact[a] - Math.floor(exact[a]);
    const fb = exact[b] - Math.floor(exact[b]);
    if (fb !== fa) return fb - fa;
    return a - b;
  });
  while (left > 0) {
    let placed = false;
    for (const i of order) {
      if (left === 0) break;
      if (quota[i] < capacities[i]) { quota[i]++; left--; placed = true; }
    }
    if (!placed) break;   // every tier is at capacity
  }
  return quota;
}

/**
 * Raise deficient tiers to their freshness floor by transferring units from whichever
 * tier has the largest surplus ABOVE ITS OWN floor (oldest tier first on ties — the
 * whole point of the floor is to buy freshness). A tier shorter than its floor simply
 * contributes what it has; the balance stays with the other tiers.
 */
function applyFloors(quota: number[], capacities: number[], total: number): number[] {
  const q = quota.slice();
  const floors = capacities.map((cap, i) => Math.min(cap, Math.ceil(total * TIER_FLOOR_SHARE[i])));
  // Tiny totals: the floors can add up to more than the whole sample.
  let budget = total;
  for (let i = 0; i < floors.length; i++) {
    floors[i] = Math.min(floors[i], Math.max(0, budget));
    budget -= floors[i];
  }
  for (let i = 0; i < q.length; i++) {
    while (q[i] < floors[i]) {
      let donor = -1;
      let best = 0;
      for (let j = q.length - 1; j >= 0; j--) {
        if (j === i) continue;
        const surplus = q[j] - floors[j];
        if (surplus > best) { best = surplus; donor = j; }
      }
      if (donor < 0) break;   // nothing left to take without breaking another floor
      q[donor]--;
      q[i]++;
    }
  }
  return q;
}

/** Deterministic display order: quality desc (null last), scrapedAt desc (null last), id asc. */
function compareForOutput(a: PoolRow, b: PoolRow): number {
  const qa = typeof a.referenceQualityScore === "number" && Number.isFinite(a.referenceQualityScore) ? a.referenceQualityScore : null;
  const qb = typeof b.referenceQualityScore === "number" && Number.isFinite(b.referenceQualityScore) ? b.referenceQualityScore : null;
  if (qa !== qb) {
    if (qa === null) return 1;
    if (qb === null) return -1;
    return qb - qa;
  }
  const sa = scrapedMs(a);
  const sb = scrapedMs(b);
  if (sa !== sb) {
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sb - sa;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sample up to `size` rows across freshness tiers.
 *
 * Tiers: at most tiersDays[0] days old / at most tiersDays[1] days old / everything
 * else (rows without a usable `scrapedAt` count as oldest). Quotas are proportional to
 * tier size, with the fresh tier guaranteed 20% and the mid tier 30% of the sample
 * whenever those tiers have the rows to fill it; a short tier hands its balance to the
 * others, so the result is always `min(size, rows.length)` rows. Within a tier, a
 * partial Fisher-Yates driven by `mulberry32(fnv1a32(seed + ":" + tier))` samples
 * without replacement, so a new seed yields a different batch and the same seed always
 * yields the same one.
 */
export function stratifiedSample<T extends PoolRow>(
  rows: T[],
  opts: { size: number; seed: string; now: Date; tiersDays?: [number, number] },
): T[] {
  const source = Array.isArray(rows) ? rows : [];
  const list = source.filter((r): r is T => Boolean(r) && typeof r.id === "string");
  const size = Number.isFinite(opts?.size) ? Math.max(0, Math.floor(opts.size)) : 0;
  if (size === 0 || list.length === 0) return [];
  if (list.length <= size) return list.slice().sort(compareForOutput);

  const [d1, d2] = opts.tiersDays ?? [7, 30];
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Number.NaN;
  const seed = typeof opts.seed === "string" ? opts.seed : "";

  const tiers: T[][] = [[], [], []];
  for (const row of list) {
    // An unusable clock cannot be reasoned about — treat the whole pool as one tier.
    tiers[Number.isNaN(nowMs) ? 2 : tierIndexOf(row, nowMs, d1, d2)].push(row);
  }
  const capacities = tiers.map(t => t.length);
  const total = Math.min(size, list.length);
  const quota = applyFloors(proportionalQuota(total, capacities), capacities, total);

  const picked: T[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const take = Math.min(quota[i], tiers[i].length);
    if (take <= 0) continue;
    // Sort by id first so the sample does not depend on the row order the DB returned.
    const members = tiers[i].slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rand = mulberry32(fnv1a32(`${seed}:${TIER_NAMES[i]}`));
    for (let n = 0; n < take; n++) {
      const j = n + Math.floor(rand() * (members.length - n));
      const swap = members[n];
      members[n] = members[j];
      members[j] = swap;
    }
    picked.push(...members.slice(0, take));
  }
  return picked.sort(compareForOutput);
}
