"use client";
import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import useSWR from "swr";
import {
  Sparkles, Send, Clock, CheckCircle2,
  ChevronDown, Zap, LayoutGrid,
  AlertCircle, BarChart2, Compass, ShoppingBag, X,
  Upload, Link2, ImagePlus, Settings,
  PenLine, ArrowRight,
} from "lucide-react";
import { ManualPublishActions } from "@/components/ManualPublishActions";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { TIER_META, workspaceTierToPrimaryBadge, PRIMARY_BADGE_META, TREND_CHIP_META, getTrendStateChip, type WorkspaceTier } from "@/lib/workspaceStatics";
import {
  saveDraft, loadDraft, clearDraft,
  addHistory, loadHistory, mergeHistoryEntries,
  fetchGenerationsFromDb,
  createRunningSessionInDb, updateSessionInDb,
  type StudioDraft, type HistoryEntry, type GenerationStatus, type GenerationErrorType,
  type SetupSnapshot, type ProductSnapshot, type ReferenceSnapshot,
} from "@/lib/studioPersistence";
import * as pinStore      from "@/lib/pinStore";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { type ProductLedOpportunity } from "@/lib/studio/product-led-recommendations";
import { CompactProductSet } from "@/components/studio/CompactProductSet";
import { RecommendedOpportunitiesSection } from "@/components/studio/RecommendedOpportunitiesSection";
import { SelectedOpportunitySummary } from "@/components/studio/SelectedOpportunitySummary";
import { StyleReferencePicker } from "@/components/studio/StyleReferencePicker";
import { OpportunityFirstStudio } from "@/components/studio/OpportunityFirstStudio";
import { CreateAssetPicker } from "@/components/studio/CreateAssetPicker";
import * as assetStore from "@/lib/assetStore";

type PlanPin     = { id: string; image_url: string; save_count: number; source_keyword?: string | null };
type PlanProduct = { id: string; product_name: string; image_url: string | null; domain: string | null; price: number | null };
type GeneratedGroup = { refUrl: string | null; images: string[]; visualFormat?: string; humanPresence?: string };

// ── Image URL proxy helper ─────────────────────────────────────────────────────
// Converts direct Supabase Storage public URLs to the server-side proxy so images
// load regardless of whether the "generated" bucket has public access enabled.
// Safe to call on any URL — non-matching URLs pass through unchanged.
function toProxyUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("/") || url.startsWith("data:") || url.startsWith("blob:")) return url;
  const MARKER = "/storage/v1/object/public/generated/studio/";
  const idx = url.indexOf(MARKER);
  if (idx !== -1) {
    const filename = url.slice(idx + MARKER.length);
    return `/api/storage-image?path=studio/${filename}`;
  }
  return url;
}

type BatchOpState = {
  generatedGroups:  GeneratedGroup[];
  customStyleRef:   string | null;
  selectedPlanRefs: string[];
  myProductImages:  string[];
  myProductUrl:     string;
  myProductName:    string;
  tier:             string;
};

const STYLE_PRESETS = [
  { id: "editorial", label: "Editorial Minimal", desc: "Clean white space, product hero" },
  { id: "lifestyle", label: "Lifestyle Warm",    desc: "Golden hour, real-life context"  },
  { id: "moody",     label: "Moody Aesthetic",   desc: "Dark tones, dramatic shadows"    },
  { id: "flat-lay",  label: "Flat Lay",          desc: "Top-down product arrangement"    },
  { id: "boho",      label: "Boho Natural",      desc: "Earthy, woven textures, plants"  },
  { id: "luxury",    label: "Quiet Luxury",      desc: "Muted palette, premium feel"     },
];

const MOCK_QUEUE  = [
  { keyword: "Boho Living Room",   board: "Home Decor Inspo", time: "Today 9:00 AM", done: true  },
  { keyword: "Japandi Interiors",  board: "Minimal Home",     time: "Wed 2:00 PM",   done: false },
  { keyword: "Coastal Minimalism", board: "Summer Vibes",     time: "Thu 11:00 AM",  done: false },
];
const MOCK_BOARDS = [
  { id: "board-home-decor", name: "Home Decor Inspiration" },
  { id: "board-aesthetic",  name: "Aesthetic Living Room"  },
  { id: "board-minimal",    name: "Minimal Home Ideas"     },
  { id: "board-gifts",      name: "Gift Ideas 2026"        },
  { id: "board-lifestyle",  name: "Lifestyle & Mood"       },
];

const MAX_PROMPT_LEN = 1200;

function getNextAvailableSlot(): Date {
  const now = new Date();
  for (const h of [9, 14, 18]) { const d = new Date(now); d.setHours(h,0,0,0); if (d>now) return d; }
  const t = new Date(now); t.setDate(t.getDate()+1); t.setHours(9,0,0,0); return t;
}
function getTomorrowMorning(): Date {
  const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0); return d;
}
function formatSlotLabel(date: Date): string {
  const now = new Date();
  const isToday    = date.toDateString() === now.toDateString();
  const isTomorrow = date.toDateString() === new Date(now.getTime()+86400000).toDateString();
  const time = date.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});
  if (isToday)    return `Today, ${time}`;
  if (isTomorrow) return `Tomorrow, ${time}`;
  return `${date.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}, ${time}`;
}

// ── Trend chip helper ─────────────────────────────────────────────────────────
function getTrendChip(tier: string): { label: string; color: string; bg: string } {
  if (tier === "blue_ocean")  return { label: "Evergreen",    color: "#0284C7", bg: "rgba(2,132,199,0.1)"   };
  if (tier === "hot_red_sea") return { label: "Competitive",  color: "#D97706", bg: "rgba(217,119,6,0.1)"   };
  if (tier === "early_trend") return { label: "Rising trend", color: "#059669", bg: "rgba(5,150,105,0.1)"   };
  return                             { label: "Rising trend", color: "#059669", bg: "rgba(5,150,105,0.1)"   };
}

type OpportunityRecord = {
  keyword_id: string; keyword: string; category: string;
  pct_growth_yoy: number; search_volume_level: string | null;
  linked_pins_count: number; linked_products_count: number; total_source_saves: number;
  avg_velocity_score: number; opportunity_score: number;
};
function fmtNum(n: number|null|undefined): string {
  if (n==null) return "—";
  if (n>=1_000_000) return (n/1_000_000).toFixed(1)+"M";
  if (n>=1_000)     return (n/1_000).toFixed(1)+"K";
  return String(n);
}
function fmtPct(n: number): string {
  const a=Math.abs(n); const s=n>=0?"+":"-";
  return a>=1000?`${s}${(a/1000).toFixed(1)}K%`:`${s}${a.toFixed(0)}%`;
}

