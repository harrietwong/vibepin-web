"use client";

import { TrendingUp, TrendingDown, Minus, Sparkles, ChevronRight } from "lucide-react";
import type { KeywordOpportunity, MomentumLevel, MarketTag } from "@/types/opportunity";
import { MARKET_TAG_META } from "@/types/opportunity";
import { BookmarkButton } from "@/components/ui/BookmarkButton";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";

// ── Volume formatter ──────────────────────────────────────────────────────────
function fmtVol(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ── Momentum icon ─────────────────────────────────────────────────────────────
export function MomentumIcon({ level }: { level: MomentumLevel }) {
  if (level === "surging")   return <TrendingUp  className="w-3.5 h-3.5 text-emerald-500" />;
  if (level === "declining") return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
  return                            <Minus        className="w-3.5 h-3.5 text-gray-400" />;
}

export const MOMENTUM_LABEL: Record<MomentumLevel, { labelKey: MessageKey; color: string }> = {
  surging:   { labelKey: "opportunity.momentum.surging",   color: "#059669" },
  steady:    { labelKey: "opportunity.momentum.steady",    color: "#9CA3AF" },
  declining: { labelKey: "opportunity.momentum.declining", color: "#EF4444" },
};

// ── MarketTag tooltip copy ────────────────────────────────────────────────────
// Wording preserved verbatim (Opportunity/Score/Fit compliance) — only made translatable.
const TAG_TOOLTIP: Record<MarketTag, { explainKey: MessageKey; actionKey: MessageKey }> = {
  hidden_supply: {
    explainKey: "opportunity.tag.hiddenSupply.explain",
    actionKey:  "opportunity.tag.hiddenSupply.action",
  },
  new_account_friendly: {
    explainKey: "opportunity.tag.newAccountFriendly.explain",
    actionKey:  "opportunity.tag.newAccountFriendly.action",
  },
  oversaturated: {
    explainKey: "opportunity.tag.oversaturated.explain",
    actionKey:  "opportunity.tag.oversaturated.action",
  },
  low_volume: {
    explainKey: "opportunity.tag.lowVolume.explain",
    actionKey:  "opportunity.tag.lowVolume.action",
  },
};

// ── Market tag badge with tooltip ─────────────────────────────────────────────
export function MarketTagBadge({ tag }: { tag: MarketTag }) {
  const { t: tr } = useLocale();
  const m   = MARKET_TAG_META[tag];
  const tip = TAG_TOOLTIP[tag];
  return (
    <span className="relative group/tag inline-flex">
      <span
        className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold leading-none cursor-help select-none"
        style={{ background: m.bg, color: m.color, border: `1px solid ${m.border}` }}
      >
        {m.emoji} {m.label}
      </span>
      {/* Tooltip — renders above the badge, always visible in overflow-visible contexts */}
      <span
        className="pointer-events-none absolute bottom-full left-0 mb-2 z-[60] w-56 rounded-xl p-3 shadow-xl opacity-0 group-hover/tag:opacity-100 transition-opacity duration-150"
        style={{ background: "#111827", border: "1px solid #1F2937" }}
      >
        <p className="text-[11px] font-semibold text-white leading-snug mb-1.5">{tr(tip.explainKey)}</p>
        <p className="text-[10px] font-bold" style={{ color: m.color }}>→ {tr(tip.actionKey)}</p>
        {/* Arrow */}
        <span
          className="absolute left-3 top-full w-0 h-0"
          style={{
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: "5px solid #1F2937",
          }}
        />
      </span>
    </span>
  );
}

// ── Metric row ────────────────────────────────────────────────────────────────
function MetricRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-gray-50 last:border-0">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 w-24 shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-2 ml-auto">{children}</div>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────
interface OpportunityCardProps {
  item:        KeywordOpportunity;
  onAnalyze?:  (item: KeywordOpportunity) => void;
  studioHref?: string;
  compact?:    boolean;
}

export function OpportunityCard({
  item,
  onAnalyze,
  studioHref,
  compact = false,
}: OpportunityCardProps) {
  const { t: tr } = useLocale();
  const { meta } = item;
  const tagMeta  = MARKET_TAG_META[meta.marketTag];
  const momentum = MOMENTUM_LABEL[meta.momentum];

  const studio = studioHref ??
    `/app/studio?source=workspace&keyword=${encodeURIComponent(item.keyword)}&category=${item.category}&sourceType=keyword&primaryLabel=${encodeURIComponent(meta.marketTag === "hidden_supply" ? "Best Bet" : "Steady")}&trendState=${encodeURIComponent(meta.momentum === "surging" ? "Rising" : "Evergreen")}`;

  return (
    // overflow-visible so tooltip can escape card bounds; rounded corners preserved via
    // rounded-t-2xl on the accent strip instead of parent overflow-hidden
    <div
      className="group relative flex flex-col rounded-2xl bg-white border shadow-sm hover:shadow-md transition-all duration-200"
      style={{ borderColor: tagMeta.border }}
    >
      {/* Top accent strip */}
      <div className="h-0.5 w-full rounded-t-2xl" style={{ background: tagMeta.color }} />

      <div className={compact ? "p-4" : "p-5"}>

        {/* ── Header: market tag + bookmark + category ──────────────────── */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <MarketTagBadge tag={meta.marketTag} />
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[10px] font-semibold text-gray-400 capitalize truncate max-w-[80px] text-right mt-0.5">
              {item.category}
            </span>
            <BookmarkButton
              item={{
                id: item.id,
                type: "keyword",
                title: item.keyword,
                category: item.category,
                image_url: null,
                keyword: item.keyword,
                marketTag: meta.marketTag,
              }}
            />
          </div>
        </div>

        {/* ── Keyword name ──────────────────────────────────────────────── */}
        <h3 className="text-[15px] font-black text-gray-900 capitalize leading-snug mb-4 line-clamp-2">
          {item.keyword}
        </h3>

        {/* ── Metrics ───────────────────────────────────────────────────── */}
        <div className="mb-3">
          <MetricRow label={tr("opportunity.card.estVolume")}>
            <span className="text-[11px] font-bold tabular-nums" style={{ color: tagMeta.color }}>
              👁️ {fmtVol(meta.estMonthlyVolume)}/mo
            </span>
          </MetricRow>

          <MetricRow label={tr("opportunity.card.momentum")}>
            <MomentumIcon level={meta.momentum} />
            <span className="text-[11px] font-bold" style={{ color: momentum.color }}>
              {tr(momentum.labelKey)}
            </span>
          </MetricRow>

          {meta.commercialRatio > 0 && (
            <MetricRow label={tr("opportunity.card.commercial")}>
              <span className="text-[11px] font-bold tabular-nums text-gray-600">
                {Math.round(meta.commercialRatio * 100)}{tr("opportunity.card.densitySuffix")}
              </span>
            </MetricRow>
          )}
        </div>

        {/* ── Insight ───────────────────────────────────────────────────── */}
        {!compact && (
          <p className="text-[11px] text-gray-500 leading-relaxed mb-4 min-h-[2.5rem] line-clamp-2">
            💡 {meta.insight}
          </p>
        )}

        {/* ── CTAs ──────────────────────────────────────────────────────── */}
        <div className="flex gap-2 mt-auto">
          {onAnalyze && (
            <button
              type="button"
              onClick={() => onAnalyze(item)}
              className="flex items-center gap-1 rounded-full px-3 py-2 text-[11px] font-semibold transition-colors border border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50"
            >
              {tr("opportunity.card.analyze")}
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
          <a
            href={studio}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-full py-2 text-[11px] font-bold text-white text-center no-underline transition-all hover:brightness-105"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
          >
            <Sparkles className="w-3 h-3" />
            {tr("opportunity.card.createPin")}
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Grid wrapper ──────────────────────────────────────────────────────────────
export function OpportunityGrid({
  items,
  onAnalyze,
}: {
  items:      KeywordOpportunity[];
  onAnalyze?: (item: KeywordOpportunity) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {items.map((item) => (
        <OpportunityCard key={item.id} item={item} onAnalyze={onAnalyze} />
      ))}
    </div>
  );
}
