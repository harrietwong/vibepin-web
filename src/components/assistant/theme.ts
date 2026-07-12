/**
 * Shared visual tokens for the assistant surface. Reuses the app's dark theme CSS
 * vars (with fallbacks) so nothing about the existing UI is redesigned. The assistant
 * floats ABOVE every drawer/modal (which top out around z-index 330) so "Ask VibePin"
 * is reachable from any workflow state.
 */
export const AUI = {
  card:      "var(--app-surface, #161D2E)",
  cardElev:  "var(--app-surface-3, #1A2236)",
  bg2:       "var(--app-surface-2, #111827)",
  border:    "var(--app-border, rgba(255,255,255,0.09))",
  borderHi:  "var(--app-border-hi, rgba(255,255,255,0.14))",
  text:      "var(--app-text, #E2E8F0)",
  textSec:   "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #64748B)",
  brand:     "var(--app-brand, #A855F7)",
  gradient:  "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
  issue:     "#F59E0B",
  issueStrong: "#EF4444",
  suggestion: "#A855F7",
  ready:     "#10B981",
} as const;

export const Z = {
  launcher: 2_000_000_000,
  panel:    2_000_000_001,
  preview:  2_000_000_010,
} as const;

/** Severity → dot color. */
export function severityColor(sev: "issue" | "suggestion" | "ready"): string {
  if (sev === "issue") return AUI.issueStrong;
  if (sev === "ready") return AUI.ready;
  return AUI.suggestion;
}
