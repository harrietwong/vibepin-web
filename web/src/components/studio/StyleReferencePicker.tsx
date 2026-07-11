"use client";
import { useState, useEffect, useRef } from "react";
import { CheckCircle2, X, Upload, Sparkles } from "lucide-react";
import { supabase } from "@/lib/supabase";

// ── Types ──────────────────────────────────────────────────────────────────────

export type StyleReferenceSource =
  | "opportunity_direct"   // pin directly linked to the selected opportunity
  | "similar_category"     // same category, high-save, no direct link
  | "viral_pins"           // top-save pins used as mood references
  | "user_upload";         // user-uploaded image

export type StyleReferenceItem = {
  id:             string;
  imageUrl:       string;
  saveCount:      number;
  source:         StyleReferenceSource;
  sourceKeyword?: string;
  visualFormat?:  string;
  humanPresence?: string;
  reason?:        string;
};

// Backward-compat shape used by callers that pass planPinSamples
export type PinRef = {
  id:               string;
  image_url:        string;
  save_count:       number;
  source_keyword?:  string | null;
};

type ActiveTab = "recommended" | "upload";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtSaves(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function sourceLabel(src: StyleReferenceSource): string {
  switch (src) {
    case "opportunity_direct": return "Direct match";
    case "similar_category":   return "Similar pin";
    case "viral_pins":         return "Viral Pin";
    case "user_upload":        return "Uploaded";
  }
}

function sourceLabelColor(src: StyleReferenceSource): string {
  switch (src) {
    case "opportunity_direct": return "#7C3AED";
    case "similar_category":   return "#2563EB";
    case "viral_pins":         return "#D97706";
    case "user_upload":        return "#059669";
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function StyleReferencePicker({
  recommendedPins,
  selectedRefs,
  onToggle,
  customStyleRef,
  setCustomStyleRef,
  hasOpportunity,
  opportunityCategory,
  opportunityKeyword,
}: {
  recommendedPins:      PinRef[];
  selectedRefs:         string[];
  onToggle:             (url: string) => void;
  customStyleRef:       string | null;
  setCustomStyleRef:    (url: string | null) => void;
  hasOpportunity:       boolean;
  opportunityCategory?: string;
  opportunityKeyword?:  string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [activeTab,      setActiveTab]      = useState<ActiveTab>("recommended");
  const [fallbackPins,   setFallbackPins]   = useState<StyleReferenceItem[]>([]);
  const [loadingFallback, setLoadingFallback] = useState(false);

  const cat = opportunityCategory?.toLowerCase().replace(/\s+/g, "-") ?? "fashion";

  // Normalise direct opportunity pins into StyleReferenceItem shape
  const directItems: StyleReferenceItem[] = recommendedPins.map(p => ({
    id:           p.id,
    imageUrl:     p.image_url,
    saveCount:    p.save_count,
    source:       "opportunity_direct" as StyleReferenceSource,
    sourceKeyword: p.source_keyword ?? opportunityKeyword,
  }));

  const needsFallback = hasOpportunity && directItems.length < 4;

  // Load fallback pins from similar category when direct refs are sparse
  useEffect(() => {
    if (!needsFallback) { setFallbackPins([]); return; }
    setLoadingFallback(true);
    const excludeUrls = new Set(directItems.map(d => d.imageUrl));

    Promise.resolve(
      supabase
        .from("pin_samples")
        .select("id,image_url,save_count,source_keyword")
        .not("image_url", "is", null)
        .order("save_count", { ascending: false })
        .limit(24)
    ).then(({ data }) => {
      if (!data?.length) { setLoadingFallback(false); return; }
      const items: StyleReferenceItem[] = (data as PinRef[])
        .filter(p => !excludeUrls.has(p.image_url))
        .slice(0, 8 - directItems.length)
        .map(p => ({
          id:           p.id,
          imageUrl:     p.image_url,
          saveCount:    p.save_count,
          source:       "similar_category" as StyleReferenceSource,
          sourceKeyword: p.source_keyword ?? undefined,
          reason:       "High-save pin — used for visual mood and composition",
        }));
      setFallbackPins(items);
      setLoadingFallback(false);
    }).catch(() => setLoadingFallback(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsFallback, directItems.map(d => d.id).join(",")]);

  // Merged list: direct first, then fallback (deduplicated by imageUrl)
  const directUrls = new Set(directItems.map(d => d.imageUrl));
  const allItems: StyleReferenceItem[] = [
    ...directItems,
    ...fallbackPins.filter(f => !directUrls.has(f.imageUrl)),
  ];

  const hasDirect    = directItems.length > 0;
  const hasFallback  = fallbackPins.length > 0;
  const totalSelected = selectedRefs.length + (customStyleRef && !selectedRefs.includes(customStyleRef) ? 1 : 0);

  function handleFile(file: File) {
    const r = new FileReader();
    r.onload = e => {
      setCustomStyleRef(e.target?.result as string ?? null);
      setActiveTab("recommended"); // switch back after upload so it's visible
    };
    r.readAsDataURL(file);
  }

  const isCustomUploaded = !!customStyleRef;
  const hasAnySelected   = totalSelected > 0;

  return (
    <div data-testid="style-reference-picker">

      {/* ── Header ── */}
      <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8,gap:12 }}>
        <div>
          <p style={{ margin:0,fontSize:"11px",fontWeight:800,color:"#374151",textTransform:"uppercase",letterSpacing:"0.07em" }}>
            Choose style references
          </p>
          <p style={{ margin:"2px 0 0",fontSize:"11px",color:"#94A3B8" }}>
            Use these for mood, layout, and Pinterest-native composition — not for copying.
          </p>
        </div>
      </div>

      {/* Multi-ref notice */}
      {totalSelected > 1 && (
        <p style={{ margin:"0 0 8px",fontSize:"10px",color:"#C026D3",fontWeight:600 }}>
          {totalSelected} references selected · each creates its own style group
        </p>
      )}

      {/* ── Tabs ── */}
      <div style={{ display:"flex",gap:4,marginBottom:12 }}>
        {(["recommended", "upload"] as ActiveTab[]).map(tab => {
          const isActive = activeTab === tab;
          const badge    = tab === "recommended" && allItems.length > 0 ? allItems.length : null;
          return (
            <button key={tab} type="button" onClick={() => setActiveTab(tab)}
              style={{
                padding:"4px 12px",borderRadius:20,fontSize:"10px",fontWeight:700,
                cursor:"pointer",border:"none",
                background: isActive ? "#7C3AED" : "#F1F5F9",
                color:      isActive ? "#fff"    : "#64748B",
              }}>
              {tab === "recommended" ? "Recommended" : "Upload"}
              {badge && (
                <span style={{ marginLeft:4,opacity:0.75 }}>{badge}</span>
              )}
              {tab === "upload" && isCustomUploaded && (
                <span style={{ marginLeft:4,color:isActive?"#fff":"#059669",fontWeight:900 }}>✓</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Tab: Recommended ── */}
      {activeTab === "recommended" && (
        <>
          {/* Context banner when showing fallback only */}
          {!hasDirect && hasFallback && (
            <div style={{ marginBottom:10,padding:"6px 10px",borderRadius:8,background:"rgba(37,99,235,0.06)",border:"1px solid rgba(37,99,235,0.14)" }}>
              <p style={{ margin:"0 0 1px",fontSize:"10px",fontWeight:700,color:"#2563EB" }}>Showing similar pins</p>
              <p style={{ margin:0,fontSize:"10px",color:"#64748B" }}>
                No pins were directly linked to this opportunity — showing high-save {cat.replace(/-/g," ")} pins for mood and composition.
              </p>
            </div>
          )}

          {/* Pin grid */}
          {allItems.length > 0 ? (
            <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10 }}>
              {allItems.map(item => {
                const sel = selectedRefs.includes(item.imageUrl);
                const lbl = sourceLabel(item.source);
                const clr = sourceLabelColor(item.source);
                return (
                  <div key={item.id} data-testid="style-reference-card"
                    style={{ display:"flex",flexDirection:"column",gap:3 }}>
                    <button type="button"
                      aria-pressed={sel}
                      onClick={() => onToggle(item.imageUrl)}
                      style={{
                        position:"relative",borderRadius:8,overflow:"hidden",
                        padding:0,cursor:"pointer",aspectRatio:"2/3",width:"100%",
                        border: sel ? "2.5px solid #C026D3" : "1.5px solid #E5E7EB",
                        boxShadow: sel ? "0 0 0 1px #C026D3" : "none",
                        background:"#F1F5F9",
                      }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.imageUrl} alt="" loading="lazy"
                        style={{ width:"100%",height:"100%",objectFit:"cover",display:"block" }}/>
                      {sel && (
                        <>
                          <div style={{ position:"absolute",top:4,right:4,width:18,height:18,borderRadius:"50%",background:"#C026D3",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }}>
                            <CheckCircle2 style={{ width:11,height:11,color:"#fff" }}/>
                          </div>
                          <div style={{ position:"absolute",inset:0,background:"rgba(192,38,211,0.08)",pointerEvents:"none" }}/>
                        </>
                      )}
                      {/* Source badge */}
                      {item.source !== "opportunity_direct" && (
                        <div style={{ position:"absolute",bottom:4,left:4,padding:"1px 5px",borderRadius:4,background:"rgba(0,0,0,0.55)" }}>
                          <span style={{ fontSize:"8px",fontWeight:700,color:clr }}>{lbl}</span>
                        </div>
                      )}
                    </button>
                    <p style={{ margin:0,fontSize:"9px",color:"#94A3B8",textAlign:"center" }}>
                      {fmtSaves(item.saveCount)} saves
                    </p>
                  </div>
                );
              })}
              {/* Skeleton slots while fallback loads */}
              {loadingFallback && !hasFallback && directItems.length < 4 && [1, 2].map(i => (
                <div key={`sk${i}`} style={{ aspectRatio:"2/3",borderRadius:8,background:"#F1F5F9",animation:"pulse 1.5s ease-in-out infinite" }}/>
              ))}
            </div>
          ) : loadingFallback ? (
            /* Full skeleton while loading */
            <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10 }}>
              {[1,2,3,4].map(i => (
                <div key={i} style={{ aspectRatio:"2/3",borderRadius:8,background:"#F1F5F9",animation:"pulse 1.5s ease-in-out infinite" }}/>
              ))}
            </div>
          ) : hasOpportunity ? (
            /* Empty state — opportunity selected, nothing found anywhere */
            <div style={{ borderRadius:10,padding:"16px 18px",border:"1.5px dashed #E5E7EB",background:"#FAFAFA",marginBottom:10 }}>
              <p style={{ margin:"0 0 4px",fontSize:"12px",fontWeight:700,color:"#374151" }}>No style references found yet</p>
              <p style={{ margin:"0 0 12px",fontSize:"11px",color:"#94A3B8",lineHeight:1.5 }}>
                You can upload your own reference, browse Viral Pins, or generate with Auto Style.
              </p>
              <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
                <button type="button"
                  onClick={() => setActiveTab("upload")}
                  style={{ padding:"5px 12px",borderRadius:8,border:"1px solid rgba(192,38,211,0.3)",background:"rgba(192,38,211,0.05)",fontSize:"10px",fontWeight:700,color:"#C026D3",cursor:"pointer",display:"flex",alignItems:"center",gap:4 }}>
                  <Upload style={{ width:10,height:10 }}/> Upload style reference
                </button>
                <a href={`/app/discover${opportunityKeyword ? `?keyword=${encodeURIComponent(opportunityKeyword)}` : ""}`}
                  style={{ padding:"5px 12px",borderRadius:8,border:"1px solid #E5E7EB",background:"#fff",fontSize:"10px",fontWeight:600,color:"#374151",textDecoration:"none" }}>
                  Browse Viral Pins
                </a>
              </div>
            </div>
          ) : (
            /* No opportunity selected yet */
            <p style={{ margin:"0 0 10px",fontSize:"10px",color:"#94A3B8" }}>
              Select an opportunity above to load recommended references.
            </p>
          )}

          {/* Auto Style notice when opp selected + 0 refs */}
          {hasOpportunity && !hasAnySelected && (
            <div style={{ padding:"7px 10px",borderRadius:8,background:"rgba(124,58,237,0.06)",border:"1px solid rgba(124,58,237,0.14)",display:"flex",alignItems:"center",gap:7,marginBottom:8 }}>
              <Sparkles style={{ width:11,height:11,color:"#7C3AED",flexShrink:0 }}/>
              <p style={{ margin:0,fontSize:"10px",color:"#7C3AED",fontWeight:600 }}>
                No reference selected — generation will use Auto Style (category playbook).
              </p>
            </div>
          )}

          {/* Browse more link */}
          {hasOpportunity && (
            <a href={`/app/workspace/${cat}`}
              style={{ display:"inline-flex",alignItems:"center",gap:3,fontSize:"10px",color:"#7C3AED",fontWeight:600,textDecoration:"none" }}>
              Browse more Pin Opportunities →
            </a>
          )}

          {/* Quick-deselect chips */}
          {selectedRefs.length > 0 && (
            <div style={{ marginTop:8,display:"flex",gap:5,flexWrap:"wrap" }}>
              {selectedRefs.map((url, i) => (
                <button key={url} type="button" onClick={() => onToggle(url)}
                  style={{ display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:20,border:"1px solid rgba(192,38,211,0.3)",background:"rgba(192,38,211,0.06)",fontSize:"9px",fontWeight:700,color:"#C026D3",cursor:"pointer" }}>
                  Ref {i + 1}
                  <X style={{ width:8,height:8 }}/>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Tab: Upload ── */}
      {activeTab === "upload" && (
        <div style={{ marginBottom:10 }}>
          {customStyleRef ? (
            <div style={{ display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",borderRadius:8,border:"1px solid rgba(192,38,211,0.2)",background:"rgba(192,38,211,0.04)" }}>
              <div style={{ width:50,height:70,borderRadius:7,overflow:"hidden",border:"1px solid #E5E7EB",flexShrink:0,background:"#F1F5F9" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={customStyleRef} alt="Uploaded reference"
                  style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
              </div>
              <div style={{ flex:1,minWidth:0 }}>
                <p style={{ margin:"0 0 2px",fontSize:"11px",fontWeight:700,color:"#C026D3" }}>✓ Reference uploaded</p>
                <p style={{ margin:"0 0 8px",fontSize:"10px",color:"#94A3B8",lineHeight:1.4 }}>
                  Used for mood, layout, and composition only — the scene will be rebuilt around your products.
                </p>
                <div style={{ display:"flex",gap:8 }}>
                  <button type="button" onClick={() => fileRef.current?.click()}
                    style={{ fontSize:"10px",fontWeight:600,color:"#C026D3",background:"none",border:"none",cursor:"pointer",padding:0 }}>
                    Replace
                  </button>
                  <button type="button" onClick={() => setCustomStyleRef(null)}
                    style={{ fontSize:"10px",fontWeight:600,color:"#94A3B8",background:"none",border:"none",cursor:"pointer",padding:0 }}>
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <button type="button" onClick={() => fileRef.current?.click()}
                style={{ width:"100%",padding:"20px 16px",borderRadius:10,border:"1.5px dashed #D1D5DB",background:"#FAFAFA",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6,marginBottom:8 }}>
                <Upload style={{ width:20,height:20,color:"#94A3B8" }}/>
                <p style={{ margin:0,fontSize:"12px",fontWeight:600,color:"#374151" }}>Upload style reference</p>
                <p style={{ margin:0,fontSize:"10px",color:"#94A3B8",lineHeight:1.4 }}>
                  Used for mood, layout, color, and composition. We won&apos;t copy the exact image.
                </p>
              </button>
              <p style={{ margin:0,fontSize:"9px",color:"#CBD5E1",textAlign:"center" }}>
                Only use images you have the right to reference.
              </p>
            </>
          )}
        </div>
      )}

      {/* Hidden file input */}
      <input ref={fileRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}/>
    </div>
  );
}
