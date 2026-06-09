"use client";

import { useRouter } from "next/navigation";
import { TIER_META, getTrendStateChip, TREND_CHIP_META } from "@/lib/workspaceStatics";
import type { WeeklyPlanItem } from "@/lib/useWeeklyPlan";
import type { WorkspaceFeedItem } from "@/app/api/workspace/feed/route";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const CHIP_ICON: Record<string, string> = {
  rising: "↑", evergreen: "∞", seasonal: "◎",
};

// Recommended weekly mix targets
const TARGET_MIX = [
  { key: "rising",   label: "Rising",   pct: 40, color: "#059669" },
  { key: "evergreen", label: "Evergreen", pct: 40, color: "#0284C7" },
  { key: "seasonal", label: "Seasonal", pct: 20, color: "#9333EA" },
];

type Props = {
  items:      WeeklyPlanItem[];
  weekLabel:  string;
  category:   string;
  onClose:    () => void;
  feedItems?: WorkspaceFeedItem[];
};

export function WeeklyPlanModal({ items, weekLabel, category, onClose, feedItems = [] }: Props) {
  const router = useRouter();

  // Group items by day index (sort_order % 7)
  const byDay: (WeeklyPlanItem | null)[] = Array(7).fill(null);
  for (const item of items) {
    const slot = item.sort_order % 7;
    if (!byDay[slot]) byDay[slot] = item;
  }

  // Compute actual lifecycle mix from plan items × feedItems lookup
  const feedByKeywordId = Object.fromEntries(feedItems.map(f => [f.keyword_id, f]));
  const mixCount: Record<string, number> = { rising: 0, evergreen: 0, seasonal: 0, unclear: 0 };
  for (const item of items) {
    const feed = feedByKeywordId[item.keyword_id];
    const chip = feed
      ? getTrendStateChip({ pct_growth_yoy: null, weekly_change: null, trend_lifecycle: feed.trend_lifecycle })
      : "evergreen";  // fallback when feed item not in current page
    mixCount[chip] = (mixCount[chip] ?? 0) + 1;
  }
  const totalItems = items.length;

  function goToPlan() {
    onClose();
    router.push(`/app/plan?category=${encodeURIComponent(category)}`);
  }

  return (
    // Backdrop
    <div
      onClick={onClose}
      style={{
        position:   "fixed",
        inset:      0,
        background: "rgba(0,0,0,0.75)",
        display:    "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex:     100,
        padding:    "24px",
      }}
    >
      {/* Panel */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width:        "100%",
          maxWidth:     "480px",
          background:   "var(--app-surface)",
          border:       "1px solid var(--app-border)",
          borderRadius: "14px",
          overflow:     "hidden",
          display:      "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{
          padding:      "18px 20px 14px",
          borderBottom: "1px solid var(--app-border)",
          display:      "flex",
          alignItems:   "center",
          justifyContent: "space-between",
        }}>
          <div>
            <p style={{ margin: 0, fontSize: "11px", color: "var(--app-text-sec)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Weekly Plan Ready
            </p>
            <h2 style={{ margin: "2px 0 0", fontSize: "16px", fontWeight: 800, color: "var(--app-text)" }}>
              {weekLabel}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              width: "28px", height: "28px",
              borderRadius: "50%",
              border: "1px solid var(--app-border)",
              background: "transparent",
              color: "var(--app-text-sec)",
              cursor: "pointer",
              fontSize: "14px",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>

        {/* Mix display */}
        <div style={{
          padding: "10px 20px",
          borderBottom: "1px solid #F1F5F9",
          display: "flex", flexDirection: "column", gap: "7px",
        }}>
          {/* Actual plan composition */}
          {totalItems > 0 && (
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: "9px", fontWeight: 700, color: "var(--app-text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", flexShrink: 0 }}>
                Your mix
              </span>
              {TARGET_MIX.map(({ key, label, color }) => {
                const count = mixCount[key] ?? 0;
                if (count === 0) return null;
                return (
                  <span key={key} style={{
                    padding: "2px 7px", borderRadius: "20px", fontSize: "9px", fontWeight: 700,
                    background: `${color}12`, color, border: `1px solid ${color}2E`,
                  }}>
                    {CHIP_ICON[key]} {label} {count}
                  </span>
                );
              })}
              {(mixCount.unclear ?? 0) > 0 && (
                <span style={{ fontSize: "9px", color: "var(--app-text-muted)" }}>
                  + {mixCount.unclear} other
                </span>
              )}
            </div>
          )}
          {/* Recommended target */}
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "9px", fontWeight: 700, color: "var(--app-text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", flexShrink: 0 }}>
              Target
            </span>
            {TARGET_MIX.map(({ key, label, pct, color }) => (
              <span key={key} style={{
                padding: "2px 7px", borderRadius: "20px", fontSize: "9px", fontWeight: 600,
                background: "var(--app-bg)", color: "var(--app-text-muted)", border: "1px solid var(--app-border)",
              }}>
                {CHIP_ICON[key]} {label} {pct}%
              </span>
            ))}
          </div>
        </div>

        {/* Day rows */}
        <div style={{ padding: "12px 20px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {DAY_LABELS.map((day, i) => {
            const item = byDay[i];
            const tier = item ? TIER_META[item.tier as keyof typeof TIER_META] : null;
            return (
              <div
                key={day}
                style={{
                  display:      "flex",
                  alignItems:   "center",
                  gap:          "10px",
                  padding:      "7px 10px",
                  borderRadius: "7px",
                  background:   item ? tier!.bg : "var(--app-bg)",
                  border:       `1px solid ${item ? tier!.color + "33" : "var(--app-border)"}`,
                }}
              >
                <span style={{ width: "30px", fontSize: "10px", color: "var(--app-text-sec)", fontWeight: 600, textTransform: "uppercase" }}>
                  {day}
                </span>
                {item ? (
                  <>
                    <span style={{
                      flex: 1,
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "var(--app-text)",
                      textTransform: "capitalize",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {item.keyword}
                    </span>
                    <span style={{
                      fontSize: "9px",
                      fontWeight: 700,
                      color: tier!.color,
                      letterSpacing: "0.06em",
                    }}>
                      {tier!.label}
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: "11px", color: "#CBD5E1" }}>—</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer CTAs */}
        <div style={{
          padding:    "14px 20px 18px",
          display:    "flex",
          gap:        "8px",
          borderTop:  "1px solid var(--app-border)",
        }}>
          <button
            onClick={goToPlan}
            style={{
              flex:         1,
              padding:      "10px 0",
              fontSize:     "13px",
              fontWeight:   700,
              borderRadius: "8px",
              border:       "none",
              background:   "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)",
              color:        "#fff",
              cursor:       "pointer",
            }}
          >
            View Full Plan →
          </button>
          <button
            onClick={onClose}
            style={{
              padding:      "10px 16px",
              fontSize:     "13px",
              fontWeight:   600,
              borderRadius: "8px",
              border:       "1px solid #2a2a2a",
              background:   "transparent",
              color:        "var(--app-text-sec)",
              cursor:       "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
