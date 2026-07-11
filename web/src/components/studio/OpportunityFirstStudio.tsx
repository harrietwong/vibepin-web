"use client";
import { useState, useEffect, useRef } from "react";
import { Search, SlidersHorizontal, X, Upload, CheckCircle2, Sparkles, ExternalLink, Clock } from "lucide-react";
import { supabase } from "@/lib/supabase";

// ── Local types ────────────────────────────────────────────────────────────────

type OppRow = {
  id:                  string;
  keyword:             string;
  category:            string;
  yearly_change:       number | null;
  priority_score:      number | null;
  search_volume_level: string | null;
  image_url?:          string | null; // from pin_samples join if available
};

type PinRef = {
  id:              string;
  image_url:       string;
  save_count:      number;
  source_keyword?: string | null;
};

type GeneratedGroup = { refUrl: string | null; images: string[] };

// ── Badge helpers ─────────────────────────────────────────────────────────────

function primaryBadge(row: OppRow): { label: string; color: string; bg: string } {
  const ps = row.priority_score ?? 0;
  if (ps >= 70) return { label: "Best Bet",    color: "#16A34A", bg: "rgba(22,163,74,0.1)"  };
  if (ps >= 40) return { label: "Steady",      color: "#2563EB", bg: "rgba(37,99,235,0.1)"  };
  return           { label: "Competitive", color: "#D97706", bg: "rgba(217,119,6,0.1)"  };
}

function trendBadge(row: OppRow): { label: string; color: string; bg: string } {
  const yoy = row.yearly_change ?? 0;
  if (yoy >= 50) return { label: "Rising",   color: "#059669", bg: "rgba(5,150,105,0.1)"  };
  if (yoy > 0)   return { label: "Evergreen", color: "#2563EB", bg: "rgba(37,99,235,0.1)"  };
  return           { label: "Seasonal", color: "#94A3B8", bg: "rgba(148,163,184,0.1)" };
}

