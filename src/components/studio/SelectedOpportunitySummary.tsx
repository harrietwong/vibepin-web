"use client";
import { PenLine } from "lucide-react";
import { type DemandBand, type CompetitionBand, type TrendState } from "@/lib/studio/opportunity-bands";

export type OpportunitySummaryProps = {
  keyword:          string;
  demandBand:       DemandBand;
  competitionBand:  CompetitionBand;
  trendState:       TrendState;
  evidenceSentence?: string;
  onClear:          () => void;
};

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

function getPrimaryBadge(demand: DemandBand, comp: CompetitionBand): { label: string; color: string } {
  if (demand === "High" && comp !== "High") return { label: "Best Bet",    color: "#16A34A" };
  if (comp  === "High")                    return { label: "Competitive", color: "#D97706" };
  return                                          { label: "Steady",      color: "#2563EB" };
}

function getTrendBadge(state: TrendState): { label: string; color: string } {
  if (state === "Rising")   return { label: "Rising",   color: "#059669" };
  if (state === "Seasonal") return { label: "Seasonal", color: "#D97706" };
  return                           { label: "Evergreen", color: "#2563EB" };
}

export function SelectedOpportunitySummary({
  keyword, demandBand, competitionBand, trendState, evidenceSentence, onClear,
}: OpportunitySummaryProps) {
  return (
    <div style={{
      borderRadius:10, padding:"10px 14px",
      border:"1px solid rgba(124,58,237,0.25)",
      background:"rgba(124,58,237,0.03)",
      display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12,
    }}>
      <div style={{flex:1,minWidth:0}}>
        {/* Label */}
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
          <span style={{fontSize:"9px",fontWeight:700,color:"#7C3AED",background:"rgba(124,58,237,0.1)",padding:"1px 6px",borderRadius:3}}>
            Opportunity selected
          </span>
        </div>

        {/* Keyword */}
        <p style={{margin:"0 0 5px",fontSize:"13px",fontWeight:700,color:"#0F172A",textTransform:"capitalize"}}>
          {keyword}
        </p>

        {/* 2-badge system: primary + trend */}
        {(() => {
          const pb = getPrimaryBadge(demandBand, competitionBand);
          const tb = getTrendBadge(trendState);
          return (
            <>
              <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:evidenceSentence?4:0}}>
                <Badge label={pb.label} color={pb.color}/>
                <Badge label={tb.label} color={tb.color}/>
              </div>
              {evidenceSentence && (
                <p style={{margin:0,fontSize:"10px",color:"#64748B"}}>{evidenceSentence}</p>
              )}
            </>
          );
        })()}
      </div>

      <button type="button" onClick={onClear}
        style={{display:"flex",alignItems:"center",gap:4,fontSize:"10px",fontWeight:600,color:"#94A3B8",background:"none",border:"none",cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"}}>
        <PenLine style={{width:11,height:11}}/> Change
      </button>
    </div>
  );
}
