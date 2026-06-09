"use client";
import { useState, useMemo, useEffect } from "react";
import useSWR from "swr";
import {
  Search, X, TrendingUp, Heart, Users, Trophy,
  MoreHorizontal, Plus, BarChart2, Clock, Sparkles, ChevronDown,
} from "lucide-react";
import Image from "next/image";
import { createBrowserClient } from "@supabase/ssr";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { buildPrefillFromKeywordTrend, openCreatePins } from "@/lib/createPinsPrefill";
import { getWeekStart } from "@/lib/useWeeklyPlan";
import {
  TrendSparkline as TrendHistorySparkline,
  TrendHistoryChart,
} from "@/components/ui/TrendHistoryChart";
import type {
  Band, CompetitionBand, SaveSignalBand, TrendState, OpportunityLabel,
  KeywordSummary, RelatedKeywordRow, TrendPoint, DataConfidence,
} from "@/lib/keyword-data/types";
import type { WorkspaceTier } from "@/lib/workspaceStatics";
import { CATEGORIES, catEmoji } from "@/lib/categories";

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
};

const OPP_COLOR: Record<OpportunityLabel, { text: string; bg: string; border: string }> = {
  "Best Bet":    { text: "#7C3AED", bg: "rgba(124,58,237,0.09)", border: "rgba(124,58,237,0.25)" },
  "Steady":      { text: "#0891B2", bg: "rgba(8,145,178,0.09)",  border: "rgba(8,145,178,0.25)"  },
  "Competitive": { text: "#D97706", bg: "rgba(245,158,11,0.09)", border: "rgba(245,158,11,0.25)" },
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

function OppBadge({ label }: { label: OpportunityLabel }) {
  const s = OPP_COLOR[label];
  return (
    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.text, border: `1px solid ${s.border}` }}>
      {label}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: "High" | "Medium" | "Low" }) {
  const cfg = {
    High:   { color: "#059669", bg: "rgba(5,150,105,0.10)" },
    Medium: { color: "#D97706", bg: "rgba(245,158,11,0.10)" },
    Low:    { color: "#6B7280", bg: "rgba(156,163,175,0.10)" },
  }[confidence];
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap shrink-0"
      style={{ background: cfg.bg, color: cfg.color }}>
      {confidence} confidence
    </span>
  );
}

// ── Inline sparkline for table ─────────────────────────────────────────────────

