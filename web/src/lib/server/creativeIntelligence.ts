// ── Creative Intelligence metrics (READ-ONLY, internal admin) ────────────────
//
// Powers /admin/creative-intelligence. Aggregates the analytics_events sink
// (migrate_v41) into a funnel row, ratio cards, and a judge-verdict distribution
// for the last 7 or 30 days. Read-only; all math lives in the pure module
// lib/creativeIntelligenceMetrics.ts so the口径 unit-tests without Supabase.
//
// Query strategy: one HEAD count per event name (10 small indexed counts on
// (event_name, created_at)) + ONE bounded fetch of recent generation_judged
// payloads (JUDGE_ROWS_LIMIT) aggregated in memory. No unbounded row pulls.
//
// Degrades gracefully: missing analytics_events table (v41 unapplied) →
// available:false + warning, never a crash. Empty table → zeros.

import {
  buildRateCards,
  EXTRA_COUNT_EVENTS,
  FUNNEL_EVENTS,
  summarizeJudgedPayloads,
  type JudgeDistribution,
  type RateCard,
} from "@/lib/creativeIntelligenceMetrics";

type PgError = { code?: string; message?: string } | null;

/** Cap on generation_judged rows pulled for the distribution (row-count protection). */
const JUDGE_ROWS_LIMIT = 2000;

export type CreativeIntelligenceWindow = 7 | 30;

export type CreativeIntelligenceMetrics = {
  available: boolean;
  generatedAt: string;
  windowDays: CreativeIntelligenceWindow;
  sinceIso: string;
  warnings: string[];
  /** event_name → count within the window (funnel + extra events). */
  counts: Record<string, number>;
  funnel: Array<{ event: string; count: number }>;
  rateCards: RateCard[];
  regenerateClicks: number;
  keywordRemovals: number;
  judge: JudgeDistribution;
  /** True when the judge distribution was computed on a capped sample. */
  judgeSampleCapped: boolean;
};

function isMissingRelation(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .* does not exist|could not find the table/i.test(error.message ?? "");
}

function emptyMetrics(windowDays: CreativeIntelligenceWindow, sinceIso: string, warnings: string[]): CreativeIntelligenceMetrics {
  const counts: Record<string, number> = {};
  for (const e of [...FUNNEL_EVENTS, ...EXTRA_COUNT_EVENTS]) counts[e] = 0;
  return {
    available: false,
    generatedAt: new Date().toISOString(),
    windowDays,
    sinceIso,
    warnings,
    counts,
    funnel: FUNNEL_EVENTS.map(event => ({ event, count: 0 })),
    rateCards: buildRateCards(counts),
    regenerateClicks: 0,
    keywordRemovals: 0,
    judge: summarizeJudgedPayloads([]),
    judgeSampleCapped: false,
  };
}

export async function getCreativeIntelligenceMetrics(
  windowDays: CreativeIntelligenceWindow,
): Promise<CreativeIntelligenceMetrics> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const eventNames = [...FUNNEL_EVENTS, ...EXTRA_COUNT_EVENTS] as readonly string[];

  // One indexed HEAD count per event, in parallel.
  let missingTable = false;
  const counts: Record<string, number> = {};
  const countResults = await Promise.all(
    eventNames.map(async name => {
      const { count, error } = await db
        .from("analytics_events")
        .select("id", { count: "exact", head: true })
        .eq("event_name", name)
        .gte("created_at", sinceIso);
      return { name, count: count ?? 0, error: error as PgError };
    }),
  );
  for (const r of countResults) {
    if (r.error) {
      if (isMissingRelation(r.error)) missingTable = true;
      else warnings.push(`count(${r.name}) failed: ${r.error.message ?? "unknown error"}`);
      counts[r.name] = 0;
    } else {
      counts[r.name] = r.count;
    }
  }
  if (missingTable) {
    return emptyMetrics(windowDays, sinceIso, [
      "analytics_events table not found — apply migrate_v41_creative_intelligence.sql. No events are being persisted yet.",
      ...warnings,
    ]);
  }

  // Bounded pull of recent generation_judged payloads for the distribution.
  let judgePayloads: Array<Record<string, unknown> | null> = [];
  let judgeSampleCapped = false;
  {
    const { data, error } = await db
      .from("analytics_events")
      .select("payload")
      .eq("event_name", "generation_judged")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(JUDGE_ROWS_LIMIT);
    if (error) {
      warnings.push(`generation_judged fetch failed: ${(error as PgError)?.message ?? "unknown error"}`);
    } else {
      judgePayloads = (data ?? []).map(r => (r as { payload: Record<string, unknown> | null }).payload);
      judgeSampleCapped = judgePayloads.length >= JUDGE_ROWS_LIMIT
        && (counts["generation_judged"] ?? 0) > JUDGE_ROWS_LIMIT;
    }
  }

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    windowDays,
    sinceIso,
    warnings,
    counts,
    funnel: FUNNEL_EVENTS.map(event => ({ event, count: counts[event] ?? 0 })),
    rateCards: buildRateCards(counts),
    regenerateClicks: counts["regenerate_clicked"] ?? 0,
    keywordRemovals: counts["keyword_removed"] ?? 0,
    judge: summarizeJudgedPayloads(judgePayloads),
    judgeSampleCapped,
  };
}
