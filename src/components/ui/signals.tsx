"use client";
// ── Unified signal display primitives ──────────────────────────────────────────
// Light-theme aware. All colors readable on white (#FFFFFF) backgrounds.

// ── Tier derivation ───────────────────────────────────────────────────────────
export type Tier = "elite" | "strong" | "rising" | "emerging" | "watchlist";

export function scoreTier(score: number | null | undefined): Tier {
  if (score == null) return "watchlist";
  if (score >= 90) return "elite";
  if (score >= 80) return "strong";
  if (score >= 70) return "rising";
  if (score >= 60) return "emerging";
  return "watchlist";
}

// Colors chosen for readability on white card backgrounds.
const TIER_META: Record<Tier, { label: string; color: string; bg: string; border: string }> = {
  elite:     { label: "ELITE",     color: "#0E4C6A", bg: "rgba(14, 76, 106, 0.08)",   border: "rgba(14, 76, 106, 0.18)"   },
  strong:    { label: "STRONG",    color: "#0E7490", bg: "rgba(14, 116, 144, 0.08)",  border: "rgba(14, 116, 144, 0.18)"  },
  rising:    { label: "RISING",    color: "#0891B2", bg: "rgba(8, 145, 178, 0.08)",   border: "rgba(8, 145, 178, 0.18)"   },
  emerging:  { label: "EMERGING",  color: "#6B7280", bg: "rgba(107, 114, 128, 0.07)", border: "rgba(107, 114, 128, 0.15)" },
  watchlist: { label: "WATCH",     color: "#9CA3AF", bg: "rgba(156, 163, 175, 0.06)", border: "rgba(156, 163, 175, 0.12)" },
};

// ── ScoreBadge ────────────────────────────────────────────────────────────────
// Large score display. Number is primary — tier label is secondary context.
export function ScoreBadge({
  score,
  size = "md",
  showTier = true,
}: {
  score: number | null | undefined;
  size?: "sm" | "md" | "lg";
  showTier?: boolean;
}) {
  const tier = scoreTier(score);
  const { label, color } = TIER_META[tier];
  const num = score != null ? Math.round(score) : "—";

  const numSize  = size === "sm" ? "text-[15px]" : size === "lg" ? "text-[30px]" : "text-[20px]";
  const tierSize = size === "sm" ? "text-[8px]"  : size === "lg" ? "text-[10px]" : "text-[9px]";
  const gap      = size === "lg" ? "gap-1" : "gap-0.5";

  return (
    <div className={`flex flex-col items-end ${gap}`}>
      <span className={`${numSize} font-black tabular-nums leading-none`} style={{ color }}>{num}</span>
      {showTier && (
        <span className={`${tierSize} font-bold uppercase tracking-widest leading-none`} style={{ color, opacity: 0.7 }}>{label}</span>
      )}
    </div>
  );
}

// ── ScorePill ─────────────────────────────────────────────────────────────────
// Compact inline pill — light bg tint, readable border, dark-ish text.
export function ScorePill({ score }: { score: number | null | undefined }) {
  const tier = scoreTier(score);
  const { label, color, bg, border } = TIER_META[tier];
  const num = score != null ? Math.round(score) : "—";

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
      style={{ background: bg, border: `1px solid ${border}`, color }}
    >
      {num}
      <span className="text-[8px] font-semibold opacity-60">{label}</span>
    </span>
  );
}

// ── ConfidenceDot ─────────────────────────────────────────────────────────────
// Semantic status — green / amber / gray. Never brand color.
export function ConfidenceDot({
  level,
  showLabel = false,
}: {
  level: "high" | "medium" | "low" | null | undefined;
  showLabel?: boolean;
}) {
  const meta = {
    high:   { color: "#10B981", label: "high" },
    medium: { color: "#F59E0B", label: "medium" },
    low:    { color: "#9CA3AF", label: "low" },
  }[level ?? "low"] ?? { color: "#9CA3AF", label: "low" };

  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: meta.color }}
      />
      {showLabel && (
        <span className="text-[10px] font-medium" style={{ color: meta.color }}>
          {meta.label}
        </span>
      )}
    </span>
  );
}

// ── EvidenceLine ──────────────────────────────────────────────────────────────
// Smart evidence summary with honest fallbacks.
// - Has products + pins/saves  → "12 products · 34 pins · 275K saves"
// - Has pins but no products   → "X pins · Y saves · Pin evidence only"
// - No product/pin evidence    → "Trend-only signal" (amber)
export function EvidenceLine({
  products,
  pins,
  saves,
  className = "",
}: {
  products?: number | null;
  pins?: number | null;
  saves?: number | null;
  className?: string;
}) {
  const hasProducts = (products ?? 0) > 0;
  const hasPins     = (pins ?? 0) > 0;
  const hasSaves    = (saves ?? 0) > 0;
  const hasAny      = hasProducts || hasPins || hasSaves;

  if (!hasAny) {
    return (
      <span className={`text-[10px] font-medium ${className}`} style={{ color: "#F59E0B" }}>
        Trend-only signal
      </span>
    );
  }

  const parts: string[] = [];
  if (hasProducts) parts.push(`${products} ${products === 1 ? "product" : "products"}`);
  if (hasPins)     parts.push(`${pins} ${pins === 1 ? "pin" : "pins"}`);
  if (hasSaves) {
    const s = (saves as number) >= 1_000_000
      ? `${((saves as number) / 1_000_000).toFixed(1)}M saves`
      : (saves as number) >= 1_000
      ? `${Math.round((saves as number) / 1_000)}K saves`
      : `${saves} saves`;
    parts.push(s);
  }

  const pinOnlyWarning = !hasProducts && hasPins;

  return (
    <span className={`text-[10px] text-gray-500 ${className}`}>
      {parts.join(" · ")}
      {pinOnlyWarning && (
        <span className="ml-1 font-medium" style={{ color: "#F59E0B" }}>· Pin evidence only</span>
      )}
    </span>
  );
}
