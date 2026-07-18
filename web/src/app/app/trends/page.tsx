"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import useSWR from "swr";
import {
  Search, X, TrendingUp, Heart, Users, Trophy,
  Plus, BarChart2, Sparkles, ChevronDown,
  ChevronRight, Bookmark, Lightbulb, ShoppingBag, Package,
  Calendar, Target, ArrowRight,
} from "lucide-react";
import Image from "next/image";
import { createBrowserClient } from "@supabase/ssr";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { buildPrefillFromKeywordTrend, openCreatePins } from "@/lib/createPinsPrefill";
import { getWeekStart } from "@/lib/useWeeklyPlan";
import dynamic from "next/dynamic";
import type {
  Band, CompetitionBand, SaveSignalBand, TrendState,
  KeywordSummary, RelatedKeywordRow, DataConfidence, KeywordTrendsMeta,
  DataSourceLabel,
} from "@/lib/keyword-data/types";
import type { WorkspaceTier } from "@/lib/workspaceStatics";
import { CATEGORIES, catEmoji } from "@/lib/categories";
import { usePinterestRegion, useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { markDataReady } from "@/lib/navTiming";

// Lazily loaded — recharts is a heavy dependency, and this chart only ever
// renders inside the searched-keyword insight section or the Evidence
// drawer, neither of which is visible on first paint.
const TrendHistoryChart = dynamic(() =>
  import("@/components/ui/TrendHistoryChart").then(m => m.TrendHistoryChart), { ssr: false });

const TRENDING_PAGE_SIZE = 20;

function formatFreshnessDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

// Compact relative time ("2h ago", "3d ago") for the trending "Updated" column.
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// Normalize a keyword for dedup: lowercase, trim, collapse whitespace, drop punctuation.
function normKeyword(s: string): string {
  return s.toLowerCase().trim().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
}

// Deduplicate rows by normalized keyword, keeping first occurrence.
function dedupeByKeyword<T extends { keyword: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = normKeyword(r.keyword);
    if (k && seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function EstimatedBadge() {
  const { t: tr } = useLocale();
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
      {tr("trends.badge.estimated")}
    </span>
  );
}

function DataSourceBadge({ label }: { label?: DataSourceLabel }) {
  const { t: tr } = useLocale();
  if (!label || label === "Derived") {
    return (
      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
        {tr("trends.badge.estimated")}
      </span>
    );
  }
  if (label === "Official") {
    return (
      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap">
        {tr("trends.badge.official")}
      </span>
    );
  }
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
      {tr("trends.badge.estimated")}
    </span>
  );
}

// ── Dark eRank-style table primitives ──────────────────────────────────────────

// Muted metric colors. Purple is reserved for primary actions / selection.
const METRIC_INTEREST = "#34D399";  // muted emerald
const METRIC_SAVE     = "#2DD4BF";  // muted teal
const METRIC_NEUTRAL  = "#64748B";  // slate

function competitionColor(band: CompetitionBand): string {
  // Low competition = good (green); Medium = amber; High = caution (orange-red).
  return band === "Low" ? "#34D399" : band === "Medium" ? "#FBBF24" : "#FB7185";
}

/** Compact value/100 bar — number above, muted track + colored fill below. */
function MetricBar({ value, color, emphasis }: { value?: number; color: string; emphasis?: boolean }) {
  const { t: tr } = useLocale();
  const v = value == null ? null : Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="w-full pr-3">
      <div className="flex items-baseline gap-0.5 mb-1">
        <span className={emphasis ? "text-[12px] font-bold tabular-nums" : "text-[11px] font-semibold tabular-nums"}
          style={{ color: v == null ? "var(--app-text-muted)" : emphasis ? color : "var(--app-text)" }}>
          {v ?? "—"}
        </span>
        {v != null && <span className="text-[9px] tabular-nums" style={{ color: "var(--app-text-muted)" }}>{tr("trends.metric.per100")}</span>}
      </div>
      <div className="rounded-full w-full overflow-hidden" style={{ height: emphasis ? 4 : 3, background: "var(--app-inset-hi)" }}>
        <div className="h-full rounded-full" style={{ width: `${v ?? 0}%`, background: color, opacity: v == null ? 0 : 0.9 }} />
      </div>
    </div>
  );
}

/** Subtle outlined source pill: Official=green, Estimated=amber, Derived=gray. */
function SourcePill({ label }: { label?: DataSourceLabel }) {
  const map = {
    Official:  "#34D399",
    Estimated: "#FBBF24",
    Derived:   "#94A3B8",
  } as const;
  const key: DataSourceLabel = label ?? "Estimated";
  const c = map[key] ?? map.Estimated;
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md border bg-transparent whitespace-nowrap"
      style={{ color: c, borderColor: `${c}55` }}>
      {key}
    </span>
  );
}

/** Subtle trend cell: icon + label, muted color, no loud pill. */
function TrendCell({ state }: { state: TrendState }) {
  const map: Record<TrendState, { c: string; icon: string }> = {
    Rising:    { c: "#34D399", icon: "↑" },
    Evergreen: { c: "#2DD4BF", icon: "∞" },
    Seasonal:  { c: "#60A5FA", icon: "❄" },
    "Rising · Needs Products": { c: "#FBBF24", icon: "↑" },
    "Insight Only":            { c: "#9CA3AF", icon: "◎" },
  };
  const d = map[state] ?? map.Rising;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap" style={{ color: d.c }}>
      <span className="text-[10px]">{d.icon}</span>{state}
    </span>
  );
}

type KeywordTrendsResponse = {
  rows: RelatedKeywordRow[];
  summary: KeywordSummary | null;
  meta: KeywordTrendsMeta;
  message?: string;
  error?: string;
};

async function fetchKeywordTrends(params: URLSearchParams): Promise<KeywordTrendsResponse> {
  const res = await fetch(`/api/keyword-trends?${params}`);
  const body = await res.json() as KeywordTrendsResponse & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Failed to load keyword trends");
  return body;
}

// ── Color palettes ─────────────────────────────────────────────────────────────

const INTEREST_COLOR: Record<Band, { text: string; bg: string }> = {
  High:   { text: "#059669", bg: "rgba(5,150,105,0.10)" },
  Medium: { text: "#D97706", bg: "rgba(245,158,11,0.10)" },
  Low:    { text: "#6B7280", bg: "rgba(156,163,175,0.10)" },
};

const COMP_COLOR: Record<CompetitionBand, { text: string; bg: string }> = {
  Low:    { text: "#059669", bg: "rgba(5,150,105,0.10)" },
  Medium: { text: "#D97706", bg: "rgba(245,158,11,0.10)" },
  High:   { text: "#DC2626", bg: "rgba(239,68,68,0.10)" },
};

const SAVE_COLOR: Record<SaveSignalBand, { text: string; bg: string }> = {
  Strong: { text: "#D946EF", bg: "rgba(217,70,239,0.10)" },
  Medium: { text: "#D97706", bg: "rgba(245,158,11,0.10)" },
  Weak:   { text: "#6B7280", bg: "rgba(156,163,175,0.10)" },
};

const TREND_META: Record<TrendState, { text: string; icon: string }> = {
  Rising:    { text: "#059669", icon: "↑" },
  Evergreen: { text: "#0891B2", icon: "∞" },
  Seasonal:  { text: "#D97706", icon: "◎" },
  "Rising · Needs Products": { text: "#D97706", icon: "↑" },
  "Insight Only":            { text: "#6B7280", icon: "◎" },
};

// ── Band display components ────────────────────────────────────────────────────

function InterestBand({ band }: { band: Band }) {
  const s = INTEREST_COLOR[band];
  return (
    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.text }}>{band}</span>
  );
}

function CompBand({ band }: { band: CompetitionBand }) {
  const s = COMP_COLOR[band];
  return (
    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.text }}>{band}</span>
  );
}

function SaveBand({ band }: { band?: SaveSignalBand }) {
  if (!band) return <span className="text-[10px] text-gray-400">—</span>;
  const s = SAVE_COLOR[band];
  return (
    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.text }}>{band}</span>
  );
}

