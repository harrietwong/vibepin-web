"use client";

// TODO — Data ingestion sources needed for Digital Signals to have real coverage:
//   1. Pinterest pins with destination URLs pointing to digital marketplaces
//   2. Etsy digital-only listings (exclude "ships to" listings)
//   3. Teachers Pay Teachers (TPT) product listings
//   4. Payhip digital products
//   5. Gumroad products (filter by "digital" category)
//   6. Creative Market (templates, fonts, graphics)
//   7. Creative Fabrica (printables, SVGs, fonts)
//   Scraper entry point: backend/scraper_v2.py — extend ingest_to_db() or add
//   a dedicated digital_scraper.py that targets the above platforms.

import { useState, useMemo, useCallback, useEffect } from "react";
import { TrendingUp, Sparkles, ExternalLink, Copy, Check, X, Search, ChevronDown, ChevronUp } from "lucide-react";

// ── Shared PinProduct type (mirrors products/page.tsx) ─────────────────────

export type DigitalPinProduct = {
  id: string;
  product_name: string;
  price: number | null;
  currency: string | null;
  source_url: string | null;
  domain: string | null;
  merchant: string | null;
  image_url: string;
  save_count: number;
  source_pin_save_count: number;
  seed_keyword: string | null;
  scraped_at: string | null;
  opportunity_score: number | null;
};

// ── Digital intent detection ──────────────────────────────────────────────────
// Checks: product_name (title), domain, source_url, merchant
// Priority: known digital platform domain > merchant name > title token

// These domains sell EXCLUSIVELY or PRIMARILY digital products.
// Etsy is intentionally excluded — it is a mixed marketplace.
// For Etsy, a digital title token is required to confirm intent.
const DIGITAL_ONLY_DOMAINS = [
  "teacherspayteachers", "tpt.com",
  "payhip",
  "gumroad",
  "creativemarket",
  "creativefabrica",
  "ko-fi",
  "selz",
  "sendowl",
  "teachermade",
  "boom.cards",
  "teachers.net",
  "tes.com",
];

const DIGITAL_TOKENS = [
  // Format-based
  "printable", "printables",
  "template", "templates",
  "worksheet", "worksheets",
  "planner",
  "tracker",
  "checklist",
  "spreadsheet",
  "workbook",
  "journal",
  "sticker", "stickers",

  // Platform-based (as title keywords)
  "notion",
  "canva",
  "tpt",
  "teachers pay teachers",
  "payhip",
  "gumroad",
  "creative market",
  "creative fabrica",

  // File-type or delivery signals
  "pdf",
  "svg",
  "png", "clipart",
  "digital paper",
  "invitation",
  "mockup",
  "preset",
  "ebook",
  "guide",
  "editable",
  "instant download",
  "digital download",
  "download",
];

// Physical/electronics tokens that confidently indicate NOT digital
const PHYSICAL_NEGATIVE = [
  "bluetooth", "speaker",
  "phone case", "iphone case", "samsung case",
  "screen protector",
  "led lamp", "desk lamp", "floor lamp",
  "office chair", "gaming chair",
  "potted plant", "succulent",
  "silk dress", "running shoes", "sneakers",
  "leather bag", "handbag", "tote bag",
  "gold necklace", "silver necklace",
  "wooden toy", "plush toy", "stuffed animal",
  "ceramic mug", "coffee mug",
  "graphic tee", "t-shirt",
  "handmade jewelry", "crystal jewelry",
  "free shipping",
  "cast iron", "wax melt", "scented candle",
  "essential oil",
  "resin art",
  "acrylic nail",
  "hair extension",
  "knee brace", "compression",
];

// ── Detection logic ───────────────────────────────────────────────────────────

type DetectionResult =
  | { included: true;  reason: string }
  | { included: false; reason: string };