// ── Product Briefing Panel ────────────────────────────────────────────────────
// Shown on the left when entering from Product Signals with no keyword selected yet.
// Recommends matching opportunities and reference pins based on the loaded products.
function ProductBriefingPanel({
  productNames, seedKeywords,
  onSelectOpportunity, onSelectReference,
}: {
  productNames:  string[];
  seedKeywords:  string[];
  onSelectOpportunity: (kw: string, cat: string) => void;
  onSelectReference:   (url: string) => void;
}) {
  const [opps,    setOpps]    = useState<{id:string;keyword:string;category:string;yearly_change:number|null}[]>([]);
  const [refs,    setRefs]    = useState<{id:string;image_url:string;save_count:number;source_keyword:string|null}[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Build search terms from product names + seed keywords
    const terms = [...new Set([...seedKeywords, ...productNames])].slice(0, 6);

    Promise.all([
      // Opportunities: trend_keywords ordered by priority
      supabase.from("trend_keywords")
        .select("id,keyword,category,yearly_change,priority_score")
        .eq("status","active")
        .not("yearly_change","is",null)
        .order("priority_score",{ascending:false})
        .limit(40)
        .then(({data}) => {
          if (!data?.length) return [];
          // Score: prefer keywords that share words with products
          const termWords = terms.flatMap(t => t.toLowerCase().split(/\s+/));
          const scored = data.map(row => {
            const kw = row.keyword.toLowerCase();
            const hits = termWords.filter(w => w.length > 3 && kw.includes(w)).length;
            return { ...row, hits };
          });
          // Return top matches first, then fill with high-priority items
          return [
            ...scored.filter(r => r.hits > 0).sort((a,b) => b.hits - a.hits),
            ...scored.filter(r => r.hits === 0),
          ].slice(0, 12);
        }),

      // Reference pins: pin_samples for relevant keywords
      supabase.from("pin_samples")
        .select("id,image_url,save_count,source_keyword")
        .not("image_url","is",null)
        .order("save_count",{ascending:false})
        .limit(50)
        .then(({data}) => {
          if (!data?.length) return [];
          const termWords = terms.flatMap(t => t.toLowerCase().split(/\s+/));
          // Prefer pins whose source_keyword overlaps with product terms
          const scored = (data as {id:string;image_url:string;save_count:number;source_keyword:string|null}[]).map(p => {
            const kw = (p.source_keyword ?? "").toLowerCase();
            const hits = termWords.filter(w => w.length > 3 && kw.includes(w)).length;
            return { ...p, hits };
          });
          const sorted = [
            ...scored.filter(r => r.hits > 0).sort((a,b) => b.hits - a.hits),
            ...scored.filter(r => r.hits === 0),
          ];
          return sorted.slice(0, 8);
        }),
    ]).then(([oppData, pinData]) => {
      setOpps(oppData as typeof opps);
      setRefs(pinData as typeof refs);
      setLoading(false);
    }).catch(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKeywords.join(","), productNames.join(",")]);

  function fmt(n: number) { return n >= 1000 ? `${(n/1000).toFixed(0)}K` : String(n); }

  return (
    <aside className="shrink-0 flex flex-col overflow-hidden" style={{width:260,borderRight:"1px solid #E5E7EB",background:"#fff"}}>
      <div style={{padding:"14px 16px 8px",borderBottom:"1px solid #F1F5F9",flexShrink:0}}>
        <p style={{margin:0,fontSize:"12px",fontWeight:800,color:"#0F172A"}}>Choose a direction</p>
        <p style={{margin:"3px 0 0",fontSize:"10px",color:"#94A3B8"}}>Select an opportunity or reference to guide your pins.</p>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"12px 14px",display:"flex",flexDirection:"column",gap:16}}>
        {loading ? (
          <>
            {[1,2,3,4].map(i=><div key={i} style={{height:36,borderRadius:8,background:"#F1F5F9",animation:"pulse 1.5s ease-in-out infinite"}}/>)}
          </>
        ) : (<>

          {/* Opportunities */}
          {opps.length > 0 && (
            <div>
              <p style={{margin:"0 0 8px",fontSize:"10px",fontWeight:700,color:"#374151",textTransform:"uppercase",letterSpacing:"0.07em"}}>Matching Opportunities</p>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {opps.slice(0,8).map(opp => (
                  <button key={opp.id} type="button"
                    onClick={() => onSelectOpportunity(opp.keyword, opp.category)}
                    style={{
                      width:"100%",textAlign:"left",padding:"7px 10px",borderRadius:8,
                      border:"1px solid #F1F5F9",background:"#FAFAFA",cursor:"pointer",
                      display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background="#F3E8FF"; (e.currentTarget as HTMLButtonElement).style.borderColor="rgba(192,38,211,0.3)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background="#FAFAFA"; (e.currentTarget as HTMLButtonElement).style.borderColor="#F1F5F9"; }}
                  >
                    <span style={{fontSize:"11px",fontWeight:600,color:"#0F172A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textTransform:"capitalize"}}>{opp.keyword}</span>
                    {opp.yearly_change != null && (
                      <span style={{fontSize:"9px",fontWeight:700,color:"#059669",whiteSpace:"nowrap",flexShrink:0}}>
                        +{opp.yearly_change >= 1000 ? `${(opp.yearly_change/1000).toFixed(0)}K` : opp.yearly_change}%
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Reference pins */}
          {refs.length > 0 && (
            <div>
              <p style={{margin:"0 0 8px",fontSize:"10px",fontWeight:700,color:"#374151",textTransform:"uppercase",letterSpacing:"0.07em"}}>Style References</p>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:5}}>
                {refs.map(pin => (
                  <button key={pin.id} type="button"
                    onClick={() => onSelectReference(pin.image_url)}
                    style={{padding:0,border:"2px solid transparent",borderRadius:8,overflow:"hidden",cursor:"pointer",background:"#F1F5F9",aspectRatio:"2/3",display:"block"}}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor="#C026D3"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor="transparent"; }}
                    title={`${fmt(pin.save_count)} saves · ${pin.source_keyword ?? ""}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pin.image_url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}
                      onError={e=>{(e.currentTarget.parentElement as HTMLButtonElement).style.display="none";}}/>
                  </button>
                ))}
              </div>
              <p style={{margin:"6px 0 0",fontSize:"9px",color:"#CBD5E1"}}>Click a reference to use its style</p>
            </div>
          )}
        </>)}
      </div>
    </aside>
  );
}

// ── Signal brief sidebar ──────────────────────────────────────────────────────
function TrendPanel({ keyword,category,pinId,productId,sourceType,yoyFromUrl,savesFromUrl,fromPlan,fromWorkspace,fromDigitalIdea,titleHook,planTier,styleRef,productAdded,marketAngleAbsorbed }: {
  keyword:string; category:string; pinId:string; productId:string; sourceType:string;
  idea?:string; yoyFromUrl?:number|null; savesFromUrl?:number|null;
  fromPlan?:boolean; fromWorkspace?:boolean; fromDigitalIdea?:boolean; titleHook?:string; planTier?:string;
  styleRef?:string|null; productAdded?:boolean; marketAngleAbsorbed?:boolean;
}) {
  const {data:oppsResp,isLoading:oppsLoading} = useSWR(
    keyword?["studio-opportunities"]:null,
    ()=>fetch("/api/opportunities?limit=100").then(r=>r.json()) as Promise<{data?:OpportunityRecord[]}>,
    {revalidateOnFocus:false},
  );
  const apiRecord = (oppsResp?.data??[]).find(r=>r.keyword.toLowerCase()===keyword.toLowerCase())??null;
  const tierMeta  = planTier ? TIER_META[planTier as WorkspaceTier] : null; // kept for export/CSV compat
  const primaryBadge = planTier ? workspaceTierToPrimaryBadge(planTier as WorkspaceTier) : null;
  const bMeta        = primaryBadge ? PRIMARY_BADGE_META[primaryBadge] : null;
  const chipKey      = apiRecord
    ? getTrendStateChip({ pct_growth_yoy: apiRecord.pct_growth_yoy, weekly_change: null, trend_lifecycle: null })
    : planTier ? getTrendStateChip({ pct_growth_yoy: yoyFromUrl ?? null, weekly_change: null, trend_lifecycle: null })
    : null;
  const cMeta = chipKey ? TREND_CHIP_META[chipKey] : null;
  const metrics   = apiRecord ? [
    {label:"YoY Growth",     value:fmtPct(apiRecord.pct_growth_yoy)},
    {label:"Total Saves",    value:fmtNum(apiRecord.total_source_saves)},
    {label:"Linked Pins",    value:fmtNum(apiRecord.linked_pins_count)},
    {label:"Linked Products",value:fmtNum(apiRecord.linked_products_count)},
  ] : [
    {label:"YoY Growth",     value:yoyFromUrl !=null?fmtPct(yoyFromUrl) :"—"},
    {label:"Total Saves",    value:savesFromUrl!=null?fmtNum(savesFromUrl):"—"},
    {label:"Linked Pins",    value:"—"},
    {label:"Linked Products",value:"—"},
  ];
  void pinId; void productId; void sourceType;

  if (!keyword) return (
    <aside className="w-60 shrink-0 flex flex-col bg-white" style={{borderRight:"1px solid #E5E7EB"}}>
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-10 text-center">
        <Zap className="h-6 w-6 text-gray-300 mb-2"/>
        <p className="text-[11px] text-gray-500">No signal selected</p>
      </div>
    </aside>
  );

  return (
    <aside className="w-60 shrink-0 flex flex-col overflow-y-auto bg-white min-h-0" style={{borderRight:"1px solid #E5E7EB"}}>
      <div className="p-4 flex flex-col gap-3">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Signal Brief</p>
            {bMeta && (
              <div className="flex items-center gap-1">
                <span className="text-[8px] font-black px-1.5 py-0.5 rounded" style={{background:bMeta.bg,color:bMeta.color,border:`1px solid ${bMeta.color}33`}}>{bMeta.label}</span>
                {cMeta && chipKey && <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded-full" style={{background:`${cMeta.color}12`,color:cMeta.color}}>{chipKey==="rising"?"↑ ":chipKey==="seasonal"?"◎ ":"∞ "}{cMeta.label}</span>}
              </div>
            )}
          </div>
          <p className="text-[14px] font-black text-gray-900 capitalize leading-snug">{keyword}</p>
          <p className="text-[10px] text-gray-500 capitalize mt-0.5">
            {(() => { const t=sourceType==="product"?"Product signal":sourceType==="pin"?"Viral pin":fromDigitalIdea?"Digital idea":fromPlan?"Weekly Plan":"Keyword"; return category?`${category} · ${t}`:t; })()}
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Metrics</p>
            {!oppsLoading && apiRecord && <span className="text-[8px] font-black rounded-full px-1.5 py-0.5" style={{background:"rgba(16,185,129,0.10)",color:"#10B981",border:"1px solid rgba(16,185,129,0.2)"}}>● Live</span>}
          </div>
          {oppsLoading ? <div className="grid grid-cols-2 gap-1.5">{Array.from({length:4}).map((_,i)=><div key={i} className="h-11 rounded-lg bg-gray-100 animate-pulse"/>)}</div> : (
            <div className="grid grid-cols-2 gap-1.5">
              {metrics.map(m=>(
                <div key={m.label} className="rounded-lg p-2 bg-gray-50 border border-gray-100">
                  <p className="text-[8px] text-gray-400 uppercase tracking-widest leading-tight mb-0.5">{m.label}</p>
                  <p className="text-[12px] font-black text-gray-900">{m.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        {fromPlan && titleHook && (
          <div className="rounded-lg p-2.5" style={{background:"rgba(8,145,178,0.06)",border:"1px solid rgba(8,145,178,0.18)"}}>
            <p className="text-[9px] font-black uppercase tracking-widest text-[#C026D3] mb-1">Plan Brief</p>
            <p className="text-[11px] text-gray-800 font-semibold italic leading-snug">&quot;{titleHook}&quot;</p>
          </div>
        )}
        <div className="rounded-lg p-2.5 bg-gray-50 border border-gray-100">
          <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1.5">Readiness</p>
          <div className="space-y-1">
            {[
              {ok:!!(fromPlan||fromWorkspace), label:fromDigitalIdea?"Digital idea loaded":fromPlan?"Weekly brief loaded":fromWorkspace?"Opportunity loaded":"Brief loaded"},
              {ok:!!styleRef,     label:"Inspiration applied"},
              {ok:true,           label:"Recommended style set"},
              {ok:!!(productAdded||marketAngleAbsorbed), label:marketAngleAbsorbed?"Market angle absorbed":productAdded?"Products added":"Products (optional)"},
            ].map((r,i)=>(
              <div key={i} className="flex items-center gap-1.5">
                <span className="text-[9px] font-black w-3 shrink-0" style={{color:r.ok?"#10B981":"#D1D5DB"}}>{r.ok?"✓":"○"}</span>
                <span className="text-[11px]" style={{color:r.ok?"#374151":"#9CA3AF"}}>{r.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function NoKeywordState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-10 py-16 gap-8">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl mb-5" style={{background:"rgba(192,38,211,0.08)",border:"1px solid rgba(8,145,178,0.18)"}}>
          <Sparkles className="h-6 w-6 text-[#C026D3]"/>
        </div>
        <h2 className="text-[18px] font-black text-gray-900 mb-2">Start with a Signal</h2>
        <p className="text-[13px] text-gray-500 leading-relaxed">Every great Pinterest pin starts with a trend or a viral reference.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-xl">
        <a href="/app/trends" className="group rounded-2xl p-5 flex flex-col gap-3 no-underline bg-white border border-gray-200 hover:border-[#C026D3]/30 hover:shadow-sm transition-all hover:scale-[1.02]">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0" style={{background:"rgba(192,38,211,0.08)"}}><BarChart2 className="h-4 w-4 text-[#C026D3]"/></div>
            <div><p className="text-[13px] font-black text-gray-900">Trend Radar</p><p className="text-[10px] text-gray-500">Keyword data</p></div>
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">Browse trending keywords with growth data. Click &quot;Create Pin&quot; on any to auto-fill.</p>
        </a>
        <a href="/app/discover" className="group rounded-2xl p-5 flex flex-col gap-3 no-underline bg-white border border-gray-200 hover:border-amber-200 hover:shadow-sm transition-all hover:scale-[1.02]">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0" style={{background:"rgba(245,158,11,0.08)"}}><Compass className="h-4 w-4 text-[#F59E0B]"/></div>
            <div><p className="text-[13px] font-black text-gray-900">Viral Pins</p><p className="text-[10px] text-gray-500">Top-save pins</p></div>
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">Find pins with 10K+ saves and use their aesthetic as a creative brief.</p>
        </a>
      </div>
    </div>
  );
}

// ── Empty Studio State ────────────────────────────────────────────────────────
function EmptyStudioState({
  onSelectSource, onOpenHistory, historyCount,
}: {
  onSelectSource: (kw: string, cat: string, src: "plan"|"workspace"|"pin", pinUrl?: string) => void;
  onOpenHistory: () => void;
  historyCount: number;
}) {
  const router = useRouter();
  const [trends, setTrends] = useState<{id:string;keyword:string;category:string;yearly_change:number|null}[]>([]);
  const [viral,  setViral]  = useState<{id:string;image_url:string;save_count:number;source_keyword:string|null}[]>([]);
  const [showBlankForm, setShowBlankForm] = useState(false);
  const [blankKw,  setBlankKw]  = useState("");
  const [blankCat, setBlankCat] = useState("home-decor");

  useEffect(()=>{
    supabase.from("trend_keywords").select("id,keyword,category,yearly_change,priority_score")
      .eq("status","active").not("yearly_change","is",null)
      .order("priority_score",{ascending:false}).limit(6)
      .then(({data})=>{ if(data?.length) setTrends(data as typeof trends); });
    supabase.from("pin_samples").select("id,image_url,save_count,source_keyword")
      .not("image_url","is",null).order("save_count",{ascending:false}).limit(3)
      .then(({data})=>{ if(data?.length) setViral(data as typeof viral); });
  },[]);

  const planItems  = trends.slice(0,3);
  const radarItems = trends.slice(3,6);

  function fmt(n:number){ return n>=1000?`${(n/1000).toFixed(1)}K`:String(n); }
  function fmtG(n:number|null){ return n?`+${n}%`:""; }
  function tierFromChange(n:number|null){
    if(!n) return null;
    if(n>=100) return "early_trend";
    if(n>=50)  return "growing";
    return "steady";
  }
  function Sparkline(){ return (
    <svg width="44" height="22" viewBox="0 0 44 22" fill="none" style={{flexShrink:0}}>
      <path d="M2 20 Q12 15 22 10 Q32 5 42 2" stroke="#3B82F6" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
    </svg>
  );}

  return (
    <div style={{display:"flex",flex:1,overflow:"hidden",background:"#F7F8FA",minHeight:0}}>

      {/* ── LEFT PANEL ─────────────────────────────────────────────────────── */}
      <aside style={{width:270,flexShrink:0,background:"#fff",borderRight:"1px solid #E5E7EB",display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"18px 18px 10px",borderBottom:"1px solid #F1F5F9",flexShrink:0}}>
          <p style={{margin:0,fontSize:"14px",fontWeight:800,color:"#0F172A"}}>Start from an Opportunity</p>
          <p style={{margin:"4px 0 0",fontSize:"11px",color:"#94A3B8",lineHeight:1.5}}>Pick a trend or plan item to auto-fill your creative brief.</p>
        </div>

        <div style={{flex:1,overflowY:"auto",padding:"12px 14px",display:"flex",flexDirection:"column",gap:16}}>
          {/* Weekly Plan */}
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:"11px",fontWeight:700,color:"#374151"}}>From Weekly Plan</span>
              <a href="/app/plan" style={{fontSize:"10px",color:"#7C3AED",fontWeight:600,textDecoration:"none"}}>View all</a>
            </div>
            {planItems.length>0 ? planItems.map(item=>{
              const chip = getTrendChip(tierFromChange(item.yearly_change)??"steady");
              return (
                <button key={item.id} type="button"
                  onClick={()=>onSelectSource(item.keyword,item.category,"workspace")}
                  style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 8px",borderRadius:8,border:"1px solid #F1F5F9",background:"#FAFAFA",cursor:"pointer",marginBottom:4,textAlign:"left"}}>
                  <span style={{fontSize:"11px",fontWeight:600,color:"#0F172A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,textTransform:"capitalize"}}>{item.keyword}</span>
                  <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0,marginLeft:6}}>
                    {chip&&<span style={{fontSize:"8px",fontWeight:700,color:chip.color,background:chip.bg,padding:"1px 5px",borderRadius:3,whiteSpace:"nowrap"}}>{chip.label}</span>}
                    <span style={{fontSize:"10px",fontWeight:700,color:"#059669",whiteSpace:"nowrap"}}>{fmtG(item.yearly_change)}</span>
                  </div>
                </button>
              );
            }) : [1,2,3].map(i=>(
              <div key={i} style={{height:34,borderRadius:8,background:"#F1F5F9",marginBottom:4,animation:"pulse 1.5s ease-in-out infinite"}}/>
            ))}
          </div>

          {/* Trend Radar */}
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:"11px",fontWeight:700,color:"#374151"}}>From Trend Radar</span>
              <a href="/app/workspace/home-decor" style={{fontSize:"10px",color:"#7C3AED",fontWeight:600,textDecoration:"none"}}>View all</a>
            </div>
            {radarItems.length>0 ? radarItems.map(item=>(
              <button key={item.id} type="button"
                onClick={()=>onSelectSource(item.keyword,item.category,"workspace")}
                style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 8px",borderRadius:8,border:"1px solid #F1F5F9",background:"#FAFAFA",cursor:"pointer",marginBottom:4,textAlign:"left",gap:8}}>
                <div style={{flex:1,minWidth:0}}>
                  <p style={{margin:0,fontSize:"11px",fontWeight:600,color:"#0F172A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textTransform:"capitalize"}}>{item.keyword}</p>
                  <p style={{margin:"1px 0 0",fontSize:"9px",color:"#64748B"}}>YOY {fmtG(item.yearly_change)}</p>
                </div>
                <Sparkline/>
              </button>
            )) : [1,2,3].map(i=>(
              <div key={i} style={{height:34,borderRadius:8,background:"#F1F5F9",marginBottom:4}}/>
            ))}
          </div>

          {/* Viral Pins */}
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:"11px",fontWeight:700,color:"#374151"}}>From Viral Pins</span>
              <a href="/app/viral-pins" style={{fontSize:"10px",color:"#7C3AED",fontWeight:600,textDecoration:"none"}}>View all</a>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
              {viral.length>0 ? viral.map(pin=>(
                <button key={pin.id} type="button"
                  onClick={()=>onSelectSource(pin.source_keyword||"aesthetic","home-decor","pin",pin.image_url)}
                  style={{borderRadius:8,overflow:"hidden",border:"1px solid #E5E7EB",background:"#F1F5F9",cursor:"pointer",padding:0,display:"flex",flexDirection:"column"}}>
                  <div style={{aspectRatio:"1/1",overflow:"hidden"}}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pin.image_url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                  </div>
                  <p style={{margin:0,fontSize:"9px",fontWeight:600,color:"#64748B",textAlign:"center",padding:"3px 2px"}}>{fmt(pin.save_count)} saves</p>
                </button>
              )) : [1,2,3].map(i=>(
                <div key={i} style={{aspectRatio:"1/1",borderRadius:8,background:"#F1F5F9"}}/>
              ))}
            </div>
          </div>
        </div>

        <div style={{padding:"12px 14px",borderTop:"1px solid #F1F5F9",flexShrink:0}}>
          <button type="button" onClick={()=>router.push("/app/workspace/home-decor")}
            style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"9px",borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",cursor:"pointer",fontSize:"11px",fontWeight:700,color:"#7C3AED"}}>
            <LayoutGrid style={{width:12,height:12}}/> Browse all sources
          </button>
        </div>
      </aside>

      {/* ── MAIN AREA ──────────────────────────────────────────────────────── */}
      <main style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",minHeight:0}}>
        {/* Header */}
        <div style={{padding:"12px 28px",borderBottom:"1px solid #F1F5F9",display:"flex",alignItems:"center",justifyContent:"space-between",background:"#fff",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <Sparkles style={{width:16,height:16,color:"#C026D3"}}/>
            <span style={{fontSize:"14px",fontWeight:800,color:"#0F172A"}}>Create Pin</span>
          </div>
          <div style={{display:"flex",gap:6}}>
            <a href="/app/history"
              style={{display:"flex",alignItems:"center",gap:5,padding:"5px 12px",fontSize:"11px",fontWeight:600,borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",color:"#64748B",textDecoration:"none"}}>
              <Clock style={{width:12,height:12}}/> History
              {historyCount>0&&<span style={{fontSize:"9px",fontWeight:800,color:"#7C3AED",background:"rgba(124,58,237,0.1)",borderRadius:10,padding:"1px 5px"}}>{historyCount}</span>}
            </a>
            <button type="button" onClick={()=>router.back()}
              style={{display:"flex",alignItems:"center",gap:5,padding:"5px 12px",fontSize:"11px",fontWeight:600,borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",color:"#64748B",cursor:"pointer"}}>
              Exit
            </button>
          </div>
        </div>

        <div style={{flex:1,padding:"40px 40px 60px",display:"flex",flexDirection:"column",alignItems:"center",gap:32,overflowY:"auto"}}>
          {!showBlankForm ? (<>
            {/* Hero */}
            <div style={{textAlign:"center",maxWidth:520}}>
              <div style={{width:64,height:64,borderRadius:20,background:"rgba(124,58,237,0.1)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
                <Sparkles style={{width:28,height:28,color:"#7C3AED"}}/>
              </div>
              <h1 style={{margin:0,fontSize:"26px",fontWeight:800,color:"#0F172A",lineHeight:1.2}}>Create your Pinterest pin</h1>
              <p style={{margin:"10px 0 0",fontSize:"14px",color:"#64748B",lineHeight:1.6}}>Start with a trend, a viral pin, or your own idea.</p>
            </div>

            {/* 3 Source cards */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,width:"100%",maxWidth:720}}>
              {[
                {icon:<BarChart2 style={{width:22,height:22,color:"#7C3AED"}}/>, iconBg:"rgba(124,58,237,0.1)", title:"From Trend Radar", sub:"Use trending keywords with growth data to generate pins.", label:"Choose trend", action:()=>router.push("/app/workspace/home-decor")},
                {icon:<Compass   style={{width:22,height:22,color:"#F59E0B"}}/>, iconBg:"rgba(245,158,11,0.1)", title:"From Viral Pins",  sub:"Use high-save pins as your style reference.",         label:"Choose pin",  action:()=>router.push("/app/viral-pins")},
                {icon:<PenLine   style={{width:22,height:22,color:"#10B981"}}/>, iconBg:"rgba(16,185,129,0.1)", title:"From Scratch",    sub:"Start with your own keyword or idea.",                 label:"Start blank", action:()=>setShowBlankForm(true)},
              ].map(card=>(
                <div key={card.title} style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:16,padding:"24px 20px",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:12}}>
                  <div style={{width:48,height:48,borderRadius:14,background:card.iconBg,display:"flex",alignItems:"center",justifyContent:"center"}}>{card.icon}</div>
                  <div>
                    <p style={{margin:0,fontSize:"14px",fontWeight:800,color:"#0F172A"}}>{card.title}</p>
                    <p style={{margin:"5px 0 0",fontSize:"12px",color:"#64748B",lineHeight:1.5}}>{card.sub}</p>
                  </div>
                  <button type="button" onClick={card.action}
                    style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"8px 16px",borderRadius:8,border:"1px solid #E5E7EB",background:"#fff",fontSize:"12px",fontWeight:700,color:"#0F172A",cursor:"pointer",marginTop:"auto",width:"100%"}}>
                    {card.label} <ArrowRight style={{width:13,height:13}}/>
                  </button>
                </div>
              ))}
            </div>

            {/* How it works */}
            <div style={{width:"100%",maxWidth:720}}>
              <p style={{margin:"0 0 16px",fontSize:"15px",fontWeight:800,color:"#0F172A"}}>How it works</p>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16}}>
                {[
                  {n:"1",t:"Choose a source",     s:"Pick a trend, a viral pin, or start from scratch."},
                  {n:"2",t:"Add references & products", s:"Select reference pins and upload product images."},
                  {n:"3",t:"Generate pins",         s:"AI creates Pinterest-style pins for you."},
                  {n:"4",t:"Download & save",       s:"Save, download, or add to your weekly plan."},
                ].map((step,i)=>(
                  <div key={i} style={{display:"flex",flexDirection:"column",gap:6}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:22,height:22,borderRadius:"50%",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                        <span style={{fontSize:"10px",fontWeight:800,color:"#fff"}}>{step.n}</span>
                      </div>
                      {i<3&&<div style={{flex:1,height:1,background:"#E5E7EB"}}/>}
                    </div>
                    <p style={{margin:0,fontSize:"12px",fontWeight:700,color:"#0F172A"}}>{step.t}</p>
                    <p style={{margin:0,fontSize:"11px",color:"#64748B",lineHeight:1.5}}>{step.s}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Tip card */}
            <div style={{width:"100%",maxWidth:720,borderRadius:12,padding:"14px 18px",background:"rgba(124,58,237,0.06)",border:"1px solid rgba(124,58,237,0.12)",display:"flex",gap:12,alignItems:"flex-start"}}>
              <div style={{width:28,height:28,borderRadius:8,background:"rgba(124,58,237,0.12)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <Zap style={{width:13,height:13,color:"#7C3AED"}}/>
              </div>
              <div>
                <p style={{margin:0,fontSize:"12px",fontWeight:700,color:"#7C3AED"}}>Tip</p>
                <p style={{margin:"3px 0 0",fontSize:"12px",color:"#4C1D95",lineHeight:1.6}}>Starting from a source helps AI understand the style and context better, so you&apos;ll get more on-brand results.</p>
              </div>
            </div>

            {/* Bottom CTA */}
            <p style={{fontSize:"13px",color:"#64748B",textAlign:"center",marginTop:4}}>
              Need inspiration?{" "}
              <a href="/app/workspace/home-decor" style={{color:"#7C3AED",fontWeight:700,textDecoration:"none"}}>Explore Trend Radar →</a>
            </p>
          </>) : (
            /* ── Blank start form ── */
            <div style={{width:"100%",maxWidth:480}}>
              <div style={{textAlign:"center",marginBottom:28}}>
                <div style={{width:48,height:48,borderRadius:14,background:"rgba(16,185,129,0.1)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px"}}>
                  <PenLine style={{width:22,height:22,color:"#10B981"}}/>
                </div>
                <h2 style={{margin:0,fontSize:"20px",fontWeight:800,color:"#0F172A"}}>Start from scratch</h2>
                <p style={{margin:"6px 0 0",fontSize:"13px",color:"#64748B"}}>Enter your keyword or idea to get started.</p>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div>
                  <label style={{display:"block",fontSize:"11px",fontWeight:700,color:"#374151",marginBottom:5}}>Keyword or idea</label>
                  <input type="text" value={blankKw} onChange={e=>setBlankKw(e.target.value)}
                    placeholder="e.g. minimalist living room, boho bedroom…"
                    onKeyDown={e=>{if(e.key==="Enter"&&blankKw.trim())onSelectSource(blankKw.trim(),blankCat,"workspace");}}
                    autoFocus
                    style={{width:"100%",padding:"10px 14px",borderRadius:10,border:"1px solid #E5E7EB",fontSize:"13px",outline:"none",boxSizing:"border-box"}}/>
                </div>
                <div>
                  <label style={{display:"block",fontSize:"11px",fontWeight:700,color:"#374151",marginBottom:5}}>Category</label>
                  <select value={blankCat} onChange={e=>setBlankCat(e.target.value)}
                    style={{width:"100%",padding:"10px 14px",borderRadius:10,border:"1px solid #E5E7EB",fontSize:"13px",outline:"none",background:"#fff",appearance:"none",boxSizing:"border-box"}}>
                    {["home-decor","fashion","beauty","food-and-drink","digital-products","diy-crafts","wedding"].map(c=>(
                      <option key={c} value={c}>{c.replace(/-/g," ").replace(/\b\w/g,l=>l.toUpperCase())}</option>
                    ))}
                  </select>
                </div>
                <div style={{display:"flex",gap:10,marginTop:4}}>
                  <button type="button" onClick={()=>setShowBlankForm(false)}
                    style={{flexShrink:0,padding:"10px 18px",borderRadius:10,border:"1px solid #E5E7EB",background:"#fff",fontSize:"13px",fontWeight:600,color:"#64748B",cursor:"pointer"}}>
                    ← Back
                  </button>
                  <button type="button" onClick={()=>{if(blankKw.trim())onSelectSource(blankKw.trim(),blankCat,"workspace");}}
                    disabled={!blankKw.trim()}
                    style={{flex:1,padding:"10px 18px",borderRadius:10,border:"none",background:blankKw.trim()?"linear-gradient(135deg,#FF4D8D,#7C3AED)":"#E5E7EB",color:blankKw.trim()?"#fff":"#9CA3AF",fontSize:"13px",fontWeight:800,cursor:blankKw.trim()?"pointer":"not-allowed",transition:"all 0.15s"}}>
                    Continue →
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ── History Preview Modal ─────────────────────────────────────────────────────
function HistoryPreviewModal({
  entry, onClose, onLoadInStudio,
}: {
  entry: HistoryEntry;
  onClose: () => void;
  onLoadInStudio: (entry: HistoryEntry) => void;
}) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  // Track plan additions locally (initialised from pinStore on open)
  const [modalPlanUrls, setModalPlanUrls] = useState<Set<string>>(() => {
    const records = pinStore.getSessionPins(entry.id);
    return new Set(records.filter(r => r.status !== "generated").map(r => r.imageUrl));
  });

  function addToPlanFromModal(urls: string[]) {
    pinStore.markPinsByImageUrls(urls);
    // Create pin drafts with copy pre-generated from session context
    for (const url of urls) {
      pinDraftStore.createDraft({
        imageUrl:            url,
        keyword:             entry.keyword,
        category:            entry.category,
        generationSessionId: entry.id,
      });
    }
    setModalPlanUrls(prev => new Set([...prev, ...urls]));
    const n = urls.length;
    toast.success(`Added ${n} pin${n !== 1 ? "s" : ""} to Weekly Plan`, {
      action: { label: "View in Weekly Plan", onClick: () => { window.location.href = "/app/plan"; } },
    });
  }

  const allPins     = entry.groups.flatMap(g => g.images);
  const addedCount  = allPins.filter(u => modalPlanUrls.has(u)).length;
  const date        = new Date(entry.savedAt);
  const dateStr     = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    + " · " + date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const title       = entry.keyword || "Generated Session";
  const isRecovered = entry.source === "storage";

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:55,background:"rgba(0,0,0,0.5)"}}/>

      {/* Modal */}
      <div style={{
        position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
        zIndex:60,width:"min(900px,96vw)",maxHeight:"90vh",
        background:"#fff",borderRadius:16,boxShadow:"0 20px 60px rgba(0,0,0,0.25)",
        display:"flex",flexDirection:"column",overflow:"hidden",
      }}>
        {/* ── Header */}
        <div style={{padding:"14px 20px",borderBottom:"1px solid #F1F5F9",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:8}}>
            <div style={{minWidth:0}}>
              <p style={{margin:0,fontSize:"15px",fontWeight:800,color:"#0F172A",textTransform:"capitalize",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{title}</p>
              <p style={{margin:"2px 0 0",fontSize:"11px",color:"#94A3B8"}}>
                {dateStr} · {allPins.length} pin{allPins.length!==1?"s":""}
                {addedCount > 0 ? ` · ${addedCount} added to plan` : " · Not added to plan"}
                {entry.productCount > 0 ? ` · ${entry.productCount} product${entry.productCount!==1?"s":""}` : ""}
                {isRecovered ? " · recovered" : ""}
              </p>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
              <button type="button" onClick={()=>onLoadInStudio(entry)}
                style={{padding:"7px 16px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"12px",fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                {entry.keyword ? "Load in Studio" : "Load results"}
              </button>
              <button type="button" onClick={onClose}
                style={{padding:6,borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",cursor:"pointer",display:"flex",alignItems:"center"}}>
                <X style={{width:15,height:15,color:"#64748B"}}/>
              </button>
            </div>
          </div>
          {/* Action bar */}
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {addedCount >= allPins.length && allPins.length > 0 ? (
              <a href="/app/plan" style={{padding:"5px 12px",borderRadius:6,fontSize:"11px",fontWeight:700,background:"rgba(16,185,129,0.08)",color:"#059669",border:"1px solid rgba(16,185,129,0.2)",textDecoration:"none",whiteSpace:"nowrap"}}>
                View in Weekly Plan
              </a>
            ) : (
              <button type="button" onClick={()=>addToPlanFromModal(allPins.filter(u=>!modalPlanUrls.has(u)))}
                style={{padding:"5px 12px",borderRadius:6,fontSize:"11px",fontWeight:700,background:"rgba(192,38,211,0.07)",color:"#C026D3",border:"1px solid rgba(192,38,211,0.2)",cursor:"pointer",whiteSpace:"nowrap"}}>
                {addedCount > 0 ? "Add remaining to Plan" : "Add all to Plan"}
              </button>
            )}
            <a href={allPins[0]} download="pins.jpg"
              style={{padding:"5px 12px",borderRadius:6,fontSize:"11px",fontWeight:600,background:"#F8FAFC",color:"#64748B",border:"1px solid #E5E7EB",textDecoration:"none",whiteSpace:"nowrap"}}>
              Download all
            </a>
          </div>
        </div>

        <div style={{flex:1,overflowY:"auto",display:"flex",gap:0,minHeight:0}}>
          {/* ── Left: metadata sidebar */}
          <div style={{width:220,flexShrink:0,borderRight:"1px solid #F1F5F9",padding:"16px 16px",display:"flex",flexDirection:"column",gap:0,overflowY:"auto"}}>

            {/* ── REFERENCE IMAGES — always show this section ── */}
            <div style={{marginBottom:18}}>
              <p style={{margin:"0 0 10px",fontSize:"11px",fontWeight:800,color:"#374151"}}>Reference pins</p>
              {entry.groups.some(g=>g.refUrl) ? (
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {entry.groups.map((g,i)=> g.refUrl ? (
                    <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                      <div style={{width:52,height:70,borderRadius:8,overflow:"hidden",border:"1px solid #E5E7EB",flexShrink:0,background:"#F1F5F9"}}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={toProxyUrl(g.refUrl!)} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                      </div>
                      <div>
                        <p style={{margin:0,fontSize:"11px",fontWeight:700,color:"#0F172A"}}>Ref {i+1}</p>
                        <p style={{margin:"2px 0 0",fontSize:"10px",color:"#94A3B8"}}>{g.images.length} pin{g.images.length!==1?"s":""} generated</p>
                      </div>
                    </div>
                  ) : null)}
                </div>
              ) : (
                <div style={{padding:"10px 12px",borderRadius:8,background:"#F8FAFC",border:"1px dashed #E2E8F0",textAlign:"center"}}>
                  <p style={{margin:0,fontSize:"11px",color:"#64748B",fontWeight:600}}>Not available</p>
                  <p style={{margin:"4px 0 0",fontSize:"10px",color:"#94A3B8",lineHeight:1.5}}>
                    {isRecovered
                      ? "Recovered sessions don't include reference data."
                      : "No reference was used."}
                  </p>
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{height:1,background:"#F1F5F9",margin:"0 0 18px"}}/>

            {/* ── GENERATION PROMPT ── */}
            <div style={{marginBottom:18}}>
              <p style={{margin:"0 0 10px",fontSize:"11px",fontWeight:800,color:"#374151"}}>Generation prompt</p>
              {entry.promptExcerpt ? (
                <p style={{margin:0,fontSize:"11px",color:"#374151",lineHeight:1.7,wordBreak:"break-word",background:"#F8FAFC",borderRadius:8,padding:"10px 12px",border:"1px solid #F1F5F9"}}>
                  {entry.promptExcerpt}{entry.promptExcerpt.length>=120?"…":""}
                </p>
              ) : (
                <div style={{padding:"10px 12px",borderRadius:8,background:"#F8FAFC",border:"1px dashed #E2E8F0",textAlign:"center"}}>
                  <p style={{margin:0,fontSize:"11px",color:"#64748B",fontWeight:600}}>Not available</p>
                  <p style={{margin:"4px 0 0",fontSize:"10px",color:"#94A3B8",lineHeight:1.5}}>
                    {isRecovered
                      ? "Recovered sessions don't include prompt data."
                      : "Prompt was not saved."}
                  </p>
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{height:1,background:"#F1F5F9",margin:"0 0 18px"}}/>

            {/* ── DETAILS ── */}
            <div style={{marginBottom:isRecovered?16:0}}>
              <p style={{margin:"0 0 8px",fontSize:"11px",fontWeight:800,color:"#374151"}}>Details</p>
              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                {([
                  ["Total pins",  String(allPins.length)],
                  ["Ref groups",  String(entry.refCount)],
                  ...(entry.productCount>0?[["Products",String(entry.productCount)]]:[] as [string,string][]),
                  ...(entry.category?[["Category",entry.category]]:[] as [string,string][]),
                ] as [string,string][]).map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",gap:8}}>
                    <span style={{fontSize:"10px",color:"#94A3B8"}}>{k}</span>
                    <span style={{fontSize:"10px",fontWeight:600,color:"#374151",textAlign:"right",textTransform:"capitalize"}}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recovered notice */}
            {isRecovered && (
              <div style={{padding:"10px 12px",borderRadius:8,background:"rgba(124,58,237,0.05)",border:"1px solid rgba(124,58,237,0.12)"}}>
                <p style={{margin:"0 0 4px",fontSize:"10px",fontWeight:700,color:"#7C3AED"}}>About this session</p>
                <p style={{margin:0,fontSize:"10px",color:"#6D28D9",lineHeight:1.6}}>
                  This session was recovered from storage before history tracking was enabled.
                  Next time you generate, your reference images and prompt will be saved automatically.
                </p>
              </div>
            )}
          </div>

          {/* ── Right: pin grid */}
          <div style={{flex:1,overflowY:"auto",padding:"16px 18px"}}>
            {entry.groups.map((group, gi) => (
              <div key={gi} style={{marginBottom: entry.groups.length > 1 ? 24 : 0}}>
                {entry.groups.length > 1 && (
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    {group.refUrl && (
                      <div style={{width:20,height:28,borderRadius:4,overflow:"hidden",border:"1px solid #E5E7EB",flexShrink:0}}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={toProxyUrl(group.refUrl!)} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                      </div>
                    )}
                    <span style={{fontSize:"10px",fontWeight:700,color:"#64748B",textTransform:"uppercase",letterSpacing:"0.07em"}}>Reference {gi+1}</span>
                    <div style={{flex:1,height:1,background:"#F1F5F9"}}/>
                    <span style={{fontSize:"10px",color:"#94A3B8"}}>{group.images.length} pins</span>
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10}}>
                  {group.images.map((src,i)=>{
                    const inPlan  = modalPlanUrls.has(src);
                    const proxySrc = toProxyUrl(src);
                    return (
                      <div key={i} style={{borderRadius:10,overflow:"hidden",border:`1px solid ${inPlan?"rgba(16,185,129,0.3)":"#F1F5F9"}`,background:"#FAFAFA",display:"flex",flexDirection:"column"}}>
                        <div style={{aspectRatio:"2/3",cursor:"pointer",overflow:"hidden",position:"relative"}} onClick={()=>setPreviewSrc(proxySrc)}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={proxySrc} alt="" style={{width:"100%",height:"100%",objectFit:"cover",transition:"transform 0.2s"}}
                            onMouseEnter={e=>(e.currentTarget.style.transform="scale(1.05)")}
                            onMouseLeave={e=>(e.currentTarget.style.transform="scale(1)")}/>
                          {/* Status chip */}
                          <span style={{position:"absolute",top:5,left:5,fontSize:"8px",fontWeight:700,borderRadius:8,padding:"2px 6px",background:inPlan?"rgba(16,185,129,0.9)":"rgba(255,255,255,0.9)",color:inPlan?"#fff":"#374151"}}>
                            {inPlan?"✓ In Plan":`#${gi*group.images.length+i+1}`}
                          </span>
                        </div>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-around",padding:"5px 2px",borderTop:"1px solid #F1F5F9",gap:2}}>
                          <a href={proxySrc} download={`pin-${gi+1}-${i+1}.jpg`}
                            style={{padding:"3px 6px",color:"#9CA3AF",display:"flex",alignItems:"center",gap:3,fontSize:"9px",fontWeight:600,textDecoration:"none"}}
                            onClick={e=>e.stopPropagation()}>
                            <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path d="M12 15V3m0 12-4-4m4 4 4-4M2 17v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                            DL
                          </a>
                          {inPlan ? (
                            <a href="/app/plan" style={{padding:"3px 6px",color:"#059669",fontSize:"9px",fontWeight:700,textDecoration:"none",whiteSpace:"nowrap"}}>
                              View →
                            </a>
                          ) : (
                            <button type="button" onClick={e=>{e.stopPropagation();addToPlanFromModal([src]);}}
                              style={{padding:"3px 6px",background:"none",border:"none",cursor:"pointer",color:"#C026D3",fontSize:"9px",fontWeight:700,whiteSpace:"nowrap"}}>
                              + Plan
                            </button>
                          )}
                        </div>
                        {inPlan && (
                          <div style={{padding:"2px 0",background:"rgba(16,185,129,0.06)",borderTop:"1px solid rgba(16,185,129,0.12)",textAlign:"center"}}>
                            <span style={{fontSize:"8px",color:"#059669",fontWeight:700}}>Added to Plan</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Large preview overlay */}
      {previewSrc && (
        <div style={{position:"fixed",inset:0,zIndex:70,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={()=>setPreviewSrc(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewSrc} alt="" style={{maxHeight:"90vh",maxWidth:"min(500px,90vw)",borderRadius:12,objectFit:"contain"}}
            onClick={e=>e.stopPropagation()}/>
          <button type="button" onClick={()=>setPreviewSrc(null)}
            style={{position:"fixed",top:16,right:16,width:34,height:34,borderRadius:"50%",background:"rgba(255,255,255,0.15)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <X style={{width:16,height:16,color:"#fff"}}/>
          </button>
        </div>
      )}
    </>
  );
}

// ── Indeterminate checkbox helper ─────────────────────────────────────────────
function IndeterminateCheckbox({ checked, indeterminate, disabled, onChange }: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const cbRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (cbRef.current) cbRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={cbRef}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      style={{ accentColor: "#7C3AED", cursor: disabled ? "default" : "pointer", width: 14, height: 14 }}
    />
  );
}

// ── History Drawer ────────────────────────────────────────────────────────────
function HistoryDrawer({
  open, loaded, onClose, entries, onOpen, onAddedToPlan,
}: {
  open: boolean;
  loaded: boolean;
  onClose: () => void;
  entries: HistoryEntry[];
  onOpen: (entry: HistoryEntry) => void;
  onAddedToPlan?: () => void;
}) {
  const [selectedPinUrls, setSelectedPinUrls] = useState<Set<string>>(new Set());
  const [expandedIds,     setExpandedIds]     = useState<Set<string>>(new Set());
  const [filterTab,       setFilterTab]       = useState<"all" | "not_added" | "added">("all");
  const [searchQuery,     setSearchQuery]     = useState("");
  const [, setStoreVer]                       = useState(0);

  useEffect(() => {
    if (!open) return;
    const handler = () => setStoreVer(v => v + 1);
    window.addEventListener("vp:pin_store_updated", handler);
    return () => window.removeEventListener("vp:pin_store_updated", handler);
  }, [open]);

  // Clear selection when drawer closes
  useEffect(() => {
    if (!open) setSelectedPinUrls(new Set());
  }, [open]);

  if (!open) return null;

  const selectedCount = selectedPinUrls.size;

  // Returns image URLs not yet added to plan for a given session
  function getNotAddedUrls(entry: HistoryEntry): string[] {
    const pins = pinStore.getSessionPins(entry.id);
    if (pins.length === 0) return entry.groups.flatMap(g => g.images);
    return pins.filter(p => p.status === "generated").map(p => p.imageUrl);
  }

  function toggleSessionSelect(entry: HistoryEntry) {
    const notAdded = getNotAddedUrls(entry);
    const allSelected = notAdded.length > 0 && notAdded.every(url => selectedPinUrls.has(url));
    setSelectedPinUrls(prev => {
      const next = new Set(prev);
      if (allSelected) {
        for (const url of entry.groups.flatMap(g => g.images)) next.delete(url);
      } else {
        for (const url of notAdded) next.add(url);
      }
      return next;
    });
  }

  function togglePinSelect(url: string) {
    setSelectedPinUrls(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function addUrlsToPlan(urls: string[]) {
    if (urls.length === 0) return;
    pinStore.markPinsByImageUrls(urls);
    // Create pin drafts — look up session context from pinStore per URL
    for (const url of urls) {
      const pin = pinStore.getPinByImageUrl(url);
      if (pin) {
        pinDraftStore.createDraft({
          imageUrl:            url,
          keyword:             pin.keyword,
          category:            pin.category,
          generationSessionId: pin.sessionId,
        });
      }
    }
    const n = urls.length;
    toast.success(`Added ${n} pin${n !== 1 ? "s" : ""} to Weekly Plan`, {
      action: { label: "View in Weekly Plan", onClick: () => { window.location.href = "/app/plan"; } },
    });
    onAddedToPlan?.();
  }

  function handleAddSelected() {
    addUrlsToPlan([...selectedPinUrls]);
    setSelectedPinUrls(new Set());
  }

  function handleDownloadSelected() {
    let i = 0;
    for (const url of selectedPinUrls) {
      const idx = i;
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = url; a.download = `pin-${idx + 1}.jpg`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }, idx * 200);
      i++;
    }
  }

  // Filter tab counts
  const tabNotAddedCount = entries.filter(e => { const s = pinStore.getSession(e.id); return !s || s.status === "generated"; }).length;
  const tabAddedCount    = entries.filter(e => { const s = pinStore.getSession(e.id); return !!s && s.status !== "generated"; }).length;

  const filteredEntries = entries.filter(entry => {
    // Skip sessions with no displayable images (e.g. old DB rows before v20 backfill)
    const hasImages = entry.groups.some(g => g.images.length > 0);
    if (!hasImages) return false;
    if (searchQuery && !entry.keyword?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterTab === "all") return true;
    const s = pinStore.getSession(entry.id)?.status ?? "generated";
    if (filterTab === "not_added") return s === "generated";
    if (filterTab === "added")     return s !== "generated";
    return true;
  });

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:40,background:"rgba(0,0,0,0.35)"}}/>

      {/* Drawer */}
      <div style={{
        position:"fixed",top:0,right:0,bottom:0,zIndex:50,width:460,maxWidth:"96vw",
        background:"#fff",boxShadow:"-4px 0 24px rgba(0,0,0,0.12)",
        display:"flex",flexDirection:"column",overflow:"hidden",
      }}>
        {/* ── Header */}
        <div style={{padding:"16px 20px",borderBottom:"1px solid #F1F5F9",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <Clock style={{width:15,height:15,color:"#7C3AED"}}/>
            <span style={{fontSize:"14px",fontWeight:800,color:"#0F172A"}}>Generation History</span>
            {entries.length > 0 && (
              <span style={{fontSize:"11px",fontWeight:700,color:"#7C3AED",background:"rgba(124,58,237,0.1)",padding:"1px 8px",borderRadius:20}}>
                {entries.length}
              </span>
            )}
          </div>
          <button type="button" onClick={onClose} style={{padding:6,borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",cursor:"pointer",display:"flex",alignItems:"center"}}>
            <X style={{width:14,height:14,color:"#64748B"}}/>
          </button>
        </div>

        {/* ── Bulk action bar — shown when pins are selected */}
        {selectedCount > 0 && (
          <div style={{
            padding:"10px 16px",borderBottom:"1px solid rgba(124,58,237,0.15)",flexShrink:0,
            background:"linear-gradient(135deg,rgba(124,58,237,0.06),rgba(192,38,211,0.06))",
            display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",
          }}>
            <input type="checkbox" checked readOnly onClick={() => setSelectedPinUrls(new Set())}
              style={{accentColor:"#7C3AED",cursor:"pointer",width:14,height:14}}/>
            <span style={{fontSize:"12px",fontWeight:700,color:"#7C3AED",flex:1,minWidth:0}}>
              {selectedCount} pin{selectedCount !== 1 ? "s" : ""} selected
            </span>
            <button type="button" onClick={handleAddSelected}
              style={{padding:"5px 12px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#C026D3,#7C3AED)",color:"#fff",fontSize:"11px",fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}>
              <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Add selected to Plan
            </button>
            <button type="button" onClick={handleDownloadSelected}
              style={{padding:"5px 10px",borderRadius:8,border:"1px solid #E5E7EB",background:"#fff",color:"#475569",fontSize:"11px",fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4}}>
              <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M12 15V3m0 12-4-4m4 4 4-4M2 17v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Download selected
            </button>
            <button type="button" onClick={() => setSelectedPinUrls(new Set())}
              style={{padding:"5px 8px",borderRadius:8,border:"1px solid #FECACA",background:"#FFF5F5",color:"#EF4444",fontSize:"11px",fontWeight:600,cursor:"pointer"}}>
              Clear
            </button>
          </div>
        )}

        {/* ── Search + filter bar */}
        <div style={{padding:"12px 16px 0",flexShrink:0}}>
          <div style={{position:"relative",marginBottom:8}}>
            <svg width="13" height="13" fill="none" stroke="#94A3B8" strokeWidth={2} viewBox="0 0 24 24"
              style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}}>
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35" strokeLinecap="round"/>
            </svg>
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by keyword or session…"
              style={{width:"100%",boxSizing:"border-box",paddingLeft:30,paddingRight:10,paddingTop:7,paddingBottom:7,borderRadius:8,border:"1px solid #E5E7EB",fontSize:"12px",color:"#374151",outline:"none",background:"#F8FAFC"}}/>
          </div>
          <div style={{display:"flex",gap:5,paddingBottom:10,overflowX:"auto"}}>
            {(["all","not_added","added"] as const).map(tab => (
              <button key={tab} type="button" onClick={() => setFilterTab(tab)}
                style={{padding:"3px 11px",borderRadius:20,border:"none",cursor:"pointer",whiteSpace:"nowrap",fontSize:"11px",fontWeight:600,flexShrink:0,
                  background: filterTab === tab ? "#7C3AED" : "#F1F5F9",
                  color:      filterTab === tab ? "#fff"    : "#64748B"}}>
                {tab === "all" ? "All" : tab === "not_added" ? `Not added ${tabNotAddedCount}` : `Added ${tabAddedCount}`}
              </button>
            ))}
          </div>
        </div>

        {/* ── Session list */}
        <div style={{flex:1,overflowY:"auto",padding:"0 16px 16px",display:"flex",flexDirection:"column",gap:10}}>
          {filteredEntries.length === 0 ? (
            <div style={{textAlign:"center",padding:"48px 0"}}>
              {loaded ? (
                <>
                  <p style={{fontSize:"13px",color:"#94A3B8",fontWeight:600}}>
                    {searchQuery || filterTab !== "all" ? "No sessions match" : "No history yet"}
                  </p>
                  <p style={{fontSize:"11px",color:"#CBD5E1",marginTop:4}}>
                    {searchQuery || filterTab !== "all" ? "Try a different filter" : "Generated pins will appear here"}
                  </p>
                </>
              ) : (
                <>
                  <div style={{width:20,height:20,border:"2px solid #E5E7EB",borderTopColor:"#7C3AED",borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 10px"}}/>
                  <p style={{fontSize:"12px",color:"#94A3B8"}}>Checking your past generations…</p>
                </>
              )}
            </div>
          ) : filteredEntries.map(entry => {
            const allImgUrls  = entry.groups.flatMap(g => g.images).map(toProxyUrl);
            const thumbs      = allImgUrls.slice(0, 4);
            const date        = new Date(entry.savedAt);
            const dateLabel   = date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
              + " · " + date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
            const isStorage   = entry.source === "storage";
            const title       = entry.keyword || (isStorage ? "Generated session" : "Untitled");
            const sess        = pinStore.getSession(entry.id);
            const sessionPins = pinStore.getSessionPins(entry.id);
            const sessStatus  = sess?.status ?? "generated";
            const statusColor = pinStore.sessionStatusColor(sessStatus);
            const isExpanded  = expandedIds.has(entry.id);

            const notAddedUrls   = getNotAddedUrls(entry);
            const hasNotAdded    = notAddedUrls.length > 0;
            const allNotAddedSel = hasNotAdded && notAddedUrls.every(url => selectedPinUrls.has(url));
            const someFromSess   = allImgUrls.some(url => selectedPinUrls.has(url));
            const isIndet        = someFromSess && !allNotAddedSel;

            return (
              <div key={entry.id} style={{
                borderRadius:12,overflow:"hidden",
                border:`1px solid ${someFromSess ? "rgba(124,58,237,0.3)" : "#F1F5F9"}`,
                background: someFromSess ? "rgba(124,58,237,0.025)" : "#FAFAFA",
                boxShadow: someFromSess ? "0 0 0 2px rgba(124,58,237,0.08)" : "none",
              }}>
                {/* ── Session header row */}
                <div style={{display:"flex",alignItems:"flex-start",gap:8,padding:"12px 14px"}}>
                  {/* Checkbox */}
                  <div style={{paddingTop:2,flexShrink:0}}>
                    <IndeterminateCheckbox
                      checked={allNotAddedSel}
                      indeterminate={isIndet}
                      disabled={!hasNotAdded && !someFromSess}
                      onChange={() => toggleSessionSelect(entry)}
                    />
                  </div>

                  {/* Title + meta + status chip */}
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{margin:0,fontSize:"12px",fontWeight:800,color:"#0F172A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textTransform:"capitalize"}}>{title}</p>
                    <p style={{margin:"2px 0 0",fontSize:"10px",color:"#94A3B8"}}>
                      {dateLabel}{" · "}{entry.totalPins} pin{entry.totalPins!==1?"s":""}
                      {entry.productCount > 0 ? ` · ${entry.productCount} product${entry.productCount!==1?"s":""}` : ""}
                      {isStorage && <span> · recovered</span>}
                    </p>
                    <div style={{marginTop:5,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span style={{display:"inline-block",fontSize:"9px",fontWeight:700,padding:"2px 7px",borderRadius:20,background:`${statusColor}18`,color:statusColor,border:`1px solid ${statusColor}30`}}>
                        {sessStatus === "partially_added_to_plan" ? "— Partially added"
                          : sessStatus === "added_to_plan" ? "✓ Added"
                          : "Not added"}
                      </span>
                      {sess && sess.addedCount > 0 && (
                        <span style={{fontSize:"9px",color:"#94A3B8"}}>{sess.addedCount}/{entry.totalPins} added</span>
                      )}
                    </div>
                  </div>

                  {/* Quick actions */}
                  <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0,flexWrap:"wrap",justifyContent:"flex-end"}}>
                    {sessStatus === "added_to_plan" ? (
                      <a href="/app/plan"
                        style={{padding:"4px 9px",borderRadius:7,fontSize:"10px",fontWeight:700,background:"rgba(5,150,105,0.08)",color:"#059669",border:"1px solid rgba(5,150,105,0.2)",textDecoration:"none",whiteSpace:"nowrap"}}>
                        View in Plan
                      </a>
                    ) : sessStatus === "partially_added_to_plan" ? (
                      <button type="button" onClick={() => addUrlsToPlan(notAddedUrls)}
                        style={{padding:"4px 9px",borderRadius:7,fontSize:"10px",fontWeight:700,background:"rgba(192,38,211,0.07)",color:"#C026D3",border:"1px solid rgba(192,38,211,0.2)",cursor:"pointer",whiteSpace:"nowrap"}}>
                        Add remaining ({notAddedUrls.length})
                      </button>
                    ) : (
                      <button type="button" onClick={() => addUrlsToPlan(notAddedUrls)}
                        style={{padding:"4px 9px",borderRadius:7,fontSize:"10px",fontWeight:700,background:"rgba(192,38,211,0.07)",color:"#C026D3",border:"1px solid rgba(192,38,211,0.2)",cursor:"pointer",whiteSpace:"nowrap"}}>
                        Add all to Plan
                      </button>
                    )}
                    <button type="button" onClick={() => toggleExpand(entry.id)}
                      style={{padding:"4px 6px",borderRadius:7,border:"1px solid #E5E7EB",background:"#fff",cursor:"pointer",display:"flex",alignItems:"center"}}>
                      <ChevronDown style={{width:12,height:12,color:"#64748B",transition:"transform 0.18s",transform:isExpanded?"rotate(180deg)":"rotate(0deg)"}}/>
                    </button>
                    <button type="button" onClick={() => onOpen(entry)}
                      style={{padding:"4px 9px",borderRadius:7,fontSize:"10px",fontWeight:700,color:"#7C3AED",background:"rgba(124,58,237,0.07)",border:"1px solid rgba(124,58,237,0.18)",cursor:"pointer",whiteSpace:"nowrap"}}>
                      Open
                    </button>
                  </div>
                </div>

                {/* ── Expanded per-pin grid or collapsed thumbnail row */}
                {isExpanded ? (
                  <div style={{padding:"0 14px 12px",display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6}}>
                    {allImgUrls.map((src, idx) => {
                      const pinRec  = sessionPins.find(p => p.imageUrl === src);
                      const inPlan  = (pinRec?.status ?? "generated") !== "generated";
                      const selected = selectedPinUrls.has(src);
                      return (
                        <div key={idx}
                          onClick={() => { if (!inPlan) togglePinSelect(src); }}
                          style={{
                            position:"relative",borderRadius:8,overflow:"hidden",cursor:inPlan?"default":"pointer",
                            border:`2px solid ${selected ? "#7C3AED" : inPlan ? "rgba(5,150,105,0.35)" : "#E5E7EB"}`,
                          }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt="" loading="lazy"
                            style={{width:"100%",aspectRatio:"2/3",objectFit:"cover",display:"block",background:"#E5E7EB"}}
                            onError={e=>{e.currentTarget.style.opacity="0";}}
                          />
                          {/* Checkbox overlay */}
                          <div style={{position:"absolute",top:5,left:5}}>
                            <input type="checkbox" checked={selected} disabled={inPlan}
                              onChange={e => { e.stopPropagation(); togglePinSelect(src); }}
                              onClick={e => e.stopPropagation()}
                              style={{accentColor:"#7C3AED",cursor:inPlan?"default":"pointer",width:14,height:14}}/>
                          </div>
                          {/* Status badge */}
                          <span style={{
                            position:"absolute",bottom:5,right:5,fontSize:"8px",fontWeight:700,padding:"2px 6px",borderRadius:8,
                            background: inPlan ? "rgba(5,150,105,0.9)" : selected ? "rgba(124,58,237,0.9)" : "rgba(255,255,255,0.88)",
                            color: (inPlan || selected) ? "#fff" : "#374151",
                          }}>
                            {inPlan ? "✓ Added" : "Generated"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : thumbs.length > 0 && (
                  <div style={{padding:"0 14px 12px",display:"grid",gridTemplateColumns:`repeat(${thumbs.length},1fr)`,gap:4}}>
                    {thumbs.map((src, idx) => (
                      <div key={idx} style={{aspectRatio:"2/3",borderRadius:6,overflow:"hidden",background:"#E5E7EB",position:"relative",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        {/* broken-image fallback icon — hidden by loaded image */}
                        <svg width="14" height="14" fill="none" stroke="#C4CADA" strokeWidth={1.5} viewBox="0 0 24 24" style={{position:"absolute",inset:0,margin:"auto"}}>
                          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21" strokeLinecap="round"/>
                        </svg>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt="" loading="lazy"
                          style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}}
                          onError={e=>{e.currentTarget.style.display="none";}}/>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Footer */}
          {entries.length > 0 && (
            <div style={{padding:"4px 0 2px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{fontSize:"11px",color:"#94A3B8"}}>
                Showing {filteredEntries.length} of {entries.length} session{entries.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Reference Pins — multi-select, save count below ───────────────────────────
function PlanRefSection({ pins, selectedRefs, onToggle }: {
  pins: PlanPin[]; selectedRefs: string[]; onToggle: (url: string) => void;
}) {
  return (
    <div className="grid gap-2" style={{gridTemplateColumns:"repeat(4, 1fr)"}}>
      {pins.map(pin => {
        const sel = selectedRefs.includes(pin.image_url);
        const saves = pin.save_count >= 1000 ? `${(pin.save_count/1000).toFixed(1)}K` : String(pin.save_count);
        return (
          <div key={pin.id} style={{display:"flex",flexDirection:"column",gap:4}}>
            <button type="button" onClick={()=>onToggle(pin.image_url)} style={{
              position:"relative", borderRadius:8, overflow:"hidden",
              border: sel?"2.5px solid #C026D3":"1.5px solid #E5E7EB",
              cursor:"pointer", background:"#f0f0f0", padding:0,
              aspectRatio:"2/3", width:"100%",
              boxShadow: sel?"0 0 0 1px #C026D3":"none",
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pin.image_url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} loading="lazy"/>
              {sel && (
                <div style={{position:"absolute",top:5,right:5,width:20,height:20,borderRadius:"50%",background:"#C026D3",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}>
                  <X style={{width:10,height:10,color:"#fff",strokeWidth:3}}/>
                </div>
              )}
            </button>
            <p style={{fontSize:10,color:"#64748B",textAlign:"center",fontWeight:500}}>{saves} saves</p>
          </div>
        );
      })}
      {/* "View more" slot — shows if fewer than 4 pins */}
      {pins.length < 4 && (
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <div style={{borderRadius:8,border:"1.5px dashed #E5E7EB",aspectRatio:"2/3",width:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,background:"#FAFAFA",cursor:"default"}}>
            <span style={{fontSize:20,color:"#D1D5DB",lineHeight:1}}>+</span>
            <p style={{fontSize:9,color:"#94A3B8",textAlign:"center",fontWeight:500,lineHeight:1.3,padding:"0 4px"}}>View more references</p>
          </div>
          <p style={{fontSize:10,color:"transparent",textAlign:"center"}}>—</p>
        </div>
      )}
    </div>
  );
}

// ── Style reference (custom upload / viral pin) ────────────────────────────────
function StyleReference({ image, setImage, fromPin }: {
  image: string|null; setImage:(url:string|null)=>void; fromPin:boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  function addFile(file:File) { const r=new FileReader(); r.onload=e=>setImage(e.target?.result as string); r.readAsDataURL(file); }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Style reference</p>
        {fromPin && image && <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{background:"rgba(245,158,11,0.08)",color:"#F59E0B",border:"1px solid rgba(245,158,11,0.2)"}}>From Viral Pin</span>}
      </div>
      <p className="text-[10px] text-gray-400 mb-2">Mood, layout &amp; composition — not copied artwork</p>
      {image ? (
        <div className="relative rounded-xl overflow-hidden border border-gray-200" style={{height:140}}>
          <Image src={image} alt="style reference" fill className="object-cover" unoptimized/>
          <button type="button" onClick={()=>setImage(null)} className="absolute top-2 right-2 rounded-full bg-black/60 p-1 hover:bg-black/80 transition-colors"><X className="h-3 w-3 text-white"/></button>
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
            <p className="text-[9px] font-bold text-white/80 uppercase tracking-widest">Style reference</p>
          </div>
        </div>
      ) : (
        <div className={`rounded-xl border-2 border-dashed cursor-pointer flex flex-col items-center justify-center gap-1.5 py-5 transition-colors ${dragging?"border-[#C026D3] bg-fuchsia-50":"border-gray-200 bg-gray-50"}`}
          onClick={()=>fileRef.current?.click()}
          onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)}
          onDrop={e=>{e.preventDefault();setDragging(false);if(e.dataTransfer.files[0])addFile(e.dataTransfer.files[0]);}}>
          <ImagePlus className="h-5 w-5 text-gray-300"/>
          <p className="text-[11px] font-semibold text-gray-400">Upload style reference</p>
          <p className="text-[10px] text-gray-300">or click &quot;Use as Style Reference&quot; on a Viral Pin</p>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e=>e.target.files?.[0]&&addFile(e.target.files[0])}/>
        </div>
      )}
    </div>
  );
}

// ── Category-aware prompt helpers (mirrors generator.py modules) ─────────────

const _FASHION_IDS = new Set(["fashion", "womens-fashion", "mens-fashion", "kids-fashion"]);

function catDisplayName(cat: string): string {
  const MAP: Record<string, string> = {
    "home-decor": "Home Decor", "fashion": "Fashion", "womens-fashion": "Women's Fashion",
    "mens-fashion": "Men's Fashion", "kids-fashion": "Kids Fashion", "beauty": "Beauty",
    "food-and-drink": "Food & Drink", "digital-products": "Digital Products",
    "wedding": "Wedding", "diy-crafts": "DIY & Crafts",
  };
  return MAP[cat] ?? (cat ? cat.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "General");
}

function catComposition(cat: string): string {
  if (cat === "home-decor")          return "styled interior scenes, room vignettes, shelf styling, or decor moodboards";
  // Fashion: do NOT enumerate flat-lay vs mirror vs on-body here.
  // The per-reference composition mode is injected separately in handleGenerate
  // so the global prompt stays neutral and does not collapse all groups into one style.
  if (_FASHION_IDS.has(cat))         return "Pinterest-native fashion image";
  if (cat === "beauty")              return "beauty routine compositions, skincare shelfies, vanity flat lays, or texture moodboards";
  if (cat === "food-and-drink")      return "recipe visuals, ingredient layouts, table settings, or serving scenes";
  if (cat === "digital-products")    return "digital product mockups, device scenes, desk setups, or template previews";
  return "lifestyle compositions, moodboards, or styled scenes";
}

function catProductRule(cat: string): string {
  if (cat === "home-decor")          return "Naturally integrate most products into the room or styling setup.";
  if (_FASHION_IDS.has(cat))         return "Use most apparel and accessory products when composition allows.";
  if (cat === "beauty")              return "Feature most beauty products as recognizable items in the scene.";
  if (cat === "food-and-drink")      return "Use uploaded products as ingredients, packaging, or serving elements.";
  if (cat === "digital-products")    return "Represent digital assets as screens, pages, cards, or mockups in context.";
  return "Include most uploaded products naturally in the scene.";
}

function catPropsRule(cat: string): string {
  if (cat === "home-decor")          return "Additional furniture, plants, books, textiles, trays, lighting, and decor props are welcome.";
  if (_FASHION_IDS.has(cat))         return "Additional complementary styling items, shoes, and accessories are allowed.";
  if (cat === "beauty")              return "Additional textures, mirrors, flowers, trays, and vanity props are allowed.";
  if (cat === "food-and-drink")      return "Additional plates, utensils, garnishes, linens, and table props are allowed.";
  if (cat === "digital-products")    return "Additional desk props, devices, stationery, and lifestyle context are allowed.";
  return "Additional complementary props and styling elements are allowed.";
}

function catRefRule(cat: string): string {
  if (cat === "home-decor")          return "Match its room composition, color palette, decor density, and lighting mood.";
  if (_FASHION_IDS.has(cat))         return "Match its exact composition type (worn outfit / flat lay / mirror), color palette, occasion vibe, and Pinterest aesthetic.";
  if (cat === "beauty")              return "Match its product arrangement, texture, lighting, and vanity style.";
  if (cat === "food-and-drink")      return "Match its serving composition, ingredient layout, table styling, and color palette.";
  if (cat === "digital-products")    return "Match its mockup composition, device layout, and preview hierarchy.";
  return "Match its composition, lighting, mood, and color palette.";
}

// ── Chip ──────────────────────────────────────────────────────────────────────
function Chip({ color, bg, children }: { color:string; bg:string; children:React.ReactNode }) {
  return <span style={{fontSize:"9px",fontWeight:700,color,background:bg,padding:"1px 5px",borderRadius:"3px",whiteSpace:"nowrap"}}>{children}</span>;
}

// ── Batch Queue Panel ─────────────────────────────────────────────────────────
function BatchQueuePanel({
  keywords, activeKeyword, batchStates,
  activeGeneratedImages, activeProductImages, activeProductUrl,
  activeCustomStyleRef, activeSelectedPlanRefs, activeTier,
  onSelectKeyword, category,
  batchProductMode, sharedProductImage, sharedProductName,
  onSetProductMode, onSetSharedProduct, batchTiers,
}: {
  keywords:string[]; activeKeyword:string; batchStates:Record<string,BatchOpState>;
  activeGeneratedImages:string[]; activeProductImages:string[]; activeProductUrl:string;
  activeCustomStyleRef:string|null; activeSelectedPlanRefs:string[]; activeTier:string;
  onSelectKeyword:(kw:string)=>void; category:string;
  batchProductMode:"per-opportunity"|"shared"; sharedProductImage:string|null; sharedProductName:string;
  onSetProductMode:(mode:"per-opportunity"|"shared")=>void;
  onSetSharedProduct:(img:string|null,name:string)=>void;
  batchTiers:Record<string,string>;
}) {
  const sharedFileRef = useRef<HTMLInputElement>(null);
  function handleSharedFile(file:File) {
    const r=new FileReader(); r.onload=e=>onSetSharedProduct(e.target?.result as string,file.name.replace(/\.[^.]+$/,"")); r.readAsDataURL(file);
  }
  const completedCount = keywords.filter(kw=>
    kw===activeKeyword ? activeGeneratedImages.length>0 : (batchStates[kw]?.generatedGroups.flatMap(g=>g.images).length??0)>0
  ).length;
  const activeIdx = Math.max(0,keywords.indexOf(activeKeyword));

  return (
    <aside className="shrink-0 flex flex-col bg-white min-h-0 overflow-hidden" style={{width:240,borderRight:"1px solid #E5E7EB"}}>
      {/* Header */}
      <div style={{padding:"14px 16px 10px",borderBottom:"1px solid #F3F4F6",flexShrink:0}}>
        <p style={{margin:0,fontSize:"9px",fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.1em"}}>Batch Queue</p>
        <p style={{margin:"2px 0 0",fontSize:"13px",fontWeight:800,color:"#0F172A"}}>{keywords.length} opportunities</p>
        {completedCount>0 && <p style={{margin:"2px 0 0",fontSize:"10px",color:"#10B981",fontWeight:600}}>{completedCount} of {keywords.length} generated</p>}
      </div>

      {/* Shared product toggle */}
      <div style={{padding:"8px 12px 6px",borderBottom:"1px solid #F3F4F6",flexShrink:0}}>
        <div style={{display:"flex",gap:3,marginBottom:batchProductMode==="shared"?"8px":"0"}}>
          {(["per-opportunity","shared"] as const).map(mode=>(
            <button key={mode} type="button" onClick={()=>onSetProductMode(mode)} style={{flex:1,padding:"4px 6px",fontSize:"9px",fontWeight:700,borderRadius:5,cursor:"pointer",border:"none",background:batchProductMode===mode?(mode==="shared"?"rgba(192,38,211,0.1)":"#F1F5F9"):"transparent",color:batchProductMode===mode?(mode==="shared"?"#C026D3":"#374151"):"#94A3B8"}}>
              {mode==="shared"?"Shared product":"Per opportunity"}
            </button>
          ))}
        </div>
        {batchProductMode==="shared" && (
          <div>
            <input ref={sharedFileRef} type="file" accept="image/*" className="hidden" onChange={e=>e.target.files?.[0]&&handleSharedFile(e.target.files[0])}/>
            {sharedProductImage ? (
              <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                <div style={{width:40,height:40,borderRadius:7,overflow:"hidden",border:"1px solid #E5E7EB",flexShrink:0}}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sharedProductImage} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <p style={{margin:0,fontSize:"10px",fontWeight:700,color:"#374151"}}>Shared product</p>
                  {sharedProductName && <p style={{margin:"1px 0 0",fontSize:"9px",color:"#64748B",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sharedProductName}</p>}
                  <div style={{display:"flex",gap:8,marginTop:3}}>
                    <button type="button" onClick={()=>sharedFileRef.current?.click()} style={{fontSize:"9px",fontWeight:600,color:"#C026D3",background:"none",border:"none",cursor:"pointer",padding:0}}>Replace</button>
                    <button type="button" onClick={()=>onSetSharedProduct(null,"")} style={{fontSize:"9px",fontWeight:600,color:"#94A3B8",background:"none",border:"none",cursor:"pointer",padding:0}}>Remove</button>
                  </div>
                </div>
              </div>
            ) : (
              <button type="button" onClick={()=>sharedFileRef.current?.click()} style={{width:"100%",padding:"7px",borderRadius:6,cursor:"pointer",border:"1px dashed #D1D5DB",background:"#FAFAFA",fontSize:"10px",fontWeight:600,color:"#94A3B8",textAlign:"center"}}>
                Upload shared product image
              </button>
            )}
          </div>
        )}
      </div>

      {/* Queue items */}
      <div style={{flex:1,overflowY:"auto",padding:"8px 10px",display:"flex",flexDirection:"column",gap:4}}>
        {keywords.map((kw,i)=>{
          const isActive = kw===activeKeyword;
          const state    = batchStates[kw];
          const refSrc   = isActive ? (activeSelectedPlanRefs[0]??activeCustomStyleRef) : (state?.selectedPlanRefs?.[0]??state?.customStyleRef??null);
          const genCount = isActive ? activeGeneratedImages.length : (state?.generatedGroups.flatMap(g=>g.images).length??0);
          const hasProduct = isActive ? (activeProductImages.length>0||!!activeProductUrl) : ((state?.myProductImages.length??0)>0||!!(state?.myProductUrl));
          const tier     = isActive ? activeTier : (batchTiers[kw]??state?.tier??"");
          const chip     = tier ? getTrendChip(tier) : null;

          return (
            <button key={kw} type="button" onClick={()=>onSelectKeyword(kw)} style={{
              padding:"10px 10px",borderRadius:10,textAlign:"left",
              border:isActive?"1px solid rgba(192,38,211,0.3)":"1px solid #E5E7EB",
              background:isActive?"rgba(192,38,211,0.04)":"#FAFAFA",
              cursor:"pointer",display:"flex",gap:10,alignItems:"flex-start",
            }}>
              {/* Thumbnail with number badge */}
              <div style={{width:44,flexShrink:0,aspectRatio:"2/3",borderRadius:7,overflow:"hidden",background:"#F1F5F9",position:"relative"}}>
                {refSrc
                  /* eslint-disable-next-line @next/next/no-img-element */
                  ? <img src={refSrc} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                  : <div style={{width:"100%",height:"100%",background:"linear-gradient(135deg,#F3F4F6,#E5E7EB)"}}/>}
                {/* Number badge */}
                <div style={{position:"absolute",top:3,left:3,width:16,height:16,borderRadius:"50%",background:isActive?"#C026D3":"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <span style={{fontSize:"8px",fontWeight:800,color:"#fff",lineHeight:1}}>{i+1}</span>
                </div>
                {genCount>0 && <div style={{position:"absolute",inset:0,background:"rgba(16,185,129,0.2)",display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:"11px",color:"#059669",fontWeight:900}}>✓</span></div>}
              </div>

              {/* Info */}
              <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:3}}>
                <p style={{margin:0,fontSize:"11px",fontWeight:700,color:isActive?"#C026D3":"#0F172A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textTransform:"capitalize",lineHeight:1.2}}>{kw}</p>
                {chip && <span style={{display:"inline-block",padding:"1px 7px",borderRadius:20,fontSize:"9px",fontWeight:600,background:chip.bg,color:chip.color,border:`1px solid ${chip.color}25`,alignSelf:"flex-start",whiteSpace:"nowrap"}}>{chip.label}</span>}
                <p style={{margin:0,fontSize:"9px",fontWeight:600,color:hasProduct?"#059669":"#94A3B8"}}>
                  {hasProduct?"✓ Product added":"No product"}
                </p>
                <p style={{margin:0,fontSize:"9px",fontWeight:600,color:genCount>0?"#C026D3":"#94A3B8"}}>
                  {genCount>0?`${genCount} pins generated`:"Ready"}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{padding:"10px 12px",borderTop:"1px solid #F3F4F6",flexShrink:0}}>
        <a href={`/app/workspace/${category||"home-decor"}`} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"7px",borderRadius:7,border:"1px dashed #E5E7EB",fontSize:"10px",fontWeight:700,color:"#94A3B8",textDecoration:"none"}}>
          + Add more opportunities
        </a>
        <div style={{marginTop:10}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
            <span style={{fontSize:"9px",color:"#94A3B8"}}>Progress</span>
            <span style={{fontSize:"9px",color:"#94A3B8"}}>{activeIdx+1} of {keywords.length}</span>
          </div>
          <div style={{height:3,background:"#F3F4F6",borderRadius:2}}>
            <div style={{height:"100%",borderRadius:2,width:`${((activeIdx+1)/keywords.length)*100}%`,background:"linear-gradient(90deg,#FF4D8D,#7C3AED)",transition:"width 0.3s"}}/>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ── Generation Panel ───────────────────────────────────────────────────────────
function GenerationPanel({
  keyword, category, style, setStyle, count, setCount,
  generating, generatingGroupIdx, onGenerate, generatedGroups,
  customStyleRef, setCustomStyleRef,
  selectedPlanRefs, onTogglePlanRef,
  sourceType, idea, fromPlan, fromWorkspace, fromBatch, fromShopSignal, fromDigitalIdea, batchInfo,
  planPinSamples, planProducts, titleHook, shopProduct, shopProducts, planTier,
  shopSignalImageUrl,
  myProductImages, setMyProductImages,
  myProductUrl, setMyProductUrl,
  myProductName, setMyProductName,
  onPublish, scheduledImages,
  draftInfo, onClearDraft, onOpenHistory,
  currentSessionId,
  marketAngleActive, setMarketAngleActive,
  productLedMode,
  productLedOpportunity,
  onSelectProductLedOpportunity,
}: {
  keyword:string; category:string;
  style:string; setStyle:(s:string)=>void;
  count:number; setCount:(n:number)=>void;
  generating:boolean; generatingGroupIdx:number|null;
  onGenerate:(req:{prompt:string;refs:string[];productImages:string[];imagesPerRef:number})=>void;
  generatedGroups:GeneratedGroup[];
  customStyleRef:string|null; setCustomStyleRef:(url:string|null)=>void;
  selectedPlanRefs:string[]; onTogglePlanRef:(url:string)=>void;
  sourceType:string; idea:string;
  fromPlan:boolean; fromWorkspace:boolean; fromBatch:boolean; fromShopSignal?:boolean; fromDigitalIdea?:boolean;
  batchInfo?:{
    total:number; currentIdx:number;
    onNext:()=>void; onPrev:()=>void; onExit:()=>void;
    productMode:"per-opportunity"|"shared";
    sharedProductImage:string|null; sharedProductName:string;
    onSetProductMode:(mode:"per-opportunity"|"shared")=>void;
    onSetSharedProduct:(img:string|null,name:string)=>void;
  };
  planPinSamples:PlanPin[]; planProducts:PlanProduct[];
  titleHook:string; shopProduct:PlanProduct|null; shopProducts:PlanProduct[]; planTier:string;
  shopSignalImageUrl?: string|null;
  myProductImages:string[]; setMyProductImages:(v:string[])=>void;
  myProductUrl:string;      setMyProductUrl:(v:string)=>void;
  myProductName:string;     setMyProductName:(v:string)=>void;
  onPublish?:(url:string)=>void; scheduledImages?:Set<string>;
  draftInfo?: { restoredAt: string | null; hadProductImages: boolean; autosaveLabel: string };
  onClearDraft?: () => void;
  onOpenHistory?: () => void;
  currentSessionId?: string | null;
  marketAngleActive:boolean; setMarketAngleActive:(v:boolean)=>void;
  productLedMode?: boolean;
  productLedOpportunity?: ProductLedOpportunity | null;
  onSelectProductLedOpportunity?: (opp: ProductLedOpportunity | null) => void;
}) {
  const selectedPreset = STYLE_PRESETS.find(p=>p.id===style)??STYLE_PRESETS[0];
  // In product-led mode start collapsed; auto-collapse again when opportunity + refs are ready
  const [promptOpen, setPromptOpen]           = useState(!productLedMode);
  const [previewSrc, setPreviewSrc]           = useState<string|null>(null);
  const [showLinkMode, setShowLinkMode]       = useState(false);
  const [draggingProduct, setDraggingProduct] = useState(false);
  const productFileRef   = useRef<HTMLInputElement>(null);
  const customRefFileRef = useRef<HTMLInputElement>(null);
  const [selectedPinUrls, setSelectedPinUrls] = useState<Set<string>>(new Set());
  const [planPinUrls,     setPlanPinUrls]     = useState<Set<string>>(new Set());
  // Asset picker state
  const [pickerRole, setPickerRole] = useState<"product"|"style_reference">("product");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Product-led: track which DB products the user removed from the current set
  const [plRemovedIds, setPlRemovedIds] = useState<Set<string>>(new Set());
  const _allShopProducts = shopProducts.length > 0 ? shopProducts : shopProduct ? [shopProduct] : [];
  const displayedShopProducts = productLedMode
    ? _allShopProducts.filter(p => !plRemovedIds.has(p.id))
    : _allShopProducts;

  function togglePinSelection(url: string) {
    setSelectedPinUrls(prev => { const n = new Set(prev); if (n.has(url)) n.delete(url); else n.add(url); return n; });
  }

  function addPinsToWeeklyPlan(urls: string[]) {
    if (urls.length === 0) return;
    setPlanPinUrls(prev => new Set([...prev, ...urls]));
    setSelectedPinUrls(new Set());
    pinStore.markPinsByImageUrls(urls);
    let addedCount = 0;
    for (const url of urls) {
      const draft = pinDraftStore.createDraft({
        imageUrl:       url,
        keyword,
        category,
        destinationUrl: myProductUrl || undefined,
      });
      addedCount++;
      console.log("[AddToPlan] selected pin count", addedCount, "weeklyPlanItemId", draft?.id ?? "none");
    }
    const sess = currentSessionId ? pinStore.getSession(currentSessionId) : null;
    console.log("[AddToPlan] updated added_count", sess?.addedCount ?? addedCount);
    const n = urls.length;
    toast.success(`Added ${n} pin${n !== 1 ? "s" : ""} to Weekly Plan`, {
      action: { label: "View in Weekly Plan", onClick: () => { window.location.href = "/app/plan"; } },
    });
  }

  function addProductFiles(files:FileList) {
    const arr=Array.from(files);
    Promise.all(arr.map(f=>new Promise<string>(res=>{ const r=new FileReader(); r.onload=e=>res(e.target?.result as string); r.readAsDataURL(f); }))).then(results=>{
      setMyProductImages([...myProductImages,...results]);
    });
  }

  const batchSharedMode = batchInfo?.productMode==="shared";
  const batchSharedImg  = batchInfo?.sharedProductImage??null;
  const batchSharedName = batchInfo?.sharedProductName??"";
  const usingShared     = batchSharedMode && !!batchSharedImg && myProductImages.length===0;
  const effectiveProductImages:string[] = usingShared ? [batchSharedImg] : myProductImages;
  const effectiveProductName  = usingShared ? batchSharedName : myProductName;
  const anyStyleRef           = selectedPlanRefs[0]??customStyleRef;
  const catLow                = (category||"").toLowerCase();
  const isFashion             = catLow.includes("fashion")||catLow.includes("apparel")||catLow.includes("beauty");

  const autoPrompt = useMemo(() => {
    const p: string[] = [];
    const hasRef = selectedPlanRefs.length > 0 || !!customStyleRef;

    // ── Product-led mode: subject-only instruction ───────────────────────────
    // Reference fidelity, composition, human presence, and hard constraints are
    // ALL injected per-group by buildGroupPrompt — keep this block subject-only
    // to avoid conflicting instructions when multiple references are used.
    if (productLedMode && displayedShopProducts.length > 0) {
      const names = displayedShopProducts.map((pr: PlanProduct) => `"${pr.product_name}"`).join(", ");
      const oppKw = productLedOpportunity?.keyword || keyword;
      p.push(
        (oppKw ? `Create a Pinterest-native fashion image for "${oppKw}". ` : `Create a Pinterest-native fashion image. `) +
        `Use the uploaded product images as the featured items. ` +
        `Keep the selected apparel and accessory products recognizable in color, silhouette, material, and key details. ` +
        `${catProductRule(catLow)} ${catPropsRule(catLow)} ` +
        `Products to feature: ${names}.`
      );
      if (!hasRef) {
        // Auto Style path — no reference, use category playbook for composition
        p.push(
          `Composition: choose the most Pinterest-native scene type for ${catDisplayName(catLow)} — ` +
          `clean editorial flat lay, on-body outfit shot with hidden face, or styled fashion vignette. ` +
          `Use natural lighting, cohesive styling, and a polished Pinterest editorial feel.`
        );
      }
      // Reference fidelity + composition + constraints are added by buildGroupPrompt.
      return p.join(" ");
    }

    // ── Category-aware creative direction ─────────────────────────────────────
    if (titleHook) p.push(`Content hook: "${titleHook}".`);

    // When a reference image is selected, omit category composition types so
    // the reference image (not text) dictates the scene type per call.
    if (effectiveProductImages.length > 1) {
      p.push(
        hasRef
          ? `Create a Pinterest-native image for "${keyword}". ` +
            `${effectiveProductImages.length} product images provided as the product set. ` +
            `${catProductRule(catLow)} ${catPropsRule(catLow)}`
          : `Create Pinterest-native ${catComposition(catLow)} for "${keyword}". ` +
            `${effectiveProductImages.length} product images provided as the product set. ` +
            `${catProductRule(catLow)} ${catPropsRule(catLow)}`
      );
      if (effectiveProductName) p.push(`Product set: "${effectiveProductName}".`);
    } else if (effectiveProductImages.length === 1) {
      p.push(
        hasRef
          ? `Create a Pinterest-native image for "${keyword}" with the uploaded product as the hero. ` +
            `The product must be clearly recognizable. ${catPropsRule(catLow)}`
          : `Create Pinterest-native ${catComposition(catLow)} for "${keyword}" ` +
            `with the uploaded product as the hero. ` +
            `The product must be clearly recognizable. ${catPropsRule(catLow)}`
      );
      if (effectiveProductName) p.push(`Product: "${effectiveProductName}".`);
    } else if (myProductUrl) {
      p.push(`Create a Pinterest pin for "${keyword}". Product URL: ${myProductUrl}.`);
      if (myProductName) p.push(`Product: "${myProductName}".`);
    } else {
      p.push(
        hasRef
          ? `Create a Pinterest-native image for "${keyword}".`
          : `Create Pinterest-native ${catComposition(catLow)} for "${keyword}".`
      );
    }

    p.push(`Visual style: ${selectedPreset.label.toLowerCase()}.`);

    if (marketAngleActive) {
      const multiCtx = shopProducts.length > 0 ? shopProducts : null;
      if (multiCtx && multiCtx.length > 1) {
        const names = multiCtx.map((pr: PlanProduct) => `"${pr.product_name}"`).join(", ");
        p.push(`Market angle: content inspired by the following product set — ${names}. Do NOT copy any product photo; use them only for buyer-intent context.`);
      } else {
        const ctx = planProducts[0] ?? shopProduct ?? (shopProducts[0] ?? null);
        if (ctx) p.push(`Market angle: inspired by "${ctx.product_name}". Do NOT copy their product photo.`);
      }
    }

    if (idea) p.push(`Content angle: "${idea}".`);

    // Reference fidelity, composition type, human presence, and hard constraints
    // are injected per-group by buildGroupPrompt — do NOT add them here.
    return p.join(" ");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleHook, effectiveProductImages.length, effectiveProductName, usingShared, myProductUrl, myProductName, keyword, catLow, selectedPreset.label, customStyleRef, selectedPlanRefs.length, idea, planProducts, marketAngleActive, shopProduct, shopProducts, productLedMode, productLedOpportunity?.keyword, displayedShopProducts.length, plRemovedIds]);

  const [promptText, setPromptText]     = useState(autoPrompt);
  const [promptEdited, setPromptEdited] = useState(false);
  const promptEditedRef                 = useRef(false);
  useEffect(()=>{ if(!promptEditedRef.current) setPromptText(autoPrompt); },[autoPrompt]);

  // Auto-collapse instructions in product-led mode once opportunity + refs are ready
  useEffect(()=>{
    if (productLedMode && !!productLedOpportunity && selectedPlanRefs.length > 0) {
      setPromptOpen(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productLedMode, productLedOpportunity?.keyword, selectedPlanRefs.length]);

  const totalOutputs   = (selectedPlanRefs.length>0?selectedPlanRefs.length:1)*count;
  const currentItemNum = batchInfo ? batchInfo.currentIdx+1 : null;
  const trendChip      = planTier ? getTrendChip(planTier) : null;
  const generatedImages = generatedGroups.flatMap(g=>g.images);

  const SectionLabel = ({children}:{children:React.ReactNode}) => (
    <p style={{margin:0,fontSize:"11px",fontWeight:800,color:"#374151",textTransform:"uppercase",letterSpacing:"0.07em"}}>{children}</p>
  );
  const SectionHelper = ({children}:{children:React.ReactNode}) => (
    <p style={{margin:"3px 0 0",fontSize:"11px",color:"#94A3B8"}}>{children}</p>
  );

  // Show NoKeywordState only when there's no keyword, not from shop signal, and not product-led
  if (!keyword && !fromShopSignal && !productLedMode) {
    return (
      <main className="flex-1 flex flex-col overflow-hidden bg-[#F7F8FA]">
        <div className="px-6 py-4 border-b border-gray-100 shrink-0 bg-white flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[#C026D3]"/>
          <h2 className="text-sm font-bold text-gray-900">Create Pin</h2>
        </div>
        <NoKeywordState/>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col overflow-hidden bg-white">

      {/* Panel header */}
      <div data-testid="studio-product-led-header" style={{padding:"12px 20px",borderBottom:"1px solid #F1F5F9",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,background:"#fff"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
          <Sparkles style={{width:16,height:16,color:"#C026D3",flexShrink:0}}/>
          <h2 style={{margin:0,fontSize:"14px",fontWeight:800,color:"#0F172A",whiteSpace:"nowrap"}}>
            {productLedMode?"Create Pins from selected products"
              :batchInfo?"Create Batch":fromDigitalIdea?"Generate Pins"
              :fromShopSignal&&shopProducts.length>1?"Create from Products"
              :fromShopSignal||sourceType==="pin"||sourceType==="product"?"Create from Signal"
              :fromPlan||fromWorkspace?"Create from Brief":"Create Pin"}
          </h2>
          {fromDigitalIdea && (
            <span style={{fontSize:"9px",fontWeight:700,color:"#7C3AED",background:"rgba(124,58,237,0.09)",border:"1px solid rgba(124,58,237,0.2)",padding:"2px 7px",borderRadius:4,whiteSpace:"nowrap"}}>
              🖥️ Digital Product mode
            </span>
          )}
          <span style={{fontSize:"11px",color:"#64748B",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
            {productLedMode
              ? (() => {
                  const refCount = selectedPlanRefs.length + (customStyleRef && !selectedPlanRefs.includes(customStyleRef) ? 1 : 0);
                  const parts = [
                    `${displayedShopProducts.length} product${displayedShopProducts.length!==1?"s":""}`,
                    productLedOpportunity ? `Opportunity: ${productLedOpportunity.keyword}` : "No opportunity",
                    refCount > 0 ? `${refCount} reference${refCount!==1?"s":""}` : "No references",
                  ];
                  return parts.join(" · ");
                })()
              : batchInfo
              ? `${batchInfo.total} opportunities · Reference ready · Product optional`
              : fromDigitalIdea
                ? "Digital product idea loaded · References optional · Product optional"
                : fromShopSignal && shopProducts.length > 1
                  ? `${shopProducts.length} products loaded · Choose a keyword or reference to generate`
                  : fromShopSignal
                  ? "Product loaded · Choose a reference or add keyword before generating"
                  : fromPlan
                    ? "Weekly plan loaded · Reference ready · Product optional"
                    : fromWorkspace
                      ? "Opportunity loaded · Reference ready · Product optional"
                      : "Brief loaded · Reference ready · Product optional"}
          </span>
        </div>
        <div style={{display:"flex",gap:6,flexShrink:0,alignItems:"center"}}>
          {/* Autosave indicator */}
          {draftInfo?.autosaveLabel && (
            <span style={{fontSize:"10px",color:"#94A3B8",fontWeight:500,whiteSpace:"nowrap"}}>{draftInfo.autosaveLabel}</span>
          )}
          {/* History button — navigates to the full-page history */}
          {onOpenHistory && (
            <a href="/app/history" style={{display:"flex",alignItems:"center",gap:5,padding:"5px 12px",fontSize:"11px",fontWeight:600,borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",color:"#64748B",textDecoration:"none"}}>
              <Clock style={{width:12,height:12}}/> History
            </a>
          )}
          {/* Active generation indicator — shown when a session is running */}
          {generating && (
            <a href="/app/history" style={{display:"flex",alignItems:"center",gap:5,padding:"5px 12px",fontSize:"11px",fontWeight:700,borderRadius:8,border:"1px solid rgba(192,38,211,0.3)",background:"rgba(192,38,211,0.07)",color:"#C026D3",textDecoration:"none",whiteSpace:"nowrap"}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:"#C026D3",animation:"pulse 1.2s ease-in-out infinite"}}/>
              Active generations 1
            </a>
          )}
          {batchInfo && (
            <button type="button" style={{display:"flex",alignItems:"center",gap:5,padding:"5px 12px",fontSize:"11px",fontWeight:600,borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",color:"#64748B",cursor:"pointer"}}>
              <Settings style={{width:12,height:12}}/> Batch settings
            </button>
          )}
          {batchInfo && (
            <button type="button" onClick={batchInfo.onExit} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 12px",fontSize:"11px",fontWeight:600,borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",color:"#64748B",cursor:"pointer"}}>
              ↗ Exit batch
            </button>
          )}
        </div>
      </div>

      {/* Draft restored banner */}
      {draftInfo?.restoredAt && (
        <div style={{padding:"7px 20px",background:"rgba(124,58,237,0.06)",borderBottom:"1px solid rgba(124,58,237,0.12)",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <span style={{fontSize:"11px",color:"#7C3AED",fontWeight:600}}>
            ✓ Restored from your last session
            <span style={{fontWeight:400,color:"#9061F9",marginLeft:6}}>
              {new Date(draftInfo.restoredAt).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})}
            </span>
          </span>
          {onClearDraft && (
            <button type="button" onClick={onClearDraft} style={{fontSize:"10px",fontWeight:600,color:"#9061F9",background:"none",border:"none",cursor:"pointer",textDecoration:"underline",padding:0}}>
              Clear draft
            </button>
          )}
        </div>
      )}

      <div style={{flex:1,overflowY:"auto",padding:"20px 24px",display:"flex",flexDirection:"column",gap:24}}>

        {/* Current item header (batch mode) */}
        {batchInfo && (
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:24,height:24,borderRadius:"50%",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <span style={{fontSize:"11px",fontWeight:800,color:"#fff"}}>{currentItemNum}</span>
            </div>
            <p style={{margin:0,fontSize:"14px",fontWeight:700,color:"#0F172A",textTransform:"capitalize",flex:1}}>{keyword}</p>
            {trendChip && <span style={{padding:"2px 10px",borderRadius:20,fontSize:"10px",fontWeight:600,background:trendChip.bg,color:trendChip.color,border:`1px solid ${trendChip.color}25`,whiteSpace:"nowrap"}}>{trendChip.label}</span>}
            <div style={{display:"flex",gap:4,flexShrink:0}}>
              <button type="button" onClick={batchInfo.onPrev} disabled={batchInfo.currentIdx===0}
                style={{width:28,height:28,borderRadius:8,border:"1px solid #E5E7EB",background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:batchInfo.currentIdx===0?"not-allowed":"pointer",opacity:batchInfo.currentIdx===0?0.3:1}}>
                <ChevronDown style={{width:14,height:14,color:"#6B7280",transform:"rotate(90deg)"}}/>
              </button>
              <button type="button" onClick={batchInfo.onNext} disabled={batchInfo.currentIdx===batchInfo.total-1}
                style={{width:28,height:28,borderRadius:8,border:"1px solid #E5E7EB",background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:batchInfo.currentIdx===batchInfo.total-1?"not-allowed":"pointer",opacity:batchInfo.currentIdx===batchInfo.total-1?0.3:1}}>
                <ChevronDown style={{width:14,height:14,color:"#6B7280",transform:"rotate(-90deg)"}}/>
              </button>
            </div>
          </div>
        )}

        {/* ── PRODUCT-LED MODE SECTIONS ── */}
        {/* 1. Product Set — compact horizontal cards */}
        {productLedMode && (
          <CompactProductSet
            products={displayedShopProducts}
            onRemove={(id)=>setPlRemovedIds(prev=>{const n=new Set(prev);n.add(id);return n;})}
            onAddFiles={addProductFiles}
          />
        )}
        {/* 2. Recommended Opportunities — always visible; cards show selected state */}
        {productLedMode && (
          <RecommendedOpportunitiesSection
            products={displayedShopProducts}
            selectedKeyword={productLedOpportunity?.keyword ?? null}
            onSelectOpportunity={opp=>{onSelectProductLedOpportunity?.(opp);}}
          />
        )}
        {/* 3. Selected opportunity summary — compact, shown only when an opportunity is active */}
        {productLedMode && productLedOpportunity && (
          <SelectedOpportunitySummary
            keyword={productLedOpportunity.keyword}
            demandBand={productLedOpportunity.demandBand}
            competitionBand={productLedOpportunity.competitionBand}
            trendState={productLedOpportunity.trendState}
            evidenceSentence={productLedOpportunity.evidenceSentence}
            onClear={() => onSelectProductLedOpportunity?.(null)}
          />
        )}
        {/* 4. Style References */}
        {productLedMode && (
          <StyleReferencePicker
            recommendedPins={planPinSamples}
            selectedRefs={selectedPlanRefs}
            onToggle={onTogglePlanRef}
            customStyleRef={customStyleRef}
            setCustomStyleRef={setCustomStyleRef}
            hasOpportunity={!!productLedOpportunity}
            opportunityCategory={productLedOpportunity?.category}
            opportunityKeyword={productLedOpportunity?.keyword}
          />
        )}

        {/* ── STYLE REFERENCES (non-product-led) ── */}
        {!productLedMode && (()=>{
          const allRefs = [...selectedPlanRefs, ...(customStyleRef && !selectedPlanRefs.includes(customStyleRef) ? [customStyleRef] : [])];
          const hasPreloaded = (fromPlan||fromWorkspace||fromBatch) && planPinSamples.length>0;
          return (
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <div>
                  <SectionLabel>
                    Style References
                    {allRefs.length>0&&<span style={{marginLeft:6,color:"#C026D3",fontSize:"10px",textTransform:"none",letterSpacing:"normal",fontWeight:700}}>{allRefs.length} reference{allRefs.length!==1?"s":""} selected</span>}
                    {allRefs.length===0&&<span style={{marginLeft:6,color:"#94A3B8",fontSize:"10px",textTransform:"none",letterSpacing:"normal",fontWeight:500}}>Optional</span>}
                  </SectionLabel>
                  <SectionHelper>Optional: choose a visual direction for mood, layout, and composition.</SectionHelper>
                </div>
                {allRefs.length>0 && (
                  <button type="button" onClick={()=>{setCustomStyleRef(null);selectedPlanRefs.forEach(r=>onTogglePlanRef(r));}} style={{fontSize:"10px",color:"#94A3B8",background:"none",border:"none",cursor:"pointer",fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>Clear</button>
                )}
              </div>

              {/* Preloaded plan/workspace refs */}
              {hasPreloaded && (
                <>
                  {selectedPlanRefs.length > 1 && (
                    <p style={{margin:"0 0 8px",fontSize:"10px",color:"#C026D3",fontWeight:600}}>
                      Each selected reference creates its own style group · {selectedPlanRefs.length} × {count} = {selectedPlanRefs.length*count} pins
                    </p>
                  )}
                  <div style={{marginBottom:8}}>
                    <PlanRefSection pins={planPinSamples} selectedRefs={selectedPlanRefs} onToggle={onTogglePlanRef}/>
                  </div>
                </>
              )}

              {/* Thumbnail strip of custom/selected refs */}
              {allRefs.length>0 && !hasPreloaded && (
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                  {allRefs.map((ref,i)=>(
                    <div key={i} style={{position:"relative",width:48,height:64,borderRadius:7,overflow:"hidden",border:"1px solid #E5E7EB"}}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={ref} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
                      <button type="button"
                        onClick={()=>{ if(customStyleRef===ref)setCustomStyleRef(null); else onTogglePlanRef(ref); }}
                        style={{position:"absolute",top:2,right:2,width:14,height:14,borderRadius:"50%",background:"rgba(0,0,0,0.55)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        <X style={{width:8,height:8,color:"#fff"}}/>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add style references button */}
              <button type="button"
                onClick={()=>{ setPickerRole("style_reference"); setPickerOpen(true); }}
                style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:7,padding:"9px 14px",borderRadius:10,border:"1.5px solid #E5E7EB",background:"#FAFAFA",fontSize:"11px",fontWeight:700,color:"#374151",cursor:"pointer"}}>
                <ImagePlus style={{width:13,height:13,color:"#7C3AED"}}/> {allRefs.length>0?"Add more references":"Add style references"}
              </button>
              <p style={{margin:"5px 0 0",fontSize:"9px",color:"#94A3B8"}}>Upload a reference or choose saved visual references.</p>

              {/* Legacy file input kept for drop/upload fallback */}
              <input ref={customRefFileRef} type="file" accept="image/*" className="hidden"
                onChange={e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>setCustomStyleRef(ev.target?.result as string??null);r.readAsDataURL(f);}}/>
            </div>
          );
        })()}

        {/* ── OPTIONAL PRODUCT (non-product-led) ── */}
        {!productLedMode && (()=>{
          if (usingShared) return (
            <div>
              <SectionLabel>Product Set</SectionLabel>
              <div style={{marginTop:8,borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,background:"rgba(6,182,212,0.06)",border:"1px solid rgba(6,182,212,0.2)"}}>
                <p style={{margin:0,fontSize:"11px",fontWeight:600,color:"#0891B2"}}>Using shared product for this batch.</p>
                <button type="button" onClick={()=>productFileRef.current?.click()} style={{fontSize:"10px",fontWeight:600,color:"#0891B2",background:"none",border:"none",cursor:"pointer",whiteSpace:"nowrap"}}>Upload different →</button>
              </div>
              <input ref={productFileRef} type="file" accept="image/*" multiple className="hidden" onChange={e=>e.target.files&&addProductFiles(e.target.files)}/>
            </div>
          );
          return (
            <div>
              {/* Shop Signal product image banner — shown when product_image_url was passed via URL */}
              {shopSignalImageUrl && myProductImages.length === 0 && (
                <div style={{marginBottom:10,borderRadius:10,border:"1px solid rgba(192,38,211,0.2)",background:"rgba(192,38,211,0.04)",padding:"10px 12px",display:"flex",alignItems:"center",gap:12}}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={toProxyUrl(shopSignalImageUrl)} alt="product" style={{width:52,height:52,borderRadius:8,objectFit:"cover",border:"1px solid #E5E7EB",flexShrink:0}}
                    onError={e=>{e.currentTarget.style.display="none";}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{margin:0,fontSize:"11px",fontWeight:700,color:"#C026D3"}}>Product from signal</p>
                    <p style={{margin:"2px 0 0",fontSize:"10px",color:"#94A3B8"}}>Upload your own image to replace, or use as-is</p>
                  </div>
                </div>
              )}

              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <div>
                  <SectionLabel>
                    Product Images
                    {myProductImages.length>0&&<span style={{marginLeft:6,color:"#C026D3",fontSize:"10px",textTransform:"none",letterSpacing:"normal",fontWeight:700}}>{myProductImages.length} product{myProductImages.length!==1?"s":""} selected</span>}
                    {myProductImages.length===0&&!myProductUrl&&!shopSignalImageUrl&&<span style={{marginLeft:6,color:"#94A3B8",fontSize:"10px",textTransform:"none",letterSpacing:"normal",fontWeight:500}}>Optional</span>}
                  </SectionLabel>
                  <SectionHelper>Add the product or item you want to feature.</SectionHelper>
                </div>
                {(myProductImages.length>0||myProductUrl) && (
                  <button type="button" onClick={()=>{setMyProductImages([]);setMyProductUrl("");setMyProductName("");setShowLinkMode(false);}} style={{fontSize:"10px",color:"#94A3B8",background:"none",border:"none",cursor:"pointer",fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>Clear</button>
                )}
              </div>

              {/* Re-upload notice — shown when a previous session had product images */}
              {draftInfo?.hadProductImages && myProductImages.length === 0 && !myProductUrl && (
                <div style={{marginBottom:8,padding:"7px 10px",borderRadius:8,background:"rgba(245,158,11,0.07)",border:"1px solid rgba(245,158,11,0.2)",display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontSize:"11px",color:"#B45309",fontWeight:600}}>⚠ Product image needs re-upload</span>
                  <span style={{fontSize:"10px",color:"#92400E"}}>— not saved across sessions</span>
                </div>
              )}

              {/* Multi-product grid */}
              {myProductImages.length>0 && (
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6,marginBottom:10}}>
                  {myProductImages.map((img,idx)=>(
                    <div key={idx} style={{position:"relative",aspectRatio:"1/1",borderRadius:8,overflow:"hidden",border:"1px solid #E5E7EB"}}>
                      <Image src={img} alt={`product ${idx+1}`} fill className="object-cover" unoptimized/>
                      <button type="button" onClick={()=>setMyProductImages(myProductImages.filter((_,i)=>i!==idx))}
                        style={{position:"absolute",top:2,right:2,width:16,height:16,borderRadius:"50%",background:"rgba(0,0,0,0.6)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        <X style={{width:9,height:9,color:"#fff"}}/>
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={()=>productFileRef.current?.click()} style={{aspectRatio:"1/1",borderRadius:8,border:"1.5px dashed #E5E7EB",background:"#FAFAFA",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"#D1D5DB"}}>+</button>
                </div>
              )}

              {/* Single product layout (1 product): thumbnail left + button right */}
              {myProductImages.length===1 && !showLinkMode && (
                <div style={{display:"flex",alignItems:"flex-start",gap:12,marginBottom:8}}>
                  <div style={{width:80,height:80,borderRadius:10,overflow:"hidden",border:"1px solid #E5E7EB",flexShrink:0}}>
                    <Image src={myProductImages[0]} alt="product" width={80} height={80} className="object-cover" unoptimized/>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:8,flex:1}}>
                    <button type="button" onClick={()=>{ setPickerRole("product"); setPickerOpen(true); }} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"8px 14px",borderRadius:8,border:"1.5px solid rgba(192,38,211,0.4)",background:"rgba(192,38,211,0.04)",fontSize:"11px",fontWeight:700,color:"#C026D3",cursor:"pointer"}}>
                      <ImagePlus style={{width:13,height:13}}/> Add products
                    </button>
                    <button type="button" onClick={()=>productFileRef.current?.click()} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"8px 14px",borderRadius:8,border:"1px solid #E5E7EB",background:"#FAFAFA",fontSize:"11px",fontWeight:600,color:"#6B7280",cursor:"pointer"}}>
                      <Upload style={{width:13,height:13}}/> Upload directly
                    </button>
                  </div>
                </div>
              )}

              {/* Empty state (no products, no link mode) */}
              {myProductImages.length===0 && !showLinkMode && !myProductUrl && (
                <div>
                  <button type="button"
                    onClick={()=>{ setPickerRole("product"); setPickerOpen(true); }}
                    style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:7,padding:"11px 16px",borderRadius:10,border:"1.5px solid rgba(192,38,211,0.4)",background:"rgba(192,38,211,0.04)",fontSize:"12px",fontWeight:700,color:"#C026D3",cursor:"pointer",marginBottom:8}}>
                    <ImagePlus style={{width:14,height:14}}/> Add products
                  </button>
                  {/* Drop zone still available for power users */}
                  <div style={{borderRadius:10,border:"1.5px dashed #E5E7EB",background:draggingProduct?"rgba(192,38,211,0.04)":"#FAFAFA",borderColor:draggingProduct?"#C026D3":"#E5E7EB",padding:"10px",textAlign:"center",cursor:"pointer"}}
                    onClick={()=>productFileRef.current?.click()}
                    onDragOver={e=>{e.preventDefault();setDraggingProduct(true);}} onDragLeave={()=>setDraggingProduct(false)}
                    onDrop={e=>{e.preventDefault();setDraggingProduct(false);if(e.dataTransfer.files.length)addProductFiles(e.dataTransfer.files);}}>
                    <p style={{margin:0,fontSize:"10px",color:"#94A3B8",fontWeight:500}}>Or drag &amp; drop product images here</p>
                  </div>
                  <p style={{marginTop:5,fontSize:"9px",color:"#94A3B8"}}>Upload products or choose from recent product images.</p>
                </div>
              )}

              {/* Link mode */}
              {myProductImages.length===0 && showLinkMode && (
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  <input type="url" value={myProductUrl} onChange={e=>setMyProductUrl(e.target.value)} placeholder="Product URL" style={{borderRadius:10,border:"1px solid #E5E7EB",padding:"8px 12px",fontSize:"12px",color:"#374151",outline:"none"}}/>
                  <input type="text" value={myProductName} onChange={e=>setMyProductName(e.target.value)} placeholder="Product name (optional)" style={{borderRadius:10,border:"1px solid #E5E7EB",padding:"8px 12px",fontSize:"12px",color:"#374151",outline:"none"}}/>
                  <div style={{display:"flex",gap:10}}>
                    <button type="button" onClick={()=>{setShowLinkMode(false);setMyProductUrl("");setMyProductName("");}} style={{background:"none",border:"none",cursor:"pointer",fontSize:"10px",color:"#94A3B8",fontWeight:500}}>← Back</button>
                    <button type="button" onClick={()=>productFileRef.current?.click()} style={{display:"flex",alignItems:"center",gap:4,background:"none",border:"none",cursor:"pointer",fontSize:"10px",fontWeight:600,color:"#C026D3"}}>
                      <Upload style={{width:11,height:11}}/> Upload image instead
                    </button>
                  </div>
                </div>
              )}

              {myProductImages.length>0 && (
                <button type="button" onClick={()=>{ setPickerRole("product"); setPickerOpen(true); }} style={{display:"flex",alignItems:"center",gap:4,background:"none",border:"none",cursor:"pointer",fontSize:"10px",fontWeight:600,color:"#C026D3",marginTop:4}}>
                  <ImagePlus style={{width:11,height:11}}/> Add more products
                </button>
              )}
              <input ref={productFileRef} type="file" accept="image/*" multiple className="hidden" onChange={e=>e.target.files&&addProductFiles(e.target.files)}/>
            </div>
          );
        })()}

        {/* Shop Signal product thumbnails — non-product-led only (product-led uses CompactProductSet above) */}
        {!productLedMode && fromShopSignal && (shopProducts.length > 0 || shopProduct) && (
          <div style={{borderRadius:10,padding:"12px 14px",background:"rgba(192,38,211,0.04)",border:"1px solid rgba(192,38,211,0.18)"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
              <ShoppingBag style={{width:12,height:12,color:"#C026D3",flexShrink:0}}/>
              <span style={{fontSize:"11px",fontWeight:700,color:"#C026D3"}}>
                {(shopProducts.length > 0 ? shopProducts.length : 1)} product{(shopProducts.length > 1 || shopProducts.length === 0 && !shopProduct) ? "s" : ""} from signal
              </span>
              <span style={{fontSize:"10px",color:"#94A3B8",marginLeft:2}}>— will be featured in generated Pins</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min((shopProducts.length > 0 ? shopProducts.length : 1), 5)},1fr)`,gap:8}}>
              {(shopProducts.length > 0 ? shopProducts : shopProduct ? [shopProduct] : []).map((pr: PlanProduct) => (
                <div key={pr.id} style={{display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{aspectRatio:"1/1",borderRadius:8,overflow:"hidden",border:"1px solid #E5E7EB",background:"#F1F5F9",position:"relative"}}>
                    {pr.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={pr.image_url} alt={pr.product_name}
                        style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}
                        onError={e=>{e.currentTarget.style.display="none";}}/>
                    ) : (
                      <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        <ShoppingBag style={{width:20,height:20,color:"#D1D5DB"}}/>
                      </div>
                    )}
                  </div>
                  <p style={{margin:0,fontSize:"9px",color:"#64748B",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.3}}>
                    {pr.product_name}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Market Angle — hidden in product-led mode (products are the subject, not a market angle) */}
        {!productLedMode && (planProducts.length>0||!!shopProduct||shopProducts.length>0) && (
          marketAngleActive ? (
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div><p style={{margin:0,fontSize:"10px",fontWeight:700,color:"#F59E0B"}}>✓ Market angle applied</p><p style={{margin:"2px 0 0",fontSize:"10px",color:"#94A3B8"}}>Buyer intent guides positioning. Images will not be copied.</p></div>
              <button type="button" onClick={()=>setMarketAngleActive(false)} style={{fontSize:"10px",color:"#94A3B8",background:"none",border:"none",cursor:"pointer",fontWeight:600,flexShrink:0}}>Remove</button>
            </div>
          ) : (
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <div style={{flex:1}}><p style={{margin:0,fontSize:"10px",fontWeight:600,color:"#374151"}}>Market angle available</p><p style={{margin:"1px 0 0",fontSize:"10px",color:"#94A3B8"}}>Use Shop Signals to shape buyer intent.</p></div>
              <button type="button" onClick={()=>setMarketAngleActive(true)} style={{padding:"5px 10px",borderRadius:7,border:"1px solid rgba(245,158,11,0.3)",background:"rgba(245,158,11,0.07)",fontSize:"10px",fontWeight:700,color:"#F59E0B",cursor:"pointer",flexShrink:0}}>Apply</button>
            </div>
          )
        )}

        {idea && (
          <div style={{borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"flex-start",gap:10,background:"rgba(8,145,178,0.06)",border:"1px solid rgba(8,145,178,0.18)"}}>
            <Zap style={{width:14,height:14,color:"#C026D3",flexShrink:0,marginTop:1}}/>
            <div><p style={{margin:0,fontSize:"9px",fontWeight:800,color:"#C026D3",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:3}}>Content Idea Active</p><p style={{margin:0,fontSize:"11px",color:"#374151",fontWeight:600}}>{idea}</p></div>
          </div>
        )}

        {/* ── GENERATION INSTRUCTIONS ── */}
        <div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <SectionLabel>Generation Instructions</SectionLabel>
            {promptEdited && (
              <span style={{fontSize:"10px",fontWeight:700,color:"#7C3AED",background:"rgba(124,58,237,0.08)",padding:"1px 8px",borderRadius:20,border:"1px solid rgba(124,58,237,0.15)"}}>
                ✎ Custom
              </span>
            )}
          </div>

          {/* ── Structured prompt summary — always visible ── */}
          {(() => {
            const allRefs = [...selectedPlanRefs, ...(customStyleRef && !selectedPlanRefs.includes(customStyleRef) ? [customStyleRef] : [])];
            const refProfiles = allRefs.map(refUrl => {
              const pinMeta = planPinSamples.find(p => p.image_url === refUrl);
              return {
                url:     refUrl,
                profile: inferReferenceProfile(refUrl, pinMeta?.source_keyword ?? productLedOpportunity?.keyword ?? null, catLow),
              };
            });
            const hasRefs   = allRefs.length > 0;
            const mode      = productLedMode ? (hasRefs ? "Reference-guided" : "Auto Style") : (hasRefs ? "Reference-guided" : "Brief-driven");
            const promptType = productLedMode
              ? `Product-led ${catDisplayName(catLow).toLowerCase()} prompt`
              : keyword ? "Keyword-driven prompt" : "Auto-filled prompt";

            function fmtLabel(vf: string): string {
              const m: Record<string,string> = {
                on_body:"On-body",mirror_selfie:"Mirror style",flat_lay:"Flat lay",
                room_scene:"Room scene",product_only:"Product only",unknown:"",
              };
              return m[vf] ?? "";
            }
            function hpLabel(hp: string): string {
              const m: Record<string,string> = { visible_person:"person",no_person:"no person",unknown:"" };
              return m[hp] ?? "";
            }

            return (
              <div style={{borderRadius:10,border:"1px solid #E5E7EB",background:"#F8FAFC",padding:"12px 14px",display:"flex",flexDirection:"column",gap:10}}>
                {/* Row 1: Prompt type + mode */}
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8}}>
                  <p style={{margin:0,fontSize:"12px",fontWeight:700,color:"#0F172A"}}>{promptType}</p>
                  <span style={{fontSize:"9px",fontWeight:700,padding:"2px 7px",borderRadius:20,whiteSpace:"nowrap",
                    background: hasRefs ? "rgba(124,58,237,0.08)" : "rgba(16,185,129,0.08)",
                    color:      hasRefs ? "#7C3AED"               : "#059669",
                    border:    `1px solid ${hasRefs ? "rgba(124,58,237,0.2)" : "rgba(16,185,129,0.2)"}`,
                  }}>{mode}</span>
                </div>

                {/* Row 2: Setup summary chips */}
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {productLedMode && displayedShopProducts.length > 0 && (
                    <span style={{fontSize:"9px",fontWeight:600,color:"#64748B",background:"#F1F5F9",padding:"2px 7px",borderRadius:20,border:"1px solid #E5E7EB"}}>
                      {displayedShopProducts.length} product{displayedShopProducts.length!==1?"s":""}
                    </span>
                  )}
                  {hasRefs ? (
                    <span style={{fontSize:"9px",fontWeight:600,color:"#C026D3",background:"rgba(192,38,211,0.06)",padding:"2px 7px",borderRadius:20,border:"1px solid rgba(192,38,211,0.2)"}}>
                      {allRefs.length} reference{allRefs.length!==1?"s":""} · {allRefs.length} style group{allRefs.length!==1?"s":""}
                    </span>
                  ) : (
                    <span style={{fontSize:"9px",fontWeight:600,color:"#059669",background:"rgba(16,185,129,0.06)",padding:"2px 7px",borderRadius:20,border:"1px solid rgba(16,185,129,0.2)"}}>Auto Style</span>
                  )}
                  <span style={{fontSize:"9px",fontWeight:600,color:"#64748B",background:"#F1F5F9",padding:"2px 7px",borderRadius:20,border:"1px solid #E5E7EB"}}>No text overlay</span>
                </div>

                {/* Row 3: Per-reference composition chips */}
                {refProfiles.length > 0 && (
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {refProfiles.map(({url, profile}, i) => {
                      const vf = fmtLabel(profile.visualFormat);
                      const hp = hpLabel(profile.humanPresence);
                      const isUpload = url.startsWith("data:") || url.startsWith("blob:");
                      const label = [vf||"Unknown format", hp, isUpload ? "uploaded" : null].filter(Boolean).join(" · ");
                      return (
                        <div key={i} style={{display:"flex",alignItems:"center",gap:6}}>
                          <div style={{width:4,height:4,borderRadius:"50%",background:"#C026D3",flexShrink:0}}/>
                          <span style={{fontSize:"10px",color:"#374151",fontWeight:500}}>
                            Ref {i+1}: <span style={{color:"#7C3AED"}}>{label}</span>
                            {profile.humanPresence==="visible_person" && <span style={{color:"#94A3B8"}}> · face hidden</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Row 4: Prompt preview */}
                {promptText && (
                  <div>
                    <p style={{margin:"0 0 4px",fontSize:"9px",fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.07em"}}>Prompt preview</p>
                    <p style={{margin:0,fontSize:"10px",color:"#374151",lineHeight:1.6,background:"#fff",padding:"8px 10px",borderRadius:7,border:"1px solid #F1F5F9",
                      display:"-webkit-box",WebkitLineClamp:4,WebkitBoxOrient:"vertical",overflow:"hidden",
                    }}>
                      {/* Show the actual prompt that would be sent for group 1 */}
                      {refProfiles.length > 0
                        ? buildGroupPrompt(promptText, allRefs[0] ?? null, refProfiles[0]?.profile ?? {visualFormat:"unknown",humanPresence:"unknown",sourceKeyword:null}, 1, allRefs.length, catLow).slice(0, 400)
                        : promptText.slice(0, 400)}
                      {promptText.length > 400 && "…"}
                    </p>
                  </div>
                )}

                {/* Row 5: Edit button */}
                <button type="button" onClick={()=>setPromptOpen(o=>!o)}
                  style={{alignSelf:"flex-start",padding:"5px 12px",borderRadius:8,border:"1px solid rgba(124,58,237,0.3)",background:"rgba(124,58,237,0.06)",color:"#7C3AED",fontSize:"11px",fontWeight:700,cursor:"pointer"}}>
                  {promptOpen ? "Close editor ↑" : "Edit full prompt ↓"}
                </button>
              </div>
            );
          })()}

          {/* Expanded prompt editor — optional */}
          {promptOpen && (
            <div style={{marginTop:8}}>
              {promptEdited && (
                <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginBottom:6}}>
                  <button type="button" onClick={()=>{setPromptEdited(false);promptEditedRef.current=false;setPromptText(autoPrompt);}} style={{fontSize:"10px",color:"#C026D3",fontWeight:600,background:"none",border:"none",cursor:"pointer"}}>Reset to brief</button>
                  <button type="button" onClick={()=>{setPromptEdited(true);promptEditedRef.current=true;setPromptText("");}} style={{fontSize:"10px",color:"#94A3B8",fontWeight:600,background:"none",border:"none",cursor:"pointer"}}>Clear</button>
                </div>
              )}
              <div style={{position:"relative"}}>
                <textarea
                  value={promptText}
                  onChange={e=>{if(e.target.value.length<=MAX_PROMPT_LEN){setPromptEdited(true);promptEditedRef.current=true;setPromptText(e.target.value);}}}
                  rows={6}
                  style={{width:"100%",borderRadius:10,border:"1px solid #E5E7EB",padding:"12px 14px",fontSize:"12px",lineHeight:1.6,resize:"none",outline:"none",color:"#374151",fontFamily:"inherit",background:"#FAFAFA",boxSizing:"border-box"}}
                  placeholder="Describe what you want to generate…"
                />
                <p style={{textAlign:"right",fontSize:"10px",color:promptText.length>MAX_PROMPT_LEN*0.9?"#D97706":"#94A3B8",marginTop:3,fontWeight:500}}>
                  {promptText.length} / {MAX_PROMPT_LEN}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── GENERATED PINS ── */}
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <SectionLabel>
              Generated Pins{generatedImages.length>0&&` (${generatedImages.length})`}
            </SectionLabel>
            {generatedGroups.length>1&&<span style={{fontWeight:500,fontSize:"10px",color:"#C026D3"}}>· {generatedGroups.length} reference groups</span>}
          </div>
          {generatedImages.length > 0 && (
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6,flexWrap:"wrap"}}>
              <span style={{fontSize:"11px",color:"#64748B",flex:1,minWidth:0}}>
                {selectedPinUrls.size > 0
                  ? `${selectedPinUrls.size} selected`
                  : planPinUrls.size >= generatedImages.length
                    ? `${generatedImages.length} pins generated · Added to Weekly Plan`
                    : planPinUrls.size > 0
                      ? `${generatedImages.length} pins generated · ${planPinUrls.size} added to plan`
                      : `${generatedImages.length} pin${generatedImages.length!==1?"s":""} generated · 0 added to plan`}
              </span>
              {selectedPinUrls.size > 0 ? (
                <button type="button" onClick={()=>addPinsToWeeklyPlan([...selectedPinUrls])} style={{padding:"4px 10px",borderRadius:6,fontSize:"11px",fontWeight:700,background:"rgba(192,38,211,0.08)",color:"#C026D3",border:"1px solid rgba(192,38,211,0.2)",cursor:"pointer",whiteSpace:"nowrap"}}>
                  Add selected to Plan
                </button>
              ) : planPinUrls.size > 0 && planPinUrls.size < generatedImages.length ? (
                <button type="button" onClick={()=>addPinsToWeeklyPlan(generatedImages.filter(u=>!planPinUrls.has(u)))} style={{padding:"4px 10px",borderRadius:6,fontSize:"11px",fontWeight:700,background:"rgba(192,38,211,0.08)",color:"#C026D3",border:"1px solid rgba(192,38,211,0.2)",cursor:"pointer",whiteSpace:"nowrap"}}>
                  Add remaining to Plan
                </button>
              ) : null}
              {planPinUrls.size >= generatedImages.length && generatedImages.length > 0 ? (
                <a href="/app/plan" style={{padding:"4px 10px",borderRadius:6,fontSize:"11px",fontWeight:700,background:"rgba(16,185,129,0.08)",color:"#059669",border:"1px solid rgba(16,185,129,0.2)",cursor:"pointer",whiteSpace:"nowrap",textDecoration:"none"}}>
                  View in Weekly Plan
                </a>
              ) : (
                <button type="button" onClick={()=>addPinsToWeeklyPlan(generatedImages)} style={{padding:"4px 10px",borderRadius:6,fontSize:"11px",fontWeight:700,background:"rgba(16,185,129,0.06)",color:"#059669",border:"1px solid rgba(16,185,129,0.2)",cursor:"pointer",whiteSpace:"nowrap"}}>
                  Add all to Plan
                </button>
              )}
            </div>
          )}
          {generatedImages.length===0 ? (
            <p style={{marginTop:8,fontSize:"11px",color:"#94A3B8"}}>Your generated Pin options will appear here after you click Generate.</p>
          ) : (
            <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:16}}>
              {generatedGroups.map((group,gi)=>(
                <div key={gi}>
                  {generatedGroups.length>1 && (
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      {group.refUrl && <div style={{width:24,height:32,borderRadius:4,overflow:"hidden",border:"1px solid #E5E7EB",flexShrink:0}}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={group.refUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/></div>}
                      <div>
                        <p style={{margin:0,fontSize:"10px",fontWeight:700,color:"#374151",textTransform:"uppercase",letterSpacing:"0.07em"}}>Reference Style {gi+1}</p>
                        <p style={{margin:"1px 0 0",fontSize:"9px",color:"#94A3B8"}}>{group.images.length} pin{group.images.length!==1?"s":""} generated from this reference</p>
                      </div>
                      <div style={{flex:1,height:1,background:"#F1F5F9"}}/>
                      <button type="button" onClick={()=>addPinsToWeeklyPlan(group.images)} style={{padding:"3px 8px",borderRadius:5,fontSize:"9px",fontWeight:700,background:"rgba(16,185,129,0.06)",color:"#059669",border:"1px solid rgba(16,185,129,0.2)",cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                        Add group to Plan
                      </button>
                    </div>
                  )}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                    {group.images.map((src,imgIdx)=>{
                      const gIdx      = generatedGroups.slice(0,gi).flatMap(g=>g.images).length+imgIdx;
                      const isSched   = scheduledImages?.has(src)??false;
                      const isSelPin  = selectedPinUrls.has(src);
                      const isInPlan  = planPinUrls.has(src);
                      return (
                        <div key={imgIdx} data-testid="generated-pin-card" style={{borderRadius:10,overflow:"hidden",border:`1px solid ${isSelPin?"#C026D3":"#F1F5F9"}`,background:"#fff",display:"flex",flexDirection:"column",transition:"border-color 0.15s"}}>
                          <div style={{position:"relative",aspectRatio:"2/3",cursor:"pointer"}} onClick={()=>togglePinSelection(src)}>
                            <Image src={src} alt="" fill className="object-cover" unoptimized/>
                            {isSelPin && <div style={{position:"absolute",inset:0,background:"rgba(192,38,211,0.12)",display:"flex",alignItems:"flex-start",justifyContent:"flex-end",padding:5}}><CheckCircle2 style={{width:14,height:14,color:"#C026D3",filter:"drop-shadow(0 0 2px #fff)"}}/></div>}
                            {isSched && <span style={{position:"absolute",top:5,left:5,fontSize:"8px",fontWeight:800,borderRadius:10,padding:"2px 6px",background:"rgba(16,185,129,0.9)",color:"#fff",display:"flex",alignItems:"center",gap:2}}><CheckCircle2 style={{width:8,height:8}}/> Scheduled</span>}
                            <span style={{position:"absolute",top:5,right:5,fontSize:"8px",fontWeight:700,borderRadius:10,padding:"2px 5px",background:"rgba(255,255,255,0.9)",color:"#374151"}}>#{gIdx+1}</span>
                          </div>
                          <div style={{display:"flex",alignItems:"center",justifyContent:"space-around",padding:"6px 0",borderTop:"1px solid #F1F5F9"}}>
                            <a href={src} download={`pin-${gIdx+1}.jpg`} style={{padding:"4px 8px",color:"#9CA3AF",display:"flex",alignItems:"center"}} onClick={e=>e.stopPropagation()} title="Download">
                              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 15V3m0 12-4-4m4 4 4-4M2 17v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            </a>
                            <button type="button" onClick={e=>{e.stopPropagation();addPinsToWeeklyPlan([src]);}} style={{padding:"4px 8px",color:isInPlan?"#10B981":"#9CA3AF",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center"}} title={isInPlan?"Added to Plan":"Add to Plan"}>
                              <svg width="14" height="14" fill={isInPlan?"currentColor":"none"} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            </button>
                            <button type="button" style={{padding:"4px 8px",color:"#9CA3AF",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center"}} title="Schedule" onClick={e=>{e.stopPropagation();onPublish?.(src);}}>
                              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            </button>
                          </div>
                          {isInPlan && (
                            <div style={{padding:"2px 0",background:"rgba(16,185,129,0.06)",borderTop:"1px solid rgba(16,185,129,0.12)",textAlign:"center"}}>
                              <span style={{fontSize:"9px",color:"#059669",fontWeight:700}}>✓ Added to Plan</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Asset Picker */}
      <CreateAssetPicker
        role={pickerRole}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConfirm={items => {
          if (pickerRole === "product") {
            const urls = items.map(i => i.imageUrl);
            const existing = new Set(myProductImages);
            const toAdd = urls.filter(u => !existing.has(u));
            setMyProductImages([...myProductImages, ...toAdd]);
          } else {
            for (const item of items) {
              if (!selectedPlanRefs.includes(item.imageUrl) && item.imageUrl !== customStyleRef) {
                onTogglePlanRef(item.imageUrl);
              }
            }
          }
        }}
      />

      {/* Preview modal */}
      {previewSrc && (
        <div style={{position:"fixed",inset:0,zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.78)"}} onClick={()=>setPreviewSrc(null)}>
          <div style={{position:"relative",maxHeight:"90vh",maxWidth:"min(480px,90vw)"}}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewSrc} alt="Preview" style={{maxHeight:"90vh",width:"auto",borderRadius:12,display:"block"}} onClick={e=>e.stopPropagation()}/>
            <button type="button" onClick={()=>setPreviewSrc(null)} style={{position:"absolute",top:8,right:8,width:28,height:28,borderRadius:"50%",background:"rgba(0,0,0,0.6)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <X style={{width:14,height:14,color:"#fff"}}/>
            </button>
          </div>
        </div>
      )}

      {/* ── BOTTOM BAR ── */}
      <div data-testid="generation-footer" style={{borderTop:"1px solid #F1F5F9",flexShrink:0,background:"#fff"}}>
        {productLedMode ? (
          // ── Product-led footer: formula layout ───────────────────────────────
          (() => {
            const prodCount = displayedShopProducts.length;
            const refCount  = selectedPlanRefs.length + (customStyleRef && !selectedPlanRefs.includes(customStyleRef) ? 1 : 0);
            const hasOpp    = !!productLedOpportunity;
            const hasRef    = refCount > 0;
            const isReady   = hasOpp && hasRef;
            const pins      = (hasRef ? refCount : 1) * count;
            console.log({
              selectedReferencesLength: selectedPlanRefs.length,
              imagesPerReference: count,
              expectedTotal: pins,
              referenceIds: selectedPlanRefs,
            });
            return (
              <div style={{padding:"10px 20px 10px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                {/* Left: formula */}
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",flex:1,minWidth:0}}>
                  <span style={{fontSize:"11px",fontWeight:600,color:"#0F172A",display:"flex",alignItems:"center",gap:4,whiteSpace:"nowrap"}}>
                    <ShoppingBag style={{width:12,height:12,color:"#C026D3"}}/>
                    <strong style={{color:"#C026D3"}}>{prodCount}</strong> product{prodCount!==1?"s":""}
                  </span>
                  {isReady && <>
                    <span style={{color:"#D1D5DB",fontSize:"11px"}}>·</span>
                    <span style={{fontSize:"11px",fontWeight:600,color:"#0F172A",whiteSpace:"nowrap"}}>
                      <strong style={{color:"#C026D3"}}>{refCount}</strong> reference{refCount!==1?"s":""} selected
                    </span>
                    <span style={{color:"#D1D5DB",fontSize:"11px"}}>·</span>
                  </>}
                  {!isReady && (
                    <span style={{fontSize:"11px",color:"#94A3B8"}}>
                      {hasOpp ? ` · ${productLedOpportunity!.keyword}` : "· No opportunity selected"}
                      {hasOpp ? " · Auto Style" : " · No references selected"}
                    </span>
                  )}
                  {/* Count selector */}
                  <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                    <span style={{fontSize:"11px",color:"#374151",fontWeight:500,whiteSpace:"nowrap"}}>
                      {isReady ? "Images per reference" : "Images per ref"}
                    </span>
                    <div style={{position:"relative"}}>
                      <select data-testid="images-per-reference-input" value={count} onChange={e=>setCount(Number(e.target.value))}
                        style={{appearance:"none",borderRadius:7,border:"1px solid #E5E7EB",background:"#fff",padding:"4px 22px 4px 8px",fontSize:"13px",fontWeight:700,color:"#0F172A",cursor:"pointer",outline:"none"}}>
                        {[1,2,4,6,8].map(n=><option key={n} value={n}>{n}</option>)}
                      </select>
                      <ChevronDown style={{position:"absolute",right:5,top:"50%",transform:"translateY(-50%)",width:11,height:11,color:"#9CA3AF",pointerEvents:"none"}}/>
                    </div>
                    {isReady && <>
                      <span style={{fontSize:"11px",color:"#374151",whiteSpace:"nowrap"}}>
                        {"= "}<strong style={{color:"#374151"}}>{pins} pin{pins!==1?"s":""}</strong>
                      </span>
                    </>}
                  </div>
                </div>
                {/* Right: overlay flag + button */}
                <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                  <span style={{fontSize:"10px",color:"#059669",whiteSpace:"nowrap"}}>✓ No text overlay</span>
                  {generating ? (
                    <button type="button" disabled
                      style={{borderRadius:30,padding:"10px 20px",fontSize:"13px",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",color:"#fff",border:"none",cursor:"not-allowed",opacity:0.6,whiteSpace:"nowrap"}}>
                      <div style={{width:14,height:14,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>
                      {generatingGroupIdx !== null && refCount > 1
                        ? `Ref ${generatingGroupIdx + 1}/${refCount}…`
                        : "Generating…"}
                    </button>
                  ) : isReady ? (
                    <button type="button"
                      onClick={()=>onGenerate({prompt:promptText,refs:selectedPlanRefs.length>0?selectedPlanRefs:customStyleRef?[customStyleRef]:[],productImages:displayedShopProducts.map(p=>p.image_url??null).filter((u): u is string => typeof u === "string"),imagesPerRef:count})}
                      style={{borderRadius:30,padding:"10px 20px",fontSize:"13px",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",color:"#fff",border:"none",cursor:"pointer",whiteSpace:"nowrap"}}>
                      <Sparkles style={{width:15,height:15}}/>Generate {pins} Pin{pins!==1?"s":""}
                    </button>
                  ) : (
                    <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end"}}>
                      <button type="button" disabled
                        style={{borderRadius:30,padding:"10px 18px",fontSize:"13px",fontWeight:700,background:"#F1F5F9",color:"#94A3B8",border:"1px solid #E5E7EB",cursor:"not-allowed",whiteSpace:"nowrap"}}>
                        {!hasOpp ? "Choose opportunity first" : "Choose references first"}
                      </button>
                      <button type="button"
                        title="Less guided — no style reference"
                        onClick={()=>onGenerate({prompt:promptText,refs:[],productImages:displayedShopProducts.map(p=>p.image_url??null).filter((u): u is string => typeof u === "string"),imagesPerRef:count})}
                        style={{background:"none",border:"none",cursor:"pointer",fontSize:"10px",color:"#94A3B8",padding:0,fontWeight:500}}>
                        Products only · <em>Less guided</em>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })()
        ) : (
          // ── Standard footer ───────────────────────────────────────────────────
          <>
            <div style={{padding:"8px 24px 0",display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              {keyword && (
                <span style={{fontSize:"10px",fontWeight:700,color:"#7C3AED",background:"rgba(124,58,237,0.08)",padding:"2px 8px",borderRadius:20,whiteSpace:"nowrap"}}>
                  {catDisplayName(catLow)} mode
                </span>
              )}
              {selectedPlanRefs.length > 1 ? (
                <span style={{fontSize:"10px",color:"#64748B"}}>
                  <strong style={{color:"#C026D3"}}>{selectedPlanRefs.length} references</strong>
                  {" × "}<strong style={{color:"#374151"}}>{count}</strong>
                  {" images each = "}<strong style={{color:"#374151"}}>{totalOutputs} pins</strong>
                  {effectiveProductImages.length > 0 && ` · ${effectiveProductImages.length} product${effectiveProductImages.length > 1 ? "s" : ""}`}
                  {" · No text"}
                </span>
              ) : (
                <span style={{fontSize:"10px",color:"#94A3B8"}}>
                  {[
                    anyStyleRef ? "1 reference selected" : null,
                    effectiveProductImages.length > 0
                      ? `${effectiveProductImages.length} product${effectiveProductImages.length > 1 ? "s" : ""} added`
                      : myProductUrl ? "Product URL added" : null,
                    marketAngleActive ? "Market angle applied" : null,
                    batchInfo ? `${batchInfo.currentIdx + 1} of ${batchInfo.total}` : null,
                  ].filter(Boolean).join(" · ") || "Using brief only"}
                </span>
              )}
              <span style={{fontSize:"10px",color:"#059669",marginLeft:"auto",whiteSpace:"nowrap"}}>✓ No text overlay</span>
            </div>
          </>
        )}

        {/* Standard footer button row — only for non-product-led mode */}
        {!productLedMode && (
        <div style={{padding:"8px 24px 12px",display:"flex",alignItems:"center",gap:10}}>
          {/* Images per reference (or Images when no ref exists) */}
          <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
            <span style={{fontSize:"12px",fontWeight:600,color:"#374151",whiteSpace:"nowrap"}}>
              {selectedPlanRefs.length > 0 || !!customStyleRef ? "Images per reference" : "Images"}
            </span>
            <div style={{position:"relative"}}>
              <select data-testid="images-per-reference-input" value={count} onChange={e=>setCount(Number(e.target.value))} style={{appearance:"none",borderRadius:8,border:"1px solid #E5E7EB",background:"#fff",padding:"6px 28px 6px 10px",fontSize:"13px",fontWeight:700,color:"#0F172A",cursor:"pointer",outline:"none"}}>
                {[1,2,4,6,8].map(n=><option key={n} value={n}>{n}</option>)}
              </select>
              <ChevronDown style={{position:"absolute",right:7,top:"50%",transform:"translateY(-50%)",width:12,height:12,color:"#9CA3AF",pointerEvents:"none"}}/>
            </div>
          </div>

          {/* Generate button — product-led mode shows readiness-aware label */}
          {productLedMode ? (()=>{
            const hasOpp = !!productLedOpportunity;
            const refCount = selectedPlanRefs.length + (customStyleRef && !selectedPlanRefs.includes(customStyleRef) ? 1 : 0);
            const hasRef = refCount > 0;
            const isReady = hasOpp && hasRef;
            const pins = (hasRef ? refCount : 1) * count;
            console.log({
              selectedReferencesLength: selectedPlanRefs.length,
              imagesPerReference: count,
              expectedTotal: pins,
              referenceIds: selectedPlanRefs,
            });
            if (generating) return (
              <button type="button" disabled style={{flex:1,borderRadius:30,padding:"11px 20px",fontSize:"13px",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",color:"#fff",border:"none",cursor:"not-allowed",opacity:0.6}}>
                <div style={{width:16,height:16,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>
                {generatingGroupIdx !== null && refCount > 1
                  ? `Reference ${generatingGroupIdx + 1} of ${refCount}…`
                  : "Generating…"}
              </button>
            );
            if (!isReady) {
              // No opportunity yet → fully blocked
              if (!hasOpp) return (
                <div style={{flex:1,display:"flex",flexDirection:"column",gap:6}}>
                  <button type="button" disabled
                    style={{flex:1,borderRadius:30,padding:"11px 20px",fontSize:"13px",fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"#F1F5F9",color:"#94A3B8",border:"1px solid #E5E7EB",cursor:"not-allowed"}}>
                    Choose an opportunity first
                  </button>
                  <p style={{margin:0,fontSize:"10px",color:"#94A3B8",textAlign:"center"}}>
                    Select an opportunity above, or generate from products only
                  </p>
                </div>
              );
              // Opportunity chosen but no references → offer Auto Style as primary
              return (
                <div style={{flex:1,display:"flex",flexDirection:"column",gap:6}}>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <button type="button"
                      onClick={()=>onGenerate({prompt:promptText,refs:[],productImages:displayedShopProducts.map(p=>p.image_url??null).filter((u): u is string => typeof u === "string"),imagesPerRef:count})}
                      style={{flex:1,borderRadius:30,padding:"10px 20px",fontSize:"12px",fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"#7C3AED",color:"#fff",border:"none",cursor:"pointer"}}>
                      <Sparkles style={{width:14,height:14}}/> Generate with Auto Style
                    </button>
                  </div>
                  <p style={{margin:0,fontSize:"10px",color:"#94A3B8",textAlign:"center",lineHeight:1.4}}>
                    Auto Style uses your products, opportunity, and category playbook.{" "}
                    <span style={{color:"#C026D3",fontWeight:600}}>Select references above for guided results.</span>
                  </p>
                </div>
              );
            }
            return (
              <button type="button"
                data-testid="generate-pins-button"
                onClick={()=>onGenerate({prompt:promptText,refs:selectedPlanRefs.length>0?selectedPlanRefs:customStyleRef?[customStyleRef]:[],productImages:displayedShopProducts.map(p=>p.image_url??null).filter((u): u is string => typeof u === "string"),imagesPerRef:count})}
                style={{flex:1,borderRadius:30,padding:"11px 20px",fontSize:"13px",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",color:"#fff",border:"none",cursor:"pointer",transition:"opacity 0.15s"}}>
                <Sparkles style={{width:16,height:16}}/>Generate {pins} Pin{pins!==1?"s":""}
              </button>
            );
          })() : (
            <button
              type="button"
              data-testid="generate-pins-button"
              onClick={() => onGenerate({
                prompt: promptText,
                refs: selectedPlanRefs.length > 0 ? selectedPlanRefs : (customStyleRef ? [customStyleRef] : []),
                productImages: effectiveProductImages,
                imagesPerRef: count,
              })}
              disabled={generating || !keyword}
              style={{flex:1,borderRadius:30,padding:"11px 20px",fontSize:"13px",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",color:"#fff",border:"none",cursor:generating||!keyword?"not-allowed":"pointer",opacity:generating||!keyword?0.5:1,transition:"opacity 0.15s"}}
            >
              {generating ? (
                <>
                  <div style={{width:16,height:16,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>
                  {generatingGroupIdx !== null && totalOutputs > count
                    ? `Reference ${generatingGroupIdx + 1} of ${selectedPlanRefs.length}…`
                    : "Generating…"}
                </>
              ) : (
                <><Sparkles style={{width:16,height:16}}/>Generate {totalOutputs} Pin{totalOutputs !== 1 ? "s" : ""}</>
              )}
            </button>
          )}

          {/* Next opportunity */}
          {batchInfo && batchInfo.currentIdx<batchInfo.total-1 && (
            <button type="button" onClick={batchInfo.onNext} style={{flexShrink:0,borderRadius:30,padding:"11px 16px",fontSize:"12px",fontWeight:700,background:"#fff",color:"#374151",border:"1px solid #E5E7EB",cursor:"pointer",whiteSpace:"nowrap"}}>
              Next opportunity →
            </button>
          )}
          {!keyword && !productLedMode && (
            <p style={{fontSize:"11px",color:"#94A3B8",display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
              <AlertCircle style={{width:12,height:12}}/> Select a trend first
            </p>
          )}
        </div>
        )}
      </div>
    </main>
  );
}

// ── Publishing Queue ───────────────────────────────────────────────────────────
function PublishPanel({ queueItems, onOpenPublish }: { queueItems:typeof MOCK_QUEUE; onOpenPublish:()=>void }) {
  const [open, setOpen] = useState(false);
  const pending = queueItems.filter(i=>!i.done).length;
  if (!open) return (
    <aside className="shrink-0 flex flex-col items-center py-4 gap-3 cursor-pointer hover:bg-gray-50 bg-white" style={{width:36,borderLeft:"1px solid #E5E7EB"}} onClick={()=>setOpen(true)}>
      <button type="button" className="rounded-full p-1.5 hover:bg-gray-100"><Send className="h-4 w-4 text-gray-400"/></button>
      <span className="text-[9px] font-black uppercase tracking-widest text-gray-300" style={{writingMode:"vertical-rl",transform:"rotate(180deg)"}}>Publish</span>
      {pending>0 && <span className="text-[9px] font-black rounded-full w-4 h-4 flex items-center justify-center" style={{background:"rgba(192,38,211,0.08)",color:"#C026D3"}}>{pending}</span>}
    </aside>
  );
  return (
    <aside className="w-64 shrink-0 flex flex-col overflow-hidden bg-white" style={{borderLeft:"1px solid #E5E7EB"}}>
      <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
        <div><h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Send className="h-4 w-4 text-[#C026D3]"/> Publishing Queue</h3><p className="text-[11px] text-gray-500 mt-0.5">{pending} pending</p></div>
        <button type="button" onClick={()=>setOpen(false)} className="rounded-full p-1.5 hover:bg-gray-100 text-gray-400"><X className="h-3.5 w-3.5"/></button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2">
        {queueItems.length===0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center"><Clock className="h-6 w-6 text-gray-300 mb-2"/><p className="text-[11px] text-gray-400">No scheduled pins yet</p></div>
        ) : queueItems.map((item,i)=>(
          <div key={i} className="rounded-xl px-3 py-2.5 flex items-center gap-2.5" style={{background:item.done?"rgba(8,145,178,0.05)":"#F9FAFB",border:`1px solid ${item.done?"rgba(8,145,178,0.15)":"#E5E7EB"}`}}>
            <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${item.done?"text-[#10B981]":"text-gray-300"}`}/>
            <div className="min-w-0 flex-1">
              <p className={`text-[11px] font-semibold truncate ${item.done?"text-gray-400 line-through":"text-gray-700"}`}>{item.keyword}</p>
              <p className="text-[10px] text-gray-400">{item.board} · {item.time}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="p-4 border-t border-gray-100">
        <button type="button" onClick={onOpenPublish} className="w-full rounded-full py-3 text-[13px] font-bold flex items-center justify-center gap-2 transition-all hover:scale-[1.02]" style={{background:"linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",color:"#fff"}}>
          <Send className="h-4 w-4"/> Schedule Pins
        </button>
        <p className="text-center text-[10px] text-gray-400 mt-2">Mock publish · no OAuth needed</p>
      </div>
    </aside>
  );
}

// ── Schedule Modal ─────────────────────────────────────────────────────────────
type ScheduleTimeSlot = "next"|"tomorrow"|"custom";
function ScheduleModal({ open,generatedImages,initialImageUrl,keyword,onClose,onSuccess }: {
  open:boolean; generatedImages:string[]; initialImageUrl:string|null;
  keyword:string; onClose:()=>void;
  onSuccess:(imageUrl:string,scheduledAt:string,boardName:string,jobId?:string)=>void;
}) {
  const [selectedImage,setSelectedImage] = useState("");
  const [boardId,setBoardId]             = useState(MOCK_BOARDS[0].id);
  const [timeSlot,setTimeSlot]           = useState<ScheduleTimeSlot>("next");
  const [customDate,setCustomDate]       = useState("");
  const [scheduling,setScheduling]       = useState(false);
  useEffect(()=>{ /* eslint-disable-next-line react-hooks/set-state-in-effect */ if(open) setSelectedImage(initialImageUrl??generatedImages[0]??""); },[open,initialImageUrl,generatedImages]);
  if (!open) return null;
  const next=getNextAvailableSlot(); const tom=getTomorrowMorning();
  const SLOTS:[ScheduleTimeSlot,string,string][] = [["next","Next Available Slot",formatSlotLabel(next)],["tomorrow","Tomorrow Morning",formatSlotLabel(tom)],["custom","Custom Date","Pick any date and time"]];
  function resolvedAt():string { if(timeSlot==="custom"&&customDate)return new Date(customDate).toISOString(); if(timeSlot==="tomorrow")return tom.toISOString(); return next.toISOString(); }
  async function confirm() {
    if(!selectedImage){toast.error("Select an image.");return;} setScheduling(true);
    try {
      const {data:{session}}=await supabase.auth.getSession();
      const scheduledAt=resolvedAt(); const boardName=MOCK_BOARDS.find(b=>b.id===boardId)?.name??MOCK_BOARDS[0].name;
      const resp=await fetch("/api/publish-jobs",{method:"POST",headers:{"Content-Type":"application/json",...(session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{})},body:JSON.stringify({mock_board_id:boardId,scheduled_at:scheduledAt,platform:"pinterest"})});
      const result=await resp.json() as {ok?:boolean;job?:{id:string};error?:string};
      const jobId=result.job?.id;
      if(result.ok&&jobId&&session?.access_token){const tok=session.access_token;import("@/lib/mockPublishWorker").then(({triggerMockWorker})=>{triggerMockWorker(jobId,tok).catch(console.error);});}
      onSuccess(selectedImage,scheduledAt,boardName,jobId);
      toast.success("Pin scheduled!",{description:`${boardName} · ${formatSlotLabel(new Date(scheduledAt))}`});
      onClose();
    } catch(err){toast.error("Schedule failed: "+String(err));} finally{setScheduling(false);}
  }
  return (
    <div style={{position:"fixed",inset:0,zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",padding:16,background:"rgba(0,0,0,0.45)",backdropFilter:"blur(2px)"}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{width:"100%",maxWidth:440,background:"#fff",borderRadius:20,overflow:"hidden",border:"1px solid #E5E7EB"}}>
        <div style={{padding:"16px 20px",borderBottom:"1px solid #F1F5F9",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div><h3 style={{margin:0,fontSize:"14px",fontWeight:800,color:"#0F172A",display:"flex",alignItems:"center",gap:8}}><Send style={{width:15,height:15,color:"#C026D3"}}/> Schedule to Pinterest</h3>{keyword&&<p style={{margin:"2px 0 0",fontSize:"11px",color:"#64748B",textTransform:"capitalize"}}>{keyword}</p>}</div>
          <button type="button" onClick={onClose} style={{width:28,height:28,borderRadius:"50%",border:"none",background:"#F1F5F9",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><X style={{width:13,height:13,color:"#6B7280"}}/></button>
        </div>
        <div style={{padding:"16px 20px",display:"flex",flexDirection:"column",gap:16,maxHeight:"72vh",overflowY:"auto"}}>
          {generatedImages.length>0 && (
            <div>
              <p style={{margin:"0 0 8px",fontSize:"10px",fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.07em"}}>Select Image · {generatedImages.length} generated</p>
              <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:4}}>
                {generatedImages.map((src,i)=>(
                  <button key={i} type="button" onClick={()=>setSelectedImage(src)} style={{width:64,height:96,flexShrink:0,borderRadius:10,overflow:"hidden",border:selectedImage===src?"2.5px solid #C026D3":"2.5px solid #E5E7EB",cursor:"pointer",padding:0,position:"relative"}}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                    {selectedImage===src&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(192,38,211,0.18)"}}><CheckCircle2 style={{width:20,height:20,color:"#C026D3"}}/></div>}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <p style={{margin:"0 0 6px",fontSize:"10px",fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.07em",display:"flex",alignItems:"center",gap:5}}><LayoutGrid style={{width:11,height:11}}/> Pinterest Board</p>
            <div style={{position:"relative"}}>
              <select value={boardId} onChange={e=>setBoardId(e.target.value)} style={{width:"100%",borderRadius:10,border:"1px solid #E5E7EB",background:"#fff",padding:"9px 32px 9px 12px",fontSize:"13px",color:"#374151",outline:"none",appearance:"none",cursor:"pointer"}}>
                {MOCK_BOARDS.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <ChevronDown style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",width:13,height:13,color:"#9CA3AF",pointerEvents:"none"}}/>
            </div>
          </div>
          <div>
            <p style={{margin:"0 0 6px",fontSize:"10px",fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.07em",display:"flex",alignItems:"center",gap:5}}><Clock style={{width:11,height:11}}/> Schedule Time</p>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {SLOTS.map(([id,label,sub])=>(
                <button key={id} type="button" onClick={()=>setTimeSlot(id)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",borderRadius:10,padding:"10px 14px",border:timeSlot===id?"1px solid rgba(192,38,211,0.3)":"1px solid #E5E7EB",background:timeSlot===id?"rgba(192,38,211,0.06)":"#F9FAFB",cursor:"pointer",textAlign:"left"}}>
                  <div><p style={{margin:0,fontSize:"13px",fontWeight:600,color:timeSlot===id?"#C026D3":"#374151"}}>{label}</p><p style={{margin:"2px 0 0",fontSize:"10px",color:"#94A3B8"}}>{sub}</p></div>
                  <div style={{width:16,height:16,borderRadius:"50%",border:`2px solid ${timeSlot===id?"#C026D3":"#D1D5DB"}`,background:timeSlot===id?"#C026D3":"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {timeSlot===id&&<div style={{width:5,height:5,borderRadius:"50%",background:"#fff"}}/>}
                  </div>
                </button>
              ))}
            </div>
            {timeSlot==="custom" && <div style={{marginTop:8}}><input type="datetime-local" value={customDate} onChange={e=>setCustomDate(e.target.value)} min={new Date().toISOString().slice(0,16)} style={{width:"100%",borderRadius:10,border:"1px solid #E5E7EB",padding:"9px 12px",fontSize:"13px",color:"#374151",outline:"none"}}/></div>}
          </div>
          <div style={{borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:8,background:"rgba(245,158,11,0.07)",border:"1px solid rgba(245,158,11,0.18)"}}>
            <Zap style={{width:14,height:14,color:"#F59E0B",flexShrink:0}}/>
            <p style={{margin:0,fontSize:"11px",color:"#374151"}}>Best time for this niche: <span style={{fontWeight:600,color:"#F59E0B"}}>Tue–Thu, 9–11 AM</span></p>
          </div>
        </div>
        <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",gap:10}}>
          <button type="button" onClick={onClose} style={{flex:1,borderRadius:30,padding:"11px",fontSize:"13px",fontWeight:600,color:"#374151",border:"1px solid #E5E7EB",background:"#fff",cursor:"pointer"}}>Cancel</button>
          <button type="button" onClick={confirm} disabled={scheduling||!selectedImage} style={{flex:1,borderRadius:30,padding:"11px",fontSize:"13px",fontWeight:800,color:"#fff",border:"none",background:"linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",cursor:scheduling||!selectedImage?"not-allowed":"pointer",opacity:scheduling||!selectedImage?0.5:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            {scheduling?<><div style={{width:14,height:14,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%"}}/>Scheduling…</>:<><Send style={{width:14,height:14}}/>Schedule Pin</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Active Generation Panel ────────────────────────────────────────────────────
type ActiveGenSession = {
  sessionId: string;
  keyword: string;
  expectedTotal: number;
  refCount: number;
};

function ActiveGenerationPanel({
  session, generating, generatingGroupIdx, generatedCount, onDismiss,
}: {
  session: ActiveGenSession;
  generating: boolean;
  generatingGroupIdx: number | null;
  generatedCount: number;
  onDismiss: () => void;
}) {
  const pct = session.expectedTotal > 0
    ? Math.min(100, Math.round((generatedCount / session.expectedTotal) * 100))
    : 0;
  const groupLabel = generatingGroupIdx !== null && session.refCount > 1
    ? `Group ${generatingGroupIdx + 1} / ${session.refCount}`
    : null;

  // Derive final state after generation finishes
  const done    = !generating;
  const failed  = done && generatedCount === 0;
  const partial = done && generatedCount > 0 && generatedCount < session.expectedTotal;
  const success = done && generatedCount >= session.expectedTotal && session.expectedTotal > 0;

  const headerColor = generating ? "#C026D3"
    : failed  ? "#EF4444"
    : partial ? "#D97706"
    : "#059669";

  const headerLabel = generating ? "Generation in progress"
    : failed  ? "Generation failed"
    : partial ? "Partial — some groups failed"
    : "Generation complete";

  const barColor = failed ? "#EF4444" : partial ? "#F59E0B" : "linear-gradient(90deg,#FF4D8D,#7C3AED)";

  return (
    <aside style={{
      width: 260, flexShrink: 0, borderLeft: "1px solid #E5E7EB",
      background: "#fff", display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{padding:"14px 16px 10px",borderBottom:"1px solid #F1F5F9",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            {generating && (
              <div style={{width:8,height:8,borderRadius:"50%",background:"#C026D3",animation:"pulse 1.2s ease-in-out infinite"}}/>
            )}
            <span style={{fontSize:"9px",fontWeight:800,color:headerColor,textTransform:"uppercase",letterSpacing:"0.1em"}}>
              {headerLabel}
            </span>
          </div>
          <button type="button" onClick={onDismiss}
            style={{padding:3,border:"none",background:"none",cursor:"pointer",color:"#94A3B8",lineHeight:1}}>
            <X style={{width:13,height:13}}/>
          </button>
        </div>
        <p style={{margin:"2px 0 0",fontSize:"12px",fontWeight:700,color:"#0F172A",textTransform:"capitalize",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          {session.keyword || "Generation"}
        </p>
        <p style={{margin:"2px 0 0",fontSize:"10px",color:"#94A3B8"}}>
          {session.refCount > 1 ? `${session.refCount} references` : "1 reference"} · {session.expectedTotal} pin{session.expectedTotal!==1?"s":""} total
        </p>
      </div>

      {/* Progress */}
      <div style={{padding:"12px 16px",borderBottom:"1px solid #F1F5F9",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <span style={{fontSize:"11px",fontWeight:600,color: failed ? "#EF4444" : "#374151"}}>
            {generating
              ? `Generating ${generatedCount} / ${session.expectedTotal} pins`
              : failed
                ? "0 pins generated — generation failed"
                : `${generatedCount} / ${session.expectedTotal} pins generated`}
          </span>
          <span style={{fontSize:"10px",color:"#94A3B8"}}>{pct}%</span>
        </div>
        <div style={{height:5,background:"#F1F5F9",borderRadius:3,overflow:"hidden"}}>
          <div style={{
            height:"100%",borderRadius:3,
            width: failed ? "100%" : `${pct}%`,
            background: barColor,
            transition:"width 0.4s ease",
            opacity: failed ? 0.35 : 1,
          }}/>
        </div>
        {groupLabel && (
          <p style={{margin:"5px 0 0",fontSize:"10px",color:"#C026D3",fontWeight:600}}>{groupLabel}</p>
        )}
        {failed && (
          <p style={{margin:"6px 0 0",fontSize:"10px",color:"#94A3B8",lineHeight:1.5}}>
            The generator timed out or the backend was unavailable. Check the server logs.
          </p>
        )}
        {partial && (
          <p style={{margin:"6px 0 0",fontSize:"10px",color:"#D97706",lineHeight:1.5}}>
            {session.expectedTotal - generatedCount} group{session.expectedTotal - generatedCount !== 1 ? "s" : ""} failed. Successful pins are saved.
          </p>
        )}
        {success && (
          <p style={{margin:"6px 0 0",fontSize:"10px",color:"#059669",lineHeight:1.5}}>
            All {generatedCount} pins generated successfully.
          </p>
        )}
      </div>

      {/* Navigation actions */}
      <div style={{padding:"12px 16px",display:"flex",flexDirection:"column",gap:7}}>
        {generating ? (
          <p style={{margin:"0 0 4px",fontSize:"10px",color:"#94A3B8",fontWeight:600}}>
            One generation running. Start another after this completes.
          </p>
        ) : failed ? (
          <p style={{margin:"0 0 4px",fontSize:"10px",color:"#EF4444",fontWeight:600}}>
            No images were saved. Try generating again.
          </p>
        ) : null}
        <a href="/app/history"
          style={{display:"block",padding:"7px 12px",borderRadius:8,border:"1px solid rgba(124,58,237,0.3)",background:"rgba(124,58,237,0.06)",color:"#7C3AED",fontSize:"11px",fontWeight:700,textDecoration:"none",textAlign:"center"}}>
          {failed ? "View session in Generated Pins →" : "View in Generated Pins →"}
        </a>
        {!generating && (
          <button type="button" onClick={onDismiss}
            style={{display:"block",width:"100%",padding:"7px 12px",borderRadius:8,border:"1px solid #E5E7EB",background:"#F8FAFC",color:"#64748B",fontSize:"11px",fontWeight:600,cursor:"pointer",textAlign:"center"}}>
            {failed ? "Try generating again" : "Continue editing"}
          </button>
        )}
      </div>
    </aside>
  );
}

// ── Per-reference style profile ───────────────────────────────────────────────
// Used to build composition-specific prompts for each reference group so that
// an on-body reference and a flat-lay reference produce visually distinct outputs.

type ReferenceVisualFormat =
  | "on_body"       // outfit worn by person / partial body
  | "mirror_selfie" // mirror reflection shot
  | "flat_lay"      // clothing/products arranged on flat surface, no person
  | "product_only"  // isolated product shot, no scene
  | "room_scene"    // home decor / interior, no person
  | "unknown";      // let the model infer from the image itself

type ReferenceHumanPresence = "visible_person" | "no_person" | "unknown";

type ReferenceStyleProfile = {
  visualFormat:  ReferenceVisualFormat;
  humanPresence: ReferenceHumanPresence;
  sourceKeyword: string | null;
};

function inferReferenceProfile(
  _refUrl: string,
  sourceKeyword: string | null | undefined,
  catLow: string,
): ReferenceStyleProfile {
  const kw = (sourceKeyword ?? "").toLowerCase();

  // Home / decor — always room scene, no person
  if (/home.decor|interior|bedroom|living.room|shelf|room.decor/.test(catLow) || /home|decor|room|interior|shelf|bedroom/.test(kw)) {
    return { visualFormat: "room_scene", humanPresence: "no_person", sourceKeyword: sourceKeyword ?? null };
  }

  // Flat-lay signals
  const isFlat = /flat.?lay|flatlay|knolling|overhead|product.?photo|product.?only|product.?shot|no.person|no.model/.test(kw);
  // Mirror / selfie signals
  const isMirror = /mirror|selfie|reflection/.test(kw);
  // On-body signals
  const isOnBody = /\b(outfit|ootd|wore|wearing|lookbook|on.?body|model|inspo|editorial|fit.?check|style|look)\b/.test(kw) && !isFlat;

  if (isFlat && !isOnBody)  return { visualFormat: "flat_lay",      humanPresence: "no_person",       sourceKeyword: sourceKeyword ?? null };
  if (isMirror)             return { visualFormat: "mirror_selfie", humanPresence: "visible_person",  sourceKeyword: sourceKeyword ?? null };
  if (isOnBody)             return { visualFormat: "on_body",       humanPresence: "visible_person",  sourceKeyword: sourceKeyword ?? null };

  // No clear signal — let the model read the reference image and decide
  return { visualFormat: "unknown", humanPresence: "unknown", sourceKeyword: sourceKeyword ?? null };
}

// buildGroupPrompt is the single source of truth for the complete per-group prompt.
// It assembles: subject (basePrompt) → reference fidelity → composition → human
// presence → quality guardrails → hard constraints.
// basePrompt should be subject-only (what to feature + auto-style playbook if no ref).
function buildGroupPrompt(
  basePrompt:  string,
  ref:         string | null,
  profile:     ReferenceStyleProfile,
  groupIndex:  number,
  totalGroups: number,
  catLow:      string,
): string {
  const isFashion     = /fashion|apparel|beauty|style/.test(catLow);
  const isHomeDecor   = /home.decor|interior|decor/.test(catLow);
  const groupTag      = totalGroups > 1 ? `[Reference group ${groupIndex} of ${totalGroups}] ` : "";

  // ── Human presence instruction (conditional, precise) ─────────────────────
  let humanRule: string;
  if (profile.humanPresence === "visible_person") {
    humanRule =
      "Show a person or partial-body subject naturally wearing the outfit. " +
      "Follow the selected reference's body framing, pose energy, and subject presentation style. " +
      "The face must not be recognizable — crop it out of frame, turn it away, or hide it behind a phone. " +
      "Do NOT show a recognizable face.";
  } else if (profile.humanPresence === "no_person") {
    humanRule =
      "Do not show any person, body part, skin, or mannequin. " +
      "This is a no-person composition — no visible arms, legs, torso, or face.";
  } else {
    // unknown — let model follow the reference
    humanRule =
      "Follow the reference image's human presence exactly: " +
      "if it shows a person, include a person with face hidden or cropped; " +
      "if it shows no person, do not add one.";
  }

  // ── Composition instruction (based on visual format) ─────────────────────
  let compositionBlock: string;
  if (!ref) {
    // Auto Style — no reference image; composition chosen by model from category playbook
    compositionBlock = "";
  } else {
    switch (profile.visualFormat) {
      case "flat_lay":
        compositionBlock =
          `${groupTag}COMPOSITION: Outfit flat-lay arrangement. ` +
          `Place the clothing and accessory items on a flat surface or styled background in a clean editorial flat-lay composition. ` +
          humanRule;
        break;

      case "on_body":
        compositionBlock =
          `${groupTag}COMPOSITION: On-body outfit editorial. ` +
          humanRule + " " +
          "Capture a natural, editorial outfit moment with realistic body proportions and clothing drape.";
        break;

      case "mirror_selfie":
        compositionBlock =
          `${groupTag}COMPOSITION: Mirror outfit reflection shot. ` +
          "Show the outfit reflected in a mirror with a casual, outfit-discovery feel. " +
          humanRule;
        break;

      case "room_scene":
        compositionBlock =
          `${groupTag}COMPOSITION: Styled interior scene. ` +
          "Naturally integrate the products into a styled interior composition. " +
          "No people or body parts visible.";
        break;

      case "product_only":
        compositionBlock =
          `${groupTag}COMPOSITION: Product-focused, clean background. ` +
          "Feature the products clearly against a minimal or contextual background. " +
          "No person, no body.";
        break;

      default: // unknown — instruct model to read the reference
        compositionBlock =
          `${groupTag}COMPOSITION: Follow the visual format of the attached reference image exactly. ` +
          "Preserve its shot type (flat lay, on-body, mirror, product shot) without blending formats. " +
          humanRule;
        break;
    }
  }

  // ── Reference fidelity instruction ────────────────────────────────────────
  const referenceFidelity = ref
    ? "The selected reference image is a visual direction guide. " +
      "Follow its overall composition type, subject framing, pose energy, lighting mood, and Pinterest-native aesthetic. " +
      "Do not recreate the exact background or scene one-to-one, but stay visually close to its composition type, " +
      "subject presentation, and overall styling feel. " +
      "Build a fresh, original composition inspired by the reference — not a literal copy."
    : "";

  // ── Category quality guardrails ───────────────────────────────────────────
  let qualityBlock: string;
  if (isFashion) {
    qualityBlock =
      "Clean editorial Pinterest style. Natural fabric texture and realistic clothing proportions. " +
      "Cohesive color palette. Polished, aspirational, and on-brand for Pinterest fashion. " +
      "Avoid distorted sleeves, collars, buttons, zippers, or hands. " +
      "No melting fabric, duplicate accessories, or unrealistic body anatomy. " +
      "Product details must be sharp and recognizable.";
  } else if (isHomeDecor) {
    qualityBlock =
      "Clean interior styling. Natural lighting, realistic textures, and cohesive color palette. " +
      "Products should be clearly recognizable in context. " +
      "Avoid cluttered or unrealistic arrangements.";
  } else {
    qualityBlock = "Polished, aspirational, and Pinterest-native. Product details must be recognizable.";
  }

  // ── Hard constraints (always last) ────────────────────────────────────────
  const constraints =
    "No text, words, labels, typography, watermarks, logos, or English characters visible anywhere in the image. " +
    "No graphic overlays. Vertical 2:3 format. Photorealistic.";

  // ── Assemble final prompt ─────────────────────────────────────────────────
  const parts = [
    compositionBlock,
    basePrompt,
    referenceFidelity,
    qualityBlock,
    constraints,
  ].filter(Boolean);

  const fullPrompt = parts.join("\n\n");

  console.log("[PromptBuilder] group", {
    groupIndex,
    referenceId:      ref ? ref.substring(0, 60) : "NO-REF",
    visualFormat:     profile.visualFormat,
    humanPresence:    profile.humanPresence,
    compositionType:  profile.visualFormat,
    promptExcerpt:    fullPrompt.slice(0, 800),
  });

  return fullPrompt;
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function StudioPage() {
  const router = useRouter();
  const [keyword,    setKeyword]    = useState("");
  const [category,   setCategory]   = useState("");
  const [pinId,      setPinId]      = useState("");
  const [productId,  setProductId]  = useState("");
  const [sourceType, setSourceType] = useState("");
  const [idea,       setIdea]       = useState("");
  const [style,      setStyle]      = useState("editorial");
  const [count,      setCount]      = useState(2);
  const [generating,         setGenerating]         = useState(false);
  const [generatingGroupIdx, setGeneratingGroupIdx] = useState<number|null>(null);
  const [generatedGroups, setGeneratedGroups] = useState<GeneratedGroup[]>([]);
  const [currentSessionId,setCurrentSessionId]= useState<string|null>(null);
  const [customStyleRef,  setCustomStyleRef]  = useState<string|null>(null);
  const [selectedPlanRefs,setSelectedPlanRefs]= useState<string[]>([]);
  const [queue, setQueue] = useState(MOCK_QUEUE);
  const [yoyFromUrl,  setYoyFromUrl]  = useState<number|null>(null);
  const [savesFromUrl,setSavesFromUrl]= useState<number|null>(null);
  const [planKeywords,setPlanKeywords]= useState<string[]>([]);

  const [fromPlan,        setFromPlan]        = useState(false);
  const [fromWorkspace,   setFromWorkspace]   = useState(false);
  const [fromBatch,       setFromBatch]       = useState(false);
  const [fromShopSignal,  setFromShopSignal]  = useState(false);
  const [fromDigitalIdea, setFromDigitalIdea] = useState(false);
  const [shopProduct,   setShopProduct]   = useState<PlanProduct|null>(null);
  const [shopProductIds, setShopProductIds] = useState<string[]>([]);
  const [shopProducts,   setShopProducts]   = useState<PlanProduct[]>([]);
  // URL-carried product image from Product Signals — displayed in Product Set, never as style ref
  const [shopSignalImageUrl, setShopSignalImageUrl] = useState<string|null>(null);
  const [marketAngleActive, setMarketAngleActive] = useState(false);
  const marketAngleAutoFiredRef = useRef(false);
  const [productLedOpportunity, setProductLedOpportunity] = useState<ProductLedOpportunity | null>(null);
  const [planKeywordId, setPlanKeywordId] = useState("");
  const [titleHook,     setTitleHook]     = useState("");
  const [planTier,      setPlanTier]      = useState("");
  const [planPinSamples,setPlanPinSamples]= useState<PlanPin[]>([]);
  // Pre-fetched base64 data URLs for reference pins (keyed by image_url).
  // Browser can fetch Pinterest CDN; Python backend often cannot.
  const [planRefDataUrls, setPlanRefDataUrls] = useState<Record<string, string>>({});
  const [planProducts,  setPlanProducts]  = useState<PlanProduct[]>([]);
  const [myProductImages,setMyProductImages]= useState<string[]>([]);
  const [myProductUrl,   setMyProductUrl]   = useState("");
  const [myProductName,  setMyProductName]  = useState("");

  const [batchStates,     setBatchStates]     = useState<Record<string,BatchOpState>>({});
  const [batchKeywordIds, setBatchKeywordIds] = useState<Record<string,string>>({});
  const [batchTiers,      setBatchTiers]      = useState<Record<string,string>>({});
  const [batchProductMode,   setBatchProductMode]   = useState<"per-opportunity"|"shared">("per-opportunity");
  const [sharedProductImage, setSharedProductImage] = useState<string|null>(null);
  const [sharedProductName,  setSharedProductName]  = useState("");

  const [showPublishModal,setShowPublishModal]= useState(false);
  const [publishTargetUrl,setPublishTargetUrl]= useState<string|null>(null);
  const [scheduledImages, setScheduledImages] = useState<Set<string>>(new Set());
  const [publishedJobMap, setPublishedJobMap] = useState<Map<string,string>>(new Map());
  void publishedJobMap;

  // ── Persistence state ───────────────────────────────────────────────────────
  const [showHistory,         setShowHistory]         = useState(false);
  const [historyPreviewEntry, setHistoryPreviewEntry] = useState<HistoryEntry | null>(null);
  const [historyEntries,      setHistoryEntries]      = useState<HistoryEntry[]>([]);
  const [historyLoaded,       setHistoryLoaded]       = useState(false);
  const [activeGenSession,    setActiveGenSession]    = useState<ActiveGenSession | null>(null);
  const [draftRestoredAt,   setDraftRestoredAt]   = useState<string | null>(null);
  const [hadProductImages,  setHadProductImages]  = useState(false);
  const [autosaveLabel,     setAutosaveLabel]      = useState("");
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(()=>{
    const p=new URLSearchParams(window.location.search);
    const kwList=p.get("keywords"); const first=kwList?kwList.split(",")[0].trim():(p.get("keyword")??"");
    const kwArr =kwList?kwList.split(",").map(k=>k.trim()).filter(Boolean):[];
    if (kwArr.length) setPlanKeywords(kwArr);
    setKeyword(first);
    const kwIds=p.get("keyword_ids")??"";
    if (kwIds&&kwArr.length) { const ids=kwIds.split(",").map(id=>id.trim()); const map:Record<string,string>={}; kwArr.forEach((kw,i)=>{if(ids[i])map[kw]=ids[i];}); setBatchKeywordIds(map); if(ids[0])setPlanKeywordId(ids[0]); }
    // Parse tier info per keyword (optional: tiers=early_trend,blue_ocean,...)
    const tiersStr=p.get("tiers")??"";
    if (tiersStr&&kwArr.length) { const tArr=tiersStr.split(",").map(t=>t.trim()); const tMap:Record<string,string>={}; kwArr.forEach((kw,i)=>{if(tArr[i])tMap[kw]=tArr[i];}); setBatchTiers(tMap); }
    setCategory(p.get("category")??"");
    setPinId(p.get("pin_id")??"");
    setProductId(p.get("product_id")??"");
    setSourceType(p.get("sourceType")??"");
    setIdea(p.get("idea")??"");
    // image_url is a style reference when sourceType="pin" (viral pin / discover entry).
    // When sourceType="product" / from="shop-signal", the product image belongs in the
    // Product Set section — handle it below via product_image_url instead.
    const srcType = p.get("sourceType")??"";
    const fromVal = p.get("from")??"";
    const img=p.get("image_url");
    if(img && srcType !== "product" && fromVal !== "shop-signal") setCustomStyleRef(img);
    // product_image_url — product image passed from Product Signals / multi-select
    const productImgUrl = p.get("product_image_url");
    if(productImgUrl) setShopSignalImageUrl(productImgUrl);
    const yoy=p.get("yoy"); if(yoy) setYoyFromUrl(parseFloat(yoy));
    const saves=p.get("saves"); if(saves) setSavesFromUrl(parseInt(saves,10));
    if(p.get("from")==="plan")         setFromPlan(true);
    if(p.get("from")==="workspace")    setFromWorkspace(true);
    if(p.get("from")==="batch")        setFromBatch(true);
    if(p.get("from")==="shop-signal")  setFromShopSignal(true);
    if(p.get("from")==="digital_idea") { setFromDigitalIdea(true); setFromWorkspace(true); }
    const pIds=p.get("productIds")??"";
    if(pIds) setShopProductIds(pIds.split(",").map(id=>id.trim()).filter(Boolean));
    const kwId=p.get("keyword_id")??""; if(kwId) setPlanKeywordId(kwId);
    const th=p.get("title_hook")??""; if(th) setTitleHook(th);
    const t=p.get("tier")??""; if(t) setPlanTier(t);

    // ── Restore draft ─────────────────────────────────────────────────────────
    // `first` is the local variable for the active keyword parsed just above.
    const draft = loadDraft();
    if (draft && draft.keyword === first && draft.generatedGroups.length > 0) {
      setGeneratedGroups(draft.generatedGroups);
      setSelectedPlanRefs(draft.selectedPlanRefs ?? []);
      if (draft.planPinSamples?.length) setPlanPinSamples(draft.planPinSamples);
      if (draft.customStyleRef?.startsWith("https://")) setCustomStyleRef(draft.customStyleRef);
      if (draft.style) setStyle(draft.style);
      if (draft.count) setCount(draft.count);
      if (draft.myProductUrl)  setMyProductUrl(draft.myProductUrl);
      if (draft.myProductName) setMyProductName(draft.myProductName);
      if (draft.hadProductImages) setHadProductImages(true);
      // Batch states
      if (draft.isBatch && draft.batchStates) {
        const restoredBatch: Record<string, BatchOpState> = {};
        for (const [kw, bs] of Object.entries(draft.batchStates)) {
          restoredBatch[kw] = {
            generatedGroups:  bs.generatedGroups,
            selectedPlanRefs: bs.selectedPlanRefs,
            customStyleRef:   bs.customStyleRef,
            myProductImages:  [],         // not persisted
            myProductUrl:     bs.myProductUrl,
            myProductName:    bs.myProductName,
            tier:             "",
          };
        }
        setBatchStates(restoredBatch);
      }
      setDraftRestoredAt(draft.savedAt);
    }

    // Tier 1: load localStorage history immediately (instant)
    const localHistory = loadHistory();
    setHistoryEntries(localHistory);

    // Safety timeout — if Supabase calls hang, stop showing "Loading…" after 5 s
    const historyTimeoutId = setTimeout(() => setHistoryLoaded(true), 5000);

    // Tier 2: DB (cross-device) + Storage listing (recovers old sessions, server-side service role)
    Promise.all([
      fetchGenerationsFromDb(supabase).catch(():HistoryEntry[] => []),
      fetch("/api/history-storage")
        .then(r => r.json())
        .then((d: {entries: HistoryEntry[]}) => d.entries ?? [])
        .catch(():HistoryEntry[] => []),
    ]).then(([dbEntries, storageEntries]) => {
      clearTimeout(historyTimeoutId);
      const merged = mergeHistoryEntries(dbEntries, localHistory, storageEntries);
      // Always update — even if empty, so the drawer transitions from "Loading" to "No history"
      setHistoryEntries(merged);
      setHistoryLoaded(true);
      // Persist merged list back to localStorage so it's fast next time
      merged.slice(0, 30).forEach(e => addHistory(e));
    }).catch(() => {
      clearTimeout(historyTimeoutId);
      setHistoryLoaded(true);
    });
  },[]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(()=>{
    if(!planKeywordId)return;
    supabase.from("pin_samples").select("id,image_url,save_count,source_keyword").eq("trend_keyword_id",planKeywordId).not("image_url","is",null).order("save_count",{ascending:false}).limit(6)
      .then(({data})=>{ if(data?.length) setPlanPinSamples(data as PlanPin[]); });
  },[planKeywordId]);

  useEffect(()=>{
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    if(planPinSamples.length>0&&selectedPlanRefs.length===0) setSelectedPlanRefs([planPinSamples[0].image_url]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[planPinSamples]);

  // ── Autosave draft (debounced 1 s, skipped during active generation) ─────────
  useEffect(()=>{
    if (!keyword || generating) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    setAutosaveLabel("Saving…");
    autosaveTimerRef.current = setTimeout(()=>{
      const isBatch = fromBatch || planKeywords.length > 1;
      // Strip product image base64 from batchStates before persisting
      const strippedBatch: StudioDraft["batchStates"] = isBatch ? {} : null;
      if (isBatch && strippedBatch) {
        for (const [kw, bs] of Object.entries(batchStates)) {
          strippedBatch[kw] = {
            generatedGroups:  bs.generatedGroups,
            selectedPlanRefs: bs.selectedPlanRefs,
            customStyleRef:   bs.customStyleRef?.startsWith("https://") ? bs.customStyleRef : null,
            myProductUrl:     bs.myProductUrl,
            myProductName:    bs.myProductName,
            hadProductImages: bs.myProductImages.length > 0,
          };
        }
      }
      const draft: StudioDraft = {
        v:               1,
        savedAt:         new Date().toISOString(),
        source:          fromPlan ? "plan" : isBatch ? "batch" : "workspace",
        keyword,
        category,
        style,
        count,
        selectedPlanRefs,
        planPinSamples,
        customStyleRef:  customStyleRef?.startsWith("https://") ? customStyleRef : null,
        myProductUrl,
        myProductName,
        hadProductImages: myProductImages.length > 0,
        generatedGroups,
        promptText:      undefined,  // only save if explicitly edited (handled separately)
        isBatch,
        batchStates:     strippedBatch,
      };
      saveDraft(draft);
      setAutosaveLabel("Draft autosaved");
      setTimeout(()=>setAutosaveLabel(""),2500);
    }, 1000);
    return ()=>{ if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[keyword, category, style, count, selectedPlanRefs, customStyleRef,
     myProductImages.length, myProductUrl, myProductName, generatedGroups,
     generating, fromPlan, fromBatch, planKeywords.length]);

  useEffect(()=>{
    if(!fromShopSignal||!productId)return;
    supabase.from("pin_products").select("id,product_name,image_url,domain,price").eq("id",productId).single().then(({data})=>{if(data)setShopProduct(data as PlanProduct);});
  },[fromShopSignal,productId]);

  // Multi-product fetch: when productIds are present (from multi-select flow)
  useEffect(()=>{
    if(!fromShopSignal||shopProductIds.length===0)return;
    supabase.from("pin_products").select("id,product_name,image_url,domain,price").in("id",shopProductIds)
      .then(({data})=>{ if(data?.length) setShopProducts(data as PlanProduct[]); });
  },[fromShopSignal,shopProductIds]);

  // Auto-activate market angle as soon as shop product data arrives — no manual [Apply] needed.
  useEffect(()=>{
    if((shopProduct||shopProducts.length>0) && fromShopSignal && !marketAngleAutoFiredRef.current){
      marketAngleAutoFiredRef.current = true;
      setMarketAngleActive(true);
    }
  },[shopProduct, shopProducts, fromShopSignal]);

  useEffect(()=>{
    if(!fromPlan||!keyword)return;
    supabase.from("pin_products").select("id,product_name,image_url,domain,price").ilike("seed_keyword",`%${keyword}%`).not("image_url","is",null).order("save_count",{ascending:false}).limit(3)
      .then(({data})=>{if(data?.length)setPlanProducts(data as PlanProduct[]);});
  },[fromPlan,keyword]);

  const generatedImages = generatedGroups.flatMap(g=>g.images);
  const isBatch         = fromBatch||planKeywords.length>1;
  // product-led mode: entered from Product Signals with at least one product loaded
  const productLedMode  = fromShopSignal && shopProducts.length > 0;
  const batchIdx        = isBatch?Math.max(0,planKeywords.indexOf(keyword)):0;

  function switchBatchKeyword(newKw:string) {
    if(newKw===keyword)return;
    setBatchStates(prev=>({...prev,[keyword]:{generatedGroups,customStyleRef,selectedPlanRefs,myProductImages,myProductUrl,myProductName,tier:planTier}}));
    const saved=batchStates[newKw];
    setKeyword(newKw); setGeneratedGroups(saved?.generatedGroups??[]); setCustomStyleRef(saved?.customStyleRef??null);
    setSelectedPlanRefs(saved?.selectedPlanRefs??[]); setMyProductImages(saved?.myProductImages??[]);
    setMyProductUrl(saved?.myProductUrl??""); setMyProductName(saved?.myProductName??"");
    const newId=batchKeywordIds[newKw]??""; setPlanKeywordId(newId); setPlanPinSamples([]);
    const newTier=batchTiers[newKw]??saved?.tier??""; if(newTier) setPlanTier(newTier);
  }

  function handleSelectProductLedOpportunity(opp: ProductLedOpportunity | null) {
    setProductLedOpportunity(opp);
    if (opp) {
      setKeyword(opp.keyword);
      setCategory(opp.category);
      setFromWorkspace(true);
      // Load reference pins — do NOT auto-select; user picks explicitly
      setPlanPinSamples(opp.referencePins);
      setSelectedPlanRefs([]);
    } else {
      // Cleared — reset keyword so user can pick a different opportunity
      setKeyword("");
      setFromWorkspace(false);
      setPlanPinSamples([]);
      setSelectedPlanRefs([]);
    }
  }

  const batchInfo = isBatch ? {
    total:batchIdx<0?planKeywords.length:planKeywords.length, currentIdx:batchIdx,
    onNext:()=>{ if(batchIdx<planKeywords.length-1) switchBatchKeyword(planKeywords[batchIdx+1]); },
    onPrev:()=>{ if(batchIdx>0) switchBatchKeyword(planKeywords[batchIdx-1]); },
    onExit:()=>router.push(`/app/workspace/${category||"home-decor"}`),
    productMode:batchProductMode, sharedProductImage, sharedProductName,
    onSetProductMode:(m:"per-opportunity"|"shared")=>setBatchProductMode(m),
    onSetSharedProduct:(img:string|null,name:string)=>{setSharedProductImage(img);setSharedProductName(name);},
  } : undefined;

  async function handleGenerate({
    prompt,
    refs: passedRefs,
    productImages: passedProductImages,
    imagesPerRef,
  }: {
    prompt: string;
    refs: string[];
    productImages: string[];
    imagesPerRef: number;   // explicit — never read from closure
  }) {
    if (!keyword) { toast.error("Select a trend keyword first."); return; }
    if (generating) {
      toast.info("A generation is already running.", {
        description: "Wait for it to finish, or view progress in Generated Pins.",
        action: { label: "View Generated Pins", onClick: () => { window.location.href = "/app/history"; } },
      });
      return;
    }

    // Snapshot everything at call time.
    const refsToProcess: Array<string | null> = passedRefs.length > 0 ? passedRefs : [null];
    const imagesPerGroup = imagesPerRef;
    const expectedTotal  = refsToProcess.length * imagesPerGroup;

    // Snapshot product context before the loop (used for DB session creation)
    const entryProducts = productLedMode
      ? (shopProducts.length > 0 ? shopProducts : shopProduct ? [shopProduct] : [])
      : [];
    const sessionSource: string = fromPlan ? "plan" : (fromBatch||planKeywords.length>1) ? "batch" : "workspace";
    const sessionMode:   string = productLedMode ? "product_led" : fromPlan ? "plan" : (fromBatch||planKeywords.length>1) ? "batch" : "keyword_led";
    const catLowSnap = (category || "").toLowerCase();

    // ── Build reference profiles upfront (write-once, stored in setup_snapshot) ─
    // This ensures the setup_snapshot has profiles for ALL refs before any API call.
    const refProfilesUpfront: ReferenceSnapshot[] = refsToProcess.map(ref => {
      if (!ref) return { imageUrl: "", visualFormat: "unknown", humanPresence: "unknown", source: "auto_style" };
      const isUserUpload = ref.startsWith("data:") || ref.startsWith("blob:");
      const pinMeta      = isUserUpload ? undefined : planPinSamples.find(p => p.image_url === ref);
      const profile      = inferReferenceProfile(
        ref,
        pinMeta?.source_keyword ?? productLedOpportunity?.keyword ?? null,
        catLowSnap,
      );
      return {
        imageUrl:      ref,
        source:        isUserUpload ? "user_upload" : (pinMeta ? "opportunity_direct" : "similar_category"),
        visualFormat:  profile.visualFormat,
        humanPresence: profile.humanPresence,
      } satisfies ReferenceSnapshot;
    });

    // ── Build product snapshots ────────────────────────────────────────────────
    const productSnapshots: ProductSnapshot[] = entryProducts.map(p => ({
      productId: p.id,
      imageUrl:  p.image_url,
      title:     p.product_name,
      source:    p.domain ?? undefined,
    }));

    // ── Build setup snapshot (canonical source of truth) ─────────────────────
    const setupSnapshot: SetupSnapshot = {
      mode:               sessionMode,
      keyword,
      category,
      opportunityTitle:   productLedOpportunity?.keyword ?? undefined,
      noTextOverlay:      true,
      imagesPerReference: imagesPerGroup,
      selectedProducts:   productSnapshots,
      selectedReferences: refProfilesUpfront.filter(r => !!r.imageUrl),
      promptSnapshot:     prompt,
      createdFrom:        fromShopSignal ? "shop_signals" : fromPlan ? "weekly_plan" : "studio",
    };

    // ── Create persistent session BEFORE any API call ───────────────────────
    const newSessionId = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

    console.log("[Generate] selectedReferences.length", refsToProcess.length);
    console.log("[Generate] imagesPerReference", imagesPerGroup);
    console.log("[Generate] expectedTotal", expectedTotal);
    console.log("[Generate] sessionId", newSessionId);
    const runningEntry: HistoryEntry = {
      id:            newSessionId,
      savedAt:       new Date().toISOString(),
      keyword,
      category,
      source:        sessionSource,
      groups:        [],
      refCount:      refsToProcess.length,
      productCount:  productLedMode ? entryProducts.length : passedProductImages.length,
      totalPins:     0,
      status:        "running",
      expectedTotal,
      mode:          sessionMode,
      opportunity:   productLedMode ? (productLedOpportunity?.keyword ?? keyword) : undefined,
      imagesPerRef:  imagesPerGroup,
      productNames:  entryProducts.length > 0 ? entryProducts.map(p => p.product_name) : undefined,
      productIds:    productLedMode && shopProductIds.length > 0 ? shopProductIds : undefined,
      promptExcerpt: prompt.slice(0, 120),
      promptFull:    prompt,
      setupSnapshot,
    };

    // Persist immediately — visible in Generated Pins as "In progress"
    createRunningSessionInDb(supabase, runningEntry).catch(() => {});
    addHistory(runningEntry);
    setHistoryEntries(prev => [runningEntry, ...prev.filter(e => e.id !== newSessionId)].slice(0, 50));
    setCurrentSessionId(newSessionId);
    setActiveGenSession({ sessionId: newSessionId, keyword, expectedTotal, refCount: refsToProcess.length });

    setGenerating(true);
    setGeneratingGroupIdx(null);
    setGeneratedGroups([]);


    // ── Error type → user-facing copy mapping ───────────────────────────────

    type GenerateResult = {
      ok?: boolean; urls?: string[]; task_id?: string;
      error?: string; stderr?: string; source?: string;
      errors?: string[];
      error_type?: GenerationErrorType;
    };

    function getGroupErrorCopy(
      errorType: GenerationErrorType | undefined,
      groupLabel: string,
    ): { title: string; description: string } {
      switch (errorType) {
        case "rate_limited":
          return {
            title:       `${groupLabel}: Rate limited`,
            description: "The image API is temporarily rate limited. Retried with backoff — try again in a few minutes.",
          };
        case "safety_blocked":
          return {
            title:       `${groupLabel}: Safety blocked`,
            description: "The model blocked this request. Try a different reference image or simplify the prompt.",
          };
        case "image_load_failed":
          return {
            title:       `${groupLabel}: Product images failed`,
            description: "Product images could not be downloaded. Re-upload product images or use different URLs.",
          };
        case "model_returned_text":
          return {
            title:       `${groupLabel}: Model returned text`,
            description: "The model returned a text description instead of an image. Try fewer inputs or a simpler prompt.",
          };
        case "api_auth_error":
          return {
            title:       `${groupLabel}: API authentication error`,
            description: "Check your LINAPI_KEY in web/.env.local.",
          };
        case "api_payload_error":
          return {
            title:       `${groupLabel}: Request rejected`,
            description: "The API rejected the payload. Try with fewer products or a shorter prompt.",
          };
        case "api_server_error":
          return {
            title:       `${groupLabel}: API server error`,
            description: "The image API returned a server error. Try again in a few minutes.",
          };
        default:
          return {
            title:       `${groupLabel}: Generation failed`,
            description: "0 images returned. Check the backend terminal for details.",
          };
      }
    }

    const completedGroups: GeneratedGroup[] = [];
    const groupErrors: Array<{ type: GenerationErrorType; message: string }> = [];
    const INTER_GROUP_DELAY_MS = 2_000; // 2 s gap between groups — avoids simultaneous API hits

    try {
      // ── Sequential generation: one group at a time ──────────────────────────
      // Spec: maxConcurrentApiCallsPerSession = 1
      // Sequential avoids simultaneous rate-limit spikes and is easier to debug.
      // With 240 s timeout per group, 2 refs × ~80 s each = ~162 s < 240 s ✓
      console.log(`[Generate] running ${refsToProcess.length} group(s) sequentially`);

      for (let i = 0; i < refsToProcess.length; i++) {
        const ref         = refsToProcess[i];
        const groupLabel  = `Reference ${i + 1} of ${refsToProcess.length}`;
        setGeneratingGroupIdx(i);

        const refSnap    = refProfilesUpfront[i];
        const refProfile = inferReferenceProfile(
          ref ?? "",
          (refSnap?.source) ?? productLedOpportunity?.keyword ?? null,
          catLowSnap,
        );
        const groupPrompt = buildGroupPrompt(prompt, ref, refProfile, i + 1, refsToProcess.length, catLowSnap);

        console.log("[Generate] group referenceId", ref ? ref.substring(0, 80) : "NO-REF");
        console.log("[Generate] group expected",    imagesPerGroup);
        console.log("[Generate] reference group", {
          groupIndex:         i + 1,
          visualFormat:       refProfile.visualFormat,
          humanPresence:      refProfile.humanPresence,
          imagesPerReference: imagesPerGroup,
        });

        const payload: Record<string, unknown> = {
          keyword,
          style,
          count:    imagesPerGroup,
          prompt:   groupPrompt,
          category,
          ...(ref                              ? { style_ref:       ref }                : {}),
          ...(passedProductImages.length > 0   ? { product_images: passedProductImages } : {}),
        };

        let result: GenerateResult = {};
        let httpStatus = 200;
        try {
          const resp = await fetch("/api/generate", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
          });
          httpStatus = resp.status;
          const text = await resp.text();
          try { result = JSON.parse(text) as GenerateResult; }
          catch { result = { ok: false, error: `HTTP ${httpStatus} — non-JSON response: ${text.slice(0, 200)}` }; }
        } catch (fetchErr) {
          console.warn(`[Generate] group ${i + 1} network error:`, fetchErr);
          toast.error(`${groupLabel} failed`, { description: String(fetchErr) });
          continue;
        }

        const returnedCount = Array.isArray(result.urls) ? result.urls.length : 0;
        const errorType     = result.error_type;
        console.log(`[Generate] group returned ${returnedCount} | error_type=${errorType ?? "none"} | httpStatus=${httpStatus}`);

        if (returnedCount > 0) {
          const group: GeneratedGroup = {
            refUrl:        ref,
            images:        result.urls!,
            visualFormat:  refProfile.visualFormat,
            humanPresence: refProfile.humanPresence,
          };
          completedGroups.push(group);
          setGeneratedGroups([...completedGroups]);
          const partialTotal = completedGroups.flatMap(g => g.images).length;
          updateSessionInDb(supabase, newSessionId, {
            groups_json: completedGroups,
            pin_urls:    completedGroups.flatMap(g => g.images),
            total_pins:  partialTotal,
            ref_count:   completedGroups.length,
            status:      "running",
          }).catch(() => {});
        } else if (result.task_id) {
          toast.success("Queued!", { description: `Task ${result.task_id}` });
        } else {
          const { title, description } = getGroupErrorCopy(errorType, groupLabel);
          toast.error(title, { description });
          groupErrors.push({ type: errorType ?? "unknown_error", message: description });
        }

        // Brief pause between groups — prevents simultaneous API requests
        if (i < refsToProcess.length - 1) {
          await new Promise(r => setTimeout(r, INTER_GROUP_DELAY_MS));
        }
      }
      if (completedGroups.length > 0) {
        const actualTotal = completedGroups.flatMap(g => g.images).length;
        const groups      = completedGroups.length;

        const genStatus: "completed" | "partial" | "failed" =
          actualTotal === 0           ? "failed"  :
          actualTotal < expectedTotal ? "partial" :
          "completed";

        console.log("[Generate] final status", genStatus);
        console.log("[Generate] total generated", actualTotal);
        console.log("[Generate] expected total", expectedTotal);
        console.log("[Generate] outputs by reference group",
          completedGroups.map((g, idx) => ({
            group:    idx + 1,
            refUrl:   g.refUrl?.substring(0, 60) ?? "none",
            pinCount: g.images.length,
            expected: imagesPerGroup,
            status:   g.images.length >= imagesPerGroup ? "ok" : g.images.length > 0 ? "partial" : "missing",
          }))
        );

        if (genStatus === "partial") {
          console.warn(`[generate] ⚠ expected ${expectedTotal} pins, received ${actualTotal}`);
          toast.warning(
            `Expected ${expectedTotal} pins, received ${actualTotal}`,
            { description: `${groups} of ${refsToProcess.length} reference groups succeeded` },
          );
        } else {
          toast.success(
            `${actualTotal} pin${actualTotal !== 1 ? "s" : ""} generated`,
            { description: `${groups} reference group${groups !== 1 ? "s" : ""} · ${imagesPerGroup} per group` },
          );
        }

        // Finalize entry with actual results
        const entry: HistoryEntry = {
          ...runningEntry,
          groups:       completedGroups,
          refCount:     completedGroups.length,
          totalPins:    actualTotal,
          status:       genStatus,
        };
        addHistory(entry);
        setHistoryEntries(prev => [entry, ...prev.filter(e => e.id !== newSessionId)].slice(0, 50));
        pinStore.createSession(entry.id, keyword, category, sessionSource, completedGroups);

        // Final DB update — sets completed status and all generated image URLs
        updateSessionInDb(supabase, newSessionId, {
          groups_json: completedGroups,
          pin_urls:    completedGroups.flatMap(g => g.images),
          ref_urls:    completedGroups.map(g => g.refUrl).filter(Boolean),
          ref_count:   completedGroups.length,
          total_pins:  actualTotal,
          status:      genStatus,
        }).catch(() => {});
      } else if (refsToProcess.length > 0) {
        toast.error("No images were generated. Check the backend logs.");
        // Mark session as failed in DB
        updateSessionInDb(supabase, newSessionId, { status: "failed", total_pins: 0 }).catch(() => {});
        // Update local history entry too
        const failedEntry: HistoryEntry = { ...runningEntry, status: "failed" };
        addHistory(failedEntry);
        setHistoryEntries(prev => [failedEntry, ...prev.filter(e => e.id !== newSessionId)].slice(0, 50));
      }
    } finally {
      setGenerating(false);
      setGeneratingGroupIdx(null);
    }
  }

  function handleOpenPublish(url?:string) {
    if(!generatedImages.length){toast.error("Generate images first.");return;}
    setPublishTargetUrl(url??null); setShowPublishModal(true);
  }
  function handlePublishSuccess(imageUrl:string,scheduledAt:string,boardName:string,jobId?:string) {
    setScheduledImages(prev=>new Set([...prev,imageUrl]));
    if(jobId) setPublishedJobMap(prev=>new Map([...prev,[imageUrl,jobId]]));
    setQueue(prev=>[...prev,{keyword:keyword||"New Pin",board:boardName,time:formatSlotLabel(new Date(scheduledAt)),done:false}]);
  }

  const anyStyleRef = selectedPlanRefs[0]??customStyleRef;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F7F8FA]">
      {/* Weekly plan keyword banner */}
      {!isBatch && planKeywords.length>1 && (
        <div style={{padding:"6px 20px",background:"rgba(5,150,105,0.08)",borderBottom:"1px solid rgba(5,150,105,0.15)",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
          <span style={{fontSize:"11px",color:"#059669",fontWeight:600}}>📋 Weekly plan: {planKeywords.length} keywords</span>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {planKeywords.map((kw,i)=>(
              <button key={kw} onClick={()=>setKeyword(kw)} style={{padding:"2px 8px",borderRadius:4,fontSize:"11px",fontWeight:keyword===kw?700:500,border:`1px solid ${keyword===kw?"#059669":"#d1d5db"}`,background:keyword===kw?"rgba(5,150,105,0.1)":"white",color:keyword===kw?"#059669":"#6b7280",cursor:"pointer",textTransform:"capitalize"}}>
                {i+1}. {kw}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Keyword prompt — shown when single-product signal and no keyword yet (not in product-led mode) */}
      {fromShopSignal && !keyword && !productLedMode && (
        <div style={{padding:"10px 24px",borderBottom:"1px solid #F1F5F9",background:"rgba(192,38,211,0.04)",flexShrink:0,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{flex:"0 0 auto"}}>
            <p style={{margin:0,fontSize:"12px",fontWeight:700,color:"#C026D3"}}>
              {shopProductIds.length > 1 ? `${shopProductIds.length} products loaded` : "Product loaded"}
            </p>
            <p style={{margin:"1px 0 0",fontSize:"10px",color:"#94A3B8"}}>Add a keyword so the AI knows what these pins are about</p>
          </div>
          <input
            type="text"
            placeholder="e.g. minimalist home decor, aesthetic nails…"
            value={keyword}
            onChange={e => { setKeyword(e.target.value); if(!category) setCategory("home-decor"); setFromWorkspace(true); }}
            onKeyDown={e => { if(e.key==="Enter" && keyword.trim()) setFromWorkspace(true); }}
            autoFocus
            style={{flex:"1 1 260px",minWidth:200,padding:"7px 14px",borderRadius:8,border:"1px solid rgba(192,38,211,0.35)",fontSize:"12px",outline:"none",background:"#fff"}}
          />
          <span style={{fontSize:"10px",color:"#CBD5E1",flexShrink:0}}>or skip to generate directly from products</span>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Empty state: no keyword, not in batch, not product-led, and not entering from shop signal */}
        {(!keyword && !isBatch && !fromShopSignal && !productLedMode && shopProductIds.length === 0) ? (
          <EmptyStudioState
            onSelectSource={(kw,cat,src,pinUrl)=>{
              if(kw)  setKeyword(kw);
              if(cat) setCategory(cat);
              if(src==="plan")      { setFromPlan(true);      }
              else if(src==="workspace"){ setFromWorkspace(true); }
              else if(src==="pin" && pinUrl){ setCustomStyleRef(pinUrl); setSourceType("pin"); setFromWorkspace(true); }
            }}
            onOpenHistory={()=>setShowHistory(true)}
            historyCount={historyEntries.length}
          />
        ) : (<>
          {isBatch ? (
            <BatchQueuePanel
              keywords={planKeywords} activeKeyword={keyword} batchStates={batchStates}
              activeGeneratedImages={generatedImages} activeProductImages={myProductImages}
              activeProductUrl={myProductUrl} activeCustomStyleRef={customStyleRef}
              activeSelectedPlanRefs={selectedPlanRefs} activeTier={planTier}
              onSelectKeyword={switchBatchKeyword} category={category}
              batchProductMode={batchProductMode} sharedProductImage={sharedProductImage}
              sharedProductName={sharedProductName} onSetProductMode={setBatchProductMode}
              onSetSharedProduct={(img,name)=>{setSharedProductImage(img);setSharedProductName(name);}}
              batchTiers={batchTiers}
            />
          ) : productLedMode ? (
            // Product-led mode: all sections live inside GenerationPanel — no separate left panel
            null
          ) : fromWorkspace && !isBatch ? (
            // Opportunity-first: new unified Create Pin Studio layout (replaces TrendPanel + GenerationPanel)
            <OpportunityFirstStudio
              keyword={keyword} category={category}
              onSelectOpportunity={(kw, cat, _id, tier) => {
                setKeyword(kw); setCategory(cat); setFromWorkspace(true);
                setPlanTier(tier);
                // planPinSamples will be loaded by the existing useEffect watching planKeywordId
                // For now trigger re-fetch by updating keyword (the useEffect handles it)
              }}
              planPinSamples={planPinSamples}
              selectedPlanRefs={selectedPlanRefs}
              onTogglePlanRef={url => setSelectedPlanRefs(prev => prev.includes(url) ? prev.filter(r => r !== url) : [...prev, url])}
              customStyleRef={customStyleRef} setCustomStyleRef={setCustomStyleRef}
              myProductImages={myProductImages}
              onAddProductFiles={files => {
                Array.from(files).forEach(f => {
                  const r = new FileReader();
                  r.onload = e => setMyProductImages(prev => [...prev, e.target?.result as string]);
                  r.readAsDataURL(f);
                });
              }}
              onRemoveProductImage={idx => setMyProductImages(prev => prev.filter((_, i) => i !== idx))}
              count={count} setCount={setCount}
              generating={generating} generatingGroupIdx={generatingGroupIdx}
              generatedGroups={generatedGroups}
              onGenerate={handleGenerate}
              onOpenHistory={() => setShowHistory(true)}
              yoyFromUrl={yoyFromUrl} planTier={planTier}
            />
          ) : fromShopSignal && !keyword ? (
            // Single-product signal with no keyword yet → legacy opportunity + reference picker
            <ProductBriefingPanel
              productNames={(shopProducts.length > 0 ? shopProducts : shopProduct ? [shopProduct] : []).map((p: PlanProduct) => p.product_name)}
              seedKeywords={(shopProducts.length > 0 ? shopProducts : shopProduct ? [shopProduct] : []).map((p: PlanProduct) => p.domain ?? "").filter(Boolean)}
              onSelectOpportunity={(kw, cat) => { setKeyword(kw); setCategory(cat); setFromWorkspace(true); }}
              onSelectReference={(url) => { setCustomStyleRef(url); setSourceType("pin"); }}
            />
          ) : (
            <TrendPanel keyword={keyword} category={category} pinId={pinId} productId={productId}
              sourceType={sourceType} idea={idea} yoyFromUrl={yoyFromUrl} savesFromUrl={savesFromUrl}
              fromPlan={fromPlan} fromWorkspace={fromWorkspace} fromDigitalIdea={fromDigitalIdea}
              titleHook={titleHook} planTier={planTier}
              styleRef={anyStyleRef} productAdded={myProductImages.length>0}
              marketAngleAbsorbed={marketAngleActive && fromShopSignal}/>
          )}

        {/* GenerationPanel for non-workspace flows: product-led, batch, signal, plan */}
        {!(fromWorkspace && !isBatch && !productLedMode) && <GenerationPanel
          keyword={keyword} category={category} style={style} setStyle={setStyle}
          count={count} setCount={setCount} generating={generating} generatingGroupIdx={generatingGroupIdx}
          onGenerate={handleGenerate}
          generatedGroups={generatedGroups}
          customStyleRef={customStyleRef} setCustomStyleRef={setCustomStyleRef}
          selectedPlanRefs={selectedPlanRefs}
          onTogglePlanRef={url=>setSelectedPlanRefs(prev=>prev.includes(url)?prev.filter(r=>r!==url):[...prev,url])}
          sourceType={sourceType} idea={idea}
          fromPlan={fromPlan} fromWorkspace={fromWorkspace} fromBatch={fromBatch} fromDigitalIdea={fromDigitalIdea}
          batchInfo={batchInfo}
          planPinSamples={planPinSamples} planProducts={planProducts}
          titleHook={titleHook} shopProduct={shopProduct} shopProducts={shopProducts} planTier={planTier}
          shopSignalImageUrl={shopSignalImageUrl}
          myProductImages={myProductImages} setMyProductImages={setMyProductImages}
          myProductUrl={myProductUrl}       setMyProductUrl={setMyProductUrl}
          myProductName={myProductName}     setMyProductName={setMyProductName}
          onPublish={handleOpenPublish} scheduledImages={scheduledImages}
          draftInfo={{ restoredAt: draftRestoredAt, hadProductImages, autosaveLabel }}
          onClearDraft={()=>{ clearDraft(); setDraftRestoredAt(null); setHadProductImages(false); }}
          onOpenHistory={()=>setShowHistory(true)}
          currentSessionId={currentSessionId}
          fromShopSignal={fromShopSignal}
          marketAngleActive={marketAngleActive} setMarketAngleActive={setMarketAngleActive}
          productLedMode={productLedMode}
          productLedOpportunity={productLedOpportunity}
          onSelectProductLedOpportunity={handleSelectProductLedOpportunity}
        />}

          {activeGenSession && (
            <ActiveGenerationPanel
              session={activeGenSession}
              generating={generating}
              generatingGroupIdx={generatingGroupIdx}
              generatedCount={generatedImages.length}
              onDismiss={() => setActiveGenSession(null)}
            />
          )}
          {generatedImages.length>0 && !activeGenSession && <PublishPanel queueItems={queue} onOpenPublish={()=>handleOpenPublish()}/>}
        </>)}
      </div>

      <HistoryDrawer
        open={showHistory}
        loaded={historyLoaded}
        onClose={()=>setShowHistory(false)}
        entries={historyEntries}
        onOpen={entry=>{
          setHistoryPreviewEntry(entry);
          setShowHistory(false);
        }}
        onAddedToPlan={()=>{
          // pinStore emits "vp:pin_store_updated" automatically;
          // the drawer re-renders via its own listener.
          // This hook is available for any parent-level side effects.
        }}
      />

      {historyPreviewEntry && (
        <HistoryPreviewModal
          entry={historyPreviewEntry}
          onClose={()=>setHistoryPreviewEntry(null)}
          onLoadInStudio={entry=>{
            setGeneratedGroups(entry.groups);
            if (entry.keyword) {
              setKeyword(entry.keyword);
              if (entry.category) setCategory(entry.category);
              setFromWorkspace(true);
            }
            setHistoryPreviewEntry(null);
          }}
        />
      )}

      <ScheduleModal open={showPublishModal} generatedImages={generatedImages} initialImageUrl={publishTargetUrl}
        keyword={keyword} onClose={()=>setShowPublishModal(false)} onSuccess={handlePublishSuccess}/>
    </div>
  );
}
