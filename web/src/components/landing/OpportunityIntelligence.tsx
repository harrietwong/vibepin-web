import Link from "next/link";
import {
  Sparkles, ArrowRight, TrendingUp, Bookmark, ShoppingBag, CalendarDays,
  Lock, Workflow, Users,
} from "lucide-react";
import { take, type LandingAsset } from "@/lib/landingAssets";

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace" };
const VibeBtn = "btn-cta rounded-full font-bold text-white transition-transform hover:scale-[1.03] active:scale-100";

// ── Mock data (replace with API data later) ───────────────────────────────────
const OPPORTUNITY = {
  title: "Boho Living Room",
  score: 94,
  description: "Warm neutrals, natural textures, layered lighting, and relaxed boho details are driving strong engagement right now.",
};
const METRICS = [
  { v: "+210%", l: "Demand vs last 30 days",   c: "#10B981" },
  { v: "18",    l: "High-save Pins · 30 days",  c: "#A855F7" },
  { v: "7",     l: "Matched products",          c: "#38BDF8" },
];
const DEMAND_ROWS: [string, string][] = [["Search demand", "High"], ["Save activity", "High"], ["Growth trend", "Rising"], ["Competition", "Low"]];
const PIN_ROWS: [string, string][] = [["Average saves per Pin", "6.2K"], ["Total high-save Pins", "18"], ["Top format", "Lifestyle"], ["Best angle", "Small-space makeover"]];
const PRODUCT_ROWS: [string, string][] = [["Product demand", "High"], ["Average price range", "$40 – $180"], ["Opportunity fit", "Excellent"], ["Matched products", "7"]];
const PIN_SAVES = ["8.4K", "7.2K", "6.1K"];
const CAMPAIGN_SUMMARY = [
  { v: "7 Pins",   l: "Recommended this week",   c: "#10B981" },
  { v: "7 Days",   l: "Optimal publishing window", c: "#38BDF8" },
  { v: "3 Angles", l: "Lifestyle · Product · Detail", c: "#A855F7" },
  { v: "High",     l: "Estimated opportunity",    c: "#E879F9" },
];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK_ANGLES = ["Lifestyle", "Detail", "Product", "Lifestyle", "Detail", "Product", "Lifestyle"];
const TRUST: [React.ReactNode, string, string][] = [
  [<Lock className="w-4 h-4" key="l" />, "Your data is private", "We never share your data"],
  [<Workflow className="w-4 h-4" key="w" />, "Built for Pinterest workflows", "Discovery to scheduling"],
  [<Users className="w-4 h-4" key="u" />, "Used by creators, sellers and managers", "Real Pinterest teams"],
];

// ── Primitives ────────────────────────────────────────────────────────────────
function AssetImg({ asset, label }: { asset?: LandingAsset; label?: string }) {
  if (asset?.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.imageUrl} alt={asset.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: asset.objectPosition ?? "center" }} />;
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ background: "linear-gradient(135deg,#141622,#0b0d15)", color: "#2A2F3E" }}>
      <span className="text-[7px] font-semibold uppercase tracking-wide">{label ?? "VibePin"}</span>
    </div>
  );
}

function ScoreRing({ score, size = 84 }: { score: number; size?: number }) {
  const r = size / 2 - 6, circ = 2 * Math.PI * r, off = circ * (1 - score / 100);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="5" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#oiScore)" strokeWidth="5" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} />
        <defs><linearGradient id="oiScore" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#38BDF8" /><stop offset="0.5" stopColor="#D946EF" /><stop offset="1" stopColor="#A855F7" /></linearGradient></defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-[20px] font-black text-white" style={MONO}>{score}</span>
        <span className="text-[8px]" style={{ color: "#6B7280" }}>/100</span>
      </div>
    </div>
  );
}