function classifyProduct(p: DigitalPinProduct): DetectionResult {
  const name     = (p.product_name ?? "").toLowerCase();
  const domain   = (p.domain ?? "").toLowerCase();
  const merchant = (p.merchant ?? "").toLowerCase();

  // Extract domain from source_url as a fallback if domain field is empty
  let urlDomain = "";
  if (p.source_url) {
    try {
      urlDomain = new URL(p.source_url).hostname.toLowerCase().replace(/^www\./, "");
    } catch { /* ignore malformed URLs */ }
  }

  const allDomainText = `${domain} ${urlDomain} ${merchant}`;

  // 1. Known digital-only platform → strong positive signal (no title token required)
  for (const frag of DIGITAL_ONLY_DOMAINS) {
    if (allDomainText.includes(frag)) {
      return { included: true, reason: `platform: ${frag}` };
    }
  }

  // 2. Physical negative → exclude before token check
  for (const neg of PHYSICAL_NEGATIVE) {
    if (name.includes(neg)) {
      return { included: false, reason: `physical token: "${neg}"` };
    }
  }

  // 3. Digital token in title
  for (const token of DIGITAL_TOKENS) {
    if (name.includes(token)) {
      return { included: true, reason: `title token: "${token}"` };
    }
  }

  return { included: false, reason: "no digital signal" };
}

function isDigitalIntent(p: DigitalPinProduct): boolean {
  return classifyProduct(p).included;
}

// ── Diagnostics (dev-only) ────────────────────────────────────────────────────

type DiagReport = {
  total:            number;
  included:         number;
  excludedPhysical: number;
  excludedNoSignal: number;
  topTokens:        [string, number][];
  topDomains:       [string, number][];
  examples: {
    included: { name: string; domain: string | null; reason: string }[];
    excluded: { name: string; domain: string | null; reason: string }[];
  };
};

function buildDiagnostics(products: DigitalPinProduct[]): DiagReport {
  const tokenCounts:  Record<string, number> = {};
  const domainCounts: Record<string, number> = {};
  const includedEx:   DiagReport["examples"]["included"] = [];
  const excludedEx:   DiagReport["examples"]["excluded"] = [];
  let excludedPhysical = 0;
  let excludedNoSignal = 0;
  let included = 0;

  for (const p of products) {
    const result = classifyProduct(p);
    if (result.included) {
      included++;
      // Count triggering token/domain
      if (result.reason.startsWith("platform:")) {
        const key = result.reason.replace("platform: ", "").trim();
        domainCounts[key] = (domainCounts[key] ?? 0) + 1;
      } else {
        const token = result.reason.replace('title token: "', "").replace('"', "");
        tokenCounts[token] = (tokenCounts[token] ?? 0) + 1;
      }
      if (includedEx.length < 10) {
        includedEx.push({ name: p.product_name, domain: p.domain, reason: result.reason });
      }
    } else {
      if (result.reason.startsWith("physical token")) excludedPhysical++;
      else excludedNoSignal++;
      if (excludedEx.length < 10) {
        excludedEx.push({ name: p.product_name, domain: p.domain, reason: result.reason });
      }
    }
  }

  const topTokens  = Object.entries(tokenCounts).sort((a, b) => b[1] - a[1]).slice(0, 10) as [string, number][];
  const topDomains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 8) as [string, number][];

  return {
    total: products.length,
    included,
    excludedPhysical,
    excludedNoSignal,
    topTokens,
    topDomains,
    examples: { included: includedEx, excluded: excludedEx },
  };
}

// ── Dev diagnostics panel (rendered only in development) ─────────────────────

