"use client";
// ── Shared intelligence UI primitives ──────────────────────────────────────────
// All components are backend-ready: swap mock helpers with real API calls
// without changing component APIs.

// ── Score config ──────────────────────────────────────────────────────────────
export function scoreConfig(score: number) {
  if (score >= 90) return { label: "Elite",     color: "#FFD700", glow: "rgba(255,215,0,0.3)",    bg: "rgba(255,215,0,0.1)"    };
  if (score >= 80) return { label: "Strong",    color: "#00F2FE", glow: "rgba(0,242,254,0.3)",    bg: "rgba(0,242,254,0.1)"    };
  if (score >= 70) return { label: "Rising",    color: "#4ade80", glow: "rgba(74,222,128,0.3)",   bg: "rgba(74,222,128,0.1)"   };
  if (score >= 60) return { label: "Emerging",  color: "#FBBF24", glow: "rgba(251,191,36,0.3)",   bg: "rgba(251,191,36,0.1)"   };
  return                  { label: "Watchlist", color: "#6b7280", glow: "rgba(107,114,128,0.2)",  bg: "rgba(107,114,128,0.08)" };
}

// ── Circular gauge ────────────────────────────────────────────────────────────
export function OpportunityScore({
  score,
  size = "md",
  label = "Opportunity",
}: {
  score: number;
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  const cfg = scoreConfig(score);
  const dim = size === "sm" ? 56 : size === "lg" ? 100 : 76;
  const r = dim / 2 - 7;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, score));
  const offset = circ - (pct / 100) * circ;
  const cx = dim / 2, cy = dim / 2;
  const fs = size === "sm" ? 12 : size === "lg" ? 22 : 17;

  return (
    <div className="flex flex-col items-center gap-1">
      <div style={{ filter: `drop-shadow(0 0 8px ${cfg.glow})` }}>
        <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} aria-label={`${label}: ${score} — ${cfg.label}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={5.5} />
          <circle
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={cfg.color}
            strokeWidth={5.5}
            strokeDasharray={circ}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${cx} ${cy})`}
          />
          <text
            x={cx} y={cy + fs * 0.38}
            textAnchor="middle"
            fill="white"
            fontSize={fs}
            fontWeight={900}
            fontFamily="system-ui,-apple-system,sans-serif"
          >
            {score}
          </text>
        </svg>
      </div>
      <p className="text-[9px] font-black uppercase tracking-widest leading-none" style={{ color: cfg.color }}>
        {cfg.label}
      </p>
      {label && <p className="text-[9px] text-neutral-600 leading-none">{label}</p>}
    </div>
  );
}