function TrendChip({ state }: { state: TrendState }) {
  const { text, icon } = TREND_META[state];
  return (
    <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: text }}>
      {icon} {state}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: "High" | "Medium" | "Low" }) {
  const { t: tr } = useLocale();
  const cfg = {
    High:   { color: "#059669", bg: "rgba(5,150,105,0.10)" },
    Medium: { color: "#D97706", bg: "rgba(245,158,11,0.10)" },
    Low:    { color: "#6B7280", bg: "rgba(156,163,175,0.10)" },
  }[confidence];
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap shrink-0"
      style={{ background: cfg.bg, color: cfg.color }}>
      {confidence} {tr("trends.confidenceSuffix")}
    </span>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────

function SummaryCard({
  title, value, subtitle, color, bg, icon, relativeIndex, sourceNote,
}: {
  title: string; value: string; subtitle: string;
  color: string; bg: string; icon: React.ReactNode;
  relativeIndex?: number; sourceNote?: string;
}) {
  const { t: tr } = useLocale();
  return (
    <div data-testid="keyword-summary-card" className="bg-white border border-gray-200 rounded-xl p-4 flex items-start gap-3">
      <div className="shrink-0 h-9 w-9 rounded-lg flex items-center justify-center" style={{ background: bg }}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{title}</p>
        <div className="flex items-baseline gap-2">
          <p className="text-[16px] font-black leading-none" style={{ color }}>{value}</p>
          {relativeIndex != null && (
            <span className="text-[12px] font-mono text-gray-400 leading-none">
              {relativeIndex}<span className="text-[9px] text-gray-400">{tr("trends.metric.per100")}</span>
            </span>
          )}
        </div>
        <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">{subtitle}</p>
        {sourceNote && (
          <p className="text-[9px] text-gray-400 mt-0.5 leading-relaxed">{sourceNote}</p>
        )}
      </div>
    </div>
  );
}

function KeywordSummaryCards({ s }: { s: KeywordSummary }) {
  const { t: tr } = useLocale();
  const iC = INTEREST_COLOR[s.pinterestInterestBand];
  const cC = COMP_COLOR[s.competitionBand];
  const sC = s.saveSignalBand ? SAVE_COLOR[s.saveSignalBand] : SAVE_COLOR.Weak;

  const iM = s.interestMetric;
  const sM = s.saveMetric;
  const cM = s.competitionMetric;

  // No Opportunity card (v2.0 final: no unified opportunity labels anywhere).
  // Competition is demoted to "Content Saturation" — an auxiliary detail signal
  // about content density, NOT market competition.
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
      <SummaryCard
        title={tr("trends.summary.pinterestInterest")} value={iM?.label ?? s.pinterestInterestBand} color={iC.text} bg={iC.bg}
        subtitle={iM?.sourceNote ?? (s.interestIndexCurrent != null ? tr("trends.summary.indexPastTwelveMonths").replace("{n}", String(s.interestIndexCurrent)) : tr("trends.summary.pastTwelveMonths"))}
        relativeIndex={iM?.relativeIndex}
        icon={<TrendingUp className="h-4 w-4" style={{ color: iC.text }} />}
      />
      <SummaryCard
        title={tr("trends.summary.saveSignal")} value={sM?.label ?? s.saveSignalBand ?? "—"} color={sC.text} bg={sC.bg}
        subtitle={s.saveSignalBand === "Strong" ? tr("trends.summary.viralPins") : s.saveSignalBand === "Medium" ? tr("trends.summary.moderateEngagement") : tr("trends.summary.limitedEvidence")}
        relativeIndex={sM?.relativeIndex}
        sourceNote={sM?.sourceNote}
        icon={<Heart className="h-4 w-4" style={{ color: sC.text }} />}
      />
      <SummaryCard
        title={tr("trends.summary.contentSaturation")} value={cM?.label ?? s.competitionBand} color={cC.text} bg={cC.bg}
        subtitle={s.competitionBand === "High" ? tr("trends.summary.manySimilarPins") : s.competitionBand === "Medium" ? tr("trends.summary.someSimilarContent") : tr("trends.summary.fewSimilarPins")}
        relativeIndex={cM?.relativeIndex}
        sourceNote={cM?.sourceNote ?? tr("trends.summary.saturationSourceNote")}
        icon={<Users className="h-4 w-4" style={{ color: cC.text }} />}
      />
    </div>
  );
}

