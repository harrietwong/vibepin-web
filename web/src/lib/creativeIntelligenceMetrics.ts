/**
 * creativeIntelligenceMetrics.ts — PURE aggregation logic for the internal
 * /admin/creative-intelligence report. No network, no Supabase, no I/O — the server
 * loader (lib/server/creativeIntelligence.ts) fetches rows and delegates all counting/
 * bucketing math here so the exact reporting口径 unit-tests in isolation
 * (scripts/test-creative-intelligence-metrics.ts).
 *
 * Data source: analytics_events (migrate_v41) — client-side beacons, best-effort by
 * design (dropped when signed out / table missing / beacon lost), so every number here
 * is a directional signal, NOT a complete ledger. The page states this caveat.
 */

/** Funnel stages in product order (upload → publish). Rendered as one row of counts. */
export const FUNNEL_EVENTS = [
  "image_analysis_ready",
  "recommended_keywords_ready",
  "direction_selected",
  "reference_selected",
  "ai_copy_success",
  "generation_judged",
  "generation_kept",
  "draft_published",
] as const;

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

/** Extra (non-funnel) counters shown as ratio/activity cards. */
export const EXTRA_COUNT_EVENTS = ["regenerate_clicked", "keyword_removed"] as const;

export const JUDGE_VERDICTS = ["ok", "borderline", "invalid"] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

/** Fixed 20-point buckets for the `overall` score histogram (0-100). */
export const OVERALL_BUCKETS = [
  { label: "0-19", min: 0, max: 19 },
  { label: "20-39", min: 20, max: 39 },
  { label: "40-59", min: 40, max: 59 },
  { label: "60-79", min: 60, max: 79 },
  { label: "80-100", min: 80, max: 100 },
] as const;

export type JudgeDistribution = {
  /** generation_judged rows inspected (rows with a recognizable payload). */
  total: number;
  /** Count per verdict; rows with an unknown/missing verdict are excluded. */
  verdictCounts: Record<JudgeVerdict, number>;
  /** Rows counted into verdictCounts (denominator for verdict share). */
  verdictTotal: number;
  /** Histogram over payload.overall; rows without a numeric overall are excluded. */
  overallBuckets: Array<{ label: string; count: number }>;
  /** Rows counted into the histogram. */
  overallTotal: number;
};

/** Loose shape of a generation_judged analytics payload (client-written JSONB). */
export type JudgedPayload = { verdict?: unknown; overall?: unknown } | null | undefined;

/**
 * Aggregate raw generation_judged payloads into verdict shares + an overall histogram.
 * Tolerant of malformed payloads: unknown verdicts and non-numeric overalls are simply
 * left out of their respective denominators (never guessed).
 */
export function summarizeJudgedPayloads(payloads: JudgedPayload[]): JudgeDistribution {
  const verdictCounts: Record<JudgeVerdict, number> = { ok: 0, borderline: 0, invalid: 0 };
  const bucketCounts = OVERALL_BUCKETS.map(() => 0);
  let verdictTotal = 0;
  let overallTotal = 0;

  for (const p of payloads) {
    if (!p || typeof p !== "object") continue;
    const verdict = typeof p.verdict === "string" ? p.verdict : "";
    if ((JUDGE_VERDICTS as readonly string[]).includes(verdict)) {
      verdictCounts[verdict as JudgeVerdict] += 1;
      verdictTotal += 1;
    }
    const overall = typeof p.overall === "number" && Number.isFinite(p.overall) ? p.overall : null;
    if (overall !== null) {
      const clamped = Math.max(0, Math.min(100, Math.round(overall)));
      const idx = OVERALL_BUCKETS.findIndex(b => clamped >= b.min && clamped <= b.max);
      if (idx >= 0) {
        bucketCounts[idx] += 1;
        overallTotal += 1;
      }
    }
  }

  return {
    total: payloads.filter(p => !!p && typeof p === "object").length,
    verdictCounts,
    verdictTotal,
    overallBuckets: OVERALL_BUCKETS.map((b, i) => ({ label: b.label, count: bucketCounts[i] })),
    overallTotal,
  };
}

/**
 * Safe ratio → percentage (0-100, one decimal) or null when the denominator is 0/
 * missing. Null renders as "n/a" — never fabricate 0% out of an empty denominator.
 */
export function ratePct(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  const n = typeof numerator === "number" && Number.isFinite(numerator) ? numerator : null;
  const d = typeof denominator === "number" && Number.isFinite(denominator) ? denominator : null;
  if (n === null || d === null || d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

export type RateCard = {
  id: string;
  label: string;
  /** Percentage 0-100 (may exceed 100 — events are not strictly 1:1), or null = n/a. */
  pct: number | null;
  numerator: number;
  denominator: number;
  /** Human-readable口径 note, e.g. "direction_selected / image_analysis_ready". */
  basis: string;
};

/**
 * The two funnel ratio cards, with their denominators made explicit:
 *  - Direction selection rate = direction_selected / image_analysis_ready
 *    (of uploads whose analysis finished, how many picked a creative direction).
 *  - Reference selection rate = reference_selected / direction_selected
 *    (of sessions that picked a direction, how many also picked a reference —
 *    reference picking follows direction picking in the studio flow, so this is a
 *    cleaner denominator than generation_judged, which counts *generated results*
 *    and can be 0..N per session).
 */
export function buildRateCards(counts: Partial<Record<string, number>>): RateCard[] {
  const c = (name: string) => counts[name] ?? 0;
  return [
    {
      id: "direction_rate",
      label: "Direction selection rate",
      pct: ratePct(c("direction_selected"), c("image_analysis_ready")),
      numerator: c("direction_selected"),
      denominator: c("image_analysis_ready"),
      basis: "direction_selected / image_analysis_ready",
    },
    {
      id: "reference_rate",
      label: "Reference selection rate",
      pct: ratePct(c("reference_selected"), c("direction_selected")),
      numerator: c("reference_selected"),
      denominator: c("direction_selected"),
      basis: "reference_selected / direction_selected",
    },
  ];
}
