"use client";
import Image from "next/image";
import { useEffect } from "react";
import useSWR from "swr";
import { X, Sparkles, Zap, ShoppingBag, Lightbulb, ArrowRight, AlertCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { mockKeywordScore } from "@/components/OpportunityScore";
import { ScoreBadge, ScorePill } from "@/components/ui/signals";
import { buildOpportunityBrief, stageBadgeStyle } from "@/lib/opportunityMocks";
import { useLocale } from "@/lib/i18n/LocaleProvider";

// ── Types ──────────────────────────────────────────────────────────────────────
type TrendKeyword = {
  id: string;
  keyword: string;
  category: string;
  weekly_change: number;
  yearly_change: number;
  priority_score: number;
  monthly_change?: number;
  search_volume_level?: string | null;
};

// Shape returned by GET /api/opportunities (matches trend_opportunities_view v11)
type OpportunityRecord = {
  keyword_id: string;
  keyword: string;
  category: string;
  pct_growth_yoy: number | null;
  search_volume_level: string | null;
  linked_pins_count: number;
  linked_products_count: number;
  total_source_saves: number;
  avg_velocity_score: number | null;
  opportunity_score: number | null;
  score_tier: string;
  data_confidence: string;
  confidence_reason: string;
};

type PinRow = {
  id: string; image_url: string; category: string; title: string | null;
  save_count: number | null; save_velocity: number | null;
  pin_id: string | null; outbound_link: string | null;
  days_since_creation: number | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtPct(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K%`;
  return `${sign}${abs.toFixed(0)}%`;
}


function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-neutral-500">{icon}</span>
      <p className="text-[10px] font-black uppercase tracking-widest text-neutral-500">{children}</p>
    </div>
  );
}

// ── Main Drawer ────────────────────────────────────────────────────────────────
export function OpportunityBriefDrawer({ kw, onClose, onCreatePin }: {
  kw: TrendKeyword;
  onClose: () => void;
  onCreatePin?: (keyword: string, category: string, idea?: string) => void;
}) {
  const { t: tr } = useLocale();
  // ── 1. Real intelligence from /api/opportunities ──────────────────────────
  const { data: oppsResp, isLoading: oppsLoading } = useSWR(
    ["api-opportunities-drawer"],
    () => fetch("/api/opportunities?limit=100").then(r => r.json()) as Promise<{ data?: OpportunityRecord[] }>,
    { revalidateOnFocus: false },
  );

  const apiRecord = (oppsResp?.data ?? []).find(
    r => r.keyword.toLowerCase() === kw.keyword.toLowerCase(),
  ) ?? null;

  // Derived scores — real when available, fallback otherwise
  const realScore   = (apiRecord?.opportunity_score != null) ? apiRecord.opportunity_score : null;
  const mockScore   = mockKeywordScore(kw.weekly_change, kw.yearly_change, kw.priority_score);
  const score       = realScore ?? mockScore;
  const hasRealData = apiRecord !== null;

  // ── 2. Full brief (content / ideas / product opps from mocks) ────────────
  const brief  = buildOpportunityBrief(kw.keyword, kw.category, kw.weekly_change, kw.yearly_change, kw.priority_score);
  const stageS = stageBadgeStyle(brief.trendStage);

  // ── 3. Linked pins from Supabase ─────────────────────────────────────────
  const { data: pins, isLoading: pinsLoading } = useSWR(
    ["brief-pins", kw.id],
    async () => {
      const { data } = await supabase
        .from("pin_samples")
        .select("id,image_url,category,title,save_count,save_velocity,pin_id,outbound_link,days_since_creation")
        .eq("trend_keyword_id", kw.id)
        .order("save_count", { ascending: false })
        .limit(6);
      return (data ?? []) as PinRow[];
    },
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const tierLabel = (kw as { score_tier?: string }).score_tier === "high" ? "Best Bet" : (kw as { score_tier?: string }).score_tier === "medium" ? "Steady" : "Steady";
  const trendLabel = (kw.yearly_change ?? 0) >= 50 ? "Rising" : "Evergreen";
  const evidence = (kw as { total_source_saves?: number }).total_source_saves != null && ((kw as { total_source_saves?: number }).total_source_saves ?? 0) >= 50000
    ? "High demand · Less crowded · Strong save signal"
    : "Steady demand · Consistent save signal";
  const createPinUrl = (idea?: string) => {
    const base = `/app/studio?source=workspace&keyword=${encodeURIComponent(kw.keyword)}&category=${encodeURIComponent(kw.category)}&sourceType=keyword&primaryLabel=${encodeURIComponent(tierLabel)}&trendState=${encodeURIComponent(trendLabel)}&evidenceSentence=${encodeURIComponent(evidence)}`;
    return idea ? `${base}&idea=${encodeURIComponent(idea)}` : base;
  };

  // Stat grid — prefer real API fields, fallback to kw fields
  const statsGrid = [
    {
      label: tr("opportunity.brief.statWeeklyDelta"),
      value: fmtPct(kw.weekly_change),
      color: kw.weekly_change >= 0 ? "#4ade80" : "#f87171",
      isReal: false,
    },
    {
      label: tr("opportunity.brief.statYoyDelta"),
      value: apiRecord ? fmtPct(apiRecord.pct_growth_yoy ?? kw.yearly_change) : fmtPct(kw.yearly_change),
      color: (apiRecord?.pct_growth_yoy ?? kw.yearly_change) >= 0 ? "#00F2FE" : "#f87171",
      isReal: !!apiRecord,
    },
    {
      label: tr("opportunity.brief.statTotalSaves"),
      value: apiRecord ? fmt(apiRecord.total_source_saves) : String(kw.priority_score),
      color: "#A78BFA",
      isReal: !!apiRecord,
    },
    {
      label: apiRecord ? tr("opportunity.brief.statSaveVelocity") : tr("opportunity.brief.statVolume"),
      value: apiRecord ? `${fmt(apiRecord.avg_velocity_score)}/d` : (kw.search_volume_level ?? "High"),
      color: "#FBBF24",
      isReal: !!apiRecord,
    },
  ];

  return (
    <>
      <div className="fixed inset-0 bg-black/65 backdrop-blur-[2px] z-40" onClick={onClose} />
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col overflow-hidden"
        style={{ width: "min(580px, 100vw)", background: "#0C1110", borderLeft: "1px solid rgba(255,255,255,0.08)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Fixed header ── */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 shrink-0 border-b border-white/[0.06]">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#00F2FE]">{tr("opportunity.brief.eyebrow")}</p>
              {hasRealData && (
                <span className="rounded-full px-2 py-0.5 text-[9px] font-black"
                  style={{ background: "rgba(74,222,128,0.12)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.25)" }}>
                  {tr("opportunity.brief.scoredBadge")}
                </span>
              )}
            </div>
            <h2 className="text-[16px] font-black text-white capitalize leading-snug">{kw.keyword}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-neutral-500 hover:text-white hover:bg-white/[0.06] transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Loading state ── */}
          {oppsLoading && (
            <div className="px-6 pt-5 pb-4">
              <div className="rounded-2xl animate-pulse" style={{ background: "#161A18", height: 140 }} />
            </div>
          )}

          {/* ── No scored opportunity notice ── */}
          {!oppsLoading && !hasRealData && (
            <div className="mx-6 mt-5 rounded-xl px-4 py-3 flex items-start gap-3"
              style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.2)" }}>
              <AlertCircle className="h-4 w-4 text-[#FBBF24] shrink-0 mt-0.5" />
              <div>
                <p className="text-[11px] font-bold text-[#FBBF24]">{tr("opportunity.brief.notAvailableTitle")}</p>
                <p className="text-[10px] text-neutral-500 mt-0.5">
                  {tr("opportunity.brief.notAvailableBody")}
                </p>
              </div>
            </div>
          )}

          {/* ── 1. Keyword Summary ── */}
          {!oppsLoading && (
            <div className="px-6 pt-5 pb-4 border-b border-white/[0.05]">
              <div className="flex items-start gap-5 mb-4">
                <ScoreBadge score={score} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="text-[10px] font-semibold text-neutral-400 capitalize">{kw.category}</span>
                    <span className="rounded-full px-2.5 py-0.5 text-[10px] font-black" style={{ background: stageS.bg, color: stageS.color, border: `1px solid ${stageS.border}` }}>
                      {brief.trendStage}
                    </span>
                    {hasRealData && (
                      <span className="text-[9px] text-neutral-600">
                        {fmt(apiRecord!.linked_pins_count)} {tr("opportunity.brief.pinsSeparatorProducts")} · {fmt(apiRecord!.linked_products_count)} {tr("opportunity.brief.productsLabel")}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {statsGrid.map(s => (
                      <div key={s.label} className="rounded-xl p-2.5" style={{ background: "#161A18", border: "1px solid rgba(255,255,255,0.05)" }}>
                        <div className="flex items-center gap-1">
                          <p className="text-[9px] text-neutral-600 uppercase tracking-widest">{s.label}</p>
                          {s.isReal && <span className="text-[7px] text-[#4ade80] font-black">●</span>}
                        </div>
                        <p className="text-[13px] font-black mt-0.5" style={{ color: s.color }}>{s.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold" style={{ background: "rgba(0,242,254,0.07)", color: "#00F2FE", border: "1px solid rgba(0,242,254,0.15)" }}>
                  🎯 {brief.intentType}
                </span>
                <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold" style={{ background: "rgba(167,139,250,0.07)", color: "#A78BFA", border: "1px solid rgba(167,139,250,0.15)" }}>
                  📌 {brief.contentType}
                </span>
              </div>
            </div>
          )}

          {/* ── 2. Why Rising ── */}
          <div className="px-6 py-4 border-b border-white/[0.05]">
            <SectionTitle icon={<Zap className="h-3.5 w-3.5" />}>{tr("opportunity.brief.whyRising")}</SectionTitle>
            <div className="rounded-xl px-4 py-3.5" style={{ background: "rgba(0,242,254,0.04)", border: "1px solid rgba(0,242,254,0.12)" }}>
              <p className="text-[12px] text-neutral-200 leading-relaxed">{brief.whyRising}</p>
            </div>
          </div>

          {/* ── 3. Top Viral Pins ── */}
          <div className="px-6 py-4 border-b border-white/[0.05]">
            <SectionTitle icon={<span className="text-[14px]">📌</span>}>{tr("opportunity.brief.topViralPins")}</SectionTitle>

            {pinsLoading && (
              <div className="grid grid-cols-2 gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="rounded-xl bg-white/[0.05] animate-pulse" style={{ height: 120 }} />
                ))}
              </div>
            )}

            {!pinsLoading && (pins ?? []).length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {(pins ?? []).map(pin => {
                  const saves = pin.save_count ?? 0;
                  const pinUrl  = pin.pin_id ? `https://www.pinterest.com/pin/${pin.pin_id}/` : null;
                  return (
                    <div key={pin.id} className="rounded-xl overflow-hidden group"
                      style={{ background: "#161A18", border: "1px solid rgba(255,255,255,0.07)" }}>
                      <div className="relative overflow-hidden" style={{ aspectRatio: "4/3" }}>
                        <Image src={pin.image_url} alt="" fill className="object-cover" sizes="260px" unoptimized />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/75 to-transparent" />
                        <div className="absolute bottom-2 left-2">
                          <span className="text-[9px] font-black text-white">💾 {fmt(saves)}</span>
                        </div>
                      </div>
                      <div className="px-2.5 py-2 flex items-center justify-between gap-2">
                        <p className="text-[10px] text-neutral-300 truncate leading-snug flex-1">
                          {pin.title || pin.category}
                        </p>
                        <div className="flex items-center gap-1 shrink-0">
                          {pin.outbound_link && (
                            <span className="text-[9px] text-[#4ade80]">🛒</span>
                          )}
                          <a
                            href={createPinUrl()}
                            className="rounded-full px-2 py-0.5 text-[9px] font-bold transition-all hover:opacity-80 no-underline"
                            style={{ background: "linear-gradient(135deg,#00F2FE,#4FACFE)", color: "#0A0F1A" }}
                          >
                            {tr("opportunity.brief.similar")}
                          </a>
                          {pinUrl && (
                            <a href={pinUrl} target="_blank" rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="flex items-center justify-center rounded-full w-5 h-5 no-underline"
                              style={{ background: "rgba(230,0,35,0.85)" }}>
                              <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="white">
                                <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
                              </svg>
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!pinsLoading && (pins ?? []).length === 0 && (
              <div className="rounded-xl py-6 text-center" style={{ background: "#161A18", border: "1px solid rgba(255,255,255,0.06)" }}>
                <p className="text-[11px] text-neutral-600">{tr("opportunity.brief.noLinkedPins")}</p>
              </div>
            )}

            <a href="/app/discover" className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-full py-2 text-[11px] font-bold no-underline transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "#9ca3af" }}>
              {tr("opportunity.brief.viewAllViralPins")} <ArrowRight className="h-3 w-3" />
            </a>
          </div>

          {/* ── 4. Product Opportunities ── */}
          <div className="px-6 py-4 border-b border-white/[0.05]">
            <SectionTitle icon={<ShoppingBag className="h-3.5 w-3.5" />}>{tr("opportunity.brief.productOpportunities")}</SectionTitle>
            {hasRealData && (
              <div className="rounded-xl px-3 py-2 mb-2 flex items-center gap-2"
                style={{ background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.15)" }}>
                <span className="text-[9px] font-black text-[#A78BFA]">{tr("opportunity.brief.liveBadge")}</span>
                <p className="text-[10px] text-neutral-500">{apiRecord!.linked_products_count} {tr("opportunity.brief.productsLinkedSuffix")}</p>
              </div>
            )}
            <div className="space-y-2">
              {brief.productOpportunities.map((p: (typeof brief.productOpportunities)[number]) => (
                  <div key={p.id} className="rounded-xl p-3.5" style={{ background: "#161A18", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <div className="flex items-start justify-between gap-3 mb-1.5">
                      <p className="text-[12px] font-bold text-neutral-100">{p.productType}</p>
                      <ScorePill score={p.productScore} />
                    </div>
                    <p className="text-[10px] text-neutral-500 mb-1.5">{p.platform}</p>
                    <p className="text-[10px] text-neutral-300 leading-snug">{p.commercialAngle}</p>
                    <div className="flex items-center gap-1 mt-2">
                      <span className="text-[9px] text-neutral-600 uppercase tracking-widest">{tr("opportunity.brief.signalLabel")}</span>
                      <span className="text-[9px] text-neutral-500">{p.sourceSignal}</span>
                    </div>
                  </div>
              ))}
            </div>
            <a href="/app/products" className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-full py-2 text-[11px] font-bold no-underline transition-all hover:opacity-80" style={{ background: "rgba(167,139,250,0.07)", border: "1px solid rgba(167,139,250,0.15)", color: "#A78BFA" }}>
              {tr("opportunity.brief.shopSignals")} <ArrowRight className="h-3 w-3" />
            </a>
          </div>

          {/* ── 5. Content Ideas ── */}
          <div className="px-6 py-4 pb-28">
            <SectionTitle icon={<Lightbulb className="h-3.5 w-3.5" />}>{tr("opportunity.brief.recommendedContentIdeas")}</SectionTitle>
            <div className="space-y-2">
              {brief.contentIdeas.map((idea: string, i: number) => (
                <div key={i} className="flex items-center gap-3 rounded-xl px-3.5 py-3 group"
                  style={{ background: "#161A18", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <span className="text-[10px] text-neutral-600 shrink-0 w-4">#{i + 1}</span>
                  <p className="text-[12px] text-neutral-200 flex-1 leading-snug">{idea}</p>
                  <a
                    href={createPinUrl(idea)}
                    className="rounded-full px-2.5 py-1 text-[10px] font-bold no-underline transition-all hover:scale-105 shrink-0 opacity-0 group-hover:opacity-100"
                    style={{ background: "linear-gradient(135deg,#00F2FE,#4FACFE)", color: "#0A0F1A" }}
                  >
                    {tr("opportunity.brief.useIdea")}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Fixed bottom CTA ── */}
        <div className="shrink-0 px-6 py-4 border-t border-white/[0.07]" style={{ background: "#0C1110" }}>
          <div className="flex gap-2">
            <a
              href={createPinUrl()}
              className="flex-1 flex items-center justify-center gap-2 rounded-full py-3 text-[12px] font-bold no-underline transition-all hover:scale-[1.02]"
              style={{ background: "linear-gradient(90deg,#00F2FE,#4FACFE)", color: "#0A0F1A", boxShadow: "0 0 16px rgba(0,242,254,0.2)" }}
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              {tr("opportunity.brief.createPinFromOpportunity")}
            </a>
            <a
              href="/app/discover"
              className="flex items-center justify-center gap-2 rounded-full px-4 py-3 text-[12px] font-bold no-underline transition-all hover:opacity-80"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#9ca3af" }}
            >
              <span className="text-base leading-none">📌</span>
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
