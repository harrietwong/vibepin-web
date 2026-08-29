/**
 * referenceServe.ts — the pure half of POST /api/reference-candidates.
 *
 * Everything the serving route does that is NOT a database call lives here so it can be
 * unit-tested without Supabase: parsing the (entirely optional) observability fields off
 * the request body, deriving the daily seed, merging the four per-category result lists
 * for an unknown category, and assembling the `served` telemetry block that both the
 * response and the `reference_recs_served` event carry.
 *
 * Two invariants shaped this module:
 *
 *  - **No new required request fields.** Old clients and existing test fixtures POST
 *    `{ imageAnalysis, product, category, limit }` and nothing else; every contract field
 *    is parsed defensively with a safe default so a missing/garbage value can never turn
 *    a recommendation request into a 400.
 *  - **No IO, no clock.** `now` is injected into `defaultSeed`, ids arrive as arrays.
 *    The route owns Supabase, `crypto.randomUUID()` and `new Date()`; this file owns the
 *    decisions, which is what the tests need to pin down.
 */

import { poolHash } from "@/lib/studio/referencePool";
import type { P0Canonical } from "@/lib/studio/referenceCategory";
import type { RecommendationBasis } from "@/lib/studio/referenceScoring";
import { byteLength } from "@/lib/analyticsIngest";

/** Where the image analysis in the request came from (client-declared, telemetry only). */
export type AnalysisSource = "draft" | "stateless" | "none";
/** Lifecycle of that analysis at request time (client-declared, telemetry only). */
export type AnalysisStatus = "ready" | "pending" | "failed" | "none";
/** How the candidate pool was assembled for this request. */
export type PoolMode = "single" | "merged-fashion" | "unknown-roundrobin";

const ANALYSIS_SOURCES: readonly AnalysisSource[] = ["draft", "stateless", "none"];
const ANALYSIS_STATUSES: readonly AnalysisStatus[] = ["ready", "pending", "failed", "none"];

/** Hard cap on `excludeIds`: the drawer accumulates seen ids across refreshes and an
 *  unbounded list would grow the request body without limit. */
export const MAX_EXCLUDE_IDS = 72;

/** Hard cap, in characters, on every free-text observability field (`requestId`,
 *  `imageKey`, `seed`, `draftId`, and each `excludeIds` entry). These fields are echoed
 *  verbatim into `served` and ultimately into the analytics event; without a source-level
 *  limit a single oversized value (e.g. a corrupted client `requestId`) can make even the
 *  "minimal floor" stage of `boundedServedPayload` exceed its byte budget, defeating it. */
export const MAX_FIELD_CHARS = 200;

/** `optionalString`, then clamp to `MAX_FIELD_CHARS`. Truncating (not discarding) a
 *  present-but-oversized value keeps its prefix stable, so a client that logs its own
 *  `requestId` can still correlate the truncated one back to the same request. */
function boundedString(value: unknown): string | undefined {
  const s = optionalString(value);
  return s === undefined ? undefined : s.slice(0, MAX_FIELD_CHARS);
}

/** The observability request fields, after defaulting. Only `requestId` is guaranteed. */
export type ServeRequestFields = {
  draftId?: string;
  requestId: string;
  imageKey?: string;
  analysisSource: AnalysisSource;
  analysisStatus: AnalysisStatus;
  seed?: string;
  excludeIds: string[];
};

/** The telemetry block: identical in the response and in the served event payload. */
export type Served = {
  requestId: string;
  categoryInput: string | null;
  categoryCanonical: P0Canonical | null;
  poolMode: PoolMode;
  poolSize: number;
  poolHash: string;
  excludedCount: number;
  tier1Count: number;
  tier2Count: number;
  ids: string[];
  recommendationBasis: RecommendationBasis;
  /** Canonical categories whose pool query failed on the unknown-roundrobin path and were
   *  excluded from `poolSize` / `poolHash` / `excludedCount` and ranking. Only present when
   *  at least one pool degraded; a fully-healthy request never carries this key. */
  degradedPools?: string[];
};

/** Minimum shape `mergeRoundRobin` / `buildServed` need from a ranked result. */
export type TieredResult = { id: string; recommendationTier?: string };

const PRODUCT_EVIDENCE_TIER = "product_evidence";

/** Trimmed non-empty string, or undefined. Blank is treated as absent, not as a value. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the observability fields off an arbitrary request body.
 *
 * Every field is optional and every invalid value degrades instead of failing:
 * a missing/blank/non-string `requestId` is generated server-side (so the event still
 * correlates with the response), an unrecognised enum becomes `"none"` rather than being
 * echoed back into analytics, and a non-array `excludeIds` becomes `[]`. `gen` is injected
 * so tests get a deterministic id without stubbing globals.
 */
