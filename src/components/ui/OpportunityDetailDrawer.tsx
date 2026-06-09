"use client";

import { X, Sparkles, ExternalLink } from "lucide-react";
import Image from "next/image";
import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import { MarketTagBadge, MomentumIcon, MOMENTUM_LABEL } from "@/components/ui/OpportunityCard";
import { mapPinToOpportunity, mapProductToOpportunity } from "@/lib/dataMapping";
import { MARKET_TAG_META } from "@/types/opportunity";
import type { KeywordOpportunity, OpportunityAssessment } from "@/types/opportunity";

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function fmtVol(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ── Mini assessment block (for linked pins & products) ────────────────────────
function MiniBlock({
  title, imageUrl, meta, saves, domain, pinId,
}: {
  title:     string;
  imageUrl?: string | null;
  meta:      OpportunityAssessment;
  saves:     number;
  domain?:   string | null;
  pinId?:    string | null;
}) {
  const mom = MOMENTUM_LABEL[meta.momentum];
  return (
    <div className="flex items-start gap-3 py-3.5 border-b border-gray-50 last:border-0">
      <div className="relative h-14 w-10 rounded-lg overflow-hidden shrink-0 bg-gray-100">
        {imageUrl && (
          <Image src={imageUrl} alt="" fill className="object-cover" sizes="40px" unoptimized />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <MarketTagBadge tag={meta.marketTag} />
          {pinId && (
            <a
              href={`https://www.pinterest.com/pin/${pinId}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <p className="text-[12px] font-semibold text-gray-800 line-clamp-1 capitalize mb-1">{title}</p>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-semibold text-gray-500">
            👁️ {fmtVol(meta.estMonthlyVolume)}/mo
          </span>
          <span className="flex items-center gap-1">
            <MomentumIcon level={meta.momentum} />
            <span className="text-[9px] font-semibold" style={{ color: mom.color }}>{mom.label}</span>
          </span>
        </div>
        <p className="text-[10px] text-gray-400 mt-1">
          Data: <span className="font-semibold text-gray-600">{fmt(saves)} saves</span>
          {domain && <> · <span>{domain.replace(/^www\./, "")}</span></>}
        </p>
      </div>
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count: number | null }) {
  return (
    <div className="flex items-center gap-2 px-6 py-2.5 bg-gray-50 border-y border-gray-100 shrink-0">
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{title}</p>
      {count !== null && (
        <span className="text-[9px] font-semibold rounded-full px-1.5 py-0.5 bg-gray-200 text-gray-600 tabular-nums">
          {count}
        </span>
      )}
    </div>
  );
}

// ── Main drawer ───────────────────────────────────────────────────────────────
export function OpportunityDetailDrawer({
  item,
  onClose,
}: {
  item:    KeywordOpportunity;
  onClose: () => void;
}) {
  const tagMeta = MARKET_TAG_META[item.meta.marketTag];
  const mom     = MOMENTUM_LABEL[item.meta.momentum];

  const { data: pins, isLoading: pinsLoading } = useSWR(
    ["detail_pins", item.id],
    async () => {
      const { data } = await supabase
        .from("pin_samples")
        .select("id,image_url,category,title,save_count,save_velocity,pin_id,days_since_creation")
        .eq("trend_keyword_id", item.id)
        .order("save_count", { ascending: false })
        .limit(6);
      return (data ?? []).map(mapPinToOpportunity);
    },
    { revalidateOnFocus: false },
  );

  const { data: products, isLoading: productsLoading } = useSWR(
    ["detail_products", item.keyword],
    async () => {
      const { data } = await supabase
        .from("pin_products")
        .select("id,product_name,image_url,save_count,source_pin_save_count,domain,seed_keyword")
        .ilike("seed_keyword", `%${item.keyword}%`)
        .order("save_count", { ascending: false })
        .limit(6);
      return (data ?? []).map(p => mapProductToOpportunity(p));
    },
    { revalidateOnFocus: false },
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-[480px] h-full flex flex-col shadow-2xl bg-white border-l border-gray-200 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div
          className="flex items-start justify-between px-6 py-5 border-b border-gray-100 shrink-0"
          style={{ borderTop: `3px solid ${tagMeta.color}` }}
        >
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-2 mb-2">
              <MarketTagBadge tag={item.meta.marketTag} />
              <span className="text-[10px] font-semibold text-gray-400 capitalize">{item.category}</span>
            </div>
            <h3 className="text-[17px] font-black text-gray-900 leading-snug capitalize">{item.keyword}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 hover:bg-gray-100 transition-colors shrink-0"
          >
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>

        {/* ── Scrollable body ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">

          {/* Keyword Assessment */}
          <div className="px-6 py-4 border-b border-gray-100">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-3">Niche Intelligence</p>

            {/* Key stats grid */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="rounded-xl p-3 bg-gray-50 border border-gray-100">
                <p className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">Est. Monthly Volume</p>
                <p className="text-[15px] font-black tabular-nums" style={{ color: tagMeta.color }}>
                  👁️ {fmtVol(item.meta.estMonthlyVolume)}
                </p>
              </div>
              <div className="rounded-xl p-3 bg-gray-50 border border-gray-100">
                <p className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">Commercial Density</p>
                <p className="text-[15px] font-black tabular-nums text-gray-800">
                  {item.meta.commercialRatio > 0
                    ? `${Math.round(item.meta.commercialRatio * 100)}%`
                    : "—"}
                </p>
              </div>
            </div>

            {/* Momentum row */}
            <div className="flex items-center gap-2 mb-3 px-1">
              <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 w-20 shrink-0">Momentum</span>
              <MomentumIcon level={item.meta.momentum} />
              <span className="text-[11px] font-bold" style={{ color: mom.color }}>{mom.label}</span>
            </div>

            <p className="text-[11px] text-gray-500 leading-relaxed">💡 {item.meta.insight}</p>

            {item.saves > 0 && (
              <p className="text-[10px] text-gray-400 mt-2">
                Raw data:{" "}
                <span className="font-semibold text-gray-600">{fmt(item.saves)} saves</span>
                {item.pin_count > 0 && <> · {item.pin_count} pins</>}
                {item.linked_products > 0 && <> · {item.linked_products} products</>}
              </p>
            )}
          </div>

          {/* Linked Viral Pins */}
          <SectionHeader
            title="Linked Viral Pins"
            count={pinsLoading ? null : (pins?.length ?? 0)}
          />
          <div className="px-6">
            {pinsLoading && (
              <div className="space-y-3 py-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-16 animate-pulse bg-gray-100 rounded-lg" />
                ))}
              </div>
            )}
            {!pinsLoading && (pins?.length ?? 0) === 0 && (
              <div className="py-8 text-center">
                <p className="text-[11px] text-gray-400">
                  No linked pins yet — run the scraper to link pins to this keyword.
                </p>
              </div>
            )}
            {!pinsLoading && pins && pins.map(pin => (
              <MiniBlock
                key={pin.id}
                title={pin.title ?? pin.category}
                imageUrl={pin.image_url}
                meta={pin.meta}
                saves={pin.save_count}
                pinId={pin.pin_id}
              />
            ))}
          </div>

          {/* Linked Products */}
          <SectionHeader
            title="Linked Products"
            count={productsLoading ? null : (products?.length ?? 0)}
          />
          <div className="px-6">
            {productsLoading && (
              <div className="space-y-3 py-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-16 animate-pulse bg-gray-100 rounded-lg" />
                ))}
              </div>
            )}
            {!productsLoading && (products?.length ?? 0) === 0 && (
              <div className="py-8 text-center">
                <p className="text-[11px] text-gray-400">No linked products found for this keyword.</p>
              </div>
            )}
            {!productsLoading && products && products.map(prod => (
              <MiniBlock
                key={prod.id}
                title={prod.product_name}
                imageUrl={prod.image_url}
                meta={prod.meta}
                saves={prod.save_count}
                domain={prod.domain}
              />
            ))}
          </div>

          <div className="h-6" />
        </div>

        {/* ── Sticky CTA ──────────────────────────────────────────────────── */}
        <div className="shrink-0 px-6 py-4 border-t border-gray-100 bg-white">
          <a
            href={`/app/studio?source=workspace&keyword=${encodeURIComponent(item.keyword)}&category=${item.category}&sourceType=keyword&primaryLabel=${encodeURIComponent((item as {score_tier?: string}).score_tier === "high" ? "Best Bet" : "Steady")}&trendState=${encodeURIComponent((item as {yearly_change?: number}).yearly_change ?? 0 >= 50 ? "Rising" : "Evergreen")}`}
            className="flex items-center justify-center gap-2 w-full rounded-full py-3 text-[13px] font-bold text-white no-underline transition-all hover:brightness-105"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
          >
            <Sparkles className="w-4 h-4" />
            Create Pin for &ldquo;{item.keyword}&rdquo;
          </a>
        </div>
      </div>
    </div>
  );
}
