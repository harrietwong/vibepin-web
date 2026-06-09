"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, TrendingUp, Sparkles, Plus, Copy, Check, ExternalLink, X } from "lucide-react";
import {
  DIGITAL_PRODUCT_IDEAS,
  NICHE_META,
  FORMAT_META,
  ALL_NICHES,
  ALL_FORMATS,
  type DigitalNiche,
  type DigitalFormat,
  type DigitalProductIdea,
} from "@/lib/digitalProductIdeas";
import { PRIMARY_BADGE_META, TREND_CHIP_META } from "@/lib/workspaceStatics";

// ── Badge helpers (same Workspace colors) ────────────────────────────────────

function intentToBadge(score: "high" | "medium"): keyof typeof PRIMARY_BADGE_META {
  return score === "high" ? "best_bet" : "steady";
}

// ── Pinterest Trends URL ───────────────────────────────────────────────────────

function trendUrl(query: string): string {
  return `https://trends.pinterest.com/search?q=${encodeURIComponent(query)}`;
}

// ── Studio URL ────────────────────────────────────────────────────────────────

function studioUrl(idea: DigitalProductIdea): string {
  const p = new URLSearchParams({
    keyword:    idea.keyword,
    category:   "digital-products",
    sourceType: "keyword",
    from:       "digital_idea",
    niche:      idea.niche,
    format:     idea.format,
    ideaId:     idea.id,
  });
  return `/app/studio?${p.toString()}`;
}

// ── Plan URL ──────────────────────────────────────────────────────────────────

function planUrl(idea: DigitalProductIdea): string {
  const p = new URLSearchParams({
    source:  "digital_idea",
    ideaId:  idea.id,
    keyword: idea.keyword,
    niche:   idea.niche,
    format:  idea.format,
  });
  return `/app/workspace/digital-products?${p.toString()}`;
}

// ── Trend Validation Drawer ───────────────────────────────────────────────────

