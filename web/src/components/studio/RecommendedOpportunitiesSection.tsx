"use client";
import { useState, useEffect } from "react";
import { CheckCircle2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { type OpportunityRow } from "@/lib/studio/opportunity-bands";
import {
  getRecommendedOpportunitiesForProducts,
  type ScoredOpportunity, type PinSample, type ProductSignal, type ProductLedOpportunity,
} from "@/lib/studio/product-led-recommendations";

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize:"9px",fontWeight:700,color,
      background:`${color}15`,padding:"2px 6px",
      borderRadius:20,border:`1px solid ${color}30`,
      whiteSpace:"nowrap",
    }}>
      {label}
    </span>
  );
}

function getPrimaryBadge(demand: string, comp: string): { label: string; color: string } {
  if (demand === "High" && comp !== "High") return { label: "Best Bet",    color: "#16A34A" };
  if (comp  === "High")                    return { label: "Competitive", color: "#D97706" };
  return                                          { label: "Steady",      color: "#2563EB" };
}

function getTrendBadge(state: string): { label: string; color: string } {
  if (state === "Rising")   return { label: "Rising",   color: "#059669" };
  if (state === "Seasonal") return { label: "Seasonal", color: "#D97706" };
  return                           { label: "Evergreen", color: "#2563EB" };
}

type LoadState = "loading" | "done" | "error";

const DEFAULT_VISIBLE = 4;