function DevDiagnosticsPanel({ diag }: { diag: DiagReport }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{
      border: "1px solid #F59E0B",
      borderRadius: 10,
      background: "#FFFBEB",
      fontSize: 11,
      fontFamily: "monospace",
      overflow: "hidden",
    }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%",
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "#92400E",
          fontWeight: 700,
          fontSize: 11,
          fontFamily: "monospace",
        }}
      >
        <span>
          🔧 DEV · DigitalSignalGrid diagnostics · {diag.included}/{diag.total} matched
        </span>
        {open
          ? <ChevronUp style={{ width: 14, height: 14 }} />
          : <ChevronDown style={{ width: 14, height: 14 }} />}
      </button>

      {open && (
        <div style={{ padding: "0 14px 12px", color: "#78350F" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 10 }}>
            {[
              ["Total rows loaded",      diag.total],
              ["✓ Passed filter",        diag.included],
              ["✗ Excluded (physical)",  diag.excludedPhysical],
              ["✗ Excluded (no signal)", diag.excludedNoSignal],
            ].map(([label, val]) => (
              <div key={String(label)} style={{ background: "#FEF3C7", borderRadius: 6, padding: "4px 8px" }}>
                <span style={{ color: "#92400E", opacity: 0.7 }}>{label}: </span>
                <strong>{val}</strong>
              </div>
            ))}
          </div>

          {diag.topTokens.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Top matched title tokens:</div>
              {diag.topTokens.map(([tok, n]) => (
                <div key={tok} style={{ paddingLeft: 8 }}>{tok}: {n}</div>
              ))}
            </div>
          )}

          {diag.topDomains.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Top matched platforms/domains:</div>
              {diag.topDomains.map(([d, n]) => (
                <div key={d} style={{ paddingLeft: 8 }}>{d}: {n}</div>
              ))}
            </div>
          )}

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>✓ Included examples (first 10):</div>
            {diag.examples.included.map((ex, i) => (
              <div key={i} style={{ paddingLeft: 8, marginBottom: 2, wordBreak: "break-word" }}>
                <span style={{ color: "#059669", fontWeight: 700 }}>+</span>{" "}
                <span>{ex.name.slice(0, 60)}</span>
                {ex.domain && <span style={{ color: "#92400E", opacity: 0.6 }}> [{ex.domain}]</span>}
                <span style={{ color: "#047857" }}> → {ex.reason}</span>
              </div>
            ))}
          </div>

          <div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>✗ Excluded examples (first 10):</div>
            {diag.examples.excluded.map((ex, i) => (
              <div key={i} style={{ paddingLeft: 8, marginBottom: 2, wordBreak: "break-word" }}>
                <span style={{ color: "#DC2626", fontWeight: 700 }}>−</span>{" "}
                <span>{ex.name.slice(0, 60)}</span>
                {ex.domain && <span style={{ color: "#92400E", opacity: 0.6 }}> [{ex.domain}]</span>}
                <span style={{ color: "#B91C1C" }}> → {ex.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Utility helpers ───────────────────────────────────────────────────────────

const FORMAT_DETECT: [string, string][] = [
  ["canva template", "Canva Template"],
  ["notion template", "Notion Template"],
  ["notion", "Notion Template"],
  ["canva", "Canva Template"],
  ["printable", "Printable"],
  ["template", "Template"],
  ["worksheet", "Worksheet"],
  ["planner", "Planner"],
  ["tracker", "Tracker"],
  ["checklist", "Checklist"],
  ["spreadsheet", "Spreadsheet"],
  ["ebook", "PDF Guide"],
  ["pdf", "PDF Guide"],
  ["guide", "PDF Guide"],
  ["workbook", "Worksheet"],
  ["svg", "SVG / Clipart"],
  ["clipart", "SVG / Clipart"],
  ["invitation", "Invitation"],
  ["mockup", "Mockup"],
  ["preset", "Preset"],
];

function detectFormat(name: string): string | null {
  const n = name.toLowerCase();
  for (const [token, label] of FORMAT_DETECT) {
    if (n.includes(token)) return label;
  }
  return null;
}

function detectPlatform(domain: string | null, sourceUrl: string | null): string {
  const raw = domain ?? "";
  const url = sourceUrl ?? "";
  const combined = `${raw.toLowerCase()} ${url.toLowerCase()}`;

  if (combined.includes("etsy"))                          return "Etsy";  // label only — not auto-included as digital
  if (combined.includes("teacherspayteachers") ||
      combined.includes("tpt.com"))                       return "TPT";
  if (combined.includes("payhip"))                        return "Payhip";
  if (combined.includes("gumroad"))                       return "Gumroad";
  if (combined.includes("creativemarket"))                return "Creative Market";
  if (combined.includes("creativefabrica"))               return "Creative Fabrica";
  if (combined.includes("ko-fi"))                         return "Ko-fi";
  if (combined.includes("canva"))                         return "Canva";

  if (!raw) return "External";
  const clean = raw.replace(/^www\./, "").split(".")[0];
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function signalLabel(saves: number): { label: string; color: string } {
  if (saves >= 5000) return { label: "Strong signal", color: "#059669" };
  if (saves >= 500)  return { label: "Medium signal", color: "#2563EB" };
  return                    { label: "Weak signal",   color: "#9CA3AF" };
}

function fmtSaves(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function trendUrl(query: string): string {
  return `https://trends.pinterest.com/search?q=${encodeURIComponent(query)}`;
}

// ── Query variant extraction ──────────────────────────────────────────────────
// Produces 3–5 candidate queries from a real pin title.
// Does NOT claim validation — variants go to the Check Trends drawer for manual checking.

const FORMAT_STRIP_ORDERED = [
  // Multi-word first so they're matched before their substrings
  "canva template", "notion template", "printable set",
  "instant download", "digital download",
  "pdf guide",
  "printable", "template", "worksheet", "planner", "tracker",
  "checklist", "spreadsheet", "ebook", "pdf", "guide", "workbook",
  "editable", "svg", "clipart", "invitation", "mockup", "preset",
  "sticker", "stickers",
];

const NOISE_STRIP_WORDS = [
  "etsy", "tpt", "teachers pay teachers", "payhip", "gumroad",
  "creative market", "creative fabrica",
  "free", "new", "best", "instant",
];

function extractQueryVariants(name: string): string[] {
  // Normalise
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip platform / noise words
  for (const w of NOISE_STRIP_WORDS) {
    base = base.replace(new RegExp(`\\b${w.replace(/\s+/g, "\\s+")}\\b`, "g"), " ")
               .replace(/\s+/g, " ")
               .trim();
  }

  // Detect and strip the primary format token
  const format = FORMAT_STRIP_ORDERED.find(t => base.includes(t));
  const withoutFormat = format
    ? base.replace(format, "").replace(/\s+/g, " ").trim()
    : base;

  const variants: string[] = [base]; // full cleaned title

  if (format && withoutFormat && withoutFormat !== base && withoutFormat.length > 3) {
    variants.push(withoutFormat);                         // concept only
    variants.push(`${withoutFormat} ${format}`);          // concept + original format
    // Also offer a cross-format variant
    if (format !== "printable") variants.push(`${withoutFormat} printable`);
    if (format !== "template")  variants.push(`${withoutFormat} template`);
  } else if (!format) {
    // No format detected — suggest common digital formats
    variants.push(`${base} printable`);
    variants.push(`${base} template`);
  }

  return [...new Set(variants.filter(v => v.trim().length > 4))].slice(0, 5);
}

// ── Trend drawer for a real digital signal pin ───────────────────────────────

function SignalTrendDrawer({
  product,
  onClose,
}: {
  product: DigitalPinProduct;
  onClose: () => void;
}) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const variants = useMemo(() => extractQueryVariants(product.product_name), [product.product_name]);

  const copyQuery = useCallback((query: string, idx: number) => {
    navigator.clipboard.writeText(query).catch(() => {});
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1800);
  }, []);

  const keyword    = product.seed_keyword ?? product.product_name;
  const platform   = detectPlatform(product.domain, product.source_url);
  const studioHref = `/app/studio?from=shop-signal&keyword=${encodeURIComponent(keyword)}&category=digital-products&sourceType=product&image_url=${encodeURIComponent(product.image_url)}`;

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />

      <div
        className="relative ml-auto w-full max-w-sm bg-white shadow-2xl flex flex-col h-full overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3 shrink-0">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#C026D3] mb-0.5">Check Pinterest Trends</p>
            <p className="text-[13px] font-bold text-gray-900 leading-snug">
              Validate demand before creating pins.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors shrink-0 mt-0.5">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        {/* Pin meta */}
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 shrink-0 flex gap-3">
          {product.image_url && (
            <div className="w-12 h-16 rounded-lg overflow-hidden shrink-0 bg-gray-100 border border-gray-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={product.image_url} alt="" className="w-full h-full object-cover" />
            </div>
          )}
          <div className="min-w-0">
            <p className="text-[12px] font-bold text-gray-900 leading-snug line-clamp-2">{product.product_name}</p>
            <p className="text-[10px] text-gray-400 mt-1">{platform} · {fmtSaves(product.save_count)} saves</p>
          </div>
        </div>

        {/* Validation disclaimer */}
        <div className="px-5 py-2 border-b border-amber-100 shrink-0 bg-amber-50">
          <p className="text-[10px] text-amber-700 font-medium">
            Queries extracted from pin title · Not yet validated · Check each in Pinterest Trends.
          </p>
        </div>

        {/* Queries */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">Candidate queries</p>
          <div className="space-y-2">
            {variants.map((v, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 transition-colors"
              >
                <span className="text-[12px] font-medium text-gray-800 flex-1 min-w-0 truncate">{v}</span>
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
          {copiedIdx !== null && (
            <p className="text-[11px] text-green-600 font-semibold mt-3 text-center">Copied query</p>
          )}
        </div>

        {/* Bottom actions */}
        <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
          <a
            href={studioHref}
            className="flex items-center justify-center gap-2 w-full rounded-xl py-2.5 text-[12px] font-bold text-white no-underline transition-all hover:brightness-105"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
          >
            <Sparkles className="h-3.5 w-3.5" /> Create Pins from this signal
          </a>
          {product.source_url && (
            <a
              href={product.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full rounded-xl py-2.5 text-[12px] font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50 no-underline transition-colors"
            >
              <ExternalLink className="h-3 w-3" /> View source
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Digital signal card ───────────────────────────────────────────────────────

function DigitalSignalCard({
  product,
  onCheckTrend,
}: {
  product: DigitalPinProduct;
  onCheckTrend: (p: DigitalPinProduct) => void;
}) {
  const [imgError, setImgError] = useState(false);
  const format   = detectFormat(product.product_name);
  const platform = detectPlatform(product.domain, product.source_url);
  const signal   = signalLabel(product.save_count);
  const keyword  = product.seed_keyword ?? product.product_name;
  const studioHref = `/app/studio?from=shop-signal&keyword=${encodeURIComponent(keyword)}&category=digital-products&sourceType=product&image_url=${encodeURIComponent(product.image_url)}`;

  return (
    <div className="group rounded-xl overflow-hidden border border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm transition-all flex flex-col">
      {/* Image */}
      <div className="relative aspect-square bg-gray-100 shrink-0">
        {!imgError && product.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image_url}
            alt={product.product_name}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-fuchsia-50 to-purple-50">
            <span className="text-3xl">🖥️</span>
          </div>
        )}
        {format && (
          <span
            className="absolute top-2 left-2 text-[8px] font-bold px-1.5 py-0.5 rounded-md"
            style={{ background: "rgba(124,58,237,0.85)", color: "#fff" }}
          >
            {format}
          </span>
        )}
        <span
          className="absolute top-2 right-2 text-[8px] font-semibold px-1.5 py-0.5 rounded-md"
          style={{ background: "rgba(255,255,255,0.92)", color: signal.color }}
        >
          {signal.label}
        </span>
      </div>

      {/* Body */}
      <div className="p-3 flex flex-col gap-2 flex-1">
        <div>
          <p className="text-[10px] text-[#7C3AED] font-semibold">{platform}</p>
          <p className="text-[12px] font-bold text-gray-900 leading-snug line-clamp-2 capitalize mt-0.5">
            {product.product_name}
          </p>
          {product.seed_keyword && (
            <p className="text-[9px] text-gray-400 mt-0.5 truncate">via: {product.seed_keyword}</p>
          )}
        </div>

        <div className="text-[10px] text-gray-400 mt-auto">
          {fmtSaves(product.save_count)} saves
          {product.source_pin_save_count > 0 && ` · ${fmtSaves(product.source_pin_save_count)} pin saves`}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onCheckTrend(product)}
            className="flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[10px] font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <TrendingUp className="h-3 w-3" /> Check Trends
          </button>
          <div className="flex gap-1.5">
            <a
              href={studioHref}
              className="flex-1 flex items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-bold text-white no-underline"
              style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
            >
              <Sparkles className="h-3 w-3" /> Create
            </a>
            {product.source_url && (
              <a
                href={product.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-semibold border border-gray-200 text-gray-500 hover:bg-gray-50 no-underline transition-colors"
                title="View source"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function DigitalSignalGrid({
  products,
  isLoading,
}: {
  products: DigitalPinProduct[];
  isLoading: boolean;
}) {
  const [search,       setSearch]       = useState("");
  const [trendProduct, setTrendProduct] = useState<DigitalPinProduct | null>(null);

  // Full-set diagnostics (before search filter), computed once per products change
  const diag = useMemo<DiagReport | null>(() => {
    if (products.length === 0) return null;
    return buildDiagnostics(products);
  }, [products]);

  // Dev-only: emit diagnostics to console when data loads
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (!diag) return;
    console.debug(
      "[DigitalSignalGrid] diagnostics",
      `total=${diag.total}`,
      `included=${diag.included}`,
      `excl_physical=${diag.excludedPhysical}`,
      `excl_no_signal=${diag.excludedNoSignal}`,
      diag,
    );
  }, [diag]);

  const digitalProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (!isDigitalIntent(p)) return false;
      if (!q) return true;
      return (
        p.product_name.toLowerCase().includes(q) ||
        (p.seed_keyword ?? "").toLowerCase().includes(q) ||
        (p.domain ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, search]);

  const isDev = process.env.NODE_ENV === "development";

  return (
    <div className="flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-[16px] font-black text-gray-900">Digital Product Signals</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">
            Real pins with digital intent · printables, templates, and downloadables
          </p>
        </div>
        <div className="relative shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search signals…"
            className="rounded-xl border border-gray-200 bg-white pl-9 pr-4 py-2 text-[12px] text-gray-800 focus:border-[#C026D3] focus:outline-none placeholder:text-gray-400 shadow-sm w-48"
          />
        </div>
      </div>

      {/* Dev diagnostics panel */}
      {isDev && diag && <DevDiagnosticsPanel diag={diag} />}

      {/* Validation notice */}
      <div className="flex items-start gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-100">
        <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wider shrink-0 mt-px">Note</span>
        <span className="text-[11px] text-amber-700">
          These are real product signals extracted from Pinterest pins. Use "Check Trends" on each card to validate demand before creating content.
        </span>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="rounded-xl overflow-hidden border border-gray-200 bg-white">
              <div className="animate-pulse bg-gray-100 aspect-square" />
              <div className="p-3 space-y-2">
                <div className="h-2.5 w-16 rounded bg-gray-100 animate-pulse" />
                <div className="h-3 w-full rounded bg-gray-100 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : digitalProducts.length > 0 ? (
        <>
          <p className="text-[11px] text-gray-400 tabular-nums -mt-2">{digitalProducts.length} digital signals</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {digitalProducts.map(p => (
              <DigitalSignalCard key={p.id} product={p} onCheckTrend={setTrendProduct} />
            ))}
          </div>
        </>
      ) : (
        <div className="py-20 text-center flex flex-col items-center gap-4">
          <span className="text-[40px]">🖥️</span>
          <div>
            <p className="text-[15px] font-bold text-gray-700">No digital product signals found yet</p>
            <p className="text-[12px] text-gray-500 mt-1.5 max-w-sm mx-auto">
              We need real Pinterest pins with digital destinations or digital-intent titles
              (Etsy, TPT, Gumroad, Payhip, Creative Market, or "printable / template / PDF" in the title).
            </p>
          </div>
          <p className="text-[12px] text-[#7C3AED] font-semibold">
            Try checking Digital Seeds in Trend Radar while data is collected.
          </p>
          {isDev && diag && (
            <p className="text-[11px] text-gray-400 font-mono">
              Checked {diag.total} pin_products rows — 0 matched digital-intent filter.
              See console for full diagnostics.
            </p>
          )}
        </div>
      )}

      {trendProduct && (
        <SignalTrendDrawer product={trendProduct} onClose={() => setTrendProduct(null)} />
      )}
    </div>
  );
}