function TrendDrawer({ idea, onClose, onPlan }: { idea: DigitalProductIdea; onClose: () => void; onPlan: () => void }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const nMeta = NICHE_META[idea.niche];
  const fMeta = FORMAT_META[idea.format];

  const copyQuery = useCallback((query: string, idx: number) => {
    navigator.clipboard.writeText(query).catch(() => {});
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1800);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />

      {/* Drawer — right side */}
      <div
        className="relative ml-auto w-full max-w-sm bg-white shadow-2xl flex flex-col h-full overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3 shrink-0">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#C026D3] mb-0.5">Check Pinterest Trends</p>
            <p className="text-[13px] font-bold text-gray-900 leading-snug">
              Use query variants to validate demand before creating pins.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors shrink-0 mt-0.5"
          >
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        {/* Idea meta */}
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 shrink-0">
          <p className="text-[13px] font-bold text-gray-900 capitalize leading-snug">{idea.keyword}</p>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">
              {nMeta.emoji} {nMeta.label}
            </span>
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap"
              style={{ background: "rgba(124,58,237,0.08)", color: "#7C3AED", border: "1px solid rgba(124,58,237,0.15)" }}>
              {fMeta.emoji} {fMeta.label}
            </span>
          </div>
        </div>

        {/* Query variants */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">
            Pinterest search queries
          </p>
          <div className="space-y-2">
            {idea.trend_variants.map((v, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 transition-colors"
              >
                <span className="text-[12px] font-medium text-gray-800 flex-1 min-w-0 truncate">{v}</span>

                {/* Copy */}
                <button
                  type="button"
                  onClick={() => copyQuery(v, i)}
                  title="Copy query"
                  className="p-1 rounded-md hover:bg-gray-100 transition-colors shrink-0"
                >
                  {copiedIdx === i
                    ? <Check className="h-3.5 w-3.5 text-green-500" />
                    : <Copy className="h-3.5 w-3.5 text-gray-400" />}
                </button>

                {/* Open in Pinterest Trends */}
                <a
                  href={trendUrl(v)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in Pinterest Trends"
                  className="p-1 rounded-md hover:bg-[#C026D3]/10 transition-colors shrink-0 no-underline"
                >
                  <ExternalLink className="h-3.5 w-3.5 text-[#C026D3]" />
                </a>
              </div>
            ))}
          </div>

          {/* Copy feedback toast */}
          {copiedIdx !== null && (
            <p className="text-[11px] text-green-600 font-semibold mt-3 text-center">
              Copied query
            </p>
          )}
        </div>

        {/* Bottom actions */}
        <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
          <a
            href={studioUrl(idea)}
            className="flex items-center justify-center gap-2 w-full rounded-xl py-2.5 text-[12px] font-bold text-white no-underline transition-all hover:brightness-105"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
          >
            <Sparkles className="h-3.5 w-3.5" /> Create Pins with this idea
          </a>
          <button
            type="button"
            onClick={() => { onClose(); onPlan(); }}
            className="flex items-center justify-center gap-2 w-full rounded-xl py-2.5 text-[12px] font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add to Plan
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Idea card row ─────────────────────────────────────────────────────────────

function IdeaRow({
  idea,
  onCheckTrend,
  onPlan,
  seedMode = false,
}: {
  idea: typeof DIGITAL_PRODUCT_IDEAS[number];
  onCheckTrend: (idea: DigitalProductIdea) => void;
  onPlan: (idea: DigitalProductIdea) => void;
  seedMode?: boolean;
}) {
  const badge    = intentToBadge(idea.digital_intent_score);
  const bMeta    = PRIMARY_BADGE_META[badge];
  const chipMeta = TREND_CHIP_META["evergreen"];
  const fMeta    = FORMAT_META[idea.format];
  const nMeta    = NICHE_META[idea.niche];

  // seed mode: 5 cols (Idea | Niche | Format | Validation | Actions)
  // verified mode: 6 cols (Idea | Niche | Format | Signal | Trend | Actions)
  const COL = seedMode
    ? "minmax(200px,2fr) 110px 130px 130px 180px"
    : "minmax(200px,2fr) 110px 130px 100px 130px 180px";

  return (
    <div className="grid items-center px-4 py-3 hover:bg-gray-50 transition-colors group border-b border-gray-100 last:border-0"
      style={{ gridTemplateColumns: COL }}>

      {/* Product idea */}
      <div className="pr-4 min-w-0">
        <p className="text-[13px] font-semibold text-gray-900 capitalize truncate leading-snug">{idea.keyword}</p>
        <p className="text-[10px] text-gray-400 mt-0.5">{idea.audience}</p>
      </div>

      {/* Audience niche */}
      <div>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 whitespace-nowrap">
          {nMeta.emoji} {nMeta.audience.split(" ")[0]}
        </span>
      </div>

      {/* Format */}
      <div>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
          style={{ background: "rgba(124,58,237,0.08)", color: "#7C3AED", border: "1px solid rgba(124,58,237,0.15)" }}>
          {fMeta.emoji} {fMeta.label}
        </span>
      </div>

      {/* Seed mode: single Validation cell | Verified mode: Signal + Trend cells */}
      {seedMode ? (
        <div>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
            style={{ background: "rgba(245,158,11,0.08)", color: "#D97706", border: "1px solid rgba(245,158,11,0.2)" }}>
            ● Not validated
          </span>
        </div>
      ) : (
        <>
          <div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
              style={{ background: bMeta.bg, color: bMeta.color, border: `1px solid ${bMeta.color}33` }}>
              {bMeta.label}
            </span>
          </div>
          <div>
            <span className="text-[9px] font-semibold whitespace-nowrap" style={{ color: chipMeta.color }}>
              ∞ {chipMeta.label}
            </span>
          </div>
        </>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button type="button" onClick={() => onCheckTrend(idea)}
          className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] font-semibold border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors whitespace-nowrap">
          <TrendingUp className="h-3 w-3" /> Check Trends
        </button>
        <a href={studioUrl(idea)}
          className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] font-bold text-white no-underline whitespace-nowrap transition-all hover:brightness-105"
          style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
          <Sparkles className="h-3 w-3" /> Create
        </a>
        <button type="button" onClick={() => onPlan(idea)}
          className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] font-semibold border border-gray-200 text-gray-600 hover:bg-gray-100 whitespace-nowrap transition-colors">
          <Plus className="h-3 w-3" /> Plan
        </button>
      </div>
    </div>
  );
}

// ── Idea card (compact grid card, alternative view) ───────────────────────────

function IdeaCard({
  idea,
  onCheckTrend,
}: {
  idea: typeof DIGITAL_PRODUCT_IDEAS[number];
  onCheckTrend: (idea: DigitalProductIdea) => void;
}) {
  const badge    = intentToBadge(idea.digital_intent_score);
  const bMeta    = PRIMARY_BADGE_META[badge];
  const fMeta    = FORMAT_META[idea.format];
  const nMeta    = NICHE_META[idea.niche];

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3.5 hover:border-gray-300 hover:shadow-sm transition-all flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md whitespace-nowrap"
              style={{ background: bMeta.bg, color: bMeta.color, border: `1px solid ${bMeta.color}33` }}>
              {bMeta.label}
            </span>
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap"
              style={{ background: "rgba(124,58,237,0.08)", color: "#7C3AED" }}>
              {fMeta.emoji} {fMeta.label}
            </span>
          </div>
          <p className="text-[13px] font-bold text-gray-900 capitalize leading-snug">{idea.keyword}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">{nMeta.emoji} {idea.audience}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 mt-auto">
        <button
          type="button"
          onClick={() => onCheckTrend(idea)}
          className="flex-1 flex items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <TrendingUp className="h-3 w-3" /> Trends
        </button>
        <a
          href={studioUrl(idea)}
          className="flex-1 flex items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-bold text-white no-underline"
          style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
        >
          <Sparkles className="h-3 w-3" /> Create
        </a>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function DigitalProductsTab({ seedMode = false }: { seedMode?: boolean }) {
  const router = useRouter();
  const [selectedNiche,  setSelectedNiche]  = useState<DigitalNiche | "all">("all");
  const [selectedFormat, setSelectedFormat] = useState<DigitalFormat | "all">("all");
  const [search,         setSearch]         = useState("");
  const [viewMode,       setViewMode]       = useState<"table" | "cards">("table");
  const [trendIdea, setTrendIdea] = useState<DigitalProductIdea | null>(null);

  function handlePlan(idea: DigitalProductIdea) {
    router.push(planUrl(idea));
    toast.info("Opened in Workspace for planning", {
      description: idea.keyword,
    });
  }

  const filtered = useMemo(() => {
    return DIGITAL_PRODUCT_IDEAS.filter(idea => {
      if (selectedNiche  !== "all" && idea.niche  !== selectedNiche)  return false;
      if (selectedFormat !== "all" && idea.format !== selectedFormat) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!idea.keyword.toLowerCase().includes(q) && !idea.audience.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [selectedNiche, selectedFormat, search]);

  return (
    <div className="flex flex-col gap-5">

      {/* Header — hidden when seedMode (parent provides context) */}
      {!seedMode && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[18px] font-black text-gray-900">Digital Product Ideas</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">
              Downloadable, printable & template products by niche
            </p>
          </div>
          <div className="flex rounded-xl overflow-hidden border border-gray-200 bg-white shrink-0">
            <button type="button" onClick={() => setViewMode("table")}
              className={`px-3 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === "table" ? "text-white" : "text-gray-500"}`}
              style={viewMode === "table" ? { background: "#C026D3" } : {}}>Table</button>
            <button type="button" onClick={() => setViewMode("cards")}
              className={`px-3 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === "cards" ? "text-white" : "text-gray-500"}`}
              style={viewMode === "cards" ? { background: "#C026D3" } : {}}>Cards</button>
          </div>
        </div>
      )}

      {/* Niche filter */}
      <div>
        <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Niche</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setSelectedNiche("all")}
            className="rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors whitespace-nowrap"
            style={selectedNiche === "all"
              ? { background: "#C026D3", color: "#fff" }
              : { background: "#fff", border: "1px solid #E5E7EB", color: "#6B7280" }}>
            All niches
          </button>
          {ALL_NICHES.map(n => {
            const m = NICHE_META[n];
            const active = selectedNiche === n;
            return (
              <button key={n} type="button" onClick={() => setSelectedNiche(active ? "all" : n)}
                className="rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors whitespace-nowrap"
                style={active
                  ? { background: "#C026D3", color: "#fff" }
                  : { background: "#fff", border: "1px solid #E5E7EB", color: "#6B7280" }}>
                {m.emoji} {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Format + Search row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Format filter */}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setSelectedFormat("all")}
            className="rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors whitespace-nowrap"
            style={selectedFormat === "all"
              ? { background: "rgba(124,58,237,0.12)", color: "#7C3AED", border: "1px solid rgba(124,58,237,0.2)" }
              : { background: "#F9FAFB", border: "1px solid #E5E7EB", color: "#6B7280" }}>
            All formats
          </button>
          {ALL_FORMATS.map(f => {
            const m = FORMAT_META[f];
            const active = selectedFormat === f;
            return (
              <button key={f} type="button" onClick={() => setSelectedFormat(active ? "all" : f)}
                className="rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors whitespace-nowrap"
                style={active
                  ? { background: "rgba(124,58,237,0.12)", color: "#7C3AED", border: "1px solid rgba(124,58,237,0.2)" }
                  : { background: "#F9FAFB", border: "1px solid #E5E7EB", color: "#6B7280" }}>
                {m.emoji} {m.label}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="relative ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search ideas…"
            className="rounded-xl border border-gray-200 bg-white pl-9 pr-4 py-2 text-[12px] text-gray-800 focus:border-[#C026D3] focus:outline-none placeholder:text-gray-400 shadow-sm w-52" />
        </div>

        {!seedMode && (
          <span className="text-[11px] text-gray-400 tabular-nums shrink-0">
            {filtered.length} ideas
          </span>
        )}
      </div>

      {/* Table view */}
      {viewMode === "table" && (
        <div className="rounded-xl overflow-hidden bg-white border border-gray-200 shadow-sm">
          {/* Header */}
          <div className="grid px-4 py-2.5 border-b border-gray-100 bg-gray-50"
            style={{ gridTemplateColumns: seedMode ? "minmax(200px,2fr) 110px 130px 130px 180px" : "minmax(200px,2fr) 110px 130px 100px 130px 180px" }}>
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Idea</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Niche</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Format</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{seedMode ? "Validation" : "Signal"}</span>
            {!seedMode && <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Trend</span>}
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 text-right">Actions</span>
          </div>
          {filtered.length > 0 ? (
            <div className="divide-y divide-gray-100">
              {filtered.map(idea => (
                <IdeaRow key={idea.id} idea={idea} onCheckTrend={setTrendIdea} onPlan={handlePlan} seedMode={seedMode} />
              ))}
            </div>
          ) : (
            <div className="py-16 text-center">
              <p className="text-[13px] font-semibold text-gray-500">No ideas match your filter</p>
            </div>
          )}
        </div>
      )}

      {/* Card view */}
      {viewMode === "cards" && (
        filtered.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filtered.map(idea => (
              <IdeaCard key={idea.id} idea={idea} onCheckTrend={setTrendIdea} />
            ))}
          </div>
        ) : (
          <div className="py-16 text-center">
            <p className="text-[13px] font-semibold text-gray-500">No ideas match your filter</p>
          </div>
        )
      )}

      {/* Trends drawer */}
      {trendIdea && (
        <TrendDrawer
          idea={trendIdea}
          onClose={() => setTrendIdea(null)}
          onPlan={() => handlePlan(trendIdea)}
        />
      )}
    </div>
  );
}
