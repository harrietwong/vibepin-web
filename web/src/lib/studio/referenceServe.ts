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

  const requestId = optionalString(raw.requestId) ?? gen.uuid();

  const source = raw.analysisSource;
  const analysisSource = ANALYSIS_SOURCES.includes(source as AnalysisSource)
    ? (source as AnalysisSource)
    : "none";

  const status = raw.analysisStatus;
  const analysisStatus = ANALYSIS_STATUSES.includes(status as AnalysisStatus)
    ? (status as AnalysisStatus)
    : "none";

  // Filter then dedupe then truncate, in that order: dropping junk first means 72 real
  // ids survive even when the client padded the list with nulls or repeats.
  const excludeIds = Array.isArray(raw.excludeIds)
    ? Array.from(new Set(raw.excludeIds.filter((id): id is string => typeof id === "string" && id.length > 0)))
        .slice(0, MAX_EXCLUDE_IDS)
    : [];

  return {
    draftId: optionalString(raw.draftId),
    requestId,
    imageKey: optionalString(raw.imageKey),
    analysisSource,
    analysisStatus,
    seed: optionalString(raw.seed),
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
}): Served {
  const poolIds = Array.isArray(args.poolIds) ? args.poolIds : [];
  const results = Array.isArray(args.results) ? args.results : [];
  const tier1Count = results.filter(r => r?.recommendationTier === PRODUCT_EVIDENCE_TIER).length;

  return {
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
}
