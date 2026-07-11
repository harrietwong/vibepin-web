// Shared theme tokens for the Create Pins board (studioBoardV2). Uses app theme
// variables so the workspace is light in light mode (matching the design) and
// theme-aware. Fallbacks are the light palette.

export const BUI = {
  bg:        "var(--app-bg, #F8FAFC)",
  surface:   "var(--app-surface, #FFFFFF)",
  surface2:  "var(--app-surface-2, #F8FAFC)",
  surface3:  "var(--app-surface-3, #F1F5F9)",
  border:    "var(--app-border, #E2E8F0)",
  borderHi:  "var(--app-border-hi, #CBD5E1)",
  text:      "var(--app-text, #0F172A)",
  textSec:   "var(--app-text-sec, #475569)",
  textMuted: "var(--app-text-muted, #94A3B8)",
  purple:    "#7C3AED",
  gradient:  "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
  success:   "#10B981",
  error:     "#EF4444",
  warning:   "#D97706",
  info:      "#2563EB",
  scheduled: "#6366F1",
} as const;

export const toneColor: Record<string, string> = {
  info:      BUI.info,
  success:   BUI.success,
  error:     BUI.error,
  scheduled: BUI.scheduled,
  neutral:   "#475569",
};

export const fieldStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 9,
  border: `1px solid ${BUI.border}`, fontSize: 13, color: BUI.text,
  background: BUI.surface, outline: "none", lineHeight: 1.5, fontFamily: "inherit",
};

export const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: BUI.textSec, marginBottom: 4, display: "block",
};
