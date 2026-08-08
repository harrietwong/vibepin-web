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
 *   - Either way the dismiss is PERSISTENT (localStorage) and PER-SCOPE: it hides that
 *     scope's banner across reloads/tabs/sessions UNLESS the actionable failure
 *     identity changes (a NEW failure), in which case it reappears automatically.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

// Warning accent (amber) — matches the existing inline warning banners in this app
// (see app/plan/page.tsx's restoreNotice banner: border rgba(217,119,6,0.35) /
// background rgba(217,119,6,0.08) / text #D97706). Not a grayscale/surface token, so
// it stays a literal like BUI.error/BUI.purple elsewhere in Studio — legible in both
// themes because it's a saturated accent color, not a light-mode-only value.
const WARN = "#D97706";

// ── Persistent, per-scope dismiss ───────────────────────────────────────────────
// "Dismiss" (× or CTA) hides that scope's banner until a NEW failure-set identity
// makes it reappear — a dismiss never hides an unrelated, later failure.
//
// Two deliberate properties (real-device QA fixes):
//  1. localStorage, not sessionStorage — a user who already clicked "Review" should
//     not get the same banner again in a new tab / after a browser restart.
//  2. The key is namespaced per SCOPE ("plan:<weekStart>" | "studio"). The mounts
//     count different populations (Plan = that week's failures, Create Pins = the
//     whole board), so a shared key would let one surface's dismiss silently suppress
//     the other's real failures. Separate keys keep each scope's dismiss to itself.
const DISMISS_KEY = "vp:failure_banner:dismissed_failure_set";
export function failureBannerDismissKey(scope: string): string { return `${DISMISS_KEY}:${scope}`; }

function readDismissedIdentity(scope: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(failureBannerDismissKey(scope));
  } catch { return null; }
}
function writeDismissedIdentity(scope: string, identity: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(failureBannerDismissKey(scope), identity); } catch { /* storage unavailable — non-fatal */ }
}
function clearDismissedIdentity(scope: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(failureBannerDismissKey(scope)); } catch { /* storage unavailable — non-fatal */ }
}

/**
 * Pure decision: given the live failure count, the identity of the currently actionable
 * failure set, and the identity the user dismissed at (null = never dismissed / already
 * reset), what count should the banner render?
 *
 * Identity — not count — is the dismiss key (publishFailureSetIdentity in
 * pinLifecycle.ts, "id:updatedAt" per failure). A count-based rule silently swallowed
 * real failures: dismissing at 3 hid a later, different set of 3, and one Pin being
 * fixed while another newly failed kept the count flat. Any change to the actionable
 * set (new failure, retry-failure on the same Pin, a failure resolved) yields a new
 * identity, so the banner breaks through.
 */
export function computeVisibleFailureCount(count: number, failureSetIdentity: string, dismissedIdentity: string | null): number {
  if (dismissedIdentity !== null && dismissedIdentity === failureSetIdentity) return 0;
  return count;
}

/**
 * Persistent, per-scope dismiss for a FailureBanner driven by `count`. Returns the
 * count to actually render (0 while dismissed at the current identity) and a dismiss
 * callback. When `count` drops to 0 the dismiss record is cleared, so a later failure
 * starts fresh.
 *
 * `scope` namespaces the persisted key: Plan (per week) and Create Pins must not share
 * dismiss state (see the key comment above).
 */
export function useFailureBannerDismiss(count: number, failureSetIdentity = `count:${count}`, scope = "default"): { visibleCount: number; dismiss: () => void } {
  const [dismissedIdentity, setDismissedIdentity] = useState<string | null>(null);

  // Hydrate from localStorage once mounted (avoids SSR/client mismatch).
  useEffect(() => { setDismissedIdentity(readDismissedIdentity(scope)); }, [scope]);

  useEffect(() => {
    if (count === 0 && dismissedIdentity !== null) {
      setDismissedIdentity(null);
      clearDismissedIdentity(scope);
    }
  }, [count, dismissedIdentity, scope]);

  const dismiss = useCallback(() => {
    setDismissedIdentity(failureSetIdentity);
    writeDismissedIdentity(scope, failureSetIdentity);
  }, [failureSetIdentity, scope]);

  const visibleCount = computeVisibleFailureCount(count, failureSetIdentity, dismissedIdentity);
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