function Sparkline({ color, w = 78, h = 30 }: { color: string; w?: number; h?: number }) {
  return (
    <svg viewBox="0 0 78 30" width={w} height={h} fill="none" className="shrink-0">
      <polyline points="0,25 11,20 20,23 29,14 38,18 48,9 58,13 68,5 78,3" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MetricRow({ label, value, valueColor = "#FFFFFF" }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b last:border-0" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <span className="text-[12px]" style={{ color: "#8B93A1" }}>{label}</span>
      <span className="text-[12px] font-bold" style={{ color: valueColor }}>{value}</span>
    </div>
  );
}

function EvidenceShell({ n, accent, title, question, desc, children, footer }: {
  n: number; accent: string; title: string; question: string; desc: string; children: React.ReactNode; footer: string;
}) {
  return (
    <div className="flex flex-col rounded-2xl border p-5 transition-transform hover:-translate-y-1" style={{ background: "linear-gradient(180deg,#0C1018,#0A0C14)", borderColor: "rgba(255,255,255,0.08)" }}>
      <div className="flex items-center gap-2.5 mb-1">
        <span className="h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-black text-white" style={{ background: accent, ...MONO }}>{n}</span>
        <h3 className="text-[16px] font-black text-white tracking-tight">{title}</h3>
      </div>
      <p className="text-[11px] font-semibold mb-2" style={{ color: accent }}>{question}</p>
      <p className="text-[12.5px] leading-relaxed mb-4" style={{ color: "#8B93A1" }}>{desc}</p>
      <div className="flex-1">{children}</div>
      <Link href="/app/discover?demo=true" className="inline-flex items-center gap-1.5 text-[12px] font-bold mt-4" style={{ color: accent }}>{footer} <ArrowRight className="w-3.5 h-3.5" /></Link>
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────
export default function OpportunityIntelligence({ pinSamples, products }: { pinSamples: LandingAsset[]; products: LandingAsset[] }) {
  const heroImg   = pinSamples.find(a => a.category === "Home Decor") ?? pinSamples[0];
  const pinEvid   = take(pinSamples, 3, "Pin", 1);
  const prodEvid  = take(products, 4, "Product");
  const weekPins  = take(pinSamples, 7, "Pin", 4);

  return (
    <section id="create" className="py-20 border-t relative overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className="pointer-events-none absolute inset-x-0 top-10 h-80 blur-3xl" style={{ background: "radial-gradient(ellipse at 50% 20%, rgba(217,70,239,0.10), transparent 68%)" }} />
      <div className="max-w-[1280px] mx-auto px-6 lg:px-8 relative">

        {/* Heading */}
        <div className="text-center max-w-[760px] mx-auto mb-12">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] mb-4" style={{ color: "#A855F7" }}>Opportunity Intelligence</p>
          <h2 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-[1.05] mb-5">
            Know what to create{" "}
            <span style={{ background: "linear-gradient(100deg,#FF4D8D,#D946EF 50%,#38BDF8)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>before you create it.</span>
          </h2>
          <p className="text-[14px] sm:text-[15px] leading-relaxed" style={{ color: "#8B93A1" }}>
            VibePin connects Pinterest demand, proven Pin performance, and product signals to recommend what to make, what to promote, and how to turn it into a 7-Pin campaign.
          </p>
        </div>

        {/* Recommended Opportunity overview */}
        <div className="rounded-2xl border p-5 sm:p-6 mb-6" style={{ background: "linear-gradient(180deg,#0E1018,#0A0C14)", borderColor: "rgba(168,85,247,0.24)", boxShadow: "0 0 60px rgba(168,85,247,0.10)" }}>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-4 flex items-center gap-1.5" style={{ color: "#E879F9" }}><Sparkles className="w-3.5 h-3.5" /> Recommended Opportunity</p>
          <div className="grid lg:grid-cols-[300px_1fr] gap-5 lg:gap-7">
            <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "4/3", minHeight: 200 }}><AssetImg asset={heroImg} label="Boho Living Room" /></div>
            <div className="flex flex-col">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-2xl sm:text-[26px] font-black text-white tracking-tight mb-2">{OPPORTUNITY.title}</h3>
                  <p className="text-[13px] leading-relaxed max-w-md" style={{ color: "#8B93A1" }}>{OPPORTUNITY.description}</p>
                </div>
                <div className="flex flex-col items-center shrink-0"><ScoreRing score={OPPORTUNITY.score} /><span className="text-[9px] mt-1" style={{ color: "#6B7280" }}>Opportunity score</span></div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-5 pt-5 border-t" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
                {METRICS.map(m => (
                  <div key={m.l} className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-2xl font-black leading-none mb-1" style={{ color: m.c, ...MONO }}>{m.v}</p>
                      <p className="text-[10px]" style={{ color: "#6B7280" }}>{m.l}</p>
                    </div>
                    <Sparkline color={m.c} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Three evidence cards */}
        <div className="grid md:grid-cols-3 gap-5 mb-6">
          {/* Demand Signal */}
          <EvidenceShell n={1} accent="#10B981" title="Demand Signal" question="Is interest growing?" desc="Increasing search demand and save activity show whether this topic is gaining momentum." footer="View full demand insights">
            <div className="rounded-xl p-3 mb-3" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.07)" }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "#4B5563" }}>Interest over time</span>
                <span className="rounded-full px-2 py-0.5 text-[9px] font-bold" style={{ background: "rgba(16,185,129,0.16)", color: "#10B981" }}>+210%</span>
              </div>
              <svg viewBox="0 0 240 70" className="w-full" height="70" fill="none">
                <defs><linearGradient id="oiArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(16,185,129,0.30)" /><stop offset="1" stopColor="rgba(16,185,129,0)" /></linearGradient></defs>
                <polyline points="0,58 24,50 44,54 68,40 92,46 120,30 150,36 178,18 208,24 240,8" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <polygon points="0,58 24,50 44,54 68,40 92,46 120,30 150,36 178,18 208,24 240,8 240,70 0,70" fill="url(#oiArea)" />
              </svg>
              <div className="flex justify-between text-[8px] mt-1" style={{ color: "#4B5563", ...MONO }}><span>May 15</span><span>May 30</span><span>Jun 15</span></div>
            </div>
            <div>{DEMAND_ROWS.map(([l, v]) => <MetricRow key={l} label={l} value={v} valueColor="#10B981" />)}</div>
          </EvidenceShell>

          {/* Pin Evidence */}
          <EvidenceShell n={2} accent="#A855F7" title="Pin Evidence" question="What creative is already working?" desc="High-save Pins reveal the formats, visual styles, and content angles that already attract engagement." footer="Explore all Pin evidence">
            <div className="grid grid-cols-4 gap-1.5 mb-3">
              {pinEvid.map((a, i) => (
                <div key={i} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "3/4" }}>
                  <AssetImg asset={a} label="Pin" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                  <span className="absolute bottom-1 left-1 text-[8px] font-bold text-white">💾 {PIN_SAVES[i]}</span>
                </div>
              ))}
              <div className="rounded-lg flex items-center justify-center text-center text-[8px] font-bold leading-tight" style={{ aspectRatio: "3/4", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#6B7280" }}>+15<br />more</div>
            </div>
            <div>{PIN_ROWS.map(([l, v]) => <MetricRow key={l} label={l} value={v} valueColor="#C4B5FD" />)}</div>
          </EvidenceShell>

          {/* Product Signals */}
          <EvidenceShell n={3} accent="#38BDF8" title="Product Signals" question="What is worth promoting?" desc="Related products show where Pinterest demand can turn into traffic, product discovery, and monetization." footer="See all product signals">
            <div className="grid grid-cols-4 gap-1.5 mb-3">
              {prodEvid.map((a, i) => <div key={i} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "1/1", border: "1px solid rgba(255,255,255,0.07)" }}><AssetImg asset={a} label="Product" /></div>)}
            </div>
            <div>{PRODUCT_ROWS.map(([l, v]) => <MetricRow key={l} label={l} value={v} valueColor="#38BDF8" />)}</div>
          </EvidenceShell>
        </div>

        {/* Recommended Campaign */}
        <div className="rounded-2xl border p-5 sm:p-6 mb-6" style={{ background: "linear-gradient(135deg,#0E1018,#120E1E)", borderColor: "rgba(168,85,247,0.24)", boxShadow: "0 24px 80px rgba(0,0,0,0.26)" }}>
          <div className="grid lg:grid-cols-2 gap-6 lg:gap-8 items-center">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-3 flex items-center gap-1.5" style={{ color: "#E879F9" }}><Sparkles className="w-3.5 h-3.5" /> Recommended Campaign</p>
              <h3 className="text-2xl sm:text-3xl font-black text-white tracking-tight mb-3">Boho Living Room Campaign</h3>
              <p className="text-[13px] leading-relaxed mb-5 max-w-md" style={{ color: "#8B93A1" }}>Publish 7 Pins over the next 7 days while demand is rising, using the formats, products, and creative angles already validated by Pinterest signals.</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-6">
                {CAMPAIGN_SUMMARY.map(s => (
                  <div key={s.l} className="rounded-xl p-3" style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.07)" }}>
                    <p className="text-[15px] font-black leading-none mb-1" style={{ color: s.c }}>{s.v}</p>
                    <p className="text-[9px] leading-tight" style={{ color: "#6B7280" }}>{s.l}</p>
                  </div>
                ))}
              </div>
              <div className="flex flex-col sm:flex-row gap-2.5">
                <button type="button" className={`${VibeBtn} px-6 py-3 text-[13px] flex items-center justify-center gap-2`}><Sparkles className="w-4 h-4" /> Generate 7 Pins</button>
                <button type="button" className="rounded-full px-6 py-3 text-[13px] font-semibold border flex items-center justify-center gap-2 transition-colors hover:text-white hover:border-white/30" style={{ borderColor: "rgba(255,255,255,0.14)", color: "#C8CDD6" }}><CalendarDays className="w-4 h-4" /> Add to weekly plan</button>
              </div>
            </div>

            {/* Publishing preview */}
            <div className="rounded-xl p-4" style={{ background: "#0A0E16", border: "1px solid rgba(255,255,255,0.08)" }}>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: "#4B5563" }}>Publishing preview</p>
              <div className="grid grid-cols-7 gap-1.5">
                {DAYS.map((d, i) => (
                  <div key={d}>
                    <p className="text-[8px] font-bold text-center mb-1" style={{ color: "#6B7280" }}>{d}</p>
                    <div className="relative rounded-lg overflow-hidden mb-1" style={{ aspectRatio: "3/4" }}>
                      <AssetImg asset={weekPins[i]} label="Pin" />
                      <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full flex items-center justify-center text-[8px] font-black text-white" style={{ background: "rgba(8,12,18,0.85)", ...MONO }}>{i + 1}</span>
                    </div>
                    <span className="block text-[7px] font-bold text-center truncate" style={{ color: "#10B981" }}>{WEEK_ANGLES[i]}</span>
                  </div>
                ))}
              </div>
              <p className="text-[9px] mt-3" style={{ color: "#4B5563" }}>Best days to publish based on your audience activity.</p>
            </div>
          </div>
        </div>

        {/* Trust strip */}
        <div className="rounded-2xl border px-6 py-5 grid sm:grid-cols-3 gap-5" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.07)" }}>
          {TRUST.map(([icon, title, sub]) => (
            <div key={title} className="flex items-center gap-3">
              <span className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(168,85,247,0.12)", color: "#C4B5FD" }}>{icon}</span>
              <div><p className="text-[13px] font-bold text-white">{title}</p><p className="text-[11px]" style={{ color: "#6B7280" }}>{sub}</p></div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
