"use client";

/**
 * FailureBanner — a bounded, low-intensity warning CARD (not a full-width red bar)
 * surfaced on Create Pins and Plan whenever one or more Pins have a failed PUBLISH
 * attempt (PRD "Create Pins & Plan 失败情况优化" §2). Publish failures only —
 * generation failures are intentionally excluded (see countPublishFailures in
 * pinLifecycle.ts); the CTA still routes into the shared Failed filter, where each card
 * already labels itself "Publish failed" vs "Generation failed" (PRD §5) so a user can
 * tell publish- and generation-failures apart once there.
 *
 * count === 0 → renders nothing. Dismiss semantics (PRD §2.2):
 *   - Clicking the CTA counts as "read" — it dismisses the banner AND navigates.
 *   - The × close button dismisses without navigating.
 *   - Either way this is a session-scoped dismiss: it hides the banner for the rest of
 *     the browser session UNLESS the failure count goes up again (a NEW failure), in
 *     which case it reappears automatically. sessionStorage (not localStorage): the
 *     banner is meant to resurface on a fresh session/tab.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

// Warning accent (amber) — matches the existing inline warning banners in this app
// (see app/plan/page.tsx's restoreNotice banner: border rgba(217,119,6,0.35) /
// background rgba(217,119,6,0.08) / text #D97706). Not a grayscale/surface token, so
// it stays a literal like BUI.error/BUI.purple elsewhere in Studio — legible in both
// themes because it's a saturated accent color, not a light-mode-only value.
const WARN = "#D97706";

// ── Session-scoped dismiss ──────────────────────────────────────────────────────
// "Dismiss" (× or CTA) hides the banner for the rest of this browser session, but a
// NEW failure (count increasing past what was dismissed) makes it reappear — dismiss
// never hides an unrelated, later failure. sessionStorage (not localStorage): the
// banner is meant to resurface on a fresh session/tab.
const DISMISS_KEY = "vp:failure_banner:dismissed_at_count";

function readDismissedCount(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(DISMISS_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
function writeDismissedCount(n: number): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(DISMISS_KEY, String(n)); } catch { /* storage unavailable — non-fatal */ }
}
function clearDismissedCount(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(DISMISS_KEY); } catch { /* storage unavailable — non-fatal */ }
}

/**
 * Pure decision: given the live failure count and the count the user dismissed at
 * (null = never dismissed / already reset), what count should the banner render?
 * Dismissing hides the banner until `count` exceeds `dismissedAt` — a NEW failure
 * (count went up since the dismiss) always breaks through.
 */
export function computeVisibleFailureCount(count: number, dismissedAt: number | null): number {
  if (dismissedAt !== null && count <= dismissedAt) return 0;
  return count;
}

/**
 * Session-scoped dismiss for a FailureBanner driven by `count`. Returns the count to
 * actually render (0 while dismissed-and-not-worsened) and a dismiss callback.
 * When `count` drops to 0 the dismiss flag is cleared, so a later failure starts fresh.
 */
export function useFailureBannerDismiss(count: number): { visibleCount: number; dismiss: () => void } {
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // Hydrate from sessionStorage once mounted (avoids SSR/client mismatch).
  useEffect(() => { setDismissedAt(readDismissedCount()); }, []);

  useEffect(() => {
    if (count === 0 && dismissedAt !== null) {
      setDismissedAt(null);
      clearDismissedCount();
    }
  }, [count, dismissedAt]);

  const dismiss = useCallback(() => {
    setDismissedAt(count);
    writeDismissedCount(count);
  }, [count]);

  const visibleCount = computeVisibleFailureCount(count, dismissedAt);
  return { visibleCount, dismiss };
}

/** Pure count→copy mapping (singular vs plural). PRD §2.1 wording. */
export function getFailureBannerCopy(count: number): { title: string; body: string; cta: string } {
  return count === 1
    ? { title: "1 Pin failed to publish", body: "Review the error and choose how to continue.", cta: "Review failed Pin" }
    : { title: `${count} Pins failed to publish`, body: "Review the errors and choose how to continue.", cta: "Review failed Pins" };
}

export type FailureBannerProps = {
  count: number;
  onReview: () => void;
  onDismiss?: () => void;
};

/**
 * FailureBanner. onReview is treated as an implicit dismiss (PRD §2.2 "CTA click =
 * dismiss"): clicking "Review failed Pins" fires onDismiss (when provided) BEFORE
 * onReview, so both Plan and Studio mounts get the same "navigated away = read"
 * behavior for free without each caller having to remember to wire it up twice.
 */
export function FailureBanner({ count, onReview, onDismiss }: FailureBannerProps) {
  if (count <= 0) return null;

  const { title, body, cta } = getFailureBannerCopy(count);

  const handleReview = () => {
    onDismiss?.();
    onReview();
  };

  return (
    <div
      data-testid="failure-banner"
      role="alert"
      style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12,
        flexWrap: "wrap", margin: "12px 22px 0", padding: "12px 14px",
        borderRadius: 12,
        border: `1px solid ${WARN}59`,
        background: `${WARN}14`,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0, flex: "1 1 auto" }}>
        <AlertTriangle style={{ width: 16, height: 16, color: WARN, flexShrink: 0, marginTop: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "var(--app-text)" }}>{title}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--app-text-sec)" }}>{body}</span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button
          type="button"
          data-testid="failure-banner-cta"
          onClick={handleReview}
          style={{
            padding: "7px 14px", borderRadius: 8,
            border: `1px solid ${WARN}73`,
            background: `${WARN}24`,
            color: WARN, fontSize: 12, fontWeight: 800,
            cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
          }}
        >
          {cta}
        </button>
        {onDismiss && (
          <button
            type="button"
            data-testid="failure-banner-dismiss"
            aria-label="Hide for now"
            onClick={onDismiss}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, padding: 0, border: "none", borderRadius: 6,
              background: "none", color: "var(--app-text-sec)", cursor: "pointer", fontFamily: "inherit",
            }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        )}
      </div>
    </div>
  );
}
