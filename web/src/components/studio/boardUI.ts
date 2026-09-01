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
  mediaFallback:       "#20242B",
  mediaFallbackBorder: "rgba(255,255,255,0.08)",
  mediaFallbackIcon:   "#8B93A1",
  mediaFallbackText:   "#AAB1BC",
} as const;

/** Studio-only density and responsive-layout tokens. */
export const STUDIO_UI = {
  space1: 4,
  space2: 6,
  space3: 8,
  space4: 12,
  space5: 16,
  space6: 20,
  space7: 24,
  cardMinWidth: 248,
  cardGap: 12,
  boardPadding: 18,
  cardRadius: 12,
  fieldRadius: 8,
  fieldHeight: 32,
  planPanelWidth: 336,
  planRailWidth: 36,
  mobileMaxWidth: 767,
  scheduleCompactHeight: 34,
  scheduleMobileTouchHeight: 44,
} as const;

/** Mirrors the Studio-only CSS hit-box contract for deterministic responsive tests. */
export function studioScheduleHitHeight(viewportWidth: number): number {
  return viewportWidth <= STUDIO_UI.mobileMaxWidth
    ? STUDIO_UI.scheduleMobileTouchHeight
    : STUDIO_UI.scheduleCompactHeight;
}

/** A pinned Plan is legal only when the measured Studio container can still hold
 * two editable cards. The browser viewport alone ignores the app navigation width. */
export function canDockStudioPlan(containerWidth: number): boolean {
  const twoCardWorkspace = (STUDIO_UI.cardMinWidth * 2)
    + STUDIO_UI.cardGap
    + (STUDIO_UI.boardPadding * 2);
  return Number.isFinite(containerWidth)
    && containerWidth >= STUDIO_UI.planPanelWidth + twoCardWorkspace;
}

export const toneColor: Record<string, string> = {
  info:      BUI.info,
  success:   BUI.success,
  error:     BUI.error,
  scheduled: BUI.scheduled,
  neutral:   "#475569",
};

export const fieldStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", minHeight: STUDIO_UI.fieldHeight,
  padding: "7px 9px", borderRadius: STUDIO_UI.fieldRadius,
  border: `1px solid ${BUI.border}`, fontSize: 13, color: BUI.text,
  background: BUI.surface, outline: "none", lineHeight: 1.5, fontFamily: "inherit",
};

export const labelStyle: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: BUI.textSec, marginBottom: STUDIO_UI.space1, display: "block",
};
