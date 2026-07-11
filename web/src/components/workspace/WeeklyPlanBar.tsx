"use client";

import { TIER_META } from "@/lib/workspaceStatics";

type TargetCount = 7 | 14 | 21;

type Props = {
  selectedCount:          number;
  targetCount:            TargetCount;
  isPro:                  boolean;
  isPlanReady:            boolean;
  onTargetChange?:        (t: TargetCount) => void;
  onBuildPlan:            () => void;
  onCreateSelectedPins?:  () => void;
  onUpgradePrompt?:       () => void;
};

export function WeeklyPlanBar({
  selectedCount,
  targetCount,
  isPro,
  isPlanReady,
  onTargetChange,
  onBuildPlan,
  onCreateSelectedPins,
  onUpgradePrompt,
}: Props) {
  const filled = Math.min(selectedCount, targetCount);
  const ready  = selectedCount >= targetCount;

  function handleTargetClick(t: TargetCount) {
    if (t === 7) {
      onTargetChange?.(7);
      return;
    }
    if (!isPro) {
      onUpgradePrompt?.();
      return;
    }
    onTargetChange?.(t);
  }

  return (
    <div style={{
      display:      "flex",
      alignItems:   "center",
      gap:          "16px",
      padding:      "10px 16px",
      background:   "var(--app-surface)",
      borderBottom: "1px solid var(--app-border)",
      flexWrap:     "wrap",
    }}>

      {/* Label */}
      <span style={{ fontSize: "12px", color: "var(--app-text-sec)", whiteSpace: "nowrap" }}>
        This week
      </span>

      {/* Dot progress (7) or numeric (14/21) */}
      {targetCount === 7 ? (
        <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              style={{
                width:        "8px",
                height:       "8px",
                borderRadius: "50%",
                background:   i < filled ? "#D946EF" : "var(--app-border)",
                transition:   "background 0.15s",
              }}
            />
          ))}
        </div>
      ) : (
        <span style={{ fontSize: "13px", color: ready ? "#D946EF" : "var(--app-text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {selectedCount} / {targetCount}
        </span>
      )}

      {/* Count text */}
      <span style={{ fontSize: "12px", color: "var(--app-text-muted)" }}>
        {filled} of {targetCount} selected
      </span>

      {/* Segment control — always visible; non-Pro 14/21 → upgrade */}
      <div style={{
        display:      "flex",
        border:       "1px solid var(--app-border)",
        borderRadius: "6px",
        overflow:     "hidden",
        marginLeft:   "auto",
      }}>
        {([7, 14, 21] as TargetCount[]).map(t => {
          const isLocked = t !== 7 && !isPro;
          const isActive = targetCount === t;
          return (
            <button
              key={t}
              onClick={() => handleTargetClick(t)}
              title={isLocked ? "Pro plan required" : undefined}
              style={{
                padding:     "3px 10px",
                fontSize:    "11px",
                cursor:      "pointer",
                border:      "none",
                borderRight: t !== 21 ? "1px solid var(--app-border)" : "none",
                background:  isActive ? "var(--app-surface-3)" : "transparent",
                color:       isLocked ? "var(--app-text-dim)" : isActive ? "var(--app-text)" : "var(--app-text-sec)",
                transition:  "background 0.15s",
                position:    "relative",
              }}
            >
              {t}
              {isLocked && (
                <span style={{ fontSize: "8px", marginLeft: "2px", verticalAlign: "super", color: "#F59E0B" }}>
                  ★
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        {/* Primary: Create Selected Pins — visible whenever any are selected */}
        {selectedCount > 0 && onCreateSelectedPins && (
          <button
            onClick={onCreateSelectedPins}
            style={{
              padding:      "5px 14px",
              fontSize:     "12px",
              fontWeight:   700,
              borderRadius: "6px",
              border:       "none",
              cursor:       "pointer",
              background:   "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)",
              color:        "#fff",
              whiteSpace:   "nowrap",
            }}
          >
            ✦ Create {selectedCount} Pin{selectedCount > 1 ? "s" : ""}
          </button>
        )}

        {/* Secondary: Build Weekly Plan / Plan built */}
        {isPlanReady ? (
          <span style={{ fontSize: "12px", color: TIER_META.early_trend.color, fontWeight: 600 }}>
            ✓ Plan built
          </span>
        ) : (
          <button
            onClick={onBuildPlan}
            disabled={!ready}
            style={{
              padding:      "5px 14px",
              fontSize:     "12px",
              fontWeight:   600,
              borderRadius: "6px",
              border:       "1px solid var(--app-border)",
              cursor:       ready ? "pointer" : "not-allowed",
              background:   "transparent",
              color:        ready ? "var(--app-text-sec)" : "var(--app-text-muted)",
              transition:   "color 0.15s",
              whiteSpace:   "nowrap",
            }}
          >
            Add to Weekly Plan
          </button>
        )}
      </div>
    </div>
  );
}