// ── Compact inline badge ───────────────────────────────────────────────────────
export function OpportunityBadge({ score, showLabel = true }: { score: number; showLabel?: boolean }) {
  const cfg = scoreConfig(score);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full text-[10px] font-black px-2 py-0.5"
      style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.glow}` }}
    >
      {score}{showLabel && <span className="font-medium opacity-75">· {cfg.label}</span>}
    </span>
  );
}

// ── Why This Is Trending section ──────────────────────────────────────────────
export function WhyTrending({
  reasons,
  trendWindow,
  competition,
}: {
  reasons: string[];
  trendWindow?: string;
  competition?: "low" | "medium" | "high";
}) {
  const compColor = competition === "low" ? "#4ade80" : competition === "high" ? "#f87171" : "#FBBF24";
  const compLabel = competition === "low" ? "Low — act now" : competition === "high" ? "High — differentiate" : "Medium";

  return (
    <div
      className="rounded-xl p-3.5"
      style={{ background: "rgba(0,242,254,0.04)", border: "1px solid rgba(0,242,254,0.12)" }}
    >
      <p className="text-[10px] font-black uppercase tracking-widest text-[#00F2FE] mb-2.5 flex items-center gap-1.5">
        ⚡ Why This Is Trending
      </p>
      <div className="space-y-1.5 mb-3">
        {reasons.map((r, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="text-[#4ade80] text-[10px] mt-0.5 shrink-0">✓</span>
            <span className="text-[11px] text-neutral-300 leading-snug">{r}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 flex-wrap pt-2 border-t border-white/[0.05]">
        {trendWindow && (
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-neutral-600 uppercase tracking-widest">Window</span>
            <span className="text-[10px] font-bold text-[#FBBF24]">{trendWindow}</span>
          </div>
        )}
        {competition && (
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-neutral-600 uppercase tracking-widest">Competition</span>
            <span className="text-[10px] font-bold" style={{ color: compColor }}>{compLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Trend Window badge ─────────────────────────────────────────────────────────
export function TrendWindowBadge({ window: tw }: { window: string }) {
  const isUrgent = tw.includes("week");
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full text-[10px] font-bold px-2.5 py-0.5"
      style={
        isUrgent
          ? { background: "rgba(255,140,66,0.15)", color: "#FF8C42", border: "1px solid rgba(255,140,66,0.3)" }
          : { background: "rgba(255,255,255,0.05)", color: "#9ca3af", border: "1px solid rgba(255,255,255,0.08)" }
      }
    >
      {isUrgent ? "🔥" : "📅"} {tw}
    </span>
  );
}

// ── Opportunity Journey strip ─────────────────────────────────────────────────
export function OpportunityJourney({
  keyword,
  category,
  pinCount,
  productCount,
}: {
  keyword: string;
  category: string;
  pinCount: number;
  productCount: number;
}) {
  const items = [
    { label: `📌 ${pinCount} Viral Pins`,   href: "/app/discover",                                          color: "#FF8C42" },
    { label: `🛍 ${productCount} Products`, href: "/app/products",                                          color: "#A78BFA" },
    { label: "✨ Create Similar",            href: `/app/studio?keyword=${encodeURIComponent(keyword)}&category=${category}`, color: "#00F2FE" },
  ];

  return (
    <div
      className="rounded-xl p-3 flex items-center gap-2 flex-wrap"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <span className="text-[11px] font-bold text-white capitalize truncate max-w-[120px]">{keyword}</span>
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-2">
          <span className="text-neutral-700 text-[10px]">→</span>
          <a
            href={item.href}
            className="text-[10px] font-bold rounded-full px-2.5 py-1 transition-all hover:opacity-80 no-underline"
            style={{ background: `${item.color}18`, color: item.color, border: `1px solid ${item.color}30` }}
          >
            {item.label}
          </a>
        </span>
      ))}
    </div>
  );
}

// ── Mock intelligence helpers (backend-ready: swap with API calls) ─────────────

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function mockOpportunityScore(saves: number, velocity: number, age: number): number {
  return Math.min(97, Math.max(44, Math.round(
    50 + Math.min(25, saves / 600) + Math.min(18, velocity / 12) + (age < 14 ? 12 : age < 30 ? 6 : 0)
  )));
}

export function mockKeywordScore(weeklyChange: number, yearlyChange: number, priorityScore: number): number {
  return Math.min(97, Math.max(44, Math.round(
    48 + weeklyChange * 0.4 + yearlyChange / 40 + priorityScore / 8
  )));
}

export function mockProductScore(saves: number, pinSaves: number): number {
  return Math.min(96, Math.max(42, Math.round(
    50 + Math.min(28, saves / 40) + Math.min(18, pinSaves / 800)
  )));
}

export const VISUAL_PATTERNS: Record<string, string[]> = {
  beauty:    ["Close-up macro", "Soft pink/nude palette", "Diffused window light"],
  home:      ["Overhead flat lay", "Earth tone palette", "Warm golden hour"],
  fashion:   ["Editorial full-body", "High contrast", "Minimalist backdrop"],
  jewelry:   ["Macro close-up", "Gold bokeh bg", "Marble surface"],
  wellness:  ["Lifestyle serene", "Sage green + ivory", "Morning soft light"],
  art:       ["Gallery context", "Neutral linen bg", "Dramatic shadow play"],
  lifestyle: ["Cozy interior", "Amber warm light", "Layered textures"],
  gifts:     ["Gift flat lay", "Kraft + ribbon", "Bokeh depth"],
};

export const RELATED_KWS: Record<string, string[]> = {
  beauty:    ["nail inspo 2026", "aesthetic nails", "clean girl aesthetic", "gel nail ideas"],
  home:      ["cozy bedroom decor", "japandi style", "aesthetic room ideas", "minimalist home"],
  fashion:   ["outfit ideas 2026", "capsule wardrobe", "quiet luxury outfits", "aesthetic fashion"],
  jewelry:   ["gold jewelry stack", "dainty necklace", "minimalist jewelry", "layered jewelry"],
  wellness:  ["morning routine", "pilates aesthetic", "self care ritual", "clean eating"],
  art:       ["gallery wall inspo", "wall art ideas", "printable wall art", "room aesthetic"],
  lifestyle: ["slow living aesthetic", "cozy content", "Pinterest aesthetic", "aesthetic home"],
  gifts:     ["gift ideas for her", "birthday gifts women", "christmas gift guide", "sentimental gifts"],
};

export function getGrowthReasons(saves: number, velocity: number, age: number, category: string): string[] {
  const r: string[] = [];
  if (velocity > 200) r.push("Exceptional save velocity — top 5% in category");
  else if (velocity > 80)  r.push("Save velocity accelerating above category average");
  else if (velocity > 30)  r.push("Save velocity growing steadily");
  if (age < 7)  r.push(`Ultra-fresh content — only ${age} days old`);
  else if (age < 21) r.push(`Fresh content — ${age} days old, still in peak discovery window`);
  if (saves > 20000) r.push("Passed 20K saves — strong social proof milestone");
  else if (saves > 5000) r.push("Surpassed 5K saves — exceeding category benchmarks");
  r.push(`${category} niche trending year-over-year on Pinterest`);
  r.push("Visual style matching Pinterest's high-engagement algorithm patterns");
  return r.slice(0, 4);
}

export function getProductReasons(saves: number, pinSaves: number, domain: string | null): string[] {
  const r: string[] = [];
  if (pinSaves > 30000) r.push("Featured in a viral pin (30K+ saves)");
  else if (pinSaves > 10000) r.push("Source pin exceeded 10K saves milestone");
  if (saves > 500) r.push("Product link clicked 500+ times from Pinterest");
  const merchant = domain?.replace(/^www\./, "").split(".")[0] ?? "";
  if (["etsy", "amazon"].includes(merchant)) r.push(`${merchant.charAt(0).toUpperCase() + merchant.slice(1)} listing with strong organic discovery`);
  r.push("Matched to rising search intent in category");
  r.push("Price point aligns with Pinterest buyer patterns");
  return r.slice(0, 4);
}

export function getTrendWindow(velocity: number, weeklyChange?: number): string {
  if (velocity > 200 || (weeklyChange ?? 0) > 60) return "Peak: 1-3 weeks — act now";
  if (velocity > 80  || (weeklyChange ?? 0) > 25) return "Growing: 4-8 weeks";
  if (velocity > 20  || (weeklyChange ?? 0) > 0)  return "Stable: 2-4 months";
  return "Mature: evergreen niche";
}

export function getCompetition(saves: number, velocity: number): "low" | "medium" | "high" {
  const score = saves / 1000 + velocity / 50;
  if (score > 30) return "high";
  if (score > 10) return "medium";
  return "low";
}

export function mockJourneyCounts(keyword: string): { pinCount: number; productCount: number } {
  const h = hashStr(keyword);
  return {
    pinCount:     5 + (h % 48),
    productCount: 1 + (h % 22),
  };
}

export const SUGGESTED_ANGLES: Record<string, string[]> = {
  "etsy.com":    ["Hidden gem discovery pin", "Small business spotlight", "Gift idea inclusion"],
  "amazon.com":  ["Amazon must-have reveal", "Under $X home find", "Best seller breakdown"],
  "walmart.com": ["Budget-friendly dupe", "Affordable aesthetic find", "Walmart hidden gem"],
  "target.com":  ["Target run haul", "Affordable luxury find", "Style on a budget"],
  default:       ["Shop the look mashup", "Trend inspo collage", "Product review pin"],
};