function catLabel(cat: string): string {
  return cat.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ── OpportunityCard ───────────────────────────────────────────────────────────

function OpportunityCard({
  row, selected, onSelect, coverUrl,
}: {
  row: OppRow; selected: boolean; onSelect: () => void; coverUrl: string | null;
}) {
  const pb = primaryBadge(row);
  const tb = trendBadge(row);

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10,
        padding: "10px 12px", borderRadius: 10, cursor: "pointer",
        border: selected ? "1.5px solid #7C3AED" : "1.5px solid #E5E7EB",
        background: selected ? "rgba(124,58,237,0.04)" : "#fff",
        transition: "border-color 0.12s, background 0.12s",
      }}
    >
      {/* Checkbox */}
      <div style={{
        width: 18, height: 18, borderRadius: 5, flexShrink: 0,
        border: `2px solid ${selected ? "#7C3AED" : "#D1D5DB"}`,
        background: selected ? "#7C3AED" : "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {selected && <CheckCircle2 style={{ width: 11, height: 11, color: "#fff" }}/>}
      </div>

      {/* Cover */}
      <div style={{ width: 44, height: 44, borderRadius: 7, overflow: "hidden", flexShrink: 0, background: "#F1F5F9" }}>
        {coverUrl
          /* eslint-disable-next-line @next/next/no-img-element */
          ? <img src={coverUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}
              onError={e => { e.currentTarget.style.display = "none"; }}/>
          : <div style={{ width: "100%", height: "100%", background: `linear-gradient(135deg,${pb.bg},${tb.bg})` }}/>}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: "0 0 4px", fontSize: "12px", fontWeight: 700, color: "#0F172A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.keyword}
        </p>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: "9px", fontWeight: 700, color: pb.color, background: pb.bg, padding: "1px 6px", borderRadius: 20, border: `1px solid ${pb.color}30`, whiteSpace: "nowrap" }}>
            {pb.label}
          </span>
          <span style={{ fontSize: "9px", fontWeight: 700, color: tb.color, background: tb.bg, padding: "1px 6px", borderRadius: 20, border: `1px solid ${tb.color}30`, whiteSpace: "nowrap" }}>
            {tb.label}
          </span>
        </div>
        <p style={{ margin: "3px 0 0", fontSize: "10px", color: "#94A3B8" }}>{catLabel(row.category)}</p>
      </div>
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function OpportunityFirstStudio({
  // Current opportunity (from parent state)
  keyword, category,
  onSelectOpportunity,
  // References
  planPinSamples,
  selectedPlanRefs, onTogglePlanRef,
  customStyleRef, setCustomStyleRef,
  // Products
  myProductImages, onAddProductFiles, onRemoveProductImage,
  // Generation
  count, setCount,
  generating, generatingGroupIdx,
  generatedGroups,
  onGenerate,
  // Misc
  onOpenHistory,
  yoyFromUrl, planTier,
}: {
  keyword: string; category: string;
  onSelectOpportunity: (kw: string, cat: string, id: string, tier: string) => void;
  planPinSamples: PinRef[];
  selectedPlanRefs: string[]; onTogglePlanRef: (url: string) => void;
  customStyleRef: string | null; setCustomStyleRef: (u: string | null) => void;
  myProductImages: string[]; onAddProductFiles: (files: FileList) => void; onRemoveProductImage: (idx: number) => void;
  count: number; setCount: (n: number) => void;
  generating: boolean; generatingGroupIdx: number | null;
  generatedGroups: GeneratedGroup[];
  onGenerate: (req: { prompt: string; refs: string[]; productImages: string[]; imagesPerRef: number }) => void;
  onOpenHistory: () => void;
  yoyFromUrl?: number | null; planTier?: string;
}) {
  const productFileRef  = useRef<HTMLInputElement>(null);
  const customRefFileRef = useRef<HTMLInputElement>(null);

  // ── Local prompt state (owned here, not passed from parent) ───────────────
  const [promptText, setPromptText] = useState("");

  // ── Left panel state ───────────────────────────────────────────────────────
  const [opps,          setOpps]          = useState<OppRow[]>([]);
  const [coverByKw,     setCoverByKw]     = useState<Record<string, string>>({});
  const [loadingOpps,   setLoadingOpps]   = useState(true);
  const [searchQuery,   setSearchQuery]   = useState("");

  // ── Fetch opportunity list ─────────────────────────────────────────────────
  useEffect(() => {
    Promise.resolve(
      supabase.from("trend_keywords")
        .select("id,keyword,category,yearly_change,priority_score,search_volume_level")
        .eq("status", "active")
        .order("priority_score", { ascending: false })
        .limit(60)
    ).then(({ data }) => {
      if (!data?.length) { setLoadingOpps(false); return; }
      setOpps(data as OppRow[]);
      const ids = data.slice(0, 20).map((r: OppRow) => r.id);
      return Promise.resolve(
        supabase.from("pin_samples")
          .select("image_url,trend_keyword_id")
          .in("trend_keyword_id", ids)
          .not("image_url", "is", null)
          .order("save_count", { ascending: false })
          .limit(ids.length * 2)
      ).then(({ data: pins }) => {
        const byKw: Record<string, string> = {};
        for (const p of (pins ?? []) as { image_url: string; trend_keyword_id: string }[]) {
          const kw = data.find((r: OppRow) => r.id === p.trend_keyword_id)?.keyword;
          if (kw && !byKw[kw]) byKw[kw] = p.image_url;
        }
        setCoverByKw(byKw);
        setLoadingOpps(false);
      });
    }).catch(() => setLoadingOpps(false));
  }, []);

  const filteredOpps = searchQuery.trim()
    ? opps.filter(o => o.keyword.toLowerCase().includes(searchQuery.toLowerCase()) || o.category.toLowerCase().includes(searchQuery.toLowerCase()))
    : opps;

  // ── Derived state ──────────────────────────────────────────────────────────
  const selectedOpp    = opps.find(o => o.keyword.toLowerCase() === keyword.toLowerCase()) ?? null;
  const allRefs        = [...selectedPlanRefs, ...(customStyleRef && !selectedPlanRefs.includes(customStyleRef) ? [customStyleRef] : [])];
  const refCount       = allRefs.length;
  const totalPins      = (refCount > 0 ? refCount : 1) * count;
  const generatedImages = generatedGroups.flatMap(g => g.images);
  const pb             = selectedOpp ? primaryBadge(selectedOpp) : null;
  const tb             = selectedOpp ? trendBadge(selectedOpp) : null;
  const isReady        = !!keyword;

  const QUICK_IDEAS = ["Cozy lighting", "Natural materials", "Minimalist styling", "Warm neutrals", "Editorial look", "Earthy tones"];

  function handleRefFile(file: File) {
    const r = new FileReader();
    r.onload = e => setCustomStyleRef(e.target?.result as string ?? null);
    r.readAsDataURL(file);
  }

  function fireGenerate() {
    if (!keyword) return;
    onGenerate({
      prompt:        promptText,
      refs:          allRefs,
      productImages: myProductImages,
      imagesPerRef:  count,
    });
  }

  // ── STEP INDICATOR ─────────────────────────────────────────────────────────
  const STEPS = ["Opportunity", "References", "Products", "Settings", "Generate"];
  const activeStep = !keyword ? 1 : refCount === 0 && myProductImages.length === 0 ? 2 : generatedImages.length > 0 ? 5 : 4;

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>

      {/* ── LEFT PANEL: Opportunity Selector ─────────────────────────────── */}
      <aside style={{
        width: 300, flexShrink: 0, background: "#fff", borderRight: "1px solid #E5E7EB",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid #F1F5F9", flexShrink: 0 }}>
          <p style={{ margin: "0 0 1px", fontSize: "12px", fontWeight: 800, color: "#0F172A" }}>1. Pin Opportunity</p>
          <p style={{ margin: 0, fontSize: "11px", color: "#94A3B8" }}>Select the opportunity to create Pins for</p>
        </div>

        {/* Search */}
        <div style={{ padding: "10px 12px 6px", borderBottom: "1px solid #F1F5F9", flexShrink: 0 }}>
          <div style={{ position: "relative" }}>
            <Search style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 13, height: 13, color: "#94A3B8", pointerEvents: "none" }}/>
            <input
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search opportunities…"
              style={{ width: "100%", boxSizing: "border-box", paddingLeft: 30, paddingRight: 32, paddingTop: 7, paddingBottom: 7, borderRadius: 8, border: "1px solid #E5E7EB", fontSize: "12px", color: "#374151", outline: "none", background: "#F8FAFC" }}
            />
            <SlidersHorizontal style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", width: 12, height: 12, color: "#94A3B8", cursor: "pointer" }}/>
          </div>
        </div>

        {/* Opportunity list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
          {loadingOpps ? (
            [1,2,3,4,5].map(i => (
              <div key={i} style={{ height: 70, borderRadius: 10, background: "#F1F5F9", animation: "pulse 1.5s ease-in-out infinite" }}/>
            ))
          ) : filteredOpps.length === 0 ? (
            <p style={{ padding: "20px 0", textAlign: "center", fontSize: "12px", color: "#94A3B8" }}>No opportunities found</p>
          ) : filteredOpps.map(row => (
            <OpportunityCard
              key={row.id}
              row={row}
              selected={row.keyword.toLowerCase() === keyword.toLowerCase()}
              coverUrl={coverByKw[row.keyword] ?? null}
              onSelect={() => {
                const tier = (row.priority_score ?? 0) >= 70 ? "best_bet" : (row.priority_score ?? 0) >= 40 ? "steady" : "competitive";
                onSelectOpportunity(row.keyword, row.category, row.id, tier);
              }}
            />
          ))}
        </div>
      </aside>

      {/* ── MAIN AREA ────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* Step indicator */}
        <div style={{ padding: "10px 24px", borderBottom: "1px solid #F1F5F9", background: "#fff", flexShrink: 0, display: "flex", alignItems: "center", gap: 0 }}>
          {STEPS.map((step, i) => {
            const n     = i + 1;
            const isAct = n === activeStep;
            const isDone = n < activeStep;
            return (
              <div key={step} style={{ display: "flex", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                    background: isAct ? "#7C3AED" : isDone ? "#7C3AED" : "#F1F5F9",
                    flexShrink: 0,
                  }}>
                    {isDone
                      ? <CheckCircle2 style={{ width: 12, height: 12, color: "#fff" }}/>
                      : <span style={{ fontSize: "10px", fontWeight: 800, color: isAct ? "#fff" : "#94A3B8" }}>{n}</span>}
                  </div>
                  <span style={{ fontSize: "11px", fontWeight: isAct ? 700 : 500, color: isAct ? "#7C3AED" : "#94A3B8", whiteSpace: "nowrap" }}>{step}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <div style={{ width: 24, height: 1, background: "#E5E7EB", margin: "0 6px" }}/>
                )}
              </div>
            );
          })}

          {/* History */}
          <div style={{ marginLeft: "auto", flexShrink: 0 }}>
            <button type="button" onClick={onOpenHistory}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", fontSize: "11px", fontWeight: 600, borderRadius: 8, border: "1px solid #E5E7EB", background: "#FAFAFA", color: "#64748B", cursor: "pointer" }}>
              <Clock style={{ width: 12, height: 12 }}/> History
            </button>
          </div>
        </div>

        {/* Page title */}
        <div style={{ padding: "16px 24px 10px", borderBottom: "1px solid #F1F5F9", background: "#fff", flexShrink: 0 }}>
          <h1 style={{ margin: "0 0 3px", fontSize: "22px", fontWeight: 800, color: "#0F172A" }}>Create Pin Studio</h1>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
            {keyword ? `Turn this opportunity into Pinterest-native Pins that get saved.` : "Select an opportunity from the left to get started."}
          </p>
        </div>

        {/* Scrollable setup area */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 24 }}>

          {/* ── Opportunity summary bar ── */}
          {keyword && selectedOpp && (
            <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "12px 16px", borderRadius: 10, border: "1px solid #E5E7EB", background: "#F8FAFC", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: "10px", color: "#94A3B8", fontWeight: 600, whiteSpace: "nowrap" }}>Opportunity</span>
                <span style={{ fontSize: "14px", fontWeight: 800, color: "#0F172A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedOpp.keyword}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "10px", color: "#94A3B8", fontWeight: 600 }}>Category</span>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#374151" }}>{catLabel(selectedOpp.category)}</span>
              </div>
              {tb && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: "10px", color: "#94A3B8", fontWeight: 600 }}>Trend</span>
                  <span style={{ fontSize: "11px", fontWeight: 700, color: tb.color, background: tb.bg, padding: "2px 8px", borderRadius: 20, border: `1px solid ${tb.color}30` }}>{tb.label}</span>
                </div>
              )}
              {pb && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: "10px", color: "#94A3B8", fontWeight: 600 }}>Priority</span>
                  <span style={{ fontSize: "11px", fontWeight: 700, color: pb.color, background: pb.bg, padding: "2px 8px", borderRadius: 20, border: `1px solid ${pb.color}30` }}>{pb.label}</span>
                </div>
              )}
            </div>
          )}

          {/* ── Section 2: Style References ── */}
          <div>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6, gap: 10 }}>
              <div>
                <p style={{ margin: 0, fontSize: "14px", fontWeight: 800, color: "#0F172A" }}>
                  2. Style References <span style={{ fontSize: "12px", fontWeight: 500, color: "#94A3B8" }}>(for visual direction)</span>
                </p>
                <p style={{ margin: "3px 0 0", fontSize: "12px", color: "#64748B" }}>
                  Select 1–5 Pins that match the style you want. Each reference creates a style group.
                </p>
              </div>
              <a href="/app/discover"
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(124,58,237,0.3)", background: "rgba(124,58,237,0.06)", color: "#7C3AED", fontSize: "11px", fontWeight: 700, textDecoration: "none", flexShrink: 0, whiteSpace: "nowrap" }}>
                <ExternalLink style={{ width: 11, height: 11 }}/> Find Viral Pins
              </a>
            </div>

            {/* Reference grid */}
            {planPinSamples.length > 0 ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
                  {planPinSamples.map((pin, idx) => {
                    const sel   = selectedPlanRefs.includes(pin.image_url);
                    const selIdx = selectedPlanRefs.indexOf(pin.image_url);
                    return (
                      <div key={pin.id} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <button type="button"
                          onClick={() => onTogglePlanRef(pin.image_url)}
                          style={{
                            position: "relative", borderRadius: 10, overflow: "hidden", padding: 0, cursor: "pointer",
                            aspectRatio: "2/3", width: "100%",
                            border: sel ? "2.5px solid #7C3AED" : "1.5px solid #E5E7EB",
                            boxShadow: sel ? "0 0 0 2px rgba(124,58,237,0.15)" : "none",
                            background: "#F1F5F9",
                          }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={pin.image_url} alt="" loading="lazy"
                            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
                          {/* Selected overlay + check */}
                          {sel && (
                            <>
                              <div style={{ position: "absolute", inset: 0, background: "rgba(124,58,237,0.08)", pointerEvents: "none" }}/>
                              <div style={{ position: "absolute", top: 6, left: 6, width: 22, height: 22, borderRadius: "50%", background: "#7C3AED", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px rgba(0,0,0,0.3)" }}>
                                <CheckCircle2 style={{ width: 13, height: 13, color: "#fff" }}/>
                              </div>
                            </>
                          )}
                          {/* X remove */}
                          {sel && (
                            <button type="button"
                              onClick={e => { e.stopPropagation(); onTogglePlanRef(pin.image_url); }}
                              style={{ position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,0.55)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <X style={{ width: 10, height: 10, color: "#fff" }}/>
                            </button>
                          )}
                          {/* Save count */}
                          {!sel && (
                            <div style={{ position: "absolute", bottom: 5, right: 5, padding: "1px 5px", borderRadius: 6, background: "rgba(0,0,0,0.5)" }}>
                              <span style={{ fontSize: "9px", color: "#fff", fontWeight: 600 }}>
                                {pin.save_count >= 1000 ? `${(pin.save_count/1000).toFixed(1)}K` : String(pin.save_count)}
                              </span>
                            </div>
                          )}
                        </button>
                        {sel && (
                          <p style={{ margin: 0, fontSize: "10px", color: "#7C3AED", fontWeight: 700, textAlign: "center" }}>
                            Ref {selIdx + 1}
                          </p>
                        )}
                      </div>
                    );
                    void idx;
                  })}
                  {/* Upload custom ref slot */}
                  {customStyleRef && !planPinSamples.some(p => p.image_url === customStyleRef) && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", aspectRatio: "2/3", border: "2.5px solid #7C3AED", boxShadow: "0 0 0 2px rgba(124,58,237,0.15)" }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={customStyleRef} alt="Uploaded reference" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
                        <button type="button" onClick={() => setCustomStyleRef(null)}
                          style={{ position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,0.55)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <X style={{ width: 10, height: 10, color: "#fff" }}/>
                        </button>
                        <div style={{ position: "absolute", top: 6, left: 6, width: 22, height: 22, borderRadius: "50%", background: "#7C3AED", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <CheckCircle2 style={{ width: 13, height: 13, color: "#fff" }}/>
                        </div>
                      </div>
                      <p style={{ margin: 0, fontSize: "10px", color: "#7C3AED", fontWeight: 700, textAlign: "center" }}>Uploaded</p>
                    </div>
                  )}
                  {/* Upload slot */}
                  <button type="button" onClick={() => customRefFileRef.current?.click()}
                    style={{ aspectRatio: "2/3", borderRadius: 10, border: "1.5px dashed #D1D5DB", background: "#F8FAFC", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Upload style={{ width: 14, height: 14, color: "#94A3B8" }}/>
                    </div>
                    <span style={{ fontSize: "10px", color: "#94A3B8", fontWeight: 600, lineHeight: 1.3, textAlign: "center" }}>Upload<br/>reference</span>
                  </button>
                </div>

                {/* Selection summary */}
                {refCount > 0 && (
                  <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, background: "rgba(124,58,237,0.06)", border: "1px solid rgba(124,58,237,0.18)", display: "flex", alignItems: "center", gap: 6 }}>
                    <CheckCircle2 style={{ width: 13, height: 13, color: "#7C3AED", flexShrink: 0 }}/>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "#7C3AED" }}>
                      {refCount} reference{refCount !== 1 ? "s" : ""} selected · Each reference will generate its own group of images.
                    </span>
                  </div>
                )}
              </>
            ) : keyword ? (
              /* Loading or no refs */
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                {[1,2,3,4].map(i => (
                  <div key={i} style={{ aspectRatio: "2/3", borderRadius: 10, background: "#F1F5F9", animation: "pulse 1.5s ease-in-out infinite" }}/>
                ))}
              </div>
            ) : (
              <div style={{ padding: "20px", borderRadius: 10, border: "1.5px dashed #E5E7EB", background: "#F8FAFC", textAlign: "center" }}>
                <p style={{ margin: 0, fontSize: "12px", color: "#94A3B8" }}>Select an opportunity to load style references.</p>
              </div>
            )}

            <input ref={customRefFileRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleRefFile(f); }}/>
          </div>

          {/* ── Section 3: Product Images ── */}
          <div>
            <p style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 800, color: "#0F172A" }}>
              3. Product Images <span style={{ fontSize: "12px", fontWeight: 500, color: "#94A3B8" }}>(optional)</span>
            </p>
            <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#64748B" }}>Add 1–10 products to include in your Pins.</p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 8, maxWidth: 600 }}>
              {myProductImages.map((img, idx) => (
                <div key={idx} style={{ position: "relative", aspectRatio: "1/1", borderRadius: 10, overflow: "hidden", border: "1px solid #E5E7EB", background: "#F1F5F9" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img} alt={`Product ${idx + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
                  <button type="button" onClick={() => onRemoveProductImage(idx)}
                    style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.55)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <X style={{ width: 9, height: 9, color: "#fff" }}/>
                  </button>
                </div>
              ))}
              {myProductImages.length < 10 && (
                <button type="button" onClick={() => productFileRef.current?.click()}
                  style={{ aspectRatio: "1/1", borderRadius: 10, border: "1.5px dashed #D1D5DB", background: "#F8FAFC", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: "16px", color: "#94A3B8", lineHeight: 1 }}>+</span>
                  </div>
                  <span style={{ fontSize: "10px", color: "#94A3B8", fontWeight: 600, lineHeight: 1.3, textAlign: "center" }}>Add more<br/>products</span>
                  <span style={{ fontSize: "9px", color: "#CBD5E1" }}>Up to 10</span>
                </button>
              )}
            </div>

            {myProductImages.length > 0 && (
              <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#7C3AED", fontWeight: 600 }}>
                {myProductImages.length} product{myProductImages.length !== 1 ? "s" : ""} added
              </p>
            )}

            <input ref={productFileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={e => { if (e.target.files) onAddProductFiles(e.target.files); }}/>
          </div>

          {/* ── Section 5: Generation Instructions ── */}
          <div>
            <p style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 800, color: "#0F172A" }}>
              5. Generation Instructions <span style={{ fontSize: "12px", fontWeight: 500, color: "#94A3B8" }}>(optional)</span>
            </p>
            <p style={{ margin: "0 0 10px", fontSize: "12px", color: "#64748B" }}>Add any specific direction for the AI.</p>
            <textarea
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
              rows={4}
              placeholder="Example: More cozy lighting, natural materials, minimalist styling, Pinterest aesthetic…"
              style={{ width: "100%", borderRadius: 10, border: "1px solid #E5E7EB", padding: "12px 14px", fontSize: "12px", lineHeight: 1.6, resize: "vertical", outline: "none", color: "#374151", fontFamily: "inherit", background: "#FAFAFA", boxSizing: "border-box" }}
            />
            {/* Quick ideas */}
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: "11px", color: "#94A3B8", fontWeight: 600 }}>Quick ideas</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {QUICK_IDEAS.map(idea => (
                  <button key={idea} type="button"
                    onClick={() => setPromptText(promptText ? `${promptText}, ${idea.toLowerCase()}` : idea)}
                    style={{ padding: "4px 12px", borderRadius: 20, border: "1px solid #E5E7EB", background: "#F8FAFC", fontSize: "11px", fontWeight: 500, color: "#374151", cursor: "pointer" }}>
                    {idea}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Generated pins (if any) */}
          {generatedImages.length > 0 && (
            <div>
              <p style={{ margin: "0 0 10px", fontSize: "13px", fontWeight: 800, color: "#0F172A" }}>
                Generated Pins ({generatedImages.length})
              </p>
              {generatedGroups.map((group, gi) => (
                <div key={gi} style={{ marginBottom: gi < generatedGroups.length - 1 ? 20 : 0 }}>
                  {generatedGroups.length > 1 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      {group.refUrl && (
                        <div style={{ width: 22, height: 30, borderRadius: 5, overflow: "hidden", border: "1px solid #E5E7EB", flexShrink: 0 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={group.refUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
                        </div>
                      )}
                      <span style={{ fontSize: "11px", fontWeight: 700, color: "#7C3AED" }}>Reference group {gi + 1}</span>
                      <div style={{ flex: 1, height: 1, background: "#F1F5F9" }}/>
                    </div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
                    {group.images.map((src, imgIdx) => (
                      <div key={imgIdx} style={{ borderRadius: 10, overflow: "hidden", border: "1px solid #F1F5F9", background: "#F8FAFC" }}>
                        <a href={src} target="_blank" rel="noopener noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt="" style={{ width: "100%", aspectRatio: "2/3", objectFit: "cover", display: "block" }}/>
                        </a>
                        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 8px", borderTop: "1px solid #F1F5F9" }}>
                          <a href={src} download={`pin-${gi+1}-${imgIdx+1}.jpg`}
                            style={{ fontSize: "9px", color: "#94A3B8", fontWeight: 600, textDecoration: "none" }}>↓ DL</a>
                          <span style={{ fontSize: "9px", color: "#94A3B8" }}>#{gi * (group.images.length) + imgIdx + 1}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Bottom status */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 4 }}>
            <CheckCircle2 style={{ width: 13, height: 13, color: "#059669" }}/>
            <span style={{ fontSize: "12px", color: "#059669", fontWeight: 600 }}>No text overlay</span>
          </div>
        </div>

        {/* ── Bottom CTA bar (mobile / narrow view) ── */}
        <div style={{ borderTop: "1px solid #F1F5F9", padding: "10px 24px", background: "#fff", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
          <button type="button"
            disabled={!isReady || generating}
            onClick={fireGenerate}
            style={{
              padding: "12px 28px", borderRadius: 30, fontSize: "14px", fontWeight: 800,
              display: "flex", alignItems: "center", gap: 8,
              background: isReady && !generating
                ? "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)"
                : "#F1F5F9",
              color: isReady && !generating ? "#fff" : "#94A3B8",
              border: "none", cursor: isReady && !generating ? "pointer" : "not-allowed",
              transition: "opacity 0.15s",
            }}>
            {generating ? (
              <>
                <div style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }}/>
                {generatingGroupIdx !== null && refCount > 1 ? `Group ${generatingGroupIdx + 1}/${refCount}…` : "Generating…"}
              </>
            ) : (
              <>
                <Sparkles style={{ width: 16, height: 16 }}/>
                Generate {totalPins} Pin{totalPins !== 1 ? "s" : ""}
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── RIGHT PANEL: Settings + Summary ──────────────────────────────── */}
      <aside style={{
        width: 240, flexShrink: 0, background: "#fff", borderLeft: "1px solid #E5E7EB",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px", display: "flex", flexDirection: "column", gap: 20 }}>

          {/* 4. Settings */}
          <div>
            <p style={{ margin: "0 0 12px", fontSize: "13px", fontWeight: 800, color: "#0F172A" }}>4. Settings</p>

            <div style={{ marginBottom: 16 }}>
              <p style={{ margin: "0 0 6px", fontSize: "12px", fontWeight: 700, color: "#374151" }}>Images per reference</p>
              <div style={{ position: "relative", display: "inline-block" }}>
                <select value={count} onChange={e => setCount(Number(e.target.value))}
                  style={{ appearance: "none", borderRadius: 8, border: "1px solid #E5E7EB", background: "#fff", padding: "6px 28px 6px 10px", fontSize: "14px", fontWeight: 700, color: "#0F172A", cursor: "pointer", outline: "none" }}>
                  {[1, 2, 4, 6, 8].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#94A3B8", pointerEvents: "none" }}>▼</span>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: "10px", color: "#94A3B8" }}>How many images to generate per reference.</p>
            </div>

            <div>
              <p style={{ margin: "0 0 6px", fontSize: "12px", fontWeight: 700, color: "#374151" }}>Text overlay</p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Toggle — always off (no text) */}
                <div style={{ width: 36, height: 20, borderRadius: 10, background: "#7C3AED", position: "relative", flexShrink: 0 }}>
                  <div style={{ position: "absolute", right: 2, top: 2, width: 16, height: 16, borderRadius: "50%", background: "#fff" }}/>
                </div>
                <span style={{ fontSize: "11px", fontWeight: 600, color: "#374151" }}>No text (recommended)</span>
              </div>
              <p style={{ margin: "3px 0 0", fontSize: "10px", color: "#94A3B8" }}>Pins will be generated without any text.</p>
            </div>
          </div>

          <div style={{ height: 1, background: "#F1F5F9" }}/>

          {/* Generation Summary */}
          <div>
            <p style={{ margin: "0 0 12px", fontSize: "13px", fontWeight: 800, color: "#0F172A" }}>Generation Summary</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { icon: "🎯", label: keyword ? `1 opportunity` : "No opportunity" },
                { icon: "🖼️", label: refCount > 0 ? `${refCount} reference${refCount !== 1 ? "s" : ""}` : "No references · Auto Style" },
                ...(myProductImages.length > 0 ? [{ icon: "📦", label: `${myProductImages.length} product${myProductImages.length !== 1 ? "s" : ""}` }] : []),
                { icon: "📐", label: `${count} image${count !== 1 ? "s" : ""} per ${refCount > 0 ? "reference" : "generation"}` },
              ].map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14 }}>{item.icon}</span>
                  <span style={{ fontSize: "12px", color: "#374151", fontWeight: 500 }}>{item.label}</span>
                </div>
              ))}
            </div>

            {/* Total formula */}
            {isReady && (
              <div style={{ marginTop: 14, padding: "12px", borderRadius: 10, background: "rgba(124,58,237,0.04)", border: "1px solid rgba(124,58,237,0.15)", textAlign: "center" }}>
                <p style={{ margin: "0 0 4px", fontSize: "11px", color: "#94A3B8" }}>
                  {refCount > 0
                    ? `${refCount} reference${refCount !== 1 ? "s" : ""} × ${count} image${count !== 1 ? "s" : ""} each`
                    : `${count} image${count !== 1 ? "s" : ""} (Auto Style)`}
                </p>
                {refCount > 0 && <p style={{ margin: "0 0 2px", fontSize: "11px", color: "#94A3B8" }}>=</p>}
                <p style={{ margin: 0, fontSize: "22px", fontWeight: 900, color: "#7C3AED" }}>{totalPins} Pins</p>
              </div>
            )}
          </div>

          <div style={{ height: 1, background: "#F1F5F9" }}/>

          {/* Tips */}
          <div>
            <p style={{ margin: "0 0 8px", fontSize: "11px", fontWeight: 800, color: "#374151", textTransform: "uppercase", letterSpacing: "0.07em" }}>Tips for better results</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                "Use 1–5 style references for clear direction",
                "Add multiple products for variety",
                "Keep it simple — let the visuals speak",
                "Avoid text for higher save rate",
              ].map((tip, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                  <span style={{ color: "#C026D3", fontWeight: 700, flexShrink: 0, lineHeight: 1.5 }}>•</span>
                  <span style={{ fontSize: "11px", color: "#64748B", lineHeight: 1.5 }}>{tip}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Generate button */}
        <div style={{ padding: "12px 14px", borderTop: "1px solid #F1F5F9", flexShrink: 0 }}>
          <button type="button"
            disabled={!isReady || generating}
            onClick={fireGenerate}
            style={{
              width: "100%", padding: "13px", borderRadius: 30, fontSize: "14px", fontWeight: 800,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              background: isReady && !generating
                ? "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)"
                : "#F1F5F9",
              color: isReady && !generating ? "#fff" : "#94A3B8",
              border: "none", cursor: isReady && !generating ? "pointer" : "not-allowed",
            }}>
            {generating ? (
              <>
                <div style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }}/>
                Generating…
              </>
            ) : (
              <>
                <Sparkles style={{ width: 16, height: 16 }}/>
                Generate {totalPins} Pin{totalPins !== 1 ? "s" : ""}
              </>
            )}
          </button>
          <p style={{ margin: "6px 0 0", fontSize: "10px", color: "#94A3B8", textAlign: "center" }}>Your generation is private and secure</p>
        </div>
      </aside>
    </div>
  );
}