function InlineSparkline({ data, band }: { data?: TrendPoint[]; band: Band }) {
  const color = INTEREST_COLOR[band].text;
  if (!data || data.length < 4) return <InterestBand band={band} />;
  return (
    <div className="flex items-center gap-2">
      <div style={{ width: 52, height: 26 }}>
        <TrendHistorySparkline data={data} color={color} height={26} />
      </div>
      <InterestBand band={band} />
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────

function SummaryCard({
  title, value, subtitle, color, bg, icon,
}: {
  title: string; value: string; subtitle: string;
  color: string; bg: string; icon: React.ReactNode;
}) {
  return (
    <div data-testid="keyword-summary-card" className="bg-white border border-gray-200 rounded-xl p-4 flex items-start gap-3">
      <div className="shrink-0 h-9 w-9 rounded-lg flex items-center justify-center" style={{ background: bg }}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{title}</p>
        <p className="text-[16px] font-black leading-none" style={{ color }}>{value}</p>
        <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">{subtitle}</p>
      </div>
    </div>
  );
}

function KeywordSummaryCards({ s }: { s: KeywordSummary }) {
  const iC = INTEREST_COLOR[s.pinterestInterestBand];
  const cC = COMP_COLOR[s.competitionBand];
  const sC = s.saveSignalBand ? SAVE_COLOR[s.saveSignalBand] : SAVE_COLOR.Weak;
  const oC = OPP_COLOR[s.opportunityLabel];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      <SummaryCard
        title="Pinterest Interest" value={s.pinterestInterestBand} color={iC.text} bg={iC.bg}
        subtitle={s.interestIndexCurrent != null ? `Index ${s.interestIndexCurrent} · Past 12 months` : "Past 12 months"}
        icon={<TrendingUp className="h-4 w-4" style={{ color: iC.text }} />}
      />
      <SummaryCard
        title="Save Signal" value={s.saveSignalBand ?? "—"} color={sC.text} bg={sC.bg}
        subtitle={s.saveSignalBand === "Strong" ? "Recent viral Pins" : s.saveSignalBand === "Medium" ? "Moderate engagement" : "Limited evidence yet"}
        icon={<Heart className="h-4 w-4" style={{ color: sC.text }} />}
      />
      <SummaryCard
        title="Competition" value={s.competitionBand} color={cC.text} bg={cC.bg}
        subtitle={s.competitionBand === "High" ? "Visual crowding" : s.competitionBand === "Medium" ? "Manageable density" : "Open field"}
        icon={<Users className="h-4 w-4" style={{ color: cC.text }} />}
      />
      <SummaryCard
        title="Opportunity" value={s.opportunityLabel} color={oC.text} bg={oC.bg}
        subtitle={s.opportunityLabel === "Best Bet" ? "Worth testing this week" : s.opportunityLabel === "Steady" ? "Consistent performer" : "Needs strong angle"}
        icon={<Trophy className="h-4 w-4" style={{ color: oC.text }} />}
      />
    </div>
  );
}

// ── Trend chart + insight bullets ─────────────────────────────────────────────

function TrendChartSection({ s }: { s: KeywordSummary }) {
  return (
    <div data-testid="search-trend-chart" className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-[13px] font-bold text-gray-900">Search Trend · Past 12 months</p>
              <p className="text-[10px] text-gray-400">Interest Index · 0–100</p>
            </div>
            <TrendChip state={s.trendState} />
          </div>
          {s.timeSeries.length >= 6 ? (
            <>
              <TrendHistoryChart trendHistory={s.timeSeries} label="" />
              <p className="text-[9px] text-gray-300 mt-1.5">
                Interest index based on Pinterest trend signals · normalized 0–100, not raw search volume
              </p>
            </>
          ) : (
            <div className="flex items-center justify-center py-8 text-[11px] text-gray-400 bg-gray-50 rounded-lg">
              No trend history available yet for this keyword
            </div>
          )}
        </div>

        {(s.insightBullets?.length ?? 0) > 0 && (
          <div className="lg:w-[230px] shrink-0 space-y-3.5">
            {s.insightBullets!.map((bullet, i) => {
              const icons = ["↑", "🏠", "⭐"];
              return (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="text-sm shrink-0 mt-0.5">{icons[i] ?? "•"}</span>
                  <p className="text-[11px] text-gray-600 leading-relaxed">{bullet}</p>
                </div>
              );
            })}
            <p className="text-[9px] text-gray-300 pt-2 border-t border-gray-100">
              Source: Pinterest trend signals
              {s.provenance.isEstimated && " · trend curve reconstructed from growth metrics"}
              {s.provenance.lastFetchedAt && <> · {new Date(s.provenance.lastFetchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</>}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Evidence drawer ───────────────────────────────────────────────────────────

function EvidenceDrawer({ row, onClose }: { row: RelatedKeywordRow; onClose: () => void }) {
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

  const oC = OPP_COLOR[row.opportunityLabel];

  const whyText =
    row.opportunityLabel === "Best Bet"
      ? `Pinterest interest is ${row.pinterestInterestBand.toLowerCase()}, competition is ${row.competitionBand.toLowerCase()}, and the trend is ${row.trendState.toLowerCase()}. Strong fit for styled, product-led Pins.`
      : row.opportunityLabel === "Steady"
      ? `Consistent search presence with ${row.competitionBand.toLowerCase()} competition. A reliable keyword for ongoing content.`
      : `High competition. Differentiate with a specific visual style or tight niche angle.`;

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
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">Keyword Evidence</p>
            <h3 className="text-[15px] font-black text-gray-900 leading-snug capitalize">{row.keyword}</h3>
          </div>
          <button type="button" onClick={onClose}
            className="rounded-full p-2 hover:bg-gray-100 transition-colors shrink-0">
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>

        {/* Provenance strip */}
        <div className="flex items-center justify-between px-6 py-2.5 border-b border-gray-100 bg-gray-50">
          <div className="min-w-0">
            <p className="text-[9px] text-gray-500 leading-relaxed">
              {row.provenance.sources.includes("pinterest_search_sample")
                ? "Pinterest trend signals + sampled search results"
                : row.provenance.isEstimated
                ? "Pinterest trend signals · trend curve reconstructed from growth metrics"
                : "Pinterest trend signals"}
            </p>
            {row.provenance.lastFetchedAt && (
              <p className="text-[9px] text-gray-400 mt-0.5">
                Updated {new Date(row.provenance.lastFetchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </p>
            )}
          </div>
          <ConfidenceBadge confidence={row.provenance.confidence} />
        </div>

        {/* Metrics grid */}
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Pinterest Interest", node: <InterestBand band={row.pinterestInterestBand} /> },
              { label: "Competition",        node: <CompBand band={row.competitionBand} /> },
              { label: "Trend State",        node: <TrendChip state={row.trendState} /> },
              { label: "Save Signal",        node: <SaveBand band={row.saveSignalBand} /> },
            ].map(({ label, node }) => (
              <div key={label}>
                <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</p>
                {node}
              </div>
            ))}
          </div>
        </div>

        {/* Why */}
        <div className="px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <OppBadge label={row.opportunityLabel} />
          </div>
          <p className="text-[11px] text-gray-600 leading-relaxed">{whyText}</p>
          {row.evidenceSentence && (
            <p className="text-[10px] text-gray-400 mt-2 italic">{row.evidenceSentence}</p>
          )}
        </div>

        {/* Mini trend chart */}
        {row.timeSeries && row.timeSeries.length >= 6 && (
          <div className="px-6 py-4 border-b border-gray-100">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">Search Trend</p>
            <TrendHistoryChart trendHistory={row.timeSeries} label={row.keyword} />
          </div>
        )}

        {/* Viral pins */}
        <div className="flex-1 px-5 py-5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">Top Pins</p>
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
                      <p className="text-[8px] text-white/80 font-bold">{(pin.save_count ?? 0).toLocaleString()} saves</p>
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
              <p className="text-[12px] font-semibold text-gray-500">No linked pins yet</p>
              <p className="text-[10px] text-gray-400 mt-1 max-w-[180px] leading-relaxed">
                Pins appear once linked to this keyword in the database.
              </p>
            </div>
          )}
        </div>

        {/* CTA */}
        <div className="px-6 py-4 border-t border-gray-100 shrink-0">
          <button type="button"
            onClick={() => openCreatePins(url => { window.location.href = url; }, buildPrefillFromKeywordTrend({ keyword: row.keyword, category: row.category, opportunityLabel: row.opportunityLabel, trendState: row.trendState }))}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-[12px] font-bold text-white"
            style={{ background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)", border: "none", cursor: "pointer" }}>
            <Sparkles className="h-3.5 w-3.5" />
            Create Pins for this keyword
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
  const active = value !== "All";
  return (
    <div className="relative">
      <select value={value} onChange={e => onChange(e.target.value)}
        className="appearance-none text-[11px] font-semibold pr-6 pl-3 py-1.5 rounded-lg border bg-white transition-colors cursor-pointer focus:outline-none"
        style={{ borderColor: active ? "#C026D3" : "#E5E7EB", color: active ? "#C026D3" : "#6B7280" }}>
        {options.map(opt => (
          <option key={opt} value={opt}>{opt === "All" ? `${label}: All` : opt}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 pointer-events-none text-gray-400" />
    </div>
  );
}

function FilterRow({
  productMode, setProductMode, demandFilter, setDemandFilter,
  compFilter, setCompFilter, trendFilter, setTrendFilter, onReset,
}: {
  productMode: "physical" | "digital"; setProductMode: (m: "physical" | "digital") => void;
  demandFilter: "All" | Band; setDemandFilter: (v: "All" | Band) => void;
  compFilter: "All" | CompetitionBand; setCompFilter: (v: "All" | CompetitionBand) => void;
  trendFilter: "All" | TrendState; setTrendFilter: (v: "All" | TrendState) => void;
  onReset: () => void;
}) {
  const hasFilter = demandFilter !== "All" || compFilter !== "All" || trendFilter !== "All";
  return (
    <div className="flex flex-wrap items-center gap-2.5 mb-4">
      <div className="flex rounded-xl overflow-hidden border border-gray-200 bg-white shrink-0">
        {(["physical", "digital"] as const).map(mode => (
          <button key={mode} type="button" onClick={() => setProductMode(mode)}
            className="px-4 py-1.5 text-[11px] font-bold transition-all whitespace-nowrap"
            style={productMode === mode ? { background: "#C026D3", color: "#fff" } : { background: "#fff", color: "#6B7280" }}>
            {mode === "physical" ? "Physical Products" : "Digital Products"}
          </button>
        ))}
      </div>
      <FilterSelect label="Demand" value={demandFilter} options={["All", "High", "Medium", "Low"]}
        onChange={v => setDemandFilter(v as "All" | Band)} />
      <FilterSelect label="Competition" value={compFilter} options={["All", "Low", "Medium", "High"]}
        onChange={v => setCompFilter(v as "All" | CompetitionBand)} />
      <FilterSelect label="Trend State" value={trendFilter} options={["All", "Rising", "Evergreen", "Seasonal"]}
        onChange={v => setTrendFilter(v as "All" | TrendState)} />
      {hasFilter && (
        <button type="button" onClick={onReset}
          className="text-[11px] font-semibold text-gray-400 hover:text-gray-600 transition-colors px-1">
          Reset
        </button>
      )}
    </div>
  );
}

// ── Related keywords table ────────────────────────────────────────────────────

const TABLE_COLS = "28px minmax(170px,2fr) 88px 155px 82px 82px 98px 90px 160px";

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
  return (
    <div data-testid="related-keywords-table" className="rounded-xl overflow-hidden bg-white border border-gray-200 shadow-sm">
      <div className="grid items-center px-4 py-3 border-b border-gray-100 bg-gray-50"
        style={{ gridTemplateColumns: TABLE_COLS }}>
        <span />
        {["Keyword","Category","Pinterest Interest","Save Signal","Competition","Trend","Opportunity","Actions"].map(h => (
          <span key={h} className="text-[10px] font-bold uppercase tracking-widest text-gray-500 last:text-right">{h}</span>
        ))}
      </div>

      {loading && (
        <div className="divide-y divide-gray-100">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="grid items-center px-4 py-3.5" style={{ gridTemplateColumns: TABLE_COLS }}>
              {[8, 140, 70, 90, 60, 60, 70, 70, 110].map((w, j) => (
                <div key={j} className="h-3 rounded bg-gray-100 animate-pulse mr-3" style={{ width: w }} />
              ))}
            </div>
          ))}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="divide-y divide-gray-100">
          {rows.map((row, idx) => {
            const catDef = CATEGORIES.find(c => c.id === row.category);
            const emoji  = row.category ? catEmoji(row.category) : "📌";
            const isAdded   = addedKwIds.has(row.id);
            const isAdding  = addingId === row.id;
            return (
              <div key={row.id}
                data-testid="related-keyword-row"
                className="group grid items-center px-4 py-3 hover:bg-gray-50 transition-colors"
                style={{ gridTemplateColumns: TABLE_COLS }}>
                <span className="text-[9px] font-mono text-gray-300 tabular-nums select-none">{idx + 1}</span>
                <div className="min-w-0 pr-3">
                  <p className="text-[12px] font-semibold text-gray-900 truncate capitalize leading-snug">{row.keyword}</p>
                </div>
                <div>
                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize whitespace-nowrap">
                    {emoji} {catDef?.label ?? row.category ?? "—"}
                  </span>
                </div>
                <InlineSparkline data={row.timeSeries} band={row.pinterestInterestBand} />
                <SaveBand band={row.saveSignalBand} />
                <CompBand band={row.competitionBand} />
                <TrendChip state={row.trendState} />
                <OppBadge label={row.opportunityLabel} />
                <div className="flex items-center justify-end gap-1.5">
                  <button type="button" data-testid="keyword-create-pins-button" onClick={() => onCreatePins(row)}
                    className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
                    style={{ background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)" }}>
                    Create Pins
                  </button>
                  <div className="relative opacity-0 group-hover:opacity-100 transition-opacity">
                    <button type="button"
                      onClick={e => { e.stopPropagation(); setOverflowId(overflowId === row.id ? null : row.id); }}
                      className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                    {overflowId === row.id && (
                      <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-xl border border-gray-200 shadow-lg py-1.5 min-w-[165px]"
                        onClick={e => e.stopPropagation()}>
                        <button type="button" data-testid="keyword-add-to-plan-button" disabled={isAdded || isAdding}
                          onClick={() => { onAddToPlan(row); setOverflowId(null); }}
                          className="w-full flex items-center gap-2 text-left px-3.5 py-2 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                          <Plus className="h-3 w-3" />
                          {isAdded ? "In Weekly Plan" : isAdding ? "Adding…" : "Add to Weekly Plan"}
                        </button>
                        <button type="button" data-testid="view-evidence-button"
                          onClick={() => { onEvidence(row); setOverflowId(null); }}
                          className="w-full flex items-center gap-2 text-left px-3.5 py-2 text-[11px] text-gray-600 hover:bg-gray-50">
                          <Search className="h-3 w-3" /> View Evidence
                        </button>
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
          <p className="text-[13px] font-semibold text-gray-500">No keywords match the current filters</p>
          <p className="text-[11px] text-gray-400">Try clearing a filter or search a different term</p>
        </div>
      )}
    </div>
  );
}

// ── State A: default view ─────────────────────────────────────────────────────

function DefaultView({
  trendingRows, recentSearches, onSearch,
}: {
  trendingRows: RelatedKeywordRow[];
  recentSearches: string[];
  onSearch: (kw: string) => void;
}) {
  return (
    <div className="mt-8">
      {recentSearches.length > 0 && (
        <div className="mb-6">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-1.5">
            <Clock className="h-3 w-3" /> Recent searches
          </p>
          <div className="flex flex-wrap gap-2">
            {recentSearches.map(kw => (
              <button key={kw} type="button" onClick={() => onSearch(kw)}
                className="px-3 py-1.5 rounded-full text-[11px] font-semibold border border-gray-200 bg-white text-gray-600 hover:border-[#C026D3] hover:text-[#C026D3] transition-colors capitalize">
                {kw}
              </button>
            ))}
          </div>
        </div>
      )}

      {trendingRows.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-[14px] font-black text-gray-900">Trending This Week</p>
              <p className="text-[11px] text-gray-400">Top keywords by Pinterest priority — click any to research</p>
            </div>
            <BarChart2 className="h-4 w-4 text-gray-300" />
          </div>
          <div className="rounded-xl overflow-hidden bg-white border border-gray-200 shadow-sm">
            <div className="grid items-center px-4 py-2.5 border-b border-gray-100 bg-gray-50"
              style={{ gridTemplateColumns: "minmax(180px,2fr) 90px 100px 88px 90px 120px" }}>
              {["Keyword","Category","Interest","Competition","Trend","Opportunity"].map(h => (
                <span key={h} className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{h}</span>
              ))}
            </div>
            <div className="divide-y divide-gray-100">
              {trendingRows.map(row => {
                const catDef = CATEGORIES.find(c => c.id === row.category);
                const emoji  = row.category ? catEmoji(row.category) : "📌";
                return (
                  <button key={row.id} type="button" onClick={() => onSearch(row.keyword)}
                    className="w-full grid items-center px-4 py-3 hover:bg-gray-50 transition-colors text-left group"
                    style={{ gridTemplateColumns: "minmax(180px,2fr) 90px 100px 88px 90px 120px" }}>
                    <p className="text-[12px] font-semibold text-gray-900 capitalize truncate group-hover:text-[#C026D3] transition-colors">
                      {row.keyword}
                    </p>
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize whitespace-nowrap w-fit">
                      {emoji} {catDef?.label ?? row.category ?? "—"}
                    </span>
                    <InterestBand band={row.pinterestInterestBand} />
                    <CompBand band={row.competitionBand} />
                    <TrendChip state={row.trendState} />
                    <OppBadge label={row.opportunityLabel} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Add to weekly plan ─────────────────────────────────────────────────────────

const planClient = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

function oppLabelToTier(label: OpportunityLabel): WorkspaceTier {
  if (label === "Best Bet") return "blue_ocean";
  if (label === "Steady")   return "early_trend";
  return "hot_red_sea";
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
    tier:       oppLabelToTier(row.opportunityLabel),
    score:      0,
    sort_order: slotCount ?? 0,
  });
  return error ? error.message : null;
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function TrendsPage() {
  const [searchInput,     setSearchInput]     = useState("");
  const [searchedKeyword, setSearchedKeyword] = useState("");
  const [recentSearches,  setRecentSearches]  = useState<string[]>([]);
  const [productMode,     setProductMode]     = useState<"physical" | "digital">("physical");
  const [demandFilter,    setDemandFilter]    = useState<"All" | Band>("All");
  const [compFilter,      setCompFilter]      = useState<"All" | CompetitionBand>("All");
  const [trendFilter,     setTrendFilter]     = useState<"All" | TrendState>("All");
  const [evidenceRow,     setEvidenceRow]     = useState<RelatedKeywordRow | null>(null);
  const [overflowId,      setOverflowId]      = useState<string | null>(null);
  const [addedKwIds,      setAddedKwIds]      = useState<Set<string>>(new Set());
  const [addingId,        setAddingId]        = useState<string | null>(null);

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
    setDemandFilter("All");
    setCompFilter("All");
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
  }

  async function handleAddToPlan(row: RelatedKeywordRow) {
    if (addedKwIds.has(row.id) || addingId === row.id) return;
    setAddingId(row.id);
    const err = await addRowToWeeklyPlan(row);
    setAddingId(null);
    if (err === "Already in your plan") {
      setAddedKwIds(prev => new Set([...prev, row.id]));
      toast.info("Already in your plan");
    } else if (err) {
      toast.error(err);
    } else {
      setAddedKwIds(prev => new Set([...prev, row.id]));
      toast.success(`"${row.keyword}" added to weekly plan`, {
        action: {
          label: "View Plan",
          onClick: () => { window.location.href = `/app/plan?category=${row.category ?? ""}`; },
        },
      });
    }
  }

  function handleCreatePins(row: RelatedKeywordRow) {
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromKeywordTrend({
      keyword: row.keyword,
      category: row.category,
      opportunityLabel: row.opportunityLabel,
      trendState: row.trendState,
    }));
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  const { data: searchData, isLoading: searchLoading } = useSWR(
    searchedKeyword ? ["kwt-search", searchedKeyword] : null,
    async ([, kw]) => {
      const res = await fetch(`/api/keyword-tool/search?keyword=${encodeURIComponent(kw as string)}&region=US`);
      if (!res.ok) throw new Error("Search failed");
      return res.json() as Promise<{ summary: KeywordSummary | null; message?: string }>;
    },
    { revalidateOnFocus: false },
  );

  const { data: relatedData, isLoading: relatedLoading } = useSWR(
    searchedKeyword ? ["kwt-related", searchedKeyword, productMode] : null,
    async ([, kw, mode]) => {
      const p = new URLSearchParams({ keyword: kw as string, region: "US", limit: "25" });
      if ((mode as string) === "digital") p.set("category", "digital-products");
      const res = await fetch(`/api/keyword-tool/related?${p}`);
      if (!res.ok) throw new Error("Related fetch failed");
      return res.json() as Promise<{ rows: RelatedKeywordRow[] }>;
    },
    { revalidateOnFocus: false },
  );

  const { data: trendingData } = useSWR(
    !searchedKeyword ? ["kwt-trending", productMode] : null,
    async ([, mode]) => {
      const p = new URLSearchParams({ keyword: "", region: "US", limit: "10" });
      if ((mode as string) === "digital") p.set("category", "digital-products");
      const res = await fetch(`/api/keyword-tool/related?${p}`);
      if (!res.ok) return { rows: [] as RelatedKeywordRow[] };
      return res.json() as Promise<{ rows: RelatedKeywordRow[] }>;
    },
    { revalidateOnFocus: false },
  );

  const summary = searchData?.summary ?? null;

  const filteredRelated = useMemo(() => {
    const rows = relatedData?.rows ?? [];
    return rows.filter(r => {
      if (demandFilter !== "All" && r.pinterestInterestBand !== demandFilter) return false;
      if (compFilter   !== "All" && r.competitionBand        !== compFilter)  return false;
      if (trendFilter  !== "All" && r.trendState             !== trendFilter) return false;
      return true;
    });
  }, [relatedData, demandFilter, compFilter, trendFilter]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app-page h-full overflow-y-auto">
      <main className="max-w-[1320px] mx-auto px-6 py-8">

        {/* Page header */}
        <div className="mb-6">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">Keyword Trends</p>
          <h1 className="text-[22px] font-black text-gray-900 tracking-tight">Keyword Tool</h1>
          <p className="text-[13px] text-gray-500 mt-1">Research Pinterest keywords by demand, competition, and trend.</p>
        </div>

        {/* Search bar */}
        <div className="bg-white border border-gray-200 rounded-xl p-3 shadow-sm mb-4">
          <div className="flex gap-2 items-center">
            {/* Platform pill */}
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 shrink-0">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="#E60023">
                <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
              </svg>
              <span className="text-[11px] font-semibold text-gray-700">Pinterest</span>
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
                placeholder="Search a Pinterest keyword…"
                className="w-full rounded-lg border border-gray-200 bg-white pl-9 pr-9 py-2 text-[13px] text-gray-900 focus:border-[#C026D3] focus:outline-none placeholder:text-gray-400"
              />
              {searchInput && (
                <button type="button" onClick={handleClear}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 transition-colors">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Region */}
            <div className="flex items-center gap-1 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 shrink-0">
              <span className="text-[11px]">🇺🇸</span>
              <span className="text-[11px] font-semibold text-gray-700">USA</span>
            </div>

            {/* Search button */}
            <button type="button" data-testid="keyword-search-button" onClick={() => handleSearch()}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-[12px] font-bold text-white whitespace-nowrap shrink-0 hover:brightness-105 transition-all"
              style={{ background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)" }}>
              <Search className="h-3.5 w-3.5" />
              Search Keywords
            </button>
          </div>

          {/* Recent searches (inline below bar, only if State A or just after typing) */}
          {!searchedKeyword && recentSearches.length > 0 && (
            <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-gray-100">
              <span className="text-[10px] text-gray-400 font-medium shrink-0">Recent:</span>
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
            trendingRows={trendingData?.rows ?? []}
            recentSearches={[]}
            onSearch={handleSearch}
          />
        )}

        {/* ── State B: search result ─────────────────────────────────────────── */}
        {searchedKeyword && (
          <>
            {searchLoading && (
              <div className="flex flex-col items-center py-16 text-center gap-3">
                <div className="h-8 w-8 rounded-full border-2 border-[#C026D3] border-t-transparent animate-spin" />
                <p className="text-[13px] text-gray-400">Looking up "{searchedKeyword}"…</p>
              </div>
            )}

            {!searchLoading && searchData && !summary && (
              <div className="flex flex-col items-center py-16 text-center gap-3 bg-white border border-gray-200 rounded-xl">
                <p className="text-4xl">🔍</p>
                <p className="text-[14px] font-semibold text-gray-700">No keyword data found yet</p>
                <p className="text-[11px] text-gray-400 max-w-[300px] leading-relaxed">
                  {searchData.message ?? "Try another keyword or browse trending keywords."}
                </p>
                <div className="flex items-center gap-2 mt-1 flex-wrap justify-center">
                  <button type="button" onClick={handleClear}
                    className="px-4 py-2 rounded-xl text-[11px] font-bold"
                    style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3" }}>
                    Browse trending keywords
                  </button>
                  <a
                    data-testid="keyword-create-anyway-button"
                    href={`/app/studio?keyword=${encodeURIComponent(searchedKeyword)}&from=keyword_trends&unvalidated=true`}
                    className="px-4 py-2 rounded-xl text-[11px] font-bold border border-gray-200 text-gray-600 hover:bg-gray-50 no-underline">
                    Create Pins anyway
                  </a>
                </div>
                <p className="text-[9px] text-gray-300 max-w-[260px]">
                  "Create Pins anyway" uses the raw keyword without verified trend data.
                </p>
              </div>
            )}

            {!searchLoading && summary && (
              <>
                {/* Keyword heading */}
                <div className="mb-4">
                  {!summary.isExactMatch && summary.matchedKeyword && (
                    <p className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 mb-2 inline-flex items-center gap-1.5">
                      <span>⚠</span>
                      Showing closest match for "{searchedKeyword}"
                    </p>
                  )}
                  <h2 className="text-[18px] font-black text-gray-900 capitalize">{summary.keyword}</h2>
                  {summary.category && (
                    <p className="text-[11px] text-gray-400 mt-0.5 capitalize">
                      {catEmoji(summary.category)} {summary.category.replace(/-/g, " ")}
                    </p>
                  )}
                </div>

                <KeywordSummaryCards s={summary} />
                <TrendChartSection s={summary} />

                {/* Related keywords */}
                <div className="mb-2">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-[14px] font-black text-gray-900">Related Keywords</p>
                      <p className="text-[11px] text-gray-400">
                        {summary.category
                          ? `${summary.category.replace(/-/g, " ")} keywords`
                          : "Keywords in same category"}
                        {relatedData ? ` · ${relatedData.rows.length} found` : ""}
                      </p>
                    </div>
                  </div>

                  <FilterRow
                    productMode={productMode}     setProductMode={setProductMode}
                    demandFilter={demandFilter}   setDemandFilter={setDemandFilter}
                    compFilter={compFilter}       setCompFilter={setCompFilter}
                    trendFilter={trendFilter}     setTrendFilter={setTrendFilter}
                    onReset={() => { setDemandFilter("All"); setCompFilter("All"); setTrendFilter("All"); }}
                  />

                  <RelatedKeywordsTable
                    rows={filteredRelated}
                    loading={relatedLoading}
                    onEvidence={setEvidenceRow}
                    onAddToPlan={handleAddToPlan}
                    onCreatePins={handleCreatePins}
                    addedKwIds={addedKwIds}
                    addingId={addingId}
                    overflowId={overflowId}
                    setOverflowId={setOverflowId}
                  />

                  <p className="text-[9px] text-gray-300 mt-2 text-center">
                    Data: Pinterest trend signals · Qualitative bands only — no exact search volume shown
                  </p>
                </div>
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