export function RecommendedOpportunitiesSection({
  products,
  selectedKeyword,
  onSelectOpportunity,
}: {
  products:            ProductSignal[];
  selectedKeyword:     string | null;
  onSelectOpportunity: (opp: ProductLedOpportunity) => void;
}) {
  const [loadState, setLoadState]   = useState<LoadState>("loading");
  const [opps,      setOpps]        = useState<ScoredOpportunity[]>([]);
  const [refsByKw,  setRefsByKw]    = useState<Record<string, PinSample[]>>({});
  const [showAll,   setShowAll]     = useState(false);

  const productKey = products.map(p => p.id).join(",");

  useEffect(() => {
    if (!products.length) { setLoadState("done"); return; }
    setLoadState("loading");

    supabase
      .from("trend_keywords")
      .select("id,keyword,category,search_volume_level,priority_score,yearly_change")
      .eq("status", "active")
      .order("priority_score", { ascending: false })
      .limit(100)
      .then(({ data, error }) => {
        if (error || !data?.length) { setLoadState(error ? "error" : "done"); return; }

        const recommended = getRecommendedOpportunitiesForProducts(
          products,
          data as OpportunityRow[],
        );
        setOpps(recommended);

        const topIds = recommended.slice(0, 6).map(r => r.id);
        if (!topIds.length) { setLoadState("done"); return; }

        Promise.resolve(
          supabase
            .from("pin_samples")
            .select("id,image_url,save_count,trend_keyword_id")
            .in("trend_keyword_id", topIds)
            .not("image_url", "is", null)
            .order("save_count", { ascending: false })
            .limit(36)
        ).then(({ data: pins }) => {
          const byKw: Record<string, PinSample[]> = {};
          for (const pin of (pins ?? []) as (PinSample & { trend_keyword_id: string })[]) {
            const kw = recommended.find(r => r.id === pin.trend_keyword_id)?.keyword ?? "";
            if (!kw) continue;
            if (!byKw[kw]) byKw[kw] = [];
            byKw[kw].push({ id: pin.id, image_url: pin.image_url, save_count: pin.save_count });
          }
          setRefsByKw(byKw);
          setLoadState("done");
        }).catch(() => setLoadState("done"));
      }, () => setLoadState("error"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productKey]);

  function handleSelect(opp: ScoredOpportunity) {
    const refs = refsByKw[opp.keyword] ?? [];
    onSelectOpportunity({
      keyword:          opp.keyword,
      category:         opp.category,
      demandBand:       opp.demandBand,
      competitionBand:  opp.competitionBand,
      trendState:       opp.trendState,
      evidenceSentence: opp.evidenceSentence,
      referencePins:    refs.slice(0, 6),
    });
  }

  const visibleOpps = showAll ? opps : opps.slice(0, DEFAULT_VISIBLE);

  return (
    <div data-testid="recommended-opportunities-section">
      {/* Header */}
      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:4}}>
        <div>
          <p style={{margin:0,fontSize:"11px",fontWeight:800,color:"#374151",textTransform:"uppercase",letterSpacing:"0.07em"}}>
            Recommended opportunities for these products
          </p>
          <p style={{margin:"2px 0 0",fontSize:"11px",color:"#94A3B8"}}>
            Based on product category, keywords, visual match, demand, and Pin evidence.
          </p>
        </div>
        {loadState==="done" && opps.length > DEFAULT_VISIBLE && (
          <button type="button" onClick={() => setShowAll(v => !v)}
            style={{fontSize:"11px",fontWeight:600,color:"#7C3AED",background:"none",border:"none",cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,marginLeft:12}}>
            {showAll ? "Show less" : `Show more`} {!showAll && <span style={{fontSize:"10px"}}>↓</span>}
          </button>
        )}
      </div>

      {/* Loading skeletons */}
      {loadState === "loading" && (
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginTop:8}}>
          <p style={{margin:"0 0 8px",fontSize:"11px",color:"#94A3B8",gridColumn:"1/-1"}}>Finding matching opportunities…</p>
          {[0,1,2,3].map(i => (
            <div key={i} style={{height:140,borderRadius:10,background:"#F1F5F9",animation:"pulse 1.5s ease-in-out infinite"}}/>
          ))}
        </div>
      )}

      {/* Error */}
      {loadState === "error" && (
        <div style={{borderRadius:10,padding:"14px",border:"1px solid #FECACA",background:"#FFF5F5",textAlign:"center",marginTop:8}}>
          <p style={{margin:"0 0 8px",fontSize:"12px",fontWeight:700,color:"#EF4444"}}>Could not load recommendations</p>
          <a href="/app/workspace/fashion"
            style={{padding:"5px 12px",borderRadius:7,border:"1px solid #E5E7EB",background:"#fff",fontSize:"11px",fontWeight:600,color:"#374151",textDecoration:"none"}}>
            Browse Pin Opportunities
          </a>
        </div>
      )}

      {/* Empty */}
      {loadState === "done" && opps.length === 0 && (
        <div style={{borderRadius:10,padding:"18px",border:"1.5px dashed #E5E7EB",background:"#FAFAFA",textAlign:"center",marginTop:8}}>
          <p style={{margin:"0 0 4px",fontSize:"13px",fontWeight:700,color:"#374151"}}>No strong matches yet</p>
          <p style={{margin:"0 0 12px",fontSize:"11px",color:"#94A3B8"}}>Try browsing Pin Opportunities or start from scratch.</p>
          <div style={{display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap"}}>
            <a href="/app/workspace/fashion"
              style={{padding:"5px 12px",borderRadius:7,border:"1px solid #E5E7EB",background:"#fff",fontSize:"11px",fontWeight:600,color:"#374151",textDecoration:"none"}}>
              Browse Pin Opportunities
            </a>
            <a href="/app/trends"
              style={{padding:"5px 12px",borderRadius:7,border:"1px solid #E5E7EB",background:"#fff",fontSize:"11px",fontWeight:600,color:"#374151",textDecoration:"none"}}>
              Browse Keyword Trends
            </a>
            <button type="button"
              onClick={() => onSelectOpportunity({
                keyword: products.map(p => p.product_name).join(", "),
                category: "fashion",
                demandBand: "Medium", competitionBand: "Medium", trendState: "Evergreen",
                evidenceSentence: "Generating directly from selected products.",
                referencePins: [],
              })}
              style={{padding:"5px 12px",borderRadius:7,border:"1px solid #E5E7EB",background:"#fff",fontSize:"11px",fontWeight:600,color:"#374151",cursor:"pointer"}}>
              Start from scratch
            </button>
          </div>
        </div>
      )}

      {/* Opportunity cards grid */}
      {loadState === "done" && opps.length > 0 && (
        <div style={{
          display:"grid",
          gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",
          gap:8,
          marginTop:8,
        }}>
          {visibleOpps.map(opp => {
            const refs     = refsByKw[opp.keyword] ?? [];
            const isSel    = opp.keyword === selectedKeyword;
            return (
              <div key={opp.id}
                data-testid="opportunity-card"
                onClick={() => handleSelect(opp)}
                style={{
                  borderRadius:10,
                  border: isSel ? "2px solid #7C3AED" : "1px solid #E5E7EB",
                  background: isSel ? "rgba(124,58,237,0.04)" : "#FAFAFA",
                  boxShadow: isSel ? "0 0 0 2px rgba(124,58,237,0.12)" : "none",
                  padding:"12px",
                  cursor:"pointer",
                  display:"flex",flexDirection:"column",gap:8,
                  position:"relative",
                  transition:"border-color 0.12s, box-shadow 0.12s",
                }}
                onMouseEnter={e=>{if(!isSel){(e.currentTarget as HTMLDivElement).style.borderColor="#CBD5E1";}}}
                onMouseLeave={e=>{if(!isSel){(e.currentTarget as HTMLDivElement).style.borderColor="#E5E7EB";}}}
              >
                {/* Selected check */}
                {isSel && (
                  <div style={{position:"absolute",top:8,right:8,width:20,height:20,borderRadius:"50%",background:"#7C3AED",display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <CheckCircle2 style={{width:13,height:13,color:"#fff"}}/>
                  </div>
                )}

                {/* Keyword title */}
                <p style={{margin:0,fontSize:"12px",fontWeight:700,color:"#0F172A",textTransform:"capitalize",paddingRight:isSel?24:0,lineHeight:1.3}}>
                  {opp.keyword}
                </p>

                {/* 2-badge system: primary + trend */}
                {(() => {
                  const pb = getPrimaryBadge(opp.demandBand, opp.competitionBand);
                  const tb = getTrendBadge(opp.trendState);
                  return (
                    <div>
                      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:4}}>
                        <Badge label={pb.label} color={pb.color}/>
                        <Badge label={tb.label} color={tb.color}/>
                      </div>
                      {opp.evidenceSentence && (
                        <p style={{margin:0,fontSize:"10px",color:"#64748B",lineHeight:1.3}}>
                          {opp.evidenceSentence}
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Reference pin thumbnails */}
                {refs.length > 0 && (
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    {refs.slice(0, 3).map(pin => (
                      <div key={pin.id}
                        style={{width:28,height:40,borderRadius:4,overflow:"hidden",border:"1px solid #E5E7EB",flexShrink:0,background:"#F1F5F9"}}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={pin.image_url} alt=""
                          style={{width:"100%",height:"100%",objectFit:"cover"}}
                          onError={e=>{(e.currentTarget.parentElement as HTMLDivElement).style.display="none";}}/>
                      </div>
                    ))}
                    {refs.length > 3 && (
                      <span style={{fontSize:"10px",color:"#94A3B8",fontWeight:600}}>+{refs.length - 3}</span>
                    )}
                  </div>
                )}

                {/* CTA */}
                <button type="button"
                  onClick={e=>{e.stopPropagation();handleSelect(opp);}}
                  style={{
                    marginTop:"auto",
                    padding:"5px 10px",borderRadius:6,border:"none",
                    background: isSel
                      ? "rgba(124,58,237,0.12)"
                      : "linear-gradient(135deg,#FF4D8D,#7C3AED)",
                    color: isSel ? "#7C3AED" : "#fff",
                    fontSize:"11px",fontWeight:700,cursor:"pointer",
                    display:"flex",alignItems:"center",justifyContent:"center",gap:4,
                  }}>
                  {isSel ? "✓ Selected" : "Use this opportunity"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