export function parseServeFields(body: unknown, gen: { uuid: () => string }): ServeRequestFields {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const requestId = boundedString(raw.requestId) ?? gen.uuid();

  const source = raw.analysisSource;
  const analysisSource = ANALYSIS_SOURCES.includes(source as AnalysisSource)
    ? (source as AnalysisSource)
    : "none";

  const status = raw.analysisStatus;
  const analysisStatus = ANALYSIS_STATUSES.includes(status as AnalysisStatus)
    ? (status as AnalysisStatus)
    : "none";

  // Filter then dedupe then truncate, in that order: dropping junk first means 72 real
  // ids survive even when the client padded the list with nulls or repeats. Each surviving
  // id is then length-clamped so a single oversized entry can't blow the payload budget.
  const excludeIds = Array.isArray(raw.excludeIds)
    ? Array.from(new Set(raw.excludeIds.filter((id): id is string => typeof id === "string" && id.length > 0)))
        .slice(0, MAX_EXCLUDE_IDS)
        .map(id => id.slice(0, MAX_FIELD_CHARS))
    : [];

  return {
    draftId: boundedString(raw.draftId),
    requestId,
    imageKey: boundedString(raw.imageKey),
    analysisSource,
    analysisStatus,
    seed: boundedString(raw.seed),
    excludeIds,
  };
}

/**
 * Seed used when the client did not send one: stable for a whole UTC day per canonical
 * category, so a reload shows the same batch but tomorrow's crawl can surface.
 */
export function defaultSeed(canonical: string | null, now: Date): string {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  const day = Number.isNaN(ms) ? "invalid-date" : new Date(ms).toISOString().slice(0, 10);
  return `${canonical ?? "unknown"}:${day}`;
}

/**
 * Interleave several ranked lists, product evidence first.
 *
 * Used only for the unknown-category path, where four independent category rankings must
 * become one list. Taking a prefix of each list would be wrong: with `keywordClusterCap`
 * on, `rankReferencesTiered` emits Tier-1 keeps, then Tier-2 keeps, then Tier-1 overflow,
 * then Tier-2 overflow — so `product_evidence` rows are NOT contiguous. We therefore
 * partition each list by tier (preserving its internal order), round-robin the evidence
 * partitions, then round-robin the rest — guaranteeing that a genuine product match from
 * the fourth category outranks category filler from the first. Ids are deduped across
 * lists; `limit <= 0` means "no truncation".
 */
