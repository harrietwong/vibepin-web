"use client";

import { useEffect, useState } from "react";

/**
 * useViewportBucket — the one breakpoint source for responsive app surfaces
 * (PRD 0809 §IX, Plan entry inside Create Pins).
 *
 * Three buckets, because the Plan entry has exactly three shapes:
 *   desktop (≥ 1280px) → docked, collapsible right panel (unchanged behaviour)
 *   tablet  (768–1279) → right-side drawer overlay, no grid reflow
 *   mobile  (< 768px)  → full-screen overlay
 *
 * SSR/first-render value is "desktop" ON PURPOSE. `matchMedia` does not exist on the
 * server, so any other default would either invent a viewport or force every consumer
 * to handle an "unknown" state. Defaulting to desktop keeps the server render byte-
 * identical to the pre-responsive markup, and the real bucket is applied in an effect
 * right after hydration — so a phone shows the desktop shape for at most one frame,
 * and React never sees a hydration mismatch.
 */
export type ViewportBucket = "mobile" | "tablet" | "desktop";

/** Below this width the Plan entry becomes a full-screen overlay. */
export const MOBILE_MAX_WIDTH = 767;
/** At or above this width the Plan entry is the docked right panel. */
export const DESKTOP_MIN_WIDTH = 1280;

const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;
const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

/**
 * Bucket for the CURRENT window, or "desktop" when there is no window
 * (server render, and node-based tests that import this module).
 */
export function readViewportBucket(): ViewportBucket {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
  if (window.matchMedia(MOBILE_QUERY).matches) return "mobile";
  if (window.matchMedia(DESKTOP_QUERY).matches) return "desktop";
  return "tablet";
}

export function useViewportBucket(): ViewportBucket {
  const [bucket, setBucket] = useState<ViewportBucket>("desktop");

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mobile = window.matchMedia(MOBILE_QUERY);
    const desktop = window.matchMedia(DESKTOP_QUERY);
    // Two queries, one handler: the middle bucket is "neither", so it needs no query
    // of its own and cannot disagree with the edges when both fire on the same resize.
    const sync = () => setBucket(mobile.matches ? "mobile" : desktop.matches ? "desktop" : "tablet");
    sync();
    mobile.addEventListener("change", sync);
    desktop.addEventListener("change", sync);
    return () => {
      mobile.removeEventListener("change", sync);
      desktop.removeEventListener("change", sync);
    };
  }, []);

  return bucket;
}