// ── Search suggestions — REAL Pinterest dropdown expansions for this keyword ───
// Data: keyword_expansions (written by the crawler from Pinterest's autocomplete).
// Ordered by dropdown rank (migrate_v36) when available; pre-v36 rows fall back
// to insertion order and simply show no rank number.
function SearchSuggestionsStrip({ keyword, onSearch }: { keyword: string; onSearch: (kw: string) => void }) {
  const { t: tr } = useLocale();
  const { data: suggestions } = useSWR(
    ["kw-suggestions", keyword],
    async () => {
      const withRank = await supabase
        .from("keyword_expansions")
        .select("expanded_keyword,rank")
        .eq("seed_keyword", keyword)
        .order("rank", { ascending: true })
        .limit(10);
      if (!withRank.error) return (withRank.data ?? []) as { expanded_keyword: string; rank: number | null }[];
      // Pre-v36 schema (no rank column): plain fetch, no rank numbers shown.
      const plain = await supabase
        .from("keyword_expansions")
        .select("expanded_keyword")
        .eq("seed_keyword", keyword)
        .order("created_at", { ascending: true })
        .limit(10);
      return ((plain.data ?? []) as { expanded_keyword: string }[]).map(r => ({ ...r, rank: null }));
    },
    { revalidateOnFocus: false },
  );
  if (!suggestions?.length) return null;   // no data → hidden, never fabricated
  return (
    <div data-testid="search-suggestions-strip" className="bg-white border border-gray-200 rounded-xl p-4 mb-5">
      <div className="flex items-center justify-between mb-2.5">
        <div>
          <p className="text-[12px] font-bold text-gray-900">{tr("trends.suggestions.title")}</p>
          <p className="text-[10px] text-gray-400">{tr("trends.suggestions.subtitle")}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map(s => (
          <button key={s.expanded_keyword} type="button" onClick={() => onSearch(s.expanded_keyword)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold bg-gray-100 text-gray-700 hover:bg-[#C026D3]/10 hover:text-[#C026D3] transition-colors capitalize">
            {s.rank != null && (
              <span className="text-[9px] font-mono font-bold text-gray-400">#{s.rank}</span>
            )}
            {s.expanded_keyword}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Popular Pins preview — real pin_samples discovered via this keyword ────────
function PopularPinsStrip({ keyword }: { keyword: string }) {
  const { t: tr } = useLocale();
  const { data: pins } = useSWR(
    ["popular-pins", keyword],
    async () => {
      const { data } = await supabase
        .from("pin_samples")
        .select("id,image_url,title,save_count,pin_id")
        .eq("seed_keyword", keyword)
        .not("image_url", "is", null)
        .order("save_count", { ascending: false })
        .limit(8);
      return data ?? [];
    },
    { revalidateOnFocus: false },
  );
  if (!pins?.length) return null;   // no fabricated placeholders — hidden when no data
  return (
    <div data-testid="popular-pins-strip" className="bg-white border border-gray-200 rounded-xl p-4 mb-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-[12px] font-bold text-gray-900">{tr("trends.popularPins.title")}</p>
          <p className="text-[10px] text-gray-400">{tr("trends.popularPins.subtitle")}</p>
        </div>
        <a href={`/app/discover?keyword=${encodeURIComponent(keyword)}`}
          className="text-[11px] font-bold no-underline" style={{ color: "#C026D3" }}>
          {tr("trends.popularPins.viewPinIdeas")}
        </a>
      </div>
      <div className="flex gap-2.5 overflow-x-auto pb-1">
        {pins.map(pin => (
          <a key={pin.id} href={`/app/discover?keyword=${encodeURIComponent(keyword)}`}
            className="relative shrink-0 rounded-lg overflow-hidden border border-gray-200 no-underline"
            style={{ width: 92, aspectRatio: "2/3" }}>
            <Image src={pin.image_url} alt={pin.title ?? ""} fill className="object-cover" sizes="92px" unoptimized />
            <div className="absolute inset-x-0 bottom-0 px-1.5 py-1"
              style={{ background: "linear-gradient(to top, rgba(0,0,0,0.72), transparent)" }}>
              <p className="text-[8px] font-bold text-white">{(pin.save_count ?? 0).toLocaleString()} {tr("trends.savesSuffix")}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ── Source-aware trend insight (no fake 12-month chart for estimated data) ─────

function TrendInsightSection({ s }: { s: KeywordSummary }) {
  const { t: tr } = useLocale();
  const display = s.trendDisplay ?? s.provenance.trendSeries;
  const mode = display?.displayMode ?? (s.provenance.isEstimated ? "estimated_signal" : "unavailable");
  const showOfficialChart = mode === "official_chart" && s.timeSeries.length >= 6;

  return (
    <div data-testid="search-trend-chart" className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
      <div className="flex flex-col lg:flex-row gap-5">

        {/* Left panel: signal summary */}
        <div className="flex-1 min-w-0">
          {showOfficialChart ? (
            <>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[13px] font-bold text-gray-900">{tr("trends.insight.searchTrend12mo")}</p>
                  <p className="text-[10px] text-gray-400" data-testid="trend-source-line">{tr("trends.insight.pinterestTrendsApi")}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">{tr("trends.badge.official")}</span>
                  <TrendChip state={s.trendState} />
                </div>
              </div>
              <TrendHistoryChart trendHistory={s.timeSeries} label="" />
              <p className="text-[9px] text-gray-400 mt-1.5">
                {tr("trends.insight.indexNormalizedNote")}
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[13px] font-bold text-gray-900">{tr("trends.insight.estimatedTrendSignal")}</p>
                  <p className="text-[10px] text-gray-400" data-testid="trend-source-line">
                    {display?.displaySourceLine ?? tr("trends.insight.estimatedDefaultSource")}
                  </p>
                </div>
                <TrendChip state={s.trendState} />
              </div>

              <div
                data-testid="estimated-trend-signal"
                className="rounded-lg border border-gray-200 bg-white p-4 space-y-3"
                style={{ borderLeft: "3px solid #F59E0B" }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <EstimatedBadge />
                  <span className="text-[11px] font-semibold text-gray-700">{tr("trends.insight.relativeInterestOnly")}</span>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{tr("trends.insight.trendState")}</p>
                    <TrendChip state={s.trendState} />
                  </div>
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{tr("trends.insight.interest")}</p>
                    <InterestBand band={s.pinterestInterestBand} />
                  </div>
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{tr("trends.insight.dataQuality")}</p>
                    <ConfidenceBadge confidence={s.provenance.confidence} />
                  </div>
                </div>

                {(s.insightBullets?.length ?? 0) > 0 && (
                  <ul className="space-y-1">
                    {s.insightBullets!.slice(0, 3).map((b, i) => (
                      <li key={i} className="text-[10px] text-gray-600 leading-relaxed flex items-start gap-1.5">
                        <span className="shrink-0 mt-0.5 text-gray-400">•</span>
                        {b}
                      </li>
                    ))}
                  </ul>
                )}

                {(s.pctGrowthYoY != null || s.pctGrowthMoM != null) && (
                  <p className="text-[10px] text-gray-500">
                    {s.pctGrowthYoY != null && <>{tr("trends.insight.yoyDirection").replace("{n}", String(Math.round(s.pctGrowthYoY)))}</>}
                    {s.pctGrowthYoY != null && s.pctGrowthMoM != null && " · "}
                    {s.pctGrowthMoM != null && <>{tr("trends.insight.momDirection").replace("{n}", String(Math.round(s.pctGrowthMoM)))}</>}
                  </p>
                )}

                <p className="text-[9px] text-gray-400 border-t border-gray-100 pt-2">
                  {tr("trends.insight.directionalOnlyNote")}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Right panel: official chart (when available) OR placeholder */}
        <div className="lg:w-[260px] shrink-0">
          {showOfficialChart ? (
            // Already shown in left panel — show evidence bullets on right
            <div className="space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{tr("trends.insight.evidenceFromCloudSignals")}</p>
              {(s.insightBullets ?? []).map((b, i) => {
                const icons = ["↑", "🏠", "⭐"];
                return (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="text-sm shrink-0 mt-0.5">{icons[i] ?? "•"}</span>
                    <p className="text-[11px] text-gray-600 leading-relaxed">{b}</p>
                  </div>
                );
              })}
              {s.provenance.lastFetchedAt && (
                <p className="text-[9px] text-gray-400 pt-2 border-t border-gray-100">
                  {tr("trends.insight.dataUpdated").replace("{date}", formatFreshnessDate(s.provenance.lastFetchedAt))}
                </p>
              )}
            </div>
          ) : (
            // No official series available
            <div className="rounded-lg border border-dashed border-gray-200 p-5 h-full flex flex-col items-center justify-center text-center gap-3">
              <div className="h-9 w-9 rounded-full bg-gray-100 flex items-center justify-center">
                <BarChart2 className="h-4.5 w-4.5 text-gray-400" />
              </div>
              <div>
                <p className="text-[12px] font-semibold text-gray-600 mb-1">{tr("trends.insight.officialUnavailableTitle")}</p>
                <p className="text-[10px] text-gray-400 leading-relaxed max-w-[200px]">
                  {tr("trends.insight.officialUnavailableBody")}
                </p>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ── Workflow actions & opportunity snapshot (keyword-to-workflow bridge) ───────

const WORKFLOW_PIN_ANGLES = [
  "trends.workflow.pinAngle.tutorial", "trends.workflow.pinAngle.productRoundup",
  "trends.workflow.pinAngle.stylingGuide", "trends.workflow.pinAngle.beforeAfter",
  "trends.workflow.pinAngle.moodBoard", "trends.workflow.pinAngle.checklist",
] as const;
const WORKFLOW_PRODUCT_IDEAS = [
  "trends.workflow.productIdea.printableWallArt", "trends.workflow.productIdea.digitalPlanner",
  "trends.workflow.productIdea.starterChecklist", "trends.workflow.productIdea.curatedBundle",
  "trends.workflow.productIdea.styleGuide", "trends.workflow.productIdea.howToEbook",
] as const;

// tr is passed in — these are plain helpers, not components, so they cannot call useLocale() themselves.
function seasonalityText(state: TrendState, tr: (key: MessageKey) => string): string {
  if (state === "Seasonal") return tr("trends.workflow.seasonalitySeasonal");
  if (state === "Rising")   return tr("trends.workflow.seasonalityRising");
  return tr("trends.workflow.seasonalityEvergreen");
}

function intentSummaryText(s: KeywordSummary, tr: (key: MessageKey) => string): string {
  const cat = s.category ? s.category.replace(/-/g, " ") : tr("trends.workflow.intentSummaryDefaultCategory");
  return tr("trends.workflow.intentSummaryText").replace("{keyword}", s.keyword).replace("{category}", cat);
}

function SnapshotField({ label, text }: { label: string; text: string }) {
  return (
    <div className="mb-3">
      <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</p>
      <p className="text-[11px] text-gray-600 leading-relaxed">{text}</p>
    </div>
  );
}

function WorkflowActionCard({ icon, title, desc, accent, onClick, primary }: {
  icon: React.ReactNode; title: string; desc: string; accent: string;
  onClick: () => void; primary?: boolean;
}) {
  return (
    <button type="button" onClick={onClick}
      className="group flex items-start gap-3 text-left rounded-xl border bg-white p-4 transition-all hover:shadow-md"
      style={{ borderColor: primary ? accent : "#E5E7EB" }}>
      <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: `${accent}14`, color: accent }}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-bold text-gray-900 mb-0.5">{title}</p>
        <p className="text-[10px] text-gray-500 leading-relaxed">{desc}</p>
      </div>
      <ArrowRight className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500 shrink-0 mt-0.5 transition-colors" />
    </button>
  );
}

function KeywordWorkflowSection({
  s, onCreatePinIdeas, onCreateProductIdeas, onUseInCreatePins,
  onAddToPlan, onSaveOpportunity, onViewRelated, planned,
}: {
  s: KeywordSummary;
  onCreatePinIdeas: () => void;
  onCreateProductIdeas: () => void;
  onUseInCreatePins: () => void;
  onAddToPlan: () => void;
  onSaveOpportunity: () => void;
  onViewRelated: () => void;
  planned: boolean;
}) {
  const { t: tr } = useLocale();
  return (
    <div className="mt-6" data-testid="keyword-workflow-section">
      <div className="mb-3">
        <p className="text-[14px] font-black text-gray-900">{tr("trends.workflow.heading")}</p>
        <p className="text-[11px] text-gray-400">{tr("trends.workflow.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,320px)_1fr] gap-4">
        {/* Left — Opportunity Snapshot */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">{tr("trends.workflow.opportunitySnapshot")}</p>

          <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{tr("trends.workflow.keyword")}</p>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <p className="text-[15px] font-black text-gray-900 capitalize">{s.keyword}</p>
            <DataSourceBadge label={s.dataSourceLabel} />
          </div>

          <SnapshotField label={tr("trends.workflow.intentSummary")} text={intentSummaryText(s, tr)} />
          <SnapshotField label={tr("trends.workflow.audienceFit")} text={tr("trends.workflow.audienceFitText")} />
          <SnapshotField label={tr("trends.workflow.seasonality")} text={seasonalityText(s.trendState, tr)} />

          <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1.5 mt-3">{tr("trends.workflow.recommendedPinAngles")}</p>
          <div className="flex flex-wrap gap-1.5">
            {WORKFLOW_PIN_ANGLES.map(a => (
              <span key={a} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{tr(a)}</span>
            ))}
          </div>
        </div>

        {/* Right — action grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 content-start">
          <WorkflowActionCard icon={<Lightbulb className="h-4 w-4" />} accent="#D946EF" primary
            title={tr("trends.workflow.action.viewPinIdeasTitle")} desc={tr("trends.workflow.action.viewPinIdeasDesc")} onClick={onCreatePinIdeas} />
          <WorkflowActionCard icon={<ShoppingBag className="h-4 w-4" />} accent="#7C3AED"
            title={tr("trends.workflow.action.viewProductOppsTitle")} desc={tr("trends.workflow.action.viewProductOppsDesc")} onClick={onCreateProductIdeas} />
          <WorkflowActionCard icon={<Sparkles className="h-4 w-4" />} accent="#FF4D8D"
            title={tr("trends.workflow.action.useInCreatePinsTitle")} desc={tr("trends.workflow.action.useInCreatePinsDesc")} onClick={onUseInCreatePins} />
          <WorkflowActionCard icon={<Calendar className="h-4 w-4" />} accent="#3B82F6"
            title={planned ? tr("trends.workflow.action.inWeeklyPlan") : tr("trends.workflow.action.addToWeeklyPlanTitle")} desc={tr("trends.workflow.action.addToWeeklyPlanDesc")} onClick={onAddToPlan} />
          <WorkflowActionCard icon={<Target className="h-4 w-4" />} accent="#10B981"
            title={tr("trends.workflow.action.saveToOpportunitiesTitle")} desc={tr("trends.workflow.action.saveToOpportunitiesDesc")} onClick={onSaveOpportunity} />
          <WorkflowActionCard icon={<Search className="h-4 w-4" />} accent="#6B7280"
            title={tr("trends.workflow.action.viewRelatedTitle")} desc={tr("trends.workflow.action.viewRelatedDesc")} onClick={onViewRelated} />
        </div>
      </div>

      {/* Suggested chips */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-[11px] font-bold text-gray-700 mb-2">{tr("trends.workflow.suggestedPinAngles")}</p>
          <div className="flex flex-wrap gap-1.5">
            {WORKFLOW_PIN_ANGLES.map(a => (
              <button key={a} type="button" onClick={onCreatePinIdeas}
                className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-[#D946EF]/10 hover:text-[#D946EF] transition-colors">{tr(a)}</button>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-[11px] font-bold text-gray-700 mb-2">{tr("trends.workflow.suggestedProductIdeas")}</p>
          <div className="flex flex-wrap gap-1.5">
            {WORKFLOW_PRODUCT_IDEAS.map(a => (
              <button key={a} type="button" onClick={onCreateProductIdeas}
                className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-[#7C3AED]/10 hover:text-[#7C3AED] transition-colors">{tr(a)}</button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[9px] text-gray-400 mt-4 text-center flex items-center justify-center gap-1.5">
        <Sparkles className="h-3 w-3" />
        {tr("trends.workflow.footerNote")}
      </p>
    </div>
  );
}

// ── Evidence drawer ───────────────────────────────────────────────────────────

function EvidenceDrawer({ row, onClose }: { row: RelatedKeywordRow; onClose: () => void }) {
  const { t: tr } = useLocale();
  const { data: pins, isLoading } = useSWR(
    ["ev-pins", row.id],
    async () => {
      const { data } = await supabase
        .from("pin_samples")
        .select("id,image_url,category,title,save_count,pin_id")
        .eq("trend_keyword_id", row.id)
        .order("save_count", { ascending: false })
        .limit(8);
      return data ?? [];
    },
    { revalidateOnFocus: false },
  );

  // Plain factual summary from the three real signals — no unified verdict.
  const whyText = tr("trends.evidence.summaryText")
    .replace("{interest}", row.pinterestInterestBand.toLowerCase())
    .replace("{saturation}", row.competitionBand.toLowerCase())
    .replace("{trend}", row.trendState.toLowerCase());

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-[420px] h-full flex flex-col shadow-xl overflow-y-auto bg-white border-l border-gray-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100 shrink-0 sticky top-0 bg-white z-10">
          <div className="min-w-0 pr-4">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{tr("trends.evidence.heading")}</p>
            <h3 className="text-[15px] font-black text-gray-900 leading-snug capitalize">{row.keyword}</h3>
          </div>
          <button type="button" onClick={onClose} aria-label={tr("trends.evidence.closeAria")}
            className="rounded-full p-2 hover:bg-gray-100 transition-colors shrink-0">
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>

        {/* Provenance strip */}
        <div className="flex items-center justify-between px-6 py-2.5 border-b border-gray-100 bg-gray-50">
          <div className="min-w-0">
            <p className="text-[9px] text-gray-500 leading-relaxed">
              {row.provenance.sources.includes("pinterest_search_sample")
                ? tr("trends.evidence.sourceSampled")
                : row.provenance.isEstimated
                ? tr("trends.evidence.sourceEstimated")
                : tr("trends.evidence.sourceDefault")}
            </p>
            {row.provenance.lastFetchedAt && (
              <p className="text-[9px] text-gray-400 mt-0.5">
                {tr("trends.insight.dataUpdated").replace("{date}", formatFreshnessDate(row.provenance.lastFetchedAt))}
              </p>
            )}
          </div>
          <ConfidenceBadge confidence={row.provenance.confidence} />
        </div>

        {/* Metrics grid */}
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: tr("trends.evidence.pinterestInterest"), node: <InterestBand band={row.pinterestInterestBand} /> },
              { label: tr("trends.evidence.contentSaturation"), node: <CompBand band={row.competitionBand} /> },
              { label: tr("trends.evidence.trendState"),        node: <TrendChip state={row.trendState} /> },
              { label: tr("trends.evidence.saveSignal"),        node: <SaveBand band={row.saveSignalBand} /> },
            ].map(({ label, node }) => (
              <div key={label}>
                <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</p>
                {node}
              </div>
            ))}
          </div>
        </div>

        {/* Signal summary — plain facts, no unified verdict */}
        <div className="px-6 py-4 border-b border-gray-100">
          <p className="text-[11px] text-gray-600 leading-relaxed">{whyText}</p>
          {row.evidenceSentence && (
            <p className="text-[10px] text-gray-400 mt-2 italic">{row.evidenceSentence}</p>
          )}
        </div>

        {/* Mini trend chart — official series only */}
        {row.trendDisplay?.displayMode === "official_chart" && row.timeSeries && row.timeSeries.length >= 6 && (
          <div className="px-6 py-4 border-b border-gray-100">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{tr("trends.insight.searchTrend12mo")}</p>
            <p className="text-[9px] text-gray-400 mb-3">{tr("trends.insight.pinterestTrendsApi")}</p>
            <TrendHistoryChart trendHistory={row.timeSeries} label={row.keyword} />
          </div>
        )}
        {row.trendDisplay?.displayMode === "estimated_signal" && (
          <div className="px-6 py-4 border-b border-gray-100 bg-white" style={{ borderLeft: "3px solid #F59E0B" }}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">{tr("trends.evidence.estimatedTrendSignal")}</p>
            <TrendChip state={row.trendState} />
            <p className="text-[9px] text-gray-400 mt-2">{tr("trends.evidence.estimatedDirectionalNote")}</p>
          </div>
        )}

        {/* Viral pins */}
        <div className="flex-1 px-5 py-5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">{tr("trends.evidence.topPins")}</p>
          {isLoading && (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-xl bg-gray-100 animate-pulse" style={{ aspectRatio: "2/3" }} />
              ))}
            </div>
          )}
          {!isLoading && (pins?.length ?? 0) > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {pins!.map(pin => (
                <div key={pin.id} className="relative rounded-xl overflow-hidden border border-gray-200">
                  <div style={{ aspectRatio: "2/3" }} className="relative">
                    <Image src={pin.image_url} alt={pin.title ?? ""} fill className="object-cover" sizes="180px" unoptimized />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                    <div className="absolute bottom-0 left-0 right-0 p-2">
                      {pin.title && <p className="text-[9px] font-semibold text-white line-clamp-2 mb-0.5">{pin.title}</p>}
                      <p className="text-[8px] text-white/80 font-bold">{(pin.save_count ?? 0).toLocaleString()} {tr("trends.savesSuffix")}</p>
                    </div>
                    {pin.pin_id && (
                      <a href={`https://www.pinterest.com/pin/${pin.pin_id}/`} target="_blank" rel="noopener noreferrer"
                        className="absolute top-2 right-2 flex items-center justify-center w-5 h-5 rounded-full opacity-0 hover:opacity-100 transition-opacity"
                        style={{ background: "rgba(230,0,35,0.9)" }}>
                        <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="white">
                          <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
                        </svg>
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!isLoading && (pins?.length ?? 0) === 0 && (
            <div className="flex flex-col items-center py-12 text-center">
              <p className="text-3xl mb-3">🔭</p>
              <p className="text-[12px] font-semibold text-gray-500">{tr("trends.evidence.noLinkedPinsTitle")}</p>
              <p className="text-[10px] text-gray-400 mt-1 max-w-[180px] leading-relaxed">
                {tr("trends.evidence.noLinkedPinsBody")}
              </p>
            </div>
          )}
        </div>

        {/* CTA */}
        <div className="px-6 py-4 border-t border-gray-100 shrink-0 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <a href={`/app/discover?keyword=${encodeURIComponent(row.keyword)}`}
              className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[11px] font-bold no-underline border border-gray-200 text-gray-700 hover:border-[#C026D3] hover:text-[#C026D3] transition-colors">
              <Lightbulb className="h-3.5 w-3.5" /> {tr("trends.evidence.viewPinIdeas")}
            </a>
            <a href={`/app/products?keyword=${encodeURIComponent(row.keyword)}`}
              className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[11px] font-bold no-underline border border-gray-200 text-gray-700 hover:border-[#7C3AED] hover:text-[#7C3AED] transition-colors">
              <ShoppingBag className="h-3.5 w-3.5" /> {tr("trends.evidence.viewProducts")}
            </a>
          </div>
          <button type="button"
            onClick={() => openCreatePins(url => { window.location.href = url; }, buildPrefillFromKeywordTrend({ keyword: row.keyword, category: row.category, trendState: row.trendState }))}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-[12px] font-bold text-white"
            style={{ background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)", border: "none", cursor: "pointer" }}>
            <Sparkles className="h-3.5 w-3.5" />
            {tr("trends.evidence.createPinsForKeyword")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Filter row ────────────────────────────────────────────────────────────────

function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string;
  options: string[]; onChange: (v: string) => void;
}) {
  const { t: tr } = useLocale();
  const active = value !== "All";
  return (
    <div className="relative">
      <select value={value} onChange={e => onChange(e.target.value)}
        className="appearance-none text-[11px] font-semibold pr-6 pl-3 py-1.5 rounded-lg border bg-white transition-colors cursor-pointer focus:outline-none"
        style={{ borderColor: active ? "#C026D3" : "#E5E7EB", color: active ? "#C026D3" : "#6B7280" }}>
        {options.map(opt => (
          <option key={opt} value={opt}>{opt === "All" ? tr("trends.filter.allSuffix").replace("{label}", label) : opt}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 pointer-events-none text-gray-400" />
    </div>
  );
}

type OpportunityFocus = "physical" | "digital" | "content" | "boards" | "seasonal";

const OPPORTUNITY_FOCUS_LABEL_KEYS: Record<OpportunityFocus, MessageKey> = {
  physical: "trends.filter.physicalProducts",
  digital:  "trends.filter.digitalProducts",
  content:  "trends.filter.blogContent",
  boards:   "trends.filter.pinterestBoards",
  seasonal: "trends.filter.seasonalCampaigns",
};

const OPPORTUNITY_FOCUS_ICONS: Record<OpportunityFocus, React.ReactNode> = {
  physical: <ShoppingBag className="h-3 w-3 shrink-0" />,
  digital:  <Package className="h-3 w-3 shrink-0" />,
  content:  <Lightbulb className="h-3 w-3 shrink-0" />,
  boards:   <Bookmark className="h-3 w-3 shrink-0" />,
  seasonal: <Sparkles className="h-3 w-3 shrink-0" />,
};

function FilterRow({
  productMode, setProductMode, demandFilter, setDemandFilter,
  trendFilter, setTrendFilter, onReset,
}: {
  productMode: OpportunityFocus; setProductMode: (m: OpportunityFocus) => void;
  demandFilter: "All" | Band; setDemandFilter: (v: "All" | Band) => void;
  trendFilter: "All" | TrendState; setTrendFilter: (v: "All" | TrendState) => void;
  onReset: () => void;
}) {
  const { t: tr } = useLocale();
  const hasFilter = demandFilter !== "All" || trendFilter !== "All";
  return (
    <div className="space-y-2.5 mb-4">
      <div>
        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 block mb-1.5">
          {tr("trends.filter.ideasFor")}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {(["physical", "digital", "content", "boards", "seasonal"] as const).map(mode => (
            <button key={mode} type="button" onClick={() => setProductMode(mode)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all whitespace-nowrap"
              style={productMode === mode
                ? { background: "#C026D3", color: "#fff", borderColor: "#C026D3" }
                : { background: "#fff", color: "#6B7280", borderColor: "#E5E7EB" }}>
              {OPPORTUNITY_FOCUS_ICONS[mode]}
              {tr(OPPORTUNITY_FOCUS_LABEL_KEYS[mode])}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect label={tr("trends.filter.demand")} value={demandFilter} options={["All", "High", "Medium", "Low"]}
          onChange={v => setDemandFilter(v as "All" | Band)} />
        <FilterSelect label={tr("trends.filter.trendState")} value={trendFilter} options={["All", "Rising", "Evergreen", "Seasonal"]}
          onChange={v => setTrendFilter(v as "All" | TrendState)} />
        {hasFilter && (
          <button type="button" onClick={onReset}
            className="text-[11px] font-semibold text-gray-400 hover:text-gray-600 transition-colors px-1">
            {tr("trends.filter.reset")}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Related keywords table ────────────────────────────────────────────────────

// Fixed column widths — total min ~900px; outer wrapper is overflow-x-auto.
// No Competition / Opportunity columns (v2.0 final: keyword page shows trend,
// interest and save signals only; saturation lives in the detail drawer).
const TABLE_COLS = "24px 1fr 90px 108px 84px 94px 72px 176px";
const TABLE_HDR_KEYS = [
  "trends.table.colKeyword", "trends.table.colCategory", "trends.table.colInterest",
  "trends.table.colSaveSignal", "trends.table.colTrendState", "trends.table.colSource",
  "trends.table.colActions",
] as const;

function RelatedKeywordsTable({
  rows, loading, onEvidence, onAddToPlan, onCreatePins,
  addedKwIds, addingId, overflowId, setOverflowId,
}: {
  rows: RelatedKeywordRow[]; loading: boolean;
  onEvidence: (r: RelatedKeywordRow) => void;
  onAddToPlan: (r: RelatedKeywordRow) => void;
  onCreatePins: (r: RelatedKeywordRow) => void;
  addedKwIds: Set<string>; addingId: string | null;
  overflowId: string | null; setOverflowId: (id: string | null) => void;
}) {
  const { t: tr } = useLocale();
  return (
    <div data-testid="related-keywords-table"
      className="rounded-xl border border-gray-200 shadow-sm bg-white overflow-hidden">
      {/* scroll wrapper so columns never collapse below their min width */}
      <div className="overflow-x-auto">
        <div style={{ minWidth: 900 }}>

          {/* Header */}
          <div className="grid items-center px-4 py-3 border-b border-gray-100 bg-gray-50"
            style={{ gridTemplateColumns: TABLE_COLS }}>
            <span />
            {TABLE_HDR_KEYS.map(h => (
              <span key={h} className="text-[10px] font-bold uppercase tracking-wide text-gray-500 last:text-right whitespace-nowrap">{tr(h)}</span>
            ))}
          </div>

          {/* Skeleton */}
          {loading && (
            <div className="divide-y divide-gray-100">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="grid items-center px-4 py-3.5" style={{ gridTemplateColumns: TABLE_COLS }}>
                  {[8, 160, 70, 90, 64, 80, 56, 140].map((w, j) => (
                    <div key={j} className="h-3 rounded bg-gray-100 animate-pulse mr-3" style={{ maxWidth: w }} />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Rows */}
          {!loading && rows.length > 0 && (
            <div className="divide-y divide-gray-100">
              {rows.map((row, idx) => {
                const catDef  = CATEGORIES.find(c => c.id === row.category);
                const emoji   = row.category ? catEmoji(row.category) : "📌";
                const isAdded  = addedKwIds.has(row.id);
                const isAdding = addingId === row.id;
                const menuOpen = overflowId === row.id;
                return (
                  <div key={row.id}
                    data-testid="related-keyword-row"
                    className="group grid items-center px-4 py-3 hover:bg-gray-50/60 transition-colors"
                    style={{ gridTemplateColumns: TABLE_COLS }}>

                    {/* # */}
                    <span className="text-[9px] font-mono text-gray-400 tabular-nums select-none">{idx + 1}</span>

                    {/* Keyword */}
                    <div className="min-w-0 pr-3">
                      <p className="text-[12px] font-semibold text-gray-900 truncate capitalize leading-snug">{row.keyword}</p>
                    </div>

                    {/* Category */}
                    <div>
                      <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize whitespace-nowrap">
                        {emoji} {catDef?.label ?? row.category ?? "—"}
                      </span>
                    </div>

                    {/* Interest */}
                    <div className="flex items-center gap-1">
                      {row.interestRelativeIndex != null && (
                        <span className="text-[10px] font-mono text-gray-400 tabular-nums w-[22px] text-right shrink-0">{row.interestRelativeIndex}</span>
                      )}
                      <InterestBand band={row.pinterestInterestBand} />
                    </div>

                    {/* Save Signal */}
                    <SaveBand band={row.saveSignalBand} />

                    {/* Trend State */}
                    <TrendChip state={row.trendState} />

                    {/* Source */}
                    <DataSourceBadge label={row.dataSourceLabel} />

                    {/* Actions — Analyze always visible; Create dropdown */}
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" data-testid="view-evidence-button"
                        onClick={() => onEvidence(row)}
                        className="rounded px-2.5 py-1.5 text-[10px] font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors whitespace-nowrap">
                        {tr("trends.table.analyze")}
                      </button>

                      {/* Create dropdown */}
                      <div className="relative">
                        <button type="button"
                          onClick={e => { e.stopPropagation(); setOverflowId(menuOpen ? null : row.id); }}
                          className="flex items-center gap-1 rounded px-2.5 py-1.5 text-[10px] font-bold text-white transition-colors whitespace-nowrap"
                          style={{ background: "linear-gradient(135deg,#D946EF 0%,#7C3AED 100%)" }}>
                          {tr("trends.table.create")}
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        </button>

                        {menuOpen && (
                          <div className="absolute right-0 top-full mt-1 z-30 bg-white rounded-xl border border-gray-200 shadow-xl py-1.5 min-w-[195px]"
                            onClick={e => e.stopPropagation()}>
                            <a data-testid="keyword-view-pin-ideas-link"
                              href={`/app/discover?keyword=${encodeURIComponent(row.keyword)}`}
                              className="w-full flex items-center gap-2.5 text-left px-3.5 py-2.5 text-[11px] text-gray-700 hover:bg-gray-50 no-underline">
                              <Lightbulb className="h-3.5 w-3.5 text-[#D946EF] shrink-0" /> {tr("trends.table.viewPinIdeas")}
                            </a>
                            <a data-testid="keyword-view-products-link"
                              href={`/app/products?keyword=${encodeURIComponent(row.keyword)}`}
                              className="w-full flex items-center gap-2.5 text-left px-3.5 py-2.5 text-[11px] text-gray-700 hover:bg-gray-50 no-underline">
                              <ShoppingBag className="h-3.5 w-3.5 text-[#7C3AED] shrink-0" /> {tr("trends.table.viewProductOpportunities")}
                            </a>
                            <button type="button" data-testid="keyword-create-pins-button"
                              onClick={() => { onCreatePins(row); setOverflowId(null); }}
                              className="w-full flex items-center gap-2.5 text-left px-3.5 py-2.5 text-[11px] font-semibold text-[#7C3AED] hover:bg-purple-50">
                              <Sparkles className="h-3.5 w-3.5 shrink-0" /> {tr("trends.table.useInCreatePins")}
                            </button>
                            <div className="border-t border-gray-100 mt-1 pt-1">
                              <button type="button" data-testid="keyword-add-to-plan-button"
                                disabled={isAdded || isAdding}
                                onClick={() => { onAddToPlan(row); setOverflowId(null); }}
                                className="w-full flex items-center gap-2.5 text-left px-3.5 py-2 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                                <Plus className="h-3.5 w-3.5 shrink-0" />
                                {isAdded ? tr("trends.table.inWeeklyPlan") : isAdding ? tr("trends.table.adding") : tr("trends.table.addToWeeklyPlan")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div className="flex flex-col items-center py-14 text-center gap-2">
              <p className="text-[13px] font-semibold text-gray-500">{tr("trends.table.emptyTitle")}</p>
              <p className="text-[11px] text-gray-400">{tr("trends.table.emptySub")}</p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ── State A: default view ─────────────────────────────────────────────────────

// Trending table grid: Keyword | Category | Trend | Interest | Save | Source | Updated | Actions
// No Competition / Opportunity columns (v2.0 final).
const TRENDING_COLS = "minmax(180px,1.4fr) 118px 98px 84px 84px 86px 78px 150px";
const TRENDING_HDR_KEYS = [
  "trends.trending.colKeyword", "trends.trending.colCategory", "trends.trending.colTrend",
  "trends.trending.colInterest", "trends.trending.colSaveSignal", "trends.trending.colSource",
  "trends.trending.colUpdated", "trends.trending.colActions",
] as const;
// Honest full names surfaced as header tooltips.
const TRENDING_HDR_TITLE_KEYS: Record<string, MessageKey> = {
  "trends.trending.colInterest":   "trends.trending.colInterestTitle",
  "trends.trending.colSaveSignal": "trends.trending.colSaveSignalTitle",
  "trends.trending.colSource":     "trends.trending.colSourceTitle",
};

function DefaultView({
  trendingRows, onSearch, onSave, savedIds, loading, error, meta,
  onLoadMore, loadingMore, hasMore,
}: {
  trendingRows: RelatedKeywordRow[];
  onSearch: (kw: string) => void;
  onSave: (row: RelatedKeywordRow) => void;
  savedIds: Set<string>;
  loading: boolean;
  error?: string | null;
  meta?: KeywordTrendsMeta | null;
  onLoadMore: () => void;
  loadingMore: boolean;
  hasMore: boolean;
}) {
  const { t: tr } = useLocale();
  const [openCreate, setOpenCreate] = useState<string | null>(null);

  function fireCreate(row: RelatedKeywordRow) {
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromKeywordTrend({
      keyword: row.keyword, category: row.category, trendState: row.trendState,
    }));
  }

  return (
    <div className="mt-8">
      <div>
        <div className="flex items-end justify-between mb-3">
          <div>
            <p className="text-[14px] font-black text-gray-900">{tr("trends.trending.title")}</p>
            <p className="text-[11px] text-gray-400">{tr("trends.trending.subtitle")}</p>
          </div>
          {meta?.total != null && (
            <p className="text-[11px] text-gray-400 shrink-0">
              <span className="font-semibold text-gray-400">{meta.total.toLocaleString()}</span> {tr("trends.trending.countSuffix")}
            </p>
          )}
        </div>

        {loading && (
          <div className="rounded-xl bg-white border border-gray-200 p-8 flex flex-col items-center gap-3">
            <div className="h-7 w-7 rounded-full border-2 border-[#C026D3] border-t-transparent animate-spin" />
            <p className="text-[12px] text-gray-400">{tr("trends.trending.loading")}</p>
          </div>
        )}

        {!loading && error && (
          <div data-testid="keyword-trending-error" className="rounded-xl bg-white border border-red-200 p-8 text-center">
            <p className="text-[13px] font-semibold text-red-600">{tr("trends.trending.loadErrorTitle")}</p>
            <p className="text-[11px] text-gray-400 mt-1">{error}</p>
          </div>
        )}

        {!loading && !error && trendingRows.length === 0 && (
          <div className="rounded-xl bg-white border border-gray-200 p-8 text-center">
            <p className="text-[13px] font-semibold text-gray-500">{tr("trends.trending.emptyTitle")}</p>
            <p className="text-[11px] text-gray-400 mt-1">{tr("trends.trending.emptySub")}</p>
          </div>
        )}

        {!loading && !error && trendingRows.length > 0 && (
          <div className="rounded-xl overflow-hidden bg-white border border-gray-200 shadow-sm">
            <div className="overflow-x-auto">
              <div style={{ minWidth: 950 }}>
                {/* Header */}
                <div className="grid items-center px-4 py-2.5 border-b border-gray-100 bg-gray-50"
                  style={{ gridTemplateColumns: TRENDING_COLS }}>
                  {TRENDING_HDR_KEYS.map(h => (
                    <span key={h} title={TRENDING_HDR_TITLE_KEYS[h] ? tr(TRENDING_HDR_TITLE_KEYS[h]) : undefined}
                      className="text-[10px] font-bold uppercase tracking-wide whitespace-nowrap last:text-right text-gray-500">
                      {tr(h)}
                    </span>
                  ))}
                </div>

                {/* Rows */}
                <div className="divide-y divide-gray-100">
                  {trendingRows.map(row => {
                    const catDef  = CATEGORIES.find(c => c.id === row.category);
                    const emoji   = row.category ? catEmoji(row.category) : "📌";
                    const saved   = savedIds.has(row.id);
                    const menuOpen = openCreate === row.id;
                    return (
                      <div key={row.id}
                        className="group grid items-center px-4 py-3 hover:bg-gray-50/60 transition-colors"
                        style={{ gridTemplateColumns: TRENDING_COLS }}>

                        {/* Keyword + bookmark */}
                        <div className="min-w-0 flex items-center gap-2 pr-3">
                          <button type="button" onClick={() => onSave(row)}
                            title={saved ? tr("trends.trending.saved") : tr("trends.trending.saveKeyword")}
                            className="shrink-0 transition-colors"
                            style={{ color: saved ? "#C026D3" : "var(--app-text-muted)" }}>
                            <Bookmark className="h-3.5 w-3.5" fill={saved ? "currentColor" : "none"} />
                          </button>
                          <button type="button" onClick={() => onSearch(row.keyword)}
                            className="min-w-0 text-left">
                            <span className="text-[12px] font-semibold text-gray-900 capitalize truncate block group-hover:text-[#C026D3] transition-colors">
                              {row.keyword}
                            </span>
                          </button>
                        </div>

                        {/* Category */}
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize whitespace-nowrap w-fit">
                          {emoji} {catDef?.label ?? row.category ?? "—"}
                        </span>

                        {/* Trend */}
                        <TrendCell state={row.trendState} />

                        {/* Interest */}
                        <MetricBar value={row.interestRelativeIndex} color={METRIC_INTEREST} />

                        {/* Save Signal */}
                        <MetricBar value={row.saveRelativeIndex} color={METRIC_SAVE} />

                        {/* Source */}
                        <SourcePill label={row.dataSourceLabel} />

                        {/* Updated */}
                        <span className="text-[10px] text-gray-400 tabular-nums whitespace-nowrap">
                          {relativeTime(row.provenance.lastFetchedAt)}
                        </span>

                        {/* Actions: Analyze + Create dropdown */}
                        <div className="flex items-center justify-end gap-1.5">
                          <button type="button" onClick={() => onSearch(row.keyword)}
                            className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[10px] font-bold text-gray-600 border border-gray-200 hover:border-[#C026D3] hover:text-[#C026D3] transition-colors whitespace-nowrap">
                            <BarChart2 className="h-3 w-3" /> {tr("trends.trending.analyze")}
                          </button>
                          <div className="relative">
                            <button type="button"
                              onClick={e => { e.stopPropagation(); setOpenCreate(menuOpen ? null : row.id); }}
                              className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[10px] font-bold text-white transition-colors whitespace-nowrap"
                              style={{ background: "linear-gradient(135deg,#D946EF 0%,#7C3AED 100%)" }}>
                              {tr("trends.trending.create")} <ChevronDown className="h-3 w-3 shrink-0" />
                            </button>
                            {menuOpen && (
                              <>
                                <div className="fixed inset-0 z-20" onClick={() => setOpenCreate(null)} />
                                <div className="absolute right-0 top-full mt-1 z-30 rounded-xl border border-gray-200 bg-white shadow-xl py-1.5 min-w-[185px]"
                                  onClick={e => e.stopPropagation()}>
                                  <a href={`/app/discover?keyword=${encodeURIComponent(row.keyword)}`}
                                    className="w-full flex items-center gap-2.5 text-left px-3.5 py-2 text-[11px] text-gray-700 hover:bg-gray-50 no-underline">
                                    <Lightbulb className="h-3.5 w-3.5 text-[#D946EF] shrink-0" /> {tr("trends.trending.viewPinIdeas")}
                                  </a>
                                  <a href={`/app/products?keyword=${encodeURIComponent(row.keyword)}`}
                                    className="w-full flex items-center gap-2.5 text-left px-3.5 py-2 text-[11px] text-gray-700 hover:bg-gray-50 no-underline">
                                    <ShoppingBag className="h-3.5 w-3.5 text-[#7C3AED] shrink-0" /> {tr("trends.trending.viewProductOpportunities")}
                                  </a>
                                  <button type="button" onClick={() => { fireCreate(row); setOpenCreate(null); }}
                                    className="w-full flex items-center gap-2.5 text-left px-3.5 py-2 text-[11px] font-semibold text-[#7C3AED] hover:bg-purple-50">
                                    <Sparkles className="h-3.5 w-3.5 shrink-0" /> {tr("trends.trending.useInCreatePins")}
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        </div>

                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {hasMore && (
              <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 text-center">
                <button type="button" data-testid="keyword-load-more" onClick={onLoadMore} disabled={loadingMore}
                  className="text-[11px] font-bold text-[#C026D3] hover:underline disabled:opacity-50">
                  {loadingMore ? tr("trends.trending.loading2") : tr("trends.trending.loadMore").replace("{n}", String(trendingRows.length)).replace("{total}", String(meta?.total ?? "?"))}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Data-honesty disclaimer */}
        {!loading && !error && trendingRows.length > 0 && (
          <p data-testid="keyword-estimated-disclaimer" className="text-[10px] text-gray-400 mt-3 flex items-start gap-1.5 leading-relaxed">
            <span className="shrink-0 mt-px">ⓘ</span>
            {tr("trends.trending.disclaimer")}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Add to weekly plan ─────────────────────────────────────────────────────────

const planClient = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// Internal weekly-plan tier from the REAL content-saturation band (never shown
// as an opportunity label in the UI).
function saturationToTier(band: CompetitionBand): WorkspaceTier {
  if (band === "Low")  return "blue_ocean";
  if (band === "High") return "hot_red_sea";
  return "early_trend";
}

async function addRowToWeeklyPlan(row: RelatedKeywordRow): Promise<string | null> {
  const { data: { user } } = await planClient.auth.getUser();
  if (!user) return "Sign in to add to plan";

  const weekStart = getWeekStart();
  const { data: existing } = await planClient
    .from("weekly_plan_items").select("id")
    .eq("user_id", user.id).eq("week_start", weekStart).eq("keyword_id", row.id)
    .maybeSingle();
  if (existing) return "Already in your plan";

  const { count: slotCount } = await planClient
    .from("weekly_plan_items").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).eq("week_start", weekStart);

  const { error } = await planClient.from("weekly_plan_items").insert({
    user_id:    user.id,
    week_start: weekStart,
    keyword_id: row.id,
    keyword:    row.keyword,
    category:   row.category ?? "",
    tier:       saturationToTier(row.competitionBand),
    score:      0,
    sort_order: slotCount ?? 0,
  });
  return error ? error.message : null;
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function TrendsPage() {
  const pinterestRegion = usePinterestRegion();
  const { t: tr } = useLocale();
  const [searchInput,     setSearchInput]     = useState("");
  const [searchedKeyword, setSearchedKeyword] = useState("");
  const [recentSearches,  setRecentSearches]  = useState<string[]>([]);
  const [productMode,     setProductMode]     = useState<OpportunityFocus>("physical");
  const [demandFilter,    setDemandFilter]    = useState<"All" | Band>("All");
  const [trendFilter,     setTrendFilter]     = useState<"All" | TrendState>("All");
  const [evidenceRow,     setEvidenceRow]     = useState<RelatedKeywordRow | null>(null);
  const [overflowId,      setOverflowId]      = useState<string | null>(null);
  const [addedKwIds,      setAddedKwIds]      = useState<Set<string>>(new Set());
  const [addingId,        setAddingId]        = useState<string | null>(null);
  const [trendingOffset,  setTrendingOffset]  = useState(0);
  const [relatedOffset,   setRelatedOffset]   = useState(0);
  const [trendingRows,    setTrendingRows]    = useState<RelatedKeywordRow[]>([]);
  const [relatedRows,     setRelatedRows]     = useState<RelatedKeywordRow[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("vibepin_recent_kw_searches");
      if (stored) setRecentSearches(JSON.parse(stored));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!overflowId) return;
    const close = () => setOverflowId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [overflowId]);

  function handleSearch(kw?: string) {
    const term = (kw ?? searchInput).trim();
    if (!term) return;
    setSearchedKeyword(term);
    setSearchInput(term);
    setRelatedOffset(0);
    setRelatedRows([]);
    setDemandFilter("All");
    setTrendFilter("All");
    try {
      const next = [term, ...recentSearches.filter(r => r !== term)].slice(0, 5);
      setRecentSearches(next);
      localStorage.setItem("vibepin_recent_kw_searches", JSON.stringify(next));
    } catch { /* ignore */ }
  }

  function handleClear() {
    setSearchInput("");
    setSearchedKeyword("");
    setTrendingOffset(0);
    setTrendingRows([]);
    setRelatedOffset(0);
    setRelatedRows([]);
  }

  useEffect(() => {
    setTrendingOffset(0);
    setTrendingRows([]);
    setRelatedOffset(0);
    setRelatedRows([]);
  }, [productMode]);

  function opportunityFocusParam(mode: string): string {
    if (mode === "digital") return "digital";
    if (mode === "content") return "content";
    if (mode === "physical") return "physical";
    return "physical"; // boards/seasonal → default to physical on server, client filters below
  }

  function applyIdeasFilter(rows: RelatedKeywordRow[]): RelatedKeywordRow[] {
    if (productMode === "seasonal") return rows.filter(r => r.trendState === "Seasonal");
    return rows; // physical/digital/content/boards already filtered server-side or no filter
  }

  async function handleAddToPlan(row: RelatedKeywordRow) {
    if (addedKwIds.has(row.id) || addingId === row.id) return;
    setAddingId(row.id);
    const err = await addRowToWeeklyPlan(row);
    setAddingId(null);
    if (err === "Already in your plan") {
      setAddedKwIds(prev => new Set([...prev, row.id]));
      toast.info(tr("trends.toast.alreadyInPlan"));
    } else if (err) {
      toast.error(err);
    } else {
      setAddedKwIds(prev => new Set([...prev, row.id]));
      toast.success(tr("trends.toast.addedToPlan").replace("{keyword}", row.keyword), {
        action: {
          label: tr("trends.toast.viewPlan"),
          onClick: () => { window.location.href = `/app/plan?category=${row.category ?? ""}`; },
        },
      });
    }
  }

  function handleCreatePins(row: RelatedKeywordRow) {
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromKeywordTrend({
      keyword: row.keyword,
      category: row.category,
      trendState: row.trendState,
    }));
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  const RELATED_PAGE_SIZE = 25;

  const { data: searchData, isLoading: searchLoading, error: searchError } = useSWR(
    searchedKeyword ? ["kwt-search", searchedKeyword, productMode, pinterestRegion, relatedOffset] : null,
    async ([, kw, mode, region, relOffset]) => {
      const p = new URLSearchParams({
        q: kw as string,
        region: region as string,
        limit: String(RELATED_PAGE_SIZE),
        offset: String(relOffset as number),
        opportunity_focus: opportunityFocusParam(mode as string),
      });
      return fetchKeywordTrends(p);
    },
    { revalidateOnFocus: false },
  );

  const { data: trendingData, isLoading: trendingLoading, error: trendingError } = useSWR(
    !searchedKeyword ? ["kwt-trending", productMode, trendingOffset, pinterestRegion] : null,
    async ([, mode, offset, region]) => {
      const p = new URLSearchParams({
        region: region as string,
        limit: String(TRENDING_PAGE_SIZE),
        offset: String(offset as number),
        opportunity_focus: opportunityFocusParam(mode as string),
      });
      return fetchKeywordTrends(p);
    },
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    if (!searchedKeyword && !trendingLoading) markDataReady("/app/trends");
  }, [searchedKeyword, trendingLoading]);

  useEffect(() => {
    if (!searchData?.rows) return;
    if (relatedOffset === 0) {
      setRelatedRows(searchData.rows);
    } else {
      setRelatedRows(prev => {
        const ids = new Set(prev.map(r => r.id));
        const next = searchData.rows.filter(r => !ids.has(r.id));
        return [...prev, ...next];
      });
    }
  }, [searchData, relatedOffset]);

  useEffect(() => {
    if (!trendingData?.rows) return;
    if (trendingOffset === 0) {
      setTrendingRows(trendingData.rows);
    } else {
      setTrendingRows(prev => {
        const ids = new Set(prev.map(r => r.id));
        const next = trendingData.rows.filter(r => !ids.has(r.id));
        return [...prev, ...next];
      });
    }
  }, [trendingData, trendingOffset]);

  function handleLoadMoreTrending() {
    if (trendingLoading) return;
    setTrendingOffset(prev => prev + TRENDING_PAGE_SIZE);
  }

  function handleLoadMoreRelated() {
    if (searchLoading) return;
    setRelatedOffset(prev => prev + RELATED_PAGE_SIZE);
  }

  const summary = searchData?.summary ?? null;
  const relatedLoading = searchLoading;

  const relatedSectionRef = useRef<HTMLDivElement | null>(null);

  // The detail page's seed keyword as a row, for plan/save actions.
  const seedRow: RelatedKeywordRow | null = useMemo(() => {
    if (!summary?.keywordId) return null;
    return {
      id:                    summary.keywordId,
      keyword:               summary.keyword,
      category:              summary.category,
      pinterestInterestBand: summary.pinterestInterestBand,
      saveSignalBand:        summary.saveSignalBand,
      competitionBand:       summary.competitionBand,
      trendState:            summary.trendState,
      provenance:            summary.provenance,
      dataSourceLabel:       summary.dataSourceLabel,
      interestRelativeIndex: summary.interestMetric?.relativeIndex,
    };
  }, [summary]);

  const seedPlanned = !!(seedRow && addedKwIds.has(seedRow.id));

  function handleCreatePinsFromSummary() {
    if (!summary) return;
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromKeywordTrend({
      keyword: summary.keyword, category: summary.category, trendState: summary.trendState,
    }));
  }

  // Cross-page browse jumps (K1): land on the downstream pages pre-filtered.
  function gotoPinIdeas(keyword: string) {
    window.location.href = `/app/discover?keyword=${encodeURIComponent(keyword)}`;
  }
  function gotoProducts(keyword: string) {
    window.location.href = `/app/products?keyword=${encodeURIComponent(keyword)}`;
  }

  function handleSaveSeed() {
    if (!seedRow) { toast.error(tr("trends.toast.signInToSave")); return; }
    void handleAddToPlan(seedRow);
  }

  function handleViewRelated() {
    relatedSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const trendingMeta = trendingData?.meta ?? searchData?.meta ?? null;
  const hasMoreTrending =
    (trendingData?.meta?.total ?? 0) > trendingRows.length;
  const hasMoreRelated =
    (searchData?.meta?.total ?? 0) > relatedRows.length;

  const filteredRelated = useMemo(() => {
    return dedupeByKeyword(applyIdeasFilter(relatedRows)).filter(r => {
      if (demandFilter !== "All" && r.pinterestInterestBand !== demandFilter) return false;
      if (trendFilter  !== "All" && r.trendState             !== trendFilter) return false;
      return true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedRows, demandFilter, trendFilter, productMode]);

  const dedupedTrending = useMemo(() => dedupeByKeyword(trendingRows), [trendingRows]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app-page h-full overflow-y-auto">
      <main className="max-w-[1320px] mx-auto px-6 py-8">

        {/* Page header */}
        <div className="mb-6">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">{tr("page.trends.title")}</p>
          <h1 className="text-[22px] font-black text-gray-900 tracking-tight">{tr("page.trends.heading")}</h1>
          <p className="text-[13px] text-gray-500 mt-1">{tr("page.trends.subtitle")}</p>
        </div>

        {/* Search bar */}
        <div className="bg-white border border-gray-200 rounded-xl p-3 shadow-sm mb-4">
          <div className="flex gap-2 items-center">
            {/* Platform pill */}
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 shrink-0">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="#E60023">
                <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
              </svg>
              <span className="text-[11px] font-semibold text-gray-700">{tr("trends.search.pinterest")}</span>
            </div>

            {/* Input */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
              <input
                data-testid="keyword-search-input"
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleSearch(); }}
                placeholder={tr("trends.search.placeholder")}
                className="w-full rounded-lg border border-gray-200 bg-white pl-9 pr-9 py-2 text-[13px] text-gray-900 focus:border-[#C026D3] focus:outline-none placeholder:text-gray-400"
              />
              {searchInput && (
                <button type="button" onClick={handleClear} aria-label={tr("trends.search.clearAria")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-500 transition-colors">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Region */}
            <div className="flex items-center gap-1 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 shrink-0">
              <span className="text-[11px]">🇺🇸</span>
              <span className="text-[11px] font-semibold text-gray-700">{tr("trends.search.usa")}</span>
            </div>

            {/* Search button */}
            <button type="button" data-testid="keyword-search-button" onClick={() => handleSearch()}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-[12px] font-bold text-white whitespace-nowrap shrink-0 hover:brightness-105 transition-all"
              style={{ background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)" }}>
              <Search className="h-3.5 w-3.5" />
              {tr("trends.search.button")}
            </button>
          </div>

          {/* Recent searches (inline below bar, only if State A or just after typing) */}
          {!searchedKeyword && recentSearches.length > 0 && (
            <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-gray-100">
              <span className="text-[10px] text-gray-400 font-medium shrink-0">{tr("trends.search.recent")}</span>
              <div className="flex flex-wrap gap-1.5">
                {recentSearches.map(kw => (
                  <button key={kw} type="button" onClick={() => handleSearch(kw)}
                    className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600 hover:bg-[#C026D3]/10 hover:text-[#C026D3] transition-colors capitalize">
                    {kw}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── State A: no search ─────────────────────────────────────────────── */}
        {!searchedKeyword && (
          <DefaultView
            trendingRows={dedupedTrending}
            onSearch={handleSearch}
            onSave={handleAddToPlan}
            savedIds={addedKwIds}
            loading={trendingLoading && trendingOffset === 0}
            error={trendingError ? (trendingError as Error).message : null}
            meta={trendingMeta}
            onLoadMore={handleLoadMoreTrending}
            loadingMore={trendingLoading && trendingOffset > 0}
            hasMore={hasMoreTrending}
          />
        )}

        {/* ── State B: search result ─────────────────────────────────────────── */}
        {searchedKeyword && (
          <>
            {searchLoading && (
              <div className="flex flex-col items-center py-16 text-center gap-3">
                <div className="h-8 w-8 rounded-full border-2 border-[#C026D3] border-t-transparent animate-spin" />
                <p className="text-[13px] text-gray-400">{tr("trends.result.lookingUp").replace("{keyword}", searchedKeyword)}</p>
              </div>
            )}

            {!searchLoading && searchError && (
              <div data-testid="keyword-search-error" className="flex flex-col items-center py-16 text-center gap-3 bg-white border border-red-200 rounded-xl">
                <p className="text-[14px] font-semibold text-red-600">{tr("trends.result.loadErrorTitle")}</p>
                <p className="text-[11px] text-gray-400">{(searchError as Error).message}</p>
              </div>
            )}

            {!searchLoading && !searchError && searchData && !summary && (
              <div className="flex flex-col items-center py-16 text-center gap-3 bg-white border border-gray-200 rounded-xl">
                <p className="text-4xl">🔍</p>
                <p className="text-[14px] font-semibold text-gray-700">{tr("trends.result.notFoundTitle")}</p>
                <p className="text-[11px] text-gray-400 max-w-[300px] leading-relaxed">
                  {searchData.message ?? tr("trends.result.notFoundDefaultMsg")}
                </p>
                <div className="flex items-center gap-2 mt-1 flex-wrap justify-center">
                  <button type="button" onClick={handleClear}
                    className="px-4 py-2 rounded-xl text-[11px] font-bold"
                    style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3" }}>
                    {tr("trends.result.browseTrending")}
                  </button>
                  <a
                    data-testid="keyword-create-anyway-button"
                    href={`/app/studio?keyword=${encodeURIComponent(searchedKeyword)}&from=keyword_trends&unvalidated=true`}
                    className="px-4 py-2 rounded-xl text-[11px] font-bold border border-gray-200 text-gray-600 hover:bg-gray-50 no-underline">
                    {tr("trends.result.createAnyway")}
                  </a>
                </div>
                <p className="text-[9px] text-gray-400 max-w-[260px]">
                  {tr("trends.result.createAnywayNote")}
                </p>
              </div>
            )}

            {!searchLoading && !searchError && summary && (
              <>
                {/* Keyword Detail Header — eRank-style */}
                <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 mb-5 shadow-sm">
                  {/* Breadcrumb */}
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-400 mb-3">
                    <button type="button" onClick={handleClear}
                      className="hover:text-[#C026D3] transition-colors">{tr("trends.result.breadcrumbKeywordTrends")}</button>
                    <ChevronRight className="h-3 w-3" />
                    <span className="text-gray-600 capitalize">{summary.keyword}</span>
                  </div>

                  {/* Title + actions */}
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div className="min-w-0">
                      {!summary.isExactMatch && summary.matchedKeyword && (
                        <p className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2 inline-flex items-center gap-1.5">
                          <span>⚠</span>
                          {tr("trends.result.closestMatch").replace("{keyword}", searchedKeyword)}
                        </p>
                      )}
                      <h2 className="text-[20px] font-black text-gray-900 capitalize leading-tight mb-1">{summary.keyword}</h2>

                      {/* Metadata row */}
                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
                        {summary.category && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize">
                            {catEmoji(summary.category)} {summary.category.replace(/-/g, " ")}
                          </span>
                        )}
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          🇺🇸 {tr("trends.result.usRegion")}
                        </span>
                        {summary.updatedAt ? (
                          <span className="text-gray-400">
                            {tr("trends.result.dataUpdated").replace("{date}", formatFreshnessDate(summary.updatedAt))}
                          </span>
                        ) : summary.firstSeenAt ? (
                          <span className="text-gray-400">
                            {tr("trends.result.firstSeen").replace("{date}", formatFreshnessDate(summary.firstSeenAt))}
                          </span>
                        ) : null}
                        <DataSourceBadge label={summary.dataSourceLabel} />
                        <ConfidenceBadge confidence={summary.provenance.confidence} />
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button type="button" data-testid="keyword-save-button" onClick={handleSaveSeed}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-colors bg-white whitespace-nowrap"
                        style={seedPlanned
                          ? { borderColor: "#C026D3", color: "#C026D3" }
                          : { borderColor: "#E5E7EB", color: "#4B5563" }}>
                        <Bookmark className="h-3 w-3" fill={seedPlanned ? "currentColor" : "none"} />
                        {seedPlanned ? tr("trends.result.savedButton") : tr("trends.result.saveKeywordButton")}
                      </button>
                      <a data-testid="summary-view-pin-ideas" href={`/app/discover?keyword=${encodeURIComponent(summary.keyword)}`}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-[11px] font-semibold text-gray-600 hover:border-[#C026D3] hover:text-[#C026D3] transition-colors bg-white whitespace-nowrap no-underline">
                        <Lightbulb className="h-3 w-3" /> {tr("trends.result.viewPinIdeas")}
                      </a>
                      <a data-testid="summary-view-products" href={`/app/products?keyword=${encodeURIComponent(summary.keyword)}`}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-[11px] font-semibold text-gray-600 hover:border-[#C026D3] hover:text-[#C026D3] transition-colors bg-white whitespace-nowrap no-underline">
                        <ShoppingBag className="h-3 w-3" /> {tr("trends.result.viewProductOpportunities")}
                      </a>
                      <button type="button" onClick={handleCreatePinsFromSummary}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-white whitespace-nowrap"
                        style={{ background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)" }}>
                        <Sparkles className="h-3 w-3" /> {tr("trends.result.useInCreatePins")}
                      </button>
                    </div>
                  </div>
                </div>

                <KeywordSummaryCards s={summary} />
                <SearchSuggestionsStrip keyword={summary.keyword} onSearch={handleSearch} />
                <PopularPinsStrip keyword={summary.keyword} />
                <TrendInsightSection s={summary} />

                {/* Related keywords */}
                <div className="mb-2" ref={relatedSectionRef}>
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-[14px] font-black text-gray-900">{tr("trends.related.heading")}</p>
                      <p className="text-[11px] text-gray-400">
                        {summary.category
                          ? `${summary.category.replace(/-/g, " ")} ${tr("trends.related.categoryKeywordsSuffix")}`
                          : tr("trends.related.sameCategory")}
                        {searchData?.meta
                          ? ` · ${tr("trends.related.showingCount").replace("{shown}", String(filteredRelated.length)).replace("{total}", String(searchData.meta.total))}`
                          : ""}
                        {searchData?.meta?.lastUpdated
                          ? ` · ${tr("trends.related.updatedSuffix").replace("{date}", formatFreshnessDate(searchData.meta.lastUpdated))}`
                          : ""}
                      </p>
                    </div>
                  </div>

                  <FilterRow
                    productMode={productMode}     setProductMode={setProductMode}
                    demandFilter={demandFilter}   setDemandFilter={setDemandFilter}
                    trendFilter={trendFilter}     setTrendFilter={setTrendFilter}
                    onReset={() => { setDemandFilter("All"); setTrendFilter("All"); }}
                  />

                  <RelatedKeywordsTable
                    rows={filteredRelated}
                    loading={relatedLoading && relatedOffset === 0}
                    onEvidence={setEvidenceRow}
                    onAddToPlan={handleAddToPlan}
                    onCreatePins={handleCreatePins}
                    addedKwIds={addedKwIds}
                    addingId={addingId}
                    overflowId={overflowId}
                    setOverflowId={setOverflowId}
                  />

                  {hasMoreRelated && (
                    <div className="mt-3 text-center">
                      <button type="button" data-testid="related-load-more" onClick={handleLoadMoreRelated}
                        disabled={searchLoading && relatedOffset > 0}
                        className="text-[11px] font-bold text-[#C026D3] hover:underline disabled:opacity-50">
                        {searchLoading && relatedOffset > 0
                          ? tr("trends.related.loading")
                          : tr("trends.related.loadMore").replace("{n}", String(relatedRows.length)).replace("{total}", String(searchData?.meta?.total ?? "?"))}
                      </button>
                    </div>
                  )}

                  <p className="text-[9px] text-gray-400 mt-2 text-center">
                    {tr("trends.related.disclaimer")}
                  </p>
                </div>

                {/* Keyword Actions & Saved Opportunities */}
                <KeywordWorkflowSection
                  s={summary}
                  planned={seedPlanned}
                  onCreatePinIdeas={() => gotoPinIdeas(summary.keyword)}
                  onCreateProductIdeas={() => gotoProducts(summary.keyword)}
                  onUseInCreatePins={handleCreatePinsFromSummary}
                  onAddToPlan={handleSaveSeed}
                  onSaveOpportunity={handleSaveSeed}
                  onViewRelated={handleViewRelated}
                />
              </>
            )}
          </>
        )}
      </main>

      {evidenceRow && (
        <EvidenceDrawer row={evidenceRow} onClose={() => setEvidenceRow(null)} />
      )}
    </div>
  );
}