export function mergeRoundRobin<T extends TieredResult>(lists: T[][], limit: number): T[] {
  const source = (Array.isArray(lists) ? lists : []).filter((l): l is T[] => Array.isArray(l));
  const evidence = source.map(l => l.filter(r => r && r.recommendationTier === PRODUCT_EVIDENCE_TIER));
  const rest = source.map(l => l.filter(r => r && r.recommendationTier !== PRODUCT_EVIDENCE_TIER));

  const out: T[] = [];
  const seen = new Set<string>();
  const drain = (groups: T[][]) => {
    const depth = groups.reduce((max, g) => Math.max(max, g.length), 0);
    for (let i = 0; i < depth; i++) {
      for (const group of groups) {
        const row = group[i];
        if (!row || typeof row.id !== "string" || seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
      }
    }
  };
  drain(evidence);
  drain(rest);

  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Assemble the `served` telemetry block.
 *
 * `poolIds` is every id that actually entered ranking (post-sampling, post-exclusion, and
 * for the unknown path the union of all four pools) — that is what makes `poolSize` and
 * `poolHash` comparable between two requests, which is the whole point of logging them:
 * "same product, same pool hash, same ids" is how a stale-recommendations report gets
 * confirmed or refuted from data instead of from a story.
 */
export function buildServed(args: {
  requestId: string;
  categoryInput: string | null;
  categoryCanonical: P0Canonical | null;
  poolMode: PoolMode;
  poolIds: string[];
  excludedCount: number;
  results: TieredResult[];
  recommendationBasis: RecommendationBasis;
  degradedPools?: string[];
}): Served {
  const poolIds = Array.isArray(args.poolIds) ? args.poolIds : [];
  const results = Array.isArray(args.results) ? args.results : [];
  const tier1Count = results.filter(r => r?.recommendationTier === PRODUCT_EVIDENCE_TIER).length;

  const served: Served = {
    requestId: args.requestId,
    categoryInput: args.categoryInput ?? null,
    categoryCanonical: args.categoryCanonical ?? null,
    poolMode: args.poolMode,
    poolSize: poolIds.length,
    poolHash: poolHash(poolIds),
    excludedCount: Math.max(0, Math.floor(args.excludedCount || 0)),
    tier1Count,
    tier2Count: results.length - tier1Count,
    ids: results.map(r => r.id),
    recommendationBasis: args.recommendationBasis,
  };
  if (Array.isArray(args.degradedPools) && args.degradedPools.length > 0) {
    served.degradedPools = args.degradedPools;
  }
  return served;
}

/**
 * Start of the UTC day containing `date`. The route feeds THIS — not the wall clock — to
 * the sampler: its freshness tiers (<=7d / <=30d) are relative to `now`, so a per-request
 * clock let a row cross a tier boundary between two calls with the same daily seed and
 * change the sample (live smoke: same seed, 2 of 9 ids drifted within minutes). Same UTC
 * day => same tiers => same sample; the daily seed already rotates at the same boundary.
 */
export function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The fields kept when even step 2 of `boundedServedPayload` is still over budget. This
 *  set is deliberately tiny and its one free-text field (`requestId`) is bounded at the
 *  source by `parseServeFields`, so in practice it is always well under `maxBytes` for any
 *  4KiB-class budget; `boundedServedPayload` re-clamps every string here anyway so that
 *  guarantee does not depend on every caller going through that source-level bound. */
const MINIMAL_SERVED_KEYS = [
  "requestId",
  "recommendationBasis",
  "poolMode",
  "tier1Count",
  "tier2Count",
  "poolSize",
  "excludedCount",
  "analysisSource",
  "analysisStatus",
] as const;

/**
 * Bound the size of the `reference_recs_served` analytics payload without going through
 * `analyticsIngest.normalizePayload`'s all-or-nothing truncation, which would otherwise
 * replace the whole block with `{_truncated,_bytes}` and lose every field. Degrades in
 * stages, re-measuring with the same `byteLength` `normalizePayload` uses so the two stay
 * consistent, and returns as soon as a stage fits. Never mutates `payload`.
 *
 * The return value is guaranteed to be `<= maxBytes` for any input: the last two stages
 * re-clamp (and, if needed, progressively shrink) every string field of the minimal floor,
 * so an oversized field that reaches this function some other way than `parseServeFields`
 * can never make it return an over-budget payload.
 */
export function boundedServedPayload(
  payload: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  if (byteLength(payload) <= maxBytes) return payload;

  // Stage 1: drop the `ids` array, keep a count instead.
  const idsCount = Array.isArray(payload.ids) ? payload.ids.length : 0;
  const withoutIds: Record<string, unknown> = { ...payload, idsCount, _idsElided: true };
  delete withoutIds.ids;
  if (byteLength(withoutIds) <= maxBytes) return withoutIds;

  // Stage 2: also drop poolHash and categoryInput (unbounded-ish / low telemetry value
  // relative to their size once we are already over budget).
  const withoutBulky: Record<string, unknown> = { ...withoutIds };
  delete withoutBulky.poolHash;
  delete withoutBulky.categoryInput;
  if (byteLength(withoutBulky) <= maxBytes) return withoutBulky;

  // Stage 3: floor — only the small, bounded fields every event needs to be diagnosable.
  // `MINIMAL_SERVED_KEYS` is normally small enough on its own, but it includes free-text
  // fields (`requestId`) that `parseServeFields` bounds at the source — not fields this
  // function controls. A caller that bypasses that source-level clamp (or any future
  // free-text field added to the set) must not be able to defeat the floor, so every string
  // value here is re-clamped, and if the result is STILL over budget every string is
  // truncated harder until it fits or there is nothing left to cut.
  const minimal: Record<string, unknown> = { idsCount, _idsElided: true };
  for (const key of MINIMAL_SERVED_KEYS) {
    if (!(key in payload)) continue;
    const value = payload[key];
    minimal[key] = typeof value === "string" ? value.slice(0, MAX_FIELD_CHARS) : value;
  }
  if (byteLength(minimal) <= maxBytes) return minimal;

  // Stage 4: the floor itself doesn't fit (e.g. maxBytes is pathologically small, or the
  // minimal set still has many bounded-but-numerous string fields). Shrink every string
  // field in `minimal` in lockstep until it fits, then fall back to the smallest possible
  // diagnosable object.
  let budget = MAX_FIELD_CHARS;
  while (budget > 0) {
    budget = Math.floor(budget / 2);
    for (const key of Object.keys(minimal)) {
      const value = minimal[key];
      if (typeof value === "string") minimal[key] = value.slice(0, budget);
    }
    if (byteLength(minimal) <= maxBytes) return minimal;
  }

  const floor: Record<string, unknown> = { _idsElided: true, idsCount, _floorTruncated: true };
  if (byteLength(floor) <= maxBytes) return floor;
  const smaller: Record<string, unknown> = { _idsElided: true, _floorTruncated: true };
  if (byteLength(smaller) <= maxBytes) return smaller;
  // `maxBytes` is smaller than any non-empty JSON object can be — there is nothing left to
  // diagnose with, only the guarantee to keep.
  return {};
}
